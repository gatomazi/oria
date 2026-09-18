import { api } from './client';

// Porte de src/reembolsos.js + src/admin/refund-modal.js — contrato de backend inalterado.
export interface ReembolsoListItem {
  entityId: string;
  loja: string;
  before?: { cliente?: string; isTotal?: boolean; reason?: string };
  criadoEm?: string;
}

export function listReembolsos() {
  return api<{ reembolsos: ReembolsoListItem[] }>('/api/admin/reembolsos');
}

export interface RefundedItemInput {
  order_item_id: number;
  requested_quantity: number;
}

export interface CriarReembolsoBody {
  reason: string;
  refundedItems: RefundedItemInput[];
  confirmadoTotal?: boolean;
}

export function criarReembolso(orderId: number, body: CriarReembolsoBody) {
  return api(`/api/admin/pedidos/${orderId}/reembolsos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
