// Vocabulário compartilhado das telas do Meta Ads (docs/meta-ads-analytics-integracao-v2.md §41,
// §58, §63). Separado de lib/ga4.ts porque as duas fontes falam línguas diferentes: o GA4 devolve
// taxa como fração (0,0171) e a Insights API devolve já em pontos percentuais (1,71). Compartilhar
// o formatador entre as duas seria a receita para um CTR aparecer 100x errado numa das telas.

export type PeriodoMeta = 'hoje' | 'ontem' | '7d' | '14d' | '30d' | '90d' | 'custom';

export const PERIODOS_META: { valor: PeriodoMeta; rotulo: string }[] = [
  { valor: 'hoje', rotulo: 'Hoje' },
  { valor: 'ontem', rotulo: 'Ontem' },
  { valor: '7d', rotulo: 'Últimos 7 dias' },
  { valor: '14d', rotulo: 'Últimos 14 dias' },
  { valor: '30d', rotulo: 'Últimos 30 dias' },
  { valor: '90d', rotulo: 'Últimos 90 dias' },
  { valor: 'custom', rotulo: 'Personalizado' },
];

// Data local como "AAAA-MM-DD". Montada a partir dos componentes locais, nunca por toISOString():
// à noite no Brasil o UTC já virou o dia seguinte, e "hoje" viraria amanhã.
function diaLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function somarDias(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Traduz o preset no par from/to que o backend espera. null = personalizado ainda incompleto,
// e nesse caso a tela não dispara requisição nenhuma.
export function intervaloMeta(periodo: PeriodoMeta, inicio: string, fim: string): { from: string; to: string } | null {
  if (periodo === 'custom') return inicio && fim ? { from: inicio, to: fim } : null;
  const hoje = new Date();
  if (periodo === 'hoje') return { from: diaLocal(hoje), to: diaLocal(hoje) };
  if (periodo === 'ontem') {
    const ontem = somarDias(hoje, -1);
    return { from: diaLocal(ontem), to: diaLocal(ontem) };
  }
  const dias = Number(periodo.replace('d', ''));
  // O período inclui hoje, então N dias vão de hoje-(N-1) até hoje.
  return { from: diaLocal(somarDias(hoje, -(dias - 1))), to: diaLocal(hoje) };
}

// ── Formatação ──────────────────────────────────────────────────────────────────────────────
// Toda métrica que pode não existir devolve "—" em vez de 0 (spec §63): "ROAS 0" num anúncio que
// nunca teve compra alguma sugere fracasso, quando o certo é dizer que não há base para calcular.

export function metaNumero(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return Math.round(n).toLocaleString('pt-BR');
}

export function metaReais(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// A Insights API já devolve ctr em pontos percentuais — não multiplicar de novo.
export function metaPercentual(n: number | null | undefined, casas = 2): string {
  if (n === null || n === undefined) return '—';
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: casas })}%`;
}

export function metaRoas(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}x`;
}

// Abaixo disso a variação arredonda para "0,0%" na exibição — ou seja, é menor do que a tela
// consegue mostrar. Tratar como mudança real produziria "+0,0%" pintado de vermelho ao lado de
// "+0,0%" pintado de verde, o que parece arbitrário e corrói a confiança nas cores que importam.
const VARIACAO_IMPERCEPTIVEL = 0.05;

// Variação entre períodos, já formatada com sinal. null quando não houve base de comparação —
// "de 0 para 10" não é +100%, é uma comparação que não existe.
export function metaVariacao(v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (Math.abs(v) < VARIACAO_IMPERCEPTIVEL) return 'estável';
  const sinal = v > 0 ? '+' : '';
  return `${sinal}${v.toLocaleString('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
}

// Cor do delta a partir da semântica da métrica, não do sinal do número (spec §41). O backend manda
// `direcaoBoa` por métrica: subir receita é bom, subir CPA é ruim, subir gasto não é nem um nem
// outro. Métrica neutra devolve null e a tela mostra a variação sem cor, como informação.
export type DirecaoBoa = 'cima' | 'baixo' | 'neutro';

export function tendenciaMeta(variacao: number | null | undefined, direcaoBoa: DirecaoBoa | undefined): 'up' | 'down' | null {
  if (variacao === null || variacao === undefined || !Number.isFinite(variacao)) return null;
  // Variação que nem aparece na tela não ganha cor — ver VARIACAO_IMPERCEPTIVEL.
  if (Math.abs(variacao) < VARIACAO_IMPERCEPTIVEL) return null;
  if (direcaoBoa !== 'cima' && direcaoBoa !== 'baixo') return null;
  const subiu = variacao > 0;
  const bom = direcaoBoa === 'cima' ? subiu : !subiu;
  return bom ? 'up' : 'down';
}

// Rótulos de status da Meta. `effective_status` é o que vale na prática (uma campanha ACTIVE dentro
// de um ad set pausado não entrega), então é ele que a tabela mostra.
export const META_STATUS_ROTULO: Record<string, string> = {
  ACTIVE: 'Ativo',
  PAUSED: 'Pausado',
  DELETED: 'Excluído',
  ARCHIVED: 'Arquivado',
  CAMPAIGN_PAUSED: 'Campanha pausada',
  ADSET_PAUSED: 'Conjunto pausado',
  IN_PROCESS: 'Em processamento',
  WITH_ISSUES: 'Com problemas',
  PENDING_REVIEW: 'Em análise',
  DISAPPROVED: 'Reprovado',
  PREAPPROVED: 'Pré-aprovado',
  PENDING_BILLING_INFO: 'Aguardando pagamento',
};

export function metaStatusTom(status: string | null): 'success' | 'neutral' | 'warning' | 'danger' {
  if (!status) return 'neutral';
  if (status === 'ACTIVE') return 'success';
  if (status === 'DISAPPROVED' || status === 'WITH_ISSUES') return 'danger';
  if (status === 'PENDING_REVIEW' || status === 'IN_PROCESS' || status === 'PENDING_BILLING_INFO') return 'warning';
  return 'neutral';
}

export function metaStatusRotulo(status: string | null): string {
  if (!status) return '—';
  return META_STATUS_ROTULO[status] || status;
}

// ── Criativos (Fase 4) ──────────────────────────────────────────────────────────────────────

export const META_FORMATO_ROTULO: Record<string, string> = {
  imagem: 'Imagem',
  video: 'Vídeo',
  carrossel: 'Carrossel',
  dinamico: 'Advantage+',
  // Não é categoria de descarte: é a resposta honesta quando o payload não permite afirmar o
  // formato. A spec §48 pede exatamente isso, em vez de chutar.
  outro: 'Outro',
};

// Vocabulário dos badges (spec §49). A V1 não decide mídia: nunca "PAUSAR"/"ESCALAR" como veredito,
// sempre uma leitura com o motivo à vista. 'sem_base' é o mais importante deles — é o que impede um
// ROAS alto sobre R$ 50 de gasto de parecer uma descoberta.
export const META_SINAL_ROTULO: Record<string, { label: string; tom: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  candidato_escala: { label: 'Candidato a escala', tom: 'success' },
  monitorar: { label: 'Monitorar', tom: 'warning' },
  baixa_eficiencia: { label: 'Baixa eficiência', tom: 'danger' },
  sem_base: { label: 'Sem base ainda', tom: 'neutral' },
};

// Tempo médio assistido vem em segundos.
export function metaSegundos(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}s`;
}

// Objetivo da campanha: a Meta manda em SCREAMING_SNAKE com prefixo de geração ("OUTCOME_SALES").
// Traduzir os conhecidos e deixar o resto legível é melhor que mostrar o enum cru.
const META_OBJETIVO: Record<string, string> = {
  OUTCOME_SALES: 'Vendas',
  OUTCOME_TRAFFIC: 'Tráfego',
  OUTCOME_ENGAGEMENT: 'Engajamento',
  OUTCOME_LEADS: 'Cadastros',
  OUTCOME_AWARENESS: 'Reconhecimento',
  OUTCOME_APP_PROMOTION: 'Promoção de app',
  CONVERSIONS: 'Conversões',
  LINK_CLICKS: 'Cliques no link',
  PRODUCT_CATALOG_SALES: 'Vendas do catálogo',
  OFFSITE_CONVERSIONS: 'Conversões no site',
};

export function metaObjetivo(objetivo: string | null): string {
  if (!objetivo) return '—';
  if (META_OBJETIVO[objetivo]) return META_OBJETIVO[objetivo];
  return objetivo.replace(/^OUTCOME_/, '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
