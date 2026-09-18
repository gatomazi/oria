# Auditoria de consolidação do workspace (Frente C)

Duas fases. **Fase 1 (§1–§9)**: somente leitura — nada foi apagado, movido, mesclado ou
desregistrado; nenhuma alteração em Railway, GitHub, CI ou código. **Fase 2 (§10)**: limpeza
autorizada pelo usuário — remoção de três worktrees via `git worktree remove`, sem tocar
`oria-capabilities`, sem renomear migration e sem apagar `apps/panel/admin/`. As tabelas das §2–§9
descrevem o estado da fase 1; o estado atual está na §10.

- Data: 18/09/2026, fase 1 ~17h20, fase 2 ~17h50 (America/Sao_Paulo)
- Monorepo canônico: `/Users/gtomazi/projects/oria` — branch `main`, HEAD `723b3fb`, `origin` =
  `github.com/gatomazi/oria.git` (conta pessoal `gatomazi`), `main` == `origin/main`.
- Método: `git worktree list`, `git cherry` / `git log --cherry-pick`, `git merge-base --is-ancestor`,
  `diff -rq` (excluindo `node_modules`, `.git`, `dist`, `__pycache__`, `*.tsbuildinfo`), `md5` das
  migrations, `git status --ignored`, leitura do CI e de `infra/railway`, `railway status` (leitura).

## 1. Fato central

Os três diretórios paralelos **não são clones nem repositórios independentes**: são
**git worktrees do próprio `oria/`**, com `.git` como arquivo apontando para
`/Users/gtomazi/projects/oria/.git/worktrees/<nome>`. Todos os objetos e branches vivem no mesmo
repositório. Remover o diretório de um worktree não remove commits — apenas a árvore de trabalho.

Existe ainda um **quarto worktree**, não citado no comando:
`/private/tmp/claude-.../scratchpad/wt22-site` (detached `9fde9d7`, 144 MB), sobra de sessão anterior.

## 2. Tabela por diretório (C15)

### `oria-platform-admin`

| campo | valor |
|---|---|
| natureza | git worktree de `oria/` (B/D: staging de rodada concluída) |
| branch | `feature/platform-admin` |
| HEAD | `c3a7051` — `test(admin): lock down the interface invariants` (17/09 23:40) |
| remote | `origin` = `gatomazi/oria` (compartilhado com o monorepo) |
| dirty | limpo; só `apps/panel/node_modules` e `apps/panel/admin/node_modules` untracked |
| commits exclusivos | **nenhum** — HEAD é ancestral de `main` (36 commits atrás); `git cherry main` vazio; branch aparece em `git branch --merged main` |
| arquivos exclusivos | 122 arquivos presentes no branch e ausentes em `main` — todos **removidos de propósito** por `7c63f6a refactor(panel): remove the Orgulho Regional site` e `0c5c3d6` (site, `apps/panel/data/` 8,6 MB, `apps/panel/docs/` legados, `apps/panel/admin/` antigo, `assets/mockups*`, scripts `extract*`). Recuperáveis pela história de `main` |
| migrations exclusivas | nenhuma (falta apenas `1790000500000_convite-aceite` e `1790000600000_store-id-connector-ink`, que são de `main`) |
| testes exclusivos | nenhum |
| docs exclusivos | nenhum em `docs/`; os 41 arquivos de `apps/panel/docs/` (incl. `painel-estado-atual.md`, `ga4-oauth-setup.md`, `ui-audit/*.png`) foram excluídos do monorepo na rodada 22 e só existem na história |
| referências externas | nenhuma em scripts/CI/Railway/tooling. Ocorrências do texto "oria-platform-admin" são o **nome do pacote npm** (`apps/platform-admin/package.json`) e um doc de rodada |
| dependência de CI | nenhuma |
| dependência de Railway | nenhuma (`railway status` no diretório: "No linked project found") |
| classificação | **SAFE TO REMOVE** (via `git worktree remove`, depois de decidir sobre o branch) → **REMOVIDO** na fase 2 (§10.2) |
| motivo | worktree de branch já contido em `main`, sem trabalho exclusivo e sem arquivo ignorado de valor |

### `oria-panel-flat`

| campo | valor |
|---|---|
| natureza | git worktree de `oria/` (D: staging do achatamento do painel) |
| branch | `feature/invite-acceptance` |
| HEAD | `db6dc98` — `docs(auth): record the invite acceptance design` (18/09 01:00) |
| remote | `origin` = `gatomazi/oria` |
| dirty | limpo (nada untracked fora de `dist`/`node_modules`) |
| commits exclusivos | **nenhum** — ancestral de `main` (16 atrás), `git cherry` vazio, branch merged |
| arquivos exclusivos (versionados) | **zero** (`git diff --name-status main feature/invite-acceptance` não tem nenhuma linha `A`) |
| arquivos exclusivos (ignorados) | `apps/panel/db/` (11 JSON — persistência JSON legada; 9 dos 11 têm 2 bytes, i.e. `[]`/`{}`; `automacao.json` 58 B e `product-settings.json` 39 B; **115 bytes no total**, o "44 KB" da fase 1 era ocupação de blocos em disco — ver §10.1), `apps/panel/img-cache/` (vazio), `apps/panel/uploads/` (vazio). São resíduos de execução local, não estado de produção |
| migrations exclusivas | nenhuma |
| testes exclusivos | nenhum |
| docs exclusivos | nenhum |
| referências externas | nenhuma |
| dependência de CI | nenhuma |
| dependência de Railway | nenhuma |
| classificação | **SAFE TO REMOVE** (confirmar antes que os JSON de `apps/panel/db/` são descartáveis) → **REMOVIDO** na fase 2 (§10.1, §10.2) |
| motivo | foi exatamente o staging que promoveu o frontend de `apps/panel/admin/` para a raiz de `apps/panel` — trabalho já absorvido em `main` |

### `oria-capabilities`

| campo | valor |
|---|---|
| natureza | git worktree de `oria/` — **frente B (Features × Connector Capabilities) em andamento** |
| branch | `feature/connector-capabilities` |
| HEAD | `1ac2c9c` — `fix(rollout): shrink the release B seed list` (18/09 13:41) |
| remote | `origin` = `gatomazi/oria` |
| dirty | working tree limpo; tudo commitado no branch |
| commits exclusivos | **4** (não estão em `main` nem por patch-id): `48d8253 feat(entitlements): split features from capabilities`, `5eb99eb docs(architecture): record the classification matrix`, `a3c8f6c test(migrations): expect 0022 in the migration lists`, `1ac2c9c fix(rollout): shrink the release B seed list`. Branch aparece em `git branch --no-merged main` |
| arquivos exclusivos | `apps/panel/lib/platform/connector-capabilities.js`, `apps/panel/lib/creative-core/module-capabilities.js`, `apps/panel/test/invariants/capabilities-classificacao.test.js`, `docs/architecture/features-vs-connectors.md`, `docs/operations/connector-ink.md`, `docs/productization/artwork-vault.md`, `docs/productization/platform-admin-phase.md`, `docs/features/pendente-serverjs-connector-guard.diff` + ~20 arquivos modificados |
| migrations exclusivas | `1790000600000_features-reclassificadas.js`, `sql/0022-features-reclassificadas.{up,down}.sql` |
| testes exclusivos | `capabilities-classificacao.test.js` (+ 10 suites modificadas) |
| docs exclusivos | 5 documentos (lista acima) |
| referências externas | nenhuma |
| dependência de CI | nenhuma (mas o branch ainda precisa passar no CI ao ser integrado) |
| dependência de Railway | nenhuma |
| classificação | **KEEP / ACTIVE WORKTREE** → depois **MERGE INTO ORIA** |
| motivo | último commit hoje 13:41 e 130 arquivos tocados depois das 12:30; trabalho não integrado. Consolidar agora destruiria a frente B |

### `wt22-site` (worktree extra, fora do comando)

| campo | valor |
|---|---|
| caminho | `/private/tmp/claude-1564959539/.../scratchpad/wt22-site` (144 MB) |
| natureza | worktree detached (`9fde9d7`) de sessão anterior, em diretório temporário |
| commits exclusivos | **nenhum por conteúdo**: os 4 commits (`fcaa72d`, `db487ec`, `c36cc4f`, `9fde9d7`) já entraram em `main` como equivalentes (`7c63f6a`, `0c5c3d6`, …) — `git log --cherry-pick --right-only main...9fde9d7` é vazio |
| classificação | **SAFE TO REMOVE** (`git worktree remove`/`prune` quando o `/tmp` da sessão sumir) → **REMOVIDO** na fase 2 (§10.2) |

## 3. Blockers

1. **BLOCKER-C1 (HIGH) — colisão de timestamp de migration.** `main` tem
   `1790000600000_store-id-connector-ink.js` (SQL `0021`, frente A) e
   `feature/connector-capabilities` tem `1790000600000_features-reclassificadas.js` (SQL `0022`).
   Mesmo prefixo `1790000600000` em migrations diferentes: ordenação ambígua no node-pg-migrate e
   risco de "já aplicada" mal resolvido. Renomear a da frente B (p.ex. `1790000700000`) antes do
   merge. Decisão de quem integrar a frente B, não desta auditoria.
2. **BLOCKER-C2 (MEDIUM) — sobreposição de arquivos entre frente A (já em `main`) e frente B.**
   Quatro testes tocados pelos dois lados: `inv-td003-postgres-obrigatorio.test.js`,
   `migrations.test.js`, `r19-runbook-dry-run.test.js`, `tenancy-migrations.test.js` (listas de
   migrations esperadas). Conflito de merge previsível; resolver manualmente, não com `-X ours`.
3. **BLOCKER-C3 (MEDIUM) — frente B ainda aberta.** Enquanto `feature/connector-capabilities` não
   for integrada, `oria-capabilities` não pode ser removido.
4. **NÃO É BLOCKER, mas é pré-condição:** o monorepo **não carregou a história** dos repositórios de
   origem (`docs/architecture/source-migration-manifest.md`). `orgulhoregional` e
   `whatsapp-webhook-go` são o registro histórico e **não** entram em nenhuma consolidação desta
   frente. `orgulhoregional` ainda tem working tree suja (44 entradas) — trabalho que, por
   construção, ficou fora do snapshot.

## 4. Achados secundários (não bloqueiam)

- `oria/apps/panel/admin/` existe no working tree do monorepo com 115 MB de `dist/` + `node_modules/`
  + `*.tsbuildinfo`, **todos ignorados** — sobra do frontend antigo. O `scripts/repo-self-check.mjs`
  só reprova se esses caminhos voltarem **versionados**, então o CI segue verde; é lixo local que
  contradiz a documentação ("a pasta `admin/` não existe mais") e confunde leitura humana.
- `apps/panel/docs/painel-estado-atual.md` (documento de estado do painel) não existe mais em `main`;
  só na história do monorepo e no repositório `orgulhoregional`.
- `infra/railway/services.md` descreve **três** services (`oria-panel`, `oria-creatives`,
  `oria-whatsapp`). O `oria-admin` (control plane) ainda não tem service — consistente com o estado
  "Oria Admin pronto, não deployado".

## 5. Verificações de autocontenção (C9/C14)

- `.github/workflows/ci.yml`: 5 jobs (`contracts`, `panel`, `platform-admin`, `creatives`,
  `whatsapp`), todos com `actions/checkout` do próprio monorepo e `working-directory` interno.
  Nenhuma referência a diretório paralelo.
- `npm run repo:self-check` (job `contracts`) falha por design em caminho absoluto de máquina,
  dependência de repositório vizinho e `ORIA_LEGACY_PANEL_REPO`. Varredura manual por
  `/Users/gtomazi`, `projects/orgulhoregional` e `ORIA_LEGACY_PANEL_REPO` em `apps/`, `scripts/` e
  `.github/`: **nenhuma ocorrência**.
- O monorepo contém os quatro deployables (`apps/panel`, `apps/platform-admin`,
  `apps/creative-generator`, `services/whatsapp`), `contracts/whatsapp`, `infra/railway`, 24
  migrations JS / 36 SQL, 72 suites do painel + 10 do control plane e 48 documentos.
- Railway (leitura): o link do CLI existe só para caminhos sob `/Users/gtomazi/projects/oria`
  (projeto `oria`, env `production`); os três worktrees respondem "No linked project found".

## 6. Migrations (C10)

| migration | origem | existe no monorepo? | mesmo conteúdo? |
|---|---|---|---|
| `0001`–`0020` + JS correspondentes | todos os worktrees | sim | sim — `md5` idêntico em todos os arquivos comuns |
| `1790000500000_convite-aceite` / `0020` | `main`, `panel-flat`, `capabilities` | sim | sim |
| `1790000600000_store-id-connector-ink` / `0021` | `main` (frente A) | sim | — |
| `1790000600000_features-reclassificadas` / `0022` | só `feature/connector-capabilities` | **não** | colisão de timestamp com a de cima (BLOCKER-C1) |

Nenhuma migration existe apenas em worktree "morto". Nenhuma divergiu de conteúdo.

## 7. Secrets / env (C13)

Somente existência, sem leitura de valores:

| diretório | arquivos `.env*` | estado |
|---|---|---|
| `oria` | `services/whatsapp/.env.example` | versionado (tracked), é exemplo |
| `oria-capabilities` | idem | tracked |
| `oria-panel-flat` | idem | tracked |
| `oria-platform-admin` | idem | tracked |

**Nenhum `.env`, `.env.local` ou `.env.production` real** existe em nenhum dos quatro diretórios
(busca até 5 níveis, fora de `node_modules`). Não há secret exclusivo a preservar.

## 8. Sequência segura de consolidação (não executar agora)

> Andamento na fase 2: passo 4 (JSON) e a parte do passo 5 que cobre `oria-platform-admin`,
> `oria-panel-flat` e `wt22-site` foram executados (§10). Seguem pendentes os passos 1–3, a remoção
> de `oria-capabilities`, o passo 6 e o passo 7.

1. Esperar as frentes A e B terminarem. A frente A já está em `main` (`edf5625`, `723b3fb`);
   a B continua em `feature/connector-capabilities`.
2. Frente B: renomear `1790000600000_features-reclassificadas.js` para um timestamp posterior ao
   `1790000600000_store-id-connector-ink.js` (BLOCKER-C1), rebasear/mesclar em `main` resolvendo à
   mão os 4 testes de lista de migrations (BLOCKER-C2) e rodar o CI completo.
3. Depois do merge, confirmar `git cherry main feature/connector-capabilities` vazio e
   `git branch --merged main` listando os três branches.
4. Confirmar com o usuário que `oria-panel-flat/apps/panel/db/*.json` (44 KB, praticamente vazios)
   não têm valor; se houver dúvida, copiar para fora antes.
5. Remover os worktrees, sempre por Git, nunca por `rm -rf`:
   `git worktree remove ../oria-platform-admin`, depois `../oria-panel-flat`, por último
   `../oria-capabilities`. Rodar `git worktree prune` para o `wt22-site` de `/tmp`.
6. Opcional, só depois: apagar os branches já contidos em `main`
   (`feature/platform-admin`, `feature/invite-acceptance`, `refactor/panel-flatten`,
   `feature/connector-capabilities` após o merge). Nada disso apaga história de `main`.
7. Limpeza local independente: `oria/apps/panel/admin/` (115 MB ignorados).
8. **Não** tocar em `orgulhoregional` nem `whatsapp-webhook-go`: são a história que o monorepo
   deliberadamente não importou.

## 9. GO / NO-GO

- **GO condicional** para o workspace terminar só com `oria/`.
- Condições: (a) frente B integrada em `main`; (b) BLOCKER-C1 resolvido; (c) confirmação sobre os
  JSON de `apps/panel/db/`; (d) remoção feita por `git worktree remove`.
- **NO-GO hoje**, por causa dos 4 commits não integrados em `oria-capabilities`.
- `oria-platform-admin`, `oria-panel-flat` e `wt22-site`: **GO** isolado — podem sair assim que
  houver autorização, sem esperar a frente B, já que não têm nada exclusivo.

## 10. Fase 2 — limpeza executada (18/09/2026, ~17h50)

Autorizada pelo usuário: remover `oria-platform-admin`, `oria-panel-flat` e `wt22-site` apenas por
`git worktree remove`; manter `oria-capabilities`; não renomear a migration Ink; não apagar
`apps/panel/admin/`.

### 10.1 Os 11 JSON de `oria-panel-flat/apps/panel/db/`

Correção da fase 1: o total é **115 bytes** (o "44 KB" era ocupação de blocos). Também **não eram
todos de 2 bytes** — 9 eram, 2 eram maiores. Nenhum tem conteúdo real:

| arquivo(s) | bytes | conteúdo | veredito |
|---|---|---|---|
| `audit_log`, `envios-pendentes-janela`, `ink_webhook_log` | 2 | `[]` | vazio |
| `automacao-eventos`, `campos-customizados`, `carrinho-envios`, `pedidos`, `pix-lembretes`, `whatsapp-template-config` | 2 | `{}` | vazio |
| `automacao.json` | 58 | `{"modoEnvio":"manual","janelaEnvio":{"inicio":8,"fim":22}}` | idêntico a `AUTOMACAO_SETTINGS_PADRAO` do `server.js` |
| `product-settings.json` | 39 | `{"productName":"Orgulho Regional"}` | idêntico a `PRODUCT_SETTINGS_DEFAULT` do `server.js` **em `db6dc98`** (o default atual é `Oria`) |

Evidências: 0 arquivos versionados (ignorados por `apps/panel/.gitignore:5: db/`); todos criados no
mesmo minuto (17/09 23:26), i.e. materializados por uma execução do app; `oria/apps/panel/db` não
existe. Referências no monorepo são apenas constantes de caminho relativas a `STORAGE_DIR/db/`
(`server.js`) e a migration `1789509660000_backfill-pedidos-json.js`, que copiaria `db/pedidos.json`
para o Postgres — aqui `{}`, nada a copiar. Nenhuma referência ao worktree. **Veredito: GO.** Cópia
dos 11 arquivos (115 bytes) mantida no scratchpad temporário da sessão.

### 10.2 Worktrees removidos

| worktree | comando | observação |
|---|---|---|
| `oria-panel-flat` | `git worktree remove` | limpo; só ignorados (`db/`, `dist/`, `node_modules/`, `*.tsbuildinfo`) |
| `oria-platform-admin` | `git worktree remove --force` | sem `--force` recusou: `apps/panel/node_modules` e `apps/panel/admin/node_modules` untracked. Verificado que era a única sujeira |
| `wt22-site` | `git worktree remove --force` | sem `--force` recusou: `apps/panel/node_modules` untracked (única sujeira). Antes: nenhum processo com cwd nele, nenhum arquivo modificado nas últimas 2 h, os 4 commits equivalentes em `main` (`git cherry` só com `-`) |

`c3a7051` e `db6dc98` são ancestrais de `origin/main`. Os branches `feature/platform-admin` e
`feature/invite-acceptance` **não foram apagados**. `git worktree prune --dry-run`: nada a podar.

`git worktree list` depois:

```text
oria               723b3fb  [main]
oria-capabilities  1ac2c9c  [feature/connector-capabilities]
```

### 10.3 `oria-capabilities` — KEEP / ACTIVE WORKTREE

HEAD `1ac2c9c` (18/09 13:41), working tree limpo, 4 commits à frente e 2 atrás de `origin/main`,
nenhum arquivo modificado nos últimos 45 min, nenhum processo com cwd em worktree, branch **não
publicada** no `origin`. Ocioso há ~4 h, mas não integrado: permanece. Sem merge, sem rename.

### 10.4 `oria/apps/panel/admin/`

Zero arquivos versionados; o diretório inteiro aparece como ignorado (`!! apps/panel/admin/`, regras
`node_modules/` e `dist/` de `apps/panel/.gitignore`). Composição: `node_modules` 113 MB, `dist`
1,6 MB, 2 × `tsconfig.*.tsbuildinfo` 16 KB. Nenhum arquivo-fonte. Referências: só comentários,
documentação e as **proibições** do `repo-self-check` (`server.js:833`, `vite.config.mjs:9`,
`infra/railway/services.md:33`, `scripts/repo-self-check.mjs`); nenhuma em `package.json`, CI,
scripts executáveis, Vite ou Railway. Classificação: **GENERATED — SAFE TO CLEAN**. Não foi apagado;
aguarda autorização.

### 10.5 Colisão de migration — Ink preservada, proposta para a frente B

- `1790000600000_store-id-connector-ink.js` (SQL `0021`) está em `main`, tem um único commit no
  histórico (`edf5625`), `md5` `1356c65fdc35959a70504150e788bfe8`, e **não foi tocada**. A frente B
  não a contém (o branch nasceu antes).
- Proposta para a B: `1790000700000_features-reclassificadas.js` (passo de 100000 usado pelas
  anteriores; máximo atual `1790000600000` tanto em `main` quanto na B). O SQL segue `0022`.
  **Reconfirmar o máximo no momento da integração.** Só executar dentro de `oria-capabilities` e
  quando a B estiver pronta.
- A B não foi publicada no `origin`: nenhuma migration publicada seria reescrita. Somente bancos
  locais que já aplicaram `1790000600000_features-reclassificadas` precisariam ser recriados.
- Ao renomear, atualizar os 4 testes que listam migrations por nome (`inv-td003-postgres-obrigatorio`,
  `migrations`, `r19-runbook-dry-run`, `tenancy-migrations`) e regenerar os manifestos **a partir do
  estado combinado** — nunca resolver com `ours`/`theirs`.
- Verificar depois: ordem no node-pg-migrate, migrate do zero, migrate sobre schema atualizado,
  down/up (a `0022` tem `.down.sql`) e idempotência aplicável.

### 10.6 Estado atual e GO / NO-GO

Workspace: `oria/` + `oria-capabilities/` (temporário).

- **GO condicional** para terminar só com `oria/`: falta (a) frente B integrada em `main` e (b) a
  migration da B renomeada, com os 4 testes e os manifestos regenerados. Depois disso,
  `git worktree remove` de `oria-capabilities` e, opcionalmente, apagar os branches já contidos.
- **NO-GO hoje**, pelos 4 commits não integrados da frente B.
- Independente da B, aguardando autorização: limpar `oria/apps/panel/admin/` (§10.4).
