'use strict';

// Fase B · contratos dos connectors por DOMAIN (docs/features/ORIA_PRODUCT_ANALYTICS_CONNECTOR_ARCHITECTURE_V2.md §4, §43).
//
// Este arquivo define o que um connector É para o domínio do Oria, sem olhar para a tabela
// `integrations`. A ordem de dependência é esta, e nunca a inversa:
//
//   Domain Contract  →  ConnectorContext  →  IntegrationResolver (porta; Fase B.1)
//
// Premissa do produto (ORIA-TENANCY-STORE-01): 1 Organization = 1 Store. Toda integração pertence à
// ORGANIZATION; a Store é só o contexto operacional (produtos, pedidos, catálogo, analytics). Por isso
// não existe "escopo de integração": o que um connector declara é se precisa do contexto de Store.
//
// O que mora aqui:
//   · DOMAINS e o contrato de cada um (métodos + capabilities);
//   · o ConnectorContext (organizationId + storeId + integrationId opcional);
//   · a validação do descritor de um connector e a conferência do objeto que ele devolve.
// O que NÃO mora aqui: nenhuma regra de provider. Nenhum `provider === '…'`.

const { ConnectorError, CODIGOS, nomeSeguro } = require('./errors');

const DOMAINS = Object.freeze({
  COMMERCE: 'commerce',
  ANALYTICS: 'analytics',
  // Sinais de evento (Meta Pixel/CAPI, BigQuery, tracking próprio). Separado de `analytics` e de
  // `ads` de propósito (§14.2): Meta Ads ≠ Meta Events, mesmo dividindo a credencial.
  EVENT_ANALYTICS: 'event_analytics',
  ADS: 'ads',
  // Reservados no vocabulário (§5), ainda sem contrato: registrar um connector neles é erro
  // explícito, não um registro que passa sem ser conferido.
  MESSAGING: 'messaging',
  AI: 'ai',
});

// Vocabulário de evento do Oria (§13). O provider mapeia o nome dele para estes no adapter.
const NORMALIZED_EVENT_TYPES = Object.freeze(['product_view', 'add_to_cart', 'checkout_started', 'purchase', 'refund']);

function congelar(valor) {
  if (valor && typeof valor === 'object' && !Object.isFrozen(valor)) {
    Object.values(valor).forEach(congelar);
    Object.freeze(valor);
  }
  return valor;
}

// Contrato por domain.
//   storeContext    'required': todo connector do domain trabalha sobre dados da Store, então declarar
//                   `requiresStoreContext: false` é inválido; 'optional': o connector decide
//   alwaysRequired  métodos que todo connector do domain tem, com qualquer capability
//   minimumOneOf    ao menos uma destas capabilities é true (connector que não faz nada não existe)
//   capabilities    nome → métodos que ela EXIGE quando true ([] = capability informativa, sem método)
// O conjunto de chaves de `capabilities` é FECHADO: o connector declara todas, true ou false, e
// nenhuma a mais. É isso que impede "capability inventada" e permite o Oria adaptar a tela ao que o
// provider realmente oferece (§43).
const CONTRACTS = congelar({
  [DOMAINS.COMMERCE]: {
    storeContext: 'required',
    alwaysRequired: [],
    minimumOneOf: ['products'],
    capabilities: {
      products: ['listProducts', 'getProduct'],
      variants: ['listProductVariants'],
      orders: ['listOrders', 'getOrder'],
      productCosts: ['getProductCost'],
      refunds: [],
    },
  },
  [DOMAINS.ANALYTICS]: {
    storeContext: 'required',
    alwaysRequired: [],
    minimumOneOf: ['productMetrics', 'eventMetrics'],
    capabilities: {
      productMetrics: ['getProductPerformance'],
      eventMetrics: ['getEventMetrics'],
      realtime: [],
    },
  },
  [DOMAINS.EVENT_ANALYTICS]: {
    storeContext: 'optional',
    alwaysRequired: ['getEventCoverage'],
    // §14.20: um provider pode só expor agregados; outro expõe evento a evento. Ao menos um dos dois.
    minimumOneOf: ['aggregatedProductEvents', 'eventLevel'],
    capabilities: {
      aggregatedProductEvents: ['getProductEventAggregates'],
      eventLevel: ['getProductEvents'],
      productIdentity: [],
      eventDedupKeys: [],
    },
  },
  [DOMAINS.ADS]: {
    storeContext: 'optional',
    alwaysRequired: [],
    minimumOneOf: ['campaignPerformance', 'adPerformance', 'creativePerformance'],
    capabilities: {
      campaignPerformance: ['getCampaignPerformance'],
      adPerformance: ['getAdPerformance'],
      creativePerformance: ['getCreativePerformance'],
    },
  },
});

function contractOf(domain) {
  if (!Object.values(DOMAINS).includes(domain)) {
    throw new ConnectorError(`domain desconhecido: ${nomeSeguro(domain)}`, CODIGOS.DOMAIN_UNKNOWN);
  }
  const contract = CONTRACTS[domain];
  if (!contract) throw new ConnectorError(`domain sem contrato: ${domain}`, CODIGOS.DOMAIN_WITHOUT_CONTRACT);
  return contract;
}

// Métodos que o objeto de um connector precisa ter, dado o que ele declarou como capability.
function requiredMethods(domain, capabilities) {
  const contract = contractOf(domain);
  const metodos = new Set(contract.alwaysRequired);
  for (const [nome, ativa] of Object.entries(capabilities)) {
    if (ativa === true) contract.capabilities[nome].forEach((m) => metodos.add(m));
  }
  return [...metodos];
}

// ── ConnectorContext ────────────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Lista fechada (whitelist): campo desconhecido reprova. Token, loja legada e URL não entram no
// contexto nem por engano — quem precisa de credencial pede à integração, com o contexto ligado.
const CAMPOS_DO_CONTEXTO = Object.freeze(['organizationId', 'storeId', 'integrationId']);

const contextoInvalido = (mensagem) => new ConnectorError(mensagem, CODIGOS.CONTEXT_INVALID);

function idOpcional(valor, campo) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'string' || !UUID.test(valor)) throw contextoInvalido(`${campo} inválido`);
  return valor.toLowerCase();
}

// O id da integração é OPACO para o contrato: hoje `integrations.id` é BIGSERIAL (o pg entrega
// string), amanhã pode ser UUID. O contrato não decide o tipo da coluna; só exige uma string curta e
// sem caractere que escape de um identificador. Comparação é sempre exata, sem normalizar caixa.
const ID_OPACO = /^[A-Za-z0-9_-]{1,64}$/;
const ehIdOpaco = (valor) => typeof valor === 'string' && ID_OPACO.test(valor);

function integrationIdOpcional(valor) {
  if (valor === undefined || valor === null) return null;
  if (!ehIdOpaco(valor)) throw contextoInvalido('integrationId inválido');
  return valor;
}

/**
 * Contexto de um connector.
 *   organizationId  o tenant: dono das integrações, dos segredos e dos entitlements
 *   storeId         contexto OPERACIONAL (produtos, pedidos, catálogo, analytics); não é dono de integração
 *   integrationId   integração explicitamente ligada, quando o chamador já sabe qual (jobs, §22)
 * `integrationId` é opcional: fica null até a integração ser resolvida, e um job que já sabe qual
 * integração usar (§22) pode informá-lo — o IntegrationResolver confere que ela pertence à
 * Organization/Store do contexto.
 *
 * @param {{organizationId: string, storeId?: string|null, integrationId?: string|null}} entrada
 * @returns {Readonly<import('./types').ConnectorContext>}
 */
function createConnectorContext(entrada) {
  if (entrada === null || typeof entrada !== 'object' || Array.isArray(entrada)) throw contextoInvalido('contexto deve ser um objeto');
  const extras = Object.keys(entrada).filter((k) => !CAMPOS_DO_CONTEXTO.includes(k));
  if (extras.length) throw contextoInvalido(`campos não permitidos no contexto: ${extras.map(nomeSeguro).join(', ')}`);
  const organizationId = idOpcional(entrada.organizationId, 'organizationId');
  if (!organizationId) throw contextoInvalido('organizationId é obrigatório');
  return Object.freeze({
    organizationId,
    storeId: idOpcional(entrada.storeId, 'storeId'),
    integrationId: integrationIdOpcional(entrada.integrationId),
  });
}

/**
 * Devolve um contexto novo com a integração informada. Trocar uma integração já definida por outra
 * é erro: seria reapontar a credencial de uma chamada no meio do caminho.
 */
function withIntegrationId(contexto, integrationId) {
  const base = createConnectorContext(contexto);
  const nova = integrationIdOpcional(integrationId);
  if (base.integrationId && nova !== base.integrationId) throw contextoInvalido('o contexto já está ligado a outra integração');
  return createConnectorContext({ ...base, integrationId: nova });
}

// ── Descritor ───────────────────────────────────────────────────────────────────────────────────

const IDENTIFICADOR = /^[a-z][a-z0-9_]{1,40}$/;
const CAMPOS_DO_DESCRITOR = Object.freeze(['domain', 'provider', 'integrationProvider', 'requiresStoreContext', 'capabilities', 'label', 'create']);

const descritorInvalido = (mensagem) => new ConnectorError(mensagem, CODIGOS.DESCRIPTOR_INVALID);

/**
 * Um connector se registra como (domain, provider). Um mesmo provider aparece em vários domains
 * com descritores independentes (Meta em `ads` e em `event_analytics`), cada um com as próprias
 * capabilities e o próprio contrato.
 *
 * `provider` é a chave no registry (`reserva_ink`). `integrationProvider` é a chave da credencial em
 * `integrations.provider` (`ink`) — por padrão igual a `provider`. É por ela que dois domains
 * compartilham a MESMA integração (sempre da Organization) sem virarem o mesmo connector.
 * `requiresStoreContext` diz se o connector só funciona com uma Store no contexto.
 *
 * @param {Object} descritor
 * @returns {Readonly<Object>} descritor normalizado e congelado
 */
function validateDescriptor(descritor) {
  if (descritor === null || typeof descritor !== 'object' || Array.isArray(descritor)) throw descritorInvalido('descritor deve ser um objeto');
  const extras = Object.keys(descritor).filter((k) => !CAMPOS_DO_DESCRITOR.includes(k));
  if (extras.length) throw descritorInvalido(`campos não permitidos no descritor: ${extras.map(nomeSeguro).join(', ')}`);

  const contract = contractOf(descritor.domain);
  if (typeof descritor.provider !== 'string' || !IDENTIFICADOR.test(descritor.provider)) throw descritorInvalido('provider inválido');
  const integrationProvider = descritor.integrationProvider === undefined ? descritor.provider : descritor.integrationProvider;
  if (typeof integrationProvider !== 'string' || !IDENTIFICADOR.test(integrationProvider)) throw descritorInvalido('integrationProvider inválido');
  // Sem default: quem escreve o connector decide, de propósito, se ele precisa do contexto de Store.
  if (typeof descritor.requiresStoreContext !== 'boolean') throw descritorInvalido('requiresStoreContext deve ser boolean');
  if (contract.storeContext === 'required' && descritor.requiresStoreContext !== true) {
    throw descritorInvalido(`${descritor.domain} sempre exige contexto de Store: requiresStoreContext deve ser true`);
  }
  if (typeof descritor.create !== 'function') throw descritorInvalido('create deve ser uma função');
  if (descritor.label !== undefined && (typeof descritor.label !== 'string' || !descritor.label.trim())) throw descritorInvalido('label inválido');

  const declaradas = descritor.capabilities;
  if (declaradas === null || typeof declaradas !== 'object' || Array.isArray(declaradas)) throw descritorInvalido('capabilities deve ser um objeto');
  const esperadas = Object.keys(contract.capabilities);
  const desconhecidas = Object.keys(declaradas).filter((k) => !esperadas.includes(k));
  if (desconhecidas.length) throw descritorInvalido(`capabilities desconhecidas em ${descritor.domain}: ${desconhecidas.map(nomeSeguro).join(', ')}`);
  const ausentes = esperadas.filter((k) => !(k in declaradas));
  if (ausentes.length) throw descritorInvalido(`capabilities não declaradas em ${descritor.domain}: ${ausentes.join(', ')}`);
  for (const nome of esperadas) {
    if (typeof declaradas[nome] !== 'boolean') throw descritorInvalido(`capability ${nome} deve ser boolean`);
  }
  if (!contract.minimumOneOf.some((nome) => declaradas[nome] === true)) {
    throw descritorInvalido(`${descritor.domain} exige ao menos uma capability: ${contract.minimumOneOf.join(' | ')}`);
  }

  return Object.freeze({
    domain: descritor.domain,
    provider: descritor.provider,
    integrationProvider,
    requiresStoreContext: descritor.requiresStoreContext,
    label: descritor.label ? descritor.label.trim() : descritor.provider,
    capabilities: Object.freeze(Object.fromEntries(esperadas.map((nome) => [nome, declaradas[nome]]))),
    create: descritor.create,
  });
}

/**
 * Confere o objeto que `create` devolveu contra o contrato do domain e o que o descritor declarou:
 * todo método exigido existe como função. Capability false não exige nada — mas também não é
 * fingida: `supports()` responde pelo descritor.
 */
function assertConnectorShape(descritor, connector) {
  if (connector === null || typeof connector !== 'object') {
    throw new ConnectorError(`connector ${descritor.domain}/${descritor.provider} não devolveu um objeto`, CODIGOS.CONTRACT_VIOLATION);
  }
  const faltando = requiredMethods(descritor.domain, descritor.capabilities).filter((m) => typeof connector[m] !== 'function');
  if (faltando.length) {
    throw new ConnectorError(`connector ${descritor.domain}/${descritor.provider} viola o contrato; faltam: ${faltando.join(', ')}`, CODIGOS.CONTRACT_VIOLATION);
  }
}

module.exports = {
  DOMAINS,
  NORMALIZED_EVENT_TYPES,
  CONTRACTS,
  contractOf,
  requiredMethods,
  ehIdOpaco,
  createConnectorContext,
  withIntegrationId,
  validateDescriptor,
  assertConnectorShape,
};
