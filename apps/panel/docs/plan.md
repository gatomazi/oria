# Plano — Cache completo do catálogo da Ink em Postgres

## Contexto

Hoje existem dois caminhos pra listar produto e nenhum dos dois é um cache do catálogo real:

1. **Feed CSV** (`produtos_feed`, commit b14e310) — só produto publicado/ativo, sem
   `approval_status`, `visible_in_store`, variantes, `product_cluster_id` nem `updated_at`.
   Só entra em cena quando há filtro de nome ou tipo (`server.js:2230`, guarda `filtroLocal &&`).
2. **API da Ink ao vivo** — `GET /v1/stores/products` paginado. Sem filtro, devolve os 85k com
   paginação nativa (rápido, 1 request por página). Com filtro de nome/tipo, a Ink ignora o
   parâmetro e o servidor varre o catálogo de 100 em 100, truncando em
   `PRODUTOS_BUSCA_MAX_PAGINAS` (50 páginas = 5.000 produtos).

O resultado prático: a tela Produtos sempre fala com a Ink ao entrar, e a tela
"Associar produtos" fala com a Ink **sempre** (`fonte: 'ink'` fixo em
`AssociarProdutosPage.tsx:89`), o que trava a etapa 2 no skeleton quando há filtro de tipo.

## Objetivo

Varrer o catálogo **completo** da Ink uma vez (todas as páginas, inclusive desativado, oculto e
não aprovado), persistir em Postgres e servir a listagem de lá. Sync manual pelo menu
Integrações — mesmo padrão do backfill de pedidos — mais um job periódico de renovação.

Decisões do usuário (2026-09-11):
- Cache vira o default da tela Produtos, inclusive sem filtro.
- Na tela Associar, o cache serve **só a listagem**; o preview e o job continuam resolvendo os
  alvos pela API da Ink.
- O feed CSV continua existindo e vira fallback, não fonte primária.

## Arquivos

| Arquivo | Ação | Descrição |
|---|---|---|
| `server.js` | editar | Tabelas `produtos_ink` + `produtos_ink_sync`; crawl em background página a página; endpoints de sync/status; `buscarProdutosNoCatalogo` como fonte primária de `GET /api/admin/produtos`; job periódico |
| `admin/src/api/produtos.ts` | editar | Tipos e chamadas do cache de catálogo (`sync`, `status`), `fonte: 'catalogo'` |
| `admin/src/pages/integracoes/CatalogoCacheCard.tsx` | criar | Card de sync manual + progresso, espelhando `BackfillPedidosCard` |
| `admin/src/pages/integracoes/IntegracoesPage.tsx` | editar | Monta o card novo |
| `admin/src/pages/produtos/ProdutosPage.tsx` | editar | Badge de fonte cobre o catálogo completo; escape pra Ink continua |
| `admin/src/pages/categorias/AssociarProdutosPage.tsx` | editar | Remove `fonte: 'ink'` fixo; avisa que o job relê da Ink |

## Detalhes técnicos

### Tabela `produtos_ink`

Espelha `mapProdutoSummary` mais o que os filtros precisam: `loja`, `produto_id` (PK composta),
`name`, `main_image_url`, `price`, `promotional_price`, `visible_in_store`, `approval_status`,
`status`, `product_type_id`, `product_type_name`, `variants_count`, `product_cluster_id`,
`updated_at`, `sincronizado_em`. Índices por `(loja, lower(name))`, `(loja, product_type_id)`,
`(loja, visible_in_store)` e `(loja, approval_status)`.

### Crawl

Mesmo padrão já validado em `processarSimulacaoMigracao` (server.js:5196): página a página com
`per_page=100`, upsert por página e progresso gravado a cada página, tudo fora do ciclo
request/response. Teto de segurança próprio (`PRODUTOS_CACHE_MAX_PAGINAS = 2000`), nunca o teto
de busca interativa. Retry via `comRetryInk` (429/5xx/rede). Ao fim, `DELETE` do que ficou com
`sincronizado_em` anterior ao início — é isso que tira produto apagado. Crawl que termina com
zero produtos é tratado como falha e preserva o cache anterior.

### Fonte da listagem

`GET /api/admin/produtos` passa a tentar, em ordem: `produtos_ink` (cobre todos os filtros) →
`produtos_feed` (só ativo, comportamento atual) → API da Ink. `fonte=ink` continua forçando a
consulta direta, e a resposta sempre diz de onde veio (`fonte` + `cacheSincronizadoEm`).

Com "todas as lojas" selecionado, o cache só responde se TODAS as lojas com token já tiverem sido
varridas — cache parcial apresentado como catálogo completo esconderia loja inteira sem aviso.

## Impacto em testes

Sem suíte automatizada no projeto. Verificação manual descrita abaixo.

## Estado

Implementado. `node --check server.js` e `npm run build` (admin) passam. Falta a verificação
manual abaixo, que depende de Postgres e token da Ink — não dá pra rodar nesta máquina.

## Verificação

1. `node --check server.js` e `npm run build` no admin.
2. Integrações → card do catálogo → sync manual de uma loja; acompanhar progresso até concluir.
3. Produtos sem filtro: badge diz "cache", total bate com o catálogo completo (não 5.000).
4. Produtos com filtro de nome e de tipo: resposta instantânea, sem `truncado`.
5. Filtro de oculto/não aprovado: agora resolvido pelo cache (o feed não cobria).
6. "Consultar direto na Ink" continua trazendo o resultado ao vivo.
7. Associar → etapa 2 com filtro de tipo: lista carrega na hora; simular e executar continuam
   batendo com a Ink.
