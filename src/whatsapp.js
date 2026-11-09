import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, isJidGroup, useMultiFileAuthState } from 'baileys';
import { rmSync } from 'node:fs';
import { gravarConversa, gravarMensagem } from './banco.js';

// Conexão com o WhatsApp como "aparelho conectado" (igual ao WhatsApp Web).
// A sessão fica em <pasta>/sessao; apagar essa pasta obriga a ler o QR code de novo.

function textoDa(msg) {
  let m = msg.message;
  if (!m) return null;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return `[foto] ${m.imageMessage.caption || ''}`.trim();
  if (m.videoMessage) return `[vídeo] ${m.videoMessage.caption || ''}`.trim();
  if (m.audioMessage) return '[áudio]';
  if (m.documentMessage) return `[arquivo] ${m.documentMessage.fileName || ''}`.trim();
  if (m.stickerMessage) return '[figurinha]';
  if (m.contactMessage) return `[contato] ${m.contactMessage.displayName || ''}`.trim();
  if (m.locationMessage) return '[localização]';
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedDisplayText || null;
  if (m.listResponseMessage) return m.listResponseMessage.title || null;
  return null; // reações, avisos de sistema etc. não entram
}

function telefoneDe(...jids) {
  for (const j of jids) {
    if (j && j.endsWith('@s.whatsapp.net')) return j.split('@')[0].split(':')[0];
  }
  return null;
}

function segundos(ts) {
  const n = typeof ts === 'object' && ts !== null ? Number(ts.low ?? ts) : Number(ts);
  return Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000);
}

export class WhatsApp {
  estado = { conectado: false, qr: null, codigo: null, numero: null, erro: null, parado: false };
  sock = null;
  recentes = new Map(); // id → mensagem crua, para conseguir responder citando
  nomesGrupo = new Map();
  espera = 5_000;

  constructor(db, pasta, log) {
    this.db = db;
    this.pastaSessao = `${pasta}/sessao`;
    this.log = log;
  }

  async conectar() {
    const { state, saveCreds } = await useMultiFileAuthState(this.pastaSessao);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      logger: this.log.child({ modulo: 'baileys' }, { level: 'warn' }),
      browser: Browsers.ubuntu('Minha Nina'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async (key) => this.recentes.get(key.id)?.message,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      if (u.qr) this.estado = { ...this.estado, qr: u.qr };
      if (u.connection === 'open') {
        this.espera = 5_000;
        this.estado = { conectado: true, qr: null, codigo: null, numero: telefoneDe(sock.user?.id), erro: null, parado: false };
        this.log.info('WhatsApp conectado');
        this.carregarGrupos().catch((e) => this.log.warn(e, 'Falha ao ler os grupos'));
      }
      if (u.connection === 'close') this.aoFechar(u.lastDisconnect?.error);
    });

    sock.ev.on('messages.upsert', ({ messages }) => messages.forEach((m) => this.guardar(m)));
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      for (const c of contacts || []) this.guardarContato(c);
      for (const c of chats || []) {
        if (c.id && c.name) gravarConversa(this.db, { jid: c.id, nome: c.name, grupo: isJidGroup(c.id), telefone: telefoneDe(c.id) });
      }
      for (const m of messages || []) this.guardar(m);
    });
    sock.ev.on('contacts.upsert', (cs) => cs.forEach((c) => this.guardarContato(c)));
    sock.ev.on('contacts.update', (cs) => cs.forEach((c) => this.guardarContato(c)));
    sock.ev.on('groups.update', (gs) => gs.forEach((g) => g.id && g.subject && this.nomeDoGrupo(g.id, g.subject)));
  }

  aoFechar(erro) {
    const codigo = erro?.output?.statusCode;
    this.estado = { ...this.estado, conectado: false, erro: `conexão fechada (${codigo ?? 'sem código'})` };
    if (codigo === DisconnectReason.loggedOut) {
      // Desconectado pelo celular: apaga a sessão e mostra um QR novo.
      this.log.warn('Aparelho desconectado pelo celular; aguardando novo QR code');
      rmSync(this.pastaSessao, { recursive: true, force: true });
      this.estado.numero = null;
      return this.reconectar(1_000);
    }
    if (codigo === DisconnectReason.connectionReplaced) {
      this.estado.parado = true;
      this.estado.erro = 'Outro servidor está usando esta mesma conexão. Desligue o outro e reinicie este.';
      return;
    }
    if (codigo === DisconnectReason.forbidden) {
      this.estado.parado = true;
      this.estado.erro = 'O WhatsApp recusou este número (pode ter sido bloqueado).';
      return;
    }
    if (codigo === DisconnectReason.restartRequired) return this.reconectar(500);
    this.reconectar(this.espera);
    this.espera = Math.min(this.espera * 2, 5 * 60_000);
  }

  reconectar(ms) {
    setTimeout(() => this.conectar().catch((e) => this.log.error(e, 'Falha ao reconectar')), ms);
  }

  async pedirCodigo(numero) {
    if (!this.sock || this.estado.conectado) throw new Error('Já está conectado ou ainda iniciando');
    const digitos = String(numero).replace(/\D/g, '');
    if (digitos.length < 12) throw new Error('Use o número com 55 + DDD, ex.: 5511999998888');
    const codigo = await this.sock.requestPairingCode(digitos);
    this.estado.codigo = codigo;
    return codigo;
  }

  async carregarGrupos() {
    const grupos = await this.sock.groupFetchAllParticipating();
    for (const g of Object.values(grupos)) this.nomeDoGrupo(g.id, g.subject);
  }

  nomeDoGrupo(jid, nome) {
    this.nomesGrupo.set(jid, nome);
    gravarConversa(this.db, { jid, nome, grupo: true });
  }

  guardarContato(c) {
    const nome = c.name || c.notify || c.verifiedName;
    if (c.id && nome && !isJidGroup(c.id)) gravarConversa(this.db, { jid: c.id, nome, grupo: false, telefone: telefoneDe(c.id, c.phoneNumber) });
  }

  guardar(msg) {
    const jid = msg.key?.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
    const texto = textoDa(msg);
    if (!texto) return;
    const quando = segundos(msg.messageTimestamp);
    const grupo = isJidGroup(jid);
    const minha = !!msg.key.fromMe;
    this.recentes.set(msg.key.id, msg);
    if (this.recentes.size > 1000) this.recentes.delete(this.recentes.keys().next().value);

    gravarConversa(this.db, {
      jid,
      nome: grupo ? this.nomesGrupo.get(jid) : minha ? null : msg.pushName,
      grupo,
      telefone: grupo ? null : telefoneDe(jid, msg.key.remoteJidAlt),
      quando,
    });
    gravarMensagem(this.db, {
      id: msg.key.id,
      jid,
      minha,
      autor: minha ? 'eu' : grupo ? msg.pushName || telefoneDe(msg.key.participant, msg.key.participantAlt) : msg.pushName,
      texto,
      quando,
    });
  }

  async jidDoNumero(numero) {
    const digitos = String(numero).replace(/\D/g, '');
    const [r] = await this.sock.onWhatsApp(digitos);
    if (!r?.exists) throw new Error(`O número ${digitos} não tem WhatsApp`);
    return r.jid;
  }

  async enviar(jid, texto, citarId) {
    if (!this.estado.conectado) throw new Error('WhatsApp desconectado. Abra a página de conexão e leia o QR code de novo.');
    const citada = citarId ? this.recentes.get(citarId) : undefined;
    const enviada = await this.sock.sendMessage(jid, { text: texto }, citada ? { quoted: citada } : {});
    this.guardar(enviada);
    return { id: enviada.key.id, citou: !!citada };
  }
}
