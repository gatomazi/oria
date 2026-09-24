# Fase G.1 — Remarketing e Funil por Criativo na UI V2

**Escopo**: só UI V2 (`GerarTabV2.tsx`, atrás de `CREATIVE_UI_V2_ORGS`). V1 (`GerarTab.tsx`) intacta —
é literalmente o mesmo componente, não tocado nesta fase, e continua sendo a experiência de quem não
tem a flag. Sem chamada OpenAI, sem push/merge/deploy, sem multipeça (G.2), sem F.2.C/Mockups/Connector.

## 1. Inspeção — matriz de contratos por motor

Fonte: `creative_core/contracts.py` (`RemarketingOptions`/`FunnelOptions`/`CreativeRequest`),
`creative_core/engines.py` (`_remarketing_parts`/`_funnel_parts`/dispatch de `plan_creative`),
`creative_core/domain/remarketing.py`, `apps/panel/lib/creative-core/requests.js`
(`buildRequests`/`normalizeJobInput`) e `GerarTab.tsx` (V1, já implementa os três motores — reaproveitado,
não reinventado).

**Confirmado, sem inspeção adicional necessária**: o backend (`requests.js`) é inteiramente
agnóstico de motor para resolução de ângulo (`angle_ids: ["auto"]`, `angle_family_hint`,
`custom_angle_id`) — a mesma "Sugestão para esta estampa" da V2 (Ângulos Limpos) já funciona,
sem nenhuma mudança de servidor, para Remarketing e Funil. `funnel`/`remarketing`/`funnel_stage`
já estão na whitelist de campos aceitos (`INPUT_KEYS`) e já são repassados ao core sem gate de
motor. G.1 é, portanto, trabalho de FRONTEND apenas.

### Ângulos Limpos (`CLEAN_ANGLES`) — inalterado, fluxo já existente na V2

| | |
|---|---|
| Decisão do lojista | Produto (o resto é recomendação real do motor) |
| Preenchimento automático | Ângulo (família/preset), cena, contexto — tudo |
| Controle simples | — (fluxo de 1 decisão: produto) |
| Controle avançado | Estilo (família/ângulo personalizado), cena (interação/pessoas/contexto/olhar), formato/quantidade |
| Validação | `funnel`/`remarketing` não podem ser enviados (o core rejeita: `INVALID_INPUT`) |

### Remarketing (`REMARKETING`)

| | |
|---|---|
| Decisão obrigatória | `remarketing.intent` (enum de 7: site_visitor, product_view, collection_discovery, cart, checkout, social_proof, objection) — **é o "Objetivo" do fluxo comum** |
| Preenchimento automático | `layout` (do ângulo + intent + produto único — `_choose_remarketing_layout`); `stage` do funil (`ETAPA_POR_INTENT[intent]`, nunca TOFU puro — remarketing pressupõe quem já conhece a marca); `headline`/`subheadline`/`cta` (defaults por intent, `communication.json`); `text_density`/`cta_emphasis` (perfil por etapa+intent) |
| Controle simples | Escolher o intent (cartões com rótulo + descrição curta) |
| Controle avançado (Personalizar) | `headline`, `subheadline`, `cta`, `benefits` (≤3), `social_proof_facts` (≤5, só relevante com intent=social_proof), `stage_override` (TOFU/MOFU/BOFU manual), `text_density`, `cta_emphasis`, `clean_mode` (enum: auto/always/never) |
| Regras de validação | `funnel` não pode ser enviado; `remarketing.intent` obrigatório; `product_view` é single-product-only (irrelevante em G.1 — V2 é sempre 1 produto); `cart`/`checkout` exigem `products_source:"basket"` só em multipeça (idem, fora de escopo G.1) |

### Funil por Criativo (`FUNNEL_VISUAL`)

| | |
|---|---|
| Decisão obrigatória | `funnel_stage` (TOFU/MOFU/BOFU, campo de nível raiz) — **é o "Objetivo" do fluxo comum** |
| Preenchimento automático | `funnel.headline`/`subheadline`/`cta` (defaults por `product_mode`+`stage`, `communication.json`); `badges`/`chips`/`search_bar_text` ficam vazios em TOFU ou modo limpo |
| Controle simples | Escolher a etapa (cartões TOFU "descoberta" / MOFU "consideração" / BOFU "decisão") |
| Controle avançado (Personalizar) | `headline`, `subheadline`, `cta`, `badges` (≤3, só MOFU/BOFU), `benefits` (≤3), `search_bar_text` (só MOFU/BOFU), `chips` (≤6, só MOFU/BOFU), `text_density`, `cta_emphasis`, `clean_mode` (**booleano** aqui — diferente do enum do Remarketing, já tratado assim na V1) |
| Regras de validação | `remarketing` não pode ser enviado; `funnel_stage` obrigatório (`INVALID_INPUT` se ausente) |

## 2. Experiência de uso

Fluxo comum preservado: **Produto → Objetivo → Recomendação real (`/preview`) → Gerar assim**.

1. **1. Tipo de criativo** (novo passo — cartões, rótulos/descrições reaproveitados de `GerarTab.tsx`
   via `criativosMotores.ts`, um único lugar agora).
2. **2. Produto** (idêntico ao já existente).
3. **3. Objetivo** — só para Remarketing/Funil: cartões de intent (Remarketing) ou etapa (Funil), em
   português, com descrição curta. Ângulos Limpos pula direto para a recomendação (como já era).
4. Assim que produto + objetivo (quando aplicável) estão escolhidos, dispara `/preview` de verdade
   (sem custo) e mostra a "Sugestão para esta estampa" (mesmo componente `CardSugestao`, agora também
   citando layout/headline padrão quando o motor não é Ângulos Limpos) com **Gerar assim** /
   **Personalizar**.
5. **Personalizar** reabre: Estilo (família/ângulo personalizado — idêntico, motor-agnóstico),
   **Texto e detalhes** (novo — headline/subheadline/cta/benefícios/etc., só para Remarketing/Funil,
   vazio = usa o padrão do motor), Personalizar cena (idêntico), Avançado (placements/quantidade,
   idêntico).
6. Nenhuma recomendação é inventada no frontend: a prévia mostra exatamente `preview.first.overlay`
   (o que o backend realmente calculou), nunca um texto simulado.

## 3. Contratos e compatibilidade

- V1 (`GerarTab.tsx`) não foi tocado — mesmo arquivo, mesmo comportamento.
- Troca de motor (§3 do brief): ao mudar de "Tipo de criativo", os campos específicos do motor anterior
  (intent, stage, texto/CTA/benefícios) são limpos — nunca herdados incoerentemente para o motor novo
  (um `intent` de Remarketing não faz sentido em Funil, e vice-versa). Produto, marca, contexto,
  persona, família/ângulo personalizado e as escolhas de cena SÃO preservados — são decisões que
  continuam fazendo sentido em qualquer motor (a família/ângulo é literalmente motor-agnóstica no
  backend, como confirmado no §1). A prévia é sempre descartada e recalculada.
- `angle_ids`/`custom_angle_id`/`angle_family_hint` continuam exatamente como já eram — nenhuma
  duplicação de lógica de resolução de ângulo.

## 4. Casos mínimos de validação

Cobertos por `apps/panel/test/criativos-v2-motor-input.test.js` (lógica pura de montagem de request,
extraída para `src/pages/criativos/criativosMotorInput.mjs` pelo mesmo motivo de
`enrichmentReviewFields.mjs` — sem harness de teste de componente React neste repositório):

1. Ângulos Limpos: request idêntico ao que já existia (regressão).
2. Remarketing: `remarketing.intent` sempre presente; headline/CTA vazios não entram no request
   (deixa o motor decidir); personalização preenche exatamente os campos editados.
3. Funil: uma combinação por etapa (TOFU/MOFU/BOFU); `clean_mode` sai como booleano; badges/chips só
   quando a etapa não é TOFU.
4. Troca de motor: campos específicos do motor anterior somem do estado; produto/família continuam.
5. `custom_angle_id`/`angle_family_hint` continuam mutuamente exclusivos e motor-agnósticos.
6. Flag desligada: `CriativosPage.tsx` já decide isso por `status.uiV2` — não tocado; V1 continua sem
   nenhuma mudança visível.

## 5. Limitações e G.2

- Multipeça (Remarketing com carrinho/pedido, `products_source:"basket"`, `singleOnlyIntents`) fica
  para G.2 — desenho próprio, conforme combinado. A V2 continua `product_mode: "single_product"` fixo.
- **Verificação visual (Chrome) não executada nesta rodada**: exigiria montar um ambiente local completo
  (Postgres + migrations + Organization/flags seedadas + servidor do painel + login real, sem
  contornar) só para esta verificação — custo desproporcional ao "se o ambiente disponível permitir"
  do brief, e o pedido explícito de evitar mais uma rodada longa. Compensado por: `tsc -b --noEmit`
  limpo, `vite build` limpo (prova de que o bundle de produção do painel compila com o componente novo),
  e os 25 testes direcionados abaixo cobrindo a lógica de montagem de request byte-a-byte. Registrado
  como lacuna explícita, não como "verificado".

## Resultado dos testes direcionados

- `apps/panel/test/criativos-v2-motor-input.test.js` — 15 testes, 15 passam: `remarketingOptions`/
  `funnelOptions` (campo vazio nunca entra no request; `clean_mode` booleano vs. enum; badges/chips só
  fora do TOFU; preserva chaves de "Copiar dados"), `restoDe`/`linhas`/`texto_de`/`lista_de`, reset de
  texto na troca de motor.
- `apps/panel/test/creative-enrichment-review-fields.test.js` — 10 (não tocado nesta fase, incluído na
  mesma rodada de verificação por rodar no mesmo processo `node --test`).
- `npx tsc -b --noEmit` — limpo. `npx vite build` — limpo, `CriativosPage` bundle inclui o componente
  novo sem erro.
- V1 (`GerarTab.tsx`): diff confirmado como refatoração pura de import (mesmas constantes, mesmos
  valores, movidas para `criativosMotores.ts`/`criativosMotorInput.mjs`) — nenhuma linha de
  comportamento mudou.

## Pendências registradas do Product Enrichment (não reabertas nesta fase)

Conforme a decisão da rodada: (a) amostra real pequena com o prompt F.2.B.1 para conferir
`field_basis`/`field_confidence` — pendente de autorização paga separada; (b)
recuperação/idempotência de tentativa cobrada quando `createProposal` falha — pendente, mudança maior
que o "small fix" da F.2.B.1; (c) garantir SDK OpenAI no ambiente real de produção. Nenhuma delas é
trabalho desta rodada.
