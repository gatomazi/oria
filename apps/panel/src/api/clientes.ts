import { api } from './client';

export interface Cliente {
  loja: string;
  customerKey: string;
  nome: string | null;
  email: string | null;
  telefone: string | null;
  documento: string | null;
  aceitaMarketing: boolean;
  totalCompras: number;
  // Lucro operacional somado dos pedidos pagos (sem troca); `pedidosSemFinanceiro` são pagos ainda
  // sem custo calculado, fora da soma.
  lucroOperacional: number;
  pedidosSemFinanceiro: number;
  ultimaCompraEm: string | null;
  diasSemComprar: number | null;
}

export type OrdemClientes = 'compras_desc' | 'lucro_desc' | 'inativos_primeiro' | 'nome';

export interface ListaDeClientes {
  clientes: Cliente[];
  page: number;
  perPage: number;
  totalPages: number;
  total: number;
}

export interface FiltroClientes {
  page: number;
  perPage: number;
  ordem: OrdemClientes;
  busca: string;
  inativoDias: string;
}

// Busca, ordem e filtro rodam no servidor antes de fatiar a página (valem para a lista inteira).
export function listClientes({ page, perPage, ordem, busca, inativoDias }: FiltroClientes) {
  const qs = new URLSearchParams({ page: String(page), per_page: String(perPage), ordem });
  if (busca.trim()) qs.set('busca', busca.trim());
  if (inativoDias) qs.set('inativoDias', inativoDias);
  return api<ListaDeClientes>(`/api/admin/clientes/lista?${qs.toString()}`);
}
