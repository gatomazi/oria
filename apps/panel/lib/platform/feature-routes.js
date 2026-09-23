'use strict';

// Que EXIGÊNCIA cada rota de negócio tem. Central, e aplicado dentro do pipeline de tenant
// (requireAdmin) — uma rota nova sob um destes prefixos já nasce protegida. A ordem importa: o
// primeiro padrão que casar vence.
//
// Não é catálogo comercial: só amarra rotas que JÁ existem ao vocabulário correspondente.
//
// Existem DOIS eixos, e cada rota fica em exatamente um deles:
//
//   ROTAS             exige FEATURE COMERCIAL      plano da Organization  → 403 feature_nao_disponivel
//   ROTAS_CAPABILITY  exige CONNECTOR CAPABILITY   integração conectada   → 409 connector_nao_conectado
//
// A separação é o ponto da rodada (§13): rota que só existe porque um provider externo
// disponibiliza aquilo NÃO é entitlement comercial, e connector conectado não concede feature
// nenhuma. Uma rota não pode aparecer nos dois — há teste conferindo.

const ROTAS = Object.freeze([
  [/^\/api\/admin\/(financeiro|dashboard\/financeiro|dashboard\/lucro-produtos|analytics\/consolidado)(\/|$)/, 'financial'],
  // Rodada H→I: Product Analytics (GA4 + Commerce/reconciliação) — feature própria, nunca
  // `analytics_ga4` (aquela é "capacidade sem_guard" hoje; esta é a feature com guard real).
  [/^\/api\/admin\/product-analytics(\/|$)/, 'analytics_product_performance'],
  [/^\/api\/admin\/(whatsapp|whatsapp-web|whatsapp-templates|campaigns|segments|clientes\/segmentos|automacao-eventos|automation-settings|recuperacao|dashboard\/recuperacao-resumo)(\/|$)/, 'whatsapp'],
  [/^\/api\/admin\/criativos(\/|$)/, 'creative_generator'],
  // ── Em transição ────────────────────────────────────────────────────────────────────────────
  // Conceitualmente são capacidades do Connector Ink (ROTAS_CAPABILITY abaixo descreve o destino).
  // Continuam no eixo de FEATURE porque o guard de capability ainda não está ligado em server.js:
  // movê-las agora não trocaria um guard por outro — deixaria estas rotas SEM guard de eixo nenhum.
  [/\/reembolsos(\/|$)/, 'refunds'],
  [/^\/api\/admin\/trocas(\/|$)/, 'exchanges'],
  [/^\/api\/admin\/(produtos|produto-tipos|categorias|category-assignments|category-jobs|agrupamentos|promocoes|estoque|controle-estoque)(\/|$)/, 'catalog'],
]);

// Rotas que migraram de feature comercial para connector capability nesta rodada.
//
//   /reembolsos               ex-`refunds`    → ink.refunds
//   /api/admin/trocas         ex-`exchanges`  → ink.exchanges
//   produtos/categorias/...   ex-`catalog`    → ink.products / ink.collections / ...
//
// A evidência da reclassificação está em docs/architecture/features-vs-connectors.md: cada um
// destes handlers é proxy ou cache da API da Reserva Ink; nenhum tem domínio próprio do Oria.
//
// DESTINO, AINDA NÃO LIGADO. Este mapa descreve para onde cada rota vai quando o runtime dela
// migrar para "Connector conectado + capability suportada". Até lá as mesmas rotas continuam em
// `ROTAS`, no eixo de feature — porque `server.js` só consome `featureDaRota`, e tirá-las de lá
// antes da fiação removeria a verificação em vez de trocá-la.
//
// É por isso que as duas tabelas se sobrepõem de propósito nesta fase: uma diz onde a rota está
// protegida HOJE, a outra diz para onde ela vai.
const ROTAS_CAPABILITY = Object.freeze([
  [/\/reembolsos(\/|$)/, 'ink.refunds'],
  [/^\/api\/admin\/trocas(\/|$)/, 'ink.exchanges'],
  [/^\/api\/admin\/(produtos|produto-tipos)(\/|$)/, 'ink.products'],
  [/^\/api\/admin\/(categorias|category-assignments|category-jobs)(\/|$)/, 'ink.collections'],
  [/^\/api\/admin\/agrupamentos(\/|$)/, 'ink.product_clusters'],
  [/^\/api\/admin\/promocoes(\/|$)/, 'ink.promotions'],
  [/^\/api\/admin\/(estoque|controle-estoque)(\/|$)/, 'ink.inventory'],
]);

const caminhoLimpo = (caminho) => String(caminho || '').split('?')[0];

function featureDaRota(caminho) {
  const p = caminhoLimpo(caminho);
  for (const [re, feature] of ROTAS) if (re.test(p)) return feature;
  return null;
}

function capabilityDaRota(caminho) {
  const p = caminhoLimpo(caminho);
  for (const [re, chave] of ROTAS_CAPABILITY) if (re.test(p)) return chave;
  return null;
}

module.exports = { ROTAS, ROTAS_CAPABILITY, featureDaRota, capabilityDaRota };
