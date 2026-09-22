'use strict';

// Contrato do pgStore contra um Postgres de verdade. Opcional: só roda com CREATIVE_TEST_DATABASE_URL apontando para um
// banco DESCARTÁVEL já migrado (as tabelas creative_* vêm das migrations; os dados de teste usam um tenant próprio, removidos ao final).
//   CREATIVE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54411/criativos_e2e node --test test/creative-core-pg.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const URL_TESTE = process.env.CREATIVE_TEST_DATABASE_URL;
const opcoes = { skip: URL_TESTE ? false : 'defina CREATIVE_TEST_DATABASE_URL para rodar contra Postgres' };

test('pgStore cumpre o contrato do store (schema, perfis, produtos, lotes, fila, retry, histórico, isolamento)', opcoes, async () => {
  const { Pool } = require('pg');
  const { createPgStore } = require('../lib/creative-core/pgStore');
  const { criarPoolTenant } = require('../lib/platform/tenant-runtime');

  // `npm run test:app-role` (TEST_APP_ROLE=1): o store roda como no server.js — role oria_app, pela
  // fachada do tenant-runtime e dentro do contexto da Organization de cada chamada. Fixture, schema e
  // limpeza continuam com a dona (TEST_OWNER_DATABASE_URL).
  const modoApp = process.env.TEST_APP_ROLE === '1';
  const pool = new Pool({ connectionString: modoApp ? process.env.TEST_OWNER_DATABASE_URL : URL_TESTE });
  const poolApp = modoApp ? new Pool({ connectionString: URL_TESTE }) : null;
  // Fase 3 (INV-22): o tenant do Creative Core é o id da Organization. Duas Organizations DIFERENTES
  // do banco de teste (cenário A); nenhum rótulo de instalação.
  const tenant = 'a1000000-0000-4000-8000-000000000001';
  const outro = 'a1000000-0000-4000-8000-000000000002';
  try {
    if (modoApp) {
      const { rows: [r] } = await poolApp.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      assert.deepEqual([r.rolsuper, r.rolbypassrls], [false, false], 'test:app-role precisa conectar o store como oria_app');
    }
    // Schema vem das migrations (scripts/test-db.mjs aplica todas do zero), não do teste.
    const { rows: tabelasCreative } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'creative\\_%'`
    );
    assert.equal(tabelasCreative[0].n, 11, 'as 11 tabelas creative_* precisam existir via migration (9 do core + creative_feedback da 0033 + creative_angles da 0034)');
    // tenant_id que não é o id da Organization dona é recusado pelo banco.
    await assert.rejects(
      pool.query(
        `INSERT INTO creative_brand_profiles (id, tenant_id, data, status, organization_id) VALUES ($1, 'default', '{}', 'active', $2)`,
        [crypto.randomUUID(), tenant]
      ),
      /ck_creative_brand_profiles_tenant_org/
    );
    const store = modoApp ? storeNoContexto(createPgStore(criarPoolTenant(poolApp))) : createPgStore(pool);

    // Fase 4: a OpenAI key não é mais do store (é a integração 'openai' da Organization).
    assert.equal(store.saveOpenAiKey, undefined);

    const brandId = crypto.randomUUID();
    await store.createProfile('brand', tenant, { id: brandId, data: { name: 'Marca' }, status: 'active' });
    const v2 = await store.updateProfile('brand', tenant, brandId, { data: { name: 'Marca 2' } });
    assert.equal(v2.version, 2);
    assert.equal(v2.data.name, 'Marca 2');
    assert.equal(await store.getProfile('brand', outro, brandId), null, 'isolamento por tenant');
    assert.equal(await store.updateProfile('brand', outro, brandId, { data: {} }), null);

    const productId = crypto.randomUUID();
    await store.createProduct(tenant, { id: productId, name: 'Caneca', type: 'caneca', references: [{ ref: 'products/x/y.png', mime: 'image/png', sizeBytes: 10 }] });
    assert.equal((await store.listProducts(tenant)).length, 1);
    assert.equal((await store.listProducts(outro)).length, 0);

    const jobId = crypto.randomUUID();
    const itens = [0, 1].map((i) => ({
      creativeId: crypto.randomUUID(), itemIndex: i, engine: 'CLEAN_ANGLES', productMode: 'single_product', productIds: [productId],
      brandId, angle: 'CABIDE', placement: 'FEED_4X5', quality: 'low', request: { creative_id: 'x', seed: i },
    }));
    const job = await store.createJob(tenant, { id: jobId, engine: 'CLEAN_ANGLES', productMode: 'single_product', input: { a: 1 } }, itens);
    assert.equal(job.items.length, 2);
    assert.equal(job.status, 'queued');

    assert.equal(await store.claimNextItem(outro), null, 'fila isolada por tenant');
    const primeiro = await store.claimNextItem(tenant);
    assert.equal(primeiro.status, 'planning');
    assert.equal(primeiro.itemIndex, 0);
    await store.updateItem(tenant, primeiro.creativeId, { status: 'generating', plan: { p: 1 }, planSummary: { scene: 'rua' }, persona: 'P1', hacker: 'ignorado' });
    assert.equal((await store.refreshJobStatus(tenant, jobId)).status, 'generating');
    await store.updateItem(tenant, primeiro.creativeId, { status: 'completed', finishedAt: new Date().toISOString(), record: { engine: 'CLEAN_ANGLES' } });
    // Fase A1: trace por tentativa em JSONB + colunas escalares (migration 0031).
    await store.updateItem(tenant, primeiro.creativeId, {
      generationTrace: { 1: { attempt: 1, model_served: 'gpt-image-2', duration_ms: 1234 } },
      modelServed: 'gpt-image-2', durationMs: 1234, providerRequestId: 'req_abc',
    });
    const comTrace = await store.getItem(tenant, primeiro.creativeId);
    assert.deepEqual(comTrace.generationTrace, { 1: { attempt: 1, model_served: 'gpt-image-2', duration_ms: 1234 } });
    assert.deepEqual([comTrace.modelServed, comTrace.durationMs, comTrace.providerRequestId], ['gpt-image-2', 1234, 'req_abc']);
    assert.equal((await store.getItem(tenant, primeiro.creativeId)).status, 'completed', 'trace não mexe no status');
    // Fase B: versão do plano e do compiler (migration 0032).
    await store.updateItem(tenant, primeiro.creativeId, { planSchemaVersion: 2, compilerVersion: 1 });
    const comVersao = await store.getItem(tenant, primeiro.creativeId);
    assert.deepEqual([comVersao.planSchemaVersion, comVersao.compilerVersion], [2, 1]);
    await store.updateItem(tenant, primeiro.creativeId, { compilerVersion: null });
    assert.equal((await store.getItem(tenant, primeiro.creativeId)).compilerVersion, null, 'plano v1 não tem compiler v2');
    const assetId = crypto.randomUUID();
    await store.insertAsset(tenant, { id: assetId, creativeId: primeiro.creativeId, storageKey: 'creatives/a/image.png', mime: 'image/png', byteSize: 10, sha256: 'x' });
    assert.equal((await store.getAssetByCreative(tenant, primeiro.creativeId)).id, assetId);

    const segundo = await store.claimNextItem(tenant);
    await store.updateItem(tenant, segundo.creativeId, { status: 'failed', error: { code: 'X', message: 'y' } });
    assert.equal((await store.refreshJobStatus(tenant, jobId)).status, 'partial');

    const retry = await store.retryItem(tenant, jobId, segundo.creativeId);
    assert.equal(retry.generationAttempt, 2);
    assert.equal(retry.error, null);
    assert.equal(await store.retryItem(tenant, jobId, primeiro.creativeId), null, 'item concluído não faz retry');

    const preso = await store.claimNextItem(tenant);
    assert.equal(preso.creativeId, segundo.creativeId);
    assert.equal(await store.requeueStuck(tenant), 1);
    await store.updateItem(tenant, segundo.creativeId, { nextAttemptAt: Date.now() + 60_000 });
    assert.equal(await store.claimNextItem(tenant), null, 'respeita next_attempt_at');

    const cancelado = await store.cancelJob(tenant, jobId);
    assert.equal(cancelado.status, 'cancelled');
    assert.equal((await store.getItem(tenant, segundo.creativeId)).status, 'cancelled');

    const hist = await store.listHistory(tenant);
    assert.equal(hist.length, 1);
    assert.deepEqual(await store.recentHints(tenant), { recent_scenes: ['rua'], recent_personas: ['P1'] });
  } finally {
    for (const tabela of ['creative_assets', 'creative_generations', 'creative_jobs', 'creative_products', 'creative_brand_profiles']) {
      await pool.query(`DELETE FROM ${tabela} WHERE tenant_id = ANY($1)`, [[tenant, outro]]).catch(() => {});
    }
    await pool.end();
    if (poolApp) await poolApp.end();
  }
});

// Cada método do store recebe o tenant no primeiro argumento (ou no segundo, depois do tipo de
// perfil); sob a role da aplicação ele roda no contexto dessa Organization, como a rota faria.
function storeNoContexto(store) {
  const { comContexto } = require('../lib/platform/tenant-runtime');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return new Proxy(store, {
    get(alvo, prop) {
      const v = alvo[prop];
      if (typeof v !== 'function') return v;
      return (...args) => {
        const organizationId = [args[0], args[1]].find((a) => UUID.test(String(a)));
        return comContexto({ organizationId, origem: 'teste' }, () => v.apply(alvo, args));
      };
    },
  });
}
