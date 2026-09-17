'use strict';

// INV-02 — o `organization_id` do contexto deriva EXCLUSIVAMENTE da sessão.
// Classe crítica: auth. Também exercita INV-01 e INV-10.
//
// A violação que o negative control introduz é a mais banal possível — ler um header
// `x-organization-id` "só para facilitar o suporte". É assim que este defeito entra em qualquer
// base: não por ignorância, por conveniência local.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const {
  resolveOrganization,
  resolveOrganizationStore,
  TenantContextError,
  FONTES_CONTROLADAS_PELO_CLIENTE,
} = h.sujeito('lib/platform/tenant-context.js');

const pool = h.abrirPool();
test.after(async () => { await pool.end(); });

function requestForjada(organizationIdForjado) {
  const v = String(organizationIdForjado);
  return {
    headers: { 'x-organization-id': v, 'x-tenant-id': v, 'x-loja': v, host: 'painel.local' },
    query: { organization_id: v, organizationId: v, loja: v, tenant: v },
    body: { organization_id: v, organizationId: v, loja: v },
    params: { organizationId: v, loja: v },
    cookies: { organization_id: v, loja: v },
    get(nome) { return this.headers[String(nome).toLowerCase()]; },
  };
}

test('INV-02 · forjar tenant em header, query, body, params ou cookie NÃO muda o resultado', async () => {
  await h.prepararFixtures(pool);
  const [orgA, orgB] = await h.semearOrganizations(pool, 2);

  const sessao = { userId: 'u-1', organizationId: orgA };

  assert.equal(resolveOrganization(requestForjada(orgB), sessao), String(orgA));
  assert.equal(resolveOrganization(requestForjada('org-inexistente'), sessao), String(orgA));
  assert.equal(resolveOrganization({}, sessao), String(orgA));
  assert.equal(resolveOrganization(null, sessao), String(orgA));

  // Cada fonte isoladamente, para que a mensagem de falha aponte QUAL delas vazou.
  for (const fonte of FONTES_CONTROLADAS_PELO_CLIENTE) {
    const req = { [fonte]: { 'x-organization-id': orgB, organization_id: orgB, organizationId: orgB, loja: orgB } };
    assert.equal(
      resolveOrganization(req, sessao),
      String(orgA),
      `o tenant vazou por req.${fonte} — o cliente passou a escolher o tenant (INV-01/INV-02)`
    );
  }
});

test('INV-02 · sem sessão, ou com sessão sem organization, falha fechado', () => {
  assert.throws(() => resolveOrganization(requestForjada('org-x'), null), TenantContextError);
  assert.throws(() => resolveOrganization(requestForjada('org-x'), {}), TenantContextError);
  assert.throws(() => resolveOrganization(requestForjada('org-x'), { organizationId: '' }), TenantContextError);
  assert.throws(() => resolveOrganization(requestForjada('org-x'), { organizationId: null }), TenantContextError);
});

test('INV-10 · process.env não determina o tenant de uma request', async () => {
  await h.prepararFixtures(pool);
  const [orgA, orgB] = await h.semearOrganizations(pool, 2);
  const anterior = process.env.ORGANIZATION_ID;
  process.env.ORGANIZATION_ID = String(orgB);
  process.env.CREATIVE_TENANT_ID = String(orgB);
  try {
    assert.equal(resolveOrganization(requestForjada(orgB), { organizationId: orgA }), String(orgA));
    assert.throws(() => resolveOrganization(requestForjada(orgB), {}), TenantContextError,
      'sem sessão, o env NÃO pode virar o tenant (é o defeito F-03 do creative-core)');
  } finally {
    if (anterior === undefined) delete process.env.ORGANIZATION_ID; else process.env.ORGANIZATION_ID = anterior;
    delete process.env.CREATIVE_TENANT_ID;
  }
});

test('INV-02 · store vinda do browser é validada contra a organization autenticada', () => {
  const stores = [
    { id: 's-a', organization_id: 'org-a' },
    { id: 's-b', organization_id: 'org-b' },
  ];

  assert.equal(resolveOrganizationStore({ organizationId: 'org-a', storesDaOrganization: stores }).id, 's-a');

  assert.throws(
    () => resolveOrganizationStore({ organizationId: 'org-a', storesDaOrganization: stores, storeIdSolicitada: 's-b' }),
    TenantContextError,
    'pedir a store de outra organization precisa falhar, não ser atendido'
  );

  // Zero stores e mais de uma store da MESMA organization falham igual: "pega a primeira" é o
  // padrão proibido pela regra fail-closed.
  assert.throws(
    () => resolveOrganizationStore({ organizationId: 'org-c', storesDaOrganization: stores }),
    TenantContextError
  );
  assert.throws(
    () => resolveOrganizationStore({
      organizationId: 'org-a',
      storesDaOrganization: [{ id: 's-1', organization_id: 'org-a' }, { id: 's-2', organization_id: 'org-a' }],
    }),
    TenantContextError
  );
});
