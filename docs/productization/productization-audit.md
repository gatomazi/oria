# Oria — Auditoria de productização (fatos)

> **Baseline:** commit `8a7ea3d`, branch `master`, working tree de 15/09/2026.
> **Fase:** AUDITORIA. Nenhuma implementação de productização foi feita nesta sessão.
>
> **Rodada 2 — decisões do usuário aplicadas.** Ver [Impacto das decisões da rodada 2](#impacto-das-decisões-da-rodada-2).
> Os fatos sobre o código continuam sendo os do commit `8a7ea3d`; o que mudou foi o **alvo**.
> **Verificação:** `npm run build` → sucesso (`✓ built in 2.62s`). `npm test` → 234 testes,
> **228 passam, 0 falham, 6 pulados**.
>
> **Companheiros:**
> [`productization-decisions.md`](./productization-decisions.md) (decisões OPEN) ·
> [`productization-progress.md`](./productization-progress.md) (log) ·
> [Anexo A — matriz completa de rotas](./anexo-a-matriz-de-rotas.md) (278 linhas) ·
> [Anexo B — matriz completa de tabelas](./anexo-b-matriz-de-tabelas.md) (53 tabelas) ·
> [Anexo C — ownership Meta/Google Ads](./anexo-c-ownership-meta-google-ads.md) ·
> [Anexo D — ownership GA4/UTM/WhatsApp/Criativos](./anexo-d-ownership-ga4-utm-whatsapp-criativos.md) ·
> [Anexo E — varredura de escopo](./anexo-e-varredura-de-escopo.md).
>
> **Fontes de intenção:** [`levantamento-productizacao-saas-painel.md`](./levantamento-productizacao-saas-painel.md),
> [`productization-audit-addendum-v2.md`](./productization-audit-addendum-v2.md) (prevalece em conflito),
> `docs/painel-estado-atual.md` do repositório de origem (removido do Oria na limpeza de 18/09/2026; continua no `orgulhoregional`).

## Regra de leitura deste documento

Este documento separa três coisas que não podem ser confundidas:

- **FATO** — observado no código, com `arquivo:linha`. É o padrão: toda afirmação sem rótulo é fato.
- **RECOMENDAÇÃO** — opinião da auditoria, explicitamente rotulada. Não é estado atual.
- **OPEN** — decisão que falta; vive em `productization-decisions.md`, não aqui.

Onde o documento de intenção diverge do código, a divergência está registrada como tal.

---

## Sumário

| | Seção |
|---|---|
| A | [Executive summary](#a-executive-summary) |
| B | [Hardcodes encontrados](#b-hardcodes-encontrados) |
| C | [Globals que precisam virar tenant config](#c-globals-que-precisam-virar-tenant-config) |
| D | [Secrets](#d-secrets) |
| E | [Tabelas e tenancy](#e-tabelas-e-tenancy) |
| F | [Rotas com risco multi-tenant](#f-rotas-com-risco-multi-tenant) |
| G | [Jobs com risco multi-tenant](#g-jobs-com-risco-multi-tenant) |
| H | [Webhooks](#h-webhooks) |
| I | [Auth](#i-auth) |
| J | [Integrações](#j-integrações) |
| K/L | [Decisões pendentes](#kl-decisões-pendentes) |
| M | [Riscos](#m-riscos) |
| N | [Arquitetura-alvo](#n-arquitetura-alvo) |
| O | [Roadmap](#o-roadmap) |
| P | [Quick wins](#p-quick-wins) |
| Q | [Blockers P0](#q-blockers-p0) |
| ★ | [**Ownership e escopo de recursos**](#ownership-e-escopo-de-recursos-rodada-3) · [**Invariants antes do 2º tenant**](#invariants-obrigatórios-antes-do-segundo-tenant) |
| + | [Tenant Surface Matrix](#tenant-surface-matrix-consolidada) · [P0 Data Leak Review](#p0-data-leak-review) · [Client-controlled tenant context](#client-controlled-tenant-context-risks) · [Current-to-Target Map](#current-to-target-map) · [Checklist P0](#checklist-p0-para-primeiro-cliente-externo) · [Respostas às 20 perguntas](#respostas-às-20-perguntas-do-levantamento-122) · [NOT VERIFIED](#not-verified) |

---

# A. Executive summary

## Estado atual

O painel **não é um SaaS multi-tenant com lacunas**. Ele é um **sistema single-tenant bem construído**,
cuja fronteira de segurança é o perímetro: uma senha, um perímetro, tudo dentro é confiável.

Essa não é uma acusação — é o desenho declarado. O próprio código registra a decisão
(`server.js:758-761`: *"saímos da ideia de SaaS multi-tenant"*; `server.js:1582-1585`: *"só existe 1
nível de admin neste projeto (sem role)"*). A dívida não é descuido; é escopo.

A consequência é que a productização **não é uma camada a acrescentar**. As três lojas
(Use Sul / Centro / Norte) não são tenants: são um enum de três strings no código-fonte
(`server.js:58`, `server.js:69-73`), com 144 referências espalhadas, e um novo tenant exige redeploy.

## Nível de acoplamento

| Dimensão | Estado |
|---|---|
| Identidade | **Inexistente.** A sessão carrega só um timestamp de expiração (`server.js:1541-1545`). Não há usuário, papel ou organização. |
| Tenant context | **Controlado pelo cliente.** A loja vem de `localStorage` → query/body/param; o servidor valida só se a string está no enum. |
| Isolamento de dados | **Por convenção.** 22 de 53 tabelas têm coluna `loja`; a filtragem depende de cada query lembrar de usá-la, e várias não usam. |
| Credenciais | **Por instalação.** Meta Ads e Google Ads têm literalmente uma linha (`CHECK (id = 1)`). |
| Entitlements | **Decorativos.** Fail-open no frontend, **inexistentes** no backend. |
| Jobs | **Processo único.** 13 dos ~16 jobs têm lock só em memória. |
| Criativos | **A exceção.** Único módulo com `tenant_id` real em todas as tabelas e em todas as queries. |

## O que já está certo (e não deve ser refeito)

Vale registrar, porque muda o custo do trabalho futuro:

- Criptografia de segredos é real: AES-256-GCM com derivação HKDF por contexto (`server.js:9585-9614`). **Nenhum segredo em texto plano foi encontrado.**
- **Nenhum segredo é devolvido ao browser** em nenhum GET auditado — só booleanos, `last4` e metadados.
- CSRF de OAuth existe nos três fluxos (Meta, GA4, Google Ads), e em nenhum deles o cliente escolhe qual loja recebe o token — a tenancy é decidida no servidor.
- Comparações sensíveis usam `timingSafeEqual` (senha, HMAC de webhook, token de agente).
- O `express.static` na raiz do repositório — que servia código-fonte, `docs/`, `scripts/` e logs — **já foi eliminado** e substituído por allowlist (`lib/arquivos-publicos.js`).
- Ids públicos de pedido usam `crypto.randomBytes` (~72 bits), não são enumeráveis (`server.js:1525-1531`).
- Uploads geram nome no servidor (`crypto.randomUUID`/`randomBytes`) — **nenhum nome de arquivo previsível** foi encontrado.
- A fila de campanhas e o worker de criativos usam `FOR UPDATE SKIP LOCKED` de verdade.
- O módulo de criativos foi construído já com `tenant_id` em todas as 9 tabelas e em todas as queries.
- `db/`, `img-cache/`, `assets/pedidos/` e o log de webhooks estão no `.gitignore` com justificativa de PII. **Nenhum segredo commitado foi encontrado.**

## Principais blockers

1. **Tenant context é client-controlled** — a loja vem do browser e nada no servidor limita qual loja uma sessão acessa.
2. **Entitlements não existem no backend** — o próprio código diz que o middleware ficou para depois (`server.js:13369-13372`).
3. **Meta Ads e Google Ads são single-row por construção** — `PRIMARY KEY id SMALLINT CHECK (id = 1)`. Não é query a corrigir; é schema a refazer.
4. **Uma chave para tudo** — todas as chaves de cifra dos segredos derivam de `ADMIN_SESSION_SECRET`, o mesmo que assina o cookie de sessão.
5. **Jobs com lock em memória** — uma segunda réplica duplicaria envios reais de WhatsApp a clientes finais.
6. **Postgres é opcional em produção** — o boot não falha sem `DATABASE_URL`; degrada para JSON em silêncio.
7. **Zero testes de isolamento executáveis** — o único que existe está pulado neste ambiente.
8. **Roteamento de webhook por tentativa e erro** — a loja é descoberta testando o segredo de cada loja em sequência.

## Risco geral

**CRITICAL para exposição a cliente externo.** Não por fragilidade do que existe, mas porque as
fronteiras que um SaaS exige — identidade, ownership, autorização por recurso — **não existem para
serem endurecidas**. Precisam ser introduzidas.

Formulado de outro modo: hoje, se dois clientes externos usassem este painel, **qualquer um deles
poderia ler, escrever, reembolsar e revogar credenciais do outro trocando um parâmetro na URL** —
e nenhum log registraria quem fez.

---

# Impacto das decisões da rodada 2

O usuário fechou decisões que **reduzem materialmente o escopo** da productização. Registro aqui o
efeito sobre esta auditoria; o detalhe de cada decisão está em
[`productization-decisions.md`](./productization-decisions.md).

## O que foi decidido

| Decisão | Efeito |
|---|---|
| **1 assinatura = 1 Organization = 1 Store ativa** (PD-002) | elimina todo o eixo multi-store |
| **Sem multi-store na V1** (R-02) | sem seletor, consolidação, DRE multi-store, campanhas cross-store, catálogo compartilhado, rateio |
| **`multiStoreMode` é LEGACY / TO_REMOVE** (R-02) | não migra para o Oria |
| **Migração Use Origens sai do produto** (R-01) | 35 rotas + página + menu + flags; tabelas viram LEGACY / TO_REMOVE, **sem DROP agora** |
| **Tenant context pela sessão** (TD-002) | `loja` some da maioria dos endpoints |
| **Criativos pertencem à Organization** (PD-018) | corrigir só a origem do `tenant_id` |
| **Ownership de mídia na Organization + fail-closed de atribuição** (PD-016/PD-021) | gerou o achado **F-01** |
| **Customer nunca cruza Organization** (PD-017) | dedup entre Stores sai da V1 |
| **Operação interna sem bypass** (PD-019) | mesma regra comercial; 3 orgs ou 1, conforme a consolidação |

## Como isso muda a leitura desta auditoria

**A superfície encolhe.**

| Métrica | Rodada 1 | Rodada 2 |
|---|---:|---:|
| Rotas a productizar | 278 | **~243** (−35 da migração) |
| Tabelas a tenantizar | 53 | **49** (−4 `origens_migration_*`) |
| Eixos de isolamento a validar em toda query | 2 (`organization_id` + `store_id`) | **1** (`organization_id`) |
| Cenário de teste de isolamento | Org A/A1 · Org A/A2 · Org B/B1 | **Org A/Store A · Org B/Store B** + acesso cruzado |

**A estratégia para as ~125 rotas MEDIUM inverte.** Na rodada 1 a conclusão era "essas rotas
precisam ganhar checagem de posse". Com TD-002 fechada, a conclusão correta é: **elas precisam
parar de receber `loja`**. O risco não é mitigado — é eliminado ao remover o parâmetro. Isso é
menos trabalho e mais seguro.

Continuam exigindo verificação de posse as **10 rotas CRITICAL** e as **~38 HIGH**, que selecionam
credencial ou recurso por identificador. Essas não mudam.

**O que NÃO mudou:** todos os blockers de credencial, secret, webhook, job, persistência, auth e
teste continuam valendo integralmente. A cardinalidade 1:1 simplifica o isolamento *entre* Stores —
ela não toca o isolamento entre **Organizations**, que é o problema real.

## Achado novo desta rodada

**F-01** — a regra fail-closed de atribuição (PD-021) **é violada hoje** pelo consolidado financeiro.
Detalhe em [Financeiro / DRE](#financeiro--dre).

---

# B. Hardcodes encontrados

| Tipo | Local | Valor atual | Problema | Solução (RECOMENDAÇÃO) |
|---|---|---|---|---|
| Enum de lojas | `server.js:58` | `LOJAS = { sul: 'Use Sul', centro: 'Use Centro', norte: 'Use Norte' }` | Tenant é constante de código; novo tenant exige redeploy | Tabela `stores` |
| Credenciais por loja | `server.js:69-73` | `INK_STORES` lendo `INK_TOKEN_{SUL,CENTRO,NORTE}` | Credencial de tenant em env da plataforma | Linhas em `integrations` cifradas |
| Espalhamento do enum | 144 referências a `LOJAS`/`INK_STORES` | — | Cada ponto assume 3 lojas conhecidas | Resolver via `stores` no request context |
| Loop de lojas | `sincronizarProdutosFeedTodasLojas` (3476), `sincronizarCatalogoInkTodasLojas` (3634), `persistirCarrinhosAbandonadosTodasLojas` (13907), `sincronizarControleEstoqueTodasLojas` (14365) | `Object.keys(INK_STORES)` | Jobs iteram enum fixo, sem noção de tenant | Iterar `stores` ativas por tenant |
| Tenant do módulo de criativos | `routes/criativos.js:9,92` | `CREATIVE_TENANT_ID \|\| 'default'` | Constante de processo, nunca do request | Derivar do contexto da sessão |
| Conexão Meta singleton | `server.js:765` | `PRIMARY KEY id SMALLINT CHECK (id = 1)` | Uma conexão para a instalação inteira | `organization_id` como chave |
| Conexão Google Ads singleton | `server.js:1006` | idem | idem | idem |
| WABA único | `server.js:291` | comentário: *"o WhatsApp/WABA deste projeto é 1 conta só"* | Canal único por instalação | Canal por Store |
| Timezone | `server.js:2600, 11896-11897, 12133` | `AT TIME ZONE 'America/Sao_Paulo'` em SQL | Fuso do tenant assumido | Config por Organization |
| Moeda | ausência de coluna em `pedidos_ink`/`despesas_operacionais` | BRL implícito | Moeda do tenant assumida | Config por Organization |
| Nome do produto (login) | `admin/src/auth/LoginPage.tsx:27`, `admin/index.html:7` | `Orgulho Regional` fixo | Tela de login nunca reflete o tenant | Branding por tenant |
| Tagline | `admin/src/shell/AppShell.tsx:265` | `Central operacional` fixo | — | — |
| Rotas regionais públicas | `server.js:1733, 1746` | regex `sul\|centro\|norte` | Site público acoplado às 3 lojas | Fora do escopo SaaS (site público) |

**Nota de divergência:** o documento de intenção pedia caçar ocorrências literais de `'sul'`/`'centro'`/`'norte'`.
No backend elas quase não existem como strings soltas (apenas 1 ocorrência em `server.js`); o acoplamento
real é **estrutural**, via `LOJAS`/`INK_STORES`. No frontend há 5 ocorrências (`admin/src/pages/pedido-novo/`,
`pedido-vincular/`). O problema é maior do que uma busca textual sugere e menor do que um rename resolveria.

---

# C. Globals que precisam virar tenant config

Classificação conforme o levantamento §4.

| Config atual | Classificação hoje | Escopo futuro | Onde armazenar (RECOMENDAÇÃO) |
|---|---|---|---|
| `DATABASE_URL` | PLATFORM_GLOBAL | PLATFORM_GLOBAL | env (correto) |
| `ADMIN_SESSION_SECRET` | PLATFORM_GLOBAL | PLATFORM_GLOBAL | env — **mas hoje acumula papel de chave de cifra (ver D)** |
| `ADMIN_PASSWORD` | PLATFORM_GLOBAL | **eliminar** | substituído por `users` + hash por usuário |
| `INK_TOKEN_{SUL,CENTRO,NORTE}` | global (env) | **INTEGRATION_SECRET por Store** | `integrations` cifrado |
| `INK_WEBHOOK_SECRET_{…}` | global (env) | **INTEGRATION_SECRET por Store** | `integrations` cifrado |
| `INK_FEED_URL_{…}` | global (env) | STORE_CONFIG | `integrations.config` |
| `WHATSAPP_SERVICE_URL` | PLATFORM_GLOBAL | PLATFORM_GLOBAL | env |
| `WHATSAPP_API_KEY` | global (env) | **INTEGRATION_SECRET** | depende de PD-003/PD-006 |
| `WHATSAPP_WEBHOOK_SECRET` | global (env) | INTEGRATION_SECRET por conexão | `integrations` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | PLATFORM_GLOBAL | PLATFORM_GLOBAL (app OAuth da Oria) | env — correto, **não confundir com token do tenant** |
| `GOOGLE_OAUTH_REDIRECT_URI` | PLATFORM_GLOBAL | PLATFORM_GLOBAL | env |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | PLATFORM_GLOBAL | PLATFORM_GLOBAL | env |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | PLATFORM_GLOBAL | **OPEN** — pode ser por tenant | verificar com PD-016 |
| `GOOGLE_ADS_EM_USO` | global (env) | **TENANT_CONFIG** | flag de processo hoje; errada por tenant amanhã (`server.js:10755, 11949`) |
| `GOOGLE_ADS_SYNC_INTERVALO_MIN` | global (env) | PLATFORM_GLOBAL | **config morta: lida e nunca usada** (`server.js:10228`) |
| `META_APP_ID` / `META_APP_SECRET` | PLATFORM_GLOBAL | PLATFORM_GLOBAL | env — correto |
| `META_API_VERSION`, `META_BACKFILL_DIAS`, `META_SYNC_INTERVALO_MIN` | PLATFORM_GLOBAL | PLATFORM_GLOBAL | env |
| `INTERNAL_TOOLS_ENABLED` | PLATFORM_GLOBAL | **PLATFORM permission** | papel de platform admin, não env |
| `CREATIVE_TENANT_ID` | global (env) | **eliminar** | derivar do request |
| `CREATIVE_CORE_SERVICE_TOKEN` | PLATFORM_GLOBAL | PLATFORM_GLOBAL | env (correto) |
| `STORAGE_DIR`, `UPLOADS_DIR`, `IMG_CACHE_DIR`, `RAILWAY_VOLUME_MOUNT_PATH` | RUNTIME_INFRA | RUNTIME_INFRA → object storage | ver TD-007 |
| `SITE_BASE_URL` | global | **TENANT_CONFIG** (domínio do tenant) | `organizations` |
| `MIGRACAO_*` | RUNTIME_INFRA (scripts) | ferramenta interna | fora da tenant app |
| `app_config` (tabela) | global: `chave TEXT PRIMARY KEY` (`server.js:220-224`) | **dividir** | config de plataforma vs config por Organization |
| `multiStoreMode` (em `app_config`) | global, cosmético | **LEGACY / TO_REMOVE** (R-02) | não migra para o Oria |
| `INTERNAL_TOOLS_ENABLED` | PLATFORM_GLOBAL | **remover junto com a feature** (R-01), salvo se sobrar outro consumidor | — |

**Fato relevante sobre `app_config`:** ela mistura, no mesmo mecanismo e sem distinção estrutural,
config de plataforma (`entitlements`) e o que deveria ser config por loja (`settings-product`,
`multiStoreMode` — um booleano único para o sistema inteiro).

---

# D. Secrets

| Secret | Provider | Escopo hoje | Armazenamento atual | Armazenamento recomendado |
|---|---|---|---|---|
| `ADMIN_PASSWORD` | Oria | instalação | env, comparado com `timingSafeEqual` (`server.js:1773-1776`) | eliminar → hash por usuário |
| `ADMIN_SESSION_SECRET` | Oria | instalação | env | env — **mas separar do papel de chave de cifra** |
| Ink token (×3) | Reserva Ink | env por loja | `server.js:69-73` | `integrations` cifrado por Store |
| Ink webhook secret (×3) | Reserva Ink | env por loja | `server.js:70-72` | idem |
| Meta Ads access/refresh token | Meta | **1 linha global** | `meta_connections`, AES-256-GCM (`server.js:9591-9614`) | por Organization |
| Google Ads refresh token | Google | **1 linha global** | `google_ads_connections`, AES-256-GCM | por Organization |
| GA4 refresh token | Google | **por loja** ✔ | `google_analytics_connections` (`loja UNIQUE`, `server.js:729`), cifrado | por Store (já correto) |
| OpenAI BYOK | OpenAI | por `tenant_id` (fixo) | `creative_settings.openai_key_enc`, AES-256-GCM, contexto HKDF próprio (`lib/creative-core/byok.js:7`) | por Organization |
| `CREATIVE_CORE_SERVICE_TOKEN` | Oria ↔ creative-core | plataforma | env, `hmac.compare_digest` (`service.py:86-90`) | env (correto) |
| Token do agente WhatsApp Web | Oria | **1 por instalação** | hash em config (`server.js:12648`) | por Store |
| `WHATSAPP_WEBHOOK_SECRET` | Oria ↔ serviço Go | instalação | env, comparado com **`!==` simples** (`server.js:16234`) | por conexão, comparação timing-safe |

## Achados de manuseio de segredo

**FATO — nenhum segredo em texto plano.** Meta, GA4, Google Ads e OpenAI usam AES-256-GCM real.

**FATO — nenhum segredo devolvido ao browser.** Todos os GETs auditados (`/api/admin/integrations`,
`/meta/status`, `/google-ads/status`, `/google-analytics/properties`, `/criativos/settings/openai-key`)
retornam apenas booleanos, `last4` e metadados.

**FATO — masking em log existe no caminho da Meta.** `mascararToken()` cobre `access_token=`,
`client_secret=` e `Bearer <token>` (`lib/meta/client.js:73-78`). Webhooks gravam apenas *nomes* de
headers (`Object.keys(req.headers)`, `server.js:16140`) — a assinatura HMAC recebida nunca é persistida.

**FATO — CRITICAL: uma única raiz de confiança.** Todas as chaves de cifra derivam por HKDF de
`ADMIN_SESSION_SECRET` (`server.js:9585-9589`), que é o **mesmo** segredo que assina os cookies de
sessão. Consequências reais:

- vazar `ADMIN_SESSION_SECRET` compromete, de uma vez, as sessões de admin **e** todos os tokens de
  integração armazenados;
- rotacionar o segredo de sessão (resposta natural a um incidente de sessão) **torna ilegíveis todos
  os segredos guardados** — ou seja, a resposta a incidente está acoplada à perda de todas as
  integrações. Não há `key_version` para rotação incremental.

**FATO — comparação não timing-safe** no repasse do webhook de WhatsApp: `server.js:16234` usa `!==`.

**NÃO VERIFICADO:** se mensagens de erro da API do Google alguma vez ecoam token (não há função de
masking dedicada nesse caminho, ao contrário do caminho da Meta).

---

# E. Tabelas e tenancy

53 tabelas: 44 em `server.js:118-1131`, 9 em `lib/creative-core/schema.js`.
Matriz completa: [Anexo B](./anexo-b-matriz-de-tabelas.md).

## Distribuição

| Classificação | Qtde | Significado |
|---|---:|---|
| GLOBAL (sem discriminador) | 7 | toda linha é compartilhada |
| STORE_SCOPED (coluna `loja`) | ~22 | isolamento depende da query lembrar |
| CONNECTION_SCOPED | 10 | escopo herdado de uma conexão que é singleton |
| OTHER (herda por FK) | 3 | |
| TENANT_ID real | 9 | apenas `creative_*` |

> **Rodada 2:** as 4 tabelas `origens_migration_*` viram **LEGACY / TO_REMOVE** (R-01) e saem da
> conta de tabelas a tenantizar: **53 → 49**. **Nenhum `DROP` nesta etapa** — a remoção acontece por
> migration versionada, depois que a infra de migrations existir (TD-010). Até lá permanecem no
> banco, sem rota que as alcance.
>
> Com PD-002 (1:1), o discriminador a adicionar é **`organization_id`**. `store_id` continua
> existindo, mas não é um segundo eixo de isolamento a validar em toda query — é derivável da
> Organization. Uma query que esqueça `store_id` não vaza entre tenants; uma que esqueça
> `organization_id`, sim.

## Tabelas GLOBAL (nenhum discriminador)

`app_config` · `segments` · `whatsapp_web_mensagens` · `utm_presets` · `custos_api_precos` ·
`meta_connections` · `google_ads_connections`

**Impacto concreto:** `custos_api_precos` (`chave TEXT PRIMARY KEY`, `server.js:1124`) com
`ON CONFLICT (chave) DO UPDATE` em `PUT /api/admin/financeiro/custos-api/precos/:chave`
(`server.js:12094`) — **um tenant editando um preço mudaria o número financeiro de todos os tenants**.
O mesmo vale para `segments` (audiências de campanha) e `whatsapp_web_mensagens`.

## Colisões estruturais (blockers de schema, não de query)

| Constraint | Local | Por que bloqueia |
|---|---|---|
| `PRIMARY KEY id SMALLINT CHECK (id = 1)` | `meta_connections` (`server.js:765`) | literalmente 1 conexão Meta por banco |
| `PRIMARY KEY id SMALLINT CHECK (id = 1)` | `google_ads_connections` (`server.js:1006`) | idem para Google Ads |
| `UNIQUE(lower(nome))` | `whatsapp_web_mensagens` (`server.js:665`) | dois tenants não podem ter mensagem de mesmo nome |
| `dedupe_key` sem `loja` | `whatsapp_web_outbox` (`server.js:689`) | dedupe depende de o chamador embutir `loja` na `referencia` — confirmado só para `origem='pedido'` (`server.js:13787`) |
| UNIQUE em ids de provider | `meta_ad_accounts`, `meta_campaigns`, `google_ads_customers`… | id do provedor como chave, sem coluna de isolamento |
| `app_config.chave` PK | `server.js:220-224` | uma linha de config por sistema inteiro |

O comentário do próprio autor em `server.js:758-761` confirma que o desenho singleton foi deliberado:
*"se um dia voltar a ser multi-tenant, troca-se o PK por tenant_id"*.

## Queries sem filtro em tabelas store-scoped (vazamentos futuros)

| Onde | Local | Observação |
|---|---|---|
| `TRUNCATE controle_estoque_observacoes` sem WHERE | `server.js:8368` | apaga o estoque observado de **todas** as lojas |
| `media_assets` por id sequencial | `server.js:15358-15360, 15391-15401` | sem checagem de `loja` |
| `campaigns` — ~17 rotas `:id` | `server.js:9055…14849` | filtram só por `id` |
| `utm_campaigns` GET/PATCH/DELETE `:id` | `server.js:8849, 8878, 8897` | só por `id` |
| `despesas_operacionais` PUT/DELETE `:id` | `server.js:12042, 12061-12064` | só por `id` |
| `audit_log` — `listarAuditLog()` | `server.js:1254-1269` | filtra por `action`, nunca por `loja` |
| `pedidos_ink` UPDATE por payment_status | `server.js:1157-1160` | sem `loja` (backfill; risco baixo hoje) |

## Persistência

**FATO — produção pode iniciar sem Postgres.** `bootstrapPostgres().then(...).catch(err => console.error(...))`
(`server.js:1177-1181`) nunca bloqueia nem derruba o processo; `app.listen` (`server.js:16349`) roda
independentemente. Sem `DATABASE_URL`, `pgPool` é `null` e **cada rota decide sozinha**: ou cai para
JSON (`lerConfigPostgres`/`salvarConfigPostgres`, `server.js:1187-1204`), ou devolve 503.

Classificação por caminho de persistência:

| Caminho | Classificação |
|---|---|
| Postgres (com `DATABASE_URL`) | DATABASE_AUTHORITATIVE |
| `db/*.json` (13 arquivos: pedidos, automações, templates, entitlements, audit_log…) | LEGACY_FALLBACK — **autoritativo na prática quando não há Postgres** |
| `img-cache/` | CACHE |
| `uploads/` (`UPLOADS_DIR`) | FILE_STORAGE — depende de volume montado |
| `assets/pedidos/` | não usado para QR (gerado em memória, `server.js:1666-1679`) |
| `ga4_performance_cache` | CACHE |
| Guardas de job em memória | EPHEMERAL |
| `lib/creative-core/memoryStore.js` | EPHEMERAL / LOCAL_DEV_ONLY |

`db/`, `img-cache/`, `assets/pedidos/` e `docs/webhook-log.json` estão no `.gitignore` com
justificativa de PII; `git ls-files db/` confirma 0 arquivos rastreados.

**FATO — não há ferramenta de migrations.** O schema nasce por `CREATE TABLE IF NOT EXISTS` no boot.
Isso cria tabelas novas e não altera tabelas existentes com dados — que é exatamente o que adicionar
`organization_id` vai exigir.

---

# F. Rotas com risco multi-tenant

278 rotas inventariadas: 243 em `server.js`, 35 em `routes/criativos.js`.
Matriz completa com risco por linha: [Anexo A](./anexo-a-matriz-de-rotas.md).

| Classe | Qtde |
|---|---:|
| ADMIN (`requireAdmin`) | 219 |
| INTERNAL (`requireAdmin` + `requireInternalTools`) | 38 |
| PUBLIC | 15 |
| WEBHOOK | 2 |
| STATIC | 4 |

| Risco de tenancy | Qtde |
|---|---:|
| CRITICAL | 10 |
| HIGH | 38 |
| MEDIUM | 125 |
| LOW | 105 |

> **Rodada 2 — duas mudanças de leitura.**
>
> 1. **As 35 rotas `/api/admin/internal/origens-migration/*` são TO_REMOVE** (R-01). A superfície a
>    productizar cai de 278 para **~243**. Elas não são trabalho de tenancy.
> 2. **As ~125 rotas MEDIUM não precisam de checagem de posse — precisam parar de receber `loja`**
>    (TD-002). O risco é eliminado, não mitigado. Isso reduz B-05 de ~163 rotas para **~48**
>    (as 10 CRITICAL + ~38 HIGH), que continuam exigindo verificação de posse.

**FATO positivo:** **nenhuma rota administrativa está sem `requireAdmin`.** As únicas rotas
`/api/admin/*` sem o guard são legitimamente públicas: `login`, `logout`, `session` e os dois
callbacks OAuth (`server.js:9792`, `server.js:11330`), que não podem carregar o cookie por chegarem
como redirect do provedor e usam `state` como prova.

**FATO positivo:** **nenhum GET que muda estado.** Os 21 candidatos foram verificados manualmente e
todos eram falsos positivos.

## CRITICAL — identificador do cliente seleciona credencial ou conexão

Todas validam apenas `LOJAS[loja]` (pertencimento ao enum), nunca posse.

| # | Rota | Local | O que o parâmetro controla |
|---|---|---|---|
| 1 | `GET /integrations/google-analytics/connect` | `server.js:9770` | inicia OAuth GA4 **daquela loja** |
| 2 | `GET /integrations/google-analytics/properties` | `server.js:9845` | lista propriedades GA4 da loja pedida |
| 3 | `POST /integrations/google-analytics/property` | `server.js:9858` | grava a propriedade GA4 da loja pedida |
| 4 | `POST /integrations/google-analytics/disconnect` | `server.js:9872` | **revoga e apaga o refresh token** da loja pedida |
| 5-7 | `GET …/performance`, `…/performance/series`, `…/overview` | `server.js:10003, 10066, 10169` | lê analytics da loja pedida |
| 8 | `POST /integrations/google-ads/contas/:customerId/selecionar` | `server.js:10589` | seleciona conta e atribui `loja` |
| 9 | `POST /integrations/google-ads/contas/:customerId/loja` | `server.js:10625` | reatribui `loja` de conta já conectada |
| 10 | `POST /integrations/meta/select-account` | `server.js:11402` | seleciona conta de anúncios e atribui `loja` |

## HIGH — `:id` de recurso "de alguém", sem amarração ao autenticado

`category-jobs/:id*` (4656-4817) · `segments/:id` (8738, 8756) · `utm/campaigns/:id*` (8849-8994) ·
`campaigns/:id*` (~12 rotas, 9052-9492) · `financeiro/despesas/:id` (12042, 12061) ·
`financeiro/custos-api/precos/:chave` (12097, 12119) · `media/:id` (15358, 15391) ·
`whatsapp-templates/:nome*` (15501-15581) · `campos-customizados/:chave` (15697, 15725) ·
`whatsapp-web/mensagens/:id` (16033-16098) · `whatsapp-web/fila/:id/*` (13196, 13242) ·
`pedidos/:id` (16307) · `whatsapp-web-agente/:id/resultado` (12943).

A maioria valida formato (`UUID_RE`) ou nada. **A checagem de posse não existe porque o modelo de
auth não tem o conceito de dono** — não é um esquecimento pontual, é uma ausência estrutural.

## O caso mais grave: reembolso

`POST /api/admin/pedidos/:loja/:id/reembolsos` toma `loja` de `req.params` (input do cliente),
valida só a existência em `INK_STORES` (`server.js:3069-3073`), e usa esse valor para escolher o
**Bearer token da Ink** em `inkApiRequest`/`inkApiPost` (`server.js:1307-1333`).

Não há authorization boundary entre sessão e loja. Uma sessão admin válida pode executar um
**reembolso financeiro real contra qualquer loja** trocando um segmento da URL. Hoje isso é
aceitável (as três lojas são do mesmo dono); em multi-tenant é cross-tenant write com efeito
financeiro irreversível.

---

# G. Jobs com risco multi-tenant

16 jobs periódicos + worker de criativos + 1 backfill sob demanda, todos como `setInterval` no
**mesmo processo** do servidor web.

| Job | Local | Intervalo | Lock | Réplica dupla = ? |
|---|---|---|---|---|
| `processarFilaDeCampanhas` | — | 30 s | **`FOR UPDATE SKIP LOCKED`** (`server.js:14811-14820`) | seguro |
| `processarBulkCategoryJobs` | — | 15 s | **`FOR UPDATE SKIP LOCKED`** + `Idempotency-Key` (`server.js:15142-15150`) | seguro |
| worker de criativos | `lib/creative-core/pgStore.js:211-223` | — | **`FOR UPDATE SKIP LOCKED`** | seguro |
| `reconcilePendingInkPedidos` | `server.js:1501` | 5 min | **nenhum** | duplica |
| `jobIncrementalMeta` / `jobDiarioMeta` / `jobRenovarTokenMeta` | `server.js:11145` | 45 min / 6 h / 12 h | flag `let` em memória | duplica |
| `syncPedidosInkParaPostgres` | — | 1 h | memória | duplica |
| `sincronizarCatalogoInkTodasLojas` | `server.js:3634` | 1 h | memória | duplica |
| `sincronizarProdutosFeedTodasLojas` | `server.js:3476` | 12 h | memória | duplica |
| `sincronizarControleEstoqueTodasLojas` | `server.js:14365` | 15 min | memória | duplica |
| `persistirCarrinhosAbandonadosTodasLojas` | `server.js:13907` | 15 min | memória | duplica |
| `processarFollowUpsCarrinho` | `server.js:15178` | 15 min | memória, **estado em JSON** | **duplica mensagem de WhatsApp a cliente final** |
| `processarFollowUpsPix` | `server.js:15180` | 15 min | idem | idem |
| `processarFilaDeJanela` | `server.js:15181` | 15 min | idem | idem |
| `registrarPixPendentesFaltantes` | — | 15 min | idem | idem |
| **Google Ads** | — | **nenhum** | — | `GOOGLE_ADS_SYNC_INTERVALO_MIN` (`server.js:10228`) é lida e nunca usada — config morta |
| **GA4** | — | **nenhum** | — | dados ao vivo com cache de 20 min (`server.js:9988`) |

**Apenas 3 de ~16 jobs têm lock real.** Os quatro jobs de follow-up são os mais sérios: operam sobre
arquivos JSON (onde `FOR UPDATE` é impossível) e o efeito de uma execução dupla é uma mensagem de
WhatsApp duplicada para o cliente final.

**Fairness:** todos os loops "TodasLojas" são sequenciais com `try/catch` por loja — o erro de uma
loja não trava as demais. Mas não há budget nem timeout por loja: uma loja lenta atrasa as outras
no mesmo tick. Não existe rate limit por tenant; **noisy neighbour é risco real e não mitigado**.

**Rate limits de provider:**

| Provider | Retry | Backoff | Jitter |
|---|---|---|---|
| Meta | sim (`lib/meta/client.js:123-155`) | exponencial | sim |
| Google Ads | sim (`lib/google-ads/client.js:184-216`) | exponencial | sim |
| **Reserva Ink** | **não, na maioria das chamadas** (comentário em `server.js:4477-4478`) | só `comRetryInk` em catálogo/bulk | não |

O erro `INK API respondeu 429` (`server.js:1320, 1346, 1373`) se propaga cru em pedidos, estoque,
carrinho e follow-ups — sem nova tentativa até o próximo tick natural. Isso é coerente com os
sintomas registrados no snapshot do painel (429 em Promoções, ~15 s em Categorias).

**Erros engolidos:** a fase de setup (antes do loop por loja) de `reconcilePendingInkPedidos`,
`processarFollowUpsCarrinho`, `processarFollowUpsPix` e `processarFilaDeJanela` falha em **silêncio
total** — `.catch(() => {})` sem log (`server.js:1501, 15178, 15180, 15181`).

---

# H. Webhooks

| Provider | Endpoint | Tenant locator | Assinatura | Idempotência | Replay | Risco |
|---|---|---|---|---|---|---|
| Reserva Ink | `POST /api/webhooks/ink` (`server.js:16129`) | **testa o segredo de cada loja em sequência** (`identifyInkWebhookStore`, `server.js:1280-1291`) | HMAC, `timingSafeEqual` (`server.js:1271-1276`), `rawBody` preservado (`server.js:1637-1643`) | não no modo `meta_api` | não | **HIGH** |
| WhatsApp (status) | `POST /api/webhooks/whatsapp` (`server.js:16233`) | `wamid` → `campaign_recipients` | **nenhuma assinatura Meta neste repo**; repasse Go→Node com `?secret=` opcional comparado por **`!==`** (`server.js:16234`) | idempotente por construção (status só avança) | não | **HIGH** |

## Reserva Ink — como a loja é encontrada hoje

`identifyInkWebhookStore` **não** usa URL, header ou campo do payload. Ela itera as três lojas e
testa o HMAC recebido contra o segredo de cada uma; a primeira que casar é a dona do evento.

Análise para multi-tenant:

- **Se cada tenant tiver um segredo distinto**, o mecanismo *funciona* — um evento de A não seria
  atribuído a B, porque o HMAC de A não valida com o segredo de B.
- **Se dois tenants compartilharem o mesmo segredo por engano** (colagem de config, reuso de
  credencial, tenant que duplica a loja), **o primeiro da ordem de iteração vence silenciosamente** —
  sem erro, sem log de ambiguidade. O evento do tenant B cria pedido no tenant A.
- O custo é O(n) verificações de HMAC por evento recebido. Com centenas de tenants, cada webhook
  vira centenas de operações de criptografia.

**Comportamento correto já existente:** segredo ausente → falha fechado (o evento é apenas logado,
nunca aplicado). Evento não verificado **é** persistido em `webhook_eventos` e no log local, mas
nunca aplicado a um pedido.

**Replay:** o modo padrão `meta_api` despacha WhatsApp sem dedupe (`despacharWhatsapp`,
`server.js:12772-12783`). Só o modo `whatsapp_web` tem `dedupe_key` único — e essa constraint não
inclui `loja` (ver §E).

---

# I. Auth

## Estado atual

| Aspecto | Fato | Local |
|---|---|---|
| Modelo | uma senha compartilhada para o painel inteiro | `server.js:1756-1784` |
| Comparação de senha | `timingSafeEqual`, **precedida de `a.length === b.length &&`** | `server.js:1773-1776` |
| Sessão | `${expiresAt}.HMAC(expiresAt)` — o payload é **só o timestamp** | `server.js:1541-1545` |
| Identidade na sessão | **nenhuma** (sem user, role, tenant) | idem |
| Cookie | `HttpOnly; SameSite=Strict; Path=/`, `Secure` só em produção | `server.js:1780-1782` |
| TTL | 12 h | `server.js:1538` |
| Revogação | **impossível** — sem store de sessão; logout só apaga o cookie do navegador, uma cópia do token continua válida até expirar | `server.js:1786-1789` |
| CSRF | **nenhuma proteção** em rotas `/api/admin/*` de escrita (mitigado parcialmente por `SameSite=Strict`) | — |
| Segredos ausentes | **falha fechada** ✔ (503 no login; `verifySession` retorna false) | `server.js:1759-1762, 1548-1549` |
| Rate limit de login | 10 tentativas / 15 min por `req.ip` | `server.js:1764` |

## Limitações

1. **Sem identidade** → audit log não pode atribuir ação a pessoa; offboarding de funcionário do
   cliente é impossível sem trocar a senha de todos.
2. **Sem revogação** → um token vazado vale 12 h, sem recurso.
3. **`req.ip` sem `trust proxy`** — o app não chama `app.set('trust proxy', …)`. Atrás de Cloudflare
   + Railway, `req.ip` tende a ser o IP do proxy, então o limiter de login vira um balde
   **compartilhado por todos**: simultaneamente inútil como throttle por atacante e capaz de
   bloquear o login legítimo de todos após 10 tentativas de qualquer origem.
4. **Comparação de senha vaza o comprimento** por tempo (o curto-circuito de `length` roda antes do
   `timingSafeEqual`). Impacto baixo, mas é fato.
5. **Sem cabeçalhos de segurança**: não há `helmet`, CSP, HSTS nem `X-Frame-Options` no app.
6. **Sem CORS configurado** — o que aqui é *positivo*: o default do Express é o mais restritivo.

## Separação plataforma / tenant / interno

**FATO — não existe platform admin.** Há um único nível de admin, sem papel (comentário explícito em
`server.js:1582-1585`).

As ferramentas internas estão, porém, **bem contidas**: todas as ~28 rotas `/api/admin/internal/*`
têm `requireAdmin + requireInternalTools`, com 404 deliberado quando a flag está desligada
(`server.js:1585-1589`). A única exceção é `internal-tools/status` (`server.js:4826-4828`), que é o
endpoint que informa à UI se deve mostrar o menu — intencional.

Lacuna menor: a rota React `/admin/internal/origens-migration` (`App.tsx:100`) não tem guard
client-side; depende só do 404 do backend. Isso é aceitável (o backend é a fronteira real) mas
produz uma tela quebrada em vez de um 404 limpo.

> **Decisão da rodada 2 (R-01):** a Migração Use Origens **sai do produto**. Toda esta superfície —
> 35 rotas, página, item de menu, clientes de API, e as flags `INTERNAL_TOOLS_ENABLED` /
> `requireInternalTools` se não sobrar outro consumidor — é **TO_REMOVE**, não trabalho de
> productização. A lacuna do guard client-side deixa de importar: a tela não existirá.
>
> **A separação conceitual entre tenant app e platform admin (addendum §19) continua valendo** — ela
> apenas deixa de ter esta ferramenta como caso de uso. Um platform admin real ainda precisa existir
> para suporte e operação SaaS, e continua não existindo hoje.

## Naming

| String | Ocorrências | Classificação | Onde aparece ao cliente |
|---|---:|---|---|
| `admin`, `/api/admin`, `adminState`, `AdminShell` | 762 / 488 / 28 / 1 | INTERNAL_CODE_NAME | nunca exibido |
| `Orgulho Regional` | 27 | **CUSTOMER_VISIBLE_NAME** | sidebar e `document.title` (dinâmico via `/api/admin/settings/product`, `AppShell.tsx:228,231,260-264`), mas **fixo** em `admin/index.html:7` e `LoginPage.tsx:27` |
| `Central operacional` | — | CUSTOMER_VISIBLE_NAME | tagline fixa (`AppShell.tsx:265`) |
| `Use Origens` | 17 | TENANT_BRAND / LEGACY | ferramenta interna de migração e nomes das lojas (`server.js:58`) |
| `orgulhoregional` | 5 | INTERNAL_CODE_NAME | diretório/projeto |

**Conclusão de naming:** o nome do produto já é parcialmente dinâmico — o trabalho de rebranding para
Oria é menor do que parece. Os pontos fixos são a aba do navegador (`index.html`), a tela de login e
a tagline. **Nenhum rename foi executado nesta auditoria**, conforme o addendum §2.

---

# J. Integrações

## Reserva Ink

| | |
|---|---|
| Dados do cliente | token por loja, secret de webhook, URL de feed |
| Secrets | `INK_TOKEN_*`, `INK_WEBHOOK_SECRET_*` — **em env da plataforma** |
| IDs | loja como chave de enum |
| Descoberta automática | nenhuma |
| OAuth/manual | manual (env) — não há UI de cadastro de token |
| Webhook | `POST /api/webhooks/ink`, loja por tentativa de segredo |
| Teste de conexão | saúde por loja exibida em Integrações |
| **Lacuna principal** | a Ink não é uma integração no modelo de dados — é uma premissa do código |

## Meta Ads

| | |
|---|---|
| Secrets | access/refresh token cifrados em `meta_connections` — **1 linha global** (`CHECK (id = 1)`) |
| Plataforma vs tenant | `META_APP_ID`/`META_APP_SECRET` são da plataforma (correto); o token é do tenant (escopo errado hoje) |
| OAuth | `state` nonce em memória, single-use, verificado antes da troca de `code` (`server.js:11317-11338`) — CSRF OK |
| Tenancy no callback | decidida no servidor; o cliente não injeta a loja ✔ |
| Recurso → loja | `meta_ad_accounts.loja_atribuida`, definida por `POST /meta/select-account` |
| Webhook | não aplicável (sync por job) |
| Revogação no provedor | **não** — desconectar só limpa colunas locais |

## Meta WhatsApp (domínio distinto — addendum §10)

| | |
|---|---|
| Credenciais | `WHATSAPP_SERVICE_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_WEBHOOK_SECRET` — serviço Go externo |
| WABA / phone | **1 conta para a instalação inteira** (`server.js:291`) |
| App id da Meta | em `app_config`, via Integrações |
| Assinatura do webhook | verificada pelo serviço Go (fora deste repo); o repasse Go→Node usa `?secret=` com `!==` |
| Modo alternativo | `whatsapp_web`: fila `whatsapp_web_outbox` + agente local com **1 token por instalação** |
| **Confirmação** | Meta Ads e Meta WhatsApp são, de fato, integrações distintas: credenciais, recursos, lifecycle e webhooks diferentes. Não devem virar uma entidade "Meta" única. |

## Google (GA4 + Google Ads)

Compartilham `GOOGLE_CLIENT_ID`/`_SECRET` (credenciais da plataforma — correto), mas são conexões
separadas com ownership **diferente**:

| | GA4 | Google Ads |
|---|---|---|
| Tabela | `google_analytics_connections` | `google_ads_connections` |
| Escopo | **por loja** (`loja UNIQUE`, `server.js:729`) ✔ | **global** (`CHECK (id = 1)`, `server.js:1006`) ✘ |
| Cache | `ga4_performance_cache` com `UNIQUE(loja, periodo)` (`server.js:754`) — sem colisão ✔ | `google_ads_insights_daily` por customer |
| OAuth state | `{loja, criadoEm}` em memória, loja decidida **antes** do redirect (`server.js:9776-9777, 9825`) ✔ | `state` assinado por HMAC, sobrevive a restart (`server.js:10323-10337`), verificado com `safeEqual` ✔ |
| Revogação no provedor | não | **sim** (`GOOGLE_REVOKE_URL`, `server.js:10379-10388`) ✔ |
| Job de sync | nenhum (ao vivo, cache 20 min) | **nenhum** — config de intervalo é morta |

**GA4 é o único caso de integração já modelada por loja de forma correta.** Serve como referência do
padrão-alvo.

## OpenAI (BYOK)

| | |
|---|---|
| Armazenamento | `creative_settings.openai_key_enc`, AES-256-GCM, contexto HKDF próprio (`lib/creative-core/byok.js:7`) |
| Devolvida ao browser | **nunca** — só `last4` |
| Log | nenhum ponto de log da chave encontrado |
| Fallback de plataforma | **não existe** — sem BYOK, não gera. Cada tenant paga com a própria chave ✔ |
| Teste | `GET https://api.openai.com/v1/models` (sem custo de geração) |
| Escopo | por `tenant_id` — **mas o `tenant_id` vem de env, não do request** |

Esta é a integração mais próxima do padrão SaaS correto no repositório.

## creative-core (serviço Python)

| | |
|---|---|
| Autenticação Node→Python | bearer token compartilhado `CREATIVE_CORE_SERVICE_TOKEN`, ≥32 chars, `hmac.compare_digest` (`service.py:86-90`) ✔ |
| Tenant context transmitido | **nenhum** — `requests.js:149-201` não envia `tenant_id` nem organização |
| Correlation/request id | **não propagado** |
| Credencial OpenAI | viaja **no corpo JSON** (`openai_api_key`), nunca em header (`client.js:90-94`) |
| Confiança | o serviço é stateless e confia 100% que o Node já filtrou por tenant |
| Exposição de rede | faz bind em `[::]:$PORT` (todas as interfaces); a única proteção é uma recomendação em README, **não garantida por código** |

**Leitura:** a fronteira está *hoje* protegida por um token de serviço forte, e o fato de nenhum
tenant context atravessar é consistente com o desenho single-tenant. Ao introduzir tenants reais,
o tenant precisa atravessar essa fronteira — e, quando atravessar, terá de ser derivado no Node e
jamais aceito do browser.

## Custos de API

Consumo (tokens) é gravado por linha em `creative_generations`, atribuível a tenant/job/geração ✔.
A **tabela de preços é global** (`custos_api_precos`) ✘. Custos em USD não são convertidos
(`lib/custos/precos.js:20`) e **não entram na DRE principal** — são tela separada.

---

# Financeiro / DRE

| Entrada | Fonte | Escopo hoje | Timezone | Moeda |
|---|---|---|---|---|
| Receita | `pedidos_ink` | por loja, **sempre filtrado** ✔ (`server.js:11895`) | `AT TIME ZONE 'America/Sao_Paulo'` em SQL | BRL implícito |
| Custo de produção | `pedidos_ink_itens` | por loja ✔ | idem | BRL implícito |
| Mídia Meta | `meta_insights_daily` | por conexão **global** | data reportada pelo provedor, sem realinhamento | `currency` exibida, **nunca convertida nem checada** (`server.js:11925-11951`) |
| Mídia Google Ads | `google_ads_insights_daily` | por conexão **global** | idem | idem |
| Despesas | `despesas_operacionais` | por loja ✔ (`server.js:11989`) | **UTC puro em JS** (`lib/financeiro/despesas.js:30-73`) — inconsistente com o SQL | BRL implícito |
| Custos de API | `custos_api_precos` | **global** ✘ | — | USD default, não convertido |
| Reembolsos | Ink + `audit_log` | por loja (via `:loja` do cliente) | — | BRL |

**Achados:**

- **Inconsistência de fuso entre módulos:** o SQL do dashboard usa `America/Sao_Paulo`; a expansão de
  recorrência de despesas usa UTC puro. Os dois números aparecem na mesma DRE.
- **Moeda somada sem verificação:** o `currency` da conta de mídia é exibido mas nunca convertido nem
  validado antes de entrar no total. Uma conta em USD somaria a reais sem aviso.
- **Atribuição de mídia — correção importante:** `loja = req.query.loja || conta.loja_atribuida || lojaAtribuidaPadrao() || ''`
  (`server.js:12256`). Com 3 lojas cadastradas, `lojaAtribuidaPadrao()` retorna sempre `null`
  (`server.js:11873-11876`), então sem `loja_atribuida` o endpoint **falha explicitamente com 409
  `META_LOJA_NAO_DEFINIDA`** — **não há fallback silencioso hoje**. O risco é outro e real: a função
  **auto-atribui sem perguntar quando existe apenas uma loja**, que é exatamente o caso do tenant
  SaaS típico. O que hoje é inofensivo torna-se "silenciosamente correto até não ser".
- **`req.query.loja` tem precedência sobre o valor salvo no banco** — qualquer sessão pode misturar o
  gasto de uma loja com o financeiro de outra trocando o parâmetro.
- `GOOGLE_ADS_EM_USO` é flag global de processo; só controla se a ausência de conexão vira aviso
  (`server.js:10755, 11949`).

## F-01 — A regra fail-closed de atribuição é violada hoje

**Prioridade:** **P1 hoje**, **P0 a partir do segundo tenant** · **Risco:** HIGH · **Esforço:** M

Verificação feita após o fechamento de PD-016/PD-021, que estabelecem:

> Se um recurso estiver não atribuído ou ambíguo, não deve entrar silenciosamente na DRE.

A regra cobre **recurso** — ad account, Google Ads customer, GA4 property, conexão OAuth e
gasto/custo. É uma regra **fail-closed de atribuição**: diante de ambiguidade, excluir e sinalizar.

### O que já está conforme

| Comportamento | Local |
|---|---|
| Provedor **não conectado** é excluído do total e entra em `faltando` → vira aviso | `lib/financeiro/consolidado.js:37-51` |
| Sem `loja_atribuida` resolvível, o endpoint **recusa** com 409 `META_LOJA_NAO_DEFINIDA` | `server.js:12256-12262` |
| Despesa não cadastrada vai como `null`; Lucro Operacional fica desconhecido em vez de fingir custo zero | `server.js:12277-12280` |
| GA4 é consultado **com** a loja | `atribuicaoGA4(loja, …)` |

O mecanismo de "excluir e sinalizar" **já existe e funciona** — para o caso de provedor ausente.

### O que viola

| # | Violação | Local |
|---|---|---|
| 1 | **`fontesDeMidia(from, to)` não recebe loja nenhuma.** Soma o gasto da conta Meta globalmente selecionada e o custo do customer do Google Ads globalmente selecionado, sem confrontar `loja_atribuida` com a loja cuja receita está sendo usada. O total vai direto para `montarResultado` junto de `financeiroDaLoja(loja, …)` | `server.js:11921-11949`, combinado em `12266-12283` |
| 2 | **A atribuição do Google Ads nunca é consultada no caminho da DRE.** `contaGoogleAdsSelecionada()` devolve o customer selecionado e seu custo é somado incondicionalmente — um customer atribuído a outra loja contribui gasto para esta DRE, em silêncio | `server.js:10454`, `11936-11947` |
| 3 | **`?loja=` sobrescreve a atribuição salva**, e o comentário do código declara isso como recurso intencional ("override por query pra a tela poder comparar cenários"). Produz receita de uma loja contra gasto de outra, sem marcar que os escopos divergem | `server.js:12256` |
| 4 | **`lojaAtribuidaPadrao()` auto-atribui quando existe exatamente uma loja.** O comentário assume que com uma loja "a resposta é óbvia" — mas **uma loja é exatamente o caso do tenant SaaS** (PD-002). Hoje inofensivo (3 lojas → `null`); na V1, default silencioso em **100% dos tenants** | `server.js:11873-11876` |

### Leitura

A violação é de **escopo**, não de conexão. O código foi cuidadoso com "e se o provedor não estiver
conectado?" e não com "e se o recurso conectado pertencer a outro escopo?". Com três lojas do mesmo
dono isso era uma imprecisão tolerável; com a cardinalidade 1:1 da V1, o item 4 deixa de ser exceção
e vira o caminho padrão.

O item 2 é o mais grave dos quatro: a atribuição do Google Ads não é apenas sobrescrevível — ela
**nunca é lida** nesse caminho.

**Comportamento-alvo:** a apuração de mídia recebe o escopo do tenant e descarta, marcando como não
atribuído, qualquer recurso cuja atribuição não bata — exibindo a pendência em vez de absorvê-la.
O mecanismo `faltando`/`avaliarQualidade` é o lugar natural para isso.

---

# Clientes e PII

**Não existe tabela `customers`.** A tela é derivada de `pedidos_ink`
(`admin/src/api/clientes.ts:26-36` → `server.js:8380, 8402`).

**Identidade:** union-find sobre documento / telefone / e-mail, **agrupado por loja primeiro**
(`server.js:8441-8447`). **FATO: o mesmo telefone em duas lojas é hoje 2 clientes distintos.**
Isso responde empiricamente metade de PD-017 — a decisão é se isso deve continuar assim.

## Inventário de PII

| Dado | Onde | Máscara | Exposição |
|---|---|---|---|
| Nome, telefone, documento, e-mail | `pedidos_ink` | telefone só em **uma** tela de campanha (`mascararTelefone`, `server.js:9412`, usada em 9515) | texto pleno em `/api/admin/clientes` e `/api/admin/dashboard/customers` |
| Payload cru da Ink | `webhook_eventos.body` (JSONB, `server.js:206-216`) | **nenhuma redação** | **sem retenção nem limpeza — nenhum `DELETE FROM webhook_eventos` existe** |
| Nome do comprador + resposta da Ink | `audit_log` (`before.cliente`, `after`, `server.js:3116`) | nenhuma | exposto por `GET /api/admin/reembolsos` |
| Nome, valor, status, código PIX | `/api/pedidos/:id` — **público** (`server.js:16320`) | — | URL-capacidade de ~72 bits, **sem expiração** |
| QR do PIX | `/assets/pedidos/:filename` — **público** (`server.js:1666`) | — | mesmo modelo de capacidade; gerado em memória, validado por regex estrita (sem path traversal) |

**FATO:** não existe endpoint de exclusão nem de exportação de dados de cliente. Registrado como
fato, não como parecer jurídico.

---

# Testes, observabilidade e deploy

## Testes

`npm test` → **234 testes: 228 passam, 0 falham, 6 pulados.**

Cinco dos pulados exigem `META_TEST_DATABASE_URL` / `GOOGLE_ADS_TEST_DATABASE_URL`. O sexto
(`test/creative-core-pg.test.js:14`, exige `CREATIVE_TEST_DATABASE_URL`) é **o único teste de
isolamento por tenant do repositório — e ele não roda neste ambiente.**

| Área | Cobertura |
|---|---|
| auth / sessão real | **nenhuma** |
| escopo de loja nas rotas HTTP | **nenhuma** |
| entitlements | **nenhuma** |
| secrets | **nenhuma** |
| roteamento/assinatura de webhook | **nenhuma** |
| ownership de campanha/criativo/mídia | **nenhuma** |
| frontend `admin/` | **nenhuma suíte** (sem script `test`, sem `*.test.*`) |

O que os 228 testes cobrem é real e útil (clientes de Meta/Google Ads, SQL de custos, financeiro da
Ink, fila de recuperação, creative-core, arquivos públicos) — mas **nenhum deles é um teste de
isolamento**, que é justamente o que a productização exige.

## Observabilidade

24 `console.log`, 262 `console.error`, 13 `console.warn` em `server.js`. **Nenhuma biblioteca de log
estruturado, nenhum request/trace id, nenhum healthcheck, nenhum error tracking.** `mascararToken`
protege ~15 pontos do caminho da Meta. Uma busca dirigida por PII/token/senha nos `console.*` não
encontrou vazamento direto (não foi varredura exaustiva dos 262 pontos).

## Deploy e persistência

Processo único (`node server.js`). **Não há Procfile, railway.json, nixpacks nem Dockerfile no
repositório.** `UPLOADS_DIR`, `db/` e `img-cache` dependem de `RAILWAY_VOLUME_MOUNT_PATH`/`STORAGE_DIR`
apontarem para volume montado; sem isso ficam no filesystem efêmero e **são perdidos a cada
restart/redeploy** (`server.js:36-56`).

**Nenhum segredo commitado foi encontrado** (sem `.env` versionado, sem padrão de chave/token/PEM).

---

# K/L. Decisões pendentes

Todas em [`productization-decisions.md`](./productization-decisions.md):

- **PD-001 a PD-020** — decisões de produto. Novas em relação ao levantamento original:
  PD-016 (ownership de conta de mídia), PD-017 (identidade/dedup de clientes),
  PD-018 (ownership de criativos), PD-019 (como a Use Origens vira Tenant #1),
  PD-020 (política de custos de API).
- **TD-001 a TD-012** — decisões técnicas.

Nenhuma foi decidida. Todas estão `OPEN`.

---

# M. Riscos

## CRITICAL

| # | Risco | Evidência |
|---|---|---|
| R-01 | Tenant context controlado pelo cliente | `adminState.ts:8-16` → `req.query/body/params.loja`; validação só de enum |
| R-02 | Entitlements inexistentes no backend | `server.js:13369-13372` (comentário do autor), zero checagens em rotas |
| R-03 | Conexões Meta/Google Ads são single-row por schema | `server.js:765, 1006` |
| R-04 | Uma única raiz de confiança criptográfica | `server.js:9585-9589` (HKDF de `ADMIN_SESSION_SECRET`) |
| R-05 | Reembolso financeiro contra loja escolhida pelo cliente | `server.js:3069-3073` → `1307-1333` |
| R-06 | Sem identidade → sem audit atribuível, sem revogação | `server.js:1541-1545, 1786-1789` |
| R-07 | Postgres opcional em produção, degradação silenciosa | `server.js:1177-1181, 16349` |
| R-08 | Zero testes de isolamento executáveis | `test/creative-core-pg.test.js:14` (pulado) |

## HIGH

| # | Risco | Evidência |
|---|---|---|
| R-09 | 13 de ~16 jobs sem lock persistente; follow-ups duplicariam WhatsApp | `server.js:15178-15181` |
| R-10 | Roteamento de webhook por tentativa de segredo; colisão silenciosa | `server.js:1280-1291` |
| R-11 | ~38 rotas `:id` sem checagem de posse | Anexo A |
| R-12 | Tabelas globais com efeito cross-tenant (`custos_api_precos`, `segments`, `whatsapp_web_mensagens`) | `server.js:1124, 665` |
| R-13 | Agente WhatsApp Web: 1 token por instalação, `claim` sem filtro de loja | `server.js:12830-12908` |
| R-14 | `webhook_eventos` guarda PII crua sem retenção | `server.js:206-216` |
| R-15 | Sem rate limit por tenant; noisy neighbour | ausência |
| R-16 | Ink sem retry/backoff na maioria das chamadas | `server.js:4477-4478` |
| R-17 | Sem migrations versionadas | `CREATE TABLE IF NOT EXISTS` no boot |
| R-18 | Volume necessário para não perder uploads/JSON | `server.js:36-56` |
| **R-33** | **Atribuição de mídia entra na DRE sem conferir escopo (F-01)** — viola PD-021; o caso do Google Ads nunca consulta a atribuição | `server.js:11921-11949, 10454, 12256, 11873-11876` |

## MEDIUM

R-19 sem CSRF em escritas (mitigado por `SameSite=Strict`) · R-20 `req.ip` sem `trust proxy` torna o
rate limit de login compartilhado · R-21 inconsistência de timezone entre SQL e JS · R-22 moeda de
mídia somada sem conversão · R-23 sem cabeçalhos de segurança (CSP/HSTS/X-Frame-Options) ·
R-24 sem log estruturado, request id ou healthcheck · R-25 `TRUNCATE` sem WHERE em estoque observado ·
R-26 `media_assets` por id sequencial sem checagem de dono · R-27 revogação de token não propagada ao
provedor (Meta, GA4) · R-28 erros de job engolidos sem log.

## LOW

R-29 senha vaza comprimento por timing · R-30 `/api/pedidos/:id` e o QR público como URL-capacidade
sem expiração · R-31 `GOOGLE_ADS_SYNC_INTERVALO_MIN` é config morta · R-32 rota React interna sem
guard client-side.

---

# N. Arquitetura-alvo

**RECOMENDAÇÃO.** Validada contra o código real, não apenas herdada do documento de intenção.

**Atualizada para a cardinalidade 1:1 fechada em PD-002.**

```text
                        ORIA PLATFORM
                              │
              ┌───────────────┴───────────────┐
              │                               │
         User (identidade)            Platform Admin
              │                         (suporte/operação SaaS)
        organization_members
              │
        Organization ◄──── plano / entitlements / billing / timezone / moeda
              │              clientes · campanhas · criativos · conexões de mídia
              │
            Store            ◄── 1:1 na V1 (entidades separadas, cardinalidade única)
              │                   pedidos · catálogo · estoque · trocas · reembolsos
              │
        Integrations
              │
 ┌────┼───────┬──────────┬──────────┐
 │    │       │          │          │
Ink  WhatsApp Meta Ads Google Ads  GA4     + OpenAI BYOK (Organization)
                                             + creative-core (serviço)
```

Um mesmo dono com duas lojas tem **dois workspaces independentes**, isolados entre si como
quaisquer clientes distintos:

```text
User
├── Organization A └── Store A
└── Organization B └── Store B
```

## Pipeline de request (alvo — fechado em TD-002)

```text
authenticateUser          → sessão carrega user_id (hoje: só timestamp)
      ↓
resolveOrganization       → da sessão, NUNCA do browser
      ↓
verifyMembership          → organization_members
      ↓
resolveOrganizationStore  → a única Store ativa do workspace
      ↓
checkEntitlement          → fail-closed (hoje: não existe)
      ↓
handler                   → query já recebe organization_id do contexto
```

Se alguma rota tecnicamente receber `store_id`, ainda assim valida que pertence à Organization
autenticada. Mas o caso normal é **não receber**: a Store é derivada do workspace.

## Onde cada peça de hoje se encaixa

| Peça atual | Encaixa? |
|---|---|
| `google_analytics_connections` (por loja) | **sim** — é o padrão de referência |
| `creative_*` (tenant_id em tudo) | **sim** — só a origem do `tenant_id` muda |
| Fila de campanhas (`FOR UPDATE SKIP LOCKED`) | **sim** |
| `requireAdmin` | vira `authenticateUser` + o resto do pipeline |
| `meta_connections` / `google_ads_connections` | **não** — schema a refazer |
| `INK_STORES` em env | **não** — vira `integrations` |
| `LOJAS` enum | **não** — vira tabela `stores` |

---

# O. Roadmap

**RECOMENDAÇÃO.** Fases ajustadas ao que a auditoria encontrou. Cada fase deve ser verificável
sozinha.

| Fase | Conteúdo | Depende de |
|---|---|---|
| **0 — Foundations** | Migrations versionadas (TD-010); Postgres obrigatório em produção (TD-003); chave de cifra separada de `ADMIN_SESSION_SECRET` com `key_version` (TD-004); log estruturado com request id; healthcheck | — |
| **1 — Tenancy** | `organizations`, `stores` (1:1), `organization_members`; `organization_id` nas **49** tabelas; refazer `meta_connections`/`google_ads_connections`; RLS como rede de segurança | Fase 0, TD-001 |
| **2 — Auth** | `users`, hash por usuário, sessão com identidade, revogação, papéis mínimos, audit atribuível, CSRF, `trust proxy` | Fase 1, PD-004 |
| **3 — Tenant context + entitlements** | middleware único (`resolveOrganization` → `resolveOrganizationStore` → `checkEntitlement`); **remover `loja` dos endpoints**; entitlements fail-closed | Fase 2, TD-002 ✔, TD-012 |
| **4 — Integrations** | `integrations` + `integration_secrets`; migrar `INK_TOKEN_*` de env; self-service; teste de conexão; revogação no provedor; **atribuição fail-closed (F-01)** | Fase 3, PD-006, PD-016 ✔ |
| **5 — Webhooks + jobs tenant-aware** | URL opaca por conexão (TD-005); idempotência e replay; leasing persistente e budget por tenant (TD-006); **+ o serviço Go — ver abaixo** | Fase 4, **PD-023** |
| **6 — Operação interna como tenant** | migração in-place; dogfooding; **sem bypass**; 3 Organizations ou 1, conforme a consolidação | Fase 5, PD-019 ✔ |
| **7 — Onboarding** | wizard, estado de onboarding, validação progressiva | Fase 6 |
| **8 — Hardening** | object storage (TD-007), retenção/LGPD (PD-010), rate limit por tenant, testes de isolamento obrigatórios em CI, cabeçalhos de segurança | contínua |

## Trabalho de remoção (não é fase; distribuído)

| Item | Quando | Nota |
|---|---|---|
| Rotas/página/menu/flags da Migração Use Origens (R-01) | antes ou durante a Fase 1 — reduz a superfície a tenantizar | remover a feature, **não** as tabelas |
| `DROP` das tabelas `origens_migration_*` | **só depois da Fase 0** (TD-010) | por migration versionada |
| `multiStoreMode` (R-02) | Fase 3, junto da remoção de `loja` dos endpoints | |

## O que saiu do roadmap com a remoção do multi-store

Trabalho que a rodada 1 previa e que **deixou de existir**: seletor de Store · visão consolidada
entre Stores · DRE multi-store · campanhas cross-store · catálogo compartilhado · rateio de mídia
entre Stores · modelagem de `max_stores` como entitlement · a tabela "por domínio, é Organization ou
Store?" · o eixo `store_id` como segundo discriminador a validar em toda query.

## Os invariants como critério de fase (rodada 3)

Os [24 invariants](#invariants-obrigatórios-antes-do-segundo-tenant) substituem "testes de
isolamento" como critério de conclusão. Mapeamento:

| Fase | Invariants que devem passar ao final |
|---|---|
| 0 — Foundations | INV-14 (+ **OPS-01..OPS-05** verificados no deploy, fora do CI) |
| 1 — Tenancy | INV-04, INV-05, INV-06, INV-07 |
| 2 — Auth | INV-02, INV-21 |
| 3 — Tenant context | INV-01, INV-03, INV-08, INV-09, INV-10, INV-24, INV-23 |
| 4 — Integrations | INV-11, INV-12, INV-13 |
| 5 — Webhooks + jobs | INV-15, INV-16, INV-17, INV-18, **INV-25** |
| 6 — Operação interna | todos (é o dogfooding) |
| 8 — Hardening | INV-19, INV-20, INV-22 |

## A janela coordenada do WhatsApp

A Fase 5 deixa de ser uma fase de um repositório só. A restrição vem de **WG-09/INV-35**: o painel
lê a identidade do remetente do `/health` do serviço Go (`server.js:15213` ← `sender.go:443-449`).
Esse contrato precisa ser **removido**, não estendido — e ele **não se parte ao meio**.

**Sub-fase 5a — preparação independente, sem coordenação** *(pode começar a qualquer momento, até
antes da Fase 0)*

| Repositório | Trabalho | Esforço |
|---|---|---|
| Go | Correções de segurança sem relação com tenancy: HMAC fail-closed (WG-06), comparação em tempo constante (WG-07/09), chave fora da query string (WG-10/WG-20), idempotência (WG-08) | **S** |
| Go | Identidade do remetente como parâmetro de `metaPost` — 9 call sites, **mantendo** o default de env como fallback | **S** |

O segundo item é o truque de sequenciamento: **escopar a saída sem quebrar o contrato**. O serviço
passa a aceitar a identidade por requisição e continua funcionando para quem não a envia.

**Sub-fase 5b — a janela coordenada** *(os dois repositórios, no mesmo deploy)*

1. Painel passa a **enviar** a identidade do remetente em toda chamada de envio.
2. Serviço **deixa de aceitar** a ausência dela (o fallback de env some).
3. Serviço **remove** `phone_number_id` do `/health` (INV-35).
4. Painel **para de ler** identidade do `/health` (`server.js:15213`).

Ordem obrigatória: **1 antes de 2**, **3 e 4 juntos**. Executados fora de ordem, ou o envio quebra
ou o painel perde a identidade.

**Sub-fase 5c — o caminho de entrada** *(reescrita, esforço L, depende de PD-023)*

Roteamento do webhook por tenant, credenciais por tenant cifradas, re-chaveamento dos stores.
**É aqui que a topologia decide o tamanho**: com processo por Organization, boa parte desaparece.

## Dependências de sequenciamento descobertas na rodada 4

| Pré-requisito | Bloqueia | Origem | Estado |
|---|---|---|---|
| ~~Verificar o domínio público do `creative-lab`~~ | ~~Fase 0~~ | D-1 | ✅ **resolvido** — rede privada confirmada; virou OPS-01, controle contínuo de deploy |
| **Auditar o repositório `whatsapp-webhook-go`** — ele detém o `phone_number_id` e não foi auditado | **Fase 5** | D-2 | ⬜ **pendente** |
| Eliminar a agregação cross-store (PD-022) | **Fase 3**, e é pré-requisito da migração | PD-022 | decidido, a executar |

**Com D-1 fechado, o `whatsapp-webhook-go` é a única lacuna de cobertura restante da auditoria.**
Existe um serviço em produção, noutro repositório, que participa do caminho de mensagem e cuja
tenancy é desconhecida. O brief de auditoria dele está em
[`whatsapp-webhook-go-audit-brief.md`](./whatsapp-webhook-go-audit-brief.md), pronto para ser
entregue a quem trabalhar naquele repositório.

Uma fase só está concluída quando os invariants dela passam **em CI**, não quando o código foi
escrito.

**Testes de isolamento não são uma fase** — entram junto com a Fase 1 e crescem a cada fase.
Com PD-002 fechada, o cenário simplifica de `Org A/A1 · Org A/A2 · Org B/B1` para
**`Org A/Store A · Org B/Store B` + tentativa explícita de acesso cruzado**. Sem eles, nenhuma fase
pode ser declarada concluída.

---

# P. Quick wins

**RECOMENDAÇÃO.** Mudanças de baixo risco, valiosas hoje, que **não dependem** da tenancy e não
conflitam com o refactor futuro. **Nenhuma foi implementada** — a fase é auditoria.

| # | Quick win | Esforço | Por que agora |
|---|---|---|---|
| QW-01 | Configurar `trust proxy` no Express | XS | o rate limit de login hoje é um balde compartilhado (R-20) |
| QW-02 | Log dos `.catch(() => {})` nos 4 jobs | XS | falhas de follow-up são invisíveis hoje (R-28) |
| QW-03 | Timing-safe no segredo do webhook de WhatsApp | XS | `server.js:16234` |
| QW-04 | Trocar o `TRUNCATE` de estoque observado por `DELETE … WHERE loja = $1` | XS | R-25 |
| QW-05 | Healthcheck + request id nos logs | S | pré-requisito de toda observabilidade futura |
| QW-06 | Cabeçalhos de segurança (`helmet`) | S | R-23 |
| QW-07 | Retenção/limpeza de `webhook_eventos` | S | PII crua acumulando sem limite (R-14) |
| QW-08 | Unificar timezone (SQL vs JS) nas despesas | S | dois fusos na mesma DRE (R-21) |
| QW-09 | Validar/avisar moeda antes de somar mídia | S | R-22 |
| QW-10 | Remover `GOOGLE_ADS_SYNC_INTERVALO_MIN` ou usá-la | XS | config morta (R-31) |
| QW-11 | Job agendado de Google Ads | S | dados param até alguém clicar |
| QW-12 | Rodar o teste de isolamento de criativos no CI | S | o único que existe está pulado |

**Nota de escopo:** QW-01 e QW-03 mexem em comportamento de autenticação/segredo. Pelas regras da
fase, **não devem ser implementados sem instrução explícita**, mesmo sendo triviais.

**Ressalvas de implementação (correções do usuário, rodada 2):**

- **QW-01 — não assumir `app.set('trust proxy', 1)`.** O valor correto (número de proxies, lista de
  IPs confiáveis, ou `false`) depende da **topologia real Cloudflare → Railway**, que esta auditoria
  não verificou. Um valor errado é pior que nenhum: confiar em `X-Forwarded-For` demais permite que
  o cliente forje o próprio IP e escape do rate limit. **Validar a topologia antes de implementar.**
- **QW-04 — não escrever `WHERE` em `TRUNCATE`.** `TRUNCATE` não aceita `WHERE`. Para limpar apenas
  uma Store, o comando é `DELETE FROM controle_estoque_observacoes WHERE loja = $1`. `TRUNCATE` fica
  reservado para operação global deliberada.

---

# Q. Blockers P0

Itens sem os quais **não se deve colocar um cliente externo real** no sistema.

| # | Blocker | Risco | Esforço |
|---|---|---|---|
| **B-01** | Tenant context server-authoritative (sessão com identidade + membership) | CRITICAL | XL |
| **B-02** | `organizations`/`stores`/`users`/`organization_members` + `organization_id` nas tabelas | CRITICAL | XL |
| **B-03** | Refazer `meta_connections` e `google_ads_connections` (single-row → por tenant) | CRITICAL | L |
| **B-04** | Entitlements fail-closed no backend | CRITICAL | M |
| **B-05** | Checagem de posse em todas as rotas `:id` (~38 HIGH + 10 CRITICAL) | CRITICAL | L |
| **B-06** | Credenciais Ink saem de env para `integrations` cifrado por Store | CRITICAL | L |
| **B-07** | Chave de cifra separada de `ADMIN_SESSION_SECRET`, com versionamento | CRITICAL | M |
| **B-08** | Roteamento de webhook por identificador opaco de conexão | CRITICAL | M |
| **B-09** | Postgres obrigatório em produção (fail-fast) | CRITICAL | S |
| **B-10** | Leasing persistente nos jobs + budget por tenant | HIGH | L |
| **B-11** | Testes automatizados de isolamento (A1/A2/B1) rodando em CI | CRITICAL | M |
| **B-12** | Migrations versionadas | HIGH | M |
| **B-13** | Auth individual com revogação e audit atribuível | CRITICAL | L |
| **B-14** | `tenant_id` do creative-core vindo do request, não de env | HIGH | M |
| **B-15** | Token do agente WhatsApp Web por Store + `claim` filtrado | HIGH | M |
| **B-16** | Isolamento de assets por tenant + posse em `media_assets` | HIGH | M |
| **B-17** | Tabelas globais com efeito cross-tenant recebem dono (`custos_api_precos`, `segments`, `whatsapp_web_mensagens`) | HIGH | M |
| **B-18** | Estratégia de retenção/exclusão de PII (inclui `webhook_eventos`) | HIGH | M |
| **B-19** | **Atribuição fail-closed na DRE** — recurso não atribuído ou ambíguo não entra no total (F-01, PD-021) | HIGH | M |
| **B-20** | **Eliminar agregação cross-tenant** — endpoints que somam todas as lojas por construção ou por default (F-02) | CRITICAL | L |
| **B-21** | **Os invariants de ownership verificáveis em CI** (ver seção própria) | CRITICAL | L |
| **B-22** | **Remover o contrato do `/health` como fonte de identidade do remetente** — janela coordenada entre os dois repositórios (WG-09, INV-35) | CRITICAL | M (coordenado) |
| **B-23** | **Roteamento do webhook de entrada por tenant no serviço Go** — hoje o webhook não roteia, assume (WG-01..WG-05) | CRITICAL | L |
| **B-24** | **Credenciais da Meta por tenant, cifradas, com rotação, no serviço Go** — hoje não existe tabela, cifra nem caminho de rotação | CRITICAL | L |
| **B-25** | **Fail-fast de secrets obrigatórios no serviço Go.** Três defeitos da **mesma natureza**: `META_APP_SECRET` desabilita a validação HMAC (`webhook.go:136`, WG-06) · `API_KEY` ausente **abre** as rotas (`main.go:123-126`, WG-27) · `dashAuth` idem (`dashboard.go:15-18`). A ausência precisa causar **boot FAIL** (INV-38, INV-30a), não degradar a proteção | HIGH — *risco presente neutralizado por configuração em 15/09/2026 (OPS-06/07/08); o blocker permanece porque os defeitos são de código* | S |
| **B-26** | **Escopo de `problem_orders` e de `handleProblemsSync`** (WG-23, WG-24) — merge pelo primeiro registro com herança de PII, e exclusão por escopo vindo do corpo | CRITICAL | M |

## Ajuste de esforço após a rodada 3

A rodada 3 **não acrescentou blockers estruturais novos além de B-20/B-21** — ela mostrou que os
blockers já conhecidos têm mais instâncias do que a rodada 1 mapeou, e que várias delas colapsam
numa única mudança mecânica.

**Fica mais barato:** B-03 e o cluster de 11 achados categoria 4 (F-06). A lógica dos blocos de
analytics não precisa ser redesenhada — precisa trocar a chave de escopo de "instalação" para
"Organization", como explica a [causa-raiz](#a-causa-raiz-declarada-no-próprio-código). O padrão
correto já existe em G-01..G-10 e pode ser copiado em vez de inventado.

**Fica mais caro:** B-05, que ganha F-02 (agregação cross-tenant sem parâmetro) — uma classe que a
rodada 1 não tinha visto porque não envolve identificador nenhum.

## Ajuste após a rodada 6 (serviço Go)

**Cinco blockers novos** (B-22..B-26), todos no `whatsapp-webhook-go`. Nenhum deles altera a
classificação dos 21 anteriores — o serviço é um componente adjacente, não uma revisão do painel.

**Um blocker existente cresce:** **B-08** (roteamento de webhook por identificador opaco de conexão)
deixa de ser só sobre a Reserva Ink e passa a cobrir também o webhook da Meta no serviço Go, que tem
o mesmo defeito em forma mais aguda — o painel ao menos *tenta* identificar a loja; o serviço Go
**não tenta**, assume.

**Nada foi rebaixado.** A auditoria do serviço não reduziu nenhum risco do painel.

**Observação de calibragem:** os 26 achados do serviço têm **zero CRITICAL e zero HIGH hoje**. Os
cinco blockers acima são blockers **do segundo tenant**, não dívida ativa.

> **Atualização de 15/09/2026.** A exceção que existia — B-25/WG-06, que dependia de OPS-06 — foi
> resolvida por configuração: `META_APP_SECRET` foi definido, e o webhook passa a ser fail-closed a
> partir do restart. O **blocker permanece**, porque o defeito é de código e não de ambiente.
> O mesmo vale para WG-26, coberto por OPS-08. Registro histórico e avaliação de consequência em
> [Remediação de 15/09/2026](#remediação-de-15092026--assinatura-do-webhook-da-meta).

## Como as decisões da rodada 2 mudaram os blockers

**Desapareceram** (trabalho que a rodada 1 previa e que não existe mais):

| Item | Por quê |
|---|---|
| Isolamento entre Stores da mesma Organization | 1:1 — não há duas Stores |
| Rateio de mídia entre Stores, DRE multi-store, seletor, consolidação | R-02 |
| Modelar `max_stores` como entitlement | PD-002 fecha a cardinalidade |
| Decidir ownership domínio a domínio (Organization vs Store) | com 1:1, os dois níveis contêm o mesmo conjunto |
| Dedup de cliente entre Stores da mesma Organization | PD-017 |
| `store_id` no Creative Core | PD-018 |
| Productizar as 35 rotas da Migração Use Origens | R-01 — a feature sai |

**Ficaram menores:**

| Blocker | Antes | Agora |
|---|---|---|
| **B-05** (posse em rotas `:id`) | ~163 rotas (10 CRITICAL + 38 HIGH + 125 MEDIUM) | **~48 rotas** — as 125 MEDIUM não ganham checagem: **perdem o parâmetro `loja`** |
| **B-02** (entidades + discriminador) | 53 tabelas, 2 eixos | **49 tabelas, 1 eixo** (`organization_id`) |
| **B-11** (testes de isolamento) | matriz A1/A2/B1 | **Org A · Org B** + acesso cruzado |
| **B-14** (`tenant_id` do creative-core) | tenant + store | só a **origem** do `tenant_id` |
| **B-15** (agente WhatsApp Web) | token por Store | token por **Organization** |

**Não mudaram** (continuam integralmente): B-01, B-03, B-04, B-06, B-07, B-08, B-09, B-10, B-12,
B-13, B-16, B-17, B-18. A cardinalidade 1:1 simplifica o isolamento *entre Stores*; ela **não toca**
o isolamento entre Organizations, que é onde estão os blockers CRITICAL.

**Novo:** B-19, derivado do fechamento de PD-021 e do achado F-01.

---

# Ownership e escopo de recursos (rodada 3)

Auditoria dedicada, motivada por F-01. A hipótese era que F-01 não fosse um bug isolado, e sim um
**padrão**: o código foi cuidadoso com *"e se não estiver conectado?"* e descuidado com *"e se
pertencer a outro escopo?"*. A hipótese se confirmou.

## A causa-raiz, declarada no próprio código

`admin/src/api/metaAds.ts:3-6`:

> *"Diferente do GA4, a conexão é ÚNICA — não há uma por loja: o produto é 1 cliente = 1 loja, e o
> banco garante isso (`meta_connections` tem `CHECK (id = 1)`)."*

Esse comentário explica quase todos os achados desta rodada. Duas observações:

1. **A premissa de produto está certa** — "1 cliente = 1 loja" é exatamente o que PD-002 fechou.
2. **A implementação escolheu o escopo errado.** Ela amarrou "1 cliente" a **1 instalação**
   (`CHECK (id = 1)`), não a **1 Organization**. Hoje isso já é falso: existem 3 lojas reais
   (`server.js:58`) compartilhando a mesma conexão.

**Consequência boa para o roadmap:** a lógica dos blocos de analytics Meta/Google Ads não está
conceitualmente errada — está com a chave de escopo errada. Trocar `CHECK (id = 1)` por
`UNIQUE (organization_id)` e fazer "a conta selecionada" virar "a conta selecionada **desta
Organization**" resolve o cluster inteiro mecanicamente, sem redesenhar a lógica. Isso torna **B-03
e os 11 achados de categoria 4 mais baratos do que a rodada 1 estimava**.

**Consequência ruim:** enquanto a chave for por instalação, o índice parcial único
(`server.js:799, 1045-1046`) permite **uma única conta selecionada no banco inteiro**. No segundo
tenant isso **quebra de forma visível** (o segundo cliente não consegue selecionar conta), não
silenciosa. É o raro caso em que o defeito falha alto.

## Achados

Formato: **FATO** · categoria (1-6) · prioridade · risco · esforço.
Detalhe por call site nos anexos [C](./anexo-c-ownership-meta-google-ads.md),
[D](./anexo-d-ownership-ga4-utm-whatsapp-criativos.md).

### F-01 — DRE consome mídia sem conferir atribuição
**Categoria 5 + 6** · **P1 hoje / P0 no 2º tenant** · HIGH · M
Detalhado em [Financeiro / DRE](#f-01--a-regra-fail-closed-de-atribuição-é-violada-hoje).
`fontesDeMidia` não recebe loja (`server.js:11921-11949`); a atribuição do Google Ads nunca é lida
(`10454`, `11936-11947`); `?loja=` sobrescreve (`12256`); `lojaAtribuidaPadrao()` auto-atribui
(`11873-11876`). `atribuicaoMeta` (`11955-11970`) tem o mesmo defeito de assinatura.

### F-02 — Agregação cross-store é o comportamento padrão de vários endpoints
**Categoria 5 + 6** · **P0 no 2º tenant** · CRITICAL · L

**FATO.** `fetchAcrossInkStores(pathAndQuery)` (`server.js:1505`) itera **todas** as lojas com token
configurado e mescla os resultados. É usada em 7 pontos. Dois deles agregam
**incondicionalmente, sem qualquer parâmetro**:

| Endpoint | Local | O que devolve |
|---|---|---|
| `GET /api/admin/dashboard/abandoned-carts` | `server.js:2006` | carrinhos de todas as lojas |
| `GET /api/admin/dashboard/customers` | `server.js:8380` | **PII de clientes** de todas as lojas |

Outros seis resolvem `loja` como `req.query.loja || 'all'` — ou seja, **omitir o parâmetro agrega
tudo**: `server.js:2031, 2132, 2540, 2819, 2937, 3191`.

Somam-se agregados globais em telas scoped: `GROUP BY loja` sem filtro em `produtos_ink`
(`3867`) e `produtos_feed` (`3953`), e `SELECT MIN(ultimo_sync_em) FROM sync_estado` **sem filtro**
(`2617`) — enquanto o mesmo dado é corretamente filtrado por loja em `14376`.

**IMPACTO.** Num modelo multi-tenant, estes endpoints devolvem dados de todos os tenants **sem
exigir nenhuma entrada maliciosa** — basta chamá-los, ou omitir um parâmetro. O caso de
`/dashboard/customers` é o mais grave: expõe PII de clientes finais de todos os tenants numa única
requisição autenticada. É a maior superfície de vazamento encontrada em toda a auditoria, porque não
depende de adivinhar id nem de forjar parâmetro.

### F-03 — Creative Core: tenant é constante de processo
**Categoria 5** · **P0 antes do 2º tenant** · HIGH · M

**FATO.** `tenantId = env.CREATIVE_TENANT_ID || 'default'` (`routes/criativos.js:9, 92`), usado em
~25 chamadas a `store.*` no mesmo arquivo. As 3 lojas compartilham hoje **um único tenant** de
Creative Core: kits, produtos, jobs, histórico, assets **e a chave OpenAI BYOK**
(`lib/creative-core/byok.js:42-44`) são os mesmos para as três.

**IMPACTO.** O schema está certo (as 9 tabelas têm `tenant_id` e `pgStore.js` filtra sempre por ele);
a origem do valor está errada. Enquanto vier de env, todo tenant é o mesmo tenant — inclusive para a
credencial paga do cliente.

### F-04 — Fila do WhatsApp Web ignora a loja
**Categoria 5 + 6** · **P0 antes do 2º tenant** · HIGH · M

**FATO.** `POST /api/whatsapp-web-agente/claim` (`server.js:12873-12909`) não referencia `loja` em
nenhuma cláusula, embora `whatsapp_web_outbox` tenha a coluna preenchida no enfileiramento
(`12754-12765`). O agente autentica com **um token por instalação** (`12648`).

**IMPACTO.** O agente de um tenant claima e envia mensagens de outro — do telefone errado, para o
cliente errado, expondo telefone e conteúdo. Cross-tenant de credencial e de PII ao mesmo tempo.

### F-05 — Rotas `:id` de UTM, campanhas, despesas e mídia sem checagem de dono
**Categoria 6** · **P0 antes do 2º tenant** · HIGH · L

**FATO.** `utm_campaigns` GET/PATCH/DELETE/duplicate/archive por `:id` filtram só por `WHERE id = $1`
(`server.js:8849-8906`). O mesmo padrão em `campaigns` (~17 rotas, `9052-9492`),
`despesas_operacionais` (`12042, 12061-12064`) e `media_assets` (`15358, 15391`).

**IMPACTO.** O registro carrega `loja`, mas nenhuma rota a compara com um escopo esperado.

**Nota:** `despesas_operacionais` é o caso mais ilustrativo — a **leitura** é
corretamente scoped (`listarDespesas(loja)`, `server.js:11989`, `WHERE loja = $1`) e a **escrita por
`:id` não é**. Mesmo recurso, mesma tabela, dois níveis de cuidado.

### F-06 — Conexões de mídia e "conta selecionada" são por instalação
**Categoria 5, com 11 consumos em categoria 4** · **P0 antes do 2º tenant** · CRITICAL · L

**FATO.** `meta_connections` e `google_ads_connections` são single-row (`CHECK (id = 1)`,
`server.js:765, 1006`). A conta ativa vem de `metaContaSelecionada()` (`10940`) e
`contaGoogleAdsSelecionada()` (`10454`), ambas `WHERE selecionada LIMIT 1`.

O pick **é determinístico** hoje — os índices parciais únicos (`799, 1045-1046`) garantem no máximo
uma linha selecionada. O defeito não é a ordem; é o **escopo da unicidade**.

Onze rotas de analytics consomem essa conta como se fosse "a" performance, sem conceito de loja:
Meta overview/timeseries/entities/creatives/`ads/:adId` (`11528-11855`), Google Ads overview
(`10665`), os `/sync` de ambos e os jobs `jobIncrementalMeta`/`jobDiarioMeta`.

### F-07 — Fallback "se só existe uma loja, use ela"
**Categoria 4** · **P0 antes do 2º tenant** · HIGH · S

**FATO.** `lojaAtribuidaPadrao()` (`server.js:11873-11876`) retorna a única loja quando existe
exatamente uma. **Dois** call sites:

- o consolidado (`12256`), já descrito em F-01;
- `select-account` da Meta (`11419`):
  `loja_atribuida = COALESCE($2, loja_atribuida, $3)` com `$3 = lojaAtribuidaPadrao()` — ou seja, ao
  selecionar uma conta sem informar a loja, a atribuição é **preenchida sozinha**.

**IMPACTO.** Hoje retorna `null` (há 3 lojas) e por isso é inofensivo. **Com PD-002, todo tenant tem
exatamente uma Store** — o caminho que hoje nunca dispara passa a disparar em 100% dos tenants.
É o achado que melhor ilustra por que testar com o banco atual não encontra estes defeitos:
**só um banco com uma organization os expõe.**

### F-08 — Tabelas e configs globais conceitualmente por-tenant
**Categoria 5** · **P0 antes do 2º tenant** · HIGH · M

**FATO.** Sem discriminador: `custos_api_precos` (`1124`, editável por rota e com
`ON CONFLICT (chave) DO UPDATE` em `12103`), `segments`, `whatsapp_web_mensagens`
(`UNIQUE(lower(nome))`, `665`), `utm_presets`, `app_config` (`220-224`, `chave TEXT PRIMARY KEY`).

Chaves de `app_config` conceitualmente por-tenant, armazenadas globalmente:

| Chave | Local | Observação |
|---|---|---|
| `automacao-settings` | `server.js:12344` | modo de envio, janela de horário |
| `whatsapp-provider` | `12623` | `meta_api` vs `whatsapp_web` para a instalação inteira |
| `whatsapp-web-agente` | `12649` | **token do agente**, um por instalação |
| `settings-product` | `13330` | `productName` singular para as 3 lojas |
| `entitlements` | `13376` | plano único para a instalação (ver F-10) |
| `campos-customizados` | `13457` | blob global, mas **indexado por loja por dentro** (ver G-08) |

Não confirmados em profundidade: `whatsapp-template-config`, `meta-metas`, `whatsapp-meta-app`.

**IMPACTO.** Um tenant editando um preço de API muda o número financeiro de todos. Um tenant não
consegue criar uma mensagem cujo nome outro já usou.

### F-09 — Audit log sem sujeito, sem escopo e com retenção compartilhada
**Categoria 5 + 6** · **P1 hoje / P0 no 2º tenant** · HIGH · M

**FATO.** A tabela tem `actor_user_id NOT NULL` e `loja` (`server.js:273-283`) — o schema está
pronto. Mas o valor gravado é a constante `'admin'` (`3108`), `listarAuditLog()` filtra por `action`
e **nunca por escopo** (`1254-1269`), e o espelho em JSON é **global e truncado em 500 entradas**
(`AUDIT_LOG_MAX = 500`, `1233`).

**IMPACTO.** Três falhas compostas: não se sabe **quem** agiu; um tenant lê a auditoria dos outros;
e a atividade de um tenant **apaga a trilha de auditoria dos demais** por rotação. O último é o mais
sério para investigação de incidente.

### F-10 — Entitlements são fail-open também no backend
**Categoria 5** · **P0 antes do 2º tenant** · CRITICAL · M

**FATO.** Além do fail-open já conhecido no frontend
(`admin/src/state/entitlements.ts:14-22, 36-39`), o próprio endpoint responde
`{ ...ENTITLEMENTS_DEFAULT, ...entitlements }` (`server.js:13390`) com **todos os defaults `true`**
(`13376-13384`): uma chave ausente no armazenamento vira **permissão concedida**. E o conjunto é
**único para a instalação**. Não há nenhuma checagem de entitlement em rota alguma.

### F-11 — Filtro de escopo que se desabilita quando o escopo é desconhecido
**Categoria 6 (latente)** · **P2 hoje** · MEDIUM · XS

**FATO.** `acharCompraDoCarrinho` (`lib/recuperacao/compra.js:53`):

```js
if (alvo.loja && p.loja !== alvo.loja) continue;
```

O filtro de loja só é aplicado **se a loja for conhecida**. Com `alvo.loja` ausente, a função casa
compradores de **todas** as lojas.

**IMPACTO.** Não é explorável hoje: o único call site (`server.js:2278`) sempre passa `c.loja`. Mas
a guarda está escrita como *"filtre se por acaso soubermos o escopo"* em vez de *"recuse se não
soubermos"*. É a mesma inversão de F-01, em forma latente. O efeito seria marcar um carrinho como
"comprou" com base no pedido de **outro** tenant — e, com isso, **suprimir** a mensagem de
recuperação.

Incluído apesar de não ser explorável porque a rodada 3 procura o **padrão**, não só instâncias
ativas. Ver **INV-24**.

### F-12 — Cache e storage sem segmento de tenant
**Categoria 5** · **P1** · MEDIUM · M

**FATO.** `IMG_CACHE_DIR` (`server.js:37`) é um cache global chaveado só pelo nome do arquivo no CDN
da Ink; `UPLOADS_DIR` não tem segmento de tenant no caminho. (O Creative Core é a exceção: usa
`…/tenant/{tenant_id}/…`.)

## O padrão-alvo já existe no repositório

Estes são os achados de **categoria 1-3**. Valem tanto quanto os defeitos: mostram que a equipe já
sabe fazer certo, e dão o modelo a replicar — o que reduz o trabalho de implementação.

| # | Padrão correto | Local | Cat. |
|---|---|---|---|
| **G-01** | **Dashboard financeiro é fail-closed**: exige `loja_atribuida IS NOT NULL`, agrupa por ela, e o comentário diz explicitamente *"sem essa definição, não há a quem atribuir e o gasto fica de fora em vez de ser somado na loja errada"* | `server.js:2594-2670`, esp. `2629-2650` | **3** |
| **G-02** | **GA4 é correto ponta a ponta**: `google_analytics_connections` com `loja UNIQUE` (`729`), cache com `UNIQUE(loja, periodo)` (`754`), loja decidida server-side antes do redirect OAuth (`9776-9777, 9825`) | vários | **1** |
| **G-03** | **Join UTM × GA4 não cruza lojas**: o match por nome só ocorre depois de pré-filtrar `utm_campaigns WHERE loja = $1` | `server.js:9959-9962`, `9966-9983` | **1** |
| **G-04** | **Loja como parâmetro obrigatório**, nunca descoberta: `financeiroDaLoja(loja,…)` (`11878`), `listarDespesas(loja)` (`11989`), `atribuicaoGA4(loja,…)` (`11975`) | — | **1** |
| **G-05** | **Creative Core filtra sempre por `tenant_id`** em todas as queries; nenhum lookup só-por-id | `lib/creative-core/pgStore.js` | **1** |
| **G-06** | **Provedor não conectado é excluído e sinalizado** (`faltando` → `avaliarQualidade`), em vez de virar zero | `lib/financeiro/consolidado.js:37-51` | **3** |
| **G-07** | **Rotas de atribuição do Google Ads** validam a loja por enum e **não** têm o fallback perigoso que o `select-account` da Meta tem | `server.js:10589, 10625` | **2** |
| **G-08** | **`campos-customizados` indexa por loja** dentro de um blob global e valida `LOJAS[loja]` | `server.js:13479-13487, 15712-15714` | **2** |
| **G-09** | **Índices parciais únicos** tornam o `LIMIT 1` determinístico — o problema é o escopo, não a ordem | `server.js:799, 1045-1046` | **2** |
| **G-10** | **Blobs de config namespaced por loja por dentro**: `automacao-eventos`, `pix-lembretes`, `envios-pendentes-janela` — armazenamento global, conteúdo separado por loja | `app_config` | **2** |

**A lição operacional:** G-01 e F-01 são o **mesmo cálculo**, implementado duas vezes, com dois
níveis de rigor, a ~9.300 linhas de distância. A correção de F-01 não precisa inventar nada —
precisa replicar G-01.

## Revisão dos achados (rodada 4)

Cada achado com dono da correção, severidade hoje, severidade no segundo tenant, blocker e o
invariant que impede a regressão. **Todos os 12 têm invariant** — nenhum ficou desprotegido.

| # | Dono da correção | Sev. hoje | Sev. 2º tenant | Blocker | Invariant |
|---|---|---|---|---|---|
| **F-01** | Fase 4 — Integrations/DRE | P1 / HIGH | **P0 / CRITICAL** | B-19 | INV-11 |
| **F-02** | Fase 3 — Tenant context (+ PD-022) | P2 / LOW *(hoje é feature)* | **P0 / CRITICAL** | B-20 | INV-03 |
| **F-03** | Fase 3 — Creative Core | P2 / LOW | **P0 / CRITICAL** | B-14 | INV-10, INV-22 |
| **F-04** | Fase 5 — Jobs/WhatsApp | P2 / MEDIUM | **P0 / CRITICAL** | B-15 | INV-12, INV-03 |
| **F-05** | Fase 3 — Autorização por recurso | P2 / LOW | **P0 / CRITICAL** | B-05 | INV-20 |
| **F-06** | Fase 1 — Tenancy (schema) | P2 / LOW | **P0 / CRITICAL** | B-03 | INV-06, INV-08 |
| **F-07** | Fase 4 — Atribuição | P3 / LOW *(hoje retorna `null`)* | **P0 / HIGH** | B-19 | INV-09 |
| **F-08** | Fase 1 — Tenancy (schema/config) | P1 / MEDIUM *(preços globais já afetam a DRE)* | **P0 / HIGH** | B-17 | INV-04, INV-05 |
| **F-09** | Fase 2 — Auth/audit | P1 / MEDIUM | **P0 / HIGH** | B-13 | INV-21 |
| **F-10** | Fase 3 — Entitlements | P1 / HIGH | **P0 / CRITICAL** | B-04 | INV-23 |
| **F-11** | Fase 3 — Tenant context | P3 / LOW *(latente)* | **P1 / MEDIUM** | B-05 | INV-24 |
| **F-12** | Fase 8 — Storage | P2 / MEDIUM | **P1 / HIGH** | B-16 | INV-19 |

**Leitura da tabela.** Só três achados são P1 hoje (F-01, F-08, F-09, F-10) — os demais são
inofensivos enquanto houver um dono e um tenant. **Onze dos doze viram P0 ou P1 no segundo tenant.**
Essa é a forma mais compacta de dizer por que a productização não é incremental: quase nada dói
agora, e quase tudo dói no dia em que um cliente externo entrar.

**Nota sobre F-02:** é o único achado cuja severidade *hoje* é baixa **porque é funcionalidade
deliberada**. PD-022 o converte de "corrigir" em "remover", o que é mais barato e mais seguro.

## Integrações: inventário de escopo

Levantado por host externo (`api.reserva.ink`, `graph.facebook.com`, `googleapis.com`,
`oauth2.googleapis.com`, `analyticsdata/analyticsadmin.googleapis.com`, `googleads.googleapis.com`,
`api.openai.com`) mais os serviços internos.

| Integração | Escopo hoje | Categoria |
|---|---|---|
| **GA4** | por loja, ponta a ponta | **1** ✔ |
| **Reserva Ink** | por loja, mas credencial em env e loja vinda do cliente | 5 + 6 |
| **Meta Ads** | conexão e conta **por instalação** | 5 |
| **Google Ads** | conexão e conta **por instalação**; atribuição nunca lida na DRE | 5 |
| **Meta WhatsApp** | 1 WABA por instalação (`server.js:291`) | 5 |
| **WhatsApp Web (agente)** | 1 token por instalação; fila sem filtro | 5 + 6 |
| **OpenAI BYOK** | por `tenant_id`, mas o tenant vem de env | 5 |
| **creative-core** | token de serviço OK; nenhum tenant atravessa | 5 |
| **UTM** | tabela por loja; rotas `:id` sem escopo | 6 |
| **Instagram** | **não implementado** — só flag de entitlement (`13378`) e card "em breve" | n/a |
| **BigQuery** | **não existe no código** — zero ocorrências | n/a |
| **Mailchimp** | **não existe no código** | n/a |

Nenhuma outra integração externa foi encontrada.

---

# Rodada 4 — fechamento dos NOT VERIFIED

Discovery final antes de escrever o plano. Cada descoberta declara explicitamente o que altera —
**inclusive quando não altera nada**, que também é resultado.

## D-1 — `creative-lab`: posição de rede e trust boundary — ✅ **VERIFIED / CLOSED**

**Resolvido pelo usuário (rodada 5), com evidência conferida no painel da Railway:**

| Evidência | Valor |
|---|---|
| `CREATIVE_CORE_URL` (serviço Node) | `http://creative-lab.railway.internal:8080` |
| Public Domain no `creative-lab` | **não existe** |
| Custom Domain | **não existe** |
| TCP Proxy | **não existe** |

**Veredito: o caminho Node → `creative-lab` é exclusivamente privado.** O serviço **não é alcançável
a partir da internet**. O `.railway.internal` confirma que o tráfego nunca sai da rede privada do
Railway.

### Consequência para o achado do `/v1/health`

**Rebaixado, não removido.** `/v1/health` continua respondendo sem token, antes do `_authorized`
(`services/creative-core/creative_core/service.py:133-134, 154`), e continua devolvendo o manifesto
de versões. Mas, **sem alcance externo, isso não é blocker de productização** — o único chamador
possível já está dentro do perímetro privado e já detém o token de serviço.

Fica registrado como **hardening opcional, prioridade baixa**: reduzir a resposta a
`{ "status": "ok" }`, sem o manifesto de versões. Ganho real apenas em defesa em profundidade.

> **O achado volta a importar se a rede mudar.** Basta gerar um Public Domain, um Custom Domain ou
> um TCP Proxy para o serviço, e a divulgação de versões passa a ser pública. É exatamente por isso
> que ele vira item de checklist operacional (**OPS-01**) em vez de desaparecer.

### Natureza do controle: operacional, não de CI

A configuração de rede vive **no painel da Railway** e **não** em Config-as-Code — o próprio README
do serviço registra que Config as Code do Railway está deprecado e que não há `railway.json`. Logo,
não existe artefato no repositório contra o qual um teste de CI possa asseverar isso.

**Por isso o antigo INV-26 foi reclassificado** para o
[Checklist operacional de infraestrutura](#checklist-operacional-de-infraestrutura) como **OPS-01**,
e **removido da série INV**, que é exclusivamente de verificações automatizáveis em CI.
INV-25 permanece na série (é testável: o serviço recebe a identidade por requisição).

### O que o repositório já provava antes

Mantido para rastreio — é o que sustenta a leitura acima.

| Fato | Evidência |
|---|---|
| Faz bind em todas as interfaces, IPv4+IPv6 | `services/creative-core/gunicorn.conf.py` — `bind = f"[::]:{PORT}"`, com o comentário *"Railway private networking may be IPv6-only"* |
| Tipo de processo `web` | `services/creative-core/Procfile` |
| Healthcheck configurado é `/v1/health` | `README.md` (seção Railway) |
| **`/v1/health` não exige token** — é checado **antes** do `_authorized` | `creative_core/service.py:133-134` |
| Todas as demais rotas exigem `Bearer`, comparado com `hmac.compare_digest` | `service.py:86-90, 135` |
| O serviço não sobe sem `CREATIVE_CORE_SERVICE_TOKEN` (≥32 chars) | `README.md` — fail-closed no boot ✔ |
| A exposição é **recomendação, não garantia** | `README.md`: *"Não expor publicamente **se possível** (rede privada do Railway)"* |
| Não há `railway.json` no repositório | `README.md`: *"Config as Code do Railway está deprecado; sem `railway.json`"* |

### Impacto, após o fecho

| Altera | Resposta |
|---|---|
| Tenant model | **Não** |
| P0 blockers | **Não** — e **remove** a condicional que pesava sobre a Fase 0 |
| Schema/migrations | **Não** |
| **Network/security boundary** | **Sim — define-a, e favoravelmente**: a fronteira é privada e o token de serviço é a única credencial exposta, dentro do perímetro |
| Sequencing | **Não** — a Fase 0 perde o pré-requisito condicional que D-1 tinha criado |
| INV | **INV-26 deixa de existir na série** (vira OPS-01). INV-25 permanece |

**O que permanece verdadeiro de TD-008:** a fronteira Node → creative-core continua sem transportar
tenant context e sem correlation id. Isso é independente da rede e continua a ser trabalho da
productização.

## D-2 — WhatsApp: o `phone_number_id` vive noutro repositório

**FATO.** O painel **não seleciona** WABA nem `phone_number_id`. Ele **lê** o valor do healthcheck do
serviço Go: `const phoneNumberId = connected ? healthResult.value.phone_number_id || null : null`
(`server.js:15213`). O `whatsapp-meta-app` guarda apenas `{ appId }` (`server.js:13070`), um id
único e global, validado por regex.

**IMPACTO.** A identidade do remetente do WhatsApp é propriedade do serviço `whatsapp-webhook-go`,
que **não está neste repositório e não foi auditado**. Tornar o WhatsApp multi-tenant exige mudar
esse serviço — ele precisa deixar de ter um número implícito e passar a receber, por requisição, a
identidade do tenant.

| Altera | Resposta |
|---|---|
| Tenant model | **Não** |
| P0 blockers | **Não cria blocker novo**; muda o *dono* de parte de B-15 (fica fora deste repo) |
| Schema/migrations | **Não** |
| Network/security boundary | **Sim** — acrescenta um serviço externo com identidade implícita |
| **Sequencing** | **Sim** — a Fase 5 ganha dependência de um repositório não auditado. **Auditar `whatsapp-webhook-go` é pré-requisito da Fase 5.** |
| INV | Origina **INV-25** |

## D-3 — O token do agente WhatsApp Web mora em máquinas de usuário

**FATO.** `desktop/` é um app Electron (macOS/Windows) que executa a fila de envio. Ele chama
`/api/whatsapp-web-agente/heartbeat`, `/claim` e `/:id/resultado` com
`Authorization: Bearer ${token}` (`desktop/src/painel.js:29, 41-45`).

**IMPACTO.** O token único por instalação (F-04) **não é só um detalhe de servidor: ele é
distribuído e instalado no computador de uma pessoa**. Em multi-tenant, cada tenant instalaria este
app; hoje existe um único token para todos. Isso eleva F-04 de "consulta sem filtro" para
"credencial compartilhada fora do perímetro do servidor".

| Altera | Resposta |
|---|---|
| Tenant model | **Não** |
| **P0 blockers** | **Sim** — aumenta a severidade de **B-15**, que passa a incluir rotação/distribuição de token por tenant |
| Schema/migrations | **Sim, marginal** — o token do agente precisa virar linha por Organization, não chave de `app_config` |
| Network/security boundary | **Sim** — há um cliente fora do servidor portando a credencial |
| Sequencing | **Não** — continua na Fase 5 |
| INV | Coberto por **INV-12** |

## D-4 — Blobs de config restantes: todos globais

| Chave | Forma real | Escopo |
|---|---|---|
| `whatsapp-meta-app` | `{ appId }` (`server.js:13070`) | **global** |
| `meta-metas` | objeto plano de limiares (`11671`) | **global** |
| `whatsapp-template-config` | **indexado por nome de template** (`13800`, `14863-14864`) | **global** |

`whatsapp-template-config` merece nota: por ser chaveado pelo nome do template, dois tenants com um
template de mesmo nome **compartilhariam a mesma configuração** — a mesma classe de colisão de
`whatsapp_web_mensagens`. Coerente com o desenho de WABA único, e quebra junto com ele.

Confirmado também que `automacao-eventos` **é** indexado por loja (`server.js:15413`:
`for (const loja of Object.keys(eventos))`) — o padrão bom de G-10 se sustenta.

| Altera | Resposta |
|---|---|
| Tenant model | **Não** |
| P0 blockers | **Não** — instâncias adicionais de **B-17**, já previsto |
| **Schema/migrations** | **Sim** — três chaves a mais na migração de `app_config` |
| Network/security boundary | **Não** |
| Sequencing | **Não** |
| INV | Coberto por **INV-04/INV-05** |

## D-5 — Índices únicos: inventário completo

Resolve o NOT VERIFIED sobre `bulk_category_jobs`, `campaigns` e `whatsapp_web_outbox`.

**Já incluem a loja (bom padrão):** `pedidos_ink UNIQUE (loja, ink_order_id)` (`136`) ·
`origens_migration_city_uf_map UNIQUE (loja, cidade_normalizada)` (`599`) ·
`ga4_performance_cache UNIQUE (loja, periodo)` (`754`).

**Escopados por FK (aceitável):** `campaign_recipients UNIQUE (campaign_id, customer_key)` (`381`).
`campaigns` e `bulk_category_jobs` **não têm índice único próprio** — sem risco de colisão.

**Colidem entre tenants:** `whatsapp_web_mensagens (lower(nome))` (`665`) ·
`whatsapp_web_outbox (dedupe_key)` (`689`) · `meta_ad_accounts (selecionada)` (`799`) ·
`google_ads_customers (selecionada)` (`1045`).

**Nuance importante — os índices por id de provedor** (`meta_insights_daily`, `google_ads_*`, `950`,
`1062`, `1097`) ficam **naturalmente seguros** quando as conexões forem por Organization: um
`meta_account_id` pertence a uma Organization só. **Com uma exceção real: agências.** Se duas
Organizations conectarem a *mesma* conta de anúncios, esses índices colidem. É um cenário plausível
no mercado-alvo e precisa de decisão explícita quando surgir — hoje não é blocker porque PD-001
mantém o MVP restrito.

| Altera | Resposta |
|---|---|
| Tenant model | **Não** |
| P0 blockers | **Não** — confirma o escopo de **B-02/B-17**, não o amplia |
| **Schema/migrations** | **Sim** — a lista definitiva de índices a reconstruir está fechada |
| Network/security boundary | **Não** |
| Sequencing | **Não** |
| INV | **INV-05**, que fica mais fácil de escrever agora que a lista é conhecida |

## D-6 — `src/` e `desktop/`: sem achado

`src/` está na allowlist pública (`lib/arquivos-publicos.js`, `DIRETORIOS_PUBLICOS`), mas contém
**apenas 33 arquivos CSS e 2 JS** (`src/loja.js`, `src/pedido.js`, do site público). Nenhum deles
chama `/api/admin`. `src/admin/` tem só CSS legado. **Servir `src/` publicamente não expõe nada
sensível.**

`desktop/` já está coberto em D-3; fora isso, não introduz superfície nova.

| Altera | Resposta |
|---|---|
| Tenant model · P0 blockers · Schema · Network boundary · Sequencing · INV | **Não altera nada.** |

---

# Serviço `whatsapp-webhook-go` (rodada 6)

Última lacuna de cobertura, fechada. Auditoria executada por agente dedicado dentro de
`/Users/gtomazi/projects/whatsapp-webhook-go` (HEAD `bf91ff1`, 16 arquivos Go, ~3.000 linhas),
read-only, seguindo o brief desta auditoria. `go build`, `go vet` e `go test` limpos.

**Relatório completo:** [`whatsapp-webhook-go-audit.md`](./whatsapp-webhook-go-audit.md) — 1.076
linhas. A síntese abaixo não o substitui.

## Decisão de numeração: série própria `WG-xx`

Os 26 achados **não** foram renumerados para dentro da série `F-xx` deste documento. Ficam como
**`WG-01..WG-26`**, em correspondência 1:1 com `F-01..F-26` do relatório do serviço.

**Critério — rastreabilidade entre dois repositórios.** Toda afirmação factual desta auditoria é
ancorada em `arquivo:linha`, e esses caminhos são **relativos a um repositório**. Uma série única e
plana tornaria `F-20` ambíguo exatamente onde a precisão importa: `sender.go:443` e `server.js:15213`
não vivem no mesmo lugar. O prefixo resolve isso sem custo. Mesma razão para os padrões corretos
(`WG-P-01..WG-P-07`).

| Série | Repositório | Documento |
|---|---|---|
| `F-01..F-12` | painel (este repo) | este documento |
| `WG-01..WG-26` ≡ `F-01..F-26` do anexo | `whatsapp-webhook-go` | [anexo](./whatsapp-webhook-go-audit.md) |
| `INV-01..INV-25` | painel | este documento |
| `INV-27..INV-38` ≡ `INV-W1..INV-W12` | serviço Go | este documento (§Invariants) |

## Veredito: mudança de contrato **e** reescrita, com divisão limpa

| Metade | Veredito | Evidência |
|---|---|---|
| **Saída** (`/send/*`, fila, templates, upload) | **Mudança de contrato — S–M** | Todo envio passa por **uma única função**, `metaPost` (`sender.go:21-51`), lendo `cfg.PhoneNumberID` (`:24`) e `cfg.AccessToken` (`:36`). **9 call sites**, nenhuma outra chamada a `/messages` no repositório. Dar um parâmetro de identidade a essa função escopa o caminho inteiro. |
| **Entrada** (webhook da Meta) | **Reescrita — L** | O webhook **não roteia; assume**. `metadata.phone_number_id` é desserializado (`types.go:32`) e usado **só num `log.Printf`** (`webhook.go:227`). `entry.ID` (WABA ID) nunca é lido. Todo payload com `object == "whatsapp_business_account"` (`webhook.go:162`) é tratado como do tenant único. |
| **Persistência** | **Migração de schema — M** | As três tabelas (`db.go:52-101`) sem coluna de tenant; seis stores em memória sem chave de tenant. |

Esta é a resposta à pergunta que o brief colocou como decisiva. **A divisão é limpa o bastante para
ser sequenciada**: a saída pode ser escopada sem tocar na entrada.

## Contagem por categoria

| Cat. | Significado | Qtd |
|---|---|---:|
| 1 | já organization-scoped | **0** |
| 2 | explicitamente atribuído | **0** achados (3 padrões corretos) |
| 3 | não atribuído e corretamente excluído | **0** achados (4 padrões corretos) |
| 4 | default implícito | **3** |
| 5 | global indevido | **15** |
| 6 | potencial cross-tenant | **8** |

**Categoria 1 = zero.** Nenhum recurso do serviço está escopado por tenant — coerente com ser
single-tenant por construção, não por descuido. É o mesmo diagnóstico do painel, em forma mais pura.

| Severidade | Hoje | No 2º tenant |
|---|---:|---:|
| CRITICAL | **0** | **12** |
| HIGH | **0** | **10** |
| MEDIUM | 7 | 3 |
| LOW | 4 | 1 |
| nenhuma | 15 | 0 |

**Zero achados CRITICAL ou HIGH hoje; 22 dos 26 viram CRITICAL ou HIGH no segundo tenant.** É a
mesma assimetria do painel — e a confirmação mais forte de que a productização não é incremental.

## O item que não é incremental: o contrato do `/health`

**WG-09 / `sender.go:443-449`**, endpoint registrado **sem wrapper de autenticação**
(`main.go:87`): o `/health` expõe o `phone_number_id`, e é de lá que o painel lê a identidade do
remetente (`server.js:15213`).

Isso é a **inversão exata do INV-25**: o chamador depende de um valor padrão configurado dentro do
serviço. O contrato precisa ser **removido, não estendido** — e removê-lo obriga painel e serviço a
mudarem **na mesma janela de deploy**. É restrição de sequenciamento que atravessa a fronteira dos
dois repositórios, tratada como tal em [Sequenciamento](#a-janela-coordenada-do-whatsapp).

## Achados de destaque

| # | Achado | Local | Hoje | 2º tenant |
|---|---|---|---|---|
| **WG-23** | `problem_orders` casa pelo **primeiro registro** com o mesmo `numero`, ignorando `loja`, e **herda Telefone/Email/CPF do registro anterior** (também no `ON CONFLICT`, `db.go:312-322`) | `problems.go:68-79`, `db.go:66` | **nenhuma** — numeração vem de uma fonte só | **CRITICAL** — contaminação de PII entre clientes de tenants distintos; números de pedido são curtos e sequenciais, colisão é o esperado |
| **WG-24** | `handleProblemsSync` **apaga** registros por escopo vindo do **corpo da requisição**; lista vazia limpa tudo daquela loja | `problems.go:237-246` | baixa | **CRITICAL** — escopo não confiável selecionando o que apagar |
| **WG-06** | Verificação HMAC inteira sob `if cfg.AppSecret != ""` — **fail-open por construção** | `webhook.go:136` | **LOW** — *neutralizado por configuração em 15/09/2026; o defeito de código permanece* | **CRITICAL** |
| **WG-25** | `lang = "pt_BR"` sobrescreve o `"en"` explícito do chamador | `queue.go:320` | baixa | HIGH |

**Nota de disciplina:** o relatório classificou WG-23 como *severidade nenhuma hoje* porque a
numeração de pedidos vem de uma instalação só. Está correto e não foi inflado — registro aqui porque
a leitura apressada do título sugeriria um bug ativo de PII, e não é.

## Remediação de 15/09/2026 — assinatura do webhook da Meta

**Condição remediada, registrada como fato histórico.** Este bloco não deve ser apagado: um achado
que some sem rastro é indistinguível de um achado que nunca existiu, e a janela de exposição é fato
de segurança.

### O que era verdade até 15/09/2026

`META_APP_SECRET` **não estava definido** no serviço `whatsapp-webhook-go` em produção. Como a
verificação de assinatura inteira está sob `if cfg.AppSecret != ""` (`webhook.go:136`), o serviço
rodava **sem verificar a assinatura da Meta**: `POST /webhook` aceitava **qualquer payload não
assinado** que alcançasse o endpoint.

Dois agravantes de desenho, já documentados em WG-01..WG-05, que valem ser lidos juntos aqui:
o serviço **não validava `metadata.phone_number_id`** (desserializado, usado só num `log.Printf`,
`webhook.go:227`) e **nunca lia `entry.ID`** (o WABA ID). Ou seja: um payload forjado **não
precisava acertar nenhum identificador** — bastava `object == "whatsapp_business_account"`
(`webhook.go:162`). A única barreira efetiva era **conhecer a URL do endpoint**.

### O que mudou

Em **15/09/2026** o usuário adicionou `META_APP_SECRET` ao serviço, com o mesmo valor que o painel
já usa para o mesmo Meta App — **correto: o App Secret é por App, não por serviço**. A partir do
deploy/restart que carregar a variável, o caminho de verificação passa a executar e o webhook fica
fail-closed na prática.

**Enquanto o deploy não for confirmado, a condição acima ainda vale no processo em execução.**
Variável definida no painel só entra em vigor depois do restart.

### O defeito de código NÃO foi remediado

`if cfg.AppSecret != ""` continua no código. Hoje ele está **inofensivo por configuração, não por
código** — e configuração desaparece num serviço novo, num redeploy limpo ou num ambiente recriado.
Permanece coberto por **INV-30**, que passou a exigir também **fail-fast no boot** (ver §Invariants),
e continua como **B-25**.

### Consequência prática da janela — avaliação

**O que um payload forjado poderia ter causado**, pelo que o código faz em `processWebhook`
(`webhook.go:155-264`): inserir eventos falsos no store/tabela `events`; disparar auto-resposta de
WhatsApp (`maybeAutoReply`, `webhook.go:95`) para um número escolhido pelo atacante; disparar
notificação ao dono (`notifyOwner`, `webhook.go:41`); e repassar dados falsos ao painel via
`ForwardURL` (`webhook.go:255`).

**Probabilidade: baixa.** A exploração exigia conhecer a URL do endpoint, que existe apenas no
console da Meta e não é publicada nem trivialmente enumerável (subdomínio de plataforma). Não há
indício de abuso — e também **não há como haver indício limpo**, pelo motivo abaixo.

**A limitação honesta:** o serviço **não registrava se um request foi verificado** — não podia, já
que não verificava. Não existe campo por onde filtrar. Qualquer conferência retroativa é **caça a
anomalia, não prova**.

**Conferência barata e delimitada, se o usuário quiser fechar o assunto** — não é alarme, é uma
consulta:

1. Na tabela `events` do serviço Go, procurar registros cujo `phone_number_id` **não** seja o número
   configurado, ou cujo WABA ID destoe. Como o serviço nunca validou esses campos, um forjador
   desleixado deixaria valores inconsistentes; um cuidadoso, não.
2. Procurar auto-respostas enviadas para números **sem histórico de mensagem recebida
   correspondente** — seria o sinal mais direto de disparo forjado, e é o que teria custo real
   (envio, reputação do número, política do WhatsApp).

**Se as duas consultas não acusarem nada, o assunto está encerrado** — dado o vetor exigir
conhecimento da URL e não haver sinal de abuso, a conclusão razoável é que a janela não foi
explorada. O que **não** se pode afirmar é o contrário com prova positiva, e essa distinção é a
razão de este bloco existir.

**Não há ação de remediação de dados pendente** além dessas duas consultas opcionais.

## Negative testing ao vivo — 15/09/2026

Executado contra o serviço **publicado**, repo em `bf91ff1`, **código-fonte não alterado**.
É a primeira evidência de comportamento em runtime de toda a auditoria — até aqui tudo era estático.

### Resultados

| Teste | Resultado |
|---|---|
| Boot 01:42:05 e 02:01:15 (redeploy forçado) | `sig_verify=true` · `api_key=true` · `forward=true` |
| Webhook assinado válido | **200** |
| Webhook sem `X-Hub-Signature-256` | **403** |
| Assinatura inválida | **403** |
| Endpoint interno sem `API_KEY` | **401** |
| `API_KEY` inválida | **401** |
| `API_KEY` válida | **200** |
| Sobrevivência a restart | boot carregou **500 eventos** e **244 itens de fila**; o evento de teste sobreviveu com `id=3376` |

Os testes de assinatura e de `API_KEY` foram repetidos contra o processo novo pós-restart, com os
mesmos resultados.

**Com isto, OPS-06, OPS-07 e OPS-08 estão VERIFIED / OK** — OPS-06 deixou de estar "aguardando
restart": o boot de 02:01:15 confirmou `sig_verify=true`.

> **Nota operacional:** o evento `id=3376` **não deve ser apagado**. O único caminho disponível é
> `/dashboard/events/clear`, que executa `DELETE FROM events` **sem `WHERE`** (`db.go:184`) — um
> `DELETE` global destrutivo não se justifica para limpar um registro de teste. O item de fila de
> teste (`id 2720`) já foi removido pontualmente.

### Topologia real — fato, não defeito

O `whatsapp-webhook-go` **tem domínio público**: `whatsapp-webhook-go-production.up.railway.app`.

**Isto não é defeito por si só** — a Meta precisa alcançar o webhook. A implicação correta é:

```text
webhook público + endpoints internos obrigatoriamente autenticados e fail-closed
```

Contraste deliberado com o `creative-lab` (OPS-01), que **não** pode ter rede pública porque nada
externo precisa alcançá-lo. São regras opostas porque os papéis são opostos.

**Não há redesenho de infraestrutura a fazer por causa disto.** Se couber sem inflar escopo, a Fase
5a pode separar conceitualmente **public ingress** (webhook da Meta, health mínimo) de
**internal/admin API** (send, queue, dashboard, management). O mínimo obrigatório é autenticação
fail-closed em toda rota não pública — que é exatamente WG-27, abaixo.

### Achados novos

```text
WG-27 — auth() e dashAuth são fail-open quando API_KEY está ausente
Categoria: 5 (global indevido) — mesma natureza estrutural de WG-06
FATO: main.go:123-126
        if cfg.APIKey == "" {
            next(w, r)
            return
        }
      dashboard.go:15-18 tem a trava idêntica.
IMPACTO: ausência de configuração ABRE as rotas em vez de fechá-las. Hoje seguro por
      configuração (API_KEY está definida — OPS-07), não por código. Com domínio público,
      um serviço novo, um redeploy limpo ou um ambiente recriado sem API_KEY expõe os 21
      endpoints internos à internet.
Prioridade: P1 | Risco: HIGH | Esforço: XS
Severidade hoje: LOW — neutralizado por configuração
Severidade no segundo tenant: CRITICAL
```

```text
WG-28 — dashAuth aceita credencial por query string
Categoria: 6 (potencial cross-tenant / exposição de credencial)
FATO: dashboard.go:19 aceita ?key=...
IMPACTO: credencial em query string vaza em access log, histórico de navegador,
      ferramenta de observabilidade e cabeçalho Referer. É a mesma classe de WG-10/WG-20
      (token na URL do upload), aqui no caminho de autenticação.
Prioridade: P1 | Risco: MEDIUM | Esforço: XS
Severidade hoje: MEDIUM — o serviço tem domínio público
Severidade no segundo tenant: HIGH
```

**Confirmação ao vivo de achado já existente — teste 6.** Um `phone_number_id` estranho foi
**aceito e processado**. É a demonstração em runtime de WG-01..WG-05 / **B-23**:

> ⚠️ **[INFERÊNCIA — trecho truncado na mensagem original]** A leitura adotada é: *a assinatura HMAC
> autentica a **origem Meta**, mas não resolve nem valida **ownership** pelo `phone_number_id`/WABA.*
> Sinalizado por não ter sido possível ler a frase original íntegra.

Ou seja: assinatura válida prova que **a Meta** enviou, não prova **de qual tenant** o evento é.
São perguntas diferentes, e hoje só a primeira é feita. **Não corrigir na 5a** — pertence à
reescrita de entrada da 5c.

### Padrão correto já existente

```text
WG-P-08 — mustEnv, o padrão fail-fast, JÁ EXISTE neste repositório
Categoria: 3 | main.go:147-153
mustEnv faz log.Fatalf quando a variável falta. É exatamente o comportamento que WG-06 e
WG-27 deveriam ter e não têm. A correção não precisa inventar mecanismo — precisa APLICAR
o que já está escrito ao lado.
```

É o terceiro caso desta auditoria em que o padrão correto já convive com o incorreto no mesmo
repositório — depois de `G-01`/`F-01` no painel e de `WG-P-02` neste serviço. Reforça a leitura de
que o modo de falha aqui é **divergência, não ignorância**.

### Achado de persistência — `SourceWamid`

```text
WG-29 — SourceWamid não é persistido no estado serializado da fila
Categoria: não é tenancy nem segurança — bug operacional
FATO: queue.go:27-30 não inclui SourceWamid no estado serializado. Confirmado ao vivo:
      o campo não aparece no JSON de /queue/list após o restart.
IMPACTO: após restart, um retry pendente perde a correlação com o wamid de origem.
Prioridade: P2 | Risco: LOW | Esforço: XS
Severidade hoje: LOW | Severidade no segundo tenant: LOW (não escala com tenants)
```

**Classificação: bug operacional independente → corrigir na Fase 5a.**

O raciocínio, explicitamente: a consequência provável de perder a correlação é um retry **que não
acontece** (a mensagem de recuperação não é reenviada), não um envio duplicado — o que o torna um
problema de qualidade de entrega, não de integridade de dados. Isso **não** justifica prioridade
alta. Vai para a 5a por dois motivos de custo, não de urgência: é **XS** (acrescentar o campo ao
struct persistido) e é **adjacente a INV-37**, que já exige que o retry sobreviva ao restart
carregando estado persistido — deixar para a 5c faria o mesmo trabalho ser redescoberto lá.

**Não escala com o número de tenants** e por isso não é blocker do segundo tenant.

## O precedente do `appId` — parcial e instrutivo

O último commit (`bf91ff1`) aceita o `appId` vindo do painel. É **a forma certa** (identidade no
corpo, `media_upload.go:34, 67-70`) com **validação de formato fail-closed e testada**
(`media_upload.go:39, 75`; `media_upload_test.go:18-64`).

Mas tem dois defeitos, e o segundo é estrutural:

1. **Sem validação de ownership** — nada verifica que o chamador tem direito àquele `appId`.
2. **A credencial não viajou junto com a identidade.** O `appId` vem da requisição; o
   `access_token` usado com ele continua global (`media_upload.go:102, 130`). Identidade recebida e
   credencial fixa **podem discordar**.

Hoje quem barra o abuso é **a Meta, não o serviço** — um token sem permissão sobre aquele `appId` é
rejeitado pela Graph API. Isso é constatação, não mitigação: no segundo tenant, quando houver vários
tokens, o token global deixa de existir e o enforcement externo deixa de bastar.

**Lição que vale para o painel também:** mover identidade para o corpo da requisição sem mover a
credencial junto cria uma inconsistência que só não explode porque um terceiro está validando.

## Padrões corretos já existentes

Reduzem o custo da migração e devem ser copiados, não reinventados.

| # | Padrão | Local |
|---|---|---|
| **WG-P-01** | HMAC em tempo constante sobre o **corpo cru**, lido antes de qualquer parse, com `hmac.Equal` e sem re-serialização | `webhook.go:130-146` |
| **WG-P-02** | `resolveWABAID` é **"receba, não descubra"**: erro explícito sem `META_WABA_ID`, sem fallback para "o primeiro que existir" — e o comentário registra que a auto-descoberta foi **tentada e removida** | `templates_management.go:18-32` |
| **WG-P-03** | `appId` validado contra allowlist estrita antes de entrar na URL, com testes | `media_upload.go:39, 75` |
| **WG-P-04** | Ausência de credencial tratada fail-closed, com ordem de checagem deliberada e documentada | `media_upload.go:65-74` |
| **WG-P-07** | O encanamento de um campo de escopo **ponta a ponta já existe** (`loja`: request → struct → coluna → SELECT → filtro → retry) | vários |

**WG-P-02 é o achado mais encorajador das seis rodadas:** o princípio "receba, não descubra" —
que é a tese central desta auditoria — **já está aplicado e documentado neste repositório**, com a
alternativa errada explicitamente tentada e descartada. A equipe reconhece o padrão.

**WG-P-07 barateia o schema de L para M:** já existe um campo de escopo atravessando a pilha inteira;
o trabalho é trocá-lo e generalizá-lo, não inventá-lo.

## Esforço

**Total agregado: L**, concentrado em três itens — roteamento do webhook de entrada (L),
armazenamento de credenciais por tenant cifradas com rotação (L) e o re-chaveamento dos seis stores
em memória, **cujo custo depende inteiramente da topologia** (M compartilhado / XS por tenant).
Sem esses três, seria M.

Barato e independente (**S**): as correções de segurança que não dependem de tenancy — fail-closed
do HMAC, comparação em tempo constante, chave fora da query string, idempotência. **Podem ser feitas
antes da migração**, e valem por si.

---

# Invariants obrigatórios antes do segundo tenant

Esta é a saída principal da rodada 3. Cada invariant é redigido para ser **verificável** — dá para
escrever um teste ou um lint para cada um. Princípio genérico sem forma de verificação não entra
nesta lista.

> **A série INV é exclusivamente de CI.** Todo item aqui tem que ser asseverável por um teste ou um
> lint rodando no pipeline. Controles que dependem de configuração de infraestrutura — que vive em
> painel de provedor, fora do repositório — **não entram nesta série**: eles vão para o
> [Checklist operacional de infraestrutura](#checklist-operacional-de-infraestrutura), que é
> verificado no deploy, por pessoa ou por script de ambiente, e não em CI.

Convenção: **L** = verificável por lint/análise estática · **T** = verificável por teste automatizado.
"Hoje falha" cita a evidência; ausência de "hoje falha" significa que o invariant já se sustenta.

## A. Contexto de request

**INV-01 (L+T) — Nenhum handler usa identificador de tenant vindo do cliente para escolher escopo,
dados ou credencial.**
L: nenhuma ocorrência de `req.query.loja`, `req.body.loja`, `req.params.loja`, nem de `store_id` /
`organization_id` / `tenant_id` / `account_id` lidos do request, em caminho que selecione escopo.
(Permitido apenas filtrar *dentro* do escopo já resolvido.)
T: sessão da Org A com `?loja=<store da Org B>` → 403/404, nunca dados.
*Hoje falha:* `server.js:12256, 3069-3073, 2819, 2937, 3191, 2031, 2132, 2540`.

**INV-02 (T) — `organization_id` do contexto deriva exclusivamente da sessão.**
T: forjar header, query, body ou cookie de tenant não altera o resultado de nenhum endpoint.

**INV-03 (L+T) — Nenhum endpoint agrega dados de mais de um tenant.**
L: não existe helper equivalente a `fetchAcrossInkStores`; nenhum handler itera a lista de
stores/organizations; nenhum `GROUP BY loja` sem predicado de escopo.
T: com duas organizations semeadas, **todo** endpoint autenticado como A retorna zero linhas de B —
inclusive quando o parâmetro de loja é **omitido**.
*Hoje falha:* `server.js:2006, 8380` (agregam incondicionalmente); `2031, 2132, 2540, 2819, 2937, 3191`
(default `'all'`); `3867, 3953` (`GROUP BY loja` sem filtro); `2617` (`MIN(ultimo_sync_em)` global).

## B. Banco

**INV-04 (L) — Toda tabela tenant-scoped tem `organization_id NOT NULL`.**
L: comparar a lista de tabelas tenant-scoped com `information_schema.columns`.

**INV-05 (L) — Toda constraint UNIQUE/PK de tabela tenant-scoped inclui `organization_id`.**
L: para cada índice único de tabela tenant-scoped, `organization_id` ∈ colunas do índice.
*Hoje falha:* `whatsapp_web_mensagens UNIQUE(lower(nome))` (`server.js:665`); `app_config.chave`
(`220-224`); `custos_api_precos.chave` (`1124`); UNIQUEs por id de provider em `meta_*` e
`google_ads_*`; `whatsapp_web_outbox.dedupe_key` (`689`).

**INV-06 (L) — Nenhuma tabela tenant-scoped é single-row.**
L: nenhum `CHECK (id = 1)` nem PK de valor constante.
*Hoje falha:* `meta_connections` (`765`), `google_ads_connections` (`1006`).

**INV-07 (T) — RLS habilitada e forçada em toda tabela tenant-scoped.**
T: com a role da aplicação e o `organization_id` de A no contexto, `SELECT * FROM <tabela>` **sem
WHERE** retorna apenas linhas de A.
É este invariant que transforma "esquecemos um `WHERE`" de vazamento em não-evento. Sem ele,
INV-01..INV-06 dependem de disciplina humana permanente.

## C. Descoberta de escopo

**INV-08 (L) — Nenhum `LIMIT 1`, `rows[0]`, `[0]` ou `.find()` determina escopo, credencial ou conexão.**
L: varrer os call sites; permitido quando um índice UNIQUE garante unicidade **dentro do tenant** —
e nesse caso o predicado precisa conter `organization_id`.
*Hoje:* `metaContaSelecionada()` (`10940`) e `contaGoogleAdsSelecionada()` (`10454`) usam
`WHERE selecionada LIMIT 1`. O pick **é determinístico** hoje graças aos índices parciais únicos
(`799`, `1045-1046`) — o defeito não é a ordem, é o escopo: a unicidade é **por instalação**.

**INV-09 (L+T) — Não existe fallback "se só há um candidato, use-o".**
L: padrões `length === 1`, `Object.keys(x).length === 1`, `|| <default>()` em resolução de escopo.
T (**o teste decisivo desta rodada**): semear o banco com **exatamente uma** organization e **um
recurso não atribuído**, e assertar que ele **continua não atribuído**.
Um banco com três lojas nunca pega esse defeito — só um banco com uma pega.
*Hoje falha:* `lojaAtribuidaPadrao()` (`server.js:11873-11876`), usado em `11402` e `12256`.

**INV-24 (L) — Todo filtro de escopo é incondicional; a ausência de escopo aborta, nunca desabilita
o filtro.**
L: nenhum predicado de escopo com a forma `if (escopo && registro.escopo !== escopo) continue` ou
`WHERE (<escopo> IS NULL OR col = <escopo>)`. Escopo ausente deve lançar erro, não relaxar a
condição.
T: chamar a função sem escopo → erro, nunca resultado de outro tenant.
*Hoje falha:* `lib/recuperacao/compra.js:53` (latente — o único call site hoje sempre passa a loja).

**INV-10 (L) — Nenhum `process.env` é lido durante um request para determinar tenant ou escopo.**
*Hoje falha:* `CREATIVE_TENANT_ID` (`routes/criativos.js:9, 92`), `INK_STORES` (`server.js:69-73`),
`GOOGLE_ADS_EM_USO` (`10755, 11949`).

## D. Atribuição (a regra de PD-021)

**INV-11 (T) — Recurso sem atribuição, ou atribuído a outro tenant, é excluído do total e reportado.**
T1: ad account com atribuição nula → gasto **fora** do total **e** presente na lista de pendências.
T2: ad account atribuído à Org B → **fora** do total da Org A.
T3 (**teste de consistência**): para o mesmo período, a mídia somada por
`/api/admin/dashboard/financeiro` (`server.js:2594`) e por `/api/admin/analytics/consolidado`
(`server.js:12249`) **coincide**.
*Hoje falha T1/T2/T3:* os dois caminhos implementam o mesmo conceito e discordam — o dashboard
exige `loja_atribuida IS NOT NULL` (`2629-2650`), o consolidado não olha atribuição (`11921-11949`).

## E. Credenciais

**INV-12 (L+T) — Toda credencial de integração é resolvida a partir do `organization_id` do contexto.**
L: nenhuma credencial de tenant lida de env em caminho de request.
T: duas organizations com tokens distintos; o provider (mockado) recebe, em cada request, o token da
organization correta.
*Hoje falha:* `INK_TOKEN_*` via `INK_STORES` (`server.js:69-73`), escolhido por `:loja` do cliente.

**INV-13 (T) — Nenhum segredo aparece em resposta de API, log ou mensagem de erro.**
T: semear segredos sintéticos e varrer respostas e logs de toda a suíte por esses valores.

**INV-14 (T) — A chave de cifra dos segredos é independente do segredo de sessão e versionada.**
T: rotacionar `ADMIN_SESSION_SECRET` e assertar que todos os segredos continuam legíveis.
*Hoje falha:* todas as chaves derivam por HKDF de `ADMIN_SESSION_SECRET` (`server.js:9585-9589`).

## F. Webhooks

**INV-15 (L+T) — O tenant de um webhook é determinado por identificador da própria rota, antes de
qualquer processamento.**
L: não existe laço que teste o segredo de vários tenants para descobrir o dono.
T: evento assinado com o segredo de A, entregue na URL de B → rejeitado, **e não roteado para A**.
*Hoje falha:* `identifyInkWebhookStore` (`server.js:1280-1291`) itera as lojas testando segredos.

**INV-16 (T) — Todo evento é idempotente por (conexão, event_id).**
T: entregar o mesmo evento duas vezes produz um efeito.

## G. Jobs

**INV-17 (L+T) — Todo job recebe o escopo iterando `organizations` do banco; nenhum descobre escopo
lendo "o selecionado" ou um enum de processo.**
T: com duas organizations, o job processa as duas, isoladamente, usando a credencial de cada uma.
*Hoje falha:* todos os `*TodasLojas` (`3476, 3634, 13907, 14365`) e os jobs Meta (`11145`).

**INV-18 (T) — Todo job que envia mensagem ou consome cota adquire lease persistente.**
T: duas instâncias concorrentes → cada item é enviado exatamente uma vez.
*Hoje falha:* 13 de ~16 jobs; os follow-ups (`15178-15181`) são os de efeito externo.

## H. Assets, cache e auditoria

**INV-19 (L+T) — Toda chave de cache e todo caminho de storage inclui `organization_id`.**
T: A não alcança asset de B por id, por caminho nem por chave de cache.
*Hoje falha:* `IMG_CACHE_DIR` global (`server.js:37`); `UPLOADS_DIR` sem segmento de tenant.

**INV-20 (T) — Todo acesso a recurso por id valida ownership.**
T: A requisita id de B → 404. Id imprevisível **não** substitui autorização.
*Hoje falha:* `media_assets` (`15358, 15391`), `campaigns`, `utm_campaigns`, `despesas` (`12042, 12061`).

**INV-21 (T) — O audit log registra o sujeito real e é isolado e retido por tenant.**
T1: uma ação da Org A grava `actor_user_id` de um usuário real (não constante) e `organization_id` de A.
T2: a Org A não lê registros de auditoria da Org B.
T3: atividade intensa da Org A **não evita** registros da Org B.
*Hoje falha:* `actorUserId: 'admin'` constante (`server.js:3108`); `listarAuditLog()` não filtra por
escopo (`1254-1269`); o espelho em JSON é global e **truncado em 500 entradas**
(`AUDIT_LOG_MAX = 500`, `1233`) — um tenant ativo apagaria a trilha dos outros.

## I. Fronteira de serviço

**INV-22 (T) — O tenant enviado ao creative-core é derivado no Node a partir da sessão; o serviço
rejeita requisição sem tenant.**
T1: chamada ao serviço sem tenant → rejeitada.
T2: nenhum valor vindo do browser alcança o campo de tenant.
*Hoje falha:* nenhum tenant context atravessa a fronteira; o valor vem de env.

## K. Serviços da plataforma (rodada 4)

**INV-25 (T) — Nenhum serviço externo da plataforma detém identidade de tenant implícita.**
Todo serviço auxiliar (creative-core, `whatsapp-webhook-go`) recebe a identidade do tenant **por
requisição**; o Node nunca depende de um valor padrão configurado dentro do serviço.
T: com duas organizations, dois envios de WhatsApp usam dois `phone_number_id` distintos, e nenhum
deles vem da configuração interna do serviço.
*Hoje falha:* o `phone_number_id` é lido do health do serviço Go (`server.js:15213`) — o serviço tem
um número implícito e único.

> **INV-26 foi reclassificado e não existe mais nesta série.** Ele tratava da exposição de rede do
> `creative-lab`, que é configuração de painel da Railway, sem artefato no repositório contra o qual
> um teste de CI possa asseverar. Virou **OPS-01** no
> [Checklist operacional de infraestrutura](#checklist-operacional-de-infraestrutura).
> A numeração não foi reaproveitada, para não confundir referências anteriores.

## L. Serviço `whatsapp-webhook-go` (rodada 6)

Verificados no CI **daquele** repositório. Equivalência: INV-27..INV-38 ≡ INV-W1..INV-W12 do
[anexo](./whatsapp-webhook-go-audit.md). Detalhe de verificação e linhas que falhariam hoje estão lá.

**INV-27 (L+T) — Nenhum caminho de envio lê a identidade do remetente de estado de processo.**
L: nenhuma referência a `cfg.PhoneNumberID`, `cfg.AccessToken` ou `cfg.AppID` fora do bootstrap e da
camada de resolução de tenant. T: `metaPost` exige parâmetro de identidade — a compilação quebra se
alguém voltar a ler do global.
*Hoje falha:* `sender.go:24,36,388,418`; `media_upload.go:102,130`; `templates_management.go:61,125,168`.

**INV-28 (T) — Dois envios de duas organizations usam dois `phone_number_id` distintos, e nenhum vem
da configuração do serviço.** *(Instanciação direta do INV-25.)*
T: Graph API falsa; duas requisições como orgs distintas; as URLs recebidas contêm os dois ids
esperados, e desconfigurar `META_PHONE_NUMBER_ID` não altera o resultado.

**INV-29 (T) — Todo evento de webhook é atribuído a exatamente uma organization ANTES de qualquer
efeito colateral; evento não atribuível é descartado e contabilizado.**
*Hoje falha:* `webhook.go:230` registra o evento antes de qualquer verificação de escopo.

**INV-30 (L+T) — A verificação de assinatura nunca é opcional. Duas asserções:**
**(a) boot:** em produção, `META_APP_SECRET` ausente → **o serviço não sobe** (fail-fast), nunca
"sobe com a validação desligada". *(Caso particular de INV-38.)*
**(b) request:** sem assinatura válida, o request é **rejeitado com 403** — valor confirmado ao vivo
em 15/09/2026, tanto sem `X-Hub-Signature-256` quanto com assinatura inválida.
L: proibir o padrão `if <segredo> != "" { <verificação> }` no pacote de webhook.
T: subir o serviço sem `META_APP_SECRET` em modo produção → boot aborta; e `POST /webhook` sem
assinatura válida → 403 com zero efeitos.
*Hoje falha:* `webhook.go:136` — a ausência do segredo **desabilita a validação** em vez de abortar.
Desde 15/09/2026 isso está neutralizado **por configuração**, não por código
([remediação](#remediação-de-15092026--assinatura-do-webhook-da-meta)) — e configuração some num
serviço novo ou num ambiente recriado. **A asserção (a) é o que torna o conserto permanente.**

**INV-31 (L+T) — A identidade do tenant deriva exclusivamente da autenticação do chamador, nunca de
campo do corpo, query ou header arbitrário.**
L: nenhum campo de struct de request pode se chamar `organization_id`, `tenant_id`, `app_id`,
`waba_id`, `phone_number_id` ou `loja`.
*Hoje falha:* `MediaUploadRequest.AppID` (`media_upload.go:34`), `QueueAddRequest.Loja`
(`queue.go:38`), corpo de `handleProblemsSync` (`problems.go:237-240`).

**INV-32 (L+T) — Toda consulta e toda escrita no banco tem predicado de organization.**
*Hoje falha:* `db.go:133, 184` (`DELETE FROM events` sem `WHERE`), `243, 258, 339, 352`.

**INV-33 (L+T) — Toda chave de estado em memória inclui a organization.**
T: o cooldown de auto-resposta da org A não suprime a resposta da org B para o mesmo telefone.
*Hoje falha:* `webhook.go:21` e os outros cinco stores.

**INV-34 (T) — Deduplicação e remoção de duplicados nunca cruzam organizations.**
*Hoje falha:* `queue.go:60-71, 176-208`.

**INV-35 (L+T) — O serviço não expõe identidade de tenant em endpoint não autenticado.**
T: `GET /health` sem credencial → sem `phone_number_id`, sem `waba_id`, sem qualquer identificador.
*Hoje falha:* `sender.go:447`. **É o invariant que fecha a janela coordenada com o painel.**

**INV-36 (T) — Credenciais de tenant nunca em texto claro em repouso, em log, em query string ou em
resposta de erro.**
*Hoje falha:* `media_upload.go:101-102` (token na query string).

**INV-37 (T) — Um envio disparado internamente (retry, auto-resposta, notificação) carrega o escopo
persistido da mensagem que o originou, nunca um default de configuração.**
T: reiniciar o processo entre o envio e o webhook de falha; o retry ainda usa o remetente correto.
*Hoje falha:* `retry.go:12-13` (volátil) e `webhook.go:41, 95` (leem `cfg` global).

**INV-38 (T) — *(expandido na rodada 9)* Toda configuração obrigatória de produção ausente causa
**boot FAIL**; nenhuma degradação silenciosa.**
Generalização do que antes cobria só `DATABASE_URL`. Em produção:

```text
META_APP_SECRET ausente  → boot FAIL   (também em INV-30a)
API_KEY ausente          → boot FAIL
DATABASE_URL ausente     → boot FAIL
```

T: subir o serviço em modo produção sem cada uma delas, isoladamente → o processo **não sobe**.
T: nenhuma delas resulta em "sobe com a feature desligada" nem em `/health` respondendo `ok`.
*Hoje falha:* `DATABASE_URL` → sobe em modo memória (`db.go:18-22`) com `/health` = `ok`
(`sender.go:446`); `API_KEY` → rotas abertas (`main.go:123-126`, `dashboard.go:15-18`);
`META_APP_SECRET` → validação desligada (`webhook.go:136`).
Desde 15/09/2026 as três **estão definidas** em produção (OPS-06/07/08) — o risco presente está
neutralizado **por configuração**, e os três defeitos de código permanecem.
**`mustEnv` (`main.go:147-153`) já implementa este comportamento no próprio repositório** (WG-P-08):
a correção é aplicá-lo, não inventá-lo.

**INV-39 (L+T) — *(novo na rodada 9)* Autenticação de endpoint interno é obrigatória e transportada
somente por header.**
Três asserções:
**(a)** endpoint interno sem credencial → **401**;
**(b)** credencial em **query string não é aceita** em nenhuma rota;
**(c)** a ausência de `API_KEY` configurada **nunca** resulta em rota aberta — o caso é coberto no
boot por INV-38, e aqui garante-se que não exista caminho de request que contorne.
L: nenhum handler lê credencial de `r.URL.Query()`.
T: as três chamadas verificadas ao vivo — sem credencial → 401, inválida → 401, válida → 200 — mais
`?key=<válida>` → **401**, não 200.
*Hoje falha:* **(b)** em `dashboard.go:19` (WG-28) e **(c)** em `main.go:123-126` e
`dashboard.go:15-18` (WG-27).

> **Por que INV-39 é novo e não expansão.** INV-31 trata de *identidade de tenant* não vir de
> corpo/query/header arbitrário; INV-36 trata de *credencial não vazar* em log, URL ou erro. Nenhum
> dos dois assevera que **a autenticação de serviço existe e só aceita header** — é propriedade
> distinta, e era a que faltava.

## J. Entitlements

**INV-23 (T) — Falha ao resolver o plano nega a feature.**
T: derrubar a fonte de entitlements → rota protegida responde 403, nunca 200.
*Hoje falha duas vezes:* o frontend volta a `DEFAULTS` todos `true`
(`admin/src/state/entitlements.ts:14-22, 36-39`) **e** o próprio endpoint faz
`{ ...ENTITLEMENTS_DEFAULT, ...entitlements }` (`server.js:13390`), com todos os defaults `true` —
uma chave ausente no armazenamento vira permissão concedida. Não há nenhuma checagem em rota.

---

## Resumo de aderência

| | Invariants | Sustentados hoje |
|---|---:|---:|
| A. Contexto de request | 3 | 0 |
| B. Banco | 4 | 0 |
| C. Descoberta de escopo | 4 | 0 |
| D. Atribuição | 1 | 0 |
| E. Credenciais | 3 | 1 (INV-13) |
| F. Webhooks | 2 | 0 |
| G. Jobs | 2 | 0 |
| H. Assets/cache/auditoria | 3 | 0 |
| I. Fronteira de serviço | 1 | 0 |
| J. Entitlements | 1 | 0 |
| K. Serviços da plataforma | 1 | 0 |
| **Subtotal — painel** | **25** | **1** |
| L. `whatsapp-webhook-go` | **13** | 0 |
| **Total** | **38** | **1** |

INV-13 (nenhum segredo vazado em resposta/log) segue sendo o único já satisfeito — e é do painel.
No serviço Go, **nenhum dos 12 se sustenta hoje**, coerente com categoria 1 = zero.

A numeração vai de INV-01 a INV-39 com **um buraco deliberado em INV-26**, vago quando aquele
controle virou OPS-01 — ver a nota na seção K. INV-27..INV-39 rodam no CI do repositório Go.

---

# Checklist operacional de infraestrutura

Controles que **não** são verificáveis em CI porque dependem de configuração de provedor, fora do
repositório. São verificados **no deploy** — por pessoa, runbook ou script de ambiente — e
reverificados a cada mudança de infraestrutura.

Distinção deliberada: a [série INV](#invariants-obrigatórios-antes-do-segundo-tenant) protege contra
regressão de **código**; esta lista protege contra regressão de **ambiente**. Um item na lista errada
vira teatro: um teste que não pode falhar, ou um controle que ninguém verifica.

| # | Controle | Verificação | Origem |
|---|---|---|---|
| **OPS-01** | **O `creative-lab` NÃO pode ter networking público habilitado** — sem Public Domain, sem Custom Domain, sem TCP Proxy | Railway → serviço `creative-lab` → Settings → Networking: as três seções vazias | D-1 |
| **OPS-02** | `CREATIVE_CORE_URL` aponta para o domínio **privado** | Deve ser `http://creative-lab.railway.internal:<porta>`. Um `*.up.railway.app` prova que OPS-01 foi violado | D-1 |
| **OPS-03** | Volume persistente montado para `STORAGE_DIR`/`UPLOADS_DIR`/`IMG_CACHE_DIR` | Sem volume, uploads e os JSON de `db/` somem a cada redeploy (`server.js:36-56`) | rodada 1 |
| **OPS-04** | Backups do Postgres habilitados e testados por restauração | Painel do Railway → Database → Backups | rodada 1 (NOT VERIFIED) |
| **OPS-05** | `DATABASE_URL` presente em produção (painel) | Enquanto TD-003 não tornar isso fail-fast no boot, é verificação de ambiente | rodada 1 |
| **OPS-06** | **`META_APP_SECRET` definido em produção** no serviço Go | ✅ **VERIFIED / OK** (15/09/2026). Restart confirmado: boot 02:01:15 com `sig_verify=true`, e negative testing devolveu 403 sem assinatura e 403 com assinatura inválida | rodada 6 · verificado rodada 9 |
| **OPS-07** | **`API_KEY` definida em produção** no serviço Go | ✅ **VERIFIED / OK** (15/09/2026). Os 21 endpoints internos estão autenticados | rodada 6 · verificado rodada 8 |
| **OPS-08** | **`DATABASE_URL` definida em produção** no serviço Go | ✅ **VERIFIED / OK** (15/09/2026). O serviço usa **persistência real**, não memory store | rodada 6 · verificado rodada 8 |
| **OPS-09** | **`WEBHOOK_FORWARD_URL`** e se carrega o `?secret=` que o painel compara | O lado Go não adiciona autenticação ao repasse (`webhook.go:255-257`); o segredo, se existe, vem embutido nessa URL. Mesma tela | rodada 6 |
| **OPS-10** | **Natureza do access token da Meta**: System User (sem expiração) ou token de usuário (60 dias) | Determina se a ausência de rotação (WG-21) é latente ou ativa. Meta Business Manager → Usuários do sistema | rodada 6 |
| **OPS-11** | **Pre-deploy Command do painel** = `npm run migrate:up` | Migrations rodam uma vez por deploy, **nunca no boot**. Railway → serviço do painel → Settings → Deploy → Pre-deploy Command. Sem isso, cada réplica tenta migrar em toda subida | rodada 7 (TD-010) |

> **OPS-06, OPS-07 e OPS-08 foram executados em 15/09/2026 e as três voltaram `definido`.**
> OPS-07 e OPS-08 estão **fechados**. OPS-06 fica **pendente de confirmação de restart** — ver
> [Remediação de 15/09/2026](#remediação-de-15092026--assinatura-do-webhook-da-meta).
>
> **A configuração resolve o risco presente; ela não resolve o defeito de código.** Nos três casos,
> o comportamento perigoso continua escrito no serviço e volta a valer sozinho num serviço novo, num
> redeploy limpo ou num ambiente recriado. Por isso cada um permanece coberto por um invariant:
> **INV-30** (assinatura) e **INV-38** (degradação de infraestrutura). Configuração não é garantia.

**OPS-01 é o mais frágil dos cinco**: é um clique de distância de ser desfeito, não deixa rastro no
repositório, e o efeito (exposição do serviço à internet) é silencioso. Merece estar no runbook de
deploy, não só aqui.

## Hardening opcional (prioridade baixa)

| # | Item | Justificativa |
|---|---|---|
| **H-01** | Reduzir `/v1/health` a `{ "status": "ok" }`, sem o manifesto de versões (`service.py:154`) | Defesa em profundidade. **Não é blocker**: com OPS-01 válido, o endpoint não é alcançável de fora. Passa a importar se OPS-01 for violado |

E ainda assim sem teste que o proteja de regressão — é justamente o tipo de garantia que se perde em
silêncio quando ninguém a asseverá.

---

# Tenant Surface Matrix (consolidada)

Visão por superfície. Detalhe linha a linha nos anexos.

| Superfície | Qtde | Ownership hoje | Risco dominante |
|---|---:|---|---|
| **Rotas** | 278 (**~243** após R-01) | nenhuma tem checagem de posse | 10 CRITICAL, 38 HIGH — [Anexo A](./anexo-a-matriz-de-rotas.md). As ~125 MEDIUM se resolvem removendo `loja` |
| **Tabelas** | 53 (**49** a tenantizar após R-01) | 7 globais, 22 por `loja`, 10 por conexão singleton, 9 com `tenant_id` | colisões estruturais — [Anexo B](./anexo-b-matriz-de-tabelas.md) |
| **Jobs** | ~18 | descobrem loja por `Object.keys(INK_STORES)` | 13 sem lock persistente |
| **Webhooks** | 2 | Ink: tentativa de segredo; WhatsApp: `wamid` | colisão silenciosa, sem replay protection |
| **Integrações** | 7 | GA4 por loja ✔; Meta/Google Ads globais ✘; Ink em env ✘; OpenAI por tenant fixo | credencial no nível errado |
| **Uploads/assets** | 3 endpoints + `media_assets` | nomes aleatórios ✔, sem dono ✘ | leitura por id sem posse |
| **Serviços** | creative-core (Python) | token de serviço ✔, sem tenant context | fronteira não carrega tenant |

---

# P0 Data Leak Review

Caminhos que, com dois tenants reais no modelo atual, causariam vazamento. **Hoje nenhum é uma falha
explorável**, porque existe um único tenant e um único admin — são consequências estruturais.

## Cross-tenant read

| Caminho | Local |
|---|---|
| Qualquer rota com `?loja=` — enum validado, posse não | ~125 rotas MEDIUM |
| `GET /api/admin/media/:id/arquivo` — id sequencial, sem dono | `server.js:15358` |
| `campaigns/:id`, `segments/:id`, `utm/campaigns/:id`, `despesas/:id` | Anexo A |
| `listarAuditLog()` sem filtro de loja | `server.js:1254-1269` |
| `GET /api/admin/analytics/consolidado?loja=X` | `server.js:12256` |

## Cross-tenant write

| Caminho | Local |
|---|---|
| **`POST /pedidos/:loja/:id/reembolsos`** — reembolso real contra loja escolhida pelo cliente | `server.js:3069-3073` |
| `PUT /financeiro/custos-api/precos/:chave` — tabela global | `server.js:12094` |
| `TRUNCATE controle_estoque_observacoes` sem WHERE | `server.js:8368` |
| `PUT/DELETE despesas/:id`, `campaigns/:id`, `utm/campaigns/:id` | Anexo A |

## Cross-tenant credential use

| Caminho | Local |
|---|---|
| `POST /integrations/google-analytics/disconnect?loja=X` — **revoga o refresh token de outro tenant** | `server.js:9872` |
| `POST /integrations/google-ads/contas/:customerId/loja` — reatribui conta de anúncios | `server.js:10625` |
| `POST /integrations/meta/select-account` | `server.js:11402` |
| Qualquer chamada Ink via `:loja` — escolhe o Bearer token | `server.js:1307-1333` |

## Cross-tenant webhook routing

| Caminho | Local |
|---|---|
| Ink: segredos iguais entre tenants → primeiro da ordem `sul, centro, norte` vence em silêncio | `server.js:1280-1291` |
| WhatsApp: `wamid` → `campaign_recipients` sem escopo de tenant | `server.js:16233` |

## Cross-tenant job execution

| Caminho | Local |
|---|---|
| Todos os jobs iteram `Object.keys(INK_STORES)` — o enum do processo, não as stores de um tenant | `server.js:3476, 3634, 13907, 14365` |
| Follow-ups operam sobre JSON global, sem lock → envio duplicado | `server.js:15178-15181` |
| **`POST /api/whatsapp-web-agente/claim`** — token único de instalação, `SELECT` sem filtro de `loja`: o agente de um tenant enviaria mensagem do outro, do telefone errado, ao cliente errado | `server.js:12873-12908` |

## Cross-tenant asset access

| Caminho | Local |
|---|---|
| `media_assets` por id sequencial, sem dono | `server.js:15358, 15391` |
| `GET /midia/:token/arquivo` — público, sem TTL e sem revogação (token opaco de 24 bytes) | `server.js:15391` |
| `UPLOADS_DIR` sem segmento de tenant no caminho | `server.js:36-56` |

**Ausências confirmadas (não são vazamento):** nenhum nome de arquivo previsível; nenhum segredo em
texto plano; nenhum segredo devolvido ao browser; nenhuma rota admin sem guard; nenhum GET mutante;
nenhum path traversal; nenhum segredo commitado.

---

# Client-controlled tenant context risks

*(seção exigida pelo addendum v2 §5)*

**Cadeia factual completa:**

1. `admin/src/state/adminState.ts:8-16` guarda a loja selecionada em `localStorage`, sem qualquer
   verificação contra a sessão.
2. A loja viaja ao backend como `req.query.loja`, `req.body.loja` ou `req.params.loja`.
3. O backend valida **apenas** `LOJAS[loja]` / `INK_STORES[loja]` — pertencimento a um enum fixo.
4. `requireAdmin` (`server.js:1574-1580`) não carrega tenant nenhum: a sessão é
   `${expiresAt}.HMAC(expiresAt)`.
5. **Não existe, em nenhum ponto do servidor, código que restrinja quais lojas uma sessão pode
   acessar.**

**Consequência:** o `localStorage` do browser é, hoje, a única coisa que determina qual loja a
sessão opera — e ele é totalmente controlado pelo cliente. Isso inclui escolher qual **credencial
de terceiro** usar (item 4 da lista CRITICAL: revogar o token GA4 de uma loja) e executar
**reembolso financeiro** contra a loja escolhida.

**`multiStoreMode` não é mitigação.** É cosmético: controla apenas a exibição do seletor na UI
(`admin/src/state/productSettings.ts`; nenhuma rota de negócio lê a flag —
`server.js:13333-13365`). Um cliente pode chamar qualquer endpoint `:loja` com o modo desligado.

> **Rodada 2 — como isso é resolvido.** TD-002 fecha o alvo:
> *authenticated user → organization → única store da organization → dados.*
> A Organization nunca vem do browser; a Store também não precisa vir, porque há uma só.
>
> A consequência prática inverte a estratégia da rodada 1: as ~125 rotas MEDIUM **não ganham
> checagem de posse — elas param de receber `loja`**. Remover o parâmetro elimina a classe inteira
> de risco, em vez de mitigá-la rota a rota. `multiStoreMode` é removido junto (R-02), por ter
> deixado de ter sentido.
>
> As 10 rotas CRITICAL e as ~38 HIGH continuam exigindo verificação de posse contra a Organization
> autenticada — nelas o identificador seleciona credencial ou recurso, não apenas escopo.

**Confirmação do princípio do addendum:** frontend/localStorage não é, e nunca foi, fronteira de
segurança neste sistema. Hoje isso não causa dano porque o perímetro (uma senha, um dono) é a
fronteira real. A productização remove esse perímetro — e não há nada atrás dele.

---

# Current-to-Target Map

| Subsistema | Current | Target | Dependência de migração | Risco |
|---|---|---|---|---|
| Identidade | senha única, sessão sem sujeito | `users` + sessão com `user_id` + papéis | antes de tudo que precisa de audit | CRITICAL |
| Tenancy | enum `LOJAS` no código | `organizations` + `stores` | migrations (TD-010) | CRITICAL |
| Tenant context | `loja` do browser | resolvido da sessão; **`loja` sai dos endpoints** | identidade | CRITICAL |
| Autorização | `requireAdmin` binário | pipeline com membership + entitlement | identidade, tenancy | CRITICAL |
| Cardinalidade | 3 lojas num painel | **1 Organization = 1 Store**; dono com 2 lojas = 2 workspaces | PD-002 ✔ | — |
| Atribuição de mídia na DRE | soma a conta selecionada sem conferir escopo (F-01) | fail-closed: recurso ambíguo fica fora e é sinalizado | PD-021 ✔ | HIGH |
| Migração Use Origens | feature ativa atrás de env flag | **removida do produto**; tabelas LEGACY até migration | R-01, TD-010 | LOW |
| `multiStoreMode` | flag cosmética em `app_config` | **removida** | R-02 | LOW |
| Entitlements | UI fail-open, backend ausente | middleware fail-closed + quotas | plano/billing (PD-005/009) | CRITICAL |
| Credenciais Ink | env por loja | `integrations` cifrado por Store | tenancy, chave separada | CRITICAL |
| Meta Ads / Google Ads | 1 linha (`CHECK id=1`) | por Organization, recurso→Store explícito | migrations, PD-016 | CRITICAL |
| GA4 | por loja ✔ | por Store (renomear escopo) | tenancy | LOW |
| OpenAI BYOK | por `tenant_id` de env | por Organization, do request | tenancy | MEDIUM |
| creative-core | token de serviço, sem tenant | tenant derivado no Node, propagado + correlation id | tenancy | HIGH |
| Webhooks | tentativa de segredo | URL opaca por conexão + idempotência | tenancy, integrations | CRITICAL |
| Jobs | `setInterval` in-process, lock em memória | leasing persistente + budget por tenant | tenancy | HIGH |
| Persistência | Postgres opcional + JSON | Postgres obrigatório em produção | — | CRITICAL |
| Storage | volume local sem segmento de tenant | object storage com prefixo por tenant + URL assinada | tenancy | HIGH |
| Clientes | derivado de `pedidos_ink`, por loja | entidade com identidade e consentimento definidos | PD-017 | CRITICAL |
| DRE | por loja, fuso e moeda implícitos | por Organization com recorte por Store, fuso/moeda de config | PD-016 | HIGH |
| Ferramentas internas | env flag | permissão de platform admin | identidade + papéis | MEDIUM |
| Testes | 228 passam, 0 de isolamento | matriz A1/A2/B1 obrigatória em CI | tenancy | CRITICAL |
| Observabilidade | `console.*` sem contexto | log estruturado com org/store/user/job/request id | — | HIGH |

---

# Checklist P0 para primeiro cliente externo

Resposta SIM/NÃO conforme o levantamento §121.

| Item | Hoje | Evidência |
|---|---|---|
| Auth individual | **NÃO** | senha única; sessão sem sujeito (`server.js:1541-1545`) |
| Tenant isolation | **NÃO** | enum no código; posse inexistente |
| Stores dinâmicas | **NÃO** | `LOJAS` hardcoded (`server.js:58`); novo tenant exige redeploy. *Com PD-002, "dinâmicas" passa a significar: a Store nasce com a Organization no onboarding — não que um tenant possa criar várias* |
| Tokens fora do `.env` | **PARCIAL** | Meta/GA4/Google Ads/OpenAI no banco cifrados ✔; **Ink em env** ✘ |
| Secrets protegidos | **PARCIAL** | AES-256-GCM real ✔; **chave única derivada do segredo de sessão** ✘ |
| Webhooks roteados por tenant | **PARCIAL** | funciona com segredos distintos; colide em silêncio se iguais |
| Jobs tenant-aware | **NÃO** | iteram o enum do processo; 13 sem lock |
| Audit log | **PARCIAL** | existe (`audit_log`) ✔; **sem sujeito e sem filtro por loja** ✘ |
| Integrações self-service | **PARCIAL** | Meta/GA4/Google Ads/OpenAI via UI ✔; **Ink não** ✘ |
| Test connection | **PARCIAL** | OpenAI e saúde da Ink ✔; não padronizado |
| Backup | **NÃO VERIFICADO** | sem configuração de backup no repositório |
| Error tracking | **NÃO** | só `console.error` |
| LGPD mínimo | **NÃO** | sem exclusão, sem exportação, `webhook_eventos` sem retenção |
| Data deletion strategy | **NÃO** | nenhum `DELETE FROM webhook_eventos` existe |
| Entitlements básicos | **NÃO** | fail-open na UI, ausentes no backend |
| Operação interna migrada para Tenant #1 | **NÃO** | não iniciado (PD-019) |

## Checklist adicional do addendum v2 §24

| Item | Hoje |
|---|---|
| tenant context server-authoritative | **NÃO** |
| frontend/localStorage não é fronteira de segurança | **NÃO** (é, na prática) |
| entitlements fail-closed no backend | **NÃO** |
| Postgres obrigatório em produção SaaS | **NÃO** |
| rotas tenant-scoped inventariadas 100% | **SIM** ✔ (278 rotas — Anexo A) |
| Meta Ads e WhatsApp separados corretamente | **SIM** ✔ (domínios distintos, confirmado) |
| GA4/Meta/Google Ads mapeados a Organization/Store | **PARCIAL** (só GA4) |
| creative-core tenant-aware | **PARCIAL** (schema sim, origem do tenant não) |
| BYOK OpenAI tenant-scoped e protegido | **PARCIAL** (protegido ✔, escopo fixo ✘) |
| creative/media assets isolados | **NÃO** |
| API costs atribuídos por Organization | **PARCIAL** (consumo sim, preços globais) |
| DRE/Financeiro tenant-scoped | **PARCIAL** (por loja, com furos) |
| customer identity/dedup definido | **NÃO** (PD-017) |
| internal tools isoladas da tenant app | **PARCIAL** ✔ (gate consistente; falta papel) |
| testes automatizados de tenant isolation | **NÃO** |
| provider rate limiting/noisy-neighbour analisado | **SIM** ✔ (analisado; não mitigado) |

---

# Respostas às 20 perguntas do levantamento §122

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Quantos pontos dependem do array fixo de 3 lojas? | **144 referências** a `LOJAS`/`INK_STORES`, quase todas em `server.js`; 5 no frontend |
| 2 | Onde os tokens Ink são carregados? | `server.js:69-73`, de `INK_TOKEN_{SUL,CENTRO,NORTE}` |
| 3 | Onde o serviço WhatsApp recebe credenciais? | env: `WHATSAPP_SERVICE_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_WEBHOOK_SECRET` |
| 4 | O serviço WhatsApp é multi-tenant? | **Não** — 1 WABA por instalação (`server.js:291`) |
| 5 | Como cada webhook identifica a loja? | Ink: testa o segredo de cada loja. WhatsApp: `wamid` → `campaign_recipients` |
| 6 | Como pedidos armazenam store? | coluna `loja` em `pedidos_ink` |
| 7 | `store` é string ou FK? | **string** (chave do enum), não FK |
| 8 | Como clientes são deduplicados entre lojas? | **Não são** — union-find agrupado por loja primeiro (`server.js:8441-8447`) |
| 9 | Segmentos são globais ou por loja? | **globais** (`segments` sem discriminador) |
| 10 | Campanhas são globais ou por loja? | têm coluna `loja`, mas as ~17 rotas `:id` **não filtram por ela** |
| 11 | Templates WhatsApp são globais? | `whatsapp_web_mensagens` é global, com `UNIQUE(lower(nome))` |
| 12 | Automações são globais ou por loja? | em `db/automacao*.json` / `app_config` — **globais** |
| 13 | Media assets têm ownership? | têm coluna `loja`, mas as rotas `:id` **não a usam** |
| 14 | `app_config` é global? | **sim** — `chave TEXT PRIMARY KEY` (`server.js:220-224`) |
| 15 | Existe código que lê env durante request? | **sim** — `INK_STORES`, `ADMIN_PASSWORD`, `CREATIVE_TENANT_ID`, `GOOGLE_ADS_EM_USO` |
| 16 | Jobs têm locks persistentes? | **3 de ~16** (`FOR UPDATE SKIP LOCKED`); o resto é flag em memória |
| 17 | O fallback JSON é necessário em produção? | **Não.** É LEGACY_FALLBACK e hoje pode virar autoritativo em silêncio (TD-003) |
| 18 | Como uploads são isolados? | **não são** — nome aleatório ✔, mas sem segmento de tenant no caminho e sem posse na leitura |
| 19 | Como o status de plano é calculado? | lido de `app_config`/`db/entitlements.json`, com defaults hardcoded; **não é aplicado no backend** |
| 20 | Qual parte já está preparada para produto genérico? | **creative-core** (tenant_id em todo o schema e em todas as queries) e **GA4** (conexão por loja). São os dois modelos de referência. |

---

# NOT VERIFIED

> **Rodada 4 fechou a maior parte desta lista.** Resolvidos: estrutura de `whatsapp-template-config`,
> `meta-metas` e `whatsapp-meta-app` (D-4) · seleção de WABA/`phone_number_id` (D-2) · índices únicos
> das tabelas de integração (D-5) · `desktop/` e `src/` (D-3, D-6) · trust boundary do `creative-lab`
> (D-1, com a ressalva abaixo).
>
> **Resta apenas o que não é determinável por leitura de código.** Para cada um, o que falta está
> dito como ação concreta, não como "não verificado":

| Item | O que falta exatamente |
|---|---|
| ~~`creative-lab` tem domínio público?~~ | ✅ **RESOLVIDO na rodada 5** — `CREATIVE_CORE_URL=http://creative-lab.railway.internal:8080`, sem Public/Custom Domain nem TCP Proxy. Rede privada confirmada. Virou **OPS-01** |
| ~~Tenancy do `whatsapp-webhook-go`~~ | ✅ **RESOLVIDO na rodada 6** — auditado em `/Users/gtomazi/projects/whatsapp-webhook-go` (HEAD `bf91ff1`). 26 achados, 12 invariants, relatório em [`whatsapp-webhook-go-audit.md`](./whatsapp-webhook-go-audit.md). **Não há mais lacuna de cobertura.** |
| **Topologia de deploy do serviço Go** | **PD-023** — decisão, não verificação. A consulta que a informa: painel da hospedagem → serviço `whatsapp-webhook-go` → quantas instâncias/ambientes existem. Ver também OPS-10 |
| Env de produção do serviço Go (4 valores) | Consolidados como **OPS-06..OPS-09**, com a tela exata de cada um |
| Itens 6, 7, 10, 11, 12 do anexo do serviço Go | Natureza do token da Meta (**OPS-10**) · se a Meta ecoa a URL em erro de upload (exige chamada real à API de produção) · quantos apps/WABAs a conta possui (Meta Business Manager) · `teste_envio.py`, não versionado e fora do artefato construído (`Dockerfile:6` copia só `*.go *.html`) · comportamento sob concorrência real (exige teste de carga) |
| Item 8 do anexo: o painel envia `loja` em toda chamada de `/queue/add`? | **Verificável aqui** — o lado Go aceita o campo como opcional (`queue.go:38`). Fica registrado como trabalho de verificação cruzada, não como incógnita |
| Backup do Postgres e criptografia em repouso do volume | Painel do Railway → Database → Backups; e a política de disco do plano |
| Comportamento em runtime | o servidor não foi executado em nenhuma rodada; a auditoria é estática + suíte de testes |
| Conteúdo real do `.env` de produção | não está no repositório (corretamente) |
| Se erros da API do Google ecoam token | não há masking dedicado nesse caminho; exigiria provocar o erro |
| Revogação de token no provedor para Meta e GA4 | só Google Ads chama `GOOGLE_REVOKE_URL`; confirmar no console de cada provedor |

## Lista original (rodadas 1-3), mantida para rastreio

| Item | Motivo |
|---|---|
| Comportamento em runtime | o servidor não foi executado; a auditoria é estática + suíte de testes |
| Conteúdo real do `.env` de produção | não está no repositório |
| Segredo mestre de cifra do BYOK (origem exata em `server.js`) | fora do trecho lido pelo workstream de criativos |
| Configuração de rede do serviço Railway `creative-lab` | não determinável pelo repositório — **se o serviço Python tem domínio público habilitado é uma questão P0 em aberto** |
| Backup do banco e criptografia em repouso do volume Railway | configuração de infraestrutura, fora do repositório |
| Se erros da API do Google ecoam token | não há masking dedicado nesse caminho; não foi provocado |
| Revogação de token no lado do provedor para Meta e GA4 | só Google Ads chama `GOOGLE_REVOKE_URL` |
| Se `whatsapp_web_outbox.referencia` sempre embute `loja` para `origem` `carrinho`/`pix` | confirmado só para `origem='pedido'` (`server.js:13787`) |
| Varredura linha a linha dos 262 `console.error` | busca dirigida por PII/token não achou vazamento; não é exaustiva |
| Toda função auxiliar chamada por cada uma das 278 rotas | as citadas foram abertas; nem todas |
| Divergência real de fuso em produção | inconsistência confirmada no código, efeito não medido |
| Campos de PII na resposta de reembolso da Ink além do nome | resposta externa não capturada |
| `scripts/**` e `routes/**` além de `criativos.js` | fora do recorte dos workstreams |
| Implementação de `sincronizarMeta`, `sincronizarControleEstoque`, `dentroDaJanelaDeEnvio` | não lidas linha a linha |
| Se a UI de GA4 impede reusar a mesma property em duas lojas | `GoogleAnalyticsIntegracaoCard.tsx` não inspecionado |
| `google_ads_connections.login_customer_id` — como é preenchido | não rastreado |
| **(R3)** Estrutura interna de `whatsapp-template-config`, `meta-metas`, `whatsapp-meta-app` | não seguidas linha a linha; não se sabe se são namespaced por loja |
| **(R3)** Como o serviço externo `whatsapp-webhook-go` escolhe WABA/`phone_number_id` no modo `meta_api` | serviço fora deste repositório |
| **(R3)** Índices únicos parciais em `bulk_category_jobs`, `campaigns`, `whatsapp_web_outbox` | migrations não inspecionadas |
| **(R3)** Estrutura interna de `carrinho-envios` | não inspecionada |
| **(R3)** `desktop/` e `src/` (site público) | fora do escopo das três varreduras de ownership |

---

## Nota de supervisão de escopo

Durante esta auditoria **nenhum arquivo de código do projeto foi alterado**. As únicas escritas foram
em `docs/produtizacao-saas/`. O working tree não apresenta sinal de trabalho concorrente de outro
agente sobre `server.js`, `lib/`, `routes/` ou `admin/src/` — as mudanças pendentes no git são
documentação e configuração de agente.

Duas afirmações produzidas pelos workstreams foram **corrigidas** pela revisão do lead antes de
entrar neste documento (registradas no cabeçalho do Anexo A): um falso positivo de path traversal em
`/assets/pedidos/:filename` e uma limitação sobre entropia de ids que pôde ser resolvida.
