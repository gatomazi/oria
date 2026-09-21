# Operação na Store nativa — Trocas, Reembolsos, Promoções, Campanhas, Recuperação (2026-09-21)

Tenant de dogfooding: Organization **Use Origens**, Store **Use Sul**, `loja_legada = NULL`.
O webhook da Reserva Ink continua **adiado de propósito** (o sistema anterior segue consumindo os eventos).

## O que a Ink oferece por API (e o que o Oria faz com isso)

| Área | Endpoint da Ink | Fonte da verdade | O que o Oria faz |
|---|---|---|---|
| Trocas | `GET/POST /v1/stores/exchanges` | Ink | lista, detalha e **cria** pela credencial da Store; `Idempotency-Key` gerada no servidor; motivos que exigem suporte exigem descrição + foto (validado antes de chamar a Ink) |
| Reembolsos por pedido | `GET/POST /v1/stores/orders/:id/refunds` | Ink | lista e cria; total exige confirmação explícita; auditoria identifica a Store |
| Promoções | `/v1/stores/promotions[/:type]` | Ink | lista, cria, edita e remove (promoção **da Ink**: desconto/cupom). O Oria não tem entidade própria de promoção; segmentação/comunicação vive em Campanhas |
| Carrinhos abandonados | `GET /v1/stores/abandoned_carts` | Ink | **polling** (job) grava o histórico de envios da Store; não depende de webhook |
| Pix pendente | `GET /v1/stores/orders` (`pix`) | Ink | polling (`registrarPixPendentesFaltantes`) |

**Troca ≠ reembolso.** São endpoints diferentes; o teste garante que criar uma troca nunca toca `/refunds`.

## Mudanças

- Trocas, reembolsos por pedido e promoções: `inkApi*DaStore` (credencial da Organization/Store do contexto) em vez de
  `lojaLegadaDoContexto()` + `inkApi*(loja, …)`. Store nativa deixou de receber 409 `STORE_WITHOUT_LEGACY_KEY`.
- **Chave de escopo da Store** (`chaveDaStore()`): vínculos de automação, histórico de carrinho e lembrete de Pix são
  mapas por chave. Store com chave legada mantém a dela (dado existente continua achável); Store nativa usa o `store_id`
  (opaco, nunca colide com `sul/centro/norte`). Nunca vai para coluna `loja` nem para checagem de credencial.
- **Campanhas**: migration `0029` — `campaigns.store_id` (FK composta com a Organization), `loja` nulo-permitida, CHECK
  `store_id OR loja` (NOT VALID), backfill só por `stores.loja_legada`. Lista/cria/duplica por `store_id`; a checagem
  anti-spam entre campanhas usa a Store, não o texto.
- **Recuperação sem webhook**: o job de polling de carrinhos abandonados grava registros da Store nativa
  (`<store_id>:<cart_id>`); o mesmo para Pix pendente. O envio manual de carrinho/Pix usa a credencial da Store.
- Mídia, frete e Pix de pedido deixam de exigir chave legada; auditoria do reembolso identifica a entidade pela Store.

## Adiado (DEFERRED) e por quê

- **Eventos só por webhook** (tempo real de `cart.abandoned`, `payment.*`): sem webhook, a Recuperação usa polling
  (intervalo de 15 min). Reconstrução de "converteu?" usa os pedidos já sincronizados (`clienteJaComprou`).
- **Estoque, Feed legado, Artwork Vault**: fora desta fase (continuam exigindo chave legada; respondem 409 controlado).
- **Promoção da Oria** (segmentação própria): não existe endpoint na Ink para isso e não foi inventado.
- **Canal WhatsApp**: em homologação (Tech Provider adiado). A Recuperação/Campanhas geram tentativa e registram status;
  envio real só em modo de teste, sem disparo em massa.

## Hardening

- **Google (OAuth/GA4)**: `lib/google/http.js` — timeout de 15 s; retry curto (400 ms, 1,2 s, respeitando `Retry-After` até
  5 s) só em 429/500/502/503/504/rede e só em chamada idempotente; **nunca** em 400/401/403 nem na troca do code de
  autorização. `invalid_grant`/401 → `RECONNECT_REQUIRED` (409) e conexão em `error` ("Reconectar"), sem vazar o texto do
  provider.
- **Ink**: GET com retry curto em 429/5xx (PR #7); agrupamentos buscam o produto de vitrine em lotes de 5 (antes 100
  em paralelo → 429).
- **Meta**: o cliente já tinha timeout + retry exponencial com teto (spec §37); token expirado vira estado `error`
  no read model.
- **OpenAI (BYOK)**: salvar mascarado, testar, recusar chave inválida (`rejected`, sem corpo do provider), revogar —
  coberto por teste, isolado por Organization.

## Testes

- `operacao-store-nativa.test.js` (18): trocas, reembolsos, promoções, campanhas, recuperação, automações, job de polling
  e OpenAI BYOK, com duas Stores nativas (C/D) e uma legada (A).
- `google-http.test.js` (8) e o cenário de `invalid_grant` em `ga4-store-nativa.test.js`.
- Negative controls: `OP-01…06` (operação) e `GHTTP-01…03` (Google).
