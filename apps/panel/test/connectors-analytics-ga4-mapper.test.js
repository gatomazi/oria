'use strict';

// Fase E · GA4 mapper (lib/connectors/analytics/ga4/mapper.js): parsing de métrica, itemId como
// identidade única, itemName só diagnóstico, "(not set)"/vazio nunca vira produto.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Ga4MetricParseError, parseInteiro, parseMonetario, ehItemIdValido, mapRow, mapReportRows,
} = require('../lib/connectors/analytics/ga4/mapper');
const { METRICAS_PRODUTO } = require('../lib/connectors/analytics/ga4/queries');

const dim = (...valores) => valores.map((value) => ({ value }));
const met = (...valores) => valores.map((value) => ({ value }));

// ── parseInteiro / parseMonetario ──────────────────────────────────────────────────────────────

test('E · parseInteiro converte string numérica válida; null passa como null (métrica não pedida)', () => {
  assert.equal(parseInteiro('42', 'x'), 42);
  assert.equal(parseInteiro('0', 'x'), 0);
  assert.equal(parseInteiro(null, 'x'), null);
  assert.equal(parseInteiro(undefined, 'x'), null);
});

test('E · parseInteiro nunca deixa NaN/Infinity/negativo/decimal passar silenciosamente', () => {
  for (const ruim of ['abc', 'NaN', 'Infinity', '-1', '1.5', '', ' ']) {
    assert.throws(() => parseInteiro(ruim, 'itemsViewed'), Ga4MetricParseError);
  }
});

test('E · parseMonetario aceita decimal não negativo; rejeita negativo/NaN', () => {
  assert.equal(parseMonetario('199.90', 'itemRevenue'), 199.9);
  assert.equal(parseMonetario('0', 'itemRevenue'), 0);
  assert.equal(parseMonetario(null, 'itemRevenue'), null);
  assert.throws(() => parseMonetario('-1', 'itemRevenue'), Ga4MetricParseError);
  assert.throws(() => parseMonetario('abc', 'itemRevenue'), Ga4MetricParseError);
});

test('E · erro de parsing carrega código estável e nomeia o campo', () => {
  try {
    parseInteiro('abc', 'itemsPurchased');
    assert.fail('deveria lançar');
  } catch (err) {
    assert.equal(err.codigo, 'GA4_METRIC_UNPARSEABLE');
    assert.match(err.message, /itemsPurchased/);
  }
});

// ── ehItemIdValido / mapRow ─────────────────────────────────────────────────────────────────────

test('E · ehItemIdValido rejeita vazio, espaços e "(not set)"; aceita qualquer outro texto', () => {
  assert.equal(ehItemIdValido('386559'), true);
  assert.equal(ehItemIdValido(''), false);
  assert.equal(ehItemIdValido('   '), false);
  assert.equal(ehItemIdValido('(not set)'), false);
  assert.equal(ehItemIdValido(null), false);
  assert.equal(ehItemIdValido(undefined), false);
});

test('E · mapRow: itemId é a identidade, itemName é só diagnóstico', () => {
  const row = { dimensionValues: dim('386559', 'Camiseta Regional'), metricValues: met('1840', '214', '93', '41', '4512.30') };
  const { row: r, skipped } = mapRow(row, { metricasPedidas: METRICAS_PRODUTO, comItemName: true });
  assert.equal(skipped, null);
  assert.equal(r.externalProductId, '386559');
  assert.equal(r.externalProductName, 'Camiseta Regional');
  assert.equal(r.itemsViewed, 1840);
  assert.equal(r.itemsAddedToCart, 214);
  assert.equal(r.itemsCheckedOut, 93);
  assert.equal(r.itemsPurchased, 41);
  assert.equal(r.itemRevenue, 4512.3);
  assert.equal(r.analyticsProvider, 'ga4');
});

test('E · mapRow: itemId "(not set)" ou vazio é descartado (skipped: empty_item_id), nunca vira produto', () => {
  for (const idInvalido of ['(not set)', '', '   ']) {
    const row = { dimensionValues: dim(idInvalido, 'x'), metricValues: met('1', '1', '1', '1', '1') };
    const { row: r, skipped } = mapRow(row, { metricasPedidas: METRICAS_PRODUTO, comItemName: true });
    assert.equal(r, null);
    assert.equal(skipped, 'empty_item_id');
  }
});

test('E · mapRow sem itemName (comItemName: false) não inventa um nome', () => {
  const row = { dimensionValues: dim('1'), metricValues: met('1', '1', '1', '1', '1') };
  const { row: r } = mapRow(row, { metricasPedidas: METRICAS_PRODUTO, comItemName: false });
  assert.equal(r.externalProductName, null);
});

test('E · mapRow: métrica não pedida (incompatível na propriedade) vira null, nunca 0 inventado', () => {
  const parcial = ['itemsViewed', 'itemRevenue']; // itemsAddedToCart/itemsCheckedOut/itemsPurchased indisponíveis
  const row = { dimensionValues: dim('1', 'x'), metricValues: met('100', '50.5') };
  const { row: r } = mapRow(row, { metricasPedidas: parcial, comItemName: true });
  assert.equal(r.itemsViewed, 100);
  assert.equal(r.itemRevenue, 50.5);
  assert.equal(r.itemsAddedToCart, null);
  assert.equal(r.itemsCheckedOut, null);
  assert.equal(r.itemsPurchased, null);
});

test('E · mapRow exige a forma esperada de linha', () => {
  assert.throws(() => mapRow(null, { metricasPedidas: METRICAS_PRODUTO }), TypeError);
  assert.throws(() => mapRow({ dimensionValues: [] }, { metricasPedidas: METRICAS_PRODUTO }), TypeError);
});

test('E · mapRow devolve objeto congelado', () => {
  const row = { dimensionValues: dim('1', 'x'), metricValues: met('1', '1', '1', '1', '1') };
  const { row: r } = mapRow(row, { metricasPedidas: METRICAS_PRODUTO, comItemName: true });
  assert.ok(Object.isFrozen(r));
});

// ── mapReportRows ───────────────────────────────────────────────────────────────────────────────

test('E · mapReportRows: mapeia todas as linhas válidas e CONTA (não descarta silenciosamente) as com itemId vazio/"(not set)"', () => {
  const rows = [
    { dimensionValues: dim('1', 'a'), metricValues: met('1', '1', '1', '1', '1') },
    { dimensionValues: dim('(not set)', ''), metricValues: met('9', '9', '9', '9', '9') },
    { dimensionValues: dim('2', 'b'), metricValues: met('2', '2', '2', '2', '2') },
    { dimensionValues: dim('', ''), metricValues: met('9', '9', '9', '9', '9') },
  ];
  const { linhas, itemIdVazioOuNaoDefinido } = mapReportRows(rows, { metricasPedidas: METRICAS_PRODUTO, comItemName: true });
  assert.equal(linhas.length, 2);
  assert.deepEqual(linhas.map((l) => l.externalProductId), ['1', '2']);
  assert.equal(itemIdVazioOuNaoDefinido, 2);
});

test('E · mapReportRows de dataset vazio devolve lista vazia e zero descartes, sem erro', () => {
  assert.deepEqual(mapReportRows([], { metricasPedidas: METRICAS_PRODUTO, comItemName: true }), { linhas: [], itemIdVazioOuNaoDefinido: 0 });
  assert.deepEqual(mapReportRows(undefined, { metricasPedidas: METRICAS_PRODUTO, comItemName: true }), { linhas: [], itemIdVazioOuNaoDefinido: 0 });
});

test('E · mapReportRows propaga erro de parsing de uma métrica corrompida (não engole)', () => {
  const rows = [{ dimensionValues: dim('1', 'a'), metricValues: met('abc', '1', '1', '1', '1') }];
  assert.throws(() => mapReportRows(rows, { metricasPedidas: METRICAS_PRODUTO, comItemName: true }), Ga4MetricParseError);
});
