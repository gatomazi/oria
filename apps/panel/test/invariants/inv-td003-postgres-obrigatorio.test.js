'use strict';

// TD-003 / B-09 — Postgres obrigatório em produção; degradação DECLARADA em dev.
// Critério de saída 2 da Fase 0.
//
// O que está sob teste não é "o boot falha sem banco". É algo mais específico e mais fácil de
// perder de vista: **a ausência de `DATABASE_URL` nunca é interpretada como intenção**. Nem em
// produção, nem em dev. Quem quiser rodar sem banco declara isso.
//
// Também sob teste: `verificarBootstrapCritico` recusa um banco onde as migrations não rodaram.
// Sem essa checagem, um deploy que pulou o Pre-deploy Command (OPS-11) sobe contra um schema velho
// e o sintoma é 500 esparso em runtime, não um boot que falha.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const { resolveDatabaseMode, verificarBootstrapCritico, opcoesDePool, DatabaseConfigError, MODO_POSTGRES, MODO_EFEMERO } =
  h.sujeito('lib/platform/db-config.js');

const URL = 'postgres://u:p@localhost:5432/db';

test('TD-003 · produção sem DATABASE_URL → erro de boot', () => {
  assert.throws(
    () => resolveDatabaseMode({ NODE_ENV: 'production' }),
    DatabaseConfigError
  );
});

test('TD-003 · DEV sem DATABASE_URL também falha — a ausência não declara nada', () => {
  assert.throws(() => resolveDatabaseMode({ NODE_ENV: 'development' }), DatabaseConfigError);
  assert.throws(() => resolveDatabaseMode({}), DatabaseConfigError);
  assert.throws(() => resolveDatabaseMode({ NODE_ENV: 'test' }), DatabaseConfigError);
});

test('TD-003 · o fallback efêmero existe, mas só DECLARADO e só fora de produção', () => {
  const dev = resolveDatabaseMode({ NODE_ENV: 'development', DATA_STORE_MODE: 'ephemeral-json' });
  assert.equal(dev.modo, MODO_EFEMERO);
  assert.equal(dev.databaseUrl, null);
  assert.equal(dev.declarado, true);

  assert.throws(
    () => resolveDatabaseMode({ NODE_ENV: 'production', DATA_STORE_MODE: 'ephemeral-json' }),
    DatabaseConfigError,
    'declarar o modo efêmero em produção precisa falhar — declarar não é autorizar'
  );
});

test('TD-003 · DATA_STORE_MODE desconhecido falha em vez de cair no default', () => {
  for (const modo of ['json', 'memory', 'auto', 'sim', 'POSTGRES-ISH']) {
    assert.throws(() => resolveDatabaseMode({ DATA_STORE_MODE: modo, DATABASE_URL: URL }), DatabaseConfigError);
  }
});

test('TD-003 · o caminho correto continua funcionando', () => {
  const prod = resolveDatabaseMode({ NODE_ENV: 'production', DATABASE_URL: URL });
  assert.equal(prod.modo, MODO_POSTGRES);
  assert.equal(prod.databaseUrl, URL);

  // DATABASE_URL só com espaços é ausência, não valor.
  assert.throws(() => resolveDatabaseMode({ NODE_ENV: 'production', DATABASE_URL: '   ' }), DatabaseConfigError);
});

test('TD-003 · SSL: local sem TLS, remoto com TLS', () => {
  assert.equal(opcoesDePool('postgres://u:p@localhost:5432/db').ssl, false);
  assert.equal(opcoesDePool('postgres://u:p@127.0.0.1:5432/db').ssl, false);
  assert.deepEqual(opcoesDePool('postgres://u:p@db.railway.app:5432/db').ssl, { rejectUnauthorized: false });
});

test('OPS-11 · banco sem migrations aplicadas é recusado no boot', async () => {
  const pool = h.abrirPool();
  try {
    // Banco real, com as migrations aplicadas: passa.
    await verificarBootstrapCritico(pool, { migrationEsperada: '1790000300000_onboarding' });

    // Migration inexistente: o boot precisa recusar.
    await assert.rejects(
      () => verificarBootstrapCritico(pool, { migrationEsperada: '9999999999999_migration-do-futuro' }),
      DatabaseConfigError,
      'o app não pode subir à frente do schema'
    );

    // E sem a tabela de controle, idem — simulado por um schema vazio.
    await pool.query('CREATE SCHEMA IF NOT EXISTS sem_migrations');
    const semControle = {
      query: async (sql, params) => {
        if (/to_regclass/.test(sql)) return { rows: [{ tem_tabela: false }] };
        return pool.query(sql, params);
      },
    };
    await assert.rejects(() => verificarBootstrapCritico(semControle), DatabaseConfigError);
  } finally {
    await pool.end();
  }
});

test('TD-003 · o banco de teste realmente tem o schema das migrations', async () => {
  const pool = h.abrirPool();
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`
    );
    assert.ok(rows[0].n > 40, `esperava o schema completo; encontrei ${rows[0].n} tabelas`);

    const { rows: migs } = await pool.query('SELECT name FROM pgmigrations ORDER BY id');
    assert.deepEqual(migs.map((m) => m.name), [
      '1789509600000_baseline-schema',
      '1789509660000_backfill-pedidos-json',
      '1789509720000_backfill-payment-status-portugues',
      '1789509780000_backfill-public-token-media',
      '1789509840000_integration-secrets',
      '1789509900000_creative-core-schema',
      '1789600000000_tenancy-plataforma',
      '1789600060000_tenancy-colunas',
      '1789600120000_tenancy-mapeamento',
      '1789600180000_tenancy-backfill',
      '1789600240000_tenancy-constraints',
      '1789600300000_tenancy-triggers',
      '1789600360000_tenancy-rls',
      '1789600420000_tenancy-chaves',
      '1789700000000_auth-identidade',
      '1789800000000_tenant-context',
      '1789900000000_integrations',
      '1790000000000_whatsapp-inbound',
      '1790000060000_ink-webhook-token',
      '1790000120000_job-leases',
      '1790000300000_onboarding',
      '1790000400000_platform-admin',
      '1790000500000_convite-aceite',
      '1790000600000_store-id-connector-ink',
      '1790000800000_entitlement-canonico',
      '1790000900000_composicao-do-internal',
      '1790001000000_midia-store-id',
      '1790001100000_catalogo-ink-store-id',
      '1790001200000_ga4-store-id',
      '1790001300000_oauth-state-whatsapp',
      '1790001400000_campanhas-store-id',
      '1790001500000_reparar-loja-uuid-em-pedidos',
      '1790001600000_commerce-catalog',
    ]);
  } finally {
    await pool.end();
  }
});
