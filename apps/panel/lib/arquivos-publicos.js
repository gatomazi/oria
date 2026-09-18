'use strict';

// Allowlist do que este serviço entrega direto do disco, sem autenticação. Antes era um
// express.static na raiz do repo, que servia server.js, lib/, docs/, scripts/, test/, services/,
// package.json e logs pra qualquer um. Arquivo novo que precise ser buscado por URL tem que entrar
// numa das listas.
//
// A lista encolheu quando o site da Orgulho Regional saiu daqui: sobrou o que o PRODUTO serve
// aberto — a landing do Oria, a política de privacidade e a hotpage de pagamento do pedido.

const path = require('path');
const express = require('express');

// Diretórios inteiros. `assets` guarda a marca do Oria (landing) e os logos/fontes da hotpage de
// pagamento; `src` guarda o CSS/JS dessa hotpage. O SPA do painel NÃO sai daqui — ele tem rota
// própria em server.js, servindo o build do Vite em admin/dist.
const DIRETORIOS_PUBLICOS = ['assets', 'src'];

// Páginas na raiz.
//
// A landing do Oria responde em `/` e em `/oria`: `/` porque é o que o domínio abre, e `/oria`
// porque é a URL cadastrada no console de OAuth do Google como "página inicial do aplicativo" — a
// verificação exige uma página aberta que diga o nome do app e explique a finalidade dele (/admin
// não serve, é tela de login e não explica nada a quem revisa). As duas servem o MESMO arquivo em
// vez de uma redirecionar pra outra: a verificação do Google lê um 200 com HTML, sem salto.
//
// A política de privacidade responde nas duas formas de propósito: a URL sem extensão é a outra
// cadastrada no console do Google (e que o Google revisita na verificação), então precisa ser
// estável; a .html é só para não quebrar quem chegar pelo nome do arquivo.
//
// `pedido.html` é a hotpage de pagamento Pix: o link vai para o cliente por WhatsApp (variável
// `pedido.link_pagamento`, montada em server.js) e a página em si é servida pela rota
// `/{idpedido}`, no fim do server.js. A entrada aqui mantém o nome do arquivo funcionando.
const PAGINAS_RAIZ = {
  '/': 'oria.html',
  '/oria': 'oria.html',
  '/oria.html': 'oria.html',
  '/pedido.html': 'pedido.html',
  '/politica-de-privacidade': 'politica-de-privacidade.html',
  '/politica-de-privacidade.html': 'politica-de-privacidade.html',
};

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
}

module.exports = { montarArquivosPublicos, DIRETORIOS_PUBLICOS, PAGINAS_RAIZ };
