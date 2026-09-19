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
| Meta Ads | Feature (sem guard) | `meta_ads` |
| Google Ads | Feature (sem guard) | `google_ads` |
| Analytics GA4 | Feature (sem guard) | `analytics_ga4` |
| Catálogo | Feature **em transição** → connector capability | `catalog` |
| Trocas | Feature **em transição** → connector capability | `exchanges` |
| Reembolsos | Feature **em transição** → connector capability | `refunds` |
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

### `catalog` → connector capability (em transição)

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

A classificação está fechada; a **migração do runtime não**. `requireEntitlement` ainda confere a
chave `catalog` nestas rotas, então ela continua no vocabulário e no plano — ver "Plano de
retirada" mais abaixo. O mesmo vale para `exchanges` e `refunds`.

**Nuance honesta:** `category-jobs` é motor de lote do Oria (fila, retry, cancelamento, falhas por
tipo). É infraestrutura de orquestração, não domínio de catálogo — e o que ele orquestra são
`collections` da Ink. Por isso ficou em `ink.collections`, e não virou feature.

### `exchanges` → connector capability (em transição)

`GET /api/admin/trocas`, `GET /api/admin/trocas/:id` e `POST /api/admin/trocas` são repasse direto
de `/v1/stores/exchanges`. Não há tabela de trocas no Oria, nem máquina de estados, nem política,
nem histórico próprio. A validação do handler (motivos que exigem foto e descrição) **espelha** a
regra documentada da Ink, não uma regra do Oria. Trocar o provider apaga a funcionalidade inteira.

### `refunds` → connector capability (em transição)

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

### `meta_ads`, `google_ads`, `analytics_ga4` → **features, ainda sem guard**

São capacidades do Oria pelo critério de sempre: a conexão com a Meta, o Google Ads e o GA4 é
OAuth do próprio cliente, e trocar a Reserva Ink por outro fornecedor não apaga nenhuma delas.

Entraram no vocabulário, no domain e no plano `internal` (migration `0024`). O que elas **não**
têm é guard: nenhuma rota confere a chave, e por isso o estado delas é `sem_guard`, não
`implementada`. A distinção é o ponto — `sem_guard` diz "o plano descreve, o código ainda não
aplica", e impede que `tenancy:seed-entitlements` as semeie como se protegessem alguma coisa.

A ordem importa e é a mesma da retirada, ao contrário: **primeiro a chave entra no plano, depois o
guard liga**. Ligar o guard antes tiraria Meta Ads do Tenant #1 — que é exatamente o acidente que
esta rodada evitou do outro lado.

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

A ordem executada foi a do comando §20, **corrigida a meio caminho**:

1. registry de connector capabilities introduzido;
2. rotas de Catálogo/Trocas/Reembolsos movidas de `ROTAS` para `ROTAS_CAPABILITY` — **revertido**,
   ver "A correção de rota" logo abaixo;
3. vocabulário comercial ajustado nas três cópias (painel, control plane, UI do control plane);
4. plano `internal` atualizado (migration `0024`, **aditiva**), sem tirar o que o runtime ainda confere.

Nenhum acesso foi retirado:

| Antes (plano `internal`) | Depois | Caminho de acesso |
|---|---|---|
| `catalog` | `catalog` | **inalterado** — continua feature até o guard de connector ligar |
| `exchanges` | `exchanges` | **inalterado** — idem |
| `refunds` | `refunds` | **inalterado** — idem |
| `creative_clean_angles` | — | `creative_generator` → modo `clean_angles` |
| `creative_remarketing` | — | `creative_generator` → modo `remarketing` |
| `creative_funnel_visual` | — | `creative_generator` → modo `funnel_visual` |
| `creative_multi_product` | — | `creative_generator` → modo `multi_product` |
| `creative_generator` | `creative_generator` | inalterado |
| `financial` | `financial` | inalterado |
| `whatsapp` | `whatsapp` | inalterado |
| — | `meta_ads`, `google_ads`, `analytics_ga4` | **entraram** (sem guard; ver a classificação acima) |

O teste `test/invariants/capabilities-classificacao.test.js` (§20) percorre essa tabela e reprova
se qualquer linha perder o caminho de acesso.

### A correção de rota

O passo (2) original tirava Catálogo, Trocas e Reembolsos de `ROTAS` e os punha em
`ROTAS_CAPABILITY`. O raciocínio registrado era "sair do eixo de feature é afrouxar, logo ninguém
perde acesso". Ele estava certo sobre o afrouxamento e **errado sobre o que isso significa**:
`server.js` só consome `featureDaRota`. `ROTAS_CAPABILITY` não está ligada em lugar nenhum. Mover
a rota para lá não trocava um guard por outro — **removia** o guard e deixava a promessa de que um
dia haveria outro.

E a segunda metade do passo (4) piorava: com `plan_features` virando fonte canônica na migration
`0023`, apagar `catalog` do plano passou a ser 403 imediato em Catálogo — a tela que funciona
hoje. As duas mudanças juntas produziriam, no mesmo deploy, uma rota sem verificação e uma tela
fora do ar.

A correção foi devolver as três ao eixo de feature e deixar `ROTAS_CAPABILITY` declarada como
**destino**, não como estado. As duas tabelas se sobrepõem de propósito nesta fase: uma diz onde a
rota está protegida hoje, a outra diz para onde ela vai.

### Plano de retirada (§10)

Para cada uma das três chaves em transição, nesta ordem e **nunca fora dela**:

1. ligar o guard de capability no pipeline de `requireAdmin` (`capabilityDaRota` → `requireCapability`),
   com a conexão da Ink lida do banco da Organization;
2. provar em teste que a rota responde `409 connector_nao_conectado` sem segredo e `200` com;
3. tirar a rota de `ROTAS` (ela já está em `ROTAS_CAPABILITY`);
4. tirar a chave de `FEATURES` e movê-la para `FEATURES_DEPRECIADAS`, nas três cópias;
5. só então a migration que apaga a chave de `plan_features` e dos overrides.

O passo (5) antes do (1) é exatamente o acidente que esta rodada corrigiu. O controle negativo
`§12` reprova qualquer tentativa de fazer (4) ou (5) enquanto o guard ainda conferir a chave —
tanto do lado do vocabulário quanto do lado do plano `internal`.

Enquanto a transição não fecha: `FEATURES_EM_TRANSICAO` (no painel) guarda a condição de saída de
cada chave, e as rotas continuam protegidas por sessão, contexto de Organization, RLS **e** o
entitlement comercial. As que falam com a Ink já falham sozinhas com
`409 INTEGRATION_NOT_CONNECTED` quando não há segredo.

### Limpeza posterior das quatro chaves de criativos (contract)

A `0024` ficou aditiva depois de uma correção. A versão anterior apagava as quatro linhas de
`plan_features` no mesmo release em que o código parou de lê-las, e a auditoria só olhava o código
**novo**. O código de produção que estava no ar ainda fazia
`entitlements[flag] === true` para cada motor, e o pre-deploy roda a migration **antes** de a
release nova assumir:

- na janela entre o migrate e a troca de release, os quatro motores do Gerador cairiam;
- se a release nova falhasse depois de migrar, a antiga seguiria no ar com os motores desligados,
  sem nada no deploy que avisasse.

"Consumidor convertido" quer dizer **convertido em produção**. O guard estático
`migration · a 0024 é aditiva` (com controle negativo) reprova um `DELETE` nessa migration.

A limpeza é uma migration própria, para uma rodada posterior, com estas pré-condições:

1. a release com `resolveFlags` derivando os motores de `creative_generator` está **no ar** e
   verificada (não basta estar mergeada);
2. os `effective entitlements` da Use Origens seguem com `creative_generator = true` e os motores
   do Gerador respondem;

```sql
DELETE FROM organization_entitlement_overrides
 WHERE feature::text IN ('creative_clean_angles', 'creative_remarketing', 'creative_funnel_visual', 'creative_multi_product');
DELETE FROM plan_features
 WHERE feature::text IN ('creative_clean_angles', 'creative_remarketing', 'creative_funnel_visual', 'creative_multi_product');
```

O `down` dessa migration restaura as quatro linhas só no plano `internal`, que é o único semeado.
O domain `platform_feature` só é estreitado depois disso (Phase E).

## Depreciação das chaves antigas

As **quatro** chaves efetivamente retiradas — os modos do Gerador — ficam declaradas como
`deprecated`, `non-commercial`, `ignored for entitlement resolution` (`FEATURES_DEPRECIADAS`, nas
duas cópias). Puderam sair porque o consumidor runtime delas já tinha migrado: `resolveFlags`
deriva os quatro motores de `creative_generator` e não lê mais as chaves. Elas:

- **não** aparecem em nenhuma UI de plano;
- **não** aceitam override novo no control plane (`422 feature_desconhecida`, com motivo);
- são negadas por `checkEntitlement` mesmo gravadas como `true` num `app_config` antigo;
- **continuam gravadas** em `plan_features` até a migration de limpeza (abaixo) — a `0024` é aditiva de
  propósito. São ruído: `resolverAcessoEfetivo` só itera sobre `FEATURES`, o `planoEfetivo` do painel as
  descarta e a tela de planos do Oria Admin só renderiza features do vocabulário;
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
