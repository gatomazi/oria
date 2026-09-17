'use strict';

// Rodada 19 · revisão: a RELEASE B do runbook publica o commit ANTIGO 31a7cdb, e o pre-deploy roda os
// scripts DAQUELE commit — seed só com ENTITLEMENTS_SEED_FEATURES (sem perfil nem checagem de
// implementação) e import do WhatsApp sem par declarado nem posse da WABA.
//
// Contrato provado aqui, com o código REAL de 31a7cdb (extraído do git) contra um banco descartável:
//   1. `tenant1:preflight --estagio antes-da-b` (HEAD, sem banco) confere que o ambiente que a B vai
//      ler é o do arquivo de rollout e imprime os valores esperados;
//   2. o pre-deploy da B (scripts de 31a7cdb) roda com esses valores;
//   3. `tenant1:verify --estagio release-b` (HEAD, somente leitura) cobre o que a B não confere:
//      plano == perfil, par WhatsApp declarado na Organization declarada;
//   4. controles de dado: o seed da B aceita `instagram` e o verify reprova; par trocado reprova;
//   5. D' (HEAD): migrations restantes, seed por perfil com a lista antiga igual → nada muda;
//      verify do HEAD passa e a posse da WABA (backfill da D0) está na mesma Organization.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const e = require('../helpers/tenant1-ensaio');

const B = 'b1000000-0000-4000-8000-000000000001';
const COMMIT_B = '31a7cdb';
const LEGADO = h.exigirRepoLegado(COMMIT_B);
const TEMPLATES = path.join(h.RAIZ_REPO, 'config', 'tenant1');
const PERFIL = path.join(h.RAIZ_REPO, 'config', 'entitlements', 'tenant1-entitlements.json');
const VALORES = Object.freeze({
  '<ORGANIZATION_ID_USE_ORIGENS>': B,
  '<STORE_ID_USE_ORIGENS>': 'b2000000-0000-4000-8000-000000000001',
  '<CREATIVE_TENANT_ID_ATUAL>': 'default',
  '<EMAIL_DO_OWNER_USE_ORIGENS>': 'operacao@ensaio.oria',
  '<WABA_ID_ATUAL>': '1200000000009',
  '<PHONE_NUMBER_ID_ATUAL>': '5511900000009',
});

const statusDe = (r, id) => e.itensDe(r.linhas).filter((i) => i.id === id).map((i) => i.status);
const soPassOuInfo = (r) => e.itensDe(r.linhas).filter((i) => i.status !== 'PASS' && i.status !== 'INFO');

function git(args) {
  const r = spawnSync('git', ['-C', LEGADO, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// Código de 31a7cdb num diretório próprio (realpath: os scripts só rodam o main quando
// import.meta.url === file://argv[1]).
function extrairReleaseB(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-r19h-relb-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tar = path.join(dir, 'b.tar');
  git(['archive', '--format=tar', '-o', tar, COMMIT_B, 'scripts', 'lib', 'package.json']);
  const r = spawnSync('tar', ['-xf', tar, '-C', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  fs.symlinkSync(path.join(h.RAIZ_REPO, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

function rodarB(dirB, script, args, env) {
  const r = spawnSync(process.execPath, [path.join(dirB, script), ...args], { cwd: dirB, encoding: 'utf8', env, timeout: 120000 });
  return { status: r.status, saida: `${r.stdout || ''}${r.stderr || ''}` };
}

function montarConfig(raiz, mudar = (x) => x, nome = 'rollout-scenario-b.json') {
  const dirT1 = path.join(raiz, 'config', 'tenant1');
  const dirEnt = path.join(raiz, 'config', 'entitlements');
  fs.mkdirSync(dirT1, { recursive: true });
  fs.mkdirSync(dirEnt, { recursive: true });
  fs.copyFileSync(PERFIL, path.join(dirEnt, 'tenant1-entitlements.json'));
  const preencher = (texto) => Object.entries(VALORES).reduce((acc, [k, v]) => acc.split(k).join(v), texto);
  const mapa = path.join(dirT1, 'tenancy-scenario-b.json');
  fs.writeFileSync(mapa, preencher(fs.readFileSync(path.join(TEMPLATES, 'tenancy-scenario-b.template.json'), 'utf8')));
  const rollout = path.join(dirT1, nome);
  const json = mudar(JSON.parse(preencher(fs.readFileSync(path.join(TEMPLATES, 'rollout-scenario-b.template.json'), 'utf8'))));
  fs.writeFileSync(rollout, JSON.stringify(json, null, 2));
  return { mapa, rollout };
}

test('r19 · RELEASE B = 31a7cdb: premissas conferidas no próprio git', async () => {
  const { RELEASE_B } = await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'config.mjs')).href);
  assert.equal(RELEASE_B.commit, COMMIT_B);
  const migrationsB = git(['ls-tree', '--name-only', COMMIT_B, 'migrations/']).split('\n').filter((x) => /^migrations\/\d+_.+\.js$/.test(x));
  assert.equal(migrationsB.length, 17);
  assert.equal(path.basename(migrationsB[migrationsB.length - 1], '.js'), RELEASE_B.ultimaMigration);
  // As migrations da B são as mesmas do HEAD (o HEAD só acrescenta): o schema "até a 17" é o da B.
  assert.equal(git(['diff', '--name-only', '--diff-filter=MDR', COMMIT_B, 'HEAD', '--', 'migrations/']).trim(), '');
  // O que a B executa no pre-deploy: seed sem perfil, import sem par declarado.
  const seedB = git(['show', `${COMMIT_B}:scripts/tenancy/seed-entitlements.mjs`]);
  assert.ok(seedB.includes('ENTITLEMENTS_SEED_FEATURES') && !seedB.includes('ENTITLEMENTS_SEED_PROFILE'));
  const zapB = git(['show', `${COMMIT_B}:scripts/integrations/import-whatsapp-sender.mjs`]);
  assert.ok(!zapB.includes('esperado') && !zapB.includes("'waba', $1"), 'a B não confere o par nem reivindica a WABA');
  const pkgB = JSON.parse(git(['show', `${COMMIT_B}:package.json`]));
  for (const s of ['migrate:up', 'auth:bootstrap-owner', 'tenancy:seed-entitlements', 'integrations:import-legacy', 'integrations:reencrypt', 'integrations:import-whatsapp-sender', 'tenancy:mover-criativos']) {
    assert.ok(pkgB.scripts[s], `${s} existe na B`);
  }
  assert.equal(pkgB.scripts['tenant1:verify'], undefined, 'tenant1 roda do HEAD');
});

test('r19 · RELEASE B: preflight antes-da-b → pre-deploy com o código de 31a7cdb → verify release-b → D\'', { timeout: 600000 }, async (t) => {
  const dirB = extrairReleaseB(t);
  const s = e.segredosDoEnsaio();
  const { db, sup } = await e.montarBase(t, 'B', s, { migrations: 17 });
  const uploads = e.uploadsLegados(t);
  const env = await e.ambiente('B', s, { url: db.url });
  env.TENANT1_OWNER_PASSWORD_HASH = env.TENANT1_OWNER_HASH;
  const proibidos = e.valoresProibidos(s, env);
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-r19h-relb-cfg-')));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const { rollout, mapa } = montarConfig(raiz);
  const semSegredo = (linhas, ctx) => { for (const v of proibidos) assert.ok(!linhas.join('\n').includes(v), `${ctx}: segredo na saída`); };

  // ── 1. antes da B: sem banco (sem DATABASE_URL no ambiente) ────────────────────────────────
  const antesArgs = ['--scenario', 'B', '--mapping', rollout, '--rollout', '--estagio', 'antes-da-b'];
  const { DATABASE_URL: _url, ...semBanco } = env;
  void _url;
  const cru = await e.executar('preflight', antesArgs, semBanco);
  assert.equal(cru.codigo, 1, cru.linhas.join('\n'));
  assert.deepEqual(statusDe(cru, 'release-b.entitlements'), ['FAIL']);
  semSegredo(cru.linhas, 'antes-da-b');
  const valor = (nome) => {
    const l = cru.linhas.find((x) => x.startsWith(`  ${nome}=`));
    assert.ok(l, `${nome} não impresso:\n${cru.linhas.join('\n')}`);
    return l.slice(nome.length + 3);
  };
  const perfil = JSON.parse(fs.readFileSync(PERFIL, 'utf8')).features;
  assert.equal(valor('ENTITLEMENTS_SEED_FEATURES'), [...perfil].sort().join(','));
  assert.ok(cru.linhas.includes(`  npm run integrations:import-whatsapp-sender -- --organization ${B} --aplicar`));

  const envB = {
    ...env,
    TENANCY_MAPPING_FILE: mapa,
    ENTITLEMENTS_SEED_ORGANIZATION_IDS: valor('ENTITLEMENTS_SEED_ORGANIZATION_IDS'),
    ENTITLEMENTS_SEED_FEATURES: valor('ENTITLEMENTS_SEED_FEATURES'),
    AUTH_BOOTSTRAP_OWNER_EMAIL: valor('AUTH_BOOTSTRAP_OWNER_EMAIL'),
    AUTH_BOOTSTRAP_ORGANIZATION_IDS: valor('AUTH_BOOTSTRAP_ORGANIZATION_IDS'),
    AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH: env.TENANT1_OWNER_PASSWORD_HASH,
  };
  const { DATABASE_URL: _u2, ...envBSemBanco } = envB;
  void _u2;
  const pronto = await e.executar('plan', antesArgs, envBSemBanco);
  assert.equal(pronto.codigo, 0, pronto.linhas.join('\n'));
  assert.deepEqual(soPassOuInfo(pronto), []);
  // Controles: lista com sobra, par trocado, mapeamento de outro arquivo, CREATIVE_TENANT_ID diferente.
  const ruins = {
    'release-b.entitlements': { ENTITLEMENTS_SEED_FEATURES: `${envB.ENTITLEMENTS_SEED_FEATURES},instagram` },
    'whatsapp.declaracao': { WHATSAPP_LEGACY_PHONE_NUMBER_ID: '5511900000123' },
    'release-b.mapeamento': { TENANCY_MAPPING_FILE: e.MAPEAMENTO.A },
    'release-b.creative-tenant': { CREATIVE_TENANT_ID: 'outro' },
    'release-b.owner': { AUTH_BOOTSTRAP_ORGANIZATION_IDS: 'a1000000-0000-4000-8000-000000000001' },
  };
  for (const [item, mudanca] of Object.entries(ruins)) {
    const r = await e.executar('preflight', antesArgs, { ...envBSemBanco, ...mudanca });
    assert.equal(r.codigo, 1, item);
    assert.deepEqual(statusDe(r, item), ['FAIL'], `${item}:\n${r.linhas.join('\n')}`);
  }
  // antes-da-b só vale para preflight/plan; release-b só para verify.
  const errado = await e.executar('apply', antesArgs, envBSemBanco);
  assert.ok(errado.linhas.some((l) => l.includes('--estagio antes-da-b só vale para: preflight, plan')));

  // ── 2. pre-deploy da RELEASE B com o código de 31a7cdb ────────────────────────────────────
  const passos = [
    ['scripts/auth/bootstrap-owner.mjs', []],
    ['scripts/tenancy/seed-entitlements.mjs', []],
    ['scripts/integrations/import-legacy.mjs', ['--aplicar']],
    ['scripts/integrations/reencrypt.mjs', []],
    ['scripts/integrations/import-whatsapp-sender.mjs', ['--organization', B, '--aplicar']],
    ['scripts/tenancy/mover-criativos.mjs', ['--uploads', uploads, '--de', 'default', '--para', B, '--aplicar']],
  ];
  for (const [script, args] of passos) {
    const r = rodarB(dirB, script, args, envB);
    assert.equal(r.status, 0, `${script}:\n${r.saida}`);
  }

  // ── 3. verify do HEAD contra o schema da B ────────────────────────────────────────────────
  const verB = ['--scenario', 'B', '--mapping', rollout, '--uploads', uploads, '--rollout', '--estagio', 'release-b'];
  const v1 = await e.executar('verify', verB, envB);
  assert.equal(v1.codigo, 0, v1.linhas.join('\n'));
  assert.deepEqual(soPassOuInfo(v1), []);
  for (const id of ['db.migrations', `entitlements[${B}]`, `whatsapp.remetente[${B}]`, 'whatsapp.declaracao', 'whatsapp.posse', 'rollout.alvo', `auth.owner[operacao@ensaio.oria]`, 'integrations.legado', 'creatives.arquivos']) {
    assert.deepEqual(statusDe(v1, id), ['PASS'], `${id}:\n${v1.linhas.join('\n')}`);
  }
  for (const id of ['whatsapp.posse-waba', 'tenancy.gates', 'role.app', 'jobs.leases', 'ink.webhook', `audit[${B}]`]) {
    assert.deepEqual(statusDe(v1, id), ['INFO'], `${id}:\n${v1.linhas.join('\n')}`);
  }
  semSegredo(v1.linhas, 'verify release-b');
  // Sem o estágio, o verify do HEAD reprova o schema da B (é por isso que o estágio existe).
  const semEstagio = await e.executar('verify', verB.slice(0, -2), envB);
  assert.deepEqual(statusDe(semEstagio, 'db.migrations'), ['FAIL']);
  const verifyNoPreflight = await e.executar('preflight', verB, envB);
  assert.ok(verifyNoPreflight.linhas.some((l) => l.includes('--estagio release-b só vale para: verify')));

  // ── 4. controles de dado ──────────────────────────────────────────────────────────────────
  // a) o seed da B aceita qualquer feature do vocabulário — o verify do HEAD é quem pega a sobra.
  const sobra = rodarB(dirB, 'scripts/tenancy/seed-entitlements.mjs', [], { ...envB, ENTITLEMENTS_SEED_FEATURES: 'instagram' });
  assert.equal(sobra.status, 0, 'a B não valida implementação');
  const v2 = await e.executar('verify', verB, envB);
  assert.equal(v2.codigo, 1);
  assert.deepEqual(statusDe(v2, `entitlements[${B}].extras`), ['FAIL'], v2.linhas.join('\n'));
  await sup.query(`UPDATE app_config SET valor = valor - 'instagram' WHERE chave = 'entitlements' AND organization_id = $1`, [B]);
  assert.equal((await e.executar('verify', verB, envB)).codigo, 0);
  // b) par diferente do declarado na integração → FAIL (a B não confere o par).
  await sup.query(`UPDATE integrations SET config = config || '{"waba_id": "1299999999999"}'::jsonb WHERE provider = 'whatsapp' AND organization_id = $1`, [B]);
  const v3 = await e.executar('verify', verB, envB);
  assert.deepEqual(statusDe(v3, `whatsapp.remetente[${B}]`), ['FAIL'], v3.linhas.join('\n'));
  await sup.query(`UPDATE integrations SET config = config || '{"waba_id": "1200000000009"}'::jsonb WHERE provider = 'whatsapp' AND organization_id = $1`, [B]);
  // c) outra Organization com o mesmo número configurado → FAIL (na B não há posse da WABA).
  const intrusa = '0d000000-0000-4000-8000-00000000000d';
  await sup.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'Intrusa')`, [intrusa]);
  await sup.query(`INSERT INTO integrations (organization_id, provider, escopo, status, config) VALUES ($1, 'whatsapp', NULL, 'disconnected', '{"waba_id": "1200000000009"}'::jsonb)`, [intrusa]);
  const v4 = await e.executar('verify', verB, envB);
  assert.deepEqual(statusDe(v4, 'whatsapp.posse'), ['FAIL'], v4.linhas.join('\n'));
  await sup.query('DELETE FROM integrations WHERE organization_id = $1', [intrusa]);
  await sup.query('DELETE FROM organizations WHERE id = $1', [intrusa]);
  assert.equal((await e.executar('verify', verB, envB)).codigo, 0);

  // ── 5. D' (HEAD) ─────────────────────────────────────────────────────────────────────────
  const m = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: mapa } });
  assert.equal(m.status, 0, `${m.stdout.slice(-2000)}${m.stderr}`);
  const role = e.roleDoEnsaio(t, 'oria_r19hd');
  await role.provisionar(sup, db.url);
  // Seed do HEAD com o perfil e a lista antiga ainda no ambiente (igual): nada muda.
  const { seedEntitlements } = await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'tenancy', 'seed-entitlements.mjs')).href);
  const antes = (await sup.query(`SELECT valor, atualizado_em FROM app_config WHERE chave = 'entitlements' AND organization_id = $1`, [B])).rows[0];
  const r = await seedEntitlements(db.url, { ...envB, ENTITLEMENTS_SEED_PROFILE: PERFIL });
  assert.deepEqual(r.ligadasAgora[B], []);
  const depois = (await sup.query(`SELECT valor, atualizado_em FROM app_config WHERE chave = 'entitlements' AND organization_id = $1`, [B])).rows[0];
  assert.deepEqual(depois, antes);
  await assert.rejects(seedEntitlements(db.url, { ...envB, ENTITLEMENTS_SEED_PROFILE: PERFIL, ENTITLEMENTS_SEED_FEATURES: 'whatsapp' }), /diverge do perfil/);

  // A posse da WABA nasceu do backfill da D0, na mesma Organization do número.
  const { rows: posses } = await sup.query(`SELECT tipo, organization_id FROM external_resource_claims WHERE provider = 'whatsapp' ORDER BY tipo`);
  assert.deepEqual(posses.map((p) => [p.tipo, p.organization_id]), [['phone_number', B], ['waba', B]]);

  // Import do HEAD na D' com o par declarado: divergente recusa; o declarado passa.
  const importHead = path.join(fs.realpathSync(h.RAIZ_REPO), 'scripts', 'integrations', 'import-whatsapp-sender.mjs');
  const rodarHead = (extra) => spawnSync(process.execPath, [importHead, '--organization', B, ...extra, '--aplicar'], { cwd: h.RAIZ_REPO, encoding: 'utf8', env: envB, timeout: 120000 });
  const divergente = rodarHead(['--waba-id', '1200000000009', '--phone-number-id', '5511900000123']);
  assert.equal(divergente.status, 1, `${divergente.stdout}${divergente.stderr}`);
  assert.match(divergente.stderr, /não são o par declarado/);
  const metade = rodarHead(['--waba-id', '1200000000009']);
  assert.equal(metade.status, 2);
  const certo = rodarHead(['--waba-id', '1200000000009', '--phone-number-id', '5511900000009']);
  assert.equal(certo.status, 0, `${certo.stdout}${certo.stderr}`);

  // Verify completo do HEAD (Ink fora: a URL opaca é emitida na tela, RELEASE D).
  const { rollout: semInk } = montarConfig(raiz, (j) => ({ ...j, inkWebhook: null }), 'rollout-sem-ink.json');
  const vd = await e.executar('verify', ['--scenario', 'B', '--mapping', semInk, '--uploads', uploads, '--rollout', '--app-role', role.role], { ...envB, ENTITLEMENTS_SEED_PROFILE: PERFIL });
  assert.equal(vd.codigo, 0, vd.linhas.join('\n'));
  assert.deepEqual(statusDe(vd, `whatsapp.remetente[${B}]`), ['PASS']);
  assert.deepEqual(statusDe(vd, 'tenancy.gates'), ['PASS']);
  assert.deepEqual(statusDe(vd, `audit[${B}]`), ['INFO'], 'rollout em produção não roda o apply');
  semSegredo(vd.linhas, 'verify D\'');
});
