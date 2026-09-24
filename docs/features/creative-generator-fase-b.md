# Creative Generator V2 — Fase B · CreativePlan v2 + Prompt Compiler

Branch `feature/creative-fase-b` (sobre `feature/creative-fase-a`). Sem push, sem deploy, **nenhuma chamada à OpenAI** (todos os testes usam doubles). Fase C não iniciada.

- Exemplos completos (request, plano V1, plano V2, `CompiledPrompt` com todas as seções e o texto): [`creative-generator-fase-b-examples.md`](./creative-generator-fase-b-examples.md).
- Fechamento da Rodada 1 do A/B: [`creative-generator-fase-a-rodada1.md`](./creative-generator-fase-a-rodada1.md).

## 1. Commits

| Commit | O que faz |
|---|---|
| `ce4a4e6` | docs: fechamento da Rodada 1 (sem vencedor; regressão não reproduzida) |
| `ff5061b` | CreativePlan v2 + planner + compiler + contratos + drafts/feedback + `/v1/compile` |
| `592e424` | migration `0032`, persistência de `plan_schema_version`/`compiler_version`, rollout do plano v2 |
| `2549fe2` | o `semantic_context` gravado no produto chega tipado ao request |
| docs | este relatório, exemplos, env manifests |

## 2. Contratos novos e alterados (todos aditivos)

**Alterados:** `CreativeRequest` (+`plan_schema_version` 1|2, +`gaze_mode`); `BrandKit` (+`minorWardrobePolicy`); `CreativeProduct` (+`semantic_context`); `PromptSection` (+`source`, +`value`); `CreativePlan` (+`mode`, `objective`, `subjects`, `scene`, `composition`, `minor_safety`, `semantics`, `provenance`, `resolved_inputs`, `compiler`, `seed`; todos opcionais).

**Novos:** `ProductSemanticContext`, `MinorWardrobePolicy`, `PlanSubject`, `GazeResolution`, `PlanScene`, `PlanComposition`, `MinorSafety`, `PlanSemantics`, `ResolvedInputs`, `CompilerSection`, `CompilerInfo`; exportados como schema: `CompiledPrompt`, `GenerationDraft`, `FeedbackSnapshot`.

Espaços já tipados para a Fase C, sem obrigar quebra de schema: `PlanSubject.relation_to_primary` e `PlanScene.interaction` (sempre `null` agora); `PlanSubject` já tem `role primary|supporting`, `age_band`, `product_use` e `prominence`.

`SCHEMA_VERSION` (forma dos contratos v1) continua `1`. Um plano v2 tem `schema_version: 2`, é um superconjunto do v1 (mesmos campos, com os mesmos valores, testado nas 7 fixtures) e `versions.compiler_version = 1`.

## 3. Migration

`0032-creative-plan-v2`: `creative_generations` + `plan_schema_version INT`, `compiler_version INT`. Aditiva e reversível. O backfill só copia o que o plano persistido já diz (`plan.schema_version`, ausente = 1; `plan.compiler.version`), onde há plano. Nenhuma migration de Subjects ou de feedback nesta fase.

## 4. Exemplos V1 × V2 para o mesmo request

No arquivo de exemplos. O que muda no plano (8,4 KB → 18 KB de JSON por geração; o plano v2 é autossuficiente para recompilar):

- **V1:** `schema_version 1`, prompt montado pelo `PromptBuilder`, persona única. Olhar, menores e semântica não são dado do plano.
- **V2:** os mesmos campos v1 **mais** `subjects[]`, `scene.gaze` (com `source` e `reason`), `scene.picks`, `composition`, `minor_safety`, `semantics`, `provenance`, `resolved_inputs`, `compiler.sections` e `seed`.

## 5. `CompiledPrompt`

Um exemplo completo (Entre Nós, "Pipa Menina", cena de presente, política de vestuário da marca, semântica pai-filho) está no arquivo de exemplos, com a tabela de seções e o texto inteiro. Cada seção carrega `section`, `source`, `value`, `length`, por exemplo:

```json
{ "section": "gaze", "source": "angle", "value": "interaction", "length": 85 }
```

`plan.prompt` mantém o formato `PromptInfo` que todo consumidor já lê (`name`/`length`), com `source` e `value` a mais.

## 6. Seções do compiler (na ordem)

| # | Seção | Origem do conteúdo | Observação |
|---|---|---|---|
| 1 | `fidelity_rules` | produto | regras de fidelidade do tipo de peça (o `core_rules` do v1) |
| 2 | `text_rules` | objetivo | regra absoluta de texto na imagem |
| 3 | `minor_safety` | `safety_policy` | só se há menor em cena |
| 4 | `reference_roles` | produto | qual imagem é qual produto |
| 5 | `product_semantic_context` | produto / enrichment | só se o produto tem `semantic_context` |
| 6 | `people_composition_contract` | persona/subjects | contagem exata, papel e uso do produto por pessoa, mais o bloco de persona |
| 7 | `gaze` | angle / user | omitida sem pessoas |
| 8 | `scene_action` | angle | texto da cena (v1 genérico ou v2 de pessoas, com os `picks` do plano) |
| 9 | `minor_wardrobe_policy` | brand | só com menor e política habilitada |
| 10 | `strategy_communication` | objetivo | overlay/layout de funil e remarketing |
| 11 | `brand` | brand | |
| 12 | `niche` | niche | |
| 13 | `context` | user/brand/niche | |
| 14 | `avoid` | brand | |
| 15 | `output_format` | user | formato do feed/story |

Diferenças em relação à lista da diretriz, com justificativa técnica: (a) `text_rules` e `minor_safety` sobem para logo depois das regras de fidelidade, porque no v1 as regras absolutas vêm primeiro e não há motivo para enfraquecer justamente as mais críticas; (b) foram **adicionadas** `minor_safety` (camada global, separada da política de marca) e `strategy_communication` (o texto de layout/overlay que o v1 já tinha); (c) `avoid` e `output_format` continuam por último, como no v1.

## 7. Como o `gaze_mode` é resolvido

`gaze_mode` (`camera | interaction | off_camera | product | auto`) é campo do request e do plano. **`auto` nunca chega ao compiler.** O planner o resolve para um valor concreto antes, com `source` (`user`, `angle` ou `planner_default`) e `reason`:

1. Sem pessoas em quadro → `none` (a seção some).
2. Valor explícito do usuário → esse valor (`source: user`).
3. Uma pessoa e o plano escolheu uma variação com olhar próprio (ação do lifestyle, formato do creator) → o olhar dessa variação (`source: angle`, `reason: pool:acao:3`).
4. Senão, a tabela por ângulo e nº de pessoas (`templates/planner_v2.json`, dado e não código):

| Ângulo | 1 pessoa | 2+ pessoas |
|---|---|---|
| CAIMENTO, CLOSE_ESTAMPA, CLOSE_BOLSO | camera | camera |
| CREATOR_STYLE | camera (formato "foto de amigo": off_camera) | camera |
| LIFESTYLE_COTIDIANO | off_camera (por ação: camera ou off_camera) | interaction |
| IDENTIDADE_ORIGEM, PERTENCIMENTO, NOSTALGIA_ORIGEM | off_camera | interaction |
| ORGULHO_DISCRETO | camera | interaction |
| PRESENTE_AFETO | (2 pessoas) interaction | interaction |
| CABIDE, PRODUTO_ESTAMPA, PREMIUM_ESTILO | none | none |

Isso implementa os defaults pedidos: caimento → câmera; lifestyle → câmera ou fora dela conforme o preset; duas ou mais pessoas interagindo e presente → `interaction`; creator → câmera/reflexo conforme o formato. A ação, o formato e o cenário de presente que o modelo escolhia sozinho agora são `scene.picks`, decididos no plano.

## 8. Políticas de menores no plano

Duas camadas, separadas de propósito, em `plan.minor_safety`:

- **Global (`global_minor_safety_policy`)**: aplicada sempre que há menor em quadro; **não é configurável para ficar mais permissiva** (não existe campo para isso). Regras: roupa apropriada à idade; nada revelador; nada sexualizado; nenhuma estética adulta; poses naturais e apropriadas à idade; caimento normal, sem foco no corpo; contexto comercial, familiar e cotidiano coerente. Com adulto e criança na cena entra também: contato físico apenas em situação familiar ou cotidiana coerente com a relação declarada.
- **Marca (`brand_minor_wardrobe_policy`)**: `BrandKit.minorWardrobePolicy` (`enabled`, `legs_coverage full|knee|default`, `allow_short_shorts`, `allow_short_skirts`, `allow_revealing_clothing`, `style`). **Só acrescenta restrições.** `allow_revealing_clothing` é aceito no formato mas ignorado: o plano registra `ignored: ["allow_revealing_clothing"]` e o que foi pedido, para auditoria. Não há hardcode de "criança usa calça comprida" no core; a preferência é da marca.

Menor é detectado por: número de anos no rótulo da persona > `age_range` > palavras (criança, menina, bebê…) > tipo do produto (o vestidor principal de uma peça infantil é tratado como menor). "Desconhecido" não é menor. "mulher 35 anos, mãe da menina" é adulta, porque o número vence.

Configuração inicial pedida para a Entre Nós (no Brand Kit do tenant; ver §13, item 3):

```json
"minorWardrobePolicy": { "enabled": true, "legs_coverage": "full", "allow_short_shorts": false,
  "allow_short_skirts": false, "allow_revealing_clothing": false, "style": "casual_age_appropriate" }
```

## 9. `product.semantic_context` sem o enrichment

`CreativeProduct.semantic_context` é um campo **tipado** (`wearer_roles`, `relationship_themes`, `recommended_supporting_roles`, `incompatible_auto_supporting_roles`, `scene_intents`, `visible_text`, `source manual|enrichment`, `confidence`), com vocabulário livre (strings curtas), para que novos temas não exijam mudar o schema. O que já funciona:

- o planner escolhe a pessoa de apoio respeitando a semântica: uma persona do pool com o papel recomendado vence; se não há, elenca-se uma a partir do papel (ex.: "homem adulto, pai da criança"); personas com papel incompatível são evitadas quando há alternativa. Com "Brincar com Meu Pai", a mãe do pool da marca não vira apoio automático;
- escolha manual ou forçada contrária à estampa **não bloqueia**: o plano segue e traz `semantics.warnings` (`semantic_mismatch:father_child:mother`), com o texto humano a cargo da UI;
- o compiler escreve a seção `product_semantic_context` com rótulos em português e **nunca pede uma pessoa que o quadro não tem**;
- o painel já leva `metadata.semantic_context` do registro do produto para o campo tipado do request. Nada na API do painel grava isso hoje: a proposta por GPT e a edição com aprovação são da Fase F, e nada é gravado sem aprovação.

## 10. Golden tests

- `tests/golden/prompt_v1.json`: **546 casos** (7 fixtures × 13 ângulos × 2 formatos × 3 seeds). O teste os refaz **três vezes**: com o padrão, com `prompt_version=1` explícito e com `plan_schema_version=1` explícito. Todos byte a byte iguais aos capturados antes da Fase A.
- A extração dos blocos do v1 para `blocks.py` foi uma mudança pura de lugar; o golden é a prova.
- Novo: recompilar cada plano v2 das 7 fixtures reproduz o prompt exatamente (também depois de um round-trip por JSON).

## 11. Suíte completa

Rodada final, no HEAD `2549fe2` (todo o código da Fase B; depois dele só entraram docs):

| Suíte | Resultado |
|---|---|
| Core (`python run_tests.py`) | **15/15 suítes, 219 testes** verdes (inclui os 546 golden do V1, três vezes) |
| Painel completo (`test/*.test.js` + `test/invariants/*.test.js`, Postgres efêmero com **todas** as migrations, incluindo a `0032`) | **1276/1276** verdes, 0 falhas, 0 canceladas, 0 puladas |
| Migrations / invariantes de tenancy | dentro dos 1276 (as listas de migrations e a contagem de rollback foram atualizadas para a `0032`) |

Uma execução anterior da suíte do painel foi interrompida por mim porque o código mudou no meio (o `semantic_context`); esta é a execução completa e definitiva. Nenhuma falha foi observada.

## 12. Compatibilidade

- Plano v1 continua legível, validável e compilável pelo fluxo antigo (`PromptBuilder` intocado e **não removido**); o compiler v2 recusa plano v1 (`ValueError`; `422` no endpoint).
- Jobs antigos abrem: as colunas novas são NULL/backfilled e nenhum campo foi removido. Aliases de ângulo inalterados. Nada de migration de Subjects. Nada converte histórico.
- Com todas as flags desligadas nada muda: o plano v2 só vale com `CREATIVE_PLAN_SCHEMA_VERSION=2` no serviço, `plan_schema_version` no request ou `CREATIVE_PLAN_V2_ORGS` no painel. Deploy: **Python antes do Node** (o serviço rejeita campos desconhecidos).

## 13. Decisões novas e riscos

1. **O plano v2 é autossuficiente** (`resolved_inputs`, `scene.picks`, `seed`): o compiler é função pura do plano, e um plano persistido pode ser recompilado e auditado. Custo: cerca de 2× o tamanho do JSON por geração (8 → 18 KB).
2. **A UI ainda não consegue pedir plano v2 nem `gaze_mode`.** `plan_schema_version` só chega por env do serviço/painel; `gaze_mode` só pela API do core e fixtures (o formulário do painel tem whitelist). Intencional: nada de tela nesta fase.
3. **O editor de Brand Kit do painel não tem o campo `minorWardrobePolicy`.** Hoje ele se configura pela API de Brand Kit (o painel valida com o core e grava o JSON completo). Configurar a Entre Nós em produção é uma ação sua (não tenho acesso ao tenant); o trecho JSON está no §8.
4. **A detecção de menor é heurística** (rótulo, faixa, palavras, produto). Uma persona infantil sem idade nem palavra-chave ("Ana") passa como "desconhecida", exceto quando o produto é infantil. A correção estrutural é a idade explícita por Subject (Fase C); até lá, cadastrar `age_range` na persona.
5. **A pessoa de apoio só é reelencada na cena de presente**, que é a única de duas pessoas hoje. Os demais casos com semântica ficam para Subjects.
6. **Risco de pose com 4 ou mais pessoas é sempre `high`** (peso próprio), e 3 ou mais geram `people_count_risk:N` em `warnings`, conforme a regra de produto.
7. `plan.persona` continua populado como no v1 (compatibilidade); `subjects` é o dado novo.
8. O prompt V2 de cena (A3) segue **opt-in** (`prompt_version=2`). Não há conclusão de qualidade V1 × V2 (a Rodada 1 não declarou vencedor). O compiler v2 funciona com os dois textos de cena.
9. `people_composition_contract` repete o rótulo da persona que o bloco de persona também traz: verboso, mas inspecionável. Candidata a enxugar depois da revisão.
10. `GenerationDraft` não recupera `remarketing.products_source` nem `persona_mode = none` (o plano não os guarda). Trivial de guardar no plano quando a UI precisar.
11. Achado durante os testes: `deterministic_pick` do core faz hash das opções, então não serve para listas de dicts; o planner usa uma rotação própria.

## 14. Chamadas OpenAI e push/deploy

**Nenhuma chamada OpenAI** nesta fase (doubles nos testes; a chave só foi usada na Rodada 1 do A/B, já fechada). **Sem push, sem merge, sem deploy.** Branch local sem upstream.

## 15. Mapeamento `campo do CreativePlan -> origem do valor`

Origens: `user`, `product`, `product_enrichment`, `brand`, `niche`, `persona`, `angle`, `planner_default`, `safety_policy`. O plano registra a origem real de cada campo em `plan.provenance`; a tabela abaixo (`plan_sources.py`, testada) diz o que **pode** vir de cada fonte e se o usuário precisa digitar algo.

| Campo | Origens possíveis | Input do usuário | Nota |
|---|---|---|---|
| `strategy / objective` | `user` | required | the type of creative (clean, remarketing, funnel) |
| `products` | `user` | required | the product(s) picked |
| `references` | `product` | never | the product's reference images, in order |
| `product.semantic_context` | `product`, `product_enrichment` | never | manual today; proposed by GPT enrichment later, saved only after approval |
| `brand_kit` | `user`, `brand` | optional | defaults to the store's brand |
| `niche_kit` | `user`, `brand`, `niche` | optional | brand's default niche |
| `angle` | `user`, `product_enrichment`, `brand`, `niche`, `planner_default` | optional | recommended from the product; the user only changes it |
| `placement` | `user`, `planner_default` | optional | the store's usual format |
| `quality` | `user`, `planner_default` | never | advanced |
| `persona` | `user`, `brand`, `niche`, `planner_default` | optional | brand/niche pool; custom only on request |
| `subjects` | `persona`, `brand`, `niche`, `product`, `product_enrichment`, `planner_default`, `user` | optional | who appears; recommended from the product, changed only in 'Personalizar cena' |
| `subjects[].age_band / is_minor` | `persona`, `product`, `safety_policy` | never | detected from persona label/age and the product type |
| `scene.gaze` | `user`, `angle`, `planner_default` | optional | resolved from the angle and the picked preset; shown as 'Olhar' only when the user customizes |
| `scene.picks` | `planner_default` | never | action / photo format / gift scenario, chosen from the seed |
| `scene.prompt_version` | `planner_default` | never | wording version of the scene text |
| `composition (people_count, pose_risk)` | `planner_default` | never | derived; at most shown as a plain-language warning |
| `minor_safety.global` | `safety_policy` | never | always applied when a minor is in the frame; not configurable towards permissive |
| `minor_safety.brand` | `brand` | never | the brand's wardrobe policy; only adds restrictions |
| `semantics (supporting, warnings)` | `product`, `product_enrichment` | never | recommendations respect it; a manual choice can contradict it and only gets a warning |
| `context` | `user`, `brand`, `niche` | optional | automatic from brand/niche; explicit choice in 'Avançado' |
| `overlay / copy / funnel_stage / remarketing` | `user`, `planner_default` | optional | text on the art and external copy; defaults per objective |
| `model / size` | `planner_default` | never | router + placement |
| `seed` | `planner_default` | never | new per generation; reused only to regenerate the same scene |
| `compiler (version, sections)` | `planner_default` | never | engine/debug only |

Leitura para a UX: só **objetivo** e **produto** exigem input; no máximo 12 campos podem virar controle visível (o teto é testado) e cada um tem default. `gaze`, `pose_risk`, `minor_safety`, `semantics`, `picks` e `compiler` são do motor e nunca formulário padrão.

## 16. Propostas para a próxima fase (nada implementado)

### 16.1 Gostei / Não gostei

Tabela `creative_feedback` (padrão de tenancy das migrations 0004–0009 e escopo Organization + Store opcional já decidido):

```sql
creative_feedback (
  id UUID PK, organization_id UUID NOT NULL, store_id UUID NULL,      -- NULL = compartilhado pela Organization
  creative_id UUID NOT NULL REFERENCES creative_generations, job_id UUID NOT NULL,
  user_id UUID NOT NULL,                                              -- quem marcou
  verdict TEXT NOT NULL CHECK (verdict IN ('liked','disliked')),
  snapshot JSONB NOT NULL,                                            -- FeedbackSnapshot (validado no core)
  plan_schema_version INT, compiler_version INT, prompt_version INT,  -- colunas para filtrar/agrupar sem abrir o JSON
  angle TEXT, objective TEXT, mode TEXT, people_count INT, minor_safety_applied BOOL,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  UNIQUE (organization_id, creative_id, user_id)                      -- trocar de ideia = upsert
)
```

- `FeedbackSnapshot` já reúne os fatos do plano pedidos (`creative_id`, versões do plano/compiler/prompt, ângulo, produtos, sujeitos, contexto, objetivo, modo, flags, modelo, asset); o painel acrescenta `organization_id`, `store_id`, `job_id`, `user_id`, `verdict` e timestamp.
- Endpoints: `PUT /api/admin/criativos/items/:creativeId/feedback` (upsert), `DELETE` (limpar), `GET /history` devolve o veredito do usuário atual, `GET /feedback/summary?by=angle|context|objective` para "ângulos/contextos/composições mais aprovados".
- O snapshot vem do plano persistido. Recomendo expor `POST /v1/feedback-snapshot` no core (puro, como `/v1/compile`) em vez de duplicar a lógica em JS.
- Toda tabela tenant-owned nova exige entrada no manifesto de tenancy, trigger e RLS `FORCE`, como as demais.

### 16.2 Copiar Dados

- `GET /api/admin/criativos/items/:creativeId/draft`: lê o plano persistido (`creative_generations.plan`), chama `generation_draft_from_plan` (a expor no core como `POST /v1/draft`, puro) e devolve o `GenerationDraft` mais um bloco `unavailable` (produto ou perfil arquivado desde então), que o painel resolve porque conhece os ids.
- A UI abre o Gerador com o draft e mostra o resumo de `carried` ("Produto, Ângulo, Pessoas, Olhar, Formato…"), com dois botões: **Gerar de novo** (mesma `seed`, mesma cena) e **Gerar variação** (descarta a `seed`).
- Não copia job, tentativa, asset, uso nem trace. Funciona para planos v1 (sem sujeitos nem olhar) e v2. Cobertura de teste: request → plano → draft → request → plano reproduz o hash do prompt (clean e funil, v1 e v2).

### 16.3 Mapeamento campo → origem

Já é dado e teste (`plan_sources.py`, §15). Sugestão: expô-lo em `GET /v1/contracts` para a UI derivar, em vez de codificar, quais campos podem virar controle.
