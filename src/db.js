// ============================================================
//  src/db.js — Camada de persistência (better-sqlite3)
//  Banco: data/nexvon.db. Tabelas conforme API_CONTRACT.md.
// ============================================================
import Database from 'better-sqlite3';
import config from './config.js';
import { DEFAULT_SYSTEM_PROMPT } from './agentSystemPrompt.js';

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ------------------------------------------------------------
//  Criação das tabelas (idempotente)
// ------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  status TEXT DEFAULT 'novo',
  tags TEXT,
  language_interest TEXT,
  level TEXT,
  objective TEXT,
  takeover INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  last_message_at TEXT,
  unread INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT,
  meta TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS configs (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT,
  question TEXT,
  answer TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT,
  message TEXT,
  created_at TEXT
);
`);

const nowISO = () => new Date().toISOString();

// ------------------------------------------------------------
//  Helpers: configs (chave/valor JSON)
// ------------------------------------------------------------
export function getConfig(key, fallback = null) {
  const row = db.prepare('SELECT value FROM configs WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setConfig(key, value) {
  const json = JSON.stringify(value);
  db.prepare(`INSERT INTO configs (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, json);
  return value;
}

// ------------------------------------------------------------
//  Helpers: leads
// ------------------------------------------------------------
export function upsertLead({ phone, name, pushName }) {
  const existing = db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
  const ts = nowISO();
  if (existing) {
    // Atualiza nome se veio um novo e o atual está vazio
    const finalName = existing.name || name || pushName || null;
    db.prepare('UPDATE leads SET name = ?, updated_at = ? WHERE id = ?')
      .run(finalName, ts, existing.id);
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(existing.id);
  }
  const info = db.prepare(`INSERT INTO leads
    (phone, name, status, tags, takeover, created_at, updated_at, last_message_at, unread)
    VALUES (?, ?, 'novo', '[]', 0, ?, ?, ?, 0)`)
    .run(phone, name || pushName || null, ts, ts, ts);
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid);
}

export function getLeadByPhone(phone) {
  return db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone) || null;
}

export function getLeadById(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id) || null;
}

export function listLeads({ search = '', limit = 50, offset = 0 } = {}) {
  limit = Math.min(Math.max(1, Number(limit) || 50), 200);
  offset = Math.max(0, Number(offset) || 0);
  let where = '';
  const params = [];
  if (search) {
    where = 'WHERE phone LIKE ? OR name LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM leads ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM leads ${where} ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  return { leads: rows, total };
}

export function updateLead(id, fields) {
  const allowed = ['name', 'status', 'tags', 'language_interest', 'level', 'objective', 'takeover', 'unread', 'last_message_at'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getLeadById(id);
  sets.push('updated_at = ?');
  vals.push(nowISO());
  vals.push(id);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getLeadById(id);
}

// ------------------------------------------------------------
//  Helpers: messages
// ------------------------------------------------------------
export function addMessage({ leadId, role, text, meta = null }) {
  const ts = nowISO();
  const info = db.prepare(
    'INSERT INTO messages (lead_id, role, text, meta, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(leadId, role, text, meta ? JSON.stringify(meta) : null, ts);
  // Atualiza last_message_at do lead
  db.prepare('UPDATE leads SET last_message_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, leadId);
  return { id: info.lastInsertRowid, lead_id: leadId, role, text, meta, created_at: ts };
}

export function getLeadMessages(leadId, limit = 200) {
  return db.prepare(
    'SELECT * FROM messages WHERE lead_id = ? ORDER BY id ASC LIMIT ?'
  ).all(leadId, limit);
}

export function getLeadWithMessages(id, msgLimit = 200) {
  const lead = getLeadById(id);
  if (!lead) return null;
  const messages = getLeadMessages(id, msgLimit).map(m => ({
    id: m.id, role: m.role, text: m.text, createdAt: m.created_at,
    meta: (() => { try { return JSON.parse(m.meta); } catch { return null; } })(),
  }));
  return { ...lead, messages };
}

// ------------------------------------------------------------
//  Helpers: logs
// ------------------------------------------------------------
export function addLog(level, message) {
  const ts = nowISO();
  db.prepare('INSERT INTO logs (level, message, created_at) VALUES (?, ?, ?)').run(level, message, ts);
  // Mantém só os últimos 5000 logs
  db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 5000)').run();
  return { level, message, createdAt: ts };
}

export function listLogs(limit = 100) {
  limit = Math.min(Math.max(1, Number(limit) || 100), 500);
  return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
}

// ------------------------------------------------------------
//  Helpers: knowledge (CRUD)
// ------------------------------------------------------------
export function listKnowledge(onlyEnabled = false) {
  if (onlyEnabled) return db.prepare('SELECT * FROM knowledge WHERE enabled = 1 ORDER BY id ASC').all();
  return db.prepare('SELECT * FROM knowledge ORDER BY id ASC').all();
}
export function createKnowledge({ category, question, answer, enabled = 1 }) {
  const ts = nowISO();
  const info = db.prepare(
    'INSERT INTO knowledge (category, question, answer, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(category || 'Geral', question, answer, enabled ? 1 : 0, ts, ts);
  return db.prepare('SELECT * FROM knowledge WHERE id = ?').get(info.lastInsertRowid);
}
export function updateKnowledge(id, { category, question, answer, enabled }) {
  const existing = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id);
  if (!existing) return null;
  const cat = category !== undefined ? category : existing.category;
  const q = question !== undefined ? question : existing.question;
  const a = answer !== undefined ? answer : existing.answer;
  const en = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;
  db.prepare('UPDATE knowledge SET category=?, question=?, answer=?, enabled=?, updated_at=? WHERE id=?')
    .run(cat, q, a, en, nowISO(), id);
  return db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id);
}
export function deleteKnowledge(id) {
  const info = db.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
  return info.changes > 0;
}

// ------------------------------------------------------------
//  Estatísticas para GET /api/stats
// ------------------------------------------------------------
export function getStats() {
  const totalLeads = db.prepare('SELECT COUNT(*) c FROM leads').get().c;
  const active7d = db.prepare(
    "SELECT COUNT(DISTINCT lead_id) c FROM messages WHERE created_at >= datetime('now','-7 days')"
  ).get().c;
  const today = new Date().toISOString().slice(0, 10);
  const messagesToday = db.prepare(
    "SELECT COUNT(*) c FROM messages WHERE substr(created_at,1,10) = ?"
  ).get(today).c;
  const conversationsOpen = db.prepare(
    "SELECT COUNT(*) c FROM leads WHERE status NOT IN ('fechado','perdido')"
  ).get().c;
  const closedDeals = db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'fechado'").get().c;
  const messagesByDay = db.prepare(
    "SELECT substr(created_at,1,10) AS date, COUNT(*) AS count FROM messages GROUP BY date ORDER BY date DESC LIMIT 30"
  ).all().reverse();
  const leadsByStatus = db.prepare(
    "SELECT status, COUNT(*) AS count FROM leads GROUP BY status"
  ).all();
  // Tempo médio de resposta (lead -> agent seguinte), simples
  const avgRow = db.prepare(`
    SELECT AVG((julianday(a.created_at) - julianday(l.created_at)) * 86400000) AS avg_ms
    FROM messages l
    JOIN messages a ON a.id = (
      SELECT m2.id FROM messages m2
      WHERE m2.lead_id = l.lead_id AND m2.id > l.id AND m2.role IN ('agent','human')
      ORDER BY m2.id ASC LIMIT 1
    )
    WHERE l.role = 'lead'
  `).get();
  return {
    totalLeads, activeLeads7d: active7d, messagesToday, conversationsOpen,
    avgResponseMs: avgRow && avgRow.avg_ms != null ? Math.round(avgRow.avg_ms) : null,
    closedDeals, messagesByDay, leadsByStatus,
  };
}

// ------------------------------------------------------------
//  SEED inicial (primeiro start)
// ------------------------------------------------------------
function seedIfNeeded() {
  const seeded = getConfig('seeded_v1', false);
  if (seeded) return;

  // --- system_prompt ---
  setConfig('system_prompt', DEFAULT_SYSTEM_PROMPT);

  // --- llm settings (vindas do env) ---
  setConfig('llm', {
    apiKey: config.LLM_API_KEY,
    baseUrl: config.LLM_BASE_URL,
    model: config.LLM_MODEL,
    temperature: config.LLM_TEMPERATURE,
  });

  // --- owner_whatsapp ---
  setConfig('owner_whatsapp', config.OWNER_WHATSAPP);

  // --- max_history ---
  setConfig('max_history', config.LLM_MAX_HISTORY);

  // --- escalation padrão ---
  setConfig('escalation', {
    keywords: ['falar com humano', 'atendente', 'pessoa', 'reembolso', 'estorno', 'cancelar', 'contato'],
    maxAttempts: 2,
    enabled: true,
  });

  // --- knowledge base: FAQs padrão (fatos do produto) ---
  const faqs = [
    { category: 'Preço', question: 'Quanto custa a NEXVON FLUENCY?',
      answer: 'Pagamento ÚNICO de $99 USD (era $199 — 50% OFF). Acesso VITALÍCIO, sem mensalidade. Em BRL: PIX à vista com 10% OFF = R$496,52; cartão em até 6x sem juros = 6× R$91,95; débito à vista = R$551,69. Pagamento processado pela InfinitePay.' },
    { category: 'Pagamento', question: 'Quais as formas de pagamento?',
      answer: 'PIX à vista com 10% OFF (R$496,52, liberação instantânea), cartão de crédito em até 6x sem juros (6× R$91,95) ou débito à vista (R$551,69). Processamento pela InfinitePay. Após a compra, o acesso é enviado via WhatsApp.' },
    { category: 'Garantia', question: 'Tem garantia? Posso pedir reembolso?',
      answer: 'Garantia INCONDICIONAL de 7 dias: se não gostar, reembolso de 100% sem perguntas. Basta entrar em contato que devolvemos seu dinheiro.' },
    { category: 'Pós-compra', question: 'Como recebo o acesso depois de comprar?',
      answer: 'Após a confirmação do pagamento, o acesso é enviado pelo próprio WhatsApp: link da extensão, instruções de instalação e acesso liberado. PIX é instantâneo; cartão depende da confirmação da operadora (geralmente minutos).' },
    { category: 'Preço', question: 'É pagamento único ou mensalidade?',
      answer: 'Pagamento ÚNICO. Você paga uma vez e tem acesso VITALÍCIO, incluindo todas as atualizações futuras gratuitamente. Sem mensalidade, sem renovação automática.' },
    { category: 'Diferencial', question: 'Qual a diferença para o Duolingo e cursos tradicionais?',
      answer: 'A NEXVON usa aquisição REAL de idioma por IMERSÃO em conteúdo autêntico (filmes, séries, YouTube, podcasts, livros), não um jogo de memorização. Inclui legendas bilíngues, dicionário com IA, PhrasePump (repetição espaçada), Aria (parceira de conversação IA 24h) e export para Anki. Custo vitalício ~R$496 contra R$2.400+/ano de plataformas tradicionais.' },
    { category: 'Público', question: 'Funciona para iniciantes absolutos?',
      answer: 'Sim! A plataforma é feita para todos os níveis, incluindo quem nunca estudou o idioma. Controles de velocidade, pausa automática, repetição de frases e a Aria (parceira de conversação sem julgamento) ajudam o iniciante a ganhar confiança desde o primeiro dia.' },
    { category: 'Idiomas', question: 'Quais idiomas estão disponíveis?',
      answer: 'São +40 idiomas liberados de uma vez: inglês, espanhol, francês, alemão, italiano, japonês, mandarim, coreano, árabe, russo, holandês, sueco, polonês, turco, hebraico, hindi, vietnamita, tailandês, grego, português e mais. Um único acesso libera todos.' },
  ];
  for (const f of faqs) createKnowledge({ ...f, enabled: 1 });

  setConfig('seeded_v1', true);
  addLog('info', 'Seed inicial do banco concluído (configs + knowledge).');
}

seedIfNeeded();

export default db;
