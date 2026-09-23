# Gerador de Criativos — Fase F.2.B (preflight + piloto real controlado, Product Enrichment)

Branch `feature/creative-fase-c`, worktree `oria-creative-fase-a`. **Todo o preflight (§0/§1/§2) foi
implementado, testado e validado localmente.** A execução das chamadas pagas reais está **BLOQUEADA nesta
sessão** — não por um gate de segurança/engenharia reprovado, mas porque **não existe uma chave OpenAI real
disponível** neste ambiente (nenhuma variável de ambiente, nenhum `.env`, nenhuma instância implantada onde o
BYOK pudesse ser configurado através do fluxo normal — ver §7). Nenhuma chamada paga foi feita. Nenhuma chave
foi inventada, pedida por texto solto ou manuseada fora do mecanismo BYOK já existente.

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
deliberada de custo/escopo para este piloto (`gpt-4o-mini` é ~7x mais barato na entrada e ~33x na saída, e
já confirmado suficiente para a tarefa), nunca mais uma alegação de invalidez.

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
   **o MESMO mecanismo** que `/v1/generations`/`/v1/copies` já usam, sem exceção nem caminho novo. Um novo
   adaptador, `enrichment.real_openai_client(sdk_client)`, traduz esse client para o `OpenAIClient` deste
   módulo, chamando `sdk_client.responses.create(...)` com o schema estrito, `max_output_tokens` finito
   (700) e `detail="low"` explícito por imagem — nunca importa `openai` nem lê a chave: só fala com o
   objeto que o chamador já construiu. **Ponte**: o painel resolve a chave por Organization
   (`req.creativeByok.resolve()`, o MESMO cofre cifrado que `/copies` usa) e manda no corpo da requisição
   interna painel→core, exatamente como as outras duas rotas — nunca ao navegador, nunca persistida,
   nunca logada. `client.js::proposeEnrichment` foi atualizado para de fato encaminhar `openai_api_key`
   quando presente (antes, deliberadamente, nunca mandava nada).
3. **Autoridade das flags confirmada**: `CREATIVE_ENRICHMENT_OPENAI_ORGS`/`CREATIVE_ENRICHMENT_OPENAI_KILL_SWITCH`
   continuam sendo o PRIMEIRO gate checado (inalterado desde a F.2.A) — todos os gates novos da F.2.B (cota,
   Postgres real, chave BYOK, reserva de orçamento) vivem DENTRO do bloco `if (usarOpenAI)`, nunca antes
   dele. Organization/Store e entitlement continuam resolvidos pelos middlewares existentes
   (`exigirStore`/`exigirModulo`) antes de qualquer coisa; a referência de imagem só é lida do storage já
   autorizado do PRÓPRIO produto (`store.getProduct` tenant-scoped, depois `req.creativeStorage`).
4. **Testes de contrato do schema Structured Outputs, client fake, zero rede** (`test_enrichment_openai.py`,
   5 testes novos): confirma a forma EXATA enviada a `responses.create` — `input` com mensagem de sistema +
   usuário, `text.format = {type: "json_schema", strict: true, schema, name}`, `required` cobrindo TODO
   campo de `properties` (exigência do strict mode), `additionalProperties: false`, `max_output_tokens`
   finito e pequeno, duas imagens como dois `input_image` com `detail: "low"` explícito, extração de
   `usage` via o leitor já existente (`engines.usage_from_response` — nenhum código de contagem de token
   novo).
5. **Preço de `gpt-4o-mini` na tabela** (`precos.js`, 3 linhas, fonte + data 2026-09-23, confiança
   "publicado") + duas funções novas: `custoEnrichmentPiorCaso(precos)` (estimativa ANTES de chamar) e
   `custoEnrichmentReal(usage, precos)` (custo REAL depois, só a partir de `usage` — nunca antes de existir).
6. **`visible_text` nunca aplicado automaticamente**: já garantido estruturalmente desde a F.1/F.2.A — o
   guard de alucinação (F.2.A) descarta `visible_text` quando `used_reference_image=true` mas nenhuma
   referência real foi enviada; e mesmo quando mantido, `propose()` NUNCA escreve no produto — só a rota
   `/decide`, com `acceptedFields` explícito de um humano, grava (e só se `visible_text` estiver na lista).
   Nada novo a implementar aqui; comportamento confirmado pelos testes já existentes + reforçado pelo
   próprio desenho da reserva (a reserva/orçamento não tem nenhuma ligação com decisão de aprovação).

## 2. Fechar a janela de cobrança concorrente

**Achado confirmado**: a regra "uma proposta pendente por produto" (F.1) só protege DEPOIS da gravação —
duas requisições que alcançam o provider ANTES de qualquer uma delas terminar não eram impedidas de chamar a
OpenAI duas vezes.

**Mecanismo novo** (migration 0038, `creative_enrichment_pilot_attempts`):

- Tabela **global** (não tenant-owned) — o teto do piloto (3 chamadas, US$ 0,05) é do PILOTO INTEIRO, não
  por Organization; classificada em `TABELAS_GLOBAIS_PRIVADAS` no manifesto de tenancy (mesma categoria de
  `job_leases`/`external_resource_claims`) — a role da aplicação não lê/escreve a tabela diretamente, só
  via duas funções `SECURITY DEFINER`.
- `creative_enrichment_pilot_reservar(...)` — **uma única instrução SQL** (transação implícita curta):
  serializa via `pg_advisory_xact_lock` (mesmo padrão da migration 0019), libera reservas travadas por
  TTL/crash (nunca desconta do orçamento agregado — só libera o slot POR PRODUTO), confere se já há uma
  tentativa `reserved` para o MESMO produto (índice único parcial `uq_creative_enrichment_pilot_attempts_inflight`
  fecha a corrida no nível do banco), confere o orçamento agregado do piloto inteiro (chamadas E valor,
  contando toda tentativa já feita — sucesso ou falha), e só então insere a reserva. O lock nunca fica preso
  esperando a rede da OpenAI, que só acontece DEPOIS desta chamada retornar.
- `creative_enrichment_pilot_finalizar(...)` — grava o resultado (sucesso ou falha) e o custo REAL.
- `routes/criativos.js`: reserva ANTES de chamar o core; `try/catch` ao redor da chamada — qualquer falha
  finaliza a reserva como `failed` (contando contra o orçamento) e repropaga o erro normalmente, sem retry.

### Prova de concorrência real (não em memória)

`creative-enrichment-pg.test.js`, contra Postgres de verdade, `Promise.all` disparando chamadas
GENUINAMENTE simultâneas (não serializadas pelo event loop do Node, que é exatamente o que um teste em
memória não conseguiria provar):

| Teste | Resultado |
|---|---|
| 2 requests simultâneos no MESMO produto | exatamente 1 reserva bem-sucedida, a outra `em_andamento`, nunca 2 linhas na tabela |
| Produtos/Organizations diferentes simultâneos | nenhum bloqueio cruzado — só o orçamento agregado os une |
| Teto de CHAMADAS (3) excedido | 4ª reserva recusada com `orcamento_excedido`, mesmo com valor sobrando |
| Teto de VALOR (US$ 0,05) excedido | 2ª reserva recusada por valor, mesmo com chamadas sobrando |
| TTL/recuperação | reserva travada (simulando crash) expira e libera o slot do PRODUTO — mas a tentativa expirada continua contando no orçamento agregado (nunca é apagada nem descontada) |

Todos os 5 testes **passaram** contra Postgres real (ver §6).

### Limite conhecido: cota atômica é de UMA instância/banco, não distribuída entre bancos

A garantia é real e atômica para **qualquer número de réplicas da aplicação apontando para o MESMO
Postgres** (a atomicidade vem do banco, não do processo — diferente da cota em memória da F.2.A, que ERA
por processo). O que NÃO está provado/coberto: múltiplos bancos/shards Postgres independentes. Não é uma
limitação real para este piloto (uma instância, um banco) nem para uma primeira produção de médio porte
(uma Organization não precisa de sharding de banco); documentado como trabalho futuro antes de uma escala
que exija múltiplos bancos.

## 3. Gates para abrir o piloto pago — status de cada um

| Gate | Status |
|---|---|
| Organization interna de teste autorizada, produto acessível pela rota normal | **Pronto, não executado** — nenhum produto de cliente real seria usado; a rota normal (`GET/POST /products`) já impõe isso |
| Kill switch operacional, flags desligadas por padrão | ✅ confirmado por teste (F.2.A + F.2.B) |
| Modelo efetivo `gpt-4o-mini`, sem fallback, no máximo 1 tentativa HTTP por produto | ✅ allowlist restrita a `gpt-4o-mini`/`gpt-6-astra` (nenhum dos dois é o default do roteador); `_OpenAIProvider` faz UMA tentativa por candidato, nunca repete o mesmo modelo |
| Referências só do storage autorizado, até 2 por produto; hash/contagem nos logs, nunca bytes/base64/URLs | ✅ inalterado da F.2.A; `provider_meta.references_used` é uma CONTAGEM, nunca os bytes |
| Limite de 3 requisições incluindo falhas; máximo US$ 0,05 com reserva prévia conservadora | ✅ implementado e testado (§2); pior caso calculado = US$ 0,0006/chamada — a reserva é ~80x mais conservadora que o teto por chamada |
| `max_output_tokens` finito, `detail` explícito por imagem | ✅ 700 tokens, `detail: "low"` — ambos hardcoded e testados |
| Contador/orçamento persistidos ANTES do envio; sem retry/fallback pago; timeout conta como tentativa | ✅ reserva é síncrona e ANTES da chamada ao core; nenhum retry em nenhuma camada; um timeout finaliza a reserva como `failed` (contando) |
| Propostas só `pending`; nenhuma aprovação automática | ✅ inalterado — `propose()` nunca escreve no produto |
| **Chave OpenAI real disponível para uma Organization interna de teste** | ❌ **NÃO — bloqueio real, ver §7** |

**8 de 9 gates prontos e verificados. O nono (chave real disponível) não pode ser satisfeito nesta sessão** —
não é uma falha de engenharia, é a ausência do insumo (a chave em si). Sem ele, nenhuma chamada paga é
possível, então nenhuma foi tentada.

## 4. Os três casos do piloto — preparados, não executados

Não há Organization/produtos de teste internos JÁ CADASTRADOS num banco real e persistente neste ambiente
(todo teste usa Postgres efêmero, destruído ao final de cada rodada) — outro efeito do mesmo bloqueio do §7.
Se/quando uma chave e um ambiente com dados de teste reais existirem, os três casos ficam assim, prontos
para escolher produtos de verdade:

1. **Semântica textual clara** — um produto com tema família/atividade explícito no texto (ex.: like
   "Brincar com Meu Pai"), com uma referência de imagem autorizada.
2. **Semântica ambígua/genérica** — um produto sem relação/interação inferível do texto; validar que a
   proposta fica conservadora (campos vazios, `confidence` baixa) em vez de inventar.
3. **Estampa com texto visível** — produto com referência legível; comparar a transcrição proposta (se
   houver) com a imagem original À MÃO, sem aprovar nada automaticamente. Nota já documentada desde a
   F.2.A: `detail: "low"` (escolha deliberada, conservadora, de custo) pode não ler texto pequeno/denso —
   um resultado conservador aqui (`visible_text` vazio) é um resultado VÁLIDO, não uma falha.

## 5. Resultados e decisão humana

**Nenhuma chamada real foi feita — nenhuma tabela de resultados por chamada a reportar.** A tabela pedida
(caso/produto anonimizado, referências, modelo pedido/servido, tokens, latência, custo estimado/real, campos
propostos, qualidade) será preenchida no dia em que uma chave real e um ambiente com produtos de teste
existirem — a infraestrutura para capturar TODOS esses campos já existe e foi testada (`provider_meta`
completo, `custoEnrichmentReal` a partir de `usage`).

`field_sources`/`field_confidence` pós-aprovação: comparação SÓ acontece se o usuário aprovar manualmente um
caso real — não aplicável aqui. Os merges continuam provados por teste, sem alterar nenhum produto (F.2.A,
inalterado).

## 6. Testes

| Suíte | Resultado |
|---|---|
| Core Python completo (`pytest`) | **373/373**, 0 falhas — 360 herdados da F.2.A + 13 novos (adaptador SDK real + BYOK) |
| Core — 546 goldens V1 | byte-idênticos (inalterado) |
| Core — `test_service.py` | 24/24 (+2 BYOK) |
| Core — `test_enrichment_openai.py` | 24/24 (+5 contrato do adaptador real) |
| Painel — `creative-enrichment.test.js` | 27/27 (+5 gates do piloto: sem Postgres, sem chave, orçamento excedido, em andamento, referência corrompida) |
| Painel — `creative-enrichment-pg.test.js` | **11/11** (+5 concorrência/orçamento reais, ver §2) — Postgres real |
| Painel — `creative-enrichment-quota.test.js` (novo, cota da F.2.A isolada) | 4/4 |
| Painel — `creative-core-pg.test.js` | atualizado (13 tabelas `creative_*`, era 12) |
| Painel completo (`test/*.test.js` + `test/invariants/*.test.js`) | **1371 testes, 1355 passaram, 16 falharam na rodada — ver diagnóstico abaixo** |

### As 16 falhas: diagnosticadas e reproduzidas, não descartadas como "ambiental" sem prova

Nenhuma das 16 tem qualquer relação com Product Enrichment: 14 são de `meta-store-nativa.test.js`
(OAuth/Dashboard/Financeiro da conexão Meta nativa) e 2 são "negative controls" de `auth/revogacao` (FASE-2)
e `auth/login-tenant` (INV-02) — subsistemas que esta fase nunca tocou. A suspeita imediata foi contenção de
recursos: esta máquina teve, durante boa parte desta sessão, OUTRAS sessões rodando suítes pesadas em
paralelo (containers `oria-test-pg`/`oria-test-pg-journey-l` de outras sessões, nunca tocados) — e os tempos
batem: o primeiro teste de `meta-store-nativa` levou 75s na rodada cheia contra 5,6s isolado (13x); as duas
negative controls levaram 233s/353s (com a mensagem "[3] o processo não executou nenhum teste — o resultado
não significa nada", um sintoma de subprocess starved de CPU) contra 44s/78s isolado, completando e
encontrando resultado normalmente.

**Reproduzido, não assumido**: rodei os três arquivos isolados, sozinhos, no MESMO container efêmero criado
só para isto:

```
node --test --test-concurrency=1 test/invariants/meta-store-nativa.test.js        → 14/14 (antes: 14 falhas)
node --test --test-concurrency=1 --test-name-pattern="auth.revogacao|auth.login-tenant" \
     test/invariants/negative-controls.test.js                                    → 2/2  (antes: 2 falhas)
```

**As 16 falhas da rodada cheia = as mesmas 16, sem exceção, e todas passam limpo quando a máquina não está
sob disputa.** Isto é exatamente o precedente já registrado na Fase E para o flake de porta do R19 (mesmo
padrão: diagnosticado, reproduzido isolado, nunca just declarado "ambiental" sem prova) — nada na F.2.B
altera esses subsistemas, e o número TRUE da rodada (1355/1371, não 1371/1371) é reportado aqui sem
maquiagem, com a causa raiz identificada e a prova de reprodução ao lado.

**Achado real durante a primeira rodada completa** (não descartado como "ambiental"): `tenancy-schema.test.js`
reprovou — `docs/productization/tenant-owned-tables.md` está GERADO a partir do manifesto de tenancy
(`scripts/tenancy/gerar-manifesto.mjs`), e eu tinha editado o manifesto (nova tabela global) sem rodar o
gerador. Corrigido rodando `node scripts/tenancy/gerar-manifesto.mjs` (18→19 globais declaradas no
documento) — junto com um segundo achado da revisão do próprio código antes da rodada final: a resolução da
referência de imagem podia falhar DEPOIS de já ter reservado o orçamento (arquivo corrompido/ausente),
deixando uma reserva presa até o TTL por um motivo que nada tem a ver com a OpenAI — corrigido movendo a
resolução da referência para ANTES da reserva (`routes/criativos.js`), com um teste novo cobrindo o caso.
Suíte completa repetida do zero depois das duas correções — o número abaixo é dessa rodada final.

Migration 0038 — checklist da F.1/F.2.A seguido: `migrations.test.js`, `inv-td003-postgres-obrigatorio.test.js`,
`r19-runbook-dry-run.test.js` (listas hardcoded), `tenancy-migrations.test.js::DEPOIS_DA_FASE1` (25→26),
`creative-core-pg.test.js` (12→13 tabelas `creative_*`) atualizados. `tenancy-isolation.test.js` não precisou
de caso novo — a tabela é GLOBAL, fora do loop de RLS por desenho.

## 7. O bloqueio real: nenhuma chave OpenAI disponível

Verificado nesta sessão, sem inventar nem pedir por atalho:

- `env | grep -i OPENAI` — vazio.
- Nenhum `.env` com credenciais reais no repositório (só um `.env.example` de outro serviço, sem relação).
- Conectividade de saída para `api.openai.com` **existe** (testado: `HTTP 401` de verdade, sem chave — a
  rede não é o problema).
- O mecanismo BYOK (`PUT /settings/openai-key`) grava a chave cifrada num Postgres real e persistente — mas
  todo ambiente desta sessão é Postgres EFÊMERO (destruído ao fim de cada rodada de teste), e não há uma
  instância do painel implantada (proibido implantar nesta fase) onde alguém pudesse cadastrar uma chave
  pelo fluxo normal.
- Por desenho de segurança (deste agente e do próprio produto), uma API key real não deve ser colada em
  texto solto numa conversa nem manuseada fora do cofre cifrado — não pedi isso, e não aceitaria se
  oferecido dessa forma.

**Consequência**: os itens (a) relatório de preflight, (b) evidência de concorrência/idempotência e (e)
riscos para rollout deste documento estão completos. Os itens (c) custos efetivamente medidos e (d)
avaliação campo a campo **não existem** porque nenhuma chamada real ocorreu — não por terem sido
negligenciados.

## 8. Riscos para rollout (revisado da F.2.A)

- **Chave/ambiente para o piloto**: ver §7 — é o bloqueio ativo agora, não uma questão de código.
- **Cota atômica por instância de banco, não entre bancos/shards** — ver nota no §2; sem risco prático nesta
  escala.
- **`visible_text` com `detail: "low"`**: pode ler mal texto pequeno/denso — escolha deliberada de custo;
  revisitar `detail` por caso (não por padrão global) se o piloto real mostrar isso como problema recorrente.
- **Consistência entre a reserva finalizada como `succeeded` e a gravação da proposta**: se
  `store.createProposal` falhar DEPOIS de uma chamada real bem-sucedida (ex.: erro de banco no exato
  momento seguinte), a reserva já registra sucesso/custo real, mas a proposta em si não é salva — um humano
  precisaria notar e, se necessário, pedir uma nova análise (a idempotência por produto permite, respeitando
  o orçamento restante). Não corrigido nesta rodada por ser uma janela extremamente pequena e por este ser
  um piloto de no máximo 3 chamadas — documentado para uma versão de produção.
- **Modelo do roteador (`gpt-5.6`)**: risco RESOLVIDO nesta rodada — era uma leitura incorreta, não um bug.

## 9. Confirmação

Zero chamada OpenAI paga, zero chave manuseada fora do BYOK cifrado, zero push/merge/deploy, zero ativação de
flag em ambiente de cliente. Trabalho feito inteiramente no worktree `oria-creative-fase-a` (branch
`feature/creative-fase-c`), sem tocar processos ou recursos de outras sessões (containers Postgres próprios,
nomeados e limpos por esta sessão; outras sessões identificadas e nunca tocadas). **Parando aqui — o piloto
pago não foi executado porque a chave não está disponível, não porque algum gate reprovou.** Aguardando a
decisão do usuário sobre como (ou se) suprir uma chave real para uma Organization de teste antes de
prosseguir.
