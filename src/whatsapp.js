// ============================================================
//  src/whatsapp.js — Integração com WhatsApp via Baileys v6
//  Sessão salva em data/baileys_auth (useMultiFileAuthState).
// ============================================================
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { toDataURL } from 'qrcode';
import config from './config.js';
import { addLog } from './db.js';

// Logger no-op para o Baileys (evita poluir o console; não depende de pino)
const noop = () => {};
const baileysLogger = {
  trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  child: () => baileysLogger,
};

let sock = null;          // socket ativo
let currentQR = null;     // último QR (data URL) em memória
let currentState = 'disconnected';
let isConnected = false;
let reconnecting = false;

// Callbacks injetados pelo server
let callbacks = {
  onQR: () => {},
  onConnection: () => {},
  onMessage: () => {},
  getLead: () => null,
  shouldAgentReply: () => true,
};

/**
 * Extrai o texto de uma mensagem Baileys (vários formatos possíveis).
 */
function extractText(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.buttonsResponseMessage?.selectedDisplayText) return message.buttonsResponseMessage.selectedDisplayText;
  if (message.listResponseMessage?.title) return message.listResponseMessage.title;
  if (message.templateButtonReplyMessage?.selectedDisplayText) return message.templateButtonReplyMessage.selectedDisplayText;
  return '';
}

/**
 * Inicia (ou reinicia) a conexão com o WhatsApp.
 * @param {object} cbs — { onQR(dataURL), onConnection(connected, reason), onMessage({phone,text,pushName}), getLead(phone), shouldAgentReply(phone) }
 */
export async function startWhatsApp(cbs = {}) {
  callbacks = { ...callbacks, ...cbs };

  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(config.BAILEYS_AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: false }));

    sock = makeWASocket.default
      ? makeWASocket.default({
          version,
          auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
          logger: baileysLogger,
          printQRInTerminal: false,
          browser: ['NEXVON AI', 'Chrome', '1.0'],
          markOnlineOnConnect: false,
        })
      : makeWASocket({
          version,
          auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
          logger: baileysLogger,
          printQRInTerminal: false,
          browser: ['NEXVON AI', 'Chrome', '1.0'],
          markOnlineOnConnect: false,
        });

    // Persiste credenciais quando atualizadas
    sock.ev.on('creds.update', saveCreds);

    // --- Eventos de conexão ---
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQR = await toDataURL(qr);
          currentState = 'qr';
          callbacks.onQR(currentQR);
        } catch (e) {
          addLog('error', `Falha ao gerar QR data URL: ${e.message}`);
        }
      }

      if (connection === 'open') {
        isConnected = true;
        currentState = 'connected';
        currentQR = null;
        addLog('info', 'WhatsApp conectado com sucesso.');
        callbacks.onConnection(true, 'open');
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = statusCode === DisconnectReason.loggedOut ? 'logged_out'
                     : statusCode === DisconnectReason.restartRequired ? 'restart_required'
                     : statusCode === DisconnectReason.timedOut ? 'timeout'
                     : 'closed';
        currentState = reason;
        addLog('warn', `Conexão WhatsApp fechada (${reason}).`);
        callbacks.onConnection(false, reason);

        // Logout (401) → não reconecta automaticamente; espera novo QR via /reconnect
        if (statusCode !== DisconnectReason.loggedOut) {
          reconnecting = false;
          // Pequeno delay antes de reconectar
          setTimeout(() => startWhatsApp(callbacks).catch(e => addLog('error', `Reconnect falhou: ${e.message}`)), 3000);
        } else {
          currentQR = null;
          reconnecting = false;
        }
      }
    });

    // --- Eventos de mensagens recebidas ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        try {
          const remoteJid = msg.key?.remoteJid || '';
          // Apenas chats diretos (@s.whatsapp.net), não grupos (@g.us)
          if (!remoteJid.endsWith('@s.whatsapp.net')) continue;
          // Não é do próprio bot
          if (msg.key?.fromMe) continue;
          // Precisa ter conteúdo de mensagem
          if (!msg.message) continue;

          const phone = remoteJid.replace('@s.whatsapp.net', '').split(':')[0];
          const text = extractText(msg.message);
          if (!text) continue; // ignora stickers/aulas sem texto por enquanto

          const pushName = msg.pushName || null;
          callbacks.onMessage({ phone, text, pushName });
        } catch (e) {
          addLog('error', `Erro ao processar mensagem recebida: ${e.message}`);
        }
      }
    });

    reconnecting = false;
  } catch (e) {
    reconnecting = false;
    addLog('error', `Falha ao iniciar WhatsApp: ${e.message}`);
    throw e;
  }
}

/** Envia uma mensagem de texto para um número (formato E.164 sem +). */
export async function sendMessage(phone, text) {
  if (!sock || !isConnected) {
    addLog('warn', `Tentativa de envio sem conexão WhatsApp (para ${phone}).`);
    return false;
  }
  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    return true;
  } catch (e) {
    addLog('error', `Falha ao enviar mensagem para ${phone}: ${e.message}`);
    return false;
  }
}

/** Desconecta e apaga a sessão (logout). */
export async function logout() {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock.end(undefined);
    }
  } catch {}
  isConnected = false;
  currentQR = null;
  currentState = 'logged_out';
  addLog('info', 'Logout do WhatsApp solicitado.');
  return true;
}

/** Força reconexão (gera novo QR se necessário). */
export async function reconnect() {
  try {
    if (sock) { sock.end(undefined); }
  } catch {}
  isConnected = false;
  currentQR = null;
  // Limpa flag para permitir reconexão
  reconnecting = false;
  await startWhatsApp(callbacks);
  return true;
}

/** Estado atual para /api/status. */
export function getWhatsAppState() {
  return { connected: isConnected, qr: currentQR, pairingCode: null, state: currentState };
}

export default { startWhatsApp, sendMessage, logout, reconnect, getWhatsAppState };
