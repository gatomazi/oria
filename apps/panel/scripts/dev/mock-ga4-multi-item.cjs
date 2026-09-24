'use strict';

// Gate F ("Jornada de Valor") · wrapper de DEMONSTRAÇÃO LOCAL em volta de
// test/helpers/provider-mock.cjs — nunca usado por teste automatizado, só pelo smoke local
// scripts/dev/smoke-jornada-oportunidades-local.cjs. Nunca toca o arquivo compartilhado: carrega-o
// primeiro (ele reescreve globalThis.fetch) e depois embrulha o resultado, interceptando só o
// runReport item-scoped da property MÁGICA abaixo — qualquer outra chamada (OAuth, property list,
// Ink, Meta) cai no mock compartilhado sem mudança nenhuma.
//
// Existe porque o mock compartilhado devolve sempre 1 produto só por property (prova suficiente
// pros testes automatizados, que checam wiring/contrato) — Opportunity Diagnostics só produz um
// sinal REAL com uma Store de vários produtos pra calcular baseline/desvio contra. Números abaixo
// são fabricados pra demonstração local; nunca confundir com dado de produção.
require('../../test/helpers/provider-mock.cjs'); // já reescreveu globalThis.fetch

const PROPERTY_MULTI = '9990001';
const original = globalThis.fetch;

// itemsViewed, itemsAddedToCart, itemsCheckedOut, itemsPurchased, itemRevenue — mesma ordem que o
// mock compartilhado usa pro item-scoped.
const PRODUTOS_DEMO = [
  { id: 'saudavel-1', name: 'Camiseta Alfa', m: [4000, 800, 400, 200, 19800] },
  { id: 'saudavel-2', name: 'Camiseta Beta', m: [3200, 640, 320, 160, 15800] },
  { id: 'saudavel-3', name: 'Bermuda Gama', m: [2600, 520, 260, 130, 12900] },
  { id: 'saudavel-4', name: 'Jaqueta Delta', m: [2100, 420, 210, 105, 10400] },
  { id: 'saudavel-5', name: 'Boné Épsilon', m: [1800, 360, 180, 90, 8900] },
  // Sinal 1 (low_view_to_cart): muita visualização, quase nada de carrinho.
  { id: 'baixa-conversao', name: 'Moletom Zeta (baixa conversão)', m: [5000, 40, 20, 8, 790] },
  // Sinal 2 (low_cart_to_checkout): carrinho saudável, checkout muito abaixo do baseline.
  { id: 'fricção-frete', name: 'Tênis Theta (fricção pós-carrinho)', m: [2000, 900, 90, 45, 4400] },
];

globalThis.fetch = async (input, init) => {
  const urlStr = typeof input === 'string' ? input : input.url;
  if (urlStr.includes('analyticsdata.googleapis.com') && urlStr.includes(`properties/${PROPERTY_MULTI}:runReport`)) {
    let corpoJson = {};
    try { corpoJson = JSON.parse(init?.body || '{}'); } catch { /* corpo não é JSON */ }
    const dimNomes = (corpoJson.dimensions || []).map((d) => d.name);
    if (dimNomes.includes('itemId')) {
      const rows = PRODUTOS_DEMO.map((p) => ({
        dimensionValues: [{ value: `sku-demo-${p.id}` }, { value: p.name }],
        metricValues: p.m.map((v) => ({ value: String(v) })),
      }));
      return new Response(JSON.stringify({ rows, rowCount: rows.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }
  return original(input, init);
};

module.exports = { PROPERTY_MULTI, PRODUTOS_DEMO };
