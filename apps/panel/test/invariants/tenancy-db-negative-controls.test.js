'use strict';

// NEGATIVE CONTROLS da Fase 1, no nível do banco.
//
// Os gates de schema (tenancy-gates.js), a verificação de role (db-config.js) e as funções de
// cobertura/trigger das migrations são detectores. Um detector que nunca reprovou não provou nada.
// Cada ciclo abaixo segue o critério do plano:
//
//   1. estado correto → o invariant PASSA
//   2. violação deliberada, aplicada no banco real migrado
//   3. o MESMO invariant FALHA
//   4. a violação é desfeita
//   5. ele volta a PASSAR
//
// O contexto de sessão não-local (`set_config(..., false)`) já tem ciclo próprio em
// negative-controls.test.js e não é repetido.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const h = require('./harness');
const { semearBaseLegada } = require('../helpers/tenancy-legado');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const gates = h.sujeito('lib/platform/tenancy-gates.js');
const { verificarRoleDaAplicacao } = h.sujeito('lib/platform/db-config.js');
const { comOrganization } = h.sujeito('lib/platform/tenant-db.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');

const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ROLE = `oria_app_nc_${crypto.randomBytes(4).toString('hex')}`;
const SENHA = crypto.randomBytes(16).toString('hex');
const SUL = 'a1000000-0000-4000-8000-000000000001';
const CENTRO = 'a1000000-0000-4000-8000-000000000002';

let db;
let sup;
let app;

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_nc');
  // Base com dado nas três lojas, migrada com o cenário A: há linhas de Organizations diferentes.
  assert.equal(h.migrar(db.url, { posicionais: ['6'] }).status, 0);
  sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  await semearBaseLegada(sup);
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  app = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA), { max: 1 });
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

// `medir` devolve a lista de violações do invariant (vazia = PASS).
async function ciclo({ medir, violar, restaurar, esperado }) {
  assert.deepEqual(await medir(), [], '[1] o invariant reprovou no estado CORRETO');
  await violar();
  try {
    const durante = await medir();
    assert.ok(durante.length > 0, '[3] o invariant PASSOU com a violação aplicada — não detecta o defeito');
    assert.ok(durante.some((v) => esperado.test(v)), `[3] reprovou por outro motivo: ${durante.join(' | ')}`);
  } finally {
    await restaurar();
  }
  assert.deepEqual(await medir(), [], '[5] o invariant não voltou a passar após restaurar');
}

const inspecionar = (classe) => async () => (await gates.inspecionarTenancy(sup, manifesto))[classe];

async function roleValida() {
  try {
    await verificarRoleDaAplicacao(app, { tabelasSobRls: manifesto.nomesSobRls() });
    return [];
  } catch (err) {
    return [err.message];
  }
}

test('NC · INV-07 · RLS sem FORCE', () => ciclo({
  medir: inspecionar('inv07'),
  violar: () => sup.query('ALTER TABLE pedidos_ink NO FORCE ROW LEVEL SECURITY'),
  restaurar: () => sup.query('ALTER TABLE pedidos_ink FORCE ROW LEVEL SECURITY'),
  esperado: /pedidos_ink: RLS não forçada/,
}));

test('NC · INV-07 · RLS desabilitada', () => ciclo({
  medir: inspecionar('inv07'),
  violar: () => sup.query('ALTER TABLE app_config DISABLE ROW LEVEL SECURITY'),
  restaurar: () => sup.query('ALTER TABLE app_config ENABLE ROW LEVEL SECURITY'),
  esperado: /app_config: RLS desabilitada/,
}));

test('NC · INV-07 · policy permissiva extra (USING true) abre a tabela', async () => {
  await ciclo({
    medir: inspecionar('inv07'),
    violar: () => sup.query('CREATE POLICY nc_aberta ON pedidos_ink USING (true) WITH CHECK (true)'),
    restaurar: () => sup.query('DROP POLICY nc_aberta ON pedidos_ink'),
    esperado: /pedidos_ink\.nc_aberta: USING fora da forma canônica/,
  });
  // E o efeito que o gate evita, medido: com a policy aberta, a role da aplicação lê sem contexto.
  await sup.query('CREATE POLICY nc_aberta ON pedidos_ink USING (true) WITH CHECK (true)');
  try {
    assert.ok((await app.query('SELECT count(*)::int AS n FROM pedidos_ink')).rows[0].n > 0);
  } finally {
    await sup.query('DROP POLICY nc_aberta ON pedidos_ink');
  }
  assert.equal((await app.query('SELECT count(*)::int AS n FROM pedidos_ink')).rows[0].n, 0);
});

// `DROP NOT NULL` nem é aceito: organization_id está na PK de toda tabela tenant-owned. A violação
// medida é a coluna deixar de existir com esse nome.
test('NC · INV-04 · tabela tenant-owned sem organization_id', () => ciclo({
  medir: inspecionar('inv04'),
  violar: () => sup.query('ALTER TABLE media_assets RENAME COLUMN organization_id TO nc_org'),
  restaurar: () => sup.query('ALTER TABLE media_assets RENAME COLUMN nc_org TO organization_id'),
  esperado: /media_assets: sem organization_id/,
}));

test('NC · INV-04 · o banco recusa organization_id nullable (está na PK)', async () => {
  await assert.rejects(
    sup.query('ALTER TABLE media_assets ALTER COLUMN organization_id DROP NOT NULL'),
    /is in a primary key/
  );
});

test('NC · INV-05 · UNIQUE global sem organization_id', () => ciclo({
  medir: inspecionar('inv05'),
  violar: () => sup.query('CREATE UNIQUE INDEX nc_unique_global ON meta_campaigns (meta_campaign_id, nome)'),
  restaurar: () => sup.query('DROP INDEX nc_unique_global'),
  esperado: /meta_campaigns\.nc_unique_global: UNIQUE sem organization_id/,
}));

test('NC · INV-05 · UNIQUE global reintroduzida numa tabela antes afetada (app_config.chave)', () => ciclo({
  medir: inspecionar('inv05'),
  violar: () => sup.query('CREATE UNIQUE INDEX nc_app_config_chave_global ON app_config (chave)'),
  restaurar: () => sup.query('DROP INDEX nc_app_config_chave_global'),
  esperado: /app_config\.nc_app_config_chave_global: UNIQUE sem organization_id/,
}));

test('NC · INV-05 · PK volta a ser só id', () => ciclo({
  medir: inspecionar('inv05'),
  violar: async () => {
    await sup.query('ALTER TABLE despesas_operacionais DROP CONSTRAINT despesas_operacionais_pkey');
    await sup.query('ALTER TABLE despesas_operacionais ADD CONSTRAINT despesas_operacionais_pkey PRIMARY KEY (id)');
  },
  restaurar: async () => {
    await sup.query('ALTER TABLE despesas_operacionais DROP CONSTRAINT despesas_operacionais_pkey');
    await sup.query('ALTER TABLE despesas_operacionais ADD CONSTRAINT despesas_operacionais_pkey PRIMARY KEY (organization_id, id)');
  },
  esperado: /despesas_operacionais\.despesas_operacionais_pkey: PK sem organization_id/,
}));

test('NC · INV-05 · FK entre tabelas tenant-owned sem organization_id', () => ciclo({
  medir: inspecionar('inv05'),
  violar: async () => {
    await sup.query('CREATE UNIQUE INDEX nc_campaigns_id ON campaigns (id)');
    await sup.query('ALTER TABLE campaign_recipients ADD CONSTRAINT nc_fk_simples FOREIGN KEY (campaign_id) REFERENCES campaigns (id)');
  },
  restaurar: async () => {
    await sup.query('ALTER TABLE campaign_recipients DROP CONSTRAINT nc_fk_simples');
    await sup.query('DROP INDEX nc_campaigns_id');
  },
  esperado: /campaign_recipients\.nc_fk_simples: FK entre tabelas tenant-owned sem organization_id/,
}));

test('NC · INV-05 · efeito medido: com a UNIQUE global de volta, Org B não grava a chave de Org A', async () => {
  await sup.query(`INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'nc-chave', '{}')`, [SUL]);
  try {
    await sup.query(`INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'nc-chave', '{}')`, [CENTRO]);
    await sup.query('CREATE UNIQUE INDEX nc_efeito ON app_config (chave)').then(
      () => assert.fail('a UNIQUE global não deveria nem ser criável com as duas linhas'),
      (err) => assert.match(err.message, /could not create unique index/)
    );
  } finally {
    await sup.query(`DELETE FROM app_config WHERE chave = 'nc-chave'`);
  }
});

test('NC · PD-002 · sem a UNIQUE de stores o banco deixa de garantir 1:1', () => ciclo({
  medir: inspecionar('card1a1'),
  violar: () => sup.query('ALTER TABLE stores DROP CONSTRAINT uq_stores_organization'),
  restaurar: () => sup.query('ALTER TABLE stores ADD CONSTRAINT uq_stores_organization UNIQUE (organization_id)'),
  esperado: /nenhuma UNIQUE \(organization_id\)/,
}));

test('NC · PD-002 · segunda Store ativa na mesma Organization (com a constraint relaxada)', () => ciclo({
  medir: inspecionar('card1a1'),
  violar: async () => {
    await sup.query('ALTER TABLE stores DROP CONSTRAINT uq_stores_organization');
    await sup.query('CREATE UNIQUE INDEX uq_stores_organization ON stores (organization_id) WHERE false');
    await sup.query(`INSERT INTO stores (id, organization_id, nome) VALUES (gen_random_uuid(), $1, 'Segunda')`, [SUL]);
  },
  restaurar: async () => {
    await sup.query(`DELETE FROM stores WHERE nome = 'Segunda'`);
    await sup.query('DROP INDEX uq_stores_organization');
    await sup.query('ALTER TABLE stores ADD CONSTRAINT uq_stores_organization UNIQUE (organization_id)');
  },
  esperado: /mais de uma Store ativa/,
}));

test('NC · INV-06 · volta do CHECK (id = 1)', () => ciclo({
  medir: inspecionar('inv06'),
  violar: async () => {
    await sup.query('DELETE FROM google_ads_connections WHERE id <> 1');
    await sup.query('ALTER TABLE google_ads_connections ADD CONSTRAINT nc_singleton CHECK (id = 1)');
  },
  restaurar: () => sup.query('ALTER TABLE google_ads_connections DROP CONSTRAINT nc_singleton'),
  esperado: /google_ads_connections\.nc_singleton/,
}));

test('NC · role da aplicação com BYPASSRLS', async () => {
  await ciclo({
    medir: roleValida,
    violar: () => sup.query(`ALTER ROLE ${ROLE} BYPASSRLS`),
    restaurar: () => sup.query(`ALTER ROLE ${ROLE} NOBYPASSRLS`),
    esperado: /BYPASSRLS/,
  });
  // O efeito, medido: com BYPASSRLS a role lê as três Organizations sem contexto nenhum.
  await sup.query(`ALTER ROLE ${ROLE} BYPASSRLS`);
  const bypass = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA), { max: 1 });
  try {
    const { rows } = await bypass.query('SELECT count(DISTINCT organization_id)::int AS n FROM pedidos_ink');
    assert.equal(rows[0].n, 3, 'com BYPASSRLS a RLS existe e não faz nada');
  } finally {
    await bypass.end();
    await sup.query(`ALTER ROLE ${ROLE} NOBYPASSRLS`);
  }
});

test('NC · role da aplicação dona de tabela tenant-owned', () => ciclo({
  medir: roleValida,
  violar: () => sup.query(`ALTER TABLE pedidos_ink OWNER TO ${ROLE}`),
  // Trocar a dona leva junto a entrada de ACL da role: devolver a posse exige reconceder o DML.
  restaurar: async () => {
    await sup.query('ALTER TABLE pedidos_ink OWNER TO CURRENT_USER');
    await sup.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON pedidos_ink TO ${ROLE}`);
  },
  esperado: /dona de pedidos_ink/,
}));

test('NC · role da aplicação com acesso ao mapeamento legado', () => ciclo({
  medir: roleValida,
  violar: () => sup.query(`GRANT SELECT ON tenancy_mapeamentos TO ${ROLE}`),
  restaurar: () => sup.query(`REVOKE SELECT ON tenancy_mapeamentos FROM ${ROLE}`),
  esperado: /acesso a tenancy_mapeamentos/,
}));

// ── "Candidato único" — os dois lugares do banco onde ele poderia reaparecer ────────────────────

// Recria uma função com um ramo "se só existe uma Organization, use-a" e devolve como desfazer.
async function substituirFuncao(banco, nome, assinatura, corpoViolado) {
  const { rows } = await banco.query(`SELECT pg_get_functiondef('${nome}(${assinatura})'::regprocedure) AS def`);
  const original = rows[0].def;
  await banco.query(corpoViolado);
  return () => banco.query(original);
}

test('NC · INV-09 · trigger: loja sem mapeamento NÃO vira da única Organization', async (t) => {
  const umaOrg = await h.criarBancoDescartavel('oria_nc1');
  t.after(() => umaOrg.destruir());
  assert.equal(h.migrar(umaOrg.url).status, 0);
  const banco = h.abrirPoolDescartavel(umaOrg.url, { max: 1 });
  t.after(() => banco.end());
  const org = crypto.randomUUID();
  await banco.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'Única')`, [org]);
  await banco.query(`INSERT INTO tenancy_mapeamentos (tipo, chave, organization_id) VALUES ('loja', 'sul', $1)`, [org]);

  const medir = async () => {
    try {
      await banco.query(`INSERT INTO pedidos_ink (loja, ink_order_id) VALUES ('orfa', 1)`);
      await banco.query(`DELETE FROM pedidos_ink WHERE loja = 'orfa'`);
      return ['pedido da loja "orfa" foi atribuído à única Organization'];
    } catch (err) {
      assert.match(err.message, /sem mapeamento explícito para loja:orfa/);
      return [];
    }
  };

  let desfazer;
  await ciclo({
    medir,
    violar: async () => {
      desfazer = await substituirFuncao(banco, 'tenancy_org_do_mapeamento', 'text, text', `
        CREATE OR REPLACE FUNCTION tenancy_org_do_mapeamento(p_tipo TEXT, p_chave TEXT) RETURNS UUID
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
          SELECT coalesce(
            (SELECT organization_id FROM public.tenancy_mapeamentos WHERE tipo = p_tipo AND chave = p_chave),
            -- VIOLAÇÃO DELIBERADA (negative control): "se só há uma, é dela"
            (SELECT id FROM public.organizations WHERE (SELECT count(*) FROM public.organizations) = 1)
          )
        $fn$`);
    },
    restaurar: () => desfazer(),
    esperado: /atribuído à única Organization/,
  });
});

test('NC · INV-09 · cobertura do backfill: dado sem mapeamento NÃO passa com uma Organization', async (t) => {
  const pre = await h.criarBancoDescartavel('oria_nc2');
  t.after(() => pre.destruir());
  // Até tenancy-colunas: colunas existem, backfill ainda não rodou.
  assert.equal(h.migrar(pre.url, { posicionais: ['6'] }).status, 0);
  const banco = h.abrirPoolDescartavel(pre.url, { max: 1 });
  t.after(() => banco.end());
  await semearBaseLegada(banco, { lojas: ['sul'] });
  assert.equal(h.migrar(pre.url, { posicionais: ['2'] }).status, 0);
  const org = crypto.randomUUID();
  await banco.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'Única')`, [org]);
  // Tudo mapeado MENOS a loja sul: sobra exatamente um candidato — e continua sendo falta de dono.
  for (const [tipo, chave] of [['instalacao', '*'], ['meta', '*'], ['google_ads', '*'], ['creative_tenant', 'default'],
    ...manifesto.TABELAS_TENANT.filter((x) => x.regra === 'loja_ou_sem_loja').map((x) => ['sem_loja', x.tabela])]) {
    await banco.query('INSERT INTO tenancy_mapeamentos (tipo, chave, organization_id) VALUES ($1, $2, $3)', [tipo, chave, org]);
  }

  const medir = async () => {
    try {
      await banco.query('SELECT tenancy_exigir_cobertura()');
      return ['cobertura aceitou a loja sul sem mapeamento'];
    } catch (err) {
      assert.match(err.message, /loja:sul/);
      return [];
    }
  };

  let desfazer;
  await ciclo({
    medir,
    violar: async () => {
      await banco.query('ALTER FUNCTION tenancy_itens_sem_mapeamento() RENAME TO nc_itens_original');
      await banco.query(`
        CREATE FUNCTION tenancy_itens_sem_mapeamento() RETURNS SETOF TEXT LANGUAGE sql STABLE AS $fn$
          -- VIOLAÇÃO DELIBERADA (negative control): com uma Organization, nada "falta"
          SELECT x FROM nc_itens_original() AS x WHERE (SELECT count(*) FROM organizations) <> 1
        $fn$`);
      desfazer = async () => {
        await banco.query('DROP FUNCTION tenancy_itens_sem_mapeamento()');
        await banco.query('ALTER FUNCTION nc_itens_original() RENAME TO tenancy_itens_sem_mapeamento');
      };
    },
    restaurar: () => desfazer(),
    esperado: /aceitou a loja sul/,
  });
});

test('NC · efeito medido: com a cobertura correta, a migration de backfill aborta nesse mesmo banco', async (t) => {
  // Complemento do ciclo acima, no caminho real (CLI): uma Organization, loja sem dono → exit ≠ 0.
  const pre = await h.criarBancoDescartavel('oria_nc3');
  t.after(() => pre.destruir());
  assert.equal(h.migrar(pre.url, { posicionais: ['6'] }).status, 0);
  const banco = h.abrirPoolDescartavel(pre.url, { max: 1 });
  t.after(() => banco.end());
  await semearBaseLegada(banco, { lojas: ['sul', 'orfa'] });
  const r = h.migrar(pre.url, { env: { TENANCY_MAPPING_FILE: path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-b.json') } });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /loja:orfa/);
});

test('NC · sanidade: a base deste arquivo tem linhas de Organizations diferentes', async () => {
  const { rows } = await sup.query('SELECT count(DISTINCT organization_id)::int AS n FROM pedidos_ink');
  assert.equal(rows[0].n, 3);
  const sul = await comOrganization(app, SUL, (c) => c.query('SELECT count(*)::int AS n FROM pedidos_ink'));
  const centro = await comOrganization(app, CENTRO, (c) => c.query('SELECT count(*)::int AS n FROM pedidos_ink'));
  assert.equal(sul.rows[0].n, 1);
  assert.equal(centro.rows[0].n, 1);
});
