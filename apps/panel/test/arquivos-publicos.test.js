'use strict';

// Allowlist de arquivos públicos (lib/arquivos-publicos.js): o que o front usa responde 200,
// código-fonte, docs, scripts, logs e dados internos respondem 404.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { montarArquivosPublicos } = require('../lib/arquivos-publicos');

function criarRaizFalsa() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'arquivos-publicos-'));
  const arquivos = {
    'index.html': '<h1>home</h1>',
    'loja.html': '<h1>loja</h1>',
    'pedido.html': '<h1>pedido</h1>',
    'politica-de-privacidade.html': '<h1>privacidade</h1>',
    'oria.html': '<h1>oria</h1>',
    'assets/oria/oria-simbolo.png': 'png',
    'server.js': 'segredo',
    'package.json': '{}',
    'migracao.log': 'log',
    '.env': 'OPENAI_API_KEY=x',
    'src/loja.js': 'js',
    'src/loja.css': 'css',
    'assets/logo-sul.png': 'png',
    'assets/fonts/handelson-six.otf': 'otf',
    'stories/frame1-sul.html': '<h1>story</h1>',
    'data/cities.json': '[]',
    'data/collections.json': '[]',
    'data/config.json': '{}',
    'data/produtos.json': '[]',
    'data/cities.json.bak': '[]',
    'data/df-regioes-administrativas.json': '[]',
    'lib/creative-core/client.js': 'js',
    'routes/criativos.js': 'js',
    'services/creative-core/service.py': 'py',
    'docs/plan.md': 'md',
    'scripts/migracao-config.mjs': 'js',
    'test/arquivos-publicos.test.js': 'js',
    'desktop/package.json': '{}',
    'db/pedidos.json': '{}',
  };
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), conteudo);
  }
  return raiz;
}

async function subirApp(t) {
  const raiz = criarRaizFalsa();
  const app = express();
  montarArquivosPublicos(app, { raiz });
  app.use((req, res) => res.status(404).end());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    server.close();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('given public front files, when requested, then they are served', async (t) => {
  const base = await subirApp(t);
  const publicos = [
    '/', '/index.html', '/loja.html', '/pedido.html',
    '/politica-de-privacidade', '/politica-de-privacidade.html',
    '/oria', '/oria.html', '/assets/oria/oria-simbolo.png',
    '/src/loja.js', '/src/loja.css', '/assets/logo-sul.png', '/assets/fonts/handelson-six.otf',
    '/stories/frame1-sul.html',
    '/data/cities.json', '/data/collections.json', '/data/config.json', '/data/produtos.json',
  ];
  for (const url of publicos) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, url);
  }
});

test('given html js and css, when served, then they revalidate on every request', async (t) => {
  const base = await subirApp(t);
  for (const url of ['/', '/loja.html', '/src/loja.js', '/src/loja.css', '/stories/frame1-sul.html']) {
    const res = await fetch(base + url);
    assert.equal(res.headers.get('cache-control'), 'no-cache', url);
  }
});

test('given source code docs scripts logs and internal data, when requested, then they return 404', async (t) => {
  const base = await subirApp(t);
  const privados = [
    '/server.js', '/package.json', '/migracao.log', '/.env',
    '/lib/creative-core/client.js', '/routes/criativos.js', '/services/creative-core/service.py',
    '/docs/plan.md', '/scripts/migracao-config.mjs', '/test/arquivos-publicos.test.js',
    '/desktop/package.json', '/db/pedidos.json',
    '/data/cities.json.bak', '/data/df-regioes-administrativas.json',
    '/src/../server.js', '/assets/%2e%2e/server.js', '/data/..%2fserver.js',
  ];
  for (const url of privados) {
    const res = await fetch(base + url);
    assert.equal(res.status, 404, url);
  }
});

// As duas URLs cadastradas no console de OAuth do Google: a página inicial do app e a política de
// privacidade. Se qualquer uma parar de responder 200, a verificação do app é reprovada — e só se
// descobre quando o refresh token expira e a integração cai sozinha.
test('given the urls registered at Google, when requested, then they serve their pages', async (t) => {
  const base = await subirApp(t);
  for (const url of ['/politica-de-privacidade', '/oria']) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type') || '', /text\/html/, url);
  }
});
