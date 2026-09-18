# Execução noturna — Oria Admin pronto para cadastrar a Use Origens amanhã

Objetivo principal:

```text
amanhã o usuário deve conseguir abrir o Oria Admin
e iniciar o cadastro da Use Origens como Tenant #1
```

Não espere confirmação para decisões técnicas pequenas e reversíveis.

Só interrompa por uma condição de STOP explícita deste documento.

---

# 1. Trabalhar isolado

Repo principal:

```text
/Users/gtomazi/projects/oria
```

Criar worktree:

```bash
cd /Users/gtomazi/projects/oria
git worktree add ../oria-platform-admin -b feature/platform-admin main
cd ../oria-platform-admin
```

Se já existir, reutilizar apenas se estiver consistente.

NÃO editar a working tree principal enquanto os outros testes/services estiverem em andamento.

---

# 2. Meta da noite

Entregar:

```text
apps/platform-admin
```

com:

```text
- backend próprio;
- frontend próprio;
- auth de Platform Admin;
- sessão + CSRF;
- plans;
- plan_features;
- subscriptions;
- entitlement overrides;
- Organizations;
- Store 1:1;
- owner invite;
- suspend/reactivate;
- onboarding status;
- integration status;
- jobs/webhooks status;
- platform audit;
- healthcheck;
- testes;
- build;
- CI;
- Railway config;
```

E deixar o fluxo funcional:

```text
Oria Admin
→ Create Organization
→ Organization "Use Origens"
→ Store "Use Origens"
→ escolher plano
→ owner email
→ convite
→ onboarding
```

Não criar a Use Origens automaticamente.

O usuário quer fazer isso amanhã pela interface.

---

# 3. Pré-condição de deploy

Pode construir tudo em paralelo agora.

Deploy do `oria-admin` só pode acontecer se, no Railway:

```text
oria-panel      = healthy
oria-creatives  = healthy
oria-whatsapp   = healthy
```

Se algum deles ainda não estiver estável:

```text
concluir código + testes + CI + config
mas NÃO criar/deployar oria-admin
```

Registrar o bloqueio e continuar todo o restante.

---

# 4. Regras

Permitido durante a noite:

```text
- commits em feature/platform-admin;
- testes direcionados;
- migrations locais;
- CI config;
- docs;
- Railway service config;
- merge para main SE tudo estiver verde;
- push SE tudo estiver verde e não houver conflito com main;
- criar/deployar oria-admin SE os 3 services base estiverem healthy.
```

Proibido:

```text
- tocar produção legada;
- apagar/alterar Railway antigo;
- banco de produção legado;
- criar tenant externo real;
- criar Use Origens automaticamente;
- BYPASSRLS;
- SUPERUSER;
- impersonation;
- secrets reais em código/log;
- pricing/billing definitivo.
```

---

# 5. Arquitetura

```text
Oria Admin = Control Plane
Oria Panel = Tenant Plane
```

Novo app:

```text
apps/platform-admin
```

Futuro/novo service:

```text
oria-admin
```

Usar o mesmo PostgreSQL principal do painel.

Não criar terceiro DB.

---

# 6. Segurança obrigatória

NÃO implementar:

```text
isSuperAdmin bypass
BYPASSRLS
disable RLS
runtime table owner
raw global query sobre tenant tables
```

Operações tenant-owned:

```text
Platform Admin autenticado
→ target Organization explícita
→ comOrganization(...)
→ operação
→ audit
```

Listagens globais devem usar platform tables/read models seguros.

---

# 7. Auth própria do Platform Admin

Criar:

```text
platform_admins
platform_admin_sessions
```

ou equivalente.

Requisitos:

```text
email/password
hash seguro
opaque session
session hash no DB
expiry
revocation
HttpOnly
Secure production
SameSite Strict
CSRF
rate limit
timing-safe compare
fixation protection
```

Cookie separado do painel do cliente.

Secret próprio:

```text
PLATFORM_ADMIN_SESSION_SECRET
```

>= 32 chars em produção.

---

# 8. Bootstrap do primeiro Platform Admin

Criar:

```text
npm run platform-admin:bootstrap
```

Inputs:

```text
PLATFORM_ADMIN_EMAIL
PLATFORM_ADMIN_PASSWORD
```

Idempotente e sem imprimir senha.

Se for feito deploy noturno do Admin, preparar o bootstrap mas NÃO inventar email/senha.

Sem valores explícitos:

```text
service pode subir
mas login inicial aguarda envs/bootstrap
```

Se o runtime exigir bootstrap para subir, ajustar para:

```text
app sobe
login indisponível até primeiro admin existir
```

Não usar senha default.

---

# 9. Roles

V1:

```text
platform_owner
platform_operator
```

Se complicar sem benefício:

```text
platform_owner
```

é suficiente.

Nunca hardcodar email.

Não permitir remover/desativar o último platform_owner.

---

# 10. Plans / entitlements

Criar/reutilizar:

```text
plans
plan_features
organization_subscriptions
organization_entitlement_overrides
```

Feature keys vêm do registry canônico.

Unknown feature:

```text
reject
```

Resolver central:

```text
effective access =
organization active
AND subscription active
AND (
  explicit override
  OR plan feature
)
```

Precedência:

```text
organization override
>
plan
>
false
```

---

# 11. Plano inicial para Tenant #1

Para permitir cadastro da Use Origens amanhã, criar um plano técnico inicial:

```text
internal
```

Somente se isso simplificar o fluxo.

Regras:

```text
- é apenas dado;
- não bypassa nada;
- features são explícitas;
- não implica allow-all.
```

Features iniciais devem refletir o profile atual já definido para Tenant #1:

```text
catalog
creative_clean_angles
creative_funnel_visual
creative_generator
creative_multi_product
creative_remarketing
exchanges
financial
refunds
whatsapp
```

Não incluir automaticamente:

```text
instagram
advancedAutomations
```

Se o registry atual divergir, usar o registry real e documentar.

---

# 12. Organization create flow

Tela/ação deve permitir amanhã:

```text
Name: Use Origens
Store: Use Origens
Plan: Internal
Owner email: [usuário informa]
```

Backend:

```text
createOrganizationWithStore(...)
```

transacional.

Resultado:

```text
Organization
Store 1:1
subscription
effective entitlements
owner invite
onboarding state
audit
```

---

# 13. SECOND_TENANT_ENABLED

Use Origens é Tenant #1 interno.

Não tratar sua criação como segundo tenant externo.

O gate:

```text
SECOND_TENANT_ENABLED=false
```

deve continuar impedindo criação de clientes externos posteriores.

Implementar distinção segura e explícita.

Não usar:

```text
if organizationName == "Use Origens"
```

como bypass.

Preferir flag/flow de bootstrap interno permitido apenas quando ainda não existe Tenant #1.

Depois de criado o Tenant #1:

```text
bootstrap interno não pode ser reutilizado.
```

---

# 14. Suspensão

Organization suspended:

```text
tenant login/actions deny
jobs deny
new sends deny
creative generation deny
new provider actions deny
```

Dados permanecem.

Admin continua vendo.

Webhooks podem ser autenticados/persistidos, mas não produzir efeitos tenant-owned.

---

# 15. Owner invite

Admin informa email.

Sistema gera token opaco.

Não cria senha.

Ações:

```text
invite
reissue
revoke
```

Não deixar Organization sem owner ativo.

---

# 16. Frontend

Direção:

```text
dark
premium SaaS
compacto
alto contraste
densidade útil
```

Menu:

```text
VISÃO GERAL

CLIENTES
  Organizations
  Usuários
  Onboardings

PLANOS
  Planos
  Assinaturas

INTEGRAÇÕES
  Status

OPERAÇÃO
  Jobs
  Webhooks

PLATAFORMA
  Auditoria
  Administradores
```

---

# 17. Telas mínimas

```text
/login
/dashboard
/organizations
/organizations/:id
/users
/onboardings
/plans
/subscriptions
/integrations
/jobs
/webhooks
/audit
/platform-admins
```

Não inventar dados quando backend não tiver fonte factual.

---

# 18. Organization detail

Mostrar:

```text
name
status
Store
owner
plan
effective features
overrides
onboarding
integration status
created_at
```

Ações:

```text
change plan
feature override
invite owner/member
suspend
reactivate
audit
```

Sem impersonation.

---

# 19. Integrações

Mostrar apenas:

```text
provider
connected/disconnected/error
display name seguro
last test
last success
error code sanitizado
```

Nunca tokens/secrets.

---

# 20. Onboarding

Mostrar:

```text
Organization
status
current step
completed steps
blocked step
last error code
updated_at
```

Não marcar completo manualmente se requirements reais não passarem.

---

# 21. Jobs / webhooks

Mostrar dados sanitizados:

```text
type
Organization
status
attempts
last_error_code
timestamps
```

Sem raw payload PII por default.

---

# 22. Platform audit

Criar:

```text
platform_audit_logs
```

Auditar:

```text
login/logout
create organization
change plan
override entitlement
suspend/reactivate
invite/revoke invite
admin create/deactivate
integration test
```

Sem secrets.

---

# 23. API

Separar:

```text
/api/platform/*
```

do tenant:

```text
/api/admin/*
```

Não misturar auth/cookies.

---

# 24. Health

Criar:

```text
GET /health
→ {"status":"ok"}
```

Sem dados sensíveis.

---

# 25. Boot fail-fast

Produção:

```text
DB ausente
PLATFORM_ADMIN_SESSION_SECRET ausente/inválido
critical config ausente
→ não sobe
```

Não exigir primeiro admin existente para o processo iniciar.

---

# 26. Railway service

Atualizar manifest:

```text
oria-admin
Root Directory: /apps/platform-admin
Public: yes
DB: panel postgres
Volume: no
Health: /health
```

Build/start reais derivados da implementação.

---

# 27. CI

Adicionar job:

```text
platform-admin
```

Rodar:

```text
install
tests
build
```

Atualizar root gate/self-check.

---

# 28. Tests obrigatórios

Auth:

```text
tenant user != platform admin
revoked session deny
expired deny
CSRF missing deny
```

Tenant safety:

```text
target A + forged B in body
→ B nunca vira authority
```

Plans:

```text
unknown feature reject
two active subscriptions reject
plan change updates access
override > plan
remove override → inherit
no plan → deny
```

Suspension:

```text
A suspended
B normal
```

Audit:

```text
plan change sem audit → teste falha
suspension sem audit → teste falha
```

Owners:

```text
last platform_owner cannot be removed
last tenant owner cannot be removed
```

---

# 29. Negative controls

Provar que a suíte reprova ao reintroduzir:

```text
BYPASSRLS
SUPERUSER
tenant user as platform admin
plan mutation without audit
suspended org still allowed
body org overriding route target
secret response
last owner removal
```

---

# 30. Validação incremental

Durante o desenvolvimento:

```text
testes direcionados
```

Não rodar Go/Creative suites completas se não alterar esses componentes.

Antes de merge/push:

```text
platform-admin tests
platform-admin build
panel targeted regression
repo:self-check
contract checks
```

Se runtime compartilhado do painel for alterado:

```text
rodar full panel suite
```

Se não:

```text
deixar full root suite para CI
```

---

# 31. Merge noturno

Se:

```text
- branch limpa;
- Platform Admin tests PASS;
- build PASS;
- targeted regressions PASS;
- self-check PASS;
- migrations testadas em Postgres descartável;
```

então pode integrar para `main` localmente.

Antes:

```bash
git status
git diff main...feature/platform-admin
```

Não sobrescrever commits concorrentes.

Merge normal, sem reset/rebase destrutivo.

---

# 32. Push

Se merge para main ficar limpo:

```text
pode fazer push para origin/main
```

somente se a autenticação Git já estiver funcionando e não exigir segredo do usuário.

Não embutir token no remote/log.

Se push falhar por autenticação:

```text
não insistir
não alterar credenciais
registrar blocker
```

---

# 33. CI

Depois do push:

```text
aguardar CI
```

Se falhar:

```text
corrigir causa real
commit
push
aguardar novamente
```

Não criar Railway Admin até CI verde.

---

# 34. Deploy noturno do oria-admin

SOMENTE se:

```text
oria-panel = healthy
oria-creatives = healthy
oria-whatsapp = healthy
main CI = green
```

Pode criar:

```text
oria-admin
```

no projeto Railway Oria.

Configurar:

```text
Root Directory
Build
Start
Health
DB reference
PLATFORM_ADMIN_SESSION_SECRET
```

Não gerar/definir:

```text
PLATFORM_ADMIN_EMAIL
PLATFORM_ADMIN_PASSWORD
```

sem dados fornecidos pelo usuário.

Pode gerar `PLATFORM_ADMIN_SESSION_SECRET` forte, pois é novo e específico do Admin.

Nunca mostrar seu valor no relatório.

---

# 35. Não criar Use Origens de madrugada

Mesmo com Admin up:

```text
NÃO criar Organization Use Origens
NÃO criar Store Use Origens
NÃO importar dados
NÃO iniciar dogfood
```

Amanhã o usuário fará o primeiro cadastro pelo Admin.

---

# 36. Não decidir pricing

Fora da noite:

```text
Stripe
trial
free
pricing
billing cadence
coupons
invoices
quotas complexas
```

---

# 37. Não implementar impersonation

Fora da V1.

---

# 38. Docs

Criar/atualizar:

```text
docs/architecture/control-plane.md
docs/operations/platform-admin-bootstrap.md
docs/productization/platform-admin-phase.md
README
infra/railway/services.md
infra/railway/env-manifest.md
```

Documentar o fluxo de amanhã:

```text
1. acessar Oria Admin
2. bootstrap/login platform owner
3. criar Use Origens
4. criar Store
5. escolher Internal
6. informar owner
7. gerar convite
8. iniciar onboarding
```

---

# 39. STOP CONDITIONS

Só pare e aguarde se encontrar:

```text
1. necessidade de tocar produção legada;
2. necessidade de segredo real existente do usuário;
3. necessidade de decidir pricing/billing;
4. necessidade de BYPASSRLS/superuser;
5. alteração destrutiva irreversível;
6. conflito real com main que não possa ser resolvido sem escolher entre trabalhos concorrentes;
7. necessidade de criar a Use Origens automaticamente;
8. necessidade de criar tenant externo real;
9. CI revela regressão arquitetural cross-tenant;
10. Railway base services não estão healthy — nesse caso só bloqueia DEPLOY, não desenvolvimento.
```

Qualquer outra questão pequena:

```text
decida pela opção mais conservadora,
registre,
continue.
```

---

# 40. Relatório da manhã

Criar:

```text
docs/productization/platform-admin-overnight-report.md
```

E retornar:

```text
1. Oria Admin READY / PARTIAL / BLOCKED
2. branch/HEAD
3. merge para main
4. push status
5. CI status
6. Railway deploy status
7. URL/health status se deployado
8. auth Platform Admin
9. bootstrap
10. migrations
11. plans
12. internal plan
13. entitlements
14. Organization create
15. Store 1:1
16. owner invite
17. SECOND_TENANT gate
18. suspension/reactivation
19. integrations
20. onboarding
21. jobs/webhooks
22. audit
23. frontend routes
24. tests
25. negative controls
26. build
27. repo:self-check
28. panel regressions
29. commits
30. blockers
31. o que o usuário precisa fazer amanhã
32. GO / NO-GO para cadastrar Use Origens manualmente
```

---

# Resultado desejado amanhã

Ideal:

```text
ORIA ADMIN = DEPLOYED + HEALTHY
PLATFORM ADMIN LOGIN = pronto para bootstrap
USE ORIGENS CREATE FLOW = pronto
INTERNAL PLAN = pronto
OWNER INVITE = pronto
TENANT #1 = ainda não criado
```

Se deploy estiver bloqueado:

```text
ORIA ADMIN CODE = READY
CI = GREEN
RAILWAY CONFIG = READY
DEPLOY = BLOCKED por motivo objetivo
```

Em ambos os casos, deixar o máximo pronto sem violar as STOP CONDITIONS.
