'use strict';

// Runtime do Gerador de Criativos.
//
// UMA feature comercial decide o módulo inteiro: `creative_generator` (complemento §2/§9/§10). Os
// modos internos — ângulos limpos, remarketing, funil visual, multiproduto — deixaram de ser
// entitlement comercial e passaram a ser MODULE CAPABILITIES (module-capabilities.js).
//
//     creative_generator = true   → módulo ligado → TODAS as capabilities V1 disponíveis
//     creative_generator = false  → nada
//
// O que mudou de verdade: antes, ligar o gerador sem ligar `creative_clean_angles` deixava a
// conta com um gerador sem motor nenhum. Agora não existe esse estado — quem compra o Gerador
// recebe os modos que o módulo tem hoje, e modo novo (§22) entra sem virar feature nova.
//
// `CREATIVE_FEATURE_FLAGS` continua existindo como escape hatch de dev/teste manual, mas só
// consegue LIGAR o módulo; não existe mais ligar/desligar motor por flag individual, porque isso
// reintroduziria o eixo comercial por engine que esta rodada removeu.

const { CAPABILITIES, FEATURE_DO_MODULO } = require('./module-capabilities');

// Nome de flag runtime por capability. As chaves `creative_*` daqui NÃO são mais lidas do plano:
// são o formato interno do objeto de flags que o gerador já usa em todo lugar.
const FLAG_DA_CAPABILITY = Object.freeze({
  clean_angles: 'creative_clean_angles',
  remarketing: 'creative_remarketing',
  funnel_visual: 'creative_funnel_visual',
  multi_product: 'creative_multi_product',
});

// A feature comercial mais as flags internas derivadas dela.
const FLAGS = Object.freeze([FEATURE_DO_MODULO, ...CAPABILITIES.map((c) => FLAG_DA_CAPABILITY[c])]);

// Só a feature comercial é conferida contra o plano da conta.
const FEATURES_CONFERIDAS = Object.freeze([FEATURE_DO_MODULO]);

const ENGINE_FLAG = Object.freeze({
  CLEAN_ANGLES: 'creative_clean_angles',
  REMARKETING: 'creative_remarketing',
  FUNNEL_VISUAL: 'creative_funnel_visual',
});

// `entitlements` é o plano da conta. Só `creative_generator` é lido dele — as quatro chaves
// antigas, se ainda estiverem gravadas no JSON de alguma Organization já semeada, são ruído
// ignorado (entitlements.js · FEATURES_DEPRECIADAS).
function resolveFlags(entitlements, envValue) {
  const env = new Set(String(envValue || '').split(',').map((s) => s.trim()).filter(Boolean));
  const modulo = (entitlements && entitlements[FEATURE_DO_MODULO] === true) || env.has(FEATURE_DO_MODULO);
  const flags = {};
  for (const flag of FLAGS) flags[flag] = modulo;
  return flags;
}

// Motores visíveis/permitidos — nunca inclui estratégias internas do gerador (STATE_COLLECTION, ORGANIC, ...).
function enabledEngines(flags) {
  return Object.keys(ENGINE_FLAG).filter((engine) => flags[ENGINE_FLAG[engine]]);
}

function checkEngineAccess(flags, engine, productMode) {
  if (!flags[FEATURE_DO_MODULO]) return 'o gerador de criativos não está habilitado nesta conta';
  if (!ENGINE_FLAG[engine]) return 'motor inexistente';
  if (!flags[ENGINE_FLAG[engine]]) return 'este motor não está habilitado nesta conta';
  if (productMode === 'multi_product' && !flags.creative_multi_product) return 'multipeça não está habilitado nesta conta';
  return null;
}

module.exports = { FLAGS, FEATURES_CONFERIDAS, FLAG_DA_CAPABILITY, ENGINE_FLAG, resolveFlags, enabledEngines, checkEngineAccess };
