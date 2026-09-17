'use strict';

// Normalizador de uma linha da Insights API → uma linha de `meta_insights_daily`
// (docs/meta-ads-analytics-integracao-v2.md §14, §15, §29). Puro, sem I/O, pra poder ser testado.
//
// Regra de consistência das taxas (spec §79): a Meta devolve `ctr`/`cpc`/`cpm` já calculados, e é
// esse número que aparece no Ads Manager. Guardamos o valor dela na linha diária pra não divergir
// do Ads Manager quando o usuário olha UM dia. Mas taxa não soma: o CTR de 7 dias NÃO é a média dos
// 7 CTRs diários. Toda agregação por período recalcula a partir das somas de clicks/impressions/
// spend (ver agregarInsights) — a coluna diária é informativa, a soma é que manda.

const { parseNumero, parseNumeroOuZero, normalizarActions, normalizarVideo, metricas } = require('./actions');

// Campos pedidos à Insights API. Mantido aqui (e não espalhado) porque a spec §92 manda revalidar
// a lista contra a documentação oficial quando a versão da Graph API subir.
const CAMPOS_INSIGHTS = [
  'date_start', 'date_stop',
  'account_id', 'campaign_id', 'adset_id', 'ad_id',
  'impressions', 'reach', 'frequency',
  'clicks', 'unique_clicks', 'inline_link_clicks', 'outbound_clicks', 'unique_outbound_clicks',
  'spend', 'ctr', 'cpc', 'cpm', 'cpp',
  'actions', 'action_values',
  'video_play_actions', 'video_thruplay_watched_actions', 'video_avg_time_watched_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions',
  'video_p95_watched_actions', 'video_p100_watched_actions',
];

const NIVEIS = ['account', 'campaign', 'adset', 'ad'];

// `outbound_clicks` e `unique_outbound_clicks` NÃO são números: vêm como array de ações, igual a
// `actions` (action_type 'outbound_click'). Tratar como número dá NaN silencioso.
function somarArrayDeAcoes(valor) {
  if (valor === null || valor === undefined) return 0;
  if (Array.isArray(valor)) return valor.reduce((acc, a) => acc + parseNumeroOuZero(a && a.value), 0);
  return parseNumeroOuZero(valor);
}

// `attributionSetting` entra na chave única da linha (spec §29): a mesma entidade, no mesmo dia,
// medida com janela de atribuição diferente é OUTRO número — não pode sobrescrever o anterior.
function normalizarLinhaInsight(linha, { level, attributionSetting }) {
  if (!NIVEIS.includes(level)) throw new Error(`nível de insight inválido: ${level}`);

  const impressions = parseNumeroOuZero(linha.impressions);
  const reach = parseNumeroOuZero(linha.reach);
  const clicks = parseNumeroOuZero(linha.clicks);
  const spend = parseNumeroOuZero(linha.spend);
  const acoes = normalizarActions(linha.actions, linha.action_values);
  const video = normalizarVideo(linha);

  return {
    level,
    date: linha.date_start,
    metaCampaignId: linha.campaign_id || null,
    metaAdSetId: linha.adset_id || null,
    metaAdId: linha.ad_id || null,

    impressions,
    reach,
    // A Meta só manda `frequency` a partir do nível em que ela faz sentido; quando falta, deriva de
    // impressions/reach (protegido contra reach = 0).
    frequency: parseNumero(linha.frequency) ?? metricas.frequency(impressions, reach),

    clicks,
    uniqueClicks: parseNumeroOuZero(linha.unique_clicks),
    inlineLinkClicks: parseNumeroOuZero(linha.inline_link_clicks),
    outboundClicks: somarArrayDeAcoes(linha.outbound_clicks),
    uniqueOutboundClicks: somarArrayDeAcoes(linha.unique_outbound_clicks),

    spend,
    // Preferimos o valor da Meta (bate com o Ads Manager); só calculamos quando ela omite.
    ctr: parseNumero(linha.ctr) ?? metricas.ctr(clicks, impressions),
    cpc: parseNumero(linha.cpc) ?? metricas.cpc(spend, clicks),
    cpm: parseNumero(linha.cpm) ?? metricas.cpm(spend, impressions),

    landingPageViews: acoes.landingPageViews,
    viewContent: acoes.viewContent,
    addToCart: acoes.addToCart,
    initiateCheckout: acoes.initiateCheckout,
    purchases: acoes.purchases,
    purchaseValue: acoes.purchaseValue,
    costPerPurchase: metricas.cpa(spend, acoes.purchases),

    ...video,

    attributionSetting: attributionSetting || 'default',
    // Guardado cru pra auditoria e pra permitir reprocessar um action_type novo sem re-sincronizar
    // 90 dias da Meta de novo (spec §29 deixa `rawActions` opcional; aqui compensa).
    rawActions: Array.isArray(linha.actions) ? linha.actions : null,
    rawActionValues: Array.isArray(linha.action_values) ? linha.action_values : null,
  };
}

// Colunas que podem ser somadas direto. Vídeo fica de fora porque ausência ali é significativa
// (anúncio de imagem não tem vídeo) e precisa continuar null, não virar 0.
const CAMPOS_SOMAVEIS = [
  'impressions', 'reach', 'clicks', 'uniqueClicks', 'inlineLinkClicks',
  'outboundClicks', 'uniqueOutboundClicks', 'spend',
  'landingPageViews', 'viewContent', 'addToCart', 'initiateCheckout',
  'purchases', 'purchaseValue',
];
const CAMPOS_VIDEO_SOMAVEIS = ['videoPlays', 'videoThruplays', 'video25', 'video50', 'video75', 'video95', 'video100'];

// Recebe um objeto de valores JÁ SOMADOS (venha ele de um SUM() do Postgres ou de agregarInsights)
// e devolve o DTO do período com as taxas recalculadas. É o único lugar onde CTR/CPC/CPM/CPA/ROAS
// de um período nascem — assim a rota de overview, a de série e a de tabela não podem divergir
// entre si por terem cada uma a sua continha.
//
// Duas regras moram aqui:
//   1. Taxa NUNCA é média de taxas diárias. CTR de 7 dias = soma(clicks)/soma(impressions).
//      Fazer a média dos 7 CTRs dá outro número e é como um dashboard passa a divergir do Ads Manager.
//   2. `reach` do período fica null. Alcance não soma: a mesma pessoa alcançada em dois dias conta
//      uma vez no período, e a Meta não devolve essa deduplicação por dia. A soma vai em
//      `reachSomado`, com nome que não deixa confundir (spec §54).
function totalizarSomas(somas) {
  const s = somas || {};
  const total = {};
  for (const campo of CAMPOS_SOMAVEIS) total[campo] = parseNumeroOuZero(s[campo]);
  const video = {};
  for (const campo of CAMPOS_VIDEO_SOMAVEIS) {
    video[campo] = s[campo] === null || s[campo] === undefined ? null : parseNumeroOuZero(s[campo]);
  }
  return {
    ...total,
    ...video,
    reachSomado: total.reach,
    reach: null,
    frequency: metricas.frequency(total.impressions, total.reach),
    ctr: metricas.ctr(total.clicks, total.impressions),
    cpc: metricas.cpc(total.spend, total.clicks),
    cpm: metricas.cpm(total.spend, total.impressions),
    cpa: metricas.cpa(total.spend, total.purchases),
    roas: metricas.roas(total.purchaseValue, total.spend),
  };
}

// Soma N linhas diárias e totaliza. Usado onde as linhas já estão em memória (exportação, teste);
// as rotas do painel deixam o SUM() com o Postgres e chamam só totalizarSomas.
function agregarInsights(linhas) {
  const somas = {};
  for (const campo of CAMPOS_SOMAVEIS) somas[campo] = 0;
  for (const campo of CAMPOS_VIDEO_SOMAVEIS) somas[campo] = null;
  for (const l of linhas || []) {
    for (const campo of CAMPOS_SOMAVEIS) somas[campo] += parseNumeroOuZero(l[campo]);
    for (const campo of CAMPOS_VIDEO_SOMAVEIS) {
      if (l[campo] === null || l[campo] === undefined) continue;
      somas[campo] = (somas[campo] || 0) + parseNumeroOuZero(l[campo]);
    }
  }
  return totalizarSomas(somas);
}

// ── INSERT em lote dos snapshots diários ────────────────────────────────────────────────────
// Mora aqui, e não no server.js, porque é o trecho mais fácil de quebrar em silêncio: são 37
// colunas e 37 valores posicionais, e trocar a ordem de um par grava dado na coluna errada sem
// erro nenhum do Postgres (BIGINT e NUMERIC aceitam os dois). Aqui ele é executado de verdade
// pelo teste, contra um Postgres real, com dado no formato que a Meta manda.

// Ordem das colunas. É a ÚNICA definição: os valores são montados a partir dela, então não existe
// "lista de colunas" e "lista de valores" que possam sair de sincronia.
const COLUNAS_INSIGHT = [
  ['meta_account_id', (l, ctx) => ctx.contaId],
  ['level', (l, ctx) => ctx.level],
  ['entidade_id', (l, ctx) => entidadeIdDoNivel(l, ctx.level, ctx.contaId)],
  ['data', (l) => l.date],
  ['attribution_setting', (l) => l.attributionSetting],
  ['meta_campaign_id', (l) => l.metaCampaignId],
  ['meta_adset_id', (l) => l.metaAdSetId],
  ['meta_ad_id', (l) => l.metaAdId],
  ['impressions', (l) => l.impressions],
  ['reach', (l) => l.reach],
  ['frequency', (l) => l.frequency],
  ['clicks', (l) => l.clicks],
  ['unique_clicks', (l) => l.uniqueClicks],
  ['inline_link_clicks', (l) => l.inlineLinkClicks],
  ['outbound_clicks', (l) => l.outboundClicks],
  ['unique_outbound_clicks', (l) => l.uniqueOutboundClicks],
  ['spend', (l) => l.spend],
  ['ctr', (l) => l.ctr],
  ['cpc', (l) => l.cpc],
  ['cpm', (l) => l.cpm],
  ['landing_page_views', (l) => l.landingPageViews],
  ['view_content', (l) => l.viewContent],
  ['add_to_cart', (l) => l.addToCart],
  ['initiate_checkout', (l) => l.initiateCheckout],
  ['purchases', (l) => l.purchases],
  ['purchase_value', (l) => l.purchaseValue],
  ['cost_per_purchase', (l) => l.costPerPurchase],
  ['video_plays', (l) => l.videoPlays],
  ['video_thruplays', (l) => l.videoThruplays],
  ['video_25', (l) => l.video25],
  ['video_50', (l) => l.video50],
  ['video_75', (l) => l.video75],
  ['video_95', (l) => l.video95],
  ['video_100', (l) => l.video100],
  ['video_avg_watch_time', (l) => l.videoAvgWatchTime],
  ['raw_actions', (l) => (l.rawActions ? JSON.stringify(l.rawActions) : null)],
  ['raw_action_values', (l) => (l.rawActionValues ? JSON.stringify(l.rawActionValues) : null)],
];

// Estas cinco formam a chave única do snapshot — não entram no UPDATE, senão o ON CONFLICT tentaria
// reescrever a própria chave que acabou de casar.
const CHAVE_INSIGHT = ['meta_account_id', 'level', 'entidade_id', 'data', 'attribution_setting'];
// Árbitro do upsert: a chave do snapshot DENTRO da Organization (Fase 1, INV-05). O valor de
// organization_id vem do contexto ou, na transição, do trigger de tenancy — antes da arbitragem.
const ALVO_CONFLITO_INSIGHT = ['organization_id', ...CHAVE_INSIGHT];

function entidadeIdDoNivel(linha, level, contaId) {
  if (level === 'ad') return linha.metaAdId;
  if (level === 'adset') return linha.metaAdSetId;
  if (level === 'campaign') return linha.metaCampaignId;
  return contaId;
}

// Monta o multi-row upsert. `RETURNING (xmax = 0)` é o jeito padrão de saber, linha a linha, o que
// foi inserido e o que foi atualizado — o MetaSyncLog precisa dos dois separados (spec §36).
function montarUpsertInsights(contaId, level, linhas) {
  const ctx = { contaId, level };
  const nomes = COLUNAS_INSIGHT.map(([nome]) => nome);
  const n = nomes.length;
  const params = [];
  const tuplas = linhas.map((linha, i) => {
    for (const [, extrair] of COLUNAS_INSIGHT) params.push(extrair(linha, ctx));
    return `(${Array.from({ length: n }, (_, k) => `$${i * n + k + 1}`).join(',')})`;
  });
  const atualizaveis = nomes.filter((nome) => !CHAVE_INSIGHT.includes(nome));
  const sql =
    `INSERT INTO meta_insights_daily (${nomes.join(', ')})\n` +
    `VALUES ${tuplas.join(', ')}\n` +
    `ON CONFLICT (${ALVO_CONFLITO_INSIGHT.join(', ')}) DO UPDATE SET\n` +
    `  ${atualizaveis.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, atualizado_em = now()\n` +
    `RETURNING (xmax = 0) AS inserido`;
  return { sql, params };
}

// Variação percentual entre período atual e anterior (spec §41). null quando não há base de
// comparação — "de 0 para 10" não é "+∞%" nem "+100%", é "sem base".
function variacao(atual, anterior) {
  const a = parseNumero(atual);
  const b = parseNumero(anterior);
  if (a === null || b === null || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

// Semântica por métrica (spec §41): verde/vermelho cego mente. Subir gasto não é bom nem ruim sem
// contexto; subir CPA é ruim; subir receita é bom. A UI lê daqui em vez de decidir cor na tela.
const DIRECAO_BOA = {
  spend: 'neutro',
  impressions: 'neutro',
  reach: 'neutro',
  frequency: 'neutro',
  clicks: 'cima',
  ctr: 'cima',
  purchases: 'cima',
  purchaseValue: 'cima',
  roas: 'cima',
  cpc: 'baixo',
  cpm: 'baixo',
  cpa: 'baixo',
};

module.exports = {
  CAMPOS_INSIGHTS,
  NIVEIS,
  CAMPOS_SOMAVEIS,
  CAMPOS_VIDEO_SOMAVEIS,
  COLUNAS_INSIGHT,
  CHAVE_INSIGHT,
  somarArrayDeAcoes,
  normalizarLinhaInsight,
  entidadeIdDoNivel,
  montarUpsertInsights,
  totalizarSomas,
  agregarInsights,
  variacao,
  DIRECAO_BOA,
};
