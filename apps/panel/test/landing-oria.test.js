'use strict';

// Contrato da landing pública (oria.html), servida em `/` e `/oria`. `/oria` é a URL cadastrada no
// console de OAuth do Google como página inicial do aplicativo, e a verificação lê esta página:
// o nome do app precisa estar visível e no H1, a finalidade explicada, o bloco de dados do Google
// (escopo, Uso Limitado) e o link da política precisam continuar publicados. Um redesign que
// perca qualquer um destes itens reprova a verificação sem nenhum erro visível — daí o teste.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'oria.html'), 'utf8');
const semTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('landing · um único H1, e ele começa pelo nome do app', () => {
  const h1s = html.match(/<h1[\s\S]*?<\/h1>/g) || [];
  assert.equal(h1s.length, 1);
  assert.match(semTags(h1s[0]), /^Oria\b/, 'o H1 começa com "Oria", sem artigo antes');
});

test('landing · título, descrição e indexação', () => {
  assert.match(html, /<title>Oria — [^<]+<\/title>/);
  assert.match(html, /<meta name="description" content="Oria é um painel de gestão para lojas/);
  assert.match(html, /<meta name="robots" content="index, follow"/);
  assert.doesNotMatch(html, /noindex/);
  assert.match(html, /<link rel="canonical" href="https:\/\/orgulhoregional\.com\.br\/oria"/);
});

test('landing · o bloco de dados do Google continua publicado', () => {
  const texto = semTags(html);
  assert.match(html, /<code>analytics\.readonly<\/code>/);
  assert.match(html, /href="https:\/\/developers\.google\.com\/terms\/api-services-user-data-policy"/);
  assert.match(texto, /incluindo os requisitos de Uso Limitado/);
  assert.match(texto, /não altera, não cria e não apaga nada na conta Google/);
  assert.match(texto, /não os usa para publicidade nem para treinar modelos de inteligência artificial/);
});

test('landing · política, painel e contato apontam para destinos reais', () => {
  assert.match(html, /href="\/politica-de-privacidade"/);
  assert.match(html, /href="\/admin"/);
  assert.match(html, /href="mailto:tomazi\.brand@gmail\.com/);
  assert.match(semTags(html), /O Oria é operado pelo Orgulho Regional/);
});

test('landing · usa a marca oficial servida pela allowlist', () => {
  for (const arquivo of ['oria-simbolo.png', 'oria-wordmark.png']) {
    assert.match(html, new RegExp(`src="/assets/oria/${arquivo.replace('.', '\\.')}"`));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'oria', arquivo)), `${arquivo} existe`);
  }
});

test('landing · sem scripts externos e sem dados ilustrativos sem aviso', () => {
  assert.doesNotMatch(html, /<script[^>]+src=/, 'nenhum script de terceiros na página pública');
  assert.match(semTags(html), /Prévia ilustrativa · dados fictícios/);
});

test('landing · só funcionalidades liberadas: nada de afiliados nem visão multi-loja', () => {
  const texto = semTags(html).toLowerCase();
  for (const proibido of ['afiliad', 'parceri', 'todas as suas lojas', 'várias lojas', 'multi-loja', 'depoimento']) {
    assert.ok(!texto.includes(proibido), `a landing não menciona "${proibido}"`);
  }
});
