'use strict';

// Comportamento de fechamento do drawer — com DOM de verdade (jsdom), porque o defeito só existe
// em eventos: clique no fundo, clique no conteúdo, Escape, botão.
//
// ── Por que estes testes existem ─────────────────────────────────────────────────────────────
// O drawer do convite mostra o token UMA vez: no banco só existe o hash. Fechar por clique fora é
// um gesto que a pessoa faz sem querer — e aqui o gesto acidental custa um token irrecuperável,
// que só se resolve reemitindo (o que invalida o anterior). Foi o que aconteceu de verdade: o
// operador clicou ao lado do botão "Copiar token" e o painel fechou.
//
// Então este drawer fecha SÓ por ação explícita, e o teste trava isso dos dois lados: o drawer
// normal continua fechando por clique fora e por Escape (senão a mudança viraria regra global sem
// ninguém decidir).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const h = require('./harness');

const UI = pathToFileURL(path.join(h.RAIZ_SUJEITO, 'public', 'js', 'ui.js')).href;

let ui;
let janela;

// jsdom precisa existir ANTES do módulo ser importado? Não: `ui.js` só toca em `document` dentro
// das funções. Mas o `document` precisa ser global na hora da chamada — é o que montamos aqui.
test.before(async () => {
  // A URL não é decoração: sem origem, o jsdom recusa localStorage/sessionStorage (origem opaca)
  // e o teste de persistência falharia por motivo errado.
  janela = new JSDOM('<!doctype html><html><body><div id="avisos"></div></body></html>',
    { pretendToBeVisual: true, url: 'https://admin.oria.test/organizations' });
  global.window = janela.window;
  global.document = janela.window.document;
  // O Node 22 já tem um `navigator` global — e ele não tem prancheta. Sem esta linha, o `copiar()`
  // do app leria o navigator do Node e devolveria false por motivo errado.
  Object.defineProperty(global, 'navigator', { configurable: true, value: janela.window.navigator });
  global.Node = janela.window.Node;
  global.HTMLElement = janela.window.HTMLElement;
  ui = await import(UI);
});

test.after(() => {
  delete global.window;
  delete global.document;
  delete global.navigator;
  delete global.Node;
  delete global.HTMLElement;
  janela.window.close();
});

function abrir(opcoes = {}) {
  const promessa = ui.abrirDrawer({
    titulo: 'Organization criada',
    corpo: ui.html`
      <div class="campo">
        <input id="token-convite" type="text" readonly value="tok_exemplo_123">
        <button type="button" data-copiar>Copiar token</button>
      </div>`,
    rodape: ui.html`<button type="button" class="btn btn-secundario" data-fechar>Fechar</button>`,
    ...opcoes,
  });
  const fundo = document.querySelector('.drawer-fundo');
  assert.ok(fundo, 'o drawer deveria estar montado');
  return { promessa, fundo };
}

const clicar = (elemento) => elemento.dispatchEvent(new janela.window.MouseEvent('click', { bubbles: true }));
const escape = () => document.dispatchEvent(new janela.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const aberto = () => !!document.querySelector('.drawer-fundo');

// ── Drawer de token: só fecha por ação explícita ─────────────────────────────────────────────

test('drawer de token · clique no backdrop NÃO fecha', async () => {
  const { fundo } = abrir({ fecharSoPorAcao: true });
  clicar(fundo);
  assert.equal(aberto(), true, 'clique no fundo fechou um drawer de token');
  clicar(fundo.querySelector('[data-fechar]'));
});

test('drawer de token · clique em área vazia do conteúdo NÃO fecha', async () => {
  const { fundo } = abrir({ fecharSoPorAcao: true });
  // Foi exatamente isto que o operador fez: clicou ao lado do botão de copiar.
  clicar(fundo.querySelector('.campo'));
  clicar(fundo.querySelector('aside'));
  assert.equal(aberto(), true, 'clique dentro do painel fechou o drawer');
  clicar(fundo.querySelector('[data-fechar]'));
});

test('drawer de token · Escape NÃO fecha', async () => {
  const { fundo } = abrir({ fecharSoPorAcao: true });
  escape();
  assert.equal(aberto(), true, 'Escape fechou um drawer de token');
  clicar(fundo.querySelector('[data-fechar]'));
});

test('drawer de token · o botão Fechar fecha', async () => {
  const { promessa, fundo } = abrir({ fecharSoPorAcao: true });
  clicar(fundo.querySelector('[data-fechar]'));
  assert.equal(await promessa, null);
  assert.equal(aberto(), false);
});

test('drawer de token · o X do cabeçalho fecha', async () => {
  const { promessa, fundo } = abrir({ fecharSoPorAcao: true });
  const x = fundo.querySelector('.fechar-x');
  assert.ok(x, 'o cabeçalho precisa ter o X');
  clicar(x);
  assert.equal(await promessa, null);
  assert.equal(aberto(), false);
});

test('drawer de token · o token não fica em lugar nenhum depois de fechar', async () => {
  const { promessa, fundo } = abrir({ fecharSoPorAcao: true });
  assert.equal(fundo.querySelector('#token-convite').value, 'tok_exemplo_123');
  clicar(fundo.querySelector('[data-fechar]'));
  await promessa;

  assert.doesNotMatch(document.body.innerHTML, /tok_exemplo_123/, 'token continua no DOM');
  assert.equal(janela.window.localStorage.getItem('token-convite'), null);
  assert.equal(janela.window.localStorage.length, 0, 'algo foi parar no localStorage');
  assert.equal(janela.window.sessionStorage.length, 0, 'algo foi parar no sessionStorage');
  assert.doesNotMatch(janela.window.location.search, /tok_exemplo_123/);
});

// ── O drawer comum não muda ──────────────────────────────────────────────────────────────────

test('drawer comum · clique no backdrop e Escape continuam fechando', async () => {
  const a = abrir();
  clicar(a.fundo);
  assert.equal(await a.promessa, null);
  assert.equal(aberto(), false, 'o drawer comum deveria fechar por clique fora');

  const b = abrir();
  escape();
  assert.equal(await b.promessa, null);
  assert.equal(aberto(), false, 'o drawer comum deveria fechar por Escape');
});

// ── A cópia ──────────────────────────────────────────────────────────────────────────────────

test('drawer de token · copiar usa a área de transferência do browser, e só ela', async () => {
  const { fundo, promessa } = abrir({ fecharSoPorAcao: true });
  const copiados = [];
  // Substitui a prancheta do browser, não a função da UI: quem roda é o `copiar()` de verdade.
  Object.defineProperty(janela.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (texto) => { copiados.push(texto); } },
  });
  Object.defineProperty(janela.window, 'isSecureContext', { configurable: true, value: true });

  const campo = fundo.querySelector('#token-convite');
  assert.equal(await ui.copiar(campo.value), true, 'copiar() deveria confirmar a cópia');
  assert.deepEqual(copiados, ['tok_exemplo_123']);

  // Nada de persistir: a prancheta é o único destino.
  assert.equal(janela.window.localStorage.length, 0);
  assert.equal(janela.window.sessionStorage.length, 0);

  clicar(fundo.querySelector('[data-fechar]'));
  await promessa;
});

test('drawer de token · sem prancheta, copiar devolve false em vez de fingir que copiou', async () => {
  Object.defineProperty(janela.window.navigator, 'clipboard', { configurable: true, value: undefined });
  assert.equal(await ui.copiar('tok_exemplo_123'), false,
    'sem clipboard a UI precisa avisar, não dizer que copiou — o token não é recuperável');
});
