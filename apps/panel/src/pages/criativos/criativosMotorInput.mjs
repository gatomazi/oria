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

// ------------------------------------------------------------------ Fase G.2 — multipeça

// `product_view` (Remarketing) é só-produto-único no core (MULTI_PRODUCT_RULES.REMARKETING.
// singleOnlyIntents) — nunca oferecido como opção quando o lojista já escolheu multipeça, em vez de
// deixar o core recusar depois de uma prévia inteira calculada.
export function intentsDisponiveis(todosOsIntents, productMode) {
  if (productMode !== 'multi_product') return todosOsIntents;
  return todosOsIntents.filter((i) => i !== 'product_view');
}

// Limite real de produtos por motor+modo — mesma fonte que a V1 já lê (`catalog.multiProductRules`,
// espelho de MULTI_PRODUCT_RULES do core). `regra` pode ser undefined (motor sem multipeça
// cadastrada no catálogo) — nunca inventa um intervalo.
export function limiteDeProdutos(productMode, regra) {
  if (productMode === 'single_product') return { min: 1, max: 1 };
  return { min: regra?.min ?? 2, max: regra?.max ?? 6 };
}

// Campos que o backend aceita de volta num `subjects[i]` (requests.js::SUBJECT_KEYS) — whitelist
// espelhada aqui de propósito: `planSummary()` devolve campos A MAIS só para EXIBIÇÃO (ex.:
// `product_name`) que o backend rejeita com "campo desconhecido" se voltarem no request. Nunca
// espalhar (`...s`) o objeto da prévia inteiro — só os campos que o backend realmente aceita.
const CAMPOS_SUBJECT_ACEITOS = ['id', 'role', 'persona', 'age_band', 'relation_to_primary', 'relation_label', 'wears_product_id', 'prominence'];

// Achado real do smoke G.2.1: o contrato do core aceita no máximo 4 `subjects` EXPLÍCITOS por request
// (contracts.py::MAX_SUBJECTS, espelhado em requests.js::MAX_SUBJECTS) — mesmo quando o PLANO em si (via
// `angle_family_hint`, sem `subjects`) já produziu 5 ou 6 pessoas de verdade para 5-6 produtos (people_needed
// == len(products) nos ângulos com pessoa). Reenviar as 5-6 linhas explícitas de "Quem veste o quê" nesse
// caso é recusado com "subjects: too many items". Nunca inventamos pessoas nem reduzimos produtos para
// contornar isso — a edição manual simplesmente não é oferecida acima do teto real do contrato.
export const MAX_SUBJECTS_EDITAVEIS = 4;

// "Quem veste o quê": aplica as edições humanas (subjectId -> wears_product_id | null) SOBRE os
// `subjects` que a prévia real devolveu — nunca reconstrói persona/role/relation do zero (isso viria
// do próprio plano, opaco). Sem NENHUMA edição, devolve `undefined` (o request não deve carregar
// `subjects` nenhum — o core decide sozinho, exatamente como no clique de 1 passo). Uma vez que há
// QUALQUER edição, TODAS as linhas voltam explícitas (nunca um mix "algumas explícitas, outras
// implícitas" que poderia ficar ambíguo de novo).
export function subjectsComOverride(subjectsDaPrevia, overrides) {
  if (!overrides || !Object.keys(overrides).length || !Array.isArray(subjectsDaPrevia) || !subjectsDaPrevia.length) {
    return undefined;
  }
  // Acima do teto real do contrato (ver comentário de MAX_SUBJECTS_EDITAVEIS): nunca monta um `subjects`
  // que o backend vai recusar. A tela não deve nem oferecer a edição nesse caso (ver GerarTabV2.tsx),
  // mas esta função também não confia só nisso — é a rede de segurança contra estado desatualizado.
  if (subjectsDaPrevia.length > MAX_SUBJECTS_EDITAVEIS) return undefined;
  return subjectsDaPrevia.map((s) => {
    const limpo = {};
    for (const campo of CAMPOS_SUBJECT_ACEITOS) {
      if (campo === 'wears_product_id') continue; // tratado abaixo — é o único campo em que `null` é um valor válido
      // Achado real do smoke visual G.2 (2ª rodada): ao contrário de `wears_product_id`, o contrato do
      // core (`contracts.py::RequestSubject`) NÃO marca `relation_to_primary`/`relation_label`/`age_band`
      // como `nullable` — o campo deve ficar AUSENTE quando não se aplica, nunca `null` explícito
      // ("must not be null"). `planSummary()` pode devolver esses campos como `null` (vindos do próprio
      // plano); nunca repassar esse `null` — omitir o campo em vez de copiá-lo.
      if (Object.prototype.hasOwnProperty.call(s, campo) && s[campo] !== null && s[campo] !== undefined) {
        limpo[campo] = s[campo];
      }
    }
    limpo.wears_product_id = Object.prototype.hasOwnProperty.call(overrides, s.id) ? overrides[s.id] : (s.wears_product_id ?? null);
    return limpo;
  });
}

// Estado de "quem veste o quê" a preservar ao trocar de motor: nenhum — a atribuição de peças é
// específica da CENA que o motor anterior calculou (layout, people_needed); o motor novo recalcula a
// sua própria a partir do zero (mesma regra de `textoAoTrocarDeMotor`, mesmo motivo).
export function overridesAoTrocarDeMotor() {
  return {};
}

// Achado real de uso (primeiro criativo, conta interna): os avisos do plano chegam como código técnico
// puro (ex. "geographic_context_unresolved_used_niche_context") — só o que o lojista de fato pediu para
// traduzir nesta rodada, sem virar um sistema geral de tradução de avisos. Um código sem tradução aqui
// volta cru (nunca escondido) — é sempre estritamente mais informativo que sumir com o aviso.
const TEXTO_AVISO = {
  geographic_context_unresolved_used_niche_context: 'Não foi possível resolver o contexto geográfico pedido — a cena usou o contexto do nicho como alternativa.',
  // Achado real (primeiro uso, conta interna, 24/09): distinto do aviso acima — aqui a cidade do
  // produto ESTÁ cadastrada, só não está no catálogo de contextos regionais. A cena usa um ambiente
  // neutro (nunca a paisagem de outro estado) — mensagem acionável: aponta o caminho manual que já
  // existe na tela (Personalizar → Ambiente → Geográfico) em vez de só descrever o problema.
  geographic_city_unrecognized_used_neutral_context: 'A cidade cadastrada no produto não está no catálogo de contextos regionais — a cena usou um ambiente neutro (nunca o cenário de outro estado). Para escolher um contexto específico, use "Personalizar" → Ambiente → Geográfico e informe a região manualmente.',
};
export function textoAviso(codigo) {
  return TEXTO_AVISO[codigo] || codigo;
}
