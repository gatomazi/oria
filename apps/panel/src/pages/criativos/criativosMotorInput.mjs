// Fase G.1 — lógica pura de montagem das opções de Remarketing/Funil, extraída para poder ser testada
// diretamente com `node:test` (mesmo motivo de `enrichmentReviewFields.mjs` — este repositório não tem
// harness de teste de componente React/JSX). GerarTab.tsx (V1) e GerarTabV2.tsx importam exatamente
// estas funções; nenhuma lógica duplicada entre os dois componentes nem entre o componente e o teste.

// "Copiar dados": o que o formulário sabe editar. O resto do que veio (chaves que a tela não mostra)
// volta intacto no pedido — nunca perdido silenciosamente.
export const CHAVES_REMARKETING = ['intent', 'headline', 'subheadline', 'cta', 'benefits', 'text_density', 'cta_emphasis', 'clean_mode', 'products_source'];
export const CHAVES_FUNIL = ['headline', 'subheadline', 'cta', 'benefits', 'badges', 'chips', 'search_bar_text', 'text_density', 'cta_emphasis', 'clean_mode'];

export function restoDe(obj, conhecidas) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !conhecidas.includes(k)));
}
export const texto_de = (v) => (typeof v === 'string' ? v : '');
export const lista_de = (v) => (Array.isArray(v) ? v.map(String).join('\n') : '');
export const linhas = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean);

export const TEXTO_MOTOR_VAZIO = {
  headline: '', subheadline: '', cta: '', benefits: '', badges: '', chips: '', search: '', density: '', emphasis: '', cleanMode: '',
};

// Monta `remarketing` a partir do estado de texto comum — campo vazio nunca entra no request (o motor
// decide o padrão); nunca manda string vazia como se fosse uma escolha explícita do lojista.
// `extra` carrega chaves que a tela não edita (vindas de "Copiar dados") — sempre preservadas.
export function remarketingOptions(texto, intent, extra = {}) {
  const out = { ...extra, intent };
  if (texto.headline) out.headline = texto.headline;
  if (texto.subheadline) out.subheadline = texto.subheadline;
  if (texto.cta) out.cta = texto.cta;
  if (texto.benefits) out.benefits = linhas(texto.benefits);
  if (texto.density) out.text_density = texto.density;
  if (texto.emphasis) out.cta_emphasis = texto.emphasis;
  if (texto.cleanMode) out.clean_mode = texto.cleanMode;
  return out;
}

// Monta `funnel` a partir do estado de texto comum. `FunnelOptions.clean_mode` é BOOLEANO (diferente do
// enum auto/always/never do Remarketing — mesma assimetria já tratada assim na V1). badges/chips/busca
// só fazem sentido fora do TOFU (o core os ignora em TOFU de qualquer forma; a tela evita mandar o que
// o motor vai descartar, para a prévia nunca prometer algo que não aparece).
export function funnelOptions(texto, stage, extra = {}) {
  const out = { ...extra };
  if (texto.headline) out.headline = texto.headline;
  if (texto.subheadline) out.subheadline = texto.subheadline;
  if (texto.cta) out.cta = texto.cta;
  if (texto.benefits) out.benefits = linhas(texto.benefits);
  if (texto.density) out.text_density = texto.density;
  if (texto.emphasis) out.cta_emphasis = texto.emphasis;
  if (texto.cleanMode) out.clean_mode = texto.cleanMode === 'always';
  if (stage !== 'TOFU') {
    if (texto.badges) out.badges = linhas(texto.badges);
    if (texto.chips) out.chips = linhas(texto.chips);
    if (texto.search) out.search_bar_text = texto.search;
  }
  return out;
}

// Estado de texto a preservar ao trocar de motor: nenhum. Campos de texto (headline/CTA/benefícios/etc.)
// são específicos do motor anterior e nunca fazem sentido transportados incoerentemente para outro
// motor (brief G.1 §3) — a troca de motor sempre reinicia para TEXTO_MOTOR_VAZIO. O que SOBREVIVE à
// troca (produto, família/ângulo, cena, contexto, persona) é decidido pelo componente, não aqui: são
// campos que não têm formato específico de motor, então não há nada para "limpar" estruturalmente.
export function textoAoTrocarDeMotor() {
  return { ...TEXTO_MOTOR_VAZIO };
}
