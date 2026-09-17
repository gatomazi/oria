'use strict';

// TD-001 — testes-gate da Fase 1.
//
// Dois grupos, e a diferença entre eles é o ponto deste arquivo:
//
//  1. MECANISMO (verde agora). Prova, num banco descartável e com tabelas `harness_*`, que o desenho
//     fechado em TD-001 isola de fato: role da aplicação sem BYPASSRLS, dona da tabela diferente
//     da role da aplicação, FORCE RLS, contexto por `set_config(..., true)` e fail-closed sem
//     contexto. Nenhuma tabela de negócio é tocada.
//
//  2. IMPLEMENTAÇÃO (Fase 1). Asserções contra o schema real das migrations, sob a role oria_app.
//     Foram `todo` até a Fase 1 e saíram dessa marca sem mock.
//
// Organizations semeadas: A e B, mais o caso de UMA só para o recurso sem dono (INV-09).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { comOrganization, TenantDbContextError, CONFIG_ORGANIZATION } = h.sujeito('lib/platform/tenant-db.js');

const sufixo = crypto.randomBytes(4).toString('hex');
const BANCO = `oria_td001_${sufixo}`;
const ROLE_APP = `oria_app_${sufixo}`;
const ROLE_DONA = `oria_owner_${sufixo}`;
const SENHA = crypto.randomBytes(18).toString('hex');

const ORG_A = crypto.randomUUID();
const ORG_B = crypto.randomUUID();

function urlCom(base, { usuario, senha, banco }) {
  const u = new URL(base);
  if (usuario) { u.username = usuario; u.password = senha; }
  if (banco) u.pathname = `/${banco}`;
  return u.toString();
}

let admin; // superusuário, banco `postgres` — só cria/derruba banco e roles
let dona; // role dona das tabelas (papel de quem roda migration)
let app; // role da aplicação — é a que importa

const pool = (url, max) => h.abrirPoolDescartavel(url, { max });

const POLICY = `organization_id = NULLIF(current_setting('${CONFIG_ORGANIZATION}', true), '')::uuid`;

test.before(async () => {
  const base = h.urlDoBanco();
  admin = pool(urlCom(base, { banco: 'postgres' }), 1);
  await admin.query(`CREATE DATABASE ${BANCO}`);
  // Senha gerada por CSPRNG, só para este processo. Nome de role não aceita bind: vem de hex.
  await admin.query(`CREATE ROLE ${ROLE_DONA} LOGIN PASSWORD '${SENHA}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE ROLE ${ROLE_APP} LOGIN PASSWORD '${SENHA}' NOSUPERUSER NOBYPASSRLS`);

  const superNoBanco = pool(urlCom(base, { banco: BANCO }), 1);
  try {
    await superNoBanco.query(`GRANT ALL ON SCHEMA public TO ${ROLE_DONA}`);
    await superNoBanco.query(`GRANT USAGE ON SCHEMA public TO ${ROLE_APP}`);
  } finally { await superNoBanco.end(); }

  dona = pool(urlCom(base, { usuario: ROLE_DONA, senha: SENHA, banco: BANCO }), 2);
  // max: 1 de propósito — toda query reutiliza a MESMA conexão, que é o cenário de vazamento.
  app = pool(urlCom(base, { usuario: ROLE_APP, senha: SENHA, banco: BANCO }), 1);

  await dona.query(`
    CREATE TABLE harness_pedidos (
      id TEXT PRIMARY KEY,
      organization_id UUID,
      valor NUMERIC NOT NULL DEFAULT 0
    );
    ALTER TABLE harness_pedidos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_pedidos FORCE ROW LEVEL SECURITY;
    CREATE POLICY harness_pedidos_tenant ON harness_pedidos
      USING (${POLICY}) WITH CHECK (${POLICY});
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_pedidos TO ${ROLE_APP};

    -- Mesma tabela SEM FORCE: existe só para provar por que o FORCE é obrigatório.
    CREATE TABLE harness_sem_force (
      id TEXT PRIMARY KEY,
      organization_id UUID
    );
    ALTER TABLE harness_sem_force ENABLE ROW LEVEL SECURITY;
    CREATE POLICY harness_sem_force_tenant ON harness_sem_force USING (${POLICY});
  `);

  // Semeadura pela dona, cada linha dentro do contexto da própria org (a policy vale para ela).
  for (const [org, id, valor] of [[ORG_A, 'pedido-a', 10], [ORG_B, 'pedido-b', 20]]) {
    await comOrganization(dona, org, (c) =>
      c.query('INSERT INTO harness_pedidos (id, organization_id, valor) VALUES ($1,$2,$3)', [id, org, valor]));
  }
  // Recurso sem dono: só um superusuário consegue gravar, e é exatamente o legado que a Fase 1 herda.
  const sup = pool(urlCom(base, { banco: BANCO }), 1);
  try {
    await sup.query(`INSERT INTO harness_pedidos (id, organization_id, valor) VALUES ('pedido-orfao', NULL, 99)`);
    await sup.query(`INSERT INTO harness_sem_force (id, organization_id) VALUES ('x', $1), ('y', $2)`, [ORG_A, ORG_B]);
  } finally { await sup.end(); }
});

test.after(async () => {
  await app?.end();
  await dona?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${BANCO} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE_APP}`);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE_DONA}`);
    await admin.end();
  }
});

const ids = (rows) => rows.map((r) => r.id).sort();

// ── 1. Mecanismo ──────────────────────────────────────────────────────────────────────────────

test('TD-001 · role da aplicação não é superusuário, não tem BYPASSRLS e não é dona da tabela', async () => {
  const { rows } = await app.query(
    `SELECT r.rolsuper, r.rolbypassrls, (t.tableowner = current_user) AS dona
       FROM pg_roles r, pg_tables t
      WHERE r.rolname = current_user AND t.tablename = 'harness_pedidos'`
  );
  assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false, dona: false });

  const { rows: rls } = await app.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'harness_pedidos'`
  );
  assert.deepEqual(rls[0], { relrowsecurity: true, relforcerowsecurity: true });
});

test('TD-001 · Org A não lê B — SELECT sem WHERE continua protegido', async () => {
  const rows = await comOrganization(app, ORG_A, async (c) => (await c.query('SELECT id FROM harness_pedidos')).rows);
  assert.deepEqual(ids(rows), ['pedido-a']);
});

test('TD-001 · Org B não lê A', async () => {
  const rows = await comOrganization(app, ORG_B, async (c) => (await c.query('SELECT id FROM harness_pedidos')).rows);
  assert.deepEqual(ids(rows), ['pedido-b']);
});

test('TD-001 · ID válido de B apresentado com contexto A é negado', async () => {
  const rows = await comOrganization(app, ORG_A, async (c) =>
    (await c.query('SELECT id FROM harness_pedidos WHERE id = $1', ['pedido-b'])).rows);
  assert.deepEqual(rows, []);
});

test('TD-001 · Org A não altera nem apaga B', async () => {
  const [upd, del] = await comOrganization(app, ORG_A, async (c) => [
    (await c.query(`UPDATE harness_pedidos SET valor = 0 WHERE id = 'pedido-b'`)).rowCount,
    (await c.query(`DELETE FROM harness_pedidos WHERE id = 'pedido-b'`)).rowCount,
  ]);
  assert.equal(upd, 0);
  assert.equal(del, 0);
  const b = await comOrganization(app, ORG_B, async (c) =>
    (await c.query(`SELECT valor FROM harness_pedidos WHERE id = 'pedido-b'`)).rows);
  assert.equal(Number(b[0].valor), 20, 'a linha de B continua intacta');
});

test('TD-001 · Org A não grava linha em nome de B, nem move a própria linha para B', async () => {
  await assert.rejects(
    comOrganization(app, ORG_A, (c) =>
      c.query('INSERT INTO harness_pedidos (id, organization_id) VALUES ($1,$2)', ['forjado', ORG_B])),
    /row-level security/
  );
  await assert.rejects(
    comOrganization(app, ORG_A, (c) =>
      c.query('UPDATE harness_pedidos SET organization_id = $1 WHERE id = $2', [ORG_B, 'pedido-a'])),
    /row-level security/
  );
});

test('TD-001 · sem contexto de Organization, fail-closed', async () => {
  // Query direta no pool, fora de comOrganization: a policy não casa nada.
  const { rows } = await app.query('SELECT id FROM harness_pedidos');
  assert.deepEqual(rows, []);
  await assert.rejects(app.query(`INSERT INTO harness_pedidos (id, organization_id) VALUES ('sem-ctx', $1)`, [ORG_A]),
    /row-level security/);

  // E o helper recusa antes de chegar ao banco.
  for (const invalido of [undefined, null, '', 'all', '*', 'not-a-uuid', `${ORG_A}' OR '1'='1`]) {
    await assert.rejects(comOrganization(app, invalido, async () => 'não devia rodar'), TenantDbContextError);
  }
});

test('TD-001 · recurso sem organization_id não aparece em tenant nenhum — nem com UMA organization', async () => {
  // Cada org, isoladamente, é "a única candidata" do seu próprio ponto de vista.
  for (const org of [ORG_A, ORG_B]) {
    const rows = await comOrganization(app, org, async (c) =>
      (await c.query(`SELECT id FROM harness_pedidos WHERE id = 'pedido-orfao'`)).rows);
    assert.deepEqual(rows, [], `órfão vazou para ${org}`);
  }
});

test('TD-001 · contexto não vaza entre requests na mesma conexão do pool', async () => {
  const antes = await app.query(`SELECT current_setting('${CONFIG_ORGANIZATION}', true) AS v`);
  await comOrganization(app, ORG_A, (c) => c.query('SELECT 1'));
  const depois = await app.query(`SELECT current_setting('${CONFIG_ORGANIZATION}', true) AS v, pg_backend_pid() AS pid`);
  assert.ok(!depois.rows[0].v, `contexto sobreviveu ao COMMIT: "${depois.rows[0].v}" (antes: "${antes.rows[0].v}")`);

  // Request seguinte, mesma conexão (max: 1), sem contexto: nada.
  assert.deepEqual((await app.query('SELECT id FROM harness_pedidos')).rows, []);

  // Request seguinte com OUTRA org: só a dela — nunca a da anterior.
  const b = await comOrganization(app, ORG_B, async (c) => ({
    rows: (await c.query('SELECT id FROM harness_pedidos')).rows,
    pid: (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
  }));
  assert.equal(b.pid, depois.rows[0].pid, 'o teste só vale se a conexão for a mesma');
  assert.deepEqual(ids(b.rows), ['pedido-b']);
});

test('TD-001 · erro dentro do request desfaz a transação e o contexto', async () => {
  await assert.rejects(comOrganization(app, ORG_A, async (c) => {
    await c.query(`UPDATE harness_pedidos SET valor = 777 WHERE id = 'pedido-a'`);
    throw new Error('falha no handler');
  }), /falha no handler/);

  assert.deepEqual((await app.query('SELECT id FROM harness_pedidos')).rows, [], 'contexto vazou após erro');
  const a = await comOrganization(app, ORG_A, async (c) =>
    (await c.query(`SELECT valor FROM harness_pedidos WHERE id = 'pedido-a'`)).rows);
  assert.equal(Number(a[0].valor), 10, 'o UPDATE do request que falhou não pode ter ficado');
});

test('TD-001 · sem FORCE, a DONA da tabela escapa da policy — por isso FORCE é obrigatório', async () => {
  const semForce = (await dona.query('SELECT id FROM harness_sem_force')).rows;
  assert.deepEqual(ids(semForce), ['x', 'y'], 'sem FORCE a dona vê tudo, sem contexto nenhum');

  const comForce = (await dona.query('SELECT id FROM harness_pedidos')).rows;
  assert.deepEqual(comForce, [], 'com FORCE a dona também fica sujeita à policy');
});

// ── 2. Implementação — schema real das migrations (Fase 1) ────────────────────────────────────
// Eram `todo` até a Fase 1. Agora rodam contra o banco de teste migrado do zero, sob a role
// `oria_app` que scripts/test-db.mjs provisiona. As violações vêm de lib/platform/tenancy-gates.js,
// cujos detectores têm negative control em tenancy-db-negative-controls.test.js.

const gates = h.sujeito('lib/platform/tenancy-gates.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const { verificarRoleDaAplicacao } = h.sujeito('lib/platform/db-config.js');

let inspecao;
async function inspecionar() {
  if (!inspecao) {
    const banco = h.abrirPool();
    try { inspecao = await gates.inspecionarTenancy(banco, manifesto); } finally { await banco.end(); }
  }
  return inspecao;
}

test('TD-001 · toda tabela do schema está classificada (tenant-owned, plataforma ou global declarada)', async () => {
  const v = await inspecionar();
  assert.deepEqual(v.naoClassificadas, []);
  assert.deepEqual(v.inexistentes, []);
});

test('TD-001 / INV-04 · toda tabela tenant-owned tem organization_id NOT NULL', async () => {
  assert.deepEqual((await inspecionar()).inv04, []);
});

test('TD-001 / INV-07 · toda tabela sob RLS tem RLS habilitada, FORÇADA e policy canônica USING + WITH CHECK', async () => {
  assert.deepEqual((await inspecionar()).inv07, []);
});

test('TD-001 · role da aplicação (oria_app) não é SUPERUSER, não tem BYPASSRLS, não é dona', async () => {
  const url = process.env.INVARIANTS_APP_DATABASE_URL;
  assert.ok(url, 'INVARIANTS_APP_DATABASE_URL ausente — rode pelo npm test (scripts/test-db.mjs provisiona oria_app)');
  const app = h.abrirPoolDescartavel(url, { max: 1 });
  try {
    const { role } = await verificarRoleDaAplicacao(app, { tabelasSobRls: manifesto.nomesSobRls() });
    assert.equal(role, 'oria_app');
  } finally { await app.end(); }
});

test('TD-001 · a verificação RECUSA a role que o banco de teste usa para migrar (superusuário)', async () => {
  const banco = h.abrirPool();
  try {
    await assert.rejects(
      verificarRoleDaAplicacao(banco, { tabelasSobRls: manifesto.nomesSobRls() }),
      /SUPERUSER/
    );
  } finally { await banco.end(); }
});

test('TD-001 / INV-07 · sob oria_app, SELECT sem WHERE em cada tabela sob RLS devolve só a Organization do contexto', async () => {
  // Isolamento de linhas com duas Organizations semeadas em TODAS as tabelas está em
  // tenancy-isolation.test.js. Aqui: no banco compartilhado, nenhuma linha de outra Organization
  // aparece, e sem contexto nada aparece.
  const app = h.abrirPoolDescartavel(process.env.INVARIANTS_APP_DATABASE_URL, { max: 1 });
  const sul = 'a1000000-0000-4000-8000-000000000001';
  try {
    for (const tabela of manifesto.nomesSobRls()) {
      const coluna = tabela === 'organizations' ? 'id' : 'organization_id';
      const semCtx = await app.query(`SELECT count(*)::int AS n FROM ${tabela}`);
      assert.equal(semCtx.rows[0].n, 0, `${tabela}: linhas visíveis sem contexto`);
      const fora = await comOrganization(app, sul, (c) =>
        c.query(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${coluna} <> $1`, [sul]));
      assert.equal(fora.rows[0].n, 0, `${tabela}: linha de outra Organization visível`);
    }
  } finally { await app.end(); }
});
