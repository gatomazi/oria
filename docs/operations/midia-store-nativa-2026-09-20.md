# Atribuição de mídia por `organization_id + store_id` (2026-09-20)

Rodada seguinte ao dogfooding de 2026-09-19. Depois dela Dashboard, Clientes e Financeiro carregavam para a
Store nativa (`loja_legada = NULL`), mas o **gasto de mídia nunca era atribuído a ela**: o lucro saía sem descontar
anúncio. Este documento é o mapa da atribuição, o modelo novo e o que ficou de fora.

## 1. Mapa do modelo antigo

Uma Organization tem **uma** conexão Meta e **uma** Google Ads (`meta_connections`, `google_ads_connections`: UNIQUE em
`organization_id`), com **uma conta selecionada** por vez (índice parcial `WHERE selecionada`). A ligação da conta com a
loja era o TEXTO `loja_atribuida` (`sul`/`centro`/`norte`).

| Peça | Onde | Dependência antiga |
|---|---|---|
| Tabelas | `meta_ad_accounts`, `google_ads_customers` | `loja_atribuida TEXT` |
| Fonte única do gasto | `lib/financeiro/midia.js` (`resolverMidiaDaOrganizacao`) | exigia `loja` (chave legada) |
| Selecionar conta Meta | `POST /integrations/meta/select-account` | `lojaLegadaDoContexto()` |
| Selecionar / atribuir conta Google | `POST /integrations/google-ads/contas/:id/{selecionar,loja}` | `lojaLegadaDoContexto()` |
| Dashboard financeiro | `GET /dashboard/financeiro` | resolver sem chave → **lançava**, gasto omitido |
| Consolidado (MER, ROAS, despesas) | `GET /analytics/consolidado` | 409 `META_LOJA_NAO_DEFINIDA` sem chave legada |
| Despesas | `GET/POST /financeiro/despesas`, `despesas_operacionais.loja NOT NULL` | `lojaLegadaDoContexto()` |
| UTM (campanhas) | `/utm/campaigns*`, `utm_campaigns.loja NOT NULL` | `lojaLegadaDoContexto()` |
| Jobs de mídia | `meta-incremental`, `meta-diario`, `meta-token` | por Organization, **sem** `loja` (já corretos) |

Google Ads **não tem job agendado**: o sync roda por rota (inicial/manual), sob o contexto da request.

## 2. Modelo novo

```text
canônico        organization_id + store_id        (FK composta → stores(id, organization_id))
compatibilidade loja_atribuida / loja (texto)      só quando a Store TEM chave legada
```

`lib/financeiro/midia.js#motivoDeExclusao` decide, por conta:

1. conta com `store_id` → é da Store do contexto se `store_id = storeId`, senão `outra_loja`;
2. conta sem `store_id` e sem texto → `sem_loja` (fora do total, sinalizada);
3. conta sem `store_id`, com texto → só casa se a Store do contexto **tem** chave legada e é a mesma.

A Store nativa nunca entra no ramo 3. Sem `storeId` nem `loja` o resolver lança (nada é atribuído por dedução). O contrato
de erro anterior (`loja: null` → erro) foi preservado para quem chama sem Store.

Nenhum vínculo por nome (`Use Sul → "sul"`) foi criado.

## 3. Schema — migration `0025-midia-store-id` (aditiva)

- `meta_ad_accounts.store_id`, `google_ads_customers.store_id`, `despesas_operacionais.store_id`, `utm_campaigns.store_id`
  (UUID), cada um com **FK composta** `(store_id, organization_id) → stores (id, organization_id)`: o banco recusa Store
  de outra Organization (o teste prova nas quatro tabelas).
- `despesas_operacionais.loja` e `utm_campaigns.loja` deixam de ser `NOT NULL`; `CHECK ... NOT VALID`: linha **nova** precisa
  de `store_id` OU `loja`.
- Conta de anúncio com `store_id` nulo é estado legítimo ("conectei e ainda não escolhi a loja").
- Backfill **só por mapeamento explícito** (`stores.loja_legada = loja_atribuida | loja`, mesma Organization). O que não
  resolve fica como está: nada é inferido de "a Organization só tem uma Store".
- `down` recusa (não apaga) se existir despesa/UTM sem chave legada.

## 4. O que muda por área

- **Meta / Google Ads**: selecionar e atribuir gravam `store_id` (canônico) e espelham `loja_atribuida` com a chave legada
  ou `NULL`. O status de contas passou a devolver `atribuidaAEstaStore` (mesma regra do resolver); as telas deixaram de
  depender de `lojaAtribuida` + `adminStores`.
- **Financeiro**: o consolidado deixou de exigir chave legada e compõe receita, custo de produção, mídia (Meta + Google) e
  despesas da Store nativa. Devolve `loja: { id, storeId, nome }` (nome da Store). GA4 continua por chave legada: sem
  chave, `ga4Disponivel: false` (explícito).
- **Dashboard**: `GET /dashboard/financeiro` devolve `midiaFontes` (estado por plataforma) e `midiaSinalizada`. A tela deixa
  de tratar `gasto > 0` como "mídia conectada": **sem conta ≠ conta fora do total ≠ conta da loja com gasto zero**.
  Sem mídia, o lucro diz por quê ("sem mídia conectada" / "conta de anúncios sem loja atribuída") em vez de calar.
- **Despesas / UTM campanhas**: `escopoDaStore` (mesma regra de pedidos e clientes).
- **Jobs**: nenhum job de mídia usa a chave legada (verificado por teste sobre o código); o runner entrega
  `organizationId + storeId + loja` a cada execução.

## 5. Isolamento

Testes com A (legada, atribuída por texto), C e D (nativas, **mesmo customer id do Google**), E (conta sem loja), F (sem
conta), G (conta com gasto zero), H (nativa com texto legado `sul`): cada uma soma só o seu, inclusive em requisições
concorrentes; `H` **não** recebe o gasto da conta "sul"; C não seleciona a conta de D. Uma consulta sem RLS por baixo prova
que o `organization_id` escrito no resolver é o que isola.

## 6. Dívidas (fora desta rodada)

- **GA4** (conexão OAuth, cache de performance, aba Performance do UTM): `google_analytics_connections` e
  `ga4_performance_cache` ainda são por `loja`; conectar GA4 numa Store nativa é frente própria (tabelas + OAuth `state`).
- **OAuth Meta/Google** para tenant novo: o modelo canônico está pronto, o fluxo de conectar não foi tocado.
- `insights` (`meta_insights_daily`, `google_ads_insights_daily`) seguem ligados à **conta**; a atribuição à Store é da conta.
  Trocar a conta de Store não reatribui histórico de outra Store (e não há backfill por heurística).
- Reembolsos por pedido (`/pedidos/:id/reembolsos`) e reembolso/troca reais não foram tocados.
- Recuperação, Promoções, Campanhas, Trocas, Catálogo, Produtos, Categorias, Agrupamentos, Estoque, Feed e Artwork Vault
  continuam fora, como combinado.
