'use strict';

// Fase E · builders de query GA4 (lib/connectors/analytics/ga4/queries.js): forma exata do request
// body de runReport/checkCompatibility — puro, sem rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DIMENSION_ITEM_ID, DIMENSION_ITEM_NAME, METRICAS_PRODUTO,
  DIMENSOES_ACQUISITION, METRICAS_ACQUISITION, DIMENSION_TRANSACTION_ID, METRICAS_TRANSACTION,
  reportRequestBody, compatibilidadeRequestBody,
  acquisitionRequestBody, acquisitionCompatibilityRequestBody,
  transactionCompatibilityRequestBody, transactionLookupRequestBody,
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

// ── K (Journey Analytics): aquisição e lookup de transação ────────────────────────────────────

test('K · DIMENSOES_ACQUISITION reaproveita os nomes `sessionManual*` já provados compatíveis no UTM Tracker legado (server.js) — nunca sessionSource/sessionDefaultChannelGroup sem evidência', () => {
  assert.deepEqual(DIMENSOES_ACQUISITION, ['sessionManualSource', 'sessionManualMedium', 'sessionManualCampaignName']);
  assert.deepEqual(METRICAS_ACQUISITION, ['sessions', 'ecommercePurchases', 'totalRevenue']);
});

test('K · acquisitionRequestBody: dateRanges ISO puro, 3 dimensões de sessão, nunca combinado com itemId', () => {
  const body = acquisitionRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.deepEqual(body.dateRanges, [{ startDate: '2026-09-01', endDate: '2026-09-20' }]);
  assert.deepEqual(body.dimensions, DIMENSOES_ACQUISITION.map((name) => ({ name })));
  assert.deepEqual(body.metrics, METRICAS_ACQUISITION.map((name) => ({ name })));
  assert.doesNotMatch(JSON.stringify(body), /itemId/);
});

test('E · acquisitionRequestBody exige startDate/endDate', () => {
  assert.throws(() => acquisitionRequestBody({ endDate: '2026-09-20' }), TypeError);
  assert.throws(() => acquisitionRequestBody({ startDate: '2026-09-01' }), TypeError);
});

test('K · acquisitionCompatibilityRequestBody pede exatamente as 3 dimensões + 3 métricas de aquisição', () => {
  const body = acquisitionCompatibilityRequestBody();
  assert.deepEqual(body.dimensions, DIMENSOES_ACQUISITION);
  assert.deepEqual(body.metrics, METRICAS_ACQUISITION);
});

test('K · transactionCompatibilityRequestBody pede transactionId + transactions/purchaseRevenue', () => {
  const body = transactionCompatibilityRequestBody();
  assert.deepEqual(body.dimensions, [DIMENSION_TRANSACTION_ID]);
  assert.deepEqual(body.metrics, METRICAS_TRANSACTION);
});

test('K · transactionLookupRequestBody: dimensionFilter EXACT fixa 1 único transactionId, limit 1 — nunca uma varredura', () => {
  const body = transactionLookupRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20', transactionId: 'ink-42' });
  assert.deepEqual(body.dimensions, [{ name: DIMENSION_TRANSACTION_ID }]);
  assert.deepEqual(body.dimensionFilter, { filter: { fieldName: DIMENSION_TRANSACTION_ID, stringFilter: { matchType: 'EXACT', value: 'ink-42' } } });
  assert.equal(body.limit, 1);
});

test('E · transactionLookupRequestBody exige startDate/endDate/transactionId', () => {
  assert.throws(() => transactionLookupRequestBody({ endDate: '2026-09-20', transactionId: 'x' }), TypeError);
  assert.throws(() => transactionLookupRequestBody({ startDate: '2026-09-01', transactionId: 'x' }), TypeError);
  assert.throws(() => transactionLookupRequestBody({ startDate: '2026-09-01', endDate: '2026-09-20' }), TypeError);
});
