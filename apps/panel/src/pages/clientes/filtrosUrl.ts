import { FILTROS_AVANCADOS_VAZIOS, type FiltrosAvancados, type OrdemClientes, type SegmentoFiltro, type TipoClientes } from '../../api/clientes';

// Estado dos filtros da página ↔ query string. A URL fica compartilhável e NUNCA leva dado pessoal: a busca (nome, e-mail,
// telefone) e o cliente aberto no drawer ficam só em memória.
export interface EstadoFiltros {
  periodo: string; // '30' | '90' | '180' | '365' | 'tudo'
  segmentos: SegmentoFiltro[];
  ordem: OrdemClientes;
  tipo: TipoClientes;
  inatividade: string;
  avancados: FiltrosAvancados;
  pagina: number;
}

export const PERIODOS = ['30', '90', '180', '365', 'tudo'] as const;
const ORDENS: OrdemClientes[] = ['compras_desc', 'lucro_desc', 'inativos_primeiro', 'nome', 'ltv_desc'];
const TIPOS: TipoClientes[] = ['todos', 'com_pedido', 'sem_pedido'];
const SEGMENTOS_VALIDOS = new Set<string>([
  'campeoes', 'leais', 'potenciais_leais', 'primeira_alto_valor', 'novos', 'aguardando_recompra',
  'precisam_atencao', 'prestes_a_dormir', 'em_risco', 'hibernando', 'perdidos', 'dados_insuficientes', 'sem_compra',
]);

// Chave curta na URL ↔ campo dos filtros avançados.
const CHAVES: Record<keyof FiltrosAvancados, string> = {
  recenciaMin: 'rmin', recenciaMax: 'rmax', pedidosMin: 'pmin', pedidosMax: 'pmax', ltvMin: 'lmin', ltvMax: 'lmax',
  ticketMin: 'tmin', ticketMax: 'tmax', primeiraDe: 'pcde', primeiraAte: 'pcate', ultimaDe: 'ucde', ultimaAte: 'ucate', marketing: 'mkt', uf: 'uf',
};

export const ESTADO_INICIAL: EstadoFiltros = {
  periodo: '30', segmentos: [], ordem: 'compras_desc', tipo: 'todos', inatividade: '', avancados: { ...FILTROS_AVANCADOS_VAZIOS }, pagina: 1,
};

export const UF_LISTA = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const UFS = new Set(UF_LISTA);
const NUMERO = /^\d{1,9}(\.\d{1,2})?$/;
const DIA = /^\d{4}-\d{2}-\d{2}$/;

export function lerFiltros(params: URLSearchParams): EstadoFiltros {
  const periodo = params.get('p') ?? '';
  const ordem = params.get('ordem') as OrdemClientes;
  const tipo = params.get('tipo') as TipoClientes;
  const avancados: FiltrosAvancados = { ...FILTROS_AVANCADOS_VAZIOS };
  for (const [campo, chave] of Object.entries(CHAVES) as [keyof FiltrosAvancados, string][]) {
    const v = params.get(chave) ?? '';
    if (campo === 'marketing') avancados.marketing = v === 'sim' || v === 'nao' ? v : '';
    else if (campo === 'uf') avancados.uf = UFS.has(v) ? v : '';
    else if (campo.startsWith('primeira') || campo.startsWith('ultima')) avancados[campo] = DIA.test(v) ? v : '';
    else avancados[campo] = NUMERO.test(v) ? v : '';
  }
  const pagina = Number(params.get('pg'));
  return {
    periodo: (PERIODOS as readonly string[]).includes(periodo) ? periodo : ESTADO_INICIAL.periodo,
    segmentos: (params.get('seg') ?? '').split(',').filter((s): s is SegmentoFiltro => SEGMENTOS_VALIDOS.has(s)),
    ordem: ORDENS.includes(ordem) ? ordem : ESTADO_INICIAL.ordem,
    tipo: TIPOS.includes(tipo) ? tipo : ESTADO_INICIAL.tipo,
    inatividade: ['30', '60', '90', '180'].includes(params.get('inativo') ?? '') ? (params.get('inativo') as string) : '',
    avancados,
    pagina: Number.isInteger(pagina) && pagina >= 1 && pagina <= 1000 ? pagina : 1,
  };
}

export function gravarFiltros(e: EstadoFiltros): URLSearchParams {
  const qs = new URLSearchParams();
  if (e.periodo !== ESTADO_INICIAL.periodo) qs.set('p', e.periodo);
  if (e.segmentos.length) qs.set('seg', e.segmentos.join(','));
  if (e.ordem !== ESTADO_INICIAL.ordem) qs.set('ordem', e.ordem);
  if (e.tipo !== ESTADO_INICIAL.tipo) qs.set('tipo', e.tipo);
  if (e.inatividade) qs.set('inativo', e.inatividade);
  for (const [campo, chave] of Object.entries(CHAVES) as [keyof FiltrosAvancados, string][]) {
    if (e.avancados[campo]) qs.set(chave, e.avancados[campo]);
  }
  if (e.pagina > 1) qs.set('pg', String(e.pagina));
  return qs;
}

export const ROTULOS_AVANCADOS: Record<keyof FiltrosAvancados, string> = {
  recenciaMin: 'Sem comprar há (mín.)', recenciaMax: 'Sem comprar há (máx.)', pedidosMin: 'Pedidos (mín.)', pedidosMax: 'Pedidos (máx.)',
  ltvMin: 'LTV (mín.)', ltvMax: 'LTV (máx.)', ticketMin: 'Ticket (mín.)', ticketMax: 'Ticket (máx.)',
  primeiraDe: 'Primeira compra desde', primeiraAte: 'Primeira compra até', ultimaDe: 'Última compra desde', ultimaAte: 'Última compra até',
  marketing: 'Marketing', uf: 'UF',
};

export function temAvancados(a: FiltrosAvancados): boolean {
  return Object.values(a).some(Boolean);
}
