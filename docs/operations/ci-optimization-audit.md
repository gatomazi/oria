# Auditoria e otimização do CI (frente D, rodada 21)

Objetivo: reduzir o tempo de feedback sem reduzir cobertura de segurança. Nada aqui remove teste,
pula RLS, pula migrations, pula dry-run ou pula controle negativo. O que muda é **não rodar duas
vezes o que não depende da role do Postgres**, **paralelizar com isolamento** e **rodar o que o diff
afeta**, movendo a verificação completa para main/nightly/sob demanda.

Convenção deste documento:

- **MEDIDO** — número observado (API pública do GitHub Actions ou execução local nesta máquina).
- **ESTIMADO** — projeção declarada, com a base do cálculo à vista.
- **NOT VERIFIED** — não foi possível verificar nesta rodada.

## 1. Método e limites

| item | como foi obtido |
|---|---|
| tempos de job/etapa do CI | API REST pública do GitHub (`/actions/runs`, `/actions/runs/{id}/jobs`), 5 runs de 2026-09-17/18 — **MEDIDO** |
| logs de job (duração por teste em CI) | **NOT VERIFIED** — o endpoint de logs exige admin (`403 Must have admin rights`); `gh` não foi usado porque a conta ativa no `gh auth status` é a corporativa |
| duração por arquivo de teste | execução local arquivo a arquivo, macOS arm64, Node 26.7.0, 2026-09-18 — **MEDIDO** (local, não CI) |
| suíte completa do painel local | **não executada por decisão** (duas outras frentes trabalham na mesma árvore); nenhum número deste documento depende dela |
| Postgres para medir | container exclusivo `oria-ci-audit-pg`, derrubado ao final — nenhuma suíte de outra frente foi tocada |

Runner do GitHub (`ubuntu-latest`) é tipicamente **1,5–2× mais lento** que esta máquina; onde o
documento projeta tempo de CI a partir de medição local, o fator está declarado.

## 2. Timeline atual do CI — MEDIDO

Cinco runs recentes (workflow `CI`, todos em `main`):

| run | wall time do run | painel (Node) | control plane | whatsapp | criativos | contratos |
|---|---|---|---|---|---|---|
| 35387660663 | ~36 min | **2150 s** | 160 s | 53 s | 13 s | 7 s |
| 35357725760 | ~34 min | **2032 s** | 160 s | 50 s | 13 s | 6 s |
| 35348439293 | ~30 min | **1819 s** | 131 s | 47 s | 20 s | 7 s |
| 35306781980 | ~25 min | **1484 s** | 128 s | 46 s | 16 s | 7 s |
| 35298433340 | ~31 min | **1840 s** | 128 s | 50 s | 12 s | 6 s |

O run inteiro dura o que dura o job `painel (Node)`: os outros quatro jobs terminam em ≤ 3 min.

### 2.1 Tempo por etapa dentro do job `painel` — MEDIDO (run 35387660663)

| etapa | tempo | depende de banco | precisa de `oria_app` | paralelizável |
|---|---|---|---|---|
| Set up job + Initialize containers | 13 s | — | — | — |
| checkout + setup-node + setup-go | 3 s | — | — | — |
| `npm ci --ignore-scripts` | 7 s | não | não | — |
| migrations do zero | 1 s | sim | não | sim (job próprio) |
| migrations idempotentes | 1 s | sim | não | sim (job próprio) |
| **suíte do painel** | **1057 s** | parcial | não | sim (shards) |
| **suíte sob `oria_app`** | **1053 s** | parcial | parcial | sim (shards) |
| build do SPA | 12 s | não | não | sim (job próprio) |

Duas observações que decidem o resto do documento:

1. **98 % do job são as duas suítes**, e elas são a **mesma lista de arquivos** executada duas vezes;
2. `npm ci` custa 7 s: **cache de npm não é onde está o problema** (D15).

### 2.2 Control plane, Go, Python — MEDIDO

| etapa | tempo |
|---|---|
| suíte do control plane | 15–21 s |
| controles negativos do control plane | 87–112 s |
| `go vet` + `go build` + `go test -race` | 29 s |
| `pip install` + `run_tests.py` | 7–14 s |

Nenhum deles está no caminho crítico. O `pip install` ganhou `cache: pip` no workflow novo (ganho
pequeno, custo zero).

## 3. A suíte do painel, arquivo a arquivo

72 arquivos de teste: 20 em `apps/panel/test/` e 52 em `apps/panel/test/invariants/`.

### 3.1 Classificação (D3/D4) — MEDIDO por execução

`scripts/ci/suites.mjs` classifica cada arquivo por leitura do texto (abre pool, cria banco
descartável, sobe o servidor do painel, lê `*DATABASE_URL`) e a classificação foi **conferida
executando cada arquivo sem banco**: quem precisa de Postgres reprova alto (o harness lança sem
`INVARIANTS_DATABASE_URL`), nunca se pula.

| classe (D3) | arquivos | observação |
|---|---|---|
| C — puro/unitário, não toca banco | **26** | rodam sem Postgres; `test/` quase inteiro + invariants estáticos |
| D/E — integração com banco, tenancy e RLS | **46** | inclui os que sobem o servidor do painel |
| A — precisa mesmo rodar sob `oria_app` | subconjunto dos 46 | ver §4 |
| B — independe da role do banco | os 26 puros + os 5 arquivos de fixture SQL que usam a URL dona por declaração (`test/invariants/app-role-suite.test.js`) | — |

Uma exceção declarada: `test/invariants/negative-controls.test.js` é classificado como `db` por
decisão explícita — ele não abre conexão, mas **executa outros invariants** contra uma cópia
defeituosa do `lib/`, e esses filhos precisam de banco (medido: reprova em 66 s sem Postgres).

### 3.2 Onde está o tempo — MEDIDO (local)

| arquivo | tempo local | grupo |
|---|---|---|
| `test/invariants/productization-gate.test.js` | **213 s** | sem banco |
| `test/invariants/negative-controls.test.js` | ~66 s (reprovando sem banco; com banco é maior) | com banco |
| `test/invariants/fase5c-e2e-whatsapp.test.js` | 18,2 s | com banco (+ `go build`) |
| `test/invariants/migrations.test.js` | 17,5 s | com banco |
| `test/invariants/tenancy-db-negative-controls.test.js` | 17,2 s | com banco |
| `test/invariants/tenancy-isolation.test.js` | 9,4 s | com banco |
| `test/invariants/convite-aceite.test.js` | 9,3 s | com banco |
| `test/invariants/release-preflight.test.js` | 4,5 s | com banco |
| os outros 25 arquivos sem banco, **juntos, num processo** | **9,5 s** (313 testes) | sem banco |

Os tempos do grupo `db` incluem ~4–10 s de harness por invocação (subir/reaproveitar o Postgres e
aplicar migrations); rodados em lote, o custo por arquivo cai.

**O maior item isolado da suíte é `productization-gate.test.js` — e ele não toca banco.** Ele roda
`scripts/productization/gate.mjs` cerca de dez vezes em subprocessos, cada uma com `go vet`,
`go build` e `go test` num módulo Go sintético. Hoje esse custo é pago **duas vezes por run** (uma
na suíte normal, outra sob `oria_app`), sem que a role do Postgres tenha qualquer efeito sobre ele.

### 3.3 Custo estrutural do harness — FATO OBSERVADO

`test/invariants/harness.js` expõe `criarBancoDescartavel()`: o teste cria um banco novo
(`CREATE DATABASE`) e roda **todas as 24 migrations** nele, pela CLI real. 21 arquivos usam esse
recurso, alguns mais de uma vez. É correto (prova migration do zero de verdade) e é caro. Não mexi
nisso; fica registrado como o principal candidato a otimização futura (§10).

## 4. A duplicação sob `oria_app` (D3) — FATO OBSERVADO

`npm run test:app-role` roda **a lista inteira de arquivos** com `TEST_APP_ROLE=1`. O que muda entre
as duas execuções, e só isso, é o valor de `DATABASE_URL`/`TEST_DATABASE_URL`/`CREATIVE_TEST_DATABASE_URL`
(role `oria_app`, NOSUPERUSER/NOBYPASSRLS) e `DB_ENFORCE_APP_ROLE=1` (`apps/panel/scripts/test-db.mjs`).

Consequência factual: **os 26 arquivos que não abrem conexão nem sobem o servidor executam
exatamente o mesmo código nas duas rodadas** — inclusive os 213 s do gate. São ~26 % dos arquivos e,
pelo peso medido, a maior fatia do tempo duplicado.

**DECISÃO TOMADA (reversível, ver §11):** no CI de PR o grupo de banco roda **apenas sob `oria_app`**
— o modo mais estrito e o que produção usa — e o grupo sem banco roda **uma vez**. A execução com a
role dona **não desaparece**: ela roda na Verificação Completa (main, nightly, dispatch), lado a lado
com a execução sob `oria_app`. O critério "a suíte inteira verde sob `oria_app`" (OPS-14) continua
sendo cumprido a cada merge em main.

## 5. Estrutura de suítes adotada (D4/D5/D6)

```text
pure          26 arquivos, sem Postgres           2 shards
db            46 arquivos, Postgres por job       4 shards
migrations    do zero + idempotência              job próprio, Postgres próprio
spa-build     tsc -b && vite build                job próprio, sem banco
```

Sharding determinístico por **LPT (longest-processing-time)** sobre pesos medidos
(`scripts/ci/suites.mjs`): ordem estável, cada arquivo em exatamente um shard, nenhum sorteio. Pesos
só balanceiam — peso errado deixa um shard mais lento, nunca deixa um teste de fora. Arquivos ainda
não medidos individualmente usam um peso padrão declarado (10 s) até a primeira execução com
`--report`, que grava `scripts/ci/weights.json`.

Partição atual — MEDIDO (peso local somado):

| grupo | shard | arquivos | peso |
|---|---|---|---|
| pure | 1/2 | 1 (`productization-gate`) | 213 s |
| pure | 2/2 | 25 | 42 s (9,5 s reais em lote) |
| db | 1/4 | 8 | ~135 s |
| db | 2/4 | 12 | ~128 s |
| db | 3/4 | 13 | ~132 s |
| db | 4/4 | 13 | ~137 s |

`node scripts/ci/suites.mjs verify --shards 4 --pure-shards 2` prova que a união dos shards é a
suíte inteira, sem sobra e sem repetição — e roda **antes** de qualquer shard, no job `changes`.

### 5.1 Second Tenant Gate no nightly

`full-verification.yml` tem um job `second tenant gate (nightly)` que roda **só** em `schedule` e
`workflow_dispatch` (num push de main ele fica `skipped`, e o `full-gate` aceita esse `skipped` por
exceção declarada). O gate roda a suíte inteira por conta própria, mais o Go e o Gerador.

A tradução do contrato de saída é feita por `scripts/ci/gate-summary.mjs` e **preserva a semântica do
gate**:

| exit do gate | significado | job no nightly |
|---|---|---|
| 0 | CODE PASS + OPS verificados + dogfood cumprido (`OVERALL READY`) | verde |
| 1 | CODE bloqueado — check FAIL ou NOT VERIFIED | **vermelho** (é regressão de código) |
| 2 | CODE PASS, `OVERALL BLOCKED` por OPS/dogfood | **verde**, com `PRODUCTIZATION ROLLOUT = BLOCKED` em destaque no summary |
| 64 / JSON ilegível | uso inválido ou erro interno | **vermelho** (estado desconhecido não é sucesso) |

O summary publica CODE, OPS (verificados/total, com os pendentes nomeados), DOGFOOD e OVERALL,
derivados dos campos reais do JSON do gate (`codeStatus`, `ops[]`, `dogfood.status`, `overall`,
`bloqueios[]`) — nada é inferido nem reescrito. Para gate de release/rollout a régua é outra:
`--strict` exige `OVERALL READY` e reprova no exit 2.

#### Prova no Actions — MEDIDO

O `full-verification.yml` rodou de verdade numa branch descartável (run 35397175247), onde **só o
gatilho** diferia do workflow final. Resultado: **17 jobs, todos verdes**, incluindo os **8 shards de
banco nas duas roles** (`owner` e `app`) e o job do gate.

O gate saiu com **exit 2** e o job ficou **verde**, com o summary abrindo assim:

```
PRODUCTIZATION
CODE: PASS
ROLLOUT: BLOCKED
```

e, abaixo, `CODE PASS · OPS 2/36 verificados · DOGFOOD NOT STARTED · OVERALL BLOCKED`, mais a lista
nominal dos OPS pendentes — tudo vindo do JSON do gate. É exatamente o contrato: pendência
operacional não vira regressão de código, e rollout bloqueado não vira silêncio.

Tempos: job do gate **1049 s** (ele roda a suíte inteira por conta própria), wall do
`full-verification` **1063 s**; sem o gate, os outros 16 jobs fecham em **704 s**.

### 5.2 Suítes que não foram shardadas (D7)

- `migrations do zero` + `migrations idempotentes`: job próprio, sequencial, Postgres próprio.
- `negative-controls` global e o dry-run de release (`r19-runbook-dry-run`, `release-preflight`,
  contratos de RELEASE B com snapshots legados): continuam íntegros dentro do grupo `db`, cada um
  inteiro em um único shard. Nenhum deles foi dividido por dentro.

## 6. Isolamento de Postgres por shard (D18/D23) — INVARIANTE

Regra escrita no topo dos dois workflows e imposta pelo runner:

> Cada job que roda testes de banco declara o **seu** `services: postgres`. Dois shards nunca
> dividem o mesmo banco/container.

- **Em CI**: `services:` é por job — a plataforma garante o isolamento.
- **Local**: `scripts/ci/panel-suite.mjs` deriva o nome do container do grupo/shard
  (`oria-test-pg-db-2` ≠ `oria-test-pg-db-3`), então duas execuções paralelas não se atropelam. Quem
  passa `TEST_DATABASE_URL` à mão assume a responsabilidade.
- Dentro de um shard, `--test-concurrency=1` continua: **nada** roda em paralelo contra o mesmo
  banco. É a regra que nasceu das 28 falhas falsas.

## 7. CI afetado por paths (D8/D9/D14)

Um workflow principal com um job `changes` (nada de vários workflows com `paths:`), e o mapa vive em
`scripts/ci/changes.mjs`, derivado do repositório real:

| diff toca | liga |
|---|---|
| `apps/panel/**` | panel (pure, db, migrations, build) |
| `apps/panel/migrations/**`, `lib/platform/{tenancy-manifest,app-role,integrations}`, `lib/secrets`, `scripts/{tenancy,tenant1}/`, `server.js` | panel **+ verificação ampliada** (`panel_full`) **+ control plane** (o schema dele mora nas migrations do painel) |
| `apps/platform-admin/**` | control plane |
| `apps/creative-generator/**` | criativos **+ panel** (`creative-core.test.js` e `inv-22` exercitam o gerador) |
| `services/whatsapp/**` | whatsapp **+ panel** (`fase5c-e2e` compila o binário Go) |
| `contracts/**` | contratos **+ panel + whatsapp** (os dois consumidores reais das cópias) |
| `docs/**` | panel (a suíte lê runbook, `tenant-owned-tables.md`, `invite-acceptance.md`) + contratos |
| `scripts/**`, `package.json` da raiz, `.github/**`, qualquer caminho desconhecido | **tudo** |

Regra de projeto: **na dúvida, rodar**. Base de diff ausente ou inválida (push direto, clone raso)
liga tudo. Um filtro que erra para menos transforma verde em silêncio.

## 8. `ci-gate` (D10)

Job final `ci-gate`, que é o check a exigir na branch protection:

- job **pulado por não ser afetado** → passa;
- job **falhou, foi cancelado ou não rodou por dependência** → **reprova**;
- `changes` que não conclua → reprova (sem ele, não houve filtro).

Na Verificação Completa o agregado é `full-gate`, e lá **nada pode ser pulado**.

## 9. Antes e depois

### Antes — MEDIDO

| | |
|---|---|
| wall time do run | 25–36 min (mediana ~31 min) |
| caminho crítico | job único `painel`, sequencial |
| suíte duplicada | sim: 1057 s + 1053 s no run 35387660663 |
| primeiro sinal de falha da suíte | só depois de ~18 min (a suíte normal inteira) |
| build do SPA | depois de ~35 min de teste |
| jobs condicionais | nenhum: tudo roda sempre |
| cancelamento de run superado | não configurado |

### Depois — MEDIDO (PR #1, runs 35394926454 e 35394886466)

O pipeline novo rodou de verdade: uma vez pelo evento `push` da branch e outra pelo `pull_request`
do PR #1. Os dois terminaram **verdes**, com `0 skipped · 0 todo · 0 cancelled` em todos os shards.

| job | run `pull_request` | run `push` |
|---|---|---|
| `o que o diff afeta` | 8 s | 8 s |
| `contratos cross-service` | 6 s | 9 s |
| `painel · sem banco 1/2` (só o gate de productização) | 218 s | 219 s |
| `painel · sem banco 2/2` (25 arquivos, 313 testes) | 19 s | 18 s |
| `painel · banco 1/4` (contém `negative-controls`) | **680 s** | **739 s** |
| `painel · banco 2/4` | 105 s | 99 s |
| `painel · banco 3/4` | 96 s | 108 s |
| `painel · banco 4/4` | 103 s | 99 s |
| `painel · migrations do zero e idempotentes` | 31 s | 33 s |
| `painel · build do SPA` | 24 s | 29 s |
| `control plane (Oria Admin)` | 159 s | 164 s |
| `gerador de criativos (Python)` | 13 s | 13 s |
| `serviço de whatsapp (Go)` | 59 s | 52 s |
| `ci-gate` | 3 s | 3 s |
| **wall time do run** | **702 s (11 min 42 s)** | **767 s (12 min 47 s)** |

Contra os 25–36 min medidos no pipeline antigo: **~3× mais rápido** num diff que liga **tudo**
(este PR mexe em `scripts/**` e `package.json`, então nenhum job foi pulado — o caso mais caro).

### 9.1 Como o time trabalha hoje muda quem recebe o ganho — FATO OBSERVADO

Os 18 runs existentes do workflow são **todos em `main`**: o trabalho vai direto para a branch
principal, sem PR. Com a divisão adotada isso significa:

- **hoje (push em `main`)**: passa a rodar a **Verificação Completa** — ESTIMADO ~12–14 min de wall
  (o mesmo shard `db 1/4` domina, agora nas duas roles), contra 25–36 min medidos, porque o que era
  um job sequencial vira ~18 jobs paralelos com as duas roles preservadas;
- **o CI rápido, MEDIDO em 11 min 42 s no PR #1** (caso mais caro, com todos os jobs ligados), só
  entra em cena quando o trabalho passar a vir por branch/PR. A infraestrutura já está pronta; a
  mudança de hábito é humana, não técnica.

### 9.2 O gargalo mudou de lugar — MEDIDO

A duplicação sob `oria_app` deixou de ser o problema. O caminho crítico agora é **um arquivo**:
`test/invariants/negative-controls.test.js`, dentro do shard `db 1/4`, que sozinho leva o shard a
680–739 s enquanto os outros três fecham em 96–108 s. Era invisível antes, diluído nos 1057 s da
suíte.

Consequência prática: sem esse arquivo, o wall time do CI rápido cairia para a ordem de **~4 min**
(o próximo maior job é o gate, com 218 s). É o alvo óbvio da próxima rodada — e a rodada 21 já
previa, em D7, que os controles negativos globais ficassem em execução separada.

CPU total: ~1520 s somados nos 14 jobs do run do PR, contra ~2150 s no job único do pipeline antigo
— menos CPU **e** menos latência, porque a suíte deixou de rodar duas vezes.

## 10. Oportunidades identificadas e **não** implementadas

Registradas como recomendação factual, fora do escopo autorizado desta frente:

1. **P1 · `productization-gate.test.js` (213 s, ~35 % da suíte)** — roda `gate.mjs` ~10× em
   subprocessos, cada um com `go vet`/`go build`/`go test` num módulo sintético. Reaproveitar um
   `GOCACHE`/`GOFLAGS` entre as invocações, ou consolidar as violações num único subprocesso, deve
   derrubar o caminho crítico do CI para perto de 2 min. Mexe em teste de gate: exige decisão.
2. **P2 · `criarBancoDescartavel()`** — 21 arquivos criam banco novo e aplicam as 24 migrations. Um
   *template database* migrado uma vez por job (`CREATE DATABASE ... TEMPLATE`) preservaria o "do
   zero" com uma fração do custo. Mexe em `apps/panel/test/invariants/harness.js`.
3. **P2 · piso de testes no CI** — o piso de 945 testes (`MINIMO_DE_TESTES`) é verificado pelo gate,
   que roda `npm test` inteiro; o CI shardado prova "todo arquivo rodou" (via `suites.mjs verify`),
   mas não soma os testes dos shards. Somar e comparar com o piso fecharia o buraco.
4. **P2 · `npm ci` repetido em 8+ jobs** — 7 s cada; `actions/setup-node` com `cache: npm` e
   `cache-dependency-path` cortaria alguns segundos por job. Deliberadamente não feito agora para
   não tocar mais arquivos do que o necessário enquanto duas frentes trabalham na árvore.

## 11. Decisões, riscos e blockers

### Decisões tomadas nesta frente

| # | decisão | reversão |
|---|---|---|
| D-CI-1 | PR roda a suíte de banco **só sob `oria_app`**; as duas roles rodam em main/nightly | trocar o passo do `panel-db` no `ci.yml` |
| D-CI-2 | `main` deixa de usar `ci.yml` e passa a usar `full-verification.yml` | `branches-ignore` no `ci.yml` |
| D-CI-3 | branch protection deve passar a exigir **`ci-gate`** no lugar dos checks individuais | configuração do repositório |
| D-CI-4 | `cancel-in-progress` ligado para PR/branch, desligado para a verificação completa | bloco `concurrency` |

### Decisões em aberto (OPEN)

- **OPEN-1 — branch protection.** MEDIDO: `main` **não tem proteção nenhuma** hoje
  (`GET /branches/main/protection` → 404 "Branch not protected", `GET /rulesets` → lista vazia). Não
  existe check obrigatório a trocar; o que existe é uma proteção a **criar**, exigindo `ci-gate`.
  Enquanto não existir, nada impede um merge com CI vermelho. **Impacto: alto**, e é decisão de
  quem administra o repositório — esta frente não alterou nada.
- **OPEN-2 — 4 shards de banco é o número certo?** MEDIDO no PR #1: `db 1/4` levou 680 s e os outros
  três, 96–108 s. O desbalanceamento não se resolve com mais shards: ele é **um arquivo**
  (`negative-controls`). Mais shards só dividiriam melhor os 300 s restantes. Recomendação: manter 4
  e tratar o arquivo (job próprio, como D7 já previa), em vez de mexer no número.
- **OPEN-3 — nightly do gate.** Implementado (§5.1), mas **nunca executado**: o primeiro nightly é
  quem vai dizer se o gate sai 2 (o esperado hoje) e se o summary sai como projetado.

### Riscos

| risco | mitigação |
|---|---|
| classificação errada mandar um teste de banco para o grupo sem banco | fail-closed: o harness lança sem `INVARIANTS_DATABASE_URL`; conferido executando os 26 arquivos |
| arquivo de teste novo não entrar em nenhum shard | `suites.mjs verify` roda no job `changes` e reprova |
| filtro de paths esconder uma regressão | "na dúvida, rodar"; base inválida liga tudo; `docs/**` liga o painel |
| shards desbalanceados | LPT com pesos medidos; `--report` regenera pesos a partir de uma execução real |
| dois shards dividirem banco | `services:` por job em CI; nome de container por shard no local; `--test-concurrency=1` dentro do shard |
| `ci-gate` virar carimbo | job pulado passa, mas cancelado/falho/não-executado reprova, e `changes` é obrigatório |

### Blockers

- **BLOCKER-1 (não bloqueia o merge, bloqueia a adoção):** OPEN-1, a branch protection.
- **BLOCKER-2 — RESOLVIDO.** Os workflows rodaram de verdade: `ci.yml` em dois eventos (`push` e
  `pull_request` do PR #1), os dois verdes, com `ci-gate` fechando o run. `full-verification.yml`
  ainda **não** rodou (depende de push em `main`, nightly ou dispatch) — **NOT VERIFIED**, e o job
  do gate de productização dentro dele também.
- `actionlint` continua não instalado nesta máquina; a validação estática foi YAML + grafo de
  `needs` + `bash -n` — hoje complementada pela execução real.

## 12. Fluxo local do desenvolvedor (D19)

```bash
npm run panel:test:pure     # 26 arquivos, sem Postgres  (~10 s, fora o gate)
npm run panel:test:db       # 46 arquivos, Postgres efêmero próprio
npm run panel:test:rls      # idem, sob oria_app (o que produção usa)
npm run panel:test:shard -- --group db --shards 4 --index 2 [--app-role]
npm run ci:suites -- plan   # como a suíte está particionada, com pesos
npm run ci:changes -- --base main --head HEAD   # o que este diff liga no CI
npm test                    # verificação completa: contratos, painel, build, admin, criativos, Go
```

Durante o desenvolvimento: suíte direcionada. Antes de um commit crítico: `panel:test:rls`. Em
main/release: a Verificação Completa.

## 13. O que NÃO foi verificado

- **NOT VERIFIED** — duração por teste **dentro do CI** (logs exigem admin; `gh` não foi usado
  porque a conta ativa é a corporativa). Tudo por arquivo é medição local.
- **VERIFICADO depois da auditoria inicial** — `ci.yml` executou nos eventos `push` e
  `pull_request` (runs 35394886466 e 35394926454), ambos verdes. `full-verification.yml` continua
  **NOT VERIFIED**: só roda em `main`, nightly ou dispatch.
- **NOT VERIFIED** — `actionlint` (não instalado).
- **NOT VERIFIED** — tempo da suíte completa do painel local (não executada de propósito).
- **VERIFICADO** — nenhum teste do grupo `db` dependia de rodar depois de outro: os quatro shards
  passaram em paralelo, cada um no seu Postgres, com 0 falhas e 0 skips em duas execuções
  independentes.
- **NOT VERIFIED** — efeito do sharding sobre testes sensíveis a tempo (leases de 1 s, boot em até
  20 s). Em CI cada shard tem runner próprio, o que tende a **melhorar** — mas é previsão.

## 14. Arquivos desta frente

| arquivo | o que é |
|---|---|
| `.github/workflows/ci.yml` | CI rápido: `changes` → jobs condicionais → `ci-gate` |
| `.github/workflows/full-verification.yml` | verificação completa: main, nightly, dispatch; as duas roles |
| `scripts/ci/suites.mjs` | classificação, pesos, particionamento determinístico e `verify` |
| `scripts/ci/panel-suite.mjs` | runner de grupo/shard, com a regra de isolamento de banco |
| `scripts/ci/changes.mjs` | mapa diff → áreas afetadas |
| `scripts/ci/duration-reporter.mjs` | reporter de duração para regenerar pesos (não é gate) |
| `package.json` (raiz) | scripts locais de §12 |

Nada fora dessa lista foi tocado. Em especial: `apps/panel/server.js`, migrations, connector Ink,
registry de features e entitlements ficaram intactos.
