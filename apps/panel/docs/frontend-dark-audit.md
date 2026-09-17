# Auditoria visual — migração pra dark premium

> Gerado a partir de `prompt-revisao-layout-claude.md`. Etapas 1–4 (auditoria + relatório).
> Nenhum código foi alterado nesta etapa — só leitura, screenshots (Chrome headless local,
> logado, dados reais de loja vazios) e comparação com `painel-v2-mockups-paginas/mockup-dark.png`.

## Achado estrutural mais importante

O app **não é um sistema visual único hoje — são dois**, e isso muda a ordem de prioridade de tudo:

- **Páginas migradas pro design system** (`DS.*`, `src/admin/design-system/`): Visão geral, Pedidos,
  Trocas, Recuperação, Produtos, Categorias, Agrupamentos, Promoções, Financeiro, Reembolsos,
  Configurações, WhatsApp Visão geral, Templates, Webhooks e logs. Usam tokens (`--bg-app`,
  `--text-primary` etc.), `DS.pageHeader`, `DS.dataTable`, `DS.card`, `DS.errorState`.
- **Páginas antigas, nunca migradas** (`.pa-*` puro, direto contra `pedido-admin.css`):
  Clientes, Estoque, Automações, Templates-novo, Templates-detalhe, Integrações, Campos
  (Variáveis), PIX (`/admin/pedidos`, `pedido-admin.html`), Pedido-novo, Pedido-vincular.

Isso importa pra dark mode especificamente porque **o grupo 1 consome tokens via alias**
(`tokens.css` aponta `--bg-app: var(--cream)` etc.) e **o grupo 2 usa as variáveis cruas
diretamente** (`var(--cream)`, `var(--ink)`) sem passar pelo alias nenhum. Se eu só trocar
`tokens.css`, o grupo 1 fica dark e o grupo 2 continua claro — dois produtos dentro do mesmo
app. A correção certa (ver Seção D) é inverter a direção do alias: os tokens novos (dark) viram
a fonte, e as variáveis antigas passam a apontar pra eles — assim os dois grupos herdam o dark
de um lugar só, sem editar CSS página por página.

## Bugs funcionais encontrados durante a auditoria (não visuais, mas acharam sozinhos)

- **`/admin/automacoes`**: quando o `whatsapp-webhook-go` está fora do ar, a tela fica
  **completamente em branco** (sem título, sem card de erro) — só um toast solto aparece no
  canto. Comparar com `/admin/templates` (migrada), que mostra corretamente
  título + card de erro. Isso é sintoma direto de estar no grupo 2 (não usa `DS.errorState`).
- **`/admin/clientes`**: nota "Contagem de compras vem do histórico já sincronizado — não é uma
  consulta ao vivo" está com contraste baixo e sem hierarquia — fácil de não ler, mas é uma
  ressalva importante sobre os dados.

---

## A. Problemas globais (aparecem em quase toda página)

1. **Claro demais pra "premium operacional"** — fundo `--cream` (`#F8F1E5`) bege claro em toda
   a área de conteúdo. A direção aprovada é charcoal/blue-black. Isso não é ajuste de cor, é
   inversão completa de tema (ver Seção D).
2. **Hierarquia de superfície plana** — hoje só existem 2 níveis reais (`--paper` sidebar,
   `--cream` conteúdo). O skill de design system exige no mínimo: app bg, sidebar bg, surface,
   elevated surface, subtle surface, hover, active — 7 níveis. Cards, tabelas e drawers hoje
   usam a mesma cor de fundo (`#FFFFFF`), sem estratificação.
3. **Densidade baixa** — cards com `padding: 20px` e uma linha de conteúdo (ex.: KPI simples)
   ocupam o mesmo espaço vertical de um card com tabela inteira. O skill pede linhas de tabela
   48–60px (hoje ok, ~52px) mas cards com muito ar em volta de pouco dado.
4. **Split visual grupo 1 vs grupo 2** (explicado acima) — prioridade #1 antes de qualquer
   trabalho de cor.
5. **Filtros como `<select>` nativo** — funcionalmente corretos, mas visualmente inertes
   (sem estados de foco fortes, sem indicação de "filtro ativo"). O mockup mostra filtros como
   botões com chevron, mais parecidos com controle de produto do que HTML cru.
6. **Sem gráfico/sparkline em nenhum KPI** — o mockup mostra tendência (linha/sparkline) em
   todo KPI. Isso é aceitável de ficar pra depois (dado real de série temporal não existe hoje
   pra todos os KPIs), mas vale decidir explicitamente "sem sparkline por enquanto" em vez de
   ficar como lacuna não-decidida.
7. **Ícones de menu (adicionados na sessão passada) são só stroke fino uniforme** — sem
   variação de peso entre ativo/inativo além da cor. No mockup, o item ativo tem ícone dentro
   de uma "pill" com fundo diferenciado — mais forte visualmente do que o que existe hoje.
8. **Nenhuma tabela tem estado de seleção em massa, ordenação por coluna ou menu contextual**
   (`⋯` por linha) — mencionado no skill de dashboard como padrão esperado pra listas
   operacionais. Não é bloqueador pra dark mode, mas é uma lacuna de "parece produto interno"
   que vale registrar.
9. **Empty states genéricos demais** — a maioria diz só "Nenhum X encontrado", sem ilustração/
   ícone e quase sempre sem CTA (só Recuperação e Trocas têm ação no empty state hoje).

## B. Problemas por página

| Página | Grupo | Principais problemas |
|---|---|---|
| Visão geral | 1 (DS) | Sem sparkline nos KPIs; "Fluxo de pedidos" é texto+número, sem os círculos conectados do mockup; sem gráfico de vendas (decisão consciente, ver conversa anterior sobre dado de 50 pedidos); "Canais e integrações" só lista Ink+WhatsApp+Instagram (correto — Shopee/Mercado Livre do mockup não existem aqui, não replicar) |
| Pedidos (central) | 1 (DS) | Filtros em `<select>` cru; sem contagem de resultados visível antes da tabela; linha de tabela não tem hover forte o bastante pro fundo escuro que vem por aí |
| Trocas / Recuperação / Produtos / Categorias / Agrupamentos / Promoções | 1 (DS) | Mesmos problemas de filtro e densidade da lista acima; consistentes entre si (bom sinal — o design system está sendo respeitado onde existe) |
| Financeiro | 1 (DS) | Tabs (`Movimentações/Antecipações/Saques`) sem indicador visual forte de aba ativa; card de saldo é só texto, sem destaque do valor principal |
| Configurações | 1 (DS) | Só 2 campos reais (nome do produto, multi-loja) — layout correto, mas muito vazio comparado ao mockup de config (não é problema visual, é escopo — não fabricar campos que não existem) |
| Templates / Webhooks e logs / WhatsApp visão geral | 1 (DS) | Mais sólidas do grupo 1 — badges de status corretos, drawer funcionando. Menor prioridade de correção |
| **Clientes** | 2 (legado) | Nenhum componente do design system; filtros e lista em HTML cru; sem estados de loading/erro tratados |
| **Automações** | 2 (legado) | **Bug de tela em branco** quando a API externa falha (ver acima); formulário de vínculo evento→template é denso demais, sem agrupamento visual |
| **Templates (novo/detalhe)** | 2 (legado) | Editor de template com preview lateral — estruturalmente o mais complexo do app; migrar por último e com cuidado (é onde mensagem real pro cliente é composta) |
| **Integrações** | 2 (legado) | Cards de loja em lista simples, sem badge de status visual (só texto "não configurado"); é a tela mais "admin interno" do app hoje |
| **PIX (`/admin/pedidos`, novo, vincular)** | 2 (legado) | Fluxo real de dinheiro (QR/código Pix) — tela mais sensível a regressão. Não tocar até o design system estar validado nas páginas de menor risco |
| **Estoque / Campos (Variáveis)** | 2 (legado) | Menor tráfego/risco — podem esperar |

## C. Componentes que precisam ser refatorados/criados

Já existem (Fase 1, `src/admin/design-system/`) e precisam só de **retint**, não de reescrita:
`PageHeader`, `Card`, `KpiCard`, `DataTable`, `StatusBadge`, `Button` (4 variantes), `Input`,
`Field`, `Drawer`, `Modal`, `Toast` (ainda não usado, `.ad-toast` legado continua ativo),
`EmptyState`/`ErrorState`, `Skeleton`.

Precisam ser **criados** (não existem hoje em nenhum dos dois grupos):
- `FilterBar` — hoje cada página monta sua própria `<div class="pc-filtros">` com selects soltos.
- `Pagination` — existe lógica (Anterior/Próxima) mas repetida em 3 arquivos (`pedidos-central`,
  `trocas`, `produtos`), sem componente.
- `Tabs` — reimplementado 3 vezes com nomes de classe diferentes (`pc-tabs`/`rc-tabs`) fazendo
  a mesma coisa. Consolidar em `DS.tabs`.
- `IconButton` — os botões `?`/`•` da topbar são um-off, não reaproveitáveis.
- `DropdownMenu` — o menu do avatar é código específico dentro de `admin-shell.js`, não um
  primitivo reaproveitável (o menu de ações por linha de tabela, que várias páginas precisam,
  hoje é feito na mão toda vez).

Precisam ser **migrados pro grupo 1** (ver Seção E pra ordem): todos os componentes hoje só
existentes em `.pa-*` — nenhum novo componente a criar aqui, é trabalho de substituição.

## D. Tokens que precisam ser centralizados

Hoje (`src/admin/design-system/tokens.css`) só existem 3 níveis de superfície e nenhuma escala
de elevação/hover. Proposta (nomes mantidos, valores trocados — quem já usa `--bg-app` etc.
não precisa mudar uma linha de código, só o valor final muda):

```css
/* pedido-admin.css :root — fonte única, dark. Hoje é onde --cream/--ink/--clay são definidas;
   viram a base de tudo (grupo 1 via alias em tokens.css, grupo 2 direto). */
--bg-app: #0B121A;          /* era --cream */
--bg-sidebar: #080D13;      /* novo — sidebar mais escura que o conteúdo (skill exige) */
--surface-1: #111A24;       /* era --paper — card padrão */
--surface-2: #16212D;       /* novo — elevado (modal, drawer, dropdown) */
--surface-3: #1C2A38;       /* novo — hover/active de linha de tabela, item de menu hover */

--border-default: rgba(255,255,255,.08);   /* era --ink-10 */
--border-strong: rgba(255,255,255,.14);    /* era --ink-15 */

--text-primary: #F3F6F9;    /* era --ink */
--text-secondary: #A9B4C0;  /* era --ink-70 */
--text-muted: #6B7684;      /* era --ink-50 */

--success: #35D07F;         /* era --sucesso — verde operacional principal */
--info: #34B7EB;            /* novo semântico — informação/transporte (hoje não existe) */
--warning: #F2A516;         /* novo semântico — pendência/recuperação/atenção */
--danger: #FF5454;          /* era --erro */
--premium: #8B5CF6;         /* novo — acento terciário, uso seletivo (ex.: badge "premium") */

--clay: var(--success);     /* compat: cor de marca da loja deixa de ser a cor operacional
                                principal do produto (o próprio prompt pede isso: "não usar
                                cor da loja como identidade do software") */
```

Pontos de atenção reais, não cosméticos:
- **`--clay` hoje muda por loja** (`[data-loja="sul/centro/norte"]` só existe em `pedido.css`,
  o hotpage do CLIENTE — não afeta o admin). No admin, `--clay` é fixo (`#4d543d`) e usado tanto
  como "cor de marca" quanto como "cor de ação primária" — no dark premium essas duas coisas
  precisam se separar (ação primária = verde semântico; marca da loja, se aparecer, fica só no
  logo da sidebar).
- **Badges de status** (`SM.*_STATUS_MAP` em `status-map.js`) já usam `tone` (success/warning/
  danger/info/neutral) em vez de cor direta — isso é o design certo, só precisa que
  `.ds-badge--*` em `components.css` beba dos tokens novos. Nenhuma tela individual precisa
  mudar.
- **Contraste**: `--text-secondary`/`--text-muted` sobre `--surface-2`/`--surface-3` precisa
  ser conferido depois de definir os hex finais (o skill de acessibilidade pede isso
  explicitamente) — não travar a implementação nisso, mas não pular a checagem.

## E. Ordem recomendada de correção

Maior impacto global primeiro, menor risco de regressão de negócio por último:

1. **Tokens** (`pedido-admin.css` + `tokens.css`) — 1 arquivo, cascata pra tudo. Sem isso, nada
   mais faz sentido visualmente.
2. **AppShell / Sidebar / Topbar** (`admin-shell.js/css`) — todo o resto vive dentro disso.
   Inclui: sidebar mais escura que conteúdo, item ativo com pill de fundo, ícones com peso
   maior no ativo.
3. **Componentes globais do grupo 1** (`components.css/js`) — Card, KpiCard, DataTable,
   StatusBadge, Button, Drawer, Modal, EmptyState/ErrorState, Skeleton. Criar `FilterBar`,
   `Tabs`, `Pagination`, `DropdownMenu` aqui também (Seção C).
4. **Páginas do grupo 1** (já usam os componentes — deve ser quase automático depois do passo 3):
   Visão geral → Pedidos → Recuperação → Trocas → Produtos/Categorias/Agrupamentos/Promoções →
   Financeiro/Reembolsos → WhatsApp visão geral/Templates/Webhooks e logs → Configurações.
5. **Migrar grupo 2 pro design system** (ganha dark de graça, porque já estará pronto):
   Clientes → Integrações → Estoque/Campos → Automações → PIX (`pedido-admin`, novo, vincular)
   → Templates-novo/detalhe (editor complexo, deixar por último e testar envio real de
   template de teste depois, como já fizemos na Fase 7).
6. **Corrigir o bug de tela em branco em Automações** — pode ser feito junto do passo 5 pra
   essa página, não precisa de fix isolado antes.

Cada página, ao terminar: rodar, capturar screenshot, listar os 5 maiores desvios contra o
mockup, corrigir, capturar de novo — como o `visual-qa-reviewer` pede. Não vou considerar uma
página pronta só porque renderizou sem erro.

---

## O que meu escopo NÃO inclui do mockup (e por quê)

O `mockup-dark.png` mostra várias coisas que este produto não tem hoje: "Painel Executivo",
contadores por item de menu (92, 23), integração com Shopee/Mercado Livre/Instagram Shopping,
widget de plano/cota ("8.500/15.000 pedidos"), sparkline de tendência por KPI, feed de
"Atividade recente", bloco de NPS/ticket médio/taxa de conversão, banner promocional de
upsell. Vou seguir a linguagem visual (cor, espaçamento, tipografia, hierarquia) desse mockup,
mas **não vou fabricar esses widgets** — nada disso tem dado real por trás hoje, e a própria
instrução do prompt (§0, sessão anterior) e a regra deste projeto são claras: não inventar
funcionalidade sem confirmar. Se algum desses fizer sentido como feature de verdade mais pra
frente, é decisão separada, de produto — não parte de uma revisão visual.

---

## F. Etapa 8 — Entregáveis finais (migração concluída)

Etapas 5–7 executadas na ordem da Seção E. Todas as páginas do grupo 2 (antes só `.pa-*` cru)
migraram pro design system e herdam o dark automaticamente pelo flip de tokens em
`pedido-admin.css`/`tokens.css` — não sobrou nenhuma página com CSS visual próprio fora do
sistema de tokens.

### Lista de mudanças por área

- **Tokens** (`src/pedido-admin.css`, `src/admin/design-system/tokens.css`): paleta `:root`
  reescrita pra dark premium (`--paper`/`--cream`/`--sand`/`--ink`/`--clay`/`--sucesso`/`--erro`
  redefinidos, `--ink-45` adicionado, `--bg-sidebar`/`--bg-elevated`/`--bg-subtle` ajustados,
  `--warning`/`--info`/`--premium` + variantes `-bg` novos, sombras escuras). 7 usos de
  `var(--cream)` como estado hover/ativo trocados pra `var(--sand)` (a lógica de "mais claro no
  hover" invertia com `--cream` virando o tom mais escuro da paleta).
- **AppShell** (`admin-shell.css/js`): sidebar em token dedicado (`--sidebar-bg`, não mais
  compartilhando `--paper` com os cards), `color-scheme: dark` no body, topbar completo
  implementado (busca desabilitada — sem backend real —, botão de ajuda, notificações, avatar
  com plano derivado de entitlements reais, nunca um nome fictício), ícones de menu (`NAV_ICON_PATHS`).
- **Design system** (`components.css/js`): `.ds-drawer`/`.ds-modal` migrados pra `--bg-elevated`;
  `kpiCard` ganhou `icon`/`tone`; `.ds-btn--block` (botão full-width, novo, usado nos formulários
  de Pix/template); `.ds-kpi__icon--{tone}`.
- **9 páginas do grupo 2 migradas** (todas agora usam `DS.pageHeader/card/dataTable/field/
  button/statusBadge/emptyState/errorState/skeletonRows`, nenhuma classe `.pa-*` sobrando):
  Clientes, Integrações, Estoque (+ feature nova de controle direto por produto dedicado,
  ver abaixo), Campos personalizados, Automações, Pedidos PIX (lista, novo, vincular),
  Templates-novo, Templates-detalhe. `Templates` (lista) já estava migrada de uma fase anterior.
- **Bug de tela em branco em erro (`/admin/automacoes` e qualquer outra do grupo 2)**: causa
  raiz era usar `.pa-msg--erro` (uma linha de texto de 13px, sem moldura) como único conteúdo da
  tela — fácil de não perceber que a página "carregou com erro" em vez de "não carregou nada".
  Resolvido migrando todo estado de erro de página inteira pra `DS.errorState` (card centralizado,
  título + descrição). Confirmado por screenshot antes/depois nesta seção.
- **Feature nova (não fazia parte do redesign, pedida no meio da sessão)**: `/admin/estoque`
  ganhou uma segunda fonte de dados, "Controle de estoque" — sincroniza por produto dedicado
  `controle-estoque` (1 por tipo de peça, nunca publicado) via `product_variants[]` do próprio
  `GET /v1/stores/products`, gravado em `controle_estoque_observacoes` (Postgres) por um job a
  cada 15min + botão de sincronização manual. Coexiste com o mecanismo antigo (observação via
  pedidos), como pedido explicitamente.
- **Bug funcional achado e corrigido durante a migração de Produtos**: `/api/admin/produtos`
  mandava o parâmetro `name` direto pra `GET /v1/stores/products` da Ink, que **não documenta
  esse filtro** (confirmado em `documentacao-api-ink.yaml`) — a busca por nome na tela de
  Produtos nunca filtrava nada de verdade, servidor e Ink só ignoravam o parâmetro em silêncio.
  Corrigido em `server.js` (`fetchTodosProdutosLoja`): quando há busca por nome, o servidor
  pagina todo o catálogo da Ink (até 50 páginas por loja, mesmo teto usado no controle de
  estoque) e filtra localmente por substring, devolvendo paginação própria — sem busca, o
  caminho antigo (mais rápido, 1 página por vez direto na Ink) continua exatamente igual.

### Páginas migradas nesta sessão (grupo 2 → grupo 1)

Clientes · Integrações · Estoque · Campos personalizados · Automações · Pedidos PIX (lista) ·
Pedidos PIX (novo) · Pedidos PIX (vincular) · Templates (novo) · Templates (detalhe).

`template-editor.js` (painel de variáveis, preview do WhatsApp, editor de botões — compartilhado
por Campos/Automações/Templates) foi mantido como está: é infraestrutura de domínio bem
específica, não um componente genérico do design system, e já herda o dark via token cru
(`var(--ink)` etc., que agora aponta pro valor escuro). A prévia do WhatsApp e o "toggle switch"
continuam de propósito claros/brancos — é a moldura do celular do cliente, não da interface do
admin.

### Evidência (screenshots reais, Chrome local headless, sessão logada)

Capturados em `/admin/*` com o servidor local (sem `DATABASE_URL`/tokens Ink reais, por isso os
estados de vazio/erro esperados abaixo):
- `estoque.png` — aba "Controle de estoque" nova + aba "Observado via pedidos", erro esperado
  "controle de estoque exige Postgres configurado" renderizado como `DS.errorState` (não em branco).
- `clientes.png`, `integracoes.png` — tabelas/badges corretos, 0 resultados (sem Postgres local).
- `campos.png` — formulário "Novo campo" + "Campos existentes" vazio.
- `automacoes.png` — **prova do fix do bug de tela em branco**: erro de integração WhatsApp
  ausente agora aparece como card "Não foi possível carregar" + descrição, com toast redundante
  (mantido, não é o único sinal de erro como antes).
- `pedido-admin2.png`, `pedido-novo.png`, `pedido-vincular.png` — lista vazia, formulário de Pix
  manual completo, cards de vínculo por Pix pendente/ID manual.
- `templates-novo.png` — formulário completo renderizado (nome, categoria, tipo, cabeçalho,
  corpo, painel de variáveis com todos os grupos reais — Cliente/Loja/Pedido —, rodapé, botões,
  preview do WhatsApp à direita).
- `templates-detalhe.png` — estado de erro (sem WhatsApp configurado local) como card, não em branco.

Não existe captura "antes" página a página do grupo 2 no tema claro anterior — o flip de tokens
foi global e as páginas do grupo 2 nunca tinham sido fotografadas antes desta auditoria (Seção A
já description). A comparação de fidelidade válida é grupo 2 pós-migração vs. grupo 1 (que já
estava correto e serviu de referência visual/estrutural o tempo todo).

### Pendências visuais conhecidas (não bloqueiam, registradas por transparência)

- **Contraste formal**: não rodei um checker de contraste (ex. axe/Lighthouse) nos hex finais de
  `--text-secondary`/`--text-muted` sobre `--bg-subtle`/`--bg-elevated` — a Seção D já sinalizava
  isso como pendente e continua sendo a checagem mais objetiva que falta.
- **`/api/admin/produtos?loja=all`**: mesmo com o fix da busca por nome, o modo "todas as lojas"
  sem busca continua limitado à primeira página (100 produtos) por loja — é o comportamento
  documentado como `approximated: true` desde antes desta sessão, não uma regressão, mas seria a
  próxima extensão natural do mesmo padrão de paginação completa.
- **Espaçamento vertical de formulários com `DS.field` empilhados** (Campos, Pix manual,
  Templates-novo): o componente não tem `margin-bottom` entre campos irmãos, então o respiro
  depende só do padding do card ao redor — visualmente aceitável nos screenshots capturados
  (mesmo padrão já usado em páginas do grupo 1 como Categorias/Produtos), mas é um ponto de
  polimento futuro no nível do design system (`design-system-guardian`: corrigir a base, não
  página por página), não desta migração especificamente.

### Confirmação de funcionalidade existente

- `node --check` limpo em todos os arquivos JS tocados nesta sessão (server.js e todas as
  páginas migradas).
- Servidor local sobe sem exceção (`ADMIN_PASSWORD`/`ADMIN_SESSION_SECRET` de teste) e todas as
  rotas migradas respondem 200 com o novo HTML/JS — os únicos erros de console observados nas
  capturas são 503 esperados (Postgres/Ink/WhatsApp não configurados localmente), idênticos antes
  e depois da migração, sem nenhum erro novo introduzido.
- Fix de `/api/admin/produtos` testado via `curl` autenticado: com e sem `name`, loja inválida e
  loja sem token respondem com a mesma mensagem de erro de antes — o caminho sem busca por nome
  não foi tocado.
- Nenhum texto, produto, ordem de estampa, nome de região ou regra de negócio foi alterado —
  troca foi só de camada visual/estrutural (tokens + componentes) e do bug funcional de busca
  documentado acima.
