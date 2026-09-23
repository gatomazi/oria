# ORIA — Rodada Noturna Product Analytics
## Fases E → F → G (backend only)

> Execução autônoma, sem UI, sem push, sem merge, sem deploy.
>
> Base arquitetural já fechada:
>
> - 1 Organization = 1 Store, definitivo.
> - Integration ownership = Organization.
> - `storeId` = contexto operacional validado.
> - Reserva Ink = CommerceConnector.
> - GA4 = AnalyticsConnector.
> - Meta Ads e Meta Events = domains distintos.
> - `server.js`, handlers legados e `produtos_ink` não devem ser migrados nesta rodada.
> - Fases B, B.1, C e D já concluídas e commitadas.
> - Catálogo canônico existente em `commerce_products` / `commerce_product_variants`.
> - Nenhum segredo em ConnectorContext ou ResolvedIntegration.
> - Connector Secret Port usa callback de uso imediato.
> - Nenhum fallback legado de env nos connectors novos.

---

# 0. OBJETIVO DA RODADA

Avançar autonomamente pelas próximas fundações de Product Analytics:

```text
Fase E
GA4 Analytics Adapter
        ↓
Fase F
Product Identity
        ↓
Fase G
Product Performance Service
```

Encerrar a rodada antes de:

```text
UI
Meta Events
Meta Ads attribution
Commerce reconciliation definitiva
AI diagnosis
billing/plan redesign
push
merge
deploy
```

A rodada deve produzir backend confiável, tenant-safe e provider-agnostic suficiente para que a próxima sessão comece pela UI/integração operacional, não por fundações.

---

# 1. REGRAS DE EXECUÇÃO NOTURNA

Não pedir confirmação entre E, F e G se os gates descritos abaixo estiverem verdes.

Pode tomar decisões locais de implementação quando:

- respeitarem os contracts existentes;
- não mudarem invariantes de tenancy;
- não criarem dependência específica da Ink fora do adapter;
- não criarem dependência específica do GA4 fora do adapter;
- não exigirem mudança destrutiva;
- não exigirem mudança de billing/produto;
- não alterarem o significado de dados já persistidos.

Se surgir dúvida estética, naming não estrutural ou detalhe interno reversível:

```text
decida
documente
teste
continue
```

Não interromper a rodada por perguntas pequenas.

---

# 2. STOP CONDITIONS

Parar a rodada e produzir relatório parcial caso qualquer uma destas condições apareça:

1. necessidade de migration destrutiva;
2. necessidade de remover/afrouxar `UNIQUE (organization_id)` de Store;
3. necessidade de tornar Integration Store-owned;
4. necessidade de colocar secret em ConnectorContext/ResolvedIntegration;
5. necessidade de usar token/env global no connector novo;
6. conflito real com RLS/tenant isolation que exija redesenho;
7. Data API real contradizer os nomes/semântica fundamentais usados no contrato;
8. necessidade de fuzzy-match automático de produto;
9. necessidade de modificar `server.js` em grande escala;
10. necessidade de alterar handlers legados Ink;
11. necessidade de tocar billing/plan sem decisão anterior;
12. testes existentes revelarem uma regressão arquitetural real que não possa ser corrigida localmente.

Não parar apenas porque:

- credenciais reais do GA4 não estão disponíveis no ambiente;
- a propriedade real não tem dados no período;
- o smoke real não pode ser executado;
- há warnings de lint não relacionados;
- documentos não rastreados de outras frentes existem.

Nesses casos:

```text
registre a limitação
mantenha testes com fakes
continue
```

---

# 3. PRIMEIRO PASSO

Antes de alterar qualquer arquivo:

```bash
git status
git log --oneline -12
git diff
```

Confirmar:

- branch correta;
- working tree tracked limpo;
- commits B→D presentes;
- docs não rastreados de outras frentes não devem ser tocados;
- migrations atuais terminam em 0031.

Rodar baseline direcionado antes da Fase E:

- connectors contracts/registry;
- integration port;
- secret port;
- Ink connector;
- catalog sync;
- tenancy/invariants relacionados.

Não precisa repetir a suíte completa de 1.497 testes antes de começar: ela já fechou verde na Fase D.

---

# 4. FASE E — GA4 ANALYTICS ADAPTER

## 4.1 Objetivo

Implementar:

```text
lib/connectors/analytics/ga4/
├── client.js
├── queries.js
├── mapper.js
├── connector.js
└── index.js
```

sem UI e sem persistência de métricas nesta fase.

O connector deve implementar o `AnalyticsConnector` existente.

---

# 4.2 Fonte e API

Usar Google Analytics Data API `v1beta`.

Para relatórios simples, usar:

```text
properties.runReport
```

Antes de assumir que a propriedade aceita as dimensões/métricas desejadas, implementar suporte a diagnóstico via:

```text
properties.getMetadata
properties.checkCompatibility
```

Não usar API alpha quando a capability necessária existir em v1beta.

---

# 4.3 Métricas confirmadas

Os nomes atuais confirmados pela documentação oficial da Data API são:

```text
Dimension:
itemId
itemName

Metrics:
itemsViewed
itemsAddedToCart
itemsCheckedOut
itemsPurchased
itemRevenue
```

Também existe:

```text
itemViewEvents
```

com semântica diferente.

IMPORTANTE:

```text
itemsViewed
itemsAddedToCart
itemsCheckedOut
itemsPurchased
```

são métricas de ITENS/UNIDADES, não necessariamente usuários únicos nem contagem pura de eventos.

Não renomear silenciosamente a semântica dentro do adapter.

O retorno normalizado deve preservar essa distinção.

---

# 4.4 Contract de Product Metrics

Se o `AnalyticsConnector` atual só expõe algo genérico como:

```text
getProductPerformance(...)
```

pode mantê-lo.

O retorno normalizado deve ser conceitualmente equivalente a:

```js
{
  externalProductId,
  externalProductName,

  itemsViewed,
  itemsAddedToCart,
  itemsCheckedOut,
  itemsPurchased,
  itemRevenue,

  analyticsProvider: "ga4"
}
```

Não usar `itemName` como identidade.

Identidade primária:

```text
itemId
```

`itemName` é apenas diagnóstico/display.

---

# 4.5 Query principal

Query:

```text
dimension:
itemId
```

Opcionalmente:

```text
itemName
```

se a combinação for compatível e não aumentar desnecessariamente cardinalidade.

Metrics:

```text
itemsViewed
itemsAddedToCart
itemsCheckedOut
itemsPurchased
itemRevenue
```

Date range recebido pelo domínio em ISO:

```text
startDate
endDate
```

Conversão para formato da Data API fica somente no adapter, caso necessária.

Não permitir períodos relativos tipo `7daysAgo` vazarem para o domain contract.

---

# 4.6 Compatibilidade

Criar diagnóstico equivalente a:

```text
getProductMetricCapabilities()
```

ou método interno adequado.

Ele deve verificar:

- `itemId` disponível;
- métricas desejadas disponíveis;
- compatibilidade da combinação;
- quais métricas podem ser usadas na propriedade.

Se uma métrica opcional não for suportada:

```text
não inventar zero
```

Retornar capability/availability.

Se a query fundamental `itemId + itemsViewed` não puder existir:

```text
connector não está apto para Product Analytics
```

e isso deve ser representado de forma estável.

---

# 4.7 Property ID

Não mover `property_id`.

Continuar:

```text
Integration(provider=ga4)
→ credencial da Organization

google_analytics_connections
→ property_id/configuração da Store
```

O GA4 connector pode consultar a configuração da Store através de uma porta/repository pequeno e explícito.

Não importar `server.js`.

Não duplicar `property_id` em `integrations.config` só para facilitar o connector.

---

# 4.8 Credencial

Reutilizar a infraestrutura segura existente.

Se hoje a renovação de access token estiver presa a helpers de `server.js`, extrair a menor camada reutilizável necessária.

O connector:

```text
não recebe access token como argumento
não armazena access token
não loga access token
não usa env fallback
```

Se for necessário criar/usar uma porta equivalente para Google auth, manter a separação:

```text
connector
↓
auth/token port
↓
infra Google existente
```

Não importar `server.js`.

---

# 4.9 Paginação GA4

A Data API usa:

```text
limit
offset
rowCount
```

para paginação de relatórios.

Não assumir limite de 10k como total.

A implementação deve:

```text
request page
process rows
advance offset
stop when rowsReceived >= rowCount
```

Pode usar um page size grande e seguro, sem exceder o máximo aceito pela API.

Não fazer uma chamada por produto.

É:

```text
1 report agregado por itemId
```

e não:

```text
N reports por commerce product
```

---

# 4.10 Quota

Solicitar `returnPropertyQuota` quando útil para diagnóstico/observabilidade, sem tornar isso requisito funcional.

Não fazer refresh agressivo.

Não implementar cache persistente ainda se isso exigir antecipar a Fase G.

---

# 4.11 Parsing

GA4 retorna valores como strings.

Parsear:

```text
inteiros
monetários
```

explicitamente.

Não permitir:

```text
NaN
Infinity
negative count inesperado
```

passar silenciosamente.

Receita:

```text
number decimal
```

com validação consistente com o restante do projeto.

Se houver risco de precisão monetária no padrão atual, seguir a convenção existente do backend e documentar.

---

# 4.12 Empty / "(not set)"

`itemId` vazio ou `(not set)`:

```text
não mapear para produto
```

Pode ser devolvido separadamente como unmapped diagnostic ou ignorado da lista principal, desde que contabilizado em coverage/diagnóstico quando possível.

Nunca criar identity com:

```text
external_id = "(not set)"
```

---

# 4.13 Smoke real GA4

Se as credenciais e `property_id` do tenant piloto estiverem disponíveis no ambiente de execução, fazer SOMENTE leitura:

1. metadata;
2. compatibility;
3. query curta, período pequeno;
4. sample de `itemId`.

Não alterar configuração real.

Não criar dados no GA4.

Não depender desse smoke para a suíte.

Se não houver acesso real:

```text
real_smoke = not_run
reason = credentials/environment unavailable
```

e continuar.

---

# 4.14 Testes E

Cobrir:

- descriptor analytics/ga4;
- requiresStoreContext;
- property pertence à Store;
- credencial tenant-bound;
- sem secret/token no retorno;
- metadata;
- compatibility;
- query correta;
- itemId;
- itemName diagnóstico;
- todas as métricas;
- métrica ausente;
- query incompatível;
- paginação limit/offset;
- mais de 10k rows simuladas;
- `(not set)`;
- empty dataset;
- 401;
- 403;
- 429;
- 5xx;
- timeout/network;
- parsing;
- nenhuma query por produto;
- nenhum import de `server.js`;
- nenhum `process.env` no connector;
- nenhuma dependência Ink.

---

# 4.15 Gate E

Rodar:

- testes GA4 connector;
- contracts;
- registry;
- integration/auth/secret related;
- static checks;
- repo:self-check.

Se verde:

```text
commit
feat(panel): add GA4 product analytics connector
```

Pode separar extração de infraestrutura Google em commit anterior se for pequena e semanticamente independente.

---

# 5. FASE F — PRODUCT IDENTITY

Só iniciar se Gate E estiver verde.

## 5.1 Objetivo

Criar:

```text
product_external_identities
ProductIdentityResolver
coverage/diagnostics
```

sem UI.

Migration esperada:

```text
0032_product_external_identities
```

---

# 5.2 Schema

Tabela conceitual:

```text
id UUID PK

organization_id UUID NOT NULL
store_id UUID NOT NULL

commerce_product_id UUID NOT NULL

namespace TEXT NOT NULL
external_id TEXT NOT NULL

source TEXT NOT NULL
confidence TEXT NOT NULL

last_verified_at
created_at
updated_at
```

FK tenant-safe para:

```text
commerce_products
```

Unique:

```text
organization_id
store_id
namespace
external_id
```

RLS forced.

Não permitir identity de Organization A apontar para product B.

---

# 5.3 Namespaces iniciais

Usar namespaces explícitos e estáveis.

Exemplo:

```text
reserva_ink.product_id
reserva_ink.variant_id
sku
ga4.item_id
```

Não criar namespace genérico `id`.

Se já houver convenção melhor no código, use-a, mas mantenha a distinção semântica.

---

# 5.4 Bootstrap de identities do Commerce

A partir do catálogo canônico, gerar/reconciliar identities conhecidas:

Produto:

```text
provider product id
```

Variante:

```text
provider variant id
```

SKU:

```text
sku
```

SKU só pode ser identity automática quando for unívoca dentro da Store/contexto relevante.

Se o mesmo SKU mapear para mais de um produto:

```text
não criar mapping automático
```

Registrar conflito.

---

# 5.5 Resolução GA4

Para cada:

```text
ga4.item_id
```

ordem:

```text
1. mapping ga4.item_id já existente
2. match exato com provider product id
3. match exato com provider variant id
4. match exato com SKU único
5. unresolved
```

Nunca fuzzy name.

Nunca slug similarity.

Nunca Levenshtein.

Nunca "parece o mesmo produto".

`itemName` serve apenas para diagnóstico manual.

---

# 5.6 Persistência automática

Se houver exatamente UM match determinístico:

```text
pode persistir ga4.item_id
```

com source/confidence coerentes.

Exemplo:

```text
source = rule
confidence = exact
```

ou nomenclatura equivalente definida no schema.

Se houver mais de um candidato:

```text
conflict
```

Não escolher.

Se nenhum:

```text
unresolved
```

Não criar linha falsa.

---

# 5.7 Variant → Product

Se `ga4.item_id` bater com `provider_variant_id` ou SKU de variante:

```text
ga4.item_id
→ variant
→ commerce_product_id
```

A identity final pode apontar para o produto canônico, preservando no metadata/source como foi resolvida se necessário.

Não criar um segundo produto canônico para variante.

---

# 5.8 Coverage

Criar service/função que produza:

```text
observedItemIds
matchedItemIds
unmatchedItemIds
conflictedItemIds
coverageRate
```

Coverage:

```text
matched / observed
```

com denominator > 0.

Não inventar 100% em dataset vazio.

Dataset vazio:

```text
coverage = null
status = insufficient_data
```

---

# 5.9 Sample diagnóstico

Se o smoke real da Fase E trouxe itemIds:

- tentar resolver sample;
- documentar exemplos sem expor PII;
- confirmar se o tenant piloto parece usar product_id, variant_id, SKU ou outro padrão.

Isso é diagnóstico, não regra global.

Não hardcodar o padrão do tenant piloto.

---

# 5.10 Testes F

Cobrir:

- RLS;
- FK cross-tenant;
- unique namespace/external_id;
- bootstrap provider product;
- bootstrap provider variant;
- SKU único;
- SKU duplicado;
- GA4 existing mapping;
- product id exact;
- variant id exact;
- SKU exact;
- conflito;
- unresolved;
- itemName nunca resolve sozinho;
- tenant isolation;
- provider collision;
- idempotência;
- re-run não duplica identity;
- coverage;
- empty coverage;
- variant → product.

---

# 5.11 Gate F

Rodar:

- migration tests;
- identity tests;
- tenancy invariants;
- negative controls;
- connector tests;
- repo:self-check.

Se verde:

```text
commit
feat(panel): add product identity resolution
```

Pode separar schema/resolver em dois commits se fizer sentido.

---

# 6. FASE G — PRODUCT PERFORMANCE SERVICE

Só iniciar se Gate F estiver verde.

## 6.1 Escopo da G nesta rodada

Criar o backend service canônico que une:

```text
commerce_products
+
GA4 product metrics
+
ProductIdentityResolver
```

SEM ainda afirmar reconciliação completa com pedidos Commerce.

Motivo:

```text
CommerceConnector.orders ainda não está implementado no contrato Ink novo
```

Não criar atalho para `pedidos_ink*` dentro de ProductPerformanceService.

Reconciliation GA4 × Commerce fica para fase posterior quando houver uma porta/capability Commerce apropriada.

---

# 6.2 Service

Criar:

```text
lib/product-analytics/product-performance-service.js
```

ou nomenclatura coerente.

Dependências:

```text
Commerce catalog repository
AnalyticsConnector
ProductIdentityResolver
```

Nunca:

```text
ReservaInkConnector direto
GA4 client direto
pedidos_ink direto
```

---

# 6.3 Input

Conceitualmente:

```js
{
  organizationId,
  storeId,
  analyticsProvider,
  startDate,
  endDate,
  filters,
  sort,
  pagination
}
```

Não usar período relativo no contrato.

Validar:

```text
startDate <= endDate
```

e impor limite razoável se já houver convenção.

---

# 6.4 Output row

Conceitualmente:

```js
{
  product: {
    id,
    name,
    imageUrl,
    productType,
    provider,
    providerProductId
  },

  metrics: {
    itemsViewed,
    itemsAddedToCart,
    itemsCheckedOut,
    itemsPurchased,
    itemRevenue
  },

  rates: {
    addToCartRate,
    checkoutFromViewRate,
    cartToCheckoutRate,
    purchaseFromViewRate
  },

  identity: {
    matchedAnalyticsIds,
    status
  },

  diagnostics: [...]
}
```

Não chamar `itemsPurchased` de "paid orders".

É:

```text
GA4 observed purchased items
```

---

# 6.5 Agregação de múltiplos IDs

O mesmo CommerceProduct pode receber métricas por:

```text
product id
variant ids
SKUs
```

Depois da resolução:

```text
somar métricas dos external ids que apontam para o mesmo commerce_product_id
```

Sem double-count conhecido.

IMPORTANTE:

Se duas identities diferentes representam exatamente o mesmo evento lógico mas a Data API já agregou por itemId, não há informação suficiente para deduplicar entre IDs.

Não inventar deduplicação.

Se detectar múltiplos IDs simultaneamente ativos para o mesmo product:

```text
somar
+
diagnostic = multiple_analytics_identities
```

A deduplicação multi-source GA4/Meta é fase posterior.

---

# 6.6 Rates

Calcular apenas quando denominator > 0.

```text
addToCartRate
= itemsAddedToCart / itemsViewed

checkoutFromViewRate
= itemsCheckedOut / itemsViewed

cartToCheckoutRate
= itemsCheckedOut / itemsAddedToCart

purchaseFromViewRate
= itemsPurchased / itemsViewed
```

Retornar:

```text
null
```

quando não calculável.

Não retornar Infinity/NaN.

Tooltips são UI futura; documentar fórmulas no type/JSDoc.

---

# 6.7 Sem classificação forte ainda

Nesta rodada NÃO implementar:

```text
CAMPEÃ
OPORTUNIDADE
REVISAR
FRACA
```

sem antes termos UI/benchmark/regras fechadas.

Pode implementar somente diagnósticos objetivos:

```text
insufficient_data
unmatched_identity
multiple_analytics_identities
metric_unavailable
```

Nada opinativo.

---

# 6.8 Produtos sem analytics

A consulta deve conseguir representar produto do catálogo sem métricas.

Não transformar ausência de dados automaticamente em:

```text
0 views
```

se não sabemos se o tracking cobre aquele produto.

Preferir:

```text
metrics = null/unavailable
```

quando a ausência resulta de capability/tracking não disponível.

Quando o GA4 report explicitamente não possui row para um item em período válido e a cobertura é conhecida, pode usar zeros conforme regra bem documentada.

Não confundir:

```text
zero observado
```

com:

```text
dado ausente
```

---

# 6.9 Unmatched GA4 IDs

Não descartar silenciosamente.

Retornar metadata/diagnostic agregado:

```text
observedAnalyticsIds
matchedAnalyticsIds
unmatchedAnalyticsIds
coverageRate
```

O usuário precisa futuramente saber quando a tabela cobre só parte do tracking.

---

# 6.10 Performance

Não fazer:

```text
1 GA4 query por product
```

Fluxo:

```text
1 ou poucas queries GA4 para o período
↓
map itemId → product
↓
aggregate
↓
join com catálogo local
↓
filter/sort/page
```

Com 85k produtos de catálogo, não carregar imagem/metadata enorme desnecessariamente.

Selecionar somente colunas necessárias.

---

# 6.11 Cache

Primeiro verificar infraestrutura existente.

Pode reutilizar cache curto em memória/DB se já existir e for tenant-safe.

NÃO criar Redis.

NÃO criar `product_metrics_daily` nesta rodada apenas porque estava no documento original.

Só criar persistência de métricas se medição real/testes mostrarem necessidade arquitetural imediata.

Como G ainda não tem UI, preferir implementação simples e mensurável.

Documentar recomendação para snapshot futuro.

---

# 6.12 API route

NÃO criar rota pública/admin nesta rodada se isso obrigar a antecipar entitlement/UI.

A entrega mínima da G é:

```text
service + tests
```

Se já existir um padrão interno de route protegido e for trivial, NÃO usar isso como desculpa para expandir escopo.

Parar antes da UI.

---

# 6.13 Commerce reconciliation

NÃO implementar nesta G:

```text
paidOrders
commerceRevenue
reconciliation warning
```

usando tabela Ink legada.

Isso violaria:

```text
ProductPerformanceService provider-agnostic
```

Ao final, propor uma fase:

```text
Commerce Order Analytics Port
```

ou extensão do CommerceConnector para orders/read model antes da reconciliação.

---

# 6.14 Tests G

Cobrir:

- tenant context;
- período;
- 1 GA4 query agregada;
- 100/1000 produtos sem N+1;
- product exact;
- variant IDs agrupados;
- SKU identities agrupadas;
- unmatched IDs;
- conflito identity;
- multiple ids same product;
- zero denominator;
- rates;
- absent metric;
- empty period;
- product sem analytics;
- provider isolation;
- Organization isolation;
- sort por métricas;
- pagination do catálogo;
- nenhum import Ink;
- nenhum import GA4 concrete client;
- nenhum acesso a `pedidos_ink`;
- nenhuma classificação opinativa.

---

# 6.15 Gate G

Rodar:

- ProductPerformance tests;
- Identity tests;
- GA4 connector tests;
- catalog sync tests;
- contracts/registry;
- tenancy/invariants;
- static checks;
- repo:self-check.

Se verde:

```text
commit
feat(panel): add canonical product performance service
```

---

# 7. GATE FINAL DA RODADA

Após G:

Rodar a suíte COMPLETA atual do painel, no particionamento oficial:

```text
2 shards pure
4 shards db
```

Preferir a mesma estratégia do CI.

Se executar todos em paralelo na mesma máquina e aparecer falha sensível a scheduler:

1. não descartar automaticamente;
2. reproduzir arquivo isolado;
3. reproduzir shard isolado;
4. classificar;
5. não enfraquecer teste válido.

Registrar:

```text
total tests
passed
failed
shards
```

Também:

```text
repo:self-check
contracts:check
suites verify
```

---

# 8. REAL GA4 VALIDATION — NÃO BLOQUEANTE

Se a conexão real do tenant piloto estiver disponível, ao final da E/F gerar um pequeno relatório técnico:

```text
property
metadata_ok
compatibility_ok
period_tested
rows_sampled
unique_item_ids
identity_matches
identity_conflicts
identity_unmatched
coverage
```

NÃO imprimir:

- access token;
- refresh token;
- client secret;
- dados pessoais;
- payload sensível.

Se não houver acesso:

```text
real_validation: not_run
```

e informar motivo.

---

# 9. DOCUMENTAÇÃO

Criar:

```text
docs/features/product-analytics-night-round-e-f-g.md
```

ou equivalente.

Registrar somente decisões realmente tomadas.

Atualizar audit/architecture docs existentes apenas quando ficaram objetivamente desatualizados.

Não reescrever documentos grandes sem necessidade.

---

# 10. COMMITS ESPERADOS

Idealmente:

```text
feat(panel): add GA4 product analytics connector
feat(panel): add product identity schema
feat(panel): add product identity resolution
feat(panel): add canonical product performance service
```

Ajuste a divisão quando houver motivo semântico.

Nunca:

```text
git add .
```

se houver docs/arquivos não relacionados no working tree.

Stage seletivo.

Sem push.

Sem merge.

Sem deploy.

---

# 11. O QUE NÃO FAZER DURANTE A NOITE

Não implementar:

```text
React UI
drawer
charts
CSV
entitlement analytics_product_performance
billing
Meta Events adapter
Meta Ads adapter
AI diagnosis
commerce order normalization
GA4 × Commerce reconciliation definitiva
BigQuery
tracking próprio Oria
webhooks novos
alteração de server.js legado
migração de handlers Ink
```

Esses itens ficam para a próxima rodada humana.

---

# 12. RELATÓRIO FINAL OBRIGATÓRIO

Ao finalizar, devolver exatamente estas seções:

## A. Estado final
- branch;
- HEAD;
- working tree;
- commits criados.

## B. Fase E
1. arquivos;
2. contract final;
3. dimensões;
4. métricas;
5. metadata/compatibility;
6. paginação;
7. tratamento de quota;
8. auth/secret;
9. testes;
10. real GA4 smoke.

## C. Fase F
1. migration;
2. schema;
3. namespaces;
4. bootstrap;
5. resolução GA4;
6. conflitos;
7. coverage;
8. testes;
9. negative controls.

## D. Fase G
1. service;
2. dependências abstratas;
3. output;
4. aggregation;
5. rates;
6. zero vs unavailable;
7. performance/N+1;
8. cache;
9. testes.

## E. Suite completa
- shards;
- total;
- falhas;
- self-check;
- contracts;
- suites verify.

## F. Dívidas
Listar apenas dívidas reais.

## G. Próxima rodada recomendada
Propor ordem para:
1. entitlement/API;
2. Commerce orders/reconciliation;
3. UI;
4. Meta Events;
5. Meta Ads;
sem executar.

---

# 13. CONFIRMAÇÕES FINAIS

Confirmar explicitamente:

```text
1 Organization = 1 Store permanece intacto.

Nenhum secret entrou em ConnectorContext ou ResolvedIntegration.

Nenhum connector novo usa fallback legado de env.

Reserva Ink continua restrita ao Commerce adapter.

GA4 continua restrito ao Analytics adapter.

ProductIdentity não usa fuzzy name matching.

ProductPerformanceService não conhece Reserva Ink.

ProductPerformanceService não acessa pedidos_ink.

Não existe GA4 query por produto.

Não houve UI.

Não houve push.

Não houve merge.

Não houve deploy.
```

---

# 14. NOTAS TÉCNICAS GA4 PARA NÃO REDESCOBRIR DURANTE A RODADA

Estado confirmado antes desta rodada:

```text
dimension:
itemId
itemName

metrics:
itemsViewed
itemsAddedToCart
itemsCheckedOut
itemsPurchased
itemRevenue
itemViewEvents
```

`items*` são métricas de itens/unidades.

A Data API v1beta fornece:

```text
runReport
getMetadata
checkCompatibility
```

`runReport` pagina com:

```text
limit
offset
rowCount
```

e pode retornar até 250.000 rows por request conforme documentação atual.

Mesmo assim, o código deve continuar preparado para paginação; não assumir que um request sempre basta.

Não usar conhecimento desta seção como substituto para teste de compatibility da propriedade real.

---

# 15. PRINCÍPIO FINAL DA RODADA

Quando houver escolha entre:

```text
atalho para o tenant piloto
```

e:

```text
abstração correta para qualquer Organization do Oria
```

usar a abstração correta.

Quando houver escolha entre:

```text
inventar dado para preencher a tela futura
```

e:

```text
representar unavailable / insufficient_data
```

usar o segundo.

Quando houver escolha entre:

```text
continuar apesar de uma dúvida reversível
```

e:

```text
interromper a noite para perguntar naming/detalhe local
```

decidir, documentar e continuar.

Quando houver conflito estrutural com tenancy, secrets, migrations destrutivas ou identidade de produto:

```text
PARAR
RELATAR
NÃO IMPROVISAR
```
