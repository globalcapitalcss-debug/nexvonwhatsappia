// ============================================================
//  src/config.js — Carregamento de configuração (.env manual)
//  NÃO usamos biblioteca externa (dotenv). Parse simples com fs.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Raiz do projeto (um nível acima de src/)
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');

/**
 * Faz parse simples de um arquivo .env:
 * - ignora linhas em branco e comentários (#)
 * - suporta KEY=VALUE (valor pode ter espaços; sem aspas por enquanto)
 * - NÃO sobrescreve variáveis já presentes em process.env
 */
function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  let raw = '';
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (e) {
    console.warn('[config] Não foi possível ler .env:', e.message);
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Remove aspas simples/duplas no início/fim, se existirem
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Variável de ambiente existente tem precedência
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

// Helpers de conversão
const str = (v, d = '') => (v === undefined || v === null || v === '' ? d : String(v));
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// Objeto de configuração consolidado
export const config = {
  PORT: num(process.env.PORT, 3000),
  ADMIN_PASSWORD: str(process.env.ADMIN_PASSWORD, 'nexvon2026'),
  LLM_API_KEY: str(process.env.LLM_API_KEY, ''),
  LLM_BASE_URL: str(process.env.LLM_BASE_URL, 'https://api.openai.com/v1').replace(/\/+$/, ''),
  LLM_MODEL: str(process.env.LLM_MODEL, 'gpt-4o-mini'),
  LLM_TEMPERATURE: num(process.env.LLM_TEMPERATURE, 0.7),
  OWNER_WHATSAPP: str(process.env.OWNER_WHATSAPP, '5519997048175'),
  LLM_MAX_HISTORY: num(process.env.LLM_MAX_HISTORY, 20),
  LLM_TIMEOUT_MS: num(process.env.LLM_TIMEOUT_MS, 30000),
  ROOT_DIR,
  DATA_DIR: path.join(ROOT_DIR, 'data'),
  PUBLIC_DIR: path.join(ROOT_DIR, 'public'),
  DB_PATH: path.join(ROOT_DIR, 'data', 'nexvon.db'),
  BAILEYS_AUTH_DIR: path.join(ROOT_DIR, 'data', 'baileys_auth'),
  VERSION: '1.0.0',
};

// Garante que os diretórios de dados existam
for (const d of [config.DATA_DIR, config.BAILEYS_AUTH_DIR]) {
  if (!fs.existsSync(d)) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

export default config;
