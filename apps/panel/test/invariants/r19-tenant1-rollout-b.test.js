'use strict';

// Rodada 19 · §1 — rollout alvo = PD-019 cenário B (Organization "Use Origens" + Store "Use Origens").
//
//   - os templates versionados (config/tenant1/*.template.json) não passam sem preencher os
//     placeholders — nenhum valor real mora no repositório;
//   - preenchidos (aqui com os ids do ensaio), o arquivo de rollout tem a MESMA forma de mapeamento
//     que o ensaio B e roda preflight → plan → apply → verify com --rollout, usando o perfil de
//     entitlements e o bloco whatsapp explícito;
//   - rollout: true exige --rollout, cenário B, whatsapp declarado e perfil; cenário A continua
//     suportado só como ensaio (rollout: false).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const e = require('../helpers/tenant1-ensaio');

const TEMPLATES = path.join(h.RAIZ_REPO, 'config', 'tenant1');
const TEMPLATE_ROLLOUT = path.join(TEMPLATES, 'rollout-scenario-b.template.json');
const TEMPLATE_MAPA = path.join(TEMPLATES, 'tenancy-scenario-b.template.json');
const PERFIL = path.join(h.RAIZ_REPO, 'config', 'entitlements', 'tenant1-entitlements.json');

const B = 'b1000000-0000-4000-8000-000000000001';
// Valores do ENSAIO (os mesmos de test/fixtures/tenancy/cenario-b.json e do ambiente do helper).
const VALORES_DO_ENSAIO = Object.freeze({
  '<ORGANIZATION_ID_USE_ORIGENS>': B,
  '<STORE_ID_USE_ORIGENS>': 'b2000000-0000-4000-8000-000000000001',
  '<CREATIVE_TENANT_ID_ATUAL>': 'default',
  '<EMAIL_DO_OWNER_USE_ORIGENS>': 'operacao@ensaio.oria',
  '<WABA_ID_ATUAL>': '1200000000009',
  '<PHONE_NUMBER_ID_ATUAL>': '5511900000009',
});

const importar = (arquivo) => import(pathToFileURL(arquivo).href);
const statusDe = (r, id) => e.itensDe(r.linhas).filter((i) => i.id === id).map((i) => i.status);
const placeholders = (texto) => [...new Set(texto.match(/<[A-Z0-9_]+>/g) || [])].sort();

function preencher(texto, valores) {
  let s = texto;
  for (const [k, v] of Object.entries(valores)) s = s.split(k).join(v);
  return s;
}

// Monta config/tenant1 + config/entitlements num diretório temporário, como o operador faria.
function montarConfig(t, valores = VALORES_DO_ENSAIO, mudar = (x) => x) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-r19h-rollout-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const dirT1 = path.join(raiz, 'config', 'tenant1');
  const dirEnt = path.join(raiz, 'config', 'entitlements');
  fs.mkdirSync(dirT1, { recursive: true });
  fs.mkdirSync(dirEnt, { recursive: true });
  fs.copyFileSync(PERFIL, path.join(dirEnt, 'tenant1-entitlements.json'));
  const mapa = path.join(dirT1, 'tenancy-scenario-b.json');
  fs.writeFileSync(mapa, preencher(fs.readFileSync(TEMPLATE_MAPA, 'utf8'), valores));
  const rollout = path.join(dirT1, 'rollout-scenario-b.json');
  const json = mudar(JSON.parse(preencher(fs.readFileSync(TEMPLATE_ROLLOUT, 'utf8'), valores)));
  fs.writeFileSync(rollout, JSON.stringify(json, null, 2));
  return { raiz, mapa, rollout };
}

test('r19 §1 · templates: só placeholders documentados; sem preencher, reprovam', async () => {
  const c = await importar(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'config.mjs'));
  const textoRollout = fs.readFileSync(TEMPLATE_ROLLOUT, 'utf8');
  const textoMapa = fs.readFileSync(TEMPLATE_MAPA, 'utf8');
  assert.deepEqual(placeholders(`${textoRollout}${textoMapa}`), Object.keys(VALORES_DO_ENSAIO).sort());
  // Nenhum UUID, WABA ou número real nos templates.
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(textoRollout + textoMapa));
  assert.ok(!/\b[0-9]{5,}\b/.test(textoRollout + textoMapa));

  const json = JSON.parse(textoRollout);
  assert.equal(json.cenario, c.CENARIO_ALVO_ROLLOUT);
  assert.equal(c.CENARIO_ALVO_ROLLOUT, 'B');
  assert.equal(json.rollout, true);
  assert.ok(json.whatsapp && json.whatsapp.waba && json.whatsapp.phoneNumber, 'bloco whatsapp obrigatório no template');
  assert.equal(json.whatsapp.waba.organizationId, json.whatsapp.phoneNumber.organizationId);
  assert.equal(json.whatsapp.waba.organizationId, '<ORGANIZATION_ID_USE_ORIGENS>');
  assert.deepEqual(json.organizations.map((o) => Object.keys(o).sort()), [['entitlementsProfile', 'id']]);
  const mapa = JSON.parse(textoMapa);
  assert.deepEqual(mapa.organizations.map((o) => [o.nome, o.store.nome]), [['Use Origens', 'Use Origens']]);

  // O template cru não é um arquivo de rollout (os placeholders não validam).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-r19h-cru-'));
  try {
    fs.mkdirSync(path.join(dir, 'config', 'tenant1'), { recursive: true });
    fs.copyFileSync(TEMPLATE_MAPA, path.join(dir, 'config', 'tenant1', 'tenancy-scenario-b.json'));
    const cru = path.join(dir, 'config', 'tenant1', 'rollout.json');
    fs.copyFileSync(TEMPLATE_ROLLOUT, cru);
    assert.throws(() => c.lerTenant1(cru, { cenario: 'B', rollout: true }), /inválido/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r19 §1 · preenchido: mesma forma do ensaio B; rollout exige --rollout, cenário B, whatsapp e perfil', async (t) => {
  const c = await importar(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'config.mjs'));
  const { rollout, mapa } = montarConfig(t);
  assert.deepEqual(JSON.parse(fs.readFileSync(mapa, 'utf8')), JSON.parse(fs.readFileSync(e.MAPEAMENTO.B, 'utf8')),
    'o template preenchido é exatamente o mapeamento ensaiado');

  const cfg = c.lerTenant1(rollout, { cenario: 'B', rollout: true });
  assert.equal(cfg.rollout, true);
  assert.deepEqual(cfg.whatsapp, { organizationId: B, wabaId: '1200000000009', phoneNumberId: '5511900000009' });
  assert.equal(cfg.organizations[0].perfil, 'tenant1-operacao-interna');
  assert.equal(cfg.organizations[0].nome, 'Use Origens');

  assert.throws(() => c.lerTenant1(rollout, { cenario: 'B' }), /passe --rollout/);
  assert.throws(() => c.lerTenant1(e.ARQUIVO.B, { cenario: 'B', rollout: true }), /arquivo declara rollout: false/);
  assert.throws(() => c.lerTenant1(e.ARQUIVO.A, { cenario: 'A', rollout: true }), /arquivo declara rollout: false/);

  const dir = path.dirname(rollout);
  const json = JSON.parse(fs.readFileSync(rollout, 'utf8'));
  const valida = (x, cenario = 'B') => () => c.validarTenant1(x, { dir, cenario, rollout: true });
  assert.throws(valida({ ...json, whatsapp: null }), /rollout: true exige whatsapp declarado/);
  assert.throws(valida({ ...json, organizations: [{ id: B, entitlements: ['whatsapp'] }] }), /rollout: true exige entitlementsProfile/);
  const { rollout: semChave, ...semRollout } = json;
  void semChave;
  assert.throws(valida(semRollout), /rollout precisa ser true/);
  // Cenário A com rollout: true reprova, mesmo com um arquivo de A bem formado.
  const fixtureA = JSON.parse(fs.readFileSync(e.ARQUIVO.A, 'utf8'));
  assert.throws(() => c.validarTenant1({ ...fixtureA, rollout: true }, { dir: path.dirname(e.ARQUIVO.A), cenario: 'A', rollout: true }),
    /rollout: true exige o cenário B/);
  // E o cenário A continua válido como ensaio.
  assert.equal(c.lerTenant1(e.ARQUIVO.A, { cenario: 'A' }).rollout, false);

  // CLI: sem --rollout, todos os comandos recusam antes do banco.
  for (const comando of ['preflight', 'plan', 'apply', 'verify', 'rollback']) {
    const r = await e.executar(comando, ['--scenario', 'B', '--mapping', rollout], { DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z' });
    assert.equal(r.codigo, 1, comando);
    assert.ok(r.linhas.some((l) => l.includes('passe --rollout')), `${comando}:\n${r.linhas.join('\n')}`);
  }
});

test('r19 §1 · banco: preflight → plan → apply → verify do arquivo de rollout B (perfil + whatsapp explícito)', { timeout: 300000 }, async (t) => {
  const s = e.segredosDoEnsaio();
  const { db, sup } = await e.montarBase(t, 'B', s);
  const role = e.roleDoEnsaio(t, 'oria_r19hb');
  await role.provisionar(sup, db.url);
  const uploads = e.uploadsLegados(t);
  const env = await e.ambiente('B', s, { url: db.url });
  env.TENANT1_OWNER_PASSWORD_HASH = env.TENANT1_OWNER_HASH;
  const proibidos = e.valoresProibidos(s, env);
  const { rollout, raiz } = montarConfig(t);
  const saidaSegredos = path.join(raiz, 'urls');
  const args = ['--scenario', 'B', '--mapping', rollout, '--uploads', uploads, '--app-role', role.role, '--rollout'];
  const semSegredo = (r, ctx) => { for (const v of proibidos) assert.ok(!r.linhas.join('\n').includes(v), `${ctx}: segredo na saída`); };

  const pre = await e.executar('preflight', args, env);
  assert.equal(pre.codigo, 0, pre.linhas.join('\n'));
  assert.ok(pre.linhas[0].endsWith('· ALVO DE ROLLOUT'), pre.linhas[0]);
  assert.deepEqual(statusDe(pre, 'rollout.alvo'), ['PASS']);
  assert.deepEqual(statusDe(pre, `entitlements[${B}]`), ['PEND']);
  assert.deepEqual(statusDe(pre, 'whatsapp.declaracao'), ['PASS']);
  semSegredo(pre, 'preflight');

  const plano = await e.executar('plan', args, env);
  assert.equal(plano.codigo, 0, plano.linhas.join('\n'));
  assert.ok(plano.linhas.includes('  alvo de rollout: sim (rollout: true, cenário B)'), plano.linhas.join('\n'));
  assert.ok(plano.linhas.some((l) => l.startsWith('    entitlements (perfil tenant1-operacao-interna): creative_generator, ')), plano.linhas.join('\n'));
  assert.ok(plano.linhas.includes(`  whatsapp: WABA 1200000000009 + número 5511900000009 → ${B} (declarado)`));
  assert.ok(plano.linhas.some((l) => l.includes('organization') && l.includes('"Use Origens"')));
  assert.ok(plano.linhas.includes('  ações destrutivas: nenhuma'));
  semSegredo(plano, 'plan');

  const ap = await e.executar('apply', [...args, '--saida-segredos', saidaSegredos], env);
  assert.equal(ap.codigo, 0, ap.linhas.join('\n'));
  assert.ok(ap.linhas.some((l) => l.startsWith(`PASS apply.entitlements[${B}] — ligadas (perfil tenant1-operacao-interna): `)), ap.linhas.join('\n'));
  semSegredo(ap, 'apply');

  const ver = await e.executar('verify', args, env);
  assert.equal(ver.codigo, 0, ver.linhas.join('\n'));
  assert.deepEqual(e.itensDe(ver.linhas).filter((i) => i.status !== 'PASS' && i.status !== 'INFO'), []);
  semSegredo(ver, 'verify');

  // Estado: 1 Organization/1 Store "Use Origens"; plano = perfil; WABA e número na mesma Organization.
  const { rows: orgs } = await sup.query('SELECT o.id, o.nome, s.nome AS store, s.loja_legada FROM organizations o JOIN stores s ON s.organization_id = o.id');
  assert.deepEqual(orgs.map((o) => [o.id, o.nome, o.store, o.loja_legada]), [[B, 'Use Origens', 'Use Origens', 'sul']]);
  const perfil = JSON.parse(fs.readFileSync(PERFIL, 'utf8')).features;
  const { rows: [plan] } = await sup.query(`SELECT valor FROM app_config WHERE chave = 'entitlements' AND organization_id = $1`, [B]);
  assert.deepEqual(Object.keys(plan.valor).sort(), [...perfil].sort());
  const { rows: posses } = await sup.query(`SELECT DISTINCT organization_id FROM external_resource_claims WHERE provider = 'whatsapp'`);
  assert.deepEqual(posses.map((p) => p.organization_id), [B]);

  // Idempotente.
  const ap2 = await e.executar('apply', [...args, '--saida-segredos', saidaSegredos], env);
  assert.equal(ap2.codigo, 0, ap2.linhas.join('\n'));
  assert.ok(ap2.linhas.some((l) => l.includes('apply.audit — nada mudou')), ap2.linhas.join('\n'));
  assert.ok(ap2.linhas.some((l) => l.startsWith(`PASS apply.entitlements[${B}] — nada a ligar`)));

  // O ensaio A (rollout: false) continua rodando, marcado como ensaio — aqui só o plan contra o
  // banco de B, que reprova pelo mapeamento (cenário A não é este banco), sem virar alvo.
  const planoA = await e.executar('plan', ['--scenario', 'A', '--mapping', e.ARQUIVO.A, '--uploads', uploads], { ...env, TENANT1_OWNER_SUL_HASH: env.TENANT1_OWNER_HASH });
  assert.ok(planoA.linhas[0].endsWith('· ensaio'), planoA.linhas[0]);
  assert.ok(planoA.linhas.some((l) => l.startsWith('  alvo de rollout: NÃO — ensaio')));
});
