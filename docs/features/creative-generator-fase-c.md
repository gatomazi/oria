# Gerador de Criativos — Fase C (Subjects, Feedback, Copiar Dados)

Branch `feature/creative-fase-c`, worktree `oria-creative-fase-a`. Sem push, sem merge, sem deploy, sem chamada à OpenAI.
Exemplos completos (request, plano, prompt, snapshot, draft de cada caso): [`creative-generator-fase-c-examples.md`](creative-generator-fase-c-examples.md).

**Status**: fechada — gate da suíte fechou verde (§0), a contradição do wearer infantil foi corrigida (§2.1), `scene_picks` × `interaction` foi revisado (§2.2), e a validação visual das 8 imagens reais fechou sem achado (§21). Próxima fase não iniciada.

## 0. Gate da suíte (resultado final)

Primeira suíte completa do painel no HEAD, antes desta correção: **1296/1300**, 4 falhas. Investigadas uma a uma, nenhuma foi atribuída a "carga da máquina" sem prova:

- **2 falhas em `tenancy-upsert`**: reais, minhas. O invariante liga cada `ON CONFLICT` à tabela do `INSERT INTO` mais próximo no arquivo; o upsert de `creative_feedback` estava dentro de `pgStore.js`, perto do `INSERT` de `creative_assets`, e foi contado para a tabela errada. Corrigido movendo as queries de feedback para `lib/creative-core/pgFeedback.js` (módulo próprio); contagem de alvos `ON CONFLICT` tenant-owned atualizada de 34 para 35 (commit `646acd7`).
- **2 falhas em `negative-controls` (STORE-01, STORE-04)**: investigadas com evidência, não descartadas por suposição. `ps aux` encontrou um `server.js` **órfão** (PID 68703, `PPID 1`, rodando desde as 17:21, **213 minutos de CPU**) — um servidor de um `subirApp()` de teste anterior que não foi encerrado, consumindo um núcleo inteiro continuamente. Isso degradava exatamente os testes sensíveis a tempo (o ciclo violação→restauração dos negative controls tem esperas fixas). Matei o processo (`kill 68703`), reexecutei `negative-controls.test.js` sozinho → **120/120**, sem alterar nenhum código de produto.

Suíte completa reexecutada do zero, máquina limpa, HEAD final (commit `8a07e4e`): **1301/1301, 0 falhas** (1 teste a mais que a rodada anterior porque a correção do §2 adicionou o teste "wearer_rules" na malha de invariantes indiretamente contado). Core: **17/17 suítes**, golden V1 intacto (546/546).

## 1. Commits

| Commit | O que entrega |
|---|---|
| `e00c2d0` | §2.1 (Fase B) proveniência: seção composta não é atribuída a uma origem só (`mixed` + `provenance_sources`) |
| `b4c752d` | C1: subjects, relações e interações; compiler v2 (v1 congelado); 5 fixtures; catálogo de interações como dado |
| `c3d3f6a` | `POST /v1/draft` e `POST /v1/feedback-snapshot` no core (puros); "de novo" e "variação" no draft |
| `2c13035` | migration 0033 `creative_feedback`; rotas de feedback, draft e consulta; UI mínima |
| `e399cd8`, `e733162` | ajustes do resumo de cena na UI (nomes em minúsculas, sem faixa etária) |
| `646acd7` | feedback SQL isolado em `pgFeedback.js` (corrige a contagem do invariante `tenancy-upsert`); relatório e exemplos |
| `8a07e4e` | **correção crítica**: wearer da peça infantil precisa ser criança (estrutural, não só string); `scene_picks` descartados numa cena `frame` |

## 2. Migrations

Uma só: **0033 `creative_feedback`** (`migrations/1790001800000_creative-feedback.js` + `sql/0033-creative-feedback.{up,down}.sql`). Aditiva e reversível (`DROP TABLE`). Subjects, relações e interações **ficam no JSONB `plan`**; nenhuma coluna nova em `creative_generations`. Não houve dúvida de tenancy que exigisse proposta antes: a tabela segue o padrão das tabelas de plataforma da 0018 (`organization_id` NOT NULL, RLS + FORCE, policy canônica, entrada em `TABELAS_PLATAFORMA`), e o `store_id` o padrão 0025–0029 (FK composta).

## 2.1 Correção crítica — peça infantil ≠ cena composta só por crianças

**O problema.** O bloco de fidelidade (v1, `products.py`) tem, para toda peça infantil, uma frase absoluta: *"O MODELO da cena é SEMPRE uma criança, NUNCA um adulto."* Essa frase descreve o modelo **da cena inteira** — fazia sentido quando a cena só podia ter uma pessoa. Com Subjects (C1), uma cena pode ser criança+pai, criança+mãe, família de 4, etc., e a frase passou a contradizer o próprio plano: o prompt dizia "o modelo é sempre uma criança" na mesma respiração em que o contrato de pessoas descrevia um adulto de apoio na cena.

**A correção não foi só trocar a frase.** Duas camadas:

1. **Estrutural, no plano** (`composition.enforce_infant_wearers`, `composition.py`): quem **veste** a peça infantil (`subject.wears_product_id` apontando pra um produto onde `infant_product()` é verdadeiro) precisa estar numa faixa etária compatível com o tipo da peça (dado em `planner_v2.json → minor.infant_wearer_bands`; `camiseta infantil` aceita `baby..child_10_12`, `body infantil` só `baby..child_3_5`). A validação roda **por subject e por produto** (multi-product: cada atribuição é checada isoladamente — um adulto pode vestir a peça adulta na mesma cena que a criança veste a infantil).
   - **Escolha do usuário** (subject explícito ou persona custom) que não cabe → `INVALID_INPUT` nomeando o subject (`subjects[1]: … is an infant garment and can only be worn by a child, but this subject is adult; an adult may be in the scene as support without wearing it`), **antes de montar qualquer prompt**. Nenhum prompt contraditório chega a ser gerado.
   - **Escolha do planner** (elenco `legacy`/`recommended`) que não cabe é **corrigida**, não rejeitada: a principal é re-sorteada do pool de personas que cabem na faixa (ou a persona neutra do papel — "criança de 6 a 9 anos"/"bebê"); um apoio simplesmente deixa de vestir. Ambas registradas como aviso (`infant_wearer_recast:<id>` / `infant_wearer_removed:<id>`), nunca em silêncio.
   - Idade `unknown` num wearer de peça infantil é lida como criança (era só para a principal; agora vale para qualquer subject).
   - Peça **adulta**: nenhuma restrição — qualquer idade veste.
2. **Wording, só no compiler v2** (`compiler._fidelity_v2`, dados em `templates/compiler_v2.json → wearer_rules`): a frase antiga é substituída pela nova, por peça — *"Qualquer pessoa que VESTE esta peça deve ser uma criança compatível com a faixa do produto. Adultos podem aparecer na cena como pessoas de apoio, mas NUNCA vestem esta peça infantil."* (variante para `body infantil`: "bebê ou criança pequena"). Um **guard** garante que a frase antiga (`"O MODELO da cena é SEMPRE"`) nunca sobrevive no texto do compiler v2 — se alguém cadastrar uma peça nova com essa frase e esquecer de mapear a substituição, `compile_prompt` **recusa** (`ValueError`) em vez de deixar a ideia velha voltar disfarçada.

**V1 não foi tocado.** `compile_prompt(plan, version=1)` continua produzindo a frase antiga, exatamente como os 546 casos golden e os 18 planos congelados da Fase B esperam (teste dedicado prova isso). A frase nova só existe no compiler v2, e só nele.

Testes novos: `creative_core/tests/test_infant_wearer.py` (15 casos) — 4 elencos válidos (criança+pai, criança+mãe, duas crianças cada uma com sua peça, família de 4 com as 2 crianças vestindo e os 2 adultos não), 2 elencos inválidos (adulto veste peça infantil explicitamente; troca de produto que entrega a peça infantil a um adulto — cada atribuição validada por si), faixas por tipo de peça (`camiseta infantil` × `body infantil`; teen não cabe em nenhuma), idade desconhecida virando criança em qualquer subject, correção silenciosa-com-aviso quando é o planner que escolhe × recusa quando é o usuário, a frase nova em cada um dos 5 casos + o guard do compiler, e a frase antiga preservada no compile v1.

## 2.2 Revisão — `scene_picks` × `interaction`

**O problema apontado.** Nos exemplos, um plano podia ter `scene_picks.acao` = "saindo de um café com um copo descartável…" ao mesmo tempo em que a `interaction` estruturada era `playing`/`reading_together` — dois textos de ação diferentes coexistindo, um deles sem efeito nenhum no prompt (o `scene_action` de uma cena `frame` usa o ângulo + a interação, nunca os pools). Herança do fluxo v1, nunca revisada depois que Subjects passou a existir.

**Decisão adotada** (regra pedida no §6 da direção): quando `scene_mode = frame` (há subjects + interação), os `scene_picks` do ângulo **não são mais persistidos como decisão ativa**. Eles continuam existindo só onde ainda fazem sentido: derivar o elenco de um cenário legado como o do PRESENTE_AFETO (`cena` decide quem veste o presente) — usados durante essa derivação e depois descartados, nunca gravados no plano. Um `scene_picks` enviado no request junto com uma cena `frame` é **ignorado, com aviso explícito** (`scene_picks_ignored:frame_scene`), não descartado em silêncio; o prompt sai idêntico ao de um request sem esse campo (mesmo `sha256`). Uma cena `template` (sem subjects/interação — o comportamento antigo, intacto) continua usando seus picks exatamente como antes: eles entram no `scene_action`, movem o `gaze` (`pool:<nome>:<índice>`) e o risco de pose (`held_object`/`contact`).

**Por que importava**: `Gerar de novo` preserva `scene_picks`, `Copiar Dados` os carrega, e o histórico/feedback podia interpretar um pick sem efeito como parte da cena. Com a mudança: `scene["picks"]` de uma cena `frame` é sempre `{}`; o `GenerationDraft.scene_picks` e `actions.again.scene_picks` saem `null`/ausentes para ela (nada a repetir); o `FeedbackSnapshot` nunca carrega `scene_picks`. Uma cena `template` continua exportando os picks normalmente em ambos.

Testes novos em `test_subjects_c1.py`: cena `frame` não persiste picks e eles não movem gaze/risco (5 casos); cena `template` continua usando os seus; pick enviado com cena `frame` é ignorado com aviso e o prompt não muda; draft/snapshot de um elenco recomendado ou explícito não carregam `scene_picks`.

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

- Core: `python3 run_tests.py` → **17/17 suítes** (inclui `test_subjects_c1.py` 34 casos, `test_infant_wearer.py` 15, `test_drafts.py` 15, `test_service.py` 16); golden V1 546/546 intacto.
- Painel: `creative-feedback.test.js` (23) e `creative-feedback-pg.test.js` (Postgres real, inclusive `TEST_APP_ROLE=1`); invariantes de migração e o isolamento `tenancy-isolation` cobrem `creative_feedback`; `tenancy-upsert` conta 35 alvos `ON CONFLICT`. **Suíte completa (painel), HEAD final, máquina limpa: 1301/1301, 0 falhas** — ver §0 para o histórico do gate (4 falhas → causa raiz investigada e corrigida → verde).

## 17. Riscos

1. **Recomendação por `semantic_context` depende de dado que hoje só entra manualmente** (a proposta por GPT é da Fase F): sem `semantic_context` nada é recomendado, tudo continua `legacy`.
2. **Rótulos do planner** ("criança de 6 a 9 anos", "homem adulto") são neutros por desenho; o resumo da UI não diz "Menina" sem um gênero declarado. Persona/subject com rótulo do usuário resolve.
3. **Cena com 2–4 pessoas** é a mais sujeita a anatomia/mãos; o core avisa e simplifica a pose, mas **não foi validada visualmente** (nenhuma imagem foi gerada nesta fase). A validação real (8 imagens, casos B–E) foi executada em §21: 8/8 utilizáveis, sem ajuste, incluindo o caso E (4 pessoas).
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

## 21. Validação visual real — executada

Autorizado pelo senhor a usar a mesma fonte de chave da Rodada 1 (`.env` do projeto Streamlit local, lida em memória, nunca impressa/logada/commitada). **8/8 imagens geradas**, avaliação humana abaixo.

### 21.1 Como foi feita

Sem o pacote `openai`: este sandbox não alcança o PyPI (só um mirror privado Fury e uma lista curta de hosts, incluindo `api.openai.com`). Em vez de contornar isso, implementei a chamada HTTPS diretamente com a stdlib (`urllib`), conferindo o contrato exato (nome do campo multipart, formato da resposta, campos de `usage`) contra o código-fonte real do SDK `openai-python` no GitHub — não adivinhado. Script em `scripts/render_fase_c_examples.py`-adjacente, fora do repositório (não commitado; é execução única, não infraestrutura nova do produto): monta o `CreativePlan` de cada caso pelo `plan_creative` de produção, chama `generate_creative` (o mesmo caminho de produção, cliente real no lugar do fake dos testes), sem retry (uma tentativa por imagem, falha ou sucesso, segue pra próxima). Cada chamada é registrada num ledger **antes** de disparar, para nenhuma tentativa ficar sem rastro.

**Referências reais**, não os placeholders fictícios dos fixtures C1: usei fotos de produto reais da linha Entre Nós (pasta local do senhor, adicionada durante a sessão) — "Abelhinhas — Hora da Leitura" (B), "Irmãs em União" (C, o mesmo print real para as duas irmãs — só existe uma cor), "Minha Pessoa Favorita Me Chama de Vida" + "Pato da Vida" (D, par de casal), e a combinação Abelhinhas + Irmãs em União para as duas crianças do caso E (conforme sua escolha). Caso D não tinha produto de casal nos fixtures nem na pasta original; o senhor adicionou duas peças reais durante a sessão.

**Um bug meu, achado e corrigido no meio da rodada**: as 4 primeiras tentativas de D e E (2 referências diferentes cada) voltaram HTTP 400 `duplicate_parameter` — eu mandava o campo `image` repetido; a API exige `image[]` quando há mais de uma referência (confirmado no texto exato do erro, não suposição). Corrigido, as 4 foram refeitas com sucesso. Essas 4 tentativas que falharam **não geraram nem cobraram nada** (erro de validação antes de qualquer geração) — não contam como retry automático (foi uma correção de bug de infraestrutura minha, autorizada por você via pergunta explícita antes de eu continuar, não um ajuste de prompt por causa de qualidade de imagem).

### 21.2 Chamadas, custo e modelo

| | Valor |
|---|---|
| Chamadas HTTP à OpenAI | **12** (8 bem-sucedidas + 4 que falharam por bug meu de encoding, sem geração nem cobrança) |
| Imagens geradas (cobradas) | **8/8** |
| Modelo pedido | `gpt-image-2` (default do core) em todas as 12 |
| Modelo servido | `gpt-image-2` nas 8 bem-sucedidas — **nenhum fallback** |
| Quality / formato | `medium` / Feed 4:5 (1088×1360) em todas |
| Duração por imagem | 34–39s |
| Custo total (tabela publicada em `apps/panel/lib/custos/precos.js`, conferida 2026-09-15) | **US$ 0,537** |

| Caso | Tokens entrada (texto+imagem) | Tokens saída | Custo/imagem | 2 imagens |
|---|---|---|---|---|
| B (1 referência) | 1488 + 1024 | 1587 | US$ 0,0632 | US$ 0,1265 |
| C (1 referência, mesmo print p/ as 2) | 1491 + 1024 | 1587 | US$ 0,0633 | US$ 0,1265 |
| D (2 referências) | 1293 + 2048 | 1587 | US$ 0,0705 | US$ 0,1409 |
| E (2 referências) | 1549 + 2048 | 1587 | US$ 0,0717 | US$ 0,1435 |

Manifesto completo (por imagem: plan_id, sha256 do prompt, trace, usage) e as 8 imagens em `~/Desktop/fase-c-visual-8-imagens/` (fora do repositório).

### 21.3 Avaliação por caso

**Caso B — menino + mãe lendo** (2 imagens, seeds 100/201): contagem e papéis corretos (menino veste a peça, mãe não veste); estampa reproduzida com fidelidade alta (abelhas, texto, posição); interação `reading_together` plausível (os dois olhando o livro, mãe apontando uma página); mãos naturais nas duas imagens, sem fusão nem dedo a mais; luz e cenário batem com o brand kit (sala aconchegante, luz lateral quente). **Utilizável, sem ajuste.**

**Caso C — duas irmãs** (seeds 100/202): 2 crianças, diferença de idade plausível (mais alta/mais nova, batendo com `child_6_9`/`child_3_5`); as duas vestem o mesmo print real (única cor disponível — ver §21.1), fiel à referência; interação `candid` natural (um braço no ombro, sorrindo, não olhando fixo pra câmera as duas); mãos visíveis sem deformação. **Utilizável, sem ajuste.**

**Caso D — casal** (seeds 100/203): 2 adultos, cada um vestindo o produto certo (ela "minha pessoa…", ele "pato da vida") sem troca; `looking_at_each_other` renderizado corretamente (as duas imagens têm o casal se olhando, não pra câmera); nenhuma criança na cena (correto — bloco de proteção de menores ausente no prompt, como esperado); mãos parcialmente ocultas pela pose mas nenhuma malformação visível onde aparecem. **Utilizável, sem ajuste.**

**Caso E — família de 4 (stress test principal)** (seeds 100/204): **contagem certa de 4 pessoas** nas duas imagens; as duas crianças vestem prints infantis **diferentes e corretos** (menino=abelhinhas, menina=irmãs-em-união); os dois adultos **não vestem nenhuma peça infantil** (camisetas lisas — a regra estrutural do §2.1 funcionando visivelmente: nada os impede de aparecer, e nada os veste); `group_photo` com todos olhando a câmera, pose simples (abraço/aconchego, não empilhados nem em fileira robótica); sem troca de produto entre as crianças; mãos nas duas imagens sem fusão, sem dedo extra, contáveis. **Utilizável, sem ajuste** — nenhum dos riscos do aviso `people_count_risk:4` se concretizou visualmente nestas 2 amostras.

### 21.4 Resumo objetivo

Nenhuma das 8 imagens apresentou problema de anatomia (mãos, dedos, membros, fusão), contagem de pessoas, troca de produto ou peça infantil em adulto. As 4 interações estruturadas (`reading_together`, `candid`, `looking_at_each_other`, `group_photo`) e os gazes correspondentes se manifestaram de forma reconhecível e coerente com o plano. **Nenhuma correção foi feita com base nas imagens** — a rodada terminou sem achado que pedisse ajuste de prompt; o único bug encontrado (§21.1) era de infraestrutura da minha chamada HTTP, corrigido antes de qualquer avaliação visual, não depois. Amostra pequena (2 por caso): não é validação estatística, é o que foi pedido — um primeiro olhar real antes de decidir sobre rollout mais amplo.

Sem push, sem merge, sem deploy nesta etapa. **Próxima fase não iniciada.**
