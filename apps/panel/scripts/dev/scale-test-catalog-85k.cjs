'use strict';

// Rodada "preparação do piloto" + "corrigir o gargalo real" · teste de escala DIRECIONADO — simula
// um catálogo de ~85 mil produtos (o número usado em toda a documentação desde a Fase D como o
// piloto real) contra um registry FAKE (nunca a API real da Ink/GA4 — só a forma do contrato,
// `listProductsWithVariants` paginado a 100/página, o mesmo limite que catalog-sync.js usa de
// verdade) e Postgres real (efêmero, descartado no final). Mede tempo, memória de PICO e volume de
// queries/chamadas de connector de cada fase:
//
//   1. runCatalogSync              — full sync do catálogo (Gate A)
//   2. bootstrapCommerceIdentities — identity em lote (Gate B)
//   3. getOpportunities FRIO       — GET /journey/opportunities, cache de relatório GA4 vazio
//   4. getOpportunities QUENTE     — MESMO período, cache de relatório GA4 já aquecido pela fase 3
//   5. getOpportunities (catálogo pequeno/médio) — cenário separado, ~2.000 produtos
//
// Nunca faz asserção pass/fail (não é um teste de correção — essas já existem, com fixtures
// pequenos, em catalog-sync.test.js/product-identity-resolver.test.js/opportunity-diagnostics.
// test.js). Este script só IMPRIME um relatório — a leitura humana decide se algum número aqui é
// motivo de bloqueio antes do piloto.
//
// Uso:
//   node scripts/test-db.mjs run -- node --expose-gc scripts/dev/scale-test-catalog-85k.cjs
//   (--expose-gc é opcional — sem ele, o pico de memória ainda é amostrado, só sem forçar coleta
//   antes/depois de cada fase, o que deixa os deltas um pouco mais ruidosos)
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

// Cenário "pequeno/médio" pra comparação — mesma forma, escala bem menor (uma loja real comum).
const N_PRODUTOS_PEQUENO = 2000;
const N_OBSERVADOS_GA4_PEQUENO = 800;
const N_PEDIDOS_PAGOS_PEQUENO = 150;

const PROVIDER = 'reserva_ink';
const ANALYTICS_PROVIDER = 'ga4';

function mb(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)}MB`; }

function medidor(pool) {
  const contagem = new Map();
  const original = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    // 120 chars — comfortably além da 1ª linha das queries de identidade (~72 chars); truncar
    // curto demais aqui já causou um falso-negativo real (a chave gravada ficava mais curta do que
    // a string checada em `chamadasResolucaoIdentidade`, `startsWith` nunca batia).
    const primeiraLinha = String(sql).trim().split('\n')[0].trim().slice(0, 120);
    contagem.set(primeiraLinha, (contagem.get(primeiraLinha) || 0) + 1);
    return original(sql, params);
  };
  return {
    total: () => [...contagem.values()].reduce((a, b) => a + b, 0),
    // Chamadas de RESOLUÇÃO DE IDENTIDADE especificamente (resolveExternalIds/resolveAndPersist —
    // ver product-identity-resolver.js): a query que checa mapping já existente. Repetida por
    // página era EXATAMENTE o gargalo desta rodada — o número aqui prova se ainda é O(páginas) ou
    // já é O(1) por chamada de getOpportunities.
    chamadasResolucaoIdentidade: () => [...contagem.entries()]
      .filter(([sql]) => sql.startsWith('SELECT external_id, commerce_product_id FROM product_external_identities'))
      .reduce((acc, [, n]) => acc + n, 0),
    detalhe: () => [...contagem.entries()].sort((a, b) => b[1] - a[1]),
    resetar: () => contagem.clear(),
  };
}

function contador() {
  let n = 0;
  return { inc: () => { n += 1; }, get: () => n, resetar: () => { n = 0; } };
}

// Amostra memória em intervalos curtos DURANTE a fase (nunca só antes/depois — um pico no meio de
// uma fase de segundos nunca apareceria só olhando os dois extremos).
async function fase(nome, fn) {
  if (global.gc) global.gc();
  const memAntes = process.memoryUsage();
  let picoHeap = memAntes.heapUsed;
  let picoRss = memAntes.rss;
  const amostragem = setInterval(() => {
    const m = process.memoryUsage();
    if (m.heapUsed > picoHeap) picoHeap = m.heapUsed;
    if (m.rss > picoRss) picoRss = m.rss;
  }, 25);
  const t0 = process.hrtime.bigint();
  let resultado;
  try {
    resultado = await fn();
  } finally {
    clearInterval(amostragem);
  }
  const t1 = process.hrtime.bigint();
  if (global.gc) global.gc();
  const memDepois = process.memoryUsage();
  const ms = Number(t1 - t0) / 1e6;
  return {
    nome, ms, resultado,
    heapUsedAntes: memAntes.heapUsed, heapUsedDepois: memDepois.heapUsed,
    heapDelta: memDepois.heapUsed - memAntes.heapUsed, heapPico: picoHeap,
    rssAntes: memAntes.rss, rssDepois: memDepois.rss, rssPico: picoRss,
  };
}

// ── Fakes — gera a página SOB DEMANDA (nunca materializa o catálogo inteiro de uma vez na memória
// do próprio script, que distorceria a medição de memória do CÓDIGO SOB TESTE). Parametrizados por
// N pra servir tanto o cenário 85k quanto o pequeno/médio, sem duplicar a implementação. ──
function registryComercioFake({ nProdutos, nPedidosPagos, org, store }) {
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: false, variants: false, productsWithVariants: true, orders: true, refunds: false, productCosts: false },
    create: () => ({
      async listProductsWithVariants({ cursor }) {
        const pagina = cursor ? Number(cursor) : 1;
        const inicio = (pagina - 1) * POR_PAGINA;
        if (inicio >= nProdutos) return { items: [], nextCursor: null };
        const fim = Math.min(inicio + POR_PAGINA, nProdutos);
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
        return { items, nextCursor: fim < nProdutos ? String(pagina + 1) : null };
      },
      async listOrders({ cursor, limit = 200 }) {
        const pagina = cursor ? Number(cursor) : 1;
        const inicio = (pagina - 1) * limit;
        if (inicio >= nPedidosPagos) return { items: [], nextCursor: null };
        const fim = Math.min(inicio + limit, nPedidosPagos);
        const items = [];
        for (let n = inicio; n < fim; n += 1) {
          // Cada pedido paga por 1 unidade de um produto espalhado pelo catálogo (n * 37 — primo,
          // espalha sem repetir padrão óbvio) — nunca todos os pedidos no mesmo produto.
          const providerProductId = String((n * 37) % nProdutos);
          items.push({
            id: `pedido-${n}`, organizationId: org, storeId: store, provider: PROVIDER, providerOrderId: String(n),
            status: 'delivered', paymentStatus: 'paid', isPaid: true, isRefunded: false, totalValue: 89.9,
            createdAt: new Date(), paidAt: new Date(),
            items: [{ providerProductId, commerceProductId: null, quantity: 1, unitValue: 89.9, totalValue: 89.9 }],
          });
        }
        return { items, nextCursor: fim < nPedidosPagos ? String(pagina + 1) : null };
      },
      async getOrder() { return null; },
    }),
  });
  return registry;
}

// GA4 fake: observa `nObservados` itemIds distintos, cada um = o providerProductId de um produto
// real (garante cobertura resolvível). Devolve tudo numa chamada só (mesmo contrato do connector
// real — o service NUNCA pagina o relatório de analytics em si, só o catálogo). `chamadasGa4` conta
// quantas vezes o connector real foi chamado — prova se o ReportCache está sendo reaproveitado
// (fria vs. quente) ou se cada getOpportunities bate no "provider" de novo.
function registryAnalyticsFake({ nObservados, chamadasGa4 }) {
  const registry = createConnectorRegistry();
  const linhas = [];
  for (let n = 0; n < nObservados; n += 1) {
    linhas.push({
      externalProductId: String(n), externalProductName: `Produto ${n}`,
      itemsViewed: 50 + (n % 500), itemsAddedToCart: 5 + (n % 40), itemsCheckedOut: 2 + (n % 15), itemsPurchased: 1 + (n % 6),
      itemRevenue: 89.9 * (1 + (n % 6)), analyticsProvider: ANALYTICS_PROVIDER,
    });
  }
  registry.register({
    domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ({
      async getProductPerformance() { chamadasGa4.inc(); return linhas; },
      async getCacheScope() { return null; },
    }),
  });
  return registry;
}

function montarRegistryFinal({ registryComercio, registryAnalytics, org, store }) {
  const registryFinal = createConnectorRegistry();
  registryFinal.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: false, variants: false, productsWithVariants: true, orders: true, refunds: false, productCosts: false },
    create: () => registryComercio.resolve('commerce', PROVIDER, { organizationId: org, storeId: store }).connector,
  });
  registryFinal.register({
    domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => registryAnalytics.resolve('analytics', ANALYTICS_PROVIDER, { organizationId: org, storeId: store }).connector,
  });
  return registryFinal;
}

function relatarGetOpportunities(rotulo, f, medidorQueries, chamadasGa4) {
  console.log(`✔ ${rotulo}: ${f.ms.toFixed(0)}ms · fontes: funil=${f.resultado.sources.productFunnel.status} commerce=${f.resultado.sources.commerceReconciliation.status} · candidatos=${f.resultado.totalCandidates} · oportunidades=${f.resultado.opportunities.length}`);
  console.log(`   heap: antes=${mb(f.heapUsedAntes)} depois=${mb(f.heapUsedDepois)} PICO=${mb(f.heapPico)} · rss: antes=${mb(f.rssAntes)} depois=${mb(f.rssDepois)} PICO=${mb(f.rssPico)}`);
  console.log(`   ${medidorQueries.total()} queries SQL totais · ${medidorQueries.chamadasResolucaoIdentidade()} chamada(s) de resolução de identidade (era ~425-850 antes da correção; O(1) por chamada agora) · ${chamadasGa4.get()} chamada(s) reais ao connector GA4`);
  console.log(`   payload (JSON.stringify): ${(JSON.stringify(f.resultado).length / 1024).toFixed(1)}KB`);
}

async function main() {
  console.log(`\n=== Teste de escala — catálogo simulado (rodada "corrigir o gargalo real") ===`);
  console.log(`Cenário grande: ${N_PRODUTOS} produtos (${Math.ceil(N_PRODUTOS / POR_PAGINA)} páginas) · ${N_OBSERVADOS_GA4} itemIds GA4 · ${N_PEDIDOS_PAGOS} pedidos pagos`);
  console.log(`Cenário pequeno/médio: ${N_PRODUTOS_PEQUENO} produtos · ${N_OBSERVADOS_GA4_PEQUENO} itemIds GA4 · ${N_PEDIDOS_PAGOS_PEQUENO} pedidos pagos`);
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

  const ORG_GRANDE = crypto.randomUUID();
  const STORE_GRANDE = crypto.randomUUID();
  const ORG_PEQUENA = crypto.randomUUID();
  const STORE_PEQUENA = crypto.randomUUID();
  for (const [org, store, nome] of [[ORG_GRANDE, STORE_GRANDE, 'Escala 85k'], [ORG_PEQUENA, STORE_PEQUENA, 'Escala pequena']]) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, nome]);
    await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [store, org, nome]);
  }

  const medidorQueries = medidor(fachada);
  const relatorio = [];

  // ── Cenário GRANDE (85k) ──────────────────────────────────────────────────────────────────────
  await runtime.comContexto({ organizationId: ORG_GRANDE, storeId: STORE_GRANDE, origem: 'scale-test' }, async () => {
    const registryComercio = registryComercioFake({ nProdutos: N_PRODUTOS, nPedidosPagos: N_PEDIDOS_PAGOS, org: ORG_GRANDE, store: STORE_GRANDE });
    medidorQueries.resetar();
    const f1 = await fase('1. runCatalogSync (full sync, 85k)', () => runCatalogSync(
      { pool: fachada, registry: registryComercio, leases, logger: { warn() {}, error(m) { console.error(m); } } },
      { organizationId: ORG_GRANDE, storeId: STORE_GRANDE, provider: PROVIDER }
    ));
    relatorio.push({ ...f1, queries: medidorQueries.total() });
    console.log(`✔ runCatalogSync: ${f1.ms.toFixed(0)}ms · status=${f1.resultado.status} · páginas=${f1.resultado.pagesProcessed} · produtos inseridos=${f1.resultado.productsInserted} · variantes inseridas=${f1.resultado.variantsInserted} · heap PICO=${mb(f1.heapPico)} · ${medidorQueries.total()} queries`);
    if (f1.resultado.status !== 'success') console.error(`  ATENÇÃO: sync não terminou com sucesso (${f1.resultado.status}) — fases seguintes rodam mesmo assim, mas o resultado não é representativo.`);

    medidorQueries.resetar();
    const f2 = await fase('2. bootstrapCommerceIdentities (85k)', () => bootstrapCommerceIdentities({ pool: fachada }, { organizationId: ORG_GRANDE, storeId: STORE_GRANDE, provider: PROVIDER }));
    relatorio.push({ ...f2, queries: medidorQueries.total() });
    console.log(`✔ bootstrapCommerceIdentities: ${f2.ms.toFixed(0)}ms · product=${f2.resultado.productIdentities} variant=${f2.resultado.variantIdentities} sku=${f2.resultado.skuIdentities} · heap PICO=${mb(f2.heapPico)} · ${medidorQueries.total()} queries`);

    const chamadasGa4 = contador();
    const registryAnalytics = registryAnalyticsFake({ nObservados: N_OBSERVADOS_GA4, chamadasGa4 });
    const registryFinal = montarRegistryFinal({ registryComercio, registryAnalytics, org: ORG_GRANDE, store: STORE_GRANDE });
    const catalogRepository = createCommerceCatalogRepository({ pool: fachada });
    const productPerformanceService = createProductPerformanceService({ pool: fachada, registry: registryFinal, catalogRepository });
    const reconciliationService = createReconciliationService({ registry: registryFinal, productPerformanceService });
    const opportunityDiagnosticsService = createOpportunityDiagnosticsService({
      productPerformanceService, reconciliationService, catalogRepository, analyticsProvider: ANALYTICS_PROVIDER, commerceProvider: PROVIDER,
    });
    const entradaOportunidades = { organizationId: ORG_GRANDE, storeId: STORE_GRANDE, startDate: '2026-09-01', endDate: '2026-09-20', limit: 5 };

    medidorQueries.resetar();
    chamadasGa4.resetar();
    const f3 = await fase('3. getOpportunities FRIO (85k, cache de relatório GA4 vazio)', () => opportunityDiagnosticsService.getOpportunities(entradaOportunidades));
    relatorio.push({ ...f3, queries: medidorQueries.total() });
    relatarGetOpportunities('3. getOpportunities FRIO (85k)', f3, medidorQueries, chamadasGa4);
    console.log(`   >>> META DE ENGENHARIA (comando): até 30s com cache aquecido — este é o FRIO, ${f3.ms < 30000 ? 'JÁ dentro da meta mesmo frio' : 'ainda acima — ver fase 4 (quente)'}.`);

    medidorQueries.resetar();
    chamadasGa4.resetar();
    const f4 = await fase('4. getOpportunities QUENTE (85k, MESMO período — cache de relatório já aquecido pela fase 3)', () => opportunityDiagnosticsService.getOpportunities(entradaOportunidades));
    relatorio.push({ ...f4, queries: medidorQueries.total() });
    relatarGetOpportunities('4. getOpportunities QUENTE (85k)', f4, medidorQueries, chamadasGa4);
    console.log(`   >>> META DE ENGENHARIA (comando): até 30s com cache aquecido — ${f4.ms <= 30000 ? '✔ DENTRO da meta' : '✘ AINDA ACIMA da meta — profile de novo, não declarar sucesso'} (${(f4.ms / 1000).toFixed(1)}s).`);

    // Request subsequente + reentrância: duas chamadas concorrentes da MESMA Organization/período
    // (a mesma instância de productPerformanceService/reconciliationService é COMPARTILHADA pelo
    // processo inteiro em produção — nunca uma por request) nunca podem se corromper uma à outra.
    medidorQueries.resetar();
    const [c1, c2] = await Promise.all([
      opportunityDiagnosticsService.getOpportunities(entradaOportunidades),
      opportunityDiagnosticsService.getOpportunities(entradaOportunidades),
    ]);
    const consistente = JSON.stringify(c1) === JSON.stringify(c2);
    console.log(`✔ 5. Reentrância (2 chamadas concorrentes, mesma Organization/período): resultados idênticos=${consistente}`);
  });

  // ── Cenário PEQUENO/MÉDIO (2k) — mesma forma, escala realista de uma loja comum ────────────────
  await runtime.comContexto({ organizationId: ORG_PEQUENA, storeId: STORE_PEQUENA, origem: 'scale-test' }, async () => {
    const registryComercio = registryComercioFake({ nProdutos: N_PRODUTOS_PEQUENO, nPedidosPagos: N_PEDIDOS_PAGOS_PEQUENO, org: ORG_PEQUENA, store: STORE_PEQUENA });
    await runCatalogSync(
      { pool: fachada, registry: registryComercio, leases, logger: { warn() {}, error(m) { console.error(m); } } },
      { organizationId: ORG_PEQUENA, storeId: STORE_PEQUENA, provider: PROVIDER }
    );
    await bootstrapCommerceIdentities({ pool: fachada }, { organizationId: ORG_PEQUENA, storeId: STORE_PEQUENA, provider: PROVIDER });

    const chamadasGa4 = contador();
    const registryAnalytics = registryAnalyticsFake({ nObservados: N_OBSERVADOS_GA4_PEQUENO, chamadasGa4 });
    const registryFinal = montarRegistryFinal({ registryComercio, registryAnalytics, org: ORG_PEQUENA, store: STORE_PEQUENA });
    const catalogRepository = createCommerceCatalogRepository({ pool: fachada });
    const productPerformanceService = createProductPerformanceService({ pool: fachada, registry: registryFinal, catalogRepository });
    const reconciliationService = createReconciliationService({ registry: registryFinal, productPerformanceService });
    const opportunityDiagnosticsService = createOpportunityDiagnosticsService({
      productPerformanceService, reconciliationService, catalogRepository, analyticsProvider: ANALYTICS_PROVIDER, commerceProvider: PROVIDER,
    });

    medidorQueries.resetar();
    chamadasGa4.resetar();
    const f5 = await fase('6. getOpportunities (catálogo pequeno/médio, 2k produtos, frio)', () => opportunityDiagnosticsService.getOpportunities({
      organizationId: ORG_PEQUENA, storeId: STORE_PEQUENA, startDate: '2026-09-01', endDate: '2026-09-20', limit: 5,
    }));
    relatorio.push({ ...f5, queries: medidorQueries.total() });
    relatarGetOpportunities('6. getOpportunities (2k produtos)', f5, medidorQueries, chamadasGa4);
  });

  // ── Isolamento entre Organizations com o MESMO providerProductId (o cenário grande e o pequeno
  // já reusam os ids 0..N em cada Organization — se houvesse vazamento de cache/contexto entre
  // tenants, a Organization pequena veria números da grande ou vice-versa). Checagem direta: o
  // total de produtos da Organization pequena tem que bater com N_PRODUTOS_PEQUENO, nunca com o
  // catálogo da Organization grande. ──
  const catalogRepositoryChecagem = createCommerceCatalogRepository({ pool: fachada });
  const paginaPequena = await runtime.comContexto({ organizationId: ORG_PEQUENA, storeId: STORE_PEQUENA, origem: 'scale-test' },
    () => catalogRepositoryChecagem.listPage({ organizationId: ORG_PEQUENA, storeId: STORE_PEQUENA, limit: 1 }));
  console.log(`\n✔ 7. Isolamento entre Organizations: catálogo da Organization pequena reporta totalCount=${paginaPequena.totalCount} (esperado ${N_PRODUTOS_PEQUENO}, nunca ${N_PRODUTOS} da grande) — ${paginaPequena.totalCount === N_PRODUTOS_PEQUENO ? 'OK' : 'FALHOU'}`);

  console.log(`\n=== Resumo ===`);
  console.log('fase'.padEnd(52), 'ms'.padStart(10), 'queries'.padStart(10), 'heapPico'.padStart(11), 'rssPico'.padStart(11));
  for (const f of relatorio) {
    console.log(f.nome.padEnd(52), f.ms.toFixed(0).padStart(10), String(f.queries).padStart(10), mb(f.heapPico).padStart(11), mb(f.rssPico).padStart(11));
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
