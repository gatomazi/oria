#!/usr/bin/env node
// Teste único do monorepo: os três componentes + os contratos compartilhados.
//
//   npm test                     tudo
//   npm test -- --skip panel     pula uma etapa (para iteração local; nunca use no gate/CI)
//
// Regra: se qualquer etapa falhar, este comando sai ≠ 0. Uma etapa que não pôde rodar conta como
// falha, nunca como silêncio.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pulados = process.argv.filter((a, i) => process.argv[i - 1] === '--skip');

const ETAPAS = [
  { id: 'self-check', titulo: 'repositório autocontido (sem caminho local nem repo de origem)', cmd: [process.execPath, ['scripts/repo-self-check.mjs']] },
  { id: 'contracts', titulo: 'contratos cross-service (fonte canônica == cópias)', cmd: [process.execPath, ['scripts/check-contracts.mjs']] },
  { id: 'panel', titulo: 'painel · npm test (suíte + invariants + E2E com o binário Go)', cmd: ['npm', ['--prefix', 'apps/panel', 'test']] },
  { id: 'panel-build', titulo: 'painel · npm run build (SPA → dist/)', cmd: ['npm', ['--prefix', 'apps/panel', 'run', 'build']] },
  // O control plane é outro deployable, mas roda sobre o MESMO schema do painel: `test-db.mjs`
  // aplica as migrations do painel antes da suíte. Por isso ele vem depois do painel aqui.
  { id: 'platform-admin', titulo: 'control plane · npm test (Oria Admin sobre o schema do painel)', cmd: ['npm', ['--prefix', 'apps/platform-admin', 'test']] },
  { id: 'creatives', titulo: 'gerador de criativos · run_tests.py', cmd: [process.execPath, ['scripts/creatives.mjs', 'test']] },
  { id: 'whatsapp', titulo: 'serviço whatsapp · go vet + build + test -race', cmd: [process.execPath, ['scripts/whatsapp.mjs', 'test']] },
];

const resultados = [];
for (const etapa of ETAPAS) {
  if (pulados.includes(etapa.id)) {
    resultados.push({ ...etapa, status: 'PULADA (--skip)' , ok: false, pulada: true });
    console.log(`\n=== ${etapa.id}: PULADA por --skip ===`);
    continue;
  }
  console.log(`\n=== ${etapa.id}: ${etapa.titulo} ===`);
  const [cmd, args] = etapa.cmd;
  const r = spawnSync(cmd, args, { cwd: RAIZ, stdio: 'inherit' });
  const ok = r.status === 0;
  resultados.push({ ...etapa, ok, status: ok ? 'OK' : `FALHOU (exit ${r.status ?? 'erro'})` });
}

console.log('\n─── resumo ───');
for (const r of resultados) console.log(`${r.ok ? 'OK  ' : 'ERR '} ${r.id.padEnd(12)} ${r.status}`);
const falhas = resultados.filter((r) => !r.ok);
if (falhas.length) {
  console.log(`\n${falhas.length} etapa(s) sem OK: ${falhas.map((f) => f.id).join(', ')}`);
  process.exit(1);
}
console.log('\ntodas as etapas OK');
