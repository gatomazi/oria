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

// ------------------------------------------------------------------ Fase F.2.B: concorrência/orçamento reais
// A janela de cobrança concorrente (§2 da direção) só se fecha de verdade contra um Postgres de verdade —
// nenhum teste em memória prova isto, porque o event loop do Node já serializa chamadas "concorrentes"
// dentro do MESMO processo. Aqui, `Promise.all` dispara as reservas em paralelo, cada uma na sua própria
// conexão do pool, para que a corrida aconteça de fato no banco.
test('creative_enrichment_pilot_attempts: reserva atômica — 2 requests simultâneos no mesmo produto geram no máximo 1 reserva', opcoes, async () => {
  const { Pool } = require('pg');
  const enrichmentPilotBudget = require('../lib/creative-core/enrichmentPilotBudget');

  const dono = new Pool({ connectionString: URL_TESTE });
  const q = (sql, params) => dono.query(sql, params);
  try {
    await dono.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'F2B A'), ($2, 'F2B B') ON CONFLICT (id) DO NOTHING`, [TENANT, OUTRO]);
    const produto = crypto.randomUUID();

    // Duas "requisições simultâneas" de verdade: disparadas juntas, cada uma resolvida pelo Postgres
    // (advisory lock + índice único parcial), nunca serializadas pelo processo Node que as chama.
    const [r1, r2] = await Promise.all([
      enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produto, custoEstimadoUsd: 0.001, limiteChamadas: 3, limiteUsd: 0.05 }),
      enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produto, custoEstimadoUsd: 0.001, limiteChamadas: 3, limiteUsd: 0.05 }),
    ]);
    const sucessos = [r1, r2].filter((r) => r.ok);
    const recusados = [r1, r2].filter((r) => !r.ok);
    assert.equal(sucessos.length, 1, 'exatamente UMA das duas reservas simultâneas teve sucesso');
    assert.equal(recusados.length, 1);
    assert.equal(recusados[0].motivo, 'em_andamento');

    const { rows: linhas } = await dono.query(
      'SELECT status FROM creative_enrichment_pilot_attempts WHERE organization_id = $1 AND product_id = $2',
      [TENANT, produto],
    );
    assert.equal(linhas.length, 1, 'nunca duas linhas de reserva para o mesmo produto — nunca duas cobranças');
    assert.equal(linhas[0].status, 'reserved');

    // Finaliza a que teve sucesso — libera o slot para uma tentativa nova, humana, futura.
    await enrichmentPilotBudget.finalizar(q, sucessos[0].attemptId, { status: 'succeeded', model: 'gpt-4o-mini', custoRealUsd: 0.0006 });
    const terceira = await enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produto, custoEstimadoUsd: 0.001, limiteChamadas: 3, limiteUsd: 0.05 });
    assert.equal(terceira.ok, true, 'com a anterior finalizada, uma NOVA tentativa (não automática) é permitida');
  } finally {
    await dono.query('DELETE FROM creative_enrichment_pilot_attempts WHERE organization_id = ANY($1)', [[TENANT, OUTRO]]).catch(() => {});
    await dono.end();
  }
});

test('creative_enrichment_pilot_attempts: produtos/Organizations diferentes não bloqueiam entre si; orçamento é do piloto inteiro', opcoes, async () => {
  const { Pool } = require('pg');
  const enrichmentPilotBudget = require('../lib/creative-core/enrichmentPilotBudget');

  const dono = new Pool({ connectionString: URL_TESTE });
  const q = (sql, params) => dono.query(sql, params);
  try {
    await dono.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'F2B C'), ($2, 'F2B D') ON CONFLICT (id) DO NOTHING`, [TENANT, OUTRO]);
    const produtoA = crypto.randomUUID();
    const produtoB = crypto.randomUUID();

    // Produtos DIFERENTES (mesmo de Organizations diferentes) nunca disputam o mesmo slot de concorrência —
    // só o orçamento AGREGADO do piloto (compartilhado entre todas as Organizations, de propósito) os une.
    const [r1, r2] = await Promise.all([
      enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produtoA, custoEstimadoUsd: 0.001, limiteChamadas: 3, limiteUsd: 0.05 }),
      enrichmentPilotBudget.reservar(q, { organizationId: OUTRO, productId: produtoB, custoEstimadoUsd: 0.001, limiteChamadas: 3, limiteUsd: 0.05 }),
    ]);
    assert.equal(r1.ok, true, 'produto/Organization A não é bloqueado pelo B');
    assert.equal(r2.ok, true, 'produto/Organization B não é bloqueado pelo A');
    assert.notEqual(r1.attemptId, r2.attemptId);

    // Uma terceira reserva (produto novo) ainda cabe no limite de 3 chamadas...
    const produtoC = crypto.randomUUID();
    const r3 = await enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produtoC, custoEstimadoUsd: 0.001, limiteChamadas: 3, limiteUsd: 0.05 });
    assert.equal(r3.ok, true);
    // ...mas a QUARTA excede o teto de CHAMADAS do piloto inteiro — nunca chega perto do teto de valor.
    const produtoD = crypto.randomUUID();
    const r4 = await enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produtoD, custoEstimadoUsd: 0.001, limiteChamadas: 3, limiteUsd: 0.05 });
    assert.equal(r4.ok, false);
    assert.equal(r4.motivo, 'orcamento_excedido');
  } finally {
    await dono.query('DELETE FROM creative_enrichment_pilot_attempts WHERE organization_id = ANY($1)', [[TENANT, OUTRO]]).catch(() => {});
    await dono.end();
  }
});

test('creative_enrichment_pilot_attempts: teto de VALOR bloqueia mesmo com chamadas sobrando', opcoes, async () => {
  const { Pool } = require('pg');
  const enrichmentPilotBudget = require('../lib/creative-core/enrichmentPilotBudget');

  const dono = new Pool({ connectionString: URL_TESTE });
  const q = (sql, params) => dono.query(sql, params);
  try {
    await dono.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'F2B E') ON CONFLICT (id) DO NOTHING`, [TENANT]);
    const produto1 = crypto.randomUUID();
    const r1 = await enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produto1, custoEstimadoUsd: 0.04, limiteChamadas: 10, limiteUsd: 0.05 });
    assert.equal(r1.ok, true);
    const produto2 = crypto.randomUUID();
    // 0.04 + 0.02 > 0.05 — mesmo com 8 chamadas de folga no limite de chamadas.
    const r2 = await enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produto2, custoEstimadoUsd: 0.02, limiteChamadas: 10, limiteUsd: 0.05 });
    assert.equal(r2.ok, false);
    assert.equal(r2.motivo, 'orcamento_excedido');
  } finally {
    await dono.query('DELETE FROM creative_enrichment_pilot_attempts WHERE organization_id = $1', [TENANT]).catch(() => {});
    await dono.end();
  }
});

test('creative_enrichment_pilot_attempts: TTL libera uma reserva travada (crash/timeout) sem devolver o orçamento já contado', opcoes, async () => {
  const { Pool } = require('pg');
  const enrichmentPilotBudget = require('../lib/creative-core/enrichmentPilotBudget');

  const dono = new Pool({ connectionString: URL_TESTE });
  const q = (sql, params) => dono.query(sql, params);
  try {
    await dono.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'F2B F') ON CONFLICT (id) DO NOTHING`, [TENANT]);
    const produto = crypto.randomUUID();
    const primeira = await enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produto, custoEstimadoUsd: 0.001, limiteChamadas: 3, limiteUsd: 0.05 });
    assert.equal(primeira.ok, true);
    // Simula um crash: a reserva nunca é finalizada. "Envelhece" manualmente para além do TTL.
    await dono.query(`UPDATE creative_enrichment_pilot_attempts SET reserved_at = now() - interval '10 minutes' WHERE id = $1`, [primeira.attemptId]);

    const segunda = await enrichmentPilotBudget.reservar(q, { organizationId: TENANT, productId: produto, custoEstimadoUsd: 0.001, limiteChamadas: 3, limiteUsd: 0.05, ttlSegundos: 60 });
    assert.equal(segunda.ok, true, 'a reserva travada expirou (TTL) e liberou o slot POR PRODUTO para uma tentativa nova');

    // Mas o orçamento AGREGADO nunca esquece a primeira tentativa — mesmo expirada, ela conta.
    const { rows: [{ total }] } = await dono.query('SELECT count(*)::int AS total FROM creative_enrichment_pilot_attempts WHERE organization_id = $1', [TENANT]);
    assert.equal(total, 2, 'a reserva expirada continua contando contra o orçamento — nunca é apagada nem descontada');
    const { rows: [expirada] } = await dono.query('SELECT status, error_code FROM creative_enrichment_pilot_attempts WHERE id = $1', [primeira.attemptId]);
    assert.equal(expirada.status, 'failed');
    assert.equal(expirada.error_code, 'reservation_expired');
  } finally {
    await dono.query('DELETE FROM creative_enrichment_pilot_attempts WHERE organization_id = $1', [TENANT]).catch(() => {});
    await dono.end();
  }
});
