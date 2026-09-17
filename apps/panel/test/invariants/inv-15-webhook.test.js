'use strict';

// INV-15 — o tenant do webhook é determinado pela ROTA, antes de processar.
// Classe crítica: webhook.
//
// O teste central é o do plano, literal: assinar um evento com o segredo de A e entregá-lo na rota
// de B. O resultado correto tem DUAS partes, e a segunda é a que importa — a entrega precisa ser
// rejeitada, E não pode ser roteada para A.
//
// A violação que o negative control introduz é `identifyInkWebhookStore` (`server.js:1280-1291`):
// varre as conexões testando cada segredo e devolve a primeira que casar. Com ela, o evento de A
// entregue na rota de B é ACEITO e processado como A — a URL deixa de significar qualquer coisa.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { resolveWebhookConnection, gerarRouteToken, assinaturaEsperada, comparacaoSegura, WebhookRoutingError } =
  h.sujeito('lib/platform/webhook-routing.js');

const SEGREDO_A = 'segredo-da-conexao-A-nao-compartilhado';
const SEGREDO_B = 'segredo-da-conexao-B-nao-compartilhado';

const TOKEN_A = gerarRouteToken();
const TOKEN_B = gerarRouteToken();

const CONEXOES = [
  { id: 'conn-a', organizationId: 'org-a', routeToken: TOKEN_A, webhookSecret: SEGREDO_A },
  { id: 'conn-b', organizationId: 'org-b', routeToken: TOKEN_B, webhookSecret: SEGREDO_B },
];

const buscarConexaoPorToken = (token) => CONEXOES.find((c) => c.routeToken === token) || null;

const CORPO = Buffer.from(JSON.stringify({ event: 'order.paid', order: { id: 1982524 } }));

function entregar({ routeToken, segredoQueAssinou, corpo = CORPO }) {
  return resolveWebhookConnection({
    routeToken,
    signature: assinaturaEsperada(segredoQueAssinou, corpo),
    rawBody: corpo,
    buscarConexaoPorToken,
    conexoesConhecidas: CONEXOES,
  });
}

test('INV-15 · o caminho correto funciona: A assina, A entrega na rota de A', () => {
  assert.deepEqual(
    entregar({ routeToken: TOKEN_A, segredoQueAssinou: SEGREDO_A }),
    { conexaoId: 'conn-a', organizationId: 'org-a' }
  );
  assert.deepEqual(
    entregar({ routeToken: TOKEN_B, segredoQueAssinou: SEGREDO_B }),
    { conexaoId: 'conn-b', organizationId: 'org-b' }
  );
});

test('INV-15 · evento assinado por A entregue na rota de B é REJEITADO e não roteado para A', () => {
  let roteou = null;
  try {
    roteou = entregar({ routeToken: TOKEN_B, segredoQueAssinou: SEGREDO_A });
  } catch (err) {
    assert.ok(err instanceof WebhookRoutingError);
    assert.equal(err.motivo, 'assinatura-invalida');
  }
  assert.equal(
    roteou,
    null,
    'a entrega foi aceita. Com a varredura de segredos, o evento de A chega como A numa rota de B'
  );
});

test('INV-15 · rota desconhecida é descartada — não há busca pelo corpo como plano B', () => {
  assert.throws(
    () => entregar({ routeToken: gerarRouteToken(), segredoQueAssinou: SEGREDO_A }),
    (err) => err instanceof WebhookRoutingError && err.motivo === 'conexao-desconhecida'
  );
  assert.throws(
    () => entregar({ routeToken: '', segredoQueAssinou: SEGREDO_A }),
    (err) => err instanceof WebhookRoutingError && err.motivo === 'sem-token'
  );
});

test('INV-15 · conexão sem segredo REJEITA a entrega — ausência nunca desabilita a verificação', () => {
  const semSegredo = [{ id: 'conn-c', organizationId: 'org-c', routeToken: 'tok-c', webhookSecret: null }];
  assert.throws(
    () => resolveWebhookConnection({
      routeToken: 'tok-c',
      signature: 'qualquer',
      rawBody: CORPO,
      buscarConexaoPorToken: (t) => semSegredo.find((c) => c.routeToken === t) || null,
      conexoesConhecidas: semSegredo,
    }),
    (err) => err instanceof WebhookRoutingError && err.motivo === 'sem-segredo',
    'é o defeito WG-06/B-25 do serviço Go: sem segredo, o HMAC deixa de ser verificado'
  );
});

test('INV-15 · entrega sem assinatura é rejeitada', () => {
  assert.throws(
    () => resolveWebhookConnection({
      routeToken: TOKEN_A, signature: null, rawBody: CORPO, buscarConexaoPorToken, conexoesConhecidas: CONEXOES,
    }),
    (err) => err instanceof WebhookRoutingError && err.motivo === 'sem-assinatura'
  );
});

test('INV-15 · corpo adulterado com assinatura válida do corpo original é rejeitado', () => {
  const adulterado = Buffer.from(JSON.stringify({ event: 'order.paid', order: { id: 9999999 } }));
  assert.throws(
    () => resolveWebhookConnection({
      routeToken: TOKEN_A,
      signature: assinaturaEsperada(SEGREDO_A, CORPO),
      rawBody: adulterado,
      buscarConexaoPorToken,
      conexoesConhecidas: CONEXOES,
    }),
    (err) => err instanceof WebhookRoutingError && err.motivo === 'assinatura-invalida'
  );
});

test('INV-15 · o token de rota é CSPRNG e inadivinhável', () => {
  const tokens = new Set(Array.from({ length: 200 }, gerarRouteToken));
  assert.equal(tokens.size, 200, 'token de rota repetido — a URL é o identificador do tenant');
  for (const t of tokens) assert.ok(t.length >= 40, `token curto demais: ${t.length}`);
});

test('INV-15 · a comparação de assinatura não estoura com comprimentos diferentes', () => {
  assert.equal(comparacaoSegura('abc', 'abc'), true);
  assert.equal(comparacaoSegura('abc', 'abcdef'), false);
  assert.equal(comparacaoSegura('', 'x'), false);
  assert.equal(comparacaoSegura(null, undefined), true); // ambos viram string vazia
  // E continua sendo a comparação certa para a assinatura real.
  const sig = assinaturaEsperada(SEGREDO_A, CORPO);
  assert.equal(comparacaoSegura(sig, sig), true);
  assert.equal(comparacaoSegura(sig, assinaturaEsperada(SEGREDO_B, CORPO)), false);
});

test('INV-15 · a assinatura segue o esquema real da Ink: base64(hex(HMAC-SHA256))', () => {
  const hex = crypto.createHmac('sha256', SEGREDO_A).update(CORPO).digest('hex');
  assert.equal(assinaturaEsperada(SEGREDO_A, CORPO), Buffer.from(hex).toString('base64'));
});
