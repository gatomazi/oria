import { api } from './client';

// Despesas operacionais (spec §53X). Recorrência mensal é UMA linha no banco, expandida na leitura
// pelo backend — o frontend nunca reimplementa essa conta, senão as duas versões divergem.

export type DespesaCategoria =
  | 'PAYMENT_FEES' | 'TRAFFIC_MANAGER' | 'DESIGNER' | 'APPS' | 'PLATFORM' | 'SHIPPING' | 'TAXES' | 'OTHER';

export const CATEGORIA_ROTULO: Record<string, string> = {
  PAYMENT_FEES: 'Taxas de pagamento',
  TRAFFIC_MANAGER: 'Gestor de tráfego',
  DESIGNER: 'Designer',
  APPS: 'Apps e integrações',
  PLATFORM: 'Plataforma',
  SHIPPING: 'Frete subsidiado',
  TAXES: 'Impostos',
  OTHER: 'Outras despesas',
};

export interface Despesa {
  id: number;
  categoria: DespesaCategoria;
  descricao: string;
  valor: number;
  data: string;
  recorrencia: 'unica' | 'mensal';
  fim: string | null;
  notas: string | null;
}

// O formulário trabalha com strings (é o que <input> devolve); a conversão acontece no envio.
export interface DespesaInput {
  categoria: string;
  descricao: string;
  valor: string | number;
  data: string;
  recorrencia: 'unica' | 'mensal';
  fim: string;
  notas: string;
}

export interface DespesaLinhaPeriodo {
  id: number;
  categoria: DespesaCategoria;
  descricao: string;
  valor: number;
  recorrencia: 'unica' | 'mensal';
  // Quantas vezes incidiu no período — 1 por mês tocado, no caso das mensais.
  ocorrencias: number;
  subtotal: number;
  // 'manual' veio do cadastro. Quando taxas de gateway forem lidas do pedido, a mesma estrutura
  // recebe 'automatico' sem mudar a tela (spec §53Y).
  origem: 'manual' | 'automatico';
}

export function listarDespesas(periodo?: { from: string; to: string }) {
  const params = new URLSearchParams();
  if (periodo) { params.set('from', periodo.from); params.set('to', periodo.to); }
  return api<{
    despesas: Despesa[];
    categorias: DespesaCategoria[];
    periodo: { total: number; porCategoria: Record<string, number>; linhas: DespesaLinhaPeriodo[] } | null;
  }>(`/api/admin/financeiro/despesas?${params.toString()}`);
}

export function criarDespesa(corpo: DespesaInput & { valor: number }) {
  return api<{ id: string }>('/api/admin/financeiro/despesas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

export function atualizarDespesa(id: number, corpo: DespesaInput & { valor: number }) {
  return api<{ ok: true }>(`/api/admin/financeiro/despesas/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

export function excluirDespesa(id: number) {
  return api(`/api/admin/financeiro/despesas/${id}`, { method: 'DELETE' });
}
