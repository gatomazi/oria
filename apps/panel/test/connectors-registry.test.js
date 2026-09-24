'use strict';

// Fase B · registry de connectors (lib/connectors/registry.js): resolve por (domain, provider), o
// mesmo provider em mais de um domain, contexto de Store (requiresStoreContext) e a porta do
// IntegrationResolver. Premissa: 1 Organization = 1 Store; a integração é sempre da Organization.
// Sem banco, sem rede, sem provider real — os connectors são test doubles.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createConnectorRegistry } = require('../lib/connectors/registry');
const { ConnectorError, CODIGOS } = require('../lib/connectors/errors');
const F = require('./helpers/connector-fakes');

// Erros da camada são ConnectorError; erros que vêm do resolvedor (ex.: INTEGRATION_NOT_CONNECTED) só têm `codigo`.
const rejeita = (fn, codigo) => assert.rejects(async () => fn(), (err) => err.codigo === codigo && (!String(codigo).startsWith('CONNECTOR_') || err instanceof ConnectorError), `esperava ${codigo}`);
const rejeitaSync = (fn, codigo) => assert.throws(fn, (err) => err instanceof ConnectorError && err.codigo === codigo, `esperava ${codigo}`);

function registryCompleto(opcoes = {}) {
  const porta = F.portaDeIntegracoes();
  const registry = createConnectorRegistry({ integrations: porta, ...opcoes });
  registry.register(F.descritorReservaInk());
  registry.register(F.descritorGa4());
  registry.register(F.descritorMetaAds());
  registry.register(F.descritorMetaEvents());
  return { registry, porta };
}
const ctxA = { organizationId: F.ORG_A, storeId: F.STORE_A };
const ctxB = { organizationId: F.ORG_B, storeId: F.STORE_B };

// ── resolve por (domain, provider) ──────────────────────────────────────────────────────────────

test('Fase B · resolve dos quatro pares pedidos, sem if de provider no consumidor', () => {
  const { registry } = registryCompleto();
  const pares = [['commerce', 'reserva_ink'], ['analytics', 'ga4'], ['event_analytics', 'meta'], ['ads', 'meta']];
  for (const [domain, provider] of pares) {
    const r = registry.resolve(domain, provider, ctxA);
    assert.equal(r.domain, domain);
    assert.equal(r.provider, provider);
    assert.equal(r.context.organizationId, F.ORG_A);
    assert.equal(r.context.storeId, F.STORE_A);
  }
});

test('Fase B · o mesmo código de consumo atende qualquer provider do domain', () => {
  const registry = createConnectorRegistry();
  registry.register(F.descritorGa4());
  // Um segundo provider de analytics, com outras capabilities e outro nome.
  registry.register(F.descritorGa4({
    provider: 'plausible',
    capabilities: { productMetrics: false, eventMetrics: true, realtime: true },
    create: () => ({ getEventMetrics: async () => [] }),
  }));
  // O "service": recebe o nome do provider como dado e nunca compara com literal.
  const consumir = (provider) => {
    const r = registry.resolve('analytics', provider, ctxA);
    return r.supports('productMetrics') ? 'usa-produto' : 'usa-evento';
  };
  assert.deepEqual(registry.providersOf('analytics'), ['ga4', 'plausible']);
  assert.equal(consumir('ga4'), 'usa-produto');
  assert.equal(consumir('plausible'), 'usa-evento');
});

test('Fase B · o resultado expõe capabilities, supports() e require() com código estável', () => {
  const { registry } = registryCompleto();
  const r = registry.resolve('commerce', 'reserva_ink', ctxA);
  assert.equal(r.supports('orders'), true);
  assert.equal(r.supports('productCosts'), false);
  assert.equal(r.supports('inexistente'), false);
  r.require('refunds');
  rejeitaSync(() => r.require('productCosts'), CODIGOS.CAPABILITY_UNSUPPORTED);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.capabilities));
});

test('Fase B · par não registrado falha com código, inclusive provider registrado em outro domain', () => {
  const { registry } = registryCompleto();
  rejeitaSync(() => registry.resolve('commerce', 'shopify', ctxA), CODIGOS.NOT_REGISTERED);
  rejeitaSync(() => registry.resolve('analytics', 'meta', ctxA), CODIGOS.NOT_REGISTERED);
  rejeitaSync(() => registry.resolve('commerce', 'ga4', ctxA), CODIGOS.NOT_REGISTERED);
  rejeitaSync(() => registry.resolve('messaging', 'whatsapp_meta', ctxA), CODIGOS.NOT_REGISTERED);
  // Entrada hostil não vai inteira para a mensagem.
  try { registry.resolve('x'.repeat(500), '<script>', ctxA); } catch (err) { assert.ok(err.message.length < 120 && !err.message.includes('<')); }
});

test('Fase B · registro duplicado de (domain, provider) reprova; o mesmo provider em outro domain não', () => {
  const { registry } = registryCompleto();
  rejeitaSync(() => registry.register(F.descritorGa4()), CODIGOS.ALREADY_REGISTERED);
  assert.equal(registry.has('ads', 'meta'), true);
  assert.equal(registry.has('event_analytics', 'meta'), true);
  assert.equal(registry.has('commerce', 'meta'), false);
});

test('Fase B · register valida o descritor: connector inválido não entra no registry', () => {
  const registry = createConnectorRegistry();
  rejeitaSync(() => registry.register(F.descritorGa4({ capabilities: { productMetrics: true } })), CODIGOS.DESCRIPTOR_INVALID);
  rejeitaSync(() => registry.register({ ...F.descritorGa4(), domain: 'messaging' }), CODIGOS.DOMAIN_WITHOUT_CONTRACT);
  assert.deepEqual(registry.list(), []);
});

test('Fase B · registries são independentes e não há estado global', () => {
  const a = createConnectorRegistry();
  const b = createConnectorRegistry();
  a.register(F.descritorGa4());
  assert.equal(a.has('analytics', 'ga4'), true);
  assert.equal(b.has('analytics', 'ga4'), false);
  assert.ok(Object.isFrozen(a));
});

test('Fase B · cada resolve cria um connector novo, ligado ao contexto da chamada', () => {
  const { registry } = registryCompleto();
  const r1 = registry.resolve('analytics', 'ga4', ctxA);
  const r2 = registry.resolve('analytics', 'ga4', ctxB);
  assert.notEqual(r1.connector, r2.connector);
  assert.equal(r1.context.organizationId, F.ORG_A);
  assert.equal(r2.context.organizationId, F.ORG_B);
});

test('Fase B · describe/list não expõem create nem segredo', () => {
  const { registry } = registryCompleto();
  const d = registry.describe('commerce', 'reserva_ink');
  assert.deepEqual(Object.keys(d).sort(), ['capabilities', 'domain', 'integrationProvider', 'label', 'provider', 'requiresStoreContext']);
  assert.equal(registry.list().length, 4);
  assert.deepEqual(registry.list().map((x) => `${x.domain}/${x.provider}`), ['ads/meta', 'analytics/ga4', 'commerce/reserva_ink', 'event_analytics/meta']);
});

// ── O mesmo provider em mais de um domain (Meta Ads ≠ Meta Events) ──────────────────────────────

test('Fase B · Meta implementa dois domains com contratos e capabilities independentes', () => {
  const { registry } = registryCompleto();
  assert.deepEqual(registry.domainsOf('meta'), ['ads', 'event_analytics']);
  assert.deepEqual(registry.domainsOf('ga4'), ['analytics']);

  const ads = registry.resolve('ads', 'meta', ctxA);
  const eventos = registry.resolve('event_analytics', 'meta', ctxA);
  assert.notDeepEqual({ ...ads.capabilities }, { ...eventos.capabilities });
  assert.equal(ads.supports('campaignPerformance'), true);
  assert.equal(ads.supports('aggregatedProductEvents'), false);
  assert.equal(eventos.supports('aggregatedProductEvents'), true);
  assert.equal(eventos.supports('eventLevel'), false);

  // Cada connector só tem os métodos do próprio domain.
  assert.equal(typeof ads.connector.getCampaignPerformance, 'function');
  assert.equal(ads.connector.getEventCoverage, undefined);
  assert.equal(typeof eventos.connector.getEventCoverage, 'function');
  assert.equal(eventos.connector.getCampaignPerformance, undefined);
});

test('Fase B · Meta Ads e Meta Events compartilham a MESMA integração sem virarem o mesmo connector', async () => {
  const { registry, porta } = registryCompleto();
  const ads = registry.resolve('ads', 'meta', ctxA);
  const eventos = registry.resolve('event_analytics', 'meta', ctxA);
  assert.equal(ads.integrationProvider, 'meta');
  assert.equal(eventos.integrationProvider, 'meta');
  assert.notEqual(ads.connector, eventos.connector);

  const daAds = await ads.connector.integracaoEmUso();
  const dosEventos = await eventos.connector.integracaoEmUso();
  assert.equal(daAds.integrationId, dosEventos.integrationId);
  assert.equal(daAds.integrationId, F.INT_META_A);
  // Mas a consulta de cada um carregou o próprio domain.
  assert.deepEqual(porta.consultas.map((c) => c.domain), ['ads', 'event_analytics']);
});

test('Fase B · um provider pode ter capabilities diferentes por domain, inclusive só agregados nos eventos', () => {
  const { registry } = registryCompleto();
  assert.equal(registry.describe('ads', 'meta').capabilities.adPerformance, true);
  assert.equal(registry.describe('event_analytics', 'meta').capabilities.eventLevel, false);
  assert.equal(registry.describe('event_analytics', 'meta').capabilities.aggregatedProductEvents, true);
});

// ── Contexto de Store (requiresStoreContext) ────────────────────────────────────────────────────

test('Fase B · requiresStoreContext=true exige storeId: sem Store no contexto não há resolve', () => {
  const { registry } = registryCompleto();
  rejeitaSync(() => registry.resolve('commerce', 'reserva_ink', { organizationId: F.ORG_A }), CODIGOS.CONTEXT_INVALID);
  rejeitaSync(() => registry.resolve('analytics', 'ga4', { organizationId: F.ORG_A, storeId: null }), CODIGOS.CONTEXT_INVALID);
  rejeitaSync(() => registry.resolve('event_analytics', 'meta', { organizationId: F.ORG_A }), CODIGOS.CONTEXT_INVALID);
});

test('Fase B · requiresStoreContext=false aceita storeId nulo (e também aceita a Store, quando vier)', () => {
  const { registry } = registryCompleto();
  assert.equal(registry.describe('ads', 'meta').requiresStoreContext, false);
  const semStore = registry.resolve('ads', 'meta', { organizationId: F.ORG_A });
  assert.equal(semStore.context.storeId, null);
  assert.equal(registry.resolve('ads', 'meta', ctxA).context.storeId, F.STORE_A);
});

test('Fase B · o contexto inválido é rejeitado no resolve, antes de criar o connector', () => {
  let criados = 0;
  const registry = createConnectorRegistry();
  registry.register(F.descritorGa4({ create: (deps) => { criados += 1; return F.descritorGa4().create(deps); } }));
  rejeitaSync(() => registry.resolve('analytics', 'ga4', { organizationId: F.ORG_A, storeId: 'sul' }), CODIGOS.CONTEXT_INVALID);
  rejeitaSync(() => registry.resolve('analytics', 'ga4', { organizationId: F.ORG_A, storeId: F.STORE_A, token: 'x' }), CODIGOS.CONTEXT_INVALID);
  assert.equal(criados, 0);
});

test('Fase B · create que devolve um connector fora do contrato é barrado no resolve', () => {
  const registry = createConnectorRegistry();
  registry.register(F.descritorGa4({ create: () => ({}) }));
  rejeitaSync(() => registry.resolve('analytics', 'ga4', ctxA), CODIGOS.CONTRACT_VIOLATION);
});

test('Fase B · o connector recebe só { context, resolveIntegration }: nenhum token, env ou pool', () => {
  let recebido;
  const registry = createConnectorRegistry({ integrations: F.portaDeIntegracoes() });
  registry.register(F.descritorGa4({ create: (deps) => { recebido = deps; return F.descritorGa4().create(deps); } }));
  registry.resolve('analytics', 'ga4', ctxA);
  assert.deepEqual(Object.keys(recebido).sort(), ['context', 'resolveIntegration']);
  assert.ok(Object.isFrozen(recebido) && Object.isFrozen(recebido.context));
});

// ── Porta do IntegrationResolver (integração é sempre da Organization) ──────────────────────────

const resultadoOk = (extra = {}) => ({
  integrationId: F.INT_INK_A, organizationId: F.ORG_A, storeId: F.STORE_A, integrationProvider: 'ink', ...extra,
});

function registryComResolvedor(resolve, descritor = F.descritorReservaInk(), contexto = ctxA) {
  const registry = createConnectorRegistry({ integrations: { resolve } });
  registry.register(descritor);
  return registry.resolve(descritor.domain, descritor.provider, contexto);
}

test('Fase B · resolveIntegration consulta por organização + provider da credencial e leva o contexto e requiresStoreContext', async () => {
  const { registry, porta } = registryCompleto();
  const r = await registry.resolve('commerce', 'reserva_ink', ctxA).connector.integracaoEmUso();
  assert.equal(r.integrationId, F.INT_INK_A);
  assert.equal(r.organizationId, F.ORG_A);
  assert.equal(r.storeId, F.STORE_A);
  assert.equal(porta.consultas.length, 1);
  const consulta = porta.consultas[0];
  assert.equal(consulta.domain, 'commerce');
  assert.equal(consulta.provider, 'reserva_ink');
  assert.equal(consulta.integrationProvider, 'ink');
  assert.equal(consulta.requiresStoreContext, true);
  assert.equal('integrationScope' in consulta, false);
  assert.deepEqual({ ...consulta.context }, { organizationId: F.ORG_A, storeId: F.STORE_A, integrationId: null });
  assert.ok(Object.isFrozen(consulta) && Object.isFrozen(consulta.context));
});

test('Fase B · duas Organizations independentes não cruzam integração (A → Ink A, B → Ink B)', async () => {
  const { registry } = registryCompleto();
  const daA = await registry.resolve('commerce', 'reserva_ink', ctxA).connector.integracaoEmUso();
  const daB = await registry.resolve('commerce', 'reserva_ink', ctxB).connector.integracaoEmUso();
  assert.equal(daA.integrationId, F.INT_INK_A);
  assert.equal(daB.integrationId, F.INT_INK_B);
  assert.equal(daB.organizationId, F.ORG_B);
  // B não tem GA4 conectado: a GA4 da Organization A não é candidata.
  await rejeita(() => registry.resolve('analytics', 'ga4', ctxB).connector.integracaoEmUso(), 'INTEGRATION_NOT_CONNECTED');
});

test('Fase B · o connector não escolhe Organization, Store nem provider da credencial: resolveIntegration ignora argumentos', async () => {
  const { porta } = registryCompleto();
  let resolveIntegration;
  const registry = createConnectorRegistry({ integrations: porta });
  registry.register(F.descritorReservaInk({ create: (deps) => { resolveIntegration = deps.resolveIntegration; return F.descritorReservaInk().create(deps); } }));
  registry.resolve('commerce', 'reserva_ink', ctxA);
  const r = await resolveIntegration({ organizationId: F.ORG_B, storeId: F.STORE_B, integrationProvider: 'meta', integrationId: F.INT_INK_B });
  assert.equal(r.integrationId, F.INT_INK_A);
  assert.equal(r.organizationId, F.ORG_A);
});

test('Fase B · integrationId do contexto pertence à Organization: o certo passa, o de outra Organization é rejeitado', async () => {
  const { registry } = registryCompleto();
  const certa = registry.resolve('commerce', 'reserva_ink', { ...ctxA, integrationId: F.INT_INK_A });
  assert.equal((await certa.connector.integracaoEmUso()).integrationId, F.INT_INK_A);
  // Integração da Organization B, informada por um contexto da Organization A: a busca leva a
  // Organization junto e não a encontra.
  const alheia = registry.resolve('commerce', 'reserva_ink', { ...ctxA, integrationId: F.INT_INK_B });
  await rejeita(() => alheia.connector.integracaoEmUso(), 'INTEGRATION_NOT_CONNECTED');
});

test('Fase B · integrationId de outro provider é rejeitado (id do GA4 num connector da Ink)', async () => {
  const { registry } = registryCompleto();
  const errada = registry.resolve('commerce', 'reserva_ink', { ...ctxA, integrationId: F.INT_GA4_A });
  await rejeita(() => errada.connector.integracaoEmUso(), 'INTEGRATION_NOT_CONNECTED');
});

test('Fase B · sem porta de integrações, o registry resolve e o connector falha só ao pedir a credencial', async () => {
  const registry = createConnectorRegistry();
  registry.register(F.descritorGa4());
  const r = registry.resolve('analytics', 'ga4', ctxA);
  await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_RESOLVER_MISSING);
  rejeitaSync(() => createConnectorRegistry({ integrations: {} }), CODIGOS.INTEGRATION_RESOLVER_MISSING);
});

test('Fase B · Store de outra Organization: o resolvedor recusa e o erro sobe como está', async () => {
  const { registry } = registryCompleto();
  const r = registry.resolve('commerce', 'reserva_ink', { organizationId: F.ORG_A, storeId: F.STORE_B });
  await rejeita(() => r.connector.integracaoEmUso(), 'STORE_NOT_IN_ORGANIZATION');
});

test('Fase B · defesa em profundidade: resolvedor que valida OUTRA Store é barrado', async () => {
  const r = registryComResolvedor(async () => resultadoOk({ storeId: F.STORE_B }));
  await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_TENANT_MISMATCH);
});

test('Fase B · defesa em profundidade: contexto com Store, resultado sem Store (ou o contrário) é barrado', async () => {
  const semStore = registryComResolvedor(async () => resultadoOk({ storeId: null }));
  await rejeita(() => semStore.connector.integracaoEmUso(), CODIGOS.INTEGRATION_TENANT_MISMATCH);
  const contextoSemStore = registryComResolvedor(async () => resultadoOk({ integrationProvider: 'meta', storeId: F.STORE_A }), F.descritorMetaAds(), { organizationId: F.ORG_A });
  await rejeita(() => contextoSemStore.connector.integracaoEmUso(), CODIGOS.INTEGRATION_TENANT_MISMATCH);
});

test('Fase B · resolvedor que devolve integração de outra Organization é barrado', async () => {
  const r = registryComResolvedor(async () => resultadoOk({ integrationId: F.INT_INK_B, organizationId: F.ORG_B }));
  await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_TENANT_MISMATCH);
});

test('Fase B · resolvedor que devolve integração de outro provider é barrado', async () => {
  const r = registryComResolvedor(async () => resultadoOk({ integrationId: F.INT_GA4_A, integrationProvider: 'ga4' }));
  await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_TENANT_MISMATCH);
});

test('Fase B · resolvedor que ignora o integrationId do contexto é barrado', async () => {
  const r = registryComResolvedor(async () => resultadoOk({ integrationId: F.INT_GA4_A }), F.descritorReservaInk(), { ...ctxA, integrationId: F.INT_INK_A });
  await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_TENANT_MISMATCH);
});

test('Fase B · resultado do resolvedor malformado ou sem identidade explícita é rejeitado', async () => {
  const malformados = [
    null,
    'x',
    resultadoOk({ integrationId: 'com espaço' }),
    resultadoOk({ integrationId: 101 }),
    { integrationId: F.INT_INK_A },
    // organizationId, storeId e provider omitidos não significam "qualquer um"
    { integrationId: F.INT_INK_A, organizationId: F.ORG_A, integrationProvider: 'ink' },
    { integrationId: F.INT_INK_A, storeId: F.STORE_A, integrationProvider: 'ink' },
    { integrationId: F.INT_INK_A, organizationId: F.ORG_A, storeId: F.STORE_A },
  ];
  for (const resultado of malformados) {
    const r = registryComResolvedor(async () => resultado);
    await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_INVALID);
  }
});

test('Fase B · o resultado entregue ao connector é congelado e traz só integração, Store validada, status e config', async () => {
  const r = registryComResolvedor(async () => resultadoOk({ status: 'connected', config: { propertyId: '123' }, apiToken: 'segredo' }));
  const ok = await r.connector.integracaoEmUso();
  assert.deepEqual(Object.keys(ok).sort(), ['config', 'integrationId', 'integrationProvider', 'organizationId', 'status', 'storeId']);
  assert.equal(ok.apiToken, undefined);
  assert.deepEqual({ ...ok.config }, { propertyId: '123' });
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.config));
});

test('Fase B · o registry não interpreta status: devolve como veio (a política é do connector/service)', async () => {
  for (const status of ['connected', 'pending', 'degraded', 'error', null]) {
    const r = registryComResolvedor(async () => resultadoOk({ status }));
    assert.equal((await r.connector.integracaoEmUso()).status, status);
  }
});

// ── Guardas estáticas da camada ─────────────────────────────────────────────────────────────────

const DIR_CONNECTORS = path.join(__dirname, '..', 'lib', 'connectors');
// SÓ o nível genérico (contracts/registry/errors/types) — não recursivo, de propósito: um adapter
// concreto (lib/connectors/commerce/reserva-ink/…, Fase C) tem todo o direito de citar o próprio
// provider. A guarda existe para o domínio, não para os adapters que ele hospeda.
const arquivosDaCamada = () => fs.readdirSync(DIR_CONNECTORS).filter((x) => x.endsWith('.js')).map((x) => path.join(DIR_CONNECTORS, x));
const semComentario = (arq) => fs.readFileSync(arq, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

// `typeof x.provider !== 'string'` valida formato; não é comparação com um provider concreto.
const comparaProviderComLiteral = (linha) => {
  const l = linha.replace(/typeof\s+[\w.]+/g, '');
  return /\w*provider\w*\s*[!=]==?\s*['"`]/i.test(l) || /['"`]\s*[!=]==?\s*[\w.]*provider\b/i.test(l) || /switch\s*\(\s*[\w.]*provider/i.test(l);
};

test('Fase B · o detector de "if (provider === …)" pega as formas que importam e ignora typeof', () => {
  for (const ruim of ["if (provider === 'ink') {", "if (d.provider !== \"ga4\")", "if ('meta' == descritor.provider)", 'switch (provider) {', 'switch (d.integrationProvider) {', 'else if (integrationProvider === `shopify`)']) {
    assert.equal(comparaProviderComLiteral(ruim), true, ruim);
  }
  for (const boa of ["typeof descritor.provider !== 'string'", 'return d.provider === provider;', 'const chave = `${domain}:${provider}`;']) {
    assert.equal(comparaProviderComLiteral(boa), false, boa);
  }
});

test('Fase B · lib/connectors não compara provider com literal nem faz switch por provider', () => {
  const achados = [];
  for (const arq of arquivosDaCamada()) {
    semComentario(arq).forEach((l, i) => {
      if (comparaProviderComLiteral(l)) achados.push(`${path.basename(arq)}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(achados, []);
});

test('Fase B · lib/connectors não lê ambiente, não importa server.js nem banco, e não fala com provider', () => {
  const achados = [];
  for (const arq of arquivosDaCamada()) {
    semComentario(arq).forEach((l, i) => {
      if (/process\.env|require\(\s*['"][^'"]*(server|tenant-runtime|tenant-db|integrations|secret|keyring|pg)['"]\s*\)|\bfetch\s*\(|https?:\/\//.test(l)) achados.push(`${path.basename(arq)}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(achados, []);
});

test('Fase B · nenhum nome de provider concreto aparece no código da camada genérica', () => {
  const achados = [];
  for (const arq of arquivosDaCamada()) {
    semComentario(arq).forEach((l, i) => {
      if (/['"`](reserva_ink|ink|ga4|meta|shopify|nuvemshop|woocommerce|use_sul)['"`]/i.test(l)) achados.push(`${path.basename(arq)}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(achados, []);
});
