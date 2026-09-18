'use strict';

// INV-23 / B-04 / F-10 — entitlements fail-closed.
//
// Hoje é fail-OPEN em dois lugares independentes, e é preciso ver os dois para entender o tamanho
// do problema (8a7ea3d):
//
//   frontend  src/state/entitlements.ts:14-22,36-39  → DEFAULTS com tudo `true`
//   backend   server.js:13390                              → { ...ENTITLEMENTS_DEFAULT, ...entitlements }
//
// No backend, o spread faz chave AUSENTE virar permissão CONCEDIDA. Ou seja: falhar ao carregar o
// plano, ou carregar um plano que não menciona a feature, libera a feature. É exatamente o
// contrário do que um entitlement é.
//
// Aqui: ausência nega, erro nega, plano nulo nega. Nada é concedido por omissão.

const { contextoAtual } = require('./tenant-runtime');

// TD-012 (V1): vocabulário FECHADO de features que o backend protege. Pedir uma feature fora
// daqui é erro de programação e nega. Não é catálogo comercial (PD-005/PD-009 seguem abertos).
//
// Rodada "features × connectors × capabilities": este vocabulário passou a ser SÓ capacidade
// comercial do Oria. O critério aplicado item a item (§2) foi:
//
//     "se amanhã o Oria trocar a Reserva Ink por outro fornecedor,
//      isso continua existindo como capacidade do Oria?"
//
// Sete chaves saíram daqui. A classificação e a evidência de código estão em
// docs/architecture/features-vs-connectors.md; o resumo é FEATURES_DEPRECIADAS logo abaixo.
const FEATURES = Object.freeze([
  'whatsapp',
  'instagram',
  'advancedAutomations',
  'financial',
  'creative_generator',
]);

// Chaves que JÁ FORAM feature comercial e não são mais. Ficam DECLARADAS (não apagadas) por três
// motivos concretos:
//   1. o domain `platform_feature` do banco ainda as aceita — a remoção física é migration
//      posterior (Phase E, complemento §17), e até lá o teste de registry precisa saber que a
//      diferença entre código e banco é DELIBERADA;
//   2. `app_config.entitlements` de organizations já semeadas ainda tem as chaves gravadas, e
//      elas precisam ser lidas como RUÍDO IGNORADO, nunca como concessão;
//   3. quem procurar a chave antiga acha aqui para onde ela foi.
//
// São `deprecated`, `non-commercial` e IGNORADAS na resolução de entitlement: fora de FEATURES,
// `checkEntitlement` as nega como "feature desconhecida" e `planoEfetivo` nem as devolve. Nenhuma
// volta a ser checkbox de plano (complemento §18/§19).
const FEATURES_DEPRECIADAS = Object.freeze({
  // → Connector capabilities da Reserva Ink (lib/platform/connector-capabilities.js).
  catalog: 'connector_capability: ink.products, ink.collections, ink.product_clusters, ink.promotions, ink.catalog_sync, ink.product_feed, ink.inventory',
  exchanges: 'connector_capability: ink.exchanges',
  refunds: 'connector_capability: ink.refunds',
  // → Module capabilities do Gerador (lib/creative-core/module-capabilities.js).
  creative_clean_angles: 'module_capability: creative_generator/clean_angles',
  creative_remarketing: 'module_capability: creative_generator/remarketing',
  creative_funnel_visual: 'module_capability: creative_generator/funnel_visual',
  creative_multi_product: 'module_capability: creative_generator/multi_product',
});

// Rodada 19 (§9): estado de IMPLEMENTAÇÃO de cada feature do vocabulário. É fato do código, não
// plano comercial (PD-005/PD-009 seguem abertos). Só `implementada` pode ser semeada por
// `npm run tenancy:seed-entitlements`; o teste `r19-entitlement-seed` confere esta tabela contra as
// rotas protegidas (feature-routes.js), as flags do Creative Core e a navegação do admin.
//   implementada       há rota/motor que confere a feature e tela que a usa
//   em_breve           declarada na navegação como comingSoon; nenhuma rota a confere
//   nao_implementada   só existe no vocabulário; nenhuma rota nem tela a confere
const ESTADO_DAS_FEATURES = Object.freeze({
  whatsapp: 'implementada',
  instagram: 'em_breve',
  advancedAutomations: 'nao_implementada',
  financial: 'implementada',
  creative_generator: 'implementada',
});
const FEATURES_IMPLEMENTADAS = Object.freeze(FEATURES.filter((f) => ESTADO_DAS_FEATURES[f] === 'implementada'));

class EntitlementDeniedError extends Error {
  constructor(feature, motivo) {
    super(`feature "${feature}" negada: ${motivo}`);
    this.name = 'EntitlementDeniedError';
    this.feature = feature;
    this.motivo = motivo;
  }
}

// Carrega o plano e decide. `carregarPlano` é assíncrono e PODE falhar — derrubar a fonte de
// entitlements é a violação que o invariant introduz, e o resultado correto é 403, não 200.
async function checkEntitlement(carregarPlano, feature, contexto = {}) {
  if (!FEATURES.includes(feature)) {
    throw new EntitlementDeniedError(feature, 'feature desconhecida — nega (TD-012)');
  }
  let plano;
  try {
    plano = await carregarPlano(contexto);
  } catch (err) {
    // Log uma vez, na borda onde o contexto existe. Sem detalhe do erro na decisão: a decisão é
    // sempre a mesma, e é negar.
    throw new EntitlementDeniedError(feature, `fonte de entitlements indisponível (${err.message})`);
  }

  if (!plano || typeof plano !== 'object') {
    throw new EntitlementDeniedError(feature, 'plano não resolvido');
  }

  const valor = plano[feature];
  if (valor === undefined) {
    throw new EntitlementDeniedError(feature, 'feature ausente no plano — ausência nega (INV-23)');
  }
  if (valor !== true) {
    throw new EntitlementDeniedError(feature, 'feature desabilitada no plano');
  }

  return true;
}

// Middleware Express, no fim do pipeline de tenant (Fase 3).
function requireEntitlement(carregarPlano, feature) {
  return async function entitlementMiddleware(req, res, next) {
    try {
      await checkEntitlement(carregarPlano, feature, { req });
      next();
    } catch (err) {
      if (err instanceof EntitlementDeniedError) {
        // Nada do motivo interno vai para o cliente além do nome da feature.
        res.status(403).json({ erro: 'feature_nao_disponivel', feature });
        return;
      }
      next(err);
    }
  };
}

// Plano da Organization do CONTEXTO, lido da FONTE CANÔNICA: a assinatura ativa, as features do
// plano e os overrides — as mesmas tabelas que o Oria Admin escreve.
//
// Antes isto lia `app_config` com a chave `entitlements`, que só um script de linha de comando
// escrevia. O resultado é que uma Organization criada pela interface do Admin tinha plano concedido
// e o painel não via nada: tudo 403, com a tela dizendo "não incluído no plano". Duas fontes de
// verdade que nunca conversaram — agora é uma só.
//
// A leitura passa por `entitlements_efetivos`/`entitlements_estado` (SECURITY DEFINER, concedidas à
// role da aplicação no OPS-14): o painel pergunta o que ESTA Organization pode, e não tem acesso ao
// catálogo de planos da plataforma. A Organization vem do contexto autenticado, nunca do request.
//
// Devolve `null` quando não há acesso a conceder (suspensa, sem assinatura ativa, plano vazio) —
// e `null` nega tudo, que é o comportamento fail-closed que já existia.
function carregadorDaOrganizacao(pool) {
  return async () => {
    // Predicado explícito além da RLS: sem contexto não há de quem ler — erro, e o erro nega.
    const ctx = contextoAtual();
    if (!ctx) throw new Error('entitlements fora de um contexto de Organization');
    const { rows } = await pool.query(
      'SELECT feature FROM entitlements_efetivos($1)',
      [ctx.organizationId]
    );
    if (!rows.length) return null;
    return Object.fromEntries(rows.map((r) => [r.feature, true]));
  };
}

// Estado do acesso, para a UI distinguir as causas. "Suspensa", "sem assinatura" e "plano sem esta
// feature" são três coisas diferentes, e dizer "não incluído no plano" para as três é mentira em
// dois casos.
async function estadoDoAcesso(pool) {
  const ctx = contextoAtual();
  if (!ctx) throw new Error('estado de acesso fora de um contexto de Organization');
  const { rows } = await pool.query(
    'SELECT organizacao_ativa, assinatura_ativa, plano_chave FROM entitlements_estado($1)',
    [ctx.organizationId]
  );
  const r = rows[0] || {};
  return {
    organizacaoAtiva: !!r.organizacao_ativa,
    assinaturaAtiva: !!r.assinatura_ativa,
    plano: r.plano_chave || null,
  };
}

// Plano efetivo para a UI: só o que está explicitamente `true`. Nada herda default.
async function planoEfetivo(carregarPlano) {
  let plano = null;
  try {
    plano = await carregarPlano();
  } catch {
    plano = null;
  }
  return Object.fromEntries(FEATURES.map((f) => [f, !!(plano && plano[f] === true)]));
}

module.exports = {
  FEATURES,
  FEATURES_DEPRECIADAS,
  ESTADO_DAS_FEATURES,
  FEATURES_IMPLEMENTADAS,
  EntitlementDeniedError,
  checkEntitlement,
  requireEntitlement,
  carregadorDaOrganizacao,
  estadoDoAcesso,
  planoEfetivo,
};
