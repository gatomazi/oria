# Product Analytics — Fases E, F, G (rodada noturna)

Registro das decisões realmente tomadas na execução de
`docs/commands/ORIA_RODADA_NOTURNA_PRODUCT_ANALYTICS_E_F_G.md`. Backend only, sem UI, sem push/merge/deploy.
Continua as Fases B→D (`docs/features/product-analytics-phase-a-audit.md`).

## Fase E — GA4 Analytics Adapter

`lib/connectors/analytics/ga4/{client,queries,mapper,token-port,property-repository,connector,index}.js`.

- **Métricas**: `itemsViewed`, `itemsAddedToCart`, `itemsCheckedOut`, `itemsPurchased`, `itemRevenue` — nomes
  da Data API preservados, nunca renomeados para termos genéricos. `itemId` é a identidade; `itemName` é só
  diagnóstico, nunca usado para resolver produto.
- **Diagnóstico antes de assumir**: `getProductMetricCapabilities()` chama `getMetadata` + `checkCompatibility`
  antes de qualquer `runReport`. Métrica incompatível na propriedade nunca é pedida e vira `null` na linha —
  nunca `0` inventado. Sem `itemId` + `itemsViewed` compatíveis, o connector se declara não apto
  (`apt: false`, `reason` estável), nunca um erro genérico.
- **Credencial**: extraí só a troca `refresh_token → access_token`
  (`token-port.js`, sobre `lib/google/http.js`, já genérico) — não o resolver legado
  (`lib/platform/integrations.js`) nem seu fallback de env. Um único access token por chamada ao connector,
  reaproveitado entre metadata + compatibility + todas as páginas do report.
- **`property_id`** continua em `google_analytics_connections` (config da Store), lido por um repositório
  próprio (`property-repository.js`) — nunca migrado para `integrations.config`.
- **Paginação**: `limit`/`offset` até `rowCount` ser coberto; nunca assume que uma página ou 10 mil linhas
  bastam (testado com 12.345 linhas simuladas).
- **`(not set)`/vazio**: nunca vira produto; contabilizado, não descartado em silêncio.
- **Testes**: 73 (mapper, queries, client, token-port, property-repository, connector fim a fim).
- **Smoke real**: `not_run` — sem `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`property_id` piloto disponíveis
  neste ambiente.

## Fase F — Product Identity

Migration `0032`: `product_external_identities` — nativa (como `commerce_products` da Fase D), entra em
`TABELAS_PLATAFORMA`. FK composta para `commerce_products (id, organization_id)`: uma identity não aponta
para produto de outro tenant, garantido pelo banco. `namespace` é aberto (`<provider>.product_id`,
`<provider>.variant_id`, `sku`, `<analyticsProvider>.item_id`), formato validado por CHECK, `id` genérico
proibido.

`lib/product-analytics/product-identity-resolver.js`:

- **Bootstrap** (`bootstrapCommerceIdentities`) a partir do catálogo canônico: `provider_product_id` e
  `provider_variant_id` sempre viram identity; `variant_id` aponta para o PRODUTO, nunca uma entidade própria
  (§5.7 — consequência natural do schema, sem código à parte). SKU só vira identity quando único na Store
  inteira (todos os providers); um SKU que deixou de ser único é removido se foi gerado automaticamente —
  nunca uma identity `manual` (confirmada por humano) é tocada pelo bootstrap.
- **Resolução** (`resolveExternalIds`) — só leitura, ordem fixa: mapping existente → `product_id` exato →
  `variant_id` exato → `sku` exato → `unresolved`. Nunca fuzzy: não há comparação de nome/slug no módulo
  inteiro, então não existe "quase igual" para acionar por engano. Mais de um candidato em qualquer passo é
  `conflict`, nunca escolhido.
- **Persistência** (`persistRuleMatches`/`resolveAndPersist`) só do que resolveu por regra determinística,
  `source: 'rule'`, `confidence: 'exact'`, `ON CONFLICT DO NOTHING`.
- **Coverage** (`computeCoverage`) pura: `observed = 0` → `coverageRate: null`, `status: 'insufficient_data'`,
  nunca 100% inventado.
- **Testes**: 21 (schema RLS/FK/unique, bootstrap produto/variante/SKU único/duplicado/revertido, resolução
  nas 4 vias + conflito + unresolved, idempotência, coverage, isolamento, 3 negative controls de FK/UNIQUE/CHECK).

## Fase G — Product Performance Service

`lib/product-analytics/{commerce-catalog-repository,product-performance-service}.js`. Depende só da tríade
abstrata (repositório do catálogo já sincronizado, `AnalyticsConnector` via registry, `ProductIdentityResolver`)
— nunca do connector Ink, de um client GA4 concreto, ou de `pedidos_ink`. Reconciliação com pedidos Commerce
fica de fora nesta rodada: o `CommerceConnector` novo ainda não tem `orders`.

- **1 chamada de analytics** por request ao service, independente do tamanho do catálogo (testado com 1.000
  produtos, ainda 1 chamada por página do service).
- **Zero vs ausente** (§6.8): identity já resolvida antes, sem linha no período → zero real. Sem identity
  nenhuma → `metrics: null` + `unmatched_identity`. As duas nunca se confundem.
- **Métrica indisponível na propriedade inteira** (nenhuma linha observada trouxe valor) → `null` +
  `metric_unavailable`, nunca 0.
- **Múltiplos external ids no mesmo produto** (product id + variant id + SKU, por exemplo) → soma, com
  `multiple_analytics_identities`; nenhuma deduplicação inventada entre ids diferentes.
- **Rates** só com denominador > 0; `null` caso contrário — nunca `Infinity`/`NaN`.
- **Sem classificação opinativa** (CAMPEÃ/OPORTUNIDADE/…) — só os quatro diagnósticos objetivos do comando.
- **Ordenação**: por campo de catálogo pagina no banco; por métrica/rate opera só sobre o conjunto com
  identity resolvida (nunca o catálogo inteiro em memória).
- **Testes**: 16 (validação, dataset vazio, 1 query/N produtos, 1000 produtos sem N+1, agrupamento de ids,
  unmatched, conflito, zero vs ausente, rates, métrica ausente, sem classificação opinativa, sort por
  métrica/catálogo, isolamento de Organization/provider, guarda estática).

## Decisões locais registradas

- `getProductMetricCapabilities()` é um método extra do connector GA4, fora do contrato formal
  `AnalyticsConnector` — `ProductPerformanceService` não depende dele; deriva "métrica indisponível" só do
  contrato (`null` nas linhas devolvidas), o que mantém o service genuinamente provider-agnostic.
- Namespace de analytics genérico adotado: `<analyticsProvider>.item_id` (ex.: `ga4.item_id`), consistente
  com os namespaces de commerce já fixados na Fase F.
- SKU é identity **store-wide** (todos os providers), não por provider — decisão explícita, documentada no
  código (`product-identity-resolver.js`).

## Suite completa (gate final da rodada)

117 arquivos, 2 shards sem banco + 4 com banco (mesmo particionamento do CI), rodados em paralelo nesta
máquina: **1.608 testes, 0 falhas**. `repo:self-check`, `contracts:check` e `suites verify` OK.
