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
// Só o texto que o visitante vê: sem <script>, <style> e comentários HTML.
const semTags = (s) => s
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

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
  // CTA comercial vai para o WhatsApp (decisão do dono, 30/09/2026); nenhum CTA de conversão usa mailto.
  const ctas = html.match(/<a [^>]*>\s*Conhecer o Oria/g) || [];
  assert.ok(ctas.length >= 3, 'CTAs "Conhecer o Oria" presentes');
  for (const cta of ctas) {
    assert.match(cta, /href="https:\/\/wa\.me\/5548996889411\?text=/, 'CTA abre o WhatsApp comercial');
    assert.match(cta, /rel="noopener noreferrer"/);
  }
  assert.match(semTags(html), /O Oria é operado pelo Orgulho Regional/);
});

test('landing · usa a marca oficial servida pela allowlist', () => {
  for (const arquivo of ['oria-simbolo.png', 'oria-wordmark.png']) {
    assert.match(html, new RegExp(`src="/assets/oria/${arquivo.replace('.', '\\.')}"`));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'oria', arquivo)), `${arquivo} existe`);
  }
});

// As demos usam dados fictícios por regra interna (comentário no HTML). O aviso não aparece na
// interface pública por decisão de produto (Home V3), mas a regra continua escrita na página.
test('landing · sem scripts externos; regra interna de dados fictícios registrada', () => {
  assert.doesNotMatch(html, /<script[^>]+src=/, 'nenhum script de terceiros na página pública');
  assert.match(html, /<!-- Regra interna \(QA\/produção\): toda demo desta página usa dados fictícios/);
});

test('landing · só funcionalidades liberadas: nada de afiliados, multi-loja ou promessa sem lastro', () => {
  const texto = semTags(html).toLowerCase();
  // Cada item daqui tem motivo na auditoria de 30/09 (docs fora do repo): afiliados em flag, 1 loja
  // por workspace, webhook Ink desligado (nada é "tempo real"), automações por evento e follow-up de
  // Pix ainda não rodam em Store nativa, modo manual da API Meta sem tela de revisão.
  const proibidos = [
    'afiliad', 'parceri', 'todas as suas lojas', 'várias lojas', 'multi-loja', 'depoimento',
    'tempo real', 'instantâne', 'automaticamente', 'envio automático', 'revisão antes do envio',
    'feed de catálogo', 'controle de estoque', 'ia inclusa', 'grátis', 'gratuit',
    // Posicionamento (Home V3): a Reserva Ink é o principal conector hoje, não o limite da marca.
    'criado para quem opera uma loja reserva ink', 'para lojas reserva ink', 'dados fictícios',
  ];
  for (const proibido of proibidos) {
    assert.ok(!texto.includes(proibido), `a landing não menciona "${proibido}"`);
  }
});

test('landing · diz para quem é acima da dobra', () => {
  const heroi = html.slice(html.indexOf('<section class="heroi"'), html.indexOf('</section>'));
  assert.match(semTags(heroi), /Reserva Ink/);
  assert.match(semTags(heroi), /Oria é um painel de gestão para lojas/);
});

// Regressão da versão anterior: `.js .revela { opacity: 0 }` deixava tudo abaixo do herói invisível
// em captura de página inteira e quando o script quebrava. Conteúdo tem que ser visível no HTML puro.
test('landing · nenhum conteúdo nasce invisível à espera de JS', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.doesNotMatch(css, /opacity:\s*0\s*[;}]/, 'nenhuma regra deixa conteúdo com opacity 0');
  assert.doesNotMatch(css, /from\s*\{[^}]*opacity:\s*0\s*[;}]/, 'nenhuma animação parte de opacity 0');
  assert.doesNotMatch(html, /role="tabpanel"[^>]*\shidden/, 'painéis de abas não nascem ocultos (o script é quem oculta)');
  assert.doesNotMatch(html, /class="js"|classList\.add\('js'\)/, 'sem gatilho global de ocultação no <head>');
});
