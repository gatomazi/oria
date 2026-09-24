'use strict';

// Fase C · descritor pronto para `registry.register(...)` (lib/connectors/registry.js).
//
//   registry.register(createReservaInkCommerceDescriptor({ secretPort }))
//   registry.resolve('commerce', 'reserva_ink', { organizationId, storeId })
//
// `secretPort` é a instância de `createConnectorSecretPort` (Fase C) montada uma vez, no bootstrap
// da aplicação, com o pool real — o mesmo padrão de `resolveIntegration` na Fase B.1: a dependência
// concreta (Postgres) fica FORA do connector, e o connector só recebe a porta já pronta.

const { createReservaInkCommerceConnector, CAPABILITIES } = require('./connector');

function createReservaInkCommerceDescriptor({ secretPort, fetchImpl, ordersRepository } = {}) {
  if (!secretPort) throw new Error('createReservaInkCommerceDescriptor exige secretPort');
  // ordersRepository: instância de createInkOrdersRepository (Etapa 2/rodada G.1) — lê
  // pedidos_ink/pedidos_ink_itens locais; exigido aqui pelo mesmo motivo que secretPort: a
  // dependência concreta (Postgres) fica FORA do connector, montada uma vez no bootstrap.
  if (!ordersRepository) throw new Error('createReservaInkCommerceDescriptor exige ordersRepository (capability orders)');
  return {
    domain: 'commerce',
    provider: 'reserva_ink',
    integrationProvider: 'ink',
    requiresStoreContext: true,
    capabilities: CAPABILITIES,
    label: 'Reserva Ink',
    create: ({ context, resolveIntegration }) => createReservaInkCommerceConnector({ context, resolveIntegration, secretPort, fetchImpl, ordersRepository }),
  };
}

module.exports = { createReservaInkCommerceDescriptor };
