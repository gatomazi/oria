'use strict';

// Fase C · Gostei / Não gostei, Copiar dados e a composição de cena nos pedidos do painel.
// Store em memória e core falso: nada de Postgres, do serviço Python nem de OpenAI. O core falso devolve saídas REAIS do
// core (test/fixtures/creative-fase-c.json, geradas por apps/creative-generator/scripts/render_fase_c_examples.py), para
// os testes não adivinharem o formato do plano, do draft e do snapshot. O contrato contra Postgres está em
// creative-feedback-pg.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { normalizeJobInput, buildRequests, InputError } = require('../lib/creative-core/requests');
const { createMemoryStore } = require('../lib/creative-core/memoryStore');
const { mapDraftToForm, patchValido } = require('../lib/creative-core/draft');
const { criarRouterCriativos } = require('../routes/criativos');
const FASE_C = require('./fixtures/creative-fase-c.json');

const TENANT = 'a1000000-0000-4000-8000-000000000001';
const OUTRO_TENANT = 'a1000000-0000-4000-8000-000000000002';
const PESSOA_A = 'b1000000-0000-4000-8000-00000000000a';
const PESSOA_B = 'b1000000-0000-4000-8000-00000000000b';
const STORE = 'c1000000-0000-4000-8000-000000000001';
const TOKEN = 't'.repeat(40);
const silencioso = { log() {}, error() {} };
const clone = (v) => JSON.parse(JSON.stringify(v));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'criativos-fb-'));
}

// Ids de registros do painel. O plano/draft do core usam ids de teste do fixture; aqui viram UUIDs reais do store.
async function semear(store, tenant = TENANT) {
  const productId = crypto.randomUUID();
  await store.createProduct(tenant, { id: productId, name: 'Pipa Menina', type: 'camiseta infantil', references: [{ ref: 'products/x/1.png', mime: 'image/png', sizeBytes: 10 }], metadata: {} });
  const brandId = crypto.randomUUID();
  await store.createProfile('brand', tenant, { id: brandId, data: { name: 'Marca X' }, status: 'active' });
  const personaId = crypto.randomUUID();
  await store.createProfile('persona', tenant, { id: personaId, data: { label: 'menina 7 anos' }, status: 'active' });
  const contextId = crypto.randomUUID();
  await store.createProfile('context', tenant, { id: contextId, data: { scene: 'sala' }, status: 'approved' });
  return { productId, brandId, personaId, contextId };
}

// O plano e o draft do caso A do core, com os ids trocados pelos registros semeados.
function planoDoCaso(letra, ids) {
  const plan = clone(FASE_C[letra].plan);
  plan.products[0].id = ids.productId;
  plan.subjects.forEach((s) => { if (s.product_id) s.product_id = ids.productId; });
  return plan;
}
function draftDoCaso(letra, ids, mudar = (d) => d) {
  const draft = clone(FASE_C[letra].draft);
  draft.product_ids = [ids.productId];
  draft.subjects.forEach((s) => { if (s.wears_product_id) s.wears_product_id = ids.productId; });
  draft.brand_kit = { id: ids.brandId, version: 1 };
  draft.persona_mode = 'custom';
  draft.persona = { label: 'menina 7 anos', id: ids.personaId, source: 'custom' };
  draft.context = { mode: 'custom', context_id: ids.contextId, provider: 'custom', scene: 'sala' };
  return mudar(draft);
}

function fakeCore({ letra = 'A', ids, mudarDraft } = {}) {
  const calls = { plan: [], draft: [], snapshot: [] };
  return {
    calls,
    configured: true,
    async health() { return { status: 'ok' }; },
    async contracts() { return { product_modes: [], multi_product_rules: {}, compatibility_matrix: [], catalog: { angles: [] }, versions: {} }; },
    async validate() { return { valid: true, errors: [] }; },
    async plan(request) {
      calls.plan.push(request);
      return { plan_id: 'p', creative_id: request.creative_id, strategy: request.strategy, product_mode: request.product_mode, products: request.products,
        angle: { id: request.angle_id, label: request.angle_id }, placement: { id: request.placement_id }, persona: null, context: {}, prompt: { text: 'PROMPT INTERNO SECRETO', sha256: 'x', prompt_version: 2 },
        model: { model: 'gpt-image-2', quality: 'medium', size: '1088x1360' }, references: [], validations: [], warnings: [], versions: {}, schema_version: 2 };
    },
    async draft(plan) { calls.draft.push(plan); return draftDoCaso(letra, ids, mudarDraft); },
    async feedbackSnapshot(args) { calls.snapshot.push(args); return clone(FASE_C[letra].snapshot); },
    async generate() { throw new Error('não deve gerar'); },
    async copies() { return []; },
  };
}

// Um lote com um criativo concluído e com plano, direto no store (o worker não é o assunto aqui).
async function criativoConcluido(store, ids, { letra = 'A', status = 'completed', comPlano = true, tenant = TENANT, jobInput } = {}) {
  const creativeId = crypto.randomUUID();
  const input = jobInput || { engine: 'CLEAN_ANGLES', context: { mode: 'automatic' } };
  const job = await store.createJob(tenant, { id: crypto.randomUUID(), engine: 'CLEAN_ANGLES', productMode: 'single_product', input }, [{
    creativeId, itemIndex: 0, engine: 'CLEAN_ANGLES', productMode: 'single_product', productIds: [ids.productId], brandId: ids.brandId,
    angle: 'LIFESTYLE_COTIDIANO', placement: 'FEED_4X5', quality: 'medium', request: { creative_id: creativeId },
  }]);
  await store.updateItem(tenant, creativeId, {
    status, ...(comPlano ? { plan: planoDoCaso(letra, ids), planSummary: { scene: 'sala' } } : {}),
    generationTrace: { 1: { attempt: 1, model_served: 'gpt-image-2' } },
  });
  if (status === 'completed') {
    await store.insertAsset(tenant, { id: crypto.randomUUID(), creativeId, storageKey: 'creatives/a/image.png', mime: 'image/png', byteSize: 10, sha256: 'ab'.repeat(32) });
  }
  return { creativeId, jobId: job.id };
}

async function subirApp({ store = createMemoryStore(), core, env = {}, tenant = { atual: TENANT }, storeAtual = () => null } = {}) {
  const app = express();
  app.use(express.json());
  // A pessoa vem do cookie de teste; em produção é req.auth.userId da sessão.
  const requireAdmin = (req, res, next) => {
    const cookie = req.headers.cookie || '';
    if (!cookie.includes('admin=1')) return res.status(401).json({ error: 'não autenticado' });
    const pessoa = /user=([\w-]+)/.exec(cookie);
    req.auth = pessoa ? { userId: pessoa[1] } : {};
    return next();
  };
  const modulo = criarRouterCriativos({
    requireAdmin, tenantAtual: () => tenant.atual, paraCadaTenant: (fn) => fn(tenant.atual), pgPool: null, store, core, uploadsDir: tmpDir(),
    lerEntitlements: async () => ({}), encriptarSegredo: (t) => t, descriptografarSegredo: (t) => t, storeAtual,
    env: { CREATIVE_FEATURE_FLAGS: 'creative_generator,creative_clean_angles', ...env }, logger: silencioso,
  });
  app.use('/api/admin/criativos', modulo.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/admin/criativos`;
  const call = async (method, p, body, pessoa = PESSOA_A) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', cookie: pessoa ? `admin=1; user=${pessoa}` : 'admin=1' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, call, store, core };
}

const ambiente = async (opcoes = {}) => {
  const store = opcoes.store || createMemoryStore();
  const ids = await semear(store);
  const core = fakeCore({ ids, ...opcoes });
  const app = await subirApp({ ...opcoes, store, core });
  return { ...app, ids };
};

// ── pedidos: composição de cena e reprodução ─────────────────────────────────────────────────────────────────────

const base = (ids, extra = {}) => ({
  engine: 'CLEAN_ANGLES', product_mode: 'single_product', product_ids: [ids.productId], angle_ids: ['LIFESTYLE_COTIDIANO'], placements: ['FEED_4X5'],
  quantity: 1, brand: { source: 'builtin', id: 'entre_nos_ab' }, ...extra,
});
const PESSOAS = (ids) => [
  { id: 's1', role: 'primary', persona: { label: 'menina 7 anos' }, age_band: 'child_6_9', wears_product_id: ids.productId },
  { id: 's2', role: 'supporting', persona: { label: 'homem 35 anos' }, age_band: 'adult', relation_to_primary: 'father', wears_product_id: null },
];

test('pedido aceita pessoas, interação, olhar, semente e sorteios, só no formato certo', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const ok = normalizeJobInput(base(ids, { subjects: PESSOAS(ids), interaction: 'playing', gaze_mode: 'interaction', seed: 42, scene_picks: { acao: 1 } }));
  assert.equal(ok.subjects.length, 2);
  assert.deepEqual([ok.interaction, ok.gaze_mode, ok.seed, ok.scene_picks], ['playing', 'interaction', 42, { acao: 1 }]);
  const recusa = (extra, re) => assert.throws(() => normalizeJobInput(base(ids, extra)), (e) => e instanceof InputError && re.test(e.message));
  recusa({ subjects: [] }, /de 1 a 4/);
  recusa({ subjects: [1, 2, 3, 4, 5].map((n) => ({ persona: { label: `p${n}` } })) }, /de 1 a 4/);
  recusa({ subjects: [{ persona: { label: 'x' }, pose_risk: 'high' }] }, /campo desconhecido: pose_risk/);
  recusa({ subjects: [{ role: 'primary' }] }, /descreva cada pessoa/);
  recusa({ subjects: [{ persona: { label: 'x' }, wears_product_id: crypto.randomUUID() }] }, /produto vestido/);
  recusa({ subjects: [{ persona: { label: 'x'.repeat(9000) } }] }, /grande demais/);
  recusa({ interaction: 'Playing!' }, /interação inválida/);
  recusa({ gaze_mode: 'para_cima' }, /olhar inválido/);
  recusa({ seed: -1 }, /semente inválida/);
  recusa({ seed: 1.5 }, /semente inválida/);
  recusa({ scene_picks: { acao: 'a' } }, /sorteios/);
  recusa({ scene_picks: { 'Ação': 1 } }, /sorteios/);
  recusa({ seed: 1, quantity: 2 }, /único criativo/);
  recusa({ scene_picks: { acao: 1 }, angle_ids: ['CAIMENTO', 'LIFESTYLE_COTIDIANO'] }, /único criativo/);
});

test('pedido leva pessoas e interação ao request; semente informada vale, e sem ela é sorteada', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const opcoes = { store, tenantId: TENANT, hints: null, promptVersion: 2, planSchemaVersion: 2 };
  const [item] = await buildRequests(normalizeJobInput(base(ids, { subjects: PESSOAS(ids), interaction: 'playing', gaze_mode: 'interaction', seed: 42, scene_picks: { acao: 1 } })), opcoes);
  assert.deepEqual([item.request.seed, item.request.scene_picks, item.request.interaction, item.request.gaze_mode], [42, { acao: 1 }, 'playing', 'interaction']);
  assert.equal(item.request.subjects[1].relation_to_primary, 'father');
  const [novo] = await buildRequests(normalizeJobInput(base(ids, { subjects: PESSOAS(ids) })), { ...opcoes, randomInt: () => 777 });
  assert.equal(novo.request.seed, 777);
  assert.equal(novo.request.scene_picks, undefined);
  const [auto] = await buildRequests(normalizeJobInput(base(ids, { gaze_mode: 'auto' })), opcoes);
  assert.equal(auto.request.gaze_mode, undefined, 'olhar auto é o padrão: não vai no request');
});

test('sem plano v2 (ou sem prompt v2 para os sorteios) o pedido é recusado em português, antes de enfileirar', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const opcoes = { store, tenantId: TENANT, hints: null };
  await assert.rejects(buildRequests(normalizeJobInput(base(ids, { subjects: PESSOAS(ids) })), { ...opcoes, promptVersion: 2 }), /plano v2/);
  await assert.rejects(buildRequests(normalizeJobInput(base(ids, { interaction: 'playing' })), { ...opcoes, planSchemaVersion: 1 }), /plano v2/);
  await assert.rejects(buildRequests(normalizeJobInput(base(ids, { scene_picks: { acao: 1 } })), { ...opcoes, planSchemaVersion: 2 }), /prompt v2/);
  const [legado] = await buildRequests(normalizeJobInput(base(ids)), opcoes);
  assert.equal(legado.request.subjects, undefined, 'lote sem composição continua igual ao de antes');
});

// ── Gostei / Não gostei ──────────────────────────────────────────────────────────────────────────────────────────

test('Gostei grava o snapshot do CORE e trocar o veredito é upsert, não duplicata', async () => {
  const { server, call, store, core, ids } = await ambiente();
  try {
    const { creativeId } = await criativoConcluido(store, ids);
    const gostei = await call('PUT', `/items/${creativeId}/feedback`, { verdict: 'liked' });
    assert.equal(gostei.status, 200);
    assert.deepEqual([gostei.body.creativeId, gostei.body.verdict], [creativeId, 'liked']);
    assert.equal(core.calls.snapshot.length, 1, 'o snapshot é calculado pelo core');
    assert.deepEqual(core.calls.snapshot[0].plan, planoDoCaso('A', ids), 'a partir do plano persistido, não da tela');
    assert.equal(core.calls.snapshot[0].assetSha256, 'ab'.repeat(32));
    assert.deepEqual(core.calls.snapshot[0].resultMetadata, { trace: { attempt: 1, model_served: 'gpt-image-2' } });
    const linha = await store.getFeedback(TENANT, PESSOA_A, creativeId);
    assert.deepEqual(linha.snapshot, FASE_C.A.snapshot, 'o Node não recalcula nem altera o snapshot');
    assert.deepEqual([linha.verdict, linha.storeId], ['liked', null], 'sem Store no contexto o feedback é compartilhado');

    const trocou = await call('PUT', `/items/${creativeId}/feedback`, { verdict: 'disliked' });
    assert.equal(trocou.body.verdict, 'disliked');
    assert.equal((await store.getFeedback(TENANT, PESSOA_A, creativeId)).verdict, 'disliked');
    const resumo = await store.feedbackSummary(TENANT, { by: 'angle' });
    assert.deepEqual(resumo, [{ key: FASE_C.A.snapshot.angle, liked: 0, disliked: 1, total: 1 }], 'uma linha por pessoa e criativo');
  } finally { server.close(); }
});

test('limpar apaga o veredito só desta pessoa, e é idempotente', async () => {
  const { server, call, store, ids } = await ambiente();
  try {
    const { creativeId } = await criativoConcluido(store, ids);
    await call('PUT', `/items/${creativeId}/feedback`, { verdict: 'liked' }, PESSOA_A);
    await call('PUT', `/items/${creativeId}/feedback`, { verdict: 'disliked' }, PESSOA_B);
    const limpou = await call('DELETE', `/items/${creativeId}/feedback`, undefined, PESSOA_A);
    assert.deepEqual([limpou.status, limpou.body.verdict], [200, null]);
    assert.equal(await store.getFeedback(TENANT, PESSOA_A, creativeId), null);
    assert.equal((await store.getFeedback(TENANT, PESSOA_B, creativeId)).verdict, 'disliked', 'o veredito de outra pessoa fica');
    assert.equal((await call('DELETE', `/items/${creativeId}/feedback`, undefined, PESSOA_A)).status, 200, 'limpar de novo não é erro');
  } finally { server.close(); }
});

test('histórico e lote trazem o veredito de QUEM está logado, nunca o de outra pessoa', async () => {
  const { server, call, store, ids } = await ambiente();
  try {
    const um = await criativoConcluido(store, ids);
    const dois = await criativoConcluido(store, ids);
    await call('PUT', `/items/${um.creativeId}/feedback`, { verdict: 'liked' }, PESSOA_A);
    await call('PUT', `/items/${dois.creativeId}/feedback`, { verdict: 'disliked' }, PESSOA_B);
    const historicoA = (await call('GET', '/history', undefined, PESSOA_A)).body.items;
    const veredito = (lista, id) => (lista.find((i) => i.creativeId === id) || {}).feedback;
    assert.equal(veredito(historicoA, um.creativeId).verdict, 'liked');
    assert.equal(veredito(historicoA, dois.creativeId), null, 'o Não gostei da pessoa B não aparece para A');
    const historicoB = (await call('GET', '/history', undefined, PESSOA_B)).body.items;
    assert.deepEqual([veredito(historicoB, um.creativeId), veredito(historicoB, dois.creativeId).verdict], [null, 'disliked']);
    const lote = (await call('GET', `/jobs/${um.jobId}`, undefined, PESSOA_A)).body;
    assert.equal(lote.items[0].feedback.verdict, 'liked');
    assert.ok(!JSON.stringify(historicoA).includes(PESSOA_B), 'nenhum id de outra pessoa na resposta');
  } finally { server.close(); }
});

test('feedback recusa veredito inventado, campos extras, criativo sem plano, não concluído, inexistente e sessão sem pessoa', async () => {
  const { server, call, store, ids } = await ambiente();
  try {
    const { creativeId } = await criativoConcluido(store, ids);
    assert.equal((await call('PUT', `/items/${creativeId}/feedback`, { verdict: 'meh' })).status, 400);
    assert.equal((await call('PUT', `/items/${creativeId}/feedback`, { verdict: 'liked', user_id: PESSOA_B })).status, 400, 'a pessoa nunca vem do corpo');
    assert.equal((await call('PUT', '/items/nao-e-uuid/feedback', { verdict: 'liked' })).status, 400);
    assert.equal((await call('PUT', `/items/${crypto.randomUUID()}/feedback`, { verdict: 'liked' })).status, 404);
    const semPlano = await criativoConcluido(store, ids, { comPlano: false });
    assert.equal((await call('PUT', `/items/${semPlano.creativeId}/feedback`, { verdict: 'liked' })).status, 409);
    const falhou = await criativoConcluido(store, ids, { status: 'failed' });
    assert.equal((await call('PUT', `/items/${falhou.creativeId}/feedback`, { verdict: 'liked' })).status, 409);
    assert.equal((await call('PUT', `/items/${creativeId}/feedback`, { verdict: 'liked' }, null)).status, 403, 'sem pessoa na sessão');
    assert.equal(await store.getFeedback(TENANT, PESSOA_A, creativeId), null, 'nada foi gravado');
  } finally { server.close(); }
});

test('isolamento: criativo de outra Organization é 404 e o veredito não atravessa', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const idsOutro = await semear(store, OUTRO_TENANT);
  const tenant = { atual: TENANT };
  const { server, call } = await subirApp({ store, tenant, core: fakeCore({ ids }) });
  try {
    const dele = await criativoConcluido(store, idsOutro, { tenant: OUTRO_TENANT });
    const meu = await criativoConcluido(store, ids);
    assert.equal((await call('PUT', `/items/${dele.creativeId}/feedback`, { verdict: 'liked' })).status, 404);
    assert.equal((await call('GET', `/items/${dele.creativeId}/draft`)).status, 404);
    await call('PUT', `/items/${meu.creativeId}/feedback`, { verdict: 'liked' });
    tenant.atual = OUTRO_TENANT;
    assert.deepEqual((await call('GET', '/feedback/summary?by=angle')).body.items, [], 'a outra Organization não vê o meu');
    assert.equal(await store.getFeedback(OUTRO_TENANT, PESSOA_A, meu.creativeId), null);
    assert.equal(await store.deleteFeedback(OUTRO_TENANT, PESSOA_A, meu.creativeId), false, 'e não apaga');
    tenant.atual = TENANT;
    assert.equal((await store.getFeedback(TENANT, PESSOA_A, meu.creativeId)).verdict, 'liked');
  } finally { server.close(); }
});

test('Store: com Store no contexto o feedback fica nela; sem Store, é compartilhado e conta para todas', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  let storeDoContexto = STORE;
  const { server, call } = await subirApp({ store, core: fakeCore({ ids }), storeAtual: () => storeDoContexto });
  try {
    const na = await criativoConcluido(store, ids);
    const compartilhado = await criativoConcluido(store, ids);
    await call('PUT', `/items/${na.creativeId}/feedback`, { verdict: 'liked' });
    storeDoContexto = null;
    await call('PUT', `/items/${compartilhado.creativeId}/feedback`, { verdict: 'disliked' });
    assert.equal((await store.getFeedback(TENANT, PESSOA_A, na.creativeId)).storeId, STORE);
    assert.equal((await store.getFeedback(TENANT, PESSOA_A, compartilhado.creativeId)).storeId, null);
    const daStore = await store.feedbackSummary(TENANT, { by: 'angle', storeId: STORE });
    assert.equal(daStore[0].total, 2, 'a Store enxerga o dela + o compartilhado');
    const outraStore = await store.feedbackSummary(TENANT, { by: 'angle', storeId: 'c1000000-0000-4000-8000-0000000000ff' });
    assert.equal(outraStore[0].total, 1, 'outra Store enxerga só o compartilhado');
  } finally { server.close(); }
});

test('consulta de aprovação por ângulo, objetivo, contexto, interação, composição e produto', async () => {
  const { server, call, store, ids } = await ambiente();
  try {
    const um = await criativoConcluido(store, ids);
    const dois = await criativoConcluido(store, ids);
    await call('PUT', `/items/${um.creativeId}/feedback`, { verdict: 'liked' }, PESSOA_A);
    await call('PUT', `/items/${dois.creativeId}/feedback`, { verdict: 'liked' }, PESSOA_A);
    await call('PUT', `/items/${dois.creativeId}/feedback`, { verdict: 'disliked' }, PESSOA_B);
    const s = FASE_C.A.snapshot;
    const esperado = { angle: s.angle, objective: s.objective, context: s.context.context_id, interaction: s.interaction, composition: s.composition_key, product: s.product_ids[0] };
    for (const [by, chave] of Object.entries(esperado)) {
      const r = await call('GET', `/feedback/summary?by=${by}`);
      assert.equal(r.status, 200, by);
      assert.deepEqual(r.body.items, [{ key: chave, liked: 3 - 1, disliked: 1, total: 3 }], by);
      assert.equal(r.body.scope, 'organization', 'sem Store resolvida a consulta é da Organization');
    }
    assert.equal((await call('GET', '/feedback/summary?by=user_id')).status, 400);
    assert.equal((await call('GET', '/feedback/summary')).status, 400);
    assert.equal((await call('GET', '/feedback/summary?by=angle&scope=global')).status, 400);
    assert.ok(!JSON.stringify((await call('GET', '/feedback/summary?by=angle')).body).includes(PESSOA_A), 'a consulta não expõe quem votou');
  } finally { server.close(); }
});

// ── Copiar dados ─────────────────────────────────────────────────────────────────────────────────────────────────

const V2 = { CREATIVE_PLAN_V2_ORGS: TENANT, CREATIVE_PROMPT_V2_ORGS: TENANT };

test('Copiar dados devolve o formulário, "de novo" e "variação" prontos, e o draft inteiro', async () => {
  const { server, call, store, core, ids } = await ambiente({ env: V2 });
  try {
    const { creativeId, jobId } = await criativoConcluido(store, ids);
    const r = await call('GET', `/items/${creativeId}/draft`);
    assert.equal(r.status, 200);
    assert.deepEqual(core.calls.draft[0], planoDoCaso('A', ids), 'o draft sai do plano persistido');
    const { form, actions, carried, unavailable, warnings, draft } = r.body;
    assert.deepEqual([r.body.creativeId, r.body.jobId], [creativeId, jobId]);
    assert.deepEqual(unavailable, []);
    assert.deepEqual([form.engine, form.product_ids, form.angle_ids, form.placements, form.quantity], ['CLEAN_ANGLES', [ids.productId], ['LIFESTYLE_COTIDIANO'], ['FEED_4X5'], 1]);
    assert.deepEqual([form.brand, form.persona, form.context], [{ source: 'profile', id: ids.brandId }, { mode: 'custom', id: ids.personaId }, { mode: 'custom', profile_id: ids.contextId }]);
    assert.equal(form.subjects.length, 2);
    assert.equal(form.subjects[1].relation_to_primary, 'father');
    assert.equal(form.interaction, 'playing');
    assert.equal(form.seed, undefined, 'semente, sorteios e olhar só vêm pela ação escolhida');
    assert.deepEqual(actions.again.seed, FASE_C.A.draft.seed);
    assert.equal(actions.again.scene_picks, undefined, 'cena de composição (frame) não tem sorteios a repetir');
    assert.equal(actions.again.gaze_mode, 'interaction');
    assert.deepEqual(actions.variation, {}, 'variação larga a semente, os sorteios e o olhar que o planner escolheu');
    assert.ok(carried.includes('subjects') && carried.includes('interaction') && carried.includes('seed') && !carried.includes('scene_picks'));
    assert.deepEqual(warnings, FASE_C.A.draft.plan_warnings);
    assert.deepEqual(draft.subjects, form.subjects, 'o draft do core vem inteiro, sem perda');
    const texto = JSON.stringify(r.body);
    assert.ok(!texto.includes(planoDoCaso('A', ids).prompt.text.slice(0, 40)), 'o texto do prompt não sai');
    for (const proibido of ['pose_risk', 'minor_source', 'minor_safety', 'semantic_context', 'age_source', 'provenance']) assert.ok(!texto.includes(proibido), `${proibido} não sai no draft`);
  } finally { server.close(); }
});

test('"Gerar de novo" e "Gerar variação" viram pedidos: mesma cena x nova cena, com as escolhas humanas nos dois', async () => {
  const { server, call, store, ids } = await ambiente({ env: V2 });
  try {
    const { creativeId } = await criativoConcluido(store, ids);
    const { form, actions } = (await call('GET', `/items/${creativeId}/draft`)).body;
    const opcoes = { store, tenantId: TENANT, hints: null, promptVersion: 2, planSchemaVersion: 2 };
    const [de_novo] = await buildRequests(normalizeJobInput({ ...form, ...actions.again }), opcoes);
    assert.equal(de_novo.request.seed, FASE_C.A.draft.seed);
    assert.equal(de_novo.request.scene_picks, undefined);
    assert.equal(de_novo.request.gaze_mode, 'interaction');
    const [variacao] = await buildRequests(normalizeJobInput({ ...form, ...actions.variation }), { ...opcoes, randomInt: () => 4242 });
    assert.equal(variacao.request.seed, 4242, 'semente nova');
    assert.equal(variacao.request.scene_picks, undefined);
    assert.equal(variacao.request.gaze_mode, undefined);
    for (const item of [de_novo, variacao]) {
      assert.equal(item.request.interaction, 'playing');
      assert.deepEqual(item.request.subjects.map((s) => s.relation_to_primary || null), [null, 'father']);
      assert.deepEqual([item.request.angle_id, item.request.placement_id, item.productIds], ['LIFESTYLE_COTIDIANO', 'FEED_4X5', [ids.productId]]);
      assert.deepEqual(item.request.products.map((p) => p.id), [ids.productId]);
    }
  } finally { server.close(); }
});

test('Copiar dados diz o que não existe mais (produto, persona, contexto, marca arquivados) e não some com nada', async () => {
  const { server, call, store, ids } = await ambiente({ env: V2 });
  try {
    const { creativeId } = await criativoConcluido(store, ids);
    await store.archiveProduct(TENANT, ids.productId);
    await store.archiveProfile('persona', TENANT, ids.personaId);
    await store.archiveProfile('context', TENANT, ids.contextId);
    await store.archiveProfile('brand', TENANT, ids.brandId);
    const r = await call('GET', `/items/${creativeId}/draft`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.unavailable.map((u) => [u.field, u.id, u.reason]), [
      ['product', ids.productId, 'missing_or_archived'], ['brand', ids.brandId, 'missing_or_archived'],
      ['persona', ids.personaId, 'missing_or_archived'], ['context', ids.contextId, 'missing_or_archived'],
    ]);
    assert.deepEqual(r.body.form.product_ids, []);
    assert.equal(r.body.form.brand, undefined);
    assert.deepEqual([r.body.form.persona, r.body.form.context], [{ mode: 'automatic' }, { mode: 'automatic' }], 'cai no automático em vez de inventar');
    assert.equal(r.body.draft.product_ids[0], ids.productId, 'o draft original segue inteiro na resposta');
  } finally { server.close(); }
});

test('produto sem imagem de referência e produto de outra Organization também são "indisponíveis"', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const idsOutro = await semear(store, OUTRO_TENANT);
  const semImagem = crypto.randomUUID();
  await store.createProduct(TENANT, { id: semImagem, name: 'Sem foto', type: 'x', references: [], metadata: {} });
  const draft = draftDoCaso('A', ids, (d) => ({ ...d, product_ids: [semImagem, idsOutro.productId, ids.productId] }));
  const { form, unavailable } = await mapDraftToForm(draft, { store, tenantId: TENANT });
  assert.deepEqual(unavailable.filter((u) => u.field === 'product').map((u) => [u.id, u.reason]),
    [[semImagem, 'no_reference'], [idsOutro.productId, 'missing_or_archived']]);
  assert.deepEqual(form.product_ids, [ids.productId]);
});

test('sem plano v2/prompt v2 na conta, pessoas, interação e sorteios ficam "indisponíveis" (avisados), não perdidos nem quebrados', async () => {
  const { server, call, store, ids } = await ambiente({ env: {} });
  try {
    const { creativeId } = await criativoConcluido(store, ids);
    const r = await call('GET', `/items/${creativeId}/draft`);
    assert.equal(r.status, 200);
    assert.equal(r.body.form.subjects, undefined);
    assert.equal(r.body.form.interaction, undefined);
    assert.equal(r.body.actions.again.scene_picks, undefined);
    assert.deepEqual(r.body.unavailable.map((u) => [u.field, u.reason]), [['subjects', 'plan_v2_not_enabled']]);
    assert.equal(r.body.draft.subjects.length, 2, 'o draft do core continua inteiro');
    // O formulário que sobra é válido para o POST /jobs.
    assert.doesNotThrow(() => normalizeJobInput({ ...r.body.form, ...r.body.actions.again }));
  } finally { server.close(); }
});

test('cena própria do ângulo (template): "de novo" repete os sorteios; "variação" os larga; sem prompt v2 eles ficam indisponíveis', async () => {
  const comV2 = await ambiente({ env: V2, letra: 'F' });
  try {
    const { creativeId } = await criativoConcluido(comV2.store, comV2.ids, { letra: 'F' });
    const r = await comV2.call('GET', `/items/${creativeId}/draft`);
    assert.equal(r.status, 200);
    assert.equal(r.body.form.subjects, undefined);
    assert.equal(r.body.form.interaction, undefined, 'sem pessoas explícitas nem interação: quem aparece volta pela semente');
    assert.deepEqual(r.body.actions.again.scene_picks, FASE_C.F.draft.scene_picks);
    assert.equal(r.body.actions.again.seed, FASE_C.F.draft.seed);
    assert.equal(r.body.actions.variation.scene_picks, undefined);
    assert.equal(r.body.actions.variation.seed, undefined);
    const opcoes = { store: comV2.store, tenantId: TENANT, hints: null, promptVersion: 2, planSchemaVersion: 2 };
    const [deNovo] = await buildRequests(normalizeJobInput({ ...r.body.form, ...r.body.actions.again }), opcoes);
    assert.deepEqual([deNovo.request.seed, deNovo.request.scene_picks], [FASE_C.F.draft.seed, FASE_C.F.draft.scene_picks]);
  } finally { comV2.server.close(); }
  const semV2 = await ambiente({ env: {}, letra: 'F' });
  try {
    const { creativeId } = await criativoConcluido(semV2.store, semV2.ids, { letra: 'F' });
    const r = await semV2.call('GET', `/items/${creativeId}/draft`);
    assert.deepEqual(r.body.unavailable.map((u) => [u.field, u.reason]), [['scene_picks', 'prompt_v2_not_enabled']]);
    assert.equal(r.body.actions.again.scene_picks, undefined);
  } finally { semV2.server.close(); }
});

test('contexto geográfico volta com a cidade do lote de origem; sem ela é indisponível', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const draft = draftDoCaso('A', ids, (d) => ({ ...d, context: { mode: 'geographic', context_id: 'blumenau', provider: 'geographic', scene: 'rua' } }));
  const subject = { name: 'Blumenau', metadata: { city: 'Blumenau', state: 'SC' } };
  const com = await mapDraftToForm(draft, { store, tenantId: TENANT, jobInput: { context: { mode: 'geographic', context_id: 'blumenau', subject } } });
  assert.deepEqual(com.form.context, { mode: 'geographic', context_id: 'blumenau', subject });
  const sem = await mapDraftToForm(draft, { store, tenantId: TENANT, jobInput: { context: { mode: 'automatic' } } });
  assert.deepEqual(sem.unavailable.find((u) => u.field === 'context'), { field: 'context', id: 'blumenau', reason: 'geographic_subject_unknown' });
});

test('patchValido descarta nulos e olhar auto; só devolve chaves aceitas pelo POST /jobs', () => {
  assert.deepEqual(patchValido({ seed: 5, scene_picks: null, gaze_mode: 'auto', hacker: 1 }), { seed: 5 });
  assert.deepEqual(patchValido({ seed: null, scene_picks: { a: 1 }, gaze_mode: 'camera' }), { scene_picks: { a: 1 }, gaze_mode: 'camera' });
  assert.deepEqual(patchValido(undefined), {});
});

test('draft sem plano é 409, criativo inexistente é 404 e id inválido é 400', async () => {
  const { server, call, store, ids } = await ambiente();
  try {
    const semPlano = await criativoConcluido(store, ids, { comPlano: false });
    assert.equal((await call('GET', `/items/${semPlano.creativeId}/draft`)).status, 409);
    assert.equal((await call('GET', `/items/${crypto.randomUUID()}/draft`)).status, 404);
    assert.equal((await call('GET', '/items/x/draft')).status, 400);
  } finally { server.close(); }
});

// ── migration 0033 ───────────────────────────────────────────────────────────────────────────────────────────────

const SQL_0033 = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', '0033-creative-feedback.up.sql'), 'utf8');
const SQL = SQL_0033.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('migration 0033: uma tabela nova, aditiva, com chave de upsert e sem mexer no que existe', () => {
  assert.deepEqual([...SQL.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]), ['creative_feedback']);
  assert.doesNotMatch(SQL, /^\s*(ALTER TABLE (?!creative_feedback)|DROP|DELETE|UPDATE|TRUNCATE)\b/im, 'só cria a tabela nova');
  assert.match(SQL, /CONSTRAINT uq_creative_feedback_pessoa UNIQUE \(organization_id, creative_id, user_id\)/);
  assert.match(SQL, /PRIMARY KEY \(organization_id, id\)/);
  assert.match(SQL, /verdict TEXT NOT NULL CHECK \(verdict IN \('liked', 'disliked'\)\)/);
  assert.match(SQL, /snapshot JSONB NOT NULL CHECK \(jsonb_typeof\(snapshot\) = 'object'\)/);
  assert.match(SQL, /organization_id UUID NOT NULL REFERENCES organizations \(id\) ON DELETE CASCADE/);
});

test('migration 0033: store_id é nulo por desenho, com FK composta; geração e job só da mesma Organization', () => {
  assert.match(SQL, /\n\s+store_id UUID,\n/, 'store_id sem NOT NULL: nulo = compartilhado');
  assert.match(SQL, /FOREIGN KEY \(store_id, organization_id\)\s+REFERENCES stores \(id, organization_id\)/);
  assert.match(SQL, /FOREIGN KEY \(organization_id, creative_id\)\s+REFERENCES creative_generations \(organization_id, creative_id\) ON DELETE CASCADE/);
  assert.match(SQL, /FOREIGN KEY \(organization_id, job_id\)\s+REFERENCES creative_jobs \(organization_id, id\) ON DELETE CASCADE/);
});

test('migration 0033: RLS habilitada e FORÇADA com a policy canônica; a tabela está no manifesto de tenancy', () => {
  assert.match(SQL, /ALTER TABLE creative_feedback ENABLE ROW LEVEL SECURITY;/);
  assert.match(SQL, /ALTER TABLE creative_feedback FORCE ROW LEVEL SECURITY;/);
  assert.match(SQL, /CREATE POLICY tenancy_isolamento ON creative_feedback\s+USING \(organization_id = NULLIF\(current_setting\('app.current_organization_id', true\), ''\)::uuid\)\s+WITH CHECK \(organization_id = NULLIF\(current_setting\('app.current_organization_id', true\), ''\)::uuid\);/);
  const manifesto = require('../lib/platform/tenancy-manifest');
  assert.ok(manifesto.TABELAS_PLATAFORMA.some((t) => t.tabela === 'creative_feedback' && t.colunaTenant === 'organization_id'));
  assert.ok(manifesto.nomesSobRls().includes('creative_feedback'));
});

test('migration 0033: colunas de consulta para ângulo, objetivo, contexto, interação, composição e produto', () => {
  for (const coluna of ['angle', 'objective', 'context_id', 'interaction', 'composition_key', 'product_ids', 'people_count', 'pose_risk', 'plan_schema_version', 'compiler_version', 'prompt_version']) {
    assert.match(SQL, new RegExp(`\\n\\s+${coluna} `), coluna);
  }
  assert.match(SQL, /USING GIN \(product_ids\)/);
  assert.doesNotMatch(SQL, /\b(prompt_text|openai|api_key|token|senha|password)\b/i, 'a tabela não guarda prompt nem segredo');
  const down = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', '0033-creative-feedback.down.sql'), 'utf8');
  assert.match(down.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim(), /^DROP TABLE IF EXISTS creative_feedback;$/);
});
