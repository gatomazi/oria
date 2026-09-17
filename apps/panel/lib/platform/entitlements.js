'use strict';

// INV-23 / B-04 / F-10 — entitlements fail-closed.
//
// Hoje é fail-OPEN em dois lugares independentes, e é preciso ver os dois para entender o tamanho
// do problema (8a7ea3d):
//
//   frontend  admin/src/state/entitlements.ts:14-22,36-39  → DEFAULTS com tudo `true`
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
const FEATURES = Object.freeze([
  'whatsapp',
  'instagram',
  'advancedAutomations',
  'catalog',
  'exchanges',
  'refunds',
  'financial',
  'creative_generator',
  'creative_clean_angles',
  'creative_remarketing',
  'creative_funnel_visual',
  'creative_multi_product',
]);

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
  catalog: 'implementada',
  exchanges: 'implementada',
  refunds: 'implementada',
  financial: 'implementada',
  creative_generator: 'implementada',
  creative_clean_angles: 'implementada',
  creative_remarketing: 'implementada',
  creative_funnel_visual: 'implementada',
  creative_multi_product: 'implementada',
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

// Plano da Organization do CONTEXTO (app_config 'entitlements', uma linha por Organization).
// `pool` é a fachada do tenant-runtime: a query roda sob RLS com a Organization da sessão. JSON
// ausente ou inválido → null → nega.
function carregadorDaOrganizacao(pool) {
  return async () => {
    // Predicado explícito além da RLS: sem contexto não há de quem ler — erro, e o erro nega.
    const ctx = contextoAtual();
    if (!ctx) throw new Error('entitlements fora de um contexto de Organization');
    const { rows } = await pool.query(
      `SELECT valor FROM app_config WHERE chave = 'entitlements' AND organization_id = $1`,
      [ctx.organizationId]
    );
    const valor = rows.length === 1 ? rows[0].valor : null;
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
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
  ESTADO_DAS_FEATURES,
  FEATURES_IMPLEMENTADAS,
  EntitlementDeniedError,
  checkEntitlement,
  requireEntitlement,
  carregadorDaOrganizacao,
  planoEfetivo,
};
