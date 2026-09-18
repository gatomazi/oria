---
name: Painel Operacional
description: Bancada digital de trabalho para lojistas Reserva Ink — densa, sóbria, legível num relance.
colors:
  bg-sidebar: "#070C11"
  bg-app: "#0B121A"
  surface-1: "#111A24"
  surface-2: "#16212D"
  surface-3: "#1B2734"
  control-bg: "#0D151E"
  border-subtle: "rgba(255, 255, 255, 0.06)"
  border-default: "rgba(255, 255, 255, 0.09)"
  border-strong: "rgba(255, 255, 255, 0.14)"
  text-primary: "#F3F6F9"
  text-secondary: "#A9B4C0"
  text-muted: "#8390A0"
  text-disabled: "#566271"
  accent: "#35D07F"
  accent-hover: "#4FD98F"
  accent-pressed: "#29A863"
  on-accent: "#06140C"
  accent-tint: "rgba(53, 208, 127, 0.12)"
  success: "#35D07F"
  success-tint: "rgba(53, 208, 127, 0.14)"
  info: "#34B7EB"
  info-tint: "rgba(52, 183, 235, 0.14)"
  warning: "#F2A516"
  warning-tint: "rgba(242, 165, 22, 0.14)"
  danger: "#FF6B6B"
  danger-solid: "#C93A3A"
  danger-solid-hover: "#B53333"
  danger-tint: "rgba(255, 84, 84, 0.14)"
  premium: "#A78BFA"
  premium-tint: "rgba(139, 92, 246, 0.14)"
  neutral-tint: "rgba(169, 180, 192, 0.12)"
  chart-neutral: "#5C6F84"
typography:
  kpi:
    fontFamily: "DM Sans, Inter, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.01em"
    fontFeature: "\"tnum\" 1"
  page-title:
    fontFamily: "DM Sans, Inter, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.005em"
  section-title:
    fontFamily: "DM Sans, Inter, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  body:
    fontFamily: "DM Sans, Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  body-dense:
    fontFamily: "DM Sans, Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  label:
    fontFamily: "DM Sans, Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "18px"
  caption:
    fontFamily: "DM Sans, Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  micro:
    fontFamily: "DM Sans, Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "14px"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  wordmark:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: "20px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  full: "999px"
spacing:
  "0.5": "2px"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-danger-solid:
    backgroundColor: "{colors.danger-solid}"
    textColor: "#FFFFFF"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  input:
    backgroundColor: "{colors.control-bg}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "36px"
  badge:
    backgroundColor: "{colors.neutral-tint}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.micro}"
    rounded: "{rounded.xs}"
    padding: "0 6px"
    height: "20px"
  panel:
    backgroundColor: "{colors.surface-1}"
    rounded: "{rounded.md}"
    padding: "16px"
  table-row:
    typography: "{typography.body-dense}"
    padding: "0 12px"
    height: "44px"
  table-row-compact:
    typography: "{typography.body-dense}"
    padding: "0 10px"
    height: "40px"
  nav-item:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
  dialog:
    backgroundColor: "{colors.surface-3}"
    rounded: "{rounded.lg}"
    padding: "20px"
    width: "480px"
  drawer:
    backgroundColor: "{colors.surface-3}"
    padding: "20px"
    width: "560px"
  tooltip:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
---

# Design System: Painel Operacional

> **Status:** aprovado em 13/09/2026. Fundação e App Shell implementados (seção 12 de [docs/ui-lapidacao-auditoria.md](docs/ui-lapidacao-auditoria.md)). Valores canônicos em `src/admin/design-system/tokens-base.css` (espelho deste frontmatter); a camada de apelidos (`tokens.css`) foi removida na Fase 9. Página de referência: `/admin/produtos`; contrato de componentes: `/admin/playground`.
>
> **Escopo:** somente o painel admin (`admin/`, `/admin/*`). Site público, `/loja` e hotpage PIX têm identidade própria e não seguem este arquivo.

## Overview

**Creative North Star: "A Bancada de Operação"**

Uma bancada digital de trabalho para quem administra a operação inteira do negócio. Densa sem ser carregada, sóbria e extremamente legível: tudo o que importa fica acessível e compreensível num relance. A interface prioriza **ação, contexto e estado**. Dashboards existem para orientar decisões, não para decorar.

O acabamento é premium e técnico, na linha de precisão de produtos como Linear e Stripe, sem copiar nenhum deles. A personalidade própria vive nos detalhes: o verde operacional usado com parcimônia, números tabulares impecáveis, estados honestos ("Indisponível", "Não configurado") tratados com o mesmo cuidado que os dados. O fundo é dark-first em azul-grafite frio. A profundidade vem de camadas tonais e bordas finas, não de sombras, brilho ou vidro.

A marca da loja (tenant) aparece como **contexto** dentro do produto: nome, wordmark e logo. Ela não define o design system. O SaaS tem identidade tipográfica própria, neutra e consistente.

**Key Characteristics:**
- Dark-first em uma única família de cinzas frios (hue ≈ 210°).
- Uma cor de ação (verde); as demais cores são estritamente semânticas.
- DM Sans em toda a interface; Fraunces só em wordmark do tenant.
- Densidade operacional: controles de 36px, linhas de tabela de 44px, texto de dados de 13px.
- Superfícies planas separadas por tom e borda de 1px; sombra só em overlays.
- Raio contido: 6px em controles, 8px em painéis, 12px só em diálogos.
- Todo componente tem estados default, hover, focus-visible, active, disabled, loading e error.

## Colors

Grafite frio em camadas, um verde de ação e um vocabulário semântico fechado. Cor comunica estado, alerta ou ação importante, nunca enfeite.

### Primary
- **Verde Operacional** (`accent`): ação primária da região (um botão preenchido por contexto), foco de teclado, marcador de seleção e controle ligado (switch, checkbox). Texto sobre ele é sempre `on-accent` (quase preto). Branco sobre este verde tem contraste ≈2:1 e é proibido.
- **Verde Operacional Hover / Pressed** (`accent-hover`, `accent-pressed`): no dark, o hover clareia e o pressionado escurece.

### Secondary
- **Ciano Informativo** (`info`): informação neutra-positiva e o que está em movimento (produção, despachado, em trânsito, sincronizando). Também é a série padrão de gráficos de volume.

### Tertiary
- **Violeta Plano** (`premium`): exclusivo para plano, recurso pago e upgrade. Nunca aparece como série de gráfico, ícone de KPI ou decoração.

### Semantic
- **Verde Sucesso** (`success`): pago, entregue, conectado, aprovado. Tem o mesmo valor do accent, mas papel e forma diferentes: sucesso aparece como texto, ponto ou badge tintado, **nunca** como superfície preenchida.
- **Âmbar Atenção** (`warning`): aguardando, pendente, PIX em aberto, ação necessária não crítica.
- **Vermelho Crítico** (`danger`): falha, recusado, erro, desconectado, destrutivo. Em texto e ícones sobre fundo escuro usa-se `danger`. Botão destrutivo preenchido, só dentro de diálogo de confirmação, usa `danger-solid` com texto branco (≈5:1).
- **Tints** (`*-tint`): fundo de badge, destaque de linha e ícone em estado. Sempre com opacidade de 14% sobre a superfície.

### Neutral
- **Grafite Sidebar** (`bg-sidebar`): a camada mais escura, só na navegação lateral.
- **Grafite Base** (`bg-app`): fundo da área de conteúdo.
- **Painel** (`surface-1`): painéis, tabelas e seções emolduradas.
- **Painel Sutil** (`surface-2`): cabeçalho de tabela quando necessário, item ativo da navegação, chips, blocos internos, botão secundário.
- **Painel Elevado** (`surface-3`): drawer, diálogo, dropdown, tooltip e toast. É tudo o que flutua.
- **Controle** (`control-bg`): fundo de input, select e textarea, mais recuado que o painel. Assim o campo é legível dentro de qualquer superfície.
- **Bordas** (`border-subtle`, `border-default`, `border-strong`): divisórias internas, contorno de painel/controle e hover/controle ativo, nessa ordem.
- **Texto** (`text-primary`, `text-secondary`, `text-muted`, `text-disabled`): dado e título; rótulo e descrição; metadado e hint (≥4.5:1 em `surface-1..3`); desabilitado (não carrega informação).
- **Gráfico Neutro** (`chart-neutral`): série de comparação, período anterior, "outros".

### Named Rules
**The One Green Rule.** Por região de tela existe no máximo um elemento preenchido de verde, que é a ação primária. Navegação ativa, links, sucesso e gráficos não usam verde preenchido.

**The Semantic-Only Rule.** Ciano, âmbar, vermelho e violeta só aparecem quando representam o estado que nomeiam. Ícone de KPI, cabeçalho de seção e série decorativa não recebem cor.

**The Same-Status Same-Color Rule.** Um status tem um único rótulo e uma única cor em todo o produto, resolvidos por `src/lib/statusMap.ts`. Rótulo cru da API (`paid`, `waiting_payment`) nunca chega à tela.

## Typography

**Body Font:** DM Sans (fallback: Inter, system-ui, sans-serif)
**Wordmark Font:** Fraunces (fallback: Georgia, serif). Restrita a wordmark ou assinatura do tenant.

**Character:** Uma sans humanista e neutra que carrega título, rótulo, dado e botão. A hierarquia vem de tamanho e peso em passos curtos (razão ≈1.15), não de fontes decorativas. Números são sempre tabulares onde se comparam valores.

### Hierarchy
- **KPI** (600, 28px/32px, -0.01em, tabular): valor principal de métrica. No máximo uma faixa de KPIs por página.
- **Page Title** (600, 22px/28px): título da página no `PageHeader`. Um `h1` por página, sempre presente.
- **Section Title** (600, 15px/22px): título de painel, seção de formulário, drawer e diálogo (diálogo pode usar 16px).
- **Body** (400, 14px/20px): texto de interface, valor de input, descrições de página. Prosa limitada a 72ch.
- **Body Dense** (400, 13px/18px): células de tabela, listas densas, itens de dropdown, conteúdo de drawer.
- **Label** (500, 13px/18px): rótulo de campo, botão, aba, item de navegação, cabeçalho de tabela (12px/500 em `text-secondary`).
- **Caption** (400, 12px/16px): hint de campo, metadado de linha, legenda de gráfico, timestamp.
- **Micro** (500, 11px/14px): badge e contador. Nunca como texto corrido.

### Named Rules
**The Three Weights Rule.** Pesos permitidos: 400, 500 e 600. Os pesos 620, 650 e 700 saem do sistema.

**The Sentence Case Rule.** Rótulos, grupos da navegação, badges e botões usam caixa de sentença. Maiúsculas espaçadas ficam proibidas, inclusive "EM BREVE" e grupos da sidebar.

**The Tabular Numbers Rule.** Tabela, KPI, valor monetário, contagem, data e ID de pedido usam `font-variant-numeric: tabular-nums`. Valores numéricos em coluna alinham à direita.

**The Wordmark Only Rule.** Fraunces nunca aparece em título, navegação, card, tabela, métrica, formulário ou conteúdo operacional.

**The Code Literal Rule.** Monoespaçada (`--font-mono`, 12px) só para literal técnico que o usuário copia ou compara caractere a caractere — nome de variável de ambiente, código Pix, nome de evento — e para o preview da formatação ```mono``` do WhatsApp. Nunca para rótulo, ID de pedido ou dado de tabela (esses usam DM Sans tabular).

## Layout

**Estrutura do app.** Sidebar fixa de 240px (`bg-sidebar`) + área de conteúdo. A área de conteúdo tem uma **barra superior de 56px** (sticky, `bg-app` com borda inferior `border-subtle`) com contexto (voltar/breadcrumb quando a página é filha), ações globais reais e menu da loja. Abaixo dela vem o conteúdo da página.

**Container.**
- Gutter lateral: 16px (<768px), 24px (768–1279px), 32px (≥1280px).
- Largura máxima do conteúdo: 1600px, alinhado à esquerda, sem centralizar a página inteira.
- Formulários de criação e edição: coluna de campos com máximo de 720px. Em ≥1280px um resumo ou prévia lateral pode ocupar coluna própria de 320–400px (ex.: prévia de template, revisão de campanha).

**Anatomia de página (ordem fixa).**
1. `PageHeader`: título (22px), descrição opcional em uma linha e ações à direita (uma primária no máximo). Página filha mostra link de volta acima do título.
2. Alertas da página (`Callout`), se houver.
3. Faixa de KPIs, se a página tiver métricas.
4. Toolbar de filtros.
5. Conteúdo principal (tabela, painéis, formulário).

**Ritmo vertical.** A página é uma pilha (`PageStack`) com `gap` de 24px entre blocos. Dentro de painel, 16px entre grupos e 12px entre itens relacionados. Campos de formulário ficam a 16px entre si, e o rótulo fica a 6px do controle. Espaço entre blocos nunca depende de margem de componente individual.

**Grids respondem à largura do conteúdo, não da viewport.** Grids de KPI e painel usam `repeat(auto-fit, minmax(<min>, 1fr))` ou container queries sobre a área de conteúdo. Media queries por viewport só controlam o shell (sidebar, gutter, barra superior).

**Breakpoints do shell:**
- `<1024px`: sidebar vira drawer com botão na barra superior (sem sobreposição ao conteúdo) e ação de fechar.
- `≥1024px`: sidebar fixa.
- `≥1280px`: gutter de 32px e colunas laterais de resumo.

**Responsividade de dados.** Em telas estreitas a tabela mantém rolagem horizontal dentro do próprio painel (nunca na página), com a primeira coluna fixa. Toolbars quebram em linhas com controles de largura total. Controles de 36px sobem para 40px em `pointer: coarse`.

### Named Rules
**The Stack Owns Spacing Rule.** Componentes não têm margem externa. A distância entre blocos é do contêiner (`PageStack`, `Stack`, grid `gap`).

**The Content-Width Rule.** Nenhuma grade assume a largura da viewport. Em 1024px com sidebar, o conteúdo tem cerca de 750px e tudo precisa caber sem overflow horizontal.

## Elevation & Depth

Sistema plano com camadas tonais. `bg-sidebar` < `bg-app` < `surface-1` < `surface-2` < `surface-3`: quanto mais clara a superfície, mais "à frente" ela está. Painéis em repouso não têm sombra, e a borda de 1px faz a separação. Sombra existe apenas para o que flutua sobre o conteúdo (drawer, diálogo, dropdown, tooltip, toast), sempre com deslocamento e desfoque suaves. O scrim escurece o fundo o suficiente para tirar o conteúdo de foco.

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 12px 32px rgba(3, 7, 11, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06)`): diálogo, drawer, dropdown, toast.
- **Tooltip** (`box-shadow: 0 4px 12px rgba(3, 7, 11, 0.45)`): tooltip e popover pequeno.
- **Scrim** (`background: rgba(3, 7, 11, 0.64)`): fundo atrás de diálogo e drawer.
- **Focus Ring** (`outline: 2px solid #35D07F; outline-offset: 2px`): foco de teclado em todo elemento interativo, via `:focus-visible` global. Inputs usam borda `accent` + `box-shadow: 0 0 0 1px` no `:focus` (também com mouse).

### Named Rules
**The Flat-At-Rest Rule.** Nada que está no fluxo da página tem sombra. Glow, gradiente decorativo, glassmorphism e `backdrop-filter` estão fora do sistema.

**The No Nesting Rule.** Painel dentro de painel é proibido. Dentro de um painel, a subdivisão é feita com `Section` (título + divisória `border-subtle`) ou bloco em `surface-2` sem borda.

## Shapes

Geometria contida e técnica. Cantos arredondados só o bastante para suavizar, sem cápsulas.

- **4px** (`xs`): badge, checkbox, chip de variável, tag.
- **6px** (`sm`): botão, input, select, item de navegação, tab segmentada, tooltip, item de dropdown.
- **8px** (`md`): painel, tabela, dropdown, toast, callout, bloco interno.
- **12px** (`lg`): diálogo. O drawer encosta na borda da tela, sem raio.
- **999px** (`full`): somente avatar, ponto de status e trilho de switch.

Bordas: 1px sempre. Tracejado só para zona de upload. Ícones: um único conjunto SVG com traço de 1.75px, em 16px (inline e navegação) ou 20px (estados vazios). Glifos Unicode (☰, ?, •, ×, ↑↓, →) nunca fazem papel de ícone.

### Named Rules
**The No Pill Rule.** Botão, input, busca, seletor de loja, stepper e badge não usam raio de cápsula.

## Components

### Buttons
Firmes e discretos. Quem indica prioridade é a hierarquia, não o tamanho.
- **Shape:** 6px de raio, 36px de altura (sm 32px em toolbars e linhas de tabela, lg 40px em `pointer: coarse`), padding horizontal de 14px, ícone opcional de 16px com gap de 6px.
- **Primary:** fundo `accent`, texto `on-accent`, 13px/500. Um por região.
- **Secondary:** fundo `surface-2`, borda `border-default`, texto `text-primary`. É a ação padrão.
- **Ghost:** transparente, texto `text-secondary`. Serve para ação terciária, "Limpar filtros" e cancelar em toolbar.
- **Danger:** fundo `danger-tint`, texto `danger`, borda `danger` a 30%. Ação destrutiva fora de confirmação.
- **Danger Solid:** fundo `danger-solid`, texto branco. Só no botão de confirmar de `ConfirmDialog` destrutivo.
- **States:** hover clareia um degrau (primary → `accent-hover`, secondary → borda `border-strong`). Active usa `accent-pressed` ou `surface-3`. `:focus-visible` usa o Focus Ring. Disabled fica em `surface-2`, texto `text-disabled`, sem opacidade sobre a cor original. Loading troca o ícone por spinner de 14px, mantém a largura e desabilita o botão.
- **Link:** texto `accent`. Link dentro de texto corrido fica sempre sublinhado (sublinhado translúcido, cheio no hover) para não depender só da cor. Não usa seta Unicode; se precisar, usa ícone SVG.

### Inputs / Fields
- **Style:** fundo `control-bg`, borda `border-default`, 6px de raio, 36px de altura, texto 14px, placeholder `text-muted`. Textarea tem mínimo de 88px e padding de 8px 10px.
- **Field:** rótulo (Label 13px/500 `text-secondary`) associado ao controle por `htmlFor`/`id`, controle, hint (Caption `text-muted`) e erro (Caption `danger`). Obrigatório marcado no rótulo; opcional marcado como "(opcional)".
- **Hover:** borda `border-strong`. **Focus:** borda `accent` + Focus Ring.
- **Error:** borda `danger` e mensagem abaixo, com `aria-invalid` e `aria-describedby`. **Disabled:** texto `text-disabled`, sem hover.
- **Select:** mesmo invólucro do input, com chevron SVG próprio e `color-scheme: dark`. Um componente `Select` substitui os `<select>` crus.
- **Search:** input com ícone de lupa à esquerda e botão de limpar quando preenchido.
- **Switch / Checkbox:** trilho `surface-3` → `accent` quando ligado; checkbox 16px com raio de 4px.
- **Agrupamento:** formulários longos são divididos em `Section` com título de 15px, sem um painel por grupo.
- **Estrutura (`FormStack`):** coluna de até 720px (`form-max`) com 16px entre campos; `FormGrid` põe campos curtos lado a lado e cai pra uma coluna quando não cabem; `wide` só para editores com preview lateral.
- **Ações (`FormActions`):** última linha do formulário. Primária à direita; secundária ou destrutiva (Voltar, Excluir) à esquerda. Assistentes usam a mesma barra abaixo do painel da etapa. Botão dentro de coluna nunca estica (`align-self: flex-start`), exceto em login.
- **Erro de envio:** parágrafo `ds-form-error` com `role="alert"` logo acima das ações, só renderizado quando existe.
- **Resultado:** o que o formulário gera (link de pagamento, vínculo) aparece num `Callout` `success` com a ação de copiar, não num bloco solto.
- **Escolha em cartões:** opções mutuamente exclusivas com descrição usam a anatomia do radio card — fundo `control-bg`, borda `border-default`, selecionado com borda `accent` + `accent-tint`, foco pelo `:has(input:focus-visible)`. Chips de seleção múltipla seguem o mesmo estado selecionado.
- **Em diálogo:** o corpo do `Modal` dá 16px entre blocos por margem entre irmãos (texto e `<strong>` soltos continuam em linha). No celular o diálogo mantém 16px de respiro lateral.
- **Lista editável dentro de painel:** itens são linhas separadas por `border-subtle`, não cards aninhados.

### Status Badge
- **Style:** 20px de altura, raio de 4px, padding de 0 6px, Micro 11px/500, fundo `*-tint`, texto na cor do tom. Ponto de 6px opcional para status "vivo" (conectado, enviando).
- **Tons:** `success` | `info` | `warning` | `danger` | `neutral` (`neutral-tint` + `text-secondary`, visível também sobre linha em hover) | `premium`.
- **Fonte única:** rótulo e tom vêm sempre de `statusMap.ts`. "Pendente" de configuração é `warning`, nunca `danger`.

### Panel (Card)
- **Corner Style:** 8px.
- **Background:** `surface-1`, com borda `border-default`. Sem sombra.
- **Header:** 48px, título Section Title e ações à direita (secondary/ghost sm). Divisória `border-subtle` só quando o corpo é tabela ou lista.
- **Internal Padding:** 16px. Painéis de formulário usam 20px. O corpo sempre tem padding superior, com ou sem título.
- **Variante `flush`:** corpo sem padding, para tabela ou lista que encosta nas bordas. A tabela dentro dela não tem borda própria.
- **Quando usar:** para agrupar conteúdo com ação ou título próprios. Uma lista de páginas de atalho não precisa virar grade de cards.

### KPI Strip
- **Estrutura:** um único painel dividido em células por divisórias verticais `border-subtle`, e não N cards soltos. As células usam `auto-fit` com mínimo de 180px e quebram em 2 colunas no mobile.
- **Célula:** rótulo 12px/500 `text-secondary`, valor KPI 28px tabular e rodapé Caption com delta em badge semântica e contexto ("vs. ontem"). Ícone é opcional, monocromático (16px, `text-muted`) e sem ladrilho colorido.
- **Sparkline:** só com série real de 2+ pontos, traço de 1.5px em `info` ou `chart-neutral`. Sem dado não há linha: nada de sparkline plana.
- **Posição e quebra:** sparkline (56×18) fica na linha do rótulo, à direita, e some quando a célula tem menos de 220px (container query). Em célula com menos de 150px o rótulo pode ocupar 2 linhas (altura reservada em todas, pra os valores ficarem alinhados) e o valor cai para 22px. No mobile a faixa tem 2 colunas e uma última célula ímpar ocupa a linha inteira.
- **Tom:** `tone` não pinta a célula. A única cor é a do delta (`success-tint`/`danger-tint`).

### Data Table
- **Estrutura:** dentro de Panel `flush`. Cabeçalho de 36px, 12px/500 `text-secondary`, fundo transparente, borda inferior `border-default`, sticky no scroll da página.
- **Linhas:** 44px (padrão) e 40px (modo compacto opcional). Células 13px com padding horizontal de 12px e divisória `border-subtle`. Hover em `surface-2`. Selecionada em `accent-tint`. Linha clicável tem `cursor: pointer`, foco de teclado e abre drawer.
- **Alinhamento:** texto à esquerda, números, valores e datas à direita com números tabulares, status em badge. Texto longo trunca com reticências e tooltip, sem quebrar a linha em duas.
- **Ordenação:** só em colunas onde faz sentido (data, valor, nome). Ícone SVG só aparece na coluna ordenada ou no hover do cabeçalho.
- **Rodapé:** contagem ("163 pedidos") à esquerda e paginação à direita, com botões secondary sm.
- **Mobile (<600px):** colunas marcadas `priority: 'low'` saem; ficam 2–3 colunas essenciais (identidade, valor, status) e o resto vive no drawer. Cabeçalho pode quebrar em 2 linhas, status longo quebra dentro do badge, larguras fixas de desktop são ignoradas. Se ainda sobrar largura, a tabela rola dentro do painel com sombra na borda indicando continuação.
- **Teclado:** linha clicável recebe foco (Tab) e abre com Enter/Espaço.
- **Estados:** o carregamento mostra 8 linhas skeleton de 44px. A lista vazia aparece dentro do corpo da tabela, com cabeçalho visível. O erro aparece no corpo, com botão "Tentar novamente".
- **Ordenação padrão:** listas temporais abrem ordenadas pela data mais recente (`defaultSort`), com o indicador visível no cabeçalho. Coluna de ações/miniatura sem título visível tem rótulo só para leitor de tela.

### Toolbar de filtros
- **Estrutura:** uma linha acima da tabela com gap de 8px e controles sm/36px, nesta ordem: busca (240px), selects de filtro, período, "Limpar filtros" (ghost, só quando há filtro ativo). Contagem de resultados e ações de visualização ficam à direita.
- **Notas contextuais:** "Todas as lojas — resultado aproximado" vira Callout `info` compacto ou tooltip, e não linha de texto solta.

### Tabs
- **Style:** abas sublinhadas, 36px de altura, Label 13px/500 `text-secondary`. A ativa fica em `text-primary` com barra inferior de 2px `accent`, sobre a divisória `border-default`. Contador opcional em badge `neutral`.
- **Segmented:** para alternar visualização ou período, grupo de botões em `surface-2` com raio de 6px. A opção ativa fica em `surface-3`.
- **Implementação:** `TabList` (barra controlada, `role="tablist"`, setas ←/→, Home/End) ou `Tabs` (barra + painel). Abas nunca são montadas à mão com `.ds-tab`.

### Stepper (assistentes)
- **Style:** linha horizontal de etapas numeradas (círculo de 20px + rótulo 13px). Concluída tem check `success`, atual fica em `text-primary` com círculo `accent`, futura fica em `text-muted`. Conectores de 1px `border-default`. Sem cápsulas.
- **Rodapé do assistente:** barra de ações ao fim da coluna do formulário, com "Voltar" (ghost) à esquerda e "Continuar" (primary) à direita, alinhados à largura do formulário e não da página.

### Navigation (Sidebar)
- **Style:** 240px, `bg-sidebar`, borda direita `border-subtle`, padding de 12px. Topo com tenant (logo ou iniciais em quadrado de 28px `surface-3` + nome em Label 14px/600, ou wordmark do tenant em Fraunces), seguido do nome do produto em Caption.
- **Itens:** 32px, ícone SVG de 16px `text-muted`, Label 13px/500 `text-secondary`, raio de 6px. Hover `surface-2`. Ativo tem fundo `surface-2`, texto `text-primary` e ícone `accent`, sem faixa colorida lateral nem borda verde.
- **Grupos:** rótulo Caption 12px/500 `text-muted` em caixa de sentença, com 16px acima e 4px abaixo. Grupos longos podem recolher.
- **Não construídos:** itens "em breve" ficam **ocultos**. Funcionalidade inexistente não ocupa a navegação.
- **Ações não são navegação:** "Nova campanha" é ação de página, não item de menu.
- **Mobile:** drawer de 280px com scrim, botão de fechar no topo e foco preso. O botão de menu fica na barra superior e não sobrepõe a sidebar.

### Top Bar
- **Style:** 56px, sticky, com borda inferior `border-subtle`. Esquerda: botão de menu (<1024px) e contexto da página filha. Direita: menu da loja (logo ou iniciais em 28px + nome da loja) com Configurações, Integrações e "Sair". Não há usuário pessoal: o produto é 1 licença = 1 loja, sem multiusuário. O seletor de loja (Select sm) aparece só no modo multi-loja da instalação interna.
- **Honestidade:** busca global, ajuda e notificações ficam **ocultas** até existirem. Placeholder desabilitado não ocupa espaço nobre.

### Dialog
- **Style:** `surface-3`, raio de 12px, sombra Overlay, largura de 480px (sm 400px, lg 640px), padding de 20px. Título 16px/600, descrição Body `text-secondary` e ações alinhadas à direita no rodapé (cancelar ghost, confirmar primary ou danger-solid).
- **Uso:** confirmação destrutiva, decisão que bloqueia o fluxo ou formulário curto (≤4 campos). Todo o resto é página ou drawer.

### Drawer
- **Style:** `surface-3`, 560px (lg 720px), sem raio, sombra Overlay. Cabeçalho sticky de 56px com título, badges de status e fechar (ícone SVG). Corpo com padding de 20px e rodapé sticky com ações.
- **Ações:** ação destrutiva (ex.: Reembolsar) nunca é o primeiro botão preenchido do topo. Ela fica no rodapé como `danger` ou no menu de mais ações.
- **Conteúdo:** pares chave–valor em grade de 2 colunas (rótulo Caption `text-muted`, valor Body Dense), formatados (telefone, moeda, forma de pagamento com rótulo humano). Documento (CPF/CNPJ) aparece mascarado (`•••.456.789-••`), com ação "Mostrar" para revelar.

### Dropdown Menu
- **Style:** `surface-3`, borda `border-default`, raio de 8px, padding de 4px, sombra Overlay, mínimo de 180px. Itens de 32px, 13px, raio de 6px, ícone opcional de 16px e atalho em `text-muted` à direita. Item destrutivo em `danger`, separado por divisória.

### Tooltip
- **Style:** `surface-3`, borda `border-default`, raio de 6px, Caption 12px `text-secondary`, máximo de 280px, atraso de 300ms. Só explica. Não carrega ação nem informação essencial.

### Toast
- **Style:** `surface-3`, borda `border-default`, raio de 8px, sombra Overlay, largura de 360px, canto inferior direito. Ícone semântico de 16px na cor do tom, texto Body Dense `text-primary`, ação opcional ("Desfazer", "Ver") e fechar. Sem fundo saturado nem faixa lateral colorida.
- **Política:** toast confirma o resultado de uma ação do usuário ("Campanha pausada"). Sucesso some em 5s. Erro fica até fechar. Falha de carregamento de página nunca vira toast: vira ErrorState ou Callout no lugar do conteúdo.
- **Copy:** nomeia o problema e a recuperação na linguagem do lojista. Nome de variável de ambiente, SQL ou stack nunca aparecem.

### Callout (alerta de página)
- **Style:** raio de 8px, fundo `*-tint`, borda de 1px na cor do tom a 30%, ícone de 16px na cor do tom, título Label 13px/600 `text-primary`, descrição Caption `text-secondary` e ação secondary sm à direita. Sem faixa lateral grossa.
- **Uso:** situação que pede decisão agora (pagamentos com problema) em `warning`/`danger`, e oportunidade (carrinhos recuperáveis) em `info`. Vários alertas se agrupam em uma lista única, não em N banners empilhados.

### Empty State
- **Style:** dentro do contêiner que ficaria preenchido (corpo da tabela, painel), com ícone SVG de 20px `text-muted`, título Label 14px/600, descrição Caption `text-secondary` (máximo de 48ch) e uma ação. Centralizado só dentro do contêiner, nunca solto no vazio da página.
- **Variantes:**
  - Primeiro uso: ensina o que aparecerá e oferece a ação de criar.
  - Sem resultados: mostra os filtros ativos e "Limpar filtros".
  - Não configurado: explica e leva a Integrações.
  - Indisponível: diz honestamente por que o dado não existe.
- **Ação única:** se o cabeçalho da página já tem a ação primária (ex.: "Nova campanha"), o vazio oferece a mesma ação como `secondary` ("Criar campanha") — nunca dois botões verdes.
- **Densidade:** dentro de painel ou drawer o estado é compacto (24px de respiro); solto na página, 48px.

### Loading State
- **Skeleton** com a forma do conteúdo final: `variant="table"` (cabeçalho de 36px + linhas de 44px com colunas de larguras variadas) em listas, blocos com a altura da faixa de KPI e dos painéis no Dashboard, linhas simples em formulários. Brilho deslizante de 1.4s em `surface-3`, estático com `prefers-reduced-motion`. O `PageHeader` renderiza antes do dado.
- **Shell:** sidebar e barra superior renderizam imediatamente com skeleton do nome do tenant. A tela nunca fica em branco enquanto as configurações carregam.
- **Progresso:** componente `ProgressBar` (trilho `surface-2`, preenchimento `info` ou `accent`, animação por `transform: scaleX`) com rótulo "38 de 120".

### Error State
- **Página ou painel:** ícone `danger`, título "Não foi possível carregar pedidos", causa em linguagem do lojista e "Tentar novamente" (secondary). O restante da página continua utilizável.
- **Campo:** mensagem abaixo do controle. **Ação:** toast de erro com recuperação.
- **Política de toast** (`api/client.ts` + `lib/toast.ts`): só falha de **ação** (POST/PUT/PATCH/DELETE) vira toast; falha de **carregamento** (GET) aparece no lugar do dado, com "Tentar novamente". Se a tela já mostra o mesmo erro junto do controle (`ds-form-error`, `role="alert"`), o toast não aparece. A mesma mensagem nunca empilha duas vezes. No celular os toasts descem do topo, sem cobrir ações de diálogo.

### Charts
- **Style:** grade horizontal `border-subtle`, eixos Caption 11–12px `text-muted`, sem linha de eixo vertical, rótulos monetários abreviados ("R$ 20 mil"). A área de plotagem nunca corta rótulos.
- **Cor:**
  - Série única em `info`.
  - Comparação em `chart-neutral`.
  - Status mapeados ao tom semântico do estágio (pago/entregue `success`, produção/trânsito `info`, aguardando `warning`, problema `danger`), no máximo 5 fatias. O restante vira "Outros" em `chart-neutral`.
  - Estágios vizinhos no mesmo tom se distinguem por opacidade decrescente (ex.: produção 100%, despachado 72%, trânsito 50%, entrega 32% de `info`), nunca por cor decorativa. Legenda só lista fatias com valor.
  - Volume + valor no mesmo gráfico: volume em barras `chart-neutral`, valor em linha `info`, legenda no cabeçalho do painel.
- **Fonte única:** cores, grade, eixos e formatação monetária curta vêm de `lib/chartTheme.ts`. Gráficos não animam na entrada.
- **Tooltip:** padrão Tooltip com valores tabulares.

### Motion
- **Função, não enfeite.** Movimento só responde a uma ação ou mostra o que mudou: abrir/fechar overlay (diálogo, drawer, menu, tooltip), aviso que chega (toast), disclosure que expande, hover/foco de controle. Conteúdo de página, cards, KPIs e gráficos não animam na entrada.
- **Tokens:** `--motion-fast` 120ms (hover, foco, menu, tooltip), `--motion-base` 180ms (diálogo, toast), `--motion-slow` 240ms (drawer, navegação mobile), `--motion-exit` 120ms (toda saída). Entrada em `--ease-out`, saída em `--ease-in`. Deslocamentos curtos (4–32px) e `scale` mínimo (0.97–0.98); só `transform` e `opacity`.
- **Saída mais curta que a entrada** e com os mesmos keyframes invertidos (`data-state="closed"` do Radix segura o desmonte até a animação terminar).
- **Diálogo centralizado** usa keyframes que preservam o `translate(-50%, -50%)`; nunca um `scale()` genérico por cima de um posicionamento por transform.
- **Movimento reduzido:** `prefers-reduced-motion: reduce` zera animações e transições no painel inteiro (regra global em `tokens-base.css`); o estado final aparece na hora.

## Do's and Don'ts

### Do:
- **Do** usar `on-accent` (#06140C) como texto de qualquer superfície verde preenchida.
- **Do** resolver distância entre blocos com `PageStack` (gap de 24px) e deixar componentes sem margem externa.
- **Do** manter um `h1` por página via `PageHeader`, inclusive em páginas de criação e assistentes.
- **Do** alinhar números à direita com `tabular-nums` em tabelas, KPIs e valores monetários.
- **Do** tirar rótulo e cor de status sempre de `statusMap.ts`.
- **Do** mostrar estados honestos ("Indisponível", "Não configurado") com o mesmo acabamento dos dados.
- **Do** dimensionar grades pela largura do conteúdo (`auto-fit`/container queries) e verificar 1024px com sidebar aberta.
- **Do** usar o Focus Ring em todo elemento interativo via `:focus-visible`.
- **Do** escrever erros como problema + recuperação, na linguagem do lojista.

### Don't:
- **Don't** colocar texto branco sobre o verde `#35D07F` ou sobre `#FF5454`, porque ambos reprovam contraste AA.
- **Don't** aninhar painel dentro de painel nem pôr borda de tabela dentro de painel com borda.
- **Don't** usar glow, gradiente decorativo, glassmorphism, `backdrop-filter` ou sombra em elemento em repouso.
- **Don't** usar raio de cápsula em botão, input, busca, seletor, stepper ou badge.
- **Don't** colorir ícone de KPI, cabeçalho ou série de gráfico sem significado de estado. Violeta só significa plano/premium.
- **Don't** usar maiúsculas espaçadas em rótulos, grupos de navegação ou badges.
- **Don't** usar glifos Unicode (☰, ?, •, ×, ↑↓, →) como ícone.
- **Don't** usar Fraunces fora do wordmark do tenant, nem pesos 620/650/700.
- **Don't** disparar toast para falha de carregamento, nem expor variável de ambiente, SQL ou enum cru da API na interface.
- **Don't** mostrar controles decorativos ou não implementados (busca desabilitada, ajuda e notificações sem função) em posição nobre.
- **Don't** criar tokens com novos prefixos (`--ds-*`, `--surface-*` paralelos). Existe um único namespace de tokens.
- **Don't** estilizar com `style={{}}` inline valores que pertencem ao sistema (cor, espaçamento, tipografia, raio).
