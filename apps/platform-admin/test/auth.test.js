'use strict';

// Auth do platform admin (§28 · bloco "Auth").
//
// O que estes testes provam, e que nenhum deles prova por inspeção de código:
//   · uma sessão de TENANT não vale no control plane;
//   · sessão revogada e sessão expirada param de valer na request SEGUINTE;
//   · escrita sem CSRF é recusada, mesmo com cookie válido;
//   · o login não reaproveita id de sessão vindo do cliente (fixation);
//   · a resposta não diz se o e-mail existe.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./harness');

let db;
let app;

test.before(async () => {
  db = await h.bancoNovo();
  app = await h.subirApp(db.url);
});

test.after(async () => {
  await app.fechar();
  await db.destruir();
});

test('health responde ok, sem sessão e sem dado sensível', async () => {
  const r = await app.cliente.get('/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo, { status: 'ok' });
});

test('sem nenhum platform admin, o login diz bootstrap_pendente (e o app está no ar)', async () => {
  const r = await app.cliente.post('/api/platform/auth/login', { email: 'ninguem@exemplo.com', senha: 'seja-la-o-que-for' });
  assert.equal(r.status, 503);
  assert.equal(r.corpo.erro, 'bootstrap_pendente');
});

test('login com credencial correta devolve cookie HttpOnly, SameSite=Strict e csrfToken', async () => {
  await h.criarAdmin(app.pool, { email: 'owner@exemplo.com', papel: 'platform_owner' });
  const r = await app.cliente.login('owner@exemplo.com');
  assert.equal(r.status, 200);
  assert.equal(r.corpo.admin.email, 'owner@exemplo.com');
  assert.equal(r.corpo.admin.papel, 'platform_owner');
  assert.ok(r.corpo.csrfToken);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^oria_platform_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  // Fora de produção não há Secure nem __Host-; a decisão é da config, não do handler.
  assert.doesNotMatch(cookie, /Secure/);
  // A resposta do login NUNCA carrega hash, token de sessão nem senha.
  assert.doesNotMatch(r.texto, /password|hash|senha/i);
});

test('e-mail inexistente e senha errada dão a MESMA resposta', async () => {
  const cliente = h.criarCliente(app.base);
  const inexistente = await cliente.post('/api/platform/auth/login', { email: 'nao-existe@exemplo.com', senha: h.SENHA_DE_TESTE });
  const errada = await cliente.post('/api/platform/auth/login', { email: 'owner@exemplo.com', senha: 'senha-errada-mas-longa' });
  assert.equal(inexistente.status, 401);
  assert.equal(errada.status, 401);
  assert.deepEqual(inexistente.corpo, errada.corpo);
  assert.equal(inexistente.corpo.erro, 'credenciais_invalidas');
});

test('admin desativado não entra, e a resposta não o distingue de senha errada', async () => {
  await h.criarAdmin(app.pool, { email: 'desativado@exemplo.com', papel: 'platform_operator', status: 'disabled' });
  const cliente = h.criarCliente(app.base);
  const r = await cliente.post('/api/platform/auth/login', { email: 'desativado@exemplo.com', senha: h.SENHA_DE_TESTE });
  assert.equal(r.status, 401);
  assert.equal(r.corpo.erro, 'credenciais_invalidas');
});

test('sessão de TENANT não vale no control plane', async () => {
  // Uma sessão legítima do painel: linha em `sessions`, com um `users` de verdade.
  const { rows: [u] } = await app.pool.query(
    `INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    ['pessoa@tenant.com', 'Pessoa', 'scrypt$1$32768$8$1$AAAA$BBBB']
  );
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.createHash('sha256').update(token).digest('hex');
  await app.pool.query(
    `INSERT INTO sessions (id, user_id, metodo, expira_em) VALUES ($1, $2, 'senha', now() + interval '1 hour')`,
    [id, u.id]
  );

  const cliente = h.criarCliente(app.base);
  cliente.cookie = `oria_platform_session=${token}`;
  const r = await cliente.get('/api/platform/overview');
  assert.equal(r.status, 401);
  assert.equal(r.corpo.erro, 'nao_autenticado');
});

test('sessão revogada para de valer na request seguinte', async () => {
  const cliente = h.criarCliente(app.base);
  await cliente.login('owner@exemplo.com');
  assert.equal((await cliente.get('/api/platform/overview')).status, 200);

  await app.pool.query(`UPDATE platform_admin_sessions SET revogada_em = now() WHERE revogada_em IS NULL`);
  const depois = await cliente.get('/api/platform/overview');
  assert.equal(depois.status, 401);
});

test('sessão expirada não vale', async () => {
  const cliente = h.criarCliente(app.base);
  await cliente.login('owner@exemplo.com');
  await app.pool.query(
    `UPDATE platform_admin_sessions SET criado_em = now() - interval '2 days', expira_em = now() - interval '1 second'
      WHERE revogada_em IS NULL`
  );
  assert.equal((await cliente.get('/api/platform/overview')).status, 401);
});

test('escrita sem header CSRF é recusada, mesmo com cookie válido', async () => {
  const cliente = h.criarCliente(app.base);
  await cliente.login('owner@exemplo.com');
  const semCsrf = await cliente.post('/api/platform/plans',
    { chave: 'sem_csrf', nome: 'Sem CSRF', features: [] }, { semCsrf: true });
  assert.equal(semCsrf.status, 403);
  assert.equal(semCsrf.corpo.erro, 'csrf');

  const comCsrf = await cliente.post('/api/platform/plans', { chave: 'com_csrf', nome: 'Com CSRF', features: [] });
  assert.equal(comCsrf.status, 201);
});

test('CSRF de OUTRA sessão não vale nesta', async () => {
  const a = h.criarCliente(app.base);
  const b = h.criarCliente(app.base);
  await h.criarAdmin(app.pool, { email: 'operador@exemplo.com', papel: 'platform_operator' });
  await a.login('owner@exemplo.com');
  await b.login('operador@exemplo.com');

  const r = await a.post('/api/platform/plans', { chave: 'csrf_alheio', nome: 'X', features: [] }, { csrf: b.csrf });
  assert.equal(r.status, 403);
  assert.equal(r.corpo.erro, 'csrf');
});

test('fixation · o login gera token novo e revoga as sessões anteriores do mesmo admin', async () => {
  const primeira = h.criarCliente(app.base);
  await primeira.login('owner@exemplo.com');
  const cookieAntigo = primeira.cookie;
  assert.equal((await primeira.get('/api/platform/auth/session')).status, 200);

  const segunda = h.criarCliente(app.base);
  const r = await segunda.login('owner@exemplo.com');
  assert.equal(r.status, 200);
  assert.notEqual(segunda.cookie, cookieAntigo, 'o login devolveu o MESMO token — é fixation');

  // A sessão anterior morreu.
  assert.equal((await primeira.get('/api/platform/auth/session')).status, 401);
});

test('o cliente não escolhe o id da sessão: um cookie forjado não vira sessão', async () => {
  const cliente = h.criarCliente(app.base);
  cliente.cookie = `oria_platform_session=${crypto.randomBytes(32).toString('base64url')}`;
  assert.equal((await cliente.get('/api/platform/overview')).status, 401);
});

test('rate limit · o balde da conta fecha depois de 10 falhas e devolve Retry-After', async () => {
  const cliente = h.criarCliente(app.base);
  await h.criarAdmin(app.pool, { email: 'alvo@exemplo.com', papel: 'platform_operator' });
  let ultima;
  for (let i = 0; i < 11; i += 1) {
    ultima = await cliente.post('/api/platform/auth/login', { email: 'alvo@exemplo.com', senha: 'errada-mas-comprida' });
  }
  assert.equal(ultima.status, 429);
  assert.equal(ultima.corpo.erro, 'rate_limited');
  assert.ok(Number(ultima.headers.get('retry-after')) >= 1);

  // E o balde é POR CONTA: outra conta continua podendo tentar.
  const outra = await cliente.post('/api/platform/auth/login', { email: 'owner@exemplo.com', senha: 'errada-mas-comprida' });
  assert.equal(outra.status, 401);
});

test('logout revoga a sessão e apaga o cookie', async () => {
  const cliente = h.criarCliente(app.base);
  await cliente.login('owner@exemplo.com');
  const r = await cliente.post('/api/platform/auth/logout');
  assert.equal(r.status, 204);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  cliente.cookie = null;
  assert.equal((await cliente.get('/api/platform/auth/session')).status, 401);
});

test('em produção o cookie é __Host- e Secure (detalhes de host em hosts.test.js)', async () => {
  const outro = await h.subirApp(db.url, {
    NODE_ENV: 'production',
    PLATFORM_ADMIN_URL: 'https://admin.oria.com.br',
  });
  try {
    const r = await outro.cliente.post('/api/platform/auth/login', { email: 'owner@exemplo.com', senha: h.SENHA_DE_TESTE });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /^__Host-oria_platform_session=/);
    assert.match(cookie, /Secure/);
  } finally {
    await outro.fechar();
  }
});

test('corpo com campo desconhecido é 400 (whitelist estrita)', async () => {
  const cliente = h.criarCliente(app.base);
  await cliente.login('owner@exemplo.com');
  const r = await cliente.post('/api/platform/plans', { chave: 'x_plano', nome: 'X', features: [], preco: 99 });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, 'campo_desconhecido');
  assert.deepEqual(r.corpo.detalhes.campos, ['preco']);
});

test('rota inexistente é 404 e método errado é 405 — sem stack, sem SQL', async () => {
  const cliente = h.criarCliente(app.base);
  await cliente.login('owner@exemplo.com');
  const r404 = await cliente.get('/api/platform/nao-existe');
  assert.equal(r404.status, 404);
  const r405 = await cliente.delete('/api/platform/plans');
  assert.equal(r405.status, 405);
  for (const r of [r404, r405]) {
    assert.doesNotMatch(r.texto, /SELECT|INSERT|at Object|\.js:\d+/);
  }
});
