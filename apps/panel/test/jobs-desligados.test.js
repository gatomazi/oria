'use strict';

// Isolamento de testes (Rodada 7): `ORIA_JOBS_DE_FUNDO=off` desliga os timers de fundo SÓ fora de produção. Prova que (1) desligado
// não cria timer nem roda job; (2) ligado (padrão) continua agendando; (3) `executarPorOrganizacao` segue disponível para quem chama de
// propósito; (4) em produção o server.js ignora o desligamento e registra erro (não dá para parar a fila de campanhas por engano).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createJobRunner } = require('../lib/platform/jobs');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const logger = () => { const l = { avisos: [], erros: [], warn: (m) => l.avisos.push(m), error: (m) => l.erros.push(m) }; return l; };

test('desligado: agendar e agendarUmaVez não criam timer, não executam nada e avisam UMA vez', async () => {
  const log = logger();
  const jobs = createJobRunner({ poolReal: null, logger: log, desligado: true });
  let chamadas = 0;
  assert.equal(jobs.agendar('job-a', 5, () => { chamadas += 1; }), null);
  assert.equal(jobs.agendar('job-b', 5, () => { chamadas += 1; }), null);
  assert.equal(jobs.agendarUmaVez('job-c', 5, () => { chamadas += 1; }), null);
  await esperar(40);
  assert.equal(chamadas, 0);
  assert.equal(log.avisos.length, 1, 'um aviso só, não um por job');
  assert.match(log.avisos[0], /DESLIGADOS/);
});

test('ligado (padrão): agendar e agendarUmaVez continuam criando timers', async () => {
  const jobs = createJobRunner({ poolReal: null, logger: logger() });
  const t = jobs.agendar('job-a', 1_000_000, () => {});
  const u = jobs.agendarUmaVez('job-b', 1_000_000, () => {});
  assert.ok(t && typeof t.unref === 'function');
  assert.ok(u && typeof u.hasRef === 'function');
  clearInterval(t);
  clearTimeout(u);
});

test('desligado não impede executar um job DE PROPÓSITO (executarPorOrganizacao)', async () => {
  const jobs = createJobRunner({ poolReal: null, logger: logger(), desligado: true });
  const r = await jobs.executarPorOrganizacao('manual', async () => {});
  assert.equal(r.organizacoes, 0, 'sem pool não há Organizations; a chamada funciona e devolve o resumo');
});

test('server.js só honra o desligamento fora de produção e loga erro se pedido em produção', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /process\.env\.ORIA_JOBS_DE_FUNDO === 'off' && process\.env\.NODE_ENV !== 'production'/);
  assert.match(src, /ORIA_JOBS_DE_FUNDO=off IGNORADO em produção/);
  assert.match(src, /desligado: JOBS_DE_FUNDO_DESLIGADOS/);
});
