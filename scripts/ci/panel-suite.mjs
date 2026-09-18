#!/usr/bin/env node
// Runner de um grupo/shard da suíte do painel — local e em CI, com a MESMA regra de isolamento.
//
// Invariante que este arquivo existe para impor (D18/D23 da rodada 21; já custou 28 falsas falhas
// quando dois testes de banco dividiram o mesmo container):
//
//     NENHUM shard de banco compartilha Postgres com outro.
//
// Em CI, cada job tem o seu `services: postgres` — o isolamento é da própria plataforma, um banco
// por job. Localmente, o nome do container sai do grupo/shard: `oria-test-pg-db-2` nunca colide com
// `oria-test-pg-db-3`. Quem passa TEST_DATABASE_URL à mão assume a responsabilidade pelo isolamento.
//
// Uso:
//   node scripts/ci/panel-suite.mjs --group pure --shards 2 --index 1
//   node scripts/ci/panel-suite.mjs --group db --shards 4 --index 2 [--app-role]
//   node scripts/ci/panel-suite.mjs --group db --shards 4 --index 2 --list
//   node scripts/ci/panel-suite.mjs --group pure --report scripts/ci/weights.json
//
// `--app-role` roda com TEST_APP_ROLE=1: a aplicação conecta como `oria_app`
// (NOSUPERUSER/NOBYPASSRLS), que é o que produção usa e o que prova RLS/tenancy.
// `--report <arquivo>` acrescenta ao arquivo o tempo medido por arquivo de teste (pesos do shard).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RAIZ, RAIZ_PAINEL, shardDe } from './suites.mjs';

function opcao(argv, nome, padrao) {
  const i = argv.indexOf(`--${nome}`);
  return i === -1 ? padrao : argv[i + 1];
}

function executar(cmd, args, env) {
  return new Promise((resolve) => {
    const filho = spawn(cmd, args, { cwd: RAIZ_PAINEL, stdio: 'inherit', env });
    filho.on('exit', (code) => resolve(code ?? 1));
  });
}

// Soma as durações por arquivo a partir do JSONL do reporter e grava/atualiza o mapa de pesos.
function consolidarPesos(jsonl, destino) {
  if (!fs.existsSync(jsonl)) return;
  const soma = {};
  for (const linha of fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean)) {
    let ev;
    try { ev = JSON.parse(linha); } catch { continue; }
    if (!ev.file) continue;
    const rel = path.relative(RAIZ_PAINEL, ev.file).split(path.sep).join('/');
    soma[rel] = Math.round(((soma[rel] || 0) + (ev.ms || 0) / 1000) * 10) / 10;
  }
  const caminho = path.isAbsolute(destino) ? destino : path.join(RAIZ, destino);
  const atual = fs.existsSync(caminho) ? JSON.parse(fs.readFileSync(caminho, 'utf8')) : {};
  fs.writeFileSync(caminho, `${JSON.stringify({ ...atual, ...soma }, null, 2)}\n`);
  console.error(`[panel-suite] pesos atualizados em ${path.relative(RAIZ, caminho)} (${Object.keys(soma).length} arquivos)`);
}

async function main(argv) {
  const grupo = opcao(argv, 'group', 'db');
  if (grupo !== 'pure' && grupo !== 'db') throw new Error(`grupo inválido: ${grupo}`);
  const shards = Number(opcao(argv, 'shards', '1'));
  const index = Number(opcao(argv, 'index', '1'));
  const appRole = argv.includes('--app-role');
  const relatorio = opcao(argv, 'report', null);

  const arquivos = shardDe(grupo, shards, index);
  if (!arquivos.length) {
    console.error(`[panel-suite] nenhum arquivo em ${grupo} ${index}/${shards} — isso é erro, não sucesso`);
    return 1;
  }
  if (argv.includes('--list')) {
    console.log(arquivos.join('\n'));
    return 0;
  }

  const env = { ...process.env };
  const jsonl = relatorio ? path.join(RAIZ_PAINEL, `.ci-durations-${grupo}-${index}.jsonl`) : null;
  const testes = [
    '--test', '--test-concurrency=1',
    ...(jsonl ? [
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${path.join(RAIZ, 'scripts', 'ci', 'duration-reporter.mjs')}`,
      `--test-reporter-destination=${jsonl}`,
    ] : []),
    ...arquivos,
  ];

  let code;
  if (grupo === 'pure') {
    // Grupo sem banco: nada de Postgres, nada de migrations. Arquivo mal classificado reprova alto
    // aqui (o harness lança sem INVARIANTS_DATABASE_URL) — nunca se pula.
    delete env.TEST_DATABASE_URL;
    delete env.DATABASE_URL;
    code = await executar(process.execPath, testes, env);
  } else {
    if (appRole) env.TEST_APP_ROLE = '1';
    if (!env.TEST_DATABASE_URL && !env.TEST_PG_CONTAINER) env.TEST_PG_CONTAINER = `oria-test-pg-${grupo}-${index}`;
    code = await executar(
      process.execPath,
      [path.join(RAIZ_PAINEL, 'scripts', 'test-db.mjs'), 'run', '--', process.execPath, ...testes],
      env,
    );
  }

  if (jsonl) { consolidarPesos(jsonl, relatorio); fs.rmSync(jsonl, { force: true }); }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`[panel-suite] ${err.message}`);
    process.exit(1);
  });
}
