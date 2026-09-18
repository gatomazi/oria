'use strict';

// Renderização das telas — o markup que a UI produz, não só os arquivos que o servidor entrega.
//
// ── Por que estes testes existem ─────────────────────────────────────────────────────────────
// O template `html` escapa toda interpolação por padrão. Enquanto ele devolveu uma STRING, um
// `html` aninhado dentro de outro era indistinguível de dado: saía escapado, e a tela mostrava
// `<strong>bootstrap interno</strong>` como texto literal. Nada quebrava, nada logava — o sintoma
// era só visual, e por isso nenhum teste pegava.
//
// A correção foi `html` devolver um FRAGMENTO marcado (o mesmo que `cru()` produz). Estes testes
// travam as duas metades da regra, que precisam continuar valendo juntas:
//
//   1. markup escrito no código compõe (fragmento dentro de fragmento entra inteiro);
//   2. valor interpolado continua escapado — nome de organização não vira HTML.
//
// A view é renderizada de verdade, com o payload REAL da API (não um objeto inventado à mão), num
// alvo que coage para string como o `innerHTML` do browser faz.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const h = require('./harness');

const RAIZ_PUBLICA = path.join(h.RAIZ_SUJEITO, 'public');
const moduloDaUi = (relativo) => import(pathToFileURL(path.join(RAIZ_PUBLICA, relativo)).href);

let db;
let app;
let overview;

// Alvo mínimo: `innerHTML` é propriedade de string no DOM, então converter aqui não é licença
// poética — é o que o browser faz. Se `html` devolvesse algo sem `toString()`, isto viraria
// "[object Object]" e os testes abaixo reprovariam.
function alvoFalso() {
  let markup = '';
  return {
    set innerHTML(valor) { markup = String(valor); },
    get innerHTML() { return markup; },
  };
}

test.before(async () => {
  db = await h.bancoNovo();
  app = await h.subirApp(db.url);
  await h.criarAdmin(app.pool, { email: 'render@exemplo.com', papel: 'platform_owner' });
  await app.cliente.login('render@exemplo.com');
  const r = await app.cliente.get('/api/platform/overview');
  assert.equal(r.status, 200, 'a visão geral precisa responder para este arquivo ter o que renderizar');
  overview = r.corpo;

  // A view fala com a API por `fetch`. Aqui ela recebe a resposta REAL capturada acima.
  globalThis.fetch = async (url) => {
    assert.ok(String(url).endsWith('/overview'), `a visão geral pediu ${url}, que não é a rota dela`);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(overview),
    };
  };
});

test.after(async () => {
  delete globalThis.fetch;
  await app.fechar();
  await db.destruir();
});

async function dashboard() {
  const { renderizar } = await moduloDaUi('js/views/overview.js');
  const alvo = alvoFalso();
  await renderizar(alvo);
  return alvo.innerHTML;
}

// ── A regressão que motivou o arquivo ────────────────────────────────────────────────────────

test('render · o dashboard não mostra markup como texto literal', async () => {
  const markup = await dashboard();
  // Markup escapado aparece no HTML como `&lt;div`, e é isso que o operador lê como "<div" na tela.
  for (const etiqueta of ['div', 'a', 'strong', 'code', 'span', 'button']) {
    assert.doesNotMatch(markup, new RegExp(`&lt;${etiqueta}\\b`),
      `<${etiqueta}> saiu escapado: a tela mostra a etiqueta como texto`);
  }
  assert.doesNotMatch(markup, /\[object Object\]/, 'fragmento virou "[object Object]"');
});

test('render · o CTA de criar organization é um elemento clicável, não texto', async () => {
  const markup = await dashboard();
  assert.match(markup, /<a[^>]*class="btn btn-primario"[^>]*href="\/organizations\?criar=1"/,
    'o CTA deveria ser uma âncora com destino, não uma string');
  assert.match(markup, /Criar organization<\/a>/);
});

test('render · os detalhes dos cards são elementos, não texto', async () => {
  const markup = await dashboard();
  assert.match(markup, /<div class="detalhe">/, 'o detalhe do card deveria ser um elemento');
  assert.doesNotMatch(markup, /&lt;div class="detalhe"/);
});

test('render · os links internos dos cards continuam clicáveis', async () => {
  const markup = await dashboard();
  const destinos = [...markup.matchAll(/<a[^>]*data-rota[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(destinos.length >= 2, `esperava links internos no dashboard, achei ${destinos.length}`);
  for (const destino of destinos) {
    assert.ok(destino.startsWith('/'), `link interno com destino externo: ${destino}`);
  }
});

test('render · o aviso de bootstrap interno aparece como markup, com o estado certo', async () => {
  const markup = await dashboard();
  assert.match(markup, /<strong>bootstrap interno<\/strong>/,
    'o aviso deveria destacar o termo com <strong>, não imprimir a etiqueta');
  assert.match(markup, /<code>SECOND_TENANT_ENABLED=0<\/code>/);
  const esperado = overview.bootstrapInternoDisponivel ? 'está disponível' : 'não está disponível';
  assert.match(markup, new RegExp(esperado));
});

// ── A outra metade da regra: dado continua sendo dado ────────────────────────────────────────

test('render · valor interpolado continua escapado — markup só vem do código', async () => {
  const { html, cru, esc } = await moduloDaUi('js/ui.js');
  const nomeHostil = '<img src=x onerror="alert(1)">';

  const saida = String(html`<div class="cartao">${nomeHostil}</div>`);
  assert.match(saida, /^<div class="cartao">/, 'o markup do próprio template precisa sair inteiro');
  assert.doesNotMatch(saida, /<img/, 'valor interpolado virou tag — é XSS');
  assert.match(saida, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);

  // Fragmento dentro de fragmento compõe; string solta, não.
  const aninhado = String(html`<p>${html`<b>${nomeHostil}</b>`}</p>`);
  assert.match(aninhado, /^<p><b>/, 'template aninhado precisa compor');
  assert.doesNotMatch(aninhado, /<img/);

  const stringSolta = String(html`<p>${'<b>nao sou markup</b>'}</p>`);
  assert.match(stringSolta, /&lt;b&gt;nao sou markup&lt;\/b&gt;/,
    'string comum precisa continuar escapada mesmo parecendo markup');

  // `cru()` segue sendo a única porta para markup não escapado, e segue idempotente.
  assert.equal(String(cru(cru('<hr>'))), '<hr>');
  assert.equal(esc('<script>'), '&lt;script&gt;');
});

test('render · nome de organização com markup não vira HTML na lista', async () => {
  const { html, esc } = await moduloDaUi('js/ui.js');
  const linha = String(html`<tr><td>${'<script>alert(1)</script>'}</td></tr>`);
  assert.match(linha, /^<tr><td>/);
  assert.doesNotMatch(linha, /<script>/);
  assert.match(linha, new RegExp(esc('<script>alert(1)</script>').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
