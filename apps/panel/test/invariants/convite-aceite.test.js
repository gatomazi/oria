'use strict';

// Aceite do convite de owner emitido pelo control plane (lib/auth/invites.js · migration 0020 ·
// docs/architecture/invite-acceptance.md).
//
// Tudo roda sob a role `oria_app` (NOSUPERUSER, NOBYPASSRLS, não dona), em Postgres descartável
// migrado do zero — é sob ela que o `GRANT EXECUTE` das duas funções SECURITY DEFINER precisa
// valer, e é ela quem grava o membership sob a RLS forçada.
//
// O que está sob teste:
//
//   hash        o painel confere o convite pelo MESMO SHA-256 da emissão, nunca por igualdade de
//               texto; o token cru não existe no banco
//   identidade  o e-mail do convite é quem aceita: conta nova define senha; conta existente exige
//               sessão autenticada daquela conta, e a senha dela nunca é tocada
//   opacidade   desconhecido | usado | revogado | expirado dão a MESMA resposta; o motivo real só
//               aparece no log do servidor, sem o token e sem o hash inteiro
//   isolamento  convite da Organization B não dá nada na Organization A
//   atomicidade toda recusa desfaz o consumo — o convite volta a valer
//   grant       as duas funções são executáveis pela role da aplicação, e só por ela

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const h = require('./harness');
const { createAuth, resolverConfigAuth } = h.sujeito('lib/auth/index.js');
const { createLoginLimiter, createConviteLimiter } = h.sujeito('lib/auth/rate-limit.js');
const senhas = h.sujeito('lib/auth/password.js');
const invites = h.sujeito('lib/auth/invites.js');
const { comOrganization } = h.sujeito('lib/platform/tenant-db.js');
const { sqlProvisionarAppRole, FUNCOES_DA_APLICACAO } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');

const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_SUL = 'a1000000-0000-4000-8000-000000000001';
const ORG_CENTRO = 'a1000000-0000-4000-8000-000000000002';
const SEGREDO = crypto.randomBytes(32).toString('base64url');
const SENHA = 'senha-forte-do-convidado-1';
const SENHA_NOVA = 'outra-senha-forte-do-convidado-2';

let db;
let sup;
let appPool;
let roleApp;
const servidores = [];

// ── Emissão, como o control plane faz ────────────────────────────────────────────────────────
// Cópia declarada de apps/platform-admin/lib/organizations.js (§15): token opaco de 256 bits em
// base64url, e no banco só o SHA-256 em hex. O painel é outro deployable e não importa aquele
// código — por isso o teste `hash · a emissão e o aceite usam o mesmo algoritmo` lê o arquivo do
// control plane e exige que as duas expressões continuem iguais.
const emitirToken = () => crypto.randomBytes(32).toString('base64url');
const hashDaEmissao = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function semearConvite({
  organizationId = ORG_SUL, email, papel = 'owner', validadeHoras = 72, token = emitirToken(),
} = {}) {
  const { rows: [c] } = await sup.query(
    `INSERT INTO organization_owner_invites (organization_id, token_hash, email, papel, expira_em)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval) RETURNING id`,
    [organizationId, hashDaEmissao(token), email, papel, String(validadeHoras)]
  );
  return { id: c.id, token, email, organizationId, papel };
}

const emailNovo = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}@convite.teste`;

async function conviteNoBanco(id) {
  const { rows: [c] } = await sup.query(
    'SELECT token_hash, usado_em, usado_por, revogado_em FROM organization_owner_invites WHERE id = $1', [id]
  );
  return c;
}

async function membros(organizationId) {
  const { rows } = await sup.query(
    'SELECT user_id, papel FROM organization_members WHERE organization_id = $1', [organizationId]
  );
  return rows;
}

// App mínima com o auth real — as rotas de convite moram no router de identidade.
async function subirApp({ limiterConvite } = {}) {
  const auth = createAuth({
    pool: appPool,
    config: resolverConfigAuth({ ADMIN_SESSION_SECRET: SEGREDO }),
    comOrganization,
    auditar: async () => {},
    limiter: createLoginLimiter(),
    limiterConvite,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', auth.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servidores.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function navegador(base) {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo, semCsrf = false } = {}) => {
    const headers = {};
    if (corpo !== undefined) headers['Content-Type'] = 'application/json';
    if (nav.cookie) headers.Cookie = nav.cookie;
    if (!semCsrf && nav.csrf && metodo !== 'GET') headers['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, {
      method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const valor = setCookie.split(';')[0];
      nav.cookie = valor.endsWith('=') ? null : valor;
    }
    const json = await res.json().catch(() => null);
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json };
  };
  nav.login = (email, senha = SENHA) => nav.req('POST', '/api/admin/login', { corpo: { email, password: senha } });
  nav.consultar = (token) => nav.req('POST', '/api/admin/convite/consultar', { corpo: { token } });
  nav.aceitar = (corpo, opcoes) => nav.req('POST', '/api/admin/convite/aceitar', { corpo, ...opcoes });
  return nav;
}

// Captura console.warn/error do processo durante `fn` — é onde o motivo real do convite aparece.
async function capturandoLog(fn) {
  const linhas = [];
  const originais = { warn: console.warn, error: console.error };
  console.warn = (...args) => linhas.push(args.join(' '));
  console.error = (...args) => linhas.push(args.join(' '));
  try {
    return { resultado: await fn(), linhas };
  } finally {
    Object.assign(console, originais);
  }
}

let base;

test.before(async () => {
  const urlApp = process.env.INVARIANTS_APP_DATABASE_URL;
  assert.ok(urlApp, 'INVARIANTS_APP_DATABASE_URL ausente — rode pelo npm test (scripts/test-db.mjs provisiona oria_app)');
  const credencial = new URL(urlApp);
  roleApp = decodeURIComponent(credencial.username);

  db = await h.criarBancoDescartavel('oria_convite');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({
    role: roleApp, senha: decodeURIComponent(credencial.password), tabelasSobRls: manifesto.nomesSobRls(),
  })) await sup.query(sql);
  appPool = h.abrirPoolDescartavel(h.urlComUsuario(db.url, roleApp, decodeURIComponent(credencial.password)), { max: 10 });
  const { rows: [eu] } = await appPool.query(
    'SELECT current_user AS u, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS escapa'
  );
  assert.equal(eu.escapa, false, 'a role da aplicação não pode ter SUPERUSER nem BYPASSRLS');
  base = await subirApp();
});

test.after(async () => {
  for (const s of servidores) await new Promise((r) => s.close(r));
  await appPool?.end();
  await sup?.end();
  await db?.destruir();
});

// ── O GRANT (§3 do comando) ──────────────────────────────────────────────────────────────────

test('grant · a role da aplicação executa as duas funções do convite', async () => {
  for (const assinatura of ['platform_convite_pendente(text)', 'platform_consumir_convite(text, uuid)']) {
    const { rows: [p] } = await appPool.query(
      'SELECT has_function_privilege(current_user, $1, $2) AS pode', [assinatura, 'EXECUTE']
    );
    assert.equal(p.pode, true,
      `${assinatura} sem EXECUTE para ${roleApp} — a rota de aceite não funciona sob a role da aplicação (OPS-14)`);
  }
  // E o registro canônico que produz esse GRANT continua declarando as duas.
  assert.ok(FUNCOES_DA_APLICACAO.includes('platform_convite_pendente(TEXT)'));
  assert.ok(FUNCOES_DA_APLICACAO.includes('platform_consumir_convite(TEXT, UUID)'));
});

test('grant · as funções do convite continuam fora de PUBLIC', async () => {
  const { rows: [p] } = await sup.query(
    `SELECT has_function_privilege('public', 'platform_convite_pendente(text)', 'EXECUTE') AS pendente,
            has_function_privilege('public', 'platform_consumir_convite(text, uuid)', 'EXECUTE') AS consumir`
  );
  assert.deepEqual(p, { pendente: false, consumir: false },
    'REVOKE ALL … FROM PUBLIC das 0019/0020 foi perdido — qualquer role passaria a consumir convite');
});

test('tenancy · organization_owner_invites continua global PRIVADA para a role da aplicação', async () => {
  assert.ok(manifesto.TABELAS_GLOBAIS_PRIVADAS.includes('organization_owner_invites'));
  await assert.rejects(
    () => appPool.query('SELECT token_hash FROM organization_owner_invites LIMIT 1'),
    /permission denied/i,
    'a role da aplicação passou a LER a tabela de convites — o acesso é só pela função SECURITY DEFINER'
  );
});

// ── O hash (§2 do comando) ───────────────────────────────────────────────────────────────────

test('hash · a emissão e o aceite usam o mesmo algoritmo, e o token cru não vai ao banco', async () => {
  // Vetor fixo: se alguém trocar o algoritmo em qualquer um dos lados, isto reprova.
  assert.equal(
    invites.sha256('convite-de-referencia'),
    crypto.createHash('sha256').update('convite-de-referencia').digest('hex')
  );
  const origem = fs.readFileSync(
    path.join(h.RAIZ_REPO, '..', 'platform-admin', 'lib', 'organizations.js'), 'utf8'
  );
  assert.match(
    origem,
    /const sha256 = \(v\) => crypto\.createHash\('sha256'\)\.update\(v\)\.digest\('hex'\);/,
    'a emissão do control plane mudou de algoritmo — o aceite precisa mudar junto'
  );
  assert.match(origem, /crypto\.randomBytes\(32\)\.toString\('base64url'\)/);

  const c = await semearConvite({ email: emailNovo('hash') });
  const linha = await conviteNoBanco(c.id);
  assert.equal(linha.token_hash, invites.sha256(c.token));
  assert.match(linha.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!linha.token_hash.includes(c.token), 'o token cru apareceu no banco');
});

// ── Caminho feliz ────────────────────────────────────────────────────────────────────────────

test('aceite · conta nova: define senha, entra e cai na Organization do convite', async () => {
  const email = emailNovo('owner');
  const c = await semearConvite({ email, organizationId: ORG_SUL });
  const nav = navegador(base);

  const consulta = await nav.consultar(c.token);
  assert.equal(consulta.status, 200);
  assert.deepEqual(
    { email: consulta.json.email, papel: consulta.json.papel, contaExistente: consulta.json.contaExistente },
    { email, papel: 'owner', contaExistente: false }
  );
  assert.equal(consulta.json.organizationNome, 'Use Sul');
  // Consultar NÃO consome.
  assert.equal((await conviteNoBanco(c.id)).usado_em, null);

  const aceite = await nav.aceitar({ token: c.token, senha: SENHA, nome: 'Dona da Organization' });
  assert.equal(aceite.status, 201, JSON.stringify(aceite.json));
  assert.equal(aceite.json.organizationId, ORG_SUL);
  assert.equal(aceite.json.contaCriada, true);

  // Convite consumido, apontando para a pessoa criada.
  const linha = await conviteNoBanco(c.id);
  assert.ok(linha.usado_em);
  assert.equal(linha.usado_por, aceite.json.user.id);

  // Membership com o papel do convite — e só na Organization do convite.
  const doSul = await membros(ORG_SUL);
  assert.ok(doSul.some((m) => m.user_id === aceite.json.user.id && m.papel === 'owner'));
  assert.equal((await membros(ORG_CENTRO)).some((m) => m.user_id === aceite.json.user.id), false);

  // E a sessão já veio no cookie, com a Organization ativa resolvida pelo servidor.
  const sessao = await nav.req('GET', '/api/admin/session');
  assert.equal(sessao.json.authenticated, true);
  assert.equal(sessao.json.user.email, email);
  assert.equal(sessao.json.organizacaoAtiva.id, ORG_SUL);
  assert.equal(sessao.json.organizacaoAtiva.papel, 'owner');
  assert.equal(sessao.json.codigoOrganizacao, null);

  // A senha definida no aceite é a senha da conta: o login normal funciona com ela.
  const outro = navegador(base);
  assert.equal((await outro.login(email)).status, 200);

  // Auditoria com sujeito real, sem token.
  const { rows: [a] } = await sup.query(
    `SELECT actor_user_id, after::text FROM audit_log WHERE action = 'org.invite.accept' AND organization_id = $1
      ORDER BY criado_em DESC LIMIT 1`, [ORG_SUL]
  );
  assert.equal(a.actor_user_id, aceite.json.user.id);
  assert.ok(!a.after.includes(c.token));
});

test('aceite · o papel do convite é o papel do membership (member não vira owner)', async () => {
  const email = emailNovo('membro');
  const c = await semearConvite({ email, organizationId: ORG_CENTRO, papel: 'member' });
  const nav = navegador(base);
  const aceite = await nav.aceitar({ token: c.token, senha: SENHA });
  assert.equal(aceite.status, 201, JSON.stringify(aceite.json));
  assert.equal(aceite.json.papel, 'member');
  const m = (await membros(ORG_CENTRO)).find((x) => x.user_id === aceite.json.user.id);
  assert.equal(m.papel, 'member');
});

// ── Isolamento entre Organizations ───────────────────────────────────────────────────────────

test('isolamento · convite de outra Organization não dá acesso à Organization do contexto', async () => {
  const email = emailNovo('centro');
  const c = await semearConvite({ email, organizationId: ORG_CENTRO });
  const nav = navegador(base);
  const aceite = await nav.aceitar({ token: c.token, senha: SENHA });
  assert.equal(aceite.status, 201, JSON.stringify(aceite.json));
  assert.equal(aceite.json.organizationId, ORG_CENTRO);

  const sessao = await nav.req('GET', '/api/admin/session');
  assert.deepEqual(sessao.json.memberships.map((m) => m.organizationId), [ORG_CENTRO],
    'o aceite deu membership em mais de uma Organization');
  assert.equal(sessao.json.organizacaoAtiva.id, ORG_CENTRO);

  // E a troca para a Organization do convite de OUTRA pessoa é 404, como qualquer não-membro.
  const troca = await nav.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_SUL } });
  assert.equal(troca.status, 404);
  assert.equal((await membros(ORG_SUL)).some((m) => m.user_id === aceite.json.user.id), false);
});

// ── Falhas: uma resposta só (§"o que o usuário vê quando falha") ──────────────────────────────

test('opacidade · desconhecido, usado, revogado e expirado dão EXATAMENTE a mesma resposta', async () => {
  const nav = navegador(base);

  // 1. desconhecido — token bem formado que nunca existiu
  const desconhecido = emitirToken();
  // 2. usado
  const usado = await semearConvite({ email: emailNovo('usado') });
  assert.equal((await navegador(base).aceitar({ token: usado.token, senha: SENHA })).status, 201);
  // 3. revogado
  const revogado = await semearConvite({ email: emailNovo('revogado') });
  await sup.query('UPDATE organization_owner_invites SET revogado_em = now() WHERE id = $1', [revogado.id]);
  // 4. expirado
  const expirado = await semearConvite({ email: emailNovo('expirado') });
  await sup.query(
    `UPDATE organization_owner_invites SET criado_em = now() - interval '2 days', expira_em = now() - interval '1 minute'
      WHERE id = $1`, [expirado.id]
  );

  const respostas = [];
  for (const token of [desconhecido, usado.token, revogado.token, expirado.token]) {
    const consulta = await nav.consultar(token);
    const aceite = await nav.aceitar({ token, senha: SENHA });
    respostas.push(JSON.stringify([consulta.status, consulta.json, aceite.status, aceite.json]));
  }
  assert.equal(new Set(respostas).size, 1,
    `os quatro motivos são distinguíveis pela resposta:\n${respostas.join('\n')}`);
  assert.match(respostas[0], /convite inválido, expirado ou já usado/);
  assert.match(respostas[0], /404/);

  // Nenhum deles foi consumido pelas tentativas.
  assert.equal((await conviteNoBanco(revogado.id)).usado_em, null);
  assert.equal((await conviteNoBanco(expirado.id)).usado_em, null);
});

test('opacidade · o motivo real fica no log do servidor, sem o token e sem o hash inteiro', async () => {
  const expirado = await semearConvite({ email: emailNovo('log') });
  await sup.query(
    `UPDATE organization_owner_invites SET criado_em = now() - interval '2 days', expira_em = now() - interval '1 minute'
      WHERE id = $1`, [expirado.id]
  );
  const hash = invites.sha256(expirado.token);
  const { resultado, linhas } = await capturandoLog(() => navegador(base).aceitar({ token: expirado.token, senha: SENHA }));
  assert.equal(resultado.status, 404);
  const log = linhas.join('\n');
  assert.match(log, /\[CONVITE\].*expirado/, 'o motivo real precisa estar no log do servidor');
  assert.ok(!log.includes(expirado.token), 'o TOKEN apareceu no log');
  assert.ok(!log.includes(hash), 'o hash inteiro (a chave da linha no banco) apareceu no log');
  assert.ok(!JSON.stringify(resultado.json).includes(expirado.token));
});

test('opacidade · token malformado responde igual a token inexistente, sem tocar o banco', async () => {
  const nav = navegador(base);
  const inexistente = await nav.aceitar({ token: emitirToken(), senha: SENHA });
  for (const token of ['', 'curto', 'x'.repeat(200), `${emitirToken()}=`]) {
    const r = await nav.aceitar({ token, senha: SENHA });
    assert.deepEqual([r.status, r.json], [inexistente.status, inexistente.json], `token ${JSON.stringify(token)}`);
  }
});

// ── Identidade: o e-mail do convite, nunca o do request ──────────────────────────────────────

test('identidade · e-mail com conta: sem sessão o aceite recusa e NÃO troca a senha', async () => {
  const email = emailNovo('existente');
  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) RETURNING id, password_hash',
    [email, 'Já existia', await senhas.gerarHash(SENHA)]
  );
  const c = await semearConvite({ email, organizationId: ORG_SUL });

  const nav = navegador(base);
  const consulta = await nav.consultar(c.token);
  assert.equal(consulta.json.contaExistente, true, 'a tela precisa saber que aqui se pede login, não senha nova');

  const tentativa = await nav.aceitar({ token: c.token, senha: SENHA_NOVA });
  assert.equal(tentativa.status, 409);
  assert.equal(tentativa.json.codigo, 'conta_existente');

  const { rows: [depois] } = await sup.query('SELECT password_hash FROM users WHERE id = $1', [u.id]);
  assert.equal(depois.password_hash, u.password_hash, 'o aceite trocou a senha de uma conta que já existia');
  assert.equal(await senhas.verificarSenha(SENHA_NOVA, depois.password_hash), false);
  // E o convite continua valendo.
  assert.equal((await conviteNoBanco(c.id)).usado_em, null);

  // Com a conta autenticada, o mesmo convite é aceito.
  assert.equal((await nav.login(email)).status, 200);
  const aceite = await nav.aceitar({ token: c.token });
  assert.equal(aceite.status, 201, JSON.stringify(aceite.json));
  assert.equal(aceite.json.user.id, u.id);
  assert.equal(aceite.json.contaCriada, false);
  assert.ok((await membros(ORG_SUL)).some((m) => m.user_id === u.id && m.papel === 'owner'));
  const sessao = await nav.req('GET', '/api/admin/session');
  assert.equal(sessao.json.organizacaoAtiva.id, ORG_SUL);
});

test('identidade · sessão autenticada de OUTRO e-mail não consome o convite', async () => {
  const dono = emailNovo('dono');
  await sup.query('INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3)',
    [dono, 'Outra pessoa', await senhas.gerarHash(SENHA)]);
  const c = await semearConvite({ email: emailNovo('alvo'), organizationId: ORG_SUL });

  const nav = navegador(base);
  assert.equal((await nav.login(dono)).status, 200);
  const consulta = await nav.consultar(c.token);
  assert.equal(consulta.json.autenticadoComo, dono, 'a tela precisa poder oferecer "sair desta conta"');

  const tentativa = await nav.aceitar({ token: c.token });
  assert.equal(tentativa.status, 403);
  assert.equal(tentativa.json.codigo, 'convite_de_outra_conta');
  assert.equal((await conviteNoBanco(c.id)).usado_em, null, 'o convite foi consumido por quem não era o convidado');
  const { rows: [quem] } = await sup.query('SELECT id FROM users WHERE email = $1', [dono]);
  assert.equal((await membros(ORG_SUL)).some((m) => m.user_id === quem.id), false);
});

test('identidade · com sessão aberta o corpo não pode trazer senha', async () => {
  const email = emailNovo('comsessao');
  await sup.query('INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3)',
    [email, null, await senhas.gerarHash(SENHA)]);
  const c = await semearConvite({ email, organizationId: ORG_CENTRO });
  const nav = navegador(base);
  assert.equal((await nav.login(email)).status, 200);
  const r = await nav.aceitar({ token: c.token, senha: SENHA_NOVA });
  assert.equal(r.status, 400);
  assert.equal(r.json.codigo, 'senha_nao_aceita');
  assert.equal((await conviteNoBanco(c.id)).usado_em, null);
});

test('identidade · senha fraca ou ausente não cria conta e não consome o convite', async () => {
  const c = await semearConvite({ email: emailNovo('fraca') });
  const nav = navegador(base);
  for (const senha of [undefined, '', 'curta', 'x'.repeat(201)]) {
    const r = await nav.aceitar({ token: c.token, ...(senha === undefined ? {} : { senha }) });
    assert.equal(r.status, 400, `senha ${JSON.stringify(senha)}`);
    assert.equal(r.json.codigo, 'senha_invalida');
  }
  assert.equal((await conviteNoBanco(c.id)).usado_em, null);
  const { rows } = await sup.query('SELECT 1 FROM users WHERE email = $1', [c.email]);
  assert.equal(rows.length, 0);
});

// ── Whitelist, CSRF e método ─────────────────────────────────────────────────────────────────

test('entrada · o corpo é whitelist: organizationId (ou qualquer extra) é recusado', async () => {
  const c = await semearConvite({ email: emailNovo('extras') });
  const nav = navegador(base);
  for (const corpo of [
    { token: c.token, senha: SENHA, organizationId: ORG_CENTRO },
    { token: c.token, senha: SENHA, email: 'outro@teste.oria' },
    { token: c.token, senha: SENHA, papel: 'owner' },
  ]) {
    const r = await nav.aceitar(corpo);
    assert.equal(r.status, 400, JSON.stringify(corpo));
    assert.equal(r.json.codigo, 'campos_nao_aceitos');
  }
  assert.equal((await conviteNoBanco(c.id)).usado_em, null);
});

test('entrada · o token não viaja em URL: GET não existe nas duas rotas', async () => {
  const c = await semearConvite({ email: emailNovo('get') });
  for (const rota of ['/api/admin/convite/aceitar', '/api/admin/convite/consultar']) {
    const res = await fetch(`${base}${rota}?token=${encodeURIComponent(c.token)}`);
    assert.ok(res.status === 404 || res.status === 405, `${rota} respondeu ${res.status} a um GET`);
  }
  assert.equal((await conviteNoBanco(c.id)).usado_em, null);
});

test('csrf · com sessão aberta, aceitar sem o header é 403', async () => {
  const email = emailNovo('csrf');
  await sup.query('INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3)',
    [email, null, await senhas.gerarHash(SENHA)]);
  const c = await semearConvite({ email, organizationId: ORG_SUL });
  const nav = navegador(base);
  assert.equal((await nav.login(email)).status, 200);
  const r = await nav.aceitar({ token: c.token }, { semCsrf: true });
  assert.equal(r.status, 403);
  assert.equal(r.json.codigo, 'csrf');
  assert.equal((await conviteNoBanco(c.id)).usado_em, null);
});

// ── Atomicidade ──────────────────────────────────────────────────────────────────────────────

test('atomicidade · Organization suspensa recusa e devolve o convite', async () => {
  const c = await semearConvite({ email: emailNovo('suspensa'), organizationId: ORG_CENTRO });
  await sup.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ORG_CENTRO]);
  try {
    const r = await navegador(base).aceitar({ token: c.token, senha: SENHA });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'organization_indisponivel');
    assert.equal((await conviteNoBanco(c.id)).usado_em, null, 'o convite foi gasto numa Organization indisponível');
    const { rows } = await sup.query('SELECT 1 FROM users WHERE email = $1', [c.email]);
    assert.equal(rows.length, 0, 'a conta foi criada mesmo com o aceite recusado');
  } finally {
    await sup.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [ORG_CENTRO]);
  }
  // Com a Organization de volta, o MESMO convite ainda vale.
  const r = await navegador(base).aceitar({ token: c.token, senha: SENHA });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('atomicidade · dois aceites simultâneos: um entra, o outro vê convite inválido', async () => {
  const c = await semearConvite({ email: emailNovo('corrida'), organizationId: ORG_SUL });
  const [a, b] = await Promise.all([
    navegador(base).aceitar({ token: c.token, senha: SENHA }),
    navegador(base).aceitar({ token: c.token, senha: SENHA }),
  ]);
  const status = [a.status, b.status].sort();
  assert.deepEqual(status, [201, 404], `respostas: ${JSON.stringify([a.json, b.json])}`);
  const { rows } = await sup.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [c.email]);
  assert.equal(rows[0].n, 1, 'o e-mail do convite virou duas contas');
  const ganhador = (a.status === 201 ? a : b).json.user.id;
  assert.equal((await membros(ORG_SUL)).filter((m) => m.user_id === ganhador).length, 1);
});

// ── Rate limit ───────────────────────────────────────────────────────────────────────────────

test('rate limit · o balde por token fecha o loop em cima de um convite só', async () => {
  const limiterConvite = createConviteLimiter({ maxPorConta: 3, maxGlobal: 1000 });
  const baseLimitada = await subirApp({ limiterConvite });
  const nav = navegador(baseLimitada);
  const token = emitirToken();
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await nav.aceitar({ token, senha: SENHA })).status, 404, `tentativa ${i + 1}`);
  }
  const bloqueado = await nav.aceitar({ token, senha: SENHA });
  assert.equal(bloqueado.status, 429);
  // Outro token ainda passa: o balde é por convite, não global.
  assert.equal((await nav.aceitar({ token: emitirToken(), senha: SENHA })).status, 404);
});

test('rate limit · o balde global freia a varredura de tokens diferentes', async () => {
  const limiterConvite = createConviteLimiter({ maxPorConta: 1000, maxGlobal: 3 });
  const baseLimitada = await subirApp({ limiterConvite });
  const nav = navegador(baseLimitada);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await nav.aceitar({ token: emitirToken(), senha: SENHA })).status, 404, `varredura ${i + 1}`);
  }
  assert.equal((await nav.aceitar({ token: emitirToken(), senha: SENHA })).status, 429,
    'cada chute é uma chave nova — sem o balde global a varredura seria ilimitada');
});

test('rate limit · a chave do balde é derivada do hash, nunca do token', async () => {
  const vistos = [];
  const limiterConvite = {
    bloqueado: (k) => { vistos.push(k); return false; },
    registrarFalha: (k) => vistos.push(k),
    registrarSucesso: (k) => vistos.push(k),
  };
  const baseEspiada = await subirApp({ limiterConvite });
  const token = emitirToken();
  await navegador(baseEspiada).aceitar({ token, senha: SENHA });
  assert.ok(vistos.length > 0);
  for (const k of vistos) {
    assert.match(k, /^convite:[0-9a-f]{12}$/);
    assert.ok(!k.includes(token), 'o token cru virou chave de rate limit');
    // Prefixo do hash, e só o prefixo: a chave não reconstrói o que está gravado no banco.
    assert.ok(invites.sha256(token).startsWith(k.slice('convite:'.length)));
    assert.notEqual(k.slice('convite:'.length), invites.sha256(token));
  }
});
