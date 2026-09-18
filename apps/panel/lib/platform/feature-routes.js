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
  [/^\/api\/admin\/(whatsapp|whatsapp-web|whatsapp-templates|campaigns|segments|automacao-eventos|automation-settings|recuperacao|dashboard\/recuperacao-resumo)(\/|$)/, 'whatsapp'],
  [/^\/api\/admin\/criativos(\/|$)/, 'creative_generator'],
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
// PENDENTE DE FIAÇÃO: `server.js` ainda só consome `featureDaRota`. Enquanto o guard de
// capability não estiver ligado lá, estas rotas seguem protegidas por sessão + contexto de
// Organization + a própria integração da Ink (que devolve 409 INTEGRATION_NOT_CONNECTED quando
// não há segredo). Sair do eixo de feature é, por construção, AFROUXAR — nunca tira acesso de
// quem já tem (§20).
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
