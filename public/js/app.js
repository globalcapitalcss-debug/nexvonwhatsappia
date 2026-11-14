/* ============================================================
   NEXVON AI — Painel Administrativo (SPA)
   Frontend puro: sem build, sem framework.
   Contrato de API: API_CONTRACT.md (congelado)
   ============================================================ */
'use strict';

/* ---------- Estado global ---------- */
const state = {
  pwd: localStorage.getItem('nx_admin_pwd') || '',
  currentView: 'dashboard',
  currentLeadId: null,
  leads: [],
  sse: null,
  charts: { messages: null, status: null },
  wa: { connected: false, qr: null, pairingCode: null, state: '' },
  llm: { configured: false, model: '', baseUrl: '' },
  kbItems: [],
  config: null,
  esc: { keywords: [], maxAttempts: 3, enabled: false },
};

const VIEW_TITLES = {
  dashboard: 'Dashboard',
  conversas: 'Conversas',
  leads: 'Leads',
  knowledge: 'Base de Conhecimento',
  config: 'Configurações da IA',
  escalonamento: 'Escalonamento',
  logs: 'Logs do Sistema',
  whatsapp: 'WhatsApp',
};

const STATUS_COLORS = {
  novo: '#38bdf8',
  qualificando: '#22d3ee',
  objeção: '#f59e0b',
  proposta: '#a78bfa',
  fechado: '#10b981',
  perdido: '#ef4444',
};

/* ============================================================
   UTILITÁRIOS
   ============================================================ */
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function toast(msg, type = 'info', duration = 3500) {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/* ============================================================
   API — fetch com header X-Admin-Password
   ============================================================ */
async function api(path, opts = {}) {
  const headers = Object.assign({
    'Content-Type': 'application/json',
    'X-Admin-Password': state.pwd,
  }, opts.headers || {});

  let res;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch (e) {
    throw new Error('Falha de rede: ' + e.message);
  }

  if (res.status === 401) {
    logout('Senha inválida ou sessão expirada.');
    throw new Error('unauthorized');
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `Erro ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/* ============================================================
   AUTENTICAÇÃO / LOGIN / LOGOUT
   ============================================================ */
function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#app-layout').classList.add('hidden');
  if (state.sse) { try { state.sse.close(); } catch {} state.sse = null; }
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app-layout').classList.remove('hidden');
  refreshStatus();
  loadCurrentView();
  connectSSE();
}

function logout(msg) {
  localStorage.removeItem('nx_admin_pwd');
  state.pwd = '';
  if (state.sse) { try { state.sse.close(); } catch {} state.sse = null; }
  showLogin();
  if (msg) $('#login-error').textContent = msg;
}

async function tryLogin(pwd) {
  state.pwd = pwd;
  try {
    await api('/api/status');
    localStorage.setItem('nx_admin_pwd', pwd);
    $('#login-error').textContent = '';
    showApp();
    toast('Bem-vindo ao painel NEXVON AI', 'success');
  } catch (e) {
    if (e.message === 'unauthorized') {
      $('#login-error').textContent = 'Senha incorreta.';
    } else {
      $('#login-error').textContent = 'Erro ao conectar: ' + e.message;
    }
    state.pwd = '';
  }
}

/* ============================================================
   NAVEGAÇÃO POR ABAS
   ============================================================ */
function showView(name) {
  state.currentView = name;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $('#topbar-title').textContent = VIEW_TITLES[name] || name;
  // Fechar sidebar no mobile
  $('#sidebar').classList.remove('open');
  loadCurrentView();
}

function loadCurrentView() {
  switch (state.currentView) {
    case 'dashboard': renderDashboard(); break;
    case 'conversas': renderConversas(); break;
    case 'leads': renderLeads(); break;
    case 'knowledge': renderKnowledge(); break;
    case 'config': renderConfig(); break;
    case 'escalonamento': renderEscalonamento(); break;
    case 'logs': renderLogs(); break;
    case 'whatsapp': renderWhatsapp(); break;
  }
}

/* ============================================================
   STATUS (WhatsApp + LLM) — topbar e aba WhatsApp
   ============================================================ */
async function refreshStatus() {
  try {
    const s = await api('/api/status');
    state.wa = s.whatsapp || state.wa;
    state.llm = s.llm || state.llm;
    updateWaUI();
  } catch (e) {
    if (e.message !== 'unauthorized') console.warn('status', e);
  }
}

function updateWaUI() {
  const dot = $('#wa-dot');
  const label = $('#wa-label');
  const big = $('#wa-status-big');
  const { connected, qr, pairingCode, state: st } = state.wa;

  dot.classList.remove('connected', 'waiting', 'offline');
  big.classList.remove('connected', 'waiting', 'offline');

  if (connected) {
    dot.classList.add('connected');
    big.classList.add('connected');
    label.textContent = 'Conectado';
    big.textContent = '● Conectado';
  } else if (qr || pairingCode) {
    dot.classList.add('waiting');
    big.classList.add('waiting');
    label.textContent = 'Aguardando QR';
    big.textContent = '○ Aguardando escaneamento';
  } else {
    dot.classList.add('offline');
    big.classList.add('offline');
    label.textContent = 'Desconectado';
    big.textContent = '✕ Desconectado';
  }

  // QR na aba WhatsApp
  const img = $('#wa-qr-img');
  const ph = $('#wa-qr-placeholder');
  const pairEl = $('#wa-pairing');
  if (qr) {
    img.src = qr;
    img.classList.remove('hidden');
    ph.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    ph.classList.remove('hidden');
  }
  if (pairingCode) {
    pairEl.textContent = pairingCode;
    pairEl.classList.remove('hidden');
  } else {
    pairEl.classList.add('hidden');
  }
}

/* ============================================================
   DASHBOARD
   ============================================================ */
async function renderDashboard() {
  const grid = $('#stats-grid');
  grid.innerHTML = '<div class="stat-card glass"><div class="stat-label">Carregando…</div></div>';
  try {
    const s = await api('/api/stats');
    const cards = [
      { label: 'Leads Totais', value: s.totalLeads ?? 0, icon: '👥' },
      { label: 'Ativos (7 dias)', value: s.activeLeads7d ?? 0, icon: '🔥' },
      { label: 'Mensagens Hoje', value: s.messagesToday ?? 0, icon: '💬' },
      { label: 'Conversas Abertas', value: s.conversationsOpen ?? 0, icon: '📂' },
      { label: 'Tempo Médio Resposta', value: fmtMs(s.avgResponseMs), icon: '⚡' },
      { label: 'Fechados', value: s.closedDeals ?? 0, icon: '✅' },
    ];
    grid.innerHTML = cards.map(c => `
      <div class="stat-card glass">
        <span class="stat-icon">${c.icon}</span>
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
      </div>
    `).join('');

    renderMessagesChart(s.messagesByDay || []);
    renderStatusChart(s.leadsByStatus || []);
  } catch (e) {
    grid.innerHTML = `<div class="stat-card glass"><div class="stat-label">Erro</div><div class="stat-value" style="font-size:14px;-webkit-text-fill-color:var(--danger)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderMessagesChart(data) {
  const ctx = $('#chart-messages').getContext('2d');
  const labels = data.map(d => d.date.slice(5)); // MM-DD
  const counts = data.map(d => d.count);
  const grad = ctx.createLinearGradient(0, 0, 0, 280);
  grad.addColorStop(0, 'rgba(34,211,238,0.4)');
  grad.addColorStop(1, 'rgba(16,185,129,0.02)');

  if (state.charts.messages) state.charts.messages.destroy();
  state.charts.messages = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Mensagens',
        data: counts,
        borderColor: '#22d3ee',
        backgroundColor: grad,
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#10b981',
        pointBorderColor: '#0a0e1a',
        pointRadius: 4,
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
      },
    },
  });
}

function renderStatusChart(data) {
  const ctx = $('#chart-status').getContext('2d');
  const labels = data.map(d => d.status);
  const counts = data.map(d => d.count);
  const colors = data.map(d => STATUS_COLORS[d.status] || '#64748b');

  if (state.charts.status) state.charts.status.destroy();
  state.charts.status = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: counts, backgroundColor: colors, borderColor: '#0a0e1a', borderWidth: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 11 }, padding: 12, boxWidth: 12 } },
      },
      cutout: '60%',
    },
  });
}

/* ============================================================
   CONVERSAS
   ============================================================ */
async function renderConversas() {
  await loadConversasList();
  if (state.currentLeadId) openChat(state.currentLeadId);
}

async function loadConversasList() {
  try {
    const search = $('#conv-search').value || '';
    const r = await api(`/api/leads?limit=100&offset=0&search=${encodeURIComponent(search)}`);
    state.leads = r.leads || [];
    const container = $('#conv-leads');
    if (!state.leads.length) {
      container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:12px">Nenhuma conversa encontrada.</div>';
      return;
    }
    container.innerHTML = state.leads.map(l => `
      <div class="conv-lead-item ${l.id === state.currentLeadId ? 'active' : ''}" data-id="${l.id}">
        <div class="conv-avatar">${escapeHtml(initials(l.name || l.phone))}</div>
        <div class="conv-info">
          <div class="conv-name-row">
            <span class="conv-name">${escapeHtml(l.name || l.phone)}</span>
            <span class="conv-time">${fmtTime(l.lastMessageAt)}</span>
          </div>
          <div class="conv-preview">${escapeHtml(l.lastMessageText || 'Sem mensagens')}</div>
          <div style="margin-top:4px;display:flex;gap:6px;align-items:center">
            <span class="badge badge-${l.status || 'novo'}">${escapeHtml(l.status || 'novo')}</span>
            ${l.takeover ? '<span class="conv-takeover-tag">HUMANO</span>' : ''}
          </div>
        </div>
        ${l.unread ? `<span class="conv-unread">${l.unread}</span>` : ''}
      </div>
    `).join('');

    $$('.conv-lead-item', container).forEach(el => {
      el.addEventListener('click', () => openChat(Number(el.dataset.id)));
    });
  } catch (e) {
    toast('Erro ao carregar conversas: ' + e.message, 'error');
  }
}

async function openChat(leadId) {
  state.currentLeadId = leadId;
  $$('.conv-lead-item').forEach(el => el.classList.toggle('active', Number(el.dataset.id) === leadId));
  $('#chat-empty').classList.add('hidden');
  $('#chat-active').classList.remove('hidden');

  try {
    const lead = await api(`/api/leads/${leadId}`);
    $('#chat-name').textContent = lead.name || lead.phone;
    $('#chat-phone').textContent = lead.phone ? `+${lead.phone}` : '';
    const badge = $('#chat-status-badge');
    badge.className = `badge badge-${lead.status || 'novo'}`;
    badge.textContent = lead.status || 'novo';

    const btn = $('#takeover-btn');
    if (lead.takeover) {
      btn.textContent = 'Liberar para IA';
      btn.classList.remove('btn-gold');
      btn.classList.add('btn-ghost');
    } else {
      btn.textContent = 'Retomar conversa';
      btn.classList.add('btn-gold');
      btn.classList.remove('btn-ghost');
    }

    renderMessages(lead.messages || []);
  } catch (e) {
    toast('Erro ao abrir conversa: ' + e.message, 'error');
  }
}

function renderMessages(messages) {
  const box = $('#chat-messages');
  box.innerHTML = messages.map(m => {
    const roleLabel = m.role === 'lead' ? 'Cliente' : m.role === 'agent' ? 'IA' : 'Você';
    return `
      <div class="msg msg-${m.role}">
        <span class="msg-role">${roleLabel}</span>
        ${escapeHtml(m.text)}
        <span class="msg-time">${fmtTime(m.createdAt)}</span>
      </div>
    `;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function appendMessage(leadId, message) {
  if (leadId !== state.currentLeadId || state.currentView !== 'conversas') return;
  const box = $('#chat-messages');
  const roleLabel = message.role === 'lead' ? 'Cliente' : message.role === 'agent' ? 'IA' : 'Você';
  const div = document.createElement('div');
  div.className = `msg msg-${message.role}`;
  div.innerHTML = `<span class="msg-role">${roleLabel}</span>${escapeHtml(message.text)}<span class="msg-time">${fmtTime(message.createdAt)}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendChatMessage(text) {
  if (!state.currentLeadId) return;
  try {
    await api(`/api/leads/${state.currentLeadId}/send`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    toast('Mensagem enviada', 'success', 1500);
  } catch (e) {
    toast('Erro ao enviar: ' + e.message, 'error');
  }
}

async function toggleTakeover() {
  if (!state.currentLeadId) return;
  const lead = state.leads.find(l => l.id === state.currentLeadId);
  const active = !(lead && lead.takeover);
  try {
    const updated = await api(`/api/leads/${state.currentLeadId}/takeover`, {
      method: 'POST',
      body: JSON.stringify({ active }),
    });
    const idx = state.leads.findIndex(l => l.id === state.currentLeadId);
    if (idx >= 0) state.leads[idx] = Object.assign(state.leads[idx], updated);
    openChat(state.currentLeadId);
    loadConversasList();
    toast(active ? 'IA pausada — humano assumiu' : 'IA retomou o atendimento', 'info');
  } catch (e) {
    toast('Erro no takeover: ' + e.message, 'error');
  }
}

/* ============================================================
   LEADS (tabela com edição inline)
   ============================================================ */
async function renderLeads() {
  const tbody = $('#leads-tbody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-faint)">Carregando…</td></tr>';
  try {
    const search = $('#leads-search').value || '';
    const r = await api(`/api/leads?limit=200&offset=0&search=${encodeURIComponent(search)}`);
    state.leads = r.leads || [];
    $('#leads-count').textContent = `${r.total ?? state.leads.length} lead(s)`;
    if (!state.leads.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-faint)">Nenhum lead encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = state.leads.map(l => leadRowHtml(l)).join('');
    bindLeadRowEvents(tbody);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--danger)">Erro: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function leadRowHtml(l) {
  const statusOpts = ['novo', 'qualificando', 'objeção', 'proposta', 'fechado', 'perdido']
    .map(s => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${s}</option>`).join('');
  const tagsStr = Array.isArray(l.tags) ? l.tags.join(', ') : (l.tags || '');
  return `
    <tr data-id="${l.id}">
      <td><input type="text" class="lead-name" value="${escapeHtml(l.name || '')}" placeholder="Nome" /></td>
      <td style="font-variant-numeric:tabular-nums;color:var(--text-dim)">${l.phone ? '+' + escapeHtml(l.phone) : '—'}</td>
      <td><select class="lead-status">${statusOpts}</select></td>
      <td><input type="text" class="lead-tags" value="${escapeHtml(tagsStr)}" placeholder="tag1, tag2" style="min-width:140px" /></td>
      <td><input type="text" class="lead-lang" value="${escapeHtml(l.languageInterest || '')}" placeholder="pt/en/es" style="width:70px" /></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-dim)" title="${escapeHtml(l.lastMessageText || '')}">${escapeHtml(l.lastMessageText || '—')}</td>
      <td>
        <div class="row-actions">
          <button class="btn-icon save" title="Salvar">💾</button>
          <button class="btn-icon" title="Abrir conversa">💬</button>
        </div>
      </td>
    </tr>
  `;
}

function bindLeadRowEvents(tbody) {
  $$('tr', tbody).forEach(tr => {
    const id = Number(tr.dataset.id);
    tr.querySelector('.btn-icon.save').addEventListener('click', async () => {
      const name = tr.querySelector('.lead-name').value.trim();
      const status = tr.querySelector('.lead-status').value;
      const tagsRaw = tr.querySelector('.lead-tags').value.trim();
      const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
      const languageInterest = tr.querySelector('.lead-lang').value.trim();
      try {
        await api(`/api/leads/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ name, status, tags, languageInterest }),
        });
        toast('Lead atualizado', 'success', 1500);
      } catch (e) {
        toast('Erro ao salvar: ' + e.message, 'error');
      }
    });
    tr.querySelectorAll('.btn-icon')[1].addEventListener('click', () => {
      showView('conversas');
      openChat(id);
    });
  });
}

/* ============================================================
   BASE DE CONHECIMENTO (FAQ) — CRUD
   ============================================================ */
async function renderKnowledge() {
  const list = $('#kb-list');
  list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-faint)">Carregando…</div>';
  try {
    const r = await api('/api/knowledge');
    state.kbItems = r.items || [];
    const search = ($('#kb-search').value || '').toLowerCase();
    const filtered = state.kbItems.filter(it =>
      !search ||
      (it.question || '').toLowerCase().includes(search) ||
      (it.answer || '').toLowerCase().includes(search) ||
      (it.category || '').toLowerCase().includes(search)
    );
    if (!filtered.length) {
      list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-faint)">Nenhum item. Clique em "Adicionar item".</div>';
      return;
    }
    list.innerHTML = filtered.map(it => `
      <div class="kb-item glass ${it.enabled ? '' : 'disabled'}" data-id="${it.id}">
        <div class="kb-main">
          <span class="kb-cat">${escapeHtml(it.category || 'Geral')}</span>
          <div class="kb-question">${escapeHtml(it.question)}</div>
          <div class="kb-answer">${escapeHtml(it.answer)}</div>
        </div>
        <div class="kb-actions">
          <button class="btn-icon kb-toggle" title="${it.enabled ? 'Desativar' : 'Ativar'}">${it.enabled ? '🟢' : '⚪'}</button>
          <button class="btn-icon kb-edit" title="Editar">✏️</button>
          <button class="btn-icon danger kb-del" title="Excluir">🗑</button>
        </div>
      </div>
    `).join('');

    $$('.kb-item', list).forEach(el => {
      const id = Number(el.dataset.id);
      const item = state.kbItems.find(i => i.id === id);
      el.querySelector('.kb-edit').addEventListener('click', () => openKbModal(item));
      el.querySelector('.kb-del').addEventListener('click', async () => {
        if (!confirm(`Excluir "${item.question}"?`)) return;
        try {
          await api(`/api/knowledge/${id}`, { method: 'DELETE' });
          toast('Item excluído', 'success', 1500);
          renderKnowledge();
        } catch (e) { toast('Erro: ' + e.message, 'error'); }
      });
      el.querySelector('.kb-toggle').addEventListener('click', async () => {
        try {
          await api(`/api/knowledge/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ ...item, enabled: !item.enabled }),
          });
          renderKnowledge();
        } catch (e) { toast('Erro: ' + e.message, 'error'); }
      });
    });
  } catch (e) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--danger)">Erro: ${escapeHtml(e.message)}</div>`;
  }
}

function openKbModal(item) {
  $('#kb-modal-title').textContent = item ? 'Editar item' : 'Adicionar item';
  $('#kb-id').value = item ? item.id : '';
  $('#kb-category').value = item ? (item.category || '') : '';
  $('#kb-question').value = item ? (item.question || '') : '';
  $('#kb-answer').value = item ? (item.answer || '') : '';
  $('#kb-enabled').checked = item ? !!item.enabled : true;
  $('#kb-modal').classList.remove('hidden');
  $('#kb-category').focus();
}

async function saveKb(e) {
  e.preventDefault();
  const id = $('#kb-id').value;
  const body = {
    category: $('#kb-category').value.trim(),
    question: $('#kb-question').value.trim(),
    answer: $('#kb-answer').value.trim(),
    enabled: $('#kb-enabled').checked,
  };
  try {
    if (id) {
      await api(`/api/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      toast('Item atualizado', 'success', 1500);
    } else {
      await api('/api/knowledge', { method: 'POST', body: JSON.stringify(body) });
      toast('Item criado', 'success', 1500);
    }
    $('#kb-modal').classList.add('hidden');
    renderKnowledge();
  } catch (e) {
    toast('Erro ao salvar: ' + e.message, 'error');
  }
}

/* ============================================================
   CONFIGURAÇÕES DA IA
   ============================================================ */
async function renderConfig() {
  try {
    const c = await api('/api/config');
    state.config = c;
    $('#cfg-system-prompt').value = c.systemPrompt || '';
    updatePromptCount();
    $('#cfg-api-key').value = '';
    $('#cfg-api-key').placeholder = c.llm && c.llm.apiKeyMasked
      ? `Atual: ${c.llm.apiKeyMasked} (deixe vazio para manter)`
      : 'deixe vazio para manter atual';
    $('#cfg-base-url').value = (c.llm && c.llm.baseUrl) || '';
    $('#cfg-model').value = (c.llm && c.llm.model) || '';
    $('#cfg-temperature').value = (c.llm && c.llm.temperature != null) ? c.llm.temperature : 0.7;
    $('#temp-value').textContent = $('#cfg-temperature').value;
    $('#cfg-owner').value = c.ownerWhatsapp || '';
    $('#cfg-max-history').value = c.maxHistory || 20;

    const badge = $('#llm-status-badge');
    if (c.llm && c.llm.configured) {
      badge.className = 'llm-status ok';
      badge.textContent = `LLM configurada · ${c.llm.model || ''}`;
    } else {
      badge.className = 'llm-status nope';
      badge.textContent = 'LLM NÃO configurada';
    }
  } catch (e) {
    toast('Erro ao carregar config: ' + e.message, 'error');
  }
}

function updatePromptCount() {
  $('#prompt-count').textContent = `${$('#cfg-system-prompt').value.length} caracteres`;
}

async function saveConfig(e) {
  e.preventDefault();
  const body = {
    systemPrompt: $('#cfg-system-prompt').value,
    llm: {
      apiKey: $('#cfg-api-key').value, // vazio = mantém atual
      baseUrl: $('#cfg-base-url').value.trim(),
      model: $('#cfg-model').value.trim(),
      temperature: parseFloat($('#cfg-temperature').value),
    },
    ownerWhatsapp: $('#cfg-owner').value.trim(),
    maxHistory: parseInt($('#cfg-max-history').value, 10) || 20,
  };
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    toast('Configurações salvas', 'success');
    renderConfig();
  } catch (e) {
    toast('Erro ao salvar: ' + e.message, 'error');
  }
}

/* ============================================================
   ESCALONAMENTO
   ============================================================ */
async function renderEscalonamento() {
  try {
    const c = await api('/api/config');
    state.esc = Object.assign({ keywords: [], maxAttempts: 3, enabled: false }, c.escalation || {});
    $('#esc-enabled').checked = !!state.esc.enabled;
    $('#esc-max-attempts').value = state.esc.maxAttempts || 3;
    renderKwList();
  } catch (e) {
    toast('Erro ao carregar: ' + e.message, 'error');
  }
}

function renderKwList() {
  const list = $('#kw-list');
  if (!state.esc.keywords.length) {
    list.innerHTML = '<span style="color:var(--text-faint);font-size:12px">Nenhuma palavra-chave.</span>';
    return;
  }
  list.innerHTML = state.esc.keywords.map((k, i) => `
    <span class="kw-chip">${escapeHtml(k)}<button data-i="${i}" title="Remover">✕</button></span>
  `).join('');
  $$('.kw-chip button', list).forEach(btn => {
    btn.addEventListener('click', () => {
      state.esc.keywords.splice(Number(btn.dataset.i), 1);
      renderKwList();
    });
  });
}

function addKeyword() {
  const input = $('#kw-input');
  const v = input.value.trim();
  if (!v) return;
  if (state.esc.keywords.includes(v)) { toast('Já existe', 'info', 1500); return; }
  state.esc.keywords.push(v);
  input.value = '';
  renderKwList();
}

async function saveEscalonamento() {
  const body = {
    escalation: {
      keywords: state.esc.keywords,
      maxAttempts: parseInt($('#esc-max-attempts').value, 10) || 3,
      enabled: $('#esc-enabled').checked,
    },
  };
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    toast('Escalonamento salvo', 'success');
  } catch (e) {
    toast('Erro ao salvar: ' + e.message, 'error');
  }
}

/* ============================================================
   LOGS
   ============================================================ */
async function renderLogs() {
  try {
    const r = await api('/api/logs?limit=200');
    const list = $('#logs-list');
    const logs = r.logs || [];
    if (!logs.length) {
      list.innerHTML = '<div style="color:var(--text-faint);padding:12px">Nenhum log registrado.</div>';
      return;
    }
    list.innerHTML = logs.map(logHtml).join('');
    list.scrollTop = list.scrollHeight;
  } catch (e) {
    $('#logs-list').innerHTML = `<div style="color:var(--danger);padding:12px">Erro: ${escapeHtml(e.message)}</div>`;
  }
}

function logHtml(l) {
  const t = l.createdAt ? new Date(l.createdAt) : new Date();
  const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  return `<div class="log-entry ${l.level || 'info'}"><span class="log-time">${ts}</span><span class="log-level">${escapeHtml(l.level || 'info')}</span><span>${escapeHtml(l.message || '')}</span></div>`;
}

function appendLog(l) {
  if (state.currentView !== 'logs') return;
  const list = $('#logs-list');
  list.insertAdjacentHTML('beforeend', logHtml(l));
  list.scrollTop = list.scrollHeight;
}

/* ============================================================
   WHATSAPP
   ============================================================ */
async function renderWhatsapp() {
  await refreshStatus();
  updateWaUI();
}

async function waReconnect() {
  try {
    await api('/api/whatsapp/reconnect', { method: 'POST' });
    toast('Reconectando… novo QR em breve', 'info');
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

async function waLogout() {
  if (!confirm('Desconectar o WhatsApp? Será necessário escanear QR novamente.')) return;
  try {
    await api('/api/whatsapp/logout', { method: 'POST' });
    toast('Desconectado', 'success', 2000);
    refreshStatus();
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

/* ============================================================
   SSE — EventSource(/api/events?password=...)
   Eventos: qr, connection, message, lead, log
   ============================================================ */
function connectSSE() {
  if (state.sse) { try { state.sse.close(); } catch {} }
  if (!state.pwd) return;
  const url = `/api/events?password=${encodeURIComponent(state.pwd)}`;
  const es = new EventSource(url);
  state.sse = es;

  es.addEventListener('qr', (e) => {
    try {
      const d = JSON.parse(e.data);
      state.wa.qr = d.qr;
      state.wa.connected = false;
      updateWaUI();
    } catch {}
  });

  es.addEventListener('connection', (e) => {
    try {
      const d = JSON.parse(e.data);
      state.wa.connected = !!d.connected;
      state.wa.state = d.state || '';
      if (d.connected) { state.wa.qr = null; state.wa.pairingCode = null; }
      updateWaUI();
      toast(d.connected ? 'WhatsApp conectado!' : 'WhatsApp desconectado', d.connected ? 'success' : 'warn');
    } catch {}
  });

  es.addEventListener('message', (e) => {
    try {
      const d = JSON.parse(e.data);
      appendMessage(d.leadId, d.message);
      // Atualiza lista de conversas se estiver na aba
      if (state.currentView === 'conversas') loadConversasList();
      if (state.currentView === 'dashboard') renderDashboard();
    } catch {}
  });

  es.addEventListener('lead', (e) => {
    try {
      const d = JSON.parse(e.data);
      const idx = state.leads.findIndex(l => l.id === d.lead.id);
      if (idx >= 0) state.leads[idx] = Object.assign(state.leads[idx], d.lead);
      else state.leads.unshift(d.lead);
      if (state.currentView === 'conversas') loadConversasList();
      if (state.currentView === 'leads') renderLeads();
      if (state.currentView === 'dashboard') renderDashboard();
    } catch {}
  });

  es.addEventListener('log', (e) => {
    try {
      const d = JSON.parse(e.data);
      appendLog(d);
    } catch {}
  });

  es.onerror = () => {
    // Reconecta automaticamente; EventSource nativo já faz retry.
    console.warn('SSE error — retry automático');
  };
}

/* ============================================================
   EVENT LISTENERS / BOOT
   ============================================================ */
function bindEvents() {
  // Login
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const pwd = $('#login-password').value;
    if (!pwd) { $('#login-error').textContent = 'Digite a senha.'; return; }
    tryLogin(pwd);
  });
  $('#toggle-pwd').addEventListener('click', () => {
    const inp = $('#login-password');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Logout
  $('#logout-btn').addEventListener('click', () => logout());

  // Navegação
  $$('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // Hamburger (mobile)
  $('#hamburger').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // Conversas
  $('#conv-search').addEventListener('input', debounce(() => { if (state.currentView === 'conversas') loadConversasList(); }, 300));
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#chat-input');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    sendChatMessage(text);
  });
  $('#takeover-btn').addEventListener('click', toggleTakeover);

  // Leads
  $('#leads-search').addEventListener('input', debounce(() => { if (state.currentView === 'leads') renderLeads(); }, 300));

  // Knowledge
  $('#kb-add-btn').addEventListener('click', () => openKbModal(null));
  $('#kb-cancel').addEventListener('click', () => $('#kb-modal').classList.add('hidden'));
  $('#kb-form').addEventListener('submit', saveKb);
  $('#kb-search').addEventListener('input', debounce(() => { if (state.currentView === 'knowledge') renderKnowledge(); }, 300));
  $('#kb-modal').addEventListener('click', (e) => { if (e.target.id === 'kb-modal') $('#kb-modal').classList.add('hidden'); });

  // Config
  $('#config-form').addEventListener('submit', saveConfig);
  $('#cfg-system-prompt').addEventListener('input', updatePromptCount);
  $('#cfg-temperature').addEventListener('input', () => { $('#temp-value').textContent = $('#cfg-temperature').value; });

  // Escalonamento
  $('#kw-add-btn').addEventListener('click', addKeyword);
  $('#kw-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } });
  $('#esc-save-btn').addEventListener('click', saveEscalonamento);

  // Logs
  $('#logs-refresh').addEventListener('click', renderLogs);

  // WhatsApp
  $('#wa-reconnect').addEventListener('click', waReconnect);
  $('#wa-logout').addEventListener('click', waLogout);

  // Refresh periódico de status
  setInterval(() => { if (state.pwd) refreshStatus(); }, 30000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  if (state.pwd) {
    // Tenta autenticar silenciosamente
    api('/api/status').then(() => showApp()).catch(() => showLogin());
  } else {
    showLogin();
  }
});
