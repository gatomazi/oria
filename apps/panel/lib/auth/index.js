'use strict';

// Montagem da autenticação individual (Fase 2) e a configuração que ela exige.
//
// Fail-closed: em produção, segredo de sessão ausente ou curto é erro de BOOT (o chamador sai com
// exit ≠ 0). Login legado por ADMIN_PASSWORD só existe com ALLOW_LEGACY_ADMIN_PASSWORD=1 e com o
// usuário que ele representa declarado em LEGACY_ADMIN_USER_EMAIL — nunca "o primeiro owner".

const { createSessionStore } = require('./sessions');
const { createAuthMiddleware } = require('./middleware');
const { createLoginLimiter } = require('./rate-limit');
const { createAuthRouter } = require('./router');

class AuthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

function resolverConfigAuth(env = process.env) {
  const producao = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const segredo = env.ADMIN_SESSION_SECRET || '';
  if (segredo.length < 32) {
    if (producao) {
      throw new AuthConfigError('ADMIN_SESSION_SECRET ausente ou com menos de 32 caracteres — obrigatório em produção (sessão e CSRF)');
    }
  }

  const flag = String(env.ALLOW_LEGACY_ADMIN_PASSWORD || '').trim();
  if (flag && flag !== '1' && flag !== '0') {
    throw new AuthConfigError(`ALLOW_LEGACY_ADMIN_PASSWORD inválido: "${flag}" (use 1 ou deixe vazio)`);
  }
  const legado = {
    habilitado: flag === '1',
    senha: env.ADMIN_PASSWORD || '',
    email: String(env.LEGACY_ADMIN_USER_EMAIL || '').trim().toLowerCase(),
  };
  if (legado.habilitado && (!legado.senha || !legado.email)) {
    throw new AuthConfigError(
      'ALLOW_LEGACY_ADMIN_PASSWORD=1 exige ADMIN_PASSWORD e LEGACY_ADMIN_USER_EMAIL (o usuário real que o login legado representa)'
    );
  }
  return { producao, segredo, legado, disponivel: segredo.length >= 32 };
}

function createAuth({
  pool, config, comOrganization, auditar, limiter = createLoginLimiter(), limiterConvite,
}) {
  const sessoes = createSessionStore({ pool, segredo: config.segredo });
  const { requireAuth, carregar } = createAuthMiddleware({ sessoes, producao: config.producao });
  const router = createAuthRouter({
    pool, sessoes, requireAuth, carregarSessao: carregar, limiter,
    producao: config.producao, legado: config.legado, auditar, comOrganization,
    // Balde do aceite de convite (lib/auth/rate-limit.js). Sem valor explícito, o router cria o
    // seu — o parâmetro existe para o teste poder apertar os limites.
    ...(limiterConvite ? { limiterConvite } : {}),
  });
  return { router, requireAuth, carregarSessao: carregar, sessoes };
}

module.exports = { AuthConfigError, resolverConfigAuth, createAuth };
