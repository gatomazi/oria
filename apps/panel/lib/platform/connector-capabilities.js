'use strict';

// Registry canônico de CONNECTOR CAPABILITIES.
//
// Três eixos diferentes, e este arquivo é dono de exatamente um deles:
//
//   FEATURE COMERCIAL     o que o cliente compra do Oria          lib/platform/entitlements.js
//   MODULE CAPABILITY     modo interno de uma feature             lib/creative-core/module-capabilities.js
//   CONNECTOR CAPABILITY  o que um provider externo suporta       ESTE ARQUIVO
//   PERMISSÃO             o que um usuário pode fazer             (RBAC — fora desta rodada)
//
// A regra de classificação (comando §2): "se amanhã o Oria trocar a Reserva Ink por outro
// fornecedor, isso continua existindo como capacidade do Oria?". Se NÃO, é capability de
// connector, não feature de plano.
//
// ── Conexão ≠ entitlement (§13) ──────────────────────────────────────────────────────────────
// Connector conectado NÃO concede feature nenhuma, e feature ligada NÃO conecta connector nenhum.
// Este módulo não importa `entitlements.js` e `entitlements.js` não importa este módulo — a
// ausência de aresta entre os dois é conferida por teste.
//
// ── Não inventar capability (§8) ─────────────────────────────────────────────────────────────
// Cada entrada declara o ESTADO real no código de hoje:
//
//   suportada    existe chamada real ao provider (endpoint citado em `evidencia`)
//   derivada     o Oria monta a capacidade em cima de outra capability; o provider NÃO tem
//                endpoint próprio para isso. Funciona, mas não é capacidade nativa do provider.
//   planejada    NÃO existe no código. Nunca fica disponível operacionalmente.
//
// Só `suportada` e `derivada` podem ficar disponíveis em runtime. `planejada` é vocabulário —
// serve para o roadmap e para a tela de integração não prometer o que não existe (§12/§31).

const SUPORTADA = 'suportada';
const DERIVADA = 'derivada';
const PLANEJADA = 'planejada';
const ESTADOS = Object.freeze([SUPORTADA, DERIVADA, PLANEJADA]);

// Estados que ficam disponíveis quando o connector está conectado.
const ESTADOS_OPERACIONAIS = Object.freeze([SUPORTADA, DERIVADA]);

// Reserva Ink. `evidencia` é o endpoint/arquivo real — se a evidência sumir do código, a entrada
// está mentindo e o teste de registry reprova.
const INK = Object.freeze({
  rotulo: 'Reserva Ink',
  capabilities: Object.freeze({
    orders: Object.freeze({
      rotulo: 'Pedidos',
      estado: SUPORTADA,
      evidencia: 'GET /v1/stores/orders · GET /v1/stores/orders/{id}',
    }),
    products: Object.freeze({
      rotulo: 'Produtos',
      estado: SUPORTADA,
      evidencia: 'GET|POST /v1/stores/products · PATCH /v1/stores/products/{id} · /products/{id}/copy · /product_types',
    }),
    collections: Object.freeze({
      rotulo: 'Categorias',
      estado: SUPORTADA,
      evidencia: 'GET|POST|PATCH|DELETE /v1/stores/collections · /collections/{id}/custom_showcase',
    }),
    product_clusters: Object.freeze({
      rotulo: 'Agrupamentos',
      estado: SUPORTADA,
      evidencia: 'GET|POST /v1/stores/product_clusters · DELETE /product_clusters/{id}/products/{id}',
    }),
    promotions: Object.freeze({
      rotulo: 'Promoções',
      estado: SUPORTADA,
      evidencia: 'GET|POST|PATCH|DELETE /v1/stores/promotions',
    }),
    exchanges: Object.freeze({
      rotulo: 'Trocas',
      estado: SUPORTADA,
      evidencia: 'GET|POST /v1/stores/exchanges · GET /v1/stores/exchanges/{id}',
    }),
    refunds: Object.freeze({
      rotulo: 'Reembolsos',
      estado: SUPORTADA,
      // A Ink NÃO expõe listagem global de reembolso — só por pedido. A listagem do painel sai do
      // audit_log do próprio Oria ("feitos por este painel"), nunca de uma cópia do lado da Ink.
      evidencia: 'GET|POST /v1/stores/orders/{id}/refunds (sem listagem global — ver server.js §Reembolsos)',
    }),
    catalog_sync: Object.freeze({
      rotulo: 'Sincronização do catálogo',
      estado: SUPORTADA,
      evidencia: 'varredura paginada de /v1/stores/products → cache produtos_ink (produtos_ink_sync)',
    }),
    product_feed: Object.freeze({
      rotulo: 'Feed de produtos (CSV)',
      estado: SUPORTADA,
      evidencia: 'segredo ink-feed-url-v1 → download/parse do CSV → cache produtos_feed',
    }),
    shipping_simulation: Object.freeze({
      rotulo: 'Simulação de frete',
      estado: SUPORTADA,
      evidencia: 'GET /v1/stores/shipping_simulation?cep=',
    }),
    balance: Object.freeze({
      rotulo: 'Saldo e saques',
      estado: SUPORTADA,
      evidencia: 'GET /v1/stores/balance · /balance_extract · /withdraws · /prepayments',
    }),
    abandoned_carts: Object.freeze({
      rotulo: 'Carrinhos abandonados',
      estado: SUPORTADA,
      evidencia: 'GET /v1/stores/abandoned_carts',
    }),
    webhooks: Object.freeze({
      rotulo: 'Webhooks',
      estado: SUPORTADA,
      evidencia: 'POST /api/webhooks/ink/:token com HMAC (segredo ink-webhook-secret-v1)',
    }),

    // ── Derivadas: o Oria monta, a Ink não tem endpoint para isso ────────────────────────────
    inventory: Object.freeze({
      rotulo: 'Estoque',
      estado: DERIVADA,
      derivadaDe: Object.freeze(['products', 'webhooks']),
      // Não existe endpoint de estoque na API da Ink. O painel observa `product_variant`
      // (available_quantity/is_available) de carona nos webhooks de pedido, e faz uma varredura
      // de um produto dedicado chamado "controle-estoque". É capacidade do Oria em cima da Ink,
      // não capacidade nativa do provider.
      evidencia: 'estoque_observacoes (webhook de pedido) + controle_estoque_observacoes (produto "controle-estoque")',
    }),
    tracking: Object.freeze({
      rotulo: 'Rastreamento',
      estado: DERIVADA,
      derivadaDe: Object.freeze(['orders']),
      // Campo `tracking_url` dentro do objeto de pedido. Não há endpoint de rastreio.
      evidencia: 'campo order.tracking_url do payload de pedido',
    }),

    // ── Planejadas: NÃO existem no código ────────────────────────────────────────────────────
    production: Object.freeze({
      rotulo: 'Produção',
      estado: PLANEJADA,
      // Auditado: nenhuma rota, nenhum endpoint, nenhum estado de produção no painel. O que
      // existe com nome parecido é `custo_producao`, coluna FINANCEIRA do Oria — não é status de
      // produção da Ink.
      evidencia: null,
    }),
    shipping: Object.freeze({
      rotulo: 'Envio (etiqueta/fulfilment)',
      estado: PLANEJADA,
      // Só existe simulação de frete (`shipping_simulation`). Nada de etiqueta, despacho ou
      // fulfilment.
      evidencia: null,
    }),
    product_import: Object.freeze({
      rotulo: 'Importação de produtos e estampas',
      estado: PLANEJADA,
      // Distinto de `catalog_sync` (que só espelha o catálogo em cache). Importar a ESTAMPA
      // (master asset) para dentro do Oria é a dívida registrada em docs/productization/artwork-vault.md.
      evidencia: null,
    }),
  }),
});

const PROVIDERS = Object.freeze({ ink: INK });

class CapabilityDesconhecidaError extends Error {
  constructor(chave) {
    super(`connector capability desconhecida: ${chave}`);
    this.name = 'CapabilityDesconhecidaError';
    this.chave = chave;
  }
}

// Namespace obrigatório (§34): a chave de capability NUNCA reusa a chave de uma feature comercial.
const chave = (provider, capability) => `${provider}.${capability}`;

function separar(chaveCompleta) {
  const texto = String(chaveCompleta || '');
  const i = texto.indexOf('.');
  if (i <= 0 || i === texto.length - 1) throw new CapabilityDesconhecidaError(texto);
  return { provider: texto.slice(0, i), capability: texto.slice(i + 1) };
}

function definicao(chaveCompleta) {
  const { provider, capability } = separar(chaveCompleta);
  const p = PROVIDERS[provider];
  const def = p && p.capabilities[capability];
  if (!def) throw new CapabilityDesconhecidaError(chaveCompleta);
  return { provider, capability, ...def };
}

// Toda chave do registry, no formato `provider.capability`.
const CAPABILITIES = Object.freeze(
  Object.entries(PROVIDERS).flatMap(([p, def]) => Object.keys(def.capabilities).map((c) => chave(p, c)))
);

function capabilitiesDoProvider(provider, { estados = null } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new CapabilityDesconhecidaError(`${provider}.*`);
  return Object.entries(p.capabilities)
    .filter(([, def]) => !estados || estados.includes(def.estado))
    .map(([c]) => c);
}

// Uma capability só fica DISPONÍVEL operacionalmente com as duas coisas:
//   1. o provider suporta (estado operacional no registry)  e
//   2. a integração daquela Organization está conectada.
// Nenhuma feature comercial entra nesta conta — é exatamente o ponto de §13.
function capabilityDisponivel(chaveCompleta, { conectado } = {}) {
  const def = definicao(chaveCompleta);
  return ESTADOS_OPERACIONAIS.includes(def.estado) && conectado === true;
}

// Read model do connector (§32). Sem segredo, sem chamada ao provider: só registry + o booleano
// de conexão que o chamador já resolveu.
function readModel(provider, { conectado = false } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new CapabilityDesconhecidaError(`${provider}.*`);
  const conectadoDeFato = conectado === true;
  return Object.freeze({
    provider,
    rotulo: p.rotulo,
    connected: conectadoDeFato,
    // `capabilities` = o que está disponível AGORA. Vazio quando desconectado, sempre.
    capabilities: Object.freeze(conectadoDeFato ? capabilitiesDoProvider(provider, { estados: ESTADOS_OPERACIONAIS }) : []),
    // `suportadas` = o que o connector passa a habilitar DEPOIS de conectar (§31). Independe da
    // conexão: é o que a tela de integração promete, e só promete o que o código faz.
    suportadas: Object.freeze(capabilitiesDoProvider(provider, { estados: ESTADOS_OPERACIONAIS }).map((c) => ({
      capability: c,
      chave: chave(provider, c),
      rotulo: p.capabilities[c].rotulo,
      estado: p.capabilities[c].estado,
    }))),
    planejadas: Object.freeze(capabilitiesDoProvider(provider, { estados: [PLANEJADA] })),
  });
}

// Middleware Express para uma rota que depende de connector, não de plano.
//
// `lerConexao(provider, { req })` devolve boolean — quem sabe se a integração está conectada é o
// resolvedor de integrações da Organization do contexto, injetado pelo chamador. Erro ao ler NÃO
// vira "disponível": vira indisponível.
//
// Os códigos de erro são DISTINTOS de `feature_nao_disponivel` de propósito (§22): a tela precisa
// conseguir mostrar "Conecte a Reserva Ink para usar este módulo" em vez de um 403 genérico.
function requireCapability(lerConexao, chaveCompleta) {
  const def = definicao(chaveCompleta); // erro de programação estoura no boot, não na request
  return async function capabilityMiddleware(req, res, next) {
    if (!ESTADOS_OPERACIONAIS.includes(def.estado)) {
      res.status(501).json({ erro: 'capability_nao_suportada', provider: def.provider, capability: def.capability });
      return;
    }
    let conectado = false;
    try {
      conectado = (await lerConexao(def.provider, { req })) === true;
    } catch {
      conectado = false;
    }
    if (!conectado) {
      res.status(409).json({ erro: 'connector_nao_conectado', provider: def.provider, capability: def.capability });
      return;
    }
    next();
  };
}

module.exports = {
  SUPORTADA,
  DERIVADA,
  PLANEJADA,
  ESTADOS,
  ESTADOS_OPERACIONAIS,
  PROVIDERS,
  CAPABILITIES,
  CapabilityDesconhecidaError,
  chave,
  separar,
  definicao,
  capabilitiesDoProvider,
  capabilityDisponivel,
  readModel,
  requireCapability,
};
