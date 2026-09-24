'use strict';

// Estado da lista de Clientes ligado à chave do pedido (src/pages/clientes/listaEstado.ts): nunca exibe dado de outra chave,
// ignora resposta atrasada/fora de ordem, mostra erro verdadeiro e recupera. Transpila o arquivo REAL do painel.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ARQUIVO = path.join(__dirname, '..', 'src', 'pages', 'clientes', 'listaEstado.ts');
const js = ts.transpileModule(fs.readFileSync(ARQUIVO, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const modulo = { exports: {} };
vm.runInNewContext(js, { module: modulo, exports: modulo.exports });
const { iniciarCarga, concluirCarga, exibicao, totalEsperadoDaMatriz } = modulo.exports;

const lista = (total, segmento) => ({ total, clientes: [{ segmento }] });

test('carga nova começa em "carregando": nada da lista anterior aparece com o filtro novo', () => {
  let carga = concluirCarga(iniciarCarga('sem-filtro'), 'sem-filtro', { dados: lista(2400, 'campeoes') });
  assert.equal(exibicao(carga, 'sem-filtro').modo, 'ok');
  // Usuário ativa o chip "Novos": a chave muda ANTES de a resposta chegar.
  assert.equal(exibicao(carga, 'novos').modo, 'carregando', 'a lista antiga (2400) não pode ser exibida com o chip novo');
  assert.equal(exibicao(carga, 'novos').dados, null);
  carga = iniciarCarga('novos');
  assert.equal(exibicao(carga, 'novos').modo, 'carregando');
  carga = concluirCarga(carga, 'novos', { dados: lista(301, 'novos') });
  const v = exibicao(carga, 'novos');
  assert.equal(v.modo, 'ok');
  assert.equal(v.dados.total, 301);
});

test('resposta de chave antiga (lenta, fora de ordem) é ignorada', () => {
  let carga = iniciarCarga('hibernando');
  carga = iniciarCarga('campeoes'); // o usuário já trocou
  const depois = concluirCarga(carga, 'hibernando', { dados: lista(662, 'hibernando') });
  assert.equal(depois, carga, 'a carga corrente não muda com resposta de outra chave');
  assert.equal(exibicao(depois, 'campeoes').modo, 'carregando');
  const certa = concluirCarga(carga, 'campeoes', { dados: lista(23, 'campeoes') });
  assert.equal(exibicao(certa, 'campeoes').dados.total, 23);
  // E se a resposta antiga chegar DEPOIS da certa, continua ignorada.
  assert.equal(concluirCarga(certa, 'hibernando', { dados: lista(662, 'hibernando') }), certa);
});

test('falha: erro verdadeiro só para a chave que falhou; não deixa a lista antiga; nova tentativa recupera', () => {
  let carga = concluirCarga(iniciarCarga('a'), 'a', { dados: lista(2400, 'x') });
  carga = iniciarCarga('novos');
  carga = concluirCarga(carga, 'novos', { erro: 'serviço indisponível' });
  const v = exibicao(carga, 'novos');
  assert.equal(v.modo, 'erro');
  assert.equal(v.erro, 'serviço indisponível');
  assert.equal(v.dados, null);
  // "Tentar novamente" = nova chave (tentativa+1): volta a carregar e, com sucesso, mostra o dado certo.
  carga = iniciarCarga('novos#2');
  assert.equal(exibicao(carga, 'novos#2').modo, 'carregando');
  carga = concluirCarga(carga, 'novos#2', { dados: lista(301, 'novos') });
  assert.equal(exibicao(carga, 'novos#2').dados.total, 301);
  // A chave da falha antiga não "ressuscita" o erro.
  assert.equal(exibicao(carga, 'novos').modo, 'carregando');
});

test('sem carga alguma: carregando; erro sem mensagem ganha texto explícito, nunca vazio', () => {
  assert.equal(exibicao(null, 'x').modo, 'carregando');
  const c = concluirCarga(iniciarCarga('x'), 'x', { erro: '' });
  assert.equal(exibicao(c, 'x').erro, 'erro desconhecido');
  assert.equal(concluirCarga(null, 'x', { dados: 1 }), null);
});

test('total esperado da matriz: só quando o ÚNICO filtro é segmento da matriz', () => {
  const mat = { novos: 301, campeoes: 23, hibernando: 662 };
  assert.equal(totalEsperadoDaMatriz(['novos'], mat, false), 301);
  assert.equal(totalEsperadoDaMatriz(['novos', 'campeoes'], mat, false), 324);
  assert.equal(totalEsperadoDaMatriz(['novos'], mat, true), null, 'com busca/faixas a comparação não é honesta');
  assert.equal(totalEsperadoDaMatriz([], mat, false), null);
  assert.equal(totalEsperadoDaMatriz(['sem_compra'], mat, false), null, 'sem_compra não é segmento da matriz');
  assert.equal(totalEsperadoDaMatriz(['novos', 'inexistente'], mat, false), null);
});
