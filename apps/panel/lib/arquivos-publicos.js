'use strict';

// Allowlist do que o site público baixa direto do disco. Antes era um express.static na raiz do
// repo, que servia server.js, lib/, docs/, scripts/, test/, services/, package.json e logs pra
// qualquer um. Arquivo novo que o front precise buscar por URL tem que entrar numa das listas.

const path = require('path');
const express = require('express');

// Diretórios inteiros: só front (CSS/JS das páginas, fontes, logos, mockups, frames de stories).
const DIRETORIOS_PUBLICOS = ['assets', 'src', 'stories'];

// Páginas na raiz. As variantes .html mantêm links antigos funcionando.
//
// A política de privacidade responde nas duas formas de propósito: a URL sem extensão é a que vai
// no console de OAuth do Google (e que o Google revisita na verificação), então ela precisa ser
// estável e bonita; a .html é só para não quebrar quem chegar pelo nome do arquivo.
const PAGINAS_RAIZ = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/loja.html': 'loja.html',
  '/pedido.html': 'pedido.html',
  '/politica-de-privacidade': 'politica-de-privacidade.html',
  '/politica-de-privacidade.html': 'politica-de-privacidade.html',
  // Página pública do Oria. É ela que fica cadastrada como "página inicial do aplicativo" no
  // console do Google: a verificação exige uma página aberta que diga o nome do app e explique a
  // finalidade dele — /admin não serve, é tela de login e não explica nada a quem revisa.
  '/oria': 'oria.html',
  '/oria.html': 'oria.html',
};

// data/ tem backup e arquivos usados só por scripts — só o que index.html e src/loja.js buscam.
const DADOS_PUBLICOS = ['cities.json', 'collections.json', 'config.json', 'produtos.json'];

// HTML/JS/CSS sempre revalidam (Cache-Control: no-cache) — sem isso, navegador e Cloudflare
// (que fica na frente do Railway) guardam a versão antiga depois de cada deploy.
// ETag do Express ainda permite 304 quando o arquivo não mudou, então isso é barato.
function aplicarNoCache(res, filePath) {
  if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
}

function montarArquivosPublicos(app, { raiz }) {
  for (const dir of DIRETORIOS_PUBLICOS) {
    app.use(`/${dir}`, express.static(path.join(raiz, dir), { index: false, setHeaders: aplicarNoCache }));
  }

  for (const [rota, arquivo] of Object.entries(PAGINAS_RAIZ)) {
    app.get(rota, (req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(raiz, arquivo));
    });
  }

  const nomesDados = DADOS_PUBLICOS.map((nome) => nome.replace(/\./g, '\\.')).join('|');
  app.get(new RegExp(`^/data/(${nomesDados})$`), (req, res) => {
    res.sendFile(path.join(raiz, 'data', req.params[0]));
  });
}

module.exports = { montarArquivosPublicos, DIRETORIOS_PUBLICOS, PAGINAS_RAIZ, DADOS_PUBLICOS };
