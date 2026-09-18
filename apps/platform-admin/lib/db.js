'use strict';

// Acesso ao Postgres do control plane.
//
// ── Cópia declarada ──────────────────────────────────────────────────────────────────────────
// `comOrganization` é uma cópia de `apps/panel/lib/platform/tenant-db.js` (mesma semântica, mesmo
// nome de setting). NÃO é um require: o Railway builda só `/apps/platform-admin`, e `apps/panel`
// não existe na imagem deste service. A cópia é o preço declarado dessa separação; se o mecanismo
// mudar lá, muda aqui — e o teste `tenant-context` reprova se os dois divergirem no que importa
// (o nome do setting e o `is_local`).
//
// Regra de uso, sem exceção: TODA query que toca tabela tenant-owned roda dentro de
// `comOrganization`, com a Organization vinda do :organizationId da ROTA. Tabela de plataforma
// (platform_*, plans, subscriptions, overrides, convites) roda direto — ela não é de ninguém.

const { Pool } = require('pg');

const CONFIG_ORGANIZATION = 'app.current_organization_id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A migration que este app exige. Boot sem ela é banco errado ou pre-deploy que não rodou.
const MIGRATION_MINIMA = '1790000400000_platform-admin';

class DbContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DbContextError';
  }
}

function criarPool(databaseUrl, extra = {}) {
  return new Pool({ connectionString: databaseUrl, max: 10, ...extra });
}

// Roda `fn(client)` numa transação com a Organization no contexto. O `true` do set_config é o
// `is_local`: morre no COMMIT/ROLLBACK, então a conexão volta limpa ao pool.
async function comOrganization(pool, organizationId, fn) {
  if (typeof organizationId !== 'string' || !UUID_RE.test(organizationId)) {
    throw new DbContextError('organizationId ausente ou inválido — nenhuma query roda sem tenant');
  }
  if (typeof fn !== 'function') throw new TypeError('comOrganization exige um callback');

  const client = await pool.connect();
  let descartar = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [CONFIG_ORGANIZATION, organizationId]);
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { descartar = true; });
    throw err;
  } finally {
    client.release(descartar);
  }
}

// Transação SEM contexto de Organization: só para tabelas de plataforma (e para as funções
// SECURITY DEFINER, que não dependem de contexto).
async function emTransacao(pool, fn) {
  const client = await pool.connect();
  let descartar = false;
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { descartar = true; });
    throw err;
  } finally {
    client.release(descartar);
  }
}

// Boot: o banco responde E as migrações que este app exige já rodaram. Schema é responsabilidade
// da migration (pre-deploy), nunca do boot — aqui só se VERIFICA.
async function verificarBanco(pool, { migrationEsperada = MIGRATION_MINIMA } = {}) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pgmigrations' AND relkind = 'r') AS tem_tabela`
  );
  if (!rows[0].tem_tabela) {
    throw new DbContextError('banco sem `pgmigrations`: as migrations do painel não rodaram neste banco');
  }
  const { rows: m } = await pool.query('SELECT 1 FROM pgmigrations WHERE name = $1', [migrationEsperada]);
  if (!m.length) {
    throw new DbContextError(`migration ${migrationEsperada} não aplicada — rode as migrations do painel antes de subir o Oria Admin`);
  }
  return true;
}

module.exports = {
  CONFIG_ORGANIZATION,
  MIGRATION_MINIMA,
  UUID_RE,
  DbContextError,
  criarPool,
  comOrganization,
  emTransacao,
  verificarBanco,
};
