# Parcerias e Afiliados · auditoria de integração (27/09/2026)

Registro do que existe no Oria, do que a API da INK documenta e do que foi **de fato confirmado localmente**. Base: código do
repositório na `main` de 27/09/2026 (`8dfe5a8`) e `apps/panel/documentacao-api-ink.yaml`. Nenhuma chamada foi feita à INK real,
nenhum dado real foi lido e nenhuma migration rodou fora de banco descartável.

Legenda: **confirmado** = provado por código + teste local · **disponível no código** = o contrato/estrutura existe, mas não foi
exercitado contra a INK real · **pendente de validação real** = depende de resposta real da INK ou de decisão de produto.

## 1. O que já existia e foi reaproveitado

| Necessidade | Onde está | Uso nesta rodada |
|---|---|---|
| Tenancy 1 Organization = 1 Store | `stores UNIQUE (organization_id)` (`uq_stores_organization`), `ORIA-TENANCY-STORE-01`, RLS forçada por `app.current_organization_id` | Todas as 20 tabelas novas nascem com `organization_id/store_id` + FK composta + policy canônica |
| Contexto do tenant na request | `requireAdmin` → `req.tenant` (sessão), `TENANT_SELECTOR_NOT_ALLOWED` | Router do módulo só lê `req.tenant`; seletor no corpo/query é 400 |
| Pedidos e itens sincronizados | `pedidos_ink`, `pedidos_ink_itens` (sync horário, webhook, backfill) | Fonte única. **Nenhum crawler novo** e nenhuma chamada nova à API da INK |
| Catálogo canônico | `commerce_products.metadata.productClusterId` | Descoberta de produtos do mesmo agrupamento e busca de produto para a collab |
| Papéis | `organization_members.papel IN ('owner','member')` | Mapeamento owner/member (ver §5) |
| Jobs por Organization com lease | `JOBS.agendar` | Reconciliação periódica, atrás de flag |
| Componentes de UI, filtros, tabelas | `src/components/ds` | Telas novas sem biblioteca visual nova |

## 2. Achados sobre o modelo real dos pedidos (ponto crítico)

O cache **não persistia** vários campos de que a apuração precisa. O documento de execução supunha que existiam; não existiam:

| Campo da INK | Estava em `pedidos_ink*`? | Ação |
|---|---|---|
| `promotion_code` | não | migration `0045` + gravado pelo upsert existente |
| `promotion_value`, `payment_discount_value`, `freight_value_difference`, `kickback_value` | só o agregado `descontos` | colunas próprias (o rateio precisa separar promoção de forma de pagamento; frete nunca entra na base) |
| `delivery.delivered_at` | não | `delivered_at` |
| `items[].refunded_quantity`, `free_quantity` | não | colunas em `pedidos_ink_itens` |
| `items[].unit_value`, `unit_ink_base_price`, `unit_additional_service_price` | só `custo_producao` total | colunas unitárias |
| `product_v2.id` | sim (`produto_id`) | usado como chave de atribuição |
| `product_variant.id`, `product_v2.product_cluster_id` | não | `product_variant_id`, `product_cluster_id` |
| `paid_at` | **não existe na API de pedidos** | política `payment_plus_days` usa a data de **observação** do pagamento (aproximação declarada) |

Consequência tratada com fail-closed: pedido anterior à migration tem `affiliate_snapshot_at IS NULL`. O módulo **nunca** o trata como
"sem cupom": ele vira item em `Revisões` (`order_data_incomplete`). Só um payload completo (com itens) marca o snapshot; evento parcial
não apaga o que já se sabe.

## 3. Matriz de capacidades da INK

| Capacidade | Estado | Evidência / observação |
|---|---|---|
| Listar pedidos com `promotion_code` | **disponível no código** | Campo documentado na especificação; gravado pelo upsert; provado com o mock local (loja de teste `F`) — a resposta real da INK para esta conta não foi lida |
| Semântica de `unit_ink_base_price` como custo de produção | **confirmado** (parcial) | `lib/ink/financeiro.js` documenta validação contra 152 pedidos reais (`kickback = Σ itens − Σ custo base − promoção − …`). Margem do módulo = receita líquida − custo de produção da INK; **não** inclui taxas, tributos nem frete |
| `kickback_value` | **confirmado** como dado de conferência | Nunca é base de comissão |
| Rateio de desconto por linha | **disponível no código** | A INK não devolve desconto por item; rateio por valor bruto (maior resto). Pressuposto: promoção incide em todas as linhas (uma promoção restrita a produtos pode distorcer o rateio) |
| `free_quantity` (promoção `unit_free`) | **pendente de validação real** | Semântica de `total_value` da linha com unidade grátis não confirmada → o item vai para revisão, não é comissionado |
| `refunded_quantity` | **disponível no código** | Devolução parcial vira ajuste compensatório; testado com dados sintéticos |
| Estados de pagamento | **confirmado** | Conjunto inglês da spec + rótulos em português observados em produção (já normalizados pelo `server.js`); estado desconhecido → revisão |
| Troca (`is_exchange`) | **confirmado** | Não é venda nova |
| `GET /v1/stores/promotions?code=` | **disponível no código** | Escopo `store.promotions.read`. Usado em **uma** chamada de leitura por verificação manual de cupom; nunca em varredura |
| `POST /v1/stores/promotions/standard` (+ `Idempotency-Key`) | **disponível no código, desligado** | Adapter isolado (`lib/afiliados/ink-promotions.js`) com testes de contrato; `ink_promotion_writes_enabled=false` fixo em código e **nenhum cliente de escrita é injetado**. Não sabemos se o plano/escopo da loja habilita escrita |
| Cupom "comum" reaproveitável por muitos pedidos | **pendente de validação real** | Depende de `usage_limit` e do tipo de promoção da loja |
| Programa de afiliados nativo da INK | **não usado** | Não é criado nem lido. Não há campo que permita detectar afiliado nativo por pedido → o lojista declara `legacy_ink_affiliate` no parceiro e o módulo bloqueia a atribuição (evita pagar em dobro) |
| Webhooks | **disponível no código** | O handler existente (HMAC, idempotência por evento) já dispara o upsert com estado corrente da API; nenhum destino novo foi criado. A ordem de chegada não importa: sempre vale o estado corrente |
| `begin_date` incremental | **confirmado** | Filtra data de **criação**: por isso a reconciliação reavalia pedidos com comissão ainda provisória/retida e os alterados desde a última rodada |
| Limite de 100 req/min por token | **respeitado** | O módulo não cria tráfego novo relevante (0 chamadas por rodada; 1 por verificação manual de cupom) |

### Primeira operação remota futura (após autorização, **não executada**)

`GET /v1/stores/promotions?code=<CÓDIGO>&per_page=5` (leitura, 1 chamada, escopo `store.promotions.read`) para validar um cupom
cadastrado à mão. Só depois, em ambiente de teste e com a flag ligada por release, o `POST /v1/stores/promotions/standard` com
`Idempotency-Key` derivada da intenção (ver §7).

## 4. Riscos e lacunas conhecidos

1. **Pedidos históricos sem snapshot**: ficam em `Revisões` até o webhook/sync/backfill tocá-los. O backfill histórico existente é a
   forma de preenchê-los (fora do escopo desta rodada em produção).
2. **Custo de produção ≠ margem econômica total** (sem taxa de gateway, imposto, frete). A tela rotula "margem de produção" e o teto
   de nível trata contratos por receita/fixo por equivalência projetada sobre as vendas gerais da loja.
3. **`paid_at` inexistente**: `payment_plus_days` é aproximação (data de observação).
4. **Calendário**: fim de semana desloca para segunda; feriados não são calculados.
5. **Comprovante de pagamento**: guarda-se só uma referência textual; não há upload de anexo protegido nesta versão.
6. **Afiliado nativo da INK**: não detectável pela API (ver §3).
7. Papéis `finance`/`marketing` **não existem** no schema (`owner|member`) — ver §5.

## 5. RBAC real × o pedido

O documento de execução fala em `owner/admin/finance/marketing/operacao`. O schema só aceita `owner` e `member`
(`ck_organization_members_papel`). Decisão: **owner** faz tudo; **member** cadastra e acompanha (parceiros, candidaturas, collabs em
rascunho, cupons planejados, contratos em rascunho) e **não vê nem altera dinheiro** (contas a pagar, pagamentos, lotes, exportação,
extrato, KPIs financeiros da visão geral). Níveis e benefícios: leitura para os dois, decisões/concessões só do owner. Cada rota confere o papel no backend e há teste chamando os endpoints direto. Papéis
mais finos exigem migration de `organization_members` e decisão de produto (fora do escopo).

## 6. Validação real da INK · rodada de validação (28/09/2026) — **NÃO EXECUTADA: credencial indisponível localmente**

### Inspeção do connector (feita, somente leitura de código)

- Caminho da chamada: `criarAfiliados({ inkClient: { get } })` (`server.js`, junto do `app.use('/api/admin/afiliados', …)`) → `inkApiRequestDaStore(caminho)` → `inkFetchDaStore('GET', caminho)`.
  O método HTTP está **fixo em `'GET'`** nessa função; o cliente injetado só tem `get` (nenhum `post`/`put`/`patch`/`delete`).
- O adapter (`lib/afiliados/ink-promotions.js`) usa `client.get` em **um único** ponto (`verificarCupom`: `GET /v1/stores/promotions?code=<code>&per_page=5`) e recusa `criarCupom` com `PromotionWritesDisabledError` quando `client.post` não existe ou a flag é `false` (fixa em `false` no código). Nenhum fluxo dispara POST/PATCH/PUT/DELETE por efeito colateral.
  Provado também em execução: com o painel local, `POST …/coupons/:id/ink-create` responde `409 INK_PROMOTION_WRITES_DISABLED` e a prévia informa `enviaria: false`.
- Credencial: token da INK por Organization, cifrado, lido via `comTokenInkDaStore` → `usarSegredo('ink', 'api_token')`; escopo necessário para a leitura: `store.promotions.read`.
  O request não escolhe a credencial. Só existe se a Organization tiver a integração da INK configurada.

### Por que a chamada real não foi feita

O ambiente local não tem token da INK: não há variável `INK_*`, nem `.env`, e a Organization de demonstração (dados 100 % sintéticos) não tem o segredo `ink/api_token` — a verificação responde `502 INK_LEITURA_FALHOU` (o connector devolve 503 "organization não tem a integração… configurada"). O token real vive só nos bancos de produção/staging, que esta rodada **não** deve acessar, e por regra da rodada não se inventa nem se pede segredo. **Etapa interrompida aqui; nada foi enviado à INK.**

### Situação após esta rodada (inalterada em relação ao §3)

| Item | Estado |
|---|---|
| Formato real da resposta de `GET /v1/stores/promotions?code=` (campos, `free_quantity`, `usage_limit`/reuso, paginação) | **não observado** — só mock/contrato |
| Escopo mínimo de leitura | `store.promotions.read` **declarado**, não confirmado contra a API |
| Escrita de promoções (POST `/standard`) | **mock-only**, desligada |
| Diferenças mock × produção | **desconhecidas**; o parser do adapter é tolerante (`data`/`promotions`/array) e o cupom sem retorno vira "não encontrado", nunca é criado |

### Decisões e passos antes de qualquer escrita futura

1. O dono da loja executa (ou autoriza) o `GET` numa Organization real com token INK e cupom seguro; comparar o payload com o mock (`test/helpers/provider-mock.cjs`) e ajustar o parser/`montarPedidoDeCriacao` se houver divergência.
2. Confirmar o escopo/plano que habilita `store.promotions.write` e o comportamento de `Idempotency-Key`.
3. Decidir a semântica de `free_quantity` e de cupom reaproveitável (`usage_limit`) — hoje viram revisão manual.
4. Só depois: liberar escrita **por release** (mudança de código + cliente de escrita injetado + teste em loja de teste), nunca por configuração em runtime.

## 7. Contrato oficial de Promoções × implementação (rodada de fechamento · 28/09/2026)

Fonte de verdade: `developers.reserva.ink/referencia/#tag/promoções` (arquivo `referencia.md` do portal) e `/guias/promocoes`, lidas nesta rodada.
**O Oria tem o próprio programa de afiliados; as Promoções da INK são infraestrutura de cupom/desconto; comissão e tracking ficam no Oria.**
Arquitetura 1:1 (1 workspace = 1 loja): não existe agregador de lojas, comissão/afiliado/nível global nem consolidação de várias lojas.

### Confirmado pela documentação oficial

| Tema | O que a documentação diz |
|---|---|
| Endpoints | `POST /v1/stores/promotions/standard`, `GET /v1/stores/promotions` (filtros `type`, `code`, `page`, `per_page`), `GET /v1/stores/promotions/{id}`, `PATCH /v1/stores/promotions/standard/{id}`, `DELETE /v1/stores/promotions/{id}` |
| Escopos | leitura `store.promotions.read`; escrita `store.promotions.write` |
| Idempotência | `Idempotency-Key` (string, "única por operação") **obrigatório** em POST/PATCH/DELETE |
| Corpo de escrita (`standard`) | só `code` é obrigatório no schema; `kind` `percentage\|value`; `list_type` `all\|products\|product_types\|collections` (+ `product_ids`/`product_type_ids`/`collection_ids`); `apply_automatically`, `first_purchase`, `show_on_product_page`/`show_in_cart` (guia), `usage_limit` (`integer\|null`), `starts_at`/`expires_at` (`date-time`); `discount_tier{discount:number, min_cart_value:number, min_cart_items:integer}`. `discount_tier` ausente → `422` |
| Leitura | envelope `{promotions[], page, per_page, total_pages, total_count}` (`per_page` padrão 5, máx. 100); detalhe e escritas devolvem `{promotion}`. **Assimetria:** a leitura traz `discount_tiers` (array) com `discount`/`min_cart_value` como **string** (`"10.0"`) |
| Filtro por código | exato, **sem diferenciar maiúsculas/minúsculas**; código único por loja |
| `available` | **calculado** pela INK (não expirada, não agendada, sem estourar `usage_limit`); não é configuração |
| Status | `201` criação, `200` PATCH (parcial, campos omitidos não mudam), `204` DELETE (soft delete; o código volta a ficar livre), `401`, `403` (escopo/plano), `404` (inexistente, outra loja, excluída ou subtipo errado), `422` (`code` duplicado, `discount_tier` ausente…) |
| Subtipo | imutável; `PATCH` só no endpoint do próprio subtipo |

### Confirmado por mocks/contract tests (INK falsa em memória, `test/helpers/ink-promotions-fake.js`)

Mapper `standard` (sem comissão, sem gatilho inventado); GET por código (achado, não achado, case-insensitive, envelope inesperado = erro, mais de um
resultado ou total maior que a página = ambíguo); GET por ID (sucesso e 404); POST (payload, `201`, ID persistido, leitura de volta,
403/409/422/timeout, retry com a mesma chave sem duplicar); PATCH (parcial, endpoint, chave por patch, falha sem corromper estado local); DELETE
(endpoint, chave, replay idempotente, 404); ativação fail-closed (existente compatível, divergente, inexistente com escrita desligada/ligada, falha
de POST/GET); pausar/encerrar sem tocar na INK; zero POST/PATCH/DELETE com flag desligada, cliente só-leitura ou escopo não declarado.

### Corrigido em relação ao mock anterior

- O parser tratava qualquer resposta sem lista como "não encontrado" (e então tentaria criar). Agora envelope fora do contrato é **erro** (`INK_BAD_RESPONSE`).
- `available=false` era divergência de configuração; agora é estado observado (só bloqueia se a promoção deveria estar valendo).
- `Idempotency-Key` fixa por vínculo (`oria-affiliate-coupon-<id>`) reaproveitaria a chave com payload diferente; agora é derivada da intenção (operação + vínculo + hash do conteúdo).
- **Ativar cupom não confirmava nada na INK** (cadastro manual virava "Ativo"): agora é fail-closed (ver `arquitetura.md` §7). O mock devolvia `discount` numérico; o contrato manda string.

### Ainda **não** confirmado ponta a ponta (sem credencial real da loja)

- Resposta real da conta e escopos efetivamente concedidos ao token; se o plano permite escrita.
- Se a INK aceita `discount_tier` **sem** gatilho (`min_cart_value`/`min_cart_items`). O schema não os marca como obrigatórios e o Oria **não inventa** valor mínimo; se a conta exigir um, é decisão de produto.
- Criação/edição/exclusão reais; comportamento real com cupom já existente; reuso do mesmo código em vários pedidos (`usage_limit` nulo); `show_on_product_page`/`show_in_cart` na escrita (documentados no guia e no schema de leitura, não listados no schema de escrita da referência); edge cases.

Ressalva correta: **integração ainda não validada end-to-end contra uma credencial real da loja.**

### Decisões antes de habilitar escrita

1. Confirmar escopo/plano `store.promotions.write` e o comportamento do token com o dono da loja.
2. Definir o gatilho mínimo aceito pela INK (se a conta o exigir) e se o Oria o configura por cupom.
3. Habilitar escrita **por release** (cliente com `post/patch/delete` injetado + `inkScopes` + flag), primeiro numa loja de teste, nunca por configuração em runtime.
4. Política para promoção existente divergente (hoje: não ativa; corrigir no Oria ou na INK e verificar de novo).
