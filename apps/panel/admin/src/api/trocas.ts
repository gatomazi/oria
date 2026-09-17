import { api } from './client';

// Porte de src/trocas.js + src/trocas-nova.js — contrato de backend inalterado.
export interface TrocaListItem {
  id: number;
  loja: string;
  oldOrderId?: number | null;
  exchangeReason?: string | null;
  exchangeReasonLabel?: string | null;
  isCourtesy?: boolean;
  status?: string | null;
  createdAt?: string | null;
}

export interface TrocasListResponse {
  trocas: TrocaListItem[];
  approximated?: boolean;
  erros?: { loja: string; error: string }[];
  page: number;
  totalPages: number;
  totalCount?: number;
}

export interface TrocaDetalhe {
  status?: string | null;
  is_courtesy_exchange?: boolean;
  exchange_reason?: string | null;
  exchange_reason_label?: string | null;
  old_order?: { id: number } | null;
  old_external_order?: { id: number } | null;
  new_order?: { id: number } | null;
  new_external_order?: { id: number } | null;
  problem_description?: string | null;
  support_review_status?: string | null;
  refusal_reason?: string | null;
  refusal_reason_label?: string | null;
  refusal_note?: string | null;
  reviewed_at?: string | null;
}

export interface TrocasQuery {
  order_id?: string;
  waiting_for_approval?: string;
  begin_date?: string;
  end_date?: string;
  page: number;
}

export function listTrocas(query: TrocasQuery) {
  const params = new URLSearchParams();
  if (query.order_id) params.set('order_id', query.order_id);
  if (query.waiting_for_approval) params.set('waiting_for_approval', query.waiting_for_approval);
  if (query.begin_date) params.set('begin_date', query.begin_date);
  if (query.end_date) params.set('end_date', query.end_date);
  params.set('page', String(query.page));
  params.set('per_page', '20');
  return api<TrocasListResponse>(`/api/admin/trocas?${params.toString()}`);
}

export function getTroca(id: number) {
  return api<{ exchange: TrocaDetalhe }>(`/api/admin/trocas/${id}`);
}

export interface CentralOrder {
  id: number;
  exchangeable?: boolean;
  order_status?: string;
  total_value?: number | string;
  buyer?: { first_name?: string; last_name?: string };
  items?: CentralOrderItem[];
}

export interface CentralOrderItem {
  id: number;
  quantity?: number;
  unit_value?: number | string;
  product_v2?: { id: number; name?: string };
  product_variant?: { id: number };
}

export function getPedidoCentral(id: number) {
  return api<{ order: CentralOrder }>(`/api/admin/pedidos/central/${id}`);
}

export interface CriarTrocaItem {
  old_item_id: number;
  product_v2_id: number | null;
  product_variant_id: number | null;
  quantity: number;
}

export interface CriarTrocaBody {
  original_order_id: number;
  exchange_reason: string;
  items: CriarTrocaItem[];
  problem_description?: string;
  photos?: { photo_attachment: string }[];
}

export function criarTroca(body: CriarTrocaBody) {
  return api('/api/admin/trocas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
