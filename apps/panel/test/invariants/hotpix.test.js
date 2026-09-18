'use strict';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A hotpage de pagamento Pix mora em /hotpix/{id} — e em mais lugar nenhum
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// A hotpage respondia em `/{id}`: um segmento só, sem prefixo. Isso a deixava ambígua com QUALQUER
// outra rota de um segmento do serviço (a landing, `/admin`, `/oria`, `/politica-de-privacidade`),
// e o que segurava a ambiguidade era a ordem de registro no Express mais um regex de comprimento
// (10-14 caracteres). Nenhuma das duas coisas é visível para quem escreve a próxima rota: uma
// página nova de 12 caracteres teria colidido em silêncio, e o sintoma seria um link de pagamento
// abrindo a página errada.
//
// O prefixo tira a ambiguidade de vez. Este arquivo trava os três fatos que a mudança precisa
// manter:
//
//   1. `/hotpix/{id}` serve a hotpage;
//   2. NENHUMA rota de um segmento serve a hotpage — o esquema antigo não voltou nem como
//      redirect (não precisa: os links que já foram enviados a clientes saíram da stack legada,
//      em outro domínio e outro servidor, que continua servindo aqueles links; neste serviço
//      ainda não circulou nenhum);
//   3. o link que o lembrete de Pix monta e a variável de template mostrada na tela usam o
//      caminho novo — senão o cliente recebe uma URL que dá 404.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('./harness');

const SERVER = path.join(h.RAIZ_REPO, 'server.js');
const HOTPAGE = path.join(h.RAIZ_REPO, 'pedido.html');

// Ambiente mínimo e explícito, igual ao de site-fora.test.js: o que se mede aqui é roteamento,
// não dado, então nada de Postgres.
function ambiente(porta) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-hotpix-'));
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

// O HTML é estático e igual para qualquer pedido: quem resolve o id e busca o dado é
// src/pedido.js, contra `/api/pedidos/:id`. Por isso o 200 vale para um id inventado — o que se
// mede é a rota existir, não o pedido existir.
test('hotpix · /hotpix/{id} serve a hotpage de pagamento', async () => {
  const esperado = fs.readFileSync(HOTPAGE, 'utf8');
  for (const id of ['AbCdEfGhIj', 'ZZ12345678901', 'x_y-z0123456']) {
    const res = await fetch(`${base}/hotpix/${id}`);
    assert.equal(res.status, 200, id);
    assert.match(res.headers.get('content-type') || '', /text\/html/, id);
    assert.equal(await res.text(), esperado, id);
  }
});

// O controle negativo do corte: nenhuma rota de um segmento serve a hotpage. Os ids abaixo cabem
// exatamente no regex antigo (`[A-Za-z0-9_-]{10,14}`) — se alguém o reintroduzir "por garantia",
// é aqui que aparece.
test('hotpix · nenhuma rota de um segmento serve a hotpage', async () => {
  const hotpage = fs.readFileSync(HOTPAGE, 'utf8');
  for (const url of ['/AbCdEfGhIj', '/ZZ12345678901', '/algumacoisa', '/x_y-z0123456']) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 404, url);
    assert.notEqual(await res.text(), hotpage, `${url} serviu a hotpage`);
  }
});

// As páginas de um segmento que o serviço serve de verdade continuam de pé — a remoção da rota
// curinga não pode ter levado nenhuma junto.
test('hotpix · as páginas públicas de um segmento seguem respondendo', async () => {
  for (const url of ['/', '/oria', '/politica-de-privacidade', '/pedido.html']) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 200, url);
  }
});

// O link que chega ao cliente. `SITE_BASE_URL` continua sendo a fonte do host (a rodada de
// domínios troca essa fonte num helper central) — o que se trava aqui é o CAMINHO.
test('hotpix · o lembrete de Pix monta o link com o caminho novo', () => {
  const servidor = fs.readFileSync(SERVER, 'utf8');

  const montagens = [...servidor.matchAll(/vars\['pedido\.link_pagamento'\]\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(montagens.length, 1, 'o link de pagamento é montado num lugar só');
  assert.equal(montagens[0], '`${SITE_BASE_URL}/hotpix/${hotpage.id}`');

  // O exemplo que o editor de templates mostra é o que a pessoa copia para dentro da mensagem.
  const exemplo = servidor.match(/'pedido\.link_pagamento':\s*'([^']+)'/)[1];
  assert.match(exemplo, /\/hotpix\/[A-Za-z0-9_-]+$/, exemplo);

  const front = fs.readFileSync(path.join(h.RAIZ_REPO, 'src', 'lib', 'templateVariables.ts'), 'utf8');
  const bloco = front.slice(front.indexOf("chave: 'pedido.link_pagamento'"));
  assert.match(bloco.slice(0, bloco.indexOf('},')), /exemplo: '[^']*\/hotpix\/[A-Za-z0-9_-]+'/);
});

// A hotpage lê o id do ÚLTIMO segmento. Enquanto a rota era `/{id}`, ela lia o caminho inteiro —
// mantida como estava, pediria `/api/pedidos/hotpix%2F{id}` e a página nunca carregaria.
test('hotpix · a hotpage lê o id do último segmento do caminho', () => {
  const js = fs.readFileSync(path.join(h.RAIZ_REPO, 'src', 'pedido.js'), 'utf8');
  assert.doesNotMatch(js, /window\.location\.pathname\.replace/, 'ainda lê o caminho inteiro como id');
  assert.match(js, /pathname\.split\('\/'\)\.filter\(Boolean\)/);
});
