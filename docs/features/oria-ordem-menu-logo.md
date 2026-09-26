# Ordem final da sidebar e símbolo oficial do Oria

Branch `feature/ordem-menu-logo-oria`, a partir da `main` com o PR #37 (`fe58ab1`) já mesclado. Sem migrations, APIs ou rotas novas. Aparência, ícones, grupos recolhíveis, trilho de 64 px e menu da loja
(aprovados) ficaram como estão.

## Ordem (fonte única: `apps/panel/src/shell/nav.ts`)

`Visão geral` (isolada) → **Comunicação** → **Marketing e dados** → **Criativos** → **Campanhas** → **Operação** → **Financeiro** → **Catálogo**.

O `NAV_GROUPS` foi apenas reordenado — desktop, drawer mobile e trilho recolhido leem o mesmo array (o `AppShell` só faz `map`/`filter` para plano, canal e `comingSoon`, sem reordenar). O grupo `Instagram`
(só com item "em breve", não renderizado) fica entre Campanhas e Operação e não aparece. Conexões e Sistema não existem na sidebar; Configurações, Integrações e Campos personalizados seguem só no menu superior
direito; Webhooks e logs não aparece (o processamento e os registros técnicos não foram tocados).

| Grupo | Itens (ordem) |
|---|---|
| Comunicação | Canal · Recuperação · PIX · Automações · Templates (API Meta) · Mensagens e Fila de envio (WhatsApp Web) |
| Marketing e dados | Meta Ads · Google Ads · Google Analytics 4 · UTM Tracker · Desempenho de produtos · Jornada de compra (os dois últimos com o entitlement `analytics_product_performance`) |
| Criativos | Gerar · Lotes · Histórico · Produtos · Marca e nicho · Contextos · Personas (uma rota por seção, ver abaixo) |
| Campanhas | Todas as campanhas · Segmentos |
| Operação | Pedidos · Clientes · Trocas e devoluções · Estoque · Simular frete |
| Financeiro | Visão financeira · Despesas · Custos de API · Reembolsos |
| Catálogo | Produtos · Categorias · Agrupamentos · Promoções |

## Gerador de criativos por seção (atualização)

Antes o menu tinha um item só (`/admin/criativos`) e as sete seções eram abas de estado interno da página. Agora **cada seção é uma rota com item próprio no menu**:
`/admin/criativos/{gerar,lotes,historico,produtos,marca,contextos,personas}` (fonte: `nav.ts`; ícone próprio por item). `/admin/criativos` redireciona para `/gerar`; uma seção inexistente também volta para Gerar.
A página (`CriativosPage`) lê a seção da rota (`useParams`), mostra título e descrição da seção e **perdeu a barra de abas interna** — o menu lateral é a navegação. Como uma única rota (`:aba`) renderiza a página,
trocar de seção não a remonta: o catálogo carregado, o lote selecionado e os dados copiados de um criativo (Histórico/Lotes → Gerar) continuam valendo; as ações do fluxo (copiar dados → Gerar; lote criado → Lotes)
apenas trocam a rota. O "Produtos" do grupo Criativos é o cadastro do gerador, distinto de Catálogo › Produtos.

## Menus fechados ao carregar (atualização)

Todo carregamento do painel começa com **todos os grupos fechados**: o grupo mostra só o item da página atual (orientação) e abrir um grupo vale enquanto o painel está aberto (estado em memória). A única preferência lembrada em
`oria.shell.nav.v1` passou a ser a sidebar recolhida (`{colapsada}`); grupos não são gravados nem lidos (o formato antigo `gruposFechados` é ignorado). O trilho recolhido continua mostrando todos os ícones.

## Logo oficial

Procurado: `assets/` e `apps/panel/assets/oria/`, `apps/panel/public`, favicons (`apps/platform-admin/public/favicon.svg`, `apps/panel/desktop/assets/icon.png`), `oria.html` e worktrees irmãs.
Oficial e em uso na marca pública: `apps/panel/assets/oria/oria-simbolo.png` (256×202, PNG com transparência, só o símbolo — usado como favicon e `marca__simbolo` em `oria.html`; já servido em
`/assets/oria/oria-simbolo.png` e coberto por `test/arquivos-publicos.test.js`). **Não** foi usado `oria-logo.png` (traz o texto "ORIA" embaixo) nem a logo da loja ativa. Não há SVG oficial no repositório
(o `favicon.svg` é do Oria Admin, outra marca) — a marca oficial disponível é PNG; a pendência é apenas um eventual SVG, sem improvisar arte.

- Expandida: símbolo (35×28, proporção preservada com `object-fit: contain`) à esquerda; `Oria` e `Central operacional` à direita, alinhados verticalmente.
- Recolhida (64 px): só o símbolo, centralizado, com tooltip `Oria`; o nome fica no DOM (recorte visual, não `display:none`) como nome acessível.
- Drawer mobile: mesma identidade e mesmo markup (35×28), dentro da tela.
- O monograma "OR" foi removido. O texto continua vindo de `settings.productName` (padrão "Oria"), como antes.

## Testes e aceite

| Verificação | Resultado |
|---|---|
| `navegacao-painel` (contratos: sequência exata dos grupos, itens por grupo, seções de criativos, ausência de Conexões/Sistema/Webhooks, ordem sob filtro de plano/canal, links válidos, marca, menus fechados) | 29/29 |
| 10 arquivos front/públicos relacionados (navegacao, nav-prefs, modal-foco, integracoes-*, store-escopo, ink-webhook-guia, arquivos-publicos, creative-enrichment) | 98/98 |
| `tsc -b` + build · `ci/suites.mjs verify` (156 arquivos) | limpos / OK |
| Playwright real, 6 viewports (1440, 1280, 1024, 768, 390×844, 360×800): ordem dos grupos, logo, expandida/recolhida/drawer, **grupos fechados ao carregar (e de novo após recarregar)**, abrir/fechar por clique e teclado sem gravar nada, 7 seções de Criativos com destaque correto e redirecionamentos, Marketing e Campanhas destacados | **276/276** |

Capturas (dados sintéticos, fora do git): `apps/panel/relatorios-privados/redesign-shell/{desktop-1440-04-marca-ordem-expandida,desktop-1440-05-marca-recolhida,mobile-390-04-drawer-marca-ordem}.png`.
A suíte integral de 2.283 testes não foi repetida (mudança de ordem de array + marca, sem lógica nova).
