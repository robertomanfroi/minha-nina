import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abrirBanco, gravarConversa, gravarMensagem } from '../src/banco.js';
import { tratarMcp } from '../src/mcp.js';

function montar() {
  const db = abrirBanco(mkdtempSync(join(tmpdir(), 'nina-')));
  const enviadas = [];
  const wa = {
    estado: { conectado: true, numero: '5511900000000' },
    async enviar(jid, texto, citar) { enviadas.push({ jid, texto, citar }); return { id: 'X', citou: !!citar }; },
    async jidDoNumero(d) { return `${d}@s.whatsapp.net`; },
  };
  const agora = Math.floor(Date.now() / 1000);
  gravarConversa(db, { jid: '5511988887777@s.whatsapp.net', nome: 'Maria Cliente', grupo: false, telefone: '5511988887777', quando: agora });
  gravarMensagem(db, { id: 'M1', jid: '5511988887777@s.whatsapp.net', minha: false, autor: 'Maria Cliente', texto: 'Oi, tem o vestido azul?', quando: agora });
  gravarConversa(db, { jid: '123@g.us', nome: 'Clientes VIP', grupo: true, quando: agora - 60 });
  return { db, wa, enviadas };
}
const chamar = (ctx, name, args = {}) => tratarMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx).then((r) => r.result.content[0].text);

test('initialize e tools/list', async () => {
  const ctx = montar();
  const ini = await tratarMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx);
  assert.equal(ini.result.serverInfo.name, 'minha-nina');
  const lista = await tratarMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
  assert.deepEqual(lista.result.tools.map((t) => t.name), ['status', 'listar_conversas', 'ler_conversa', 'enviar_mensagem']);
  assert.equal(await tratarMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
});

test('lista, lê e responde citando', async () => {
  const ctx = montar();
  assert.match(await chamar(ctx, 'listar_conversas'), /Maria Cliente[\s\S]*aguardando resposta/);
  assert.match(await chamar(ctx, 'ler_conversa', { conversa: 'maria' }), /vestido azul\? \(id M1\)/);
  assert.match(await chamar(ctx, 'enviar_mensagem', { para: 'Maria', texto: 'Tem sim!', responder_a: 'M1' }), /respondendo/);
  assert.deepEqual(ctx.enviadas[0], { jid: '5511988887777@s.whatsapp.net', texto: 'Tem sim!', citar: 'M1' });
});

test('envia para número novo e acha por telefone', async () => {
  const ctx = montar();
  await chamar(ctx, 'enviar_mensagem', { para: '(21) 97777-6666', texto: 'Olá' });
  assert.equal(ctx.enviadas[0].jid, '5521977776666@s.whatsapp.net');
  assert.match(await chamar(ctx, 'ler_conversa', { conversa: '11 98888-7777' }), /Maria Cliente/);
});

test('conversa inexistente e texto vazio', async () => {
  const ctx = montar();
  assert.match(await chamar(ctx, 'ler_conversa', { conversa: 'Joana' }), /Não achei/);
  assert.match(await chamar(ctx, 'enviar_mensagem', { para: 'Maria', texto: '  ' }), /Faltou o texto/);
  assert.equal(ctx.enviadas.length, 0);
});
