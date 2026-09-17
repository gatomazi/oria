# Anexo B — Matriz de tabelas: tenancy e persistência

> Anexo de [`productization-audit.md`](./productization-audit.md). Baseline: commit `8a7ea3d`, 15/09/2026.
> 53 tabelas (44 em `server.js`, 9 em `lib/creative-core/schema.js`). Auditoria READ-ONLY.

## Atualização após a revisão de decisões do usuário

Reclassificações decididas pelo usuário. As linhas abaixo continuam sendo o retrato do commit
`8a7ea3d`; o que muda é o destino de cada tabela.

| Tabela | Nova classificação | Observação |
|---|---|---|
| `origens_migration_rules` | **LEGACY / TO_REMOVE** | a feature sai do produto |
| `origens_migration_simulations` | **LEGACY / TO_REMOVE** | idem |
| `origens_migration_simulation_items` | **LEGACY / TO_REMOVE** | idem |
| `origens_migration_city_uf_map` | **LEGACY / TO_REMOVE** | idem |

**Nenhum `DROP` nesta etapa.** A remoção acontece depois, por migration versionada, quando a infra
de migrations existir (TD-010). Até lá as tabelas permanecem no banco, sem rota que as alcance.

As 4 tabelas saem da conta de tabelas a receber `organization_id`: **53 → 49 tabelas** a
tenantizar.

Também reclassificado: `app_config` deixa de precisar guardar `multiStoreMode` — a flag é
**LEGACY / TO_REMOVE** (ver `productization-decisions.md`, §Escopo removido da V1).


Escopo: tenancy, schema, queries e persistência. READ-ONLY. Fonte primária: `server.js` (bootstrap
de schema em `bootstrapPostgres()`, linhas 118–1133) e `lib/creative-core/schema.js`.

Contexto confirmado: `const LOJAS = { sul, centro, norte }` (server.js:58) é a única noção de
"loja" hoje. Não existe tabela `users`/`organizations`/`tenants`/`accounts` em lugar nenhum do
repo (grep confirmado). `requireAdmin` (server.js:1574) é um único cookie de sessão global —
não existe nenhum conceito de "admin escopado a uma loja" na camada de autorização.

---
## (a) Inventário de tabelas

Legenda de Classificação: GLOBAL (sem discriminador, linha única compartilhada) · STORE_SCOPED
(tem coluna `loja`/`loja_atribuida`) · CONNECTION_SCOPED (escopada a uma linha de conexão de
integração, ex. `meta_account_id`/`customer_id`) · OTHER (herda escopo via FK, sem coluna própria).

| Tabela | Arquivo:linha | Discriminador de tenant | Classificação | Filtragem consistente? | Risco |
|---|---|---|---|---|---|
| `pedidos_ink` | server.js:121 | `loja` (NOT NULL) | STORE_SCOPED | Sim, nas rotas de leitura/escrita normais. Exceção: `UPDATE pedidos_ink SET payment_status=... WHERE LOWER(payment_status)=$2` (server.js:1157-1160, backfill de normalização) roda sobre TODAS as lojas sem filtro | Baixo (é um fix de dado, não expõe nada a um cliente) |
| `pedidos_ink_itens` | server.js:159 | `loja` (PK composta `(loja,item_id)`) | STORE_SCOPED | Sim (sempre `JOIN ... ON p.loja=i.loja`) | — |
| `sync_estado` | server.js:182 | `loja` (PK) | STORE_SCOPED | Sim | — |
| `pedidos_backfill_jobs` | server.js:192 | `loja` | STORE_SCOPED | Sim | — |
| `webhook_eventos` | server.js:206 | `loja` (nullable) | STORE_SCOPED (fraco) | Não verificado exaustivamente; listagem de auditoria não parece filtrar por loja | Baixo hoje (tela interna) |
| `app_config` | server.js:220 | nenhum (`chave` é a PK) | **GLOBAL** | N/A — 1 linha por `chave`, nunca por loja | Alto (ver seção app_config abaixo) |
| `estoque_observacoes` | server.js:231 | `loja` | STORE_SCOPED | Sim (`WHERE $1::text IS NULL OR loja=$1`, GET) | Leitura "todas as lojas" é intencional (`loja` opcional na query) |
| `controle_estoque_observacoes` | server.js:253 | `loja` | STORE_SCOPED | Escrita **NÃO** é sempre filtrada — ver Risco | **Alto**: `TRUNCATE controle_estoque_observacoes` sem WHERE em server.js:8368 quando `POST /api/admin/controle-estoque/limpar` é chamado sem `loja` no body — apaga o histórico de TODAS as lojas de uma vez |
| `audit_log` | server.js:273 | `loja` (nullable) | STORE_SCOPED (fraco) | `listarAuditLog()` (server.js:1254-1269) filtra só por `action`, nunca por `loja` | Médio (vazaria histórico de reembolso entre tenants) |
| `media_assets` | server.js:295 | `loja` (nullable, comentário explícito diz que é "opcional de propósito" pois hoje é 1 conta WhatsApp compartilhada) | OTHER/parcial | **Não** — `GET /api/admin/media/:id/arquivo` (server.js:15358-15360) e `DELETE /api/admin/media/:id` (server.js:15391-15401) buscam só por `id` sequencial, sem checar `loja` | **Alto**: IDOR — id sequencial (`BIGSERIAL`) exposto na URL sem checagem de posse |
| `segments` | server.js:322 | nenhum | **GLOBAL** | N/A — segmento não pertence a loja nenhuma (só a campanha que o usa tem `loja`) | Médio — segmento de audiência é compartilhável entre lojas por desenho |
| `campaigns` | server.js:335 | `loja` (NOT NULL) | STORE_SCOPED | **Não** para rotas por id — `GET/PUT/DELETE/duplicate/start/pause/resume/summary/recipients /api/admin/campaigns/:id*` fazem `WHERE id=$1` sem checar `loja` (server.js:9055,9097,9103,9122,9127,9140,9272,9288,9324,9356,9363,9377,9399,9428,14834,14840,14847,14849) | **Alto**: IDOR — id sequencial em rota, sem checagem de `loja` |
| `campaign_recipients` | server.js:359 | nenhuma coluna `loja` própria (herda via FK `campaign_id`) | OTHER | Segue o mesmo problema de `campaigns` — se a rota pai não checa `loja`, o filho também não | Alto (herdado) |
| `produtos_feed` | server.js:403 | `loja` (PK composta) | STORE_SCOPED | Sim, sempre `loja = ANY($1)`/`loja=$1` | Único ponto sem filtro é `GROUP BY loja` administrativo (server.js:3953) — soma total por loja de propósito, não vaza linha |
| `produtos_feed_sync` | server.js:422 | `loja` (PK) | STORE_SCOPED | Sim | — |
| `produtos_ink` | server.js:436 | `loja` (PK composta) | STORE_SCOPED | Sim | Mesmo padrão de `GROUP BY loja` administrativo em server.js:3867 |
| `produtos_ink_sync` | server.js:460 | `loja` (PK) | STORE_SCOPED | Sim | — |
| `bulk_category_jobs` | server.js:479 | `loja` | STORE_SCOPED | `/api/admin/category-jobs/:id*` (server.js:4656+) não foi 100% verificado linha a linha, mas segue o mesmo padrão de rota por id só | Não verificado exaustivamente |
| `bulk_category_job_items` | server.js:502 | nenhuma (via FK `job_id`) | OTHER | Herdado | — |
| `origens_migration_rules` | server.js:525 | `loja` | STORE_SCOPED | Rotas `/rules/:id` (server.js:6298,6340) por id só, sem checar `loja` | Médio — ferramenta interna (`requireInternalTools`, gate por env var) |
| `origens_migration_simulations` | server.js:542 | `loja` | STORE_SCOPED | Rotas `/simulations/:id*` (múltiplas, server.js:6621+) por id só | Médio — mesma ferramenta interna |
| `origens_migration_simulation_items` | server.js:556 | nenhuma (via FK `simulation_id`) | OTHER | Herdado | — |
| `origens_migration_city_uf_map` | server.js:591 | `loja` (UNIQUE `(loja,cidade_normalizada)`) | STORE_SCOPED | `/city-uf-map/:id` (server.js:7621,7633) por id só | Médio — ferramenta interna |
| `whatsapp_web_outbox` | server.js:627 | `loja` (nullable) | STORE_SCOPED (fraco) | Dedupe (`dedupe_key = origem:referencia`) **não inclui `loja` na constraint** — depende de convenção no código (referencia já embute `loja` na maioria dos chamadores, ex. server.js:13787) para não colidir entre lojas | Médio — constraint de banco não garante isolamento, só a convenção do chamador |
| `whatsapp_web_mensagens` | server.js:657 | nenhum | **GLOBAL** | UNIQUE `(lower(nome))` — nomes de mensagem são globais, uma loja não pode ter mensagem com o mesmo nome de outra | Médio (ver colisões) |
| `utm_campaigns` | server.js:695 | `loja` (NOT NULL) | STORE_SCOPED | **Não** para rotas por id — `GET/PATCH/DELETE /api/admin/utm/campaigns/:id` (server.js:8849,8878,8897) fazem `WHERE id=$1` sem checar `loja` | **Alto**: IDOR |
| `utm_presets` | server.js:715 | nenhum | **GLOBAL** | N/A | Baixo |
| `google_analytics_connections` | server.js:727 | `loja` (UNIQUE) | STORE_SCOPED | Sim, sempre `WHERE loja=$1` | — |
| `ga4_performance_cache` | server.js:748 | `loja` (UNIQUE com `periodo`) | STORE_SCOPED | Sim | — |
| `meta_connections` | server.js:764 | nenhum — **`id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1)`** | **GLOBAL por desenho explícito** | N/A | Bloqueador estrutural — comentário do próprio código (server.js:758-761) diz: *"UMA só, por decisão de produto (1 cliente = 1 loja; saímos da ideia de SaaS multi-tenant)... Se um dia voltar a ser multi-tenant, troca-se o PK por (tenant_id)"* |
| `meta_ad_accounts` | server.js:784 | `loja_atribuida` (nullable, `ALTER` tardio, server.js:804) | GLOBAL (a conexão é global) + atribuição de loja é só um rótulo de negócio | N/A | UNIQUE em `meta_account_id` — ver colisões |
| `meta_campaigns` | server.js:810 | `meta_account_id` | CONNECTION_SCOPED | Sim (indexado por conta) | UNIQUE em `meta_campaign_id` — ver colisões |
| `meta_adsets` | server.js:830 | `meta_account_id` | CONNECTION_SCOPED | Sim | UNIQUE em `meta_adset_id` |
| `meta_ads` | server.js:853 | `meta_account_id` | CONNECTION_SCOPED | Sim | UNIQUE em `meta_ad_id` |
| `meta_creatives` | server.js:876 | `meta_account_id` | CONNECTION_SCOPED | Sim | UNIQUE em `meta_creative_id` |
| `meta_insights_daily` | server.js:899 | `meta_account_id` | CONNECTION_SCOPED | Sim | UNIQUE composto inclui `meta_account_id` — ok |
| `meta_sync_logs` | server.js:960 | `meta_account_id` (nullable) | CONNECTION_SCOPED | Sim | — |
| `despesas_operacionais` | server.js:983 | `loja` (NOT NULL) | STORE_SCOPED | **Não** — `PUT/DELETE /api/admin/financeiro/despesas/:id` (server.js:12042,12061-12064) por id só | **Alto**: IDOR |
| `google_ads_connections` | server.js:1005 | nenhum — **`id SMALLINT DEFAULT 1 CHECK (id=1)`** | **GLOBAL por desenho explícito** | N/A | Mesmo bloqueador estrutural que `meta_connections` (comentário server.js:998-1004 remete ao mesmo desenho) |
| `google_ads_customers` | server.js:1026 | `loja_atribuida` (nullable) | GLOBAL (conexão global) | N/A | UNIQUE em `customer_id` |
| `google_ads_campaigns` | server.js:1048 | `customer_id` | CONNECTION_SCOPED | Sim | UNIQUE `(customer_id, campaign_id)` |
| `google_ads_insights_daily` | server.js:1072 | `customer_id` | CONNECTION_SCOPED | Sim | UNIQUE composto inclui `customer_id` |
| `google_ads_sync_logs` | server.js:1104 | `customer_id` (nullable) | CONNECTION_SCOPED | Sim | — |
| `custos_api_precos` | server.js:1124 | nenhum (`chave` PK) | **GLOBAL** | N/A | Preço de API é config de plataforma, não de loja |
| `creative_settings` | lib/creative-core/schema.js:8 | `tenant_id` (PK) | Nominalmente TENANT_SCOPED | Sim nas queries (`pgStore.js` sempre `WHERE tenant_id=$1`) | Ver nota crítica abaixo — `tenant_id` é constante de processo |
| `creative_brand_profiles` | lib/creative-core/schema.js:16 | `tenant_id` | idem | Sim | idem |
| `creative_niche_profiles` | lib/creative-core/schema.js:28 | `tenant_id` | idem | Sim | idem |
| `creative_context_profiles` | lib/creative-core/schema.js:40 | `tenant_id` | idem | Sim | idem |
| `creative_personas` | lib/creative-core/schema.js:52 | `tenant_id` | idem | Sim | idem |
| `creative_products` | lib/creative-core/schema.js:64 | `tenant_id` | idem | Sim | idem |
| `creative_jobs` | lib/creative-core/schema.js:78 | `tenant_id` | idem | Sim | idem |
| `creative_generations` | lib/creative-core/schema.js:93 | `tenant_id` | idem | Sim | idem |
| `creative_assets` | lib/creative-core/schema.js:144 | `tenant_id` | idem | Sim | idem |

**Total: 53 tabelas** (44 em `server.js` + 9 em `lib/creative-core/schema.js`).

### Nota crítica sobre `creative_*` (tenant_id)
`routes/criativos.js:9,92`: *"tenant_id vem da env `CREATIVE_TENANT_ID` (servidor), nunca do
request"* — `const tenantId = (env.CREATIVE_TENANT_ID || 'default').toLowerCase();`. Isso é
calculado **uma vez, no mount do módulo** (processo inteiro), não por request/sessão/loja. Ou
seja: as 9 tabelas `creative_*` são as ÚNICAS do repo desenhadas com um discriminador de tenant
de verdade e filtradas 100% corretamente em `lib/creative-core/pgStore.js` — mas hoje, dentro de
um único deploy, `tenant_id` é sempre o MESMO valor fixo para todas as 3 lojas (`sul`/`centro`/
`norte` compartilham um `tenant_id` só, tipicamente `'default'`). O desenho da tabela está pronto
para multi-tenant; o valor que a alimenta, não.

---
## (b) Classificação de persistência (Postgres vs JSON)

`DATABASE_URL` é opcional (server.js:112-116): `pgPool` só existe se a env var estiver setada.
Todo o bootstrap de schema roda em `bootstrapPostgres().then(...).catch((err) => console.error(...))`
(server.js:1177-1181) — **nunca** há `process.exit`, `throw` não capturado, ou qualquer gate antes
de `app.listen(PORT, ...)` (server.js:16349). `app.listen` não depende de `pgPool` nem de
`bootstrapPostgres` ter terminado ou sucedido.

**Resposta à Task 7: sim, o serviço sobe (boot completo, `app.listen` chamado e aceitando
conexões) mesmo sem `DATABASE_URL`, e mesmo que a conexão ao Postgres falhe.** O único efeito
visível é: `pgPool === null` → todo código com `if (pgPool) {...}` cai no branch JSON, e todo
código com `if (!pgPool) return res.status(503)...` passa a devolver 503 só naquelas rotas
específicas (lucro-produtos, dashboard/financeiro, estoque, controle-estoque, WhatsApp Web),
nunca derrubando o processo.

| Caminho de persistência | Função/mecanismo | Domínios que usam | Classificação |
|---|---|---|---|
| `app_config` (Postgres) + espelho em `db/*.json` | `lerConfigPostgres`/`salvarConfigPostgres` (server.js:1187-1204) | `pedidos`, `meta-metas`, `automacao-settings`, `whatsapp-provider`, `whatsapp-web-agente`, `whatsapp-meta-app`, `settings-product`, `entitlements`, `campos-customizados`, `whatsapp-template-config`, `automacao-eventos`, `carrinho-envios`, `pix-lembretes`, `envios-pendentes-janela` | **DATABASE_AUTHORITATIVE quando Postgres existe** (arquivo vira só melhor-esforço/espelho); **LEGACY_FALLBACK / LOCAL_DEV_ONLY quando não existe** (aí o arquivo manda de verdade) |
| `db/*.json` sem contraparte Postgres | leitura/escrita direta (`fs.readFileSync`/`writeFileSync`) | `audit_log.json` (log local, tem espelho parcial em `audit_log` mas listagem lê só Postgres quando existe), `ink_webhook_log.json` (idem, espelho em `webhook_eventos`) | CACHE local com cap de tamanho (200/500 linhas) + Postgres durável quando disponível |
| `db/pedidos.json` | `PEDIDOS_FILE`, backfill único (`backfillPedidosSeNecessario`, server.js:1138-1147) | Hotpages de pedido Pix | LEGACY_FALLBACK — nasceu em produção antes do Postgres existir; migrado 1x no boot, daí em diante é espelho |
| `data/*.json` (`cities.json`, `collections.json`, `config.json`, `produtos.json`, `df-regioes-administrativas.json`) | não usa `lerConfigPostgres`; não apareceu nenhuma tabela Postgres equivalente nas buscas feitas | Catálogo de cidades/coleções do site público (busca de cidade → loja) | **FILE_STORAGE / LOCAL_DEV_ONLY-like, mas na verdade é dado estático versionado no repo, não estado mutável de runtime** — não verificado se há escrita em runtime nesses arquivos (não encontrada nenhuma) |
| `IMG_CACHE_DIR`, `UPLOADS_DIR` | `fs.mkdirSync`/streams (server.js:36-50) | Cache de imagem de produto + upload de mídia admin (`media_assets.storage_key` aponta pra cá) | **EPHEMERAL em produção** — comentário do próprio código (server.js:44-49) confirma: `STORAGE_DIR` não está de fato setado em prod hoje (cai em `__dirname`, que é apagado a cada deploy), mesmo havendo volume Railway montado; só `UPLOADS_DIR` tenta usar `RAILWAY_VOLUME_MOUNT_PATH` diretamente como contorno |
| Postgres — todas as 44 tabelas de `server.js` exceto `app_config` | queries diretas | Pedidos, produtos, campanhas, integrações Meta/Google/GA4, migração de categorias, WhatsApp Web outbox | **DATABASE_AUTHORITATIVE quando configurado; funcionalidade simplesmente indisponível (503) quando não** — ex.: `/api/admin/dashboard/lucro-produtos` (server.js:2538), `/api/admin/dashboard/financeiro` (server.js:2595), `/api/admin/estoque` (server.js:8247), `/api/admin/controle-estoque` (server.js:8293) todos retornam 503 explícito sem Postgres — não degradam pra JSON |
| Postgres — `creative_*` (9 tabelas) | `lib/creative-core/pgStore.js` vs `lib/creative-core/memoryStore.js` | Gerador de criativos | **DATABASE_AUTHORITATIVE quando configurado; CACHE em memória de processo (não persistente, perdida a cada restart) quando não** — `memoryStore.js` é literalmente um fallback in-memory, mais efêmero ainda que JSON em disco |

---
## Colisões estruturais entre tenants (constraints que quebrariam em multi-tenant)

1. **`meta_connections`**: `PRIMARY KEY id SMALLINT DEFAULT 1 CHECK (id = 1)` (server.js:765) —
   literalmente só pode existir 1 linha no banco inteiro. Bloqueador explícito e documentado no
   próprio comentário (server.js:758-761).
2. **`google_ads_connections`**: mesmo padrão, `PRIMARY KEY id SMALLINT DEFAULT 1 CHECK (id = 1)`
   (server.js:1006).
3. **`meta_ad_accounts.meta_account_id`** UNIQUE (server.js:786), **`meta_campaigns.meta_campaign_id`**
   UNIQUE (server.js:813), **`meta_adsets.meta_adset_id`** UNIQUE (server.js:834),
   **`meta_ads.meta_ad_id`** UNIQUE (server.js:859), **`meta_creatives.meta_creative_id`** UNIQUE
   (server.js:879), **`google_ads_customers.customer_id`** UNIQUE (server.js:1028): nenhuma tem
   `tenant_id`/`loja` na constraint. Não colidem por valor entre tenants DIFERENTES (IDs da Meta/
   Google são globalmente únicos na origem), mas não há NENHUMA coluna de isolamento nessas
   tabelas — dois tenants que apontassem a mesma conta de anúncio (ex. agência gerindo múltiplos
   clientes na mesma Business Manager) colidiriam silenciosamente via upsert, e mesmo sem essa
   coincidência, uma query maliciosa/com bug não tem NENHUMA coluna para filtrar por tenant.
4. **`whatsapp_web_mensagens`**: `UNIQUE INDEX uq_wa_web_mensagens_nome ON (lower(nome))`
   (server.js:665) — nome de mensagem é global; duas lojas/tenants não podem ter mensagem
   homônima ("Boas-vindas", "Lembrete carrinho" etc. colidiriam).
5. **`whatsapp_web_outbox`**: `UNIQUE INDEX uq_wa_web_outbox_dedupe ON (dedupe_key) WHERE status
   IN (...)` (server.js:689-690) onde `dedupe_key = origem:referencia` (server.js:12762) — a
   constraint em si não inclui `loja`; a ausência de colisão hoje depende inteiramente de os
   chamadores embutirem `loja` dentro de `referencia` (confirmado em server.js:13787 para
   `origem='pedido'`; não confirmado com a mesma certeza para `origem='carrinho'`/`'pix'`, cuja
   `referencia` é `${chave}:${contador}` — **NÃO VERIFICADO** se `chave` inclui `loja` em todos os
   casos).
6. **`app_config.chave`** PRIMARY KEY (server.js:221): por desenho, uma linha por chave para o
   sistema INTEIRO — `entitlements`, `settings-product` (com o próprio campo `multiStoreMode`
   dentro do JSON, ver `db/product-settings.json`), `meta-metas`, `automacao-settings` etc. não
   têm nenhuma forma de existir "por loja" sem migrar a chave.
7. **`segments`** e **`utm_presets`**: sem coluna `loja`, nomes/definições compartilhados
   globalmente entre lojas.

## IDs sequenciais/previsíveis expostos em URL (task 5)

`BIGSERIAL`/`SMALLINT` auto-incremento usados como `:id` de rota, sem token opaco:
- `media_assets.id` → `GET/DELETE /api/admin/media/:id...` (server.js:15358,15391) — sem checagem
  de `loja`, portanto IDOR relevante (mitigado parcialmente para a rota PÚBLICA `/midia/:token/
  arquivo` que usa `public_token` opaco, server.js:15380-15388, mas as rotas ADMIN por `id` não
  têm essa proteção).
- `campaigns.id` → múltiplas rotas `/api/admin/campaigns/:id*` (server.js:9052+).
- `despesas_operacionais.id` → `/api/admin/financeiro/despesas/:id` (server.js:12042,12061).
- `utm_campaigns.id` → `/api/admin/utm/campaigns/:id*` (server.js:8849+).
- `segments.id` → `/api/admin/segments/:id` (server.js:8738,8756).
- `bulk_category_jobs.id` → `/api/admin/category-jobs/:id*` (server.js:4656+).
- `origens_migration_rules.id`, `origens_migration_simulations.id`,
  `origens_migration_city_uf_map.id` → várias rotas internas (server.js:6298+).
- `utm_presets.id` → `DELETE /api/admin/utm/presets/:id` (server.js:8994).

Todos protegidos hoje só por `requireAdmin` (sessão única, sem escopo de loja) — não há checagem
de posse (`loja`/tenant) em nenhuma dessas rotas por id, então o vetor de IDOR só não é
explorável HOJE porque o único admin já enxerga todas as lojas por desenho.

## `app_config` (task 8)

Schema: `chave TEXT PRIMARY KEY, valor JSONB NOT NULL, atualizado_em TIMESTAMPTZ` (server.js:220-224).
Chaves confirmadas em uso (grep de `lerConfigPostgres`/`salvarConfigPostgres`): `pedidos`,
`meta-metas`, `automacao-settings`, `whatsapp-provider`, `whatsapp-web-agente`, `whatsapp-meta-app`,
`settings-product`, `entitlements`, `campos-customizados`, `whatsapp-template-config`,
`automacao-eventos`, `carrinho-envios`, `pix-lembretes`, `envios-pendentes-janela`.

Confirmado global-only: `db/entitlements.json` é um objeto plano de feature flags
(`whatsapp, instagram, advancedAutomations, catalog, exchanges, refunds, financial`) sem NENHUMA
chave por loja — são flags de PLATAFORMA (o quê o produto pode fazer), não de loja. `db/
product-settings.json` = `{ multiStoreMode: false, productName: "Orgulho Regional" }` — literalmente
um único nome de produto e um único booleano "multi-loja" para o sistema inteiro, confirmando que
mesmo o conceito de "multi-loja" hoje é uma flag global, não uma dimensão de dado. Mistura,
portanto, config de plataforma (`entitlements`) e o que deveria ser config por loja
(`meta-metas`, `automacao-settings`, `whatsapp-provider` — nenhuma tem campo `loja` dentro do JSON)
na mesma tabela/mesmo mecanismo, sem nenhuma distinção estrutural entre as duas.

---
## NÃO VERIFICADO / fora do escopo desta passada

- `routes/**` além de `routes/criativos.js` não foram lidos linha a linha (só localizados via
  grep); podem conter tabelas ou queries adicionais não listadas aqui.
- `scripts/**` não foi auditado por completo — pode haver `CREATE TABLE`/queries adicionais em
  scripts de migração/manutenção fora do fluxo normal do server.
- Conteúdo completo de `chave` dentro de `referencia` para `whatsapp_web_outbox` nos casos
  `origem='carrinho'`/`'pix'` (se `chave` sempre embute `loja`) não foi rastreado até a origem de
  `chave` (fora do arquivo lido).
- `bulk_category_jobs`/`origens_migration_*` rotas por `:id` foram inspecionadas apenas pela lista
  de rotas (grep), não confirmei linha a linha se TODAS fazem `WHERE id=$1` sem `loja` — o padrão
  é consistente com `campaigns`/`utm_campaigns`/`despesas_operacionais` mas não foi lido 100% do
  código de cada handler.
- `data/*.json` (cities/collections/config/produtos) — não confirmei se há qualquer rota de
  escrita em runtime; pela busca, parecem ser dado estático de build/seed, não estado mutável.
