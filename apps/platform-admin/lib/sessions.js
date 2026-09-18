'use strict';

// Sessão do PLATFORM ADMIN — separada, em tudo, da sessão do painel.
//
//   tabela   platform_admin_sessions   (o painel usa `sessions`)
//   cookie   __Host-oria_platform_admin / oria_platform_admin   (o painel usa oria_session)
//   segredo  PLATFORM_ADMIN_SESSION_SECRET                       (o painel usa ADMIN_SESSION_SECRET)
//
// Um token de sessão de tenant apresentado aqui não encontra linha nenhuma: os dois espaços de id
// são disjuntos porque as tabelas são outras. Isso é testado (`auth · sessão de tenant não vale`).
//
// O cookie carrega um token opaco de 256 bits. No banco fica só o SHA-256 dele: quem lê a tabela
// não ganha sessão viva. Toda request consulta o banco — revogar vale na request seguinte.
//
// CSRF: HMAC(chave derivada do segredo, id da sessão). Vinculado à sessão, não precisa ser
// armazenado, e o de uma sessão não serve em outra.

const crypto = require('crypto');

const TTL_PADRAO_MS = 8 * 60 * 60 * 1000;
const INTERVALO_TOQUE_MS = 5 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CSRF_HEADER = 'x-csrf-token';
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

class SessaoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessaoError';
  }
}

const idDoToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function derivarChaveCsrf(segredo) {
  if (typeof segredo !== 'string' || segredo.length < 32) {
    throw new SessaoError('segredo de sessão ausente ou curto (mínimo 32 caracteres)');
  }
  return Buffer.from(crypto.hkdfSync('sha256', segredo, '', 'oria-platform-csrf-v1', 32));
}

// Cookie HOST-ONLY do control plane (ajuste de domínios §3, §4).
//
// `admin.oria.com.br` e `app.oria.com.br` NÃO compartilham sessão. O mecanismo que garante isso é
// a AUSÊNCIA do atributo `Domain`: sem ele o cookie é host-only, e o browser nunca o envia para
// outro host — nem para `oria.com.br`, nem para o painel.
//
// O prefixo `__Host-` é a trava: o browser só aceita um cookie com esse prefixo se ele vier com
// Secure, Path=/ e SEM Domain. Ou seja, em produção o próprio nome recusa a configuração errada.
// Fora de HTTPS o prefixo não pode ser usado, então o nome de desenvolvimento é o mesmo sem ele.
function nomeDoCookie(producao) {
  return producao ? '__Host-oria_platform_session' : 'oria_platform_session';
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
    // Nada de `Domain=...` aqui. Ver o comentário de nomeDoCookie: o atributo Domain é
    // exatamente o que tornaria a sessão do Admin visível para o painel.
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

function createSessionStore({ pool, segredo, ttlMs = TTL_PADRAO_MS, agora = () => Date.now() }) {
  if (!pool) throw new SessaoError('store de sessão exige Postgres');
  const chaveCsrf = derivarChaveCsrf(segredo);

  function csrfDe(sessaoId) {
    return crypto.createHmac('sha256', chaveCsrf).update(sessaoId).digest('base64url');
  }

  function csrfConfere(sessaoId, recebido) {
    if (typeof recebido !== 'string' || !recebido) return false;
    const a = Buffer.from(csrfDe(sessaoId));
    const b = Buffer.from(recebido);
    // Comprimento diferente já vaza "não é", mas timingSafeEqual exige buffers iguais; comparar
    // hashes de comprimento fixo evita o vazamento real (o conteúdo).
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Sempre um token NOVO, gerado aqui. Nenhum valor vindo do cliente vira id de sessão — é a
  // proteção a fixation, junto com a revogação das sessões anteriores no login.
  async function criar({ adminId }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = idDoToken(token);
    const expiraEm = new Date(agora() + ttlMs);
    await pool.query(
      'INSERT INTO platform_admin_sessions (id, admin_id, expira_em) VALUES ($1, $2, $3)',
      [id, adminId, expiraEm]
    );
    return { token, id, expiraEm, csrfToken: csrfDe(id) };
  }

  // Sessão válida = existe, não revogada, não expirada, e o admin está ativo.
  async function buscar(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const id = idDoToken(token);
    const { rows } = await pool.query(
      `SELECT s.id, s.admin_id, s.expira_em, s.ultimo_uso_em, a.email, a.nome, a.papel
         FROM platform_admin_sessions s
         JOIN platform_admins a ON a.id = s.admin_id
        WHERE s.id = $1
          AND s.revogada_em IS NULL
          AND s.expira_em > now()
          AND a.status = 'active'`,
      [id]
    );
    const s = rows[0];
    if (!s) return null;
    if (agora() - new Date(s.ultimo_uso_em).getTime() > INTERVALO_TOQUE_MS) {
      await pool.query('UPDATE platform_admin_sessions SET ultimo_uso_em = now() WHERE id = $1', [id]);
    }
    return {
      sessaoId: s.id,
      adminId: s.admin_id,
      email: s.email,
      nome: s.nome,
      papel: s.papel,
      expiraEm: s.expira_em,
      csrfToken: csrfDe(s.id),
    };
  }

  async function revogar(sessaoId, { por = null, motivo }) {
    const { rowCount } = await pool.query(
      `UPDATE platform_admin_sessions SET revogada_em = now(), revogada_por = $2, motivo_revogacao = $3
        WHERE id = $1 AND revogada_em IS NULL`,
      [sessaoId, por, motivo]
    );
    return rowCount;
  }

  async function revogarPorToken(token, opcoes) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return 0;
    return revogar(idDoToken(token), opcoes);
  }

  async function revogarDoAdmin(adminId, { por = null, motivo, exceto = null }) {
    const { rowCount } = await pool.query(
      `UPDATE platform_admin_sessions SET revogada_em = now(), revogada_por = $2, motivo_revogacao = $3
        WHERE admin_id = $1 AND revogada_em IS NULL AND ($4::text IS NULL OR id <> $4)`,
      [adminId, por, motivo, exceto]
    );
    return rowCount;
  }

  return { criar, buscar, revogar, revogarPorToken, revogarDoAdmin, csrfDe, csrfConfere };
}

module.exports = {
  TTL_PADRAO_MS,
  TOKEN_RE,
  CSRF_HEADER,
  METODOS_SEGUROS,
  SessaoError,
  idDoToken,
  derivarChaveCsrf,
  nomeDoCookie,
  lerCookies,
  cookieDeSessao,
  cookieApagado,
  tokenDoRequest,
  createSessionStore,
};
