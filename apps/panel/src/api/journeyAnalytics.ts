import { api } from './client';
import type { ProductAnalyticsCoverage, ProductAnalyticsMetrics } from './productAnalytics';

// Tipos e chamadas pra /api/admin/product-analytics/journey* (Rodada K/L). Contrato vem de
// lib/product-analytics/http-routes.js + journey-analytics-service.js — qualquer mudança de forma
// tem que acontecer lá primeiro.
//
// `status` é a taxonomia normalizada (Rodada L §2.2) que toda camada devolve — a UI decide o texto
// certo por ESTE campo, nunca tentando interpretar `reason` (que é só diagnóstico/debug).
export type AvailabilityStatus = 'available' | 'not_connected' | 'unsupported' | 'insufficient_data' | 'not_verified' | 'temporary_failure';

export interface JourneyFunnel {
  available: boolean;
  status: AvailabilityStatus;
  reason: string | null;
  observed: ProductAnalyticsMetrics | null;
  matched: ProductAnalyticsMetrics | null;
  coverage: ProductAnalyticsCoverage | null;
}

export interface JourneyAcquisitionRow {
  source: string;
  medium: string;
  campaign: string;
  sessions: number | null;
  ecommercePurchases: number | null;
  totalRevenue: number | null;
}

export interface JourneyAcquisition {
  available: boolean;
  status: AvailabilityStatus;
  reason: string | null;
  rows: JourneyAcquisitionRow[];
}

export interface JourneyMetaCampaign {
  externalId: string;
  name: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  purchases: number | null;
  revenue: number | null;
}

export interface JourneyAdsInvestment {
  available: boolean;
  status: AvailabilityStatus;
  reason: string | null;
  campaigns: JourneyMetaCampaign[];
}

export interface JourneyConfirmedOrders {
  available: boolean;
  status: AvailabilityStatus;
  reason: string | null;
  count: number | null;
  revenue: number | null;
}

// Um vínculo `linked: true` prova SÓ isto: o mesmo identificador apareceu nos dois lados
// (`linkType: 'transaction_linked'`). Nunca a sequência completa de eventos do cliente, nunca qual
// campanha/anúncio causou a compra.
export interface JourneyTransactionLink {
  commerceOrderId: string;
  providerOrderId: string;
  linked: boolean;
  linkType: 'transaction_linked';
  ga4Transactions: number | null;
  ga4Revenue: number | null;
}

export interface JourneyTransactionOrderLink {
  available: boolean;
  status: AvailabilityStatus;
  reason: string | null;
  checked: number;
  linked: number;
  links: JourneyTransactionLink[];
  // Rodada L §2.3: o relatório agregado nunca verifica TODOS os pedidos pagos (custaria 1 chamada
  // GA4 por pedido, sem teto) — só uma amostra. `sampled` avisa quando há mais pedidos elegíveis do
  // que os verificados; use GET /journey/transaction-link pra checar um pedido específico.
  sampled: boolean;
  sampleSize: number;
  totalEligible: number;
}

export interface JourneyIndividual {
  available: boolean;
  status: AvailabilityStatus;
  reason: string | null;
  provider: string | null;
  eventLevel?: boolean;
}

export interface JourneyAttributionRow {
  source: 'commerce' | 'meta_ads' | 'ga4';
  label: string;
  purchases: number | null;
  revenue: number | null;
  spend?: number | null;
}

export type JourneyCoverageState = 'available' | 'unavailable';
export interface JourneyCoverage {
  funnel: JourneyCoverageState;
  acquisition: JourneyCoverageState;
  adsInvestment: JourneyCoverageState;
  confirmedOrders: JourneyCoverageState;
  transactionOrderLink: JourneyCoverageState;
  individualJourney: JourneyCoverageState;
}

export interface JourneyAnalyticsResponse {
  period: { startDate: string; endDate: string };
  status: 'ok' | 'insufficient_data';
  reason?: string;
  historyStartsAt?: string;
  tier1?: {
    funnel: JourneyFunnel;
    acquisition: JourneyAcquisition;
    adsInvestment: JourneyAdsInvestment;
    confirmedOrders: JourneyConfirmedOrders;
  };
  tier2?: { transactionOrderLink: JourneyTransactionOrderLink };
  tier3?: { individualJourney: JourneyIndividual };
  attribution?: JourneyAttributionRow[];
  coverage?: JourneyCoverage;
}

function periodoParams(q: { startDate: string; endDate: string }): URLSearchParams {
  const params = new URLSearchParams();
  params.set('startDate', q.startDate);
  params.set('endDate', q.endDate);
  return params;
}

export function getJourneyAnalytics(periodo: { startDate: string; endDate: string }): Promise<JourneyAnalyticsResponse> {
  return api<JourneyAnalyticsResponse>(`/api/admin/product-analytics/journey?${periodoParams(periodo).toString()}`);
}

// Pedido do Commerce (CommerceOrder — lib/connectors/types.js), só os campos que a UI mostra no
// resultado da verificação sob demanda.
export interface JourneyOrderRef {
  id: string;
  providerOrderId: string;
  status: string | null;
  isPaid: boolean;
  totalValue: number;
  createdAt: string;
}

export interface OrderTransactionLinkResponse {
  available: boolean;
  status: AvailabilityStatus;
  reason: string | null;
  order: JourneyOrderRef | null;
  linked: boolean | null;
  linkType?: 'transaction_linked';
  ga4Transactions?: number | null;
  ga4Revenue?: number | null;
}

// Rodada L §2.3: verificação SOB DEMANDA de 1 pedido — chame isto quando o usuário seleciona um
// pedido específico (nunca no carregamento inicial da página, que só mostra a amostra agregada).
export function checkOrderTransactionLink(periodo: { startDate: string; endDate: string }, providerOrderId: string): Promise<OrderTransactionLinkResponse> {
  const params = periodoParams(periodo);
  params.set('providerOrderId', providerOrderId);
  return api<OrderTransactionLinkResponse>(`/api/admin/product-analytics/journey/transaction-link?${params.toString()}`);
}

// Gate C ("Jornada de Valor") · "Prioridades de hoje" — contrato vem de
// lib/product-analytics/opportunity-diagnostics.js. `evidence`/`config` são só números/contadores
// (nunca token/PII); `hypothesis` NUNCA é apresentada como causa comprovada, só possível explicação
// com uma ação de verificação — a UI preserva esse tom, nunca reescreve como afirmação.
export type OpportunityType =
  | 'low_view_to_cart' | 'low_cart_to_checkout' | 'low_checkout_to_purchase'
  | 'units_divergent_ga4_commerce' | 'identity_coverage_low';

export interface Opportunity {
  type: OpportunityType;
  scope: 'product' | 'store';
  product: ProductAnalyticsProductRef | null;
  evidence: Record<string, number>;
  hypothesis: string;
  suggestedAction: string;
  confidence: 'baixa' | 'media' | 'alta';
  score: number;
}

interface ProductAnalyticsProductRef {
  id: string;
  name: string;
  imageUrl: string | null;
  productType: string | null;
  provider: string;
  providerProductId: string;
}

export interface OpportunitiesSource {
  available: boolean;
  status: AvailabilityStatus;
  reason: string | null;
}

export interface OpportunitiesResponse {
  period: { startDate: string; endDate: string };
  status: 'ok';
  config: { minSamples: Record<string, number>; minDeviation: number; minCoverage: number; limit: number };
  sources: { productFunnel: OpportunitiesSource; commerceReconciliation: OpportunitiesSource };
  opportunities: Opportunity[];
  totalCandidates: number;
}

export function getOpportunities(periodo: { startDate: string; endDate: string }, opts: { limit?: number } = {}): Promise<OpportunitiesResponse> {
  const params = periodoParams(periodo);
  if (opts.limit) params.set('limit', String(opts.limit));
  return api<OpportunitiesResponse>(`/api/admin/product-analytics/journey/opportunities?${params.toString()}`);
}
