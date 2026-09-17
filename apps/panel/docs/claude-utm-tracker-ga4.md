# Claude Code — UTM Tracker + Google Analytics 4

> **Status (14/09/2026).** Fases 1, 2 e 3 **em produção**: Builder/Campanhas/Presets (sem GA4),
> OAuth do Google com propriedade por loja, e a aba Performance lendo a Data API agrupada pelas
> dimensões do próprio GA4 — então UTM usado fora do Construtor (anúncio do Meta) aparece igual.
> Conectada de verdade só a loja Use Sul.
>
> Fora do escopo original, no mesmo ciclo: tela **Analytics GA4** (`/admin/analytics`) com funil
> sessão→carrinho→checkout→pedido, KPIs de tráfego e receita, canais, dispositivos e mapa de calor
> por hora — 5 relatórios num `batchRunReports`, mesmo cache de 20min.
>
> **Atenção:** o app OAuth está em "Testing" no Google Cloud, onde o refresh token expira em 7 dias
> e derruba a conexão sozinha (1ª queda esperada ~21/09/2026). Resolver exige publicar/verificar o
> app. Setup do Google Cloud em `docs/ga4-oauth-setup.md`.
>
> Fase 4 (QA, empty states, auditoria final) não começou.

## Contexto

O painel já está em React + TypeScript e possui integrações com Reserva Ink e WhatsApp, além de Instagram planejado.

Agora queremos adicionar um módulo:

```text
FERRAMENTAS
└── UTM Tracker
```

e uma integração:

```text
SISTEMA
└── Integrações
    └── Google Analytics 4
```

O objetivo é permitir:

1. criar URLs com UTMs;
2. salvar campanhas;
3. padronizar nomenclaturas;
4. reutilizar campanhas;
5. conectar o GA4 pelo painel;
6. consultar performance real das campanhas salvas;
7. exibir sessões, usuários, compras, receita e conversão quando esses dados existirem;
8. continuar usando o Builder mesmo sem GA4 conectado.

---

# Regra central

O módulo deve separar claramente:

```text
UTM Builder
Campanhas salvas
Conexão GA4
Performance GA4
```

O Builder não depende do Google Analytics.

O GA4 serve apenas para transformar as UTMs salvas em relatórios de performance.

Nunca fabricar números.

---

# 1. Navegação

Adicionar:

```text
FERRAMENTAS
└── UTM Tracker
```

Rota sugerida:

```text
/admin/utm
```

Dentro do módulo:

```text
Visão geral
Campanhas
Construtor
Presets
```

Pode usar tabs no MVP.

Em:

```text
SISTEMA
└── Integrações
```

adicionar card:

```text
Google Analytics 4
```

---

# 2. UTM Builder

Campos:

```text
URL de destino *
utm_source *
utm_medium *
utm_campaign *
utm_content
utm_term
```

Preview em tempo real:

```text
https://usesul.com.br/seu-lugar
?utm_source=instagram
&utm_medium=story
&utm_campaign=seu_lugar
&utm_content=banner_busca_v1
```

Ações:

```text
Copiar URL
Abrir URL
Salvar campanha
```

Usar `URL` e `URLSearchParams`.

Não concatenar querystring manualmente.

Deve funcionar corretamente com URL que já possui parâmetros.

---

# 3. Normalização

Criar helper central:

```text
normalizeUtmValue()
```

Padrão sugerido:

```text
trim
lowercase
remover acentos para o valor normalizado
espaços → underscore
remover espaços duplicados
```

Exemplo:

```text
Campanha Setembro
→ campanha_setembro
```

Não alterar campanha já salva silenciosamente.

---

# 4. Presets

Sugestões iniciais de `source`:

```text
instagram
facebook
google
whatsapp
email
site
tiktok
```

Sugestões de `medium`:

```text
paid_social
organic_social
story
reel
banner
email
cpc
whatsapp
bio
card
```

Permitir presets editáveis.

Exemplos:

```text
Instagram Story
source = instagram
medium = story
```

```text
Meta Ads
source = facebook
medium = paid_social
```

```text
WhatsApp
source = whatsapp
medium = whatsapp
```

---

# 5. Campanhas salvas

Modelo conceitual:

```ts
type UtmCampaign = {
  id: string
  accountId?: string
  storeId?: string
  name: string
  destinationUrl: string

  source: string
  medium: string
  campaign: string
  content?: string
  term?: string

  fullUrl: string

  createdAt: Date
  updatedAt: Date
  archivedAt?: Date
}
```

Tabela:

```text
Nome
Campaign
Source
Medium
Content
Destino
Atualizado
Ações
```

Ações:

```text
Copiar URL
Abrir
Editar
Duplicar
Arquivar
Excluir
```

Excluir em menu contextual, não botão vermelho em cada linha.

---

# 6. Identidade analítica da campanha

Não considerar apenas `utm_campaign`.

Preferir a combinação:

```text
source
medium
campaign
content
term
```

Isso evita colisões quando o mesmo `campaign` aparece em canais diferentes.

---

# 7. Integração Google Analytics 4

## Fluxo recomendado

Usar OAuth 2.0.

Não usar Service Account como fluxo principal do SaaS.

Fluxo:

```text
Conectar Google Analytics
↓
OAuth Google
↓
autorizar leitura
↓
listar propriedades disponíveis
↓
selecionar propriedade GA4
↓
salvar propertyId
↓
integração conectada
```

Usar escopo somente leitura sempre que possível.

---

# 8. APIs Google

Usar:

```text
Google Analytics Admin API
```

para:

```text
listar contas/propriedades
selecionar propertyId
```

Usar:

```text
Google Analytics Data API
```

para:

```text
sessões
usuários
compras
receita
séries temporais
dimensões UTM
```

---

# 9. Conexão persistida

Modelo conceitual:

```ts
type GoogleAnalyticsConnection = {
  id: string
  accountId?: string
  storeId?: string

  propertyId: string
  propertyName: string
  googleAccountEmail?: string

  refreshTokenEncrypted: string
  accessTokenEncrypted?: string
  tokenExpiresAt?: Date

  status:
    | "connected"
    | "expired"
    | "error"
    | "disconnected"

  connectedAt: Date
  lastSyncAt?: Date
  lastError?: string
}
```

Adaptar ao schema atual.

---

# 10. Segurança

Nunca guardar tokens em:

```text
localStorage
sessionStorage
frontend bundle
```

Tokens ficam no backend.

O refresh token deve ficar criptografado em repouso.

Nunca logar:

```text
refresh_token
access_token
client_secret
authorization_code
```

Variáveis de ambiente:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_OAUTH_REDIRECT_URI
```

---

# 11. OAuth

Endpoints sugeridos:

```text
GET /admin/api/integrations/google-analytics/connect
GET /admin/api/integrations/google-analytics/callback
GET /admin/api/integrations/google-analytics/properties
POST /admin/api/integrations/google-analytics/property
POST /admin/api/integrations/google-analytics/disconnect
```

Adaptar às convenções do projeto.

No OAuth:

1. gerar `state`;
2. associar ao usuário/sessão;
3. validar `state` no callback;
4. trocar `code` por tokens;
5. armazenar tokens;
6. listar propriedades;
7. usuário escolhe `propertyId`.

---

# 12. Card de integração

Estado conectado:

```text
Google Analytics 4

● Conectado

Propriedade
Use Sul - GA4

Property ID
123456789

Última sincronização
há 12 min

[ Gerenciar ]
```

Estado desconectado:

```text
Google Analytics 4

○ Não conectado

Conecte uma propriedade GA4 para acompanhar a performance das UTMs.

[ Conectar Google Analytics ]
```

Estados possíveis:

```text
Conectado
Desconectado
Autorização expirada
Erro
Propriedade não selecionada
```

---

# 13. Performance via Data API

Usar dimensões de sessão compatíveis com UTMs manuais.

Mapeamento conceitual:

```text
utm_source
→ sessionManualSource

utm_medium
→ sessionManualMedium

utm_campaign
→ sessionManualCampaignName

utm_content
→ sessionManualAdContent

utm_term
→ sessionManualTerm
```

Antes de codificar, confirmar os nomes exatos suportados pela versão atual da Data API/biblioteca utilizada.

---

# 14. Métricas

Prioridade:

```text
sessions
activeUsers ou totalUsers
ecommercePurchases / transactions
totalRevenue
```

Se houver suporte confiável:

```text
purchaseRevenue
engagementRate
keyEvents
```

Não usar métricas incompatíveis com as dimensões escolhidas.

---

# 15. Conversão

Quando houver:

```text
sessions > 0
```

pode calcular:

```text
conversionRate = purchases / sessions
```

Na UI, tooltip:

```text
Compras ÷ sessões
```

Não afirmar que é uma métrica nativa do GA4 se for cálculo local.

---

# 16. Performance por campanha

Tabela:

```text
Campanha
Sessões
Usuários
Compras
Receita
Conversão
Atualizado
```

Ao clicar:

```text
Nome da campanha

Sessões
Usuários
Compras
Receita
Conversão

[ gráfico por dia ]

Source
Medium
Campaign
Content
Term

URL destino
URL completa
```

---

# 17. Filtro por período

Adicionar:

```text
Hoje
7 dias
30 dias
90 dias
Personalizado
```

Default sugerido:

```text
30 dias
```

---

# 18. Série temporal

Usar Recharts ou a biblioteca de gráficos já adotada no projeto.

Gráfico principal:

```text
Sessões por dia
```

Opcional:

```text
Receita por dia
```

Não adicionar gráfico apenas por decoração.

---

# 19. Visão geral do UTM Tracker

Com GA4 conectado:

```text
KPIs
Campanhas
Sessões
Compras
Receita

Performance por campanha
Campanhas recentes
```

Sem GA4:

```text
Campanhas salvas
Links gerados
CTA conectar GA4
```

Não mostrar métricas falsas.

---

# 20. Cache

Não consultar a Data API a cada render.

Criar cache por:

```text
propertyId
campanha
período
```

Sugestão:

```text
15 a 30 minutos
```

Mostrar:

```text
Atualizado há 12 min
```

Ação:

```text
Atualizar agora
```

---

# 21. Quotas / eficiência

Evitar:

```text
1 request GA4 por row
refresh automático agressivo
dezenas de consultas simultâneas
```

Preferir:

```text
consultas agrupadas
cache
concorrência limitada
atualização sob demanda
```

---

# 22. Endpoints internos

Sugestão:

```text
GET    /admin/api/utm/campaigns
POST   /admin/api/utm/campaigns
GET    /admin/api/utm/campaigns/{id}
PATCH  /admin/api/utm/campaigns/{id}
DELETE /admin/api/utm/campaigns/{id}
POST   /admin/api/utm/campaigns/{id}/duplicate
```

Analytics:

```text
GET /admin/api/utm/analytics/overview
GET /admin/api/utm/analytics/campaigns
GET /admin/api/utm/analytics/campaigns/{id}
```

Adaptar aos padrões existentes.

---

# 23. Banco / migrations

Criar apenas o necessário.

Sugestão:

```text
utm_campaigns
google_analytics_connections
utm_analytics_cache
```

Schema mínimo `utm_campaigns`:

```text
id
account_id / store_id
name
destination_url
utm_source
utm_medium
utm_campaign
utm_content
utm_term
created_at
updated_at
archived_at
```

Schema mínimo `google_analytics_connections`:

```text
id
account_id / store_id
property_id
property_name
google_account_email
refresh_token_encrypted
status
connected_at
last_sync_at
last_error
created_at
updated_at
```

Usar cache existente do projeto. Não adicionar Redis apenas por causa desta feature.

---

# 24. Integração futura com outros módulos

Deixar o Builder reutilizável por:

```text
WhatsApp
Instagram
Banners
Recuperação
PIX
```

Mas NÃO implementar essas automações agora.

Exemplo futuro:

```text
Adicionar rastreamento UTM
[x]
```

---

# 25. Design

Usar o design system dark premium atual.

Não copiar visualmente outra ferramenta.

Estrutura conceitual:

```text
UTM Tracker                       GA4: Conectado

Minhas campanhas

Performance por campanha

Construtor de URL

Presets
```

Builder desktop:

```text
URL destino
────────────────────────

Source              Medium
Campaign            Content
Term

URL gerada
────────────────────────

[ Copiar URL ] [ Salvar campanha ]
```

---

# 26. Empty states

Sem campanhas:

```text
Nenhuma campanha UTM cadastrada.

Crie sua primeira campanha para padronizar e acompanhar os links da loja.

[ Nova campanha ]
```

Sem GA4:

```text
Conecte o Google Analytics para visualizar a performance das campanhas.
```

Sem resultado:

```text
Nenhum dado encontrado para esta campanha no período.
```

---

# 27. Erros

Tratar:

```text
OAuth cancelado
state inválido
token expirado
refresh token inválido
property sem acesso
quota GA4
Data API indisponível
campanha sem dados
```

Erro de um widget não deve derrubar o módulo inteiro.

---

# 28. Auditoria

Registrar eventos internos:

```text
utm_campaign_created
utm_campaign_updated
utm_campaign_deleted

ga4_connected
ga4_property_selected
ga4_disconnected
ga4_report_refreshed
ga4_report_failed
```

Nunca incluir tokens nos logs.

---

# 29. Testes

## Builder

Testar:

```text
source obrigatório
medium obrigatório
campaign obrigatório
content opcional
term opcional
URL sem querystring
URL com querystring existente
encoding
normalização
```

Exemplo:

```text
https://site.com/produto?color=black
```

deve resultar em:

```text
https://site.com/produto?color=black&utm_source=...
```

## OAuth

Testar:

```text
state válido
state inválido
callback sem code
refresh token
desconectar
```

## GA4

Mockar client em testes.

Testar:

```text
campanha com dados
campanha sem dados
property inválida
quota error
cache
refresh manual
```

---

# 30. Trabalho paralelo

Este projeto pode estar sendo alterado por outros agentes.

Antes de começar:

```bash
git status
git log --oneline -10
git diff
```

Não reverta trabalho alheio.

Limite a tarefa aos módulos:

```text
UTM Tracker
Google Analytics
Integrações relacionadas
```

Evite refatorações paralelas fora do escopo.

---

# 31. Fora do escopo

Não implementar agora:

```text
redirect próprio /r/{slug}
tracking server-side de clique
integração automática com Meta Ads
auto-injeção de UTM em todas as mensagens
atribuição multi-touch
Instagram Analytics
```

---

# 32. Ordem de implementação

## Fase 1

```text
models/migrations
UTM Builder
campanhas salvas
presets
```

## Fase 2

```text
card GA4
OAuth
listagem de propriedades
seleção de propertyId
persistência segura
```

## Fase 3

```text
Data API
performance
cache
gráficos
```

## Fase 4

```text
QA
empty states
erros
responsividade
auditoria
```

---

# 33. Critérios de aceitação

## Cenário A

Criar:

```text
utm_source=instagram
utm_medium=story
utm_campaign=seu_lugar
utm_content=banner_busca_v1
```

e gerar URL correta.

## Cenário B

Salvar a campanha e reutilizá-la.

## Cenário C

Conectar conta Google e selecionar propriedade GA4.

## Cenário D

Abrir campanha e visualizar performance real.

## Cenário E

Desconectar GA4 sem perder campanhas UTM.

## Cenário F

Builder continua funcionando sem GA4.

---

# 34. Entrega esperada

Ao finalizar, informar:

1. arquivos criados;
2. arquivos alterados;
3. migrations;
4. models;
5. endpoints;
6. fluxo OAuth;
7. escopos Google utilizados;
8. como o propertyId é selecionado;
9. onde tokens são armazenados;
10. estratégia de criptografia;
11. métricas GA4 utilizadas;
12. dimensões GA4 utilizadas;
13. estratégia de cache;
14. novas dependências;
15. testes;
16. limitações restantes.

Confirmar explicitamente:

```text
O UTM Builder funciona sem GA4.

Nenhum dado analítico é mockado.

GA4 é usado somente para performance real.

Tokens Google nunca são enviados ao frontend.

O propertyId não é hardcoded.

Reserva Ink e WhatsApp não foram alterados.
```
