# ORIA — Product Analytics & Connector Architecture

## Status

Documento de implementação para a etapa posterior à produtização-base do Oria.

Este documento NÃO deve transformar a Reserva Ink em dependência estrutural do produto.

A regra central desta fase é:

> Oria é o produto. Reserva Ink, GA4, Meta Ads, WhatsApp e Instagram são integrações conectadas por Organization/Store.

A implementação desta fase deve respeitar a arquitetura multi-tenant já adotada e não reintroduzir conceitos do painel antigo como caminhos especiais para Use Sul, Use Centro, Use Norte, Use Origens ou qualquer outra operação específica.

---

# 1. Contexto

O painel nasceu como ferramenta operacional interna e está sendo produtizado como SaaS.

A arquitetura-base mais recente é:

```text
User
  ↓
Organization
  ↓
Store
  ↓
Integration
  ↓
Provider
```

Uma `Organization` é o tenant.

Uma `Organization` pode possuir uma ou mais `Stores`.

Uma `Integration` pertence obrigatoriamente à Organization e, quando aplicável, também a uma Store.

Exemplos de providers:

```text
Commerce
  ├─ reserva_ink
  ├─ shopify
  ├─ nuvemshop
  └─ woocommerce

Analytics / Event Signals
  ├─ ga4
  ├─ meta_events
  └─ future_provider

Ads
  ├─ meta_ads
  └─ google_ads

Messaging
  ├─ whatsapp_meta
  └─ instagram_meta
```

Não criar vínculo conceitual do tipo:

```text
Oria = painel para Reserva Ink
```

O correto é:

```text
Oria
  └─ Commerce Connector
       └─ Reserva Ink
```

Reserva Ink deve ser apenas o primeiro conector de commerce implementado.

---

# 2. Pré-condição para iniciar esta fase

Esta fase deve ser iniciada apenas quando a produtização-base estiver funcional e validada com uma Organization real.

Antes de implementar Product Analytics, confirmar:

- autenticação funcionando;
- Organization corretamente resolvida;
- Store corretamente resolvida;
- isolamento tenant-scoped;
- IntegrationConnection/Integration equivalente já tenant-scoped;
- secrets por cliente;
- ausência de token global sendo reutilizado entre tenants;
- acesso testado com a loja real do tenant piloto;
- jobs/webhooks tenant-aware;
- nenhuma regra dependente de Use Sul/Centro/Norte;
- nenhuma integração dependente de variáveis de ambiente globais quando o segredo é do cliente.

Não avançar utilizando atalhos que precisem ser removidos posteriormente.

---

# 3. Objetivo desta fase

Criar no Oria uma camada de Product Analytics capaz de unir:

```text
Commerce
Analytics
Ads
```

para responder perguntas como:

- quantas pessoas visualizaram determinado produto;
- quais sinais da jornada vieram de GA4, Meta ou outra fonte;
- quantas adicionaram ao carrinho;
- quantas iniciaram checkout;
- quantas compraram;
- qual receita o produto gerou;
- qual mídia levou tráfego para ele;
- quanto foi gasto em mídia;
- qual CPA;
- qual ROAS;
- futuramente, qual margem/lucro após custo e mídia;
- onde o produto perde conversão;
- quais produtos merecem escala;
- quais precisam de novo criativo, mockup, oferta ou revisão.

A tela não deve conhecer detalhes específicos da Reserva Ink.

Ela deve operar sobre dados normalizados do Oria.

---

# 4. Princípio arquitetural: Connectors por domínio

Não criar uma interface genérica única chamada apenas `IntegrationProvider` com dezenas de métodos opcionais.

Separar contratos por domínio/capability.

Exemplo:

```ts
interface CommerceConnector {
  listProducts(...)
  getProduct(...)
  listOrders(...)
  getOrder(...)
  normalizeProduct(...)
  normalizeOrder(...)
}

interface AnalyticsConnector {
  getProductPerformance(...)
  getEventMetrics(...)
}

interface AdsConnector {
  getCampaignPerformance(...)
  getCreativePerformance(...)
}

interface MessagingConnector {
  ...
}
```

Um provider pode implementar uma ou mais capabilities, mas o domínio deve continuar explícito.

---

# 5. Entidade Integration

Usar a entidade de integração já definida na produtização.

Se ainda não houver estrutura equivalente, o modelo conceitual esperado é:

```ts
type Integration = {
  id: string
  organizationId: string
  storeId?: string | null

  domain:
    | "commerce"
    | "analytics"
    | "ads"
    | "messaging"
    | "ai"

  provider: string

  status:
    | "pending"
    | "connected"
    | "degraded"
    | "error"
    | "disconnected"

  config: Record<string, unknown>

  createdAt: Date
  updatedAt: Date
}
```

Secrets NÃO ficam dentro de `config` em plaintext.

Devem continuar utilizando a estratégia segura definida na produtização.

---

# 6. Reserva Ink

A Reserva Ink deve implementar o contrato de `CommerceConnector`.

Responsabilidades do conector:

```text
INK API
   ↓
InkCommerceConnector
   ↓
Normalização
   ↓
Oria Commerce Domain
```

Nenhuma tela de Product Analytics deve fazer chamadas diretamente para a Ink.

Nenhum service de Product Analytics deve receber `inkToken`.

Nenhum componente React deve saber que o produto veio da Ink além de metadados opcionais para diagnóstico.

---

# 7. Produto normalizado no Oria

Criar um modelo canônico independente do provider.

Exemplo:

```ts
type CommerceProduct = {
  id: string
  organizationId: string
  storeId: string

  provider: string
  providerProductId: string

  name: string
  slug?: string | null
  imageUrl?: string | null
  productUrl?: string | null

  productType?: string | null

  price?: number | null
  promotionalPrice?: number | null

  visible?: boolean | null

  metadata?: Record<string, unknown>

  syncedAt: Date
}
```

O `id` é interno do Oria.

Nunca utilizar `providerProductId` como PK global do sistema.

---

# 8. Variações

Criar entidade separada quando necessário:

```ts
type CommerceProductVariant = {
  id: string
  organizationId: string
  storeId: string

  commerceProductId: string

  provider: string
  providerVariantId: string

  sku?: string | null
  color?: string | null
  size?: string | null
  model?: string | null

  metadata?: Record<string, unknown>
}
```

Isto é importante porque algumas plataformas podem enviar no tracking:

- product id;
- variant id;
- SKU;
- outro content id.

A resolução precisa suportar todos esses formatos sem hardcode da Ink.

---

# 9. Product Identity

Criar uma camada dedicada a resolver:

```text
ID vindo do Analytics
          ↓
Product Identity Resolver
          ↓
Produto interno do Oria
```

Nova estrutura sugerida:

```ts
type ProductExternalIdentity = {
  id: string

  organizationId: string
  storeId: string

  commerceProductId: string

  namespace: string
  externalId: string

  source:
    | "commerce_sync"
    | "analytics_observed"
    | "manual"
    | "rule"

  confidence:
    | "exact"
    | "verified"
    | "inferred"

  lastVerifiedAt?: Date | null
}
```

Exemplos de namespace:

```text
reserva_ink.product_id
reserva_ink.variant_id
sku
ga4.item_id
meta.content_id
nuvemshop.product_id
shopify.product_id
shopify.variant_id
```

Índice único obrigatório:

```text
organization_id
store_id
namespace
external_id
```

Nunca permitir colisão entre tenants.

---

# 10. Estratégia de resolução de identidade

Prioridade:

```text
1. mapping exato já salvo
2. provider product id conhecido
3. provider variant id conhecido
4. SKU
5. mapping manual previamente confirmado
6. candidato para revisão
```

Nome do produto NÃO deve criar associação automática definitiva.

Nome/slug podem gerar sugestão de vínculo, mas não devem virar match silencioso.

Exemplo:

```text
GA4 item_id = 386559
      ↓
namespace = ga4.item_id
      ↓
já existe mapping?
      ↓
SIM → resolve produto
NÃO → tenta IDs conhecidos
      ↓
encontrou relação exata?
      ↓
salva mapping verificado
```

---

# 11. GA4 como Analytics Connector

GA4 deve continuar sendo integração tenant-scoped.

Não reutilizar credenciais ou Property ID de outra Organization.

Modelo conceitual:

```ts
type GA4IntegrationConfig = {
  propertyId: string
  timezone?: string
}
```

Autorização/credentials devem seguir a estratégia de integração já definida na produtização.

O provider GA4 implementa:

```ts
interface ProductAnalyticsProvider {
  getProductPerformance(input: {
    organizationId: string
    storeId: string
    startDate: string
    endDate: string
  }): Promise<ProductAnalyticsRow[]>
}
```

---

# 12. V1: Analytics agregado

A primeira versão NÃO precisa reconstruir a navegação individual de cada usuário.

A V1 deve produzir funil agregado por produto:

```text
Views
Add to cart
Checkout
Purchases
Revenue
```

Exemplo de saída normalizada:

```ts
type ProductAnalyticsRow = {
  analyticsProductId: string

  views: number
  addToCarts: number
  checkouts: number
  purchases: number
  revenue: number

  users?: number
}
```

Depois o Product Identity Resolver converte `analyticsProductId` para o produto interno.

---

# 13. Eventos normalizados

Internamente utilizar nomes independentes do provider:

```ts
type NormalizedCommerceEvent =
  | "product_view"
  | "add_to_cart"
  | "checkout_started"
  | "purchase"
  | "refund"
```

Mapeamento inicial do GA4:

```text
view_item       → product_view
add_to_cart     → add_to_cart
begin_checkout  → checkout_started
purchase        → purchase
refund          → refund
```

O restante do sistema trabalha apenas com os nomes normalizados.

---

# 14. Jornada completa: separar V1 de Event-Level Analytics

Não confundir:

```text
Product Funnel Aggregado
```

com:

```text
Event-Level Customer Journey
```

Para o dashboard inicial, o agregado é suficiente.

Se futuramente quisermos responder:

> "Qual sequência exata de eventos este usuário percorreu?"

ou construir jornadas por sessão/usuário, criar outra capability:

```text
EventAnalyticsConnector
```

Fontes possíveis:

```text
GA4 BigQuery Export
Oria Tracking
Server-side events
outro warehouse
```

Não forçar a Data API a ser uma event store.


---

# 14.1. Jornada multi-source: GA4 + Meta + futuras fontes

A jornada de produto NÃO deve ser modelada como:

```text
GA4
  ↓
Jornada
```

O modelo correto é:

```text
GA4 ──────────────┐
                  │
Meta Pixel/CAPI ──┼─→ Event Normalization Layer
                  │
Oria Tracking ────┤
                  │
Outros providers ─┘
                         ↓
                 Product Identity
                         ↓
                 Deduplication
                         ↓
                 Product Journey
```

GA4 é uma fonte.

Meta pode ser outra fonte.

Nenhuma das duas deve ser estruturalmente obrigatória.

---

# 14.2. Meta possui dois papéis diferentes

Separar explicitamente:

```text
META ADS
```

de:

```text
META EVENTS
```

O primeiro pertence ao domínio Ads:

```ts
interface AdsConnector {
  getCampaignPerformance(...)
  getAdPerformance(...)
  getCreativePerformance(...)
}
```

O segundo pertence ao domínio Analytics/Event Signals:

```ts
interface EventAnalyticsConnector {
  getEvents(...)
  getEventCoverage(...)
}
```

Mesmo que ambos usem APIs/credenciais da Meta, são capabilities diferentes.

Não criar um único `MetaService` usado indiscriminadamente por todos os módulos.

---

# 14.3. Eventos Meta normalizados

Quando o provider disponibilizar esses sinais ao Oria, mapear conceitualmente:

```text
ViewContent       → product_view
AddToCart         → add_to_cart
InitiateCheckout  → checkout_started
Purchase          → purchase
```

Se houver outros eventos relevantes:

```text
Search
Lead
CompleteRegistration
custom events
```

eles podem ser preservados, mas só devem entrar no funil principal quando houver semântica explícita.

Não inferir etapa do funil a partir do nome de evento customizado sem configuração.

---

# 14.4. Evento normalizado precisa guardar proveniência

Não reduzir o evento para apenas:

```text
product_view
```

Persistir ou representar:

```ts
type NormalizedJourneyEvent = {
  id: string

  organizationId: string
  storeId: string

  normalizedType:
    | "product_view"
    | "add_to_cart"
    | "checkout_started"
    | "purchase"
    | "refund"
    | "custom"

  provider:
    | "ga4"
    | "meta"
    | "oria"
    | string

  providerEventName: string

  providerEventId?: string | null

  occurredAt: Date
  receivedAt?: Date | null

  commerceProductId?: string | null

  externalProductId?: string | null
  externalProductNamespace?: string | null

  sessionKey?: string | null
  userKey?: string | null

  orderId?: string | null

  value?: number | null
  currency?: string | null

  sourceMetadata?: Record<string, unknown>
}
```

O restante do domínio usa `normalizedType`.

Diagnóstico e deduplicação continuam tendo acesso à origem.

---

# 14.5. Product Identity continua central

Exemplo observado em evento Meta:

```text
AddToCart
contents[0].id = 386559
```

Isso NÃO deve gerar:

```text
meta content_id = product PK
```

Deve passar pelo mesmo `Product Identity Resolver`:

```text
Meta contents[].id
      ↓
namespace = meta.content_id
      ↓
ProductExternalIdentity
      ↓
CommerceProduct
```

Assim:

```text
GA4 item_id
Meta content_id
Commerce product_id
Commerce variant_id
SKU
```

podem apontar para o mesmo produto interno.

---

# 14.6. Não presumir que GA4 e Meta usam o mesmo ID

Mesmo que no tenant piloto eles coincidam, não transformar isso em regra global.

Exemplo possível:

```text
GA4 item_id        = SKU
Meta content_id    = variant_id
Commerce provider  = product_id
```

O Oria deve resolver todos através de namespaces independentes.

---

# 14.7. Deduplicação é obrigatória

O mesmo comportamento pode ser observado por:

```text
GA4
+
Meta Pixel
+
Meta CAPI
```

Não somar tudo diretamente.

Caso contrário:

```text
1 AddToCart real
```

pode virar:

```text
3 AddToCart
```

no Oria.

Criar uma camada explícita:

```text
Event Deduplication
```

antes de gerar métricas consolidadas.

---

# 14.8. Estratégia de deduplicação

Ordem preferencial:

```text
1. provider event_id explícito
2. order_id para purchase
3. event key já deduplicada pelo provider
4. product + normalized event + session/user + janela temporal
5. manter como eventos distintos quando não houver evidência suficiente
```

Nunca deduplicar agressivamente apenas por:

```text
produto + minuto
```

Isso pode apagar ações reais distintas.

---

# 14.9. Pixel × CAPI

Quando Meta Pixel e Conversions API representarem o mesmo evento, preservar qualquer identificador disponível que permita reconhecer que se trata do mesmo evento lógico.

O domínio do Oria deve assumir:

```text
duas entregas técnicas
≠
duas ações do usuário
```

A implementação específica dependerá dos campos efetivamente disponíveis no conector Meta.

---

# 14.10. Métricas consolidadas precisam declarar a fonte

Exemplo:

```ts
type ProductMetricValue = {
  value: number

  source:
    | "ga4"
    | "meta"
    | "commerce"
    | "consolidated"

  providers?: string[]

  deduplicated?: boolean
}
```

Na UI não é necessário poluir a tabela principal.

Mas no drill-down deve ser possível mostrar:

```text
Origem dos dados

Views
GA4 + Meta

Carrinhos
GA4 + Meta, deduplicados

Compras
Commerce confirmado
```

---

# 14.11. Fonte de verdade por tipo de dado

Adotar como regra conceitual:

```text
Comportamento
→ Analytics/Event Connectors

Mídia
→ Ads Connectors

Venda operacional
→ Commerce Connector
```

Exemplo:

```text
ViewContent / view_item
→ comportamento

AddToCart / add_to_cart
→ comportamento

Ad impression / click / spend
→ Ads

Pedido pago
→ Commerce

Reembolso confirmado
→ Commerce
```

---

# 14.12. Purchase observado não substitui pedido pago

Pode existir:

```text
GA4 purchase
Meta Purchase
Commerce Order Paid
```

Os três podem representar o mesmo resultado, mas possuem papéis distintos.

O Oria deve permitir:

```text
Purchase observado pelo analytics
```

e:

```text
Compra confirmada pelo commerce
```

Não transformar um evento Meta `Purchase` automaticamente em pedido pago.

---

# 14.13. Funil consolidado

O ProductPerformanceService poderá futuramente produzir:

```text
Views
  ↓
Add to carts
  ↓
Checkout started
  ↓
Purchases observed
  ↓
Paid orders confirmed
```

Isso é melhor que esconder a diferença entre tracking e operação.

Exemplo:

```text
Views                  1.840
Add to carts             214
Checkout started           93
Purchases observed         43
Paid orders confirmed      41
```

---

# 14.14. Journey Source Strategy

Permitir configuração por Organization/Store.

Exemplo:

```ts
type JourneySourceStrategy = {
  productViews: string[]
  addToCart: string[]
  checkout: string[]
  purchaseObserved: string[]
  purchaseConfirmed: string[]
}
```

Tenant A:

```text
views        → GA4
add_to_cart  → GA4 + Meta
checkout     → GA4
purchase     → GA4 + Meta
confirmed    → Reserva Ink
```

Tenant B:

```text
views        → Meta
add_to_cart  → Meta
checkout     → Meta
purchase     → Meta
confirmed    → Shopify
```

Não hardcodar uma estratégia única.

---

# 14.15. V1 recomendada para o tenant piloto

Como primeira implementação:

```text
GA4
→ principal fonte comportamental agregada

Meta
→ fonte complementar quando os eventos forem acessíveis de forma confiável

Commerce
→ confirmação operacional
```

A arquitetura deve aceitar Meta desde o início, mesmo que a primeira tela entregue mais métricas via GA4.

Isso evita refatorar o domínio quando o conector de eventos Meta estiver pronto.

---

# 14.16. Diagnóstico por fonte

Na área de integrações/diagnóstico:

```text
Jornada de Produto
```

mostrar algo como:

```text
GA4
view_item          Detectado
add_to_cart        Detectado
begin_checkout     Detectado
purchase           Detectado

Meta
ViewContent        Detectado
AddToCart          Detectado
InitiateCheckout   Detectado
Purchase           Detectado

Commerce
Pedidos pagos      Disponível
Reembolsos         Disponível
```

Também mostrar:

```text
Cobertura de Product Identity
```

por provider.

---

# 14.17. Data quality

Criar indicadores:

```text
event coverage
identity coverage
deduplication coverage
commerce reconciliation
```

Exemplo:

```text
GA4 product identity      98,7%
Meta product identity     99,1%
Meta event dedup coverage 94,2%
Purchase reconciliation   97,8%
```

Não inventar esses percentuais: são métricas calculadas com dados observados.

---

# 14.18. Jornada individual futura

Para uma futura jornada individual:

```text
Impressão Meta
↓
Clique Meta
↓
ViewContent Meta
↓
view_item GA4
↓
AddToCart Meta/GA4
↓
InitiateCheckout
↓
Purchase
↓
Order Paid Commerce
```

não assumir que será possível correlacionar todos os eventos de todos os providers para um mesmo usuário.

Privacidade, identificadores disponíveis, consentimento e limitações de cada API podem impedir a junção completa.

A UI deve distinguir:

```text
jornada observada
```

de:

```text
jornada inferida
```

---

# 14.19. Contratos adicionais

Adicionar/refinar:

```ts
interface EventAnalyticsConnector {
  getEventCoverage(input: EventCoverageInput): Promise<EventCoverage>

  getProductEvents?(
    input: ProductEventQuery
  ): Promise<NormalizedJourneyEvent[]>

  getProductEventAggregates?(
    input: ProductEventAggregateQuery
  ): Promise<ProductEventAggregate[]>
}
```

Capabilities:

```ts
{
  aggregatedProductEvents: true | false,
  eventLevel: true | false,
  productIdentity: true | false,
  eventDedupKeys: true | false
}
```

Um provider pode expor apenas agregados.

Outro pode expor eventos.

O Oria deve funcionar com ambos.

---

# 14.20. Meta Connector não deve ser assumido como event store

A arquitetura deve permitir eventos Meta, mas a implementação NÃO deve assumir que toda conta Meta oferece ao Oria acesso retroativo a cada evento bruto enviado pelo Pixel/CAPI.

O connector deve declarar suas capabilities reais.

Se o provider só disponibilizar métricas agregadas:

```text
aggregatedProductEvents = true
eventLevel = false
```

O Oria usa o agregado.

Se futuramente houver uma ingestão própria/server-side dos eventos:

```text
eventLevel = true
```

A mesma camada de domínio continua válida.

---

# 15. BigQuery como evolução opcional

BigQuery NÃO é requisito da primeira entrega.

Prever apenas a extensão arquitetural.

Futuro:

```text
GA4
  ↓
BigQuery Export
  ↓
GA4BigQueryConnector
  ↓
Normalized Event Store
  ↓
Oria Analytics
```

Usos futuros:

- jornada por sessão;
- coortes;
- tempo entre etapas;
- caminhos antes da compra;
- primeira/última interação;
- auditoria de eventos;
- reconciliação mais profunda.

---

# 16. Commerce como fonte de verdade operacional

Não depender exclusivamente do GA4 para saber se uma venda realmente existe.

Separar conceitos:

```text
Analytics
→ comportamento observado

Commerce
→ operação/transação real
```

O Oria deve conseguir reconciliar:

```text
GA4 purchases
vs
Commerce paid orders
```

Não substituir silenciosamente um pelo outro.

Exibir a origem da métrica quando necessário.

---

# 17. Pedido normalizado

Criar modelo de leitura independente do provider.

```ts
type CommerceOrder = {
  id: string

  organizationId: string
  storeId: string

  provider: string
  providerOrderId: string

  status: string
  paymentStatus?: string | null

  totalValue: number

  createdAt: Date
  paidAt?: Date | null

  items: CommerceOrderItem[]
}
```

```ts
type CommerceOrderItem = {
  commerceProductId: string
  commerceVariantId?: string | null

  quantity: number
  unitValue: number
  totalValue: number
}
```

---

# 18. Camada de Product Performance

Criar um service próprio:

```text
ProductPerformanceService
```

Ele recebe:

```text
organizationId
storeId
period
filters
```

E consulta:

```text
Analytics Connector
Commerce Connector / normalized commerce data
Product Identity Resolver
futuramente Ads Connector
```

Retorno:

```ts
type ProductPerformance = {
  product: CommerceProduct

  views: number
  addToCarts: number
  checkouts: number
  purchasesAnalytics: number

  paidOrders: number
  unitsSold: number

  analyticsRevenue: number
  commerceRevenue: number

  addToCartRate: number
  checkoutRate: number
  purchaseRate: number

  identityStatus:
    | "matched"
    | "partial"
    | "unmatched"

  discrepancies?: {
    purchaseDifference?: number
    revenueDifference?: number
  }
}
```

---

# 19. Métricas

Calcular taxas com denominator explícito.

```text
Taxa de adição
= add_to_cart / product_view

Taxa de checkout
= checkout_started / product_view

Taxa carrinho → checkout
= checkout_started / add_to_cart

Taxa de conversão
= purchases / product_view
```

Não reutilizar o nome "taxa de checkout" para cálculos diferentes.

Tooltips devem informar a fórmula.

---

# 20. Reconciliação GA4 × Commerce

Criar health/status de reconciliação.

Exemplo:

```text
GA4 purchases:        42
Commerce paid orders: 39
Diferença:             3
```

Não classificar automaticamente como erro.

Motivos possíveis incluem:

- atraso de sincronização;
- tracking bloqueado;
- duplicidade;
- diferença de período/fuso;
- cancelamento posterior;
- refund;
- evento purchase faltante;
- ID de produto não resolvido.

Criar status:

```text
healthy
warning
unmatched
insufficient_data
```

---

# 21. Sync de catálogo

Product Analytics não deve consultar todo o catálogo remoto em toda abertura da tela.

Criar sincronização local:

```text
Commerce Provider
     ↓
catalog sync job
     ↓
commerce_products
commerce_product_variants
product_external_identities
```

O dashboard consulta banco local.

Provider é consultado por jobs ou refresh explícito.

---

# 22. Jobs

Todos os jobs devem ser tenant-aware.

Nunca:

```ts
syncInkProducts()
```

Preferir:

```ts
syncCommerceCatalog({
  organizationId,
  storeId,
  integrationId
})
```

E o worker resolve o provider via Integration.

Mesma regra para analytics:

```ts
syncProductAnalytics({
  organizationId,
  storeId,
  integrationId,
  period
})
```

---

# 23. Cache / snapshots

Criar snapshots diários ou agregações se a consulta GA4 começar a ficar cara/lenta.

Modelo possível:

```text
product_metrics_daily
```

Campos:

```text
organization_id
store_id
commerce_product_id
date

views
add_to_carts
checkouts
purchases
revenue

analytics_provider
synced_at
```

Unique:

```text
organization_id
store_id
commerce_product_id
date
analytics_provider
```

---

# 24. Ads: fase posterior

Não misturar a primeira implementação com Meta Ads caso isso aumente demais o escopo.

Mas preparar o modelo.

Futuro:

```text
Creative
  ↓
Ad
  ↓
Campaign
  ↓
Landing/product
  ↓
Product
```

Criar possibilidade de:

```ts
type ProductAdPerformance = {
  spend: number
  impressions: number
  clicks: number

  purchases: number
  revenue: number

  cpa: number
  roas: number
}
```

---

# 25. Unit economics — evolução

Quando houver dados suficientes:

```text
Venda
- custo do produto
- mídia
- descontos
- reembolsos
= contribuição
```

Não implementar custo do produto hardcoded para Ink.

Criar capability futura:

```ts
interface CommerceCostProvider {
  getProductCost(...)
}
```

ou armazenar custo normalizado no domínio Commerce quando o provider disponibilizar.

---

# 26. Tela: Desempenho de Produtos

Criar página no domínio:

```text
MARKETING & DADOS
  └─ Desempenho de Produtos
```

ou respeitar o agrupamento atual equivalente se a navegação já tiver sido consolidada durante a produtização.

Header:

```text
Desempenho de Produtos

Entenda onde cada produto ganha ou perde conversão.
```

Filtros:

- período;
- comparação com período anterior;
- busca por produto;
- tipo;
- qualquer venda / com venda / sem venda;
- status de identity mapping;
- provider;
- mais filtros.

---

# 27. Cards superiores

Sugestão:

```text
Produtos analisados
Views
Adições ao carrinho
Compras
Receita
Conversão média
```

Não lotar a interface.

Usar somente os KPIs mais úteis.

---

# 28. Tabela principal

Colunas:

```text
Produto
Views
Carrinho
Checkout
Compras
Receita
Tx. adição
Tx. carrinho→checkout
Tx. conversão
```

Opcional:

```text
Variação vs período anterior
```

Produto deve conter:

- imagem;
- nome;
- tipo;
- provider apenas quando útil;
- badge de identity issue caso exista.

---

# 29. Drill-down de produto

Ao clicar no produto, abrir drawer ou página detalhada.

Mostrar:

```text
Produto
Imagem
Nome
Commerce provider
ID interno
IDs externos
```

Funil:

```text
Views
 ↓
Carrinho
 ↓
Checkout
 ↓
Compra
```

E gráfico temporal:

```text
views
add_to_cart
purchase
```

Também:

```text
Receita
Pedidos pagos
Unidades vendidas
```

---

# 30. Diagnóstico heurístico

NÃO usar IA na primeira versão para decidir se um produto é bom ou ruim.

Criar regras transparentes.

Exemplo:

```text
muitas views + baixa adição
→ baixo interesse após visualização

boa adição + baixo checkout
→ fricção carrinho → checkout

bom checkout + baixa compra
→ fricção final

baixo volume
→ amostra insuficiente
```

Esses diagnósticos devem ser descritivos, não absolutos.

Não exibir:

```text
"Essa estampa é ruim"
```

Preferir:

```text
"Alta visualização, mas baixa taxa de adição ao carrinho."
```

---

# 31. IA — fase posterior

Depois que as métricas estiverem confiáveis:

```text
Analytics
  ↓
Structured Metrics
  ↓
AI Analysis
```

A IA recebe dados já calculados, não consulta banco livremente.

Exemplo:

```json
{
  "views": 1840,
  "add_to_cart": 214,
  "checkout": 93,
  "purchase": 41,
  "revenue": 4512
}
```

E pode sugerir hipóteses:

- testar outro mockup;
- revisar preço;
- testar novo criativo;
- aumentar distribuição;
- verificar checkout.

Nunca permitir que IA altere campanha ou produto automaticamente nesta fase.

---

# 32. Identity Mapping UI

Criar página ou modal de diagnóstico quando houver IDs não resolvidos.

Exemplo:

```text
ID observado         Origem   Eventos   Status
386559               GA4      382       Não vinculado
SKU-ABC-GG           GA4      91        Vinculado
```

Ações:

```text
Vincular produto
Ignorar
Criar regra
```

Mostrar sugestões de match separadamente.

Nunca persistir um vínculo inferido sem deixar clara sua origem.

---

# 33. Onboarding da integração

Quando um cliente conecta GA4:

1. criar Integration;
2. validar credencial;
3. selecionar Property;
4. testar acesso;
5. verificar disponibilidade de `itemId`;
6. executar diagnóstico de tracking;
7. listar IDs recentes observados;
8. tentar resolver com Commerce;
9. mostrar percentual de cobertura.

Exemplo:

```text
98,4% dos eventos de produto estão vinculados ao catálogo.
```

---

# 34. Tracking diagnostics

Criar health check:

```text
view_item
add_to_cart
begin_checkout
purchase
```

Por evento:

```text
detectado?
possui item_id?
quantos IDs únicos?
último evento?
coverage de mapping?
```

Exemplo:

```text
view_item       OK
add_to_cart     OK
begin_checkout  OK
purchase        sem dados nos últimos 7 dias
```

---

# 35. Multi-tenant

Toda tabela nova deve possuir:

```text
organization_id
```

E quando fizer sentido:

```text
store_id
```

Toda query deve ser tenant-scoped.

Toda FK deve impedir cruzamento entre Organizations.

Todo cache key deve carregar tenant.

Todo job deve carregar tenant.

Todo log relacionado a integração deve carregar:

```text
organization_id
store_id
integration_id
provider
```

---

# 36. Segurança

Nunca logar:

- access token;
- refresh token;
- service account private key;
- client secret;
- webhook secret;
- credencial do provider.

Logs podem mostrar:

```text
integration_id
provider
property_id
store_id
status
```

Tokens devem permanecer criptografados conforme padrão já definido no projeto.

---

# 37. Planos e entitlements

Não atrelar Product Analytics ao plano WhatsApp.

WhatsApp e Instagram continuam products/capabilities independentes.

Product Analytics deve possuir entitlement próprio caso faça parte da estratégia comercial.

Exemplo:

```text
analytics.product_performance
analytics.ga4
analytics.ads
```

Backend valida entitlement.

Não confiar apenas em lock no frontend.

---

# 38. Compatibilidade com os planos atuais

Continuar permitindo combinações independentes:

```text
WhatsApp
Instagram
WhatsApp + Instagram
```

Analytics não deve ser consequência automática de nenhum deles.

Uma futura grade pode ter add-ons/capabilities.

Não redesenhar billing nesta fase; apenas não criar acoplamento que impeça isso.

---

# 39. V1 assistida vs versão final

Manter a decisão da produtização:

```text
V1
→ integração assistida, porém segura

Final
→ self-service profissional
```

Na V1 pode ser aceitável configurar determinadas informações manualmente, desde que:

- pertençam à Organization correta;
- secrets estejam seguros;
- não exista config global compartilhada;
- seja possível migrar para OAuth/fluxo profissional sem alterar o domínio.

---

# 40. Reserva Ink como primeiro Commerce Connector

Implementar algo equivalente a:

```text
src/integrations/commerce/reserva-ink/
```

ou respeitar a arquitetura de diretórios existente.

Separar:

```text
client
adapter
mapper
connector
types
```

Exemplo:

```ts
class ReservaInkCommerceConnector implements CommerceConnector {
  async listProducts(...) {}
  async listOrders(...) {}
  async getProduct(...) {}
  async getOrder(...) {}
}
```

Conversão:

```text
InkProductDTO
   ↓ mapper
CommerceProduct
```

Nunca propagar DTO da Ink para páginas.

---

# 41. GA4 Connector

Estrutura equivalente:

```text
src/integrations/analytics/ga4/
```

Separar:

```text
client
queries
mapper
connector
types
```

O restante do sistema deve consumir apenas interfaces do domínio Analytics.

---

# 42. Provider Registry

Resolver providers centralmente.

Exemplo:

```ts
commerceRegistry.register(
  "reserva_ink",
  ReservaInkCommerceConnector
)

analyticsRegistry.register(
  "ga4",
  GA4AnalyticsConnector
)
```

Evitar:

```ts
if (provider === "reserva_ink") ...
else if (...)
```

espalhado pelos services.

---

# 43. Capabilities

Cada connector declara capabilities.

Exemplo:

```ts
{
  products: true,
  variants: true,
  orders: true,
  productCosts: false,
  refunds: true
}
```

Analytics:

```ts
{
  productMetrics: true,
  eventLevel: false,
  realtime: false
}
```

Assim o Oria adapta recursos sem assumir que todo provider oferece tudo.

---

# 44. Empty states

Se Commerce não estiver conectado:

```text
Conecte uma plataforma de e-commerce para identificar os produtos.
```

Se GA4 não estiver conectado:

```text
Conecte uma fonte de analytics para acompanhar a jornada dos produtos.
```

Se os dois estiverem conectados mas sem mapping:

```text
Encontramos eventos, mas ainda precisamos vincular os IDs aos produtos.
```

Não mencionar Reserva Ink nesses estados genéricos.

---

# 45. Observabilidade

Adicionar métricas técnicas:

```text
connector requests
connector errors
sync duration
records processed
identity matched
identity unmatched
analytics rows imported
reconciliation warnings
```

Todas tenant-scoped.

---

# 46. Auditoria

Registrar ações administrativas como:

```text
integration.connected
integration.disconnected

product_identity.created
product_identity.updated
product_identity.removed

catalog.sync.requested
catalog.sync.completed

analytics.sync.requested
analytics.sync.completed
```

---

# 47. Feature flags

Se necessário, proteger entrega inicial com:

```text
product_analytics
commerce_connectors
analytics_connectors
```

Não criar flags específicas:

```text
use_sul_product_analytics
ink_mode
```

---

# 48. Migração da implementação existente

Antes de criar código novo:

1. localizar integração GA4 existente;
2. localizar acesso Ink existente;
3. identificar chamadas diretas feitas por páginas/services;
4. identificar tokens globais/env;
5. identificar models existentes de Integration;
6. reutilizar o que já foi criado pela produtização;
7. evitar duplicar entidades;
8. mover gradualmente adaptadores para os novos contracts.

Produzir um pequeno mapa:

```text
OLD → NEW
```

antes de alterar código.

---

# 49. Proibição de regressão arquitetural

NÃO fazer:

```text
product_analytics_service → inkService
```

Fazer:

```text
product_analytics_service
        ↓
CommerceConnector interface
        ↓
provider resolver
        ↓
Reserva Ink
```

Mesmo princípio para GA4.

---

# 50. Sequência de implementação recomendada

## Fase A — Audit

- revisar estado atual da produtização;
- localizar integrations/models existentes;
- localizar GA4;
- localizar Ink;
- confirmar tenant isolation;
- escrever plano incremental.

## Fase B — Domain Contracts

Criar/refinar:

- CommerceConnector;
- AnalyticsConnector;
- CommerceProduct;
- CommerceVariant;
- CommerceOrder;
- ProductExternalIdentity;
- ProductPerformance.

Sem UI ainda.

## Fase C — Reserva Ink Adapter

Adaptar a integração atual da Ink para CommerceConnector.

Nenhuma mudança funcional de comportamento além da camada de abstração.

## Fase D — Catalog Sync

Persistir catálogo normalizado e identities.

## Fase E — GA4 Adapter

Adaptar integração atual para AnalyticsConnector.

## Fase F — Identity Resolution

Implementar matching, coverage e tela de pendências.

## Fase G — Product Metrics

Implementar ProductPerformanceService e snapshots.

## Fase H — UI

Implementar:

```text
Desempenho de Produtos
Product Detail
Tracking Diagnostics
Identity Mapping
```

## Fase I — Reconciliation

GA4 × Commerce.

## Fase J — Future

- Meta Ads;
- BigQuery;
- event-level journey;
- custos;
- lucro;
- AI analysis.

---

# 51. Critérios de aceite arquiteturais

A feature só está pronta se:

- nenhuma regra depende de Reserva Ink fora do adapter;
- nova Organization pode conectar seu próprio provider;
- nenhuma credencial é global;
- nenhum tenant consegue acessar produto de outro tenant;
- Product Analytics funciona por interfaces normalizadas;
- IDs externos têm namespace;
- GA4 item IDs podem ser ligados ao catálogo;
- IDs desconhecidos ficam pendentes em vez de gerar associação errada;
- catálogo não é carregado integralmente do provider a cada request;
- jobs são tenant-aware;
- dashboards usam dados tenant-scoped;
- backend valida entitlement;
- WhatsApp/Instagram não foram acoplados a Analytics;
- nenhuma funcionalidade interna da Use Origens virou bypass de produto.

---

# 52. Critérios de aceite da V1

Usando a Organization piloto:

1. conectar Commerce;
2. sincronizar produtos;
3. conectar GA4;
4. ler métricas por item;
5. resolver IDs para produtos;
6. abrir tela de desempenho;
7. visualizar:

```text
views
add_to_cart
checkout
purchase
revenue
```

8. comparar período;
9. abrir detalhe;
10. ver funil;
11. ver pedidos/revenue do Commerce;
12. identificar divergência GA4 × Commerce;
13. nenhuma informação de outro tenant pode aparecer.

---

# 53. Testes

Obrigatórios:

## Unit

- product identity resolver;
- mappers;
- formulas;
- reconciliation;
- capability checks.

## Integration

- provider registry;
- CommerceConnector;
- AnalyticsConnector;
- tenant scoping;
- sync jobs.

## Security

- tenant A não lê tenant B;
- store A não altera store B;
- Integration de outra Organization é rejeitada;
- secret não aparece em response;
- logs não contêm secret.

## UI

- loading;
- empty;
- partial integration;
- unmatched IDs;
- disconnected provider;
- error provider;
- período vazio;
- produto sem vendas;
- produto sem image;
- mobile/responsive.

---

# 54. Paralelismo com múltiplos agentes Claude

Pode haver mais de um agente trabalhando simultaneamente no workspace.

Antes de alterar arquivos:

```text
git status
git diff
```

Regras:

- não apagar mudança não relacionada;
- não restaurar arquivo inteiro sem necessidade;
- fazer commits pequenos;
- limitar alterações ao domínio da tarefa;
- documentar migration/schema changes;
- avisar quando houver conflito arquitetural;
- nunca assumir que uma mudança desconhecida pode ser descartada;
- reutilizar componentes/entities introduzidos por outro agente quando fizer sentido.

---

# 55. Saída esperada do agente antes de implementar

Antes da primeira alteração relevante, devolver:

```text
1. Estado atual encontrado
2. Entidades existentes que serão reutilizadas
3. Pontos de acoplamento Ink atuais
4. Pontos de acoplamento GA4 atuais
5. Schema proposto
6. Contracts propostos
7. Arquivos a criar
8. Arquivos a modificar
9. Riscos
10. Ordem de implementação
```

Se existir decisão arquitetural já documentada no projeto, ela prevalece sobre suposição.

Não reabrir decisões fechadas sem conflito concreto.

---

# 56. Resultado esperado

A arquitetura final deve permitir:

```text
Organization A
  Store A
    Commerce: Reserva Ink
    Analytics: GA4
    Ads: Meta

Organization B
  Store B
    Commerce: Shopify
    Analytics: GA4
    Ads: Meta

Organization C
  Store C
    Commerce: Nuvemshop
    Analytics: outro provider
```

e a mesma tela:

```text
Desempenho de Produtos
```

deve funcionar para todas sem precisar saber qual plataforma de commerce está conectada.

Esse é o objetivo principal desta fase.

---

# 57. Regra final

Sempre que surgir uma decisão entre:

```text
"mais fácil para a Use Sul agora"
```

e:

```text
"correto para qualquer tenant do Oria"
```

priorizar a segunda, desde que não viole uma decisão arquitetural já aprovada no projeto.

A operação atual deve ser utilizada como tenant piloto real, não como exceção estrutural do produto.
