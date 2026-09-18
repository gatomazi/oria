import { api } from './client';
import type { AudienciaExclusoes, AudienciaFiltro } from './campanhas';

export interface Segmento {
  id: string;
  nome: string;
  match: 'ALL' | 'ANY';
  filtros: AudienciaFiltro[];
  exclusoes: AudienciaExclusoes;
  criadoPor: string | null;
  criadoEm: string;
  atualizadoEm: string;
}

export interface SegmentoInput {
  nome: string;
  match: 'ALL' | 'ANY';
  filtros: AudienciaFiltro[];
  exclusoes: AudienciaExclusoes;
}

export function listSegmentos() {
  return api<{ segmentos: Segmento[] }>('/api/admin/segments');
}

export function criarSegmento(input: SegmentoInput) {
  return api<{ segmento: Segmento }>('/api/admin/segments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function editarSegmento(id: string, input: SegmentoInput) {
  return api<{ segmento: Segmento }>(`/api/admin/segments/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function excluirSegmento(id: string) {
  return api(`/api/admin/segments/${id}`, { method: 'DELETE' });
}
