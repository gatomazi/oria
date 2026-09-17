import { api } from './client';
import type { TemplateComponent } from '../lib/templateVariables';

// Tipos e chamadas pra /api/admin/whatsapp-templates, /api/admin/campos-customizados,
// /api/admin/webhook-log e /api/admin/automacao-eventos (as duas últimas também são usadas por
// Automações — os wrappers de automacao-eventos aqui são deliberadamente próprios desta página,
// não compartilhados com admin-app/src/api/automacoes.ts, pra evitar 2 agentes editando o mesmo
// arquivo em paralelo durante a Fase 3; é uma pequena duplicação aceita, não uma divergência de
// contrato — ambos batem no mesmo endpoint do backend).
export interface WhatsappTemplateEvento {
  loja: string;
  evento: string;
}

export interface WhatsappTemplate {
  name: string;
  category?: string;
  language?: string;
  status: string;
  rejected_reason?: string;
  components?: TemplateComponent[];
  config?: {
    tipo?: string;
    headerTipo?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
    sampleMediaAssetId?: number | null;
    sampleLocation?: { nome: string; endereco: string; latitude: number; longitude: number } | null;
  };
  eventos?: WhatsappTemplateEvento[];
}

export function listTemplates() {
  return api<{ templates: WhatsappTemplate[] }>('/api/admin/whatsapp-templates');
}

export function deleteTemplate(nome: string) {
  return api(`/api/admin/whatsapp-templates/${encodeURIComponent(nome)}`, { method: 'DELETE' });
}

export type HeaderTipo = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';

export interface SampleLocation {
  nome: string;
  endereco: string;
  latitude: number;
  longitude: number;
}

export interface NovoTemplateInput {
  nome: string;
  categoria: string;
  tipo: string;
  headerTexto: string | null;
  headerVariavel: string | null;
  corpo: string;
  corpoVariaveis: string[];
  footer: string | null;
  botoes: { tipo: string; texto: string; valor: string; urlTipo?: string; variavel?: string }[];
  headerTipo: HeaderTipo;
  sampleMediaAssetId: number | null;
  sampleLocation: SampleLocation | null;
}

export function criarTemplate(input: NovoTemplateInput) {
  return api('/api/admin/whatsapp-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface TestarTemplateInput {
  telefone: string;
  valores: {
    header?: string;
    corpo: string[];
    botao?: string;
  };
}

export function testarTemplate(nome: string, input: TestarTemplateInput) {
  return api(`/api/admin/whatsapp-templates/${encodeURIComponent(nome)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface VincularAmostraInput {
  headerTipo: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
  sampleMediaAssetId?: number | null;
  sampleLocation?: SampleLocation | null;
}

// Templates criados antes da "amostra de mídia" existir (ou direto no Gerenciador da Meta, fora
// do painel) não têm sampleMediaAssetId/sampleLocation salvos aqui — sem isso, "enviar teste" e
// os disparos automáticos não sabem que mídia reenviar no header. Esse endpoint vincula/atualiza
// essa amostra pra um template que já existe, sem precisar recriá-lo na Meta.
export function vincularAmostraTemplate(nome: string, input: VincularAmostraInput) {
  return api(`/api/admin/whatsapp-templates/${encodeURIComponent(nome)}/amostra`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface CampoCustomizadoAPI {
  label: string;
  valores?: Record<string, string>;
}

export function listCamposCustomizados() {
  return api<{ campos: Record<string, CampoCustomizadoAPI> }>('/api/admin/campos-customizados');
}

export interface AutomacaoEventoConfig {
  template?: string;
  headerVariavel?: string | null;
  corpoVariaveis?: string[];
  botaoVariavel?: string | null;
  atrasoPrimeiroEnvioHoras?: number;
  maxEnvios?: number;
  intervaloHoras?: number;
  checarCompra?: boolean;
}

export function listAutomacaoEventos() {
  return api<{ eventos: Record<string, Record<string, AutomacaoEventoConfig>> }>('/api/admin/automacao-eventos');
}

export function putAutomacaoEvento(evento: string, body: AutomacaoEventoConfig) {
  return api(`/api/admin/automacao-eventos/${encodeURIComponent(evento)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteAutomacaoEvento(evento: string) {
  return api(`/api/admin/automacao-eventos/${encodeURIComponent(evento)}`, { method: 'DELETE' });
}

export interface WebhookLogEntry {
  eventName?: string;
}

export function listWebhookLog() {
  return api<{ log: WebhookLogEntry[] }>('/api/admin/webhook-log');
}
