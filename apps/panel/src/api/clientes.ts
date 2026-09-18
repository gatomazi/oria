import { api } from './client';

// Porte de src/clientes.js.
export interface ClienteInk {
  loja: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  documento: string | null;
  aceitaMarketing: boolean;
}

export interface ClienteCompra {
  loja: string;
  documento: string | null;
  telefone: string | null;
  totalCompras: number;
  // Lucro operacional somado dos pedidos pagos (sem troca); `pedidosSemFinanceiro` são pagos ainda
  // sem custo calculado, fora da soma.
  lucroOperacional: number;
  pedidosSemFinanceiro: number;
  ultimaCompraEm: string | null;
  diasSemComprar: number | null;
}

export function getCustomers() {
  return api<{ clientes: ClienteInk[] }>('/api/admin/dashboard/customers');
}

// Histórico de compras é opcional (exige Postgres) — fetch cru, não `api()`, pra não estourar um
// toast de erro só porque esse extra não está disponível (mesmo comportamento do vanilla).
export function getComprasOpcional(): Promise<{ clientes: ClienteCompra[] }> {
  return fetch('/api/admin/clientes', { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : { clientes: [] }))
    .catch(() => ({ clientes: [] }));
}
