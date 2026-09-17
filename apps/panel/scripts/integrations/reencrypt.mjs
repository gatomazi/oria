#!/usr/bin/env node
// Fase 4 · re-cifra na versão corrente todo segredo de integration_secrets gravado numa versão
// antiga (inclusive a legacy 0, derivada de ADMIN_SESSION_SECRET). Idempotente e em lotes; sai com
// erro se sobrar segredo ilegível ou em versão antiga. Nada de valor sai no log.
//
//   DATABASE_URL=... ENCRYPTION_MASTER_KEY=... [ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1 ADMIN_SESSION_SECRET=...] \
//     node scripts/integrations/reencrypt.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { createKeyring } = require('../../lib/secrets/keyring.js');
const { createSecretStore } = require('../../lib/secrets/store.js');
const { SEGREDOS } = require('../../lib/platform/integrations.js');

export async function recifrar(url, { env = process.env, lote = 100 } = {}) {
  const keyring = createKeyring(env);
  if (!keyring.disponivel()) throw new Error('ENCRYPTION_MASTER_KEY ausente');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const store = createSecretStore({ pool, keyring });
  const total = { recifrados: 0, ilegiveis: 0 };
  try {
    for (;;) {
      const r = await store.recifrarPendentes({
        limite: lote,
        contextoDe: (linha) => (SEGREDOS[linha.provider] || {})[linha.tipo],
      });
      total.recifrados += r.recifrados;
      total.ilegiveis += r.ilegiveis;
      if (r.recifrados === 0) break;
    }
    const { rows: [pendentes] } = await pool.query(
      'SELECT count(*)::int AS n FROM integration_secrets WHERE key_version <> $1', [keyring.versaoCorrente]
    );
    return { ...total, pendentes: pendentes.n, versao: keyring.versaoCorrente };
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL ausente');
    process.exit(2);
  }
  recifrar(process.env.DATABASE_URL)
    .then((r) => {
      console.log(`re-cifra: ${r.recifrados} re-cifrado(s) para a versão ${r.versao}; ${r.pendentes} ainda em versão antiga`);
      if (r.pendentes > 0) process.exit(1);
    })
    .catch((err) => { console.error(`re-cifra: ${err.message}`); process.exit(1); });
}
