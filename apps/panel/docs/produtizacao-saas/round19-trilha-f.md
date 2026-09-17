# Rodada 19 — Trilha F: segredo do repasse no boot, exit code do gate, dogfood factual

17/09/2026. Worktree destacado sobre `883e157`. **Nada foi publicado.** Sem push, sem deploy, sem
Railway, sem banco de produção, sem segredo real, sem dogfood.

Temas do comando: §4 (boot fail-fast do `WHATSAPP_WEBHOOK_SECRET`), §12 (exit code do
`productization:gate`) e §13 (tracking factual do dogfood).

---

## 1. §4 — `WHATSAPP_WEBHOOK_SECRET` obrigatório no boot de produção

### 1.1 Antes

Em `server.js`, com `NODE_ENV=production` e `WHATSAPP_SERVICE_URL`, um segredo ausente ou curto
gerava só um `console.warn`. O processo subia e a rota `POST /api/webhooks/whatsapp` respondia 503 a
todo repasse do Go. Os status de campanha se perdiam e nenhum deploy abortava.

### 1.2 Agora

`lib/platform/whatsapp-forward.js` ganhou `exigirSegredoDeRepasseNoBoot(env)`. Ela usa o mesmo
critério da rota: `segredoConfigurado`, com pelo menos 32 caracteres (`TAMANHO_MINIMO_SEGREDO`).
Em `server.js`, o aviso virou fail-fast, no mesmo padrão do remetente 5b (`console.error` +
`process.exit(1)`). A mensagem diz só `ausente` ou `curto` e nunca inclui o valor.

| ambiente | segredo | resultado |
|---|---|---|
| `NODE_ENV=production` (sem diferenciar maiúsculas) | ausente, vazio ou < 32 | **exit 1, não escuta** |
| `NODE_ENV=production` | ≥ 32 | sobe |
| fora de produção (dev/test, `NODE_ENV` ausente) | qualquer | sobe; a rota continua falhando fechada (503) |

**Decisão: em produção a ausência não é aceita nem sem `WHATSAPP_SERVICE_URL`.** Motivos:

- A rota `/api/webhooks/whatsapp` é montada sempre, sem nenhuma condição. O repasse, portanto, está
  sempre ativo em produção.
- Não existe hoje um mecanismo explícito que desligue o módulo WhatsApp. Procurei `WHATSAPP_ENABLED`,
  `*_DISABLED`, flags de módulo etc. e não há nada. O único "desligado" que aparece é a entitlement
  `whatsapp` por Organization, que atua em runtime e não no boot.
- Tratar `WHATSAPP_SERVICE_URL` ausente como "módulo desligado" seria justamente a inferência que o
  comando proíbe. Existe um controle negativo para isso (ver abaixo).
- Consequência: qualquer ambiente com `NODE_ENV=production` precisa do segredo, inclusive um staging
  sem WhatsApp. Nesse caso basta um valor aleatório com ≥ 32 caracteres.

Fora de produção, a regra segue o padrão dos outros segredos de boot (`ADMIN_SESSION_SECRET` em
`lib/auth`, chaves do remetente 5b): eles só são exigidos com `NODE_ENV=production`. O "modo
explícito" que já existe é não declarar produção. A rota não aceita nada sem segredo em nenhum
ambiente (`trilha-c-whatsapp-forward.test.js`).

A verificação roda na avaliação do módulo, antes de `verificarPostgresOuMorrer()`. Por isso dois
testes antigos de `boot-exit-code.test.js`, que medem as verificações de banco em produção
("banco sem migrations" e "`DB_ENFORCE_APP_ROLE=1` com superusuário"), passaram a receber um
`WHATSAPP_WEBHOOK_SECRET` válido para chegar até elas. O motivo esperado de cada um não mudou.

### 1.3 `release:preflight`

`WHATSAPP_WEBHOOK_SECRET` passou de "exigido se houver `WHATSAPP_SERVICE_URL`" para "exigido nos
três estágios (`release-n`, `after-ops14`, `cleanup`)", continuando com o requisito de ≥ 32. Novo
teste: sem `WHATSAPP_SERVICE_URL` e sem o segredo dá BLOCK em todos os estágios; com 31 caracteres
também dá BLOCK; com o env completo dá OK.

### 1.4 Testes (processo real, `test/invariants/r19-whatsapp-webhook-secret-boot.test.js`)

O `server.js` vem de `INVARIANT_SUBJECT_ROOT`.

1. `R19-04 · regra do boot`: tabela da regra, e o motivo não carrega o valor.
2. `boot · produção sem WHATSAPP_WEBHOOK_SECRET → exit ≠ 0 e não escuta` (sem `WHATSAPP_SERVICE_URL`).
3. `boot · produção com serviço de WhatsApp e remetente, sem WHATSAPP_WEBHOOK_SECRET → exit ≠ 0`.
4. `boot · produção com WHATSAPP_WEBHOOK_SECRET curto → exit ≠ 0, sem imprimir o valor`.
5. `boot · produção com WHATSAPP_WEBHOOK_SECRET válido → sobe e escuta` (controle positivo, banco
   migrado do harness).
6. `boot · desenvolvimento declarado sem WHATSAPP_WEBHOOK_SECRET → sobe`.

Controles negativos (`negative-controls.test.js`, ciclo de 5 passos):

- `whatsapp/repasse-boot-so-avisa` (R19-04): `server.js` volta ao `console.warn` sem `exit`. Os
  testes 2, 3 e 4 reprovam, porque o processo fica vivo e escutando.
- `whatsapp/repasse-boot-inferido` (R19-04): a lib só exige o segredo quando há
  `WHATSAPP_SERVICE_URL`. O teste 1 e o teste 2 reprovam.

### 1.5 OPS proposto

A mudança pertence ao **OPS-09**. Não é um OPS novo. Texto proposto para o catálogo/plano:

> OPS-09 — `WEBHOOK_FORWARD_URL` conhecida e autenticada: `WEBHOOK_FORWARD_SECRET` (Go) =
> `WHATSAPP_WEBHOOK_SECRET` (painel), valor novo com ≥ 32 caracteres, URL sem query. **Desde a
> rodada 19, o painel em produção não sobe sem `WHATSAPP_WEBHOOK_SECRET` válido.** Configurar
> antes de qualquer deploy de painel que contenha `638f71b` (fix(boot)). Sem ele o deploy aborta e
> a versão anterior continua no ar.

Não mudei o título em `CATALOGO_OPS` (`gate-lib.mjs`). A decisão fica com o lead, se quiser
acrescentar "(boot do painel exige)".

### 1.6 Risco para o lead (ordem das releases)

- O commit que publica o fail-fast é o HEAD da productização, ou seja, a RELEASE D. O painel P2
  (`31a7cdb`, RELEASE B) **não** tem o fail-fast. Nele o segredo ainda é comparado com `?secret=`
  (código anterior à trilha C).
- O preflight roda com as ferramentas do HEAD e o estágio `release-n` serve tanto para B quanto
  para D. Ele já exigia o segredo quando havia `WHATSAPP_SERVICE_URL`, que é o caso de produção.
  Na prática nada muda para B.
- Mesmo assim, **configurar um segredo NOVO antes da RELEASE B muda o comportamento do P2**: o P2
  passa a exigir `?secret=<novo>` na URL do Go. A trilha que decide a ordem da assinatura de status
  (§5) precisa fixar em que release o valor novo entra. Esta trilha não decidiu isso.

---

## 2. §12 — exit code do `productization:gate`

### 2.1 Semântica nova

| modo | exit | quando |
|---|---|---|
| padrão (o gate) | **0** | **somente** com OVERALL READY: CODE PASS + todos os OPS VERIFIED/NOT_APPLICABLE + dogfood COMPLETED |
| padrão | 1 | CODE com qualquer FAIL ou NOT VERIFIED (OVERALL BLOCKED) |
| padrão | 2 | CODE PASS, OVERALL BLOCKED (OPS pendentes e/ou dogfood não cumprido) |
| `--report-only` | 0 | sempre que o relatório foi gerado. **Não é gate.** |
| qualquer | 64 | uso inválido, **inclusive `--code-only`** |

- **`--code-only` foi removido**, porque saía 0 com OVERALL BLOCKED. Passar essa opção agora dá
  exit 64, com uma mensagem que aponta as alternativas.
- Não mantive nenhum modo que saia 0 enquanto algo estiver bloqueado, exceto o `--report-only`.
- `--report-only` tem três marcas:
  - imprime `REPORT ONLY — ISTO NÃO É UM GATE: exit 0 aqui NÃO significa pronto…` no topo e no fim;
  - imprime `exit 0 (--report-only: informativo; o gate sairia com N)`;
  - no JSON, traz `mode: "report-only"`, `gate: false` e `gateExit`.
- O modo padrão inclui `mode: "gate"`, `gate: true`, `gateExit` e `exit` no JSON.
- Checagem só do código para o runbook: usar o gate padrão e ler o exit. **1 = pare** (código
  bloqueado). **2 = código pronto**, com o rollout ainda bloqueado; esse é o esperado antes do
  rollout. Outra opção é `--report-only --json` e o campo `codeStatus === "PASS"`.
- Documentação de uso atualizada no topo de `scripts/productization/gate.mjs`.
  `overnight-trilha-d.md` não foi editado, porque é histórico.

### 2.2 Testes e controles negativos (`productization-gate.test.js`)

- O teste antigo que esperava "`--code-only` → 0" agora espera: `--report-only` → exit 0,
  `gateExit` 2, texto "NÃO É UM GATE"; e modo gate → exit 2, sem o aviso.
- CODE bloqueado → 1. Com `--report-only`, `gateExit` = 1.
- `gate · exit 0 SOMENTE com OVERALL READY`: sete caminhos, e `exit === 0 ⇔ overall === READY` em
  todos. Os caminhos:
  1. OPS e dogfood pendentes;
  2. só OPS-27 pendente;
  3. dogfood NOT STARTED;
  4. dogfood em andamento;
  5. CODE FAIL;
  6. CODE NOT VERIFIED;
  7. tudo pronto.
- **Controles negativos de saída.** Cada um carrega uma cópia da `gate-lib.mjs` com uma mutação,
  segue o ciclo de 5 passos, e a verificação de semântica precisa reprovar:
  1. volta do `--code-only` (CODE PASS decide sozinho, exit 0 com OPS pendente);
  2. dogfood fora do overall;
  3. `soRelatorio` ligado por padrão.
- CLI: `--code-only` → 64 com a mensagem; `--report-only` → 0, com JSON `mode/gate/gateExit` e o
  aviso no texto; modo padrão na mesma cópia → 1.

---

## 3. §13 — dogfood factual

### 3.1 Formato novo do `DOGFOOD.json`

```json
{
  "format": "oria-ops-evidence/v1",
  "id": "DOGFOOD",
  "environment": "production",
  "dogfood_started_at": "2026-10-01T00:00:00Z",
  "dogfood_required_days": 14,
  "recorded_by": "nome de quem registrou o início no rollout",
  "open_incidents": 0
}
```

Regras (`avaliarDogfood(dir, { agora })`, em `gate-lib.mjs`):

| situação | status |
|---|---|
| sem `DOGFOOD.json` | NOT STARTED |
| arquivo ilegível, não-objeto, `format`/`id` errados, `environment` ≠ `production`, sem `recorded_by`, campo com cara de segredo | FAIL |
| contém `status`, `started_at`, `ended_at`, `completed_at`, `closed_at`, `days` ou `elapsed_days` (marcação manual) | FAIL |
| `dogfood_required_days` presente e ≠ 14 (inclusive `"14"` como texto) | FAIL |
| `dogfood_started_at` ausente, sem hora, sem fuso, data inexistente (ex.: 31/09) ou não-string | FAIL |
| `dogfood_started_at` no futuro em relação ao relógio | FAIL |
| `open_incidents` ausente ou diferente de inteiro ≥ 0 | FAIL |
| **OPS-14 sem evidência, inválido, NOT_APPLICABLE, ou com `verified_at` posterior a `dogfood_started_at`** | FAIL |
| dias = ⌊(agora − início) / 24 h⌋ < 14 | IN PROGRESS |
| ≥ 14 dias e `open_incidents` ≠ 0 | FAIL (o fechamento exige 0) |
| ≥ 14 dias, `open_incidents` = 0, referências válidas | COMPLETED |

- `DIAS_DE_DOGFOOD = 14` é constante do gate. O arquivo não decide quantos dias são necessários.
- **Referência factual do rollout:** `REFERENCIAS_DO_DOGFOOD = ['OPS-14']`.
  - OPS-14 é a RELEASE F, a última release do runbook atual. A evidência dele precisa ser
    `VERIFIED` (NOT_APPLICABLE não serve), válida no formato e ter `verified_at` ≤
    `dogfood_started_at`.
  - Se a ordem final do runbook colocar outra etapa com evidência própria depois do OPS-14 (ex.: a
    rotação do `ADMIN_SESSION_SECRET`, se ganhar um OPS), basta acrescentá-la a essa lista; cada
    item passa a ser exigido.
  - Não usei "o maior `verified_at` de todos os OPS". Motivo: OPS-31 é re-verificado por cliente
    depois do gate, e isso reabriria o dogfood retroativamente.
- Relógio: `consolidar({ agora })` e `avaliarDogfood(dir, { agora })`. A CLI usa o relógio do
  processo e **não aceita override** por opção ou variável de ambiente, o que seria um bypass.
- Estado real hoje: não há `docs/produtizacao-saas/ops-evidence/`. O resultado é
  **DOGFOOD NOT STARTED**.

### 3.2 Testes e controles negativos

- `gate · dogfood factual`: 30 cenários da tabela, entre eles:
  - "marcação manual COMPLETED com 1 dia real" → FAIL;
  - "declara 1 dia exigido" → FAIL, inclusive com 15 dias;
  - início no futuro, sem fuso, 31/09;
  - sem OPS-14, ou com OPS-14 NOT_APPLICABLE ou posterior ao início;
  - mesmo instante do OPS-14 → COMPLETED;
  - incidente aberto durante → IN PROGRESS; no fechamento → FAIL.
- `gate · dogfood: relógio injetável`: o mesmo arquivo passa de IN PROGRESS a COMPLETED só pelo
  relógio (13 d 23 h 59 min → IN PROGRESS; 14 d → COMPLETED). Relógio inválido lança erro.
- READY: exige os 35 OPS e o dogfood novo com o relógio em 16/10. O mesmo diretório avaliado em
  17/09/2026 dá FAIL (início no futuro) e exit 2.
- **5 controles negativos de dogfood** (mutação de uma cópia da gate-lib, ciclo de 5 passos):
  1. status COMPLETED declarado fecha;
  2. dias exigidos lidos do arquivo;
  3. sem referência da release final;
  4. início no futuro aceito;
  5. formato do início validado só por `Date.parse`.

---

## 4. Resultados

Resultados no HEAD `9e51587`, com Postgres descartável `oria-test-pg-19f` e
`WHATSAPP_GO_DIR=/Users/gtomazi/projects/whatsapp-webhook-go` (`23528ae`): ver o relatório final
da trilha (números exatos da suíte, do `test:app-role`, do build e do gate).

---

## 5. Texto para o runbook

Substituições exatas em `production-rollout-runbook.md`, a cargo do lead.

**§1 Ferramentas**: trocar as duas linhas do gate por:

```text
| `npm run productization:gate` | máquina do operador / CI, com Docker | O GATE. CODE (suíte + invariants + estático + Go) / OPS / DOGFOOD. **Exit 0 somente com OVERALL READY**; 1 = código bloqueado; 2 = código pronto, rollout bloqueado (OPS pendentes e/ou dogfood); 64 = uso inválido |
| `npm run productization:gate -- --report-only [--json]` | idem | **não é gate**: só relatório, sai 0 mesmo bloqueado; mostra o exit que o gate daria (`gateExit`). Nunca usar como condição de avanço |
```

Acrescentar abaixo da tabela:

```text
`--code-only` foi removido na rodada 19 (saía 0 com OVERALL BLOCKED); passá-lo é uso inválido (64).
```

**§2 Evidência OPS**: substituir o parágrafo "Dogfood (`DOGFOOD.json`) …" por:

````text
Dogfood (`DOGFOOD.json`) — criado **uma vez**, no dia em que o dogfood começa (§14), e só editado
para atualizar `open_incidents`:

```json
{
  "format": "oria-ops-evidence/v1",
  "id": "DOGFOOD",
  "environment": "production",
  "dogfood_started_at": "2026-10-01T00:00:00Z",
  "dogfood_required_days": 14,
  "recorded_by": "nome de quem registrou",
  "open_incidents": 0
}
```

- Os dias são calculados pelo gate: relógio − `dogfood_started_at`. São exigidos 14 (constante do
  gate). `dogfood_required_days` é opcional e, se vier, precisa ser 14.
- **Não** existem `status`, `ended_at` nem data de fim. Arquivo com `status`, `started_at`,
  `ended_at`, `completed_at`, `closed_at`, `days` ou `elapsed_days` é FAIL.
- `dogfood_started_at`: ISO 8601 com hora e fuso, não pode estar no futuro, e precisa ser **≥
  `verified_at` do `OPS-14.json`** (RELEASE F VERIFIED; NOT_APPLICABLE não serve). Sem OPS-14
  válido, o dogfood é FAIL.
- `open_incidents`: inteiro ≥ 0. O gate só dá COMPLETED com 0.
- Sem arquivo: NOT STARTED.
````

**§4.2 Código**: trocar o item do gate por:

```text
- [ ] `npm run productization:gate` no commit do painel, com `WHATSAPP_GO_DIR` apontando para o
  commit do Go → **exit 2** com `CODE: PASS` (esperado antes do rollout: OPS e dogfood pendentes).
  **Exit 1 = pare** (código bloqueado). Exit 0 aqui seria erro de evidência: nenhum OPS pode estar
  VERIFIED antes do rollout. O gate roda:
  - a suíte;
  - `go vet`, `go build` e `go test -race`;
  - as checagens estáticas.
```

**§4.5 Ambiente do painel**: acrescentar:

```text
- [ ] **OPS-09 (painel)** — `WHATSAPP_WEBHOOK_SECRET` com ≥ 32 caracteres, valor **novo**.
  **Desde a rodada 19, o painel em produção não sobe sem ele** (exit 1, com ou sem
  `WHATSAPP_SERVICE_URL`; não existe modo que desligue o repasse). O preflight bloqueia a ausência em
  todos os estágios. O momento em que o valor novo entra (antes de B ou só antes de D) segue a ordem
  da assinatura de status (§5 da rodada 19): no P2 (`31a7cdb`) o segredo ainda é comparado com
  `?secret=` na URL do Go.
```

**§8 RELEASE D**: no bullet da trilha C, trocar "Sem ele, o repasse responde 503." por:

```text
Sem ele (ou com < 32), **o boot aborta** e a versão anterior continua no ar (rodada 19).
```

No VERIFY D, acrescentar:

```text
- [ ] Boot sem `[WHATSAPP_WEBHOOK] WHATSAPP_WEBHOOK_SECRET ausente/curto`.
```

**§13 CLEANUP**: trocar o último item por:

```text
- [ ] `npm run productization:gate` → exit 2 com todos os OPS VERIFIED/N.A. e só `DOGFOOD NOT STARTED`
  como bloqueio.
```

**§14 Dogfood**: substituir o item Dogfood e o item do gate por:

```text
- [ ] **Dogfood** — no dia em que a operação interna passar a rodar como Organization normal, sem
  bypass, e **depois** de `OPS-14.json` VERIFIED (e das etapas finais do runbook), criar
  `DOGFOOD.json` no formato de §2 com `dogfood_started_at` = esse instante.
  - Não há marcação de fim: o gate conta os dias pelo relógio.
  - Até 14 dias: `IN PROGRESS`. Incidente aberto: atualizar `open_incidents` (bloqueia o fechamento).
  - Início antes do OPS-14, no futuro, ou `dogfood_required_days` ≠ 14 → FAIL.
- [ ] `npm run productization:gate` → **exit 0 (OVERALL READY)** é a condição técnica do SECOND TENANT
  GATE. É o único caso de exit 0 do gate. A Fase 6 só fecha com isso **e** com a decisão do usuário.
  `--report-only` nunca serve como evidência de fechamento.
```

**§15 Matriz**: linha 09 → `| 09 | 4.4 / 4.5 / 8 / 9 | antes de tudo; segredo novo do repasse (boot do painel exige desde a R19) antes de D (painel) e de E (Go) |`;
linha 14 → `| 14 | 10 / 14 | RELEASE F; referência obrigatória do início do dogfood |`.

**Plano / progresso (lead)**: a linha "productization:gate … (exit 2; `--code-only` exit 0)" passa a
ser "(exit 2; `--code-only` removido; `--report-only` exit 0, não-gate)". O item 5 de "próximos
passos" do progresso ("Iniciar o dogfood (`DOGFOOD.json`) … após ≥ 14 dias e gate exit 0") passa a
citar `dogfood_started_at` depois do OPS-14.

---

## 6. Arquivos tocados

| arquivo | commit |
|---|---|
| `lib/platform/whatsapp-forward.js` | fix(boot) |
| `server.js` (bloco `WHATSAPP_WEBHOOK_SECRET`) | fix(boot) |
| `scripts/release/preflight.mjs` | fix(boot) |
| `test/invariants/r19-whatsapp-webhook-secret-boot.test.js` (novo) | fix(boot) |
| `test/invariants/boot-exit-code.test.js` (2 testes recebem o segredo) | fix(boot) |
| `test/invariants/negative-controls.test.js` (2 violações + lista de classes) | fix(boot) |
| `test/invariants/release-preflight.test.js` | fix(boot) |
| `scripts/productization/gate.mjs`, `gate-lib.mjs` | fix(gate) ×2 |
| `test/invariants/productization-gate.test.js` | fix(gate) ×2 |
| `docs/produtizacao-saas/round19-trilha-f.md` (este) | docs |

Não foram tocados: `package.json`, migrations, listas de migrations, `app-role.js`, manifesto.
`MINIMO_DE_TESTES` continua 806.
