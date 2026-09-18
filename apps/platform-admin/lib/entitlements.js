'use strict';

// Resolver de acesso efetivo do control plane.
//
// ── Registry ─────────────────────────────────────────────────────────────────────────────────
// `FEATURES` é CÓPIA DECLARADA de `apps/panel/lib/platform/entitlements.js` → FEATURES (não é
// require; ver lib/db.js). O mesmo vocabulário está gravado no banco como o domain
// `platform_feature`. Três cópias, e um teste (`entitlements-registry`) compara as três: divergir
// reprova. A terceira cópia não é redundância — é a que impede gravar feature inválida mesmo se
// alguém escrever SQL à mão.
//
// ── A regra ──────────────────────────────────────────────────────────────────────────────────
//
//     acesso_efetivo(org, feature) =
//           organization.status = 'active'
//       AND existe assinatura com status = 'active'
//       AND (  override explícito → override.permitido
//            ∨ plan_features      → habilitada
//            ∨ false )
//
//     precedência:  override da Organization  >  plano  >  false
//
// Ausência nega. Erro nega. Plano nulo nega. Organization suspensa nega TUDO, inclusive o que o
// override concede. Nunca `{ ...DEFAULTS, ...plano }` — o spread é o defeito INV-23 do painel, em
// que chave ausente virava permissão concedida.

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

// Perfil do Tenant #1 (apps/panel/config/entitlements/tenant1-entitlements.json). É o conteúdo do
// plano técnico `internal`, semeado pela migration. Sem `instagram` e sem `advancedAutomations`.
const FEATURES_INTERNAL = Object.freeze([
  'catalog',
  'creative_clean_angles',
  'creative_funnel_visual',
  'creative_generator',
  'creative_multi_product',
  'creative_remarketing',
  'exchanges',
  'financial',
  'refunds',
  'whatsapp',
]);

// Por que a feature ficou como ficou. É o que a UI mostra para tornar a precedência visível.
const ORIGENS = Object.freeze([
  'override',              // override explícito da Organization decidiu
  'plano',                 // veio do plano da assinatura ativa
  'ausente',               // nem override nem plano: false
  'sem_assinatura',        // não há assinatura ativa: tudo negado
  'organization_suspensa', // Organization suspensa: tudo negado
]);

class FeatureDesconhecidaError extends Error {
  constructor(features) {
    super(`feature fora do vocabulário: ${features.join(', ')}`);
    this.name = 'FeatureDesconhecidaError';
    this.features = features;
  }
}

// Rejeita, nunca "ignora silenciosamente". Pedir feature que não existe é erro de programação.
function exigirFeaturesConhecidas(features) {
  if (!Array.isArray(features)) throw new FeatureDesconhecidaError(['(não é lista)']);
  const desconhecidas = [...new Set(features.filter((f) => !FEATURES.includes(f)))];
  if (desconhecidas.length) throw new FeatureDesconhecidaError(desconhecidas);
  return features;
}

// `entrada`:
//   organizationStatus  'active' | 'suspended' | null (não existe)
//   assinaturaAtiva     boolean
//   featuresDoPlano     Map<feature, boolean> | objeto
//   overrides           Map<feature, boolean> | objeto
//
// Devolve { efetivos: {feature: boolean}, origem: {feature: origem} } com TODAS as features do
// vocabulário — nunca um objeto parcial, porque objeto parcial é o que convida ao spread.
function resolverAcessoEfetivo({ organizationStatus, assinaturaAtiva, featuresDoPlano, overrides } = {}) {
  const plano = normalizar(featuresDoPlano);
  const over = normalizar(overrides);

  const suspensa = organizationStatus !== 'active';
  const semAssinatura = !assinaturaAtiva;

  const efetivos = {};
  const origem = {};
  for (const f of FEATURES) {
    if (suspensa) {
      efetivos[f] = false;
      origem[f] = 'organization_suspensa';
      continue;
    }
    if (semAssinatura) {
      efetivos[f] = false;
      origem[f] = 'sem_assinatura';
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(over, f)) {
      efetivos[f] = over[f] === true;
      origem[f] = 'override';
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(plano, f)) {
      efetivos[f] = plano[f] === true;
      origem[f] = 'plano';
      continue;
    }
    efetivos[f] = false;
    origem[f] = 'ausente';
  }
  return { efetivos: Object.freeze(efetivos), origem: Object.freeze(origem) };
}

function normalizar(valor) {
  if (!valor) return {};
  if (valor instanceof Map) return Object.fromEntries(valor);
  if (typeof valor !== 'object' || Array.isArray(valor)) return {};
  return valor;
}

// Acesso a UMA feature, para quem quiser a pergunta direta. Desconhecida → erro (não `false`).
function acessoA(feature, resolucao) {
  exigirFeaturesConhecidas([feature]);
  return resolucao.efetivos[feature] === true;
}

module.exports = {
  FEATURES,
  FEATURES_INTERNAL,
  ORIGENS,
  FeatureDesconhecidaError,
  exigirFeaturesConhecidas,
  resolverAcessoEfetivo,
  acessoA,
};
