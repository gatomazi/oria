'use strict';

// Registry de MODULE CAPABILITIES do Gerador de Criativos.
//
// Complemento §3/§5: `creative_clean_angles`, `creative_remarketing`, `creative_funnel_visual` e
// `creative_multi_product` deixaram de ser feature comercial. Não são o que o cliente compra —
// são modos internos do módulo que ele compra. O que ele compra é uma coisa só:
//
//     FEATURE COMERCIAL      creative_generator   "Gerador de Criativos"
//       └─ MODULE CAPABILITY   clean_angles
//       └─ MODULE CAPABILITY   remarketing
//       └─ MODULE CAPABILITY   funnel_visual
//       └─ MODULE CAPABILITY   multi_product
//
// Regra V1 (complemento §9/§10): `creative_generator = true` → TODAS as capabilities atuais
// disponíveis. Não existe entitlement por motor. Se um dia for preciso limitar modos por plano,
// o caminho é `creative_generator.capabilities = [...]` (§20), NUNCA voltar a feature por engine.
//
// Este módulo não conhece connector nenhum: o Gerador é feature independente da Reserva Ink
// (comando §24).

const FEATURE_DO_MODULO = 'creative_generator';

const CAPABILITIES = Object.freeze(['clean_angles', 'remarketing', 'funnel_visual', 'multi_product']);

const ROTULO = Object.freeze({
  clean_angles: 'Ângulos limpos',
  remarketing: 'Remarketing',
  funnel_visual: 'Funil visual',
  multi_product: 'Multiproduto',
});

// Chaves comerciais que ESTAS capabilities ocupavam antes desta rodada. Ficam aqui só para o
// mapa de depreciação (complemento §18): são `deprecated`, `non-commercial` e IGNORADAS na
// resolução de entitlement. Nenhum código pode voltar a ler uma destas do plano.
const CHAVES_LEGADAS = Object.freeze({
  creative_clean_angles: 'clean_angles',
  creative_remarketing: 'remarketing',
  creative_funnel_visual: 'funnel_visual',
  creative_multi_product: 'multi_product',
});

// V1: o módulo inteiro, ou nada. A lista sai do registry, nunca do plano.
function capabilitiesDisponiveis(moduloHabilitado) {
  return moduloHabilitado === true ? [...CAPABILITIES] : [];
}

function capabilityDisponivel(capability, moduloHabilitado) {
  return moduloHabilitado === true && CAPABILITIES.includes(capability);
}

module.exports = { FEATURE_DO_MODULO, CAPABILITIES, ROTULO, CHAVES_LEGADAS, capabilitiesDisponiveis, capabilityDisponivel };
