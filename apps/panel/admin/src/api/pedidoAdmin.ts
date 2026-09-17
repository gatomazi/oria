import { api } from './client';

// Tipos e chamadas pra /api/admin/pedidos (fila de Pix pendentes) — porte de src/pedido-admin.js,
// src/pedido-novo.js e src/pedido-vincular.js (mesmo recurso). Contrato de backend inalterado.
export interface PedidoPix {
  id: string;
  cliente?: string | null;
  referencia?: string | null;
  loja: string;
  valor?: string | number | null;
  origem: 'ink' | 'manual';
  orderStatusLabel?: string | null;
  paymentStatus?: string | null;
}

export function listPedidosPix() {
  return api<{ pedidos: PedidoPix[] }>('/api/admin/pedidos');
}

export function syncPedidoPix(id: string) {
  return api(`/api/admin/pedidos/${id}/sync`, { method: 'POST' });
}

export function deletePedidoPix(id: string) {
  return api(`/api/admin/pedidos/${id}`, { method: 'DELETE' });
}

export interface CriarPixManualInput {
  cliente: string;
  referencia: string;
  valor: string;
  pixCode: string;
}

export function criarPixManual(data: CriarPixManualInput) {
  return api<{ url: string }>('/api/admin/pedidos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function qrPreview(pixCode: string) {
  return api<{ dataUrl: string }>('/api/admin/qr-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pixCode }),
  });
}

export interface PedidoInkPendente {
  inkOrderId: string | number;
  rsvFactoryId?: string | number | null;
  loja: string;
  cliente?: string | null;
  valor?: string | number | null;
  criadoEm?: string | null;
  jaVinculado?: boolean;
}

export function listPedidosInkPendentes() {
  return api<{ pedidos: PedidoInkPendente[]; erros?: string[] }>('/api/admin/pedidos/ink/pendentes');
}

export function vincularPedidoInk(inkOrderId: string | number) {
  return api<{ url: string }>('/api/admin/pedidos/ink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inkOrderId }),
  });
}
