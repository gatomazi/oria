# Rodada Noturna Estendida — Integrações + Operação + Marketing

## Objetivo

Aproveitar a madrugada para avançar muito além do hardening de integrações.

Quero fechar, dentro do possível, uma camada operacional realmente dogfoodável do Oria.

Escopo desta rodada:

```text
A. Integrações
- Reserva Ink via API
- GA4
- Meta Ads
- Google Ads, se já houver base suficiente
- OpenAI
- WhatsApp no estado atual do Oria
- Instagram apenas conforme implementação existente

B. Operação
- Trocas
- Recuperação
- Promoções
- Campanhas
- UTM relacionado
- clientes/pedidos/financeiro apenas onde forem necessários ao fluxo

C. Reserva Ink
- tudo que depender da API deve funcionar para Store nativa
- webhook REAL continua fora desta rodada
```

Tenant principal de dogfooding:

```text
Organization = Use Origens
Store = Use Sul
loja_legada = NULL
```

## 1. Regra principal

Esta rodada está aprovada para execução ponta a ponta.

Pode:

```text
investigar
implementar
migrar schema com migrations novas
criar/refatorar jobs
corrigir bugs do escopo
testar
commit
push
CI
merge quando permitido
deploy
smoke por API/logs
smoke no Claude in Chrome
fazer escritas controladas em produção
```

Não parar por excesso de cautela operacional.

Pare somente para:

```text
senha/2FA/challenge que seu ambiente não pode submeter
billing real
ação irreversível/destrutiva não prevista
mudança arquitetural nova que altere produto
risco de segurança/isolamento
```

Se uma frente encontrar blocker externo:

```text
registre
→ continue nas outras
→ retome depois se possível
```

## 2. Gate inicial

Antes de abrir mudanças novas:

1. confirmar o estado final do PR #9;
2. confirmar CI;
3. confirmar merge/deploy;
4. confirmar boot limpo;
5. confirmar migrations aplicadas;
6. confirmar que as novas envs de Meta Ads estão visíveis ao backend:

```text
META_ADS_APP_ID
META_ADS_APP_SECRET
META_ADS_OAUTH_REDIRECT_URI
```

Esperado:

```text
oauthConfigurado = true
```

## 3. Regra Ink desta rodada

O webhook da Reserva Ink está deliberadamente:

```text
DEFERRED
```

Motivo:

```text
o projeto legado continua sendo o consumidor oficial dos webhooks da Use Sul
```

Portanto:

```text
NÃO cadastrar webhook Ink real
NÃO trocar o consumidor oficial
NÃO depender de webhook para considerar a API Ink saudável
```

Mas tudo que puder operar por API deve ficar funcional.

## 4. Reserva Ink — API completa

Quero revisar e fechar:

```text
credencial
teste de conexão
status
pedidos
pedido detalhe
itens
clientes derivados
produtos
categorias
agrupamentos
catálogo/cache
tracking/shipping quando disponível por API
trocas se suportadas por API
promoções/cupom/dados necessários se suportados
```

Tudo por:

```text
organization_id + store_id
```

Store nativa nunca exige `loja_legada`.

## 5. Ink — busca por dependências legadas

Auditar todas as chamadas ainda usadas por áreas desta rodada a:

```text
lojaLegadaDoContexto()
loja
loja_atribuida
feedUrl
produtos_feed
```

Se o consumidor pertence a:

```text
Pedidos
Clientes
Financeiro
Produtos
Categorias
Agrupamentos
Trocas
Recuperação
Promoções
Campanhas
UTM
```

e pode ser migrado com segurança:

```text
migrar agora
```

Se pertence a:

```text
Estoque
Feed legado
Artwork Vault
```

deixar fora.

## 6. Produtos / Categorias / Agrupamentos

Esses fluxos devem permanecer ou ficar:

```text
READY
```

Validar:

```text
listagem
busca
filtros
status
cache
dados reais
store_id
loja = NULL para Store nativa
```

Nenhum endpoint deve retornar:

```text
STORE_WITHOUT_LEGACY_KEY
```

## 7. Trocas — agora entra no escopo

Migrar Trocas para Store nativa.

Auditar:

```text
lista
detalhe
criação
status
pedido relacionado
cliente
itens
motivo
resolução
integração Ink
```

Objetivo:

```text
Trocas abre
lista dados
permite criar/acompanhar fluxo suportado
sem legacy key
```

## 8. Trocas + Ink

Determinar exatamente o que a API Ink suporta.

Se houver endpoint real de troca/devolução:

```text
integrar corretamente
```

Se o Oria é o source of truth da troca e a Ink só fornece pedido/item/status:

```text
documentar e implementar assim
```

Não inventar capacidade da Ink.

Se uma ação externa real puder alterar pedido/produção:

```text
usar fixture/controlado
```

Não executar troca destrutiva em pedido real sem necessidade.

## 9. Reembolsos relacionados

Mesmo que Reembolsos já esteja READY, revisar integração com Trocas.

Garantir:

```text
troca != reembolso
```

e que os fluxos não dupliquem efeito financeiro.

Se houver dependência legada simples:

```text
corrigir
```

Não ampliar para gateway/billing não existente.

## 10. Recuperação — agora entra no escopo

Quero a área de Recuperação funcional para Store nativa.

Auditar:

```text
carrinho abandonado
PIX pendente/expirado
pedido incompleto
cliente
pedido
janela de recuperação
status da tentativa
mensagem
conversão
```

## 11. Recuperação sem webhook Ink

Como webhook Ink continua adiado, o Oria NÃO pode fingir real-time.

Usar, quando possível:

```text
polling
jobs
API Ink
dados já sincronizados
```

para obter estados relevantes.

Se um evento só existir via webhook e não puder ser reconstruído por API:

```text
marcar aquela subcapability como DEFERRED
```

Não bloquear toda a Recuperação.

## 12. Jobs de Recuperação

Auditar/criar os jobs necessários para:

```text
carrinhos abandonados
PIX pendente
reconsulta
reenvio
status
```

Todos com contexto explícito:

```text
organization_id
store_id
integration
```

Nada global.

## 13. Recuperação + WhatsApp

O WhatsApp do Oria está em estado técnico/teste e o Tech Provider production está deferred.

Portanto distinguir:

```text
motor de recuperação
vs
canal de envio disponível
```

A recuperação deve poder:

```text
identificar elegíveis
gerar tentativa
preparar mensagem/template
registrar status
```

mesmo se o canal real estiver em modo de teste.

Se houver número/test environment configurado, pode fazer envio controlado apenas quando seguro.

Não disparar mensagens em massa.

## 14. Templates

Validar:

```text
lista
status
aprovação
variáveis
preview
associação com fluxo
```

Se Meta/WhatsApp test mode limitar envio:

```text
UI deve explicar
```

e não retornar erro cru.

## 15. Promoções — agora entra no escopo

Quero Promoções funcional para Store nativa.

Auditar:

```text
lista
criação
edição
status
data início/fim
segmento
cupom
produto/categoria
regra
```

Se Promoções depende apenas do Oria:

```text
migrar para organization_id + store_id
```

Se depende de Ink:

```text
mapear exatamente a capacidade real da API
```

## 16. Promoções + Ink

Não assumir que a Ink suporta criação de promoção/cupom se não houver endpoint real.

Separar:

```text
promoção Oria
→ targeting/campanha/comunicação

promoção Ink
→ desconto/cupom/preço real
```

Se o Oria apenas referencia um cupom já existente:

```text
persistir referência/metadata
```

Se houver API real para criação:

```text
pode integrar
```

Mas não inventar.

## 17. Campanhas — agora entra no escopo

Quero Campanhas funcional para Store nativa.

Auditar:

```text
lista
criação
edição
status
segmento
canal
mensagem
UTM
agendamento
envio
resultados
```

## 18. Campanhas e canais

Distinguir claramente:

```text
campanha definida
campanha agendada
campanha pronta para envio
campanha enviada
```

de:

```text
canal indisponível
```

Não bloquear criação de campanha porque WhatsApp/Meta ainda está parcialmente em configuração.

## 19. Campanhas + WhatsApp

Não enviar campanha em massa real.

Pode validar:

```text
renderização
template
segmentação
preview
fila
idempotência
job
```

e, se houver ambiente/test number:

```text
1 envio controlado
```

somente quando seguro.

## 20. Segmentos

Segmentos já estava READY, mas revisar integração com:

```text
Clientes
Pedidos
Produtos
Categorias
Campanhas
Recuperação
```

Tudo Store-scoped.

## 21. UTM

UTM já está READY.

Agora integrar melhor com Campanhas:

```text
campanha
→ UTM
→ origem
→ mídia
→ GA4
```

Se GA4 estiver conectado, Performance deve refletir.

Se não estiver:

```text
estado vazio factual
```

## 22. GA4 — prioridade alta

Deixar redondo.

Fluxo:

```text
Conectar
→ OAuth
→ callback
→ property
→ conectado
→ UTM Performance
```

Validar:

```text
sessions
purchases
revenue
property
store_id
cache
```

Se login/2FA bloquear:

```text
pare só GA4
continue o restante
```

## 23. Meta Ads — prioridade alta

As envs já estão configuradas.

Confirmar:

```text
oauthConfigurado = true
```

Depois:

```text
Conectar
→ OAuth
→ callback
→ Ad Accounts
→ selecionar
→ persistir
→ sync
→ Dashboard
→ Financeiro
```

Se Meta pedir login/2FA:

```text
pare só Meta
continue o restante
```

## 24. Meta Ads + Campanhas

Não confundir campanha de marketing do Oria com campanha paga da Meta.

Nesta rodada:

```text
ler campanhas Meta
ler gasto/resultados
associar métricas
```

Não:

```text
criar/editar/pausar campanha Meta
alterar orçamento
```

## 25. Google Ads

Auditar de verdade.

Se já houver implementação suficiente:

```text
finalizar
```

Se for placeholder:

```text
classificar como PARTIAL
não abrir mega frente
```

Mas a UI deve ser honesta.

## 26. OpenAI

Validar BYOK:

```text
salvar
testar
mascarar
revogar
usar no Gerador
```

Corrigir se necessário.

## 27. Instagram

Se não implementado:

```text
COMING SOON
```

Sem chamadas/erros.

## 28. Página Estado das Integrações

Quero que a página seja fonte real de verdade.

Para cada provider:

```text
provider
entitled
platformAvailable
configured
connected
hasData
health
deferred
nextAction
```

## 29. Read model único

Se o PR #9 já introduziu algo equivalente:

```text
usar
```

e não duplicar.

Cards devem consumir o mesmo estado semântico.

## 30. Retry / backoff / timeout

Auditar clients:

```text
Ink
Google/GA4
Meta
Google Ads
OpenAI
```

Tratar corretamente:

```text
429
502
503
504
timeout
connection reset
expired token
```

Não retry em:

```text
400
401
403
validation error
```

salvo caso documentado.

## 31. Token expiry / reconnect

GA4 e Meta:

```text
expired
revoked
invalid_grant
```

devem virar:

```text
Reconectar
```

e não 500.

## 32. Observabilidade

Padronizar logs:

```text
provider
organization_id
store_id
operation
duration
status
external resource parcialmente identificável
```

Nunca secret/token.

## 33. Jobs

Auditar todos os jobs tocados nesta rodada:

```text
Ink sync
Recuperação
Campanhas
Meta
GA4
Google Ads se existir
```

Todos com:

```text
organization_id
store_id
```

## 34. Tenant isolation

Provar isolamento em:

```text
Ink
Trocas
Recuperação
Promoções
Campanhas
GA4
Meta Ads
OpenAI
```

Tenant A não lê/escreve/sincroniza B.

## 35. Escritas controladas permitidas

Pode criar e remover:

```text
[TESTE Claude] troca
[TESTE Claude] promoção
[TESTE Claude] campanha
[TESTE Claude] recuperação
[TESTE Claude] UTM
```

desde que:

```text
sejam identificáveis
não gerem efeito externo destrutivo
sejam limpas ao final
```

## 36. Chrome obrigatório

Após deploy, validar:

```text
Dashboard
Pedidos
Clientes
Financeiro
Despesas
Trocas
Reembolsos
Recuperação
Promoções
Campanhas
Segmentos
UTM
Integrações
Estado das integrações
Ink
GA4
Meta Ads
Google Ads
WhatsApp
OpenAI
Instagram
Produtos
Categorias
Agrupamentos
```

## 37. Chrome quebrado

Se ocorrer quadrante duplicado/renderização quebrada:

```text
reiniciar navegador
fechar abas
reabrir apenas Tenant Panel
```

Não classificar artefato do Chrome como bug do produto.

## 38. Control Plane

Se houver tempo depois dos P1:

Validar/corrigir P2 simples:

```text
readiness de plataforma
owner onboarding incorreto
capabilities aparecendo como features
```

Sem migration destrutiva.

## 39. Não entrar ainda

Ainda fora:

```text
Webhook Ink real
Estoque productization
Feed legado
Artwork Vault
WhatsApp Tech Provider production
App Review WPP
billing
```

## 40. Critério de fechamento de Trocas

```text
abre
lista
cria fluxo controlado
relaciona pedido/item
Store nativa
sem legacy key
sem loading infinito
```

## 41. Critério de fechamento de Recuperação

```text
abre
identifica elegíveis por API/jobs
gera tentativa
status correto
Store nativa
sem depender obrigatoriamente de webhook
```

Subfluxos impossíveis sem webhook podem ficar:

```text
DEFERRED
```

## 42. Critério de fechamento de Promoções

```text
abre
cria/edita
segmenta
associa dados reais
Store nativa
sem legacy key
```

## 43. Critério de fechamento de Campanhas

```text
abre
cria
edita
segmenta
preview
UTM
agendamento/fila coerente
canal/estado explícito
Store nativa
```

Não precisa disparo em massa real.

## 44. Critério de fechamento Ink

```text
API conectada
Pedidos READY
Produtos READY
Categorias READY
Agrupamentos READY
Trocas relacionadas funcionais conforme capacidade real
cache correto
webhook = DEFERRED
```

## 45. Critério de fechamento GA4/Meta

Ideal:

```text
GA4 READY
Meta Ads READY
```

Se login externo bloquear:

```text
infraestrutura pronta
UI pronta
backend pronto
blocker externo explícito
```

## 46. CI

Pode dividir por blocos e usar CI incremental.

Mas antes de fechar:

```text
suite relevante
negative controls
tenant isolation
Full Verification
```

Não rodar suites concorrentes no mesmo Postgres.

## 47. Commits

Pode dividir em commits coerentes:

```text
integrations hardening
trocas
recuperação
promoções/campanhas
tests/UX
```

ou equivalente.

## 48. Merge/deploy

Se gates verdes:

```text
merge
deploy
```

Se o harness bloquear merge:

```text
não contornar
deixar pronto
continuar o que for possível
```

## 49. Checkpoint final da madrugada

Quero:

```text
GERAL
- PR #9
- CI
- merge
- deploy
- migrations
- Full Verification

INTEGRAÇÕES
- Ink
- GA4
- Meta Ads
- Google Ads
- WhatsApp
- OpenAI
- Instagram
- Estado das integrações

INK
- API
- pedidos
- produtos
- categorias
- agrupamentos
- trocas
- cache
- jobs
- webhook deferred

OPERAÇÃO
- Trocas
- Reembolsos relacionados
- Recuperação

MARKETING
- Promoções
- Campanhas
- Segmentos
- UTM

HARDENING
- retry
- timeout
- reconnect
- jobs
- logs
- secrets
- tenant isolation
- negative controls

CHROME
- páginas validadas
- bugs encontrados
- correções

DOGFOODING
- READY
- READY WITH POLISH
- PARTIAL
- BLOCKED
- DEFERRED
- GO/NO-GO geral
```

## 50. Regra final

Quero aproveitar a madrugada.

Não pare cedo porque uma frente encontrou blocker externo.

Prioridade:

```text
fechar o máximo de funcionalidade real com segurança
```

Se Meta parar em login:

```text
continue GA4 + Ink + Trocas + Recuperação + Promoções + Campanhas
```

Se GA4 parar:

```text
continue Meta + Ink + Operação + Marketing
```

Se uma integração externa limitar:

```text
continue o domínio local
```

Pare apenas no checkpoint final.

Não iniciar Estoque, Feed, Artwork Vault, Webhook Ink real ou Tech Provider WhatsApp production.
