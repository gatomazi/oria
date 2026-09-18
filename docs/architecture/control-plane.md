# Oria Admin — Control Plane

> Contrato da API e modelo de dados do `apps/platform-admin` (service `oria-admin`).
>
> Este documento é a **fonte do contrato** para o frontend do Oria Admin. Toda rota, corpo,
> resposta e código de erro descritos aqui são o que o backend entrega. O frontend não deve
> inventar campo, não deve derivar autoridade de nada que ele mesmo envie, e não deve exibir dado
> que este contrato não devolve.

---

## 1. Dois planos, dois apps

```text
Oria Admin  = Control Plane   apps/platform-admin   service oria-admin   /api/platform/*
Oria Panel  = Tenant Plane    apps/panel            service oria-panel   /api/admin/*
```

Os dois compartilham **o mesmo PostgreSQL**. Não compartilham processo, código de runtime,
cookie, sessão nem identidade:

| | Control Plane | Tenant Plane |
|---|---|---|
| Identidade | `platform_admins` | `users` |
| Sessão | `platform_admin_sessions` | `sessions` |
| Cookie | `__Host-oria_platform_admin` (prod) / `oria_platform_admin` (dev) | `__Host-oria_session` / `oria_session` |
| Prefixo | `/api/platform/*` | `/api/admin/*` |
| Segredo | `PLATFORM_ADMIN_SESSION_SECRET` | `ADMIN_SESSION_SECRET` |

Um token de sessão de tenant apresentado ao Oria Admin é **401**, e vice-versa. As duas tabelas de
sessão são distintas e nenhuma rota do Admin consulta `sessions`; nenhuma rota do painel consulta
`platform_admin_sessions`.

### 1.1 Por que o app é separado e não importa o painel

O Railway builda apenas o diretório-raiz do service (`/apps/platform-admin`). Em runtime o
`apps/panel` **não existe** na imagem do `oria-admin`. Portanto:

- `apps/platform-admin` tem `package.json`, dependências (`pg`) e servidor próprios;
- não existe `require('../panel/...')` em lugar nenhum;
- o reuso acontece **pelo banco** (funções SQL `SECURITY DEFINER` já existentes, e as novas deste
  documento) e por **cópia mínima e declarada** — cada arquivo copiado diz de onde veio, no topo.

As **migrations continuam em `apps/panel/migrations`**: o painel é o dono do schema daquele banco.

---

## 2. Segurança — o que o control plane pode e o que não pode

Não existe e não vai existir:

```text
BYPASSRLS · SUPERUSER na role da aplicação · DISABLE RLS · impersonation
isSuperAdmin bypass · `if organizationName == "Use Origens"` · query global crua em tabela de tenant
```

**Toda operação sobre dado de tenant** segue exatamente esta sequência, sem atalho:

```text
platform admin autenticado (sessão válida + CSRF)
  → Organization alvo EXPLÍCITA na rota (/organizations/:organizationId/...)
  → comOrganization(pool, organizationId, ...)   (BEGIN + set_config('app.current_organization_id', …, true))
  → operação, sob a RLS forçada, como qualquer request do painel
  → registro em platform_audit_logs
```

O `:organizationId` da **rota** é a única autoridade. Um `organization_id` no corpo do request é
**ignorado** quando coincide e **rejeitado com 400 `organization_no_corpo`** quando é enviado —
nunca vira alvo. Isto é testado (§28 do comando: *target A + forged B in body → B nunca vira
authority*).

**Listagens globais** (que atravessam Organizations) não leem tabela de tenant direto. Elas passam
por *read models* explícitos: funções SQL `SECURITY DEFINER` criadas na migration, com
`REVOKE ALL … FROM PUBLIC`, projeção estreita e nenhum campo sensível (§6 deste doc).

> **Nota honesta sobre a role do banco.** Hoje a `DATABASE_URL` do Railway é o papel **dono** do
> banco, herdado do painel. Isso *poderia* ser usado para varrer tabela de tenant — e não é. O
> código está escrito como se a role fosse restrita: nenhuma query do control plane toca tabela
> tenant-owned fora de `comOrganization`, e toda leitura global passa pelos read models.
> **Endurecer a role do control plane (role própria, `NOSUPERUSER NOBYPASSRLS`, não dona, com
> `GRANT EXECUTE` só nos read models) é passo posterior**, com o mesmo desenho do OPS-14 do painel.
> As funções já nascem com `REVOKE ALL FROM PUBLIC` para que esse `GRANT` seja a única mudança.

---

## 3. Modelo de dados

Todas as tabelas abaixo são **de plataforma**: globais, privadas, **não** tenant-owned, **não**
sob RLS. Elas são registradas em `apps/panel/lib/platform/tenancy-manifest.js` em
`TABELAS_GLOBAIS` + `TABELAS_GLOBAIS_PRIVADAS` (a role da aplicação do painel não as lê).

Migration: `apps/panel/migrations/1790000400000_platform-admin.js`
(SQL em `migrations/sql/0019-platform-admin.up.sql` / `.down.sql`).

### 3.1 `platform_admins`

| coluna | tipo | regra |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `email` | TEXT | único; `lower(btrim(email))`, precisa conter `@` |
| `nome` | TEXT | opcional |
| `password_hash` | TEXT | `scrypt$…` (mesmo formato do painel). Nunca sai em resposta. |
| `papel` | TEXT | `platform_owner` \| `platform_operator` |
| `status` | TEXT | `active` \| `disabled` |
| `criado_em` / `atualizado_em` / `ultimo_login_em` | TIMESTAMPTZ | |

Invariante: **sempre existe ao menos um `platform_owner` com `status='active'`**. Desativar,
excluir ou rebaixar o último é `409 ultimo_platform_owner`. Garantido por função SQL que conta
dentro da mesma transação (`platform_admin_contar_owners_ativos`), não só por checagem no Node.

### 3.2 `platform_admin_sessions`

| coluna | tipo | regra |
|---|---|---|
| `id` | TEXT PK | `sha256(token)` em hex — o token cru **nunca** é gravado |
| `admin_id` | UUID | FK `platform_admins` `ON DELETE CASCADE` |
| `criado_em` / `expira_em` / `ultimo_uso_em` | TIMESTAMPTZ | `expira_em > criado_em` |
| `revogada_em` / `revogada_por` / `motivo_revogacao` | | revogação vale na request seguinte |

TTL padrão: **8 horas**. A sessão é validada no banco a **cada** request.

### 3.3 `plans` e `plan_features`

```text
plans(id UUID PK, chave TEXT UNIQUE, nome, descricao, status active|archived, criado_em, atualizado_em)
plan_features(plan_id UUID → plans ON DELETE CASCADE, feature TEXT, habilitada BOOLEAN, PK (plan_id, feature))
```

`feature` tem `CHECK` contra o **vocabulário fechado** copiado do registry canônico
(`apps/panel/lib/platform/entitlements.js` → `FEATURES`). Um teste compara a lista do `CHECK` com
o registry: divergir reprova.

Vocabulário (12): `whatsapp`, `instagram`, `advancedAutomations`, `catalog`, `exchanges`,
`refunds`, `financial`, `creative_generator`, `creative_clean_angles`, `creative_remarketing`,
`creative_funnel_visual`, `creative_multi_product`.

### 3.4 `organization_subscriptions`

```text
id UUID PK
organization_id UUID → organizations ON DELETE CASCADE
plan_id         UUID → plans ON DELETE RESTRICT
status          TEXT active|canceled
iniciada_em, cancelada_em TIMESTAMPTZ
CHECK ((status = 'canceled') = (cancelada_em IS NOT NULL))
UNIQUE INDEX (organization_id) WHERE status = 'active'   ← no máximo UMA assinatura ativa
```

Trocar de plano = cancelar a ativa e criar a nova, **na mesma transação**. Duas ativas é
impossível pelo índice, não por convenção.

### 3.5 `organization_entitlement_overrides`

```text
organization_id UUID → organizations ON DELETE CASCADE
feature         TEXT (mesmo CHECK do vocabulário)
permitido       BOOLEAN NOT NULL          ← pode ser TRUE (conceder) ou FALSE (negar)
motivo          TEXT
criado_por      UUID → platform_admins ON DELETE SET NULL
criado_em, atualizado_em
PRIMARY KEY (organization_id, feature)
```

### 3.6 `organization_owner_invites`

```text
id UUID PK
organization_id UUID → organizations ON DELETE CASCADE
token_hash      TEXT UNIQUE CHECK ~ '^[0-9a-f]{64}$'   ← só o SHA-256; o token cru só existe na resposta
email           TEXT (lower, com @)
papel           TEXT owner|member
criado_por      UUID → platform_admins ON DELETE SET NULL
criado_em, expira_em, usado_em, revogado_em
revogado_por    UUID → platform_admins ON DELETE SET NULL
CHECK (expira_em > criado_em)
CHECK (NOT (usado_em IS NOT NULL AND revogado_em IS NOT NULL))
UNIQUE INDEX (organization_id, email) WHERE usado_em IS NULL AND revogado_em IS NULL
```

Um convite pendente por (Organization, e-mail). Uso único: consumir trava a linha
(`FOR UPDATE`) e grava `usado_em` na mesma transação que cria o membership.

Convite é **diferente** do `onboarding_invites` do painel (Fase 7): aquele é o fluxo
*self-service* em que a pessoa aceita o convite e **cria** a Organization. Aqui a Organization já
existe; o convite só liga uma pessoa a ela como owner.

### 3.7 `platform_audit_logs`

```text
id              BIGINT GENERATED ALWAYS AS IDENTITY PK   ← log: ordem monotônica é o ponto
criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
actor_admin_id  UUID → platform_admins ON DELETE SET NULL
actor_email     TEXT NOT NULL          ← retrato; o rastro sobrevive ao admin
action          TEXT CHECK ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
entity_type     TEXT NOT NULL
entity_id       TEXT
organization_id UUID → organizations ON DELETE SET NULL
before          JSONB
after           JSONB
```

`before`/`after` passam por um **sanitizador com allowlist de chaves** antes de gravar: qualquer
chave que case `token|secret|senha|password|hash|key|authorization|cookie|ciphertext` é recusada
(erro, não redação silenciosa). Um teste reprova se um segredo chegar à tabela ou à resposta.

Ações auditadas (vocabulário fechado, `lib/audit.js`):

```text
admin.login            admin.logout            admin.login_failed
admin.created          admin.deactivated       admin.reactivated       admin.role_changed
plan.created           plan.updated            plan.archived           plan.features_replaced
organization.created   organization.suspended  organization.reactivated
subscription.created   subscription.changed
entitlement.override_set                       entitlement.override_removed
invite.issued          invite.reissued         invite.revoked
member.removed
integration.tested
```

**Auditoria não é opcional.** `changePlan`, `suspend`, `reactivate`, override e convite gravam a
auditoria **dentro da mesma transação** da mutação. Se a auditoria falhar, a mutação desfaz.
Dois testes cobrem isso (§28: *plan change sem audit → teste falha*, *suspension sem audit →
teste falha*) e um negative control prova que a suíte reprova quando alguém tira o insert.

---

## 4. Autenticação e sessão

### 4.1 Cookie

```text
produção:  __Host-oria_platform_admin=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=…
dev:       oria_platform_admin=<token>;        HttpOnly; SameSite=Strict; Path=/; Max-Age=…
```

O token é 256 bits aleatórios em `base64url` (43 chars). No banco fica só o SHA-256.

### 4.2 CSRF

Todo método que **não** seja `GET`/`HEAD`/`OPTIONS` exige o header:

```text
X-CSRF-Token: <csrfToken>
```

`csrfToken = HMAC-SHA256(HKDF(PLATFORM_ADMIN_SESSION_SECRET, 'oria-platform-csrf-v1'), sessaoId)`
em `base64url`. Ele é devolvido por `POST /api/platform/auth/login` e por
`GET /api/platform/auth/session`. Está **vinculado à sessão**: o de uma sessão não vale em outra.
Comparação `timingSafeEqual`.

Ausente ou inválido → **403 `csrf`**. SameSite=Strict é segunda camada, não a única.

### 4.3 Fixation

O login **sempre** gera token novo, gerado no servidor. Nenhum valor vindo do cliente vira id de
sessão. Além disso, ao autenticar com sucesso, toda sessão anterior **daquele admin** é revogada
(`motivo='login'`), salvo quando o cliente pede explicitamente `manterOutrasSessoes: true`.

### 4.4 Rate limit

Balde por **conta** (e-mail normalizado): 10 falhas / 15 min. Balde global: 200 falhas / 60 s
(freia varredura de contas). Sucesso limpa o balde da conta. Em memória, processo único — mesma
limitação registrada do painel.

Bloqueado → **429 `rate_limited`**, com `Retry-After` em segundos.

### 4.5 Respostas de login

Credencial errada, e-mail inexistente e admin `disabled` devolvem **a mesma** resposta
`401 credenciais_invalidas`, com o mesmo custo de tempo (hash de referência quando o e-mail não
existe). A resposta nunca diz se o e-mail está cadastrado.

---

## 5. Formato geral

### 5.1 Requests

- `Content-Type: application/json` em todo corpo. Corpo maior que **64 KB** → `413`.
- **Campos desconhecidos são rejeitados** (`400 campo_desconhecido`, com `detalhes.campos`).
  Whitelist estrita, struct tipada por rota.
- IDs de recurso são UUID. Valor malformado é tratado como **não encontrado** (`404`), não `500`.

### 5.2 Respostas de erro

Sempre este envelope, sem exceção:

```json
{ "erro": "codigo_estavel", "mensagem": "texto curto, seguro para exibir" }
```

Com detalhe estruturado quando ajuda o frontend:

```json
{ "erro": "feature_desconhecida", "mensagem": "…", "detalhes": { "features": ["foo"] } }
```

Nenhuma mensagem carrega stack trace, SQL, nome de tabela, valor de segredo, nem texto cru de
provider.

### 5.3 Códigos de status

| status | quando |
|---|---|
| `200` | leitura ou mutação com corpo |
| `201` | criação (com `Location`) |
| `204` | mutação sem corpo |
| `400` | corpo malformado, campo desconhecido, `organization_id` no corpo |
| `401` | sem sessão / sessão expirada / sessão revogada |
| `403` | CSRF ausente ou inválido; papel insuficiente; gate desligado |
| `404` | não existe — **e também** o que existe mas o pedido não deveria revelar |
| `409` | conflito de estado (já existe, último owner, bootstrap já usado) |
| `413` | corpo grande demais |
| `422` | validação semântica (feature fora do vocabulário, plano inexistente) |
| `429` | rate limit |
| `503` | dependência indisponível (banco fora) — fail-closed, nunca "deixa passar" |

### 5.4 Paginação

Todas as listagens:

```text
?limit=<1..200, default 50>&cursor=<opaco>
```

```json
{ "itens": [ … ], "proximoCursor": "eyJ…" }
```

O cursor é opaco (base64url de `{criadoEm, id}`), estável e só válido para a mesma rota+filtros.
Cursor inválido → `400 cursor_invalido`. `proximoCursor: null` = fim.

### 5.5 Papéis

| papel | pode |
|---|---|
| `platform_operator` | tudo que é leitura; suspender/reativar; convite; override; troca de plano |
| `platform_owner` | o acima **+** gerir `platform_admins` e criar/arquivar `plans` |

Papel insuficiente → `403 papel_insuficiente`.

---

## 6. Read models globais (as funções SQL)

Criadas na migration, `SECURITY DEFINER`, `SET search_path = pg_catalog, public`,
`REVOKE ALL … FROM PUBLIC`. Projeção estreita — nenhuma devolve `config`, `ciphertext`, `headers`,
`body`, `password_hash` nem token.

| função | devolve |
|---|---|
| `platform_listar_organizations(p_status, p_busca, p_limite, p_cursor_em, p_cursor_id)` | `id, nome, status, criado_em, store_id, store_nome, owners_ativos, plano_chave, onboarding_status` |
| `platform_organization_detalhe(p_org)` | o acima + `membros`, `overrides`, `updated_at` do onboarding |
| `platform_listar_users(p_busca, …)` | `id, email, nome, status, criado_em, ultimo_login_em, organizations[]` |
| `platform_listar_onboardings(…)` | `organization_id, organization_nome, status, current_step, completed_steps[], blocked_step, last_error_code, atualizado_em` |
| `platform_listar_integracoes(p_org, …)` | `organization_id, provider, status, display_name, last_test_em, last_success_em, last_error_code` |
| `platform_listar_jobs(p_org, …)` | `job, organization_id, ocupado, iniciado_em, ate, proxima_em` |
| `platform_listar_webhooks(p_org, …)` | `id, recebido_em, verificado, metodo_auth, event_name, organization_id` |

O que **não** sai desses read models, por desenho:

- `integrations.config` e `integration_secrets.*` — nunca. `display_name` é derivado e sanitizado;
  `last_error_code` vem do vocabulário fechado de `lib/platform/onboarding.js` (`PROVIDER_*`).
- `webhook_eventos.headers` e `.body` — nunca. São payload cru com PII.
- `job_leases.dono` — vira o booleano `ocupado` (é identificador de worker/host).

---

## 7. Entitlements — o resolver

```text
acesso_efetivo(org, feature) =
      organization.status = 'active'
  AND existe assinatura com status = 'active'
  AND (  override explícito da organization para a feature   → usa override.permitido
       ∨ plan_features da assinatura ativa                   → usa habilitada
       ∨ false )
```

Precedência, sem ambiguidade:

```text
override da Organization   >   feature do plano   >   false
```

Regras duras:

- **Feature fora do vocabulário → rejeita** (`422 feature_desconhecida`). Não é "false silencioso":
  pedir uma feature que não existe é erro de programação.
- **Sem assinatura ativa → todas as features negadas.** Ausência nega.
- **Organization `suspended` → todas as features negadas**, mesmo com plano e override `true`.
- **Remover o override → volta a herdar do plano** (não volta a `false` por acidente).
- Um override com `permitido: false` **nega** mesmo que o plano conceda.

Este resolver é o mesmo `checkEntitlement` fail-closed do painel em espírito — ausência nega, erro
nega, plano nulo nega — e **nunca** faz `{ ...DEFAULTS, ...plano }`.

### 7.1 O plano técnico `internal`

Semeado pela migration (é **dado**, não bypass), com **exatamente** as 10 features do perfil do
Tenant #1 (`apps/panel/config/entitlements/tenant1-entitlements.json`):

```text
catalog · creative_clean_angles · creative_funnel_visual · creative_generator
creative_multi_product · creative_remarketing · exchanges · financial · refunds · whatsapp
```

**Não** inclui `instagram` nem `advancedAutomations`. Não implica allow-all: as duas ausentes são
negadas como qualquer outra ausência. Um teste compara a semente com o JSON do perfil: divergir
reprova.

### 7.2 Efeito da suspensão (§14)

Suspender grava `organizations.status = 'suspended'`. Isso produz **efeito real**, não rótulo:

| superfície | efeito |
|---|---|
| login de tenant / seleção de workspace | `auth_memberships()` já filtra `o.status = 'active'` → a Organization some das memberships |
| entitlements | o resolver nega **todas** as features |
| jobs | `platform_organizations_ativas()` (read model dos schedulers) não devolve a Organization |
| envios / geração de criativo / ações de provider | negadas pela porta de entitlements |
| webhooks | podem ser autenticados e **persistidos**; não produzem efeito tenant-owned |

Os dados **permanecem**. O Admin continua vendo tudo. Reativar restaura.

---

## 8. O gate de criação (§13) — Tenant #1 vs. tenant externo

Dois caminhos, distintos e explícitos. Nunca por nome de Organization.

```text
SECOND_TENANT_ENABLED = 1  →  criação de Organization externa LIBERADA
SECOND_TENANT_ENABLED = 0/ausente (padrão)
    ├─ COUNT(*) FROM organizations = 0  →  BOOTSTRAP INTERNO permitido (Tenant #1)
    └─ COUNT(*) FROM organizations > 0  →  403 second_tenant_disabled
```

O bootstrap interno:

- exige `bootstrapInterno: true` **explícito** no corpo (o cliente declara a intenção; o servidor
  decide se pode);
- é verificado **dentro da transação de criação**, com o `COUNT(*)` sob o mesmo `SERIALIZABLE`
  (dois pedidos simultâneos: um cria, o outro recebe `409 bootstrap_interno_indisponivel`);
- **não pode ser reutilizado**: assim que existir uma Organization, o caminho recusa para sempre;
- não olha o nome. `"Use Origens"` é só um nome.

Valor inválido de `SECOND_TENANT_ENABLED` (nem `0`/`1`/vazio) → o processo **não sobe** (§9.2).

---

## 9. Boot e configuração

### 9.1 Variáveis

| variável | obrigatória | nota |
|---|---|---|
| `DATABASE_URL` | **sim** | mesmo Postgres do painel |
| `PLATFORM_ADMIN_SESSION_SECRET` | **sim em produção** | ≥ 32 caracteres |
| `PORT` | não | default `8080` |
| `NODE_ENV` | não | `production` liga Secure/`__Host-` |
| `SECOND_TENANT_ENABLED` | não | `0` (padrão) ou `1` |
| `PLATFORM_ADMIN_SESSION_TTL_HOURS` | não | default `8`, 1..24 |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | não | **só** para `npm run platform-admin:bootstrap` |

### 9.2 Fail-fast (§25)

Em produção, o processo **não sobe** se:

- `DATABASE_URL` ausente, ou o banco não responde, ou as migrations mínimas não rodaram;
- `PLATFORM_ADMIN_SESSION_SECRET` ausente ou com menos de 32 caracteres;
- `SECOND_TENANT_ENABLED` com valor inválido.

Fora de produção, um segredo de desenvolvimento é gerado em memória, com aviso no log.

**O processo NÃO exige que exista um primeiro admin.** Sem nenhum `platform_admins` ativo, o app
sobe, `GET /health` responde `ok`, e o login responde `503 bootstrap_pendente` — nunca senha
padrão, nunca "cria o admin no boot".

### 9.3 Bootstrap do primeiro admin

```bash
PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... npm run platform-admin:bootstrap
```

Idempotente: rodar de novo com o mesmo e-mail **não** troca a senha e **não** duplica; imprime
`já existe`. Nunca imprime a senha, nem no log de erro. Sem as duas variáveis, o script recusa
com instrução — não inventa credencial. Detalhes em
[`docs/operations/platform-admin-bootstrap.md`](../operations/platform-admin-bootstrap.md).

---

## 10. Rotas

Prefixo de todas as rotas de API: `/api/platform`. Salvo indicação contrária, **toda** rota exige
sessão válida; toda mutação exige `X-CSRF-Token`.

### 10.1 Health — público

```http
GET /health  →  200 {"status":"ok"}
```

Sem versão, sem host, sem estado do banco, sem contagem. Não exige sessão. É o healthcheck do
Railway.

### 10.2 Auth

#### `POST /api/platform/auth/login` — público

```json
{ "email": "pessoa@exemplo.com", "senha": "…", "manterOutrasSessoes": false }
```

`200`:

```json
{
  "admin": { "id": "uuid", "email": "…", "nome": "…", "papel": "platform_owner" },
  "csrfToken": "…",
  "expiraEm": "2026-09-18T04:00:00.000Z"
}
```

`Set-Cookie` com o cookie da §4.1.

| erro | status |
|---|---|
| `credenciais_invalidas` | 401 |
| `rate_limited` (+ `Retry-After`) | 429 |
| `bootstrap_pendente` — nenhum admin existe ainda | 503 |
| `autenticacao_indisponivel` — banco fora | 503 |

#### `POST /api/platform/auth/logout`

Sessão + CSRF. Revoga a sessão atual e limpa o cookie. → `204`.

#### `GET /api/platform/auth/session`

→ `200` com o mesmo corpo do login (sem `Set-Cookie`), ou `401 nao_autenticado`.
É a rota que o frontend chama no carregamento para saber se está logado e obter o `csrfToken`.

### 10.3 Visão geral

#### `GET /api/platform/overview`

```json
{
  "organizations": { "total": 0, "ativas": 0, "suspensas": 0 },
  "onboardings":   { "emAndamento": 0, "bloqueados": 0, "concluidos": 0 },
  "convites":      { "pendentes": 0, "expirados": 0 },
  "integracoes":   { "conectadas": 0, "erro": 0, "desconectadas": 0 },
  "planos":        { "ativos": 0 },
  "admins":        { "ativos": 0 },
  "bootstrapInternoDisponivel": true,
  "second_tenant_enabled": false
}
```

Tudo factual, vindo dos read models. Zero é zero — o frontend **não** deve inventar dado quando
não há fonte (§17 do comando).

### 10.4 Platform admins (`platform_owner` para mutações)

| método | rota | corpo | resposta |
|---|---|---|---|
| `GET` | `/api/platform/admins` | — | `{itens:[{id,email,nome,papel,status,criadoEm,ultimoLoginEm}], proximoCursor}` |
| `POST` | `/api/platform/admins` | `{email, nome?, senha, papel}` | `201 {id,email,nome,papel,status}` |
| `POST` | `/api/platform/admins/:adminId/deactivate` | — | `200 {id,status}` |
| `POST` | `/api/platform/admins/:adminId/reactivate` | — | `200 {id,status}` |
| `POST` | `/api/platform/admins/:adminId/role` | `{papel}` | `200 {id,papel}` |

`senha`: mínimo 12, máximo 200 caracteres (mesma regra do painel). Nunca devolvida, nunca logada.

| erro | status |
|---|---|
| `email_em_uso` | 409 |
| `ultimo_platform_owner` — desativar/rebaixar o último owner ativo | 409 |
| `nao_encontrado` | 404 |
| `papel_insuficiente` | 403 |
| `senha_fraca` (`detalhes.minimo`) | 422 |

### 10.5 Planos

| método | rota | corpo | resposta |
|---|---|---|---|
| `GET` | `/api/platform/plans` | — | `{itens:[Plan], proximoCursor}` |
| `POST` | `/api/platform/plans` | `{chave, nome, descricao?, features:[]}` | `201 Plan` |
| `GET` | `/api/platform/plans/:planId` | — | `200 Plan` |
| `PATCH` | `/api/platform/plans/:planId` | `{nome?, descricao?}` | `200 Plan` |
| `PUT` | `/api/platform/plans/:planId/features` | `{features:[…]}` (substitui o conjunto) | `200 Plan` |
| `POST` | `/api/platform/plans/:planId/archive` | — | `200 Plan` |

`Plan`:

```json
{
  "id": "uuid", "chave": "internal", "nome": "Internal", "descricao": "…",
  "status": "active",
  "features": ["catalog", "whatsapp", "…"],
  "assinaturasAtivas": 1,
  "criadoEm": "…", "atualizadoEm": "…"
}
```

| erro | status |
|---|---|
| `feature_desconhecida` (`detalhes.features`) | 422 |
| `chave_em_uso` | 409 |
| `plano_com_assinatura_ativa` — arquivar plano em uso | 409 |
| `papel_insuficiente` | 403 |

`chave` casa `^[a-z][a-z0-9_]{1,62}$`. Arquivar **não** apaga: o histórico de assinaturas fica.

### 10.6 Organizations

#### `GET /api/platform/organizations`

Filtros: `?status=active|suspended` · `?q=<busca por nome, ≥2 chars>` · `limit` · `cursor`.

```json
{
  "itens": [{
    "id": "uuid", "nome": "…", "status": "active",
    "criadoEm": "…",
    "store": { "id": "uuid", "nome": "…" },
    "plano": { "chave": "internal", "nome": "Internal" },
    "ownersAtivos": 1,
    "onboarding": { "status": "in_progress", "currentStep": "ink" }
  }],
  "proximoCursor": null
}
```

`plano` é `null` quando não há assinatura ativa. `onboarding` é `null` quando a Organization não
passou por onboarding (é o caso de Organizations legadas).

#### `POST /api/platform/organizations` — o fluxo de criação (§12)

```json
{
  "nome": "Use Origens",
  "store": { "nome": "Use Origens" },
  "planoChave": "internal",
  "ownerEmail": "pessoa@exemplo.com",
  "idempotencyKey": "admin-2026-09-17-use-origens",
  "bootstrapInterno": true,
  "conviteValidadeHoras": 72,
  "passos": { "ink": "required", "meta": "optional", "…": "…" }
}
```

- `idempotencyKey`: 16–200 caracteres `[A-Za-z0-9_.:-]`. **Obrigatória.** Repetir a mesma chave
  com o mesmo pedido devolve o mesmo resultado (`"criada": false`); com pedido diferente →
  `409 idempotency_key_reutilizada`.
- `passos` é opcional: sem ele, vale `ONBOARDING_STEP_REQUIREMENTS`; sem os dois →
  `409 onboarding_config_required` (não existe plano padrão de onboarding).
- `bootstrapInterno` só é aceito quando o gate da §8 permite.

`201`, tudo criado numa **única transação** (`organizations`, `stores`, assinatura,
`onboarding_sessions` + `onboarding_steps`, convite, `platform_audit_logs`):

```json
{
  "criada": true,
  "organization": { "id": "uuid", "nome": "Use Origens", "status": "active", "criadoEm": "…" },
  "store": { "id": "uuid", "nome": "Use Origens" },
  "subscription": { "id": "uuid", "plano": { "chave": "internal", "nome": "Internal" }, "status": "active" },
  "entitlements": { "catalog": true, "whatsapp": true, "instagram": false, "…": false },
  "invite": {
    "id": "uuid", "email": "pessoa@exemplo.com", "papel": "owner",
    "token": "43-chars-base64url",
    "expiraEm": "…"
  },
  "onboarding": {
    "status": "in_progress", "proximoPasso": "ink",
    "passos": [{ "id": "org_store", "requirement": "required", "status": "complete", "lastErrorCode": null }]
  }
}
```

> **`invite.token` aparece UMA única vez**, nesta resposta (e na de reissue). Não é recuperável
> depois — no banco só existe o SHA-256. O frontend deve exibi-lo com um botão de copiar e um aviso
> de que não haverá segunda chance. Não o coloque em URL, log, título de página nem analytics.

| erro | status |
|---|---|
| `second_tenant_disabled` | 403 |
| `bootstrap_interno_indisponivel` — já existe Organization | 409 |
| `plano_desconhecido` | 422 |
| `plano_arquivado` | 422 |
| `onboarding_config_required` | 409 |
| `idempotency_key_reutilizada` | 409 |
| `email_invalido` / `nome_invalido` | 400 |
| `organization_no_corpo` | 400 |

#### `GET /api/platform/organizations/:organizationId` — detalhe (§18)

```json
{
  "id": "uuid", "nome": "…", "status": "active", "criadoEm": "…",
  "store": { "id": "uuid", "nome": "…", "ativa": true, "lojaLegada": null },
  "owners": [{ "userId": "uuid", "email": "…", "nome": "…", "status": "active", "papel": "owner" }],
  "membros": [{ "userId": "uuid", "email": "…", "nome": "…", "papel": "member", "status": "active" }],
  "plano": { "id": "uuid", "chave": "internal", "nome": "Internal", "features": ["…"] },
  "subscription": { "id": "uuid", "status": "active", "iniciadaEm": "…" },
  "entitlements": {
    "efetivos": { "catalog": true, "instagram": false, "…": false },
    "origem":   { "catalog": "plano", "whatsapp": "override", "instagram": "ausente" }
  },
  "overrides": [{ "feature": "whatsapp", "permitido": true, "motivo": "…", "criadoEm": "…" }],
  "onboarding": { "status": "…", "proximoPasso": "…", "passos": [ … ], "atualizadoEm": "…" },
  "integracoes": [{ "provider": "ink", "status": "connected", "displayName": "…",
                    "lastTestEm": "…", "lastSuccessEm": "…", "lastErrorCode": null }],
  "convites": [{ "id": "uuid", "email": "…", "papel": "owner", "estado": "pendente",
                 "criadoEm": "…", "expiraEm": "…" }],
  "suspensao": { "suspensaEm": "…", "motivo": "…", "por": "admin@…" }
}
```

`entitlements.origem` é o que torna a precedência **visível** na UI: `override` \| `plano` \|
`ausente` \| `organization_suspensa` \| `sem_assinatura`.

`convites[].estado`: `pendente` \| `usado` \| `revogado` \| `expirado`. **Nunca** traz `token`.

#### Suspensão e reativação

| método | rota | corpo | resposta |
|---|---|---|---|
| `POST` | `/api/platform/organizations/:organizationId/suspend` | `{motivo}` (4..500 chars) | `200 {id,status:"suspended",suspensaEm}` |
| `POST` | `/api/platform/organizations/:organizationId/reactivate` | `{motivo?}` | `200 {id,status:"active"}` |

Idempotente: suspender uma Organization já suspensa → `200` com o estado atual (sem nova
auditoria duplicada). Erros: `404 nao_encontrado`.

#### Assinatura

| método | rota | corpo | resposta |
|---|---|---|---|
| `GET` | `/api/platform/organizations/:organizationId/subscription` | — | `200 {subscription, historico:[…]}` |
| `PUT` | `/api/platform/organizations/:organizationId/subscription` | `{planoChave, motivo?}` | `200 {subscription, entitlements}` |

A troca cancela a ativa e cria a nova **na mesma transação**, e grava `subscription.changed`.
Trocar para o mesmo plano → `200` sem mudança e sem auditoria nova.

Erros: `422 plano_desconhecido`, `422 plano_arquivado`, `404 nao_encontrado`.

#### Entitlements e overrides

| método | rota | corpo | resposta |
|---|---|---|---|
| `GET` | `/api/platform/organizations/:organizationId/entitlements` | — | `200 {efetivos, origem, overrides, plano}` |
| `PUT` | `/api/platform/organizations/:organizationId/entitlements/:feature` | `{permitido, motivo}` | `200 {efetivos, origem, overrides}` |
| `DELETE` | `/api/platform/organizations/:organizationId/entitlements/:feature` | — | `200 {efetivos, origem, overrides}` |

`:feature` fora do vocabulário → `422 feature_desconhecida`. Remover override que não existe →
`404 override_inexistente`.

#### Convites de owner (§15)

| método | rota | corpo | resposta |
|---|---|---|---|
| `GET` | `/api/platform/organizations/:organizationId/invites` | — | `200 {itens:[Convite]}` (sem token) |
| `POST` | `/api/platform/organizations/:organizationId/invites` | `{email, papel?, validadeHoras?}` | `201 {…, token}` |
| `POST` | `/api/platform/organizations/:organizationId/invites/:inviteId/reissue` | `{validadeHoras?}` | `200 {…, token}` — revoga o anterior e emite outro |
| `POST` | `/api/platform/organizations/:organizationId/invites/:inviteId/revoke` | `{motivo?}` | `200 {id, estado:"revogado"}` |

`validadeHoras`: 1..168 (7 dias), default 72.

| erro | status |
|---|---|
| `convite_pendente_existe` — já há pendente para o e-mail | 409 |
| `convite_ja_usado` | 409 |
| `convite_ja_revogado` | 409 |
| `ultimo_owner` — revogar deixaria a Organization sem owner ativo nem convite de owner pendente | 409 |
| `feature`/`papel` inválido | 422 |

**Nunca deixar a Organization sem owner ativo.** A regra é verificada dentro da transação:
revogar o **único** caminho para um owner (sem owner ativo e sem outro convite de owner pendente)
é recusado.

#### Membros

| método | rota | resposta |
|---|---|---|
| `GET` | `/api/platform/organizations/:organizationId/members` | `200 {itens:[Membro]}` |
| `DELETE` | `/api/platform/organizations/:organizationId/members/:userId` | `204` |

Remover o **último owner ativo** → `409 ultimo_owner`. Verificado na transação, com a contagem
lida sob o contexto da Organization.

### 10.7 Usuários (§17 `/users`)

```http
GET /api/platform/users?q=&status=&limit=&cursor=
```

```json
{ "itens": [{
    "id": "uuid", "email": "…", "nome": "…", "status": "active",
    "criadoEm": "…", "ultimoLoginEm": "…",
    "organizations": [{ "id": "uuid", "nome": "…", "papel": "owner" }]
  }], "proximoCursor": null }
```

Leitura pelo read model. Nunca `password_hash`. Não há criação de usuário por aqui: pessoa entra
por convite.

### 10.8 Onboardings (§20)

```http
GET /api/platform/onboardings?status=&limit=&cursor=
GET /api/platform/organizations/:organizationId/onboarding
```

```json
{ "itens": [{
    "organizationId": "uuid", "organizationNome": "…",
    "status": "blocked",
    "currentStep": "ink",
    "completedSteps": ["org_store", "owner"],
    "blockedStep": "ink",
    "lastErrorCode": "PROVIDER_AUTH_FAILED",
    "atualizadoEm": "…"
  }], "proximoCursor": null }
```

**Não existe rota para marcar passo como concluído à mão.** O estado é derivado dos requisitos
reais (integrações, store, owner, entitlements) — igual ao painel. O Admin **lê**; quem conclui é
o fato.

### 10.9 Integrações (§19)

```http
GET /api/platform/integrations?provider=&status=&limit=&cursor=
GET /api/platform/organizations/:organizationId/integrations
```

```json
{ "itens": [{
    "organizationId": "uuid", "organizationNome": "…",
    "provider": "ink", "status": "connected",
    "displayName": "Ink · loja principal",
    "lastTestEm": "…", "lastSuccessEm": "…",
    "lastErrorCode": null
  }], "proximoCursor": null }
```

`status`: `connected` \| `disconnected` \| `error`. `lastErrorCode` vem do vocabulário fechado
`PROVIDER_*`. **Nunca** token, secret, `config`, id de conta externa, nem mensagem de provider.

`POST /api/platform/organizations/:organizationId/integrations/:provider/test` fica **fora da
V1 desta noite** (exigiria chamar provider real com segredo de tenant). A ação `integration.tested`
já existe no vocabulário de auditoria para quando entrar. O frontend não deve renderizar o botão.

### 10.10 Jobs e webhooks (§21)

```http
GET /api/platform/jobs?organizationId=&limit=&cursor=
```

```json
{ "itens": [{ "job": "ink:sync", "organizationId": "uuid", "organizationNome": "…",
              "ocupado": true, "iniciadoEm": "…", "ate": "…", "proximaEm": "…" }],
  "proximoCursor": null }
```

```http
GET /api/platform/webhooks?organizationId=&verificado=&limit=&cursor=
```

```json
{ "itens": [{ "id": "123", "recebidoEm": "…", "verificado": true,
              "metodoAuth": "hmac", "eventName": "order.created",
              "organizationId": "uuid", "organizationNome": "…" }],
  "proximoCursor": null }
```

**Sem `headers`, sem `body`, sem payload cru.** Não há rota que os devolva.

### 10.11 Auditoria (§22)

```http
GET /api/platform/audit?organizationId=&action=&actorAdminId=&desde=&ate=&limit=&cursor=
```

```json
{ "itens": [{
    "id": "42", "criadoEm": "…",
    "actor": { "adminId": "uuid", "email": "…" },
    "action": "organization.suspended",
    "entityType": "organization", "entityId": "uuid",
    "organizationId": "uuid", "organizationNome": "…",
    "before": { "status": "active" },
    "after": { "status": "suspended", "motivo": "…" }
  }], "proximoCursor": "…" }
```

Ordem: `criado_em DESC, id DESC`. `action` inválida no filtro → `422 action_desconhecida`.

---

## 11. Mapa tela → rotas (para o frontend)

| tela | rotas |
|---|---|
| `/login` | `POST /auth/login` |
| `/dashboard` | `GET /overview` |
| `/organizations` | `GET /organizations`, `POST /organizations`, `GET /plans` |
| `/organizations/:id` | `GET /organizations/:id` + suspend/reactivate/subscription/entitlements/invites/members |
| `/users` | `GET /users` |
| `/onboardings` | `GET /onboardings` |
| `/plans` | `GET /plans`, `POST /plans`, `PUT /plans/:id/features`, `POST /plans/:id/archive` |
| `/subscriptions` | `GET /organizations` (traz plano) + `PUT /organizations/:id/subscription` |
| `/integrations` | `GET /integrations` |
| `/jobs` | `GET /jobs` |
| `/webhooks` | `GET /webhooks` |
| `/audit` | `GET /audit` |
| `/platform-admins` | `GET/POST /admins`, `POST /admins/:id/{deactivate,reactivate,role}` |

Regras para o frontend, derivadas deste contrato:

1. Chame `GET /auth/session` no boot. `401` → `/login`. Guarde o `csrfToken` **em memória**
   (não em `localStorage`) e mande-o em `X-CSRF-Token` em toda mutação.
2. `401` em qualquer resposta → volte para `/login` e limpe o estado. Não tente renovar sozinho.
3. Nunca envie `organization_id` no corpo. O alvo vai **na URL**.
4. Exiba `invite.token` uma vez, com aviso. Não o persista.
5. Não invente dado: quando um campo vem `null`, mostre estado vazio honesto, não placeholder
   fabricado.
6. Não renderize ação de impersonation. Ela não existe e não vai existir na V1.

---

## 12. Fluxo de amanhã (Use Origens como Tenant #1)

```text
1. abrir o Oria Admin
2. npm run platform-admin:bootstrap  (com e-mail e senha do usuário)  →  login
3. /organizations → "Criar Organization"
     nome: Use Origens · store: Use Origens · plano: Internal
     owner email: <informado pelo usuário> · idempotencyKey: <gerada pela UI>
     bootstrapInterno: true            ← só funciona porque ainda não há nenhuma Organization
4. a resposta traz o token do convite → copiar e entregar ao owner
5. o owner aceita o convite no Oria Panel e define a senha
6. /organizations/:id acompanha o onboarding passo a passo
```

Nada disso é feito automaticamente. **O backend não cria a Use Origens** — nem dados de exemplo.

---

## 13. Limites declarados desta V1

Fora do escopo, por decisão explícita:

- **Impersonation** (§37) — não existe.
- **Pricing/billing** (§36) — `plans` é vocabulário técnico de acesso, não catálogo comercial.
  Não há preço, trial, cupom, fatura nem cadência.
- **Teste de integração disparado pelo Admin** — a rota não entra nesta noite (§10.9).
- **Role dedicada do control plane no Postgres** — passo posterior (§2).
- **Rate limit distribuído** — em memória, processo único, como no painel.
