import { api } from './client';
import type { TemplateComponent } from '../lib/templateVariables';

export interface AutomationSettings {
  whatsappConfigurado: boolean;
  provider?: 'meta_api' | 'whatsapp_web';
  modoEnvio: 'manual' | 'automatico';
  janelaEnvio?: { inicio: number; fim: number };
}

export function getAutomationSettings() {
  return api<AutomationSettings>('/api/admin/automation-settings');
}

export function updateAutomationSettings(data: Partial<{ modoEnvio: string; janelaEnvio: { inicio: number; fim: number } }>) {
  return api('/api/admin/automation-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export interface WhatsappTemplateResumo {
  name: string;
  status: string;
  components?: TemplateComponent[];
}

export function getWhatsappTemplates() {
  return api<{ templates: WhatsappTemplateResumo[] }>('/api/admin/whatsapp-templates');
}

export interface AutomacaoEventoConfig {
  // Vínculo da API da Meta e do WhatsApp Web convivem no mesmo evento — cada modo usa o seu.
  template?: string;
  mensagemWeb?: string;
  atrasoPrimeiroEnvioHoras?: number;
  maxEnvios?: number;
  intervaloHoras?: number;
  checarCompra?: boolean;
}

export type AutomacaoEventosPorLoja = Record<string, Record<string, AutomacaoEventoConfig>>;

export function getAutomacaoEventos() {
  return api<{ eventos: AutomacaoEventosPorLoja }>('/api/admin/automacao-eventos');
}

export function salvarAutomacaoEvento(eventName: string, body: Record<string, unknown>) {
  return api(`/api/admin/automacao-eventos/${encodeURIComponent(eventName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// `modo` remove só o vínculo daquele modo, preservando o do outro.
export function removerAutomacaoEvento(eventName: string, modo?: 'api' | 'web') {
  const qs = modo ? `?modo=${modo}` : '';
  return api(`/api/admin/automacao-eventos/${encodeURIComponent(eventName)}${qs}`, { method: 'DELETE' });
}

export function getWebhookLogAutomacoes() {
  return api<{ log: import('./eventos').WebhookEvento[] }>('/api/admin/webhook-log');
}

export function getCamposCustomizadosRefs() {
  return api<{ campos: Record<string, { label: string }> }>('/api/admin/campos-customizados');
}
