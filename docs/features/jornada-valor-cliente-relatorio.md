# Jornada de Valor — relatório da rodada

**Branch:** `feature/jornada-valor-cliente` · **Worktree:** `/Users/gtomazi/projects/oria-jornada-valor` (exclusivo desta rodada)
**Base:** `origin/main` @ `f8f784e` (Rodadas K/L/M já mescladas) — **nenhuma branch alheia tocada** (`oria`, `oria-capabilities`, `oria-creative-fase-a`, `oria-integracoes` seguem intocados).
**Commits locais** (nenhum push/merge/deploy):

```
28ca826 fix(panel): give the canonical commerce catalog sync a production trigger
b52c1e1 feat(panel): add Opportunity Diagnostics engine (Gate C)
5f488df feat(panel): surface Opportunity Diagnostics as "Prioridades de hoje" (Gate D)
bacb7de test(panel): add local multi-product smoke harness for Gate C
942e66b docs(panel): record Jornada de Valor round report
8831430 feat(panel): close the loop from Commerce connect to a synced, identity-resolved catalog (Gate A/B)
c75d3aa fix(panel): stop implying calibrated statistical confidence in opportunity labels (Gate C)
5fea6f4 fix(panel): never show "0 opportunities" as if it were a clean bill of health (Gate B/D)
```

> Os 4 primeiros commits são da rodada "Jornada de Valor" (relatório original, seções 1-9 abaixo,
> mantidas como estavam). Os 4 últimos são a rodada seguinte, **"Jornada de Valor Operacional"**
> (`ORIA_RODADA_SEGUINTE_JORNADA_VALOR_OPERACIONAL.md`), registrada na seção nova ao final deste
> arquivo. **Ajuste de escopo explícito do usuário para esta segunda rodada:** suíte completa (6
> shards) adiada de propósito — testes direcionados aos arquivos/funcionalidades modificados, gate
> obrigatório antes de PR/merge/deploy, não a cada rodada de desenvolvimento.

---

## O que o lojista ganha agora (estado cumulativo — Rodada 1 + Rodada 2 "Operacional")

> **Nota de atualização:** as seções 1-9 abaixo são o relatório ORIGINAL da Rodada 1, preservadas
> como escritas na época — incluindo trechos que a Rodada 2 já resolveu (ex.: "sync automático" era
> um gap registrado na Rodada 1 e é exatamente o que a Rodada 2 entregou). Onde as duas
> divergem, **a seção "Rodada 2" no final deste arquivo é a mais atual.** Este parágrafo de abertura
> foi atualizado pra refletir o estado combinado; o resto do corpo original não foi reescrito.

Abrindo **Jornada de Compra → Visão geral**, o topo da página deixou de ser só números — agora mostra **"Prioridades de hoje"**: até 5 cartões dizendo *qual produto merece atenção, por quê (com o número real), e o que investigar primeiro* — com um botão que abre o produto certo direto no Desempenho de Produtos. Exemplo real (dado de demonstração, ver seção de evidência): *"Interesse não vira carrinho — Produto X: 5.000 visualizações, só 0,8% viraram carrinho (mediana da Store: 20%) → evidência suficiente → Inspecionar foto, preço, descrição..."* — rótulo `evidência suficiente/limitada` desde a Rodada 2 (nunca mais "confiança alta", que soava como um modelo estatístico calibrado que este motor não tem).

Isso só existe porque o catálogo canônico (`commerce_products`) — que antes da Rodada 1 **nunca era sincronizado em produção** — agora sincroniza **sozinho** assim que o lojista conecta a Ink (Rodada 2; a Rodada 1 só tinha entregue o botão manual em Desempenho de Produtos, que continua existindo como "Sincronizar agora"/"Tentar novamente"). Instalações que já estavam conectadas antes dessa mudança se recuperam sozinhas também, sem precisar reconectar nada.

**O que ainda NÃO mudou** (para não prometer mais do que foi entregue): as abas Aquisição / Meta Ads / Correlação transação↔pedido / Qualidade dos dados continuam exatamente como nas Rodadas K/L — nenhuma reestruturação de navegação em 5 áreas (§5.1 do comando) foi feita; "Prioridades de hoje" continua dentro da aba Visão geral existente. Ver "Escopo não coberto" (Rodada 1) e "Pendências exatas" (Rodada 2) no fim.

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

---

# Rodada 2 — "Jornada de Valor Operacional"

**Comando:** `ORIA_RODADA_SEGUINTE_JORNADA_VALOR_OPERACIONAL.md`. **Ajuste de escopo do usuário:**
suíte completa (6 shards) adiada de propósito para esta rodada — testes direcionados aos
arquivos/funcionalidades modificados, integração/tenant-isolation quando jobs/persistência/
autenticação/integrações mudam, typecheck+build quando o frontend muda, smoke visual das telas
alteradas. A suíte completa fica como **gate obrigatório antes de PR/merge/deploy**, registrada
como pendente aqui, nunca declarada como executada.

## O que o lojista ganha agora (incremento desta rodada)

1. **Conectar a loja na Ink já é suficiente.** Antes desta rodada, o catálogo só sincronizava se
   alguém clicasse "Sincronizar catálogo" em Desempenho de Produtos. Agora, o momento em que a
   credencial da Ink é salva e a integração vira `connected` já dispara a sincronização sozinho —
   confirmado ao vivo (teste real, servidor real, Postgres real): conectar → sem nenhum clique
   extra → catálogo sincronizado → identidade dos produtos já resolvida.
2. **Instalações antigas se recuperam sozinhas.** Uma Organization que já estava conectada antes
   desta feature existir (catálogo canônico nunca sincronizado) é pega automaticamente pelo mesmo
   job recorrente, até 1h depois do próximo tick (ou 5 minutos após o próximo restart do servidor)
   — nunca precisa que alguém descubra e clique o botão.
3. **"Prioridades de hoje" nunca mais confunde "sem catálogo" com "está tudo bem".** Se não há
   nenhuma oportunidade porque o catálogo ainda não sincronizou (ou está sincronizando, ou a última
   tentativa falhou), a tela agora diz exatamente isso — com um link pra resolver — em vez da
   mensagem genérica de "nenhuma prioridade encontrada".
4. **Os rótulos de confiança pararam de prometer o que o motor não tem.** "Confiança alta/média/
   baixa" virou "Evidência suficiente/limitada" — nunca mais soa como um modelo estatístico
   calibrado quando é, na verdade, mediana da Store + limiar de amostra.

## Gate 0 — segurança de branch e baseline

- Trabalhei exclusivamente em `/Users/gtomazi/projects/oria-jornada-valor`, branch
  `feature/jornada-valor-cliente`. Nenhum `checkout`/`reset`/`clean`/`restore` na pasta
  compartilhada nem em worktrees de outras sessões. Os 5 commits da rodada anterior foram
  verificados (`git log`) e **nunca reescritos nem recherry-picados** — esta rodada só adiciona
  commits novos em cima deles.
- Baseline confirmado: `git status` limpo, HEAD em `942e66b` antes de começar. Os 134 testes
  direcionados da rodada anterior (opportunity-diagnostics + product-analytics-http + serviços
  adjacentes) foram a baseline aceita — **não re-executei a suíte completa antes de ampliar o
  escopo**, por instrução explícita do usuário que sobrepõe o texto do comando original (§0.2 do MD
  pedia isso; o ajuste de prioridade da conversa pediu o oposto, e o ajuste em chat é o mais
  recente).

## Gate A — catálogo sem intervenção do lojista

**Auditoria antes de codar:** `runCatalogSync` (Fase D) e `bootstrapCommerceIdentities` (Fase F)
não tinham NENHUM disparo automático — só o botão manual (rodada anterior). `lib/platform/jobs.js`
(`createJobRunner`) já existia e já tinha o padrão exato que eu precisava:
`sincronizarCatalogoInkDaOrganizacao`/`catalogo-ink`/`catalogo-ink-boot` (~server.js:2742) fazem
precisamente "tick de hora em hora com guard de vencido + rodada extra 5min após o boot" pro cache
LEGADO (`produtos_ink`). Reaproveitei o padrão inteiro pro catálogo CANÔNICO, sem inventar
infraestrutura nova.

**Implementado:**
- `composition.js#catalogSyncNecessario({organizationId, storeId}, {maxAgeMs})` — decide se uma
  Organization precisa de sync agora, só lendo `commerce_catalog_sync_logs` (nunca chama o
  registry/connector): sem log → precisa (cobre catálogo novo E recovery, mesmo branch); último run
  `running` → não precisa (o lease do `runCatalogSync` já protege); último run `failed`/
  `partial_failure` → precisa; sucesso mais velho que `maxAgeMs` (injetável, default 24h) → precisa.
- `server.js#sincronizarCatalogoCanonicoDaOrganizacao` — mesma assinatura/padrão do irmão legado
  (`apenasVencidos`), usa `storesInkDoContexto()` (já existente) pra saber se a Organization tem
  Ink conectado — nunca um `if (provider === 'ink')` dentro de `catalog-sync.js`/`opportunity-
  diagnostics.js`, o conhecimento de provider fica só na wiring do server.js, exatamente como já
  vivia pro cache legado.
- `JOBS.agendar('catalogo-canonico', 1h, …)` + `JOBS.agendarUmaVez('catalogo-canonico-boot', 5min,
  …)`.
- `PUT /api/admin/integrations/ink/credenciais` dispara `syncCommerceCatalog` (fire-and-forget,
  nunca bloqueia a resposta) só quando a integração **transiciona** pra `connected` (comparando o
  status antes/depois da escrita) — atualizar só `feedUrl`/`webhookSecret` numa integração já
  conectada não redispara nada.
- `GET /catalog-sync/status` ganhou `state` (`never_synced|queued|running|completed|
  partial_failure|failed`), calculado a partir do LOG real (nunca só do Set em memória, que não via
  os disparos do scheduler nem do auto-connect).

**Idempotência (em vez de uma idempotency key literal):** o lease em Postgres de `runCatalogSync`
(`commerce-catalog-sync:<provider>`, por Organization) já é a proteção real — dois disparos quase
simultâneos (ex.: o auto-connect e um tick do scheduler) resultam em UM run de verdade; o segundo
`leases.adquirir` falha e `runCatalogSync` devolve `{status:'locked'}` sem duplicar nada. Documentei
essa equivalência em vez de construir uma fila com chave de idempotência separada — o comportamento
observável é o mesmo, com bem menos superfície nova.

**Não fiz** (registrado, não escondido): 429/backoff explícito por cima do que `catalog-sync.js` já
tinha (nenhuma mudança na lógica de paginação/retry desta rodada); orçamento de chamadas por tenant
configurável (hoje é só o `maxAgeMs` + o rodízio natural do `executarPorOrganizacao`, que já impede
paralelismo de full-syncs mas não limita quantos tenants ficam "vencidos" no mesmo tick); simulação
de 85 mil produtos.

### Teste real (achado durante a construção)

Construir o teste fim a fim (conectar → sync automático → bootstrap automático) contra o mock
compartilhado da Ink revelou um bug de fixture real: `test/helpers/provider-mock.cjs` gera os
MESMOS ids de variante (`1`, `2`) pra todo produto de uma loja — inofensivo pra todo teste
existente (nenhum outro exercita `listProductsWithVariants` da Ink real em lote), mas quebra um
full sync de verdade: o Postgres recusa `ON CONFLICT DO UPDATE` afetando a mesma linha duas vezes
dentro do MESMO `INSERT`, e três produtos reivindicando variante `1` e `2` ao mesmo tempo caem
exatamente nisso. **Nunca um bug de produção** (ids de variante reais da Ink são únicos por
natureza) — só do fixture de teste. Corrigido com um wrapper aditivo
(`test/helpers/provider-mock-ink-catalogo-unico.cjs`) que nunca toca o mock compartilhado.

## Gate B — Catalog Sync → Product Identity → Analytics

`bootstrapCommerceIdentities` (já idempotente, em lote, preserva mapping manual — Fase F, sem
mudança nesta rodada) agora roda sozinho dentro de `composition.js#syncCommerceCatalog`, só quando
o run fecha `status: 'success'` (nunca em `partial_failure` — produtos de um run parcial ganham
identity no próximo run bem-sucedido).

**Invalidação de cache: nenhuma, de propósito.** Auditei `getProductPerformance`/
`getProductPerformanceSummary`/Opportunity Diagnostics e confirmei que NENHUM deles cacheia
identity resolvida — o `resolveAndPersist` roda contra o banco em TODA chamada, sempre fresco. O
único cache existente (ReportCache, 15min) guarda só as LINHAS CRUAS do relatório GA4, que não
mudam quando a identidade muda. Destruir esse cache aqui derrubaria 15 minutos de reuso legítimo
pra TODOS os tenants sem ganho nenhum — a próxima request depois do bootstrap já vê a identidade
nova sozinha.

**Diagnóstico "não mostrar 0 como sucesso":** ver Gate D abaixo — `PrioridadesDeHoje` agora busca
`getCommerceCatalogSyncStatus()` junto com as oportunidades e mostra o estado real do catálogo
quando ele explica a ausência de sinal.

## Gate C — oportunidades confiáveis

- **Universo correto:** já era o conjunto elegível inteiro (a rodada anterior pagina a Store
  inteira via `paginarDesempenhoCompleto`, nunca só a 1ª página) — esta rodada **provou** isso
  explicitamente com um teste novo (249 produtos "normais" + 1 forte no produto #250, fora da
  página interna de 200) e corrigiu o fake de teste pra paginar de verdade (antes sempre devolvia
  tudo numa página só, o que fazia o teste anterior não provar nada sobre paginação).
- **Mínimo de evidência:** já existia (limiar de amostra por sinal, configurável, nunca universal)
  — sem mudança de lógica, só de rótulo (ver abaixo).
- **Rótulos objetivos, nunca confiança calibrada:** `confidence: 'alta'|'media'|'baixa'` →
  `evidenceStrength: 'suficiente'|'limitada'` em todo o caminho (engine, testes, tipos TS, UI).
  Fórmula de score **não mudou** — só o rótulo público.
- **Semântica GA4/hipótese/não-causal:** sem mudança de código (já estava correto desde a rodada
  anterior — `itemsViewed`/etc. já documentados como contagem de item, `hypothesis` já nunca
  apresentada como causa comprovada, testado por regex na rodada anterior).
- **Meta por campanha:** continua fora, mesma decisão/justificativa da rodada anterior.

**Seis sinais planejados, cinco realmente suportados** (repetindo explicitamente, como o comando
pediu): `low_view_to_cart`, `low_cart_to_checkout`, `low_checkout_to_purchase`,
`units_divergent_ga4_commerce`, `identity_coverage_low`. O sexto (gasto Meta por campanha vs.
resultado) segue **não implementado** — o reader atual só agrega a Store inteira no período, nunca
por campanha individual.

## Gate D — validar, não redesenhar

- "Prioridades de hoje" agora distingue estado de catálogo (ver Gate B) — feito.
- Drawer de produto (Desempenho de Produtos) — **auditado, não alterado**: já mostra
  visualizado→carrinho→checkout→comprado (GA4) e já usa `diagnostics` (`unmatched_identity` etc.)
  em vez de 0 quando uma etapa não está ligada a produto (comportamento da Fase G/G.1, sem mudança
  nesta rodada).
- Compra vinculada (Correlação transação↔pedido) — **auditada, não alterada**: já mostra só
  pedido Commerce + transação GA4 vinculada + aquisição quando comprovável, nunca desenha
  view→cart→checkout como sequência pessoal (Rodada L, sem mudança).
- Smoke autenticado real: feito pra "conectar dispara sync automático" (teste automatizado, não
  browser) e pro rótulo de evidência (browser real, screenshot desktop, ver abaixo). **Não fiz** um
  novo smoke visual dos 5 cenários de conectividade desta vez — a rodada anterior já tinha feito
  isso pro card em si; esta rodada só mudou o RÓTULO e ADICIONOU um estado de catálogo, cobertos por
  teste automatizado + 1 screenshot de confirmação visual, não a bateria completa de novo.
- **Mobile 390px:** mesma limitação da rodada anterior — `resize_window` não mudou o viewport real
  nesta sessão (verificado via `innerWidth`). Não retentei desta vez (já documentado como limitação
  conhecida da ferramenta, não do código).

## Gate E — validação no piloto real

**Não feito.** Sem autorização/acesso a credencial de produção nesta sessão — mesma situação da
rodada anterior. Toda evidência desta rodada é local: Postgres efêmero + mock da Ink (com o fix de
fixture documentado acima), claramente rotulada como tal em cada teste/screenshot.

## Gate F — testes

### Rodou e passou (isolado, nesta sessão)

| Suite | Resultado |
|---|---|
| `catalog-sync-necessario.test.js` (novo — puro Postgres, sem servidor) | **8/8** |
| `catalog-sync-automatico.test.js` (novo — servidor real + Ink real via mock) | **2/2** |
| `opportunity-diagnostics.test.js` (2 testes novos desta rodada: evidenceStrength, ranking fora da 1ª página) | **21/21** |
| `product-analytics-http.test.js` (ajustado pro campo `state` novo) | **31/31** |
| `reconciliation.test.js` + `catalog-sync.test.js` + `journey-analytics-service.test.js` + `product-performance-service.test.js` + `product-identity-resolver.test.js` (não modificados — checagem de não-regressão) | **146/146** (agregado, incluindo os acima) |
| `tsc -b --noEmit` | limpo |
| `vite build` | limpo |

**Total desta rodada: 167/167 testes, zero falhas.** Somado à rodada anterior (134), a feature tem
hoje 301 testes direcionados passando, nunca a suíte completa.

### Explicitamente NÃO rodou (por instrução do usuário, não por falha)

A suíte completa de 6 shards (2 pure + 4 db) **não foi executada nesta rodada**, por ajuste de
prioridade explícito do usuário no chat ("adie a suíte completa... não execute novamente os seis
shards completos nesta rodada... fica como gate obrigatório antes do futuro merge ou deploy, não
como pré-requisito para cada rodada de desenvolvimento"). Status: **`not_run`**, não "100% verde" —
fica pendente antes de abrir PR ou deploy, junto com os checks de repositório (`repo:self-check`,
`contracts:check`), migrations/RLS e negative controls completos.

## Mudanças de arquivo (resumo desta rodada)

| Arquivo | O quê |
|---|---|
| `lib/product-analytics/composition.js` | `catalogSyncNecessario` + `catalogSyncMaxAgeMs` (Gate A) · `syncCommerceCatalog` chama `bootstrapCommerceIdentities` em sucesso (Gate B) |
| `lib/product-analytics/http-routes.js` | `state` (taxonomia) em `GET /catalog-sync/status` |
| `lib/product-analytics/opportunity-diagnostics.js` | `confidence` → `evidenceStrength` (Gate C) |
| `server.js` | `sincronizarCatalogoCanonicoDaOrganizacao` + `JOBS.agendar`/`agendarUmaVez` (Gate A) · disparo automático em `PUT /integrations/ink/credenciais` |
| `src/api/productAnalytics.ts`, `src/api/journeyAnalytics.ts` | `CommerceCatalogSyncState`, `evidenceStrength` |
| `src/pages/jornada-compra/JornadaCompraPage.tsx`, `formatadores.ts` | rótulo `EVIDENCIA_LABEL` (Gate C) · estado de catálogo em "Prioridades de hoje" (Gate B/D) |
| `test/invariants/catalog-sync-necessario.test.js`, `catalog-sync-automatico.test.js` | **novos** |
| `test/helpers/provider-mock-ink-catalogo-unico.cjs` | **novo** — wrapper aditivo, corrige fixture de teste (nunca o mock compartilhado) |
| `test/invariants/opportunity-diagnostics.test.js`, `product-analytics-http.test.js` | testes novos/ajustados |

**Nenhuma migration nova, nenhuma mudança de schema.** Nenhum arquivo de outro workstream tocado
(StoreFront/Pixel/CAPI/OAuth/RFM/criativos: nenhum).

## Pendências exatas antes de PR/merge/deploy

1. **Suíte completa (6 shards) + migrations/RLS/negative controls + `repo:self-check` +
   `contracts:check`** — `not_run` nesta rodada, gate obrigatório antes do próximo passo.
2. Piloto real contra o tenant de produção (Gate E) — sem credencial/autorização nesta sessão.
3. Simulação de catálogo em escala (~85k produtos) — não executada nas duas rodadas.
4. Orçamento de chamadas configurável por tenant (rate limit/backoff explícitos por cima do
   scheduler) — hoje só o `maxAgeMs` + o rodízio natural do job runner.
5. Screenshot mobile 390px real — limitação de ferramenta, não retentada nesta rodada.
6. As pendências já registradas na Rodada 1 que não mudaram (reestruturação de navegação, drawer de
   produto com hipóteses, tela de pedido dedicada, linguagem comercial na aba Qualidade).

## Próximo passo — mais curto, maior valor

Com o catálogo, a identidade e o gatilho automático agora fechados, o próximo passo de maior valor
deixou de ser backend: é rodar o Gate F completo (suíte + RLS + contracts) numa janela sem
contenção de máquina, e — se vier verde — abrir o PR desta branch pra revisão. Não há mais nenhuma
peça estrutural faltando pra isso; o que falta é validação, não código novo.

---

# Rodada 3 — "Preparação do piloto"

**Escopo:** curto, de preparação — sem nova fase de desenvolvimento funcional. Teste de escala direcionado, auditoria de agendamento/concorrência, validação de mensagens da tela, testes direcionados. **Sem push, merge ou deploy.**

**Commits locais desta rodada:**
```
3463a66 fix(panel): harden the catalog-sync lease against real-scale duration and crash recovery
ea6a678 test(panel): add an 85k-product scale harness for sync/bootstrap/opportunities
de3992a fix(panel): correct misleading empty-state text in "Prioridades de hoje"
```

## 1. Teste de escala (~85 mil produtos, sem API real da Ink)

Script novo `scripts/dev/scale-test-catalog-85k.cjs`: registry fake (nunca a Ink real) gerando 85.000 produtos em 850 páginas de 100 — o mesmo limite que `catalog-sync.js` usa de verdade — contra Postgres real efêmero. Mede tempo, heap/rss e volume de queries por fase.

| Fase | Tempo | Queries | Heap Δ | Observação |
|---|---|---|---|---|
| 1. `runCatalogSync` (full sync) | **~110s** (110-111s em duas execuções) | 1704 (2 por página + desativação + log) | -0,3MB | O(páginas), nunca O(produtos) — confirmado |
| 2. `bootstrapCommerceIdentities` | **~105-124s** | **4** (constante, batch SQL) | ~0MB | O(1) em número de queries; o tempo vem do volume real das linhas (85k produtos + 170k variantes), não de N+1 |
| 3. `getOpportunities` (`/journey/opportunities`) | **>23 minutos, interrompido deliberadamente sem terminar** | não medido (não terminou) | não medido | **Gargalo crítico — ver abaixo** |

**Sem API real da Ink em nenhuma fase** — confirmado (registry 100% fake, ver script).

### O gargalo crítico

`opportunity-diagnostics.js#paginarDesempenhoCompleto` chama `productPerformanceService.getProductPerformance` em páginas de 200 — para 85k produtos, ~425 chamadas internas. **Cada uma dessas chamadas** roda `resolveAndPersist` (`product-performance-service.js`) contra o conjunto **INTEIRO** de itemIds observados pelo GA4 (nunca só os da página) — ou seja, a resolução de identidade de ~20.000 ids é refeita **~425 vezes**, uma por página interna, em vez de uma vez só. Pior: `reconciliationService.reconcileProductPerformance` faz a **MESMA** varredura paginada de forma **independente** (sua própria `agregarAnalyticsCompleto`), dobrando o problema — duas passagens completas e redundantes sobre o catálogo inteiro por chamada ao endpoint.

Isto é um problema **pré-existente** (existe desde a Fase G — `resolveAndPersist` dentro de `getProductPerformance` nunca foi projetado para ser chamado em loop sobre o catálogo inteiro) e **não foi introduzido por nenhuma das duas rodadas de Jornada de Valor**. Corrigir direito exige mudar como `product-performance-service.js` participa de uma varredura completa (cachear a resolução de identity por chamada, ou dar ao chamador um jeito de resolver 1x e reaproveitar) — **exatamente o tipo de mudança que esta rodada pediu explicitamente para NÃO fazer** ("não faça uma grande refatoração"). Registrado aqui como o achado central, não corrigido às cegas.

**Por que isto ameaça o piloto:** se a Organization piloto tiver um catálogo desta ordem de grandeza, abrir a Jornada de Compra faria a chamada a `/journey/opportunities` travar por dezenas de minutos ou nunca responder dentro de um timeout HTTP razoável — a tela ficaria com "Prioridades de hoje" carregando indefinidamente. **Não testado**: o comportamento com um catálogo pequeno/médio (centenas a poucos milhares de produtos), que é provavelmente a faixa real do piloto — aí o mesmo N× redundante é pequeno o bastante pra não doer. **Recomendação:** antes de habilitar esta tela pra uma Organization real, confirmar o tamanho real do catálogo dela; se for da ordem de dezenas de milhares pra cima, o piloto não deve começar sem essa correção.

## 2. Auditoria de agendamento (concorrência, leases, restart, 429)

- **Lease TTL curto demais pro tamanho real de um sync** (achado, corrigido — commit `3463a66`): `syncCommerceCatalog` chamava `runCatalogSync` sem `ttlMs` explícito, usando o default de `leases.js` (`ttlPara(0)` = 30min, pensado pra jobs curtos). Sem heartbeat/renovação do lease (`job_leases.ate` é fixo desde a aquisição — ver `migrations/sql/0016-job-leases.up.sql`), um sync real mais lento que 30 minutos (rede real da Ink, não o fake local — o teste de escala mostrou ~110s SEM rede real) teria o lease expirado enquanto ainda roda, permitindo um segundo sync concorrente da mesma Organization. **Corrigido**: `catalogSyncLeaseTtlMs` explícito (default 3h).
- **Recuperação após restart quebrada** (achado, corrigido — commit `3463a66`): se o processo cai NO MEIO de um sync, a linha em `commerce_catalog_sync_logs` fica `running` pra sempre (`fecharLog` nunca roda). `catalogSyncNecessario` tratava QUALQUER linha `running` como "não precisa" — travando o scheduler automático pra aquela Organization pra sempre, mesmo com o lease real já expirado havia muito tempo. **Corrigido**: linha `running` mais velha que o TTL do próprio lease agora é tratada como órfã, e o scheduler tenta de novo.
- **Múltiplas Organizations, concorrência**: `JOBS.executarPorOrganizacao` já processa uma Organization POR VEZ, sequencialmente, com rodízio (`emRodizio`) entre ciclos — nunca dispara N syncs em paralelo. Auditado, sem mudança necessária.
- **Falha parcial**: já tratada corretamente desde a Fase D — upserts de páginas anteriores ficam, desativação nunca roda em falha parcial. Auditado, sem mudança necessária.
- **429/backoff**: `lib/ink/retry.js` já envolve TODA chamada GET da Ink (incluindo `listProductsWithVariants`) com até 2 retries curtos (400ms, 1200ms) em 429/502/503/504. **Não auditado/testado nesta rodada**: se a API real aplicar rate limit mais agressivo que esses 2 retries aguentam ao longo de 850 páginas sequenciais, o sync inteiro falha/fica parcial (nenhum "pacing" proativo entre páginas). **Não é um bug identificado** (sem visibilidade sobre os limites reais da Ink), mas é uma lacuna de robustez conhecida — recomendo confirmar o rate limit real da conta piloto antes do primeiro sync de produção.

## 3. Mensagens da tela (Prioridades de hoje)

Auditados e corrigidos dois problemas concretos (commit `de3992a`), nenhum novo texto/regra de diagnóstico inventado:

- **"Conectar Commerce sozinho não garante dados comportamentais"** — confirmado um problema real: como `reconciliationService.reconcileProductPerformance` sempre depende de GA4 E Commerce ao mesmo tempo, a mensagem antiga ("Sem fonte conectada... Conecte o GA4 e/ou o Commerce") aparecia mesmo quando o Commerce JÁ estava conectado e só faltava o GA4 — dizendo pro lojista conectar algo que ele já tinha feito. Reescrita pra nunca afirmar o estado de uma integração específica que o sinal não prova, e pra deixar claro que a maioria dos sinais depende do GA4.
- **Catálogo não sincronizado / GA4 ausente / dados insuficientes / ausência de oportunidades** — os quatro estados já eram distinguidos corretamente antes desta rodada (rodada 2, Gate B/D) — confirmado, sem mudança necessária além do item acima.
- **Título "Prioridades de hoje" com período de várias semanas** — confirmado que o card nunca mostrava o período junto do título, o que podia soar como "só dados de hoje" com o filtro em semanas. Adicionado o período selecionado na descrição do card (o nome "Prioridades de hoje" continua como está — é o nome do recurso, não uma afirmação de "só dados de hoje", mesmo padrão de outros produtos com widgets "de hoje" que resumem uma janela maior).

## 4. Testes

Só testes direcionados, nenhuma suíte completa (mantido como pendência pré-merge, conforme combinado):

| Suite | Resultado |
|---|---|
| `catalog-sync-necessario.test.js` (4 testes novos: running recente/órfão/override + isolamento por Organization dedicada) | **10/10** |
| `catalog-sync-automatico.test.js` (revalidado após o fix de lease TTL) | **2/2** |
| `product-analytics-http.test.js` | **31/31** |
| `opportunity-diagnostics.test.js` | **21/21** |
| `tsc -b --noEmit` | limpo |
| `vite build` | limpo |

**Achado operacional durante os testes (não é bug de código):** rodar `catalog-sync-necessario.test.js` CONCORRENTEMENTE com o teste de escala de 85k (mesmo container Postgres) derrubou a conexão do teste de escala ("Connection terminated unexpectedly") — contenção de recursos entre os dois, erro meu de execução, não um bug do sistema sob teste. Corrigido rodando os dois em sequência, nunca em paralelo, pro resto da rodada. Da mesma forma, rodar 8 arquivos de teste (cada um sobe um Postgres efêmero + migrations) em sequência numa única invocação causou UM timeout transitório de boot de servidor em `product-analytics-http.test.js` (contenção real da máquina, que tem outras sessões/worktrees ativos ao mesmo tempo) — confirmado como falso alarme ao rodar o mesmo arquivo isolado logo em seguida (31/31, limpo).

## 5. Avaliação objetiva — o que falta pro piloto

**Bloqueador real, não contornável sem mais trabalho:**
- **O gargalo de `/journey/opportunities` em catálogos grandes** (seção 1). Se o catálogo real da Organization piloto for da mesma ordem de grandeza dos ~85 mil produtos referenciados desde a Fase D, a tela trava. Isto PRECISA de uma correção (fora do escopo desta rodada por instrução explícita) antes de habilitar a feature pra essa Organization — ou confirmação de que o catálogo real dela é pequeno o bastante pra o problema não aparecer na prática.

**Resolvido nesta rodada, já seguro pro piloto:**
- Lease TTL realista pro tamanho real de um sync.
- Recuperação automática depois de um crash do processo no meio de um sync.
- Mensagens da tela não afirmam mais o estado errado de uma integração.

**Pendências já conhecidas, sem mudança nesta rodada:**
- Suíte completa (6 shards) + RLS + `contracts:check` + `repo:self-check` — continua `not_run`, gate obrigatório antes de PR/merge/deploy.
- 429/backoff proativo contra a API real da Ink em varreduras longas — sem dado real sobre o rate limit da conta piloto pra saber se é necessário.
- Validação com Organization de produção real — ainda sem credencial/autorização nesta sessão.

**Recomendação objetiva:** o piloto pode começar com uma Organization de catálogo pequeno/médio (a validação de escala mostrou que as fases 1 e 2 — sync e bootstrap — são rápidas e seguras em qualquer tamanho testado). **Não deve começar** com uma Organization cujo catálogo real se aproxime da escala de 85 mil produtos sem primeiro resolver o gargalo da seção 1 — abrir "Jornada de Compra" pra essa Organization hoje resultaria numa tela travada, não numa experiência quebrada de forma sutil.
