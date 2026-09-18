'use strict';

// Oria Admin — control plane. Service `oria-admin`, Root Directory `/apps/platform-admin`.
//
// Boot fail-fast (§25): sem banco, sem `PLATFORM_ADMIN_SESSION_SECRET` válido ou com
// `SECOND_TENANT_ENABLED` inválido, o processo NÃO sobe. O que ele NÃO exige é que já exista um
// platform admin: sem nenhum, o app sobe, /health responde e o login devolve `bootstrap_pendente`.

const http = require('http');
const { resolverConfig, ConfigError } = require('./lib/config');
const { criarPool, verificarBanco } = require('./lib/db');
const { createSessionStore } = require('./lib/sessions');
const { createLoginLimiter } = require('./lib/rate-limit');
const { criarServicoDeAdmins } = require('./lib/admins');
const { criarServicoDePlanos } = require('./lib/plans');
const { criarServicoDeOrganizations } = require('./lib/organizations');
const { criarReadModels } = require('./lib/readmodels');
const { criarApp } = require('./lib/app');

// Monta tudo a partir de um pool já aberto. Separado de `main` para que o teste suba o app inteiro
// sem processo filho e sem porta fixa.
function montar({ config, pool }) {
  const sessoes = createSessionStore({ pool, segredo: config.segredoSessao, ttlMs: config.ttlSessaoMs });
  const limiter = createLoginLimiter();
  const readModels = criarReadModels(pool);
  const admins = criarServicoDeAdmins({ pool, sessoes, limiter });
  const planos = criarServicoDePlanos({ pool });
  const organizations = criarServicoDeOrganizations({ pool, config, planos, readModels });
  return {
    sessoes, limiter, readModels, admins, planos, organizations,
    handler: criarApp({ config, pool, sessoes, admins, planos, organizations, readModels }),
  };
}

async function main() {
  let config;
  try {
    config = resolverConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[BOOT] configuração inválida: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const pool = criarPool(config.databaseUrl);
  try {
    await verificarBanco(pool);
  } catch (err) {
    // Banco ausente ou sem as migrations: o processo morre aqui, antes de anunciar a porta. Um
    // service que aceita requisições com o schema errado é pior do que um service que não sobe.
    console.error(`[BOOT] Postgres indisponível ou desatualizado: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  const { handler, admins } = montar({ config, pool });

  if (!(await admins.existeAlgum())) {
    console.warn('[BOOT] nenhum platform admin cadastrado — o login fica indisponível até rodar `npm run platform-admin:bootstrap`');
  }

  const servidor = http.createServer(handler);
  servidor.listen(config.porta, () => {
    console.log(`[BOOT] Oria Admin ouvindo na porta ${config.porta} (produção=${config.producao})`);
  });

  const encerrar = (sinal) => {
    console.log(`[BOOT] ${sinal}: encerrando`);
    servidor.close(() => pool.end().then(() => process.exit(0), () => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('SIGINT', () => encerrar('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[BOOT] falha: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { montar, main };
