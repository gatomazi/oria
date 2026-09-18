import type { DashboardPedido, FinanceiroDia } from '../../api/dashboard';
import { CORES_ESTAGIO } from '../../lib/chartTheme';
import { lookup, ORDER_STATUS_MAP } from '../../lib/statusMap';

// Camada de agregação do Dashboard — nada de conta espalhada dentro do JSX (ver
// docs/claude-dashboard-visual-graficos.md, Passo 2). Tudo aqui deriva só do que o backend já
// devolve como dado real (pedidos da Ink, carrinhos abandonados, métricas de recuperação
// persistidas) — nada é inventado/mockado.

export type PeriodoId = 'hoje' | '7d' | '30d' | '90d';

export interface PeriodoOpcao {
  id: PeriodoId;
  label: string;
  dias: number;
}

export const PERIODOS: PeriodoOpcao[] = [
  { id: 'hoje', label: 'Hoje', dias: 1 },
  { id: '7d', label: 'Últimos 7 dias', dias: 7 },
  { id: '30d', label: 'Últimos 30 dias', dias: 30 },
  { id: '90d', label: 'Últimos 90 dias', dias: 90 },
];

export const PERIODO_PADRAO: PeriodoId = '30d';

export function diasDoPeriodo(id: PeriodoId): number {
  return PERIODOS.find((p) => p.id === id)?.dias ?? 30;
}

// "Hoje" no fuso do navegador (mesmo padrão frouxo já usado por formatData/tempoDesde no resto do
// admin — não tenta reproduzir com precisão o -03:00 que a Ink usa, só data-referência local).
export function hojeISO(): string {
  const d = new Date();
  const semFuso = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return semFuso.toISOString().slice(0, 10);
}

export function diasAtrasISO(dataISO: string, n: number): string {
  const [y, m, dia] = dataISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dia));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

export function valorNumerico(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Filtra pelo período selecionado — o backend já limita a busca a no máximo 90 dias (teto real
// de per_page=100/loja da Ink dentro da janela pedida), isso aqui só recorta client-side pro
// período exato escolhido no seletor.
export function pedidosNoPeriodo(pedidos: DashboardPedido[], dias: number): DashboardPedido[] {
  const hoje = hojeISO();
  const limite = diasAtrasISO(hoje, dias - 1);
  return pedidos.filter((p) => p.createdAt && p.createdAt.slice(0, 10) >= limite);
}

export function pedidosDoDia(pedidos: DashboardPedido[], diaISO: string): DashboardPedido[] {
  return pedidos.filter((p) => p.createdAt && p.createdAt.slice(0, 10) === diaISO);
}

// "Ontem até agora" — mesma janela de horário que "hoje" já tem (parcial), não o dia de ontem
// inteiro. Comparar hoje-parcial com ontem-inteiro é injusto: dá "queda" em qualquer hora do dia
// que não seja pertinho da meia-noite, todo santo dia, mesmo sem ter havido queda nenhuma.
export function pedidosDoDiaAteHora(pedidos: DashboardPedido[], diaISO: string, horaMinuto: string): DashboardPedido[] {
  return pedidos.filter((p) => {
    if (!p.createdAt || p.createdAt.slice(0, 10) !== diaISO) return false;
    const hm = new Date(p.createdAt).toTimeString().slice(0, 5);
    return hm <= horaMinuto;
  });
}

export function somaValor(pedidos: DashboardPedido[]): number {
  return pedidos.reduce((acc, p) => acc + valorNumerico(p.valor), 0);
}

export interface Delta {
  delta: string;
  trend: 'up' | 'down';
}

// Só calcula variação percentual quando dá pra sustentar com dado real (base anterior > 0) — não
// inventa "+100%" quando o período anterior for zero, e não mostra nada quando os dois são zero.
export function calcularDelta(atual: number, anterior: number): Delta | null {
  if (anterior <= 0) return null;
  const variacao = Math.round(((atual - anterior) / anterior) * 100);
  return { delta: `${variacao >= 0 ? '+' : ''}${variacao}%`, trend: variacao >= 0 ? 'up' : 'down' };
}

export interface DiaSerie {
  data: string;
  pedidos: number;
  receita: number;
  // Só na série do cache financeiro (serieFinanceiraDiaria); ausente, o gráfico não desenha a linha.
  lucro?: number;
}

export function serieDiaria(pedidos: DashboardPedido[], dias: number): DiaSerie[] {
  const hoje = hojeISO();
  const porDia = new Map<string, DiaSerie>();
  for (let i = dias - 1; i >= 0; i--) {
    const dia = diasAtrasISO(hoje, i);
    porDia.set(dia, { data: dia, pedidos: 0, receita: 0 });
  }
  pedidos.forEach((p) => {
    if (!p.createdAt) return;
    const dia = p.createdAt.slice(0, 10);
    const bucket = porDia.get(dia);
    if (bucket) {
      bucket.pedidos += 1;
      bucket.receita += valorNumerico(p.valor);
    }
  });
  return Array.from(porDia.values());
}

// Estágios reais do fluxo — mesma categorização já usada no Dashboard antigo (a API da Ink não
// tem um "estágio" pronto, isso é um agrupamento editorial de order_status já existente no
// projeto). Cores vêm do tema de gráficos (lib/chartTheme.ts), no tom semântico de cada estágio.
export const ESTAGIOS_PIPELINE: { key: string; label: string; statuses: string[]; color: string; opacidade: number }[] = [
  { key: 'pago', label: 'Pago', statuses: ['paid'] },
  { key: 'producao', label: 'Produção', statuses: ['awaiting_production', 'production_delayed', 'awaiting_stamp', 'waiting_approval'] },
  { key: 'despachado', label: 'Despachado', statuses: ['sent', 'waiting_to_be_sent', 'waiting_to_be_collected'] },
  { key: 'transito', label: 'Em trânsito', statuses: ['delivery_in_progress', 'preparing_for_delivery'] },
  { key: 'entrega', label: 'Em entrega', statuses: ['left_for_delivery', 'delivery_failure', 'delivery_interrupted', 'waiting_sender_action'] },
  { key: 'entregue', label: 'Entregue', statuses: ['delivered', 'delivered_correios'] },
].map((e) => ({ ...e, color: CORES_ESTAGIO[e.key].cor, opacidade: CORES_ESTAGIO[e.key].opacidade }));

export interface StatusPoint {
  status: string;
  label: string;
  count: number;
  color: string;
  opacidade: number;
}

export type TomStatus = 'success' | 'info' | 'warning' | 'danger' | 'premium' | 'neutral';

// Cor do estágio do PEDIDO (fulfillment) — não confundir com o bucket de PAGAMENTO. Usado onde o
// texto exibido é o estágio (orderStatusLabel), pra cor e texto contarem a mesma história. Achado
// no QA visual: colorir pelo bucket de pagamento fazia "Aguardando produção" aparecer verde
// (pago = sucesso), como se já tivesse concluído — mesma cor pra um pedido só recém-pago.
export function tomDoEstagio(orderStatus: string | null): TomStatus {
  // Mesmo tom da tela de Pedidos (DESIGN.md › Same-Status Same-Color): a fonte é o statusMap.
  return lookup(ORDER_STATUS_MAP, orderStatus).tone as TomStatus;
}

export function serieStatus(pedidos: DashboardPedido[]): StatusPoint[] {
  return ESTAGIOS_PIPELINE.map((estagio) => ({
    status: estagio.key,
    label: estagio.label,
    color: estagio.color,
    opacidade: estagio.opacidade,
    count: pedidos.filter((p) => p.orderStatus && estagio.statuses.includes(p.orderStatus)).length,
  }));
}

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const ORDEM_SEG_A_DOM = [1, 2, 3, 4, 5, 6, 0];

export interface WeekdayPoint {
  weekday: string;
  label: string;
  orders: number;
}

export function serieDiaSemana(pedidos: DashboardPedido[]): WeekdayPoint[] {
  const contagem = new Array(7).fill(0);
  pedidos.forEach((p) => {
    if (p.createdAt) contagem[new Date(p.createdAt).getDay()] += 1;
  });
  return ORDEM_SEG_A_DOM.map((i) => ({ weekday: String(i), label: DIAS_SEMANA[i], orders: contagem[i] }));
}

export interface HourPoint {
  hour: string;
  label: string;
  orders: number;
}

// Blocos de 3h (0h, 3h, 6h...) em vez de 24 barras finas — com algumas centenas de pedidos no
// período, hora a hora vira ruído; blocos de 3h ainda mostram o padrão real sem fabricar
// granularidade que o volume não sustenta.
export function serieHorario(pedidos: DashboardPedido[]): HourPoint[] {
  const contagem = new Array(24).fill(0);
  pedidos.forEach((p) => {
    if (p.createdAt) contagem[new Date(p.createdAt).getHours()] += 1;
  });
  const blocos: HourPoint[] = [];
  for (let h = 0; h < 24; h += 3) {
    const total = contagem.slice(h, h + 3).reduce((a, b) => a + b, 0);
    blocos.push({ hour: String(h), label: `${h}h`, orders: total });
  }
  return blocos;
}

export function serieRecuperacao(porDia: Record<string, number>, dias: number): { data: string; mensagens: number }[] {
  const hoje = hojeISO();
  const out: { data: string; mensagens: number }[] = [];
  for (let i = dias - 1; i >= 0; i--) {
    const dia = diasAtrasISO(hoje, i);
    out.push({ data: dia, mensagens: porDia[dia] || 0 });
  }
  return out;
}

export interface MidiaDia {
  loja: string;
  dia: string;
  spend: number;
}

export interface ResultadoFinanceiro {
  pedidos: number;
  semFinanceiro: number;
  faturamento: number;
  lucroBruto: number;
  custoProducao: number;
  // Lucro do produto: venda menos custo de produção. NÃO inclui mídia — é o mesmo número que a DRE
  // do Meta Ads chama de "Lucro do Produto" (spec §53A).
  lucroOperacional: number;
  // Gasto real de mídia no mesmo recorte. Só existe pra loja que tem conta de anúncios atribuída.
  midia: number;
  // Lucro do produto menos mídia — o que de fato sobrou depois do maior custo variável.
  lucroAposMidia: number;
}

// Soma o resultado financeiro das linhas (loja × dia) entre duas datas ISO, inclusivas. O recorte
// por loja (escopo) é feito antes, por quem chama.
export function resultadoFinanceiro(
  linhas: FinanceiroDia[],
  inicioISO: string,
  fimISO: string,
  midia: MidiaDia[] = [],
  lojasNoEscopo?: Set<string>
): ResultadoFinanceiro {
  const total: ResultadoFinanceiro = {
    pedidos: 0, semFinanceiro: 0, faturamento: 0, lucroBruto: 0, custoProducao: 0,
    lucroOperacional: 0, midia: 0, lucroAposMidia: 0,
  };
  linhas.forEach((l) => {
    if (l.dia < inicioISO || l.dia > fimISO) return;
    total.pedidos += l.pedidos;
    total.semFinanceiro += l.semFinanceiro;
    total.faturamento += l.faturamento;
    total.lucroBruto += l.lucroBruto;
    total.custoProducao += l.custoProducao;
    total.lucroOperacional += l.lucroOperacional;
  });
  // O gasto entra só das lojas que estão no escopo escolhido — senão, filtrar o dashboard por uma
  // loja mostraria a receita dela contra a mídia de todas.
  midia.forEach((m) => {
    if (m.dia < inicioISO || m.dia > fimISO) return;
    if (lojasNoEscopo && !lojasNoEscopo.has(m.loja)) return;
    total.midia += m.spend;
  });
  total.lucroAposMidia = total.lucroOperacional - total.midia;
  return total;
}

// Série diária do gráfico principal a partir do cache financeiro: pedidos pagos (sem troca),
// faturamento e lucro operacional. Mesma fonte dos KPIs de resultado — não mistura com a lista da
// API da Ink, que em loja grande só cobre parte do período.
export function serieFinanceiraDiaria(linhas: FinanceiroDia[], dias: number): DiaSerie[] {
  const hoje = hojeISO();
  const porDia = new Map<string, DiaSerie>();
  for (let i = dias - 1; i >= 0; i--) {
    const dia = diasAtrasISO(hoje, i);
    porDia.set(dia, { data: dia, pedidos: 0, receita: 0, lucro: 0 });
  }
  linhas.forEach((l) => {
    const bucket = porDia.get(l.dia);
    if (!bucket) return;
    bucket.pedidos += l.pedidos;
    bucket.receita += l.faturamento;
    bucket.lucro = (bucket.lucro || 0) + l.lucroOperacional;
  });
  return Array.from(porDia.values());
}

// A mídia entra dia a dia, e não como um desconto no fim: a sparkline fica embaixo do card de lucro
// após mídia, então precisa ser a série DAQUELE número — senão a linha sobe num dia em que o gasto
// comeu o resultado.
export function serieLucroOperacional(linhas: FinanceiroDia[], dias: number, midia: MidiaDia[] = []): number[] {
  const hoje = hojeISO();
  const porDia = new Map<string, number>();
  linhas.forEach((l) => porDia.set(l.dia, (porDia.get(l.dia) || 0) + l.lucroOperacional));
  midia.forEach((m) => porDia.set(m.dia, (porDia.get(m.dia) || 0) - m.spend));
  const out: number[] = [];
  for (let i = dias - 1; i >= 0; i--) out.push(porDia.get(diasAtrasISO(hoje, i)) || 0);
  return out;
}

export function formatarDataCurta(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(m) - 1]}`;
}

// "13/09 17:41" — tabela compacta do Dashboard (o ano é o corrente quase sempre; o completo fica em Pedidos).
export function formatDataHoraCurta(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const doisDig = (n: number) => String(n).padStart(2, '0');
  return `${doisDig(d.getDate())}/${doisDig(d.getMonth() + 1)} ${doisDig(d.getHours())}:${doisDig(d.getMinutes())}`;
}
