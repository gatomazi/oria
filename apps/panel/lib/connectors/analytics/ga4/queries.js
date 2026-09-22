'use strict';

// Fase E · nomes e query da GA4 Data API confirmados na documentação oficial (§4.3/§14 do comando).
// `items*` são métricas de ITENS/UNIDADES — não usuários únicos, não contagem pura de evento — e o
// contrato normalizado (mapper.js) preserva esse nome em vez de renomear silenciosamente para algo
// genérico ("views", "purchases") que apagaria a distinção.

const DIMENSION_ITEM_ID = 'itemId';
const DIMENSION_ITEM_NAME = 'itemName';

// Ordem estável: é a mesma ordem em que os valores voltam em `row.metricValues[]`.
const METRICAS_PRODUTO = Object.freeze(['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue']);

// Página grande e segura (a Data API aceita até 250.000 linhas por request, mas o código nunca
// assume que 1 request basta — ver connector.js). Fica bem abaixo do teto documentado.
const LIMITE_PAGINA_PADRAO = 100000;

const NAO_DEFINIDO = '(not set)';

/**
 * `metricas`: subconjunto de METRICAS_PRODUTO realmente compatível com a propriedade (connector.js
 * decide isso via checkCompatibility antes de montar a query) — nunca pede métrica incompatível,
 * porque a Data API rejeita a query inteira se uma métrica não existir na propriedade.
 */
function reportRequestBody({ startDate, endDate, metricas, limit = LIMITE_PAGINA_PADRAO, offset = 0, comItemName = true }) {
  if (!startDate || !endDate) throw new TypeError('reportRequestBody exige startDate e endDate');
  if (!Array.isArray(metricas) || !metricas.length) throw new TypeError('reportRequestBody exige ao menos 1 métrica compatível');
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: DIMENSION_ITEM_ID }, ...(comItemName ? [{ name: DIMENSION_ITEM_NAME }] : [])],
    metrics: metricas.map((name) => ({ name })),
    limit,
    offset,
    returnPropertyQuota: true,
  };
}

function compatibilidadeRequestBody({ metricas = METRICAS_PRODUTO, comItemName = true } = {}) {
  return {
    dimensions: [DIMENSION_ITEM_ID, ...(comItemName ? [DIMENSION_ITEM_NAME] : [])],
    metrics: [...metricas],
  };
}

module.exports = {
  DIMENSION_ITEM_ID, DIMENSION_ITEM_NAME, METRICAS_PRODUTO, LIMITE_PAGINA_PADRAO, NAO_DEFINIDO,
  reportRequestBody, compatibilidadeRequestBody,
};
