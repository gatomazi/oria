'use strict';

// Fase C · cliente HTTP da Reserva Ink para o CommerceConnector novo.
//
// A extração é deliberadamente mínima (§48 da rodada anterior — não refatorar os ~40 handlers
// legados): só a base URL, o request e o retry de leitura, os três já genéricos em
// `server.js`/`lib/ink/retry.js` e sem nenhum acoplamento a `req`/`res`/tabela. O legado continua
// chamando as próprias funções (`inkApiRequestDaStore` etc.) sem mudança nenhuma.
//
// O token NUNCA é parâmetro deste módulo por fora: quem chama `request()` decide COMO obter o
// token (`obterToken`, o mesmo desenho de `inkRequisitar` no legado — server.js:497), então o
// client nunca guarda nem loga credencial. Este arquivo não sabe o que é uma Organization: quem
// resolve o token é o connector, via ConnectorSecretPort.

const { comRetryDeLeitura } = require('../../../ink/retry');

const INK_API_BASE = 'https://api.reserva.ink';

// `Retry-After` em segundos ou data HTTP → milissegundos (null quando ausente/ilegível).
function lerRetryAfterMs(valor, agora = Date.now()) {
  if (valor === null || valor === undefined || valor === '') return null;
  const segundos = Number(valor);
  if (Number.isFinite(segundos) && segundos >= 0) return Math.round(segundos * 1000);
  const data = Date.parse(valor);
  return Number.isNaN(data) ? null : Math.max(0, data - agora);
}

class InkApiError extends Error {
  constructor(message, { status, details, retryAfterMs } = {}) {
    super(message);
    this.name = 'InkApiError';
    this.status = status;
    if (details !== undefined) this.details = details;
    // Só o valor numérico do cabeçalho — quem faz backoff (catalog-sync) o respeita; nada de segredo aqui.
    if (retryAfterMs !== null && retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * @param {{obterToken: (usar: (token: string) => Promise<Response>) => Promise<Response>, baseUrl?: string, fetchImpl?: Function}} opcoes
 *   `obterToken`: recebe uma função `usar(token)` e devolve o resultado dela — o mesmo desenho do
 *   `usarSegredo`/`ConnectorSecretPort.use`, para o token nunca sair do escopo de quem o entrega.
 *   `fetchImpl`: injetável só para teste (mesmo padrão de lib/meta/client.js, lib/google-ads/client.js).
 */
function createInkClient({ obterToken, baseUrl = INK_API_BASE, fetchImpl = globalThis.fetch } = {}) {
  if (typeof obterToken !== 'function') throw new Error('createInkClient exige obterToken');

  async function umaTentativa(metodo, pathAndQuery, { body, extraHeaders, timeoutMs } = {}) {
    const res = await obterToken((token) => fetchImpl(baseUrl + pathAndQuery, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(extraHeaders || {}),
      },
      body: body !== undefined ? JSON.stringify(body || {}) : undefined,
      signal: AbortSignal.timeout(timeoutMs || (metodo === 'GET' || metodo === 'DELETE' ? 15000 : 20000)),
    }));
    if (metodo === 'DELETE' && res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new InkApiError(
        (data.errors && data.errors.join('; ')) || data.error || `INK API respondeu ${res.status}`,
        {
          status: res.status,
          details: metodo !== 'GET' ? data : undefined,
          retryAfterMs: res.status === 429 && res.headers && typeof res.headers.get === 'function' ? lerRetryAfterMs(res.headers.get('retry-after')) : null,
        }
      );
    }
    return data;
  }

  // GET repete curto em 429/502/503/504 (lib/ink/retry.js); escrita nunca repete aqui.
  function request(metodo, pathAndQuery, opcoes) {
    return comRetryDeLeitura(metodo, () => umaTentativa(metodo, pathAndQuery, opcoes));
  }

  return Object.freeze({
    get: (pathAndQuery, opcoes) => request('GET', pathAndQuery, opcoes),
    post: (pathAndQuery, body, extraHeaders, timeoutMs) => request('POST', pathAndQuery, { body, extraHeaders, timeoutMs }),
    patch: (pathAndQuery, body, extraHeaders) => request('PATCH', pathAndQuery, { body, extraHeaders }),
    put: (pathAndQuery, body, extraHeaders) => request('PUT', pathAndQuery, { body, extraHeaders }),
    delete: (pathAndQuery, extraHeaders) => request('DELETE', pathAndQuery, { extraHeaders }),
  });
}

module.exports = { createInkClient, InkApiError, INK_API_BASE, lerRetryAfterMs };
