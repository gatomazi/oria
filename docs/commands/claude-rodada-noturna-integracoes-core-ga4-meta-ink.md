# Rodada Noturna — Integrações Core do Oria

## Objetivo

Executar uma rodada maior, ponta a ponta, para deixar as integrações centrais realmente utilizáveis no dogfooding.

Escopo principal:

```text
1. Google Analytics 4
2. Meta Ads
3. Reserva Ink
```

Resultado desejado:

```text
GA4
→ conectar
→ OAuth/callback
→ selecionar/configurar propriedade
→ status real
→ leitura real
→ UTM/Performance funcionando para Store nativa

Meta Ads
→ conectar
→ OAuth/callback
→ selecionar Business/Ad Account
→ sincronizar gasto real
→ Dashboard e Financeiro consumindo gasto real

Reserva Ink
→ credencial
→ testar conexão
→ webhook
→ pedidos
→ produtos
→ categorias
→ agrupamentos
→ tudo funcionando para Store nativa sem loja_legada
```

Tenant de dogfooding:

```text
Organization = Use Origens
Store = Use Sul
loja_legada = NULL
```

Não preencher `loja_legada` e não criar workaround com `sul`, `centro`, `norte`, nome de loja ou slug legado.

---

## 0. Regra de execução

Esta rodada está aprovada para execução ponta a ponta.

Pode:

```text
investigar
implementar
criar migrations novas
testar
corrigir bugs do escopo
commit
push
CI
merge quando os gates e permissões permitirem
deploy
smoke API/logs
smoke no Claude in Chrome
escritas controladas necessárias à validação
```

Não pedir aprovação a cada etapa.

Pare apenas para:

```text
senha/2FA/challenge que o ambiente não pode submeter
billing/cobrança
ação destrutiva relevante
mudança arquitetural nova de produto
risco de segurança/isolamento
ação externa irreversível fora do escopo
```

Se um OAuth ficar bloqueado por login/2FA, NÃO pare a rodada inteira.

Faça:

```text
registre o blocker
→ continue nas outras integrações
→ retome quando houver sessão autenticada
```

---

## 1. Gate da rodada anterior

Antes de começar, confirme o resultado final do Full Verification da main referente ao último merge/deploy.

Se verde:

```text
continue
```

Se vermelho:

```text
investigue antes de abrir esta rodada
```

---

## 2. Fundação comum de integrações

Auditar o mecanismo comum atual:

```text
integration records
integration_secrets
OAuth state
callbacks
organization_id
store_id
loja
loja_legada
loja_atribuida
provider accounts
external_resource_id
status/read models
jobs de sync
error mapping
UI de Integrações
```

Arquitetura alvo:

```text
Organization
→ Store
→ Integration
→ Provider account/resource
→ encrypted secrets/tokens
→ sync state
```

Identidade canônica:

```text
organization_id + store_id
```

Compatibilidade legada só onde estritamente necessária para dados históricos.

Store nativa nunca deve depender de chave legada.

---

## 3. Estados semânticos comuns

Onde fizer sentido, padronizar:

```text
not_entitled
platform_unavailable
not_configured
pending
connected
connected_with_data
degraded
error
```

Não usar como UX final:

```text
403
409
500
STORE_WITHOUT_LEGACY_KEY
env names
stack trace
JSON bruto
```

---

# BLOCO A — GA4

## 4. Auditar GA4 completo

Mapear:

```text
status
connect
callback
disconnect
token refresh
property/account selection
cache
UTM Performance
jobs
queries
lojaLegadaDoContexto
```

Bug real já reproduzido:

```text
/api/admin/integrations/google-analytics/connect
→ STORE_WITHOUT_LEGACY_KEY
```

Isso deve desaparecer para Store nativa.

## 5. GA4 — OAuth

Productizar:

```text
Tenant Panel
→ Integrações
→ GA4
→ Conectar
→ Google OAuth
→ callback
→ selecionar/confirmar resource
→ retornar ao Oria
→ status conectado
```

Contexto OAuth ligado com segurança a:

```text
organization_id
store_id
provider
```

Usar state anti-CSRF.

Não aceitar Organization/Store arbitrária do browser.

## 6. GA4 — tokens e resources

Credenciais globais do app OAuth são plataforma.

Tokens tenant:

```text
criptografados
organization scoped
store scoped quando aplicável
mascarados
não logados
```

Se houver uma única property/resource inequívoca, pode selecionar automaticamente.

Se houver múltiplas:

```text
mostrar seleção
```

Persistir ID externo real, não nome.

## 7. GA4 — UTM / Performance

O UTM Tracker já funciona para Store nativa.

Agora fazer:

```text
UTM campaign
→ GA4
→ sessions
→ purchases
→ revenue
```

funcionar sem legado.

Migrar cache/queries/jobs relacionados para:

```text
organization_id + store_id
```

## 8. GA4 — Chrome

Após deploy validar:

```text
Integrações
→ GA4
→ Conectar
→ OAuth
→ retorno
→ status
→ UTM Tracker
→ Performance
```

Se Google pedir senha/2FA:

```text
pare só nesse ponto
registre
continue Meta/Ink
```

---

# BLOCO B — META ADS

## 9. Auditar Meta existente

Mapear:

```text
connect
callback
OAuth state
Meta App
Business
Ad Accounts
tokens
scopes
sync
spend
Dashboard
Financeiro
```

Reusar o que estiver correto.

## 10. Modelo Meta

Alvo:

```text
Oria Meta App (global)
→ OAuth
→ Organization
→ Store
→ Business / Ad Account autorizado
→ sync de mídia
```

Credenciais Meta do app são globais da plataforma.

Cliente mantém:

```text
seus assets
sua conta de anúncios
seu billing
```

## 11. OAuth Meta

Implementar/corrigir:

```text
state anti-CSRF
callback
tenant validation
store validation
token storage
token expiry/renewal quando aplicável
cancel flow
error flow
disconnect/revoke
```

Não confiar em IDs arbitrários do browser.

## 12. Scopes

Solicitar apenas os scopes necessários para leitura e sincronização de Meta Ads.

Registrar no checkpoint:

```text
scopes
motivo de cada scope
```

## 13. Business / Ad Account

Depois do OAuth:

```text
listar Businesses
listar Ad Accounts permitidas
```

Se houver múltiplas:

```text
permitir seleção explícita
```

Persistir:

```text
organization_id
store_id
provider
external_account_id
```

Nunca usar:

```text
loja
loja_legada
loja_atribuida
nome da Store
```

como identidade canônica.

## 14. Sync real de mídia

Executar sync controlado.

Validar:

```text
ad account
período
timezone
moeda
spend
organization_id
store_id
external_account_id
```

Idempotência obrigatória.

## 15. Dashboard e Financeiro

Após sync real:

Dashboard deve distinguir:

```text
não conectado
conectado sem dados
conectado com dados
degraded/error
```

Financeiro deve incorporar corretamente o gasto Meta.

Não alterar fórmula financeira sem documentar.

## 16. Limites Meta

Pode:

```text
autorizar OAuth
selecionar Business
selecionar Ad Account
persistir token
sincronizar métricas
ler campanhas/anúncios quando necessário
```

Não pode:

```text
criar campanha
editar campanha
pausar campanha
alterar orçamento
criar anúncio
alterar billing
```

Se houver senha/2FA:

```text
pare só o fluxo Meta
continue GA4 + Ink
```

---

# BLOCO C — RESERVA INK

## 17. Objetivo Ink desta rodada

Deixar o Connector Ink funcional para Store nativa nos fluxos principais.

Escopo obrigatório:

```text
credenciais
teste de conexão
status
webhook
pedidos
produtos
categorias
agrupamentos
```

Fora:

```text
feed legado
estoque productization
Artwork Vault
importação ampla
```

## 18. Credencial Ink

Manter:

```text
token Ink tenant
→ encrypted integration secret
→ organization/store scoped
```

Salvar credencial não deve chamar API desnecessariamente.

Teste de conexão deve ser read-only.

## 19. Feed URL

`feedUrl` não é requisito canônico.

Portanto:

```text
não exigir feedUrl
não usar feedUrl como condição de connected
não bloquear Store nativa por ausência de feed
```

Se ainda estiver em UI nova:

```text
remover/deprecar
```

## 20. Teste de conexão

Validar:

```text
token configurado
→ testar conexão
→ API Ink responde
→ status connected/healthy
```

Erro de autenticação deve virar estado de integração, não erro técnico cru.

## 21. Webhook Ink

Validar/implementar:

```text
configurar webhook
secret
verification
organization/store association
event ingestion
deduplication
idempotency
audit/log
```

Evento recebido deve identificar:

```text
organization_id
store_id
```

sem inferir por chave legada.

## 22. Pedidos Ink

Revalidar:

```text
sync
lista
detalhe
itens
status
tracking quando aplicável
```

Sem regressão do fluxo READY.

## 23. Produtos Ink

Migrar Produtos para Store nativa.

Objetivo:

```text
Produtos
→ carregar
→ listar
→ status de catálogo
```

sem:

```text
lojaLegadaDoContexto()
STORE_WITHOUT_LEGACY_KEY
```

Usar:

```text
organization_id + store_id
```

## 24. Categorias Ink

Productizar Categorias para Store nativa.

Mesmas garantias:

```text
organization_id + store_id
zero dependência obrigatória de loja_legada
```

## 25. Agrupamentos Ink

Productizar Agrupamentos para Store nativa.

Garantir:

```text
tenancy
store scope
idempotência
sem legacy key para Store nativa
```

## 26. Status de catálogo

Corrigir o erro conhecido em:

```text
/produtos/catalogo/status
```

Revisar também:

```text
/produtos/feed/status
```

Se feed estiver deprecated:

```text
não tratá-lo como requisito
não exibir erro como falha da integração
```

## 27. Cache do catálogo

Hoje pode mostrar:

```text
Nenhuma loja conectada
```

mesmo com token Ink.

Corrigir para:

```text
integration + store_id
```

e não `loja_legada`.

## 28. Jobs Ink

Auditar:

```text
sync pedidos
sync catálogo
webhooks
status
```

Todos com contexto explícito:

```text
organization_id
store_id
```

CONTROLE_ESTOQUE pode permanecer deferred, sem ruído e sem UNHANDLED_REJECTION.

## 29. Isolamento Ink

Provar:

```text
Tenant A token não persiste dados em B
Store A não vê pedidos/produtos/categorias/agrupamentos de B
```

---

# 30. UX de Integrações

Depois das três frentes, revisar a página Integrações.

Para GA4, Meta e Ink mostrar:

```text
entitlement
platform readiness
tenant configuration
connection health
next action
```

Sem:

```text
env names
stack
HTTP bruto
legacy terminology
```

---

# 31. Testes obrigatórios

Comuns:

```text
Store nativa com loja_legada = NULL
OAuth state válido/inválido
callback sem sessão
callback cross-tenant
token criptografado
token nunca exposto
status correto
Tenant A/B
Store A/B
jobs com contexto
idempotência
```

GA4:

```text
connect sem loja legada
callback
resource selection
status
UTM Performance
cache por store_id
```

Meta:

```text
connect
callback
Business/Ad Account mapping
spend sync
idempotência
Dashboard
Financeiro
cross-tenant
```

Ink:

```text
save credential
test connection
webhook
orders
products
categories
groupings
catalog status
cache
Store nativa
legacy compatibility
cross-tenant
```

---

# 32. Negative controls

Impedir regressão para:

```text
lojaLegadaDoContexto() no GA4 connect
lojaLegadaDoContexto() no Meta connect
lojaLegadaDoContexto() em Produtos/Categorias/Agrupamentos Ink
OAuth aceitar org/store arbitrária
secret/token em resposta/log
sync cross-tenant
novo write sem store_id nos domínios migrados
```

Não invalidar compatibilidade histórica legítima fora do escopo.

---

# 33. Migrations

Se necessário:

```text
nova migration
forward-only
```

Antes de numerar:

```text
inspecionar sequência real
```

Nunca editar migration aplicada.

Quando houver FK de Store, garantir coerência com Organization.

---

# 34. CI e execução

Sequência recomendada:

```text
testes GA4
testes Meta
testes Ink
tenant isolation
negative controls
build
contracts
suite necessária
Full Verification
```

Não rodar suites concorrentes no mesmo Postgres.

Pode dividir commits por domínio se ajudar.

---

# 35. Merge e deploy

Se gates verdes:

```text
merge
deploy
```

Se o harness bloquear merge por review:

```text
não contornar
deixar PR pronto
continuar tudo que puder
```

---

# 36. Claude in Chrome obrigatório

Depois do deploy validar:

```text
Integrações
GA4
Meta Ads
Dashboard
Financeiro
UTM Tracker
Pedidos
Produtos
Categorias
Agrupamentos
```

Confirmar:

```text
carrega
estado correto
CTA correto
sem erro técnico
sem loading infinito
dados reais quando aplicável
```

---

# 37. Login

Se exigir senha/2FA e o ambiente não puder submeter:

```text
pare só aquele fluxo
registre onde parou
continue o restante
```

Não pedir senha.
Não registrar credenciais.

---

# 38. Escritas controladas permitidas

Pode:

```text
conectar integração
persistir account/property/ad account
configurar webhook
sincronizar dados
criar/remover registro de teste claramente identificado
```

Limpar resíduos ao final.

---

# 39. Não executar

Não:

```text
criar/editar campanha paga
alterar orçamento Meta
alterar billing
enviar WhatsApp em massa
reembolso real
troca real
productizar Estoque
reativar feed legado
iniciar Artwork Vault
```

---

# 40. Critério de fechamento — GA4

Ideal:

```text
GA4 OAuth completo
Store nativa conectada
property/resource associado
status conectado
UTM Performance funcionando
```

Se login externo impedir:

```text
infraestrutura + testes + deploy prontos
blocker documentado no ponto exato
```

---

# 41. Critério de fechamento — Meta

Ideal:

```text
Meta OAuth completo
Ad Account real conectada
store_id persistido
sync real
Dashboard reconhece mídia
Financeiro incorpora gasto
```

Se login/2FA impedir:

```text
infraestrutura pronta
testes verdes
UI pronta
blocker externo documentado
```

---

# 42. Critério de fechamento — Ink

Obrigatório levar o máximo possível até:

```text
credencial Ink reconhecida
teste de conexão funcionando
webhook funcionando/configurável
Pedidos READY
Produtos READY
Categorias READY
Agrupamentos READY
status do catálogo correto
Store nativa
loja_legada = NULL
```

Feed e Estoque podem permanecer fora.

---

# 43. Matriz de dogfooding final

Atualizar:

```text
Dashboard
Pedidos
Clientes
Financeiro
Despesas
UTM
GA4
Meta Ads
Ink
Produtos
Categorias
Agrupamentos
Integrações
```

Classificar:

```text
READY
READY WITH POLISH
BLOCKED
DEFERRED
```

---

# 44. Checkpoint final da madrugada

Entregar:

```text
GERAL
- main inicial
- branch
- commits
- migrations
- CI
- Full Verification
- merge
- deploy
- erros encontrados/corrigidos

GA4
- arquitetura anterior
- mudanças
- OAuth
- callback
- scopes
- resource selecionado
- token/storage
- UTM Performance
- smoke Chrome
- blocker, se houver

META ADS
- arquitetura anterior
- mudanças
- OAuth
- callback
- scopes
- Business
- Ad Account
- token/storage
- sync
- gasto real
- Dashboard
- Financeiro
- smoke Chrome
- blocker, se houver

INK
- credential
- test connection
- webhook
- orders
- products
- categories
- groupings
- catalog status
- cache
- jobs
- tenant isolation
- smoke Chrome

SEGURANÇA
- secrets
- tenant isolation
- negative controls
- resíduos em produção

DOGFOODING
- matriz atualizada
- READY
- BLOCKED
- DEFERRED
- top blockers restantes
- GO/NO-GO geral
```

---

# 45. Regra final

Não parar cedo porque uma integração encontrou bloqueio externo.

Prioridade:

```text
maximizar trabalho concluído com segurança
```

Se GA4 parar em login:

```text
continue Meta + Ink
```

Se Meta parar em 2FA:

```text
continue GA4 + Ink
```

Ink deve ser levado o mais longe possível sem depender de nova ação manual.

Ao finalizar:

```text
pare no checkpoint
```

Não iniciar Recuperação, Promoções, Campanhas, Trocas, Estoque ou Artwork Vault automaticamente.
