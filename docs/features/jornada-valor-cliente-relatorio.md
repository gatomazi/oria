# Jornada de Valor — relatório da rodada

**Branch:** `feature/jornada-valor-cliente` · **Worktree:** `/Users/gtomazi/projects/oria-jornada-valor` (exclusivo desta rodada)
**Base:** `origin/main` @ `f8f784e` (Rodadas K/L/M já mescladas) — **nenhuma branch alheia tocada** (`oria`, `oria-capabilities`, `oria-creative-fase-a`, `oria-integracoes` seguem intocados).
**Commits locais** (nenhum push/merge/deploy):

```
28ca826 fix(panel): give the canonical commerce catalog sync a production trigger
b52c1e1 feat(panel): add Opportunity Diagnostics engine (Gate C)
5f488df feat(panel): surface Opportunity Diagnostics as "Prioridades de hoje" (Gate D)
bacb7de test(panel): add local multi-product smoke harness for Gate C
```

---

## O que o lojista ganha agora

Abrindo **Jornada de Compra → Visão geral**, o topo da página deixou de ser só números — agora mostra **"Prioridades de hoje"**: até 5 cartões dizendo *qual produto merece atenção, por quê (com o número real), e o que investigar primeiro* — com um botão que abre o produto certo direto no Desempenho de Produtos. Exemplo real (dado de demonstração, ver seção de evidência): *"Interesse não vira carrinho — Produto X: 5.000 visualizações, só 0,8% viraram carrinho (mediana da Store: 20%) → confiança alta → Inspecionar foto, preço, descrição..."*.

Isso só existe porque o catálogo canônico (`commerce_products`) — que antes desta rodada **nunca era sincronizado em produção** — agora tem um botão real em Desempenho de Produtos ("Sincronizar catálogo") que dispara a sincronização de verdade e mostra o progresso.

**O que NÃO mudou nesta rodada** (para não prometer mais do que foi entregue): as abas Aquisição / Meta Ads / Correlação transação↔pedido / Qualidade dos dados continuam exatamente como nas Rodadas K/L — nenhuma reestruturação de navegação em 5 áreas (§5.1 do comando) foi feita; "Prioridades de hoje" foi adicionado dentro da aba Visão geral existente. Ver "Escopo não coberto" no fim.

---

## 1. Gate Zero — integridade e integração do trabalho em andamento

- HEAD verificado antes de codar: `origin/main` estava em `f8f784e` (merge da PR #22, que já contém o fix do prefixo `INK<id>` da Rodada M). A branch local `feature/journey-analytics-ui` tinha 1 commit a mais (`69a1354`, a correção do catalog-sync que eu mesmo tinha deixado pronta mas não commitada quando esta rodada começou).
- **Integração do fix de catalog-sync** (exigida como prioridade máxima pelo usuário): commitado primeiro em `feature/journey-analytics-ui` (`69a1354`), depois **cherry-picked limpo** (sem conflito) para a nova branch `feature/jornada-valor-cliente`, criada a partir de `origin/main`. Nenhum código duplicado, nenhum segundo scheduler.
- Worktree novo e exclusivo (`oria-jornada-valor`) — nunca toquei a pasta compartilhada (`/Users/gtomazi/projects/oria`, rodando `feature/clientes-rfm` de outra sessão) nem as branches `feature/connector-capabilities`, `feature/creative-fase-c`, `feature/entitlement-canonico`.
- Auditei `catalog-sync.js`, `product-identity-resolver.js`, `product-performance-service.js`, `reconciliation.js`, `journey-analytics-service.js`, `http-routes.js`, `composition.js` e a UI existente antes de escrever qualquer linha nova.

---

## 2. Gate A — Catálogo canônico: quem dispara `runCatalogSync` agora

**Antes desta rodada:** `runCatalogSync` (Fase D, já existia) só era chamada por arquivos de teste. `commerce_products`/`commerce_product_variants` ficavam vazios pra sempre em produção, mesmo com GA4+Ink conectados e dado real fluindo dos dois — "Desempenho de Produtos" e a correlação de identidade nunca resolviam nada.

**Depois:**
- `composition.js` expõe `syncCommerceCatalog`/`getCommerceCatalogSyncStatus`, reaproveitando o lease já existente (`lib/platform/leases.js`, Postgres-backed) e o log já existente (`commerce_catalog_sync_logs`, Fase D — só nunca populado fora de teste).
- `POST /api/admin/product-analytics/catalog-sync` (fire-and-forget — a varredura é de minutos, nunca síncrona numa resposta HTTP) e `GET /catalog-sync/status` (polling).
- UI: botão real em `/admin/desempenho-produtos` ("Sincronizar catálogo"), com status/progresso, substituindo uma mensagem que apontava pro botão ERRADO (o de `/admin/produtos`, que sincroniza uma tabela legada diferente, `produtos_ink`).

**O que NÃO foi feito** (gap real, registrado honestamente): o fluxo do comando (§2.2) pede sync **automático** ao conectar o Commerce + sync recorrente sustentável. O que existe hoje é **só manual** (o lojista precisa clicar). Não há cron, não há trigger em "integração conectada", não há retry automático agendado — só o retry manual (clicar de novo) e a proteção de concorrência (lease + guard em processo). Isso é o próximo passo de maior valor (ver seção final).

**Escala/orçamento de chamadas:** a paginação usa `listProductsWithVariants` (1 chamada por página, produto+variante juntos — nunca N+1), lease evita 2 syncs simultâneos da mesma Organization, teto de segurança de 100.000 páginas contra paginação que nunca termina. Não simulei as ~85 mil páginas reais desta rodada (ver "Escopo não coberto") — o comportamento sob esse volume é o mesmo já auditado nas Rodadas D/M (nenhuma mudança na lógica de paginação/upsert em lote nesta rodada), só o *trigger* de disparo é novo.

**Resultado real vs. staging:** sem credencial de produção nesta sessão (leitura/execução só local, Postgres efêmero + mocks). Testado fim a fim: `POST /catalog-sync` → `GET /catalog-sync/status` mostra o run fechando como `failed` com `errorCode: INTEGRATION_NOT_CONNECTED` quando o Ink não está conectado (nunca trava "running" pra sempre, nunca derruba o processo) — prova de que o caminho de erro é seguro. Sucesso real com Ink conectado tem cobertura própria em `catalog-sync.test.js`/`ink-orders-repository.test.js` (pré-existentes, ainda verdes: 84/84 na verificação final, ver Gate F).

---

## 3. Gate B — Modelo de evidência

**Decisão:** não recriei nenhum service. Auditei os DTOs que `JourneyAnalyticsService`/`ProductPerformanceService`/`ReconciliationService` já produzem (Rodadas G/G.1/H/J.4/K/L) e confirmei que já distinguem exatamente o vocabulário do comando:

- `observed` vs. `matched` (Product Performance/Journey funnel) — sempre os dois, nunca um escondendo o outro.
- `linked`/`sampled`/`sampleSize`/`totalEligible` (Journey tier2 — nunca confunde amostra com cobertura total; ex.: 10/10 verificados ≠ 100% de 274 elegíveis).
- Taxonomia normalizada `available|not_connected|unsupported|insufficient_data|not_verified|temporary_failure` (`classificarIndisponibilidade`, Rodada L) — reaproveitada tal e qual no novo Opportunity Diagnostics (nunca uma segunda taxonomia).
- `hypothesis` como conceito **novo** nesta rodada, só no Opportunity Diagnostics — nunca apresentada como causa comprovada (verificado por teste: nenhuma string de hipótese contém "prova"/"garantido"/"causa").

Não toquei `journey-analytics-service.js`, `product-performance-service.js`, `reconciliation.js` nem `product-identity-resolver.js` — Opportunity Diagnostics é um **consumidor novo em cima deles**, nunca um segundo motor.

---

## 4. Gate C — Opportunity Diagnostics (a entrega principal)

Novo módulo `lib/product-analytics/opportunity-diagnostics.js`: determinístico, sem IA, sem classificação mágica. Consome `productPerformanceService.getProductPerformance` (paginado, Store inteira) e `reconciliationService.reconcileProductPerformance` — **nenhuma chamada nova ao GA4/Ink**; o mesmo ReportCache de 15min das Rodadas G/H é reaproveitado de graça.

**5 dos 6 sinais da tabela do comando:**

| # | Sinal | Fonte |
|---|---|---|
| 1 | `low_view_to_cart` | GA4 (ProductPerformance) |
| 2 | `low_cart_to_checkout` | GA4 |
| 3 | `low_checkout_to_purchase` | GA4 (razão calculada localmente — não existe em `itemRatios`) |
| 4 | `units_divergent_ga4_commerce` | Reconciliação GA4×Commerce |
| 5 | `identity_coverage_low` | Cobertura de identidade (agregado, escopo Store) |

**O 6º (gasto Meta por campanha vs. resultado) fica de fora** — decisão registrada, não esquecimento: o reader atual (`lib/meta/campaign-performance.js`) só agrega a Store inteira no período, não por campanha individual o bastante pra apontar "esta campanha específica" sem fabricar granularidade que a fonte não tem.

**Fórmula de prioridade** (documentada uma vez, em `confiabilidade()`): `score = volume × desvio × confiabilidade_da_amostra`, nunca "receita perdida". Baseline = mediana da própria Store entre produtos com amostra mínima **configurável** (nunca limiar universal fixo). Produto acima do baseline, ou abaixo da amostra mínima, nunca vira oportunidade.

**Degradação honesta por fonte:** GA4 desconectado não derruba os sinais que só precisam de Commerce (e vice-versa); sem nenhuma fonte, `status: 'ok'` com `opportunities: []` — nunca 409/500.

**Testes:** 19 testes unitários puros (sem banco) cobrindo — acima vs. abaixo do baseline, amostra mínima, não-monotonicidade de contagem (checkout > cart), denominador zero (nunca Infinity/NaN), toda combinação de fonte desconectada/insuficiente, ordenação por score, corte de apresentação vs. `totalCandidates` real, limiares configuráveis. Mais 4 testes de wiring HTTP fim a fim (processo real, Postgres real). **23/23 verdes.**

---

## 5. Gate D — UX: "Prioridades de hoje"

Novo endpoint `GET /journey/opportunities` (Gate E — ver assinatura abaixo) surge como um card no topo da aba **Visão geral** existente de `/admin/jornada-compra` — nunca uma tela nova, nunca duas implementações divergentes com `/admin/desempenho-produtos`. Cada oportunidade:

- título em linguagem comercial (nunca o código técnico `low_view_to_cart` visível);
- linha de evidência numérica formatada em pt-BR;
- hipótese e ação sugerida **exatamente como o motor escreveu** (nunca reforçadas para soar como fato);
- badge de confiança;
- CTA real: **"Abrir produto"** → `/admin/desempenho-produtos?productId=<id>` — a página lê o parâmetro, abre o drawer do produto certo, e limpa a URL (nunca preso no histórico).

Quando Commerce não está conectado, um Callout explica por quê os sinais de divergência não aparecem (nunca fabrica zero). Sem nenhuma fonte, `EmptyState` explica o motivo. Sem sinal nenhum, a mensagem é **"sem evidência suficiente ainda"** — nunca "está tudo perfeito".

### Evidência real (local, nunca produção)

Sem credencial de produção nesta sessão. Construí um harness de demonstração **local**, separado dos testes automatizados:

- `scripts/dev/mock-ga4-multi-item.cjs` — embrulha (nunca modifica) o mock compartilhado `test/helpers/provider-mock.cjs`, interceptando só o `runReport` item-scoped de uma property mágica pra devolver 7 produtos fabricados (5 "saudáveis" + 2 com desvio deliberado).
- `scripts/dev/smoke-jornada-oportunidades-local.cjs` — sobe o server real contra Postgres efêmero com esse catálogo semeado.

Rodando contra isso, **o motor real, fim a fim** (rota real → service real → UI real) encontrou exatamente os 2 sinais esperados, com a matemática certa:

```json
{
  "sources": { "productFunnel": {"available": true}, "commerceReconciliation": {"available": false, "status": "not_connected"} },
  "opportunities": [
    { "type": "low_view_to_cart", "product": "Produto baixa-conversao",
      "evidence": { "itemsViewed": 5000, "itemsAddedToCartPerItemViewed": 0.008, "storeBaseline": 0.2, "deviation": 0.96 },
      "confidence": "alta" },
    { "type": "low_cart_to_checkout", "product": "Produto fricção-frete",
      "evidence": { "itemsAddedToCart": 900, "itemsCheckedOutPerItemAddedToCart": 0.1, "storeBaseline": 0.5, "deviation": 0.8 },
      "confidence": "alta" }
  ],
  "totalCandidates": 2
}
```

**Screenshot desktop real** (Chrome, servidor local, sessão autenticada): card "Prioridades de hoje" com os 2 diagnósticos acima, evidência, hipótese, ação sugerida e botão "Abrir produto".
**CTA testado ao vivo:** clicar "Abrir produto" navegou pra `/admin/desempenho-produtos?productId=<uuid real>` e abriu o drawer do produto certo, com os mesmos números (5000/40/20/8) — prova de que o deep-link funciona, não só existe.

**Mobile 390px — limitação registrada, não escondida:** `resize_window` (ferramenta de automação de browser) mudou o tamanho da JANELA do Chrome, mas `window.innerWidth` do `<html>` continuou em 1920px nesta sessão — o viewport de renderização não respondeu ao resize (limitação da ferramenta neste ambiente, não do código). Não tenho um screenshot real de 390px pra esta rodada. Verifiquei em vez disso, via inspeção direta do DOM renderizado, que o grid `.pa-oportunidades-grid` (`grid-template-columns: repeat(auto-fill, minmax(280px,1fr))`) colapsa corretamente para **1 coluna** quando o container tem 358px de largura (390px menos os 2×16px de gutter da página) — real, mas não é o mesmo que um screenshot de viewport completo. Registrado como pendência de verificação, não como "testado".

---

## 6. Gate E — API, eficiência, tenancy

Novo endpoint, evolução pequena (não um novo domínio):

```
GET /api/admin/product-analytics/journey/opportunities?startDate&endDate&limit(1-20, default 5)
```

- Mesmo `requireAdmin` + entitlement `analytics_product_performance` de toda a superfície de Product Analytics — nenhum guard novo reimplementado.
- `organizationId`/`storeId` só de `req.tenant` (sessão) — nunca do cliente, mesmo padrão de todas as outras rotas do arquivo.
- **Zero chamadas novas ao GA4/Ink**: reaproveita literalmente as mesmas instâncias de `productPerformanceService`/`reconciliationService` já montadas em `composition.js`, com o mesmo ReportCache de 15min.
- `limit` validado (1-20, nunca hardcoded) — "Prioridades de hoje" é curto de propósito.
- Erro de uma fonte nunca derruba a rota inteira (ver Gate C) — sempre 200 com `sources` explícito, nunca 409/500 por integração ausente.

**Não testado nesta rodada:** simulação de catálogo com ~85 mil produtos (custo de API por rota sob esse volume). A paginação em si é a mesma já auditada nas Rodadas D/G/G.1 (nenhuma mudança); o que não foi medido é o tempo de resposta REAL de `/journey/opportunities` contra um catálogo desse tamanho, porque monta 2 passagens completas (`ProductPerformance` + `Reconciliation`) sobre o conjunto elegível. Não é uma regressão nova (as duas rotas já existiam e já faziam isso sozinhas), mas é o primeiro lugar que soma o custo das duas na mesma requisição — vale medir antes de um piloto com catálogo grande.

---

## 7. Gate F — Testes

### O que rodou e passou (nesta sessão, isolado)

| Suite | Resultado |
|---|---|
| `opportunity-diagnostics.test.js` (novo, unitário puro) | **19/19** |
| `product-analytics-http.test.js` (rotas HTTP, processo real + Postgres real) | **31/31** (27 pré-existentes + 4 novos de `/journey/opportunities`) |
| `reconciliation.test.js` + `catalog-sync.test.js` + `journey-analytics-service.test.js` + `product-performance-service.test.js` (serviços consumidos, não modificados — checagem de não-regressão) | **84/84** |
| `tsc -b --noEmit` (frontend) | limpo |
| `vite build` (frontend) | limpo |

**Total verificado nesta rodada: 134/134, zero falhas, zero skips.**

### O que NÃO rodou

A suíte completa de 6 shards (comando `panel-suite.mjs`) foi iniciada mas **abandonada por contenção de recursos**: a máquina tinha, ao mesmo tempo, pelo menos 4 outras sessões/worktrees ativos (`oria` em `feature/clientes-rfm`, `oria-capabilities`, `oria-creative-fase-a`, `oria-integracoes`) — `ps` mostrou processos de teste de OUTRAS sessões (`clientes-rfm-http.test.js`, `negative-controls.test.js`) competindo por CPU junto com os meus, tornando o tempo/resultado da corrida completa não-confiável como sinal isolado desta rodada. Optei por rodar cirurgicamente todos os arquivos de teste tocados ou logicamente adjacentes (tabela acima) em vez de queimar tempo numa corrida com sinal ruidoso. **Pendência real:** rodar a suíte completa de 6 shards isolada (idealmente com a máquina livre de outras sessões) antes de considerar esta rodada pronta pra PR.

---

## 8. Mudanças de arquivo (resumo)

| Arquivo | O quê |
|---|---|
| `lib/product-analytics/composition.js` | + `syncCommerceCatalog`/`getCommerceCatalogSyncStatus` (Gate A) · + `opportunityDiagnosticsService` (Gate C) |
| `lib/product-analytics/http-routes.js` | + `POST /catalog-sync`, `GET /catalog-sync/status` (Gate A) · + `GET /journey/opportunities` (Gate E) |
| `lib/product-analytics/opportunity-diagnostics.js` | **novo** — motor de diagnósticos (Gate C) |
| `server.js` | wiring das novas dependências no `PRODUCT_ANALYTICS`/router |
| `src/api/productAnalytics.ts`, `src/api/journeyAnalytics.ts` | tipos + fetchers novos |
| `src/pages/desempenho-produtos/DesempenhoProdutosPage.tsx` | botão real de sync do catálogo (Gate A) · abre drawer via `?productId=` (Gate D) |
| `src/pages/jornada-compra/JornadaCompraPage.tsx`, `formatadores.ts`, `jornada-compra.css` | card "Prioridades de hoje" (Gate D) |
| `test/invariants/opportunity-diagnostics.test.js` | **novo** — 19 testes unitários |
| `test/invariants/product-analytics-http.test.js` | + 4 testes HTTP de `/journey/opportunities` + testes do Gate A (catalog-sync) |
| `scripts/dev/mock-ga4-multi-item.cjs`, `scripts/dev/smoke-jornada-oportunidades-local.cjs` | **novos** — harness de demonstração local (nunca produção) |

**Nenhuma migration nova, nenhuma mudança de schema, nenhuma rota removida.** Impacto em funcionalidades existentes: zero mudança de contrato em rotas pré-existentes (só adições opcionais).

---

## 9. Escopo não coberto (registrado, não escondido)

Itens do comando original que **não** foram feitos nesta rodada, por escolha explícita de tempo/risco — nenhum foi esquecido, todos são o próximo passo natural:

- **Sync automático do catálogo** (§2.2) — hoje é só manual (botão). Sem trigger em "integração conectada", sem cron recorrente.
- **Reestruturação de navegação em 5 áreas** (§5.1: Visão geral/Produtos/Pedidos/Canais/Qualidade) — mantive as 5 abas atuais (Rodadas K/L), só adicionei o card de oportunidades na Visão geral existente.
- **Drawer de produto com 1-3 hipóteses** (§5.3) — o drawer existente (`ProdutoPerformanceDrawer`) não foi alterado; as hipóteses só aparecem no card da Visão geral.
- **Tela de pedido dedicada / "Compra vinculada"** (§5.4) — a Correlação transação↔pedido (Rodada L) não foi tocada nem redesenhada.
- **Linguagem comercial na aba Qualidade** (§5.6) — não reescrita nesta rodada.
- **6º sinal (Meta por campanha)** — decisão explícita de não fabricar granularidade que a fonte não sustenta (ver Gate C).
- **Simulação de catálogo 85k / medição de custo de API sob esse volume** (Gate E) — não executada.
- **Piloto real contra Organization de produção** — sem credencial/autorização nesta sessão; toda evidência é local (Postgres efêmero + mocks, claramente rotulado como tal).
- **Suíte completa de 6 shards isolada** — não concluída por contenção de recursos (ver Gate F).
- **Screenshot mobile 390px real** — `resize_window` não funcionou nesta sessão (ver Gate D); verificação parcial via CSS.

## Próximo passo — mais curto, maior valor

Disparar `syncCommerceCatalog` **automaticamente** na primeira conexão bem-sucedida do Commerce (hoje só existe o botão manual) — é a diferença entre "o lojista precisa saber que esse botão existe" e "funciona sozinho assim que ele conecta a loja". É pequeno (um hook no fluxo de conexão já existente, reaproveitando exatamente a mesma função já testada) e destrava o resto da feature (identidade, Desempenho de Produtos, Prioridades de hoje) pra qualquer Organization nova sem intervenção manual nenhuma.
