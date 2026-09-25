# Gerador de Criativos — D.1.1 (gate de integração: STORE-01, replay de Custom Angle, autoridade de `definition`)

Branch `feature/creative-fase-c`, worktree `oria-creative-fase-a`. Sem push, sem merge, sem deploy, sem chamada à
OpenAI. Mockup Generator, Product Enrichment GPT, Commerce Connector, aprendizado por feedback e QA/retry automático
não foram iniciados — só os três itens abaixo, na ordem pedida.

## 1. STORE-01: diagnosticado e corrigido (não era o STORE-01)

**Conclusão em uma frase**: o gate integrado não tinha um bug em `STORE-01`, nem no conector Ink — tinha um teste
(`fase4-server-integrations.test.js`) que não dava tempo de um job de produção legítimo terminar antes de checar uma
contagem global de chamadas a provider. Corrigido no harness do teste; produção não mudou uma linha.

### O diagnóstico

A segunda suíte completa da D.1 tinha terminado 1319/1320 com `STORE-01` falhando, mas passando limpo em isolamento
duas vezes — exatamente o quadro que a rodada anterior aceitou sem prova. Reproduzir isso de verdade (não só rodar o
arquivo isolado, que dá 5/5 limpo) exigiu replicar o MECANISMO do negative control, não só o arquivo:

- `negative-controls.test.js` roda `fase4-server-integrations.test.js` como **processo filho** (`spawnSync`), até
  3× por invariant dentro de um ciclo de 5 passos, com `--test-concurrency=1` entre arquivos (não entre os testes
  de nível superior de um mesmo arquivo).
- **Achado central**: 5 invariants diferentes (`STORE-01`, `STORE-02`, `STORE-03`, `STORE-04`, `INV-12`) usam o
  **mesmo arquivo** `fase4-server-integrations.test.js`. Rodando só esses 5 ciclos (em vez da suíte de 1320 testes
  inteira) reproduziu a falha em **3 de 3 tentativas**, sempre no mesmo subteste ("tenant novo · Integrações abre
  com zero integrações: ... sem tocar provider"), mas **alternando qual invariant pegava a falha** — `STORE-02` e
  `STORE-04` na 1ª rodada, `STORE-01` na 2ª, `STORE-01` e `STORE-04` na 3ª. Isso prova que a falha nunca teve nada a
  ver com a lógica de detecção do `STORE-01` em si: é uma falha de isolamento **do arquivo compartilhado**, que
  qualquer um dos 5 podia "herdar" dependendo de quem corria por último sob carga.
- Instrumentação temporária (stack trace de baixo overhead em `inkRequisitar`, nunca commitada — revertida antes de
  qualquer commit; `git diff --stat server.js` conferido vazio) apontou a origem exata: `boot-redes-de-seguranca`
  (`server.js`), um job `agendarUmaVez('boot-redes-de-seguranca', 5000, ...)` que roda **uma única vez, 5s após o
  boot**, e chama `sincronizarControleEstoqueDaOrganizacao` + `registrarPixPendentesFaltantes` +
  `persistirCarrinhosAbandonadosDaOrganizacao` para **toda Organization ativa** — inclusive as duas Organizations de
  teste (A e B), que já têm credencial Ink gravada em `test.before()`. Esse é um job de produção **correto e
  deliberado** (o comentário original já explica por quê: evita esperar o intervalo cheio de 15 min a cada
  deploy/restart).
- O teste `fase4-server-integrations.test.js` cria um tenant novo (`ORG_C`) no meio da suíte e verifica
  `chamadasMock().length === chamadasAntes` — uma contagem **global do processo**, não escopada a `ORG_C` — para
  provar que abrir a tela de Integrações de um tenant sem nada configurado não fala com nenhum provider. Sob
  máquina rápida, os 8 subtestes anteriores terminam bem antes dos 5s do timer do boot job, e ele nunca aparece
  no meio do arquivo. Sob carga (harness do negative control, ou a suíte completa competindo por CPU/IO), os 5s
  podem cair exatamente durante esse subteste, e as chamadas do job de A/B (autenticadas com o token de A, gravado
  no subteste anterior) inflam a contagem global — 2 ou 3 chamadas a mais, dependendo de quanto do job já tinha
  rodado.

### A correção (harness do teste, produção intocada)

`test.before()` de `fase4-server-integrations.test.js` agora espera 7s (5s do timer + folga para o próprio trabalho
assíncrono do job) **depois que o servidor sobe e antes do primeiro subteste**. Como `agendarUmaVez` dispara só uma
vez, essa espera garante — de forma determinística, não por sorte de timing — que o job já terminou antes de
QUALQUER subteste rodar, então nenhum pode mais cair no meio da execução dele. `server.js` tem diff zero.

### Evidência de que a correção funciona

A mesma reprodução que falhava 3/3 (rodando só os 5 ciclos que compartilham o arquivo, via
`--test-name-pattern`, no meu container isolado `oria-test-pg-creative-a`) foi repetida **4 vezes após a correção**:
**20/20 ciclos verdes** (`STORE-01`/`STORE-02`/`STORE-03`/`STORE-04`/`INV-12`, 4 rodadas cada).

### Suíte completa após a correção

Rodada única, container isolado (`oria-test-pg-creative-a`, sem tocar processos/recursos de outra sessão),
`--test-concurrency=1`, todos os arquivos de `test/*.test.js` e `test/invariants/*.test.js`:

```
tests 1326
pass 1326
fail 0
duration_ms 3982028.550583   (≈ 66min)
```

**1326/1326, 0 falhas, uma rodada.** `STORE-01` (e os outros 4 invariants que compartilham o arquivo) passaram
limpo dentro da suíte real — não só na reprodução isolada do §1. O gate deixa de estar pendente: **rollout
liberado quanto a este ponto** (o critério do comando era "registre o gate como pendente e rollout NO-GO" apenas
se a causa continuasse sem prova — aqui há causa provada, correção aplicada e suíte completa verde).

## 2. Auditoria do limite de confiança: replay de Custom Angle em `POST /jobs`

**Conclusão**: o caminho estava inseguro exatamente como o comando temia, e foi fechado — não por excesso de cautela,
por leitura direta do código: `lib/creative-core/requests.js` aceitava um objeto `custom_angle` inteiro, vindo cru do
corpo do request, com **checagem de formato apenas** (`id` e `family` são strings) — nenhuma verificação de que
`organization_id`/`store_id` batiam com o tenant de quem chamava, nenhuma consulta ao banco, nenhum vínculo com um
plano realmente gerado. Um cliente autenticado podia enviar QUALQUER `CustomAngle` fabricado — inclusive alegando
pertencer a outra Organization/Store, com `id`/`version`/`active`/`definition` inventados — e o servidor repassava
para o core como se fosse um snapshot histórico autorizado.

### O desenho novo

Dois caminhos, nunca o objeto cru do navegador:

- **`custom_angle_id`** (já existia, sem mudança) — escolha nova: o servidor busca no banco, escopado ao tenant,
  exige `active`.
- **`custom_angle_replay_of`** (novo, substitui `custom_angle`) — reutilização histórica: o cliente manda só o
  **id do criativo original** (já gerado, já autorizado). O servidor busca esse item com `store.getItem(tenantId,
  id)` — a MESMA consulta escopada ao tenant que "Copiar dados" já usava (`WHERE tenant_id = $1 AND creative_id =
  $2`) — e lê o snapshot do **plano persistido**
  (`item.plan.angle_recommendation.custom_angle`), nunca do corpo do request. `active` não entra aqui de propósito:
  "Gerar de novo"/"Gerar variação" continuam funcionando com um ângulo já desativado, porque o snapshot é do
  momento em que ele foi usado.

Nada que o cliente manda sobre o ângulo em si (nome, family, definition, scope, version) é usado como prova de
autorização — só o id de um criativo que, por construção do `getItem`, **só resolve para algo se já pertencer ao
tenant da sessão**. Cross-tenant, adulteração de `id`/`scope`/`version`/`definition` deixam de ser canais possíveis,
não porque foram bloqueados um por um, mas porque o cliente não manda mais nenhum desses campos.

`custom_angle` (o campo antigo) foi **removido** de `INPUT_KEYS` — não existia nenhuma UI usando esse caminho ainda
(Fase D.1 construiu só o backend; grep em `src/` confirma zero referências), então não há nada de produção a
migrar. `mapDraftToForm` ("Copiar dados") agora devolve `custom_angle_preview` (só para a tela mostrar
nome/família/definição — não está na whitelist de `POST /jobs`, então postar de volta cru é rejeitado como "campo
desconhecido") e `custom_angle_replay_of` (o id que de fato volta no POST).

### Testes negativos adicionados (`test/creative-custom-angle-effect.test.js`)

| Caso | Resultado |
|---|---|
| `custom_angle_replay_of` de criativo de **outro tenant** | recusado — "não encontrado" (não confirma nem que o criativo existe) |
| `custom_angle_replay_of` inexistente | recusado — "não encontrado" |
| `custom_angle_replay_of` de criativo **sem plano** ainda | recusado — "não tem plano" |
| `custom_angle_replay_of` de criativo que **não usou** ângulo personalizado | recusado — "não usou um ângulo personalizado" |
| Objeto `custom_angle` inteiro (caminho antigo) | recusado — "campo desconhecido" (o caminho sem verificação está fechado) |
| `custom_angle_replay_of` com id em formato inválido | recusado antes de qualquer consulta |
| `custom_angle_id` **e** `custom_angle_replay_of` juntos | recusado |
| Replay legítimo, ângulo **desativado** (`active: false`) | funciona — snapshot vem do plano, não da linha viva |
| Replay legítimo via "Copiar dados" → "Gerar de novo" | funciona, `custom_angle_replay_of` correto, seed preservada |

13/13 verdes (arquivo inteiro), incluindo os testes originais de `custom_angle_id` (inalterados).

## 3. Conflito entre `definition` livre e dados estruturados da cena

**A regra de autoridade, do jeito que já era verificável no código antes desta rodada** (D.1.1 só documenta e
adiciona um aviso — não mudou nenhuma precedência):

`resolve_gaze` (`planner_v2.py`) **nunca lê `definition`** — só `custom_angle["default_gaze"]` (campo estruturado),
e com prioridade **abaixo** de `interaction` e do `gaze` explícito do usuário. `people_count`, quem veste o produto,
ação estruturada, contexto obrigatório e minor safety vêm exclusivamente de `subjects`/`interaction`/`context`/
`products` — não existe nenhum caminho de código que leia `definition.photographic_direction`/`framing`/
`visual_notes` para decidir qualquer uma dessas coisas. O texto de `definition` é compilado no prompt como
**orientação de estilo fotográfico** (`_custom_angle_direction`, `compiler.py`) — nunca reinterpretado como uma
segunda fonte de verdade.

### O aviso novo (advisory, não bloqueia, não reescreve nada)

Único ponto onde a D.1.1 acrescenta código: um aviso léxico, estreito e explicitamente best-effort, para o caso
citado no comando — `definition` falando de olhar para/longe da câmera em palavras que contradizem o `gaze`
realmente resolvido pelo plano (`planner_v2.py::_definition_gaze_hint`, chamado logo após `resolve_gaze`). Cobre
só isso: não existe verificação textual para pessoas/vestimenta/ação/contexto/fidelidade/safety porque **não existe
canal** por onde `definition` poderia influenciar essas decisões — não há o que detectar.

O aviso nunca muda `scene.gaze`, nunca toca `definition`, e é lido pela lista fixa de frases em português (dobradas
— sem acento/maiúscula) do `_GAZE_DEFINITION_HINTS`. A ordem de checagem cuida do caso de negação do próprio
exemplo do comando: "não olha para a câmera" **contém** a substring "olha para a câmera", então as frases negadas
são checadas primeiro — testado explicitamente (`test_given_the_negated_off_camera_phrase_then_it_is_read_correctly_
not_as_agreement_with_camera`).

Deliberadamente **não** é um detector geral de contradição em linguagem natural — isso seria uma falsa sensação de
segurança. Está documentado como tal no próprio código (docstring de `_definition_gaze_hint`), exatamente como o
comando pediu: "evite prometer que ela é completa e exponha a regra de autoridade no compiler".

### Compiler: sem mudança de versão

Nenhum texto/ordem de seção compilada mudou — o aviso vive em `plan["warnings"]`, não no texto do prompt. `v3`
continua o compiler atual e único; `v1`/`v2` continuam congelados. Nenhuma mudança nesta rodada exigia `v4`.

### Testes novos (`test_custom_angle.py`, core)

4 testes novos, 21/21 verdes no arquivo (17 originais + 4 novos):

- Definição diz "câmera" (CAFE), `gaze` forçado para `off_camera` → aviso emitido, `scene.gaze.mode` **inalterado**.
- Definição e `gaze` resolvido concordam → nenhum aviso.
- Definição nega ("não olha para a câmera", URBANO), `gaze` forçado para `camera` → aviso emitido com a leitura
  correta (`definition_suggests=off_camera`), prova de que a negação não é lida como concordância.
- Definição sem nenhuma palavra de olhar → nenhum aviso, para qualquer `gaze` resolvido.

## 4. Entrega

**Commits**: 3 arquivos de produção (`planner_v2.py`, `requests.js`, `draft.js`), 1 arquivo de rota
(`criativos.js`), 3 arquivos de teste (`test_custom_angle.py`,
`creative-custom-angle-effect.test.js`, `fase4-server-integrations.test.js`). Sem alteração em `server.js` (diff
zero — nenhuma lógica de produção do conector Ink mudou, porque nenhum defeito real foi demonstrado nela).

**Testes direcionados**: 21/21 (core, `test_custom_angle.py`), 322/322 (core completo,
inclui os 546 casos golden V1 via `test_prompt_v1_golden.py`), 101/101 (painel — `creative-core`,
`creative-feedback`, `creative-angles`, `creative-custom-angle-effect`, `fase4-server-integrations` standalone),
20/20 ciclos de negative control (STORE-01/02/03/04/INV-12, 4 rodadas, reprodução fiel ao harness).

**Suíte completa do painel**: 1326/1326, 0 falhas, uma rodada (ver §1).

**Retrocompatibilidade**: `v1`/`v2`/`v3` do compiler continuam byte a byte idênticos (nenhuma seção/ordem mudou);
os 546 casos golden V1 continuam verdes; planos antigos com `custom_angle` gravado no formato anterior continuam
recompiláveis (o snapshot vive no plano persistido, não no wire format de entrada — essa mudança é só em
`POST /jobs`, não no schema do `CreativePlan`).

**Status de autorização para a Fase E**: os dois pontos abertos da auditoria (replay sem verificação; conflito
`definition`/estruturado sem regra documentada) estão fechados. A UI de seleção/replay de Custom Angle pode ser
construída.
