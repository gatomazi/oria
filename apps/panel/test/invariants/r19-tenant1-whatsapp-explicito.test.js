'use strict';

// Rodada 19 · §2 — o número WhatsApp atual pertence à Organization que o arquivo de rollout DECLARA.
//
//   (a) remetente legado no ambiente (ou posse no banco) sem declaração no arquivo → FAIL em
//       preflight, plan e apply — mesmo havendo um único número e uma única Organization;
//   (b) WABA e phone_number_id declarados para Organizations diferentes → FAIL;
//   (c) os dois convergindo para a Organization Use Origens → PASS, e as posses de WABA e de número
//       (external_resource_claims) ficam na mesma Organization;
//   (+) par declarado diferente do ambiente → FAIL;
//   controles negativos: uma cópia que infere "o único número é da única Organization" e uma que
//   aceita WABA/número em Organizations diferentes fazem as asserções reprovarem (5 passos).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const e = require('../helpers/tenant1-ensaio');

const A = {
  sul: 'a1000000-0000-4000-8000-000000000001',
  centro: 'a1000000-0000-4000-8000-000000000002',
};
const B = 'b1000000-0000-4000-8000-000000000001';
const WABA_B = '1200000000009';
const NUMERO_B = '5511900000009';

const importar = (arquivo, marca = '') => import(`${pathToFileURL(arquivo).href}${marca}`);
const statusDe = (r, id) => e.itensDe(r.linhas).filter((i) => i.id === id).map((i) => i.status);

function tmp(t, prefixo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Arquivo do Tenant #1 derivado do fixture, gravado ao lado de uma cópia do mapeamento.
function arquivoDerivado(dir, cenario, nome, mudar) {
  const fixture = JSON.parse(fs.readFileSync(e.ARQUIVO[cenario], 'utf8'));
  const json = mudar({ ...fixture, mapeamentoTenancy: e.MAPEAMENTO[cenario] });
  const p = path.join(dir, nome);
  fs.writeFileSync(p, JSON.stringify(json));
  return p;
}

const declarado = (orgWaba, orgNumero, waba = WABA_B, numero = NUMERO_B) => ({
  waba: { id: waba, organizationId: orgWaba },
  phoneNumber: { id: numero, organizationId: orgNumero },
});

// Asserções puras (sem banco): usadas no teste direto e nos controles negativos.
function assertDeclaracao(cfgMod, checksMod) {
  const ids = new Set([A.sul, A.centro, B]);
  // (b) Organizations diferentes.
  const erros = [];
  assert.equal(cfgMod.validarWhatsapp(declarado(A.sul, A.centro), ids, erros), null);
  assert.ok(erros.some((x) => x.includes('declarados para Organizations diferentes')), erros.join('\n'));
  // Forma antiga (só a Organization) e recurso faltando: o par não é inferido.
  const e2 = [];
  cfgMod.validarWhatsapp({ organizationId: B }, ids, e2);
  assert.ok(e2.some((x) => x.includes('campos não aceitos: organizationId')));
  assert.ok(e2.some((x) => x.includes('whatsapp.waba ausente')));
  const e3 = [];
  cfgMod.validarWhatsapp({ waba: { id: WABA_B, organizationId: B } }, ids, e3);
  assert.ok(e3.some((x) => x.includes('whatsapp.phoneNumber ausente')));
  const e4 = [];
  cfgMod.validarWhatsapp(declarado(B, B, 'nao-numerico'), ids, e4);
  assert.ok(e4.some((x) => x.includes('whatsapp.waba.id')));
  // (c) convergindo.
  assert.deepEqual(cfgMod.validarWhatsapp(declarado(B, B), ids, []), { organizationId: B, wabaId: WABA_B, phoneNumberId: NUMERO_B });

  // (a) um único número no ambiente e UMA Organization no arquivo, sem declaração → FAIL.
  const umaOrg = { organizations: [{ id: B }], whatsapp: null };
  const envLegado = { WHATSAPP_LEGACY_PHONE_NUMBER_ID: NUMERO_B, WHATSAPP_LEGACY_WABA_ID: WABA_B };
  const semDono = checksMod.conferirDeclaracaoWhatsapp({ cfg: umaOrg, env: envLegado, claims: [] });
  assert.deepEqual(semDono.map((i) => i.status), ['FAIL'], JSON.stringify(semDono));
  assert.match(semDono[0].detalhe, /sem declaração no arquivo/);
  // (a) posse no banco sem declaração → FAIL, mesmo sem ambiente.
  const posse = [{ provider: 'whatsapp', tipo: 'phone_number', external_id: NUMERO_B, organization_id: B }];
  assert.deepEqual(checksMod.conferirDeclaracaoWhatsapp({ cfg: umaOrg, env: {}, claims: posse }).map((i) => i.status), ['FAIL']);
  // Sem nada legado: null é declaração válida.
  assert.deepEqual(checksMod.conferirDeclaracaoWhatsapp({ cfg: umaOrg, env: {}, claims: [] }).map((i) => i.status), ['PASS']);

  // Declarado: ambiente diferente do par → FAIL; posse do par em outra Organization → FAIL.
  const cfgB = { organizations: [{ id: B }], whatsapp: { organizationId: B, wabaId: WABA_B, phoneNumberId: NUMERO_B } };
  assert.deepEqual(checksMod.conferirDeclaracaoWhatsapp({ cfg: cfgB, env: envLegado, claims: [] }).map((i) => i.status), ['PASS']);
  const outroNumero = checksMod.conferirDeclaracaoWhatsapp({ cfg: cfgB, env: { ...envLegado, WHATSAPP_LEGACY_PHONE_NUMBER_ID: '5511900000001' }, claims: [] });
  assert.deepEqual(outroNumero.map((i) => i.status), ['FAIL']);
  const posseAlheia = [{ provider: 'whatsapp', tipo: 'waba', external_id: WABA_B, organization_id: A.sul }];
  assert.deepEqual(checksMod.conferirDeclaracaoWhatsapp({ cfg: cfgB, env: envLegado, claims: posseAlheia }).map((i) => i.status), ['FAIL']);
}

test('r19 §2 · declaração: par explícito, mesma Organization, nada inferido do único número', async () => {
  const cfgMod = await importar(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'config.mjs'));
  const checksMod = await importar(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'checks.mjs'));
  assertDeclaracao(cfgMod, checksMod);
});

test('r19 §2 · (b) WABA e número em Organizations diferentes → preflight, plan e apply FAIL antes do banco', async (t) => {
  const dir = tmp(t, 'oria-r19h-zap-b-');
  const arq = arquivoDerivado(dir, 'A', 'a-cruzado.json', (f) => ({ ...f, whatsapp: declarado(A.sul, A.centro, '1200000000001', '5511900000001') }));
  const env = { DATABASE_URL: 'postgres://ninguem:x@127.0.0.1:1/nada' };
  for (const comando of ['preflight', 'plan', 'apply', 'verify']) {
    const r = await e.executar(comando, ['--scenario', 'A', '--mapping', arq, '--uploads', dir], env);
    assert.equal(r.codigo, 1, comando);
    assert.ok(r.linhas.some((l) => l.includes('declarados para Organizations diferentes')), `${comando}:\n${r.linhas.join('\n')}`);
    assert.ok(!r.linhas.some((l) => l.includes('db.conexao')), `${comando}: não chegou a abrir conexão`);
  }
});

test('r19 §2 · banco: (a) sem declaração → FAIL sem escrever; (+) par divergente → FAIL; (c) convergente → posses na mesma Organization', { timeout: 300000 }, async (t) => {
  const s = e.segredosDoEnsaio();
  const { db, sup } = await e.montarBase(t, 'B', s);
  const role = e.roleDoEnsaio(t, 'oria_r19hz');
  await role.provisionar(sup, db.url);
  const uploads = e.uploadsLegados(t);
  const env = await e.ambiente('B', s, { url: db.url });
  const dir = tmp(t, 'oria-r19h-zap-');
  const { impressaoDigital, compararImpressoes } = await e.modulo('checks.mjs');
  const args = (arq) => ['--scenario', 'B', '--mapping', arq, '--uploads', uploads, '--app-role', role.role];

  // (a) um só número no ambiente, uma só Organization, arquivo com whatsapp: null.
  const semZap = arquivoDerivado(dir, 'B', 'b-sem-zap.json', (f) => ({ ...f, whatsapp: null }));
  const antes = await impressaoDigital(db.url);
  for (const comando of ['preflight', 'plan', 'apply']) {
    const r = await e.executar(comando, args(semZap), env);
    assert.equal(r.codigo, 1, `${comando}:\n${r.linhas.join('\n')}`);
    assert.deepEqual(statusDe(r, 'whatsapp.declaracao'), ['FAIL'], `${comando}:\n${r.linhas.join('\n')}`);
  }
  assert.deepEqual(compararImpressoes(antes, await impressaoDigital(db.url)), [], 'nada escrito');
  assert.equal((await sup.query(`SELECT count(*)::int AS n FROM external_resource_claims WHERE provider = 'whatsapp'`)).rows[0].n, 0);

  // (+) par declarado diferente do ambiente.
  const outro = arquivoDerivado(dir, 'B', 'b-outro-numero.json', (f) => ({ ...f, whatsapp: declarado(B, B, WABA_B, '5511900000123') }));
  const divergente = await e.executar('apply', args(outro), env);
  assert.equal(divergente.codigo, 1);
  assert.deepEqual(statusDe(divergente, 'whatsapp.declaracao'), ['FAIL'], divergente.linhas.join('\n'));
  assert.deepEqual(statusDe(divergente, `whatsapp.remetente[${B}]`), ['FAIL'], 'o import também recusa o par que não é o declarado');
  assert.deepEqual(compararImpressoes(antes, await impressaoDigital(db.url)), []);

  // (c) convergente (fixture B): PASS e as duas posses na Organization declarada.
  const ok = args(e.ARQUIVO.B);
  const plano = await e.executar('plan', ok, env);
  assert.equal(plano.codigo, 0, plano.linhas.join('\n'));
  assert.ok(plano.linhas.includes(`  whatsapp: WABA ${WABA_B} + número ${NUMERO_B} → ${B} (declarado)`), plano.linhas.join('\n'));
  const ap = await e.executar('apply', [...ok, '--saida-segredos', path.join(dir, 'urls')], env);
  assert.equal(ap.codigo, 0, ap.linhas.join('\n'));
  const ver = await e.executar('verify', ok, env);
  assert.equal(ver.codigo, 0, ver.linhas.join('\n'));
  assert.deepEqual(statusDe(ver, 'whatsapp.declaracao'), ['PASS']);
  assert.deepEqual(statusDe(ver, `whatsapp.remetente[${B}]`), ['PASS']);
  const { rows: posses } = await sup.query(
    `SELECT tipo, external_id, organization_id FROM external_resource_claims WHERE provider = 'whatsapp' ORDER BY tipo`
  );
  assert.deepEqual(posses.map((p) => [p.tipo, p.external_id, p.organization_id]), [['phone_number', NUMERO_B, B], ['waba', WABA_B, B]]);

  // (a') depois do cutover, sem ambiente legado: posse no banco e arquivo com null → FAIL.
  const semAmbiente = { ...env };
  for (const n of Object.keys(semAmbiente)) if (n.startsWith('WHATSAPP_LEGACY_')) delete semAmbiente[n];
  const r = await e.executar('verify', args(semZap), semAmbiente);
  assert.equal(r.codigo, 1);
  assert.deepEqual(statusDe(r, 'whatsapp.declaracao'), ['FAIL'], r.linhas.join('\n'));
  // Com a declaração, o verify segue verde mesmo sem o ambiente legado (integração completa).
  const verSemAmbiente = await e.executar('verify', ok, semAmbiente);
  assert.equal(verSemAmbiente.codigo, 0, verSemAmbiente.linhas.join('\n'));
});

// ── controles negativos ──────────────────────────────────────────────────────────────────────
const VIOLACOES = [
  {
    nome: 'checks infere o único número para a única Organization',
    arquivo: 'checks.mjs',
    de: "    if (envNumero || envWaba) problemas.push(",
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "só há um número e uma Organization: é dela"\n'
        + '    if ((envNumero || envWaba) && cfg.organizations.length !== 1) problemas.push(',
  },
  {
    nome: 'config aceita WABA e número em Organizations diferentes',
    arquivo: 'config.mjs',
    de: '  if (recurso.waba.organizationId !== recurso.phoneNumber.organizationId) {',
    para: '  if (false) { // VIOLAÇÃO DELIBERADA (negative control) — "o número manda"',
  },
];

for (const v of VIOLACOES) {
  test(`r19 §2 · negative control · ${v.nome} · ciclo de 5 passos`, async (t) => {
    const raiz = tmp(t, 'oria-r19h-zap-nc-');
    fs.cpSync(path.join(h.RAIZ_REPO, 'scripts'), path.join(raiz, 'scripts'), { recursive: true });
    for (const x of ['lib', 'node_modules', 'migrations', 'server.js', 'routes']) fs.symlinkSync(path.join(h.RAIZ_REPO, x), path.join(raiz, x));
    const alvo = path.join(raiz, 'scripts', 'tenant1', v.arquivo);
    const original = fs.readFileSync(alvo, 'utf8');
    assert.equal(original.split(v.de).length - 1, 1, 'trecho da violação não encontrado — o controle não aplicaria nada');
    let passo = 0;
    const rodar = async (conteudo) => {
      passo += 1;
      fs.writeFileSync(alvo, conteudo);
      // Cópia nova por passo: o cache de módulos ESM é por URL.
      const dirPasso = path.join(raiz, `p${passo}`);
      fs.mkdirSync(dirPasso);
      fs.cpSync(path.join(raiz, 'scripts'), path.join(dirPasso, 'scripts'), { recursive: true });
      for (const x of ['lib', 'node_modules', 'migrations', 'server.js', 'routes']) fs.symlinkSync(path.join(h.RAIZ_REPO, x), path.join(dirPasso, x));
      const cfgMod = await importar(path.join(dirPasso, 'scripts', 'tenant1', 'config.mjs'));
      const checksMod = await importar(path.join(dirPasso, 'scripts', 'tenant1', 'checks.mjs'));
      try {
        assertDeclaracao(cfgMod, checksMod);
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(await rodar(original), true, '[1] passa no estado correto');
    assert.equal(await rodar(original.replace(v.de, v.para)), false, `[3] a violação passou: ${v.nome}`);
    assert.equal(await rodar(original), true, '[5] volta a passar');
  });
}
