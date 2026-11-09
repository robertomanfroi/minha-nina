import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import pino from 'pino';
import QRCode from 'qrcode';
import { abrirBanco, limparAntigas } from './banco.js';
import { tratarMcp } from './mcp.js';
import { WhatsApp } from './whatsapp.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const TOKEN = process.env.TOKEN || '';
const PASTA = process.env.DATA_DIR || './dados';
const PORTA = Number(process.env.PORT) || 3000;
const ENDERECO = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORTA}`).replace(/\/$/, '');

if (TOKEN.length < 24) {
  log.fatal('Falta a variável TOKEN (mínimo 24 caracteres). Ela é a senha do seu conector.');
  process.exit(1);
}

const db = abrirBanco(PASTA);
const wa = new WhatsApp(db, PASTA, log);
setInterval(() => limparAntigas(db), 6 * 3600_000).unref();

function tokenOk(recebido) {
  const a = Buffer.from(recebido || '');
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      if (dados.length > 1_000_000) req.destroy();
    });
    req.on('end', () => ok(dados));
    req.on('error', falha);
  });
}

const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function paginaConectar() {
  const e = wa.estado;
  const conector = `${ENDERECO}/mcp/${TOKEN}`;
  let miolo;
  if (e.conectado) {
    miolo = `<div class="ok">✅ WhatsApp conectado${e.numero ? ` (${escapar(e.numero)})` : ''}</div>
      <p>Este é o link do seu conector. Cole no Claude em <b>Configurações → Conectores → Adicionar conector personalizado</b>:</p>
      <input readonly value="${escapar(conector)}" onclick="this.select()">
      <p class="aviso">⚠️ Esse link é a senha do seu WhatsApp. Não mande para ninguém.</p>`;
  } else if (e.parado) {
    miolo = `<div class="erro">❌ ${escapar(e.erro)}</div>`;
  } else if (e.codigo) {
    miolo = `<p>No celular: WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar aparelho</b> → <b>Conectar com número de telefone</b> e digite:</p>
      <div class="codigo">${escapar(e.codigo)}</div>`;
  } else if (e.qr) {
    const img = await QRCode.toDataURL(e.qr, { width: 320, margin: 1 });
    miolo = `<p>No celular: WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar aparelho</b> e aponte a câmera para o código:</p>
      <img src="${img}" alt="QR code">
      <details><summary>Está abrindo esta página no próprio celular?</summary>
        <form method="post" action="/conectar/${escapar(TOKEN)}/codigo">
          <p>Digite seu número com 55 e DDD para receber um código de 8 letras:</p>
          <input name="numero" placeholder="5511999998888" inputmode="numeric"><button>Gerar código</button>
        </form></details>`;
  } else {
    miolo = `<p>Iniciando a conexão… a página atualiza sozinha.</p>`;
  }
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minha Nina</title>${e.conectado ? '' : '<meta http-equiv="refresh" content="15">'}
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px 16px;text-align:center;color:#222;background:#fafafa}
h1{font-size:22px}img{max-width:100%;border:8px solid #fff;border-radius:12px}input{width:100%;padding:10px;font-size:14px;box-sizing:border-box;margin:8px 0}
button{padding:10px 16px;font-size:15px}.ok{font-size:20px;color:#137333;margin:16px 0}.erro{color:#b3261e;font-size:18px}
.codigo{font-size:36px;letter-spacing:6px;font-weight:700;margin:16px 0}.aviso{color:#8a5300;font-size:14px}details{margin-top:20px;text-align:left}</style>
<h1>Minha Nina · conexão do WhatsApp</h1>${miolo}</html>`;
}

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const partes = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/saude') return json(res, 200, { ok: true });
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Minha Nina está no ar.');
    }

    const [rota, token, acao] = partes;
    if (!['conectar', 'status', 'mcp'].includes(rota) || !tokenOk(token)) return json(res, 404, { erro: 'não encontrado' });

    if (rota === 'status') return json(res, 200, { conectado: wa.estado.conectado, numero: wa.estado.numero, aguardandoQr: !!wa.estado.qr, erro: wa.estado.erro, parado: wa.estado.parado });

    if (rota === 'conectar' && req.method === 'POST' && acao === 'codigo') {
      const numero = new URLSearchParams(await lerCorpo(req)).get('numero') || url.searchParams.get('numero');
      try {
        await wa.pedirCodigo(numero);
      } catch (e) {
        wa.estado.erro = e.message;
      }
      res.writeHead(303, { location: `/conectar/${TOKEN}` });
      return res.end();
    }
    if (rota === 'conectar') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await paginaConectar());
    }

    // rota === 'mcp'
    if (req.method !== 'POST') return json(res, 405, { erro: 'use POST' });
    let corpo;
    try {
      corpo = JSON.parse(await lerCorpo(req));
    } catch {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
    }
    const resposta = await tratarMcp(corpo, { db, wa });
    if (!resposta) {
      res.writeHead(202);
      return res.end();
    }
    return json(res, 200, resposta);
  } catch (e) {
    log.error(e, 'Erro na requisição');
    return json(res, 500, { erro: 'erro interno' });
  }
});

servidor.listen(PORTA, () => log.info({ porta: PORTA }, 'Minha Nina no ar'));
wa.conectar().catch((e) => log.error(e, 'Falha ao iniciar o WhatsApp'));

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    servidor.close();
    db.close();
    process.exit(0);
  });
}
