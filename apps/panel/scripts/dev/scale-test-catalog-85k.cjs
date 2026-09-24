'use strict';

// Rodada "preparação do piloto" · teste de escala DIRECIONADO — simula um catálogo de ~85 mil
// produtos (o número usado em toda a documentação desde a Fase D como o piloto real) contra um
// registry FAKE (nunca a API real da Ink — só a forma do contrato, `listProductsWithVariants`
// paginado a 100/página, o mesmo limite que catalog-sync.js já usa de verdade) e Postgres real
// (efêmero, descartado no final). Mede tempo, memória e volume de queries de cada fase:
//
//   1. runCatalogSync            — full sync do catálogo (Gate A)
//   2. bootstrapCommerceIdentities — identity em lote (Gate B)
//   3. opportunityDiagnosticsService.getOpportunities — o endpoint que o lojista realmente abre
//
// Nunca faz asserção pass/fail (não é um teste de correção — essas já existem, com fixtures
// pequenos, em catalog-sync.test.js/product-identity-resolver.test.js/opportunity-diagnostics.
// test.js). Este script só IMPRIME um relatório — a leitura humana decide se algum número aqui é
// motivo de bloqueio antes do piloto.
//
// Uso:
//   node --expose-gc scripts/test-db.mjs run -- node --expose-gc scripts/dev/scale-test-catalog-85k.cjs
//   (--expose-gc é opcional — sem ele, a medição de memória é só heapUsed/rss antes/depois, sem
//   forçar coleta; com ele, cada fase começa de um heap mais previsível)
//
// Variáveis opcionais: SCALE_PRODUTOS (default 85000), SCALE_OBSERVADOS_GA4 (default 20000 — quantos
// itemIds o GA4 "observa" no período, sempre <= SCALE_PRODUTOS), SCALE_PEDIDOS_PAGOS (default 2000).

const path = require('node:path');
const crypto = require('node:crypto');

const RAIZ = path.resolve(__dirname, '..', '..');
const h = require(path.join(RAIZ, 'test/invariants/harness.js'));
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createConnectorRegistry } = h.sujeito('lib/connectors/registry.js');
const { createJobLeases } = h.sujeito('lib/platform/leases.js');
const { runCatalogSync } = h.sujeito('lib/product-analytics/catalog-sync.js');
const { bootstrapCommerceIdentities } = h.sujeito('lib/product-analytics/product-identity-resolver.js');
const { createCommerceCatalogRepository } = h.sujeito('lib/product-analytics/commerce-catalog-repository.js');
const { createProductPerformanceService } = h.sujeito('lib/product-analytics/product-performance-service.js');
const { createReconciliationService } = h.sujeito('lib/product-analytics/reconciliation.js');
const { createOpportunityDiagnosticsService } = h.sujeito('lib/product-analytics/opportunity-diagnostics.js');

const N_PRODUTOS = Number(process.env.SCALE_PRODUTOS) || 85000;
const N_OBSERVADOS_GA4 = Math.min(Number(process.env.SCALE_OBSERVADOS_GA4) || 20000, N_PRODUTOS);
const N_PEDIDOS_PAGOS = Number(process.env.SCALE_PEDIDOS_PAGOS) || 2000;
const POR_PAGINA = 100; // mesmo limite que catalog-sync.js usa de verdade — nunca um número de teste

const PROVIDER = 'reserva_ink';
const ANALYTICS_PROVIDER = 'ga4';
const ORG = crypto.randomUUID();
const STORE = crypto.randomUUID();

function mb(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)}MB`; }

function medidor(pool) {
  const contagem = new Map();
  const original = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    const primeiraLinha = String(sql).trim().split('\n')[0].trim().slice(0, 60);
    contagem.set(primeiraLinha, (contagem.get(primeiraLinha) || 0) + 1);
    return original(sql, params);
  };
  return {
    total: () => [...contagem.values()].reduce((a, b) => a + b, 0),
    detalhe: () => [...contagem.entries()].sort((a, b) => b[1] - a[1]),
    resetar: () => contagem.clear(),
  };
}

async function fase(nome, fn) {
  if (global.gc) global.gc();
  const memAntes = process.memoryUsage();
  const t0 = process.hrtime.bigint();
  const resultado = await fn();
  const t1 = process.hrtime.bigint();
  if (global.gc) global.gc();
  const memDepois = process.memoryUsage();
  const ms = Number(t1 - t0) / 1e6;
  return {
    nome, ms, resultado,
    heapUsedAntes: memAntes.heapUsed, heapUsedDepois: memDepois.heapUsed,
    heapDelta: memDepois.heapUsed - memAntes.heapUsed,
    rssAntes: memAntes.rss, rssDepois: memDepois.rss,
  };
}

// ── Fake commerce connector — gera a página SOB DEMANDA (nunca materializa os 85k de uma vez na
// memória do próprio script, que distorceria a medição de memória do CÓDIGO SOB TESTE). ──
function registryComercioFake() {
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: false, variants: false, productsWithVariants: true, orders: true, refunds: false, productCosts: false },
    create: () => ({
      async listProductsWithVariants({ cursor }) {
        const pagina = cursor ? Number(cursor) : 1;
        const inicio = (pagina - 1) * POR_PAGINA;
        if (inicio >= N_PRODUTOS) return { items: [], nextCursor: null };
        const fim = Math.min(inicio + POR_PAGINA, N_PRODUTOS);
        const items = [];
        for (let n = inicio; n < fim; n += 1) {
          items.push({
            product: {
              providerProductId: String(n), name: `Produto ${n}`, slug: null, imageUrl: null, productUrl: null,
              productType: n % 5 === 0 ? 'Camiseta' : 'Bermuda', price: 50 + (n % 200), promotionalPrice: null,
              visible: true, metadata: { origem: 'scale-test' },
            },
            // Ids de variante ÚNICOS globalmente (n*10+1 / n*10+2) — o achado da rodada anterior
            // (colisão de variant_id entre produtos no mock compartilhado) nunca se repete aqui.
            variants: [
              { providerVariantId: String(n * 10 + 1), sku: `SKU-${n}-P`, color: null, size: 'P', model: null, metadata: {} },
              { providerVariantId: String(n * 10 + 2), sku: `SKU-${n}-M`, color: null, size: 'M', model: null, metadata: {} },
            ],
          });
        }
        return { items, nextCursor: fim < N_PRODUTOS ? String(pagina + 1) : null };
      },
      async listOrders({ cursor, limit = 200 }) {
        const pagina = cursor ? Number(cursor) : 1;
        const inicio = (pagina - 1) * limit;
        if (inicio >= N_PEDIDOS_PAGOS) return { items: [], nextCursor: null };
        const fim = Math.min(inicio + limit, N_PEDIDOS_PAGOS);
        const items = [];
        for (let n = inicio; n < fim; n += 1) {
          // Cada pedido paga por 1 unidade de um produto espalhado pelo catálogo (n * 37 — primo,
          // espalha sem repetir padrão óbvio) — nunca todos os pedidos no mesmo produto.
          const providerProductId = String((n * 37) % N_PRODUTOS);
          items.push({
            id: `pedido-${n}`, organizationId: ORG, storeId: STORE, provider: PROVIDER, providerOrderId: String(n),
            status: 'delivered', paymentStatus: 'paid', isPaid: true, isRefunded: false, totalValue: 89.9,
            createdAt: new Date(), paidAt: new Date(),
            items: [{ providerProductId, commerceProductId: null, quantity: 1, unitValue: 89.9, totalValue: 89.9 }],
          });
        }
        return { items, nextCursor: fim < N_PEDIDOS_PAGOS ? String(pagina + 1) : null };
      },
      async getOrder() { return null; },
    }),
  });
  return registry;
}

// GA4 fake: observa N_OBSERVADOS_GA4 itemIds distintos, cada um = o providerProductId de um produto
// real (garante cobertura resolvível). Devolve tudo numa chamada só (mesmo contrato do connector
// real — o service NUNCA pagina o relatório de analytics em si, só o catálogo).
function registryAnalyticsFake() {
  const registry = createConnectorRegistry();
  const linhas = [];
  for (let n = 0; n < N_OBSERVADOS_GA4; n += 1) {
    linhas.push({
      externalProductId: String(n), externalProductName: `Produto ${n}`,
      itemsViewed: 50 + (n % 500), itemsAddedToCart: 5 + (n % 40), itemsCheckedOut: 2 + (n % 15), itemsPurchased: 1 + (n % 6),
      itemRevenue: 89.9 * (1 + (n % 6)), analyticsProvider: ANALYTICS_PROVIDER,
    });
  }
  registry.register({
    domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ({ getProductPerformance: async () => linhas, getCacheScope: async () => null }),
  });
  return registry;
}

async function main() {
  console.log(`\n=== Teste de escala — catálogo simulado ===`);
  console.log(`Produtos: ${N_PRODUTOS} (${Math.ceil(N_PRODUTOS / POR_PAGINA)} páginas de ${POR_PAGINA})`);
  console.log(`Itens observados pelo GA4 (fake): ${N_OBSERVADOS_GA4}`);
  console.log(`Pedidos pagos (fake): ${N_PEDIDOS_PAGOS}`);
  console.log(`--expose-gc: ${global.gc ? 'ativo (medição de memória mais estável)' : 'INATIVO — rode com --expose-gc pra números mais confiáveis'}\n`);

  const db = await h.criarBancoDescartavel('oria_escala_85k');
  const r = h.migrar(db.url);
  if (r.status !== 0) throw new Error(`migrations falharam: ${r.stdout}${r.stderr}`);
  const role = `oria_app_escala_${crypto.randomBytes(4).toString('hex')}`;
  const senhaRole = crypto.randomBytes(16).toString('hex');
  const sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role, senha: senhaRole, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  const appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, role, senhaRole), { max: 8 });
  const fachada = runtime.criarPoolTenant(appPoolReal);
  const leases = createJobLeases({ poolReal: appPoolReal, dono: 'scale-test' });

  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [ORG, 'Escala 85k']);
  await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [STORE, ORG, 'Escala 85k']);

  const medidorQueries = medidor(fachada);
  const relatorio = [];

  await runtime.comContexto({ organizationId: ORG, storeId: STORE, origem: 'scale-test' }, async () => {
    // ── Fase 1: runCatalogSync ──────────────────────────────────────────────────────────────────
    const registryComercio = registryComercioFake();
    medidorQueries.resetar();
    const f1 = await fase('1. runCatalogSync (full sync)', () => runCatalogSync(
      { pool: fachada, registry: registryComercio, leases, logger: { warn() {}, error(m) { console.error(m); } } },
      { organizationId: ORG, storeId: STORE, provider: PROVIDER }
    ));
    relatorio.push({ ...f1, queries: medidorQueries.total(), queriesDetalhe: medidorQueries.detalhe() });
    console.log(`✔ runCatalogSync: ${f1.ms.toFixed(0)}ms · status=${f1.resultado.status} · páginas=${f1.resultado.pagesProcessed} · produtos inseridos=${f1.resultado.productsInserted} · variantes inseridas=${f1.resultado.variantsInserted} · heap Δ${mb(f1.heapDelta)} · ${medidorQueries.total()} queries`);
    if (f1.resultado.status !== 'success') {
      console.error(`  ATENÇÃO: sync não terminou com sucesso (${f1.resultado.status}) — fases seguintes rodam mesmo assim, mas o resultado não é representativo.`);
    }

    // ── Fase 2: bootstrapCommerceIdentities ────────────────────────────────────────────────────
    medidorQueries.resetar();
    const f2 = await fase('2. bootstrapCommerceIdentities', () => bootstrapCommerceIdentities({ pool: fachada }, { organizationId: ORG, storeId: STORE, provider: PROVIDER }));
    relatorio.push({ ...f2, queries: medidorQueries.total(), queriesDetalhe: medidorQueries.detalhe() });
    console.log(`✔ bootstrapCommerceIdentities: ${f2.ms.toFixed(0)}ms · product=${f2.resultado.productIdentities} variant=${f2.resultado.variantIdentities} sku=${f2.resultado.skuIdentities} · heap Δ${mb(f2.heapDelta)} · ${medidorQueries.total()} queries`);

    // ── Fase 3: GET /journey/opportunities (via opportunityDiagnosticsService direto) ──────────
    // Registry único com os dois domains (commerce + analytics) — mesma composição real
    // (composition.js registra os dois no MESMO registry); os connectors delegam pros fakes já
    // criados acima, nunca uma terceira implementação.
    const registryAnalytics = registryAnalyticsFake();
    const registryFinal = createConnectorRegistry();
    registryFinal.register({
      domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
      capabilities: { products: false, variants: false, productsWithVariants: true, orders: true, refunds: false, productCosts: false },
      create: () => registryComercio.resolve('commerce', PROVIDER, { organizationId: ORG, storeId: STORE }).connector,
    });
    registryFinal.register({
      domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
      capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
      create: () => registryAnalytics.resolve('analytics', ANALYTICS_PROVIDER, { organizationId: ORG, storeId: STORE }).connector,
    });

    const catalogRepository = createCommerceCatalogRepository({ pool: fachada });
    const productPerformanceService = createProductPerformanceService({ pool: fachada, registry: registryFinal, catalogRepository });
    const reconciliationService = createReconciliationService({ registry: registryFinal, productPerformanceService });
    const opportunityDiagnosticsService = createOpportunityDiagnosticsService({
      productPerformanceService, reconciliationService, analyticsProvider: ANALYTICS_PROVIDER, commerceProvider: PROVIDER,
    });

    medidorQueries.resetar();
    const f3 = await fase('3. GET /journey/opportunities (getOpportunities)', () => opportunityDiagnosticsService.getOpportunities({
      organizationId: ORG, storeId: STORE, startDate: '2026-09-01', endDate: '2026-09-20', limit: 5,
    }));
    relatorio.push({ ...f3, queries: medidorQueries.total(), queriesDetalhe: medidorQueries.detalhe() });
    console.log(`✔ getOpportunities: ${f3.ms.toFixed(0)}ms · fontes: funil=${f3.resultado.sources.productFunnel.status} commerce=${f3.resultado.sources.commerceReconciliation.status} · candidatos=${f3.resultado.totalCandidates} · heap Δ${mb(f3.heapDelta)} · ${medidorQueries.total()} queries`);
  });

  console.log(`\n=== Detalhe de queries por fase (top 8 por volume) ===`);
  for (const f of relatorio) {
    console.log(`\n-- ${f.nome} (${f.queries} queries totais) --`);
    for (const [sql, n] of f.queriesDetalhe.slice(0, 8)) console.log(`  ${String(n).padStart(6)}x  ${sql}`);
  }

  console.log(`\n=== Resumo ===`);
  console.log('fase'.padEnd(45), 'ms'.padStart(10), 'queries'.padStart(10), 'heapΔ'.padStart(10), 'rssDepois'.padStart(12));
  for (const f of relatorio) {
    console.log(f.nome.padEnd(45), f.ms.toFixed(0).padStart(10), String(f.queries).padStart(10), mb(f.heapDelta).padStart(10), mb(f.rssDepois).padStart(12));
  }

  await appPoolReal.end();
  await sup.query(`DROP OWNED BY ${role}`).catch(() => {});
  await sup.end();
  await db.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${role}`); } finally { await admin.end(); }
  console.log('\nBanco descartável destruído. Fim.');
}

main().catch((err) => { console.error('ERRO:', err); process.exitCode = 1; });
