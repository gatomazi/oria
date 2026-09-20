import { api } from './client';

export interface PedidosBackfillJob {
  id: number;
  // Chave histórica da loja — nula na Store nativa (a identidade canônica é `store_id`).
  store_id?: string | null;
  loja: string | null;
  desde: string;
  status: 'processando' | 'concluido' | 'falhou';
  paginas_processadas: number;
  paginas_total: number | null;
  pedidos_processados: number;
  erro: string | null;
  criado_em: string;
  atualizado_em: string;
}

export function iniciarBackfillPedidos(desde?: string) {
  return api<{ jobId: number }>(`/api/admin/pedidos/backfill-historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(desde ? { desde } : {}),
  });
}

export function getBackfillPedidosJob(jobId: number) {
  return api<{ job: PedidosBackfillJob }>(`/api/admin/pedidos/backfill-historico/${jobId}`);
}

export function listarBackfillsPedidos() {
  return api<{ jobs: PedidosBackfillJob[] }>(`/api/admin/pedidos/backfill-historico`);
}
