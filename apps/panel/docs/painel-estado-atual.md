# Painel Admin — estado atual

> Snapshot de **11/09/2026**, branch `migration/admin-react-ts`. Documenta o que **existe e está rodando** hoje no painel (`/admin/*`), não o que está planejado. O planejamento da migração vive em [`plan.md`](./plan.md); o rebuild vanilla anterior, já concluído e arquivado, em [`plan-admin-v2-vanilla.md`](./plan-admin-v2-vanilla.md).

---

## 1. Visão geral

O painel é a **central operacional** das três lojas Reserva Ink (Use Sul, Use Centro, Use Norte). Ele não é o site público — o site (`index.html`, `loja.html`, `pedido.html`) continua vanilla, sem build step, e está fora deste documento.

O painel cobre hoje seis frentes:

| Frente | O que faz |
|---|---|
| **Operação** | Pedidos, trocas/devoluções, recuperação de carrinho e PIX, estoque |
| **Catálogo** | Produtos, categorias, agrupamentos, promoções (sincronizado com a Ink) |
| **WhatsApp** | Templates Meta, automações por evento, visão geral do canal |
| **Campanhas** | Segmentos dinâmicos, campanhas em lote com fila de envio real |
| **Financeiro** | Saldo/movimentações/antecipações/saques da Ink, reembolsos |
| **Sistema** | Variáveis customizadas, webhooks e logs, integrações, configurações |

---

## 2. Stack e arquitetura

### Frontend — `admin/`

SPA React 18 + TypeScript + Vite, subprojeto isolado com `package.json` próprio (não polui a raiz nem o site público).

- **Roteamento**: `react-router-dom` v6 em `BrowserRouter`, todas as rotas sob `/admin/*` (`admin/src/App.tsx`).
- **UI**: Radix (`react-dialog`, `react-dropdown-menu`, `react-tooltip`) + `recharts` para os gráficos do dashboard.
- **Base do Vite**: `/admin/`; build sai em `admin/dist/`.
- **Dev**: `npm --prefix admin run dev` com proxy de `/api` → `http://localhost:8080`.

### Backend — `server.js`

Um único arquivo Express (~10.6k linhas) que serve o site público, o painel e toda a API.

O **cutover da migração já aconteceu**: os 29 `sendFile` de página-por-página foram substituídos por um catch-all SPA (`server.js:1103`):

```js
app.use('/admin/assets', express.static('admin/dist/assets', { maxAge: '1y', immutable: true }));
app.get(/^\/admin(\/.*)?$/, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile('admin/dist/index.html');
});
```

Os arquivos vanilla antigos ficaram em `admin-old/` (30 arquivos, sem rota, sem uso — só histórico/rollback). O **CSS** deles continua ativo: `admin/src/main.tsx` ainda importa `src/pedido-admin.css`, `src/admin/design-system/tokens.css`, `components.css` e `src/admin/admin-shell.css`, e várias páginas importam o `.css` legado correspondente.

### Build e deploy

`package.json` da raiz roda o build do admin no `postinstall` e no `build`:

```json
"build":       "npm --prefix admin install && npm --prefix admin run build",
"postinstall": "npm --prefix admin install && npm --prefix admin run build"
```

Ou seja: o `dist/` do admin é gerado no deploy antes de `node server.js` subir.

---

## 3. Autenticação e sessão

- Senha única (`ADMIN_PASSWORD`) + cookie de sessão HMAC-assinado (`ADMIN_SESSION_SECRET`). Sem sessão em banco/memória.
- Endpoints: `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/session`.
- Gate **server-side** existe apenas nas rotas `/api/admin/*` (middleware `requireAdmin`). A rota de página é pública e serve o `index.html` da SPA — quem barra o acesso à UI é o `AuthProvider`/`ProtectedRoute` client-side (`admin/src/auth/`), que renderiza `LoginPage` enquanto a sessão não é válida. Nenhum dado sensível chega ao browser sem sessão, porque toda a API está protegida.

---

## 4. Estado global do shell

| Módulo | Papel |
|---|---|
| `state/adminState.ts` | Loja selecionada (`all`/`sul`/`centro`/`norte`), persistida em `localStorage`, exposta como external store + hook `useAdminStore()` |
| `state/adminStores.ts` | Fonte única das 3 lojas (id, nome, cor) |
| `state/productSettings.ts` | `GET /api/admin/settings/product` — nome do produto e `multiStoreMode` (esconde o seletor de loja); cache por sessão de página |
| `state/entitlements.ts` | `GET /api/admin/entitlements` — flags de plano (`whatsapp`, `instagram`, `catalog`, `exchanges`, `refunds`, `financial`, `advancedAutomations`); default permissivo se o fetch falhar |

O `AppShell` (`admin/src/shell/AppShell.tsx`) monta sidebar + header, deriva o item ativo da rota, mostra o seletor de loja quando `multiStoreMode`, exibe o rótulo do plano no dropdown do usuário e injeta condicionalmente o grupo **Ferramentas internas** conforme `GET /api/admin/internal-tools/status`.

---

## 5. Design system

`admin/src/components/ds/` é o porte React 1:1 do antigo `window.DS` vanilla — **mesmas classes CSS, mesmo contrato visual** (a direção é dark premium: charcoal, verde operacional, cyan informativo, âmbar pendente, vermelho crítico).

Componentes disponíveis (`components/ds/index.ts`):

`Button` · `Field` · `Input` · `StatusBadge` · `PageHeader` · `Card` · `KpiCard` · `MiniSparkline` · `MediaDropzone` · `DataTable` (com sort por coluna) · `EmptyState`/`ErrorState` · `Skeleton` · `Drawer` · `Modal` · `ConfirmDialog` · `RowActionsMenu` · `Tooltip`/`InfoTooltip` · `Tabs` · `ICONS`

Extras:
- `components/template-editor/` — editor de template WhatsApp (corpo com variáveis, seletor de variável, editor de botões, preview no formato WhatsApp). É o componente de domínio mais complexo do painel.
- `lib/`: `format.ts`, `statusMap.ts` (status Ink → tom/label), `toast.ts`, `templateVariables.ts`.
- `/admin/playground` — página viva de comparação visual dos componentes.

---

## 6. Mapa de páginas

**37 rotas** registradas em `App.tsx`, agrupadas como na sidebar (`shell/nav.ts`).

### Visão geral
| Rota | O que entrega |
|---|---|
| `/admin/dashboard` | 5 KPIs (pedidos hoje, receita estimada, carrinhos recuperáveis, taxa de recuperação, pedidos com atenção) com delta vs. ontem e sparkline; "Fluxo de pedidos" (pipeline por estágio); gráficos Recharts: pedidos×receita, donut de status, recuperação, heatmap dia×hora; tabelas de pedidos recentes e carrinhos |

### Operação
| Rota | O que entrega |
|---|---|
| `/admin/pedidos-central` | Lista unificada de pedidos (pedido, loja, cliente, itens, valor, pagamento, status, data) + drawer de detalhe com itens, endereço e reembolsos |
| `/admin/trocas` · `/admin/trocas/nova` | Lista e criação de trocas/devoluções. A **aprovação é da Ink** — aqui só cria e acompanha |
| `/admin/recuperacao` | Carrinhos abandonados + PIX pendentes, com KPIs e disparo de mensagem de recuperação |
| `/admin/estoque` | Duas abas deliberadamente separadas: **Controle de estoque** (produto dedicado, sincronizável) e **Observado via pedidos** (inferência indireta) |
| `/admin/clientes` | Base de clientes derivada dos pedidos |
| `/admin/carrinhos` | Redirect → `/admin/recuperacao` (rota legada) |

### Catálogo
| Rota | O que entrega |
|---|---|
| `/admin/produtos` · `/admin/produtos/novo` | Catálogo sob demanda da Ink; drawer de detalhe, edição, duplicação, criação |
| `/admin/categorias` | CRUD de categorias, drawer com vitrine, criação em lote, ativação/exclusão em massa |
| `/admin/categorias/associar` | Associação em massa produto↔categoria, com preview e job assíncrono acompanhável na tela |
| `/admin/agrupamentos` | Mesma estampa em tipos de produto diferentes, exibida como 1 card na vitrine |
| `/admin/promocoes` | Descontos e ofertas por loja |

### WhatsApp
| Rota | O que entrega |
|---|---|
| `/admin/whatsapp` | KPIs do canal (enviadas, respostas, falhas, fila aguardando revisão) |
| `/admin/automacoes` | Mapeia qual template dispara cada evento da Ink, por loja |
| `/admin/templates` · `/novo` · `/detalhe` | Gestão de templates Meta: criação, amostra, teste de envio, exclusão |

### Campanhas
| Rota | O que entrega |
|---|---|
| `/admin/campanhas/segmentos` | Audiências **dinâmicas** (recalculadas a cada uso, não lista fixa). Campos suportados: dias sem comprar, nº de pedidos, total gasto, ticket médio, UF, opt-in, tem carrinho abandonado, recebeu/não recebeu campanha, recebeu nos últimos N dias. Exclusões: sem opt-in, número inválido, comprou recentemente, recebeu campanha recentemente |
| `/admin/campanhas/nova` | Builder de campanha: audiência com preview de alcance, template, mapeamento de variáveis `{{n}}` (corpo/header/botão), mídia e localização de amostra |
| `/admin/campanhas` · `/admin/campanhas/:id` | Lista e detalhe com resumo de envio e destinatários |

### Financeiro
| Rota | O que entrega |
|---|---|
| `/admin/financeiro/despesas` | Despesas operacionais — cadastro por categoria, com recorrência mensal expandida na leitura. Alimenta o Lucro Operacional do Resultado |
| `/admin/financeiro` | Saldo disponível/pendente + abas Movimentações, Antecipações, Saques (dados da Ink) |
| `/admin/reembolsos` | Reembolsos feitos por este painel (a Ink não expõe listagem global, só por pedido) |

### Ferramentas
| Rota | O que entrega |
|---|---|
| `/admin/simular-frete` | Simulação de frete por loja |
| `/admin/pix` | Hub enxuto de atalhos PIX (a lógica real vive em `/admin/pedidos*`, não foi duplicada) |
| `/admin/pedidos` | Pedidos PIX — hotpages de pagamento, QR e copia-e-cola |
| `/admin/pedidos/novo` | Cria hotpage PIX manual |
| `/admin/pedidos/vincular` | Vincula pedido real da Ink a uma hotpage |
| `/admin/utm` | UTM Tracker — construtor de links, campanhas salvas, presets e performance real por GA4 |
| `/admin/analytics` | Analytics GA4 — funil, tráfego, receita, canais, dispositivos e mapa de horários da loja |
| `/admin/meta-ads` | Meta Ads — visão geral com KPIs e funil, tabelas de campanhas/conjuntos/anúncios com drill-down, Criativos com metas configuráveis e retenção de vídeo, e **Resultado**: DRE consolidada (receita real → lucro do produto → lucro após mídia), MER, ROAS de margem, break-even, Blended CAC e comparação Loja × Meta × GA4. Lê do cache local, nunca da Meta ao vivo |

### Sistema
| Rota | O que entrega |
|---|---|
| `/admin/campos` | Variáveis/campos customizados para usar nos templates |
| `/admin/eventos` | Últimas entregas de webhook recebidas da Ink |
| `/admin/integracoes` | Saúde por loja da conexão Ink (token/webhook/último evento), status do WhatsApp, card de backfill histórico de pedidos, placeholder do Instagram |
| `/admin/configuracoes` | Nome do produto + toggle de modo multi-loja |

### Ferramentas internas (condicional)
| Rota | O que entrega |
|---|---|
| `/admin/internal/origens-migration` | **Migração Use Origens** — maior página do painel (1.495 linhas). Classifica produtos por regras de nome, simula antes de aplicar, executa em massa, audita conflitos, corrige gentílico/"fala daqui", mapeia cidade↔UF, exporta CSV. Visível só com `INTERNAL_TOOLS_ENABLED`; o backend bloqueia de verdade via `requireInternalTools` (404) |

---

## 7. Camada de API do frontend

`admin/src/api/client.ts` é um wrapper `fetch` fino (porte do `api()` vanilla): `credentials: same-origin`, parse tolerante de JSON, erro vira `Error` + toast.

Um arquivo tipado por recurso — 29 no total:

`agrupamentos` · `automacoes` · `campanhas` · `campos` · `carrinhos` · `categoryAssignments` · `categorias` · `clientes` · `configuracoes` · `dashboard` · `estoque` · `eventos` · `financeiro` · `integracoes` · `internalTools` · `media` · `origensMigration` · `pedidoAdmin` · `pedidosBackfill` · `pedidosCentral` · `produtos` · `promocoes` · `recuperacao` · `reembolsos` · `segments` · `simularFrete` · `templates` · `trocas` · `whatsapp`

No backend: **152 rotas `/api/admin/*`** registradas em `server.js`, além de `/api/webhooks/ink` e `/api/webhooks/whatsapp`.

---

## 8. Persistência

**Postgres é opcional por design**: sem `DATABASE_URL`, o servidor cai para os arquivos JSON em `db/` e nada quebra. Com Postgres, as tabelas são criadas por `CREATE TABLE IF NOT EXISTS` no boot:

| Domínio | Tabelas |
|---|---|
| Pedidos | `pedidos_ink`, `sync_estado`, `pedidos_backfill_jobs` |
| Webhooks/auditoria | `webhook_eventos`, `audit_log` |
| Config | `app_config` (inclui as metas de eficiência do Meta Ads, chave `meta-metas`) |
| Estoque | `estoque_observacoes`, `controle_estoque_observacoes` |
| Mídia | `media_assets` |
| Campanhas | `segments`, `campaigns`, `campaign_recipients` |
| Catálogo | `produtos_feed`, `produtos_feed_sync`, `bulk_category_jobs`, `bulk_category_job_items` |
| Migração Origens | `origens_migration_rules`, `origens_migration_simulations`, `origens_migration_simulation_items`, `origens_migration_city_uf_map` |
| UTM / GA4 | `utm_campaigns`, `utm_presets`, `google_analytics_connections`, `ga4_performance_cache` |
| Financeiro | `despesas_operacionais` |
| Meta Ads | `meta_connections`, `meta_ad_accounts` (com `loja_atribuida`, base do MER), `meta_campaigns`, `meta_adsets`, `meta_ads`, `meta_creatives`, `meta_insights_daily`, `meta_sync_logs` |

> ⚠️ Estado que precisa sobreviver a deploy/restart deve estar no Postgres. Os JSONs de `db/` só são seguros com volume persistente montado (`RAILWAY_VOLUME_MOUNT_PATH` / `STORAGE_DIR`).

---

## 9. Jobs em background

Todos rodam como `setInterval` no próprio processo do `server.js`, com guard em memória contra ticks concorrentes:

| Job | Intervalo |
|---|---|
| `processarFilaDeCampanhas` — envio em lote das campanhas | 30 s |
| `processarBulkCategoryJobs` — associação em massa de categorias | 15 s |
| `reconcilePendingInkPedidos` | 5 min |
| `processarFollowUpsCarrinho`, `processarFollowUpsPix`, `registrarPixPendentesFaltantes`, `processarFilaDeJanela`, `sincronizarControleEstoqueTodasLojas`, `persistirCarrinhosAbandonadosTodasLojas` | 15 min |
| `syncPedidosInkParaPostgres` | 1 h |
| `sincronizarProdutosFeedTodasLojas` (feed CSV da Ink) | 12 h (+ um passe de vencidos 60 s após o boot) |
| `jobIncrementalMeta` — Insights da Meta de hoje/ontem | 45 min (`META_SYNC_INTERVALO_MIN`) |
| `jobDiarioMeta` — hierarquia da Meta + backfill de atribuição | 6 h |
| `jobRenovarTokenMeta` — renova o token da Meta antes de vencer | 12 h |

**Fila de campanhas**: o snapshot completo de destinatários nasce no `POST /campaigns/:id/start`, mas só é enviado quem já foi liberado num lote (`POST /campaigns/:id/batches`). Quando o lote acaba e ainda há gente pendente, a campanha vai sozinha para `paused` — o operador avalia entregas e libera o próximo. Transação com `FOR UPDATE` garante que ninguém receba duas vezes (`pending → queued → sent` é de mão única).

---

## 10. Variáveis de ambiente

| Var | Uso |
|---|---|
| `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` | Auth do painel (sem elas: 503 no login) |
| `DATABASE_URL` | Postgres (opcional; sem ela, fallback JSON) |
| `INK_TOKEN_{SUL,CENTRO,NORTE}` | API da Reserva Ink por loja |
| `INK_WEBHOOK_SECRET_{SUL,CENTRO,NORTE}` | Validação dos webhooks da Ink |
| `INK_FEED_URL_{SUL,CENTRO,NORTE}` | Feed CSV do catálogo ativo |
| `WHATSAPP_SERVICE_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_WEBHOOK_SECRET` | Canal WhatsApp. O ID do app da Meta usado no upload de mídia de exemplo dos templates fica em Integrações › WhatsApp (`app_config` `whatsapp-meta-app`), com fallback no `META_APP_ID` do whatsapp-webhook-go |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | OAuth do Google Analytics 4 |
| `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI` | OAuth da Meta Ads (escopo `ads_read`) |
| `META_API_VERSION`, `META_BACKFILL_DIAS`, `META_SYNC_INTERVALO_MIN` | Ajustes da Meta (defaults `v23.0`, 28, 45) |
| `INTERNAL_TOOLS_ENABLED` | Libera a Migração Use Origens |
| `STORAGE_DIR`, `UPLOADS_DIR`, `IMG_CACHE_DIR`, `RAILWAY_VOLUME_MOUNT_PATH` | Persistência de arquivos |
| `SITE_BASE_URL`, `PORT`, `NODE_ENV` | Infra |

---

## 11. O que ainda não existe

| Item | Situação |
|---|---|
| Busca global no header | Input presente, **desabilitado** com tooltip |
| Histórico de WhatsApp | Item de menu marcado "em breve", sem página |
| Relatórios de campanha | Item de menu "em breve" — depende de webhooks de entrega/leitura e tracking de clique |
| Atribuição de receita a campanha | KPIs "Pedidos"/"Receita" no detalhe da campanha mostram *Indisponível* |
| Instagram | Card e menu presentes, integração não implementada |
| Notificações / Ajuda (header) | Botões decorativos, sem comportamento |
| ESLint/Prettier no `admin/` | Adiado desde a Fase 0 |
| `tokens-base.css` | TODO aberto em `main.tsx`: o admin ainda importa `src/pedido-admin.css` inteiro só pelas cores base do `:root` |
| Testes automatizados | Não há suíte no `admin/` — validação é `tsc -b` + verificação manual/visual. **O backend agora tem**: `npm test` (`test/meta*.test.js`, 46 casos) |
| Taxas automáticas do gateway | As despesas operacionais existem (Financeiro → Despesas) e fecham o Lucro Operacional, mas tudo é cadastro manual. Ler a taxa por pedido do gateway é o passo seguinte — spec §53Y |
| Atribuição por pedido | A comparação Loja × Meta × GA4 é agregada. Saber qual campanha trouxe qual pedido (Fase 6) depende de UTM e click IDs persistidos no pedido |
| Versão da Graph API | `META_API_VERSION` não está setada, então vale o default `v23.0`. A vigente é v26.0; recomendado setar `v25.0` |
| Histórico financeiro dos pedidos | As colunas de custo/lucro existem e são preenchidas por webhook, sync e backfill, mas ficam **nulas em pedidos antigos** até o backfill por loja rodar (Integrações). Os endpoints devolvem `semFinanceiro`/`pedidosSemItens` pra tela avisar em vez de sub-reportar lucro |
| Lucro por produto (nota, não pendência) | `/dashboard/lucro-produtos` agrupa por `produto_id`, **decidido em 14/09/2026**. Em 191 pedidos reais, 8 nomes de produto têm mais de um `produto_id`, então a mesma estampa aparece em duas linhas do ranking — é o preço da precisão, e foi escolhido conscientemente |

> Nota de manutenção: comentários em `api/campanhas.ts` e `lib/statusMap.ts` dizem que a fila de envio "ainda não foi implementada" (Fase 5). Isso **está desatualizado** — a fila existe e roda (`processarFilaDeCampanhas`, `campaign_recipients`, endpoints de `start`/`batches`/`pause`/`resume`).

---

## 12. Como rodar

```bash
# backend (porta 8080 por padrão)
node server.js

# frontend do admin em dev, com proxy de /api pro backend
npm --prefix admin run dev

# build de produção (é o que o deploy roda)
npm run build           # = npm --prefix admin install && npm --prefix admin run build

# checagem de tipos
npm --prefix admin run typecheck
```
