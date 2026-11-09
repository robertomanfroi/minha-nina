import { acharConversa, conversasRecentes, mensagemPorId, mensagensDaConversa } from './banco.js';

// Conector do Claude (MCP via HTTP, sem sessão). A URL secreta /mcp/<TOKEN> é a senha.
const PROTOCOLO = '2025-06-18';

const FORMATO = 'Formato do WhatsApp: *negrito* com um asterisco, _itálico_, listas com •, sem # e sem tabelas.';

export const FERRAMENTAS = [
  {
    name: 'status',
    description: 'Mostra se o WhatsApp está conectado e qual número. Use quando algo der erro.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'listar_conversas',
    description:
      'Lista as conversas mais recentes do WhatsApp (clientes e grupos), com a última mensagem de cada uma e se quem falou por último foi o cliente (aguardando resposta) ou eu. Só aparecem conversas que tiveram mensagem desde que o WhatsApp foi conectado aqui (e as recentes que o celular sincronizou).',
    inputSchema: {
      type: 'object',
      properties: {
        quantidade: { type: 'number', description: 'Quantas conversas (padrão 20, máximo 100)' },
        busca: { type: 'string', description: 'Opcional: trecho do nome ou do telefone para filtrar' },
      },
    },
  },
  {
    name: 'ler_conversa',
    description:
      'Lê as últimas mensagens de uma conversa (cliente ou grupo), com dia, hora, quem falou e o id de cada mensagem. Leia antes de responder alguém.',
    inputSchema: {
      type: 'object',
      properties: {
        conversa: { type: 'string', description: 'Nome do contato ou grupo (basta um trecho) ou o telefone' },
        quantidade: { type: 'number', description: 'Quantas mensagens (padrão 30, máximo 200)' },
      },
      required: ['conversa'],
    },
  },
  {
    name: 'enviar_mensagem',
    description:
      `Envia uma mensagem no WhatsApp para um contato, grupo ou número. ANTES de chamar, mostre o texto final para a dona do WhatsApp e só envie depois que ela aprovar (ela fala com clientes reais). Nunca use para mandar a mesma mensagem para muitas pessoas: envio em massa faz o WhatsApp bloquear o número. ${FORMATO}`,
    inputSchema: {
      type: 'object',
      properties: {
        para: { type: 'string', description: 'Nome do contato ou grupo (como em listar_conversas) ou telefone com DDD, ex.: 11999998888' },
        texto: { type: 'string', description: 'A mensagem exatamente como deve sair' },
        responder_a: { type: 'string', description: 'Opcional: id de uma mensagem (de ler_conversa) para responder citando ela' },
      },
      required: ['para', 'texto'],
    },
  },
];

const hora = (s) =>
  new Date(s * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const rotulo = (c) => `${c.nome || c.telefone || 'Sem nome'}${c.grupo ? ' (grupo)' : c.telefone ? ` · ${c.telefone}` : ''}`;

function resolver(db, termo) {
  const achadas = acharConversa(db, termo);
  if (achadas.length === 0) return { erro: `Não achei nenhuma conversa com "${termo}". Use listar_conversas para ver os nomes.` };
  if (achadas.length > 1 && !achadas.some((c) => (c.nome || '').toLowerCase() === String(termo).trim().toLowerCase())) {
    return { erro: `Achei mais de uma conversa com "${termo}": ${achadas.map(rotulo).join('; ')}. Diga qual.` };
  }
  return { conversa: achadas.find((c) => (c.nome || '').toLowerCase() === String(termo).trim().toLowerCase()) || achadas[0] };
}

async function executar(nome, args, { db, wa }) {
  if (nome === 'status') {
    const e = wa.estado;
    return e.conectado ? `Conectado ✅ no número ${e.numero || '(desconhecido)'}.` : `Desconectado ❌. ${e.erro || ''} Abra a página de conexão para ler o QR code.`;
  }
  if (nome === 'listar_conversas') {
    const lista = conversasRecentes(db, Math.min(Number(args.quantidade) || 20, 100), args.busca || '');
    if (!lista.length) return 'Nenhuma conversa guardada ainda. As conversas aparecem aqui conforme chegam mensagens novas.';
    return lista
      .map((c) => `• ${rotulo(c)} — ${hora(c.ultima)}${c.ultimo_texto ? `\n  ${c.ultima_minha ? 'Eu' : 'Cliente'}: ${c.ultimo_texto.slice(0, 140)}` : ''}${c.ultima_minha === 0 && !c.grupo ? '\n  ⏳ aguardando resposta' : ''}`)
      .join('\n');
  }
  if (nome === 'ler_conversa') {
    const r = resolver(db, args.conversa);
    if (r.erro) return r.erro;
    const msgs = mensagensDaConversa(db, r.conversa.jid, Math.min(Number(args.quantidade) || 30, 200));
    if (!msgs.length) return `Ainda não há mensagens guardadas com ${rotulo(r.conversa)}.`;
    return [`Conversa com ${rotulo(r.conversa)}:`, ...msgs.map((m) => `[${hora(m.quando)}] ${m.minha ? 'Eu' : m.autor || 'Cliente'}: ${m.texto} (id ${m.id})`)].join('\n');
  }
  if (nome === 'enviar_mensagem') {
    const texto = String(args.texto || '').trim();
    if (!texto) return 'Faltou o texto da mensagem.';
    let jid;
    let destino;
    const digitos = String(args.para || '').replace(/\D/g, '');
    const r = resolver(db, args.para);
    if (!r.erro) {
      jid = r.conversa.jid;
      destino = rotulo(r.conversa);
    } else if (digitos.length >= 10) {
      jid = await wa.jidDoNumero(digitos.startsWith('55') ? digitos : `55${digitos}`);
      destino = digitos;
    } else {
      return r.erro;
    }
    const citar = args.responder_a && mensagemPorId(db, args.responder_a) ? args.responder_a : undefined;
    const enviada = await wa.enviar(jid, texto, citar);
    return `Mensagem enviada para ${destino}${enviada.citou ? ' (respondendo à mensagem citada)' : ''}.`;
  }
  throw new Error(`Ferramenta desconhecida: ${nome}`);
}

async function responder(req, ctx) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOLO,
        capabilities: { tools: {} },
        serverInfo: { name: 'minha-nina', version: '1.0.0' },
        instructions:
          'Conector do WhatsApp da dona deste número. Ela fala com clientes reais: leia a conversa antes de responder, mostre o texto e só envie depois que ela aprovar. Nunca envie em massa.',
      },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: FERRAMENTAS } };
  if (method === 'tools/call') {
    try {
      const texto = await executar(params?.name, params?.arguments || {}, ctx);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: texto }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Erro: ${e.message}` }] } };
    }
  }
  if (id === undefined) return null; // notificação
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Método não suportado: ${method}` } };
}

export async function tratarMcp(corpo, ctx) {
  if (Array.isArray(corpo)) {
    const saidas = (await Promise.all(corpo.map((r) => responder(r, ctx)))).filter(Boolean);
    return saidas.length ? saidas : null;
  }
  return responder(corpo, ctx);
}
