# Varredura mecânica de SCOPE-DISCOVERY — server.js / lib / routes / scripts

Escopo: sweep cross-cutting em `server.js` (16.349 linhas), `lib/**`, `routes/**`, `scripts/**`.
Excluído de propósito (cobertos por outros workstreams): lógica específica de Meta Ads, Google Ads,
GA4/UTM, WhatsApp e Creative Core. Ocorrências desses domínios que apareceram nos greps mecânicos
são citadas por completude, sem análise aprofundada.

Fato estrutural que contextualiza quase todos os achados: `LOJAS` (server.js:58) e `INK_STORES`
(server.js:69-73) são **constantes de módulo hardcoded** (`{ sul, centro, norte }`), não linhas de
banco. `requireAdmin` (server.js:1574-1580) é uma sessão única, sem papel/escopo por loja — "só
existe 1 nível de admin neste projeto (sem role)" (comentário do próprio código, linha 1582).
Ou seja: hoje não existe fronteira de tenant real — as 3 "lojas" são regiões de UM único dono. Isso
não anula os achados abaixo (o objetivo da auditoria é a productização SaaS), mas explica por que
nada disso quebrou nada até hoje.

---

## A. `LIMIT 1` sem `ORDER BY` determinístico

| Achado | Local | Mecanismo | Categoria | Evidência |
|---|---|---|---|---|
| Resolver simulação de migração mais recente | server.js:7768 (`resolverSimulacaoParaLimpeza`) | `WHERE loja = $1 AND status IN (...) ORDER BY criado_em DESC LIMIT 1` | 2 | Escopo por `loja=$1` + determinismo por `ORDER BY criado_em DESC` (não por índice único — duas simulações com o mesmo `criado_em` empatariam, mas o parâmetro de escopo está correto) |
| `google_ads_customers WHERE selecionada LIMIT 1` | server.js:10456 | Sem `WHERE loja`; "selecionada" é uma flag única *instalação-wide* | 5 (domínio Google Ads — citado por completude, aprofundado pelo outro workstream) | `SELECT * FROM google_ads_customers WHERE selecionada LIMIT 1` |
| `meta_ad_accounts WHERE selecionada LIMIT 1` | server.js:10942 | Idem, sem `WHERE loja` | 5 (domínio Meta — citado por completude) | `SELECT * FROM meta_ad_accounts WHERE selecionada LIMIT 1` |
| Próximo item da fila de WhatsApp Web | server.js:12904 | `ORDER BY ... LIMIT 1 FOR UPDATE SKIP LOCKED`, sem filtro de loja — mas o registro escolhido carrega seu próprio `loja` e é usado corretamente depois | 2 (domínio WhatsApp — citado por completude) | `WHERE id = (SELECT id FROM whatsapp_web_outbox ... LIMIT 1 FOR UPDATE SKIP LOCKED)` |
| Checagem de bloqueio de campanha | server.js:12931 | `SELECT 1 ... LIMIT 1` — existencial, não seleciona linha de escopo | 3 (não é seleção de escopo) | — |
| `clienteJaComprou` | server.js:14169 | `WHERE loja = $1 AND ... LIMIT 1` | 1 | Escopado corretamente por parâmetro |
| Falso positivo de grep (`LIMIT 10`) | server.js:14508 | Não é `LIMIT 1`; `WHERE loja = $1 ORDER BY criado_em DESC LIMIT 10` | 1 | — |
| Próxima campanha a processar | server.js:14967 | `ORDER BY iniciada_em ASC NULLS LAST LIMIT 1`, sem filtro de loja — id da campanha resolvido depois carrega loja | 2 (domínio WhatsApp/Campanhas — citado por completude) | `SELECT id FROM campaigns WHERE status IN ('preparing','sending') ...` |
| Próximo job de categorização em massa | server.js:15161 | `WHERE status IN ('queued','running') ORDER BY criado_em ASC LIMIT 1`, sem filtro de loja — job carrega `loja` no próprio row e é usado no processamento subsequente | 2 | `SELECT id, loja, mode, ... FROM bulk_category_jobs WHERE status IN (...) ORDER BY criado_em ASC LIMIT 1` |
| Claim de asset de creative | lib/creative-core/pgStore.js:218 | `ORDER BY c.created_at, c.item_index LIMIT 1 FOR UPDATE OF c SKIP LOCKED` | não avaliado (Creative Core — outro workstream) | — |
| Asset mais recente de um creative | lib/creative-core/pgStore.js:273 | `WHERE tenant_id = $1 AND creative_id = $2 ORDER BY created_at DESC LIMIT 1` | 1 (Creative Core — citado por completude; já escopado por `tenant_id`) | — |
| Detalhes de customer Google Ads | lib/google-ads/queries.js:63 | `FROM customer LIMIT 1` (query GAQL de metadata do customer autenticado, não seleção de linha ambígua) | 1 (Google Ads — citado por completude) | — |

**NÃO VERIFICADO**: se existe constraint `UNIQUE (status) WHERE status IN ('queued','running')` ou
índice parcial equivalente para `bulk_category_jobs`/`campaigns`/`whatsapp_web_outbox` que impeça
duas execuções concorrentes de pegarem jobs diferentes ao mesmo tempo — não inspecionei as
migrações (`/migrations`) nesta varredura.

---

## B. `rows[0]` / `[0]` / `.find(` usados para escolher escopo/credencial/conta

Foram inventariadas 99 ocorrências de `rows[0]` e 27 de `.find(` em `server.js`. A esmagadora
maioria resolve uma linha já filtrada por `id`/`loja`/`chave` (categoria 1). Os que envolvem
credencial/conta/token foram isolados:

| Achado | Local | Mecanismo | Categoria | Evidência |
|---|---|---|---|---|
| Token público de mídia de campanha | server.js:14724 (`linkPublicoMedia`) | `SELECT public_token FROM media_assets WHERE id = $1` → `rows[0]` | 1 | Escopado por `id` do parâmetro (`mediaAssetId`) |
| Resolução de categoria-alvo (nome→id) | server.js:6157 (`resolverCategoriasAlvo`) | `candidatos.length === 1 ? candidatos[0].id : null` | 1 (não é escopo de loja/tenant — é resolução de nome de categoria ambíguo, já isolado por loja a montante) | — |
| Resolução de categoria de destino do preset | server.js:7539 | Mesmo padrão de `.length === 1 ? [0] : null` | 1 (idem — ambiguidade de categoria, não de tenant) | — |
| Contas Google Ads/Meta selecionadas | server.js:10456, 10942 | Ver seção A | 5 | (domínio Ads — citado por completude) |

Nenhum outro `.find()`/`rows[0]` em `server.js` seleciona conta, credencial, conexão ou loja fora
dos já cobertos nas seções A/C/D.

---

## C. Fallbacks "se só existir um, usa esse"

| Achado | Local | Mecanismo | Categoria | Evidência |
|---|---|---|---|---|
| `lojaAtribuidaPadrao()` — instância conhecida | server.js:11873-11876 | `Object.keys(LOJAS).length === 1 ? ids[0] : null` | 4 (default implícito — funciona só porque hoje há 1 candidato positivo em instalações de 1 loja; comentário do próprio código admite isso: "Instalação com uma loja só ... não deve perguntar nada") | `function lojaAtribuidaPadrao() { const ids = Object.keys(LOJAS); return ids.length === 1 ? ids[0] : null; }` |
| Chamada nº2 de `lojaAtribuidaPadrao()` (além da já conhecida em 12256) | server.js:11419 (`POST /api/admin/integrations/meta/select-account`) | `loja_atribuida = COALESCE($2, loja_atribuida, $3)` com `$3 = lojaAtribuidaPadrao()` | 4 | `[String(metaAccountId), loja || null, lojaAtribuidaPadrao()]` — se o body não mandar `loja` e a conta Meta nunca teve `loja_atribuida`, cai no default de 1-loja-só |
| `acharCompraDoCarrinho` — filtro de loja pulável | lib/recuperacao/compra.js:53 | `if (alvo.loja && p.loja !== alvo.loja) continue;` — se `alvo.loja` for falsy, o filtro de loja é **inteiramente ignorado** e a busca casa comprador contra pedidos de QUALQUER loja | 6 (potencial, latente) | Único call site hoje é server.js:2278, que sempre passa `loja: c.loja` (não-vazio) — não está sendo explorado na prática, mas a função em si tem um caminho fail-open, não fail-closed, quando chamada sem loja |
| Resolução de categoria por nome único (não é escopo de tenant) | server.js:6157, 7539 | Ver seção B | 1 | Fora do escopo desta categoria (ambiguidade de nome de categoria, não de loja) |

Não encontrei outras ocorrências do padrão `Object.keys(X).length === 1` ou `arr.length === 1 ? arr[0] : ...`
usadas para inferir loja/conta/credencial fora das listadas acima.

---

## D. Escopo sobrescrito por input não confiável

Toda a superfície de "loja vinda da request" no repositório passa por `req.query.loja`,
`req.body.loja` ou `req.params.loja` — não há `store_id`, `tenant_id`, `account_id`, `customer_id`
ou `connection_id` lidos diretamente de `req.*` em `server.js`, `lib/**` ou `routes/**` fora do
domínio Google Ads (`:customerId` em `req.params`, tratado pelo outro workstream). A quase
totalidade valida contra o whitelist `LOJAS`/`INK_STORES` (fail-closed, categoria 1/2).

| Achado | Local | Mecanismo | Categoria | Evidência |
|---|---|---|---|---|
| Override conhecido (consolidado de Analytics) | server.js:12256 | `req.query.loja || conta.loja_atribuida || lojaAtribuidaPadrao() || ''` | 6 | Comentário do próprio código: "A loja vem da conta de anúncios ..., com override por query pra a tela poder comparar cenários" — a query string do CLIENTE tem precedência sobre o valor armazenado (`conta.loja_atribuida`) |
| `POST /produtos/catalogo/sync` | server.js:3907-3910 | `pedida = req.body.loja`; se ausente, roda para `Object.keys(INK_STORES)` (todas as lojas) — não é override de uma loja JÁ atribuída, é fan-out | 1 | Validado contra `INK_STORES` antes de usar |
| `POST /produtos/feed/sync` | server.js:3982-3986 | Idem (fan-out quando ausente) | 1 | Validado contra `INK_STORES` |
| `PUT /produtos/catalogo/config` | server.js:3919-3921 | `body.loja` validado contra `INK_STORES` | 1 | — |
| `GET /clientes` | server.js:8403-8406 | `req.query.loja` validado contra `LOJAS`; ausência = agregado de todas | 1 | — |
| `POST /google-ads/contas/:customerId/selecionar` | server.js:10593 | `req.body.loja` validado contra `LOJAS`, usado com `COALESCE($2, loja_atribuida)` — o valor da REQUEST tem precedência sobre o armazenado quando presente | 6 (domínio Google Ads — citado por completude) | — |
| `POST /google-ads/contas/:customerId/loja` | server.js:10629 | Idem, mas aqui é atribuição explícita (endpoint dedicado "atribuir loja"), não side-channel | 2 (domínio Google Ads) | — |
| `POST /meta/select-account` | server.js:11402-11419 | `req.body.loja` com `COALESCE($2, loja_atribuida, $3=lojaAtribuidaPadrao())` — request tem precedência | 6 (domínio Meta — citado por completude) | Ver também seção C |
| `GET/POST /financeiro/despesas` | server.js:12002, 12024 | `req.query.loja`/`req.body.loja` validados contra `LOJAS`, obrigatórios (400 se ausente/inválido) | 1 | Fail-closed, sem fallback |

**Nota de classificação**: como não existe hoje fronteira de autorização por loja em `requireAdmin`
(qualquer sessão admin pode passar qualquer `loja` válida), a categoria 6 aqui reflete o risco
**estrutural/futuro** (quando "loja" virar "tenant" de verdade na productização SaaS), não uma
exploração possível hoje entre donos diferentes — hoje as 3 lojas pertencem ao mesmo operador.

---

## E. Env vars usadas como identidade de tenant

| Achado | Local | Mecanismo | Categoria | Evidência |
|---|---|---|---|---|
| `LOJAS` / `INK_STORES` — lista de lojas é constante de módulo | server.js:58, 69-73 | `const LOJAS = { sul: 'Use Sul', centro: 'Use Centro', norte: 'Use Norte' }`; tokens por loja vêm de env (`INK_TOKEN_SUL` etc.) mas o CONJUNTO de lojas é hardcoded no código-fonte, não configuração runtime/banco | 5 | Achado estrutural — nenhuma "loja"/tenant pode ser adicionada sem deploy de código |
| `GOOGLE_ADS_EM_USO` | server.js:10755, 10942 (uso em 11949) | `process.env.GOOGLE_ADS_EM_USO === 'true'` — flag global de instalação, não por loja | 5 (domínio Google Ads — citado por completude) | `fontes.push({ provider: 'google_ads', ..., relevante: GOOGLE_ADS_EM_USO })` |
| `CREATIVE_TENANT_ID` | lib/creative-core/storage.js:33 | Validado com regex, usado como tenant id | não avaliado (Creative Core — outro workstream) | `if (!TENANT_RE.test(tenantId)) throw new Error('CREATIVE_TENANT_ID inválido')` |
| `SITE_BASE_URL` | server.js:60 | Env global usada para montar links públicos — instalação inteira, não por loja | 5 (baixa relevância — é a URL do site final, hoje 1 site para as 3 lojas; não é "identidade" per se, mas é outro exemplo de configuração global que a productização SaaS terá que tornar per-tenant) | — |

Não encontrei outras `process.env.*` lidas durante o processamento de uma request e usadas para
decidir escopo/identidade em `server.js`, `lib/**`, `routes/**` fora das listadas.

---

## F. Caches/memoização/singletons de módulo mantendo escopo entre requests

Inventariei todos os `new Map()`/`new Set()` de escopo de módulo (top-level) em `server.js`:

| Achado | Local | Mecanismo | Categoria | Evidência |
|---|---|---|---|---|
| `loginAttempts` | server.js:1593 | `Map` chaveado por IP — não é dado de tenant, é rate-limit de login | 1 | — |
| `inFlight` (cache de imagem CDN) | server.js:1609 | `Map` chaveado por `filename` do asset — imagens de estampas/design, não dado de cliente por loja | 1 | `if (inFlight.has(filename)) return inFlight.get(filename);` |
| `feedEmSincronizacao`, `catalogoEmSincronizacao` | server.js:3306, 3509 | `Set` de guarda de job, chaveado por `loja` (`.has(loja)`/`.add(loja)`) | 1 | Escopado corretamente |
| `tiposPorLojaCache` | server.js:3657 | `Map<loja, {em, tipos}>` — cache de tipos de produto, chaveado por loja | 1 | Comentário explícito confirma: `// loja -> { em: timestamp, tipos: Map<id, nome> }` |
| `lojasSimulandoMigracao` | server.js:6520 | `Set` chaveado por `loja` | 1 | — |
| `GA_OAUTH_STATES` | server.js:9618 | `Map<nonce, {loja, criadoEm}>` — state OAuth carrega a loja explicitamente junto do nonce | 1 | Comentário: "state OAuth (CSRF do fluxo): nonce → { loja, criadoEm }" — padrão correto |
| `META_OAUTH_STATES` | server.js:10792 | `Map<nonce, ...>` (domínio Meta — não aprofundado; `meta_connections` é tabela singleton `WHERE id = 1`, então não há loja para carregar no state) | 5 (domínio Meta — citado por completude: conexão Meta é literalmente 1 linha global, `id = 1`, não por loja) | `SELECT * FROM meta_connections WHERE id = 1` (server.js:10799) |
| `lojasComBackfillPedidosRodando` | server.js:14426 | `Set` chaveado por `loja` | 1 | — |
| `campanhasEmProcessamento` | server.js:14787 | `Set` chaveado por `campanhaId` (não por loja — mas campanha é global entre lojas, ver seção A/G) | 2 (domínio Campanhas/WhatsApp — citado por completude) | — |
| `bulkCatJobsEmProcessamento` | server.js:14988 | `Set` chaveado por `job.id` | 1 | — |

Nenhum cache de módulo em `server.js` foi encontrado sem componente de escopo quando o dado
cacheado é sensível a loja (os que cacheiam algo global — imagens de design, rate-limit de IP —
são legitimamente globais).

---

## G. Jobs/webhooks que descobrem escopo em vez de recebê-lo

Toda iteração `Object.keys(INK_STORES)`/`Object.keys(LOJAS)` encontrada (server.js:1284, 1508,
1856, 2456, 2542, 2734, 3229, 3478, 3636, 3698, 3788, 3875, 3909, 3959, 3985, 8406, 9758, 9762,
14366, 14404) é um fan-out explícito — "rode isto para cada loja conhecida" em jobs de
background (renovação de cache, backfill, listagem agregada) — não um "adivinhe qual é a loja
conectada". Dado que `LOJAS`/`INK_STORES` são constantes estáticas (seção E), isso é esperado e
correto NO MODELO ATUAL (1 instalação, N regiões do mesmo dono). Categoria 1 para todas.

Os dois casos de job-queue que escolhem 1 item para processar sem filtro de loja na query
(`campaigns` em 14967, `bulk_category_jobs` em 15161) já estão cobertos na seção A/F — o item
escolhido carrega sua própria `loja` e o processamento subsequente usa esse valor corretamente
(categoria 2, não um bug de descoberta).

Não encontrei função que, na ausência de parâmetro de loja, tente "adivinhar a loja conectada"
olhando qual store tem token configurado, qual tem dados recentes, etc. — os únicos "defaults" são
os já cobertos em C (`lojaAtribuidaPadrao`).

---

## H. Config lida como blob único global (`lerConfigPostgres`/`salvarConfigPostgres`)

Schema real (server.js:220-224): `CREATE TABLE app_config (chave TEXT PRIMARY KEY, valor JSONB ...)`
— **não existe coluna de loja/tenant na tabela**. Qualquer isolamento por loja depende inteiramente
de o código aplicativo namespacear a própria chave `chave` (não faz) ou o conteúdo do `valor` JSONB
internamente por loja (alguns fazem, listados abaixo).

Lista completa de chaves gravadas via `lerConfigPostgres`/`salvarConfigPostgres`:

| Chave | Local (1ª definição) | Conteúdo internamente namespaced por loja? | Categoria | Observação |
|---|---|---|---|---|
| `pedidos` | server.js:1521-1524 | Sim — objeto `{ [pedidoId]: pedido }`, cada `pedido` carrega seu próprio `loja` | 1 | Registro individual escopado |
| `meta-metas` | server.js:11671 | Não verificado a fundo (domínio Meta) | 5 (Meta — citado por completude) | — |
| `automacao-settings` | server.js:12344-12352 | **Não** — `{ modoEnvio, janelaEnvio }` flat, aplicado a TODAS as lojas igualmente | 5 | Conceitualmente por loja (uma loja pode querer modo automático, outra manual) mas armazenado global |
| `whatsapp-provider` | server.js:12623, 12643 | **Não** — `{ provider, limiteRecomendado, tetoDiario }` flat, global | 5 | Cada loja pode ter provedor/número de WhatsApp diferente no futuro; hoje é 1 config para todas |
| `whatsapp-web-agente` | server.js:12649-12652 | **Não** — objeto flat de 1 agente/dispositivo para toda a instalação | 5 | Citado explicitamente no prompt da tarefa — só 1 loja pode operar o agente desktop por vez |
| `whatsapp-meta-app` | server.js:13070, 13094 | **Não** — `{ appId }` flat | 5 (ambíguo — pode ser intencionalmente global, ver nota) | Se a instalação tiver 1 único Business App Meta compartilhado entre lojas, isso é correto por design; **NÃO VERIFICADO** se a intenção de produto é 1 App por tenant |
| `settings-product` | server.js:13330-13362 | **Não** — `{ multiStoreMode, productName: 'Orgulho Regional' }` flat | 5 | `productName` singular é o sintoma mais claro: hoje só existe 1 "produto"/marca para as 3 lojas — bloqueador direto para multi-tenant real |
| `entitlements` | server.js:13376-13402 | **Não** — `{ catalog, exchanges, refunds, financial, ... }` flat, 1 conjunto de feature flags para TODA a instalação, inclusive consumido por `routes/criativos.js` via `lerEntitlements` | 5 | Acesso a feature (billing/gating) não distingue tenant — acoplamento relevante para produtização SaaS |
| `campos-customizados` | server.js:13457-13461 | **Não** — objeto flat de definições de campo, usado igualmente para todas as lojas (`custom.${c}`) | 5 | Cada loja pode querer campos de produto diferentes; hoje compartilhado |
| `whatsapp-template-config` | server.js:13529-13532 | Não verificado a fundo (domínio WhatsApp — citado por completude) | 5 (WhatsApp) | — |
| `automacao-eventos` | server.js:13540-13544 | **Sim** — acessado como `eventos[loja]` em todos os call sites (server.js:2346, 2408, 13768) | 1 | Bom padrão: blob global, mas namespaced internamente por loja |
| `carrinho-envios` | server.js:13554-13557 | Provável — usado junto de registros que carregam loja (não confirmei a chave interna a fundo) | NÃO VERIFICADO | — |
| `pix-lembretes` | server.js:13568-13571 | **Sim** — cada entrada é `lembretes[chave] = { loja: p.loja, ... }` (server.js:14705) | 1 | Registro individual escopado |
| `envios-pendentes-janela` | server.js:13817-13820 | **Sim** — array de `{ loja, eventName, order, criadoEm }` (server.js:13824) | 1 | Registro individual escopado |

**Resumo da seção H — chaves conceitualmente por loja mas armazenadas globalmente**:
`automacao-settings`, `whatsapp-provider`, `whatsapp-web-agente`, `settings-product`,
`entitlements`, `campos-customizados` (mais, sem confirmação profunda: `whatsapp-template-config`,
`meta-metas`, `whatsapp-meta-app`).

---

## Itens NÃO VERIFICADOS (fora do orçamento desta varredura)

- Existência de constraints/índices únicos parciais para `bulk_category_jobs`, `campaigns`,
  `whatsapp_web_outbox` (arquivos de `/migrations` não inspecionados).
- Estrutura interna completa de `carrinho-envios` e `whatsapp-template-config` (namespacing por
  loja não confirmado a fundo).
- Intenção de produto para `whatsapp-meta-app` (1 App Meta por instalação vs. por tenant).
- Qualquer padrão de escopo dentro de `desktop/`, `admin/src`, `src/admin` (não fazem parte do
  escopo desta varredura: server.js/lib/routes/scripts).
