'use strict';

// Hosts canônicos, cookie host-only, origem de mutação e open redirect.
//
// Convenção definitiva (ajuste de domínios §1):
//
//     https://oria.com.br          landing + /hotpix/{id}     PUBLIC_SITE_URL
//     https://app.oria.com.br      Tenant Plane               APP_URL
//     https://admin.oria.com.br    Control Plane (este app)   PLATFORM_ADMIN_URL
//
// O que estes testes protegem é uma propriedade que só existe se NINGUÉM a quebrar por conveniência:
// a sessão do Admin não sai do host do Admin. O mecanismo é a ausência do atributo `Domain`, e o
// negative control (`scripts/negative-controls.mjs`, controle `cookie-domain`) reintroduz
// `Domain=.oria.com.br` e exige que o teste abaixo REPROVE.

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const ADMIN = 'https://admin.oria.com.br';
const APP = 'https://app.oria.com.br';
const PUBLICO = 'https://oria.com.br';

let db;
let app;      // desenvolvimento
let prod;     // produção, com os três hosts configurados

test.before(async () => {
  db = await h.bancoNovo();
  app = await h.subirApp(db.url, { PLATFORM_ADMIN_URL: ADMIN, APP_URL: APP, PUBLIC_SITE_URL: PUBLICO });
  prod = await h.subirApp(db.url, {
    NODE_ENV: 'production',
    PLATFORM_ADMIN_URL: ADMIN,
    APP_URL: APP,
    PUBLIC_SITE_URL: PUBLICO,
  });
  await h.criarAdmin(app.pool, { email: 'dev@exemplo.com', papel: 'platform_owner' });
  await h.criarAdmin(app.pool, { email: 'prod@exemplo.com', papel: 'platform_owner' });
});

test.after(async () => {
  await prod.fechar();
  await app.fechar();
  await db.destruir();
});

// ── Cookie (§4, §36) ─────────────────────────────────────────────────────────────────────────

test('cookie de plataforma · produção: __Host-, Secure, HttpOnly, Path=/ e SEM Domain', async () => {
  const r = await prod.cliente.login('prod@exemplo.com');
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie');

  assert.match(cookie, /^__Host-oria_platform_session=/, 'o cookie do control plane precisa do prefixo __Host-');
  assert.match(cookie, /(^|;\s*)Secure(;|$)/);
  assert.match(cookie, /(^|;\s*)HttpOnly(;|$)/);
  assert.match(cookie, /(^|;\s*)Path=\/(;|$)/);
  assert.match(cookie, /(^|;\s*)SameSite=Strict(;|$)/);

  // A asserção que importa: NENHUM atributo Domain. Com `Domain=.oria.com.br`, o browser mandaria
  // a sessão do Admin para app.oria.com.br e para a landing — que é exatamente o que a arquitetura
  // proíbe. O prefixo __Host- faz o browser recusar o cookie nesse caso, mas o servidor não pode
  // depender disso: ele não emite o atributo, ponto.
  assert.doesNotMatch(cookie, /(^|;\s*)Domain=/i, 'o cookie do control plane NÃO pode ter atributo Domain');
});

test('cookie de plataforma · o nome difere do cookie do painel, em produção e em desenvolvimento', async () => {
  const { nomeDoCookie } = h.sujeito('lib/sessions.js');
  // Os nomes do Tenant Plane, como o painel os emite hoje (apps/panel/lib/auth/middleware.js).
  const doPainel = ['__Host-oria_session', 'oria_session'];
  for (const producao of [true, false]) {
    const nome = nomeDoCookie(producao);
    assert.ok(!doPainel.includes(nome), `o control plane usa o cookie do painel: ${nome}`);
    assert.match(nome, /platform/);
  }
});

test('cookie de plataforma · desenvolvimento: sem __Host- e sem Secure (não há HTTPS), e ainda sem Domain', async () => {
  const r = await app.cliente.login('dev@exemplo.com');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^oria_platform_session=/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test('logout apaga apenas o cookie DESTE host — e também sem Domain', async () => {
  const cliente = h.criarCliente(app.base, ADMIN);
  await cliente.login('dev@exemplo.com');
  const r = await cliente.post('/api/platform/auth/logout');
  assert.equal(r.status, 204);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^oria_platform_session=/);
  assert.match(cookie, /Max-Age=0/);
  assert.doesNotMatch(cookie, /Domain=/i);
  // E não há tentativa de apagar cookie de outro host: um Set-Cookie só.
  assert.equal(cookie.split(/,(?=\s*[A-Za-z_-]+=)/).length, 1);
});

// ── Origem (§21, §37) ────────────────────────────────────────────────────────────────────────

test('mutação do control plane vinda de PLATFORM_ADMIN_URL é permitida', async () => {
  const cliente = h.criarCliente(app.base, ADMIN);
  const r = await cliente.login('dev@exemplo.com');
  assert.equal(r.status, 200);
  const criar = await cliente.post('/api/platform/plans', { chave: 'origem_ok', nome: 'Origem OK', features: [] });
  assert.equal(criar.status, 201);
});

test('mutação vinda de APP_URL (painel) é NEGADA', async () => {
  const cliente = h.criarCliente(app.base, ADMIN);
  await cliente.login('dev@exemplo.com');
  const r = await cliente.post('/api/platform/plans',
    { chave: 'origem_app', nome: 'X', features: [] }, { headers: { Origin: APP } });
  assert.equal(r.status, 403);
  assert.equal(r.corpo.erro, 'origem_nao_permitida');
});

test('mutação vinda de PUBLIC_SITE_URL (landing) é NEGADA', async () => {
  const cliente = h.criarCliente(app.base, ADMIN);
  await cliente.login('dev@exemplo.com');
  const r = await cliente.post('/api/platform/plans',
    { chave: 'origem_landing', nome: 'X', features: [] }, { headers: { Origin: PUBLICO } });
  assert.equal(r.status, 403);
  assert.equal(r.corpo.erro, 'origem_nao_permitida');
});

test('LOGIN a partir do painel ou da landing também é negado — é mutação', async () => {
  for (const origem of [APP, PUBLICO, 'https://evil.example']) {
    const cliente = h.criarCliente(app.base, origem);
    const r = await cliente.post('/api/platform/auth/login', { email: 'dev@exemplo.com', senha: h.SENHA_DE_TESTE });
    assert.equal(r.status, 403, `origem ${origem} conseguiu chegar ao login`);
    assert.equal(r.corpo.erro, 'origem_nao_permitida');
  }
});

test('LEITURA não é barrada por origem (o CSRF é quem protege escrita)', async () => {
  const cliente = h.criarCliente(app.base, ADMIN);
  await cliente.login('dev@exemplo.com');
  const r = await cliente.get('/api/platform/overview', { headers: { Origin: APP } });
  assert.equal(r.status, 200);
});

test('em produção, mutação SEM header Origin é negada; fora de produção, passa', async () => {
  const semOrigemProd = h.criarCliente(prod.base, null);
  const prodLogin = await semOrigemProd.post('/api/platform/auth/login',
    { email: 'prod@exemplo.com', senha: h.SENHA_DE_TESTE });
  assert.equal(prodLogin.status, 403);
  assert.equal(prodLogin.corpo.erro, 'origem_nao_permitida');

  // Em desenvolvimento, cliente não-browser (curl, script, teste) continua funcionando.
  const semOrigemDev = h.criarCliente(app.base, null);
  assert.equal((await semOrigemDev.login('dev@exemplo.com')).status, 200);
});

// ── Open redirect (§23, §38) ─────────────────────────────────────────────────────────────────

test('returnUrl · caminho local é respeitado, e sai absoluto sobre PLATFORM_ADMIN_URL', async () => {
  const cliente = h.criarCliente(app.base, ADMIN);
  const r = await cliente.post('/api/platform/auth/login',
    { email: 'dev@exemplo.com', senha: h.SENHA_DE_TESTE, returnUrl: '/organizations/abc?aba=planos' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.destino, `${ADMIN}/organizations/abc?aba=planos`);
});

test('returnUrl · host externo, protocol-relative e javascript: caem no destino padrão', async () => {
  const perigosos = [
    'https://evil.example',
    'https://evil.example/x',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'http://admin.oria.com.br.evil.example/',
    '/ok\nSet-Cookie: x=1',
  ];
  for (const returnUrl of perigosos) {
    const cliente = h.criarCliente(app.base, ADMIN);
    const r = await cliente.post('/api/platform/auth/login',
      { email: 'dev@exemplo.com', senha: h.SENHA_DE_TESTE, returnUrl });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.destino, `${ADMIN}/`, `returnUrl perigoso aceito: ${JSON.stringify(returnUrl)}`);
  }
});

test('returnUrl · o resolvedor puro recusa tudo que não é caminho local', () => {
  const { resolverRetorno } = h.sujeito('lib/urls.js');
  assert.equal(resolverRetorno('/settings'), '/settings');
  assert.equal(resolverRetorno('/a/b/c?d=1#e'), '/a/b/c?d=1#e');
  for (const v of ['https://evil.example', '//evil.example', 'javascript:x', 'settings', '', null, 42, '/\\x']) {
    assert.equal(resolverRetorno(v), null, `aceitou ${JSON.stringify(v)}`);
  }
});

// ── Configuração de host (§6, §7, §12, §34) ──────────────────────────────────────────────────

test('PLATFORM_ADMIN_URL é validada: sem path, sem credencial, https em produção', () => {
  const { resolverConfig } = h.sujeito('lib/config.js');
  const base = { DATABASE_URL: 'postgres://x/y', PLATFORM_ADMIN_SESSION_SECRET: 'z'.repeat(40) };
  const recusa = (env, motivo) => assert.throws(
    () => resolverConfig({ ...base, ...env }, { avisar: () => {} }),
    /PLATFORM_ADMIN_URL/,
    motivo
  );
  recusa({ PLATFORM_ADMIN_URL: 'https://admin.oria.com.br/painel' }, 'path deveria ser recusado');
  recusa({ PLATFORM_ADMIN_URL: 'https://u:p@admin.oria.com.br' }, 'credencial deveria ser recusada');
  recusa({ PLATFORM_ADMIN_URL: 'admin.oria.com.br' }, 'URL relativa deveria ser recusada');
  recusa({ PLATFORM_ADMIN_URL: 'https://admin.oria.com.br?x=1' }, 'query deveria ser recusada');
  recusa({ NODE_ENV: 'production', PLATFORM_ADMIN_URL: 'http://admin.oria.com.br' }, 'http em produção');
  recusa({ NODE_ENV: 'production', PLATFORM_ADMIN_URL: 'https://localhost:3000' }, 'localhost em produção');
  recusa({ NODE_ENV: 'production' }, 'ausente em produção deveria derrubar o boot');

  const ok = resolverConfig({ ...base, PLATFORM_ADMIN_URL: ADMIN }, { avisar: () => {} });
  assert.equal(ok.urls.platformAdmin.origem, ADMIN);
  assert.equal(ok.urls.platformAdmin.link('/audit'), `${ADMIN}/audit`);
});

test('o control plane não usa APP_URL nem PUBLIC_SITE_URL como identidade', () => {
  // A config carrega os três, mas só `platformAdmin` é a identidade deste app: é dele que sai o
  // link e é ele que a validação de origem compara. Os outros existem para serem NEGADOS.
  assert.equal(app.config.urls.platformAdmin.origem, ADMIN);
  assert.equal(app.config.urls.app.origem, APP);
  assert.equal(app.config.urls.publicSite.origem, PUBLICO);

  const fonte = require('node:fs').readFileSync(require('node:path').join(h.RAIZ_SUJEITO, 'lib/app.js'), 'utf8');
  assert.doesNotMatch(fonte, /urls\.app\b/, 'app.js usa APP_URL — o host do painel não manda no control plane');
  assert.doesNotMatch(fonte, /urls\.publicSite\b/, 'app.js usa PUBLIC_SITE_URL');
  // E o construtor do cookie, chamado direto, nunca produz `Domain` — em nenhum dos dois modos.
  const { cookieDeSessao, cookieApagado } = h.sujeito('lib/sessions.js');
  const daqui = new Date(Date.now() + 3600e3);
  for (const producao of [true, false]) {
    assert.doesNotMatch(cookieDeSessao({ producao, token: 'x'.repeat(43), expiraEm: daqui }), /Domain=/i);
    assert.doesNotMatch(cookieApagado({ producao }), /Domain=/i);
  }
});
