# Integrações core na Store nativa: Reserva Ink, GA4 e Meta Ads (2026-09-20)

Rodada noturna. Depois da rodada de mídia (`midia-store-nativa-2026-09-20.md`) o modelo canônico é
`organization_id + store_id`. Aqui ele chega às três integrações centrais. Use Sul continua com
`loja_legada = NULL`; nada foi preenchido e nenhum vínculo por nome (`sul`/`centro`/`norte`) foi criado.

## 1. Fundação comum (auditoria)

| Peça | Estado encontrado | Decisão |
|---|---|---|
| Tokens/segredos | `integration_secrets`, por **Organization** (cifrados, mascarados, `last4`) | mantido: já era correto |
| Estado OAuth | `oauth_states`: uso único, amarrado à pessoa, à sessão e à Organization | **acrescentado `storeId` ao `state`** (GA4 e Meta); o callback só grava se `storeDoContexto() === state.storeId` |
| Callback | sem `requireAdmin` (o cookie pode não chegar); legitimidade = `state` | mantido; state antigo (sem Store) ou de outra Store é **recusado** (fail-closed) |
| Recurso externo | `integracao_reivindicar_recurso` (PD-016): um recurso, uma Organization | mantido (propriedade GA4, conta Meta/Google) |
| Identidade da Store | `organization_id + store_id` (FK composta com `stores`) | aplicada às tabelas abaixo |
| Jobs | `JOBS.agendar` → `comContexto({organizationId, storeId, loja})` por Organization | mantido; nenhum job dos domínios migrados chama a chave legada |

Migrations desta rodada (aditivas, forward-only; backfill só por `stores.loja_legada`, mesma Organization;
`down` recusa em vez de apagar dado):

| Migration | Tabelas |
|---|---|
| `0026-catalogo-ink-store-id` | `produtos_ink`, `produtos_ink_sync`, `bulk_category_jobs`, `pedidos_backfill_jobs` |
| `0027-ga4-store-id` | `google_analytics_connections`, `ga4_performance_cache` |

Nas tabelas com `loja` na PK (`produtos_ink`, `produtos_ink_sync`) a PK virou substituta `(organization_id, id)`;
a unicidade canônica é **parcial em `store_id`** e o índice legado por `loja` continua com o mesmo nome (as
releases já publicadas o usam no `ON CONFLICT`). Linha antiga de uma Store **com** chave legada é reivindicada por
mapeamento explícito antes de escrever, então nunca duplica.

## 2. Reserva Ink

- **Credencial**: token cifrado por Organization, nunca devolvido. **`feedUrl` deixou de ser requisito**: o
  card não pede nem mostra feed (só o "feed legado" para quem já tem um); `GET /produtos/feed/status` responde
  `{ lojas: [], descontinuado: true }` (200) e `POST /produtos/feed/sync` responde 410 `FEED_DEPRECATED`.
- **Teste de conexão**: read-only (`GET /v1/stores/orders?per_page=1`); token sozinho é `pendente`, token + URL +
  segredo do webhook é `conectada`.
- **Webhook**: URL opaca + segredo → Organization → Store do contexto. O evento grava `organization_id + store_id`
  (`webhook_eventos`), o pedido é ingerido pela credencial da Store (idempotente) e a assinatura de outra
  Organization é recusada (401). Automações de WhatsApp/PIX e a observação de estoque ainda dependem da chave
  legada e só rodam para Store que a tem (dívida: Recuperação).
- **Produtos / Categorias / Agrupamentos**: `inkApi*DaStore` (credencial da Organization). O núcleo do cliente Ink
  é um só (`inkRequisitar`) para o caminho legado e o canônico.
- **Cache do catálogo / status / config / job**: por `store_id`; `produtos_ink_sync` e o job periódico enumeram a
  Store do contexto. O status deixou de ser 500 e o card de Integrações opera por `storeId`.
- **Backfill histórico de pedidos e associação de categorias em lote**: jobs com `store_id`, processados sob o
  contexto da Organization/Store.

## 3. GA4

- Conectar (`/google-analytics/connect`) deixou de responder `STORE_WITHOUT_LEGACY_KEY`. O `state` leva a Store.
- **Scope**: `analytics.readonly` (leitura de propriedades e relatórios; nada de escrita).
- **Propriedade**: uma só é selecionada sozinha (ID externo `propertyId`, nunca o nome); com várias o tenant escolhe;
  outra Organization não pode reivindicá-la (409).
- Conexão, cache de performance, UTM Performance, panorama e a atribuição GA4 do consolidado por `store_id`.
- **Bug corrigido no caminho**: a campanha UTM salva sem `content`/`term` nunca reconhecia a linha do GA4, porque o
  literal `(not set)` era normalizado para `notset`.

## 4. Meta Ads

- **Escopo**: só `ads_read` — o menor que lê campanhas e Insights (`ads_management` e `business_management` ficam de
  fora de propósito). **Business**: não é listado (exigiria `business_management`); a **conta de anúncios** é
  sempre escolhida explicitamente e persistida como `meta_account_id` + `store_id`.
- OAuth já tinha state de uso único; agora carrega a Store. Cancelamento/erro do usuário vira estado
  `error` com código, sem exceção e sem segredo. Renovação de token (job de 12h) e revogação
  (`DELETE /me/permissions`) já existiam.
- **Sync**: idempotente (upsert por conta/nível/dia), sob o contexto da Organization. Testado de ponta a ponta com o
  provider simulado: conectar, contas, selecionar, gasto real, Dashboard e consolidado.
- **Dashboard**: a fonte agora distingue *não conectada*, *conta fora do total*, *conectada* (com ou sem gasto) e
  *com problema* (conta da loja, mas conexão em erro/expirada). A fórmula financeira não mudou.

## 5. Estados na UI

Vocabulário atual do backend: `not_configured` / `pendente` / `conectada` (Ink), `disconnected` / `connected` /
`error` (GA4/Meta). O mapeamento para o vocabulário comum pedido (`not_entitled`, `platform_unavailable`,
`not_configured`, `pending`, `connected`, `connected_with_data`, `degraded`, `error`) **não foi unificado nesta
rodada** (registrado como dívida). Nenhum card mostra nomes de env, HTTP bruto ou stack; "plataforma
indisponível" é tratado como conceito de produto.

## 6. Isolamento e segurança

Testes com A (legada), C e D (nativas): cada Organization lê o catálogo/pedidos/GA4/gasto da SUA credencial (o
provider simulado devolve dados diferentes por token), cache e jobs por Store, replay/forja de `state` e assinatura
de webhook de outra Organization não gravam nada, e nenhum token/segredo aparece em resposta nem em log.

## 7. Dívidas

- Vocabulário comum de estados de integração (item 5).
- Ink: automações de WhatsApp/PIX e estoque por chave legada (Recuperação/Estoque, fora do escopo); `promocoes`,
  `trocas`, `reembolsos`, `simular frete` seguem no caminho legado.
- Login externo: o fluxo OAuth real (Google/Meta com senha/2FA/consentimento) só é exercitável com a sessão do
  navegador; a infraestrutura e os testes estão prontos, o passo final depende de uma conta autenticada.
