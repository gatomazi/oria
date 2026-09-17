'use strict';

// INV-15 / B-08 / TD-005 — o tenant de um webhook é determinado pela ROTA, antes de processar.
//
// O que existe hoje (`identifyInkWebhookStore`, `server.js:1280-1291` em 8a7ea3d): um endpoint só,
// e a loja é descoberta testando o segredo de CADA loja em sequência até um casar. Três problemas,
// em ordem de gravidade:
//
//   1. o tenant de destino passa a ser "de quem for o segredo que casou primeiro" — a ordem de
//      iteração de um objeto vira regra de roteamento;
//   2. a assinatura deixa de ser verificação e vira BUSCA: O(n) HMACs por evento, crescendo com a
//      base de assinantes;
//   3. um segredo vazado de um tenant é aceito em qualquer entrega, porque não há rota que
//      restrinja contra qual segredo ele é testado.
//
// Aqui: a URL carrega um token opaco por conexão; ele resolve a conexão; a assinatura é conferida
// contra UM segredo, o daquela conexão. Assinar com o segredo de A e entregar na rota de B é
// rejeitado — e, principalmente, NÃO é roteado para A.

const crypto = require('crypto');

class WebhookRoutingError extends Error {
  constructor(message, { motivo }) {
    super(message);
    this.name = 'WebhookRoutingError';
    this.motivo = motivo;
  }
}

// Comparação em tempo constante e resistente a comprimentos diferentes (timingSafeEqual lança se
// os buffers tiverem tamanhos distintos, e esse throw já seria um oráculo de comprimento).
function comparacaoSegura(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  const tamanhoIgual = ba.length === bb.length;
  // Compara sempre contra um buffer do mesmo tamanho para o custo não depender do input.
  const alvo = tamanhoIgual ? bb : ba;
  const iguais = crypto.timingSafeEqual(ba, alvo);
  return tamanhoIgual && iguais;
}

// Esquema confirmado com entregas reais da Ink:
// X-Webhook-Signature = base64( hex( HMAC-SHA256(secret, corpo) ) )
function assinaturaEsperada(segredo, rawBody) {
  const hex = crypto.createHmac('sha256', segredo).update(rawBody).digest('hex');
  return Buffer.from(hex).toString('base64');
}

// Resolve a conexão e valida a assinatura, nessa ordem.
//
// `buscarConexaoPorToken(token)` devolve `{ id, organizationId, webhookSecret }` ou null. É
// síncrono de propósito na assinatura do resolvedor: um lookup por chave primária, não uma busca.
//
// `conexoesConhecidas` está aqui pela mesma razão de `candidatas` em ownership.js — para que o
// negative control consiga reintroduzir o defeito histórico (varrer todas as conexões testando
// cada segredo) e o invariant consiga reprovar.
function resolveWebhookConnection({ routeToken, signature, rawBody, buscarConexaoPorToken, conexoesConhecidas = [] } = {}) {
  void conexoesConhecidas;

  if (!routeToken) {
    throw new WebhookRoutingError('rota de webhook sem token de conexão', { motivo: 'sem-token' });
  }

  const conexao = buscarConexaoPorToken(routeToken);
  if (!conexao) {
    // Não existe fallback "então tenta descobrir pelo corpo". Evento não atribuível é descartado.
    throw new WebhookRoutingError('token de rota desconhecido', { motivo: 'conexao-desconhecida' });
  }

  if (!conexao.webhookSecret) {
    // Ausência de segredo NUNCA desabilita a verificação (é o defeito WG-06/B-25 do serviço Go).
    throw new WebhookRoutingError(
      'conexão sem webhook secret configurado — entrega rejeitada, não aceita sem verificar',
      { motivo: 'sem-segredo' }
    );
  }

  if (!signature || !rawBody) {
    throw new WebhookRoutingError('entrega sem assinatura ou sem corpo', { motivo: 'sem-assinatura' });
  }

  if (!comparacaoSegura(signature, assinaturaEsperada(conexao.webhookSecret, rawBody))) {
    throw new WebhookRoutingError('assinatura inválida para esta conexão', { motivo: 'assinatura-invalida' });
  }

  return { conexaoId: conexao.id, organizationId: conexao.organizationId };
}

// Token de rota: 32 bytes de CSPRNG. Nunca sequencial, nunca `Math.random`, nunca derivado do nome
// da loja — a URL é o identificador do tenant e precisa ser inadivinhável.
function gerarRouteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
  WebhookRoutingError,
  resolveWebhookConnection,
  gerarRouteToken,
  assinaturaEsperada,
  comparacaoSegura,
};
