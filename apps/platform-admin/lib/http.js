'use strict';

// Camada HTTP mínima sobre `node:http`.
//
// Por que não Express: a única coisa que este app precisa de um framework é rota + corpo JSON, e
// as duas cabem aqui em pouco mais de cem linhas — auditáveis, sem middleware de terceiro no
// caminho de uma superfície de plataforma. A dependência que sobra é o `pg`.
//
// O que esta camada IMPÕE, e por isso é o lugar certo para ela:
//
//   · corpo JSON com limite de 64 KB (corpo maior é 413, não OOM);
//   · **campos desconhecidos são rejeitados** — whitelist por rota, nunca "ignora o que não
//     conheço" (um campo ignorado em silêncio é o vetor de "mando organization_id e vejo no que dá");
//   · envelope de erro único, sem stack, sem SQL, sem nome de tabela;
//   · `organization_id` no corpo é 400 — a autoridade é o :organizationId da ROTA.

const { STATUS_CODES } = require('http');

const LIMITE_CORPO_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Nomes que NUNCA podem chegar pelo corpo: o alvo vem da rota. Rejeitar é melhor do que ignorar,
// porque torna o erro de integração visível em vez de silencioso.
const CAMPOS_DE_AUTORIDADE = Object.freeze(['organization_id', 'organizationId', 'organization', 'org_id', 'orgId']);

class HttpError extends Error {
  constructor(status, erro, mensagem, detalhes = null) {
    super(mensagem || erro);
    this.name = 'HttpError';
    this.status = status;
    this.erro = erro;
    this.detalhes = detalhes;
  }
}

const erro400 = (codigo, msg, det) => new HttpError(400, codigo, msg, det);
const erro404 = () => new HttpError(404, 'nao_encontrado', 'não encontrado');
const erro409 = (codigo, msg, det) => new HttpError(409, codigo, msg, det);
const erro422 = (codigo, msg, det) => new HttpError(422, codigo, msg, det);

function responderJson(res, status, corpo, cabecalhos = {}) {
  const texto = corpo === undefined ? '' : JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    // Resposta de API nunca entra em cache compartilhado.
    'Cache-Control': 'no-store',
    ...cabecalhos,
  });
  res.end(texto);
}

function responderErro(res, err) {
  if (err instanceof HttpError) {
    const corpo = { erro: err.erro, mensagem: err.message };
    if (err.detalhes) corpo.detalhes = err.detalhes;
    return responderJson(res, err.status, corpo, err.cabecalhos || {});
  }
  // Defeito do servidor: o cliente recebe o mínimo; o operador recebe o log.
  console.error(`[HTTP] falha não tratada: ${err && err.stack ? err.stack : err}`);
  return responderJson(res, 500, { erro: 'erro_interno', mensagem: 'falha ao processar a requisição' });
}

// Lê o corpo com teto. Acima do teto, derruba a leitura em vez de acumular.
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    req.on('data', (p) => {
      total += p.length;
      if (total > LIMITE_CORPO_BYTES) {
        reject(new HttpError(413, 'corpo_grande', `corpo maior que ${LIMITE_CORPO_BYTES} bytes`));
        req.destroy();
        return;
      }
      pedacos.push(p);
    });
    req.on('end', () => resolve(Buffer.concat(pedacos)));
    req.on('error', reject);
  });
}

async function lerJson(req) {
  const bruto = await lerCorpo(req);
  if (!bruto.length) return {};
  const tipo = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(tipo)) {
    throw erro400('content_type_invalido', 'use Content-Type: application/json');
  }
  let corpo;
  try {
    corpo = JSON.parse(bruto.toString('utf8'));
  } catch {
    throw erro400('json_invalido', 'corpo não é JSON válido');
  }
  if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo)) {
    throw erro400('json_invalido', 'corpo precisa ser um objeto JSON');
  }
  return corpo;
}

// Whitelist estrita. `campos` é o conjunto permitido; qualquer outro nome é 400.
function exigirCampos(corpo, campos) {
  const permitidos = new Set(campos);
  const recebidos = Object.keys(corpo);
  const autoridade = recebidos.filter((k) => CAMPOS_DE_AUTORIDADE.includes(k) && !permitidos.has(k));
  if (autoridade.length) {
    throw erro400(
      'organization_no_corpo',
      'a Organization alvo vem da rota, nunca do corpo',
      { campos: autoridade }
    );
  }
  const desconhecidos = recebidos.filter((k) => !permitidos.has(k));
  if (desconhecidos.length) {
    throw erro400('campo_desconhecido', 'campos não reconhecidos no corpo', { campos: desconhecidos });
  }
  return corpo;
}

// ── Validadores de valor ─────────────────────────────────────────────────────────────────────

function texto(valor, campo, { minimo = 1, maximo = 200, obrigatorio = true } = {}) {
  if (valor === undefined || valor === null) {
    if (obrigatorio) throw erro400(`${campo}_invalido`, `${campo} é obrigatório`);
    return null;
  }
  if (typeof valor !== 'string') throw erro400(`${campo}_invalido`, `${campo} precisa ser texto`);
  const v = valor.trim();
  if (v.length < minimo || v.length > maximo) {
    throw erro400(`${campo}_invalido`, `${campo} precisa ter entre ${minimo} e ${maximo} caracteres`);
  }
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function email(valor, campo = 'email') {
  const v = texto(valor, campo, { minimo: 3, maximo: 320 }).toLowerCase();
  if (!EMAIL_RE.test(v)) throw erro400('email_invalido', 'e-mail inválido');
  return v;
}

function uuid(valor, campo) {
  if (typeof valor !== 'string' || !UUID_RE.test(valor)) {
    // Id malformado é "não encontrado", não 500 nem 400 — não confirma nem nega existência.
    throw erro404();
  }
  return valor.toLowerCase();
}

function booleano(valor, campo, { padrao = undefined } = {}) {
  if (valor === undefined || valor === null) {
    if (padrao === undefined) throw erro400(`${campo}_invalido`, `${campo} é obrigatório`);
    return padrao;
  }
  if (typeof valor !== 'boolean') throw erro400(`${campo}_invalido`, `${campo} precisa ser booleano`);
  return valor;
}

function inteiro(valor, campo, { padrao, minimo, maximo }) {
  if (valor === undefined || valor === null || valor === '') return padrao;
  const n = typeof valor === 'number' ? valor : Number(String(valor).trim());
  if (!Number.isInteger(n) || n < minimo || n > maximo) {
    throw erro400(`${campo}_invalido`, `${campo} precisa ser inteiro entre ${minimo} e ${maximo}`);
  }
  return n;
}

function umDe(valor, campo, opcoes, { padrao = undefined } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (padrao === undefined) throw erro400(`${campo}_invalido`, `${campo} é obrigatório`);
    return padrao;
  }
  if (!opcoes.includes(valor)) {
    throw erro422(`${campo}_invalido`, `${campo} precisa ser um de: ${opcoes.join(', ')}`);
  }
  return valor;
}

// ── Paginação por cursor ─────────────────────────────────────────────────────────────────────
// Opaco de propósito: o cliente não constrói cursor, só devolve o que recebeu.

const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 200;

function lerLimite(query) {
  return inteiro(query.get('limit'), 'limit', { padrao: LIMITE_PADRAO, minimo: 1, maximo: LIMITE_MAXIMO });
}

function codificarCursor(valor) {
  return Buffer.from(JSON.stringify(valor), 'utf8').toString('base64url');
}

function decodificarCursor(bruto) {
  if (bruto === null || bruto === undefined || bruto === '') return null;
  try {
    const v = JSON.parse(Buffer.from(String(bruto), 'base64url').toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('forma');
    return v;
  } catch {
    throw erro400('cursor_invalido', 'cursor inválido');
  }
}

// ── Router ───────────────────────────────────────────────────────────────────────────────────
// Padrões com `:param`. Sem regex vinda de fora, sem catch-all ambíguo.

function criarRouter() {
  const rotas = [];

  function registrar(metodo, padrao, handler, opcoes = {}) {
    const partes = padrao.split('/').filter(Boolean);
    rotas.push({ metodo, partes, handler, publico: !!opcoes.publico });
  }

  function casar(metodo, caminho) {
    const partes = caminho.split('/').filter(Boolean);
    for (const r of rotas) {
      if (r.metodo !== metodo || r.partes.length !== partes.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.partes.length; i += 1) {
        const p = r.partes[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(partes[i]);
        else if (p !== partes[i]) { ok = false; break; }
      }
      if (ok) return { rota: r, params };
    }
    return null;
  }

  // Existe a rota em outro método? Então é 405, não 404 — ajuda a depurar integração sem vazar nada.
  function existeOutroMetodo(caminho) {
    const partes = caminho.split('/').filter(Boolean);
    return rotas.some((r) => r.partes.length === partes.length
      && r.partes.every((p, i) => p.startsWith(':') || p === partes[i]));
  }

  return {
    get: (p, h, o) => registrar('GET', p, h, o),
    post: (p, h, o) => registrar('POST', p, h, o),
    put: (p, h, o) => registrar('PUT', p, h, o),
    patch: (p, h, o) => registrar('PATCH', p, h, o),
    delete: (p, h, o) => registrar('DELETE', p, h, o),
    casar,
    existeOutroMetodo,
    rotas,
  };
}

module.exports = {
  LIMITE_CORPO_BYTES,
  LIMITE_PADRAO,
  LIMITE_MAXIMO,
  CAMPOS_DE_AUTORIDADE,
  UUID_RE,
  HttpError,
  erro400,
  erro404,
  erro409,
  erro422,
  responderJson,
  responderErro,
  lerCorpo,
  lerJson,
  exigirCampos,
  texto,
  email,
  uuid,
  booleano,
  inteiro,
  umDe,
  lerLimite,
  codificarCursor,
  decodificarCursor,
  criarRouter,
  STATUS_CODES,
};
