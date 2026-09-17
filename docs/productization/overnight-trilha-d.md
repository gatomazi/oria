# Rodada 18 · Trilha D — Second Tenant Gate executável e prontidão de release

Painel, worktree destacado a partir de `bfd00a6`. **Sem push, sem deploy, sem Railway, sem banco de
produção, sem segredo real.**

- Nada foi executado em produção.
- Nenhum OPS foi marcado como verificado.
- `productization-plan.md`, `productization-progress.md` e `productization-decisions.md` não foram
  editados: a consolidação é do lead.

## 1. Entregas

| entrega | onde | comando |
|---|---|---|
| gate executável (§27-29) | `scripts/productization/gate.mjs`, `gate-lib.mjs`, `gate-suite.mjs`, `gate-reporter.mjs` | `npm run productization:gate` |
| preflight de release (§32) | `scripts/release/preflight.mjs` | `npm run release:preflight` |
| suíte sob oria_app (§36) | `scripts/test-db.mjs` (modo `TEST_APP_ROLE=1`) | `npm run test:app-role` |
| runbook único (§30-31) | `docs/produtizacao-saas/production-rollout-runbook.md` | — |
| testes | `test/invariants/productization-gate.test.js` (31), `release-preflight.test.js` (8), `app-role-suite.test.js` (4) | parte do `npm test` |

## 2. `productization:gate`

### 2.1 Blocos

**CODE GATES** — 16 checks.

A suíte completa roda num Postgres efêmero próprio, via `scripts/test-db.mjs`. Um reporter do
`node --test` grava cada teste com o arquivo de origem, porque o TAP não informa o arquivo de um
teste que passou. Os checks:

| check | como é verificado |
|---|---|
| npm test completo | exit code, falhas, piso de 753 testes |
| all invariants PASS | cada `test/invariants/*.test.js` precisa ter rodado, sem falha nem pulo |
| no skipped critical tests | `skip`, `todo` e `cancelled` = 0 na suíte inteira |
| no tenant selector | reaproveita `fase3-static` contra `--root` (os 3 testes pelo nome exato) |
| no cross-org aggregation | `fase3-static` (INV-10, F-02) + arquivos A/B da suíte |
| RLS schema valid | arquivos `tenancy-schema`, `td001-rls-contract`, `tenancy-db-negative-controls`, `tenancy-migrations` |
| app role contract | `app-role.js` gerado e inspecionado (atributos, privadas revogadas); `server.js` verifica a role com a flag; `fase3-server-ab` e os dois testes de boot da flag |
| integration env fallback state | flag desligada por padrão e só `1` liga (checado carregando o código); teste INV-12 do fallback |
| legacy admin auth state | idem para `ALLOW_LEGACY_ADMIN_PASSWORD`, e produção recusa segredo de sessão curto |
| Go contract fixtures aligned | as duas cópias byte a byte iguais; `fase5b-*` e o E2E `fase5c-e2e-whatsapp` verdes |
| Go 5b/5c contract version | versão declarada no gate (`oria-whatsapp-sender` v1, `oria-whatsapp-context` v1) = painel = Go; o código Go referencia os headers e as rotas do contrato |
| Go vet/build/test -race | rodados pelo gate no repositório do Go, com banco próprio no mesmo Postgres efêmero. Qualquer pulo, exceto o processo-filho `TestQueueWorkerProcess`, reprova |
| no global tenant credential request-path usage | `fase3-static` INV-12 |
| no unsafe TRUNCATE tenant tables | `fase3-static` (app) + varredura nova de `scripts/` e `migrations/` contra o manifesto. TRUNCATE dinâmico reprova |
| no legacy Ink runtime route | `fase3-static` + regex nova: só `app.post('/api/webhooks/ink/:token'`; `app.all/get/use('/api/webhooks/ink')` reprova |
| no default sender env | painel (server/lib/routes) e Go (código não-teste) não citam `META_PHONE_NUMBER_ID/ACCESS_TOKEN/WABA_ID` nem `WHATSAPP_LEGACY_*` |

**OPS GATES** — OPS-01..35.

- OPS-01..10 vêm do SECOND TENANT GATE do plano.
- Só contam como VERIFIED (ou NOT APPLICABLE com `reason`) com um arquivo
  `docs/produtizacao-saas/ops-evidence/OPS-XX.json`, no formato `oria-ops-evidence/v1` (runbook §2).
- Ausência = NOT VERIFIED.
- É FAIL quando a evidência é inválida: status diferente, sem campos, ambiente que não é `production`, campo com nome
  sensível ou valor com cara de credencial.
- OPS-06/07/08 continuam NOT VERIFIED no gate: a rodada 8 os registrou só em texto.

**DOGFOOD GATE** — `DOGFOOD.json`.

| situação | status |
|---|---|
| sem arquivo | NOT STARTED |
| em andamento | IN PROGRESS |
| < 14 dias ou incidente aberto | FAIL |
| ≥ 14 dias, `open_incidents: 0` | COMPLETED |

### 2.2 Exit code

| exit | quando |
|---|---|
| 0 | padrão: CODE PASS + todos os OPS VERIFIED/N.A. + dogfood COMPLETED. Com `--code-only`: CODE PASS |
| 1 | CODE com qualquer FAIL ou NOT VERIFIED |
| 2 | CODE PASS, OVERALL BLOCKED (só sem `--code-only`) |
| 64 | uso inválido (inclui `--root` sem `--skip-suite`) |

### 2.3 Opções

| opção | efeito |
|---|---|
| `--skip-suite` | só as checagens estáticas; os checks da suíte ficam NOT VERIFIED, logo o exit é 1 |
| `--no-go-tests` | não roda os testes Go |
| `--go-dir` | repositório do Go |
| `--go-report` / `--emit-go-report` | relatório `oria-go-gate-report/v1` (hashes, versões, ausência de remetente de ambiente, resultado dos testes Go com head) para quando o Go não está ao lado. Relatório de outro commit reprova os testes Go |
| `--evidence-dir` | diretório de evidências OPS/dogfood |
| `--root` | raiz avaliada pelas checagens estáticas |
| `--json` | relatório em JSON |
| `--verbose` | detalhes de todos os checks |

### 2.4 Controles negativos

- Avaliação pura com eventos sintéticos:
  - teste pulado (E2E do Go), `todo`, cancelado, falha, exit ≠ 0;
  - piso de testes;
  - arquivo de invariant que não rodou, teste esperado renomeado;
  - Go pulado, sem `-race`, de outro commit;
  - relatório do Go com formato, hash ou versão divergentes.
- Exit code:
  - CODE PASS com OPS pendente → 2; `--code-only` → 0;
  - CODE FAIL com `--code-only` → 1;
  - READY só com os 35 OPS e dogfood; remover o `OPS-27.json` volta a 2.
- 11 formas de evidência OPS inválida → FAIL, nunca VERIFIED.
- **15 ciclos de 5 passos da CLI** contra uma cópia de `server.js`/`lib`/`routes`/`scripts`/`migrations`/
  fixtures e um repositório Go sintético. Cada ciclo: passa → viola → FAIL → restaura → passa. Violações:
  1. `req.query.loja`;
  2. `multiStoreMode`;
  3. `TRUNCATE` num script;
  4. `TRUNCATE` dinâmico numa migration;
  5. `app.all('/api/webhooks/ink')`;
  6. `process.env.META_PHONE_NUMBER_ID` no painel;
  7. `os.Getenv("META_ACCESS_TOKEN")` no Go;
  8. fixture divergente no Go;
  9. header do contrato ausente no Go;
  10. versão do contrato 2 no painel;
  11. `process.env.INK_TOKEN`;
  12. `BYPASSRLS` no `app-role.js`;
  13. verificação de role desligada no `server.js`;
  14. fallback de integração ligado por padrão;
  15. login legado ligado por padrão.

## 3. `release:preflight`

Somente leitura.

| confere | como |
|---|---|
| variáveis | só o nome e "atende o requisito: sim/não" |
| flags legadas | por estágio (`release-n`, `after-ops14`, `cleanup`) |
| variáveis de tenant a remover | pelo nome |
| role de migration separada | só booleanos |
| contrato da role | no código e, com banco, na role real do `DATABASE_URL` |
| versão do schema | numa transação `READ ONLY`: pendentes, desconhecidas, `MIGRATION_MINIMA`, PostgreSQL ≥ 15 |
| mapeamento de tenancy | validado com a mesma lib da migration, sem aplicar |
| scripts do runbook | presentes no `package.json` |

- `--service go` avalia o ambiente do Go:
  - resolver https;
  - `META_GRAPH_BASE_URL` proibida;
  - `META_*`, `REPLY_*` e `LEGACY_ORGANIZATION_ID` como limpeza.
- `--from-env-file` lê um export `KEY=VALUE`. O nome não é `--env-file` porque o próprio `node` intercepta
  `--env-file` mesmo depois do script: com arquivo inexistente ele sai 9, e com arquivo existente
  carrega o arquivo no ambiente do processo.
- Erros de banco saem só com o código (ex.: `ECONNREFUSED`). Exceção inesperada sai com mensagem
  genérica.

Controles negativos:

- valores marcados (senhas de URL, usuários, chaves, tokens, e-mail, host) não aparecem no texto nem
  no JSON, inclusive com erro de conexão;
- uma cópia do script que imprime o valor é pega pelo detector (5 passos);
- com banco real:
  - dona no lugar do app depois do OPS-14 → BLOCK;
  - migration no banco desconhecida do repositório → BLOCK;
  - `pgmigrations` inalterada ao fim.

## 4. Suíte sob `oria_app` (`npm run test:app-role`)

**Antes:** não existia modo de rodar a suíte com o app conectando como `oria_app`. Já rodavam sob
`oria_app`:

- os testes de processo `fase3-server-ab`, `fase4-server-integrations`, `fase5b-server-whatsapp`, `fase5c-e2e`, `fase5c-leases`;
- os testes de lib `fase3-tenant-context`, `fase4-integrations`, `fase5b-whatsapp-sender`, `auth-flow`, `tenancy-*`, `td001`;
- o boot com `DB_ENFORCE_APP_ROLE=1`.

Esses testes usam `INVARIANTS_APP_DATABASE_URL` ou provisionam role própria. O resto recebia a URL dona
(`DATABASE_URL`, `*_TEST_DATABASE_URL`).

**Modo novo:** com `TEST_APP_ROLE=1`, o `test-db.mjs` entrega `oria_app` em `DATABASE_URL`,
`TEST_DATABASE_URL` e `CREATIVE_TEST_DATABASE_URL`, e liga `DB_ENFORCE_APP_ROLE=1`.

**Primeira execução, sem ajustes nos testes: 669/710, 41 falhas.** Investigado: todas vinham de seis
arquivos que escrevem sem contexto de tenant (a RLS recusa, corretamente) ou criam tabela/banco
(sem permissão, corretamente):

- `creative-core-pg`;
- `custos-api-sql`;
- `google-ads-midia-sql`;
- `google-ads-schema`;
- `meta-schema`;
- `recuperacao-fila`.

Nenhuma falha em código de request.

Ajustes:

- `creative-core-pg`: o `pgStore` (código real da aplicação) passa a rodar, no modo app-role, como no
  `server.js`:
  - `oria_app`;
  - fachada `criarPoolTenant`;
  - contexto da Organization de cada chamada.

  Fixture e limpeza continuam com a dona.
- `auth-server`: no modo app-role, o `server.js` sobe com uma role de aplicação própria e a
  verificação de boot ligada. Antes ele subia como superusuário.
- Os outros cinco arquivos testam **SQL copiado e DDL própria**, não código de request. Continuam com
  a dona (`META_TEST_DATABASE_URL`, `GOOGLE_ADS_TEST_DATABASE_URL`), por declaração fechada em
  `app-role-suite.test.js`, que reprova:
  - se outro arquivo passar a usar essas URLs;
  - se um deles carregar código da aplicação com banco.
- Também continuam donos, por natureza, os caminhos de fixture do harness (`INVARIANTS_DATABASE_URL`):
  - criar banco descartável, provisionar role, semear;
  - `inv-02`, que só usa as tabelas `harness_`;
  - `inv-13`, que exercita o secret store com pool dono. O A/B de integrações sob `oria_app` é coberto
    por `fase4-integrations`.

**Resultado real:** `npm run test:app-role` = **753/753 pass, 0 skipped**. Destes, **41 testes** (em
5 arquivos de schema/SQL) rodam com a dona **por declaração**; o restante recebe as URLs da
aplicação como `oria_app`.

O modo padrão (`npm test`) não mudou de comportamento.

## 5. Runbook

`production-rollout-runbook.md` segue a ordem BEFORE RELEASE → releases A..F (cada uma com PRE-DEPLOY
e VERIFY) → ROLLBACK → CLEANUP → dogfood/onboarding. Tem ainda uma matriz OPS → passo.

**Divergências resolvidas** (runbook §11), sem editar as fontes:

1. OPS-27 vem antes de tudo, não depois da configuração do remetente:
   - bloqueia qualquer release da 5b, e a primeira é o Go aditivo;
   - o OPS-29 importa o que o OPS-27 identifica.
2. O cutover da Ink vem logo após o painel R1, antes do Go R2: o R1 remove a rota legada, e o Go R2
   depende do R1.
3. O painel precisa de três commits (P2 `31a7cdb` → P3 `3adad08` → HEAD) para respeitar ao mesmo
   tempo:
   - a "release N" do plano;
   - as Releases B/C da 5b;
   - a pré-condição da 5c.

   Juntar é **[DECISÃO]**.
4. Leases não têm OPS próprio: são verificação antes do OPS-14.
5. OPS-06/07/08 precisam ser re-registrados no formato de evidência.

**Pontos marcados [A CONFIRMAR NA CONSOLIDAÇÃO]:**

- `tenant1:*` (trilha A) nos passos 6.1-6.4;
- onboarding/`SECOND_TENANT_ENABLED` (trilha B) em VERIFY D e §14;
- header de repasse e aceitação durável do Go (trilha C) em §4.2 e na RELEASE E;
- janela de 404 dos criativos (OPS-22).

## 6. Arquivos compartilhados tocados

- `package.json`: três scripts (`productization:gate`, `release:preflight`, `test:app-role`), depois de
  `test:invariants`.
- `scripts/test-db.mjs`: só `envDeTeste`. No modo padrão, as variáveis e os valores são os mesmos de
  antes, mais `TEST_OWNER_DATABASE_URL`.
- `test/creative-core-pg.test.js` e `test/invariants/auth-server.test.js`: ramo `TEST_APP_ROLE`. O modo
  padrão não mudou.
- **Não tocados:**
  - `server.js`;
  - `lib/`;
  - migrations e listas de migrations;
  - `app-role.js`;
  - manifesto;
  - `negative-controls.test.js`.

## 7. Riscos e pendências

- **Piso de testes do gate:** `MINIMO_DE_TESTES = 753`. Com os commits das outras trilhas a suíte cresce
  e o piso continua válido. Se a consolidação **remover** testes, o piso precisa ser revisto
  conscientemente.
- **Versões de contrato:** declaradas no gate (`CONTRATOS_GO`). Se a trilha C versionar um contrato novo
  (header de repasse), atualizar ali. O gate reprova até isso ser feito, e esse é o comportamento
  desejado.
- **Testes Go no gate:**
  - rodam no repositório indicado por `WHATSAPP_GO_DIR`/`--go-dir` (leitura; `go build -o /dev/null`);
  - com mudanças locais, o head aparece como `+dirty`;
  - para o gate valer para a trilha C, apontar para o worktree Go dela.
- **Evidência OPS:** o formato é do gate. O diretório `ops-evidence/` não foi criado; há um teste que
  garante que ele não traz `.json` nesta fase.
- **Preflight:**
  - não substitui o OPS-27 (que exige a Meta real) nem nenhum OPS de console (Railway, Meta, Ink);
  - o estágio `release-n` bloqueia a ausência de `TENANCY_MAPPING_FILE` e das variáveis de bootstrap e
    seed, que só são necessárias no ambiente do pre-deploy. Rodar com o export desse ambiente.
- **Decisões do usuário, não tomadas aqui:**
  - PD-019 (A/B);
  - qual Organization fica com o número WhatsApp atual;
  - features do seed;
  - release do painel antes do OPS-27;
  - juntar as releases B e C;
  - ordem de troca do `ADMIN_SESSION_SECRET`, se ele for curto hoje.

## 8. Saídas reais (worktree, rodada 18)

Resumo do `productization:gate --verbose`, com o Go em `445ead9` e todas as mudanças da trilha:

```text
CODE GATES: PASS (16/16)
  suíte 753 testes · 753 pass · 0 fail · exit 0 · skipped 0 · todo 0 · cancelled 0
  go vet 0 · go build 0 · go test -race: 105 pass, 0 fail, 0 skip · head 445ead9
OPS GATES: 35 de 35 pendentes (OPS-27 NOT VERIFIED)
DOGFOOD GATE: 14 days NOT STARTED
CODE: PASS
OVERALL: BLOCKED
exit 2
```

`release:preflight --no-db` no ambiente local (sem variáveis de produção):

- `BLOCKED (11)`, exit 1;
- variáveis de release N ausentes e mapeamento não definido;
- contrato da role OK (58 tabelas sob RLS, 13 funções);
- scripts do runbook disponíveis.

Com um export fictício completo: `NO BLOCKERS`, exit 0. O mesmo export no estágio `cleanup`:
`BLOCKED (6)`.
