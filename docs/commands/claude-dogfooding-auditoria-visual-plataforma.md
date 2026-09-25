# Dogfooding Oria — auditoria visual e funcional com Claude in Chrome

## Contexto

A base técnica principal já está pronta para retomarmos o dogfooding:

```text
auth / tenancy
subscriptions
entitlements canônicos
Control Plane
Reserva Ink — credencial
Reserva Ink — pedidos
WhatsApp
Financeiro
Gerador de Criativos
Meta Ads
Google Ads
Analytics GA4
```

Ainda existem áreas parcialmente legadas ou em productização:

```text
Produtos
Categorias
Agrupamentos
Estoque
Feed
Artwork Vault
```

O objetivo desta rodada NÃO é abrir novas features.

O objetivo é:

```text
usar o Oria como cliente
percorrer a plataforma inteira
identificar páginas quebradas/incompletas/confusas
classificar prioridade
corrigir primeiro o que bloqueia dogfooding
```

Pode usar **Claude in Chrome** para fazer a auditoria visual e funcional.

---

# 1. Objetivo principal

Percorrer o Tenant Panel e o Control Plane como usuário real.

Para cada página, responder:

```text
1. abre?
2. carrega sem erro?
3. estado vazio faz sentido?
4. entitlement está correto?
5. integração não configurada é tratada como estado normal?
6. há 403/404/500/502 visível?
7. há texto técnico/env/internal details?
8. há dependência de legado?
9. a próxima ação do usuário está clara?
10. está pronta para dogfooding?
```

---

# 2. Claude in Chrome

Está autorizado a usar Claude in Chrome para:

```text
navegar
clicar
abrir menus
abrir páginas
validar estados
validar formulários
validar empty states
validar badges
validar loading/error states
inspecionar fluxos read-only
```

Pode usar DevTools/network se disponível para identificar:

```text
endpoint
status HTTP
payload
erro
```

---

# 3. Limites de segurança

NÃO:

```text
deletar dados reais
arquivar plano
suspender Organization
revogar owner
remover integração
trocar token Ink
trocar webhook real
enviar campanhas
enviar mensagens reais
importar catálogo
sincronizar estoque
executar reembolso
executar troca
alterar billing
criar dados destrutivos
```

Ações mutativas só quando forem seguras, necessárias para validar dogfooding e explicitamente autorizadas.

---

# 4. Pode realizar ações seguras

Permitido:

```text
navegar
filtrar
buscar
abrir detalhes
trocar tabs
abrir dialogs sem confirmar
usar retry
testar conexão read-only quando já existe endpoint seguro
```

Não salvar novas credenciais sem autorização adicional.

---

# 5. Fonte da verdade

Testar produção atual.

Tenant principal:

```text
Organization = Use Origens
Store = Use Sul
```

Não criar Organization extra.

Não alterar:

```text
loja_legada = NULL
```

---

# 6. Ordem de auditoria — Tenant Panel

## 6.1 Visão geral / Dashboard

Validar:

```text
carregamento
cards
métricas
empty states
erros
links
menu
nome da Organization
nome do produto Oria
```

Classificar:

```text
READY
READY WITH POLISH
BLOCKED
HIDDEN/DEFERRED
```

## 6.2 Pedidos

Validar:

```text
lista
filtros
busca
paginação
status
detalhe
itens
cliente
timeline
tracking
ações disponíveis
```

Confirmar que dados Ink carregados aparecem corretamente.

Não executar ação destrutiva.

## 6.3 Clientes

Validar:

```text
lista
busca
detalhe
dados provenientes de pedidos
empty states
```

## 6.4 Trocas e devoluções

Validar:

```text
acesso
entitlement
estado vazio
dependência da Ink
mensagens
```

Como `exchanges` ainda está em compatibilidade:

```text
registrar se runtime ainda depende de legado
```

Não disparar troca real.

## 6.5 Reembolsos

Validar:

```text
acesso
entitlement
estado
dependência Ink
erro técnico
```

Não executar reembolso.

## 6.6 Financeiro

Validar:

```text
dashboard
receitas
custos
despesas
reembolsos
custo de mídia
lucro
empty states
```

Distinguir `sem dados` de `erro de integração`.

Nenhum `403` esperado deve aparecer visualmente.

## 6.7 Produtos

Validar e registrar apenas.

Sabemos que existe dívida:

```text
STORE_WITHOUT_LEGACY_KEY
```

Não corrigir ainda sem checkpoint.

Capturar:

```text
rota
endpoint
erro
status HTTP
stack/log correlacionado
```

Classificar:

```text
BLOCKED — Catálogo Ink
```

## 6.8 Categorias

Mesma abordagem.

Registrar:

```text
erro
endpoint
dependência loja_legada
```

Não corrigir ainda.

## 6.9 Agrupamentos

Mesma abordagem.

## 6.10 Estoque

Validar visualmente.

Sabemos que ainda pode estar no caminho legado.

Não productizar nesta rodada.

Apenas classificar.

## 6.11 Promoções / Campanhas

Validar:

```text
lista
criação sem salvar
filtros
segmentos
status
empty states
```

Não disparar campanha real.

## 6.12 Segmentos

Validar:

```text
lista
criação
filtros
preview
dependências
```

Não enviar mensagens/campanhas.

## 6.13 WhatsApp

Validar:

```text
status
entitlement
configuração
número
templates
automations
recuperação
PIX
canal
```

Distinguir:

```text
platform available
tenant configured
health
```

Não enviar mensagem real.

## 6.14 Templates WhatsApp

Validar:

```text
lista
estado vazio
sincronização
erros
```

Não criar/enviar template real se depender de Meta.

## 6.15 Recuperação / PIX / Automações

Validar:

```text
acesso
configuração
empty state
entitlement
erros técnicos
```

Não disparar automação real.

## 6.16 Analytics GA4

Validar:

```text
entitlement
platform availability
tenant connection
CTA
error states
```

Não mostrar:

```text
env names
stack
HTTP 403 bruto
```

## 6.17 Meta Ads

Validar:

```text
entitlement
platform readiness
OAuth CTA
estado não conectado
```

Não conectar conta real sem autorização.

## 6.18 Google Ads

Mesma regra.

## 6.19 Gerador de Criativos

Validar:

```text
acesso por creative_generator
OpenAI BYOK state
modos disponíveis
CLEAN_ANGLES
REMARKETING
FUNNEL_VISUAL
MULTI_PRODUCT se aplicável
```

Não consumir API paga desnecessariamente.

Pode abrir formulários e confirmar que UI está funcional.

## 6.20 OpenAI / BYOK

Validar:

```text
não configurado
configurado
mascaramento
CTA
erro
```

Nunca exibir secret completo.

Não substituir chave real.

## 6.21 UTM Tracker

Validar:

```text
página
lista
filtros
dados
empty states
```

## 6.22 Simular frete

Validar UI e fluxo sem finalizar efeitos externos indevidos.

## 6.23 Campos personalizados

Validar:

```text
lista
criação sem confirmar se destrutiva
edição
empty states
```

## 6.24 Webhooks e logs

Validar:

```text
lista
filtros
status
detalhes
segredos mascarados
```

Não expor tokens.

## 6.25 Integrações

Fazer auditoria completa:

```text
Ink
WhatsApp
GA4
Google Ads
Meta Ads
OpenAI
Instagram
```

Para cada card:

```text
entitlement
platform availability
tenant configuration
health
próxima ação
```

Nenhum erro HTTP bruto deve representar estado normal.

## 6.26 Configurações

Validar:

```text
Organization
Store
usuário
preferências
segurança
```

Sem alterar dados críticos.

---

# 7. Ordem de auditoria — Control Plane

## 7.1 Dashboard

Validar:

```text
métricas
cards
status
links
```

## 7.2 Organizations

Validar:

```text
lista
busca
detalhe
status
store
owner
subscription
entitlements
integration status
```

## 7.3 Planos

Validar:

```text
internal
features comerciais
capabilities não aparecem como features
```

Esperado:

```text
whatsapp
financial
creative_generator
meta_ads
google_ads
analytics_ga4
```

Compatibility keys podem existir tecnicamente, mas não devem poluir a UI comercial.

## 7.4 Features / entitlements

Validar:

```text
registry
display names
grupo
effective entitlements
overrides
```

## 7.5 Users / invites

Validar:

```text
lista
invite state
reissue
revoked
expired
```

Não criar convite novo sem necessidade.

## 7.6 Integration readiness

Se existir:

```text
Meta
Google
WhatsApp
Ink
```

validar.

Se não existir:

```text
registrar dívida
```

## 7.7 Audit

Validar:

```text
lista
filtros
actor
Organization
action
timestamps
```

---

# 8. Classificação por página

Para cada página produzir:

```text
READY
→ pode ser usada no dogfooding agora

READY WITH POLISH
→ funciona, mas UX precisa melhorar

BLOCKED
→ não dá para usar

HIDDEN/DEFERRED
→ intencionalmente fora do escopo atual
```

---

# 9. Severidade

Cada problema:

```text
P0
→ risco de segurança, isolamento, perda/corrupção de dados

P1
→ bloqueia dogfooding de fluxo principal

P2
→ fluxo funciona, UX ruim/confusa

P3
→ polish/visual/copy
```

---

# 10. Não corrigir tudo durante a auditoria

Primeiro percorrer e mapear.

Pode corrigir imediatamente somente:

```text
P0
ou
bug trivial e isolado sem conflito
```

Para P1/P2/P3:

```text
registrar
agrupar por domínio
retornar checkpoint
```

Não abrir 20 frentes ao mesmo tempo.

---

# 11. Evidência por problema

Registrar:

```text
página
URL
ação
resultado esperado
resultado atual
HTTP status
endpoint
log relacionado
se reproduzível
se depende de legado
```

Screenshots podem ser usados quando úteis.

---

# 12. Dogfooding readiness matrix

Entregar matriz:

```text
Área                  Estado            Prioridade
----------------------------------------------------
Dashboard              READY
Pedidos                READY
Clientes               ...
WhatsApp               ...
Financeiro             ...
Criativos              ...
Meta Ads               ...
Google Ads             ...
GA4                     ...
Produtos                BLOCKED          P1
Categorias              BLOCKED          P1
Agrupamentos            BLOCKED          P1
Estoque                 DEFERRED
...
```

---

# 13. Primeira fila de correções

Depois da auditoria, sugerir no máximo:

```text
3 a 5 correções
```

para a próxima rodada.

Prioridade:

```text
P0
→ P1
→ P2
```

Não priorizar polish enquanto existir blocker funcional.

---

# 14. Não tocar em áreas conhecidas sem autorização

Não iniciar:

```text
Catálogo Ink productization
Estoque productization
Feed
Artwork Vault
creative_* cleanup
catalog/exchanges/refunds cleanup
```

A menos que o checkpoint conclua que uma delas é a próxima prioridade e o usuário aprove.

---

# 15. Navegação autenticada

Se Chrome abrir tela de login:

```text
pare
informe que precisa de sessão autenticada
```

Se já houver sessão autenticada:

```text
pode continuar automaticamente
```

Não pedir senha.
Não tentar recuperar credenciais.
Não armazenar credenciais.

---

# 16. Logs e API

Para qualquer erro visual:

```text
correlacionar com API/logs
```

quando possível.

Não concluir causa apenas pela UI.

---

# 17. Não confiar em status code isolado

Exemplo:

```text
403
```

pode ser:

```text
entitlement
auth
capability
tenant isolation
```

Diagnosticar a origem factual.

---

# 18. CI durante esta rodada

Não precisa rodar suíte completa apenas para auditoria.

Se houver correção pontual:

```text
teste direcionado
```

e só depois, se necessário:

```text
suite maior
```

Evitar gastar 25+ minutos por observação visual.

---

# 19. Resultado desejado

Ao final quero saber:

```text
o que posso dogfoodar hoje
o que quebra
o que está só feio
o que está propositalmente adiado
qual é a próxima rodada mais valiosa
```

---

# 20. Checkpoint final

Retornar:

```text
DOGFOODING AUDIT

1. páginas percorridas
2. páginas não acessíveis
3. READY
4. READY WITH POLISH
5. BLOCKED
6. HIDDEN/DEFERRED
7. P0 encontrados
8. P1 encontrados
9. P2 encontrados
10. P3 encontrados
11. erros HTTP
12. endpoints problemáticos
13. dependências legadas
14. inconsistências de entitlement
15. inconsistências de integração
16. menu/navigation issues
17. security/privacy issues
18. top 3–5 correções recomendadas
19. ordem proposta das próximas rodadas
20. GO / NO-GO para dogfooding geral
```

Pare no checkpoint.

Não iniciar automaticamente a próxima rodada de implementação.
