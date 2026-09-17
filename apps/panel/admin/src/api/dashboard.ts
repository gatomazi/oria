import { api } from './client';

export type PaymentBucket = 'aguardando' | 'pago' | 'problema' | 'desconhecido';

export interface DashboardPedido {
  loja: string;
  cliente: string | null;
  valor: number | string | null;
  paymentStatus: string | null;
  paymentBucket: PaymentBucket;
  orderStatus: string | null;
  orderStatusLabel: string | null;
  createdAt: string | null;
  hotpageId: string | null;
  temPixPendente: boolean;
  inkOrderId: string | number | null;
}

export interface RecuperacaoResumo {
  mensagensEnviadas: number;
  carrinhosConvertidos: number;
  receitaRecuperada: number;
  carrinhosTentados: number;
  taxaConversao: number | null;
  porDia: Record<string, number>;
}

export interface DashboardResumo {
  aguardando: number;
  pago: number;
  problema: number;
  desconhecido: number;
}

export interface DashboardErro {
  loja: string;
  error: string;
}

export interface DashboardOrdersData {
  pedidos: DashboardPedido[];
  resumo: DashboardResumo;
  erros: DashboardErro[];
  // Lojas cujo volume no período pedido passou de 200 pedidos (2 páginas de 100) — só a 1ª e a
  // última página são buscadas, então pode faltar pedidos do meio do período pra essas lojas.
  lojasComLacuna: string[];
}

export interface DashboardCarrinho {
  loja: string;
  contactable: boolean;
  buyerName: string | null;
  buyerPhone: string | null;
  itemsCount: number;
  updatedAt: string | null;
  valor: number | null;
}

export interface DashboardCartsData {
  carrinhos: DashboardCarrinho[];
  erros: DashboardErro[];
}

// Resultado financeiro agregado por loja e dia (cache Postgres; só pedido pago e que não é troca).
// `semFinanceiro`: pedidos pagos do dia ainda sem custo calculado — ficam fora das somas.
export interface FinanceiroDia {
  loja: string;
  dia: string;
  pedidos: number;
  semFinanceiro: number;
  faturamento: number;
  frete: number;
  descontos: number;
  lucroBruto: number;
  custoProducao: number;
  lucroOperacional: number;
}

export interface DashboardFinanceiroData {
  dias: number;
  sincronizadoEm: string | null;
  linhas: FinanceiroDia[];
  // Gasto de mídia por loja × dia, vindo das contas de anúncio conectadas. Vazio quando nenhuma
  // conta tem loja atribuída — o painel não inventa zero pra quem não conectou.
  midia: { loja: string; dia: string; spend: number }[];
}

export function getDashboardFinanceiro(dias = 180) {
  return api<DashboardFinanceiroData>(`/api/admin/dashboard/financeiro?dias=${dias}`);
}

export type AgrupamentoLucro = 'produto' | 'modelo';

export interface LucroProdutoItem {
  chave: string;
  nome: string | null;
  pecas: number;
  pedidos: number;
  lucroBruto: number;
  custoProducao: number;
  lucroOperacional: number;
}

export interface DashboardLucroProdutosData {
  dias: number;
  agrupar: AgrupamentoLucro;
  // Pedidos pagos do período cujos itens ainda não foram gravados (ficam fora do ranking).
  pedidosSemItens: number;
  itens: LucroProdutoItem[];
}

export function getDashboardLucroProdutos(dias: number, agrupar: AgrupamentoLucro) {
  const params = new URLSearchParams({ dias: String(dias), agrupar });
  return api<DashboardLucroProdutosData>(`/api/admin/dashboard/lucro-produtos?${params}`);
}

export function getDashboardOrders(dias = 90) {
  return api<DashboardOrdersData>(`/api/admin/dashboard/orders?dias=${dias}`);
}

export function getDashboardAbandonedCarts() {
  return api<DashboardCartsData>('/api/admin/dashboard/abandoned-carts');
}

export function getDashboardRecuperacaoResumo() {
  return api<RecuperacaoResumo>(`/api/admin/dashboard/recuperacao-resumo`);
}

export function vincularPedidoInk(inkOrderId: string | number) {
  return api<{ id: string; url: string }>('/api/admin/pedidos/ink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inkOrderId }),
  });
}
