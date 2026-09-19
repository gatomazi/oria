'use strict';

// Segurança de handlers assíncronos do Express 4 + mapeamento central de erros.
//
// O defeito que isto fecha (auditoria de dogfooding, 2026-09-19): o Express 4 não olha a promise
// devolvida por um handler `async`. Um `throw` (ou uma promise rejeitada) dentro dele não chega a
// nenhum middleware de erro — vira `unhandledRejection`, a resposta NUNCA é enviada e a tela do
// cliente fica em "Carregando" para sempre. Foi o que aconteceu em 6 endpoints quando
// `lojaLegadaDoContexto()` lançou `STORE_WITHOUT_LEGACY_KEY` para a Store nativa do Oria.
//
// Três peças, todas aqui para o comportamento ter UM dono:
//
//   1. `instalarSegurancaAsync()` — faz TODA rota e middleware, os que existem e os futuros,
//      encaminharem a rejeição para `next(err)`. É o único ponto que sabe da promise do handler.
//   2. `mapearErro()` — traduz erro conhecido em resposta HTTP controlada. Erro desconhecido vira
//      500 genérico: a mensagem e o stack de um erro que ninguém previu não são resposta.
//   3. `criarErroCentral()` — o middleware de erro, registrado por último. Loga UMA vez (com stack,
//      só no log do servidor) e responde JSON `{ error, codigo }`, o mesmo formato que o painel lê (`ApiError.codigo`).
//
// `wrapAsync()` é a forma explícita da peça 1, para código que monta handler fora do `app`.

// Erros de contexto de tenant (`TenantRuntimeError.codigo`) que o cliente pode encontrar sem que
// isso seja um defeito do servidor. A mensagem é a que o painel mostra: sem nome de tabela, de
// função interna ou de variável.
const ERROS_CONHECIDOS = Object.freeze({
  // A Store nativa do Oria (`loja_legada = NULL`) chegou num fluxo que ainda depende da chave
  // legada. É um estado, não um crash: 409 diz "o recurso não está disponível para este estado".
  STORE_WITHOUT_LEGACY_KEY: { status: 409, error: 'este recurso ainda não está disponível para a sua loja' },
  STORE_NOT_RESOLVED: { status: 409, error: 'a sua organização ainda não tem uma loja configurada' },
  TENANT_CONTEXT_REQUIRED: { status: 401, error: 'sessão inválida ou expirada' },
});

const ERRO_INTERNO = Object.freeze({ status: 500, error: 'erro interno do servidor', codigo: 'INTERNAL_ERROR' });

function mapearErro(err) {
  const codigo = err && typeof err.codigo === 'string' ? err.codigo : null;
  if (codigo && Object.prototype.hasOwnProperty.call(ERROS_CONHECIDOS, codigo)) {
    const { status, error } = ERROS_CONHECIDOS[codigo];
    return { status, error, codigo };
  }

  // Erro de cliente com `expose` (body-parser: JSON malformado, payload grande demais) é feito
  // para ser mostrado. Qualquer outro `status` de um erro solto NÃO é: a mensagem pode carregar
  // detalhe interno, e o handler que a quisesse mostrar já responde por conta própria.
  const status = Number(err && (err.status || err.statusCode));
  if (err && err.expose === true && Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, error: String(err.message || 'requisição inválida'), codigo: typeof err.type === 'string' ? err.type : 'BAD_REQUEST' };
  }

  return { ...ERRO_INTERNO };
}

function querJson(req) {
  const caminho = String(req.originalUrl || req.url || '');
  return caminho.startsWith('/api/') || req.xhr === true || (typeof req.accepts === 'function' && req.accepts(['html', 'json']) === 'json');
}

// Middleware de erro do Express (4 argumentos — a aridade é o que o identifica). Vai por último.
function criarErroCentral({ logger = console } = {}) {
  return function erroCentral(err, req, res, next) {
    const { status, error, codigo } = mapearErro(err);

    // Log único, no servidor. Só método e caminho (sem query string: pode ter token ou PII) e o
    // stack completo — que nunca sai na resposta.
    const desconhecido = codigo === ERRO_INTERNO.codigo;
    const detalhe = err && err.stack ? err.stack : String(err);
    logger.error(`[HTTP_ERRO] ${req.method} ${req.path} -> ${status} ${codigo}${desconhecido ? `\n${detalhe}` : `: ${err && err.message}`}`);

    // Cabeçalhos já saíram (a resposta começou e o handler falhou depois): não dá para trocar o
    // status. Fecha a resposta em vez de deixá-la aberta.
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(status);
    if (querJson(req)) res.json({ error, codigo });
    else res.type('text/plain').send(error);
  };
}

// Executa um handler e encaminha qualquer falha, síncrona ou assíncrona, para `next(err)`.
function executar(fn, req, res, next) {
  let retorno;
  try {
    retorno = fn(req, res, next);
  } catch (err) {
    next(err);
    return;
  }
  if (retorno && typeof retorno.then === 'function') {
    retorno.then(undefined, (err) => {
      // `Promise.reject()` sem motivo chegaria em `next(undefined)`, que o Express lê como
      // "siga para o próximo handler" — e a requisição ficaria pendurada de novo.
      next(err || new Error('promise rejeitada sem motivo'));
    });
  }
}

// Forma explícita: `app.get('/x', wrapAsync(async (req, res) => { ... }))`.
function wrapAsync(fn) {
  if (typeof fn !== 'function') throw new TypeError('wrapAsync espera uma função');
  // Middleware de erro (4 argumentos) não é decorado: a aridade tem de sobreviver.
  if (fn.length > 3) return fn;
  return function handlerSeguro(req, res, next) {
    executar(fn, req, res, next);
  };
}

const MARCA = Symbol.for('oria.http-safety.instalado');

// Instala a rede no roteador do Express 4: `Layer#handle_request` é por onde passa TODO handler e
// TODO middleware (rotas, `app.use`, `express.Router`), então nenhuma das centenas de rotas
// precisa ser tocada — e as futuras já nascem cobertas. Idempotente.
//
// Devolve `false` quando não há o que instalar (Express 5 já encaminha a rejeição por conta
// própria, e o caminho `express/lib/router/layer` deixa de existir).
function instalarSegurancaAsync(resolver = require) {
  let Layer;
  try {
    Layer = resolver('express/lib/router/layer');
  } catch {
    return false;
  }
  const proto = Layer && Layer.prototype;
  if (!proto || typeof proto.handle_request !== 'function') return false;
  if (proto.handle_request[MARCA]) return true;

  function handleRequestSeguro(req, res, next) {
    const fn = this.handle;
    // Mesma regra do Express: função de 4 argumentos só atende erro, então numa requisição normal
    // ela é ignorada.
    if (fn.length > 3) {
      next();
      return;
    }
    executar(fn, req, res, next);
  }
  handleRequestSeguro[MARCA] = true;
  proto.handle_request = handleRequestSeguro;
  return true;
}

module.exports = { instalarSegurancaAsync, wrapAsync, mapearErro, criarErroCentral, ERROS_CONHECIDOS, ERRO_INTERNO };
