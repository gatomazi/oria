# Trilha B — Rodada 18 · Fase 7 (construção) · onboarding

> **Base:** `bfd00a6` (worktree destacado). **Escopo:** seções 11–21 do comando da rodada 18.
> **Nada disto cria tenant externo.** A criação de Organization fica atrás de
> `SECOND_TENANT_ENABLED` (desligado por padrão), não há rota HTTP nova, nada aparece no admin e
> tudo foi exercitado só em Postgres descartável. Fase 6 **não** foi tocada nem marcada.
>
> A seção antiga deste arquivo (Fase 0) continua abaixo, em "Histórico".

## 1. O que foi construído

| Peça | Onde | O que faz |
|---|---|---|
| Migration `1790000300000_onboarding` | `migrations/sql/0018-onboarding.{up,down}.sql` | `onboarding_sessions` e `onboarding_steps` (RLS habilitada + **forçada**, policy canônica), `onboarding_invites` e `onboarding_idempotencia` (globais **privadas**), 3 funções `SECURITY DEFINER` |
| Serviço | `lib/platform/onboarding.js` | `createOrganizationWithStore`, `emitirConvite`, `aceitarConvite`, `estado`, `registrarErroDoPasso`, `retomarPasso`, `semearEntitlements`, `finalizar` |
| Manifesto | `lib/platform/tenancy-manifest.js` | as duas tabelas de estado entram em `TABELAS_PLATAFORMA` (sob RLS); as duas globais em `TABELAS_GLOBAIS` + `TABELAS_GLOBAIS_PRIVADAS`; documento regenerado |
| Role | `lib/platform/app-role.js` | `EXECUTE` nas 3 funções novas; sem acesso às 2 tabelas privadas (`verificarRoleDaAplicacao` confere) |
| Testes | `test/invariants/fase7-onboarding.test.js` (12) + 5 negative controls | ver §6 |

### Modelo de estado (seção 13)

- `onboarding_sessions` (PK `organization_id`): `status ∈ not_started | in_progress | blocked | complete`,
  `config` (retrato dos requisitos no momento da criação), `criado_por`, `concluido_em`
  (`CHECK status = complete ⇔ concluido_em`).
- `onboarding_steps` (PK `(organization_id, step_id)`, FK para a sessão): `step_id`, `requirement`
  (`required | optional | disabled`), `status` (`pending | in_progress | blocked | complete | skipped`),
  `last_error_code`, `tentativas`, `completed_at`.
  - `last_error_code` tem `CHECK ~ '^[A-Z][A-Z0-9_]{2,63}$'`: o banco recusa texto livre de provider.
    O serviço ainda reduz qualquer erro a um vocabulário fechado (`CODIGOS_DE_ERRO`).
  - `blocked` exige código; `disabled` só pode estar `skipped`; `complete ⇔ completed_at`.
- Passos (seção 14): `org_store, owner, ink, meta, google, ga4, openai_byok, whatsapp, entitlements, readiness`.
- Status da sessão: `complete` é **marco** (fica após `finalizar`, mesmo que uma integração seja
  desconectada depois — o passo em si volta a refletir a realidade); senão `blocked` se algum passo
  **required** está bloqueado; senão `in_progress`/`not_started`. Uma Organization criada pelo
  serviço já nasce `in_progress` (org_store e owner são concluídos na mesma transação);
  `not_started` fica disponível para um fluxo futuro que pré-provisione a sessão.
- Organizations que já existem (Tenant #1) **não** recebem estado de onboarding: não passaram por ele.

## 2. Decisões (e o que ficou para o usuário)

| # | Decisão | Por quê |
|---|---|---|
| B18-1 | **Sem configuração explícita, criação recusada** (`ONBOARDING_CONFIG_REQUIRED`). Requisitos vêm de `ONBOARDING_STEP_REQUIREMENTS` (JSON com os 10 passos) ou do parâmetro `passos`. Faltar um passo é erro. | PD-005/006/007/008/009/011/012 estão OPEN: não existe "plano padrão" para inventar. Obrigatoriedade de Ink/WhatsApp é config. |
| B18-2 | `org_store`, `owner` e `readiness` são sempre `required` (config diferente é inválida). | São estruturais (sem eles não há Organization utilizável), não comerciais. |
| B18-3 | Estado dos passos de provider é **derivado** de `integrations` + `integration_secrets` (status `connected`, tipos de segredo exigidos e não vencidos, config não sensível exigida — WhatsApp: `waba_id` + `phone_number_id`). `onboarding_steps` guarda só a projeção e o último código. Nenhum segredo é lido/decifrado pelo onboarding. | Seção 17: sem segundo source of truth. Negative control `onboarding/segunda-fonte`. |
| B18-4 | Passo `entitlements` = existe plano explícito (`app_config 'entitlements'`) para a Organization. O seed é operação de **plataforma** (`semearEntitlements(org, [features])`, lista explícita, vocabulário fechado), atrás do gate, e só para Organization que tem sessão de onboarding. O owner não concede plano a si mesmo. | Nada é concedido por omissão (INV-23); não mexe no plano do Tenant #1. Quais features cada plano liga continua PD-005/009. |
| B18-5 | Idempotência por **(pessoa, chave explícita)** em `onboarding_idempotencia` (chave guardada como SHA-256, com digest do pedido). Mesma chave + mesmo pedido → mesma Organization (`criada: false`); mesma chave + pedido diferente → `IDEMPOTENCY_KEY_REUSED`; chave nova → Organization nova. Concorrência resolvida pela PK (o segundo espera o COMMIT do primeiro). | Seção 15/19: nada de "a pessoa já tem uma". Negative controls `onboarding/ja-existe-uma` e `onboarding/chave-sem-pedido`. |
| B18-6 | Criação roda sob a **role da aplicação**, numa transação com a Organization nova no contexto (`comOrganization`): a RLS forçada vale para Organization, Store, membership, sessão, passos e audit. As únicas coisas fora da RLS são as duas tabelas privadas, acessadas só por função `SECURITY DEFINER` que usa a Organization **do contexto**. | Sem bypass (seção 21). |
| B18-7 | Convite: token de 256 bits (`base64url`), só o SHA-256 no banco, validade padrão 72 h (máx. 7 dias), uso único por `SELECT … FOR UPDATE` dentro da transação de criação (ROLLBACK devolve o convite). O e-mail vem do convite, não do request. E-mail já cadastrado → `INVITE_EMAIL_ALREADY_REGISTERED` (a pessoa entra e usa `createOrganizationWithStore` logada). **Sem envio de e-mail**: quem emite recebe o token (dev flow). | Seção 16. Provedor de e-mail não definido. |
| B18-8 | Gate: `SECOND_TENANT_ENABLED` (`1`/`true` liga; vazio/`0`/`false` desliga; **qualquer outro valor é erro**). Verificado **no serviço** antes de `createOrganizationWithStore`, `emitirConvite`, `aceitarConvite` e `semearEntitlements`. Leitura/retomada/finalização de onboarding existente não dependem do gate. | Seção 20. Negative control `onboarding/gate`. Quem liga o flag em produção é decisão do Second Tenant Gate (trilha D) + usuário. |
| B18-9 | **Nenhuma rota HTTP nova e nada no `server.js` além de `MIGRATION_MINIMA`.** O teste monta uma app mínima com o auth real e uma rota de leitura de teste. | Seção 11: onboarding não exposto publicamente. Quando houver rota, ela deve pegar `userId`/Organization da sessão (nunca do corpo) e continuar atrás do gate. |
| B18-10 | Erros de provider: `registrarErroDoPasso(org, passo, erro)` grava só o código normalizado (401→`PROVIDER_AUTH_FAILED`, 403, 429, 400/422, 5xx/rede→`PROVIDER_UNAVAILABLE`, posse de recurso → `PROVIDER_RESOURCE_OWNED_ELSEWHERE`, resto → `PROVIDER_ERROR`); segredo vencido vira `INTEGRATION_SECRET_EXPIRED` na derivação. `retomarPasso` tira do bloqueio e mantém o último código visível. | Seção 13/18. Negative control `onboarding/erro-bruto`. |

**Para o usuário decidir depois (não decidido aqui):** requisitos reais de cada passo por plano
(PD-005/011/012), trial/free/pricing (PD-007/008/009), detalhes de conexão manual × OAuth
(PD-006), provedor de e-mail do convite, UI/rotas de onboarding e quando ligar
`SECOND_TENANT_ENABLED` (depende do Second Tenant Gate e de OPS-27, que segue **NOT VERIFIED**).

## 3. Como usar (dev flow, só em banco descartável)

```js
const { createOnboardingService } = require('./lib/platform/onboarding');
const s = createOnboardingService({ poolReal, env: {
  SECOND_TENANT_ENABLED: '1',
  ONBOARDING_STEP_REQUIREMENTS: JSON.stringify({ org_store: 'required', owner: 'required', ink: '…', meta: '…',
    google: '…', ga4: '…', openai_byok: '…', whatsapp: '…', entitlements: '…', readiness: 'required' }),
} });
const { token } = await s.emitirConvite({ email });                    // entregue por fora
const { organizationId, ownerUserId } = await s.aceitarConvite({ token, senha, organizacao: { nome }, store: { nome } });
// integrações pelo caminho normal (createIntegrationResolver dentro do contexto da Organization)
await s.estado(organizationId, { userId: ownerUserId });               // retomável a qualquer momento
await s.semearEntitlements(organizationId, ['…']);                     // plataforma, lista explícita
await s.finalizar(organizationId, { userId: ownerUserId });            // idempotente
```

## 4. Seções 11–21 — status

| Seção | Status | Evidência |
|---|---|---|
| 11 construção sem uso real | ✅ | gate desligado por padrão; sem rota; sem admin |
| 12 sem decisão comercial | ✅ | B18-1/B18-4 |
| 13 modelo persistido | ✅ | migration 0018; manifesto; INV-07 e matriz de isolamento cobrem as duas tabelas |
| 14 passos genéricos configuráveis | ✅ | `PASSOS`, `validarPassos` |
| 15 criação atômica + concorrência | ✅ | testes `atômico` e `idempotência` (8 chamadas paralelas → 1 Organization) |
| 16 convite | ✅ | testes de uso único, concorrência (5 aceites → 1), expirado, desconhecido, e-mail existente |
| 17 estado de provider derivado | ✅ | teste E2E (desconectar reflete no passo) + negative control |
| 18 retomada (logout, restart, erro) | ✅ | teste E2E com login real, logout (401), pool/serviço novos, sessão nova |
| 19 idempotência | ✅ | criar Org/Store/owner (chave), finalizar (mesmo `concluidoEm`, 1 audit), seed de entitlements (1 linha) |
| 20 gate | ✅ | teste `gate` + negative control; valor inválido é erro |
| 21 E2E + segundo tenant | ✅ | E2E completo sob `oria_app` e segundo tenant isolado (aplicação + RLS, com e sem contexto) |

## 5. Arquivos compartilhados tocados

- `server.js` — só `MIGRATION_MINIMA` → `1790000300000_onboarding`.
- `lib/platform/tenancy-manifest.js`, `lib/platform/app-role.js`, `docs/produtizacao-saas/tenant-owned-tables.md` (regenerado).
- Listas de migrations: `test/invariants/migrations.test.js`, `inv-td003-postgres-obrigatorio.test.js`,
  `tenancy-migrations.test.js` (`DEPOIS_DA_FASE1` 6 → 7).
- `test/invariants/tenancy-isolation.test.js` — a matriz inclui as tabelas de plataforma novas.
- `test/invariants/negative-controls.test.js` — 5 controles `onboarding/*` e a lista de classes.
- `test/invariants/tenancy-upsert.test.js` — contagem de alvos `ON CONFLICT` 32 → 33 (seed de `app_config 'entitlements'`, alvo começa por `organization_id`).
- `package.json` **não** foi tocado (nenhum script `onboarding:*` foi necessário).

## 6. Testes

`test/invariants/fase7-onboarding.test.js` usa um banco descartável migrado do zero (cenário A) e a
role **`oria_app`** com a mesma senha de `INVARIANTS_APP_DATABASE_URL` (GRANTs aplicados pelo mesmo
SQL de OPS-14 no banco novo; o teste confere `current_user = oria_app` sem SUPERUSER/BYPASSRLS).

Negative controls (ciclo passa → viola → FALHA → restaura → passa):

| classe | violação |
|---|---|
| `onboarding/gate` | serviço ignora `SECOND_TENANT_ENABLED` |
| `onboarding/ja-existe-uma` | idempotência por "já é owner de alguma" |
| `onboarding/chave-sem-pedido` | mesma chave com pedido diferente devolve a Organization antiga |
| `onboarding/erro-bruto` | mensagem do provider vira `last_error_code` |
| `onboarding/segunda-fonte` | passo concluído não volta quando a integração é desconectada |

## 7. Riscos

- `onboarding_emitir_convite` é executável pela role da aplicação; o gate que impede emitir em
  produção está no serviço. Uma rota futura precisa passar pelo serviço (não chamar a função direto).
- A sessão `complete` é marco: desconectar uma integração depois não reabre o onboarding (o passo
  mostra a regressão). Se o produto quiser "health contínuo", isso é outra tela, não este estado.
- As listas de migrations vão conflitar com as das trilhas A/C/D (timestamps 17900003xxxxx são desta).

---

# Histórico

# Trilha B — Fase 0 (Foundations) · relatório de execução

> **Baseline:** `master` @ `8a7ea3d` · **Escopo:** TD-010 (migrations), TD-003 (Postgres obrigatório),
> TD-004 (secrets), harness de invariants + negative controls, Postgres efêmero em teste/CI.
>
> **Nada foi commitado.** Tudo está no working tree. Nenhum push, deploy, alteração no Railway ou
> migration contra banco de produção. A Fase 1 **não** foi iniciada e **nenhuma tabela de negócio
> recebeu `organization_id`**.

---

## 1. Resultado, em uma tela

| Critério de saída da Fase 0 | Estado | Evidência |
|---|---|---|
| 1. Uma migration aplicada **e revertida** em teste | ✅ | `migrations · a última é revertível e reaplicável` |
| 2. Boot sem `DATABASE_URL` falha em produção; degrada em dev **declaradamente** | ✅ | matriz de boot §5, casos 1-3 |
| 3. `INV-14`: rotacionar `ADMIN_SESSION_SECRET` e os segredos seguem legíveis | ✅ | `inv-13-secrets.test.js` |
| 4. **Nenhum DDL e nenhum backfill roda no boot** | ✅ | `migrations · nenhum DDL nem backfill roda no boot` |
| 5. Harness completou o **ciclo de 5 passos** nas **cinco** classes críticas | ✅ | §4 |

| Métrica | Antes (`8a7ea3d`) | Depois |
|---|---|---|
| Testes executados | 228 | **325** |
| Testes **pulados** | **6** | **0** |
| Testes cobrindo tenancy/auth/entitlement/secrets/webhook | **0** | 48 |
| Invariants que já reprovaram um defeito real | **0** | **5** (um por classe crítica) |
| Linhas de DDL rodando a cada boot | ~1.010 | **0** |

---

## 2. Arquivos alterados — agrupamento proposto por commit

### `chore(db): move o schema do boot para migrations versionadas`

| Arquivo | Ação |
|---|---|
| `package.json` | `node-pg-migrate` como **dependência normal**; scripts `migrate:*`, `test`, `test:unit`, `test:invariants`, `db:start`, `db:stop` |
| `package-lock.json` | lock da dependência |
| `migrations/README.md` | novo — explica a diferença para `scripts/migracao-*.mjs` |
| `migrations/sql/0001-baseline-schema.sql` | novo — o DDL de `bootstrapPostgres()`, movido **sem uma edição** |
| `migrations/1789509600000_baseline-schema.js` | novo |
| `migrations/1789509660000_backfill-pedidos-json.js` | novo — era `backfillPedidosSeNecessario` |
| `migrations/1789509720000_backfill-payment-status-portugues.js` | novo — era `backfillPaymentStatusPortugues` |
| `migrations/1789509780000_backfill-public-token-media.js` | novo — era `backfillPublicTokenMedia` |
| `lib/platform/db-config.js` | novo — TD-003: modo de persistência declarado, verificação crítica de boot |
| `server.js` | **predominante aqui** — remoção do DDL/backfills do boot (−1.012 linhas), fail-fast, `listen` só após verificação |

### `feat(secrets): chave de cifra própria, versionada e independente da sessão`

| Arquivo | Ação |
|---|---|
| `migrations/1789509840000_integration-secrets.js` | novo — `integrations` + `integration_secrets` (TD-004, Opção A) |
| `lib/secrets/keyring.js` | novo — `ENCRYPTION_MASTER_KEY`, `key_version`, rotação incremental, legacy opt-in |
| `lib/secrets/store.js` | novo — repositório com fronteira metadata × plaintext |
| `server.js` | **secundário** — `encriptarSegredo`/`descriptografarSegredo` passam a usar o chaveiro; `chaveEncriptacao()` removida |

> **`server.js` aparece nos dois commits.** O **predominante é `chore(db)`**: ali estão as ~1.012
> linhas removidas e a mudança de comportamento de boot. A parte de `feat(secrets)` são ~40 linhas
> contíguas, no bloco de cripto (uma única região do arquivo), e podem ser separadas com `git add -p`
> se você quiser o corte limpo. Se preferir um commit só para `server.js`, ele pertence a `chore(db)`.

### `test(platform): harness de invariants com negative controls e Postgres efêmero`

| Arquivo | Ação |
|---|---|
| `scripts/test-db.mjs` | novo — Postgres efêmero (Docker), migrations do zero, env para os testes |
| `.github/workflows/ci.yml` | novo — CI com Postgres de serviço, migrations do zero, `npm test`, `npm run build` |
| `test/invariants/harness.js` | novo — resolução de sujeito via `INVARIANT_SUBJECT_ROOT`, fixtures de tenancy |
| `test/invariants/negative-controls.test.js` | novo — **o ciclo de 5 passos** |
| `test/invariants/inv-09-tenancy.test.js` | novo — INV-09/11/20 |
| `test/invariants/inv-02-auth.test.js` | novo — INV-01/02/10 |
| `test/invariants/inv-23-entitlement.test.js` | novo — INV-23 |
| `test/invariants/inv-13-secrets.test.js` | novo — INV-13/14 |
| `test/invariants/inv-15-webhook.test.js` | novo — INV-15 |
| `test/invariants/inv-td003-postgres-obrigatorio.test.js` | novo — TD-003 + OPS-11 |
| `test/invariants/migrations.test.js` | novo — inclui o caso "sobre a base de produção existente" |
| `test/helpers/schema-sql.js` | novo — fonte única do DDL para os testes de schema |
| `lib/platform/ownership.js` | novo — sujeito do invariant de tenancy |
| `lib/platform/tenant-context.js` | novo — sujeito do invariant de auth |
| `lib/platform/entitlements.js` | novo — sujeito do invariant de entitlement |
| `lib/platform/webhook-routing.js` | novo — sujeito do invariant de webhook |
| `test/meta-schema.test.js` | **modificado** — lia o DDL recortando `server.js`; passa a ler a migration |
| `test/google-ads-schema.test.js` | **modificado** — idem |

> Os quatro módulos `lib/platform/*.js` de política poderiam ir em `feat(platform):`. Coloquei-os em
> `test(platform)` porque **nesta fase eles não estão ligados a nenhuma rota** — existem como
> contrato e como sujeito dos invariants. Quem os liga ao pipeline são as Fases 2-4. Se preferir,
> `lib/platform/{ownership,tenant-context,entitlements,webhook-routing}.js` formam um
> `feat(platform): contratos de tenancy, auth, entitlement e roteamento de webhook` coerente.

### Arquivos compartilhados que **eu não toquei**

Nada em `docs/produtizacao-saas/` além **deste arquivo**. Li (somente leitura, sem escrita):
`productization-plan.md`, `productization-decisions.md`. Não abri os anexos nem o audit.

Tudo o mais que aparece em `git status` — `docs/painel-estado-atual.*`,
`docs/commands-produtizacao/`, `docs/claude-analytics-*`, `START-PRODUCTIZATION-AUDIT.md`,
`.claude/agent-memory/`, `.claude/agents/oria-productization-lead.md`,
`docs/levantamento-productizacao-saas-painel.md` (deletado) — **não é meu.**

---

## 3. Saída real de build e testes

### `npm run build` (o comando do deploy)

```
> orgulhoregional@1.0.0 build
> npm --prefix admin install && npm --prefix admin run build

vite v5.4.20 building for production...
✓ 932 modules transformed.
dist/assets/index-DOOB726M.js                   298.44 kB │ gzip:  98.33 kB
dist/assets/ComposedChart-Cb9cpxSh.js           387.35 kB │ gzip: 112.43 kB
✓ built in 2.20s
```

### `npm test` (Postgres efêmero + migrations do zero + suíte completa)

```
Migrations complete!
ℹ tests 325
ℹ suites 0
ℹ pass 325
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10668.525958
```

`skipped 0` é o número que interessa. Era 6.

### `npm run migrate:up` num banco vazio

```
### MIGRATION 1789509600000_baseline-schema (UP) ###
### MIGRATION 1789509660000_backfill-pedidos-json (UP) ###
### MIGRATION 1789509720000_backfill-payment-status-portugues (UP) ###
### MIGRATION 1789509780000_backfill-public-token-media (UP) ###
### MIGRATION 1789509840000_integration-secrets (UP) ###
Migrations complete!
```
Resultado: **47 tabelas**, 5 linhas em `pgmigrations`.

### `migrate:down` → `migrate:up` (critério de saída 1)

```
DROP TABLE IF EXISTS integration_secrets;
DROP TABLE IF EXISTS integrations;
DELETE FROM "public"."pgmigrations" WHERE name='1789509840000_integration-secrets';
Migrations complete!
--- after down ---  secrets | integrations →  (null) | (null)
--- up again ---    Migrations complete!  →  integration_secrets
```

### `migrate:dry` e reaplicação

```
dry run
No migrations to run!
Migrations complete!
```

---

## 4. O ciclo de prova do harness, por classe crítica

**Como a violação é introduzida.** Não é uma flag no código de produção (`if (QUEBRA) ...`) — isso
provaria a flag, não o invariant. O `lib/` real é copiado para um diretório temporário, **o defeito
histórico é escrito por cima do arquivo copiado**, e o **mesmo arquivo de teste** roda contra a cópia
via `INVARIANT_SUBJECT_ROOT`. O repositório nunca é modificado, e há um teste que verifica isso.

O runner também exige que o processo filho tenha **executado testes de verdade** (`# tests N > 0`),
não só saído com 0 — ver o blocker B-2 abaixo, que é exatamente esse modo de falha e aconteceu.

| Classe | Invariant | Violação introduzida | 1 passa | 3 **FALHA** | 5 volta a passar |
|---|---|---|:--:|:--:|:--:|
| **tenancy/ownership** | **INV-09** | `lojaAtribuidaPadrao()`: `if (sem dono && candidatas.length === 1) return candidatas[0]` — `server.js:11873-11876` | ✔ | ✔ | ✔ |
| **auth** | INV-02 | `resolveOrganization` passa a ler `req.headers['x-organization-id']` | ✔ | ✔ | ✔ |
| **entitlement** | INV-23 | `catch` da fonte de entitlements devolve `true` — o fail-open de `server.js:13390` | ✔ | ✔ | ✔ |
| **secrets** | INV-13 | `listarMetadata` passa a devolver o `ciphertext` junto da metadata | ✔ | ✔ | ✔ |
| **webhook** | INV-15 | `identifyInkWebhookStore()`: varre as conexões testando cada segredo — `server.js:1280-1291` | ✔ | ✔ | ✔ |

```
✔ tenancy/ownership  INV-09  passa → viola → FALHA → restaura → passa
✔ auth               INV-02  passa → viola → FALHA → restaura → passa
✔ entitlement        INV-23  passa → viola → FALHA → restaura → passa
✔ secrets            INV-13  passa → viola → FALHA → restaura → passa
✔ webhook            INV-15  passa → viola → FALHA → restaura → passa
```

### O caso INV-09, explicitamente

O teste semeia **uma única Organization** e um recurso sem dono, e assere que o banco tem
exatamente uma antes de continuar. Com o defeito aplicado, o helper devolve essa organization e o
invariant reprova. Sem ele, lança `OwnershipUnresolvedError`.

O banco de produção, com três lojas, **não pega esse defeito**: com três candidatas, o fallback
devolve `null` e parece correto. É por isso que `lojaAtribuidaPadrao()` sobreviveu à auditoria, e é
por isso que o default do harness é `semearOrganizations(pool, 1)`.

O invariant também roda com **duas** organizations, para provar que a regra não depende da contagem.

---

## 5. Matriz de boot medida (TD-003)

| # | Configuração | exit | Mensagem |
|---|---|:--:|---|
| 1 | produção, sem `DATABASE_URL` | **1** | `DATABASE_URL ausente e DATA_STORE_MODE=postgres (padrão)` |
| 2 | **dev**, sem `DATABASE_URL`, sem declarar modo | **1** | mesma — a ausência não declara nada |
| 3 | produção + `DATA_STORE_MODE=ephemeral-json` | **1** | `proibido em produção` — declarar não é autorizar |
| 4 | `DATA_STORE_MODE=memory` | **1** | `inválido. Valores aceitos: postgres, ephemeral-json` |
| 5 | produção sem `ENCRYPTION_MASTER_KEY` | **1** | `independente de ADMIN_SESSION_SECRET (TD-004) e obrigatória` |
| 6 | produção + banco **sem migrations** | **1** | `tabela pgmigrations ausente` — e **não chega a escutar** |
| 7 | produção, banco migrado, chave presente | escuta | `[POSTGRES] conexão e migrations verificadas` → `na porta …` |
| 8 | dev + `ephemeral-json` declarado | escuta | avisa que é modo de desenvolvimento |

O caso 2 é o ponto da decisão: **a inferência foi eliminada, não relaxada.** Rodar sem banco exige
`DATA_STORE_MODE=ephemeral-json`, em qualquer ambiente.

---

## 6. Os 6 testes destravados

Todos rodam agora, e **os 42 casos dentro deles nunca haviam executado**:

| Arquivo | Casos | O que passou a ser coberto |
|---|:--:|---|
| `test/creative-core-pg.test.js` | 1 | **o único teste de isolamento por tenant do repositório** |
| `test/meta-schema.test.js` | 11 | schema Meta, idempotência do baseline, ponta a ponta |
| `test/google-ads-schema.test.js` | 10 | "nunca duas contas selecionadas", sync idempotente |
| `test/google-ads-midia-sql.test.js` | 4 | gasto contado uma vez apesar dos 4 recortes |
| `test/custos-api-sql.test.js` | 7 | recorte de período em fuso, `FILTER`, `SUM` com NULL |
| `test/recuperacao-fila.test.js` | 9 | fila × compra — casamento telefone↔pedido |

Dois deles precisaram de ajuste, porque **recortavam o DDL de dentro do `server.js`** com `indexOf`
(`meta-schema`, `google-ads-schema`). A intenção original — "rodar contra o DDL real, nunca contra
uma cópia que envelheceu" — foi preservada: passaram a ler `migrations/sql/0001-baseline-schema.sql`,
via `test/helpers/schema-sql.js`. Sem esse ajuste, eles quebrariam ao remover o DDL do boot.

---

## 7. Blockers encontrados

### B-1 · `npm test` era verde com 6 testes que nunca rodaram *(resolvido)*
O sintoma exato que o plano chama de silêncio. Resolvido com Postgres efêmero, e o harness de
invariants **não se pula**: sem `INVARIANTS_DATABASE_URL` ele falha com instrução, em vez de pular.

### B-2 · o fail-fast do boot saía com **exit code 0** *(encontrado por medição, resolvido)*
`server.js` instala `process.on('uncaughtException')` como rede de segurança geral. Esse handler
**também captura o throw durante a avaliação do próprio módulo**. Sem tratamento explícito, a falha
de configuração virava uma linha de log, `app.listen` nunca era alcançado, o event loop esvaziava e
o processo terminava com **0** — "encerrou normalmente". O Railway não abortaria o deploy.

Medido antes da correção:
```
EXIT CODE: 0 SIGNAL: null
[UNCAUGHT_EXCEPTION] DatabaseConfigError: DATABASE_URL ausente e DATA_STORE_MODE=postgres ...
```
Corrigido com `try/catch` + `process.exit(1)` explícito. **Vale como aviso para as fases seguintes:
neste processo, `throw` no topo do módulo não derruba nada.**

### B-3 · o primeiro negative control passava sem rodar teste nenhum *(encontrado, resolvido)*
O runner do Node injeta `NODE_TEST_CONTEXT` em processos filhos; ao vê-la, o filho decide que já
está dentro de uma execução (`skipping running files`) e **sai com 0 sem rodar nada**. O negative
control lia esse 0 como "o invariant passou com a violação" e reprovava por engano — mas o modo de
falha inverso é pior, e é o do plano: um harness que lê 0 de um processo que não executou nada.
Resolvido removendo a variável **e** exigindo `# tests N > 0` em cada um dos passos 1, 3 e 5.

### B-4 · o processo escutava antes de verificar o schema *(resolvido)*
Com um banco sem migrations, o log saía na ordem `na porta 45876` → erro → exit 1. Janela de
milissegundos em que o healthcheck responde OK e o balanceador pode mandar tráfego para um processo
que está morrendo. `app.listen` passou a ser encadeado após `verificarPostgresOuMorrer()`.

### B-5 *(LOW, não resolvido)* · jobs consultam o banco antes da verificação de boot
No caso 6 da matriz, antes do exit aparecem:
```
[PIX_LEMBRETE] falha na rede de segurança inicial: relation "app_config" does not exist
[CARRINHO_PERSISTENCIA] falha na rede de segurança inicial: relation "app_config" does not exist
```
São timers/rotinas de startup que rodam na avaliação do módulo, antes da verificação. **Não
bloqueiam**: o processo sai com 1 de qualquer forma e nada é escrito. O endereço próprio disso é a
Fase 5c (**B-10 / TD-006**, jobs iterando `organizations` com leasing persistente), não a Fase 0.

---

## 8. Pendências e pré-requisitos operacionais

### OPS-11 *(já previsto no plano)* — **antes** do primeiro deploy com migrations
Railway → *Pre-deploy Command* = `npm run migrate:up`. Não há manifesto de deploy no repositório,
então é configuração de painel. **Não fiz — não toco o Railway.**

### OPS-12 *(novo, e é gate de deploy)* — `ENCRYPTION_MASTER_KEY`
Consequência direta de TD-004: sem ela, **o boot em produção falha** (caso 5 da matriz). É
deliberado — a alternativa seria descobrir a falta às 3h da manhã, uma integração por vez. Definir
**antes** de subir esta mudança:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### OPS-13 *(novo, e tem ordem obrigatória)* — janela legacy
Os ciphertexts que estão em produção hoje (`meta_connections`, `ga_connections`,
`google_ads_connections`) foram cifrados com a chave derivada de `ADMIN_SESSION_SECRET`. Para
continuarem legíveis **durante a janela**, definir também:
```
ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1
```
⚠️ **Enquanto essa flag estiver ligada, `ADMIN_SESSION_SECRET` continua sendo material sensível e
NÃO pode ser rotacionado.** O boot avisa isso no log. A flag sai na release seguinte à validação da
re-cifra — **datada, não "quando não precisar mais"**.

Sem a flag, as integrações conectadas hoje aparecem como "reconecte". Com ela, seguem funcionando.

### Pendente por desenho — **não é dívida, é a Fase 4**
A re-cifra dos segredos existentes para `integration_secrets` **não foi feita**. A tabela foi criada
(é o que a Fase 0 pede), o chaveiro e o repositório existem e estão testados, mas mover os
ciphertexts é `PD-019`: acontece **depois** que a leitura já passa pela nova camada. Fazer agora
inverteria a ordem do plano.

### Dívida real criada pela própria Fase 0
1. `migrations/sql/0001-baseline-schema.sql` carrega índices e tabelas que a Fase 1 vai refazer
   (`meta_connections` com `CHECK (id = 1)`, UNIQUEs sem `organization_id`). É intencional: o
   baseline registra o estado **atual**, não o desejado. A Fase 1 corrige por migration aditiva.
2. `integrations.organization_id` e `integration_secrets.organization_id` são **nullable e sem FK** —
   `organizations` só existe na Fase 1. O índice único já inclui a coluna (com `NULLS NOT DISTINCT`)
   para não precisar ser reconstruído depois.
3. `lib/platform/*.js` ainda não está ligado a nenhuma rota. É contrato + sujeito de invariant.

---

## 9. Próximo passo, sem precisar de confirmação nova

**Ligar `checkEntitlement` ao backend, como middleware, numa rota de cada vez.**

É o único item da Fase 3 que **não depende da Fase 1**: não precisa de `organizations`, não precisa
de `organization_id` em tabela nenhuma, e a fonte de entitlements já existe
(`app_config.chave = 'entitlements'`). O invariant já está verde e já reprovou a versão fail-open —
o que falta é substituir `{ ...ENTITLEMENTS_DEFAULT, ...entitlements }` (`server.js:13390`) por
`requireEntitlement(...)` e remover os `DEFAULTS` todos-`true` do frontend
(`admin/src/state/entitlements.ts:14-22`). Fecha **B-04** e **F-10** sem antecipar a Fase 1.

Se preferir manter a ordem estrita do plano, o passo seguinte é **TD-001** (§10) — fechá-la é o
pré-requisito literal da primeira migration de tenancy.

---

## 10. TD-001 — proposta final *(documentação apenas, nada implementado)*

> Registrada aqui porque não posso escrever em `productization-decisions.md` — o lead está editando
> essa pasta. **Transcreva para TD-001 quando consolidar.**

### Recomendação, inalterada pela execução da Fase 0

```text
Opção A — schema compartilhado
  + organization_id obrigatório (NOT NULL) em toda tabela tenant-scoped
  + RLS habilitada E forçada, como defesa em profundidade
  + testes automáticos de isolamento (Org A × Org B + tentativa explícita de acesso cruzado)
```

### O que a execução desta fase acrescenta como evidência

1. **Migration única é operacionalmente barata, e isso foi medido.** O baseline completo (47 tabelas,
   ~1.010 linhas de DDL) aplica em **~350 ms** num banco vazio, e reaplicar é no-op. A Opção B
   (schema por tenant) multiplicaria isso por N e transformaria cada `migrate:up` numa operação com
   janela e falha parcial — com `pgmigrations` por schema, "aplicado" deixaria de ser um booleano.
2. **A infraestrutura da Fase 0 é agnóstica, mas não é neutra no custo.** `node-pg-migrate`,
   `DATA_STORE_MODE` e o chaveiro funcionam nas três opções. O que muda é o **pre-deploy**: com A,
   é um comando; com B, é um laço sobre tenants que precisa ser idempotente, retomável e observável —
   e isso não existe.
3. **O harness já está construído em cima de A.** Os fixtures usam um discriminador por linha
   (`harness_recursos.organization_id`). Migrar o harness para B significaria reescrevê-lo.

### Por que a RLS não é redundante com `organization_id`

`INV-07` é o invariant mais valioso do plano por uma razão específica, e a execução desta fase
reforçou: a Fase 0 mostrou **dois** defeitos reais (B-2 e B-3) em que o sistema saía com sucesso sem
ter feito o trabalho. O modo de falha desta base não é erro alto — é **silêncio**. Uma query que
esquece o `WHERE` é exatamente isso: devolve linhas, ninguém percebe.

RLS transforma "esquecemos um `WHERE`" de vazamento silencioso em linha ausente. É a única proteção
que continua valendo quando a disciplina humana falha — inclusive **durante** as Fases 1-5, que são
feitas de dual-read/write e caminhos de fallback mantidos por uma release, ou seja, precisamente as
condições que produziram `F-01` (a mesma regra implementada duas vezes com rigor diferente).

### Pontos que a decisão precisa fixar quando for fechada

| # | Ponto | Recomendação |
|---|---|---|
| 1 | Role da aplicação | role **não-superusuário e sem `BYPASSRLS`**. Com `BYPASSRLS`, a RLS existe e não faz nada — e o teste passaria |
| 2 | `FORCE ROW LEVEL SECURITY` | obrigatório: sem ele, o **dono** da tabela escapa da policy, e o dono costuma ser a role de migration |
| 3 | Transporte do contexto | `SET LOCAL app.organization_id` por transação, definido no pipeline de `resolveOrganization`, **nunca** por variável de processo (INV-10) |
| 4 | Pool e `SET LOCAL` | `SET LOCAL` morre no fim da transação. Com pool e auto-commit, uma query fora de transação não teria contexto — **fail-closed**: sem contexto, a policy não casa com nada |
| 5 | Tabelas globais | `custos_api_precos`, `segments`, `whatsapp_web_mensagens`, `utm_presets` ganham dono (B-17). Se alguma precisar ser genuinamente global, precisa ser **declarada** como tal, não ficar sem policy por omissão |
| 6 | Migrations e RLS | a role que roda migration precisa poder trabalhar sem a policy; separar `app_user` de `migration_user` |

### Risco principal desta recomendação

Não é desempenho — é a **falsa sensação de cobertura**: habilitar RLS e concluir que o isolamento
está resolvido. RLS protege a **query**; não protege um handler que resolve o tenant errado *antes*
de consultar. `INV-01`, `INV-02` e `INV-09` continuam sendo necessários, e RLS não substitui nenhum.

A mitigação prática é o teste do critério de saída 2 da Fase 1: `SELECT * FROM <tabela>` **sem
`WHERE`**, sob a role da aplicação, com duas Organizations semeadas — se voltar linha das duas, a
RLS está desligada ou a role tem bypass, e nenhuma quantidade de `WHERE` correto compensa isso.

---

## 11. Como reproduzir

```bash
npm ci --ignore-scripts        # node-pg-migrate é dependência NORMAL
npm test                       # sobe Postgres efêmero, migra do zero, roda tudo
npm run test:invariants        # só os invariants + negative controls
npm run build                  # o comando do deploy

npm run db:start               # deixa o banco de pé e imprime a URL
npm run db:stop
```

Requisito: **Docker**. Em CI com Postgres de serviço, defina `TEST_DATABASE_URL` e o Docker é
ignorado (é o que `.github/workflows/ci.yml` faz).
