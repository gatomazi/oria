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
  'financial',
  'creative_generator',
  'meta_ads',
  'google_ads',
  'analytics_ga4',
  // Rodada H→I (apps/panel): Desempenho de Produtos (GA4 + Commerce reconciliado). Guard real
  // desde o início — diferente de meta_ads/google_ads/analytics_ga4, que entraram sem rota ligada.
  'analytics_product_performance',
  // Em transição: já classificadas como connector capability da Reserva Ink, ainda conferidas
  // como entitlement pelo runtime do painel. Saem do vocabulário quando o guard de connector for
  // ligado nas rotas de Catálogo, Trocas e Reembolsos — não antes, senão é 403 em tela que
  // funciona. Ver apps/panel/lib/platform/entitlements.js → FEATURES_EM_TRANSICAO.
  'catalog',
  'exchanges',
  'refunds',
]);

// Chaves que já foram feature comercial e não são mais (cópia declarada de
// `apps/panel/lib/platform/entitlements.js` → FEATURES_DEPRECIADAS): os quatro modos do Gerador
// de Criativos, que viraram module capability de `creative_generator`.
//
// Saíram porque o consumidor runtime delas já migrou — `resolveFlags` deriva os quatro motores de
// `creative_generator` e não lê mais as chaves. É esse o critério para depreciar: primeiro o
// runtime, depois o vocabulário.
//
// O domain `platform_feature` do banco AINDA aceita as quatro: estreitar o domain é a última fase
// da depreciação (Phase E), depois que nenhuma linha carregar mais a chave. Até lá o control plane
// trata a diferença como deliberada — nunca oferece uma delas como checkbox de plano (§19 do
// complemento), nunca aceita override novo nelas, e `resolverAcessoEfetivo` nem as calcula,
// porque o laço é sobre FEATURES.
const FEATURES_DEPRECIADAS = Object.freeze([
  'creative_clean_angles',
  'creative_remarketing',
  'creative_funnel_visual',
  'creative_multi_product',
]);

// Conteúdo VIGENTE do plano técnico `internal`, como as migrations o deixam (0019 + 0024 + 0033).
// As quatro chaves depreciadas podem continuar gravadas em `plan_features` até a migration de
// limpeza (a 0024 é aditiva de propósito) e não fazem parte desta lista. Sem
// `instagram` e sem `advancedAutomations`, que ninguém mandou ligar.
//
// São duas camadas, de propósito:
//   · as SETE comerciais — whatsapp, financial, creative_generator, meta_ads, google_ads,
//     analytics_ga4, analytics_product_performance — que descrevem o que o Oria entrega;
//   · as TRÊS em transição — catalog, exchanges, refunds — que continuam no plano porque o
//     runtime ainda as confere. Saem do plano junto com a fiação do guard de connector.
//
// Não é mais espelho do perfil `tenant1-entitlements.json`: aquele arquivo semeia
// `app_config.entitlements`, que deixou de ser fonte de verdade na 0023. O perfil é subconjunto
// deste plano — há teste conferindo — e não o contrário.
const FEATURES_INTERNAL = Object.freeze([
  'analytics_ga4',
  'analytics_product_performance',
  'catalog',
  'creative_generator',
  'exchanges',
  'financial',
  'google_ads',
  'meta_ads',
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
//
// Chave DEPRECIADA cai aqui junto com as desconhecidas, de propósito: é assim que "não permitir
// novos overrides" (§19) e "não voltar como checkbox de plano" (§28) viram regra de servidor, e
// não só de tela. A mensagem diz que a chave foi reclassificada, para o erro não parecer typo.
function exigirFeaturesConhecidas(features) {
  if (!Array.isArray(features)) throw new FeatureDesconhecidaError(['(não é lista)']);
  const desconhecidas = [...new Set(features.filter((f) => !FEATURES.includes(f)))];
  if (desconhecidas.length) {
    const depreciadas = desconhecidas.filter((f) => FEATURES_DEPRECIADAS.includes(f));
    const err = new FeatureDesconhecidaError(desconhecidas);
    if (depreciadas.length) {
      err.depreciadas = depreciadas;
      err.message = `${err.message} (reclassificada, não é mais feature comercial: ${depreciadas.join(', ')})`;
    }
    throw err;
  }
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
  FEATURES_DEPRECIADAS,
  FEATURES_INTERNAL,
  ORIGENS,
  FeatureDesconhecidaError,
  exigirFeaturesConhecidas,
  resolverAcessoEfetivo,
  acessoA,
};
