// ============================================================
//  src/agent.js — Lógica do agente de vendas (Aria Vendas)
//  Recebe mensagens, decide resposta, envia via WhatsApp,
//  persiste no banco e emite eventos para SSE.
// ============================================================
import { EventEmitter } from 'node:events';
import {
  upsertLead, getLeadByPhone, getLeadById, updateLead,
  addMessage, getLeadMessages, getConfig, setConfig,
  listKnowledge, addLog,
} from './db.js';
import { chatComplete } from './llm.js';
import { sendMessage } from './whatsapp.js';
import config from './config.js';

// EventEmitter simples para SSE (qr/connection/message/lead/log)
export const agentEvents = new EventEmitter();
agentEvents.setMaxListeners(100);

// Re-exporta utilidade: o server também emite qr/connection por aqui
export function emitEvent(type, data) {
  agentEvents.emit('event', { type, data, ts: new Date().toISOString() });
}

/** Link wa.me do dono (atendimento humano). */
function ownerWaLink() {
  const owner = getConfig('owner_whatsapp', config.OWNER_WHATSAPP) || config.OWNER_WHATSAPP;
  return `https://wa.me/${owner}`;
}

/** Mensagem de fallback (sem LLM ou LLM falhou). */
function fallbackMessage(leadName) {
  const nome = leadName ? `, ${leadName}` : '';
  return `Olá${nome}! Tudo bem? 😊 Sou a Aria, da NEXVON FLUENCY.

A NEXVON é a plataforma de idiomas por IMERSÃO: você aprende com filmes, séries, YouTube e podcasts que já ama. +40 idiomas em um acesso VITALÍCIO.

✅ Pagamento ÚNICO de $99 (50% OFF) — sem mensalidade
✅ Garantia incondicional de 7 dias
✅ Aria: sua parceira de conversação com IA 24h

Para garantir seu acesso: https://nexvonfluency.com.br/
Prefere falar com uma pessoa? É só chamar aqui: ${ownerWaLink()}`;
}

/** Mensagem de escalonamento humano. */
function escalationMessage() {
  return `Claro! Vou te passar com nosso atendente humano, ele vai te ajudar agora mesmo. 😊

É só clicar aqui: ${ownerWaLink()}`;
}

/** Verifica se o texto casa com alguma keyword de escalonamento. */
function matchesEscalation(text) {
  const esc = getConfig('escalation', { keywords: [], enabled: true });
  if (!esc || esc.enabled === false) return false;
  const lower = (text || '').toLowerCase();
  return (esc.keywords || []).some(k => lower.includes(String(k).toLowerCase()));
}

/** Heurística simples de atualização de status do lead. */
function inferStatus(text, currentStatus) {
  const lower = (text || '').toLowerCase();
  const compra = ['comprar', 'pix', 'link', 'quero', 'quero comprar', 'como pago', 'pagamento', 'comprar agora', 'fechar'];
  if (compra.some(k => lower.includes(k))) return 'proposta';
  if (lower.includes('obrigado') || lower.includes('obrigada')) return currentStatus; // não marca perdido
  return currentStatus;
}

/**
 * Trata uma mensagem recebida de um lead.
 * @param {{phone:string, text:string, pushName?:string}} param0
 */
export async function handleIncoming({ phone, text, pushName }) {
  try {
    // 1. Cria/atualiza lead
    let lead = upsertLead({ phone, pushName });

    // 2. Salva mensagem do lead (role=lead) e marca unread
    const msgIn = addMessage({ leadId: lead.id, role: 'lead', text });
    lead = updateLead(lead.id, { unread: (lead.unread || 0) + 1 });
    emitEvent('message', { leadId: lead.id, message: { id: msgIn.id, role: 'lead', text, createdAt: msgIn.created_at } });
    emitEvent('lead', { lead: serializeLead(lead) });

    // 3. Verifica takeover (humano assumiu) → IA não responde
    if (lead.takeover === 1) {
      addLog('info', `Lead ${phone} em takeover — IA não responde.`);
      return;
    }

    // 4. Verifica keywords de escalonamento
    if (matchesEscalation(text)) {
      const reply = escalationMessage();
      const ok = await sendMessage(phone, reply);
      const msgOut = addMessage({ leadId: lead.id, role: 'agent', text: reply, meta: { escalation: true, delivered: ok } });
      // Marca tag 'escalonado'
      let tags = [];
      try { tags = JSON.parse(lead.tags || '[]'); } catch { tags = []; }
      if (!tags.includes('escalonado')) tags.push('escalonado');
      lead = updateLead(lead.id, { tags, unread: 0 });
      emitEvent('message', { leadId: lead.id, message: { id: msgOut.id, role: 'agent', text: reply, createdAt: msgOut.created_at } });
      emitEvent('lead', { lead: serializeLead(lead) });
      addLog('info', `Lead ${phone} escalonado para humano.`);
      return;
    }

    // 5. Monta histórico das últimas N mensagens e chama LLM
    const maxHistory = Number(getConfig('max_history', config.LLM_MAX_HISTORY)) || 20;
    const history = getLeadMessages(lead.id, maxHistory + 1)
      .slice(-maxHistory)
      .map(m => ({ role: m.role, text: m.text }));

    const systemPrompt = getConfig('system_prompt', '') || '';
    const knowledgeItems = listKnowledge(true);

    const llmReply = await chatComplete({ messages: history, systemPrompt, knowledgeItems });

    let replyText;
    if (llmReply) {
      replyText = llmReply;
    } else {
      // 6. Fallback: mensagem padrão
      replyText = fallbackMessage(lead.name || pushName);
      addLog('warn', `LLM indisponível para lead ${phone} — usando fallback.`);
    }

    // 7. Envia via WhatsApp e salva (role=agent)
    const ok = await sendMessage(phone, replyText);
    const msgOut = addMessage({ leadId: lead.id, role: 'agent', text: replyText, meta: { delivered: ok, fallback: !llmReply } });

    // 8. Atualiza status (heurística) e zera unread
    const newStatus = inferStatus(text, lead.status || 'novo');
    lead = updateLead(lead.id, { status: newStatus, unread: 0 });

    emitEvent('message', { leadId: lead.id, message: { id: msgOut.id, role: 'agent', text: replyText, createdAt: msgOut.created_at } });
    emitEvent('lead', { lead: serializeLead(lead) });
  } catch (e) {
    addLog('error', `Erro no handleIncoming (${phone}): ${e.message}`);
  }
}

/** Envia mensagem humana (pelo painel admin) — takeover implícito. */
export async function sendHumanMessage(leadId, text) {
  const lead = getLeadById(leadId);
  if (!lead) return null;
  // Takeover implícito: humano assumiu
  updateLead(leadId, { takeover: 1 });
  const ok = await sendMessage(lead.phone, text);
  const msg = addMessage({ leadId, role: 'human', text, meta: { delivered: ok } });
  const updated = updateLead(leadId, { unread: 0 });
  emitEvent('message', { leadId, message: { id: msg.id, role: 'human', text, createdAt: msg.created_at } });
  emitEvent('lead', { lead: serializeLead(updated) });
  return { ok, message: msg, lead: updated };
}

/** Serializa lead para o formato do contrato (camelCase). */
export function serializeLead(l) {
  if (!l) return null;
  let tags = [];
  try { tags = JSON.parse(l.tags || '[]'); } catch { tags = []; }
  return {
    id: l.id,
    phone: l.phone,
    name: l.name,
    status: l.status,
    tags,
    languageInterest: l.language_interest,
    level: l.level,
    objective: l.objective,
    takeover: !!l.takeover,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    lastMessageAt: l.last_message_at,
    unread: l.unread || 0,
  };
}

export default { handleIncoming, sendHumanMessage, agentEvents, emitEvent, serializeLead };
