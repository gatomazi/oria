'use strict';

// Fase G · ProductPerformanceService contra Postgres real: catálogo + analytics (fake) + identity,
// sem N+1, agregação por múltiplos ids, rates, zero vs ausente, coverage, isolamento, paginação e
// ordenação. O connector de analytics é FAKE (não GA4 real — isso já está coberto em
// test/connectors-analytics-ga4-connector.test.js); aqui o alvo é o que o SERVICE faz com o que o
// connector devolve.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createConnectorRegistry } = h.sujeito('lib/connectors/registry.js');
const { createCommerceCatalogRepository } = h.sujeito('lib/product-analytics/commerce-catalog-repository.js');
const { createProductPerformanceService } = h.sujeito('lib/product-analytics/product-performance-service.js');
const { bootstrapCommerceIdentities } = h.sujeito('lib/product-analytics/product-identity-resolver.js');

const ORG_A = 'ab000000-0000-4000-8000-000000000001';
const ORG_B = 'ab000000-0000-4000-8000-000000000002';
const STORE_A = 'ac000000-0000-4000-8000-000000000001';
const STORE_B = 'ac000000-0000-4000-8000-000000000002';
const ROLE = `oria_app_pps_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const PROVIDER = 'fake_commerce';
const ANALYTICS_PROVIDER = 'fake_ga4';
const RUN = crypto.randomUUID();
const PERIODO = { startDate: '2026-09-01', endDate: '2026-09-20' };

let db;
let sup;
let appPoolReal;

const em = (org, store, fn) => runtime.comContexto({ organizationId: org, storeId: store, origem: 'teste' }, fn);
const pool = () => runtime.criarPoolTenant(appPoolReal);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_pps');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 6 });

  for (const [org, store, nome] of [[ORG_A, STORE_A, 'Org A'], [ORG_B, STORE_B, 'Org B']]) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, nome]);
    await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [store, org, nome]);
  }
});

test.after(async () => {
  await appPoolReal?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

async function semearCatalogo(org, store, provider, produtos) {
  const idsPorPid = new Map();
  for (const p of produtos) {
    const { rows: [{ id }] } = await sup.query(
      `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, price, last_seen_sync_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [org, store, provider, p.providerProductId, p.name || `Produto ${p.providerProductId}`, p.price ?? null, RUN]
    );
    idsPorPid.set(p.providerProductId, id);
    for (const v of p.variants || []) {
      await sup.query(
        `INSERT INTO commerce_product_variants (organization_id, store_id, commerce_product_id, provider, provider_variant_id, sku, last_seen_sync_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [org, store, id, provider, v.providerVariantId, v.sku || null, RUN]
      );
    }
  }
  return idsPorPid;
}

const item = (externalProductId, over = {}) => ({
  externalProductId, externalProductName: null, itemsViewed: 10, itemsAddedToCart: 4, itemsCheckedOut: 2, itemsPurchased: 1, itemRevenue: 99.9,
  analyticsProvider: ANALYTICS_PROVIDER, ...over,
});

// Registry com um AnalyticsConnector FAKE controlável: `linhas` (array) ou função(chamadas) → array.
// `cacheScope`: quando informado (valor fixo ou função(chamadas) → valor), o fake ganha
// `getCacheScope()` — simula GA4 com propriedade configurada, pra testar invalidação por escopo.
function registryComAnalytics(linhas, { capabilities, cacheScope } = {}) {
  const registry = createConnectorRegistry();
  let chamadas = 0;
  let chamadasDeEscopo = 0;
  registry.register({
    domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false, ...capabilities },
    create: () => ({
      getProductPerformance: async () => {
        chamadas += 1;
        return typeof linhas === 'function' ? linhas(chamadas) : linhas;
      },
      ...(cacheScope !== undefined ? {
        getCacheScope: async () => {
          chamadasDeEscopo += 1;
          return typeof cacheScope === 'function' ? cacheScope(chamadasDeEscopo) : cacheScope;
        },
      } : {}),
    }),
  });
  return { registry, chamadasFeitas: () => chamadas, chamadasDeEscopoFeitas: () => chamadasDeEscopo };
}

function montarServico(registry, poolFacade = pool()) {
  return createProductPerformanceService({
    pool: poolFacade, registry, catalogRepository: createCommerceCatalogRepository({ pool: poolFacade }),
  });
}

// ── Tenant / período / validação ─────────────────────────────────────────────────────────────

test('G · exige organizationId/storeId/analyticsProvider/startDate/endDate; startDate <= endDate', () => em(ORG_A, STORE_A, async () => {
  const { registry } = registryComAnalytics([]);
  const svc = montarServico(registry);
  await assert.rejects(svc.getProductPerformance({ storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO }), TypeError);
  await assert.rejects(svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO }), TypeError);
  await assert.rejects(svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER }), TypeError);
  await assert.rejects(svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, startDate: '2026-09-20', endDate: '2026-09-01' }), TypeError);
}));

test('G · sem período com dados (dataset vazio): produtos aparecem com metrics=null, diagnóstico insufficient_data — nunca 0 inventado', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'empty_provider', [{ providerProductId: 'e1' }]);
  const { registry } = registryComAnalytics([]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'empty_provider' }, ...PERIODO });
  assert.equal(r.coverage.status, 'insufficient_data');
  assert.equal(r.coverage.coverageRate, null);
  assert.equal(r.items[0].metrics, null);
  assert.deepEqual(r.items[0].diagnostics, ['insufficient_data']);
}));

// ── 1 query agregada / sem N+1 ────────────────────────────────────────────────────────────────

test('G · 1 chamada ao AnalyticsConnector para o período inteiro, independente do número de produtos', () => em(ORG_A, STORE_A, async () => {
  const N = 120;
  const produtos = Array.from({ length: N }, (_, i) => ({ providerProductId: `n${i}` }));
  await semearCatalogo(ORG_A, STORE_A, 'n_provider', produtos);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'n_provider' });
  const { registry, chamadasFeitas } = registryComAnalytics(produtos.map((p) => item(p.providerProductId)));
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'n_provider' }, pagination: { limit: 500 }, ...PERIODO });
  assert.equal(chamadasFeitas(), 1);
  assert.equal(r.items.length, N);
  assert.equal(r.items.every((it) => it.metrics.itemsViewed === 10), true);
}));

test('G · 1000 produtos: 1 chamada de analytics REAPROVEITADA entre páginas (cache), nenhuma query de catálogo por produto', { timeout: 30000 }, () => em(ORG_A, STORE_A, async () => {
  const N = 1000;
  const produtos = Array.from({ length: N }, (_, i) => ({ providerProductId: `m${i}` }));
  await semearCatalogo(ORG_A, STORE_A, 'mil_provider', produtos);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'mil_provider' });
  const { registry, chamadasFeitas } = registryComAnalytics(produtos.map((p) => item(p.providerProductId)));
  const svc = montarServico(registry);
  const r1 = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'mil_provider' }, pagination: { limit: 50 }, ...PERIODO });
  assert.equal(chamadasFeitas(), 1);
  assert.equal(r1.items.length, 50);
  assert.equal(r1.totalCount, N);
  assert.ok(r1.nextCursor);
  const r2 = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'mil_provider' }, pagination: { limit: 50, cursor: r1.nextCursor }, ...PERIODO });
  // Mesmo escopo (org/store/provider/período): a página 2 reaproveita o relatório da página 1 do
  // ReportCache — nunca um relatório completo de novo por página (rodada G.1, escalabilidade).
  assert.equal(chamadasFeitas(), 1);
  assert.equal(r2.items.length, 50);
  assert.notDeepEqual(r2.items.map((i2) => i2.product.id), r1.items.map((i1) => i1.product.id));
}));

// ── Cache tenant-safe de relatório (rodada G.1 — escalabilidade) ────────────────────────────────

// Rodada M §2 · relógio falso pro teste de TTL: nunca depende de quanto tempo uma chamada de banco
// REAL levou (com a máquina ocupada, duas chamadas sequenciais podiam facilmente passar de 50ms de
// tempo REAL entre elas, expirando o TTL "cedo demais" e fazendo o teste falhar por uma corrida que
// não tinha nada a ver com o comportamento do cache). `avancar(ms)` move o relógio exatamente o
// quanto o teste decide, de forma síncrona — remove a corrida, não esconde ela atrás de tolerância.
function relogioFalso(inicial = 0) {
  let agora = inicial;
  const fn = () => agora;
  fn.avancar = (ms) => { agora += ms; };
  return fn;
}

test('G · ReportCache: mesma chave (org/store/provider/período) reaproveita; chave diferente busca de novo; TTL expira; nunca cruza Organization', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'cache_provider', [{ providerProductId: 'c1' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'cache_provider' });
  const { registry, chamadasFeitas } = registryComAnalytics([item('c1')]);
  const { createReportCache } = h.sujeito('lib/product-analytics/product-performance-service.js');
  const relogio = relogioFalso();
  const cache = createReportCache({ ttlMs: 50, relogio });
  const svc = createProductPerformanceService({ pool: pool(), registry, catalogRepository: createCommerceCatalogRepository({ pool: pool() }), reportCache: cache });
  const entrada = { organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'cache_provider' }, ...PERIODO };

  await svc.getProductPerformance(entrada);
  await svc.getProductPerformance(entrada);
  assert.equal(chamadasFeitas(), 1); // 2ª chamada com o MESMO escopo, MESMO instante do relógio: cache hit

  await svc.getProductPerformance({ ...entrada, endDate: '2026-09-21' }); // período diferente: cache miss
  assert.equal(chamadasFeitas(), 2);

  relogio.avancar(60); // TTL de 50ms expira — determinístico, nunca espera tempo real
  await svc.getProductPerformance(entrada);
  assert.equal(chamadasFeitas(), 3); // expirou: busca de novo, nunca serve dado velho além do TTL
}));

test('G · ReportCache: instância nova por createProductPerformanceService quando não injetado — nunca estado global entre services', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'cache_iso_provider', [{ providerProductId: 'ci1' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'cache_iso_provider' });
  const entrada = { organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'cache_iso_provider' }, ...PERIODO };
  const { registry: reg1, chamadasFeitas: chamadas1 } = registryComAnalytics([item('ci1')]);
  const { registry: reg2, chamadasFeitas: chamadas2 } = registryComAnalytics([item('ci1')]);
  const svc1 = montarServico(reg1);
  const svc2 = montarServico(reg2);
  await svc1.getProductPerformance(entrada);
  await svc2.getProductPerformance(entrada); // service DIFERENTE — não pode herdar o cache-hit do svc1
  assert.equal(chamadas1(), 1);
  assert.equal(chamadas2(), 1);
}));

// ── Product exact / variant agrupado / SKU agrupado ──────────────────────────────────────────

test('G · product id exact, variant ids agrupados e SKU agrupado no MESMO commerce_product_id (soma, não duplica)', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'grp_provider', [
    { providerProductId: 'gp1', variants: [{ providerVariantId: 'gv1', sku: 'GSKU-1' }, { providerVariantId: 'gv2', sku: 'GSKU-2' }] },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'grp_provider' });
  // 3 ids diferentes (product, variant, sku) todos observados no analytics do MESMO produto.
  const { registry } = registryComAnalytics([
    item('gp1', { itemsViewed: 10, itemsAddedToCart: 2, itemsCheckedOut: 1, itemsPurchased: 0, itemRevenue: 0 }),
    item('gv1', { itemsViewed: 5, itemsAddedToCart: 1, itemsCheckedOut: 1, itemsPurchased: 1, itemRevenue: 50 }),
    item('GSKU-2', { itemsViewed: 3, itemsAddedToCart: 0, itemsCheckedOut: 0, itemsPurchased: 0, itemRevenue: 0 }),
  ]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'grp_provider' }, ...PERIODO });
  const linha = r.items.find((x) => x.product.id === ids.get('gp1'));
  assert.equal(linha.metrics.itemsViewed, 18); // 10+5+3
  assert.equal(linha.metrics.itemsPurchased, 1);
  assert.equal(linha.identity.matchedAnalyticsIds.length, 3);
  assert.deepEqual(linha.diagnostics, ['multiple_analytics_identities']);
}));

// ── Unmatched / conflito ──────────────────────────────────────────────────────────────────────

test('G · id observado sem identity nenhuma: coverage conta como unmatched; produto sem esse id fica unmatched_identity', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'unm_provider', [{ providerProductId: 'u1' }]);
  const { registry } = registryComAnalytics([item('id-orfao-sem-produto-nenhum')]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'unm_provider' }, ...PERIODO });
  assert.equal(r.coverage.unmatchedAnalyticsIds, 1);
  assert.equal(r.items[0].identity.status, 'unmatched');
  assert.equal(r.items[0].metrics, null);
  assert.deepEqual(r.items[0].diagnostics, ['unmatched_identity']);
}));

test('G · conflito de identity (mesmo external_id em dois namespaces de produtos diferentes) entra na coverage, nunca escolhe', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'cfl_provider', [{ providerProductId: 'cf1' }, { providerProductId: 'cf2' }]);
  await sup.query(
    `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
     VALUES ($1,$2,$3,'a.product_id','ambiguo-g','manual','exact'), ($1,$2,$4,'b.product_id','ambiguo-g','manual','exact')`,
    [ORG_A, STORE_A, ids.get('cf1'), ids.get('cf2')]
  );
  const { registry } = registryComAnalytics([item('ambiguo-g')]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'cfl_provider' }, ...PERIODO });
  assert.equal(r.coverage.conflictedAnalyticsIds, 1);
  for (const linha of r.items) assert.equal(linha.identity.matchedAnalyticsIds.includes('ambiguo-g'), false);
}));

// ── Zero vs ausente / rates / métrica ausente ────────────────────────────────────────────────

test('G · produto com identity conhecida mas SEM linha no período: zero real (não null) — GA4 cobre a propriedade inteira', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'zero_provider', [{ providerProductId: 'z1' }, { providerProductId: 'z2' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'zero_provider' });
  // "Identity conhecida" é uma resolução PRÉVIA (ex.: de um período anterior com atividade) — nunca
  // se cria sozinha por z2 simplesmente existir no catálogo. Semeia essa resolução prévia direto.
  await sup.query(
    `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
     VALUES ($1, $2, $3, $4, 'z2-em-periodo-anterior', 'rule', 'exact')`,
    [ORG_A, STORE_A, ids.get('z2'), `${ANALYTICS_PROVIDER}.item_id`]
  );
  const { registry } = registryComAnalytics([item('z1')]); // z2 tem identity (de antes) mas não aparece NESTE período
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'zero_provider' }, ...PERIODO });
  const z2 = r.items.find((x) => x.product.id === ids.get('z2'));
  assert.deepEqual({ ...z2.metrics }, { itemsViewed: 0, itemsAddedToCart: 0, itemsCheckedOut: 0, itemsPurchased: 0, itemRevenue: 0 });
  assert.equal(z2.identity.status, 'matched');
  assert.deepEqual(z2.diagnostics, []);
  assert.equal(z2.itemRatios.itemsAddedToCartPerItemViewed, null); // denominator 0 → null, nunca Infinity/NaN
}));

test('G · itemRatios: razão entre CONTAGENS DE ITEM (nunca conversão de usuário/sessão) — denominator > 0 calcula, denominator 0 vira null, nunca Infinity/NaN', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'rate_provider', [{ providerProductId: 'rt1' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'rate_provider' });
  const { registry } = registryComAnalytics([item('rt1', { itemsViewed: 200, itemsAddedToCart: 40, itemsCheckedOut: 10, itemsPurchased: 2, itemRevenue: 500 })]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'rate_provider' }, ...PERIODO });
  const l = r.items[0];
  assert.equal(l.itemRatios.itemsAddedToCartPerItemViewed, 40 / 200);
  assert.equal(l.itemRatios.itemsCheckedOutPerItemViewed, 10 / 200);
  assert.equal(l.itemRatios.itemsCheckedOutPerItemAddedToCart, 10 / 40);
  assert.equal(l.itemRatios.itemsPurchasedPerItemViewed, 2 / 200);
  for (const v of Object.values(l.itemRatios)) { assert.ok(Number.isFinite(v)); assert.notEqual(v, Infinity); }
  // Nomes explícitos: nenhum campo sugere "conversion"/"session"/"user" — são razões item/item.
  for (const nome of Object.keys(l.itemRatios)) {
    assert.match(nome, /^items[A-Za-z]+PerItem[A-Za-z]+$/);
    assert.doesNotMatch(nome.toLowerCase(), /conversion|session|user/);
  }
}));

test('G · métrica indisponível na propriedade (todas as linhas null) vira null no produto, com diagnóstico metric_unavailable', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'unavail_provider', [{ providerProductId: 'ua1' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'unavail_provider' });
  const { registry } = registryComAnalytics([item('ua1', { itemRevenue: null })]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'unavail_provider' }, ...PERIODO });
  assert.equal(r.items[0].metrics.itemRevenue, null);
  assert.equal(r.items[0].metrics.itemsViewed, 10);
  assert.ok(r.items[0].diagnostics.includes('metric_unavailable'));
}));

test('G · nenhuma classificação opinativa (CAMPEÃ/OPORTUNIDADE/REVISAR/FRACA) em lugar nenhum da resposta', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'op_provider', [{ providerProductId: 'op1' }]);
  const { registry } = registryComAnalytics([item('op1')]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'op_provider' }, ...PERIODO });
  const texto = JSON.stringify(r);
  for (const rotulo of ['CAMPEÃ', 'OPORTUNIDADE', 'REVISAR', 'FRACA', 'campeã', 'fraca']) assert.equal(texto.includes(rotulo), false);
}));

// ── Ordenação / paginação ─────────────────────────────────────────────────────────────────────

test('G · sort por métrica ordena por valor agregado, produtos sem dado (null) por último', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'sort_provider', [{ providerProductId: 's1' }, { providerProductId: 's2' }, { providerProductId: 's3' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'sort_provider' });
  const { registry } = registryComAnalytics([item('s1', { itemsViewed: 5 }), item('s2', { itemsViewed: 50 })]); // s3 sem dado
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'sort_provider' }, sort: { field: 'itemsViewed', direction: 'desc' }, ...PERIODO });
  assert.deepEqual(r.items.map((i) => i.product.providerProductId), ['s2', 's1']); // s3 não entra: nunca observado em analytics, sem identity resolvida neste namespace
}));

test('G · sort por campo do catálogo (name) usa paginação do banco, sem carregar o catálogo inteiro', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'cat_sort_provider', [{ providerProductId: 'cs1', name: 'Zebra' }, { providerProductId: 'cs2', name: 'Abelha' }]);
  const { registry } = registryComAnalytics([]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'cat_sort_provider' }, sort: { field: 'name', direction: 'asc' }, ...PERIODO });
  assert.deepEqual(r.items.map((i) => i.product.name), ['Abelha', 'Zebra']);
}));

test('G · sort por receita (itemRevenue) considera TODO o conjunto elegível da Store antes de paginar — top performer fora da 1ª página por nome aparece em 1º', () => em(ORG_A, STORE_A, async () => {
  // 5 produtos, nomes em ordem alfabética inversa da receita: o de MAIOR receita ("E...") cairia na
  // ÚLTIMA página se a ordenação só olhasse a página atual por nome (paginação limit=2).
  const nomes = ['A-baixa', 'B-baixa', 'C-media', 'D-alta', 'E-topo'];
  const produtos = nomes.map((n, i) => ({ providerProductId: `top${i}`, name: n }));
  await semearCatalogo(ORG_A, STORE_A, 'top_provider', produtos);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'top_provider' });
  const receitas = [10, 20, 30, 40, 500]; // "E-topo" (índice 4) é o maior, mas seria a última por nome
  const { registry } = registryComAnalytics(produtos.map((p, i) => item(p.providerProductId, { itemRevenue: receitas[i] })));
  const svc = montarServico(registry);
  const r1 = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'top_provider' }, sort: { field: 'itemRevenue', direction: 'desc' }, pagination: { limit: 2 }, ...PERIODO });
  assert.equal(r1.totalCount, 5); // conjunto elegível INTEIRO, não só a página
  assert.deepEqual(r1.items.map((i) => i.product.name), ['E-topo', 'D-alta']); // maior receita em 1º, mesmo fora da 1ª página alfabética
}));

test('G · sort por itemRatio (itemsAddedToCartPerItemViewed) funciona — antes era sempre null/sem efeito', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'ratio_sort_provider', [{ providerProductId: 'rs1' }, { providerProductId: 'rs2' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'ratio_sort_provider' });
  const { registry } = registryComAnalytics([
    item('rs1', { itemsViewed: 100, itemsAddedToCart: 5 }), // ratio 0.05
    item('rs2', { itemsViewed: 100, itemsAddedToCart: 80 }), // ratio 0.80
  ]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'ratio_sort_provider' }, sort: { field: 'itemsAddedToCartPerItemViewed', direction: 'desc' }, ...PERIODO });
  assert.deepEqual(r.items.map((i) => i.product.providerProductId), ['rs2', 'rs1']);
}));

test('G · sort por métrica: produto com identity resolvida mas zero atividade entra no conjunto elegível (zero real, não excluído)', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'zero_sort_provider', [{ providerProductId: 'zs1' }, { providerProductId: 'zs2' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'zero_sort_provider' });
  // zs2 tem identity resolvida de um período anterior, mas nenhuma linha AGORA.
  await sup.query(
    `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
     VALUES ($1, $2, $3, $4, 'zs2-anterior', 'rule', 'exact')`,
    [ORG_A, STORE_A, ids.get('zs2'), `${ANALYTICS_PROVIDER}.item_id`]
  );
  const { registry } = registryComAnalytics([item('zs1', { itemsViewed: 10 })]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'zero_sort_provider' }, sort: { field: 'itemsViewed', direction: 'desc' }, ...PERIODO });
  assert.equal(r.totalCount, 2); // zs2 entra (identity resolvida), com métrica zero — não fica de fora
  assert.deepEqual(r.items.map((i) => i.product.providerProductId), ['zs1', 'zs2']);
  const zs2 = r.items.find((i) => i.product.providerProductId === 'zs2');
  assert.equal(zs2.metrics.itemsViewed, 0);
}));

// ── "Mais dados primeiro" + filtros (rodada Desempenho de Produtos) ───────────────────────────────

// Métricas explícitas (o `item` padrão traz números que atrapalhariam as comparações de ordem).
const dados = (externalProductId, { v = 0, c = 0, k = 0, p = 0, r = 0 } = {}) => item(externalProductId, {
  itemsViewed: v, itemsAddedToCart: c, itemsCheckedOut: k, itemsPurchased: p, itemRevenue: r,
});
const consulta = (svc, filters, extra = {}) => svc.getProductPerformance({
  organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters, ...PERIODO, ...extra,
});
const nomes = (r) => r.items.map((i) => i.product.name);
const MAIS_DADOS = { field: 'data', direction: 'desc' };

async function catalogoDeDados(provider) {
  // Zeta e Beta têm dado (Beta mais); Alfa e Delta não foram observados pelo GA4.
  const ids = await semearCatalogo(ORG_A, STORE_A, provider, [
    { providerProductId: `${provider}-z`, name: 'Zeta' }, { providerProductId: `${provider}-b`, name: 'Beta' },
    { providerProductId: `${provider}-a`, name: 'Alfa' }, { providerProductId: `${provider}-d`, name: 'Delta' },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider });
  return ids;
}

test('D · mais dados primeiro: quem tem dado vem por volume; o RESTO do catálogo vem depois, por nome (nunca escondido)', () => em(ORG_A, STORE_A, async () => {
  await catalogoDeDados('md_provider');
  const { registry } = registryComAnalytics([dados('md_provider-z', { v: 5 }), dados('md_provider-b', { v: 50 })]);
  const r = await consulta(montarServico(registry), { provider: 'md_provider' }, { sort: MAIS_DADOS });
  assert.deepEqual(nomes(r), ['Beta', 'Zeta', 'Alfa', 'Delta']);
  assert.equal(r.totalCount, 4); // o catálogo todo, não só quem tem dado
  assert.equal(r.items[2].metrics, null); // Alfa: nunca observado — "—", nunca 0 inventado
}));

test('D · mais dados primeiro: volume = visualizações + carrinho + checkout + compras; empate desempata por compras, checkout, carrinho', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'md_tie', [
    { providerProductId: 'tie-x', name: 'X' }, { providerProductId: 'tie-y', name: 'Y' }, { providerProductId: 'tie-w', name: 'W' },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'md_tie' });
  const { registry } = registryComAnalytics([
    dados('tie-x', { v: 10 }), // volume 10, 0 compras
    dados('tie-y', { v: 9, p: 1 }), // volume 10, 1 compra → à frente de X
    dados('tie-w', { v: 1, c: 1, k: 1, p: 1, r: 9999 }), // volume 4: a receita NÃO entra no volume
  ]);
  const r = await consulta(montarServico(registry), { provider: 'md_tie' }, { sort: MAIS_DADOS });
  assert.deepEqual(nomes(r), ['Y', 'X', 'W']);
}));

test('D · mais dados primeiro: a página atravessa a fronteira ranqueados → cauda sem repetir nem perder produto', () => em(ORG_A, STORE_A, async () => {
  await catalogoDeDados('md_pag');
  const { registry } = registryComAnalytics([dados('md_pag-z', { v: 5 }), dados('md_pag-b', { v: 50 })]);
  const svc = montarServico(registry);

  // limit 3 → [Beta, Zeta | Alfa] e depois [Delta]
  const p1 = await consulta(svc, { provider: 'md_pag' }, { sort: MAIS_DADOS, pagination: { limit: 3 } });
  assert.deepEqual(nomes(p1), ['Beta', 'Zeta', 'Alfa']);
  assert.equal(p1.nextCursor, '2');
  const p2 = await consulta(svc, { provider: 'md_pag' }, { sort: MAIS_DADOS, pagination: { limit: 3, cursor: p1.nextCursor } });
  assert.deepEqual(nomes(p2), ['Delta']);
  assert.equal(p2.nextCursor, null);

  // limit 1 → uma por página, na ordem exata, cursor encadeado até acabar
  const vistos = [];
  let cursor;
  for (let i = 0; i < 6; i += 1) {
    const p = await consulta(svc, { provider: 'md_pag' }, { sort: MAIS_DADOS, pagination: { limit: 1, cursor } });
    vistos.push(...nomes(p));
    assert.equal(p.totalCount, 4);
    cursor = p.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(vistos, ['Beta', 'Zeta', 'Alfa', 'Delta']);
  assert.equal(cursor, null);
}));

test('D · mais dados primeiro: sem NENHUM produto com dado no período, é o catálogo por nome (a tela nunca fica vazia por isso)', () => em(ORG_A, STORE_A, async () => {
  await catalogoDeDados('md_vazio');
  const { registry } = registryComAnalytics([dados('id-que-nao-e-de-produto-nenhum', { v: 99 })]);
  const r = await consulta(montarServico(registry), { provider: 'md_vazio' }, { sort: MAIS_DADOS });
  assert.deepEqual(nomes(r), ['Alfa', 'Beta', 'Delta', 'Zeta']);
  assert.equal(r.totalCount, 4);
}));

test('D · mais dados primeiro num período SEM linha de analytics: cai no catálogo por nome, com insufficient_data', () => em(ORG_A, STORE_A, async () => {
  await catalogoDeDados('md_semga');
  const { registry } = registryComAnalytics([]);
  const r = await consulta(montarServico(registry), { provider: 'md_semga' }, { sort: MAIS_DADOS });
  assert.deepEqual(nomes(r), ['Alfa', 'Beta', 'Delta', 'Zeta']);
  assert.ok(r.items.every((i) => i.diagnostics.includes('insufficient_data')));
}));

test('D · status: padrão só ativos; inactive só desativados; all os dois — com dado ou sem', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'st_provider', [
    { providerProductId: 'st-on', name: 'Ativo' }, { providerProductId: 'st-off', name: 'Desativado' }, { providerProductId: 'st-off2', name: 'Desativado sem dado' },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'st_provider' });
  await sup.query('UPDATE commerce_products SET is_active = false WHERE id = ANY($1::uuid[])', [[ids.get('st-off'), ids.get('st-off2')]]);
  const { registry } = registryComAnalytics([dados('st-on', { v: 3 }), dados('st-off', { v: 30 })]);
  const svc = montarServico(registry);
  const porStatus = async (status, sort) => nomes(await consulta(svc, { provider: 'st_provider', status }, { sort }));

  for (const sort of [MAIS_DADOS, { field: 'name', direction: 'asc' }, undefined]) {
    assert.deepEqual(await porStatus(undefined, sort), ['Ativo'], `padrão (${sort && sort.field})`);
    assert.deepEqual((await porStatus('inactive', sort)).sort(), ['Desativado', 'Desativado sem dado'], `inactive (${sort && sort.field})`);
    assert.deepEqual((await porStatus('all', sort)).sort(), ['Ativo', 'Desativado', 'Desativado sem dado'], `all (${sort && sort.field})`);
  }
  // Ordenar por MÉTRICA continua só com quem tem identity no GA4 (contrato da Fase G.1): o desativado
  // SEM dado nunca foi observado, então não entra — mas o desativado com dado entra, e status vale.
  const porMetrica = { field: 'itemsViewed', direction: 'desc' };
  assert.deepEqual(await porStatus(undefined, porMetrica), ['Ativo']);
  assert.deepEqual(await porStatus('inactive', porMetrica), ['Desativado']);
  assert.deepEqual(await porStatus('all', porMetrica), ['Desativado', 'Ativo']);
  // mais dados primeiro dentro de "all": o desativado COM dado (30) vem antes do ativo (3)
  assert.deepEqual(await porStatus('all', MAIS_DADOS), ['Desativado', 'Ativo', 'Desativado sem dado']);
  const linha = (await consulta(svc, { provider: 'st_provider', status: 'inactive' })).items[0];
  assert.equal(linha.product.isActive, false); // a tela consegue rotular o desativado
}));

test('D · status inválido é erro do service (nunca vira "ativos" em silêncio)', () => em(ORG_A, STORE_A, async () => {
  const { registry } = registryComAnalytics([]);
  await assert.rejects(consulta(montarServico(registry), { status: 'ativos' }), TypeError);
}));

test('D · mínimo de comprados com ordenação por nome: o banco ordena, só passa quem tem >= o mínimo, total é dos que passaram', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'mn_provider', [
    { providerProductId: 'mn-1', name: 'Nenhuma' }, { providerProductId: 'mn-2', name: 'Duas' }, { providerProductId: 'mn-3', name: 'Cinco' }, { providerProductId: 'mn-4', name: 'Sem dado' },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'mn_provider' });
  const { registry } = registryComAnalytics([dados('mn-1', { v: 100 }), dados('mn-2', { v: 10, p: 2 }), dados('mn-3', { v: 8, p: 5 })]);
  const svc = montarServico(registry);
  const r = await consulta(svc, { provider: 'mn_provider', minPurchased: 2 }, { sort: { field: 'name', direction: 'asc' } });
  assert.deepEqual(nomes(r), ['Cinco', 'Duas']); // exatamente no limite (2) passa
  assert.equal(r.totalCount, 2);
  const pag = await consulta(svc, { provider: 'mn_provider', minPurchased: 2 }, { sort: { field: 'name', direction: 'asc' }, pagination: { limit: 1 } });
  assert.deepEqual(nomes(pag), ['Cinco']);
  assert.equal(pag.nextCursor, '2');
}));

test('D · mínimos combinam (E): checkout >= 2 e receita >= 50; produto sem dado e métrica nula ficam de fora', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'cb_provider', [
    { providerProductId: 'cb-1', name: 'Passa' }, { providerProductId: 'cb-2', name: 'Pouca receita' }, { providerProductId: 'cb-3', name: 'Pouco checkout' },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'cb_provider' });
  const { registry } = registryComAnalytics([
    dados('cb-1', { v: 9, k: 2, r: 50 }), dados('cb-2', { v: 9, k: 5, r: 49.9 }), dados('cb-3', { v: 9, k: 1, r: 500 }),
  ]);
  const r = await consulta(montarServico(registry), { provider: 'cb_provider', minCheckedOut: 2, minRevenue: 50 }, { sort: MAIS_DADOS });
  assert.deepEqual(nomes(r), ['Passa']);
}));

test('D · filtro de métrica com "mais dados primeiro" não traz a cauda (produto sem dado não satisfaz "mínimo de X")', () => em(ORG_A, STORE_A, async () => {
  await catalogoDeDados('md_filtro');
  const { registry } = registryComAnalytics([dados('md_filtro-z', { v: 5, p: 1 }), dados('md_filtro-b', { v: 50 })]);
  const svc = montarServico(registry);
  const r = await consulta(svc, { provider: 'md_filtro', minPurchased: 1 }, { sort: MAIS_DADOS });
  assert.deepEqual(nomes(r), ['Zeta']);
  assert.equal(r.totalCount, 1);
  assert.equal(r.nextCursor, null);
  const semTail = await consulta(svc, { provider: 'md_filtro', hasData: true }, { sort: MAIS_DADOS });
  assert.deepEqual(nomes(semTail), ['Beta', 'Zeta']); // "somente com dados": Alfa e Delta (sem dado) saem
}));

test('D · filtro de métrica combina com ordenação por outra métrica', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'fm_provider', [
    { providerProductId: 'fm-1', name: 'Um' }, { providerProductId: 'fm-2', name: 'Dois' }, { providerProductId: 'fm-3', name: 'Três' },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'fm_provider' });
  const { registry } = registryComAnalytics([dados('fm-1', { v: 5, p: 1, r: 10 }), dados('fm-2', { v: 5, p: 3, r: 300 }), dados('fm-3', { v: 5, p: 0, r: 999 })]);
  const r = await consulta(montarServico(registry), { provider: 'fm_provider', minPurchased: 1 }, { sort: { field: 'itemRevenue', direction: 'desc' } });
  assert.deepEqual(nomes(r), ['Dois', 'Um']);
}));

test('D · métrica indisponível na propriedade (null) nunca satisfaz um mínimo > 0', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'nl_provider', [{ providerProductId: 'nl-1', name: 'Sem compras medidas' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'nl_provider' });
  const { registry } = registryComAnalytics([item('nl-1', { itemsViewed: 40, itemsPurchased: null })]);
  const svc = montarServico(registry);
  assert.equal((await consulta(svc, { provider: 'nl_provider', minPurchased: 1 })).totalCount, 0);
  assert.equal((await consulta(svc, { provider: 'nl_provider', minViewed: 1 })).totalCount, 1); // outra métrica segue valendo
}));

test('D · ninguém satisfaz o filtro: resposta vazia e honesta (totalCount 0), nunca erro — inclusive sem analytics no período', () => em(ORG_A, STORE_A, async () => {
  await catalogoDeDados('vz_provider');
  const { registry } = registryComAnalytics([dados('vz_provider-z', { v: 5 })]);
  const r = await consulta(montarServico(registry), { provider: 'vz_provider', minPurchased: 1000 }, { sort: MAIS_DADOS });
  assert.deepEqual(r.items, []);
  assert.equal(r.totalCount, 0);
  assert.equal(r.nextCursor, null);

  const { registry: semGa } = registryComAnalytics([]);
  const s = await consulta(montarServico(semGa), { provider: 'vz_provider', minViewed: 1 });
  assert.deepEqual(s.items, []);
  assert.equal(s.totalCount, 0);
  assert.equal(s.coverage.status, 'insufficient_data'); // o "porquê" segue no coverage
}));

test('D · isolamento: mais dados primeiro nunca mistura produto de outro provider nem de outra Organization', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'iso_a', [{ providerProductId: 'isoa-1', name: 'Do A' }]);
  await semearCatalogo(ORG_A, STORE_A, 'iso_b', [{ providerProductId: 'isob-1', name: 'Do B' }]);
  await em(ORG_B, STORE_B, () => semearCatalogo(ORG_B, STORE_B, 'iso_a', [{ providerProductId: 'isoa-1', name: 'De outra Organization' }]));
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'iso_a' });
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'iso_b' });
  const { registry } = registryComAnalytics([dados('isoa-1', { v: 7 }), dados('isob-1', { v: 70 })]);
  const r = await consulta(montarServico(registry), { provider: 'iso_a' }, { sort: MAIS_DADOS });
  assert.deepEqual(nomes(r), ['Do A']);
}));

// ── Isolamento ────────────────────────────────────────────────────────────────────────────────

test('G · Organization isolation: A não vê produto de B mesmo com o mesmo external id observado', async () => {
  await em(ORG_A, STORE_A, () => semearCatalogo(ORG_A, STORE_A, 'iso_pps_provider', [{ providerProductId: 'ip1' }]));
  await em(ORG_B, STORE_B, () => semearCatalogo(ORG_B, STORE_B, 'iso_pps_provider', [{ providerProductId: 'ip1' }]));
  const { registry: regA } = registryComAnalytics([item('ip1')]);
  const svcA = montarServico(regA, pool());
  const rA = await em(ORG_A, STORE_A, () => svcA.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'iso_pps_provider' }, ...PERIODO }));
  assert.equal(rA.items.length, 1);
  const { rows } = await sup.query(`SELECT organization_id FROM commerce_products WHERE id = $1`, [rA.items[0].product.id]);
  assert.equal(rows[0].organization_id, ORG_A);
});

test('G · provider isolation: filters.provider restringe ao catálogo daquele provider só', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'prov_x', [{ providerProductId: 'px1' }]);
  await semearCatalogo(ORG_A, STORE_A, 'prov_y', [{ providerProductId: 'py1' }]);
  const { registry } = registryComAnalytics([]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'prov_x' }, ...PERIODO });
  assert.deepEqual(r.items.map((i) => i.product.providerProductId), ['px1']);
}));

// ── H · getProductPerformanceById (detalhe do produto) ───────────────────────────────────────────

test('H · getProductPerformanceById devolve a MESMA linha que apareceria na listagem, sem chamada de analytics extra', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'detail_provider', [{ providerProductId: 'd1' }, { providerProductId: 'd2' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'detail_provider' });
  const { registry, chamadasFeitas } = registryComAnalytics([item('d1', { itemsViewed: 40, itemsAddedToCart: 8 })]);
  const svc = montarServico(registry);
  const lista = await svc.getProductPerformance({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'detail_provider' }, ...PERIODO });
  const detalhe = await svc.getProductPerformanceById({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, productId: ids.get('d1'), ...PERIODO });
  assert.equal(chamadasFeitas(), 1); // cache reaproveitado — nunca 1 relatório a mais pro detalhe
  const daLista = lista.items.find((i) => i.product.id === ids.get('d1'));
  assert.deepEqual({ ...detalhe.metrics }, { ...daLista.metrics });
  assert.deepEqual({ ...detalhe.itemRatios }, { ...daLista.itemRatios });
  assert.equal(detalhe.identity.status, 'matched');
}));

test('H · getProductPerformanceById: produto inexistente na Store devolve null (a rota decide o 404)', () => em(ORG_A, STORE_A, async () => {
  const { registry } = registryComAnalytics([]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformanceById({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, productId: 'ab000000-0000-4000-8000-000000000999', ...PERIODO });
  assert.equal(r, null);
}));

test('H · getProductPerformanceById: sem identity resolvida vira unmatched_identity (nunca erro)', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'detail_unm_provider', [{ providerProductId: 'du1' }]);
  const { registry } = registryComAnalytics([item('id-nao-relacionado')]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformanceById({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, productId: ids.get('du1'), ...PERIODO });
  assert.equal(r.identity.status, 'unmatched');
  assert.deepEqual(r.diagnostics, ['unmatched_identity']);
}));

test('H · getProductPerformanceById: período sem nenhum dado de analytics vira insufficient_data', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'detail_vazio_provider', [{ providerProductId: 'dv1' }]);
  const { registry } = registryComAnalytics([]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformanceById({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, productId: ids.get('dv1'), ...PERIODO });
  assert.deepEqual(r.diagnostics, ['insufficient_data']);
}));

test('H · getProductPerformanceById: identity resolvida mas zero atividade no período é zero real', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'detail_zero_provider', [{ providerProductId: 'dz1' }]);
  await sup.query(
    `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
     VALUES ($1, $2, $3, $4, 'dz1-anterior', 'rule', 'exact')`,
    [ORG_A, STORE_A, ids.get('dz1'), `${ANALYTICS_PROVIDER}.item_id`]
  );
  const { registry } = registryComAnalytics([item('outro-id-qualquer')]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformanceById({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, productId: ids.get('dz1'), ...PERIODO });
  assert.deepEqual({ ...r.metrics }, { itemsViewed: 0, itemsAddedToCart: 0, itemsCheckedOut: 0, itemsPurchased: 0, itemRevenue: 0 });
  assert.equal(r.identity.status, 'matched');
}));

test('H · getProductPerformanceById: Organization isolation — produto de outra Organization não é encontrado', async () => {
  const idsB = await em(ORG_B, STORE_B, () => semearCatalogo(ORG_B, STORE_B, 'detail_iso_provider', [{ providerProductId: 'di1' }]));
  const { registry } = registryComAnalytics([]);
  const svc = montarServico(registry, pool());
  const r = await em(ORG_A, STORE_A, () => svc.getProductPerformanceById({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, productId: idsB.get('di1'), ...PERIODO }));
  assert.equal(r, null);
});

// ── H · ReportCache invalidado por escopo (ex.: propriedade GA4 trocada) ─────────────────────────

test('H · ReportCache: escopo (ex.: property) diferente busca de novo, mesmo com org/store/provider/período iguais', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'escopo_provider', [{ providerProductId: 'e1' }]);
  const { registry, chamadasFeitas, chamadasDeEscopoFeitas } = registryComAnalytics([item('e1')], { cacheScope: (n) => (n <= 1 ? 'property-A' : 'property-B') });
  const svc = montarServico(registry);
  const entrada = { organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'escopo_provider' }, ...PERIODO };
  await svc.getProductPerformance(entrada);
  await svc.getProductPerformance(entrada);
  assert.equal(chamadasDeEscopoFeitas(), 2); // getCacheScope é barato e roda em toda chamada, hit ou miss
  assert.equal(chamadasFeitas(), 2); // escopo mudou (property-A → property-B): nunca reaproveita
}));

test('H · ReportCache: MESMO escopo reaproveita normalmente (getCacheScope não desliga o cache)', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'escopo_fixo_provider', [{ providerProductId: 'ef1' }]);
  const { registry, chamadasFeitas } = registryComAnalytics([item('ef1')], { cacheScope: 'property-fixa' });
  const svc = montarServico(registry);
  const entrada = { organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'escopo_fixo_provider' }, ...PERIODO };
  await svc.getProductPerformance(entrada);
  await svc.getProductPerformance(entrada);
  assert.equal(chamadasFeitas(), 1);
}));

// ── J.4 · getProductPerformanceSummary (totais store-wide) ───────────────────────────────────────

// Ids externos com prefixo `j4-` — únicos no arquivo de propósito (achado real: 's1'/'s2'/'c1' já
// eram usados por testes mais antigos no MESMO ORG_A/STORE_A/namespace 'fake_ga4.item_id', e o
// UNIQUE de product_external_identities é por (organization_id, store_id, namespace, external_id) —
// reusar o id fazia o INSERT novo ser descartado por ON CONFLICT DO NOTHING, apontando pro produto
// do teste ANTIGO. Falha real de isolamento de teste, não do código de produção.
test('J.4 · summary: observed soma TODA linha do relatório; matched só o que resolveu a produto canônico', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'summary_provider', [{ providerProductId: 'j4-s1' }, { providerProductId: 'j4-s2' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'summary_provider' });
  const { registry } = registryComAnalytics([
    item('j4-s1', { itemsViewed: 100, itemsAddedToCart: 10, itemsCheckedOut: 5, itemsPurchased: 2, itemRevenue: 50 }),
    item('j4-s2', { itemsViewed: 50, itemsAddedToCart: 5, itemsCheckedOut: 2, itemsPurchased: 1, itemRevenue: 20 }),
    item('j4-orfao-sem-produto', { itemsViewed: 30, itemsAddedToCart: 3, itemsCheckedOut: 1, itemsPurchased: 0, itemRevenue: 0 }),
  ]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformanceSummary({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'summary_provider' }, ...PERIODO });
  // observed: soma de TODAS as 3 linhas, resolvida ou não.
  assert.equal(r.observed.itemsViewed, 180);
  assert.equal(r.observed.itemsPurchased, 3);
  // matched: só s1+s2 (o órfão nunca resolveu a produto nenhum).
  assert.equal(r.matched.itemsViewed, 150);
  assert.equal(r.matched.itemsPurchased, 3);
  assert.equal(r.coverage.observedAnalyticsIds, 3);
  assert.equal(r.coverage.matchedAnalyticsIds, 2);
  assert.equal(r.coverage.unmatchedAnalyticsIds, 1);
}));

test('J.4 · summary: produto com múltiplos ids (produto+variante+sku) soma as linhas dele, nunca conta como 2 produtos', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'summary_multi_provider', [
    { providerProductId: 'j4-m1', variants: [{ providerVariantId: 'j4-mv1', sku: 'J4SKU-1' }] },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'summary_multi_provider' });
  const { registry } = registryComAnalytics([
    item('j4-m1', { itemsViewed: 10 }), item('j4-mv1', { itemsViewed: 5 }), item('J4SKU-1', { itemsViewed: 3 }),
  ]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformanceSummary({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'summary_multi_provider' }, ...PERIODO });
  assert.equal(r.observed.itemsViewed, 18); // 10+5+3, sem duplicar como se fossem produtos diferentes
  assert.equal(r.matched.itemsViewed, 18); // os 3 ids resolvem pro MESMO produto — soma igual
  assert.equal(r.coverage.matchedAnalyticsIds, 3); // 3 ids resolvidos, 1 produto só
}));

test('J.4 · summary: métrica indisponível na propriedade vira null nos DOIS grupos, nunca 0', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'summary_unavail_provider', [{ providerProductId: 'j4-u1' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'summary_unavail_provider' });
  const { registry } = registryComAnalytics([item('j4-u1', { itemRevenue: null })]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformanceSummary({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'summary_unavail_provider' }, ...PERIODO });
  assert.equal(r.observed.itemRevenue, null);
  assert.equal(r.matched.itemRevenue, null);
  assert.equal(r.observed.itemsViewed, 10); // outras métricas continuam normais
}));

test('J.4 · summary: período sem nenhuma linha de analytics vira insufficient_data, observed/matched null', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'summary_vazio_provider', [{ providerProductId: 'j4-v1' }]);
  const { registry } = registryComAnalytics([]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformanceSummary({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'summary_vazio_provider' }, ...PERIODO });
  assert.equal(r.observed, null);
  assert.equal(r.matched, null);
  assert.equal(r.coverage.status, 'insufficient_data');
}));

test('J.4 · summary: filters.provider restringe "matched" a produtos daquele provider (observed continua sem filtro)', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'summary_prov_x', [{ providerProductId: 'j4-px1' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'summary_prov_x' });
  const { registry } = registryComAnalytics([item('j4-px1', { itemsViewed: 40 })]);
  const svc = montarServico(registry);
  const r = await svc.getProductPerformanceSummary({ organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'prov_y_nao_tem_nada' }, ...PERIODO });
  assert.equal(r.observed.itemsViewed, 40); // observed nunca filtra por provider do catálogo
  assert.equal(r.matched.itemsViewed, 0); // matched: filtrado pro provider errado, zero elegível
}));

test('J.4 · summary reaproveita o MESMO relatório cacheado que /products — sem chamada de analytics extra', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'summary_cache_provider', [{ providerProductId: 'j4-c1' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'summary_cache_provider' });
  const { registry, chamadasFeitas } = registryComAnalytics([item('j4-c1')]);
  const svc = montarServico(registry);
  const entrada = { organizationId: ORG_A, storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, filters: { provider: 'summary_cache_provider' }, ...PERIODO };
  await svc.getProductPerformance(entrada);
  await svc.getProductPerformanceSummary(entrada);
  assert.equal(chamadasFeitas(), 1); // 2ª chamada (summary) reaproveita o cache do relatório da 1ª
}));

// ── Guardas estáticas: nenhum import de Ink, GA4 concreto ou pedidos_ink ────────────────────────

const ARQUIVOS_G = [
  path.join(__dirname, '..', '..', 'lib', 'product-analytics', 'product-performance-service.js'),
  path.join(__dirname, '..', '..', 'lib', 'product-analytics', 'commerce-catalog-repository.js'),
];

test('G · nenhum import de Ink, cliente GA4 concreto ou pedidos_ink no service/repository', () => {
  const achados = [];
  for (const arq of ARQUIVOS_G) {
    fs.readFileSync(arq, 'utf8').split('\n').forEach((l, i) => {
      if (l.trimStart().startsWith('//')) return;
      if (/reserva[_-]?ink|InkClient|inkApi|Ga4Client|require\([^)]*ga4\/client['"]\)|pedidos_ink\b/i.test(l)) {
        achados.push(`${path.basename(arq)}:${i + 1}: ${l.trim()}`);
      }
    });
  }
  assert.deepEqual(achados, []);
});
