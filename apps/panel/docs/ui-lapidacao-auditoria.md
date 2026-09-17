# Lapidação da UI do Painel: auditoria, fundação e plano

> **Data:** 13/09/2026 · **Escopo:** painel admin (`admin/`, `/admin/*`) · **Status:** etapa 1 (diagnóstico). Nenhum código de interface foi alterado.
> **Fonte de verdade visual proposta:** [`DESIGN.md`](../DESIGN.md) · **Contexto de produto:** [`PRODUCT.md`](../PRODUCT.md) · **Screenshots:** [`docs/ui-audit/`](./ui-audit/)

---

## 0. Método

| Fonte | O que foi feito |
|---|---|
| **Código** | Leitura de `tokens.css`, `components.css`, `admin-shell.css`, `pedido-admin.css` (`:root`), dos 19 componentes em `components/ds/`, de `AppShell.tsx`, `nav.ts`, `statusMap.ts`, `api/client.ts`, `DashboardPage` e dos 21 CSS de página. Métricas de drift por grep. |
| **App real** | Instância isolada do `server.js` (porta 8091, storage copiado para scratch, sem Postgres/Ink/WhatsApp, senha descartável) servindo o build atual de `admin/dist`. |
| **Navegador** | Playwright (Chromium 1208) via script local, porque o **Playwright MCP falhou ao conectar** nesta sessão (timeout). O motor é o mesmo. Foram cobertas: 36 rotas em 1440×900; dashboard e pedidos com **dados fictícios mockados** via interceptação de rede; 1024 e 900 (tablet); 390 (mobile); drawer, modal, foco por teclado. Em cada rota foram medidos overflow, cards, bordas, raios, tamanhos e pesos de fonte, alvos pequenos e erros de console. |
| **Referências** | `impeccable` (audit, operate, document, craft-floor), `redesign-existing-projects`, `frontend-design`, `CLAUDE.md` do projeto e o doc anterior `claude-refinamento-visual-completo-29-paginas.md`. |
| **Detector** | `impeccable detect`: 7 achados, todos `transition: width` em barras de progresso. |

Limitação da instância local: sem integrações conectadas, a maioria das páginas renderizou **estado vazio ou de erro**, exatamente o que um novo tenant do SaaS verá. Isso foi complementado por uma **validação em produção, somente leitura, com dados reais** (14 telas): ver [seção 11](#11-validação-com-dados-reais-produção-somente-leitura).

---

## 1. Diagnóstico

O painel **já tem uma fundação real**: tokens com aliases documentados, um design system React (`components/ds`) usado em larga escala (138 `<Button>`, 115 `<Field>`, 41 `<DataTable>`, 39 `<PageHeader>`), Radix para overlays acessíveis, `statusMap.ts` fiel aos enums da Ink e um Playground. A direção dark e a paleta semântica estão corretas e alinhadas ao `CLAUDE.md`.

O que impede a sensação de SaaS maduro **não é a direção, é a execução do sistema**. Um punhado de defeitos em arquivos compartilhados se repete em todas as 37 rotas:

1. **Sem `box-sizing: border-box` no shell.** A sidebar declara 248px e renderiza com 276px, invadindo 28px do conteúdo (o conteúdo fica a 12px da borda da sidebar). O input do login vaza para fora do card.
2. **Não existe dono do espaçamento vertical.** Painéis empilhados encostam uns nos outros (0–2px) no Dashboard, no WhatsApp e no Playground. Campos de formulário encostam no hint anterior (Templates). `Card` sem título não tem padding superior (Nova troca, Nova campanha).
3. **Grades dependem da viewport, não da largura do conteúdo.** Em 1024px, a faixa de 5 KPIs e a grade de gráficos estouram horizontalmente. Em 390px o dashboard tem 329px de overflow horizontal.
4. **O verde está sobrecarregado e é ilegível como fundo.** O mesmo `#35D07F` é marca, ação primária, sucesso, item ativo, link, série de gráfico e avatar. Texto branco sobre ele tem **contraste 2.0:1** (reprova AA) em todo botão primário, toast de sucesso e badge de logo.
5. **Erros vazam para a UI em forma técnica e barulhenta.** `api/client.ts` transforma **toda** falha de API em toast vermelho saturado (branco sobre `#FF5454` = 3.2:1), inclusive falhas de carregamento em background. O resultado são toasts como *"integração com WhatsApp não configurada (WHATSAPP_SERVICE_URL/WHATSAPP_API_KEY)"* ao abrir Nova campanha.
6. **Mesmo status, cores e rótulos diferentes.** "Pago" é neutro em Pedidos e verde no Dashboard. "Pendente" de configuração aparece em vermelho em Integrações. Contagens ("2 compras") usam verde de sucesso. Enums crus aparecem como texto (`order.created`, `MARKETING`, `charge`) e, no Dashboard, o rótulo cai para o enum de pagamento quando o backend não manda o rótulo.
7. **O shell exibe o que não existe.** Busca global desabilitada ocupa o espaço mais nobre da tela, os botões "?" e "•" não fazem nada, o usuário é "Administrador / Conta" fixo e 4 itens "EM BREVE" ficam na navegação. Isso contradiz o princípio **Honest states** do `PRODUCT.md`.

**Nota de saúde (rubrica impeccable/audit):**

| # | Dimensão | Nota | Achado-chave |
|---|---|---|---|
| 1 | Acessibilidade | 2 | Texto branco no primário 2.0:1; `Field` não associa `<label>` ao controle (115 usos); glifos Unicode como ícones |
| 2 | Performance | 3 | Barras de progresso animando `width` (7×); shell retorna `null` até carregar settings |
| 3 | Responsivo | 1 | Overflow em 1024px (tablet/notebook pequeno) e 390px; header mobile ocupa 3 linhas; tabelas sem adaptação |
| 4 | Theming | 2 | 3 namespaces de token + tokens fantasmas (`--ds-success`, `--ds-surface-2`) com fallback hex divergente; 144 `style={{}}` |
| 5 | Integridade do sistema | 2 | DS existe e é usado, mas legado `.pa-*`/`.ad-*`, dois sistemas de toast, `<select>` cru 47× e padrões paralelos minam a coerência |
| | **Total** | **10/20** | **Aceitável: trabalho significativo, concentrado na fundação** |

---

## 2. O que já está bom e deve ser preservado

- **Direção dark e paleta semântica** (verde operacional, ciano info, âmbar pendente, vermelho crítico, violeta premium). Evoluir, não trocar.
- **DM Sans**: sans humanista, legível em densidade. Não há motivo técnico para trocar de família.
- **Arquitetura do DS**: componentes pequenos em `components/ds/` com classes `ds-*` e porte 1:1 documentado. A fundação nova entra **dentro** deles.
- **Radix** em Dialog, Drawer, Dropdown e Tooltip: focus trap, ESC e ARIA já corretos.
- **`statusMap.ts`**: fonte única e fiel aos enums da Ink. Basta ser usada em todo lugar.
- **`DataTable` com ordenação e seleção centralizadas.** A densidade e a anatomia evoluem no mesmo componente.
- **`ConfirmDialog`** substituindo `window.confirm`; **`ErrorState`/`EmptyState`/`Skeleton`** já existem (61 usos de `Skeleton`).
- **Honestidade de dados já praticada** em vários pontos ("Indisponível", sparkline só com série real, "Ainda sem tentativa registrada").
- **`color-scheme: dark`**, `prefers-reduced-motion` nos overlays e z-index em tokens.
- **Abas de Recuperação e Estoque** (separação deliberada), stepper nos assistentes, prévia de template ao lado do editor. São bons padrões de produto que merecem acabamento, não substituição.
- **Playground** (`/admin/playground`): vira o contrato visual de cada fase.

---

## 3. Problemas encontrados

Severidade conforme o pedido: **CRÍTICO** afeta uso, legibilidade ou consistência; **ALTO** faz parecer imaturo ou prejudica a escaneabilidade; **MÉDIO** é inconsistência que merece refinamento; **POLISH** é microdetalhe. Entre colchetes está o padrão sistêmico (seção 4) que resolve o item.

### CRÍTICO

| # | Problema | Onde / evidência | Impacto | Resolve |
|---|---|---|---|---|
| C1 | **Contraste do botão primário 2.0:1** (branco sobre `#35D07F`); toast de sucesso idem; botão/toast de perigo 3.2:1 | `components.css` `.ds-btn--primary`, `.ds-btn--danger`, `.ds-toast--*`; `admin-shell.css` `.ad-toast`, avatar, logo | Reprova WCAG AA em toda ação principal do produto | [S4] |
| C2 | **Sidebar invade o conteúdo em 28px** (sem `box-sizing`); o input do login vaza do card | `admin-shell.css` `.ad-sidebar` (248 + padding 14×2) vs `.ad-main { margin-left: 248px }`; `pedido-admin.css` `.pa-field input` | Conteúdo "colado" na sidebar em todas as telas; login quebrado visualmente | [S1] |
| C3 | **Overflow horizontal em 1024px e 390px** | Dashboard em 1024 (KPI com 5 colunas + gráficos cortados); dashboard mobile com +329px; Templates/novo mobile com +67px (`docs/ui-audit/tablet1024-dashboard.png`, `m-dashboard.png`) | Página rola para os lados; KPIs e gráficos inacessíveis | [S3] |
| C4 | **Labels de formulário não associadas ao controle** | `components/ds/Field.tsx` renderiza `<label>` sem `htmlFor` e sem envolver o input (115 usos) | Leitor de tela não anuncia o campo; clicar no rótulo não foca o controle | [S5] |
| C5 | **Mesmo status em cores diferentes; rótulo cru da API como fallback** | `DashboardPage.tsx:351-352`: rótulo = `orderStatusLabel` ou `paymentStatus` cru, tom = estágio do pedido. Em produção o backend manda o rótulo e o problema some; quando o rótulo vem nulo, "paid" aparece em 4 cores (`data-dashboard.png`). Entre páginas, "Pago" é verde no Dashboard e neutro em Pedidos (ver seção 11) | Leitura de estado inconsistente entre telas | [S6] |
| C6 | **Falhas de carregamento viram toast técnico** com variáveis de ambiente e jargão | `api/client.ts:22` faz toast em todo erro. Ex.: "cache do catálogo exige Postgres configurado" ao abrir Integrações; "WHATSAPP_SERVICE_URL/WHATSAPP_API_KEY" ao abrir Nova campanha | Ruído em toda navegação; inaceitável para lojista externo (SaaS) | [S7] |
| C7 | **Painéis empilhados sem espaçamento** e `Card` sem título sem padding superior | KPI → gráficos (2px), Fluxo → gráficos (0), cards do WhatsApp, Playground; label "Loja" colada no topo do card em Nova troca e Nova campanha | Hierarquia colapsa; blocos distintos parecem um só | [S2] |

### ALTO

| # | Problema | Onde / evidência | Resolve |
|---|---|---|---|
| A1 | **Shell com elementos falsos**: busca desabilitada em destaque, "?" e "•" sem ação, usuário "Administrador/Conta" fixo | `AppShell.tsx:206-245` | [S8] |
| A2 | **Verde em excesso**: item ativo com fundo, borda e faixa verdes; ícones ativos, links, avatar, logo e 5 botões "Enviar WhatsApp" verdes empilhados em Carrinhos quentes | `admin-shell.css:95-116`, Dashboard | [S4] |
| A3 | **Cores decorativas nos KPIs**: ladrilho de ícone em 5 tons diferentes, sem semântica; violeta e teal `#2DD4BF` hardcoded como séries | `DashboardPage.tsx:141-169`, `dashboardData.ts:122-124` | [S4] [S9] |
| A4 | **Excesso de cards e moldura dupla**: tabela com borda própria dentro de card com borda (Integrações, Últimos pedidos); cards de escolha dentro de card; painel de variáveis dentro de card (Templates); PIX como grade de 4 cards-atalho; KPIs como 5 cards soltos | `.ds-table-wrap` + `.ds-card`; `docs/ui-audit/desktop-integracoes-full.png` | [S10] |
| A5 | **Tabelas pouco escaneáveis**: linhas de 51px com texto de 14px; células quebram em 2 linhas ("Use / Sul", datas); números proporcionais; ícone de ordenação em todas as colunas, inclusive de tabela com 3 linhas; badge "Pago" duplicado em Pagamento e Status | `components.css:162-187`, Pedidos, Dashboard | [S11] |
| A6 | **Hierarquia tipográfica difusa**: 12 tamanhos (10–28px) e 6 pesos (400/500/600/620/650/700); título de card (15/600) quase igual ao rótulo de KPI; grupos da sidebar e badges em MAIÚSCULAS | Métricas de CSS | [S12] |
| A7 | **Três padrões de erro concorrentes**: toast, texto vermelho solto (WhatsApp: "Não foi possível conectar…") e `ErrorState` | WhatsApp, Integrações, Categorias/associar | [S7] |
| A8 | **Estados vazios soltos no vazio**: título em negrito centralizado no meio da página, sem ícone, ação ou contexto de tabela; gráficos vazios com texto de 15px em negrito | Pedidos, Recuperação, Dashboard vazio | [S13] |
| A9 | **Páginas sem `h1`/PageHeader e voltar ad hoc**: Templates/novo e Pedidos/novo usam título de card como título de página; "← Voltar pra lista" com seta Unicode e alinhamento próprio | `desktop-templates_novo-full.png` | [S14] |
| A10 | **Ação destrutiva como primária**: "Reembolsar" é o primeiro botão, vermelho sólido, no topo do drawer de pedido | `data-pedidos-drawer.png` | [S4] |
| A11 | **Mobile**: barra superior quebra em 3 linhas (~180px antes do título); botão de menu sobrepõe o logo com o drawer aberto; drawer sem botão de fechar | `m-dashboard.png`, `m-drawer.png` | [S3] [S8] |
| A12 | **Linguagem técnica para lojista**: nomes de env var, "Postgres", "DATABASE_URL", "cache", "backfill" como texto de interface em Integrações | `desktop-integracoes-full.png` | [S7] |

### MÉDIO

| # | Problema | Onde |
|---|---|---|
| M1 | Três namespaces de token (`--ink/--cream/--clay`, `--text-primary/--bg-surface`, `--ds-*` fantasma) e fallbacks hex divergentes (`#2dbd6e`, `#f5a524`, `#e5484d`) | `pedido-admin.css`, `tokens.css`, inline em 5 páginas |
| M2 | 144 `style={{}}` inline, concentrados em Origens (51), Campanha detalhe (20), Associar produtos (18) | páginas listadas |
| M3 | 47 `<select>` e 58 `<input>` crus; não existe `Select`/`Textarea`/`Checkbox`/`Switch` no DS; login usa `.pa-field` (input de 68px) | `pages/*`, `LoginPage.tsx` |
| M4 | Raio inconsistente: 6/12/18/pill/50%/10/2/1px. Pills em busca, seletor de loja, stepper, botões legados, badges (18px) e botões circulares do header | CSS |
| M5 | Inputs com o mesmo fundo do card (`--bg-surface`), por isso o campo "some" dentro do painel; o legado usa `--sand` (outro visual) | `components.css:49-58` |
| M6 | Barra de progresso reimplementada inline 5× animando `width` | detector |
| M7 | Dois sistemas de toast (`.ad-toast` e `.ds-toast`) | CSS |
| M8 | `AppShell` retorna `null` até carregar `productSettings`, deixando tela preta na entrada | `AppShell.tsx:157` |
| M9 | Seleção de "choice card" (API Meta vs WhatsApp Web) e stepper com visual próprio por página (`tn-steps`) | Integrações, Trocas/nova, Campanhas/nova |
| M10 | Navegação com 29 itens: "Visão geral" duplicada (Dashboard e WhatsApp), "Nova campanha" (ação) como item de menu, grupo Instagram só com "em breve" | `nav.ts` |
| M11 | Alertas do dashboard: dois banners âmbar empilhados, sendo "carrinhos recuperáveis" (oportunidade) tratado como aviso; plural "carrinho(s) recuperável(is)" | `DashboardPage` |
| M12 | Filtros de Pedidos sem busca e sem "Limpar filtros"; nota "Todas as lojas — aproximado…" como linha de texto solta | `PedidosCentralPage` |
| M13 | Gráfico com eixo monetário cortado ("R$ 20.000,0"); rótulos longos não abreviados | `OrdersRevenueChart.tsx` |
| M14 | Sticky header da tabela não funciona dentro de `.ds-table-wrap { overflow-x: auto }` | `components.css:161-165` |
| M15 | Scrim de modal/drawer a 40%, que separa pouco o overlay do conteúdo | `components.css:193,224` |

### POLISH

| # | Problema |
|---|---|
| P1 | Glifos Unicode como ícones: ☰ (menu), ? e • (header), × (fechar), ↑↓ (ordenação), → (links "Ver todos"). |
| P2 | Scrollbar, seleção de texto e calendário nativos sem tema; `input[type=date]` segue o locale do navegador. |
| P3 | Telefone cru (`5548900000000`) e "pix" minúsculo no drawer; datas em 2 linhas. |
| P4 | Placeholder sem acento ou com reticências inconsistentes; "pra" vs "para" misturados na microcopy. |
| P5 | Botão desabilitado com `opacity .5` sobre verde parece "semi-ativo" (Continuar em Nova troca). |
| P6 | Sparkline plana desenhada quando o valor é 0 em alguns KPIs. |
| P7 | Transições com durações soltas (`.15s`, `.2s`, `.4s`) fora dos tokens de motion. |

---

## 4. Padrões sistêmicos (onde uma correção resolve muitas telas)

| # | Padrão | Causa-raiz | Correção única | Telas afetadas |
|---|---|---|---|---|
| **S1** | Box model inconsistente | `box-sizing` só dentro de `.pa-root` | Reset global `*, *::before, *::after { box-sizing: border-box }` em `tokens-base.css` | Todas (37) |
| **S2** | Espaçamento sem dono | Componentes não definem ritmo; páginas empilham sem contêiner; `.ds-card__body` sem padding-top | `PageStack` (gap 24) no `AppShell`/`PageHeader`; `Card` com padding completo; `Field` stack com gap 16 via `FormSection` | Todas com mais de um bloco (~30) |
| **S3** | Layout baseado em viewport | Media queries por viewport em grades de conteúdo; header sem estrutura mobile | Grades `auto-fit`/container queries; top bar de 56px com menu; tabela com rolagem interna | Dashboard, Recuperação, WhatsApp, PIX, formulários, todas no mobile |
| **S4** | Verde e vermelho sobrecarregados e ilegíveis como fundo | Um token (`--clay`) para marca, ação e sucesso; texto `#fff` fixo | Tokens `accent`/`on-accent`/`success`/`danger-solid`; *One Green Rule*; nav ativa por tom; perigo tintado | Todas (botões, nav, toasts, drawers) |
| **S5** | Formulário sem semântica | `Field` sem `id`; `<select>` cru | `Field` com `useId()` + clonagem do controle; componentes `Select`, `Textarea`, `Checkbox`, `Switch` | ~25 páginas com formulário |
| **S6** | Status resolvido por página | Algumas páginas montam rótulo/tom localmente | `StatusBadge` recebe `{map, value}` e resolve via `statusMap.ts`; tons revisados ("Pendente" de config = warning) | Dashboard, Integrações, Campanhas, Trocas, Produtos |
| **S7** | Erro sem política | Toast automático em `api/client.ts`; copy do backend repassada crua | `api()` não faz toast em GET (opção `{ notify }` para mutações); `Callout`/`ErrorState` para carga; mapa de mensagens humanas por código de erro | Todas que chamam API |
| **S8** | Shell desonesto e pesado | Placeholders de features futuras no header e na nav | Remover ou ocultar busca, ajuda e notificações até existirem; conta real; itens "em breve" recolhidos; top bar enxuta | Todas |
| **S9** | Cor decorativa | Ícone de KPI e séries de gráfico escolhidos por variedade | KPI monocromático; paleta de gráfico ligada à semântica + `chart-neutral` | Dashboard, Recuperação, WhatsApp |
| **S10** | Card como contêiner padrão | `Card` é a única primitiva de agrupamento | `Panel` (com variante `flush`), `Section` sem moldura, `KpiStrip`, `Callout`; *No Nesting Rule* | Dashboard, Integrações, Templates, PIX, Configurações, Campos |
| **S11** | Tabela genérica | `DataTable` com uma densidade só e sem tipos de coluna | Linhas de 44px/13px, `align: 'right' \| 'numeric'`, `truncate`, prop `compact` (40px), rodapé de paginação padrão, estados de loading/empty/error internos | 41 tabelas |
| **S12** | Tipografia sem escala | Tamanhos e pesos escritos à mão em 21 CSS de página | Tokens de tipo (8 papéis) + utilitários; pesos 400/500/600; sentence case | Todas |
| **S13** | Estados vazios e de loading genéricos | `EmptyState` só centraliza texto; `Skeleton` genérico | `EmptyState` com variantes (primeiro uso, sem resultados, não configurado, indisponível), ícone e ação; skeletons com forma (`TableSkeleton`, `KpiSkeleton`) | ~30 |
| **S14** | Cabeçalho de página inconsistente | `PageHeader` opcional; voltar ad hoc | `PageHeader` obrigatório com `back` e `meta`; lint visual no Playground | ~8 páginas filhas |

---

## 5. Direção visual recomendada

**North Star: "A Bancada de Operação".** Detalhamento completo em `DESIGN.md`.

- **Evolução, não substituição.** Mesma família cromática, mesma fonte, mesma arquitetura de componentes. A mudança está na **disciplina de uso**: um verde, cor só com significado, superfícies por tom, borda de 1px, sombra só em overlay.
- **Densidade operacional:** controles de 36px, linhas de 44px (40px no modo compacto), texto de dados de 13px, números tabulares.
- **Menos molduras:** KPIs em faixa única, tabela encostada no painel, seções sem card dentro de formulários, alertas agrupados.
- **Shell honesto e leve:** sidebar de 240px com ativo por tom; top bar de 56px com contexto, loja e conta; nada decorativo.
- **Estados com o mesmo acabamento dos dados:** vazio que ensina, erro que diz como resolver, carregamento com a forma do conteúdo.
- **Rejeitado por brief:** glow, gradientes, glassmorphism, cards dentro de cards, raio de cápsula, cores decorativas, dashboard com cara de landing page, animação decorativa.

> **Conflitos entre skills resolvidos a favor do brief.** `redesign-existing-projects` sugere trocar fonte, dobrar espaçamento, adicionar grain/noise e glass, e evitar sidebar em dashboard. Tudo isso é contrário ao brief (dark operacional, densidade, sem glass) e às regras Operate do Impeccable. Ficou de fora. Aproveitado dela: tabular numbers, estados de hover/active/focus, skeletons, max-width, semântica HTML e remoção de glifos como ícones.

### Correspondência de tokens: atual → alvo

| Atual | Valor atual | Alvo (`DESIGN.md`) | Valor alvo | Nota |
|---|---|---|---|---|
| `--sidebar-bg` | `#070C11` | `bg-sidebar` | `#070C11` | igual |
| `--cream` / `--bg-app` | `#0B121A` | `bg-app` | `#0B121A` | igual |
| `--paper` / `--bg-surface` | `#141F2B` | `surface-1` | `#111A24` | um degrau mais escuro, com menos contraste card × fundo |
| `--bg-subtle` | `#19242F` | `surface-2` | `#16212D` | |
| `--bg-elevated` | `#1D2A37` | `surface-3` | `#1B2734` | |
| `--sand` (input legado) | `#223244` | `control-bg` | `#0D151E` | campo recuado, legível dentro do painel |
| `--ink` / `--text-primary` | `#F3F6F9` | `text-primary` | `#F3F6F9` | igual |
| `--ink-70` | rgba .72 | `text-secondary` | `#A9B4C0` | sólido (8.3:1) |
| `--ink-50`/`--ink-45` | rgba .50/.45 | `text-muted` | `#8390A0` | sólido (≥4.6:1 em todas as superfícies) |
| `--ink-10`/`--ink-15` | rgba .08/.14 | `border-subtle/default/strong` | .06/.09/.14 | 3 níveis |
| `--clay` / `--brand-500` | `#35D07F` | `accent` + `on-accent` | `#35D07F` + `#06140C` | texto escuro (9.4:1) |
| `--clay-dark` | `#29A863` | `accent-pressed` (+ `accent-hover` `#4FD98F`) | | |
| `--sucesso` | `#35D07F` | `success` | `#35D07F` | papel separado do accent |
| `--erro` / `--danger` | `#FF5454` | `danger` + `danger-solid` | `#FF6B6B` + `#C93A3A` | texto 6.3:1; sólido com branco 5.1:1 |
| `--warning` | `#F2A516` | `warning` | `#F2A516` | igual |
| `--info` | `#34B7EB` | `info` | `#34B7EB` | igual |
| `--premium` | `#8B5CF6` | `premium` | `#A78BFA` | `#8B5CF6` como texto reprovava (4.1:1) |
| `--r-sm/md/lg/pill` | 6/12/18/999 | `rounded.xs/sm/md/lg/full` | 4/6/8/12/999 | |
| `--space-*` | existia, sem uso | `spacing` | mesma escala 4px | passa a ser obrigatória |
| `--font-display` Fraunces | sidebar, login | `wordmark` | só wordmark do tenant | |

Estratégia: os **nomes legados** (`--ink`, `--paper`, `--clay`…) viram aliases dos novos tokens durante a migração, para que as páginas `.pa-*` continuem funcionando. São removidos na Fase 9.

---

## 6. Componentes a padronizar

| Componente | Situação | Ação |
|---|---|---|
| `Button` | Existe; primário ilegível; perigo sólido; sem `size`/`loading`/ícone | Tokens novos; `size: sm\|md`; `loading`; `icon`; variante `danger` tintada + `danger-solid` |
| `IconButton` | Só classe `.ds-icon-btn` | Componente com `aria-label` obrigatório e tooltip |
| `Field` | Sem associação label↔controle; sem erro | `useId`, `required`, `error`, `aria-describedby` |
| `Input` | Fundo igual ao painel | `control-bg`, hover/focus/error/disabled |
| `Select` | **Não existe** (47 `<select>` crus) | Novo, nativo estilizado (sem biblioteca) |
| `Textarea`, `Checkbox`, `Switch`, `RadioCard` | **Não existem** | Novos; `RadioCard` substitui choice cards de Integrações |
| `SearchInput` | Não existe | Novo (ícone + limpar) |
| `FormSection` | Não existe | Novo: título + descrição + pilha de campos (gap 16) |
| `PageHeader` | Existe; opcional em algumas páginas | `back`, `meta`, ações; obrigatório em todas |
| `PageStack` / `Stack` | Não existe | Novo; dono do espaçamento vertical |
| `Card` → `Panel` | Existe; sem padding-top; moldura dupla | Padding completo; `flush`; `Section` interna |
| `KpiCard` → `KpiStrip` | 5 cards com ícones coloridos | Faixa única, ícone neutro, delta semântico |
| `DataTable` | Densidade única, sem tipos de coluna | 44/40px, `align`, `numeric`, `truncate`, sticky header, estados internos, rodapé |
| `Toolbar` / `FilterBar` | Cada página faz a sua | Novo contêiner com slots (busca, filtros, limpar, contagem) |
| `Pagination` | Ad hoc em Pedidos | Novo, usado no rodapé da tabela |
| `Tabs` | `components/Tabs.tsx` (reexportado pelo DS), mas páginas repetem o markup `.ds-tabs` à mão (Fila WhatsApp Web, Origens) e há abas próprias (`wa-versoes`) | Todas as abas via componente; contador; variante segmented |
| `StatusBadge` | Existe; tom e rótulo decididos fora | Resolve via `statusMap`; raio 4; ponto opcional |
| `Stepper` | Markup `tn-steps` copiado em 4 assistentes (Trocas/nova, Campanhas/nova, Produtos/novo, Associar produtos) | Novo componente compartilhado |
| `DropdownMenu`, `Tooltip`, `Modal`, `Drawer`, `ConfirmDialog` | Existem (Radix) | Tokens de superfície/sombra/scrim; rodapé sticky no drawer; tamanhos |
| `Toast` | 2 sistemas; fundo saturado | Um sistema; `surface-3` + ícone; política de uso |
| `Callout` | `ad-banner`, `wa-alerta`, texto vermelho solto | Novo componente único |
| `EmptyState` / `ErrorState` | Existem, genéricos | Variantes, ícone, ação, retry |
| `Skeleton` | Existe, com inline style | `TableSkeleton`, `KpiSkeleton`, `PanelSkeleton` |
| `ProgressBar` | Inline 5× | Novo (transform) |
| `Icon` | SVGs via `dangerouslySetInnerHTML` + glifos | Componente `Icon` sobre `icons.ts`; completar set (menu, close, sort, chevron, search, external) |
| Charts (`recharts`) | Cores e ticks locais | `chartTheme.ts`: cores semânticas, eixos, tooltip e formatação monetária compacta |

---

## 7. Plano de implementação em fases

Ajuste em relação à sequência sugerida: **Estados (S7) sobem para dentro da Fase 1/3**, porque a política de erro do `api/client.ts` é fundação e causa ruído em todas as telas. **Responsividade de shell e grades entra nas Fases 2 e 3**, e não só na 7, porque o overflow em 1024px é defeito de fundação. A Fase 7 fica com a adaptação fina de tabelas e formulários no mobile.

Regra de todas as fases: **sem mudança de rota, lógica, contrato de API ou texto de negócio**. Cada fase termina com `npm --prefix admin run typecheck` e `build`, captura Playwright desktop 1440 + 1024 + mobile 390 das rotas de referência, atualização do Playground e revisão sua antes da próxima.

**Rotas de referência** (cobrem todos os padrões): Dashboard, Pedidos (+ drawer), Recuperação, Nova campanha, Templates/novo, Integrações, Configurações e Login.

### FASE 1 — Fundação (tokens, tipografia, cor, superfícies, espaço, raio, botões, inputs)
- Extrair o `:root` de `pedido-admin.css` para **`src/admin/design-system/tokens-base.css`** (resolve o TODO de `main.tsx`), com reset `box-sizing`, tokens alvo e **aliases legados**.
- Reescrever `tokens.css` como camada semântica única e eliminar `--ds-*` fantasmas (substituir nas 5 páginas).
- Tipografia: tokens dos 8 papéis, `tabular-nums` utilitário, pesos 400/500/600, sentence case.
- Foco: `:focus-visible` global com Focus Ring; tema de scrollbar e seleção.
- `Button` (tokens, `size`, `loading`, `icon`, `danger`/`danger-solid`), `IconButton`.
- `Field` (acessível), `Input`, **novos** `Select`, `Textarea`, `Checkbox`, `Switch`, `SearchInput`.
- `api/client.ts` com política de erro (sem toast automático em GET) e `Toast` único com novo visual.
- **Critério de aceite:** contraste AA em todos os botões e toasts; `box-sizing` corrigido (sidebar com 240px reais); Playground mostrando todos os estados; nenhuma página com regressão funcional.

### FASE 2 — App Shell
- `AppShell`: sidebar de 240px com ativo por tom, grupos em sentence case, "em breve" recolhidos, ícones SVG (menu, fechar).
- Top bar de 56px: contexto/voltar e menu da loja (D3); seletor de loja só no modo multi-loja; **ocultar** busca desabilitada, "?" e "•" (D1); ocultar itens "em breve" (D2).
- Drawer mobile com fechar, scrim e foco preso; botão de menu na top bar.
- `PageStack` no container de conteúdo; gutters responsivos; max-width 1600.
- `PageHeader` com `back`/`meta`; aplicado às páginas sem `h1` (Templates/novo, Pedidos/novo, detalhes).
- Skeleton de shell no lugar de `return null`.
- `nav.ts`: renomear "Visão geral" do WhatsApp para "Canal", tirar "Nova campanha" da sidebar (D4), ocultar itens "em breve" (D2), adicionar título de aba de Clientes (R4). **Nenhuma rota muda.**

### FASE 3 — Componentes operacionais
- `Panel` (`flush`, padding completo), `Section`, `Callout`, `KpiStrip`.
- `DataTable`: 44px/13px, tipos de coluna, truncamento, sticky header, modo `compact`, estados internos, `Pagination`.
- `Toolbar`/`FilterBar` e "Limpar filtros".
- Abas só via `Tabs` (remover markup `.ds-tabs` manual); `StatusBadge` via `statusMap` (corrigir C5 e "Pendente" de Integrações).
- `DropdownMenu`, `Tooltip`, `Modal`, `Drawer` (rodapé sticky, ação destrutiva fora do topo), `ConfirmDialog` com `danger-solid`.
- `ProgressBar`, `Stepper`, `Icon`.
- Grades de conteúdo com `auto-fit`/container queries.

### FASE 4 — Formulários e configurações
- `FormSection` + largura de 720px + coluna lateral de prévia (Templates, Campanhas).
- Migrar `<select>` e `<input>` crus para os componentes do DS.
- Validação inline (`error`, `aria-invalid`), marcação de obrigatório e opcional.
- `RadioCard` para escolhas (provedor WhatsApp); Integrações reescritas em linguagem de lojista, com detalhes técnicos em disclosure "Detalhes técnicos".
- Login no padrão do DS (sem `.pa-*`).

### FASE 5 — Dashboard
- `Callout` agrupado (oportunidade `info` + problema `warning`), plural correto.
- `KpiStrip` com ícones neutros e deltas semânticos.
- `chartTheme.ts`: cores semânticas, sem violeta/teal, eixos sem corte, moeda compacta.
- "Últimos pedidos" com `statusMap` e colunas enxutas; "Carrinhos quentes" com ação secundária por linha (uma primária por região).
- Hierarquia: o que exige ação primeiro, tendência depois, comportamento por último.

### FASE 6 — Estados
- `EmptyState` com variantes aplicado a todas as listas; `ErrorState` com retry por painel.
- `TableSkeleton`/`KpiSkeleton`/`PanelSkeleton` no lugar de skeletons genéricos e "Carregando…".
- Sucesso: toasts com o verbo da ação ("Campanha pausada"); loading em botões de mutação.
- Revisão de microcopy de erro (sem env var, sem jargão).

### FASE 7 — Responsividade fina
- Tabelas: primeira coluna fixa e colunas por prioridade em <768px.
- Toolbars empilhadas; ações de página em menu no mobile; controles de 40px em `pointer: coarse`.
- Verificação em 320, 375, 390, 430, 768, 1024, 1280, 1440 e 1920.

### FASE 8 — Motion e microinterações
- Tokens de duração e easing aplicados (120/180/240ms, ease-out exponencial) só a hover, abertura de overlay, troca de aba e confirmação.
- `prefers-reduced-motion` com alternativa que preserva a mudança de estado.
- Remover `transition: width` (detector).

### FASE 9 — Polish final
- Remover aliases legados e CSS `.pa-*` não usado; migrar os 144 `style={{}}` restantes para classes do DS.
- Formatação (telefone, forma de pagamento, datas em 1 linha), acentuação e "pra"/"para".
- `impeccable detect` limpo; auditoria de contraste automatizada; `/impeccable audit` com meta ≥17/20.

---

## 8. Arquivos e componentes afetados primeiro (Fases 1–2)

| Arquivo | Ação | Descrição |
|---|---|---|
| `src/admin/design-system/tokens-base.css` | **criar** | Reset `box-sizing`, tokens primitivos alvo, aliases legados (`--ink`, `--paper`, `--clay`…), foco, scrollbar |
| `src/pedido-admin.css` | editar | Remover o bloco `:root` (movido); manter `.pa-*` enquanto houver uso |
| `src/admin/design-system/tokens.css` | reescrever | Camada semântica única (superfícies, texto, bordas, accent/on-accent, semânticas, tipo, raio, espaço, motion, z-index) |
| `src/admin/design-system/components.css` | editar | Button, IconButton, Field, Input, Select, Textarea, Checkbox, Switch, Toast; tabela e card preparados para a Fase 3 |
| `src/admin/admin-shell.css` | editar (Fase 2) | Sidebar de 240px, top bar de 56px, drawer mobile, PageStack, gutters |
| `admin/src/main.tsx` | editar | Importar `tokens-base.css` no lugar de `pedido-admin.css` inteiro |
| `admin/src/components/ds/Button.tsx` | editar | `size`, `loading`, `icon`, variantes de perigo |
| `admin/src/components/ds/Field.tsx` | editar | `useId`, `htmlFor`, `error`, `required`, `aria-describedby` |
| `admin/src/components/ds/Input.tsx` | editar | `aria-invalid`, integração com Field |
| `admin/src/components/ds/{Select,Textarea,Checkbox,Switch,SearchInput,IconButton,Icon,PageStack}.tsx` | **criar** | Novas primitivas |
| `admin/src/components/ds/index.ts` | editar | Exportar novas primitivas |
| `admin/src/components/ds/icons.ts` | editar | Completar set (menu, close, sort, chevron, search, external, arrow) |
| `admin/src/api/client.ts` | editar | Política de erro: sem toast automático em leitura |
| `admin/src/lib/toast.ts` | editar | Sistema único, variantes e duração |
| `admin/src/shell/AppShell.tsx` | editar (Fase 2) | Top bar honesta, drawer mobile, skeleton de shell |
| `admin/src/shell/nav.ts` | editar (Fase 2) | Rótulos e agrupamento "em breve" (rotas intactas) |
| `admin/src/components/ds/PageHeader.tsx` | editar (Fase 2) | `back`, `meta` |
| `admin/src/pages/Playground.tsx` | editar | Contrato visual de cada fase |
| `admin/src/auth/LoginPage.tsx` | editar (Fase 1/4) | Sair de `.pa-*` |

**Impacto em testes:** o `admin/` não tem suíte automatizada. A validação por fase é `tsc -b`, `vite build`, capturas Playwright das rotas de referência nos 3 viewports e checagem de overflow e contraste por script. Recomendação para a Fase 1: adicionar ao `scripts/` o script de captura usado nesta auditoria, para repetir a comparação antes e depois.

---

## 9. Decisões registradas nesta etapa

- North Star "A Bancada de Operação" (texto do usuário em `DESIGN.md › Overview`).
- DM Sans integral; Fraunces só em wordmark/assinatura do tenant.
- Tabela padrão com 44px/13px; modo compacto opcional de 40px; 48–52px não é padrão.

## 10. Decisões tomadas (13/09/2026)

| # | Decisão | Onde entra |
|---|---|---|
| D1 | **Busca global, ajuda e notificações ficam ocultas** até existirem. | Fase 2 · `AppShell.tsx` |
| D2 | **Itens "em breve" ficam ocultos na navegação** (Histórico, Relatórios, grupo Instagram). | Fase 2 · `nav.ts`/`AppShell.tsx` |
| D3 | **Sem multiusuário.** Modelo: 1 licença = 1 loja; 2 lojas = 2 assinaturas. A top bar mostra o menu da loja (logo/iniciais + nome) com Configurações, Integrações e "Sair"; o "Administrador/Conta" fixo sai. O seletor de loja fica só no modo multi-loja da instalação interna. | Fase 2 · `AppShell.tsx`; `PRODUCT.md` atualizado |
| D4 | **"Nova campanha" sai da sidebar** e fica como ação primária em Campanhas (a rota `/admin/campanhas/nova` continua existindo). | Fase 2 · `nav.ts` |
| D5 | **Pedidos com ordem padrão "Criado em", mais recentes primeiro**, com a ordenação ativa visível no cabeçalho. | Fase 3 · `PedidosCentralPage` (verificar se a ordem vem da API Ink ou do merge entre lojas) |
| D6 | **Estoque:** badge `neutral` para 0 e `danger` só para negativo; **negativos ordenados por último**, porque o estoque negativo não é assertivo. | Fase 3 · `EstoquePage` |
| D7 | **CPF/CNPJ mascarado no drawer**, com ação "Mostrar". | Fase 4 · drawer de pedido; regra em `DESIGN.md › Drawer` |

Em aberto (não bloqueia a Fase 1): se um lojista com várias licenças terá alguma visão entre lojas ou alternará entre contas separadas.

---

## 11. Validação com dados reais (produção, somente leitura)

> **13/09/2026.** Navegação em https://orgulhoregional.com.br/admin via Claude in Chrome, na sessão já autenticada pelo usuário, sem digitar credenciais. Nenhum botão de mutação foi acionado: a única interação foi abrir o drawer de um pedido, que só faz leitura. As capturas **não** foram salvas em disco e este registro não contém dados pessoais.
>
> Telas vistas: Dashboard, Pedidos (+ drawer), Recuperação, Campanhas, Segmentos, Automações, Templates, Fila de envio, Mensagens, Produtos, Estoque, Financeiro, Clientes, Integrações. Janela de 1920×912.

### O que os dados reais confirmam
- **Linhas de 51–52px** em Pedidos (medido): a 1920×912 cabem cerca de 11 pedidos visíveis. Com 44px cabem cerca de 14. Confirma a decisão de densidade.
- **Nomes longos quebram linhas em tabelas estreitas.** Em "Últimos pedidos" do Dashboard, um nome real ocupa **5 linhas** (linha de ~80px) e "Use Sul" quebra em 2. Em Clientes, a coluna Loja quebra em 2 linhas mesmo com a tabela larga, porque a distribuição automática das colunas dá largura demais a Nome e Contato. Confirma a necessidade de `truncate` + larguras de coluna no `DataTable` (S11).
- **Dados com caixa mista** (NOMES EM MAIÚSCULAS ao lado de nomes normais) pioram o escaneamento. Não se deve alterar o dado; é mais um motivo para truncar e usar peso uniforme.
- **5 botões verdes "Enviar WhatsApp" empilhados** em Carrinhos quentes com dados reais (A2). Em Recuperação a mesma ação já é secundária por linha, então o padrão existe no produto e só não é aplicado em todo lugar.
- **Parede de vermelho em Estoque:** quase todas as linhas mostram badge `danger` "0 · esgotado". Para produto sob demanda, "esgotado" no controle dedicado é o estado comum, então vermelho em toda linha anula o sinal. Proposta: `neutral` para 0 e `danger` só para negativo.
- **Ação destrutiva sólida ao lado da primária:** "Limpar e ressincronizar" em vermelho sólido ao lado de "Sincronizar agora" (Estoque), no mesmo padrão do "Reembolsar" (A10).
- **Duas ações primárias iguais na mesma tela:** "Nova mensagem" no cabeçalho e no estado vazio (Mensagens). Viola a One Green Rule.
- **Enums e códigos crus como texto de interface:**
  - Automações: `order.created`, `payment.card_not_authorized`, `shipping.waiting_to_be_sent` em pílulas coloridas.
  - Templates: `MARKETING`/`UTILITY`, `pt_BR`, "Use Sul → payment.approved".
  - Financeiro: tipo `charge`, descrição `pix`, hora `00:00` sem significado.
  - Reforça A12/S7: é preciso um mapa de rótulos humanos junto do `statusMap`, com o código técnico em tooltip ou "detalhes".
- **Mesmo status, cores diferentes entre telas:** "Pago" é badge `neutral` em Pedidos, verde na legenda do Dashboard e fatia verde no donut. Em Clientes, "2 compras" é badge verde, que é cor de sucesso usada para uma contagem (viola Semantic-Only).
- **Ações de linha inconsistentes:** Campanhas usa menu `⋮`; Segmentos mostra "Excluir" como texto solto em cada linha, sem confirmação visível no padrão.
- **Plurais com parênteses** em dados reais: "39 carrinho(s) recuperável(is)", "1 conversões", "0 filtro(s)", "1 item(ns)", "0 mensagem(ns)", "1 de 89 tentativa(s)".
- **Rótulo uppercase dentro de painel** em Fila de envio ("MENSAGENS WHATSAPP ENVIADAS HOJE") e badge "Seguro" encavalado na borda superior do painel.
- **Notas técnicas no meio do conteúdo:** "volume alto no período — mostra só os pedidos mais recentes… (teto de 100 pedidos/página da Reserva Ink)" dentro do gráfico; "Cache do catálogo: … responde todos os filtros nesta tela" + "Resultado do cache do catálogo…" em Produtos, com dois botões de sincronização espalhados pelo toolbar.
- **Legenda de donut listando categorias com 0 (0%)**: metade da legenda é ruído.

### Novos achados (não visíveis na instância local)

| # | Sev. | Problema | Onde | Resolve |
|---|---|---|---|---|
| R1 | ALTO | **Carregamento sem estrutura da página:** Recuperação leva cerca de 5–10s e mostra só barras de skeleton na largura toda, sem `PageHeader`. O título aparece depois e empurra o conteúdo. Dashboard idem. | `RecuperacaoPage`, `DashboardPage` | S13: `PageHeader` renderiza imediatamente e o skeleton ocupa só a região de dados, com a forma da tabela e dos KPIs |
| R2 | ALTO | **Ordem padrão de Pedidos não é cronológica:** a primeira página alterna datas (fev, mar, fev, jun…) sem ordenação indicada. | `PedidosCentralPage` / ordem da API Ink | Fase 3: ordenação ativa visível e padrão "Criado em", mais recentes primeiro. **Aprovado (D5).** |
| R3 | MÉDIO | **Cabeçalho desalinhado da largura do conteúdo:** a 1920px o conteúdo para em 1440px e a top bar (busca, conta) vai até a borda da janela, então ações e conteúdo não compartilham a margem direita. | `admin-shell.css` `.ad-content` vs `.ad-header` | S3/Fase 2: top bar e conteúdo com o mesmo contêiner (ou ambos fluidos até 1600px) |
| R4 | MÉDIO | **Título da aba vazio em Clientes** ("· Admin — Orgulho Regional"): falta a chave em `PAGE_TITLES`. | `shell/nav.ts` | Fase 2 |
| R5 | MÉDIO | **Scrollbar nativa clara na sidebar** (trilho e thumb cinza-claro sobre o fundo escuro). | `admin-shell.css` | Fase 1 (tema de scrollbar) |
| R6 | MÉDIO | **Colunas de tabela muito esparsas em telas largas:** a 1920px a coluna Cliente tem ~290px vazios, o que dificulta seguir a linha com o olho. | `DataTable` | S11: larguras por tipo de coluna, `max-width` por coluna de texto, conteúdo até 1600px |
| R7 | POLISH | **Thumbnail "sem foto"** em texto dentro do quadro da imagem em Produtos (10 mil+ itens). | `ProdutosPage` | Fase 6: placeholder com ícone neutro |
| R8 | POLISH | **Documento (CPF) completo visível no drawer** e contato concatenado (e-mail · telefone) numa única célula em Clientes. | Drawer de pedido, Clientes | Fase 4/6: mascarar com ação "Mostrar" (**aprovado, D7**) e separar colunas de contato. |

### Ajustes no plano a partir disso
- **Fase 3** ganha: larguras e truncamento de coluna, ordenação ativa visível, padrão único de ações por linha (menu `⋮` + confirmação), mapa de rótulos humanos para eventos e categorias da Ink/Meta.
- **Fase 5** ganha: legenda sem categorias zeradas; notas técnicas do gráfico em tooltip de informação.
- **Fase 6** ganha: skeleton por região com `PageHeader` imediato (R1) e utilitário único de pluralização (`plural(n, 'carrinho', 'carrinhos')`).
- **Estoque (aprovado, D6):** tom `neutral` para 0, `danger` só para negativo, negativos por último.

---

## 12. Execução — Fase 1 (Fundação) + Fase 2 (App Shell) + página piloto

> **13/09/2026.** Implementado sobre a arquitetura existente, sem mudar rotas, APIs, regras de negócio ou lógica das páginas. Validação contínua com Playwright numa instância local isolada (dados fictícios por interceptação de rede), em 1440 / 1920 / 1024 / 900 / 390 / 320px. Sem commit.

### Decisões sistêmicas
1. **Uma fonte de valores.** `tokens-base.css` define todos os valores canônicos (cor, tipo, raio, espaço, sombra, controles, layout, z-index), espelhando o frontmatter do `DESIGN.md`, e a base do documento: `box-sizing`, foco, seleção, scrollbar, placeholder.
2. **Compatibilidade explícita, não duplicação.** `tokens.css` virou só camada de apelidos: os nomes antigos `--ink`, `--paper`, `--clay`, `--bg-surface`, `--brand-500`… apontam para os canônicos. As 29 páginas legadas herdam a paleta nova sem edição. Remover na Fase 9. Tokens fantasmas `--ds-*` e fallbacks hex divergentes foram substituídos pelos canônicos (6 arquivos).
3. **Contraste resolvido no token.** Texto `on-accent` (#06140C) sobre verde (9.4:1); perigo tintado no dia a dia; `danger-solid` só no confirmar do `ConfirmDialog` (troca automática). Axe: 0 violações de contraste nas rotas verificadas.
4. **Controles com estados próprios.** Botão 36px (sm 32px, 40px em `pointer: coarse`); disabled com cor própria (sem opacidade); inputs recuados (`control-bg`) com foco por borda accent; `Select` nativo com chevron próprio.
5. **Acessibilidade na primitiva.** `Field` associa `<label>` ao controle automaticamente (`useId`), com `error`/`required`/`optional` e `aria-invalid`/`aria-describedby`, beneficiando os 115 usos existentes. Ícone-botão sem padding nativo (corrige o "ponto solto" do `InfoTooltip`).
6. **Shell honesto (D1–D4).** Sidebar de 240px reais, ativo por tom, grupos em sentence case, itens "em breve" ocultos, "Nova campanha" fora do menu. Topbar de 56px com breadcrumb (grupo › pai › página), seletor de loja só no modo multi-loja, e menu da loja (Radix) com Configurações/Integrações/Sair, no lugar de busca desabilitada, "?" e "•". Topbar e conteúdo compartilham o container de 1600px (R3). Drawer mobile com fechar, Esc e devolução de foco. Skeleton do shell em vez de tela vazia.
7. **Título e contexto por rota.** `ROUTE_CONTEXT` em `nav.ts` resolve título da aba, item ativo e breadcrumb de páginas filhas e fora do menu (corrige a aba vazia de Clientes, R4).
8. **Espaçamento com dono.** `PageStack` (24px) e `ds-stack` (12px); `Card` com padding completo (corrige C7b); `PageHeader` com `back`/`meta` aplicado às 8 páginas com "← Voltar" ad hoc (Templates/novo e Pedidos/novo ganharam `h1`).
9. **Tabela na densidade aprovada.** 44px/13px, números tabulares, cabeçalho 12/500, ícones SVG de ordenação só no hover ou na coluna ativa, ordenação por teclado. Props aditivas: `align`, `width`, `truncate`, `muted`, `hideLabel`, `compact`, `label`.
10. **Piloto: Produtos.** `PageStack` + `PageHeader` (status do cache como metadado, explicação em tooltip, ações "Sincronizar catálogo" e "Novo produto"), toolbar (`SearchInput`, `Select`), notas contextuais discretas, tabela tipada, paginação de rodapé, placeholder de foto com ícone (R7). Mesma lógica, endpoints e textos. Verificado: busca, filtros, paginação (mesmas queries), ordenação, drawer.

### Resultado do `/impeccable audit` (após a execução)

| # | Dimensão | Antes | Agora | Evidência |
|---|---|---|---|---|
| 1 | Acessibilidade | 2 | 3 | Axe: login, Produtos e Playground com 0 violações; contraste AA em todos os tokens; label↔controle; foco visível. Restam `select`/`input` sem rótulo em páginas não migradas (Pedidos, Dashboard). |
| 2 | Performance | 3 | 3 | Sem animação nova. Restam 5 `transition: width` em barras de progresso das páginas; bundle único de 1 MB (anterior). |
| 3 | Responsivo | 1 | 3 | 0 overflow em 33 rotas a 1440 e 390px (exceto Templates/novo no mobile); 0 em 1024. A 320px restam Dashboard (+62px) e Estoque (+40px). |
| 4 | Theming | 2 | 3 | Fonte única + camada de compatibilidade; 0 tokens fantasmas; detector limpo. Páginas ainda usam nomes legados e ~130 `style={{}}`. |
| 5 | Integridade | 2 | 3 | Primitivas novas no DS e piloto sem estilo inline. Legado `.pa-*` e CSS por página ainda convivem. |
| | **Total** | **10/20** | **15/20** | **Bom: fundação resolvida; faltam as páginas** |

### Pendências registradas por fase
- **Fase 3 (componentes operacionais):**
  - `PedidosCentral` com filtros em `Select` e rótulos (axe: `label`/`select-name`).
  - Ordenação padrão por data (D5); Estoque neutro/negativo por último (D6).
  - `StatusBadge` via `statusMap` (Integrações "Pendente" ainda vermelho; `.pa-tag--pendente` já virou âmbar).
  - `Stepper` compartilhado (`tn-steps` em 4 assistentes); abas manuais `.ds-tabs`; `Callout`; `ProgressBar` (remove `transition: width`).
  - Paginação/toolbar das demais listas; formatos de dado (telefone, forma de pagamento).
- **Fase 4 (formulários):**
  - Espaçamento entre campos (Templates/novo, Nova troca); `FormSection`.
  - Templates/novo com overflow de 53px no mobile.
  - Integrações ("Loja" select estreito, env vars no texto); CPF mascarado no drawer (D7).
  - Remover `.pa-field`/`.pa-btn` restantes.
- **Fase 5 (Dashboard):**
  - KPI com ícones coloridos e grade quebrando a 320px; `select` de período sem rótulo.
  - Painéis empilhados sem gap (C7a); cores de gráfico.
- **Fase 6 (estados):**
  - Política de toast em `api/client.ts` (ainda dispara em falha de carregamento, com texto técnico; em dev, o StrictMode duplica).
  - `EmptyState`/`ErrorState` com variantes; skeletons com forma; pluralização.
- **Fase 7 (responsivo):**
  - Estoque a 320px (abas e botões sem quebra de linha); tabelas com coluna fixa e colunas por prioridade.
- **Fase 9 (polish):**
  - Remover `tokens.css` (apelidos), classes `.pa-*` mortas, `style={{}}` restantes.
  - Glifos "→" em links "Ver todos"; code-splitting do bundle.

---

## 13. Execução — Fase 3 (Componentes operacionais)

> **13/09/2026.** Mesmas restrições: sem mudança de rota, API ou regra de negócio. Validação: typecheck, build, Playwright em 1440/1024/390px em 35 rotas (105 capturas; 1 overflow restante, fora do escopo: Templates/novo no mobile), axe-core em 14 páginas (0 violações; Pedidos tinha 4 críticas) e testes de interação (filtros, ordenação, abas por teclado, drawer, paginação).

### Componentes novos no DS
`Toolbar` · `Pagination` · `Callout` · `ProgressBar` · `Stepper` · `TabList` (abas com `role="tablist"`, setas/Home/End, contador). `Tabs` passou a usar `TabList`. `Drawer` ganhou rodapé fixo (`footer`). `DataTable` ganhou `defaultSort`, e cabeçalhos sem texto recebem rótulo para leitor de tela automaticamente. Utilitários: `plural`, `formatTelefone`, `formatDia`, `paymentMethodLabel`, `movementTypeLabel` e `lib/eventLabels.ts` (eventos da Ink, categoria e idioma de template).

### Páginas migradas
- **Pedidos:** toolbar com filtros rotulados e "Limpar filtros"; D5 aplicada (ordenação padrão "Criado em" decrescente, visível no cabeçalho); `Pagination`; drawer com "Reembolsar" no rodapé (tintado), telefone formatado e forma de pagamento com rótulo humano.
- **Recuperação:** `TabList` com contagens, `Toolbar` (busca + status + ações de PIX), ações por linha compactas, ícone de telefone no lugar do glifo "i", cabeçalho visível durante o carregamento (R1).
- **Estoque:** D6 aplicada (0 = neutro, negativo = vermelho e por último); filtro e ações na mesma toolbar.
- **Clientes:** toolbar com contagem pluralizada; "N compras" como texto tabular (sem verde de sucesso).
- **Trocas:** toolbar rotulada, `Pagination`, "Cortesia" em tom informativo (violeta fica só para plano).
- **Promoções:** `TabList` com contagens. **Segmentos:** "Excluir" solto virou menu ⋮ (Editar / Excluir). **Financeiro:** tipo e descrição com rótulos humanos, extrato só com data. **Templates:** categoria, idioma e automações com rótulos humanos; aviso em `Callout`.
- **Fila de envio e Origens:** abas manuais → `TabList`; filtros em `Select`.
- **Assistentes** (Nova troca, Novo produto, Nova campanha, Associar produtos): `Stepper` compartilhado.
- **Barras de progresso** (5 telas + funil da campanha + medidor de volume): `ProgressBar`/`transform`; nenhum `transition: width` restante no painel.
- **Avisos** `wa-alerta` (6 lugares) → `Callout`. **Integrações:** "Pendente" em âmbar; tabela Reserva Ink em painel `flush`.
- **Listas restantes** (Campanhas, Mensagens, Categorias, Eventos, PIX): números e datas alinhados; eventos com rótulo humano (código no `title`).
- CSS morto removido: `.rc-tabs`, `.tn-steps`, `.es-filtros`, estilos de filtro/busca sobrescritos.

### Limites e pendências registradas
- **D5 — ordem global: resolvida (13/09).** Pedidos passou a listar do cache `pedidos_ink` (Postgres) com filtros, ordenação por qualquer coluna e paginação em SQL sobre todo o histórico; "Consultar direto na Ink" mostra o estado ao vivo (sem ordenação por coluna). Produtos ordena no banco quando a fonte é o cache do catálogo. Trocas (só Ink) ficou sem ordenação por coluna. Nova coluna `items_count` no cache (preenchida por webhook/sync/backfill; `—` até lá).
- **Fase 4:** espaçamento de formulários (Templates/novo com +53px no mobile), CPF mascarado (D7), `Automações` (fluxo de eventos ainda com códigos técnicos como referência), `Reembolsos` (busca em linha de campos), textos com nomes de variável de ambiente em Integrações/Fila.
- **Fase 5:** KPIs de Recuperação/Financeiro/Fila ainda como cards soltos (`KpiStrip`), Dashboard.
- **Fase 6:** política de toast, estados vazios com variantes, pluralização nos textos restantes ("loja(s)", "entrega(s)").
- **Fase 9:** `.pc-nota`/`.pc-paginacao` (Origens) e fontes monoespaçadas locais em `whatsapp-web.css`/`templates.css`.

## 14. Execução — Fase 4 (Formulários e configurações)

> **13/09/2026.** Sem mudança de rota, API ou regra de negócio. Validação: typecheck, build, Playwright em 1440/1024/390/320px nas 14 rotas de formulário (0 overflow), axe-core em 13 rotas de formulário (0 violações após 2 correções), detector do Impeccable sem falhas nos arquivos alterados, testes de interação (validação de Campos, edição inline, QR do Pix + link gerado, 3 diálogos com rótulos associados).

### Componentes novos no DS
`FormStack` / `FormSection` / `FormGrid` / `FormActions` (estrutura de formulário: coluna de 720px, campos curtos lado a lado, ações no fim) · `RadioCardGroup` · `Checkbox` · `Switch` · `Disclosure` · `MaskedValue` (+ `mascararDocumento`). `VariavelSelect` passou a ser controle do DS (associa rótulo pelo `Field`). Token `--font-mono` e regra **Code Literal** no DESIGN.md.

### Padrões sistêmicos
- **Ritmo:** todo formulário tem 16px entre campos (antes, várias telas empilhavam campos sem espaço). O corpo do `Modal` ganhou o mesmo ritmo por margem entre irmãos, sem quebrar descrições com `<strong>` em linha; no celular o diálogo mantém 16px de respiro.
- **Ações:** primária à direita, Voltar/Excluir à esquerda (`FormActions`), inclusive nos 3 assistentes (Nova troca, Novo produto, Nova campanha). Botões dentro de coluna não esticam mais.
- **Erros e resultados:** erro de envio em `ds-form-error` com `role="alert"`, só quando existe; resultado (link de pagamento) em `Callout` de sucesso com "Copiar link".
- **Escolhas:** opções de template/mensagem da campanha, chips de área de estampa e checkboxes legados seguem a anatomia do radio card (borda accent + tint quando selecionado, anel de foco via `:has`).
- **Listas editáveis:** Campos personalizados deixou de aninhar um card por campo; cada campo é uma linha.

### Telas migradas
- **Templates/novo** (grade com preview fixo ≥1100px; overflow do mobile resolvido) e **Editor de mensagem do WhatsApp Web** (versões sem `tablist` inválido).
- **Configurações** e **Integrações:** seções, `Switch`/`RadioCardGroup`, textos com nomes de variável de ambiente atrás de `Disclosure`; Backfill e cache do catálogo com linha de campos + ação.
- **Automações** e **Templates/detalhe:** vínculos com espaçamento de formulário e selects rotulados.
- **Pedidos:** CPF/CNPJ mascarado com "Mostrar" no drawer (D7).
- **Novo Pix manual:** loja + valor lado a lado, QR Code visível (a imagem nunca aparecia: herdava `display: none` do vanilla), link gerado em `Callout`.
- **Vincular pedido**, **Reembolsos**, **Campos personalizados**, **Nova troca**, **Novo produto**, **Nova campanha**, modais de Promoção, Categoria (nova/lote), Duplicar produto e Reembolso, `AudienceBuilder`, editor de botões e variáveis de template.
- `PageHeader` passou a dar chave às ações passadas em array (aviso de `key` no console de Categorias, Promoções e Associar produtos).
- CSS morto removido: `.tn-actions`, `.tn-erro`, sobrescritas visuais de input/select em `templates.css`, `promocoes.css`, `trocas-nova.css`, `whatsapp-web.css`, `automacoes.css`, `configuracoes.css`.

### Revisão em produção (após o deploy de e3f17c7, só leitura)
- **Automações:** card de envio sem ritmo entre opções e janela de horário; link "fila de envio" no roxo do navegador; eventos como cards dentro do painel da loja; códigos crus (`cart.abandoned`). Corrigido: pilha no card, link base em `accent` sublinhado, vínculos como linhas, rótulo humano + código em mono discreto, cadência em 3 colunas, ações Remover/Salvar em `FormActions`, rótulos dos campos numéricos associados.
- **Templates/detalhe:** página sem `h1` (nome dentro do card), "MARKETING · pt_BR" cru, teste com telefone esticado e "Enviar teste" solto, Duplicar/Excluir misturados ao teste. Corrigido: `PageHeader` com nome, status e "Marketing · Português (BR)", ações no cabeçalho; painéis "Conteúdo aprovado", "Enviar teste" e "Vínculo com evento"; amostra ausente em `Callout` de aviso; campo de evento rotulado; botão do preview com contraste 4.5:1.

### Limites e pendências registradas
- **Autocomplete de evento** (Templates/detalhe) não navega por teclado — trocar por combobox acessível (Fase 9).
- **Fase 5:** Dashboard e KPIs.
- **Fase 6:** toasts duplicados quando a mesma falha vem de duas chamadas (ex.: "integração com WhatsApp não configurada" 2×) e toasts cobrindo as ações de diálogos no celular; `ErrorState` em página inteira quando só uma integração falta.
- **Fase 7:** painéis de formulário único ocupam a largura do conteúdo com o formulário em 720px (espaço vazio à direita em 1440px) — decidir se o painel acompanha o formulário.
- **Fase 9:** breadcrumb "Variáveis" × título "Campos personalizados"; cores literais do preview do WhatsApp em `templates.css`; `pedido-admin.css` ainda compartilhado com `admin-old`.

## 15. Execução — Fase 5 (Dashboard e KPIs)

> **13/09/2026.** Sem mudança de rota, API ou cálculo. Validação: typecheck, build, Playwright com dados simulados em 1440/1024/390/320px (0 overflow), axe-core no Dashboard e nas 5 telas com KPIs (0 violações), detector sem falhas; referência visual tirada do Dashboard real em produção antes da mudança.

### Componentes e fundação
- **`KpiStrip`** (novo) + **`KpiCard`** reescrito como célula: um painel com divisórias, sem ladrilho de ícone colorido; delta em badge semântica; sparkline 56×18 na linha do rótulo; container queries por célula (sparkline some abaixo de 220px, rótulo em 2 linhas e valor 22px abaixo de 150px); mobile em 2 colunas.
- **`lib/chartTheme.ts`** (novo): cores por token, grade, eixos, cursor, rampa semântica dos estágios e `formatMoedaCurta` ("R$ 1,6 mil").
- **`Card`**: cabeçalho quebra a ação (legenda, link) pra baixo do título quando não cabe.
- **`DataTable`**: células numéricas/datas e colunas `muted` não quebram linha.

### Dashboard
- Página inteira em `PageStack` (antes os blocos encostavam uns nos outros).
- Fila de atenção em `Callout` (falha de integração em `danger`, pagamento e carrinhos em `warning`), com plural correto ("6 carrinhos recuperáveis") e CTA sem seta.
- Faixa única de KPIs no lugar de 5 cards com ícones em 5 cores.
- Gráfico principal: volume em barras `chart-neutral` + receita em linha `info`, legenda no cabeçalho, eixo monetário curto; a nota técnica "volume alto… 100 pedidos/página" saiu do corpo e virou tooltip de informação.
- Status dos pedidos: donut e legenda só com estágios que têm pedido; cores do tom semântico (pago/entregue `success`, estágios em andamento em rampa de `info`) no lugar de violeta/âmbar/teal; legenda ao lado do donut por container query.
- Recuperação: 4 números em lista rotulada (antes números soltos + "1 conversões").
- Fluxo de pedidos: células neutras com traço do estágio, sem bolhas coloridas e sem setas "→".
- Dia da semana e horários: série única em `info` (antes verde e violeta).
- Carrinhos quentes: "WhatsApp" secundário pequeno com ícone (antes 5 botões verdes "Enviar WhatsApp"), "1 item/2 itens".
- Últimos pedidos: painel `flush`, valores e datas à direita ("13/09 17:41"), status com rótulo/tom do `statusMap` (mesmo de Pedidos), coluna Loja só com várias lojas no escopo "Todas".
- Carregamento: esqueleto com a forma da página (faixa + 3 painéis) e cabeçalho imediato.

### Outras telas com KPIs
Recuperação, Financeiro (faixa estreita de 2 saldos), Fila de envio, WhatsApp › Canal (também "Número/Templates/Automações" viraram faixa; aviso de serviço fora em `Callout`), Campanha, Associar produtos, Origens e Playground passaram a `KpiStrip`; `tone` colorido removido das chamadas.

### Pendências registradas
- **Fase 6:** "há 0 min" em carrinhos recém-abandonados; toasts duplicados; empty states sem variante.
- **Fase 8:** gráficos sem animação de entrada por decisão (registrado no DESIGN.md); falta política geral de movimento.

## 16. Execução — Fase 6 (Estados)

> **13/09/2026.** Validação: typecheck, build, Playwright em 25 rotas × desktop/mobile (0 overflow, 0 erro de console, `h1` presente), teste de estados com rede simulada (esqueleto → erro → "Tentar novamente" refaz a chamada; erro de ação em formulário sem toast duplicado; erro de ação sem mensagem na tela gera 1 toast), detector sem falhas.

### Política de feedback
- **Toast só para ação.** `api()` deixou de disparar toast em falha de GET: a tela já mostra o erro no lugar do dado. Antes cada falha de leitura aparecia duas vezes e o polling com erro empilhava toasts ("integração com WhatsApp não configurada" 2×).
- **Sem duplicar o inline.** Se a mensagem de erro já está visível junto do controle (`ds-form-error`/`role="alert"`), o toast é suprimido; mensagem idêntica visível não empilha.
- **Mobile:** toasts no topo (abaixo da barra), sem cobrir ações de diálogo/rodapé.
- Leituras que só avisavam por toast ganharam estado próprio: configuração do WhatsApp Web (Integrações) em `Callout`; tipos do "Duplicar produto" (o diálogo ficava preso em "Carregando tipos…").

### Componentes
- **`ErrorState`**: ícone, `role="alert"`, `onRetry` → "Tentar novamente" (aplicado em 24 carregamentos; Automações deixou de usar markup próprio).
- **`EmptyState`**: `action` em linha própria; compacto dentro de painel/drawer.
- **`Skeleton variant="table"`** em 16 listas; Recuperação carrega com a forma da faixa de KPI + tabela; brilho mais visível.

### Texto
- ~45 plurais "(s)/(ns)/(is)/(es)" viraram singular/plural reais (lojas, destinatários, categorias, produtos, mensagens, itens, cores, linhas…). Mensagens enviadas aos clientes pelo WhatsApp (texto de "carrinho abandonado") **não** foram alteradas — é copy de mensageria.
- "há 0 min" → "há menos de 1 min".
- Uma ação primária por tela: vazio de Campanhas, Templates e Mensagens oferece "Criar …" em `secondary` (o cabeçalho mantém a primária).

### Pendências registradas
- **Fase 7:** tabelas largas no mobile ainda rolam horizontalmente (Últimos pedidos, Estoque); colunas por prioridade.
- **Fase 9:** a copy da mensagem de carrinho abandonado ainda usa "item(ns)" (decisão do dono, é mensagem ao cliente).

## 17. Execução — Fase 7 (Responsivo fino)

> **13/09/2026.** Validação: Playwright em 24 rotas × 320/768/1280/1920 (0 overflow de página, 0 erro de console, `h1` presente) somado às rodadas 390/1024/1440 das fases anteriores; capturas das listas em 320 e 390.

### Tabelas no celular
- **Prioridade de coluna** (`Column.priority: 'low'`): abaixo de 600px as colunas de apoio saem e a linha fica com o essencial; o detalhe completo continua no drawer/página. Aplicado em 17 listas (ex.: Pedidos mostra Cliente · Valor · Status; Estoque mostra Tipo · Variação · Disponível; Produtos mostra Produto · Preço · Status).
- Larguras fixas de desktop não empurram colunas no celular; cabeçalho pode quebrar em 2 linhas; padding lateral de 8px; status longo quebra dentro do badge.
- **Sombra de rolagem** nas bordas quando a tabela ainda é mais larga que a tela.
- **Linha clicável acessível por teclado** (Tab + Enter/Espaço, anel de foco) — antes só abria com mouse/toque.

### Filtros, abas e grades
- Toolbar no celular vira grade: busca e selects em linha inteira, datas lado a lado (antes larguras desencontradas).
- Abas roláveis sem barra de rolagem aparente (a barra aparecia ao lado das abas em Recuperação).
- Dashboard no tablet (700–1023px): painéis curtos em pares (status + recuperação, dia da semana + horários), fluxo com os 6 estágios numa linha.

### Decisão registrada
- **Painel de formulário único** (pendência da Fase 4): o painel mantém a largura do conteúdo, alinhado aos demais blocos da página, e o formulário dentro dele fica em 720px. Estreitar só o painel quebraria o alinhamento das bordas entre blocos (ex.: Campos personalizados tem o formulário e a lista em painéis empilhados).

### Pendências
- **Fase 9:** a 1920px as colunas de texto das tabelas continuam espaçadas (conteúdo limitado a 1600px, colunas `auto`).

## 18. Execução — Fase 8 (Movimento)

> **13/09/2026.** Validação: medição em Playwright do centro e da opacidade do diálogo a cada 30ms durante a entrada, tempo de desmonte de diálogo/drawer ao fechar, mesmo teste com `prefers-reduced-motion: reduce`; typecheck, build, detector.

### Correções
- **Diálogo "pulava" ao abrir:** a animação `scale()` substituía o `translate(-50%, -50%)` que centraliza o `Modal`; durante a entrada o diálogo nascia deslocado e saltava para o centro no fim. Agora usa keyframes próprios que mantêm o centro (medido: centro fixo em 720px durante toda a entrada, sobe 5px enquanto aparece).
- **Overlays sumiam de uma vez:** diálogo, drawer, menu e tooltip ganharam saída (fade/slide curto de 120ms via `data-state="closed"`).
- **Toasts** entram deslizando 8px a partir da borda onde vivem (baixo no desktop, topo no celular) e saem com fade, inclusive no fechamento automático.

### Sistema
- Tokens `--motion-exit`, `--ease-out`, `--ease-in`; entrada/saída do drawer e da navegação mobile nos tokens.
- Chevron do `Disclosure` gira com transição; hover de linha clicável com transição curta.
- **Movimento reduzido global:** uma regra em `tokens-base.css` zera animações e transições do painel (antes só alguns componentes respeitavam).
- DESIGN.md ganhou a seção **Motion** (quando animar, tokens, saída mais curta, regra do diálogo, movimento reduzido).

### Fora do escopo
- `loja.css` e `pedido.css` (site público e página de pagamento) têm transições próprias (`transition: all`, `fadein`, `shimmer`) — não fazem parte do painel.
- Drawers abertos por renderização condicional (`{drawer && <Drawer/>}`) desmontam sem animação de saída; a entrada é preservada. Trocar para `open` controlado fica para quando cada tela for revisitada.

## 19. Execução — Fase 9 (Polimento)

> **13/09/2026.** Validação: diff de captura antes/depois (14 rotas; só mudaram horários gerados pelos dados simulados) para a remoção dos apelidos de token e para o code-splitting; Playwright no **build de produção** em 35 rotas × desktop/mobile (0 overflow, 0 erro de console, `h1` presente); axe-core no build em 12 rotas (0 violações); teste de teclado do combobox; typecheck, build, detector.

### Fundação
- **`tokens.css` removido.** 73 usos de nomes legados (`--ink`, `--paper`, `--clay`, `--brand-500`, `--bg-surface`…) trocados pelos canônicos em 12 arquivos; o painel importa só `tokens-base.css`.
- **`.pc-nota` no DS** (antes dependia de `pedidos-central.css`, que várias telas não importavam), com variante `--warning`.
- **Utilitários de composição** no DS (`ds-bloco-seguinte`, `ds-status-linha`, `ds-lista-meta`, `ds-code-block`, `ds-check-inline`) substituíram estilos inline em Integrações, Evento, Categorias, Associar produtos, drawers de Pedido/Troca/Produto e Simular frete.
- **Code-splitting por rota:** bundle inicial de JS de **1.062 KB → 294 KB** (gzip ~97 KB); cada tela vira um chunk. O CSS das telas continua global e na mesma ordem de cascata de antes (verificado no build), para não depender de qual tela abriu primeiro.

### Telas
- **Detalhe da campanha** refeito sem estilos inline: `PageHeader` com voltar e metadados (status, datas), painéis "Progresso do envio", "Envio em lotes" (controles e métricas por lote em tabela compacta) e "Funil" em grade, faixa de KPIs, `Pagination` e colunas por prioridade nos destinatários.
- **KPI com valor em palavra** ("Indisponível", "Conectado") sai em tamanho de texto em vez de cortar ("Indisponí…").
- Setas "→" removidas de botões/links ("Editar texto da mensagem", "Configurar campos do template") e dos badges de vínculo ("Template: …" / "Mensagem: …"); eventos com rótulo humano na lista de Mensagens.
- **Autocomplete de evento** vira combobox acessível (setas, Enter, Esc, `aria-activedescendant`).
- Chip "categoria nova" em Novo produto vira botão com rótulo ("Remover categoria nova …") em vez de `span` clicável.
- Menu lateral: "Variáveis" → **"Campos personalizados"**, igual ao título da página e ao breadcrumb.
- Código morto removido: página `CarrinhosPage` (rota já redirecionava para Recuperação) e `api/carrinhos.ts`.

### O que fica registrado (não feito, por risco ou por ser decisão do dono)
- `.ds-button-row` ainda tem margem inferior própria (viola "Stack Owns Spacing"); trocar exige revisar ~20 telas que dependem dela.
- Drawers abertos por renderização condicional não animam a saída.
- A 1920px, colunas de texto das tabelas continuam espaçadas.
- Copy da mensagem de carrinho abandonado enviada ao cliente ainda usa "item(ns)".
- `pedido-admin.css` segue compartilhado com `admin-old/` (histórico sem rota).
- Cores literais do preview do WhatsApp (`templates.css`) são intencionais: imitam o app.
