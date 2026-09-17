# Levantamento para transformar o Painel Admin em produto SaaS

> **Objetivo deste documento:** orientar uma auditoria técnica e de produto antes de transformar o painel atual — hoje construído para a operação interna de Use Sul / Use Centro / Use Norte — em um produto utilizável por clientes externos.
>
> **Este documento NÃO é um plano de implementação.**
>
> Primeiro precisamos descobrir:
>
> 1. o que hoje está hardcoded ou acoplado à nossa operação;
> 2. o que precisa virar configuração por cliente;
> 3. quais decisões de produto ainda não foram tomadas;
> 4. quais riscos existem para multi-tenant;
> 5. quais mudanças são obrigatórias antes de vender;
> 6. qual seria a sequência mais segura de productização.
>
> O resultado esperado desta etapa é um **relatório de gaps + decisões + roadmap técnico**, não código produzido às cegas.

---

# 1. Contexto atual

Ler primeiro:

```text
painel-estado-atual.md
```

O painel atual foi criado como central operacional das nossas próprias lojas Reserva Ink.

Hoje existem três lojas internas:

```text
Use Sul
Use Centro
Use Norte
```

O sistema possui módulos como:

```text
Dashboard
Pedidos
Clientes
Trocas
Recuperação
Estoque

Produtos
Categorias
Agrupamentos
Promoções

WhatsApp
Templates
Automações

Segmentos
Campanhas

Financeiro
Reembolsos

Webhooks
Integrações
Configurações
```

A arquitetura atual foi construída pensando em uma operação controlada por nós.

A productização exige separar claramente:

```text
DADOS DA PLATAFORMA

vs.

DADOS DO CLIENTE

vs.

CREDENCIAIS DO CLIENTE

vs.

CONFIGURAÇÕES DO CLIENTE
```

---

# 2. Premissa de produto

A ideia futura é que um cliente possa criar uma conta e configurar o próprio ambiente.

Exemplo:

```text
Cliente cria conta
      ↓
Cria organização
      ↓
Cadastra uma ou mais lojas
      ↓
Conecta Reserva Ink
      ↓
Conecta Meta / WhatsApp
      ↓
Configura Webhooks
      ↓
Importa pedidos
      ↓
Começa a operar
```

Ou seja:

> nenhum token, ID, telefone, WABA ID, Store ID ou configuração específica de um cliente deve precisar ser colocado manualmente no `.env` da aplicação pelo operador da plataforma.

O próprio cliente deverá inserir/configurar esses dados quando tecnicamente apropriado.

---

# 3. O que o Claude deve fazer nesta etapa

Executar uma auditoria completa do projeto.

Não começar uma grande refatoração.

Produzir:

```text
1. Inventário do estado atual
2. Lista de hardcodes/acoplamentos
3. Gaps para multi-tenant
4. Decisões de produto pendentes
5. Decisões técnicas pendentes
6. Riscos
7. Arquitetura-alvo sugerida
8. Roadmap de productização
9. Ordem de migração
10. Estimativa relativa de esforço
```

Usar sempre:

```text
FATO OBSERVADO NO CÓDIGO
DECISÃO NECESSÁRIA
RECOMENDAÇÃO
IMPACTO
```

Não misturar fato com suposição.

---

# 4. Primeiro levantamento: tudo que hoje é global

Procurar no projeto tudo que hoje existe como:

```text
env global
constante
array fixo
config global
arquivo JSON compartilhado
singleton
variável em memória
configuração única
```

Exemplos esperados:

```text
ADMIN_PASSWORD
ADMIN_SESSION_SECRET

INK_TOKEN_SUL
INK_TOKEN_CENTRO
INK_TOKEN_NORTE

INK_WEBHOOK_SECRET_SUL
INK_WEBHOOK_SECRET_CENTRO
INK_WEBHOOK_SECRET_NORTE

INK_FEED_URL_SUL
INK_FEED_URL_CENTRO
INK_FEED_URL_NORTE

WHATSAPP_SERVICE_URL
WHATSAPP_API_KEY
WHATSAPP_WEBHOOK_SECRET

SITE_BASE_URL
```

Para cada item, classificar como:

```text
PLATFORM_GLOBAL
TENANT_CONFIG
STORE_CONFIG
INTEGRATION_SECRET
RUNTIME_INFRA
```

Exemplo:

```text
DATABASE_URL
→ PLATFORM_GLOBAL

ADMIN_SESSION_SECRET
→ PLATFORM_GLOBAL

INK_TOKEN_SUL
→ deveria virar STORE/INTEGRATION_SECRET

WABA_ID
→ deveria virar TENANT ou STORE integration config

PHONE_NUMBER_ID
→ deveria virar configuração de canal

META_ACCESS_TOKEN
→ secret por conexão
```

---

# 5. Auditoria de hardcodes de lojas

Localizar todo código que assume explicitamente:

```text
sul
centro
norte
```

ou:

```text
Use Sul
Use Centro
Use Norte
```

Auditar:

```text
frontend
backend
queries
jobs
webhooks
schemas
arrays
selects
relatórios
filtros
dashboards
migrations
configurações
testes
nomes de arquivo
env
```

Produzir tabela:

| Arquivo | Linha/Função | Hardcode | Tipo | Mudança necessária |
|---|---|---|---|---|

O objetivo final deve ser:

```text
nenhuma feature de produto depende de saber que existem "Sul/Centro/Norte".
```

A plataforma deve entender:

```text
Organization
    ├── Store A
    ├── Store B
    └── Store C
```

---

# 6. Definir modelo de tenancy

Precisamos decidir a unidade principal do SaaS.

Sugestão inicial:

```text
User
  ↓
Organization / Workspace
  ↓
Stores
  ↓
Integrations
```

Exemplo:

```text
Tomazi Store Ltda
├── Use Sul
├── Use Centro
└── Use Norte
```

Outro cliente:

```text
Loja ABC
└── Loja ABC
```

O Claude deve analisar se essa estrutura encaixa bem no código atual.

---

# 7. Entidades mínimas a estudar

Avaliar necessidade de:

```text
users
organizations
organization_members
stores
integrations
integration_credentials
integration_webhooks
subscriptions
plans
feature_entitlements
audit_logs
```

Não criar ainda.

Primeiro definir responsabilidades.

---

# 8. `users`

Hoje existe senha administrativa única.

Isso não serve para SaaS.

Precisamos decidir:

```text
email + senha
magic link
Google OAuth
outro provider
```

Para V1, avaliar solução simples e segura.

Requisitos mínimos:

```text
login individual
reset de senha
verificação de e-mail
logout
sessões
revogação de sessão
proteção contra brute force
```

---

# 9. `organizations`

Uma organização representa o cliente pagante.

Exemplo:

```text
organization
────────────────
id
name
slug
status
created_at
updated_at
```

Tudo que pertence ao cliente deve apontar direta ou indiretamente para:

```text
organization_id
```

---

# 10. `organization_members`

Precisamos decidir se V1 terá múltiplos usuários.

Mesmo que V1 comece com um único usuário por organização, a arquitetura não deve impedir:

```text
owner
admin
operator
viewer
```

Levantar quais partes do painel futuramente podem exigir RBAC.

---

# 11. `stores`

As lojas atuais devem virar registros.

Modelo conceitual:

```text
stores
────────────────
id
organization_id
name
slug
status
timezone
currency
locale
created_at
updated_at
```

Campos específicos de Reserva Ink NÃO devem ficar diretamente na store se pertencem à integração.

---

# 12. Isolamento multi-tenant

Esta é uma condição obrigatória.

Auditar todas as tabelas atuais.

Para cada tabela responder:

```text
Esse dado pertence à plataforma?
À organização?
À loja?
Ao usuário?
```

Criar relatório:

| Tabela | Escopo atual | Escopo futuro | Chave necessária |
|---|---|---|---|

Exemplo:

```text
pedidos_ink
→ store_id obrigatório

segments
→ organization_id ou store_id?

campaigns
→ organization_id

campaign_recipients
→ herdado da campaign

media_assets
→ organization_id

app_config
→ precisa ser dividido entre plataforma e tenant
```

---

# 13. Regra crítica de queries

A auditoria deve procurar qualquer query do tipo:

```sql
SELECT * FROM campaigns
```

que futuramente deveria ser:

```sql
SELECT *
FROM campaigns
WHERE organization_id = ?
```

ou equivalente.

O risco mais grave de SaaS é:

> cliente A visualizar/alterar dados do cliente B.

Criar uma lista específica de:

```text
MULTI-TENANT DATA LEAK RISKS
```

---

# 14. Estratégia de tenancy no banco

Avaliar opções.

## Opção A

```text
shared database
shared schema
organization_id/store_id
```

Provavelmente mais adequada para V1.

## Opção B

```text
schema por tenant
```

## Opção C

```text
database por tenant
```

Produzir recomendação com tradeoffs.

Não escolher apenas por "mais seguro".

Considerar:

```text
simplicidade
custo
migrations
backups
queries
suporte
escala
observabilidade
```

---

# 15. Integrações como entidade de primeira classe

Hoje integrações parecem estar tratadas principalmente como configuração externa/global.

Para SaaS precisamos pensar:

```text
organization
    ↓
integration
    ↓
credentials/config
```

Modelo conceitual:

```text
integrations
────────────────
id
organization_id
store_id nullable

provider
type
status

display_name
config_json

created_at
updated_at
```

Exemplos:

```text
provider = reserva_ink
type = ecommerce

provider = meta_whatsapp
type = messaging

provider = mailchimp
type = email_marketing
```

---

# 16. Credenciais NÃO devem ficar misturadas com config comum

Separar conceitualmente:

```text
CONFIG
```

de:

```text
SECRET
```

Exemplo Meta:

### config

```text
waba_id
phone_number_id
business_id
display_phone_number
```

### secrets

```text
access_token
app_secret
webhook_verify_token
```

Reserva Ink:

### config

```text
store identifier
feed URL
```

### secrets

```text
API token
webhook secret
```

---

# 17. Armazenamento de secrets

Definir estratégia.

Não armazenar tokens sensíveis em plaintext comum sem justificativa.

Avaliar:

```text
criptografia application-level
KMS
secret manager
encrypted DB column
```

Para V1, sugerir uma solução realista.

Documentar:

```text
encryption at rest
key rotation
token rotation
masking
audit
```

---

# 18. UI de integração

O cliente deve conseguir configurar integrações sem acesso ao servidor.

Exemplo:

```text
Sistema
└── Integrações
```

Cards:

```text
Reserva Ink
WhatsApp / Meta
Mailchimp
Instagram
```

Cada card:

```text
Não configurado
Configurando
Conectado
Erro
Expirado
Desativado
```

---

# 19. Configuração Reserva Ink

Levantar exatamente quais dados são necessários hoje.

Exemplo esperado:

```text
API token
Webhook secret
Feed URL
identificador da loja
```

Mas não assumir.

Ler código e documentação da integração atual.

Produzir:

```text
Campos obrigatórios
Campos opcionais
Campos deriváveis
Campos que podem ser descobertos pela API
Campos que o usuário precisa copiar manualmente
```

---

# 20. Configuração Meta / WhatsApp

Levantar tudo que a integração atual usa.

Possíveis dados:

```text
Meta App ID
Meta App Secret

Business Manager ID
WABA ID
Phone Number ID
Access Token
Webhook Verify Token

número
nome exibido
idioma
```

Não assumir que todos são necessários.

Mapear código real.

---

# 21. Manual token vs OAuth

Para cada integração, decidir:

```text
cliente cola token
```

ou:

```text
cliente conecta via OAuth
```

Criar tabela:

| Provider | V1 | Futuro | Motivo |
|---|---|---|---|

Exemplo potencial:

```text
Reserva Ink
V1 → token manual

Meta
V1 → avaliar Embedded Signup/OAuth

Mailchimp
V1 → API Key manual
Futuro → OAuth
```

Mas confirmar possibilidades antes.

---

# 22. Onboarding

Definir fluxo inicial.

Sugestão:

```text
1. Criar conta
2. Criar organização
3. Criar primeira loja
4. Conectar Reserva Ink
5. Testar conexão
6. Configurar webhook
7. Importar histórico
8. Conectar WhatsApp
9. Testar WhatsApp
10. Finalizar onboarding
```

A auditoria deve identificar:

```text
quais etapas podem ser automatizadas
quais exigem ação externa
quais podem falhar
como retomar onboarding interrompido
```

---

# 23. Wizard vs configuração livre

Definir se V1 terá:

```text
wizard guiado
```

ou apenas:

```text
Integrações + Configurações
```

Recomendação inicial:

```text
wizard inicial
+
telas normais depois
```

Mas validar esforço.

---

# 24. Teste de conexão

Toda integração deveria ter:

```text
[Testar conexão]
```

Resultado:

```text
Conectado

ou

Token inválido
Permissão insuficiente
ID incorreto
API indisponível
```

Não salvar configuração como saudável apenas porque os campos foram preenchidos.

---

# 25. Validação progressiva

Sempre que possível:

```text
cliente informa token
      ↓
backend valida
      ↓
backend descobre IDs disponíveis
      ↓
cliente escolhe
```

Evitar pedir ao usuário IDs que a API pode descobrir.

Exemplo conceitual:

```text
access token
    ↓
listar WABAs disponíveis
    ↓
selecionar WABA
    ↓
listar números
    ↓
selecionar número
```

Avaliar onde isso é tecnicamente possível.

---

# 26. Webhooks multi-tenant

Hoje existe:

```text
/api/webhooks/ink
/api/webhooks/whatsapp
```

Precisamos definir como um webhook identifica:

```text
qual organização
qual loja
qual integração
```

Possibilidades:

```text
URL única + lookup por provider ID
```

ou:

```text
/api/webhooks/ink/:integrationId
```

ou token seguro.

Produzir recomendação.

---

# 27. Webhook routing

Exemplo:

```text
Webhook Meta chega
      ↓
phone_number_id
      ↓
lookup integration
      ↓
organization_id
      ↓
processa evento no tenant correto
```

Reserva Ink pode exigir outra chave de roteamento.

Documentar provider por provider.

---

# 28. Webhook verification

Auditar:

```text
assinatura
secret
verify token
replay protection
idempotency
```

Não aceitar apenas:

```text
"tem endpoint, então está pronto"
```

---

# 29. Jobs multi-tenant

Hoje os jobs rodam globalmente no processo.

Exemplo:

```text
processarFilaDeCampanhas
processarBulkCategoryJobs
processarFollowUpsCarrinho
processarFollowUpsPix
syncPedidosInkParaPostgres
sincronizarProdutosFeedTodasLojas
```

Precisamos descobrir:

```text
como cada job percorre lojas
como escolhe tokens
como impede vazamento
como escala com 10, 100, 1000 clientes
```

---

# 30. Remover loops hardcoded de lojas

Qualquer padrão:

```js
for (const store of ['sul', 'centro', 'norte'])
```

deve ser mapeado.

Futuro:

```text
buscar stores/integrations ativas no banco
```

---

# 31. Job leasing / concorrência

Com SaaS, avaliar se `setInterval` no mesmo `server.js` continua aceitável.

Perguntas:

```text
um único processo?
múltiplas réplicas?
Railway escala horizontal?
jobs duplicariam?
```

Avaliar necessidade futura de:

```text
job queue
worker
Redis
BullMQ
Postgres SKIP LOCKED
advisory locks
```

Não implementar automaticamente.

Produzir recomendação por estágio:

```text
MVP
crescimento
escala
```

---

# 32. Configurações

Hoje existe:

```text
app_config
```

e configurações globais.

Precisamos separar:

```text
platform_config
organization_config
store_config
integration_config
user_preferences
```

Mapear cada configuração atual para um desses níveis.

---

# 33. Entitlements / planos

Hoje já existe conceito de flags de plano.

Auditar:

```text
whatsapp
instagram
catalog
exchanges
refunds
financial
advancedAutomations
```

Precisamos decidir:

```text
quais funcionalidades serão produto
quais serão add-ons
quais pertencem a qual plano
```

Não definir preço nesta etapa, salvo se já existir decisão.

---

# 34. Planos

Produzir uma proposta de packaging apenas para orientar arquitetura.

Exemplo conceitual:

```text
Starter
Professional
Advanced
```

Mas o importante é descobrir unidades de limite:

```text
número de lojas
número de usuários
campanhas/mês
mensagens
contatos
automations
histórico
integrações
```

---

# 35. Usage metering

Se futuramente houver limites, definir como medir.

Exemplo:

```text
messages_sent
campaign_recipients
active_contacts
stores
users
automation_runs
```

Não colocar lógica de cobrança espalhada nas features.

---

# 36. Billing

Não precisa implementar nesta etapa.

Mas definir arquitetura futura:

```text
organization
   ↓
subscription
   ↓
plan
   ↓
entitlements
```

Avaliar:

```text
Stripe
Mercado Pago
outro
```

A decisão comercial pode ficar pendente.

---

# 37. Trial

Definir se produto terá:

```text
trial de X dias
```

ou:

```text
trial por uso
```

Essa decisão afeta:

```text
subscription state
entitlements
onboarding
billing
```

Marcar como `PRODUCT_DECISION` se não definido.

---

# 38. Estado da organização

Precisamos suportar:

```text
trial
active
past_due
suspended
cancelled
```

ou modelo equivalente.

Definir o que ocorre com:

```text
jobs
webhooks
envios
acesso ao painel
dados
```

em cada estado.

---

# 39. Autenticação vs autorização

Separar claramente:

```text
AUTHENTICATION
quem é o usuário?

AUTHORIZATION
o que ele pode acessar?
```

Toda rota `/api/admin/*` atual deve ser auditada.

Futuro provavelmente não deve continuar conceitualmente como:

```text
admin global
```

---

# 40. Middleware multi-tenant

Arquitetura desejada conceitualmente:

```text
authenticateUser
      ↓
resolveOrganization
      ↓
verifyMembership
      ↓
resolveStore if needed
      ↓
checkEntitlement
      ↓
handler
```

Auditar o esforço para introduzir isso.

---

# 41. Super admin da plataforma

Precisamos de um contexto diferente para nós, operadores do SaaS.

Exemplo:

```text
/admin/*
```

hoje é painel do cliente.

Talvez futuro:

```text
/app/*
```

cliente

e:

```text
/platform/*
```

super admin

ou outra convenção.

Não mudar rotas agora.

Definir necessidade.

---

# 42. Impersonation

Avaliar se suporte precisa de:

```text
entrar como cliente
```

Se implementado futuramente:

```text
audit log obrigatório
banner visível
tempo limitado
permissão restrita
```

Não implementar nesta etapa.

---

# 43. Auditoria

SaaS precisa registrar ações importantes.

Exemplos:

```text
integration_connected
integration_token_changed
campaign_started
campaign_paused
campaign_resumed
refund_created
webhook_config_changed
member_invited
role_changed
```

Auditar `audit_log` atual e verificar se serve.

---

# 44. Logs

Logs de servidor devem carregar:

```text
organization_id
store_id
integration_id
user_id
request_id
```

quando aplicável.

Evitar PII desnecessária.

---

# 45. Observabilidade

Levantar necessidades:

```text
error tracking
logs
metrics
job failures
webhook failures
provider failures
queue depth
API latency
```

Sugerir stack compatível com arquitetura atual.

---

# 46. Dashboard da plataforma

Nós, donos do produto, provavelmente precisaremos ver:

```text
organizações
usuários
lojas
integrações
status
uso
jobs com erro
webhooks falhando
versão/plano
MRR futuramente
```

Separar isso do dashboard operacional do cliente.

---

# 47. Secrets e suporte

Suporte não deve conseguir visualizar token completo por padrão.

UI:

```text
Meta Access Token
••••••••••••3ab9

[Substituir]
```

Não:

```text
[Mostrar token]
```

a menos que exista motivo forte.

---

# 48. Rotação de credencial

Toda integração deve permitir:

```text
substituir token
revalidar
desativar
reconectar
```

Sem apagar histórico.

---

# 49. Saúde da integração

Criar conceito padrão:

```text
not_configured
connected
degraded
error
expired
disabled
```

Mais:

```text
last_checked_at
last_success_at
last_error_at
last_error_code
```

---

# 50. Histórico de conexão

Seria útil armazenar:

```text
connected_at
connected_by
last_rotated_at
disabled_at
```

Definir necessidade V1.

---

# 51. Backfill inicial

Hoje existe backfill de pedidos.

Precisamos transformar isso em fluxo por cliente.

Exemplo:

```text
Conexão Ink concluída
      ↓
Deseja importar histórico?

Últimos:
30 dias
90 dias
1 ano
Tudo disponível
```

Auditar limites da API.

---

# 52. Estado do onboarding

Persistir algo como:

```text
organization onboarding status
```

ou calcular dinamicamente.

Etapas possíveis:

```text
account_created
store_created
ink_connected
webhook_active
backfill_completed
whatsapp_connected
ready
```

---

# 53. Produto sem WhatsApp

Definir:

> o cliente pode usar apenas catálogo/pedidos sem WhatsApp?

Provavelmente sim.

Não acoplar onboarding obrigatório a todos os providers se os planos permitirem uso parcial.

---

# 54. Produto sem Reserva Ink

Pergunta estratégica:

> o SaaS será exclusivamente para clientes Reserva Ink?

ou:

> no futuro poderá integrar outras plataformas?

Essa decisão altera profundamente o domínio.

Classificar como:

```text
PRODUCT_DECISION_CRITICAL
```

---

# 55. Caso seja exclusivamente Reserva Ink

Podemos simplificar:

```text
store
   ↓
Reserva Ink integration obrigatória
```

---

# 56. Caso seja multi-commerce no futuro

Precisamos pensar:

```text
CommerceProvider
- reserva_ink
- shopify
- nuvemshop
...
```

e evitar campos `ink_*` espalhados no modelo central.

O Claude deve apontar onde o código já está excessivamente acoplado à Ink.

---

# 57. Canonical domain

Mesmo continuando apenas com Ink por enquanto, identificar conceitos que deveriam ser genéricos:

```text
Order
Customer
Product
Category
Store
Campaign
Refund
Exchange
Cart
Inventory
```

e conceitos específicos:

```text
InkProductPayload
InkOrderPayload
InkWebhookEvent
```

---

# 58. Provider adapters

Avaliar futuramente estrutura:

```text
providers/
  reservaInk/
  metaWhatsApp/
  mailchimp/
```

Em vez de lógica externa espalhada no `server.js`.

Não iniciar refactor gigante sem roadmap.

---

# 59. `server.js`

Hoje o backend está concentrado em um arquivo grande.

A productização provavelmente aumenta muito a complexidade.

Auditar:

```text
quantas responsabilidades
quais domínios
quais integrações
quais jobs
```

Produzir proposta incremental de modularização.

Não fazer rewrite completo.

---

# 60. Recomendação de modularização

Esperado algo parecido futuramente:

```text
server/
  auth/
  organizations/
  stores/
  integrations/
  orders/
  catalog/
  campaigns/
  whatsapp/
  webhooks/
  jobs/
```

Mas somente após mapear dependências reais.

---

# 61. API versioning

Decidir se V1 precisa:

```text
/api/v1/
```

ou se manter `/api/admin/*` é aceitável durante MVP.

Não criar versionamento apenas por estética.

---

# 62. Naming do produto

Hoje muitas coisas usam:

```text
admin
```

Mas para cliente final o painel é o produto.

Levantar nomes que futuramente precisam mudar:

```text
Admin
AdminShell
adminState
/api/admin
```

Classificar:

```text
interno, pode ficar
```

vs.

```text
visível para cliente, precisa mudar
```

---

# 63. Dados de cliente

Definir políticas mínimas:

```text
exportação
exclusão
retenção
backup
```

Especialmente porque existem:

```text
nome
telefone
email
endereço
pedidos
mensagens
```

---

# 64. LGPD

Produzir checklist de impactos técnicos, não parecer jurídico.

Exemplos:

```text
consentimento
finalidade
retenção
direitos do titular
eliminação
exportação
subprocessadores
logs
controle de acesso
```

Marcar itens que exigem revisão jurídica.

---

# 65. Exclusão de organização

Definir comportamento:

```text
soft delete?
grace period?
hard delete?
backup retention?
```

E dados externos:

```text
webhooks
tokens
campaigns
media
```

---

# 66. Exportação

Avaliar se cliente precisa exportar:

```text
clientes
pedidos
campanhas
logs
```

Não implementar ainda.

---

# 67. Uploads e mídia

Auditar:

```text
media_assets
UPLOADS_DIR
IMG_CACHE_DIR
STORAGE_DIR
```

Hoje pode existir armazenamento local/volume.

Para SaaS precisamos definir:

```text
por tenant
quota
nomes seguros
object storage
CDN
limpeza
```

---

# 68. Storage

Avaliar momento de migrar de volume local para:

```text
S3-compatible
Cloudflare R2
AWS S3
Supabase Storage
```

Não escolher apenas por preferência.

Considerar:

```text
custo
deploy
backup
multi-instance
CDN
signed URLs
```

---

# 69. IDs públicos

Evitar expor IDs sequenciais sensíveis se isso facilitar enumeração entre tenants.

Avaliar uso de:

```text
UUID
ULID
opaque public ID
```

sem necessariamente migrar PK interna.

---

# 70. Rate limiting

SaaS público precisa de rate limiting em:

```text
login
password reset
webhooks
campaign start
test connection
media upload
API endpoints sensíveis
```

Auditar o que existe.

---

# 71. CSRF / cookies / sessão

Revisar arquitetura de sessão atual.

Hoje existe cookie HMAC.

Avaliar para multi-user:

```text
secure
httpOnly
sameSite
expiry
rotation
CSRF
session revocation
```

---

# 72. Domínio

Definir arquitetura de URLs.

Exemplos:

```text
app.produto.com
```

ou:

```text
produto.com/app
```

E eventualmente:

```text
tenant.produto.com
```

Não escolher subdomain por tenant sem necessidade.

---

# 73. Emails transacionais da plataforma

SaaS vai precisar de:

```text
verificação de email
reset de senha
convite de usuário
alerta de integração quebrada
billing
```

Definir provider futuro.

Não confundir com Mailchimp dos clientes.

---

# 74. Notificações internas

Hoje notificações do header são decorativas.

Productização pode torná-las úteis:

```text
token expirou
webhook falhando
import finalizado
campanha concluída
pagamento falhou
```

Avaliar prioridade.

---

# 75. Configuração de timezone

Hoje jobs podem assumir timezone do servidor/operação.

Em SaaS, cada organização/store pode estar em timezone diferente.

Auditar:

```text
datas
filtros
relatórios
campaign scheduling
jobs
```

---

# 76. Moeda e locale

Mesmo que V1 seja Brasil:

```text
BRL
pt-BR
```

é útil separar conceito.

Não internacionalizar tudo agora.

Evitar hardcodes impossíveis de remover depois.

---

# 77. Telefone

Normalização deve considerar:

```text
country code
E.164
```

Se produto for apenas Brasil V1, documentar.

---

# 78. Feature flags

Definir diferença:

```text
feature flag interna
```

vs.

```text
entitlement de plano
```

Não usar uma coisa como a outra.

---

# 79. Ambiente demo

Pode ser útil para vendas.

Avaliar necessidade de:

```text
demo tenant
seeded data
read-only
```

sem misturar com produção real.

---

# 80. Suporte

Definir ferramentas mínimas para operador:

```text
ver saúde do tenant
ver integrações sem secrets
ver últimos erros
reprocessar job
revalidar conexão
ver webhooks
```

Evitar depender de acesso ao banco/terminal para tudo.

---

# 81. Customer-facing logs

Talvez o cliente precise ver:

```text
Webhook recebido
Campanha processada
Integração falhou
Sync executado
```

Auditar `/admin/eventos` atual.

---

# 82. Retry manual

Para erros recuperáveis:

```text
[Reprocessar]
```

pode ser importante.

Definir quais ações são seguras/idempotentes.

---

# 83. Provider outages

O sistema deve distinguir:

```text
configuração do cliente inválida
```

de:

```text
Meta fora do ar
```

e:

```text
erro interno
```

Isso impacta suporte.

---

# 84. Status page

Não é V1 obrigatório.

Marcar como futuro.

---

# 85. Backups

Definir:

```text
frequência
retenção
restore
teste de restore
```

Não tratar backup do provider como backup do SaaS.

---

# 86. Migrations

Com clientes reais:

> migration não pode apagar/reescrever dados sem estratégia.

Definir padrão:

```text
backward compatible
expand/migrate/contract
```

quando necessário.

---

# 87. Deploy

Hoje build do admin ocorre no deploy.

Auditar:

```text
zero downtime?
migration before boot?
migration concorrente?
rollback?
```

---

# 88. Ambientes

Definir:

```text
development
staging
production
```

Secrets separados.

Não usar contas reais de clientes em staging.

---

# 89. Sandbox de integrações

Verificar se providers oferecem ambiente de teste.

Criar matriz:

| Provider | Sandbox | Test account | Estratégia |
|---|---|---|---|

---

# 90. Testes

A productização exige elevar o nível de testes.

Prioridades:

```text
auth
tenant isolation
integration credentials
webhook routing
campaigns
jobs
billing/entitlements
```

---

# 91. Teste obrigatório de tenant isolation

Criar no futuro algo equivalente:

```text
Tenant A
Tenant B
```

Garantir que:

```text
A não lê B
A não altera B
A não usa token de B
webhook de A não cria dados em B
job de A não processa B
```

Isso deve ser um conjunto de testes dedicado.

---

# 92. Seed de desenvolvimento

Criar futuramente:

```text
Org Demo A
  Store A1
  Store A2

Org Demo B
  Store B1
```

para testar isolamento.

---

# 93. Definition of Ready para começar refactor

Não iniciar productização pesada enquanto não tivermos decidido ao menos:

```text
tenant model
store model
auth model
secret storage
integration model
billing strategy mínima
multi-tenant DB strategy
webhook routing
job strategy MVP
```

---

# 94. Saída obrigatória da auditoria

Criar arquivo:

```text
productization-audit.md
```

com exatamente estas seções:

---

## A. Executive summary

Resumo de:

```text
estado atual
nível de acoplamento
principais blockers
risco geral
```

---

## B. Hardcodes encontrados

Tabela:

| Tipo | Local | Valor atual | Problema | Solução |
|---|---|---|---|---|

---

## C. Globals que precisam virar tenant config

Tabela:

| Config atual | Escopo futuro | Onde armazenar |
|---|---|---|

---

## D. Secrets

Tabela:

| Secret | Provider | Escopo | Armazenamento atual | Armazenamento recomendado |
|---|---|---|---|---|

---

## E. Tabelas e tenancy

Tabela:

| Tabela | Tenant scoped? | Store scoped? | Mudança |
|---|---:|---:|---|

---

## F. Rotas com risco multi-tenant

Listar:

```text
rota
handler
problema
correção esperada
```

---

## G. Jobs com risco multi-tenant

Listar todos.

---

## H. Webhooks

Por provider:

```text
como identifica tenant hoje
como deveria identificar
risco
```

---

## I. Auth

```text
estado atual
limitações
arquitetura sugerida
```

---

## J. Integrações

Para cada provider:

```text
dados pedidos do cliente
secrets
IDs
o que pode ser descoberto automaticamente
OAuth/manual
webhook
teste de conexão
```

---

## K. Decisões de produto pendentes

Usar IDs:

```text
PD-001
PD-002
...
```

Exemplo:

```text
PD-001
O SaaS será exclusivo para Reserva Ink?

Impacto:
ALTO

Opções:
A. Sim
B. Não

Recomendação:
...
```

---

## L. Decisões técnicas pendentes

Usar IDs:

```text
TD-001
TD-002
...
```

---

## M. Riscos

Classificar:

```text
CRITICAL
HIGH
MEDIUM
LOW
```

---

## N. Arquitetura-alvo

Diagrama textual.

Exemplo:

```text
User
 ↓
Organization
 ↓
Store
 ↓
Integration
 ↓
Provider
```

---

## O. Roadmap

Separar:

```text
Phase 0 - Foundations
Phase 1 - Tenancy
Phase 2 - Auth
Phase 3 - Integrations
Phase 4 - Onboarding
Phase 5 - Billing
Phase 6 - Hardening
```

Ajustar após auditoria.

---

## P. Quick wins

Mudanças que podem ser feitas antes do grande refactor.

---

## Q. Blockers

Itens sem os quais não devemos colocar cliente externo real.

---

# 95. Classificação de prioridade

Para cada item:

```text
P0
P1
P2
P3
```

Definição:

```text
P0
Obrigatório antes de qualquer cliente externo.

P1
Obrigatório antes de comercialização ampla.

P2
Importante após MVP.

P3
Evolução futura.
```

---

# 96. Classificação de esforço

Usar:

```text
XS
S
M
L
XL
```

Não estimar horas.

---

# 97. Classificação de risco

Usar:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

---

# 98. O que NÃO fazer durante a auditoria

Não:

```text
reescrever backend
trocar framework
trocar banco
introduzir microservices
implementar Stripe
criar OAuth para tudo
migrar storage
renomear todas as rotas
```

apenas porque parecem melhorias.

Toda mudança deve ter:

```text
problema concreto
motivo
prioridade
dependência
```

---

# 99. Princípio de evolução

A productização deve ser incremental.

Ideal:

```text
painel interno atual
      ↓
introduz organization/store
      ↓
migra nossa própria operação como Tenant #1
      ↓
valida tudo
      ↓
habilita onboarding de segundo tenant
      ↓
cliente piloto
      ↓
produto comercial
```

Nossa própria operação deve virar:

```text
Organization #1
```

em vez de continuar como caso especial.

---

# 100. Dogfooding

Antes de aceitar cliente externo:

```text
Use Sul / Centro / Norte
```

devem estar funcionando usando exatamente o mesmo modelo que será usado pelos clientes.

Nada de:

```text
if internalTenant
```

para contornar arquitetura.

---

# 101. Arquitetura conceitual desejada

```text
                   PLATFORM
                      │
                ┌─────┴─────┐
                │           │
              User      Platform Admin
                │
         Organization
                │
          ┌─────┴─────┐
          │           │
        Store       Store
          │           │
    Integrations   Integrations
          │
   ┌──────┼──────────────┐
   │      │              │
 Ink    Meta         Mailchimp
   │      │              │
Orders WhatsApp       Email
```

---

# 102. Princípio para integrações

O cliente deve ser capaz de:

```text
adicionar
configurar
testar
atualizar
desativar
reconectar
```

uma integração sem acesso ao servidor.

---

# 103. Formulário de integração

Cada provider deve declarar seus próprios campos.

Exemplo conceitual:

```ts
IntegrationDefinition {
  provider
  fields
  secretFields
  validation
  discoverySteps
  healthCheck
}
```

Isso pode evitar UI hardcoded para cada integração no futuro.

Não implementar automaticamente.

Avaliar se vale V1.

---

# 104. Campos secretos

UI deve saber:

```text
secret: true
```

para:

```text
mascarar
não devolver valor
permitir substituição
```

---

# 105. Integration setup state

Talvez seja necessário:

```text
draft
credentials_saved
validated
webhook_pending
connected
error
```

Avaliar.

---

# 106. Campos descobertos automaticamente

Sempre preferir:

```text
token
   ↓
API
   ↓
lista IDs
```

em vez de:

```text
"copie WABA ID manualmente"
```

quando provider permitir.

Isso reduz suporte.

---

# 107. Meta como exemplo de UX

Idealmente:

```text
Conectar Meta
   ↓
autenticar
   ↓
selecionar Business
   ↓
selecionar WABA
   ↓
selecionar número
   ↓
webhook configurado
```

Se V1 não permitir Embedded Signup:

```text
formulário manual guiado
```

com links/instruções claras.

---

# 108. Ink como exemplo de UX

Ideal:

```text
Token
   ↓
[Testar]
   ↓
Loja encontrada
   ↓
Webhook status
   ↓
Feed status
```

Não exigir campos redundantes se puderem ser derivados.

---

# 109. Validação de configuração

Toda integração deve possuir método conceitual:

```text
validateCredentials()
discoverResources()
configureWebhook()
healthCheck()
```

Mesmo que internamente ainda não exista uma interface.

---

# 110. Configuração incompleta

O painel deve permitir salvar rascunho?

Definir.

Exemplo:

```text
Meta
Status: Configuração incompleta

Falta:
- Phone Number ID
```

Pode melhorar onboarding.

---

# 111. Entitlement por integração

Possível futuro:

```text
Starter
Ink + pedidos

Pro
+ WhatsApp

Advanced
+ automações
```

A arquitetura de integração não pode assumir que todos têm todos os providers.

---

# 112. Limites por loja

Talvez o plano limite:

```text
1 loja
3 lojas
ilimitado
```

Por isso `stores` deve ser entidade real.

---

# 113. Limites por integração

Possível:

```text
1 WhatsApp number por store
```

ou:

```text
N WABAs por organization
```

Definir depois.

Não hardcodar sem decisão.

---

# 114. Multi-number WhatsApp

Pergunta técnica/produto:

> uma organização poderá conectar mais de um Phone Number ID?

Classificar decisão.

Mesmo que V1 seja um número, modelar integração de forma que não impeça evolução.

---

# 115. Multi-store + WABA

Precisamos definir relação:

```text
Store 1 -> Number A
Store 2 -> Number B
```

ou:

```text
Organization -> Number A compartilhado
```

A arquitetura deve suportar explicitamente um dos modelos ou ambos.

---

# 116. Histórico

Quando uma integração muda:

```text
Phone Number A
→ Phone Number B
```

campanhas antigas devem continuar mostrando qual provider resource foi usado.

Persistir snapshot/IDs relevantes.

---

# 117. Deprovision

Quando cliente cancela:

```text
parar jobs
parar campanhas
desativar webhooks quando possível
revogar tokens quando possível
```

Definir comportamento.

---

# 118. Ownership de webhooks

Se a plataforma registrar webhook automaticamente no provider:

> quem remove ao desconectar?

Definir lifecycle.

---

# 119. Import lifecycle

Backfills precisam ser:

```text
canceláveis?
reiniciáveis?
idempotentes?
```

Auditar job atual.

---

# 120. Erros de onboarding

Precisamos guardar:

```text
step
error_code
message
last_attempt
```

ou pelo menos oferecer diagnóstico claro.

---

# 121. Checklist P0 para primeiro cliente externo

O relatório final deve responder SIM/NÃO para:

```text
[ ] Auth individual
[ ] Tenant isolation
[ ] Stores dinâmicas
[ ] Tokens fora do .env
[ ] Secrets protegidos
[ ] Webhooks roteados por tenant
[ ] Jobs tenant-aware
[ ] Audit log
[ ] Integrações self-service
[ ] Test connection
[ ] Backup
[ ] Error tracking
[ ] LGPD mínimo
[ ] Data deletion strategy
[ ] Entitlements básicos
[ ] Operação interna migrada para Tenant #1
```

---

# 122. Questões que devem ser respondidas pelo código antes de decidir

O Claude deve investigar:

1. Quantos pontos hoje dependem do array fixo de três lojas?
2. Onde os tokens Ink são carregados?
3. Onde o serviço WhatsApp recebe credenciais?
4. O WhatsApp service é multi-tenant ou assume uma conta?
5. Como cada webhook identifica loja?
6. Como pedidos armazenam `store`?
7. O campo `store` é string ou FK?
8. Como clientes são deduplicados entre lojas?
9. Segmentos são globais ou por loja?
10. Campanhas são globais ou por loja?
11. Templates WhatsApp são globais ou por loja?
12. Automations são globais ou por loja?
13. Media assets possuem ownership?
14. `app_config` é global?
15. Existe código que lê env durante request?
16. Jobs possuem locks persistentes?
17. O fallback JSON é realmente necessário em produção futura?
18. Como uploads são isolados?
19. Como status de plano é calculado?
20. Qual parte do painel já está preparada para produto genérico?

---

# 123. Questões de produto para nós decidirmos

O relatório deve nos devolver essas perguntas em formato decisório:

### PD-001

O produto será exclusivo para Reserva Ink na V1?

### PD-002

Uma organização pode ter múltiplas lojas?

### PD-003

Uma loja pode ter múltiplos números WhatsApp?

### PD-004

Múltiplos usuários por organização entram na V1?

### PD-005

Quais módulos fazem parte do plano inicial?

### PD-006

O cliente configura tokens manualmente ou teremos OAuth onde possível?

### PD-007

Existe trial?

### PD-008

Haverá plano gratuito?

### PD-009

Qual é a unidade de cobrança?

### PD-010

Qual histórico de dados manter após cancelamento?

### PD-011

Clientes podem usar o produto sem WhatsApp?

### PD-012

Clientes podem usar o produto sem conexão Ink?

### PD-013

Mailchimp entra no MVP ou depois?

### PD-014

Instagram entra no MVP ou depois?

### PD-015

Financeiro Ink será parte do produto inicial?

---

# 124. Resultado final esperado desta tarefa

Não implementar ainda a productização completa.

Entregar:

```text
docs/productization-audit.md
```

e opcionalmente:

```text
docs/productization-decisions.md
```

Se fizer sentido separar.

O primeiro deve ser factual/técnico.

O segundo deve conter apenas decisões que precisamos tomar.

---

# 125. Formato de `productization-decisions.md`

Exemplo:

```md
# Decisões pendentes

## PD-001 — Escopo de providers de e-commerce

Status: OPEN
Impacto: CRITICAL

Pergunta:
O MVP será exclusivo para Reserva Ink?

Opção A — Exclusivo Ink
Prós:
...

Contras:
...

Opção B — Arquitetura multi-commerce desde V1
Prós:
...

Contras:
...

Recomendação:
...

Decisão:
[aguardando]
```

---

# 126. Não bloquear auditoria por perguntas

Se uma decisão estiver faltando:

```text
marcar OPEN
```

e continuar o levantamento.

Não parar o trabalho pedindo confirmação a cada ponto.

---

# 127. Critério de sucesso

Depois desta auditoria devemos conseguir responder:

```text
O que precisamos mudar para vender o painel?
```

sem resposta genérica.

Precisamos saber:

```text
quais tabelas
quais rotas
quais jobs
quais configs
quais secrets
quais hardcodes
quais telas
quais decisões
qual ordem
qual risco
```

---

# 128. Direção recomendada

A hipótese inicial é:

```text
User
 ↓
Organization
 ↓
Stores
 ↓
Integrations
```

com:

```text
shared Postgres
organization_id/store_id
```

e integrações self-service.

Mas isso é uma hipótese.

O Claude deve validar contra o projeto real antes de declarar como arquitetura definitiva.

---

# 129. Princípio final

A productização NÃO é:

```text
pegar o painel atual
+
criar uma tela onde cliente cola tokens
```

Isso seria apenas tornar configurações editáveis.

Productização real exige:

```text
identidade
tenancy
isolamento
ownership
secrets
integrações
onboarding
entitlements
observabilidade
lifecycle
segurança
billing-ready architecture
```

A auditoria deve tratar esses temas como parte do mesmo produto.

---

# 130. Próximo passo depois da auditoria

Somente depois de revisar `productization-audit.md` e fechar as decisões P0/P1:

```text
criar productization-plan.md
```

com implementação faseada.

Não iniciar esse plano nesta tarefa.

Primeiro descobrir e decidir.
