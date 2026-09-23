'use strict';

// Fase F.1 · Product Enrichment contra um Postgres de verdade: FK composta (product_id, organization_id)
// protege contra um product_id de outra Organization mesmo passando por cima da RLS (owner), a RLS em si
// isola entre Organizations, e só uma proposta pendente por produto (índice único parcial). Roda com
// `node scripts/test-db.mjs run -- ...`.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const URL_TESTE = process.env.CREATIVE_TEST_DATABASE_URL;
const opcoes = { skip: URL_TESTE ? false : 'defina CREATIVE_TEST_DATABASE_URL para rodar contra Postgres' };

const TENANT = 'a1000000-0000-4000-8000-000000000001';
const OUTRO = 'a1000000-0000-4000-8000-000000000002';

test('creative_enrichment_proposals: FK composta, RLS, uma pendente por produto', opcoes, async () => {
  const { Pool } = require('pg');
  const { createPgStore } = require('../lib/creative-core/pgStore');

  const dono = new Pool({ connectionString: URL_TESTE });
  try {
    const store = createPgStore(dono);
    await dono.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'F1 A'), ($2, 'F1 B') ON CONFLICT (id) DO NOTHING`, [TENANT, OUTRO]);
    const { rows: [revisor] } = await dono.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'scrypt$1$x') RETURNING id`,
      [`f1-revisor-${crypto.randomUUID()}@teste.oria`],
    );

    const produtoA = crypto.randomUUID();
    await store.createProduct(TENANT, { id: produtoA, name: 'Camiseta A', type: 'camiseta', metadata: {}, references: [] });
    const produtoB = crypto.randomUUID();
    await store.createProduct(OUTRO, { id: produtoB, name: 'Camiseta B', type: 'camiseta', metadata: {}, references: [] });

    const produtoARow = await store.getProduct(TENANT, produtoA);

    // ── FK composta: uma proposta não pode apontar pra um produto de OUTRA Organization ──
    await assert.rejects(
      dono.query(
        `INSERT INTO creative_enrichment_proposals (organization_id, product_id, provider, proposed, product_snapshot_hash, product_updated_at)
         VALUES ($1, $2, 'fake', '{}'::jsonb, 'h', now())`,
        [TENANT, produtoB], // produtoB é do OUTRO — a FK composta (product_id, organization_id) não bate com nenhuma linha
      ),
      /fk_creative_enrichment_proposals_product|violates foreign key/,
    );

    // ── proposta legítima ──
    const proposta = await store.createProposal(TENANT, {
      productId: produtoA, provider: 'fake', proposed: { wearer_roles: ['adult'], source: 'enrichment', confidence: 0.6 },
      recommendedAngleFamilies: [], recommendedInteractions: [], fieldNotes: {},
      productSnapshotHash: 'h1', productUpdatedAt: produtoARow.updatedAt, createdBy: null,
    });
    assert.equal(proposta.status, 'pending');
    assert.equal(proposta.providerMeta, null, 'provider fake nunca tem provider_meta (Fase F.2.A, migration 0037)');

    // ── Fase F.2.A: provider_meta é uma coluna JSONB de verdade (0037) — round-trip via Postgres, nunca a
    // resposta bruta do provider, nunca bytes de imagem, nunca credencial.
    const produtoC = crypto.randomUUID();
    await store.createProduct(TENANT, { id: produtoC, name: 'Camiseta C', type: 'camiseta', metadata: {}, references: [] });
    const produtoCRow = await store.getProduct(TENANT, produtoC);
    const propostaComMeta = await store.createProposal(TENANT, {
      productId: produtoC, provider: 'openai', proposed: { wearer_roles: [], source: 'enrichment', confidence: 0.2 },
      recommendedAngleFamilies: [], recommendedInteractions: [], fieldNotes: {},
      productSnapshotHash: 'h-meta', productUpdatedAt: produtoCRow.updatedAt, createdBy: null,
      providerMeta: { model_requested: 'gpt-4o-mini', model_served: 'gpt-4o-mini', usage: { input_tokens: 10, output_tokens: 5 }, attempts: 1 },
    });
    assert.equal(propostaComMeta.providerMeta.model_served, 'gpt-4o-mini');
    const relida = await store.getProposal(TENANT, propostaComMeta.id);
    assert.deepEqual(relida.providerMeta, propostaComMeta.providerMeta, 'sobrevive a uma releitura do banco');

    // ── só uma pendente por produto (índice único parcial) ──
    await assert.rejects(
      dono.query(
        `INSERT INTO creative_enrichment_proposals (organization_id, product_id, provider, proposed, product_snapshot_hash, product_updated_at)
         VALUES ($1, $2, 'fake', '{}'::jsonb, 'h2', now())`,
        [TENANT, produtoA],
      ),
      /uq_creative_enrichment_proposals_pending|duplicate key/,
    );

    // ── RLS: a Organization B não vê a proposta de A, nem decide sobre ela ──
    const propostaVistaDeB = await store.getProposal(OUTRO, proposta.id);
    assert.equal(propostaVistaDeB, null);
    const decisaoDeB = await store.decideEnrichmentProposal(OUTRO, proposta.id, { decision: 'approved', acceptedFields: [], reviewedBy: revisor.id });
    assert.equal(decisaoDeB.error, 'not_found');
    // A proposta continua pendente — a tentativa de B não decidiu nada.
    assert.equal((await store.getProposal(TENANT, proposta.id)).status, 'pending');

    // ── aprovação de verdade: merge explícito, auditável, e a proposta sai do caminho de "pendente" ──
    const decisao = await store.decideEnrichmentProposal(TENANT, proposta.id, { decision: 'approved', acceptedFields: ['wearer_roles'], reviewedBy: revisor.id });
    assert.equal(decisao.proposal.status, 'approved');
    assert.deepEqual(decisao.after.wearer_roles, ['adult']);
    const produtoFinal = await store.getProduct(TENANT, produtoA);
    assert.deepEqual(produtoFinal.metadata.semantic_context.wearer_roles, ['adult']);

    // ── com a pendente decidida, uma proposta NOVA para o mesmo produto é permitida (não é mais "duplicada") ──
    const segunda = await store.createProposal(TENANT, {
      productId: produtoA, provider: 'fake', proposed: { scene_intents: ['playing'], source: 'enrichment', confidence: 0.5 },
      recommendedAngleFamilies: [], recommendedInteractions: [], fieldNotes: {},
      productSnapshotHash: 'h3', productUpdatedAt: produtoFinal.updatedAt, createdBy: null,
    });
    assert.equal(segunda.status, 'pending');
    assert.equal((await store.listProposals(TENANT, produtoA)).length, 2, 'histórico guarda as duas — a decidida e a nova pendente');
  } finally {
    await dono.query('DELETE FROM creative_enrichment_proposals WHERE organization_id = ANY($1)', [[TENANT, OUTRO]]).catch(() => {});
    await dono.query('DELETE FROM creative_products WHERE organization_id = ANY($1)', [[TENANT, OUTRO]]).catch(() => {});
    await dono.query(`DELETE FROM users WHERE email LIKE 'f1-revisor-%@teste.oria'`).catch(() => {});
    await dono.end();
  }
});
