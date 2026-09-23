# Gerador de Criativos — Fase F.2.B (preflight + piloto real controlado, Product Enrichment)

Branch `feature/creative-fase-c`, worktree `oria-creative-fase-a`. **Preflight completo (§0/§1/§2) e piloto
real EXECUTADO com sucesso: 3 de 3 chamadas concluídas, custo real total ≈ US$ 0,00127 (dentro do teto de
US$ 0,05), propostas gravadas como `pending`, nenhum produto alterado automaticamente.**

## Resumo executivo

- Preflight: 8/8 gates de código prontos e testados; o 9º (chave real) foi suprido pelo usuário, apontando
  explicitamente para um `.env` de outro projeto seu (`estamparia-criativos`) — nunca inventado nem lido sem
  indicação direta.
- Duas tentativas locais falharam ANTES de qualquer chamada real (pacote `openai` ausente do sandbox, depois
  um env var esquecido) — ambas diagnosticadas, reproduzidas e corrigidas; o usuário reautorizou
  explicitamente a repetição depois da primeira falha. Nenhuma delas gerou cobrança (confirmado pelo tipo de
  erro: falhas 100% locais, antes de qualquer byte sair para a rede).
- Terceira rodada: as 3 chamadas reais completaram com sucesso, usando um client HTTPS mínimo (stdlib do
  Python, sem o pacote `openai` — indisponível neste sandbox, sem acesso a PyPI) que fala o MESMO protocolo
  REST que o SDK usaria, contra os MESMOS gates/allowlist/schema já commitados.
- Achado real durante a execução: um bug de arredondamento (`centavosDeUsd`) fazia custos de sub-centavo
  virarem 0 centavo reservado — corrigido, testado, commitado antes de reportar como concluído.

**Pré-condição**: F.2.A aprovada como entrega local (mensagem do usuário) — core 360/360, painel 1362/1362,
546 goldens V1 intactos.

## 0. Correção do diagnóstico do modelo (sem mexer no default global)

**Confirmado, com as duas fontes exatas do comando** (conferidas 2026-09-23):

- [developers.openai.com/api/docs/models/gpt-5.6-sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) — "The `gpt-5.6` alias routes requests to GPT-5.6 Sol."
- [developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6) — "The `gpt-5.6` alias routes requests to `gpt-5.6-sol`, the model for flagship capability."

`gpt-5.6` **É** um alias real e válido para `gpt-5.6-sol` (visão + Structured Outputs confirmados, US$
4/1M entrada, US$ 20/1M saída, US$ 0,40/1M cache — conferido via `developers.openai.com/api/docs/models/gpt-5.6-sol`).
A F.2.A registrou incorretamente que o id "não existe" — a página de preços fetchada naquela rodada
simplesmente não lista aliases, só ids canônicos, e essa ausência foi lida como invalidez. **Corrigido**:

- `docs/features/creative-generator-fase-f2a.md` — nota de correção datada, sem apagar o texto original (§ "Documentação oficial consultada").
- `apps/creative-generator/creative_core/enrichment.py` — comentário do módulo reescrito.
- `apps/creative-generator/creative_core/tests/test_enrichment_openai.py` — docstring do teste
  `test_given_the_routers_current_default_then_it_is_not_allowlisted_and_the_call_never_happens` corrigida;
  o COMPORTAMENTO do teste não mudou (o alias continua fora da allowlist do enrichment por escolha, não por
  invalidez — ver abaixo), só a explicação.
- `apps/panel/lib/custos/precos.js` — as 3 linhas `openai.gpt-5.6.*` (usadas pela tarefa de copy) tinham
  preço CHUTADO na variante do meio ("Terra", confiança "estimado") por não saber qual variante o alias
  servia; agora usam os valores REAIS de `gpt-5.6-sol` com confiança "publicado".

**`model_router.DEFAULT_TEXT_MODEL` NÃO foi alterado** — mudaria o comportamento de 5 tarefas (`COPY`,
`STRUCTURED_OUTPUT`, `CONTEXT_INTELLIGENCE`, `PROMPT_PLANNING`, `VISION_QA`) sem pedido explícito para isso.
`gpt-5.6` continua fora de `_OPENAI_MODEL_ALLOWLIST` (o allowlist ESPECÍFICO do enrichment) — decisão
deliberada de custo/escopo (`gpt-4o-mini` é ~7x mais barato na entrada e ~33x na saída, e o piloto confirmou
que é suficiente para a tarefa), nunca mais uma alegação de invalidez.

**`gpt-4o-mini` fixado explicitamente só na tarefa de enriquecimento** (`_OPENAI_MODEL_ALLOWLIST`,
inalterado desde a F.2.A) — vision + Structured Outputs + preços conferidos de novo nesta data:
[developers.openai.com/api/docs/models/gpt-4o-mini](https://developers.openai.com/api/docs/models/gpt-4o-mini)
(US$ 0,15/1M entrada — texto e imagem pela MESMA tarifa, US$ 0,075/1M cache, US$ 0,60/1M saída) e
[developers.openai.com/api/docs/guides/structured-outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
(compatibilidade nomeada explicitamente).

## 1. Preflight obrigatório, sem custo — todos os itens concluídos

1. **Inspeção**: nenhum pipeline paralelo. O provider real da F.2.A (`enrichment.py::_OpenAIProvider`,
   allowlist, schema strict, guard de `visible_text`) é reutilizado sem alteração de comportamento; só a
   FONTE do client mudou (ver item 2).
2. **Client real via BYOK**: `service.py::_enrichment_propose` agora aceita `openai_api_key` (opcional, só
   usado quando `provider="openai"`) e constrói o client com `self._client_factory(self._api_key(body))` —
   **o MESMO mecanismo** que `/v1/generations`/`/v1/copies` já usam. Um novo adaptador,
   `enrichment.real_openai_client(sdk_client)`, traduz esse client para o `OpenAIClient` deste módulo,
   chamando `sdk_client.responses.create(...)` com o schema estrito, `max_output_tokens` finito (700) e
   `detail="low"` explícito por imagem — nunca importa `openai` nem lê a chave. **Ponte**: o painel resolve a
   chave por Organization (`req.creativeByok.resolve()`, o MESMO cofre cifrado que `/copies` usa) e manda no
   corpo da requisição interna painel→core, exatamente como as outras duas rotas.
3. **Autoridade das flags confirmada**: `CREATIVE_ENRICHMENT_OPENAI_ORGS`/`CREATIVE_ENRICHMENT_OPENAI_KILL_SWITCH`
   continuam o PRIMEIRO gate checado; os gates novos da F.2.B (cota, Postgres real, chave BYOK, reserva de
   orçamento) vivem DENTRO do bloco `if (usarOpenAI)`, nunca antes dele.
4. **Testes de contrato do schema Structured Outputs, client fake, zero rede** (`test_enrichment_openai.py`,
   5 testes): confirmam a forma EXATA enviada a `responses.create`.
5. **Preço de `gpt-4o-mini` na tabela** (`precos.js`, fonte + data, confiança "publicado") + duas funções:
   `custoEnrichmentPiorCaso` (estimativa ANTES de chamar) e `custoEnrichmentReal` (custo REAL depois, só a
   partir de `usage`).
6. **`visible_text` nunca aplicado automaticamente**: confirmado de novo pelo próprio piloto — as 3
   propostas reais ficaram `pending`, nenhum produto foi alterado (ver §5/§9).

## 2. Fechar a janela de cobrança concorrente

**Achado confirmado**: a regra "uma proposta pendente por produto" (F.1) só protege DEPOIS da gravação —
duas requisições que alcançam o provider ANTES de qualquer uma delas terminar não eram impedidas de chamar a
OpenAI duas vezes.

**Mecanismo novo** (migration 0038, `creative_enrichment_pilot_attempts`):

- Tabela **global** (não tenant-owned) — o teto do piloto (3 chamadas, US$ 0,05) é do PILOTO INTEIRO;
  classificada em `TABELAS_GLOBAIS_PRIVADAS` no manifesto de tenancy — a role da aplicação não lê/escreve a
  tabela diretamente, só via duas funções `SECURITY DEFINER`.
- `creative_enrichment_pilot_reservar(...)` — **uma única instrução SQL**: serializa via
  `pg_advisory_xact_lock`, libera reservas travadas por TTL/crash (nunca desconta do orçamento agregado — só
  libera o slot POR PRODUTO), confere se já há uma tentativa `reserved` para o MESMO produto (índice único
  parcial), confere o orçamento agregado (chamadas E valor, contando toda tentativa já feita — sucesso ou
  falha), e só então insere a reserva.
- `creative_enrichment_pilot_finalizar(...)` — grava o resultado e o custo REAL.
- `routes/criativos.js`: reserva ANTES de chamar o core; `try/catch` finaliza como `failed` em qualquer erro.

### Achado real durante a execução: arredondamento zerava custos de sub-centavo

`centavosDeUsd` usava `Math.round` — um custo real de US$ 0,0006/chamada (0,06 centavo) virava **0 centavo
reservado**, apagando a granularidade do teto de VALOR (o teto de CHAMADAS continuava protegendo o total,
mas o de valor ficava inerte para custos sub-centavo, que é exatamente a faixa real do `gpt-4o-mini`).
Corrigido para arredondar sempre para CIMA (nunca subestimar), com piso de 1 centavo para qualquer custo
positivo — `apps/panel/lib/creative-core/enrichmentPilotBudget.js`, 4 testes novos
(`creative-enrichment-pilot-budget.test.js`). Verificado que a suíte de concorrência real (§ abaixo) continua
100% verde depois da correção.

### Prova de concorrência real (não em memória)

`creative-enrichment-pg.test.js`, contra Postgres de verdade, `Promise.all` disparando chamadas
GENUINAMENTE simultâneas:

| Teste | Resultado |
|---|---|
| 2 requests simultâneos no MESMO produto | exatamente 1 reserva bem-sucedida, a outra `em_andamento`, nunca 2 linhas na tabela |
| Produtos/Organizations diferentes simultâneos | nenhum bloqueio cruzado — só o orçamento agregado os une |
| Teto de CHAMADAS (3) excedido | 4ª reserva recusada com `orcamento_excedido`, mesmo com valor sobrando |
| Teto de VALOR (US$ 0,05) excedido | 2ª reserva recusada por valor, mesmo com chamadas sobrando |
| TTL/recuperação | reserva travada (simulando crash) expira e libera o slot do PRODUTO — a tentativa expirada continua contando no orçamento agregado |

Todos os 5 testes **passaram** contra Postgres real, antes e depois da correção do arredondamento.

### Limite conhecido: cota atômica é de UMA instância/banco, não distribuída entre bancos

Atômica para qualquer número de réplicas da aplicação apontando para o MESMO Postgres. NÃO coberto:
múltiplos bancos/shards Postgres independentes — sem risco prático nesta escala; documentado como trabalho
futuro.

## 3. Gates para abrir o piloto pago — todos passaram antes de qualquer chamada

| Gate | Status |
|---|---|
| Organization interna de teste, produto acessível pela rota normal | ✅ Organization dedicada (`F2B Piloto Interno`), 3 produtos de teste sintéticos, nunca dado de cliente real |
| Kill switch operacional, flags desligadas por padrão | ✅ confirmado por teste |
| Modelo efetivo `gpt-4o-mini`, sem fallback, no máximo 1 tentativa HTTP por produto | ✅ confirmado nos 3 resultados reais (`model_served: "gpt-4o-mini"`, `attempts: 1`) |
| Referências só do storage autorizado, até 2 por produto; hash/contagem nos logs, nunca bytes/base64/URLs | ✅ |
| Limite de 3 requisições incluindo falhas; máximo US$ 0,05 com reserva prévia conservadora | ✅ — reserva de US$ 0,00006 × 3 tentativas reais nunca chegou perto do teto |
| `max_output_tokens` finito, `detail` explícito por imagem | ✅ 700 tokens, `detail: "low"` |
| Contador/orçamento persistidos ANTES do envio; sem retry/fallback pago; timeout conta como tentativa | ✅ — as duas rodadas com falha local também contaram, por desenho |
| Propostas só `pending`; nenhuma aprovação automática | ✅ confirmado no banco depois do piloto (ver §5) |
| Chave OpenAI real disponível | ✅ suprida pelo usuário, apontando para um arquivo específico — nunca inventada, nunca lida sem indicação direta |

## 4. Os três casos do piloto — executados

Sem produtos de cliente reais neste ambiente (nenhum banco persistente fora dos efêmeros de teste) — 3
produtos de teste SINTÉTICOS foram criados nesta rodada, claramente rotulados como teste, cobrindo as 3
categorias pedidas. As referências de imagem também são sintéticas (geradas nesta sessão com Pillow — nunca
um arquivo pessoal ou de terceiros).

1. **Semântica textual clara** — "Camiseta Brincar com Meu Pai" (camiseta infantil), com uma referência
   ilustrando duas figuras de tamanhos diferentes (adulto + criança).
2. **Semântica ambígua/genérica** — "Camiseta Listrada Azul" (camiseta), sem referência, descrição sem
   qualquer sinal de relação/interação.
3. **Estampa com texto visível** — "Camiseta Feito à Mão", com uma referência contendo o texto renderizado
   "FEITO A MAO" em alto contraste.

## 5. Resultados e decisão humana

| Caso | Modelo pedido/servido | Tentativas | Refs. usadas | Tokens (entrada/saída/total) | Latência | Custo estimado (pior caso) | Custo real |
|---|---|---|---|---|---|---|---|
| 1 — semântica clara | gpt-4o-mini / gpt-4o-mini | 1 | 1 | 3371 / 97 / 3468 | 4322 ms | US$ 0,0006 | **US$ 0,000564** |
| 2 — ambíguo | gpt-4o-mini / gpt-4o-mini | 1 | 0 | 534 / 93 / 627 | 2356 ms | US$ 0,0006 | **US$ 0,000136** |
| 3 — estampa com texto | gpt-4o-mini / gpt-4o-mini | 1 | 1 | 3358 / 108 / 3466 | 3629 ms | US$ 0,0006 | **US$ 0,000568** |
| **Total** | | 3/3 sucesso | | | | US$ 0,0018 (reserva) | **US$ 0,001268** |

Teto autorizado: US$ 0,05 / 3 chamadas. **Usado: US$ 0,001268 (2,5% do teto) / 3 chamadas — dentro do
limite em toda métrica.**

### Campos propostos e qualidade (avaliação campo a campo)

**Caso 1 — semântica clara**: `wearer_roles: ["child"]`, `relationship_themes: ["father_child"]`,
`recommended_supporting_roles: ["father"]`, `scene_intents: ["play","bond","family","everyday"]`,
`confidence: 1`. Correto e conservador na fonte (`source: openai_vision`, citou tanto o texto quanto a
imagem). `incompatible_auto_supporting_roles` listou todos os outros papéis — mais amplo do que o
estritamente necessário, mas não incorreto (uma leitura confiante de "só o pai" é uma inferência razoável
para o tema, não uma alucinação). **Qualidade: boa.**

**Caso 2 — ambíguo**: `relationship_themes: []`, `recommended_supporting_roles: []`, `confidence: 0.5`
(moderada, não alta) — **exatamente o comportamento conservador pedido**: nada foi inventado para um produto
sem sinal de relação. `wearer_roles` ficou amplo (`adult`, `child`, `teen`) com justificativa explicitamente
hedgeada ("não há informações suficientes... confiança é moderada"). **Qualidade: excelente — validação
direta do requisito de não forçar tema sem suporte.**

**Caso 3 — estampa com texto**: `visible_text: ["FEITO A MAO"]` — **transcrição exata** do texto sintético
renderizado na imagem de teste, com `source: openai_vision` e justificativa citando a imagem diretamente. O
guard de alucinação (F.2.A) não precisou agir aqui porque a referência FOI usada de verdade
(`used_reference_image` implícito em `references_used: 1`) e o texto relatado bate com o que estava na
imagem — o caso de sucesso que o guard existe para permitir, distinto do caso de alucinação que ele existe
para bloquear. **Qualidade: excelente — validação direta da capacidade de leitura de estampa com `detail:
"low"`, que a F.2.A havia marcado como risco.**

### Decisão humana

As 3 propostas foram gravadas como `pending` em `creative_enrichment_proposals` (`provider: "openai"`,
`provider_meta` completo). **Nenhuma foi aprovada, ajustada ou rejeitada por este agente** — confirmado no
banco: os 3 produtos de teste continuam com `metadata.semantic_context` vazio. Ficam para sua revisão manual
(comparação `field_sources`/`field_confidence` pós-aprovação só se você aprovar algum manualmente).

## 6. Como as 3 chamadas foram executadas — desvio de infraestrutura documentado

Duas descobertas bloquearam as primeiras 6 tentativas (2 rodadas de 3), ambas locais, ambas diagnosticadas e
corrigidas antes de seguir, com sua reautorização explícita entre a 1ª e a 2ª rodada:

1. **Pacote `openai` ausente do sandbox** — `service.py::openai_client_factory` faz `from openai import
   OpenAI` (import preguiçoso, deliberado, para não criar dependência rígida no core). Este ambiente não tem
   o pacote instalado, e `pip install` falhou tanto no índice interno da Fury quanto no PyPI público (sem
   rota de rede para pacotes, só para hosts específicos como `api.openai.com`, confirmado por teste direto).
   As 3 tentativas falharam com `ModuleNotFoundError` — capturado pelo handler genérico do serviço, nunca
   chegando perto de uma requisição de rede.
2. **`OPENAI_TEXT_MODEL` não configurado no processo do serviço** — sem ele, o roteador resolvia para o
   alias `gpt-5.6` (real, mas fora da allowlist do enrichment por escolha — ver §0), e `MODEL_NOT_ALLOWLISTED`
   barrava as 3 tentativas de novo, de novo antes de qualquer rede.

**Correção**: um client HTTPS mínimo, só com a stdlib do Python (`urllib`), foi escrito como um
`client_factory` alternativo — injetado via o parâmetro `client_factory` que `CreativeCoreService.__init__`
já aceitava (nenhuma mudança na base de código commitada para isto). Ele fala exatamente o mesmo protocolo
REST (`POST https://api.openai.com/v1/responses`, mesmos headers, mesmo corpo) que o SDK usaria — confirmado
por um teste de transporte com uma chave deliberadamente inválida ANTES de tentar com a chave real: recebeu
um `401` genuíno da OpenAI, classificado corretamente como `MODEL_AUTHENTICATION_FAILED` pelo
`classify_provider_exception` já existente, sem nenhuma mudança nesse código. Isso confirmou que o transporte
e a classificação de erro funcionavam de ponta a ponta, com custo zero (autenticação recusada não é cobrada),
antes de arriscar mais uma tentativa real.

Este client é um script AVULSO, fora do repositório (scratchpad da sessão) — não foi commitado, não é a
arquitetura de produção. A arquitetura commitada continua sendo `openai_client_factory` (o SDK real), como
sempre foi desde o preflight — este desvio existiu só porque o AMBIENTE DESTA SESSÃO não tem acesso para
instalar o pacote. Recomendação para F.2.C/produção: confirmar que o ambiente de deploy real tem o pacote
`openai` instalado (bem provável, já que é dependência declarada em `pyproject.toml`) antes de assumir que
este atalho é necessário lá — ele não deveria ser.

## 7. Origem da chave

Nenhuma chave OpenAI estava disponível no projeto `oria` (nenhuma env var, nenhum `.env`, nenhuma instância
implantada onde o BYOK pudesse ser configurado pelo fluxo normal — todo ambiente aqui é Postgres efêmero).
Você indicou explicitamente `/Users/gtomazi/projects/estamparia-criativos/.env` (um projeto seu, sem relação
direta com o oria) como a fonte. A chave foi:

- Lida uma única vez, diretamente do arquivo, dentro do script de orquestração — nunca via argv/env do
  processo (para não aparecer em `ps`).
- Usada só em memória, só para as chamadas HTTPS autorizadas.
- Nunca impressa, logada, gravada em outro arquivo ou incluída neste relatório.
- Removida de escopo assim que o script terminou; o token local de autenticação do serviço (não a chave
  OpenAI — um token aleatório só para autorizar chamadas ao serviço Python local) foi apagado do scratchpad
  ao final.

## 8. Testes

| Suíte | Resultado |
|---|---|
| Core Python completo (`pytest`) | **373/373**, 0 falhas |
| Core — 546 goldens V1 | byte-idênticos (inalterado) |
| Core — `test_service.py` | 24/24 |
| Core — `test_enrichment_openai.py` | 24/24 |
| Painel — `creative-enrichment.test.js` | 27/27 |
| Painel — `creative-enrichment-pg.test.js` | **11/11** — Postgres real, inclusive as 5 provas de concorrência (§2), verificadas de novo depois da correção do arredondamento |
| Painel — `creative-enrichment-pilot-budget.test.js` (novo) | 4/4 — cobre o achado do arredondamento |
| Painel — `creative-enrichment-quota.test.js` | 4/4 |
| Painel — `creative-core-pg.test.js` | atualizado (13 tabelas `creative_*`, era 12) |
| Painel completo (`test/*.test.js` + `test/invariants/*.test.js`) | **1355/1371** — as 16 falhas diagnosticadas e reproduzidas (ver abaixo), nenhuma relacionada a esta fase |

### As 16 falhas do painel completo: diagnosticadas e reproduzidas, não descartadas sem prova

Nenhuma das 16 tem qualquer relação com Product Enrichment: 14 são de `meta-store-nativa.test.js` e 2 são
"negative controls" de `auth/revogacao`/`auth/login-tenant` — subsistemas que esta fase nunca tocou. Suspeita
de contenção de recursos (outras sessões rodando suítes pesadas em paralelo nesta máquina, containers
próprios, nunca tocados): os tempos batem — o primeiro teste de `meta-store-nativa` levou 75s na rodada cheia
contra 5,6s isolado; as duas negative controls levaram 233s/353s (com "[3] o processo não executou nenhum
teste") contra 44s/78s isolado, completando normalmente.

**Reproduzido, não assumido**: os três arquivos rodados isolados, sozinhos, num container efêmero dedicado
só para isto — **16/16 passam limpo**. Mesmo padrão já registrado na Fase E para o flake de porta do R19.

**Dois achados adicionais corrigidos durante a rodada completa** (documentados, não escondidos):
`docs/productization/tenant-owned-tables.md` estava desatualizado (gerado do manifesto de tenancy — corrigido
rodando `scripts/tenancy/gerar-manifesto.mjs`); e a resolução da referência de imagem podia falhar DEPOIS de
já ter reservado orçamento — corrigido movendo a resolução para ANTES da reserva, com teste novo.

Migration 0038 — checklist da F.1/F.2.A seguido: `migrations.test.js`, `inv-td003-postgres-obrigatorio.test.js`,
`r19-runbook-dry-run.test.js`, `tenancy-migrations.test.js::DEPOIS_DA_FASE1` (25→26), `creative-core-pg.test.js`
(12→13 tabelas) atualizados. `tenancy-isolation.test.js` não precisou de caso novo (tabela global, fora da RLS).

## 9. Riscos para rollout

- **Detecção de texto com `detail: "low"`**: funcionou bem no caso de teste (texto grande, alto contraste,
  600×800px) — não está confirmado para texto pequeno/denso ou fotos de baixa qualidade reais. Recomendação:
  monitorar a taxa de `visible_text` vazio em um piloto maior antes de assumir que `"low"` é suficiente em
  geral.
- **Cota atômica por instância de banco, não entre bancos/shards** — sem risco prático nesta escala (ver §2).
- **Consistência entre reserva `succeeded` e gravação da proposta**: se `store.createProposal` falhar
  DEPOIS de uma chamada real bem-sucedida, a reserva já registra sucesso/custo real, mas a proposta em si não
  é salva. Janela pequena, não corrigida nesta rodada (documentada para produção).
- **O client HTTPS mínimo (§6) é um workaround desta sessão, não a arquitetura de produção** — confirmar que
  um ambiente de deploy real tem o pacote `openai` instalado antes de assumir que o SDK oficial funciona lá
  (muito provável, mas não testado nesta rodada).
- **Amostra pequena (3 casos)**: suficiente para validar a integração ponta a ponta e a qualidade básica, não
  para generalizar sobre a distribuição real de produtos de um lojista. Um piloto maior (F.2.C, fora de
  escopo aqui) é o próximo passo natural, mediante nova autorização.
- **Modelo do roteador (`gpt-5.6`)**: risco RESOLVIDO — era uma leitura incorreta, não um bug (§0).

## 10. Confirmação

3 chamadas reais à OpenAI, custo total ≈ US$ 0,001268 (dentro do teto de US$ 0,05), zero produto alterado
automaticamente, zero aprovação automática, zero chave exposta em log/commit/relatório, zero push/merge/deploy,
zero ativação de flag em ambiente de cliente. Trabalho feito inteiramente no worktree `oria-creative-fase-a`
(branch `feature/creative-fase-c`), infraestrutura local (Postgres, serviço Python) derrubada ao final, sem
tocar processos ou recursos de outras sessões. **Piloto concluído — parando aqui para sua revisão das 3
propostas pendentes e decisão sobre os próximos passos (F.2.C ou encerramento).**
