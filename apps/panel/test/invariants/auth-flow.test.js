'use strict';

// Fase 2 — identidade individual, sessão revogável, CSRF, fixation, papéis e audit atribuível.
//
// A app aqui é montada com os mesmos módulos que o server.js usa (lib/auth, lib/platform/audit),
// carregados pelo harness — os negative controls trocam esses arquivos por versões defeituosas e
// este arquivo precisa reprovar. O banco é descartável, migrado do zero, e a app conecta com uma
// role SEM SUPERUSER e SEM BYPASSRLS: a autenticação precisa funcionar sob RLS forçada.
//
// Pessoas (cenário A de PD-019: Org A = sul, Org B = centro):
//   A  owner de Org A          B  owner de Org B
//   C  member de A e de B      D  member de A
//   E  owner de A e de B

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const h = require('./harness');
const { createAuth, resolverConfigAuth } = h.sujeito('lib/auth/index.js');
const { createLoginLimiter } = h.sujeito('lib/auth/rate-limit.js');
const senhas = h.sujeito('lib/auth/password.js');
const { comOrganization } = h.sujeito('lib/platform/tenant-db.js');
const { registrarAuditoria } = h.sujeito('lib/platform/audit.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');

const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_A = 'a1000000-0000-4000-8000-000000000001';
const ORG_B = 'a1000000-0000-4000-8000-000000000002';
const SENHA = 'senha-forte-de-teste-123';
const SENHA_LEGADA = 'senha-compartilhada-legada';
const SEGREDO = crypto.randomBytes(32).toString('base64url');
const ROLE = `oria_app_auth_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');

const pessoas = {};
let db;
let sup;
let appPool;
let servidores = [];

async function criarPessoa(chave, memberships) {
  const email = `${chave.toLowerCase()}@teste.oria`;
  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [email, `Pessoa ${chave}`, await senhas.gerarHash(SENHA)]
  );
  for (const [org, papel] of memberships) {
    await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, papel]);
  }
  pessoas[chave] = { id: u.id, email };
}

// Sobe uma app com a configuração pedida. Rotas de teste: uma leitura e uma escrita auditada.
async function subirApp(env = {}, { limiter } = {}) {
  const config = resolverConfigAuth({ ADMIN_SESSION_SECRET: SEGREDO, ...env });
  const auth = createAuth({
    pool: appPool,
    config,
    comOrganization,
    auditar: (e) => registrarAuditoria(appPool, e),
    limiter: limiter || createLoginLimiter(),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', auth.router);
  app.get('/api/admin/teste/eu', auth.requireAuth, (req, res) => res.json({ auth: req.auth }));
  app.all('/api/admin/teste/escrita', auth.requireAuth, async (req, res) => {
    const r = await registrarAuditoria(appPool, {
      actorUserId: req.auth.userId, action: 'teste.escrita', entityType: 'teste', entityId: 'x', organizationId: ORG_A,
    });
    res.json({ ok: true, auditId: r.id });
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servidores.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, config };
}

// Navegador mínimo: guarda o cookie de sessão e o token CSRF.
function navegador(base) {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo, headers = {}, semCsrf = false, csrf } = {}) => {
    const h2 = { ...headers };
    if (corpo !== undefined) h2['Content-Type'] = 'application/json';
    if (nav.cookie) h2.Cookie = nav.cookie;
    const token = csrf !== undefined ? csrf : nav.csrf;
    if (!semCsrf && token && metodo !== 'GET') h2['X-CSRF-Token'] = token;
    const res = await fetch(base + caminho, { method: metodo, headers: h2, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const valor = setCookie.split(';')[0];
      nav.cookie = valor.endsWith('=') ? null : valor;
      nav.ultimoSetCookie = setCookie;
    }
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json };
  };
  nav.login = (email, senha = SENHA, extra = {}) => nav.req('POST', '/api/admin/login', { corpo: { email, password: senha, ...extra } });
  return nav;
}

let app;

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_auth');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPool = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 4 });
  await criarPessoa('A', [[ORG_A, 'owner']]);
  await criarPessoa('B', [[ORG_B, 'owner']]);
  await criarPessoa('C', [[ORG_A, 'member'], [ORG_B, 'member']]);
  await criarPessoa('D', [[ORG_A, 'member']]);
  await criarPessoa('E', [[ORG_A, 'owner'], [ORG_B, 'owner']]);
  app = await subirApp();
});

test.after(async () => {
  for (const s of servidores) await new Promise((r) => s.close(r));
  await appPool?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

const sessaoNoBanco = async (cookie) => {
  const token = cookie.split('=')[1];
  const id = crypto.createHash('sha256').update(token).digest('hex');
  return (await sup.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0];
};

// ── Login e sessão ─────────────────────────────────────────────────────────────────────────

test('auth · login individual cria sessão persistida; um único membership vira a Organization ativa (Fase 3)', async () => {
  const nav = navegador(app.base);
  const r = await nav.login(pessoas.A.email);
  assert.equal(r.status, 200);
  assert.equal(r.json.user.id, pessoas.A.id);
  const s = await sessaoNoBanco(nav.cookie);
  assert.equal(s.user_id, pessoas.A.id);
  assert.equal(s.metodo, 'senha');
  assert.ok(new Date(s.expira_em) > new Date());

  const sessao = await nav.req('GET', '/api/admin/session');
  assert.equal(sessao.json.authenticated, true);
  assert.equal(sessao.json.user.id, pessoas.A.id);
  // A pessoa tem exatamente UM membership: o servidor escolhe esse (é o universo DELA, não o do
  // banco — INV-09) e grava na sessão.
  assert.deepEqual(
    [sessao.json.organizacaoAtiva && sessao.json.organizacaoAtiva.id, sessao.json.organizacaoAtiva && sessao.json.organizacaoAtiva.papel],
    [ORG_A, 'owner']
  );
  assert.equal(sessao.json.codigoOrganizacao, null);
  assert.equal((await sessaoNoBanco(nav.cookie)).active_organization_id, ORG_A);
  assert.deepEqual(sessao.json.memberships.map((m) => [m.organizationId, m.papel]), [[ORG_A, 'owner']]);
});

test('auth · senha errada e e-mail inexistente dão a mesma resposta, sem sessão', async () => {
  const nav = navegador(app.base);
  const errada = await nav.login(pessoas.A.email, 'outra-senha-qualquer');
  const inexistente = await nav.login('ninguem@teste.oria');
  assert.deepEqual([errada.status, errada.json], [401, { error: 'e-mail ou senha incorretos' }]);
  assert.deepEqual([inexistente.status, inexistente.json], [401, { error: 'e-mail ou senha incorretos' }]);
  assert.equal(nav.cookie, null);
});

test('auth · cookie: opaco, HttpOnly, SameSite=Strict, Path=/, Max-Age da sessão; Secure e __Host- em produção', async () => {
  const nav = navegador(app.base);
  await nav.login(pessoas.A.email);
  const c = nav.ultimoSetCookie;
  assert.match(c, /^oria_session=[A-Za-z0-9_-]{43};/);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(c.includes(flag), flag);
  const maxAge = Number(c.match(/Max-Age=(\d+)/)[1]);
  assert.ok(maxAge > 11 * 3600 && maxAge <= 12 * 3600, `Max-Age ${maxAge}`);
  assert.doesNotMatch(c, new RegExp(`${pessoas.A.id}|${ORG_A}|owner|${SENHA}`), 'o cookie não carrega identidade, tenant nem papel');

  const { cookieDeSessao } = h.sujeito('lib/auth/middleware.js');
  const prod = cookieDeSessao({ producao: true, token: 'x'.repeat(43), expiraEm: Date.now() + 1000 });
  assert.match(prod, /^__Host-oria_session=/);
  assert.match(prod, /; Secure$/);
});

// ── INV-02: tenant e papel nunca vêm do cliente ──────────────────────────────────────────────

test('INV-02 · login recusa organization_id, store_id, loja e papel no corpo', async () => {
  for (const campo of ['organization_id', 'organizationId', 'store_id', 'loja', 'role', 'papel']) {
    const nav = navegador(app.base);
    const r = await nav.login(pessoas.A.email, SENHA, { [campo]: ORG_B });
    assert.equal(r.status, 400, campo);
    assert.equal(nav.cookie, null, `${campo}: nenhuma sessão pode nascer`);
  }
});

test('INV-02 · header, query ou corpo forjados não mudam identidade, memberships nem Organization ativa', async () => {
  const nav = navegador(app.base);
  await nav.login(pessoas.D.email);
  const limpa = await nav.req('GET', '/api/admin/session');
  const forjada = await nav.req('GET', `/api/admin/session?organization_id=${ORG_B}&role=owner`, {
    headers: { 'X-Organization-Id': ORG_B, 'X-User-Id': pessoas.B.id, 'X-Role': 'owner' },
  });
  assert.deepEqual(forjada.json, limpa.json);
  // D só é membro de A: a Organization ativa é A, por mais que o request fale de B.
  assert.equal(forjada.json.organizacaoAtiva.id, ORG_A);
  const eu = await nav.req('GET', '/api/admin/teste/eu', { headers: { 'X-Organization-Id': ORG_B } });
  assert.deepEqual(Object.keys(eu.json.auth).sort(), ['email', 'metodo', 'nome', 'organizacaoAtivaId', 'sessaoId', 'userId']);
  assert.equal(eu.json.auth.userId, pessoas.D.id);
  assert.equal(eu.json.auth.organizacaoAtivaId, ORG_A, 'vem da sessão gravada, não do header');
});

test('INV-02 · User C (duas Organizations) não ganha Organization escolhida automaticamente', async () => {
  const nav = navegador(app.base);
  await nav.login(pessoas.C.email);
  const s = await nav.req('GET', '/api/admin/session');
  assert.equal(s.json.organizacaoAtiva, null);
  assert.equal(s.json.codigoOrganizacao, 'ORGANIZATION_CONTEXT_REQUIRED');
  assert.deepEqual(s.json.memberships.map((m) => m.organizationId).sort(), [ORG_A, ORG_B].sort());
  assert.equal((await sessaoNoBanco(nav.cookie)).active_organization_id, null);
});

// ── Logout e revogação ───────────────────────────────────────────────────────────────────────

test('auth · logout invalida a sessão no servidor — o cookie antigo não serve mais', async () => {
  const nav = navegador(app.base);
  await nav.login(pessoas.A.email);
  const cookieAntigo = nav.cookie;
  assert.equal((await nav.req('POST', '/api/admin/logout')).status, 200);
  assert.ok((await sessaoNoBanco(cookieAntigo)).revogada_em);
  nav.cookie = cookieAntigo; // o atacante guardou o cookie
  assert.equal((await nav.req('GET', '/api/admin/teste/eu')).status, 401);
});

test('auth · sessão revogada falha na request SEGUINTE', async () => {
  const nav = navegador(app.base);
  await nav.login(pessoas.A.email);
  assert.equal((await nav.req('GET', '/api/admin/teste/eu')).status, 200);
  const s = await sessaoNoBanco(nav.cookie);
  await sup.query('UPDATE sessions SET revogada_em = now() WHERE id = $1', [s.id]);
  assert.equal((await nav.req('GET', '/api/admin/teste/eu')).status, 401);
  assert.equal((await nav.req('GET', '/api/admin/session')).json.authenticated, false);
});

test('auth · revogar uma sessão específica da própria conta; a outra continua', async () => {
  const pc = navegador(app.base);
  const celular = navegador(app.base);
  await pc.login(pessoas.D.email);
  await celular.login(pessoas.D.email);
  const alvo = (await sessaoNoBanco(celular.cookie)).id;
  const lista = await pc.req('GET', '/api/admin/me/sessions');
  assert.ok(lista.json.sessoes.some((s) => s.id === alvo && !s.atual));
  assert.equal((await pc.req('POST', `/api/admin/me/sessions/${alvo}/revoke`)).status, 200);
  assert.equal((await celular.req('GET', '/api/admin/teste/eu')).status, 401);
  assert.equal((await pc.req('GET', '/api/admin/teste/eu')).status, 200);
});

test('auth · A não revoga sessão de B, nem sabendo o id', async () => {
  const a = navegador(app.base);
  const b = navegador(app.base);
  await a.login(pessoas.A.email);
  await b.login(pessoas.B.email);
  const deB = (await sessaoNoBanco(b.cookie)).id;
  assert.equal((await a.req('POST', `/api/admin/me/sessions/${deB}/revoke`)).status, 404);
  assert.equal((await a.req('POST', `/api/admin/users/${pessoas.B.id}/revoke-sessions`)).status, 403);
  assert.equal((await b.req('GET', '/api/admin/teste/eu')).status, 200, 'a sessão de B segue viva');
});

test('auth · owner revoga todas as sessões de um member só dele; revogar A não afeta B', async () => {
  const d1 = navegador(app.base);
  const d2 = navegador(app.base);
  const b = navegador(app.base);
  const a = navegador(app.base);
  await d1.login(pessoas.D.email);
  await d2.login(pessoas.D.email);
  await b.login(pessoas.B.email);
  await a.login(pessoas.A.email);
  const r = await a.req('POST', `/api/admin/users/${pessoas.D.id}/revoke-sessions`);
  assert.equal(r.status, 200);
  assert.ok(r.json.revogadas >= 2);
  assert.equal((await d1.req('GET', '/api/admin/teste/eu')).status, 401);
  assert.equal((await d2.req('GET', '/api/admin/teste/eu')).status, 401);
  assert.equal((await b.req('GET', '/api/admin/teste/eu')).status, 200);
});

test('auth · owner de A não mexe em quem também é de B (User C); owner das duas mexe', async () => {
  const a = navegador(app.base);
  const e = navegador(app.base);
  const c = navegador(app.base);
  await a.login(pessoas.A.email);
  await e.login(pessoas.E.email);
  await c.login(pessoas.C.email);
  assert.equal((await a.req('POST', `/api/admin/users/${pessoas.C.id}/revoke-sessions`)).status, 403);
  assert.equal((await a.req('POST', `/api/admin/users/${pessoas.C.id}/disable`)).status, 403);
  assert.equal((await c.req('GET', '/api/admin/teste/eu')).status, 200);
  assert.equal((await e.req('POST', `/api/admin/users/${pessoas.C.id}/revoke-sessions`)).status, 200);
  assert.equal((await c.req('GET', '/api/admin/teste/eu')).status, 401);
});

test('auth · desativar usuário encerra o acesso e impede novo login', async () => {
  await criarPessoa('F', [[ORG_A, 'member']]);
  const f = navegador(app.base);
  const a = navegador(app.base);
  await f.login(pessoas.F.email);
  await a.login(pessoas.A.email);
  assert.equal((await a.req('POST', `/api/admin/users/${pessoas.F.id}/disable`)).status, 200);
  assert.equal((await f.req('GET', '/api/admin/teste/eu')).status, 401);
  assert.equal((await navegador(app.base).login(pessoas.F.email)).status, 401);
});

// ── Papéis ───────────────────────────────────────────────────────────────────────────────────

test('papéis · member não gere membros nem owner', async () => {
  const d = navegador(app.base);
  await d.login(pessoas.D.email);
  assert.equal((await d.req('GET', `/api/admin/organizations/${ORG_A}/members`)).status, 403);
  assert.equal((await d.req('POST', `/api/admin/organizations/${ORG_A}/members`, { corpo: { email: 'x@teste.oria', senha: SENHA } })).status, 403);
  assert.equal((await d.req('PATCH', `/api/admin/organizations/${ORG_A}/members/${pessoas.A.id}`, { corpo: { papel: 'member' } })).status, 403);
  assert.equal((await d.req('DELETE', `/api/admin/organizations/${ORG_A}/members/${pessoas.A.id}`)).status, 403);
  assert.equal((await d.req('POST', `/api/admin/users/${pessoas.A.id}/revoke-sessions`)).status, 403);
});

test('papéis · owner de A não enxerga nem gere Org B', async () => {
  const a = navegador(app.base);
  await a.login(pessoas.A.email);
  assert.equal((await a.req('GET', `/api/admin/organizations/${ORG_B}/members`)).status, 404);
  assert.equal((await a.req('DELETE', `/api/admin/organizations/${ORG_B}/members/${pessoas.B.id}`)).status, 404);
  assert.equal((await a.req('PATCH', `/api/admin/organizations/${ORG_B}/members/${pessoas.C.id}`, { corpo: { papel: 'owner' } })).status, 404);
  const { rows } = await sup.query('SELECT papel FROM organization_members WHERE organization_id = $1 AND user_id = $2', [ORG_B, pessoas.C.id]);
  assert.equal(rows[0].papel, 'member');
});

test('papéis · owner adiciona, promove, rebaixa e remove; o último owner não sai', async () => {
  const a = navegador(app.base);
  await a.login(pessoas.A.email);
  const novo = await a.req('POST', `/api/admin/organizations/${ORG_A}/members`, {
    corpo: { email: 'nova.pessoa@teste.oria', senha: SENHA, nome: 'Nova' },
  });
  assert.equal(novo.status, 201);
  assert.equal((await navegador(app.base).login('nova.pessoa@teste.oria')).status, 200);
  // Pessoa já existente (B) entra em A sem ter a senha tocada.
  const hashAntes = (await sup.query('SELECT password_hash FROM users WHERE id = $1', [pessoas.B.id])).rows[0].password_hash;
  assert.equal((await a.req('POST', `/api/admin/organizations/${ORG_A}/members`, { corpo: { email: pessoas.B.email, senha: 'outra-senha-qualquer' } })).status, 201);
  assert.equal((await sup.query('SELECT password_hash FROM users WHERE id = $1', [pessoas.B.id])).rows[0].password_hash, hashAntes);
  assert.equal((await a.req('PATCH', `/api/admin/organizations/${ORG_A}/members/${novo.json.userId}`, { corpo: { papel: 'owner' } })).status, 200);
  assert.equal((await a.req('PATCH', `/api/admin/organizations/${ORG_A}/members/${novo.json.userId}`, { corpo: { papel: 'member' } })).status, 200);
  assert.equal((await a.req('DELETE', `/api/admin/organizations/${ORG_A}/members/${novo.json.userId}`)).status, 200);
  assert.equal((await a.req('DELETE', `/api/admin/organizations/${ORG_A}/members/${pessoas.B.id}`)).status, 200);

  // Org B tem um só owner além de E: rebaixar E e depois o último owner (B) precisa falhar.
  const b = navegador(app.base);
  await b.login(pessoas.B.email);
  assert.equal((await b.req('PATCH', `/api/admin/organizations/${ORG_B}/members/${pessoas.E.id}`, { corpo: { papel: 'member' } })).status, 200);
  assert.equal((await b.req('DELETE', `/api/admin/organizations/${ORG_B}/members/${pessoas.B.id}`)).status, 409);
  assert.equal((await b.req('PATCH', `/api/admin/organizations/${ORG_B}/members/${pessoas.B.id}`, { corpo: { papel: 'member' } })).status, 409);
  assert.equal((await b.req('PATCH', `/api/admin/organizations/${ORG_B}/members/${pessoas.E.id}`, { corpo: { papel: 'owner' } })).status, 200);
});

// ── CSRF ─────────────────────────────────────────────────────────────────────────────────────

test('CSRF · GET sem token passa; POST legítimo passa; sem token, errado ou de outra sessão falha', async () => {
  const a = navegador(app.base);
  const b = navegador(app.base);
  await a.login(pessoas.A.email);
  await b.login(pessoas.B.email);
  assert.equal((await a.req('GET', '/api/admin/teste/eu', { semCsrf: true })).status, 200);
  assert.equal((await a.req('POST', '/api/admin/teste/escrita')).status, 200);
  assert.equal((await a.req('POST', '/api/admin/teste/escrita', { semCsrf: true })).status, 403);
  assert.equal((await a.req('POST', '/api/admin/teste/escrita', { csrf: 'x'.repeat(43) })).status, 403);
  assert.equal((await a.req('POST', '/api/admin/teste/escrita', { csrf: b.csrf })).status, 403, 'token de B na sessão de A');
  for (const metodo of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal((await a.req(metodo, '/api/admin/teste/escrita', { semCsrf: true })).status, 403, metodo);
  }
  assert.equal((await a.req('POST', '/api/admin/logout', { semCsrf: true })).status, 403, 'logout também é escrita');
});

// ── Session fixation ─────────────────────────────────────────────────────────────────────────

test('fixation · a sessão trazida para o login é revogada e o login gera outra', async () => {
  const atacante = navegador(app.base);
  await atacante.login(pessoas.D.email);
  const plantado = atacante.cookie;

  const vitima = navegador(app.base);
  vitima.cookie = plantado; // cookie plantado no navegador da vítima
  const r = await vitima.login(pessoas.A.email);
  assert.equal(r.status, 200);
  assert.notEqual(vitima.cookie, plantado, 'o login não pode reaproveitar o id anterior');
  assert.equal((await vitima.req('GET', '/api/admin/teste/eu')).json.auth.userId, pessoas.A.id);
  assert.ok((await sessaoNoBanco(plantado)).revogada_em, 'o id pré-login foi revogado');
  atacante.cookie = plantado;
  assert.equal((await atacante.req('GET', '/api/admin/teste/eu')).status, 401);
});

test('fixation · valor de cookie inventado pelo cliente nunca vira sessão', async () => {
  const nav = navegador(app.base);
  const inventado = crypto.randomBytes(32).toString('base64url');
  nav.cookie = `oria_session=${inventado}`;
  assert.equal((await nav.req('GET', '/api/admin/teste/eu')).status, 401);
  await nav.login(pessoas.A.email);
  assert.notEqual(nav.cookie, `oria_session=${inventado}`);
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM sessions WHERE id = $1',
    [crypto.createHash('sha256').update(inventado).digest('hex')])).rows[0].n, 0);
});

// ── Rate limit ───────────────────────────────────────────────────────────────────────────────

test('rate limit · por conta, sem depender de IP; outra conta segue entrando', async () => {
  const lento = await subirApp({}, { limiter: createLoginLimiter({ maxPorConta: 3 }) });
  const nav = navegador(lento.base);
  for (let i = 0; i < 3; i += 1) assert.equal((await nav.login(pessoas.D.email, 'errada-errada-errada')).status, 401);
  assert.equal((await nav.login(pessoas.D.email)).status, 429, 'nem a senha certa entra durante o bloqueio');
  assert.equal((await nav.login(pessoas.A.email)).status, 200);
});

// ── Login legado ─────────────────────────────────────────────────────────────────────────────

test('legado · sem a flag, ADMIN_PASSWORD não autentica ninguém', async () => {
  const semFlag = await subirApp({ ADMIN_PASSWORD: SENHA_LEGADA, LEGACY_ADMIN_USER_EMAIL: pessoas.A.email });
  const nav = navegador(semFlag.base);
  const r = await nav.req('POST', '/api/admin/login', { corpo: { password: SENHA_LEGADA } });
  assert.equal(r.status, 401);
  assert.equal(nav.cookie, null);
});

test('legado · com a flag, entra como o usuário DECLARADO, com sessão marcada como legado', async () => {
  const comFlag = await subirApp({
    ALLOW_LEGACY_ADMIN_PASSWORD: '1', ADMIN_PASSWORD: SENHA_LEGADA, LEGACY_ADMIN_USER_EMAIL: pessoas.A.email,
  });
  const nav = navegador(comFlag.base);
  assert.equal((await nav.req('POST', '/api/admin/login', { corpo: { password: 'errada' } })).status, 401);
  const r = await nav.req('POST', '/api/admin/login', { corpo: { password: SENHA_LEGADA } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.id, pessoas.A.id);
  assert.equal((await sessaoNoBanco(nav.cookie)).metodo, 'legado');
  const escrita = await nav.req('POST', '/api/admin/teste/escrita');
  const { rows } = await sup.query('SELECT actor_user_id FROM audit_log WHERE id = $1', [escrita.json.auditId]);
  assert.equal(rows[0].actor_user_id, pessoas.A.id, 'nem o login legado grava sujeito sintético');
});

test('legado · flag ligada sem usuário declarado é erro de configuração', () => {
  assert.throws(() => resolverConfigAuth({ ALLOW_LEGACY_ADMIN_PASSWORD: '1', ADMIN_PASSWORD: 'x', ADMIN_SESSION_SECRET: SEGREDO }),
    /LEGACY_ADMIN_USER_EMAIL/);
  assert.throws(() => resolverConfigAuth({ ALLOW_LEGACY_ADMIN_PASSWORD: 'true', ADMIN_SESSION_SECRET: SEGREDO }), /inválido/);
  assert.throws(() => resolverConfigAuth({ NODE_ENV: 'production', ADMIN_SESSION_SECRET: 'curto' }), /ADMIN_SESSION_SECRET/);
});

// ── Audit (INV-21, parte de identidade) ──────────────────────────────────────────────────────

test('INV-21 · cada ação grava o id real de quem agiu (A, B, C)', async () => {
  for (const chave of ['A', 'B', 'C']) {
    const nav = navegador(app.base);
    await nav.login(pessoas[chave].email);
    const r = await nav.req('POST', '/api/admin/teste/escrita');
    assert.equal(r.status, 200);
    const { rows } = await sup.query('SELECT actor_user_id FROM audit_log WHERE id = $1', [r.json.auditId]);
    assert.equal(rows[0].actor_user_id, pessoas[chave].id, chave);
  }
  // Gestão de membros audita com a Organization do recurso.
  const { rows: gestao } = await sup.query(
    `SELECT DISTINCT organization_id FROM audit_log WHERE action LIKE 'org.member.%' AND actor_user_id = $1`, [pessoas.A.id]
  );
  assert.deepEqual(gestao.map((g) => g.organization_id), [ORG_A]);
});

test('INV-21 · sujeito ausente ou sintético é recusado antes de gravar', async () => {
  const antes = (await sup.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
  for (const ator of ['admin', '', null, undefined, 'system']) {
    await assert.rejects(
      registrarAuditoria(appPool, { actorUserId: ator, action: 'x', entityType: 'x', entityId: 'x', organizationId: ORG_A }),
      /sujeito real/
    );
  }
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, antes);
  const { rows } = await sup.query(`SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = 'admin'`);
  assert.equal(rows[0].n, 0, 'nenhum registro novo com sujeito sintético');
});
