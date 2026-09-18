'use strict';

// Configuração do control plane, com fail-fast de produção (§25 do comando da rodada).
//
// Em produção o processo NÃO sobe sem banco, sem `PLATFORM_ADMIN_SESSION_SECRET` de 32+ caracteres
// ou com `SECOND_TENANT_ENABLED` num valor que não seja 0/1. Valor inválido não vira "desligado por
// engano" nem "ligado por engano": vira erro de configuração.
//
// O que o boot NÃO exige: que já exista um platform admin. Sem nenhum, o app sobe, /health responde
// e o login devolve 503 `bootstrap_pendente`. Não existe senha padrão, e o boot não cria admin.

const crypto = require('crypto');
const { resolverUrlCanonica, UrlInvalidaError } = require('./urls');

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TAMANHO_MINIMO_SEGREDO = 32;

function lerFlag(nome, valor) {
  const v = String(valor ?? '').trim().toLowerCase();
  if (v === '' || v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return true;
  throw new ConfigError(`${nome} inválido: use 1, 0 ou deixe vazio (recebido: ${JSON.stringify(valor)})`);
}

function lerInteiro(nome, valor, { padrao, minimo, maximo }) {
  const bruto = String(valor ?? '').trim();
  if (bruto === '') return padrao;
  const n = Number(bruto);
  if (!Number.isInteger(n) || n < minimo || n > maximo) {
    throw new ConfigError(`${nome} inválido: inteiro entre ${minimo} e ${maximo}`);
  }
  return n;
}

function resolverConfig(env = process.env, { avisar = (m) => console.warn(m) } = {}) {
  const producao = String(env.NODE_ENV || '').trim() === 'production';

  const databaseUrl = String(env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new ConfigError('DATABASE_URL ausente — o control plane não sobe sem o Postgres do painel');
  }

  let segredo = String(env.PLATFORM_ADMIN_SESSION_SECRET || '').trim();
  if (segredo.length && segredo.length < TAMANHO_MINIMO_SEGREDO) {
    // Curto é sempre erro, inclusive fora de produção: um segredo curto que "funciona" localmente é
    // exatamente o que acaba copiado para o deploy.
    throw new ConfigError(`PLATFORM_ADMIN_SESSION_SECRET curto demais (mínimo ${TAMANHO_MINIMO_SEGREDO} caracteres)`);
  }
  if (!segredo) {
    if (producao) {
      throw new ConfigError('PLATFORM_ADMIN_SESSION_SECRET ausente — obrigatório em produção');
    }
    segredo = crypto.randomBytes(32).toString('base64url');
    avisar('[CONFIG] PLATFORM_ADMIN_SESSION_SECRET ausente: usando segredo efêmero de desenvolvimento (as sessões morrem no restart)');
  }

  const criacaoExternaHabilitada = lerFlag('SECOND_TENANT_ENABLED', env.SECOND_TENANT_ENABLED);

  // Hosts canônicos (ajuste de domínios §6, §7, §12, §34).
  //
  //   PLATFORM_ADMIN_URL  é a identidade DESTE app: todo link que ele gera sai daqui, e toda
  //                       mutação precisa vir desta origem. Crítica em produção → fail-fast.
  //   APP_URL             host do Tenant Plane. Entra SÓ para ser negado como origem e para o
  //                       Admin conseguir mostrar/abrir o painel. Nunca vira sessão nem
  //                       autorização do control plane.
  //   PUBLIC_SITE_URL     landing. Mesma coisa: nunca ganha poder administrativo.
  let urls;
  try {
    urls = {
      platformAdmin: resolverUrlCanonica('PLATFORM_ADMIN_URL', env.PLATFORM_ADMIN_URL,
        { producao, obrigatoria: producao }),
      app: resolverUrlCanonica('APP_URL', env.APP_URL, { producao }),
      publicSite: resolverUrlCanonica('PUBLIC_SITE_URL', env.PUBLIC_SITE_URL, { producao }),
    };
  } catch (err) {
    if (err instanceof UrlInvalidaError) throw new ConfigError(err.message);
    throw err;
  }
  if (!urls.platformAdmin) {
    avisar('[CONFIG] PLATFORM_ADMIN_URL ausente: fora de produção o Admin não valida origem de mutação nem monta link absoluto');
  }

  return Object.freeze({
    producao,
    databaseUrl,
    segredoSessao: segredo,
    porta: lerInteiro('PORT', env.PORT, { padrao: 8080, minimo: 1, maximo: 65535 }),
    ttlSessaoMs: lerInteiro('PLATFORM_ADMIN_SESSION_TTL_HOURS', env.PLATFORM_ADMIN_SESSION_TTL_HOURS,
      { padrao: 8, minimo: 1, maximo: 24 }) * 60 * 60 * 1000,
    criacaoExternaHabilitada,
    urls: Object.freeze(urls),
    // Retrato dos requisitos de onboarding (mesma variável e mesmo formato do painel). Sem ela e
    // sem `passos` no request, a criação é recusada: não existe plano padrão de onboarding.
    passosOnboarding: String(env.ONBOARDING_STEP_REQUIREMENTS || '').trim() || null,
    diretorioEstatico: String(env.PLATFORM_ADMIN_STATIC_DIR || '').trim() || null,
  });
}

module.exports = { ConfigError, TAMANHO_MINIMO_SEGREDO, lerFlag, resolverConfig };
