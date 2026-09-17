'use strict';

// Feature flags do Gerador de Criativos. Default DESLIGADO para todas: o módulo só liga quando o entitlement da conta
// (app_config 'entitlements' / db/entitlements.json) traz `true`, ou quando a env CREATIVE_FEATURE_FLAGS lista a flag
// (útil em dev/teste manual). Sem `creative_generator`, todas as outras ficam desligadas.

const FLAGS = Object.freeze([
  'creative_generator',
  'creative_clean_angles',
  'creative_remarketing',
  'creative_funnel_visual',
  'creative_multi_product',
]);

const ENGINE_FLAG = Object.freeze({
  CLEAN_ANGLES: 'creative_clean_angles',
  REMARKETING: 'creative_remarketing',
  FUNNEL_VISUAL: 'creative_funnel_visual',
});

function resolveFlags(entitlements, envValue) {
  const env = new Set(String(envValue || '').split(',').map((s) => s.trim()).filter(Boolean));
  const flags = {};
  for (const flag of FLAGS) flags[flag] = (entitlements && entitlements[flag] === true) || env.has(flag);
  if (!flags.creative_generator) for (const flag of FLAGS) flags[flag] = false;
  return flags;
}

// Motores visíveis/permitidos — nunca inclui estratégias internas do gerador (STATE_COLLECTION, ORGANIC, ...).
function enabledEngines(flags) {
  return Object.keys(ENGINE_FLAG).filter((engine) => flags[ENGINE_FLAG[engine]]);
}

function checkEngineAccess(flags, engine, productMode) {
  if (!flags.creative_generator) return 'o gerador de criativos não está habilitado nesta conta';
  if (!ENGINE_FLAG[engine]) return 'motor inexistente';
  if (!flags[ENGINE_FLAG[engine]]) return 'este motor não está habilitado nesta conta';
  if (productMode === 'multi_product' && !flags.creative_multi_product) return 'multipeça não está habilitado nesta conta';
  return null;
}

module.exports = { FLAGS, ENGINE_FLAG, resolveFlags, enabledEngines, checkEngineAccess };
