# Checklist obrigatório — tela ou feature nova no admin

> Use em toda tela, formulário, modal, drawer ou funcionalidade nova sob `admin/src/`. Nasceu da
> lapidação de UI em 9 fases (13/09/2026) — cada item aqui corrigiu um problema real encontrado
> numa tela existente. O raciocínio completo de cada fase está em
> `docs/ui-lapidacao-auditoria.md` §12–19; o contrato visual (tokens, anatomia de componente,
> regras nomeadas) está em `DESIGN.md`. Esta página é a versão "cole e confira".
>
> Regra maior, acima de qualquer item abaixo: **a interface muda, o negócio não** — nunca alterar
> rota, contrato de API, regra de negócio ou texto de mensageria ao cliente pra resolver um item
> daqui.

## Antes de escrever código

- [ ] Existe uma tela parecida já migrada? Copie a anatomia dela (`PageHeader` → filtros →
      conteúdo → paginação) em vez de inventar uma nova estrutura.
- [ ] Vai ter lista? Decida agora quais colunas são essenciais (ficam no celular) e quais são
      `priority: 'low'` (somem abaixo de 600px, mas continuam no drawer/detalhe).
- [ ] Vai ter formulário? Decida se cabe em `FormStack` simples ou precisa de `FormSection`
      (seções com título) — nunca um painel por campo.
- [ ] Vai ter estado que muda sozinho (polling, job em andamento, sincronização)? Desenhe
      loading → erro → vazio antes de codar só o caminho feliz.

## Componentes — use o que já existe, nunca HTML cru

| Precisa de | Use | Nunca |
|---|---|---|
| select | `Select` | `<select>` cru, nem com `className="ds-select"` |
| input texto/número | `Input` | `<input>` cru |
| texto longo | `Textarea` | `<textarea>` crua |
| checkbox solto | `Checkbox` (ou `.ds-check-row` numa lista) | `<input type="checkbox">` sem invólucro |
| liga/desliga imediato | `Switch` | checkbox fingindo de switch |
| escolha exclusiva com descrição | `RadioCardGroup` | linha de `<input type="radio">` cru |
| texto que expande | `Disclosure` | `<details>` cru estilizado na mão |
| CPF/CNPJ/token/documento | `MaskedValue` | valor completo sempre visível |
| aviso de página | `Callout` (tone certo) | parágrafo vermelho solto |
| número de resumo | `KpiCard` dentro de `KpiStrip` | card solto com ícone colorido |
| carregando | `Skeleton` (`variant="table"` pra lista) | spinner genérico ou nada |
| lista vazia | `EmptyState` com ação | texto solto "nenhum resultado" |
| falha ao carregar | `ErrorState` com `onRetry` | toast sozinho, página em branco |
| confirmação destrutiva | `ConfirmDialog` (`danger-solid`) | `window.confirm` |
| ajuda contextual | `InfoTooltip` | `title=""` do HTML |
| rótulo + controle | `Field` (associa o `label` sozinho) | `<label>` solto sem `htmlFor` |

Contrato de cada componente, com exemplo ao vivo, em `/admin/playground`.

## Estrutura de página

- [ ] Um `PageHeader` com `title` real — nunca um link de "Voltar" solto fora do componente.
- [ ] Página inteira dentro de `PageStack` — nunca `margin-top`/`marginBottom` avulso entre blocos
      (a pilha é dona do espaçamento vertical).
- [ ] Página filha de outra usa `back={{ to, label }}` no `PageHeader`.
- [ ] Uma ação primária só, em `actions` do `PageHeader` — nunca dois botões verdes na mesma tela
      (cabeçalho **e** estado vazio repetindo "Nova X": o vazio usa `secondary`).

## Tabelas e listas

- [ ] `DataTable` com `label` (nome acessível) — nunca uma `<table>` própria.
- [ ] Números, datas e valores com `align: 'right'`; texto longo com `truncate` + `width`.
- [ ] Toda coluna decide `priority: 'low'` se for dado de apoio (sai no celular; o detalhe
      completo mora no drawer).
- [ ] Ordenação: marque `sortValue` só onde faz sentido ordenar. Se a lista pagina no servidor,
      use `sort`/`onSortChange` controlado — **nunca** deixe o `DataTable` ordenar sozinho uma
      lista paginada (achado real: ordenar reordenava só a página carregada, não o histórico —
      Fase 3, corrigido movendo a ordenação pro Postgres).
- [ ] Status vem de `statusMap.ts` (rótulo + tom) — nunca uma cor decidida na tela.
- [ ] Linha clicável mantém `onKeyDown` (Tab + Enter/Espaço abre) — não sobrescreva `onRowClick`
      sem preservar o comportamento de teclado que o componente já dá.

## Formulários

- [ ] `FormStack` → `FormGrid` (campos curtos lado a lado) → `FormActions` (primária à direita,
      Voltar/Excluir à esquerda).
- [ ] Erro de envio: parágrafo `ds-form-error` com `role="alert"`, só renderizado quando existe.
- [ ] Resultado da ação (link gerado, id criado) em `Callout` `tone="success"` com a ação de
      copiar — nunca um `<div>` improvisado.
- [ ] Não force `block` no botão de submit — a coluna do formulário já evita que ele estique.

## Estados (carregando / vazio / erro)

- [ ] Skeleton com a forma do conteúdo final (`variant="table"` pra lista); `PageHeader` sempre
      renderiza antes do dado — nunca a tela inteira em branco enquanto carrega.
- [ ] `EmptyState` explica o que vai aparecer ali e como preencher — nunca "Nenhum resultado"
      sozinho.
- [ ] `ErrorState` com `onRetry` chamando a mesma função de carregar.
- [ ] GET que falha nunca dispara toast por padrão — `api()` decide isso pelo método HTTP. Se
      precisar forçar, passe `{ toast: true }` explicitamente e justifique no código.
- [ ] Ação (POST/PUT/PATCH/DELETE) que falha: deixe a mensagem aparecer inline no formulário ou
      diálogo — o toast se cancela sozinho se achar o mesmo texto já visível na tela.

## Cor e status

- [ ] Nenhuma cor literal (`#hex`, `rgb()`) fora de `tokens-base.css` — sempre `var(--token)`.
- [ ] Um badge, um tom: sucesso/info/aviso/perigo/neutro/premium só vêm de `statusMap.ts`; o
      mesmo status usa sempre a mesma cor em qualquer tela nova.
- [ ] Verde é ação primária e sucesso, ponto — não decore ícone, avatar ou cabeçalho com verde só
      por estética (One Green Rule).

## Responsivo

- [ ] Teste em 320, 390, 768 e 1440px antes de considerar a tela pronta.
- [ ] Nenhuma largura fixa maior que a tela sem `max-width` reativo.
- [ ] Filtros/toolbar no celular viram grade de largura total — não uma fileira de caixas
      apertadas.

## Movimento

- [ ] Anima só overlay que abre/fecha (diálogo, drawer, menu, tooltip, toast) ou algo que responde
      a uma ação do usuário. Conteúdo de página, card, gráfico e KPI **não** animam na entrada.
- [ ] Animação nova? Teste com "reduzir movimento" ligado no SO — tem que sumir sozinha. A regra
      global em `tokens-base.css` cobre a maioria dos casos, mas `!important` inline pode furar.
- [ ] Saída de overlay sempre mais curta que a entrada (`--motion-exit`, 120ms) e com os mesmos
      keyframes invertidos — nunca um `scale()` genérico por cima de um elemento centralizado por
      `transform: translate(-50%, -50%)` (achado real: o diálogo "pulava" ao abrir — Fase 8).

## Texto e copy

- [ ] Nunca escrever "pedido(s)", "loja(s)", "item(ns)" — use `plural(n, singular, plural)` de
      `lib/format.ts`.
- [ ] Sentence case em tudo (rótulo, botão, item de menu) — nunca Title Case nem CAIXA ALTA.
- [ ] Sem seta Unicode (`→`) em botão ou link — se precisar indicar direção, é ícone SVG do
      `Icon`/`icons.ts`.
- [ ] Toda mensagem de erro diz o que aconteceu e, quando possível, o que fazer — nunca "Ops!" ou
      um erro genérico sem contexto.
- [ ] Texto que o cliente recebe (WhatsApp, e-mail) não é escopo desta checklist — mudar isso é
      decisão de produto, não de interface.

## Antes de abrir para revisão

- [ ] `npm --prefix admin run typecheck` e `npm --prefix admin run build` passam.
- [ ] `.claude/skills/impeccable/scripts/impeccable detect <arquivos tocados>` sem falhas não
      justificadas.
- [ ] Captura em 1440px, 768–1024px (tablet) e 320–390px (celular) — sem rolagem horizontal.
- [ ] axe-core (ou revisão manual de foco/rótulo) na tela nova — meta é 0 violação.
- [ ] Testar de teclado: Tab alcança tudo clicável, Enter/Espaço ativa, Esc fecha overlay.
- [ ] Se a tela pode falhar (rede, dado ausente, serviço fora do ar), simular a falha e conferir
      loading → erro → "Tentar novamente".
- [ ] Rodar a tela pelo menos uma vez com dado de verdade ou fixture realista — nunca só com o
      caminho feliz e completo.

## Erros que já aconteceram — não repetir

- **Ordenar só reordenava a página carregada**, não o histórico inteiro, numa lista paginada no
  servidor (Fase 3). Sempre checar se a fonte pagina de verdade antes de deixar o `DataTable`
  ordenar sozinho.
- **QR Code invisível** porque a imagem herdava `display: none` de um CSS legado (Fase 4). Ao
  portar de HTML/CSS antigo, teste visualmente — "está no DOM" não é "está visível".
- **Diálogo central "pulava" ao abrir** porque um `scale()` genérico sobrescrevia o
  `translate(-50%, -50%)` que centraliza o elemento (Fase 8). Nunca reaproveitar uma animação
  genérica num elemento posicionado por `transform` sem checar o resultado.
- **Toast duplicado** quando duas chamadas falhavam pela mesma causa, ou o StrictMode do React
  disparava o efeito duas vezes (Fase 6). Daí a regra de "toast só em ação" + deduplicação por
  mensagem.
- **KPI com ícone colorido e badge decorativo virou ruído** — 5 cores diferentes competindo na
  mesma faixa. Resolvido com faixa única monocromática e cor só no delta (Fase 5).
- **Plural escrito como "(s)"** em ~45 lugares — sempre usar `plural()`, nunca parênteses.
- **Painel dentro de painel** (card com outro card por dentro) — lista editável vira linhas com
  divisória, não um card por item (No Nesting Rule).

## Onde ler mais

- `DESIGN.md` — regras nomeadas, tokens, anatomia de cada componente.
- `docs/ui-lapidacao-auditoria.md` §12–19 — o raciocínio completo de cada fase, achado por achado.
- `/admin/playground` — cada componente do design system ao vivo, pra copiar o uso certo.
