'use strict';

// UX do cadastro do webhook da Reserva Ink (src/pages/integracoes/InkWebhookGuia.tsx e o card de
// credencial). O tenant precisa saber EXATAMENTE o que cadastrar (URL, eventos, segredo, como
// confirmar) sem que o segredo salvo jamais reapareça inteiro.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');

const DIR = path.join(h.RAIZ_SUJEITO, 'src');
const guia = fs.readFileSync(path.join(DIR, 'pages', 'integracoes', 'InkWebhookGuia.tsx'), 'utf8');
const card = fs.readFileSync(path.join(DIR, 'pages', 'integracoes', 'InkCredenciaisCard.tsx'), 'utf8');
const rotulos = fs.readFileSync(path.join(DIR, 'lib', 'eventLabels.ts'), 'utf8');

const eventosDoGuia = [...guia.matchAll(/^\s+'([a-z_]+\.[a-z_]+)',$/gm)].map((m) => m[1]);

test('o guia lista os eventos que o Oria entende, e todos têm rótulo humano', () => {
  assert.ok(eventosDoGuia.length >= 10, `eventos encontrados: ${eventosDoGuia.length}`);
  for (const evento of eventosDoGuia) {
    assert.ok(rotulos.includes(`'${evento}':`), `o evento ${evento} não tem rótulo em eventLabels.ts`);
  }
  for (const essencial of ['order.created', 'payment.approved', 'order.canceled', 'shipping.delivered', 'cart.abandoned']) {
    assert.ok(eventosDoGuia.includes(essencial), `falta ${essencial}`);
  }
});

test('o guia explica a ORDEM (URL → Reserva Ink → segredo → confirmar) e que a URL aparece uma vez', () => {
  assert.match(guia, /Gere a URL/);
  assert.match(guia, /painel da Reserva Ink/);
  assert.match(guia, /Marque os eventos/);
  assert.match(guia, /Copie o segredo/);
  assert.match(guia, /Confirme/);
  assert.match(guia, /uma única vez/);
  assert.match(guia, /Último evento recebido/);
  assert.match(guia, /Sem o segredo salvo o Oria recusa os eventos/);
});

test('o segredo salvo nunca reaparece inteiro: só os 4 últimos caracteres, e o campo é senha e é limpo ao salvar', () => {
  assert.match(card, /type="password"[^>]*value=\{segredoWebhook\}/, 'o campo do segredo é do tipo senha');
  assert.match(card, /setSegredoWebhook\(''\)/, 'o segredo sai do estado da tela depois de enviado');
  assert.match(card, /segredoFinal=\{segredoWebhookInfo\?\.last4 \|\| null\}/);
  // O valor digitado nunca é interpolado em texto visível nem em log.
  assert.doesNotMatch(card, /\$\{segredoWebhook\}/);
  assert.doesNotMatch(card, /console\.(log|info|debug)\(/);
  assert.doesNotMatch(guia, /segredoWebhook/);
});

test('o guia fica recolhido, e o recebimento não ativado é orientação — não pendência nem jargão', () => {
  assert.match(guia, /open=\{aberto\}/);
  assert.match(card, /const \[guiaAberto, setGuiaAberto\] = useState\(false\)/, 'o guia começa recolhido');
  assert.doesNotMatch(card, /Webhook pendente/, 'sem o recebimento automático, o selo não diz "pendente"');
  assert.doesNotMatch(card, /Webhook não ativado/, 'a tela do lojista não usa o jargão "webhook não ativado"');
  assert.match(card, /O recebimento automático ainda não está ativado/);
  assert.match(card, /Não é uma falha/, 'a ausência do recebimento é dita como não-falha (adiado de propósito)');
  assert.match(card, /Ativar recebimento automático/, 'a ação necessária continua visível para o responsável');
});
