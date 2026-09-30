'use strict';

// Dashboard · modo discreto (src/state/modoDiscreto.ts).
//
// A escolha "ocultar/mostrar valores" persiste por usuário E por Organization, só no navegador, e o
// padrão é sempre OCULTO: sem preferência, sem identidade resolvida ou com o armazenamento bloqueado.
// Outra pessoa no mesmo computador não herda a escolha. Nada além de 'oculto'/'visivel' é gravado.
// Testado sobre o arquivo REAL do painel, transpilado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const h = require('./harness');

function carregar() {
  const arquivo = path.join(h.RAIZ_SUJEITO, 'src', 'state', 'modoDiscreto.ts');
  const js = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const modulo = { exports: {} };
  // Sem `window`: o módulo não pode depender do navegador para decidir o padrão.
  vm.runInNewContext(js, { module: modulo, exports: modulo.exports });
  return modulo.exports;
}

function armazenamentoFalso() {
  const dados = new Map();
  return { dados, getItem: (k) => (dados.has(k) ? dados.get(k) : null), setItem: (k, v) => dados.set(k, String(v)) };
}

const bloqueado = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };

test('primeira visita (sem preferência): valores começam ocultos', () => {
  const m = carregar();
  const chave = m.chaveModoDiscreto('u1', 'o1');
  assert.equal(m.lerOculto(chave, armazenamentoFalso()), true);
});

test('identidade não resolvida: sempre oculto, e nada é gravado', () => {
  const m = carregar();
  const s = armazenamentoFalso();
  assert.equal(m.chaveModoDiscreto(null, 'o1'), null);
  assert.equal(m.chaveModoDiscreto('u1', undefined), null);
  assert.equal(m.lerOculto(null, s), true);
  m.gravarOculto(null, false, s);
  assert.equal(s.dados.size, 0);
});

test('a última escolha persiste para o mesmo usuário e Organization (refresh, novo login)', () => {
  const m = carregar();
  const s = armazenamentoFalso();
  const chave = m.chaveModoDiscreto('u1', 'o1');
  m.gravarOculto(chave, false, s);
  assert.equal(m.lerOculto(chave, s), false, 'mostrar valores fica lembrado');
  m.gravarOculto(chave, true, s);
  assert.equal(m.lerOculto(chave, s), true, 'ocultar de novo também');
});

test('outro usuário (ou outra Organization) no mesmo navegador não herda a escolha', () => {
  const m = carregar();
  const s = armazenamentoFalso();
  m.gravarOculto(m.chaveModoDiscreto('u1', 'o1'), false, s);
  assert.equal(m.lerOculto(m.chaveModoDiscreto('u2', 'o1'), s), true, 'outro usuário começa oculto');
  assert.equal(m.lerOculto(m.chaveModoDiscreto('u1', 'o2'), s), true, 'outra Organization começa oculta');
});

test('só a preferência é gravada: valor "oculto"/"visivel" numa chave versionada, sem nenhum dado', () => {
  const m = carregar();
  const s = armazenamentoFalso();
  m.gravarOculto(m.chaveModoDiscreto('u1', 'o1'), false, s);
  assert.deepEqual([...s.dados.entries()], [['oria.dashboard.valores.v1:u1:o1', 'visivel']]);
});

test('valor desconhecido ou corrompido no armazenamento: volta ao padrão oculto', () => {
  const m = carregar();
  const s = armazenamentoFalso();
  const chave = m.chaveModoDiscreto('u9', 'o9');
  s.dados.set(chave, 'true');
  assert.equal(m.lerOculto(chave, s), true);
});

test('armazenamento bloqueado: nunca lança, começa oculto e a escolha vale em memória', () => {
  const m = carregar();
  const chave = m.chaveModoDiscreto('u3', 'o3');
  assert.equal(m.lerOculto(chave, bloqueado), true);
  assert.doesNotThrow(() => m.gravarOculto(chave, false, bloqueado));
  assert.equal(m.lerOculto(chave, bloqueado), false, 'a troca funciona enquanto a aba está aberta');
});
