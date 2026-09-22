# Gerador de Criativos — Fase D (Angles V2)

Branch `feature/creative-fase-c` (mesma branch das Fases A–C; Fase D não abriu branch nova), worktree `oria-creative-fase-a`.
Sem push, sem merge, sem deploy, sem chamada à OpenAI. **UI V2 completa, Mockup Generator, Commerce Connector, Product
Enrichment via GPT, aprendizado automático por feedback e QA/retry automático não foram iniciados.**

## 1. Análise do catálogo atual

Os 13 ângulos de `templates/angles.json` foram desenhados para o primeiro caso de uso (marca regional, uma pessoa por
cena). Quatro deles — `IDENTIDADE_ORIGEM`, `ORGULHO_DISCRETO`, `PERTENCIMENTO`, `NOSTALGIA_ORIGEM` — são variações do
mesmo conceito (pessoa + produto + cenário emocional simples), diferindo só no TOM (confiante/nostálgico/pertencimento)
e não na composição. `PRESENTE_AFETO` tem uma lógica própria de elenco (quem veste o presente) que a Fase C (Subjects)
tornou redundante — hoje isso é `interaction: gifting` mais o contrato de Subjects. Nenhum dos 13 ângulos tem cidade,
bandeira, monumento ou paisagem regional embutida no texto do template (`templates/angles.json`, `templates/compiler_v2.json
→ frames`, `products.py`) — isso sempre foi dado de `context_profile`, nunca do ângulo global. O problema real não é
"regionalismo vazando pro ângulo"; é "13 opções quase iguais", exatamente o que o senhor descreveu.

## 2. Tabela `ângulo atual -> família/preset/interaction/objective/descontinuado`

| Ângulo atual | Família V2 | Preset | Vira interaction? | objective_hints | Nível top-level |
|---|---|---|---|---|---|
| `LIFESTYLE_COTIDIANO` | `lifestyle` | — | não | `daily_life` | mantém (base da família) |
| `IDENTIDADE_ORIGEM` | `lifestyle` | — | não | `brand_identity`, `belonging_place` | **descontinuado** (era "pessoa integrada ao lugar"; isso já é `context`/`semantic_context`) |
| `PERTENCIMENTO` | `connection` | — | não | `belonging` | mantém (base da família) |
| `PRESENTE_AFETO` | `connection` | — | **sim — `interaction: gifting`** | `gifting` | **descontinuado** (a diferença inteira dele hoje é a interaction, mostrar os dois seria duplicar) |
| `ORGULHO_DISCRETO` | `editorial_portrait` | — | não | `confident` | mantém (base da família) |
| `NOSTALGIA_ORIGEM` | `editorial_portrait` | — | não | `reflective`, `nostalgia` | mantém como variação (mesma família, hint diferente) |
| `CAIMENTO` | `product_focus` | `fit_full_body` | não | `technical_fit` | mantém |
| `CLOSE_ESTAMPA` | `product_focus` | `print_closeup` | não | `print_detail` | mantém |
| `CLOSE_BOLSO` | `product_focus` | `detail_closeup` | não | `small_detail` | mantém |
| `CABIDE` | `product_no_person` | `hanging` | não | — | mantém |
| `PRODUTO_ESTAMPA` | `product_no_person` | `flatlay` | não | — | mantém |
| `PREMIUM_ESTILO` | `product_no_person` | `editorial_still` | não | — | mantém |
| `CREATOR_STYLE` | `creator_social` | — | não | `social_native` | mantém (família própria — ver §2.1) |

**Nenhum ângulo virou puramente `objective`/`semantic intent` sem família**: todos os 13 continuam roteáveis para uma
família (é o que faz o alias funcionar sem recompilar nada). O que muda é que dois deles (`IDENTIDADE_ORIGEM`,
`PRESENTE_AFETO`) deixam de aparecer como CARTÃO PRÓPRIO numa tela V2 — continuam existindo como `angle_id` válido
(histórico e chamadas diretas funcionam sem alteração) e como rota via família+hint (`angle_family_hint`).

## 2.1 Catálogo global V2 proposto

**6 famílias populadas + 1 reservada** (dentro da faixa 6–7 pedida):

| Família | O que é | Ângulos legados que caem aqui |
|---|---|---|
| `lifestyle` | Pessoa vivendo a peça no dia a dia | LIFESTYLE_COTIDIANO, IDENTIDADE_ORIGEM |
| `connection` | Duas+ pessoas ligadas por um momento genuíno | PERTENCIMENTO, PRESENTE_AFETO |
| `editorial_portrait` | Retrato confiante ou contemplativo | ORGULHO_DISCRETO, NOSTALGIA_ORIGEM |
| `action_movement` | **Reservada — nenhum ângulo atual mapeia aqui** | nenhum |
| `product_focus` | A peça vestida, em plano técnico | CAIMENTO, CLOSE_ESTAMPA, CLOSE_BOLSO |
| `product_no_person` | Só a peça | CABIDE, PRODUTO_ESTAMPA, PREMIUM_ESTILO |
| `creator_social` | Linguagem de rede social | CREATOR_STYLE |

**`action_movement` fica reservada, não populada**: nenhum dos 13 ângulos atuais é sobre movimento corporal puro
(esporte, dança) — todos os que mencionam "ação" (`LIFESTYLE_COTIDIANO`) já caem em `lifestyle`, que é sobre viver o
produto no dia a dia, não sobre o corpo em movimento como sujeito da foto. Marcá-la como reservada evita inventar um
preset sem ângulo real por trás; um preset novo (ex.: esporte) entra aí sem migração de catálogo quando existir.

**`creator_social` merece família própria** (resposta direta ao "avaliar" do §2 da direção): sim — a convenção visual
de selfie/foto-de-amigo (ângulo de câmera, enquadramento informal, olhar câmera OU espelho) não se encaixa em nenhuma
outra família sem forçar; juntá-la a `lifestyle` faria um preset se comportar como exceção o tempo todo.

**Por que só 10 entradas de sistema para 13 ângulos**: `lifestyle`, `connection` e `editorial_portrait` têm 2 ângulos
legados cada, mas represento cada família como **UMA** entrada de sistema (`system.<família>.default`) — a diferença
entre, por exemplo, `ORGULHO_DISCRETO` e `NOSTALGIA_ORIGEM` não é de COMPOSIÇÃO (preset), é de TOM (`objective_hints`),
e por isso não justifica duas entradas de catálogo. `product_focus` e `product_no_person` têm 3 presets reais cada
(diferença técnica de enquadramento, não só tom) — aí sim, 3 entradas.

Catálogo completo, com descrições, `default_gaze`, `allowed_interactions` etc.:
[`templates/angle_catalog_v2.json`](../../apps/creative-generator/creative_core/templates/angle_catalog_v2.json).

## 3. `CreativeAngle` — schema adotado

A proposta do TS foi ajustada ao que o core já tem (contratos `F`-spec, não TS) e dividida em duas partes, porque
"ângulo do sistema" e "ângulo customizado" têm ciclos de vida MUITO diferentes (arquivo versionado vs. linha de banco):

```python
# AngleRecommendation — o que fica no CreativePlan (creative_core/contracts.py)
{
  "angle_id": str,        # sempre um dos 13 ids legados — nunca "auto": o plano grava o que foi usado de fato
  "family": str,           # enum ANGLE_FAMILIES
  "preset": str | None,
  "objective_hints": [str],
  "scope": "system" | "organization" | "store",
  "version": int,
  "reason": [str],         # ex.: ["interaction:playing", "people_count:2"]
  "source": "user" | "planner_default",
}

# CustomAngle — a linha de creative_angles (organization/store), espelhada em contracts.py
{
  "id": str, "scope": "organization" | "store", "organization_id": str, "store_id": str | None,
  "slug": str, "name": str, "description": str | None,
  "family": str, "people_mode": "none" | "optional" | "required", "preset": str | None,
  "definition": dict,      # campos mais ricos, ainda evoluindo — só family/people_mode/preset são lidos hoje
  "active": bool, "version": int, "created_by": str | None, "created_at": str, "updated_at": str,
}
```

`peopleMode`/`allowedProductModes`/`allowedInteractions`/`defaultGaze`/`plannerHints`/`promptInstructions` da proposta
original viraram, respectivamente: `people_mode` (adotado), `allowed_product_modes`/`allowed_interactions`/`default_gaze`
(existem no catálogo de sistema como dado informativo — ver riscos, §20), `definition` (JSONB livre, onde os campos mais
ricos futuros entram sem migração).

## 4. Escopo — system / organization / store

Implementado exatamente como pedido:

- **system**: `templates/angle_catalog_v2.json`, versionado no core, nunca no banco. Servido em `GET /v1/contracts →
  catalog.angle_families` (+ `angle_legacy_map`, `angle_discontinued`).
- **organization**: linha de `creative_angles` com `store_id IS NULL` — visível em TODAS as Stores da Organization.
- **store**: linha com `store_id` preenchido — visível só naquela Store.

**Sem override implícito por nome**: `slug` é único DENTRO do escopo (índice parcial `uq_creative_angles_org_slug` /
`uq_creative_angles_store_slug`), nunca globalmente — um ângulo de Organization e um de Store podem ter o MESMO slug e
coexistir, cada um com sua própria linha/id (testado explicitamente — ver §16 casos 6/7).

## 5. Custom Angle — cadastro mínimo, sem GPT

`POST /api/admin/criativos/angles` aceita exatamente o mínimo pedido: `name`, `description` (opcional), `family`,
`peopleMode`, `preset` (opcional), mais `active` (implícito `true` na criação) e `scope`. **GPT não foi implementado**
(nem importado, nem chamado) — o campo `definition` (JSONB livre) é o lugar reservado para os campos mais ricos que um
fluxo "Quero fotos mais espontâneas..." viria a preencher depois; hoje ele é opcional e vazio por padrão.

## 6. Regras de UX — o que foi e o que NÃO foi feito

**Feito**: o catálogo exposto (`catalog.angle_families`) já vem no formato "cartão de família" — só `id`/`label`/
`description`/`reserved`, nada de id interno, planner hints, pose risk, allowedProductModes ou prompt instructions
(testado: `test_given_contracts_then_catalog_lets_panel_build_forms` confere que as chaves são exatamente essas quatro).

**Não feito nesta fase** (fora do escopo explícito — "não iniciar UI V2 completa"): a tela do Gerador
(`GerarTab.tsx`) continua mostrando os 13 ângulos como estão; não constrói cards de família nem o fluxo
"Recomendado: Lifestyle cotidiano · Pai + filha brincando · parque" → "Outros estilos". Isso é reconstrução de UI, que
a direção pediu para NÃO iniciar agora. O que existe é o back-end pronto para essa tela vir depois.

## 7. Planner recomenda, não exige — `angle_id: "auto"`

`CreativeRequest.angle_id` aceita `"auto"` (além dos 13 ids legados, sem quebrar nada — enum estendido). Com `"auto"`:

1. se `angle_family_hint` vier no request (`{family, preset?}`) — usa DIRETO, sem heurística (`source: "user"`, porque
   uma família já é uma escolha humana, só não crua o id legado). É o caminho que um ângulo customizado de
   organization/store, resolvido pelo painel, ou um seletor de família na UI usaria;
2. senão, chama `recommend_angle(inputs)` (heurística pura, `source: "planner_default"`).

`recommend_angle` lê: `subjects` (contagem/relações), `interaction` (explícita), `products[].semantic_context`
(`relationship_themes`, `scene_intents`), `persona_mode`, e um `intent_hint` explícito (seam para um brief futuro por
GPT — hoje só uma string literal como `"creator"`, nunca inferida). **Feedback (Gostei/Não gostei) não é lido** — nem
por `recommend_angle` nem por nada nesta fase (§16).

## 8. `recommend_angle` — função pura

```python
recommend_angle({"subjects": [...], "interaction": "playing"})
# -> {"angle_id": "PERTENCIMENTO", "family": "connection", "preset": None,
#     "objective_hints": ["belonging"], "reason": ["interaction:playing", "people_count:2"],
#     "source": "planner_default"}
```

Sem I/O — não lê banco, não lê feedback, não chama provider. Persistida em `plan["angle_recommendation"]` e em
`plan["provenance"]["angle"]` (`"user"` quando o `angle_id` foi nomeado ou veio de `angle_family_hint`; `"planner_default"`
quando veio da heurística). Testado como função pura (`recommend_angle({...}) == recommend_angle({...})` com os
mesmos inputs) e determinística.

## 9. Angle não duplica Interaction

A regra central do catálogo: nenhuma entrada do sistema tem uma "flavor" que só repete o que uma interaction já diz.
O caso mais direto era `PRESENTE_AFETO` (a ideia inteira dele é "presente/uso compartilhado" — hoje `interaction:
gifting`); por isso ele foi para `discontinued_as_top_level` em vez de virar `preset: "gifting"`. `family=connection`
tem `allowed_interactions` (gifting, reading_together, playing, hugging, cooking, doing_activity, talking, walking,
looking_at_each_other, candid) como dado informativo, não como composição embutida no ângulo — quem decide "o que as
pessoas estão fazendo" continua sendo só `interaction` (Fase C).

## 10. Angle não dita Context

Confirmado por leitura de código, não só por design: nenhum dos 13 `templates/angles.json`/`compiler_v2.json → frames`
tem cidade, bandeira, monumento ou paisagem regional (`grep` por esses termos nos templates do core não retorna nada —
esse conteúdo só existe em CONTEXT PROFILES de teste/fixture, nunca no catálogo global). Nada precisou ser removido;
a Fase D só confirma e documenta essa separação, que já existia.

## 11. Relação com Gaze — inalterada

A precedência continua **exatamente** a mesma da Fase C (`resolve_gaze`, `planner_v2.py`, não tocada nesta fase):
sem pessoa → `none`; usuário explícito → o que ele pediu; interaction → o gaze da interaction; preset/pool do ângulo
(`pool_gaze`) → só para 1 pessoa; default do ângulo (`gaze_defaults`). `default_gaze` no catálogo V2 é hoje só
informativo (ver riscos, §20) — o roteamento sempre passa por um `angle_id` legado concreto, cujo `gaze_defaults` já
existente é quem decide de fato.

## 12. Modelo de dados / persistência

- **system**: arquivo (`templates/angle_catalog_v2.json`), nunca duplicado por Organization — exatamente como pedido.
- **organization/store**: migration **0034**, `creative_angles` (abaixo).

## 13. Compatibilidade com ângulos antigos

Testado byte a byte: `test_given_the_new_catalog_then_v1_prompts_are_still_byte_identical_for_every_legacy_angle`
gera o plano v1 dos 13 ângulos e confere que o layer de família não aparece nem muda nada. Um job histórico com
`angle_id: "PRESENTE_AFETO"` continua funcionando sem alteração (`test_case_8`). **Nenhum plano persistido foi
reescrito** — a camada de alias é só leitura (`resolve_angle_meta`), nunca grava nada sobre planos antigos.

## 14. Versionamento

Um ângulo customizado tem `id` (UUID estável) e `version` (sobe 1 a cada UPDATE — nunca reescreve outra linha, `version
= version + 1`). **Editar um ângulo usado antes não altera o plano histórico** — e isso é garantido estruturalmente,
não só por convenção: o core roteia TODO ângulo (customizado incluso, via `angle_family_hint`) para um `angle_id`
LEGADO concreto (`canonical_legacy_angle_id`), que sozinho já determina o prompt inteiro. O `CreativePlan` grava esse
`angle_id` legado + `angle_recommendation.version` (a versão do ângulo customizado NO MOMENTO da geração, só para
histórico/analytics) — recompilar um plano antigo nunca volta a ler `creative_angles`. É a "abordagem autossuficiente
equivalente" que a direção deixou como alternativa ao "resolved definition completo".

## 15. `FeedbackSnapshot` preparado para Angle V2

Quatro campos novos, nullable (planos anteriores à Fase D não têm, nunca são retroativamente preenchidos):
`angle_family`, `angle_preset`, `angle_scope`, `angle_version` — lidos de `plan["angle_recommendation"]`, gravados em
`creative_feedback` (colunas já existentes na tabela da Fase C não mudam; o snapshot JSONB é que ganha os 4 campos).
Testado com plano v2 e com plano v1 (a metadata de família aparece nos dois, aditivamente).

## 16. "Gostei / Não gostei" não congela nem recomenda automaticamente

Confirmado por ausência: nenhum código desta fase lê `creative_feedback` para decidir `recommend_angle`, criar um
ângulo customizado ou mudar `active`/ranking. `recommend_angle` é uma função pura sem acesso a banco — estruturalmente
não PODE ler feedback, não é só que "hoje não lê".

## 17. Casos de teste obrigatórios — os 8

Core (`creative_core/tests/test_angle_catalog.py`, 21 casos): **Caso 1** single person → `editorial_portrait`, gaze
`camera`; **Caso 2** pai+filha brincando → `connection`, `interaction: playing`, gaze `interaction`; **Caso 3**
mãe+filho lendo → `connection`, `reading_together`; **Caso 4** produto sem pessoa → `product_no_person`; **Caso 5**
creator via `intent_hint` → `creator_social`, gaze do próprio preset; **Caso 8** alias `PRESENTE_AFETO` continua
funcionando sem alterar o job antigo.

Painel (`test/creative-angles.test.js`, `test/creative-angles-pg.test.js`): **Caso 6** ângulo de Store aparece só
naquela Store (memória + Postgres real); **Caso 7** ângulo de Organization aparece em duas Stores da mesma
Organization, e um ângulo de Store com o MESMO slug convive sem sobrescrever (identidade própria, §4).

## 18. Sem chamada OpenAI durante a implementação

Nenhuma. Nenhum `client.images.edit`/`client.responses.create` foi tocado; `recommend_angle` e todo o CRUD de ângulos
não importam `openai`, não recebem client, não recebem key.

## 19–24. Suítes, riscos, push/merge/deploy

Ver §20/§21/§22 abaixo.

## 20. Riscos e decisões novas

1. **`default_gaze`/`allowed_interactions`/`allowed_product_modes` do catálogo V2 são hoje informativos, não
   aplicados**: o roteamento sempre passa por um `angle_id` legado, cujo `gaze_defaults`/`angle_people` JÁ existentes
   (Fase B/C) continuam sendo a autoridade real. Um ângulo CUSTOMIZADO puro (sem `angle_id` legado por trás) não
   existe ainda — todo `angle_family_hint` resolve para um dos 13. Se um dia houver família sem nenhum legado (como
   `action_movement` ficaria, se for populada), o roteamento precisa de um destino real (compiler/template) antes de
   aceitar geração — hoje ele corretamente RECUSA (`UNSUPPORTED_ANGLE`) em vez de inventar um.
2. **`recommend_angle` é uma heurística de poucas regras** (contagem de pessoas, interaction, `relationship_themes`,
   `intent_hint`), não um modelo aprendido nem um brief por GPT — é o que a direção pediu para esta fase (§5/§18), mas
   a qualidade da recomendação é só tão boa quanto essas poucas regras; casos fora do que os 8 testes cobrem podem cair
   no fallback genérico (`editorial_portrait` para 1 pessoa, `lifestyle` para 2+ sem sinal de vínculo).
3. **`IDENTIDADE_ORIGEM` e `PRESENTE_AFETO` saem do catálogo "top-level" mas continuam 100% funcionais** via `angle_id`
   direto — nenhum cliente ativo quebra; só uma tela V2 futura não os ofereceria como cartão próprio.
4. **`creative_angles.definition` é JSONB livre**: nada impede hoje um campo malformado ali (o core só lê
   `family`/`people_mode`/`preset`, nunca `definition`) — não é um risco de geração, mas um contrato ainda incompleto
   para quando os "campos mais ricos" (§5) forem definidos.
5. Deploy (quando for a hora): **Python antes do Node** de novo (o request `angle_family_hint`/`angle_id: "auto"` só
   funciona com o core desta fase); migration 0034 antes de expor as rotas de `/angles`.

## 21. Suíte completa

- **Core**: `python3 run_tests.py` → **18/18 suítes** (nova `test_angle_catalog.py`, 21 casos). Golden V1: **546/546
  byte-idênticos**, intacto.
- **Painel**: `creative-angles.test.js` (9) + `creative-angles-pg.test.js` (Postgres real, `TEST_APP_ROLE=1` incluso)
  + `creative-core-pg.test.js` reconferido (11 tabelas `creative_*`) + os 4 invariantes de lista de migração +
  `tenancy-isolation`/`tenancy-upsert` reconferidos com a tabela nova — **143/143** nessa fatia. **Suíte completa do
  painel** (`test/*.test.js test/invariants/*.test.js`, máquina limpa, sem processo órfão): **1312/1312, 0 falhas.**
- `npx tsc -b --noEmit` no painel: limpo.

## 22. Compatibilidade retroativa

Request sem `angle_id: "auto"` nem `angle_family_hint` produz o MESMO plano de antes (nenhum campo novo influencia
nada que já existia). `angle_recommendation` é aditivo em `CreativePlan` (nullable) e em `FeedbackSnapshot` (4 campos
nullable). Migration 0034 é só `CREATE TABLE` — nada existente muda. Nenhum plano ou histórico anterior foi reescrito.

## 23. Push / deploy

Nenhum push, merge, deploy ou `gh`. Só commits locais (`5bb6107`, `935e709`) na branch `feature/creative-fase-c`.

## 24. Próxima fase

**Não iniciada.** Fica para o senhor revisar o catálogo de Angles V2 (§1–§3) antes do redesign completo do Gerador —
exatamente como pedido no fechamento da direção da Fase D.
