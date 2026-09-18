import { api } from './client';

// Tipos e chamadas pra /api/admin/pedidos/central* — porte do que src/pedidos-central.js já
// fazia via api() cru. Contrato de backend inalterado.
export interface PedidoResumo {
  inkOrderId: number | string;
  loja: string;
  cliente: string | null;
  itemsCount: number | null; // null quando a lista vem do cache e o pedido ainda não tem a contagem
  valor: number | string | null;
  paymentStatus: string;
  orderStatus: string;
  createdAt: string;
}

export interface ListaPedidosCentral {
  pedidos: PedidoResumo[];
  approximated?: boolean;
  erros?: { loja: string; error: string }[];
  page: number;
  totalPages: number;
  totalCount?: number;
  // 'cache' = lista do Postgres (pedidos_ink), ordenável sobre todo o histórico; 'ink' = consulta
  // ao vivo (sem ordenação: a API da Ink não ordena).
  fonte?: 'cache' | 'ink';
  ordenacao?: { sort: string; order: 'asc' | 'desc' };
  cacheSincronizadoEm?: string | null;
  cacheDesde?: string | null;
}

export interface OrderBuyer {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  document?: string;
}

export interface OrderItem {
  id: number;
  quantity?: number;
  total_value?: number | string;
  unit_value?: number | string;
  product_variant?: { name?: string };
  product_v2?: { name?: string };
}

export interface OrderDelivery {
  carrier?: string;
  shipping_type?: string;
  current_status?: string;
  estimated_delivery_date?: string;
  delivered_at?: string;
  history?: { created_at: string; description?: string; event?: string }[];
}

export interface Order {
  buyer?: OrderBuyer;
  total_value?: number | string;
  payment_method?: string;
  created_at?: string;
  promotion_code?: string;
  items?: OrderItem[];
  delivery?: OrderDelivery;
  tracking_url?: string;
  payment_status: string;
  order_status: string;
}

export interface TimelineEvento {
  em: string;
  evento?: string;
}

export interface PedidoCentralDetalhe {
  order: Order;
  timeline?: TimelineEvento[];
}

export function listPedidosCentral(query: string) {
  return api<ListaPedidosCentral>(`/api/admin/pedidos/central?${query}`);
}

export function getPedidoCentral(inkOrderId: string | number) {
  return api<PedidoCentralDetalhe>(`/api/admin/pedidos/central/${inkOrderId}`);
}
