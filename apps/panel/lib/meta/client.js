'use strict';

// Cliente da Meta Graph / Marketing API (docs/meta-ads-analytics-integracao-v2.md §8, §37, §64).
// Puro o bastante pra ser testado: `fetch` é injetável e nada aqui toca banco nem Express.
//
// Três responsabilidades, e só elas:
//   1. montar a URL com a versão da Graph API configurável (§5.1: nunca hardcodar a versão espalhada);
//   2. paginar de verdade (§91: uma chamada NUNCA contém todos os resultados);
//   3. traduzir erro da Meta num código estável do painel, sem nunca vazar o access token (§6, §65).

// Versão default da Graph API. Configurável por META_API_VERSION justamente porque a spec §92 manda
// confirmar a versão vigente na documentação oficial antes de fixar — este default é o piso, não a
// verdade. Trocar aqui (ou na env) muda TODAS as chamadas de uma vez.
const VERSAO_PADRAO = 'v23.0';
const BASE = 'https://graph.facebook.com';

// Códigos de erro do painel (spec §64). O frontend traduz cada um numa frase; o backend nunca
// devolve a mensagem crua da Meta pro cliente porque ela às vezes ecoa parâmetros da requisição.
const ERROS = {
  TOKEN_EXPIRED: 'META_TOKEN_EXPIRED',
  PERMISSION_DENIED: 'META_PERMISSION_DENIED',
  RATE_LIMIT: 'META_RATE_LIMIT',
  ACCOUNT_NOT_FOUND: 'META_ACCOUNT_NOT_FOUND',
  API_ERROR: 'META_API_ERROR',
  SYNC_FAILED: 'META_SYNC_FAILED',
};

class MetaApiError extends Error {
  constructor(codigo, mensagem, { status = null, metaCode = null, metaSubcode = null, retriable = false } = {}) {
    super(mensagem);
    this.name = 'MetaApiError';
    this.codigo = codigo;
    this.status = status;
    this.metaCode = metaCode;
    this.metaSubcode = metaSubcode;
    this.retriable = retriable;
  }
}

// Mapeia o par (code, error_subcode) da Meta pro código do painel. Os números vêm da tabela de
// erros da Graph API; agrupados por efeito prático, que é o que a UI precisa saber:
// reconectar / não tem acesso / esperar / sumiu / deu ruim.
function classificarErroMeta(status, erro) {
  const code = erro && erro.code !== undefined ? Number(erro.code) : null;
  const subcode = erro && erro.error_subcode !== undefined ? Number(erro.error_subcode) : null;

  // 190 = token inválido/expirado; 102 = sessão expirada. Ambos exigem reconectar — nunca adianta
  // repetir a chamada, então retriable: false de propósito.
  if (code === 190 || code === 102) {
    return new MetaApiError(ERROS.TOKEN_EXPIRED, 'a conexão com a Meta expirou — reconecte a conta', { status, metaCode: code, metaSubcode: subcode });
  }
  // 10 e a faixa 200–299 são permissão ausente (tipicamente ads_read sem Advanced Access).
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return new MetaApiError(ERROS.PERMISSION_DENIED, 'a conta conectada não tem permissão para ler estes dados de anúncios', { status, metaCode: code, metaSubcode: subcode });
  }
  // 4/17/32/613 = limites de aplicação/usuário/página; 80000–80014 = limites específicos de Ads.
  // Estes SIM valem retry com backoff.
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code !== null && code >= 80000 && code <= 80014)) {
    return new MetaApiError(ERROS.RATE_LIMIT, 'limite de requisições da Meta atingido — tentando novamente mais devagar', { status, metaCode: code, metaSubcode: subcode, retriable: true });
  }
  // 803 = objeto não existe; 100/33 = id inválido ou sem permissão de ver aquele objeto.
  if (code === 803 || (code === 100 && subcode === 33)) {
    return new MetaApiError(ERROS.ACCOUNT_NOT_FOUND, 'a conta ou o objeto pedido não existe mais na Meta (ou saiu do seu acesso)', { status, metaCode: code, metaSubcode: subcode });
  }
  // 5xx da própria Meta: transitório, vale repetir.
  const retriable = status !== null && status >= 500;
  return new MetaApiError(ERROS.API_ERROR, 'a Meta recusou a requisição', { status, metaCode: code, metaSubcode: subcode, retriable });
}

// Remove qualquer access_token que tenha entrado numa string antes dela virar log ou mensagem de
// erro (spec §6/§65: token nunca em log, nunca em erro devolvido ao cliente). Rede de segurança —
// a regra principal é o token viajar em header/body, nunca na querystring logada.
function mascararToken(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .replace(/(access_token=)[^&\s]+/gi, '$1***')
    .replace(/(client_secret=)[^&\s]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1***');
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MetaClient {
  // `fetchImpl` e `sleep` injetáveis só pra teste (relógio falso, sem espera real).
  constructor({
    accessToken,
    // HMAC-SHA256 do access token com o app secret. A Meta recomenda em toda chamada server-side e
    // EXIGE quando o app tem "Require App Secret" ligado — sem ele a API responde 190 como se o
    // token estivesse inválido. Quem calcula é quem tem o secret (o server.js), não esta lib.
    appsecretProof = null,
    versao = VERSAO_PADRAO,
    timeoutMs = 60_000,
    maxTentativas = 4,
    fetchImpl = globalThis.fetch,
    sleep = esperar,
    onLog = null,
  } = {}) {
    if (!accessToken) throw new Error('MetaClient exige um access token');
    this.accessToken = accessToken;
    this.appsecretProof = appsecretProof;
    this.versao = versao || VERSAO_PADRAO;
    this.timeoutMs = timeoutMs;
    this.maxTentativas = Math.max(1, maxTentativas);
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.onLog = onLog;
    // Contador de chamadas por instância — vai pro MetaSyncLog.apiCalls (spec §36).
    this.apiCalls = 0;
  }

  url(caminho, params = {}) {
    const limpo = String(caminho).replace(/^\/+/, '');
    const url = new URL(`${BASE}/${this.versao}/${limpo}`);
    const todos = this.appsecretProof ? { ...params, appsecret_proof: this.appsecretProof } : params;
    for (const [k, v] of Object.entries(todos)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return url.toString();
  }

  // Uma requisição, com timeout e retry exponencial. O token vai SEMPRE no header Authorization,
  // nunca na querystring — assim nem um log de URL acidental o expõe.
  async request(caminho, params = {}) {
    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= this.maxTentativas; tentativa += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.apiCalls += 1;
        const res = await this.fetchImpl(this.url(caminho, params), {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          signal: controller.signal,
        });
        const corpo = await res.json().catch(() => ({}));
        if (res.ok) return corpo;
        ultimoErro = classificarErroMeta(res.status, corpo && corpo.error);
      } catch (err) {
        // Rede caiu ou estourou o timeout: transitório por definição, vale repetir.
        ultimoErro = new MetaApiError(ERROS.API_ERROR, `falha de rede ao falar com a Meta: ${mascararToken(err.message)}`, { retriable: true });
      } finally {
        clearTimeout(timer);
      }

      // Nunca repete erro definitivo (token expirado, sem permissão, objeto inexistente) e nunca
      // passa do teto de tentativas — a spec §37 proíbe loop infinito de retry explicitamente.
      if (!ultimoErro.retriable || tentativa === this.maxTentativas) break;
      // Backoff exponencial com jitter: 1s, 2s, 4s (± até 250ms) pra não sincronizar as retentativas.
      const espera = 1000 * 2 ** (tentativa - 1) + Math.floor(Math.random() * 250);
      if (this.onLog) this.onLog({ evento: 'retry', caminho, tentativa, esperaMs: espera, codigo: ultimoErro.codigo });
      await this.sleep(espera);
    }
    throw ultimoErro;
  }

  // Percorre TODAS as páginas de um edge (spec §91). `paging.cursors.after` é o cursor oficial;
  // `limite` existe pra o chamador impor um teto de segurança e nunca ficar preso num edge enorme.
  async *paginar(caminho, params = {}, { maxPaginas = 200 } = {}) {
    let after = null;
    for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
      const corpo = await this.request(caminho, after ? { ...params, after } : params);
      const dados = Array.isArray(corpo.data) ? corpo.data : [];
      for (const item of dados) yield item;
      after = corpo.paging && corpo.paging.cursors ? corpo.paging.cursors.after : null;
      // Sem cursor `after`, ou página vazia: acabou. A Meta devolve `paging.next` mesmo na última
      // página em alguns edges, por isso a parada olha o cursor e o tamanho, não o `next`.
      if (!after || !dados.length) return;
    }
    throw new MetaApiError(ERROS.API_ERROR, `paginação passou de ${maxPaginas} páginas em ${caminho} — abortado para não rodar sem fim`);
  }

  async coletar(caminho, params = {}, opts = {}) {
    const itens = [];
    for await (const item of this.paginar(caminho, params, opts)) itens.push(item);
    return itens;
  }
}

module.exports = {
  MetaClient,
  MetaApiError,
  ERROS,
  VERSAO_PADRAO,
  BASE,
  classificarErroMeta,
  mascararToken,
};
