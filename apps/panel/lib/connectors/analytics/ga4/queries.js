'use strict';

// Fase E · nomes e query da GA4 Data API confirmados na documentação oficial (§4.3/§14 do comando).
// `items*` são métricas de ITENS/UNIDADES — não usuários únicos, não contagem pura de evento — e o
// contrato normalizado (mapper.js) preserva esse nome em vez de renomear silenciosamente para algo
// genérico ("views", "purchases") que apagaria a distinção.

const DIMENSION_ITEM_ID = 'itemId';
const DIMENSION_ITEM_NAME = 'itemName';

// Ordem estável: é a mesma ordem em que os valores voltam em `row.metricValues[]`.
const METRICAS_PRODUTO = Object.freeze(['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue']);

// Rodada K (Journey Analytics) · dimensões de AQUISIÇÃO (escopo sessão, nunca item) — os mesmos
// nomes `sessionManual*` que o UTM Tracker legado (server.js, docs/claude-utm-tracker-ga4.md §16-21)
// já usa em produção contra a propriedade real do piloto: reaproveitar o conjunto PROVADO compatível
// em vez de inventar `sessionSource`/`sessionDefaultChannelGroup` sem nenhuma evidência de que a
// propriedade os aceita (comando: "não presuma compatibilidade sem evidência"). A compatibilidade
// real de CADA propriedade ainda passa por checkCompatibility antes de qualquer report — isto aqui é
// só o vocabulário candidato, nunca a confirmação.
const DIMENSAO_ACQ_SOURCE = 'sessionManualSource';
const DIMENSAO_ACQ_MEDIUM = 'sessionManualMedium';
const DIMENSAO_ACQ_CAMPAIGN = 'sessionManualCampaignName';
const DIMENSOES_ACQUISITION = Object.freeze([DIMENSAO_ACQ_SOURCE, DIMENSAO_ACQ_MEDIUM, DIMENSAO_ACQ_CAMPAIGN]);
const METRICAS_ACQUISITION = Object.freeze(['sessions', 'ecommercePurchases', 'totalRevenue']);

// Rodada K · dimensão de TRANSAÇÃO — nunca usada em nenhum report agregado (explodiria cardinalidade
// e cota); só em `transactionLookupRequestBody`, sempre com `dimensionFilter` fixando 1 transactionId
// por chamada (verificação pontual "esta transação existe no GA4?", nunca uma listagem).
const DIMENSION_TRANSACTION_ID = 'transactionId';
const METRICAS_TRANSACTION = Object.freeze(['transactions', 'purchaseRevenue']);

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

// Rodada K · relatório de aquisição para o período inteiro — 1 chamada (paginada como o report de
// item), nunca 1 por canal/campanha. Escopo SESSÃO: nunca combinado com `itemId` na mesma query (são
// escopos diferentes na Data API — misturar devolveria incompatibilidade ou um cross-join sem
// sentido); por isso é um `runReport` À PARTE do relatório de produto.
function acquisitionRequestBody({ startDate, endDate, limit = LIMITE_PAGINA_PADRAO, offset = 0 }) {
  if (!startDate || !endDate) throw new TypeError('acquisitionRequestBody exige startDate e endDate');
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: DIMENSOES_ACQUISITION.map((name) => ({ name })),
    metrics: METRICAS_ACQUISITION.map((name) => ({ name })),
    limit,
    offset,
    returnPropertyQuota: true,
  };
}

function acquisitionCompatibilityRequestBody() {
  return { dimensions: [...DIMENSOES_ACQUISITION], metrics: [...METRICAS_ACQUISITION] };
}

function transactionCompatibilityRequestBody() {
  return { dimensions: [DIMENSION_TRANSACTION_ID], metrics: [...METRICAS_TRANSACTION] };
}

// Rodada K · verificação PONTUAL de 1 transactionId (nunca uma listagem: `dimensionFilter` EXACT
// fixa a única linha possível) — é como o connector verifica "este pedido do Commerce apareceu no
// GA4?" sem varrer o relatório inteiro procurando um id.
function transactionLookupRequestBody({ startDate, endDate, transactionId }) {
  if (!startDate || !endDate) throw new TypeError('transactionLookupRequestBody exige startDate e endDate');
  if (!transactionId) throw new TypeError('transactionLookupRequestBody exige transactionId');
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: DIMENSION_TRANSACTION_ID }],
    metrics: METRICAS_TRANSACTION.map((name) => ({ name })),
    dimensionFilter: {
      filter: { fieldName: DIMENSION_TRANSACTION_ID, stringFilter: { matchType: 'EXACT', value: String(transactionId) } },
    },
    limit: 1,
  };
}

module.exports = {
  DIMENSION_ITEM_ID, DIMENSION_ITEM_NAME, METRICAS_PRODUTO, LIMITE_PAGINA_PADRAO, NAO_DEFINIDO,
  DIMENSOES_ACQUISITION, METRICAS_ACQUISITION, DIMENSION_TRANSACTION_ID, METRICAS_TRANSACTION,
  reportRequestBody, compatibilidadeRequestBody,
  acquisitionRequestBody, acquisitionCompatibilityRequestBody,
  transactionCompatibilityRequestBody, transactionLookupRequestBody,
};
