'use strict';

// Testes do módulo Gerador de Criativos (docs/creative-generator-saas-integration-plan.md §13).
// Sem Postgres, sem serviço Python e sem OpenAI: store em memória, core falso e fetch falso.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { createCoreClient, CoreUnavailableError, CoreRequestError } = require('../lib/creative-core/client');
const { resolveFlags, checkEngineAccess, enabledEngines } = require('../lib/creative-core/flags');
const { createByok, cofreDeStore, testarChave, CONTEXTO_CRIPTO_OPENAI } = require('../lib/creative-core/byok');
const { createStorage } = require('../lib/creative-core/storage');
const { normalizeJobInput, buildRequests } = require('../lib/creative-core/requests');
const { aggregateJobStatus } = require('../lib/creative-core/status');
const { createMemoryStore } = require('../lib/creative-core/memoryStore');
const { createWorker, MAX_INFRA_RETRIES } = require('../lib/creative-core/worker');
const { criarRouterCriativos, montarCriativos } = require('../routes/criativos');
const DDL = require('./helpers/schema-sql').ddlCreativeCore();

const TENANT = 'default';
const API_KEY = 'sk-test-oria-byok-0123456789abcdefXYZ';
const TOKEN = 't'.repeat(40);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const silencioso = { log() {}, error() {} };

// Cifra de teste reversível: suficiente pra provar que o store nunca recebe a key em claro.
const encrypt = (texto, contexto) => Buffer.from(`${contexto}:${[...texto].reverse().join('')}`).toString('base64');
const decrypt = (b64, contexto) => {
  const bruto = Buffer.from(b64, 'base64').toString();
  if (!bruto.startsWith(`${contexto}:`)) return null;
  return [...bruto.slice(contexto.length + 1)].reverse().join('');
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'criativos-test-'));
}

function fakeCore(overrides = {}) {
  const calls = { plan: [], generate: [], validate: [], copies: [] };
  const core = {
    calls,
    configured: true,
    async health() { return { status: 'ok', versions: { core_version: '1.1.0' } }; },
    async contracts() {
      return { product_modes: ['single_product', 'multi_product'], multi_product_rules: {}, compatibility_matrix: [], catalog: { angles: [] }, versions: {} };
    },
    async validate(contract, payload) { calls.validate.push({ contract, payload }); return { valid: true, errors: [] }; },
    async plan(request) {
      calls.plan.push(request);
      return {
        plan_id: 'plan_x', creative_id: request.creative_id, strategy: request.strategy, product_mode: request.product_mode,
        products: request.products, angle: { id: request.angle_id, label: request.angle_id },
        placement: { id: request.placement_id, width: 1080, height: 1350 }, persona: null,
        context: { context_id: 'niche:fashion', provider: 'niche', scene: 'rua', status: 'approved', profile_version: 1 },
        brand_kit: { id: 'b', version: 2 }, niche_kit: { id: 'fashion', version: 1 },
        funnel_stage: request.funnel_stage || null, remarketing_intent: null, layout: null, overlay: { allowed: false },
        copy: { generate: false, funnel_stages: [] },
        references: request.products.flatMap((p) => p.referenceImages.map((ref, i) => ({ ref, product_id: p.id, role: 'product_art', order: i + 1 }))),
        prompt: { text: 'PROMPT INTERNO SECRETO', sections: [], sha256: 'abc', prompt_version: 1 },
        model: { model: 'gpt-image-2', quality: request.quality, size: '1088x1360' },
        versions: { core_version: '1.1.0' }, validations: [], warnings: [],
      };
    },
    async generate({ plan, references, apiKey, attempt }) {
      calls.generate.push({ plan, references, apiKey, attempt });
      return {
        creative_id: plan.creative_id, status: 'completed', generation_attempt: attempt,
        asset: { mime_type: 'image/png', width: 1080, height: 1350, byte_size: PNG.length, sha256: crypto.createHash('sha256').update(PNG).digest('hex'), data_base64: PNG.toString('base64') },
        error: null,
      };
    },
    async copies() { calls.copies.push(true); return [{ funnel_stage: 'TOFU', primary_text: 'x', headline: 'y', description: 'z' }]; },
    ...overrides,
  };
  return core;
}

async function semear(store, storage) {
  const productId = crypto.randomUUID();
  const ref = storage.saveProductReference(productId, PNG.toString('base64'));
  await store.createProduct(TENANT, { id: productId, name: 'Camiseta Blumenau', type: 'camiseta', references: [ref], metadata: {} });
  const brandId = crypto.randomUUID();
  await store.createProfile('brand', TENANT, { id: brandId, data: { name: 'Marca X' }, status: 'active' });
  return { productId, brandId };
}

function jobInput({ productId, brandId }, extra = {}) {
  return {
    engine: 'CLEAN_ANGLES', product_mode: 'single_product', product_ids: [productId], angle_ids: ['CABIDE', 'PRODUTO_ESTAMPA'],
    placements: ['FEED_4X5'], quantity: 1, brand: { source: 'profile', id: brandId }, niche: { source: 'builtin', id: 'fashion' },
    ...extra,
  };
}

// ── flags ────────────────────────────────────────────────────────────────────

test('flags ficam todas desligadas por padrão', () => {
  const flags = resolveFlags({}, '');
  assert.deepEqual(Object.values(flags), [false, false, false, false, false]);
  assert.deepEqual(enabledEngines(flags), []);
});

test('sem creative_generator nenhum motor liga, mesmo com a chave antiga do motor no plano', () => {
  assert.equal(resolveFlags({ creative_clean_angles: true }, '').creative_clean_angles, false);
});

// MUDOU nesta rodada: os quatro modos deixaram de ser entitlement comercial e viraram module
// capabilities de `creative_generator` (complemento §9/§10). Antes, ligar o gerador sem ligar o
// motor deixava a conta com um gerador sem nenhum motor; esse estado não existe mais. O que
// continua valendo é a checagem de motor INEXISTENTE.
test('o módulo ligado libera todos os modos V1; motor inexistente continua recusado', () => {
  const flags = resolveFlags({ creative_generator: true }, '');
  assert.deepEqual(enabledEngines(flags).sort(), ['CLEAN_ANGLES', 'FUNNEL_VISUAL', 'REMARKETING']);
  assert.equal(checkEngineAccess(flags, 'CLEAN_ANGLES', 'single_product'), null);
  assert.equal(checkEngineAccess(flags, 'FUNNEL_VISUAL', 'single_product'), null);
  assert.equal(checkEngineAccess(flags, 'CLEAN_ANGLES', 'multi_product'), null);
  assert.match(checkEngineAccess(flags, 'ORGANIC', 'single_product'), /inexistente/);
});

test('a env liga o MÓDULO; motor avulso na env não liga mais nada', () => {
  assert.deepEqual(enabledEngines(resolveFlags({}, 'creative_clean_angles, creative_remarketing')), []);
  assert.deepEqual(enabledEngines(resolveFlags({}, 'creative_generator')).sort(), ['CLEAN_ANGLES', 'FUNNEL_VISUAL', 'REMARKETING']);
});

// ── cliente do core ──────────────────────────────────────────────────────────

test('cliente sem URL/token é indisponível e não chama rede', async () => {
  let chamadas = 0;
  const client = createCoreClient({ baseUrl: '', token: TOKEN, fetchImpl: async () => { chamadas += 1; } });
  assert.equal(client.configured, false);
  await assert.rejects(client.health(), CoreUnavailableError);
  assert.equal(createCoreClient({ baseUrl: 'http://core', token: 'curto' }).configured, false);
  assert.equal(createCoreClient({ baseUrl: 'file:///etc/passwd', token: TOKEN }).configured, false);
  assert.equal(chamadas, 0);
});

test('cliente mapeia rede fora, 5xx e erro de negócio sem perder a mensagem segura', async () => {
  const fora = createCoreClient({ baseUrl: 'http://core', token: TOKEN, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(fora.plan({}), (e) => e instanceof CoreUnavailableError && e.reason === 'unreachable');

  const erro500 = createCoreClient({ baseUrl: 'http://core', token: TOKEN, fetchImpl: async () => new Response('{}', { status: 500 }) });
  await assert.rejects(erro500.plan({}), CoreUnavailableError);

  const body = JSON.stringify({ error: { code: 'UNSUPPORTED_PRODUCT_MODE', message: 'Modo de produto não suportado para esta combinação.', retryable: false, details: { intent: 'product_view' } } });
  const negocio = createCoreClient({ baseUrl: 'http://core', token: TOKEN, fetchImpl: async () => new Response(body, { status: 422 }) });
  await assert.rejects(negocio.plan({}), (e) => e instanceof CoreRequestError && e.code === 'UNSUPPORTED_PRODUCT_MODE' && e.httpStatus === 422);
});

test('cliente manda token de serviço no header e a key só no corpo da geração', async () => {
  const vistos = [];
  const client = createCoreClient({
    baseUrl: 'http://core:8765', token: TOKEN,
    fetchImpl: async (url, init) => { vistos.push({ url, init }); return new Response(JSON.stringify({ result: { status: 'completed' } }), { status: 200 }); },
  });
  await client.generate({ plan: { a: 1 }, references: [], apiKey: API_KEY, attempt: 2 });
  assert.equal(vistos[0].url, 'http://core:8765/v1/generations');
  assert.equal(vistos[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!vistos[0].url.includes(API_KEY) && !JSON.stringify(vistos[0].init.headers).includes(API_KEY));
  assert.equal(JSON.parse(vistos[0].init.body).openai_api_key, API_KEY);
  assert.throws(() => client.validate('../plans', {}), CoreRequestError);
});

// ── BYOK ─────────────────────────────────────────────────────────────────────

test('BYOK guarda só cifrado, expõe só os 4 últimos e decifra com o contexto próprio', async () => {
  const store = createMemoryStore();
  const byok = createByok({ cofre: cofreDeStore({ store, encrypt, decrypt, tenantId: TENANT }) });
  await assert.rejects(byok.save('não é uma key'), /formato/);
  const status = await byok.save(API_KEY);
  assert.deepEqual({ configured: status.configured, last4: status.last4 }, { configured: true, last4: 'fXYZ' });
  const salvo = await store.getSettings(TENANT);
  assert.ok(!JSON.stringify(salvo).includes(API_KEY), 'key em claro no store');
  assert.ok(Buffer.from(salvo.openaiKeyEnc, 'base64').toString().startsWith(CONTEXTO_CRIPTO_OPENAI));
  assert.equal(await byok.resolve(), API_KEY);
  await byok.remove();
  assert.equal(await byok.resolve(), null);
});

test('teste da key usa URL fixa da OpenAI e classifica recusa', async () => {
  let url;
  const r = await testarChave(API_KEY, async (u) => { url = u; return new Response('{}', { status: 401 }); });
  assert.equal(url, 'https://api.openai.com/v1/models');
  assert.deepEqual(r, { ok: false, reason: 'rejected' });
  assert.deepEqual(await testarChave(null), { ok: false, reason: 'missing' });
});

// ── storage ──────────────────────────────────────────────────────────────────

test('storage valida imagem por magic bytes e bloqueia path traversal', () => {
  const storage = createStorage({ uploadsDir: tmpDir(), tenantId: TENANT });
  const id = crypto.randomUUID();
  assert.throws(() => storage.saveProductReference(id, Buffer.from('<svg/>').toString('base64')), /formato/);
  assert.throws(() => storage.saveProductReference('../../x', PNG.toString('base64')), /produto inválido/);
  const ref = storage.saveProductReference(id, PNG.toString('base64'));
  assert.match(ref.ref, /^products\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual(storage.readProductReference(ref.ref), PNG);
  assert.throws(() => storage.readProductReference('products/../../../etc/passwd'), /referência inválida/);
  assert.throws(() => createStorage({ uploadsDir: tmpDir(), tenantId: '../outro' }), /tenant inválido/);
  assert.throws(() => storage.saveCreativeAsset(id, { data_base64: PNG.toString('base64'), sha256: 'errado' }), /sha256/);
});

// ── formulário → requests ────────────────────────────────────────────────────

test('formulário rejeita campo desconhecido, ids inválidos e lote grande demais', () => {
  const base = { engine: 'CLEAN_ANGLES', product_mode: 'single_product', product_ids: [crypto.randomUUID()], angle_ids: ['CABIDE'], placements: ['FEED_4X5'], brand: { source: 'builtin', id: 'use_origens' } };
  assert.doesNotThrow(() => normalizeJobInput(base));
  assert.throws(() => normalizeJobInput({ ...base, tenant_id: 'outro' }), /campo desconhecido: tenant_id/);
  assert.throws(() => normalizeJobInput({ ...base, engine: 'ORGANIC' }), /motor inválido/);
  assert.throws(() => normalizeJobInput({ ...base, product_ids: ["1' OR 1=1"] }), /produtos/);
  const muitos = ['IDENTIDADE_ORIGEM', 'LIFESTYLE_COTIDIANO', 'ORGULHO_DISCRETO', 'PERTENCIMENTO', 'NOSTALGIA_ORIGEM'];
  assert.throws(() => normalizeJobInput({ ...base, angle_ids: muitos, placements: ['FEED_4X5', 'STORY_9X16'], quantity: 5 }), /passaria de 40/);
});

test('lote vira 1 request por ângulo x formato x quantidade, com dados carregados só do tenant', async () => {
  const store = createMemoryStore();
  const storage = createStorage({ uploadsDir: tmpDir(), tenantId: TENANT });
  const ids = await semear(store, storage);
  const input = normalizeJobInput(jobInput(ids, { placements: ['FEED_4X5', 'STORY_9X16'], quantity: 2 }));
  const items = await buildRequests(input, { store, tenantId: TENANT, hints: { recent_scenes: ['rua'], recent_personas: [] } });
  assert.equal(items.length, 8);
  assert.equal(new Set(items.map((i) => i.creativeId)).size, 8);
  const req = items[0].request;
  assert.equal(req.brand_kit.id, ids.brandId);
  assert.equal(req.brand_kit.version, 1);
  assert.equal(req.niche_kit_id, 'fashion');
  assert.deepEqual(req.products[0].referenceImages.length, 1);
  assert.deepEqual(req.history_hints.recent_scenes, ['rua']);
  await assert.rejects(buildRequests(input, { store, tenantId: 'outro-tenant', hints: null }), /produto não encontrado/);
});

// ── status ───────────────────────────────────────────────────────────────────

test('status do lote deriva dos itens (parcial, falha, em andamento, cancelado)', () => {
  const s = (...st) => st.map((status) => ({ status }));
  assert.equal(aggregateJobStatus(s('queued', 'queued')), 'queued');
  assert.equal(aggregateJobStatus(s('completed', 'generating')), 'generating');
  assert.equal(aggregateJobStatus(s('completed', 'queued')), 'generating');
  assert.equal(aggregateJobStatus(s('completed', 'completed')), 'completed');
  assert.equal(aggregateJobStatus(s('completed', 'failed')), 'partial');
  assert.equal(aggregateJobStatus(s('failed', 'failed')), 'failed');
  assert.equal(aggregateJobStatus(s('queued'), true), 'cancelled');
});

// ── worker ───────────────────────────────────────────────────────────────────

async function prepararWorker(coreOverrides = {}, { comKey = true } = {}) {
  const store = createMemoryStore();
  const storage = createStorage({ uploadsDir: tmpDir(), tenantId: TENANT });
  const core = fakeCore(coreOverrides);
  const byok = createByok({ cofre: cofreDeStore({ store, encrypt, decrypt, tenantId: TENANT }) });
  if (comKey) await byok.save(API_KEY);
  const ids = await semear(store, storage);
  const input = normalizeJobInput(jobInput(ids));
  const items = await buildRequests(input, { store, tenantId: TENANT, hints: null });
  const job = await store.createJob(TENANT, { id: crypto.randomUUID(), engine: input.engine, productMode: input.product_mode, input }, items);
  const worker = createWorker({ store, core, byokDe: () => byok, storageDe: () => storage, paraCadaTenant: (fn) => fn(TENANT), flagsProvider: async () => ({ creative_generator: true }), logger: silencioso });
  return { store, storage, core, worker, job };
}

async function drenar(worker) {
  while (await worker.tick()) { /* até esvaziar */ }
}

test('worker gera, grava asset e histórico versionado; lote termina completed', async () => {
  const { store, core, worker, job, storage } = await prepararWorker();
  await drenar(worker);
  const final = await store.getJob(TENANT, job.id);
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.items.map((i) => i.status), ['completed', 'completed']);
  const item = final.items[0];
  assert.equal(item.record.engine, 'CLEAN_ANGLES');
  assert.equal(item.record.product_mode, 'single_product');
  assert.equal(item.record.brand_kit_version, 2);
  assert.equal(item.record.tenant_id, TENANT);
  const asset = await store.getAssetByCreative(TENANT, item.creativeId);
  assert.deepEqual(storage.readCreativeAsset(asset.storageKey), PNG);
  assert.equal(core.calls.generate[0].apiKey, API_KEY);
  assert.equal(core.calls.generate[0].references[0].data_base64, PNG.toString('base64'));
  assert.ok(!JSON.stringify(final).includes(API_KEY), 'key vazou para o lote');
});

test('sem OpenAI key o item falha com mensagem acionável e o lote fica failed', async () => {
  const { store, worker, job } = await prepararWorker({}, { comKey: false });
  await drenar(worker);
  const final = await store.getJob(TENANT, job.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.items[0].error.code, 'BYOK_MISSING');
});

test('serviço fora do ar devolve o item pra fila e só falha após o limite de tentativas', async () => {
  const { store, worker, job } = await prepararWorker({ plan: async () => { throw new CoreUnavailableError('unreachable'); } });
  assert.equal(await worker.tick(), true);
  let item = (await store.getJob(TENANT, job.id)).items[0];
  assert.equal(item.status, 'queued');
  assert.equal(item.infraRetries, 1);
  for (let i = 1; i < MAX_INFRA_RETRIES; i += 1) {
    await store.updateItem(TENANT, item.creativeId, { nextAttemptAt: 0 });
    await worker.tick();
    item = await store.getItem(TENANT, item.creativeId);
  }
  assert.equal(item.status, 'failed');
  assert.equal(item.error.code, 'CORE_UNAVAILABLE');
});

test('erro do provedor falha só o item (parcial) e retry mantém creative_id com nova tentativa', async () => {
  let n = 0;
  const base = fakeCore();
  const { store, worker, job, core } = await prepararWorker({
    generate: async (args) => {
      n += 1;
      if (n === 1) return { status: 'failed', asset: null, error: { code: 'MODEL_RATE_LIMITED', message: 'Limite de uso do provedor de IA atingido.', retryable: true } };
      return base.generate(args);
    },
  });
  await drenar(worker);
  let final = await store.getJob(TENANT, job.id);
  assert.equal(final.status, 'partial');
  const falho = final.items.find((i) => i.status === 'failed');
  assert.equal(falho.error.code, 'MODEL_RATE_LIMITED');
  const retry = await store.retryItem(TENANT, job.id, falho.creativeId);
  assert.equal(retry.generationAttempt, 2);
  await drenar(worker);
  final = await store.getJob(TENANT, job.id);
  assert.equal(final.status, 'completed');
  assert.equal(core.calls.plan.length, 2, 'retry reaproveita o plano salvo em vez de replanejar');
});

test('erro inesperado nunca expõe a mensagem interna', async () => {
  const { store, worker, job } = await prepararWorker({ generate: async () => { throw new Error('/var/data/segredo.txt ENOENT'); } });
  await drenar(worker);
  const item = (await store.getJob(TENANT, job.id)).items[0];
  assert.equal(item.error.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(item.error).includes('segredo'));
});

// ── rotas ────────────────────────────────────────────────────────────────────

async function subirApp({ entitlements = {}, envFlags = 'creative_generator,creative_clean_angles', store = createMemoryStore(), core = fakeCore(), semStore = false, tenantAtual = () => TENANT } = {}) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const requireAdmin = (req, res, next) => (req.headers.cookie === 'admin=1' ? next() : res.status(401).json({ error: 'não autenticado' }));
  const modulo = criarRouterCriativos({
    requireAdmin, tenantAtual, paraCadaTenant: (fn) => fn(TENANT), pgPool: null, store: semStore ? null : store, core, uploadsDir: tmpDir(),
    lerEntitlements: async () => entitlements, encriptarSegredo: encrypt, descriptografarSegredo: decrypt,
    env: { CREATIVE_FEATURE_FLAGS: envFlags }, logger: silencioso,
  });
  app.use('/api/admin/criativos', modulo.router);
  // Escuta no mesmo endereço que o teste chama: em todas as interfaces, a porta escolhida pode estar
  // ocupada em 127.0.0.1 por outro processo da máquina e a chamada cair nele.
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/admin/criativos`;
  const call = async (method, p, body, cookie = 'admin=1') => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), ct };
  };
  return { server, call, modulo, store, core };
}

test('rotas exigem admin e respeitam flags desligadas por padrão', async () => {
  const { server, call } = await subirApp({ envFlags: '' });
  try {
    assert.equal((await call('GET', '/status', null, null)).status, 401);
    const status = await call('GET', '/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.flags.creative_generator, false);
    assert.deepEqual(status.body.engines, []);
    assert.equal((await call('GET', '/products')).status, 403);
    assert.equal((await call('POST', '/jobs', {})).status, 403);
    // Módulo desligado: nenhum modo interno passa, inclusive multipeça.
    assert.equal((await call('POST', '/jobs', { engine: 'REMARKETING', product_mode: 'multi_product' })).status, 403);
  } finally {
    server.close();
  }
});

test('sem Postgres o módulo responde 503 e o status explica', async () => {
  const { server, call } = await subirApp({ semStore: true });
  try {
    assert.equal((await call('GET', '/products')).status, 503);
    assert.equal((await call('GET', '/status')).body.postgres, false);
  } finally {
    server.close();
  }
});

test('serviço do core indisponível vira 503 no catálogo, sem derrubar o status', async () => {
  const core = createCoreClient({ baseUrl: '', token: '' });
  const { server, call } = await subirApp({ core });
  try {
    assert.equal((await call('GET', '/catalog')).status, 503);
    const status = await call('GET', '/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.core, { configured: false, reachable: false, versions: null });
  } finally {
    server.close();
  }
});

test('fluxo completo pela API: key, marca, produto, lote, asset e histórico', async () => {
  const { server, call, modulo, core } = await subirApp();
  try {
    const put = await call('PUT', '/settings/openai-key', { apiKey: API_KEY });
    assert.equal(put.status, 200);
    assert.ok(!JSON.stringify(put.body).includes(API_KEY));
    assert.equal(put.body.last4, 'fXYZ');

    const brand = await call('POST', '/brand-kits', { data: { name: 'Marca X', id: 'forjado', version: 99 } });
    assert.equal(brand.status, 201);
    const validado = core.calls.validate.at(-1);
    assert.equal(validado.contract, 'BrandKit');
    assert.equal(validado.payload.id, brand.body.id, 'id do kit vem do servidor');
    assert.equal(validado.payload.version, 1);

    const prod = await call('POST', '/products', { name: 'Caneca', type: 'caneca', images: [{ data_base64: PNG.toString('base64') }] });
    assert.equal(prod.status, 201);
    assert.equal((await call('POST', '/products', { name: 'X', type: 'y', images: [{ data_base64: Buffer.from('<svg/>').toString('base64') }] })).status, 400);

    const input = jobInput({ productId: prod.body.id, brandId: brand.body.id });
    // Motor inexistente continua sendo recusado. Motor EXISTENTE não é mais recusado por
    // entitlement: com o módulo ligado, todos os modos V1 estão disponíveis (complemento §9/§10).
    // A recusa por módulo desligado está no teste "rotas exigem admin e respeitam flags
    // desligadas por padrão", e a classificação inteira em
    // test/invariants/capabilities-classificacao.test.js.
    assert.equal((await call('POST', '/jobs', { ...input, engine: 'ORGANIC' })).status, 400, 'motor inexistente');

    const preview = await call('POST', '/preview', input);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.total, 2);
    // A prévia é o único lugar que mostra o prompt (para testar a arte no ChatGPT antes do lote).
    assert.equal(preview.body.prompts.length, 2, 'um prompt por ângulo × formato');
    assert.deepEqual(preview.body.prompts.map((p) => p.angle.id), ['CABIDE', 'PRODUTO_ESTAMPA']);
    assert.equal(preview.body.prompts[0].text, 'PROMPT INTERNO SECRETO');
    assert.deepEqual(preview.body.prompts[0].references, [{ order: 1, product_id: prod.body.id, product_name: 'Caneca', photo: 1 }]);
    assert.equal(preview.body.promptsOmitidos, 0);
    const foto = await call('GET', `/products/${prod.body.id}/references/1`);
    assert.equal(foto.status, 200);
    assert.deepEqual(foto.body, PNG);
    assert.equal((await call('GET', `/products/${prod.body.id}/references/2`)).status, 404);
    assert.equal((await call('GET', `/products/${prod.body.id}/references/..%2F..`)).status, 400);
    assert.ok(!JSON.stringify(preview.body.first).includes('PROMPT INTERNO SECRETO'), 'resumo do plano não carrega prompt');

    const job = await call('POST', '/jobs', input);
    assert.equal(job.status, 201);
    assert.equal(job.body.items.length, 2);
    modulo.worker.stop();
    while (await modulo.worker.tick()) { /* drena */ }

    const detalhe = await call('GET', `/jobs/${job.body.id}`);
    assert.equal(detalhe.body.status, 'completed');
    assert.deepEqual(detalhe.body.progress, { total: 2, done: 2, completed: 2, failed: 0 });
    assert.ok(!JSON.stringify(detalhe.body).includes('PROMPT INTERNO SECRETO'), 'prompt vazou no lote');
    assert.ok(!JSON.stringify(detalhe.body).includes(API_KEY), 'key vazou no lote');

    const asset = await call('GET', detalhe.body.items[0].assetUrl.replace('/api/admin/criativos', ''));
    assert.equal(asset.status, 200);
    assert.match(asset.ct, /image\/png/);
    assert.deepEqual(asset.body, PNG);

    const historico = await call('GET', '/history');
    assert.equal(historico.body.items.length, 2);
    assert.ok(!JSON.stringify(historico.body).includes('PROMPT INTERNO SECRETO'), 'prompt vazou no histórico');
    assert.equal(historico.body.items[0].record.engine, 'CLEAN_ANGLES');

    const retry = await call('POST', `/jobs/${job.body.id}/items/${detalhe.body.items[0].creativeId}/retry`);
    assert.equal(retry.status, 409, 'só item com falha pode tentar de novo');
  } finally {
    server.close();
  }
});

test('prévia planeja cada ângulo × formato uma vez, sem repetir pela quantidade', async () => {
  const { server, call, core } = await subirApp();
  try {
    const brand = await call('POST', '/brand-kits', { data: { name: 'Marca' } });
    const prod = await call('POST', '/products', { name: 'Caneca', type: 'caneca', images: [{ data_base64: PNG.toString('base64') }] });
    const antes = core.calls.plan.length;
    const input = jobInput({ productId: prod.body.id, brandId: brand.body.id }, { placements: ['FEED_4X5', 'STORY_9X16'], quantity: 3 });
    const preview = await call('POST', '/preview', input);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.total, 12);
    assert.equal(preview.body.prompts.length, 4);
    assert.equal(core.calls.plan.length - antes, 4, 'quantidade não multiplica os planos da prévia');
    assert.deepEqual(preview.body.prompts.map((p) => `${p.angle.id}|${p.placement}`), ['CABIDE|FEED_4X5', 'CABIDE|STORY_9X16', 'PRODUTO_ESTAMPA|FEED_4X5', 'PRODUTO_ESTAMPA|STORY_9X16']);
  } finally {
    server.close();
  }
});

test('lote sem key cadastrada é recusado antes de enfileirar', async () => {
  const store = createMemoryStore();
  const { server, call } = await subirApp({ store });
  try {
    const brand = await call('POST', '/brand-kits', { data: { name: 'Marca' } });
    const prod = await call('POST', '/products', { name: 'Caneca', type: 'caneca', images: [{ data_base64: PNG.toString('base64') }] });
    const r = await call('POST', '/jobs', jobInput({ productId: prod.body.id, brandId: brand.body.id }));
    assert.equal(r.status, 409);
    assert.equal((await store.listJobs(TENANT)).length, 0);
  } finally {
    server.close();
  }
});

test('regra de negócio do core volta 422 com mensagem segura e nada é enfileirado', async () => {
  const store = createMemoryStore();
  const core = fakeCore({
    plan: async () => { throw new CoreRequestError(422, { code: 'PRODUCT_COUNT_OUT_OF_RANGE', message: 'Quantidade de produtos fora do limite permitido.' }); },
  });
  const { server, call } = await subirApp({ store, core });
  try {
    await call('PUT', '/settings/openai-key', { apiKey: API_KEY });
    const brand = await call('POST', '/brand-kits', { data: { name: 'Marca' } });
    const prod = await call('POST', '/products', { name: 'Caneca', type: 'caneca', images: [{ data_base64: PNG.toString('base64') }] });
    const r = await call('POST', '/jobs', jobInput({ productId: prod.body.id, brandId: brand.body.id }));
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'PRODUCT_COUNT_OUT_OF_RANGE');
    assert.equal((await store.listJobs(TENANT)).length, 0);
  } finally {
    server.close();
  }
});

test('INV-22 · tenant vem da Organization da request: env é ignorada, tenant inválido ou ausente é 403', async () => {
  const store = createMemoryStore();
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  let atual = A;
  const { server, call } = await subirApp({ store, tenantAtual: () => atual });
  const antes = process.env.CREATIVE_TENANT_ID;
  process.env.CREATIVE_TENANT_ID = B;
  try {
    const criado = await call('POST', '/brand-kits', { data: { name: 'Marca A' } });
    assert.equal(criado.status, 201);
    assert.equal(criado.body.tenantId, A, 'gravado na Organization da request, não na env');
    assert.equal((await store.listProfiles('brand', B)).length, 0);
    atual = B;
    assert.equal((await call('GET', '/brand-kits')).body.items.length, 0, 'B não vê o kit de A');
    atual = '../evil';
    assert.equal((await call('GET', '/brand-kits')).status, 403);
    atual = null;
    assert.equal((await call('GET', '/brand-kits')).status, 403);
  } finally {
    if (antes === undefined) delete process.env.CREATIVE_TENANT_ID; else process.env.CREATIVE_TENANT_ID = antes;
    server.close();
  }
});

test('montagem nunca derruba o servidor, mesmo com configuração inválida', () => {
  const app = express();
  // Sem fonte de tenant (a Organization da request) o módulo não monta.
  const r = montarCriativos(app, { requireAdmin: (q, s, n) => n(), pgPool: null, uploadsDir: tmpDir(), env: {}, logger: silencioso, lerEntitlements: async () => ({}) });
  assert.equal(r, null);
  const ok = montarCriativos(express(), { requireAdmin: (q, s, n) => n(), tenantAtual: () => TENANT, pgPool: null, uploadsDir: tmpDir(), env: {}, logger: silencioso, lerEntitlements: async () => ({}) });
  assert.ok(ok && ok.router);
});

test('DDL é só aditivo (sem DROP/DELETE) e só em tabelas creative_', () => {
  // Nada destrutivo: esta migration roda sobre a base de produção, que já tem essas tabelas com dados.
  assert.doesNotMatch(DDL, /\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i);
  const tabelas = [...DDL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.equal(tabelas.length, 9);
  assert.ok(tabelas.every((t) => t.startsWith('creative_')));
  assert.equal([...DDL.matchAll(/CREATE TABLE (?!IF NOT EXISTS)/g)].length, 0);
});

test('todo ALTER do DDL é acréscimo de coluna, em tabela creative_', () => {
  // Coluna nova numa tabela que já existe em produção só chega por ALTER — o CREATE TABLE vira
  // no-op depois da primeira execução. O que continua proibido é ALTER que mude ou remova algo
  // (DROP COLUMN, ALTER COLUMN, RENAME), e ALTER em tabela que não é do gerador.
  for (const [, tabela, resto] of DDL.matchAll(/ALTER TABLE (\w+)([^;]*);/g)) {
    assert.ok(tabela.startsWith('creative_'), `ALTER fora do gerador: ${tabela}`);
    assert.match(resto, /^\s+ADD COLUMN IF NOT EXISTS\s/, `ALTER não aditivo em ${tabela}: ${resto.trim()}`);
  }
});
