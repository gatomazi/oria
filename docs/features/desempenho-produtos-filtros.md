# Desempenho de Produtos — "mais dados primeiro" + filtros

Pedido do usuário (2026-09-25, olhando a tela com o catálogo real da Use Sul): a tabela listava por
nome e a maioria das linhas era "Identidade não resolvida / —". Queria **sempre os produtos com mais
dados primeiro** e **filtros** (ativos, desativados, mais que X comprados, mais que X em checkout…).

## O que mudou

**Ordenação padrão = "mais dados primeiro"** (`sort=data`)
- Quem tem dado observado no período vem primeiro, do maior volume pro menor. Volume = visualizações
  + carrinho + checkout + compras (receita não entra: é valor, não evento). Empate: mais compras,
  depois mais checkout, depois mais carrinho, depois nome.
- O **resto do catálogo vem depois, por nome** — nunca escondido. É a lição da Rodada J: ordenar só
  por métrica fazia o catálogo parecer vazio. Uma paginação só percorre os dois trechos em sequência
  (o cursor continua sendo o número da página).
- Clicar numa coluna ordena por ela (as colunas de métrica agora são clicáveis — antes nenhuma era);
  o botão "Voltar para 'mais dados primeiro'" volta ao padrão. Na API o padrão continua "por nome" — o
  padrão novo é da **tela**, que pede `sort=data`.

**Filtros** (query de `GET /api/admin/product-analytics/products`)

| Parâmetro | Valores | Significado |
|---|---|---|
| `status` | `active` (padrão), `inactive`, `all` | `is_active` do catálogo canônico. O full sync marca inativo o produto que saiu da Ink; até aqui a tela nunca mostrava desativado |
| `minViewed`, `minAddedToCart`, `minCheckedOut`, `minPurchased`, `minRevenue` | número ≥ 0 | mínimo (`>=`) da contagem no período; 0/vazio = sem filtro; vários combinam com **E** |
| `hasData` | `true`/`false` | só produtos com alguma atividade no período |

- Métrica **indisponível** na propriedade GA4 (null) nunca satisfaz um mínimo > 0; produto sem dado
  também não. Com filtro de métrica a "cauda" sem dado não entra (por definição não atende).
- Filtro que ninguém atende devolve lista vazia (200, `totalCount: 0`) — a tela mostra "Nenhum produto
  com esses filtros" + "Limpar filtros" (e **não** o aviso de catálogo vazio).
- Valor inválido (`status=ativos`, `minPurchased=-1`, `hasData=1`, parâmetro repetido…) → 400 estável.
- A linha do produto ganhou `product.isActive`; a tela rotula "Desativado".
- Os totais no topo (cards "Itens visualizados…") continuam sendo da **Store inteira no período**, não
  seguem os filtros da tabela.

## Onde está
- `lib/product-analytics/performance-filters.js` — regra única (rota valida, service aplica)
- `lib/product-analytics/product-performance-service.js` — `getProductPerformance`: ranqueados em
  memória + cauda no banco; com filtro de métrica + ordenação por coluna do catálogo, os ids que
  passaram viram `onlyIds` e o **banco** continua ordenando/paginando
- `lib/product-analytics/commerce-catalog-repository.js` — `status`, `onlyIds`, `excludeIds`, `offset`
- `lib/product-analytics/http-routes.js` — validação de `sort=data` e dos filtros
- `src/pages/desempenho-produtos/DesempenhoProdutosPage.tsx` (+ `productAnalytics.ts`, `.css`)

A barra de filtros fica montada durante o carregamento (senão o campo perderia o foco a cada
digitação), os mínimos esperam 400 ms de pausa na digitação, e só a resposta da consulta mais
recente vale (respostas atrasadas são descartadas).

## Bug pego pelos testes no caminho
No período **sem nenhuma linha de analytics**, a direção do sort (`desc` do "mais dados") vazava pra
ordenação por nome e o fallback saía Z→A. Corrigido: campo que não é do catálogo cai em nome
ascendente.

## Verificação
- `test/performance-filters.test.js` (9, sem banco) · `product-performance-service.test.js` (49,
  +14 novos contra Postgres real: ranking, empate, paginação atravessando ranqueados→cauda sem
  repetir/perder produto, status nos três modos e nos três tipos de ordenação, mínimos combinados,
  métrica nula, filtro sem resultado, período sem analytics, isolamento por provider/Organization)
  · `product-analytics-http.test.js` (39, +4: aceite de `sort=data`, `status`, mínimos, 8 formas de
  entrada malformada)
- Vizinhos que compartilham repositório/service (reconciliação, oportunidades, jornada, identidade,
  catalog sync): 130/130
- `tsc`, `vite build`, `suites.mjs verify` limpos
- Navegador (ambiente local de demonstração, números fabricados): ordem por volume conferida contra
  os números da tabela; "Comprados ≥ 150" → 2 produtos; "Desativados" → estado vazio próprio;
  clique em "Receita GA4" reordena; "Limpar filtros" restaura. **Mobile não foi visto em imagem** (a
  extensão do navegador ignorou o resize na captura); a grade de filtros usa
  `repeat(auto-fit, minmax(150px, 1fr))`, sem largura fixa (2 colunas em ~344 px úteis).

## Desempenho medido (54.100 produtos, 23.304 ids observados pelo GA4 — o perfil real da Use Sul)
Postgres real e efêmero, GA4 fake, máquina compartilhada (números com ruído). Por requisição:

| Caminho | Tempo |
|---|---|
| ordenar por nome (caminho antigo, só banco) | ~2,2 s |
| **mais dados primeiro**, página 1 / 2 / 1000 / fronteira ranqueados→cauda / 2000 | ~2,4–3,4 s, **sem degradar com a profundidade** |
| mais dados + `minPurchased`, `status=all`, `hasData` | ~1,7–2,5 s |
| mais dados + `status=inactive` | ~4,0 s (pior caso medido; ruído da máquina possível) |

O "mais dados primeiro" custa **~0,3–1 s a mais** que o caminho antigo. O grosso (~2 s) é
**pré-existente**: cada requisição refaz a resolução de identidade dos ~23 mil ids observados (só o
relatório do GA4 é cacheado, a resolução não). Não foi mexido nesta rodada; se a tela ficar lenta no
catálogo real, é o próximo alvo (cachear a resolução por período, como o relatório).

## Pendências
- Confirmar o mobile em navegador real.
- Nada de migration nem de passo de produção nesta rodada.
