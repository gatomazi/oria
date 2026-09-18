# Features comerciais × Connectors × Capabilities

Este documento fixa o vocabulário do Oria e registra a classificação item a item que a rodada
"separar features comerciais de connector capabilities" produziu, com a evidência de código que
sustenta cada decisão.

## Os quatro eixos

| Eixo | O que é | Onde mora |
|---|---|---|
| **Feature comercial** | capacidade do produto Oria; o que o cliente compra | `apps/panel/lib/platform/entitlements.js` → `FEATURES` |
| **Connector** | integração com um provider externo | `apps/panel/lib/platform/integrations.js` (`integrations`, por Organization) |
| **Connector capability** | o que aquela integração consegue sincronizar/operar | `apps/panel/lib/platform/connector-capabilities.js` |
| **Module capability** | modo interno de uma feature | `apps/panel/lib/creative-core/module-capabilities.js` |
| **Permissão** | o que um usuário pode fazer | RBAC de tenant — **fora** desta rodada |

Resumindo o que cada um decide:

```
Feature          = unidade comercial          →  creative_generator
Module capability = comportamento interno     →  multi_product
Connector capability = suporte do provider    →  ink.refunds
```

## A regra de classificação

> Se amanhã o Oria trocar a Reserva Ink por outro fornecedor, essa funcionalidade continua
> existindo como capacidade do Oria?

**Sim** → feature comercial. **Não / depende diretamente da API do provider** → connector capability.

Para granularidade dentro de uma feature, vale a segunda pergunta:

> O cliente entende isso como um módulo/produto que compra, ou é apenas um modo interno daquele
> módulo?

**Módulo** → feature. **Modo interno** → module capability.

## Matriz

| Item | Tipo | Chave |
|---|---|---|
| WhatsApp | Feature | `whatsapp` |
| Instagram | Feature (em breve) | `instagram` |
| Automações avançadas | Feature (não implementada) | `advancedAutomations` |
| Financeiro | Feature | `financial` |
| Gerador de Criativos | Feature | `creative_generator` |
| Ângulos limpos | Module capability | `creative_generator/clean_angles` |
| Remarketing | Module capability | `creative_generator/remarketing` |
| Funil visual | Module capability | `creative_generator/funnel_visual` |
| Multiproduto | Module capability | `creative_generator/multi_product` |
| Reserva Ink | Connector | provider `ink` |
| Pedidos Ink | Connector capability | `ink.orders` |
| Produtos Ink | Connector capability | `ink.products` |
| Categorias Ink | Connector capability | `ink.collections` |
| Agrupamentos Ink | Connector capability | `ink.product_clusters` |
| Promoções Ink | Connector capability | `ink.promotions` |
| Trocas Ink | Connector capability | `ink.exchanges` |
| Reembolsos Ink | Connector capability | `ink.refunds` |
| Sincronização do catálogo | Connector capability | `ink.catalog_sync` |
| Feed de produtos (CSV) | Connector capability | `ink.product_feed` |
| Simulação de frete | Connector capability | `ink.shipping_simulation` |
| Saldo e saques | Connector capability | `ink.balance` |
| Carrinhos abandonados | Connector capability | `ink.abandoned_carts` |
| Webhooks Ink | Connector capability | `ink.webhooks` |
| Estoque | Connector capability (derivada) | `ink.inventory` |
| Rastreamento | Connector capability (derivada) | `ink.tracking` |
| Produção | Connector capability (planejada) | `ink.production` |
| Envio / etiqueta | Connector capability (planejada) | `ink.shipping` |
| Importação de produtos e estampas | Connector capability (planejada) | `ink.product_import` |

## Classificação item a item, com evidência

### `catalog` → connector capability

Todas as rotas que a feature protegia são proxy ou cache da API da Reserva Ink:

| Rota | Implementação |
|---|---|
| `/api/admin/produtos` | cache `produtos_ink` / `produtos_feed`, ambos alimentados por varredura da Ink; `fonte=ink` chama `/v1/stores/products` ao vivo |
| `/api/admin/produtos` (POST/PATCH/duplicar) | `POST/PATCH /v1/stores/products`, `/products/{id}/copy` |
| `/api/admin/produto-tipos` | `GET /v1/stores/product_types` |
| `/api/admin/categorias` (+ vitrine, bulk) | `GET/POST/PATCH/DELETE /v1/stores/collections` |
| `/api/admin/category-assignments`, `/category-jobs` | orquestração em lote **sobre** `collections` da Ink |
| `/api/admin/agrupamentos` | `/v1/stores/product_clusters` |
| `/api/admin/promocoes` | `/v1/stores/promotions` |
| `/api/admin/estoque`, `/controle-estoque` | observações derivadas de `product_variant` da Ink |

Não existe produto canônico do Oria, não existe sincronização com múltiplos providers, não existe
modelo de catálogo independente. Trocar a Ink não deixa nada de pé.

**Nuance honesta:** `category-jobs` é motor de lote do Oria (fila, retry, cancelamento, falhas por
tipo). É infraestrutura de orquestração, não domínio de catálogo — e o que ele orquestra são
`collections` da Ink. Por isso ficou em `ink.collections`, e não virou feature.

### `exchanges` → connector capability

`GET /api/admin/trocas`, `GET /api/admin/trocas/:id` e `POST /api/admin/trocas` são repasse direto
de `/v1/stores/exchanges`. Não há tabela de trocas no Oria, nem máquina de estados, nem política,
nem histórico próprio. A validação do handler (motivos que exigem foto e descrição) **espelha** a
regra documentada da Ink, não uma regra do Oria. Trocar o provider apaga a funcionalidade inteira.

### `refunds` → connector capability

`POST /api/admin/pedidos/:id/reembolsos` e `GET /api/admin/pedidos/central/:id/reembolsos` são
repasse de `/v1/stores/orders/{id}/refunds`.

`GET /api/admin/reembolsos` lê o `audit_log` do próprio Oria — mas isso é a trilha de auditoria
genérica da plataforma ("reembolsos feitos por este painel"), não um domínio de reembolso: não há
motivo canônico do Oria, aprovação, workflow ou estado. Por isso a classificação é connector
capability. O **Financeiro** continua consumindo dados de reembolso sem que reembolso vire feature.

### `financial` → **continua feature**

`pedidos_ink`/`pedidos_ink_itens` guardam `custo_producao`, `lucro_bruto` e `lucro_operacional`
calculados pelo Oria; há despesas próprias, custos de API, consolidação com Meta Ads e GA4. Os
dados vêm de várias fontes (Ink + Meta + GA4 + despesas internas) e o módulo é do Oria. Trocar a
Ink muda uma fonte, não apaga o módulo.

### `whatsapp`, `instagram`, `advancedAutomations` → **continuam features**

Canal próprio (envio, templates, campanhas, segmentos, automações, recuperação, inbound). Nada
disso passa pela Ink.

### `creative_generator` → **continua feature**; os quatro modos → module capabilities

O Gerador é independente da Ink (comando §24): pode usar produtos sincronizados quando existirem,
mas não é "feature da Ink". Já `creative_clean_angles`, `creative_remarketing`,
`creative_funnel_visual` e `creative_multi_product` falham o teste do cliente: ninguém compra
"remarketing" separado do Gerador — são motores dentro do módulo. Viraram module capabilities.

### `meta_ads`, `google_ads`, `analytics_ga4` — **não entraram nesta rodada**

O comando §3 manda *manter* estas três como features. Elas **não existem** no vocabulário hoje:
nenhuma rota as confere, e `ESTADO_DAS_FEATURES` só admite semear feature `implementada`.
Acrescentá-las agora criaria vocabulário comercial que o código não aplica — e, pior, criaria o
risco de alguém ligar um guard depois e tirar Meta Ads do Tenant #1, que não teria a chave no
plano. Ficam registradas como **feature comercial planejada**, a ser criada junto com os guards de
rota correspondentes. É a exceção que o próprio §3 prevê ("salvo incompatibilidade factual
encontrada no código").

## O que o código **não** faz (e por isso não virou capability disponível)

| Capability do comando | Estado real |
|---|---|
| `ink.production` | **não existe**. Nenhum endpoint, rota ou estado de produção. O que tem nome parecido é `custo_producao`, coluna financeira do Oria. |
| `ink.shipping` | só existe `GET /v1/stores/shipping_simulation`. Não há etiqueta, despacho nem fulfilment. Registrado como `ink.shipping_simulation` (suportada) + `ink.shipping` (planejada). |
| `ink.product_import` | **não existe** como importação de estampa/master asset. O que existe é `catalog_sync`, que só espelha o catálogo em cache. Ligado à dívida do Artwork Vault. |
| `ink.inventory` | existe, mas **derivada**: a API da Ink não tem endpoint de estoque. O painel observa `product_variant.available_quantity` de carona nos webhooks de pedido e varre um produto dedicado chamado `controle-estoque`. |
| `ink.tracking` | existe, mas **derivada**: é o campo `order.tracking_url` dentro do payload de pedido, não um endpoint. |

## Conexão ≠ entitlement

Os dois eixos são independentes, e isso é estrutural:

- `entitlements.js` **não** importa `connector-capabilities.js`, e vice-versa (teste confere);
- `capabilityDisponivel()` só olha `conectado`; um plano cheio não disponibiliza nada;
- `checkEntitlement()` só olha o plano; um connector conectado não concede feature nenhuma;
- a Reserva Ink **não** tem feature comercial `connector_ink`. Ela é connector técnico disponível
  para todos. Comercializar connectors por plano exige decisão comercial, e não foi tomada.

Na prática: `financial` habilitado funciona parcialmente sem a Ink, e completa os dados quando o
connector estiver conectado. Uma Organization **não** é marcada como sem feature só porque um
connector está ausente.

## Estados de UI

| Situação | Resposta | Tela |
|---|---|---|
| Feature fora do plano | `403 feature_nao_disponivel` | "não incluído no plano" |
| Connector não conectado | `409 connector_nao_conectado` | "Conecte a Reserva Ink para usar este módulo" |
| Provider não suporta a capability | `501 capability_nao_suportada` | "indisponível para este connector" |

Os três códigos são distintos de propósito: um 403 genérico impediria a tela de oferecer a ação
certa.

## Migração sem regressão

A ordem executada foi a do comando §20:

1. registry de connector capabilities introduzido;
2. rotas de Catálogo/Trocas/Reembolsos movidas de `ROTAS` para `ROTAS_CAPABILITY`;
3. vocabulário comercial encolhido nas três cópias (painel, control plane, UI do control plane);
4. plano `internal` e baseline do Tenant #1 atualizados (migration `0022`).

Nenhum acesso foi retirado:

| Antes (plano `internal`) | Depois | Caminho de acesso |
|---|---|---|
| `catalog` | — | Connector Ink conectado → `ink.products`, `ink.collections`, `ink.product_clusters`, `ink.promotions`, `ink.catalog_sync`, `ink.product_feed`, `ink.inventory` |
| `exchanges` | — | Connector Ink conectado → `ink.exchanges` |
| `refunds` | — | Connector Ink conectado → `ink.refunds` |
| `creative_clean_angles` | — | `creative_generator` → modo `clean_angles` |
| `creative_remarketing` | — | `creative_generator` → modo `remarketing` |
| `creative_funnel_visual` | — | `creative_generator` → modo `funnel_visual` |
| `creative_multi_product` | — | `creative_generator` → modo `multi_product` |
| `creative_generator` | `creative_generator` | inalterado |
| `financial` | `financial` | inalterado |
| `whatsapp` | `whatsapp` | inalterado |

O teste `test/invariants/capabilities-classificacao.test.js` (§20) percorre essa tabela e reprova
se qualquer linha perder o caminho de acesso.

Sobre a janela entre (2) e a fiação do guard em `server.js`: sair do eixo de feature é, por
construção, **afrouxar**. Nenhuma request que passava antes deixa de passar. As rotas continuam
protegidas por sessão, contexto de Organization e RLS, e as que falam com a Ink já falham sozinhas
com `409 INTEGRATION_NOT_CONNECTED` quando não há segredo.

## Depreciação das chaves antigas

As sete chaves ficam declaradas como `deprecated`, `non-commercial`, `ignored for entitlement
resolution` (`FEATURES_DEPRECIADAS`, nas duas cópias). Elas:

- **não** aparecem em nenhuma UI de plano;
- **não** aceitam override novo no control plane (`422 feature_desconhecida`, com motivo);
- são negadas por `checkEntitlement` mesmo gravadas como `true` num `app_config` antigo;
- continuam aceitas pelo domain `platform_feature` do banco — remover fisicamente é a **Phase E**,
  para depois de nenhum ambiente carregar mais as chaves. O teste de registry sabe que a diferença
  é deliberada.

Nenhuma das chaves antigas foi reusada como chave de capability: o namespace é `provider.capability`
(§34).

## Futuro multi-provider

O registry é um mapa de providers, não um `if provider === 'ink'`. Acrescentar Printful, Printify
ou um provider próprio é acrescentar uma entrada com o seu próprio conjunto de capabilities; nada
no guard, no read model ou nas rotas presume a Ink.

Se um dia for preciso limitar modos por plano, o caminho é `creative_generator.capabilities = [...]`
ou uma policy de módulo — **nunca** voltar a feature por engine. Limite de uso é quota
(`creative_generator.limits.monthly`), não entitlement.

## Referências

- `docs/architecture/control-plane.md`
- `docs/operations/connector-ink.md`
- `docs/productization/artwork-vault.md`
- `apps/panel/test/invariants/capabilities-classificacao.test.js`
