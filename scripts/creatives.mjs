#!/usr/bin/env node
// Gerador de Criativos (apps/creative-generator) a partir da raiz do monorepo.
//
//   node scripts/creatives.mjs test    roda run_tests.py com um Python que tenha as dependências
//
// Interpretador, nesta ordem: CREATIVE_PYTHON, apps/creative-generator/.venv/bin/python, python3.
// Não há fallback silencioso: sem Pillow, o run_tests.py falha e o comando sai ≠ 0.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(RAIZ, 'apps', 'creative-generator');

export function pythonDoGerador() {
  const venv = path.join(APP, '.venv', 'bin', 'python');
  const candidatos = [process.env.CREATIVE_PYTHON, fs.existsSync(venv) ? venv : null, 'python3'].filter(Boolean);
  return candidatos[0];
}

function testar() {
  const python = pythonDoGerador();
  console.log(`[creatives] ${python} run_tests.py (${path.relative(RAIZ, APP)})`);
  const r = spawnSync(python, ['run_tests.py'], { cwd: APP, stdio: 'inherit' });
  if (r.error) {
    console.error(`[creatives] não consegui executar ${python}: ${r.error.message}\n` +
      '  defina CREATIVE_PYTHON ou crie o venv: python3.12 -m venv apps/creative-generator/.venv && ' +
      'apps/creative-generator/.venv/bin/pip install -r apps/creative-generator/requirements.txt');
    return 1;
  }
  return r.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const comando = process.argv[2] || 'test';
  if (comando !== 'test') {
    console.error('uso: node scripts/creatives.mjs test');
    process.exit(64);
  }
  process.exit(testar());
}
