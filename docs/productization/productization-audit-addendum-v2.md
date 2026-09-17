# Oria — Addendum obrigatório da auditoria de productização (V2)

> **Status:** complementar e, em caso de conflito, prevalece sobre o documento original
> `Levantamento para transformar o Painel Admin em produto SaaS`.
>
> **Motivo:** este addendum alinha a auditoria ao estado real mais recente do painel,
> documentado no snapshot de 15/09/2026.
>
> **Regra:** continua sendo uma auditoria. Não iniciar a productização completa nesta etapa.

---

# 1. Escopo atual que a auditoria NÃO pode omitir

O inventário de produto precisa incluir explicitamente, além dos módulos históricos:

```text
Conexões / Integrações

Comunicação
- WhatsApp
- Recuperação
- PIX
- Automações
- Templates

Marketing & Dados
- Meta Ads
- Google Ads
- Analytics GA4
- UTM Tracker

Criativos
- Gerar
- Lotes
- Histórico
- Produtos
- Marca e nicho
- Contextos
- Personas

Campanhas
- Campanhas
- Segmentos

Operação
- Pedidos
- Clientes
- Trocas e devoluções
- Estoque
- Simular frete

Financeiro
- Financeiro Ink
- Despesas
- Custos de API
- Reembolsos
- Resultado/DRE consolidada

Catálogo
- Produtos
- Categorias
- Agrupamentos
- Promoções

Sistema
- Campos personalizados
- Webhooks e logs
- Configurações

Interno
- Migração Use Origens
```

O relatório não deve usar uma fotografia antiga do produto para definir tenancy,
ownership, planos ou integrações.

---

# 2. Nome e identidade do produto

O nome comercial futuro do SaaS é:

```text
Oria
```

Durante a auditoria, classificar ocorrências de nomes atuais como:

```text
INTERNAL_CODE_NAME
LEGACY_PRODUCT_NAME
CUSTOMER_VISIBLE_NAME
TENANT_BRAND
```

Levantar ocorrências relevantes de:

```text
admin
AdminShell
adminState
/api/admin
Orgulho Regional
Use Origens
Central operacional
```

Não executar rename massivo nesta etapa.

Objetivo:

- descobrir o que pode continuar interno;
- descobrir o que é customer-facing e precisará virar Oria;
- separar identidade da plataforma da identidade do tenant.

---

# 3. Use Origens será o Tenant / Organization #1

A direção arquitetural é:

```text
ORIA PLATFORM
    ↓
Organization
    ↓
Use Origens
    ├── Use Sul
    ├── Use Centro
    └── Use Norte
```

Nossa operação atual deve ser migrada para o MESMO modelo usado pelos futuros clientes.

É proibido planejar uma arquitetura baseada em exceções permanentes como:

```text
if (internalTenant)
if (useOrigens)
if (isOurStore)
```

Casos internos legítimos devem ser representados por:

- permissões de plataforma;
- feature flags internas;
- platform admin;
- configurações explícitas;

e não por bypass de tenancy.

---

# 4. Organization e Store: arquitetura ≠ pricing

A arquitetura deve suportar:

```text
Organization
    ├── Store
    ├── Store
    └── Store
```

mesmo que um plano comercial inicialmente limite:

```text
max_stores = 1
```

Não codificar a regra comercial "1 assinatura = 1 loja" como limitação estrutural do modelo.

A auditoria deve separar:

```text
CAPABILITY
o modelo suporta múltiplas stores

ENTITLEMENT
quantas stores o plano permite
```

---

# 5. P0 — Tenant context deve ser server-authoritative

Hoje existe estado de loja no frontend/localStorage.

Na arquitetura SaaS:

> seleção no frontend nunca pode ser uma fronteira de segurança.

Toda request tenant-scoped deve resolver no servidor:

```text
authenticated user
    ↓
organization membership
    ↓
organization_id
    ↓
store_id, quando aplicável
    ↓
authorization
    ↓
query
```

Auditar qualquer endpoint que aceite:

```text
store
loja
organization_id
store_id
tenant
```

diretamente do browser.

O servidor deve validar ownership/membership antes de usar esses valores.

Adicionar uma seção P0 específica:

```text
CLIENT-CONTROLLED TENANT CONTEXT RISKS
```

---

# 6. P0 — Entitlements devem falhar fechados

O painel atual possui comportamento permissivo quando o fetch de entitlements falha.

Isso é aceitável como conveniência interna, mas é perigoso em SaaS.

Direção:

```text
entitlement service disponível
    → usa permissões reais

entitlement service indisponível
    → não libera feature restrita por padrão
```

Auditar:

- frontend;
- backend;
- rotas;
- jobs;
- integrações;
- campanhas;
- criativos;
- financeiro.

Entitlement no frontend é UX.

A autorização efetiva deve existir no backend.

Adicionar ao checklist P0:

```text
[ ] Entitlements fail-closed em operações protegidas
```

---

# 7. P0 — Postgres deve ser a persistência SaaS autoritativa

O painel atual ainda possui fallback para JSON/arquivos quando `DATABASE_URL` não existe.

A auditoria deve avaliar explicitamente esta direção:

```text
DEV / TEST
JSON pode continuar, se útil

SAAS PRODUCTION
Postgres obrigatório
```

Não permitir em produção SaaS que estado tenant-critical dependa silenciosamente de:

```text
db/*.json
volume local
memória do processo
```

Classificar cada persistência atual:

```text
DATABASE_AUTHORITATIVE
CACHE
EPHEMERAL
LOCAL_DEV_ONLY
LEGACY_FALLBACK
FILE_STORAGE
```

Adicionar blocker P0 se produção puder iniciar sem persistência autoritativa adequada.

---

# 8. Inventário completo das rotas

O backend atual possui uma superfície grande de endpoints administrativos.

A auditoria deve produzir uma MATRIZ COMPLETA, não apenas exemplos:

| Método | Rota | Handler | Domínio | Auth atual | Organization scoped | Store scoped | Entitlement | Risco |
|---|---|---|---|---|---:|---:|---|---|

Cobrir:

- rotas em `server.js`;
- `routes/criativos.js`;
- webhooks;
- uploads/media;
- endpoints de sync;
- endpoints internos.

Objetivo:

```text
nenhum endpoint tenant-scoped fica fora da auditoria
```

Priorizar uma arquitetura futura de middleware:

```text
authenticateUser
resolveOrganization
verifyMembership
resolveStoreIfNeeded
checkEntitlement
handler
```

---

# 9. Integrações: separar credencial da plataforma e conexão do tenant

A auditoria deve distinguir explicitamente:

## Platform OAuth/App credentials

Exemplos conceituais:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET

META_APP_ID
META_APP_SECRET
```

São credenciais da PLATAFORMA Oria para operar OAuth/API.

## Tenant connection credentials

Exemplos:

```text
refresh token
access token
WABA / phone resources
GA4 property
Google Ads customer
Meta ad account
Reserva Ink token
OpenAI key BYOK
```

Pertencem à conexão do cliente.

Não misturar esses dois níveis em `app_config` ou `.env`.

Produzir tabela:

| Credential/Config | Platform | Organization | Store | Integration | Secret? |
|---|---:|---:|---:|---:|---:|

---

# 10. Meta Ads e Meta WhatsApp não são "a mesma integração"

Mesmo que possam compartilhar App/Business Manager, tratá-las como domínios distintos:

```text
Meta Ads
- ads_read / recursos de mídia
- ad accounts
- campaigns/adsets/ads
- insights
- creative performance

Meta WhatsApp
- WABA
- Phone Number ID
- templates
- messaging
- webhooks
```

A auditoria deve identificar:

- credenciais compartilhadas;
- credenciais diferentes;
- scopes diferentes;
- recursos diferentes;
- lifecycle diferente;
- webhooks diferentes;
- health checks diferentes.

Não criar uma entidade "Meta" monolítica sem justificar.

---

# 11. Marketing & Dados — ownership obrigatório

Auditar explicitamente ownership e mapping de:

```text
GA4 connection
GA4 property
Meta connection
Meta ad account
Google Ads connection
Google Ads customer
UTM campaign
UTM preset
performance caches
daily insights
```

Decisões necessárias:

```text
Um ad account pertence a uma Organization ou Store?
Pode alimentar múltiplas Stores?
Um GA4 property pode mapear várias Stores?
Um Google Ads customer pode dirigir tráfego para múltiplas Stores?
Como o MER escolhe a Store atribuída?
Como UTM resolve Store/Organization?
```

Criar decisões PD específicas quando o código não determinar a resposta.

---

# 12. DRE e Financeiro multi-tenant

O painel atual já consolida:

```text
receita
custo de produção
lucro do produto
mídia
lucro após mídia
despesas
lucro operacional
custos de API
reembolsos
```

Auditar ownership e escopo de cada fonte.

Responder:

```text
organization-scoped?
store-scoped?
provider-scoped?
período/timezone?
moeda?
```

Não deixar a DRE depender de atribuição implícita de conta de mídia.

Mapear explicitamente:

```text
Store ↔ Meta Ad Account
Store ↔ Google Ads Customer
Store ↔ GA4 Property
```

quando aplicável.

---

# 13. Clientes — identidade e deduplicação

Clientes precisam de decisão explícita de ownership.

Auditar:

```text
telefone
email
documento
customer_id externo
store
organization
pedidos
lucro
opt-in
histórico de campanhas
```

Responder:

```text
O mesmo telefone em duas Stores da mesma Organization é um cliente ou dois?
O mesmo telefone em duas Organizations jamais pode ser unido.
Qual identificador é canônico?
Como conflitos de nome/email são resolvidos?
```

Criar uma decisão de produto/técnica específica.

---

# 14. Creative Core / Gerador de Criativos é P0/P1 de productização

O Gerador já é um módulo importante e possui serviço Python próprio.

Auditar separadamente:

```text
routes/criativos.js
services/creative-core/
creative_settings
creative_brand_profiles
creative_niche_profiles
creative_context_profiles
creative_personas
creative_products
creative_assets
creative_jobs
creative_generations
```

## Ownership

Toda entidade precisa ter ownership claro:

```text
organization_id
store_id quando realmente fizer sentido
user_id / created_by quando necessário
```

## Service-to-service

Verificar como Node → creative-core transmite:

```text
organization
user
job
OpenAI credential
correlation/request id
```

Nenhum serviço interno deve aceitar tenant context sem validação na borda confiável.

## BYOK OpenAI

A chave OpenAI própria do cliente deve ser tratada como:

```text
INTEGRATION_SECRET
```

Auditar:

- criptografia;
- masking;
- substituição;
- teste;
- rotação;
- nunca devolver segredo;
- escopo organization/store;
- acesso pelo serviço Python;
- logs que possam vazar a chave.

## Custos

Toda geração deve poder ser atribuída a:

```text
organization
job
generation
provider/model
custo estimado/real
```

para permitir:

- custo interno;
- usage metering;
- quotas;
- futuro billing.

## Assets

Auditar isolamento de:

```text
creative assets
product photos
generated files
uploads
image cache
```

e estratégia para object storage.

---

# 15. Storage e uploads por tenant

O inventário atual usa diretórios/volume para alguns arquivos.

Auditar todos os caminhos e endpoints de:

```text
UPLOADS_DIR
IMG_CACHE_DIR
STORAGE_DIR
media_assets
creative_assets
product photos
generated creatives
```

Para cada item:

```text
owner
path/key
public/private
retention
quota
signed URL?
cleanup
backup
CDN
```

P0:

> nenhum tenant deve conseguir descobrir, listar ou acessar arquivo de outro tenant por caminho previsível.

---

# 16. Jobs — adicionar matriz tenant-aware real

Cobrir explicitamente os jobs existentes e os novos domínios:

```text
campanhas
bulk categories
follow-up carrinho
follow-up PIX
sync de pedidos
sync de catálogo
feed de produtos
Meta Ads incremental
Meta Ads diário
token Meta
Google Ads
creative jobs
backfill
```

Google Ads atualmente não deve ser ignorado só porque não possui scheduler efetivo.

Para cada job registrar:

| Job | Tenant discovery | Store discovery | Credential source | Lock | Idempotência | Retry | Rate limit | Escala |
|---|---|---|---|---|---|---|---|---|

Adicionar análise de:

```text
fairness entre tenants
per-tenant rate limit
provider quota
noisy neighbor
```

Um tenant não pode consumir toda a cota/throughput e bloquear os demais.

---

# 17. Rate limits de providers

O painel atual já apresenta operações sensíveis a rate limit.

Productização deve considerar:

```text
Reserva Ink
Meta
Google
OpenAI
```

Auditar:

- retry;
- backoff;
- jitter;
- cache;
- concurrency;
- per-tenant limit;
- global provider limit;
- circuit breaker quando útil.

Não implementar arquitetura complexa sem necessidade.

Mas documentar o risco de noisy neighbor.

---

# 18. Webhooks — ownership e idempotência

Além do routing por tenant, criar matriz:

| Provider | Endpoint atual | Tenant locator | Signature | Idempotency key | Replay protection | Retry behavior |
|---|---|---|---|---|---|---|

Garantir que:

```text
evento de Tenant A
```

nunca possa:

```text
usar integração de B
criar pedido em B
atualizar campanha de B
disparar mensagem de B
```

---

# 19. Platform Admin vs Tenant App vs Internal Tools

Separar conceitualmente:

```text
ORIA TENANT APP
uso do cliente

ORIA PLATFORM ADMIN
uso nosso para suporte/operação SaaS

INTERNAL TOOLS
ferramentas especiais/migração
```

A ferramenta de Migração Use Origens não deve virar feature comum do tenant por acidente.

Auditar:

- rotas;
- flags;
- autenticação;
- autorização;
- visibilidade.

Não renomear rotas nesta fase.

---

# 20. Testes — elevar prioridade

O frontend atual não possui suíte completa.

Antes de cliente externo, obrigatórios ao menos testes automatizados para:

```text
auth
tenant isolation
organization/store resolution
entitlements
integration secrets
webhook routing
jobs tenant-aware
campaign ownership
creative ownership
media ownership
```

Criar matriz de testes P0/P1.

Incluir cenário:

```text
Org A / Store A1
Org A / Store A2
Org B / Store B1
```

e validar leitura/escrita/segredos/jobs/webhooks entre combinações.

---

# 21. Observabilidade com contexto de tenant

Logs e traces devem carregar, quando aplicável:

```text
request_id
organization_id
store_id
integration_id
user_id
job_id
provider
```

Mas:

- evitar PII desnecessária;
- nunca logar tokens;
- nunca logar payloads sensíveis sem redaction;
- propagar correlation ID ao creative-core.

---

# 22. Navegação e refino visual ficam depois da fundação SaaS

Não executar agora a grande rodada de:

```text
Sidebar 2.0
PageHeader v2
Tabs v2
refino de surfaces
reorganização visual ampla
```

A auditoria pode registrar impactos futuros de:

```text
Organization
Store selector
Onboarding
Entitlements
Platform Admin
Integrations
```

mas a implementação visual deve aguardar a fundação de productização.

---

# 23. Providers futuros: não contaminar o MVP

O documento original usa Mailchimp e outros providers como exemplos conceituais.

Regra desta auditoria:

```text
providers que existem hoje
→ auditar profundamente

providers anunciados/planejados
→ considerar em extensibilidade

providers apenas hipotéticos
→ não criar trabalho de MVP por causa deles
```

Mailchimp, por exemplo, não deve gerar schema/UI/fluxo no MVP apenas porque apareceu como exemplo.

Instagram deve ser classificado conforme seu estado real atual.

---

# 24. Nova lista P0 antes de cliente externo

Além do checklist original, acrescentar:

```text
[ ] tenant context server-authoritative
[ ] frontend/localStorage não é fronteira de segurança
[ ] entitlements fail-closed no backend
[ ] Postgres obrigatório em produção SaaS
[ ] rotas tenant-scoped inventariadas 100%
[ ] Meta Ads e WhatsApp separados corretamente
[ ] GA4/Meta/Google Ads mapeados a Organization/Store
[ ] creative-core tenant-aware
[ ] BYOK OpenAI tenant-scoped e protegido
[ ] creative/media assets isolados
[ ] API costs atribuídos por Organization
[ ] DRE/Financeiro tenant-scoped
[ ] customer identity/dedup definido
[ ] internal tools isoladas da tenant app
[ ] testes automatizados de tenant isolation
[ ] provider rate limiting/noisy-neighbor analisado
```

---

# 25. Saída adicional obrigatória

Além de:

```text
docs/productization-audit.md
docs/productization-decisions.md
```

a auditoria deve produzir dentro do primeiro documento:

## Tenant Surface Matrix

Tabela consolidando:

```text
routes
tables
jobs
webhooks
integrations
uploads
services
```

com ownership e risco.

## P0 Data Leak Review

Lista explícita de qualquer caminho que possa causar:

```text
cross-tenant read
cross-tenant write
cross-tenant credential use
cross-tenant webhook routing
cross-tenant job execution
cross-tenant asset access
```

## Current-to-Target Map

Para cada grande subsistema:

```text
Current
Target
Migration dependency
Risk
```

---

# 26. Regra final

Não considerar a auditoria concluída apenas porque:

```text
users
organizations
stores
integrations
```

foram propostos.

Ela só termina quando o relatório explicar, com base no código real:

```text
como os dados são isolados
como as credenciais são resolvidas
como os webhooks encontram o tenant
como os jobs encontram o tenant
como os módulos novos pertencem ao tenant
como assets pertencem ao tenant
como entitlements são aplicados
como a nossa operação vira Tenant #1
```

Sem isso, a productização ainda está incompleta.
