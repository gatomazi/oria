'use strict';

// INV-09 — não existe fallback "se só há um candidato, use-o".
// Classe crítica: tenancy/ownership. Também exercita INV-11 e INV-20.
//
// ── O teste decisivo ───────────────────────────────────────────────────────────────────────────
// O banco aqui tem UMA organization. Não três. Essa escolha é o teste inteiro.
//
// `lojaAtribuidaPadrao()` (`server.js:11873-11876` em 8a7ea3d) devolve a única loja atribuída
// quando existe exatamente uma. Contra o banco de produção — três lojas — ela devolve null e passa
// por correta. Foi assim que sobreviveu à auditoria. Um banco com três lojas é ESTRUTURALMENTE
// incapaz de detectar essa classe de defeito; só um banco com uma pega.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const {
  resolveOwnerOrganization,
  assertOwnership,
  particionarPorOwnership,
  OwnershipUnresolvedError,
  CrossTenantAccessError,
} = h.sujeito('lib/platform/ownership.js');

const pool = h.abrirPool();
test.after(async () => { await pool.end(); });

test.before(async () => {
  await h.prepararFixtures(pool);
});

test('INV-09 · com UMA organization e um recurso sem dono, ownership NÃO é inferido', async () => {
  await h.prepararFixtures(pool);
  const [orgUnica] = await h.semearOrganizations(pool, 1);
  await h.semearRecurso(pool, { id: 'media-orfa', organizationId: null, valor: 42 });

  const { rows: orgs } = await pool.query('SELECT id FROM harness_organizations');
  assert.equal(orgs.length, 1, 'o teste só vale com exatamente uma organization semeada');

  const { rows } = await pool.query('SELECT id, organization_id FROM harness_recursos WHERE id = $1', ['media-orfa']);
  assert.equal(rows[0].organization_id, null);

  // As candidatas do banco são passadas de propósito: é o material exato com que o defeito
  // histórico se alimentava.
  assert.throws(
    () => resolveOwnerOrganization({
      recurso: rows[0].id,
      organizationIdDoRecurso: rows[0].organization_id,
      candidatas: orgs.map((o) => o.id),
    }),
    OwnershipUnresolvedError,
    'recurso sem dono com UM candidato precisa continuar sem dono — inferir é o defeito F-07'
  );

  // E o mesmo vale pelo caminho de autorização: nem a única organization do banco alcança o
  // recurso órfão.
  assert.throws(
    () => assertOwnership({
      recurso: rows[0].id,
      organizationIdDoRecurso: rows[0].organization_id,
      organizationIdDoContexto: orgUnica,
      candidatas: orgs.map((o) => o.id),
    }),
    OwnershipUnresolvedError
  );
});

test('INV-09 · o mesmo vale com duas organizations — a regra não depende da contagem', async () => {
  await h.prepararFixtures(pool);
  const orgs = await h.semearOrganizations(pool, 2);
  await h.semearRecurso(pool, { id: 'media-orfa-2', organizationId: null });

  assert.throws(
    () => resolveOwnerOrganization({
      recurso: 'media-orfa-2',
      organizationIdDoRecurso: null,
      candidatas: orgs,
    }),
    OwnershipUnresolvedError
  );
});

test('INV-20 · recurso de outra organization é recusado, não filtrado em silêncio', async () => {
  await h.prepararFixtures(pool);
  const [orgA, orgB] = await h.semearOrganizations(pool, 2);
  await h.semearRecurso(pool, { id: 'campanha-de-b', organizationId: orgB });

  const { rows } = await pool.query('SELECT id, organization_id FROM harness_recursos WHERE id = $1', ['campanha-de-b']);

  assert.throws(
    () => assertOwnership({
      recurso: rows[0].id,
      organizationIdDoRecurso: rows[0].organization_id,
      organizationIdDoContexto: orgA,
    }),
    CrossTenantAccessError
  );

  // E o caminho correto continua funcionando: B alcança o recurso de B.
  assert.equal(
    assertOwnership({
      recurso: rows[0].id,
      organizationIdDoRecurso: rows[0].organization_id,
      organizationIdDoContexto: orgB,
    }),
    String(orgB)
  );
});

test('INV-11 · recurso órfão fica FORA do total e é sinalizado (é o defeito F-01 da DRE)', async () => {
  await h.prepararFixtures(pool);
  const [orgA, orgB] = await h.semearOrganizations(pool, 2);
  await h.semearRecurso(pool, { id: 'gasto-a', organizationId: orgA, valor: 100 });
  await h.semearRecurso(pool, { id: 'gasto-orfao', organizationId: null, valor: 999 });
  await h.semearRecurso(pool, { id: 'gasto-b', organizationId: orgB, valor: 500 });

  const { rows } = await pool.query('SELECT id, organization_id, valor FROM harness_recursos ORDER BY id');
  const { inclusos, sinalizados } = particionarPorOwnership(rows, orgA);

  const total = inclusos.reduce((s, r) => s + Number(r.valor), 0);
  assert.equal(total, 100, 'o total de A não pode conter o órfão nem o gasto de B');
  assert.equal(sinalizados.length, 2, 'os dois excluídos precisam ser SINALIZADOS, não sumir');
  assert.deepEqual(
    sinalizados.map((s) => [s.recurso.id, s.motivo]).sort(),
    [['gasto-b', 'cross-tenant'], ['gasto-orfao', 'unassigned']]
  );
});

test('INV-02 (parcial) · contexto sem organization falha fechado', () => {
  assert.throws(
    () => assertOwnership({ recurso: 'x', organizationIdDoRecurso: 'org-1', organizationIdDoContexto: null }),
    OwnershipUnresolvedError
  );
  assert.throws(
    () => assertOwnership({ recurso: 'x', organizationIdDoRecurso: 'org-1', organizationIdDoContexto: '' }),
    OwnershipUnresolvedError
  );
});
