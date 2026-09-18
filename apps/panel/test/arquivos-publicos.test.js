'use strict';

// Allowlist de arquivos públicos (lib/arquivos-publicos.js): o que o produto entrega aberto
// responde 200; código-fonte, docs, scripts, logs, dados internos — e tudo que era do site da
// Orgulho Regional — respondem 404.
//
// A raiz falsa abaixo contém DE PROPÓSITO os arquivos do site que foram removidos do repositório
// (index.html, loja.html, stories/ e o catálogo em data/). Eles existem no disco desta raiz falsa
// justamente para que os 404 provem a ALLOWLIST, e não a ausência dos arquivos: se alguém devolver
// o site pro repositório sem mexer aqui, a allowlist continua recusando — e é isso que este teste
// trava.

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
    // O que o produto serve aberto.
    'oria.html': '<h1>oria</h1>',
    'pedido.html': '<h1>pedido</h1>',
    'politica-de-privacidade.html': '<h1>privacidade</h1>',
    'assets/oria/oria-simbolo.png': 'png',
    'assets/logo-sul.png': 'png',
    'assets/fonts/handelson-six.otf': 'otf',
    'src/pedido.js': 'js',
    'src/pedido.css': 'css',
    // Frontend do painel: mora em `src/` desde que `apps/panel/admin/` deixou de existir. É
    // código-fonte, não arquivo público — o Vite empacota, ninguém busca por URL.
    'src/main.tsx': 'tsx',
    'src/App.tsx': 'tsx',
    'src/api/client.ts': 'ts',
    'src/auth/AuthContext.tsx': 'tsx',
    'index.html': '<div id="root"></div>',
    'vite.config.mjs': 'js',
    'tsconfig.json': '{}',
    // Código, dados e operação — nunca públicos.
    'server.js': 'segredo',
    'package.json': '{}',
    'deploy.log': 'log',
    '.env': 'OPENAI_API_KEY=x',
    'lib/creative-core/client.js': 'js',
    'routes/criativos.js': 'js',
    'services/creative-core/service.py': 'py',
    'docs/plan.md': 'md',
    'scripts/test-db.mjs': 'js',
    'test/arquivos-publicos.test.js': 'js',
    'desktop/package.json': '{}',
    'db/pedidos.json': '{}',
    // Site da Orgulho Regional: removido do repositório, e recusado aqui mesmo quando existe.
    'index.html': '<h1>home do site</h1>',
    'loja.html': '<h1>loja</h1>',
    'stories/frame1-sul.html': '<h1>story</h1>',
    'data/cities.json': '[]',
    'data/collections.json': '[]',
    'data/config.json': '{}',
    'data/produtos.json': '[]',
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

test('given the public product files, when requested, then they are served', async (t) => {
  const base = await subirApp(t);
  const publicos = [
    '/', '/oria', '/oria.html',
    '/pedido.html',
    '/politica-de-privacidade', '/politica-de-privacidade.html',
    '/assets/oria/oria-simbolo.png', '/assets/logo-sul.png', '/assets/fonts/handelson-six.otf',
    '/src/pedido.js', '/src/pedido.css',
  ];
  for (const url of publicos) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, url);
  }
});

// A raiz do serviço é a landing do Oria — abrir o domínio cai nela, sem redirecionamento.
// `/oria` continua servindo o MESMO arquivo (é a URL cadastrada no console do Google).
test('given the service root, when requested, then it serves the Oria landing itself', async (t) => {
  const base = await subirApp(t);
  const corpos = [];
  for (const url of ['/', '/oria', '/oria.html']) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type') || '', /text\/html/, url);
    corpos.push(await res.text());
  }
  assert.equal(corpos[0], '<h1>oria</h1>', 'a raiz serve a landing, não outra página');
  assert.deepEqual(new Set(corpos).size, 1, '/ , /oria e /oria.html servem o mesmo arquivo');
});

test('given html js and css, when served, then they revalidate on every request', async (t) => {
  const base = await subirApp(t);
  for (const url of ['/', '/oria', '/pedido.html', '/src/pedido.js', '/src/pedido.css']) {
    const res = await fetch(base + url);
    assert.equal(res.headers.get('cache-control'), 'no-cache', url);
  }
});

test('given source code docs scripts logs and internal data, when requested, then they return 404', async (t) => {
  const base = await subirApp(t);
  const privados = [
    '/server.js', '/package.json', '/deploy.log', '/.env',
    '/lib/creative-core/client.js', '/routes/criativos.js', '/services/creative-core/service.py',
    '/docs/plan.md', '/scripts/test-db.mjs', '/test/arquivos-publicos.test.js',
    '/desktop/package.json', '/db/pedidos.json',
    '/src/../server.js', '/assets/%2e%2e/server.js',
    // Frontend do painel. `src/` já foi um diretório público inteiro; quando o SPA subiu de
    // `admin/src` para `src/`, isso passou a significar servir o código-fonte do produto aberto.
    // A allowlist agora nomeia os dois arquivos da hotpage e nada mais.
    '/src/main.tsx', '/src/App.tsx', '/src/api/client.ts', '/src/auth/AuthContext.tsx',
    '/vite.config.mjs', '/tsconfig.json',
  ];
  for (const url of privados) {
    const res = await fetch(base + url);
    assert.equal(res.status, 404, url);
  }
});

// Controle negativo da remoção do site: mesmo com os arquivos presentes na raiz, a allowlist
// recusa a home, a loja, os frames de stories e o catálogo em data/ — repor os arquivos não basta
// para trazer o site de volta.
//
// O CSS/JS do site (src/loja.*) e as imagens dele (assets/mockups/, assets/og-image.png) não
// aparecem aqui de propósito: `src` e `assets` são diretórios públicos inteiros, e o que os tira
// do ar é terem sido apagados, não a allowlist. Quem prova isso é
// test/invariants/site-fora.test.js, contra o repositório de verdade.
test('given the old Orgulho Regional site pages, when requested, then the allowlist refuses them', async (t) => {
  const base = await subirApp(t);
  const doSite = [
    // `/index.html` responde 404 por dois motivos somados: era a home do site, e hoje o arquivo
    // na raiz é o template FONTE do Vite (aponta para `/src/main.tsx`) — servi-lo entregaria uma
    // página que não carrega. O painel sai da rota `/admin`, com o build em `dist/`.
    '/index.html',
    '/loja.html',
    '/stories/frame1-sul.html',
    '/data/cities.json', '/data/collections.json', '/data/config.json', '/data/produtos.json',
  ];
  for (const url of doSite) {
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
