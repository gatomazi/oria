import { api } from './client';

// Google Ads — somente leitura. O painel nunca fala com o Google: o sync grava no Postgres e estas
// rotas leem de lá. Por isso nenhuma chamada aqui demora o tempo de uma API externa.

export interface GoogleAdsConta {
  customerId: string;
  /** "123-456-7890" — o formato que a interface do Google mostra. */
  customerIdFormatado: string | null;
  nome: string | null;
  moeda: string | null;
  fuso: string | null;
  /** Conta de administrador (MCC) não veicula anúncio: nunca terá métrica. */
  manager: boolean;
  teste: boolean;
  selecionada: boolean;
  lojaAtribuida: string | null;
  // A conta é da Store da sessão? (canônico por store_id; o texto legado só vale com chave legada.)
  atribuidaAEstaStore: boolean;
  ultimoSync: string | null;
}

export interface GoogleAdsStatus {
  oauthConfigurado: boolean;
  conectado: boolean;
  status: 'connected' | 'disconnected' | 'error' | string;
  email: string | null;
  erroCodigo: string | null;
  erroMensagem: string | null;
  ultimoSync: string | null;
  syncEmAndamento?: boolean;
  contas: GoogleAdsConta[];
}

export interface GoogleAdsTotais {
  impressoes: number;
  cliques: number;
  custo: number;
  conversoes: number;
  valorConversoes: number;
  videoViews: number | null;
  /** null quando não há base para calcular — a tela mostra "—", nunca zero. */
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  roas: number | null;
  taxaConversao: number | null;
}

export interface GoogleAdsDia extends GoogleAdsTotais {
  data: string;
}

export interface GoogleAdsCampanha extends GoogleAdsTotais {
  campaignId: string;
  nome: string;
}

export interface GoogleAdsOverview {
  conectado: boolean;
  conta: { customerId: string; customerIdFormatado: string | null; nome: string | null; moeda: string | null; lojaAtribuida: string | null; atribuidaAEstaStore: boolean } | null;
  dias?: number;
  /** Primeiro dia do recorte (AAAA-MM-DD). Sem ele não há comparação possível com o Google. */
  de?: string;
  /** Último dia do recorte — inclui hoje, que ainda está incompleto. */
  ate?: string;
  sincronizadoEm?: string | null;
  total: GoogleAdsTotais | null;
  serie: GoogleAdsDia[];
  campanhas: GoogleAdsCampanha[];
}

export function getGoogleAdsStatus() {
  return api<GoogleAdsStatus>('/api/admin/integrations/google-ads/status');
}

export function urlConectarGoogleAds() {
  return api<{ url: string }>('/api/admin/integrations/google-ads/oauth/start');
}

export function desconectarGoogleAds() {
  return api<{ ok: true }>('/api/admin/integrations/google-ads/disconnect', { method: 'POST' });
}

export interface GoogleAdsAvisoConta {
  customerId: string;
  codigo: string | null;
  mensagem: string;
}

export function listarGoogleAdsContas() {
  return api<{ contas: number; apiCalls: number; avisos: GoogleAdsAvisoConta[] }>(
    '/api/admin/integrations/google-ads/contas/sincronizar',
    { method: 'POST' }
  );
}

export function selecionarGoogleAdsConta(customerId: string) {
  return api<{ ok: true }>(`/api/admin/integrations/google-ads/contas/${encodeURIComponent(customerId)}/selecionar`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Dispara e volta na hora: o sync roda em background e a tela acompanha pelo status. */
export function sincronizarGoogleAdsAgora(dias?: number) {
  return api<{ iniciado: true; dias: number }>(
    '/api/admin/integrations/google-ads/sync',
    { method: 'POST', body: JSON.stringify(dias ? { dias } : {}) }
  );
}

// Vincula a conta à loja da Organization ativa (a loja vem da sessão, nunca do navegador).
export function atribuirLojaGoogleAds(customerId: string) {
  return api<{ ok: true }>(`/api/admin/integrations/google-ads/contas/${encodeURIComponent(customerId)}/loja`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function getGoogleAdsOverview(dias: number) {
  return api<GoogleAdsOverview>(`/api/admin/analytics/google-ads/overview?dias=${dias}`);
}

// Cada código tem uma ação diferente do usuário. O de acesso de teste é o que mais importa
// separar: a solução é subir o nível no Google Cloud, e dizer "sem permissão" faria a pessoa
// tentar reconectar a conta para sempre sem nunca resolver.
export function mensagemErroGoogleAds(codigo: string | null, fallback?: string | null): string {
  switch (codigo) {
    case 'GOOGLE_ADS_ACESSO_DE_TESTE':
      return 'O projeto no Google Cloud está com acesso de Teste, que só lê contas de teste. Suba para Exploração na página da API Google Ads — reconectar aqui não resolve.';
    case 'GOOGLE_ADS_TOKEN_EXPIRED':
    case 'TOKEN_ILEGIVEL':
    case 'REFRESH_FALHOU':
      return 'A conexão com o Google expirou. Conecte novamente para voltar a sincronizar.';
    case 'GOOGLE_ADS_PERMISSION_DENIED':
      return 'A conta Google conectada não tem permissão de leitura nesta conta de anúncios.';
    case 'GOOGLE_ADS_RATE_LIMIT':
      return 'Limite de requisições do Google atingido. A próxima sincronização tenta de novo.';
    case 'GOOGLE_ADS_ACCOUNT_NOT_FOUND':
      return 'A conta de anúncios escolhida não existe mais ou saiu do seu acesso.';
    case 'GOOGLE_ADS_QUERY_INVALIDA':
      return 'A consulta enviada ao Google Ads foi recusada. Isso é um defeito do painel, não da sua conta.';
    case 'OAUTH_RECUSADO':
      return 'A autorização foi recusada na tela do Google.';
    case 'OAUTH_SEM_CODIGO':
    case 'OAUTH_FALHOU':
      return 'A autorização não foi concluída. Tente conectar novamente.';
    default:
      return fallback || 'Não foi possível falar com o Google Ads.';
  }
}
