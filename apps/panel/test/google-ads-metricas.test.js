'use strict';

// Métricas da Google Ads API (lib/google-ads/metricas.js).
//
// Cada teste aqui corresponde a um jeito de produzir um número PLAUSÍVEL e errado — que num painel
// financeiro é pior que um erro escandaloso, porque ninguém desconfia. Os três principais:
// micros tratados como moeda, conversão fracionária arredondada, e conversions somado com
// all_conversions.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deMicros, ehMicros, escolherConversao, normalizarLinha, totalizar, dividir, metricas,
  normalizarCustomerId, formatarCustomerId, parseConversoes,
} = require('../lib/google-ads/metricas');

// ── Micros ──────────────────────────────────────────────────────────────────────────────────

test('cost_micros vira moeda da conta', () => {
  // R$ 12,50 chega como 12500000. Sem dividir, o painel mostraria R$ 12.500.000,00 de gasto.
  assert.equal(deMicros(12500000), 12.5);
  assert.equal(deMicros('12500000'), 12.5, 'int64 chega como string no JSON');
});

test('micros ausente é null, não zero', () => {
  // Zero diria "não gastou"; null diz "não sei". Num gráfico de gasto diário isso é a diferença
  // entre um vale real e um buraco de dados.
  assert.equal(deMicros(null), null);
  assert.equal(deMicros(undefined), null);
  assert.equal(deMicros(''), null);
});

test('só os campos declarados são micros — conversions_value não é', () => {
  assert.equal(ehMicros('cost_micros'), true);
  assert.equal(ehMicros('average_cpc'), true);
  assert.equal(ehMicros('conversions_value'), false, 'é double em moeda da conta, não micros');
  assert.equal(ehMicros('conversions'), false);
});

// ── Conversão fracionária ───────────────────────────────────────────────────────────────────

test('conversão fracionária não é arredondada', () => {
  // Atribuição parcial faz uma venda valer 0,5 em cada um de dois anúncios. Arredondar perde venda.
  assert.equal(parseConversoes(0.5), 0.5);
  assert.equal(parseConversoes(3.75), 3.75);
});

test('soma de conversões fracionárias fecha no inteiro', () => {
  const t = totalizar([
    { impressoes: 0, cliques: 0, custo: 0, conversoes: 0.5, valorConversoes: 50 },
    { impressoes: 0, cliques: 0, custo: 0, conversoes: 0.5, valorConversoes: 50 },
  ]);
  assert.equal(t.conversoes, 1, 'duas metades são uma venda');
});

// ── conversions × all_conversions ───────────────────────────────────────────────────────────

test('escolhe uma contagem de conversão, nunca soma as duas', () => {
  // Mesmo erro que somar purchase com omni_purchase no Meta: duplica vendas que não existiram.
  const linha = {
    metrics: { conversions: 10, conversions_value: 1000, all_conversions: 14, all_conversions_value: 1400 },
  };
  assert.equal(escolherConversao(linha).conversoes, 10);
  assert.equal(escolherConversao(linha, 'all_conversions').conversoes, 14);
  assert.notEqual(escolherConversao(linha).conversoes, 24);
});

test('o padrão é conversions — o mesmo número que a interface do Google Ads mostra', () => {
  const linha = { metrics: { conversions: 10, all_conversions: 14 } };
  assert.equal(escolherConversao(linha).contagem, 'conversions');
});

test('valor acompanha a contagem escolhida, não mistura as duas', () => {
  const linha = {
    metrics: { conversions: 10, conversions_value: 1000, all_conversions: 14, all_conversions_value: 1400 },
  };
  const all = escolherConversao(linha, 'all_conversions');
  assert.equal(all.valorConversoes, 1400, 'ROAS com contagem de um e valor do outro é ficção');
});

// ── Linha ───────────────────────────────────────────────────────────────────────────────────

test('linha crua vira campos normalizados com o custo já em moeda', () => {
  const l = normalizarLinha({
    segments: { date: '2026-09-10' },
    metrics: { impressions: '1000', clicks: '17', cost_micros: '8500000', conversions: 2, conversions_value: 300 },
  });
  assert.equal(l.data, '2026-09-10');
  assert.equal(l.impressoes, 1000);
  assert.equal(l.cliques, 17);
  assert.equal(l.custo, 8.5);
  assert.equal(l.conversoes, 2);
  assert.equal(l.valorConversoes, 300);
});

test('campanha sem vídeo devolve null em videoViews, não zero', () => {
  // "0 visualizações" sugere um vídeo que ninguém viu; o certo é não existir vídeo nenhum.
  const l = normalizarLinha({ segments: { date: '2026-09-10' }, metrics: { impressions: 10 } });
  assert.equal(l.videoViews, null);
});

test('aceita metrics em camelCase, como alguns clientes devolvem', () => {
  const l = normalizarLinha({ metrics: { costMicros: '2000000', conversionsValue: 40, conversions: 1 } });
  assert.equal(l.custo, 2);
  assert.equal(l.valorConversoes, 40);
});

// ── Taxas recalculadas ──────────────────────────────────────────────────────────────────────

test('taxa é recalculada da soma, nunca é média das taxas diárias', () => {
  // Média de CTR de dois dias com volumes diferentes não é o CTR do período.
  const linhas = [
    { impressoes: 100, cliques: 10, custo: 5, conversoes: 1, valorConversoes: 100 },   // CTR 10%
    { impressoes: 900, cliques: 9, custo: 45, conversoes: 0, valorConversoes: 0 },     // CTR 1%
  ];
  const t = totalizar(linhas);
  assert.equal(t.impressoes, 1000);
  assert.equal(t.cliques, 19);
  assert.ok(Math.abs(t.ctr - 1.9) < 1e-9, 'CTR do período é 19/1000, não a média de 10% e 1%');
  assert.notEqual(Math.round(t.ctr * 100) / 100, 5.5, 'média simples daria 5,5%');
});

test('CTR sai em pontos, igual ao módulo do Meta', () => {
  // A API devolve fração (0,0171). As duas integrações caem no mesmo formatador do front, então
  // precisam falar a mesma unidade.
  assert.ok(Math.abs(metricas.ctr(171, 10000) - 1.71) < 1e-9);
});

test('ROAS usa valor de conversão sobre custo', () => {
  assert.equal(metricas.roas(2910, 1000), 2.91);
});

test('denominador zero devolve null, não zero nem Infinity', () => {
  assert.equal(metricas.ctr(0, 0), null);
  assert.equal(metricas.roas(100, 0), null, 'ROAS sem gasto não é infinito, é indefinido');
  assert.equal(metricas.cpa(50, 0), null, 'custo por conversão sem conversão não é R$ 0');
  assert.equal(dividir(1, 0), null);
});

test('totalização de lista vazia não inventa taxas', () => {
  const t = totalizar([]);
  assert.equal(t.custo, 0);
  assert.equal(t.ctr, null);
  assert.equal(t.roas, null);
});

test('videoViews só aparece se alguma linha tiver vídeo', () => {
  const semVideo = totalizar([{ impressoes: 10, cliques: 1, custo: 1, conversoes: 0, valorConversoes: 0, videoViews: null }]);
  assert.equal(semVideo.videoViews, null);
  const comVideo = totalizar([
    { impressoes: 10, cliques: 1, custo: 1, conversoes: 0, valorConversoes: 0, videoViews: 5 },
    { impressoes: 10, cliques: 1, custo: 1, conversoes: 0, valorConversoes: 0, videoViews: null },
  ]);
  assert.equal(comVideo.videoViews, 5);
});

// ── Customer ID ─────────────────────────────────────────────────────────────────────────────

test('aceita o customer id no formato que a interface mostra', () => {
  // O usuário copia "123-456-7890" da tela; a API exige "1234567890".
  assert.equal(normalizarCustomerId('123-456-7890'), '1234567890');
  assert.equal(normalizarCustomerId('1234567890'), '1234567890');
  assert.equal(normalizarCustomerId(' 123-456-7890 '), '1234567890');
});

test('recusa customer id que não tem 10 dígitos', () => {
  assert.equal(normalizarCustomerId('12345'), null);
  assert.equal(normalizarCustomerId('12345678901'), null);
  assert.equal(normalizarCustomerId(''), null);
  assert.equal(normalizarCustomerId(null), null);
});

test('formata de volta para exibir', () => {
  assert.equal(formatarCustomerId('1234567890'), '123-456-7890');
  assert.equal(formatarCustomerId('abc'), null);
});
