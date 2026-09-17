'use strict';

// INV-22 — o tenant do Creative Core é a Organization autenticada da request, nunca uma variável de
// ambiente da instalação (CREATIVE_TENANT_ID) nem um valor do cliente.
//
// O Creative Core Python (apps/creative-generator) é stateless e recusa acoplamento a tenant por
// teste de pureza: recebe kits e referências já carregados, não guarda nada por tenant. A fronteira
// de isolamento é este router, e é ela que o invariant mede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const h = require('./harness');
const { criarRouterCriativos } = h.sujeito('routes/criativos.js');
const { createMemoryStore } = h.sujeito('lib/creative-core/memoryStore.js');

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const identidade = (t) => Buffer.from(t).toString('base64');
const silencioso = { log() {}, error() {} };

async function subir(tenantAtual) {
  const store = createMemoryStore();
  const core = {
    configured: true,
    async validate() { return { valid: true, errors: [] }; },
    async contracts() { return {}; },
    async health() { return { versions: {} }; },
  };
  const app = express();
  app.use(express.json());
  const modulo = criarRouterCriativos({
    requireAdmin: (req, res, next) => next(),
    tenantAtual,
    paraCadaTenant: async () => {},
    pgPool: null, store, core,
    uploadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'inv22-')),
    lerEntitlements: async () => ({ creative_generator: true }),
    encriptarSegredo: identidade, descriptografarSegredo: (b) => Buffer.from(b, 'base64').toString(),
    env: {}, logger: silencioso,
  });
  app.use('/c', modulo.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/c`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, call, store };
}

test('INV-22 · dados do Creative Core ficam na Organization da request, com CREATIVE_TENANT_ID apontando para outra', async () => {
  let atual = ORG_A;
  const { server, call, store } = await subir(() => atual);
  const antes = process.env.CREATIVE_TENANT_ID;
  process.env.CREATIVE_TENANT_ID = ORG_B;
  try {
    const kit = await call('POST', '/brand-kits', { data: { name: 'Kit de A' } });
    assert.equal(kit.status, 201);
    assert.equal(kit.body.tenantId, ORG_A);
    assert.equal((await call('PUT', '/settings/openai-key', { apiKey: 'sk-inv22-aaaaaaaaaaaaaaaaaaaaaaaa' })).status, 200);

    assert.equal((await store.listProfiles('brand', ORG_B)).length, 0, 'nada gravado no tenant da env');
    assert.equal(await store.getSettings(ORG_B), null);

    atual = ORG_B;
    assert.deepEqual((await call('GET', '/brand-kits')).body.items, [], 'B não lista o kit de A');
    assert.equal((await call('GET', '/settings/openai-key')).body.configured, false, 'B não enxerga a key de A');
    assert.equal((await call('PUT', `/brand-kits/${kit.body.id}`, { data: { name: 'sequestro' } })).status, 404);

    atual = ORG_A;
    assert.equal((await call('GET', '/brand-kits')).body.items.length, 1);
    // Header ou corpo com tenant não mudam nada.
    const forjado = await call('GET', '/brand-kits', null, { 'X-Tenant-Id': ORG_B });
    assert.equal(forjado.body.items.length, 1);
    const comCampo = await call('POST', '/brand-kits', { data: { name: 'x' }, tenant_id: ORG_B });
    assert.equal(comCampo.body.tenantId, ORG_A, 'tenant_id do corpo é ignorado');
    assert.equal((await store.listProfiles('brand', ORG_B)).length, 0);
  } finally {
    if (antes === undefined) delete process.env.CREATIVE_TENANT_ID; else process.env.CREATIVE_TENANT_ID = antes;
    server.close();
  }
});

test('INV-22 · sem Organization resolvida o módulo não atende', async () => {
  for (const fonte of [() => null, () => '', () => '../fora', () => { throw new Error('sem contexto'); }]) {
    const { server, call } = await subir(fonte);
    try {
      const r = await call('GET', '/brand-kits');
      assert.equal(r.status, 403);
      assert.equal(r.body.codigo, 'TENANT_CONTEXT_REQUIRED');
    } finally {
      server.close();
    }
  }
  assert.throws(() => criarRouterCriativos({ requireAdmin: (q, s, n) => n(), pgPool: null, uploadsDir: os.tmpdir(), env: {}, logger: silencioso }), /tenantAtual/);
});
