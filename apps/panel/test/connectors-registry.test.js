'use strict';

// Fase B · registry de connectors (lib/connectors/registry.js): resolve por (domain, provider), o
// mesmo provider em mais de um domain, escopo da integração e a porta do IntegrationResolver.
// Sem banco, sem rede, sem provider real — os connectors são test doubles.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createConnectorRegistry } = require('../lib/connectors/registry');
const { ConnectorError, CODIGOS } = require('../lib/connectors/errors');
const F = require('./helpers/connector-fakes');

const rejeita = (fn, codigo) => assert.rejects(async () => fn(), (err) => err instanceof ConnectorError && err.codigo === codigo, `esperava ${codigo}`);
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
const ctxA1 = { organizationId: F.ORG_A, storeId: F.STORE_A1 };

// ── resolve por (domain, provider) ──────────────────────────────────────────────────────────────

test('Fase B · resolve dos quatro pares pedidos, sem if de provider no consumidor', () => {
  const { registry } = registryCompleto();
  const pares = [['commerce', 'reserva_ink'], ['analytics', 'ga4'], ['event_analytics', 'meta'], ['ads', 'meta']];
  for (const [domain, provider] of pares) {
    const r = registry.resolve(domain, provider, ctxA1);
    assert.equal(r.domain, domain);
    assert.equal(r.provider, provider);
    assert.equal(r.context.organizationId, F.ORG_A);
    assert.equal(r.context.storeId, F.STORE_A1);
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
    const r = registry.resolve('analytics', provider, ctxA1);
    return r.supports('productMetrics') ? 'usa-produto' : 'usa-evento';
  };
  assert.deepEqual(registry.providersOf('analytics'), ['ga4', 'plausible']);
  assert.equal(consumir('ga4'), 'usa-produto');
  assert.equal(consumir('plausible'), 'usa-evento');
});

test('Fase B · o resultado expõe capabilities, supports() e require() com código estável', () => {
  const { registry } = registryCompleto();
  const r = registry.resolve('commerce', 'reserva_ink', ctxA1);
  assert.equal(r.supports('orders'), true);
  assert.equal(r.supports('productCosts'), false);
  assert.equal(r.supports('inexistente'), false);
  r.require('refunds');
  rejeitaSync(() => r.require('productCosts'), CODIGOS.CAPABILITY_UNSUPPORTED);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.capabilities));
});

test('Fase B · par não registrado falha com código, inclusive provider registrado em outro domain', () => {
  const { registry } = registryCompleto();
  rejeitaSync(() => registry.resolve('commerce', 'shopify', ctxA1), CODIGOS.NOT_REGISTERED);
  rejeitaSync(() => registry.resolve('analytics', 'meta', ctxA1), CODIGOS.NOT_REGISTERED);
  rejeitaSync(() => registry.resolve('commerce', 'ga4', ctxA1), CODIGOS.NOT_REGISTERED);
  rejeitaSync(() => registry.resolve('messaging', 'whatsapp_meta', ctxA1), CODIGOS.NOT_REGISTERED);
  // Entrada hostil não vai inteira para a mensagem.
  try { registry.resolve('x'.repeat(500), '<script>', ctxA1); } catch (err) { assert.ok(err.message.length < 120 && !err.message.includes('<')); }
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
  const r1 = registry.resolve('analytics', 'ga4', ctxA1);
  const r2 = registry.resolve('analytics', 'ga4', { organizationId: F.ORG_B, storeId: F.STORE_B1 });
  assert.notEqual(r1.connector, r2.connector);
  assert.equal(r1.context.organizationId, F.ORG_A);
  assert.equal(r2.context.organizationId, F.ORG_B);
});

test('Fase B · describe/list não expõem create nem segredo', () => {
  const { registry } = registryCompleto();
  const d = registry.describe('commerce', 'reserva_ink');
  assert.deepEqual(Object.keys(d).sort(), ['capabilities', 'domain', 'integrationProvider', 'integrationScope', 'label', 'provider']);
  assert.equal(registry.list().length, 4);
  assert.deepEqual(registry.list().map((x) => `${x.domain}/${x.provider}`), ['ads/meta', 'analytics/ga4', 'commerce/reserva_ink', 'event_analytics/meta']);
});

// ── O mesmo provider em mais de um domain (Meta Ads ≠ Meta Events) ──────────────────────────────

test('Fase B · Meta implementa dois domains com contratos e capabilities independentes', () => {
  const { registry } = registryCompleto();
  assert.deepEqual(registry.domainsOf('meta'), ['ads', 'event_analytics']);
  assert.deepEqual(registry.domainsOf('ga4'), ['analytics']);

  const ads = registry.resolve('ads', 'meta', ctxA1);
  const eventos = registry.resolve('event_analytics', 'meta', ctxA1);
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
  const ads = registry.resolve('ads', 'meta', ctxA1);
  const eventos = registry.resolve('event_analytics', 'meta', ctxA1);
  assert.equal(ads.integrationProvider, 'meta');
  assert.equal(eventos.integrationProvider, 'meta');
  assert.notEqual(ads.connector, eventos.connector);

  const daAds = await ads.connector.integracaoEmUso();
  const dosEventos = await eventos.connector.integracaoEmUso();
  assert.equal(daAds.integrationId, dosEventos.integrationId);
  assert.equal(daAds.integrationId, F.INT_META_A_ORG);
  // Mas a consulta de cada um carregou o próprio domain.
  assert.deepEqual(porta.consultas.map((c) => c.domain), ['ads', 'event_analytics']);
});

test('Fase B · um provider pode ter capabilities diferentes por domain, inclusive só agregados nos eventos', () => {
  const { registry } = registryCompleto();
  assert.equal(registry.describe('ads', 'meta').capabilities.adPerformance, true);
  assert.equal(registry.describe('event_analytics', 'meta').capabilities.eventLevel, false);
  assert.equal(registry.describe('event_analytics', 'meta').capabilities.aggregatedProductEvents, true);
});

// ── Escopo do contexto ──────────────────────────────────────────────────────────────────────────

test('Fase B · connector de escopo store exige storeId; sem Store no contexto não há resolve', () => {
  const { registry } = registryCompleto();
  rejeitaSync(() => registry.resolve('commerce', 'reserva_ink', { organizationId: F.ORG_A }), CODIGOS.CONTEXT_INVALID);
  rejeitaSync(() => registry.resolve('analytics', 'ga4', { organizationId: F.ORG_A, storeId: null }), CODIGOS.CONTEXT_INVALID);
  // store_or_organization também precisa da Store: o dado analisado é da Store.
  rejeitaSync(() => registry.resolve('ads', 'meta', { organizationId: F.ORG_A }), CODIGOS.CONTEXT_INVALID);
});

test('Fase B · connector de escopo organization aceita contexto sem Store', () => {
  const registry = createConnectorRegistry();
  registry.register(F.descritorGa4({ provider: 'ga4_org', integrationScope: 'organization' }));
  const r = registry.resolve('analytics', 'ga4_org', { organizationId: F.ORG_A });
  assert.equal(r.context.storeId, null);
});

test('Fase B · o contexto inválido é rejeitado no resolve, antes de criar o connector', () => {
  let criados = 0;
  const registry = createConnectorRegistry();
  registry.register(F.descritorGa4({ create: (deps) => { criados += 1; return F.descritorGa4().create(deps); } }));
  rejeitaSync(() => registry.resolve('analytics', 'ga4', { organizationId: F.ORG_A, storeId: 'sul' }), CODIGOS.CONTEXT_INVALID);
  rejeitaSync(() => registry.resolve('analytics', 'ga4', { organizationId: F.ORG_A, storeId: F.STORE_A1, token: 'x' }), CODIGOS.CONTEXT_INVALID);
  assert.equal(criados, 0);
});

test('Fase B · create que devolve um connector fora do contrato é barrado no resolve', () => {
  const registry = createConnectorRegistry();
  registry.register(F.descritorGa4({ create: () => ({}) }));
  rejeitaSync(() => registry.resolve('analytics', 'ga4', ctxA1), CODIGOS.CONTRACT_VIOLATION);
});

test('Fase B · o connector recebe só { context, resolveIntegration }: nenhum token, env ou pool', () => {
  let recebido;
  const registry = createConnectorRegistry({ integrations: F.portaDeIntegracoes() });
  registry.register(F.descritorGa4({ create: (deps) => { recebido = deps; return F.descritorGa4().create(deps); } }));
  registry.resolve('analytics', 'ga4', ctxA1);
  assert.deepEqual(Object.keys(recebido).sort(), ['context', 'resolveIntegration']);
  assert.ok(Object.isFrozen(recebido) && Object.isFrozen(recebido.context));
});

// ── Porta do IntegrationResolver (preparo para integrationId e Fase B.1) ───────────────────────

test('Fase B · resolveIntegration consulta por organização + Store + provider da credencial, com o escopo do descritor', async () => {
  const { registry, porta } = registryCompleto();
  const r = await registry.resolve('commerce', 'reserva_ink', ctxA1).connector.integracaoEmUso();
  assert.equal(r.integrationId, F.INT_INK_A1);
  assert.equal(r.storeId, F.STORE_A1);
  assert.equal(porta.consultas.length, 1);
  const consulta = porta.consultas[0];
  assert.equal(consulta.domain, 'commerce');
  assert.equal(consulta.provider, 'reserva_ink');
  assert.equal(consulta.integrationProvider, 'ink');
  assert.equal(consulta.integrationScope, 'store');
  assert.deepEqual({ ...consulta.context }, { organizationId: F.ORG_A, storeId: F.STORE_A1, integrationId: null });
  assert.ok(Object.isFrozen(consulta) && Object.isFrozen(consulta.context));
});

test('Fase B · duas Stores da mesma Organization resolvem integrações diferentes (Store A → Ink A, Store B → Ink B)', async () => {
  const { registry } = registryCompleto();
  const daA1 = await registry.resolve('commerce', 'reserva_ink', ctxA1).connector.integracaoEmUso();
  const daA2 = await registry.resolve('commerce', 'reserva_ink', { organizationId: F.ORG_A, storeId: F.STORE_A2 }).connector.integracaoEmUso();
  assert.equal(daA1.integrationId, F.INT_INK_A1);
  assert.equal(daA2.integrationId, F.INT_INK_A2);
});

test('Fase B · o connector não escolhe Organization, Store nem provider da credencial: resolveIntegration ignora argumentos', async () => {
  const { registry, porta } = registryCompleto();
  const r = registry.resolve('commerce', 'reserva_ink', ctxA1);
  const depsEspiao = { resolveIntegration: null };
  const registryEspiao = createConnectorRegistry({ integrations: porta });
  registryEspiao.register(F.descritorReservaInk({ create: (deps) => { depsEspiao.resolveIntegration = deps.resolveIntegration; return F.descritorReservaInk().create(deps); } }));
  registryEspiao.resolve('commerce', 'reserva_ink', ctxA1);
  const r2 = await depsEspiao.resolveIntegration({ organizationId: F.ORG_B, storeId: F.STORE_B1, integrationProvider: 'meta' });
  assert.equal(r2.integrationId, F.INT_INK_A1);
  assert.equal(r.context.storeId, F.STORE_A1);
});

test('Fase B · integrationId do contexto é conferido: a integração devolvida tem de ser a mesma', async () => {
  const { registry } = registryCompleto();
  const certa = registry.resolve('commerce', 'reserva_ink', { ...ctxA1, integrationId: F.INT_INK_A1 });
  assert.equal((await certa.connector.integracaoEmUso()).integrationId, F.INT_INK_A1);
  const errada = registry.resolve('commerce', 'reserva_ink', { ...ctxA1, integrationId: F.INT_INK_A2 });
  await rejeita(() => errada.connector.integracaoEmUso(), CODIGOS.INTEGRATION_SCOPE_MISMATCH);
});

test('Fase B · sem porta de integrações, o registry resolve e o connector falha só ao pedir a credencial', async () => {
  const registry = createConnectorRegistry();
  registry.register(F.descritorGa4());
  const r = registry.resolve('analytics', 'ga4', ctxA1);
  await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_RESOLVER_MISSING);
  rejeitaSync(() => createConnectorRegistry({ integrations: {} }), CODIGOS.INTEGRATION_RESOLVER_MISSING);
});

test('Fase B · erro do resolvedor (ex.: integração não conectada) sobe como está, sem fallback', async () => {
  const { registry } = registryCompleto();
  // Store A2 não tem GA4 conectado; a GA4 da Store A1 não pode ser usada no lugar.
  const r = registry.resolve('analytics', 'ga4', { organizationId: F.ORG_A, storeId: F.STORE_A2 });
  await assert.rejects(() => r.connector.integracaoEmUso(), /não conectada/);
});

function registryComResolvedor(resolve, descritor = F.descritorReservaInk()) {
  const registry = createConnectorRegistry({ integrations: { resolve } });
  registry.register(descritor);
  return registry.resolve(descritor.domain, descritor.provider, ctxA1);
}

test('Fase B · defesa em profundidade: resolvedor que devolve integração de outra Store é barrado', async () => {
  const r = registryComResolvedor(async () => ({ integrationId: F.INT_INK_A2, organizationId: F.ORG_A, storeId: F.STORE_A2 }));
  await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_SCOPE_MISMATCH);
});

test('Fase B · resolvedor que devolve integração de outra Organization é barrado', async () => {
  const r = registryComResolvedor(async () => ({ integrationId: F.INT_INK_B1, organizationId: F.ORG_B, storeId: F.STORE_A1 }));
  await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_SCOPE_MISMATCH);
});

test('Fase B · escopo store não aceita integração da Organization como fallback', async () => {
  const r = registryComResolvedor(async () => ({ integrationId: F.INT_META_A_ORG, organizationId: F.ORG_A, storeId: null }));
  await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_SCOPE_MISMATCH);
});

test('Fase B · store_or_organization aceita a integração da Organization só porque o descritor permitiu', async () => {
  const r = registryComResolvedor(async () => ({ integrationId: F.INT_META_A_ORG, organizationId: F.ORG_A, storeId: null }), F.descritorMetaAds());
  const ok = await r.connector.integracaoEmUso();
  assert.equal(ok.integrationId, F.INT_META_A_ORG);
  assert.equal(ok.storeId, null);
  // E mesmo assim não aceita a de outra Store.
  const outra = registryComResolvedor(async () => ({ integrationId: F.INT_INK_A2, organizationId: F.ORG_A, storeId: F.STORE_A2 }), F.descritorMetaAds());
  await rejeita(() => outra.connector.integracaoEmUso(), CODIGOS.INTEGRATION_SCOPE_MISMATCH);
});

test('Fase B · escopo organization só aceita integração da Organization', async () => {
  const d = F.descritorGa4({ provider: 'ga4_org', integrationScope: 'organization' });
  const daStore = registryComResolvedor(async () => ({ integrationId: F.INT_GA4_A1, organizationId: F.ORG_A, storeId: F.STORE_A1 }), d);
  await rejeita(() => daStore.connector.integracaoEmUso(), CODIGOS.INTEGRATION_SCOPE_MISMATCH);
});

test('Fase B · resultado do resolvedor malformado ou sem escopo explícito é rejeitado', async () => {
  const malformados = [
    null,
    'x',
    { integrationId: 'com espaço', organizationId: F.ORG_A, storeId: F.STORE_A1 },
    { integrationId: 101, organizationId: F.ORG_A, storeId: F.STORE_A1 },
    { integrationId: F.INT_INK_A1 },
    // storeId omitido não significa "qualquer Store"
    { integrationId: F.INT_INK_A1, organizationId: F.ORG_A },
  ];
  for (const resultado of malformados) {
    const r = registryComResolvedor(async () => resultado);
    await rejeita(() => r.connector.integracaoEmUso(), CODIGOS.INTEGRATION_INVALID);
  }
});

test('Fase B · o resultado entregue ao connector é congelado e traz só integração, escopo, status e config', async () => {
  const r = registryComResolvedor(async () => ({
    integrationId: F.INT_INK_A1, organizationId: F.ORG_A, storeId: F.STORE_A1, status: 'connected', config: { propertyId: '123' }, apiToken: 'segredo',
  }));
  const ok = await r.connector.integracaoEmUso();
  assert.deepEqual(Object.keys(ok).sort(), ['config', 'integrationId', 'organizationId', 'status', 'storeId']);
  assert.equal(ok.apiToken, undefined);
  assert.deepEqual({ ...ok.config }, { propertyId: '123' });
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.config));
});

// ── Guardas estáticas da camada ─────────────────────────────────────────────────────────────────

const DIR_CONNECTORS = path.join(__dirname, '..', 'lib', 'connectors');
const arquivosDaCamada = () => fs.readdirSync(DIR_CONNECTORS, { recursive: true }).filter((x) => x.endsWith('.js')).map((x) => path.join(DIR_CONNECTORS, x));
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
