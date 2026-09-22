# Product Analytics — Rodada G.1 (consolidação) + Commerce Orders + Reconciliação

Continuação de `docs/features/product-analytics-night-round-e-f-g.md` (Fases E/F/G). Três etapas,
três commits. Backend only — sem UI, sem billing, sem Meta Events/Ads, sem IA.

## Etapa 1 — G.1: validação do ProductPerformanceService

Auditoria dos quatro pontos pedidos; três correções reais, uma confirmação.

- **Semântica das métricas**: `rates` virou `itemRatios`, com campos explícitos
  (`itemsAddedToCartPerItemViewed`, `itemsCheckedOutPerItemViewed`, `itemsCheckedOutPerItemAddedToCart`,
  `itemsPurchasedPerItemViewed`) — razão entre CONTAGENS DE ITEM, nunca sugerindo conversão de
  usuário/sessão (o GA4 Data API mede escopo de item, não de sessão).
- **Ordenação/paginação**: corrigido. Ordenar por métrica/ratio agora considera o conjunto elegível
  **inteiro da Store** (todo produto com identity resolvida no namespace de analytics, com ou sem
  atividade no período) antes de paginar em memória — antes, um produto com identity resolvida mas
  zero atividade no período ficava fora do conjunto, distorcendo `totalCount` e o ranking. Ordenar
  por `itemRatios` também passou a funcionar (antes sempre `null`, sem efeito).
- **Zero vs ausência**: já estava correto (confirmado, não uma correção) — `insufficient_data`
  (período sem nenhuma linha), `metric_unavailable` (propriedade não suporta a métrica),
  `unmatched_identity` (produto sem identity resolvida) e zero real (identity resolvida, sem
  ocorrência no período) já eram quatro estados distintos desde a Fase G.
- **Escalabilidade**: `ReportCache` (Map isolado por instância do service, TTL 15 min padrão,
  chave `organizationId+storeId+analyticsProvider+startDate+endDate`) — página 2 de um mesmo
  período reaproveita o relatório da página 1, nunca um relatório GA4 completo por página. Instância
  por `createProductPerformanceService`, nunca estado de módulo/global (viola a regra de estado
  mutável compartilhado entre requests).

Commit: `fix(panel): correct product performance metric semantics and scale`.

## Etapa 2 — Commerce Orders

Capability `orders` (já prevista no contrato desde a Fase B — `contracts.js` já tinha
`orders: ['listOrders', 'getOrder']`) implementada na Reserva Ink.

- **Fonte de dado**: `pedidos_ink`/`pedidos_ink_itens` — o cache local que `server.js` já
  sincroniza (sync horário + webhook, intocado). Nenhuma tabela nova, nenhuma migration nesta etapa,
  nenhum full fetch na API da Ink.
- **`orders-repository.js`** (novo): 1 query de pedidos (paginada) + 1 query de itens por página
  (nunca 1 por pedido), resolvendo `commerce_product_id` por JOIN direto com `commerce_products`
  (Fase D) via `(organization_id, store_id, provider, provider_product_id)` — é o MESMO id da Ink,
  casamento exato por definição, sem ambiguidade a resolver (não é Product Identity).
- **Contrato**: `CommerceOrder` ganhou `isPaid`/`isRefunded` (booleanos normalizados pelo adapter) —
  `status`/`paymentStatus` continuam crus, só para diagnóstico. `CommerceOrderItem.commerceProductId`
  virou `string|null` (item de pedido antigo pode referenciar produto nunca sincronizado).
- **`isPaid`**: espelha exatamente `PAYMENT_STATUSES_CONVERTIDO` (`paid`/`succeeded`/`free`) e a
  regra `is_troca IS NOT TRUE` do `server.js` — sem importar `server.js` (intocável); um teste
  comparativo lê o `Set` real do arquivo por regex e falha se divergir.
- **Fora do escopo**: reembolso itemizado (`refunds` continua `false`) — exigiria 1 chamada de API
  por pedido; sem cache local pra isso. `isRefunded` reporta só o ESTADO (`payment_status` em
  `refunded`/`refund_requested`), nunca um valor.
- **Bug real encontrado pelos testes**: `getOrder` buscava itens num `Map` usando um `Number`
  (convertido do `providerOrderId` de entrada) enquanto o `Map` é indexado pela STRING que o driver
  do Postgres devolve para colunas `BIGINT` — nunca batia, item sempre vinha vazio. Corrigido usando
  a própria coluna da linha lida como chave.

Commit: `feat(panel): add commerce orders capability to reserva ink connector`.

## Etapa 3 — Reconciliação

`lib/product-analytics/reconciliation.js` — provider-agnostic dos dois lados.

- **Unidades equivalentes**: `itemsPurchased` (Analytics) compara com unidades vendidas (soma de
  `item.quantity` dos pedidos com `isPaid: true`) — nunca com número de pedidos.
- **Provider-agnostic de verdade**: lê só `CommerceOrder.isPaid` (normalizado pelo adapter na Etapa
  2) — nenhum literal de status de nenhum provider aparece no arquivo (guarda estática cobre isso).
- **Receita**: `itemRevenue` (Analytics) e `commerceRevenue` (Commerce) sempre vêm acompanhados de um
  bloco `caveats` fixo — reembolso itemizado e rateio de desconto não estão no cache local, `createdAt`
  do pedido não é data de pagamento, fuso horário e atraso de sincronização — nunca uma alegação de
  equivalência exata.
- **Divergência é diagnóstico**: `aligned`/`divergent` por produto, com os dois valores brutos
  sempre visíveis — nunca lança exceção por número diferente do esperado.
- **Cobertura de histórico local**: período com `startDate` antes de `2026-08-19` devolve
  `insufficient_data` no nível da chamada inteira, sem tentar comparar (evitaria uma "toda venda
  observada parece suspeita" enganosa).
- **`insufficient_identity` vs `insufficient_data` por produto**: as duas causas compartilham
  `identity.status: 'unmatched'` na saída da Fase G, mas são diagnósticos diferentes aqui — período
  inteiro sem nenhuma linha de analytics (`insufficient_data`) não é o mesmo problema que este produto
  específico não ter identity resolvida com o resto do período coberto (`insufficient_identity`).

Commit: `feat(panel): add provider-agnostic analytics/commerce reconciliation`.

## Testes desta rodada

- `test/invariants/product-performance-service.test.js`: +9 (itemRatios, sort por métrica/ratio
  considerando o conjunto elegível inteiro, produto zero-matched no sort, cache com TTL/chave/
  isolamento por instância).
- `test/connectors-commerce-reserva-ink-mapper.test.js`: +14 (mapOrder/mapOrderItem, comparativo
  contra `PAYMENT_STATUSES_CONVERTIDO`/`RESUMO_PROBLEMA` do server.js).
- `test/connectors-commerce-reserva-ink-connector.test.js`: +5 (listOrders/getOrder delegando ao
  repositório, nunca à API; capabilities atualizadas).
- `test/invariants/ink-orders-repository.test.js` (novo): 9 testes reais contra Postgres — período,
  paginação, sem N+1, join com catálogo, isolamento de Organization/RLS.
- `test/invariants/reconciliation.test.js` (novo): 12 testes reais — unidades vs pedidos, paginação
  do Commerce inteiro, pedido não pago excluído, divergência, as duas causas de identity distintas,
  caveats sempre presentes, guarda estática provider-agnostic.

## Limitações reais (dívidas, não bugs)

- Reembolso itemizado (valor por item reembolsado) não está disponível localmente — só o endpoint
  por pedido da Ink tem esse dado, fora do escopo desta rodada.
- `paidAt` do pedido é sempre `null` — o cache local não tem uma coluna própria de "pago em"
  (só `criado_em`, a criação do pedido). Documentado no mapper, nunca aproximado.
- Reconciliação usa `criado_em` como âncora de período do lado Commerce — não é a data do evento de
  Analytics nem a data de pagamento; listado explicitamente em `caveats`.
- Tolerância de divergência (`divergenceTolerance`, padrão 10%) é uma heurística de partida
  documentada, não uma precisão calibrada — ajustável por chamada.

## Próxima rodada recomendada

1. Entitlement + API pública para Product Performance/Reconciliation (`analytics_product_performance`,
   já reservado desde a Fase B).
2. UI de consumo (catálogo + performance + reconciliação).
3. Reembolso itemizado (endpoint por pedido da Ink) se o produto precisar de receita líquida exata.
4. Meta Events (EventAnalyticsConnector) e Meta Ads (AdsConnector), domínios independentes.
