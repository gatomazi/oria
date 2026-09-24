# Adendo Rodada J — Auditoria: jornada de compra individual (Meta + GA4 + Commerce)

Executado em 2026-09-22, como extensão da Rodada J (`ORIA_ADENDO_RODADA_J_META_JORNADA_ATRIBUICAO.md`).
Este documento é o produto do **Gate A** (auditoria real, antes de qualquer implementação) e registra
a conclusão que decide se os Gates D/E do adendo são executáveis nesta rodada.

## Resultado em uma frase

**Nenhuma compra individual pode ser vinculada a uma origem de aquisição hoje**, porque nem a vitrine
nem o checkout que o cliente final usa são servidos por este código — e o cache local de pedidos
(`pedidos_ink`) não guarda nenhuma chave de correlação (UTM, click id, sessão, referência de jornada).
Isso não é uma falha de implementação desta rodada: é a ausência estrutural do dado, auditada por
leitura de schema/código, não por suposição.

## 1 — Mapa de fronteira de controle (achado decisivo do Gate A)

| Componente | Quem serve/controla | Está neste repositório? |
|---|---|---|
| Vitrine/Storefront do tenant piloto | Plataforma externa ("Use Origens", terceiro) | **Não** |
| Checkout | Domínio da Reserva Ink (terceiro) | **Não** |
| GA4 (tag no site) | Instalado no site do terceiro, fora do controle da Oria | **Não** (só o *connector* de leitura, `lib/connectors/analytics/ga4/`) |
| Meta Pixel/CAPI | Se existir, está instalado no site do terceiro | **Não** — não há nenhum código de Pixel/CAPI em `apps/panel` |
| Meta Ads (conexão atual) | `lib/meta/*`, `meta_connections` | **Sim**, mas é só Marketing API/Insights (ads-level, agregado) |
| Cache de pedidos Ink | `pedidos_ink`/`pedidos_ink_itens` (`migrations/sql/0001-baseline-schema.sql`) | **Sim** |

A Oria já serviu um storefront próprio no passado (`lib/arquivos-publicos.js`, comentário em
`server.js` por volta da linha 906: *"Aqui ficavam também as rotas do site da Orgulho Regional...
O site saiu — o produto deste repositório é o painel"*) — mas para o **tenant piloto atual**, a
vitrine é uma plataforma externa e o checkout é o hospedado pela própria Reserva Ink. Qualquer
instrumentação de `PageView`/`Search`/`ViewContent`/`AddToCart`/`InitiateCheckout`/`Purchase` só pode
ser verificada visitando essas páginas externas ao vivo (fora do escopo de leitura de código) e só
pode ser **alterada** com autorização explícita do dono dessas plataformas — nenhuma das duas está
sob controle deste código-fonte.

**Pré-requisito ausente para completar esta parte do Gate A**: URL real da vitrine do tenant piloto e,
se aplicável, acesso ao Meta Events Manager / Pixel Helper daquele domínio. Sem isso, a inspeção ao
vivo de quais eventos disparam fica **not_run** (não fabricada, não presumida).

## 2 — Meta: o que existe hoje no código

- `lib/meta/client.js`, `lib/meta/insights.js`, `lib/meta/actions.js`, `lib/meta/criativos.js` — tudo
  Marketing API / **Insights API** (`meta_insights_daily`, `CAMPOS_INSIGHTS` em `insights.js`):
  `impressions`, `reach`, `clicks`, `spend`, `actions`/`action_values` **agregados por
  campanha/adset/ad/dia**. Nenhuma chamada a Pixel/CAPI, nenhum evento por usuário/sessão.
- `meta_connections` (schema, `0001-baseline-schema.sql`): guarda `access_token_encrypted`,
  `meta_user_id`, `escopos` — **nenhuma coluna de `pixel_id` ou `dataset_id`**. A conexão Meta desta
  Oria nunca foi desenhada para ler eventos de Pixel/CAPI, só Ads Insights.
- Conclusão: `aggregatedProductEvents=true`, `eventLevel=false` para o domínio Meta nesta instalação.
  **Meta Ads e Meta Events já são, na prática, domínios estruturalmente separados** — não existe
  hoje nenhum caminho de ingestão de evento individual da Meta neste código.

## 3 — GA4: o que existe hoje no código

- `lib/connectors/analytics/ga4/connector.js` + `queries.js`: usa a **Data API** (`runReport`), com
  dimensão `itemId` (`DIMENSION_ITEM_ID`) e métricas de `METRICAS_PRODUTO` (`itemsViewed`,
  `itemsAddedToCart`, `itemsPurchased`, receita) — **sempre agregado por item, nunca por sessão ou
  transação**. Não há requisição de dimensão `transactionId` em nenhum ponto do connector.
- `google_analytics_connections` (schema): armazena `property_id`, tokens OAuth — **sem nenhum campo
  de BigQuery** (dataset/projeto). Não há BigQuery Export habilitado ou referenciado em nenhum lugar
  do código além de um comentário genérico em `lib/connectors/contracts.js`/`types.js` descrevendo o
  *contrato futuro* de `event_analytics`, nunca implementado.
- Conclusão: GA4 hoje é **só agregado** (`aggregate`, não `event`). Para vincular uma compra
  individual via `transaction_id`, seria necessário (a) adicionar a dimensão `transactionId` ao
  connector (mudança pequena, viável) **e/ou** (b) BigQuery Export, que exigiria habilitação/custo e
  autorização explícita — nenhuma das duas coisas foi feita nesta auditoria.

## 4 — Commerce (Ink): o que existe hoje no código

- `pedidos_ink` (schema completo revisado): `loja`, `ink_order_id`, `payment_status`, `order_status`,
  dados do comprador, valores, datas. **Nenhuma coluna de UTM, `fbclid`, `gclid`, `session_id`,
  `journey_id` ou qualquer referência de checkout.** Também não existe em nenhuma outra tabela do
  schema (`grep` por `utm|fbclid|gclid|click_id|referrer|landing` não encontrou nenhuma coluna de
  pedido com esse tipo de dado — só a ferramenta `utm_campaigns`/`utm_presets`, que é o **UTM
  Builder** de campanhas de mídia, para *criar* links com UTM, não para *capturar* de onde um pedido
  veio).
- `webhook_eventos` guarda `headers`/`body` brutos de cada webhook da Ink recebido — é a única fonte
  que poderia, em tese, conter algo além do que `pedidos_ink` persiste hoje (não auditado ao vivo:
  exigiria consultar produção, `not_run` nesta rodada).
- Conclusão: **`orderLink = missing` por padrão, estruturalmente**, para todo pedido existente e para
  todo pedido novo até que uma referência de jornada comece a ser propagada pelo checkout — o que
  depende da Ink (terceiro) devolver algo vinculável, auditoria não feita ao vivo nesta rodada.

## 5 — Identidade do produto: extensão viável sem migração

O resolver de identidade (`lib/product-analytics/product-identity-resolver.js`) já é
provider-agnostic por `namespace` (`<provider>.<tipo>`, ex.: `ga4.item_id`). Adicionar
`meta.content_id` é arquiteturalmente trivial — mesmo mecanismo de `resolveAndPersist` usado hoje
para GA4, sem alteração de schema. **Não implementado nesta rodada** porque não há nenhuma fonte
real de `contents[].id` da Meta disponível (Meta hoje só devolve agregados de Ads Insights, nunca IDs
de produto por evento) — implementar o namespace sem uma fonte de dado real seria exatamente o que
o adendo proíbe (§9: "não criar tabelas ou endpoints apenas para fingir uma jornada disponível").

## 6 — Por que zero compras puderam ser vinculadas por ID determinístico

Nenhuma. Motivo, por camada:

1. **Vitrine**: fora do repositório — não auditável ao vivo nesta rodada (falta URL/credencial).
2. **Checkout Ink**: fora do repositório — não auditável ao vivo nesta rodada; e mesmo que fosse,
   `pedidos_ink` (o único dado que chega de volta pra Oria) não tem coluna nenhuma para receber uma
   referência de jornada mesmo que o checkout a devolvesse.
3. **GA4**: só agregado por item, nunca por `transactionId` — não há como localizar a linha de uma
   compra específica no GA4 com o código atual.
4. **Meta**: só Ads Insights agregado — não existe evento individual da Meta acessível pelo código
   atual, em nenhuma hipótese.

Não existe hoje nenhuma chave determinística compartilhada entre pedido pago e qualquer evento de
analytics/anúncio. Registrar isso como lacuna estrutural é o resultado correto do Gate A — nenhuma
jornada foi fabricada por proximidade de horário ou SKU para preencher esse vazio.

## 7 — `platformAttribution` disponível (separado, nunca como prova de pedido individual)

- **GA4**: relatórios agregados de item existentes (Rodada H→J) — nunca por pedido.
- **Meta Ads**: Insights agregados por campanha/adset/ad existentes (`meta_insights_daily`) — nunca
  por pedido.
- **Google Ads**: só há UTM/gclid nos links criados pelo UTM Builder (`utm_campaigns`); não há conexão
  Google Ads com dados de conversão no código auditado.

## 8 — Privacidade e deduplicação

Não aplicável nesta rodada: nenhum evento novo foi capturado, nenhum Pixel/CAPI foi tocado, nenhuma
alteração de consentimento foi feita. Fica registrado como pré-condição para qualquer Gate D futuro:
antes de propagar `journey_id`/UTM/click id pela vitrine ou pelo checkout, validar consentimento e
política de retenção com o dono da vitrine (terceiro) — fora do escopo desta auditoria de código.

## 9 — Decisão sobre os Gates D/E do adendo

**Gate D (MVP de captura) e Gate E (leitura de atribuição por compra) não foram implementados nesta
rodada.** Justificativa, por regra do próprio adendo:

- §2 (Gate A) manda: "Se GA4 real/Meta real/checkout real não estiverem disponíveis, continuar com
  arquitetura, fakes e testes apenas onde fizer sentido, registrando `not_run`" — cumprido: este
  documento é o resultado de arquitetura/registro, sem fakes que simulem uma jornada real.
- §5 (Gate D) manda: implementar "somente se o Gate A sustentar" — o Gate A concluiu que tanto a
  vitrine quanto o checkout são de terceiros, fora do controle deste código, e nenhuma credencial
  Meta Events/Pixel ou GA4 BigQuery foi disponibilizada nesta sessão.
- §9 (limites) proíbe explicitamente: alterar checkout de terceiro, publicar Pixel/CAPI em produção,
  provisionar credenciais novas — exatamente o que qualquer Gate D real exigiria aqui.

Implementar tabelas/endpoints de jornada sem uma fonte real de evento seria fabricar infraestrutura
para uma jornada que não existe — o próprio adendo proíbe isso (§5, §9).

## 10 — Próximo passo preciso (menor conjunto de mudanças externas necessárias)

Para registrar a **primeira compra real com jornada rastreável**, nesta ordem de menor esforço:

1. **URL real da vitrine do tenant piloto** + confirmação de quem administra as tags nela (Use
   Origens é uma plataforma de terceiro — a Oria precisa de autorização/acesso para inspecionar ou
   propor mudança de tag).
2. **Confirmar com a Ink** se o checkout aceita algum parâmetro de referência opaca (`journey_id`) que
   sobrevive até o webhook/pedido — sem isso, `orderLink` continua `missing` para sempre, não importa
   o que a Oria implemente do seu lado.
3. Se (1) suportar Meta Pixel e (2) suportar uma referência de jornada: adicionar 2 colunas
   nullable a `pedidos_ink` (ex.: `journey_reference`, `utm_source_observado` — nomes finais a
   decidir com o dono do produto) via migration aditiva, e um pequeno endpoint de ingestão
   `journey_id`→checkout na Oria, sob a mesma `analytics_product_performance` entitlement.
4. Adicionar dimensão `transactionId` ao GA4 connector (mudança pequena, sem depender de terceiro) —
   viável desde já, mas só tem valor depois que (1)-(3) permitirem cruzar aquele `transactionId` com
   um pedido Commerce real.
5. Só depois disso caberia implementar `product_external_identities` namespace `meta.content_id` e o
   `OrderJourneyResolver` conceitual descrito no adendo (§1).

Nenhum desses 5 passos foi executado nesta rodada — todos dependem de decisão/acesso que só o
usuário (dono do produto/relacionamento com Use Origens e Reserva Ink) pode fornecer.
