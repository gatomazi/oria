import { api, apiArquivoPost } from './client';

export type SegmentoRfmId =
  | 'campeoes' | 'leais' | 'potenciais_leais' | 'primeira_alto_valor' | 'novos' | 'aguardando_recompra'
  | 'precisam_atencao' | 'prestes_a_dormir' | 'em_risco' | 'hibernando' | 'perdidos' | 'dados_insuficientes';

// Filtro de segmento aceita também `sem_compra`: só cadastro ou pedido sem compra válida (fora da RFM).
export type SegmentoFiltro = SegmentoRfmId | 'sem_compra';

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
  primeiraCompraEm: string | null;
  diasSemComprar: number | null;
  // 'pedido': já fez ao menos um pedido. 'cadastro': só tem cadastro na Ink, nunca pediu.
  origem: 'pedido' | 'cadastro';
  // RFM: `null` em quem não tem compra válida (só cadastro, cancelado, reembolsado, troca).
  segmento: SegmentoRfmId | null;
  segmentoNome: string | null;
  rfm: { r: number; f: number; m: number } | null;
  pedidosValidos: number;
  ltv: number | null;
  ticketMedioValido: number | null;
  uf: string | null;
}

export type OrdemClientes = 'compras_desc' | 'lucro_desc' | 'inativos_primeiro' | 'nome' | 'ltv_desc';

export type TipoClientes = 'todos' | 'com_pedido' | 'sem_pedido';

export interface ListaDeClientes {
  clientes: Cliente[];
  cadastro: { incluido: boolean; disponivel: boolean; parcial: boolean; atualizadoEm: string | null };
  page: number;
  perPage: number;
  totalPages: number;
  total: number;
}

// Filtros avançados: todos texto vazio = sem filtro (viram query string só quando preenchidos).
export interface FiltrosAvancados {
  recenciaMin: string; recenciaMax: string;
  pedidosMin: string; pedidosMax: string;
  ltvMin: string; ltvMax: string;
  ticketMin: string; ticketMax: string;
  primeiraDe: string; primeiraAte: string;
  ultimaDe: string; ultimaAte: string;
  marketing: '' | 'sim' | 'nao';
  uf: string;
}

export const FILTROS_AVANCADOS_VAZIOS: FiltrosAvancados = {
  recenciaMin: '', recenciaMax: '', pedidosMin: '', pedidosMax: '', ltvMin: '', ltvMax: '', ticketMin: '', ticketMax: '',
  primeiraDe: '', primeiraAte: '', ultimaDe: '', ultimaAte: '', marketing: '', uf: '',
};

export interface FiltroClientes {
  page: number;
  perPage: number;
  ordem: OrdemClientes;
  busca: string;
  inativoDias: string;
  tipo: TipoClientes;
  segmentos: SegmentoFiltro[];
  avancados: FiltrosAvancados;
}

// Parâmetros de filtro (sem paginação): a mesma forma serve à lista, à exportação e ao segmento salvo.
export function filtrosComoObjeto({ ordem, busca, inativoDias, tipo, segmentos, avancados }: Omit<FiltroClientes, 'page' | 'perPage'>): Record<string, string> {
  const out: Record<string, string> = { ordem, tipo };
  if (busca.trim()) out.busca = busca.trim();
  if (inativoDias) out.inativoDias = inativoDias;
  if (segmentos.length) out.segmento = segmentos.join(',');
  for (const [k, v] of Object.entries(avancados)) if (v) out[k] = v;
  return out;
}

// Busca, ordem e filtro rodam no servidor antes de fatiar a página (valem para a lista inteira).
export function listClientes(filtro: FiltroClientes) {
  const qs = new URLSearchParams({ page: String(filtro.page), per_page: String(filtro.perPage), ...filtrosComoObjeto(filtro) });
  return api<ListaDeClientes>(`/api/admin/clientes/lista?${qs.toString()}`);
}

// ── Resumo: indicadores do período + RFM ─────────────────────────────────────────────────────────────
export interface PredicadoRfm {
  recenciaDias: { min: number; max: number | null };
  frequencia: { min: number | null; max: number | null } | null;
  valor: { metrica?: 'ltv_janela' | 'ticket_medio'; min: number | null; maxExclusivo: number | null } | null;
}

export interface SegmentoResumo {
  id: SegmentoRfmId;
  nome: string;
  descricao: string | null;
  hipotese: string | null;
  predicado: PredicadoRfm | null;
  clientes: number;
  pctBase: number;
  pedidos: number;
  pedidosPorCliente: number;
  ticketMedio: number | null;
  receita: number;
  pctReceita: number;
  recenciaMediaDias: number | null;
  recenciaMedianaDias: number | null;
  frequenciaMediana: number | null;
}

export interface IndicadoresPeriodo {
  faturamento: number;
  pedidos: number;
  clientes: number;
  recorrentes: number;
  taxaRecompra: number | null;
  ticketMedio: number | null;
  receitaPorCliente: number | null;
  receitaRecorrente: number;
  clientesPrimeiraCompra: number;
  pedidosReembolsados: number;
}

export interface ResumoClientes {
  periodo: { de: string; ate: string };
  indicadores: {
    periodo: { de: string; ate: string };
    atual: IndicadoresPeriodo;
    comparacao: { periodo: { de: string; ate: string }; anterior: IndicadoresPeriodo | null; motivo?: string };
  };
  rfm: {
    versao: string;
    // Versão da REGRA: algoritmo + hash dos limiares. Muda quando qualquer limiar muda.
    regraVersao: string;
    classificadoEm: string;
    fuso: string;
    janelaFrequenciaDias: number;
    limitesRecenciaDias: number[];
    valorAlto: number | null;
    suficiente: boolean;
    motivoInsuficiencia: string | null;
    universo: number;
    identidadesSemCompraValida: number;
    historicoDias: number;
    janelaCobreHistorico: boolean;
    segmentos: SegmentoResumo[];
  };
  cobertura: {
    pedidosTotal: number;
    pedidosValidos: number;
    pedidosSemIdentidade: number;
    clientesIdentificados: number;
    primeiroPedidoEm: string | null;
    ultimoPedidoEm: string | null;
    ultimoSyncEm: string | null;
    backfill: { status: string; desde: string; pedidosProcessados: number; atualizadoEm: string } | null;
    fonte: string;
  };
  lacunas: string[];
}

// `dias`: '30' | '90' | '180' | '365' | 'tudo' (o servidor calcula o período no fuso da Organização) ou `de`/`ate` (AAAA-MM-DD).
export function getResumoClientes({ dias, de, ate }: { dias?: string; de?: string; ate?: string }) {
  const qs = new URLSearchParams();
  if (dias) qs.set('dias', dias);
  else {
    if (de) qs.set('de', de);
    if (ate) qs.set('ate', ate);
  }
  return api<ResumoClientes>(`/api/admin/clientes/resumo?${qs.toString()}`);
}

// ── Drawer 360° ─────────────────────────────────────────────────────────────────────────────────────
export interface ItemPedido {
  produto: string | null; sku: string | null; modelo: string | null; cor: string | null; tamanho: string | null;
  quantidade: number; valorVenda: number; descontoRateado: number; valorLiquido: number; imagem: string | null;
}

export interface PedidoDetalhe {
  inkOrderId: string | null;
  criadoEm: string | null;
  statusPagamento: string | null;
  statusPedido: string | null;
  troca: boolean;
  contaNoLtv: boolean;
  quantidade: number | null;
  subtotal: number | null;
  desconto: number | null;
  frete: number | null;
  totalPago: number | null;
  devolvido: number | null;
  devolucaoParcialRastreada: boolean;
  totalLiquido: number;
  somaItens: number | null;
  conciliado: boolean | null;
  itens: ItemPedido[];
}

export interface DetalheCliente {
  cliente: { nome: string | null; email: string | null; telefone: string | null; documento: string | null; uf: string | null; loja: string };
  identidade: { motivosDeUniao: string[]; pedidosAgrupados: number };
  rfm: {
    segmento: { id: SegmentoRfmId; nome: string };
    escore: { r: number; f: number; m: number } | null;
    r: number; f: number; fVida: number; m: number;
    versao: string; asOf: string; suficiente: boolean; motivoInsuficiencia: string | null;
  } | null;
  indicadores: {
    ltv: number; pedidosPagos: number; ticketMedio: number | null; primeiraCompraEm: string | null; ultimaCompraEm: string | null;
    diasSemComprar: number | null; itensComprados: number | null; pedidosSemItens: number;
  };
  distintivos: { id: string; label: string; detalhe?: string }[];
  pedidos: PedidoDetalhe[];
  campanhas: { campanhaId: string; campanha: string; status: string; enviadoEm: string | null; entregueEm: string | null; lidoEm: string | null; falha: string | null }[];
  canais: {
    consentimento: { aceitaMarketing: boolean | null; fonte: string; registroPorCanal: boolean };
    whatsapp: { conexaoOria: 'conectada' | 'desconectada'; telefoneValido: boolean; acao: 'abrir_externo' | 'indisponivel'; telefoneWa: string | null; motivo: string };
    email: { provedorIntegrado: boolean; emailValido: boolean; acao: 'abrir_cliente_de_email' | 'indisponivel'; motivo: string };
  };
  lacunas: string[];
}

// POST: a chave do cliente é documento/telefone/e-mail e não vai na URL.
export function getDetalheCliente(customerKey: string) {
  return api<DetalheCliente>('/api/admin/clientes/detalhe', { method: 'POST', body: JSON.stringify({ customerKey }) });
}

// ── Segmento de campanha e exportação ────────────────────────────────────────────────────────────────
export interface SegmentoCriado {
  segmento: { id: string; nome: string };
  reaproveitado?: boolean;
  politica: 'dinamico';
  origem: 'rfm' | 'clientes';
  predicado: PredicadoRfm | null;
  observacoes: string[];
  naoConvertidos: string[];
}

export function criarSegmentoRfm(nome: string, segmento: SegmentoRfmId) {
  return api<SegmentoCriado>('/api/admin/clientes/segmentos', { method: 'POST', body: JSON.stringify({ nome, origem: 'rfm', segmento }) });
}

export function criarSegmentoDeFiltros(nome: string, filtros: Record<string, string>) {
  return api<SegmentoCriado>('/api/admin/clientes/segmentos', { method: 'POST', body: JSON.stringify({ nome, origem: 'clientes', filtros }) });
}

export function exportarClientes(filtros: Record<string, string>, quantidadeConfirmada: number) {
  return apiArquivoPost('/api/admin/clientes/exportar', { filtros, quantidadeConfirmada });
}
