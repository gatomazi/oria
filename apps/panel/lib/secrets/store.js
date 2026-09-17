'use strict';

// TD-004 — repositório de `integration_secrets`.
//
// Regra de fronteira, e é a única razão de este módulo existir em vez de os handlers falarem
// direto com a tabela: **não há função aqui que devolva ciphertext ou plaintext para quem só
// pediu "o segredo da integração X"**. Existem duas operações distintas e nomeadas:
//
//   listarMetadata()  → o que PODE ir para API, log e frontend (last4 / status / validade)
//   usarSegredo()     → o plaintext, entregue a um callback, para uso imediato contra o provedor
//
// `usarSegredo` não retorna o valor: ele o passa para a função de uso e devolve o RESULTADO dela.
// Isso torna sintaticamente difícil o modo de falha recorrente desta base — um `res.json(dados)`
// levando junto um campo que ninguém percebeu que era segredo (INV-13).

const { createKeyring, metadataDeSegredo, last4 } = require('./keyring');

class SegredoIndisponivelError extends Error {
  constructor(message, codigo = 'SECRET_UNAVAILABLE') {
    super(message);
    this.name = 'SegredoIndisponivelError';
    this.codigo = codigo;
  }
}

function createSecretStore({ pool, keyring = createKeyring() } = {}) {
  if (!pool) throw new Error('createSecretStore exige um pool de Postgres');

  async function gravar({ integrationId, organizationId = null, tipo, valor, expiresAt = null, contexto }) {
    const { ciphertext, keyVersion } = keyring.encrypt(valor, contexto);
    const { rows } = await pool.query(
      `INSERT INTO integration_secrets
         (integration_id, organization_id, tipo, ciphertext, key_version, last4, expires_at, rotated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (organization_id, integration_id, tipo) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         organization_id = EXCLUDED.organization_id,
         key_version = EXCLUDED.key_version,
         last4 = EXCLUDED.last4,
         expires_at = EXCLUDED.expires_at,
         rotated_at = now(),
         atualizado_em = now()
       RETURNING id, tipo, last4, key_version, expires_at, rotated_at`,
      [integrationId, organizationId, tipo, ciphertext, keyVersion, last4(valor), expiresAt]
    );
    return metadataDeSegredo(rows[0]);
  }

  // Só metadata. É o que vai para resposta HTTP e log.
  async function listarMetadata(integrationId) {
    const { rows } = await pool.query(
      `SELECT tipo, last4, key_version, expires_at, rotated_at
         FROM integration_secrets WHERE integration_id = $1 ORDER BY tipo`,
      [integrationId]
    );
    return rows.map(metadataDeSegredo);
  }

  // Plaintext, entregue a um callback e nunca retornado. Ver comentário do topo.
  // Com `organizationId`, a leitura também filtra pela Organization (além da RLS por baixo).
  // Segredo vencido é recusado, salvo `aceitarVencido` (quem sabe renovar, como o access token do
  // Google, decide o que fazer com ele).
  async function usarSegredo({ integrationId, organizationId = null, tipo, contexto, aceitarVencido = false }, usar) {
    if (typeof usar !== 'function') {
      throw new TypeError('usarSegredo exige um callback: o plaintext nunca é retornado');
    }
    const { rows } = await pool.query(
      `SELECT ciphertext, key_version, expires_at FROM integration_secrets
        WHERE integration_id = $1 AND tipo = $2 AND ($3::uuid IS NULL OR organization_id = $3)`,
      [integrationId, tipo, organizationId]
    );
    if (!rows.length) {
      throw new SegredoIndisponivelError(`segredo "${tipo}" não cadastrado para esta integração`, 'SECRET_MISSING');
    }
    if (!aceitarVencido && rows[0].expires_at && new Date(rows[0].expires_at).getTime() <= Date.now()) {
      throw new SegredoIndisponivelError(`segredo "${tipo}" vencido — reconecte esta integração`, 'SECRET_EXPIRED');
    }
    const plaintext = keyring.decrypt(rows[0].ciphertext, {
      keyVersion: rows[0].key_version,
      contexto,
    });
    if (plaintext === null) {
      // Ilegível com toda versão ativa. Fail-closed: erro, nunca "tenta sem credencial".
      throw new SegredoIndisponivelError(
        'segredo ilegível com as chaves ativas — reconecte esta integração', 'SECRET_UNREADABLE'
      );
    }
    return usar(plaintext, { expiresAt: rows[0].expires_at || null });
  }

  // Apaga os segredos de uma integração (desconexão). Devolve quantos saíram.
  async function apagar({ integrationId, organizationId = null, tipo = null }) {
    const { rowCount } = await pool.query(
      `DELETE FROM integration_secrets
        WHERE integration_id = $1 AND ($2::uuid IS NULL OR organization_id = $2)
          AND ($3::text IS NULL OR tipo = $3)`,
      [integrationId, organizationId, tipo]
    );
    return rowCount;
  }

  // Rotação incremental: re-cifra na versão corrente tudo que ainda está numa versão antiga.
  // Sem downtime porque a leitura já aceita as duas, e o lote é pequeno de propósito.
  // `contextoDe(linha)` escolhe o contexto por (provider, tipo) — o mesmo tipo tem contextos
  // diferentes em providers diferentes. `contextoPorTipo` continua aceito para um provider só.
  async function recifrarPendentes({ contextoPorTipo = {}, contextoDe = null, limite = 100 } = {}) {
    const { rows } = await pool.query(
      `SELECT s.id, s.tipo, s.ciphertext, s.key_version, i.provider
         FROM integration_secrets s
         JOIN integrations i ON i.id = s.integration_id AND i.organization_id IS NOT DISTINCT FROM s.organization_id
        WHERE s.key_version <> $1 ORDER BY s.id LIMIT $2`,
      [keyring.versaoCorrente, limite]
    );
    const resultado = { recifrados: 0, ilegiveis: 0 };
    for (const linha of rows) {
      const contexto = contextoDe ? contextoDe(linha) : contextoPorTipo[linha.tipo];
      const plaintext = keyring.decrypt(linha.ciphertext, {
        keyVersion: linha.key_version,
        contexto,
      });
      if (plaintext === null) { resultado.ilegiveis += 1; continue; }
      const { ciphertext, keyVersion } = keyring.encrypt(plaintext, contexto);
      await pool.query(
        `UPDATE integration_secrets
            SET ciphertext = $1, key_version = $2, rotated_at = now(), atualizado_em = now()
          WHERE id = $3`,
        [ciphertext, keyVersion, linha.id]
      );
      resultado.recifrados += 1;
    }
    return resultado;
  }

  return { gravar, listarMetadata, usarSegredo, apagar, recifrarPendentes, keyring };
}

module.exports = { createSecretStore, SegredoIndisponivelError };
