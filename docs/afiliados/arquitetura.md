# Parcerias e Afiliados · arquitetura

O **Oria é o livro-razão das comissões da loja** e tem o **próprio programa de afiliados** (cadastro, contrato, nível, benefício, comissão,
ledger, contas a pagar, pagamentos, collabs e tracking). A INK entra só como fonte de pedidos/catálogo e como **infraestrutura de
cupom/desconto** (Promoções `standard`). Nada aqui usa o programa de afiliados nativo da INK nem o `kickback_value` como base de repasse.
Promoção INK e comissão Oria são conceitos diferentes: o desconto do cliente (ex.: 10 %) vai para a INK; a comissão negociada (ex.: 15 % da
base do contrato) **nunca** vai para a INK.

```text
Parceiro no Oria → contrato → promoção/cupom na INK → pedidos da INK → tracking e comissão no Oria → ledger → pagar
```

## 1. Política 1:1 e isolamento

- 1 Organization (workspace) = 1 Store (`ORIA-TENANCY-STORE-01`). Não há painel multiloja, agregado entre lojas, afiliado compartilhado
  nem seletor de marca. `store_id` nas tabelas novas é dado operacional (FK composta `(store_id, organization_id) → stores`).
- Toda tabela nova é **plataforma** no manifesto de tenancy (`lib/platform/tenancy-manifest.js`), com RLS forçada e a policy canônica.
  A matriz de isolamento (`tenancy-isolation.test.js`) grava uma linha de A e de B em cada uma das 20 tabelas e prova leitura/escrita
  cruzada recusada.
- O tenant vem **só da sessão** (`req.tenant`). `organizationId/storeId` em query, header ou corpo → 400. Todo SQL também filtra por
  `organization_id` (defesa em profundidade; a RLS é o piso). Id que não é UUID responde 404 igual a "não existe".

## 2. Modelo de dados (migrations `0044` e `0045`)

Dinheiro em **BIGINT centavos (BRL)**, percentuais em **basis points**, datas em UTC (regras de calendário no timezone da loja).

| Tabela | Papel |
|---|---|
| `partnership_settings` | Config 1:1 da loja (timezone, avisos, mínimo de contribuição, orçamento de benefício, marca-d'água da reconciliação) |
| `partnership_partners` | Parceiro: contato mínimo, candidatura × vínculo (eixos separados), aceite de termos, `legacy_ink_affiliate` |
| `partnership_contracts` / `partnership_contract_versions` | Contrato e **versões econômicas append-only** (trigger recusa UPDATE/DELETE) |
| `partner_coupon_links` | Cupom: código normalizado, vigência, estado local × sync com a INK; sobreposição de vigência do mesmo código recusada por trigger |
| `partner_collabs`, `partner_collab_creators`, `partner_collab_product_memberships` | Collab, participação por criador (soma ≤ 100% por trigger) e **vínculo versionado por `ink_product_id`** com vigência |
| `partnership_attributions` | Atribuição por item: evidência, **snapshot original imutável** e `current_state` (estado corrente) |
| `partnership_review_items` | Itens que o sistema não decide sozinho (fail-closed) |
| `partner_commission_ledger` | Lançamentos **assinados** em centavos; valor imutável (trigger); nunca apagado |
| `partner_payout_batches`, `partner_payout_batch_items` | Fechamento (congela o que será pago) |
| `partner_payment_records`, `partner_payment_allocations` | Pagamento real + **rateio por lançamento**, append-only; invariante de saldo por trigger com `FOR UPDATE` |
| `partnership_level_rule_sets`, `partner_level_history`, `partner_level_proposals` | Regras de nível versionadas, histórico e propostas com aprovação |
| `partner_benefit_ledger` | Carteira de benefícios, separada das comissões |
| `partnership_audit_events` | Auditoria append-only |

`0045` só adiciona colunas nulas a `pedidos_ink`/`pedidos_ink_itens` (ver a auditoria de integração). É aditiva e reversível; nenhum
comando destrutivo em dado legado.

## 3. Motor de atribuição por item (`lib/afiliados/engine.js`, puro)

Entrada: pedido/itens em centavos, cupons, collabs (com histórico de vínculo), versão de contrato por data. Saída: atribuições,
revisões e alvo de comissão. Sem banco, relógio ou rede.

Para cada **linha** (nunca por pedido):

1. **Base**: `bruto` da linha − parcela do desconto do pedido (promoção + forma de pagamento) rateada pelo valor bruto (maior resto,
   soma exata). Frete e `kickback_value` nunca entram. Unidades devolvidas/gratuitas saem da base elegível.
2. **Quem tem direito**:
   - collab: `product_id` da linha × vínculo versionado válido **na data da venda** (nome, imagem, slug e cluster **não** atribuem);
   - cupom: código normalizado (trim + maiúsculas) × vínculo `active` com a data dentro da vigência.
3. **Política de conflito** (`collab_precedence` por padrão): item de collab paga o criador; cupom de terceiro não gera comissão sobre
   esse item; o mesmo parceiro titular dos dois **não recebe duas vezes** (o cupom fica só como evidência). `coupon_precedence` e
   `split_explicit` (dupla comissão com fatias que somam 100% e confirmação administrativa) são contratuais.
4. **Regra do contrato vigente na data da venda**: `% da receita líquida`, `% da margem de produção verificada` ou `fixo por unidade`,
   aplicada à fatia do parceiro (participação do criador). Base em margem exige custo conhecido; sem custo → revisão, nunca chute.
5. **Estado do pedido**: cancelado/reembolsado/chargeback → alvo 0; aguardando pagamento → provisionado; disputa → retido; troca → não é venda.
6. Exemplo obrigatório (testado): 2 itens de R$ 100, desconto R$ 20, custo R$ 60 → margem R$ 30 por item; collab 20% = R$ 6,00, cupom
   15% = R$ 4,50, total R$ 10,50 (sem os R$ 4,50 duplicados sobre o item da collab).

Colisões que vão para **revisão manual** (nunca pagam sozinhas): item sem `product_id`, variante exigida e ausente, produto em duas collabs,
dois cupons possíveis, criadores com políticas diferentes, collab sem criador com contrato ativo, unidade grátis, status desconhecido,
pedido sem snapshot, custo desconhecido em base de margem. Parceiro com afiliado nativo da INK declarado → atribuição `blocked`.

## 4. Ledger, idempotência e estornos (`lib/afiliados/reconcile.js`)

- O ledger recebe **deltas**: `alvo − soma dos lançamentos da atribuição`. Reprocessar o mesmo estado não cria nada; concorrência é
  serializada por advisory lock por pedido e pela chave única `(organization, parceiro, origin_key)`.
- Devolução/cancelamento/chargeback = **lançamento compensatório**; o original e o histórico permanecem. Estorno líquido sem pagamento
  anula o par (`reversed`). Depois de pago, o ajuste vira débito **a compensar** no próximo pagamento; o Pix registrado nunca é alterado.
- Evento antigo não reabre pedido cancelado: o estado usado é sempre o **corrente** do cache, não o do evento.
- Mudança de contrato/nível hoje não altera pedidos de ontem: cada atribuição guarda a `contract_version_id` e o snapshot originais.
- Ativação de cupom e aprovação de produto de collab **não são retroativas** (só com comando expresso, motivo e auditoria).

## 5. Contas a pagar

Cinco datas **distintas**, com filtros independentes que nunca se somam:

| Data | Significado |
|---|---|
| `sale_at` | pedido |
| competência | mês da venda (fuso da loja) |
| `release_at` | quando fica pagável |
| `estimated_payment_at` / `due_at` | previsão × vencimento |
| `paid_at` | quando o lojista **transferiu** (≠ `recorded_at`, quando lançou) |

Política padrão do piloto (por contrato, não retroativa a contratos existentes): libera 7 dias após a **entrega**; paga no **dia 10 do
mês seguinte** à liberação; mínimo R$ 50 (abaixo disso acumula); fim de semana vai para segunda (sem feriados). `payment_plus_days`
usa a data de observação do pagamento.

- `vencido` = saldo **liberado** em aberto com a **data** de vencimento anterior a hoje (vencer hoje não é atraso).
- `previsto` (provisório/carência) **nunca** entra na dívida; KPIs separam `previsto` × `disponível` × `vencido`.
- Pagamento: rateio explícito por lançamento, parcial ou total, **sem adiantamento**; idempotência por chave e por referência externa;
  concorrência resolvida por `SELECT … FOR UPDATE` + trigger de invariante. Correção só por **estorno administrativo** (contralançamento).
- Fechamento em lote (rascunho → aprovado → pago/parcial/vencido derivados dos pagamentos; anulável só sem pagamento).
- Cachê por conteúdo é **categoria separada** (`content_fee`); benefícios/permuta ficam na carteira própria e nunca viram dinheiro a pagar.
- CSV: mesmos filtros, só colunas necessárias, sem dado de comprador/segredo, fórmulas neutralizadas (`= + - @ TAB CR`).

## 6. Níveis e benefícios

Regras por loja, versionadas (padrão sugerido: Raiz/Voz/Referência/Embaixador). Metas simultâneas sobre vendas **elegíveis** (pagas,
sem devolução; cupom + collab na mesma linha contam uma vez); meta de margem sem custo verificado fica "não verificada" e **não promove**.
O sistema **propõe**; o lojista aprova. Nível altera elegibilidade e benefícios, nunca reescreve contrato em vigor nem comissão passada.
Peça nunca é grátis ao ingressar: exige vendas, período, atividade e saldo, ou exceção "criador convidado" com entregáveis e aprovação.

## 7. Integração com a INK

- Ingestão: o **mesmo** upsert de pedido do sync/webhook grava os campos novos (`lib/ink/afiliados-campos.js`). Zero chamada nova.
- Cupom = **Promoção `standard` da INK** (`lib/afiliados/ink-promotions.js`, contrato oficial de Promoções): `GET /v1/stores/promotions?code=` e
  `GET /{id}` (leitura), `POST /standard`, `PATCH /standard/{id}` e `DELETE /{id}` (escrita, `Idempotency-Key` obrigatório). Mapper Oria → INK:
  `kind`, `list_type=all`, `apply_automatically=false`, `show_*=false`, `first_purchase=false`, `usage_limit=null`, vigência e
  `discount_tier{discount}` **sem gatilho mínimo inventado**; nada de comissão/nível/benefício no corpo.
- **Ativação fail-closed** (`registry.ativarCupom`): Rascunho → *Aguardando INK* → Verificado/Criado → **Ativo**. Só ativa depois de a INK
  confirmar: (A) promoção existente e compatível (GET por código; vincula `ink_promotion_id`, registra a verificação e ativa); (B) inexistente
  com connector **sem criação** (modo manual) → **sem POST**, fica aguardando o vínculo; (C) inexistente com connector que cria → POST, e só após `201` válido + leitura de volta
  persiste ID/snapshot (na auditoria) e ativa; (D) 401/403/409/422/429/5xx/timeout/envelope inesperado → **não ativa**, preserva o estado e
  devolve erro compreensível (sem token). Divergência (código, tipo, desconto, gatilho, escopo, primeira compra, limite, vigência,
  aplicação automática, exibição) **não ativa** e é listada; `available` é estado calculado pela INK, não configuração.
- Idempotência: `Idempotency-Key` **determinística pela intenção** (`oria-aff-<create|update|delete>-<vínculo>[-<id>]-<hash do conteúdo>`): retry
  reenvia a mesma chave, outra intenção/payload gera outra; só UUID interno e hash. Retry automático só para falha transitória (timeout/429/5xx).
- **Encerramento fecha o desconto na INK sem apagar a promoção.** Encerrar o **parceiro** (vínculo `ended`), encerrar o **contrato** ou pausar/encerrar o
  **cupom** fecham a vigência no Oria (mesma transação, com auditoria por cupom: `coupon.end.partner_ended`, `coupon.end.contract_ended`) e,
  depois do commit, fazem `PATCH` só de `expires_at` na INK quando o connector atualiza (melhor-esforço: se a INK falhar, o encerramento vale, o cupom
  fica com `sync_status=error` e o owner usa "Sincronizar com a INK"; a resposta traz `inkSync`/`cupons.ink`). **Retomar** reabre o fim da
  promoção (`expires_at: null`). Pausar o vínculo do parceiro não mexe nos cupons. `DELETE` (`ink-delete`, botão "Excluir na INK") continua
  operação explícita de owner, com motivo e cupom pausado/encerrado — nunca consequência de encerrar.
- **Escrita é funcionalidade do painel, sem flag**, determinada pela **capacidade do connector**: o `server.js` injeta o cliente da INK com
  `get/post/patch/delete` (credencial da Organization do contexto). Só ocorre por ação explícita de owner (Ativar, `ink-create`, `ink-sync`,
  `ink-delete`), com `Idempotency-Key`, e nada é ativado sem `201` válido + leitura de volta. `/status` expõe `couponCreation`
  (`{provider, read, create, update, delete}`); a UI e o fluxo se adaptam a isso.
- **Outros connectors (futuro):** cada connector de loja implementa a mesma interface de cupom (`verificarCupom`, `criarPromocao`,
  `atualizarPromocao`, `excluirPromocao`, `capacidades`, `bloqueioDeEscrita`). Se o connector tem integração de criação de cupom → **fluxo
  idêntico** (só muda o contrato/mapper do connector). Se não tem → **modo manual**, como antes: cria-se o cupom na loja e o Oria só cria o
  vínculo (`Verificar`/`Ativar` confirmam por leitura, se o connector ao menos lê; sem leitura, o vínculo fica aguardando).
- Não validado ponta a ponta contra credencial real da loja (ver `auditoria-integracao.md` §6–§7).

## 8. Segurança e privacidade (invariantes)

- Nenhum dado de comprador nas tabelas do módulo (só ids de pedido/item). Nenhum dado bancário/documento do parceiro.
- Papéis conferidos no backend; corpo com campo desconhecido → 400; CSRF em toda escrita; erro inesperado → 500 genérico (sem SQL).
- Históricos append-only por trigger `AFTER` (a RLS `WITH CHECK` continua sendo a primeira barreira); DELETE em cascata a partir da
  Organization continua possível (`pg_trigger_depth()`).
- Auditoria de contrato, política de conflito, pagamento/estorno, vencimento manual, override de nível/teto, benefício e resolução manual.

## 9. Operação em runtime

| Flag / job | Padrão | Efeito |
|---|---|---|
| `AFILIADOS_MODULE_ENABLED=true` | **desligada** | Sem ela: rotas 404 (menos `/status`), menu escondido, job inerte |
| job `afiliados-reconciliar` (30 min, lease por Organization) | ativo só com a flag e só para quem tem parceiro | Lê o cache local, reavalia pedidos alterados/em aberto, libera carências vencidas, propõe níveis |
| `POST /reconcile` (owner) | manual | Mesma rotina sob demanda; `completo:true` reprocessa tudo |

Mapa de código: `lib/afiliados/{money,schedule,engine,levels,csv,ink-promotions}.js` (puros) · `{db,registry,collabs,reconcile,payables,
progression,directory,index,routes}.js` (persistência/HTTP) · `src/pages/parcerias/*` (telas) · `scripts/afiliados/seed-demo.cjs` (cenário
local sintético).
