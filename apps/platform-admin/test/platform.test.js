'use strict';

// Bootstrap, fail-fast de boot, último platform_owner e as propriedades estruturais do control
// plane (sem query global crua em tabela de tenant, sem BYPASSRLS, sem SUPERUSER).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./harness');

let db;
let app;

const bootstrap = (env) => spawnSync(
  process.execPath,
  [path.join(h.RAIZ_SUJEITO, 'scripts', 'bootstrap-admin.mjs')],
  { encoding: 'utf8', env: { ...process.env, DATABASE_URL: db.url, ...env } }
);

test.before(async () => {
  db = await h.bancoNovo();
  app = await h.subirApp(db.url);
});

test.after(async () => {
  await app.fechar();
  await db.destruir();
});

// ── Bootstrap (§8) ───────────────────────────────────────────────────────────────────────────

test('bootstrap · sem e-mail ou sem senha, RECUSA e explica — não inventa credencial', () => {
  const semEmail = bootstrap({ PLATFORM_ADMIN_PASSWORD: 'uma-senha-bem-longa' });
  assert.notEqual(semEmail.status, 0);
  assert.match(semEmail.stderr, /PLATFORM_ADMIN_EMAIL ausente/);
  assert.match(semEmail.stderr, /não inventa credencial/);

  const semSenha = bootstrap({ PLATFORM_ADMIN_EMAIL: 'primeiro@exemplo.com' });
  assert.notEqual(semSenha.status, 0);
  assert.match(semSenha.stderr, /não existe senha padrão/);
});

test('bootstrap · senha curta é recusada', () => {
  const r = bootstrap({ PLATFORM_ADMIN_EMAIL: 'primeiro@exemplo.com', PLATFORM_ADMIN_PASSWORD: 'curta' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /senha recusada/);
  assert.doesNotMatch(r.stderr + r.stdout, /curta/);
});

test('bootstrap · o primeiro admin nasce platform_owner, e a senha NUNCA é impressa', async () => {
  const SENHA = 'senha-secreta-do-bootstrap-123';
  const r = bootstrap({ PLATFORM_ADMIN_EMAIL: 'primeiro@exemplo.com', PLATFORM_ADMIN_PASSWORD: SENHA });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /platform admin criado/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SENHA), 'a senha apareceu na saída do bootstrap');

  const { rows } = await app.pool.query(
    `SELECT papel, status, password_hash FROM platform_admins WHERE email = 'primeiro@exemplo.com'`
  );
  assert.equal(rows[0].papel, 'platform_owner');
  assert.equal(rows[0].status, 'active');
  assert.match(rows[0].password_hash, /^scrypt\$/);
  assert.ok(!rows[0].password_hash.includes(SENHA));
});

test('bootstrap · é idempotente: rodar de novo não duplica e não troca a senha', async () => {
  const { rows: antes } = await app.pool.query(
    `SELECT password_hash FROM platform_admins WHERE email = 'primeiro@exemplo.com'`
  );
  const r = bootstrap({ PLATFORM_ADMIN_EMAIL: 'primeiro@exemplo.com', PLATFORM_ADMIN_PASSWORD: 'outra-senha-diferente-456' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /já existe/);

  const { rows: depois } = await app.pool.query(
    `SELECT count(*)::int AS n, max(password_hash) AS hash FROM platform_admins WHERE email = 'primeiro@exemplo.com'`
  );
  assert.equal(depois[0].n, 1);
  assert.equal(depois[0].hash, antes[0].password_hash, 'o bootstrap trocou a senha de um admin existente');
});

test('bootstrap · o segundo admin nasce platform_operator', async () => {
  const r = bootstrap({ PLATFORM_ADMIN_EMAIL: 'segundo@exemplo.com', PLATFORM_ADMIN_PASSWORD: 'outra-senha-longa-789' });
  assert.equal(r.status, 0, r.stderr);
  const { rows } = await app.pool.query(`SELECT papel FROM platform_admins WHERE email = 'segundo@exemplo.com'`);
  assert.equal(rows[0].papel, 'platform_operator');
});

test('bootstrap · o admin criado consegue entrar', async () => {
  const cliente = h.criarCliente(app.base);
  const r = await cliente.post('/api/platform/auth/login',
    { email: 'primeiro@exemplo.com', senha: 'senha-secreta-do-bootstrap-123' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.admin.papel, 'platform_owner');
});

// ── Último platform_owner (§9, §28) ──────────────────────────────────────────────────────────

test('o último platform_owner ativo não pode ser desativado nem rebaixado', async () => {
  const cliente = h.criarCliente(app.base);
  await cliente.login('primeiro@exemplo.com', 'senha-secreta-do-bootstrap-123');
  const { rows: [owner] } = await app.pool.query(
    `SELECT id FROM platform_admins WHERE email = 'primeiro@exemplo.com'`
  );

  const desativar = await cliente.post(`/api/platform/admins/${owner.id}/deactivate`);
  assert.equal(desativar.status, 409);
  assert.equal(desativar.corpo.erro, 'ultimo_platform_owner');

  const rebaixar = await cliente.post(`/api/platform/admins/${owner.id}/role`, { papel: 'platform_operator' });
  assert.equal(rebaixar.status, 409);
  assert.equal(rebaixar.corpo.erro, 'ultimo_platform_owner');

  const { rows } = await app.pool.query('SELECT platform_admin_owners_ativos() AS n');
  assert.equal(rows[0].n, 1);
});

test('o banco recusa por trigger, mesmo com UPDATE/DELETE direto', async () => {
  await assert.rejects(
    () => app.pool.query(`UPDATE platform_admins SET status = 'disabled' WHERE papel = 'platform_owner' AND status = 'active'`),
    /último platform_owner/
  );
  await assert.rejects(
    () => app.pool.query(`DELETE FROM platform_admins WHERE papel = 'platform_owner' AND status = 'active'`),
    /último platform_owner/
  );
  await assert.rejects(
    () => app.pool.query(`UPDATE platform_admins SET papel = 'platform_operator' WHERE papel = 'platform_owner' AND status = 'active'`),
    /último platform_owner/
  );
});

test('com DOIS owners ativos, desativar um passa — e aí o outro fica travado', async () => {
  const cliente = h.criarCliente(app.base);
  await cliente.login('primeiro@exemplo.com', 'senha-secreta-do-bootstrap-123');
  const novo = await cliente.post('/api/platform/admins',
    { email: 'terceiro@exemplo.com', senha: 'mais-uma-senha-longa-000', papel: 'platform_owner' });
  assert.equal(novo.status, 201, JSON.stringify(novo.corpo));

  const desativar = await cliente.post(`/api/platform/admins/${novo.corpo.id}/deactivate`);
  assert.equal(desativar.status, 200);
  assert.equal(desativar.corpo.status, 'disabled');

  const { rows } = await app.pool.query('SELECT platform_admin_owners_ativos() AS n');
  assert.equal(rows[0].n, 1);
});

test('desativar um admin revoga as sessões dele na hora', async () => {
  const dono = h.criarCliente(app.base);
  await dono.login('primeiro@exemplo.com', 'senha-secreta-do-bootstrap-123');
  const alvo = await dono.post('/api/platform/admins',
    { email: 'sessao@exemplo.com', senha: 'senha-do-alvo-1234567', papel: 'platform_operator' });

  const cliente = h.criarCliente(app.base);
  await cliente.login('sessao@exemplo.com', 'senha-do-alvo-1234567');
  assert.equal((await cliente.get('/api/platform/overview')).status, 200);

  await dono.post(`/api/platform/admins/${alvo.corpo.id}/deactivate`);
  assert.equal((await cliente.get('/api/platform/overview')).status, 401);
});

test('operador não gere platform admins', async () => {
  const dono = h.criarCliente(app.base);
  await dono.login('primeiro@exemplo.com', 'senha-secreta-do-bootstrap-123');
  const alvo = await dono.post('/api/platform/admins',
    { email: 'so.le@exemplo.com', senha: 'senha-do-operador-123', papel: 'platform_operator' });

  const operador = h.criarCliente(app.base);
  await operador.login('so.le@exemplo.com', 'senha-do-operador-123');
  assert.equal((await operador.get('/api/platform/admins')).status, 200);
  const criar = await operador.post('/api/platform/admins',
    { email: 'x@exemplo.com', senha: 'senha-qualquer-1234', papel: 'platform_operator' });
  assert.equal(criar.status, 403);
  assert.equal(criar.corpo.erro, 'papel_insuficiente');
});

// ── Boot fail-fast (§25) ─────────────────────────────────────────────────────────────────────

test('boot · produção sem segredo, sem banco ou com config inválida NÃO sobe', () => {
  const { resolverConfig, ConfigError } = h.sujeito('lib/config.js');
  const casos = [
    ['sem DATABASE_URL', { NODE_ENV: 'production' }],
    ['sem segredo em produção', { NODE_ENV: 'production', DATABASE_URL: db.url }],
    ['segredo curto', { DATABASE_URL: db.url, PLATFORM_ADMIN_SESSION_SECRET: 'curto-demais' }],
    ['SECOND_TENANT_ENABLED inválido', { DATABASE_URL: db.url, SECOND_TENANT_ENABLED: 'talvez' }],
    ['TTL fora do intervalo', { DATABASE_URL: db.url, PLATFORM_ADMIN_SESSION_TTL_HOURS: '99' }],
    ['sem PLATFORM_ADMIN_URL em produção', {
      NODE_ENV: 'production', DATABASE_URL: db.url, PLATFORM_ADMIN_SESSION_SECRET: 'x'.repeat(40),
    }],
  ];
  for (const [nome, env] of casos) {
    assert.throws(() => resolverConfig(env, { avisar: () => {} }), ConfigError, `"${nome}" deveria derrubar o boot`);
  }
});

test('boot · banco sem as migrations do control plane é recusado', async () => {
  const { criarPool, verificarBanco } = h.sujeito('lib/db.js');
  const pool = criarPool(db.url, { max: 1 });
  try {
    await verificarBanco(pool); // o banco real passa
    await assert.rejects(
      () => verificarBanco(pool, { migrationEsperada: '9999999999999_nao-existe' }),
      /não aplicada/
    );
  } finally {
    await pool.end();
  }
});

test('boot · o app sobe SEM nenhum platform admin; só o login fica indisponível', async () => {
  const vazio = await h.bancoNovo();
  const semAdmin = await h.subirApp(vazio.url);
  try {
    assert.equal((await semAdmin.cliente.get('/health')).status, 200);
    const login = await semAdmin.cliente.post('/api/platform/auth/login',
      { email: 'qualquer@exemplo.com', senha: 'qualquer-senha-longa' });
    assert.equal(login.status, 503);
    assert.equal(login.corpo.erro, 'bootstrap_pendente');
  } finally {
    await semAdmin.fechar();
    await vazio.destruir();
  }
});

// ── Propriedades estruturais (§6, §29) ───────────────────────────────────────────────────────

const FONTES = ['server.js', ...fs.readdirSync(path.join(h.RAIZ_SUJEITO, 'lib')).map((f) => `lib/${f}`)];
const ler = (f) => fs.readFileSync(path.join(h.RAIZ_SUJEITO, f), 'utf8');

test('nenhuma fonte do control plane pede BYPASSRLS, SUPERUSER ou desliga RLS', () => {
  const proibido = /BYPASSRLS|SUPERUSER|DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL/i;
  for (const f of FONTES) {
    assert.doesNotMatch(ler(f), proibido, `${f} tenta contornar a RLS`);
  }
});

test('nenhuma query crua em tabela de tenant fora de comOrganization', () => {
  // As tabelas tenant-owned/plataforma sob RLS que este app toca. Ler qualquer uma delas por
  // SELECT direto no pool seria a "raw global query" que o §6 proíbe — o caminho é read model
  // (função SECURITY DEFINER) ou comOrganization.
  //
  // A varredura ignora COMENTÁRIOS: sem isso, o próprio comentário que explica a regra faria o
  // arquivo "conter" a query, e o teste passaria a medir prosa em vez de código. (Foi exatamente
  // assim que o controle negativo `bypassrls` passou pela primeira versão deste teste.)
  const tabelas = ['organizations', 'stores', 'organization_members', 'onboarding_sessions', 'onboarding_steps',
    'integrations', 'integration_secrets', 'webhook_eventos', 'job_leases'];
  const padrao = new RegExp(`\\b(?:from|join|into|update|delete\\s+from)\\s+(?:only\\s+)?(?:public\\.)?"?(${tabelas.join('|')})"?\\b`, 'gi');

  const semComentarios = (fonte) => fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

  // `lib/organizations.js` é o ÚNICO arquivo autorizado a nomear tabela de tenant, e só porque é
  // ele que escreve nelas — sempre dentro de comOrganization.
  const AUTORIZADO = 'lib/organizations.js';

  for (const f of FONTES) {
    const fonte = semComentarios(ler(f));
    const ocorrencias = [...fonte.matchAll(padrao)].map((m) => m[1]);
    if (!ocorrencias.length) continue;
    assert.equal(f, AUTORIZADO,
      `${f} consulta tabela de tenant (${[...new Set(ocorrencias)].join(', ')}) — use o read model ou comOrganization`);
    assert.ok(/comOrganization\(/.test(fonte), `${f} nomeia tabela de tenant e não chama comOrganization`);
  }

  // E o arquivo autorizado precisa mesmo estar chamando comOrganization para cada bloco que
  // escreve: menos chamadas do que blocos seria o sinal de que alguém saiu do contexto.
  const autorizado = semComentarios(ler(AUTORIZADO));
  assert.ok((autorizado.match(/comOrganization\(/g) || []).length >= 6);
});

test('os read models globais são SECURITY DEFINER e não são públicos', async () => {
  const { rows } = await app.pool.query(
    `SELECT p.proname, p.prosecdef, array_to_string(p.proacl, ',') AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'platform\\_%'
      ORDER BY p.proname`
  );
  assert.ok(rows.length >= 10, `esperava os read models; encontrei ${rows.length}`);
  for (const f of rows) {
    assert.equal(f.prosecdef, true, `${f.proname} não é SECURITY DEFINER`);
    // REVOKE de PUBLIC: a ACL existe e não contém a entrada vazia de PUBLIC ("=X/").
    assert.ok(f.acl, `${f.proname} ficou com a ACL padrão (executável por PUBLIC)`);
    assert.doesNotMatch(f.acl, /(^|,)=X\//, `${f.proname} continua executável por PUBLIC`);
  }
});

test('o app não importa nada de apps/panel em runtime', () => {
  for (const f of [...FONTES, 'scripts/bootstrap-admin.mjs', 'scripts/build.mjs']) {
    const fonte = ler(f);
    assert.doesNotMatch(fonte, /require\(['"]\.\.\/\.\.\/panel/, `${f} importa apps/panel`);
    assert.doesNotMatch(fonte, /from ['"]\.\.\/\.\.\/panel/, `${f} importa apps/panel`);
  }
  // As dependências declaradas são só o que o app realmente usa.
  const pkg = JSON.parse(ler('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['pg']);
});

test('as tabelas de plataforma estão declaradas no manifesto de tenancy do painel', () => {
  const manifesto = require(path.join(h.RAIZ_REPO, '..', 'panel', 'lib', 'platform', 'tenancy-manifest.js'));
  const nossas = [
    'platform_admins', 'platform_admin_sessions', 'plans', 'plan_features',
    'organization_subscriptions', 'organization_entitlement_overrides',
    'organization_owner_invites', 'platform_audit_logs',
  ];
  const globais = manifesto.TABELAS_GLOBAIS.map((t) => t.tabela);
  for (const t of nossas) {
    assert.ok(globais.includes(t), `${t} não está em TABELAS_GLOBAIS`);
    assert.ok(manifesto.TABELAS_GLOBAIS_PRIVADAS.includes(t), `${t} não está em TABELAS_GLOBAIS_PRIVADAS`);
    assert.ok(!manifesto.nomesTenant().includes(t), `${t} foi classificada como tenant-owned`);
  }
});
