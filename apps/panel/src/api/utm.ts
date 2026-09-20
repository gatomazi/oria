import { api } from './client';

export interface UtmCampaign {
  id: string;
  // Chave legada da loja — nula na Store nativa do Oria (a identidade canônica é `storeId`).
  storeId: string | null;
  loja: string | null;
  nome: string;
  destinationUrl: string;
  source: string;
  medium: string;
  campaign: string;
  content: string | null;
  term: string | null;
  fullUrl: string;
  criadoEm: string;
  atualizadoEm: string;
  arquivadaEm: string | null;
}

export interface UtmCampaignInput {
  nome: string;
  destinationUrl: string;
  source: string;
  medium: string;
  campaign: string;
  content?: string;
  term?: string;
}

export interface UtmPreset {
  id: string;
  nome: string;
  source: string;
  medium: string;
  criadoEm: string;
}

export type UtmCampaignStatus = 'ativas' | 'arquivadas' | 'todas';

export function listUtmCampaigns(opts: { status?: UtmCampaignStatus } = {}) {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  return api<{ campanhas: UtmCampaign[] }>(`/api/admin/utm/campaigns${qs ? `?${qs}` : ''}`);
}

export function criarUtmCampaign(input: UtmCampaignInput) {
  return api<{ campanha: UtmCampaign }>('/api/admin/utm/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function editarUtmCampaign(id: string, input: UtmCampaignInput) {
  return api<{ campanha: UtmCampaign }>(`/api/admin/utm/campaigns/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function excluirUtmCampaign(id: string) {
  return api(`/api/admin/utm/campaigns/${id}`, { method: 'DELETE' });
}

export function duplicarUtmCampaign(id: string) {
  return api<{ campanha: UtmCampaign }>(`/api/admin/utm/campaigns/${id}/duplicate`, { method: 'POST' });
}

export function arquivarUtmCampaign(id: string) {
  return api<{ campanha: UtmCampaign }>(`/api/admin/utm/campaigns/${id}/archive`, { method: 'POST' });
}

export function desarquivarUtmCampaign(id: string) {
  return api<{ campanha: UtmCampaign }>(`/api/admin/utm/campaigns/${id}/unarchive`, { method: 'POST' });
}

export function listUtmPresets() {
  return api<{ presets: UtmPreset[] }>('/api/admin/utm/presets');
}

export function criarUtmPreset(input: { nome: string; source: string; medium: string }) {
  return api<{ preset: UtmPreset }>('/api/admin/utm/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function excluirUtmPreset(id: string) {
  return api(`/api/admin/utm/presets/${id}`, { method: 'DELETE' });
}
