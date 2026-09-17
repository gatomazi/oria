# Dados disponíveis para remarketing e dashboard

Levantamento do que já temos (via webhooks da Reserva Ink + API + o que o painel já
processa/guarda) e como isso pode virar campanhas de remarketing e métricas de um dashboard.
Não é um plano de implementação — é um mapa do que existe e do que dá pra construir em cima.

## 1. Fontes de dados que já temos

| Fonte | O que traz | Onde já entra no sistema |
|---|---|---|
| Webhooks de pedido (`order.created`, `payment.*`, `shipping.*`) | Pedido completo: comprador, itens (produto + variação + estoque da variação), endereço, pagamento, entrega | `processarEventoWebhook` → cache `pedidos_ink` (Postgres) |
| Webhook de carrinho (`cart.abandoned`) | Carrinho com comprador, itens, `contactable` | `dispararMensagemAutomaticaCarrinho` → `carrinho-envios.json`/Postgres |
| `GET /v1/stores/orders` (sync de hora em hora) | Mesmo formato do webhook, mas em lote — cobre pedidos que não geraram webhook recente | `syncPedidosLoja` |
| `GET /v1/stores/customers` | Registro de clientes (nome, e-mail, telefone, documento, `accepts_marketing`) | tela Clientes |
| `GET /v1/stores/abandoned_carts` | Lista de carrinhos abandonados | tela Carrinhos |
| Cache `pedidos_ink` (Postgres) | Histórico agregável: status de pagamento, valor, comprador, data | Anti-spam de carrinho, novo histórico de compras |
| `estoque_observacoes` (novo) | `available_quantity` por variação (tamanho/cor/modelo), toda vez que aparece num pedido | tela Estoque |

**Campos por pedido que ainda não são usados em lugar nenhum, mas existem:** `billing_address`/`shipping_address` (cidade/estado do comprador — faz sentido pro produto, que é regional), `product_v2.tags`/`product_cluster_id` (agrupamento de produto, útil pra recomendação), `payment_method` (cartão/Pix/etc, com bandeira no caso de cartão), `delivery.carrier`/`delivery_delayed`/`production_delayed` (operacional, não remarketing), `kickback_value` (não é dado de cliente).

## 2. Segmentos de remarketing sugeridos

Já implementados nesta sessão: **carrinho abandonado** (com atraso configurável) e **Pix pendente** (lembrete automático). Os que seguem são candidatos novos, em ordem de "quão pronto está o dado":

1. **Cliente inativo há X dias** (30/60/90/180+) — já disponível na tela Clientes agora. Oferecer cupom de reativação.
2. **Pagamento falhou, pedido cancelado** (`payment.card_not_authorized` → `order.canceled`, `payment.pix_boleto_expired` → `order.canceled`) — diferente de carrinho abandonado: aqui o cliente **tentou pagar e não conseguiu**. Mensagem de recuperação com um caminho alternativo de pagamento (ex: "seu cartão foi recusado, finalize com Pix e ganhe X%") tende a converter melhor que reativação genérica, porque a intenção de compra já estava mais avançada.
3. **Cliente com 1 única compra** — incentivo pra segunda compra (cross-sell de outra estampa/cidade da mesma região, já que o catálogo é organizado assim).
4. **Cliente recorrente (2+ ou 3+ compras)** — tratamento VIP (frete grátis, acesso antecipado a lançamento) em vez de desconto genérico — o dado (`totalCompras`) já existe na tela Clientes.
5. **Pós-entrega** (`shipping.delivered`) — pedir avaliação, ou (passado um tempo, ex. 60-90 dias) sugerir nova compra — ciclo natural de recompra de vestuário. Precisaria de um novo evento sintético com atraso, no mesmo padrão do `pix.pendente`.
6. **Segmentação geográfica** (`shipping_address.city`/`state`) — campanha por cidade/região faz sentido particular pra esse produto (identidade regional). Ainda não é capturado no cache — precisaria adicionar `cidade`/`estado` no `pedidos_ink`.
7. **Escassez de estoque** (novo, com a tela de Estoque) — cruzar "produto com estoque baixo" com "clientes que já compraram daquele produto/estampa" pra campanha de "últimas peças".

Em todos os casos, **`accepts_marketing` já é respeitado** — só quem opôs-in deveria ser contatado com esse tipo de mensagem (ainda não há uma trava automática disso no código de disparo; hoje é um dado disponível pra decisão manual, vale adicionar como filtro obrigatório se algum desses virar automação de verdade).

## 3. Métricas sugeridas para um dashboard

**Funil de conversão** (usando os eventos que já chegam): `order.created` → `payment.approved` → `shipping.sent` → `shipping.delivered`, com contagem e tempo médio em cada etapa, por loja. Dá pra ver gargalo (ex: produção atrasando envio) e taxa de queda entre etapas.

**Financeiro**: receita por loja/dia/semana (soma de `total_value` dos pedidos com `payment_status` pago), ticket médio, taxa de aprovação de pagamento (aprovados vs. recusados/pix expirado).

**Clientes**: novos vs. recorrentes por período, taxa de recompra, valor médio por cliente ao longo do tempo (LTV aproximado) — a base pra isso (`pedidos_ink` agregado) já existe, é o mesmo dado usado no histórico de compras da tela Clientes.

**Produto/estoque**: produtos/estampas mais vendidos (contagem de itens por `product_v2`), estoque crítico por variação (já tem a tela, dá pra resumir num card do dashboard geral).

**Carrinho e Pix pendente**: taxa de recuperação (quantos carrinhos abandonados viraram pedido pago depois do lembrete, comparando `clienteJaComprou` no momento do reenvio), mesma lógica pro lembrete de Pix.

**Geografia**: pedidos por cidade/estado — dado que o produto inteiro é sobre identidade regional, um mapa de "de onde vêm os pedidos" tem valor tanto de negócio quanto de conteúdo (ex: "estampa mais pedida em tal estado").

## 4. Limitações a ter em mente

- **Identidade de cliente é heurística** (documento → telefone → e-mail, nessa ordem de confiança) — se um cliente mudar de telefone/documento entre compras, pode aparecer como "2 clientes diferentes" em vez de 1.
- **Estoque é observação passiva**, não uma sincronização — uma variação que não aparece em nenhum pedido recente não tem número atualizado (documentado na tela de Estoque).
- **`accepts_marketing` é capturado por pedido**, não por um cadastro único — hoje usamos o valor do pedido mais recente do cliente como aproximação.
- **Não existe dado de "quase comprou sem carrinho"** (ex: visualizou produto mas não adicionou ao carrinho) — a Reserva Ink não expõe isso via webhook/API atualmente.

## 5. O que já está pronto vs. o que precisaria ser construído

**Pronto:** carrinho abandonado (com atraso), Pix pendente (com atraso + link de pagamento automático), histórico de compras por cliente + filtro de inatividade, rastreio de estoque por variação.

**Precisaria construir, se decidir seguir em algum desses:** evento sintético de "recuperação de pagamento falhado" (mesmo padrão do `pix.pendente`), evento sintético de "pós-entrega" com atraso configurável, captura de cidade/estado no cache de pedidos, uma tela de dashboard consolidando as métricas da seção 3 (hoje cada dado vive na sua própria tela — Pedidos, Carrinhos, Clientes, Estoque — sem uma visão agregada única).
