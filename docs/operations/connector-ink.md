# Connector · Reserva Ink

A Reserva Ink é um **connector**: uma integração com um provider externo, opcional, resolvida por
Organization. Não é feature comercial, não é obrigatória, e conectá-la não concede nenhuma feature
de plano.

O vocabulário e o critério de classificação estão em
[`docs/architecture/features-vs-connectors.md`](../architecture/features-vs-connectors.md).

## Ink é opcional

O Oria não é um produto acoplado à Ink. Uma Organization sem Ink continua tendo WhatsApp,
Financeiro (parcial, com os dados que tiver) e Gerador de Criativos. O que ela não tem são as
áreas que dependem do catálogo/pedidos do provider.

Não existe feature comercial `connector_ink`. Se um dia o produto quiser vender connectors por
plano, isso é uma feature nova e uma decisão comercial — não uma consequência técnica.

## Credenciais

Resolvidas por `(organization_id, provider='ink')`, nunca por env global nem por "a única conexão".
Três segredos, todos cifrados:

| Tipo | Contexto HKDF | Para quê |
|---|---|---|
| `api_token` | `ink-api-token-v1` | chamadas REST a `/v1/stores/...` |
| `webhook_secret` | `ink-webhook-secret-v1` | validação HMAC da entrada de webhook |
| `feed_url` | `ink-feed-url-v1` | download do CSV do feed de produtos |

Sem segredo, o resolvedor devolve `INTEGRATION_NOT_CONNECTED` (409). Nada consulta o provider.

## Capabilities

Registry canônico: `apps/panel/lib/platform/connector-capabilities.js`. Três estados:

- **suportada** — existe chamada real ao provider;
- **derivada** — o Oria monta a capacidade em cima de outra; o provider não tem endpoint próprio;
- **planejada** — não existe no código. Nunca fica disponível operacionalmente.

| Capability | Estado | Evidência |
|---|---|---|
| `ink.orders` | suportada | `GET /v1/stores/orders`, `/orders/{id}` |
| `ink.products` | suportada | `GET|POST /v1/stores/products`, `PATCH /products/{id}`, `/products/{id}/copy`, `/product_types` |
| `ink.collections` | suportada | `GET|POST|PATCH|DELETE /v1/stores/collections`, `/collections/{id}/custom_showcase` |
| `ink.product_clusters` | suportada | `/v1/stores/product_clusters` |
| `ink.promotions` | suportada | `/v1/stores/promotions` |
| `ink.exchanges` | suportada | `GET|POST /v1/stores/exchanges`, `/exchanges/{id}` |
| `ink.refunds` | suportada | `GET|POST /v1/stores/orders/{id}/refunds` — **sem listagem global** |
| `ink.catalog_sync` | suportada | varredura paginada de `/products` → cache `produtos_ink` |
| `ink.product_feed` | suportada | CSV do `feed_url` → cache `produtos_feed` |
| `ink.shipping_simulation` | suportada | `GET /v1/stores/shipping_simulation?cep=` |
| `ink.balance` | suportada | `/balance`, `/balance_extract`, `/withdraws`, `/prepayments` |
| `ink.abandoned_carts` | suportada | `GET /v1/stores/abandoned_carts` |
| `ink.webhooks` | suportada | `POST /api/webhooks/ink/:token` com HMAC |
| `ink.inventory` | **derivada** | a Ink não tem endpoint de estoque: observações de `product_variant` nos webhooks + varredura do produto `controle-estoque` |
| `ink.tracking` | **derivada** | campo `order.tracking_url` no payload de pedido |
| `ink.production` | **planejada** | não existe no código |
| `ink.shipping` | **planejada** | só há simulação de frete; nada de etiqueta/fulfilment |
| `ink.product_import` | **planejada** | importar a estampa (master asset) — ver `docs/productization/artwork-vault.md` |

Só capability `suportada` ou `derivada` pode aparecer como promessa na tela de integração. Nunca
anunciar "Produção", "Envio" ou "Importação de estampas" enquanto estiverem planejadas.

## Reembolso: a limitação que importa

A Ink não expõe listagem global de reembolso — só por pedido. A tela de Reembolsos do painel lista
o que **este painel** fez, a partir do `audit_log`, e nunca finge ser uma cópia completa do lado da
Ink. O detalhe por pedido (`GET /v1/stores/orders/{id}/refunds`) é confiável porque é escopado a um
pedido.

## Estoque: o contorno que importa

Não existe endpoint de estoque. O painel obtém quantidade por variação de dois jeitos, ambos
indiretos:

1. de carona nos webhooks de pedido (`estoque_observacoes`), que só cobre variação que apareceu em
   algum pedido;
2. varrendo um produto dedicado chamado literalmente `controle-estoque`, um por tipo de peça, nunca
   publicado (`controle_estoque_observacoes`).

É por isso que `ink.inventory` é **derivada** e não suportada: a capacidade é do Oria, montada em
cima de `ink.products` + `ink.webhooks`.

## Read model

```json
{
  "provider": "ink",
  "connected": true,
  "capabilities": ["orders", "products", "collections", "..."],
  "suportadas": [{ "capability": "orders", "chave": "ink.orders", "rotulo": "Pedidos", "estado": "suportada" }],
  "planejadas": ["production", "shipping", "product_import"]
}
```

`capabilities` é o que está disponível **agora** — vazio quando desconectado, sempre.
`suportadas` é o que o connector habilita **depois de conectar**, e independe da conexão: é o que a
tela de integração promete.

## Respostas de erro

| Situação | Resposta |
|---|---|
| Connector não conectado | `409 { erro: 'connector_nao_conectado', provider, capability }` |
| Capability planejada | `501 { erro: 'capability_nao_suportada', provider, capability }` |
| Feature comercial fora do plano | `403 { erro: 'feature_nao_disponivel', feature }` |

Os três são distintos de propósito. Um 403 genérico impediria a tela de oferecer "conectar a
Reserva Ink" no lugar certo.
