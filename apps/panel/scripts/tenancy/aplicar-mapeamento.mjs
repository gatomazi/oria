#!/usr/bin/env node
// Aplica um mapeamento de tenancy num banco JÁ migrado (instalação nova, banco de teste).
// Uso: DATABASE_URL=... node scripts/tenancy/aplicar-mapeamento.mjs caminho/do/mapeamento.json
// Em produção o caminho normal é TENANCY_MAPPING_FILE no pre-deploy; este script é para quando a
// migration já rodou sem dado e sem arquivo.
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const tm = require('../../lib/platform/tenancy-mapping.js');

export async function aplicarMapeamento(url, arquivo, { creativeTenant = process.env.CREATIVE_TENANT_ID || 'default' } = {}) {
  const mapeamento = tm.lerMapeamentoDeArquivo(path.resolve(arquivo));
  tm.verificarCompletudeRuntime(mapeamento, { creativeTenant });
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(tm.sqlAplicarMapeamento(mapeamento));
    await client.query('SELECT tenancy_exigir_cobertura()');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  return mapeamento;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [arquivo] = process.argv.slice(2);
  if (!arquivo || !process.env.DATABASE_URL) {
    console.error('uso: DATABASE_URL=... node scripts/tenancy/aplicar-mapeamento.mjs <arquivo.json>');
    process.exit(2);
  }
  aplicarMapeamento(process.env.DATABASE_URL, arquivo)
    .then((m) => console.log(`mapeamento aplicado: ${m.organizations.length} organization(s), ${m.mapeamentos.length} regra(s)`))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
