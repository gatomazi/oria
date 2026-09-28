'use strict';

// CSV seguro e níveis.

const test = require('node:test');
const assert = require('node:assert/strict');

const { gerarCsv, celula } = require('../lib/afiliados/csv');
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

// Promoções da INK (mapper, GET/POST/PATCH/DELETE, idempotência, fail-closed): test/afiliados-ink-promocoes.test.js.

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
