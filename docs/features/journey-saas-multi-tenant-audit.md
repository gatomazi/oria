# Rodada K — Jornada de Compra como feature SaaS: auditoria multi-tenant

Executado em 2026-09-23, usando **somente** `ORIA_ADENDO_K_JORNADA_SAAS_MULTI_TENANT.md` como instrução
definitiva (prevalece sobre versões anteriores da Rodada K). Este documento **estende**
[`meta-jornada-atribuicao-audit.md`](./meta-jornada-atribuicao-audit.md) (auditoria anterior, ainda
válida no que é código-level) com evidência nova real: código do StoreFront (`useorigens`, repo local)
e inspeção ao vivo, somente leitura, das duas URLs reais do piloto que o usuário forneceu. Onde as duas
auditorias divergem, esta prevalece — porque reformula a conclusão de "limitação do piloto" para
"o que é a feature SaaS vs. o que é configuração deste tenant", como o adendo exige.

**Premissa confirmada e respeitada**: `Product Journey` é feature nativa do Oria, não específica da Use
Sul/Use Origens/Reserva Ink. A Use Sul é só a Organization piloto. Nada abaixo hardcoda tenant — os
achados sobre `useorigens.com.br`/`usesul.com.br`/Pixel `1558923262073052` são **dados de configuração
do piloto**, citados só como evidência, nunca como default de código.

## Fontes desta auditoria

1. Leitura de código do painel Oria (`apps/panel/lib/connectors/*`, `apps/panel/migrations/sql/*`) —
   já feita na rodada anterior, reconfirmada aqui.
2. Leitura de código do repo real do StoreFront do piloto: `/Users/gtomazi/projects/useorigens`
   (`github.com/gatomazi/useorigens-storefront`, branch `main`, HEAD `71b9a7e`) — **novo nesta rodada**.
3. Inspeção ao vivo, somente leitura (sem formulário, sem carrinho, sem compra), de
   `https://useorigens.com.br/sul` e `https://www.usesul.com.br/usesul` via Claude in Chrome —
   **novo nesta rodada**, only-read network/DOM inspection.

---

## 1. Quais fontes de jornada o Oria consegue consumir hoje

| Fonte | Consumível pelo Oria hoje? | Como |
|---|---|---|
| GA4 (agregado) | **Sim** | `lib/connectors/analytics/ga4/` — Data API, `AnalyticsConnector.getProductPerformance` |
| GA4 (event-level/BigQuery) | **Não** | Sem BigQuery Export configurado em nenhuma conexão; nenhum código o consulta |
| Meta Ads (agregado) | **Sim** | `lib/meta/*` — Marketing API Insights |
| Meta Pixel/CAPI (event-level) | **Não** | Nenhum código no painel lê Pixel/CAPI; o contrato (`EventAnalyticsConnector`) existe em `lib/connectors/types.js` mas **nenhum provider o implementa** |
| Commerce (Ink, pedidos pagos) | **Sim** | `lib/connectors/commerce/reserva-ink/` — cache local `pedidos_ink` |
| StoreFront (eventos de navegação) | **Não, diretamente** | O StoreFront (`useorigens`) é um repo/deploy separado; o painel Oria não recebe nada dele hoje — o que ele manda vai só para a Meta (Pixel do navegador), nunca para o Oria |

## 2. Quais são apenas agregadas

GA4 (`getProductPerformance`, dimensão `itemId`) e Meta Ads (`meta_insights_daily`) — ambas confirmadas
por leitura de código, sem nenhuma chamada a evento individual em nenhum dos dois.

## 3. Quais podem fornecer evento individual

Nenhuma, hoje, **para o Oria**. Mas a inspeção ao vivo mostra que evento individual **existe e já está
sendo capturado por terceiros**, fora da visão do Oria:

- O StoreFront (`useorigens.com.br/sul`) dispara `PageView`/`Search`/`SelectCity`/`GoToInk` para o Meta
  Pixel (`1558923262073052`) diretamente do navegador do visitante — real, consent-gated, confirmado por
  código (`src/components/analytics/MetaPixel.tsx`, `src/lib/analytics/track.ts`) e por inspeção ao vivo
  (nenhuma chamada de rede à Meta antes de aceitar o banner de consentimento; nenhum `fbq`/`gtag` no
  `window` antes disso).
- O checkout (`usesul.com.br`, hospedado pela Reserva Ink) tem **seu próprio** Meta Pixel — mesmo ID
  `1558923262073052` — e **duas** tags GA4 (`G-T6BS328VRE` direto + `G-8GYTEJ1F77` via Google Tag
  Manager, evento `virtualPageView`), confirmadas por rede real (`connect.facebook.net/signals/config/…`,
  `facebook.com/tr/?id=1558923262073052`, `google-analytics.com/g/collect?tid=G-T6BS328VRE`) — nenhuma
  dessas contas é conhecida ou lida pelo Oria hoje.

Ou seja: **evento individual existe, em pelo menos 3 streams diferentes (Pixel do StoreFront, Pixel do
checkout, 2 GA4 do checkout), nenhum deles acessível ou correlacionado pelo Oria.**

## 4. Quais IDs existem em cada etapa

| Etapa | Sistema | ID observado |
|---|---|---|
| Visita StoreFront | Meta Pixel (StoreFront) | `fbp` (cookie de `useorigens.com.br`), `fbclid` só se vier na URL de entrada |
| Busca/seleção de cidade | Meta Pixel (custom `SelectCity`) | sem ID de sessão próprio do Oria — nenhum `journey_id` existe |
| Clique para a loja | Meta Pixel (custom `GoToInk`) | `product_id` real (o `inkProductId` do catálogo) — **não** um ID de sessão/jornada |
| Chegada no checkout | Meta Pixel (checkout, mesmo `1558923262073052`) + GA4 (`G-T6BS328VRE`, `G-8GYTEJ1F77`) | `fbp` **novo**, gerado no domínio `usesul.com.br` (cookies não atravessam domínio); `fbc`/`fbclid` só se a URL de chegada já os tivesse |
| Pedido pago | Commerce (Ink) | `ink_order_id` (`pedidos_ink.ink_order_id`) — nenhuma referência de jornada |

## 5. Quais IDs realmente podem fechar o vínculo hoje

**Nenhum, ponta a ponta.** Achado decisivo, por leitura direta de código do StoreFront:

```ts
// useorigens: src/lib/catalog/commerce.ts
export function purchaseUrl(product) {
  const url = new URL(product.storeProductUrl); // URL EXATA que a Ink devolveu
  if (url.protocol !== "https:") return null;
  return ALLOWED_COMMERCE_HOSTS.has(url.host) ? url.toString() : null; // nenhum query param é adicionado
}
```

O link "ir para a loja" nunca leva UTM, `fbclid`, `gclid` nem qualquer referência opaca — mesmo quando o
visitante chegou ao StoreFront com esses parâmetros na URL. **Isso não é uma limitação do checkout (a Ink
provavelmente aceitaria query params — não testado, ver §9); é uma decisão/lacuna do lado do StoreFront,
que hoje não propaga nada.** Esse é o único ponto de reparo necessário para o vínculo determinístico
existir — e é genérico: qualquer cliente com um StoreFront próprio na mesma posição teria a mesma lacuna,
resolvida da mesma forma (propagar o que já foi capturado).

## 6. `transactionId` GA4 ↔ Commerce order — pode ligar?

**Não hoje, e não por falta de suporte técnico — por falta de implementação em ambos os lados,
confirmada por código:**

- O `AnalyticsConnector` do Oria (`lib/connectors/analytics/ga4/`) nunca requisita a dimensão
  `transactionId` — só `itemId` agregado. Adicionar essa dimensão é uma mudança pequena e genérica no
  connector GA4 (não específica de tenant), mas **sem uma conexão GA4 real para validar contra, seria
  implementação especulativa** — o próprio adendo proíbe isso (§ "Não quero uma implementação grande
  baseada em hipóteses"). Não implementado nesta rodada.
- Não há evidência de que o GA4 do checkout (`G-T6BS328VRE`/`G-8GYTEJ1F77`, vistos ao vivo) sequer emite
  `purchase` com `transaction_id` igual ao `ink_order_id` — **`not_verified`**: exigiria completar um
  pedido real de teste (proibido nesta rodada) ou acesso de leitura à própria conta GA4 do checkout, que
  o Oria não tem e provavelmente nunca teve razão de ter (é uma conta de terceiro, da Ink/loja, distinta
  da que o tenant conectaria ao Oria).

## 7. Como Meta poderia entrar na jornada

Dois papéis, já distintos na arquitetura existente (`lib/connectors/contracts.js`, domínios `ads` vs
`event_analytics`, comentário citando `docs/features/ORIA_PRODUCT_ANALYTICS_CONNECTOR_ARCHITECTURE_V2.md
§14.2`):

1. **`ads/meta`** (já existe): Insights agregado — o que já está implementado, nunca prova pedido
   individual.
2. **`event_analytics/meta`** (contrato já existe em `lib/connectors/types.js` —
   `EventAnalyticsConnector`, `NormalizedJourneyEvent`, capabilities `aggregatedProductEvents`/
   `eventLevel` — mas **nenhum provider o implementa**): entraria só quando houver uma fonte real de
   evento individual acessível ao Oria. A Marketing API não devolve histórico bruto de Pixel por usuário
   — a única forma realista é o **próprio StoreFront** (quando o Oria o controla, como é o caso do
   `useorigens`) mandar os eventos que ele já dispara para o Pixel **também** para um endpoint de
   ingestão do Oria (ownership do dado passa a ser do Oria, não da Meta) — conceito já previsto em
   `ORIA_PRODUCT_ANALYTICS_CONNECTOR_ARCHITECTURE_V2.md §14.19` como "Oria Event Ingestion / Web SDK
   opcional". Não implementado nesta rodada (ver §12 — "não fazer").

## 8. Lacunas entre StoreFront e checkout

Confirmadas por código + rede real:

- **Nenhuma referência propagada** do StoreFront para o checkout (§5).
- **Cookies não atravessam** `useorigens.com.br` → `usesul.com.br` (domínios diferentes) — qualquer
  vínculo de sessão via cookie first-party é estruturalmente impossível; só um identificador opaco
  explícito na própria URL resolveria isso (exatamente o que o adendo pede em §6: "preferir identificador
  opaco explícito... após comprovação do caminho ponta a ponta" — comprovação essa que não foi feita
  nesta rodada, porque exigiria alterar o checkout de terceiro sem autorização).
- **Mesmo Pixel ID nos dois domínios** (achado novo, real): reduz fragmentação do lado Meta (a conta de
  anúncios enxerga os dois domínios sob um só Pixel), mas isso é correspondência **probabilística da
  própria Meta** (matching interno, não auditável, não determinístico do ponto de vista do Oria) — nunca
  deve ser apresentado como prova de vínculo de uma compra específica.

## 9. Quais partes são específicas do tenant piloto

- URLs (`useorigens.com.br/sul`, `usesul.com.br/usesul`), o Pixel `1558923262073052`, e o fato de o
  GA4 do checkout já estar ativo (`G-T6BS328VRE`/`G-8GYTEJ1F77`) — **tudo configuração deste tenant**,
  nunca hardcodado em código de domínio nesta auditoria nem em nenhuma implementação anterior.
- O fato de existirem DOIS domínios separados (StoreFront ≠ checkout) — específico deste tenant (Cliente
  B do adendo, "loja/checkout no mesmo domínio", seria diferente).
- O fato de o checkout ser hospedado por um Commerce provider externo (Reserva Ink) sem capability de
  passthrough de jornada comprovada — pode ou não ser específico; não testado (ver §12).

## 10. Quais partes pertencem ao produto Oria

- `AnalyticsConnector`/`EventAnalyticsConnector`/`AdsConnector`/`CommerceConnector` (contratos por
  domínio, `lib/connectors/*`) — já genéricos, já provider-agnostic, confirmados por leitura de código.
- `Product Identity Resolver` (`lib/product-analytics/product-identity-resolver.js`) — namespace
  `<provider>.<tipo>` já suporta qualquer provider (incluindo um futuro `meta.content_id`) sem migração.
- `CommerceOrder.providerOrderId` — já genérico no contrato (`lib/connectors/types.js:120`), não
  Ink-específico; **falta** um campo opcional de referência de jornada (`journeyReference`/
  `checkoutReference`), que nenhum provider preenche hoje.
- A distinção `ads` vs `event_analytics` como domínios separados — já é arquitetura do produto, não do
  piloto (`lib/connectors/contracts.js` comentário §14.2).

## 11. Arquitetura proposta para Journey

**Já existe, desenhada e não implementada**, em
`docs/features/ORIA_PRODUCT_ANALYTICS_CONNECTOR_ARCHITECTURE_V2.md` §14.13–14.20 e §15–18: Event
Normalization/Provenance → Tenant-scoped Journey/Correlation Layer, alimentada por
`EventAnalyticsConnector` + `AnalyticsConnector` + `CommerceConnector` + `Product Identity Resolver`,
com `NormalizedJourneyEvent` já tipado (`sessionKey`, `orderId`, `providerEventId`,
`externalProductId`/`Namespace`, proveniência). Esta rodada **confirma que esse desenho já satisfaz** o
diagrama pedido pelo adendo K §3 — não há necessidade de redesenhar; a lacuna é 100% de implementação
(nenhum `EventAnalyticsConnector` real) e de dado disponível (nenhuma fonte event-level acessível hoje).

## 12. Modelo de correlação recomendado

Conforme já escrito em `meta-jornada-atribuicao-audit.md` §6/§9, agora generalizado para qualquer
tenant: aceitar apenas `journey_id`/`checkout_reference` preservado, `transactionId` comprovadamente
igual, ou `event_id` comum entre browser/server para o mesmo evento lógico. Nunca por produto+hora+valor
próximos. Isso já é o padrão desta auditoria (nenhuma correlação por proximidade foi usada em nenhum
achado acima).

## 13. Estados complete/partial/unresolved

Proposta conceitual (sem endpoint/schema criado nesta rodada):

- **`complete`**: pedido pago com `journeyReference` recuperado E pelo menos um evento de cada estágio
  (`landing`→`purchase_observed`) correlacionado por ID determinístico.
- **`partial`**: pedido pago com identidade de produto resolvida, mas sem referência de sessão/jornada
  (é o estado de **100% dos pedidos hoje**, no piloto e em qualquer tenant nas mesmas condições).
- **`unresolved`**: pedido pago sem nenhuma correlação possível (produto não identificado, ou sem
  nenhuma fonte analytics disponível).

## 14. Blockers reais

1. StoreFront não propaga UTM/click id/referência para o checkout (`purchaseUrl()`, §5) — **resolvível
   sem depender de terceiro**, é código do próprio Oria/tenant-owner do StoreFront.
2. Checkout de terceiro (Reserva Ink) — capability de receber/devolver uma referência de jornada
   **não testada** (exigiria autorização para alterar ou inspecionar mais a fundo o fluxo real de
   checkout de terceiro; fora do escopo desta rodada). `not_verified`.
3. GA4 do checkout já ativo, mas de conta desconhecida do Oria — `not_verified` se emite `transaction_id`
   compatível.
4. Nenhum `EventAnalyticsConnector` implementado — bloqueio de implementação, não de arquitetura.
5. Acesso a produção (DB real do Oria) segue bloqueado nesta sessão (mesma limitação já registrada na
   Rodada J) — não impede esta auditoria, que é toda código+inspeção ao vivo read-only.

## 15. Menor próxima implementação genérica recomendada

Nesta ordem, cada uma independente de particularidade da Use Sul:

1. **StoreFront**: capturar UTMs/`fbclid`/`gclid` de entrada (já há uma base de consentimento pronta,
   `ConsentProvider`) e propagá-los como query string no `purchaseUrl()` gerado — mudança pequena,
   genérica (vale para qualquer StoreFront que o Oria controle), sem tocar checkout de terceiro.
2. **Commerce contract**: adicionar campo opcional `journeyReference`/`checkoutReference` a
   `CommerceOrder` (`lib/connectors/types.js`) — aditivo, genérico, sem migração obrigatória (fica
   `null` até um provider o preencher).
3. **Confirmar com a Reserva Ink** (dependência externa, não código) se o checkout ecoa parâmetros de URL
   de volta no pedido/webhook — só depois disso o passo 2 ganha um provider real que o preenche.
4. **GA4 connector**: adicionar dimensão `transactionId` como capability opcional (`aggregatedProductEvents`
   continua true; isso não vira `eventLevel`) — só depois de confirmar, com uma conexão GA4 real, que a
   Data API do property em uso devolve isso de forma compatível.
5. Só então: `EventAnalyticsConnector` real para Meta (via ingestão própria do StoreFront, não Marketing
   API) e o `journey_id`/`OrderJourneyResolver` completos.

Nenhum desses 5 passos foi implementado nesta rodada — todos exigem decisão do usuário (autorizar mudança
em StoreFront de produção, contato com a Ink, ou acesso real a uma conexão GA4) que esta sessão não tem.
