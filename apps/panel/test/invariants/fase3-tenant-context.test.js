'use strict';

// Fase 3 — tenant context + entitlements, sob a role da aplicação (NOSUPERUSER, NOBYPASSRLS, não
// dona). Os módulos vêm do harness: os negative controls trocam esses arquivos por versões
// defeituosas e este arquivo precisa reprovar.
//
// Pessoas (cenário A: Org A = sul, Org B = centro, Org N = norte):
//   A  owner de A          B  owner de B          C  member de A e de B
//   D  member de A         E  owner de N

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');

const h = require('./harness');
const { concederFeatures } = require('../helpers/linhas');
const { createAuth, resolverConfigAuth } = h.sujeito('lib/auth/index.js');
const { createLoginLimiter } = h.sujeito('lib/auth/rate-limit.js');
const senhas = h.sujeito('lib/auth/password.js');
const { comOrganization } = h.sujeito('lib/platform/tenant-db.js');
const { registrarAuditoria } = h.sujeito('lib/platform/audit.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const pipeline = h.sujeito('lib/platform/tenant-pipeline.js');
const entitlements = h.sujeito('lib/platform/entitlements.js');
const ownership = h.sujeito('lib/platform/ownership.js');
const { createJobRunner } = h.sujeito('lib/platform/jobs.js');
const { createPgStore } = h.sujeito('lib/creative-core/pgStore.js');

const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_A = 'a1000000-0000-4000-8000-000000000001';
const ORG_B = 'a1000000-0000-4000-8000-000000000002';
const ORG_N = 'a1000000-0000-4000-8000-000000000003';
const SENHA = 'senha-forte-de-teste-123';
const SEGREDO = crypto.randomBytes(32).toString('base64url');
const ROLE = `oria_app_f3_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const silencioso = { log() {}, error() {}, warn() {} };

const pessoas = {};
const segmentos = {};
let db;
let sup;
let appPool;
let fachada;
let base;
let servidor;

async function criarPessoa(chave, memberships) {
  const email = `f3-${chave.toLowerCase()}@teste.oria`;
  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [email, `Pessoa ${chave}`, await senhas.gerarHash(SENHA)]
  );
  for (const [org, papel] of memberships) {
    await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, papel]);
  }
  pessoas[chave] = { id: u.id, email };
}

async function semearSegmento(org, nome) {
  const { rows: [s] } = await sup.query(
    'INSERT INTO segments (organization_id, nome) VALUES ($1, $2) RETURNING id', [org, nome]
  );
  return String(s.id);
}

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo, headers = {} } = {}) => {
    const h2 = { ...headers };
    if (corpo !== undefined) h2['Content-Type'] = 'application/json';
    if (nav.cookie) h2.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') h2['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, { method: metodo, headers: h2, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) nav.cookie = setCookie.split(';')[0];
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json };
  };
  nav.entrar = async (chave) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email: pessoas[chave].email, password: SENHA } });
    assert.equal(r.status, 200);
    return nav;
  };
  return nav;
}

const sessaoNoBanco = async (cookie) => {
  const id = crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  return (await sup.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0];
};

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_f3');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPool = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 4 });
  fachada = runtime.criarPoolTenant(appPool);

  await criarPessoa('A', [[ORG_A, 'owner']]);
  await criarPessoa('B', [[ORG_B, 'owner']]);
  await criarPessoa('C', [[ORG_A, 'member'], [ORG_B, 'member']]);
  await criarPessoa('D', [[ORG_A, 'member']]);
  await criarPessoa('E', [[ORG_N, 'owner']]);
  segmentos.A = await semearSegmento(ORG_A, 'segmento de A');
  segmentos.B = await semearSegmento(ORG_B, 'segmento de B');
  await semearSegmento(ORG_N, 'segmento de N');

  // Plano explícito só para A (TD-012: nada ligado por omissão). B recebe assinatura com a feature
  // DESLIGADA e, de quebra, um `app_config` com o velho "quase true" — que não concede mais nada.
  await concederFeatures(sup, ORG_A, { financial: true });
  await concederFeatures(sup, ORG_B, { financial: false });
  await sup.query(
    `INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'entitlements', '{"financial":"true"}'::jsonb)`, [ORG_B]
  );

  const auth = createAuth({
    pool: appPool,
    config: resolverConfigAuth({ ADMIN_SESSION_SECRET: SEGREDO }),
    comOrganization,
    auditar: (e) => registrarAuditoria(appPool, e),
    limiter: createLoginLimiter(),
  });
  const tenant = pipeline.createTenantPipeline({ poolReal: appPool });
  const carregador = entitlements.carregadorDaOrganizacao(fachada);
  const exigirRecurso = ownership.criarExigirRecurso(() => fachada);
  const ctx = [auth.requireAuth, tenant.requireOrganizationContext];

  const app = express();
  app.use(express.json());
  app.use('/api/admin', auth.router);
  app.get('/api/admin/segments', ...ctx, async (req, res) => {
    const { rows } = await fachada.query('SELECT id::text AS id, organization_id FROM segments ORDER BY id');
    res.json({ tenant: req.tenant, itens: rows });
  });
  app.post('/api/admin/segments', ...ctx, (req, res) => res.json({ ok: true }));
  app.get('/api/admin/segments/:id', ...ctx, exigirRecurso('segments'), (req, res) => res.json({ id: String(req.recurso.id) }));
  app.get('/api/admin/financeiro', ...ctx, entitlements.requireEntitlement(carregador, 'financial'), (req, res) => res.json({ ok: true }));
  app.get('/api/admin/entitlements', ...ctx, async (req, res) => res.json(await entitlements.planoEfetivo(carregador)));
  servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  if (servidor) await new Promise((r) => servidor.close(r));
  await appPool?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

const ids = (r) => r.json.itens.map((x) => x.id);

// ── Pipeline: Organization só da sessão ──────────────────────────────────────────────────────

test('fase 3 · A e B veem só a própria Organization; Store e loja vêm do contexto', async () => {
  const a = await navegador().entrar('A');
  const ra = await a.req('GET', '/api/admin/segments');
  assert.equal(ra.status, 200);
  assert.deepEqual(ids(ra), [segmentos.A]);
  assert.deepEqual([ra.json.tenant.organizationId, ra.json.tenant.loja, ra.json.tenant.papel], [ORG_A, 'sul', 'owner']);

  const b = await navegador().entrar('B');
  const rb = await b.req('GET', '/api/admin/segments');
  assert.deepEqual(ids(rb), [segmentos.B]);
  assert.equal(rb.json.tenant.loja, 'centro');
});

test('fase 3 · seletor de tenant no request é 400 TENANT_SELECTOR_NOT_ALLOWED', async () => {
  const a = await navegador().entrar('A');
  for (const q of ['loja=centro', 'store_id=x', `organization_id=${ORG_B}`, `organizationId=${ORG_B}`, 'tenant_id=x']) {
    const r = await a.req('GET', `/api/admin/segments?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.codigo, 'TENANT_SELECTOR_NOT_ALLOWED', q);
  }
  for (const hdr of ['X-Organization-Id', 'X-Store-Id', 'X-Tenant-Id', 'X-Loja']) {
    const r = await a.req('GET', '/api/admin/segments', { headers: { [hdr]: ORG_B } });
    assert.equal(r.status, 400, hdr);
  }
  const corpo = await a.req('POST', '/api/admin/segments', { corpo: { nome: 'x', organization_id: ORG_B } });
  assert.equal(corpo.status, 400);
  assert.equal((await a.req('POST', '/api/admin/segments', { corpo: { nome: 'x' } })).status, 200);
});

// ── User C: mais de um membership ─────────────────────────────────────────────────────────────

test('fase 3 · User C precisa escolher; escolha passa pelo membership; troca muda o contexto inteiro', async () => {
  const c = await navegador().entrar('C');
  const sem = await c.req('GET', '/api/admin/segments');
  assert.equal(sem.status, 409);
  assert.equal(sem.json.codigo, 'ORGANIZATION_CONTEXT_REQUIRED');
  assert.equal((await sessaoNoBanco(c.cookie)).active_organization_id, null, 'nenhuma Organization escolhida por ele');

  // Organization que existe, mas de que C não é membro: indistinguível de inexistente.
  const alheia = await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_N } });
  assert.equal(alheia.status, 404);
  assert.equal((await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_B, loja: 'sul' } })).status, 400);
  assert.equal((await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: 'nao-uuid' } })).status, 400);
  assert.equal((await c.req('GET', '/api/admin/segments')).status, 409, 'tentativas recusadas não gravam nada');

  const paraB = await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_B } });
  assert.equal(paraB.status, 200);
  assert.deepEqual([paraB.json.organizacaoAtiva.id, paraB.json.organizacaoAtiva.papel], [ORG_B, 'member']);
  const emB = await c.req('GET', '/api/admin/segments');
  assert.deepEqual(ids(emB), [segmentos.B]);
  assert.equal(emB.json.tenant.loja, 'centro');
  assert.equal((await c.req('GET', `/api/admin/segments/${segmentos.A}`)).status, 404, 'recurso de A invisível em B');

  await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_A } });
  const emA = await c.req('GET', '/api/admin/segments');
  assert.deepEqual(ids(emA), [segmentos.A]);
  assert.equal((await c.req('GET', `/api/admin/segments/${segmentos.B}`)).status, 404);

  const sessao = await c.req('GET', '/api/admin/session');
  assert.equal(sessao.json.organizacaoAtiva.id, ORG_A);
  assert.equal(sessao.json.organizacaoAtiva.loja, 'sul', 'loja da Store, só para exibição');
});

test('fase 3 · membership removido: a sessão perde a Organization e a request é 403 — nunca troca em silêncio', async () => {
  const c = await navegador().entrar('C');
  await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_B } });
  await sup.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [ORG_B, pessoas.C.id]);
  try {
    const r = await c.req('GET', '/api/admin/segments');
    assert.equal(r.status, 403);
    assert.equal(r.json.codigo, 'ORGANIZATION_ACCESS_REVOKED');
    assert.equal(r.json.itens, undefined, 'nenhum dado de outra Organization na mesma resposta');
    assert.equal((await sessaoNoBanco(c.cookie)).active_organization_id, null);
  } finally {
    await sup.query(`INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'member')`, [ORG_B, pessoas.C.id]);
  }
});

test('fase 3 · pessoa sem membership nenhum é 403', async () => {
  const { rows: [u] } = await sup.query(
    `INSERT INTO users (email, password_hash) VALUES ('f3-orfa@teste.oria', $1) RETURNING id`, [await senhas.gerarHash(SENHA)]
  );
  pessoas.O = { id: u.id, email: 'f3-orfa@teste.oria' };
  const o = await navegador().entrar('O');
  const r = await o.req('GET', '/api/admin/segments');
  assert.equal(r.status, 403);
  assert.equal(r.json.codigo, 'NO_ORGANIZATION_MEMBERSHIP');
});

// ── Store da Organization ─────────────────────────────────────────────────────────────────────

test('fase 3 · Organization sem Store ativa é 409; mais de uma Store é erro de integridade', async () => {
  const e = await navegador().entrar('E');
  assert.equal((await e.req('GET', '/api/admin/segments')).status, 200);
  await sup.query('UPDATE stores SET ativa = false WHERE organization_id = $1', [ORG_N]);
  try {
    const r = await e.req('GET', '/api/admin/segments');
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'STORE_NOT_FOUND');
  } finally {
    await sup.query('UPDATE stores SET ativa = true WHERE organization_id = $1', [ORG_N]);
  }

  // O banco impede duas Stores por Organization (uq_stores_organization); a aplicação não conta
  // com isso: duas linhas também são erro, nunca "a primeira".
  const cliente = { query: async (sql) => (/FROM stores/.test(sql) ? { rows: [{ id: 's1', loja_legada: 'sul' }, { id: 's2', loja_legada: 'x' }] } : { rows: [] }), release() {} };
  const poolFalso = { connect: async () => cliente };
  const erroOriginal = console.error;
  console.error = () => {};
  try {
    await assert.rejects(pipeline.resolverStore(poolFalso, ORG_A), (err) => err.codigo === 'STORE_INTEGRITY_ERROR');
  } finally {
    console.error = erroOriginal;
  }
});

// ── Ownership por id ──────────────────────────────────────────────────────────────────────────

test('fase 3 · recurso por id de outra Organization é 404, igual a inexistente', async () => {
  const a = await navegador().entrar('A');
  assert.deepEqual((await a.req('GET', `/api/admin/segments/${segmentos.A}`)).json, { id: segmentos.A });
  for (const id of [segmentos.B, '999999999', 'nao-numero']) {
    const r = await a.req('GET', `/api/admin/segments/${id}`);
    assert.equal(r.status, 404, id);
    assert.deepEqual(r.json, { error: 'não encontrado' });
  }
});

test('fase 3 · ownership é da aplicação também: sem RLS por baixo, o recurso de B continua 404 para A', async () => {
  // `sup` ignora RLS (superusuário). Se o carregador perder o predicado de Organization ou a
  // conferência de dono, é aqui que aparece.
  const exigir = ownership.criarExigirRecurso(() => sup)('segments');
  const chamar = (id) => new Promise((resolve, reject) => {
    const req = { params: { id } };
    const res = { status(c) { this.c = c; return this; }, json(o) { resolve({ status: this.c, corpo: o }); } };
    runtime.comContexto({ organizationId: ORG_A, origem: 'teste' }, () => exigir(req, res, () => resolve({ status: 200, recurso: req.recurso })))
      .catch(reject);
  });
  assert.equal((await chamar(segmentos.A)).status, 200);
  assert.equal((await chamar(segmentos.B)).status, 404);
  const semContexto = await new Promise((resolve) => {
    const res = { status(c) { this.c = c; return this; }, json() { resolve(this.c); } };
    exigir({ params: { id: segmentos.A } }, res, () => resolve(200));
  });
  assert.notEqual(semContexto, 200, 'sem contexto não há dono a conferir');
});

// ── Entitlements (TD-012) ─────────────────────────────────────────────────────────────────────

test('fase 3 · TD-012: feature só com true explícito da Organization da sessão', async () => {
  const a = await navegador().entrar('A');
  assert.equal((await a.req('GET', '/api/admin/financeiro')).status, 200);
  const planoA = (await a.req('GET', '/api/admin/entitlements')).json;
  assert.equal(planoA.financial, true);
  assert.equal(planoA.whatsapp, false, 'feature não semeada é false, nunca default true');

  const b = await navegador().entrar('B');
  assert.equal((await b.req('GET', '/api/admin/financeiro')).status, 403, '"true" string não concede');
  assert.equal((await b.req('GET', '/api/admin/entitlements')).json.financial, false);

  const e = await navegador().entrar('E');
  const semPlano = await e.req('GET', '/api/admin/financeiro');
  assert.deepEqual([semPlano.status, semPlano.json], [403, { erro: 'feature_nao_disponivel', feature: 'financial' }]);

  // O plano de A não vaza para C quando C está em B.
  const c = await navegador().entrar('C');
  await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_B } });
  assert.equal((await c.req('GET', '/api/admin/financeiro')).status, 403);
  await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_A } });
  assert.equal((await c.req('GET', '/api/admin/financeiro')).status, 200);
});

test('fase 3 · TD-012: carregador sem contexto, feature desconhecida e plano desligado negam', async () => {
  const carregador = entitlements.carregadorDaOrganizacao(fachada);
  await assert.rejects(entitlements.checkEntitlement(carregador, 'financial'), entitlements.EntitlementDeniedError);
  await runtime.comContexto({ organizationId: ORG_A }, async () => {
    assert.equal(await entitlements.checkEntitlement(carregador, 'financial'), true);
    await assert.rejects(entitlements.checkEntitlement(carregador, 'criativos'), entitlements.EntitlementDeniedError);
    await assert.rejects(entitlements.checkEntitlement(carregador, 'whatsapp'), entitlements.EntitlementDeniedError);
  });
  // Desligar a feature é no PLANO, que é a fonte. Mexer em app_config não muda mais nada.
  await concederFeatures(sup, ORG_A, { financial: false });
  try {
    await runtime.comContexto({ organizationId: ORG_A }, async () => {
      await assert.rejects(entitlements.checkEntitlement(carregador, 'financial'), entitlements.EntitlementDeniedError);
    });
  } finally {
    await concederFeatures(sup, ORG_A, { financial: true });
  }
});

test('OPS-21 · seed de entitlements: explícito, vocabulário fechado, idempotente', async () => {
  const { seedEntitlements } = await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'tenancy', 'seed-entitlements.mjs')));
  assert.deepEqual(await seedEntitlements(db.url, {}), { feito: false, motivo: 'sem configuração de seed' });
  await assert.rejects(seedEntitlements(db.url, { ENTITLEMENTS_SEED_FEATURES: 'financial' }), /ORGANIZATION_IDS/);
  await assert.rejects(seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: ORG_N, ENTITLEMENTS_SEED_FEATURES: 'tudo' }), /vocabulário/);
  await assert.rejects(
    seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: crypto.randomUUID(), ENTITLEMENTS_SEED_FEATURES: 'catalog' }),
    /inexistente/
  );
  for (let i = 0; i < 2; i += 1) {
    await seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: ORG_N, ENTITLEMENTS_SEED_FEATURES: 'catalog' });
  }
  const { rows } = await sup.query(`SELECT valor FROM app_config WHERE organization_id = $1 AND chave = 'entitlements'`, [ORG_N]);
  assert.deepEqual(rows.map((r) => r.valor), [{ catalog: true }]);
  // `app_config` só tem linha de quem foi semeado por este script legado (ORG_N) e da linha de
  // compatibilidade que este arquivo planta em B. A concessão real de A e B vem do PLANO, e não
  // deixa rastro aqui — é a diferença que a migration 0023 introduziu.
  const { rows: outras } = await sup.query(`SELECT organization_id FROM app_config WHERE chave = 'entitlements' ORDER BY organization_id`);
  assert.deepEqual(outras.map((r) => r.organization_id), [ORG_B, ORG_N]);
});

// ── Runtime: modo estrito ─────────────────────────────────────────────────────────────────────

test('fase 3 · fachada: tabela tenant-owned sem contexto é erro; com contexto, só a Organization dele', async () => {
  await assert.rejects(fachada.query('SELECT count(*) FROM segments'), (err) => err.codigo === 'TENANT_CONTEXT_REQUIRED');
  await assert.rejects(fachada.query('UPDATE segments SET nome = nome'), (err) => err.codigo === 'TENANT_CONTEXT_REQUIRED');
  assert.equal((await fachada.query('SELECT 1 AS um')).rows[0].um, 1, 'query sem tabela de tenant passa');

  await runtime.comContexto({ organizationId: ORG_B }, async () => {
    const { rows } = await fachada.query('SELECT organization_id FROM segments');
    assert.deepEqual([...new Set(rows.map((r) => r.organization_id))], [ORG_B]);
    // Cliente dedicado com transação explícita recebe o mesmo contexto.
    const cli = await fachada.connect();
    try {
      await cli.query('BEGIN');
      const { rows: dentro } = await cli.query('SELECT organization_id FROM segments');
      await cli.query('COMMIT');
      assert.deepEqual([...new Set(dentro.map((r) => r.organization_id))], [ORG_B]);
    } finally {
      cli.release();
    }
    // semContexto desfaz a Organization herdada.
    await runtime.semContexto(() => assert.rejects(fachada.query('SELECT 1 FROM segments'), (err) => err.codigo === 'TENANT_CONTEXT_REQUIRED'));
  });
  assert.equal(runtime.contextoAtual(), null);
  assert.throws(() => runtime.comContexto({ organizationId: 'x' }, () => {}), /organizationId válido/);
});

// ── Jobs (INV-17) ─────────────────────────────────────────────────────────────────────────────

test('INV-17 · job roda uma vez por Organization ativa, cada uma no próprio contexto, sob a role da aplicação', async () => {
  const jobs = createJobRunner({ poolReal: appPool, logger: silencioso });
  const vistos = [];
  const r = await jobs.executarPorOrganizacao('teste', async (org) => {
    const { rows } = await fachada.query('SELECT organization_id, id::text AS id FROM segments');
    vistos.push({ org: org.organizationId, loja: org.loja, donos: [...new Set(rows.map((x) => x.organization_id))], ids: rows.map((x) => x.id) });
  });
  assert.deepEqual(r, { organizacoes: 3, executadas: 3, puladas: 0, falhas: 0 });
  assert.deepEqual(vistos.map((v) => [v.org, v.loja]), [[ORG_A, 'sul'], [ORG_B, 'centro'], [ORG_N, 'norte']]);
  for (const v of vistos) assert.deepEqual(v.donos, [v.org], `job de ${v.org} viu dado de outra Organization`);
  assert.ok(vistos[0].ids.includes(segmentos.A) && !vistos[0].ids.includes(segmentos.B));
  assert.equal(runtime.contextoAtual(), null, 'nenhum contexto sobra depois do job');
});

test('INV-17 · falha numa Organization não derruba as outras; Organization suspensa fica fora', async () => {
  const jobs = createJobRunner({ poolReal: appPool, logger: silencioso });
  const ok = [];
  const r = await jobs.executarPorOrganizacao('teste', async (org) => {
    if (org.organizationId === ORG_A) throw new Error('falha só de A');
    ok.push(org.organizationId);
  });
  assert.deepEqual(r, { organizacoes: 3, executadas: 2, puladas: 0, falhas: 1 });
  assert.deepEqual(ok, [ORG_B, ORG_N]);

  await sup.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ORG_N]);
  try {
    assert.deepEqual((await jobs.organizacoes()).map((o) => o.organizationId), [ORG_A, ORG_B]);
  } finally {
    await sup.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [ORG_N]);
  }
});

test('INV-17 · timer agendado dentro de uma request não herda a Organization dela', async () => {
  const jobs = createJobRunner({ poolReal: appPool, logger: silencioso });
  const contextos = await new Promise((resolve) => {
    runtime.comContexto({ organizationId: ORG_A }, () => {
      const vistos = [];
      const timer = jobs.agendar('teste-timer', 20, async (org) => {
        vistos.push(org.organizationId);
        if (vistos.length === 3) { clearInterval(timer); resolve(vistos); }
      });
    });
  });
  assert.deepEqual(contextos, [ORG_A, ORG_B, ORG_N]);
});

// ── Resolvedores sem sessão ───────────────────────────────────────────────────────────────────

test('fase 3 · resolvedores sem sessão devolvem uma Organization ou nada, sob a role da aplicação', async () => {
  const f = async (sql, v) => (await appPool.query(`SELECT ${sql}($1) AS id`, [v])).rows[0].id;
  assert.equal(await f('tenancy_organization_da_loja', 'centro'), ORG_B);
  assert.equal(await f('tenancy_organization_da_loja', 'inexistente'), null);

  const pedido = crypto.randomBytes(9).toString('base64url');
  await sup.query(`INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'pedidos', $2::jsonb)`, [ORG_A, JSON.stringify({ [pedido]: { loja: 'sul' } })]);
  assert.equal(await f('publico_organization_do_pedido', pedido), ORG_A);
  assert.equal(await f('publico_organization_do_pedido', 'outro-id-qualquer'), null);
  // Mesmo id em duas Organizations: ambíguo → nada, nunca "a primeira".
  await sup.query(`INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'pedidos', $2::jsonb)`, [ORG_B, JSON.stringify({ [pedido]: { loja: 'centro' } })]);
  assert.equal(await f('publico_organization_do_pedido', pedido), null);

  const hash = crypto.randomBytes(32).toString('hex');
  await sup.query(`INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'whatsapp-web-agente', $2::jsonb)`, [ORG_B, JSON.stringify({ tokenHash: hash })]);
  assert.equal(await f('publico_organization_do_agente', hash), ORG_B);
  assert.equal(await f('publico_organization_do_agente', 'x'.repeat(64)), null);

  const token = crypto.randomBytes(24).toString('hex');
  await sup.query(
    `INSERT INTO media_assets (organization_id, loja, kind, filename, original_filename, mime_type, size_bytes, storage_key, public_token)
     VALUES ($1, 'centro', 'template_sample', 'a.png', 'a.png', 'image/png', 1, 'uploads/a.png', $2)`, [ORG_B, token]
  );
  assert.equal(await f('publico_organization_da_midia', token), ORG_B);
  assert.equal(await f('publico_organization_da_midia', 'nada'), null);

  // A role da aplicação continua sem ler o mapeamento direto.
  await assert.rejects(appPool.query('SELECT * FROM tenancy_mapeamentos'), /permission denied/);
});

// ── Creative Core sob a role da aplicação (INV-22) ───────────────────────────────────────────

test('INV-22 · pgStore do Creative Core pela fachada: cada Organization no próprio contexto', async () => {
  const store = createPgStore(fachada);
  const id = crypto.randomUUID();
  await assert.rejects(store.listProfiles('brand', ORG_A), (err) => err.codigo === 'TENANT_CONTEXT_REQUIRED');
  await runtime.comContexto({ organizationId: ORG_A }, () => store.createProfile('brand', ORG_A, { id, data: { name: 'Kit A' }, status: 'active' }));
  await runtime.comContexto({ organizationId: ORG_A }, async () => {
    assert.equal((await store.listProfiles('brand', ORG_A)).length, 1);
  });
  await runtime.comContexto({ organizationId: ORG_B }, async () => {
    // B pede o tenant de A: a RLS devolve nada, e gravar como A é recusado.
    assert.equal((await store.listProfiles('brand', ORG_A)).length, 0);
    assert.equal(await store.getProfile('brand', ORG_A, id), null);
    await assert.rejects(store.createProfile('brand', ORG_A, { id: crypto.randomUUID(), data: {}, status: 'active' }), /row-level security/);
  });
  const { rows } = await sup.query('SELECT tenant_id, organization_id FROM creative_brand_profiles WHERE id = $1', [id]);
  assert.deepEqual(rows, [{ tenant_id: ORG_A, organization_id: ORG_A }]);
});
