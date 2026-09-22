'use strict';

// Fase B · registry de connectors, chaveado por (domain, provider).
//
//   registry.resolve('commerce', 'reserva_ink', { organizationId, storeId })
//   registry.resolve('analytics', 'ga4', { organizationId, storeId })
//   registry.resolve('ads', 'meta', …)              ┐ mesmo provider, domains diferentes,
//   registry.resolve('event_analytics', 'meta', …)  ┘ contratos e capabilities independentes
//
// Quem consome (service, job, rota) fala só com o domain; nenhum `if (provider === …)` fora do
// adapter. Não há registry global: `createConnectorRegistry()` devolve uma instância, e quem monta a
// aplicação registra os adapters nela. Cada `resolve` cria um connector NOVO, ligado ao contexto
// daquela chamada — estado de um tenant não é reaproveitado por outro.
//
// Credencial: o connector nunca recebe token nem lê ambiente. Recebe `resolveIntegration()`, uma
// função já ligada a (domain, provider, contexto) — ele não escolhe Organization, Store nem
// provider da credencial. O resultado é conferido aqui (defesa em profundidade) contra o escopo do
// descritor: uma integração de outra Store, ou da Organization quando o descritor não permite,
// vira CONNECTOR_INTEGRATION_SCOPE_MISMATCH em vez de ser usada em silêncio.

const { ConnectorError, CODIGOS, nomeSeguro } = require('./errors');
const {
  INTEGRATION_SCOPES,
  ehIdOpaco,
  createConnectorContext,
  validateDescriptor,
  assertConnectorShape,
} = require('./contracts');

const incompativel = (mensagem) => new ConnectorError(mensagem, CODIGOS.INTEGRATION_SCOPE_MISMATCH);

// Confere o que o IntegrationResolver devolveu contra o contexto e o escopo do descritor.
function conferirIntegracao(resultado, descritor, contexto) {
  if (resultado === null || typeof resultado !== 'object' || !ehIdOpaco(resultado.integrationId)) {
    throw new ConnectorError('o resolvedor de integrações devolveu um resultado inválido', CODIGOS.INTEGRATION_INVALID);
  }
  // `storeId` precisa vir explícito (uuid ou null): omitir não vale como "qualquer Store".
  if (resultado.organizationId === undefined || resultado.storeId === undefined) {
    throw new ConnectorError('o resolvedor de integrações não informou organizationId/storeId', CODIGOS.INTEGRATION_INVALID);
  }
  const mesmoId = (a, b) => typeof a === 'string' && a.toLowerCase() === b;
  if (!mesmoId(resultado.organizationId, contexto.organizationId)) throw incompativel('a integração pertence a outra Organization');

  const daOrganization = resultado.storeId === null;
  if (!daOrganization && !mesmoId(resultado.storeId, contexto.storeId)) throw incompativel('a integração pertence a outra Store');
  if (descritor.integrationScope === INTEGRATION_SCOPES.STORE && daOrganization) {
    throw incompativel('este connector só aceita integração da Store; integração da Organization não é fallback');
  }
  if (descritor.integrationScope === INTEGRATION_SCOPES.ORGANIZATION && !daOrganization) {
    throw incompativel('este connector só aceita integração da Organization');
  }
  if (contexto.integrationId && resultado.integrationId !== contexto.integrationId) {
    throw incompativel('o contexto aponta para outra integração');
  }

  return Object.freeze({
    integrationId: resultado.integrationId,
    organizationId: contexto.organizationId,
    storeId: resultado.storeId === null ? null : contexto.storeId,
    status: typeof resultado.status === 'string' ? resultado.status : null,
    config: Object.freeze({ ...(resultado.config && typeof resultado.config === 'object' ? resultado.config : {}) }),
  });
}

// Função que o connector recebe: sem argumentos, ligada ao (domain, provider, contexto) da chamada.
function ligarResolvedor(porta, descritor, contexto) {
  return async function resolveIntegration() {
    if (!porta) {
      throw new ConnectorError('registry criado sem resolvedor de integrações', CODIGOS.INTEGRATION_RESOLVER_MISSING);
    }
    const resultado = await porta.resolve(Object.freeze({
      domain: descritor.domain,
      provider: descritor.provider,
      integrationProvider: descritor.integrationProvider,
      integrationScope: descritor.integrationScope,
      context: contexto,
    }));
    return conferirIntegracao(resultado, descritor, contexto);
  };
}

const chaveDe = (domain, provider) => `${domain}:${provider}`;

// Visão pública do descritor: sem `create`.
const visaoPublica = ({ domain, provider, integrationProvider, integrationScope, label, capabilities }) => (
  Object.freeze({ domain, provider, integrationProvider, integrationScope, label, capabilities })
);

/**
 * @param {{integrations?: import('./types').IntegrationResolver|null}} [opcoes]
 *   `integrations`: a porta implementada pela camada de integrações (Fase B.1). Sem ela, o registry
 *   funciona, e `resolveIntegration()` dos connectors falha com INTEGRATION_RESOLVER_MISSING.
 */
function createConnectorRegistry({ integrations = null } = {}) {
  if (integrations !== null && (typeof integrations !== 'object' || typeof integrations.resolve !== 'function')) {
    throw new ConnectorError('integrations deve implementar resolve()', CODIGOS.INTEGRATION_RESOLVER_MISSING);
  }
  const descritores = new Map();

  function obter(domain, provider) {
    const descritor = descritores.get(chaveDe(domain, provider));
    if (!descritor) throw new ConnectorError(`connector não registrado: ${nomeSeguro(domain)}/${nomeSeguro(provider)}`, CODIGOS.NOT_REGISTERED);
    return descritor;
  }

  return Object.freeze({
    register(descritor) {
      const normalizado = validateDescriptor(descritor);
      const chave = chaveDe(normalizado.domain, normalizado.provider);
      if (descritores.has(chave)) {
        throw new ConnectorError(`connector já registrado: ${normalizado.domain}/${normalizado.provider}`, CODIGOS.ALREADY_REGISTERED);
      }
      descritores.set(chave, normalizado);
      return visaoPublica(normalizado);
    },

    /**
     * Cria o connector de (domain, provider) ligado ao contexto. `storeId` é obrigatório, exceto em
     * connector de escopo `organization`.
     */
    resolve(domain, provider, contextoEntrada) {
      const descritor = obter(domain, provider);
      const contexto = createConnectorContext(contextoEntrada);
      if (descritor.integrationScope !== INTEGRATION_SCOPES.ORGANIZATION && contexto.storeId === null) {
        throw new ConnectorError(`${domain}/${provider} exige storeId no contexto`, CODIGOS.CONTEXT_INVALID);
      }
      const connector = descritor.create(Object.freeze({
        context: contexto,
        resolveIntegration: ligarResolvedor(integrations, descritor, contexto),
      }));
      assertConnectorShape(descritor, connector);

      const supports = (capability) => descritor.capabilities[capability] === true;
      return Object.freeze({
        domain: descritor.domain,
        provider: descritor.provider,
        integrationProvider: descritor.integrationProvider,
        integrationScope: descritor.integrationScope,
        capabilities: descritor.capabilities,
        context: contexto,
        connector,
        supports,
        // Para o service falhar cedo, com código estável, em vez de chamar método que o provider não tem.
        require(capability) {
          if (!supports(capability)) {
            throw new ConnectorError(`${domain}/${provider} não suporta ${nomeSeguro(capability)}`, CODIGOS.CAPABILITY_UNSUPPORTED);
          }
        },
      });
    },

    has: (domain, provider) => descritores.has(chaveDe(domain, provider)),
    describe: (domain, provider) => visaoPublica(obter(domain, provider)),
    list: () => Object.freeze([...descritores.values()].map(visaoPublica).sort((a, b) => chaveDe(a.domain, a.provider).localeCompare(chaveDe(b.domain, b.provider)))),
    // Providers disponíveis num domain — a tela escolhe entre eles sem conhecer nenhum.
    providersOf: (domain) => Object.freeze([...descritores.values()].filter((d) => d.domain === domain).map((d) => d.provider).sort()),
    // Domains que um provider implementa — o mesmo provider em vários domains.
    domainsOf: (provider) => Object.freeze([...descritores.values()].filter((d) => d.provider === provider).map((d) => d.domain).sort()),
  });
}

module.exports = { createConnectorRegistry };
