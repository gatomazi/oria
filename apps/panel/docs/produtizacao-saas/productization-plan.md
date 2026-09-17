# Oria — Plano de productização

> **Status:** plano executável. A auditoria está **encerrada** (6 rodadas).
> **Baseline de código:** painel `8a7ea3d` · `whatsapp-webhook-go` `bf91ff1`.
>
> **Fontes de verdade:** [`productization-audit.md`](./productization-audit.md) ·
> [`productization-decisions.md`](./productization-decisions.md) ·
> [`productization-progress.md`](./productization-progress.md) · anexos A–E ·
> [auditoria do serviço Go](./whatsapp-webhook-go-audit.md).
>
> Este documento **não** altera código, schema, migrations ou infraestrutura. Ele diz o que fazer,
> em que ordem, e como saber que terminou.

---

## Como este plano decide que uma fase acabou

**Uma fase não está concluída porque os arquivos foram alterados. Está concluída quando os
invariants daquela fase passam em CI.**

Essa é a regra central e vale sem exceção. Cada fase lista, ao final, os `INV-xx` que precisam estar
**PASS**. Se um deles não puder ser escrito como teste ou lint, ele não é invariant — é item de
runbook, e vai para a série `OPS`.

## Vocabulário

| Série | O que é | Onde vive |
|---|---|---|
| `F-01..F-12` | findings do **painel** | [audit](./productization-audit.md) |
| `WG-01..WG-26` | findings do **`whatsapp-webhook-go`** | [anexo](./whatsapp-webhook-go-audit.md) |
| `G-01..G-10`, `WG-P-01..07` | padrões **corretos** já existentes, a copiar | idem |
| `B-01..B-26` | blockers | [audit §Q](./productization-audit.md) |
| `INV-01..INV-38` | contratos verificáveis em **CI** (sem INV-26, vago de propósito) | [audit](./productization-audit.md) |
| `OPS-01..OPS-10` | verificações de **infraestrutura**, em runbook de deploy | idem |
| `PD-xxx` / `TD-xxx` | decisões de produto / técnicas | [decisions](./productization-decisions.md) |

As duas séries de findings **não** são unificadas: seus `arquivo:linha` são relativos a repositórios
diferentes. A série de invariants **é** única, porque um invariant é um contrato de CI da plataforma,
independente de onde o defeito estava.

## Classificação de cada item

| Faixa | Significado |
|---|---|
| **RBST** — Required Before Second Tenant | sem isto, não existe segundo tenant |
| **RBPL** — Required Before Public Launch | sem isto, não há venda aberta |
| **PLH** — Post-Launch Hardening | melhora depois, não bloqueia |
| **FP** — Future Product | fora do caminho crítico |

Esforço em **XS · S · M · L · XL**. Sem horas.

## Regra de ownership (fixa, vale em todas as fases)

```text
Session
  ↓
Organization          ← eixo de isolamento
  ↓
Store (1:1 na V1)     ← entidade de domínio, NÃO um segundo tenant selector
```

- **O frontend não escolhe tenant.** Nunca.
- Endpoints **não recebem** `organization_id` nem `store_id` para decidir ownership quando isso pode
  ser derivado da sessão.
- IDs de **recurso** vindos da request continuam exigindo checagem de posse.

## Regra fail-closed (transversal)

Diante de **ausência de escopo**, **ambiguidade de ownership**, **recurso não atribuído** ou
**identificador de outra Organization**, o comportamento correto é sempre:

```text
erro · exclusão · sinalização
```

e **nunca**:

```text
remover o filtro · inferir o único candidato · pegar o primeiro · usar configuração global
```

Ancorada em **INV-09**, **INV-11**, **INV-24** e nos invariants do serviço Go (**INV-29**, **INV-30**,
**INV-31**, **INV-37**).

## Regra de migrations (transversal)

Nunca big-bang destrutivo. Para toda mudança de schema:

```text
adicionar estrutura nova → backfill → dual-read/write só onde necessário
→ validar invariants → trocar leitores → remover caminho antigo → DROP em migration posterior
```

As tabelas `origens_migration_*` permanecem **LEGACY / TO_REMOVE**, **sem `DROP` precoce**.

## Regra de duplicação (transversal)

A auditoria encontrou a mesma regra de negócio implementada **duas vezes com rigor diferente**:
`G-01` (dashboard, fail-closed e correto) e `F-01` (consolidado, sem conferir atribuição), a ~9.300
linhas de distância.

**Onde o plano encontrar duas implementações da mesma regra de ownership/atribuição, centralize a
regra** em vez de corrigir cada cópia. Isto **não** é autorização para refactor estético amplo —
é eliminação de duplicação capaz de produzir divergência de isolamento.

---

# Visão geral das fases

```text
Fase 0 — Foundations                   ─┐
Fase 1 — Tenancy                        │
Fase 2 — Auth                           │ caminho crítico
Fase 3 — Tenant context + entitlements  │
Fase 4 — Integrations                   │
Fase 5b — Janela coordenada             │
Fase 5c — Entrada multi-tenant          │
Fase 6 — Operação interna = Tenant #1  ─┘
        ▼
╔═══════════════════════════════════╗
║      SECOND TENANT GATE           ║
╚═══════════════════════════════════╝
        ▼
Fase 7 — Onboarding        Fase 8 — Hardening

Fase 5a — preparação independente do serviço Go  ← paralelo a tudo, desde já
```

| Fase | Nome | Faixa | Esforço | Depende de |
|---|---|---|---|---|
| **0** | Foundations — ✅ **CLOSED (local), 16/09** | RBST | **M** | — |
| **1** | Tenancy — ✅ **CLOSED (local), 16/09** | RBST | **XL** | 0 |
| **2** | Auth — ✅ **CLOSED (local), 16/09** | RBST | **L** | 1 |
| **3** | Tenant context + entitlements | RBST | **XL** | 2 |
| **4** | Integrations | RBST | **L** | 3 |
| **5a** | Serviço Go — preparação | RBST | **S** | — *(paralelo)* |
| **5b** | Janela coordenada painel ↔ Go — ✅ **CLOSED (local), 16/09** · deploy bloqueado por **OPS-27** | RBST | **M** | 4 + 5a |
| **5c** | Entrada/webhook multi-tenant — ✅ **CLOSED (local), 16/09** · Variante **B** · rollout bloqueado por **OPS-27** | RBST | **L (var. B)** | 5b + **PD-023 (CLOSED)** |
| **6** | Operação interna como Tenant #1 — 🟡 **CODE READY (local), 17/09** · alvo **cenário B** · rollout **NO-GO** (OPS-27) · **NÃO CLOSED** | RBST | **L** | 5c |
| **7** | Onboarding — 🟡 **construída localmente (backend), 17/09** · travada por `SECOND_TENANT_ENABLED` · não exposta | RBPL | **M** | GATE |
| **8** | Hardening | RBPL/PLH | **L** | contínua |

**Nove fases.** Total agregado: **XL**.

---

# Fase 0 — Foundations

**Faixa:** RBST · **Esforço:** M

> **Status (rodada 10, 16/09/2026): ✅ CLOSED — implementação local.** Painel: 7 commits após `bde3cad` (`c7f53a6` … `2389d0f` + docs)
> ; 352 testes, 349 pass, **0 fail, 0 skipped**, 3 `todo` (gates da Fase 1);
> `npm run build` verde. Nada foi publicado.
>
> A revisão matinal achou e corrigiu **duas lacunas reais** do fechamento noturno:
> 1. **DDL no boot ≠ 0.** `routes/criativos.js` ainda rodava o schema do Gerador de Criativos no
>    mount, sob `.catch` que só loga; o teste do critério 4 só olhava `server.js`. Virou a migration
>    `1789509900000_creative-core-schema`; o teste passou a varrer `server.js`, `lib/`, `routes/`,
>    `services/`.
> 2. **B-2 tinha uma segunda instância.** `createKeyring(process.env)` no topo do módulo: com
>    `ENCRYPTION_MASTER_KEY` malformada o processo **não saía nem escutava** (timers seguravam o
>    event loop). Corrigido na causa (o handler sai com 1 durante a avaliação do módulo) e com teste
>    permanente que sobe o processo real.
>
> **DEPLOY READINESS — produção: NÃO pronto até os itens abaixo.** São pré-requisitos operacionais,
> não pendências técnicas da fase.
>
> | id | antes do próximo deploy do painel | se faltar |
> |---|---|---|
> | **OPS-11** | *Pre-deploy Command* = `npm run migrate:up` | schema não é criado; boot recusa (`pgmigrations ausente`) |
> | **OPS-12** | `ENCRYPTION_MASTER_KEY` (32 bytes, base64) | boot falha em produção |
> | **OPS-13** | `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1` | tokens Meta/GA4/Google Ads atuais ficam ilegíveis ("reconecte") |
> | **OPS-15** | Node ≥ 20.11 no build do Railway (`node-pg-migrate` 9 exige; repo não fixa `engines`) | pre-deploy falha |
> | — | não rotacionar `ADMIN_SESSION_SECRET` enquanto OPS-13 estiver ligada | segredos legados ilegíveis |
>
> Na primeira execução em produção o baseline e a `creative-core-schema` são no-op (tudo
> `IF NOT EXISTS`, provado sobre uma cópia do estado atual); os três backfills rodam uma vez.

### Objetivo
Criar as ferramentas sem as quais nenhuma fase seguinte pode ser executada com segurança nem
declarada concluída: migrations versionadas, persistência obrigatória, chave de cifra própria e o
harness de CI que vai provar todos os invariants.

### Pré-requisitos
Nenhum. Esta fase pode começar imediatamente.
**TD-003, TD-004 e TD-010 estão CLOSED** (rodada 7) — o conteúdo desta fase está definido.

### Mudanças de schema
`pgmigrations` (tabela de controle do `node-pg-migrate`) e **`integration_secrets`**
(tabela-filha de `integrations`, criada aqui para receber a re-cifra; ver TD-004).

### Mudanças backend

**Migrations versionadas — `node-pg-migrate` (TD-010).** Adicionado como **dependência normal**
(não `devDependency`): o comando roda no container publicado, e o build pode podar devDeps.

- Migrations em `migrations/`. Não confundir com `scripts/migracao-*.mjs`, que é a migração de
  catálogo da Use Origens — nomes quase iguais, coisas distintas. Um `migrations/README.md` de uma
  linha resolve.
- **Migrations nunca rodam no boot.** Railway → *Pre-deploy Command* = `npm run migrate:up`
  (**OPS-11**). Falha aborta o deploy.
- **Remover o DDL e os três backfills do boot** — `bootstrapPostgres()` (`server.js:118`) e
  `backfillPedidosSeNecessario` / `backfillPaymentStatusPortugues` / `backfillPublicTokenMedia`
  (`server.js:1138, 1153, 1168`), hoje encadeados sob um `.catch` que só loga
  (`server.js:1177-1181`). **Isto não é limpeza: é o que impede réplicas de correrem entre si.**
  Sem isso, o pre-deploy e o advisory lock não valem nada.

**Postgres obrigatório (TD-003, B-09).** Em produção, `DATABASE_URL` ausente ou bootstrap crítico
falhando → **boot falha**. O modo de fallback JSON/memory passa a ser **declarado**, nunca inferido
da ausência da variável (hoje é `DATABASE_URL ? ... : null`, `server.js:113`) — inferir o único
candidato é exatamente o padrão que a regra fail-closed proíbe.

**Chave de cifra própria (TD-004, B-07).** `ENCRYPTION_MASTER_KEY` independente de
`ADMIN_SESSION_SECRET`, com `key_version` junto do ciphertext, rotação incremental sem downtime,
leitura aceitando versões ativas e escrita sempre na corrente. Segredo nunca volta ao frontend;
API e log só mostram `last4`/status/validade.

**Observabilidade:** log estruturado com `request_id`; endpoint de healthcheck.

### Mudanças frontend
Nenhuma.

### Jobs/workers
Nenhum.

### Integrações afetadas
Todas, indiretamente: a re-cifra dos segredos existentes com a nova chave é feita aqui, sob a
sequência de migrations (adicionar coluna nova → re-cifrar → trocar leitores → remover antiga).

### Migração de dados

Re-cifra dos segredos existentes, na sequência de TD-004:

```text
legacy key derivada de ADMIN_SESSION_SECRET  (key_version = 0)
  → leitura temporária compatível
  → reencrypt com ENCRYPTION_MASTER_KEY na nova key_version
  → validação: todo segredo lê E volta a funcionar contra o provedor
  → remoção do fallback legacy em release POSTERIOR
```

**Enquanto o fallback legacy existir, `ADMIN_SESSION_SECRET` continua sendo material sensível e não
pode ser rotacionado.** Essa janela é curta, datada e vai para o runbook.

### Testes — o harness de invariants

A infraestrutura de lint e teste que todas as fases seguintes usam, mais o banco de teste
multi-organization.

**Critério de validade do harness — ciclo obrigatório de 5 passos:**

```text
1. o invariant é executado e PASSA no estado correto
2. introduz-se uma violação controlada, deliberada
3. o mesmo invariant FALHA
4. remove-se a violação
5. ele volta a PASSAR
```

Obrigatório para **ao menos um invariant de cada classe crítica**:

| Classe | Invariant sugerido | Violação controlada a introduzir |
|---|---|---|
| **tenancy/ownership** | **INV-09** | ver bloco abaixo — é o caso mais importante |
| **auth** | INV-02 | forjar `organization_id` em header/body e verificar que o resultado muda |
| **entitlement** | INV-23 | derrubar a fonte de entitlements e verificar se a rota protegida ainda responde 200 |
| **secrets** | INV-13 | fazer um handler ecoar um segredo semeado na resposta |
| **webhook** | INV-15 | assinar um evento com o segredo de A e entregá-lo na rota de B |

**O caso do INV-09, explicitamente:** semear **uma única Organization** e um recurso não atribuído,
e provar que o invariant **falha** se algum helper voltar a inferir ownership só porque existe um
candidato único.

Este é o caso que motiva o ciclo inteiro. O banco atual, com três lojas, é **estruturalmente
incapaz** de detectar essa classe de defeito — `lojaAtribuidaPadrao()` sobreviveu à auditoria por
isso. Um harness que roda contra a forma errada de dados passa sempre, e o silêncio é
indistinguível de sucesso.

**Efeito colateral valioso:** com Postgres real no CI, os **6 testes hoje pulados** passam a rodar —
incluindo `test/creative-core-pg.test.js`, o único teste de isolamento por tenant que existe hoje.

### Rollout
Independente. Sem janela coordenada. A configuração do *Pre-deploy Command* (**OPS-11**) precisa
estar feita **antes** do primeiro deploy que contenha migrations.

### Rollback
Trivial até a re-cifra. Depois dela, reverter exige o caminho de leitura legacy, mantido de
propósito até a release seguinte.

### Blockers resolvidos
**B-07** · **B-09** · **B-12** · **B-21** (infraestrutura; os invariants em si vão ficando verdes ao
longo das fases)

### Findings resolvidos
Nenhum diretamente. Habilita todos.

### Invariants verdes ao final
```text
INV-14 PASS
```
*(INV-14 — a chave de cifra é independente da de sessão e versionada.)*

### OPS que passam a valer
**OPS-01..OPS-05** entram no runbook de deploy.
**OPS-11 (novo):** *Pre-deploy Command* = `npm run migrate:up` configurado no Railway — é
configuração de painel, porque não há manifesto de deploy no repositório.
**OPS-12, OPS-13 (rodada 8/overnight) e OPS-15 (rodada 10):** ver o quadro de deploy readiness no
topo desta fase.

### Critérios de saída
1. Uma migration versionada foi aplicada **e revertida** com sucesso em ambiente de teste.
2. Boot sem `DATABASE_URL` **falha** em produção e **degrada** em dev — e a degradação é
   **declarada**, não inferida da ausência da variável.
3. `INV-14 PASS` no CI: rotacionar `ADMIN_SESSION_SECRET` e todos os segredos continuam legíveis.
4. **Nenhum DDL e nenhum backfill roda no boot da aplicação.**
5. O harness completou o **ciclo de 5 passos** para as **cinco** classes críticas —
   tenancy/ownership (com o caso INV-09 de Organization única), auth, entitlement, secrets e webhook.

> Os itens 4 e 5 não são formalidade. O 4 é o que impede réplicas de correrem entre si em toda
> subida. O 5 é o único jeito de saber que o harness detecta — um harness que nunca reprovou nada
> não provou nada, e é a mitigação do maior risco deste plano.

---

# Fase 1 — Tenancy

**Faixa:** RBST · **Esforço:** XL

> **Status (rodada 12, 16/09/2026): ✅ CLOSED — implementação local**, na branch
> `feature/produtizacao-saas` (sem push, sem deploy, nenhuma migration contra produção).
> A rodada 11 declarou CLOSED com o INV-05 "PASS com 28 exceções" — **isso não era PASS**. A rodada 12
> fechou a lacuna e corrigiu a redação do cenário B.
>
> - **Manifesto canônico: 55 tabelas tenant-owned** + 3 de plataforma sob RLS + 2 globais
>   declaradas — [`tenant-owned-tables.md`](./tenant-owned-tables.md), gerado de
>   `lib/platform/tenancy-manifest.js`. Substitui as contagens "49" e "53" abaixo.
> - **8 migrations** (`1789600000000` … `1789600420000`): plataforma → colunas → mapeamento →
>   backfill → constraints → triggers → RLS → **chaves**. Todas reversíveis; rollback testado.
> - **Ownership por mapeamento explícito** (`TENANCY_MAPPING_FILE`), nunca por "Organization #1" nem
>   por candidato único. PD-019 **A = 3 Organizations + 3 Stores**; **B = 1 Organization + 1 Store**
>   (Use Origens), com os valores legados `sul`/`centro`/`norte` convergindo para ela no backfill,
>   sem virar Stores. Mapeamento ausente, incompleto ou ambíguo aborta sem aplicar nada.
> - **1:1 garantido pelo banco:** `stores` tem `UNIQUE (organization_id)`; gate `card1a1` confere a
>   constraint e o dado (nenhuma Organization com mais de uma Store ativa, nenhuma sem Store, nenhuma
>   Store sem Organization).
> - **INV-05 sem exceção:** os 32 alvos de `ON CONFLICT` do código começam por `organization_id`; a
>   migration de chaves removeu as 20 UNIQUEs globais restantes e trocou as 55 PKs por PKs que
>   começam por `organization_id`; as 8 FKs entre tabelas tenant-owned são compostas. **Zero** chaves
>   globais em tabela tenant-owned. Org A e Org B gravam a mesma chave lógica nas 26 famílias de
>   upsert; o upsert de A nunca alcança a linha de B.
> - **Trigger transitório** preenche `organization_id` pelo mapeamento quando o código atual grava
>   sem ele — **antes** da arbitragem do `ON CONFLICT` (provado) — e recusa quando não há regra.
>   Sai na Fase 3.
> - **RLS habilitada e forçada** em 58 tabelas; INV-04/05/06/07 PASS no CI sob `oria_app`; matriz de
>   isolamento A/B sobre as 58 tabelas; 16 ciclos de negative control no banco (+4 medições de
>   efeito) e 2 ciclos de lib (contexto RLS e mapeamento).
>
> **DEPLOY READINESS — além de OPS-11/12/13/15 (Fase 0), o próximo deploy do painel exige:**
>
> | id | antes do próximo deploy | se faltar |
> |---|---|---|
> | **OPS-16** | decidir PD-019 (A ou B) e publicar o arquivo de mapeamento; `TENANCY_MAPPING_FILE` no ambiente do *Pre-deploy Command* | a migration de mapeamento aborta: a base tem dado sem dono declarado. O deploy não sobe e a versão anterior continua no ar |
> | — | janela curta: o pre-deploy roda num único `BEGIN…COMMIT` e trava as 55 tabelas durante o backfill | escrita (e leitura) do app espera até o COMMIT |
> | — | `CREATIVE_TENANT_ID` do serviço igual ao `creative_tenant` declarado | a migration recusa o arquivo (completude de runtime) |
> | **OPS-17** | **deploy em dois passos**: primeiro o commit `b8f2ac7` (alvos novos de `ON CONFLICT`, migrations até `1789600360000`); depois `fee17e7` ou posterior (`1789600420000_tenancy-chaves`) | a versão anterior à Fase 1, ainda no ar durante o pre-deploy, perde o árbitro dos seus upserts até a troca |
> | — | PostgreSQL ≥ 15 no Railway | `ON DELETE SET NULL (coluna)` e `NULLS NOT DISTINCT` não existem antes |
>
> **OPS-14 continua depois das Fases 2-3** (troca da `DATABASE_URL` do app para `oria_app` +
> `DB_ENFORCE_APP_ROLE=1`). Até lá, **em produção a RLS existe e não vale para o app**: a role atual
> é superusuária. INV-07 vale no CI. *(Rodada 14: pré-condição de código cumprida — ver o status da
> Fase 3; a troca em si é operacional.)*

### Objetivo
Introduzir `organizations`, `stores` (1:1) e `organization_members`, e levar `organization_id` a
todas as tabelas que o exigem. É a fase mais pesada do plano.

### Pré-requisitos
Fase 0 concluída ✅. **TD-001 CLOSED (V1)** ✅ — shared schema, `organization_id NOT NULL`, RLS
habilitada **e forçada**, app sem `BYPASSRLS`, contexto por
`set_config('app.current_organization_id', $1, true)` em transação (`lib/platform/tenant-db.js`).
**Início só com confirmação explícita do usuário.**

**Gates já escritos** (`test/invariants/td001-rls-contract.test.js`): o mecanismo está verde; três
asserções contra o schema real estão `todo` e são o critério de saída desta fase.

> ⚠️ **Sequenciamento que o plano original deixava implícito (rodada 10).** Esta fase diz, ao mesmo
> tempo, "RLS habilitada e forçada" e "nenhuma mudança de comportamento; as queries continuam
> funcionando". **As duas coisas só valem juntas enquanto a conexão do app ignorar a RLS** — e a
> única forma de ignorar é superusuário ou `BYPASSRLS`, exatamente o que TD-001 proíbe. Com a role
> certa e sem contexto, toda query do `server.js` devolve zero linhas.
>
> Ordem a seguir:
> 1. **Fase 1:** schema + backfill + policies + `FORCE`. Em produção o app continua na role atual
>    (RLS inerte **para o app**, e isso é declarado, não esquecido). Os gates rodam no CI sob a
>    role `oria_app`, com duas Organizations.
> 2. **Fases 2-3:** todo acesso a tabela tenant-owned passa por `comOrganization` a partir do tenant
>    context da sessão. Jobs recebem a Organization explicitamente (TD-006).
> 3. **Troca de role (OPS-14)** só depois de 2 — é o momento em que a RLS passa a valer em
>    produção. Critério: a suíte inteira verde sob `oria_app`.
>
> Até o passo 3, **INV-07 é verdade no CI e não em produção.** Registrar isso no status de cada fase.

### Mudanças de schema
- Novas: `organizations`, `stores`, `organization_members`.
- `organization_id NOT NULL` em **55 tabelas** *(rodada 11 — ver o manifesto; o texto original a seguir dizia 49, "53 totais menos as 4 `origens_migration_*`, que são
  LEGACY/TO_REMOVE". As quatro também foram tenantizadas: guardam dado por loja enquanto existirem)*.
- Refazer as conexões singleton: `meta_connections` e `google_ads_connections` deixam de ter
  `PRIMARY KEY id SMALLINT CHECK (id = 1)` e passam a ser chaveadas por Organization (**B-03**,
  **F-06**).
- Reconstruir todo índice UNIQUE de tabela tenant-scoped para incluir `organization_id` (**B-17**,
  **F-08**): `whatsapp_web_mensagens (lower(nome))`, `whatsapp_web_outbox (dedupe_key)`,
  `app_config.chave`, `custos_api_precos.chave`, `meta_ad_accounts (selecionada)`,
  `google_ads_customers (selecionada)`.
- Dar dono às tabelas globais: `custos_api_precos`, `segments`, `whatsapp_web_mensagens`,
  `utm_presets`.
- Migrar as chaves de `app_config` conceitualmente por-tenant: `automacao-settings`,
  `whatsapp-provider`, `whatsapp-web-agente`, `settings-product`, `entitlements`,
  `campos-customizados`, `whatsapp-meta-app`, `meta-metas`, `whatsapp-template-config`.
- **RLS** habilitada e forçada em toda tabela tenant-scoped.

### Mudanças backend
Ainda **nenhuma mudança de comportamento**. As queries continuam funcionando porque a role de
produção ainda ignora RLS (ver sequenciamento acima) e porque um **trigger transitório** preenche
`organization_id` pelo mapeamento explícito em todo INSERT que não o informa — e recusa o INSERT
quando não há regra. Única mudança de código: `server.js` exige a última migration da Fase 1 no boot
e ganhou a verificação de role (desligada até OPS-14).

### Mudanças frontend
Nenhuma.

### Jobs/workers
Nenhuma mudança de lógica. Os jobs continuam iterando o enum de lojas — isso muda na Fase 5c.

### Integrações afetadas
Meta Ads e Google Ads, pelo redesenho das tabelas de conexão.

### Migração de dados
~~Toda a base atual recebe `organization_id` da **Organization #1**, criada nesta fase.~~
**Corrigido na rodada 11:** isso só valeria no cenário B de PD-019 e seria, na prática, "o único
candidato". A base recebe `organization_id` por **mapeamento explícito** (loja legada, loja NULL por
tabela, instalação, conexão Meta, conexão Google Ads, tenant do Creative Core), fornecido em
`TENANCY_MAPPING_FILE`. Cenário A → três Organizations; cenário B → uma.
Sequência por tabela: adicionar coluna nullable → backfill → tornar `NOT NULL` → reconstruir índices.
**Sem `DROP` de nada.**

### Testes
Banco de teste com **duas Organizations**. A partir daqui, **todo** teste de isolamento roda contra
`Org A` e `Org B` — não contra três lojas de um dono só.

### Rollout
Migrations incrementais, uma tabela por vez. Nenhuma janela coordenada.

### Rollback
Por migration reversa. As colunas antigas e os índices antigos só saem depois da Fase 3.

### Blockers resolvidos
**B-02** · **B-03** *(parte de schema)* · **B-17** · **B-11** *(passa a ser executável)*

### Findings resolvidos
**F-06** *(schema)* · **F-08**

### Invariants verdes ao final
```text
INV-04 PASS    organization_id NOT NULL em toda tabela tenant-scoped
INV-05 PASS    todo UNIQUE/PK inclui organization_id
INV-06 PASS    nenhuma tabela tenant-scoped é single-row
INV-07 PASS    RLS ativa e forçada
```

### Critérios de saída
1. Os quatro invariants acima **PASS**.
2. Com duas Organizations semeadas, `SELECT * FROM <qualquer tabela tenant-scoped>` **sem `WHERE`**,
   sob a role da aplicação, devolve só as linhas da Organization do contexto.
3. Nenhuma linha órfã: toda linha de toda tabela tenant-scoped tem `organization_id`.

**Rodada 12 — verificação dos critérios (todos PASS, implementação local):**

| critério | estado | evidência |
|---|---|---|
| manifesto canônico reconciliado | PASS | `tenant-owned-tables.md` + `tenancy-schema.test.js` (sincronia e classificação total) |
| `organizations` / `stores` / `organization_members` | PASS | `1789600000000_tenancy-plataforma` |
| cardinalidade V1 1:1 no banco | PASS | `uq_stores_organization`; gate `card1a1` (constraint + dado) com 2 negative controls |
| cenário A = 3 Organizations + 3 Stores · cenário B = 1 + 1 | PASS | `tenancy-migrations.test.js` (contagens, 1 Store por Organization, zero Store órfã) |
| `organization_id` NOT NULL nas 55 · zero órfãos | PASS | INV-04; `tenancy_problemas_de_ownership()`; `organization_id` está na PK de toda tabela |
| mapeamento explícito, sem candidato único | PASS | `tenancy-migrations.test.js` (A, B, E1-3, F1-3, INV-09 ×2) + 2 negative controls de banco + 1 de lib |
| singleton por Organization | PASS | INV-06; conexão Meta/Google Ads por Organization |
| **zero UNIQUE/PK global em tabela tenant-owned** | **PASS** | INV-05 sem exceção; `tenancy-upsert.test.js` (26 famílias, A/B mesma chave, pré e pós-contract) |
| RLS ENABLE + FORCE + policy USING/WITH CHECK | PASS | INV-07 (forma canônica exata) em 58 tabelas |
| contratos A/B · sem contexto · pool | PASS | matriz em 58 tabelas sob role de app, `max: 1` |
| INV-04/05/06/07 | PASS no CI sob `oria_app` | — |
| 3 `todo` de TD-001 | implementation PASS · **production activation PENDING OPS-14** | `verificarRoleDaAplicacao` + testes de boot com e sem flag |
| rollback | PASS | down/up das 8 migrations sem perda de dado |
| build/test | PASS | `npm test` 513/513, 0 skipped, 0 todo; `npm run build` verde; `b8f2ac7` 474/474 |
| Fase 2 não iniciada | PASS | nenhuma rota, sessão ou job alterado; a única mudança de código são os alvos de `ON CONFLICT` |

> **INV-07 é o mais valioso do plano.** Ele transforma "esquecemos um `WHERE`" de vazamento em
> não-evento, e é a única rede de segurança que continua funcionando quando a disciplina humana
> falhar — inclusive durante as fases seguintes.

---

# Fase 2 — Auth

**Faixa:** RBST · **Esforço:** L

> **Status (rodada 13, 16/09/2026): ✅ CLOSED — implementação local**, na branch
> `feature/produtizacao-saas` (sem push, sem deploy, nenhuma migration contra produção).
>
> - **Schema** (`1789700000000_auth-identidade`): `users` (e-mail único, `password_hash` scrypt,
>   `status`), `sessions` (id = SHA-256 do token, `metodo`, expiração, revogação com autor e
>   motivo), `organization_members` com FK para `users` e papel `owner`/`member`, e
>   `auth_memberships(user_id)` (SECURITY DEFINER) para ler os memberships antes de existir contexto
>   de tenant. `users` e `sessions` são globais declaradas; `organization_members` segue sob RLS.
> - **Login individual** (`lib/auth/`): e-mail + senha; corpo com qualquer outro campo é recusado;
>   sessão nova a cada login, a trazida no cookie é revogada (fixation); cookie opaco
>   `HttpOnly; SameSite=Strict; Path=/`, `__Host-` + `Secure` em produção.
> - **Revogação imediata**: toda request consulta a sessão no banco — logout, sessão específica,
>   todas as sessões de uma pessoa e desativação valem na request seguinte.
> - **CSRF**: `X-CSRF-Token` = HMAC da sessão, exigido em POST/PUT/PATCH/DELETE autenticados por
>   cookie (dentro do `requireAdmin`, portanto nas 222 rotas); SameSite continua como segunda camada.
> - **Papéis**: owner gere membros da própria Organization; ações globais sobre uma pessoa
>   (revogar tudo, desativar) só por quem é owner de **todas** as Organizations dela.
> - **Audit**: `actor_user_id` real em toda gravação nova; sujeito ausente ou `'admin'` é erro antes
>   de gravar. Histórico antigo não foi reescrito.
> - **Legado**: `ADMIN_PASSWORD` só autentica com `ALLOW_LEGACY_ADMIN_PASSWORD=1`, e entra como o
>   usuário declarado em `LEGACY_ADMIN_USER_EMAIL` — nunca "o primeiro owner".
> - **Não iniciado (Fase 3):** Organization ativa na sessão, `?loja`, `comOrganization` no pipeline,
>   filtro do audit por Organization, entitlements. *(Rodada 14: feitos — ver Fase 3.)*
>
> **DEPLOY READINESS — além do que as Fases 0 e 1 exigem:**
>
> | id | antes do deploy da Fase 2 | se faltar |
> |---|---|---|
> | **OPS-18** | criar o(s) primeiro(s) owner(s): `AUTH_BOOTSTRAP_OWNER_EMAIL`, `AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH` (de `npm run auth:hash-password`), `AUTH_BOOTSTRAP_ORGANIZATION_IDS` (lista explícita); *Pre-deploy Command* = `npm run migrate:up && npm run auth:bootstrap-owner` | ninguém consegue entrar (só o legado, se ligado) |
> | **OPS-19** | release N: `ALLOW_LEGACY_ADMIN_PASSWORD=1` + `LEGACY_ADMIN_USER_EMAIL` (opcional, emergência). Release N+1: remover a flag e o código do legado | boot falha se a flag vier sem o e-mail |
> | **OPS-20** | `ADMIN_SESSION_SECRET` com **≥ 32 caracteres** em produção (hoje o tamanho não é conhecido) | boot falha com exit ≠ 0 |
> | — | janela: todas as sessões atuais caem (o cookie antigo deixa de existir); comunicar antes | todo mundo precisa entrar de novo |
> | **QW-01** | `trust proxy` **continua pendente** — nada no repositório descreve a cadeia Cloudflare → Railway. O rate limit de login não depende de IP | — |
>
> **Condição para remover o legado (release N+1):** todo owner declarado entrou ao menos uma vez com
> `metodo = 'senha'` (`sessions`), nenhuma sessão `metodo = 'legado'` nos últimos 7 dias, e uma
> release inteira passou com a flag desligada em produção.

### Objetivo
Substituir a senha compartilhada por identidade individual, com sessão que carrega sujeito,
revogação e audit atribuível.

### Pré-requisitos
Fase 1 concluída. **PD-004** tem a direção fechada (usuários individuais); o conjunto de roles
continua OPEN e **não bloqueia** — a V1 pode seguir com `owner` e `member`.

### Mudanças de schema
`users` (hash por usuário), sessões revogáveis, `organization_members` passa a ser usada de verdade.
`audit_log.actor_user_id` passa a receber o id real — hoje é a constante `'admin'`
(`server.js:3108`).

### Mudanças backend
- `POST /api/admin/login` passa a autenticar **pessoa**, não instalação.
- Sessão carrega `user_id`; hoje carrega **só o timestamp de expiração** (`server.js:1541-1545`).
- Revogação de sessão (hoje impossível: o logout só apaga o cookie do navegador).
- **CSRF** em rotas de escrita.
- `app.set('trust proxy', …)` — **com a topologia Cloudflare/Railway validada antes** (QW-01).
  Valor errado é pior que nenhum: confiar demais em `X-Forwarded-For` deixa o cliente forjar o
  próprio IP e escapar do rate limit.
- `listarAuditLog()` passa a filtrar por Organization (`server.js:1254-1269`).
- O espelho JSON do audit log, hoje **global e truncado em 500 entradas**
  (`AUDIT_LOG_MAX = 500`, `server.js:1233`), deixa de poder evitar registros de outra Organization.

### Mudanças frontend
Tela de login com usuário; gestão de membros; menu de conta.

### Jobs/workers
Nenhum.

### Integrações afetadas
Nenhuma.

### Migração de dados
~~Criar o primeiro usuário real da Organization #1~~ — **corrigido na rodada 13:** o primeiro owner
de **cada** Organization declarada é criado por `npm run auth:bootstrap-owner` (OPS-18), com a
lista de Organizations explícita. `ADMIN_PASSWORD` é aposentado em duas releases (OPS-19).

### Testes
Login, revogação, CSRF, e isolamento do audit log entre Organizations.

### Rollout
Janela curta: a troca de autenticação derruba sessões existentes. Comunicar antes.

### Rollback
Manter `ADMIN_PASSWORD` como caminho de emergência por **uma** release, atrás de flag, e removê-lo
na seguinte. Não mais que isso.

### Blockers resolvidos
**B-13**

### Findings resolvidos
**F-09**

### Invariants verdes ao final
```text
INV-02 PASS    organization_id do contexto deriva exclusivamente da sessão
INV-21 PASS    audit log com sujeito real, isolado e retido por tenant
```

**Rodada 13 — separação honesta dos dois invariants:**

| invariant | parte | estado |
|---|---|---|
| INV-02 | identidade: login e sessão não aceitam Organization, Store, loja nem papel do cliente; header/query forjados não mudam identidade nem memberships; nenhum código lê `organization_id`/`store_id`/`tenant_id` do request | **PASS** (teste + negative control) |
| INV-02 | "forjar tenant não altera **nenhum** endpoint" | **gate da Fase 3** — as rotas ainda recebem `?loja` (INV-01/INV-03) · *rodada 14: PASS* |
| INV-21 | identidade: sujeito real em todo registro novo, sintético recusado | **PASS** (teste + negative control) |
| INV-21 | isolado por tenant: `audit_log` já tem `organization_id` NOT NULL e RLS (Fase 1); gestão de membros grava com a Organization do recurso | **PASS estrutural** |
| INV-21 | `listarAuditLog()` filtrado pela Organization ativa; registros gravados sem Organization explícita; espelho JSON global | **gate da Fase 3** (exige Organization ativa) · *rodada 14: PASS* |
| INV-21 | retenção por tenant | **B-18 / RBPL** |

### Critérios de saída
1. Os dois invariants **PASS**.
2. Forjar header, query, body ou cookie de tenant **não altera** o resultado de nenhum endpoint.
3. Revogar uma sessão encerra o acesso imediatamente.
4. Nenhuma ação grava `actor_user_id = 'admin'`.

**Rodada 13 — verificação dos critérios (implementação local):**

| critério | estado | evidência |
|---|---|---|
| users individuais · hash seguro | PASS | `users`; scrypt N=2^15 r=8 p=1, salt 16 bytes (`auth-password.test.js`) |
| sessions persistidas e revogáveis · logout server-side · revogação imediata | PASS | `auth-flow.test.js` + negative control (revogação ignorada → reprova) |
| organization_members usada · owner/member | PASS | `auth_memberships`; rotas de membros; testes A/B/C/D/E |
| login não aceita tenant do browser | PASS | INV-02 identidade + negative control |
| session fixation | PASS | teste + negative control |
| CSRF em writes autenticados | PASS | matriz GET/POST/PUT/PATCH/DELETE, token errado e de outra sessão; processo real; negative control |
| cookies seguros | PASS | `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` = sessão; `__Host-` + `Secure` em produção |
| `actor_user_id` real · nenhum `'admin'` novo | PASS | INV-21 identidade + teste estático + negative control |
| legado só por flag explícita | PASS | testes com/sem flag; boot recusa flag sem usuário declarado |
| auth fail-closed em produção | PASS | exit ≠ 0 sem `ADMIN_SESSION_SECRET` ou com segredo curto (processo real); store fora → 503 |
| User A/B/C · gestão cross-org negada | PASS | `auth-flow.test.js` |
| critério 2 do plano (nenhum endpoint muda com tenant forjado) | **Fase 3** | ver tabela acima |
| Fase 3 não iniciada | PASS | nenhuma rota de negócio mudou além do `requireAdmin` e dos 4 sujeitos de audit |

---

# Fase 3 — Tenant context + entitlements

**Faixa:** RBST · **Esforço:** XL

### Objetivo
Fazer o servidor decidir o tenant. Remover `loja` dos endpoints, eliminar a agregação cross-store,
aplicar posse por recurso e tornar os entitlements fail-closed.

### Pré-requisitos
Fase 2 concluída. **TD-002** já está fechada (pipeline definido). **PD-022** já está fechada
(a visão consolidada é eliminada).

### Mudanças de schema
Nenhuma.

### Mudanças backend

**Pipeline único**, em todas as rotas tenant-facing:
```text
authenticateUser → resolveOrganization → verifyMembership
→ resolveOrganizationStore → checkEntitlement → handler
```

**Remoção da agregação cross-store (F-02, B-20) — é trabalho de remoção, não de guard.**
Não desenhar salvaguardas para preservar a agregação: ela deixa de existir.

| Alvo | Ação |
|---|---|
| `fetchAcrossInkStores` (`server.js:1505`) | **deletar o helper** — sem ele, a classe de defeito não pode voltar |
| `GET /api/admin/dashboard/customers` (`server.js:8380`) | **atenção máxima: devolve PII de clientes de todas as lojas, sem nenhum parâmetro.** Passa a usar a Store da sessão |
| `GET /api/admin/dashboard/abandoned-carts` (`server.js:2006`) | idem |
| `loja = req.query.loja \|\| 'all'` (`2031, 2132, 2540, 2819, 2937, 3191`) | o modo `'all'` **deixa de existir** |
| `GROUP BY loja` sem filtro (`3867`, `3953`) · `MIN(ultimo_sync_em)` (`2617`) | passam a ser escopados |

**Remoção de `loja` como parâmetro** nas ~125 rotas hoje classificadas MEDIUM. Elas **não ganham
checagem de posse — param de receber o parâmetro**. O risco é eliminado, não mitigado.

**Checagem de posse** nas ~48 rotas que selecionam recurso ou credencial por identificador
(10 CRITICAL + ~38 HIGH): `campaigns/:id`, `utm/campaigns/:id`, `despesas/:id`, `media/:id`,
`segments/:id`, `category-jobs/:id`, `whatsapp-templates/:nome`, `campos-customizados/:chave` e as
rotas de integração por `:loja`.

**Entitlements fail-closed (B-04, F-10).** Hoje é fail-open em dois lugares: o frontend volta a
`DEFAULTS` todos `true` (`admin/src/state/entitlements.ts:14-22, 36-39`) **e** o endpoint responde
`{ ...ENTITLEMENTS_DEFAULT, ...entitlements }` com todos os defaults `true` (`server.js:13390`) —
chave ausente vira permissão concedida. Middleware `checkEntitlement` no backend nega por padrão.

**Creative Core (B-14, F-03):** `tenant_id` passa a vir do contexto autenticado, não de
`CREATIVE_TENANT_ID` (`routes/criativos.js:9, 92`). O schema já está certo — muda só a origem.

**Filtro de escopo incondicional (F-11):** `lib/recuperacao/compra.js:53` —
`if (alvo.loja && p.loja !== alvo.loja) continue` desabilita o filtro quando a loja é desconhecida.
Ausência de escopo passa a abortar.

**`multiStoreMode` é removido** (R-02).

### Mudanças frontend
Remover o seletor de loja e `multiStoreMode`; parar de enviar `loja`; entitlements viram só UX.

### Jobs/workers
Nenhuma mudança ainda.

### Integrações afetadas
Creative Core (origem do tenant).

### Migração de dados
Nenhuma.

### Testes
O grosso da suíte de isolamento: `Org A` vs `Org B`, leitura, escrita, posse por recurso, e
tentativa explícita de acesso cruzado.

### Rollout
Por domínio, não big-bang. Cada domínio migra para o pipeline junto com sua modularização
(**TD-009** — fatiar `server.js` **durante**, não antes).

### Rollback
Por domínio. A remoção de `fetchAcrossInkStores` é a única irreversível sem revert de commit —
e é intencional.

### Blockers resolvidos
**B-01** · **B-04** · **B-05** · **B-14** · **B-16** *(posse em `media_assets`)* · **B-20**

### Findings resolvidos
**F-02** · **F-03** · **F-05** · **F-10** · **F-11**

### Invariants verdes ao final
```text
INV-01 PASS    nenhum handler usa identificador de tenant vindo do cliente
INV-03 PASS    nenhum endpoint agrega mais de um tenant
INV-08 PASS    nenhum LIMIT 1 / rows[0] determina escopo ou credencial
INV-09 PASS    não existe fallback "se só há um candidato, use-o"
INV-10 PASS    nenhum process.env lido em request para determinar tenant
INV-20 PASS    todo acesso a recurso por id valida ownership
INV-22 PASS    tenant do creative-core derivado da sessão
INV-23 PASS    falha ao resolver plano nega a feature
INV-24 PASS    todo filtro de escopo é incondicional
```

### Critérios de saída
1. Os nove invariants **PASS**.
2. Com duas Organizations, **todo** endpoint autenticado como A devolve zero linhas de B —
   **inclusive quando o parâmetro de loja é omitido**.
3. `INV-09` verificado pelo **teste decisivo**: banco com **exatamente uma** Organization e um
   recurso não atribuído → ele **continua não atribuído**.
4. `grep` por `fetchAcrossInkStores` não retorna nada.

> O critério 3 é o mais fácil de pular e o mais importante. Um banco com três lojas **nunca** pega
> `lojaAtribuidaPadrao()`; só um banco com uma pega. É a razão de o defeito ter sobrevivido.

### Rodada 14 — implementação (local, branch `feature/produtizacao-saas`)

> **Status: implementada localmente, sem deploy.** Suíte completa: **613/613, 0 pulados**, com 20
> ciclos de negative control de lib/código (8 novos nesta fase) além dos 16 de banco.
>
> **Correções ao texto original desta fase** (o texto acima fica como registro do planejado):
> - *"Mudanças de schema: nenhuma"* — houve uma: `1789800000000_tenant-context`. Ela traz:
>   - `sessions.active_organization_id`;
>   - os resolvedores `SECURITY DEFINER` para caminhos sem sessão;
>   - `tenant_id = organization_id::text` nas 9 tabelas do Creative Core, com CHECK.
> - *"Jobs/workers: nenhuma mudança ainda"* — mudou, e precisava mudar. Não existe troca para
>   `oria_app` (OPS-14) sem jobs com Organization explícita, e o texto da Fase 1 (passo 2) já dizia
>   isso. O que mudou:
>   - todo timer do `server.js` passa por `JOBS.agendar` (`lib/platform/jobs.js`), que lista as
>     Organizations ativas e roda uma iteração por Organization dentro de `comContexto`;
>   - o worker do Creative Core usa o mesmo runner;
>   - **fica para a Fase 5c (INV-18 / TD-006):** lease persistente, exclusão entre réplicas e cota
>     por tenant.
> - *"Rollout por domínio / TD-009"* — o pipeline entrou de uma vez, via `requireAdmin`, porque a
>   fachada de pool (`lib/platform/tenant-runtime.js`) não exige reescrever as ~320 queries.
>   Fatiar o `server.js` continua em TD-009.
>
> **O que foi feito:**
> - **Pipeline:** `requireAdmin` roda sessão → Organization ativa → membership (relido a cada
>   request) → Store → contexto → entitlement da rota. Detalhes em TD-002 (decisions).
> - **Tenant selector no request:** `400 TENANT_SELECTOR_NOT_ALLOWED`.
> - **37 rotas perderam o `/:loja`.**
> - **Agregação entre lojas removida:**
>   - `fetchAcrossInkStores`, o modo `'all'` e `multiStoreMode` foram removidos;
>   - `INK_STORES` só é varrido no roteamento do webhook por assinatura (TD-005).
> - **Posse por id:** `exigirRecurso` (`lib/platform/ownership.js`) em 54 rotas `:id`. A leitura
>   tem predicado explícito de Organization e passa por `assertOwnership`. Recurso de outra
>   Organization responde 404, igual a um inexistente.
> - **Caminhos sem sessão** passam por resolvedores estreitos:
>   - webhook da Ink (loja → mapeamento);
>   - status do WhatsApp (wamid);
>   - links públicos de pedido e de mídia;
>   - agente WhatsApp Web;
>   - callbacks OAuth, com a Organization no state.
> - **Entitlements:** TD-012 CLOSED (V1), fail-closed, com seed explícito (OPS-21).
> - **Creative Core:** o tenant é a Organization da request. `CREATIVE_TENANT_ID` não é mais lido
>   pela aplicação.
> - **Recuperação:** o filtro de loja é incondicional; sem escopo, a chamada dá erro.
> - **Audit:**
>   - a gravação e a listagem usam a Organization do contexto;
>   - com Postgres, sem espelho JSON global;
>   - o mesmo vale para `salvarConfigPostgres` e para o log de webhooks.
> - **Achado da rodada — dois `TRUNCATE` na aplicação:** em `controle-estoque/limpar` e em
>   `desconectarMeta`.
>   - `TRUNCATE` ignora RLS e apagaria os dados de **todas** as Organizations.
>   - Viraram `DELETE ... WHERE organization_id = $1`.
>   - Um teste estático proíbe `TRUNCATE` no código da aplicação.
> - **Locks de sync da Meta e do Google Ads:** passaram a ser por Organization.
> - **Frontend:**
>   - sem seletor de loja, sem `multiStoreMode`, e nenhuma chamada manda `loja`;
>   - os entitlements nascem `false`;
>   - a escolha de workspace (`WorkspacePage` + seletor na barra) aparece só para quem tem mais de
>     uma Organization;
>   - código de contexto perdido relê a sessão, nunca troca sozinho.
>
> **Invariants:**
>
> ```text
> INV-01 PASS    nenhum handler lê loja/store/organization do request (estático + 400 no pipeline + NC)
> INV-02 PASS    forjar header/query/body não muda Organization nem resultado (auth-flow, fase3, processo real)
> INV-03 PASS    nenhum endpoint agrega mais de um tenant (estático + A/B por domínio no processo real + NC)
> INV-08 PASS    Store por Organization: 0 → 409, >1 → 500; nunca rows[0] como escopo
> INV-09 PASS    User C com duas Organizations não recebe nenhuma (NC); banco com uma Org não atribui órfão
> INV-10 PASS    tenant não vem de process.env (CREATIVE_TENANT_ID fora; estático + NC)
> INV-17 PASS    jobs uma vez por Organization, no próprio contexto, sob oria_app (NC)
> INV-20 PASS    recurso por id de outra Organization = 404, com e sem RLS por baixo (NC)
> INV-21 PASS    audit gravado e listado na Organization do contexto; sem espelho JSON global
> INV-22 PASS    tenant do Creative Core = Organization da request (router, pgStore sob oria_app, processo real, NC)
> INV-23 PASS    ausência, erro, "true" string e feature desconhecida negam (2 NC)
> INV-24 PASS    filtro de recuperação incondicional (NC)
> INV-18 —       lease/exclusão entre réplicas: Fase 5c (inalterado)
> ```
>
> **INV-22, T1 ("o serviço recusa request sem tenant").** O Creative Core Python
> (`services/creative-core`) é *stateless* e tem um teste de pureza que **proíbe** acoplamento a
> `tenant_id`. Ele recebe kits e referências já carregados e não guarda nada.
> - A fronteira de isolamento é o Node: router, `pgStore`, storage por Organization e worker por
>   Organization.
> - Decisão: não acoplar o serviço a tenant. T1 é atendido no Node, que não chama o serviço sem
>   Organization resolvida (403).
>
> **OPS-14 — READY (condicionado aos passos de deploy abaixo).** A suíte roda o código da aplicação
> sob uma role NOSUPERUSER / NOBYPASSRLS / não dona:
> - `fase3-server-ab.test.js`: `server.js` real com `DB_ENFORCE_APP_ROLE=1`. Cobre:
>   - login;
>   - domínios A/B (PII de clientes, pedidos, segmentos, UTM, mídia, campanhas, auditoria, despesas);
>   - entitlement;
>   - posse por id;
>   - limpeza em massa;
>   - webhooks Ink e WhatsApp;
>   - links públicos;
>   - Creative Core;
>   - jobs do boot sem erro de contexto.
> - Também sob a role da aplicação: `fase3-tenant-context.test.js`, `auth-flow.test.js`,
>   `tenancy-isolation.test.js` e `tenancy-upsert.test.js`.
> - Os testes que continuam como superusuário são de **schema e SQL de fixture**
>   (`meta-schema`, `google-ads-schema`, `custos-api-sql`, `google-ads-midia-sql`,
>   `recuperacao-fila`, `creative-core-pg`, migrations). Eles não exercitam código de request.
>
> **DEPLOY READINESS — além do que as Fases 0-2 exigem:**
>
> | id | antes do deploy da Fase 3 | se faltar |
> |---|---|---|
> | **OPS-21** | seed explícito de entitlements de **cada** Organization interna: `ENTITLEMENTS_SEED_ORGANIZATION_IDS` + `ENTITLEMENTS_SEED_FEATURES`; *Pre-deploy Command* = `npm run migrate:up && npm run auth:bootstrap-owner && npm run tenancy:seed-entitlements` | fail-closed: toda feature protegida responde 403 (financeiro, catálogo, WhatsApp, criativos…) |
> | **OPS-22** | mover os arquivos do Creative Core: `npm run tenancy:mover-criativos -- --uploads $UPLOADS_DIR --de <CREATIVE_TENANT_ID antigo> --para <organization_id> --aplicar` (sem `--aplicar` só simula) | referências e criativos antigos dão 404 (o banco já aponta para a pasta da Organization) |
> | — | owners com mais de uma Organization escolhem o workspace no primeiro acesso | tela "Suas lojas" em vez do painel |
> | — | webhook da Ink continua chegando por loja legada → mapeamento `loja` (TD-005 segue aberto) | evento sem Organization mapeada é descartado e logado |
> | **OPS-14** | **depois** deste deploy estar estável: `DATABASE_URL` do app → `oria_app` + `DB_ENFORCE_APP_ROLE=1`. As funções `SECURITY DEFINER` precisam ser de uma role com BYPASSRLS (a dona das migrations; no Railway, `postgres`) | boot falha (role verificada) — a versão anterior continua no ar |

---

# Fase 4 — Integrations

**Faixa:** RBST · **Esforço:** L

### Objetivo
Tirar as credenciais de tenant do `.env`, chavear as conexões externas por Organization e tornar a
atribuição de recursos de marketing fail-closed.

### Pré-requisitos
Fase 3 concluída.

### Mudanças de schema
`integrations` + `integration_secrets`, cifrados com a chave da Fase 0.

### Mudanças backend
- **Ink:** `INK_TOKEN_*`, `INK_WEBHOOK_SECRET_*`, `INK_FEED_URL_*` saem de env
  (`server.js:69-73`) e viram linhas por Store (**B-06**).
- **Conexões externas** deixam de ser singleton por instalação e passam a pertencer à Organization
  (**PD-016**): Meta Ads, Google Ads, GA4, OpenAI BYOK. Onde havia `CHECK (id = 1)`, seleção global,
  env como identidade ou `LIMIT 1` de recurso "selecionado", a chave passa a ser `organization_id`.
- **Atribuição fail-closed (B-19, F-01, F-07, PD-021).** `fontesDeMidia(from, to)`
  (`server.js:11921-11949`) passa a **receber o escopo**; a atribuição do Google Ads passa a ser
  **lida** (hoje nunca é, `server.js:10454`, `11936-11947`); `?loja=` deixa de sobrescrever
  (`12256`); `lojaAtribuidaPadrao()` (`11873-11876`) é **removida**.
- **Centralizar a regra (§Regra de duplicação):** `G-01` (`server.js:2629-2650`, correto) e `F-01`
  (`11921-11949`, incorreto) são a mesma regra. **Extrair uma implementação só** e fazer os dois
  endpoints a consumirem — não corrigir a cópia errada e deixar duas.
- Teste de conexão padronizado; revogação propagada ao provedor (hoje só o Google Ads chama
  `GOOGLE_REVOKE_URL`).

### Mudanças frontend
Integrações passa a ser self-service por Organization.

### Jobs/workers
Ainda não. Muda na 5c.

### Integrações afetadas
Todas.

### Migração de dados
Tokens de env → `integration_secrets`, **por último** dentro da fase, depois que a leitura já passa
pela nova camada (**PD-019**).

### Testes
Duas Organizations com tokens distintos; o provider mockado recebe, em cada request, o token da
Organization correta.

### Rollout
Por provedor. Ink por último — é a de maior blast radius.

### Rollback
Env permanece como fonte de leitura de fallback por **uma** release, atrás de flag.

### Blockers resolvidos
**B-03** *(consumo)* · **B-06** · **B-19**

### Findings resolvidos
**F-01** · **F-06** *(consumo)* · **F-07**

### Invariants verdes ao final
```text
INV-11 PASS    recurso não atribuído ou de outro tenant fica fora do total e é sinalizado
INV-12 PASS    toda credencial resolvida a partir do organization_id do contexto
INV-13 PASS    nenhum segredo em resposta, log ou erro
```

### Critérios de saída
1. Os três invariants **PASS**.
2. **Teste de consistência:** para o mesmo período, a mídia somada por
   `/api/admin/dashboard/financeiro` e por `/api/admin/analytics/consolidado` **coincide**.
   Hoje divergem.
3. Nenhuma credencial de tenant é lida de `process.env` em caminho de request.

### Rodada 15 — implementação (local, branch `feature/produtizacao-saas`)

> **Status: implementada localmente, sem deploy.** A suíte completa passou: **651/651**, com 0 testes
> pulados. Há 30 ciclos de negative control de lib/código (10 desta fase) e mais 16 de banco.
>
> **Inventário factual (antes → depois)**
>
> | provider | conexão/recurso antes | credencial antes | tipo | agora |
> |---|---|---|---|---|
> | Reserva Ink | enum `INK_STORES` da instalação | `INK_TOKEN_*`, `INK_FEED_URL_*` (env) | tenant | integração `ink` da Organization (`api_token`, `feed_url`). A loja só confere a Store do contexto. Credencial manual só por owner (`PUT/DELETE /integrations/ink/credenciais`). Não há revogação remota: a desconexão é local. |
> | Ink — webhook | `INK_WEBHOOK_SECRET_*` (env) | idem | tenant | **dívida isolada até a 5c (TD-005)**: identifica só a loja na entrada. O segredo também é importado para `integration_secrets`. |
> | Meta Ads | `meta_connections WHERE id = 1`; `selecionada LIMIT 1` | `access_token_encrypted` | tenant | integração `meta`. Conta selecionada por Organization, com integridade (0 ou 1) e posse do recurso. A desconexão revoga (`DELETE /me/permissions`) e apaga só a Organization. |
> | Google Ads | `google_ads_connections WHERE id = 1`; `selecionada LIMIT 1` | `refresh/access_token_encrypted` | tenant | integração `google_ads`, com o mesmo padrão. Revogação no Google preservada. |
> | GA4 | `google_analytics_connections` por loja | `refresh/access_token_encrypted` | tenant | integração `ga4` (uma por Organization; a linha da loja guarda status e propriedade). Posse da propriedade. A revogação no Google foi mantida e o token saiu da URL. |
> | OpenAI (BYOK) | `creative_settings` | `openai_key_enc` | tenant | integração `openai` (cofre da Organization no Creative Core). |
> | Plataforma | — | `META_APP_*`, `GOOGLE_CLIENT_*`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `CREATIVE_CORE_SERVICE_TOKEN`, `ENCRYPTION_MASTER_KEY`, `ADMIN_SESSION_SECRET`, `WHATSAPP_*` | plataforma | continuam no ambiente. |
> | `GOOGLE_ADS_EM_USO` | env da instalação decidia o aviso para todos | — | *era tenant* | removida. O aviso vale quando a Organization tem a integração. |
>
> O que foi entregue na rodada:
>
> - **Google Ads e GA4** continuam como integrações separadas, como já eram. Unificar ficou fora do escopo desta fase.
> - **Resolver central** (`lib/platform/integrations.js`).
>   - Falha fechada em todos os casos anômalos:
>     - sem integração → `INTEGRATION_NOT_CONNECTED`;
>     - mais de uma integração → `INTEGRATION_INTEGRITY_ERROR`;
>     - segredo ausente, ilegível ou vencido → erro;
>     - sem contexto → erro.
>   - Todo plaintext entregue é registrado na rede de segurança de INV-13 (`lib/platform/secret-guard.js`). Essa rede redige respostas HTTP e todo `console.*` do processo.
> - **OAuth.** O state fica em `oauth_states`, com uso único, só o SHA-256 guardado e validade medida pelo relógio do banco.
>   - Ele guarda a pessoa, a sessão, a Organization e o provider.
>   - O callback revalida a sessão e o membership.
>   - Trocar de workspace no meio do fluxo não muda a Organization do state.
>   - `organization_id` vindo do navegador é ignorado (há negative control para isso).
>   - O HMAC do Google Ads e os mapas em memória de GA4 e Meta foram removidos.
> - **F-01.**
>   - `fontesDeMidia` global foi removida. Dashboard e consolidado consomem `resolverMidiaDaOrganizacao`.
>   - A atribuição do Google Ads passou a ser lida.
>   - `?loja` não sobrescreve nada (400).
>   - O consolidado devolve `midiaSinalizada`.
>   - `lojaAtribuidaPadrao` foi removida (grep zero, negative control).
>   - Teste de consistência no processo real: dashboard e consolidado dão o mesmo gasto, e o recurso sem loja fica fora e sinalizado.
> - **Teste de conexão padronizado:** `POST /api/admin/integrations/:provider/teste`, para ink, meta, google_ads, ga4 e openai. Devolve status e um código, nunca o erro bruto.
> - **Painel:** novo card "Credencial da Reserva Ink" (owner grava e remove, equipe testa) e botão de teste.
>
> **Invariants**
>
> ```text
> INV-11 PASS    recurso sem loja / de outra loja / de outra Organization fora do total e sinalizado (2 NC)
> INV-12 PASS    credencial só da Organization do contexto: resolver, store, OAuth, env legado, desconexão (6 NC)
> INV-13 PASS    nenhum segredo em resposta/log/erro — estrutura + secret-guard + processo real (2 NC)
> ```
>
> As invariants das fases anteriores continuam verdes. A suíte com a app sob `oria_app` inclui `fase4-server-integrations` (processo real com os providers simulados por `--require`).
>
> **SECOND TENANT GATE (acréscimo desta fase).** O segundo tenant só entra com:
>
> - `ALLOW_LEGACY_INTEGRATION_ENV` **desligada**;
> - o import aplicado;
> - `integrations:reencrypt` sem pendência.
>
> Com a flag ligada, a variável de uma loja só atende a Organization cuja Store tem aquela loja legada; tenant novo (sem loja legada) nunca é atendido pelo env. Mesmo assim, a flag não convive com o segundo tenant.
>
> **OPS novos**
>
> | id | o quê | se faltar |
> |---|---|---|
> | **OPS-23** | `npm run integrations:import-legacy -- --aplicar` no pre-deploy (role de migration). Exige `ENCRYPTION_MASTER_KEY`, `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1` + `ADMIN_SESSION_SECRET` (para ler os ciphertexts antigos) e os `INK_*_<LOJA>` ainda presentes. **Sai com erro se houver segredo ilegível.** | a app não encontra as credenciais: Ink, Meta, Google e OpenAI aparecem como não conectados |
> | **OPS-24** | release N com `ALLOW_LEGACY_INTEGRATION_ENV=1` (janela de rollback só para a Ink, por loja legada mapeada). Release N+1: flag desligada, `import-legacy --aplicar --limpar-colunas-legadas`, remover `INK_TOKEN_*`, `INK_FEED_URL_*`, `GOOGLE_ADS_EM_USO` e `CREATIVE_TENANT_ID` (depois do OPS-22). `INK_WEBHOOK_SECRET_*` **fica** até a 5c. | com a flag esquecida ligada, o SECOND TENANT GATE não passa |
> | **OPS-25** | `npm run integrations:reencrypt` depois do import; sai com erro se sobrar versão antiga. Com 0 pendentes confirmados em produção, uma release posterior remove `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY`, e só então `ADMIN_SESSION_SECRET` pode ser rotacionado. | segredo legado continua dependendo do segredo de sessão |
> | **OPS-26** | após o deploy, `POST /api/admin/integrations/{ink,meta,google_ads,ga4,openai}/teste` na Organization interna | conexão quebrada só aparece no primeiro uso |
>
> **Ordem do próximo deploy do painel (derivada das dependências dos scripts):**
>
> 1. **Ambiente (OPS-12/13/15/20):** Node ≥ 20.11, PostgreSQL ≥ 15, `ENCRYPTION_MASTER_KEY`, `ADMIN_SESSION_SECRET` ≥ 32 caracteres, `TENANCY_MAPPING_FILE` (OPS-16) e as variáveis de bootstrap e seed (OPS-18/21).
>    - Manter os `INK_*` antigos até o passo 6.
> 2. **OPS-17, passo 1** (só se a base ainda estiver antes da Fase 1): deploy do `b8f2ac7`.
> 3. **Pre-deploy do release N**, em sequência:
>    1. `npm run migrate:up` (OPS-11). Cria a tenancy com o mapeamento explícito, auth, tenant context, integrações e posse.
>    2. `npm run auth:bootstrap-owner` (OPS-18). Depende de `users` e `organization_members`.
>    3. `npm run tenancy:seed-entitlements` (OPS-21). Depende das Organizations.
>    4. `npm run integrations:import-legacy -- --aplicar` (OPS-23). Depende de `tenancy_organizations_para_jobs`, `tenancy_organization_da_loja` e `integration_secrets`.
>    5. `npm run integrations:reencrypt` (OPS-25). Depende do import.
> 4. **`npm run tenancy:mover-criativos -- ... --aplicar` (OPS-22).** Roda **onde o volume `UPLOADS_DIR` está montado**; o pre-deploy do Railway pode não ter o volume. Não depende do banco.
> 5. **Deploy da app (release N)** com `ALLOW_LEGACY_INTEGRATION_ENV=1` e `ALLOW_LEGACY_ADMIN_PASSWORD` conforme OPS-19. Depois, OPS-26.
> 6. **Release N+1 (OPS-24):** desligar a flag, limpar as colunas antigas e remover as variáveis de tenant listadas acima.
> 7. **OPS-14**, depois de N estável.
>    - A partir daqui a `DATABASE_URL` da app é `oria_app`.
>    - O pre-deploy (migrations, import, re-cifra) precisa de **uma URL própria da role de migration**. Os scripts não rodam sob `oria_app`: a role da aplicação não lê `external_resource_claims` nem `tenancy_mapeamentos`.
>
> **Rollback.**
>
> - Release N volta para a anterior sem perda: o import **copia** e não apaga as colunas antigas, que a versão anterior ainda lê.
> - A migration `1789900000000` tem down: remove posse e `oauth_states` e mantém os segredos importados.
> - Religar o env da Ink só vale com a flag e só para a Organization da loja mapeada.

---

# Fase 5 — WhatsApp

```text
Fase 5
├── 5a — preparação independente          (paralela, pode começar já)
├── 5b — janela coordenada painel ↔ Go    (ordem obrigatória)
└── 5c — entrada/webhook multi-tenant     (duas variantes, PD-023)
```

## Fase 5a — Preparação independente do serviço Go

**Faixa:** RBST · **Esforço:** S · **Paralela: sim, desde já**

> **Status (rodada 10, 16/09/2026): implementação local concluída; rollout pendente.**
> `whatsapp-webhook-go` `bf91ff1 → 9f0f655` (18 commits, sem push/deploy); 45 testes, build/vet/
> `test -race` verdes.
>
> | item | implementation | rollout |
> |---|---|---|
> | **B-25** — `META_APP_SECRET`/`API_KEY`/`DATABASE_URL` obrigatórios em produção; `auth()`/`dashAuth` fail-closed; `?key=` removido | ✅ **FIXED locally** (com negative controls) | ⏳ **PENDING DEPLOY** — conferir as três variáveis no Railway antes |
> | `access_token` do upload resumable na query string | ✅ **FIXED locally** (`c89bb71`, `9f0f655`) — header `Authorization: OAuth`, o mesmo esquema do passo 2 do fluxo; teste prova que URL, query e mensagem de erro não carregam o token | ⏳ PENDING DEPLOY — validar com **um** upload real de amostra de template após subir |
> | Dashboard HTML (3 páginas) | ⚠️ **temporariamente indisponível pelo navegador**: autenticava por `?key=`, removido; navegação não manda header. **Não reintroduzir query-string auth.** Não é runtime principal — login com cookie fica para Fase 8 (hardening/admin UX) | — |
> | `SourceWamid` (WG-29) | backlog documentado; vira necessário na 5b/5c | — |
>
> O vazamento do upload era pior que "token em log de proxy": uma falha de rede vira `*url.Error`
> com a URL inteira, e `handleMediaUpload` devolve essa mensagem ao chamador (medido no teste contra
> a versão anterior).

### Objetivo
Baixar o risco do serviço Go e preparar o caminho de saída **sem quebrar o contrato atual**.

### Pré-requisitos
Nenhum. **Pode rodar em paralelo às Fases 0-4.**

### Mudanças backend (repositório Go)
**Correções de segurança independentes de tenancy.** Todas valem **mesmo se a productização parasse
hoje** — é o critério que define esta sub-fase.

| # | Correção | Local | Finding | Esforço |
|---|---|---|---|---|
| 1 | **Fail-fast de secrets obrigatórios no boot.** `META_APP_SECRET`, `API_KEY` e `DATABASE_URL` ausentes em produção → o serviço **não sobe**. **Reutilizar o `mustEnv` que já existe** (`main.go:147-153`) — o padrão correto já está escrito no próprio repositório | `webhook.go:136` · `main.go:123-126` · `dashboard.go:15-18` · `db.go:18-22` | WG-06, **WG-27** | XS |
| 2 | **Remover autenticação por query string.** `dashAuth` aceita `?key=...`; passa a aceitar **somente header** | `dashboard.go:19` | **WG-28** | XS |
| 3 | Comparação em tempo constante | — | WG-07, WG-09 | XS |
| 4 | Credencial fora da URL no upload | `media_upload.go:101-102` | WG-10, WG-20 | S |
| 5 | Idempotência por id de evento | — | WG-08 | S |
| 6 | **Persistir `SourceWamid` no estado serializado da fila** — hoje o retry perde a correlação com o wamid de origem após restart | `queue.go:27-30` | **WG-29** | XS |

> **Sobre o item 1 — a lista dos três secrets.** ⚠️ **[INFERÊNCIA]** A mensagem original truncava em
> `API_`; a lista de invariants exigida na mesma mensagem cita explicitamente os três
> (`META_APP_SECRET`, `API_KEY`, `DATABASE_URL`), então os três foram registrados. Sinalizado.

> **Sobre o item 6 — por que está aqui e não no backlog.** `SourceWamid` é **bug operacional, não
> tenancy nem segurança**, e a consequência provável é um retry **que não acontece**, não um envio
> duplicado — qualidade de entrega, não integridade. Entra na 5a por **custo e adjacência**, não por
> urgência: é XS, e INV-37 (5c) já vai exigir que o retry sobreviva ao restart com estado
> persistido. Deixar para depois faria o mesmo trabalho ser redescoberto lá.

**O que NÃO entra na 5a:** validar ownership pelo `phone_number_id`/WABA. O negative testing
confirmou ao vivo que um `phone_number_id` estranho é aceito e processado — mas isso é
**B-23/5c**. A assinatura HMAC autentica a **origem Meta**; ela não diz **de qual tenant** o evento
é. São perguntas diferentes.

**Separação conceitual opcional**, se couber sem inflar escopo: distinguir **public ingress**
(webhook da Meta, health mínimo) de **internal/admin API** (send, queue, dashboard, management).
O serviço tem domínio público por necessidade — a Meta precisa alcançá-lo. **Não fazer redesenho de
infraestrutura por isso**; o mínimo obrigatório é o item 1 mais o item 2.
- **O truque de sequenciamento:** dar a `metaPost` (`sender.go:21-51`) um **parâmetro de
  identidade**, mantendo o default de env como fallback. São **9 call sites** e nenhuma outra
  chamada a `/messages` no repositório. O serviço passa a aceitar identidade por requisição **e
  continua funcionando para quem não a envia**.

### Testes
Primeiros testes de webhook e de envio. A base de partida é essencialmente zero: hoje há 6 testes,
cobrindo apenas pacer e validação de `appId`.

### Rollout / Rollback
Independentes. Nenhuma coordenação com o painel.

### Blockers resolvidos
**B-25** *(implementation FIXED localmente; rollout PENDING DEPLOY)*

### Findings resolvidos
**WG-06** · **WG-07** · **WG-08** · **WG-09** *(parte)* · **WG-10** · **WG-20** ·
**WG-27** · **WG-28** · **WG-29**

### Invariants verdes ao final
```text
INV-30 PASS    assinatura nunca opcional — (a) boot FAIL sem META_APP_SECRET,
               (b) request sem assinatura válida → 403
INV-36 PASS    credencial nunca em texto claro, log, query string ou erro
INV-38 PASS    todo secret obrigatório ausente → boot FAIL; nenhuma degradação silenciosa
               (META_APP_SECRET, API_KEY, DATABASE_URL)
INV-39 PASS    autenticação interna obrigatória e só por header — sem credencial 401,
               query string não aceita, API_KEY ausente nunca abre rota
```

### Critérios de saída
1. Os quatro invariants **PASS**.
2. `metaPost` aceita identidade por parâmetro, e o comportamento atual permanece inalterado para
   chamadores que não a enviam.
3. **Repetir o negative testing de 15/09/2026 contra o novo build**, com os mesmos resultados
   observados: sem assinatura → 403 · assinatura inválida → 403 · sem `API_KEY` → 401 ·
   `API_KEY` inválida → 401 · válida → 200. **Acrescentar** `?key=<válida>` → **401**.
4. Subir o serviço em produção sem cada secret obrigatório, isoladamente → **o processo não sobe**.

> O critério 3 tem valor particular: existe uma linha de base medida ao vivo em 15/09/2026. É raro
> ter isso, e transforma a verificação em comparação, não em julgamento.

---

## Fase 5b — Janela coordenada painel ↔ serviço Go

**Faixa:** RBST · **Esforço:** M · **Paralela: não**

> **Status (rodada 16, 16/09/2026): ✅ CLOSED — implementação local, nos dois repositórios.** Nada publicado.
> **Deploy bloqueado por OPS-27.** Contrato, rollout, rollback e mapa de commits:
> `whatsapp-sender-contract.md`.
>
> **Ordem executada** (a do comando da rodada 16, que corrige a lista abaixo: o Go aceita antes de o painel mandar):
>
> 1. Go aceita (`40f4c35`, `8c3fe50`)
> 2. painel passa (`386457d`, `31a7cdb`)
> 3. Go exige (`55647c0`)
> 4. painel para de ler o `/health` (`3adad08`)
> 5. `/health` sem identidade (`31b4bc9`)
>
> **Invariants**
>
> ```text
> INV-25 PASS    remetente só da integração da Organization; referência só com assinatura do painel; forjamento ignorado (painel: 2 NC)
> INV-27 PASS    nenhum META_* nem remetente de processo no serviço (estático) e sem fallback de ambiente (Go: 2 NC manuais)
> INV-28 PASS    A/B intercalado e concorrente nos dois lados; número de outra Organization recusado (painel: 2 NC, Go: 2 NC manuais)
> INV-35 PASS    /health só {"status":"ok"}; painel não lê identidade dele (painel: 1 NC, Go: 2 NC manuais)
> ```
>
> **Critério 3 verificado:** com `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN` e `META_WABA_ID` definidos, nenhum envio usa esses valores. O serviço também não os lê mais.
>
> **SourceWamid (WG-29):**
>
> - persistido junto do remetente (`sender_phone_number_id`, `sender_ref`, `source_wamid`);
> - retry e fila pedem o token ao painel pela referência, sem guardar o token;
> - a dedup por `source_wamid` sobrevive ao restart;
> - a entrada por Organization fica na 5c.
>
> **OPS novos**
>
> | id | o quê | bloqueia |
> |---|---|---|
> | **OPS-27** | `META_APP_SECRET` pertence exatamente ao `META_APP_ID` do Go, e um webhook real passa no HMAC (200/received). Repetir a bateria 5a (403/403/401/401/200/401). | **qualquer deploy da 5b** |
> | **OPS-28** | segredos novos: `WHATSAPP_SENDER_REF_SECRET` e `WHATSAPP_SENDER_RESOLVER_KEY` (painel), `PANEL_SENDER_RESOLVER_URL` e `PANEL_SENDER_RESOLVER_KEY` (Go) | Releases A/B |
> | **OPS-29** | `npm run integrations:import-whatsapp-sender -- --organization <uuid> --aplicar`, com `WHATSAPP_LEGACY_*` = `META_*` do Go | Release B |
> | **OPS-30** | esvaziar a fila do Go (itens sem referência) antes do cutover; `POST /api/admin/integrations/whatsapp/teste` depois | Release C |

### Objetivo
Remover o contrato invertido: hoje o **painel lê a identidade do remetente do `/health` do
serviço** (`server.js:15213` ← `sender.go:443-449`, endpoint sem autenticação, `main.go:87`).
É a inversão exata do INV-25 — o chamador depende de um valor configurado dentro do serviço.

### Pré-requisitos
Fase 4 concluída (o painel já sabe qual Organization está agindo) **e** Fase 5a concluída (o serviço
já aceita identidade por parâmetro).

### Ordem obrigatória

```text
1. painel passa a enviar identidade/remetente explicitamente
2. serviço Go passa a aceitar e VALIDAR essa identidade
3. serviço deixa de aceitar ausência / default implícito
4. painel deixa de descobrir phone_number_id via /health
5. ambos removem phone_number_id do contrato de /health
```

**Nenhum estado intermediário é permitido** em que:
- o painel espere identidade nova e o serviço ainda não a entenda; **ou**
- o serviço exija identidade e o painel ainda não a envie.

Os passos **1-2** são aditivos e podem ficar no ar com segurança por tempo indeterminado. Os passos
**3-4-5** são a janela estrita: **3 nunca antes de 1**, e **4 e 5 juntos**.

### Rollout coordenado
1. Deploy do serviço com os passos 1-2 aceitos (aditivo, reversível).
2. Deploy do painel enviando identidade (aditivo, reversível).
3. **Observar** um ciclo completo de envio em produção com identidade explícita.
4. Só então: deploy conjunto de 3-4-5.

### Rollback coordenado
- Passos 1-2: rollback independente de cada lado, sem efeito.
- Passos 3-4-5: **rollback conjunto obrigatório**. Reverter um lado só recria exatamente o estado
  intermediário proibido. O plano de reversão precisa estar escrito **antes** do deploy, e o
  fallback de env do serviço só é removido em release **posterior** à janela — não dentro dela.

### Blockers resolvidos
**B-22**

### Findings resolvidos
**WG-09** *(completo)* · **WG-01..WG-04** *(caminho de saída)*

### Invariants verdes ao final
```text
INV-25 PASS    nenhum serviço externo detém identidade de tenant implícita
INV-27 PASS    nenhum caminho de envio lê identidade de estado de processo
INV-28 PASS    dois envios de duas orgs usam dois phone_number_id distintos
INV-35 PASS    o serviço não expõe identidade de tenant em endpoint não autenticado
```

### Critérios de saída
1. Os quatro invariants **PASS**.
2. `GET /health` sem credencial **não** devolve `phone_number_id`, `waba_id` nem qualquer
   identificador de tenant.
3. Desconfigurar `META_PHONE_NUMBER_ID` **não altera** o resultado de um envio.

---

## Fase 5c — Entrada/webhook multi-tenant

**Faixa:** RBST · **Esforço:** **XS (Variante A) / L (Variante B)** · **Gate: PD-023**

> **Status (rodada 17, 16/09/2026): ✅ CLOSED — implementação local, Variante B, nos dois repositórios.**
> Nada publicado. **Rollout bloqueado por OPS-27.** Arquitetura, contrato, rollout, rollback e OPS-31..35 estão em
> `whatsapp-inbound-5c.md`.
>
> **Decisões fechadas:**
>
> - PD-023 (processo compartilhado, um Meta App da plataforma);
> - TD-005 (URL opaca por integração da Ink);
> - TD-006 (lease persistente dos jobs + CTE com `SKIP LOCKED` nos itens).
>
> **Invariants**
>
> ```text
> INV-15 PASS    HMAC da plataforma → WABA/número → Organization; Ink: URL opaca → Organization → segredo → assinatura (painel: 4 NC, Go: 1)
> INV-16 PASS    idempotência persistente por (organization_id, evento) no Go; reentrega sem efeito (Go: 1 NC)
> INV-18 PASS    lease persistente no scheduler do painel e na fila do Go; processos reais disputando (painel: 1 NC, Go: 2)
> INV-29 PASS    nenhum efeito antes da resolução do tenant — teste instrumentado (Go: 1 NC)
> INV-31 PASS    escopo de API interna nunca vem do corpo (painel: 1 NC, Go: 1)
> INV-32 PASS    toda query de tenant do Go filtra organization_id — estático + restart (Go: 2 NC)
> INV-33 PASS    chaves de estado em memória com Organization (Go: 1 NC)
> INV-34 PASS    dedupe nunca cruza Organizations (wamid, número de pedido, telefone)
> INV-37 PASS    item persistido sai com Organization/remetente de origem após restart (Go + E2E)
> INV-38 PASS    painel/banco fora → 503 ou job não roda, com log; migration sem mapeamento aborta
> ```
>
> **E2E local:** painel real + binário Go + Meta simulada (`fase5c-e2e-whatsapp.test.js`).

### Objetivo
O webhook de entrada hoje **não roteia: assume**. `metadata.phone_number_id` é desserializado
(`types.go:32`) e usado **só num `log.Printf`** (`webhook.go:227`); `entry.ID` (WABA ID) nunca é
lido; todo payload com `object == "whatsapp_business_account"` (`webhook.go:162`) é tratado como do
tenant único.

### Pré-requisitos
Fase 5b concluída · **PD-023 decidida** · **OPS-06, OPS-07, OPS-08, OPS-10 verificados**.

### As duas variantes

| | **Variante A — 1 processo por Organization** | **Variante B — processo compartilhado** |
|---|---|---|
| **Esforço no código Go** | **XS** | **L** |
| Por quê | variável de ambiente por container **é** identidade por instalação; a maior parte dos achados de categoria 4 e 5 deixa de ser defeito e vira arquitetura | webhook de entrada **reescrito**; os 6 stores em memória re-chaveados; credenciais por tenant |
| Trabalho restante | remover o contrato de `/health` (já feito na 5b) e escopar a autenticação | roteamento por tenant antes de qualquer efeito; app secret resolvido **antes** do HMAC; `problem_orders` re-chaveada |
| **Custo fora do código** | **alto e recorrente**: um container, um Postgres (ou schema) e um app da Meta **por assinante**; provisionamento cresce linearmente com a base | baixo: um serviço, uma operação |
| Arquitetura de tenancy | **duas** na plataforma (painel compartilhado + WhatsApp por tenant) | **uma só** |

**Recomendação atual: Variante B.** Coerência com o resto da plataforma, custo único de engenharia
em vez de custo recorrente de infraestrutura, e a Variante A não elimina o trabalho — realoca-o para
automação de provisionamento que também não existe.

**A Variante A só passa a ser necessária** se uma restrição real da Meta ou de provisionamento
tornar o modelo compartilhado inviável — por exemplo, se um app/WABA não puder servir números de
clientes distintos. **Essa verificação é OPS-10 e é gate desta fase**, não das anteriores.

**PD-023 continua OPEN.** Não foi fechada por este plano.

### Mudanças backend (Variante B)
- Roteamento do tenant por `metadata.phone_number_id` **antes de qualquer efeito colateral**;
  evento não atribuível é descartado e contabilizado.
- Resolver o app secret **antes** da validação HMAC — problema de ovo-e-galinha que exige endpoint
  por tenant ou busca por `entry.ID`.
- Re-chavear os 6 stores em memória (`store.go:34`, `queue.go:50`, `problems.go:57`, `retry.go:15`,
  `webhook.go:21`, `sender.go:18`).
- **`problem_orders` (WG-23, B-26):** `numero` é PK sozinha (`db.go:66`); o upsert casa no
  **primeiro** registro com o mesmo número, ignorando `loja`, e **herda Telefone/Email/CPF do
  registro anterior** (`problems.go:68-79`, `db.go:312-322`). Chave passa a incluir a Organization.
- **`handleProblemsSync` (WG-24):** hoje **apaga** registros por escopo vindo do **corpo da
  requisição** (`problems.go:237-246`) — lista vazia limpa tudo daquela loja. O escopo passa a vir
  da autenticação.
- `lang = "pt_BR"` deixa de sobrescrever o `"en"` explícito do chamador (`queue.go:320`, WG-25).
- Config comportamental por tenant: `NotifyNumber`, `ReplyRedirectMessage`, `ForwardURL`
  (`webhook.go:41, 95, 255`).
- Credenciais da Meta por tenant, cifradas, com rotação (**B-24**) — construção nova.

### Painel, nesta fase
- Webhook da Ink deixa de descobrir a loja **testando o segredo de cada uma em sequência**
  (`identifyInkWebhookStore`, `server.js:1280-1291`) e passa a URL opaca por conexão (**B-08**,
  **TD-005**).
- Jobs deixam de iterar o enum de processo e passam a iterar `organizations` (**B-10**, **TD-006**),
  com leasing persistente. Hoje **13 de ~16 jobs** têm guarda só em memória, e os 4 de follow-up
  (`server.js:15178-15181`) duplicariam mensagens reais numa segunda réplica.
- Token do agente WhatsApp Web por Organization (**B-15**, **F-04**): hoje é **um token por
  instalação**, distribuído no app Electron (`desktop/src/painel.js:29, 41-45`), e
  `POST /api/whatsapp-web-agente/claim` (`server.js:12873-12909`) faz `SELECT` sem filtro de loja.

### Migração de dados
`problem_orders` re-chaveada. **Atenção:** o backfill precisa decidir o que fazer com registros que
já herdaram PII de outro registro. Não é migração mecânica.

### Testes
Todo o bloco INV-29..INV-38.

### Rollout / Rollback
Por componente. O roteamento do webhook exige janela curta (a URL muda no console da Meta).

### Blockers resolvidos
**B-08** · **B-10** · **B-15** · **B-23** · **B-24** · **B-26**

### Findings resolvidos
**F-04** · **WG-01..WG-05** · **WG-11..WG-19** · **WG-21..WG-26**

### Invariants verdes ao final
```text
INV-15 PASS    tenant do webhook determinado pela rota, antes de processar
INV-16 PASS    evento idempotente por (conexão, event_id)
INV-17 PASS    todo job recebe o escopo iterando organizations
INV-18 PASS    todo job que envia ou consome cota adquire lease persistente
INV-29 PASS    evento atribuído a uma organization antes de qualquer efeito
INV-31 PASS    identidade do tenant deriva da autenticação, nunca do corpo
INV-32 PASS    toda query/escrita tem predicado de organization
INV-33 PASS    toda chave de estado em memória inclui a organization
INV-34 PASS    dedupe nunca cruza organizations
INV-37 PASS    envio interno carrega o escopo persistido da origem
INV-38 PASS    degradação de infraestrutura falha fechada ou é visível
```

### Critérios de saída
1. Os onze invariants **PASS**.
2. Evento assinado com o segredo de A, entregue na URL de B → **rejeitado, e não roteado para A**.
3. Duas instâncias concorrentes → cada item enviado **exatamente uma vez**.
4. O cooldown de auto-resposta de A não suprime a resposta de B para o mesmo telefone.

---

# Fase 6 — Operação interna como Tenant #1

**Faixa:** RBST · **Esforço:** L

### Objetivo
Migrar a Use Origens para o mesmo modelo dos clientes externos. **Sem bypass.** É o dogfooding que
prova a plataforma.

> **Status — rodada 18 (17/09): CODE/ROLLBACK READINESS = READY. Fase 6 NÃO CLOSED.**
>
> - `npm run tenant1:preflight | plan | apply | verify | rollback` (`scripts/tenant1/`): cenário e
>   mapeamento sempre explícitos; preflight/plan/verify somente leitura; apply/rollback só em banco local.
> - Ensaio completo dos cenários A e B em dois bancos descartáveis montados como produção
>   (`fase6-tenant1-rehearsal`), com re-execução idempotente e casos de falha.
> - Teste estático sem `internalTenant`/`useOrigens`/`ourStore` (`fase6-tenant1-static`), com controle negativo.
> - Rollback local por configuração/caminho de leitura, sem DROP/DELETE/troca de dono
>   (`fase6-tenant1-rollback`); runbook em `overnight-trilha-a.md` §6.
> - **Falta para fechar:** rollout em produção (bloqueado por OPS-27 e OPS pendentes —
>   `production-rollout-runbook.md`) e ≥ 2 semanas de dogfooding factual.
>
> **Rodada 19 (17/09): decisões fechadas, rollout preparado, nada publicado.**
>
> - PD-019 → **cenário B** (Use Origens; número WhatsApp declarado para ela). Cenário A continua como ensaio.
> - Runbook reescrito com releases A → B (`31a7cdb`) → C → D0 (`8c024d2`) → E → D' (HEAD) → F → CLEANUP →
>   rotação do `ADMIN_SESSION_SECRET` (OPS-36) → dogfood; nenhuma janela de perda de status nem de 404.
> - Boot do HEAD exige `WHATSAPP_WEBHOOK_SECRET`; gate só sai 0 com OVERALL READY; dogfood factual.
> - Dry-run local do runbook: CODE PASS · OPS NOT VERIFIED · DOGFOOD NOT STARTED · OVERALL BLOCKED (exit 2).

### Pré-requisitos
Fase 5c concluída.

### Cenários (PD-019, ambos fechados)

```text
Cenário A — três lojas ainda independentes
  User interno
  ├── Organization Use Sul    └── Store Use Sul
  ├── Organization Use Centro └── Store Use Centro
  └── Organization Use Norte  └── Store Use Norte

Cenário B — operação já consolidada  ← PREFERENCIAL
  User interno
  └── Organization Use Origens └── Store Use Origens
```

**O cenário B é o alvo preferencial.** Qual vale depende **apenas do momento operacional da
consolidação Centro/Norte → Sul**, já em andamento — **não de uma nova decisão arquitetural**.

**Consequência de PD-022, já aceita:** no cenário A, a operação interna **perde** a visão conjunta
das três lojas. Isso foi decidido, não é regressão a mitigar. Não haverá platform admin operando
Use Sul/Centro/Norte em conjunto.

### Migração de dados
In-place: a Organization #1 (ou as três) já existe desde a Fase 1; aqui o restante é reconciliado.
Corte único **por domínio**, nunca big-bang.

### Testes
Todos os invariants, simultaneamente, contra dados reais.

### Rollout / Rollback
Por domínio, com o caminho antigo disponível por uma release.

### Blockers resolvidos
Nenhum novo — **confirma** todos.

### Invariants verdes ao final
```text
TODOS os 37 (INV-01..INV-25, INV-27..INV-38) PASS simultaneamente
```

### Critérios de saída
1. A operação interna roda por **≥ 2 semanas** como Organization normal, sem exceção de código.
2. `grep` por `if (internalTenant)`, `useOrigens`, `isOurStore` não retorna nada.
3. Todos os 37 invariants verdes no mesmo build.

---

# ╔═══════════════════════════════╗<br>SECOND TENANT GATE<br>╚═══════════════════════════════╝

**Nenhuma segunda Organization externa pode ser criada enquanto qualquer linha abaixo estiver
aberta.** Este gate não é uma revisão — é uma condição binária.

> **Rodada 18:** o gate é executável — `npm run productization:gate` (blocos CODE / OPS / DOGFOOD).
> OPS só contam como VERIFIED com evidência em `ops-evidence/` (formato em
> `production-rollout-runbook.md` §2). Estado em 17/09: **CODE PASS · 35 OPS NOT VERIFIED · DOGFOOD NOT
> STARTED · OVERALL BLOCKED.** Rodada 19: catálogo com OPS-01..36; exit 0 só com OVERALL READY
> (`--code-only` removido); dogfood contado pelo relógio desde `dogfood_started_at`, depois de OPS-14 e OPS-36.

### Blockers que devem estar fechados

```text
B-01  tenant context server-authoritative
B-02  entidades de tenancy + organization_id
B-03  conexões de mídia por Organization (fim do CHECK (id = 1))
B-04  entitlements fail-closed no backend
B-05  posse em toda rota :id
B-06  credenciais Ink fora do .env
B-07  chave de cifra independente e versionada
B-08  roteamento de webhook por identificador opaco (Ink E Meta/Go)
B-09  Postgres obrigatório em produção
B-10  leasing persistente nos jobs
B-11  testes de isolamento operacionais em CI
B-12  migrations versionadas
B-13  auth individual com revogação e audit atribuível
B-14  tenant do creative-core vindo do request
B-15  token do agente WhatsApp Web por Organization
B-16  posse em media_assets
B-17  tabelas globais com dono
B-19  atribuição fail-closed na DRE
B-20  agregação cross-Organization eliminada
B-21  invariants operacionais no CI
B-22  contrato do /health removido
B-23  roteamento do webhook de entrada por tenant
B-24  credenciais Meta por tenant
B-25  HMAC fail-closed
B-26  escopo de problem_orders e handleProblemsSync
```

**B-18** (retenção/exclusão de PII) é o único que **não** trava este gate — ele trava o lançamento
público (RBPL).

### Itens transitórios da Fase 1 que também travam este gate (rodada 11)

```text
T-01  ✅ fechado na rodada 12 — zero chaves globais em tabela tenant-owned
T-02  o trigger transitório tenancy_organization saiu (todo INSERT informa a Organization do contexto)
T-03  OPS-14 aplicado: app em oria_app com DB_ENFORCE_APP_ROLE=1 (a RLS vale em produção)
T-04  regras "instalacao:*", "meta:*", "google_ads:*" e "sem_loja:*" sem uso pelo código
```

Com T-02 aberto, uma linha gravada sem `organization_id` vai para o dono da instalação.

### Findings que devem estar corrigidos

```text
F-01  DRE consome mídia sem conferir atribuição
F-02  agregação cross-store por default  ← removida, não guardada
F-03  Creative Core com tenant de env
F-04  fila do WhatsApp Web sem filtro de loja
F-05  rotas :id sem checagem de dono
F-06  conexões de mídia por instalação
F-07  fallback "se só existe uma loja, use ela"
F-08  tabelas e configs globais
F-09  audit log sem sujeito, sem escopo, com retenção compartilhada
F-10  entitlements fail-open no backend
F-11  filtro de escopo que se desabilita
WG-01..WG-26  todos os aplicáveis à variante escolhida na 5c
```

**F-12** (cache/storage sem segmento de tenant) é RBPL, não RBST — desde que `INV-20` (posse por id)
esteja verde, conhecer o caminho não basta para ler o arquivo.

### Condições estruturais

```text
[ ] tenant context derivado EXCLUSIVAMENTE da sessão
[ ] rotas tenant-facing incapazes de agregar Organizations
[ ] conexões externas keyed por organization_id (Meta, Google Ads, GA4, WhatsApp, OpenAI, Ink)
[ ] defaults implícitos críticos removidos (lojaAtribuidaPadrao e equivalentes)
[ ] nenhum process.env lido em request para determinar tenant
[ ] RLS ativa e forçada em toda tabela tenant-scoped
[ ] frontend não escolhe tenant em nenhum ponto
```

### Invariants

```text
TODOS os 37 (INV-01..INV-25, INV-27..INV-38) PASS
```

### OPS

```text
OPS-01  creative-lab sem networking público
OPS-02  CREATIVE_CORE_URL no domínio privado
OPS-03  volume persistente montado
OPS-04  backups do Postgres habilitados E testados por restauração
OPS-05  DATABASE_URL presente (painel)
OPS-06  META_APP_SECRET definido (serviço Go)   ✅ VERIFIED (restart confirmado)
OPS-07  API_KEY definida (serviço Go)           ✅ VERIFIED
OPS-08  DATABASE_URL definida (serviço Go)      ✅ VERIFIED
OPS-09  WEBHOOK_FORWARD_URL conhecida e autenticada
OPS-10  natureza do access token da Meta conhecida
```

### Condição de dogfooding

```text
[ ] Fase 6 concluída: a operação interna roda como Organization normal há ≥ 2 semanas, sem bypass
```

> **Por que o dogfooding está no gate.** Um invariant verde prova que o código faz o que o teste
> pede. Duas semanas de operação real provam que o teste pedia a coisa certa. As duas evidências são
> diferentes e nenhuma substitui a outra.

---

# Fase 7 — Onboarding

**Faixa:** RBPL · **Esforço:** M · **Paralela: pode ser construída durante a 5c**

### Objetivo
Permitir que uma Organization nasça sem intervenção manual.

> **Status — rodada 18 (17/09): backend construído localmente, não exposto.**
>
> - `onboarding_sessions`/`onboarding_steps` sob RLS (migration `1790000300000`); convites com token
>   opaco (só hash), expiração e uso único; idempotência por chave explícita.
> - `lib/platform/onboarding.js`: `createOrganizationWithStore` atômico (Organization + Store 1:1 + owner +
>   estado), passos de provider derivados de `integrations` (sem segunda fonte), erros por código.
> - Requisito de cada passo só por configuração (`ONBOARDING_STEP_REQUIREMENTS`); sem ela a criação é
>   recusada — nenhum default comercial.
> - Trava no backend: `SECOND_TENANT_ENABLED` (desligada por padrão; o `release:preflight` bloqueia ligada).
> - E2E em Postgres descartável sob `oria_app`, com um segundo tenant **de teste** isolado
>   (`fase7-onboarding`). Sem rotas HTTP, sem UI, sem e-mail real.
> - **Falta:** SECOND TENANT GATE, PD-005/006/007/011/012, provedor de e-mail, rotas/UI.

### Pré-requisitos
Pode ser **construída** antes do gate. **Não pode ser usada para criar um tenant externo** antes do
gate passar.

### Conteúdo
Criação de Organization + Store 1:1 · convite de usuários · conexão self-service das integrações,
com teste de conexão obrigatório · estado de onboarding e validação progressiva · backfill inicial.

### Decisões OPEN que este escopo toca
**PD-005** (módulos do plano), **PD-006** (manual vs OAuth), **PD-007** (trial), **PD-011/PD-012**
(produto sem WhatsApp / sem Ink). Nenhuma delas bloqueia a **construção** — bloqueiam a definição do
wizard comercial. Ver §Decisões.

### Invariants verdes ao final
Nenhum novo. Todos os anteriores permanecem verdes.

### Critérios de saída
Uma Organization nova é criada, conectada e operacional **sem nenhum passo manual de engenharia**.

---

# Fase 8 — Hardening

**Faixa:** RBPL + PLH · **Esforço:** L · **Paralela: sim, contínua**

| Item | Faixa | Esforço |
|---|---|---|
| Object storage com prefixo por tenant e URL assinada (**TD-007**, **F-12**, **B-16**) | RBPL | M |
| Retenção/exclusão de PII, incluindo `webhook_eventos` — que hoje guarda payload cru **sem nenhuma rotina de limpeza** (**B-18**, **PD-010**) | **RBPL** | M |
| Exportação de dados do tenant | RBPL | S |
| Rate limit por tenant / anti-noisy-neighbour | RBPL | M |
| Retry e backoff nas chamadas Ink — hoje ausentes na maioria (`server.js:4477-4478`) | PLH | S |
| Cabeçalhos de segurança (`helmet`, CSP, HSTS) | PLH | S |
| Error tracking e métricas | PLH | S |
| **H-01** — reduzir `/v1/health` do creative-lab a `{"status":"ok"}` | PLH (LOW) | XS |
| **TD-008** — tenant context e correlation id entre Node e creative-core | RBPL | M |
| Modularização residual de `server.js` (**TD-009**) | PLH | M |
| `DROP` das tabelas `origens_migration_*` | PLH | XS |

> **TD-008 continua aberto** e é independente do fecho de D-1: a exposição de rede foi resolvida
> (rede privada confirmada), mas o tenant context e o correlation id **não** atravessam a fronteira
> Node → creative-core. São questões separadas.

### Invariants verdes ao final
```text
INV-19 PASS    toda chave de cache e todo caminho de storage inclui organization_id
```

---

# Paralelismo e caminho crítico

### Podem rodar em paralelo

| O que | Com o quê | Por quê |
|---|---|---|
| **Fase 5a** | Fases 0-4 | repositório diferente, sem dependência; é a única fase que pode começar hoje |
| **Fase 7** *(construção)* | Fase 5c | não toca o núcleo de isolamento |
| **Fase 8** *(itens PLH)* | qualquer fase depois da 3 | independentes |
| Correções de segurança da 5a | tudo | valem por si, mesmo que a productização parasse |

### Caminho crítico

```text
0 → 1 → 2 → 3 → 4 → 5b → 5c → 6 → SECOND TENANT GATE
```

**As Fases 1, 2, 3 e 4 são estritamente sequenciais.** Cada uma depende da anterior de forma dura:
sem tenancy não há contexto; sem contexto não há autorização; sem autorização não há credencial por
tenant. Não há atalho aqui.

**Fase 3 é a mais longa e a mais arriscada** — é onde o comportamento muda de verdade.

---

# Decisões OPEN e onde elas travam

**35 decisões: 11 CLOSED (V1) · 3 PARCIAL · 21 OPEN** (TD-001 fechada na rodada 10). Nenhuma trava a **escrita** deste plano.

**Rodada 7 fechou TD-003, TD-004 e TD-010** — a Fase 0 está inteiramente definida e pode ser
executada sem mais decisões.

### As que travam uma fase

| Decisão | Trava | Observação |
|---|---|---|
| **TD-001** — estratégia de tenancy no banco | **Fase 1** | ✅ **CLOSED (V1)** na rodada 10; implementada na rodada 11 |
| **PD-023** — topologia do serviço Go | **Fase 5c** | ✅ **CLOSED (V1)** na rodada 17: Variante **B**, um Meta App da plataforma |
| ~~**TD-010** — migrations~~ | ~~Fase 0~~ | ✅ **CLOSED (rodada 7)** — `node-pg-migrate` |
| ~~**TD-003** — Postgres obrigatório~~ | ~~Fase 0~~ | ✅ **CLOSED (rodada 7)** — fail-fast em produção |
| ~~**TD-004** — secrets~~ | ~~Fase 0~~ | ✅ **CLOSED (rodada 7)** — `ENCRYPTION_MASTER_KEY` + `integration_secrets` |
| **TD-012** — entitlements fail-closed | **Fase 3** | direção já recomendada |
| **TD-002**, **PD-002**, **PD-016**, **PD-017**, **PD-018**, **PD-019**, **PD-021**, **PD-022** | — | **já CLOSED** |
| **PD-004** *(roles)* | **Fase 2**, parcialmente | a direção (usuários individuais) está fechada; o conjunto de roles pode ficar em `owner`/`member` |

### As que **não** travam nada do caminho crítico

**PD-001** (providers), **PD-003** (múltiplos números), **PD-005** (módulos), **PD-006** (OAuth vs
manual), **PD-007** (trial), **PD-008** (plano gratuito), **PD-009** *(quotas/pricing)*, **PD-010**
(retenção — trava a Fase 8/RBPL), **PD-011**, **PD-012**, **PD-013** (Mailchimp), **PD-014**
(Instagram), **PD-015** (Financeiro Ink), **PD-020** (custos de API), **TD-005..TD-009**, **TD-011**.

**Nenhuma decisão foi inventada por este plano.** PD-023 permanece OPEN.

---

# OPS-06 / OPS-07 / OPS-08 — executados em 15/09/2026

Consultados pelo usuário no Railway, serviço **`whatsapp-webhook-go`** → **Variables**.
O contrato da consulta foi respeitado: só `definido` / `não definido`, **nenhum valor colado**.

| # | Variável | Resultado | Estado |
|---|---|---|---|
| **OPS-06** | `META_APP_SECRET` | **DEFINIDO** — *adicionado nesta data*, com o mesmo valor que o painel já usa para o mesmo Meta App (correto: o App Secret é por App, não por serviço) | ✅ **VERIFIED / OK** |
| **OPS-07** | `API_KEY` | **DEFINIDO** | ✅ **VERIFIED / OK** — os 21 endpoints internos estão autenticados |
| **OPS-08** | `DATABASE_URL` | **DEFINIDO** | ✅ **VERIFIED / OK** — persistência real, não memory store |

**OPS-06 fechou com o restart.** O boot de 02:01:15 (redeploy forçado) reportou `sig_verify=true`, e
o negative testing contra o processo novo devolveu **403** sem assinatura e **403** com assinatura
inválida. A condição "aguardando restart" está cumprida e verificada em runtime, não presumida.

**O que isso NÃO resolve.** Os três casos foram resolvidos **por configuração, não por código**:

- `webhook.go:136` continua desabilitando a validação HMAC quando o segredo falta, em vez de abortar
  o boot → **B-25** permanece, coberto por **INV-30**, agora com a asserção de **fail-fast**;
- `db.go:18-22` continua permitindo subir sem persistência com `/health` respondendo `ok` →
  coberto por **INV-38**.

Configuração some num serviço novo, num redeploy limpo ou num ambiente recriado. É a diferença
entre *não estar acontecendo* e *não poder acontecer*.

O registro histórico da janela em que o webhook rodou sem verificar assinatura, e a avaliação de
consequência prática, estão no audit →
[Remediação de 15/09/2026](./productization-audit.md#remediação-de-15092026--assinatura-do-webhook-da-meta).

**Uma quarta consulta, indispensável para OPS-10 / PD-023** — listada à parte por ser de outro
painel e não fazer parte das três acima:

| # | Onde | Pergunta | Resposta esperada |
|---|---|---|---|
| **OPS-10** | Meta Business Manager → **Usuários do sistema** | o access token usado pelo serviço é de **System User** ou de **usuário**? | `system user` / `usuário` |

Interpretação: **`system user`** → sem expiração; a ausência de rotação (WG-21) é **latente**.
**`usuário`** → expira em ~60 dias; a ausência de rotação é **ativa** e já é risco operacional hoje.

Esta quarta resposta, somada a **quantos apps/WABAs a conta comercial possui**, é o que informa
**PD-023** — se um app/WABA não puder servir números de clientes distintos, a Variante A da Fase 5c
deixa de ser escolha e vira imposição.

**Nenhuma dessas consultas bloqueia as Fases 0-4.** As três primeiras são pré-requisito da Fase 5c;
a quarta é o gate de PD-023.

---

# O que este plano NÃO faz

Por decisão fechada (**PD-002**, **PD-022**, **R-01**, **R-02**), o plano **não** contempla:

```text
multi-store
visão consolidada entre Organizations
modo loja='all'
fetchAcrossInkStores
DRE consolidada entre Organizations
platform admin usado para operar Use Sul/Centro/Norte
multiStoreMode
Migração Use Origens como feature do produto
Mailchimp · Instagram  (FUTURE PRODUCT)
```

Platform admin **continua previsto** — para suporte, saúde de integração e billing. O que está
proibido é usá-lo como veículo de relatório de negócio entre Organizations.

---

# Maior risco de execução

Não é a topologia do serviço Go (PD-023): está isolada numa sub-fase, com as duas variantes
dimensionadas. Não é a janela coordenada da 5b: é estreita, ensaiável e reversível se o plano de
rollback conjunto estiver escrito antes.

**O maior risco é que a migração produza novas instâncias exatamente do defeito que ela existe para
remover — e que o mecanismo desenhado para detectá-las não esteja realmente funcionando quando isso
acontecer.**

São dois fatos da auditoria que, juntos, produzem esse risco:

**1. O modo de falha deste código não é ignorância — é divergência.** A auditoria encontrou a mesma
regra financeira implementada duas vezes, com rigor diferente, a ~9.300 linhas de distância: `G-01`
(fail-closed, correto, com o comentário explicando por quê) e `F-01` (sem conferir atribuição).
Ninguém "não sabia": o padrão certo estava escrito no mesmo repositório. No serviço Go, o mesmo —
`WG-P-02` aplica "receba, não descubra" e documenta que a auto-descoberta foi **tentada e removida**,
enquanto o webhook ao lado simplesmente assume o tenant.

**As Fases 3, 4 e 5 são feitas de dual-read/write, caminhos de fallback mantidos por uma release e
migrações por domínio.** São, precisamente, as condições que produzem duas implementações da mesma
regra convivendo — que é o mecanismo de origem de `F-01`. O plano vai atravessar meses no estado que
historicamente gerou o defeito.

**2. O mecanismo de detecção é ele próprio um entregável, e chega antes de ter sido exercitado.**
Toda a estrutura deste plano repousa em "a fase fecha quando os invariants passam". Mas os 37
invariants não existem: são construídos na Fase 0 e vão ficando verdes ao longo do caminho. Um
harness escrito sob pressão de entrega tende a ser escrito **para passar**, não para detectar — e o
sintoma disso é silêncio, que é indistinguível de sucesso. É o mesmo padrão de falha que a auditoria
inteira descreve: o sistema não avisa, ele só concorda.

O agravante concreto: hoje existem **228 testes que passam e nenhum deles cobre auth, tenancy,
ownership, entitlements, secrets ou roteamento de webhook**. A suíte atual é verde e não protege
nada do que este plano vai mexer. A sensação de cobertura já existe sem a cobertura.

**Mitigações que o plano incorpora:**

- **Critério de saída 4 da Fase 0:** o harness precisa **reprovar** um invariant propositalmente
  quebrado antes de a fase fechar. Um harness que nunca reprovou nada não provou nada.
- **Teste decisivo do INV-09** (Fase 3, critério 3): banco com **uma** Organization. O banco atual,
  com três lojas, é estruturalmente incapaz de pegar a classe de defeito do `lojaAtribuidaPadrao()`.
  Testar com a forma errada de dados é como não testar.
- **INV-07 (RLS) na Fase 1, cedo:** é a única proteção que continua valendo quando a disciplina
  humana falha, e vale durante as fases seguintes, não só no fim.
- **Regra de duplicação:** onde houver duas implementações da mesma regra de ownership,
  **centralizar** em vez de corrigir as duas. Aplicada explicitamente a `G-01`/`F-01` na Fase 4.
- **Janelas de fallback curtas e datadas:** "por uma release", nunca "até não precisar mais".
  Todo caminho antigo mantido é uma segunda implementação viva.

**O sinal de alarme a vigiar durante a execução:** uma fase que fecha com todos os invariants verdes
**na primeira tentativa**, sem que nenhum tenha reprovado durante o desenvolvimento. Nas Fases 1, 3
e 5c isso é praticamente impossível de acontecer de verdade — e muito fácil de acontecer se os
invariants estiverem medindo a coisa errada.
