'use strict';

// Cliente da Google Ads API (lib/google-ads/client.js). `fetch` é injetado, então nada aqui toca a
// rede. O que está sob teste é o comportamento que só aparece quando algo dá errado: qual erro é
// definitivo, qual vale repetir, e se o token vaza em alguma mensagem.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GoogleAdsClient, GoogleAdsApiError, ERROS, classificarErroGoogle, mascararToken, soDigitos,
} = require('../lib/google-ads/client');

const CUSTOMER = '1234567890';

function resposta(status, corpo) {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo };
}

function erroGoogle(familia, caso, googleStatus) {
  return {
    error: {
      code: 400, status: googleStatus || 'INVALID_ARGUMENT', message: 'erro',
      details: [{ errors: [{ errorCode: { [familia]: caso }, message: 'detalhe' }] }],
    },
  };
}

// Cliente com fetch falso; devolve as respostas da fila, uma por chamada.
function clienteFalso(respostas, opts = {}) {
  const chamadas = [];
  const cliente = new GoogleAdsClient({
    accessToken: 'ya29.token-secreto',
    sleep: async () => {},                    // sem espera real no teste
    fetchImpl: async (url, init) => {
      chamadas.push({ url, init });
      const r = respostas.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    ...opts,
  });
  return { cliente, chamadas };
}

// ── Classificação de erro ───────────────────────────────────────────────────────────────────

test('acesso de teste vira código próprio, não "sem permissão"', () => {
  // A ação do usuário é subir o nível no Google Cloud, não reconectar a conta. Sem separar, ele
  // reconectaria para sempre sem nunca resolver.
  const e = classificarErroGoogle(403, erroGoogle('authorizationError', 'DEVELOPER_TOKEN_NOT_APPROVED', 'PERMISSION_DENIED'));
  assert.equal(e.codigo, ERROS.ACESSO_DE_TESTE);
  assert.match(e.message, /Exploração/);
  assert.equal(e.retriable, false);
});

test('erro de autenticação pede reconexão e NÃO é repetido', () => {
  const e = classificarErroGoogle(401, erroGoogle('authenticationError', 'NOT_ADS_USER', 'UNAUTHENTICATED'));
  assert.equal(e.codigo, ERROS.TOKEN_EXPIRED);
  assert.equal(e.retriable, false, 'repetir com token inválido só queima cota');
});

test('erro de permissão é separado de erro de autenticação', () => {
  const e = classificarErroGoogle(403, erroGoogle('authorizationError', 'USER_PERMISSION_DENIED', 'PERMISSION_DENIED'));
  assert.equal(e.codigo, ERROS.PERMISSION_DENIED);
});

test('cota estourada é o caso que vale repetir', () => {
  const e = classificarErroGoogle(429, erroGoogle('quotaError', 'RESOURCE_EXHAUSTED', 'RESOURCE_EXHAUSTED'));
  assert.equal(e.codigo, ERROS.RATE_LIMIT);
  assert.equal(e.retriable, true);
});

test('query inválida é bug nosso: código próprio e nunca repetida', () => {
  const e = classificarErroGoogle(400, erroGoogle('queryError', 'BAD_FIELD_NAME', 'INVALID_ARGUMENT'));
  assert.equal(e.codigo, ERROS.QUERY_INVALIDA);
  assert.equal(e.retriable, false, 'a mesma query errada vai falhar igual nas próximas tentativas');
});

test('conta inexistente tem código próprio', () => {
  const e = classificarErroGoogle(404, erroGoogle('requestError', 'CUSTOMER_NOT_FOUND', 'NOT_FOUND'));
  assert.equal(e.codigo, ERROS.ACCOUNT_NOT_FOUND);
});

test('5xx do Google é transitório e vale repetir', () => {
  const e = classificarErroGoogle(503, { error: { status: 'UNAVAILABLE' } });
  assert.equal(e.retriable, true);
});

test('erro sem corpo reconhecível ainda vira erro classificado, nunca explode', () => {
  const e = classificarErroGoogle(418, {});
  assert.ok(e instanceof GoogleAdsApiError);
  assert.equal(e.codigo, ERROS.API_ERROR);
});

test('a frase do Google é preservada além do código estável', () => {
  // O código serve para a tela decidir o que dizer; o detalhe é o que diz QUAL campo foi recusado.
  // Sem ele, um erro de consulta só é depurável por quem tem o log do servidor.
  const e = classificarErroGoogle(400, {
    error: {
      status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.',
      details: [{ errors: [{ errorCode: { queryError: 'BAD_FIELD_NAME' }, message: "Error in 'metrics.foo'." }] }],
    },
  });
  assert.equal(e.codigo, ERROS.QUERY_INVALIDA);
  assert.match(e.detalhe, /metrics\.foo/);
});

test('erro sem frase nenhuma ainda devolve alguma pista', () => {
  // "Sem detalhe" é pior que um JSON truncado: deixa o defeito indepurável.
  assert.match(classificarErroGoogle(400, { algo: 'inesperado' }).detalhe, /inesperado/);
  assert.match(classificarErroGoogle(400, {}).detalhe, /HTTP 400/);
});

// ── Token nunca vaza ────────────────────────────────────────────────────────────────────────

test('mascara token em qualquer string que vire log ou erro', () => {
  assert.equal(mascararToken('Authorization: Bearer ya29.segredo'), 'Authorization: Bearer ***');
  assert.match(mascararToken('"developer-token": "abc123"'), /\*\*\*/);
  assert.match(mascararToken('access_token=ya29.x&outro=1'), /access_token=\*\*\*/);
  assert.match(mascararToken('"refresh_token": "1//0gabc-def"'), /\*\*\*/);
});

test('token vai no header, nunca na URL', async () => {
  const { cliente, chamadas } = clienteFalso([resposta(200, { results: [] })]);
  await cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.ok(!chamadas[0].url.includes('ya29'), 'nem um log de URL acidental pode expor o token');
  assert.equal(chamadas[0].init.headers.Authorization, 'Bearer ya29.token-secreto');
});

test('developer token só é enviado quando existe', async () => {
  const semToken = clienteFalso([resposta(200, { results: [] })]);
  await semToken.cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.equal('developer-token' in semToken.chamadas[0].init.headers, false,
    'foi descontinuado em 09/2026 — mandar vazio seria pior que não mandar');

  const comToken = clienteFalso([resposta(200, { results: [] })], { developerToken: 'dev-123' });
  await comToken.cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.equal(comToken.chamadas[0].init.headers['developer-token'], 'dev-123');
});

test('login-customer-id só aparece quando há conta de administrador', async () => {
  const sem = clienteFalso([resposta(200, { results: [] })]);
  await sem.cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.equal('login-customer-id' in sem.chamadas[0].init.headers, false);

  const com = clienteFalso([resposta(200, { results: [] })], { loginCustomerId: '999-888-7777' });
  await com.cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.equal(com.chamadas[0].init.headers['login-customer-id'], '9998887777', 'sem hífen');
});

// ── Paginação ───────────────────────────────────────────────────────────────────────────────

test('percorre todas as páginas, não só a primeira', async () => {
  const { cliente, chamadas } = clienteFalso([
    resposta(200, { results: [{ a: 1 }, { a: 2 }], nextPageToken: 'p2' }),
    resposta(200, { results: [{ a: 3 }], nextPageToken: null }),
  ]);
  const linhas = await cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.equal(linhas.length, 3, 'uma resposta nunca traz o relatório inteiro');
  assert.equal(JSON.parse(chamadas[1].init.body).pageToken, 'p2');
});

test('nunca envia pageSize — o Google recusa o parâmetro', async () => {
  // A API passou a usar página de tamanho fixo. Mandar pageSize derruba a consulta inteira com
  // "Setting the page size is not supported", e o sync não grava nada.
  const { cliente, chamadas } = clienteFalso([resposta(200, { results: [] })]);
  await cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  const corpo = JSON.parse(chamadas[0].init.body);
  assert.equal('pageSize' in corpo, false);
  assert.equal(corpo.query, 'SELECT campaign.id FROM campaign');
});

test('para quando não há mais token de página', async () => {
  const { cliente, chamadas } = clienteFalso([resposta(200, { results: [{ a: 1 }] })]);
  await cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.equal(chamadas.length, 1);
});

test('aborta se a paginação passar do teto, em vez de rodar sem fim', async () => {
  // Um nextPageToken que nunca muda prenderia o sync para sempre.
  const infinitas = new Proxy([], {
    get: (alvo, prop) => (prop === 'shift' ? () => resposta(200, { results: [{ a: 1 }], nextPageToken: 'sempre' }) : alvo[prop]),
  });
  const { cliente } = clienteFalso(infinitas);
  await assert.rejects(
    () => cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign', { maxPaginas: 3 }),
    /passou de 3 páginas/
  );
});

// ── Retry ───────────────────────────────────────────────────────────────────────────────────

test('repete erro transitório e aproveita a resposta boa', async () => {
  const { cliente, chamadas } = clienteFalso([
    resposta(503, { error: { status: 'UNAVAILABLE' } }),
    resposta(200, { results: [{ a: 1 }] }),
  ]);
  const linhas = await cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.equal(linhas.length, 1);
  assert.equal(chamadas.length, 2);
});

test('não repete erro definitivo', async () => {
  const { cliente, chamadas } = clienteFalso([
    resposta(401, erroGoogle('authenticationError', 'NOT_ADS_USER', 'UNAUTHENTICATED')),
  ]);
  await assert.rejects(() => cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign'));
  assert.equal(chamadas.length, 1, 'insistir com token inválido só queima cota');
});

test('respeita o teto de tentativas em erro que se repete', async () => {
  const sempre500 = new Proxy([], {
    get: (alvo, prop) => (prop === 'shift' ? () => resposta(503, {}) : alvo[prop]),
  });
  const { cliente, chamadas } = clienteFalso(sempre500, { maxTentativas: 3 });
  await assert.rejects(() => cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign'));
  assert.equal(chamadas.length, 3, 'nunca pode virar loop infinito de retry');
});

test('falha de rede é tratada como transitória', async () => {
  const { cliente, chamadas } = clienteFalso([
    new Error('ECONNRESET'),
    resposta(200, { results: [] }),
  ]);
  await cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.equal(chamadas.length, 2);
});

// ── Customer id ─────────────────────────────────────────────────────────────────────────────

test('recusa customer id fora do formato antes de gastar chamada', async () => {
  const { cliente, chamadas } = clienteFalso([]);
  await assert.rejects(() => cliente.coletar('123', 'SELECT campaign.id FROM campaign'), /10 dígitos/);
  assert.equal(chamadas.length, 0, 'nem chega a chamar a API');
});

test('aceita customer id com hífen e envia sem', async () => {
  const { cliente, chamadas } = clienteFalso([resposta(200, { results: [] })]);
  await cliente.coletar('123-456-7890', 'SELECT campaign.id FROM campaign');
  assert.match(chamadas[0].url, /customers\/1234567890\/googleAds:search/);
});

test('soDigitos limpa qualquer formatação', () => {
  assert.equal(soDigitos('123-456-7890'), '1234567890');
  assert.equal(soDigitos(null), '');
});

// ── Contas acessíveis ───────────────────────────────────────────────────────────────────────

test('lista contas acessíveis já sem o prefixo de resource name', async () => {
  const { cliente } = clienteFalso([
    resposta(200, { resourceNames: ['customers/1234567890', 'customers/9998887777'] }),
  ]);
  assert.deepEqual(await cliente.contasAcessiveis(), ['1234567890', '9998887777']);
});

test('descarta resource name malformado em vez de propagar id inválido', async () => {
  const { cliente } = clienteFalso([
    resposta(200, { resourceNames: ['customers/123', 'lixo', 'customers/1234567890'] }),
  ]);
  assert.deepEqual(await cliente.contasAcessiveis(), ['1234567890']);
});

test('a versão da API fica num lugar só e é configurável', async () => {
  const { cliente, chamadas } = clienteFalso([resposta(200, { results: [] })], { versao: 'v26' });
  await cliente.coletar(CUSTOMER, 'SELECT campaign.id FROM campaign');
  assert.match(chamadas[0].url, /googleads\.googleapis\.com\/v26\//,
    'versão desativada devolve 404 em tudo — trocar em um lugar precisa valer para todas as chamadas');
});
