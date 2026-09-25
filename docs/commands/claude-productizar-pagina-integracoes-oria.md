# Productização da página de Integrações do Oria

## Contexto

A página `/admin/integracoes` já está próxima do padrão correto para a Reserva Ink, mas as demais integrações ainda misturam:

- entitlement do plano;
- configuração global da plataforma;
- configuração do tenant;
- health da integração;
- erros HTTP;
- features ainda não implementadas.

Exemplos observados na UI atual:

```text
WhatsApp
- "Não incluído no plano"
- "API conectada"
- HTTP 403

Número do WhatsApp
- HTTP 403

Sincronização histórica de pedidos
- "Nenhuma loja conectada"

Cache do catálogo
- HTTP 403

GA4
- HTTP 403

Google Ads
- expõe GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI

Meta Ads
- expõe META_APP_ID / META_APP_SECRET / META_OAUTH_REDIRECT_URI

OpenAI
- HTTP 403

Instagram
- "Não incluído no plano"
- "Em breve"
```

A Reserva Ink deve virar a referência de UX para o restante: estado semântico, configuração explícita e próxima ação clara.

---

# 1. Objetivo

Transformar `/admin/integracoes` em uma tela de SaaS para cliente final.

Para cada integração, responder claramente:

```text
1. Meu plano permite usar isso?
2. O Oria está preparado globalmente para oferecer essa integração?
3. Minha Organization já configurou/conectou?
4. A conexão está saudável?
5. Qual é a próxima ação?
```

Nunca usar erro HTTP bruto como estado normal de produto.

---

# 2. Separar quatro conceitos

Modelar explicitamente:

```text
ENTITLEMENT
→ o plano permite usar

PLATFORM AVAILABILITY
→ o Oria está globalmente configurado para esse provider

TENANT CONFIGURATION
→ a Organization conectou/configurou suas credenciais

CONNECTION HEALTH
→ a conexão foi validada e está operacional
```

Esses quatro conceitos não podem ser confundidos.

---

# 3. Read model semântico

Criar ou reutilizar um read model consistente por integração.

Exemplo conceitual:

```json
{
  "provider": "whatsapp",
  "entitled": true,
  "platformAvailable": true,
  "configured": false,
  "health": "not_checked",
  "status": "not_configured"
}
```

Outro:

```json
{
  "provider": "meta_ads",
  "entitled": true,
  "platformAvailable": false,
  "configured": false,
  "health": "unknown",
  "status": "platform_unavailable"
}
```

Não precisa usar exatamente esse schema.

O objetivo é a UI receber estado semântico em vez de inferir produto a partir de 403/500.

---

# 4. Estados canônicos

Preferir algo equivalente a:

```text
not_entitled
platform_unavailable
not_configured
pending
connected
degraded
error
coming_soon
```

Cada estado deve ter representação visual controlada.

---

# 5. Regra principal de UI

Não:

```text
render card
→ chama endpoint
→ recebe 403
→ mostra "Erro HTTP 403"
```

Sim:

```text
backend resolve entitlement + disponibilidade + configuração + health
→ UI recebe estado semântico
→ UI mostra mensagem adequada
```

Backend continua fail-closed.

---

# 6. Reserva Ink — remover feed da experiência nova

A opção:

```text
feedUrl
URL do feed
Substituir URL do feed
Feed cadastrado
```

não faz parte do Connector Ink canônico.

Foi mecanismo experimental/legado.

Para cliente novo, o setup é:

```text
Token da API
Segredo do webhook
```

somente.

`feedUrl`:

```text
deprecated
não exibido na UI nova
não usado no status
não obrigatório
não usado no runtime novo
```

Se precisar permanecer temporariamente no backend por compatibilidade, manter sem exposição.

---

# 7. Reserva Ink — status

Garantir:

```text
sem apiToken
→ not_configured

apiToken presente
→ pending

apiToken + webhookSecret
→ configured/connected conforme health atual
```

`feedUrl` não participa dessa resolução.

---

# 8. Reserva Ink — endpoint de save

Auditar:

```text
PUT /api/admin/integrations/ink/credenciais
```

Hoje pode aceitar:

```text
apiToken
feedUrl
webhookSecret
```

Para Store nativa, o contrato canônico deve ser:

```text
apiToken
webhookSecret
```

Se `feedUrl` precisar continuar aceito por compatibilidade:

```text
não documentar como parte do contrato novo
não exibir na UI
não usar para status
```

---

# 9. Catálogo/feed/estoque Ink

A seção:

```text
Cache do catálogo de produtos
```

continua fora da productização atual para Store nativa.

Hoje catálogo/feed/estoque ainda estão no caminho legado.

Para Store nativa:

```text
não chamar endpoint legado
não exibir 403
não mostrar "Nenhuma loja conectada"
```

Preferência:

```text
ocultar temporariamente
```

ou mostrar um estado semântico de indisponibilidade futura.

Não productizar catálogo nesta rodada.

---

# 10. Sincronização histórica de pedidos

Auditar separadamente:

```text
Sincronização histórica de pedidos
```

Se já funciona por:

```text
organization_id + store_id
```

pode permanecer.

Se ainda depende de:

```text
loja_legada
```

para Store nativa:

```text
ocultar / marcar indisponível
```

Não apresentar "Nenhuma loja conectada" se a Store está conectada canonicamente.

---

# 11. WhatsApp — corrigir estado contraditório

Hoje aparecem simultaneamente:

```text
Não incluído no plano
API conectada
HTTP 403
```

Isso não pode ser estado válido.

Auditar:

```text
effective entitlement
integration status
platform availability
endpoint authorization
```

Determinar factual e explicitamente qual fonte está errada.

---

# 12. WhatsApp — entitlement

Se:

```text
whatsapp = true
```

no effective entitlement:

não mostrar:

```text
Não incluído no plano
```

Se:

```text
whatsapp = false
```

o frontend não deve chamar endpoints operacionais que retornarão 403.

---

# 13. WhatsApp — distinguir plataforma e tenant

Não confundir:

```text
API/plataforma WhatsApp do Oria disponível
```

com:

```text
WABA/número da Organization configurado
```

Badge "API conectada" precisa ter significado claro ou ser removido.

---

# 14. WhatsApp — UX esperada

Exemplo não configurado:

```text
WhatsApp
Incluído no plano
Não configurado

[Configurar WhatsApp]
```

Exemplo conectado:

```text
WhatsApp
Número conectado: +55 ...
Status: Conectado
```

---

# 15. Número do WhatsApp

O card "Número do WhatsApp" não deve chamar endpoint se:

```text
WhatsApp não está entitled
ou
integração ainda não está configurada
```

Substituir HTTP 403 por estado semântico:

```text
WhatsApp ainda não configurado
```

ou incorporar esse conteúdo no card principal do WhatsApp.

Avaliar se dois cards separados ainda fazem sentido.

---

# 16. Analytics GA4

Hoje aparece:

```text
HTTP 403
```

Implementar estados:

```text
not_entitled
platform_unavailable
not_configured
connected
error
```

Se não entitled:

```text
não chamar endpoint operacional
```

Se OAuth/config global da plataforma não estiver pronta:

```text
platform_unavailable
```

Tenant não vê detalhes internos.

---

# 17. Google Ads

A UI atual expõe:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_OAUTH_REDIRECT_URI
```

Isso é configuração interna do Oria.

NUNCA mostrar esses nomes ao tenant.

Configuração global fica em:

```text
Control Plane
ops
health/readiness interno
```

Tenant deve ver apenas:

```text
Google Ads
Não conectado
[Conectar Google Ads]
```

ou:

```text
Integração temporariamente indisponível
```

---

# 18. Meta Ads

Mesma regra do Google.

Não mostrar ao tenant:

```text
META_APP_ID
META_APP_SECRET
META_OAUTH_REDIRECT_URI
```

Tenant deve ver:

```text
Meta Ads
Não conectado
[Conectar Meta]
```

ou:

```text
Conectado
Conta de anúncios: ...
```

ou:

```text
Integração temporariamente indisponível
```

---

# 19. Meta provider != Meta Ads

Formalizar:

```text
provider Meta
```

é diferente de:

```text
feature Meta Ads
feature Instagram
```

Um provider OAuth pode suportar múltiplas capabilities.

Não misturar entitlement de Meta Ads com Instagram.

---

# 20. OpenAI — BYOK

OpenAI usa BYOK.

Modelo esperado:

```text
creative_generator = true
→ OpenAI aparece como configuração necessária/opcional do módulo
```

UI:

```text
OpenAI
Chave não configurada

[ API key __________________ ]
[ Salvar ]
```

Depois:

```text
Chave configurada · final XXXX
```

Nunca retornar a chave completa.

Se `creative_generator = false`:

```text
não chamar endpoint
não mostrar 403
```

---

# 21. Instagram

Hoje:

```text
Não incluído no plano
Em breve
```

é estado redundante.

Se ainda não existe implementação real:

```text
coming_soon
```

deve ser suficiente.

Não misturar:

```text
not_entitled
```

com:

```text
coming_soon
```

como se fossem a mesma coisa.

---

# 22. Política global de exibição

Definir e aplicar uma regra única.

Sugestão:

```text
entitled + platform available
→ mostrar integração normal

entitled + platform unavailable
→ mostrar indisponível

not entitled
→ ocultar OU mostrar locked

coming soon
→ mostrar somente se fizer sentido comercial
```

Escolher uma estratégia e usar em toda página.

---

# 23. Menu lateral

Auditar visibilidade de:

```text
Analytics GA4
Meta Ads
Google Ads
Gerador de criativos
```

Regra desejada:

```text
feature entitled
→ menu aparece

feature não entitled
→ menu some ou fica locked

feature entitled mas integração não configurada
→ menu aparece e leva a setup
```

Não confundir visibilidade de feature com estado da conexão.

---

# 24. 403 continua correto no backend

Não afrouxar autorização.

Backend continua:

```text
fail-closed
```

A correção é:

```text
frontend conhece entitlement antes de chamar endpoint
+
backend fornece read model semântico
```

Um 403 inesperado continua sendo erro real.

---

# 25. Readiness da plataforma

Criar/reutilizar health interno para:

```text
Meta OAuth
Google OAuth
WhatsApp platform config
```

Tenant não precisa saber qual variável interna falta.

Control Plane pode receber esse diagnóstico.

Se implementar no Admin ampliar demais o escopo:

```text
registrar como dívida
```

---

# 26. Segurança de secrets

Para todas as integrações:

```text
nunca retornar secret completo
nunca logar secret
nunca renderizar secret salvo
mostrar no máximo final XXXX
```

Preservar o secret store existente.

---

# 27. UX de erro

Estados esperados devem usar mensagens semânticas:

```text
Não disponível no seu plano
Ainda não configurado
Integração temporariamente indisponível
Conecte sua conta para continuar
```

Erros reais como:

```text
500
timeout
provider offline
payload inválido
```

podem mostrar:

```text
Não foi possível carregar
[Tentar novamente]
```

sem revelar stack/env/internal details.

---

# 28. Loading/retry

Cada card deve suportar:

```text
loading
loaded
retryable_error
```

Um card quebrado não deve derrubar a página inteira.

---

# 29. Formalizar domínio

Registrar:

```text
Feature
→ unidade comercial

Integration
→ conexão com provider

Platform Readiness
→ Oria preparado globalmente

Tenant Configuration
→ cliente conectou conta/segredo

Connection Health
→ conexão operacional
```

---

# 30. Testes obrigatórios — entitlement

Para cada integração:

```text
entitled=false
```

provar:

```text
frontend não chama endpoint operacional
nenhum 403 esperado aparece na UI
```

---

# 31. Testes obrigatórios — platform unavailable

Exemplo:

```text
Meta feature=true
Meta platform config=false
```

esperado:

```text
platform_unavailable
```

Não:

```text
500
env names
```

---

# 32. Testes obrigatórios — not configured

```text
entitled=true
platformAvailable=true
configured=false
```

esperado:

```text
not_configured
```

---

# 33. Testes obrigatórios — connected

```text
entitled=true
platformAvailable=true
configured=true
health=ok
```

esperado:

```text
connected
```

---

# 34. Negative controls

Criar controles que falhem se:

```text
nomes de env voltarem à UI tenant
403 esperado voltar a ser mostrado como estado
frontend chamar endpoint sem entitlement
feedUrl voltar a ser requisito da Ink
OpenAI sem chave virar erro 403
WhatsApp mostrar simultaneamente not_entitled e connected
```

---

# 35. Integração com a frente Features × Capabilities

Existe uma frente separada alterando:

```text
features
connector capabilities
creative capabilities
internal plan
```

Não conflitar.

Antes de tocar registries/entitlements:

```text
inspecionar branch/worktree da frente de capabilities
```

Se estiver ativa:

```text
NÃO duplicar alterações
NÃO editar o mesmo registry
```

Trabalhar preferencialmente em:

```text
read model
UI
integration status
```

e deixar merge de registry para depois.

---

# 36. Internal plan

Não hardcodar o conteúdo do plano `internal`.

Usar:

```text
effective entitlements
```

como fonte de verdade.

A outra frente pode alterar a composição do plano.

---

# 37. Não fazer

NÃO:

```text
alterar token real da Ink
remover credencial Ink já salva
configurar webhook real automaticamente
importar pedidos automaticamente
importar catálogo
productizar feed
productizar estoque
implementar billing
criar novos planos comerciais
mexer em loja_legada
```

---

# 38. Sequência recomendada

Executar:

```text
1. mapear estado atual de cada card
2. mapear endpoints chamados por cada card
3. mapear entitlement usado por cada card
4. criar/reusar read model semântico
5. corrigir Ink/feed legado
6. corrigir WhatsApp
7. corrigir GA4
8. corrigir Google Ads
9. corrigir Meta Ads
10. corrigir OpenAI
11. corrigir Instagram
12. alinhar menu lateral
13. testes
14. negative controls
15. docs
16. deploy
17. smoke
```

---

# 39. Smoke esperado

Com Tenant #1:

```text
Use Origens
Store = Use Sul
```

validar:

```text
Ink
→ token configurado
→ pending até webhook

WhatsApp
→ estado coerente com effective entitlement
→ sem 403 visual

GA4
→ sem 403 visual

Google Ads
→ sem nomes de env

Meta Ads
→ sem nomes de env

OpenAI
→ BYOK state
→ sem 403 visual

Instagram
→ estado único e coerente
```

---

# 40. Checkpoint final

Retornar:

```text
1. estado anterior de cada integração
2. causa factual de cada 403
3. effective entitlement usado por cada feature
4. novo read model
5. Ink antes/depois
6. WhatsApp antes/depois
7. GA4 antes/depois
8. Google Ads antes/depois
9. Meta Ads antes/depois
10. OpenAI antes/depois
11. Instagram antes/depois
12. menu antes/depois
13. vazamento de env removido
14. estratégia final para feedUrl
15. testes
16. negative controls
17. docs
18. commits
19. CI
20. deploy
21. smoke
22. blockers
23. GO / NO-GO para continuar a configuração real das integrações
```

---

# Estado esperado

```text
Integrações
├── Reserva Ink
│   ├── entitlement
│   ├── token
│   ├── webhook
│   └── health
│
├── WhatsApp
│   ├── entitlement
│   ├── tenant config
│   └── health
│
├── Analytics GA4
│   ├── entitlement
│   ├── platform availability
│   ├── tenant connection
│   └── health
│
├── Google Ads
│   ├── entitlement
│   ├── platform availability
│   ├── OAuth connection
│   └── health
│
├── Meta Ads
│   ├── entitlement
│   ├── platform availability
│   ├── OAuth connection
│   └── health
│
├── OpenAI
│   ├── creative_generator entitlement
│   ├── BYOK
│   └── key status
│
└── Instagram
    └── coming_soon / future implementation
```

A página deve representar estado de produto, não detalhes internos de infraestrutura.
