#!/usr/bin/env node
// Traduz a saída do Second Tenant Gate para o summary do GitHub Actions, PRESERVANDO a semântica do
// gate — que é o ponto todo: nem tratar rollout bloqueado como regressão de código, nem esconder
// que o rollout está bloqueado.
//
// Contrato de saída do gate (apps/panel/scripts/productization/gate.mjs):
//   0  CODE PASS + OPS verificados + dogfood cumprido  → OVERALL READY
//   1  CODE bloqueado (check FAIL ou NOT VERIFIED)     → regressão/bloqueio de CÓDIGO
//   2  CODE PASS, OVERALL BLOCKED                      → pendência OPERACIONAL de rollout
//   64 uso inválido
//
// O que este script faz com cada um, no nightly de engenharia:
//   0  → job verde
//   1  → job VERMELHO (é regressão de código)
//   2  → job verde, com `PRODUCTIZATION ROLLOUT = BLOCKED` em destaque no summary
//   64 ou JSON ilegível → job VERMELHO (não saber o estado nunca é sucesso)
//
// Para um gate de release/rollout a régua é outra: lá só 0 passa. Quem quiser essa régua roda
// `--strict`.
//
//   node scripts/ci/gate-summary.mjs --json <arquivo> --exit <código> [--strict]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function opcao(argv, nome) {
  const i = argv.indexOf(`--${nome}`);
  return i === -1 ? null : argv[i + 1];
}

function escrever(linhas) {
  const texto = `${linhas.join('\n')}\n`;
  process.stdout.write(texto);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, texto);
}

function main(argv) {
  const arquivo = opcao(argv, 'json');
  const saidaDoGate = Number(opcao(argv, 'exit'));
  const estrito = argv.includes('--strict');

  if (!arquivo || !Number.isInteger(saidaDoGate)) {
    console.error('uso: gate-summary.mjs --json <arquivo> --exit <código> [--strict]');
    return 2;
  }

  let r;
  try {
    r = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch (err) {
    escrever([
      '## Second Tenant Gate', '',
      `**Não foi possível ler o relatório do gate** (${err.message}).`,
      `O gate saiu com ${saidaDoGate}. Estado desconhecido é reprovação: silêncio não é sucesso.`,
    ]);
    return 1;
  }

  // Os campos vêm do gate; nada aqui é inventado nem reinterpretado.
  const ops = Array.isArray(r.ops) ? r.ops : [];
  const pendentes = ops.filter((o) => !['VERIFIED', 'NOT APPLICABLE'].includes(o.status));
  const reprovados = (Array.isArray(r.code) ? r.code : []).filter((c) => c.status !== 'PASS');

  const linhas = ['## Second Tenant Gate', ''];
  if (saidaDoGate === 2) linhas.push('> ### PRODUCTIZATION ROLLOUT = BLOCKED', '>', '> O CÓDIGO está pronto. O que falta é operacional (OPS e/ou dogfood) — não é regressão.', '');
  linhas.push(
    '| bloco | estado |', '|---|---|',
    `| CODE | \`${r.codeStatus ?? '?'}\` |`,
    `| OPS | ${ops.length ? `${ops.length - pendentes.length}/${ops.length} verificados` : '—'} |`,
    `| DOGFOOD | \`${r.dogfood?.status ?? '?'}\` |`,
    `| OVERALL | \`${r.overall ?? '?'}\` |`,
    `| exit do gate | \`${saidaDoGate}\`${Number.isInteger(r.gateExit) ? ` (gateExit \`${r.gateExit}\`)` : ''} |`,
    '',
  );

  if (reprovados.length) {
    linhas.push('### Checks de CODE que não passaram', '');
    for (const c of reprovados) {
      linhas.push(`- **${c.status}** · ${c.titulo}`);
      for (const d of (c.detalhes || []).slice(0, 5)) linhas.push(`  - ${d}`);
    }
    linhas.push('');
  }
  if (pendentes.length) {
    linhas.push('### OPS pendentes', '');
    for (const o of pendentes) linhas.push(`- **${o.status}** · ${o.id}${o.titulo ? ` — ${o.titulo}` : ''}`);
    linhas.push('');
  }
  if (Array.isArray(r.bloqueios) && r.bloqueios.length) {
    linhas.push('### Bloqueios declarados pelo gate', '', ...r.bloqueios.map((b) => `- ${b}`), '');
  }

  let saida;
  if (saidaDoGate === 0) { saida = 0; linhas.push('Resultado: **OVERALL READY**.'); }
  else if (saidaDoGate === 2) {
    saida = estrito ? 1 : 0;
    linhas.push(estrito
      ? 'Resultado: **rollout bloqueado** — e `--strict` exige OVERALL READY, então o job reprova.'
      : 'Resultado: **código verde, rollout bloqueado**. O job segue verde: pendência operacional não é regressão de código.');
  } else if (saidaDoGate === 1) { saida = 1; linhas.push('Resultado: **CODE bloqueado** — isto é regressão ou check não verificado. O job reprova.'); }
  else { saida = 1; linhas.push(`Resultado: exit \`${saidaDoGate}\` (uso inválido ou erro interno do gate). O job reprova.`); }

  escrever(linhas);
  return saida;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
