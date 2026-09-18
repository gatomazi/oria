# Connector Ink — identidade da Store sem `loja_legada`

Como o Connector Ink identifica a loja depois da rodada de productização
([comando](../commands/claude-productizar-connector-ink-sem-loja-legada.md)).

## A regra

```text
organization_id + store_id   →  identidade
loja / loja_legada           →  compatibilidade histórica
```

`stores.loja_legada` é a chave do sistema de loja única (`sul`/`centro`/`norte`). Cliente criado
nativamente pelo Oria nasce **sem** ela, e nada no caminho novo pode exigi-la.

## Por que isso era um bloqueio, e não um detalhe

A chave legada não era só o escopo: ela era **chave primária** de `pedidos_ink_itens` e
`sync_estado`, e parte da unicidade de `pedidos_ink`. Como coluna de chave primária não pode ser
nula, a chave do sistema antigo era requisito de **existência da linha**. Um cliente novo não
conseguia ter pedido — não por regra de negócio, por formato de chave.

## Os dois caminhos, explicitamente separados

O helper `escopoDaStore(n)` em `apps/panel/server.js` monta o predicado de leitura:

```text
canônico      store_id = $n
compatível    OU (store_id IS NULL AND loja = $n+1)
```

O segundo ramo **só existe quando a Store do contexto tem chave legada** — ou seja, quando ela veio
de uma migração e pode ter linhas antigas ainda sem `store_id`. Store nativa nunca entra nele: sem
chave, não há o que casar. É isso que impede um cliente novo de enxergar linha histórica de
outro contexto, e é o que o controle negativo `connector/store-nativa-no-path-legado` protege.

`organization_id` entra sempre, à parte, e a RLS confere de novo por baixo.

## Helpers

| helper | o que devolve | quando usar |
|---|---|---|
| `storeDoContexto()` | `store_id` da Organization da sessão | identidade canônica; é o padrão |
| `lojaLegadaDoContexto()` | chave legada, **lança** se não houver | só no caminho de compatibilidade |
| `lojaLegadaDoContextoOuNula()` | chave legada ou `null` | exibição e rótulo |
| `storesInkDoContexto()` | `[{ storeId, loja }]` se houver credencial | fluxos de pedido/Ink |
| `lojasLegadasInkDoContexto()` | só as Stores com chave legada | fluxos ainda não convertidos |

O nome `lojaLegadaDoContexto` é deliberado: quem o chama está no caminho de compatibilidade, e o
nome não deixa confundir com a Store canônica.

## Identidade externa na Ink

A loja **na Ink** é determinada pela **credencial**. A API é `/v1/stores/...`, sem id de loja no
caminho: quem responde é a conta do token. O `loja` interno nunca é enviado ao provider.

Se um dia a Ink devolver um identificador próprio (store id, account id), ele será persistido como
`external_resource_id` da integração — **não** reaproveitando `loja_legada` para isso.

## Schema (migration 0021)

| tabela | `store_id` | `loja` | unicidade |
|---|---|---|---|
| `pedidos_ink` | nova, FK composta | passou a ser opcional | `uq_pedidos_ink_store` (parcial) + `uq_pedidos_ink_org` (legado, intacto) |
| `pedidos_ink_itens` | nova, FK composta | opcional | PK substituta `(organization_id, id)`; `uq_pedidos_ink_itens_store` (parcial) + legado |
| `sync_estado` | nova, FK composta | opcional | PK substituta; `uq_sync_estado_store` (parcial) + legado |
| `webhook_eventos` | nova, FK composta | já era opcional | índice de leitura por Store |

Três decisões que valem explicação:

**A FK é composta** — `(store_id, organization_id) → stores (id, organization_id)`. Não basta a
Store existir: ela precisa ser da Organization da linha. É a regra da RLS escrita também como
integridade referencial, então o banco recusa a combinação errada mesmo que o código erre.

**O CHECK é `NOT VALID`** — vale para linha nova e atualizada, e não revalida o histórico. Toda
linha nova identifica sua Store (pela identidade nova ou pela chave antiga); nenhuma linha
histórica é declarada inválida retroativamente. A primeira versão desta migration exigia `store_id`
de todo mundo: quebrou 116 testes e, pior, quebraria o cenário real de migração, onde existem
pedidos cuja loja ainda não foi mapeada.

**Os índices legados continuam, com o mesmo nome e sem predicado** — as releases já publicadas
fazem `ON CONFLICT (organization_id, loja, ...)`, e `ON CONFLICT` não casa com índice parcial.
Transformá-los em parciais quebraria a release anterior no meio de um rollout, e nenhum teste de
schema veria isso — quem pegou foi o dry-run do runbook, que executa o código antigo de verdade.
Como NULL é distinto de NULL em índice único, o legado não restringe as linhas novas.

## O que ainda é legado, de propósito

Catálogo (`produtos_ink`, `produtos_feed`, `produtos_ink_sync`), estoque (`estoque_observacoes`,
`controle_estoque_observacoes`) e os demais fluxos com `loja NOT NULL` **não** foram convertidos
nesta rodada. Eles rodam só para Store com chave legada (`lojasLegadasInkDoContexto()`), e Store
nativa fica de fora — o que é o comportamento correto enquanto essas tabelas não tiverem `store_id`.

Converter esses fluxos é a continuação natural: mesma migration em forma, mesmo helper de escopo.

## Fallback de ambiente

Continua existindo (`ALLOW_LEGACY_INTEGRATION_ENV=1` + `INK_TOKEN_<LOJA>`), e continua exigindo
chave legada — logo, é **inelegível** para Store nativa. Isso não é uma falha: o caminho normal é
`integration_secrets`, cifrado com `ENCRYPTION_MASTER_KEY`.
