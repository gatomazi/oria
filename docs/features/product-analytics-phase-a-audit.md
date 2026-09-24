# Product Analytics & Connectors — Fase A (Audit)

Saída exigida por `ORIA_PRODUCT_ANALYTICS_CONNECTOR_ARCHITECTURE_V2.md` §55 e §48 (mapa OLD → NEW).
Somente leitura: nenhum arquivo de código foi alterado. Base: `main` + branch `fix/clientes-chave-unica`
(HEAD `5537e7e`), painel em `apps/panel`.

## 1. Estado atual encontrado

- **Backend do painel é um monólito JS CommonJS**: `apps/panel/server.js` (16.7 mil linhas) + módulos em
  `apps/panel/lib/*`. Frontend é SPA React/TS em `apps/panel/src`. O doc V2 fala em TypeScript
  (`src/integrations/commerce/reserva-ink/`); no backend isso vira JS com JSDoc. Não há camada TS no servidor.
- **Multi-tenant pronto**: `organizations`, `stores` (com `loja_legada` só como compatibilidade), RLS, role
  `oria_app`, `store_id` composto `(store_id, organization_id) → stores` em pedidos, catálogo Ink, GA4, mídia,
  campanhas (migrations 0003–0030).
- **Uma Organization efetiva em produção** (Use Sul, Store nativa). Isolamento entre Organizations é coberto por
  testes (`tenancy-isolation`, negative controls), não exercido em produção (checkpoint 2026-09-21 §4).
  → Pré-condição §2 do doc só parcialmente comprovada.
- **Integrações**: tabela `integrations` é por `(organization_id, provider, escopo)` — **uma por Organization e
  provider**, sem `store_id` nem `domain` (correto: a integração é da Organization; ver PD-002/`ORIA-TENANCY-STORE-01`). Segredos em `integration_secrets` via keyring (`lib/platform/integrations.js`).
  Providers hoje: `ink`, `ga4`, `meta`, `google_ads`, `openai`, `whatsapp`.
- **Registry de capabilities** existe (`lib/platform/connector-capabilities.js`) mas só conhece `ink`
  (`ink.orders`, `ink.products`…). Não há registry de connectors por domínio.
- **Entitlements**: `analytics_ga4` existe e está `sem_guard`. Não existem `analytics.product_performance` nem
  `analytics.ads`.
- **Jobs**: `lib/platform/jobs.js` (`createJobRunner`) + `leases.js` — reutilizável para sync tenant-aware.

## 2. Entidades existentes que serão reutilizadas

| Existente | Uso no V2 |
|---|---|
| `organizations`, `stores` | tenant/loja (sem mudança) |
| `integrations` + `integration_secrets` + `createIntegrationResolver` | resolver credencial do connector |
| `google_analytics_connections` (por Store, `property_id`) | config do GA4 connector (propertyId) |
| `ga4_performance_cache` | padrão de cache; **não** serve para item-level (chave é UTM) |
| `produtos_ink` / `produtos_ink_sync` (`store_id`) | fonte do mapper Ink → `commerce_products` |
| `pedidos_ink` / `pedidos_ink_itens` (`produto_id`, `sku`, `modelo`, `cor`, `tamanho`, `quantidade`, `valor_venda`) | receita/pedidos por produto no Commerce, sem nova chamada à Ink |
| `lib/meta/insights.js` (`view_content`, `add_to_cart`, `initiate_checkout`, `purchases`) | só agregado de campanha/anúncio, **não** por produto — fica para Ads/Fase J |
| `lib/platform/jobs.js`, `leases.js`, `audit.js` | jobs e auditoria (§46) |
| `entitlements.js` (`FEATURES`) | adicionar chave própria de Product Analytics |

## 3. Pontos de acoplamento Ink atuais

- `server.js:90` `INK_API_BASE` hardcoded; `server.js:505-541` `inkRequisitar`/`inkApiRequestDaStore`/`inkApiPost…`.
- ~40 handlers em `server.js` chamam `inkApiRequestDaStore('/v1/stores/…')` direto (pedidos 989/1068/1991/2035,
  trocas 2081-2152, reembolsos 2179-2227, produtos 2287/2366/2698, categorias, promoções, carrinhos 1491).
- Catálogo e pedidos vivem em tabelas nomeadas por provider (`produtos_ink`, `pedidos_ink*`) e com `produto_id
  BIGINT` como ID do provider.
- Fallback legado por env `INK_TOKEN_<LOJA>` / `INK_FEED_URL_<LOJA>` atrás de `ALLOW_LEGACY_INTEGRATION_ENV`
  (`lib/platform/integrations.js`). Token por tenant já é o caminho principal; o env é dívida com flag.
- Capabilities só de Ink (`ink.*`); FEATURES `catalog`, `exchanges`, `refunds` "em transição" (docs/architecture/features-vs-connectors.md).
- **Nenhuma tela de Product Analytics existe**, então nada novo precisa tocar `inkService`; o risco é o
  `ProductPerformanceService` novo nascer chamando `inkApiRequestDaStore` por atalho (§49).

## 4. Pontos de acoplamento GA4 atuais

- Um único uso de Data API para relatório: `buscarPerformanceGA4Bruto` (`server.js:9616`) e
  `buscarSerieDiariaGA4` (`~9752`) — ambos em dimensões `sessionManual*` (UTM Tracker). **Nenhuma consulta
  item-level hoje** (`itemId`, `itemsViewed`, `itemsAddedToCart`, `itemsCheckedOut`, `itemsPurchased`,
  `itemRevenue`; nomes a validar contra o schema da Data API antes de codar).
- Conexão/OAuth/token misturados no monólito: `obterConexaoGA4`, `obterAccessTokenValidoGA4`,
  `accessTokenGoogle('ga4', …)`, `googleFetchLeitura`, `erroGoogle`. Tudo Store-scoped e sem token global.
- Período no formato do GA4 (`7daysAgo`…) e `resolverPeriodoGA4` — não é contrato de domínio (o doc quer
  `startDate/endDate` ISO).
- Consolidado financeiro já usa GA4 (`lib/financeiro/consolidado.js`).

## 5. Schema proposto (migrations 0031+, forward-only, todas com `organization_id` + FK composta de Store + RLS)

| Tabela | Chave | Observação |
|---|---|---|
| `commerce_products` | `(organization_id, id)`; único `(organization_id, store_id, provider, provider_product_id)` | PK interna própria; `provider_product_id` **TEXT** (não BIGINT) |
| `commerce_product_variants` | `(organization_id, id)`; único por `provider_variant_id` | FK → `commerce_products` |
| `product_external_identities` | único `(organization_id, store_id, namespace, external_id)` | `source` e `confidence` conforme §9 |
| `product_metrics_daily` | único `(organization_id, store_id, commerce_product_id, date, analytics_provider)` | §23, só quando a consulta ficar cara |
| `commerce_orders` / `_items` | **adiado** | V1 reaproveita `pedidos_ink*` via mapper (ver §7 abaixo) |

`produtos_ink` **não** é renomeada nem alterada: continua como cache do adapter Ink usado por Produtos/Categorias.
`commerce_products` é populada por mapper a partir dela (e, no futuro, de outros providers).

## 6. Contracts propostos

```text
apps/panel/lib/connectors/
  registry.js                      # register/resolve por (domain, provider); sem if (provider === …) nos services
  contracts.js                     # JSDoc: CommerceConnector, AnalyticsConnector, EventAnalyticsConnector, AdsConnector
  commerce/reserva-ink/{client,mapper,connector,index}.js
  analytics/ga4/{client,queries,mapper,connector,index}.js
apps/panel/lib/product-analytics/
  identity-resolver.js  performance-service.js  reconciliation.js  metrics.js  heuristics.js
```

- Connector recebe `{ organizationId, storeId }` e resolve segredo via `createIntegrationResolver`; nunca recebe token.
- Cada connector declara `capabilities` (§43). GA4: `{ productMetrics: true, eventMetrics: false, realtime: false }`.
- Eventos normalizados: `product_view | add_to_cart | checkout_started | purchase | refund` (§13).
- `ProductPerformanceService` consome só interfaces + `product_external_identities`; nunca `inkApiRequestDaStore`.

## 7. Arquivos a criar / modificar

**Criar (Fases B–I):** conforme árvore do §6; migrations 0031 (`commerce_*`), 0032 (`product_external_identities`),
0033 (`product_metrics_daily`, se necessário); rotas `GET /api/admin/product-analytics/*` (em módulo próprio, não
inflando mais o `server.js`); páginas `src/pages/desempenho-produtos/*` (Fase H); testes de invariantes
(`test/invariants/product-analytics-*.test.js`) + negative controls tenant-scoped.

**Modificar (mínimo):** `server.js` (montar rotas e registrar connectors; extrair a leitura GA4 reutilizável
sem mudar comportamento do UTM Tracker), `lib/platform/entitlements.js` + migration de seed (chave própria),
`lib/platform/connector-capabilities.js` (aceitar provider `ga4`), `lib/platform/integrations.js` (se o domínio
precisar ser lido), navegação SPA (Marketing & Dados).

## 8. Mapa OLD → NEW (§48)

| OLD | NEW |
|---|---|
| `inkApiRequestDaStore('/v1/stores/products…')` nos handlers | `ReservaInkCommerceConnector.listProducts` (handlers antigos seguem intactos na Fase C) |
| `produtos_ink` (cache Ink-shaped) | mantido; mapper → `commerce_products` |
| `pedidos_ink_itens.produto_id` | fonte de `paidOrders/unitsSold/commerceRevenue` via `CommerceConnector`/read model |
| `buscarPerformanceGA4Bruto` (UTM) | intacto; nova query item-level em `analytics/ga4/queries.js` reusando `obterAccessTokenValidoGA4`/`googleFetchLeitura` |
| `resolverPeriodoGA4` (`7daysAgo`) | contrato de domínio usa `startDate/endDate` ISO; conversão só no adapter |
| `analytics_ga4` (sem guard) | entitlement `analytics.product_performance` com guard real no backend |
| `ink.*` capabilities | mantidas; connectors por domínio declaram as próprias |

## 9. Riscos

1. ~~`integrations` é 1 por (Organization, provider), sem `store_id`.~~ **Superado (2026-09-21):** `ORIA-TENANCY-STORE-01`
   (`productization-decisions.md`, PD-002) — 1 Organization = 1 Store, definitivo. A integração é da Organization; a Store é
   contexto operacional; `integrations` não ganha `store_id`. O GA4 continua com a credencial na Organization e o `property_id`
   em `google_analytics_connections`.
2. **Só uma Organization em produção**: isolamento é provado por teste. Exige controles negativos novos (tenant A não lê B).
3. **`produto_id BIGINT`** herdado da Ink vs `provider_product_id TEXT` do canônico: mapper precisa converter sem perda.
4. **Histórico local de pedidos só desde 2026-08-19** (checkpoint §7): reconciliação GA4 × Commerce fora dessa janela seria falsa
   divergência. Precisa aparecer como `insufficient_data`, não `warning`.
5. **Cota/latência da Data API** com `itemId` em catálogo grande (Ink tem ~85 mil produtos): usar `limit` + `orderBys` e
   snapshot diário; nunca 1 request por linha.
6. **Nome do produto nunca é match automático** (§10). Coberturas de identity serão reais e provavelmente baixas no início.
7. **Meta como fonte de eventos** não é assumível como event store: V1 só declara a capability.
8. **`server.js` já tem 16.7 mil linhas**: código novo em módulos, sem crescer o monólito.
9. **Paralelismo**: working tree tem docs não rastreados de outras frentes; não tocar.

## 10. Ordem de implementação (§50)

A. Audit (este doc) → B. Contracts + registry + testes de contrato (sem UI, sem migration) → C. Adapter Ink (sem mudança de
comportamento) → D. Migrations `commerce_*` + catalog sync tenant-aware → E. Adapter GA4 item-level → F. Identity resolver + cobertura →
G. `ProductPerformanceService` + snapshots → H. UI (Desempenho de Produtos, detalhe, diagnóstico, mapping) → I. Reconciliação.
Cada fase: commit pequeno, CI verde, negative controls tenant-scoped. UI só fecha com smoke no Claude in Chrome.

## Decisões tomadas depois deste audit

1. Backend em JS + JSDoc em `apps/panel/lib/connectors/` (sem TypeScript no backend).
2. `ORIA-TENANCY-STORE-01`: 1 Organization = 1 Store, definitivo. Sem `store_id` em `integrations`; a Store é contexto operacional.
3. Connector declara `requiresStoreContext` (boolean, sem default); commerce e analytics sempre `true`.
4. Entitlement `analytics_product_performance` (underscore, como as demais chaves), ainda não criado.
