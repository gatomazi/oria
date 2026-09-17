'use strict';

// Fase 6 · rollback LOCAL do cutover do Tenant #1 (runbook: docs/productization/overnight-trilha-a.md,
// seção "Rollback Fase 6").
//
// O cutover não cria schema nem apaga nada; o rollback é de configuração e de caminho de leitura:
//
//   1  confere as pré-condições das alavancas (login de emergência, Ink pelo ambiente, colunas antigas
//      legíveis pela release anterior, remetente legado do Go) — sem elas, FAIL e nada é escrito;
//   2  com --aplicar, só audita; a impressão digital prova que nenhuma linha saiu nem trocou de
//      Organization;
//   3  as alavancas funcionam de verdade no código de produto (login legado sob a role da aplicação,
//      Ink lida do ambiente só com a flag e só para a loja da Store do contexto);
//   4  roll-forward (apply de novo) não muda nada e o verify segue verde.
//
// Controles negativos: colunas antigas limpas → FAIL; linha trocada de Organization → a comparação
// de impressões acusa; owner que não cobre todas as Organizations → FAIL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const express = require('express');

const h = require('./harness');
const e = require('../helpers/tenant1-ensaio');
const runtime = require('../../lib/platform/tenant-runtime.js');
const { createIntegrationResolver } = require('../../lib/platform/integrations.js');
const { createSecretStore } = require('../../lib/secrets/store.js');
const { createKeyring } = require('../../lib/secrets/keyring.js');
const { createAuth, resolverConfigAuth } = require('../../lib/auth/index.js');
const { comOrganization } = require('../../lib/platform/tenant-db.js');
const { registrarAuditoria } = require('../../lib/platform/audit.js');

const A = {
  sul: 'a1000000-0000-4000-8000-000000000001',
  centro: 'a1000000-0000-4000-8000-000000000002',
  norte: 'a1000000-0000-4000-8000-000000000003',
};
const B = 'b1000000-0000-4000-8000-000000000001';
const silencioso = { log() {}, warn() {}, error() {} };
const statusDe = (r, id) => e.itensDe(r.linhas).filter((i) => i.id === id).map((i) => i.status);

function assertSoPassOuInfo(r, contexto) {
  const ruins = e.itensDe(r.linhas).filter((i) => i.status !== 'PASS' && i.status !== 'INFO');
  assert.deepEqual(ruins, [], `${contexto}:\n${r.linhas.join('\n')}`);
  assert.equal(r.codigo, 0, `${contexto}:\n${r.linhas.join('\n')}`);
}

async function contagemAudit(sup, acao) {
  const { rows } = await sup.query('SELECT organization_id::text AS org, count(*)::int AS n FROM audit_log WHERE action = $1 GROUP BY 1 ORDER BY 1', [acao]);
  return Object.fromEntries(rows.map((r) => [r.org, r.n]));
}

function resolverDaApp(appPool, mestra, env) {
  const fachada = runtime.criarPoolTenant(appPool);
  return createIntegrationResolver({
    pool: fachada, segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: mestra }) }), env, logger: silencioso,
  });
}

// Login legado real (mesmos módulos do server.js), sob a role da aplicação.
async function loginDeEmergencia(t, appPool, envAuth) {
  const config = resolverConfigAuth({ ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'), ...envAuth });
  const auth = createAuth({ pool: appPool, config, comOrganization, auditar: (x) => registrarAuditoria(appPool, x) });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', auth.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: envAuth.ADMIN_PASSWORD }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const sessao = await (await fetch(`${base}/api/admin/session`, { headers: { Cookie: cookie } })).json();
  return { status: login.status, sessao };
}

test('rollback Fase 6 · cenário A (banco novo): pré-condições, alavancas reais, dados intactos, roll-forward', { timeout: 300000 }, async (t) => {
  const s = e.segredosDoEnsaio();
  const db = await h.criarBancoDescartavel('oria_t1rb_a');
  t.after(() => db.destruir());
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  const sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  t.after(() => sup.end());
  const role = e.roleDoEnsaio(t, 'oria_t1rba');
  await role.provisionar(sup, db.url);
  const appPool = h.abrirPoolDescartavel(h.urlComUsuario(db.url, role.role, role.senha), { max: 3 });
  t.after(() => appPool.end());
  const uploads = e.diretorioTemporario(t, 'oria-t1-up-');

  // Variante declarada do cenário A: além das três cadeias, a pessoa da operação é owner das três
  // (é quem o login de emergência representa). Sem WhatsApp e sem URL da Ink nesta execução.
  const dir = e.diretorioTemporario(t, 'oria-t1-rb-');
  const fixture = JSON.parse(fs.readFileSync(e.ARQUIVO.A, 'utf8'));
  const arquivo = path.join(dir, 'a-operacao.json');
  fs.writeFileSync(arquivo, JSON.stringify({
    ...fixture,
    mapeamentoTenancy: e.MAPEAMENTO.A,
    owners: [...fixture.owners, { email: 'operacao@ensaio.oria', passwordHashEnv: 'TENANT1_OWNER_HASH', organizations: Object.values(A) }],
    whatsapp: null,
    inkWebhook: null,
  }));
  const base = ['--scenario', 'A', '--mapping', arquivo, '--uploads', uploads, '--app-role', role.role];

  // No apply, só a loja Sul tem credencial Ink no ambiente.
  const envCompleto = await e.ambiente('A', s, { url: db.url });
  const envApply = { ...envCompleto };
  for (const l of ['CENTRO', 'NORTE']) for (const n of ['INK_TOKEN_', 'INK_FEED_URL_', 'INK_WEBHOOK_SECRET_']) delete envApply[`${n}${l}`];
  // whatsapp: null só vale sem remetente legado no ambiente (rodada 19 §2).
  for (const n of Object.keys(envApply)) if (n.startsWith('WHATSAPP_LEGACY_')) delete envApply[n];

  const pre = await e.executar('preflight', base, envApply);
  assert.equal(pre.codigo, 0, pre.linhas.join('\n'));
  assert.deepEqual(statusDe(pre, `tenancy.organization[${A.norte}]`), ['PEND'], 'banco novo: as Organizations nascem no apply');
  assertSoPassOuInfo(await e.executar('apply', base, envApply), 'apply A');
  assertSoPassOuInfo(await e.executar('verify', base, envApply), 'verify A');

  const { impressaoDigital, compararImpressoes } = await e.modulo('checks.mjs');
  const antes = await impressaoDigital(db.url);
  const auditAntes = await contagemAudit(sup, 'tenant1.apply');

  // 1. Pré-condições: sem login de emergência e sem Ink no ambiente → FAIL, nada escrito.
  const semAlavancas = await e.executar('rollback', ['--scenario', 'A', '--mapping', arquivo, '--aplicar'], envApply);
  assert.equal(semAlavancas.codigo, 1);
  assert.deepEqual(statusDe(semAlavancas, 'rollback.login-emergencia'), ['FAIL']);
  assert.deepEqual(statusDe(semAlavancas, `rollback.ink-leitura[${A.centro}]`), ['FAIL']);
  assert.deepEqual(statusDe(semAlavancas, `rollback.ink-webhook[${A.norte}]`), ['FAIL']);
  assert.deepEqual(compararImpressoes(antes, await impressaoDigital(db.url)), []);
  assert.deepEqual(await contagemAudit(sup, 'tenant1.rollback'), {});

  // Controle negativo: o login de emergência representando um owner de UMA cadeia não serve para A.
  const envRollback = {
    ...envCompleto, ALLOW_LEGACY_ADMIN_PASSWORD: '1', ADMIN_PASSWORD: s.senhaAdmin, ALLOW_LEGACY_INTEGRATION_ENV: '1',
  };
  const soSul = await e.executar('rollback', ['--scenario', 'A', '--mapping', arquivo], { ...envRollback, LEGACY_ADMIN_USER_EMAIL: 'dono.sul@ensaio.oria' });
  assert.equal(soSul.codigo, 1);
  assert.ok(soSul.linhas.some((l) => l.startsWith('FAIL rollback.login-emergencia') && l.includes(A.centro) && l.includes(A.norte)), soSul.linhas.join('\n'));

  // 2. Com as alavancas: simulação primeiro (sem escrita), depois --aplicar (só auditoria).
  envRollback.LEGACY_ADMIN_USER_EMAIL = 'operacao@ensaio.oria';
  const snapshot = path.join(dir, 'impressao.json');
  const simulacao = await e.executar('rollback', ['--scenario', 'A', '--mapping', arquivo, '--snapshot', snapshot], envRollback);
  assertSoPassOuInfo(simulacao, 'rollback simulado');
  assert.ok(simulacao.linhas.some((l) => l.startsWith('simulação: nada foi escrito')));
  assert.deepEqual(await contagemAudit(sup, 'tenant1.rollback'), {});
  assert.equal(JSON.parse(fs.readFileSync(snapshot, 'utf8')).antes.resumo, antes.resumo);

  const aplicado = await e.executar('rollback', ['--scenario', 'A', '--mapping', arquivo, '--aplicar'], envRollback);
  assertSoPassOuInfo(aplicado, 'rollback aplicado');
  assert.deepEqual(statusDe(aplicado, 'rollback.dados'), ['PASS']);
  for (const v of e.valoresProibidos(s, envRollback)) assert.ok(!aplicado.linhas.join('\n').includes(v), 'segredo na saída do rollback');
  assert.deepEqual(compararImpressoes(antes, await impressaoDigital(db.url)), [], 'nenhuma linha removida ou reassociada');
  assert.deepEqual(await contagemAudit(sup, 'tenant1.rollback'), { [A.sul]: 1, [A.centro]: 1, [A.norte]: 1 });
  assert.deepEqual(await contagemAudit(sup, 'tenant1.apply'), auditAntes);
  const { rows: sujeitos } = await sup.query(`SELECT DISTINCT a.actor_user_id FROM audit_log a WHERE a.action = 'tenant1.rollback'`);
  const { rows: [dono] } = await sup.query(`SELECT id FROM users WHERE email = 'dono.sul@ensaio.oria'`);
  assert.ok(sujeitos.every((x) => /^[0-9a-f-]{36}$/.test(x.actor_user_id)));
  assert.ok(sujeitos.some((x) => x.actor_user_id === dono.id), 'sujeito = primeiro owner declarado da Organization');

  // 3a. Alavanca de login: o login legado entra como a pessoa declarada e enxerga as três.
  const login = await loginDeEmergencia(t, appPool, {
    ALLOW_LEGACY_ADMIN_PASSWORD: '1', ADMIN_PASSWORD: s.senhaAdmin, LEGACY_ADMIN_USER_EMAIL: 'operacao@ensaio.oria',
  });
  assert.equal(login.status, 200);
  assert.equal(login.sessao.metodo, 'legado');
  assert.deepEqual(login.sessao.memberships.map((m) => [m.organizationId, m.papel]).sort(),
    Object.values(A).sort().map((id) => [id, 'owner']));

  // 3b. Alavanca da Ink: com a flag, Centro lê a credencial do ambiente da SUA loja; sem a flag,
  // falha fechada. Sul continua lendo a integração importada (dado novo preservado e preferido).
  const semFlag = resolverDaApp(appPool, s.mestra, { INK_TOKEN_CENTRO: s.ink.centro.token });
  const comFlag = resolverDaApp(appPool, s.mestra, envRollback);
  const ler = (res, org, loja) => runtime.comContexto({ organizationId: org, loja }, () => res.usarSegredo('ink', 'api_token', (v) => v));
  await assert.rejects(ler(semFlag, A.centro, 'centro'), (err) => err.codigo === 'INTEGRATION_NOT_CONNECTED');
  assert.equal(await ler(comFlag, A.centro, 'centro'), s.ink.centro.token);
  assert.equal(await ler(comFlag, A.sul, 'sul'), s.ink.sul.token);
  assert.equal(await ler(resolverDaApp(appPool, s.mestra, { ...envRollback, INK_TOKEN_SUL: 'outro-valor-qualquer-000' }), A.sul, 'sul'), s.ink.sul.token);
  // A loja vem da Store do contexto: Norte não lê o token de Centro nem com a flag.
  assert.equal(await ler(comFlag, A.norte, 'norte'), s.ink.norte.token);
  await assert.rejects(ler(resolverDaApp(appPool, s.mestra, { ALLOW_LEGACY_INTEGRATION_ENV: '1', INK_TOKEN_CENTRO: s.ink.centro.token }), A.norte, 'norte'),
    (err) => err.codigo === 'INTEGRATION_NOT_CONNECTED');

  // 4. Roll-forward: o apply de novo não muda nada e o verify segue verde.
  const denovo = await e.executar('apply', base, envApply);
  assertSoPassOuInfo(denovo, 'roll-forward');
  assert.ok(denovo.linhas.some((l) => l.includes('apply.audit — nada mudou')));
  assert.deepEqual(compararImpressoes(antes, await impressaoDigital(db.url)), []);
  assertSoPassOuInfo(await e.executar('verify', base, envApply), 'verify depois do rollback');

  // Controle negativo da impressão digital: uma linha trocada de Organization é acusada.
  const { rows: [seg] } = await sup.query(
    `INSERT INTO segments (organization_id, nome) VALUES ($1, 'controle do rollback') RETURNING id`, [A.centro]
  );
  const base2 = await impressaoDigital(db.url);
  await sup.query('UPDATE segments SET organization_id = $1 WHERE id = $2', [A.norte, seg.id]);
  const dif = compararImpressoes(base2, await impressaoDigital(db.url));
  assert.ok(dif.some((d) => d.startsWith('segments: 1 → 1 linha(s) (dono ou chave mudou)')), dif.join('; '));
  await sup.query('DELETE FROM segments WHERE id = $1', [seg.id]);
  assert.ok(compararImpressoes(base2, await impressaoDigital(db.url)).some((d) => d.startsWith('segments: 1 → 0')), 'remoção também é acusada');
});

test('rollback Fase 6 · cenário B (base legada): a release anterior ainda lê as colunas antigas; limpas → FAIL', { timeout: 300000 }, async (t) => {
  const s = e.segredosDoEnsaio();
  const { db, sup } = await e.montarBase(t, 'B', s);
  const role = e.roleDoEnsaio(t, 'oria_t1rbb');
  await role.provisionar(sup, db.url);
  const uploads = e.uploadsLegados(t);
  const saida = path.join(e.diretorioTemporario(t, 'oria-t1-seg-'), 'urls');
  const env = await e.ambiente('B', s, { url: db.url });
  const base = ['--scenario', 'B', '--mapping', e.ARQUIVO.B, '--uploads', uploads, '--app-role', role.role];
  assertSoPassOuInfo(await e.executar('apply', [...base, '--saida-segredos', saida], env), 'apply B');

  const envRollback = {
    ...env, ALLOW_LEGACY_ADMIN_PASSWORD: '1', ADMIN_PASSWORD: s.senhaAdmin, LEGACY_ADMIN_USER_EMAIL: 'operacao@ensaio.oria', ALLOW_LEGACY_INTEGRATION_ENV: '1',
  };
  const ok = await e.executar('rollback', ['--scenario', 'B', '--mapping', e.ARQUIVO.B, '--aplicar'], envRollback);
  assertSoPassOuInfo(ok, 'rollback B');
  // meta (instalação), GA4 da loja da Store e OpenAI: três credenciais que a release anterior lê.
  assert.ok(ok.linhas.some((l) => l.startsWith('PASS rollback.colunas-legadas — 3 credencial(is)')), ok.linhas.join('\n'));
  assert.deepEqual(statusDe(ok, 'rollback.whatsapp'), ['PASS']);
  assert.deepEqual(statusDe(ok, 'rollback.dados'), ['PASS']);
  assertSoPassOuInfo(await e.executar('verify', base, env), 'verify B depois do rollback');

  // Chave de sessão trocada: a release anterior não leria as colunas → FAIL.
  const chaveTrocada = await e.executar('rollback', ['--scenario', 'B', '--mapping', e.ARQUIVO.B], { ...envRollback, ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url') });
  assert.equal(chaveTrocada.codigo, 1);
  assert.ok(chaveTrocada.linhas.some((l) => l.startsWith('FAIL rollback.colunas-legadas — ilegíveis')), chaveTrocada.linhas.join('\n'));

  // Go sem o remetente legado (Release D já executada) → FAIL.
  const semZap = { ...envRollback };
  delete semZap.WHATSAPP_LEGACY_ACCESS_TOKEN;
  assert.deepEqual(statusDe(await e.executar('rollback', ['--scenario', 'B', '--mapping', e.ARQUIVO.B], semZap), 'rollback.whatsapp'), ['FAIL']);

  // Release N+1 (limpeza das colunas antigas) fecha a janela: o rollback de release deixa de existir.
  const { importarLegado } = await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'integrations', 'import-legacy.mjs')));
  await importarLegado(db.url, { env, aplicar: true, limparColunas: true });
  const limpo = await e.executar('rollback', ['--scenario', 'B', '--mapping', e.ARQUIVO.B, '--aplicar'], envRollback);
  assert.equal(limpo.codigo, 1);
  assert.ok(limpo.linhas.some((l) => l.startsWith('FAIL rollback.colunas-legadas — colunas antigas já limpas')), limpo.linhas.join('\n'));
  assert.deepEqual(await contagemAudit(sup, 'tenant1.rollback'), { [B]: 1 }, 'rollback reprovado não audita');
});
