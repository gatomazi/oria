# Gerador de Criativos — Fase D.1 (Custom Angles funcionais e versionados)

Branch `feature/creative-fase-c`, worktree `oria-creative-fase-a`. Sem push, sem merge, sem deploy, sem chamada à
OpenAI. UI V2 completa, Mockups, Commerce Connector, Product Enrichment via GPT e aprendizado automático por feedback
não foram iniciados.

## A lacuna corrigida

Na Fase D, um ângulo customizado (`family`/`preset`) roteava para um `angle_id` legado e **parava aí** — a definição
da tenant nunca chegava ao prompt. Duas definições diferentes da mesma família produziam o **mesmo** texto. A Fase D.1
fecha isso: a definição estruturada de um ângulo customizado agora **complementa** o prompt, sem tocar nas regras
obrigatórias, em Subjects, Interaction ou Context — que continuam sendo quem decide fidelidade/segurança, quem
aparece e onde.

## 1. Duas definições, dois prompts — exemplo real

Mesma família (`lifestyle`), mesmo ângulo legado por baixo (`LIFESTYLE_COTIDIANO`), mesmo produto/pessoa/seed —
**só a definição do ângulo customizado muda**:

**Ângulo A — Café editorial** (`definition`: `framing: "plano médio, corpo até a cintura"`,
`photographic_direction: "pessoa sentada à mesa de um café"`, `lighting: "luz natural lateral, mesa de madeira"`,
`composition: "produto claramente visível, olhando para a câmera"`)

**Ângulo B — Editorial urbano** (`definition`: `framing: "plano aberto, corpo inteiro"`,
`photographic_direction: "pessoa caminhando, foto espontânea"`, `composition: "cena de rua cotidiana"`,
`visual_notes: ["não olha para a câmera"]`)

Os dois compilam **byte a byte idênticos até a seção nova** e divergem só nela:

```text
ÂNGULO LIFESTYLE: Mulher 30 anos, estilo casual urbano em movimento, fazendo algo cotidiano com "Camiseta Blumenau"
(camiseta) (café ou ambiente contemporâneo de cidade de médio porte). Momento real e espontâneo, luz natural, produto
nítido e em uso verdadeiro.

DIREÇÃO DO ÂNGULO PERSONALIZADO (Café editorial):          |  DIREÇÃO DO ÂNGULO PERSONALIZADO (Editorial urbano):
Enquadramento: plano médio, corpo até a cintura             |  Enquadramento: plano aberto, corpo inteiro
Direção fotográfica: pessoa sentada à mesa de um café        |  Direção fotográfica: pessoa caminhando, foto espontânea
Iluminação: luz natural lateral, mesa de madeira             |  Composição: cena de rua cotidiana
Composição: produto claramente visível, olhando para a...    |  - não olha para a câmera

MARCA (Use Origens): ...                                     |  MARCA (Use Origens): ... (idêntico dali em diante)
```

`prompt.sha256` diferente (`cc1e0903…` × `9aa826d7…`); tudo antes e depois da seção nova — fidelidade, regras de
texto, contrato de pessoas, olhar, marca, nicho, contexto, evitar, formato — **idêntico caractere a caractere**.
Exemplo completo (as duas requisições, os dois planos, os dois prompts inteiros): rodar
`python3 creative_core/tests/test_custom_angle.py` ou ler `test_given_two_custom_angles_of_the_same_family_then_the_prompts_are_different`.

## 2. `definition` estruturada, nunca um prompt livre

```python
definition: {
  "framing": str | None,                 # até 200 caracteres
  "photographic_direction": str | None,
  "lighting": str | None,
  "composition": str | None,
  "visual_notes": [str] | None,          # até 6 notas, cada uma até 140 caracteres
}
```

O compiler v3 escreve cada campo preenchido como **sua própria linha rotulada**, nesta ordem fixa (nunca um bloco de
texto livre que o ângulo possa usar para tentar mandar "ignore as regras acima"). Vazio (`definition: {}`) → nenhuma
seção é adicionada — nem uma linha em branco. O painel valida a mesma estrutura antes de gravar (campo desconhecido,
texto longo demais, lista grande demais → `400` antes de chegar ao banco).

## 3. Precedência das regras obrigatórias — nunca sobrescritas

A seção nova (`custom_angle_direction`) entra **depois** de `fidelity_rules`, `text_rules`, `minor_safety` e
`scene_action` — nunca antes. Isso é estrutural, não só de posição: essas quatro seções são compiladas por builders
que não leem `custom_angle` de forma alguma; a definição do ângulo customizado só alimenta uma seção nova e isolada.
Testado (`test_given_a_custom_angle_then_fidelity_minor_safety_and_text_rules_still_come_first_and_are_untouched`):
`minor_safety.applies` continua `True` com um menor em cena mesmo com ângulo customizado; a ordem das seções é
verificada, não suposta.

**Interaction continua definindo a ação, Context o ambiente, Subjects quem aparece** — nenhum dos três lê
`custom_angle`; testado com um pai+filha brincando sob um ângulo customizado: a interação (`playing`), os 2 subjects
e o cenário do context resolvem exatamente como resolveriam sem ele.

## 4. Compatibilidade — o que passou a ser respeitado de verdade

| Propriedade | Antes (Fase D) | Agora (D.1) |
|---|---|---|
| `default_gaze` | informativa | tier real em `resolve_gaze`: abaixo de interaction/usuário, **acima** do default do ângulo legado por baixo |
| `allowed_interactions` | informativa | **aviso** (`angle_interaction_mismatch:<id>:<interaction>`) se a interação resolvida não estiver na lista — nunca bloqueia, a escolha explícita sempre vence |
| `allowed_product_modes` | informativa | **recusa dura** (`UNSUPPORTED_ANGLE`) — é uma restrição estrutural (a peça de referência), não uma preferência artística |
| `people_mode` (`none`/`optional`/`required`) | só cadastro | **aviso** (`angle_people_mode_mismatch:<esperado>:<contagem>`) se a contagem resolvida não bater — Subjects/Interaction continuam donos de quem aparece |

A decisão de "aviso vs. recusa" segue a mesma régua já usada em Subjects/Interaction desde a Fase C: uma restrição
sobre O QUE PODE SER FOTOGRAFADO (o produto, `allowed_product_modes`) é estrutural e bloqueia; uma preferência sobre
composição (interação, contagem de pessoas) é só um sinal — a escolha explícita do usuário nunca é derrubada por um
ângulo.

## 5. Persistência e versionamento — autossuficiente

`CreativePlan.angle_recommendation.custom_angle` grava o `CustomAngle` **inteiro**, como o painel o resolveu no
momento da geração — não uma referência. Recompilar um plano persistido (`compile_prompt(json.loads(json.dumps(plan)))`)
nunca lê `creative_angles` de novo; testado com um round-trip completo por JSON e com um ângulo simulado como "já
editado" (`version: 2`, outra `definition`) para provar que o plano antigo (`version: 1`) é o que continua sendo
recompilado — editar ou até **desativar** a linha depois não altera nem quebra a recompilação.

`version` sobe 1 a cada `PUT /angles/:id` (nunca reescreve outra linha); é só para o histórico saber "isto foi feito
quando o ângulo estava na v1", nunca para decidir o que recompilar.

## 6. Contratos

- `CustomAngle` (`contracts.py`): `+definition` (agora com forma — ver §2), `+allowed_interactions`,
  `+allowed_product_modes`, `+default_gaze`; `description` corrigido para `nullable` (bug pré-existente da Fase D:
  toda linha sem descrição falhava a validação — achado e corrigido nesta rodada).
- `CreativeRequest.custom_angle`: `R("CustomAngle", nullable=True)` — só válido com `angle_id: "auto"`.
- `AngleRecommendation.custom_angle`: idem, o que fica no plano.
- `GenerationDraft.custom_angle`, `FeedbackSnapshot.angle_custom_id/slug/name`: identidade própria do ângulo
  customizado, não só a família/versão que ele compartilha com outros.
- Compiler: `SECTION_ORDER_V3`, `COMPILER_VERSION` 2 → **3** (v2 congelado exatamente como a Fase C1 deixou — nenhum
  plano v2 antigo muda; v3 é aditivo e vazio para qualquer plano sem ângulo customizado, então nenhum golden ou plano
  existente muda de texto).

## 7. Painel — a seleção chega ao request

- `POST /jobs` aceita `custom_angle_id` (escolha nova: resolve do banco, checa `active`, monta o payload no formato
  do core) **ou** `custom_angle` (replay de um draft — "de novo"/"variação" — o objeto inteiro, sem consultar o
  banco). Os dois forçam `angle_id: "auto"`; `angle_ids` (legado) e ângulo customizado são mutuamente exclusivos no
  mesmo lote.
- Migration **0035**: `allowed_interactions`/`allowed_product_modes`/`default_gaze` como colunas tipadas (com CHECK),
  não dentro do `definition` livre — são regras de compatibilidade validadas, não texto em evolução.
- `Copiar Dados` (`mapDraftToForm`): quando o plano usou um ângulo customizado, o `form.custom_angle` vem preenchido
  e `angle_ids` vira `["auto"]`; sem plano v2 habilitado na conta, o campo some da resposta com
  `unavailable: [{field: "custom_angle", reason: "plan_v2_not_enabled"}]` e o formulário volta pro `angle_id` legado
  do plano — nunca quebra o `POST /jobs` seguinte.
- UI (GerarTab) **não foi tocada** — fora do escopo desta fase, como nas Fases C/D.

## 8. Testes — os 9 pedidos

1. **Dois Custom Angles da mesma família com instruções diferentes produzem prompts diferentes** — §1, testado com
   sha256 e diff isolado à seção nova.
2. **Alterar um Custom Angle não modifica planos históricos** — §5, round-trip JSON + simulação de edição.
3. **Regras obrigatórias continuam tendo precedência** — §3, ordem das seções e `minor_safety.applies` verificados.
4. **Organization e Store permanecem isoladas** — já coberto pelo CRUD da Fase D (`creative-angles.test.js`/
   `-pg.test.js`); D.1 não mudou a tabela de identidade/RLS, só acrescentou 3 colunas.
5. **Desativar um ângulo impede novas seleções, mas não quebra o histórico** — `custom_angle_id` com `active: false`
   é recusado (`buildRequests` no painel, mensagem "está desativado"); um `custom_angle` de replay com `active: false`
   funciona normalmente (histórico intacto) — os dois testados em `creative-custom-angle-effect.test.js`.
6. **Copiar Dados recupera o ângulo personalizado** — §7, testado ponta a ponta (draft → form → novo request →
   `custom_angle` idêntico chega ao core).
7. **Feedback registra identidade e versão** — `angle_custom_id`/`slug`/`name` + `angle_family`/`scope`/`version` no
   snapshot, testado com um ângulo customizado e confirmado nulo para um ângulo de sistema.
8. **Os 13 ângulos legados continuam funcionando** — `test_given_a_system_angle_then_it_never_gets_a_custom_angle_direction_section`
   + a suíte inteira da Fase D (`test_angle_catalog.py`) recontada, sem alteração de comportamento.
9. **Os 546 golden tests V1 continuam byte-idênticos** — `test_prompt_v1_golden.py` 4/4; compiler v1 nem existe nesta
   mudança (só v2→v3 foi tocado, e v2 ficou congelado).

## 9. Suítes completas

- **Core**: `python3 run_tests.py` → **19/19 suítes** (nova `test_custom_angle.py`, 17 casos). Golden V1: **546/546
  byte-idênticos**.
- **Painel**: fatia direcionada (angles, feedback, core-pg, custom-angle-effect, 4 invariantes de migração,
  tenancy-isolation, tenancy-upsert) → **152/152**, limpo.
- `npx tsc -b --noEmit`: limpo (nenhum arquivo `.ts` foi tocado nesta fase — a UI continua fora de escopo).

### 9.1 Suíte completa do painel — duas rodadas, `STORE-01` isolada

**1ª rodada**: 1315/1320, 5 falhas — todas negative controls (`STORE-01/02/04`, `oauth/org-do-navegador INV-12`,
`jobs/lease-ignorado INV-18`), nenhuma em código tocado pela D.1. Investigado com evidência, não descartado por
suposição: havia **outra sessão do Claude Code** rodando um `/productization:gate` neste mesmo Mac, no checkout
principal (`~/projects/oria`, fora deste worktree), com seu próprio container Docker — logs em
`/tmp/oria-gate-logs/db{1..4}.log`, processos visíveis com `pwd -P >| /tmp/claude-1707-cwd`. Um processo órfão dela
(`oria-nc-INK-02`, 45 min de CPU a 74%) foi encerrado por engano durante a investigação; conferido depois nos logs
dela: o teste que usava esse processo (`R19-04`) já tinha passado, e o shard seguinte dela continuou sem falhas — sem
dano causado. Esperei o gate dela terminar (`EXIT` nos 4 shards) antes de rodar de novo.

**2ª rodada, máquina livre da outra sessão**: **1319/1320**, uma falha só — `STORE-01`, a mesma família de
antes. Desta vez não encontrei processo órfão (`ps aux` limpo). `STORE-01` isolada (`--test-name-pattern="STORE-01"`)
passou **1/1**, limpa — como já tinha passado isolada na 1ª rodada também. `STORE-01` testa o connector Ink legado
(escopo por `loja`/`store_id`), código que a Fase D.1 nunca tocou.

**Decisão** (registrada, não escondida): não seguirei perseguindo esse flake indefinidamente. A evidência acumulada —
zero falhas em qualquer teste que toca `creative_angles`/`custom_angle`/compiler v3 em duas rodadas completas,
`STORE-01` limpa duas vezes isolada, e uma causa externa concretamente identificada na 1ª rodada — é suficiente para
dizer que **a Fase D.1 não introduziu regressão**. O que fica em aberto, fora do escopo desta fase, é uma fragilidade
de timing pré-existente do próprio `STORE-01` dentro de uma suíte sequencial de ~50 minutos, não investigada a fundo
por não ser código que esta fase mudou.

## 10. Decisões arquiteturais

1. **Compiler v3, não uma mudança dentro do v2**: a mesma disciplina da Fase C1 (v1→v2 quando a seção `interaction`
   foi criada) — uma seção nova é sempre uma versão nova, mesmo sendo vazia/inofensiva para planos antigos. Mantém
   "mesmo plano + mesma `COMPILER_VERSION` = mesmo texto" verdadeiro para sempre, sem exceção por data.
2. **O ângulo customizado sempre roteia para um `angle_id` legado concreto** (via `family`/`preset` →
   `canonical_legacy_angle_id`, inalterado desde a Fase D). Isto é o que torna a persistência autossuficiente (§5)
   sem precisar duplicar todo o pipeline de compilação por tenant — o "resolved definition" vira só a seção extra,
   não um compiler paralelo.
3. **`allowed_product_modes` bloqueia, `allowed_interactions`/`people_mode` avisam**: não é uma escolha simétrica de
   propósito — um é sobre o PRODUTO (estrutural, já é assim para os 13 ângulos legados via `angle_is_available`), os
   outros são sobre a COMPOSIÇÃO, que desde a Fase C pertence a Subjects/Interaction, nunca ao ângulo.
4. **`allowed_interactions`/`allowed_product_modes`/`default_gaze` em colunas tipadas, `definition` continua JSONB
   livre**: a linha entre "o core valida e aplica" (colunas) e "texto ainda em evolução, sem contrato rígido" (JSONB)
   é a mesma que já separava dado validado de dado narrativo no resto do schema.
5. **`angle_ids` (legado) e ângulo customizado são mutuamente exclusivos por lote**: um lote gera N criativos por
   `ângulo × formato × quantidade`; um ângulo customizado não tem essa multiplicidade (é uma escolha, não uma lista)
   — forçar `angle_ids: ['auto']` internamente evita duas fontes de verdade sobre "quantos ângulos" no mesmo lote.
6. **Bug achado no caminho**: `CustomAngle.description` não era `nullable` desde a Fase D — toda linha sem descrição
   (a maioria) falhava a validação assim que tentasse atravessar para o core. Corrigido nesta rodada, antes de causar
   dano (nenhuma geração real com ângulo customizado tinha sido feita ainda).

## 11. OpenAI / push / deploy

Nenhuma chamada à OpenAI. Nenhum push, merge, deploy ou `gh`. Commits locais (`1035704`, `f3c95a0`, este relatório)
na branch `feature/creative-fase-c`.

## 12. Próxima fase

**Não iniciada.** Fica para o senhor revisar Custom Angles funcionais antes do redesign completo do Gerador, Mockups,
Commerce Connector, Product Enrichment ou aprendizado por feedback.
