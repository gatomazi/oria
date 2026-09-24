'use strict';

// Fase C · porta de segredos para connectors (lib/connectors). Separada da IntegrationResolver da
// Fase B.1: aquela resolve identidade/Store validada/status/config; esta resolve o PLAINTEXT de um
// segredo que já pertence a uma integração já resolvida e conferida.
//
//   IntegrationResolver → ResolvedIntegration → ConnectorSecretPort → plaintext
//
// Por que é uma porta separada, e não mais um método do connector:
//   · `ResolvedIntegration` não carrega segredo (types.js já documenta isso — ver Fase B.1);
//   · o connector NÃO deve importar `lib/platform/integrations.js`: aquele módulo é o resolver
//     LEGADO, ligado só ao contexto implícito do processo e com fallback por variável de ambiente
//     (`INK_TOKEN_<LOJA>`, `ALLOW_LEGACY_INTEGRATION_ENV`) — importá-lo de volta reintroduziria o
//     acoplamento que a Fase B quebrou, e um connector novo nunca deve herdar aquele fallback;
//   · esta porta reusa a infraestrutura segura de BAIXO NÍVEL (`lib/secrets/store.js`,
//     `lib/secrets/keyring.js`) — a mesma que o resolver legado usa por baixo — sem o fallback: só
//     segredo PERSISTIDO da própria integração.
//
// A única coisa importada do módulo legado é `SEGREDOS`: um mapa de dados (provider → tipo →
// contexto HKDF), não o resolver com fallback. Duplicá-lo aqui criaria duas fontes de verdade sobre
// qual contexto cifra qual segredo — pior para segurança do que reexportar o mesmo dado.
//
// Segurança (mesmo padrão de INV-13 do resolver legado): o plaintext NUNCA é retornado — só
// entregue a um callback de uso imediato — e passa pelo secretGuard antes de chegar lá, a mesma
// rede que os testes de INV-13 usam para provar que nenhum segredo vaza em resposta HTTP ou log.
//
// API: ligada ao par (context, integration) já resolvidos pelo registry (Fase B) e pela
// IntegrationResolver (Fase B.1). O connector escolhe só o NOME do segredo — nunca outro tenant,
// integration ou provider:
//
//   const secrets = secretPort.forIntegration(context, integration)
//   await secrets.use('api_token', (token) => inkClient.request(token, ...))

const { contextoAtual } = require('./tenant-runtime');
const { createSecretStore } = require('../secrets/store');
const { createKeyring } = require('../secrets/keyring');
// Whitelist de (provider → tipo → contexto HKDF) — dado puro; ver comentário do topo.
const { SEGREDOS, IntegracaoError } = require('./integrations');
const secretGuard = require('./secret-guard');
const { ConnectorError, CODIGOS } = require('../connectors/errors');
const { createConnectorContext } = require('../connectors/contracts');

const outroTenant = (mensagem) => new ConnectorError(mensagem, CODIGOS.INTEGRATION_TENANT_MISMATCH);
const CODIGOS_AUSENCIA = new Set(['SECRET_MISSING', 'SECRET_EXPIRED', 'SECRET_UNREADABLE']);

// O connector só escolhe o nome; o contexto HKDF vem do whitelist, nunca de um parâmetro do chamador.
function contextoHkdf(provider, tipo) {
  const porTipo = SEGREDOS[provider];
  if (!porTipo || !Object.hasOwn(porTipo, tipo)) {
    throw new ConnectorError(`segredo desconhecido: ${provider}/${tipo}`, CODIGOS.INTEGRATION_INVALID);
  }
  return porTipo[tipo];
}

/**
 * @param {{pool: {query: Function}, keyring?: Object, contexto?: () => (Object|null)}} opcoes
 *   `pool`: a fachada do tenant-runtime (a mesma exigida pela IntegrationResolver da B.1) — toda
 *   leitura roda em `comOrganization`, sob RLS.
 *   `keyring`: por padrão `createKeyring()` (lê `ENCRYPTION_MASTER_KEY` do ambiente — a chave-mestra
 *   de cifra, infraestrutura obrigatória para QUALQUER leitura, não o fallback de credencial que
 *   este módulo existe para excluir).
 * @returns {{forIntegration: (context: Object, integration: Object) => {use: Function, has: Function}}}
 */
function createConnectorSecretPort({ pool, keyring, contexto = contextoAtual }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createConnectorSecretPort exige pool');
  const store = createSecretStore({ pool, keyring: keyring || createKeyring() });

  // Liga a porta a uma integração já resolvida. Confere de novo, aqui, que ela é da mesma
  // Organization do contexto e do processo — nunca confia cegamente no que chegou (defesa em
  // profundidade, o mesmo padrão do registry na Fase B e da porta na Fase B.1).
  function forIntegration(contextoEntrada, integration) {
    const context = createConnectorContext(contextoEntrada);
    if (integration === null || typeof integration !== 'object') {
      throw new ConnectorError('integration inválida', CODIGOS.INTEGRATION_INVALID);
    }
    const mesmoId = (a, b) => typeof a === 'string' && a.toLowerCase() === b;
    if (!mesmoId(integration.organizationId, context.organizationId)) {
      throw outroTenant('a integração não pertence à Organization do contexto');
    }
    if (context.integrationId && integration.integrationId !== context.integrationId) {
      throw outroTenant('a integração não é a que o contexto tem ligada');
    }
    const ambiente = contexto();
    if (!ambiente) {
      throw new IntegracaoError('leitura de segredo fora de um contexto de Organization', { codigo: 'TENANT_CONTEXT_REQUIRED', status: 500 });
    }
    if (String(ambiente.organizationId).toLowerCase() !== context.organizationId) {
      throw outroTenant('a Organization da consulta não é a do contexto do processo');
    }

    /**
     * Lê o segredo `tipo` e entrega o plaintext a `usar(plaintext, meta)`. Nunca retorna o valor —
     * o que volta é o RESULTADO de `usar`. Sem fallback de env: só o que está persistido nesta
     * integração, filtrado por `integrationId` E `organizationId` juntos (nunca um sozinho).
     */
    async function use(tipo, usar) {
      if (typeof usar !== 'function') throw new TypeError('use(tipo, usar) exige um callback: o plaintext nunca é retornado');
      const hkdf = contextoHkdf(integration.integrationProvider, tipo);
      return store.usarSegredo(
        { integrationId: integration.integrationId, organizationId: integration.organizationId, tipo, contexto: hkdf },
        (plaintext, meta) => { secretGuard.registrar(plaintext); return usar(plaintext, meta); }
      );
    }

    // Só diz SE existe (diagnóstico/capability); nunca entrega o valor.
    async function has(tipo) {
      try { await use(tipo, () => true); return true; } catch (err) {
        if (CODIGOS_AUSENCIA.has(err.codigo)) return false;
        throw err;
      }
    }

    return Object.freeze({ use, has });
  }

  return Object.freeze({ forIntegration });
}

module.exports = { createConnectorSecretPort };
