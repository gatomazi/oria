import { api } from './client';

export type PaymentBucket = 'aguardando' | 'pago' | 'problema' | 'desconhecido';

export interface DashboardPedido {
  loja: string | null;
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
  loja: string | null;
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
  loja: string | null;
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
  loja: string | null;
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
  startDate: string;
  endDate: string;
  sincronizadoEm: string | null;
  linhas: FinanceiroDia[];
  // Gasto de mídia por loja × dia, vindo das contas de anúncio conectadas. Vazio quando nenhuma
  // conta tem loja atribuída — o painel não inventa zero pra quem não conectou.
  midia: { loja: string | null; dia: string; spend: number }[];
  // Estado de cada fonte de mídia (Meta, Google Ads). `null` = o servidor não conseguiu ler — a tela
  // não afirma nem "sem mídia" nem "gasto zero".
  midiaFontes: { provider: string; conectado: boolean; relevante: boolean; motivo: string | null; comProblema?: boolean }[] | null;
  midiaSinalizada: { provider: string; recurso: string; motivo: string }[];
}

// `startDate`/`endDate` (o seletor de período global, ver src/lib/periodoGlobal.ts) sempre vencem
// quando informados; `dias` fica só como fallback pra quem ainda não migrou. O servidor recorta o
// INÍCIO se o intervalo pedido for maior que o suportado — nunca muda o fim escolhido.
export function getDashboardFinanceiro({ startDate, endDate, dias }: { startDate?: string; endDate?: string; dias?: number } = {}) {
  const params = new URLSearchParams();
  if (startDate && endDate) { params.set('startDate', startDate); params.set('endDate', endDate); }
  else params.set('dias', String(dias ?? 180));
  return api<DashboardFinanceiroData>(`/api/admin/dashboard/financeiro?${params}`);
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
  startDate: string;
  endDate: string;
  agrupar: AgrupamentoLucro;
  // Pedidos pagos do período cujos itens ainda não foram gravados (ficam fora do ranking).
  pedidosSemItens: number;
  itens: LucroProdutoItem[];
}

export function getDashboardLucroProdutos({ startDate, endDate, dias }: { startDate?: string; endDate?: string; dias?: number }, agrupar: AgrupamentoLucro) {
  const params = new URLSearchParams({ agrupar });
  if (startDate && endDate) { params.set('startDate', startDate); params.set('endDate', endDate); }
  else params.set('dias', String(dias ?? 30));
  return api<DashboardLucroProdutosData>(`/api/admin/dashboard/lucro-produtos?${params}`);
}

export function getDashboardOrders({ startDate, endDate, dias }: { startDate?: string; endDate?: string; dias?: number } = {}) {
  const params = new URLSearchParams();
  if (startDate && endDate) { params.set('startDate', startDate); params.set('endDate', endDate); }
  else params.set('dias', String(dias ?? 90));
  return api<DashboardOrdersData>(`/api/admin/dashboard/orders?${params}`);
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
