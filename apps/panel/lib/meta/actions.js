'use strict';

// MetaActionMapper (docs/meta-ads-analytics-integracao-v2.md §15-19) — a Insights API nunca devolve
// "purchases: 31". Ela devolve arrays de ações (`actions`) e de valores (`action_values`) onde cada
// linha é um par { action_type, value }, e o MESMO evento aparece em vários action_type ao mesmo
// tempo. Um pedido único costuma vir três vezes:
//
//   { action_type: 'purchase',                             value: '31' }
//   { action_type: 'offsite_conversion.fb_pixel_purchase', value: '31' }
//   { action_type: 'omni_purchase',                        value: '31' }
//
// Somar isso dá 93 compras que nunca existiram. Por isso a regra central deste módulo é:
// **escolher o primeiro action_type presente na ordem de prioridade, nunca somar as variantes**.
//
// Este arquivo é puro de propósito (nenhum require, nenhum I/O): é a única forma de testar a
// regra acima, já que o server.js abre pool do Postgres e registra rotas no require.

// Ordem de prioridade por evento. O primeiro que existir na resposta ganha — os seguintes são
// sinônimos do mesmo evento, contados por caminhos diferentes (pixel, omni-channel, onsite).
// `purchase` vem primeiro porque é o número que o próprio Ads Manager mostra como "Compras";
// manter a mesma escolha aqui evita o usuário comparar o painel com o Ads Manager e ver divergência.
const ACTION_TYPES = {
  purchase: [
    'purchase',
    'offsite_conversion.fb_pixel_purchase',
    'omni_purchase',
    'onsite_web_purchase',
    'web_in_store_purchase',
  ],
  addToCart: [
    'add_to_cart',
    'offsite_conversion.fb_pixel_add_to_cart',
    'omni_add_to_cart',
    'onsite_web_add_to_cart',
  ],
  initiateCheckout: [
    'initiate_checkout',
    'offsite_conversion.fb_pixel_initiate_checkout',
    'omni_initiated_checkout',
    'onsite_web_initiate_checkout',
  ],
  viewContent: [
    'view_content',
    'offsite_conversion.fb_pixel_view_content',
    'omni_view_content',
  ],
  lead: [
    'lead',
    'offsite_conversion.fb_pixel_lead',
    'omni_lead',
    'onsite_conversion.lead_grouped',
  ],
  landingPageView: ['landing_page_view'],
  linkClick: ['link_click'],
};

// Meta manda dinheiro e contagem como string ("109.9", "0.0") e às vezes omite o campo inteiro.
// Devolve null pra ausência real (≠ zero): o dashboard precisa distinguir "não se aplica" de "zero",
// senão mostra ROAS 0 pra um anúncio que nunca teve base pra converter (spec §63).
function parseNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number(String(valor).trim());
  return Number.isFinite(n) ? n : null;
}

// Mesma coisa, mas para colunas que representam contagem/dinheiro acumulado, onde ausência na
// resposta significa "não aconteceu no período" — aí zero é a leitura correta.
function parseNumeroOuZero(valor) {
  const n = parseNumero(valor);
  return n === null ? 0 : n;
}

// Helper central da spec §16. `actions` é o array cru da Meta; `tipos` é a lista de prioridade.
// Devolve 0 quando nenhum tipo aparece (o evento não aconteceu no período) — nunca soma variantes.
function getActionValue(actions, tipos) {
  if (!Array.isArray(actions) || !actions.length) return 0;
  if (!Array.isArray(tipos)) tipos = [tipos];
  for (const tipo of tipos) {
    const achado = actions.find((a) => a && a.action_type === tipo);
    if (achado) return parseNumeroOuZero(achado.value);
  }
  return 0;
}

// Traduz os arrays crus (`actions` / `action_values`) nos campos nomeados que a tabela guarda.
// Usar isto em vez de `actions.find(x => x.action_type === 'purchase')` espalhado por aí é o ponto
// da spec §16 — um lugar só decide qual variante conta.
function normalizarActions(actions, actionValues) {
  return {
    purchases: getActionValue(actions, ACTION_TYPES.purchase),
    purchaseValue: getActionValue(actionValues, ACTION_TYPES.purchase),
    addToCart: getActionValue(actions, ACTION_TYPES.addToCart),
    initiateCheckout: getActionValue(actions, ACTION_TYPES.initiateCheckout),
    viewContent: getActionValue(actions, ACTION_TYPES.viewContent),
    lead: getActionValue(actions, ACTION_TYPES.lead),
    landingPageViews: getActionValue(actions, ACTION_TYPES.landingPageView),
    linkClicks: getActionValue(actions, ACTION_TYPES.linkClick),
  };
}

// As métricas de vídeo também chegam como array de ações, mas com um action_type único por tipo de
// vídeo ('video_view'). Ausência aqui é significativa: anúncio de imagem não tem vídeo nenhum, e
// mostrar "0 plays" seria enganoso (spec §20) — por isso devolve null, não zero, quando o campo
// inteiro não veio na resposta.
function normalizarVideo(linha) {
  const doArray = (campo) => {
    const arr = linha[campo];
    if (!Array.isArray(arr) || !arr.length) return null;
    // Métrica de vídeo só tem uma entrada útil ('video_view'); somar o array é seguro aqui porque
    // não existem variantes do mesmo evento como acontece em `actions`.
    return arr.reduce((acc, a) => acc + parseNumeroOuZero(a && a.value), 0);
  };
  return {
    videoPlays: doArray('video_play_actions'),
    videoThruplays: doArray('video_thruplay_watched_actions'),
    video25: doArray('video_p25_watched_actions'),
    video50: doArray('video_p50_watched_actions'),
    video75: doArray('video_p75_watched_actions'),
    video95: doArray('video_p95_watched_actions'),
    video100: doArray('video_p100_watched_actions'),
    videoAvgWatchTime: doArray('video_avg_time_watched_actions'),
  };
}

// ── Métricas derivadas (spec §18, §19, §79) ────────────────────────────────────────────────
// Todas devolvem null quando o denominador é zero/ausente, em vez de 0 ou Infinity. O dashboard
// renderiza "—" pra null (spec §63: nunca mostrar "ROAS 0" sem base). Divisão por zero protegida
// em um lugar só.
function dividir(numerador, denominador) {
  const n = parseNumero(numerador);
  const d = parseNumero(denominador);
  if (n === null || d === null || d === 0) return null;
  const r = n / d;
  return Number.isFinite(r) ? r : null;
}

const metricas = {
  ctr: (clicks, impressions) => {
    const r = dividir(clicks, impressions);
    return r === null ? null : r * 100;
  },
  cpc: (spend, clicks) => dividir(spend, clicks),
  cpm: (spend, impressions) => {
    const r = dividir(spend, impressions);
    return r === null ? null : r * 1000;
  },
  cpa: (spend, purchases) => dividir(spend, purchases),
  roas: (purchaseValue, spend) => dividir(purchaseValue, spend),
  frequency: (impressions, reach) => dividir(impressions, reach),
  // MER observado (spec §53I / §79): receita REAL da loja sobre o gasto real de mídia conectada.
  // Não usa receita atribuída por plataforma nenhuma — é independente de atribuição por construção.
  mer: (receitaRealLoja, gastoMidiaConectada) => dividir(receitaRealLoja, gastoMidiaConectada),
};

module.exports = {
  ACTION_TYPES,
  parseNumero,
  parseNumeroOuZero,
  getActionValue,
  normalizarActions,
  normalizarVideo,
  dividir,
  metricas,
};
