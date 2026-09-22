'use strict';

// Erros da camada de connectors. Um só tipo, com `codigo` estável: quem trata (rota, job, teste)
// decide pelo código, nunca pelo texto da mensagem. As mensagens não carregam id de tenant, token
// nem valor vindo do chamador além do nome curto de domain/provider.

const CODIGOS = Object.freeze({
  DOMAIN_UNKNOWN: 'CONNECTOR_DOMAIN_UNKNOWN',
  DOMAIN_WITHOUT_CONTRACT: 'CONNECTOR_DOMAIN_WITHOUT_CONTRACT',
  DESCRIPTOR_INVALID: 'CONNECTOR_DESCRIPTOR_INVALID',
  ALREADY_REGISTERED: 'CONNECTOR_ALREADY_REGISTERED',
  NOT_REGISTERED: 'CONNECTOR_NOT_REGISTERED',
  CONTEXT_INVALID: 'CONNECTOR_CONTEXT_INVALID',
  CONTRACT_VIOLATION: 'CONNECTOR_CONTRACT_VIOLATION',
  CAPABILITY_UNSUPPORTED: 'CONNECTOR_CAPABILITY_UNSUPPORTED',
  INTEGRATION_RESOLVER_MISSING: 'CONNECTOR_INTEGRATION_RESOLVER_MISSING',
  INTEGRATION_INVALID: 'CONNECTOR_INTEGRATION_INVALID',
  INTEGRATION_NOT_CONNECTED: 'INTEGRATION_NOT_CONNECTED',
  INTEGRATION_TENANT_MISMATCH: 'CONNECTOR_INTEGRATION_TENANT_MISMATCH',
});

class ConnectorError extends Error {
  constructor(message, codigo) {
    super(message);
    this.name = 'ConnectorError';
    this.codigo = codigo;
  }
}

// Só o nome curto do que o chamador pediu entra na mensagem; o resto é cortado.
const nomeSeguro = (valor) => String(valor).replace(/[^a-z0-9_]/gi, '?').slice(0, 40);

module.exports = { ConnectorError, CODIGOS, nomeSeguro };
