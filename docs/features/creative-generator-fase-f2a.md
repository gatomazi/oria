# Gerador de Criativos — Fase F.2.A (auditoria de proveniência + provider real, sem uso pago)

Branch `feature/creative-fase-c`, worktree `oria-creative-fase-a`. Implementação **local**, atrás de duas
flags **distintas** de rollout (`CREATIVE_ENRICHMENT_ORGS` do modal F.1 e `CREATIVE_ENRICHMENT_OPENAI_ORGS`
do provider real, mais o kill switch `CREATIVE_ENRICHMENT_OPENAI_KILL_SWITCH`) — nenhuma ativada em ambiente
real. **Zero chamada paga, zero chave OpenAI real, zero push/merge/deploy nesta rodada.** F.2.B (piloto pago),
UI V2 como substituta universal, aprendizado automático por feedback, QA/retry automático, Mockups e Commerce
Connector não foram iniciados.

**Pré-condição**: D.1.1, E e F.1 aprovadas como entregas locais (mensagem do usuário). Gate de referência da
F.1: core 334/334, painel 1347/1347, 546 goldens V1 byte-idênticos.

## 1. Auditoria de proveniência (obrigatória antes de qualquer código de provider)

**Achado: bug real confirmado**, exatamente o cenário do comando — `wearer_roles` manual (nunca aceito de
uma proposta), `relationship_themes`/`scene_intents` aceitos de uma proposta de enriquecimento parcial. Dois
reprodutores escritos ANTES de qualquer correção:

1. **Nível de merge** (`pgEnrichment.js::mergeSemanticContext`): `mesclado.source = 'enrichment'`
   incondicional sempre que QUALQUER campo é aceito — reatribui o objeto INTEIRO, inclusive campos jamais
   tocados pela proposta.
2. **Nível de plano** (`composition.py::recommend`): usava UM `origin` compartilhado, derivado do `source`
   agregado, para DUAS decisões diferentes — o primary (de `wearer_roles`) e o supporting (de
   `recommended_supporting_roles`). Com o fixture do comando, o plano gerado atribuía o primary (cujo
   casting veio do campo MANUAL) a `product_enrichment` — proveniência falsa, confirmada por teste.

### Correção — a menor evolução aditiva e versionada

`ProductSemanticContext` ganha dois campos opcionais, nullable, nunca inventados retroativamente:

```
field_sources:    { <um dos 6 campos mesclaveis>: "manual" | "enrichment" }
field_confidence: { <um dos 6 campos mesclaveis>: number }
```

- **`composition.field_origin(semantic, campo)`** — nova função central: lê `field_sources[campo]`
  primeiro; sem entrada, cai no `source` agregado (comportamento EXATO de antes da fase — nenhuma inferência
  nova para um objeto que nunca teve `field_sources`). `composition.recommend` e `composition.
  resolve_interaction` foram corrigidos para chamar isto por campo (`wearer_roles`,
  `recommended_supporting_roles`, `scene_intents` — cada decisão lê a proveniência do campo que REALMENTE a
  motivou), em vez do `source` agregado único.
- **`enrichment.merge()`/`mergeSemanticContext`** (Python e Node, mesma regra nas duas linguagens, mesmo
  padrão de pequena duplicação deliberada já documentado na F.1) — agora populam `field_sources` por campo:
  "enrichment" para os campos QUE ESTA decisão aceita; para os demais campos mesclaveis sem registro
  prévio, herdam o `source` agregado como ele estava um instante ANTES deste merge (a única evidência viva
  que a chamada está prestes a sobrescrever — não um chute sobre uma linha histórica adormecida).
- **`planner_v2._semantics_source_summary()`** — `plan["semantics_source"]`/`provenance["semantics"]` agora
  agregam a proveniência REAL por campo (via `field_origin`), retornando `contracts.MIXED_ORIGIN` ("mixed" —
  a mesma constante que `subjects`/`scene` já usam para seções compostas) quando os campos populados
  discordam, e o valor único de sempre quando concordam ou quando não há `field_sources` (fallback idêntico
  ao comportamento pré-fase).

### Compatibilidade e testes

Nenhuma inferência retroativa: um objeto sem `field_sources` produz EXATAMENTE o mesmo plano de antes
(provado por teste dedicado). Testes novos: `test_plan_v2.py` (2), `test_subjects_c1.py` (2, incluindo
`field_origin` isolada), `test_enrichment.py` (3), `creative-enrichment.test.js` (3 de `mergeSemanticContext`
+ 4 assertions extras no teste de merge parcial existente).

## 2. Contrato e provider real

Nenhum pipeline paralelo: o provider real reaproveita `enrichment.propose()`/`merge()`, o contrato
`EnrichmentProposal`/`ProductSemanticContext` (validados pelo MESMO `contracts.ensure_valid`), a rota
`/v1/enrichment/propose`, a tabela `creative_enrichment_proposals`, o modal F.1 (`EnrichmentReview.tsx`, com
indicador de origem atualizado — §5).

### Documentação oficial consultada (verificada 2026-09-23)

| Fonte | O que confirma |
|---|---|
| [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) | Forma `text.format = {type: "json_schema", strict: true, schema, name}`; strict mode exige TODO campo de `properties` em `required` e `additionalProperties: false`; suporte "a partir do GPT-4o e modelos posteriores", `gpt-6-astra` citado nominalmente |
| [Images & vision](https://developers.openai.com/api/docs/guides/images-vision) | Forma multimodal `input: [{role, content: [{type:"input_text",...}, {type:"input_image", image_url: "data:<mime>;base64,...", detail}]}]`; array de `input_image` é o jeito normal de mandar VÁRIAS referências — sem a pegadinha de `image[]` multipart (isto é corpo JSON, não multipart form — bug diferente do da Fase C); limites declarados de até 1.500 imagens/512MB por request (`_MAX_REFERENCES = 2` deste round é bem mais conservador) |
| [Pricing](https://developers.openai.com/api/docs/pricing) | **Não existe modelo literalmente "gpt-5.6"** (o `model_router.DEFAULT_TEXT_MODEL` deste repositório) — só variantes nomeadas (`gpt-5.6-sol/-terra/-luna`). `apps/panel/lib/custos/precos.js` já sinalizava essa mesma ambiguidade independentemente ("a variante efetiva não é conhecida"). GPT-6 (Astra/Sol/Luna, lançado 03/09/2026) é a família atual com visão confirmada para todos os três |

**Achado operacional**: com os defaults de hoje (`OPENAI_TEXT_MODEL` não definido, sem fallbacks), o roteador
resolve `"gpt-5.6"` para a tarefa `STRUCTURED_OUTPUT` — não é um model id real. Isto é uma lacuna PRÉ-
EXISTENTE no default COMPARTILHADO do roteador (usado por outras 4 tarefas também), não algo que esta fase
altera — mas o provider real desta fase NÃO confia nisso cegamente.

### Allowlist versionada (a "configuração/allowlist" que o comando pediu)

```python
_OPENAI_MODEL_ALLOWLIST = {
    "gpt-4o-mini": {"vision": True, "structured_outputs": True, "verified": "2026-09-23"},  # default sugerido do piloto
    "gpt-6-astra": {"vision": True, "structured_outputs": True, "verified": "2026-09-23"},  # opt-in explícito, mais caro
}
```

Um modelo resolvido pelo roteador fora desta lista é tratado como "indisponível" — o MESMO mecanismo que
`model_router.run_traced` já usa para tentar o próximo fallback (`OPENAI_TEXT_MODEL_FALLBACKS`, a "regra
explícita aprovada" do comando). Só quando TODOS os candidatos são recusados o erro
`MODEL_NOT_ALLOWLISTED` aparece. Com os defaults de hoje, isto significa: uma chamada real falharia ANTES de
qualquer requisição de rede, até alguém configurar `OPENAI_TEXT_MODEL` explicitamente para um valor
permitido — comportamento confirmado por teste (`test_given_the_routers_current_default_then_it_is_not_allowlisted_and_the_call_never_happens`).

### O que o provider real faz (`enrichment.py::_OpenAIProvider`)

- Schema de saída PRÓPRIO (não o `ProductSemanticContext` inteiro — teria `source`/`field_sources` que o
  MODELO não deve produzir): os 6 campos + `confidence` + `justification` + `used_reference_image`, todos em
  `required` (exigência do strict mode), `wearer_roles`/`recommended_supporting_roles`/
  `incompatible_auto_supporting_roles` com `enum` fechado (vocabulário REAL de `composition.DATA`, não
  inventado); `relationship_themes`/`scene_intents` como string livre com vocabulário só sugerido no prompt
  (um valor fora da lista simplesmente não casa nada a jusante — nunca um erro de validação, o mesmo
  comportamento de antes desta fase).
- **Guard contra alucinação de `visible_text`**: só é mantido quando o modelo reporta
  `used_reference_image: true` E uma referência de verdade foi de fato enviada — um modelo que afirma ter
  visto texto sem nenhuma imagem no request tem `visible_text` descartado (testado explicitamente).
- Prompt de sistema trata nome/tipo/descrição como DADOS a classificar, nunca instruções — mesma defesa
  (vocabulário fechado, nunca eco) já provada na F.1 para o provider fake, agora reforçada também na
  instrução ao modelo real.
- Erros classificados pelo mecanismo JÁ EXISTENTE (`errors.classify_provider_exception`,
  `engines.usage_from_response`) — nenhuma hierarquia de exceção nova: 401/403 → `MODEL_AUTHENTICATION_FAILED`;
  429 → `MODEL_RATE_LIMITED` (retryable); timeout/5xx → `MODEL_UNAVAILABLE` (retryable); resposta vazia/não-
  objeto → `GENERATION_FAILED`.
- Referências: `references.decode_reference()` (MESMA validação por magic bytes + teto de 10MB que
  `/v1/generations` já usa) — nunca confia no `mime` que o chamador alega, só nos bytes reais; entradas
  malformadas são excluídas em silêncio, sem derrubar a proposta inteira; cap de 2 referências (
  `_MAX_REFERENCES`), filtro ANTES do corte (uma referência ruim nunca rouba a vaga de uma boa).

### Garantia estrutural de zero chamada real nesta rodada

`_OpenAIProvider` exige um `client` injetado no construtor — nada neste código importa o pacote `openai` nem
lê a chave de API. `service.py::_enrichment_propose` **nunca constrói nem recebe um client** (a rota
deliberadamente não aceita `openai_api_key`, ao contrário de `/v1/generations`/`/v1/copies`): pedir
`provider="openai"` pela superfície HTTP real hoje **sempre** recusa com `INVALID_INPUT` ("no client
configured"), antes de qualquer coisa parecida com rede — confirmado por teste HTTP dedicado
(`test_given_provider_openai_over_http_then_it_refuses_cleanly_no_client_wired_this_round`, que também
confirma que a factory BYOK nunca é sequer tocada). O painel espelha a mesma garantia: `client.js` nunca
manda `openai_api_key` para esta rota, e mesmo com a flag `CREATIVE_ENRICHMENT_OPENAI_ORGS` ligada, uma
chamada real do core sempre falha limpo — nunca um fallback silencioso para "fake" (testado explicitamente:
uma sugestão fake nunca se apresenta como visão real).

## 3. Referências e isolamento de tenant

- Referências resolvidas do ARMAZENAMENTO já autorizado do produto (`req.creativeStorage.
  readProductReference`, tenant-scoped por `store.getProduct` antes) — o corpo da requisição do navegador
  nunca influencia qual imagem é usada; testado explicitamente injetando um `references`/`url` malicioso no
  corpo do POST (a rota nem lê esse campo).
- Duas referências testadas ponta a ponta (core e painel) — precedente da Fase C (bug de `image[]`
  multipart) explicitamente coberto; a API Responses da OpenAI usa corpo JSON com array de `input_image`,
  sem essa classe de bug.
- Idempotência: a regra F.1 de uma proposta pendente por produto (já existente) cobre "não gastar de novo
  numa execução idêntica" sem código adicional — confirmado por teste de que pedir de novo com uma pendente
  nunca chama o core outra vez.
- Cota por Organization (`enrichmentQuota.js`) — em memória, por processo (não distribuída entre réplicas;
  risco remanescente documentado no §6), consultada ANTES de qualquer chamada ao core, registrada só DEPOIS
  de sucesso (uma tentativa que falha nunca consome cota).
- Credenciais: nenhuma nesta rota, em nenhum round-trip (nem painel, nem core) — não há o que vazar.

## 4. Custos, observabilidade e controle operacional

- **Flags distintas** (exigência explícita): `CREATIVE_ENRICHMENT_ORGS` (modal F.1, inalterada) vs.
  `CREATIVE_ENRICHMENT_OPENAI_ORGS` (provider real, Fase F.2.A, `rollout.js::enrichmentOpenAIFor`) — estar na
  lista do modal não liga o provider real.
- **Kill switch**: `CREATIVE_ENRICHMENT_OPENAI_KILL_SWITCH=1` desliga globalmente, lido ANTES da lista de
  orgs — vence mesmo com `*` configurado.
- **`provider_meta`** (migration 0037, aditiva, nullable): modelo pedido/servido, versão de
  prompt/schema, uso reportado (tokens — nunca texto), tentativas, latência, contagem de referências usadas.
  Nunca a resposta bruta, nunca bytes de imagem, nunca credencial. Sempre `null` para `provider="fake"` e,
  nesta rodada, para toda proposta (nenhuma chamada real acontece).
- **Custo estimado**: tabela existente de `apps/panel/lib/custos/precos.js` — ainda não tem linha para o
  modelo do enriquecimento (proposta: adicionar `openai.gpt-4o-mini.*` com a mesma estrutura
  entrada/saída/cache, fonte `developers.openai.com/api/docs/pricing`, confiança "publicado", data
  2026-09-23 — não fiz a edição nesta rodada por ainda não haver uso real a custear; ver §6).
- **Sem retry automático pago**: o provider faz UMA tentativa por candidato do roteador (fallback é
  "indisponível → próximo modelo", nunca "erro → repetir o mesmo modelo"); nenhum retry automático em
  nenhuma camada.
- **Indicador fake/openai**: `EnrichmentReview.tsx` agora rotula a origem de forma explícita e distinta
  ("Sugestão automática (a partir do texto do produto)" vs. "Sugestão por IA com visão da imagem"), com um
  aviso de confiança baixa quando `confidence < 0.5` — nunca um texto genérico que esconda a diferença.

## 5. Experiência do usuário

Reaproveita o modal F.1 (nenhum novo passo no fluxo comum do Gerador). A decisão de qual provider pedir é do
BACKEND (`enrichmentOpenAIFor`), nunca do navegador. Campo sem evidência continua desmarcado por padrão
(comportamento herdado, inalterado). Justificativa: o provider real produz UMA justificativa curta em
português por proposta (replicada nos campos populados, mesmo padrão do fake) — uma versão por-campo mais
granular fica como melhoria futura (mesmo gap já anotado no relatório da F.1 para o fake provider).

## 6. Gates e testes

| Suíte | Resultado |
|---|---|
| Core Python completo (`pytest`) | **360/360**, 0 falhas — 341 herdados da F.1 + 19 novos (`test_enrichment_openai.py`) |
| Core — 546 goldens V1 | **byte-idênticos**, confirmados (`test_prompt_v1_golden.py`, 4/4) |
| Core — `test_service.py` (camada HTTP) | 22/22 (6 novos para `/v1/enrichment/propose`) |
| Core — `test_plan_v2.py` / `test_subjects_c1.py` / `test_enrichment.py` | verdes, +7 testes de proveniência |
| Painel — `creative-enrichment.test.js` | 22/22 (7 novos de F.2.A: flag, referência real, kill switch, cota, recusa limpa do core, 2 referências, SSRF) |
| Painel — `creative-core.test.js` (rollout unitário) | 42/42 (+1 teste de `enrichmentOpenAIFor`) |
| Painel — `creative-enrichment-pg.test.js` (RLS/FK/Postgres real, `provider_meta` incluso) | 1/1 |
| Painel — `creative-enrichment-quota.test.js` (novo, cota isolada) | 4/4 |
| Painel completo (`test/*.test.js` + `test/invariants/*.test.js`) | **1362/1362, 0 falhas** (≈91min, uma rodada, container isolado desta sessão) |

**Nota sobre o tempo da suíte completa**: bem mais longa que o precedente da F.1 (≈44min/1347 testes) —
o ambiente estava sob contenção de recursos por causa de OUTRA sessão rodando testes em paralelo no mesmo
Docker (containers/processos de nomes/comandos diferentes dos desta sessão, nunca tocados). A primeira
tentativa de rodar a suíte completa foi interrompida sem rastro de erro (processo encerrado sem sumário —
container próprio, `oria-f2a-provenance-*`/`oria-f2a-final-*`, sempre limpo depois); a suíte foi repetida até
fechar com um resultado definitivo, nunca aceitando um resultado incompleto como "verde". O resultado final
acima é de uma rodada completa, do início ao fim, sem interrupção.

Migration nova (0037, aditiva, `provider_meta` nullable) — checklist da F.1 seguido: `migrations.test.js`,
`inv-td003-postgres-obrigatorio.test.js`, `r19-runbook-dry-run.test.js` (listas hardcoded) e
`tenancy-migrations.test.js::DEPOIS_DA_FASE1` (24→25) atualizados; `tenancy-isolation.test.js` não precisou
de caso especial novo (coluna nullable, sem CHECK de enum); `creative-core-pg.test.js` não muda (conta
TABELAS `creative_*`, não colunas — 0037 só adiciona uma coluna a uma tabela já existente).

## 7. Riscos e decisões remanescentes

- **Modelo do roteador**: o default compartilhado `model_router.DEFAULT_TEXT_MODEL = "gpt-5.6"` não é um
  model id real hoje (achado independente, confirmado também pela própria tabela de preços do painel). Isto
  afeta 5 tarefas do roteador (`COPY`, `STRUCTURED_OUTPUT`, `CONTEXT_INTELLIGENCE`, `PROMPT_PLANNING`,
  `VISION_QA`), não só o enriquecimento — corrigir o default está fora do escopo desta auditoria (mudaria
  comportamento de código já em produção sem pedido explícito), mas bloqueia QUALQUER chamada real futura
  até `OPENAI_TEXT_MODEL` ser configurado explicitamente.
- **Cota por Organization em memória, não distribuída** — uma réplica por processo, não uma cota global. Se
  a operação escalar horizontalmente antes de um limite compartilhado (banco/Redis) existir, o gasto real
  pode ultrapassar o configurado (nunca bloqueia sem motivo, mas também não impede gasto espalhado por várias
  réplicas). Sem risco PRÁTICO nesta rodada (nenhuma chamada real acontece), mas deve ser endereçado antes de
  um piloto com tráfego em mais de uma réplica.
- **Justificativa por campo**: hoje uma frase única replicada nos campos populados (mesmo padrão do fake) —
  uma versão granular por campo é possível, não fiz por ser incremento cosmético.
- **Tabela de custos** (`precos.js`) ainda sem linha para o modelo do enriquecimento — proposta registrada
  no §4, não aplicada por não haver uso real a custear ainda.
- **`field_sources`/`field_confidence`** não são expostos na UI (só a proveniência AGREGADA reflete neles
  indiretamente, via o comportamento do planner) — suficiente para a correção de proveniência do plano, mas
  uma tela de auditoria por campo é um possível trabalho futuro.

## 8. Orçamento unitário estimado (F.2.B)

Baseado no modelo sugerido do piloto (`gpt-4o-mini`, $0,15/1M tokens de entrada, $0,60/1M de saída — tabela
oficial verificada 2026-09-23): uma análise típica (nome+tipo+descrição curtos + 1 imagem de referência,
saída de ~150 tokens estruturados) fica na ordem de **US$ 0,001–0,003 por produto analisado**, dominado pelo
custo da imagem de entrada. Este número é uma ESTIMATIVA a partir da tabela pública, não uma medição real —
nenhuma chamada foi feita nesta rodada; o custo real só é conhecido depois do piloto (F.2.B), quando
`provider_meta.usage` passa a ter dados de verdade.

## 9. Protocolo de piloto controlado sugerido (F.2.B — pendente de aprovação separada)

1. 2–3 produtos de teste de classes diferentes (ex.: um com tema família claro no texto, um sem nenhum
   sinal textual, um com estampa/texto legível na foto) — escolhidos pelo usuário, não pela IA.
2. `OPENAI_TEXT_MODEL=gpt-4o-mini` explícito (fora da allowlist = recusa automática, por design).
3. `CREATIVE_ENRICHMENT_OPENAI_ORGS` só com a Organization de teste; kill switch pronto para uso imediato.
4. Uma chamada real por produto (a idempotência já impede repetição); revisão humana obrigatória de cada
   proposta antes de qualquer aprovação (fluxo já existente, inalterado).
5. Registrar `provider_meta.usage`/custo real de cada chamada e comparar com a estimativa do §8.
6. Reportar ao usuário: as 2–3 propostas, o custo real medido, qualquer falha/classificação de erro
   observada — só então decidir sobre uma rodada maior.

## 10. Confirmação

Zero chamada OpenAI, zero chave real, zero custo externo. Zero push, merge ou deploy. Trabalho feito
inteiramente no worktree `oria-creative-fase-a` (branch `feature/creative-fase-c`), sem tocar processos ou
recursos de outras sessões. **Parando antes de F.2.B, como o comando pediu — aguardando revisão e autorização
separada.**
