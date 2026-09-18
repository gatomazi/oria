import { api } from './client';

export interface CampoCustomizado {
  label: string;
  valores?: Record<string, string>;
}

export function getCamposCustomizados() {
  return api<{ campos: Record<string, CampoCustomizado> }>('/api/admin/campos-customizados');
}

export function criarCampoCustomizado(chave: string, label: string) {
  return api('/api/admin/campos-customizados', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chave, label }),
  });
}

export function salvarCampoCustomizado(chave: string, label: string, valores: Record<string, string>) {
  return api(`/api/admin/campos-customizados/${encodeURIComponent(chave)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, valores }),
  });
}

export function excluirCampoCustomizado(chave: string) {
  return api(`/api/admin/campos-customizados/${encodeURIComponent(chave)}`, { method: 'DELETE' });
}
