'use strict';

// Cliente da Google Ads API. Mesmo desenho do lib/meta/client.js: `fetch` injetável, nada aqui toca
// banco nem Express, e o token nunca aparece em log nem em erro devolvido ao cliente.
//
// Três responsabilidades, e só elas:
//   1. executar GAQL com a versão da API configurável num lugar só;
//   2. paginar de verdade — uma resposta NUNCA traz todas as linhas de um relatório;
//   3. traduzir o erro do Google num código estável do painel.
//
// A diferença de forma em relação ao Meta é que aqui não se pedem campos por querystring: manda-se
// uma query GAQL no corpo de um POST para customers/{id}/googleAds:search.

// Versão default. Configurável por GOOGLE_ADS_API_VERSION porque o Google passou a lançar versão
// MENSAL em 2026 e cada uma vive ~1 ano — este default é o piso conhecido (v25, vigente em
// setembro/2026), não uma verdade permanente. Chamar uma versão já desativada devolve 404 em tudo.
const VERSAO_PADRAO = 'v25';
const BASE = 'https://googleads.googleapis.com';

const ERROS = {
  TOKEN_EXPIRED: 'GOOGLE_ADS_TOKEN_EXPIRED',
  PERMISSION_DENIED: 'GOOGLE_ADS_PERMISSION_DENIED',
  // Estado próprio porque tem solução própria e não adianta reconectar: o projeto no Google Cloud
  // ainda está em nível "Teste", que só fala com contas de teste. Sem distinguir isso, o painel
  // diria "sem permissão" e o usuário tentaria reconectar a conta para sempre.
  ACESSO_DE_TESTE: 'GOOGLE_ADS_ACESSO_DE_TESTE',
  RATE_LIMIT: 'GOOGLE_ADS_RATE_LIMIT',
  ACCOUNT_NOT_FOUND: 'GOOGLE_ADS_ACCOUNT_NOT_FOUND',
  QUERY_INVALIDA: 'GOOGLE_ADS_QUERY_INVALIDA',
  API_ERROR: 'GOOGLE_ADS_API_ERROR',
  SYNC_FAILED: 'GOOGLE_ADS_SYNC_FAILED',
};

class GoogleAdsApiError extends Error {
  constructor(codigo, mensagem, { status = null, googleStatus = null, errorCode = null, detalhe = null, retriable = false } = {}) {
    super(mensagem);
    this.name = 'GoogleAdsApiError';
    this.codigo = codigo;
    this.status = status;
    this.googleStatus = googleStatus;
    this.errorCode = errorCode;
    // A frase do próprio Google, preservada. `message` é a versão estável que o painel mostra ao
    // usuário; `detalhe` é o que diz QUAL campo ou valor foi recusado. Traduzir para um código
    // estável e jogar o detalhe fora deixa um erro de código impossível de diagnosticar sem
    // acesso ao log do servidor.
    this.detalhe = detalhe;
    this.retriable = retriable;
  }
}

// O erro do Google vem aninhado: error.details[].errors[].errorCode é um objeto de UMA chave, cujo
// nome é a família do erro (authenticationError, quotaError, ...) e o valor é o caso específico.
// Esta função achata isso em { familia, caso } — sem ela, toda checagem viraria um encadeamento de
// optional chaining espalhado pelo código.
function primeiroErro(corpo) {
  const detalhes = (corpo && corpo.error && corpo.error.details) || [];
  for (const d of detalhes) {
    const erros = (d && d.errors) || [];
    for (const e of erros) {
      const ec = e && e.errorCode;
      if (ec && typeof ec === 'object') {
        const familia = Object.keys(ec)[0];
        if (familia) return { familia, caso: ec[familia], mensagem: e.message || null };
      }
    }
  }
  return null;
}

// Casos de autorização que significam "o PROJETO não tem acesso de produção", não "o usuário não
// tem permissão". Separados porque a ação do usuário é completamente diferente: subir o nível de
// acesso no Google Cloud, não reconectar nem pedir permissão a ninguém.
const CASOS_ACESSO_DE_TESTE = new Set([
  'DEVELOPER_TOKEN_NOT_APPROVED',
  'DEVELOPER_TOKEN_PROHIBITED',
  'PROJECT_NOT_APPROVED',
  'ACCESS_LEVEL_NOT_SUFFICIENT',
]);

function classificarErroGoogle(status, corpo) {
  const e = primeiroErro(corpo);
  const familia = e && e.familia;
  const caso = e && e.caso;
  const googleStatus = (corpo && corpo.error && corpo.error.status) || null;
  // Último recurso: se o Google não mandou frase nenhuma, guarda um resumo do corpo. Um erro de
  // consulta sem nenhuma pista é indepurável, e "sem detalhe" é pior que um JSON truncado.
  let detalhe = (e && e.mensagem) || (corpo && corpo.error && corpo.error.message) || null;
  if (!detalhe && corpo && Object.keys(corpo).length) {
    try { detalhe = JSON.stringify(corpo).slice(0, 400); } catch { detalhe = null; }
  }
  if (!detalhe) detalhe = `HTTP ${status} sem corpo`;
  const meta = { status, googleStatus, errorCode: caso || familia || null, detalhe };

  if (caso && CASOS_ACESSO_DE_TESTE.has(caso)) {
    return new GoogleAdsApiError(
      ERROS.ACESSO_DE_TESTE,
      'o projeto no Google Cloud ainda está com acesso de Teste, que só lê contas de teste — suba para Exploração',
      meta
    );
  }
  // Token inválido/expirado: repetir nunca resolve, então retriable fica false de propósito.
  if (familia === 'authenticationError' || googleStatus === 'UNAUTHENTICATED' || status === 401) {
    return new GoogleAdsApiError(ERROS.TOKEN_EXPIRED, 'a conexão com o Google expirou — reconecte a conta', meta);
  }
  if (familia === 'authorizationError' || googleStatus === 'PERMISSION_DENIED' || status === 403) {
    return new GoogleAdsApiError(ERROS.PERMISSION_DENIED, 'a conta conectada não tem permissão para ler esta conta de anúncios', meta);
  }
  // Cota estourada: é o caso que VALE repetir com espera.
  if (familia === 'quotaError' || googleStatus === 'RESOURCE_EXHAUSTED' || status === 429) {
    return new GoogleAdsApiError(ERROS.RATE_LIMIT, 'limite de requisições do Google atingido — tentando novamente mais devagar', { ...meta, retriable: true });
  }
  if (googleStatus === 'NOT_FOUND' || caso === 'CUSTOMER_NOT_FOUND' || caso === 'BAD_RESOURCE_ID') {
    return new GoogleAdsApiError(ERROS.ACCOUNT_NOT_FOUND, 'a conta de anúncios pedida não existe mais (ou saiu do seu acesso)', meta);
  }
  // Erro de query é bug nosso, não do usuário: nunca repetir, e o código próprio faz aparecer no
  // log como defeito de código em vez de se esconder entre falhas de rede.
  if (familia === 'queryError' || googleStatus === 'INVALID_ARGUMENT' || status === 400) {
    return new GoogleAdsApiError(ERROS.QUERY_INVALIDA, 'a consulta enviada ao Google Ads é inválida', meta);
  }
  const retriable = status !== null && status >= 500;
  return new GoogleAdsApiError(ERROS.API_ERROR, 'o Google Ads recusou a requisição', { ...meta, retriable });
}

// Rede de segurança: remove token de qualquer string antes dela virar log ou mensagem de erro.
function mascararToken(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1***')
    .replace(/("?developer-token"?\s*[:=]\s*"?)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/(access_token=)[^&\s]+/gi, '$1***')
    .replace(/(refresh_token"?\s*[:=]\s*"?)[A-Za-z0-9._\-/+]+/gi, '$1***');
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A API exige o customer id só com dígitos; a interface mostra com hífen.
function soDigitos(customerId) {
  return String(customerId == null ? '' : customerId).replace(/\D/g, '');
}

class GoogleAdsClient {
  constructor({
    accessToken,
    // O developer token deixou de ser exigido em 09/09/2026 (o acesso passou a ser do projeto no
    // Cloud). Fica opcional: se o ambiente ainda tiver um, mandamos; se não, a chamada vai sem ele.
    developerToken = null,
    // Só quando a conta é acessada através de uma conta de administrador (MCC).
    loginCustomerId = null,
    versao = VERSAO_PADRAO,
    timeoutMs = 60_000,
    maxTentativas = 4,
    fetchImpl = globalThis.fetch,
    sleep = esperar,
    onLog = null,
  } = {}) {
    if (!accessToken) throw new Error('GoogleAdsClient exige um access token');
    this.accessToken = accessToken;
    this.developerToken = developerToken;
    this.loginCustomerId = loginCustomerId ? soDigitos(loginCustomerId) : null;
    this.versao = versao || VERSAO_PADRAO;
    this.timeoutMs = timeoutMs;
    this.maxTentativas = Math.max(1, maxTentativas);
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.onLog = onLog;
    this.apiCalls = 0;
  }

  cabecalhos() {
    const h = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
    if (this.developerToken) h['developer-token'] = this.developerToken;
    if (this.loginCustomerId) h['login-customer-id'] = this.loginCustomerId;
    return h;
  }

  url(caminho) {
    return `${BASE}/${this.versao}/${String(caminho).replace(/^\/+/, '')}`;
  }

  async request(caminho, corpo = null, { metodo = 'POST' } = {}) {
    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= this.maxTentativas; tentativa += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.apiCalls += 1;
        const res = await this.fetchImpl(this.url(caminho), {
          method: metodo,
          headers: this.cabecalhos(),
          body: corpo === null ? undefined : JSON.stringify(corpo),
          signal: controller.signal,
        });
        const resposta = await res.json().catch(() => ({}));
        if (res.ok) return resposta;
        ultimoErro = classificarErroGoogle(res.status, resposta);
      } catch (err) {
        ultimoErro = new GoogleAdsApiError(
          ERROS.API_ERROR,
          `falha de rede ao falar com o Google Ads: ${mascararToken(err.message)}`,
          { retriable: true }
        );
      } finally {
        clearTimeout(timer);
      }

      if (!ultimoErro.retriable || tentativa === this.maxTentativas) break;
      const espera = 1000 * 2 ** (tentativa - 1) + Math.floor(Math.random() * 250);
      if (this.onLog) this.onLog({ evento: 'retry', caminho, tentativa, esperaMs: espera, codigo: ultimoErro.codigo });
      await this.sleep(espera);
    }
    throw ultimoErro;
  }

  // Executa uma query GAQL, percorrendo TODAS as páginas. `maxPaginas` é teto de segurança: sem ele
  // um relatório grande (ou um nextPageToken que não avança) prenderia o sync para sempre.
  async *consultar(customerId, query, { maxPaginas = 200 } = {}) {
    const id = soDigitos(customerId);
    if (!/^\d{10}$/.test(id)) throw new GoogleAdsApiError(ERROS.ACCOUNT_NOT_FOUND, 'customer id precisa ter 10 dígitos');
    let pageToken = null;
    for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
      // Sem pageSize: o Google passou a usar página de tamanho fixo (10000 linhas) e RECUSA o
      // parâmetro — mandá-lo derruba a consulta inteira com "Setting the page size is not
      // supported". A paginação continua pelo nextPageToken, que não mudou.
      const corpo = { query };
      if (pageToken) corpo.pageToken = pageToken;
      const resposta = await this.request(`customers/${id}/googleAds:search`, corpo);
      const linhas = Array.isArray(resposta.results) ? resposta.results : [];
      for (const linha of linhas) yield linha;
      pageToken = resposta.nextPageToken || null;
      if (!pageToken) return;
    }
    throw new GoogleAdsApiError(
      ERROS.API_ERROR,
      `a consulta passou de ${maxPaginas} páginas — abortada para não rodar sem fim`
    );
  }

  async coletar(customerId, query, opts = {}) {
    const linhas = [];
    for await (const linha of this.consultar(customerId, query, opts)) linhas.push(linha);
    return linhas;
  }

  // Contas que este token enxerga. Devolve customer ids sem hífen, no formato que a API exige.
  async contasAcessiveis() {
    const resposta = await this.request('customers:listAccessibleCustomers', null, { metodo: 'GET' });
    const nomes = Array.isArray(resposta.resourceNames) ? resposta.resourceNames : [];
    return nomes.map((n) => String(n).replace('customers/', '')).filter((id) => /^\d{10}$/.test(id));
  }
}

module.exports = {
  GoogleAdsClient,
  GoogleAdsApiError,
  ERROS,
  VERSAO_PADRAO,
  BASE,
  CASOS_ACESSO_DE_TESTE,
  classificarErroGoogle,
  primeiroErro,
  mascararToken,
  soDigitos,
};
