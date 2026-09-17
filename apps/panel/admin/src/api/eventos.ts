import { api } from './client';

export interface WebhookEvento {
  loja: string | null;
  eventName: string | null;
  inkOrderId: string | number | null;
  verificado: boolean;
  metodoAuth: string | null;
  recebidoEm: string | null;
  headers?: Record<string, unknown>;
  body?: unknown;
}

export function getWebhookLog() {
  return api<{ log: WebhookEvento[] }>('/api/admin/webhook-log');
}
