'use strict';

// Consultas GAQL (lib/google-ads/queries.js).
//
// Este arquivo existe porque as consultas moravam dentro do server.js, fora do alcance de teste, e
// cada campo inventado só aparecia como erro em produção — um deploy por engano. Um campo que não
// existe derruba a consulta INTEIRA, não só a coluna dele: não há "no pior caso vem vazio".

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  METRICAS, CAMPOS_RECUSADOS, queryInsights, queryConta, queryContaCliente,
} = require('../lib/google-ads/queries');

// ── Campos ──────────────────────────────────────────────────────────────────────────────────

test('nenhum campo já recusado pela API volta para a consulta', () => {
  // metrics.video_views foi recusado pela v25 em 15/09/2026 e quebrou o sync inteiro.
  for (const nivel of ['customer', 'campaign']) {
    const q = queryInsights(nivel, '2026-09-01', '2026-09-15');
    for (const campo of CAMPOS_RECUSADOS) {
      assert.ok(!q.includes(campo), `${campo} voltou para a consulta de ${nivel}`);
    }
  }
});

test('a lista de métricas não contém nada marcado como recusado', () => {
  for (const m of METRICAS) assert.ok(!CAMPOS_RECUSADOS.has(m), `${m} está nas duas listas`);
});

test('as métricas de gasto e conversão estão todas presentes', () => {
  const q = queryInsights('customer', '2026-09-01', '2026-09-15');
  for (const campo of ['metrics.impressions', 'metrics.clicks', 'metrics.cost_micros',
    'metrics.conversions', 'metrics.conversions_value']) {
    assert.ok(q.includes(campo), `faltou ${campo}`);
  }
});

test('as duas réguas de conversão vêm juntas, para poder trocar sem re-sincronizar', () => {
  const q = queryInsights('customer', '2026-09-01', '2026-09-15');
  assert.ok(q.includes('metrics.all_conversions'));
  assert.ok(q.includes('metrics.conversions,'), 'a régua padrão continua sendo pedida');
});

// ── Estrutura ───────────────────────────────────────────────────────────────────────────────

test('sempre quebra por dia — sem isso não existe série diária', () => {
  // Sem segments.date a API devolve o período somado numa linha só.
  assert.ok(queryInsights('customer', '2026-09-01', '2026-09-15').includes('segments.date'));
  assert.ok(queryInsights('campaign', '2026-09-01', '2026-09-15').includes('segments.date'));
});

test('cada nível consulta o recurso certo e traz sua chave', () => {
  const conta = queryInsights('customer', '2026-09-01', '2026-09-15');
  assert.match(conta, /FROM customer\b/);
  assert.ok(conta.includes('customer.id'));

  const campanha = queryInsights('campaign', '2026-09-01', '2026-09-15');
  assert.match(campanha, /FROM campaign\b/);
  assert.ok(campanha.includes('campaign.id') && campanha.includes('campaign.name'),
    'sem o nome, a tela mostraria o ID da campanha');
});

test('o período entra como intervalo fechado', () => {
  assert.ok(queryInsights('customer', '2026-09-01', '2026-09-15')
    .includes("segments.date BETWEEN '2026-09-01' AND '2026-09-15'"));
});

test('nível desconhecido falha na hora, não vira consulta torta', () => {
  assert.throws(() => queryInsights('adgroup', '2026-09-01', '2026-09-15'), /nível desconhecido/);
});

// ── Datas ───────────────────────────────────────────────────────────────────────────────────

test('data fora do formato é recusada antes de virar string de consulta', () => {
  // As datas são concatenadas na query; validar o formato é o que garante que só data entra ali.
  assert.throws(() => queryInsights('customer', '01/09/2026', '2026-09-15'), /AAAA-MM-DD/);
  assert.throws(() => queryInsights('customer', '2026-09-01', "2026-09-15' OR '1'='1"), /AAAA-MM-DD/);
  assert.throws(() => queryInsights('customer', '', ''), /AAAA-MM-DD/);
});

// ── Consultas de conta ──────────────────────────────────────────────────────────────────────

test('a consulta de conta pede o que a tela mostra', () => {
  const q = queryConta();
  for (const campo of ['customer.descriptive_name', 'customer.currency_code', 'customer.time_zone']) {
    assert.ok(q.includes(campo), `faltou ${campo}`);
  }
});

test('customer_client filtra pela conta e aceita id formatado', () => {
  assert.ok(queryContaCliente('123-456-7890').includes('customer_client.id = 1234567890'),
    'a API exige o id sem hífen');
});

test('customer_client recusa id inválido em vez de montar consulta com lixo', () => {
  assert.throws(() => queryContaCliente('123'), /10 dígitos/);
  assert.throws(() => queryContaCliente('1; DROP TABLE'), /10 dígitos/);
});
