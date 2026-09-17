'use strict';

// TD-004 / B-07 — chave de cifra própria, versionada, independente do segredo de sessão.
//
// O estado em `8a7ea3d` (`server.js:9578-9612`): todas as chaves AES são derivadas por HKDF do
// `ADMIN_SESSION_SECRET`. Três consequências, e nenhuma delas é teórica:
//
//  1. rotacionar o segredo de SESSÃO torna ilegível todo segredo de INTEGRAÇÃO gravado — o próprio
//     comentário do código admite isso ("a loja aparece com status error e precisa reconectar");
//  2. por isso, na prática, o segredo de sessão nunca é rotacionado;
//  3. o ciphertext não carrega versão de chave, então não existe rotação incremental: só
//     "reconecte tudo de novo".
//
// Aqui: `ENCRYPTION_MASTER_KEY` própria, `key_version` gravada JUNTO do ciphertext, leitura
// aceitando qualquer versão ativa, escrita sempre na corrente. AES-256-GCM permanece.
//
// ── Compatibilidade legacy, controlada e datada ──────────────────────────────────────────────
// A versão 0 é a chave derivada de `ADMIN_SESSION_SECRET`, aceita SOMENTE para LEITURA, e existe
// só para permitir a re-cifra dos ciphertexts que já estão em produção. ENQUANTO ESSE FALLBACK
// EXISTIR, `ADMIN_SESSION_SECRET` CONTINUA SENDO MATERIAL SENSÍVEL E NÃO PODE SER ROTACIONADO.
// A remoção é numa release POSTERIOR à validação da re-cifra, não "quando não precisar mais".

const crypto = require('crypto');

const VERSAO_LEGACY = 0;

// Contextos HKDF preservados de 8a7ea3d: mudá-los tornaria ilegível tudo que já está gravado.
const CONTEXTO_GA4 = 'ga4-refresh-token-v1';
const CONTEXTO_META = 'meta-ads-access-token-v1';
const CONTEXTO_GOOGLE_ADS = 'google-ads-refresh-token-v1';

class SecretKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

function parseChaveMestra(valor) {
  const bruto = String(valor || '').trim();
  if (!bruto) return null;
  // base64 ou hex; exigimos 32 bytes (AES-256).
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(bruto)) buf = Buffer.from(bruto, 'hex');
  else buf = Buffer.from(bruto, 'base64');
  if (buf.length !== 32) {
    throw new SecretKeyError(
      `ENCRYPTION_MASTER_KEY precisa ter 32 bytes (AES-256); recebi ${buf.length}. ` +
      'Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  return buf;
}

// Deriva a chave de um contexto a partir de um material-base. Contextos diferentes produzem chaves
// independentes: um token do Google não é decifrável com a chave da Meta, mesmo com uma chave
// mestra só. Mesmo esquema de 8a7ea3d — o que muda é DE ONDE vem o material.
function derivar(material, contexto) {
  return Buffer.from(crypto.hkdfSync('sha256', material, '', contexto, 32));
}

// Monta o chaveiro a partir do ambiente.
//
// `ENCRYPTION_MASTER_KEY`      → versão corrente (default 1, ou ENCRYPTION_KEY_VERSION)
// `ENCRYPTION_MASTER_KEY_PREV` → versão anterior, aceita só para leitura durante a rotação
// `ADMIN_SESSION_SECRET`       → versão 0 (legacy), aceita só para leitura, sob flag explícita
function createKeyring(env = process.env) {
  const versaoCorrente = Number(env.ENCRYPTION_KEY_VERSION || 1);
  if (!Number.isInteger(versaoCorrente) || versaoCorrente < 1) {
    throw new SecretKeyError(`ENCRYPTION_KEY_VERSION inválida: ${env.ENCRYPTION_KEY_VERSION}`);
  }

  const mestra = parseChaveMestra(env.ENCRYPTION_MASTER_KEY);
  const anterior = parseChaveMestra(env.ENCRYPTION_MASTER_KEY_PREV);

  // O fallback legacy é OPT-IN. Sem a flag, `ADMIN_SESSION_SECRET` não participa de NADA relativo
  // a segredo persistido — que é o requisito literal de TD-004. Com a flag, participa só da
  // leitura da versão 0, e o chamador consegue perguntar por isso (`legacyAtivo`) para colocar a
  // janela no runbook.
  const legacyAtivo = String(env.ENCRYPTION_ALLOW_LEGACY_SESSION_KEY || '').trim() === '1';
  const segredoSessao = legacyAtivo ? String(env.ADMIN_SESSION_SECRET || '') : '';

  const materiais = new Map();
  if (mestra) materiais.set(versaoCorrente, mestra);
  if (anterior && !materiais.has(versaoCorrente - 1)) materiais.set(versaoCorrente - 1, anterior);
  if (legacyAtivo && segredoSessao) materiais.set(VERSAO_LEGACY, segredoSessao);

  function chaveDe(versao, contexto) {
    const material = materiais.get(versao);
    if (!material) return null;
    return derivar(material, contexto);
  }

  return {
    versaoCorrente,
    legacyAtivo: legacyAtivo && Boolean(segredoSessao),
    versoesDeLeitura: () => [...materiais.keys()].sort((a, b) => b - a),

    disponivel() {
      return materiais.has(versaoCorrente);
    },

    // Escrita: SEMPRE na versão corrente. Nunca na legacy, nunca na anterior.
    encrypt(texto, contexto = CONTEXTO_GA4) {
      const chave = chaveDe(versaoCorrente, contexto);
      if (!chave) {
        throw new SecretKeyError(
          'ENCRYPTION_MASTER_KEY não configurada — não é possível cifrar segredo de integração. ' +
          'Esta chave é independente de ADMIN_SESSION_SECRET (TD-004).'
        );
      }
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', chave, iv);
      const enc = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
      return {
        ciphertext: Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64'),
        keyVersion: versaoCorrente,
      };
    },

    // Leitura: aceita a versão gravada, se ela ainda estiver ativa. Se `keyVersion` não vier
    // (ciphertext anterior a esta fase), tenta as versões de leitura da mais nova para a mais
    // antiga — é o único caminho que decifra o que já está em produção sem uma migração de dados
    // que ainda não pode rodar.
    decrypt(ciphertextB64, { keyVersion = null, contexto = CONTEXTO_GA4 } = {}) {
      if (!ciphertextB64) return null;
      const versoes = keyVersion === null || keyVersion === undefined
        ? [...materiais.keys()].sort((a, b) => b - a)
        : [keyVersion];

      for (const versao of versoes) {
        const chave = chaveDe(versao, contexto);
        if (!chave) continue;
        try {
          const buf = Buffer.from(ciphertextB64, 'base64');
          const iv = buf.subarray(0, 12);
          const tag = buf.subarray(12, 28);
          const enc = buf.subarray(28);
          const decipher = crypto.createDecipheriv('aes-256-gcm', chave, iv);
          decipher.setAuthTag(tag);
          return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
        } catch {
          // GCM: falha de tag = chave errada. Segue para a próxima versão ativa.
        }
      }
      return null; // ilegível com qualquer versão ativa — o chamador trata como "reconecte".
    },
  };
}

// Metadata que PODE sair no log e na API. O segredo em si, nunca. Tudo que atravessa a fronteira
// de resposta passa por aqui — é mais fácil auditar uma função do que N handlers (INV-13).
function metadataDeSegredo(linha) {
  if (!linha) return null;
  return {
    tipo: linha.tipo,
    last4: linha.last4 || null,
    keyVersion: linha.key_version ?? linha.keyVersion ?? null,
    expiresAt: linha.expires_at ?? linha.expiresAt ?? null,
    rotatedAt: linha.rotated_at ?? linha.rotatedAt ?? null,
    status: statusDeSegredo(linha),
  };
}

function statusDeSegredo(linha, agora = new Date()) {
  const expira = linha.expires_at ?? linha.expiresAt ?? null;
  if (!expira) return 'active';
  return new Date(expira).getTime() <= agora.getTime() ? 'expired' : 'active';
}

// Últimos 4 caracteres, e só isso. Para segredo curto demais para ter "últimos 4" sem virar
// vazamento, devolve null em vez de devolver o segredo quase inteiro.
function last4(segredo) {
  const s = String(segredo || '');
  return s.length >= 8 ? s.slice(-4) : null;
}

module.exports = {
  VERSAO_LEGACY,
  CONTEXTO_GA4,
  CONTEXTO_META,
  CONTEXTO_GOOGLE_ADS,
  SecretKeyError,
  createKeyring,
  metadataDeSegredo,
  statusDeSegredo,
  last4,
};
