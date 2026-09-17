#!/usr/bin/env node
// Executor da suíte para o Second Tenant Gate. Roda DENTRO de `scripts/test-db.mjs run`, que já
// exportou as URLs do Postgres efêmero. Não decide nada: grava eventos e códigos de saída em --out
// e o gate.mjs avalia.
//
//   node scripts/productization/gate-suite.mjs --out <dir> [--go-dir <dir>]
//
// Saídas em <dir>:
//   suite.jsonl       um evento por teste (gate-reporter.mjs), com o arquivo de origem
//   suite-exit.json   { exitCode }
//   go-tests.json     (com --go-dir) { vet, build, test, race, pass, fail, skipped, head }

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resumirGoTestJson } from './gate-lib.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i === -1 ? null : process.argv[i + 1];
}

// O runner do Node injeta NODE_TEST_CONTEXT; um filho que o herda acha que já está dentro de um
// teste e sai 0 sem rodar nada.
function envLimpo(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function rodarSuite(out) {
  const arquivos = [
    ...fs.readdirSync(path.join(RAIZ, 'test')).filter((x) => x.endsWith('.test.js')).sort().map((x) => path.join('test', x)),
    ...fs.readdirSync(path.join(RAIZ, 'test', 'invariants')).filter((x) => x.endsWith('.test.js')).sort().map((x) => path.join('test', 'invariants', x)),
  ];
  const filho = spawn(process.execPath, [
    '--test', '--test-concurrency=1',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${path.join(RAIZ, 'scripts', 'productization', 'gate-reporter.mjs')}`,
    `--test-reporter-destination=${path.join(out, 'suite.jsonl')}`,
    ...arquivos,
  ], { cwd: RAIZ, stdio: 'inherit', env: envLimpo() });
  return new Promise((resolve) => filho.on('exit', (c) => resolve(c ?? 1)));
}

async function comBancoGo(fn) {
  const base = process.env.INVARIANTS_DATABASE_URL;
  if (!base) throw new Error('INVARIANTS_DATABASE_URL ausente — rode por scripts/test-db.mjs run');
  const nome = `oria_go_gate_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${nome}`);
    return await fn(`${base.replace(/\/[^/]+$/, `/${nome}`)}?sslmode=disable`);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

async function rodarGo(goDir, out) {
  const head = spawnSync('git', ['-C', goDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null;
  const sujo = spawnSync('git', ['-C', goDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim();
  const go = (args, env = {}) => spawnSync('go', args, { cwd: goDir, encoding: 'utf8', env: envLimpo(env), maxBuffer: 256 * 1024 * 1024 });
  console.log(`[gate] go vet / build / test -race em ${goDir} (${head}${sujo ? ', com mudanças locais' : ''})`);
  const vet = go(['vet', './...']);
  const build = go(['build', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '.']);
  const resultado = await comBancoGo(async (url) => {
    const t = go(['test', '-race', '-count=1', '-json', './...'], { WEBHOOK_TEST_DATABASE_URL: url });
    return { status: t.status, ...resumirGoTestJson(t.stdout || '') };
  });
  const r = {
    vet: vet.status, build: build.status, test: resultado.status, race: true,
    pass: resultado.pass, fail: resultado.fail, skipped: resultado.skipped, pulos_esperados: resultado.pulosEsperados,
    head: sujo ? `${head}+dirty` : head,
  };
  if (vet.status !== 0) console.log(vet.stderr);
  if (build.status !== 0) console.log(build.stderr);
  console.log(`[gate] Go: vet ${r.vet} · build ${r.build} · test ${r.test} (${r.pass} pass, ${r.fail} fail, pulados ${r.skipped.length})`);
  fs.writeFileSync(path.join(out, 'go-tests.json'), JSON.stringify(r, null, 2));
}

async function main() {
  const out = arg('--out');
  if (!out) { console.error('uso: gate-suite.mjs --out <dir> [--go-dir <dir>]'); return 64; }
  fs.mkdirSync(out, { recursive: true });
  const exitCode = await rodarSuite(out);
  fs.writeFileSync(path.join(out, 'suite-exit.json'), JSON.stringify({ exitCode }));
  const goDir = arg('--go-dir');
  if (goDir) await rodarGo(goDir, out);
  // O código de saída da suíte é informação para o gate, não o resultado deste executor.
  return 0;
}

main().then((c) => process.exit(c), (err) => { console.error(`[gate-suite] ${err.message}`); process.exit(1); });
