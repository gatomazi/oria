'use strict';

// Fase B.1 · porta IntegrationResolver contra Postgres real: Organization A + Store A + Integration A,
// Organization B + Store B + Integration B, sob a role da APLICAÇÃO (RLS forçada) e sob o
// superusuário (prova que o isolamento não depende só da RLS — a porta filtra por organization_id em
// toda query, mesmo quando a role consegue ver tudo).
//
// Premissa (ORIA-TENANCY-STORE-01): 1 Organization = 1 Store. Nenhum cenário aqui tem duas Stores na
// mesma Organization.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createConnectorIntegrationPort } = h.sujeito('lib/platform/connector-integration-port.js');
const { CODIGOS } = h.sujeito('lib/connectors/errors.js');

const ORG_A = 'd1000000-0000-4000-8000-000000000001';
const ORG_B = 'd1000000-0000-4000-8000-000000000002';
const STORE_A = 'd2000000-0000-4000-8000-000000000001';
const STORE_B = 'd2000000-0000-4000-8000-000000000002';
const ROLE = `oria_app_conn_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');

let db;
let sup;
let appPool;

const consulta = (context, extra = {}) => ({
  domain: 'commerce', provider: 'reserva_ink', integrationProvider: 'ink', requiresStoreContext: true, context, ...extra,
});
const em = (org, storeId, fn) => runtime.comContexto({ organizationId: org, storeId, origem: 'teste' }, fn);
const rejeita = (promessa, codigo) => assert.rejects(promessa, (err) => err.codigo === codigo, `esperava ${codigo}`);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_conn_port');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPool = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 4 });

  for (const [org, store, nome] of [[ORG_A, STORE_A, 'Org A'], [ORG_B, STORE_B, 'Org B']]) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, nome]);
    await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [store, org, nome]);
    await sup.query(
      "INSERT INTO integrations (organization_id, provider, escopo, status, config) VALUES ($1, 'ink', NULL, 'connected', $2::jsonb)",
      [org, JSON.stringify({ region: nome, webhook_token_sha256: 'a'.repeat(64) })]
    );
  }
  // Uma integração disconnected e uma com escopo legado, só na Organization A, para provar que não
  // viram candidatas.
  await sup.query("INSERT INTO integrations (organization_id, provider, escopo, status) VALUES ($1, 'ga4', NULL, 'disconnected')", [ORG_A]);
  await sup.query("INSERT INTO integrations (organization_id, provider, escopo, status) VALUES ($1, 'meta', 'sul', 'connected')", [ORG_A]);
});

test.after(async () => {
  await appPool?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

for (const [nome, pool] of [['role da aplicação', () => appPool], ['sem RLS (superusuário)', () => sup]]) {
  test(`B.1 · Organization A + Store A + Integration A, Organization B + Store B + Integration B, sem cruzamento (${nome})`, async () => {
    const fachada = runtime.criarPoolTenant(pool());
    const porta = createConnectorIntegrationPort({ pool: fachada });

    const daA = await em(ORG_A, STORE_A, () => porta.resolve(consulta({ organizationId: ORG_A, storeId: STORE_A, integrationId: null })));
    const daB = await em(ORG_B, STORE_B, () => porta.resolve(consulta({ organizationId: ORG_B, storeId: STORE_B, integrationId: null })));
    assert.equal(daA.organizationId, ORG_A);
    assert.equal(daA.storeId, STORE_A);
    assert.equal(daB.organizationId, ORG_B);
    assert.equal(daB.storeId, STORE_B);
    assert.notEqual(daA.integrationId, daB.integrationId);
    assert.deepEqual(daA.config, { region: 'Org A' });
    assert.doesNotMatch(JSON.stringify(daA), /sha256|token/i);

    // A Store de B não é aceita no contexto de A — nem pela role da aplicação, nem sem RLS.
    await em(ORG_A, STORE_A, () => rejeita(
      porta.resolve(consulta({ organizationId: ORG_A, storeId: STORE_B, integrationId: null })),
      CODIGOS.INTEGRATION_TENANT_MISMATCH,
    ));

    // A integração de B não é achada por um integrationId "emprestado" dentro do contexto de A.
    await em(ORG_A, STORE_A, () => rejeita(
      porta.resolve(consulta({ organizationId: ORG_A, storeId: STORE_A, integrationId: daB.integrationId })),
      'INTEGRATION_NOT_CONNECTED',
    ));
  });
}

test('B.1 · disconnected e escopo legado não são candidatos, mesmo existindo na mesma Organization', () => em(ORG_A, STORE_A, async () => {
  const porta = createConnectorIntegrationPort({ pool: runtime.criarPoolTenant(appPool) });
  await rejeita(
    porta.resolve(consulta({ organizationId: ORG_A, storeId: STORE_A, integrationId: null }, { integrationProvider: 'ga4' })),
    'INTEGRATION_NOT_CONNECTED',
  );
  await rejeita(
    porta.resolve(consulta({ organizationId: ORG_A, storeId: STORE_A, integrationId: null }, { integrationProvider: 'meta', requiresStoreContext: false })),
    'INTEGRATION_NOT_CONNECTED',
  );
}));

test('B.1 · fora de qualquer contexto de Organization, a porta falha fechada mesmo sem RLS', async () => {
  const porta = createConnectorIntegrationPort({ pool: runtime.criarPoolTenant(sup) });
  await runtime.semContexto(() => rejeita(
    porta.resolve(consulta({ organizationId: ORG_A, storeId: STORE_A, integrationId: null })),
    'TENANT_CONTEXT_REQUIRED',
  ));
});
