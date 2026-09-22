'use strict';

// Fase C · ReservaInkCommerceConnector fim a fim: registry (Fase B) → IntegrationResolver (B.1) →
// ConnectorSecretPort (C) → InkClient (C) → mapper (C), com Postgres falso e Ink falsa (fetchImpl).
// Também o comparativo pedido: o connector novo lê o MESMO dado que o handler legado
// (`mapProdutoSummary`, extraído de server.js sem alterá-lo) já usa, no mesmo produto Ink.
//
// Premissa: 1 Organization = 1 Store (ORIA-TENANCY-STORE-01). Sem banco.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createConnectorRegistry } = require('../lib/connectors/registry');
const { createConnectorIntegrationPort } = require('../lib/platform/connector-integration-port');
const { createConnectorSecretPort } = require('../lib/platform/connector-secret-port');
const { createSecretStore } = require('../lib/secrets/store');
const { createKeyring } = require('../lib/secrets/keyring');
const { comContexto } = require('../lib/platform/tenant-runtime');
const { createReservaInkCommerceDescriptor } = require('../lib/connectors/commerce/reserva-ink');
const { InkApiError } = require('../lib/connectors/commerce/reserva-ink/client');
const F = require('./helpers/connector-fakes');

const MESTRA = crypto.randomBytes(32).toString('base64');
const keyring = () => createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA });
const TOKEN = 'ink-tok-A-9f8e7d6c5b4a';

// ── Pool falso: `stores`, `integrations` e `integration_secrets` num só objeto em memória ──────
function poolCompleto({ lojas, integracoes, segredos = [] }) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql, params });
      if (/FROM stores/.test(sql)) return { rows: lojas.filter((l) => l.id === params[0] && l.organization_id === params[1]).map((l) => ({ id: l.id })) };
      if (/FROM integrations/.test(sql)) {
        const [org, provider, id] = params;
        return { rows: integracoes.filter((i) => i.organization_id === org && i.provider === provider && (id === undefined || String(i.id) === id) && i.escopo === null) };
      }
      if (/INSERT INTO integration_secrets/.test(sql)) {
        const [integrationId, organizationId, tipo, ciphertext, keyVersion, last4v, expiresAt] = params;
        let linha = segredos.find((l) => l.integration_id === integrationId && l.tipo === tipo);
        if (!linha) { linha = { id: String(segredos.length + 1), integration_id: integrationId, tipo }; segredos.push(linha); }
        Object.assign(linha, { organization_id: organizationId, ciphertext, key_version: keyVersion, last4: last4v, expires_at: expiresAt });
        return { rows: [{ id: linha.id, tipo, last4: linha.last4, key_version: linha.key_version, expires_at: linha.expires_at, rotated_at: new Date() }] };
      }
      if (/SELECT ciphertext, key_version, expires_at FROM integration_secrets/.test(sql)) {
        const [integrationId, tipo, organizationId] = params;
        const achada = segredos.find((l) => l.integration_id === integrationId && l.tipo === tipo && (organizationId === null || l.organization_id === organizationId));
        return { rows: achada ? [{ ciphertext: achada.ciphertext, key_version: achada.key_version, expires_at: achada.expires_at }] : [] };
      }
      throw new Error(`SQL inesperado no fake pool: ${sql}`);
    },
  };
}

async function montarAmbiente({ comSegredo = true } = {}) {
  const pool = poolCompleto({
    lojas: [{ id: F.STORE_A, organization_id: F.ORG_A }],
    integracoes: [{ id: F.INT_INK_A, organization_id: F.ORG_A, provider: 'ink', escopo: null, status: 'connected' }],
  });
  const kr = keyring();
  if (comSegredo) {
    await createSecretStore({ pool, keyring: kr }).gravar({ integrationId: F.INT_INK_A, organizationId: F.ORG_A, tipo: 'api_token', valor: TOKEN, contexto: 'ink-api-token-v1' });
  }
  const secretPort = createConnectorSecretPort({ pool, keyring: kr });
  const registry = createConnectorRegistry({ integrations: createConnectorIntegrationPort({ pool }) });
  let fetchImpl;
  registry.register(createReservaInkCommerceDescriptor({ secretPort, fetchImpl: (...a) => fetchImpl(...a) }));
  return { pool, registry, definirFetch: (fn) => { fetchImpl = fn; } };
}

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const emA = (fn) => comContexto({ organizationId: F.ORG_A, storeId: F.STORE_A, origem: 'teste' }, fn);
const ctxA = { organizationId: F.ORG_A, storeId: F.STORE_A };

const PRODUTO_INK = Object.freeze({
  id: 386559, name: 'Camiseta Regional', slug: 'camiseta-regional', store_product_url: 'https://x/p/386559',
  visible_in_store: true, price: '129.90', promotional_price: '99.90', main_image_url: 'https://x/i/386559.webp',
  approval_status: 'approved', status: 'active', product_cluster_id: 777, updated_at: '2026-09-20T08:30:00Z',
  product_type: { id: 12, name: 'Camiseta' },
  product_variants: [{ id: 9001, sku: 'CAM-GG-AZUL', color: 'Azul', size: 'GG', model: 'Regular' }],
});

// ── resolve, capabilities e forma do connector ─────────────────────────────────────────────────

test('C · resolve commerce/reserva_ink pelo registry, ligado à Organization/Store corretas', () => emA(async () => {
  const { registry } = await montarAmbiente();
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  assert.equal(r.domain, 'commerce');
  assert.equal(r.integrationProvider, 'ink');
  assert.equal(r.requiresStoreContext, true);
  assert.equal(typeof r.connector.listProducts, 'function');
}));

test('C · capabilities verdadeiras correspondem exatamente aos métodos implementados', () => emA(async () => {
  const { registry } = await montarAmbiente();
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  assert.deepEqual({ ...r.capabilities }, { products: true, variants: true, orders: false, refunds: false, productCosts: false });
  assert.equal(typeof r.connector.listProducts, 'function');
  assert.equal(typeof r.connector.getProduct, 'function');
  assert.equal(typeof r.connector.listProductVariants, 'function');
  // Nada implementado além do que foi declarado true.
  assert.equal(r.connector.listOrders, undefined);
  assert.equal(r.connector.getOrder, undefined);
  assert.equal(r.connector.getProductCost, undefined);
}));

// ── Integration/Store/Organization ─────────────────────────────────────────────────────────────

test('C · Integration da Organization correta é usada; Store de outra Organization é recusada', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(async () => jsonRes(200, { products: [PRODUTO_INK], page: 1, per_page: 100, total_pages: 1, total_count: 1 }));
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  const pagina = await r.connector.listProducts({});
  assert.equal(pagina.items[0].organizationId, F.ORG_A);

  // O contexto se monta sem erro (é só um objeto); a rejeição vem de resolveIntegration(), na
  // primeira chamada real ao connector — é a porta da B.1 que valida Store → Organization.
  const rOutraStore = registry.resolve('commerce', 'reserva_ink', { organizationId: F.ORG_A, storeId: F.STORE_B });
  await assert.rejects(rOutraStore.connector.listProducts({}), (err) => err.codigo === 'CONNECTOR_INTEGRATION_TENANT_MISMATCH');
}));

test('C · secret api_token ausente: erro claro, nenhuma chamada à Ink', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente({ comSegredo: false });
  let chamouFetch = false;
  definirFetch(async () => { chamouFetch = true; return jsonRes(200, {}); });
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  await assert.rejects(r.connector.listProducts({}), (err) => err.codigo === 'SECRET_MISSING');
  assert.equal(chamouFetch, false);
}));

test('C · secret de outra Organization nunca é acessível: contexto de B não lê o token de A', () => comContexto({ organizationId: F.ORG_B, storeId: F.STORE_B, origem: 'teste' }, async () => {
  const poolB = poolCompleto({
    lojas: [{ id: F.STORE_B, organization_id: F.ORG_B }],
    integracoes: [], // B não tem integração Ink nenhuma
  });
  const secretPort = createConnectorSecretPort({ pool: poolB, keyring: keyring() });
  const registry = createConnectorRegistry({ integrations: createConnectorIntegrationPort({ pool: poolB }) });
  registry.register(createReservaInkCommerceDescriptor({ secretPort, fetchImpl: async () => jsonRes(200, {}) }));
  const r = registry.resolve('commerce', 'reserva_ink', { organizationId: F.ORG_B, storeId: F.STORE_B });
  await assert.rejects(r.connector.listProducts({}), (err) => err.codigo === 'INTEGRATION_NOT_CONNECTED');
}));

test('C · sem fallback por env: INK_TOKEN_/ALLOW_LEGACY_INTEGRATION_ENV setados não substituem o segredo ausente', () => emA(async () => {
  const antes = { ...process.env };
  process.env.INK_TOKEN_SUL = 'nunca-deveria-aparecer';
  process.env.ALLOW_LEGACY_INTEGRATION_ENV = '1';
  try {
    const { registry } = await montarAmbiente({ comSegredo: false });
    const r = registry.resolve('commerce', 'reserva_ink', ctxA);
    await assert.rejects(r.connector.listProducts({}), (err) => err.codigo === 'SECRET_MISSING');
  } finally {
    process.env = antes;
  }
}));

// ── Token nunca aparece ─────────────────────────────────────────────────────────────────────────

test('C · o token nunca aparece no produto/variante retornados nem no erro', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    return jsonRes(200, { products: [PRODUTO_INK], page: 1, per_page: 100, total_pages: 1, total_count: 1 });
  });
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  const pagina = await r.connector.listProducts({});
  assert.equal(JSON.stringify(pagina).includes(TOKEN), false);

  definirFetch(async () => jsonRes(401, { error: 'unauthorized' }));
  await assert.rejects(r.connector.listProducts({}), (err) => {
    assert.equal(JSON.stringify({ message: err.message, details: err.details }).includes(TOKEN), false);
    return true;
  });
}));

// ── GET /v1/stores/products e paginação ────────────────────────────────────────────────────────

test('C · listProducts monta a query certa e mapeia os produtos', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  let urlChamada;
  definirFetch(async (url) => { urlChamada = url; return jsonRes(200, { products: [PRODUTO_INK], page: 2, per_page: 50, total_pages: 3, total_count: 120 }); });
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  const pagina = await r.connector.listProducts({ cursor: '2', limit: 50 });
  assert.match(urlChamada, /\/v1\/stores\/products\?page=2&per_page=50$/);
  assert.equal(pagina.items.length, 1);
  assert.equal(pagina.items[0].providerProductId, '386559');
  assert.equal(pagina.items[0].provider, 'reserva_ink');
}));

test('C · paginação: nextCursor avança enquanto page < total_pages e vira null na última página', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(async () => jsonRes(200, { products: [], page: 1, per_page: 100, total_pages: 3, total_count: 250 }));
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  assert.equal((await r.connector.listProducts({})).nextCursor, '2');

  definirFetch(async () => jsonRes(200, { products: [], page: 3, per_page: 100, total_pages: 3, total_count: 250 }));
  assert.equal((await r.connector.listProducts({ cursor: '3' })).nextCursor, null);
}));

test('C · limit é limitado a 100 (o máximo per_page da Ink)', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  let url;
  definirFetch(async (u) => { url = u; return jsonRes(200, { products: [], page: 1, per_page: 100, total_pages: 1, total_count: 0 }); });
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  await r.connector.listProducts({ limit: 500 });
  assert.match(url, /per_page=100$/);
}));

// ── getProduct ──────────────────────────────────────────────────────────────────────────────────

test('C · getProduct busca por id e mapeia; 404 vira null (nunca erro genérico)', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(async (url) => { assert.match(url, /\/v1\/stores\/products\/386559$/); return jsonRes(200, { status: 200, product: PRODUTO_INK }); });
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  assert.equal((await r.connector.getProduct({ providerProductId: '386559' })).name, 'Camiseta Regional');

  definirFetch(async () => jsonRes(404, { error: 'não encontrado' }));
  assert.equal(await r.connector.getProduct({ providerProductId: '999' }), null);
}));

test('C · getProduct exige providerProductId numérico (o formato da Ink)', () => emA(async () => {
  const { registry } = await montarAmbiente();
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  await assert.rejects(r.connector.getProduct({}), TypeError);
  await assert.rejects(r.connector.getProduct({ providerProductId: 'abc' }), TypeError);
}));

// ── listProductVariants ────────────────────────────────────────────────────────────────────────

test('C · listProductVariants busca o produto e devolve as variantes mapeadas', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(async () => jsonRes(200, { status: 200, product: PRODUTO_INK }));
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  const pagina = await r.connector.listProductVariants({ providerProductId: '386559' });
  assert.equal(pagina.items.length, 1);
  assert.equal(pagina.items[0].providerVariantId, '9001');
  assert.equal(pagina.items[0].sku, 'CAM-GG-AZUL');
  assert.equal(pagina.nextCursor, null);
}));

test('C · listProductVariants exige providerProductId (a Ink não lista variante fora de um produto)', () => emA(async () => {
  const { registry } = await montarAmbiente();
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  await assert.rejects(r.connector.listProductVariants({}), TypeError);
}));

// ── Erros normalizados ─────────────────────────────────────────────────────────────────────────

for (const status of [401, 403, 429, 500, 503]) {
  test(`C · erro ${status} da Ink sobe como InkApiError com o status`, { timeout: 10000 }, () => emA(async () => {
    const { registry, definirFetch } = await montarAmbiente();
    definirFetch(async () => jsonRes(status, { error: `erro ${status}` }));
    const r = registry.resolve('commerce', 'reserva_ink', ctxA);
    await assert.rejects(r.connector.listProducts({}), (err) => err instanceof InkApiError && err.status === status);
  }));
}

// ── Comparativo com o handler legado (mapProdutoSummary), sem alterar server.js ─────────────────

function extrairFuncaoDoServer(nomeFuncao) {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const assinatura = `function ${nomeFuncao}(`;
  const inicio = fonte.indexOf(assinatura);
  assert.notEqual(inicio, -1, `${nomeFuncao} não encontrada em server.js — o comparativo ficaria cego`);
  const abre = fonte.indexOf('{', inicio);
  let profundidade = 0;
  let fim = abre;
  for (; fim < fonte.length; fim += 1) {
    if (fonte[fim] === '{') profundidade += 1;
    else if (fonte[fim] === '}') { profundidade -= 1; if (profundidade === 0) break; }
  }
  const src = fonte.slice(inicio, fim + 1);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nthis.__fn = ${nomeFuncao};`, sandbox);
  return sandbox.__fn;
}

test('C · comparativo: o connector novo preserva o mesmo dado que o handler legado (mapProdutoSummary) lê do mesmo produto Ink', () => emA(async () => {
  const mapProdutoSummary = extrairFuncaoDoServer('mapProdutoSummary');
  const legado = mapProdutoSummary('loja-legado', PRODUTO_INK);

  const { registry, definirFetch } = await montarAmbiente();
  // A listagem e o detalhe do produto são endpoints diferentes na Ink (§ mapper.js) — o fetch falso
  // distingue pela URL, como a Ink real distinguiria.
  definirFetch(async (url) => (url.includes('?')
    ? jsonRes(200, { products: [PRODUTO_INK], page: 1, per_page: 100, total_pages: 1, total_count: 1 })
    : jsonRes(200, { status: 200, product: PRODUTO_INK })));
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  const novo = (await r.connector.listProducts({})).items[0];
  const variantesNovo = (await r.connector.listProductVariants({ providerProductId: novo.providerProductId })).items;

  assert.equal(novo.providerProductId, String(legado.id));
  assert.equal(novo.name, legado.name);
  assert.equal(novo.imageUrl, legado.mainImageUrl);
  assert.equal(novo.price, Number(legado.price));
  assert.equal(novo.promotionalPrice, Number(legado.promotionalPrice));
  assert.equal(novo.visible, legado.visibleInStore);
  assert.equal(novo.productType, legado.productType);
  assert.equal(variantesNovo.length, legado.variantsCount);
  assert.equal(novo.metadata.productClusterId, legado.productClusterId);
  assert.equal(novo.metadata.approvalStatus, legado.approvalStatus);
  assert.equal(novo.metadata.status, legado.status);
}));
