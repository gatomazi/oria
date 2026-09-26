'use strict';

// Preferências LOCAIS da navegação (src/shell/navPrefs.ts): sidebar reduzida (lembrada) e grupos (sempre fechados ao carregar). Só conveniência do navegador —
// dado corrompido, armazenamento bloqueado ou ausente nunca quebram a tela nem viram preferência inventada.

const test = require('node:test');
const assert = require('node:assert/strict');
const { carregarTs } = require('./helpers/ts-carregar.cjs');

const { CHAVE_NAV_PREFS, lerPrefs, gravarPrefs, alternarColapso, alternarGrupo, grupoAberto, itensVisiveis } = carregarTs('src/shell/navPrefs.ts');
const plano = (x) => JSON.parse(JSON.stringify(x));
const fonte = (valor) => ({ getItem: (k) => (k === CHAVE_NAV_PREFS ? valor : null) });

test('a chave é versionada (mudar o formato exige uma versão nova, nunca reinterpretar a antiga)', () => {
  assert.equal(CHAVE_NAV_PREFS, 'oria.shell.nav.v1');
});

test('padrão: sidebar expandida e TODOS os grupos fechados (ausência, vazio, sem armazenamento)', () => {
  const padrao = { colapsada: false, gruposAbertos: [] };
  assert.deepEqual(plano(lerPrefs(fonte(null))), padrao);
  assert.deepEqual(plano(lerPrefs(fonte(''))), padrao);
  assert.deepEqual(plano(lerPrefs(null)), padrao);
  assert.equal(grupoAberto(padrao, 'Operação'), false, 'nenhum grupo começa aberto');
});

test('leitura tolerante: JSON inválido, forma errada e lixo viram o padrão; só `colapsada` é lida', () => {
  const padrao = { colapsada: false, gruposAbertos: [] };
  for (const v of ['{', 'null', '42', '"x"', '[]', '[1,2]', 'undefined']) assert.deepEqual(plano(lerPrefs(fonte(v))), padrao, v);
  assert.deepEqual(plano(lerPrefs(fonte(JSON.stringify({ colapsada: 'sim' })))), padrao, 'tipo errado');
  assert.deepEqual(plano(lerPrefs(fonte(JSON.stringify({ colapsada: true, token: 'segredo' })))), { colapsada: true, gruposAbertos: [] }, 'nada além do formato conhecido');
});

test('grupos NUNCA voltam do armazenamento: nem o formato antigo (gruposFechados) nem um gruposAbertos gravado reabrem/fecham nada', () => {
  const velho = JSON.stringify({ colapsada: true, gruposFechados: ['Operação'], gruposAbertos: ['Catálogo', 'Financeiro'] });
  assert.deepEqual(plano(lerPrefs(fonte(velho))), { colapsada: true, gruposAbertos: [] });
});

test('armazenamento que LANÇA (janela privada/bloqueado) nunca propaga o erro', () => {
  const quebrado = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.deepEqual(plano(lerPrefs(quebrado)), { colapsada: false, gruposAbertos: [] });
  assert.doesNotThrow(() => gravarPrefs({ colapsada: true, gruposAbertos: ['Operação'] }, quebrado));
});

test('gravar persiste SÓ a sidebar recolhida (os grupos abertos ficam só na sessão)', () => {
  let salvo = null;
  const armazem = { setItem: (k, v) => { assert.equal(k, CHAVE_NAV_PREFS); salvo = v; }, getItem: () => salvo };
  gravarPrefs({ colapsada: true, gruposAbertos: ['Catálogo', 'Financeiro'], extra: 'não persiste' }, armazem);
  assert.deepEqual(JSON.parse(salvo), { colapsada: true });
  assert.deepEqual(plano(lerPrefs(armazem)), { colapsada: true, gruposAbertos: [] }, 'recarregar: recolhida lembrada, grupos fechados');
});

test('alternar: colapso e grupo são reversíveis e não mutam o estado anterior', () => {
  const p0 = { colapsada: false, gruposAbertos: [] };
  const p1 = alternarColapso(p0);
  assert.equal(p1.colapsada, true);
  assert.equal(p0.colapsada, false, 'imutável');
  assert.equal(alternarColapso(p1).colapsada, false);
  const g1 = alternarGrupo(p0, 'Catálogo');
  assert.deepEqual(plano(g1.gruposAbertos), ['Catálogo']);
  assert.equal(grupoAberto(g1, 'Catálogo'), true);
  assert.equal(grupoAberto(g1, 'Operação'), false);
  assert.deepEqual(plano(alternarGrupo(g1, 'Catálogo').gruposAbertos), []);
  assert.deepEqual(plano(p0.gruposAbertos), []);
});

const ITENS = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
test('grupo aberto mostra todos os itens; fechado mostra SÓ a página atual (orientação); sem página atual, nenhum', () => {
  assert.equal(itensVisiveis(ITENS, true, 'b', false).length, 3);
  assert.deepEqual(plano(itensVisiveis(ITENS, false, 'b', false)), [{ key: 'b' }]);
  assert.deepEqual(plano(itensVisiveis(ITENS, false, 'zzz', false)), []);
  assert.deepEqual(plano(itensVisiveis(ITENS, false, '', false)), []);
});

test('sidebar reduzida (só ícones) ignora grupos fechados: nenhuma rota some do alcance', () => {
  assert.equal(itensVisiveis(ITENS, false, 'b', true).length, 3);
  assert.equal(itensVisiveis(ITENS, false, '', true).length, 3);
});
