'use strict';

// Fase 2 no processo real (server.js): a autenticação individual está ligada de verdade, o CSRF
// vale nas rotas existentes e nenhum caminho novo grava sujeito sintético.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('./harness');
const senhas = h.sujeito('lib/auth/password.js');

const SERVER = path.join(h.RAIZ_REPO, 'server.js');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');

function arquivosDoApp() {
  return [SERVER, ...['lib', 'routes'].flatMap((d) => fs.readdirSync(path.join(h.RAIZ_REPO, d), { recursive: true })
    .filter((x) => x.endsWith('.js')).map((x) => path.join(h.RAIZ_REPO, d, x)))];
}

test('audit · nenhum código grava o sujeito sintético "admin"', () => {
  const achados = [];
  for (const arq of arquivosDoApp()) {
    fs.readFileSync(arq, 'utf8').split('\n').forEach((l, i) => {
      if (/actorUserId:\s*['"]admin['"]|actor_user_id[^\n]*['"]admin['"]/.test(l)) achados.push(`${path.relative(h.RAIZ_REPO, arq)}:${i + 1}`);
    });
  }
  assert.deepEqual(achados, []);
});

test('INV-02 · nenhum código lê organization_id, store_id ou tenant do request', () => {
  // Única exceção: `req.params.organizationId` das rotas de membros (lib/auth/router.js), que
  // identifica o RECURSO a gerir e passa por exigirOwner() contra os memberships do banco.
  const padrao = /req\.(query|body|params|headers|cookies)\b[^;\n]*\b(organization_?id|organizationId|store_?id|storeId|tenant_?id|tenantId)\b|req\.get\(\s*['"`]x-(organization|store|tenant)/i;
  const achados = [];
  for (const arq of arquivosDoApp()) {
    fs.readFileSync(arq, 'utf8').split('\n').forEach((l, i) => {
      if (l.trimStart().startsWith('//')) return;
      if (!padrao.test(l)) return;
      if (arq.endsWith(path.join('lib', 'auth', 'router.js')) && /const \{ organizationId \} = req\.params;/.test(l)) return;
      achados.push(`${path.relative(h.RAIZ_REPO, arq)}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(achados, []);
});

test('auth · toda escrita em /api/admin do server.js passa por requireAdmin (CSRF incluído)', () => {
  const texto = fs.readFileSync(SERVER, 'utf8');
  const semGuarda = [];
  for (const m of texto.matchAll(/app\.(post|put|patch|delete)\(\s*(['"`])(\/api\/admin[^'"`]*)\2\s*,\s*([A-Za-z_]+)/g)) {
    if (m[4] !== 'requireAdmin') semGuarda.push(`${m[1].toUpperCase()} ${m[3]} (${m[4]})`);
  }
  assert.deepEqual(semGuarda, []);
  assert.ok(!/app\.(post|put)\(\s*['"]\/api\/admin\/login/.test(texto), 'login mora em lib/auth/router.js');
});

test('auth · processo real: login individual, CSRF nas rotas existentes, logout revoga', async (t) => {
  const db = await h.criarBancoDescartavel('oria_auth_srv');
  t.after(() => db.destruir());
  assert.equal(h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } }).status, 0);
  const sup = h.abrirPoolDescartavel(db.url, { max: 1 });
  t.after(() => sup.end());
  const { rows: [u] } = await sup.query(
    `INSERT INTO users (email, password_hash) VALUES ('dona@teste.oria', $1) RETURNING id`,
    [await senhas.gerarHash('senha-forte-de-teste-123')]
  );
  await sup.query(`INSERT INTO organization_members (organization_id, user_id, papel)
                   VALUES ('a1000000-0000-4000-8000-000000000001', $1, 'owner')`, [u.id]);

  // `npm run test:app-role`: o processo sobe como a role da aplicação, com a verificação ligada.
  let urlDoProcesso = db.url;
  const extraDoProcesso = {};
  if (process.env.TEST_APP_ROLE === '1') {
    const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
    const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
    const role = `oria_app_auth_${crypto.randomBytes(4).toString('hex')}`;
    const senhaRole = crypto.randomBytes(16).toString('hex');
    for (const sql of sqlProvisionarAppRole({ role, senha: senhaRole, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
    // Independe da ordem dos hooks: se o banco descartável ainda existe, solta as dependências nele.
    t.after(async () => {
      const noBanco = h.abrirPoolDescartavel(db.url, { max: 1 });
      await noBanco.query(`DROP OWNED BY ${role}`).catch(() => {});
      await noBanco.end().catch(() => {});
      const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
      try { await admin.query(`DROP ROLE IF EXISTS ${role}`); } finally { await admin.end(); }
    });
    urlDoProcesso = h.urlComUsuario(db.url, role, senhaRole);
    extraDoProcesso.DB_ENFORCE_APP_ROLE = '1';
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-auth-srv-'));
  let saida = '';
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, [SERVER], {
    cwd: h.RAIZ_REPO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', DATABASE_URL: urlDoProcesso, ...extraDoProcesso,
      ENCRYPTION_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      // A senha compartilhada existe no ambiente, mas sem a flag não autentica ninguém.
      ADMIN_PASSWORD: 'senha-compartilhada-antiga',
    },
  }), {
    aoLer: (pedaco, { reiniciando }) => { saida = reiniciando ? '' : saida + pedaco; },
    limiteMs: 20000,
  });
  const filho = processo.filho;
  t.after(() => filho.kill('SIGKILL'));
  if (extraDoProcesso.DB_ENFORCE_APP_ROLE) assert.match(saida, /role da aplicação oria_app_auth_\w+ verificada/);
  const base = processo.base;
  const req = (metodo, caminho, { cookie, csrf, corpo } = {}) => fetch(base + caminho, {
    method: metodo,
    headers: {
      ...(corpo ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });

  assert.equal((await req('GET', '/api/admin/webhook-log')).status, 401);
  assert.equal((await req('POST', '/api/admin/login', { corpo: { password: 'senha-compartilhada-antiga' } })).status, 401);

  const login = await req('POST', '/api/admin/login', { corpo: { email: 'dona@teste.oria', password: 'senha-forte-de-teste-123' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();

  assert.equal((await req('GET', '/api/admin/webhook-log', { cookie })).status, 200);
  // Rota de escrita já existente, antes da Fase 2: sem token, barrada no guard.
  assert.equal((await req('PUT', '/api/admin/whatsapp/meta-app', { cookie, corpo: { appId: '123456789' } })).status, 403);
  const sessao = await (await req('GET', '/api/admin/session', { cookie })).json();
  assert.equal(sessao.user.email, 'dona@teste.oria');
  // Um único membership: a Organization ativa é essa (Fase 3).
  assert.equal(sessao.organizacaoAtiva && sessao.organizacaoAtiva.papel, 'owner');

  assert.equal((await req('POST', '/api/admin/logout', { cookie })).status, 403);
  assert.equal((await req('POST', '/api/admin/logout', { cookie, csrf: csrfToken })).status, 200);
  assert.equal((await req('GET', '/api/admin/webhook-log', { cookie })).status, 401);
});

test('OPS-18 · bootstrap do owner: explícito, idempotente, nunca troca senha nem deduz Organization', async (t) => {
  const db = await h.criarBancoDescartavel('oria_boot_owner');
  t.after(() => db.destruir());
  assert.equal(h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } }).status, 0);
  const sup = h.abrirPoolDescartavel(db.url, { max: 1 });
  t.after(() => sup.end());
  const { bootstrapOwner } = await import(path.join(h.RAIZ_REPO, 'scripts', 'auth', 'bootstrap-owner.mjs'));
  const hash = await senhas.gerarHash('senha-forte-de-teste-123');
  const orgs = 'a1000000-0000-4000-8000-000000000001,a1000000-0000-4000-8000-000000000002';

  assert.deepEqual(await bootstrapOwner(db.url, {}), { feito: false, motivo: 'sem configuração de bootstrap' });
  await assert.rejects(bootstrapOwner(db.url, { AUTH_BOOTSTRAP_OWNER_EMAIL: 'dona@teste.oria' }), /incompleto/);
  await assert.rejects(bootstrapOwner(db.url, {
    AUTH_BOOTSTRAP_OWNER_EMAIL: 'dona@teste.oria', AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH: 'senha-em-claro',
    AUTH_BOOTSTRAP_ORGANIZATION_IDS: orgs,
  }), /não é um hash scrypt/);
  await assert.rejects(bootstrapOwner(db.url, {
    AUTH_BOOTSTRAP_OWNER_EMAIL: 'dona@teste.oria', AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH: hash,
    AUTH_BOOTSTRAP_ORGANIZATION_IDS: '00000000-0000-4000-8000-000000000000',
  }), /Organization inexistente/);

  const env = { AUTH_BOOTSTRAP_OWNER_EMAIL: 'Dona@Teste.Oria', AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH: hash, AUTH_BOOTSTRAP_ORGANIZATION_IDS: orgs };
  const r1 = await bootstrapOwner(db.url, env);
  const outroHash = await senhas.gerarHash('outra-senha-forte-456');
  const r2 = await bootstrapOwner(db.url, { ...env, AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH: outroHash });
  assert.equal(r1.userId, r2.userId);
  const { rows: [u] } = await sup.query('SELECT email, password_hash FROM users WHERE id = $1', [r1.userId]);
  assert.deepEqual(u, { email: 'dona@teste.oria', password_hash: hash }, 'a segunda execução não troca a senha');
  const { rows } = await sup.query('SELECT organization_id, papel FROM organization_members WHERE user_id = $1 ORDER BY 1', [r1.userId]);
  assert.deepEqual(rows.map((x) => [x.organization_id, x.papel]),
    orgs.split(',').sort().map((o) => [o, 'owner']), 'owner exatamente das Organizations declaradas');
});
