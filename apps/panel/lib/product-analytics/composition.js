'use strict';

// Fase H (rodada H→I) · monta os serviços de Product Analytics UMA VEZ por processo.
//
// Risco de integração explícito no comando: se a factory do ProductPerformanceService (e o
// ReportCache dela) fosse criada a cada request, o TTL de 15 min nunca produziria reuso nenhum
// entre páginas/requests — seria o mesmo custo de não ter cache. Por isso este módulo é chamado
// UMA VEZ no bootstrap do servidor (server.js) e o resultado (registry/services) vive pelo
// processo inteiro — o mesmo ciclo de vida de `pgPool`/`CHAVEIRO` no próprio server.js.
//
// Isolamento entre tenants/properties não depende de recriar o service por Organization: o
// ReportCache particiona por (organizationId, storeId, analyticsProvider, período, escopoCache) —
// ver product-performance-service.js — e toda chamada aos services abaixo já recebe
// organizationId/storeId explícitos (nunca implícitos, nunca de um closure de request).

const { createConnectorRegistry } = require('../connectors/registry');
const { createConnectorIntegrationPort } = require('../platform/connector-integration-port');
const { createConnectorSecretPort } = require('../platform/connector-secret-port');
const { createReservaInkCommerceDescriptor } = require('../connectors/commerce/reserva-ink');
const { createInkOrdersRepository } = require('../connectors/commerce/reserva-ink/orders-repository');
const { createGa4AnalyticsDescriptor } = require('../connectors/analytics/ga4');
const { createGa4PropertyRepository } = require('../connectors/analytics/ga4/property-repository');
const { createCommerceCatalogRepository } = require('./commerce-catalog-repository');
const { createProductPerformanceService, createReportCache } = require('./product-performance-service');
const { createReconciliationService } = require('./reconciliation');
const { createJourneyAnalyticsService } = require('./journey-analytics-service');
const { createOpportunityDiagnosticsService } = require('./opportunity-diagnostics');
const { runCatalogSync } = require('./catalog-sync');
const { bootstrapCommerceIdentities } = require('./product-identity-resolver');

const ANALYTICS_PROVIDER = 'ga4';
const COMMERCE_PROVIDER = 'reserva_ink';

// Rodada M · achado real de produção (Use Sul, GA4 real cruzado à mão pelo usuário contra o Oria):
// a Ink manda `transaction_id` pro GA4 como `INK<providerOrderId>`, nunca o id cru. Mapa por
// provider (nunca um `if` solto em journey-analytics-service.js) — outro CommerceConnector no
// futuro entra aqui só se também tiver prefixo próprio; sem entrada, o default do service (`''`)
// já cobre "sem prefixo", nenhuma mudança necessária lá.
const COMMERCE_TRANSACTION_ID_PREFIX = Object.freeze({ reserva_ink: 'INK' });

/**
 * @param {{pool, keyring, fetchImpl?, googleClientId?, googleClientSecret?, reportCacheTtlMs?, leases?}} deps
 *   `pool`: a fachada tenant-scoped (RLS) — o mesmo `pgPool` do resto do server.js, NUNCA o pool
 *   real sem RLS (`pgPoolReal`).
 *   `leases`: Rodada M — lib/platform/leases.js (mesma instância que server.js já cria pra `JOBS`,
 *   `createJobLeases({ poolReal: pgPoolReal })`; criar de novo aqui é seguro — o lease em si vive no
 *   Postgres via `job_lease_adquirir`/`job_lease_concluir`, nunca em memória do processo). Opcional:
 *   sem leases, `runCatalogSync` roda sem proteção de concorrência (mesmo default da própria
 *   função) — aceitável só em teste.
 * @returns {Readonly<{registry, catalogRepository, productPerformanceService, reconciliationService,
 *   journeyAnalyticsService, opportunityDiagnosticsService, reportCache, analyticsProvider: string,
 *   commerceProvider: string, syncCommerceCatalog: Function, getCommerceCatalogSyncStatus: Function,
 *   catalogSyncNecessario: Function}>}
 */
function createProductAnalyticsComposition({
  pool, keyring, fetchImpl, googleClientId, googleClientSecret, reportCacheTtlMs, leases = null,
  // Rodada "Jornada de Valor Operacional" · a partir de quanto tempo desde o último sync BEM-SUCEDIDO
  // um catálogo é considerado "vencido" pro scheduler automático (Gate A) disparar de novo. Injetável
  // (nunca hardcoded globalmente) — 24h é o default operacional documentado, não "a" verdade; um
  // catálogo de ~85 mil produtos custa dezenas/centenas de páginas por run, então recorrência mais
  // curta que isso é orçamento de chamadas que ninguém pediu ainda.
  catalogSyncMaxAgeMs = 24 * 60 * 60 * 1000,
} = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createProductAnalyticsComposition exige pool');
  if (!keyring) throw new Error('createProductAnalyticsComposition exige keyring');

  const integrations = createConnectorIntegrationPort({ pool });
  const secretPort = createConnectorSecretPort({ pool, keyring });
  const registry = createConnectorRegistry({ integrations });

  // Reserva Ink: capability `orders` (Etapa 2/rodada G.1) lê o cache local, nunca a API — mesmo
  // secretPort do GA4 (é genérico por integração, não por provider).
  registry.register(createReservaInkCommerceDescriptor({
    secretPort, fetchImpl, ordersRepository: createInkOrdersRepository({ pool }),
  }));
  registry.register(createGa4AnalyticsDescriptor({
    secretPort, propertyRepository: createGa4PropertyRepository({ pool }),
    fetchImpl, clientId: googleClientId, clientSecret: googleClientSecret,
  }));

  const catalogRepository = createCommerceCatalogRepository({ pool });
  const reportCache = createReportCache(reportCacheTtlMs ? { ttlMs: reportCacheTtlMs } : undefined);
  const productPerformanceService = createProductPerformanceService({ pool, registry, catalogRepository, reportCache });
  const reconciliationService = createReconciliationService({ registry, productPerformanceService });
  // Rodada K · Journey Analytics reaproveita o MESMO registry (GA4 + Ink já registrados acima) — a
  // conta Meta Ads é lida direto de meta_insights_daily (lib/meta/campaign-performance.js), fora do
  // registry por enquanto (ver comentário no próprio arquivo). Nenhum provider `event_analytics` é
  // registrado nesta composição — tier3 (jornada individual) fica estruturalmente indisponível até
  // uma composição futura registrar um.
  const journeyAnalyticsService = createJourneyAnalyticsService({
    pool, registry, productPerformanceService, analyticsProvider: ANALYTICS_PROVIDER, commerceProvider: COMMERCE_PROVIDER,
    commerceTransactionIdPrefix: COMMERCE_TRANSACTION_ID_PREFIX[COMMERCE_PROVIDER] || '',
  });

  // Gate C ("Jornada de Valor") · consome productPerformanceService + reconciliationService JÁ
  // montados acima (mesmo ReportCache, nenhuma chamada nova ao GA4/Ink) — nunca um segundo motor.
  const opportunityDiagnosticsService = createOpportunityDiagnosticsService({
    productPerformanceService, reconciliationService, analyticsProvider: ANALYTICS_PROVIDER, commerceProvider: COMMERCE_PROVIDER,
  });

  // Rodada M · achado real: `runCatalogSync` (Fase D, lib/product-analytics/catalog-sync.js) nunca
  // tinha um jeito de ser acionada em produção — só aparecia em teste. Sem ela, `commerce_products`
  // fica sempre vazio e Desempenho de Produtos/Jornada de Compra nunca resolvem identidade nenhuma,
  // mesmo com GA4/Ink conectados e dado real chegando dos dois. `syncCommerceCatalog` dispara e
  // devolve na hora (é uma varredura de centenas/milhares de páginas — minutos, nunca síncrono numa
  // resposta HTTP); `getCommerceCatalogSyncStatus` lê o último run do log (commerce_catalog_sync_logs,
  // já existente desde a Fase D) pra quem quiser acompanhar por polling — mesmo padrão já usado por
  // `/api/admin/produtos/catalogo/status` pro cache separado de Produtos.
  // Gate B ("Jornada de Valor Operacional") · depois de um full sync BEM-SUCEDIDO, a identidade
  // (product_external_identities) precisa refletir o catálogo novo — nunca uma operação manual
  // escondida atrás de um script de teste (era exatamente esse o estado antes desta rodada:
  // bootstrapCommerceIdentities só era chamada em teste, igual runCatalogSync na rodada anterior).
  // Só em 'success' (nunca 'partial_failure'/'failed' — um sync parcial não termina a varredura
  // inteira; produtos de um run parcial ganham identity no PRÓXIMO sync bem-sucedido, manual ou
  // automático). bootstrapCommerceIdentities é idempotente e em lote (SQL set-based, nunca por
  // produto) — rodar de novo sobre o mesmo catálogo não duplica nem sobrescreve mapping manual
  // (`WHERE ... source = 'commerce_sync'`, ver product-identity-resolver.js).
  //
  // Invalidação de cache: NENHUMA aqui de propósito. O ReportCache (product-performance-service.js)
  // guarda só as LINHAS CRUAS do relatório GA4 (nunca a resolução de identity) — toda chamada a
  // getProductPerformance/getProductPerformanceSummary/Opportunity Diagnostics já resolve identity
  // DE NOVO contra o banco a cada invocação (resolveAndPersist, sempre fresco). Destruir o
  // ReportCache aqui derrubaria o reuso de 15min sem nenhum ganho — a próxima request já vê a
  // identity nova sozinha, sem precisar que nada seja invalidado.
  async function syncCommerceCatalog({ organizationId, storeId }) {
    const resultado = await runCatalogSync({ pool, registry, leases, logger: console }, { organizationId, storeId, provider: COMMERCE_PROVIDER });
    if (resultado.status === 'success') {
      try {
        await bootstrapCommerceIdentities({ pool }, { organizationId, storeId, provider: COMMERCE_PROVIDER });
      } catch (err) {
        // O catálogo sincronizou; o bootstrap de identity é best-effort logo em seguida — falhar
        // aqui não desfaz o sync. Fica pro próximo sync (manual ou do scheduler) tentar de novo.
        console.error(`[PRODUCT_ANALYTICS] bootstrapCommerceIdentities pós-sync falhou (${organizationId}): ${err.message}`);
      }
    }
    return resultado;
  }

  async function getCommerceCatalogSyncStatus({ organizationId, storeId }) {
    const { rows } = await pool.query(
      `SELECT sync_run_id, status, started_at, finished_at, pages_processed,
              products_seen, products_inserted, products_updated, products_deactivated,
              variants_seen, variants_inserted, variants_updated, variants_deactivated, error_code
         FROM commerce_catalog_sync_logs
        WHERE organization_id = $1 AND store_id = $2 AND provider = $3
        ORDER BY started_at DESC LIMIT 1`,
      [organizationId, storeId, COMMERCE_PROVIDER]
    );
    return rows[0] || null;
  }

  // Gate A ("Jornada de Valor Operacional") · decide se ESTA Organization precisa de um full sync
  // agora — usado pelo scheduler automático (server.js `sincronizarCatalogoCanonicoDaOrganizacao`)
  // pra checar antes de disparar, nunca depois: nunca sincroniza(dor) verifica "vencido" só olhando
  // pro relógio de parede sem olhar o log real. `maxAgeMs` é injetável por chamada (default = o
  // `catalogSyncMaxAgeMs` desta composição) — nunca hardcoded globalmente.
  //
  //   sem log nenhum                → precisa (nunca sincronizado — cobre "recovery" de instalações
  //                                    antigas do mesmo jeito que cobre um catálogo novo)
  //   último run 'running'          → NÃO precisa (já em andamento; o lease de catalog-sync.js
  //                                    protege — o scheduler não dispara por cima)
  //   último run != 'success'       → precisa (falhou ou parcial — tenta de novo)
  //   último sucesso mais velho que maxAgeMs → precisa
  //   senão                          → não precisa
  async function catalogSyncNecessario({ organizationId, storeId }, { maxAgeMs = catalogSyncMaxAgeMs } = {}) {
    const ultimo = await getCommerceCatalogSyncStatus({ organizationId, storeId });
    if (!ultimo) return true;
    if (ultimo.status === 'running') return false;
    if (ultimo.status !== 'success') return true;
    if (!ultimo.finished_at) return true;
    return (Date.now() - new Date(ultimo.finished_at).getTime()) >= maxAgeMs;
  }

  return Object.freeze({
    registry, catalogRepository, productPerformanceService, reconciliationService, journeyAnalyticsService,
    opportunityDiagnosticsService, reportCache,
    analyticsProvider: ANALYTICS_PROVIDER, commerceProvider: COMMERCE_PROVIDER,
    syncCommerceCatalog, getCommerceCatalogSyncStatus, catalogSyncNecessario,
  });
}

module.exports = { createProductAnalyticsComposition, ANALYTICS_PROVIDER, COMMERCE_PROVIDER };
