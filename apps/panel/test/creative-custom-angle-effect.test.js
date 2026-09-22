'use strict';

// Fase D.1 · o ângulo personalizado realmente chega ao pedido do core (não só o CRUD, testado em
// creative-angles.test.js). buildRequests resolve `custom_angle_id` do banco (checando "active"), monta o
// payload no formato que o core espera (CustomAngle — snake_case) e força `angle_id: "auto"`; um replay
// ("de novo"/"variação") repassa o CustomAngle inteiro sem tocar o banco, autossuficiente. `Copiar dados`
// devolve o mesmo ângulo. Duas definições diferentes de fato produzindo prompts diferentes é teste do CORE
// (apps/creative-generator/creative_core/tests/test_custom_angle.py) — aqui só a plumbing do painel.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { normalizeJobInput, buildRequests, InputError } = require('../lib/creative-core/requests');
const { createMemoryStore } = require('../lib/creative-core/memoryStore');
const { mapDraftToForm } = require('../lib/creative-core/draft');

const TENANT = 'a1000000-0000-4000-8000-000000000001';

async function semear(store) {
  const productId = crypto.randomUUID();
  await store.createProduct(TENANT, { id: productId, name: 'Camiseta', type: 'camiseta', references: [{ ref: 'x', mime: 'image/png', sizeBytes: 1 }], metadata: {} });
  const brandId = crypto.randomUUID();
  await store.createProfile('brand', TENANT, { id: brandId, data: { name: 'Marca' }, status: 'active' });
  return { productId, brandId };
}

const jobInput = (ids, extra = {}) => ({
  engine: 'CLEAN_ANGLES', product_mode: 'single_product', product_ids: [ids.productId], placements: ['FEED_4X5'],
  quantity: 1, brand: { source: 'profile', id: ids.brandId }, ...extra,
});

test('custom_angle_id: resolve do banco, monta o payload do core (snake_case) e força angle_id auto', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const angulo = await store.createAngle(TENANT, {
    slug: 'cafe-editorial', name: 'Café editorial', family: 'lifestyle', peopleMode: 'optional',
    definition: { framing: 'plano médio', lighting: 'luz natural lateral' },
    allowedInteractions: ['reading_together'], allowedProductModes: ['single_product'], defaultGaze: 'camera',
    createdBy: 'user-1',
  });
  const input = normalizeJobInput(jobInput(ids, { custom_angle_id: angulo.id }));
  assert.deepEqual(input.angle_ids, ['auto']);
  const [item] = await buildRequests(input, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 });
  assert.equal(item.request.angle_id, 'auto');
  assert.deepEqual(item.request.custom_angle, {
    id: angulo.id, scope: 'organization', organization_id: TENANT, store_id: null, slug: 'cafe-editorial',
    name: 'Café editorial', description: null, family: 'lifestyle', people_mode: 'optional', preset: null,
    definition: { framing: 'plano médio', lighting: 'luz natural lateral' },
    allowed_interactions: ['reading_together'], allowed_product_modes: ['single_product'], default_gaze: 'camera',
    active: true, version: 1, created_by: 'user-1', created_at: angulo.createdAt, updated_at: angulo.updatedAt,
  });
});

test('custom_angle_id inativo, inexistente, ou junto com custom_angle: recusado antes de enfileirar', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const angulo = await store.createAngle(TENANT, { slug: 'x', name: 'X', family: 'lifestyle', peopleMode: 'optional' });
  await store.archiveAngle(TENANT, angulo.id);

  const inativo = normalizeJobInput(jobInput(ids, { custom_angle_id: angulo.id }));
  await assert.rejects(
    buildRequests(inativo, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 }),
    (e) => e instanceof InputError && /desativado/.test(e.message),
  );

  const semAngulo = normalizeJobInput(jobInput(ids, { custom_angle_id: crypto.randomUUID() }));
  await assert.rejects(
    buildRequests(semAngulo, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 }),
    (e) => e instanceof InputError && /não encontrado/.test(e.message),
  );

  assert.throws(() => normalizeJobInput(jobInput(ids, { custom_angle_id: angulo.id, custom_angle: { id: 'x', family: 'lifestyle' } })), InputError);
});

test('sem plano v2, ângulo personalizado é recusado antes de enfileirar (não gera prompt contraditório)', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const angulo = await store.createAngle(TENANT, { slug: 'x', name: 'X', family: 'lifestyle', peopleMode: 'optional' });
  const input = normalizeJobInput(jobInput(ids, { custom_angle_id: angulo.id }));
  await assert.rejects(
    buildRequests(input, { store, tenantId: TENANT, hints: null, planSchemaVersion: 1 }),
    (e) => e instanceof InputError && /plano v2/.test(e.message),
  );
});

test('replay (custom_angle inteiro, como um draft manda): repassa sem tocar o banco, autossuficiente', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const historico = {
    id: 'deletado-faz-tempo', scope: 'organization', organization_id: TENANT, store_id: null, slug: 'sumiu',
    name: 'Ângulo que já foi apagado', description: null, family: 'connection', people_mode: 'required', preset: null,
    definition: { framing: 'plano aberto' }, allowed_interactions: null, allowed_product_modes: null, default_gaze: null,
    active: false, version: 3, created_by: null, created_at: 'x', updated_at: 'y',
  };
  const input = normalizeJobInput(jobInput(ids, { custom_angle: historico }));
  assert.deepEqual(input.angle_ids, ['auto']);
  const [item] = await buildRequests(input, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 });
  assert.deepEqual(item.request.custom_angle, historico, 'passa tal e qual — nenhuma consulta ao banco, "active" não importa');
});

test('formato inválido de custom_angle é recusado antes de qualquer consulta', async () => {
  const ids = { productId: crypto.randomUUID(), brandId: crypto.randomUUID() };
  assert.throws(() => normalizeJobInput(jobInput(ids, { custom_angle: { id: 'x' } })), InputError, 'sem family');
  assert.throws(() => normalizeJobInput(jobInput(ids, { custom_angle: 'nao-e-objeto' })), InputError);
});

// ------------------------------------------------------------------ Copiar dados recupera o ângulo (§6)
test('Copiar dados: o form carrega o custom_angle do draft, e angle_ids vira ["auto"]', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const customAngle = {
    id: '33333333-3333-4333-8333-333333333333', scope: 'store', organization_id: TENANT, store_id: 'loja-1',
    slug: 'promo-loja', name: 'Promo da loja', description: null, family: 'product_focus', people_mode: 'required',
    preset: 'fit_full_body', definition: { framing: 'corpo inteiro' }, allowed_interactions: null,
    allowed_product_modes: null, default_gaze: null, active: true, version: 2, created_by: null, created_at: 'x', updated_at: 'y',
  };
  const draft = {
    mode: 'creative', objective: 'clean_creative', strategy: 'CLEAN_ANGLES', product_mode: 'single_product',
    product_ids: [ids.productId], angle_id: 'CAIMENTO', custom_angle: customAngle, placement_id: 'FEED_4X5', quality: 'medium',
    brand_kit: { id: ids.brandId, version: 1 }, niche_kit: { id: 'fashion', version: 1 }, persona_mode: 'automatic',
    persona: null, subjects: [], interaction: null, scene_picks: null, context: { mode: 'automatic' }, funnel_stage: null,
    remarketing: null, funnel: null, copy: { generate: false }, gaze_mode: 'auto', plan_schema_version: 2, prompt_version: 2,
    seed: 42, plan_warnings: [], actions: { again: { seed: 42 }, variation: {} },
    carried: ['custom_angle'], source: { creative_id: 'c1', plan_id: 'p1', plan_schema_version: 2, compiler_version: 3 },
  };
  const { form } = await mapDraftToForm(draft, { store, tenantId: TENANT });
  assert.deepEqual(form.custom_angle, customAngle);
  assert.deepEqual(form.angle_ids, ['auto']);
  const input = normalizeJobInput({ ...form, ...draft.actions.again });
  const [item] = await buildRequests(input, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 });
  assert.deepEqual(item.request.custom_angle, customAngle);
  assert.equal(item.request.seed, 42);
});

test('sem custom_angle no draft (ângulo de sistema): form continua com angle_ids legado, como antes da D.1', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const draft = {
    mode: 'creative', objective: 'clean_creative', strategy: 'CLEAN_ANGLES', product_mode: 'single_product',
    product_ids: [ids.productId], angle_id: 'LIFESTYLE_COTIDIANO', placement_id: 'FEED_4X5', quality: 'medium',
    brand_kit: { id: ids.brandId, version: 1 }, niche_kit: { id: 'fashion', version: 1 }, persona_mode: 'automatic',
    persona: null, subjects: [], interaction: null, scene_picks: null, context: { mode: 'automatic' }, funnel_stage: null,
    remarketing: null, funnel: null, copy: { generate: false }, gaze_mode: 'auto', plan_schema_version: 1, prompt_version: 1,
    seed: null, plan_warnings: [], actions: { again: {}, variation: {} }, carried: [],
    source: { creative_id: 'c1', plan_id: 'p1', plan_schema_version: 1, compiler_version: null },
  };
  const { form } = await mapDraftToForm(draft, { store, tenantId: TENANT });
  assert.equal(form.custom_angle, undefined);
  assert.deepEqual(form.angle_ids, ['LIFESTYLE_COTIDIANO']);
});
