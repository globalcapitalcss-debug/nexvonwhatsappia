// ============================================================
//  src/server.js — Servidor Express (API REST + SSE + estáticos)
//  Ponto de entrada: `node src/server.js`
// ============================================================
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import db, {
  getConfig, setConfig, listLeads, getLeadWithMessages, getLeadById,
  updateLead, listKnowledge, createKnowledge, updateKnowledge, deleteKnowledge,
  listLogs, addLog, getStats,
} from './db.js';
import { startWhatsApp, logout, reconnect, getWhatsAppState } from './whatsapp.js';
import { handleIncoming, sendHumanMessage, agentEvents, emitEvent, serializeLead } from './agent.js';
import { isLlmConfigured } from './llm.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ------------------------------------------------------------
//  Middleware de autenticação (X-Admin-Password)
//  Exceto /api/events que usa ?password= na query (SSE).
// ------------------------------------------------------------
function authMiddleware(req, res, next) {
  // SSE usa query string (EventSource não suporta headers customizados).
  // Como este middleware está montado em /api, usamos originalUrl para
  // identificar a rota corretamente (req.path teria o prefixo /api removido).
  const pathOnly = (req.originalUrl || req.url).split('?')[0];
  if (pathOnly === '/api/events') {
    if (req.query.password === config.ADMIN_PASSWORD) return next();
    return res.status(401).json({ error: 'unauthorized' });
  }
  const pass = req.header('X-Admin-Password');
  if (!pass || pass !== config.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
app.use('/api', authMiddleware);

// ------------------------------------------------------------
//  GET /api/status
// ------------------------------------------------------------
app.get('/api/status', (req, res) => {
  const wa = getWhatsAppState();
  const llmCfg = getConfig('llm', {}) || {};
  res.json({
    whatsapp: { connected: wa.connected, qr: wa.qr, pairingCode: wa.pairingCode, state: wa.state },
    llm: { configured: isLlmConfigured(), model: llmCfg.model || config.LLM_MODEL, baseUrl: llmCfg.baseUrl || config.LLM_BASE_URL },
    version: config.VERSION,
  });
});

// ------------------------------------------------------------
//  GET /api/stats
// ------------------------------------------------------------
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// ------------------------------------------------------------
//  GET /api/leads?search=&limit=&offset=
// ------------------------------------------------------------
app.get('/api/leads', (req, res) => {
  const { search = '', limit = 50, offset = 0 } = req.query;
  const { leads, total } = listLeads({ search, limit, offset });
  // Encontra último texto de mensagem para cada lead
  const out = leads.map(l => {
    const s = serializeLead(l);
    // Última mensagem (consulta rápida)
    const last = db.prepare('SELECT text FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(l.id);
    return { ...s, lastMessageText: last ? last.text : null };
  });
  res.json({ leads: out, total });
});

// ------------------------------------------------------------
//  GET /api/leads/:id
// ------------------------------------------------------------
app.get('/api/leads/:id', (req, res) => {
  const full = getLeadWithMessages(Number(req.params.id), 200);
  if (!full) return res.status(404).json({ error: 'lead não encontrado' });
  const lead = serializeLead(full);
  res.json({ ...lead, messages: full.messages });
});

// ------------------------------------------------------------
//  POST /api/leads/:id/send (mensagem humana, takeover implícito)
// ------------------------------------------------------------
app.post('/api/leads/:id/send', async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'texto vazio' });
  const result = await sendHumanMessage(Number(req.params.id), String(text).trim());
  if (!result) return res.status(404).json({ error: 'lead não encontrado' });
  res.json({ ok: true, message: result.message, lead: serializeLead(result.lead) });
});

// ------------------------------------------------------------
//  POST /api/leads/:id/takeover
// ------------------------------------------------------------
app.post('/api/leads/:id/takeover', (req, res) => {
  const { active } = req.body || {};
  const lead = updateLead(Number(req.params.id), { takeover: active ? 1 : 0 });
  if (!lead) return res.status(404).json({ error: 'lead não encontrado' });
  addLog('info', `Takeover do lead ${lead.phone} = ${active ? 'ativo (humano)' : 'desativado (IA)'}`);
  emitEvent('lead', { lead: serializeLead(lead) });
  res.json(serializeLead(lead));
});

// ------------------------------------------------------------
//  PUT /api/leads/:id (campos editáveis)
// ------------------------------------------------------------
app.put('/api/leads/:id', (req, res) => {
  const { name, status, tags, languageInterest, level, objective } = req.body || {};
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (status !== undefined) fields.status = status;
  if (tags !== undefined) fields.tags = tags;
  if (languageInterest !== undefined) fields.language_interest = languageInterest;
  if (level !== undefined) fields.level = level;
  if (objective !== undefined) fields.objective = objective;
  const lead = updateLead(Number(req.params.id), fields);
  if (!lead) return res.status(404).json({ error: 'lead não encontrado' });
  emitEvent('lead', { lead: serializeLead(lead) });
  res.json(serializeLead(lead));
});

// ------------------------------------------------------------
//  GET /api/config (chaves mascaradas)
// ------------------------------------------------------------
app.get('/api/config', (req, res) => {
  const llm = getConfig('llm', {}) || {};
  const mask = (k) => !k ? '' : (k.length <= 6 ? '••••' : k.slice(0, 3) + '••••' + k.slice(-3));
  res.json({
    systemPrompt: getConfig('system_prompt', ''),
    llm: {
      apiKeyMasked: mask(llm.apiKey || ''),
      baseUrl: llm.baseUrl || config.LLM_BASE_URL,
      model: llm.model || config.LLM_MODEL,
      temperature: llm.temperature ?? config.LLM_TEMPERATURE,
      configured: isLlmConfigured(),
    },
    ownerWhatsapp: getConfig('owner_whatsapp', config.OWNER_WHATSAPP),
    maxHistory: getConfig('max_history', config.LLM_MAX_HISTORY),
    escalation: getConfig('escalation', { keywords: [], maxAttempts: 2, enabled: true }),
  });
});

// ------------------------------------------------------------
//  PUT /api/config (qualquer subconjunto)
// ------------------------------------------------------------
app.put('/api/config', (req, res) => {
  const body = req.body || {};
  if (body.systemPrompt !== undefined) setConfig('system_prompt', body.systemPrompt);
  if (body.llm && typeof body.llm === 'object') {
    const cur = getConfig('llm', {}) || {};
    const next = { ...cur };
    // apiKey vazia → NÃO altera; não-vazia → substitui
    if (body.llm.apiKey !== undefined && String(body.llm.apiKey).trim() !== '') {
      next.apiKey = String(body.llm.apiKey).trim();
    }
    if (body.llm.baseUrl !== undefined) next.baseUrl = String(body.llm.baseUrl).replace(/\/+$/, '');
    if (body.llm.model !== undefined) next.model = String(body.llm.model);
    if (body.llm.temperature !== undefined) next.temperature = Number(body.llm.temperature);
    setConfig('llm', next);
  }
  if (body.ownerWhatsapp !== undefined) setConfig('owner_whatsapp', String(body.ownerWhatsapp));
  if (body.maxHistory !== undefined) setConfig('max_history', Number(body.maxHistory) || 20);
  if (body.escalation && typeof body.escalation === 'object') {
    const cur = getConfig('escalation', { keywords: [], maxAttempts: 2, enabled: true }) || {};
    setConfig('escalation', {
      keywords: Array.isArray(body.escalation.keywords) ? body.escalation.keywords : cur.keywords,
      maxAttempts: body.escalation.maxAttempts !== undefined ? Number(body.escalation.maxAttempts) : cur.maxAttempts,
      enabled: body.escalation.enabled !== undefined ? !!body.escalation.enabled : cur.enabled,
    });
  }
  addLog('info', 'Configurações atualizadas pelo painel admin.');
  // Retorna config atualizada (mascarada)
  const llm = getConfig('llm', {}) || {};
  const mask = (k) => !k ? '' : (k.length <= 6 ? '••••' : k.slice(0, 3) + '••••' + k.slice(-3));
  res.json({
    systemPrompt: getConfig('system_prompt', ''),
    llm: {
      apiKeyMasked: mask(llm.apiKey || ''),
      baseUrl: llm.baseUrl || config.LLM_BASE_URL,
      model: llm.model || config.LLM_MODEL,
      temperature: llm.temperature ?? config.LLM_TEMPERATURE,
      configured: isLlmConfigured(),
    },
    ownerWhatsapp: getConfig('owner_whatsapp', config.OWNER_WHATSAPP),
    maxHistory: getConfig('max_history', config.LLM_MAX_HISTORY),
    escalation: getConfig('escalation', { keywords: [], maxAttempts: 2, enabled: true }),
  });
});

// ------------------------------------------------------------
//  Knowledge CRUD
// ------------------------------------------------------------
app.get('/api/knowledge', (req, res) => {
  const items = listKnowledge(false).map(k => ({
    id: k.id, category: k.category, question: k.question, answer: k.answer,
    enabled: !!k.enabled, createdAt: k.created_at, updatedAt: k.updated_at,
  }));
  res.json({ items });
});
app.post('/api/knowledge', (req, res) => {
  const { category, question, answer, enabled } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: 'question e answer são obrigatórios' });
  const k = createKnowledge({ category, question, answer, enabled: enabled !== false });
  res.json({ id: k.id, category: k.category, question: k.question, answer: k.answer, enabled: !!k.enabled, createdAt: k.created_at, updatedAt: k.updated_at });
});
app.put('/api/knowledge/:id', (req, res) => {
  const k = updateKnowledge(Number(req.params.id), req.body || {});
  if (!k) return res.status(404).json({ error: 'item não encontrado' });
  res.json({ id: k.id, category: k.category, question: k.question, answer: k.answer, enabled: !!k.enabled, createdAt: k.created_at, updatedAt: k.updated_at });
});
app.delete('/api/knowledge/:id', (req, res) => {
  const ok = deleteKnowledge(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'item não encontrado' });
  res.json({ ok: true });
});

// ------------------------------------------------------------
//  GET /api/logs?limit=
// ------------------------------------------------------------
app.get('/api/logs', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const logs = listLogs(limit).map(l => ({ id: l.id, level: l.level, message: l.message, createdAt: l.created_at }));
  res.json({ logs });
});

// ------------------------------------------------------------
//  WhatsApp: logout / reconnect
// ------------------------------------------------------------
app.post('/api/whatsapp/logout', async (req, res) => {
  await logout();
  emitEvent('connection', { connected: false, state: 'logged_out' });
  res.json({ ok: true });
});
app.post('/api/whatsapp/reconnect', async (req, res) => {
  try {
    await reconnect();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
//  GET /api/events — Server-Sent Events
// ------------------------------------------------------------
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Envia estado inicial
  const wa = getWhatsAppState();
  res.write(`event: connection\ndata: ${JSON.stringify({ connected: wa.connected, state: wa.state })}\n\n`);
  if (wa.qr) res.write(`event: qr\ndata: ${JSON.stringify({ qr: wa.qr })}\n\n`);

  const onEvent = ({ type, data }) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  agentEvents.on('event', onEvent);

  // Keep-alive a cada 25s
  const keepAlive = setInterval(() => {
    res.write(`: keep-alive ${Date.now()}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    agentEvents.off('event', onEvent);
  });
});

// ------------------------------------------------------------
//  Estáticos do frontend em /admin
//  GET /admin → public/index.html (placeholder se não existir)
// ------------------------------------------------------------
const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEXVON WhatsApp AI — Admin</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem;max-width:480px}h1{color:#38bdf8}p{opacity:.8}</style></head>
<body><div class="card"><h1>NEXVON WhatsApp AI</h1><p>Painel administrativo — frontend em construção.</p>
<p>Backend no ar. A API está disponível em <code>/api/*</code>.</p></div></body></html>`;

app.get('/admin', (req, res) => {
  const idx = path.join(config.PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.type('html').send(PLACEHOLDER_HTML);
});
app.use('/admin', express.static(config.PUBLIC_DIR));
// Raiz também redireciona para /admin
app.get('/', (req, res) => res.redirect('/admin'));

// ------------------------------------------------------------
//  Tratamento de erros (JSON)
// ------------------------------------------------------------
app.use((err, req, res, next) => {
  addLog('error', `Erro HTTP: ${err.message}`);
  res.status(500).json({ error: err.message || 'internal error' });
});

// ------------------------------------------------------------
//  Inicialização
// ------------------------------------------------------------
const server = app.listen(config.PORT, () => {
  console.log(`\n============================================================`);
  console.log(`  NEXVON WHATSAPP AI — servidor no ar`);
  console.log(`  Painel admin: http://localhost:${config.PORT}/admin`);
  console.log(`  API:          http://localhost:${config.PORT}/api/status`);
  console.log(`  LLM:          ${isLlmConfigured() ? 'configurada' : 'NÃO configurada (modo fallback)'}`);
  console.log(`============================================================\n`);
  addLog('info', `Servidor iniciado na porta ${config.PORT}.`);
});

// Inicia o WhatsApp (em background, não bloqueia o HTTP)
startWhatsApp({
  onQR: (dataURL) => {
    console.log('[whatsapp] QR recebido — disponível no painel admin.');
    emitEvent('qr', { qr: dataURL });
  },
  onConnection: (connected, reason) => {
    emitEvent('connection', { connected, state: reason || (connected ? 'connected' : 'disconnected') });
  },
  onMessage: ({ phone, text, pushName }) => {
    // Dispara o agente (não espera, para não travar o loop de eventos)
    handleIncoming({ phone, text, pushName });
  },
}).catch(e => {
  addLog('error', `Falha ao iniciar WhatsApp: ${e.message}`);
  console.error('[whatsapp] Não foi possível iniciar:', e.message);
});

// SIGINT → fecha DB e servidor de forma limpa
process.on('SIGINT', () => {
  console.log('\nEncerrando servidor...');
  try { db.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
process.on('SIGTERM', () => {
  try { db.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

export default app;
