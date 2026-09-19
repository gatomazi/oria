# Dogfooding Audit — Tenant Panel (2026-09-19)

Escopo: produção atual (`oria-panel-production.up.railway.app`), Organization Use Origens, sessão já autenticada.
Somente leitura: nenhuma mutação, nenhuma credencial alterada, nenhum dado criado.
Control Plane (`oria-admin-production.up.railway.app`): **não auditado** — abriu tela de login; parado conforme o doc.

## Causa-raiz dominante

`lojaLegadaDoContexto()` (`apps/panel/server.js:356`) lança `TenantRuntimeError` (`STORE_WITHOUT_LEGACY_KEY`)
para Store nativa (`loja_legada = NULL`). Ela tem 104 call sites. Nos handlers `async` do Express 4 o throw vira
`[UNHANDLED_REJECTION]` e **a requisição nunca recebe resposta** (fica pendente > 25 s) — a UI fica em "Carregando".

Endpoints confirmados pendentes (read-only GET, timeout 25 s no cliente):

| Endpoint | Handler | Página afetada |
|---|---|---|
| `/api/admin/dashboard/recuperacao-resumo` | server.js:1111 | Dashboard (card Recuperação) |
| `/api/admin/dashboard/lucro-produtos` | server.js:1619 | Dashboard (Lucro por produto) |
| `/api/admin/clientes` | server.js:7363 | Clientes |
| `/api/admin/trocas` | server.js:1989 | Trocas e devoluções |
| `/api/admin/financeiro/resumo` | server.js:7150 | Financeiro (saldos) |
| `/api/admin/financeiro/movimentacoes` | server.js:7161 | Financeiro (extrato) |

Endpoints que respondem 500 (mesma causa nos logs): `/api/admin/produtos/feed/status`,
`/api/admin/produtos/catalogo/status`, `/api/admin/integrations/google-analytics/status`.

Jobs de fundo falhando repetidamente: `[CONTROLE_ESTOQUE] falha ao sincronizar loja null` (9x),
`[SYNC_PEDIDOS] falha no sync inicial: operação de store fora de um contexto de Organization`.

## Dashboard mostra zeros falsos (P1)

`/api/admin/dashboard/orders` e `/dashboard/financeiro` retornam dados reais (431 pedidos; ~15–17 pedidos/dia),
mas o Dashboard exibe 0. `porEscopo()` (`pages/dashboard/DashboardPage.tsx:60`) compara `item.loja === escopo`,
com `escopo = useLojaAtiva() ?? ''` (`''`), e a API devolve `loja: null` → todo item é filtrado.
`erros.filter((e) => e.loja === escopo)` (linha 550) tem o mesmo padrão.

## Matriz

| Área | Estado | Prioridade |
|---|---|---|
| Pedidos (lista, filtros, drawer) | READY WITH POLISH | P3 (coluna Loja "—") |
| Dashboard | BLOCKED | P1 |
| Clientes | BLOCKED | P1 |
| Trocas e devoluções | BLOCKED | P1 |
| Reembolsos | READY | — |
| Financeiro (resumo/extrato) | BLOCKED | P1 |
| Despesas / Custos de API | READY | — |
| Produtos | BLOCKED — Catálogo Ink | P1 |
| Categorias | BLOCKED (Carregando) | P1 |
| Agrupamentos | BLOCKED (Carregando) | P1 |
| Estoque | HIDDEN/DEFERRED (Carregando + job falhando) | — |
| Promoções | BLOCKED (Carregando) | P1 |
| Campanhas | BLOCKED (Carregando) | P1 |
| Segmentos | READY | — |
| WhatsApp visão geral | READY WITH POLISH | P2 |
| WhatsApp fila / Mensagens | READY | — |
| Automações / Templates | READY WITH POLISH (409 tratado como erro) | P2 |
| Recuperação | BLOCKED (Carregando) | P1 |
| PIX (hub) | READY | — |
| Analytics GA4 | READY WITH POLISH (500 no bastidor) | P2 |
| Meta Ads / Google Ads | READY (estado não conectado ok) | — |
| Gerador de Criativos | READY | — |
| UTM Tracker | BLOCKED (Carregando + 500 GA4) | P1 |
| Simular frete / Campos / Webhooks | READY | — |
| Integrações | READY WITH POLISH | P2 |
| Configurações | READY | — |

## Outros achados

- P2 Integrações: card GA4 mostra "Não foi possível carregar" (500) enquanto a página Analytics mostra estado
  amigável — inconsistente. Cache do catálogo e sync histórico mostram "Nenhuma loja conectada" mesmo com token Ink cadastrado.
- P2 Automações e Templates: WhatsApp sem número (409 `número do WhatsApp não cadastrado`) aparece como erro
  "Não foi possível carregar"; deveria ser estado vazio com CTA.
- P2 WhatsApp: Dashboard diz "Conectado", Integrações diz "API conectada", mas a visão geral diz "Número: Não cadastrado"
  e "Templates aprovados: Indisponível" — estados contraditórios.
- P2 Integrações: Reserva Ink "Use Sul" em "Pendente", webhook "Não configurado"; Webhooks e logs mostra "Últimas 0 entregas".
- P3 Privacidade/copy: card Meta Ads exibe nomes de env (`META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI`)
  e "OAuth da Meta não configurado neste ambiente" para o tenant — texto de plataforma vazando.
- P3 Pedidos: coluna "Loja" sempre "—" (esperado com `loja_legada = NULL`, mas coluna inútil).
- Segredos: token Ink e chave OpenAI aparecem só mascarados (últimos 4 caracteres). Nenhum secret completo exposto.
- Entitlements (`/api/admin/entitlements`): 6 features comerciais true (`whatsapp`, `financial`, `creative_generator`,
  `meta_ads`, `google_ads`, `analytics_ga4`), `instagram` false (coerente com "Não incluído no plano");
  compat keys `catalog`, `exchanges`, `refunds` true.
- Nenhum 403 visível ao usuário.

## Não verificado

- Control Plane inteiro (login exigido).
- Detalhe de Campanha, Templates novo/detalhe, Pedido novo/vincular, Trocas nova, Associar produtos.
- Testes de "usar retry" e "testar conexão".

## Correções recomendadas (próxima rodada)

1. Handlers async sem resposta: envolver em wrapper que converte `TenantRuntimeError` em resposta HTTP
   (ex.: 409 `STORE_WITHOUT_LEGACY_KEY`) — resolve os 6 hangs e os 500 de uma vez, e elimina o `UNHANDLED_REJECTION`.
2. Dashboard: normalizar `loja` nulo em `porEscopo` / filtro de erros (`(item.loja ?? '') === escopo`).
3. Migrar os call sites de `lojaLegadaDoContexto` das páginas de Clientes, Trocas, Financeiro, Recuperação e Promoções/Campanhas
   para o caminho canônico por Store/Organization (uma por vez, começando por Financeiro e Clientes).
4. Tratar "WhatsApp sem número" (409) e "GA4/Meta/Google sem conexão" como estado vazio com CTA, e unificar o status de WhatsApp.
5. Remover nomes de env do card Meta Ads no tenant.

---

## Rodada de correção (Store nativa: Dashboard, Clientes, Financeiro)

Sem migration. A Store nativa continua com `loja_legada = NULL`; nada foi preenchido e nenhuma chave
`sul`/`centro`/`norte` foi introduzida.

### Rede async + erro central — `apps/panel/lib/platform/http-safety.js`

- `instalarSegurancaAsync()` (chamada logo após `const app = express()`) faz `Layer#handle_request` do Express 4
  encaminhar a promise rejeitada de qualquer handler/middleware para `next(err)`. Cobre as ~104 chamadas de
  `lojaLegadaDoContexto()` e as rotas futuras, sem tocar em cada rota.
- `mapearErro()` + `criarErroCentral()` (último `app.use`): `STORE_WITHOUT_LEGACY_KEY` → **409**,
  `STORE_NOT_RESOLVED` → 409, `TENANT_CONTEXT_REQUIRED` → 401, erro de cliente com `expose` (JSON malformado) → 4xx,
  qualquer outro → **500 genérico**. Corpo `{ error, codigo }`; stack só no log do servidor; o log não leva query string.
- `wrapAsync()` é a forma explícita da mesma regra. `process.on('unhandledRejection')` continua como última rede.

### Handlers migrados para `organization_id + store_id`

| Rota | Antes | Depois |
|---|---|---|
| `GET /api/admin/clientes` | `lojaLegadaDoContexto()` (variável morta) | escopo canônico já existente (`escopoDaStore`) |
| `GET /api/admin/financeiro/{resumo,movimentacoes,antecipacoes,saques}` | `inkApiRequest(loja, …)` | `inkApiRequestDaStore(…)`; resposta traz `storeId` e `loja` (nula na Store nativa) |
| `GET /api/admin/dashboard/lucro-produtos` | junção itens×pedidos por `loja` | CTE por `organization_id + escopoDaStore`, junção por `store_id` (com ramo `loja` só para linha histórica) |
| `GET /api/admin/dashboard/recuperacao-resumo` | `loja === lojaFiltro` estrito | `lojaLegadaDoContextoOuNula()`; registro sem `loja` é o da Store nativa |
| `GET /api/admin/integrations/google-analytics/status` | 500 | Store nativa = "desconectado" |
| `midiaDaOrganizacao()` (Dashboard) | lançava e logava a cada carga | Store nativa: nenhuma conta atribuível, resultado vazio. O contrato do resolver (loja obrigatória) não mudou |

### Dashboard (front)

`src/pages/dashboard/escopoLoja.ts`: `null`, `''` e ausente são a mesma coisa ("sem chave legada"). O filtro estrito
`item.loja === escopo` (`null === ''` → falso) fazia todo pedido/carrinho/linha financeira sumir. O card "Canais e
integrações" passou a mostrar a linha da Reserva Ink também para a Store nativa.

### Jobs

- `SYNC_PEDIDOS`: removida a chamada solta no boot (rodava sem contexto e falhava em todo boot desde a Fase 3); o ciclo
  horário por Organization (`JOBS.agendar`) e o webhook continuam.
- `CONTROLE_ESTOQUE`: só itera Stores com chave legada (`lojasLegadasInkDoContexto`). Estoque não foi productizado.

### Extras triviais

- Card Meta Ads no tenant não mostra mais `META_APP_ID`/`META_APP_SECRET`/`META_OAUTH_REDIRECT_URI`.
- WhatsApp sem número (`WHATSAPP_SENDER_NOT_CONFIGURED`, 409): Templates mostra estado vazio com CTA para Integrações;
  Automações abre com a lista de templates vazia.
- GA4 status (acima).

### Dívidas registradas (fora do escopo)

- Ainda dependem de chave legada e agora respondem 409 controlado (antes: pendurado): Trocas, Recuperação, Promoções,
  Campanhas, UTM, Categorias, Agrupamentos, Produtos/Catálogo/Feed, Estoque, Automações por loja, GA4 *connect*.
- Atribuição de conta de anúncio (Meta/Google Ads) ainda é por `loja_atribuida`: a Store nativa não recebe gasto de mídia.
- Os cards Google (GA4 e Ads) ainda citam `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_OAUTH_REDIRECT_URI` no texto.
- Cache do catálogo e sync histórico em Integrações ainda dizem "Nenhuma loja conectada" para a Store nativa.

### Testes

`test/invariants/http-safety.test.js` (14, rede real), `test/invariants/store-nativa-dogfooding.test.js` (17: processo
real, RLS, Stores A legada / C e D nativas), `test/invariants/dashboard-escopo-loja.test.js` (5). Seis negative controls
novos: `http/async-sem-rede`, `http/erro-vaza-stack`, `store-nativa/clientes-exige-loja-legada`,
`store-nativa/financeiro-exige-loja-legada`, `store-nativa/lucro-produtos-join-por-loja`, `dashboard/escopo-loja-nula`.
O controle `tenancy/loja-do-request` foi reancorado no handler de Clientes migrado (o trecho antigo deixou de existir).
