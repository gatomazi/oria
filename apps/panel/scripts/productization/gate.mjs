#!/usr/bin/env node
// Second Tenant Gate executável — `npm run productization:gate` (rodada 18, trilha D, §27-29;
// semântica de saída e dogfood factual: rodada 19, §12-13).
//
// Uso:
//   npm run productization:gate                           # O GATE: CODE + OPS + DOGFOOD decidem o exit code
//   npm run productization:gate -- --report-only          # só relatório (NÃO é gate: sai 0 mesmo bloqueado)
//   npm run productization:gate -- --report-only --json   # idem em JSON (campos codeStatus, overall, gateExit)
//   npm run productization:gate -- --skip-suite           # não roda a suíte (os checks dela ficam NOT VERIFIED)
//
// Opções:
//   --report-only          informativo: imprime o relatório e sai 0 (salvo uso inválido/erro interno).
//                          O relatório avisa que não é gate e mostra o exit que o gate daria (gateExit).
//                          Nunca use em CI/release como condição de avanço.
//   --skip-suite           não roda `npm test`; checks derivados da suíte = NOT VERIFIED
//   --no-go-tests          não roda go vet/build/test -race (check go-tests = NOT VERIFIED, salvo --go-report)
//   --go-dir <dir>         repositório do Go (padrão: WHATSAPP_GO_DIR ou ../whatsapp-webhook-go)
//   --go-report <arquivo>  relatório do Go (formato oria-go-gate-report/v1) quando o repositório não está disponível
//   --emit-go-report <arq> grava o relatório do Go a partir de --go-dir (e dos testes Go, se rodados) e segue
//   --evidence-dir <dir>   evidências OPS/dogfood (padrão: docs/produtizacao-saas/ops-evidence)
//   --root <dir>           raiz avaliada pelas checagens estáticas (controle negativo); exige --skip-suite
//   --json                 relatório em JSON no stdout
//   --verbose              detalhes de todos os checks
//
// `--code-only` (rodada 18) foi REMOVIDO na rodada 19: saía 0 com OVERALL BLOCKED. Passá-lo é uso
// inválido (64). Para saber só se o código está pronto: o gate padrão sai 1 (código bloqueado) ou 2
// (código PASS, rollout bloqueado); ou `--report-only --json` e o campo `codeStatus`.
//
// Exit code (modo gate, o padrão):
//   0   SOMENTE com OVERALL READY: CODE PASS + todos os OPS VERIFIED/NOT_APPLICABLE + dogfood COMPLETED
//   1   CODE bloqueado (algum check FAIL ou NOT VERIFIED) — OVERALL BLOCKED
//   2   CODE PASS, mas OVERALL BLOCKED (OPS pendentes e/ou dogfood não cumprido)
//   64  uso inválido (inclui --code-only)
// Com --report-only: 0 (ou 64 / 1 por uso inválido / erro interno).
//
// Dogfood: os dias vêm do relógio (agora − dogfood_started_at do DOGFOOD.json), nunca de status ou
// data de fim declarados; ver avaliarDogfood em gate-lib.mjs e production-rollout-runbook.md.
//
// A suíte roda num Postgres efêmero próprio (scripts/test-db.mjs, TEST_PG_CONTAINER). Nada aqui toca
// produção, Railway ou segredo real.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIR_EVIDENCIA_PADRAO, EXIT, consolidar, formatarRelatorio, gerarRelatorioGo, lerEventos, lerRelatorioGo,
} from './gate-lib.mjs';

const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FLAGS = new Set(['--report-only', '--skip-suite', '--no-go-tests', '--json', '--verbose']);
const REMOVIDAS = new Map([
  ['--code-only', '--code-only foi removido (saía 0 com OVERALL BLOCKED). Use o gate padrão (exit 1 = código bloqueado, 2 = só rollout bloqueado) ou --report-only --json (campo codeStatus)'],
]);
const COM_VALOR = new Set(['--go-dir', '--go-report', '--emit-go-report', '--evidence-dir', '--root']);

function lerArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (REMOVIDAS.has(a)) throw new Error(REMOVIDAS.get(a));
    if (FLAGS.has(a)) o[a.slice(2)] = true;
    else if (COM_VALOR.has(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${a} exige um valor`);
      o[a.slice(2)] = argv[i + 1];
      i += 1;
    } else throw new Error(`opção desconhecida: ${a}`);
  }
  return o;
}

function envLimpo(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Testes estáticos existentes, contra `raiz` (INVARIANT_SUBJECT_ROOT). Sem banco.
function rodarEstaticos(raiz, tmp) {
  const destino = path.join(tmp, 'estaticos.jsonl');
  const r = spawnSync(process.execPath, [
    '--test',
    `--test-reporter=${path.join(RAIZ_REPO, 'scripts', 'productization', 'gate-reporter.mjs')}`,
    `--test-reporter-destination=${destino}`,
    path.join(RAIZ_REPO, 'test', 'invariants', 'fase3-static.test.js'),
  ], { cwd: RAIZ_REPO, encoding: 'utf8', env: envLimpo({ INVARIANT_SUBJECT_ROOT: raiz }), timeout: 120000 });
  if (r.error) throw r.error;
  return lerEventos(destino);
}

function rodarSuite(tmp, goDir, saidaParaStderr) {
  const args = [path.join(RAIZ_REPO, 'scripts', 'test-db.mjs'), 'run', '--',
    process.execPath, path.join(RAIZ_REPO, 'scripts', 'productization', 'gate-suite.mjs'), '--out', tmp];
  if (goDir) args.push('--go-dir', goDir);
  const filho = spawn(process.execPath, args, {
    cwd: RAIZ_REPO,
    // Com --json o stdout é do relatório: a saída da suíte vai para o stderr.
    stdio: ['ignore', saidaParaStderr ? process.stderr : 'inherit', 'inherit'],
    env: envLimpo(),
  });
  return new Promise((resolve) => filho.on('exit', (c) => resolve(c ?? 1))).then((codigo) => {
    const exitArq = path.join(tmp, 'suite-exit.json');
    if (codigo !== 0 || !fs.existsSync(exitArq)) {
      // O Postgres não subiu ou o executor morreu: a suíte NÃO rodou — isso é falha, não ausência.
      return { exitCode: codigo || 1, eventos: lerEventos(path.join(tmp, 'suite.jsonl')), executorFalhou: true };
    }
    const { exitCode } = JSON.parse(fs.readFileSync(exitArq, 'utf8'));
    const goArq = path.join(tmp, 'go-tests.json');
    return {
      exitCode,
      eventos: lerEventos(path.join(tmp, 'suite.jsonl')),
      goTestes: fs.existsSync(goArq) ? JSON.parse(fs.readFileSync(goArq, 'utf8')) : null,
    };
  });
}

function headDoGo(goDir) {
  if (!goDir || !fs.existsSync(path.join(goDir, 'go.mod'))) return null;
  const r = spawnSync('git', ['-C', goDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const sujo = spawnSync('git', ['-C', goDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout?.trim();
  const head = r.status === 0 ? r.stdout.trim() : null;
  return head && sujo ? `${head}+dirty` : head;
}

async function main() {
  let o;
  try {
    o = lerArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[gate] ${err.message}`);
    return EXIT.USO;
  }
  const raiz = path.resolve(o.root || RAIZ_REPO);
  if (raiz !== RAIZ_REPO && !o['skip-suite']) {
    console.error('[gate] --root só avalia checagens estáticas: use junto com --skip-suite');
    return EXIT.USO;
  }
  const goDirPadrao = process.env.WHATSAPP_GO_DIR || path.resolve(RAIZ_REPO, '..', 'whatsapp-webhook-go');
  const goDir = path.resolve(o['go-dir'] || goDirPadrao);
  const temGo = fs.existsSync(path.join(goDir, 'go.mod'));
  const relatorioGo = o['go-report'] ? lerRelatorioGo(path.resolve(o['go-report'])) : null;
  const dirEvidencia = path.resolve(o['evidence-dir'] || path.join(RAIZ_REPO, DIR_EVIDENCIA_PADRAO));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-gate-'));
  try {
    const eventosEstaticos = rodarEstaticos(raiz, tmp);

    let suite = null;
    let goTestes = null;
    if (!o['skip-suite']) {
      // O E2E da suíte (fase5c-e2e-whatsapp) e as cópias de contrato leem WHATSAPP_GO_DIR.
      if (temGo) process.env.WHATSAPP_GO_DIR = goDir;
      const r = await rodarSuite(tmp, temGo && !o['no-go-tests'] ? goDir : null, Boolean(o.json));
      suite = { exitCode: r.exitCode, eventos: r.eventos };
      goTestes = r.goTestes;
    }

    const goHead = headDoGo(goDir);
    if (o['emit-go-report']) {
      if (!temGo) {
        console.error(`[gate] --emit-go-report exige o repositório do Go (${goDir})`);
        return EXIT.USO;
      }
      const rel = gerarRelatorioGo(goDir, { goHead, goTestes });
      fs.writeFileSync(path.resolve(o['emit-go-report']), `${JSON.stringify(rel, null, 2)}\n`);
      console.error(`[gate] relatório do Go gravado em ${o['emit-go-report']}`);
    }

    const r = consolidar({
      raiz,
      suite,
      eventosEstaticos,
      goDir: temGo ? goDir : null,
      relatorioGo,
      goTestes,
      goHead,
      dirEvidencia,
      soRelatorio: Boolean(o['report-only']),
    });

    if (o.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    else console.log(`\n${formatarRelatorio(r, { detalhado: Boolean(o.verbose) })}`);
    return r.exit;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(`[gate] ${err.stack || err.message}`); process.exit(EXIT.CODIGO_BLOQUEADO); }
);
