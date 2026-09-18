'use strict';

// Preflight de release (rodada 18, trilha D, §32): somente leitura e NUNCA imprime valor secreto.
//
//   - variáveis: só nome e "atende o requisito"; flags legadas por estágio; variáveis de tenant
//     que saem na limpeza; role de migration separada; mapeamento validado sem aplicar;
//   - banco real (Postgres efêmero): versão do schema e contrato da role, numa transação READ ONLY;
//   - vazamento: nenhum valor de segredo aparece no texto nem no JSON, inclusive com erro de
//     conexão — e o detector de vazamento reprova uma cópia do script que imprime valor
//     (ciclo de 5 passos).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const h = require('./harness');

const SCRIPT = path.join(h.RAIZ_REPO, 'scripts', 'release', 'preflight.mjs');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const CENARIO_B = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-b.json');
const PERFIL_TENANT1 = path.join(h.RAIZ_REPO, 'config', 'entitlements', 'tenant1-entitlements.json');
const LISTA_TENANT1 = JSON.parse(fs.readFileSync(PERFIL_TENANT1, 'utf8')).features.join(',');
let pf;

test.before(async () => {
  pf = await import(pathToFileURL(SCRIPT));
});

const marcador = (rotulo) => `${rotulo}${crypto.randomBytes(18).toString('hex')}`;

// Ambiente completo para o estágio release-n, com valores marcados para detectar vazamento.
function envCompleto() {
  const senhaApp = marcador('senhaapp');
  const senhaMig = marcador('senhamig');
  return {
    NODE_ENV: 'production',
    DATABASE_URL: `postgres://usuarioapp:${senhaApp}@127.0.0.1:1/oria`,
    MIGRATION_DATABASE_URL: `postgres://usuariomig:${senhaMig}@127.0.0.1:1/oria`,
    ENCRYPTION_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
    ADMIN_SESSION_SECRET: marcador('sessao'),
    ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: '1',
    TENANCY_MAPPING_FILE: CENARIO_B,
    AUTH_BOOTSTRAP_OWNER_EMAIL: `${marcador('email')}@teste.oria`,
    AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH: marcador('hash'),
    AUTH_BOOTSTRAP_ORGANIZATION_IDS: 'a1000000-0000-4000-8000-000000000001',
    ENTITLEMENTS_SEED_ORGANIZATION_IDS: 'a1000000-0000-4000-8000-000000000001',
    ENTITLEMENTS_SEED_PROFILE: PERFIL_TENANT1,
    // RELEASE B (31a7cdb) só lê a lista antiga: igual ao perfil.
    ENTITLEMENTS_SEED_FEATURES: LISTA_TENANT1,
    WHATSAPP_SERVICE_URL: `https://${marcador('host')}.interno`,
    WHATSAPP_API_KEY: marcador('apikey'),
    WHATSAPP_SENDER_REF_SECRET: marcador('refsecret'),
    WHATSAPP_SENDER_RESOLVER_KEY: marcador('resolver'),
    WHATSAPP_WEBHOOK_SECRET: marcador('repasse'),
    INK_TOKEN_SUL: marcador('inktoken'),
    INK_WEBHOOK_SECRET_SUL: marcador('inkwebhook'),
    ADMIN_PASSWORD: marcador('adminpass'),
  };
}

function segredosDe(env) {
  const valores = Object.entries(env)
    .filter(([k]) => !['NODE_ENV', 'ENCRYPTION_ALLOW_LEGACY_SESSION_KEY', 'TENANCY_MAPPING_FILE', 'AUTH_BOOTSTRAP_ORGANIZATION_IDS',
      'ENTITLEMENTS_SEED_ORGANIZATION_IDS', 'ENTITLEMENTS_SEED_PROFILE', 'ENTITLEMENTS_SEED_FEATURES', 'DB_ENFORCE_APP_ROLE', 'ALLOW_LEGACY_ADMIN_PASSWORD',
      'ALLOW_LEGACY_INTEGRATION_ENV', 'META_APP_ID'].includes(k))
    .map(([, v]) => v);
  // Partes das URLs de banco também são segredo aqui: senha, usuário e host.
  for (const [k, v] of Object.entries(env)) {
    if (!/DATABASE_URL$/.test(k)) continue;
    const u = new URL(v);
    valores.push(decodeURIComponent(u.password), decodeURIComponent(u.username));
    if (u.hostname !== '127.0.0.1') valores.push(u.hostname);
  }
  return valores.filter((v) => v && v.length >= 8);
}

function vazados(saida, env) {
  return segredosDe(env).filter((v) => saida.includes(v));
}

function rodar(script, env, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-preflight-'));
  const arq = path.join(dir, 'railway.env');
  fs.writeFileSync(arq, Object.entries(env).map(([k, v]) => `${k}="${v}"`).join('\n'));
  const limpo = { PATH: process.env.PATH, HOME: process.env.HOME };
  const r = spawnSync(process.execPath, [script, '--from-env-file', arq, ...args], { encoding: 'utf8', env: limpo, timeout: 60000 });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, saida: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}

const achar = (r, secao, nome) => r.itens.filter((i) => i.secao === secao && i.nome === nome);

test('preflight · ambiente completo de release N sem banco → sem bloqueio, só nomes', async () => {
  const env = envCompleto();
  const r = await pf.preflight(env, { banco: false });
  assert.deepEqual(r.itens.filter((i) => i.status === pf.BLOCK), []);
  assert.equal(r.exit, 0);
  assert.equal(achar(r, 'env', 'ENCRYPTION_MASTER_KEY')[0].texto, 'presente · 32 bytes em base64: sim (OPS-12)');
  assert.equal(achar(r, 'flags', 'ENCRYPTION_ALLOW_LEGACY_SESSION_KEY')[0].status, pf.WARN);
  assert.ok(achar(r, 'legado', 'INK_TOKEN_SUL').length, 'variável legada listada pelo nome');
  assert.equal(achar(r, 'mapping', 'cenario-b.json')[0].status, pf.OK);
  assert.equal(achar(r, 'rollout', 'PD-019')[0].status, pf.OK);
  assert.deepEqual(vazados(JSON.stringify(r), env), []);
});

test('preflight · requisitos de valor, flags e limpeza bloqueiam por estágio', async () => {
  const curto = { ...envCompleto(), ADMIN_SESSION_SECRET: 'curto', ENCRYPTION_MASTER_KEY: 'bm9wZQ==' };
  const r1 = await pf.preflight(curto, { banco: false });
  assert.equal(achar(r1, 'env', 'ADMIN_SESSION_SECRET')[0].status, pf.BLOCK);
  assert.equal(achar(r1, 'env', 'ENCRYPTION_MASTER_KEY')[0].status, pf.BLOCK);
  assert.equal(r1.exit, 1);

  const semRef = envCompleto();
  delete semRef.WHATSAPP_SENDER_REF_SECRET;
  assert.equal(achar(await pf.preflight(semRef, { banco: false }), 'env', 'WHATSAPP_SENDER_REF_SECRET')[0].status, pf.BLOCK,
    'com WHATSAPP_SERVICE_URL, o segredo da referência é obrigatório');

  const flag = { ...envCompleto(), ALLOW_LEGACY_ADMIN_PASSWORD: '1', ALLOW_LEGACY_INTEGRATION_ENV: 'sim' };
  const n = await pf.preflight(flag, { banco: false });
  assert.equal(achar(n, 'flags', 'ALLOW_LEGACY_ADMIN_PASSWORD')[0].status, pf.WARN);
  assert.equal(achar(n, 'flags', 'ALLOW_LEGACY_INTEGRATION_ENV')[0].status, pf.BLOCK, 'valor diferente de 1/0');
  const limpeza = await pf.preflight({ ...flag, ALLOW_LEGACY_INTEGRATION_ENV: '0', DB_ENFORCE_APP_ROLE: '1' }, { banco: false, estagio: 'cleanup' });
  assert.equal(achar(limpeza, 'flags', 'ALLOW_LEGACY_ADMIN_PASSWORD')[0].status, pf.BLOCK);
  assert.equal(achar(limpeza, 'legado', 'INK_WEBHOOK_SECRET_SUL')[0].status, pf.BLOCK);
  assert.equal(achar(limpeza, 'legado', 'ADMIN_PASSWORD')[0].status, pf.BLOCK);

  const go = await pf.preflight({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/g', API_KEY: 'x', META_APP_ID: '1', META_APP_SECRET: 'y',
    PANEL_SENDER_RESOLVER_URL: 'http://painel', PANEL_SENDER_RESOLVER_KEY: 'k'.repeat(40), META_GRAPH_BASE_URL: 'http://mock', REPLY_REDIRECT_SUL: 'x' },
  { banco: false, servico: 'go' });
  assert.equal(achar(go, 'env', 'PANEL_SENDER_RESOLVER_URL')[0].status, pf.BLOCK, 'resolver sem https');
  assert.equal(achar(go, 'legado', 'META_GRAPH_BASE_URL')[0].status, pf.BLOCK, 'OPS-35');
  assert.equal(achar(go, 'legado', 'REPLY_REDIRECT_SUL')[0].status, pf.WARN);
});

test('preflight · role de migration: ausente ou igual à do app bloqueia depois do OPS-14', async () => {
  const env = { ...envCompleto(), DB_ENFORCE_APP_ROLE: '1' };
  const ok = await pf.preflight(env, { banco: false, estagio: 'after-ops14' });
  assert.deepEqual(ok.itens.filter((i) => i.status === pf.BLOCK), []);

  const igual = { ...env, MIGRATION_DATABASE_URL: env.DATABASE_URL.replace(/:[^:@]+@/, ':outra@') };
  const r = await pf.preflight(igual, { banco: false, estagio: 'after-ops14' });
  assert.ok(achar(r, 'roles', 'MIGRATION_DATABASE_URL').some((i) => i.status === pf.BLOCK && /usuário distinto do app: NÃO/.test(i.texto)));

  const sem = { ...env };
  delete sem.MIGRATION_DATABASE_URL;
  const r2 = await pf.preflight(sem, { banco: false, estagio: 'after-ops14' });
  assert.ok(achar(r2, 'roles', 'MIGRATION_DATABASE_URL').some((i) => i.status === pf.BLOCK));
  assert.equal(achar(await pf.preflight(sem, { banco: false }), 'roles', 'MIGRATION_DATABASE_URL')[0].status, pf.INFO, 'antes do OPS-14 é esperado');

  const semFlag = { ...env };
  delete semFlag.DB_ENFORCE_APP_ROLE;
  assert.equal(achar(await pf.preflight(semFlag, { banco: false, estagio: 'after-ops14' }), 'env', 'DB_ENFORCE_APP_ROLE')[0].status, pf.BLOCK);
});

test('preflight · mapeamento inválido ou incompleto bloqueia sem mostrar conteúdo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-preflight-map-'));
  const quebrado = path.join(dir, 'quebrado.json');
  fs.writeFileSync(quebrado, '{ nao e json');
  const r1 = await pf.preflight({ ...envCompleto(), TENANCY_MAPPING_FILE: quebrado }, { banco: false });
  assert.equal(achar(r1, 'mapping', 'quebrado.json')[0].status, pf.BLOCK);

  const incompleto = path.join(dir, 'incompleto.json');
  const m = JSON.parse(fs.readFileSync(CENARIO_A, 'utf8'));
  m.mapeamentos = m.mapeamentos.slice(1);
  fs.writeFileSync(incompleto, JSON.stringify(m));
  const r2 = await pf.preflight({ ...envCompleto(), TENANCY_MAPPING_FILE: incompleto }, { banco: false });
  assert.equal(achar(r2, 'mapping', 'incompleto.json')[0].status, pf.BLOCK);

  const r3 = await pf.preflight({ ...envCompleto(), TENANCY_MAPPING_FILE: path.join(dir, 'nao-existe.json') }, { banco: false });
  assert.equal(achar(r3, 'mapping', 'TENANCY_MAPPING_FILE')[0].status, pf.BLOCK);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('preflight · banco real: schema em dia, contrato da role, e nada é escrito', async () => {
  const dono = h.urlDoBanco();
  const app = process.env.INVARIANTS_APP_DATABASE_URL;
  assert.ok(app, 'INVARIANTS_APP_DATABASE_URL ausente — rode pelo scripts/test-db.mjs');
  const sup = h.abrirPoolDescartavel(dono, { max: 1 });
  try {
    const antes = (await sup.query('SELECT count(*)::int AS n, max(run_on) AS m FROM pgmigrations')).rows[0];

    const envPre = { ...envCompleto(), DATABASE_URL: dono };
    delete envPre.MIGRATION_DATABASE_URL;
    const pre = await pf.preflight(envPre, {});
    assert.equal(achar(pre, 'schema', 'postgres')[0].status, pf.OK);
    assert.match(achar(pre, 'schema', 'DATABASE_URL')[0].texto, /· 0 pendentes no repositório$/);
    assert.equal(achar(pre, 'schema', 'MIGRATION_MINIMA')[0].status, pf.OK);
    // Antes do OPS-14 o app ainda é a dona: informado, não bloqueado.
    const rolePre = achar(pre, 'roles', 'DATABASE_URL')[0];
    assert.deepEqual([rolePre.status, /NÃO cumpre/.test(rolePre.texto)], [pf.INFO, true]);

    const envPos = { ...envCompleto(), DATABASE_URL: app, MIGRATION_DATABASE_URL: dono, DB_ENFORCE_APP_ROLE: '1' };
    const pos = await pf.preflight(envPos, { estagio: 'after-ops14' });
    assert.equal(achar(pos, 'roles', 'DATABASE_URL')[0].status, pf.OK);
    assert.equal(achar(pos, 'schema', 'MIGRATION_DATABASE_URL')[0].status, pf.INFO);

    // Controle negativo: a mesma checagem, com a dona no lugar do app depois do OPS-14, bloqueia.
    const errado = await pf.preflight({ ...envPos, DATABASE_URL: dono }, { estagio: 'after-ops14' });
    assert.equal(achar(errado, 'roles', 'DATABASE_URL')[0].status, pf.BLOCK);

    // Migration no banco que o repositório não conhece = release atrás do schema.
    await sup.query("INSERT INTO pgmigrations (name, run_on) VALUES ('9999999999999_futura', now())");
    try {
      const futuro = await pf.preflight(envPre, {});
      assert.equal(achar(futuro, 'schema', '9999999999999_futura')[0].status, pf.BLOCK);
    } finally {
      await sup.query("DELETE FROM pgmigrations WHERE name = '9999999999999_futura'");
    }

    const depois = (await sup.query('SELECT count(*)::int AS n, max(run_on) AS m FROM pgmigrations')).rows[0];
    assert.deepEqual(depois, antes);

    for (const r of [pre, pos, errado]) {
      const texto = JSON.stringify(r) + pf.formatar(r);
      for (const url of [dono, app]) {
        const u = new URL(url);
        assert.ok(!texto.includes(decodeURIComponent(u.password)), 'senha do banco no relatório');
        assert.ok(!texto.includes(url), 'URL do banco no relatório');
      }
    }
  } finally {
    await sup.end();
  }
});

test('preflight CLI · nenhum segredo no texto nem no JSON, inclusive com erro de conexão', () => {
  const env = envCompleto();
  const texto = rodar(SCRIPT, env);
  assert.equal(texto.status, 1, texto.saida);
  assert.match(texto.saida, /conexão\/consulta falhou \(ECONNREFUSED\)/);
  assert.deepEqual(vazados(texto.saida, env), []);
  const json = rodar(SCRIPT, env, ['--json']);
  assert.deepEqual(vazados(json.saida, env), []);
  assert.equal(JSON.parse(json.stdout).exit, 1);

  const go = { DATABASE_URL: `postgres://gouser:${marcador('gosenha')}@127.0.0.1:1/go`, API_KEY: marcador('goapikey'),
    META_APP_ID: '123', META_APP_SECRET: marcador('appsecret'), PANEL_SENDER_RESOLVER_URL: `https://${marcador('painel')}.interno`,
    PANEL_SENDER_RESOLVER_KEY: marcador('goresolver'), META_ACCESS_TOKEN: `EAAG${marcador('tok')}` };
  const r = rodar(SCRIPT, go, ['--service', 'go']);
  assert.deepEqual(vazados(r.saida, go), []);
  assert.match(r.saida, /META_ACCESS_TOKEN/);
});

test('preflight CLI · uso inválido sai 64', () => {
  const limpo = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const args of [['--stage', 'producao'], ['--service', 'python'], ['--qualquer'], ['--from-env-file', '/nao/existe']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: limpo });
    assert.equal(r.status, 64, args.join(' '));
  }
});

test('preflight · negative control: cópia que imprime valor é pega pelo detector (5 passos)', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-preflight-nc-'));
  try {
    fs.mkdirSync(path.join(raiz, 'scripts', 'release'), { recursive: true });
    for (const x of ['lib', 'migrations', 'node_modules', 'package.json', 'server.js']) {
      fs.symlinkSync(path.join(h.RAIZ_REPO, x), path.join(raiz, x));
    }
    for (const x of ['tenancy', 'tenant1', 'integrations', 'auth']) fs.symlinkSync(path.join(h.RAIZ_REPO, 'scripts', x), path.join(raiz, 'scripts', x));
    const copia = path.join(raiz, 'scripts', 'release', 'preflight.mjs');
    const original = fs.readFileSync(SCRIPT, 'utf8');
    fs.writeFileSync(copia, original);
    const env = envCompleto();

    const passo1 = rodar(copia, env, ['--no-db']);
    assert.match(passo1.saida, /RELEASE PREFLIGHT/);
    assert.deepEqual(vazados(passo1.saida, env), [], '[1]');

    const de = "itens.push(item(atende ? OK : BLOCK, 'env', v.nome, `presente · ${v.descricao}: ${atende ? 'sim' : 'NÃO'}${ref}`));";
    assert.equal(original.split(de).length - 1, 1, 'trecho da violação não encontrado');
    fs.writeFileSync(copia, original.replace(de, "itens.push(item(atende ? OK : BLOCK, 'env', v.nome, `presente · ${env[v.nome]}${ref}`));"));
    const passo3 = rodar(copia, env, ['--no-db']);
    assert.ok(vazados(passo3.saida, env).length >= 3, `[3] o detector não pegou o vazamento:\n${passo3.saida}`);

    fs.writeFileSync(copia, original);
    const passo5 = rodar(copia, env, ['--no-db']);
    assert.deepEqual(vazados(passo5.saida, env), [], '[5]');
    assert.equal(passo5.saida, passo1.saida);
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});

// Consolidação da rodada 18: variáveis das trilhas B (segundo tenant) e C (repasse assinado).
test('preflight · rodada 18: repasse assinado e segundo tenant desligado', async () => {
  const semSegredo = envCompleto();
  delete semSegredo.WHATSAPP_WEBHOOK_SECRET;
  assert.equal(achar(await pf.preflight(semSegredo, { banco: false }), 'env', 'WHATSAPP_WEBHOOK_SECRET')[0].status, pf.BLOCK,
    'com WHATSAPP_SERVICE_URL, o painel precisa do segredo do repasse');

  // Rodada 19 (§4): o boot de produção exige o segredo mesmo sem WHATSAPP_SERVICE_URL; o preflight
  // acompanha em todos os estágios, e curto também bloqueia.
  const semServico = envCompleto();
  delete semServico.WHATSAPP_WEBHOOK_SECRET;
  delete semServico.WHATSAPP_SERVICE_URL;
  for (const estagio of ['release-n', 'after-ops14', 'cleanup']) {
    const r = await pf.preflight(semServico, { banco: false, estagio });
    assert.equal(achar(r, 'env', 'WHATSAPP_WEBHOOK_SECRET')[0].status, pf.BLOCK, `sem WHATSAPP_SERVICE_URL, estágio ${estagio}`);
  }
  const curtoPainel = await pf.preflight({ ...envCompleto(), WHATSAPP_WEBHOOK_SECRET: 'x'.repeat(31) }, { banco: false });
  assert.equal(achar(curtoPainel, 'env', 'WHATSAPP_WEBHOOK_SECRET')[0].status, pf.BLOCK, 'segredo com 31 caracteres');
  assert.equal(achar(await pf.preflight(envCompleto(), { banco: false }), 'env', 'WHATSAPP_WEBHOOK_SECRET')[0].status, pf.OK);

  const env = envCompleto();
  for (const valor of ['', '0', 'false']) {
    const r = await pf.preflight({ ...env, SECOND_TENANT_ENABLED: valor }, { banco: false });
    assert.equal(achar(r, 'flags', 'SECOND_TENANT_ENABLED')[0].status, pf.OK, `valor ${JSON.stringify(valor)}`);
  }
  for (const valor of ['1', 'true', 'sim']) {
    for (const estagio of ['release-n', 'after-ops14', 'cleanup']) {
      const r = await pf.preflight({ ...env, SECOND_TENANT_ENABLED: valor }, { banco: false, estagio });
      assert.equal(achar(r, 'flags', 'SECOND_TENANT_ENABLED')[0].status, pf.BLOCK, `${valor} em ${estagio}`);
    }
  }

  const segredoGo = marcador('fwd');
  const go = {
    DATABASE_URL: 'postgres://u:p@127.0.0.1:1/go', API_KEY: marcador('apikeygo'), META_APP_ID: '123', META_APP_SECRET: marcador('app'),
    PANEL_SENDER_RESOLVER_URL: 'https://painel.interno/api/internal/whatsapp/sender', PANEL_SENDER_RESOLVER_KEY: marcador('resolvergo'),
    WEBHOOK_FORWARD_URL: 'https://painel.interno/api/webhooks/whatsapp', WEBHOOK_FORWARD_SECRET: segredoGo,
  };
  const ok = await pf.preflight(go, { servico: 'go', banco: false });
  assert.equal(achar(ok, 'env', 'WEBHOOK_FORWARD_URL')[0].status, pf.OK);
  assert.equal(achar(ok, 'env', 'WEBHOOK_FORWARD_SECRET')[0].status, pf.OK);
  assert.ok(!JSON.stringify(ok).includes(segredoGo));

  for (const url of [`https://painel.interno/api/webhooks/whatsapp?secret=${segredoGo}`, 'http://painel.interno/api/webhooks/whatsapp',
    'https://u:p@painel.interno/api/webhooks/whatsapp', 'https://painel.interno/x#f', 'nao-e-url']) {
    const r = await pf.preflight({ ...go, WEBHOOK_FORWARD_URL: url }, { servico: 'go', banco: false });
    assert.equal(achar(r, 'env', 'WEBHOOK_FORWARD_URL')[0].status, pf.BLOCK, url.replace(segredoGo, '<segredo>'));
    assert.ok(!JSON.stringify(r).includes(segredoGo), 'a URL recusada não é repetida');
  }
  const semSegredoGo = { ...go };
  delete semSegredoGo.WEBHOOK_FORWARD_SECRET;
  assert.equal(achar(await pf.preflight(semSegredoGo, { servico: 'go', banco: false }), 'env', 'WEBHOOK_FORWARD_SECRET')[0].status, pf.BLOCK);
  const curto = await pf.preflight({ ...go, WEBHOOK_FORWARD_SECRET: 'curto' }, { servico: 'go', banco: false });
  assert.equal(achar(curto, 'env', 'WEBHOOK_FORWARD_SECRET')[0].status, pf.BLOCK);
});

// Rodada 19 (§9): o seed de entitlements do rollout é um PERFIL de dados validado contra o registry.
test('preflight · rodada 19: perfil de entitlements obrigatório e validado', async () => {
  const ok = await pf.preflight(envCompleto(), { banco: false });
  const [perfil] = achar(ok, 'entitlements', 'tenant1-entitlements.json');
  assert.equal(perfil.status, pf.OK);
  assert.match(perfil.texto, /perfil tenant1-operacao-interna válido · ON: creative_generator, .*whatsapp/);
  assert.ok(!/instagram|advancedAutomations/.test(perfil.texto));

  const semPerfil = envCompleto();
  delete semPerfil.ENTITLEMENTS_SEED_PROFILE;
  const r1 = await pf.preflight(semPerfil, { banco: false });
  assert.equal(achar(r1, 'env', 'ENTITLEMENTS_SEED_PROFILE')[0].status, pf.BLOCK);
  assert.match(achar(r1, 'entitlements', 'ENTITLEMENTS_SEED_FEATURES')[0].texto, /sem ENTITLEMENTS_SEED_PROFILE/);
  assert.equal(r1.exit, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-preflight-perfil-'));
  try {
    const base = JSON.parse(fs.readFileSync(PERFIL_TENANT1, 'utf8'));
    const casos = {
      'em-breve.json': { ...base, features: [...base.features, 'instagram'] },
      'desconhecida.json': { ...base, features: [...base.features, 'nao_existe'] },
      'curinga.json': { ...base, features: ['*'] },
      'all.json': { ...base, all: true },
      'objeto.json': { ...base, features: { whatsapp: true } },
    };
    for (const [nome, conteudo] of Object.entries(casos)) {
      const arq = path.join(dir, nome);
      fs.writeFileSync(arq, JSON.stringify(conteudo));
      const r = await pf.preflight({ ...envCompleto(), ENTITLEMENTS_SEED_PROFILE: arq }, { banco: false });
      assert.equal(achar(r, 'entitlements', nome)[0].status, pf.BLOCK, nome);
      assert.equal(r.exit, 1, nome);
    }
    const r = await pf.preflight({ ...envCompleto(), ENTITLEMENTS_SEED_PROFILE: path.join(dir, 'nao-existe.json') }, { banco: false });
    assert.equal(achar(r, 'entitlements', 'nao-existe.json')[0].status, pf.BLOCK);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// RELEASE B = 31a7cdb: o seed publicado só lê ENTITLEMENTS_SEED_FEATURES. O preflight do HEAD exige a
// lista EXATA do perfil nesse estágio e imprime o valor esperado.
function assertListaDaReleaseB(modulo, env) {
  const achou = (r, nome) => r.itens.filter((i) => i.secao === 'entitlements' && i.nome === nome);
  return (async () => {
    const igual = await modulo.preflight(env(), { banco: false });
    assert.equal(achou(igual, 'ENTITLEMENTS_SEED_FEATURES')[0].status, modulo.OK);
    assert.equal(igual.exit, 0);
    const reordenada = await modulo.preflight({ ...env(), ENTITLEMENTS_SEED_FEATURES: LISTA_TENANT1.split(',').reverse().join(', ') }, { banco: false });
    assert.equal(achou(reordenada, 'ENTITLEMENTS_SEED_FEATURES')[0].status, modulo.OK, 'ordem não importa');

    const divergentes = {
      'a mais': `${LISTA_TENANT1},instagram`,
      faltando: LISTA_TENANT1.split(',').slice(1).join(','),
      repetida: `${LISTA_TENANT1},financial`,
      curinga: '*',
      trocada: LISTA_TENANT1.replace('financial', 'advancedAutomations'),
    };
    for (const [caso, valor] of Object.entries(divergentes)) {
      for (const estagio of ['release-n', 'after-ops14', 'cleanup']) {
        const r = await modulo.preflight({ ...env(), ENTITLEMENTS_SEED_FEATURES: valor, DB_ENFORCE_APP_ROLE: '1' }, { banco: false, estagio });
        const [it] = achou(r, 'ENTITLEMENTS_SEED_FEATURES');
        assert.equal(it.status, modulo.BLOCK, `${caso} em ${estagio}`);
        assert.ok(it.texto.includes(`valor esperado (igual ao perfil): ${[...LISTA_TENANT1.split(',')].sort().join(',')}`), it.texto);
        assert.equal(r.exit, 1);
      }
    }
    const semLista = env();
    delete semLista.ENTITLEMENTS_SEED_FEATURES;
    const [ausente] = achou(await modulo.preflight(semLista, { banco: false }), 'ENTITLEMENTS_SEED_FEATURES');
    assert.equal(ausente.status, modulo.BLOCK, 'a RELEASE B precisa da lista');
    assert.match(ausente.texto, /só lê esta variável; valor esperado \(igual ao perfil\): creative_generator,/);
  })();
}

test('preflight · rodada 19: RELEASE B lê a lista antiga — só vale igual ao perfil; depois sai', async () => {
  await assertListaDaReleaseB(pf, envCompleto);
  const env = { ...envCompleto(), DB_ENFORCE_APP_ROLE: '1' };
  const depois = await pf.preflight(env, { banco: false, estagio: 'after-ops14' });
  assert.equal(achar(depois, 'entitlements', 'ENTITLEMENTS_SEED_FEATURES')[0].status, pf.WARN);
  const semLista = { ...env };
  delete semLista.ENTITLEMENTS_SEED_FEATURES;
  assert.deepEqual(achar(await pf.preflight(semLista, { banco: false, estagio: 'after-ops14' }), 'entitlements', 'ENTITLEMENTS_SEED_FEATURES'), []);
  const limpeza = await pf.preflight(env, { banco: false, estagio: 'cleanup' });
  assert.equal(achar(limpeza, 'entitlements', 'ENTITLEMENTS_SEED_FEATURES')[0].status, pf.BLOCK);
});

test('preflight · rodada 19: negative control — preflight que aceita lista divergente do perfil reprova (5 passos)', async () => {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-preflight-nc-lista-')));
  try {
    fs.mkdirSync(path.join(raiz, 'scripts', 'release'), { recursive: true });
    for (const x of ['lib', 'migrations', 'node_modules', 'package.json', 'server.js']) fs.symlinkSync(path.join(h.RAIZ_REPO, x), path.join(raiz, x));
    for (const x of fs.readdirSync(path.join(h.RAIZ_REPO, 'scripts'))) {
      if (x !== 'release') fs.symlinkSync(path.join(h.RAIZ_REPO, 'scripts', x), path.join(raiz, 'scripts', x));
    }
    const original = fs.readFileSync(SCRIPT, 'utf8');
    const de = '      } else if (!c.iguais) {';
    assert.equal(original.split(de).length - 1, 1, 'trecho da violação não encontrado');
    const passar = async (conteudo, passo) => {
      const copia = path.join(raiz, 'scripts', 'release', 'preflight.mjs');
      fs.writeFileSync(copia, conteudo);
      const mod = await import(`${pathToFileURL(copia).href}?passo=${passo}`);
      try {
        await assertListaDaReleaseB(mod, envCompleto);
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(await passar(original, 1), true, '[1]');
    assert.equal(await passar(original.replace(de, '      } else if (false) { // VIOLAÇÃO DELIBERADA (negative control)'), 3), false, '[3] lista divergente passou');
    assert.equal(await passar(original, 5), true, '[5]');
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});

// Rodada 19 (§1): o rollout mira o cenário B de PD-019; um mapeamento válido de A bloqueia.
test('preflight · rodada 19: mapeamento fora do cenário B (alvo de rollout) bloqueia', async () => {
  const b = await pf.preflight(envCompleto(), { banco: false });
  assert.match(achar(b, 'rollout', 'PD-019')[0].texto, /cenário B \(alvo de rollout\)/);
  const a = await pf.preflight({ ...envCompleto(), TENANCY_MAPPING_FILE: CENARIO_A }, { banco: false });
  assert.equal(achar(a, 'mapping', 'cenario-a.json')[0].status, pf.OK, 'A continua sendo um mapeamento válido');
  const [alvo] = achar(a, 'rollout', 'PD-019');
  assert.equal(alvo.status, pf.BLOCK);
  assert.match(alvo.texto, /não é o cenário B .* 3 Organization\(s\)/);
  assert.ok(!alvo.texto.includes('a1000000'), 'sem conteúdo do mapeamento');
  assert.equal(a.exit, 1);
  const semArquivo = envCompleto();
  delete semArquivo.TENANCY_MAPPING_FILE;
  assert.deepEqual(achar(await pf.preflight(semArquivo, { banco: false }), 'rollout', 'PD-019'), []);
});

// Rodada 19 (§5): flags da transição do repasse sem perda de status — WARN antes, BLOCK no CLEANUP.
test('preflight · rodada 19: flags de transição do repasse permitidas só antes do cleanup', async () => {
  const painel = envCompleto();
  for (const estagio of ['release-n', 'after-ops14']) {
    const r = await pf.preflight({ ...painel, WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED: '1' }, { banco: false, estagio });
    assert.equal(achar(r, 'flags', 'WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED')[0].status, pf.WARN, estagio);
  }
  const limpeza = await pf.preflight({ ...painel, WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED: '1' }, { banco: false, estagio: 'cleanup' });
  assert.equal(achar(limpeza, 'flags', 'WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED')[0].status, pf.BLOCK);
  const invalida = await pf.preflight({ ...painel, WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED: 'true' }, { banco: false });
  assert.equal(achar(invalida, 'flags', 'WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED')[0].status, pf.BLOCK, 'valor diferente de 1/0');
  for (const valor of [undefined, '0']) {
    const r = await pf.preflight({ ...painel, WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED: valor }, { banco: false, estagio: 'cleanup' });
    assert.equal(achar(r, 'flags', 'WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED')[0].status, pf.OK, String(valor));
  }

  const segredoGo = marcador('fwd');
  const legado = marcador('legado');
  const go = {
    DATABASE_URL: 'postgres://u:p@127.0.0.1:1/go', API_KEY: marcador('apikeygo'), META_APP_ID: '123', META_APP_SECRET: marcador('app'),
    PANEL_SENDER_RESOLVER_URL: 'https://painel.interno/api/internal/whatsapp/sender', PANEL_SENDER_RESOLVER_KEY: marcador('resolvergo'),
    WEBHOOK_FORWARD_URL: `https://painel.interno/api/webhooks/whatsapp?secret=${legado}`, WEBHOOK_FORWARD_SECRET: segredoGo,
  };
  const status = async (env, estagio = 'release-n') => {
    const r = await pf.preflight(env, { servico: 'go', banco: false, estagio });
    const texto = JSON.stringify(r);
    assert.ok(!texto.includes(legado) && !texto.includes(segredoGo), 'preflight repetiu a URL ou o segredo');
    return {
      url: achar(r, 'env', 'WEBHOOK_FORWARD_URL')[0].status,
      flag: achar(r, 'flags', 'WEBHOOK_FORWARD_LEGACY_QUERY_SECRET')[0].status,
      aviso: achar(r, 'flags', 'WEBHOOK_FORWARD_URL').map((i) => i.status),
    };
  };
  // Sem a flag, a URL legada continua bloqueada (rodada 18).
  assert.deepEqual(await status(go), { url: pf.BLOCK, flag: pf.OK, aviso: [] });
  // Com a flag, antes do cleanup: URL legada atende, flag e URL com WARN.
  for (const estagio of ['release-n', 'after-ops14']) {
    assert.deepEqual(await status({ ...go, WEBHOOK_FORWARD_LEGACY_QUERY_SECRET: '1' }, estagio), { url: pf.OK, flag: pf.WARN, aviso: [pf.WARN] }, estagio);
  }
  // No cleanup: a flag e a URL legada bloqueiam.
  assert.deepEqual(await status({ ...go, WEBHOOK_FORWARD_LEGACY_QUERY_SECRET: '1' }, 'cleanup'), { url: pf.BLOCK, flag: pf.BLOCK, aviso: [] });
  // A flag não abre outra query, credencial, http nem o mesmo valor da assinatura na URL.
  for (const url of [
    `https://painel.interno/api/webhooks/whatsapp?secret=${legado}&x=1`,
    `https://painel.interno/api/webhooks/whatsapp?token=${legado}`,
    'https://painel.interno/api/webhooks/whatsapp?secret=',
    `http://painel.interno/api/webhooks/whatsapp?secret=${legado}`,
    `https://u:${legado}@painel.interno/api/webhooks/whatsapp?secret=${legado}`,
    `https://painel.interno/api/webhooks/whatsapp?secret=${segredoGo}`,
  ]) {
    const s = await status({ ...go, WEBHOOK_FORWARD_URL: url, WEBHOOK_FORWARD_LEGACY_QUERY_SECRET: '1' });
    assert.equal(s.url, pf.BLOCK, url.replaceAll(legado, '<legado>').replaceAll(segredoGo, '<segredo>'));
  }
  // Flag ligada com a URL já limpa: WARN para desligar; flag inválida bloqueia.
  const limpa = { ...go, WEBHOOK_FORWARD_URL: 'https://painel.interno/api/webhooks/whatsapp', WEBHOOK_FORWARD_LEGACY_QUERY_SECRET: '1' };
  assert.deepEqual(await status(limpa), { url: pf.OK, flag: pf.WARN, aviso: [pf.WARN] });
  assert.equal((await status({ ...go, WEBHOOK_FORWARD_LEGACY_QUERY_SECRET: 'true' })).flag, pf.BLOCK);
});

test('preflight · rodada 19: --legacy-forward-panel (RELEASE D0) aceita o segredo legado curto, só no painel', async () => {
  const legado = { ...envCompleto(), WHATSAPP_WEBHOOK_SECRET: marcador('l').slice(0, 12) };
  const padrao = await pf.preflight(legado, { banco: false });
  assert.equal(achar(padrao, 'env', 'WHATSAPP_WEBHOOK_SECRET')[0].status, pf.BLOCK, 'sem a opção, o painel novo exige ≥ 32');
  const d0 = await pf.preflight(legado, { banco: false, repasseLegado: true });
  assert.equal(achar(d0, 'env', 'WHATSAPP_WEBHOOK_SECRET')[0].status, pf.OK);
  assert.equal(d0.exit, 0);
  assert.deepEqual(vazados(JSON.stringify(d0), legado), []);
  const semSegredo = envCompleto();
  delete semSegredo.WHATSAPP_WEBHOOK_SECRET;
  assert.equal(achar(await pf.preflight(semSegredo, { banco: false, repasseLegado: true }), 'env', 'WHATSAPP_WEBHOOK_SECRET')[0].status, pf.WARN);
  await assert.rejects(pf.preflight(legado, { banco: false, repasseLegado: true, estagio: 'cleanup' }), /só para o painel/);
  await assert.rejects(pf.preflight(legado, { banco: false, repasseLegado: true, servico: 'go' }), /só para o painel/);

  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-pf-r19-')), 'env');
  try {
    fs.writeFileSync(arq, Object.entries(legado).map(([k, v]) => `${k}=${v}`).join('\n'));
    const r = spawnSync(process.execPath, [SCRIPT, '--from-env-file', arq, '--no-db', '--legacy-forward-panel'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /painel D0 \(repasse legado\)/);
    assert.deepEqual(vazados(r.stdout + r.stderr, legado), []);
    const uso = spawnSync(process.execPath, [SCRIPT, '--from-env-file', arq, '--no-db', '--legacy-forward-panel', '--service', 'go'], { encoding: 'utf8' });
    assert.equal(uso.status, 64);
  } finally {
    fs.rmSync(path.dirname(arq), { recursive: true, force: true });
  }
});

test('preflight · rodada 19: leitura dupla dos criativos (OPS-22) só na transição, coerente com o mapeamento', async () => {
  // Organization dona do creative_tenant no mapeamento do envCompleto (cenário B, alvo de rollout).
  const ORG = 'b1000000-0000-4000-8000-000000000001';
  const OUTRA = 'b1000000-0000-4000-8000-000000000002';
  const nome = 'CREATIVE_LEGACY_READ_*';
  const desligada = await pf.preflight(envCompleto(), { banco: false });
  assert.equal(achar(desligada, 'flags', nome)[0].status, pf.OK);

  const env = { ...envCompleto(), CREATIVE_LEGACY_READ_FROM: 'default', CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG };
  for (const estagio of ['release-n', 'after-ops14']) {
    const r = await pf.preflight({ ...env, DB_ENFORCE_APP_ROLE: '1' }, { banco: false, estagio });
    assert.equal(achar(r, 'flags', nome)[0].status, pf.WARN, estagio);
    assert.deepEqual(achar(r, 'flags', 'CREATIVE_LEGACY_READ_ORGANIZATION_ID').map((i) => i.status), [pf.OK], estagio);
    assert.deepEqual(achar(r, 'flags', 'CREATIVE_LEGACY_READ_FROM'), [], estagio);
    assert.deepEqual(vazados(JSON.stringify(r), env), []);
    assert.ok(!JSON.stringify(r).includes(ORG), 'o id não é impresso');
  }
  assert.equal(achar(await pf.preflight({ ...envCompleto(), CREATIVE_LEGACY_READ_FROM: 'default', CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG }, { banco: false }), 'flags', nome)[0].status, pf.WARN);
  const limpeza = await pf.preflight({ ...env, DB_ENFORCE_APP_ROLE: '1' }, { banco: false, estagio: 'cleanup' });
  assert.equal(achar(limpeza, 'flags', nome)[0].status, pf.BLOCK, 'cleanup exige a leitura dupla removida');
  assert.equal(limpeza.exit, 1);

  const ruins = [
    { CREATIVE_LEGACY_READ_FROM: 'default' },
    { CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG },
    { CREATIVE_LEGACY_READ_FROM: OUTRA, CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG },
    { CREATIVE_LEGACY_READ_FROM: '../default', CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG },
  ];
  for (const extra of ruins) {
    const r = await pf.preflight({ ...envCompleto(), ...extra }, { banco: false });
    assert.equal(achar(r, 'flags', nome)[0].status, pf.BLOCK, JSON.stringify(extra));
  }
  // Organization que não é a dona do tenant legado no mapeamento, ou tenant legado diferente do da instalação.
  const outraOrg = await pf.preflight({ ...env, CREATIVE_LEGACY_READ_ORGANIZATION_ID: OUTRA }, { banco: false });
  assert.equal(achar(outraOrg, 'flags', 'CREATIVE_LEGACY_READ_ORGANIZATION_ID')[0].status, pf.BLOCK);
  assert.equal(outraOrg.exit, 1);
  const outroTenant = await pf.preflight({ ...env, CREATIVE_TENANT_ID: 'loja-antiga' }, { banco: false });
  assert.equal(achar(outroTenant, 'flags', 'CREATIVE_LEGACY_READ_FROM')[0].status, pf.BLOCK);

  // Serviço Go: não se aplica.
  assert.deepEqual(pf.checarLeituraLegadaCriativos(env, { servico: 'go', estagio: 'release-n' }), []);
});
