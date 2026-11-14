// ============================================================
//  src/llm.js — Cliente LLM compatível com OpenAI
//  POST {baseUrl}/chat/completions com Authorization Bearer.
//  Se não configurado ou falhar → retorna null (fallback do agente).
// ============================================================
import { getConfig } from './db.js';
import { addLog } from './db.js';
import config from './config.js';

/**
 * Lê as configurações de LLM do banco (com fallback para env).
 */
function getLlmConfig() {
  const dbCfg = getConfig('llm', {}) || {};
  return {
    apiKey: dbCfg.apiKey || config.LLM_API_KEY || '',
    baseUrl: (dbCfg.baseUrl || config.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: dbCfg.model || config.LLM_MODEL || 'gpt-4o-mini',
    temperature: dbCfg.temperature ?? config.LLM_TEMPERATURE ?? 0.7,
    timeoutMs: config.LLM_TIMEOUT_MS || 30000,
  };
}

/**
 * Completa o chat.
 * @param {object} opts
 * @param {Array<{role:string, content:string}>} opts.messages — histórico (já em ordem)
 * @param {string} opts.systemPrompt — system prompt (do config)
 * @param {Array} opts.knowledgeItems — itens de conhecimento habilitados
 * @returns {Promise<string|null>} texto da resposta ou null em falha
 */
export async function chatComplete({ messages = [], systemPrompt = '', knowledgeItems = [] }) {
  const llm = getLlmConfig();

  // Sem chave configurada → modo fallback
  if (!llm.apiKey) {
    return null;
  }

  // Injeta conhecimento no system prompt
  let systemContent = systemPrompt || '';
  if (knowledgeItems && knowledgeItems.length) {
    const kb = knowledgeItems
      .map(k => `Pergunta: ${k.question}\nResposta: ${k.answer}`)
      .join('\n\n---\n\n');
    systemContent += `\n\n## BASE DE CONHECIMENTO (use estes fatos quando relevante, não invente):\n${kb}`;
  }

  const body = {
    model: llm.model,
    messages: [
      { role: 'system', content: systemContent },
      ...messages.map(m => ({ role: m.role === 'human' ? 'assistant' : (m.role === 'lead' ? 'user' : m.role), content: m.content || m.text || '' })),
    ],
    temperature: Number(llm.temperature),
    max_tokens: 600,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), llm.timeoutMs);

  try {
    const res = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      addLog('warn', `LLM respondeu HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || typeof text !== 'string') {
      addLog('warn', 'LLM retornou resposta vazia.');
      return null;
    }
    return text.trim();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      addLog('warn', `LLM timeout após ${llm.timeoutMs}ms.`);
    } else {
      addLog('error', `Erro na chamada à LLM: ${err.message}`);
    }
    return null;
  }
}

/** Indica se a LLM está configurada (tem chave). */
export function isLlmConfigured() {
  return !!getLlmConfig().apiKey;
}

export default { chatComplete, isLlmConfigured };
