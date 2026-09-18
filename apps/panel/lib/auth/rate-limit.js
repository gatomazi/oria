'use strict';

// Limite de tentativas de login (Fase 2).
//
// A chave é a CONTA (e-mail normalizado), não o IP: sem `trust proxy` validado (QW-01), `req.ip`
// é o endereço do proxy do Railway — um balde único para todo mundo. Um balde global largo existe
// só para frear varredura de muitas contas; ele não bloqueia login que dá certo.
//
// Em memória, processo único (topologia atual). Várias réplicas precisariam de store compartilhado.
//
// O mesmo mecanismo serve ao aceite de convite (`createConviteLimiter`, no fim do arquivo): lá a
// chave também não pode ser o IP, e também não pode ser a conta — o e-mail do convite só é
// conhecido DEPOIS de consultar o convite, que é exatamente o que se quer limitar.

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

// Limite do aceite de convite (lib/auth/invites.js). Mesmo balde de dois níveis do login, com a
// chave e os números escolhidos para o que esta rota é: uma rota ANÔNIMA que recebe um segredo no
// corpo do request.
//
//   chave = 'convite:' + os 12 primeiros hex do SHA-256 do token
//
// Por que não o IP: atrás do proxy do Railway, `req.ip` é o endereço do proxy (QW-01) — um balde
// único para o mundo inteiro, que o primeiro erro de qualquer pessoa fecharia para todas.
// Por que não a conta: o e-mail é do CONVITE, e só é conhecido depois de consultá-lo no banco —
// é justamente a consulta que está sendo limitada.
// Por que o hash e não o token: o balde é uma estrutura em memória com chaves inspecionáveis em
// heap dump e em log de erro; o token cru nunca sai do request. O prefixo curto basta para
// separar convites e não reconstrói o hash gravado no banco.
//
// O que cada balde faz:
//   por chave (10 / 15 min)  freia o LOOP em cima de um mesmo token — o caso do link vazado.
//   global (60 / min)        é a defesa real contra VARREDURA: cada token chutado é uma chave
//                            nova, então só o balde global a vê. Com 256 bits de token o chute
//                            não tem chance estatística; o limite existe para que a tentativa não
//                            custe CPU e conexão de banco.
//
// Baldes SEPARADOS dos do login, de propósito: uma varredura de convites não pode consumir a
// franquia de quem está tentando entrar, e vice-versa.
function createConviteLimiter(opcoes = {}) {
  return createLoginLimiter({
    maxPorConta: 10,
    janelaMs: 15 * 60 * 1000,
    maxGlobal: 60,
    janelaGlobalMs: 60 * 1000,
    ...opcoes,
  });
}

module.exports = { createLoginLimiter, createConviteLimiter };
