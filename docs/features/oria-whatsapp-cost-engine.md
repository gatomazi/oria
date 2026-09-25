# ORIA — WhatsApp Cost Engine

## Objetivo

Implementar no Oria um **WhatsApp Cost Engine** responsável por identificar, estimar, registrar, atribuir e exibir o custo de mensagens enviadas pela WhatsApp Business Platform.

A implementação deve considerar a mudança de cobrança da Meta prevista para **01/10/2026**, onde mensagens enviadas pela empresa passam a ter cobrança por mensagem entregue conforme categoria, país e regras vigentes da plataforma.

O objetivo não é criar um módulo contábil complexo.

O objetivo é permitir que o lojista entenda, de forma simples:

- quanto o WhatsApp está custando;
- quais automações geram custo;
- quais automações geram receita;
- qual custo veio de atendimento;
- qual custo veio de mensagens transacionais;
- qual custo veio de marketing;
- quanto determinado fluxo recuperou em vendas;
- quando uma automação está enviando mensagens demais;
- qual é o custo estimado antes de disparar uma campanha;
- qual é o custo real após confirmação de entrega.

A experiência deve ser **user friendly por padrão**.

O usuário NÃO deve precisar configurar dezenas de campos para que o Cost Engine funcione.

A maior parte das informações deve ser descoberta automaticamente pelo sistema.

---

# 1. Princípio de produto

O WhatsApp Cost Engine deve funcionar como uma camada transversal do módulo de WhatsApp.

Ele NÃO deve ser uma ferramenta isolada em que o usuário precisa preencher manualmente:

- categoria da mensagem;
- janela de atendimento;
- custo unitário;
- país;
- moeda;
- tipo de template;
- origem;
- workflow;
- campanha;
- número de mensagens;
- retorno financeiro.

Tudo que puder ser inferido pelo sistema deve ser inferido automaticamente.

A configuração inicial ideal deve exigir, no máximo:

1. conexão da WABA;
2. definição da moeda da conta, caso não seja detectável;
3. eventual confirmação de país/região de cobrança quando necessário.

Depois disso, o motor deve operar automaticamente.

---

# 2. Contexto atual do Oria

O Oria já possui ou terá integração com:

- WhatsApp Business API oficial;
- Meta / WABA;
- tokens por cliente;
- webhooks da INK;
- eventos de pedidos;
- carrinho abandonado;
- PIX pendente;
- produção concluída;
- pedido despachado;
- pedido em trânsito;
- pedido em entrega;
- atendimento humano;
- automações;
- templates oficiais da Meta.

Cada cliente conecta seus próprios ativos da Meta.

A cobrança da Meta deve continuar pertencendo ao cliente.

O Oria deve:

- medir;
- estimar;
- atribuir;
- consolidar;
- explicar;
- otimizar;
- alertar.

O Oria NÃO deve atuar como intermediário financeiro das mensagens neste momento.

---

# 3. Escopo do Engine

Criar um serviço central:

```text
WhatsAppCostEngine
```

Responsável por receber eventos relacionados a mensagens e calcular seu impacto financeiro.

Exemplos de entrada:

```text
message.created
message.sent
message.delivered
message.failed
message.read
template.sent
template.delivered
automation.executed
conversation.started
customer.message_received
order.created
order.paid
cart.recovered
pix.recovered
```

O Cost Engine deve conseguir trabalhar tanto com:

- eventos internos do Oria;
- webhooks oficiais da Meta;
- eventos de automações;
- dados transacionais da loja.

---

# 4. Modelo conceitual

Toda mensagem enviada deve possuir um registro interno de billing.

Exemplo conceitual:

```json
{
  "message_id": "wamid.xxx",
  "workspace_id": "xxx",
  "waba_id": "xxx",
  "phone_number_id": "xxx",

  "direction": "outbound",

  "message_type": "template",
  "template_name": "pedido_despachado",

  "category": "utility",

  "customer_service_window_open": false,

  "country": "BR",
  "currency": "BRL",

  "billable": true,

  "billing_status": "estimated",

  "estimated_unit_cost": 0.035,
  "actual_unit_cost": null,

  "estimated_cost": 0.035,
  "actual_cost": null,

  "automation_id": "order_shipped",
  "campaign_id": null,

  "order_id": "1234",
  "customer_id": "5678",

  "revenue_attributed": null,

  "created_at": "...",
  "sent_at": "...",
  "delivered_at": null
}
```

Não copiar esse schema cegamente.

Adaptar ao padrão arquitetural existente do projeto.

---

# 5. Categorias

O sistema deve suportar pelo menos:

```text
service
utility
authentication
marketing
unknown
```

Nunca assumir silenciosamente uma categoria quando não houver evidência suficiente.

Quando possível, usar:

1. categoria oficial informada pela Meta;
2. categoria do template aprovado;
3. metadados já existentes no sistema;
4. inferência controlada como fallback.

Caso ainda seja impossível determinar:

```text
category = unknown
```

e registrar motivo.

---

# 6. Janela de atendimento

Criar uma camada explícita para determinar:

```text
customer_service_window_open
```

O sistema deve registrar o último evento inbound do cliente.

Conceitualmente:

```text
service_window_started_at
service_window_expires_at
```

Ao receber mensagem do cliente:

```text
service_window_started_at = received_at
service_window_expires_at = received_at + 24h
```

Não espalhar essa lógica por controllers, workers ou handlers.

Centralizar.

Criar algo equivalente a:

```go
type ServiceWindowResolver interface {
    Resolve(ctx context.Context, workspaceID, customerID string, at time.Time) (ServiceWindow, error)
}
```

A implementação concreta deve seguir o padrão atual do projeto.

---

# 7. Pricing Rules

Não hardcodar preços dentro da regra de negócio.

Criar estrutura versionável de pricing.

Exemplo conceitual:

```text
WhatsAppPricingRule
```

Campos esperados:

```text
provider
country
currency
category
effective_from
effective_until

unit_price
free_allowance
pricing_model

source
source_version
updated_at
```

O sistema deve suportar regras com vigência.

Exemplo:

```text
regra A
vigência até 30/09/2026

regra B
vigência a partir de 01/10/2026
```

Isso permitirá que relatórios históricos sejam calculados corretamente.

---

# 8. Fonte de verdade dos preços

Criar abstração para atualizar os preços sem deploy.

Exemplo:

```go
type PricingProvider interface {
    GetPricing(ctx context.Context, req PricingRequest) (PricingResult, error)
}
```

Inicialmente pode existir implementação:

```text
DatabasePricingProvider
```

O painel deve permitir atualização interna/admin das regras.

Não expor uma tabela de configuração complexa para o lojista.

O usuário final deve apenas visualizar os preços efetivos aplicáveis.

---

# 9. Estimated Cost vs Actual Cost

Separar claramente:

```text
estimated_cost
actual_cost
```

Antes da mensagem ser enviada:

```text
billing_status = estimated
```

Após confirmação relevante do provider:

```text
billing_status = confirmed
```

Caso a mensagem falhe e não seja faturável:

```text
billing_status = not_billable
```

Caso não seja possível determinar:

```text
billing_status = pending
```

Nunca apresentar uma estimativa como custo definitivo.

Na UI:

```text
Estimado
Confirmado
```

devem ser visualmente distintos.

---

# 10. Free allowance

O sistema deve suportar franquias gratuitas quando aplicáveis.

Criar ledger mensal por:

```text
workspace
WABA
phone_number
country
billing_period
category
```

Não implementar a lógica como:

```text
if message_count < 1000
```

espalhada pelo código.

Criar entidade/serviço equivalente a:

```text
AllowanceLedger
```

Exemplo:

```json
{
  "workspace_id": "...",
  "billing_period": "2026-10",
  "category": "service",

  "allowance_total": 1000,
  "allowance_used": 843,
  "allowance_remaining": 157
}
```

A regra deve ser versionável porque franquias podem mudar no futuro.

---

# 11. Idempotência

Este ponto é obrigatório.

A Meta pode reenviar webhooks.

Jobs internos podem sofrer retry.

Nunca contabilizar a mesma mensagem duas vezes.

Usar chave idempotente adequada, preferencialmente baseada em:

```text
provider_message_id
event_type
billing_version
```

ou estrutura equivalente.

Criar constraint no banco quando possível.

Exemplo:

```text
UNIQUE(workspace_id, provider_message_id, billing_event_type)
```

A modelagem final deve considerar o banco atual do projeto.

---

# 12. Event processing

Não calcular tudo de forma síncrona no endpoint do webhook.

Fluxo preferencial:

```text
Meta webhook
    ↓
normalize event
    ↓
persist raw/normalized event
    ↓
enqueue processing
    ↓
WhatsAppCostEngine
    ↓
billing ledger
    ↓
aggregates
```

O endpoint deve ser rápido e tolerante a retry.

---

# 13. Billing Ledger

Criar um ledger auditável.

Toda alteração financeira precisa permitir reconstrução histórica.

Entidade conceitual:

```text
WhatsAppBillingEntry
```

Tipos possíveis:

```text
message_estimate
message_charge
message_adjustment
allowance_credit
allowance_consumption
manual_adjustment
```

Campos conceituais:

```text
workspace_id
message_id
automation_id
campaign_id

entry_type

category
country
currency

quantity
unit_price

amount

source
pricing_rule_id

occurred_at
created_at
```

Não depender apenas de valores agregados em uma tabela mensal.

Os agregados devem ser derivados ou atualizados a partir do ledger.

---

# 14. Attribution Engine

Esse é um ponto importante para o valor do produto.

O WhatsApp Cost Engine deve conversar com a camada de atribuição do Oria.

Queremos chegar a métricas como:

```text
Carrinho abandonado
Custo WhatsApp: R$ 22,40
Receita recuperada: R$ 1.870,00
ROAS WhatsApp: 83,48x
```

Outro exemplo:

```text
PIX pendente
Custo: R$ 8,05
PIX recuperados: 13
Receita recuperada: R$ 940,00
```

Outro:

```text
Status de pedido
Custo: R$ 31,15
Receita atribuída: —
Objetivo: operação / suporte
```

Não forçar ROAS para automações que não têm objetivo comercial.

Classificar automações por objetivo:

```text
revenue
transactional
support
marketing
authentication
```

---

# 15. Attribution Window

Criar configuração interna sensata, com defaults.

Exemplo:

```text
abandoned_cart = 24h
pix_recovery = 24h
marketing = 7d
```

Mas não obrigar o lojista a configurar isso no onboarding.

Pode existir configuração avançada futuramente.

---

# 16. Custo por automação

Toda mensagem gerada por automação deve carregar:

```text
automation_id
automation_execution_id
```

Assim podemos calcular:

```text
messages_sent
messages_delivered
billable_messages
cost
orders_recovered
revenue
cost_per_recovered_order
```

Exemplo de tela:

```text
Carrinho abandonado

Mensagens enviadas        1.240
Mensagens faturáveis      1.114
Custo Meta                R$ 38,99
Pedidos recuperados       31
Receita recuperada        R$ 4.216,00
Custo por recuperação     R$ 1,26
```

---

# 17. Custo por campanha

Campanhas manuais e de marketing também devem ter tracking.

Registrar:

```text
campaign_id
campaign_name
```

Dashboard:

```text
Campanha Dia das Mães

Enviadas          3.401
Entregues         3.287
Custo             R$ 286,43
Pedidos           72
Receita           R$ 10.826,00
```

Se ainda não existir attribution confiável:

mostrar:

```text
Receita atribuída ainda não disponível
```

Não inventar números.

---

# 18. Atendimento

Precisamos conseguir separar:

```text
support_human
support_bot
support_ai
```

Toda saída do atendimento deve carregar `sender_type`.

Exemplo:

```json
{
  "sender_type": "ai"
}
```

ou:

```text
human
bot
automation
system
```

Dashboard:

```text
Atendimento

Humano
1.842 mensagens
R$ 64,47

IA
3.921 mensagens
R$ 137,24

Automações
1.114 mensagens
R$ 38,99
```

Isso será importante para detectar chatbots excessivamente verbosos.

---

# 19. Message Bundling / Cost Optimization

Criar recomendações automáticas.

Exemplo:

Detectar:

```text
4 mensagens consecutivas
mesmo destinatário
mesmo workflow
intervalo < 15 segundos
```

Sugerir:

```text
"Essa automação envia em média 4 mensagens por interação.
Agrupar o conteúdo em 1 mensagem poderia reduzir aproximadamente 68% do custo desse fluxo."
```

NÃO alterar mensagens automaticamente sem autorização.

Primeiro gerar recomendação.

---

# 20. Simulador pré-disparo

Antes de campanhas em massa, mostrar estimativa.

Exemplo:

```text
Enviar campanha?

Público
4.812 contatos

Entrega estimada
4.400–4.700

Categoria
Marketing

Custo estimado Meta
R$ 382–R$ 409
```

Usar faixa quando houver incerteza.

CTA:

```text
Enviar campanha
```

O usuário não deve precisar abrir uma calculadora externa.

---

# 21. Dashboard principal

Adicionar uma seção:

```text
WhatsApp
```

Cards principais:

```text
Custo neste mês
Mensagens faturáveis
Mensagens gratuitas
Receita recuperada
Custo / pedido recuperado
```

Exemplo:

```text
WhatsApp — Outubro

Custo Meta
R$ 116,20

Mensagens
4.320

Franquia gratuita
1.000 / 1.000 utilizadas

Receita recuperada
R$ 5.156,00
```

Evitar excesso de cards.

Priorizar informação útil.

---

# 22. Breakdown

Permitir breakdown simples por:

```text
Automação
Categoria
Campanha
Atendimento
Número
Dia
```

Começar com:

```text
Automação
Categoria
Dia
```

Os demais podem entrar depois caso necessário.

---

# 23. Cost Timeline

Criar gráfico diário:

```text
custo WhatsApp por dia
```

Opcionalmente sobrepor:

```text
receita recuperada
```

Não misturar escalas de forma confusa.

Tooltip:

```text
18/10

Custo WhatsApp
R$ 18,44

Receita recuperada
R$ 684,90
```

---

# 24. Automation ranking

Não criar ranking simplista "melhor/pior".

Criar tabela operacional:

```text
Automação | Mensagens | Custo | Receita atribuída | Objetivo
```

Exemplo:

```text
Carrinho abandonado | 1.114 | R$38,99 | R$4.216 | Receita
PIX pendente        |   388 | R$13,58 | R$1.920 | Receita
Pedido despachado   |   842 | R$29,47 | —       | Operação
Em trânsito         |   711 | R$24,89 | —       | Operação
```

---

# 25. Alertas

Criar alertas úteis.

Exemplos:

```text
"Custo do WhatsApp está 34% acima da média dos últimos 30 dias."
```

```text
"A automação 'Carrinho abandonado' aumentou de 1,8 para 3,7 mensagens por execução."
```

```text
"Seu saldo gratuito de mensagens de serviço foi totalmente utilizado."
```

```text
"A automação 'PIX pendente' gastou R$ 42 nos últimos 7 dias e recuperou R$ 0 em pedidos."
```

Não criar urgência falsa.

---

# 26. Cost Guardrails

Criar limite opcional de segurança.

Exemplo:

```text
alert_monthly_cost
```

e futuramente:

```text
hard_monthly_limit
```

Na primeira versão, usar apenas alerta.

Não bloquear operações do cliente silenciosamente.

---

# 27. Feature flags

Adicionar feature flag:

```text
whatsapp_cost_engine
```

Possivelmente também:

```text
whatsapp_cost_engine_dashboard
whatsapp_cost_engine_alerts
whatsapp_cost_engine_simulator
```

Permitir rollout gradual.

---

# 28. Migração

Precisamos pensar em dados anteriores.

Não recalcular histórico inteiro com preços atuais.

Se houver dados suficientes para backfill:

```text
usar pricing_rule válida na data original
```

Caso contrário:

```text
billing_status = unavailable
```

e UI:

```text
Dados de custo disponíveis a partir de DD/MM/AAAA.
```

---

# 29. API

Criar APIs seguindo o padrão atual.

Possíveis endpoints:

```text
GET /api/whatsapp/costs/summary
GET /api/whatsapp/costs/timeline
GET /api/whatsapp/costs/automations
GET /api/whatsapp/costs/categories
GET /api/whatsapp/costs/messages/:id
GET /api/whatsapp/costs/campaigns/:id/estimate
```

Não criar endpoint apenas porque está listado aqui.

Primeiro avaliar os padrões existentes no backend.

Preferir reuse.

---

# 30. Frontend

Seguir o design system existente do Oria.

Reutilizar:

- cards;
- tables;
- badges;
- tooltip;
- tabs;
- dialogs;
- status components.

Evitar criar componentes redundantes.

Possíveis status:

```text
Estimado
Confirmado
Não faturável
Pendente
Indisponível
```

---

# 31. UX — regra essencial

O usuário deve conseguir abrir a página e entender em menos de 10 segundos:

```text
Quanto gastei?
Por que gastei?
O que gerou retorno?
Tem algo fora do normal?
```

Não mostrar conceitos internos da API da Meta sem necessidade.

Exemplo ruim:

```text
CBP service category billing allowance entry
```

Exemplo bom:

```text
Mensagens de atendimento
843 gratuitas de 1.000
```

---

# 32. "Por que fui cobrado?"

Adicionar explicação contextual.

Ao clicar no custo de uma mensagem:

```text
Custo estimado: R$ 0,035

Motivo:
Mensagem enviada pela empresa
Categoria: Serviço
Franquia gratuita já utilizada

Enviada:
21/10/2026 14:22

Origem:
Atendimento com IA
```

Isso reduzirá suporte sobre cobrança.

---

# 33. Detecção de anomalias

Criar base para detectar:

```text
spike de mensagens
spike de custo
loop de automação
duplicação
template disparado repetidamente
```

Exemplo:

```text
Mesmo cliente
mesma automation_execution
> 10 mensagens em 60 segundos
```

Registrar anomaly.

Não bloquear automaticamente na primeira versão.

Gerar alerta.

---

# 34. Observabilidade

Adicionar métricas internas.

Exemplos:

```text
whatsapp_cost_engine_events_total
whatsapp_cost_engine_processing_errors_total
whatsapp_cost_engine_duplicate_events_total
whatsapp_cost_engine_estimated_cost_total
whatsapp_cost_engine_confirmed_cost_total
```

Adicionar logs estruturados com:

```text
workspace_id
waba_id
message_id
automation_id
billing_status
pricing_rule_id
```

Nunca logar conteúdo sensível da mensagem desnecessariamente.

---

# 35. Segurança

Respeitar isolamento multi-tenant.

Toda consulta deve obrigatoriamente filtrar por:

```text
workspace_id
```

ou mecanismo equivalente já utilizado no projeto.

Nunca permitir consulta cross-workspace.

---

# 36. Performance

Não recalcular mês inteiro a cada carregamento do dashboard.

Criar agregados.

Possíveis tabelas:

```text
whatsapp_cost_daily
whatsapp_cost_monthly
whatsapp_cost_by_automation_daily
```

Mas o ledger continua sendo fonte de verdade.

---

# 37. Consistência monetária

Nunca usar `float32` ou `float64` como representação financeira persistida.

Usar:

```text
decimal
```

ou:

```text
integer micros
```

conforme padrão atual.

Exemplo:

```text
0.035 BRL
```

pode ser armazenado como:

```text
35000 micros
```

se essa for a estratégia escolhida.

---

# 38. Timezone

Armazenar timestamps em UTC.

Billing periods e dashboard devem respeitar timezone do workspace.

Exemplo:

```text
America/Sao_Paulo
```

Não usar timezone do servidor como regra de negócio.

---

# 39. Testes obrigatórios

Criar cobertura para:

### Pricing

```text
regra anterior a 01/10
regra posterior a 01/10
mudança de tarifa
país diferente
categoria diferente
```

### Free allowance

```text
mensagem 999
mensagem 1000
mensagem 1001
novo mês
```

### Idempotência

```text
webhook duplicado
retry de worker
evento fora de ordem
```

### Service window

```text
inbound agora
23h59 depois
24h01 depois
```

### Attribution

```text
carrinho recuperado dentro da janela
fora da janela
pedido já atribuído
duplicidade
```

### Currency

```text
BRL
outra moeda
```

### Multi-tenant

```text
workspace A nunca acessa workspace B
```

---

# 40. Rollout

Fazer em fases.

## Fase 1 — Core

Implementar:

```text
pricing rules
service window
billing ledger
idempotência
estimated cost
actual cost
daily/monthly aggregation
```

Sem UI complexa.

---

## Fase 2 — Dashboard

Adicionar:

```text
resumo mensal
breakdown por categoria
breakdown por automação
timeline
```

---

## Fase 3 — Revenue Attribution

Adicionar:

```text
cart recovery
pix recovery
marketing attribution
cost per recovered order
```

---

## Fase 4 — Optimizer

Adicionar:

```text
message bundling detection
cost anomaly alerts
cost per workflow
recommendations
```

---

## Fase 5 — Campaign Simulator

Adicionar:

```text
estimativa pré-disparo
público
categoria
faixa de custo
```

---

# 41. Migration strategy

Antes de criar migrations:

1. inspecionar models existentes;
2. inspecionar tabelas de mensagens;
3. inspecionar tabelas de automação;
4. inspecionar WABA/workspace mapping;
5. inspecionar padrão monetário;
6. inspecionar padrão de jobs;
7. inspecionar event bus;
8. inspecionar retries;
9. inspecionar feature flags.

Evitar duplicar conceitos existentes.

---

# 42. Não fazer

Não:

- hardcodar custo em handlers;
- assumir que toda mensagem custa igual;
- assumir que todos os países têm o mesmo preço;
- misturar estimativa com custo confirmado;
- cobrar duas vezes evento duplicado;
- depender de cron para corrigir tudo;
- criar uma tela cheia de configuração;
- obrigar usuário a escolher categoria manualmente;
- inventar receita atribuída;
- armazenar dinheiro em float;
- recalcular histórico com preço atual;
- espalhar regra de janela de 24h pelo código;
- acoplar billing ao provider de forma impossível de trocar;
- bloquear mensagens automaticamente por custo;
- criar dezenas de cards no dashboard.

---

# 43. Critérios de aceite

Considerar a implementação pronta quando:

### Core

- [ ] cada mensagem outbound possui estado de billing;
- [ ] categoria pode ser determinada ou marcada como unknown;
- [ ] janela de 24h está centralizada;
- [ ] pricing possui vigência;
- [ ] custo estimado é separado de custo confirmado;
- [ ] eventos duplicados não geram custo duplicado;
- [ ] franquia gratuita é controlada via ledger;
- [ ] dinheiro não usa float;
- [ ] multi-tenancy está protegida.

### Dashboard

- [ ] usuário vê custo do mês;
- [ ] usuário vê mensagens faturáveis;
- [ ] usuário vê uso da franquia;
- [ ] usuário vê breakdown por categoria;
- [ ] usuário vê breakdown por automação;
- [ ] usuário consegue entender origem do custo.

### Attribution

- [ ] carrinho recuperado pode receber custo WhatsApp;
- [ ] PIX recuperado pode receber custo WhatsApp;
- [ ] receita atribuída nunca é inventada;
- [ ] custo por pedido recuperado é calculável.

### UX

- [ ] página principal é compreensível sem conhecimento de WABA;
- [ ] não há onboarding com dezenas de campos;
- [ ] informações avançadas ficam em drill-down;
- [ ] custo estimado e confirmado são distinguíveis;
- [ ] alertas são úteis e sem urgência falsa.

---

# 44. Entrega esperada

Antes de implementar, faça uma leitura real do projeto.

Entregue primeiro:

```text
1. Architecture assessment
2. Existing components that can be reused
3. Data model proposal
4. Migration plan
5. Event flow
6. API changes
7. UI changes
8. Rollout plan
9. Risks
10. Files expected to change
```

Depois implemente em incrementos pequenos.

Cada incremento deve:

- compilar;
- possuir testes;
- não quebrar fluxos existentes;
- não introduzir regressões;
- manter compatibilidade com dados atuais.

---

# 45. Resultado final esperado

Ao final, o Oria deve conseguir responder automaticamente:

```text
Quanto meu WhatsApp custou este mês?
```

```text
Qual automação mais consumiu mensagens?
```

```text
Quanto o carrinho abandonado gastou?
```

```text
Quanto ele recuperou em vendas?
```

```text
Quanto cada pedido recuperado me custou?
```

```text
Por que determinada mensagem foi cobrada?
```

```text
Minha IA está enviando mensagens demais?
```

```text
Quanto essa campanha provavelmente custará antes de eu enviar?
```

Tudo isso sem exigir que o lojista entenda a estrutura de cobrança da Meta.
