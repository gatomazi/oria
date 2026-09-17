'use strict';

// Limite de tentativas de login (Fase 2).
//
// A chave é a CONTA (e-mail normalizado), não o IP: sem `trust proxy` validado (QW-01), `req.ip`
// é o endereço do proxy do Railway — um balde único para todo mundo. Um balde global largo existe
// só para frear varredura de muitas contas; ele não bloqueia login que dá certo.
//
// Em memória, processo único (topologia atual). Várias réplicas precisariam de store compartilhado.

function createLoginLimiter({
  maxPorConta = 10,
  janelaMs = 15 * 60 * 1000,
  maxGlobal = 200,
  janelaGlobalMs = 60 * 1000,
  agora = () => Date.now(),
} = {}) {
  const porConta = new Map();
  let global = { n: 0, ate: 0 };

  function bloqueado(conta) {
    const t = agora();
    if (t > global.ate) global = { n: 0, ate: t + janelaGlobalMs };
    if (global.n >= maxGlobal) return true;
    const e = porConta.get(conta);
    if (!e || t > e.ate) return false;
    return e.n >= maxPorConta;
  }

  function registrarFalha(conta) {
    const t = agora();
    global.n += 1;
    const e = porConta.get(conta);
    if (!e || t > e.ate) porConta.set(conta, { n: 1, ate: t + janelaMs });
    else e.n += 1;
    if (porConta.size > 10000) {
      for (const [k, v] of porConta) if (t > v.ate) porConta.delete(k);
    }
  }

  function registrarSucesso(conta) {
    porConta.delete(conta);
  }

  return { bloqueado, registrarFalha, registrarSucesso };
}

module.exports = { createLoginLimiter };
