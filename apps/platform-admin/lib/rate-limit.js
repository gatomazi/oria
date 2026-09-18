'use strict';

// ── CÓPIA DECLARADA ──────────────────────────────────────────────────────────────────────────
// Origem: apps/panel/lib/auth/rate-limit.js. Não é require (ver lib/db.js).
//
// A chave é a CONTA (e-mail normalizado), não o IP: atrás do proxy do Railway, `req.ip` é o
// endereço do proxy — um balde único para todo mundo. O balde global largo existe só para frear
// varredura de muitas contas; ele não bloqueia login que dá certo.
//
// Em memória, processo único. Várias réplicas precisariam de store compartilhado — limitação
// registrada, igual à do painel.

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

  // Segundos até o balde da conta (ou o global) liberar. Vira o header Retry-After.
  function esperaEmSegundos(conta) {
    const t = agora();
    const e = porConta.get(conta);
    const ateConta = e && t <= e.ate && e.n >= maxPorConta ? e.ate : 0;
    const ateGlobal = global.n >= maxGlobal ? global.ate : 0;
    const ate = Math.max(ateConta, ateGlobal);
    return ate > t ? Math.ceil((ate - t) / 1000) : 1;
  }

  function registrarFalha(conta) {
    const t = agora();
    if (t > global.ate) global = { n: 0, ate: t + janelaGlobalMs };
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

  return { bloqueado, esperaEmSegundos, registrarFalha, registrarSucesso };
}

module.exports = { createLoginLimiter };
