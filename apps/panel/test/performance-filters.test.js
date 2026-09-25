'use strict';

// Rodada "Desempenho de Produtos: mais dados primeiro + filtros" · a regra única dos filtros
// (lib/product-analytics/performance-filters.js), sem banco. O comportamento contra o catálogo real
// está em test/invariants/product-performance-service.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS_VALIDOS, MINIMOS, BUSCA_MAX_CARACTERES, BUSCA_MAX_PALAVRAS, volumeDeDados, termosDeBusca, normalizarFiltros, passaNosFiltrosDeMetrica,
} = require('../lib/product-analytics/performance-filters');

const metricas = (over = {}) => ({
  metrics: { itemsViewed: 10, itemsAddedToCart: 4, itemsCheckedOut: 2, itemsPurchased: 1, itemRevenue: 99.9, ...over },
});

test('F · sem filtro nenhum: status active, nada de métrica, provider intacto', () => {
  const f = normalizarFiltros({ provider: 'reserva_ink' });
  assert.equal(f.status, 'active');
  assert.equal(f.provider, 'reserva_ink');
  assert.deepEqual(f.minimos, []);
  assert.equal(f.somenteComDados, false);
  assert.equal(f.temFiltroDeMetrica, false);
  assert.equal(normalizarFiltros().status, 'active');
});

test('F · status: só active, inactive e all; qualquer outro valor é erro (nunca cai no padrão em silêncio)', () => {
  for (const status of STATUS_VALIDOS) assert.equal(normalizarFiltros({ status }).status, status);
  for (const status of ['ativos', 'ACTIVE', '', 'true', 1]) assert.throws(() => normalizarFiltros({ status }), TypeError);
});

test('F · mínimos: número >= 0; 0 e ausente significam "sem filtro"; negativo, NaN e texto são erro', () => {
  assert.deepEqual(normalizarFiltros({ minPurchased: 0, minViewed: undefined }).minimos, []);
  const f = normalizarFiltros({ minPurchased: 5, minCheckedOut: 2.5 });
  // a ordem segue a de MINIMOS (funil), não a da entrada
  assert.deepEqual(f.minimos.map((m) => [m.chave, m.metrica, m.minimo]), [
    ['minCheckedOut', 'itemsCheckedOut', 2.5], ['minPurchased', 'itemsPurchased', 5],
  ]);
  assert.deepEqual(Object.keys(MINIMOS), ['minViewed', 'minAddedToCart', 'minCheckedOut', 'minPurchased', 'minRevenue']);
  assert.equal(f.temFiltroDeMetrica, true);
  for (const valor of [-1, NaN, Infinity, '5']) {
    assert.throws(() => normalizarFiltros({ minPurchased: valor }), TypeError, `minPurchased=${String(valor)}`);
  }
});

test('F · hasData só liga com true de verdade (string "true" não conta — a rota converte antes)', () => {
  assert.equal(normalizarFiltros({ hasData: true }).somenteComDados, true);
  assert.equal(normalizarFiltros({ hasData: true }).temFiltroDeMetrica, true);
  assert.equal(normalizarFiltros({ hasData: 'true' }).somenteComDados, false);
  assert.equal(normalizarFiltros({ hasData: false }).temFiltroDeMetrica, false);
});

test('F · volumeDeDados: soma as 4 contagens (receita não), null conta como 0, sem métrica é 0', () => {
  assert.equal(volumeDeDados({ itemsViewed: 10, itemsAddedToCart: 4, itemsCheckedOut: 2, itemsPurchased: 1, itemRevenue: 9999 }), 17);
  assert.equal(volumeDeDados({ itemsViewed: null, itemsAddedToCart: 3, itemsCheckedOut: null, itemsPurchased: 0, itemRevenue: null }), 3);
  assert.equal(volumeDeDados(null), 0);
  assert.equal(volumeDeDados(undefined), 0);
});

test('F · passaNosFiltrosDeMetrica: sem filtro passa tudo, inclusive produto sem dado nenhum', () => {
  const f = normalizarFiltros({});
  assert.equal(passaNosFiltrosDeMetrica(undefined, f), true);
  assert.equal(passaNosFiltrosDeMetrica(metricas(), f), true);
});

test('F · mínimo é ">=" por métrica, todos ao mesmo tempo (E, nunca OU)', () => {
  const f = normalizarFiltros({ minPurchased: 1, minViewed: 10 });
  assert.equal(passaNosFiltrosDeMetrica(metricas(), f), true); // exatamente no limite passa
  assert.equal(passaNosFiltrosDeMetrica(metricas({ itemsPurchased: 0 }), f), false);
  assert.equal(passaNosFiltrosDeMetrica(metricas({ itemsViewed: 9 }), f), false);
});

test('F · métrica indisponível (null) NUNCA satisfaz um mínimo > 0 — e produto sem dado também não', () => {
  const f = normalizarFiltros({ minRevenue: 1 });
  assert.equal(passaNosFiltrosDeMetrica(metricas({ itemRevenue: null }), f), false);
  assert.equal(passaNosFiltrosDeMetrica(undefined, f), false);
  // mas um mínimo de OUTRA métrica não é afetado por null numa terceira
  assert.equal(passaNosFiltrosDeMetrica(metricas({ itemRevenue: null }), normalizarFiltros({ minViewed: 5 })), true);
});

test('F · somente com dados: volume > 0; zero real e sem métrica ficam de fora', () => {
  const f = normalizarFiltros({ hasData: true });
  assert.equal(passaNosFiltrosDeMetrica(metricas(), f), true);
  assert.equal(passaNosFiltrosDeMetrica(metricas({ itemsViewed: 0, itemsAddedToCart: 0, itemsCheckedOut: 0, itemsPurchased: 0 }), f), false);
  assert.equal(passaNosFiltrosDeMetrica(undefined, f), false);
});

// ── Busca por nome ────────────────────────────────────────────────────────────────────────────────

test('F · termosDeBusca: separa por espaço, ignora espaço sobrando e vazio é "sem busca"', () => {
  assert.deepEqual(termosDeBusca('  camiseta   Preta '), ['camiseta', 'Preta']);
  assert.deepEqual(termosDeBusca(''), []);
  assert.deepEqual(termosDeBusca('   \t '), []);
  assert.deepEqual(termosDeBusca(undefined), []);
  assert.deepEqual(termosDeBusca(null), []);
});

test('F · termosDeBusca: passou do limite de caracteres ou de palavras, ou não é texto, é erro', () => {
  assert.equal(termosDeBusca('a'.repeat(BUSCA_MAX_CARACTERES)).length, 1);
  assert.throws(() => termosDeBusca('a'.repeat(BUSCA_MAX_CARACTERES + 1)), TypeError);
  assert.equal(termosDeBusca(Array.from({ length: BUSCA_MAX_PALAVRAS }, () => 'x').join(' ')).length, BUSCA_MAX_PALAVRAS);
  assert.throws(() => termosDeBusca(Array.from({ length: BUSCA_MAX_PALAVRAS + 1 }, () => 'x').join(' ')), TypeError);
  for (const ruim of [42, {}, ['a'], true]) assert.throws(() => termosDeBusca(ruim), TypeError);
});

test('F · com busca, status vira "all" e mínimos/hasData são IGNORADOS (nem validados) — a busca vence tudo', () => {
  const f = normalizarFiltros({ search: 'camiseta', status: 'active', minPurchased: 5, hasData: true, provider: 'reserva_ink' });
  assert.equal(f.status, 'all');
  assert.deepEqual(f.minimos, []);
  assert.equal(f.somenteComDados, false);
  assert.equal(f.temFiltroDeMetrica, false);
  assert.deepEqual(f.busca.termos, ['camiseta']);
  assert.equal(f.provider, 'reserva_ink'); // o provider não é filtro de tela, segue valendo
  // filtro inválido junto com busca não derruba: foi ignorado
  assert.doesNotThrow(() => normalizarFiltros({ search: 'x', status: 'nope', minPurchased: -1 }));
  // mas sem busca o mesmo filtro inválido continua sendo erro
  assert.throws(() => normalizarFiltros({ status: 'nope' }), TypeError);
});

test('F · sem busca o resultado é o de sempre e `busca` é null', () => {
  assert.equal(normalizarFiltros({}).busca, null);
  assert.equal(normalizarFiltros({ search: '   ' }).busca, null);
  assert.equal(normalizarFiltros({ search: '   ', status: 'inactive' }).status, 'inactive');
});
