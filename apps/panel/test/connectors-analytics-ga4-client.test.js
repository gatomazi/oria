'use strict';

// Fase E · cliente GA4 (lib/connectors/analytics/ga4/client.js): endpoints certos, Authorization
// header, sem token na URL, erro classificado por lib/google/http.js (401/403/429/5xx), timeout/rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGa4Client, GA_DATA_API } = require('../lib/connectors/analytics/ga4/client');

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const obterTokenDe = (token) => (usar) => usar(token);

function fetchFalso(respostas) {
  const chamadas = [];
  const fila = [...respostas];
  return {
    chamadas,
    fetchImpl: async (url, init) => {
      chamadas.push({ url, init });
      const proxima = fila.shift();
      if (!proxima) throw new Error('fetch falso sem resposta programada');
      return typeof proxima === 'function' ? proxima(url, init) : proxima;
    },
  };
}

test('E · getMetadata faz GET em properties/{id}/metadata com Bearer, sem token na URL', async () => {
  const { fetchImpl, chamadas } = fetchFalso([jsonRes(200, { dimensions: [], metrics: [] })]);
  const cliente = createGa4Client({ obterToken: obterTokenDe('tok-secreto'), fetchImpl });
  await cliente.getMetadata('123456');
  assert.equal(chamadas[0].url, `${GA_DATA_API}/properties/123456/metadata`);
  assert.equal(chamadas[0].init.method, 'GET');
  assert.equal(chamadas[0].init.headers.Authorization, 'Bearer tok-secreto');
  assert.equal(chamadas[0].url.includes('tok-secreto'), false);
});

test('E · checkCompatibility faz POST em properties/{id}:checkCompatibility com dimensions/metrics no formato certo', async () => {
  const { fetchImpl, chamadas } = fetchFalso([jsonRes(200, { dimensionCompatibilities: [], metricCompatibilities: [] })]);
  const cliente = createGa4Client({ obterToken: obterTokenDe('t'), fetchImpl });
  await cliente.checkCompatibility('123456', { dimensions: ['itemId'], metrics: ['itemsViewed', 'itemRevenue'] });
  assert.equal(chamadas[0].url, `${GA_DATA_API}/properties/123456:checkCompatibility`);
  assert.equal(chamadas[0].init.method, 'POST');
  const body = JSON.parse(chamadas[0].init.body);
  assert.deepEqual(body.dimensions, [{ name: 'itemId' }]);
  assert.deepEqual(body.metrics, [{ name: 'itemsViewed' }, { name: 'itemRevenue' }]);
});

test('E · runReport faz POST em properties/{id}:runReport com o body exato recebido', async () => {
  const { fetchImpl, chamadas } = fetchFalso([jsonRes(200, { rows: [] })]);
  const cliente = createGa4Client({ obterToken: obterTokenDe('t'), fetchImpl });
  const corpo = { dateRanges: [{ startDate: '2026-09-01', endDate: '2026-09-20' }], dimensions: [{ name: 'itemId' }], metrics: [{ name: 'itemsViewed' }], limit: 100, offset: 0 };
  await cliente.runReport('123456', corpo);
  assert.equal(chamadas[0].url, `${GA_DATA_API}/properties/123456:runReport`);
  assert.deepEqual(JSON.parse(chamadas[0].init.body), corpo);
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`E · erro ${status} vem classificado (lib/google/http.js), nunca o corpo bruto do Google`, async () => {
    const { fetchImpl } = fetchFalso(Array(3).fill(jsonRes(status, { error: { message: 'raw google error', status: 'X' } })));
    const cliente = createGa4Client({ obterToken: obterTokenDe('t'), fetchImpl });
    await assert.rejects(cliente.getMetadata('1'), (err) => {
      assert.equal(err.upstreamStatus, status);
      assert.ok(err.codigo);
      assert.equal(err.message.includes('raw google error'), false);
      return true;
    });
  });
}

test('E · erro de rede/timeout propaga (não engole)', async () => {
  const cliente = createGa4Client({
    obterToken: obterTokenDe('t'),
    fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
  });
  await assert.rejects(cliente.getMetadata('1'), /timeout/);
});

test('E · o token nunca aparece na URL nem no corpo de nenhuma das 3 chamadas', async () => {
  const { fetchImpl, chamadas } = fetchFalso([jsonRes(200, {}), jsonRes(200, {}), jsonRes(200, {})]);
  const cliente = createGa4Client({ obterToken: obterTokenDe('super-secreto-xyz'), fetchImpl });
  await cliente.getMetadata('1');
  await cliente.checkCompatibility('1', { dimensions: ['itemId'], metrics: ['itemsViewed'] });
  await cliente.runReport('1', { dateRanges: [] });
  for (const c of chamadas) {
    assert.equal(c.url.includes('super-secreto-xyz'), false);
    assert.equal((c.init.body || '').includes('super-secreto-xyz'), false);
  }
});

test('E · createGa4Client exige obterToken', () => {
  assert.throws(() => createGa4Client({}), /obterToken/);
});
