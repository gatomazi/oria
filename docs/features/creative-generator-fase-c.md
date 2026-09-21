# Gerador de Criativos — Fase C (Subjects, Feedback, Copiar Dados)

Branch `feature/creative-fase-c`, worktree `oria-creative-fase-a`. Sem push, sem merge, sem deploy, sem chamada à OpenAI.
Exemplos completos (request, plano, prompt, snapshot, draft de cada caso): [`creative-generator-fase-c-examples.md`](creative-generator-fase-c-examples.md).

## 1. Commits

| Commit | O que entrega |
|---|---|
| `e00c2d0` | §2.1 proveniência: seção composta não é atribuída a uma origem só (`mixed` + `provenance_sources`) |
| `b4c752d` | C1: subjects, relações e interações; compiler v2 (v1 congelado); 5 fixtures; catálogo de interações como dado |
| `c3d3f6a` | `POST /v1/draft` e `POST /v1/feedback-snapshot` no core (puros); "de novo" e "variação" no draft |
| `2c13035` | migration 0033 `creative_feedback`; rotas de feedback, draft e consulta; UI mínima |
| `e399cd8`, `e733162` | ajustes do resumo de cena na UI (nomes em minúsculas, sem faixa etária) |

## 2. Migrations

Uma só: **0033 `creative_feedback`** (`migrations/1790001800000_creative-feedback.js` + `sql/0033-creative-feedback.{up,down}.sql`). Aditiva e reversível (`DROP TABLE`). Subjects, relações e interações **ficam no JSONB `plan`**; nenhuma coluna nova em `creative_generations`. Não houve dúvida de tenancy que exigisse proposta antes: a tabela segue o padrão das tabelas de plataforma da 0018 (`organization_id` NOT NULL, RLS + FORCE, policy canônica, entrada em `TABELAS_PLATAFORMA`), e o `store_id` o padrão 0025–0029 (FK composta).

## 3. Contratos

- `RequestSubject` (novo): `id`, `role`, `persona`, `age_band`, `relation_to_primary`, `relation_label`, `wears_product_id` (ausente = planner decide; `null` = não veste nada; id = veste), `prominence`.
- `CreativeRequest`: `subjects` (máx. 4), `interaction`, `scene_picks`. **Exigem `plan_schema_version=2`** (`scene_picks` também `prompt_version=2`); em plano v1 o core recusa com `INVALID_INPUT` em vez de ignorar em silêncio.
- `PlanSubject`: `relation_to_primary` (enum: `mother, father, daughter, son, sibling, partner, friend, grandparent, custom`), `relation_label`, `age_source`; faixas etárias `baby, child, child_3_5, child_6_9, child_10_12, teen, adult, senior, unknown`.
- `PlanScene`: `interaction`, `interaction_source`, `interaction_detail`, `scene_mode` (`template` | `frame`), `composition_source` (`explicit` | `recommended` | `legacy`).
- `MinorSafety.basis`: `{explicit: [ids], heuristic: [ids]}` — de onde veio cada idade.
- `GenerationDraft`: `subjects` (agora em forma de request), `interaction`, `scene_picks`, `plan_warnings`, `actions {again, variation}`.
- `FeedbackSnapshot`: `interaction`, `composition_source`, `composition_key`, `pose_risk`, `warnings`, `subjects[].relation_to_primary`.
- Novo erro `INTERACTION_INCOMPATIBLE`. Catálogo (`GET /v1/contracts`): `interactions` e `relations` com nomes para telas.
- Schemas regenerados em `creative_core/schemas/`.

## 4. Os 5 fixtures

`creative_core/fixtures_v2/fixture-c1-{a-pai-e-filha,b-menino-e-mae,c-duas-irmas,d-casal,e-familia}.json`.

| Caso | Composição | Resultado do plano |
|---|---|---|
| A — pai e filha | **nenhum subject no request**; a estampa (`semantic_context`) recomenda | `recommended`, cena `frame`; filha `child_6_9` veste (origem `product`), pai apoia sem vestir; interação `playing`; olhar `interaction`; risco `medium`; sem avisos |
| B — menino e mãe | explícito | menino veste; mãe (`relation: mother`) presente sem vestir; `reading_together`; olhar `interaction`; risco `medium` |
| C — duas irmãs | explícito, produtos diferentes | cada uma veste o seu; `sibling`; `candid`; olhar fora da câmera; risco `low` |
| D — casal | explícito | dois adultos, `partner`, peças combinando; `looking_at_each_other`; sem bloco de proteção de menores |
| E — família de 4 | explícito | 2 crianças + mãe + pai; `group_photo`; olhar câmera; risco **`high`**; aviso `people_count_risk:4`; "ninguém segura objetos" |

Cada plano valida no contrato, recompila byte a byte e lista a seção `interaction` logo depois de `gaze`.

## 5. Exemplos de plano

Ver o arquivo de exemplos. Trecho do caso A (campos da cena):

```json
"subjects": [
  {"id":"s1","role":"primary","age_band":"child_6_9","is_minor":true,"product_use":"wears","source":"product"},
  {"id":"s2","role":"supporting","age_band":"adult","relation_to_primary":"father","product_use":"none","role_hint":"father"}
],
"scene": {"composition_source":"recommended","scene_mode":"frame","interaction":"playing",
          "gaze":{"mode":"interaction","source":"planner_default","reason":"interaction:playing"}},
"composition": {"people_count":2,"pose_risk":"medium"},
"provenance": {"subjects":"product","scene.interaction":"product"},
"provenance_sources": {"scene":["planner_default","product"],"subjects":["product"]}
```

## 6. Como relações e interações funcionam

- **Relação** é dado estruturado (`relation_to_primary`), não texto livre. O texto do prompt sai dela ("mãe da Pessoa 1"); a comparação com a estampa também (a persona "Carla" com relação `mother` conta como mãe, o rótulo é irrelevante). A principal não tem relação. `custom` exige `relation_label`.
- **Interação** é um catálogo em `templates/interactions.json` (11 entradas: `candid, talking, looking_at_each_other, walking, hugging, reading_together, playing, cooking, doing_activity, gifting, group_photo`). Cada uma declara mín/máx de pessoas, faixas que não combinam, contato, complexidade de mãos, uso de objeto, olhar padrão, peso de risco de pose e as duas frases do compiler. Nenhuma lógica de interação vive em `if`; entrada nova = registro novo, sem código (há teste que prova).
- **Explícita**: o número de pessoas fora do intervalo é **erro** (`INTERACTION_INCOMPATIBLE`); idade que não combina é **aviso** (`interaction_age_mismatch:...`) — a escolha do usuário nunca é bloqueada por semântica.
- **Sem interação pedida** (2+ pessoas): a primeira `scene_intent` da estampa cuja interação cabe (origem `product`/`product_enrichment`); senão o padrão do catálogo (`candid`, origem `planner_default`). Uma pessoa: nenhuma.
- **Olhar** derivado da interação (precedência: sem pessoas > usuário > padrão da interação > pool > tabela do ângulo). **Risco de pose**: 1–2 pessoas normal, 3 aviso (`medium`), 4 sempre `high` e nunca sugerido como "seguro"; a interação soma seu peso.
- **Máximo 4 pessoas**, validado no contrato e no planner.

## 7. Como `semantic_context` influencia subjects

- Sem `subjects` no request e com um único produto cujo `semantic_context` recomenda um papel de apoio (`recommended_supporting_roles`), o planner **recomenda** o elenco: quem veste sai de `wearer_roles`, quem apoia de `recommended_supporting_roles`, a interação de `scene_intents`. Vale em qualquer ângulo que aceite pessoas (`angle_people.recommend`); ângulos de peça única, close, selfie ou com template próprio ficam `legacy`.
- Persona custom escolhida pelo usuário continua sendo a principal (origem `user`); só o apoio é recomendado (origem `product`) → agregado `mixed`.
- **Nunca bloqueia**: escolha manual que contradiz a estampa gera apenas aviso (`semantic_mismatch:<tema>:<papel>`, `wearer_role_mismatch:...`) e a cena sai.

## 8. Como a segurança de menores usa dado explícito

- A faixa etária é dado: `RequestSubject.age_band` > `Persona.age_band` > anos no rótulo > `age_range` > palavras. A heurística de texto é só o último recurso (e por último o tipo de produto infantil para a principal).
- `is_minor` deriva da faixa; `minor_safety.basis` registra quais pessoas foram decididas por dado explícito e quais por heurística (`explicit` × `heuristic`) — auditável.
- Camada global (não afrouxável) + camada da marca (só acrescenta restrição) inalteradas da Fase B; a regra adulto–criança (contato só em contexto familiar) vale para qualquer relação.
- A UI nunca mostra faixa etária, e o resumo de cena tira "N anos" dos rótulos.

## 9. Tabela `creative_feedback`

| Coluna | Tipo | Nota |
|---|---|---|
| `organization_id` | UUID NOT NULL | FK `organizations`, RLS |
| `id` | UUID | PK `(organization_id, id)` |
| `store_id` | UUID **NULL** | NULL = compartilhado pela Organization; FK composta `(store_id, organization_id) → stores` |
| `creative_id`, `job_id` | UUID NOT NULL | FKs compostas `(organization_id, …)` → `creative_generations`, `creative_jobs`, `ON DELETE CASCADE` |
| `user_id` | UUID NOT NULL | FK `users`, sempre da sessão |
| `verdict` | TEXT | `liked` \| `disliked` |
| `snapshot` | JSONB NOT NULL | `FeedbackSnapshot` do core |
| `plan_schema_version`, `compiler_version`, `prompt_version` | INT | versões |
| `angle`, `objective`, `mode`, `context_id`, `interaction`, `composition_key`, `product_ids TEXT[]`, `people_count`, `pose_risk` | — | colunas de consulta copiadas do snapshot |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

`UNIQUE (organization_id, creative_id, user_id)` = chave do upsert. RLS `ENABLE` + `FORCE` com a policy canônica; índices por dimensão e GIN em `product_ids`. Entrada em `TABELAS_PLATAFORMA` e `docs/productization/tenant-owned-tables.md` regenerado. Nada lê esta tabela para decidir uma geração (sem ML, sem ranking).

## 10. Exemplo de `FeedbackSnapshot` (caso A)

```json
{
  "creative_id": "…", "plan_id": "plan_67a0…", "plan_schema_version": 2, "compiler_version": 2, "prompt_version": 2,
  "prompt_sha256": "440bc5e5…", "mode": "creative", "objective": "clean_creative", "strategy": "CLEAN_ANGLES",
  "angle": "LIFESTYLE_COTIDIANO", "product_ids": ["pipa-menina"],
  "subjects": [
    {"role":"primary","age_band":"child_6_9","is_minor":true,"product_use":"wears","relation_to_primary":null},
    {"role":"supporting","age_band":"adult","is_minor":false,"product_use":"none","role_hint":"father","relation_to_primary":"father"}
  ],
  "people_count": 2, "interaction": "playing", "composition_source": "recommended",
  "composition_key": "p2|child_6_9+father|playing", "pose_risk": "medium", "warnings": [],
  "context": {"context_id":"entre_nos_sala","context_type":"custom","provider":"custom","scene":"…"},
  "placement": "FEED_4X5", "quality": "medium", "gaze_mode": "interaction", "minor_safety_applied": true,
  "flags": {"normalize_references": null}, "model": {"requested":"gpt-image-2","served":null}, "asset_sha256": null
}
```

`composition_key` = `p<pessoas>|<faixa da principal>+<relações dos apoios>|<interação>`: uma string estável para agrupar aprovação por composição.

## 11. Endpoints de feedback

Core (puros, sem chave, sem provedor, sem estado): `POST /v1/feedback-snapshot {plan[, result_metadata, asset_sha256]}`, `POST /v1/draft {plan}`.

Painel (`/api/admin/criativos`, `requireAdmin`, módulo habilitado):

| Rota | Comportamento |
|---|---|
| `PUT /items/:creativeId/feedback` `{verdict}` | só criativo `completed` com plano da própria Organization; snapshot vem do core; upsert; a pessoa vem da sessão, nunca do corpo (corpo com outro campo = 400) |
| `DELETE /items/:creativeId/feedback` | limpa o veredito desta pessoa; idempotente |
| `GET /history`, `GET /jobs/:id` | cada item traz `feedback: {verdict, updatedAt} \| null` — só o da pessoa logada |
| `GET /feedback/summary?by=angle\|objective\|context\|interaction\|composition\|product[&scope=store\|organization]` | contagem `liked/disliked/total` por chave; escopo Store = da Store + compartilhado; não expõe quem votou |

## 12. Exemplo de `GenerationDraft` (caso A, resumo)

```json
{
  "angle_id": "LIFESTYLE_COTIDIANO", "product_ids": ["pipa-menina"],
  "subjects": [
    {"id":"s1","role":"primary","persona":{"label":"criança de 6 a 9 anos","age_band":"child_6_9"},"wears_product_id":"pipa-menina","prominence":"hero","age_band":"child_6_9"},
    {"id":"s2","role":"supporting","persona":{"label":"homem adulto"},"wears_product_id":null,"prominence":"secondary","age_band":"adult","relation_to_primary":"father"}
  ],
  "interaction": "playing", "gaze_mode": "interaction", "seed": 100, "scene_picks": {"acao": 4},
  "actions": {
    "again":     {"seed": 100,  "scene_picks": {"acao": 4}, "gaze_mode": "interaction"},
    "variation": {"seed": null, "scene_picks": null,        "gaze_mode": "auto"}
  }
}
```

O painel acrescenta ao `GET /items/:creativeId/draft`: `form` (o mesmo formato do `POST /jobs`), `actions` já válidas para o `POST /jobs`, `carried`, `unavailable` e `warnings`, mais o `draft` do core inteiro.

## 13. "Gerar de novo" × "Gerar variação"

| | Gerar de novo | Gerar variação |
|---|---|---|
| Semente | mantém | descarta |
| Sorteios de cena (`scene_picks`) | mantém | descarta |
| Olhar | mantém o resolvido | descarta o que o planner escolheu; mantém o que o usuário pediu |
| Produto, pessoas, relações, interação, ângulo, contexto, formato, demais escolhas humanas | mantém | mantém |

Teste: reconstruir o pedido a partir do draft com "de novo" reproduz o **mesmo `prompt.sha256`** nos 5 casos, no recomendado e no legado; "variação" mantém pessoas/relações/interação/ângulo/contexto/formato/produtos. Uma cena que o planner sorteou sozinho (`legacy`) não vira `subjects` explícito no draft: volta pela semente (evita congelar como "escolha humana" o que não foi escolha).

## 14. UI mínima

`apps/panel/src/pages/criativos/` (`AvaliacaoCriativo.tsx`, `LotesTab.tsx`, `GerarTab.tsx`, `CriativosPage.tsx`, `api/criativos.ts`; typecheck e `vite build` ok):

- **Cards do lote e coluna "Avaliação" do histórico** (só criativo concluído): `Gostei` · `Não gostei` (`aria-pressed`; clicar de novo limpa) · `Copiar dados`.
- **Copiar dados** abre o Gerar preenchido, com um cartão "Dados copiados de um criativo": aviso do que não pôde vir (produto/marca/persona/contexto arquivados, plano v2 desligado…), a linha **"Recomendado: Criança + pai · brincando juntos · Sala de estar"** e os botões `Gerar assim` (variação) e `Gerar de novo (mesma cena)`; `Personalizar cena` (sob demanda) lista as pessoas (nome, relação, se veste) e permite trocar a interação ou "Usar cena automática".
- O que a tela não edita (pessoas, interação, chaves extras de remarketing/funil) segue no estado e volta no pedido: nada se perde em silêncio.
- Nunca aparecem faixa etária, risco de pose, ids de relação, política de segurança, contexto semântico ou metadados do compiler (o teste de rota confere que a resposta do draft não os contém).

Verificação visual: harness com backend simulado (fora do repositório) no Chrome — toggle Gostei/Não gostei/limpar, Copiar dados → Gerar, banner "Recomendado", Personalizar cena, aviso de indisponíveis e o pedido enviado por "Gerar assim" (sem semente/sorteios) e "Gerar de novo" (com `seed`, `scene_picks`, `gaze_mode`). Sem o painel real logado (login é a exceção manual).

## 15. Golden V1

`tests/golden/prompt_v1.json` (546 casos) **intacto**: `test_prompt_v1_golden.py` 4/4. Os 18 planos da Fase B guardados (`fixtures_v2/plans_fase_b/`) recompilam com o compiler v1 byte a byte; planos novos usam o compiler v2 (versão gravada no plano).

## 16. Suíte completa

- Core: `python3 run_tests.py` → **16/16 suítes** (inclui `test_subjects_c1.py` 30 casos, `test_drafts.py` 15, `test_service.py` 16).
- Painel: novos `creative-feedback.test.js` (22) e `creative-feedback-pg.test.js` (Postgres real, inclusive `TEST_APP_ROLE=1`); invariantes de migração e o isolamento `tenancy-isolation` cobrem `creative_feedback`. Suíte inteira: ver §21.

## 17. Riscos

1. **Recomendação por `semantic_context` depende de dado que hoje só entra manualmente** (a proposta por GPT é da Fase F): sem `semantic_context` nada é recomendado, tudo continua `legacy`.
2. **Rótulos do planner** ("criança de 6 a 9 anos", "homem adulto") são neutros por desenho; o resumo da UI não diz "Menina" sem um gênero declarado. Persona/subject com rótulo do usuário resolve.
3. **Cena com 3–4 pessoas** é a mais sujeita a anatomia/mãos; o core avisa e simplifica a pose, mas **não foi validada visualmente** (nenhuma imagem foi gerada nesta fase). Antes de liberar, rodar um lote real pequeno com os casos B–E.
4. **Compiler v2 muda o prompt** de planos v2 novos (seção `interaction`, cena `frame`). Só valem para contas em `CREATIVE_PLAN_V2_ORGS`.
5. `GET /items/:id/draft` para contexto geográfico depende do `input` do lote original (cidade/UF não são fato do plano).
6. Feedback grava `store_id` da Store do contexto; V1 tem uma Store por Organization, então na prática é sempre a dela. Se um dia houver várias, veredito de uma Store conta como "compartilhado" nas outras só se gravado sem Store.
7. Deploy: **Python antes do Node** (o painel chama `/v1/draft` e `/v1/feedback-snapshot`); migration 0033 antes de expor as rotas.

## 18. Compatibilidade retroativa

- Request sem `subjects`/`interaction`/`scene_picks` produz o mesmo plano de antes (cena `template`, `composition_source: legacy`).
- Planos e drafts antigos (v1 e Fase B) continuam válidos; `subjects` do draft mudou de `PlanSubject[]` para `RequestSubject[]` (o draft da Fase B não tinha consumidor).
- Plano v1 não aceita os campos novos (recusa explícita). `plan_schema_version`/`prompt_version` por Organization inalterados.
- Migration aditiva; histórico e jobs existentes não mudam.

## 19. OpenAI

Nenhuma chamada nesta fase. Nenhuma imagem gerada. A chave da rodada A/B não foi usada.

## 20. Push / deploy

Nenhum push, merge, deploy ou `gh`. Nada além de commits locais na branch `feature/creative-fase-c`. **A próxima fase não foi iniciada**: fica para o senhor revisar Subjects + Feedback + Copiar Dados antes de UI V2, Mockups ou Connector.
