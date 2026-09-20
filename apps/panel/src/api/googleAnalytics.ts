import { api } from './client';

export type GaConnectionStatus = 'connected' | 'expired' | 'error' | 'disconnected';

export interface GaConnection {
  // Identidade canônica da Store; `loja` é só a chave histórica (nula na Store nativa).
  storeId: string;
  storeNome: string | null;
  loja: string | null;
  propertyId: string | null;
  propertyName: string | null;
  googleAccountEmail: string | null;
  status: GaConnectionStatus;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface GaProperty {
  propertyId: string;
  propertyName: string;
  accountName: string;
}

export function getGaStatus() {
  return api<{ conexoes: GaConnection[]; oauthConfigurado: boolean }>('/api/admin/integrations/google-analytics/status');
}

// Não é uma chamada de API (fetch): é uma navegação de página inteira de propósito — o fluxo
// OAuth do Google exige top-level navigation, não dá pra fazer por XHR/fetch.
export function urlConectarGa(): string {
  return `/api/admin/integrations/google-analytics/connect`;
}

export function listGaProperties() {
  return api<{ propriedades: GaProperty[] }>(`/api/admin/integrations/google-analytics/properties`);
}

export function salvarGaProperty(propertyId: string, propertyName: string) {
  return api<{ conexao: GaConnection }>('/api/admin/integrations/google-analytics/property', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ propertyId, propertyName }),
  });
}

export function desconectarGa() {
  return api('/api/admin/integrations/google-analytics/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// Períodos aceitos pelo endpoint de performance; "custom:AAAA-MM-DD:AAAA-MM-DD" é montado à parte.
export type GaPeriodo = 'hoje' | '7d' | '30d' | '90d' | string;

export interface GaPerformanceLinha {
  source: string;
  medium: string;
  campaign: string;
  content: string;
  term: string;
  sessions: number;
  users: number;
  purchases: number;
  revenue: number;
  conversionRate: number;
  // Fatia das sessões do período que esta combinação representa (0-1).
  participacao: number;
  campanhaId: string | null;
  campanhaNome: string | null;
}

export interface GaPerformanceTotais {
  sessions: number;
  users: number;
  purchases: number;
  revenue: number;
  conversionRate: number;
}

export interface GaPerformanceResposta {
  linhas: GaPerformanceLinha[];
  totais: GaPerformanceTotais;
  // Quantas combinações existem no período — a lista traz no máximo as 250 maiores.
  totalCombinacoes: number;
  atualizadoEm: string;
  doCache: boolean;
}

// Vem AGRUPADO PELAS DIMENSÕES DO GA4, não das campanhas salvas — por isso mostra tráfego de UTMs
// usadas fora do Construtor (ex.: campanhas do Meta), enriquecendo com o nome salvo quando reconhece.
export function getGaPerformance(periodo: GaPeriodo, opts?: { forcarAtualizacao?: boolean }) {
  const params = new URLSearchParams({ periodo });
  if (opts?.forcarAtualizacao) params.set('atualizar', '1');
  return api<GaPerformanceResposta>(`/api/admin/integrations/google-analytics/performance?${params.toString()}`);
}

export interface GaPerformanceSerieDia {
  data: string;
  sessions: number;
  users: number;
  purchases: number;
  revenue: number;
  conversionRate: number;
}

export function getGaPerformanceSerie(
  periodo: GaPeriodo,
  combo: { source: string; medium: string; campaign: string; content: string; term: string }
) {
  const params = new URLSearchParams({ periodo, ...combo });
  return api<{ serie: GaPerformanceSerieDia[] }>(`/api/admin/integrations/google-analytics/performance/series?${params.toString()}`);
}

export interface GaOverviewTotais {
  sessions: number;
  users: number;
  newUsers: number;
  usuariosRecorrentes: number;
  pageviews: number;
  pageviewsPorSessao: number;
  avgSessionDuration: number;
  bounceRate: number;
  revenue: number;
  purchases: number;
  addToCarts: number;
  checkouts: number;
  conversionRate: number;
  ticketMedio: number;
}

export interface GaOverviewGrupo {
  rotulo: string;
  sessions: number;
  purchases: number;
  revenue: number;
  conversionRate: number;
  participacao: number;
}

export interface GaOverviewResposta {
  totais: GaOverviewTotais;
  canais: GaOverviewGrupo[];
  dispositivos: GaOverviewGrupo[];
  serie: { data: string; sessions: number; purchases: number; revenue: number }[];
  horarios: { dia: number; hora: number; sessions: number }[];
  atualizadoEm: string;
  doCache: boolean;
}

export function getGaOverview(periodo: GaPeriodo, opts?: { forcarAtualizacao?: boolean }) {
  const params = new URLSearchParams({ periodo });
  if (opts?.forcarAtualizacao) params.set('atualizar', '1');
  return api<GaOverviewResposta>(`/api/admin/integrations/google-analytics/overview?${params.toString()}`);
}
