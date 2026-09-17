'use strict';

// Fase 5 (docs/meta-ads-analytics-integracao-v2.md §53A-53AC, §76). O que está sob teste aqui não é
// aritmética — é a separação entre FINANCEIRO e ATRIBUIÇÃO, que a spec §53D trata como premissa
// central e cujo desrespeito produz lucro inflado.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  totalizarMidia, montarResultado, mer, roasDeMargem, resultadoPorRealDeMidia,
  breakEvenRoas, blendedCac, avaliarQualidade, compararAtribuicao, QUALIDADE,
} = require('../lib/financeiro/consolidado');

// Exemplo da própria spec §53K, pra a conta poder ser conferida contra o documento.
const LOJA = { receita: 10000, custoProducao: 6000, lucroProduto: 4000, pedidos: 100 };

// ── Resultado progressivo ───────────────────────────────────────────────────────────────────

test('o gasto de mídia é descontado UMA vez, no nível de aquisição', () => {
  const r = montarResultado({ loja: LOJA, midia: { total: 2000, porProvedor: { meta: 2000 } }, despesas: {} });
  assert.equal(r.lucroProduto, 4000, 'produção sai no nível 2');
  assert.equal(r.lucroAposMidia, 2000, 'mídia sai no nível 3, e só aí');
  // O erro que a spec §53E descreve: descontar mídia no pedido E no período. Se isso acontecesse,
  // lucroAposMidia seria 0 ou negativo aqui.
  assert.equal(r.lucroProduto - r.totalMidia, r.lucroAposMidia);
});

test('Lucro do Produto vem da Ink quando existe, não é recalculado', () => {
  // kickback_value da Ink já é líquido de desconto; recalcular como receita − custo daria outro
  // número em pedido com promoção.
  const r = montarResultado({ loja: { receita: 109.33, custoProducao: 49.90, lucroProduto: 49.01, pedidos: 1 }, midia: {}, despesas: {} });
  assert.equal(r.lucroProduto, 49.01, 'não é 59.43 (= receita − custo), que ignoraria a promoção');
});

test('sem Lucro do Produto informado, cai para receita menos custo', () => {
  const r = montarResultado({ loja: { receita: 1000, custoProducao: 600, pedidos: 10 }, midia: {}, despesas: {} });
  assert.equal(r.lucroProduto, 400);
});

test('sem despesas cadastradas, Lucro Operacional é desconhecido — não igual ao lucro após mídia', () => {
  const r = montarResultado({ loja: LOJA, midia: { total: 2000 }, despesas: {} });
  assert.equal(r.lucroAposMidia, 2000);
  assert.equal(r.lucroOperacional, null, 'null obriga a tela a dizer que não sabe (spec §53AB)');
  assert.equal(r.margemOperacional, null);
});

test('com despesas, o nível 4 fecha', () => {
  const r = montarResultado({ loja: LOJA, midia: { total: 2000 }, despesas: { total: 500 } });
  assert.equal(r.lucroOperacional, 1500);
  assert.equal(r.margemOperacional, 15);
});

test('margens são percentuais sobre a receita real', () => {
  const r = montarResultado({ loja: LOJA, midia: { total: 2000 }, despesas: {} });
  assert.equal(r.margemProduto, 40);
  assert.equal(r.margemAposMidia, 20);
  assert.equal(r.ticketMedio, 100);
});

test('período sem receita não explode nem inventa margem', () => {
  const r = montarResultado({ loja: { receita: 0, custoProducao: 0, pedidos: 0 }, midia: { total: 0 }, despesas: {} });
  assert.equal(r.margemProduto, null);
  assert.equal(r.ticketMedio, null);
});

// ── Total de mídia, provider-agnostic ───────────────────────────────────────────────────────

test('soma os provedores conectados e REPORTA os que faltam', () => {
  const t = totalizarMidia([
    { provider: 'meta', spend: 2000, conectado: true },
    { provider: 'google_ads', spend: null, conectado: false },
  ]);
  assert.equal(t.total, 2000);
  assert.deepEqual(t.porProvedor, { meta: 2000 });
  assert.deepEqual(t.faltando, ['google_ads'], 'não conectado não vira zero silencioso (spec §53AA)');
});

test('Google Ads entra no total sem mudar fórmula nenhuma', () => {
  // O teste do §53P: a camada tem que aceitar o provedor novo como mais uma linha.
  const t = totalizarMidia([
    { provider: 'meta', spend: 2000, conectado: true },
    { provider: 'google_ads', spend: 500, conectado: true },
  ]);
  assert.equal(t.total, 2500);
  assert.deepEqual(t.faltando, []);
  assert.equal(mer(10000, t.total), 4, 'exemplo da spec §53I: 10.000 / 2.500 = 4,0x');
});

// ── Indicadores ─────────────────────────────────────────────────────────────────────────────

test('MER usa receita real, nunca receita atribuída', () => {
  // Se alguém trocasse o numerador pela receita atribuída da Meta, o MER deixaria de ser
  // independente de atribuição — que é a única razão dele existir (spec §53I).
  assert.equal(mer(10000, 2500), 4);
  assert.equal(mer(10000, 0), null, 'sem mídia não há MER, e não é infinito');
});

test('ROAS de margem e ROAS de receita contam histórias diferentes', () => {
  // Exemplo literal da spec §53K: receita 10.000, produção 6.000, mídia 2.000.
  assert.equal(mer(10000, 2000), 5, 'ROAS de receita 5,0x');
  assert.equal(roasDeMargem(4000, 2000), 2, 'ROAS de margem 2,0x — o que de fato sobrou por real investido');
});

test('resultado por real de mídia é diferente de ROAS', () => {
  assert.equal(resultadoPorRealDeMidia(2000, 2000), 1);
});

test('break-even ROAS sai da margem real, não de um palpite', () => {
  assert.equal(breakEvenRoas(40), 2.5, 'exemplo da spec §53M: 1 / 0,40 = 2,5x');
  assert.equal(breakEvenRoas(0), null, 'margem zero não tem break-even calculável');
  assert.equal(breakEvenRoas(-10), null, 'margem negativa idem');
  assert.equal(breakEvenRoas(null), null);
});

test('Blended CAC considera TODOS os pedidos, inclusive orgânicos', () => {
  assert.equal(blendedCac(2500, 100), 25);
  assert.equal(blendedCac(2500, 0), null);
});

// ── Qualidade do dado ───────────────────────────────────────────────────────────────────────

test('cobertura parcial diz quantos pedidos o resultado representa, e o que fazer', () => {
  // A primeira versão dizia "o lucro aparece maior que o real" — direção errada, descoberta em
  // produção: com receita de 377 pedidos e custo de 55, a margem saía MENOR (6% em vez de ~45%).
  const q = avaliarQualidade({ pedidos: 100, pedidosSemFinanceiro: 12, provedoresFaltando: [], despesasCadastradas: true, midiaSincronizadaEm: '2026-09-15' });
  assert.equal(q.nivel, QUALIDADE.PARCIAL);
  assert.match(q.avisos[0], /cobre 88 de 100/);
  assert.match(q.avisos[0], /backfill/, 'o aviso precisa dizer o que fazer, não só o que está faltando');
});

test('provedor não conectado vira aviso nomeado, não silêncio', () => {
  const q = avaliarQualidade({ pedidos: 10, provedoresFaltando: ['google_ads'], despesasCadastradas: true, midiaSincronizadaEm: 'x' });
  assert.equal(q.nivel, QUALIDADE.PARCIAL);
  assert.match(q.avisos[0], /Google Ads/);
});

test('tudo presente é completo; sem pedido é sem dado', () => {
  assert.equal(avaliarQualidade({ pedidos: 10, despesasCadastradas: true, midiaSincronizadaEm: 'x' }).nivel, QUALIDADE.COMPLETO);
  assert.equal(avaliarQualidade({ pedidos: 0 }).nivel, QUALIDADE.SEM_DADO);
});

// ── Atribuição ──────────────────────────────────────────────────────────────────────────────

test('as três fontes aparecem separadas, e o que não é medido vem null', () => {
  const linhas = compararAtribuicao({
    loja: { pedidos: 23, receita: 3120 },
    meta: { purchases: 21, purchaseValue: 2840, clicks: 2104 },
    ga4: { purchases: 18, revenue: 2410, sessions: 1842 },
  });
  assert.deepEqual(linhas.map((l) => l.origem), ['loja', 'meta', 'ga4']);
  // A spec §54 é explícita: não mostrar campo não equivalente como se fosse igual. A Meta não tem
  // sessão e o GA4 não tem clique de anúncio — os dois vêm null, nunca zero.
  assert.equal(linhas[1].sessoes, null, 'Meta não mede sessão');
  assert.equal(linhas[2].cliques, null, 'GA4 não mede clique de anúncio');
  assert.equal(linhas[0].receita, 3120);
  assert.equal(linhas[1].receita, 2840);
  assert.equal(linhas[2].receita, 2410);
});

test('fonte ausente não vira linha zerada', () => {
  const linhas = compararAtribuicao({ loja: { pedidos: 5, receita: 500 }, meta: null, ga4: null });
  assert.equal(linhas[1].receita, null, 'Meta desconectada é "não sei", não "vendeu zero"');
  assert.equal(linhas[2].receita, null);
});

test('despesa cadastrada que não incide no período vira aviso, não silêncio', () => {
  // Uma mensalidade é lançada no dia da cobrança. Consultar um dia que não é esse dá total zero, e
  // o Lucro Operacional fica igual ao Lucro após Mídia — certo na conta, enganoso na leitura.
  const q = avaliarQualidade({ pedidos: 10, despesasCadastradas: true, despesasNoPeriodo: 0, midiaSincronizadaEm: 'x' });
  assert.equal(q.nivel, QUALIDADE.PARCIAL);
  assert.match(q.avisos[0], /não inclui custos fixos/);
});

test('despesa que incide no período não gera aviso', () => {
  const q = avaliarQualidade({ pedidos: 10, despesasCadastradas: true, despesasNoPeriodo: 1500, midiaSincronizadaEm: 'x' });
  assert.equal(q.nivel, QUALIDADE.COMPLETO);
});

test('cobertura parcial suprime absolutos derivados da margem, mas mantém a taxa', () => {
  // Margem de um recorte (55 de 377 pedidos) menos o gasto de mídia de TODO o tráfego dá um
  // prejuízo que não existe. Foi o que apareceu em produção: -R$ 16.588 de "Lucro após Mídia".
  const r = montarResultado({
    loja: { receita: 8967.75, custoProducao: 3664.10, lucroProduto: 4054.60, pedidos: 55 },
    midia: { total: 20379.38 }, despesas: {}, coberturaCompleta: false,
  });
  assert.ok(Math.abs(r.margemProduto - 45.21) < 0.1, 'a taxa do recorte é válida e fica');
  assert.equal(r.lucroAposMidia, null, 'o absoluto não: seria um prejuízo inventado');
  assert.equal(r.margemAposMidia, null);
  assert.equal(r.lucroOperacional, null);
});

test('cobertura completa calcula tudo normalmente', () => {
  const r = montarResultado({ loja: LOJA, midia: { total: 2000 }, despesas: {}, coberturaCompleta: true });
  assert.equal(r.lucroAposMidia, 2000);
  assert.equal(r.margemAposMidia, 20);
});

test('provedor que a loja não usa não vira aviso fixo', () => {
  // Repetir "Google Ads não conectado" em toda consulta de quem só anuncia na Meta é ruído fixo no
  // topo da tela — e ruído fixo é ruído ignorado, inclusive quando virar aviso de verdade.
  const t = totalizarMidia([
    { provider: 'meta', spend: 2000, conectado: true },
    { provider: 'google_ads', spend: null, conectado: false, relevante: false },
  ]);
  assert.equal(t.total, 2000);
  assert.deepEqual(t.faltando, [], 'canal nunca usado não é lacuna');
});

test('mas quem anuncia no Google e não conectou continua sendo avisado', () => {
  const t = totalizarMidia([
    { provider: 'meta', spend: 2000, conectado: true },
    { provider: 'google_ads', spend: null, conectado: false, relevante: true },
  ]);
  assert.deepEqual(t.faltando, ['google_ads']);
});
