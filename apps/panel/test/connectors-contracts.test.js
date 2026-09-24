'use strict';

// Fase B · contratos dos connectors (lib/connectors/contracts.js): domains, capabilities,
// ConnectorContext e validação do descritor. Sem banco, sem rede, sem provider real.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DOMAINS, CONTRACTS, contractOf, requiredMethods,
  createConnectorContext, withIntegrationId, validateDescriptor, assertConnectorShape,
} = require('../lib/connectors/contracts');
const { ConnectorError, CODIGOS } = require('../lib/connectors/errors');
const {
  ORG_A, STORE_A, STORE_B, INT_INK_A, INT_GA4_A,
  descritorReservaInk, descritorGa4, descritorMetaAds, descritorMetaEvents,
} = require('./helpers/connector-fakes');

const rejeita = (fn, codigo) => assert.throws(fn, (err) => err instanceof ConnectorError && err.codigo === codigo, `esperava ${codigo}`);

// ── Domains e capabilities ──────────────────────────────────────────────────────────────────────

test('Fase B · os quatro domains abertos têm contrato; messaging e ai estão reservados sem contrato', () => {
  for (const d of [DOMAINS.COMMERCE, DOMAINS.ANALYTICS, DOMAINS.EVENT_ANALYTICS, DOMAINS.ADS]) {
    const c = contractOf(d);
    assert.ok(Object.keys(c.capabilities).length > 0, d);
    assert.ok(c.minimumOneOf.every((n) => n in c.capabilities), `${d}: minimumOneOf cita capability inexistente`);
  }
  rejeita(() => contractOf(DOMAINS.MESSAGING), CODIGOS.DOMAIN_WITHOUT_CONTRACT);
  rejeita(() => contractOf(DOMAINS.AI), CODIGOS.DOMAIN_WITHOUT_CONTRACT);
  rejeita(() => contractOf('shipping'), CODIGOS.DOMAIN_UNKNOWN);
});

test('Fase B · contratos e domains são imutáveis', () => {
  assert.ok(Object.isFrozen(DOMAINS) && Object.isFrozen(CONTRACTS));
  assert.ok(Object.isFrozen(CONTRACTS.commerce.capabilities) && Object.isFrozen(CONTRACTS.commerce.capabilities.products));
  assert.throws(() => { 'use strict'; CONTRACTS.commerce.capabilities.products.push('deleteEverything'); }, TypeError);
});

test('Fase B · Meta Ads e Meta Events são contratos diferentes, sem método em comum', () => {
  const ads = Object.values(contractOf(DOMAINS.ADS).capabilities).flat();
  const eventos = [...contractOf(DOMAINS.EVENT_ANALYTICS).alwaysRequired, ...Object.values(contractOf(DOMAINS.EVENT_ANALYTICS).capabilities).flat()];
  assert.deepEqual(ads.filter((m) => eventos.includes(m)), []);
});

test('Fase B · requiredMethods segue as capabilities true e ignora as false', () => {
  assert.deepEqual(requiredMethods('commerce', { products: true, variants: false, orders: false, productCosts: false, refunds: true }).sort(), ['getProduct', 'listProducts']);
  const comPedidos = requiredMethods('commerce', { products: true, variants: false, orders: true, productCosts: false, refunds: false });
  assert.ok(comPedidos.includes('listOrders') && comPedidos.includes('getOrder'));
  // event_analytics: getEventCoverage é sempre exigido; o resto vem das capabilities.
  assert.deepEqual(requiredMethods('event_analytics', { aggregatedProductEvents: false, eventLevel: true, productIdentity: false, eventDedupKeys: false }).sort(), ['getEventCoverage', 'getProductEvents']);
});

// ── ConnectorContext ────────────────────────────────────────────────────────────────────────────

test('Fase B · o contexto carrega organizationId, storeId e integrationId (null até ser resolvido)', () => {
  const ctx = createConnectorContext({ organizationId: ORG_A, storeId: STORE_A });
  assert.deepEqual({ ...ctx }, { organizationId: ORG_A, storeId: STORE_A, integrationId: null });
  assert.ok(Object.isFrozen(ctx));

  const comIntegracao = createConnectorContext({ organizationId: ORG_A, storeId: STORE_A, integrationId: INT_INK_A });
  assert.equal(comIntegracao.integrationId, INT_INK_A);
});

test('Fase B · storeId é opcional no contexto e vira null explícito', () => {
  assert.equal(createConnectorContext({ organizationId: ORG_A }).storeId, null);
  assert.equal(createConnectorContext({ organizationId: ORG_A, storeId: null }).storeId, null);
});

test('Fase B · o contexto reprova organização ausente, id que não é uuid e tipos errados', () => {
  rejeita(() => createConnectorContext({ storeId: STORE_A }), CODIGOS.CONTEXT_INVALID);
  rejeita(() => createConnectorContext({ organizationId: '1' }), CODIGOS.CONTEXT_INVALID);
  rejeita(() => createConnectorContext({ organizationId: ORG_A, storeId: 'sul' }), CODIGOS.CONTEXT_INVALID);
  rejeita(() => createConnectorContext({ organizationId: ORG_A, storeId: 42 }), CODIGOS.CONTEXT_INVALID);
  rejeita(() => createConnectorContext({ organizationId: ORG_A, integrationId: '../etc' }), CODIGOS.CONTEXT_INVALID);
  rejeita(() => createConnectorContext(null), CODIGOS.CONTEXT_INVALID);
  rejeita(() => createConnectorContext([ORG_A]), CODIGOS.CONTEXT_INVALID);
  rejeita(() => createConnectorContext(ORG_A), CODIGOS.CONTEXT_INVALID);
});

test('Fase B · campo desconhecido no contexto reprova: token, loja legada e URL não entram por engano', () => {
  for (const campo of ['token', 'inkToken', 'accessToken', 'loja', 'feedUrl']) {
    rejeita(() => createConnectorContext({ organizationId: ORG_A, storeId: STORE_A, [campo]: 'x' }), CODIGOS.CONTEXT_INVALID);
  }
});

test('Fase B · o contexto é uma cópia: mudar a entrada depois não altera o contexto', () => {
  const entrada = { organizationId: ORG_A, storeId: STORE_A };
  const ctx = createConnectorContext(entrada);
  entrada.storeId = STORE_B;
  assert.equal(ctx.storeId, STORE_A);
  assert.throws(() => { 'use strict'; ctx.storeId = STORE_B; }, TypeError);
});

test('Fase B · integrationId é opaco: aceita id numérico (BIGSERIAL de hoje) e uuid; rejeita number e o que escapa de um id', () => {
  for (const ok of ['42', '101', 'c1000000-0000-4000-8000-0000000000a1', 'int_A-1']) {
    assert.equal(createConnectorContext({ organizationId: ORG_A, storeId: STORE_A, integrationId: ok }).integrationId, ok);
  }
  for (const ruim of [42, '', ' ', '../etc', "1'; DROP TABLE integrations;--", 'a b', 'x'.repeat(65), {}, []]) {
    rejeita(() => createConnectorContext({ organizationId: ORG_A, storeId: STORE_A, integrationId: ruim }), CODIGOS.CONTEXT_INVALID);
  }
  // Organization e Store, ao contrário, continuam UUID (organizations.id e stores.id são UUID).
  rejeita(() => createConnectorContext({ organizationId: '42', storeId: STORE_A }), CODIGOS.CONTEXT_INVALID);
});

test('Fase B · withIntegrationId liga a integração e não reaponta uma integração já definida', () => {
  const base = createConnectorContext({ organizationId: ORG_A, storeId: STORE_A });
  const ligado = withIntegrationId(base, INT_INK_A);
  assert.equal(ligado.integrationId, INT_INK_A);
  assert.equal(base.integrationId, null);
  assert.equal(withIntegrationId(ligado, INT_INK_A).integrationId, INT_INK_A);
  rejeita(() => withIntegrationId(ligado, INT_GA4_A), CODIGOS.CONTEXT_INVALID);
  rejeita(() => withIntegrationId(base, 'com espaço'), CODIGOS.CONTEXT_INVALID);
});

// ── Descritor ───────────────────────────────────────────────────────────────────────────────────

test('Fase B · os quatro descritores de referência são válidos e saem congelados', () => {
  for (const d of [descritorReservaInk(), descritorGa4(), descritorMetaAds(), descritorMetaEvents()]) {
    const v = validateDescriptor(d);
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.capabilities));
    assert.equal(v.label, v.provider);
  }
});

test('Fase B · integrationProvider assume o provider por padrão; reserva_ink aponta para a credencial ink', () => {
  assert.equal(validateDescriptor(descritorGa4()).integrationProvider, 'ga4');
  assert.equal(validateDescriptor(descritorReservaInk()).integrationProvider, 'ink');
});

test('Fase B · o descritor reprova domain sem contrato, integrationScope (removido) e create ausente', () => {
  rejeita(() => validateDescriptor({ ...descritorGa4(), domain: 'messaging' }), CODIGOS.DOMAIN_WITHOUT_CONTRACT);
  rejeita(() => validateDescriptor({ ...descritorGa4(), domain: 'nope' }), CODIGOS.DOMAIN_UNKNOWN);
  // O conceito de escopo de integração não existe mais: integração é da Organization.
  rejeita(() => validateDescriptor({ ...descritorGa4(), integrationScope: 'store' }), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ create: 'nao-e-funcao' })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ provider: 'GA4 Prod' })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ integrationProvider: 'ga4/../x' })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(null), CODIGOS.DESCRIPTOR_INVALID);
});

test('Fase B · requiresStoreContext é obrigatório e booleano, sem default implícito', () => {
  rejeita(() => validateDescriptor(descritorGa4({ requiresStoreContext: undefined })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ requiresStoreContext: 'true' })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ requiresStoreContext: 1 })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ requiresStoreContext: null })), CODIGOS.DESCRIPTOR_INVALID);
  const { requiresStoreContext, ...semCampo } = descritorGa4();
  assert.equal(requiresStoreContext, true);
  rejeita(() => validateDescriptor(semCampo), CODIGOS.DESCRIPTOR_INVALID);
});

test('Fase B · piso por domain: commerce e analytics sempre exigem Store; ads e event_analytics escolhem', () => {
  assert.deepEqual(
    Object.fromEntries([DOMAINS.COMMERCE, DOMAINS.ANALYTICS, DOMAINS.EVENT_ANALYTICS, DOMAINS.ADS].map((d) => [d, contractOf(d).storeContext])),
    { commerce: 'required', analytics: 'required', event_analytics: 'optional', ads: 'optional' },
  );
  rejeita(() => validateDescriptor(descritorReservaInk({ requiresStoreContext: false })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ requiresStoreContext: false })), CODIGOS.DESCRIPTOR_INVALID);
  for (const requiresStoreContext of [true, false]) {
    assert.equal(validateDescriptor(descritorMetaAds({ requiresStoreContext })).requiresStoreContext, requiresStoreContext);
    assert.equal(validateDescriptor(descritorMetaEvents({ requiresStoreContext })).requiresStoreContext, requiresStoreContext);
  }
});

test('Fase B · o descritor reprova campo desconhecido, como um token embutido', () => {
  rejeita(() => validateDescriptor({ ...descritorGa4(), token: 'ya29.x' }), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor({ ...descritorGa4(), pilotStore: true }), CODIGOS.DESCRIPTOR_INVALID);
});

test('Fase B · capabilities: conjunto fechado, todas declaradas e booleanas', () => {
  const base = descritorGa4().capabilities;
  rejeita(() => validateDescriptor(descritorGa4({ capabilities: { ...base, magic: true } })), CODIGOS.DESCRIPTOR_INVALID);
  const { realtime, ...semRealtime } = base;
  assert.equal(realtime, false);
  rejeita(() => validateDescriptor(descritorGa4({ capabilities: semRealtime })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ capabilities: { ...base, realtime: 'yes' } })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ capabilities: { ...base, realtime: 1 } })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorGa4({ capabilities: [] })), CODIGOS.DESCRIPTOR_INVALID);
});

test('Fase B · capabilities de outro domain não valem: eventLevel não existe em analytics', () => {
  rejeita(() => validateDescriptor(descritorGa4({ capabilities: { productMetrics: true, eventMetrics: false, realtime: false, eventLevel: true } })), CODIGOS.DESCRIPTOR_INVALID);
});

test('Fase B · connector que não faz nada não existe: exige ao menos uma capability do mínimo do domain', () => {
  rejeita(() => validateDescriptor(descritorGa4({ capabilities: { productMetrics: false, eventMetrics: false, realtime: true } })), CODIGOS.DESCRIPTOR_INVALID);
  rejeita(() => validateDescriptor(descritorMetaEvents({ capabilities: { aggregatedProductEvents: false, eventLevel: false, productIdentity: true, eventDedupKeys: true } })), CODIGOS.DESCRIPTOR_INVALID);
  // Provider só de agregados (§14.20) e provider event-level são ambos válidos.
  validateDescriptor(descritorMetaEvents({ capabilities: { aggregatedProductEvents: true, eventLevel: false, productIdentity: false, eventDedupKeys: false } }));
  validateDescriptor(descritorMetaEvents({ capabilities: { aggregatedProductEvents: false, eventLevel: true, productIdentity: false, eventDedupKeys: true } }));
});

test('Fase D · commerce aceita um connector que só implementa productsWithVariants, sem products avulso', () => {
  const d = validateDescriptor(descritorReservaInk({
    capabilities: { products: false, variants: false, productsWithVariants: true, orders: false, refunds: false, productCosts: false },
  }));
  assert.deepEqual(requiredMethods('commerce', d.capabilities), ['listProductsWithVariants']);
  rejeita(() => validateDescriptor(descritorReservaInk({
    capabilities: { products: false, variants: true, productsWithVariants: false, orders: false, refunds: false, productCosts: false },
  })), CODIGOS.DESCRIPTOR_INVALID);
});

test('Fase B · o descritor não guarda referência às capabilities passadas: mutar a entrada não muda o registro', () => {
  const capabilities = { ...descritorGa4().capabilities };
  const v = validateDescriptor(descritorGa4({ capabilities }));
  capabilities.productMetrics = false;
  assert.equal(v.capabilities.productMetrics, true);
});

// ── Conferência do objeto do connector ──────────────────────────────────────────────────────────

test('Fase B · o connector precisa ter todos os métodos das capabilities true', () => {
  const d = validateDescriptor(descritorReservaInk());
  assertConnectorShape(d, d.create({ resolveIntegration: async () => null }));

  const semGetOrder = { ...d.create({}) };
  delete semGetOrder.getOrder;
  rejeita(() => assertConnectorShape(d, semGetOrder), CODIGOS.CONTRACT_VIOLATION);
  rejeita(() => assertConnectorShape(d, { ...d.create({}), listProducts: 'não é função' }), CODIGOS.CONTRACT_VIOLATION);
  rejeita(() => assertConnectorShape(d, null), CODIGOS.CONTRACT_VIOLATION);
  rejeita(() => assertConnectorShape(d, Promise.resolve({})), CODIGOS.CONTRACT_VIOLATION);
});

test('Fase B · capability false não exige o método (GA4 sem getEventMetrics)', () => {
  const d = validateDescriptor(descritorGa4());
  assert.equal(d.capabilities.eventMetrics, false);
  assertConnectorShape(d, { getProductPerformance: async () => [] });
});

test('Fase B · getEventCoverage é obrigatório em event_analytics, mesmo só com agregados', () => {
  const d = validateDescriptor(descritorMetaEvents());
  rejeita(() => assertConnectorShape(d, { getProductEventAggregates: async () => [] }), CODIGOS.CONTRACT_VIOLATION);
  assertConnectorShape(d, { getEventCoverage: async () => ({ events: [] }), getProductEventAggregates: async () => [] });
});
