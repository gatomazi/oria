'use strict';

// Preferências LOCAIS da navegação (src/shell/navPrefs.ts): sidebar reduzida e grupos fechados. Só conveniência do navegador —
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

test('padrão: sidebar expandida e todos os grupos abertos (ausência, vazio, sem armazenamento)', () => {
  const padrao = { colapsada: false, gruposFechados: [] };
  assert.deepEqual(plano(lerPrefs(fonte(null))), padrao);
  assert.deepEqual(plano(lerPrefs(fonte(''))), padrao);
  assert.deepEqual(plano(lerPrefs(null)), padrao);
});

test('leitura tolerante: JSON inválido, forma errada e lixo viram o padrão; campos desconhecidos são descartados', () => {
  const padrao = { colapsada: false, gruposFechados: [] };
  for (const v of ['{', 'null', '42', '"x"', '[]', '[1,2]', 'undefined']) assert.deepEqual(plano(lerPrefs(fonte(v))), padrao, v);
  assert.deepEqual(plano(lerPrefs(fonte(JSON.stringify({ colapsada: 'sim', gruposFechados: 'Operação' })))), padrao, 'tipos errados');
  assert.deepEqual(plano(lerPrefs(fonte(JSON.stringify({ colapsada: true, gruposFechados: ['Operação', 3, null, '', 'Operação', { x: 1 }], token: 'segredo' })))),
    { colapsada: true, gruposFechados: ['Operação'] }, 'só strings válidas, sem duplicar, e nada além do formato conhecido');
});

test('leitura limita o tamanho (dado enorme não vira preferência gigante) e rótulos absurdos são recusados', () => {
  const muitos = Array.from({ length: 200 }, (_, i) => `Grupo ${i}`);
  assert.equal(lerPrefs(fonte(JSON.stringify({ colapsada: false, gruposFechados: muitos }))).gruposFechados.length, 40);
  assert.deepEqual(plano(lerPrefs(fonte(JSON.stringify({ colapsada: false, gruposFechados: ['x'.repeat(200)] })))).gruposFechados, []);
});

test('armazenamento que LANÇA (janela privada/bloqueado) nunca propaga o erro', () => {
  const quebrado = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.deepEqual(plano(lerPrefs(quebrado)), { colapsada: false, gruposFechados: [] });
  assert.doesNotThrow(() => gravarPrefs({ colapsada: true, gruposFechados: ['Operação'] }, quebrado));
});

test('gravar e ler é idempotente e só persiste o formato conhecido', () => {
  let salvo = null;
  const armazem = { setItem: (k, v) => { assert.equal(k, CHAVE_NAV_PREFS); salvo = v; }, getItem: () => salvo };
  gravarPrefs({ colapsada: true, gruposFechados: ['Catálogo', 'Financeiro'], extra: 'não persiste' }, armazem);
  assert.deepEqual(JSON.parse(salvo), { colapsada: true, gruposFechados: ['Catálogo', 'Financeiro'] });
  assert.deepEqual(plano(lerPrefs(armazem)), { colapsada: true, gruposFechados: ['Catálogo', 'Financeiro'] });
});

test('alternar: colapso e grupo são reversíveis e não mutam o estado anterior', () => {
  const p0 = { colapsada: false, gruposFechados: [] };
  const p1 = alternarColapso(p0);
  assert.equal(p1.colapsada, true);
  assert.equal(p0.colapsada, false, 'imutável');
  assert.equal(alternarColapso(p1).colapsada, false);
  const g1 = alternarGrupo(p0, 'Catálogo');
  assert.deepEqual(plano(g1.gruposFechados), ['Catálogo']);
  assert.equal(grupoAberto(g1, 'Catálogo'), false);
  assert.equal(grupoAberto(g1, 'Operação'), true);
  assert.deepEqual(plano(alternarGrupo(g1, 'Catálogo').gruposFechados), []);
  assert.deepEqual(plano(p0.gruposFechados), []);
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
