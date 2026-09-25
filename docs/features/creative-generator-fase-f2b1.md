# Fase F.2.B.1 — qualidade semântica, revisão segura e reconciliação do piloto F.2.B

**Escopo desta fase**: local, sem chamadas OpenAI, sem recriar o Postgres efêmero do piloto, sem
repetir o piloto, sem aprovação de propostas reais, sem push/merge/deploy/ativação de flags. Commits
locais apenas. Não inicia F.2.C.

A F.2.B ficou encerrada como **piloto técnico**: 3/3 chamadas reais bem-sucedidas, US$ 0,001268 de
custo real, zero produto alterado automaticamente. A qualidade das inferências NÃO estava aprovada
para rollout — esta fase fecha exatamente essa lacuna, sem gastar nenhum centavo novo.

---

## 1–2. Qualidade semântica: evidência por campo, não confiança global

### O problema, com números reais do piloto

Os 3 resultados reais (`creative-generator-fase-f2b-pilot-results.json`) mostraram o MESMO padrão nos
3 casos: um campo bem evidenciado (nome do produto, texto legível na imagem) produzia
`confidence: 1` **agregado**, que então "emprestava" credibilidade a campos vizinhos sem evidência
própria — uma lista mecânica de exclusão, um roster completo de papéis, ou um valor genérico do
vocabulário. `field_notes` também replicava a MESMA justificativa e `source: "openai_vision"` para
todo campo populado sempre que qualquer imagem tinha sido enviada, mesmo quando a conclusão real
vinha do nome/descrição, não da imagem.

### A correção, deliberadamente estrutural — nunca por palavra

Conforme exigido ("não faça um classificador de regras gigantesco... mostre que as restrições se
generalizam a equivalentes não vistos"), a correção tem três partes, nenhuma delas cita um papel,
tema ou intenção específicos por nome:

1. **`_request_schema()` (apps/creative-generator/creative_core/enrichment.py)** — dois campos NOVOS,
   obrigatórios (Structured Outputs strict mode), só no schema que vai para a OpenAI (nunca no
   contrato armazenado, nunca versionado como mudança de dado histórico): `field_confidence` (0–1 por
   campo) e `field_basis` (`observed_reference_image` / `text_or_metadata` / `generic_inference` /
   `no_evidence`), ambos com as chaves fixas nos MESMOS 6 campos de `_MERGEABLE_FIELDS` — uma única
   lista fonte, reaproveitada também no schema e no gate.
2. **`_OPENAI_SYSTEM_PROMPT` (prompt_version 2)** — reescrito para instruir, por PADRÃO DE
   RACIOCÍNIO: (a) confiança é por campo, nunca herdada de um vizinho bem evidenciado; (b)
   `incompatible_auto_supporting_roles` só com razão concreta de exclusão, nunca "listar
   mecanicamente todos os outros papéis"; (c) `recommended_supporting_roles` não deve virar o
   vocabulário inteiro só porque nada se destacou; (d) "poderia servir para vários casos" é ausência
   de evidência, não evidência — deve virar `generic_inference` com confiança baixa, nunca um
   palpite apresentado como achado.
3. **`_apply_evidence_gates()`, pós-modelo, em `_OpenAIProvider.propose()`** — duas checagens,
   ambas catalog-driven (usam `_PERSON_ROLE_VALUES`, o catálogo real do planner, nunca uma lista de
   nomes hardcoded):
   - Confiança abaixo de `_LOW_CONFIDENCE_THRESHOLD` (0,5) limpa o campo; `generic_inference`/
     `no_evidence` têm um TETO de confiança (`_GENERIC_INFERENCE_CONFIDENCE_CAP`, 0,4) independente
     do que o modelo alegar.
   - Um campo fechado que bate EXATAMENTE com "todo o catálogo" ou "o catálogo inteiro menos o
     recomendado" é tratado como mecânico (sem sinal discriminativo por construção) e só sobrevive
     com uma base não-genérica E confiança ≥ 0,9 (`_FULL_CATALOG_OVERRIDE_CONFIDENCE`) — um produto
     cujo texto diz "só para X" ainda consegue passar; uma lista reflexiva não.
   - A confiança agregada final é recomputada como o MÍNIMO entre o número global do modelo e a
     confiança de cada campo que sobreviveu — nunca mais o número bruto do modelo.

`field_sources`/`field_confidence` do `ProductSemanticContext` (proveniência PÓS-aprovação,
manual/enrichment — Fase F.2.A) continuam **intocados e semanticamente separados**: a evidência que
motivou uma PROPOSTA nunca é confundida com a proveniência de um valor já aprovado. `field_notes`
(free-form, já não-versionado no contrato de `EnrichmentProposal`) ganhou uma chave `confidence` a
mais por campo, e `source` agora vem do `field_basis` real reportado (`openai_vision`/`openai_text`/
`openai_inference`), nunca mais um valor único replicado.

### Prova de generalização (não hardcoded às palavras dos 3 casos)

`test_given_a_completely_unseen_catalog_then_the_same_structural_checks_apply_unmodified` troca
`_PERSON_ROLE_VALUES` por um vocabulário esportivo hipotético (`coach`/`teammate`/`rival`/`sponsor` —
nada que apareça em qualquer lugar do código de produção) e confirma que a MESMA regra estrutural
pega o complemento mecânico. Um segundo teste
(`test_given_an_explicit_high_confidence_non_generic_override_then_a_full_roster_exclusion_survives`)
prova que uma exclusão EXPLÍCITA (basis não-genérica, confiança ≥ 0,9) sobrevive — o gate não é cego,
é estrutural.

### Tabela antes/depois — os 3 casos reais como fixtures de regressão (nunca golden)

Os 3 objetos "ANTES" são os reais do piloto (prompt_version 1, F.2.B) — nenhum deles foi alterado.
Os "DEPOIS" são uma **simulação do pipeline NOVO** sobre uma reconstrução plausível de
`field_confidence`/`field_basis` (consistente com as próprias justificativas que o modelo real
escreveu — ex.: Caso 2 admite "não há informações suficientes" no texto) — **nunca uma nova chamada
OpenAI**, que este round não fez. Testados em
`apps/creative-generator/creative_core/tests/test_enrichment_openai.py` (`test_given_case1/2/3_reconstructed_*`).

**Caso 1 — Brincar com Meu Pai**

| Campo | Antes | Depois | Motivo |
|---|---|---|---|
| `wearer_roles` | `[child]` | `[child]` (mantido) | evidenciado por nome/descrição |
| `relationship_themes` | `[father_child]` | `[father_child]` (mantido) | idem |
| `recommended_supporting_roles` | `[father]` | `[father]` (mantido) | idem |
| `incompatible_auto_supporting_roles` | `[mother, sibling, grandparent, partner, friend]` | `[]` **limpo** | complemento mecânico do catálogo, base `generic_inference` |
| `scene_intents` | `[play, bond, family, everyday]` | `[play, bond, family, everyday]` (mantido) | confiança 0,7 — acima do piso, mas já não infla o agregado |
| `confidence` (agregado) | **1** | **0,7** | min(global, confiança dos campos sobreviventes) |

**Caso 2 — Camiseta Listrada Azul**

| Campo | Antes | Depois | Motivo |
|---|---|---|---|
| `wearer_roles` | `[adult, child, teen]` | `[]` **limpo** | sem metadado de tamanho/idade — `generic_inference`, confiança 0,3 |
| `scene_intents` | `[everyday]` | `[]` **limpo** | fallback genérico do vocabulário, sem sinal próprio |
| `relationship_themes` / `recommended_supporting_roles` | `[]` | `[]` (abstenção já correta, preservada) | — |
| `confidence` (agregado) | **0,5** | **0,0** | nenhum campo sobreviveu |

**Caso 3 — Feito à Mão**

| Campo | Antes | Depois | Motivo |
|---|---|---|---|
| `visible_text` | `[FEITO A MAO]` | `[FEITO A MAO]` (mantido) | lido de verdade na imagem — `observed_reference_image`, confiança 0,95 |
| `relationship_themes` | `[family, friends]` | `[]` **limpo** | não decorre do texto lido — `generic_inference` |
| `recommended_supporting_roles` | `[father, mother, sibling, grandparent, partner, friend]` (catálogo inteiro) | `[]` **limpo** | roster completo sem sinal próprio |
| `scene_intents` | `[everyday, gift, outing]` | `[]` **limpo** | idem |
| `wearer_roles` | `[adult, child, teen]` | `[]` **limpo** | idem |
| `confidence` (agregado) | **1** | **0,95** | só `visible_text` sobrevive — o agregado passa a refletir SÓ o que tem evidência real |

**Nenhum caso negativo virou golden incorreto**: os 3 objetos originais continuam válidos como
`ProductSemanticContext` histórico (compatibilidade retroativa testada em
`test_given_the_historical_pilot_json_shape_then_it_still_validates_as_a_stored_contract_object`),
mas nenhum teste afirma que os valores extrapolados do piloto real são o resultado ESPERADO do
pipeline atual — o contrário: cada teste de regressão afirma explicitamente que eles são limpos.

### Contratos e goldens

`_request_schema()` é privada, não faz parte do `CONTRACTS` exportado/versionado — sua mudança não
exige bump de `EnrichmentProposal.schema_version` (continua 1; verificado por teste). Só
`provider_meta.prompt_version` (→ 2) e `provider_meta.schema_version` — o da REQUISIÇÃO OpenAI, não o
do objeto armazenado — mudaram, marcando esta geração de propostas como distinta da do piloto real.
`field_notes` já era free-form (`O()` no contrato) — a chave `confidence` nova não exige versionamento.

`enrichment.py` não é importado por `planner_v2.py`/`composition.py`/`compiler.py` (só por
`service.py`) — os 546 goldens V1 (prompt/plan) não têm nenhum caminho de código compartilhado com
esta mudança; confirmado verde na suíte completa do core (ver §5).

**Testes novos**: 13 em `test_enrichment_openai.py` (37 no total do arquivo, todos verdes) — gates
estruturais, generalização a catálogo não visto, override explícito, e os 3 casos reconstruídos.

---

## 3. Revisão humana — exclusões não podem ser invisíveis

Auditado `EnrichmentReview.tsx`: o contrato tem 6 campos mescláveis
(`wearer_roles`/`relationship_themes`/`recommended_supporting_roles`/
`incompatible_auto_supporting_roles`/`scene_intents`/`visible_text`), mas o resumo de aprovação
rápida ("Aprovar sugestão") só mencionava 2–3 deles (tema/interação) — `incompatible_auto_supporting_roles`
nunca aparecia na tela antes de um clique único aceitar TODOS os campos populados, exclusão incluída.

**Correção** (lógica extraída para `src/pages/criativos/enrichmentReviewFields.mjs` — módulo puro,
sem JSX, importado pelo componente E testado diretamente por `node:test`, já que este repositório não
tem harness de teste de componente React):

- **Caminho rápido ("Aprovar sugestão")**: `camposPositivos()` — todo campo populado, EXCETO
  `incompatible_auto_supporting_roles`. A exclusão nunca é aplicada por um clique sem revisão. Se ela
  estiver populada, um `Callout` (tom warning) mostra seus valores reais e explica que só "Ajustar"
  aplica.
- **Modo "Ajustar"**: todos os 6 campos aparecem como checkbox (nada escondido), mas
  `incompatible_auto_supporting_roles` começa **desmarcado** por padrão — precisa de opt-in explícito
  depois de ver os papéis reais.
- **Resumo da tela**: passou de duas linhas terse (tema + interação) para uma lista campo-a-campo de
  TUDO que "Aprovar sugestão" vai aplicar — nada que o clique aceita fica fora da tela.

`acceptedFields` sempre corresponde exatamente ao que foi mostrado: no caminho rápido, `camposPositivos()`
(nunca a exclusão); no Ajustar, o `Set` real dos checkboxes marcados.

**Testes** (10 casos, `test/creative-enrichment-review-fields.test.js`): aprovação total nunca inclui
a exclusão; estado inicial do Ajustar tem a exclusão desmarcada mas visível; outros campos continuam
pré-marcados; casos 2/3 do piloto (sem exclusão populada) não inventam nada. Persistência/rejeição/
approved-parcial já cobertas em `creative-enrichment.test.js` (camada de rota, inalterada por este
ajuste de UI). Nenhum produto real foi alterado nesta rodada — todos os testes usam stores/cores
falsos.

`tsconfig.app.json` ganhou `allowJs: true` (sem `checkJs`) — necessário só para o TypeScript resolver
o import do módulo `.mjs` compartilhado; `npx tsc -b --noEmit` e `npx vite build` confirmados verdes
depois da mudança.

---

## 4. Orçamento e durabilidade

### Reconciliação do ledger (três números, três perguntas)

O relatório da F.2.B tinha uma inconsistência literal (um zero de diferença: "US$ 0,00006 × 3" numa
seção, "US$ 0,0006" noutra) e conflava dois conceitos diferentes sob "quanto foi usado do teto".
Corrigido diretamente em `docs/features/creative-generator-fase-f2b.md` (§3 e §5), com uma nova seção
dedicada e testes (`test/custos-precos.test.js`, 5 casos novos):

| # | O que é | Valor real desta rodada | Unidade |
|---|---|---|---|
| 1 | Custo real medido (`custoEnrichmentReal`, via `usage`) | US$ 0,00126825 (3 chamadas) | USD, precisão total |
| 2 | Reserva conservadora pré-chamada (`custoEnrichmentPiorCaso`, fixo) | US$ 0,0006 × 3 = US$ 0,0018 | USD |
| 3 | Contabilização no ledger (o que o Postgres realmente compara, `centavosDeUsd`) | 1 centavo/tentativa × 3 = 3 centavos | **centavos inteiros** |

Teto: US$ 0,05 = 5 centavos na mesma conversão. **Duas percentagens diferentes, nenhuma errada**:
2,5% do teto em USD (custo real) contra **60% do teto em centavos** (o que efetivamente restringe
quantas chamadas futuras cabem) — a leitura que importa para "quão perto do limite" é a segunda, não
a primeira, por causa do piso de 1 centavo em custos sub-centavo como os deste modelo.

### Durabilidade: OpenAI cobra, `store.createProposal` falha

**Antes desta fase**: o attempt do piloto era finalizado como `succeeded` (com custo real) ANTES de
`store.createProposal` rodar. Se a gravação local falhasse depois, o erro propagava como um 500
genérico e a tentativa ficava permanentemente `succeeded`, sem NENHUMA proposta correspondente —
auditável no banco, mas invisível na resposta, e um clique seguinte no MESMO produto não era barrado
por nenhum guard específico (só pelo teto agregado de 3 chamadas/US$ 0,05, que já conta qualquer
tentativa).

**Correção pequena, sem redesenho de jobs** (`routes/criativos.js`): `store.createProposal` agora roda
ANTES da finalização do attempt.
- Sucesso → finaliza como `succeeded`, como antes.
- Falha → finaliza como `failed`, mas **ainda com o custo real e o modelo gravados** (o schema da
  migration 0038 já suporta custo real num attempt `failed` — nenhuma migração nova) e
  `error_code: 'proposal_persist_failed'`, um sentinel distinto de qualquer falha do lado da OpenAI
  (greppable no ledger). A resposta HTTP também muda: `500` com
  `code: ENRICHMENT_PROPOSAL_PERSIST_FAILED` e o `attemptId`, em vez de um 500 genérico — o operador
  vê, sem adivinhar, que houve cobrança real sem proposta.

**O que isto fecha**: o attempt nunca mais fica preso em `reserved` esperando TTL por este motivo; o
custo real nunca é perdido; a falha é imediatamente identificável e correlacionável a uma tentativa
específica.

**O que isto NÃO fecha, documentado com teste**: um clique seguinte no MESMO produto, depois dessa
falha, AINDA pode disparar uma segunda chamada real (o `attempt` `failed` não bloqueia uma nova
`reservar` — só um `attempt` em `status='reserved'` bloqueia, por desenho da migration 0038). A
proteção real contra um LOOP de cobranças acidentais continua sendo o teto agregado de 3
chamadas/US$ 0,05 do piloto inteiro (já testado, real, atômico) — não um bloqueio específico deste
caso. Um fechamento completo exigiria correlacionar `attempts` ↔ `proposals` (uma coluna nova +
lookup, ou um "stash" do payload já pago para permitir recuperação sem nova chamada) — avaliado e
deliberadamente adiado por exceder "mudança pequena, sem redesenhar o sistema de jobs"; fica como
risco conhecido de rollout (ver §7).

Cobertura: 2 testes novos em `creative-enrichment.test.js` (falha de persistência preserva custo
real + errorCode distinto; segunda tentativa depois da falha ainda é possível dentro do teto — prova
do limite documentado, não um bug novo). Suíte de concorrência real contra Postgres
(`creative-enrichment-pg.test.js`, 5 testes) confirmada verde sem alteração depois do reorder.

---

## 5. Gate integrado — suíte completa

**Não declaro a suíte completa 100% verde num único disparo — o motivo é bem diagnosticado abaixo,
com evidência, e não é ambiental nem tem relação com o código desta fase.**

### Core (Python) — verde, 386/386

Rodado em ambiente sem nenhuma outra sessão ativa: `python3 run_tests.py` (19/19 suítes OK, 334
casos) + `python3 -m pytest creative_core/tests/test_enrichment.py creative_core/tests/test_enrichment_openai.py`
(52/52, o par que `run_tests.py` não consegue rodar como script standalone — mesma dualidade de
invocação já documentada em F.2.A/F.2.B, não uma escolha desta fase). **386/386, 0 falhas.** 546
goldens V1 (`test_prompt_v1_golden.py`) confirmados byte-idênticos; `enrichment.py` não é importado
por nenhum módulo do caminho de prompt/plano (só por `service.py`), então essa confirmação é
estrutural, não coincidência.

### Painel (Node) — 3 execuções, container próprio, zero outra sessão ativa

Confirmado ANTES de cada execução (`ps aux` + `docker ps`) que nenhuma outra sessão deste usuário
tinha processo `node --test`/`test-db.mjs` nem container ativo.

**1. Disparo único de tudo** (`TEST_PG_CONTAINER=oria-f2b1-verify-<ts>`, `test/*.test.js
test/invariants/*.test.js`, começo 2026-09-24T00:15Z, fim 2026-09-24T00:36Z — 21 minutos):

```
ℹ tests 841
ℹ pass 807
ℹ fail 0
ℹ cancelled 34
ℹ duration_ms 1201727 (≈ 20 min)

✖ test/invariants/negative-controls.test.js (949884ms ≈ 15,8 min) — 'Promise resolution is still
  pending but the event loop has already resolved'
✖ + 33 arquivos seguintes na fila, todos com o MESMO erro — nenhum chegou a rodar de verdade
```

Zero falha de asserção (`fail 0`) — o que existe é UM arquivo (`negative-controls.test.js`) que o
processo `node --test` abortou aos ~15,8 min, derrubando em cascata os 33 arquivos ainda na fila
(nunca executados, não "reprovados" — o runner nem chegou a tentar).

**2. `negative-controls.test.js` sozinho, container próprio, mesmo comando** (começo 00:37:59Z, fim
01:19:14Z — **41 minutos**):

```
ℹ tests 120
ℹ pass 120
ℹ fail 0
ℹ cancelled 0
ℹ duration_ms 2469287 (≈ 41,15 min)
```

**120/120 passam.** A causa fica clara: o arquivo é genuinamente lento (41 min de verdade — muitos
dos 120 ciclos "passa → viola → FALHA → restaura → passa" sobem um servidor completo em subprocesso,
alguns levando 30–110s cada) — não travado, não quebrado. No disparo único, ele só tinha alcançado
~15,8 min (menos de 40% do tempo que precisa) quando ALGO externo ao próprio arquivo abortou o
processo `node --test` inteiro. Consistente com um limite de recursos do processo Node (handles,
memória, file descriptors acumulados por ~800 testes já executados antes deste no MESMO processo) —
não com uma falha de lógica de negócio do arquivo, e não com contenção de outra sessão (verificado
limpo nas duas execuções).

**3. Os 33 arquivos cancelados, em lote, container próprio** (começo 04:22:49Z, fim 04:29:57Z — 7
minutos):

```
ℹ tests 465
ℹ pass 465
ℹ fail 0
ℹ cancelled 0
ℹ duration_ms 395955 (≈ 6,6 min)
```

**465/465 passam.**

### Resultado agregado, com evidência completa

| Execução | Tests | Pass | Fail | Cancelled |
|---|---|---|---|---|
| Disparo único (até o abort) | 841 | 807 | 0 | 34 (arquivos) |
| `negative-controls.test.js` isolado | 120 | 120 | 0 | 0 |
| 33 arquivos cancelados, em lote | 465 | 465 | 0 | 0 |
| **Total com evidência real de execução** | **1392*** | **1392** | **0** | **0** |

\* Os 807 do disparo único já incluem TODOS os testes deste round de Product Enrichment/F.2.B.1
(`test_enrichment_openai.py` não conta aqui — é Python, contado à parte acima —, mas
`creative-enrichment*.test.js`, `custos-precos.test.js` e `creative-enrichment-review-fields.test.js`
do painel sim, todos verdes, confirmados nas linhas 5262–5353 do log do disparo único).

**Todo teste que existe neste repositório, quando de fato chega a rodar, passa — zero falha de
asserção em lugar nenhum.** O que impede declarar "1 disparo, 100% verde" é uma limitação de
harness/isolamento (um processo `node --test` monolítico não sobrevive aos ~62 minutos totais que a
suíte completa, com `negative-controls.test.js` em sua forma atual, de fato precisa) — não uma
regressão desta fase nem de nenhuma outra. O próprio time já reconheceu isto: existe, numa branch
irmã (`feature/clientes-rfm`, não mesclada aqui), uma versão já fatiada de
`negative-controls.test.js` (`negative-controls-fatia-1..4.test.js` +
`negative-controls-cobertura.test.js`) — evidência de que o problema já era conhecido antes desta
fase. Não portei essa divisão para este worktree: é uma mudança de código de um subsistema não
relacionado (teste de invariantes gerais, nada de Product Enrichment) e fora do escopo autorizado
desta rodada ("sem alterar código de negócio de subsistemas não relacionados sem prova" — aqui a
prova aponta para um problema de HARNESS, já em correção alhures, não para algo que esta fase deva
tocar).

**Logs completos preservados**: `/tmp/f2b1-panel-suite-full.log` (415 KB, disparo único),
`/tmp/f2b1-negative-controls-isolated.log` (345 KB), `/tmp/f2b1-cancelados-rerun.log` (365 KB) — os
três às datas/horas UTC citadas acima.

---

## 6. Entregáveis

- Diff local nesta branch (`feature/creative-fase-c`), 8 arquivos modificados + 2 novos, sem push/merge/deploy.
- Tabela de avaliação por campo antes/depois dos 3 fixtures (§1–2 acima).
- Prova de que os casos negativos não viraram golden incorreto (§1–2, testes de compatibilidade
  retroativa + testes de regressão que afirmam explicitamente o oposto do valor extrapolado).
- UX de aprovação com exclusões explícitas + testes (§3).
- Reconciliação do ledger + testes de concorrência/durabilidade (§4).
- Testes completos core + painel (§5).
- 546 golden V1 confirmados byte-idênticos (nenhum caminho de código compartilhado com `enrichment.py`; suíte core verde).
- Riscos restantes (§7).

## 7. Riscos restantes para rollout

1. **Durabilidade parcial** (§4): uma falha de persistência ainda permite uma 2ª chamada real para o
   mesmo produto dentro do teto do piloto — sem loop infinito (o teto agregado protege), mas sem
   bloqueio específico. Fechar exigiria uma coluna de correlação `attempt_id` na proposta ou um
   "stash" do payload pago — escopo maior que esta rodada.
2. **Evidência por campo depende da honestidade do modelo real**: os gates estruturais (roster
   mecânico, teto de `generic_inference`) são catalog-driven e comprovadamente gerais, mas o piso de
   confiança por campo depende do modelo reportar `field_confidence`/`field_basis` de boa-fé — esta
   fase não fez nenhuma chamada real para validar isso empiricamente contra o prompt novo (proibido
   pelo escopo); a primeira validação real fica para uma futura fase explicitamente autorizada.
3. **Orçamento do piloto continua de instância única** (limite já documentado desde a F.2.B, não
   alterado aqui): atômico para múltiplas réplicas do MESMO Postgres, não para múltiplos bancos/shards.
4. **UI**: a auditoria cobriu o modal de revisão; não cobriu telas adjacentes (lista de produtos,
   indicadores agregados) que também possam resumir campos de enrichment — fora do escopo desta fase.
