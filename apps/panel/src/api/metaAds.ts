import { api } from './client';

// Meta Ads (docs/meta-ads-implementacao.md). Diferente do GA4, a conexão é ÚNICA — não há
// uma por loja: o produto é 1 cliente = 1 loja, e o banco garante isso (meta_connections tem
// CHECK (id = 1)). A conexão enxerga todas as contas de anúncio do usuário e o painel trabalha uma
// por vez, escolhida aqui.
export type MetaConnectionStatus = 'connected' | 'error' | 'disconnected';

export interface MetaConexao {
  status: MetaConnectionStatus;
  metaUserNome: string | null;
  conectadoEm: string | null;
  tokenExpiraEm: string | null;
  ultimoSyncEm: string | null;
  ultimoErro: string | null;
  ultimoErroCodigo: string | null;
}

export interface MetaConta {
  metaAccountId: string;
  nome: string | null;
  currency: string | null;
  timezoneName: string | null;
  // Código numérico da Meta. 1 = ativa, 2 = desativada; ver META_ACCOUNT_STATUS.
  accountStatus: number | null;
  selecionada: boolean;
  ultimoSyncEm: string | null;
  // A qual loja o tráfego desta conta leva — base do MER. null = ainda não definido.
  lojaAtribuida: string | null;
}

export interface MetaSincronizacao {
  id: number;
  tipo: 'INITIAL_IMPORT' | 'INCREMENTAL' | 'BACKFILL' | 'MANUAL';
  status: 'processando' | 'sucesso' | 'erro';
  iniciadoEm: string;
  finalizadoEm: string | null;
  de: string | null;
  ate: string | null;
  registros: number;
  criados: number;
  atualizados: number;
  chamadas: number;
  erroCodigo: string | null;
  erro: string | null;
}

export interface MetaStatus {
  conexao: MetaConexao;
  oauthConfigurado: boolean;
  syncEmAndamento: boolean;
  contas: MetaConta[];
  sincronizacoes: MetaSincronizacao[];
}

// Códigos de account_status da Marketing API. Só os que mudam o que a tela deve dizer — o resto cai
// no rótulo genérico. Uma conta que não está ativa não é erro de conexão: ela existe, mas
// sincronizá-la traria pouco ou nada, então a tela avisa antes da escolha.
export const META_ACCOUNT_STATUS: Record<number, string> = {
  1: 'Ativa',
  2: 'Desativada',
  3: 'Pendente de pagamento',
  7: 'Em análise de risco',
  8: 'Aguardando quitação',
  9: 'Em período de carência',
  100: 'Encerramento pendente',
  101: 'Encerrada',
};

export function contaEstaAtiva(conta: MetaConta): boolean {
  return conta.accountStatus === 1;
}

// Identificador de conta mascarado na exibição (spec §61: `act_••••••••1234`). Só onde a conta já
// está escolhida e o id é ruído — no seletor ele aparece inteiro, porque é o que distingue duas
// contas de nome parecido.
export function mascararContaMeta(metaAccountId: string): string {
  const digitos = metaAccountId.replace(/^act_/, '');
  if (digitos.length <= 4) return metaAccountId;
  return `act_${'•'.repeat(Math.min(digitos.length - 4, 8))}${digitos.slice(-4)}`;
}

// Tradução dos códigos de erro do backend (spec §64). A mensagem crua da Meta nunca chega ao
// cliente; o backend manda só o código, e a frase acionável mora aqui.
export const META_ERRO_MENSAGEM: Record<string, string> = {
  META_TOKEN_EXPIRED: 'Sua conexão com a Meta expirou. Reconecte a conta para continuar sincronizando os dados.',
  META_PERMISSION_DENIED: 'A conta conectada não tem permissão para ler estes dados de anúncios. Reconecte e aceite o acesso aos anúncios.',
  META_RATE_LIMIT: 'A Meta limitou temporariamente as requisições. A próxima sincronização automática tenta de novo.',
  META_ACCOUNT_NOT_FOUND: 'A conta de anúncios não existe mais na Meta, ou saiu do seu acesso.',
  META_API_ERROR: 'A Meta recusou a requisição.',
  META_SYNC_FAILED: 'A sincronização falhou.',
};

export function mensagemErroMeta(codigo: string | null, fallback: string | null): string {
  if (codigo && META_ERRO_MENSAGEM[codigo]) return META_ERRO_MENSAGEM[codigo];
  return fallback || 'Não foi possível falar com a Meta.';
}

export function getMetaStatus() {
  return api<MetaStatus>('/api/admin/integrations/meta/status');
}

// Não é fetch: é navegação de página inteira, igual ao GA4 — o diálogo OAuth da Meta exige
// top-level navigation e não funciona por XHR.
export function urlConectarMeta(): string {
  return '/api/admin/integrations/meta/connect';
}

// Revarre as contas na Meta antes de devolver — é o "atualizar lista" da tela, pra quando o usuário
// ganha acesso a uma conta nova sem precisar reconectar.
export function listarMetaContas() {
  return api<{ contas: MetaConta[] }>('/api/admin/integrations/meta/ad-accounts');
}

// Selecionar uma conta dispara a importação inicial de 90 dias em background (o backend responde
// antes de terminar). Quem acompanha é o campo `sincronizacoes` do status.
export function selecionarMetaConta(metaAccountId: string) {
  return api<{ ok: true; importacaoIniciada: boolean }>('/api/admin/integrations/meta/select-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metaAccountId }),
  });
}

export function sincronizarMetaAgora(dias?: number) {
  return api<{ ok: true; iniciado: boolean }>('/api/admin/integrations/meta/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dias ? { dias } : {}),
  });
}

// ── Leitura para as telas de análise (Fase 3) ───────────────────────────────────────────────
// Tudo vem do Postgres, nunca da Meta ao vivo (spec §31). As taxas já chegam recalculadas a partir
// das somas do período — a tela nunca faz média de taxa diária.

// Métricas somadas + taxas do período. `reach` é null de propósito: alcance único de um período a
// Meta não fornece, e somar o alcance diário conta a mesma pessoa mais de uma vez. A soma fica em
// `reachSomado`, com nome que não deixa confundir (spec §54).
export interface MetaMetricas {
  impressions: number;
  reach: null;
  reachSomado: number;
  clicks: number;
  uniqueClicks: number;
  inlineLinkClicks: number;
  outboundClicks: number;
  uniqueOutboundClicks: number;
  spend: number;
  landingPageViews: number;
  viewContent: number;
  addToCart: number;
  initiateCheckout: number;
  purchases: number;
  purchaseValue: number;
  // null quando nenhuma linha do período tinha vídeo — anúncio de imagem não é "0 plays".
  videoPlays: number | null;
  videoThruplays: number | null;
  video25: number | null;
  video50: number | null;
  video75: number | null;
  video95: number | null;
  video100: number | null;
  frequency: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  roas: number | null;
}

export interface MetaOverview extends MetaMetricas {
  periodo: { from: string; to: string; timezone: string | null };
  conta: { metaAccountId: string; nome: string | null; currency: string | null };
  periodoAnterior: MetaMetricas | null;
  variacoes: Record<string, number | null> | null;
  direcaoBoa: Record<string, 'cima' | 'baixo' | 'neutro'>;
  ultimoSyncEm: string | null;
  syncEmAndamento: boolean;
}

export interface MetaPontoSerie extends MetaMetricas {
  data: string;
}

export interface MetaLinhaEntidade extends MetaMetricas {
  id: string;
  nome: string | null;
  status: string | null;
  effectiveStatus: string | null;
  objective: string | null;
  paiId: string | null;
  paiNome: string | null;
  thumbnailUrl: string | null;
  // Só no nível de anúncio: permite filtrar os anúncios de um criativo vindo da aba Criativos.
  criativoId: string | null;
}

export type MetaNivel = 'campaign' | 'adset' | 'ad';

export function getMetaOverview(from: string, to: string, opts?: { comparar?: boolean }) {
  const params = new URLSearchParams({ from, to });
  if (opts?.comparar === false) params.set('comparar', 'nenhum');
  return api<MetaOverview>(`/api/admin/analytics/meta/overview?${params.toString()}`);
}

export function getMetaTimeseries(from: string, to: string) {
  const params = new URLSearchParams({ from, to });
  return api<{ periodo: { from: string; to: string }; serie: MetaPontoSerie[] }>(
    `/api/admin/analytics/meta/timeseries?${params.toString()}`
  );
}

export function getMetaEntidades(level: MetaNivel, from: string, to: string) {
  const params = new URLSearchParams({ level, from, to });
  return api<{ periodo: { from: string; to: string }; level: MetaNivel; linhas: MetaLinhaEntidade[] }>(
    `/api/admin/analytics/meta/entities?${params.toString()}`
  );
}

// ── Criativos e metas (Fase 4) ──────────────────────────────────────────────────────────────

export type MetaFormato = 'imagem' | 'video' | 'carrossel' | 'dinamico' | 'outro';
// null = o painel não emite julgamento (nenhuma meta configurada). 'sem_base' = gastou pouco
// demais pra a leitura significar algo.
export type MetaSinal = 'candidato_escala' | 'monitorar' | 'baixa_eficiencia' | 'sem_base' | null;

export interface MetaRetencao {
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  p100: number | null;
  thruplay: number | null;
}

export interface MetaCriativo extends MetaMetricas {
  id: string;
  nome: string;
  title: string | null;
  body: string | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  formato: MetaFormato;
  anuncios: number;
  nomesAnuncios: string | null;
  videoAvgWatchTime: number | null;
  retencao: MetaRetencao | null;
  sinal: MetaSinal;
  motivos: string[];
  // null quando a peça não rodou no período anterior — sem base de comparação, não é crescimento
  // infinito vindo de zero.
  variacoes: Record<string, number | null> | null;
}

// Metas analíticas (spec §50). null em todas = o painel mostra métricas e cala sobre eficiência,
// em vez de inventar um limiar no lugar de quem cuida da conta.
export interface MetaMetas {
  cpaAlvo: number | null;
  roasAlvo: number | null;
  ctrMinimo: number | null;
  gastoMinimo: number | null;
}

export interface MetaAnuncioDetalhe extends MetaMetricas {
  periodo: { from: string; to: string };
  anuncio: {
    id: string; nome: string | null; status: string | null; effectiveStatus: string | null;
    campanhaId: string | null; campanhaNome: string | null;
    adsetId: string | null; adsetNome: string | null;
  };
  criativo: {
    id: string; nome: string | null; title: string | null; body: string | null;
    thumbnailUrl: string | null; imageUrl: string | null; formato: MetaFormato;
  } | null;
  videoAvgWatchTime: number | null;
  retencao: MetaRetencao | null;
  serie: MetaPontoSerie[];
}

export function getMetaCriativos(from: string, to: string) {
  const params = new URLSearchParams({ from, to });
  return api<{
    periodo: { from: string; to: string };
    periodoAnterior: { from: string; to: string } | null;
    metas: MetaMetas;
    formatos: MetaFormato[];
    direcaoBoa: Record<string, 'cima' | 'baixo' | 'neutro'>;
    linhas: MetaCriativo[];
  }>(`/api/admin/analytics/meta/creatives?${params.toString()}`);
}

export function getMetaMetas() {
  return api<{ metas: MetaMetas }>('/api/admin/analytics/meta/metas');
}

export function salvarMetaMetas(metas: MetaMetas) {
  return api<{ metas: MetaMetas }>('/api/admin/analytics/meta/metas', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metas),
  });
}

export function getMetaAnuncio(adId: string, from: string, to: string) {
  const params = new URLSearchParams({ from, to });
  return api<MetaAnuncioDetalhe>(`/api/admin/analytics/meta/ads/${encodeURIComponent(adId)}?${params.toString()}`);
}

export function desconectarMeta() {
  return api('/api/admin/integrations/meta/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// ── Consolidado financeiro + atribuição (Fase 5) ────────────────────────────────────────────
// A regra que o tipo precisa deixar óbvia: `resultado` é FINANCEIRO (receita e custo reais, gasto
// real de mídia) e `atribuicao` é ANALÍTICO (o que Meta e GA4 dizem ter gerado). Receita atribuída
// nunca entra numa conta de resultado — a spec §53D trata isso como premissa.

export interface MetaResultadoFinanceiro {
  receita: number;
  custoProducao: number;
  lucroProduto: number;
  margemProduto: number | null;
  totalMidia: number;
  midiaPorProvedor: Record<string, number>;
  lucroAposMidia: number;
  margemAposMidia: number | null;
  // null enquanto não houver despesas operacionais cadastradas: desconhecido, não igual ao lucro
  // após mídia.
  despesas: number | null;
  lucroOperacional: number | null;
  margemOperacional: number | null;
  pedidos: number;
  ticketMedio: number | null;
}

export interface MetaIndicadores {
  mer: number | null;
  roasDeMargem: number | null;
  resultadoPorRealDeMidia: number | null;
  breakEvenRoas: number | null;
  blendedCac: number | null;
  roasMeta: number | null;
}

export interface MetaLinhaAtribuicao {
  origem: 'loja' | 'meta' | 'ga4';
  rotulo: string;
  fonte: string;
  sessoes: number | null;
  cliques: number | null;
  compras: number | null;
  receita: number | null;
}

export interface MetaConsolidado {
  periodo: { from: string; to: string };
  loja: { id: string; nome: string };
  resultado: MetaResultadoFinanceiro;
  indicadores: MetaIndicadores;
  atribuicao: MetaLinhaAtribuicao[];
  // Quantos pedidos o RESULTADO representa. Quando não é a loja inteira, a tela precisa dizer —
  // senão um recorte de 55 de 377 pedidos lê como se fosse o mês fechado.
  cobertura: {
    pedidosComFinanceiro: number;
    pedidosTotal: number;
    receitaTotal: number;
    completa: boolean;
  };
  ga4Disponivel: boolean;
  qualidade: { nivel: 'completo' | 'parcial' | 'sem_dado'; avisos: string[] };
  midiaSincronizadaEm: string | null;
}

export function getMetaConsolidado(from: string, to: string) {
  const params = new URLSearchParams({ from, to });
  return api<MetaConsolidado>(`/api/admin/analytics/consolidado?${params.toString()}`);
}

// Seleciona a conta de anúncios e a vincula à loja da Organization ativa (a loja vem da sessão).
// Sem isso o MER compararia receita e gasto de escopos diferentes.
export function definirLojaDaContaMeta(metaAccountId: string) {
  return api<{ ok: true }>('/api/admin/integrations/meta/select-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metaAccountId }),
  });
}
