'use strict';

// Fase B.1 · porta IntegrationResolver sobre `integrations` (lib/platform/connector-integration-port.js),
// com pool falso: só o contrato de consulta, sem banco. O comportamento contra Postgres de verdade
// (duas Organizations, RLS e superusuário) está em test/invariants/connector-integration-port.test.js.
//
// Premissa: 1 Organization = 1 Store (ORIA-TENANCY-STORE-01). Nenhum cenário aqui tem duas Stores na
// mesma Organization.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createConnectorIntegrationPort, semChavesSensiveis } = require('../lib/platform/connector-integration-port');
const { comContexto } = require('../lib/platform/tenant-runtime');
const { createConnectorRegistry } = require('../lib/connectors/registry');
const { ConnectorError, CODIGOS } = require('../lib/connectors/errors');
const F = require('./helpers/connector-fakes');

const consulta = (extra = {}, context = { organizationId: F.ORG_A, storeId: F.STORE_A }) => ({
  domain: 'commerce', provider: 'reserva_ink', integrationProvider: 'ink', requiresStoreContext: true, context, ...extra,
});

// Pool falso: responde `stores` e `integrations` a partir de tabelas em memória e registra o SQL.
function poolFalso({ lojas = [{ id: F.STORE_A, organization_id: F.ORG_A }], integracoes = [] } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql, params });
      if (/FROM stores/.test(sql)) return { rows: lojas.filter((l) => l.id === params[0] && l.organization_id === params[1]).map((l) => ({ id: l.id })) };
      if (/FROM integrations/.test(sql)) {
        const [org, provider, id] = params;
        return { rows: integracoes.filter((i) => i.organization_id === org && i.provider === provider && (id === undefined || String(i.id) === id) && i.escopo === null) };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
}
const linhaInk = (extra = {}) => ({ id: '101', organization_id: F.ORG_A, provider: 'ink', escopo: null, status: 'connected', config: {}, ...extra });

const emA = (fn) => comContexto({ organizationId: F.ORG_A, storeId: F.STORE_A, origem: 'teste' }, fn);
const rejeita = (promessa, codigo) => assert.rejects(promessa, (err) => err.codigo === codigo, `esperava ${codigo}`);

// ── Consulta ────────────────────────────────────────────────────────────────────────────────────

test('B.1 · resolve por Organization + provider e devolve identidade, Store validada, status e config', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk({ config: { region: 'br' } })] });
  const r = await createConnectorIntegrationPort({ pool }).resolve(consulta());
  assert.deepEqual(r, {
    integrationId: '101', organizationId: F.ORG_A, storeId: F.STORE_A, integrationProvider: 'ink', status: 'connected', config: { region: 'br' },
  });
  const sqlIntegracao = pool.chamadas.find((c) => /FROM integrations/.test(c.sql));
  assert.deepEqual(sqlIntegracao.params, [F.ORG_A, 'ink']);
  assert.match(sqlIntegracao.sql, /organization_id = \$1 AND provider = \$2 AND escopo IS NULL/);
}));

test('B.1 · nenhuma busca é só por integrationId, nem só por provider: a Organization entra em todas', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk()] });
  const porta = createConnectorIntegrationPort({ pool });
  await porta.resolve(consulta());
  await porta.resolve(consulta({}, { organizationId: F.ORG_A, storeId: F.STORE_A, integrationId: '101' }));
  const buscas = pool.chamadas.filter((c) => /FROM integrations/.test(c.sql));
  assert.equal(buscas.length, 2);
  for (const b of buscas) {
    assert.match(b.sql, /organization_id = \$1/);
    assert.match(b.sql, /provider = \$2/);
    assert.equal(b.params[0], F.ORG_A);
  }
  assert.match(buscas[1].sql, /AND id = \$3/);
  assert.deepEqual(buscas[1].params, [F.ORG_A, 'ink', '101']);
}));

test('B.1 · a porta nunca toca integration_secrets e não devolve nenhum campo além do contrato', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk({ api_token: 'segredo', refresh_token: 'segredo2' })] });
  const r = await createConnectorIntegrationPort({ pool }).resolve(consulta());
  assert.deepEqual(Object.keys(r).sort(), ['config', 'integrationId', 'integrationProvider', 'organizationId', 'status', 'storeId']);
  assert.equal(pool.chamadas.some((c) => /integration_secrets/i.test(c.sql)), false);
  assert.doesNotMatch(JSON.stringify(r), /segredo/);
}));

test('B.1 · a porta não usa SQL de segredo nem ambiente (guarda estática do arquivo)', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'platform', 'connector-integration-port.js'), 'utf8')
    .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(fonte, /integration_secrets|usarSegredo|process\.env|secret-guard|keyring/);
});

// ── Organization e Store ────────────────────────────────────────────────────────────────────────

test('B.1 · a Organization da consulta tem de ser a do contexto do processo', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk({ organization_id: F.ORG_B })] });
  await rejeita(
    createConnectorIntegrationPort({ pool }).resolve(consulta({}, { organizationId: F.ORG_B, storeId: F.STORE_B })),
    CODIGOS.INTEGRATION_TENANT_MISMATCH,
  );
  assert.equal(pool.chamadas.length, 0, 'não chegou a consultar o banco');
}));

test('B.1 · sem contexto de Organization no processo, a porta falha fechada', async () => {
  const pool = poolFalso({ integracoes: [linhaInk()] });
  await rejeita(createConnectorIntegrationPort({ pool }).resolve(consulta()), 'TENANT_CONTEXT_REQUIRED');
  assert.equal(pool.chamadas.length, 0);
});

test('B.1 · a Store pertence à Organization: passa; a Store de outra Organization é rejeitada', () => emA(async () => {
  const pool = poolFalso({
    lojas: [{ id: F.STORE_A, organization_id: F.ORG_A }, { id: F.STORE_B, organization_id: F.ORG_B }],
    integracoes: [linhaInk()],
  });
  const porta = createConnectorIntegrationPort({ pool });
  assert.equal((await porta.resolve(consulta())).storeId, F.STORE_A);
  await rejeita(porta.resolve(consulta({}, { organizationId: F.ORG_A, storeId: F.STORE_B })), CODIGOS.INTEGRATION_TENANT_MISMATCH);
  const conferencia = pool.chamadas.find((c) => /FROM stores/.test(c.sql));
  assert.match(conferencia.sql, /id = \$1 AND organization_id = \$2/);
}));

test('B.1 · Store inexistente é rejeitada como a de outro tenant (sem revelar qual)', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk()] });
  await rejeita(
    createConnectorIntegrationPort({ pool }).resolve(consulta({}, { organizationId: F.ORG_A, storeId: 'c9000000-0000-4000-8000-000000000009' })),
    CODIGOS.INTEGRATION_TENANT_MISMATCH,
  );
}));

test('B.1 · requiresStoreContext=true sem Store no contexto é erro; =false aceita e não consulta stores', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk({ provider: 'meta' })] });
  const porta = createConnectorIntegrationPort({ pool });
  await rejeita(porta.resolve(consulta({}, { organizationId: F.ORG_A })), CODIGOS.CONTEXT_INVALID);
  const r = await porta.resolve(consulta({ integrationProvider: 'meta', requiresStoreContext: false }, { organizationId: F.ORG_A }));
  assert.equal(r.storeId, null);
  assert.equal(pool.chamadas.some((c) => /FROM stores/.test(c.sql)), false);
}));

test('B.1 · Store enviada com requiresStoreContext=false continua sendo validada', () => emA(async () => {
  const pool = poolFalso({ lojas: [{ id: F.STORE_B, organization_id: F.ORG_B }], integracoes: [linhaInk({ provider: 'meta' })] });
  await rejeita(
    createConnectorIntegrationPort({ pool }).resolve(consulta({ integrationProvider: 'meta', requiresStoreContext: false }, { organizationId: F.ORG_A, storeId: F.STORE_B })),
    CODIGOS.INTEGRATION_TENANT_MISMATCH,
  );
}));

// ── Existência, id e status ─────────────────────────────────────────────────────────────────────

test('B.1 · integração inexistente → INTEGRATION_NOT_CONNECTED', () => emA(async () => {
  await rejeita(createConnectorIntegrationPort({ pool: poolFalso() }).resolve(consulta()), 'INTEGRATION_NOT_CONNECTED');
}));

test('B.1 · integração disconnected (placeholder do resolver legado) → INTEGRATION_NOT_CONNECTED', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk({ status: 'disconnected' })] });
  await rejeita(createConnectorIntegrationPort({ pool }).resolve(consulta()), 'INTEGRATION_NOT_CONNECTED');
}));

test('B.1 · os demais status voltam como vieram: a política operacional é do connector/service', () => emA(async () => {
  for (const status of ['connected', 'pending', 'degraded', 'error', 'connected_with_data']) {
    const pool = poolFalso({ integracoes: [linhaInk({ status })] });
    assert.equal((await createConnectorIntegrationPort({ pool }).resolve(consulta())).status, status);
  }
}));

test('B.1 · integrationId de outra Organization, de outro provider ou inexistente → INTEGRATION_NOT_CONNECTED', () => emA(async () => {
  const pool = poolFalso({
    integracoes: [linhaInk(), linhaInk({ id: '111', organization_id: F.ORG_B }), linhaInk({ id: '201', provider: 'ga4' })],
  });
  const porta = createConnectorIntegrationPort({ pool });
  for (const integrationId of ['111', '201', '999']) {
    await rejeita(porta.resolve(consulta({}, { organizationId: F.ORG_A, storeId: F.STORE_A, integrationId })), 'INTEGRATION_NOT_CONNECTED');
  }
  assert.equal((await porta.resolve(consulta({}, { organizationId: F.ORG_A, storeId: F.STORE_A, integrationId: '101' }))).integrationId, '101');
}));

test('B.1 · id que não cabe em integrations.id não vira erro de cast: não chega ao banco', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk()] });
  const porta = createConnectorIntegrationPort({ pool });
  for (const integrationId of ['int_A-1', 'c1000000-0000-4000-8000-0000000000a1', '9'.repeat(30)]) {
    await rejeita(porta.resolve(consulta({}, { organizationId: F.ORG_A, storeId: F.STORE_A, integrationId })), 'INTEGRATION_NOT_CONNECTED');
  }
  assert.equal(pool.chamadas.some((c) => /FROM integrations/.test(c.sql)), false);
}));

test('B.1 · integração da linha com escopo legado não é candidata (só escopo NULO)', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk({ escopo: 'sul' })] });
  await rejeita(createConnectorIntegrationPort({ pool }).resolve(consulta()), 'INTEGRATION_NOT_CONNECTED');
}));

test('B.1 · mais de uma linha para a mesma Organization e provider é erro de integridade, nunca "a primeira"', () => emA(async () => {
  const pool = { async query(sql) { return /FROM stores/.test(sql) ? { rows: [{ id: F.STORE_A }] } : { rows: [linhaInk(), linhaInk({ id: '102' })] }; } };
  await rejeita(createConnectorIntegrationPort({ pool }).resolve(consulta()), 'INTEGRATION_INTEGRITY_ERROR');
}));

test('B.1 · consulta malformada: provider desconhecido, requiresStoreContext ausente e contexto inválido', () => emA(async () => {
  const porta = createConnectorIntegrationPort({ pool: poolFalso({ integracoes: [linhaInk()] }) });
  await rejeita(porta.resolve(consulta({ integrationProvider: 'shopify' })), CODIGOS.INTEGRATION_INVALID);
  await rejeita(porta.resolve(consulta({ integrationProvider: '__proto__' })), CODIGOS.INTEGRATION_INVALID);
  await rejeita(porta.resolve(consulta({ requiresStoreContext: undefined })), CODIGOS.INTEGRATION_INVALID);
  await rejeita(porta.resolve(consulta({}, { organizationId: F.ORG_A, storeId: 'sul' })), CODIGOS.CONTEXT_INVALID);
  await rejeita(porta.resolve(consulta({}, { organizationId: F.ORG_A, storeId: F.STORE_A, token: 'x' })), CODIGOS.CONTEXT_INVALID);
  await rejeita(porta.resolve(null), CODIGOS.INTEGRATION_INVALID);
  assert.throws(() => createConnectorIntegrationPort({ pool: null }), /exige pool/);
}));

// ── config ──────────────────────────────────────────────────────────────────────────────────────

test('B.1 · config sai sem chave com cara de credencial (webhook_token_sha256 do Ink, tokens, segredos)', () => {
  const config = {
    region: 'br',
    webhook_token_sha256: 'a'.repeat(64),
    webhook_token_criado_em: '2026-09-01',
    accessToken: 'x',
    api_key: 'x',
    nested: { ok: 1, client_secret: 'x', lista: [{ refresh_token: 'x', nome: 'n' }] },
    Password: 'x',
    signature: 'x',
  };
  assert.deepEqual(semChavesSensiveis(config), { region: 'br', nested: { ok: 1, lista: [{ nome: 'n' }] } });
});

test('B.1 · a porta aplica o filtro de config ao resultado', () => emA(async () => {
  const pool = poolFalso({ integracoes: [linhaInk({ config: { region: 'br', webhook_token_sha256: 'h', segredo_api_key: 'k' } })] });
  const r = await createConnectorIntegrationPort({ pool }).resolve(consulta());
  assert.deepEqual(r.config, { region: 'br' });
}));

// ── Ligada ao registry ──────────────────────────────────────────────────────────────────────────

test('B.1 · ligada ao registry: os quatro connectors resolvem por essa porta, e Meta Ads/Events dividem a integração', () => emA(async () => {
  const pool = poolFalso({
    lojas: [{ id: F.STORE_A, organization_id: F.ORG_A }],
    integracoes: [linhaInk(), linhaInk({ id: '201', provider: 'ga4' }), linhaInk({ id: '301', provider: 'meta' })],
  });
  const registry = createConnectorRegistry({ integrations: createConnectorIntegrationPort({ pool }) });
  for (const d of [F.descritorReservaInk(), F.descritorGa4(), F.descritorMetaAds(), F.descritorMetaEvents()]) registry.register(d);
  const ctx = { organizationId: F.ORG_A, storeId: F.STORE_A };

  const ink = await registry.resolve('commerce', 'reserva_ink', ctx).connector.integracaoEmUso();
  const ga4 = await registry.resolve('analytics', 'ga4', ctx).connector.integracaoEmUso();
  const ads = await registry.resolve('ads', 'meta', ctx).connector.integracaoEmUso();
  const eventos = await registry.resolve('event_analytics', 'meta', ctx).connector.integracaoEmUso();
  assert.deepEqual([ink.integrationId, ga4.integrationId, ads.integrationId, eventos.integrationId], ['101', '201', '301', '301']);
  assert.notEqual(registry.resolve('ads', 'meta', ctx).connector, registry.resolve('event_analytics', 'meta', ctx).connector);
}));

test('B.1 · ligada ao registry: o erro da porta sobe com o código, e nada vaza segredo', () => emA(async () => {
  const registry = createConnectorRegistry({ integrations: createConnectorIntegrationPort({ pool: poolFalso() }) });
  registry.register(F.descritorReservaInk());
  const r = registry.resolve('commerce', 'reserva_ink', { organizationId: F.ORG_A, storeId: F.STORE_A });
  await assert.rejects(r.connector.integracaoEmUso(), (err) => err.codigo === 'INTEGRATION_NOT_CONNECTED' && !(err instanceof ConnectorError));
}));
