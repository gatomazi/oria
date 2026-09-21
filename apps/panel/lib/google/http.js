'use strict';

// Cliente HTTP dos endpoints do Google (OAuth, Analytics Admin/Data): timeout, retry curto e erro
// classificado.
//
// Antes, cada chamada era um `fetch` cru: sem timeout (uma resposta que nunca vem pendura a rota), sem
// repetição em 429/5xx (uma oscilação do Google virava erro na tela) e, pior, o corpo bruto do erro do
// provider chegava ao navegador — inclusive `invalid_grant`, que na verdade significa "reconecte".
//
// Regras (spec do round de hardening):
//   · repete SÓ em 429, 500, 502, 503, 504 e falha de rede/timeout — e só em chamada idempotente;
//   · NÃO repete em 400, 401, 403 nem erro de validação: repetir não muda a resposta;
//   · a espera respeita `Retry-After` (até 5 s) e nunca passa do teto de tentativas.

const ESPERAS_MS = Object.freeze([400, 1200]);
const STATUS_TRANSITORIOS = Object.freeze([429, 500, 502, 503, 504]);
const TIMEOUT_PADRAO_MS = 15000;
const ESPERA_MAXIMA_MS = 5000;

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function erroDeRede(err) {
  const nome = err && err.name;
  const codigo = err && (err.code || (err.cause && err.cause.code));
  return nome === 'TimeoutError' || nome === 'AbortError' || nome === 'TypeError'
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(codigo);
}

function esperaDe(resposta, padrao) {
  const cabecalho = resposta && resposta.headers && resposta.headers.get && resposta.headers.get('retry-after');
  const segundos = Number(cabecalho);
  if (Number.isFinite(segundos) && segundos > 0) return Math.min(segundos * 1000, ESPERA_MAXIMA_MS);
  return padrao;
}

// `idempotente`: leitura (GET) ou POST que só LÊ (runReport, troca de refresh token). Uma escrita nunca
// é repetida aqui.
async function fetchGoogle(url, init = {}, { idempotente = null, timeoutMs = TIMEOUT_PADRAO_MS, esperas = ESPERAS_MS, dormirFn = dormir, fetchFn = null } = {}) {
  const podeRepetir = idempotente === null ? (init.method || 'GET').toUpperCase() === 'GET' : idempotente;
  const tentativas = podeRepetir ? esperas.length + 1 : 1;
  const chamar = fetchFn || globalThis.fetch;
  let ultimoErro = null;
  for (let i = 0; i < tentativas; i += 1) {
    const ultima = i === tentativas - 1;
    try {
      const resposta = await chamar(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (ultima || !STATUS_TRANSITORIOS.includes(resposta.status)) return resposta;
      await dormirFn(esperaDe(resposta, esperas[i]));
    } catch (err) {
      ultimoErro = err;
      if (ultima || !erroDeRede(err)) throw err;
      await dormirFn(esperas[i]);
    }
  }
  throw ultimoErro;
}

// Classifica a resposta de erro do Google em algo que a tela sabe tratar. Nunca devolve o corpo bruto.
//   RECONNECT_REQUIRED    o consentimento acabou (invalid_grant, token revogado/expirado, 401)
//   PERMISSION_DENIED     a conta conectada não tem acesso ao recurso (403)
//   RATE_LIMITED          cota do Google (429)
//   PROVIDER_UNAVAILABLE  Google fora do ar (5xx)
//   PROVIDER_ERROR        qualquer outro
function classificarErroGoogle(status, corpo) {
  const dado = corpo && typeof corpo === 'object' ? corpo : {};
  const oauth = String(dado.error && typeof dado.error === 'string' ? dado.error : '');
  const statusGoogle = String((dado.error && dado.error.status) || '');
  if (oauth === 'invalid_grant' || oauth === 'invalid_token' || status === 401 || statusGoogle === 'UNAUTHENTICATED') {
    return { codigo: 'RECONNECT_REQUIRED', httpStatus: 409, mensagem: 'a conexão com o Google expirou ou foi revogada — reconecte' };
  }
  if (status === 403 || statusGoogle === 'PERMISSION_DENIED') {
    return { codigo: 'PERMISSION_DENIED', httpStatus: 403, mensagem: 'a conta do Google conectada não tem acesso a este recurso' };
  }
  if (status === 429 || statusGoogle === 'RESOURCE_EXHAUSTED') {
    return { codigo: 'RATE_LIMITED', httpStatus: 429, mensagem: 'o Google está limitando as requisições agora — tente de novo em instantes' };
  }
  if (status >= 500) {
    return { codigo: 'PROVIDER_UNAVAILABLE', httpStatus: 502, mensagem: 'o Google está indisponível agora — tente de novo em instantes' };
  }
  return { codigo: 'PROVIDER_ERROR', httpStatus: 502, mensagem: 'o Google recusou o pedido' };
}

// Erro pronto para lançar. A mensagem é a de produto; o corpo do provider fica de fora.
function erroGoogle(status, corpo, contexto = '') {
  const c = classificarErroGoogle(status, corpo);
  const err = new Error(contexto ? `${contexto}: ${c.mensagem}` : c.mensagem);
  err.status = c.httpStatus;
  err.codigo = c.codigo;
  err.upstreamStatus = status;
  return err;
}

module.exports = { fetchGoogle, classificarErroGoogle, erroGoogle, ESPERAS_MS, STATUS_TRANSITORIOS };
