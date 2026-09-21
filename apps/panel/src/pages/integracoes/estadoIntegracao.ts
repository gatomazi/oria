// Estado de integração (read model do servidor) → rótulo e tom do selo.
//
// O SERVIDOR decide o estado (lib/platform/integration-read-model.js); aqui só se traduz em texto.
// Nenhum card recalcula "conectado" por conta própria — é isso que impedia dois cards de se
// contradizerem. Tom: `warning` é ação necessária, `danger` é falha, `neutral` é "não é com você agora".

export type EstadoIntegracao =
  | 'not_entitled' | 'platform_unavailable' | 'not_configured' | 'configured' | 'connecting'
  | 'connected' | 'connected_with_data' | 'degraded' | 'error' | 'deferred' | 'coming_soon';

export type ProximaAcao = 'none' | 'ask_plan' | 'wait_platform' | 'configure' | 'select_resource' | 'reconnect' | 'retry';

export interface IntegracaoLeitura {
  provider: string;
  estado: EstadoIntegracao;
  proximaAcao: ProximaAcao;
  entitled: boolean | null;
  platformAvailable: boolean;
  componentes?: Record<string, string | null>;
  leituraFalhou?: boolean;
}

export type TomSelo = 'success' | 'warning' | 'danger' | 'neutral';

const ROTULOS: Record<EstadoIntegracao, { label: string; tone: TomSelo }> = {
  not_entitled: { label: 'Não incluída no plano', tone: 'neutral' },
  platform_unavailable: { label: 'Indisponível na plataforma', tone: 'neutral' },
  not_configured: { label: 'Não configurada', tone: 'neutral' },
  configured: { label: 'Falta escolher a conta', tone: 'warning' },
  connecting: { label: 'Conectando…', tone: 'neutral' },
  connected: { label: 'Conectada', tone: 'success' },
  connected_with_data: { label: 'Conectada, com dados', tone: 'success' },
  degraded: { label: 'Com problema', tone: 'warning' },
  error: { label: 'Erro — reconectar', tone: 'danger' },
  deferred: { label: 'Adiada', tone: 'neutral' },
  coming_soon: { label: 'Em breve', tone: 'neutral' },
};

export function seloDoEstado(estado: EstadoIntegracao): { label: string; tone: TomSelo } {
  return ROTULOS[estado] || { label: 'Desconhecido', tone: 'neutral' };
}

export const NOME_DO_PROVIDER: Record<string, string> = {
  ink: 'Reserva Ink',
  ga4: 'Google Analytics 4',
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  whatsapp: 'WhatsApp',
  openai: 'OpenAI',
  instagram: 'Instagram',
};

// A Ink tem duas partes com estados próprios. "API conectada" não depende do webhook, que hoje está
// adiado de propósito: sem webhook a integração NÃO fica "pendente" nem "com erro".
export function rotuloDaApiInk(estadoApi: string | null | undefined): { label: string; tone: TomSelo } {
  return estadoApi === 'connected' ? { label: 'API conectada', tone: 'success' } : { label: 'API não configurada', tone: 'neutral' };
}

export function rotuloDoWebhookInk(estadoWebhook: string | null | undefined): { label: string; tone: TomSelo } {
  return estadoWebhook === 'connected' ? { label: 'Webhook ativo', tone: 'success' } : { label: 'Webhook não ativado', tone: 'neutral' };
}
