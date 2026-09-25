# Refino de produto — separar Features comerciais de Connector Capabilities

## Contexto

Durante o dogfood do Tenant #1 ficou claro que o catálogo atual de features está misturando conceitos diferentes.

Hoje o plano `internal` mostra como features:

```text
WhatsApp
Instagram
Automações avançadas
Catálogo
Trocas
Reembolsos
Financeiro
Gerador de criativos
Criativos · ângulos limpos
Criativos · remarketing
Criativos · funil visual
Criativos · multiproduto
```

Mas `Catálogo`, `Trocas` e `Reembolsos` hoje são fortemente dependentes do que a Reserva Ink disponibiliza.

Isso cria confusão entre:

```text
FEATURE / ENTITLEMENT
= capacidade comercial do Oria

CONNECTOR
= integração com um provider externo

CONNECTOR CAPABILITY
= o que aquela integração consegue fornecer

PERMISSÃO
= o que determinado usuário pode fazer
```

Esta rodada deve corrigir essa modelagem antes de criarmos planos comerciais reais.

---

# 1. Objetivo

Separar claramente:

```text
PLAN
→ vende capacidades do produto Oria

CONNECTOR
→ conecta um provider externo

CONNECTOR CAPABILITY
→ descreve o que aquele provider consegue sincronizar/operar

USER PERMISSION
→ controla ações por papel
```

Não usar feature comercial como espelho direto da API da Reserva Ink.

---

# 2. Regra de classificação

Para cada item atual do feature registry, aplicar esta pergunta:

```text
"Se amanhã o Oria trocar a Reserva Ink por outro fornecedor,
essa funcionalidade continua existindo como capacidade do Oria?"
```

Se:

```text
SIM
→ provavelmente feature comercial

NÃO / DEPENDE diretamente da API do provider
→ connector capability
```

Registrar a classificação explicitamente.

---

# 3. Features comerciais que devem permanecer

Manter como features do plano, salvo incompatibilidade factual encontrada no código:

```text
whatsapp
instagram
advancedAutomations

meta_ads
google_ads
analytics_ga4

financial

creative_generator
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

Essas representam capacidades do produto, não apenas espelhos de um provider.

---

# 4. Financeiro

`financial` continua como feature comercial.

Justificativa:

```text
Financeiro do Oria
= vendas
- custo de produção
- mídia
- despesas
- reembolsos
= resultado operacional
```

Mesmo que parte dos dados venha da Ink, o módulo é do Oria.

Não transformar `financial` em capability da Ink.

---

# 5. Catálogo

Auditar a implementação real de:

```text
catalog
```

Se hoje ele significa principalmente:

```text
ler/sincronizar catálogo/produtos da Reserva Ink
```

remover do plano como feature comercial e mover para capability do Connector Ink.

Se houver lógica real de catálogo independente do provider:

```text
catálogo próprio do Oria
produto canônico
sincronização com múltiplos providers
```

então manter como feature.

Não decidir por nome; decidir pelo comportamento real do código.

---

# 6. Trocas

Auditar:

```text
exchanges
```

Se hoje significa apenas:

```text
espelhar / executar fluxo suportado pela Ink
```

mover para Connector Capability.

Se o Oria já possui workflow próprio de troca independente de provider:

```text
solicitação
status
políticas
regras
histórico
```

então manter como feature.

---

# 7. Reembolsos

Auditar:

```text
refunds
```

Mesma regra.

Se for apenas:

```text
estado/operação vinda da Ink
```

→ capability do connector.

Se houver domínio próprio do Oria:

```text
workflow de reembolso
motivo
aprovação
financeiro
auditoria
```

→ feature comercial.

---

# 8. Reserva Ink como Connector

Criar/reusar conceito explícito:

```text
Connector
Reserva Ink
```

O connector pode expor capabilities como:

```text
orders
products
catalog_sync
inventory
production
shipping
tracking
exchanges
refunds
webhooks
product_import
```

Usar nomes compatíveis com o código existente.

Não inventar capabilities não suportadas pela API real.

---

# 9. Connector Capability Registry

Criar um registry canônico separado do feature registry.

Exemplo conceitual:

```text
connector_capabilities
```

ou registry em código, se isso for mais coerente com a arquitetura.

Para Ink:

```text
ink.orders
ink.products
ink.inventory
ink.production
ink.shipping
ink.tracking
ink.exchanges
ink.refunds
ink.webhooks
ink.product_import
```

Não precisa ser tabela se um registry code-defined for suficiente.

---

# 10. Provider != capability != feature

Exemplo correto:

```text
Provider:
Reserva Ink

Capabilities:
- orders
- products
- inventory
- exchanges
- refunds
```

Isso é diferente de:

```text
Feature:
financial
```

que usa dados de:

```text
Ink + Meta + GA4 + despesas internas
```

---

# 11. UI do plano

A tela de criação/edição de plano deve mostrar apenas features comerciais.

Alvo conceitual:

```text
COMUNICAÇÃO
WhatsApp
Instagram
Automações avançadas

MARKETING & DADOS
Meta Ads
Google Ads
Analytics GA4

FINANCEIRO
Financeiro

CRIATIVOS
Gerador de criativos
Criativos · ângulos limpos
Criativos · remarketing
Criativos · funil visual
Criativos · multiproduto
```

Não mostrar Connector Capabilities como checkbox de plano.

---

# 12. Tela de Connector Ink

Na UI de Integrações, a Reserva Ink deve poder mostrar:

```text
Reserva Ink

Status
Não conectado / Conectado

Capabilities suportadas
✓ Pedidos
✓ Produtos
✓ Estoque
✓ Produção
✓ Rastreio
✓ Trocas
✓ Reembolsos
✓ Webhooks
✓ Importação de produtos
```

Somente exibir as capabilities realmente suportadas pelo código/API.

---

# 13. Conexão vs entitlement

Se a Reserva Ink estiver disponível como connector técnico para todos:

```text
não precisa de feature "ink"
```

Se futuramente quiser comercializar connectors por plano:

```text
criar feature comercial separada
ex.: connector_ink
```

mas NÃO fazer isso nesta rodada sem decisão comercial.

---

# 14. Onboarding

O onboarding deve separar:

```text
capacidade comercial
```

de:

```text
conexão técnica
```

Exemplo:

```text
Financeiro habilitado no plano
→ ainda pode funcionar parcialmente sem Ink
→ completa dados quando connector Ink/Meta/etc. está conectado
```

Não marcar uma Organization como sem feature apenas porque um connector está ausente.

---

# 15. Ink continua opcional

Reserva Ink não é obrigatória para o produto Oria.

Manter:

```text
Ink = integração opcional
```

Não transformar o SaaS em produto acoplado à Ink.

---

# 16. Produtos e importação

A preocupação com exposição de estampas aparece principalmente na:

```text
importação/sincronização de produtos
```

Portanto registrar, sem implementar nesta rodada:

```text
Future Feature:
Artwork Vault / Protected Artwork
```

Relacionada ao:

```text
Connector Ink → product_import
```

---

# 17. Artwork Vault — registrar dívida

Criar documento de arquitetura futura, por exemplo:

```text
docs/productization/artwork-vault.md
```

Conceito:

```text
MASTER ASSET
→ original privado

PREVIEW ASSET
→ visualização protegida

PRODUCTION ASSET
→ arquivo fechado/temporário para produção
```

Objetivos futuros:

```text
storage privado
URLs assinadas
expiração
auditoria de acesso
controle por papel
cópia de produção por pedido
fingerprint/rastreabilidade
```

Não implementar ainda.

---

# 18. Não prometer DRM

Na documentação futura, deixar explícito:

```text
o arquivo precisa chegar ao provider para produção
```

Logo:

```text
proteção reduz exposição
não garante impossibilidade absoluta de cópia
```

Não vender como DRM infalível.

---

# 19. Internal plan

O `internal` deve refletir apenas features comerciais.

Se após a auditoria:

```text
catalog
exchanges
refunds
```

forem reclassificados como connector capabilities, removê-los do plano `internal`.

Mas:

```text
NÃO remover funcionalidade real do Tenant #1.
```

A UI e backend devem continuar mostrando/operando essas áreas quando o Connector Ink as disponibilizar.

Ou seja:

```text
capability do connector
≠ entitlement comercial
```

---

# 20. Migração sem regressão

Se remover features do registry:

```text
catalog
exchanges
refunds
```

e elas já existem em:

```text
plan_features
organization overrides
tenant1 baseline
tests
```

não simplesmente deletar sem estratégia.

Fazer migration/compat layer segura.

Preferência:

```text
1. introduzir connector capabilities
2. migrar checks de runtime
3. atualizar plano
4. remover feature antiga só depois que não houver dependência
```

---

# 21. Não quebrar rotas existentes

Rotas de:

```text
Produtos
Trocas
Reembolsos
```

não devem sumir apenas porque deixaram de ser features de plano.

O acesso deve passar a depender de:

```text
connector disponível
+ capability suportada
+ integração configurada
```

quando apropriado.

---

# 22. Estados de UI

Exemplo:

```text
Trocas
```

Se Connector Ink conectado e capability exchanges:

```text
→ módulo disponível
```

Se Connector Ink não conectado:

```text
→ estado "Conecte a Reserva Ink para usar este módulo"
```

Não:

```text
403 genérico
```

Se connector conectado, mas provider não suporta capability:

```text
→ indisponível para este connector
```

---

# 23. Reembolsos e Financeiro

Mesmo que `refunds` vire capability do Ink:

```text
financial
```

continua feature.

O módulo financeiro pode consumir:

```text
refund events/data
```

do connector, sem transformar reembolso em feature comercial.

---

# 24. Catálogo e Criativos

Se `catalog` virar connector capability, isso NÃO deve bloquear:

```text
creative_generator
```

O Gerador de Criativos é feature independente.

Pode usar:

```text
produtos sincronizados
```

quando disponíveis, mas não deve se tornar semanticamente "feature da Ink".

---

# 25. User Permissions

Não misturar esta rodada com RBAC de tenant.

Exemplo:

```text
feature financial = comprada

owner/member permission
= pode editar/ver
```

São eixos diferentes.

Não tentar resolver permissões junto com connector capabilities.

---

# 26. Testes de classificação

Adicionar testes que provem a separação.

Exemplo:

```text
financial
→ feature válida

meta_ads
→ feature válida

google_ads
→ feature válida

analytics_ga4
→ feature válida

creative_generator
→ feature válida
```

E, se reclassificados:

```text
catalog
→ não é feature comercial

exchanges
→ não é feature comercial

refunds
→ não é feature comercial
```

---

# 27. Testes Connector Ink

Cobrir:

```text
Ink desconectado
→ capabilities existem no registry
→ mas não estão disponíveis operacionalmente

Ink conectado
→ capabilities suportadas ficam disponíveis
```

Sem secret:

```text
não consulta provider
```

---

# 28. Negative controls

Provar que testes falham se:

```text
connector capability voltar a aparecer como feature de plano
Ink desconectado retornar 403 genérico
feature financial depender diretamente de Ink
feature creative_generator depender diretamente de Ink
```

---

# 29. Control Plane

Atualizar:

```text
Criar plano
Editar plano
Detalhe do plano
Detalhe da Organization
```

para não mostrar connector capabilities como feature comercial.

---

# 30. Tenant Panel

Atualizar menus/guards, se necessário, para:

```text
Produtos
Trocas
Reembolsos
```

usarem estado do Connector Ink/capability em vez de entitlement comercial.

Não remover menu sem revisar UX.

---

# 31. Integrações

Na tela de integração Ink, mostrar claramente:

```text
o que será habilitado depois da conexão
```

Exemplo:

```text
Ao conectar Reserva Ink, o Oria poderá acessar:

• Pedidos
• Produtos
• Estoque
• Produção
• Rastreamento
• Trocas
• Reembolsos
```

Somente capabilities verdadeiras.

---

# 32. Connector read model

Preferir um read model equivalente a:

```json
{
  "provider": "ink",
  "connected": true,
  "capabilities": [
    "orders",
    "products",
    "inventory",
    "exchanges",
    "refunds"
  ]
}
```

Não precisa usar exatamente esse schema.

---

# 33. Futuro multi-provider

Preparar sem implementar providers novos.

O modelo deve permitir no futuro:

```text
Reserva Ink
Printful
Printify
provider próprio
```

cada um com capabilities diferentes.

Não hardcodar:

```text
if provider == ink então produtos existem
```

onde um registry resolveria melhor.

---

# 34. Feature naming

Manter keys comerciais estáveis.

Preferência:

```text
whatsapp
instagram
advancedAutomations
meta_ads
google_ads
analytics_ga4
financial
creative_generator
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

Se `catalog`, `exchanges`, `refunds` forem removidos do registry comercial:

```text
não reutilizar as mesmas keys para capabilities
```

Preferir namespace/provider:

```text
ink.products
ink.exchanges
ink.refunds
```

ou equivalente.

---

# 35. Docs

Criar/atualizar:

```text
docs/architecture/features-vs-connectors.md
docs/architecture/control-plane.md
docs/productization/platform-admin-phase.md
docs/productization/artwork-vault.md
docs/operations/connector-ink.md
```

Adicionar matriz:

```text
ITEM                     TIPO
---------------------------------------
WhatsApp                 Feature
Instagram                Feature
Meta Ads                 Feature
Google Ads               Feature
Analytics GA4            Feature
Financeiro               Feature
Gerador de criativos     Feature

Reserva Ink              Connector
Pedidos Ink              Connector Capability
Produtos Ink             Connector Capability
Estoque Ink              Connector Capability
Trocas Ink               Connector Capability
Reembolsos Ink           Connector Capability
Importação Ink           Connector Capability
```

---

# 36. Não fazer

NÃO:

```text
conectar Ink de verdade
mexer em credenciais reais
trocar webhook
importar produtos
importar estampas
implementar Artwork Vault
criar pricing
criar Stripe/billing
ligar SECOND_TENANT_ENABLED
criar multi-store
```

---

# 37. Sequência

Executar:

```text
1. auditar catalog/exchanges/refunds no código
2. classificar cada um com evidência
3. criar connector capability registry
4. migrar runtime checks
5. ajustar internal plan
6. ajustar tenant1 baseline
7. ajustar Control Plane UI
8. ajustar Tenant Panel states
9. atualizar integração Ink
10. testes
11. negative controls
12. docs
13. deploy
14. smoke read-only
```

---

# 38. Checkpoint final

Retornar:

```text
1. classificação final de catalog
2. classificação final de exchanges
3. classificação final de refunds
4. features comerciais finais
5. connector capabilities finais
6. internal plan antes/depois
7. tenant1 baseline antes/depois
8. migration strategy
9. runtime guards alterados
10. UI do plano
11. UI da integração Ink
12. estados do Tenant Panel
13. testes
14. negative controls
15. docs
16. Artwork Vault debt
17. commits
18. deploy
19. smoke
20. blockers
21. GO / NO-GO para continuar a conexão real da Reserva Ink
```

---

# Estado esperado

```text
PLAN
→ capacidades comerciais do Oria

CONNECTOR
→ provider externo

CONNECTOR CAPABILITY
→ o que aquele provider suporta

Reserva Ink
├── orders
├── products
├── inventory
├── production
├── shipping
├── tracking
├── exchanges
├── refunds
├── webhooks
└── product_import

Financeiro
→ continua feature do Oria

Criativos
→ continuam features do Oria

Artwork Vault
→ registrado para futuro
→ ligado à proteção de assets/importação
→ não implementado agora
