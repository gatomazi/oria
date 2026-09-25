'use strict';

// Fase 1 — migrations de tenancy contra bases descartáveis.
//
//   A  banco vazio → todas as migrations → schema final válido (sem mapeamento: não há dado)
//   B  base equivalente à atual (6 migrations + dado nas 55 tabelas) → pendentes → válido
//   C  PD-019 cenário A: 3 Stores independentes → 3 Organizations, zero órfãos, dono certo
//   D  PD-019 cenário B: operação consolidada → 1 Organization, zero órfãos
//   E  mapeamento ausente/incompleto → FALHA, e nada fica aplicado
//   F  mapeamento ambíguo → FALHA
//   +  INV-09: UMA Organization + loja sem mapeamento → FALHA (nunca "é a única")
//   +  rollback das 8 migrations da Fase 1 e reaplicação

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const h = require('./harness');
const { semearBaseLegada, MIGRATIONS_PRE_TENANCY, LOJAS } = require('../helpers/tenancy-legado');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const gates = h.sujeito('lib/platform/tenancy-gates.js');

const FIXTURES = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy');
const CENARIO_A = path.join(FIXTURES, 'cenario-a.json');
const CENARIO_B = path.join(FIXTURES, 'cenario-b.json');
const FASE1 = 8;
// Fases 2 (auth), 3 (tenant context), 4 (integrações), 5c, 7 (onboarding), o control plane
// (platform-admin), o aceite do convite (0020), o `store_id` do Connector Ink (0021), a
// reclassificação de features (0022), o entitlement canônico (0023), o catálogo canônico de
// Commerce da Fase D (0031), o Product Identity da Fase F (0032) e o entitlement de Product
// Performance da rodada H (0033) vêm depois; o rollback da Fase 1 desce todas.
const DEPOIS_DA_FASE1 = 30; // 21 (linha acima) +8 do Gerador de Criativos, renumeradas na integração para depois de
// 0033: 0034 (trace), 0035 (versão do plano/compiler), 0036 (feedback), 0037 (angles customizados), 0038
// (compat. de angles), 0039 (Product Enrichment), 0040 (provider_meta, Fase F.2.A) e 0041 (reserva de
// concorrência/orçamento do piloto, Fase F.2.B) +1 (0042, observabilidade/kill switch do catalog sync,
// renumerada por causa da mesma colisão de timestamp — ver comentário no PR)

const lerJson = (arquivo) => JSON.parse(fs.readFileSync(arquivo, 'utf8'));

function gravarTemporario(t, conteudo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-map-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, 'mapeamento.json');
  fs.writeFileSync(arquivo, JSON.stringify(conteudo));
  return arquivo;
}

// Base como a de produção: schema até creative-core-schema e dado em todas as tabelas.
async function baseLegada(t, opcoes) {
  const db = await h.criarBancoDescartavel('oria_mig1');
  t.after(() => db.destruir());
  const r = h.migrar(db.url, { posicionais: [String(MIGRATIONS_PRE_TENANCY)] });
  assert.equal(r.status, 0, `pré-tenancy falhou:\n${r.stdout}${r.stderr}`);
  const pool = h.abrirPoolDescartavel(db.url, { max: 2 });
  t.after(() => pool.end());
  await semearBaseLegada(pool, opcoes);
  return { db, pool };
}

async function aplicadas(pool) {
  return (await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n;
}

async function temColuna(pool, tabela, coluna) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tabela, coluna]
  );
  return rows.length > 0;
}

async function assertSchemaFinalValido(pool) {
  const v = await gates.inspecionarTenancy(pool, manifesto);
  assert.deepEqual(gates.todasAsViolacoes(v), []);
}

async function assertZeroOrfaosEDonoCerto(pool) {
  const { rows } = await pool.query('SELECT * FROM tenancy_problemas_de_ownership() AS p');
  assert.deepEqual(rows.map((r) => r.p), []);
  for (const x of manifesto.TABELAS_TENANT) {
    const { rows: n } = await pool.query(`SELECT count(*)::int AS n FROM ${x.tabela}`);
    assert.ok(n[0].n >= 1, `${x.tabela}: a base legada deveria ter dado aqui — o backfill não foi exercitado`);
  }
}

async function assertCardinalidade(pool, { organizations, stores }) {
  const { rows: [n] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM organizations) AS orgs,
            (SELECT count(*)::int FROM stores) AS stores,
            (SELECT count(*)::int FROM (SELECT organization_id FROM stores WHERE ativa GROUP BY 1 HAVING count(*) > 1) x) AS varias,
            (SELECT count(*)::int FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM stores s WHERE s.organization_id = o.id AND s.ativa)) AS sem_store,
            (SELECT count(*)::int FROM stores s WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = s.organization_id)) AS orfas`
  );
  assert.deepEqual(n, { orgs: organizations, stores, varias: 0, sem_store: 0, orfas: 0 });
  const v = await gates.inspecionarTenancy(pool, manifesto);
  assert.deepEqual(v.card1a1, []);
}

function assertFalhou(r, ...trechos) {
  const saida = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, `a migration deveria falhar:\n${saida.slice(-3000)}`);
  for (const t of trechos) assert.match(saida, t, `motivo esperado ausente:\n${saida.slice(-3000)}`);
}

async function assertNadaAplicado(pool) {
  assert.equal(await aplicadas(pool), MIGRATIONS_PRE_TENANCY, 'single-transaction: nenhuma migration da Fase 1 pode ficar');
  assert.equal(await temColuna(pool, 'pedidos_ink', 'organization_id'), false);
  const { rows } = await pool.query(`SELECT to_regclass('public.organizations') AS t`);
  assert.equal(rows[0].t, null);
}

test('A · banco vazio → todas as migrations → schema final válido', async (t) => {
  const db = await h.criarBancoDescartavel('oria_mig1');
  t.after(() => db.destruir());
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const pool = h.abrirPoolDescartavel(db.url);
  try {
    assert.equal(await aplicadas(pool), MIGRATIONS_PRE_TENANCY + FASE1 + DEPOIS_DA_FASE1);
    await assertSchemaFinalValido(pool);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM organizations');
    assert.equal(rows[0].n, 0, 'banco vazio não ganha Organization inventada');
    // E, sem mapeamento, nada entra sem dono.
    await assert.rejects(
      pool.query(`INSERT INTO app_config (chave, valor) VALUES ('x', '{}')`),
      /sem mapeamento explícito para instalacao:\*/
    );
  } finally { await pool.end(); }
});

test('B + C · base atual, PD-019 cenário A → 3 Organizations, dono certo em cada linha', async (t) => {
  const { db, pool } = await baseLegada(t);
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-3000)}${r.stderr}`);

  await assertSchemaFinalValido(pool);
  await assertZeroOrfaosEDonoCerto(pool);

  const orgs = (await pool.query('SELECT id FROM organizations ORDER BY id')).rows.map((x) => x.id);
  assert.equal(orgs.length, 3);
  const mapa = lerJson(CENARIO_A);
  const donoDaLoja = Object.fromEntries(mapa.mapeamentos.filter((m) => m.tipo === 'loja').map((m) => [m.chave, m.organizationId]));
  const sul = donoDaLoja.sul;

  // Cada loja → a sua Organization; loja NULL e estado de instalação → o dono DECLARADO (Sul).
  const { rows: pedidos } = await pool.query('SELECT loja, organization_id FROM pedidos_ink');
  for (const p of pedidos) assert.equal(p.organization_id, donoDaLoja[p.loja], `pedido da loja ${p.loja}`);
  const { rows: semLoja } = await pool.query('SELECT DISTINCT organization_id FROM webhook_eventos WHERE loja IS NULL');
  assert.deepEqual(semLoja.map((x) => x.organization_id), [sul]);
  for (const tabela of ['app_config', 'meta_connections', 'google_ads_customers', 'creative_jobs']) {
    const { rows } = await pool.query(`SELECT DISTINCT organization_id FROM ${tabela}`);
    assert.deepEqual(rows.map((x) => x.organization_id), [sul], tabela);
  }
  // Filho herda do pai, que herdou da loja.
  const { rows: filhos } = await pool.query(
    `SELECT c.loja, r.organization_id FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id`
  );
  assert.equal(filhos.length, LOJAS.length);
  for (const f of filhos) assert.equal(f.organization_id, donoDaLoja[f.loja]);

  // 3 Organizations, 3 Stores, exatamente 1 Store por Organization.
  await assertCardinalidade(pool, { organizations: 3, stores: 3 });
  const { rows: stores } = await pool.query('SELECT organization_id, loja_legada FROM stores ORDER BY loja_legada');
  assert.deepEqual(stores.map((s) => [s.loja_legada, s.organization_id]).sort(),
    Object.entries(donoDaLoja).sort());
});

test('D · PD-019 cenário B → 1 Organization consolidada, zero órfãos', async (t) => {
  const { db, pool } = await baseLegada(t);
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_B } });
  assert.equal(r.status, 0, `${r.stdout.slice(-3000)}${r.stderr}`);

  await assertSchemaFinalValido(pool);
  await assertZeroOrfaosEDonoCerto(pool);
  const [org] = lerJson(CENARIO_B).organizations;
  for (const x of manifesto.TABELAS_TENANT) {
    const { rows } = await pool.query(`SELECT DISTINCT organization_id FROM ${x.tabela}`);
    assert.deepEqual(rows.map((y) => y.organization_id), [org.id], x.tabela);
  }
  // 1 Organization + 1 Store (Use Origens). Os três valores legados de loja convergem para ela no
  // dado — e NÃO viram Stores.
  await assertCardinalidade(pool, { organizations: 1, stores: 1 });
  const { rows: st } = await pool.query('SELECT count(*)::int AS n FROM stores WHERE organization_id = $1', [org.id]);
  assert.equal(st[0].n, 1, 'a Organization Use Origens tem exatamente uma Store');
  assert.equal((await pool.query('SELECT count(DISTINCT loja)::int AS n FROM pedidos_ink')).rows[0].n, 3,
    'as três origens legadas continuam no dado, todas da mesma Organization');
});

test('E1 · base com dado e SEM mapeamento → falha listando cada item, nada aplicado', async (t) => {
  const { db, pool } = await baseLegada(t);
  const r = h.migrar(db.url);
  assertFalhou(r, /dado sem dono declarado/, /loja:sul/, /loja:centro/, /loja:norte/,
    /sem_loja:webhook_eventos/, /instalacao:\*/, /meta:\*/, /google_ads:\*/, /creative_tenant:default/);
  await assertNadaAplicado(pool);
});

test('E2 · mapeamento sem uma loja que existe no dado → falha, nada aplicado', async (t) => {
  const { db, pool } = await baseLegada(t, { lojas: ['sul', 'centro', 'norte', 'extra'] });
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assertFalhou(r, /loja:extra/);
  await assertNadaAplicado(pool);
});

test('E3 · mapeamento que não cobre o código em execução → falha antes do SQL', async (t) => {
  const { db, pool } = await baseLegada(t);
  const incompleto = lerJson(CENARIO_A);
  incompleto.mapeamentos = incompleto.mapeamentos.filter((m) => !(m.tipo === 'sem_loja' && m.chave === 'audit_log'));
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: gravarTemporario(t, incompleto) } });
  assertFalhou(r, /incompleto para o código em execução/, /sem_loja:audit_log/);
  await assertNadaAplicado(pool);
});

test('F1 · a mesma loja mapeada para duas Organizations → falha (ambíguo)', async (t) => {
  const { db, pool } = await baseLegada(t);
  const ambiguo = lerJson(CENARIO_A);
  const centro = ambiguo.organizations[1].id;
  ambiguo.mapeamentos.push({ tipo: 'loja', chave: 'sul', organizationId: centro });
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: gravarTemporario(t, ambiguo) } });
  assertFalhou(r, /loja:sul mapeado mais de uma vez/, /ambíguo/);
  await assertNadaAplicado(pool);
});

test('F2 · duas Stores reivindicando a mesma loja legada → falha (ambíguo)', async (t) => {
  const { db, pool } = await baseLegada(t);
  const ambiguo = lerJson(CENARIO_A);
  ambiguo.organizations[1].store.lojaLegada = 'sul';
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: gravarTemporario(t, ambiguo) } });
  assertFalhou(r, /lojaLegada "sul" reivindicada por duas stores/);
  await assertNadaAplicado(pool);
});

test('F3 · mapeamento divergente do que já está no banco → falha, nada sobrescrito', async (t) => {
  const { db, pool } = await baseLegada(t);
  assert.equal(h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } }).status, 0);
  const outro = lerJson(CENARIO_A);
  // Mesmas organizations, mas meta:* trocado de dono — um segundo arquivo não pode reescrever o primeiro.
  outro.mapeamentos = outro.mapeamentos.map((m) =>
    (m.tipo === 'meta' ? { ...m, organizationId: outro.organizations[2].id } : m));
  const { aplicarMapeamento } = await import(path.join(h.RAIZ_REPO, 'scripts', 'tenancy', 'aplicar-mapeamento.mjs'));
  await assert.rejects(aplicarMapeamento(db.url, gravarTemporario(t, outro)), /meta:\* já pertence a outra organization/);
  const { rows } = await pool.query(`SELECT organization_id FROM tenancy_mapeamentos WHERE tipo = 'meta'`);
  assert.equal(rows[0].organization_id, outro.organizations[0].id);
});

test('INV-09 · UMA Organization e uma loja sem mapeamento → falha; nunca "é a única"', async (t) => {
  const { db, pool } = await baseLegada(t);
  const umaSo = lerJson(CENARIO_B);
  // Cenário B sem a loja centro: continua existindo exatamente uma Organization candidata.
  umaSo.mapeamentos = umaSo.mapeamentos.filter((m) => !(m.tipo === 'loja' && m.chave === 'centro'));
  assert.equal(umaSo.organizations.length, 1);
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: gravarTemporario(t, umaSo) } });
  // Barrado pela completude de runtime (centro está no enum do código)...
  assertFalhou(r, /loja:centro/);
  await assertNadaAplicado(pool);
});

test('INV-09 · UMA Organization: o banco (não só o JS) recusa inferir dono no backfill e no trigger', async (t) => {
  // Base com dado só da loja sul e uma loja "orfa" que não existe no enum — a completude de runtime
  // passa, e o que decide é a cobertura NO BANCO.
  const { db, pool } = await baseLegada(t, { lojas: ['sul', 'orfa'] });
  const umaSo = lerJson(CENARIO_B);
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: gravarTemporario(t, umaSo) } });
  assertFalhou(r, /loja:orfa/);
  await assertNadaAplicado(pool);

  // Sem a loja órfã, migra; depois disso o TRIGGER também não atribui a loja desconhecida à única org.
  for (const x of manifesto.TABELAS_TENANT.filter((y) => y.regra === 'loja' || y.regra === 'loja_ou_sem_loja')) {
    await pool.query(`DELETE FROM ${x.tabela} WHERE loja = 'orfa'`);
  }
  await pool.query(`DELETE FROM integrations WHERE escopo = 'orfa'`);
  const r2 = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: gravarTemporario(t, umaSo) } });
  assert.equal(r2.status, 0, `${r2.stdout.slice(-2000)}${r2.stderr}`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n, 1);
  await assert.rejects(
    pool.query(`INSERT INTO pedidos_ink (loja, ink_order_id) VALUES ('orfa', 1)`),
    /sem mapeamento explícito para loja/
  );
});

test('rollback · as 8 migrations da Fase 1 descem e sobem de novo sem perder dado', async (t) => {
  const { db, pool } = await baseLegada(t);
  assert.equal(h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } }).status, 0);
  const antes = (await pool.query('SELECT count(*)::int AS n FROM pedidos_ink')).rows[0].n;

  const down = h.migrar(db.url, { comando: 'down', posicionais: [String(FASE1 + DEPOIS_DA_FASE1)] });
  assert.equal(down.status, 0, `${down.stdout.slice(-3000)}${down.stderr}`);
  await assertNadaAplicado(pool);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pedidos_ink')).rows[0].n, antes);
  const { rows: chk } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'meta_connections_id_check'`
  );
  assert.equal(chk.length, 1, 'o down restaura o desenho anterior');

  const up = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(up.status, 0, `${up.stdout.slice(-3000)}${up.stderr}`);
  await assertSchemaFinalValido(pool);
  await assertZeroOrfaosEDonoCerto(pool);
});
