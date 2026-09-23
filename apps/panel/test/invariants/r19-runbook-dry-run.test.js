'use strict';

// Rodada 19 · §15 — DRY-RUN do runbook (docs/productization/production-rollout-runbook.md, raiz do monorepo), sem
// produção: um Postgres descartável montado como a produção de hoje (6 migrations + dado legado das
// três lojas + credenciais nas colunas antigas) e uploads legados num diretório temporário.
//
// A sequência roda os COMANDOS do runbook, com o código de cada release:
//   §5.4  release:preflight (release-n, --legacy-forward-panel, com banco) + tenant1 antes-da-b
//   §7    vínculo dos criativos com o bloco de shell de round19-trilha-g.md §7.5
//   §8.2  pre-deploy da B: o bloco do runbook, rodado com o código de 31a7cdb (git archive)
//   §8.4  tenant1:verify --estagio release-b; criativo antigo pelo caminho da Organization
//   §10   pre-deploy da D0 (8c024d2) + emissão da URL opaca da Ink (OPS-34)
//   §12   preflight D' (segredo novo, tolerância) + pre-deploy com o código do HEAD
//   §12   tenant1:verify --rollout (HEAD, sem estágio)
//   §13.2 mover-criativos --verificar / --desvincular --aplicar / --verificar
//   §14   release:preflight --stage after-ops14 (MIGRATION_DATABASE_URL dona, DATABASE_URL = app)
//   §5.3  ensaio tenant1 preflight → plan → apply → verify num SEGUNDO banco (restauração simulada)
//   §5.3  productization:gate → BLOCKED, exit ≠ 0
//
// Substituições explícitas (e só estas) nos blocos do runbook: `<ORGANIZATION_ID_USE_ORIGENS>` pelo id
// do ensaio e `/tmp/tenancy-mapping.json` por um arquivo do diretório temporário do teste (o /tmp real
// é compartilhado entre execuções). No D', a linha do import ganha `--waba-id/--phone-number-id`, como
// o próprio §12 manda.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const e = require('../helpers/tenant1-ensaio');

const RAIZ = fs.realpathSync(h.RAIZ_REPO);
const RUNBOOK = path.join(RAIZ, '..', '..', 'docs', 'productization', 'production-rollout-runbook.md');
const DOC_G = path.join(RAIZ, '..', '..', 'docs', 'productization', 'round19-trilha-g.md');
const PERFIL = path.join(RAIZ, 'config', 'entitlements', 'tenant1-entitlements.json');
const TEMPLATES = path.join(RAIZ, 'config', 'tenant1');
const PREFLIGHT = path.join(RAIZ, 'scripts', 'release', 'preflight.mjs');
const TENANT1 = path.join(RAIZ, 'scripts', 'tenant1', 'cli.mjs');
const MOVER = path.join(RAIZ, 'scripts', 'tenancy', 'mover-criativos.mjs');
const GATE = path.join(RAIZ, 'scripts', 'productization', 'gate.mjs');
// Snapshots versionados dos commits de release (ver scripts/fixtures/legacy-snapshots.mjs).
const COMMIT = { B: '31a7cdb', D0: '8c024d2' };
const SNAPSHOT = { [COMMIT.B]: '31a7cdb-release-b', [COMMIT.D0]: '8c024d2-release-d0' };

const ORG = 'b1000000-0000-4000-8000-000000000001';
const WABA = '1200000000009';
const NUMERO = '5511900000009';
const EMAIL = 'operacao@ensaio.oria';
const VALORES = Object.freeze({
  '<ORGANIZATION_ID_USE_ORIGENS>': ORG,
  '<STORE_ID_USE_ORIGENS>': 'b2000000-0000-4000-8000-000000000001',
  '<CREATIVE_TENANT_ID_ATUAL>': 'default',
  '<EMAIL_DO_OWNER_USE_ORIGENS>': EMAIL,
  '<WABA_ID_ATUAL>': WABA,
  '<PHONE_NUMBER_ID_ATUAL>': NUMERO,
});

const statusDe = (linhas, id) => e.itensDe(linhas).filter((i) => i.id === id).map((i) => i.status);
const ruins = (linhas) => e.itensDe(linhas).filter((i) => i.status !== 'PASS' && i.status !== 'INFO');
const marcador = (rotulo) => `${rotulo}${crypto.randomBytes(18).toString('hex')}`;

function tmpReal(t, prefixo) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefixo)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Código publicado por uma release (o que o Pre-deploy Command roda), com o node_modules do repositório.
function extrairRelease(t, commit) {
  const dir = tmpReal(t, `oria-r19h-dry-${commit}-`);
  h.extrairSnapshotLegado(dir, SNAPSHOT[commit]);
  fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

// Bloco ```bash logo depois de um título do runbook.
function blocoDoRunbook(titulo) {
  const doc = fs.readFileSync(RUNBOOK, 'utf8');
  const ini = doc.indexOf(titulo);
  assert.ok(ini > 0, `seção não encontrada no runbook: ${titulo}`);
  const a = doc.indexOf('```bash\n', ini);
  const b = doc.indexOf('\n```', a + 8);
  return doc.slice(a + 8, b);
}

function blocoVinculo() {
  const doc = fs.readFileSync(DOC_G, 'utf8');
  const linhas = doc.slice(doc.indexOf('<!-- ops22-vincular-sh -->')).split('\n').map((l) => l.replace(/^> ?/, ''));
  const inicio = linhas.indexOf('```sh');
  const fim = linhas.indexOf('```', inicio + 1);
  assert.ok(inicio > 0 && fim > inicio, 'bloco de shell do vínculo não encontrado');
  return linhas.slice(inicio + 1, fim).join('\n');
}

function sh(script, { cwd, env }) {
  const r = spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8', env, timeout: 300000 });
  return { status: r.status, saida: `${r.stdout || ''}${r.stderr || ''}` };
}

function node(script, args, env, cwd = RAIZ) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env, timeout: 300000 });
  return { status: r.status, stdout: r.stdout || '', saida: `${r.stdout || ''}${r.stderr || ''}` };
}

// release:preflight pela CLI, com o export do ambiente num arquivo (como o operador faz).
function preflight(t, env, args) {
  const dir = tmpReal(t, 'oria-r19h-dry-pf-');
  const arq = path.join(dir, 'painel.env');
  fs.writeFileSync(arq, Object.entries(env).map(([k, v]) => `${k}="${v}"`).join('\n'), { mode: 0o600 });
  const r = node(PREFLIGHT, ['--from-env-file', arq, ...args], { PATH: process.env.PATH, HOME: process.env.HOME });
  const bloqueios = r.stdout.split('\n').filter((l) => /^\s+BLOCK\s/.test(l));
  return { ...r, bloqueios, warns: r.stdout.split('\n').filter((l) => /^\s+WARN\s/.test(l)) };
}

function semVazamento(texto, valores, ctx) {
  for (const v of valores) {
    // A mensagem identifica QUAL item vazou sem imprimi-lo: posição na lista e tamanho bastam
    // para achar a origem, e nenhum dos dois é o segredo.
    assert.ok(!texto.includes(v), `${ctx}: valor sensível na saída (item ${valores.indexOf(v)}, ${v.length} caracteres)`);
  }
}

function montarConfig(raiz) {
  const dirT1 = path.join(raiz, 'config', 'tenant1');
  const dirEnt = path.join(raiz, 'config', 'entitlements');
  fs.mkdirSync(dirT1, { recursive: true });
  fs.mkdirSync(dirEnt, { recursive: true });
  fs.copyFileSync(PERFIL, path.join(dirEnt, 'tenant1-entitlements.json'));
  const preencher = (texto) => Object.entries(VALORES).reduce((acc, [k, v]) => acc.split(k).join(v), texto);
  const mapa = path.join(dirT1, 'tenancy-scenario-b.json');
  fs.writeFileSync(mapa, preencher(fs.readFileSync(path.join(TEMPLATES, 'tenancy-scenario-b.template.json'), 'utf8')));
  const rollout = path.join(dirT1, 'rollout-scenario-b.json');
  fs.writeFileSync(rollout, preencher(fs.readFileSync(path.join(TEMPLATES, 'rollout-scenario-b.template.json'), 'utf8')));
  // §5.3 passo 3: nenhum placeholder sobrando.
  assert.equal(sh(`grep -n '<[A-Z_]*>' "${rollout}" "${mapa}"`, { cwd: raiz, env: { PATH: process.env.PATH } }).status, 1);
  return { mapa, rollout };
}

// Criativos como na produção: o seed genérico grava chaves sintéticas; aqui cada linha do Creative
// Core ganha chave válida e um arquivo real no diretório legado (sha256 e tamanho batendo).
async function criativosComoProducao(sup, uploads) {
  const legado = path.join(uploads, 'creatives', 'tenant', 'default');
  const gravar = (rel) => {
    const buf = crypto.randomBytes(64);
    const abs = path.join(legado, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    return buf;
  };
  let refs = 0;
  for (const { id } of (await sup.query('SELECT id FROM creative_assets')).rows) {
    const rel = `creatives/${crypto.randomUUID()}/image.png`;
    const buf = gravar(rel);
    await sup.query('UPDATE creative_assets SET storage_key = $1, sha256 = $2, byte_size = $3 WHERE id = $4',
      [rel, crypto.createHash('sha256').update(buf).digest('hex'), buf.length, id]);
  }
  let umaRef = null;
  for (const { id } of (await sup.query('SELECT id FROM creative_products')).rows) {
    const rel = `products/${id}/${crypto.randomUUID()}.png`;
    const buf = gravar(rel);
    umaRef = umaRef || rel;
    refs += 1;
    await sup.query('UPDATE creative_products SET references_json = $1::jsonb WHERE id = $2',
      [JSON.stringify([{ ref: rel, mime: 'image/png', sizeBytes: buf.length }]), id]);
  }
  await sup.query(`UPDATE creative_generations SET plan = jsonb_build_object('references', $1::jsonb)`,
    [JSON.stringify(umaRef ? [{ ref: umaRef }] : [])]);
  return refs;
}

// Ambiente do painel de produção (§5.4), com os valores do ensaio.
async function ambienteDeProducao(s, url, mapa, envEnsaio) {
  const features = JSON.parse(fs.readFileSync(PERFIL, 'utf8')).features.join(',');
  return {
    ...Object.fromEntries(Object.entries(envEnsaio).filter(([k]) => /^(INK_|WHATSAPP_LEGACY_)/.test(k))),
    NODE_ENV: 'production',
    DATABASE_URL: url,
    ENCRYPTION_MASTER_KEY: s.mestra,
    ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: '1',
    ADMIN_SESSION_SECRET: s.sessao,
    TENANCY_MAPPING_FILE: mapa,
    AUTH_BOOTSTRAP_OWNER_EMAIL: EMAIL,
    AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH: envEnsaio.TENANT1_OWNER_HASH,
    AUTH_BOOTSTRAP_ORGANIZATION_IDS: ORG,
    ENTITLEMENTS_SEED_ORGANIZATION_IDS: ORG,
    ENTITLEMENTS_SEED_PROFILE: PERFIL,
    ENTITLEMENTS_SEED_FEATURES: features,
    ALLOW_LEGACY_INTEGRATION_ENV: '1',
    WHATSAPP_SERVICE_URL: 'https://go.ensaio.interno',
    WHATSAPP_API_KEY: marcador('apikey'),
    WHATSAPP_SENDER_REF_SECRET: marcador('refsecret'),
    WHATSAPP_SENDER_RESOLVER_KEY: marcador('resolver'),
    // Produção hoje: o repasse ainda é autenticado pela query com o segredo LEGADO (curto).
    WHATSAPP_WEBHOOK_SECRET: `leg${crypto.randomBytes(6).toString('hex')}`,
    TENANT1_OWNER_PASSWORD_HASH: envEnsaio.TENANT1_OWNER_HASH,
  };
}

test('r19 §15 · dry-run do runbook: antes da B → B (31a7cdb) → D0 (8c024d2) → D\' (HEAD) → §13.2 → F', { timeout: 900000 }, async (t) => {
  const codigoB = extrairRelease(t, COMMIT.B);
  const codigoD0 = extrairRelease(t, COMMIT.D0);
  const s = e.segredosDoEnsaio();
  const { db, sup } = await e.montarBase(t, 'B', s, { migrations: e.MIGRATIONS_PRE_TENANCY });
  const uploads = e.uploadsLegados(t);
  assert.ok(await criativosComoProducao(sup, uploads) > 0, 'há referências de criativos para conferir');
  const arquivosLegados = sh('find default -type f | wc -l', { cwd: path.join(uploads, 'creatives', 'tenant'), env: { PATH: process.env.PATH } }).saida.trim();
  const arteLegada = fs.readFileSync(path.join(uploads, 'creatives', 'tenant', 'default', 'assets', 'arte.png'));
  const envEnsaio = await e.ambiente('B', s, { url: db.url });
  const raiz = tmpReal(t, 'oria-r19h-dry-cfg-');
  const { mapa, rollout } = montarConfig(raiz);
  const prod = await ambienteDeProducao(s, db.url, mapa, envEnsaio);
  const proibidos = [
    ...e.valoresProibidos(s, envEnsaio),
    prod.WHATSAPP_API_KEY, prod.WHATSAPP_SENDER_REF_SECRET, prod.WHATSAPP_SENDER_RESOLVER_KEY, prod.WHATSAPP_WEBHOOK_SECRET,
  ];
  // `semVazamento` procura SUBSTRING, e substring só é detector honesto quando o valor é longo e
  // aleatório. A senha do Postgres de teste é uma palavra (`teste`, em scripts/test-db.mjs) e casa
  // com prosa comum — "nos testes", "um teste compara" — em qualquer SQL que o pre-deploy ecoe.
  // Um detector que grita por prosa é um detector que alguém acaba calando.
  //
  // São duas camadas. `valoresProibidos` (test/helpers/tenant1-ensaio.js) já entrega a senha do
  // banco na forma em que ela vaza de verdade — `usuario:senha@`, longa o bastante para só casar de
  // propósito — em vez de solta. E aqui a lista do que fica FORA da varredura é DECLARADA: hoje
  // está vazia, e se algum valor curto novo aparecer este assert reprova e obriga alguém a olhar,
  // em vez de deixá-lo passar em silêncio.
  const curtos = [...new Set(proibidos.filter((v) => v.length < 12))];
  assert.deepEqual(curtos, [],
    'valor sensível curto não declarado — confira antes de deixá-lo fora da varredura de vazamento');
  const semSegredo = (texto, ctx) => semVazamento(texto, proibidos.filter((v) => v.length >= 12), ctx);
  const tenant1 = (comando, args, env) => {
    const r = node(TENANT1, [comando, ...args], { PATH: process.env.PATH, ...env });
    semSegredo(r.saida, `tenant1 ${comando}`);
    return { ...r, linhas: r.stdout.split('\n') };
  };
  const base = ['--scenario', 'B', '--mapping', rollout, '--rollout'];

  // ── §5.4 preflight da B (com banco) ───────────────────────────────────────────────────────
  const pfB = preflight(t, prod, ['--stage', 'release-n', '--legacy-forward-panel']);
  assert.equal(pfB.status, 0, pfB.saida);
  assert.deepEqual(pfB.bloqueios, []);
  assert.match(pfB.stdout, /MAPPING[\s\S]*OK\s+tenancy-scenario-b\.json/);
  assert.match(pfB.stdout, /OK\s+PD-019\s+cenário B \(alvo de rollout\)/);
  assert.match(pfB.stdout, /OK\s+ENTITLEMENTS_SEED_FEATURES\s+igual ao perfil/);
  assert.match(pfB.stdout, /OK\s+WHATSAPP_WEBHOOK_SECRET\s+presente · valor LEGADO/, 'segredo legado curto aceito no modo --legacy-forward-panel');
  assert.match(pfB.stdout, /pendente \(o pre-deploy aplica\)/, 'schema de produção ainda antes da Fase 1');
  semSegredo(pfB.saida, 'preflight B');
  // Sem o modo de transição, o segredo legado curto bloqueia (é o boot do HEAD).
  assert.ok(preflight(t, prod, ['--stage', 'release-n', '--no-db']).bloqueios.some((l) => l.includes('WHATSAPP_WEBHOOK_SECRET')));

  const antes = tenant1('preflight', [...base, '--estagio', 'antes-da-b'], prod);
  assert.equal(antes.status, 0, antes.saida);
  assert.match(antes.stdout, /RESULTADO preflight: PASS/);
  assert.ok(antes.linhas.includes(`  npm run integrations:import-whatsapp-sender -- --organization ${ORG} --aplicar`));

  // ── §7 vínculo dos criativos (produção atual, antes da B) ─────────────────────────────────
  const vinculo = sh(blocoVinculo(), { cwd: raiz, env: { PATH: process.env.PATH, UPLOADS_DIR: uploads, LEGADO: 'default', ORG } });
  assert.equal(vinculo.status, 0, vinculo.saida);
  assert.match(vinculo.saida, new RegExp(`vínculo criado: tenant/${ORG} -> tenant/default \\(${arquivosLegados} arquivo\\(s\\)\\)`));
  assert.equal(fs.readlinkSync(path.join(uploads, 'creatives', 'tenant', ORG)), 'default');

  // ── §8.2 pre-deploy da B, com o código de 31a7cdb ─────────────────────────────────────────
  const arqMapa = path.join(raiz, 'tenancy-mapping.json');
  const blocoPreDeploy = blocoDoRunbook('### 8.2 PRE-DEPLOY');
  assert.ok(blocoPreDeploy.includes('/tmp/tenancy-mapping.json') && blocoPreDeploy.includes('<ORGANIZATION_ID_USE_ORIGENS>'));
  const preDeploy = blocoPreDeploy.split('/tmp/tenancy-mapping.json').join(arqMapa).split('<ORGANIZATION_ID_USE_ORIGENS>').join(ORG);
  // O mapeamento chega como o runbook manda: conteúdo compacto numa variável (jq -c), sem o arquivo.
  const { TENANCY_MAPPING_FILE: _semArquivo, ...prodSemArquivo } = prod;
  void _semArquivo;
  const envPreDeploy = { ...prodSemArquivo, PATH: process.env.PATH, HOME: process.env.HOME, TENANCY_MAPPING_JSON: JSON.stringify(JSON.parse(fs.readFileSync(mapa, 'utf8'))) };
  const pdB = sh(preDeploy, { cwd: codigoB, env: envPreDeploy });
  assert.equal(pdB.status, 0, pdB.saida);
  assert.match(pdB.saida, /entitlements: catalog, .* ligadas em 1 organization\(s\)/);
  assert.match(pdB.saida, new RegExp(`whatsapp: organization ${ORG} ← número ${NUMERO}, WABA ${WABA}, token final .{4}: importado`));
  semSegredo(pdB.saida, 'pre-deploy B');
  assert.equal(fs.readFileSync(arqMapa, 'utf8'), envPreDeploy.TENANCY_MAPPING_JSON);
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 17);

  // ── §8.4 VERIFY B ─────────────────────────────────────────────────────────────────────────
  const verB = tenant1('verify', [...base, '--uploads', uploads, '--estagio', 'release-b'], prod);
  assert.equal(verB.status, 0, verB.saida);
  assert.deepEqual(ruins(verB.linhas), [], verB.saida);
  for (const id of ['db.migrations', `entitlements[${ORG}]`, 'whatsapp.declaracao', `whatsapp.remetente[${ORG}]`, 'whatsapp.posse', 'creatives.arquivos']) {
    assert.deepEqual(statusDe(verB.linhas, id), ['PASS'], `${id}:\n${verB.saida}`);
  }
  assert.deepEqual(statusDe(verB.linhas, `entitlements[${ORG}].extras`), []);
  for (const id of ['whatsapp.posse-waba', 'tenancy.gates', 'role.app', 'jobs.leases', 'ink.webhook', `audit[${ORG}]`, 'tenancy.loja-fora-da-store', 'creatives.materializacao']) {
    assert.deepEqual(statusDe(verB.linhas, id), ['INFO'], `${id}:\n${verB.saida}`);
  }
  // Criativo antigo pelo caminho da Organization (o que a B lê), via vínculo.
  assert.ok(fs.readFileSync(path.join(uploads, 'creatives', 'tenant', ORG, 'assets', 'arte.png')).equals(arteLegada));
  const pfBBanco = preflight(t, prod, ['--stage', 'release-n', '--legacy-forward-panel']);
  assert.deepEqual(pfBBanco.bloqueios, [], pfBBanco.saida);
  assert.match(pfBBanco.stdout, /17 aplicadas/);

  // ── §10 RELEASE D0 (8c024d2): o mesmo bloco, migrations 18-21; OPS-34 logo depois ─────────
  const pfD0 = preflight(t, prod, ['--legacy-forward-panel']);
  assert.deepEqual(pfD0.bloqueios, [], pfD0.saida);
  const pdD0 = sh(preDeploy, { cwd: codigoD0, env: envPreDeploy });
  assert.equal(pdD0.status, 0, pdD0.saida);
  semSegredo(pdD0.saida, 'pre-deploy D0');
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 21);
  // OPS-34: URL opaca emitida pela regra da tela (hash + posse + config); a URL só vai para o arquivo 0600.
  const { emitirUrlInk } = await import(pathToFileURL(path.join(RAIZ, 'scripts', 'tenant1', 'acoes.mjs')).href);
  const dirUrl = path.join(raiz, 'urls');
  const emitida = await emitirUrlInk(db.url, ORG, dirUrl);
  assert.equal(emitida.mudou, true);

  // ── §12 RELEASE D' (HEAD) ─────────────────────────────────────────────────────────────────
  const envD = {
    ...prod,
    WHATSAPP_WEBHOOK_SECRET: marcador('repasse-novo-'),
    WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED: '1',
    // §13.2: a leitura dupla entra na D'.
    CREATIVE_LEGACY_READ_FROM: 'default',
    CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG,
  };
  proibidos.push(envD.WHATSAPP_WEBHOOK_SECRET);
  const pfD = preflight(t, envD, []);
  assert.equal(pfD.status, 0, pfD.saida);
  assert.deepEqual(pfD.bloqueios, []);
  assert.ok(pfD.warns.some((l) => l.includes('WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED')), pfD.stdout);
  assert.ok(pfD.warns.some((l) => l.includes('CREATIVE_LEGACY_READ_*')), pfD.stdout);
  semSegredo(pfD.saida, 'preflight D\'');
  // O HEAD não aceita o segredo legado curto (boot fail-fast da rodada 19).
  assert.ok(preflight(t, { ...envD, WHATSAPP_WEBHOOK_SECRET: prod.WHATSAPP_WEBHOOK_SECRET }, ['--no-db']).bloqueios.some((l) => l.includes('WHATSAPP_WEBHOOK_SECRET')));

  const linhaImport = `npm run integrations:import-whatsapp-sender -- --organization ${ORG} --aplicar`;
  assert.ok(preDeploy.includes(linhaImport));
  const preDeployHead = preDeploy.replace(linhaImport,
    `npm run integrations:import-whatsapp-sender -- --organization ${ORG} --waba-id ${WABA} --phone-number-id ${NUMERO} --aplicar`);
  const envPreDeployD = { ...envPreDeploy, WHATSAPP_WEBHOOK_SECRET: envD.WHATSAPP_WEBHOOK_SECRET, ENTITLEMENTS_SEED_PROFILE: PERFIL };
  const antesD = (await sup.query(`SELECT valor, atualizado_em FROM app_config WHERE chave = 'entitlements' AND organization_id = $1`, [ORG])).rows[0];
  const pdD = sh(preDeployHead, { cwd: RAIZ, env: envPreDeployD });
  assert.equal(pdD.status, 0, pdD.saida);
  assert.match(pdD.saida, /entitlements: perfil tenant1-operacao-interna · ON: catalog, /);
  assert.match(pdD.saida, new RegExp(`entitlements: ${ORG}: nada mudou`));
  // D0 é o snapshot de 8c024d2: as migrations posteriores a ele só existem no HEAD, e é o
  // pre-deploy da D' que as aplica. Esta linha exigia `No migrations to run!` até a fusão do
  // control plane (7f0a130, posterior a este teste) acrescentar a 0019 — a asserção passou a
  // mentir sobre o que o runbook faz na D'. Agora ela DECLARA a lista: migration nova sem entrar
  // aqui reprova, que é o ponto do dry-run.
  assert.deepEqual(
    [...pdD.saida.matchAll(/^### MIGRATION (\S+) \(UP\) ###$/gm)].map((m) => m[1]),
    ['1790000400000_platform-admin', '1790000500000_convite-aceite', '1790000600000_store-id-connector-ink',
      '1790000800000_entitlement-canonico', '1790000900000_composicao-do-internal', '1790001000000_midia-store-id',
      '1790001100000_catalogo-ink-store-id', '1790001200000_ga4-store-id', '1790001300000_oauth-state-whatsapp', '1790001400000_campanhas-store-id', '1790001500000_reparar-loja-uuid-em-pedidos',
      '1790001600000_creative-trace',
      '1790001700000_creative-plan-v2',
      '1790001800000_creative-feedback',
      '1790001900000_creative-angles',
      '1790002000000_creative-angles-compat',
      '1790002100000_creative-enrichment',
      '1790002200000_creative-enrichment-provider-meta'],
    'o pre-deploy da D\' aplicou um conjunto de migrations diferente do declarado'
  );
  semSegredo(pdD.saida, 'pre-deploy D\'');
  const depoisD = (await sup.query(`SELECT valor, atualizado_em FROM app_config WHERE chave = 'entitlements' AND organization_id = $1`, [ORG])).rows[0];
  assert.deepEqual(depoisD, antesD, 'seed do HEAD: nada muda');
  // O import do HEAD recusa um par diferente do declarado.
  const errado = sh(preDeployHead.slice(preDeployHead.indexOf('npm run integrations:import-whatsapp-sender')).replace(`--phone-number-id ${NUMERO}`, '--phone-number-id 5511900000123'),
    { cwd: RAIZ, env: envPreDeployD });
  assert.notEqual(errado.status, 0);
  assert.match(errado.saida, /não são o par declarado/);

  // VERIFY D' (HEAD, sem estágio), ainda com o vínculo.
  const verD = tenant1('verify', [...base, '--uploads', uploads], envD);
  assert.equal(verD.status, 0, verD.saida);
  assert.deepEqual(ruins(verD.linhas), [], verD.saida);
  assert.deepEqual(statusDe(verD.linhas, `ink.webhook[${ORG}]`), ['PASS']);
  assert.deepEqual(statusDe(verD.linhas, `whatsapp.remetente[${ORG}]`), ['PASS']);
  assert.deepEqual(statusDe(verD.linhas, 'creatives.arquivos'), ['PASS']);
  assert.deepEqual(statusDe(verD.linhas, 'role.app'), ['INFO'], 'antes do OPS-14 a role da aplicação não é exigida');
  const { rows: posses } = await sup.query(`SELECT tipo, organization_id FROM external_resource_claims WHERE provider = 'whatsapp' ORDER BY tipo`);
  assert.deepEqual(posses.map((p) => [p.tipo, p.organization_id]), [['phone_number', ORG], ['waba', ORG]]);

  // ── §13.2 materialização dos criativos ────────────────────────────────────────────────────
  const moverArgs = ['--uploads', uploads, '--de', 'default', '--para', ORG];
  const envMover = { PATH: process.env.PATH, DATABASE_URL: db.url };
  const v1 = node(MOVER, [...moverArgs, '--verificar'], envMover);
  assert.equal(v1.status, 0, v1.saida);
  assert.match(v1.stdout, /estado: vinculado/);
  assert.match(v1.stdout, /criativos: PASS-VINCULADO/);
  const mat = node(MOVER, [...moverArgs, '--desvincular', '--aplicar'], envMover);
  assert.equal(mat.status, 0, mat.saida);
  assert.match(mat.stdout, new RegExp(`vínculo tenant/${ORG} removido`));
  assert.match(mat.stdout, new RegExp(`${arquivosLegados} movido\\(s\\)`));
  const v2 = node(MOVER, [...moverArgs, '--verificar'], envMover);
  assert.equal(v2.status, 0, v2.saida);
  assert.match(v2.stdout, /estado: separado/);
  assert.match(v2.stdout, /criativos: PASS\n/);
  assert.ok(!fs.lstatSync(path.join(uploads, 'creatives', 'tenant', ORG)).isSymbolicLink());
  assert.ok(fs.readFileSync(path.join(uploads, 'creatives', 'tenant', ORG, 'assets', 'arte.png')).equals(arteLegada));
  semSegredo(`${v1.saida}${mat.saida}${v2.saida}`, 'mover');

  const verD2 = tenant1('verify', [...base, '--uploads', uploads], envD);
  assert.equal(verD2.status, 0, verD2.saida);
  assert.deepEqual(ruins(verD2.linhas), [], verD2.saida);
  assert.deepEqual(statusDe(verD2.linhas, 'creatives.materializacao'), []);

  // ── §14 RELEASE F (OPS-14) ────────────────────────────────────────────────────────────────
  const role = e.roleDoEnsaio(t, 'oria_r19hf');
  await role.provisionar(sup, db.url);
  const urlApp = h.urlComUsuario(db.url, role.role, role.senha);
  proibidos.push(role.senha);
  const envF = { ...envD, DATABASE_URL: urlApp, MIGRATION_DATABASE_URL: db.url, DB_ENFORCE_APP_ROLE: '1' };
  delete envF.CREATIVE_LEGACY_READ_FROM; // §13.2: removidas na release seguinte à materialização
  delete envF.CREATIVE_LEGACY_READ_ORGANIZATION_ID;
  // Divergência encontrada: o runbook só remove ALLOW_LEGACY_INTEGRATION_ENV no CLEANUP (§15.2), mas o
  // preflight de after-ops14 a bloqueia (permitida só em release-n). Registrado aqui, sem contornar.
  const pfFComFlag = preflight(t, envF, ['--stage', 'after-ops14']);
  assert.equal(pfFComFlag.status, 1);
  assert.deepEqual(pfFComFlag.bloqueios.map((l) => l.trim().split(/\s+/)[1]), ['ALLOW_LEGACY_INTEGRATION_ENV'], pfFComFlag.stdout);
  delete envF.ALLOW_LEGACY_INTEGRATION_ENV;
  const pfF = preflight(t, envF, ['--stage', 'after-ops14']);
  assert.equal(pfF.status, 0, pfF.saida);
  assert.deepEqual(pfF.bloqueios, []);
  assert.match(pfF.stdout, /OK\s+DATABASE_URL\s+role do app cumpre o contrato/);
  assert.match(pfF.stdout, /OK\s+MIGRATION_DATABASE_URL\s+usuário distinto do app: sim/);
  assert.ok(pfF.warns.some((l) => l.includes('ENTITLEMENTS_SEED_FEATURES')), pfF.stdout);
  semSegredo(pfF.saida, 'preflight F');
  const verF = tenant1('verify', [...base, '--uploads', uploads, '--app-role', role.role], { ...envF, DATABASE_URL: db.url });
  assert.equal(verF.status, 0, verF.saida);
  assert.deepEqual(statusDe(verF.linhas, 'role.app'), ['PASS']);
  // Com DB_ENFORCE_APP_ROLE=1 a tolerância acaba: role inexistente reprova.
  const semRole = tenant1('verify', [...base, '--uploads', uploads, '--app-role', 'oria_r19h_nao_existe'], { ...envF, DATABASE_URL: db.url });
  assert.equal(semRole.status, 1);
  assert.deepEqual(statusDe(semRole.linhas, 'role.app'), ['FAIL']);
});

test('r19 §15 · ensaio §5.3: tenant1 preflight → plan → apply → verify --rollout num segundo banco (restauração)', { timeout: 300000 }, async (t) => {
  const s = e.segredosDoEnsaio();
  const { db, sup } = await e.montarBase(t, 'B', s);
  const role = e.roleDoEnsaio(t, 'oria_r19he');
  await role.provisionar(sup, db.url);
  const uploads = e.uploadsLegados(t);
  const env = await e.ambiente('B', s, { url: db.url });
  env.TENANT1_OWNER_PASSWORD_HASH = env.TENANT1_OWNER_HASH;
  const raiz = tmpReal(t, 'oria-r19h-ensaio-');
  const { rollout } = montarConfig(raiz);
  const dirSeg = path.join(raiz, 'segredos');
  const base = ['--scenario', 'B', '--mapping', rollout, '--uploads', uploads, '--rollout', '--app-role', role.role];
  const proibidos = e.valoresProibidos(s, env);
  for (const [comando, extra] of [['preflight', []], ['plan', []], ['apply', ['--saida-segredos', dirSeg]], ['verify', []]]) {
    const r = await e.executar(comando, [...base, ...extra], env);
    assert.equal(r.codigo, 0, `${comando}:\n${r.linhas.join('\n')}`);
    assert.ok(r.linhas[0].endsWith('· ALVO DE ROLLOUT'), r.linhas[0]);
    assert.ok(r.linhas.includes(`RESULTADO ${comando}: PASS`));
    semVazamento(r.linhas.join('\n'), proibidos, comando);
    if (comando !== 'plan') assert.deepEqual(statusDe(r.linhas, 'rollout.alvo'), ['PASS']);
    if (comando === 'verify') {
      assert.deepEqual(ruins(r.linhas), []);
      assert.deepEqual(statusDe(r.linhas, 'whatsapp.declaracao'), ['PASS']);
    }
  }
});

test('r19 §15 · productization:gate sem rollout real: OPS NOT VERIFIED, DOGFOOD NOT STARTED, BLOCKED, exit ≠ 0', { timeout: 180000 }, (t) => {
  const vazio = tmpReal(t, 'oria-r19h-ev-');
  // --skip-suite: este teste roda DENTRO da suíte (rodá-la de novo seria recursivo). Os checks
  // derivados da suíte ficam NOT VERIFIED e o gate sai 1; com a suíte completa, o §5.3 espera exit 2
  // (CODE PASS, rollout bloqueado). --no-go-tests: sem a suíte, os testes do Go não rodam de qualquer forma.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (process.env.WHATSAPP_GO_DIR) env.WHATSAPP_GO_DIR = process.env.WHATSAPP_GO_DIR;
  const r = spawnSync(process.execPath, [GATE, '--skip-suite', '--no-go-tests', '--json', '--evidence-dir', vazio], { cwd: RAIZ, encoding: 'utf8', env, timeout: 170000 });
  assert.notEqual(r.status, 0, r.stderr);
  const rel = JSON.parse(r.stdout);
  assert.equal(rel.overall, 'BLOCKED');
  assert.equal(rel.exit, r.status);
  assert.equal(rel.ops.length, 36);
  assert.deepEqual([...new Set(rel.ops.map((o) => o.status))], ['NOT VERIFIED']);
  assert.equal(rel.dogfood.status, 'NOT STARTED');
  assert.ok(rel.bloqueios.includes('OPS-27 NOT VERIFIED'));
  assert.equal(rel.codeStatus, 'NOT VERIFIED', 'com --skip-suite o código não é dado como PASS');
});
