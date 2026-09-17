import { api } from './client';

// Tipos e chamadas pra /api/admin/produtos* — porte do que src/produtos.js já fazia via api()
// cru. Contrato de backend inalterado (ver docs/plan.md — nenhuma rota /api/admin/* muda).
// IMPORTANTE: a API da Ink não tem DELETE de produto — nunca adicionar essa ação (server.js
// comenta isso explicitamente acima de PATCH /api/admin/produtos/:id).

export interface ProdutoSummary {
  loja: string;
  id: number;
  name: string | null;
  mainImageUrl: string | null;
  price: string | number | null;
  promotionalPrice: string | number | null;
  visibleInStore: boolean;
  approvalStatus: string | null;
  status: string | null;
  productType: string | null;
  // null quando o resultado veio do cache do FEED, que não traz variantes (o cache do
  // catálogo e a Ink trazem).
  variantsCount: number | null;
  productClusterId: number | null;
  updatedAt: string | null;
}

export interface ListProdutosResponse {
  produtos: ProdutoSummary[];
  erros: { loja: string; error: string }[];
  approximated: boolean;
  // true quando filtro local (nome/tipo) varreu só parte do catálogo — teto de páginas do servidor.
  truncado?: boolean;
  page: number;
  perPage?: number;
  totalPages: number;
  totalCount?: number;
  // 'catalogo' = cache do catálogo completo da Ink em Postgres (qualquer filtro, sem truncamento);
  // 'cache' = cache do feed CSV (só produtos ativos, usado enquanto o catálogo não foi varrido);
  // 'ink' (ou ausente) = consulta direta na Reserva Ink.
  fonte?: 'catalogo' | 'cache' | 'ink';
  cacheSincronizadoEm?: string | null;
  // Presente só quando a fonte é o cache do catálogo (única que ordena no servidor).
  ordenacao?: { sort: string; order: 'asc' | 'desc' };
}

export interface ListProdutosQuery {
  visible_in_store?: string;
  approval_status?: string;
  name?: string;
  product_type_id?: string;
  page?: number;
  per_page?: number;
  // 'ink' força a consulta direta na Ink (dado recém-criado, sem esperar o próximo sync); sem
  // valor, o servidor serve do cache do catálogo e só cai na Ink se ele ainda estiver vazio.
  fonte?: 'ink';
  sort?: string;
  order?: 'asc' | 'desc';
}

export function listProdutos(query: ListProdutosQuery) {
  const params = new URLSearchParams();
  if (query.visible_in_store) params.set('visible_in_store', query.visible_in_store);
  if (query.approval_status) params.set('approval_status', query.approval_status);
  if (query.name) params.set('name', query.name);
  if (query.product_type_id) params.set('product_type_id', query.product_type_id);
  params.set('page', String(query.page ?? 1));
  params.set('per_page', String(query.per_page ?? 20));
  if (query.fonte) params.set('fonte', query.fonte);
  if (query.sort) params.set('sort', query.sort);
  if (query.order) params.set('order', query.order);
  return api<ListProdutosResponse>(`/api/admin/produtos?${params.toString()}`);
}

export interface CatalogoCacheStatusLoja {
  loja: string;
  configurado: boolean;
  total: number;
  sincronizadoEm: string | null;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  processados: number;
  totalEstimado: number | null;
  paginas: number;
  truncado: boolean;
  erro: string | null;
  sincronizando: boolean;
  autoPausado: boolean;
  intervaloHoras: number;
}

export function getCatalogoCacheStatus() {
  return api<{ lojas: CatalogoCacheStatusLoja[]; intervalosHoras: number[] }>('/api/admin/produtos/catalogo/status');
}

// Só o agendamento da renovação automática — não interrompe varredura em andamento.
export function salvarCatalogoCacheConfig(config: { pausado?: boolean; intervaloHoras?: number }) {
  return api<{ ok: true; autoPausado: boolean; intervaloHoras: number }>('/api/admin/produtos/catalogo/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...config }),
  });
}

// A varredura são centenas de requests à Ink e leva minutos: a resposta só confirma quais lojas
// entraram no crawl — o progresso vem do polling de getCatalogoCacheStatus.
export function sincronizarCatalogoCache() {
  return api<{ ok: true; lojas: string[]; jaRodando: string[] }>('/api/admin/produtos/catalogo/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export interface FeedProdutosStatusLoja {
  loja: string;
  configurado: boolean;
  total: number;
  sincronizadoEm: string | null;
  iniciadoEm: string | null;
  erro: string | null;
  sincronizando: boolean;
}

export function getFeedProdutosStatus() {
  return api<{ lojas: FeedProdutosStatusLoja[] }>('/api/admin/produtos/feed/status');
}

// Dispara a atualização em segundo plano (o download leva dezenas de segundos); a resposta só
// confirma quais lojas entraram na fila.
export function sincronizarFeedProdutos() {
  return api<{ ok: true; lojas: string[] }>('/api/admin/produtos/feed/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export interface ProdutoVariante {
  id: number;
  model?: string | null;
  color?: string | null;
  size?: string | null;
  is_available: boolean;
}

export interface ProdutoDetalhe {
  name: string | null;
  approval_status: string | null;
  status: string | null;
  product_type?: { name: string } | null;
  price: string | number | null;
  promotional_price?: string | number | null;
  visible_in_store: boolean;
  customizable_by_buyer: boolean;
  total_sales_count?: number | null;
  updated_at?: string | null;
  product_variants?: ProdutoVariante[];
}

export function getProduto(id: number) {
  return api<{ loja: string; produto: ProdutoDetalhe }>(`/api/admin/produtos/${id}`);
}

export interface ProdutoTipoOption {
  name: string;
  values?: string[];
}

export interface ProdutoTipoArea {
  base_image_id: number;
  model?: string | null;
  color?: { name: string } | null;
  description?: string | null;
  mockup_url?: string | null;
}

export interface ProdutoTipo {
  id: number;
  name: string;
  options?: ProdutoTipoOption[];
  printable_areas?: ProdutoTipoArea[];
}

export function listProdutoTipos() {
  return api<{ tipos: ProdutoTipo[] }>(`/api/admin/produto-tipos`);
}

export interface CriarProdutoInput {
  productTypeId: number;
  name: string;
  description?: string;
  price: string;
  tags?: string[];
  visibleInStore?: boolean;
  customizableByBuyer?: boolean;
  collections?: number[];
  newCollections?: string[];
  // 1 arte pode valer pra várias cores/versões — manda cada base64 1x só (agrupado pelas áreas
  // que usam ela), em vez de repetir o mesmo arquivo por área. O servidor expande isso pro
  // formato que a Ink exige (1 entrada por base_image_id) na perna servidor→Ink.
  artGroups: { base_image_ids: number[]; art_attachment: string }[];
}

export function criarProduto(data: CriarProdutoInput) {
  return api(`/api/admin/produtos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function atualizarProduto(id: number, data: { visibleInStore?: boolean }) {
  return api(`/api/admin/produtos/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export interface DuplicarProdutoInput {
  productTypeId: number;
  price?: string;
  includeCategories: boolean;
}

export function duplicarProduto(id: number, data: DuplicarProdutoInput) {
  return api(`/api/admin/produtos/${id}/duplicar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
