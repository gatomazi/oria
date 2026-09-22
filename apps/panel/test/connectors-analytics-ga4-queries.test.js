'use strict';

// Fase E · builders de query GA4 (lib/connectors/analytics/ga4/queries.js): forma exata do request
// body de runReport/checkCompatibility — puro, sem rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DIMENSION_ITEM_ID, DIMENSION_ITEM_NAME, METRICAS_PRODUTO,
  reportRequestBody, compatibilidadeRequestBody,
} = require('../lib/connectors/analytics/ga4/queries');

test('E · METRICAS_PRODUTO são os 5 nomes confirmados, sem renomear semântica de itens/unidades', () => {
  assert.deepEqual(METRICAS_PRODUTO, ['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue']);
});

test('E · reportRequestBody: dateRanges ISO puro, sem período relativo (7daysAgo) vazando do domain', () => {
  const body = reportRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20', metricas: METRICAS_PRODUTO });
  assert.deepEqual(body.dateRanges, [{ startDate: '2026-09-01', endDate: '2026-09-20' }]);
  assert.doesNotMatch(JSON.stringify(body), /daysAgo|today|yesterday/);
});

test('E · reportRequestBody: dimensão itemId sempre presente; itemName opcional', () => {
  const comNome = reportRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20', metricas: METRICAS_PRODUTO });
  assert.deepEqual(comNome.dimensions, [{ name: DIMENSION_ITEM_ID }, { name: DIMENSION_ITEM_NAME }]);
  const semNome = reportRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20', metricas: METRICAS_PRODUTO, comItemName: false });
  assert.deepEqual(semNome.dimensions, [{ name: DIMENSION_ITEM_ID }]);
});

test('E · reportRequestBody: só pede as métricas compatíveis informadas (nunca as 5 fixas)', () => {
  const body = reportRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20', metricas: ['itemsViewed', 'itemRevenue'] });
  assert.deepEqual(body.metrics, [{ name: 'itemsViewed' }, { name: 'itemRevenue' }]);
});

test('E · reportRequestBody exige ao menos 1 métrica compatível — nunca uma query vazia', () => {
  assert.throws(() => reportRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20', metricas: [] }), TypeError);
  assert.throws(() => reportRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20' }), TypeError);
});

test('E · reportRequestBody exige startDate/endDate', () => {
  assert.throws(() => reportRequestBody({ endDate: '2026-09-20', metricas: METRICAS_PRODUTO }), TypeError);
  assert.throws(() => reportRequestBody({ startDate: '2026-09-01', metricas: METRICAS_PRODUTO }), TypeError);
});

test('E · reportRequestBody: limit/offset controlam a paginação; returnPropertyQuota sempre true (diagnóstico, não requisito)', () => {
  const body = reportRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20', metricas: METRICAS_PRODUTO, limit: 500, offset: 1000 });
  assert.equal(body.limit, 500);
  assert.equal(body.offset, 1000);
  assert.equal(body.returnPropertyQuota, true);
});

test('E · reportRequestBody: offset default 0, limit default grande e seguro (bem abaixo do teto documentado de 250000)', () => {
  const body = reportRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20', metricas: METRICAS_PRODUTO });
  assert.equal(body.offset, 0);
  assert.ok(body.limit > 0 && body.limit < 250000);
});

test('E · compatibilidadeRequestBody: por padrão pede itemId+itemName+as 5 métricas', () => {
  const body = compatibilidadeRequestBody();
  assert.deepEqual(body.dimensions, [DIMENSION_ITEM_ID, DIMENSION_ITEM_NAME]);
  assert.deepEqual(body.metrics, METRICAS_PRODUTO);
});

test('E · compatibilidadeRequestBody aceita subconjunto de métricas para checar isoladamente', () => {
  const body = compatibilidadeRequestBody({ metricas: ['itemsViewed'] });
  assert.deepEqual(body.metrics, ['itemsViewed']);
});
