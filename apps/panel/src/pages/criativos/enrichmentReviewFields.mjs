// Fase F.2.B.1 (§3 do brief) — lógica pura de seleção de campos, extraída de EnrichmentReview.tsx
// para poder ser testada diretamente com `node:test` (este repo não tem harness de teste de
// componente React/JSX — ver docs/features/creative-generator-fase-f2b1.md pelo motivo de isto ser a
// ponte mínima, e não uma dependência nova de tooling de teste). O componente importa exatamente
// estas funções; nada aqui é lógica duplicada entre o .tsx e o teste.
//
// Achado do piloto real (F.2.B, caso 1): `incompatible_auto_supporting_roles` (uma lista de EXCLUSÃO,
// não uma descrição positiva) chegava muito abrangente e era aceita por um único clique em "Aprovar
// sugestão" sem o lojista NUNCA ver seus valores — o resumo da tela só mencionava tema/interação. As
// funções abaixo garantem estruturalmente que isso não se repete, para qualquer proposta futura, sem
// depender de revisão manual da UI a cada nova fase.

export const CAMPOS_MESCLAVEIS = [
  'wearer_roles', 'relationship_themes', 'recommended_supporting_roles',
  'incompatible_auto_supporting_roles', 'scene_intents', 'visible_text',
];

// O único campo que representa uma EXCLUSÃO (negativa) em vez de uma descrição (positiva) do
// produto. Tratado à parte em todo o resto deste módulo.
export const CAMPO_EXCLUSAO = 'incompatible_auto_supporting_roles';

// Todos os campos mescláveis que a proposta realmente populou — a lista completa de "o que existe
// para revisar", usada para os checkboxes do modo Ajustar (onde CADA campo, exclusão incluída,
// aparece com seus valores reais, nunca escondido).
export function camposNaoVazios(proposed) {
  if (!proposed) return [];
  return CAMPOS_MESCLAVEIS.filter((campo) => Array.isArray(proposed[campo]) && proposed[campo].length > 0);
}

// Campos "positivos" (descritivos) populados — usados em DOIS lugares, deliberadamente com o mesmo
// resultado: (1) o conjunto que "Aprovar sugestão" (um clique, sem checkboxes) de fato aplica — a
// exclusão NUNCA entra nesse caminho rápido, só através do opt-in explícito abaixo; (2) o estado
// inicial dos checkboxes do modo Ajustar — a exclusão começa DESMARCADA, o lojista precisa marcá-la
// depois de ver os papéis reais que ela lista.
export function camposPositivos(proposed) {
  return camposNaoVazios(proposed).filter((campo) => campo !== CAMPO_EXCLUSAO);
}

export function temExclusaoProposta(proposed) {
  return camposNaoVazios(proposed).includes(CAMPO_EXCLUSAO);
}

// Módulo ESM puro de propósito — o componente .tsx importa normalmente via Vite; o teste
// `node:test` (CommonJS, ver test/creative-enrichment-review-fields.test.js) carrega isto com
// `await import(...)` dinâmico, que o Node resolve como ESM real independentemente de quem chama —
// nenhuma ponte CJS/ESM híbrida e frágil aqui.
