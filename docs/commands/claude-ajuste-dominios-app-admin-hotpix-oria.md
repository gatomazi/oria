# Ajuste de arquitetura web — `oria.com.br`, `app.oria.com.br` e `admin.oria.com.br`

## Contexto

A arquitetura pública do Oria foi definida assim:

```text
https://oria.com.br
→ landing page pública já existente

https://oria.com.br/hotpix/{id}
→ HotPix público já existente/em ajuste

https://app.oria.com.br
→ painel SaaS dos clientes / Tenant Plane

https://admin.oria.com.br
→ Oria Admin / Control Plane
```

A landing page **já existe**.

O HotPix **já existe e está sendo/foi solicitado para ajuste em outra frente**.

Portanto esta tarefa NÃO deve reconstruir:

```text
landing
HotPix
```

O objetivo é alinhar código, autenticação, URLs geradas, cookies, callbacks, configuração e documentação à convenção definitiva de hosts.

---

# 1. Convenção definitiva

Registrar como decisão arquitetural:

```text
PUBLIC WEB
oria.com.br

TENANT APP
app.oria.com.br

PLATFORM ADMIN
admin.oria.com.br
```

Não usar:

```text
oria.com.br/admin
```

como painel principal do cliente.

Não usar:

```text
oria.com.br/app
```

como origem canônica do painel.

Os subdomínios são as URLs canônicas.

---

# 2. Responsabilidades

## `oria.com.br`

Responsável por:

```text
landing pública
HotPix público
outras páginas públicas futuras
```

Não é Tenant Plane.

Não é Control Plane.

---

## `app.oria.com.br`

Responsável por:

```text
login do cliente
painel do cliente
Organization ativa
onboarding
integrações
financeiro
criativos
WhatsApp
demais módulos tenant-owned
```

É o:

```text
Tenant Plane
```

---

## `admin.oria.com.br`

Responsável por:

```text
Oria Admin
Organizations
plans
subscriptions
entitlements
platform admins
auditoria
operação da plataforma
```

É o:

```text
Control Plane
```

---

# 3. Não compartilhar sessões entre hosts

REGRA OBRIGATÓRIA:

```text
app.oria.com.br
```

e:

```text
admin.oria.com.br
```

não compartilham sessão.

Não configurar:

```text
Domain=.oria.com.br
```

nos cookies de autenticação.

Usar cookies host-only.

---

# 4. Cookies

## Tenant Panel

Preferência:

```text
__Host-oria_session
```

ou nome equivalente claramente tenant.

Requisitos em produção:

```text
Secure
HttpOnly
Path=/
SEM Domain
```

Preservar o comportamento SameSite atualmente validado pelo projeto, especialmente em relação aos callbacks OAuth.

NÃO alterar SameSite mecanicamente nesta rodada sem provar os fluxos Meta/Google reais ou os testes correspondentes.

---

## Platform Admin

Cookie separado:

```text
__Host-oria_platform_session
```

ou equivalente.

Requisitos:

```text
Secure
HttpOnly
Path=/
SEM Domain
```

Nunca reutilizar o cookie do Tenant Panel.

---

# 5. Landing não recebe auth cookie

Ao acessar:

```text
oria.com.br
```

o browser não deve enviar os cookies host-only de:

```text
app.oria.com.br
admin.oria.com.br
```

Esse isolamento é desejado.

Adicionar teste/config check quando tecnicamente possível.

---

# 6. Variáveis canônicas

Criar/confirmar nomes de configuração explícitos.

Preferência:

```text
PUBLIC_SITE_URL=https://oria.com.br
APP_URL=https://app.oria.com.br
PLATFORM_ADMIN_URL=https://admin.oria.com.br
```

Se já houver nomes equivalentes no código:

```text
não criar aliases desnecessários;
escolher uma convenção canônica
e migrar as referências.
```

Em produção:

```text
valores ausentes/inválidos
→ fail-fast onde forem críticos
```

Não usar localhost como fallback silencioso em produção.

---

# 7. URL parser/validator central

Evitar espalhar:

```text
process.env.APP_URL
```

com concatenação arbitrária.

Criar/reusar helper central para:

```text
publicSiteUrl
appUrl
platformAdminUrl
```

Validar:

```text
https em produção
URL válida
sem path inesperado
sem credentials embutidas
```

---

# 8. Links públicos do HotPix

Todo link HotPix gerado pelo sistema deve usar:

```text
PUBLIC_SITE_URL
```

Resultado:

```text
https://oria.com.br/hotpix/{id}
```

NUNCA:

```text
https://app.oria.com.br/hotpix/{id}
https://admin.oria.com.br/hotpix/{id}
```

Não reconstruir a implementação HotPix.

Somente localizar:

```text
geradores de link
redirects
templates
mensagens
copies
```

e garantir que usam a origem pública canônica.

---

# 9. HotPix continua público

`/hotpix/{id}` não depende de:

```text
tenant session cookie
platform admin cookie
```

A autorização pública continua pelo mecanismo já definido na implementação HotPix.

Não enfraquecer o identificador/segurança existente.

Não mover a rota para o painel autenticado.

---

# 10. Convites de usuários

Links de convite para owner/member da Organization devem apontar para:

```text
APP_URL
```

Exemplo conceitual:

```text
https://app.oria.com.br/invite/{token}
```

Usar a rota REAL implementada; não criar `/invite` se o projeto já utiliza outro path.

O ponto obrigatório é:

```text
host = APP_URL
```

---

# 11. Login/reset/onboarding tenant

Todos os links tenant-facing devem usar:

```text
APP_URL
```

Incluindo, se existirem:

```text
login
password setup/reset
invite acceptance
onboarding
integration completion redirects
```

Não gerar links tenant para `oria.com.br`.

---

# 12. Platform Admin links

Links específicos do Control Plane devem usar:

```text
PLATFORM_ADMIN_URL
```

Incluindo, se existirem:

```text
login
platform admin invite
bootstrap completion
password flows
```

Não misturar com APP_URL.

---

# 13. OAuth Meta / Google / GA4

Auditar os fluxos OAuth atuais.

Callbacks do Tenant Plane devem apontar para:

```text
app.oria.com.br
```

e não para:

```text
oria.com.br
admin.oria.com.br
Railway-generated URL
```

em produção.

NÃO inventar paths novos.

Derivar dos endpoints atuais.

Exemplo conceitual:

```text
APP_URL + callbackPathAtual
```

---

# 14. OAuth state/session

A arquitetura atual liga OAuth state a:

```text
user
session
Organization
provider
```

Preservar.

Ao ajustar host/cookie:

```text
não quebrar revalidação da sessão no callback.
```

Criar/atualizar testes específicos para:

```text
Meta callback
Google callback
workspace changed midflow
forged organization ignored
```

Não alterar SameSite sem necessidade comprovada.

---

# 15. Meta/Google Redirect URI documentation

Atualizar docs/runbook para deixar explícito quais redirect URIs precisam ser cadastradas nos providers quando o domínio real for ativado.

Nunca incluir secret.

Registrar apenas URLs.

---

# 16. Ink webhook

Se o webhook da Ink permanece no backend do painel:

```text
host público de webhook = app.oria.com.br
```

ou o host factual definido pelo serviço que realmente atende a rota.

Não movê-lo para:

```text
oria.com.br
```

só porque HotPix/landing vivem ali.

Derivar da arquitetura/runtime real.

Atualizar URL generator/runbook se necessário.

---

# 17. WhatsApp webhook

Não alterar o host do WhatsApp Service nesta rodada, salvo documentação.

Ele continua no:

```text
oria-whatsapp
```

com domínio público próprio/Railway custom domain quando definido.

Não tentar colocá-lo em:

```text
app.oria.com.br
```

ou:

```text
admin.oria.com.br
```

---

# 18. API do Tenant Panel

Preferir same-origin:

```text
https://app.oria.com.br/api/...
```

Frontend do Tenant Panel:

```text
app.oria.com.br
```

Backend/API:

```text
mesmo origin
```

Não criar `api.oria.com.br` nesta rodada.

Isso preserva:

```text
cookies
CSRF
sem CORS adicional
```

---

# 19. API do Platform Admin

Preferir same-origin:

```text
https://admin.oria.com.br/api/platform/...
```

Frontend e backend do Control Plane no mesmo origin.

Não fazer browser chamar:

```text
app.oria.com.br/api/platform
```

com service key.

---

# 20. CORS

Alvo:

```text
Tenant Panel → same-origin
Platform Admin → same-origin
Landing/HotPix → implementação pública existente
```

Não adicionar:

```text
Access-Control-Allow-Origin: *
```

Se algum fluxo público factual exige cross-origin:

```text
whitelist explícita por PUBLIC_SITE_URL
```

e apenas endpoints públicos necessários.

---

# 21. CSRF / Origin validation

Tenant mutations devem aceitar somente origins legítimas do Tenant Plane.

Canonical:

```text
APP_URL
```

Platform Admin mutations:

```text
PLATFORM_ADMIN_URL
```

Não considerar:

```text
PUBLIC_SITE_URL
```

origem autorizada para mutações tenant/platform apenas por compartilhar domínio-base.

---

# 22. Host header não é autoridade de tenant

Não usar:

```text
Host: app.oria.com.br
```

para escolher Organization.

Tenancy continua:

```text
server-side session
→ active Organization
```

Os subdomínios separam aplicações, não tenants.

---

# 23. Redirect pós-login

Tenant:

```text
→ APP_URL
```

Platform:

```text
→ PLATFORM_ADMIN_URL
```

Não aceitar `redirect=` arbitrário para domínio externo.

Se existir returnUrl:

```text
permitir somente path relativo
ou origins explicitamente allowlisted.
```

Prevenir open redirect.

---

# 24. Logout

Logout do Tenant Panel encerra apenas:

```text
tenant session
```

Logout do Oria Admin encerra apenas:

```text
platform session
```

Não tentar apagar cookie de outro host.

---

# 25. Landing existente

NÃO reescrever.

NÃO migrar design.

NÃO recriar.

Somente verificar se existem CTAs como:

```text
Entrar
Acessar painel
Começar
```

e alinhar links:

```text
Entrar/Acessar painel
→ APP_URL
```

Se houver link administrativo interno:

```text
→ PLATFORM_ADMIN_URL
```

Não adicionar link público para Control Plane sem necessidade.

---

# 26. HotPix existente

A outra frente já está alterando/alterou HotPix.

Não sobrescrever esse trabalho.

Antes de tocar arquivos relacionados:

```text
git status
git log
diffs
```

Se houver trabalho concorrente:

```text
esperar/consolidar primeiro.
```

Nesta rodada, apenas ajustar:

```text
base URL
canonical host
links gerados
tests de host
```

quando necessário.

---

# 27. `/admin` legado

A URL canônica do tenant agora é:

```text
https://app.oria.com.br/
```

A URL canônica do Control Plane:

```text
https://admin.oria.com.br/
```

Não usar `/admin` como tenant app.

Se já existir compatibilidade histórica com:

```text
/admin
```

não remover cegamente.

Escolher uma destas estratégias conforme estado real:

```text
A. se não há usuários/links reais: remover;
B. se há links existentes: redirect temporário para APP_URL;
```

Não redirecionar o antigo tenant `/admin` para o Control Plane.

Isso poderia levar usuário de tenant à tela administrativa errada.

---

# 28. Alias opcional `/app`

Não é necessário.

Canonical:

```text
app.oria.com.br
```

Se a landing já possui `/app`, pode fazer redirect para APP_URL.

Não criar novo alias sem necessidade.

---

# 29. Canonical/SEO

Landing:

```text
canonical = https://oria.com.br
```

HotPix:

```text
seguir política já definida para index/noindex
```

Tenant Panel e Platform Admin:

```text
noindex
```

quando houver suporte simples.

Não gastar esta rodada com SEO complexo.

---

# 30. CSP / security headers

Se os apps já usam CSP/security headers, atualizar allowlists para os novos hosts.

Não abrir:

```text
*.oria.com.br
```

por conveniência se hosts explícitos bastarem.

---

# 31. Railway custom domains

Atualizar planejamento:

```text
oria-web / landing existente
→ oria.com.br

oria-panel
→ app.oria.com.br

oria-admin
→ admin.oria.com.br

oria-creatives
→ private only

oria-whatsapp
→ public webhook host separado
```

Não necessariamente executar DNS nesta tarefa sem autorização.

---

# 32. Env manifest

Atualizar:

```text
infra/railway/env-manifest.md
```

com:

```text
PUBLIC_SITE_URL
APP_URL
PLATFORM_ADMIN_URL
```

Classificar por service.

Não colocar valores secretos.

URLs públicas não são secrets.

---

# 33. `apps/panel`

Depois da refatoração estrutural já aprovada:

```text
apps/panel
```

é o Tenant Panel.

Garantir que nenhum texto/config ainda trate:

```text
/admin
```

como sua identidade estrutural apenas por herança do Orgulho Regional.

---

# 34. `apps/platform-admin`

Control Plane deve assumir:

```text
PLATFORM_ADMIN_URL
```

e cookie próprio.

Não importar configuração de tenant URL como sessão/autorização.

---

# 35. Tests obrigatórios — canonical URLs

Criar/atualizar testes:

```text
HotPix link → PUBLIC_SITE_URL
tenant invite → APP_URL
tenant login redirect → APP_URL
platform link → PLATFORM_ADMIN_URL
OAuth callback → APP_URL
```

Usar paths reais do código.

---

# 36. Tests obrigatórios — cookies

Provar:

```text
tenant cookie → sem Domain
platform cookie → sem Domain
nomes diferentes
Path=/
Secure production
HttpOnly
```

Negative control:

```text
Domain=.oria.com.br
→ teste falha
```

---

# 37. Tests obrigatórios — origin

Provar:

```text
tenant mutation from APP_URL → allowed
tenant mutation from PLATFORM_ADMIN_URL → denied

platform mutation from PLATFORM_ADMIN_URL → allowed
platform mutation from APP_URL → denied
```

Public Site não ganha poder administrativo.

---

# 38. Tests — open redirect

Se houver return URL:

```text
https://evil.example
//evil.example
javascript:
```

→ rejeitado.

Path local válido:

```text
/settings
```

→ permitido.

---

# 39. Não rodar suítes irrelevantes

Durante desenvolvimento:

```text
testes direcionados
```

Se alterar runtime/auth/cookies do painel:

```text
rodar suíte relevante do painel
```

Se alterar runtime do Platform Admin:

```text
rodar testes/build dele
```

Não repetir Go/Creative completos se não forem tocados.

CI pode executar a suíte integral depois.

---

# 40. Documentação

Criar/atualizar:

```text
docs/architecture/web-hosts.md
docs/architecture/control-plane.md
docs/operations/railway-bootstrap.md
infra/railway/services.md
infra/railway/env-manifest.md
README.md
```

Adicionar diagrama simples:

```text
oria.com.br
├── landing
└── /hotpix/{id}

app.oria.com.br
└── Tenant Plane

admin.oria.com.br
└── Control Plane
```

---

# 41. Não fazer

NÃO:

```text
reconstruir landing
reconstruir HotPix
mover HotPix para app
mover HotPix para admin
criar api.oria.com.br
compartilhar auth cookie
Domain=.oria.com.br
CORS wildcard
usar host para escolher Organization
alterar WhatsApp ingress
alterar billing/pricing
```

---

# 42. Checkpoint final

Retornar:

```text
1. convenção final de hosts
2. path real da landing existente
3. path real do HotPix existente
4. PUBLIC_SITE_URL
5. APP_URL
6. PLATFORM_ADMIN_URL
7. tenant cookie final
8. platform cookie final
9. Domain attribute status
10. SameSite status e justificativa
11. tenant redirects
12. platform redirects
13. HotPix URL generation
14. owner/member invite URLs
15. OAuth callback hosts
16. Ink webhook host
17. WhatsApp host impact
18. CORS
19. CSRF/origin validation
20. `/admin` legacy behavior
21. open redirect protection
22. Railway custom-domain plan
23. env manifest
24. tests executados
25. negative controls
26. docs atualizados
27. commits
28. blockers/riscos
29. GO / NO-GO para configurar os 3 domínios
```

---

# Estado esperado

```text
oria.com.br
= landing pública existente
+ HotPix existente

app.oria.com.br
= painel dos clientes
= Tenant Plane
= sessão própria

admin.oria.com.br
= Oria Admin
= Control Plane
= sessão própria

cookies
= host-only
= NÃO compartilhados

APIs autenticadas
= same-origin

HotPix
= PUBLIC_SITE_URL

OAuth tenant
= APP_URL

pricing/billing
= fora desta tarefa
