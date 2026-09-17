'use strict';

// Autenticação por request (Fase 2).
//
// `requireAuth` substitui o antigo `requireAdmin`: cookie → sessão persistida → `req.auth` com a
// IDENTIDADE (sessão e usuário) e a Organization ativa JÁ GRAVADA na sessão. Resolver e validar
// essa Organization é do pipeline de tenant (lib/platform/tenant-pipeline.js). Nenhum valor do
// cliente (header, query, body) entra em `req.auth`.
//
// CSRF: toda escrita autenticada por cookie (POST/PUT/PATCH/DELETE) exige o header X-CSRF-Token
// igual ao HMAC da sessão. SameSite=Strict continua, como segunda camada — não como a única.

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER = 'x-csrf-token';

function nomeDoCookie(producao) {
  // `__Host-` obriga Secure, Path=/ e ausência de Domain — só dá para usar sob HTTPS.
  return producao ? '__Host-oria_session' : 'oria_session';
}

function lerCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const par of header.split(';')) {
    const i = par.indexOf('=');
    if (i === -1) continue;
    const nome = par.slice(0, i).trim();
    if (!nome || Object.prototype.hasOwnProperty.call(cookies, nome)) continue; // primeiro vence
    try {
      cookies[nome] = decodeURIComponent(par.slice(i + 1).trim());
    } catch {
      cookies[nome] = '';
    }
  }
  return cookies;
}

function cookieDeSessao({ producao, token, expiraEm }) {
  const maxAge = Math.max(0, Math.floor((new Date(expiraEm).getTime() - Date.now()) / 1000));
  return [
    `${nomeDoCookie(producao)}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
    ...(producao ? ['Secure'] : []),
  ].join('; ');
}

function cookieApagado({ producao }) {
  return [
    `${nomeDoCookie(producao)}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
    ...(producao ? ['Secure'] : []),
  ].join('; ');
}

function tokenDoRequest(req, producao) {
  return lerCookies(req)[nomeDoCookie(producao)] || null;
}

function createAuthMiddleware({ sessoes, producao }) {
  async function carregar(req) {
    const token = tokenDoRequest(req, producao);
    if (!token) return null;
    return sessoes.buscar(token);
  }

  async function requireAuth(req, res, next) {
    let auth;
    try {
      auth = await carregar(req);
    } catch (err) {
      // Store fora do ar: fail-closed, nunca "deixa passar".
      console.error(`[AUTH] falha ao validar sessão: ${err.message}`);
      return res.status(503).json({ error: 'autenticação indisponível' });
    }
    if (!auth) return res.status(401).json({ error: 'não autenticado' });

    if (!METODOS_SEGUROS.has(req.method)) {
      if (!sessoes.csrfConfere(auth.sessaoId, req.get(CSRF_HEADER))) {
        return res.status(403).json({ error: 'token CSRF ausente ou inválido', codigo: 'csrf' });
      }
    }

    req.auth = Object.freeze({
      sessaoId: auth.sessaoId,
      userId: auth.userId,
      email: auth.email,
      nome: auth.nome,
      metodo: auth.metodo,
      // Gravada pelo servidor (seleção de workspace). Nunca vem do request.
      organizacaoAtivaId: auth.organizacaoAtivaId || null,
    });
    next();
  }

  return { requireAuth, carregar };
}

module.exports = {
  CSRF_HEADER,
  METODOS_SEGUROS,
  nomeDoCookie,
  lerCookies,
  cookieDeSessao,
  cookieApagado,
  tokenDoRequest,
  createAuthMiddleware,
};
