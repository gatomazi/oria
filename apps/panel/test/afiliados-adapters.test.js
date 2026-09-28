'use strict';

// CSV seguro, adaptador de promoções da INK (contract tests com fake, sem chamada real) e níveis.

const test = require('node:test');
const assert = require('node:assert/strict');

const { gerarCsv, celula } = require('../lib/afiliados/csv');
const inkPromo = require('../lib/afiliados/ink-promotions');
const levels = require('../lib/afiliados/levels');

// ── CSV ────────────────────────────────────────────────────────────────────────────────────────
test('CSV neutraliza fórmulas, mas números negativos legítimos continuam números', () => {
  assert.equal(celula('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(celula('+55 11'), "'+55 11");
  assert.equal(celula('-cmd'), "'-cmd");
  assert.equal(celula('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(celula(-12.5), '-12.5');
  assert.equal(celula(null), '');
  assert.equal(celula('a,b'), '"a,b"');
  assert.equal(celula('linha\nquebra'), '"linha\nquebra"');
});

test('CSV só emite as colunas declaradas (não vaza campo extra da linha)', () => {
  const csv = gerarCsv([{ chave: 'nome', titulo: 'Nome' }], [{ nome: 'Ana', email: 'x@y.com', token: 'segredo' }]);
  assert.match(csv, /Nome\r\nAna\r\n/);
  assert.doesNotMatch(csv, /segredo|x@y\.com/);
});

// ── INK: promoções ─────────────────────────────────────────────────────────────────────────────
const LINK = { id: 'link-1', codeDisplay: 'Amanda10', codeNormalized: 'AMANDA10', discountKind: 'percentage', discountBps: 1000, validFrom: new Date('2026-10-01T03:00:00Z'), validUntil: null };

function clienteFalso({ existentes = [], criada = { promotion: { id: 77, code: 'AMANDA10', type: 'standard', kind: 'percentage', available: true, discount_tiers: [{ discount: '10.0' }], starts_at: '2026-10-01T03:00:00.000Z' } } } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async get(path) { chamadas.push(['GET', path]); return { promotions: existentes }; },
    async post(path, body, headers) { chamadas.push(['POST', path, body, headers]); return criada; },
  };
}

test('escrita desligada: nenhum POST é feito mesmo com cliente injetado', async () => {
  const cliente = clienteFalso();
  const adapter = inkPromo.createInkPromotionsAdapter({ client: cliente, flags: { inkPromotionWritesEnabled: false } });
  await assert.rejects(() => adapter.criarPromocao(LINK), inkPromo.PromotionWritesDisabledError);
  assert.equal(cliente.chamadas.length, 0);
});

test('escrita ligada mas sem cliente de escrita: também falha fechado', async () => {
  const adapter = inkPromo.createInkPromotionsAdapter({ client: { get: async () => ({ promotions: [] }) }, flags: { inkPromotionWritesEnabled: true } });
  await assert.rejects(() => adapter.criarPromocao(LINK), inkPromo.PromotionWritesDisabledError);
});

test('preview monta o pedido com Idempotency-Key estável e não faz nenhuma chamada', () => {
  const cliente = clienteFalso();
  const adapter = inkPromo.createInkPromotionsAdapter({ client: cliente, flags: {} });
  const a = adapter.previsualizarCriacao(LINK);
  const b = adapter.previsualizarCriacao(LINK);
  assert.equal(a.ok, true);
  assert.equal(a.enviaria, false);
  assert.equal(a.request.method, 'POST');
  assert.equal(a.request.path, '/v1/stores/promotions/standard');
  assert.equal(a.request.headers['Idempotency-Key'], 'oria-affiliate-coupon-link-1');
  assert.equal(a.request.headers['Idempotency-Key'], b.request.headers['Idempotency-Key']);
  assert.equal(a.request.escopoExigido, 'store.promotions.write');
  assert.deepEqual(a.request.body.discount_tier, { discount: 10 });
  assert.equal(a.request.body.code, 'AMANDA10');
  assert.equal(cliente.chamadas.length, 0);
});

test('preview aponta problemas de validação em vez de montar pedido inválido', () => {
  const adapter = inkPromo.createInkPromotionsAdapter({});
  const r = adapter.previsualizarCriacao({ ...LINK, codeDisplay: 'a b', codeNormalized: 'A B', discountKind: null });
  assert.equal(r.ok, false);
  assert.ok(r.problemas.length >= 2);
});

test('criação (só com fake e flag ligada): checa conflito, cria com Idempotency-Key e lê de volta', async () => {
  const cliente = clienteFalso();
  const adapter = inkPromo.createInkPromotionsAdapter({ client: cliente, flags: { inkPromotionWritesEnabled: true }, scopes: ['store.promotions.write', 'store.promotions.read'] });
  const r = await adapter.criarPromocao(LINK);
  assert.equal(r.promotionId, 77);
  const post = cliente.chamadas.find((c) => c[0] === 'POST');
  assert.equal(post[3]['Idempotency-Key'], 'oria-affiliate-coupon-link-1');
  // GET de conflito antes do POST e GET de leitura de volta depois.
  assert.equal(cliente.chamadas[0][0], 'GET');
  assert.equal(cliente.chamadas.filter((c) => c[0] === 'GET').length, 2);
});

test('conflito: código já existente na INK não é sobrescrito', async () => {
  const cliente = clienteFalso({ existentes: [{ id: 5, code: 'amanda10', type: 'standard' }] });
  const adapter = inkPromo.createInkPromotionsAdapter({ client: cliente, flags: { inkPromotionWritesEnabled: true } });
  await assert.rejects(() => adapter.criarPromocao(LINK), inkPromo.PromotionConflictError);
  assert.equal(cliente.chamadas.some((c) => c[0] === 'POST'), false);
});

test('token sem escopo de escrita: recusa antes de qualquer chamada', async () => {
  const cliente = clienteFalso();
  const adapter = inkPromo.createInkPromotionsAdapter({ client: cliente, flags: { inkPromotionWritesEnabled: true }, scopes: ['store.promotions.read'] });
  await assert.rejects(() => adapter.criarPromocao(LINK), inkPromo.PromotionPermissionError);
  assert.equal(cliente.chamadas.length, 0);
});

test('verificação de cupom manual: confirmado, divergente e não encontrado', async () => {
  const ok = clienteFalso({ existentes: [{ id: 9, code: 'AMANDA10', type: 'standard', kind: 'percentage', available: true, discount_tiers: [{ discount: '10.00' }] }] });
  assert.equal((await inkPromo.createInkPromotionsAdapter({ client: ok }).verificarCupom(LINK)).status, 'confirmed');
  const dif = clienteFalso({ existentes: [{ id: 9, code: 'AMANDA10', type: 'standard', kind: 'percentage', available: true, discount_tiers: [{ discount: '25.00' }] }] });
  const r = await inkPromo.createInkPromotionsAdapter({ client: dif }).verificarCupom(LINK);
  assert.equal(r.status, 'divergent');
  assert.match(r.divergencias.join(' '), /valor do desconto/);
  const nada = clienteFalso({ existentes: [] });
  assert.equal((await inkPromo.createInkPromotionsAdapter({ client: nada }).verificarCupom(LINK)).status, 'not_found');
  assert.equal((await inkPromo.createInkPromotionsAdapter({ client: null }).verificarCupom(LINK)).status, 'unavailable');
});

// ── Níveis ─────────────────────────────────────────────────────────────────────────────────────
const AGORA = new Date('2026-10-20T12:00:00Z');
function linhaVenda(pedido, item, diasAtras, extra = {}) {
  return { inkOrderId: pedido, inkItemId: item, eligibleQty: 1, marginEligibleCents: 4000, saleAt: new Date(AGORA.getTime() - diasAtras * 86400000), status: 'calculated', orderState: 'delivered', ...extra };
}

test('regras padrão são válidas e ordenadas', () => {
  assert.doesNotThrow(() => levels.validarRegras(levels.REGRAS_PADRAO));
  assert.deepEqual(levels.REGRAS_PADRAO.niveis.map((n) => n.key), ['raiz', 'voz', 'referencia', 'embaixador']);
  assert.throws(() => levels.validarRegras({ niveis: [{ key: 'a', ordem: 1 }, { key: 'a', ordem: 2 }] }));
});

test('métricas: cupom+collab na mesma linha contam uma vez; pedido não pago e estornado não contam', () => {
  const linhas = [
    linhaVenda(1, 1, 5), linhaVenda(1, 1, 5), // mesma linha atribuída duas vezes (collab + cupom)
    linhaVenda(2, 1, 10, { orderState: 'awaiting_payment' }),
    linhaVenda(3, 1, 10, { eligibleQty: 0 }),
    linhaVenda(4, 1, 200), // fora da janela de 90 dias
    linhaVenda(5, 1, 20, { eligibleQty: 2 }),
  ];
  const m = levels.metricasDaJanela(linhas, { agora: AGORA, janelaDias: 90, contarPor: 'orders' });
  assert.equal(m.pedidosDistintos, 2);
  assert.equal(m.vendasQualificadas, 2);
  assert.equal(m.unidades, 3);
  const u = levels.metricasDaJanela(linhas, { agora: AGORA, janelaDias: 90, contarPor: 'units' });
  assert.equal(u.vendasQualificadas, 3);
});

test('collab conta UNIDADES, não pedidos: 2 camisetas em 1 pedido = 2 unidades e 1 pedido', () => {
  const m = levels.metricasDaJanela([linhaVenda(1, 1, 3, { eligibleQty: 2 })], { agora: AGORA, janelaDias: 90, contarPor: 'units' });
  assert.equal(m.pedidosDistintos, 1);
  assert.equal(m.unidades, 2);
  assert.equal(m.vendasQualificadas, 2);
});

test('nível: precisa de TODAS as metas simultâneas; margem sem custo verificado não promove', () => {
  const linhas = Array.from({ length: 5 }, (_, i) => linhaVenda(100 + i, 1, 10 + i, { marginEligibleCents: 3000 }));
  const m = levels.metricasDaJanela(linhas, { agora: AGORA, janelaDias: 90 });
  assert.equal(levels.avaliarNivel(m, levels.REGRAS_PADRAO, 'raiz').nivelAlcancado, 'voz');
  const menosMargem = levels.metricasDaJanela(linhas.map((l) => ({ ...l, marginEligibleCents: 1000 })), { agora: AGORA, janelaDias: 90 });
  assert.equal(levels.avaliarNivel(menosMargem, levels.REGRAS_PADRAO, 'raiz').nivelAlcancado, 'raiz');
  const semCusto = levels.metricasDaJanela(linhas.map((l) => ({ ...l, marginEligibleCents: null })), { agora: AGORA, janelaDias: 90 });
  const av = levels.avaliarNivel(semCusto, levels.REGRAS_PADRAO, 'raiz');
  assert.equal(av.nivelAlcancado, 'raiz');
  assert.equal(av.proximo.metas.find((x) => x.meta === 'margemCents').naoVerificada, true);
});

test('avaliação sugere rebaixamento quando as metas deixam de ser cumpridas', () => {
  const m = levels.metricasDaJanela([linhaVenda(1, 1, 5)], { agora: AGORA, janelaDias: 90 });
  const av = levels.avaliarNivel(m, levels.REGRAS_PADRAO, 'referencia');
  assert.equal(av.direcao, 'downgrade');
  assert.equal(av.nivelAlcancado, 'raiz');
});

test('peça grátis: nunca ao ingressar; exige vendas, período, atividade e saldo', () => {
  const [raiz, voz, , embaixador] = levels.REGRAS_PADRAO.niveis;
  const m = (vendas, v30 = 0) => ({ vendasQualificadas: vendas, vendasUltimos30d: v30 });
  assert.equal(levels.elegibilidadeDePeca({ nivel: raiz, metricas: m(100), saldoBeneficioCents: 99999, custoPecaCents: 1000, agora: AGORA }).motivo, 'nivel_sem_peca');
  assert.equal(levels.elegibilidadeDePeca({ nivel: voz, metricas: m(11), saldoBeneficioCents: 99999, custoPecaCents: 1000, agora: AGORA }).motivo, 'vendas_insuficientes');
  assert.equal(levels.elegibilidadeDePeca({ nivel: voz, metricas: m(12), saldoBeneficioCents: 500, custoPecaCents: 1000, agora: AGORA }).motivo, 'saldo_insuficiente');
  assert.equal(levels.elegibilidadeDePeca({ nivel: voz, metricas: m(12), saldoBeneficioCents: 2000, custoPecaCents: 1000, agora: AGORA }).elegivel, true);
  assert.equal(levels.elegibilidadeDePeca({ nivel: embaixador, metricas: m(50, 5), saldoBeneficioCents: 9999, custoPecaCents: 1000, agora: AGORA }).motivo, 'atividade_insuficiente');
  assert.equal(levels.elegibilidadeDePeca({ nivel: embaixador, metricas: m(50, 12), saldoBeneficioCents: 9999, custoPecaCents: 1000, ultimaPecaEm: new Date(AGORA.getTime() - 5 * 86400000), agora: AGORA }).motivo, 'periodo_nao_cumprido');
});
