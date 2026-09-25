'use strict';

// Fase C · o pgStore do feedback (Gostei / Não gostei) contra um Postgres de verdade: chave de upsert, um veredito por
// pessoa, isolamento por Organization, Store nula = compartilhado, FKs compostas e consultas de aprovação.
// Roda com `node scripts/test-db.mjs run -- ...` (banco descartável já migrado); com TEST_APP_ROLE=1 o store roda como
// oria_app (RLS forçada), como no server.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const FASE_C = require('./fixtures/creative-fase-c.json');

const URL_TESTE = process.env.CREATIVE_TEST_DATABASE_URL;
const opcoes = { skip: URL_TESTE ? false : 'defina CREATIVE_TEST_DATABASE_URL para rodar contra Postgres' };

const TENANT = 'a1000000-0000-4000-8000-000000000001';
const OUTRO = 'a1000000-0000-4000-8000-000000000002';
const STORE = 'a2000000-0000-4000-8000-000000000001';
const STORE_DO_OUTRO = 'a2000000-0000-4000-8000-000000000002';

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

test('pgStore do feedback: upsert por pessoa, isolamento, Store nula, FKs e consultas', opcoes, async () => {
  const { Pool } = require('pg');
  const { createPgStore } = require('../lib/creative-core/pgStore');
  const { criarPoolTenant } = require('../lib/platform/tenant-runtime');

  const modoApp = process.env.TEST_APP_ROLE === '1';
  const dono = new Pool({ connectionString: modoApp ? process.env.TEST_OWNER_DATABASE_URL : URL_TESTE });
  const poolApp = modoApp ? new Pool({ connectionString: URL_TESTE }) : null;
  const pessoas = [];
  try {
    const store = modoApp ? storeNoContexto(createPgStore(criarPoolTenant(poolApp))) : createPgStore(dono);

    for (const nome of ['a', 'b']) {
      const { rows } = await dono.query(
        "INSERT INTO users (email, password_hash) VALUES ($1, 'scrypt$1$32768$8$1$x$y') RETURNING id",
        [`fb-${nome}-${crypto.randomBytes(4).toString('hex')}@teste.oria`],
      );
      pessoas.push(rows[0].id);
    }
    const [A, B] = pessoas;

    const criarCriativo = async (tenant) => {
      const brandId = crypto.randomUUID();
      await store.createProfile('brand', tenant, { id: brandId, data: { name: 'M' }, status: 'active' });
      const creativeId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      await store.createJob(tenant, { id: jobId, engine: 'CLEAN_ANGLES', productMode: 'single_product', input: {} }, [{
        creativeId, itemIndex: 0, engine: 'CLEAN_ANGLES', productMode: 'single_product', productIds: [], brandId,
        angle: 'LIFESTYLE_COTIDIANO', placement: 'FEED_4X5', quality: 'low', request: { creative_id: creativeId },
      }]);
      return { creativeId, jobId };
    };
    const meu = await criarCriativo(TENANT);
    const meuDois = await criarCriativo(TENANT);
    const dele = await criarCriativo(OUTRO);
    const snapshot = (letra, creativeId) => ({ ...FASE_C[letra].snapshot, creative_id: creativeId });

    // ── upsert: uma linha por (Organization, criativo, pessoa) ──
    const primeiro = await store.upsertFeedback(TENANT, { userId: A, creativeId: meu.creativeId, jobId: meu.jobId, verdict: 'liked', snapshot: snapshot('A', meu.creativeId) });
    assert.deepEqual([primeiro.verdict, primeiro.storeId, primeiro.userId, primeiro.tenantId], ['liked', null, A, TENANT]);
    assert.deepEqual(primeiro.snapshot, snapshot('A', meu.creativeId));
    const trocou = await store.upsertFeedback(TENANT, { userId: A, creativeId: meu.creativeId, jobId: meu.jobId, verdict: 'disliked', snapshot: snapshot('A', meu.creativeId) });
    assert.equal(trocou.id, primeiro.id, 'trocar o veredito atualiza a mesma linha');
    assert.equal(trocou.verdict, 'disliked');
    assert.equal(trocou.createdAt, primeiro.createdAt);
    assert.ok(trocou.updatedAt >= primeiro.updatedAt);
    const { rows: [{ n }] } = await dono.query('SELECT count(*)::int AS n FROM creative_feedback WHERE organization_id = $1 AND creative_id = $2', [TENANT, meu.creativeId]);
    assert.equal(n, 1);

    // As colunas de consulta espelham o snapshot.
    const { rows: [coluna] } = await dono.query('SELECT * FROM creative_feedback WHERE id = $1', [primeiro.id]);
    const s = FASE_C.A.snapshot;
    assert.deepEqual(
      [coluna.angle, coluna.objective, coluna.mode, coluna.context_id, coluna.interaction, coluna.composition_key, coluna.product_ids, coluna.people_count, coluna.pose_risk, coluna.plan_schema_version, coluna.compiler_version, coluna.prompt_version],
      [s.angle, s.objective, s.mode, s.context.context_id, s.interaction, s.composition_key, s.product_ids, s.people_count, s.pose_risk, s.plan_schema_version, s.compiler_version, s.prompt_version],
    );

    // Outra pessoa, mesmo criativo: outra linha.
    await store.upsertFeedback(TENANT, { userId: B, creativeId: meu.creativeId, jobId: meu.jobId, verdict: 'liked', snapshot: snapshot('A', meu.creativeId) });
    assert.equal((await store.getFeedback(TENANT, A, meu.creativeId)).verdict, 'disliked');
    assert.equal((await store.getFeedback(TENANT, B, meu.creativeId)).verdict, 'liked');
    const mapa = await store.feedbackByCreative(TENANT, A, [meu.creativeId, meuDois.creativeId]);
    assert.deepEqual([...mapa.keys()], [meu.creativeId], 'só o veredito da pessoa, só dos criativos pedidos');
    assert.equal(mapa.get(meu.creativeId).verdict, 'disliked');
    assert.equal((await store.feedbackByCreative(TENANT, A, [])).size, 0);

    // ── limpar ──
    assert.equal(await store.deleteFeedback(TENANT, B, meu.creativeId), true);
    assert.equal(await store.deleteFeedback(TENANT, B, meu.creativeId), false, 'limpar de novo não acha nada');
    assert.equal(await store.getFeedback(TENANT, B, meu.creativeId), null);
    assert.equal((await store.getFeedback(TENANT, A, meu.creativeId)).verdict, 'disliked', 'o de A ficou');

    // ── isolamento entre Organizations ──
    await store.upsertFeedback(OUTRO, { userId: B, creativeId: dele.creativeId, jobId: dele.jobId, verdict: 'liked', snapshot: snapshot('B', dele.creativeId) });
    assert.equal(await store.getFeedback(OUTRO, A, meu.creativeId), null, 'a outra Organization não enxerga o veredito');
    assert.equal(await store.deleteFeedback(OUTRO, A, meu.creativeId), false, 'nem apaga');
    assert.equal((await store.feedbackByCreative(OUTRO, A, [meu.creativeId])).size, 0);
    assert.equal((await store.feedbackSummary(OUTRO, { by: 'angle' })).reduce((t, r) => t + r.total, 0), 1, 'a consulta só vê a própria Organization');
    // FK composta: criativo/job de uma Organization não vira feedback da outra.
    await assert.rejects(store.upsertFeedback(OUTRO, { userId: A, creativeId: meu.creativeId, jobId: meu.jobId, verdict: 'liked', snapshot: snapshot('A', meu.creativeId) }), /fk_creative_feedback_(criativo|job)|row-level security/);
    await assert.rejects(store.upsertFeedback(TENANT, { userId: A, creativeId: meuDois.creativeId, jobId: dele.jobId, verdict: 'liked', snapshot: snapshot('A', meuDois.creativeId) }), /fk_creative_feedback_job|row-level security/);

    // ── Store: nula = compartilhado; a Store precisa ser da MESMA Organization ──
    await store.upsertFeedback(TENANT, { userId: A, storeId: STORE, creativeId: meuDois.creativeId, jobId: meuDois.jobId, verdict: 'liked', snapshot: snapshot('C', meuDois.creativeId) });
    assert.equal((await store.getFeedback(TENANT, A, meuDois.creativeId)).storeId, STORE);
    await assert.rejects(
      store.upsertFeedback(TENANT, { userId: B, storeId: STORE_DO_OUTRO, creativeId: meuDois.creativeId, jobId: meuDois.jobId, verdict: 'liked', snapshot: snapshot('C', meuDois.creativeId) }),
      /fk_creative_feedback_store/,
    );

    // ── CHECKs e chaves direto no banco ──
    await assert.rejects(dono.query(`UPDATE creative_feedback SET verdict = 'love' WHERE id = $1`, [primeiro.id]), /creative_feedback_verdict_check/);
    await assert.rejects(dono.query(`UPDATE creative_feedback SET snapshot = '[]' WHERE id = $1`, [primeiro.id]), /creative_feedback_snapshot_check/);
    await assert.rejects(dono.query(
      `INSERT INTO creative_feedback (organization_id, creative_id, job_id, user_id, verdict, snapshot) VALUES ($1, $2, $3, $4, 'liked', '{}')`,
      [TENANT, meu.creativeId, meu.jobId, A]), /uq_creative_feedback_pessoa/);

    // ── consultas de aprovação (A: meu = disliked; meuDois = liked na Store, snapshot C) ──
    const soma = (linhas) => linhas.reduce((t, r) => t + r.total, 0);
    assert.equal(soma(await store.feedbackSummary(TENANT, { by: 'angle' })), 2);
    const porInteracao = await store.feedbackSummary(TENANT, { by: 'interaction' });
    assert.deepEqual(porInteracao.map((r) => r.key).sort(), [FASE_C.A.snapshot.interaction, FASE_C.C.snapshot.interaction].filter(Boolean).sort());
    const porComposicao = await store.feedbackSummary(TENANT, { by: 'composition' });
    assert.deepEqual(porComposicao.find((r) => r.key === FASE_C.A.snapshot.composition_key), { key: FASE_C.A.snapshot.composition_key, liked: 0, disliked: 1, total: 1 });
    assert.deepEqual((await store.feedbackSummary(TENANT, { by: 'product' })).map((r) => r.key).sort(), [...new Set([...FASE_C.A.snapshot.product_ids, ...FASE_C.C.snapshot.product_ids])].sort());
    for (const by of ['objective', 'context']) assert.ok((await store.feedbackSummary(TENANT, { by })).length >= 1, by);
    const daStore = await store.feedbackSummary(TENANT, { by: 'composition', storeId: STORE });
    assert.equal(soma(daStore), 2, 'a Store vê o dela (liked) + o compartilhado (o Não gostei sem Store)');
    const deOutraStore = await store.feedbackSummary(TENANT, { by: 'composition', storeId: STORE_DO_OUTRO });
    assert.equal(soma(deOutraStore), 1, 'outra Store vê só o compartilhado');
    await assert.rejects(store.feedbackSummary(TENANT, { by: 'user_id; DROP TABLE users' }), /dimensão de feedback desconhecida/);

    // ── o feedback acompanha o criativo: apagar a geração leva junto (ON DELETE CASCADE) ──
    await dono.query('DELETE FROM creative_generations WHERE organization_id = $1 AND creative_id = $2', [TENANT, meuDois.creativeId]);
    assert.equal(await store.getFeedback(TENANT, A, meuDois.creativeId), null);
  } finally {
    await dono.query('DELETE FROM creative_feedback WHERE organization_id = ANY($1)', [[TENANT, OUTRO]]).catch(() => {});
    for (const tabela of ['creative_assets', 'creative_generations', 'creative_jobs', 'creative_products', 'creative_brand_profiles']) {
      await dono.query(`DELETE FROM ${tabela} WHERE tenant_id = ANY($1)`, [[TENANT, OUTRO]]).catch(() => {});
    }
    if (pessoas.length) await dono.query('DELETE FROM users WHERE id = ANY($1)', [pessoas]).catch(() => {});
    await dono.end();
    if (poolApp) await poolApp.end();
  }
});
