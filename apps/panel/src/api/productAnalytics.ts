import { api } from './client';

// Tipos e chamadas pra /api/admin/product-analytics/* (rodada H→I). Contrato vem de
// lib/product-analytics/http-routes.js — qualquer mudança de forma tem que acontecer lá primeiro.
//
// `itemsViewed`/`itemsAddedToCart`/`itemsCheckedOut`/`itemsPurchased` são QUANTIDADES DE ITEM
// (nunca usuários, sessões ou pedidos — GA4 Data API é escopo de item). `itemRatios` são razões
// entre essas quantidades, nunca taxa de conversão de pessoas.

export interface ProductAnalyticsProduct {
  id: string;
  name: string;
  imageUrl: string | null;
  productType: string | null;
  provider: string;
  providerProductId: string;
  // Ativo no sentido do lojista: publicado na Ink E ainda listado no último sync. false = desativado
  // (não publicado, recusado, arte inválida… ou fora da Ink). Opcional: respostas antigas não trazem.
  isActive?: boolean;
  // `status` cru da Ink (ex.: 'not_published', 'refused') — a tela diz POR QUE está desativado.
  providerStatus?: string | null;
}

export interface ProductAnalyticsMetrics {
  itemsViewed: number | null;
  itemsAddedToCart: number | null;
  itemsCheckedOut: number | null;
  itemsPurchased: number | null;
  itemRevenue: number | null;
}

export interface ProductAnalyticsItemRatios {
  itemsAddedToCartPerItemViewed: number | null;
  itemsCheckedOutPerItemViewed: number | null;
  itemsCheckedOutPerItemAddedToCart: number | null;
  itemsPurchasedPerItemViewed: number | null;
}

// unmatched_identity: produto sem identidade resolvida nesta fonte de analytics.
// multiple_analytics_identities: mais de um id externo (produto+variante+sku) somados no mesmo produto.
// metric_unavailable: a propriedade GA4 não suporta esta métrica (nunca 0 inventado).
// insufficient_data: período inteiro sem nenhuma linha de analytics.
export type ProductAnalyticsDiagnostic = 'unmatched_identity' | 'multiple_analytics_identities' | 'metric_unavailable' | 'insufficient_data';

export interface ProductAnalyticsItem {
  product: ProductAnalyticsProduct;
  metrics: ProductAnalyticsMetrics | null;
  itemRatios: ProductAnalyticsItemRatios;
  identity: { matchedAnalyticsIds: string[]; status: 'matched' | 'unmatched' };
  diagnostics: ProductAnalyticsDiagnostic[];
}

export interface ProductAnalyticsCoverage {
  observedAnalyticsIds: number;
  matchedAnalyticsIds: number;
  unmatchedAnalyticsIds: number;
  conflictedAnalyticsIds?: number;
  coverageRate: number | null;
  status: 'ok' | 'insufficient_data';
}

export interface ProductAnalyticsListResponse {
  items: ProductAnalyticsItem[];
  nextCursor: string | null;
  totalCount: number;
  coverage: ProductAnalyticsCoverage;
}

export const SORT_FIELDS = [
  // 'data' = "mais dados primeiro" (visualizações + carrinho + checkout + compras; quem não tem dado
  // vem depois, por nome — o catálogo nunca some). Padrão da tela.
  'data',
  'name', 'price', 'created_at', 'updated_at',
  'itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue',
  'itemsAddedToCartPerItemViewed', 'itemsCheckedOutPerItemViewed', 'itemsCheckedOutPerItemAddedToCart', 'itemsPurchasedPerItemViewed',
] as const;
export type ProductAnalyticsSortField = (typeof SORT_FIELDS)[number];

// Filtros da listagem (rodada "Desempenho de Produtos: mais dados primeiro + filtros"). Mínimos são
// ">=" sobre as contagens de item do período; ausente ou 0 = sem filtro.
export type ProductAnalyticsStatusFiltro = 'active' | 'inactive' | 'all';

export interface ProductAnalyticsFiltros {
  status?: ProductAnalyticsStatusFiltro;
  minViewed?: number;
  minAddedToCart?: number;
  minCheckedOut?: number;
  minPurchased?: number;
  minRevenue?: number;
  hasData?: boolean;
}

export interface ProductAnalyticsQuery extends ProductAnalyticsFiltros {
  // Busca pelo NOME. Preenchida, o servidor ignora todos os outros filtros e devolve o produto de
  // qualquer situação (ativo ou não).
  q?: string;
  startDate: string;
  endDate: string;
  cursor?: string | null;
  limit?: number;
  sort?: ProductAnalyticsSortField;
  sortDir?: 'asc' | 'desc';
  provider?: string;
}

function periodoParams(q: { startDate: string; endDate: string }): URLSearchParams {
  const params = new URLSearchParams();
  params.set('startDate', q.startDate);
  params.set('endDate', q.endDate);
  return params;
}

export function listProductAnalytics(q: ProductAnalyticsQuery): Promise<ProductAnalyticsListResponse> {
  const params = periodoParams(q);
  if (q.cursor) params.set('cursor', q.cursor);
  if (q.limit) params.set('limit', String(q.limit));
  if (q.sort) params.set('sort', q.sort);
  if (q.sortDir) params.set('sortDir', q.sortDir);
  if (q.provider) params.set('provider', q.provider);
  if (q.q && q.q.trim()) params.set('q', q.q.trim());
  if (q.status && q.status !== 'active') params.set('status', q.status);
  for (const chave of ['minViewed', 'minAddedToCart', 'minCheckedOut', 'minPurchased', 'minRevenue'] as const) {
    const valor = q[chave];
    if (valor != null && valor > 0) params.set(chave, String(valor));
  }
  if (q.hasData) params.set('hasData', 'true');
  return api<ProductAnalyticsListResponse>(`/api/admin/product-analytics/products?${params.toString()}`);
}

export function getProductAnalyticsDetail(productId: string, periodo: { startDate: string; endDate: string }): Promise<ProductAnalyticsItem> {
  return api<ProductAnalyticsItem>(`/api/admin/product-analytics/products/${encodeURIComponent(productId)}?${periodoParams(periodo).toString()}`);
}

export function getProductAnalyticsCoverage(periodo: { startDate: string; endDate: string }): Promise<{ coverage: ProductAnalyticsCoverage }> {
  return api(`/api/admin/product-analytics/coverage?${periodoParams(periodo).toString()}`);
}

// Rodada J.4 · totais STORE-WIDE do período inteiro (nunca só a página carregada na tabela).
// `observed`: soma de TODO itemId que o GA4 relatou, resolvido ou não — a verdade crua da
// propriedade. `matched`: soma só do que resolveu a um produto canônico da Store — o que dá pra
// atribuir a um produto de verdade. Os dois vêm SEMPRE juntos (nunca um escondendo o outro);
// `null` em qualquer campo é métrica indisponível na propriedade, nunca 0 inventado.
export interface ProductAnalyticsSummary {
  observed: ProductAnalyticsMetrics | null;
  matched: ProductAnalyticsMetrics | null;
  coverage: ProductAnalyticsCoverage;
}

export function getProductAnalyticsSummary(periodo: { startDate: string; endDate: string; provider?: string }): Promise<ProductAnalyticsSummary> {
  const params = periodoParams(periodo);
  if (periodo.provider) params.set('provider', periodo.provider);
  return api<ProductAnalyticsSummary>(`/api/admin/product-analytics/summary?${params.toString()}`);
}

export interface ProductAnalyticsStatus {
  analytics: {
    provider: string;
    connected: boolean;
    apt: boolean | null;
    reason: string | null;
    metrics: Record<string, boolean> | null;
  };
}

export function getProductAnalyticsStatus(): Promise<ProductAnalyticsStatus> {
  return api<ProductAnalyticsStatus>('/api/admin/product-analytics/status');
}

export type ReconciliationStatus = 'aligned' | 'divergent' | 'insufficient_identity' | 'insufficient_data';

export interface ReconciliationItem {
  product: ProductAnalyticsProduct;
  analyticsUnits: number | null;
  commerceUnits: number | null;
  analyticsRevenue: number | null;
  commerceRevenue: number | null;
  paidOrdersDistinct: number;
  status: ReconciliationStatus;
  diagnostics: string[];
}

export interface ReconciliationResponse {
  status: 'ok' | 'insufficient_data';
  reason?: string;
  historyStartsAt?: string;
  items: ReconciliationItem[];
  // Paginação no servidor (ausentes quando `status` é 'insufficient_data').
  nextCursor?: string | null;
  totalCount?: number;
  coverage?: ProductAnalyticsCoverage;
  caveats: string[];
}

export function getReconciliation(q: { startDate: string; endDate: string; cursor?: string | null; limit?: number }): Promise<ReconciliationResponse> {
  const params = periodoParams(q);
  if (q.cursor) params.set('cursor', q.cursor);
  if (q.limit) params.set('limit', String(q.limit));
  return api<ReconciliationResponse>(`/api/admin/product-analytics/reconciliation?${params.toString()}`);
}

// Rodada M · o catálogo canônico (commerce_products) — do qual TODA identidade de produto aqui
// depende — precisa ser sincronizado antes de existir qualquer coisa pra "atribuir a produto".
// Dispara e responde na hora; quem acompanha é getCatalogSyncStatus (polling).
export function syncCommerceCatalog(): Promise<{ ok: true; status: 'started' | 'already_running' }> {
  return api('/api/admin/product-analytics/catalog-sync', { method: 'POST' });
}

export interface CommerceCatalogSyncRun {
  status: 'running' | 'success' | 'partial_failure' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  pagesProcessed: number;
  productsSeen: number;
  productsInserted: number;
  productsUpdated: number;
  productsDeactivated: number;
  errorCode: string | null;
}

// Gate A ("Jornada de Valor Operacional") · taxonomia do comando — a UI decide o texto certo por
// ESTE campo, nunca lendo `lastRun.status` cru (`state` já cobre never_synced/queued, que não têm
// linha nenhuma em `lastRun`).
export type CommerceCatalogSyncState = 'never_synced' | 'queued' | 'running' | 'completed' | 'partial_failure' | 'failed';

export interface CommerceCatalogSyncStatus {
  syncing: boolean;
  state: CommerceCatalogSyncState;
  lastRun: CommerceCatalogSyncRun | null;
}

export function getCommerceCatalogSyncStatus(): Promise<CommerceCatalogSyncStatus> {
  return api<CommerceCatalogSyncStatus>('/api/admin/product-analytics/catalog-sync/status');
}
