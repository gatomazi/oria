'use strict';

// Cliente HTTP do serviço Python do Gerador de Criativos (apps/creative-generator).
// Falha graciosa por desenho: sem URL/token configurados, com o serviço fora do ar ou lento, toda chamada
// lança CoreUnavailableError (as rotas viram 503) — nada no boot do Node depende do serviço.
// A OpenAI key do tenant só trafega no corpo de /v1/generations e /v1/copies; nunca em log, header ou URL.

const TIMEOUTS_MS = {
  health: 5_000,
  contracts: 15_000,
  validate: 15_000,
  plans: 30_000,
  generations: 240_000,
  copies: 90_000,
};

const CONTRACT_NAME_RE = /^[A-Za-z]{1,40}$/;

class CoreUnavailableError extends Error {
  constructor(reason) {
    super('serviço do gerador de criativos indisponível');
    this.name = 'CoreUnavailableError';
    this.code = 'CORE_UNAVAILABLE';
    this.reason = reason;
    this.httpStatus = 503;
    this.retryable = true;
  }
}

// Erro de negócio devolvido pelo core (GenerationError). `message` é segura por contrato
// (handoff §19): nunca contém key, prompt ou stack trace.
class CoreRequestError extends Error {
  constructor(status, coreError) {
    super((coreError && coreError.message) || 'o serviço do gerador recusou a requisição');
    this.name = 'CoreRequestError';
    this.code = (coreError && coreError.code) || 'CORE_ERROR';
    this.httpStatus = status === 401 ? 503 : 422; // 401 aqui é token de serviço errado: problema de infra, não do usuário
    this.retryable = Boolean(coreError && coreError.retryable);
    this.details = (coreError && coreError.details) || {};
  }
}

function createCoreClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeouts = {} } = {}) {
  let base = null;
  try {
    if (baseUrl) {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') base = parsed;
    }
  } catch {
    base = null;
  }
  const configured = Boolean(base && typeof token === 'string' && token.length >= 32);
  const limites = { ...TIMEOUTS_MS, ...timeouts };

  async function call(method, path, body, timeoutKey) {
    if (!configured) throw new CoreUnavailableError('not_configured');
    let res;
    try {
      res = await fetchImpl(new URL(path, base).toString(), {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(limites[timeoutKey]),
      });
    } catch (err) {
      throw new CoreUnavailableError(err && err.name === 'TimeoutError' ? 'timeout' : 'unreachable');
    }
    const texto = await res.text().catch(() => '');
    let data = {};
    try {
      data = texto ? JSON.parse(texto) : {};
    } catch {
      data = {};
    }
    if (res.status >= 500) throw new CoreUnavailableError(`status_${res.status}`);
    if (!res.ok) throw new CoreRequestError(res.status, data.error || null);
    return data;
  }

  return {
    configured,
    health: () => call('GET', '/v1/health', undefined, 'health'),
    contracts: () => call('GET', '/v1/contracts', undefined, 'contracts'),
    validate: (contract, payload) => {
      if (!CONTRACT_NAME_RE.test(String(contract))) throw new CoreRequestError(404, { code: 'NOT_FOUND', message: 'Contrato inexistente.' });
      return call('POST', `/v1/validate/${contract}`, { payload }, 'validate');
    },
    plan: (request) => call('POST', '/v1/plans', { request }, 'plans').then((d) => d.plan),
    generate: ({ plan, references, apiKey, attempt = 1 }) =>
      call('POST', '/v1/generations', { plan, references, openai_api_key: apiKey, generation_attempt: attempt }, 'generations')
        .then((d) => d.result),
    copies: ({ request, apiKey }) =>
      call('POST', '/v1/copies', { request, openai_api_key: apiKey }, 'copies').then((d) => d.variants),
  };
}

module.exports = { createCoreClient, CoreUnavailableError, CoreRequestError, TIMEOUTS_MS };
