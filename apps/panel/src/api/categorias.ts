import { api } from './client';

// Tipos e chamadas pra /api/admin/categorias/* — porte do que src/categorias.js já fazia via
// api() cru. Contrato de backend inalterado (ver docs/plan.md — nenhuma rota /api/admin/* muda).
export interface Categoria {
  id: number;
  name: string;
  description?: string | null;
  is_available: boolean;
  position: number;
  product_ids?: number[];
  kit_ids?: number[];
  updated_at?: string;
}

export function listCategorias() {
  return api<{ categorias: Categoria[] }>(`/api/admin/categorias`);
}

export function getCategoria(id: number) {
  return api<{ categoria: Categoria }>(`/api/admin/categorias/${id}`);
}

export function getNomesProdutosCategoria(id: number) {
  return api<{ categoria: { id: number; name: string }; total: number; encontrados: number; nomes: string[]; csv: string }>(
    `/api/admin/categorias/${id}/produtos-nomes`
  );
}

export function createCategoria(data: { name: string; description?: string; isAvailable?: boolean }) {
  return api(`/api/admin/categorias`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data }),
  });
}

export interface UpdateCategoriaInput {
  name?: string;
  description?: string;
  isAvailable?: boolean;
  productIds?: number[];
}

export function updateCategoria(id: number, data: UpdateCategoriaInput) {
  return api(`/api/admin/categorias/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function deleteCategoria(id: number) {
  return api(`/api/admin/categorias/${id}`, { method: 'DELETE' });
}

export function adicionarProduto(id: number, productId: number) {
  return api(`/api/admin/categorias/${id}/adicionar-produto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId }),
  });
}

export interface VitrineItem {
  product_id: number;
  position: number;
}

export function getVitrine(id: number) {
  return api<{ vitrine: { product_items: VitrineItem[] } }>(`/api/admin/categorias/${id}/vitrine`);
}

export function putVitrine(id: number, productItems: { productId: number }[]) {
  return api(`/api/admin/categorias/${id}/vitrine`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productItems }),
  });
}

export type StatusItemLote = 'pronta' | 'ja_existe' | 'nome_invalido' | 'duplicada_na_lista';

export interface ItemPreviewLote {
  nome: string;
  status: StatusItemLote;
}

export function bulkPreviewCategorias(nomes: string[]) {
  return api<{
    itens: ItemPreviewLote[];
    resumo: { total: number; prontas: number; jaExistem: number; invalidas: number; duplicadas: number };
  }>(`/api/admin/categorias/bulk-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomes }),
  });
}

export interface ResultadoItemLote {
  nome: string;
  status: 'criada' | 'ja_existia' | 'falhou';
  id?: number;
  error?: string;
}

export function bulkCreateCategorias(
  data: { nomes: string[]; isAvailable?: boolean; descricaoPadrao?: string }
) {
  return api<{
    resultados: ResultadoItemLote[];
    mapaIds: Record<string, number>;
    resumo: { criadas: number; existentes: number; falharam: number };
  }>(`/api/admin/categorias/bulk-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function bulkAtivarCategorias(ids: number[], isAvailable = true) {
  return api<{
    resultados: { id: number; status: 'ativada' | 'desativada' | 'falhou'; error?: string }[];
    resumo: { ativadas: number; falharam: number };
  }>(`/api/admin/categorias/bulk-ativar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, isAvailable }),
  });
}

export function bulkExcluirCategorias(ids: number[]) {
  return api<{
    resultados: { id: number; status: 'excluida' | 'falhou'; error?: string }[];
    resumo: { excluidas: number; falharam: number };
  }>(`/api/admin/categorias/bulk-excluir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}
