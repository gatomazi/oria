'use strict';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// O site da Orgulho Regional não mora mais neste serviço
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// O repositório do site foi reaproveitado para virar o painel (o produto é o Oria), e o site saiu.
// Este arquivo é o CONTROLE NEGATIVO dessa remoção, contra o serviço de verdade: sobe o painel e
// exige 404 em cada URL que o site servia. Enquanto a allowlist
// (test/arquivos-publicos.test.js) prova que os ARQUIVOS não voltam pela porta estática, aqui se
// prova que as ROTAS do server.js não voltam — eram rotas próprias, registradas à mão, e é por
// elas que o site reapareceria.
//
// O que sobrou aberto é o produto: a landing do Oria (agora na raiz), a política de privacidade
// (as duas URLs cadastradas no console de OAuth do Google) e a hotpage de pagamento do pedido.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('./harness');

const SERVER = path.join(h.RAIZ_REPO, 'server.js');
const INDEX_DO_ADMIN = path.join(h.RAIZ_REPO, 'admin', 'dist', 'index.html');

// Ambiente mínimo e explícito: nada do shell de quem roda o teste decide o resultado. Sem
// Postgres de propósito — o que se mede aqui é roteamento, não dado.
function ambiente(porta) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-site-fora-'));
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    STORAGE_DIR: dir,
    UPLOADS_DIR: path.join(dir, 'uploads'),
    PORT: String(porta),
    NODE_ENV: 'development',
    DATA_STORE_MODE: 'ephemeral-json',
    ENCRYPTION_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
  };
}

let painel = null;
let base = '';

test.before(async () => {
  const r = await h.subirProcessoDoPainel(
    (porta) => spawn(process.execPath, [SERVER], { cwd: h.RAIZ_REPO, env: ambiente(porta) }),
  );
  painel = r.filho;
  base = r.base;
});

test.after(() => {
  if (painel) {
    painel.removeAllListeners('exit');
    painel.kill('SIGKILL');
  }
});

// A raiz do domínio era a busca de cidades do site; hoje é a landing do Oria.
test('site fora · a raiz do serviço serve a landing do Oria', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const corpo = await res.text();
  assert.match(corpo, /<title>Oria — Painel de gestão para lojas<\/title>/);
  assert.match(corpo, /href="\/admin"/, 'a landing leva ao painel');
});

// `/oria` é a URL cadastrada no console de OAuth do Google como página inicial do aplicativo.
// Serve o mesmo arquivo da raiz, sem redirecionar: a verificação lê um 200 com HTML.
test('site fora · /oria e /politica-de-privacidade (as URLs do Google) seguem de pé', async () => {
  const raiz = await (await fetch(`${base}/`)).text();
  const oria = await fetch(`${base}/oria`);
  assert.equal(oria.status, 200);
  assert.equal(await oria.text(), raiz, '/oria e / servem o mesmo arquivo');

  const politica = await fetch(`${base}/politica-de-privacidade`);
  assert.equal(politica.status, 200);
  assert.match(politica.headers.get('content-type') || '', /text\/html/);
});

// Nenhuma página do site responde mais. As três primeiras eram rotas com regex própria no
// server.js (região, região/loja, UF/cidade) — reintroduzir qualquer uma reprova aqui.
test('site fora · nenhuma página do site responde', async () => {
  const doSite = [
    '/index.html', '/loja.html',
    '/sul', '/centro', '/norte',
    '/sul/traco', '/sul/traco/curitiba',
    '/sul/loja', '/centro/loja', '/norte/loja', '/sul/loja/produto/camiseta-sul',
    '/sc/tijucas', '/pr/curitiba', '/go/goiania',
    '/stories/frame1-sul.html',
    '/data/cities.json', '/data/collections.json', '/data/config.json', '/data/produtos.json',
    // Existe no disco (os scripts da migração interna leem), mas data/ não é mais servido.
    '/data/df-regioes-administrativas.json',
    '/src/loja.js', '/src/loja.css',
    '/assets/og-image.png', '/assets/mockups/camiseta-preta.png',
  ];
  for (const url of doSite) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 404, url);
  }
});

// Os dois logs que existiam só para medir a busca de cidade e a loja de personalizados.
test('site fora · os logs de busca e de loja do site não aceitam mais nada', async () => {
  for (const url of ['/api/log', '/api/loja/log']) {
    const res = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'city_selected', city: 'Tijucas', state: 'SC', brand: 'sul' }),
    });
    assert.equal(res.status, 404, url);
  }
});

// O painel é o produto: a remoção do site não pode ter encostado na rota do SPA. O 200 exige o
// build do Vite (`npm run panel:build`), que o CI não roda (`npm ci --ignore-scripts`); por isso o
// que se exige SEMPRE é que /admin seja resolvido pela rota do SPA e nunca pela landing — que é o
// jeito como esta mudança quebraria o painel. Com o build presente, exige-se o index de verdade.
test('site fora · /admin continua no SPA do painel, nunca na landing', async () => {
  const temBuild = fs.existsSync(INDEX_DO_ADMIN);
  for (const url of ['/admin', '/admin/pedidos']) {
    const res = await fetch(`${base}${url}`);
    const corpo = await res.text();
    assert.doesNotMatch(corpo, /<title>Oria — Painel de gestão para lojas<\/title>/,
      `${url} caiu na landing em vez do SPA`);
    if (temBuild) {
      assert.equal(res.status, 200, url);
      assert.equal(corpo, fs.readFileSync(INDEX_DO_ADMIN, 'utf8'), `${url} não serviu o index do build`);
      assert.equal(res.headers.get('cache-control'), 'no-cache', url);
    }
  }
});
