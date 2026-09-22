'use strict';

// Fase E · GA4 runReport row → ProductAnalyticsRow (lib/connectors/types.js). A Data API devolve
// todo valor como STRING — nada aqui confia em coerção implícita.

const { METRICAS_PRODUTO, NAO_DEFINIDO } = require('./queries');

class Ga4MetricParseError extends Error {
  constructor(campo, bruto) {
    super(`métrica GA4 "${campo}" veio ilegível: ${JSON.stringify(bruto)}`);
    this.name = 'Ga4MetricParseError';
    this.codigo = 'GA4_METRIC_UNPARSEABLE';
  }
}

// Inteiro (itemsViewed, itemsAddedToCart, itemsCheckedOut, itemsPurchased): sem casa decimal,
// sem negativo — a Data API não documenta contagem negativa; se aparecer, é dado corrompido, não
// "zero criativo".
// `Number('')` e `Number(' ')` são 0 em JS — exatamente o "passa silencioso" que isto existe para
// impedir. String vazia/só espaço é tratada como valor ilegível, nunca como zero.
function textoNumericoValido(bruto) {
  return typeof bruto === 'string' && bruto.trim() !== '';
}

function parseInteiro(bruto, campo) {
  if (bruto === null || bruto === undefined) return null;
  if (!textoNumericoValido(bruto)) throw new Ga4MetricParseError(campo, bruto);
  const n = Number(bruto);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) throw new Ga4MetricParseError(campo, bruto);
  return n;
}

// Monetário (itemRevenue): decimal, não negativo. Mesma convenção do restante do backend (Number
// para valor de moeda — ver server.js/lib/meta — não Decimal/BigInt; documentado aqui porque é a
// primeira vez que este módulo decide).
function parseMonetario(bruto, campo) {
  if (bruto === null || bruto === undefined) return null;
  if (!textoNumericoValido(bruto)) throw new Ga4MetricParseError(campo, bruto);
  const n = Number(bruto);
  if (!Number.isFinite(n) || n < 0) throw new Ga4MetricParseError(campo, bruto);
  return n;
}

const PARSERS = Object.freeze({
  itemsViewed: parseInteiro, itemsAddedToCart: parseInteiro, itemsCheckedOut: parseInteiro, itemsPurchased: parseInteiro,
  itemRevenue: parseMonetario,
});

function ehItemIdValido(valor) {
  const v = String(valor ?? '').trim();
  return v !== '' && v !== NAO_DEFINIDO;
}

/**
 * @param {Object} row  item de `runReport.rows[]`: `{dimensionValues:[...], metricValues:[...]}`
 * @param {{metricasPedidas: string[], comItemName: boolean}} contexto
 *   `metricasPedidas`: a ordem EXATA usada em `queries.reportRequestBody` — decide a posição de
 *   cada valor em `metricValues[]`. Métrica fora deste conjunto (incompatível na propriedade) mapeia
 *   para `null` — nunca zero inventado (§4.6).
 * @returns {{row: import('../../types').ProductAnalyticsRow|null, skipped: 'empty_item_id'|null}}
 */
function mapRow(row, { metricasPedidas, comItemName = true }) {
  if (!row || !Array.isArray(row.dimensionValues) || !Array.isArray(row.metricValues)) {
    throw new TypeError('mapRow exige dimensionValues e metricValues');
  }
  const itemId = row.dimensionValues[0] && row.dimensionValues[0].value;
  if (!ehItemIdValido(itemId)) return { row: null, skipped: 'empty_item_id' };
  const itemName = comItemName ? (row.dimensionValues[1] && row.dimensionValues[1].value) || null : null;

  const valores = Object.fromEntries(metricasPedidas.map((nome, i) => [nome, row.metricValues[i] && row.metricValues[i].value]));
  const metrics = {};
  for (const nome of METRICAS_PRODUTO) {
    metrics[nome] = Object.hasOwn(valores, nome) ? PARSERS[nome](valores[nome], nome) : null; // não pedida = null, não 0
  }

  return {
    row: Object.freeze({
      externalProductId: String(itemId),
      externalProductName: itemName, // diagnóstico/display — NUNCA identidade (§4.4)
      ...metrics,
      analyticsProvider: 'ga4',
    }),
    skipped: null,
  };
}

/**
 * Mapeia `runReport.rows` inteiro. Devolve as linhas válidas + a contagem do que foi descartado por
 * itemId vazio/"(not set)" — contabilizado, nunca silenciosamente sumido (§4.12).
 */
function mapReportRows(rows, contexto) {
  const linhas = [];
  let itemIdVazioOuNaoDefinido = 0;
  for (const r of rows || []) {
    const { row, skipped } = mapRow(r, contexto);
    if (row) linhas.push(row);
    else if (skipped === 'empty_item_id') itemIdVazioOuNaoDefinido += 1;
  }
  return { linhas, itemIdVazioOuNaoDefinido };
}

module.exports = { Ga4MetricParseError, parseInteiro, parseMonetario, ehItemIdValido, mapRow, mapReportRows };
