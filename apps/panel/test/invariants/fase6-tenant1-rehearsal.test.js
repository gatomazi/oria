'use strict';

// Fase 6 · ensaio completo do Tenant #1 em DOIS bancos descartáveis independentes.
//
//   A  três lojas independentes → 3 Organizations / 3 Stores / 3 cadeias de ownership
//   B  operação consolidada     → 1 Organization / 1 Store; Sul, Centro e Norte convergem por
//                                 mapeamento explícito
//
// Em cada um: preflight → plan → apply → verify pela CLI real, depois re-execução (idempotência) e
// controles negativos de dado (o verify precisa reprovar quando o estado é violado).
// PD-019 não é decidido aqui: o mesmo código roda os dois cenários, e o cenário é sempre declarado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const h = require('./harness');
const e = require('../helpers/tenant1-ensaio');
const runtime = require('../../lib/platform/tenant-runtime.js');
const { createIntegrationResolver } = require('../../lib/platform/integrations.js');
const { createSecretStore } = require('../../lib/secrets/store.js');
const { createKeyring } = require('../../lib/secrets/keyring.js');

const A = {
  sul: 'a1000000-0000-4000-8000-000000000001',
  centro: 'a1000000-0000-4000-8000-000000000002',
  norte: 'a1000000-0000-4000-8000-000000000003',
};
const B = 'b1000000-0000-4000-8000-000000000001';
const silencioso = { log() {}, warn() {}, error() {} };

const args = (cenario, uploads, extra = []) => ['--scenario', cenario, '--mapping', e.ARQUIVO[cenario], '--uploads', uploads, ...extra];

function semSegredo(linhas, proibidos, contexto) {
  const texto = linhas.join('\n');
  for (const v of proibidos) assert.ok(!texto.includes(v), `${contexto}: um valor sensível apareceu na saída`);
  assert.ok(!/\/api\/webhooks\/ink\/[A-Za-z0-9_-]{43}/.test(texto), `${contexto}: URL opaca da Ink na saída`);
}

function statusDe(r, id) {
  return e.itensDe(r.linhas).filter((i) => i.id === id).map((i) => i.status);
}

function assertSoPassOuInfo(r, contexto) {
  const ruins = e.itensDe(r.linhas).filter((i) => i.status !== 'PASS' && i.status !== 'INFO');
  assert.deepEqual(ruins, [], `${contexto}:\n${r.linhas.join('\n')}`);
  assert.equal(r.codigo, 0, `${contexto}:\n${r.linhas.join('\n')}`);
}

async function lerCom(poolApp, s, org, loja, provider, tipo) {
  const fachada = runtime.criarPoolTenant(poolApp);
  const resolver = createIntegrationResolver({
    pool: fachada, segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: s.mestra }) }), env: {}, logger: silencioso,
  });
  return runtime.comContexto({ organizationId: org, loja }, () => resolver.usarSegredo(provider, tipo, (v) => v));
}

// Pipeline comum: devolve o que os testes específicos precisam conferir.
async function ensaiar(t, cenario) {
  const s = e.segredosDoEnsaio();
  const { db, sup } = await e.montarBase(t, cenario, s);
  const role = e.roleDoEnsaio(t, `oria_t1${cenario.toLowerCase()}`);
  await role.provisionar(sup, db.url);
  const uploads = e.uploadsLegados(t);
  const saidaSegredos = path.join(e.diretorioTemporario(t, 'oria-t1-seg-'), 'urls');
  const env = await e.ambiente(cenario, s, { url: db.url });
  const proibidos = e.valoresProibidos(s, env);
  const { impressaoDigital, compararImpressoes } = await e.modulo('checks.mjs');
  const base = args(cenario, uploads, ['--app-role', role.role]);

  // preflight e plan: somente leitura, sem FAIL, com o que falta como PEND.
  const antes = await impressaoDigital(db.url);
  const pre = await e.executar('preflight', base, env);
  assert.equal(pre.codigo, 0, pre.linhas.join('\n'));
  semSegredo(pre.linhas, proibidos, `preflight ${cenario}`);
  assert.deepEqual(statusDe(pre, 'integrations.legado'), ['PEND']);
  assert.deepEqual(statusDe(pre, 'secrets.chave'), ['PASS']);
  assert.ok(e.itensDe(pre.linhas).some((i) => i.id.startsWith('auth.owner[') && i.status === 'PEND'));

  const plano = await e.executar('plan', base, env);
  assert.equal(plano.codigo, 0, plano.linhas.join('\n'));
  semSegredo(plano.linhas, proibidos, `plan ${cenario}`);
  assert.ok(plano.linhas.includes('  ações destrutivas: nenhuma'));
  assert.ok(plano.linhas.some((l) => l.startsWith(`PLANO cenário ${cenario}`)));
  assert.ok(plano.linhas.some((l) => l.includes('- integrations.legado: importar')));
  assert.deepEqual(compararImpressoes(antes, await impressaoDigital(db.url)), [], 'preflight/plan não escrevem');
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  assert.ok(fs.existsSync(path.join(uploads, 'creatives', 'tenant', 'default')), 'plan não move arquivos');

  // apply
  const ap = await e.executar('apply', [...base, '--saida-segredos', saidaSegredos], env);
  semSegredo(ap.linhas, proibidos, `apply ${cenario}`);
  assertSoPassOuInfo(ap, `apply ${cenario}`);
  const urls = fs.readdirSync(saidaSegredos);
  for (const f of urls) {
    assert.equal(fs.statSync(path.join(saidaSegredos, f)).mode & 0o777, 0o600, 'URL opaca gravada só para o dono do arquivo');
  }

  // verify
  const ver = await e.executar('verify', base, env);
  semSegredo(ver.linhas, proibidos, `verify ${cenario}`);
  assertSoPassOuInfo(ver, `verify ${cenario}`);
  assert.deepEqual(statusDe(ver, 'bypass.codigo'), ['PASS']);

  // re-execução: nada muda, nada é auditado de novo, nenhuma URL nova.
  const depois = await impressaoDigital(db.url);
  const ap2 = await e.executar('apply', [...base, '--saida-segredos', saidaSegredos], env);
  assertSoPassOuInfo(ap2, `apply repetido ${cenario}`);
  assert.ok(ap2.linhas.some((l) => l.includes('apply.audit — nada mudou')), ap2.linhas.join('\n'));
  assert.deepEqual(compararImpressoes(depois, await impressaoDigital(db.url)), []);
  assert.deepEqual(await impressaoDigital(db.url).then((x) => x.audit), depois.audit, 'sem auditoria nova');
  assert.deepEqual(fs.readdirSync(saidaSegredos), urls);

  const appPool = h.abrirPoolDescartavel(h.urlComUsuario(db.url, role.role, role.senha), { max: 2 });
  t.after(() => appPool.end());
  return { s, db, sup, env, uploads, saidaSegredos, base, appPool, ver, role };
}

async function assertUrlInk(sup, saidaSegredos, org) {
  const caminho = fs.readFileSync(path.join(saidaSegredos, `ink-webhook-${org}.url`), 'utf8').trim();
  const token = caminho.split('/').pop();
  const hash = require('node:crypto').createHash('sha256').update(token).digest('hex');
  const { rows } = await sup.query('SELECT ink_organization_do_webhook($1) AS org', [hash]);
  assert.equal(rows[0].org, org, 'a URL opaca resolve para a própria Organization');
}

test('Fase 6 · cenário A: 3 Organizations, 3 Stores, 3 cadeias de ownership — preflight → plan → apply → verify', { timeout: 300000 }, async (t) => {
  const r = await ensaiar(t, 'A');
  const { sup, s, appPool } = r;

  const { rows: orgs } = await sup.query('SELECT o.id, s.loja_legada FROM organizations o JOIN stores s ON s.organization_id = o.id AND s.ativa ORDER BY o.id');
  assert.deepEqual(orgs.map((o) => [o.id, o.loja_legada]), [[A.sul, 'sul'], [A.centro, 'centro'], [A.norte, 'norte']]);

  // Três cadeias: cada owner só na própria Organization.
  const { rows: donos } = await sup.query(
    `SELECT u.email, array_agg(m.organization_id::text ORDER BY m.organization_id) AS orgs
       FROM users u JOIN organization_members m ON m.user_id = u.id AND m.papel = 'owner' GROUP BY u.email ORDER BY u.email`
  );
  assert.deepEqual(donos.map((d) => [d.email, d.orgs]), [
    ['dono.centro@ensaio.oria', [A.centro]], ['dono.norte@ensaio.oria', [A.norte]], ['dono.sul@ensaio.oria', [A.sul]],
  ]);

  const { rows: planos } = await sup.query(`SELECT organization_id, valor FROM app_config WHERE chave = 'entitlements' ORDER BY 1`);
  assert.deepEqual(planos.map((p) => [p.organization_id, Object.keys(p.valor).sort()]), [
    [A.sul, ['creative_generator', 'financial', 'whatsapp']], [A.centro, ['financial']],
  ], 'Norte declarou nenhuma feature: nada é ligado por omissão');

  // Credenciais: cada Organization lê a da própria loja, sob a role da aplicação.
  for (const [loja, org] of Object.entries(A)) {
    assert.equal(await lerCom(appPool, s, org, loja, 'ink', 'api_token'), s.ink[loja].token);
    assert.equal(await lerCom(appPool, s, org, loja, 'ga4', 'refresh_token'), s.ga4[loja]);
    await assertUrlInk(sup, r.saidaSegredos, org);
  }
  // Estado da instalação (meta:*, creative_tenant:default) foi para o dono DECLARADO (Sul), não "o único".
  assert.equal(await lerCom(appPool, s, A.sul, 'sul', 'meta', 'access_token'), s.meta);
  assert.equal(await lerCom(appPool, s, A.sul, 'sul', 'openai', 'api_key'), s.openai);
  await assert.rejects(lerCom(appPool, s, A.centro, 'centro', 'meta', 'access_token'), (err) => err.codigo === 'INTEGRATION_NOT_CONNECTED');
  assert.ok(fs.existsSync(path.join(r.uploads, 'creatives', 'tenant', A.sul, 'assets', 'arte.png')));
  assert.ok(!fs.existsSync(path.join(r.uploads, 'creatives', 'tenant', 'default')));

  // WhatsApp: só Sul, posse de WABA e número, e o resolvedor de entrada concorda.
  const { rows: zap } = await sup.query(`SELECT * FROM whatsapp_organization_do_remetente('1200000000001', '5511900000001')`);
  assert.deepEqual(zap.map((z) => [z.organization_id, z.motivo]), [[A.sul, 'ok']]);
  const { rows: claims } = await sup.query(`SELECT organization_id, tipo FROM external_resource_claims WHERE provider = 'whatsapp' ORDER BY tipo`);
  assert.deepEqual(claims.map((c) => [c.organization_id, c.tipo]), [[A.sul, 'phone_number'], [A.sul, 'waba']]);

  // Colunas antigas intactas (janela de rollback) e auditoria atribuível.
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM meta_connections WHERE access_token_encrypted IS NOT NULL')).rows[0].n, 1);
  const { rows: aud } = await sup.query(`SELECT organization_id, count(*)::int AS n FROM audit_log WHERE action = 'tenant1.apply' GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(aud.map((a) => [a.organization_id, a.n]), [[A.sul, 1], [A.centro, 1], [A.norte, 1]]);

  // ── controles negativos de dado: o verify reprova, e o apply (roll-forward) conserta ────────
  await t.test('controle negativo · owner removido de uma Organization → verify FAIL', async () => {
    await sup.query(`DELETE FROM organization_members WHERE organization_id = $1`, [A.norte]);
    const ruim = await e.executar('verify', r.base, r.env);
    assert.equal(ruim.codigo, 1);
    assert.deepEqual(statusDe(ruim, `auth.organization-com-owner[${A.norte}]`), ['FAIL']);
    assert.deepEqual(statusDe(ruim, 'auth.owner[dono.norte@ensaio.oria]'), ['FAIL']);
    const conserto = await e.executar('apply', r.base, r.env);
    assertSoPassOuInfo(conserto, 'roll-forward do owner');
    assertSoPassOuInfo(await e.executar('verify', r.base, r.env), 'verify depois do conserto');
  });

  await t.test('controle negativo · posse do número movida para outra Organization → verify FAIL', async () => {
    await sup.query(`UPDATE external_resource_claims SET organization_id = $1 WHERE provider = 'whatsapp' AND tipo = 'phone_number'`, [A.norte]);
    const ruim = await e.executar('verify', r.base, r.env);
    assert.equal(ruim.codigo, 1);
    assert.deepEqual(statusDe(ruim, 'whatsapp.posse'), ['FAIL']);
    await sup.query(`UPDATE external_resource_claims SET organization_id = $1 WHERE provider = 'whatsapp' AND tipo = 'phone_number'`, [A.sul]);
    assertSoPassOuInfo(await e.executar('verify', r.base, r.env), 'verify depois de restaurar a posse');
  });

  await t.test('controle negativo · linha de uma loja reassociada a outra Organization → verify FAIL', async () => {
    const { rows: [linha] } = await sup.query(`SELECT id, store_id FROM despesas_operacionais WHERE loja = 'centro' ORDER BY id LIMIT 1`);
    await sup.query('ALTER TABLE despesas_operacionais DISABLE TRIGGER USER');
    try {
      // Desde a 0025 a linha carrega `store_id` (FK composta com a Organization): reassociar só o
      // `organization_id` já é recusado pelo banco. O defeito que o verify precisa flagrar é o do
      // dado ANTIGO — só `loja`, sem Store — apontando para a Organization errada; por isso a linha
      // simulada volta a ser desse tipo, e a restauração devolve o `store_id` que ela tinha.
      await sup.query('UPDATE despesas_operacionais SET organization_id = $1, store_id = NULL WHERE id = $2', [A.sul, linha.id]);
      const ruim = await e.executar('verify', r.base, r.env);
      assert.equal(ruim.codigo, 1);
      assert.deepEqual(statusDe(ruim, 'tenancy.dono-da-loja'), ['FAIL']);
      await sup.query('UPDATE despesas_operacionais SET organization_id = $1, store_id = $3 WHERE id = $2', [A.centro, linha.id, linha.store_id]);
    } finally {
      await sup.query('ALTER TABLE despesas_operacionais ENABLE TRIGGER USER');
    }
    assertSoPassOuInfo(await e.executar('verify', r.base, r.env), 'verify depois de restaurar a linha');
  });

  await t.test('controle negativo · entitlement declarado desligado → verify FAIL', async () => {
    await sup.query(`UPDATE app_config SET valor = valor - 'financial' WHERE chave = 'entitlements' AND organization_id = $1`, [A.centro]);
    const ruim = await e.executar('verify', r.base, r.env);
    assert.deepEqual(statusDe(ruim, `entitlements[${A.centro}]`), ['FAIL']);
    assertSoPassOuInfo(await e.executar('apply', r.base, r.env), 'roll-forward do entitlement');
  });
});

test('Fase 6 · cenário B: 1 Organization, 1 Store, Sul/Centro/Norte convergindo explicitamente', { timeout: 300000 }, async (t) => {
  const r = await ensaiar(t, 'B');
  const { sup, s, appPool } = r;

  const { rows: orgs } = await sup.query('SELECT o.id, s.loja_legada FROM organizations o JOIN stores s ON s.organization_id = o.id');
  assert.deepEqual(orgs.map((o) => [o.id, o.loja_legada]), [[B, 'sul']]);
  const { rows: mapa } = await sup.query(`SELECT chave, organization_id FROM tenancy_mapeamentos WHERE tipo = 'loja' ORDER BY chave`);
  assert.deepEqual(mapa.map((m) => [m.chave, m.organization_id]), [['centro', B], ['norte', B], ['sul', B]]);

  // Todo o histórico das três lojas é da Organization B — por declaração, não por "é a única".
  const { rows: porLoja } = await sup.query(
    `SELECT loja, array_agg(DISTINCT organization_id::text) AS orgs FROM despesas_operacionais GROUP BY loja ORDER BY loja`
  );
  assert.deepEqual(porLoja.map((x) => [x.loja, x.orgs]), [['centro', [B]], ['norte', [B]], ['sul', [B]]]);

  // O que a aplicação ainda não mostra fica visível para o operador (decisão de PD-019, não daqui).
  assert.deepEqual(statusDe(r.ver, 'tenancy.loja-fora-da-store'), ['INFO']);

  // Só a credencial da loja da Store (Sul) é importada; as de Centro/Norte não viram da B por tabela.
  assert.equal(await lerCom(appPool, s, B, 'sul', 'ink', 'api_token'), s.ink.sul.token);
  assert.equal(await lerCom(appPool, s, B, 'sul', 'ga4', 'refresh_token'), s.ga4.sul);
  assert.equal(await lerCom(appPool, s, B, 'sul', 'meta', 'access_token'), s.meta);
  const { rows: inks } = await sup.query(`SELECT count(*)::int AS n FROM integrations WHERE provider = 'ink'`);
  assert.equal(inks[0].n, 1);
  await assertUrlInk(sup, r.saidaSegredos, B);

  const { rows: donos } = await sup.query(`SELECT u.email, m.organization_id FROM users u JOIN organization_members m ON m.user_id = u.id`);
  assert.deepEqual(donos.map((d) => [d.email, d.organization_id]), [['operacao@ensaio.oria', B]]);
  const { rows: zap } = await sup.query(`SELECT * FROM whatsapp_organization_do_remetente('1200000000009', '5511900000009')`);
  assert.deepEqual(zap.map((z) => [z.organization_id, z.motivo]), [[B, 'ok']]);
  assert.ok(fs.existsSync(path.join(r.uploads, 'creatives', 'tenant', B, 'assets', 'arte.png')));

  await t.test('falha · Organization sem Store no banco → apply aborta sem escrever', async () => {
    const { impressaoDigital, compararImpressoes } = await e.modulo('checks.mjs');
    const extra = '0c000000-0000-4000-8000-00000000000c';
    await sup.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'Sem store')`, [extra]);
    try {
      const antes = await impressaoDigital(r.db.url);
      const ruim = await e.executar('apply', r.base, r.env);
      assert.equal(ruim.codigo, 1);
      assert.deepEqual(statusDe(ruim, 'tenancy.organizations-extras'), ['FAIL']);
      assert.deepEqual(statusDe(ruim, 'tenancy.gates'), ['FAIL']);
      assert.ok(ruim.linhas.includes('apply abortado pelo preflight: nada foi escrito'));
      assert.deepEqual(compararImpressoes(antes, await impressaoDigital(r.db.url)), []);
    } finally {
      await sup.query('DELETE FROM organizations WHERE id = $1', [extra]);
    }
    assertSoPassOuInfo(await e.executar('verify', r.base, r.env), 'verify depois de remover a Organization extra');
  });

  await t.test('falha · banco de B com o arquivo de A → FAIL, nada escrito', async () => {
    const { impressaoDigital, compararImpressoes } = await e.modulo('checks.mjs');
    const antes = await impressaoDigital(r.db.url);
    const ruim = await e.executar('apply', args('A', r.uploads, ['--app-role', r.role.role]), { ...r.env, TENANT1_OWNER_SUL_HASH: r.env.TENANT1_OWNER_HASH });
    assert.equal(ruim.codigo, 1);
    assert.deepEqual(statusDe(ruim, 'tenancy.mapeamento'), ['FAIL']);
    assert.deepEqual(compararImpressoes(antes, await impressaoDigital(r.db.url)), []);
  });
});

test('Fase 6 · falhas antes de tocar o banco: sem cenário, cenário trocado, mapeamento ambíguo, org sem store, chave ausente', { timeout: 120000 }, async (t) => {
  const dir = e.diretorioTemporario(t, 'oria-t1-arq-');
  const env = { DATABASE_URL: 'postgres://ninguem:x@127.0.0.1:1/nada' };
  const gravar = (nome, conteudo) => {
    const p = path.join(dir, nome);
    fs.writeFileSync(p, JSON.stringify(conteudo));
    return p;
  };
  const fixture = JSON.parse(fs.readFileSync(e.ARQUIVO.A, 'utf8'));
  const mapa = JSON.parse(fs.readFileSync(e.MAPEAMENTO.A, 'utf8'));

  for (const comando of ['preflight', 'plan', 'apply', 'verify', 'rollback']) {
    const semCenario = await e.executar(comando, ['--mapping', e.ARQUIVO.A], env);
    assert.equal(semCenario.codigo, 1);
    assert.ok(semCenario.linhas.some((l) => l.includes('--scenario A|B não informado')), comando);
    const semArquivo = await e.executar(comando, ['--scenario', 'A'], env);
    assert.equal(semArquivo.codigo, 1);
    assert.ok(semArquivo.linhas.some((l) => l.includes('--mapping <arquivo> não informado')), comando);
  }

  const trocado = await e.executar('plan', ['--scenario', 'B', '--mapping', e.ARQUIVO.A], env);
  assert.ok(trocado.linhas.some((l) => l.includes('--scenario B não confere')));

  // B declarado com o mapeamento de A: a forma não é de B — FAIL, sem "parece A".
  const bComMapaA = gravar('b-com-a.json', { ...fixture, cenario: 'B', mapeamentoTenancy: e.MAPEAMENTO.A });
  const r1 = await e.executar('plan', ['--scenario', 'B', '--mapping', bComMapaA], env);
  assert.ok(r1.linhas.some((l) => l.includes('cenário B exige 1 Organization')), r1.linhas.join('\n'));

  // A declarado com duas lojas na mesma Organization.
  const mapaTorto = { ...mapa, mapeamentos: mapa.mapeamentos.map((m) => (m.chave === 'norte' ? { ...m, organizationId: A.centro } : m)) };
  const r2 = await e.executar('plan', ['--scenario', 'A', '--mapping', gravar('a-torto.json', { ...fixture, mapeamentoTenancy: gravar('mapa-torto.json', mapaTorto) })], env);
  assert.equal(r2.codigo, 1);
  assert.ok(r2.linhas.some((l) => /lojaLegada "norte" é da org|cada loja legada precisa de uma Organization própria/.test(l)), r2.linhas.join('\n'));

  // Mapeamento ambíguo: a mesma loja declarada duas vezes.
  const ambiguo = { ...mapa, mapeamentos: [...mapa.mapeamentos, { tipo: 'loja', chave: 'sul', organizationId: A.norte }] };
  const r3 = await e.executar('apply', ['--scenario', 'A', '--mapping', gravar('a-ambiguo.json', { ...fixture, mapeamentoTenancy: gravar('mapa-ambiguo.json', ambiguo) })], env);
  assert.equal(r3.codigo, 1);
  assert.ok(r3.linhas.some((l) => l.includes('mapeado mais de uma vez')), r3.linhas.join('\n'));

  // Organization sem Store.
  const semStore = { ...mapa, organizations: mapa.organizations.map((o, i) => (i === 2 ? { id: o.id, nome: o.nome } : o)) };
  const r4 = await e.executar('apply', ['--scenario', 'A', '--mapping', gravar('a-sem-store.json', { ...fixture, mapeamentoTenancy: gravar('mapa-sem-store.json', semStore) })], env);
  assert.equal(r4.codigo, 1);
  assert.ok(r4.linhas.some((l) => l.includes('store ausente (V1 é 1:1)')), r4.linhas.join('\n'));

  // WhatsApp/Ink: a chave é obrigatória (null = "não se aplica", declarado).
  const { whatsapp, ...semZap } = fixture;
  void whatsapp;
  const r5 = await e.executar('plan', ['--scenario', 'A', '--mapping', gravar('a-sem-zap.json', { ...semZap, mapeamentoTenancy: e.MAPEAMENTO.A })], env);
  assert.ok(r5.linhas.some((l) => l.includes('campos obrigatórios ausentes') && l.includes('whatsapp')), r5.linhas.join('\n'));

  // Organization sem owner declarado.
  const r6 = await e.executar('plan', ['--scenario', 'A', '--mapping', gravar('a-sem-owner.json', { ...fixture, mapeamentoTenancy: e.MAPEAMENTO.A, owners: fixture.owners.slice(0, 2) })], env);
  assert.ok(r6.linhas.some((l) => l.includes(`Organization ${A.norte} sem owner declarado`)), r6.linhas.join('\n'));

  // apply/rollback só em banco local.
  const remoto = await e.executar('apply', ['--scenario', 'A', '--mapping', e.ARQUIVO.A, '--uploads', dir], { DATABASE_URL: 'postgres://u:p@db.railway.internal:5432/x' });
  assert.equal(remoto.codigo, 1);
  assert.ok(remoto.linhas.some((l) => l.includes('não é local')), remoto.linhas.join('\n'));
  const railway = await e.executar('rollback', ['--scenario', 'A', '--mapping', e.ARQUIVO.A], { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x', RAILWAY_ENVIRONMENT_NAME: 'production' });
  assert.ok(railway.linhas.some((l) => l.includes('Railway')), railway.linhas.join('\n'));
});

test('Fase 6 · preflight sem hash do owner → FAIL; a CLI real sai com código ≠ 0 e sem segredo', { timeout: 300000 }, async (t) => {
  const s = e.segredosDoEnsaio();
  const { db } = await e.montarBase(t, 'B', s);
  const uploads = e.uploadsLegados(t);
  const env = await e.ambiente('B', s, { url: db.url });
  delete env.TENANT1_OWNER_HASH;
  const r = spawnSync(process.execPath, [path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'cli.mjs'), 'preflight', ...args('B', uploads)], {
    cwd: h.RAIZ_REPO, encoding: 'utf8', env, timeout: 120000,
  });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^FAIL auth\.owner\[operacao@ensaio\.oria\] — TENANT1_OWNER_HASH ausente/m);
  assert.match(r.stdout, /^(PASS|FAIL) role\.app/m);
  assert.match(r.stdout, /RESULTADO preflight: FAIL\s*$/);
  for (const v of e.valoresProibidos(s, { ...env, TENANT1_OWNER_HASH: '' })) assert.ok(!r.stdout.includes(v), 'segredo no stdout');
  // apply com o mesmo ambiente aborta sem escrever.
  const ap = await e.executar('apply', args('B', uploads), env);
  assert.equal(ap.codigo, 1);
  assert.ok(ap.linhas.includes('apply abortado pelo preflight: nada foi escrito'));
  const sup = h.abrirPoolDescartavel(db.url, { max: 1 });
  t.after(() => sup.end());
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM integration_secrets')).rows[0].n, 0);
});
