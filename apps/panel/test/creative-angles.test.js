'use strict';

// Fase D · Angles V2 — CRUD de ângulos customizados de Organization/Store, resolução da biblioteca
// (system + organization + store) e isolamento. Store em memória e core falso (só `contracts()`, sem plano —
// CRUD de ângulo não gera nada). Contrato contra Postgres em creative-angles-pg.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { createMemoryStore } = require('../lib/creative-core/memoryStore');
const { criarRouterCriativos } = require('../routes/criativos');

const TENANT = 'a1000000-0000-4000-8000-000000000001';
const OUTRO_TENANT = 'a1000000-0000-4000-8000-000000000002';
const PESSOA_A = 'b1000000-0000-4000-8000-00000000000a';
const STORE_1 = 'c1000000-0000-4000-8000-000000000001';
const STORE_2 = 'c1000000-0000-4000-8000-000000000002';
const silencioso = { log() {}, error() {} };

const ANGLE_FAMILIES = [
  { id: 'lifestyle', label: 'Lifestyle cotidiano', description: 'x', reserved: false },
  { id: 'connection', label: 'Conexão / vínculo', description: 'x', reserved: false },
  { id: 'action_movement', label: 'Ação / movimento', description: 'x', reserved: true },
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'criativos-angles-'));
}

function fakeCore() {
  return {
    configured: true,
    async health() { return { status: 'ok' }; },
    async contracts() { return { catalog: { angle_families: ANGLE_FAMILIES }, product_modes: [], multi_product_rules: {}, compatibility_matrix: [], versions: {} }; },
    async validate() { return { valid: true, errors: [] }; },
    async plan() { throw new Error('não deve planejar'); },
    async generate() { throw new Error('não deve gerar'); },
    async copies() { return []; },
  };
}

async function subirApp({ store = createMemoryStore(), env = {}, tenant = { atual: TENANT }, storeAtual = () => null } = {}) {
  const app = express();
  app.use(express.json());
  const requireAdmin = (req, res, next) => {
    const cookie = req.headers.cookie || '';
    if (!cookie.includes('admin=1')) return res.status(401).json({ error: 'não autenticado' });
    const pessoa = /user=([\w-]+)/.exec(cookie);
    req.auth = pessoa ? { userId: pessoa[1] } : {};
    return next();
  };
  const modulo = criarRouterCriativos({
    requireAdmin, tenantAtual: () => tenant.atual, paraCadaTenant: (fn) => fn(tenant.atual), pgPool: null, store, core: fakeCore(), uploadsDir: tmpDir(),
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
  return { server, call, store };
}

const angleBody = (extra = {}) => ({ scope: 'organization', slug: 'dia-dos-pais', name: 'Dia dos Pais', family: 'connection', peopleMode: 'required', ...extra });

// ------------------------------------------------------------------ CRUD básico
test('cria um ângulo de Organization, lista com o system + organization, atualiza (versão sobe) e arquiva', async () => {
  const { server, call } = await subirApp();
  try {
    const criado = await call('POST', '/angles', angleBody());
    assert.equal(criado.status, 201);
    assert.deepEqual(
      [criado.body.scope, criado.body.storeId, criado.body.family, criado.body.version, criado.body.active],
      ['organization', null, 'connection', 1, true],
    );
    assert.equal(criado.body.createdBy, PESSOA_A);

    const lista = await call('GET', '/angles');
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.body.system, ANGLE_FAMILIES);
    assert.deepEqual(lista.body.organization.map((a) => a.id), [criado.body.id]);
    assert.deepEqual(lista.body.store, []);

    const atualizado = await call('PUT', `/angles/${criado.body.id}`, { name: 'Dia dos Pais 2026', preset: 'gift_moment' });
    assert.equal(atualizado.status, 200);
    assert.deepEqual([atualizado.body.name, atualizado.body.preset, atualizado.body.version], ['Dia dos Pais 2026', 'gift_moment', 2]);
    assert.equal(atualizado.body.slug, 'dia-dos-pais', 'campo não enviado não muda');

    const arquivado = await call('DELETE', `/angles/${criado.body.id}`);
    assert.deepEqual([arquivado.status, arquivado.body.active], [200, false]);
    assert.deepEqual((await call('GET', '/angles')).body.organization, [], 'arquivado some da listagem padrão');
    assert.equal((await call('DELETE', `/angles/${criado.body.id}`)).status, 404, 'arquivar de novo não acha nada ativo');
  } finally { server.close(); }
});

test('validação: slug, family, peopleMode, campo desconhecido e slug duplicado no mesmo escopo', async () => {
  const { server, call } = await subirApp();
  try {
    assert.equal((await call('POST', '/angles', angleBody({ slug: 'AB' }))).status, 400);
    assert.equal((await call('POST', '/angles', angleBody({ family: 'nao_existe' }))).status, 400);
    assert.equal((await call('POST', '/angles', angleBody({ peopleMode: 'sempre' }))).status, 400);
    assert.equal((await call('POST', '/angles', { ...angleBody(), extra: 1 })).status, 400);
    assert.equal((await call('POST', '/angles', angleBody({ scope: 'loja' }))).status, 400);
    assert.equal((await call('POST', '/angles', { ...angleBody(), name: '' })).status, 400);
    const primeiro = await call('POST', '/angles', angleBody());
    assert.equal(primeiro.status, 201);
    const repetido = await call('POST', '/angles', angleBody({ name: 'Outro nome' }));
    assert.equal(repetido.status, 400, 'mesmo slug, mesmo escopo');
    assert.match(repetido.body.error, /slug/);
  } finally { server.close(); }
});

test('atualizar id inválido ou inexistente, e apagar com id inválido', async () => {
  const { server, call } = await subirApp();
  try {
    assert.equal((await call('PUT', '/angles/nao-e-uuid', { name: 'x' })).status, 400);
    assert.equal((await call('PUT', `/angles/${crypto.randomUUID()}`, { name: 'x' })).status, 404);
    assert.equal((await call('DELETE', '/angles/nao-e-uuid')).status, 400);
  } finally { server.close(); }
});

test('Fase D.1: definition estruturado e compatibilidade (allowedInteractions/allowedProductModes/defaultGaze) persistem', async () => {
  const { server, call } = await subirApp();
  try {
    const criado = await call('POST', '/angles', angleBody({
      definition: { framing: 'plano médio', photographic_direction: 'sentada', visual_notes: ['nota 1', 'nota 2'] },
      allowedInteractions: ['reading_together', 'playing'], allowedProductModes: ['single_product'], defaultGaze: 'camera',
    }));
    assert.equal(criado.status, 201);
    assert.deepEqual(criado.body.definition, { framing: 'plano médio', photographic_direction: 'sentada', visual_notes: ['nota 1', 'nota 2'] });
    assert.deepEqual([criado.body.allowedInteractions, criado.body.allowedProductModes, criado.body.defaultGaze],
      [['reading_together', 'playing'], ['single_product'], 'camera']);

    assert.equal((await call('POST', '/angles', angleBody({ slug: 'y', definition: { campo_invalido: 'x' } }))).status, 400);
    assert.equal((await call('POST', '/angles', angleBody({ slug: 'y', definition: { framing: 'x'.repeat(201) } }))).status, 400);
    assert.equal((await call('POST', '/angles', angleBody({ slug: 'y', definition: { visual_notes: Array(7).fill('x') } }))).status, 400);
    assert.equal((await call('POST', '/angles', angleBody({ slug: 'y', allowedInteractions: ['Não Minúsculo'] }))).status, 400);
    assert.equal((await call('POST', '/angles', angleBody({ slug: 'y', allowedProductModes: ['multi_product_errado'] }))).status, 400);
    assert.equal((await call('POST', '/angles', angleBody({ slug: 'y', defaultGaze: 'giratorio' }))).status, 400);

    const atualizado = await call('PUT', `/angles/${criado.body.id}`, { defaultGaze: 'product' });
    assert.deepEqual([atualizado.body.defaultGaze, atualizado.body.allowedInteractions], ['product', ['reading_together', 'playing']]);
  } finally { server.close(); }
});

// ------------------------------------------------------------------ Caso 6: ângulo de Store só aparece naquela Store
test('caso 6 — ângulo de Store aparece só naquela Store, não na Organization nem em outra Store', async () => {
  let storeAtiva = STORE_1;
  const { server, call } = await subirApp({ storeAtual: () => storeAtiva });
  try {
    const criado = await call('POST', '/angles', angleBody({ scope: 'store', slug: 'promo-loja-1' }));
    assert.equal(criado.status, 201);
    assert.deepEqual([criado.body.scope, criado.body.storeId], ['store', STORE_1]);

    const naPropriaStore = await call('GET', '/angles');
    assert.deepEqual(naPropriaStore.body.store.map((a) => a.id), [criado.body.id]);
    assert.deepEqual(naPropriaStore.body.organization, []);

    storeAtiva = STORE_2;
    const naOutraStore = await call('GET', '/angles');
    assert.deepEqual(naOutraStore.body.store, [], 'outra Store da mesma Organization não vê o ângulo');

    storeAtiva = null;
    const semStore = await call('GET', '/angles');
    assert.deepEqual(semStore.body.store, [], 'sem Store resolvida, nada de escopo Store aparece');
  } finally { server.close(); }
});

test('criar ângulo de Store sem Store resolvida no contexto é recusado', async () => {
  const { server, call } = await subirApp({ storeAtual: () => null });
  try {
    const r = await call('POST', '/angles', angleBody({ scope: 'store', slug: 'sem-store' }));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Store/);
  } finally { server.close(); }
});

// ------------------------------------------------------------------ Caso 7: ângulo de Organization aparece em duas Stores
test('caso 7 — ângulo de Organization aparece em duas Stores diferentes da mesma Organization', async () => {
  let storeAtiva = STORE_1;
  const { server, call, store } = await subirApp({ storeAtual: () => storeAtiva });
  try {
    const criado = await call('POST', '/angles', angleBody({ scope: 'organization', slug: 'campanha-anual' }));
    assert.equal(criado.status, 201);

    const store1 = await call('GET', '/angles');
    assert.deepEqual(store1.body.organization.map((a) => a.id), [criado.body.id]);

    storeAtiva = STORE_2;
    const store2 = await call('GET', '/angles');
    assert.deepEqual(store2.body.organization.map((a) => a.id), [criado.body.id], 'a mesma Organization, outra Store, mesmo ângulo visível');

    // E não existe override implícito por nome: um ângulo de Store com slug igual convive, não substitui.
    storeAtiva = STORE_1;
    const proprioDaStore = await call('POST', '/angles', angleBody({ scope: 'store', slug: 'campanha-anual', name: 'Campanha da Loja 1' }));
    assert.equal(proprioDaStore.status, 201);
    const listaFinal = await call('GET', '/angles');
    assert.equal(listaFinal.body.organization.length, 1);
    assert.equal(listaFinal.body.store.length, 1);
    assert.notEqual(listaFinal.body.organization[0].id, listaFinal.body.store[0].id, 'dois ângulos com identidade própria, nenhuma sobrescrita');
    assert.equal(await store.getAngle(TENANT, criado.body.id).then((a) => a.slug), 'campanha-anual');
  } finally { server.close(); }
});

// ------------------------------------------------------------------ isolamento entre Organizations
test('isolamento: outra Organization não lista, não edita e não arquiva o ângulo', async () => {
  const tenant = { atual: TENANT };
  const { server, call } = await subirApp({ tenant });
  try {
    const criado = await call('POST', '/angles', angleBody());
    tenant.atual = OUTRO_TENANT;
    assert.deepEqual((await call('GET', '/angles')).body.organization, []);
    assert.equal((await call('PUT', `/angles/${criado.body.id}`, { name: 'invadido' })).status, 404);
    assert.equal((await call('DELETE', `/angles/${criado.body.id}`)).status, 404);
    tenant.atual = TENANT;
    assert.equal((await call('GET', `/angles`)).body.organization[0].name, 'Dia dos Pais', 'nada mudou');
  } finally { server.close(); }
});

// ------------------------------------------------------------------ migration 0034
const SQL_0034 = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', '0034-creative-angles.up.sql'), 'utf8');
const SQL = SQL_0034.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('migration 0034: uma tabela nova, aditiva, com identidade própria por escopo', () => {
  assert.deepEqual([...SQL.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]), ['creative_angles']);
  assert.doesNotMatch(SQL, /^\s*(ALTER TABLE (?!creative_angles)|DROP|DELETE|UPDATE|TRUNCATE)\b/im, 'só cria a tabela nova');
  assert.match(SQL, /CONSTRAINT pk_creative_angles PRIMARY KEY \(organization_id, id\)/);
  assert.match(SQL, /CONSTRAINT ck_creative_angles_scope_store CHECK \(\(scope = 'organization'\) = \(store_id IS NULL\)\)/);
  assert.match(SQL, /FOREIGN KEY \(store_id, organization_id\) REFERENCES stores \(id, organization_id\)/);
  assert.match(SQL, /CREATE UNIQUE INDEX uq_creative_angles_org_slug ON creative_angles \(organization_id, slug\) WHERE store_id IS NULL/);
  assert.match(SQL, /CREATE UNIQUE INDEX uq_creative_angles_store_slug ON creative_angles \(organization_id, store_id, slug\) WHERE store_id IS NOT NULL/);
});

test('migration 0034: RLS habilitada e FORÇADA com a policy canônica; a tabela está no manifesto de tenancy', () => {
  assert.match(SQL, /ALTER TABLE creative_angles ENABLE ROW LEVEL SECURITY;/);
  assert.match(SQL, /ALTER TABLE creative_angles FORCE ROW LEVEL SECURITY;/);
  assert.match(SQL, /CREATE POLICY tenancy_isolamento ON creative_angles/);
  const manifesto = require('../lib/platform/tenancy-manifest');
  assert.ok(manifesto.TABELAS_PLATAFORMA.some((t) => t.tabela === 'creative_angles' && t.colunaTenant === 'organization_id'));
  assert.ok(manifesto.nomesSobRls().includes('creative_angles'));
  const down = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', '0034-creative-angles.down.sql'), 'utf8');
  assert.match(down.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim(), /^DROP TABLE IF EXISTS creative_angles;$/);
});
