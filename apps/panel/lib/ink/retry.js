'use strict';

// Retry curto para LEITURA interativa na API da Reserva Ink.
//
// Achado do smoke em produção (2026-09-20): a varredura completa do catálogo (~1.060 chamadas em
// background) disputa a cota da Ink, e uma tela aberta nesse intervalo (Categorias) recebia 429 cru.
// Leitura (GET) é idempotente, então uma ou duas repetições curtas resolvem o caso comum sem o
// usuário perceber; escrita nunca é repetida aqui (a idempotência dela é da chave `Idempotency-Key`).
//
// Se ainda assim a Ink seguir limitando, o erro sai com texto de produto — não o corpo bruto do
// provider — e um código estável para a tela decidir o que fazer.

const ESPERAS_MS = Object.freeze([400, 1200]);
const STATUS_TRANSITORIOS = Object.freeze([429, 502, 503, 504]);
const MENSAGEM_LIMITE = 'a Reserva Ink está limitando as requisições agora — tente de novo em instantes';

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `executar` faz UMA tentativa e lança erro com `status` quando a Ink responde !ok.
async function comRetryDeLeitura(metodo, executar, { esperas = ESPERAS_MS, dormirFn = dormir } = {}) {
  const tentativas = metodo === 'GET' ? esperas.length + 1 : 1;
  let ultimo;
  for (let i = 0; i < tentativas; i += 1) {
    try {
      return await executar();
    } catch (err) {
      ultimo = err;
      if (i === tentativas - 1 || !err || !STATUS_TRANSITORIOS.includes(err.status)) break;
      await dormirFn(esperas[i]);
    }
  }
  if (ultimo && ultimo.status === 429) {
    ultimo.message = MENSAGEM_LIMITE;
    ultimo.codigo = 'INK_RATE_LIMITED';
  }
  throw ultimo;
}

module.exports = { comRetryDeLeitura, ESPERAS_MS, MENSAGEM_LIMITE };
