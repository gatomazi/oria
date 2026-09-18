import { api } from './client';

export interface ReservaInkStatus {
  loja: string;
  tokenConfigurado: boolean;
  webhookConfigurado: boolean;
  ultimoEventoEm: string | null;
}

export interface WhatsappStatus {
  conectado: boolean;
  observacao?: string | null;
  provider?: 'meta_api' | 'whatsapp_web';
}

export interface IntegrationsData {
  reservaInk: ReservaInkStatus[];
  whatsapp: WhatsappStatus;
}

export function getIntegrations() {
  return api<IntegrationsData>('/api/admin/integrations');
}

// ID do app da Meta que o serviço de WhatsApp usa pra subir a mídia de exemplo dos templates.
export interface WhatsappMetaApp {
  appId: string;
}

export function getWhatsappMetaApp() {
  return api<WhatsappMetaApp>('/api/admin/whatsapp/meta-app');
}

export function updateWhatsappMetaApp(appId: string) {
  return api<WhatsappMetaApp>('/api/admin/whatsapp/meta-app', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId }),
  });
}

// ── Fase 4: credenciais por Organization ─────────────────────────────────────────────────────
// O painel nunca recebe o segredo: só status, últimos 4 caracteres e validade.
export interface SegredoMetadata {
  tipo: string;
  last4: string | null;
  keyVersion: number | null;
  expiresAt: string | null;
  rotatedAt: string | null;
  status: 'active' | 'expired';
}

export interface InkCredenciais {
  status: string;
  segredos: SegredoMetadata[];
  viaEnvLegado?: string[];
  // Fase 5c: URL do webhook por integração (o caminho só volta na hora de gerar).
  webhook?: { urlEmitida: boolean; urlEmitidaEm: string | null; segredoCadastrado: boolean };
}

export function getInkCredenciais() {
  return api<InkCredenciais>('/api/admin/integrations/ink/credenciais');
}

export function salvarInkCredenciais(dados: { apiToken?: string; feedUrl?: string; webhookSecret?: string }) {
  return api<InkCredenciais>('/api/admin/integrations/ink/credenciais', {
    method: 'PUT',
    body: JSON.stringify(dados),
  });
}

export function gerarUrlWebhookInk() {
  return api<{ caminho: string; criadoEm: string }>('/api/admin/integrations/ink/webhook-url', { method: 'POST', body: '{}' });
}

export function removerInkCredenciais() {
  return api<{ ok: true }>('/api/admin/integrations/ink/credenciais', { method: 'DELETE' });
}

// ── Fase 5b: remetente WhatsApp da Organization ───────────────────────────────────────────
// Número e conta (WABA) são visíveis; do token a tela só recebe last4 e datas.
export interface WhatsappRemetente {
  status: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  // Fase 5c: comportamento por loja (antes eram variáveis do serviço de envio). Vazio desliga.
  replyRedirectMessage: string;
  notifyNumber: string;
  token: SegredoMetadata | null;
}

export function getWhatsappRemetente() {
  return api<WhatsappRemetente>('/api/admin/whatsapp/remetente');
}

export function salvarWhatsappRemetente(dados: {
  phoneNumberId: string;
  wabaId: string;
  accessToken?: string;
  replyRedirectMessage?: string;
  notifyNumber?: string;
}) {
  return api<WhatsappRemetente>('/api/admin/whatsapp/remetente', {
    method: 'PUT',
    body: JSON.stringify(dados),
  });
}

export function removerWhatsappRemetente() {
  return api<{ ok: true }>('/api/admin/whatsapp/remetente', { method: 'DELETE' });
}

export type ProviderIntegracao = 'ink' | 'meta' | 'google_ads' | 'ga4' | 'openai' | 'whatsapp';

export interface ResultadoTesteConexao {
  provider: ProviderIntegracao;
  status: 'connected' | 'error';
  codigo?: string;
}

export function testarConexao(provider: ProviderIntegracao) {
  return api<ResultadoTesteConexao>(`/api/admin/integrations/${provider}/teste`, { method: 'POST', body: '{}' });
}
