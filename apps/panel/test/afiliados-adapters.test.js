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
  assert.throws(() => levels.validarRegras({ niveis: [{ key: 'a', label: 'A', beneficio: { tipo: 'nenhum' } }, { key: 'a', label: 'A de novo', beneficio: { tipo: 'nenhum' } }] }));
});

// ── Configurabilidade total pelo lojista: mais steps, campos livres, whitelist (nunca confia no bruto) ──────────────────
test('regras: `ordem` NUNCA vem do cliente — é sempre a posição no array; reordenar é só mudar a posição', () => {
  const r = levels.validarRegras({
    niveis: [
      { key: 'aa', label: 'A', ordem: 99, tetoMargemBps: 1500, beneficio: { tipo: 'nenhum' } },
      { key: 'bb', label: 'B', ordem: -5, vendasQualificadas: 1, margemCents: 0, mesesComVenda: 0, vendasUltimos60d: 0, tetoMargemBps: 1000, beneficio: { tipo: 'nenhum' } },
    ],
  });
  assert.deepEqual(r.niveis.map((n) => n.ordem), [0, 1]);
});

test('regras: campo desconhecido nunca é persistido (whitelist, igual a lerTermos/lerPerfis)', () => {
  const r = levels.validarRegras({
    niveis: [{ key: 'raiz', label: 'Raiz', tetoMargemBps: 1500, beneficio: { tipo: 'nenhum' } }],
    algoQueNaoDeveria: 'x',
  });
  assert.equal('algoQueNaoDeveria' in r, false);
  const r2 = levels.validarRegras({ niveis: [{ key: 'raiz', label: 'Raiz', tetoMargemBps: 1500, beneficio: { tipo: 'nenhum' }, campoInventado: 123, outroTambem: {} }] });
  assert.deepEqual(Object.keys(r2.niveis[0]).sort(), ['beneficio', 'janelaDias', 'key', 'label', 'margemCents', 'mesesComVenda', 'ordem', 'tetoMargemBps', 'vendasQualificadas', 'vendasUltimos60d']);
});

test('regras: nível base (índice 0) tem as metas sempre zeradas, mesmo que o cliente mande valores diferentes', () => {
  const r = levels.validarRegras({ niveis: [{ key: 'raiz', label: 'Raiz', vendasQualificadas: 999, margemCents: 999, mesesComVenda: 99, vendasUltimos60d: 99, tetoMargemBps: 1500, beneficio: { tipo: 'nenhum' } }] });
  assert.deepEqual([r.niveis[0].vendasQualificadas, r.niveis[0].margemCents, r.niveis[0].mesesComVenda, r.niveis[0].vendasUltimos60d], [0, 0, 0, 0]);
});

test('regras: de 1 a 16 níveis (mais "steps" é livre dentro do teto); fora disso é rejeitado', () => {
  const nivel = (i) => ({ key: `nv${i}`, label: `N${i}`, vendasQualificadas: 0, margemCents: 0, mesesComVenda: 0, vendasUltimos60d: 0, tetoMargemBps: 1000, beneficio: { tipo: 'nenhum' } });
  assert.doesNotThrow(() => levels.validarRegras({ niveis: [nivel(0)] }));
  assert.doesNotThrow(() => levels.validarRegras({ niveis: Array.from({ length: 16 }, (_, i) => nivel(i)) }));
  assert.throws(() => levels.validarRegras({ niveis: [] }), /1 a 16/);
  assert.throws(() => levels.validarRegras({ niveis: Array.from({ length: 17 }, (_, i) => nivel(i)) }), /1 a 16/);
});

test('regras: chave inválida, duplicada ou nome vazio são rejeitados', () => {
  const base = { vendasQualificadas: 0, margemCents: 0, mesesComVenda: 0, vendasUltimos60d: 0, tetoMargemBps: 1000, beneficio: { tipo: 'nenhum' } };
  assert.throws(() => levels.validarRegras({ niveis: [{ ...base, key: 'Maiuscula', label: 'X' }] }), /chave inválida/);
  assert.throws(() => levels.validarRegras({ niveis: [{ ...base, key: 'a', label: 'X' }] }), /chave inválida/); // 1 caractere só
  assert.throws(() => levels.validarRegras({ niveis: [{ ...base, key: 'ok', label: '   ' }] }), /label/);
  assert.throws(() => levels.validarRegras({ niveis: [{ ...base, key: 'dup', label: 'X' }, { ...base, key: 'dup', label: 'Y' }] }), /duplicada/);
});

test('regras: benefício é validado e normalizado POR TIPO — campo de outro tipo nunca sobra no objeto salvo', () => {
  const base = { key: 'voz', label: 'Voz', vendasQualificadas: 0, margemCents: 0, mesesComVenda: 0, vendasUltimos60d: 0, tetoMargemBps: 1000 };
  assert.throws(() => levels.validarRegras({ niveis: [{ ...base, beneficio: { tipo: 'periodica_errada' } }] }), /beneficio\.tipo/);
  assert.throws(() => levels.validarRegras({ niveis: [{ ...base, beneficio: { tipo: 'primeira_peca' } }] }), /aPartirDeVendas/); // obrigatório ausente
  assert.throws(() => levels.validarRegras({ niveis: [{ ...base, beneficio: { tipo: 'peca_periodica' } }] }), /aCadaDias/); // obrigatório ausente
  const r = levels.validarRegras({ niveis: [{ ...base, beneficio: { tipo: 'peca_periodica', aCadaDias: 30, aPartirDeVendas: 999, exigeVendasUltimos30d: 5 } }] });
  assert.deepEqual(r.niveis[0].beneficio, { tipo: 'peca_periodica', aCadaDias: 30, exigeVendasUltimos30d: 5 }); // aPartirDeVendas (de outro tipo) cai fora
  const r2 = levels.validarRegras({ niveis: [{ ...base, beneficio: { tipo: 'peca_periodica', aCadaDias: 30, exigeVendasUltimos30d: '' } }] });
  assert.deepEqual(r2.niveis[0].beneficio, { tipo: 'peca_periodica', aCadaDias: 30 }); // opcional vazio não entra
});

test('regras: um nível de exemplo com 8 steps e benefícios variados passa e mantém a ordem dos rótulos', () => {
  const niveis = [
    { key: 'raiz', label: 'Raiz', beneficio: { tipo: 'nenhum' }, tetoMargemBps: 1000 },
    ...Array.from({ length: 7 }, (_, i) => ({
      key: `nivel_${i + 1}`, label: `Nível ${i + 1}`, vendasQualificadas: (i + 1) * 10, margemCents: (i + 1) * 10000, mesesComVenda: 0, vendasUltimos60d: 0, tetoMargemBps: 1000 + i * 200,
      beneficio: i % 2 === 0 ? { tipo: 'primeira_peca', aPartirDeVendas: (i + 1) * 5 } : { tipo: 'peca_periodica', aCadaDias: 30 },
    })),
  ];
  const r = levels.validarRegras({ niveis });
  assert.equal(r.niveis.length, 8);
  assert.deepEqual(r.niveis.map((n) => n.label), niveis.map((n) => n.label));
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
