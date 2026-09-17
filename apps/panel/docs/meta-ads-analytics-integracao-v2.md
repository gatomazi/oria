# Implementação — Integração Meta Ads + Analytics

> Documento de execução para o Claude implementar a integração do Meta Ads no painel existente.
>
> **Contexto atual:** o painel já possui integração funcional com GA4 e já exibe dados da loja. A nova integração deve seguir os padrões arquiteturais, visuais e de segurança já adotados no projeto, evitando criar uma segunda arquitetura paralela.

---

# 1. Objetivo

Adicionar ao painel uma integração com a **Meta Marketing API / Insights API** para trazer dados de mídia paga da Meta e cruzá-los com:

- GA4;
- pedidos/receita real da loja;
- UTM Tracker, caso já esteja implementado;
- produtos/estampas, quando houver uma chave de associação confiável.

O resultado deve permitir responder, dentro do painel:

> Qual campanha → conjunto → anúncio → criativo está trazendo tráfego, conversões e receita, e como esses números se comparam com GA4 e com a receita real da loja?

A integração deve nascer preparada para ser usada futuramente no produto SaaS, mas a **V1 é somente leitura**.

---

# 2. Princípio da V1

## Implementar agora

- conexão com Meta;
- seleção da conta de anúncios;
- leitura de campanhas;
- leitura de conjuntos de anúncios;
- leitura de anúncios;
- leitura de criativos quando disponível;
- leitura de Insights;
- sincronização histórica e incremental;
- armazenamento local/cache;
- dashboards;
- comparação Meta × GA4 × Loja;
- métricas de criativos;
- estrutura preparada para múltiplos clientes/contas.

## NÃO implementar agora

Não solicitar `ads_management` e não permitir:

- pausar campanha;
- pausar conjunto;
- pausar anúncio;
- alterar orçamento;
- alterar bid;
- editar criativo;
- criar campanha;
- criar conjunto;
- criar anúncio.

A V1 deve funcionar com o menor conjunto de permissões possível, priorizando:

```text
ads_read
```

No futuro poderá existir um módulo separado de gestão utilizando:

```text
ads_management
```

Essa evolução não deve exigir refatoração completa da arquitetura criada agora.

---

# 3. Antes de alterar o código

Claude deve primeiro inspecionar o projeto existente e identificar:

1. como a integração GA4 foi implementada;
2. como tokens/segredos são armazenados;
3. como conexões externas são modeladas;
4. como jobs/cron/sincronizações são executados;
5. como o banco está estruturado;
6. como as rotas de API são organizadas;
7. como o frontend consulta analytics;
8. quais componentes de dashboard já existem;
9. como filtros globais de período funcionam;
10. se o UTM Tracker já existe;
11. se já existe uma entidade de `store`, `workspace`, `tenant`, `account` ou equivalente.

**Não duplicar soluções já existentes.**

Se GA4 já tiver um padrão como:

```text
Integration
Provider
Credential
SyncJob
AnalyticsSnapshot
```

o Meta deve reutilizar esse mesmo padrão sempre que fizer sentido.

---

# 4. Arquitetura desejada

Fluxo conceitual:

```text
Meta
  │
  ├── OAuth / Access Token
  │
  ├── Ad Account
  │
  └── Marketing API / Insights API
          │
          ▼
Backend do painel
          │
          ├── serviço Meta
          ├── normalização
          ├── sync incremental
          ├── histórico
          └── cache/banco
                  │
                  ▼
Analytics
  │
  ├── Meta Ads
  ├── GA4
  ├── Loja
  ├── UTM
  └── Atribuição
```

Não consultar a Meta diretamente do browser.

Todas as chamadas devem ocorrer no backend.

---

# 5. Autenticação e conexão

A integração deve suportar dois cenários.

## 5.1 Uso interno / desenvolvimento

Enquanto o painel estiver sendo usado internamente, permitir configuração manual protegida:

```text
META_APP_ID
META_APP_SECRET
META_ACCESS_TOKEN
META_AD_ACCOUNT_ID
META_API_VERSION
```

`META_API_VERSION` deve ser configurável.

**Não hardcodar uma versão específica da Graph API em vários arquivos.**

Centralizar:

```ts
const META_GRAPH_VERSION = process.env.META_API_VERSION
```

e construir a base:

```text
https://graph.facebook.com/{META_GRAPH_VERSION}
```

---

## 5.2 SaaS / produção

A arquitetura deve permitir futuramente:

```text
Integrações
  └── Meta Ads
        └── [ Conectar com Meta ]
```

Fluxo:

```text
Usuário
  ↓
Facebook Login / Meta OAuth
  ↓
consentimento
  ↓
backend recebe autorização
  ↓
token armazenado de forma segura
  ↓
buscar contas de anúncios acessíveis
  ↓
usuário seleciona a conta
  ↓
salvar Meta Ad Account
```

Para contas de anúncios de terceiros, preparar a implementação considerando que o app poderá exigir **Advanced Access** para permissões como `ads_read`.

Não implementar App Review agora, mas não criar dependências que impeçam essa evolução.

---

# 6. Segurança

## Obrigatório

- nunca persistir access token em plaintext se o projeto já tiver mecanismo de criptografia;
- nunca enviar token Meta ao frontend;
- nunca incluir token em logs;
- nunca incluir token em erros retornados ao cliente;
- mascarar identificadores sensíveis na UI quando necessário;
- acesso às integrações deve respeitar tenant/store/workspace;
- usuário de uma loja nunca pode consultar dados Meta de outra;
- implementar refresh/reconexão seguindo o padrão adotado pelo projeto.

Criar abstração equivalente a:

```ts
MetaCredentialsService
```

Responsabilidades:

```text
getCredentials()
saveCredentials()
updateCredentials()
invalidateCredentials()
testConnection()
```

---

# 7. Entidades Meta que devemos suportar

Hierarquia:

```text
Ad Account
    ↓
Campaign
    ↓
Ad Set
    ↓
Ad
    ↓
Creative
```

Precisamos preservar os IDs nativos da Meta.

Exemplo:

```text
metaAccountId
metaCampaignId
metaAdSetId
metaAdId
metaCreativeId
```

Esses IDs serão fundamentais para histórico e associação de Insights.

---

# 8. Endpoints principais da Meta

Usar a Marketing API.

Exemplos conceituais:

```http
GET /act_{AD_ACCOUNT_ID}
```

```http
GET /act_{AD_ACCOUNT_ID}/campaigns
```

```http
GET /act_{AD_ACCOUNT_ID}/adsets
```

```http
GET /act_{AD_ACCOUNT_ID}/ads
```

```http
GET /act_{AD_ACCOUNT_ID}/insights
```

O endpoint de Insights deve suportar:

```text
level=account
level=campaign
level=adset
level=ad
```

Para grande volume de dados, deixar a camada de serviço preparada para relatórios assíncronos da Meta, caso necessário.

---

# 9. Campos básicos

## 9.1 Ad Account

Buscar quando disponível:

```text
id
name
account_status
currency
timezone_name
timezone_offset_hours_utc
amount_spent
spend_cap
```

Não assumir que todos os campos estarão disponíveis em todas as contas.

---

# 10. Campaign

Persistir no mínimo:

```text
id
name
status
effective_status
objective
created_time
updated_time
start_time
stop_time
```

Associar à conta Meta.

---

# 11. Ad Set

Persistir no mínimo:

```text
id
campaign_id
name
status
effective_status
daily_budget
lifetime_budget
optimization_goal
billing_event
bid_strategy
created_time
updated_time
start_time
end_time
```

Campos opcionais devem ser nullable.

---

# 12. Ad

Persistir:

```text
id
campaign_id
adset_id
name
status
effective_status
creative
created_time
updated_time
```

Quando possível armazenar referência para:

```text
creative.id
```

---

# 13. Criativo

Para a V1, buscar o suficiente para exibir e identificar o criativo.

Exemplos de campos possíveis:

```text
id
name
title
body
thumbnail_url
image_url
object_story_spec
asset_feed_spec
effective_object_story_id
```

Nem todo criativo fornecerá todos os campos.

Criativos Advantage+/Dynamic Creative podem possuir múltiplos assets.

Portanto:

**não modelar criativo assumindo que existe apenas uma imagem + um texto.**

Criar uma estrutura flexível.

---

# 14. Insights

Este é o núcleo da integração.

Exemplo conceitual:

```http
GET /act_{ACCOUNT_ID}/insights
  ?level=ad
  &time_increment=1
  &fields=...
```

Precisamos buscar dados por dia sempre que possível:

```text
time_increment=1
```

Isso permite reconstruir qualquer período no painel sem depender de consultar a Meta em tempo real.

---

# 15. Métricas de Insights

## Entrega

```text
impressions
reach
frequency
```

## Tráfego

```text
clicks
unique_clicks
inline_link_clicks
outbound_clicks
unique_outbound_clicks
ctr
cpc
cpm
cpp
```

## Investimento

```text
spend
```

## Conversões

Buscar:

```text
actions
action_values
cost_per_action_type
conversions
conversion_values
```

Não assumir que `purchase`, `add_to_cart` etc. serão propriedades diretas.

A API frequentemente retorna arrays de ações:

```json
[
  {
    "action_type": "purchase",
    "value": "12"
  }
]
```

Criar normalizador.

---

# 16. Normalizador de actions

Criar helper central:

```ts
getActionValue(actions, actionTypes[])
```

Exemplo:

```ts
const purchases = getActionValue(actions, [
  'purchase',
  'omni_purchase'
])
```

O mapper deve ser centralizado e testado.

Criar inicialmente suporte lógico para:

```text
view_content
add_to_cart
initiate_checkout
purchase
lead
landing_page_view
link_click
```

A nomenclatura retornada pela Meta pode variar dependendo da origem/evento.

Portanto evitar lógica espalhada como:

```ts
actions.find(x => x.action_type === 'purchase')
```

em vários componentes.

Usar:

```text
MetaActionMapper
```

---

# 17. Receita atribuída pelo Meta

Usar `action_values`/`conversion_values` de maneira explícita.

Precisamos salvar separadamente:

```text
metaPurchases
metaPurchaseValue
```

Nunca usar:

```text
pedidos reais da loja
```

como se fossem compras atribuídas pela Meta.

São métricas diferentes.

---

# 18. ROAS Meta

Calcular:

```text
Meta ROAS =
Meta Purchase Value
-------------------
Meta Spend
```

Se a Meta fornecer um campo equivalente confiável para o contexto, podemos armazená-lo também, mas manter cálculo próprio normalizado permite consistência.

Sempre proteger divisão por zero.

---

# 19. CPA Meta

```text
Meta CPA =
Meta Spend
----------
Meta Purchases
```

---

# 20. Métricas de vídeo

Quando disponíveis:

```text
video_play_actions
video_thruplay_watched_actions
video_avg_time_watched_actions
video_p25_watched_actions
video_p50_watched_actions
video_p75_watched_actions
video_p95_watched_actions
video_p100_watched_actions
video_30_sec_watched_actions
```

Esses dados devem aparecer apenas para anúncios compatíveis.

Frontend não deve exibir `0` de forma enganosa para métricas não aplicáveis.

Preferir:

```text
—
```

quando não há dado.

---

# 21. Atribuição Meta

A consulta deve suportar configuração de atribuição.

Quando compatível com a conta:

```text
use_unified_attribution_setting=true
```

Guardar no snapshot qual configuração foi usada.

Exemplo:

```text
attributionSetting
```

ou:

```text
attributionWindows
```

Não comparar Meta com GA4 afirmando que ambos usam o mesmo modelo de atribuição.

---

# 22. Modelo de dados

Adaptar ao ORM já usado pelo projeto.

Não trocar ORM.

Estrutura conceitual:

```text
MetaConnection
MetaAdAccount
MetaCampaign
MetaAdSet
MetaAd
MetaCreative
MetaInsightDaily
MetaSyncLog
```

---

# 23. MetaConnection

Campos conceituais:

```text
id
tenantId/storeId/workspaceId
provider = "meta"
status
accessTokenEncrypted
tokenExpiresAt
metaUserId
createdAt
updatedAt
lastSuccessfulSyncAt
lastErrorAt
lastErrorCode
lastErrorMessage
```

Se o projeto já possui uma tabela genérica de integrações, reutilizar.

---

# 24. MetaAdAccount

```text
id
connectionId
metaAccountId
name
currency
timezoneName
accountStatus
isSelected
createdAt
updatedAt
lastSyncedAt
```

Suportar múltiplas contas futuramente mesmo que a UI inicial permita uma conta principal.

---

# 25. MetaCampaign

```text
id
metaAdAccountId
metaCampaignId
name
objective
status
effectiveStatus
startTime
stopTime
createdTime
updatedTime
rawData?
createdAt
updatedAt
```

`rawData` opcional, apenas se o projeto já usa JSON bruto de integrações.

---

# 26. MetaAdSet

```text
id
metaAdAccountId
campaignId
metaAdSetId
name
status
effectiveStatus
optimizationGoal
billingEvent
bidStrategy
dailyBudget
lifetimeBudget
startTime
endTime
createdTime
updatedTime
createdAt
updatedAt
```

---

# 27. MetaAd

```text
id
metaAdAccountId
campaignId
adSetId
creativeId
metaAdId
name
status
effectiveStatus
createdTime
updatedTime
createdAt
updatedAt
```

---

# 28. MetaCreative

Estrutura flexível:

```text
id
metaAdAccountId
metaCreativeId
name
title
body
thumbnailUrl
imageUrl
objectStoryId
assetFeedSpec JSON?
objectStorySpec JSON?
rawData JSON?
createdAt
updatedAt
```

Não armazenar blobs de imagem.

Salvar apenas URL/referência quando permitido.

---

# 29. MetaInsightDaily

Esta tabela é essencial.

Cada linha deve representar:

```text
1 entidade Meta
+
1 dia
+
1 nível
+
1 configuração de atribuição
```

Exemplo:

```text
id

metaAdAccountId

level:
  account
  campaign
  adset
  ad

date

metaCampaignId?
metaAdSetId?
metaAdId?

impressions
reach
frequency

clicks
uniqueClicks
inlineLinkClicks
outboundClicks
uniqueOutboundClicks

spend
ctr
cpc
cpm

landingPageViews
viewContent
addToCart
initiateCheckout

purchases
purchaseValue

costPerPurchase

videoPlays
videoThruplays
video25
video50
video75
video95
video100
videoAvgWatchTime

attributionSetting
rawActions JSON?
rawActionValues JSON?

createdAt
updatedAt
```

Criar índices.

No mínimo:

```text
(metaAdAccountId, date)
(metaCampaignId, date)
(metaAdSetId, date)
(metaAdId, date)
(level, date)
```

Criar unique constraint que impeça snapshots duplicados para:

```text
ad account
+
level
+
entity id
+
date
+
attribution config
```

---

# 30. Valores monetários

Não usar `float` para dinheiro.

Seguir o padrão financeiro existente.

Preferência:

```text
Decimal
```

ou centavos inteiros, conforme arquitetura atual.

Meta pode retornar valores monetários como strings.

Normalizar no backend.

---

# 31. Sincronização

Não fazer o dashboard depender de chamadas ao Meta em tempo real.

Fluxo:

```text
Meta API
   ↓
sync
   ↓
database
   ↓
API interna
   ↓
dashboard
```

Benefícios:

- velocidade;
- menos rate limit;
- histórico;
- comparação com GA4;
- resiliência;
- SaaS mais previsível.

---

# 32. Importação inicial

Ao conectar uma conta:

1. validar token;
2. buscar conta;
3. buscar campanhas;
4. buscar ad sets;
5. buscar ads;
6. buscar criativos necessários;
7. importar Insights históricos.

V1:

```text
90 dias
```

como período inicial sugerido.

Se isso ficar pesado para uma conta específica:

- paginar;
- dividir por janelas;
- usar relatório assíncrono;
- mostrar progresso;
- não bloquear request HTTP até completar tudo.

---

# 33. Sync incremental

Sugestão inicial:

## Dados recentes

Sincronizar periodicamente:

```text
hoje
ontem
```

e atualizar entidades ativas.

Periodicidade sugerida:

```text
30–60 minutos
```

A frequência deve ser configurável.

---

# 34. Backfill de atribuição

Conversões podem aparecer posteriormente.

Portanto não considerar um dia encerrado e imutável.

Criar job diário que refaça pelo menos:

```text
últimos 7 dias
```

Idealmente permitir configuração para:

```text
7
14
28 dias
```

dependendo da estratégia de atribuição utilizada.

---

# 35. Sync noturno

Criar rotina diária para:

```text
campanhas
adsets
ads
creatives
últimos 28 dias de insights
```

Ela corrige:

- alterações de nome;
- alteração de status;
- conversões tardias;
- reprocessamentos da Meta.

---

# 36. MetaSyncLog

Registrar:

```text
startedAt
finishedAt
status
syncType
dateFrom
dateTo
recordsProcessed
recordsCreated
recordsUpdated
apiCalls
errorCode
errorMessage
```

Tipos:

```text
INITIAL_IMPORT
INCREMENTAL
BACKFILL
MANUAL
```

---

# 37. Rate limit e resiliência

Implementar:

- paginação;
- retry com exponential backoff;
- timeout;
- tratamento de token expirado;
- tratamento de permission denied;
- tratamento de rate limit;
- circuit breaker simples se a arquitetura existente já suportar;
- log estruturado.

Nunca fazer loop infinito de retry.

---

# 38. API interna do painel

Adaptar nomes ao backend existente.

Sugestão:

```text
GET /api/integrations/meta/status
POST /api/integrations/meta/connect
POST /api/integrations/meta/disconnect
POST /api/integrations/meta/test
GET /api/integrations/meta/ad-accounts
POST /api/integrations/meta/select-account
POST /api/integrations/meta/sync
```

Analytics:

```text
GET /api/analytics/meta/overview
GET /api/analytics/meta/campaigns
GET /api/analytics/meta/adsets
GET /api/analytics/meta/ads
GET /api/analytics/meta/creatives
GET /api/analytics/meta/timeseries
GET /api/analytics/meta/attribution
```

Filtros padrão:

```text
from
to
accountId
campaignId
adSetId
adId
```

---

# 39. Nova seção do painel

Estrutura desejada:

```text
Analytics
├── Visão Geral
├── GA4
├── Meta Ads
│   ├── Visão Geral
│   ├── Campanhas
│   ├── Conjuntos
│   ├── Anúncios
│   └── Criativos
├── UTMs
└── Atribuição
```

Se a sidebar já tiver outra hierarquia, adaptar sem quebrar consistência visual.

---

# 40. Meta Ads — Visão Geral

Cabeçalho:

```text
Meta Ads

Conta: Use Origens
Período: [ últimos 7 dias ▼ ]
Comparar com: [ período anterior ▼ ]

Última sincronização: há 18 min
```

Cards principais:

```text
Investimento
Impressões
Alcance
Frequência
CTR
CPC
CPM
Compras Meta
CPA Meta
Receita Meta
ROAS Meta
```

---

# 41. Variação de período

Cada card deve suportar:

```text
valor atual
variação %
valor período anterior
```

Exemplo:

```text
Investimento
R$ 4.318,22
▲ 14,8%
vs. período anterior
```

Não usar verde/vermelho cegamente.

Exemplo:

- aumento de receita pode ser positivo;
- aumento de CPA pode ser negativo;
- aumento de gasto é neutro sem contexto.

Criar semântica por métrica.

---

# 42. Gráfico principal

Gráfico temporal com seleção:

```text
[ Investimento ]
[ Receita ]
[ Compras ]
[ CPA ]
[ ROAS ]
[ CTR ]
[ CPC ]
```

Possibilidade de duas séries:

```text
Investimento
Receita Meta
```

por dia.

Reutilizar biblioteca de gráficos existente.

Não adicionar nova lib sem necessidade.

---

# 43. Funil Meta

Exibir quando houver dados suficientes:

```text
Impressões
   ↓
Cliques
   ↓
Landing Page Views
   ↓
View Content
   ↓
Add to Cart
   ↓
Initiate Checkout
   ↓
Purchase
```

Mostrar:

```text
volume
taxa entre etapas
```

Não misturar eventos GA4 nesse componente.

Este é o:

```text
Funil Meta
```

---

# 44. Página Campanhas

Tabela:

| Campanha | Status | Gasto | Impressões | CTR | CPC | Compras | CPA | Receita | ROAS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|

Recursos:

- busca;
- filtro de status;
- filtro por objetivo;
- ordenação;
- paginação;
- período;
- comparação.

Clique na campanha:

```text
Campanha
   ↓
Conjuntos
```

---

# 45. Página Conjuntos

Tabela:

| Conjunto | Campanha | Status | Gasto | CTR | CPM | Compras | CPA | Receita | ROAS |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|

Filtros:

```text
campanha
status
período
```

---

# 46. Página Anúncios

Tabela:

| Anúncio | Conjunto | Campanha | Status | Gasto | CTR | CPC | Compras | CPA | Receita | ROAS |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|

Quando houver thumbnail:

```text
[thumb] Nome do anúncio
```

Clique abre detalhe.

---

# 47. Detalhe do anúncio

Exibir:

```text
Criativo
Nome
Campanha
Conjunto
Status

Investimento
Impressões
Alcance
Frequência
CTR
CPC
CPM

Compras Meta
CPA Meta
Receita Meta
ROAS Meta
```

Se vídeo:

```text
plays
ThruPlay
25%
50%
75%
95%
100%
avg watch time
```

Mostrar série temporal do anúncio.

---

# 48. Página Criativos

Esta página é estratégica.

Objetivo:

> comparar performance de criativos independentemente da navegação convencional Campanha → Conjunto → Anúncio.

Cards ou tabela visual:

```text
[thumbnail]

Nome do anúncio

R$ 837,21 gasto
CTR 2,7%
CPA R$ 27,00
ROAS 5,83x

31 compras
```

Filtros:

```text
Todos
Imagem
Vídeo
Carrossel
Dynamic/Advantage+
```

Quando não for possível identificar o tipo de forma confiável:

```text
Outro
```

Ordenação:

```text
ROAS
CPA
Gasto
CTR
Compras
Impressões
Frequência
```

---

# 49. Classificação visual de criativos

Não automatizar decisões de mídia na V1.

Podemos oferecer sinalização analítica:

```text
Boa eficiência
Neutro
Atenção
```

Mas ela deve depender de thresholds configuráveis.

Nunca escrever automaticamente:

```text
PAUSAR
ESCALAR
```

como decisão absoluta.

Preferir:

```text
Candidato a escala
Monitorar
Baixa eficiência
```

e mostrar o motivo.

Exemplo:

```text
Candidato a escala

ROAS acima da meta
CPA abaixo da meta
Gasto > R$ 200
```

---

# 50. Metas configuráveis

Criar configurações analíticas:

```text
CPA alvo
ROAS alvo
CTR mínimo
Gasto mínimo antes de avaliar
```

Exemplo:

```text
CPA alvo: R$ 45
ROAS alvo: 3.0
CTR mínimo: 1,5%
Gasto mínimo: R$ 100
```

Essas metas serão usadas para badges.

Não codificar valores específicos da Use Origens no sistema.

---

# 51. Visão Geral — GA4 + Meta + Loja

Criar uma visão consolidada.

Exemplo:

```text
RECEITA REAL
R$ 3.120

INVESTIMENTO META
R$ 580

RECEITA ATRIBUÍDA META
R$ 2.840

RECEITA ATRIBUÍDA GA4
R$ 2.410

PEDIDOS REAIS
23
```

A nomenclatura é muito importante.

Não exibir simplesmente:

```text
Receita
```

para os três.

Usar explicitamente:

```text
Receita real da loja
Receita atribuída Meta
Receita atribuída GA4
```

---

# 52. Comparação de atribuição

Criar tela:

```text
Analytics > Atribuição
```

Exemplo:

| Origem | Compras | Receita |
|---|---:|---:|
| Loja | 23 | R$ 3.120 |
| Meta | 21 | R$ 2.840 |
| GA4 | 18 | R$ 2.410 |

Adicionar explicação curta:

> Meta, GA4 e a loja utilizam fontes e modelos diferentes. Divergências são esperadas e não significam necessariamente erro de rastreamento.

---

# 53. MER

Adicionar métrica:

```text
MER =
Receita real da loja
---------------------
Investimento em mídia
```

Enquanto apenas Meta estiver integrado:

```text
MER observado =
Receita real
-------------
Gasto Meta
```

A UI deve deixar claro que o denominador considera apenas as fontes de mídia conectadas.

No futuro:

```text
Meta
Google Ads
TikTok Ads
Pinterest Ads
...
```

poderão compor:

```text
Blended Media Spend
```

e então:

```text
Blended MER
```

---


# 53A. Camada financeira — ponto crítico

A integração Meta não deve ser tratada apenas como um dashboard de ROAS.

O painel já possui um dado particularmente valioso que deve ser considerado a **fonte de verdade do custo de produção**:

```text
custo de produção recebido no webhook do pedido
```

A partir disso, precisamos separar quatro conceitos diferentes.

---

## 53A.1 Receita da venda

Utilizar como base a receita efetivamente considerada pelo sistema para aquele pedido.

Conceitualmente:

```text
Receita da venda
```

deve respeitar:

```text
valor efetivamente pago
descontos
cancelamentos
reembolsos
```

conforme os dados disponíveis no sistema atual.

Não utilizar `purchase_value` do Meta como receita contábil/financeira da loja.

A receita da loja é a fonte de verdade financeira.

---

## 53A.2 Custo de produção

O custo de produção vem do evento recebido pelo webhook.

Exemplo:

```text
Venda:              R$ 129,90
Custo de produção:   R$ 75,00
```

Então:

```text
Margem do produto = R$ 54,90
```

O sistema atual pode chamar esse valor de `Lucro Real`, mas tecnicamente ele ainda representa o lucro/margem **antes dos custos de aquisição e demais despesas operacionais**.

Para evitar ambiguidade no novo módulo, preferir na arquitetura:

```text
productProfit
```

ou:

```text
productContribution
```

e na UI usar:

```text
Lucro do Produto
```

ou:

```text
Margem do Produto
```

Caso seja necessário preservar o termo atual por compatibilidade visual, manter tooltip explicando:

> Valor da venda menos o custo de produção. Não inclui mídia, taxas e demais despesas operacionais.

Fórmula:

```text
Lucro do Produto =
Receita da venda
-
Custo de produção
```

---

# 53B. O gasto de mídia é uma camada separada

Para fechar o financeiro corretamente:

```text
Receita
   ↓
- Custo de produção
   ↓
= Lucro do Produto
   ↓
- Meta Ads
- Google Ads
- outros canais pagos
   ↓
= Lucro após mídia
```

Posteriormente:

```text
Lucro após mídia
   ↓
- taxas de pagamento
- frete subsidiado
- apps
- gestor de tráfego
- designer
- mensalidades
- outras despesas
   ↓
= Lucro Operacional
```

Essa separação deve existir desde a modelagem inicial.

---

# 53C. Duas fontes de verdade diferentes

## Produção

Fonte:

```text
webhook do pedido
```

É o custo real associado ao pedido/produto.

## Mídia

Fonte:

```text
Meta Marketing API
Google Ads API
outros providers futuros
```

É o gasto real reportado pela plataforma naquele período.

Essas informações **não devem ser misturadas na origem**.

O backend consolida depois.

---

# 53D. Regra fundamental: atribuição não fecha o caixa

Existe uma diferença entre:

```text
gasto real de mídia
```

e:

```text
gasto atribuído a uma venda
```

O gasto real vem da plataforma.

Exemplo:

```text
Meta gastou hoje: R$ 1.000
Google gastou hoje: R$ 400

Total real de mídia: R$ 1.400
```

Esse é o número que deve entrar no financeiro do período.

Já a atribuição pode dizer:

```text
Pedido #123 → Meta
Pedido #124 → Google
Pedido #125 → Orgânico
```

Isso é uma camada analítica.

**Nunca depender da atribuição por pedido para saber quanto foi gasto com mídia.**

---

# 53E. Evitar dupla contabilização

Regra obrigatória:

> O gasto real de mídia só pode ser descontado uma vez no fechamento financeiro.

Não fazer:

```text
Lucro de cada pedido
- custo atribuído de anúncio

e depois

Lucro do período
- gasto total Meta
```

Isso descontaria mídia duas vezes.

Separar:

```text
FINANCEIRO
→ usa gasto real da plataforma

ATRIBUIÇÃO
→ distribui/relaciona esse gasto para análise
```

---

# 53F. Novo modelo de resultado

A visão financeira consolidada deve trabalhar progressivamente.

## Nível 1 — Receita

```text
Receita Real
```

---

## Nível 2 — Produção

```text
Receita Real
- Custo de Produção
= Lucro do Produto
```

---

## Nível 3 — Aquisição

```text
Lucro do Produto
- Meta Ads
- Google Ads
- outros canais pagos
= Lucro após Mídia
```

---

## Nível 4 — Operacional

Quando houver essas informações:

```text
Lucro após Mídia
- Taxas
- Frete subsidiado
- Apps
- Serviços
- Despesas operacionais
= Lucro Operacional
```

---

# 53G. Métricas financeiras obrigatórias

Adicionar à camada consolidada:

```text
Receita Real
Custo de Produção
Lucro do Produto
Margem do Produto %
Meta Spend
Google Ads Spend
Total Media Spend
Lucro após Mídia
Margem após Mídia %
Pedidos
Ticket Médio
```

Quando houver despesas adicionais:

```text
Despesas Operacionais
Lucro Operacional
Margem Operacional %
```

---

# 53H. Fórmulas

## Lucro do Produto

```text
Lucro do Produto =
Receita Real
-
Custo de Produção
```

---

## Margem do Produto

```text
Margem do Produto % =
Lucro do Produto
-----------------
Receita Real
× 100
```

---

## Total de mídia

```text
Total Media Spend =
Meta Spend
+
Google Ads Spend
+
demais canais conectados
```

---

## Lucro após mídia

```text
Lucro após Mídia =
Lucro do Produto
-
Total Media Spend
```

---

## Margem após mídia

```text
Margem após Mídia % =
Lucro após Mídia
----------------
Receita Real
× 100
```

---

## Lucro operacional

Quando todos os custos estiverem disponíveis:

```text
Lucro Operacional =
Receita Real
- Custo de Produção
- Mídia
- Taxas
- Despesas Operacionais
```

---

# 53I. MER

Manter:

```text
MER =
Receita Real
------------
Total Media Spend
```

Esse número é independente da atribuição do Meta/GA4.

Exemplo:

```text
Receita real:       R$ 10.000
Meta:               R$ 2.000
Google:             R$   500

Total mídia:        R$ 2.500

MER = 4,0x
```

---

# 53J. ROAS de plataforma × eficiência real

Nunca substituir um pelo outro.

## ROAS Meta

```text
Receita atribuída pelo Meta
---------------------------
Meta Spend
```

## ROAS Google

```text
Receita atribuída pelo Google
-----------------------------
Google Spend
```

## MER

```text
Receita Real
------------
Total Media Spend
```

Os três devem coexistir.

---

# 53K. Profit ROAS / eficiência sobre margem

Como temos custo real de produção vindo do webhook, podemos criar uma métrica muito mais útil do que apenas ROAS de receita.

### Gross Profit ROAS / ROAS de margem

```text
ROAS de Margem =
Lucro do Produto
----------------
Total Media Spend
```

Exemplo:

```text
Receita:            R$ 10.000
Produção:           R$  6.000
Lucro do Produto:   R$  4.000
Mídia:              R$  2.000

ROAS de receita:       5,0x
ROAS de margem:        2,0x
```

O segundo indicador revela melhor quanto de margem foi gerado para cada real investido em aquisição.

---

# 53L. Resultado líquido de mídia

Também mostrar:

```text
Lucro após Mídia =
Lucro do Produto
-
Total Media Spend
```

No exemplo:

```text
R$ 4.000 - R$ 2.000 = R$ 2.000
```

E:

```text
Resultado por R$ de mídia =
Lucro após Mídia
----------------
Total Media Spend
```

Essa métrica deve ter nome explícito na UI para não ser confundida com ROAS tradicional.

---

# 53M. Break-even ROAS

Como conhecemos o custo do produto, o painel pode calcular o ROAS mínimo necessário para não consumir toda a margem do produto.

Versão simplificada:

```text
Margem do Produto % = 40%
```

Então:

```text
Break-even ROAS =
1
----------------
Margem do Produto
```

```text
1 / 0,40 = 2,5x
```

Ou seja:

> abaixo de 2,5x de ROAS de receita, a mídia consumiria toda a margem antes das demais despesas.

Quando taxas e outras despesas variáveis forem conhecidas, usar margem de contribuição real no denominador.

Essa métrica deve ser calculada dinamicamente.

---

# 53N. Blended CAC

Adicionar:

```text
Blended CAC =
Total Media Spend
-----------------
Pedidos Reais
```

A UI deve informar:

> Considera todos os pedidos do período, inclusive vendas orgânicas.

Não confundir com:

```text
Meta CPA
Google CPA
```

que são métricas atribuídas por plataforma.

---

# 53O. CAC atribuído

Por provider:

```text
Meta CPA =
Meta Spend
----------
Compras atribuídas Meta
```

```text
Google CPA =
Google Spend
------------
Compras atribuídas Google
```

Esses dados são analíticos.

O `Blended CAC` é financeiro/agregado.

---

# 53P. Estrutura provider-agnostic para mídia

Embora esta implementação comece com Meta, a camada financeira não deve se chamar:

```text
MetaExpense
```

Criar abstração equivalente a:

```text
MediaSpend
```

ou:

```text
AdSpendDaily
```

Estrutura conceitual:

```text
id
workspaceId/storeId
provider
accountId
date

campaignId?
adSetOrGroupId?
adId?

spend
currency

source
syncedAt
createdAt
updatedAt
```

Providers possíveis:

```text
META
GOOGLE_ADS
TIKTOK_ADS
PINTEREST_ADS
OTHER
```

Na V1:

```text
META
```

Google Ads deve poder ser conectado depois sem mudar o modelo financeiro.

Se o Google Ads já estiver disponível no projeto no momento da execução, integrá-lo ao `TotalMediaSpend`.

---

# 53Q. Economia do pedido

Criar ou derivar uma estrutura lógica equivalente a:

```text
OrderEconomics
```

Por pedido:

```text
orderId

saleRevenue
productionCost

productProfit
productMargin

paymentFees?
shippingSubsidy?
refundAmount?

createdAt
```

Os campos opcionais entram conforme os dados realmente existentes.

O custo de produção deve vir do webhook existente.

Não recalcular custo usando preço médio ou catálogo se o webhook já forneceu o valor real.

---

# 53R. Atribuição do pedido

Separar de `OrderEconomics`.

Estrutura futura/conceitual:

```text
OrderAttribution
```

Exemplo:

```text
orderId

provider
source
medium

campaignId?
adSetId?
adId?

utmCampaign?
utmContent?
utmTerm?

gclid?
fbclid?

model
confidence
attributionShare
```

Isso permite responder:

```text
qual campanha trouxe a venda?
```

sem alterar o custo financeiro real do pedido.

---

# 53S. Custo de aquisição estimado por pedido

Depois que UTM + GA4 + Meta/Google estiverem maduros, podemos mostrar:

```text
Custo de aquisição atribuído
```

no detalhe do pedido.

Mas deve aparecer explicitamente como:

```text
Estimado / atribuído
```

e nunca como custo contábil exato.

Exemplo:

```text
Pedido #123

Venda                    R$ 129,90
Produção                  R$  75,00
Lucro do Produto          R$  54,90

Origem atribuída          Meta
Campanha                  Cidades SC
Custo aquisição estimado  R$  24,80

Margem após aquisição*    R$  30,10

*estimativa analítica baseada na atribuição
```

---

# 53T. Performance por produto / estampa

Com tracking confiável, o painel poderá produzir:

| Produto | Receita | Produção | Lucro Produto | Mídia atribuída* | Lucro após aquisição* |
|---|---:|---:|---:|---:|---:|

Também:

```text
ROAS
ROAS de Margem
CPA
Margem %
Break-even ROAS
```

O asterisco deve indicar métricas dependentes de atribuição.

---

# 53U. Performance por campanha com margem real

Esse será um diferencial importante.

Em vez de apenas:

```text
Campanha
Gasto
Receita Meta
ROAS
```

poderemos mostrar:

```text
Campanha
Gasto
Pedidos atribuídos
Receita real atribuída*
Custo real de produção desses pedidos*
Margem de produto atribuída*
ROAS
ROAS de margem*
Resultado após mídia*
```

As métricas com `*` dependem do vínculo confiável pedido ↔ campanha.

---

# 53V. Dashboard financeiro

Criar uma visão consolidada semelhante a uma DRE operacional, mas alimentada pelos dados reais do painel.

Exemplo:

```text
RESULTADO — SETEMBRO

Receita Real                    R$ 23.471,05

(-) Custo de Produção           R$ 12.599,76
────────────────────────────────────────────
Lucro do Produto                R$ 10.871,29
Margem do Produto                    46,32%

(-) Meta Ads                    R$  8.825,35
(-) Google Ads                  R$      0,00
────────────────────────────────────────────
Lucro após Mídia                R$  2.045,94
Margem após Mídia                     8,72%

(-) Taxas                       R$    223,06
(-) Outras despesas             R$      0,00
────────────────────────────────────────────
Lucro Operacional               R$  1.822,88
Margem Operacional                    7,77%
```

Os valores acima são apenas exemplo estrutural.

Nunca hardcodar.

---

# 53W. Visão diária

Além do mensal, permitir:

```text
Hoje
Ontem
7 dias
14 dias
30 dias
Mês
Personalizado
```

Exemplo de cards:

```text
Receita
R$ 424,90

Produção
R$ 217,86

Lucro do Produto
R$ 207,04

Meta Ads
R$ 216,43

Google Ads
R$ 0,00

Lucro após Mídia
-R$ 9,39
```

Essa visão substitui estimativas manuais por dados sincronizados.

---

# 53X. Despesas manuais e recorrentes

Para superar o controle financeiro simplificado da plataforma, preparar uma entidade de despesas operacionais.

Exemplo:

```text
Expense
```

Campos:

```text
id
workspaceId/storeId

category
description

amount
date

recurrence?
provider?
notes?

createdAt
updatedAt
```

Categorias iniciais:

```text
PAYMENT_FEES
TRAFFIC_MANAGER
DESIGNER
APPS
PLATFORM
SHIPPING
TAXES
OTHER
```

A implementação completa da gestão de despesas pode ser feita em etapa posterior, mas o modelo de cálculo financeiro deve prever esses custos.

---

# 53Y. Despesas automáticas × manuais

Origem do custo deve ser visível.

Exemplo:

```text
Meta Ads
R$ 8.825,35
Automático · Meta API
```

```text
Taxa de pagamento
R$ 223,06
Automático · Pedidos
```

```text
Designer
R$ 1.500,00
Manual · Recorrente
```

Isso aumenta a auditabilidade do financeiro.

---

# 53Z. Fonte de verdade financeira

Definir hierarquia:

```text
RECEITA
→ pedido real

PRODUÇÃO
→ webhook do pedido

MÍDIA
→ API oficial de cada plataforma

TAXAS
→ gateway/pedido quando disponível

DESPESAS FIXAS
→ cadastro financeiro/manual ou integração correspondente

ATRIBUIÇÃO
→ GA4 + UTM + click IDs + plataforma
```

A atribuição **não substitui nenhuma das fontes financeiras acima**.

Ela serve para explicar:

> de onde veio a venda?

O financeiro serve para responder:

> quanto realmente entrou, custou e sobrou?

---

# 53AA. Reconciliação

Criar verificações de consistência.

Exemplo:

```text
Meta Spend armazenado
vs.
Meta Spend retornado pela API

Pedidos contabilizados
vs.
Pedidos do período

Custo produção total
vs.
soma dos custos recebidos nos webhooks
```

Se houver divergência:

```text
Dados financeiros incompletos
```

e indicar a origem.

Nunca preencher ausência de custo com `0` silenciosamente.

---

# 53AB. Status de qualidade do dado

O dashboard financeiro deve poder indicar:

```text
Completo
Parcial
Aguardando sincronização
Com divergência
```

Exemplo:

```text
Lucro Operacional
R$ 1.822,88

● Parcial
Google Ads não conectado
```

Isso é especialmente importante para não apresentar um lucro artificialmente alto.

---

# 53AC. Comparação com a estimativa atual da INK

A INK pode continuar sendo usada como referência visual/operacional, mas o novo painel não deve copiar a lógica como fonte.

A proposta é construir uma visão mais confiável porque o painel possui:

```text
pedido
custo real de produção
Meta API
GA4
UTMs
e futuramente Google Ads API
```

Portanto podemos separar claramente:

```text
resultado financeiro real
```

de:

```text
atribuição de marketing
```

Essa deve ser uma premissa central da implementação.

---


# 54. GA4 × Meta

Não tentar forçar equivalência perfeita.

Exemplo de comparativo:

```text
                    Meta       GA4
Sessões               —        1.842
Cliques              2.104        —
Compras                 31         25
Receita atribuída   4.881      4.126
```

Cada plataforma mede uma coisa diferente.

Não mostrar campos não equivalentes como se fossem iguais.

---

# 55. UTM Tracker

Se já existir módulo de UTMs, reutilizar.

Caso não exista, apenas preparar interface; não criar outro projeto paralelo neste momento.

Padrão recomendado para Meta:

```text
utm_source=meta
utm_medium=paid_social
utm_campaign={{campaign.name}}
utm_content={{ad.name}}
utm_term={{adset.name}}
```

Idealmente também armazenar IDs quando a estratégia permitir:

```text
campaign_id
adset_id
ad_id
```

Nomes podem mudar.

IDs são mais confiáveis para associação.

---

# 56. Associação UTM → Meta

Criar camada futura de resolução:

```text
UTM / click metadata
        ↓
Meta campaign/adset/ad
        ↓
GA4 session
        ↓
order
```

Prioridade de associação:

```text
1. IDs
2. parâmetros explícitos
3. nomes normalizados
```

Evitar associação fuzzy como fonte principal.

---

# 57. Produto / estampa

A V1 não deve inventar associação anúncio → produto.

Somente mostrar performance por produto quando existir dado confiável, como:

- UTM com product_id;
- landing page específica;
- URL de produto;
- catálogo Meta com product_id;
- associação manual;
- pedido atribuído com chave persistida.

Quando implementado, permitir:

| Produto | Gasto | Cliques | Compras | Receita | CPA | ROAS |
|---|---:|---:|---:|---:|---:|---:|

Mas não inferir por nome do anúncio sem deixar isso explícito.

---

# 58. Filtros globais

O módulo deve usar o mesmo DateRangePicker do GA4.

Presets:

```text
Hoje
Ontem
Últimos 7 dias
Últimos 14 dias
Últimos 30 dias
Este mês
Mês passado
Personalizado
```

Comparação:

```text
Período anterior
Mesmo período do mês anterior
Sem comparação
```

---

# 59. Timezone

A Meta possui timezone da conta.

GA4 também possui timezone da propriedade.

A loja pode possuir outro timezone.

Definir claramente a timezone usada nos dashboards.

Preferência:

```text
timezone da loja/workspace
```

Normalizar datas no backend.

Evitar agrupar um mesmo pedido em dias diferentes por timezone.

---

# 60. Cache

Utilizar o mecanismo existente.

Sugestão:

```text
overview: 5 min
tables: 5 min
historical timeseries: 15 min
```

Não cachear credenciais.

Invalidar caches relevantes após sync manual.

---

# 61. Estado da integração

Tela:

```text
Meta Ads

Status: Conectado
Conta: Use Origens
ID: act_••••••••1234
Última sincronização: 13:20
Último sync: sucesso

[ Sincronizar agora ]
[ Reconectar ]
[ Desconectar ]
```

Se houver erro:

```text
Atenção necessária
Token expirado

[ Reconectar Meta ]
```

---

# 62. Estados de loading

Evitar spinner global longo.

Usar:

- skeleton nos cards;
- skeleton na tabela;
- indicador de sync;
- progress da importação inicial.

Exemplo:

```text
Importando histórico Meta
42 / 90 dias
```

---

# 63. Empty states

## Sem integração

```text
Conecte sua conta Meta Ads

Acompanhe campanhas, conjuntos, anúncios, criativos,
gasto, CPA e ROAS diretamente no painel.

[ Conectar Meta ]
```

## Conta sem anúncios

```text
Nenhuma campanha encontrada neste período.
```

## Sem conversões

Não mostrar:

```text
ROAS 0
```

se não houver base adequada.

Preferir:

```text
—
```

com tooltip.

---

# 64. Erros amigáveis

Mapear erros técnicos.

Exemplos:

```text
META_TOKEN_EXPIRED
META_PERMISSION_DENIED
META_RATE_LIMIT
META_ACCOUNT_NOT_FOUND
META_API_ERROR
META_SYNC_FAILED
```

Frontend traduz:

```text
Sua conexão com a Meta expirou.
Reconecte a conta para continuar sincronizando os dados.
```

---

# 65. Observabilidade

Adicionar logs estruturados:

```text
provider
tenantId
adAccountId
syncType
dateFrom
dateTo
duration
records
apiCalls
errorCode
```

Nunca incluir:

```text
accessToken
appSecret
```

---

# 66. Testes

## Unitários

Testar:

```text
MetaActionMapper
Meta monetary parser
ROAS
CPA
MER
date normalization
pagination
rate limit handler
```

Casos obrigatórios:

```text
actions ausente
actions vazio
purchase duplicado em action types diferentes
spend = 0
purchases = 0
purchaseValue = 0
campo null
campo string numérica
```

---

# 67. Testes de integração

Mockar Meta API.

Testar:

```text
connect
account discovery
campaign sync
adset sync
ad sync
insights sync
pagination
token expired
permission denied
rate limit
partial failure
```

---

# 68. Não quebrar GA4

A integração Meta deve ser independente.

Falha Meta:

```text
GA4 continua funcionando
```

Falha GA4:

```text
Meta continua funcionando
```

Tela consolidada deve mostrar dados disponíveis e avisar quais fontes estão indisponíveis.

---

# 69. Performance

Não fazer queries N+1 para:

```text
campaign → adset → ads → insights
```

Criar queries agregadas.

Pré-agregar quando necessário.

Dashboard de 30 dias com centenas de anúncios deve continuar responsivo.

---

# 70. Feature flags

Se o projeto possuir feature flag:

```text
analytics.meta.enabled
```

usar.

Caso contrário, não adicionar biblioteca/serviço de feature flags apenas por causa desta integração.

---

# 71. Preparação para planos do SaaS

Meta Analytics poderá futuramente pertencer a um plano específico.

A implementação deve permitir controle:

```text
feature: meta_analytics
```

Não espalhar regras como:

```ts
if (plan === 'pro')
```

por componentes.

Centralizar capabilities/plano conforme padrão existente.

---

# 72. Fase 1 — fundação

Implementar primeiro:

- provider Meta;
- credenciais;
- teste de conexão;
- ad account;
- campaigns;
- adsets;
- ads;
- banco;
- sync log.

Critério:

> conta Meta conectada e hierarquia de mídia persistida.

---

# 73. Fase 2 — Insights

Implementar:

- account insights;
- campaign insights;
- adset insights;
- ad insights;
- parser de actions;
- snapshots diários;
- sync incremental;
- backfill.

Critério:

> backend consegue retornar métricas consistentes por período.

---

# 74. Fase 3 — UI Meta Ads

Implementar:

```text
Visão Geral
Campanhas
Conjuntos
Anúncios
```

Critério:

> usuário consegue navegar por toda a hierarquia e comparar performance.

---

# 75. Fase 4 — Criativos

Implementar:

```text
thumbnail
tipo
métricas
vídeo
ranking
badges analíticos
```

Critério:

> usuário consegue identificar rapidamente quais criativos estão performando melhor.

---

# 76. Fase 5 — Analytics consolidado + financeiro

Implementar:

```text
Meta
GA4
Loja

Receita Real
Custo de Produção (webhook)
Lucro do Produto
Meta Spend
Google Ads Spend, quando conectado
Total Media Spend
Lucro após Mídia

MER
ROAS de Margem
Break-even ROAS
Blended CAC

Atribuição
```

Se taxas e despesas operacionais já estiverem disponíveis:

```text
Lucro Operacional
Margem Operacional
```

Critério:

> painel apresenta receita real, custo real de produção e gasto real de mídia sem depender da atribuição para fechar o financeiro; receitas atribuídas continuam separadas para análise de marketing.

---

# 77. Fase 6 — UTM / atribuição avançada

Somente depois da integração principal estar estável.

Implementar:

```text
Meta IDs
UTMs
GA4
orders
products
```

Criar visão:

```text
Campanha
  ↓
Conjunto
  ↓
Anúncio
  ↓
Sessão
  ↓
Produto
  ↓
Pedido
```

sempre distinguindo:

```text
observado
atribuído
inferido
```

---

# 78. Critérios de aceite da V1

A entrega não está concluída até que:

- [ ] Meta possa ser conectada;
- [ ] conta de anúncios possa ser selecionada;
- [ ] conexão possa ser testada;
- [ ] campaigns sejam sincronizadas;
- [ ] adsets sejam sincronizados;
- [ ] ads sejam sincronizados;
- [ ] Insights sejam armazenados por dia;
- [ ] paginação Meta esteja funcionando;
- [ ] token expirado seja tratado;
- [ ] rate limit seja tratado;
- [ ] sync incremental esteja funcionando;
- [ ] backfill esteja funcionando;
- [ ] Visão Geral Meta esteja funcional;
- [ ] tabela de Campanhas esteja funcional;
- [ ] tabela de Conjuntos esteja funcional;
- [ ] tabela de Anúncios esteja funcional;
- [ ] página de Criativos esteja funcional;
- [ ] filtros de período funcionem;
- [ ] comparação de períodos funcione;
- [ ] Meta Purchases seja separado de pedidos reais;
- [ ] Meta Revenue seja separado de receita real;
- [ ] GA4 Revenue seja separado de receita Meta;
- [ ] MER esteja disponível;
- [ ] custo de produção do webhook seja utilizado como fonte de verdade;
- [ ] Lucro do Produto seja calculado como Receita Real - Custo de Produção;
- [ ] gasto real Meta seja descontado apenas uma vez no financeiro;
- [ ] camada financeira seja provider-agnostic para receber Google Ads;
- [ ] Total Media Spend seja separado de mídia atribuída por pedido;
- [ ] Lucro após Mídia esteja disponível;
- [ ] ROAS de Margem esteja disponível;
- [ ] Break-even ROAS esteja disponível quando houver margem suficiente para cálculo;
- [ ] Blended CAC esteja disponível;
- [ ] o painel sinalize quando o resultado financeiro estiver parcial por falta de alguma integração;
- [ ] estados de loading/erro/vazio estejam tratados;
- [ ] tokens não sejam expostos;
- [ ] testes principais passem;
- [ ] documentação técnica seja atualizada.

---

# 79. Definições de métricas

Centralizar em um arquivo/serviço.

## CTR

```text
CTR =
Clicks
-------
Impressions
× 100
```

Quando usar CTR retornado pela Meta, manter consistência em todo o dashboard.

---

## CPC

```text
CPC =
Spend
------
Clicks
```

---

## CPM

```text
CPM =
Spend
---------
Impressions
× 1000
```

---

## CPA

```text
CPA =
Spend
---------
Purchases
```

---

## ROAS

```text
ROAS =
Meta Purchase Value
-------------------
Meta Spend
```

---

## MER observado

```text
MER =
Real Store Revenue
------------------
Connected Media Spend
```

Enquanto apenas Meta Ads estiver conectado:

```text
Connected Media Spend = Meta Spend
```

---

# 80. DTO de overview sugerido

Exemplo conceitual:

```ts
type MetaOverview = {
  period: {
    from: string
    to: string
    timezone: string
  }

  spend: number
  impressions: number
  reach: number
  frequency: number

  clicks: number
  outboundClicks: number
  ctr: number | null
  cpc: number | null
  cpm: number | null

  purchases: number
  purchaseValue: number
  cpa: number | null
  roas: number | null

  previousPeriod?: {
    spend: number
    purchases: number
    purchaseValue: number
    cpa: number | null
    roas: number | null
  }

  lastSyncedAt: string | null
}
```

---

# 81. DTO consolidado sugerido

```ts
type AnalyticsOverview = {
  period: {
    from: string
    to: string
  }

  store: {
    orders: number
    revenue: number
    averageOrderValue: number | null
  }

  meta: {
    spend: number
    attributedPurchases: number
    attributedRevenue: number
    cpa: number | null
    roas: number | null
  } | null

  ga4: {
    sessions: number
    purchases: number
    attributedRevenue: number
    conversionRate: number | null
  } | null

  blended: {
    connectedMediaSpend: number
    mer: number | null
  }
}
```

---

# 82. UX importante

Não criar um dashboard excessivamente colorido.

Seguir o design system atual.

Prioridades:

```text
hierarquia
legibilidade
densidade adequada
comparação
filtros rápidos
drill-down
```

Usar badges de status de forma consistente com o painel atual.

---

# 83. Mobile

Analytics deve ser utilizável em tablet/mobile, mas não sacrificar o desktop.

Tabelas podem usar:

```text
horizontal scroll
```

ou cards responsivos quando fizer sentido.

Não esconder métricas importantes silenciosamente.

---

# 84. Exportação futura

Preparar backend para futuramente permitir:

```text
CSV
XLSX
```

Não é necessário implementar agora.

Evitar API interna que retorne dados apenas no formato visual da tabela.

---

# 85. Gestão Meta futura

A arquitetura criada deve possibilitar um módulo separado:

```text
Meta Ads > Gestão
```

com:

```text
pause
resume
budget
campaign creation
adset creation
ad creation
```

Mas **não implementar na V1**.

Quando isso ocorrer, criar camada separada:

```text
MetaReadService
MetaManagementService
```

para reduzir risco.

---

# 86. Estrutura sugerida de código

Adaptar ao projeto existente.

Exemplo:

```text
src/
  integrations/
    meta/
      meta.client.ts
      meta.auth.ts
      meta.service.ts
      meta.insights.service.ts
      meta.sync.service.ts
      meta.actions.mapper.ts
      meta.types.ts
      meta.errors.ts

  analytics/
    meta/
      meta.analytics.service.ts
      meta.analytics.controller.ts

    attribution/
      attribution.service.ts

  jobs/
    meta-sync.job.ts
    meta-backfill.job.ts
```

Frontend:

```text
features/
  analytics/
    meta/
      MetaOverview
      MetaCampaigns
      MetaAdSets
      MetaAds
      MetaCreatives

    attribution/
      AttributionOverview
```

**Não seguir esses caminhos literalmente se o projeto já possuir outra convenção.**

---

# 87. Estratégia de implementação para o Claude

Claude deve executar nesta ordem:

```text
1. Auditar arquitetura atual
2. Identificar padrão do GA4
3. Escrever plano de arquivos afetados
4. Criar migration/schema
5. Criar Meta API client
6. Criar connection flow
7. Criar sync de entidades
8. Criar Insights mapper
9. Criar sync diário
10. Criar endpoints internos
11. Criar UI Meta
12. Criar Analytics consolidado
13. Criar testes
14. Atualizar documentação
```

Não começar pela UI fake antes do backend.

---

# 88. Regra para mocks

Mocks são permitidos apenas durante desenvolvimento de componentes.

Antes de concluir:

```text
nenhum número do dashboard pode vir de mock
```

A origem deve ser:

```text
Meta API sincronizada
GA4
Loja
```

---

# 89. Regra para nomes e atribuição

Sempre diferenciar:

```text
Meta Purchases
GA4 Purchases
Store Orders
```

e:

```text
Meta Attributed Revenue
GA4 Attributed Revenue
Store Revenue
```

Nunca unificar os três silenciosamente.

---

# 90. Definição de sucesso

A integração estará realmente útil quando a tela conseguir mostrar algo como:

```text
Últimos 7 dias

Receita real da loja
R$ 21.400

Pedidos reais
158

Meta Spend
R$ 4.320

Meta Purchases
141

Meta Attributed Revenue
R$ 19.080

Meta CPA
R$ 30,64

Meta ROAS
4,42x

GA4 Purchases
128

GA4 Attributed Revenue
R$ 17.920

MER observado
4,95x
```

e permitir descer até:

```text
Campanha
  ↓
Conjunto
  ↓
Anúncio
  ↓
Criativo
```

sem precisar abrir o Ads Manager para a análise diária básica.

---

# 91. Observação sobre a API da Meta

A Meta Marketing API suporta consulta de Insights em níveis como:

```text
account
campaign
adset
ad
```

e os endpoints retornam coleções paginadas.

A integração deve implementar paginação corretamente e não assumir que uma única chamada contém todos os resultados.

A Meta também trabalha com configurações/janelas de atribuição; por isso dados de conversão podem ser reprocessados e mudar posteriormente.

Isso justifica o:

```text
backfill periódico
```

descrito neste documento.

---

# 92. Referências oficiais úteis

Meta Marketing API / coleção oficial no Postman:

```text
https://www.postman.com/meta/facebook-marketing-api/overview
```

Documentação da coleção Marketing API:

```text
https://www.postman.com/meta/facebook-marketing-api/documentation/
```

Antes de implementar requests definitivos, confirmar na documentação oficial:

- versão Graph API vigente;
- campos atualmente disponíveis;
- permissões necessárias;
- limites;
- campos deprecated;
- janelas de atribuição aceitas.

**Não copiar cegamente uma versão antiga da API de exemplos encontrados na internet.**

---

# 93. Entrega esperada do Claude

Ao finalizar, gerar resumo:

```text
## Implementado

## Arquivos criados

## Arquivos alterados

## Migrations

## Variáveis de ambiente

## Rotas adicionadas

## Jobs adicionados

## Permissões Meta necessárias

## Como conectar

## Como testar

## Limitações atuais

## Próximas evoluções
```

Também atualizar o documento de estado atual do painel.

---

# 94. Próximas evoluções possíveis — não implementar agora

Após a V1 estabilizar:

```text
Meta CAPI diagnostics
Pixel diagnostics
Google Ads
TikTok Ads
criativos com IA
alertas de performance
anomaly detection
sugestão de escala
sugestão de pausa
budget pacing
forecast
LTV por canal
cohort por origem
atribuição por produto
atribuição por estampa
profit ROAS
contribution margin
```

A camada de **margem e lucro após mídia já faz parte da arquitetura principal**, porque o painel possui custo real de produção via webhook.

Atribuições avançadas por pedido/produto continuam como evolução posterior, mas o fechamento financeiro agregado não deve esperar por elas.

Manter como evoluções futuras:

```text
atribuição de custo de mídia por pedido
profitabilidade por campanha usando pedidos reconciliados
profitabilidade por estampa
LTV líquido por canal
margem por cohort
forecast financeiro
```

O financeiro agregado deve sempre usar:

```text
Receita real da loja
- custo real de produção
- gasto real das plataformas
- demais despesas reais disponíveis
```

e nunca depender exclusivamente da receita atribuída reportada pelas plataformas.

---

# 95. Regra final

A prioridade é:

> construir uma camada de dados confiável primeiro e uma interface bonita depois.

Evitar um dashboard visualmente completo sustentado por métricas inconsistentes.

A hierarquia de confiança deve ser:

```text
1. Receita/pedidos reais da loja
2. Dados brutos sincronizados das plataformas
3. Métricas calculadas
4. Atribuição
5. Recomendações
```

A V1 termina no nível 4.

Recomendações automatizadas ficam para uma etapa posterior.
