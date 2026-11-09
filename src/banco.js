import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Guarda só o texto das conversas, no disco do servidor da própria dona do número.
// Mensagens com mais de DIAS_GUARDADOS dias são apagadas sozinhas.
const DIAS_GUARDADOS = 90;

export function abrirBanco(pasta) {
  mkdirSync(pasta, { recursive: true });
  const db = new Database(join(pasta, 'conversas.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversas (
      jid TEXT PRIMARY KEY,
      nome TEXT,
      grupo INTEGER NOT NULL DEFAULT 0,
      telefone TEXT,
      ultima INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mensagens (
      id TEXT NOT NULL,
      jid TEXT NOT NULL,
      minha INTEGER NOT NULL,
      autor TEXT,
      texto TEXT NOT NULL,
      quando INTEGER NOT NULL,
      PRIMARY KEY (jid, id)
    );
    CREATE INDEX IF NOT EXISTS mensagens_por_conversa ON mensagens (jid, quando);
  `);
  return db;
}

export function gravarConversa(db, { jid, nome, grupo, telefone, quando }) {
  db.prepare(
    `INSERT INTO conversas (jid, nome, grupo, telefone, ultima) VALUES (@jid, @nome, @grupo, @telefone, @ultima)
     ON CONFLICT(jid) DO UPDATE SET
       nome = COALESCE(excluded.nome, conversas.nome),
       telefone = COALESCE(excluded.telefone, conversas.telefone),
       grupo = excluded.grupo,
       ultima = MAX(conversas.ultima, excluded.ultima)`,
  ).run({ jid, nome: nome || null, grupo: grupo ? 1 : 0, telefone: telefone || null, ultima: quando || 0 });
}

export function gravarMensagem(db, m) {
  db.prepare(
    `INSERT OR IGNORE INTO mensagens (id, jid, minha, autor, texto, quando) VALUES (@id, @jid, @minha, @autor, @texto, @quando)`,
  ).run({ ...m, minha: m.minha ? 1 : 0, autor: m.autor || null });
}

export function conversasRecentes(db, quantidade = 20, busca = '') {
  const filtro = busca ? `%${busca.toLowerCase()}%` : null;
  return db
    .prepare(
      `SELECT c.jid, c.nome, c.grupo, c.telefone, c.ultima,
              (SELECT texto FROM mensagens m WHERE m.jid = c.jid ORDER BY quando DESC LIMIT 1) AS ultimo_texto,
              (SELECT minha FROM mensagens m WHERE m.jid = c.jid ORDER BY quando DESC LIMIT 1) AS ultima_minha
         FROM conversas c
        WHERE c.ultima > 0 ${filtro ? 'AND (lower(c.nome) LIKE @filtro OR c.telefone LIKE @filtro)' : ''}
        ORDER BY c.ultima DESC LIMIT @quantidade`,
    )
    .all({ quantidade, filtro });
}

export function acharConversa(db, termo) {
  const t = String(termo || '').trim();
  if (!t) return [];
  const exato = db.prepare('SELECT * FROM conversas WHERE jid = ?').get(t);
  if (exato) return [exato];
  const digitos = t.replace(/\D/g, '');
  if (digitos.length >= 8) {
    const porTelefone = db.prepare('SELECT * FROM conversas WHERE telefone LIKE ? ORDER BY ultima DESC').all(`%${digitos.slice(-8)}`);
    if (porTelefone.length) return porTelefone;
  }
  return db.prepare('SELECT * FROM conversas WHERE lower(nome) LIKE ? ORDER BY ultima DESC LIMIT 5').all(`%${t.toLowerCase()}%`);
}

export function mensagensDaConversa(db, jid, quantidade = 30) {
  return db
    .prepare('SELECT * FROM (SELECT * FROM mensagens WHERE jid = ? ORDER BY quando DESC LIMIT ?) ORDER BY quando ASC')
    .all(jid, quantidade);
}

export function mensagemPorId(db, id) {
  return db.prepare('SELECT * FROM mensagens WHERE id = ?').get(id);
}

export function limparAntigas(db) {
  const limite = Math.floor(Date.now() / 1000) - DIAS_GUARDADOS * 86400;
  db.prepare('DELETE FROM mensagens WHERE quando < ?').run(limite);
}
