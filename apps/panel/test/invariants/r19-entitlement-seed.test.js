'use strict';

// Rodada 19 · §9 — seed EXPLÍCITO de entitlements do Tenant #1 por PERFIL de dados.
//
//   1. o registry canônico (lib/platform/entitlements.js, ESTADO_DAS_FEATURES) bate com o código:
//      rotas protegidas (feature-routes.js), flags do Creative Core e navegação do admin;
//   2. o perfil config/entitlements/tenant1-entitlements.json só liga features implementadas;
//   3. `tenancy:seed-entitlements` rejeita feature desconhecida, não implementada, curinga,
//      all/default e lista vazia; é idempotente; a saída só tem nomes/estado;
//   4. o arquivo do Tenant #1 aceita o perfil (entitlementsProfile) com a mesma validação;
//   5. controles negativos: uma cópia do seed sem a checagem de vocabulário ou sem a de
//      implementação faz as asserções reprovarem (ciclo de 5 passos).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const { FEATURES, ESTADO_DAS_FEATURES, FEATURES_IMPLEMENTADAS } = require('../../lib/platform/entitlements.js');
const { ROTAS } = require('../../lib/platform/feature-routes.js');
const { FLAGS: FLAGS_CRIATIVOS } = require('../../lib/creative-core/flags.js');

const SEED = path.join(h.RAIZ_REPO, 'scripts', 'tenancy', 'seed-entitlements.mjs');
const PERFIL = path.join(h.RAIZ_REPO, 'config', 'entitlements', 'tenant1-entitlements.json');

// Lista ON documentada em docs/productization/round19-trilha-h.md. Mudar o perfil exige mudar
// aqui e no documento, de propósito.
const ON_TENANT1 = [
  'catalog', 'creative_clean_angles', 'creative_funnel_visual', 'creative_generator', 'creative_multi_product',
  'creative_remarketing', 'exchanges', 'financial', 'refunds', 'whatsapp',
];

const importar = (arquivo, marca = '') => import(`${pathToFileURL(arquivo).href}${marca}`);

function tmp(t, prefixo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gravarJson(dir, nome, conteudo) {
  const p = path.join(dir, nome);
  fs.writeFileSync(p, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
  return p;
}

// ── 1. registry × código ─────────────────────────────────────────────────────────────────────
test('r19 §9 · registry: estado de cada feature bate com rotas, flags do Creative Core e navegação', () => {
  assert.deepEqual(Object.keys(ESTADO_DAS_FEATURES).sort(), [...FEATURES].sort(), 'toda feature do vocabulário tem estado');
  for (const estado of Object.values(ESTADO_DAS_FEATURES)) assert.ok(['implementada', 'em_breve', 'nao_implementada'].includes(estado));

  const protegidasPorRota = new Set(ROTAS.map(([, f]) => f));
  const conferidasPeloGerador = new Set(FLAGS_CRIATIVOS);
  for (const f of protegidasPorRota) assert.equal(ESTADO_DAS_FEATURES[f], 'implementada', `${f} protege rota e precisa estar implementada`);
  for (const f of conferidasPeloGerador) assert.equal(ESTADO_DAS_FEATURES[f], 'implementada', `${f} é conferida pelo gerador`);
  for (const f of FEATURES_IMPLEMENTADAS) {
    assert.ok(protegidasPorRota.has(f) || conferidasPeloGerador.has(f), `${f} marcada implementada sem rota/motor que a confira`);
  }

  // Navegação do admin: item comingSoon cuja chave é feature não pode estar implementado.
  const nav = fs.readFileSync(path.join(h.RAIZ_REPO, 'src', 'shell', 'nav.ts'), 'utf8');
  const emBreve = [...nav.matchAll(/\{\s*key:\s*'([^']+)'[^}]*comingSoon:\s*true/g)].map((m) => m[1]).filter((k) => FEATURES.includes(k));
  assert.deepEqual(emBreve, ['instagram']);
  for (const f of emBreve) assert.equal(ESTADO_DAS_FEATURES[f], 'em_breve');

  // O espelho do frontend só conhece features do vocabulário.
  const espelho = fs.readFileSync(path.join(h.RAIZ_REPO, 'src', 'state', 'entitlements.ts'), 'utf8');
  const chaves = [...espelho.match(/interface Entitlements \{([^}]*)\}/)[1].matchAll(/(\w+):\s*boolean/g)].map((m) => m[1]);
  for (const k of chaves) assert.ok(FEATURES.includes(k), `${k} do espelho fora do vocabulário`);

  // Sem rota, sem motor e sem item de navegação: não implementada.
  const semUso = FEATURES.filter((f) => !protegidasPorRota.has(f) && !conferidasPeloGerador.has(f) && !emBreve.includes(f));
  assert.deepEqual(semUso, ['advancedAutomations']);
  assert.equal(ESTADO_DAS_FEATURES.advancedAutomations, 'nao_implementada');
});

// ── 2. perfil do Tenant #1 ───────────────────────────────────────────────────────────────────
test('r19 §9 · perfil do Tenant #1: só implementadas, lista ON documentada, nada de curinga', async () => {
  const s = await importar(SEED);
  const p = s.lerPerfilDeEntitlements(PERFIL);
  assert.equal(p.perfil, 'tenant1-operacao-interna');
  assert.deepEqual(p.features, ON_TENANT1);
  for (const f of p.features) assert.equal(ESTADO_DAS_FEATURES[f], 'implementada');
  const bruto = JSON.parse(fs.readFileSync(PERFIL, 'utf8'));
  assert.deepEqual(Object.keys(bruto).sort(), ['descricao', 'features', 'perfil', 'versao']);
  assert.ok(Array.isArray(bruto.features));
  assert.ok(!p.features.includes('instagram') && !p.features.includes('advancedAutomations'));
});

// Asserções de validação: usadas no teste direto e no controle negativo (contra cópias do seed).
function assertValidacao(s) {
  const rejeita = (lista, re) => assert.throws(() => s.validarFeaturesDoSeed(lista, 'x'), re, JSON.stringify(lista));
  rejeita(['nao_existe'], /fora do vocabulário: nao_existe/);
  rejeita(['whatsapp', 'Financial'], /fora do vocabulário: Financial/);
  rejeita(['*'], /curinga proibido/);
  rejeita(['all'], /curinga proibido/);
  rejeita(['instagram'], /não implementada.*instagram \(em_breve\)/);
  rejeita(['catalog', 'advancedAutomations'], /não implementada.*advancedAutomations \(nao_implementada\)/);
  rejeita([], /vazia/);
  rejeita(['catalog', 'catalog'], /repetida/);
  assert.deepEqual(s.validarFeaturesDoSeed(['whatsapp', 'catalog'], 'x'), ['catalog', 'whatsapp']);

  const base = { versao: 1, perfil: 'teste', features: ['catalog'] };
  const rejeitaPerfil = (json, re) => assert.throws(() => s.validarPerfilDeEntitlements(json, 'p'), re, JSON.stringify(json));
  rejeitaPerfil({ ...base, all: true }, /curinga\/default proibido/);
  rejeitaPerfil({ ...base, default: true }, /curinga\/default proibido/);
  rejeitaPerfil({ ...base, defaultEnabled: true }, /curinga\/default proibido/);
  rejeitaPerfil({ ...base, features: { catalog: true } }, /precisa ser uma LISTA/);
  rejeitaPerfil({ ...base, features: ['instagram'] }, /não implementada/);
  rejeitaPerfil({ ...base, features: ['*'] }, /curinga/);
  rejeitaPerfil({ ...base, versao: 2 }, /versao 2/);
  rejeitaPerfil({ ...base, perfil: 'Com Espaço' }, /perfil precisa ser um nome/);
  rejeitaPerfil([], /objeto JSON/);
  assert.deepEqual(s.validarPerfilDeEntitlements(base, 'p'), { perfil: 'teste', features: ['catalog'] });
}

test('r19 §9 · validação: desconhecida, não implementada, curinga, all/default e vazia reprovam', async () => {
  const s = await importar(SEED);
  assertValidacao(s);
  // Ambiente: perfil e lista juntos é ambíguo; lista solta passa pela mesma regra.
  assert.throws(() => s.featuresDoAmbiente({ ENTITLEMENTS_SEED_PROFILE: PERFIL, ENTITLEMENTS_SEED_FEATURES: 'catalog' }), /diverge do perfil.*faltando: .*ambíguo; esperado: catalog,/);
  assert.throws(() => s.featuresDoAmbiente({ ENTITLEMENTS_SEED_PROFILE: PERFIL, ENTITLEMENTS_SEED_FEATURES: `${ON_TENANT1.join(',')},instagram` }), /a mais: instagram/);
  // Mesma lista (a variável da RELEASE B continua no ambiente): o perfil manda, sem erro.
  assert.deepEqual(s.featuresDoAmbiente({ ENTITLEMENTS_SEED_PROFILE: PERFIL, ENTITLEMENTS_SEED_FEATURES: [...ON_TENANT1].reverse().join(', ') }).features, ON_TENANT1);
  assert.equal(s.compararListaComPerfil(ON_TENANT1.join(','), ON_TENANT1).iguais, true);
  assert.equal(s.compararListaComPerfil(`${ON_TENANT1.join(',')},catalog`, ON_TENANT1).iguais, false, 'repetição não é igual');
  assert.equal(s.compararListaComPerfil('', ON_TENANT1).iguais, false);
  assert.throws(() => s.featuresDoAmbiente({ ENTITLEMENTS_SEED_FEATURES: 'catalog,instagram' }), /não implementada/);
  assert.throws(() => s.featuresDoAmbiente({ ENTITLEMENTS_SEED_FEATURES: '*' }), /curinga/);
  assert.equal(s.featuresDoAmbiente({}), null);
  assert.deepEqual(s.featuresDoAmbiente({ ENTITLEMENTS_SEED_PROFILE: PERFIL }).features, ON_TENANT1);
});

// ── 3. banco real ────────────────────────────────────────────────────────────────────────────
test('r19 §9 · seed por perfil: liga exatamente o perfil, é idempotente e recusa sem escrever', { timeout: 120000 }, async (t) => {
  const s = await importar(SEED);
  const db = await h.criarBancoDescartavel('oria_r19h_seed');
  t.after(() => db.destruir());
  const m = h.migrar(db.url);
  assert.equal(m.status, 0, `${m.stdout.slice(-2000)}${m.stderr}`);
  const sup = h.abrirPoolDescartavel(db.url, { max: 1 });
  t.after(() => sup.end());
  const org = crypto.randomUUID();
  const outra = crypto.randomUUID();
  await sup.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'Org perfil'), ($2, 'Org fora')`, [org, outra]);
  const plano = async (id) => (await sup.query(`SELECT valor, atualizado_em FROM app_config WHERE chave = 'entitlements' AND organization_id = $1`, [id])).rows[0];

  // Recusas: nada gravado.
  const dir = tmp(t, 'oria-r19h-perfil-');
  const ruim = gravarJson(dir, 'ruim.json', { versao: 1, perfil: 'ruim', features: ['catalog', 'instagram'] });
  await assert.rejects(s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: org, ENTITLEMENTS_SEED_PROFILE: ruim }), /não implementada/);
  await assert.rejects(s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: org, ENTITLEMENTS_SEED_FEATURES: 'catalog,nao_existe' }), /vocabulário/);
  await assert.rejects(s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: org, ENTITLEMENTS_SEED_FEATURES: 'all' }), /curinga/);
  await assert.rejects(s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: org, ENTITLEMENTS_SEED_PROFILE: PERFIL, ENTITLEMENTS_SEED_FEATURES: 'catalog' }), /diverge do perfil/);
  await assert.rejects(s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: org }), /ENTITLEMENTS_SEED_PROFILE/);
  await assert.rejects(s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: `${org},${org}`, ENTITLEMENTS_SEED_PROFILE: PERFIL }), /repetido/);
  await assert.rejects(s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: `${org},${crypto.randomUUID()}`, ENTITLEMENTS_SEED_PROFILE: PERFIL }), /inexistente/);
  assert.equal(await plano(org), undefined, 'nenhuma recusa escreveu (a transação inteira volta)');

  const r1 = await s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: org, ENTITLEMENTS_SEED_PROFILE: PERFIL });
  assert.deepEqual(r1.ligadasAgora[org], ON_TENANT1);
  const p1 = await plano(org);
  assert.deepEqual(Object.keys(p1.valor).sort(), ON_TENANT1);
  assert.ok(Object.values(p1.valor).every((v) => v === true));
  assert.equal(await plano(outra), undefined, 'só a Organization declarada');

  const r2 = await s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: org, ENTITLEMENTS_SEED_PROFILE: PERFIL });
  assert.deepEqual(r2.ligadasAgora[org], [], 'segunda execução não liga nada');
  const p2 = await plano(org);
  assert.deepEqual(p2.valor, p1.valor);
  assert.equal(p2.atualizado_em.getTime(), p1.atualizado_em.getTime(), 'idempotente: nem o carimbo muda');
  assert.ok(s.relatorio(r2).some((l) => l.endsWith(`${org}: nada mudou`)));

  // Não desliga nada: um valor já false para feature fora do perfil continua como está.
  await sup.query(`UPDATE app_config SET valor = valor || '{"instagram": false}'::jsonb WHERE chave = 'entitlements' AND organization_id = $1`, [org]);
  await s.seedEntitlements(db.url, { ENTITLEMENTS_SEED_ORGANIZATION_IDS: org, ENTITLEMENTS_SEED_PROFILE: PERFIL });
  assert.equal((await plano(org)).valor.instagram, false);

  // CLI real: só nomes/estado; nenhum valor do ambiente no stdout; recusa sai com 1.
  const senha = crypto.randomBytes(12).toString('hex');
  const urlComMarca = db.url;
  const env = { PATH: process.env.PATH, DATABASE_URL: urlComMarca, ENTITLEMENTS_SEED_ORGANIZATION_IDS: outra, ENTITLEMENTS_SEED_PROFILE: PERFIL, ALGUM_SECRET: senha };
  const cli = spawnSync(process.execPath, [SEED], { cwd: h.RAIZ_REPO, encoding: 'utf8', env, timeout: 60000 });
  assert.equal(cli.status, 0, `${cli.stdout}${cli.stderr}`);
  const saida = `${cli.stdout}${cli.stderr}`;
  assert.match(saida, /perfil tenant1-operacao-interna · ON: catalog, /);
  assert.match(saida, new RegExp(`${outra}: ligadas agora: catalog`));
  assert.match(saida, /não ligadas por este seed: instagram \(em_breve\), advancedAutomations \(nao_implementada\)/);
  assert.ok(!saida.includes(senha));
  const pw = new URL(urlComMarca).password;
  if (pw) assert.ok(!saida.includes(pw), 'senha do banco na saída');
  const recusa = spawnSync(process.execPath, [SEED], { cwd: h.RAIZ_REPO, encoding: 'utf8', env: { ...env, ENTITLEMENTS_SEED_PROFILE: ruim }, timeout: 60000 });
  assert.equal(recusa.status, 1);
  assert.match(recusa.stderr, /entitlements: perfil ruim\.json: feature não implementada \(não pode ser semeada\): instagram \(em_breve\)/);
});

// ── 4. arquivo do Tenant #1 ──────────────────────────────────────────────────────────────────
test('r19 §9 · arquivo do Tenant #1: entitlementsProfile resolve pelo perfil; lista e perfil juntos reprovam', async (t) => {
  const c = await importar(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'config.mjs'));
  const fixture = JSON.parse(fs.readFileSync(path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenant1', 'cenario-b.json'), 'utf8'));
  const dirFix = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenant1');
  const [org] = fixture.organizations;
  const comPerfil = { ...fixture, organizations: [{ id: org.id, entitlementsProfile: PERFIL }] };
  const cfg = c.validarTenant1(comPerfil, { dir: dirFix, cenario: 'B' });
  assert.deepEqual(cfg.organizations[0].entitlements, ON_TENANT1);
  assert.equal(cfg.organizations[0].perfil, 'tenant1-operacao-interna');
  assert.equal(cfg.organizations[0].arquivoPerfil, PERFIL);

  const valida = (json) => () => c.validarTenant1(json, { dir: dirFix, cenario: 'B' });
  assert.throws(valida({ ...fixture, organizations: [{ ...org, entitlementsProfile: PERFIL }] }), /exatamente um de entitlements/);
  assert.throws(valida({ ...fixture, organizations: [{ id: org.id }] }), /exatamente um de entitlements/);
  assert.throws(valida({ ...fixture, organizations: [{ id: org.id, entitlementsProfile: 'nao-existe.json' }] }), /entitlementsProfile: perfil nao-existe\.json: não foi possível ler/);
  const dir = tmp(t, 'oria-r19h-t1-');
  const ruim = gravarJson(dir, 'ruim.json', { versao: 1, perfil: 'ruim', features: ['whatsapp'], all: true });
  assert.throws(valida({ ...fixture, organizations: [{ id: org.id, entitlementsProfile: ruim }] }), /curinga\/default proibido/);
  // Lista inline passa pela mesma regra do seed.
  assert.throws(valida({ ...fixture, organizations: [{ ...org, entitlements: ['whatsapp', 'instagram'] }] }), /não implementada/);
  assert.throws(valida({ ...fixture, organizations: [{ ...org, entitlements: ['*'] }] }), /fora do vocabulário: \*/);
  assert.doesNotThrow(valida({ ...fixture, organizations: [{ ...org, entitlements: [] }] }), 'lista vazia inline = nenhuma feature (declarado)');
});

// ── 5. controles negativos ───────────────────────────────────────────────────────────────────
const VIOLACOES_SEED = [
  {
    nome: 'seed aceita feature desconhecida',
    de: "  const desconhecidas = nomes.filter((f) => !FEATURES.includes(f));",
    para: '  const desconhecidas = []; // VIOLAÇÃO DELIBERADA (negative control) — "o registry é só referência"',
  },
  {
    nome: 'seed aceita feature não implementada (comingSoon)',
    de: "  const naoImplementadas = nomes.filter((f) => FEATURES.includes(f) && ESTADO_DAS_FEATURES[f] !== 'implementada');",
    para: '  const naoImplementadas = []; // VIOLAÇÃO DELIBERADA (negative control) — "liga já, a tela vem depois"',
  },
  {
    nome: 'perfil aceita all/default como chave',
    de: '  const extras = Object.keys(json).filter((k) => !CAMPOS_DO_PERFIL.includes(k));',
    para: "  const extras = Object.keys(json).filter((k) => !CAMPOS_DO_PERFIL.includes(k) && !/^(all|default)/i.test(k)); // VIOLAÇÃO DELIBERADA",
  },
];

for (const v of VIOLACOES_SEED) {
  test(`r19 §9 · negative control · ${v.nome} · ciclo de 5 passos`, async (t) => {
    const raiz = tmp(t, 'oria-r19h-nc-');
    fs.mkdirSync(path.join(raiz, 'scripts', 'tenancy'), { recursive: true });
    for (const x of ['lib', 'node_modules']) fs.symlinkSync(path.join(h.RAIZ_REPO, x), path.join(raiz, x));
    const copia = path.join(raiz, 'scripts', 'tenancy', 'seed-entitlements.mjs');
    const original = fs.readFileSync(SEED, 'utf8');
    assert.equal(original.split(v.de).length - 1, 1, 'trecho da violação não encontrado — o controle não aplicaria nada');
    const rodar = async (conteudo, passo) => {
      fs.writeFileSync(copia, conteudo);
      const mod = await importar(copia, `?passo=${passo}`);
      try {
        assertValidacao(mod);
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(await rodar(original, 1), true, '[1] passa no estado correto');
    assert.equal(await rodar(original.replace(v.de, v.para), 3), false, `[3] a violação passou: ${v.nome}`);
    assert.equal(await rodar(original, 5), true, '[5] volta a passar');
  });
}
