'use strict';

// Fase E · repositório de property_id (lib/connectors/analytics/ga4/property-repository.js): lê
// google_analytics_connections, nunca integrations.config, nunca segredo.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGa4PropertyRepository } = require('../lib/connectors/analytics/ga4/property-repository');

const ORG_A = 'a1000000-0000-4000-8000-00000000000a';
const STORE_A = 'a1a10000-0000-4000-8000-0000000000a1';

function poolFalso(linhas) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql, params });
      const [org, store] = params;
      return { rows: linhas.filter((l) => l.organization_id === org && l.store_id === store) };
    },
  };
}

test('E · getProperty devolve propertyId/propertyName/status da Store', async () => {
  const pool = poolFalso([{ organization_id: ORG_A, store_id: STORE_A, property_id: '123456', property_name: 'Loja A', status: 'connected' }]);
  const repo = createGa4PropertyRepository({ pool });
  assert.deepEqual(await repo.getProperty({ organizationId: ORG_A, storeId: STORE_A }), { propertyId: '123456', propertyName: 'Loja A', status: 'connected' });
});

test('E · sem linha para a Store devolve null (não inventa configuração)', async () => {
  const repo = createGa4PropertyRepository({ pool: poolFalso([]) });
  assert.equal(await repo.getProperty({ organizationId: ORG_A, storeId: STORE_A }), null);
});

test('E · linha sem property_id (conectado mas sem propriedade escolhida) devolve null', async () => {
  const pool = poolFalso([{ organization_id: ORG_A, store_id: STORE_A, property_id: null, property_name: null, status: 'connected' }]);
  const repo = createGa4PropertyRepository({ pool });
  assert.equal(await repo.getProperty({ organizationId: ORG_A, storeId: STORE_A }), null);
});

test('E · mais de uma linha para a mesma Store é erro de integridade, nunca "a primeira"', async () => {
  const pool = {
    async query() { return { rows: [{ property_id: '1' }, { property_id: '2' }] }; },
  };
  const repo = createGa4PropertyRepository({ pool });
  await assert.rejects(repo.getProperty({ organizationId: ORG_A, storeId: STORE_A }), (err) => err.codigo === 'GA4_CONNECTION_INTEGRITY_ERROR');
});

test('E · a consulta é sempre por organization_id + store_id juntos', async () => {
  const pool = poolFalso([{ organization_id: ORG_A, store_id: STORE_A, property_id: '1', property_name: null, status: 'connected' }]);
  const repo = createGa4PropertyRepository({ pool });
  await repo.getProperty({ organizationId: ORG_A, storeId: STORE_A });
  assert.match(pool.chamadas[0].sql, /organization_id = \$1 AND store_id = \$2/);
  assert.deepEqual(pool.chamadas[0].params, [ORG_A, STORE_A]);
});

test('E · getProperty exige organizationId e storeId', async () => {
  const repo = createGa4PropertyRepository({ pool: poolFalso([]) });
  await assert.rejects(repo.getProperty({ storeId: STORE_A }), TypeError);
  await assert.rejects(repo.getProperty({ organizationId: ORG_A }), TypeError);
});

test('E · createGa4PropertyRepository exige pool', () => {
  assert.throws(() => createGa4PropertyRepository({}), /exige pool/);
});
