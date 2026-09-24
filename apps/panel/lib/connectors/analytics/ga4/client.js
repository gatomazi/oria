'use strict';

// Fase E · cliente da GA4 Data API v1beta (§4.2/§14 do comando). Só os três métodos que o Product
// Analytics precisa: `runReport` (relatório agregado), `getMetadata` (o que a propriedade EXPÕE) e
// `checkCompatibility` (se ESTA combinação de dimensão+métricas é consultável junto). Nenhuma
// chamada por produto — sempre 1 report para o período inteiro (§4.9).
//
// O token nunca é parâmetro por fora deste módulo: `obterToken(usar)` é o mesmo desenho do client
// da Ink (Fase C) — quem entrega o token decide o escopo de vida dele, o client nunca guarda.

const { fetchGoogle, erroGoogle } = require('../../../google/http');

const GA_DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

/**
 * @param {{obterToken: (usar: (token: string) => Promise<Response>) => Promise<Response>, baseUrl?: string, fetchImpl?: Function}} opcoes
 */
function createGa4Client({ obterToken, baseUrl = GA_DATA_API, fetchImpl } = {}) {
  if (typeof obterToken !== 'function') throw new Error('createGa4Client exige obterToken');

  async function chamar(metodo, caminho, body, contexto) {
    const res = await obterToken((token) => fetchGoogle(`${baseUrl}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, { idempotente: true, fetchFn: fetchImpl }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw erroGoogle(res.status, data, contexto);
    return data;
  }

  return Object.freeze({
    // GET properties/{propertyId}/metadata — o que a propriedade tem, em bruto (dimensões e métricas
    // disponíveis). Diagnóstico "existe?", não "esta combinação funciona junto?" (isso é checkCompatibility).
    getMetadata: (propertyId) => chamar('GET', `/properties/${encodeURIComponent(propertyId)}/metadata`, undefined, 'metadata do GA4'),

    // POST properties/{propertyId}:checkCompatibility — se `dimensions`+`metrics` são consultáveis
    // JUNTOS nesta propriedade. É o que decide se `itemId + itemsViewed` existe de verdade (§4.6).
    checkCompatibility: (propertyId, { dimensions, metrics, dimensionFilter } = {}) => chamar(
      'POST', `/properties/${encodeURIComponent(propertyId)}:checkCompatibility`,
      { dimensions: (dimensions || []).map((name) => ({ name })), metrics: (metrics || []).map((name) => ({ name })), ...(dimensionFilter ? { dimensionFilter } : {}) },
      'compatibilidade do GA4'
    ),

    // POST properties/{propertyId}:runReport — 1 chamada por PÁGINA do relatório agregado, nunca por produto.
    runReport: (propertyId, body) => chamar('POST', `/properties/${encodeURIComponent(propertyId)}:runReport`, body, 'relatório do GA4'),
  });
}

module.exports = { createGa4Client, GA_DATA_API };
