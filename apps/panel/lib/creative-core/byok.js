'use strict';

// BYOK: a OpenAI API Key é da Organization. Guardada cifrada (AES-256-GCM, contexto HKDF próprio — uma chave de
// GA4/Meta nunca decifra esta e vice-versa), desde a Fase 4 em integration_secrets. Regras: só backend, nunca devolvida inteira
// (só os 4 últimos caracteres), nunca em log, nunca em job/erro, decifrada só no momento da chamada ao core.

const CONTEXTO_CRIPTO_OPENAI = 'openai-api-key-creative-v1';
const KEY_RE = /^sk-[A-Za-z0-9_-]{20,300}$/;
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

function validarFormatoChave(apiKey) {
  return typeof apiKey === 'string' && KEY_RE.test(apiKey.trim());
}

// O cofre guarda a key de UM tenant (Organization). Interface:
//   metadata() → { configured, last4, updatedAt }   gravar(valor)   apagar()   usar(fn) → fn(key) | null
// Em produção é a integração 'openai' da Organization (integration_secrets, Fase 4); nos testes,
// `cofreDeStore` sobre o memoryStore.
function createByok({ cofre }) {
  if (!cofre) throw new Error('createByok exige um cofre');
  return {
    status: () => cofre.metadata(),
    async save(apiKey) {
      if (!validarFormatoChave(apiKey)) {
        const err = new Error('formato de API Key inválido');
        err.httpStatus = 400;
        throw err;
      }
      await cofre.gravar(apiKey.trim());
      return cofre.metadata();
    },
    remove: () => cofre.apagar(),
    // Uso exclusivo do worker/rotas que chamam o core. Devolve null quando não há key ou ela não
    // decifra — o chamador trata como "reconectar".
    resolve: () => cofre.usar((key) => key),
  };
}

// Cofre sobre um store com get/save/deleteOpenAiKey (memoryStore dos testes). Guarda só cifrado.
function cofreDeStore({ store, encrypt, decrypt, tenantId }) {
  return {
    async metadata() {
      const s = await store.getSettings(tenantId);
      return {
        configured: Boolean(s && s.openaiKeyEnc),
        last4: (s && s.openaiKeyLast4) || null,
        updatedAt: (s && s.openaiKeyUpdatedAt) || null,
      };
    },
    gravar: (valor) => store.saveOpenAiKey(tenantId, encrypt(valor, CONTEXTO_CRIPTO_OPENAI), valor.slice(-4)),
    apagar: () => store.deleteOpenAiKey(tenantId),
    async usar(fn) {
      const s = await store.getSettings(tenantId);
      if (!s || !s.openaiKeyEnc) return null;
      const key = decrypt(s.openaiKeyEnc, CONTEXTO_CRIPTO_OPENAI);
      return key ? fn(key) : null;
    },
  };
}

// Testa a key sem custo de geração (lista de modelos). URL fixa — nenhum destino vem do usuário.
async function testarChave(apiKey, fetchImpl = globalThis.fetch) {
  if (!apiKey) return { ok: false, reason: 'missing' };
  try {
    const res = await fetchImpl(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected' };
    if (res.status === 429) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: `status_${res.status}` };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

module.exports = { createByok, cofreDeStore, testarChave, validarFormatoChave, CONTEXTO_CRIPTO_OPENAI };
