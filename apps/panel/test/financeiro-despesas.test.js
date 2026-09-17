'use strict';

// Despesas operacionais (spec §53X). O que está sob teste é a expansão de recorrência: contar duas
// vezes uma mensalidade, ou nenhuma, muda o Lucro Operacional direto.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ocorrencias, totalizarDespesas, validarDespesa } = require('../lib/financeiro/despesas');

const MENSAL = { id: 1, categoria: 'DESIGNER', descricao: 'Designer', valor: 1500, data: '2026-01-10', recorrencia: 'mensal', fim: null };
const UNICA = { id: 2, categoria: 'APPS', descricao: 'Licença anual', valor: 900, data: '2026-03-05', recorrencia: 'unica', fim: null };

// ── Despesa única ───────────────────────────────────────────────────────────────────────────

test('despesa única conta uma vez dentro do período e nenhuma fora', () => {
  assert.deepEqual(ocorrencias(UNICA, '2026-03-01', '2026-03-31'), ['2026-03-05']);
  assert.deepEqual(ocorrencias(UNICA, '2026-04-01', '2026-04-30'), []);
  assert.deepEqual(ocorrencias(UNICA, '2026-02-01', '2026-02-28'), []);
});

test('despesa única no limite do período entra', () => {
  assert.equal(ocorrencias(UNICA, '2026-03-05', '2026-03-05').length, 1, 'início = fim = o próprio dia');
});

// ── Recorrência mensal ──────────────────────────────────────────────────────────────────────

test('mensal conta uma vez por mês-calendário tocado', () => {
  assert.deepEqual(ocorrencias(MENSAL, '2026-01-01', '2026-03-31'), ['2026-01-10', '2026-02-10', '2026-03-10']);
});

test('mensal conta o MÊS, não 30 dias', () => {
  // Fevereiro tem 28 dias. Uma mensalidade de R$ 1.500 não vira R$ 1.400 por isso.
  const t = totalizarDespesas([MENSAL], '2026-02-01', '2026-02-28');
  assert.equal(t.total, 1500);
  assert.equal(t.linhas[0].ocorrencias, 1);
});

test('mensal não conta antes de começar', () => {
  assert.deepEqual(ocorrencias(MENSAL, '2025-11-01', '2025-12-31'), [], 'despesa começa em jan/2026');
});

test('mensal para de contar depois do fim', () => {
  const encerrada = { ...MENSAL, fim: '2026-02-28' };
  assert.deepEqual(ocorrencias(encerrada, '2026-01-01', '2026-05-31'), ['2026-01-10', '2026-02-10']);
});

test('dia 31 cai no último dia dos meses curtos', () => {
  // Regra de cobrança recorrente: não pula fevereiro nem inventa 31/02.
  const d31 = { ...MENSAL, data: '2026-01-31' };
  assert.deepEqual(ocorrencias(d31, '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('período parcial no meio do mês ainda captura a incidência daquele mês', () => {
  assert.deepEqual(ocorrencias(MENSAL, '2026-03-08', '2026-03-12'), ['2026-03-10']);
  assert.deepEqual(ocorrencias(MENSAL, '2026-03-11', '2026-03-20'), [], 'a incidência do dia 10 ficou pra trás');
});

test('período de um ano conta doze vezes, não treze', () => {
  const t = totalizarDespesas([MENSAL], '2026-01-01', '2026-12-31');
  assert.equal(t.linhas[0].ocorrencias, 12);
  assert.equal(t.total, 18000);
});

// ── Totalização ─────────────────────────────────────────────────────────────────────────────

test('soma por categoria e guarda a origem de cada linha', () => {
  const t = totalizarDespesas([MENSAL, UNICA], '2026-03-01', '2026-03-31');
  assert.equal(t.total, 2400);
  assert.deepEqual(t.porCategoria, { DESIGNER: 1500, APPS: 900 });
  // spec §53Y: saber se o custo é automático ou manual é o que torna o financeiro auditável.
  assert.equal(t.linhas[0].origem, 'manual');
});

test('despesa fora do período não vira linha zerada', () => {
  const t = totalizarDespesas([UNICA], '2026-05-01', '2026-05-31');
  assert.equal(t.total, 0);
  assert.equal(t.linhas.length, 0, 'linha com subtotal 0 só polui a tela');
});

test('lista vazia devolve zero, não null — nenhuma despesa cadastrada é uma resposta', () => {
  const t = totalizarDespesas([], '2026-03-01', '2026-03-31');
  assert.equal(t.total, 0);
  assert.deepEqual(t.linhas, []);
});

// ── Validação ───────────────────────────────────────────────────────────────────────────────

test('recusa valor zero ou negativo', () => {
  assert.ok(validarDespesa({ categoria: 'APPS', valor: 0, data: '2026-03-01', descricao: 'x' }).erros);
  assert.ok(validarDespesa({ categoria: 'APPS', valor: -5, data: '2026-03-01', descricao: 'x' }).erros);
});

test('recusa categoria fora da lista', () => {
  const r = validarDespesa({ categoria: 'MARKETING', valor: 10, data: '2026-03-01', descricao: 'x' });
  assert.match(r.erros[0], /categoria inválida/);
});

test('aceita categoria em minúsculas e normaliza', () => {
  const r = validarDespesa({ categoria: 'designer', valor: 10, data: '2026-03-01', descricao: 'x' });
  assert.equal(r.despesa.categoria, 'DESIGNER');
});

test('recusa fim antes do início, e fim em despesa não recorrente', () => {
  assert.match(
    validarDespesa({ categoria: 'APPS', valor: 10, data: '2026-03-10', fim: '2026-03-01', recorrencia: 'mensal', descricao: 'x' }).erros[0],
    /fim não pode ser antes/
  );
  assert.ok(
    validarDespesa({ categoria: 'APPS', valor: 10, data: '2026-03-01', fim: '2026-04-01', recorrencia: 'unica', descricao: 'x' })
      .erros.some((e) => /só faz sentido em despesa recorrente/.test(e))
  );
});

test('descrição em branco é recusada', () => {
  assert.ok(validarDespesa({ categoria: 'APPS', valor: 10, data: '2026-03-01', descricao: '   ' }).erros);
});

test('despesa válida sai normalizada', () => {
  const r = validarDespesa({ categoria: 'apps', valor: '199.90', data: '2026-03-01', descricao: '  Shopify  ' });
  assert.deepEqual(r.despesa, { categoria: 'APPS', valor: 199.9, data: '2026-03-01', recorrencia: 'unica', fim: null, descricao: 'Shopify' });
});
