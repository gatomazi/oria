import { api } from './client';
import type { CorteDeValor, PredicadoRfm } from './clientes';

// Campos de filtro suportados hoje (dado real disponível — ver decisão #7 do plano de
// Campanhas/Remarketing, docs/PROMPT-CLAUDE-CAMPANHAS-REMARKETING-MIDIA-WHATSAPP.md). Cidade,
// tags, produto/categoria comprada e cupom ficam de fora por falta de captura desse dado. UF vem
// direto de shipping_address.state da Ink (buyer_uf em pedidos_ink).
export type AudienciaCampo =
  | 'diasSemComprar'
  | 'quantidadePedidos'
  | 'totalGasto'
  | 'ticketMedio'
  | 'uf'
  | 'optIn'
  | 'temCarrinhoAbandonado'
  | 'recebeuCampanha'
  | 'naoRecebeuCampanha'
  | 'recebeuCampanhaNosUltimosDias'
  // Segmento de origem RFM (Rodada 5): condição OBRIGATÓRIA avaliada pela mesma classificação da matriz de Clientes.
  | 'rfm';

export interface AudienciaFiltroRfmValor {
  segmento: string;
  regraVersao: string;
  classificadoEm: string | null;
  predicado: PredicadoRfm;
}

export const UF_OPCOES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB',
  'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

export type AudienciaOperador = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

export interface AudienciaFiltro {
  field: AudienciaCampo;
  op?: AudienciaOperador;
  value?: unknown;
}

export interface AudienciaExclusoes {
  semOptIn?: boolean;
  numeroInvalido?: boolean;
  compradoNosUltimosDias?: number | null;
  recebeuCampanhaNasUltimasHoras?: number | null;
}

// Presente só quando a audiência tem um segmento RFM: de onde vem a população e com que regra/corte/`asOf` foi calculada.
export interface AudienciaRfmResumo {
  equivalencia: 'exata';
  segmento: string;
  segmentoNome: string;
  regraVersao: string;
  asOf: string;
  fuso: string;
  classificadoEmSalvo: string | null;
  // Três universos distintos: pessoas com pedido ⊃ compradores válidos (a RFM) ⊃ segmento.
  universos: { pessoasComPedido: number; compradoresValidos: number; segmento: number };
  corteSalvo: CorteDeValor | null;
  corteAtual: CorteDeValor | null;
  divergente: boolean;
  pessoasNoSegmentoDeHoje: number | null;
}

export interface AudienciaPreviewResultado {
  matched: number;
  excluded: number;
  eligible: number;
  breakdown: {
    optOut: number;
    numeroInvalido: number;
    compradoRecentemente: number;
    recebeuCampanhaRecentemente: number;
  };
  rfm?: AudienciaRfmResumo;
}

export function previewAudiencia(match: 'ALL' | 'ANY', filters: AudienciaFiltro[], exclusions: AudienciaExclusoes) {
  return api<AudienciaPreviewResultado>('/api/admin/campaigns/audience/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ match, filters, exclusions }),
  });
}

// Status possíveis nesta fase (Fase 4 do plano) — "sending"/"completed"/"failed" só existem a
// partir da Fase 5 (fila de envio), ainda não implementada; uma campanha aqui só chega a draft
// ou scheduled.
export type CampanhaStatus = 'draft' | 'scheduled' | 'preparing' | 'sending' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface AudienceDefinition {
  match: 'ALL' | 'ANY';
  filtros: AudienciaFiltro[];
  exclusoes: AudienciaExclusoes;
  // Mapeamento {{n}} -> fonte do valor, salvo aqui pra Fase 5 resolver por destinatário depois.
  // "fixo" usa variavelFixa como texto literal igual pra todo mundo. `alvo` distingue pra qual
  // component da Meta esse valor vai: "corpo" (default, indice = posição do token no BODY),
  // "header" (cabeçalho de texto com variável) ou "botao" (botão de URL dinâmica) — os dois
  // últimos não usam `indice` (cada template só tem no máximo 1 de cada).
  variaveis?: { indice: number; fonte: string; variavelFixa?: string; alvo?: 'corpo' | 'header' | 'botao' }[];
  mediaAssetId?: number | null;
  sampleLocation?: { nome: string; endereco: string; latitude: number; longitude: number } | null;
}

export interface Campanha {
  id: string;
  loja: string;
  nome: string;
  descricao: string | null;
  templateNome: string | null;
  segmentoId: string | null;
  audienceDefinition: AudienceDefinition | Record<string, never>;
  status: CampanhaStatus;
  agendadaPara: string | null;
  iniciadaEm: string | null;
  finalizadaEm: string | null;
  totalMatched: number | null;
  totalExcluded: number | null;
  totalRecipients: number | null;
  criadoPor: string | null;
  criadoEm: string;
  atualizadoEm: string;
  // Tamanho padrão de lote (null = tudo de uma vez) — 1º lote ao iniciar e sugestão pros próximos.
  tamanhoLote: number | null;
  // Modo WhatsApp Web: mensagem própria no lugar do template. O texto congela ao iniciar.
  mensagemWebId: string | null;
  mensagemWebNome: string | null;
  mensagemWebCongelada: boolean;
}

export interface CampanhaInput {
  nome: string;
  descricao?: string | null;
  templateNome?: string | null;
  mensagemWebId?: string | null;
  segmentoId?: string | null;
  audienceDefinition: AudienceDefinition;
  tamanhoLote?: number | null;
}

export function listCampanhas() {
  return api<{ campanhas: Campanha[] }>('/api/admin/campaigns');
}

export function getCampanha(id: string) {
  return api<{ campanha: Campanha }>(`/api/admin/campaigns/${id}`);
}

export function criarCampanha(input: CampanhaInput) {
  return api<{ campanha: Campanha }>('/api/admin/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function editarCampanha(id: string, input: CampanhaInput & { status?: 'draft' | 'scheduled'; agendadaPara?: string | null }) {
  return api<{ campanha: Campanha }>(`/api/admin/campaigns/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function cancelarCampanha(id: string) {
  return api(`/api/admin/campaigns/${id}`, { method: 'DELETE' });
}

export function duplicarCampanha(id: string) {
  return api<{ campanha: Campanha }>(`/api/admin/campaigns/${id}/duplicate`, { method: 'POST' });
}

// Fase 5/6: snapshot de destinatários + transição pra 'preparing' — o disparo de verdade pra
// Meta acontece no job periódico do backend, nunca dentro desta chamada (spec, Parte 19).
export function iniciarCampanha(id: string) {
  return api<{ ok: true; totalRecipients: number; primeiroLote: number }>(`/api/admin/campaigns/${id}/start`, { method: 'POST' });
}

// Libera o próximo lote pra envio (tamanho null = todos os restantes). Numa campanha pausada,
// também retoma o envio.
export function liberarLoteCampanha(id: string, tamanho: number | null) {
  return api<{ ok: true; lote: number; liberados: number }>(`/api/admin/campaigns/${id}/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tamanho }),
  });
}

export function pausarCampanha(id: string) {
  return api<{ ok: true }>(`/api/admin/campaigns/${id}/pause`, { method: 'POST' });
}

export function retomarCampanha(id: string) {
  return api<{ ok: true }>(`/api/admin/campaigns/${id}/resume`, { method: 'POST' });
}

export interface CampanhaLoteResumo {
  lote: number;
  destinatarios: number;
  enviados: number;
  entregues: number;
  lidos: number;
  falhas: number;
  cliques: number;
  naoEnviados: number;
  pedidos: number;
  receita: number;
}

// Cards/funil da Parte 24. `pedidos`/`receita`: pedidos pagos atribuídos à campanha por último
// toque de mensagem, até `janelaAtribuicaoDias` dias depois do envio (lib/campanhas/atribuicao.js).
export interface CampanhaResumo {
  destinatarios: number;
  enviados: number;
  entregues: number;
  lidos: number;
  falhas: number;
  cliques: number;
  // Snapshot feito mas ainda não liberado em nenhum lote.
  aguardandoLiberacao: number;
  // Liberado e ainda não enviado (pending/queued com lote).
  naFila: number;
  lotes: CampanhaLoteResumo[];
  pedidos: number;
  receita: number;
  janelaAtribuicaoDias: number;
}

export function buscarResumoCampanha(id: string, janelaDias: number) {
  return api<{ campanha: Campanha; resumo: CampanhaResumo }>(`/api/admin/campaigns/${id}/summary?janelaDias=${janelaDias}`);
}

export type DestinatarioStatusFiltro = 'enviados' | 'entregues' | 'lidos' | 'falhas' | 'clicados' | 'nao_enviados';

export interface CampanhaDestinatario {
  id: string;
  nome: string | null;
  telefoneMascarado: string | null;
  status: string;
  lote: number | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  failureMessage: string | null;
  cliques: number;
  criadoEm: string;
}

export function buscarDestinatariosCampanha(id: string, opts: { status?: DestinatarioStatusFiltro; page?: number; pageSize?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
  const qs = params.toString();
  return api<{ total: number; page: number; pageSize: number; destinatarios: CampanhaDestinatario[] }>(
    `/api/admin/campaigns/${id}/recipients${qs ? `?${qs}` : ''}`
  );
}
