import { api } from './client';
import type { ListProdutosQuery } from './produtos';

// Filtros aceitos pelo preview/execução — mesmo shape de GET /api/admin/produtos (+ "name"),
// pra reaproveitar exatamente o que já é suportado pelo backend de produtos.
export type FiltrosProdutos = Pick<ListProdutosQuery, 'visible_in_store' | 'approval_status' | 'name' | 'product_type_id'> & {
  begin_date?: string;
  end_date?: string;
};

export type ModoAssociacao = 'add' | 'replace';

export interface SelecaoManual {
  productIds: number[];
}

export interface PreviewAssignmentInput {
  categoryIds: number[];
  mode: ModoAssociacao;
  filtros?: FiltrosProdutos;
  selecaoManual?: SelecaoManual;
  // Só vale no modo 'add' — transferência (tira dessa(s), coloca na(s) nova(s)) num job só.
  removeCategoryIds?: number[];
}

export interface AmostraProdutoPreview {
  id: number;
  name: string | null;
  categoriasAntes: string[];
  categoriasDepois: string[];
}

export function previewCategoryAssignment(input: PreviewAssignmentInput) {
  return api<{ total: number; truncado?: boolean; amostra: AmostraProdutoPreview[]; categoriasNomes: { id: number; name?: string }[] }>(
    '/api/admin/category-assignments/preview',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
  );
}

export function criarCategoryAssignmentJob(input: PreviewAssignmentInput) {
  return api<{ jobId: number; total: number }>('/api/admin/category-assignments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export type BulkCategoryJobStatus =
  | 'draft' | 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';

export interface BulkCategoryJob {
  id: number;
  loja: string;
  mode: ModoAssociacao;
  category_ids: number[];
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  status: BulkCategoryJobStatus;
  criado_em: string;
  finalizado_em: string | null;
}

export interface FalhaJobItem {
  id: number;
  product_id: number;
  error: string | null;
  attempts: number;
}

export function getCategoryJob(id: number) {
  return api<{ job: BulkCategoryJob; falhas: FalhaJobItem[] }>(`/api/admin/category-jobs/${id}`);
}

export function retryFailedCategoryJob(id: number) {
  return api(`/api/admin/category-jobs/${id}/retry-failed`, { method: 'POST' });
}

export function cancelCategoryJob(id: number) {
  return api(`/api/admin/category-jobs/${id}/cancel`, { method: 'POST' });
}

export interface DebugChamadaInk {
  titulo: string;
  method: string;
  path: string;
  idempotencyKey?: string;
  body?: unknown;
  status: number | null;
  response: unknown;
  ocorreuEm: string;
}

export interface DebugTestarItemResultado {
  produtoAtual: unknown;
  produtoAtualErro: unknown;
  request: { method: string; path: string; idempotencyKey: string; body: unknown };
  success: boolean;
  response: unknown;
  requests: DebugChamadaInk[];
}

export function debugTestarItem(itemId: number) {
  return api<DebugTestarItemResultado>(`/api/admin/internal/origens-migration/debug/testar-item/${itemId}`, { method: 'POST' });
}

export interface FalhaPorTipo {
  id: number;
  nome: string;
  quantidade: number;
}

export function falhasPorTipo(jobId: number) {
  return api<{ totalAnalisado: number; semTipo: number; tipos: FalhaPorTipo[] }>(`/api/admin/category-jobs/${jobId}/falhas-por-tipo`);
}
