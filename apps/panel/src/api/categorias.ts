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
  /** Só na listagem: quantidade de produtos (a lista não traz os ids — estão no detalhe). */
  product_count?: number;
  kit_ids?: number[];
  updated_at?: string;
}

export interface ListaDeCategorias {
  categorias: Categoria[];
  page?: number;
  totalPages?: number;
  totalCount?: number | null;
  /** 'cache' = sync de Categorias (depois da 1ª varredura concluída); 'ink' = leitura ao vivo. */
  fonte?: 'cache' | 'ink';
  /** Só com `fonte: 'cache'`: quando o cache foi atualizado pela última vez. */
  sincronizadoEm?: string | null;
}

// ── Sync de Categorias (cache das collections da Ink) ──────────────────
export interface CategoriasCacheStatus {
  storeId: string;
  configurado: boolean;
  total: number;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  paginas: number;
  erro: string | null;
  sincronizando: boolean;
  autoPausado: boolean;
  intervaloHoras: number;
  intervalosHoras: number[];
}

export function getCategoriasCacheStatus() {
  return api<CategoriasCacheStatus>('/api/admin/categorias/cache/status');
}

// Responde na hora; o progresso vem do polling de getCategoriasCacheStatus.
export function sincronizarCategoriasCache() {
  return api<{ ok: true; jaRodando: boolean }>('/api/admin/categorias/cache/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// Só o agendamento da renovação automática — não interrompe varredura em andamento.
export function salvarCategoriasCacheConfig(config: { pausado?: boolean; intervaloHoras?: number }) {
  return api<{ ok: true; autoPausado: boolean; intervaloHoras: number }>('/api/admin/categorias/cache/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...config }),
  });
}

/** Sem `opts` devolve a lista de sempre (seletores); com `opts.page` devolve só aquela página e os totais. */
export function listCategorias(opts?: { page: number; perPage?: number }) {
  const qs = opts ? `?page=${opts.page}&per_page=${opts.perPage ?? 25}` : '';
  return api<ListaDeCategorias>(`/api/admin/categorias${qs}`);
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
