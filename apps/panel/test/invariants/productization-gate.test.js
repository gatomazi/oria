'use strict';

// Second Tenant Gate executável (rodada 18, trilha D) — o gate precisa REPROVAR.
//
//   - avaliação pura (scripts/productization/gate-lib.mjs) com eventos sintéticos: teste pulado,
//     falha, arquivo de invariant ausente, piso de testes, Go pulado ou de outro commit;
//   - OPS nunca viram PASS sem evidência; evidência inválida ou com cara de segredo é FAIL;
//   - exit code (rodada 19): 0 SÓ com OVERALL READY; CODE bloqueado = 1; CODE PASS com OPS/dogfood
//     pendente = 2; `--code-only` removido (64); `--report-only` sai 0 e se declara "não é gate";
//     controle negativo: uma gate-lib que sai 0 bloqueada reprova a verificação de semântica;
//   - CLI contra uma CÓPIA do código com violação deliberada (ciclo de 5 passos) para cada check
//     estático, incluindo um repositório Go sintético.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { RAIZ_REPO } = require('./harness');

const GATE = path.join(RAIZ_REPO, 'scripts', 'productization', 'gate.mjs');
let lib;

test.before(async () => {
  lib = await import(pathToFileURL(path.join(RAIZ_REPO, 'scripts', 'productization', 'gate-lib.mjs')));
});

// ── Eventos sintéticos ─────────────────────────────────────────────────────────────────────────

function arquivosDaSuite() {
  const de = (dir) => fs.readdirSync(path.join(RAIZ_REPO, dir)).filter((x) => x.endsWith('.test.js')).map((x) => path.join(RAIZ_REPO, dir, x));
  return [...de('test'), ...de(path.join('test', 'invariants'))];
}

function suiteVerde() {
  const eventos = [];
  for (const file of arquivosDaSuite()) {
    for (let i = 0; i < 16; i += 1) eventos.push({ status: 'pass', file, name: `t${i}`, nesting: 0, skip: null, todo: null, tipo: 'test' });
  }
  const boot = path.join(RAIZ_REPO, 'test', 'invariants', 'boot-exit-code.test.js');
  eventos.push({ status: 'pass', file: boot, name: 'boot · DB_ENFORCE_APP_ROLE=1 com superusuário → exit ≠ 0 e não escuta', nesting: 0, tipo: 'test' });
  eventos.push({ status: 'pass', file: boot, name: 'boot · DB_ENFORCE_APP_ROLE=1 com oria_app → verifica e escuta', nesting: 0, tipo: 'test' });
  eventos.push({ status: 'pass', file: path.join(RAIZ_REPO, 'test', 'invariants', 'fase4-integrations.test.js'), name: 'INV-12 · fallback de env legado: desligado por padrão, e ligado só serve a loja legada da própria Store', nesting: 0, tipo: 'test' });
  return { exitCode: 0, eventos };
}

function estaticosVerdes() {
  const file = path.join(RAIZ_REPO, 'test', 'invariants', 'fase3-static.test.js');
  const nomes = [...new Set(Object.values(lib.TESTES_ESTATICOS).flat())];
  return nomes.map((name) => ({ status: 'pass', file, name, nesting: 0, tipo: 'test' }));
}

function relatorioGoDoPainel(extra = {}) {
  const contracts = {};
  for (const c of lib.CONTRATOS_GO) {
    const bruto = fs.readFileSync(path.join(RAIZ_REPO, 'test', 'fixtures', 'whatsapp', c.arquivo));
    contracts[c.arquivo] = { contract: c.contrato, version: c.versao, sha256: crypto.createHash('sha256').update(bruto).digest('hex') };
  }
  return { format: lib.FORMATO_RELATORIO_GO, go_head: 'abc1234', contracts, default_sender_env_absent: true, ...extra };
}

const GO_VERDE = { vet: 0, build: 0, test: 0, race: true, pass: 105, fail: 0, skipped: [], head: 'abc1234' };
// Monorepo Oria: terceiro componente do gate (apps/creative-generator/run_tests.py).
const GERADOR_VERDE = { exit: 0, suites: 7, falhas: 0, python: '/x/.venv/bin/python' };

function dirVazio(prefixo) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
}

function evidencia(dir, id, extra = {}) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    format: lib.FORMATO_EVIDENCIA_OPS, id, status: 'VERIFIED', verified_at: '2026-09-20T12:00:00Z',
    verified_by: 'operador', environment: 'production', evidence: 'bateria 5a: 403/403/401/401/200/401', ...extra,
  }));
}

function consolidarVerde(opcoes = {}) {
  return lib.consolidar({
    raiz: RAIZ_REPO,
    suite: suiteVerde(),
    eventosEstaticos: estaticosVerdes(),
    goDir: null,
    relatorioGo: relatorioGoDoPainel(),
    goTestes: GO_VERDE,
    goHead: null,
    geradorTestes: GERADOR_VERDE,
    dirEvidencia: dirVazio('oria-gate-ev-'),
    ...opcoes,
  });
}

const statusDe = (r, id) => r.code.find((c) => c.id === id).status;

// ── Suíte ──────────────────────────────────────────────────────────────────────────────────────

test('gate · suíte verde sintética → checks da suíte PASS', () => {
  const r = lib.avaliarSuite(suiteVerde(), { raiz: RAIZ_REPO });
  for (const [nome, parte] of Object.entries(r.partes)) assert.equal(parte.status, lib.PASS, `${nome}: ${parte.detalhes}`);
});

test('gate · suíte não executada nunca é PASS', () => {
  const r = lib.avaliarSuite(null, { raiz: RAIZ_REPO });
  for (const parte of Object.values(r.partes)) assert.equal(parte.status, lib.NAO_VERIFICADO);
});

test('gate · um teste pulado reprova no skipped e no arquivo dele', () => {
  const s = suiteVerde();
  const alvo = path.join(RAIZ_REPO, 'test', 'invariants', 'fase5c-e2e-whatsapp.test.js');
  s.eventos.push({ status: 'pass', file: alvo, name: 'E2E', nesting: 0, skip: 'repositório do Go não encontrado', tipo: 'test' });
  const r = lib.avaliarSuite(s, { raiz: RAIZ_REPO }).partes;
  assert.equal(r.pulados.status, lib.FAIL);
  assert.equal(r.goE2e.status, lib.FAIL);
  assert.equal(r.invariants.status, lib.FAIL);
  assert.equal(r.suite.status, lib.PASS, 'pulado não é falha da suíte — é o check de pulados que pega');
});

test('gate · todo e cancelado também reprovam', () => {
  const s = suiteVerde();
  s.eventos.push({ status: 'pass', file: path.join(RAIZ_REPO, 'test', 'meta.test.js'), name: 'x', nesting: 0, todo: 'depois', tipo: 'test' });
  assert.equal(lib.avaliarSuite(s, { raiz: RAIZ_REPO }).partes.pulados.status, lib.FAIL);
  const c = suiteVerde();
  c.eventos.push({ status: 'fail', file: path.join(RAIZ_REPO, 'test', 'meta.test.js'), name: 'y', nesting: 1, falha: 'cancelledByParent', tipo: 'test' });
  const r = lib.avaliarSuite(c, { raiz: RAIZ_REPO }).partes;
  assert.equal(r.pulados.status, lib.FAIL);
  assert.equal(r.suite.status, lib.FAIL);
});

test('gate · falha, exit ≠ 0, piso de testes e arquivo de invariant que não rodou', () => {
  const falha = suiteVerde();
  falha.eventos.push({ status: 'fail', file: path.join(RAIZ_REPO, 'test', 'invariants', 'td001-rls-contract.test.js'), name: 'RLS', nesting: 0, tipo: 'test' });
  const r = lib.avaliarSuite(falha, { raiz: RAIZ_REPO }).partes;
  assert.equal(r.suite.status, lib.FAIL);
  assert.equal(r.rls.status, lib.FAIL);
  assert.equal(r.appRole.status, lib.FAIL);

  const exit = { ...suiteVerde(), exitCode: 1 };
  assert.equal(lib.avaliarSuite(exit, { raiz: RAIZ_REPO }).partes.suite.status, lib.FAIL);

  const pouco = suiteVerde();
  assert.equal(lib.avaliarSuite(pouco, { raiz: RAIZ_REPO, minimoDeTestes: pouco.eventos.length + 1 }).partes.suite.status, lib.FAIL);

  const sem = suiteVerde();
  sem.eventos = sem.eventos.filter((e) => !e.file.endsWith('tenancy-schema.test.js'));
  const p = lib.avaliarSuite(sem, { raiz: RAIZ_REPO }).partes;
  assert.equal(p.invariants.status, lib.FAIL);
  assert.equal(p.rls.status, lib.FAIL);
  assert.match(p.rls.detalhes.join('\n'), /tenancy-schema.test.js: nenhum teste executado/);

  // Teste esperado por nome que sumiu (renomeado) não passa em silêncio.
  const renomeado = suiteVerde();
  renomeado.eventos = renomeado.eventos.filter((e) => !/DB_ENFORCE_APP_ROLE=1 com oria_app/.test(e.name));
  assert.equal(lib.avaliarSuite(renomeado, { raiz: RAIZ_REPO }).partes.appRole.status, lib.FAIL);
});

// ── Go ─────────────────────────────────────────────────────────────────────────────────────────

test('gate · testes Go: ausentes = NOT VERIFIED; pulado, falha, sem -race ou commit velho = FAIL', () => {
  assert.equal(lib.avaliarTestesGo(null).status, lib.NAO_VERIFICADO);
  assert.equal(lib.avaliarTestesGo(GO_VERDE).status, lib.PASS);
  assert.equal(lib.avaliarTestesGo({ ...GO_VERDE, skipped: ['TestDB'] }).status, lib.FAIL);
  assert.equal(lib.avaliarTestesGo({ ...GO_VERDE, fail: 1, test: 1 }).status, lib.FAIL);
  assert.equal(lib.avaliarTestesGo({ ...GO_VERDE, race: false }).status, lib.FAIL);
  assert.equal(lib.avaliarTestesGo({ ...GO_VERDE, pass: 0 }).status, lib.FAIL);
  const rel = { ...relatorioGoDoPainel(), go_tests: GO_VERDE };
  assert.equal(lib.avaliarTestesGo(null, { relatorioGo: rel, goHead: 'abc1234' }).status, lib.PASS);
  assert.equal(lib.avaliarTestesGo(null, { relatorioGo: rel, goHead: 'fff9999' }).status, lib.FAIL);
});

test('gate · Gerador de Criativos: ausente = NOT VERIFIED; exit ≠ 0, suíte faltando ou erro = FAIL', () => {
  assert.equal(lib.avaliarTestesDoGerador(null).status, lib.NAO_VERIFICADO);
  assert.equal(lib.avaliarTestesDoGerador(GERADOR_VERDE).status, lib.PASS);
  assert.equal(lib.avaliarTestesDoGerador({ ...GERADOR_VERDE, exit: 1 }).status, lib.FAIL);
  assert.equal(lib.avaliarTestesDoGerador({ ...GERADOR_VERDE, falhas: 2 }).status, lib.FAIL);
  assert.equal(lib.avaliarTestesDoGerador({ ...GERADOR_VERDE, suites: 0 }).status, lib.FAIL);
  assert.equal(lib.avaliarTestesDoGerador({ erro: 'python3: not found' }).status, lib.FAIL);
  // No consolidado, o componente bloqueia o bloco CODE como qualquer outro.
  assert.equal(statusDe(consolidarVerde(), 'creative-generator'), lib.PASS);
  const semGerador = consolidarVerde({ geradorTestes: null });
  assert.equal(statusDe(semGerador, 'creative-generator'), lib.NAO_VERIFICADO);
  assert.notEqual(semGerador.exit, lib.EXIT.PRONTO);
  assert.equal(statusDe(consolidarVerde({ geradorTestes: { exit: 1, suites: 7, falhas: 1 } }), 'creative-generator'), lib.FAIL);
});

test('gate · go test -json: só o processo-filho conhecido pode pular', () => {
  const linhas = [
    { Action: 'pass', Test: 'TestA' }, { Action: 'skip', Test: 'TestQueueWorkerProcess' }, { Action: 'skip', Test: 'TestInboxProcess' },
    { Action: 'skip', Test: 'TestInboxProcessX' }, { Action: 'skip', Test: 'TestGivenDatabase_WhenX' }, { Action: 'fail', Test: 'TestB' }, { Action: 'output', Test: 'TestA' },
  ].map((x) => JSON.stringify(x)).join('\n');
  const r = lib.resumirGoTestJson(`${linhas}\nPASS\n`);
  assert.deepEqual([r.pass, r.fail, r.skipped, r.pulosEsperados], [1, 1, ['TestInboxProcessX', 'TestGivenDatabase_WhenX'], ['TestQueueWorkerProcess', 'TestInboxProcess']]);
});

test('gate · relatório do Go: formato errado, hash divergente ou sem atestado de remetente não passam', () => {
  const r0 = consolidarVerde();
  assert.equal(statusDe(r0, 'go-contract-fixtures'), lib.PASS);
  assert.equal(statusDe(r0, 'no-default-sender-env'), lib.PASS);

  const hash = relatorioGoDoPainel();
  hash.contracts['sender-contract-v1.json'].sha256 = '0'.repeat(64);
  assert.equal(statusDe(consolidarVerde({ relatorioGo: hash }), 'go-contract-fixtures'), lib.FAIL);

  const versao = relatorioGoDoPainel();
  versao.contracts['inbound-context-v1.json'].version = 2;
  assert.equal(statusDe(consolidarVerde({ relatorioGo: versao }), 'go-contract-version'), lib.FAIL);

  assert.equal(statusDe(consolidarVerde({ relatorioGo: relatorioGoDoPainel({ default_sender_env_absent: undefined }) }), 'no-default-sender-env'), lib.NAO_VERIFICADO);
  assert.equal(statusDe(consolidarVerde({ relatorioGo: relatorioGoDoPainel({ default_sender_env_absent: false }) }), 'no-default-sender-env'), lib.FAIL);

  const sem = consolidarVerde({ relatorioGo: null });
  assert.equal(statusDe(sem, 'go-contract-fixtures'), lib.NAO_VERIFICADO);
  assert.equal(sem.codeStatus, lib.NAO_VERIFICADO);
  assert.equal(sem.exit, lib.EXIT.CODIGO_BLOQUEADO);

  const arq = path.join(dirVazio('oria-gate-go-'), 'r.json');
  fs.writeFileSync(arq, JSON.stringify({ ...relatorioGoDoPainel(), format: 'outro' }));
  assert.equal(statusDe(consolidarVerde({ relatorioGo: lib.lerRelatorioGo(arq) }), 'go-contract-fixtures'), lib.FAIL);
});

// ── OPS, dogfood e exit code ───────────────────────────────────────────────────────────────────

test('gate · CODE PASS com OPS e dogfood pendentes → OVERALL BLOCKED, exit 2; --report-only → exit 0 declarado não-gate', () => {
  const r = consolidarVerde();
  assert.equal(r.codeStatus, lib.PASS, JSON.stringify(r.code.filter((c) => c.status !== lib.PASS), null, 2));
  assert.equal(r.overall, 'BLOCKED');
  assert.equal(r.exit, lib.EXIT.ROLLOUT_BLOQUEADO);
  assert.ok(r.ops.every((o) => o.status === lib.NAO_VERIFICADO));
  assert.equal(r.ops.find((o) => o.id === 'OPS-27').status, lib.NAO_VERIFICADO);
  assert.equal(r.dogfood.status, 'NOT STARTED');
  assert.deepEqual(r.ops.map((o) => o.id), Array.from({ length: 36 }, (_, i) => `OPS-${String(i + 1).padStart(2, '0')}`));

  const texto = lib.formatarRelatorio(r);
  assert.match(texto, /^CODE GATES: PASS$/m);
  assert.match(texto, /^ {2}OPS-27 {2}NOT VERIFIED/m);
  assert.match(texto, /^DOGFOOD GATE: 14 days NOT STARTED$/m);
  assert.match(texto, /^OVERALL: BLOCKED/m);
  assert.match(texto, /^exit 2$/m);
  assert.equal(r.mode, 'gate');
  assert.equal(r.gate, true);
  assert.doesNotMatch(texto, /NÃO É UM GATE/);

  const rel = consolidarVerde({ soRelatorio: true });
  assert.equal(rel.exit, lib.EXIT.PRONTO);
  assert.equal(rel.gateExit, lib.EXIT.ROLLOUT_BLOQUEADO, 'o relatório mostra o exit que o gate daria');
  assert.equal(rel.overall, 'BLOCKED');
  assert.equal(rel.mode, 'report-only');
  assert.equal(rel.gate, false);
  const textoRel = lib.formatarRelatorio(rel);
  assert.match(textoRel, /^REPORT ONLY — ISTO NÃO É UM GATE/m);
  assert.match(textoRel, /^exit 0 \(--report-only: informativo; o gate sairia com 2\)$/m);
});

test('gate · CODE bloqueado → exit 1 (e --report-only continua mostrando gateExit 1)', () => {
  const eventos = estaticosVerdes();
  eventos[0].status = 'fail';
  const r = consolidarVerde({ eventosEstaticos: eventos });
  assert.equal(r.codeStatus, lib.FAIL);
  assert.equal(r.exit, lib.EXIT.CODIGO_BLOQUEADO);
  assert.equal(consolidarVerde({ eventosEstaticos: null }).exit, lib.EXIT.CODIGO_BLOQUEADO);
  const rel = consolidarVerde({ eventosEstaticos: eventos, soRelatorio: true });
  assert.equal(rel.exit, lib.EXIT.PRONTO);
  assert.equal(rel.gateExit, lib.EXIT.CODIGO_BLOQUEADO);
});

// ── Semântica de saída (rodada 19, §12) + controle negativo ───────────────────────────────────

// Evidência completa com o relógio do teste: todos os OPS VERIFIED, OPS-14 (release final) antes do
// início do dogfood, e o dogfood com 15 dias.
const INICIO_DOGFOOD = '2026-10-01T00:00:00Z';
const AGORA_FECHADO = new Date('2026-10-16T00:00:00Z');

// Formato da rodada 19: início registrado no rollout; os dias vêm do relógio.
function dogfood(extra = {}) {
  return {
    format: lib.FORMATO_EVIDENCIA_OPS, id: 'DOGFOOD', environment: 'production', recorded_by: 'operador',
    dogfood_started_at: INICIO_DOGFOOD, dogfood_required_days: 14, open_incidents: 0, ...extra,
  };
}

function dogfoodEmAndamento() {
  return dogfood();
}

function dirProntoParaFechar() {
  const dir = dirVazio('oria-gate-ev-');
  for (const { id } of lib.CATALOGO_OPS) evidencia(dir, id);
  fs.writeFileSync(path.join(dir, 'DOGFOOD.json'), JSON.stringify(dogfood()));
  return dir;
}

// Verifica, contra QUALQUER gate-lib (a real ou uma cópia defeituosa), que exit 0 só existe com
// OVERALL READY. Devolve a lista de violações (vazia = semântica correta).
function violacoesDeSaida(alvo) {
  const verde = {
    raiz: RAIZ_REPO, suite: suiteVerde(), eventosEstaticos: estaticosVerdes(), goDir: null,
    relatorioGo: relatorioGoDoPainel(), goTestes: GO_VERDE, goHead: null, geradorTestes: GERADOR_VERDE,
    agora: AGORA_FECHADO,
  };
  const pronto = dirProntoParaFechar();
  const semOps27 = dirProntoParaFechar();
  fs.rmSync(path.join(semOps27, 'OPS-27.json'));
  const semDogfood = dirProntoParaFechar();
  fs.rmSync(path.join(semDogfood, 'DOGFOOD.json'));
  const dogfoodCurto = dirProntoParaFechar();
  fs.writeFileSync(path.join(dogfoodCurto, 'DOGFOOD.json'), JSON.stringify(dogfoodEmAndamento()));
  const falha = estaticosVerdes();
  falha[0].status = 'fail';

  const casos = [
    ['OPS pendentes e dogfood NOT STARTED', { dirEvidencia: dirVazio('oria-gate-ev-') }, lib.EXIT.ROLLOUT_BLOQUEADO],
    ['só OPS-27 pendente', { dirEvidencia: semOps27 }, lib.EXIT.ROLLOUT_BLOQUEADO],
    ['dogfood NOT STARTED', { dirEvidencia: semDogfood }, lib.EXIT.ROLLOUT_BLOQUEADO],
    ['dogfood em andamento', { dirEvidencia: dogfoodCurto, agora: new Date('2026-10-05T00:00:00Z') }, lib.EXIT.ROLLOUT_BLOQUEADO],
    ['CODE FAIL com tudo verificado', { dirEvidencia: pronto, eventosEstaticos: falha }, lib.EXIT.CODIGO_BLOQUEADO],
    ['CODE NOT VERIFIED (suíte não rodou)', { dirEvidencia: pronto, suite: null }, lib.EXIT.CODIGO_BLOQUEADO],
    ['tudo pronto', { dirEvidencia: pronto }, lib.EXIT.PRONTO],
  ];
  const problemas = [];
  for (const [nome, extra, esperado] of casos) {
    const r = alvo.consolidar({ ...verde, ...extra });
    if (r.exit !== esperado) problemas.push(`${nome}: exit ${r.exit}, esperado ${esperado}`);
    if ((r.exit === 0) !== (r.overall === 'READY')) problemas.push(`${nome}: exit ${r.exit} com OVERALL ${r.overall}`);
  }
  for (const d of [pronto, semOps27, semDogfood, dogfoodCurto]) fs.rmSync(d, { recursive: true, force: true });
  return problemas;
}

test('gate · exit 0 SOMENTE com OVERALL READY (todos os caminhos bloqueados saem ≠ 0)', () => {
  assert.deepEqual(violacoesDeSaida(lib), []);
});

const MUTACOES_DE_SAIDA = [
  {
    nome: 'volta o --code-only: CODE PASS decide sozinho',
    de: 'return overall === \'READY\' ? EXIT.PRONTO : EXIT.ROLLOUT_BLOQUEADO;',
    para: 'return EXIT.PRONTO; // VIOLAÇÃO DELIBERADA',
  },
  {
    nome: 'dogfood fora do overall',
    de: "if (dogfood.status !== 'COMPLETED') bloqueios.push(`DOGFOOD ${dogfood.status}`);",
    para: '// VIOLAÇÃO DELIBERADA: dogfood não bloqueia',
  },
  {
    nome: 'modo relatório vira padrão',
    de: 'soRelatorio = false, agora',
    para: 'soRelatorio = true, agora',
  },
];

MUTACOES_DE_SAIDA.forEach((m, i) => {
  test(`gate · negative control de saída ${i + 1} · ${m.nome} · passa → viola → FALHA → restaura → passa`, async () => {
    const dir = dirVazio('oria-gate-lib-');
    const alvo = path.join(dir, 'gate-lib.mjs');
    const original = fs.readFileSync(path.join(RAIZ_REPO, 'scripts', 'productization', 'gate-lib.mjs'), 'utf8');
    const carregar = async (conteudo, n) => {
      const arq = alvo.replace(/\.mjs$/, `-${n}.mjs`);
      fs.writeFileSync(arq, conteudo);
      return import(pathToFileURL(arq));
    };
    try {
      assert.deepEqual(violacoesDeSaida(await carregar(original, 1)), [], '[1] cópia intacta');
      assert.equal(original.split(m.de).length - 1, 1, `trecho não encontrado exatamente uma vez: ${m.de}`);
      const violado = violacoesDeSaida(await carregar(original.replace(m.de, m.para), 3));
      assert.notDeepEqual(violado, [], `[3] a verificação não pegou: ${m.nome}`);
      assert.deepEqual(violacoesDeSaida(await carregar(original, 5)), [], '[5] cópia restaurada');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('gate · READY só com todos os OPS VERIFIED (ou NOT_APPLICABLE justificado) e 14 dias de dogfood pelo relógio', () => {
  const dir = dirVazio('oria-gate-ev-');
  for (const { id } of lib.CATALOGO_OPS) evidencia(dir, id);
  evidencia(dir, 'OPS-17', { status: 'NOT_APPLICABLE', reason: 'a base de produção já está depois da Fase 1' });
  const r0 = consolidarVerde({ dirEvidencia: dir, agora: AGORA_FECHADO });
  assert.equal(r0.overall, 'BLOCKED', 'sem dogfood ainda');
  assert.deepEqual(r0.bloqueios, ['DOGFOOD NOT STARTED']);

  fs.writeFileSync(path.join(dir, 'DOGFOOD.json'), JSON.stringify(dogfood()));
  assert.equal(lib.avaliarDogfood(dir, { agora: new Date('2026-10-05T00:00:00Z') }).status, 'IN PROGRESS');
  assert.equal(lib.avaliarDogfood(dir, { agora: new Date('2026-10-14T23:59:59Z') }).status, 'IN PROGRESS', '13 dias e 23 h');
  assert.equal(lib.avaliarDogfood(dir, { agora: new Date('2026-10-15T00:00:00Z') }).status, 'COMPLETED', '14 dias exatos');

  const r = consolidarVerde({ dirEvidencia: dir, agora: AGORA_FECHADO });
  assert.equal(r.overall, 'READY', r.bloqueios.join(', '));
  assert.equal(r.exit, lib.EXIT.PRONTO);
  assert.equal(r.ops.find((o) => o.id === 'OPS-17').status, 'NOT APPLICABLE');
  assert.match(lib.formatarRelatorio(r), /^DOGFOOD GATE: 14 days COMPLETED$/m);

  // O mesmo arquivo, avaliado no relógio real (17/09/2026, antes do início registrado), não fecha.
  const hoje = consolidarVerde({ dirEvidencia: dir, agora: new Date('2026-09-17T12:00:00Z') });
  assert.equal(hoje.dogfood.status, lib.FAIL);
  assert.equal(hoje.exit, lib.EXIT.ROLLOUT_BLOQUEADO);

  // Retirar só o OPS-27 volta a bloquear.
  fs.rmSync(path.join(dir, 'OPS-27.json'));
  const sem27 = consolidarVerde({ dirEvidencia: dir, agora: AGORA_FECHADO });
  assert.deepEqual(sem27.bloqueios, ['OPS-27 NOT VERIFIED']);
  assert.equal(sem27.exit, lib.EXIT.ROLLOUT_BLOQUEADO);
});

// ── Dogfood factual (rodada 19, §13) ──────────────────────────────────────────────────────────

// Diretório com OPS-14 e OPS-36 VERIFIED (ou alterados por `ops14`/`ops36`) e o DOGFOOD.json dado
// (null = sem arquivo).
function dirDogfood(dados, { ops14 = {}, semOps14 = false, ops36 = {}, semOps36 = false } = {}) {
  const dir = dirVazio('oria-gate-dog-');
  if (!semOps14) evidencia(dir, 'OPS-14', ops14);
  if (!semOps36) evidencia(dir, 'OPS-36', ops36);
  if (dados !== null) fs.writeFileSync(path.join(dir, 'DOGFOOD.json'), typeof dados === 'string' ? dados : JSON.stringify(dados));
  return dir;
}

const DIA_1 = new Date('2026-10-02T00:00:00Z');

// Cenários que qualquer implementação do dogfood precisa respeitar. Devolve as violações.
function violacoesDeDogfood(alvo) {
  const legado = {
    format: lib.FORMATO_EVIDENCIA_OPS, id: 'DOGFOOD', environment: 'production', recorded_by: 'operador',
    started_at: INICIO_DOGFOOD, status: 'COMPLETED', ended_at: '2026-10-16T00:00:00Z', open_incidents: 0,
  };
  const casos = [
    ['sem arquivo', null, {}, AGORA_FECHADO, 'NOT STARTED'],
    ['1 dia pelo relógio', dogfood(), {}, DIA_1, 'IN PROGRESS'],
    ['15 dias pelo relógio', dogfood(), {}, AGORA_FECHADO, 'COMPLETED'],
    ['marcação manual COMPLETED com 1 dia real', legado, {}, DIA_1, lib.FAIL],
    ['marcação manual COMPLETED mesmo com 15 dias', legado, {}, AGORA_FECHADO, lib.FAIL],
    ['status/ended_at acrescentados ao formato novo', dogfood({ status: 'COMPLETED', ended_at: '2026-10-16T00:00:00Z' }), {}, DIA_1, lib.FAIL],
    ['declara 1 dia exigido', dogfood({ dogfood_required_days: 1 }), {}, new Date('2026-10-03T00:00:00Z'), lib.FAIL],
    ['declara 1 dia exigido, mesmo com 15 dias', dogfood({ dogfood_required_days: 1 }), {}, AGORA_FECHADO, lib.FAIL],
    ['declara 14 como texto', dogfood({ dogfood_required_days: '14' }), {}, AGORA_FECHADO, lib.FAIL],
    ['início no futuro', dogfood(), {}, new Date('2026-09-17T12:00:00Z'), lib.FAIL],
    ['início só com data', dogfood({ dogfood_started_at: '2026-10-01' }), {}, AGORA_FECHADO, lib.FAIL],
    ['início sem fuso', dogfood({ dogfood_started_at: '2026-10-01T00:00:00' }), {}, AGORA_FECHADO, lib.FAIL],
    ['início em data inexistente', dogfood({ dogfood_started_at: '2026-09-31T00:00:00Z' }), {}, AGORA_FECHADO, lib.FAIL],
    ['início ilegível', dogfood({ dogfood_started_at: 'ontem' }), {}, AGORA_FECHADO, lib.FAIL],
    ['início numérico', dogfood({ dogfood_started_at: Date.parse(INICIO_DOGFOOD) }), {}, AGORA_FECHADO, lib.FAIL],
    ['sem dogfood_started_at', dogfood({ dogfood_started_at: undefined }), {}, AGORA_FECHADO, lib.FAIL],
    ['sem OPS-14 (release final)', dogfood(), { semOps14: true }, AGORA_FECHADO, lib.FAIL],
    ['OPS-14 NOT_APPLICABLE', dogfood(), { ops14: { status: 'NOT_APPLICABLE', reason: 'não se aplica por algum motivo' } }, AGORA_FECHADO, lib.FAIL],
    ['OPS-14 inválido', dogfood(), { ops14: { environment: 'staging' } }, AGORA_FECHADO, lib.FAIL],
    ['início antes da release final', dogfood(), { ops14: { verified_at: '2026-10-05T00:00:00Z' } }, new Date('2026-10-30T00:00:00Z'), lib.FAIL],
    ['início no mesmo instante da release final', dogfood(), { ops14: { verified_at: INICIO_DOGFOOD } }, AGORA_FECHADO, 'COMPLETED'],
    ['sem OPS-36 (rotação do ADMIN_SESSION_SECRET)', dogfood(), { semOps36: true }, AGORA_FECHADO, lib.FAIL],
    ['OPS-36 NOT_APPLICABLE', dogfood(), { ops36: { status: 'NOT_APPLICABLE', reason: 'não se aplica por algum motivo' } }, AGORA_FECHADO, lib.FAIL],
    ['início antes da rotação final', dogfood(), { ops36: { verified_at: '2026-10-05T00:00:00Z' } }, new Date('2026-10-30T00:00:00Z'), lib.FAIL],
    ['incidente aberto no fechamento', dogfood({ open_incidents: 1 }), {}, AGORA_FECHADO, lib.FAIL],
    ['incidente aberto durante', dogfood({ open_incidents: 1 }), {}, DIA_1, 'IN PROGRESS'],
    ['sem open_incidents', dogfood({ open_incidents: undefined }), {}, AGORA_FECHADO, lib.FAIL],
    ['environment staging', dogfood({ environment: 'staging' }), {}, AGORA_FECHADO, lib.FAIL],
    ['sem recorded_by', dogfood({ recorded_by: '' }), {}, AGORA_FECHADO, lib.FAIL],
    ['id trocado', dogfood({ id: 'OPS-14' }), {}, AGORA_FECHADO, lib.FAIL],
    ['arquivo quebrado', '{ quebrado', {}, AGORA_FECHADO, lib.FAIL],
    ['arquivo que não é objeto', '[]', {}, AGORA_FECHADO, lib.FAIL],
    ['campo sensível', dogfood({ api_token: 'x' }), {}, AGORA_FECHADO, lib.FAIL],
  ];
  const problemas = [];
  for (const [nome, dados, opcoes, agora, esperado] of casos) {
    const dir = dirDogfood(dados, opcoes);
    try {
      const r = alvo.avaliarDogfood(dir, { agora });
      if (r.status !== esperado) problemas.push(`${nome}: ${r.status} (esperado ${esperado}) · ${r.detalhes.join(' | ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return problemas;
}

test('gate · dogfood factual: dias pelo relógio desde dogfood_started_at, 14 fixos, depois do OPS-14', () => {
  assert.deepEqual(violacoesDeDogfood(lib), []);
  assert.equal(lib.DIAS_DE_DOGFOOD, 14);
  assert.deepEqual(lib.REFERENCIAS_DO_DOGFOOD, ['OPS-14', 'OPS-36']);
});

test('gate · dogfood: relógio injetável — o mesmo arquivo passa de IN PROGRESS a COMPLETED só pelo tempo', () => {
  const dir = dirDogfood(dogfood());
  try {
    const estados = ['2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z', '2026-10-14T23:59:59.999Z', '2026-10-15T00:00:00Z']
      .map((x) => lib.avaliarDogfood(dir, { agora: new Date(x) }));
    assert.deepEqual(estados.map((e) => e.status), ['IN PROGRESS', 'IN PROGRESS', 'IN PROGRESS', 'COMPLETED']);
    assert.match(estados[1].detalhes[0], /^dia 7 de 14 desde 2026-10-01T00:00:00Z/);
    assert.throws(() => lib.avaliarDogfood(dir, { agora: new Date('x') }), /relógio inválido/);
    // Sem relógio injetado vale o do processo: hoje o início registrado ainda é futuro.
    if (Date.now() < Date.parse(INICIO_DOGFOOD)) assert.equal(lib.avaliarDogfood(dir).status, lib.FAIL);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MUTACOES_DE_DOGFOOD = [
  {
    nome: 'status COMPLETED declarado fecha o gate',
    trocas: [["  const d = ev.dados;\n  if (!d || typeof d !== 'object'",
      "  const d = ev.dados;\n  if (d && d.status === 'COMPLETED' && d.ended_at) return { status: 'COMPLETED', detalhes: ['VIOLAÇÃO DELIBERADA'] };\n  if (!d || typeof d !== 'object'"]],
  },
  {
    nome: 'dias exigidos lidos do arquivo',
    trocas: [
      ["Object.prototype.hasOwnProperty.call(d, 'dogfood_required_days') && d.dogfood_required_days !== DIAS_DE_DOGFOOD", 'false /* VIOLAÇÃO DELIBERADA */'],
      ['if (dias < DIAS_DE_DOGFOOD) return', 'if (dias < (Number(d.dogfood_required_days) || DIAS_DE_DOGFOOD)) return'],
    ],
  },
  {
    nome: 'sem referência da release final',
    trocas: [['for (const id of REFERENCIAS_DO_DOGFOOD) {', 'for (const id of [/* VIOLAÇÃO DELIBERADA */]) {']],
  },
  {
    nome: 'início no futuro aceito',
    trocas: [['else if (inicio > agoraMs)', 'else if (false /* VIOLAÇÃO DELIBERADA */)']],
  },
  {
    nome: 'formato do início só por Date.parse',
    trocas: [['const inicio = lerInstante(d.dogfood_started_at);', 'const inicio = Number.isNaN(Date.parse(d.dogfood_started_at)) ? null : Date.parse(d.dogfood_started_at); // VIOLAÇÃO DELIBERADA']],
  },
];

MUTACOES_DE_DOGFOOD.forEach((m, i) => {
  test(`gate · negative control de dogfood ${i + 1} · ${m.nome} · passa → viola → FALHA → restaura → passa`, async () => {
    const dir = dirVazio('oria-gate-lib-');
    const original = fs.readFileSync(path.join(RAIZ_REPO, 'scripts', 'productization', 'gate-lib.mjs'), 'utf8');
    const carregar = async (conteudo, n) => {
      const arq = path.join(dir, `gate-lib-${n}.mjs`);
      fs.writeFileSync(arq, conteudo);
      return import(pathToFileURL(arq));
    };
    try {
      assert.deepEqual(violacoesDeDogfood(await carregar(original, 1)), [], '[1] cópia intacta');
      let violado = original;
      for (const [de, para] of m.trocas) {
        assert.equal(violado.split(de).length - 1, 1, `trecho não encontrado exatamente uma vez: ${de}`);
        violado = violado.replace(de, para);
      }
      assert.notDeepEqual(violacoesDeDogfood(await carregar(violado, 3)), [], `[3] a verificação não pegou: ${m.nome}`);
      assert.deepEqual(violacoesDeDogfood(await carregar(original, 5)), [], '[5] cópia restaurada');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('gate · evidência OPS inválida é FAIL, nunca VERIFIED', () => {
  const casos = [
    ['status PASS', { status: 'PASS' }],
    ['sem evidence', { evidence: '' }],
    ['staging', { environment: 'staging' }],
    ['id trocado', { id: 'OPS-28' }],
    ['formato', { format: 'x' }],
    ['data', { verified_at: 'ontem' }],
    ['N/A sem motivo', { status: 'NOT_APPLICABLE' }],
    ['token Meta no texto', { evidence: `webhook ok com EAAG${'x'.repeat(30)}` }],
    ['hex longo', { evidence: `segredo ${'a'.repeat(64)}` }],
    ['url com senha', { evidence: 'postgres://postgres:senha@host/db' }],
    ['campo sensível', { app_secret: 'qualquer' }],
  ];
  for (const [nome, extra] of casos) {
    const dir = dirVazio('oria-gate-ev-');
    evidencia(dir, 'OPS-27', extra);
    const o = lib.avaliarOps(dir).find((x) => x.id === 'OPS-27');
    assert.equal(o.status, lib.FAIL, `${nome}: ${o.status}`);
  }
  const dir = dirVazio('oria-gate-ev-');
  fs.writeFileSync(path.join(dir, 'OPS-27.json'), '{ quebrado');
  assert.equal(lib.avaliarOps(dir).find((x) => x.id === 'OPS-27').status, lib.FAIL);
  assert.equal(lib.avaliarOps(dir).find((x) => x.id === 'OPS-28').status, lib.NAO_VERIFICADO);
});

test('gate · o repositório não traz evidência OPS de produção (nada foi verificado nesta fase)', () => {
  const dir = path.join(RAIZ_REPO, lib.DIR_EVIDENCIA_PADRAO);
  const arquivos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : [];
  assert.deepEqual(arquivos, []);
});

// ── CLI contra cópia com violação (ciclo de 5 passos) ──────────────────────────────────────────

function copiarSujeito() {
  const raiz = dirVazio('oria-gate-nc-');
  for (const d of ['lib', 'routes', 'scripts', 'migrations', path.join('test', 'fixtures')]) {
    fs.cpSync(path.join(RAIZ_REPO, d), path.join(raiz, d), { recursive: true });
  }
  fs.copyFileSync(path.join(RAIZ_REPO, 'server.js'), path.join(raiz, 'server.js'));
  fs.mkdirSync(path.join(raiz, 'test', 'invariants'), { recursive: true });
  // lib/auth carrega express: a cópia resolve dependências pelas do repositório.
  fs.symlinkSync(path.join(RAIZ_REPO, 'node_modules'), path.join(raiz, 'node_modules'), 'dir');
  return raiz;
}

// Repositório Go mínimo com as cópias de contrato e o que o gate procura no código.
function goSintetico() {
  const dir = dirVazio('oria-gate-go-');
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module sintetico\n\ngo 1.22\n');
  fs.mkdirSync(path.join(dir, 'testdata'));
  for (const c of lib.CONTRATOS_GO) {
    fs.copyFileSync(path.join(RAIZ_REPO, 'test', 'fixtures', 'whatsapp', c.arquivo), path.join(dir, 'testdata', c.arquivo));
  }
  const sender = JSON.parse(fs.readFileSync(path.join(RAIZ_REPO, 'test', 'fixtures', 'whatsapp', 'sender-contract-v1.json'), 'utf8'));
  const contexto = JSON.parse(fs.readFileSync(path.join(RAIZ_REPO, 'test', 'fixtures', 'whatsapp', 'inbound-context-v1.json'), 'utf8'));
  const repasse = JSON.parse(fs.readFileSync(path.join(RAIZ_REPO, 'test', 'fixtures', 'whatsapp', 'forward-auth-v1.json'), 'utf8'));
  const consts = [
    ...Object.values(sender.headers).map((h, i) => `\th${i} = "${h}"`),
    ...Object.values(contexto.endpoints).map((e, i) => `\te${i} = "${e.path.split('/').pop()}"`),
    `\tf0 = "${repasse.auth.timestamp_header}"`,
    `\tf1 = "${repasse.auth.signature_header}"`,
  ];
  fs.writeFileSync(path.join(dir, 'identity.go'), `package main\n\nconst (\n${consts.join('\n')}\n)\n`);
  // Teste pode citar as variáveis antigas (é assim que o Go prova que não as lê).
  fs.writeFileSync(path.join(dir, 'sender_test.go'), 'package main\n\nvar _ = "META_ACCESS_TOKEN"\n');
  return dir;
}

function rodarGate(raiz, goDir, extra = []) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.WHATSAPP_GO_DIR;
  const r = spawnSync(process.execPath, [GATE, '--skip-suite', '--json', '--root', raiz, '--go-dir', goDir,
    '--evidence-dir', dirVazio('oria-gate-ev-'), ...extra], { cwd: RAIZ_REPO, encoding: 'utf8', env, timeout: 120000 });
  assert.ok(r.stdout, `gate sem saída JSON (exit ${r.status}):\n${r.stderr}`);
  return { exit: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
}

const status = (r, id) => r.json.code.find((c) => c.id === id);

function substituir(arquivo, de, para) {
  const original = fs.readFileSync(arquivo, 'utf8');
  assert.equal(original.split(de).length - 1, 1, `trecho não encontrado exatamente uma vez em ${arquivo}`);
  fs.writeFileSync(arquivo, original.replace(de, para));
  return () => fs.writeFileSync(arquivo, original);
}

function acrescentar(arquivo, texto) {
  const original = fs.readFileSync(arquivo, 'utf8');
  fs.writeFileSync(arquivo, `${original}\n${texto}\n`);
  return () => fs.writeFileSync(arquivo, original);
}

const VIOLACOES = [
  {
    check: 'no-tenant-selector',
    limpo: 'PASS',
    aplicar: (raiz) => substituir(path.join(raiz, 'server.js'), "app.post('/api/webhooks/whatsapp', (req, res) => {",
      "app.post('/api/webhooks/whatsapp', (req, res) => {\n  const lojaPedida = req.query.loja;"),
  },
  {
    check: 'no-cross-org-aggregation',
    limpo: 'NOT VERIFIED',
    aplicar: (raiz) => acrescentar(path.join(raiz, 'lib', 'platform', 'ownership.js'), 'const multiStoreMode = true;'),
  },
  {
    check: 'no-unsafe-truncate',
    limpo: 'PASS',
    // scripts/ não é coberto pelo fase3-static: esta violação só o check novo do gate pega.
    aplicar: (raiz) => acrescentar(path.join(raiz, 'scripts', 'tenancy', 'seed-entitlements.mjs'), "// limpeza\nawait pool.query('TRUNCATE pedidos_ink, campaigns');"),
  },
  {
    check: 'no-unsafe-truncate',
    limpo: 'PASS',
    aplicar: (raiz) => acrescentar(path.join(raiz, 'migrations', '1790000120000_job-leases.js'), 'const limpar = (pgm, t) => pgm.sql(`TRUNCATE ${t}`);'),
  },
  {
    check: 'no-legacy-ink-route',
    limpo: 'PASS',
    aplicar: (raiz) => substituir(path.join(raiz, 'server.js'), "app.post('/api/webhooks/ink/:token', async (req, res) => {",
      "app.all('/api/webhooks/ink', (req, res) => res.sendStatus(410));\napp.post('/api/webhooks/ink/:token', async (req, res) => {"),
  },
  {
    check: 'no-default-sender-env',
    limpo: 'PASS',
    aplicar: (raiz) => acrescentar(path.join(raiz, 'lib', 'platform', 'whatsapp-sender.js'), 'const remetentePadrao = process.env.META_PHONE_NUMBER_ID;'),
  },
  {
    check: 'no-default-sender-env',
    limpo: 'PASS',
    aplicar: (raiz, goDir) => acrescentar(path.join(goDir, 'identity.go'), 'var fallback = os.Getenv("META_ACCESS_TOKEN")'),
  },
  {
    check: 'go-contract-fixtures',
    limpo: 'NOT VERIFIED',
    aplicar: (raiz, goDir) => substituir(path.join(goDir, 'testdata', 'inbound-context-v1.json'), '"rate_limited": 429', '"rate_limited": 503'),
  },
  {
    check: 'go-contract-version',
    limpo: 'PASS',
    aplicar: (raiz, goDir) => {
      const volta = substituir(path.join(goDir, 'identity.go'), '"X-Sender-Ref"', '"X-Sender-Reference"');
      return volta;
    },
  },
  {
    check: 'go-contract-version',
    limpo: 'PASS',
    aplicar: (raiz) => substituir(path.join(raiz, 'test', 'fixtures', 'whatsapp', 'sender-contract-v1.json'), '"version": 1,', '"version": 2,'),
  },
  {
    check: 'no-global-tenant-credential',
    limpo: 'PASS',
    aplicar: (raiz) => acrescentar(path.join(raiz, 'lib', 'platform', 'integrations.js'), 'const tokenGlobal = process.env.INK_TOKEN;'),
  },
  {
    check: 'app-role-contract',
    limpo: 'NOT VERIFIED',
    aplicar: (raiz) => substituir(path.join(raiz, 'lib', 'platform', 'app-role.js'), "PASSWORD '${senha}' NOSUPERUSER NOBYPASSRLS", "PASSWORD '${senha}' NOSUPERUSER BYPASSRLS"),
  },
  {
    check: 'app-role-contract',
    limpo: 'NOT VERIFIED',
    aplicar: (raiz) => substituir(path.join(raiz, 'server.js'), 'if (exigirRoleDaAplicacao()) {', 'if (false && exigirRoleDaAplicacao()) {'),
  },
  {
    check: 'integration-env-fallback',
    limpo: 'NOT VERIFIED',
    aplicar: (raiz) => substituir(path.join(raiz, 'lib', 'platform', 'integrations.js'),
      "return String(env.ALLOW_LEGACY_INTEGRATION_ENV || '').trim() === '1';",
      "return String(env.ALLOW_LEGACY_INTEGRATION_ENV || '').trim() !== '0';"),
  },
  {
    check: 'legacy-admin-auth',
    limpo: 'PASS',
    aplicar: (raiz) => substituir(path.join(raiz, 'lib', 'auth', 'index.js'), "habilitado: flag === '1',", "habilitado: flag !== '0',"),
  },
];

test('gate CLI · --root sem --skip-suite é uso inválido; opção desconhecida também', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const a = spawnSync(process.execPath, [GATE, '--root', os.tmpdir()], { encoding: 'utf8', env });
  assert.equal(a.status, lib.EXIT.USO);
  const b = spawnSync(process.execPath, [GATE, '--skip-suite', '--sem-isso'], { encoding: 'utf8', env });
  assert.equal(b.status, lib.EXIT.USO);
});

test('gate CLI · cópia intacta: checks estáticos verdes, suíte NOT VERIFIED, exit 1', () => {
  const raiz = copiarSujeito();
  const goDir = goSintetico();
  const r = rodarGate(raiz, goDir);
  assert.equal(r.exit, lib.EXIT.CODIGO_BLOQUEADO);
  for (const id of ['no-tenant-selector', 'legacy-admin-auth', 'go-contract-version', 'no-global-tenant-credential',
    'no-unsafe-truncate', 'no-legacy-ink-route', 'no-default-sender-env']) {
    assert.equal(status(r, id).status, lib.PASS, `${id}: ${status(r, id).detalhes}`);
  }
  for (const id of ['suite', 'invariants', 'no-skipped', 'rls-schema', 'go-tests']) assert.equal(status(r, id).status, lib.NAO_VERIFICADO, id);
  assert.equal(r.json.overall, 'BLOCKED');
  assert.equal(r.json.dogfood.status, 'NOT STARTED');
  fs.rmSync(raiz, { recursive: true, force: true });
  fs.rmSync(goDir, { recursive: true, force: true });
});

VIOLACOES.forEach((v, i) => {
  test(`gate CLI · negative control ${i + 1} · ${v.check} · passa → viola → FALHA → restaura → passa`, { timeout: 180000 }, () => {
    const raiz = copiarSujeito();
    const goDir = goSintetico();
    try {
      const antes = status(rodarGate(raiz, goDir), v.check);
      assert.equal(antes.status, v.limpo, `[1] ${v.check} no estado correto: ${antes.detalhes}`);
      const desfazer = v.aplicar(raiz, goDir);
      const violado = rodarGate(raiz, goDir);
      assert.equal(status(violado, v.check).status, lib.FAIL, `[3] ${v.check} não reprovou a violação: ${status(violado, v.check).detalhes}`);
      assert.equal(violado.exit, lib.EXIT.CODIGO_BLOQUEADO);
      desfazer();
      const depois = status(rodarGate(raiz, goDir), v.check);
      assert.equal(depois.status, v.limpo, `[5] ${v.check} não voltou: ${depois.detalhes}`);
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
      fs.rmSync(goDir, { recursive: true, force: true });
    }
  });
});

test('gate CLI · sem repositório Go e sem relatório: contratos NOT VERIFIED; com relatório emitido, PASS', () => {
  const raiz = copiarSujeito();
  const goDir = goSintetico();
  const tmp = dirVazio('oria-gate-rel-');
  try {
    const sem = rodarGate(raiz, path.join(tmp, 'nao-existe'));
    assert.equal(status(sem, 'go-contract-fixtures').status, lib.NAO_VERIFICADO);
    assert.equal(status(sem, 'no-default-sender-env').status, lib.NAO_VERIFICADO);

    const arq = path.join(tmp, 'go-report.json');
    const emitido = rodarGate(raiz, goDir, ['--emit-go-report', arq]);
    assert.equal(emitido.exit, lib.EXIT.CODIGO_BLOQUEADO);
    const rel = JSON.parse(fs.readFileSync(arq, 'utf8'));
    assert.equal(rel.format, lib.FORMATO_RELATORIO_GO);
    assert.equal(rel.default_sender_env_absent, true);
    assert.equal(rel.go_tests, null, 'sem suíte não há resultado de go test para atestar');

    const comRel = rodarGate(raiz, path.join(tmp, 'nao-existe'), ['--go-report', arq]);
    assert.equal(status(comRel, 'go-contract-version').status, lib.PASS);
    assert.equal(status(comRel, 'no-default-sender-env').status, lib.PASS);
    assert.equal(status(comRel, 'go-tests').status, lib.NAO_VERIFICADO);
  } finally {
    for (const d of [raiz, goDir, tmp]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('gate CLI · --code-only foi removido (uso inválido); --report-only sai 0 e se declara não-gate', () => {
  const raiz = copiarSujeito();
  const goDir = goSintetico();
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const removido = spawnSync(process.execPath, [GATE, '--skip-suite', '--code-only'], { encoding: 'utf8', env });
    assert.equal(removido.status, lib.EXIT.USO);
    assert.match(removido.stderr, /--code-only foi removido/);

    const gate = rodarGate(raiz, goDir);
    assert.equal(gate.exit, lib.EXIT.CODIGO_BLOQUEADO);
    assert.equal(gate.json.mode, 'gate');

    const rel = rodarGate(raiz, goDir, ['--report-only']);
    assert.equal(rel.exit, 0);
    assert.equal(rel.json.mode, 'report-only');
    assert.equal(rel.json.gate, false);
    assert.equal(rel.json.overall, 'BLOCKED');
    assert.equal(rel.json.gateExit, lib.EXIT.CODIGO_BLOQUEADO);

    const texto = spawnSync(process.execPath, [GATE, '--skip-suite', '--report-only', '--root', raiz, '--go-dir', goDir,
      '--evidence-dir', dirVazio('oria-gate-ev-')], { cwd: RAIZ_REPO, encoding: 'utf8', env, timeout: 120000 });
    assert.equal(texto.status, 0, texto.stderr);
    assert.match(texto.stdout, /^REPORT ONLY — ISTO NÃO É UM GATE/m);
    assert.match(texto.stdout, /^OVERALL: BLOCKED/m);
    assert.match(texto.stdout, /^exit 0 \(--report-only: informativo; o gate sairia com 1\)$/m);
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
    fs.rmSync(goDir, { recursive: true, force: true });
  }
});
