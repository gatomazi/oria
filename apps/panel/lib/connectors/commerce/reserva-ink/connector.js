'use strict';

// Fase C · ReservaInkCommerceConnector — implementa o contrato `commerce` de lib/connectors/contracts.js.
//
// Fluxo de credencial (Fases B, B.1 e C, nesta ordem, sempre):
//
//   ConnectorContext → resolveIntegration() → ResolvedIntegration → ConnectorSecretPort.use('api_token', …) → InkClient
//
// O connector NUNCA importa `lib/platform/integrations.js` (o resolver legado, com fallback de
// env) nem lê `process.env`: a única credencial que ele conhece é a que `secretPort` entrega, já
// ligada à Organization/Store do próprio `context`. Isto é o Ink como `CommerceConnector` puro —
// nenhuma regra de "loja piloto", nenhum `if (store nativa)`, nenhum caminho especial.

const { createInkClient, InkApiError } = require('./client');
const { mapProduct, mapVariants } = require('./mapper');

// §9: capability true só quando o método correspondente está implementado de verdade.
//   products              → listProducts, getProduct            implementados
//   variants              → listProductVariants                 implementado (escopo: por produto — ver abaixo)
//   productsWithVariants  → listProductsWithVariants (Fase D)    a MESMA chamada de listProducts: a
//                           Ink já manda `product_variants[]` dentro de cada produto da listagem —
//                           nunca 1 chamada de variantes por produto
//   orders, refunds, productCosts → fora desta fase
const CAPABILITIES = Object.freeze({
  products: true, variants: true, productsWithVariants: true, orders: false, refunds: false, productCosts: false,
});
const MAX_PER_PAGE = 100;
const PROVIDER_PRODUCT_ID_RE = /^[0-9]+$/; // a Ink usa inteiro; o connector aceita a forma texto do contrato canônico

function normalizarErro(err) {
  if (err instanceof InkApiError) return err;
  throw err; // erro de rede/timeout/programação: sobe como está, não é reescrito para parecer InkApiError
}

function validarProviderProductId(valor, quem) {
  if (typeof valor !== 'string' || !PROVIDER_PRODUCT_ID_RE.test(valor)) {
    throw new TypeError(`${quem} exige providerProductId (o id numérico da Ink, como texto)`);
  }
  return valor;
}

/**
 * @param {{context: Object, resolveIntegration: Function, secretPort: Object, fetchImpl?: Function}} deps
 *   `secretPort`: instância de `createConnectorSecretPort` (Fase C) — NÃO ligada ainda; o connector
 *   liga em cada chamada (`secretPort.forIntegration(context, integration)`) porque a integração só
 *   é conhecida depois de `resolveIntegration()`.
 * @returns {import('../../types').CommerceConnector}
 */
function createReservaInkCommerceConnector({ context, resolveIntegration, secretPort, fetchImpl }) {
  if (typeof resolveIntegration !== 'function') throw new Error('createReservaInkCommerceConnector exige resolveIntegration');
  if (!secretPort || typeof secretPort.forIntegration !== 'function') throw new Error('createReservaInkCommerceConnector exige secretPort');

  // Uma chamada Ink por invocação de método: resolve a integração e o token na hora, nunca guarda
  // token em variável do módulo/closure de longa duração.
  async function clienteDaChamada() {
    const integration = await resolveIntegration();
    const secrets = secretPort.forIntegration(context, integration);
    return createInkClient({ obterToken: (usar) => secrets.use('api_token', usar), fetchImpl });
  }

  // Uma única chamada por página, compartilhada por listProducts e listProductsWithVariants: o
  // payload de `GET /v1/stores/products` já traz `product_variants[]` em cada item — o que muda
  // entre os dois métodos é só o que o mapper aproveita da MESMA resposta, nunca uma segunda
  // chamada. É o que impede o full catalog sync (lib/product-analytics/catalog-sync.js) de fazer
  // 1 GET de variantes por produto.
  async function buscarPaginaDeProdutos({ cursor, limit } = {}) {
    const page = cursor === undefined || cursor === null ? 1 : Number(cursor);
    if (!Number.isInteger(page) || page < 1) throw new TypeError('cursor inválido');
    const perPage = Math.min(Math.max(Number.isFinite(Number(limit)) && limit ? Number(limit) : MAX_PER_PAGE, 1), MAX_PER_PAGE);
    const cliente = await clienteDaChamada();
    let data;
    try {
      data = await cliente.get(`/v1/stores/products?page=${page}&per_page=${perPage}`);
    } catch (err) {
      throw normalizarErro(err);
    }
    const produtosBrutos = data.products || [];
    const totalPages = data.total_pages || 1;
    return { produtosBrutos, nextCursor: page < totalPages ? String(page + 1) : null };
  }

  async function listProducts(entrada = {}) {
    const { produtosBrutos, nextCursor } = await buscarPaginaDeProdutos(entrada);
    return Object.freeze({ items: produtosBrutos.map((p) => mapProduct(p, context)), nextCursor });
  }

  async function listProductsWithVariants(entrada = {}) {
    const { produtosBrutos, nextCursor } = await buscarPaginaDeProdutos(entrada);
    const items = produtosBrutos.map((p) => Object.freeze({ product: mapProduct(p, context), variants: mapVariants(p, context) }));
    return Object.freeze({ items, nextCursor });
  }

  async function getProduct({ providerProductId } = {}) {
    validarProviderProductId(providerProductId, 'getProduct');
    const cliente = await clienteDaChamada();
    let data;
    try {
      data = await cliente.get(`/v1/stores/products/${encodeURIComponent(providerProductId)}`);
    } catch (err) {
      if (err instanceof InkApiError && err.status === 404) return null;
      throw normalizarErro(err);
    }
    return data.product ? mapProduct(data.product, context) : null;
  }

  // A Ink não documenta um endpoint que liste variantes fora de um produto: elas vêm embutidas em
  // `GET /v1/stores/products/{id}`. `providerProductId` é por isso obrigatório aqui — capability
  // `variants: true` descreve o que o método FAZ, não uma listagem geral que a Ink não oferece.
  async function listProductVariants({ providerProductId, cursor = null } = {}) {
    validarProviderProductId(providerProductId, 'listProductVariants');
    if (cursor) return Object.freeze({ items: [], nextCursor: null }); // tudo já veio na primeira página
    const cliente = await clienteDaChamada();
    let data;
    try {
      data = await cliente.get(`/v1/stores/products/${encodeURIComponent(providerProductId)}`);
    } catch (err) {
      if (err instanceof InkApiError && err.status === 404) return Object.freeze({ items: [], nextCursor: null });
      throw normalizarErro(err);
    }
    if (!data.product) return Object.freeze({ items: [], nextCursor: null });
    return Object.freeze({ items: mapVariants(data.product, context), nextCursor: null });
  }

  return Object.freeze({ listProducts, getProduct, listProductVariants, listProductsWithVariants });
}

module.exports = { createReservaInkCommerceConnector, CAPABILITIES };
