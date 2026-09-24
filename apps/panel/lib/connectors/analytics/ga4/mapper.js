'use strict';

// Fase E · GA4 runReport row → ProductAnalyticsRow (lib/connectors/types.js). A Data API devolve
// todo valor como STRING — nada aqui confia em coerção implícita.

const { METRICAS_PRODUTO, DIMENSOES_ACQUISITION, METRICAS_ACQUISITION, METRICAS_TRANSACTION, NAO_DEFINIDO } = require('./queries');

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

// Rodada K (Journey Analytics) · escopo SESSÃO, nunca item — `source`/`medium`/`campaign` cru da
// Data API, "(not set)" preservado como veio (nunca traduzido pra null: é o valor real que o GA4
// devolve pra sessão sem UTM manual nenhuma, e a UI/service decide o que fazer com ele — este mapper
// só traduz o formato, nunca decide semântica de aquisição).
const PARSERS_ACQUISITION = Object.freeze({ sessions: parseInteiro, ecommercePurchases: parseInteiro, totalRevenue: parseMonetario });

function mapAcquisitionRow(row) {
  if (!row || !Array.isArray(row.dimensionValues) || !Array.isArray(row.metricValues)) {
    throw new TypeError('mapAcquisitionRow exige dimensionValues e metricValues');
  }
  const [source, medium, campaign] = DIMENSOES_ACQUISITION.map((_, i) => row.dimensionValues[i] && row.dimensionValues[i].value);
  const metrics = Object.fromEntries(METRICAS_ACQUISITION.map((nome, i) => [nome, PARSERS_ACQUISITION[nome](row.metricValues[i] && row.metricValues[i].value, nome)]));
  return Object.freeze({ source: source ?? NAO_DEFINIDO, medium: medium ?? NAO_DEFINIDO, campaign: campaign ?? NAO_DEFINIDO, ...metrics });
}

function mapAcquisitionRows(rows) {
  return (rows || []).map(mapAcquisitionRow);
}

const PARSERS_TRANSACTION = Object.freeze({ transactions: parseInteiro, purchaseRevenue: parseMonetario });

// Rodada K · lookup pontual de transactionId: `rows` vazio significa "não encontrada" (não é erro —
// GA4 nunca viu esta transação, ou o navegador não emitiu `purchase` com este transaction_id, ou o
// período não cobre a data real da compra). Nunca inventa `found: true` por um valor parecido.
// Posição em `metricValues[]` = posição em METRICAS_TRANSACTION (mesma ordem do body em queries.js).
function mapTransactionLookup(rows) {
  const linhas = rows || [];
  if (!linhas.length) return Object.freeze({ found: false, transactions: null, revenue: null });
  const valores = linhas[0].metricValues || [];
  const [transactions, revenue] = METRICAS_TRANSACTION.map((nome, i) => PARSERS_TRANSACTION[nome](valores[i] && valores[i].value, nome));
  return Object.freeze({ found: true, transactions, revenue });
}

module.exports = {
  Ga4MetricParseError, parseInteiro, parseMonetario, ehItemIdValido, mapRow, mapReportRows,
  mapAcquisitionRow, mapAcquisitionRows, mapTransactionLookup,
};
