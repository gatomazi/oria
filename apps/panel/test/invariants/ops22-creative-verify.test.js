'use strict';

// OPS-22 (rodada 19, trilha G) — o que o runbook executa: `tenancy:mover-criativos --verificar` contra
// um Postgres real (referências da Organization sob RLS, numa transação READ ONLY), a CLI sem
// vazamento de caminho/URL, e o boot que recusa configuração parcial/inválida da leitura dupla.
// A lógica de leitura (antes/durante/depois, duas Organizations, traversal) está em
// ops22-creative-dual-read.test.js, que é o alvo dos negative controls.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const h = require('./harness');

const MOVER = path.join(h.RAIZ_REPO, 'scripts', 'tenancy', 'mover-criativos.mjs');
const SERVER = path.join(h.RAIZ_REPO, 'server.js');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_1 = 'a1000000-0000-4000-8000-000000000001';
const ORG_2 = 'a1000000-0000-4000-8000-000000000002';
const LEGADO = 'default';
const CHAVE_VALIDA = crypto.randomBytes(32).toString('base64');

let db;
let sup;

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_ops22');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 2 });
});

test.after(async () => {
  await sup?.end();
  await db?.destruir();
});

async function emOrg(org, fn) {
  const c = await sup.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_organization_id', $1, true)", [org]);
    await fn(c);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

// Produto (1 referência), lote + geração com a mesma referência no plano, e asset — no banco e no disco.
async function semear(org, uploads, tenantDir) {
  const productId = crypto.randomUUID();
  const creativeId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const ref = `products/${productId}/${crypto.randomUUID()}.png`;
  const storageKey = `creatives/${creativeId}/image.png`;
  const bufRef = crypto.randomBytes(64);
  const bufAsset = crypto.randomBytes(80);
  for (const [rel, buf] of [[ref, bufRef], [storageKey, bufAsset]]) {
    const abs = path.join(uploads, 'creatives', 'tenant', tenantDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  }
  await emOrg(org, async (c) => {
    await c.query(
      `INSERT INTO creative_products (id, tenant_id, name, type, references_json, organization_id)
       VALUES ($1, $2, 'p', 't', $3::jsonb, $2::text::uuid)`,
      [productId, org, JSON.stringify([{ ref, mime: 'image/png', sizeBytes: bufRef.length }])]
    );
    await c.query(
      `INSERT INTO creative_jobs (id, tenant_id, engine, product_mode, input, organization_id)
       VALUES ($1, $2, 'e', 'single', '{}'::jsonb, $2::text::uuid)`, [jobId, org]
    );
    await c.query(
      `INSERT INTO creative_generations (creative_id, tenant_id, job_id, item_index, request, plan, engine, product_mode, organization_id)
       VALUES ($1, $2, $3, 0, '{}'::jsonb, $4::jsonb, 'e', 'single', $2::text::uuid)`,
      [creativeId, org, jobId, JSON.stringify({ references: [{ ref }] })]
    );
    await c.query(
      `INSERT INTO creative_assets (id, tenant_id, creative_id, storage_key, mime_type, byte_size, sha256, organization_id)
       VALUES ($1, $2, $3, $4, 'image/png', $5, $6, $2::text::uuid)`,
      [crypto.randomUUID(), org, creativeId, storageKey, bufAsset.length, crypto.createHash('sha256').update(bufAsset).digest('hex')]
    );
  });
  return { ref, storageKey };
}

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [MOVER, ...args], {
    cwd: h.RAIZ_REPO, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { status: r.status, saida: `${r.stdout || ''}${r.stderr || ''}` };
}

function semVazamento(saida, uploads) {
  const u = new URL(db.url);
  assert.ok(!saida.includes(uploads), 'caminho absoluto na saída');
  assert.ok(!saida.includes(db.url) && !saida.includes(`@${u.host}`), 'URL do banco na saída');
  if (u.password) assert.ok(!saida.includes(u.password), 'senha do banco na saída');
}

test('OPS-22 · CLI: verificar reprova antes, aplicar move, verificar aprova — só com a Organization pedida', async (t) => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ops22-cli-'));
  t.after(() => fs.rmSync(uploads, { recursive: true, force: true }));
  const legados = [await semear(ORG_1, uploads, LEGADO), await semear(ORG_1, uploads, LEGADO)];
  const jaNoNovo = await semear(ORG_1, uploads, ORG_1);
  // Outra Organization com referência sem arquivo: não entra na verificação da primeira.
  await semear(ORG_2, uploads, 'nao-usado');

  const base = ['--uploads', uploads, '--de', LEGADO, '--para', ORG_1];
  const env = { DATABASE_URL: db.url };

  const antes = cli([...base, '--verificar'], env);
  assert.equal(antes.status, 1, antes.saida);
  assert.match(antes.saida, /legado restante: 4/);
  assert.match(antes.saida, /ausente no diretório novo: products\//);
  assert.match(antes.saida, /criativos: FAIL/);
  semVazamento(antes.saida, uploads);

  const simulado = cli(base);
  assert.equal(simulado.status, 0, simulado.saida);
  assert.match(simulado.saida, /4 a mover · 0 já idêntico\(s\) no destino \(simulação; use --aplicar\)/);
  semVazamento(simulado.saida, uploads);

  const aplicado = cli([...base, '--aplicar']);
  assert.equal(aplicado.status, 0, aplicado.saida);
  assert.match(aplicado.saida, /tenant\/default → tenant\/a1000000-0000-4000-8000-000000000001 · 4 movido\(s\)/);
  semVazamento(aplicado.saida, uploads);

  const depois = cli([...base, '--verificar'], env);
  assert.equal(depois.status, 0, depois.saida);
  assert.match(depois.saida, /legado restante: 0 · arquivos no destino: 6/);
  assert.match(depois.saida, /assets no banco: 3 · sha256 conferidos: 3/);
  assert.match(depois.saida, /referências no banco: 3 · presentes: 3/);
  assert.match(depois.saida, /criativos: PASS/);
  semVazamento(depois.saida, uploads);

  const denovo = cli([...base, '--aplicar']);
  assert.equal(denovo.status, 0);
  assert.match(denovo.saida, /nada a mover \(origem inexistente\)/);

  // Arquivo corrompido ou apagado depois: a verificação volta a reprovar.
  const destino = path.join(uploads, 'creatives', 'tenant', ORG_1);
  fs.writeFileSync(path.join(destino, jaNoNovo.storageKey), crypto.randomBytes(80));
  fs.unlinkSync(path.join(destino, legados[0].ref));
  const quebrado = cli([...base, '--verificar'], env);
  assert.equal(quebrado.status, 1, quebrado.saida);
  assert.match(quebrado.saida, /asset com sha256 divergente: creatives\//);
  assert.match(quebrado.saida, /referência ausente no diretório novo: products\//);
  semVazamento(quebrado.saida, uploads);

  // A outra Organization, com a referência sem arquivo, reprova — cada uma é conferida isolada.
  const outra = cli(['--uploads', uploads, '--de', LEGADO, '--para', ORG_2, '--verificar'], env);
  assert.equal(outra.status, 1, outra.saida);
  assert.match(outra.saida, /referências no banco: 1 · presentes: 0/);
});

test('OPS-22 · CLI: vínculo (RELEASE B = 31a7cdb) → PASS-VINCULADO → --desvincular --aplicar → PASS', async (t) => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ops22-vinc-'));
  t.after(() => fs.rmSync(uploads, { recursive: true, force: true }));
  const ORG_3 = 'a1000000-0000-4000-8000-000000000003';
  await semear(ORG_3, uploads, LEGADO);
  await semear(ORG_3, uploads, LEGADO);
  const base = ['--uploads', uploads, '--de', LEGADO, '--para', ORG_3];
  const env = { DATABASE_URL: db.url };

  const sim = cli([...base, '--vincular']);
  assert.equal(sim.status, 0, sim.saida);
  assert.match(sim.saida, /vínculo tenant\/a1000000-0000-4000-8000-000000000003 → tenant\/default · 4 arquivo\(s\) no legado \(simulação; use --aplicar\)/);
  assert.equal(cli([...base, '--vincular', '--aplicar']).status, 0);
  assert.match(cli([...base, '--vincular', '--aplicar']).saida, /nada a vincular \(vínculo já existe\)/);

  const vinculado = cli([...base, '--verificar'], env);
  assert.equal(vinculado.status, 0, vinculado.saida);
  assert.match(vinculado.saida, /estado: vinculado/);
  assert.match(vinculado.saida, /sha256 conferidos: 2/);
  assert.match(vinculado.saida, /criativos: PASS-VINCULADO/);
  semVazamento(vinculado.saida, uploads);

  const recusado = cli([...base, '--aplicar']);
  assert.equal(recusado.status, 1);
  assert.match(recusado.saida, /é o vínculo para tenant\/default: o movimento comum apagaria os arquivos/);
  const simulado = cli(base);
  assert.equal(simulado.status, 1, 'simulação com vínculo também para');
  assert.equal(cli([...base, '--desvincular']).status, 1, '--desvincular exige --aplicar');
  assert.equal(cli([...base, '--vincular', '--desvincular', '--aplicar']).status, 1);
  assert.equal(cli([...base, '--verificar', '--vincular'], env).status, 1);

  const materializado = cli([...base, '--desvincular', '--aplicar']);
  assert.equal(materializado.status, 0, materializado.saida);
  assert.match(materializado.saida, /vínculo tenant\/a1000000-0000-4000-8000-000000000003 removido/);
  assert.match(materializado.saida, /4 movido\(s\)/);
  semVazamento(materializado.saida, uploads);
  const separado = cli([...base, '--verificar'], env);
  assert.equal(separado.status, 0, separado.saida);
  assert.match(separado.saida, /estado: separado/);
  assert.match(separado.saida, /criativos: PASS$/m);
});

test('OPS-22 · CLI: uso inválido e banco ausente não fingem sucesso', () => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ops22-uso-'));
  try {
    const base = ['--uploads', uploads, '--de', LEGADO, '--para', ORG_1];
    assert.equal(cli([...base, '--verificar']).status, 2, 'sem DATABASE_URL');
    assert.equal(cli([...base, '--verificar', '--aplicar'], { DATABASE_URL: db.url }).status, 1);
    const uuidComoOrigem = cli(['--uploads', uploads, '--de', ORG_2, '--para', ORG_1, '--aplicar']);
    assert.equal(uuidComoOrigem.status, 1);
    assert.match(uuidComoOrigem.saida, /--de inválido/);
    const semBanco = cli([...base, '--verificar'], { DATABASE_URL: 'postgres://ninguem:senhaops22@127.0.0.1:1/nada' });
    assert.equal(semBanco.status, 1);
    assert.ok(!semBanco.saida.includes('senhaops22') && !semBanco.saida.includes('ninguem'), semBanco.saida);
  } finally {
    fs.rmSync(uploads, { recursive: true, force: true });
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────────────────────────

function ambiente(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-boot-ops22-'));
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'), PORT: '0',
    NODE_ENV: 'development', DATA_STORE_MODE: 'ephemeral-json', ENCRYPTION_MASTER_KEY: CHAVE_VALIDA,
    ...extra,
  };
}

test('OPS-22 · boot: leitura dupla parcial ou inválida → exit ≠ 0', () => {
  for (const extra of [
    { CREATIVE_LEGACY_READ_FROM: 'default' },
    { CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG_1 },
    { CREATIVE_LEGACY_READ_FROM: ORG_2, CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG_1 },
    { CREATIVE_LEGACY_READ_FROM: '../x', CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG_1 },
  ]) {
    const r = spawnSync(process.execPath, [SERVER], { cwd: h.RAIZ_REPO, encoding: 'utf8', timeout: 20000, env: ambiente(extra) });
    const saida = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.signal, 'SIGTERM', `ficou vivo: ${JSON.stringify(extra)}`);
    assert.notEqual(r.status, 0, `subiu com ${JSON.stringify(extra)}`);
    assert.match(saida, /\[CRIATIVOS\] configuração inválida: CREATIVE_LEGACY_READ_/);
    assert.doesNotMatch(saida, /Orgulho Regional na porta/);
  }
});

test('OPS-22 · boot: leitura dupla válida sobe e avisa que é temporária', async () => {
  const filho = spawn(process.execPath, [SERVER], {
    cwd: h.RAIZ_REPO,
    env: ambiente({ CREATIVE_LEGACY_READ_FROM: 'default', CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG_1 }),
  });
  let saida = '';
  try {
    await new Promise((resolve, reject) => {
      const limite = setTimeout(() => reject(new Error(`não escutou em 20s:\n${saida.slice(-2000)}`)), 20000);
      const ler = (buf) => {
        saida += buf;
        if (/Orgulho Regional na porta/.test(saida)) { clearTimeout(limite); resolve(); }
      };
      filho.stdout.on('data', ler);
      filho.stderr.on('data', ler);
      filho.on('exit', (code) => { clearTimeout(limite); reject(new Error(`saiu com ${code}:\n${saida.slice(-2000)}`)); });
    });
  } finally {
    filho.removeAllListeners('exit');
    filho.kill('SIGKILL');
  }
  assert.match(saida, /OPS-22: leitura legada LIGADA para 1 Organization \(temporária\)/);
  assert.ok(!saida.includes(ORG_1), 'o aviso não repete o id');
});
