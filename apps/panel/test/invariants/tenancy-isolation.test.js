'use strict';

// Fase 1 — matriz de isolamento sobre TODAS as tabelas sob RLS, no schema real das migrations.
//
// Banco descartável migrado do zero pela CLI, duas Organizations (A/Store A, B/Store B) e uma role
// de aplicação criada aqui com o mesmo SQL de OPS-14 (sem SUPERUSER, sem BYPASSRLS, NOINHERIT, não
// dona). Cada tabela do manifesto recebe uma linha de A e uma de B, gravadas PELA role da aplicação,
// dentro de comOrganization — o caminho que a Fase 3 vai usar.
//
// Para cada tabela: A não lê B, B não lê A, A não altera/apaga/insere/move para B, sem contexto não
// há linha nem escrita. Uma tabela nova no manifesto entra nesta matriz sem código novo.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { inserir, limparCache } = require('../helpers/linhas');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const { comOrganization } = h.sujeito('lib/platform/tenant-db.js');
const { sqlAplicarMapeamento } = h.sujeito('lib/platform/tenancy-mapping.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');

// Fase 3 (INV-22): tenant_id do Creative Core é o próprio id da Organization.
const ORG = {
  A: { id: crypto.randomUUID(), loja: 'sul' },
  B: { id: crypto.randomUUID(), loja: 'centro' },
};
for (const o of Object.values(ORG)) o.tenant = o.id;
const ROLE = `oria_app_iso_${crypto.randomBytes(4).toString('hex')}`;
const SENHA = crypto.randomBytes(16).toString('hex');

let db;
let sup;
let app;
const linhas = { A: new Map(), B: new Map() };
const pessoas = {};

const RLS = /row-level security/;
// Mover uma linha com dono de fato (loja, tenant) é barrado já pelo trigger, antes da RLS.
const RLS_OU_TRIGGER = /row-level security|diverge/;

function mapeamento() {
  // Fase D: commerce_products/variants/sync_logs têm store_id NOT NULL — o id gerado aqui precisa
  // ficar acessível a valoresPara() depois (nenhuma tabela de plataforma anterior precisava disso:
  // as legadas leem `loja`/`escopo`, texto; store_id é identidade de Store de verdade).
  const org = (x) => {
    const storeId = crypto.randomUUID();
    x.storeId = storeId;
    return { id: x.id, nome: `Org ${x.loja}`, store: { id: storeId, nome: `Store ${x.loja}`, lojaLegada: x.loja } };
  };
  return {
    versao: 1,
    organizations: [org(ORG.A), org(ORG.B)],
    mapeamentos: [
      { tipo: 'loja', chave: ORG.A.loja, organizationId: ORG.A.id },
      { tipo: 'loja', chave: ORG.B.loja, organizationId: ORG.B.id },
      { tipo: 'creative_tenant', chave: ORG.A.tenant, organizationId: ORG.A.id },
      { tipo: 'creative_tenant', chave: ORG.B.tenant, organizationId: ORG.B.id },
    ],
  };
}

async function colunasDe(tabela) {
  const { rows } = await sup.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [tabela]
  );
  return new Set(rows.map((r) => r.column_name));
}

// Valores que amarram a linha à Organization: dono, loja/escopo/tenant e o pai da mesma org.
async function valoresPara(tabela, chave) {
  const o = ORG[chave];
  const cols = await colunasDe(tabela);
  const v = {};
  if (tabela === 'organizations') return null; // semeada pelo mapeamento
  if (cols.has('organization_id')) v.organization_id = o.id;
  if (cols.has('loja')) v.loja = o.loja;
  if (cols.has('escopo')) v.escopo = o.loja;
  if (cols.has('tenant_id')) v.tenant_id = o.tenant;
  if (tabela === 'stores') v.loja_legada = null;
  // organization_members aponta para users (Fase 2): uma pessoa por Organization.
  if (tabela === 'organization_members') v.user_id = pessoas[chave];
  // Fase 7: passo de onboarding precisa de id e requisito do vocabulário (CHECK).
  if (tabela === 'onboarding_steps') Object.assign(v, { step_id: 'owner', requirement: 'required' });
  // Fase D: store_id é NOT NULL nas três tabelas do catálogo canônico — a Store REAL da
  // Organization, nunca um UUID aleatório (que quebraria a FK composta para `stores`).
  if (['commerce_products', 'commerce_product_variants', 'commerce_catalog_sync_logs', 'product_external_identities'].includes(tabela)) {
    v.store_id = o.storeId;
  }
  if (tabela === 'commerce_product_variants') v.commerce_product_id = linhas[chave].get('commerce_products').id;
  // Fase F: colunas com CHECK de vocabulário fechado — o preenchedor genérico (`coluna-N`) violaria
  // namespace/source/confidence. Valores válidos e explícitos, como onboarding_steps acima.
  if (tabela === 'product_external_identities') {
    Object.assign(v, {
      commerce_product_id: linhas[chave].get('commerce_products').id,
      namespace: 'sku', external_id: `sku-${chave}`, source: 'manual', confidence: 'exact',
    });
  }
  const decl = manifesto.porTabela(tabela);
  if (decl && decl.pai) v[decl.pai.coluna] = linhas[chave].get(decl.pai.tabela).id;
  return v;
}

// Ordem: pais antes dos filhos; `stores` já existe (1:1) e não ganha outra linha. As tabelas de
// plataforma vêm na ordem do manifesto (organization_members, onboarding_sessions → _steps).
function ordem() {
  const tenant = manifesto.TABELAS_TENANT;
  return [
    ...tenant.filter((x) => x.regra !== 'pai').map((x) => x.tabela),
    ...tenant.filter((x) => x.regra === 'pai').map((x) => x.tabela),
    ...manifesto.TABELAS_PLATAFORMA.map((x) => x.tabela).filter((t) => !['organizations', 'stores'].includes(t)),
  ];
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_iso');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `migrate falhou:\n${r.stdout}${r.stderr}`);

  sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  await sup.query(sqlAplicarMapeamento(mapeamento()));
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  // max: 1 — toda operação reutiliza a MESMA conexão: é o cenário de vazamento de contexto.
  app = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA), { max: 1 });

  for (const chave of ['A', 'B']) {
    const { rows } = await sup.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'scrypt$1$32768$8$1$x$y') RETURNING id`,
      [`iso-${chave.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}@teste.oria`]
    );
    pessoas[chave] = rows[0].id;
  }
  limparCache();
  for (const chave of ['A', 'B']) {
    for (const tabela of ordem()) {
      const valores = await valoresPara(tabela, chave);
      const linha = await comOrganization(app, ORG[chave].id, (c) => inserir(c, tabela, valores));
      linhas[chave].set(tabela, linha);
    }
  }
});

test.after(async () => {
  await app?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

const contar = (c, tabela, onde = '', params = []) =>
  c.query(`SELECT count(*)::int AS n FROM ${tabela} ${onde}`, params).then((r) => r.rows[0].n);

const colunaTenant = (tabela) => (tabela === 'organizations' ? 'id' : 'organization_id');

test('isolamento · a matriz cobre todas as tabelas sob RLS', () => {
  const cobertas = new Set([...ordem(), 'organizations', 'stores']);
  assert.deepEqual(manifesto.nomesSobRls().filter((t) => !cobertas.has(t)), []);
  assert.equal(manifesto.TABELAS_TENANT.length, 55, 'contagem canônica de tabelas tenant-owned');
});

for (const tabela of manifesto.nomesSobRls()) {
  test(`isolamento · ${tabela}`, async () => {
    const col = colunaTenant(tabela);

    // A lê só A, B lê só B — SELECT sem WHERE.
    for (const [eu, outro] of [['A', 'B'], ['B', 'A']]) {
      const [total, doOutro] = await comOrganization(app, ORG[eu].id, async (c) => [
        await contar(c, tabela),
        await contar(c, tabela, `WHERE ${col} = $1`, [ORG[outro].id]),
      ]);
      assert.ok(total >= 1, `${tabela}: ${eu} não enxerga a própria linha`);
      assert.equal(doOutro, 0, `${tabela}: ${eu} enxerga linha de ${outro}`);
    }

    // A não altera nem apaga B.
    const [upd, del] = await comOrganization(app, ORG.A.id, async (c) => [
      (await c.query(`UPDATE ${tabela} SET ${col} = ${col} WHERE ${col} = $1`, [ORG.B.id])).rowCount,
      (await c.query(`DELETE FROM ${tabela} WHERE ${col} = $1`, [ORG.B.id])).rowCount,
    ]);
    assert.equal(upd, 0, `${tabela}: A alterou linha de B`);
    assert.equal(del, 0, `${tabela}: A apagou linha de B`);
    assert.ok(await comOrganization(app, ORG.B.id, (c) => contar(c, tabela)) >= 1, `${tabela}: linha de B sumiu`);

    // Sem contexto: nada visível, nada gravável.
    assert.equal(await contar(app, tabela), 0, `${tabela}: linha visível sem contexto`);

    if (tabela === 'organizations') return; // não há "linha de outra org" a mover ou forjar

    // A não grava linha em nome de B.
    const valoresB = await valoresPara(tabela, 'B');
    await assert.rejects(
      comOrganization(app, ORG.A.id, (c) => inserir(c, tabela, valoresB)),
      RLS,
      `${tabela}: A gravou linha com organization_id de B`
    );

    // Sem contexto, nem a própria linha entra.
    await assert.rejects(inserir(app, tabela, await valoresPara(tabela, 'A')), RLS);

    // A não move a própria linha para B.
    await assert.rejects(
      comOrganization(app, ORG.A.id, (c) =>
        c.query(`UPDATE ${tabela} SET organization_id = $1 WHERE organization_id = $2`, [ORG.B.id, ORG.A.id])),
      RLS_OU_TRIGGER,
      `${tabela}: A moveu linha para B`
    );
  });
}

test('isolamento · contexto não vaza entre requests na mesma conexão (pedidos_ink, max: 1)', async () => {
  const pidA = await comOrganization(app, ORG.A.id, async (c) => (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p);
  const semCtx = await app.query(`SELECT pg_backend_pid() AS p, current_setting('app.current_organization_id', true) AS v`);
  assert.equal(semCtx.rows[0].p, pidA, 'o teste só vale na mesma conexão');
  assert.ok(!semCtx.rows[0].v, 'contexto sobreviveu ao COMMIT');
  assert.equal(await contar(app, 'pedidos_ink'), 0);
  const vistosPorB = await comOrganization(app, ORG.B.id, (c) =>
    c.query('SELECT DISTINCT organization_id FROM pedidos_ink').then((r) => r.rows.map((x) => x.organization_id)));
  assert.deepEqual(vistosPorB, [ORG.B.id]);
});

test('isolamento · linha-filha não atravessa Organization pelo pai (campaign_recipients)', async () => {
  // Pai de B, contexto A, organization_id omitido: desde a Fase 3 o trigger usa a Organization do
  // contexto (A), e a FK composta (organization_id, campaign_id) recusa o pai de B.
  await assert.rejects(
    comOrganization(app, ORG.A.id, (c) =>
      inserir(c, 'campaign_recipients', { campaign_id: linhas.B.get('campaigns').id, organization_id: null })),
    /campaign_recipients_campaign_id_org_fkey/
  );
  // Sem contexto (fora de comOrganization), o trigger herda B do pai e a RLS recusa.
  await assert.rejects(
    app.query('INSERT INTO campaign_recipients (campaign_id, customer_key) VALUES ($1, $2)', [linhas.B.get('campaigns').id, 'sem-contexto']),
    RLS
  );
  // Pai de B com organization_id de A declarado: a FK composta (organization_id, campaign_id) recusa.
  await assert.rejects(
    comOrganization(app, ORG.A.id, (c) =>
      inserir(c, 'campaign_recipients', { campaign_id: linhas.B.get('campaigns').id, organization_id: ORG.A.id })),
    /campaign_recipients_campaign_id_org_fkey/
  );
});

test('isolamento · loja de B com organization_id de A é recusada pelo trigger (regra é fato)', async () => {
  await assert.rejects(
    comOrganization(app, ORG.A.id, (c) => inserir(c, 'pedidos_ink', { loja: ORG.B.loja, organization_id: ORG.A.id })),
    /diverge do dono da loja/
  );
});

test('isolamento · a role da aplicação não lê o mapeamento legado', async () => {
  await assert.rejects(app.query('SELECT * FROM tenancy_mapeamentos'), /permission denied/);
});

test('cardinalidade V1 · a segunda Store da mesma Organization é recusada', async () => {
  await assert.rejects(
    comOrganization(app, ORG.A.id, (c) =>
      c.query('INSERT INTO stores (id, organization_id, nome) VALUES ($1, $2, $3)', [crypto.randomUUID(), ORG.A.id, 'Outra'])),
    /uq_stores_organization/
  );
});

test('INV-06 · cada Organization tem sua própria conexão Meta e Google Ads', async () => {
  for (const tabela of ['meta_connections', 'google_ads_connections']) {
    const { rows } = await sup.query(`SELECT organization_id, id FROM ${tabela} ORDER BY id`);
    assert.equal(rows.length, 2, `${tabela}: esperava uma conexão por Organization`);
    assert.notEqual(rows[0].organization_id, rows[1].organization_id);
    await assert.rejects(
      comOrganization(app, ORG.A.id, (c) => inserir(c, tabela, { organization_id: ORG.A.id })),
      /duplicate key/,
      `${tabela}: segunda conexão da mesma Organization`
    );
  }
});
