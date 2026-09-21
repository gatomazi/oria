import { api } from './client';

// Tipos e chamadas pra /api/admin/agrupamentos/* — porte do que src/agrupamentos.js já fazia.
export interface Agrupamento {
  id: number;
  default_product_id: number;
  product_ids: number[];
  // Só na listagem (GET .../:loja) — resolvido no backend a partir do produto de vitrine.
  defaultProductName?: string | null;
  defaultProductImageUrl?: string | null;
}

export interface ProdutoResumo {
  id: number;
  name: string;
  product_type?: { name: string } | null;
}

export interface ListaDeAgrupamentos {
  agrupamentos: Agrupamento[];
  page?: number;
  totalPages?: number;
  totalCount?: number | null;
}

/** Sem `opts` devolve a lista de sempre; com `opts.page` devolve só aquela página e os totais. */
export function listAgrupamentos(opts?: { page: number; perPage?: number }) {
  const qs = opts ? `?page=${opts.page}&per_page=${opts.perPage ?? 25}` : '';
  return api<ListaDeAgrupamentos>(`/api/admin/agrupamentos${qs}`);
}

export function getAgrupamento(id: number) {
  return api<{ loja: string; agrupamento: Agrupamento; produtos: ProdutoResumo[] }>(`/api/admin/agrupamentos/${id}`);
}

export function criarAgrupamento(productIds: number[]) {
  return api<{ loja: string; agrupamento: Agrupamento }>(`/api/admin/agrupamentos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productIds }),
  });
}

export function removerProdutoDoAgrupamento(clusterId: number, produtoId: number) {
  return api<{ loja: string; agrupamento: Agrupamento | null; dissolvido: boolean }>(
    `/api/admin/agrupamentos/${clusterId}/produtos/${produtoId}`,
    { method: 'DELETE' },
  );
}
