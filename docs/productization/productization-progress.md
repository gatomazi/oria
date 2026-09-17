# Productization Progress

## Current phase

**Rodada 21 (17/09/2026): OPS-27 VERIFIED e alvo de infraestrutura fechado. Nada publicado.**
**CODE READY · ROLLOUT BLOCKED · FASE 6 NOT CLOSED.**
Branches **`feature/produtizacao-saas`** no painel e no Go; o produto vive no monorepo `oria`. Sem
push, sem deploy; a `master` não foi tocada.

| | estado |
|---|---|
| Fases 0 a 5c — implementação local | ✅ CLOSED |
| Fase 6 — Tenant #1 | 🟡 **CODE READY** · alvo **cenário B** (Use Origens) · **NÃO CLOSED** |
| Fase 7 — onboarding | 🟡 backend construído · `SECOND_TENANT_ENABLED` desligada · sem rota/UI |
| Runbook | ✅ ordem única A → B → C → D0 → E → D' → F → CLEANUP → OPS-36 → dogfood; dry-run local encadeado verde. A **sequência de releases** precisa ser redefinida para o alvo novo (runbook §20.3) |
| OPS-27 | ✅ **VERIFIED (17/09/2026)** — `ops-evidence/OPS-27.json` |
| `npm run productization:gate` | **OPS 35/36 NOT VERIFIED · DOGFOOD NOT STARTED · OVERALL BLOCKED.** Código: PASS na última execução completa (rodada 20); a rodada 21 rodou só `--report-only --skip-suite --no-go-tests`, que reporta CODE NOT VERIFIED por não executar a suíte |
| Alvo de infraestrutura | ✅ **projeto Railway novo `Oria`** (`oria-panel`, `oria-creatives`, `oria-whatsapp`; dois Postgres; volume só no painel). Projeto antigo = stack legada / rollback. **Nada criado ainda** |
| Rollout | ⛔ **BLOCKED** — infraestrutura nova não criada · 35 OPS sem evidência · nenhuma release publicada · dogfood NOT STARTED |
| Nada publicado | nenhum push, deploy, Railway, banco de produção, tenant externo ou dogfooding |

> **Rodada 20 (17/09/2026) — o produto mudou de casa, e só isso.** A productização passou a viver no
> monorepo **`oria`** (`apps/panel`, `apps/creative-generator`, `services/whatsapp`), importado como
> snapshot de `orgulhoregional@970290e` e `whatsapp-webhook-go@244bf45`. **Nenhum estado mudou naquela
> rodada:** Fase 6 CODE READY e NÃO CLOSED, rollout NO-GO, OPS-27 ainda NOT VERIFIED (resolvido na
> rodada 21), dogfood NOT STARTED. Os
> repositórios antigos continuam intactos; a proveniência está em
> `docs/architecture/source-migration-manifest.md`. Os comandos `npm run ...` deste documento rodam
> em `apps/panel` ou pelos atalhos da raiz (`npm run panel:test`, `npm run productization:gate`).

---

## Histórico da auditoria

**Rodada 6 (serviço `whatsapp-webhook-go`) — concluída.**

**Não há mais lacuna de cobertura.** Os dois repositórios do caminho crítico estão auditados:
o painel (rodadas 1-5) e o serviço Go (rodada 6).

**Resta uma incógnita arquitetural: PD-023 — a topologia de deploy do serviço Go.** Ela muda o
esforço daquele repositório em uma ordem de grandeza (XS ↔ L) e é **pré-requisito da Fase 5**.
Não bloqueia as Fases 0-4.

> **Correção de uma afirmação da rodada 4.** Eu havia dito que não restava incógnita arquitetural
> capaz de mudar as fases. **Estava errado.** O erro foi tratar "o que não auditei" como se não
> pudesse conter surpresa — ao mesmo tempo em que classificava o serviço Go como lacuna de
> cobertura. As duas coisas não podiam ser verdadeiras juntas. Registrado em PD-023.

**PARADO de propósito.** `productization-plan.md` **não** foi criado, nenhuma implementação foi
feita, nenhuma migration, nenhum schema ou código de negócio alterado. Só documentação.

## Completed

### Rodada 1 — auditoria factual (baseline `8a7ea3d`)

- Leitura das fontes de verdade e recon direto do núcleo P0.
- **7 workstreams em paralelo:** rotas (278) · schema/persistência (53 tabelas) ·
  auth/entitlements/internal tools/naming · integrações/secrets/OAuth/webhooks ·
  jobs/rate limits/marketing · creative-core/BYOK/assets/custos/storage ·
  financeiro-DRE/clientes-PII/testes/observabilidade/deploy.
- Revisão do lead: **2 afirmações de subagente corrigidas**.
- Produzidos: `productization-audit.md`, `productization-decisions.md`, `anexo-a-matriz-de-rotas.md`,
  `anexo-b-matriz-de-tabelas.md`.

### Rodada 2 — decisões do usuário aplicadas

- **3 → 6 decisões CLOSED (V1)**, 4 PARCIAL, 23 OPEN.
- Registrado o **escopo removido da V1**: R-01 (Migração Use Origens sai do produto) e
  R-02 (`multiStoreMode` e todo o multi-store).
- **Achado novo F-01** — investigação de código feita nesta rodada, a partir da ampliação de PD-016.
- Anexos A e B atualizados com as reclassificações; corrigida a linha de tabela do falso positivo
  de path traversal em `/assets/pedidos/:filename` (o cabeçalho já corrigia, a linha não).
- Corrigidas as duas ressalvas de implementação apontadas pelo usuário (QW-01 `trust proxy`,
  QW-04 `TRUNCATE` → `DELETE`).

### Rodada 3 — auditoria de ownership e escopo

- **3 workstreams em paralelo:** Meta/Google Ads · GA4/UTM/WhatsApp/Creative Core · varredura
  cross-cutting de antipadrões de descoberta de escopo.
- **12 achados** (F-01..F-12) classificados nas 6 categorias pedidas; **10 padrões-alvo** (G-01..G-10)
  registrados — categorias 1-3 documentadas junto com as ruins.
- **24 invariants verificáveis** (INV-01..INV-24) redigidos para virar teste ou lint, mapeados para
  as fases do roadmap.
- Confirmado por inventário de hosts externos que **Instagram, BigQuery e Mailchimp não existem** no
  código — nenhuma outra integração externa além de Ink, Meta, Google e OpenAI.
- 3 anexos novos publicados (C, D, E).

### Rodada 4 — discovery final

- **PD-022 fechada** na opção (a): a visão consolidada das 3 lojas é **eliminada antes da migração**,
  não realocada para platform admin. Premissa fixada: a tenant app é estritamente
  Organization-scoped e nenhuma rota dela agrega Organizations.
- **NOT VERIFIED fechados** (D-1..D-6): trust boundary do `creative-lab` · WABA/`phone_number_id` ·
  blobs `whatsapp-meta-app` / `meta-metas` / `whatsapp-template-config` · índices únicos das tabelas
  de integração · `desktop/` · `src/`.
- **2 invariants novos:** INV-25 (nenhum serviço externo detém identidade de tenant implícita) e
  INV-26 (nenhum serviço interno alcançável pela internet; healthcheck sem informação de sistema).
  Total: **26**.
- **F-01..F-12 revisados**: todos com dono, severidade hoje, severidade no 2º tenant, blocker e
  invariant. **Nenhum ficou sem invariant.**
- **2 dependências de sequenciamento** descobertas: verificação de rede do `creative-lab` antes da
  Fase 0; auditoria do `whatsapp-webhook-go` antes da Fase 5.

### Rodada 5 — fecho de D-1 e brief externo

- **D-1 VERIFIED / CLOSED** com evidência de infraestrutura do usuário:
  `CREATIVE_CORE_URL=http://creative-lab.railway.internal:8080`, e o serviço `creative-lab` **sem**
  Public Domain, Custom Domain ou TCP Proxy. O caminho Node → creative-lab é **exclusivamente
  privado**.
- **`/v1/health` sem auth rebaixado, não apagado**: deixa de ser blocker (não é alcançável de fora) e
  vira **H-01**, hardening opcional de prioridade baixa. Volta a importar se a rede mudar.
- **INV-26 reclassificado e removido da série INV.** Virou **OPS-01**. A série INV passa a ser
  declaradamente **só de CI**; controles de infraestrutura vivem num **checklist operacional**
  separado (OPS-01..OPS-05), verificado no deploy. Numeração INV vai até 25, sem INV-26.
- **Brief de auditoria do `whatsapp-webhook-go` escrito** — autocontido, entregável a uma sessão que
  não conhece este projeto.

### Rodada 6 — serviço `whatsapp-webhook-go`

- Auditoria executada por agente dedicado dentro de `/Users/gtomazi/projects/whatsapp-webhook-go`
  (HEAD `bf91ff1`), read-only, seguindo o brief. Repo auditado intacto. `go build`/`vet`/`test` limpos.
- **26 achados** consolidados como série própria **`WG-01..WG-26`** (não renumerados para dentro de
  `F-xx`): os `arquivo:linha` são relativos a repositórios diferentes, e uma série plana tornaria a
  referência ambígua justamente onde a precisão importa.
- **Veredito:** saída = **mudança de contrato (S–M)**, entrada = **reescrita (L)**, persistência =
  **migração de schema (M)**. A divisão é limpa o bastante para ser sequenciada.
- **Categoria 1 = zero.** Nenhum recurso do serviço é escopado por tenant. **0 CRITICAL/HIGH hoje;
  22 dos 26 viram CRITICAL ou HIGH no segundo tenant.**
- **12 invariants incorporados como INV-27..INV-38** (≡ INV-W1..W12), verificados no CI daquele repo.
- **5 blockers novos (B-22..B-26)**; **B-08 cresce** para cobrir o webhook da Meta.
- **5 itens operacionais novos (OPS-06..OPS-10)** — quatro valores de env de produção e a natureza do
  token da Meta.
- **PD-023 aberta:** topologia de deploy. É a correção da minha resposta da rodada 4.

### Rodada 7 — criação do plano

- `productization-plan.md` escrito conforme `claude-criar-productization-plan.md` (19 seções).
- **9 fases**, cada uma fechando por **invariants**, não por arquivos alterados.
- **SECOND TENANT GATE** explícito entre a Fase 6 e a criação de qualquer Organization externa:
  25 dos 26 blockers (B-18 é RBPL), os 12 findings do painel, os WG aplicáveis, os 37 invariants,
  os 10 OPS e ≥ 2 semanas de dogfooding.
- **PD-023 permanece OPEN**; a Fase 5c foi escrita com as duas variantes lado a lado.
- Séries preservadas: `F-01..F-12` e `WG-01..WG-26` separadas; `INV-01..INV-38` única.
- Classificação em quatro faixas (RBST / RBPL / PLH / FP) aplicada a todos os itens.

### Rodada 7 — fechamento da Fase 0

Plano aprovado pelo usuário. Rodada de decisão técnica, sem código.

- **TD-003 CLOSED (V1)** — Postgres obrigatório em produção; boot falha sem `DATABASE_URL` ou com
  bootstrap crítico falhando; fallback JSON/memory só em dev/test **declarado**, nunca inferido.
- **TD-004 CLOSED (V1)** — `ENCRYPTION_MASTER_KEY` independente de `ADMIN_SESSION_SECRET`,
  `key_version` junto do ciphertext, rotação incremental. Schema: **Opção A,
  `integration_secrets` dedicada** (1:N a partir de `integrations`), porque a cardinalidade real é
  N segredos com ciclos de vida distintos por integração, e porque mantém o ciphertext fora do
  caminho de leitura comum. Migração dos ciphertexts documentada com janela datada.
- **TD-010 CLOSED (V1)** — **`node-pg-migrate`**, após inspeção de `package.json`, driver, scripts,
  bootstrap, deploy e testes. Dependência **normal** (não dev). Migrations em `migrations/`,
  rodando em **pre-deploy** (OPS-11), **nunca no boot**.
- **TD-001 confirmada como próxima**, não fechada. Recomendação inalterada.
- **OPS-11 criado.** Checklist de consulta OPS-06/07/08 (+ OPS-10) redigida no plano, com contrato
  explícito de **não colar valores secretos**.
- Fase 0 do plano refinada: ciclo de validação do harness em **5 passos**, obrigatório para as cinco
  classes críticas, com o caso do **INV-09 sob uma única Organization** explicitado.

**Achado desta rodada, relevante para a implementação:** o repositório **já faz migração e backfill
no boot** — `bootstrapPostgres()` mais três `backfill*` (`server.js:118, 1138, 1153, 1168`),
encadeados sob um `.catch` que só loga (`server.js:1177-1181`). Não é código de inicialização: são
migrations disfarçadas, que rodam em toda subida e rodariam em **toda réplica**. Removê-las do boot
virou critério de saída da Fase 0 — sem isso, nem o pre-deploy nem o advisory lock valem.

### Rodada 8 — verificação OPS-06/07/08

Checklist executada pelo usuário no Railway (`whatsapp-webhook-go` → Variables), em **15/09/2026**.
Contrato respeitado: só `definido`/`não definido`, nenhum valor colado.

| # | Variável | Estado |
|---|---|---|
| OPS-06 | `META_APP_SECRET` | **definido** — adicionado nesta data; ⏳ **aguardando restart** |
| OPS-07 | `API_KEY` | ✅ **VERIFIED / OK** |
| OPS-08 | `DATABASE_URL` | ✅ **VERIFIED / OK** — persistência real, não memory store |

- **WG-26 e os achados que dependiam de memory store** (perda de eventos, fila e `problem_orders` a
  cada restart) ficam **resolvidos na prática** por OPS-08.
- **WG-06 rebaixado a LOW hoje** — neutralizado por configuração, não por código.
- **B-25 permanece blocker**, porque `if cfg.AppSecret != ""` (`webhook.go:136`) continua no código.
- **INV-30 reforçado**: passou a exigir **(a) fail-fast no boot** sem `META_APP_SECRET`, além de
  **(b)** rejeitar o request sem assinatura válida. É o que torna o conserto permanente.
- **Remediação registrada com data**, não apagada: até 15/09/2026 o serviço rodava em produção sem
  verificar assinatura da Meta. Bloco próprio no audit, com avaliação de consequência prática.

**Confirmado pelo usuário: não altera o critical path nem bloqueia a Fase 0.**

### Rodada 9 — negative testing ao vivo

Executado pelo usuário contra o serviço **publicado** (`bf91ff1`, código não alterado). **Primeira
evidência de runtime de toda a auditoria** — as 8 rodadas anteriores foram estáticas.

- **OPS-06, OPS-07 e OPS-08 → VERIFIED / OK.** OPS-06 fechou: boot 02:01:15 pós-redeploy com
  `sig_verify=true`, e o negative testing contra o processo novo devolveu 403/403/401/401/200.
- Estado e fila **sobrevivem ao restart**: 500 eventos e 244 itens de fila recarregados.
- **Topologia registrada como fato, não defeito:** o serviço tem domínio público — a Meta precisa
  alcançar o webhook. A implicação é *webhook público + internos fail-closed*, não redesenho.
- **3 achados novos:** **WG-27** (`auth()` e `dashAuth` fail-open sem `API_KEY`), **WG-28**
  (`dashAuth` aceita `?key=`), **WG-29** (`SourceWamid` não persistido).
- **1 padrão correto novo:** **WG-P-08** — `mustEnv` (`main.go:147-153`) já é o fail-fast certo,
  no próprio repositório. Terceiro caso de padrão certo convivendo com o errado.
- **Teste 6 confirmou ao vivo B-23:** `phone_number_id` estranho é aceito e processado. Assinatura
  autentica a **origem Meta**, não o **tenant**. Fica na 5c, não na 5a.
- **B-25 ampliado:** de um defeito para **três da mesma natureza** — `META_APP_SECRET`, `API_KEY`
  e `dashAuth`. Risco presente neutralizado por configuração; blocker permanece.
- **Nota operacional:** o evento `id=3376` **não deve ser apagado** — o único caminho é
  `/dashboard/events/clear`, que faz `DELETE FROM events` sem `WHERE` (`db.go:184`).

### Overnight 15→16/09 — Fase 5a + Fase 0

Ver [`overnight-report.md`](./overnight-report.md). Go `bf91ff1 → 6eb6274` (16 commits, 43 testes);
painel `8a7ea3d → a5bc84e` (5 commits, 325 testes, 0 pulados).

### Rodada 10 — revisão matinal, fechamento da Fase 0 e TD-001 (16/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-9-revisao-fechamento-fase-0-td001.md`.

**Checklist da Fase 0 verificado contra o código, não contra o relatório.** Duas lacunas reais:

1. **DDL no boot ≠ 0** — `routes/criativos.js` rodava o DDL do Gerador de Criativos no mount
   (`lib/creative-core/schema.js`), sob `.catch` que só loga. O teste do critério 4 só lia
   `server.js`. → migration `1789509900000_creative-core-schema` (SQL movido sem edição,
   irreversível); worker só liga após a verificação de boot; teste varre `server.js`, `lib/`,
   `routes/`, `services/` e reprova contra o código anterior.
2. **Segunda instância de B-2** — `createKeyring(process.env)` no topo: chave malformada →
   `SecretKeyError` engolido → processo **vivo sem escutar** (nem exit 0: preso nos timers).
   → handler `uncaughtException` sai com 1 enquanto o módulo é avaliado + try/catch explícito;
   `test/invariants/boot-exit-code.test.js` sobe o processo real (7 casos ≠ 0 + controle positivo)
   e reprova 2 casos contra o `server.js` anterior.

**Migration pipeline provado contra a versão instalada** (`node-pg-migrate` 9.0.0):
`pg_try_advisory_lock(7241865325823964)` em modo `fail` → segundo `migrate:up` sai 1 sem aplicar
nada (teste; reprova com `--no-lock`); `--single-transaction` default → falha sai 1 e desfaz o lote
(teste). **Achado lateral:** `--count` é ignorado em silêncio — contagem é posicional; o teste de
irreversibilidade do baseline usava `--count 4` e passava por outro motivo. Corrigido.

**TD-001 fechada** com os 10 pontos implícitos fixados e o mecanismo de contexto escolhido:
transação + `set_config('app.current_organization_id', $1, true)` (`lib/platform/tenant-db.js`,
não ligado a rota). Contrato em banco descartável com role sem `BYPASSRLS`, não dona, `FORCE`:
11 PASS; 3 `todo` contra o schema real (RED em 55 tabelas). **6º ciclo de negative control:**
contexto gravado na sessão (`is_local=false`) → 4 casos reprovam.

**5a:** `access_token` do upload resumable saiu da query string (header `OAuth`); a falha de rede
devolvia a URL com o token ao chamador — medido. Dashboard HTML indisponível pelo navegador,
registrado, sem reintroduzir `?key=`. B-25: implementation FIXED / rollout PENDING DEPLOY.

**Flakes de infraestrutura de teste corrigidos:** teardown com `DROP DATABASE ... WITH (FORCE)`
virava uncaughtException (57P01) e `test-db.mjs` migrava durante o Postgres temporário do init da
imagem.

**Novo ponto de sequenciamento (plano, Fase 1):** RLS forçada + "nenhuma mudança de backend" só
convivem se o app ignorar a RLS. Ordem registrada no plano: schema/policies na Fase 1 → acesso via
`comOrganization` nas Fases 2-3 → troca de role (**OPS-14**) depois. Até lá INV-07 vale no CI, não
em produção.

### Rodada 11 — Fase 1 (Tenancy) implementada (16/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-11-implementar-fase-1-tenancy.md`.
A pedido do usuário, o trabalho passou para a branch `feature/produtizacao-saas`.

- **Manifesto canônico** (`lib/platform/tenancy-manifest.js` → `tenant-owned-tables.md`): 55
  tabelas, uma regra de ownership cada. Reconcilia "49", "53" e "55" (as 4 `origens_migration_*`
  também foram tenantizadas; +2 `integrations`).
- **7 migrations**, SQL gerado do manifesto e congelado em `migrations/sql/0003..0009`.
  `organizations`, `stores` (UNIQUE `organization_id` = 1:1), `organization_members`,
  `tenancy_mapeamentos`.
- **Sem "Organization #1":** o texto do plano foi corrigido. Dono vem de `TENANCY_MAPPING_FILE`;
  cobertura conferida **no banco** (`tenancy_exigir_cobertura`) e completude para o código em
  execução conferida antes do SQL. Cenários PD-019 A e B migram; ausente, incompleto, ambíguo e
  "uma Organization + loja sem dono" abortam sem aplicar nada.
- **Backfill fail-closed:** zero órfãos **e** cada linha com o dono que a regra manda
  (`tenancy_problemas_de_ownership`).
- **INV-06:** `meta_connections`/`google_ads_connections` perderam `CHECK (id = 1)`; id com sequência
  e UNIQUE `(organization_id)`.
- **INV-05 em expand/contract:** 30 UNIQUEs novas com `organization_id`; 28 legadas mantidas e
  declaradas porque 37 `ON CONFLICT (...)` do código usam UNIQUEs como árbitro — saem na Fase 3. `media_assets.public_token`
  é global por desenho (TD-011).
- **Creative Core:** `organization_id` canônico por `creative_tenant:<tenant_id>`; `tenant_id` fica.
- **RLS habilitada e forçada** em 58 tabelas (55 + 3 de plataforma), policy canônica USING + WITH
  CHECK; o gate compara a forma exata (um `OR true` reprova).
- **Trigger transitório** preenche `organization_id` pelo mapeamento quando o código atual não o
  informa; recusa sem regra; confere divergência em loja, pai e tenant. Sai na Fase 3.
- **Role:** `oria_app` provisionada no CI (`NOSUPERUSER NOBYPASSRLS NOINHERIT`, sem acesso ao
  mapeamento). `verificarRoleDaAplicacao` recusa superusuário, `BYPASSRLS`, dona e herdeira da dona;
  no boot só com `DB_ENFORCE_APP_ROLE=1` — testado que o deploy de hoje (superusuário, sem flag)
  continua subindo.
- **Testes:** matriz A/B em todas as 58 tabelas sob `oria_app` (`max: 1`), cenários de migration,
  rollback das 7, 13 negative controls de banco (FORCE, RLS off, policy aberta, nullable, UNIQUE
  global, `CHECK id=1`, BYPASSRLS, dona, grant no mapeamento, candidato único no trigger e na
  cobertura) e 1 de lib (ambiguidade do mapeamento).
- **Achados durante a rodada:** `meta-schema.test.js` derrubava e recriava as tabelas Meta no banco
  compartilhado (passou a usar banco descartável); devolver a posse de uma tabela apaga o GRANT da
  role (pego pelo próprio negative control).

### Rodada 12 — correção do fechamento da Fase 1 (16/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-12-corrigir-fechamento-fase-1.md`.

- **Cenário B era erro de redação, não de implementação.** O fixture sempre teve 1 Organization e
  1 Store (Use Origens), com as lojas legadas `sul`/`centro`/`norte` mapeadas para ela. O texto "uma
  Organization com as três lojas" foi corrigido; os testes agora afirmam `3+3` (A) e `1+1` (B), uma
  Store por Organization, zero Store órfã.
- **1:1 no banco:** `stores UNIQUE (organization_id)` (mais estrito que parcial por `ativa`: não há
  histórico de Stores na V1). Gate `card1a1` confere constraint e dado; 2 negative controls.
- **INV-05 da rodada 11 não era PASS.** Provado em Postgres descartável que o trigger resolve
  `organization_id` **antes** da arbitragem do `ON CONFLICT`. Com isso: os **32** alvos de
  `ON CONFLICT` (29 em `server.js`, 3 em `lib/`) passaram a começar por `organization_id` (as
  conexões Meta/Google arbitram na UNIQUE por Organization); a migration
  `1789600420000_tenancy-chaves` removeu as 20 UNIQUEs globais e as 8 FKs simples, trocou as 55 PKs
  por PKs que começam por `organization_id` e recriou as FKs como compostas. O manifesto não declara
  mais nenhuma transitória, e declarar uma reprova o gate. A PK surrogate também entrou: o
  `id = 1` fixo das conexões mostrava que o próprio `id` podia ser chave cross-tenant.
- **Prova:** 26 famílias de upsert, cada uma com A insere / A atualiza / B mesma chave → linha nova /
  B atualiza só a sua / A sob RLS nunca alcança B; também contra o schema **pré-contract** (base do
  deploy em dois passos, OPS-17) e pelo código real de `lib/` (insights Meta, secret store, Creative
  Core).
- **Achado:** `google-ads-schema.test.js` reaplicava o DDL do baseline no banco compartilhado e
  recriava uma UNIQUE global removida. Pego pelo INV-05; o teste deixou de aplicar DDL.
- Trigger: com dono explícito, a FK composta substitui a conferência do pai; sem dono, a busca do pai
  é `STRICT` (falha se achar mais de uma linha).

### Rodada 13 — Fase 2 (Auth) implementada (16/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-13-implementar-fase-2-auth.md`.

- **Schema** `1789700000000_auth-identidade`: `users`, `sessions` (hash do token), papéis
  `owner`/`member` com FK para `users`, `auth_memberships()` (SECURITY DEFINER, lê memberships antes do
  contexto de tenant). `users`/`sessions` são globais declaradas; a role `oria_app` recebe DML nelas e
  EXECUTE na função.
- **`lib/auth/`**: senha scrypt (nativo do Node, sem dependência nova); sessão opaca de 256 bits
  consultada no banco a cada request; CSRF por HMAC da sessão dentro do `requireAdmin`; fixation;
  rate limit por conta (não por IP); login legado só com flag e usuário declarado.
- **`server.js`**: `requireAdmin` passa a ser a sessão individual (mesmo nome, 222 rotas); as rotas de
  login/logout/sessão foram para o router; os 4 `actorUserId: 'admin'` viraram `req.auth.userId`;
  `registrarAuditLog` recusa sujeito sintético; boot exige a migration de auth e falha sem segredo.
- **Frontend**: login com e-mail, token CSRF em memória enviado em toda escrita, nome/e-mail no menu,
  logout. Sem seletor de Organization.
- **Operação**: `npm run auth:hash-password` e `npm run auth:bootstrap-owner` (OPS-18).
- **Testes**: `auth-flow` (25 casos sob role sem bypass: A/B/C/D/E, revogação, CSRF, fixation, rate
  limit, legado, INV-02, INV-21), `auth-password`, `auth-server` (processo real, CSRF nas rotas
  existentes, estáticos, bootstrap), boot com e sem segredo; 5 ciclos novos de negative control.
- **Achado de infraestrutura de teste:** a cópia de `lib/` usada pelos negative controls não resolvia
  `express`; o runner passou a linkar `node_modules`.
- **Não feito, por ser Fase 3:** Organization ativa, filtro do audit por Organization, `?loja`.

### Rodada 14 — Fase 3 (Tenant context + entitlements) implementada (16/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-14-implementar-fase-3-tenant-context-entitlements.md`.

- **Schema** `1789800000000_tenant-context`:
  - `sessions.active_organization_id`;
  - resolvedores `SECURITY DEFINER` para jobs, webhook da Ink, wamid, pedido público, mídia pública
    e agente;
  - Creative Core com `tenant_id = organization_id::text`, garantido por CHECK. O down devolve o
    rótulo mapeado.
- **Runtime** (`lib/platform/tenant-runtime.js`):
  - o contexto viaja por AsyncLocalStorage;
  - o `pgPool` do `server.js` virou uma fachada: com contexto, toda query roda em
    `comOrganization`; sem contexto, query em tabela tenant-owned é erro (`TENANT_CONTEXT_REQUIRED`);
  - o trigger de tenancy passou a preferir a Organization do contexto.
- **Pipeline** (`lib/platform/tenant-pipeline.js`) dentro do `requireAdmin`. Seleção de workspace
  em `POST /api/admin/session/organization`. Tenant selector no request dá 400.
  Detalhes em TD-002.
- **Rotas:**
  - 37 `/:loja` removidos;
  - `fetchAcrossInkStores`, o modo `'all'` e `multiStoreMode` removidos;
  - `dashboard/customers` e `abandoned-carts` servem só a Store da sessão;
  - posse por id (`exigirRecurso`) em 54 rotas.
- **Sem sessão:** webhook da Ink, status do WhatsApp, pedido e mídia públicos, agente WhatsApp Web,
  e callbacks OAuth com a Organization no state.
- **Jobs** (`lib/platform/jobs.js`): todos os timers passam pelo runner por Organization. O worker
  do Creative Core também. Os locks de sync da Meta e do Google Ads passaram a ser por Organization.
- **TD-012 CLOSED (V1):**
  - entitlements fail-closed, aplicados centralmente por rota (`lib/platform/feature-routes.js`);
  - seed explícito (`npm run tenancy:seed-entitlements`, OPS-21).
- **Creative Core:**
  - o tenant é a Organization da request;
  - storage por Organization, com `npm run tenancy:mover-criativos` (OPS-22);
  - o serviço Python continua stateless; decisão registrada no plano.
- **Recuperação:** filtro incondicional (INV-24).
- **Audit:**
  - gravado e listado na Organization do contexto;
  - com Postgres, sem espelho JSON global, e o mesmo vale para `salvarConfigPostgres` e para o log
    de webhooks;
  - webhook sem assinatura não grava nada.
- **Achado:** dois `TRUNCATE` na aplicação apagariam todas as Organizations (`controle-estoque/limpar`,
  `desconectarMeta`). Viraram `DELETE` por Organization, com teste estático e teste no processo real.
- **Frontend:**
  - sem seletor de loja e sem `loja` em nenhuma chamada;
  - entitlements nascem `false`;
  - `WorkspacePage` e seletor de workspace para quem tem mais de uma Organization;
  - listas fixas Sul/Centro/Norte removidas dos formulários (pedido Pix, vincular, reembolso, troca,
    produto, campanha, UTM, campos, integrações Meta e Google Ads).
- **Testes novos:**
  - `fase3-tenant-context` (17): User A/B/C/D/E, workspace, revogação, Store, posse, TD-012, seed,
    fachada, jobs, resolvedores e `pgStore`, sob `oria_app`;
  - `fase3-server-ab` (18): `server.js` real sob `oria_app` com `DB_ENFORCE_APP_ROLE=1`, A/B por
    domínio, webhooks, links públicos, limpeza em massa e Creative Core;
  - `fase3-static` (9);
  - `inv-22-creative-tenant`, `inv-24-recuperacao`;
  - 8 negative controls: `req.query.loja`, `fetchAcrossInkStores`, candidato único, ownership
    removido, ausência concede, filtro condicional, job sem contexto, `CREATIVE_TENANT_ID`.
- **Commits** (branch `feature/produtizacao-saas`, sem push):
  - `c6fe058` — backend e testes;
  - `9658900` — flake antigo do teste de senha, que falhava 1 vez em 64;
  - `185977a` — painel;
  - o commit desta documentação.

  Cada commit foi verificado num `git worktree` temporário.
- **Trabalho de outra sessão no mesmo diretório — preservado e fora dos commits:**
  - as alterações de UTM do `17536fc` (`origin/master`) em `server.js`, `admin/src/lib/utm.ts`,
    `admin/src/api/utm.ts` e `UtmBuilderForm.tsx`;
  - `scripts/migracao-verificar.mjs`.

  Nos arquivos com mudanças das duas sessões, o commit leva só a parte desta fase.
- **Incidente de execução, corrigido antes de qualquer commit:** ao criar o helper de ownership
  sobrescrevi o `lib/platform/ownership.js` da Fase 0. Ele foi restaurado do `HEAD` e o carregador
  por id entrou **acrescentado** ao arquivo original. O negative control da Fase 0 continua passando.

### Rodada 15 — Fase 4 (Integrations) implementada (16/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-15-implementar-fase-4-integrations.md`.

- **Inventário factual e classificação plataforma × tenant:** no plano, Fase 4.
- **Schema** `1789900000000_integrations`:
  - `oauth_states` (global da aplicação);
  - `external_resource_claims` (global privada), acessada só por funções `SECURITY DEFINER` com a Organization do contexto;
  - posse dos recursos já selecionados.

  Segredo nenhum entra por migration.
- **Resolver central** `lib/platform/integrations.js`:
  - uma integração por (Organization, provider);
  - falha fechada em qualquer caso anômalo;
  - fallback legado da Ink só com a flag e só pela loja legada da Store.

  O store ganhou filtro por Organization, recusa de segredo vencido, `apagar` e re-cifra com contexto por (provider, tipo).
- **Consumo:**
  - Ink: os 5 helpers viram um `inkFetch` que usa o token da Organization; feed e catálogo idem.
  - Meta: cliente, renovação e desconexão com revogação.
  - Google Ads e GA4: refresh, revogação no corpo (não mais na URL) e posse.
  - OpenAI: cofre da Organization.

  As conexões são lidas por `organization_id`, e contas selecionadas passam por integridade 0/1 e posse.
- **OAuth:** `lib/platform/oauth-state.js`. Os mapas em memória e o HMAC do Google Ads saíram.
- **F-01:** fonte única `lib/financeiro/midia.js` para dashboard e consolidado.
  - A atribuição do Google Ads passou a ser lida.
  - O consolidado devolve `midiaSinalizada`.
  - `GOOGLE_ADS_EM_USO` saiu.
- **INV-13:** `lib/platform/secret-guard.js`. Todo segredo usado é redigido em respostas e no console do processo.
- **Operação:**
  - `npm run integrations:import-legacy`: simula por padrão, é idempotente, verifica cada gravação e tem `--limpar-colunas-legadas`;
  - `npm run integrations:reencrypt`.
- **Painel:** card "Credencial da Reserva Ink" (owner) e teste de conexão.
- **Testes novos:**
  - `fase4-integrations` (18), sob `oria_app` e sem RLS: credenciais A/B intercaladas, integridade, vencido, env legado, desconexão, posse, OAuth, import com re-cifra, re-cifra, INV-11, INV-13;
  - `fase4-server-integrations` (8): processo real, providers simulados por `--require` (A/B e concorrência, OAuth ignorando `organization_id` do navegador, DRE consistente, colisão de conta, desconexão isolada, credencial Ink, nenhum token em resposta ou log);
  - estático INV-12;
  - 10 negative controls.
- **Commits** (sem push): `8f33574` backend e testes · `f8f98d5` painel · o commit desta documentação. Cada um foi verificado num worktree temporário. As alterações de UTM de outra sessão (`17536fc`) e `scripts/migracao-verificar.mjs` ficaram fora dos commits.
- **Achado de relógio:** a validade do state era comparada com o relógio do Node, e o Postgres (VM do Docker) pode estar adiantado. Passou a ser medida no banco.

### Rodada 16 — Fase 5b (contrato painel ↔ WhatsApp Go) implementada (16/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-16-implementar-fase-5b-whatsapp-contract.md`.
Contrato completo, rollout e rollback: **`whatsapp-sender-contract.md`**.

**Ordem executada:**

1. Go aceita — G1 `40f4c35`, G2 `8c3fe50`;
2. painel passa — P1 `386457d`, P2 `31a7cdb`;
3. Go exige — G3 `55647c0`;
4. painel para de ler o `/health` — P3 `3adad08`;
5. `/health` sem identidade — G4 `31b4bc9`.

Testes e docs do Go: `7b82c2b`, `eed85e9`, `1d9b821`. A branch do Go foi criada a partir do HEAD da 5a (`9f0f655`).

**Painel**

- **Remetente** (`lib/platform/whatsapp-sender.js`):
  - integração `whatsapp`, sem migration: número e WABA em `config`, token em `integration_secrets`;
  - o par é lido na mesma leitura, da mesma linha;
  - a posse do número (PD-016) é conferida a cada resolução;
  - o token não é enumerável.
- **Cadastro:** tela "Número do WhatsApp" (owner). Troca de número exige o token novo; o número de outra Organization dá 409.
- **Import (OPS-29):** `integrations:import-whatsapp-sender` exige a Organization explícita.
- **Chamadas ao Go:**
  - `X-Sender-*` em toda rota da Organization;
  - `/health` e `/dashboard/events` vão sem remetente;
  - Organization sem número → 409 sem chamar o Go;
  - campos forjados pelo navegador (corpo, headers) nunca são repassados.
- **Resolver interno** `POST /api/internal/whatsapp/sender`, para fila e retry do Go. Exige:
  - chave do serviço;
  - assinatura HMAC do painel;
  - plano com WhatsApp;
  - mesma integração e mesmo número.

  A resposta sai por `res.end`, a única exceção ao secret-guard. `Cache-Control: no-store`.
- **Visão geral:** o número vem da integração; o `/health` só diz se o serviço está de pé.
- **Boot em produção** com `WHATSAPP_SERVICE_URL` exige `WHATSAPP_SENDER_REF_SECRET` e `WHATSAPP_SENDER_RESOLVER_KEY`.
- **Testes:**
  - `fase5b-whatsapp-sender` (10): A/B e concorrência, par cruzado, referência forjada, JSON/inspect, import, contrato e cópia idêntica no Go;
  - `fase5b-server-whatsapp` (11): processo real com um Go falso — cadastro, PD-016, teste de conexão, resolver, A/B intercalado e concorrente, forjamento, fail-closed, `/health`, estático §16, INV-13;
  - 1 teste de boot;
  - 5 negative controls.

**Go**

- `identity.go`: headers validados.
  - Ausente, parcial, malformado ou repetido → 400, sem chamar a Meta.
  - Campos de remetente no corpo → 400.
  - Token redigido em erros e na formatação.
- `resolver.go`: fila e retry guardam número, referência e `source_wamid` (WG-29), nunca o token.
  - O despacho resolve o token no painel.
  - Divergência, falha ou item antigo → o item falha.
  - A dedup inclui o remetente.
- Respostas automáticas saem pelo número que recebeu, via a última referência vista. Número desconhecido não responde.
- `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN` e `META_WABA_ID` saíram do código. `/health` = `{"status":"ok"}`.
- `PANEL_SENDER_RESOLVER_URL` e `PANEL_SENDER_RESOLVER_KEY` são obrigatórios em produção (https).
- `newMux()` foi extraído. O teste de contrato passa cada rota da fixture pelo roteador real.
- O nome do template passou a ser escapado na exclusão (antes, um `&` acrescentava parâmetros à chamada da Meta).

**Achados da rodada**

- Um controle negativo do Go revelou uma lacuna: um número desconhecido podia responder pelo remetente de outro, e não havia teste disso. O teste foi reforçado.
- Um bug do helper de teste foi corrigido antes do commit (sombreamento do corpo da resposta).

### Rodada 19 — decisões fechadas e rollout preparado (17/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-19-fechar-decisoes-e-preparar-rollout.md`.
Relatório: **`round19-report.md`**. Quatro trilhas (E–H) em worktrees destacados, consolidadas por cherry-pick.

**Painel** (`883e157..`):

- **E** (repasse sem perda): `ae3853f`, `b048cf3`, `b6c1976`, `acd2e61`.
- **F** (boot/gate/dogfood): `c76fce0`, `4cf4bb0`, `544dc11`, `8a7b9ac`.
- **G** (criativos sem 404): `60e81cc`, `3397943`, `dd3b79b`, `8508102`, `eabd626`, `60bc0f6`, `58aeacc`, `a8cf187`.
- **H** (cenário B, WhatsApp declarado, seed por perfil, contrato da B, dry-run): `76f620a`, `e257ac8`, `613c1a8`, `d57bb32`, `4020296`.
- **Consolidação:** `0d529d5`, `27f4a3c` (OPS-36 e dogfood depois da rotação), `b5b7480` (runbook + checklist do OPS-27),
  `7535dfa` (achados do dry-run), `2ab9246` (piso 894) e o commit de docs desta rodada.

**Go** (`23528ae..`): `789b7c9`, `023398c`, `244bf45` — assinatura junto com a query legada durante a transição.

**Achados da rodada**

1. **A RELEASE B publica o commit antigo `31a7cdb`** e o pre-deploy roda os scripts dele. Três desenhos
   iniciais só funcionavam com código do HEAD e foram refeitos:
   - leitura dupla dos criativos → vínculo antes da B;
   - seed por perfil → lista igual ao perfil na B;
   - par do WhatsApp → conferido pelo HEAD antes e depois.
   O mapeamento passa a chegar à B por variável (não ensaiado no Railway).
2. **O mover de criativos da trilha G apagaria a única cópia** com o vínculo presente (via o link, cada
   arquivo parecia "idêntico"). Corrigido com recusa + `realpath`, e com controle negativo.
3. **O "404" dos criativos era 500** na prática, e o mover antigo falharia após a primeira escrita nova.
4. **O dry-run encadeado** achou cinco divergências no runbook. A que parava a execução: o preflight
   `after-ops14` bloqueia as flags da release N, que agora saem antes da F.
5. **Testes intermitentes sob carga:** `jobs/lease-ignorado` (INV-18, lease de 1 s), `remetente-global`
   (boot em 30 s) e o teste de réplica do Go. Passam isolados; nenhum ligado a mudanças desta rodada.
6. **Porta do Docker:** o `test-db` sorteia uma porta livre e às vezes ela é tomada antes do `docker run`.
   Um gate saiu com exit 1 por isso, sem rodar teste nenhum.

### Rodada 18 — execução noturna Phase 6+ (16–17/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-18-execucao-noturna-phase6plus.md`.
Relatório: **`overnight-phase6plus-report.md`**. Quatro trilhas em paralelo, cada uma num worktree
destacado com Postgres próprio; consolidação por cherry-pick.

**Painel**

- **Trilha A (Tenant #1):** `ca5b56f`, `1017cbe`, `cf53497` — `tenant1:*`, ensaio A/B, rollback local.
- **Trilha B (onboarding):** `b0ef336`, `2353adb`, `485cab3`, `8c024d2` — estado retomável, criação atômica, convite, gate.
- **Trilha C (hardening 5c):** `c706da1`, `87b0002` — repasse assinado em header.
- **Trilha D (gate/release):** `4e7cd7f`, `54d65fe`, `e3ef343`, `693fd11` — `productization:gate`, `release:preflight`, `test:app-role`, runbook.
- **Consolidação:** `4198fdd` (gate conhece `forward-auth-v1`, piso 806), `8b33f79` (preflight com as variáveis de B/C; pulo esperado `TestInboxProcess`), `6e86872` (runbook sem marcadores abertos) e o commit de docs desta rodada.

**Go:** `40cf2e1`, `c735c7e`, `d47b2af`, `b426acb`, `23528ae` — repasse assinado, `webhook_inbox` (migration 3), teste de queda com processos reais, cache curto, páginas removidas.

**Achados da rodada**

1. **Suíte sob `oria_app` não existia.** Primeira execução honesta: 669/710; todas as falhas eram fixtures (sem contexto/sem CREATE), nenhuma em código de request. Corrigido; 5 arquivos de schema/SQL rodam com a role dona por lista fechada e verificada.
2. **Integração entre trilhas pegou dois buracos:** o gate não conhecia o contrato de repasse novo nem o processo filho novo do Go (reprovou `TestInboxProcess` como pulo) e o preflight não conhecia as variáveis de B/C. Corrigidos com teste e controle negativo.
3. **Trilha B:** o aceite de convite usava `ON CONFLICT (email)` global em `users`; o teste de upserts reprovou e foi corrigido.
4. **Trilha C:** uma falha isolada do Go, sem nome capturado, não reproduziu em 17 execuções (7 da trilha + 10 completas).

### Rodada 17 — PD-023 fechada e Fase 5c implementada (16/09/2026)

Comando: `docs/commands-produtizacao/claude-rodada-17-fechar-pd023-implementar-fase-5c.md`.
Documento da fase: **`whatsapp-inbound-5c.md`**.

**Decisões**

- PD-023: **CLOSED (V1)**, Variante B — processo compartilhado e um Meta App da plataforma, com a evidência do Embedded Signup e de `subscribed_apps`.
- TD-005: **CLOSED**.
- TD-006: **CLOSED**.
- OPS-10 vira parte de OPS-27 e do onboarding.

**Painel**

- **`a0803d6` — contexto de entrada:**
  - `inbound-context` (WABA + número) e `ref-context`, com contexto sem token;
  - `whatsapp_organization_do_remetente` (SECURITY DEFINER);
  - posse exclusiva da WABA;
  - resposta automática e aviso como configuração da Organization;
  - fixture `inbound-context-v1`.
- **`a630482` — dois flakes de ambiente** que apareceram na verificação:
  - hash corrompido só nos bits de enchimento do base64;
  - porta local ocupada.
- **`ad131d2` — E2E real** (painel + binário Go + Meta simulada). O painel de eventos do Go passa a receber só número + referência.
- **`7011907` — TD-005 e referência de serviço:**
  - webhook da Ink em `/api/webhooks/ink/:token` (hash → Organization → segredo da integração → assinatura);
  - rota legada e varredura de segredos removidas;
  - URL gerada ou rotacionada pelo owner;
  - segredo do webhook no cofre;
  - `integrations:whatsapp-referencia` (OPS-33).
- **`2c46105` — TD-006:**
  - `job_leases` + `job_lease_adquirir`/`job_lease_concluir`;
  - scheduler com lease e rodízio;
  - campanha com CTE;
  - teste com processos reais (largada simultânea, intervalo, queda com lease vencido, fail-closed).

**Go**

- **`31f45b6` — entrada roteada por Organization:**
  - HMAC da plataforma → resolução por change → idempotência → 200 → efeitos;
  - estado e banco por Organization, com migrations versionadas e mapeamento legado explícito;
  - fila com lease;
  - dashboard, fila e problemas exigem contexto;
  - cold start resolvido;
  - WG-23, WG-24 e WG-25 corrigidos.
- **`445ead9` — docs.**

**Achados da rodada**

1. **`UPDATE ... WHERE id IN (subconsulta com LIMIT ... FOR UPDATE SKIP LOCKED)` pega mais linhas que o LIMIT.**
   - No Go, um lote de 3 levou a fila inteira. Visto porque o teste de duas réplicas passou a exigir disputa real.
   - Corrigido para CTE no Go e também no disparo de campanha do painel, que usava a mesma forma.
2. **Controles negativos inicialmente fracos.**
   - Um teste de duas réplicas dependia de colisão exata no tempo; foi trocado por um teste determinístico, com lease segurado numa transação aberta.
   - O teste estático do INV-32 não via strings com aspas duplas.
   - O teste A/B da Fase 3 subia o `server.js` da raiz real, fora do alcance dos controles negativos.
   - Os três foram corrigidos e cada controle agora reprova de verdade.
3. **Uma corrida de teste no Go:** processamento assíncrono do webhook sobrevivendo ao teste. Resolvida com `webhookWork` (também útil para shutdown).

## In progress

- Nada. Parado no rollout gate (rodada 19, §19). Não deployar, não iniciar dogfood, não marcar a Fase 6.

## Blockers antes do rollout / do fechamento da Fase 6

- ~~**OPS-27**: primeiro gate~~ — ✅ **VERIFIED em 17/09/2026** (rodada 21), evidência em
  `ops-evidence/OPS-27.json`. O checklist em `ops-27-checklist.md` fica como referência para qualquer
  ambiente novo.
- **Infraestrutura do projeto Railway `Oria` não criada** (project, services, dois Postgres, volume).
- **Sequência de releases não redefinida para o alvo novo** (runbook §20.3) — decisão de outra rodada.
- **Consolidação operacional Use Origens** pronta para o corte (condição do cenário B).
- **OPS-01..26 e OPS-28..36** sem evidência no formato do gate (35 dos 36).
- **`ADMIN_SESSION_SECRET` atual < 32** (se for o caso) para o rollout em §5.4 do runbook: exige decisão nova.
- **Dogfood de 14 dias:** NOT STARTED.
- **Fora do repositório:** OPS-33 (extrator).
- QW-01 (`trust proxy`) segue OPEN.

## Findings requiring attention

### Novo na rodada 3

**A hipótese se confirmou: F-01 era um padrão, não um bug.** 12 instâncias (F-01..F-12).

**Causa-raiz declarada no próprio código** — `admin/src/api/metaAds.ts:3-6`: *"o produto é 1 cliente
= 1 loja, e o banco garante isso (`meta_connections` tem `CHECK (id = 1)`)"*. A premissa de produto
está **certa** (é PD-002); a implementação amarrou "1 cliente" a **1 instalação** em vez de
**1 Organization**.

**O pior achado da rodada — F-02, agregação cross-tenant sem parâmetro.**
`GET /api/admin/dashboard/customers` (`server.js:8380`) e `/dashboard/abandoned-carts` (`2006`)
agregam **todas** as lojas incondicionalmente; outros seis endpoints usam `req.query.loja || 'all'`,
de modo que **omitir o parâmetro** agrega tudo. É a maior superfície de vazamento de toda a
auditoria porque não exige entrada maliciosa nenhuma — e o de `customers` devolve PII.

**Demais:** F-03 Creative Core com tenant de env (as 3 lojas compartilham inclusive a chave BYOK) ·
F-04 fila do WhatsApp Web sem filtro de loja · F-05 rotas `:id` sem dono · F-06 conexões de mídia
por instalação com 11 consumos categoria 4 · F-07 `lojaAtribuidaPadrao()` em **dois** call sites
(`11873-11876`, `11419`) · F-08 tabelas e chaves de config globais · F-09 audit log sem sujeito,
sem escopo e **truncado em 500 entradas globalmente** · F-10 entitlements fail-open **também no
backend** · F-12 cache/storage sem tenant · F-11 filtro de escopo que se desabilita
(`lib/recuperacao/compra.js:53`, latente).

**O padrão correto já existe** (G-01..G-10): o dashboard financeiro é fail-closed
(`server.js:2629-2650`) e o GA4 é correto ponta a ponta. **G-01 e F-01 são o mesmo cálculo,
implementado duas vezes com rigor diferente, a ~9.300 linhas de distância.**

### Da rodada 2

**F-01 — a regra fail-closed de atribuição (PD-021) é violada hoje.** P1 hoje, **P0 a partir do
segundo tenant**, risco HIGH.

1. `fontesDeMidia(from, to)` **não recebe loja nenhuma** (`server.js:11921`) — soma o gasto da conta
   Meta e do customer Google Ads globalmente selecionados, sem confrontar `loja_atribuida` com a
   loja cuja receita está sendo usada.
2. **A atribuição do Google Ads nunca é consultada** no caminho da DRE (`server.js:10454`,
   `11936-11947`). É a violação mais clara: não é sobrescrita, é ignorada.
3. `?loja=` sobrescreve a atribuição salva (`server.js:12256`), por afordância intencional.
4. `lojaAtribuidaPadrao()` auto-atribui quando há **uma** loja (`server.js:11873-11876`) — que é
   exatamente o caso do tenant SaaS.

Conforme à regra e **já corretos**: provedor não conectado é excluído e sinalizado
(`lib/financeiro/consolidado.js:37-51`); 409 quando não há atribuição; despesa ausente vira `null`;
GA4 é consultado com a loja. O mecanismo de "excluir e sinalizar" já existe — falta aplicá-lo a
escopo, não só a ausência.

### Da rodada 1 (inalterados)

Single-tenant por desenho declarado · `meta_connections`/`google_ads_connections` com
`CHECK (id = 1)` · todas as chaves de cifra derivam de `ADMIN_SESSION_SECRET` · reembolso escolhe
credencial pelo `:loja` da URL · agente WhatsApp Web com token único e `claim` sem filtro ·
entitlements ausentes no backend · 13 de ~16 jobs sem lock persistente · `webhook_eventos` com PII
sem limpeza · único teste de isolamento está pulado.

**Positivos que reduzem trabalho:** AES-256-GCM real; nenhum segredo em texto plano, em log ou
devolvido ao browser; CSRF de OAuth nos três fluxos com tenancy server-side; nenhuma rota admin sem
guard; nenhum GET mutante; nenhum nome de arquivo previsível; nenhum segredo commitado;
`express.static` da raiz já eliminado; GA4 e creative-core já no padrão-alvo.

## Open decisions

`productization-decisions.md` — índice do documento na rodada 14: **19 OPEN**, 3 PARCIAL,
**10 CLOSED (V1)** (TD-012 fechada nesta rodada). O texto abaixo é o histórico da rodada 4.

**PD-022 fechada na rodada 4** na opção (a): a visão consolidada das três lojas é **eliminada antes
da migração**. A opção platform admin foi recusada — usar a ferramenta de suporte do Oria como BI da
nossa própria empresa seria o "bypass especial" que o addendum §3 proíbe, com outro nome.
Reforça o **cenário B de PD-019** (consolidar em Use Origens antes de migrar) como claramente
preferível.

**Nenhuma decisão nova ficou aberta na rodada 4.** As 23 OPEN são as mesmas das rodadas anteriores —
comerciais (planos, trial, pricing, retenção) e técnicas de implementação (TD-001, TD-003..TD-012).
**Nenhuma delas é incógnita arquitetural**: todas têm opções mapeadas e recomendação registrada.

**CLOSED (V1):** PD-002 (1:1) · PD-016 (ownership de mídia + fail-closed de atribuição) ·
PD-018 (criativos na Organization) · PD-019 (operação interna sem bypass) · PD-021 (recurso ambíguo
fora da DRE) · TD-002 (tenant context pela sessão).

**PARCIAL:** PD-004 (usuários individuais fechado; roles OPEN) · PD-009 (unidade fechada; quotas e
pricing OPEN) · PD-017 (cross-org proibido e modelo definido; conflitos OPEN) · PD-019 (execução da
migração OPEN).

**Mais urgentes para destravar a Fase 1:** TD-001 (tenancy no banco), TD-010 (migrations),
TD-012 (entitlements), TD-003 (Postgres obrigatório), TD-004 (secrets).

**Nenhuma inferência permanece aberta** — os dois trechos truncados foram confirmados pelo usuário.

## P0 blockers

21 blockers (B-01..B-21) em `productization-audit.md` §Q. Novos na rodada 3: **B-20** (eliminar
agregação cross-tenant) e **B-21** (invariants verificáveis em CI — 24 na rodada 3, 37 no plano).

**Ajuste de esforço da rodada 3:** B-03 e o cluster de 11 achados categoria 4 ficam **mais baratos**
(trocar a chave de escopo, não redesenhar a lógica — o padrão-alvo já existe e pode ser copiado);
B-05 fica **mais caro** (ganha F-02, uma classe que não envolve identificador nenhum).

**Menores após a rodada 2:** B-05 (~163 → **~48** rotas) · B-02 (53 → **49** tabelas, 1 eixo em vez
de 2) · B-11 (matriz de teste menor) · B-14 · B-15.
**Inalterados:** B-01, B-03, B-04, B-06..B-10, B-12, B-13, B-16, B-17, B-18.

A cardinalidade 1:1 simplifica o isolamento *entre Stores* — **não toca** o isolamento entre
Organizations, que é onde estão os blockers CRITICAL.

## Next actions

1. ~~Checklist do OPS-27~~ — feito (rodada 21). **Próximo:** registrar o `OPS-10.json` como
   `NOT_APPLICABLE` com `reason` "absorvido por OPS-27", que é o par documental do OPS-27.
2. Criar a infraestrutura do projeto Railway `Oria` conforme `docs/operations/railway-bootstrap.md`
   (nada criado até aqui) e registrar as evidências de OPS-01..05 e OPS-15.
3. **Decidir a sequência de releases no alvo novo** (runbook §20.3): o que substitui os commits
   B/C/D0 do repositório antigo, o que prova cada passo e como é o rollback entre degraus.
4. Confirmar que a consolidação Use Origens está pronta para o corte e preencher os arquivos de rollout do cenário B.
5. Ensaiar `tenant1:*` sobre uma restauração local do backup de produção.
6. Seguir `production-rollout-runbook.md` a partir de §5, com `release:preflight` em cada etapa e a
   estratégia de cutover do §20.3 (legado no ar até o fim da janela de rollback).
7. Iniciar o dogfood (`DOGFOOD.json`) só depois de OPS-14 e OPS-36 VERIFIED; gate exit 0 + decisão do usuário fecham a Fase 6.
8. Sincronizar a `master` e integrar as branches só por decisão separada.

> Histórico das próximas ações das rodadas 1-7 preservado abaixo, só para rastreio.

## Last verified

date: 2026-09-17 (rodada 19)

| repo | branch · HEAD | build | testes |
|---|---|---|---|
| painel | `feature/produtizacao-saas` · commit de docs da rodada 19 (código em `2ab9246`) | `npm run build` ✅ | gate: `npm test` **894/894**, CODE PASS, exit 2 · `npm run test:app-role` **894/894** (2ª execução; a 1ª deu 893/894 por timeout de boot sob carga no controle `remetente-global`, que passa isolado) |
| `whatsapp-webhook-go` | `feature/produtizacao-saas` · `244bf45` | `go build` ✅ · `go vet` ✅ | `go test -race ./...` → **135 PASS** (2 pulos esperados), com banco |

> Histórico: rodada 18 — 807 / Go 123; rodada 17 — 710 / Go 105; rodada 16 — 678 / Go 87; rodada 15 — 651; rodada 14 — 613 (o commit `c6fe058` deu 612/613 no worktree, por causa do flake do teste de senha corrigido em `9658900`); rodada 13 — 555; rodada 12 — 513; rodada 11 — 474 (INV-05 ainda com exceções); rodada 10 — 352, 3 todo;
> rodada 1 — `8a7ea3d`, 234 testes, 6 pulados.

### Working tree

Alterações desta sessão, todas em `docs/produtizacao-saas/`:

```
?? docs/produtizacao-saas/productization-audit.md
?? docs/produtizacao-saas/productization-decisions.md
?? docs/produtizacao-saas/productization-progress.md
?? docs/produtizacao-saas/anexo-a-matriz-de-rotas.md
?? docs/produtizacao-saas/anexo-b-matriz-de-tabelas.md
```

**Nenhum arquivo de código do projeto foi alterado.** Nenhum commit, nenhum push, nenhuma migration.
As demais pendências do git são anteriores a esta sessão.

### Trabalho concorrente detectado (supervisão de escopo)

Durante esta sessão surgiu, fora do meu escopo, um arquivo novo não rastreado:

```
?? docs/claude-analytics-desempenho-jornada-observada.md   (criado 15/09 20:46)
```

**Avaliação:** é documentação, fora de `docs/produtizacao-saas/`, e `HEAD` continua em `8a7ea3d` —
nenhum commit novo, nenhum código de aplicação tocado. **Sem scope drift** em relação à
productização e **sem regressão de tenancy/segurança** a registrar.

**Não foi lido nem alterado por mim**, conforme a regra de não reverter nem interferir em trabalho de
outro agente. Fica o registro para que o usuário saiba que houve outra sessão ativa em paralelo.

(`.claude/agent-memory/` também aparece como novo — é a memória de projeto deste agente.)
