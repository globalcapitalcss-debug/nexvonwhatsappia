# CONTRATO DE API — NEXVON WHATSAPP AI (CONGELADO)
Backend e Frontend DEVEM seguir exatamente este contrato. Qualquer divergência = bug.

## Autenticação
Toda rota `/api/*` exige o header `X-Admin-Password: <senha>`.
A senha vem de `process.env.ADMIN_PASSWORD` (padrão em .env).
Se faltar ou estiver errada → `401 {error: "unauthorized"}`.
O frontend guarda a senha no localStorage e envia em todo fetch.

## Formato geral
- Todas as respostas são JSON.
- Erros: `{error: "mensagem"}` com status 4xx/5xx.
- Datas em ISO string. Telefones em formato E.164 sem `+` (ex: `5511999998888`).

## Rotas

### GET /api/status
Retorna: `{ whatsapp: { connected: bool, qr: string|null (data URL image/png ou null), pairingCode: string|null, state: string }, llm: { configured: bool, model: string, baseUrl: string }, version: "1.0.0" }`

### GET /api/stats
Retorna: `{ totalLeads, activeLeads7d, messagesToday, conversationsOpen, avgResponseMs, closedDeals, messagesByDay: [{date:"YYYY-MM-DD", count:int}], leadsByStatus: [{status, count}] }`

### GET /api/leads?search=&limit=50&offset=0
Retorna: `{ leads: [{ id, phone, name, status, tags, languageInterest, lastMessageText, lastMessageAt, unread, takeover }], total }`
Status possíveis: `novo`, `qualificando`, `objeção`, `proposta`, `fechado`, `perdido`.

### GET /api/leads/:id
Retorna lead completo + `messages` (array, mais recente no fim, limitado a 200):
`{ id, phone, name, status, tags, languageInterest, level, objective, createdAt, updatedAt, takeover, messages: [{id, role, text, createdAt, meta}] }`
role: `lead` | `agent` | `human`.

### POST /api/leads/:id/send
Body: `{ text }`. Envia mensagem humana no WhatsApp (takeover implícito). Retorna `{ok:true, message:{...}}`.

### POST /api/leads/:id/takeover
Body: `{ active: bool }`. Quando `active=true`, a IA para de responder este lead (humano assume). Retorna lead atualizado.

### PUT /api/leads/:id
Body: campos editáveis (`name, status, tags, languageInterest, level, objective`). Retorna lead atualizado.

### GET /api/config
Retorna (chaves de API mascaradas): `{ systemPrompt, llm: { apiKeyMasked, baseUrl, model, temperature, configured }, ownerWhatsapp, maxHistory, escalation: { keywords: [string], maxAttempts: int, enabled: bool } }`

### PUT /api/config
Body (qualquer subconjunto): `{ systemPrompt, llm: { apiKey, baseUrl, model, temperature }, ownerWhatsapp, maxHistory, escalation: { keywords, maxAttempts, enabled } }`.
Se `llm.apiKey` vier vazio, NÃO altera a chave atual. Se vier string não vazia, substitui.
Persiste em tabela `configs` (chave/valor JSON).

### GET /api/knowledge
Retorna: `{ items: [{id, category, question, answer, enabled, createdAt, updatedAt}] }`

### POST /api/knowledge
Body: `{ category, question, answer, enabled }`. Retorna item criado.

### PUT /api/knowledge/:id
Body: mesmos campos. Retorna item atualizado.

### DELETE /api/knowledge/:id
Retorna `{ok:true}`.

### GET /api/logs?limit=100
Retorna: `{ logs: [{id, level, message, createdAt}] }` (level: info|warn|error).

### POST /api/whatsapp/logout
Desconecta sessão WhatsApp. Retorna `{ok:true}`.

### POST /api/whatsapp/reconnect
Reinicia conexão (gera novo QR se necessário). Retorna `{ok:true}`.

### GET /api/events (Server-Sent Events)
Stream SSE. Eventos enviados (tipo no campo `event`, dados em JSON):
- `qr` → `{ qr: dataURL }`
- `connection` → `{ connected: bool, state }`
- `message` → `{ leadId, message: {id, role, text, createdAt} }`
- `lead` → `{ lead: {...} }` (atualização de lead)
- `log` → `{ level, message, createdAt }`
O cliente abre `new EventSource('/api/events')` com `?password=...` na query string (SSE não suporta headers customizados). O backend valida a senha via query.

## Servindo o frontend
- `GET /admin` → `public/index.html`
- `GET /admin/*` → arquivos estáticos de `public/`
- O frontend é uma SPA single-page (um único index.html com navegação por abas JS, sem router de servidor).

## Esquema do Banco (SQLite, better-sqlite3, arquivo em data/nexvon.db)
- `leads(id INTEGER PK, phone TEXT UNIQUE, name TEXT, status TEXT DEFAULT 'novo', tags TEXT, language_interest TEXT, level TEXT, objective TEXT, takeover INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, last_message_at TEXT, unread INTEGER DEFAULT 0)`
- `messages(id INTEGER PK, lead_id INTEGER, role TEXT, text TEXT, meta TEXT, created_at TEXT)`
- `configs(key TEXT PK, value TEXT)`
- `knowledge(id INTEGER PK, category TEXT, question TEXT, answer TEXT, enabled INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT)`
- `logs(id INTEGER PK, level TEXT, message TEXT, created_at TEXT)`

## Comportamento do agente (backend)
1. Ao receber mensagem de um lead: cria/atualiza lead, salva mensagem (role=lead), marca unread.
2. Se `takeover=1` para este lead → NÃO responde com IA (humano assumiu).
3. Monta histórico (últimas N mensagens, role lead/agent/human) + system prompt (do config) + base de conhecimento (itens enabled, injetados como contexto) → chama LLM compatível com OpenAI (POST {baseUrl}/chat/completions).
4. Se LLM não configurada ou falhar → fallback: mensagem padrão de boas-vindas + link de pagamento + número humano.
5. Salva resposta (role=agent), envia via Baileys, atualiza lead (status, last_message_at, unread=0).
6. Detecta palavras-chave de escalonamento na mensagem do lead → responde com link wa.me do dono e marca lead com tag `escalonado`.
7. Emite eventos SSE a cada mensagem e mudança de conexão/QR.

## Conexão WhatsApp (Baileys)
- Usa `@whiskeysockets/baileys` v6, sessão salva em `data/baileys_auth/` (use `useMultiFileAuthState`).
- Ao receber `connection.update` com `qr` → gera data URL via pacote `qrcode` e guarda em memória + emite evento SSE `qr`.
- `open` → connected=true, emite `connection`.
- `close` com code 401 (desconectado) → limpa QR, emite `connection`.
- O QR também fica acessível via GET /api/status.
