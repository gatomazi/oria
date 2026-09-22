'use strict';

// Fase D.1 · o ângulo personalizado realmente chega ao pedido do core (não só o CRUD, testado em
// creative-angles.test.js). buildRequests resolve `custom_angle_id` do banco (checando "active"), monta o
// payload no formato que o core espera (CustomAngle — snake_case) e força `angle_id: "auto"`. Duas
// definições diferentes de fato produzindo prompts diferentes é teste do CORE
// (apps/creative-generator/creative_core/tests/test_custom_angle.py) — aqui só a plumbing do painel.
//
// D.1.1 (auditoria do limite de confiança de `POST /jobs`): até aqui, um replay ("de novo"/"variação")
// mandava o CustomAngle INTEIRO no corpo do request e o servidor repassava sem checar nada — nem que o
// `organization_id`/`store_id` dentro do objeto fosse o de quem chamou, nem que `id`/`version`/`definition`
// correspondessem a algo que já existiu. Um cliente podia fabricar QUALQUER CustomAngle do zero (inclusive
// fingindo ser de outra Organization) e o core compilava o prompt a partir dele como se fosse um snapshot
// histórico autorizado. `custom_angle_replay_of` fecha isso: o cliente manda só o id do CRIATIVO ORIGINAL, e
// o servidor busca esse item com `store.getItem(tenantId, id)` — a MESMA consulta escopada ao tenant que
// "Copiar dados" usa — e lê o snapshot do PLANO PERSISTIDO. Nada que o navegador mande sobre o ângulo em si
// é usado como prova de autorização; a única coisa que decide é a quem pertence o criativo original.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { normalizeJobInput, buildRequests, InputError } = require('../lib/creative-core/requests');
const { createMemoryStore } = require('../lib/creative-core/memoryStore');
const { mapDraftToForm } = require('../lib/creative-core/draft');

const TENANT = 'a1000000-0000-4000-8000-000000000001';
const OUTRO_TENANT = 'a1000000-0000-4000-8000-000000000002';

async function semear(store, tenant = TENANT) {
  const productId = crypto.randomUUID();
  await store.createProduct(tenant, { id: productId, name: 'Camiseta', type: 'camiseta', references: [{ ref: 'x', mime: 'image/png', sizeBytes: 1 }], metadata: {} });
  const brandId = crypto.randomUUID();
  await store.createProfile('brand', tenant, { id: brandId, data: { name: 'Marca' }, status: 'active' });
  return { productId, brandId };
}

const jobInput = (ids, extra = {}) => ({
  engine: 'CLEAN_ANGLES', product_mode: 'single_product', product_ids: [ids.productId], placements: ['FEED_4X5'],
  quantity: 1, brand: { source: 'profile', id: ids.brandId }, ...extra,
});

const ANGULO_HISTORICO = {
  id: 'deletado-faz-tempo', scope: 'organization', organization_id: TENANT, store_id: null, slug: 'sumiu',
  name: 'Ângulo que já foi apagado', description: null, family: 'connection', people_mode: 'required', preset: null,
  definition: { framing: 'plano aberto' }, allowed_interactions: null, allowed_product_modes: null, default_gaze: null,
  active: false, version: 3, created_by: null, created_at: 'x', updated_at: 'y',
};

// Um criativo JÁ GERADO, com plano persistido usando um Custom Angle — é o que `custom_angle_replay_of`
// resolve contra. `angle_recommendation.custom_angle` é onde o core grava o snapshot no plano
// (creative_core/engines.py `plan_creative()`; `drafts.py` lê do mesmo caminho para "Copiar dados").
async function criativoComAngulo(store, { tenant = TENANT, ids, customAngle = ANGULO_HISTORICO, comPlano = true } = {}) {
  const creativeId = crypto.randomUUID();
  const job = await store.createJob(tenant, { id: crypto.randomUUID(), engine: 'CLEAN_ANGLES', productMode: 'single_product', input: { engine: 'CLEAN_ANGLES' } }, [{
    creativeId, itemIndex: 0, engine: 'CLEAN_ANGLES', productMode: 'single_product', productIds: [ids.productId], brandId: ids.brandId,
    angle: 'auto', placement: 'FEED_4X5', quality: 'medium', request: { creative_id: creativeId },
  }]);
  if (comPlano) {
    await store.updateItem(tenant, creativeId, {
      status: 'completed',
      plan: { plan_id: 'p-' + creativeId, angle_recommendation: customAngle ? { custom_angle: customAngle } : {} },
      planSummary: {},
    });
  }
  return { creativeId, jobId: job.id };
}

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

test('custom_angle_id inativo ou inexistente: recusado antes de enfileirar', async () => {
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

test('replay (custom_angle_replay_of): busca o snapshot no plano persistido, "active" não importa', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const { creativeId } = await criativoComAngulo(store, { ids }); // ANGULO_HISTORICO tem active: false
  const input = normalizeJobInput(jobInput(ids, { custom_angle_replay_of: creativeId }));
  assert.deepEqual(input.angle_ids, ['auto']);
  const [item] = await buildRequests(input, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 });
  assert.deepEqual(item.request.custom_angle, ANGULO_HISTORICO, 'lido do plano persistido — "active" não importa aqui');
});

// ---------------------------------------------------- D.1.1 · limite de confiança do replay (auditoria §2)
test('custom_angle_replay_of de OUTRO tenant: recusado — não vaza o ângulo nem confirma que o criativo existe', async () => {
  const store = createMemoryStore();
  const idsOutro = await semear(store, OUTRO_TENANT);
  const { creativeId } = await criativoComAngulo(store, { tenant: OUTRO_TENANT, ids: idsOutro });
  const ids = await semear(store); // produto/marca do tenant que está de fato chamando
  const input = normalizeJobInput(jobInput(ids, { custom_angle_replay_of: creativeId }));
  await assert.rejects(
    buildRequests(input, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 }),
    (e) => e instanceof InputError && /não encontrado/.test(e.message),
    'getItem é escopado ao tenant — de outro tenant, o criativo simplesmente não existe para esta busca',
  );
});

test('custom_angle_replay_of inexistente: recusado', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const input = normalizeJobInput(jobInput(ids, { custom_angle_replay_of: crypto.randomUUID() }));
  await assert.rejects(
    buildRequests(input, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 }),
    (e) => e instanceof InputError && /não encontrado/.test(e.message),
  );
});

test('custom_angle_replay_of de um criativo sem plano ainda: recusado', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const { creativeId } = await criativoComAngulo(store, { ids, comPlano: false });
  const input = normalizeJobInput(jobInput(ids, { custom_angle_replay_of: creativeId }));
  await assert.rejects(
    buildRequests(input, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 }),
    (e) => e instanceof InputError && /não tem plano/.test(e.message),
  );
});

test('custom_angle_replay_of de um criativo que não usou ângulo personalizado: recusado', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const { creativeId } = await criativoComAngulo(store, { ids, customAngle: null });
  const input = normalizeJobInput(jobInput(ids, { custom_angle_replay_of: creativeId }));
  await assert.rejects(
    buildRequests(input, { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 }),
    (e) => e instanceof InputError && /não usou um ângulo personalizado/.test(e.message),
  );
});

test('o objeto CustomAngle inteiro não é mais um campo aceito — o caminho antigo (sem verificação) está fechado', async () => {
  const ids = { productId: crypto.randomUUID(), brandId: crypto.randomUUID() };
  // Antes da D.1.1 isto era aceito e repassado ao core sem checar organization_id/store_id/version/active — a
  // adulteração de qualquer um desses campos passava. Agora `custom_angle` nem está na whitelist de entrada.
  assert.throws(() => normalizeJobInput(jobInput(ids, { custom_angle: ANGULO_HISTORICO })), (e) => e instanceof InputError && /campo desconhecido/.test(e.message));
});

test('custom_angle_replay_of: id em formato inválido é recusado antes de qualquer consulta', async () => {
  const ids = { productId: crypto.randomUUID(), brandId: crypto.randomUUID() };
  assert.throws(() => normalizeJobInput(jobInput(ids, { custom_angle_replay_of: 'nao-e-uuid' })), InputError);
});

test('custom_angle_id e custom_angle_replay_of juntos: recusado', async () => {
  const ids = { productId: crypto.randomUUID(), brandId: crypto.randomUUID() };
  assert.throws(
    () => normalizeJobInput(jobInput(ids, { custom_angle_id: crypto.randomUUID(), custom_angle_replay_of: crypto.randomUUID() })),
    InputError,
  );
});

// ------------------------------------------------------------------ Copiar dados recupera o ângulo (§6)
test('Copiar dados: o form traz custom_angle_preview (exibição) + custom_angle_replay_of (o que volta no POST), e angle_ids vira ["auto"]', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const customAngle = {
    id: '33333333-3333-4333-8333-333333333333', scope: 'store', organization_id: TENANT, store_id: 'loja-1',
    slug: 'promo-loja', name: 'Promo da loja', description: null, family: 'product_focus', people_mode: 'required',
    preset: 'fit_full_body', definition: { framing: 'corpo inteiro' }, allowed_interactions: null,
    allowed_product_modes: null, default_gaze: null, active: true, version: 2, created_by: null, created_at: 'x', updated_at: 'y',
  };
  const { creativeId } = await criativoComAngulo(store, { ids, customAngle });
  const draft = {
    mode: 'creative', objective: 'clean_creative', strategy: 'CLEAN_ANGLES', product_mode: 'single_product',
    product_ids: [ids.productId], angle_id: 'CAIMENTO', custom_angle: customAngle, placement_id: 'FEED_4X5', quality: 'medium',
    brand_kit: { id: ids.brandId, version: 1 }, niche_kit: { id: 'fashion', version: 1 }, persona_mode: 'automatic',
    persona: null, subjects: [], interaction: null, scene_picks: null, context: { mode: 'automatic' }, funnel_stage: null,
    remarketing: null, funnel: null, copy: { generate: false }, gaze_mode: 'auto', plan_schema_version: 2, prompt_version: 2,
    seed: 42, plan_warnings: [], actions: { again: { seed: 42 }, variation: {} },
    carried: ['custom_angle'], source: { creative_id: creativeId, plan_id: 'p1', plan_schema_version: 2, compiler_version: 3 },
  };
  const { form } = await mapDraftToForm(draft, { store, tenantId: TENANT });
  assert.deepEqual(form.custom_angle_preview, customAngle, 'só para a tela mostrar — nunca volta crua no POST /jobs');
  assert.equal(form.custom_angle, undefined, 'o campo antigo não existe mais no form');
  assert.equal(form.custom_angle_replay_of, creativeId);
  assert.deepEqual(form.angle_ids, ['auto']);
  // `custom_angle_preview` não está em INPUT_KEYS — se o cliente espalhar o form inteiro no POST, é rejeitado. A
  // ação real usa custom_angle_replay_of.
  assert.throws(() => normalizeJobInput({ ...form, ...draft.actions.again }), (e) => e instanceof InputError && /campo desconhecido/.test(e.message));
  const { custom_angle_preview, ...formParaEnviar } = form;
  const input = normalizeJobInput({ ...formParaEnviar, ...draft.actions.again });
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
  assert.equal(form.custom_angle_preview, undefined);
  assert.equal(form.custom_angle_replay_of, undefined);
  assert.deepEqual(form.angle_ids, ['LIFESTYLE_COTIDIANO']);
});
