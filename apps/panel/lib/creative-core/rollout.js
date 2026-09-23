'use strict';

// Rollout operacional do prompt V2 do Gerador (Fase A3). NÃO é feature comercial nem module capability:
// é o interruptor de um experimento de qualidade, por Organization, controlado por env do painel.
//
//   CREATIVE_PROMPT_V2_ORGS = "<organization_id>,<organization_id>"   só essas Organizations
//   CREATIVE_PROMPT_V2_ORGS = "*"                                     todas
//   (vazio/ausente)                                                    ninguém — o padrão
//
// Fora da lista o painel NÃO manda `prompt_version` e o serviço usa o padrão dele (V1, salvo
// CREATIVE_PROMPT_VERSION no serviço). O valor escolhido fica no `request` persistido de cada geração,
// então uma tentativa (e um retry) sempre reproduz o prompt com que foi planejada.

const ID_RE = /^[a-z0-9_-]{1,64}$/;

function orgsComPromptV2(envValue) {
  return new Set(String(envValue || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s === '*' || ID_RE.test(s)));
}

// 2 quando a Organization está na lista; `undefined` caso contrário (não manda o campo).
function promptVersionFor(env, tenantId) {
  const orgs = orgsComPromptV2(env && env.CREATIVE_PROMPT_V2_ORGS);
  return orgs.has('*') || orgs.has(String(tenantId || '').toLowerCase()) ? 2 : undefined;
}

// Fase B — mesmo mecanismo para o CreativePlan v2 (compiler novo). CREATIVE_PLAN_V2_ORGS = ids de Organization ou `*`.
// Independente do prompt v2: uma coisa é a estrutura do plano/compiler, outra é a redação da cena.
function planSchemaVersionFor(env, tenantId) {
  const orgs = orgsComPromptV2(env && env.CREATIVE_PLAN_V2_ORGS);
  return orgs.has('*') || orgs.has(String(tenantId || '').toLowerCase()) ? 2 : undefined;
}

// Fase E — a UI V2 do gerador (fluxo simples, recomendação, famílias de ângulo). Mesmo mecanismo: rollout
// operacional por Organization, nunca comercial, nunca automático. CREATIVE_UI_V2_ORGS = ids de Organization
// ou `*`. Implementação só local nesta rodada — nenhuma conta fora da lista vê nada diferente do V1; a conta
// que está na lista continua com o V1 completo disponível (a UI V2 é um caminho novo, não uma substituição).
function uiV2For(env, tenantId) {
  const orgs = orgsComPromptV2(env && env.CREATIVE_UI_V2_ORGS);
  return orgs.has('*') || orgs.has(String(tenantId || '').toLowerCase());
}

// Fase F.1 — Product Enrichment (propostas de semantic_context; nunca aplicadas automaticamente).
// CREATIVE_ENRICHMENT_ORGS = ids de Organization ou `*`, mesmo mecanismo — nunca comercial, sem provider
// pago nesta fase (só "fake"). Fora da lista, as rotas de /products/:id/enrichment/* respondem 403, como
// se não existissem.
function enrichmentFor(env, tenantId) {
  const orgs = orgsComPromptV2(env && env.CREATIVE_ENRICHMENT_ORGS);
  return orgs.has('*') || orgs.has(String(tenantId || '').toLowerCase());
}

module.exports = { promptVersionFor, planSchemaVersionFor, uiV2For, enrichmentFor, orgsComPromptV2 };
