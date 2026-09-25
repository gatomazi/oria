'use strict';

// scripts/clientes/rfm-calibracao.mjs: execução SEGURA da calibração na base real. Sem banco (guardas de alvo e de caminho) e
// com banco descartável (somente leitura de fato, escopo da Organization, nenhum dado pessoal na saída, cobertura por backfill).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const h = require('./harness');
const { inserir, limparCache } = require('../helpers/linhas');

const SCRIPT = path.join(h.RAIZ_SUJEITO, 'scripts', 'clientes', 'rfm-calibracao.mjs');
const ORG = 'ca000000-0000-4000-8000-000000000001';
const OUTRA = 'ca000000-0000-4000-8000-000000000002';
const STORE = 'cb000000-0000-4000-8000-000000000001';
const STORE_OUTRA = 'cb000000-0000-4000-8000-000000000002';
const SEGREDO = `senha-${crypto.randomBytes(6).toString('hex')}`;

function rodar(env, argv) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'), ...env }, timeout: 60000 });
}

test('sem DATABASE_URL o script não faz nada e diz o que falta', () => {
  const r = rodar({}, ['--organization', ORG]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DATABASE_URL/);
});

test('host remoto exige confirmação explícita; a URL (usuário/senha) nunca é impressa', () => {
  const url = `postgres://leitura:${SEGREDO}@replica.exemplo.invalid:5432/oria`;
  const sem = rodar({ DATABASE_URL: url }, ['--organization', ORG]);
  assert.equal(sem.status, 2);
  assert.match(sem.stderr, /replica\.exemplo\.invalid/);
  assert.match(sem.stderr, /--confirmo-host replica\.exemplo\.invalid/);
  const errado = rodar({ DATABASE_URL: url }, ['--organization', ORG, '--confirmo-host', 'outro-host']);
  assert.equal(errado.status, 2);
  for (const r of [sem, errado]) {
    assert.ok(!r.stdout.includes(SEGREDO) && !r.stderr.includes(SEGREDO), 'a senha não pode aparecer');
    assert.ok(!r.stderr.includes('leitura:'), 'nem o usuário na forma da URL');
  }
});

test('saída dentro do repositório só em caminho ignorado pelo Git; nada é gravado no caminho recusado', () => {
  const url = `postgres://u:${SEGREDO}@localhost:1/x`;
  const naoIgnorado = path.join(h.RAIZ_REPO, 'docs-calibracao-teste.md');
  const r = rodar({ DATABASE_URL: url }, ['--organization', ORG, '--md', naoIgnorado]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NÃO é ignorado pelo Git/);
  assert.equal(fs.existsSync(naoIgnorado), false);
  // Caminho ignorado passa da guarda (e só então falha por não haver banco em localhost:1, sem vazar a senha).
  const ignorado = path.join(h.RAIZ_REPO, 'relatorios-privados', 'teste-guarda.md');
  const ok = rodar({ DATABASE_URL: url }, ['--organization', ORG, '--md', ignorado]);
  assert.notEqual(ok.status, 0);
  assert.doesNotMatch(ok.stderr, /NÃO é ignorado/);
  assert.ok(!ok.stdout.includes(SEGREDO) && !ok.stderr.includes(SEGREDO));
  assert.equal(fs.existsSync(ignorado), false);
  fs.rmSync(path.join(h.RAIZ_REPO, 'relatorios-privados'), { recursive: true, force: true });
});

let db;
let sup;
const DOCS = ['91100000001', '91100000002', '91100000003'];
test.before(async () => {
  db = await h.criarBancoDescartavel('oria_calib');
  const m = h.migrar(db.url);
  assert.equal(m.status, 0, `${m.stdout.slice(-1500)}${m.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  limparCache();
  for (const [org, store, nome] of [[ORG, STORE, 'Loja Sigilosa Alfa'], [OUTRA, STORE_OUTRA, 'Loja Sigilosa Beta']]) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, nome]);
    await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [store, org, nome]);
  }
  let id = 500;
  const dia = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  // A cobertura conta dias de calendário no fuso da Organization: a data do backfill também é a de São Paulo (nada de UTC).
  const diaSaoPaulo = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - n * 86_400_000));
  const pedido = (org, store, doc, dias, extra = {}) => inserir(sup, 'pedidos_ink', {
    organization_id: org, store_id: store, loja: null, ink_order_id: ++id, payment_status: 'paid', order_status: 'sent', buyer_nome: `Nome Secreto ${doc}`,
    buyer_documento: doc, buyer_telefone: `${doc.slice(0, 3)}55${doc.slice(-6)}`, buyer_email: `${doc}@sigiloso.test`, total_value: 100, criado_em: dia(dias), frete: 10, descontos: 0, is_troca: false, ...extra,
  });
  for (let i = 0; i < 40; i += 1) await pedido(ORG, STORE, `9200000${String(i).padStart(4, '0')}`, 5 + i * 4);
  for (const d of DOCS) { await pedido(ORG, STORE, d, 30); await pedido(ORG, STORE, d, 90); }
  await pedido(OUTRA, STORE_OUTRA, '93000000001', 10); // outra Organization: nunca pode entrar
  await sup.query(`INSERT INTO pedidos_backfill_jobs (organization_id, store_id, loja, desde, status) VALUES ($1, $2, NULL, $3, 'concluido')`, [ORG, STORE, diaSaoPaulo(200)]);
});
test.after(async () => { await sup?.end(); await db?.destruir(); });

const contagens = async () => (await sup.query('SELECT (SELECT count(*) FROM pedidos_ink) AS p, (SELECT count(*) FROM pedidos_backfill_jobs) AS b, (SELECT count(*) FROM audit_log) AS a')).rows[0];

test('com banco: relatório só da Organization pedida, sem dado pessoal, somente leitura e com a cobertura do backfill', async () => {
  const antes = await contagens();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-calib-'));
  const r = rodar({ DATABASE_URL: db.url }, ['--organization', ORG, '--json', path.join(dir, 'r.json'), '--md', path.join(dir, 'r.md')]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const texto = fs.readFileSync(path.join(dir, 'r.json'), 'utf8') + fs.readFileSync(path.join(dir, 'r.md'), 'utf8') + r.stdout + r.stderr;
  assert.ok(!/Nome Secreto|sigiloso\.test|92000000|9110000|9300000|(920|911|930)55\d/.test(texto), 'nenhum documento, telefone, e-mail ou nome na saída');
  assert.ok(!texto.includes(db.url) && !texto.includes('postgres://'), 'a URL de conexão não aparece');
  const rel = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
  assert.equal(rel.integridade.linhas, 46, 'só as linhas da Organization pedida (a outra tem 1)');
  assert.equal(rel.universo.compradores, 43);
  assert.equal(rel.cobertura.backfillConfirmado, true);
  assert.equal(rel.cobertura.coberturaConfirmadaDias, 200);
  assert.equal(rel.cobertura.cobertura365Confirmada, false);
  assert.equal(rel.cobertura.ultimoBackfillStatus, 'concluido');
  assert.equal(rel.metodologia.origem.hostConfirmado.length > 0, true);
  assert.deepEqual(await contagens(), antes, 'nada foi gravado');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('com banco: Organization inexistente é recusada antes de ler qualquer pedido', () => {
  const r = rodar({ DATABASE_URL: db.url }, ['--organization', 'ca000000-0000-4000-8000-0000000000ff']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /não tem Store visível/);
  assert.equal(r.stdout, '');
});

test('com banco: --listar-organizacoes mostra só ids e contagens (nenhum nome de loja)', () => {
  const r = rodar({ DATABASE_URL: db.url }, ['--listar-organizacoes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${ORG}\\s+stores=1\\s+pedidos_ink=46`));
  assert.ok(!/Sigilosa/.test(r.stdout), 'nome da loja não é exibido');
});
