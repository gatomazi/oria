'use strict';

// "Copiar dados": traduz o GenerationDraft do core (montado do PLANO persistido) para o formulário do painel e diz o que
// não pôde vir. O core decide o que o plano guarda; aqui só se resolvem ids (produto, kits, persona, contexto) contra
// os registros VIVOS da Organization — arquivado ou apagado vira `unavailable`, nunca some em silêncio.
//
//   form      o que o gerador preenche (mesmas chaves do POST /jobs, sem semente/sorteios/olhar)
//   actions   "again" (mesma cena) e "variation" (nova cena) como remendos sobre o form, já no formato do POST /jobs
//   carried   nomes dos campos do plano que vieram (resumo "o que veio junto")
//   unavailable  [{ field, id, reason }] o que o plano usou e não existe mais
//   warnings  códigos de aviso do plano + avisos do painel
//
// Nada disto expõe idade, risco de pose, ids de relação, política de segurança, contexto semântico ou metadados do
// compiler: o draft não os tem, e este módulo só repassa o que o draft carrega.

const { UUID_RE } = require('./storage');

const PATCH_KEYS = ['seed', 'scene_picks', 'gaze_mode'];

// Remendo do core → só as chaves aceitas pelo POST /jobs, sem nulos e sem `gaze_mode: auto`.
function patchValido(patch) {
  const out = {};
  for (const key of PATCH_KEYS) {
    const value = patch && patch[key];
    if (value === null || value === undefined) continue;
    if (key === 'gaze_mode' && value === 'auto') continue;
    out[key] = value;
  }
  return out;
}

async function resolverKit(kind, ref, campo, { store, tenantId }, unavailable) {
  if (!ref || !ref.id) return undefined;
  if (!UUID_RE.test(ref.id)) return { source: 'builtin', id: ref.id };
  const row = await store.getProfile(kind, tenantId, ref.id);
  if (!row) {
    unavailable.push({ field: campo, id: ref.id, reason: 'missing_or_archived' });
    return undefined;
  }
  return { source: 'profile', id: ref.id };
}

async function mapDraftToForm(draft, { store, tenantId, jobInput = null }) {
  const unavailable = [];
  const ctx = { store, tenantId };

  const productIds = [];
  for (const id of draft.product_ids) {
    const produto = UUID_RE.test(id) ? await store.getProduct(tenantId, id) : null;
    if (!produto) unavailable.push({ field: 'product', id, reason: 'missing_or_archived' });
    else if (!(produto.references || []).length) unavailable.push({ field: 'product', id, reason: 'no_reference' });
    else productIds.push(id);
  }

  const form = {
    engine: draft.strategy,
    product_mode: draft.product_mode,
    product_ids: productIds,
    angle_ids: [draft.angle_id],
    placements: [draft.placement_id],
    quantity: 1,
    quality: draft.quality,
  };

  const brand = await resolverKit('brand', draft.brand_kit, 'brand', ctx, unavailable);
  if (brand) form.brand = brand;
  const niche = await resolverKit('niche', draft.niche_kit, 'niche', ctx, unavailable);
  if (niche) form.niche = niche;

  form.persona = { mode: 'automatic' };
  if (draft.persona_mode === 'custom' && draft.persona) {
    const id = draft.persona.id;
    if (UUID_RE.test(id || '') && await store.getProfile('persona', tenantId, id)) form.persona = { mode: 'custom', id };
    else unavailable.push({ field: 'persona', id: id || null, reason: 'missing_or_archived' });
  }

  const ctxDraft = draft.context || {};
  const ctxJob = jobInput && jobInput.context && typeof jobInput.context === 'object' ? jobInput.context : null;
  form.context = { mode: 'automatic' };
  if (ctxDraft.mode === 'custom') {
    if (UUID_RE.test(ctxDraft.context_id || '') && await store.getProfile('context', tenantId, ctxDraft.context_id)) {
      form.context = { mode: 'custom', profile_id: ctxDraft.context_id };
    } else {
      unavailable.push({ field: 'context', id: ctxDraft.context_id || null, reason: 'missing_or_archived' });
    }
  } else if (ctxDraft.mode === 'geographic') {
    // A cidade/estado é entrada do formulário, não fato do plano: vem do lote que gerou o criativo.
    if (ctxJob && ctxJob.mode === 'geographic' && ctxJob.subject) form.context = { ...ctxJob };
    else unavailable.push({ field: 'context', id: ctxDraft.context_id || null, reason: 'geographic_subject_unknown' });
  } else if (ctxJob && ['automatic', 'niche'].includes(ctxJob.mode)) {
    form.context = { mode: ctxJob.mode };
  } else {
    form.context = { mode: 'niche' };
  }

  if (draft.funnel_stage && draft.strategy === 'FUNNEL_VISUAL') form.funnel_stage = draft.funnel_stage;
  if (draft.funnel) form.funnel = draft.funnel;
  if (draft.remarketing) form.remarketing = draft.remarketing;
  if (draft.copy && typeof draft.copy.generate === 'boolean') form.copy = { generate: draft.copy.generate };

  // Escolhas humanas de cena. Ficam no form como o core as entregou: a UI mínima não as mostra, mas as devolve no POST
  // /jobs — copiar dados não perde pessoa, relação nem interação em silêncio.
  if (Array.isArray(draft.subjects) && draft.subjects.length) form.subjects = draft.subjects;
  if (draft.interaction) form.interaction = draft.interaction;
  // Ângulo personalizado (Fase D.1 + D.1.1): "de novo"/"variação" reproduzem o MESMO ângulo, não um recálculo pela
  // família — autossuficiente, como o plano que o gerou. `angle_ids` (legado, um id só) não se aplica mais nesse caso.
  //
  // `custom_angle_preview` é só para a TELA mostrar nome/família/definição (por isso não está em INPUT_KEYS de
  // requests.js — postar de volta é rejeitado como campo desconhecido). O que de fato volta no POST /jobs é
  // `custom_angle_replay_of`, o id DESTE criativo: o servidor busca o snapshot no plano persistido (nunca confia no
  // objeto que a tela devolveria) — é o mesmo id que `source.creative_id` já trazia para o histórico.
  if (draft.custom_angle) {
    form.custom_angle_preview = draft.custom_angle;
    if (draft.source && draft.source.creative_id) form.custom_angle_replay_of = draft.source.creative_id;
    form.angle_ids = ['auto'];
  }

  const actions = {
    again: patchValido(draft.actions && draft.actions.again),
    variation: patchValido(draft.actions && draft.actions.variation),
  };
  const warnings = Array.isArray(draft.plan_warnings) ? [...draft.plan_warnings] : [];
  return { form, actions, carried: [...(draft.carried || [])], unavailable, warnings };
}

module.exports = { mapDraftToForm, patchValido };
