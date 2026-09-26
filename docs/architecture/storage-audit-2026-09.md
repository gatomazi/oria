# Auditoria de armazenamento do catálogo Commerce — setembro/2026

> Rodada **somente leitura em produção + prova de conceito em banco isolado**. Nenhuma linha, índice ou job de
> produção foi alterado; nenhum push, merge ou deploy. Este documento tem quatro partes: **1** Gate 0 e Gate A
> (diagnóstico medido), **2** Gate B (alternativas), **3** Gate C (prova de conceito e benchmarks), **4** Gate D
> (plano de rollout reversível, não executado) e o **relatório final**.
>
> Convenção: **[M]** = medido em produção (exato), **[A]** = amostra (tamanho e método declarados), **[P]** = medido
> na POC (Postgres 18.6 isolado, catálogo sintético fiel à Use Sul), **[E]** = estimativa derivada, com a conta.

## Alerta operacional (independente da otimização)

> **ATUALIZAÇÃO 2026-09-26 03:10 UTC — o risco já se materializou (leitura somente, nada alterado por mim).** O agendador
> disparou o full sync às **02:44:16 UTC**; ele terminou em `partial_failure` às 02:46:40 (144 páginas, 658.102 variantes,
> `CATALOG_SYNC_FAILED`) e o log do `oria-panel` traz `[CATALOG_SYNC_SCHEDULER] … could not extend file "base/16384/52569.1":
> No space left on device`. Estado às 03:08 UTC: volume **96 % (4,4 GB usados, 194 MB livres)**, `pg_wal` **833 MB** (era 177 MB),
> banco 3.548 MB. Como o último run não foi `success`, `catalogSyncNecessario` devolve `true` e **o agendador tentará de novo a
> cada hora** (próxima ≈ 03:44 UTC); o bootstrap pesado (+865 MB, 7,6 GB de WAL) ainda nem rodou. Enquanto o volume estiver
> assim, qualquer escrita (inclusive de outras funcionalidades e Organizations) pode falhar com o mesmo erro, e uma falha de WAL
> derruba o Postgres. **Ação imediata do dono:** ampliar o volume (ou suspender o sync) — ver "Mitigações" abaixo.

O **próximo full sync agendado** da Use Sul reescreve **todas** as 3,68 milhões de identities de variante numa única
instrução (`bootstrapCommerceIdentities` faz `ON CONFLICT DO UPDATE` sem `IS DISTINCT FROM`, e nenhuma coluna
indexada muda, mas as páginas estão cheias, então não há HOT). O volume do Postgres tem **804 MB livres** [M]. Na POC,
esse re-upsert **dobra heap e índices** da tabela de identities (**+865 MB**: heap +629 MB, índices +236 MB; em produção os índices são ~20 % maiores) e escreve **~7,6 GB de WAL** [P]. O full sync que o antecede regrava as 3,68 M variantes (+~0,4–0,6 GB nas 3 tabelas, +11 GB de WAL) [P].

- Agendador: `JOBS.agendar('catalogo-canonico', 1h)` com guarda de 24 h (`catalogSyncNecessario`); o último sucesso terminou
  em **2026-09-25 02:09 UTC** [M] → o próximo é elegível a partir de **2026-09-26 02:09 UTC** (o clique manual em
  "Sincronizar catálogo" também dispara).
- Consequência provável: `ENOSPC` durante a instrução (ela falha e o bootstrap é "best-effort"), mas o lixo da
  transação abortada continua ocupando disco até um VACUUM, e uma falha de escrita de WAL derruba o Postgres.
- O bootstrap é o pior trecho (+865 MB numa instrução), mas **o próprio full sync também é arriscado** com 804 MB livres:
  ~11 GB de WAL por ciclo (o `pg_wal` pode subir até ~1 GB, hoje 273 MB) e reescrita não-HOT de 3,68 M variantes com
  autovacuum concorrente. Sem a POC não dá para afirmar qual dos dois estoura primeiro — por isso a mitigação robusta é
  **folga de volume**, não só o código.
- Mitigações que dependem de decisão do dono (**não executadas por mim**): (a) aumentar o volume antes das 02:09 UTC (o plano
  atual limita a 5 GB? confirmar); (b) impedir o sync até a correção; (c) depois disso, o modo `derived` (partes 3 e 4) elimina o
  bootstrap pesado e o `per_product` reduz o WAL do sync em 73 %. **`derived` sozinho não basta para a noite de hoje.**

---

# Parte 1 — Gate 0 e Gate A

## Gate 0 — segurança e organização

| Item | Resultado |
| --- | --- |
| Worktree | `/Users/gtomazi/projects/oria-storage-poc`, branch `feature/storage-optimization-poc`, criado de `origin/main` **c575bcb** (fetch feito no início). Nenhum outro worktree (Journey, RFM, criativos, StoreFront) foi tocado. |
| Migrações | Produção tem **45** aplicadas, a última `1790002800000_segments-rfm`; o repositório em `origin/main` tem os mesmos **45** arquivos → sem deriva. **Esta rodada não adiciona migration.** |
| Acesso a produção | `railway ssh --service oria-panel` executando um cliente `pg` dentro da rede do Railway (o banco não tem proxy público e não foi exposto). Toda sessão: `default_transaction_read_only = on`, `statement_timeout = 25s`, `lock_timeout = 2s`, `application_name = storage-audit-readonly`. Só catálogos de sistema, `pg_stats`, `EXPLAIN` (sem `ANALYZE`) e agregações limitadas pelos índices. Nenhum segredo/PII lido ou registrado (ids de catálogo apenas). |
| Volume (via `df`/`du` no container do Postgres, somente leitura) | 4,6 GB de tamanho, **3,8 GB usados, 804 MB livres (83 %)**; `base/` 3,5 GB; `pg_wal/` 273 MB (17 segmentos). |
| Backup com restauração testada | **Não verificável a partir daqui.** Nenhum backup foi criado nem restaurado. É pré-requisito bloqueante para qualquer etapa destrutiva do Gate D (a partir do passo 5). |
| Operações proibidas | Nenhum `VACUUM FULL`, `REINDEX`, `DROP INDEX`, `DELETE`, `TRUNCATE` ou migração em produção. Esses comandos rodaram **somente** nos bancos `oria_poc_*` do container local. |
| Bytes em relação × volume | O volume (3,8 GB) inclui WAL (273 MB), catálogo do sistema e demais tabelas; as três tabelas do catálogo somam 3,36 GB. Apagar linhas **não** devolve espaço ao volume; WAL cresce durante migrações (ver 3.6). |

## Gate A — o que está armazenado [M]

### Tabelas (2026-09-25 ≈ 22:00 UTC)

| Tabela | Linhas | Heap | Índices | Total | B/linha (heap + índices) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `commerce_product_variants` | 3.680.802 | 1.087 MB | 776 MB | **1.863 MB** | 310 + 221 = **531** |
| `product_external_identities` | 3.806.267 | 632 MB | 768 MB | **1.400 MB** | 174 + 212 = **386** |
| `commerce_products` | 105.857 | 66 MB | 30 MB | 96 MB | 656 + 297 = 953 |
| `produtos_ink` (legado) | 105.857 | 40 MB | 37 MB | 77 MB | — |
| **Banco** | | | | **3.481 MB** | |

WAL desde o reset de estatísticas (2026-09-17): **29 GB** em 126 M de registros, `wal_compression = off`,
`max_wal_size = 1 GB`, `wal_level = replica`. Configuração próxima do padrão (shared_buffers 128 MB).

### Índices, constraints e uso [M]

`idx_scan` acumulado desde ~2026-09-17 (`pg_stat_database.stats_reset` é nulo; usar como indício, nunca como prova).

| Tabela | Índice (definição resumida) | MB | idx_scan | Papel |
| --- | --- | ---: | ---: | --- |
| variants | `uq_…_identidade` UNIQUE `(org, store, provider, provider_variant_id)` | 515 | 9.501.377 | conflito do upsert do sync; **é o mapeamento variante → produto** |
| variants | `…_pkey` `(id)` | 153 | 0 | PK |
| variants | `idx_…_sync_run` `(org, store, provider, last_seen_sync_id)` | 53,5 | 0 | pensado para a varredura de desativação; o plano real é `Seq Scan` (o predicado é `<>`) |
| variants | `idx_…_produto` `(org, commerce_product_id)` | 47,5 | 0 | sustenta o `ON DELETE CASCADE` da FK composta — **manter** |
| variants | `idx_…_ativos` parcial `(org, store, provider) WHERE is_active` | 44,2 | 0 | prefixo do UNIQUE cobre a mesma busca; plano real do bootstrap/desativação é `Seq Scan` |
| identities | `uq_…_identidade` UNIQUE `(org, store, namespace, external_id)` | 584 | 3.901.397 | resolução e ON CONFLICT do bootstrap |
| identities | `…_pkey` | 154 | 0 | PK |
| identities | `idx_…_produto` `(org, commerce_product_id)` | 41,5 | 551 | FK / cascade — **manter** |
| identities | `idx_…_namespace` `(org, store, namespace)` | 25,7 | 1.998 (9,1 M tuplas) | elegibilidade `idsComIdentidadeResolvida`; prefixo do UNIQUE cobre |
| products | `uq_…_id_organization`, `uq_…_identidade`, `pkey`, `sync_run`, `ativos`, `store` | 1,2–14,7 | 7.039.207 / 272.645 / 372.318 / 119.243 / 2.416 / 0 | tabela pequena; não é alvo |

Constraints relevantes: FK composta `(commerce_product_id, organization_id) → commerce_products(id, organization_id) ON DELETE CASCADE`
em ambas; CHECKs de namespace (`^[a-z][a-z0-9_]*(\.…)*$`, `<> 'id'`), `source ∈ {commerce_sync, analytics_observed, manual, rule}`,
`confidence ∈ {exact, verified, inferred}`; RLS `FORCE` por `organization_id` nas três tabelas.
**Nenhuma regra proíbe remover índices sem uso, mas nenhum será removido nesta rodada** (E é só proposta, com evidência
de plano em 3.5).

### Escrita nas tabelas [M]

| Tabela | inserts | updates | HOT | Leitura |
| --- | ---: | ---: | ---: | --- |
| variants | 3.680.802 | **5.820.575** | **0** | o full sync regrava **toda** variante (`DO UPDATE` incondicional, `last_seen_sync_id` é indexada → nunca HOT) |
| identities | 3.806.942 | 0 | 0 | só 1 bootstrap rodou até agora; o 2º atualizará **todas** as linhas |
| products | 105.857 | 158.200 | 0 | idem, escala pequena |

Histórico de `commerce_catalog_sync_logs`: 1 sucesso (2026-09-25 01:50→02:09, **18 min 43 s**, 1.059 páginas, 105.857 produtos,
443.638 variantes inseridas + 3.237.164 atualizadas), 1 falha parcial (`INK_RATE_LIMITED`, 12.000 produtos) e 2 linhas
`running` órfãs. O tempo do sync é dominado pela API da Ink, não pelo banco.

### Identidades por namespace e método de vínculo [M, exato]

| namespace | source | confidence | linhas | O que é |
| --- | --- | --- | ---: | --- |
| `reserva_ink.variant_id` | `commerce_sync` | `exact` | **3.680.802** | espelho 1:1 de `commerce_product_variants` |
| `reserva_ink.product_id` | `commerce_sync` | `exact` | 105.857 | espelho 1:1 de `commerce_products.provider_product_id` |
| `ga4.item_id` | `rule` | `exact` | 19.608 | alias GA4 observado |
| `sku` | — | — | **0** | nenhum SKU é único na Store |
| manuais / históricas / conflitos | — | — | **0** | não existem hoje |

**Causa confirmada da hipótese (duplicação):** as 3.680.802 identities `reserva_ink.variant_id` são **exatamente** o número de
variantes ativas (3.680.802, contagem exata por índice parcial), foram todas criadas na mesma instrução (`created_at`
idêntico, 02:09:36.221 UTC) pelo `INSERT … SELECT` do bootstrap, e a tabela de identities **não tem coluna de variante** —
só `commerce_product_id`. Cada linha guarda `(external_id = provider_variant_id) → commerce_product_id`, que é exatamente
o que o índice UNIQUE de `commerce_product_variants` já entrega.

Equivalência verificada em duas amostras independentes, nos dois sentidos (identity→variante e variante→identity):

| Amostra | Método | Identity→variante | Variante→identity |
| --- | --- | --- | --- |
| A (n = 55.272 / 55.673) | `TABLESAMPLE SYSTEM (1,5)` (páginas contíguas) | 100 % existe, 100 % mesmo produto | 100 % / 100 % |
| B (n = 59.000 / 59.000) | 300 faixas de 200 chaves em pontos aleatórios de **todo** o espaço de ids | 100 % / 100 % | 100 % / 100 % |

Não foi feita a antijunção exaustiva de 3,7 M × 3,7 M em produção (evitada de propósito: ~2 GB de leitura numa base
com 128 MB de shared_buffers). Falta de cobertura exaustiva é **amostra**, mas com contagem exata idêntica e mecanismo
determinístico no código; a comprovação exaustiva fica como verificação do passo 2 do Gate D (dupla leitura).

Os **19.608 aliases GA4** e as 105.857 identities de produto foram verificados **exatamente**: 100 % têm
`external_id = provider_product_id` do próprio produto (nenhum GA4 item_id da Use Sul é id de variante ou SKU). Dos
19.608 produtos observados, **9.777 estão `not_published`** e 9.831 `published` (juntada exata) — o funil GA4 e o
histórico de pedidos dependem de produtos **não publicados** (699 produtos / 1.225 itens de pedido também).

### Densidade real de variantes [M, exato]

10 tipos de produto, 105.857 produtos, **34,8 variantes/produto** em média — mas muito heterogêneo:

| product_type | produtos | variantes/produto (mín–máx) | publicados |
| --- | ---: | --- | ---: |
| Camiseta | 13.986 | 101,2 (6–108) | **9.817** |
| Camiseta Algodão Peruano | 10.284 | 40,1 (24–46) | 0 |
| Camiseta Infantil | 10.202 | 39,8 (7–44) | 0 |
| Cropped | 10.195 | 34,9 (10–35) | 0 |
| Hoodie Moletom / Suéter Moletom | 10.183 / 10.198 | 24,0 | 0 |
| Body Infantil | 10.171 | 21,1 (6–24) | 0 |
| Camiseta Oversized | 10.250 | 18,0 (6–18) | 18 |
| Regata / Cropped Moletom | 10.202 / 10.186 | 10,0 | 0 |

Só **9.835 produtos (9,3 %) estão publicados** (quase todos "Camiseta", ~100 variantes cada); 96.022 são estampas não
publicadas. O piloto "excepcional" tem, portanto, **um núcleo publicado de ~9,8 mil produtos — do tamanho do cliente-alvo —
com a grade mais cheia (~100 variantes/produto)**, mais uma cauda de 96 mil não publicados. Variantes por produto é o
parâmetro que domina o custo: a distribuição conjunta completa está em
`apps/panel/scripts/dev/storage-poc/fixtures/usesul-catalog-shape.json` e alimenta o gerador da POC.

### Mapa de leitura e escrita [código]

| Onde | Escreve | Lê |
| --- | --- | --- |
| `catalog-sync.js` `runCatalogSync` | upsert de `commerce_products` e `commerce_product_variants`; desativação por `last_seen_sync_id` | — |
| `product-identity-resolver.js` `bootstrapCommerceIdentities` (chamado por `composition.syncCommerceCatalog` **depois de todo sync com sucesso**) | identities `product_id`, `variant_id` (3,68 M), `sku` (só se único na Store) | variantes e produtos |
| `resolveExternalIds` / `resolveAndPersist` (passos: mapping existente → `%.product_id` → `%.variant_id` → `sku`) | `persistRuleMatches`: só aliases `rule` do namespace observado (`ga4.item_id`) | identities (`namespace LIKE '%.variant_id'` é a **única** leitura das 3,68 M linhas) |
| `product-performance-service.idsComIdentidadeResolvida` | — | identities do namespace `ga4.item_id` ⋈ `commerce_products` (conjunto elegível) |
| `commerce-catalog-repository` (lista/busca de catálogo) | — | `commerce_products` apenas |
| `orders-repository.js` (Ink) | — | `commerce_products` por `provider_product_id`; `commerceVariantId` é sempre `null` (pedido não guarda variante) |
| `reconciliation`, `opportunity-diagnostics`, `journey-analytics-service` | — | via `ProductPerformanceService` (não tocam identities diretamente) |
| Triggers / views | nenhum | nenhum |

Conclusão do mapa: **nenhuma funcionalidade lê `commerce_product_variants` fora do resolvedor e do sync**, e a única
leitura das identities mecânicas de variante é o passo 3 da resolução.

### Custo de manutenção e crescimento [M + P]

- O full sync é limitado pela API (18 min 43 s para 1.059 páginas). No banco, cada sync regrava 3,68 M linhas de variante
  e (hoje) 3,68 M de identities; na POC a Use Sul gera **~11 GB de WAL por sync + ~7,6 GB por bootstrap** (ver 3.3).
- Sem manutenção, o tamanho **estabiliza em ~2× o tamanho "fresco"** (versões mortas reaproveitadas, mas heap/índices
  não encolhem): 10 k produtos: 260 → 503 → 513 → 514 MB nos ciclos 1–4 [P, execução com ids sequenciais em `results/v1-sequential-ids/`].
- Histórico de crescimento do volume não está disponível como métrica; só o estado atual e os contadores de escrita.

### Identidades **necessárias** (estimativa [E], não inferida de `idx_scan`)

| Necessidade | Precisa de linha própria? |
| --- | --- |
| Funil GA4: item_id → produto | **Sim, só o alias** (`ga4.item_id`, 19.608 hoje): alimenta a elegibilidade e evita recomputar |
| Commerce-only (sem GA4) | Não — nada lê identities |
| Pedidos / histórico financeiro | Não — junta por `provider_product_id` em `commerce_products` |
| Reconciliação | Não diretamente (usa o mapa produzido pela resolução) |
| Pesquisa por SKU | Só com SKU **único** (0 hoje); SKU compartilhado nunca vira identity |
| Futuros providers | Precisam do **passo 3 da resolução**, não de 1 linha por variante |
| Mapeamento manual / correção de conflito | Sim — mecanismo a preservar (0 hoje) |

Necessárias hoje: **19.608 aliases (+ 105.857 product ids, opcionais)** contra 3.806.267 armazenadas → **≥ 96,7 %** são
espelho derivável.

---

# Parte 2 — Gate B: alternativas

Referência de tamanho: 3 tabelas do catálogo (dados + índices), MB. **A** = modelo atual. "fresh" = logo após a carga;
"steady" = depois de 2+ ciclos de sync com VACUUM (o tamanho para o qual o sistema converge sem manutenção; teto — ver 3.1).
Todas as linhas com [P] vêm da POC (Postgres 18.6, catálogo sintético fiel à Use Sul, código real de sync/bootstrap/resolução).

| Alt. | O que faz | Economia (Use Sul 100 k, [P]) | Economia (loja 10 k, 98 var/prod, [P]) | Impacto em consulta | Risco / complexidade | Veredito |
| --- | --- | --- | --- | --- | --- | --- |
| **A** atual | variante + identity `variant_id` (espelho) para todo o catálogo | — (3.007 fresh / 4.441 steady) | — (789 / 1.331) | baseline | — | baseline; **tem o risco de disco do alerta acima** |
| **B** derivar a identity de variante | não grava `<provider>.variant_id`; o passo 3 da resolução lê o UNIQUE de `commerce_product_variants`; aliases GA4, manuais, regras e SKU único continuam na tabela e **vencem** o catálogo | **−1.292 MB fresh (−43 %) / −2.173 MB steady (−49 %)**; bootstrap 204→27 s, WAL 3,7→0,14 GB | −349 / −572 MB (−44 % / −43 %) | latência **neutra** no estado final (3.4); custa uma consulta extra enquanto as linhas espelho ainda existem (transição) | **baixo**: flag `PRODUCT_IDENTITY_VARIANT_MODE` (padrão = comportamento atual), dual-read, sem migration, reversível regenerando | **RECOMENDADA — fase 1** |
| B-sku | idem para SKU único por variante (3ª cópia nas lojas com SKU único) | 10 k publicado, SKU único: B ainda guarda 983.514 identities `sku` (**540 MB steady**); índice parcial `(org, store, sku)` custa 64 MB | (B 713 fresh → ~507 [E]) | busca por SKU vira lookup + checagem de unicidade em tempo de consulta | médio: exige migration (índice) e decisão de semântica (unicidade só entre ativas? histórico de SKU de variante descontinuada) | fase 2b, **não implementada** nesta rodada |
| **C** variantes sob demanda / só publicados | materializa variantes só de produtos publicados/consultados | Use Sul: ~72,5 % das variantes são de produtos não publicados [A, n = 53.964] → até ~−1,2 GB | ~0 (loja normal tem quase tudo publicado) | resolução de variante de produto não publicado falha | **alto** — ver "Por que não C" | **rejeitada como padrão** |
| **D** retenção / arquivamento | arquivar inativos/históricos | **0**: não existe linha inativa (105.857 produtos e 3.680.802 variantes ativos, exato) e nenhuma regra de retenção documentada | 0 | — | pedidos/itens financeiros/aliases históricos não podem ser tocados | **sem ação** |
| **E** índices redundantes | remover `idx_…_variants_sync_run` e `idx_…_ativos` | −50 MB fresh (−2,9 %) [P]; em produção 97,7 MB (índices sem uso e sem bloat: ~44 MB) | −4 MB | nenhuma (planos reais são Seq Scan/UNIQUE) | baixo, mas **não removi nada** e o ganho é pequeno | opcional, depois da fase 2 |
| **S** sync sem regravar o que não mudou (`variantSweep=per_product`) | grava a variante só se mudou; sumiço tratado por produto; desativação de produtos só no fim | steady 2.268 → **1.845** (com E) = **−19 %** sobre B (−58 % sobre A); sync#2 **463 → 220 s** e **11,0 → 3,0 GB de WAL** (−73 %) | steady 759 → 464 (**−39 %** sobre B, −65 % sobre A) | nenhuma leitura muda | médio: muda a semântica numa falha parcial (ver 3.7); flag, testes diferenciais | **fase 2, opt-in por tenant** |
| **G** compactação física | `REINDEX` / `VACUUM FULL` numa janela | A: steady 4.441 → 3.727 (REINDEX) → 2.661 (VACUUM FULL); B+S+E: 1.845 → 1.640 → 1.500 | — | — | lock; precisa de folga (o índice UNIQUE de variantes tem 515 MB em produção) | só depois de liberar espaço (Gate D, passo 7) |
| descartadas | `fillfactor = 90` nas variantes: **pior** (fresh +11 MB, steady +5 MB, sem ganho de HOT) [P]; `wal_compression` não foi medido (é parâmetro do servidor) | | | | | — |

### Por que não C (materialização seletiva)

1. **9.777 dos 19.608 produtos que o GA4 observa estão `not_published`** e 699 produtos/1.225 itens de pedido também [M]: o
   histórico do funil e da reconciliação depende de produtos que hoje não estão publicados. A Use Sul só escapa porque o GA4
   dela usa o id do **produto**; outro provider pode usar id de variante, e o contrato é provider-agnostic.
2. Um produto que vira publicado só ganha variantes no próximo full sync (até 24 h) — nesse intervalo o item observado ficaria
   `unresolved` e a cobertura cairia sem erro visível.
3. O ganho (~72,5 % das variantes) é específico do perfil "100 mil estampas, 9 % publicadas". Para o cliente-alvo (5–10 mil,
   quase tudo publicado) é ~0. Fica como opção **por provider/tenant** só se houver regra de negócio explícita.

### Por que não D
Não há o que arquivar: nada está inativo. "Não publicado" não é "inativo" (`is_active = true` em 100 %). Não há política de
retenção nem dependência mapeada que justifique tocar pedidos, itens financeiros ou aliases.

### Estimativas por tamanho de loja [E]

Modelo linear ajustado sobre **14 pontos medidos** (5 k/10 k × 3 mixes × 2 arms + 100 k): `bytes = p·produtos + v·variantes`
(erro máximo 3 % em fresh e 0,7 % em compacto). Unidades: A fresh 845 B/produto + 832,5 B/variante; A compacto 1.239 + 722,6;
B fresh 1.078 + 457,8; B compacto 1.241 + 406,7. "Steady" usa os fatores medidos: A × 1,5–1,7 (1,48 a 100 k, 1,69 a 10 k),
B+S × 1,1 (1,09–1,13). MB, 3 tabelas.

| Produtos | var/prod | A fresh | A steady (×1,6) | B fresh | **B+S steady (×1,1)** | economia fresh (B) | economia steady (B+S vs A) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 k | 10 | 44 | 70 | 27 | 30 | 38 % | 58 % |
| 5 k | 35 | 143 | 229 | 82 | 90 | 43 % | 61 % |
| 5 k | 100 | 401 | 642 | 223 | 246 | 44 % | 62 % |
| **10 k** | 10 | 87 | 140 | 54 | 59 | 38 % | 58 % |
| **10 k** | 35 | 286 | 457 | 163 | 179 | 43 % | 61 % |
| **10 k** | 100 | 802 | 1.283 | 447 | 492 | 44 % | 62 % |
| 50 k | 10 | 437 | 700 | 270 | 297 | 38 % | 58 % |
| 50 k | 35 | 1.430 | 2.287 | 815 | 897 | 43 % | 61 % |
| 50 k | 100 | 4.010 | 6.416 | 2.234 | 2.458 | 44 % | 62 % |
| **100 k** | 10 | 926 | 1.481 | 571 | 628 | 38 % | 58 % |
| **100 k** | 35 (Use Sul) | 3.027 | 4.843 | 1.726 | 1.899 | 43 % | 61 % |
| **100 k** | 100 | 8.490 | 13.583 | 4.730 | 5.204 | 44 % | 62 % |

Validação do modelo: previsto × medido — 10 k publicado A fresh 802 × 789; 100 k Use Sul A fresh 3.027 × 3.007; B fresh 1.726 × 1.716.
As linhas de 100 k com 10 e 100 var/prod são **hipotéticas** (a Use Sul real é 34,8). O "steady" é o **teto** da POC, onde o
sync roda em segundos; em produção ele leva ~19 min e o autovacuum recicla parte das versões mortas (o steady do B a 100 k foi
1,32×, não 1,6×). Por isso o número honesto para decidir é o intervalo **fresh → steady**, não um ponto.

**Em produção (Use Sul, aritmética exata, sem POC):** remover as 3.680.802 identities espelho deixa a tabela com ~125.465 linhas
(105.857 produto + 19.608 GA4) × ~386 B ≈ **48 MB**: **1.400 → ~50 MB = −1.350 MB (−40 % das 3 tabelas, −39 % do banco)**, e evita
o crescimento de +~0,9 GB do próximo bootstrap. **A economia de 1,4 GB não é prometida em bytes de volume:** só vira espaço
livre com `VACUUM FULL` depois do DELETE (3.6), e os aliases GA4 e as identities de produto necessários **permanecem** (48 MB).

Capacidade em termos práticos (volume de 4,6 GB, loja de 10 k com 98 var/prod): A steady 1,33 GB → ~3 lojas por volume;
B+S steady 0,46 GB → ~10. Em dinheiro o armazenamento é barato (referência de mercado ~US$ 0,15/GB-mês, a confirmar no plano) —
o custo real é **folga de volume, WAL, tempo de sync e tempo de backup/restauração**, não o aluguel do disco.

---

# Parte 3 — Gate C: prova de conceito

## 3.1 Método e calibração

- Banco isolado: container `postgres:18` (18.6, **mesma minor de produção**, `fsync`/`full_page_writes` ligados, configuração
  padrão como a do Railway), 2 vCPU/2 GiB, volume próprio. Um segundo container `postgres:16-alpine` (versão do CI) para
  planos e testes. Nada aponta para produção: o harness recusa host ≠ 127.0.0.1 e banco fora de `oria_poc_*`.
- Código sob teste: `runCatalogSync`, `bootstrapCommerceIdentities`, `resolveExternalIds`, `ProductPerformanceService`,
  `reconcileProductPerformance`, `getOpportunities` — os reais, com conector falso que segue o contrato paginado a 100.
- Catálogo sintético: distribuição conjunta **exata** tipo × variantes da Use Sul (39 células), 9,3 % publicados, 18,5 % com
  alias GA4, cores/tamanhos/modelos com as frequências reais, larguras reais de nome/slug/URLs/metadata, SKU compartilhado
  entre produtos (a base "peça lisa"), **ids de variante com correlação 0,42 com a ordem física** (produção: 0,41 — sem isso o
  índice único nasce denso demais). 100 k = **105.857 produtos / 3.680.802 variantes**, idêntico ao real.
- Calibração contra produção (Use Sul, tabelas do catálogo): POC fresh **3.007 MB** × produção **3.359 MB** (−10,5 %). Por
  tabela: identities 1.335 × 1.400 (−5 %); variantes 1.588 × 1.863 (−15 %: produção tem ~1,6 ciclos de update e heap 12 % mais
  largo); produtos 85 × 96. Ou seja, **a POC subestima levemente o custo real**; a economia em bytes de produção tende a ser
  igual ou maior.
- Limites declarados: VM de 2 vCPU (latência com ruído de ±25 %); sync de segundos (steady = teto); catálogos sintéticos; não
  mede o I/O do Railway.

## 3.2 Armazenamento medido [P]

MB (3 tabelas, dados + índices). Coluna "B+S+E" = derived + `per_product` + sem os 2 índices.

| Escala | mix (var/prod) | A fresh | A steady | B fresh | B steady | B+S+E fresh | B+S+E steady | B vs A fresh | B vs A steady |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 k | light (10) | 45 | 76 | 28 | 48 | — | — | 38 % | 37 % |
| 5 k | Use Sul (34,8) | 143 | 242 | 82 | 141 | — | — | 43 % | 42 % |
| 5 k | publicado (98,4) | 396 | 671 | 220 | 382 | — | — | 44 % | 43 % |
| 10 k | light (10) | 90 | 152 | 55 | 96 | — | — | 39 % | 37 % |
| 10 k | Use Sul (34,8) | 286 | 482 | 163 | 282 | 158 | 180 | 43 % | 42 % |
| 10 k | publicado (98,4) | 789 | 1.331 | 440 | 759 | 427 | 464 | 44 % | 43 % |
| **100 k** | **Use Sul (34,8)** | **3.007** | **4.441** | **1.716** | **2.268** | **1.666** | **1.845** | **43 %** | **49 %** |

Loja de 10 k com SKU **único** por variante (caso típico): A 1.062 / 1.724; B 713 / 1.242 (a 3ª cópia — identities `sku` — é
38 % do que sobra); ver B-sku.

Composição a 100 k (fresh, heap + índices): variantes 972 + 616; identities **629 + 705 → 18 + 21** com B; produtos 64 + 21.
Steady = 2× porque o sync regrava toda linha (não-HOT): o mesmo padrão se repete nos ciclos 3 e 4 a 10 k (513,3 → 513,8 MB; execução com ids sequenciais, `results/v1-sequential-ids/`).

## 3.3 Custo de manutenção (100 k Use Sul) [P]

| Fase | A atual | B derived | B+S+E |
| --- | --- | --- | --- |
| sync#1 (carga inicial) | 278 s · 5,5 GB WAL | 262 s · 5,5 GB | 265 s · 4,3 GB |
| **bootstrap#1** | **204 s · 3,6 GB WAL** | **27 s · 0,13 GB** | 23 s · 0,13 GB |
| sync#2 (segundo full sync) | 450 s · 11,1 GB | 463 s · 11,0 GB | **220 s · 3,0 GB** |
| **bootstrap#2** (re-upsert) | **346 s · 7,4 GB** | **26 s · 0,12 GB** | 24 s · 0,13 GB |
| pico de memória do Postgres (container) | 910 MB (bootstrap#2) | 720 MB | 724 MB |
| pico de heap do Node | 86 MB | 63 MB | 56 MB |

O bootstrap #2 no A é o evento do alerta: +865 MB e 7,4 GB de WAL numa instrução. No B ele deixa de existir (−96…98 % de WAL,
−87 % de tempo). Cada sync no A gera ~18 GB de WAL no perfil Use Sul (compatível com os 29 GB medidos em 8 dias de produção).

## 3.4 Latência da resolução e dos serviços

Rodadas **alternadas** entre os modos (a deriva da VM afeta todos), 15 rodadas + 2 de aquecimento, p50/p95 em ms, 20 k ids no
máximo. "Estado final" = banco onde as linhas espelho não existem (o que o modo derived produz); "transição" = banco A com o
modo derived (as linhas espelho ainda existem e são consultadas **e** ignoradas: são 2 consultas).
**Corretude:** em todos os conjuntos e nos 4 bancos os mapas id→produto foram **idênticos** entre os modos (18.000 resolvidos +
2.000 sem correspondência no misto de 20 k; 0 conflitos).

PostgreSQL 18, 100 k (3,68 M variantes):

| Conjunto | A (materialized) | **B estado final** | B na transição |
| --- | ---: | ---: | ---: |
| produto 5 k | 74 / 159 | 69 / 123 | 64 / 145 |
| variante 5 k | 141 / 236 | **82 / 136** | 205 / 346 |
| variante 20 k | 1.103 / 1.457 | **484 / 740** | 1.383 / 2.976 |
| desconhecidos 20 k | 81 / 124 | 180 / 218 | 99 / 169 |
| misto 20 k (12 k prod + 6 k var + 2 k desc.) | 442 / 642 | **216 / 311** | 487 / 801 |
| frio (shared_buffers vazio) misto / variante 5 k | 758 / 455 | 500 / 256 | 920 / 469 |

PostgreSQL 16 (CI), 10 k publicado (983 k variantes):

| Conjunto | A | B estado final | B na transição |
| --- | ---: | ---: | ---: |
| produto 5 k | 170 / 318 | 14 / 28 | 136 / 228 |
| variante 5 k | 307 / 707 | 219 / 427 | 620 / 1.620 |
| variante 20 k | 383 / 705 | 238 / 479 | 551 / 1.226 |
| desconhecidos 20 k | 538 / 1.123 | 311 / 1.701 | 1.046 / 2.442 |
| misto 20 k | 522 / 725 | 265 / 988 | 820 / 1.152 |

Serviços de ponta a ponta (100 k, 19.447 ids GA4 observados, 2.000 pedidos), p50 / p95:

| Serviço | A | B na transição | B estado final |
| --- | ---: | ---: | ---: |
| `prepareStoreAnalytics` | 1.302 / 1.754 | 1.264 / 1.366 | 1.281 / 1.487 |
| `getProductPerformance` (página de 50) | 1.377 / 1.724 | 1.418 / 1.583 | 1.397 / 1.761 |
| `reconcileProductPerformance` | 5.014 / 6.006 | 4.847 / 5.447 | 4.909 / 5.557 |
| `getOpportunities` | 1.408 / 1.670 | 1.388 / 2.057 | 1.447 / 1.775 |

Leitura honesta: (1) o **estado final não regride** — fica igual ou melhor porque o índice consultado é menor (389 MB contra
495 MB) e a tabela de identities some do caminho; (2) o **estado de transição custa mais** nos ids de variante (2 consultas, até
+45–100 %), por isso o Gate D encurta essa janela e mede na dupla leitura; (3) o caso "20 k ids sem correspondência" é 2× mais
lento no B (uma consulta a mais que erra): irrelevante para o GA4 real (ids observados são do catálogo) mas vale como
otimização futura (pular a consulta de identities quando não há linha não-espelho); (4) os serviços são dominados por trabalho
que a mudança não toca — a Use Sul resolve pelo **id de produto**, então o passo de variante quase não roda. As diferenças
entre bancos distintos (mat × der) misturam o efeito do tamanho do arquivo; as colunas "A" e "B na transição" são do
**mesmo banco**, alternadas.
(5) **Achado de portabilidade:** minha primeira forma da consulta derivada (JOIN com CTE recursivo) virou *Hash Join + Parallel
Seq Scan da tabela inteira* no PG 16 (66 k buffers a 983 k variantes; o 18 só escapava pelo skip scan). Comparei 4 formas nas
duas versões e adotei a **d** (`provider = ANY(ARRAY(SELECT … providers))`, índice nas duas):

| Forma (p50 ms) | PG18 var 5 k | PG18 var 20 k | PG18 sem corresp. 20 k | PG16 var 5 k | PG16 var 20 k | PG16 sem corresp. | plano |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| a JOIN + CTE | 58 | 456 | 20 | 273 | 254 | 234 | **Seq Scan no PG16** |
| b LATERAL + OFFSET 0 | 143 | 463 | 98 | 151 | 194 | 425 | nested loop |
| c sem provider | 58 | 424 | 18 | 225 | 294 | 247 | índice (depende do skip scan no 18) |
| **d init-plan ARRAY** | **52** | **370** | **17** | 223 | 253 | 239 | **índice nas duas** |

## 3.5 Planos de consulta e índices (evidência para E)

- Produção (`EXPLAIN` sem `ANALYZE`): a resolução `namespace LIKE '%.variant_id' AND external_id = ANY(...)` usa o UNIQUE com
  `external_id` como condição (skip scan do PG 18); a busca `ga4.item_id` usa `idx_…_namespace` com filtro; o bootstrap
  `INSERT … SELECT` e a desativação do sync fazem **Seq Scan** de `commerce_product_variants` (3,68 M linhas) — os índices
  `sync_run` e `ativos` **nunca são escolhidos** (0 scans em ~8 dias). `idx_…_produto` (0 scans) **fica**: é ele que torna
  barato o `ON DELETE CASCADE` da FK composta.
- PG 16 (CI) não tem skip scan: qualquer consulta sem `provider` nas variantes exige o filtro explícito (por isso a forma d).
- Regra respeitada: nada foi removido; PK, UNIQUE, FKs e o índice do cascade ficam. O ganho de E é 2,9 % — não justifica risco
  antes das fases 1–2.

## 3.6 Poda e rollback (Gate D, medidos no fork da POC de 100 k) [P]

Só o caminho que a política do repositório permite: o gate `no-unsafe-truncate` (release gate, `productization-gate`) **proíbe
`TRUNCATE` de tabela de tenant** em `scripts/`, migrations e app — ele atingiria todas as Organizations. Minha primeira versão do
experimento usava `TRUNCATE` + reinserção; o gate a reprovou (11 testes do gate falharam na suíte completa, todos por isso), então
**removi o experimento** e refiz a medição com DELETE por Organization + `VACUUM FULL`. A medição antiga fica só como referência
(`results/prune-…rev1-truncate-experiment-superseded.json`: 4,1 s, 139 MB de WAL, mas **não recomendada**).

| Experimento | Tempo (rev2, máquina compartilhada) | WAL | Efeito no espaço |
| --- | ---: | ---: | --- |
| P1 `DELETE` em lotes de 50 k (75 lotes), por Organization, + `VACUUM` | 651 s (rev1, máquina livre: 139 s) | 1,3 GB | **tabela não encolhe** (1.336 → 1.336 MB) |
| **P1b `VACUUM FULL` depois do DELETE** | **3,6 s** (rev1: 0,7 s) | 34 MB | **1.336 → 35 MB** (só sobram 125 mil linhas: lock exclusivo de segundos) |
| P5 leitura de resolução concorrente durante o `VACUUM FULL` | terminou após 3,6 s (espera o lock) | — | bloqueio curto e limitado |
| P4 `bootstrap derived` depois da poda | 51 s | 84 MB | **não recria** as linhas (105.887 = 105.857 produtos + 30 SKU) |
| **P3 rollback: `bootstrap materialized` regenera** | 764 s (rev1: 209 s) | 4,3 GB | 1.352 MB; **md5 do conjunto idêntico ao original** |

Os tempos da rev2 foram medidos com a máquina disputada por outras sessões (3–4× mais lentos que a rev1): usar como **teto**.
Conclusões: (1) o DELETE sozinho **não devolve espaço** e escreve 1,3–1,6 GB de WAL — num volume com <1 GB livres isso já é
risco, por isso a poda **exige folga (≥ 2 GB) e pausas entre lotes** para o checkpoint reciclar o WAL; (2) o `VACUUM FULL` que
fecha o processo é rápido porque a tabela já está quase vazia; (3) rollback = regenerar (as linhas são **derivadas**), com
conferência de hash, e também precisa de ~1,4 GB de folga + 4 GB de WAL.

## 3.7 Compatibilidade — testes diferenciais e de segurança

Arquivos novos (Postgres real, role da aplicação com RLS): `test/invariants/product-identity-derived-variants.test.js` (16 testes)
e `test/invariants/catalog-sync-per-product.test.js` (5 testes). Passaram em **PG 16 e PG 18**; os 21 testes existentes do
resolvedor e os 15 do sync continuam verdes sem alteração.

| # | Cenário exigido | Resultado |
| --- | --- | --- |
| 1 | igualdade de product id | antigo = novo (`matchedVia: product_id`) |
| 2 | igualdade de variant id (3 variantes, 2 produtos) | antigo = novo; variante → produto correto |
| 3 | SKU único | antigo = novo (identity `sku` gravada continua) |
| 4 | SKU duplicado | nunca vira identity; `unresolved` nos dois |
| 5 | alias manual prioritário | manual vence o catálogo; bootstrap `derived` posterior não desfaz |
| 6 | identidade histórica/inativa | variante e produto desativados continuam resolvendo |
| 7 | colisão entre providers | **conflito** nos dois modos, mesmos candidatos; `resolveAndPersist` nunca grava conflito |
| 8 | itemId sem correspondência | `unresolved` nos dois |
| 9 | aproximação | caixa diferente, prefixo/sufixo, `%`, `_` nunca casam em nenhum modo |
| + | única diferença aceita | variante que o bootstrap nunca viu: derived resolve, materialized ainda não; `dual` reporta `derived_only` e devolve o antigo |
| + | linha espelho **velha** (variante que mudou de produto, antes da poda) | derived segue o catálogo; `dual` reporta `different_product` (achado de revisão: sem esse tratamento, uma linha velha venceria o catálogo durante a transição) |
| + | `materialized_only`, 4 providers na mesma Store, modo inválido | cobertos |
| **Tenancy** | 2 Organizations com o **mesmo** id de variante | cada uma resolve o próprio produto; contexto B pedindo a Organization A recebe `unresolved` (RLS), inclusive em `dual` |

Sync `per_product` (differencial, 8 passos: carga, sem mudança, variante nova/removida/alterada, produto some, volta, variante
muda de produto, produto sem variantes, reativação): **estado idêntico ao `last_seen` a cada passo**; não regrava linha que não
mudou (mesmo `xmin`); isolamento entre Organizations com mesmo provider/ids. **Única diferença assumida — falha parcial:** o
`last_seen` não desativa nada; o `per_product` aplica só o que o provider **já informou** (produto lido sem a variante), nunca
desativa produto nem variante de página não lida. Isso muda o texto "nada vira inativo numa falha" do cabeçalho de
`catalog-sync.js` → precisa de decisão de produto antes da fase 2 (por isso fica atrás de flag).

Nenhum contrato de conector mudou: `lib/connectors/**` não foi tocado; `CommerceConnector` continua provider-agnostic.
Suíte completa: ver "Verificações" ao fim.

---

# Parte 4 — Gate D: plano de rollout reversível (**não executado**)

Pré-requisitos bloqueantes (antes do passo 5): (a) **backup com restauração testada** num serviço descartável; (b) folga de
volume ≥ 2 GB (o alerta do início já exige agir antes do próximo sync); (c) janela de baixo tráfego para o passo 5.

| # | Passo | Ação | Critério de saída | Reversão |
| ---: | --- | --- | --- | --- |
| 0 | **Estancar o risco de disco** | **aumentar o volume** (ou suspender o sync) antes do próximo ciclo; `derived` sozinho não basta — o full sync continua gerando ~11 GB de WAL | folga ≥ 2 GB antes de qualquer sync | — |
| 1 | Novo resolvedor, leitura compatível, flag | deploy do código desta branch com **padrão `materialized`** (zero mudança de comportamento; sem migration) | testes verdes em PG 16/18; smoke da Jornada | remover a flag / reverter o deploy |
| 2 | **Dupla leitura + telemetria** (`dual`), sem exclusão | `PRODUCT_IDENTITY_VARIANT_MODE=dual` por 2–7 dias; o log `[PRODUCT_IDENTITY] divergência materialized×derived` agrega por tipo. Rodar também a antijunção **exaustiva** 3,68 M × 3,68 M em lotes (chaveada por `external_id`, 50 k por vez, fora do pico, somente leitura) | `different_product = 0`, `materialized_only = 0`; `derived_only` só para variantes novas | voltar a `materialized` |
| 3 | **Parar de gravar** as linhas redundantes | `derived`: o bootstrap não escreve mais `variant_id`; a resolução ignora linhas espelho | 1 sync completo com `variantIdentities = 0`; crescimento de identities = 0 | `dual`/`materialized` (o bootstrap regenera) |
| 4 | Validar sync + Jornada/GA4 + Commerce-only | reconciliação, `getOpportunities`, Desempenho de Produtos na Use Sul; uma Organization Commerce-only e uma GA4-only de teste; 2 Organizations com o mesmo id de variante | cobertura GA4 igual à do passo 2; p95 da resolução ≤ baseline + 20 % | idem 3 |
| 5 | **Backup verificado + poda em lote/por tenant** | por Organization: `DELETE` em lotes de 50 k com pausa entre lotes (limita I/O e WAL) apenas das linhas `source = 'commerce_sync' AND namespace LIKE '%.variant_id'`, com contagem e md5 antes/depois; em seguida `VACUUM FULL product_external_identities` (lock de segundos). Aborta se a folga < 2 GB. **Nunca `TRUNCATE`** (gate do repositório) | 125.465 linhas restantes; espaço liberado ≈ 1,35 GB | regenerar (bootstrap `materialized`) e conferir o md5 |
| 6 | Só depois **podar os provadamente redundantes** | nada além do passo 5 (aliases GA4, product ids, manuais e SKU único ficam) | — | — |
| 7 | **Recuperar espaço físico** com folga | `REINDEX INDEX CONCURRENTLY` dos índices de variantes um a um (o UNIQUE tem 515 MB: precisa dessa folga *depois* do passo 5); `VACUUM FULL` só em janela. Ganho medido a 100 k: −0,7 GB só com REINDEX | volume < 60 % | — (REINDEX CONCURRENTLY é reversível: o índice antigo permanece até o novo ficar pronto) |
| 8 | Fase 2: `CATALOG_SYNC_VARIANT_SWEEP=per_product` (opt-in por tenant) | após decisão de produto sobre falha parcial | sync −52 % de tempo, −73 % de WAL; estado final idêntico ao anterior | voltar a `last_seen` (o 1º sync reestampa) |
| 9 | Fase 2b: SKU derivado | migration com índice parcial `(org, store, sku) WHERE sku IS NOT NULL` + regra de unicidade | −205 MB por 10 k publicado com SKU único | remover o índice + bootstrap `materialized` |

**Controle para a sincronização periódica não recriar as linhas removidas:** o bootstrap em `derived` **não tem** o `INSERT` de
variantes (provado no P4: 105.887 linhas após o bootstrap seguinte); um teste de regressão afirma `variantIdentities = 0`; e um
alarme deve contar `product_external_identities WHERE namespace LIKE '%.variant_id' AND source = 'commerce_sync'` (esperado 0 após
o passo 5 — qualquer valor > 0 é reintrodução).

**Observabilidade a implantar (meta):**
- crescimento mensal **por tenant**: bytes de `commerce_*` e `product_external_identities` por `organization_id` (amostra por
  `pg_column_size` + contagem; cardinalidade de tag = nº de Organizations, aceitável), `storage.catalog.bytes` / `storage.catalog.rows`;
- alertas: volume > 70 % (aviso) e > 80 % (crítico); `pg_wal` > 1,5 GB; duração e WAL por full sync (`WAL/sync` > 2× a mediana);
  linhas espelho > 0 (acima); `commerce_catalog_sync_logs` com `running` órfão > 3 h;
- painel: bytes por variante (531 → ~458 B com B) e por produto; projeção de dias até 80 % do volume.

**Riscos preservados/monitorados:** conectores (contrato intocado); Jornada de Compra (resolução idêntica nos 9 cenários e em 100 k ids);
pedidos (não leem variantes: `commerceVariantId` sempre `null`); performance (neutra no estado final; **a janela de transição
custa mais** — passo 2/3 devem ser curtos); aliases manuais (vencem o catálogo); tenancy (RLS, teste com 2 Organizations).

---

# Verificações e limites

**Não medido / declarado como amostra:** equivalência exaustiva 3,7 M × 3,7 M (amostras de 55–59 mil em duas estratégias, 100 %;
o passo 2 a torna exaustiva); backup restaurável; `wal_compression`; latência no hardware do Railway (a VM tem 2 vCPU: p95 com
ruído); SKU derivado (só o custo do índice e um `EXPLAIN` foram medidos; o código **não** foi escrito); comportamento com
múltiplos providers de verdade (só o teste sintético de 4); `idx_scan` cobre ~8 dias.

**Como reproduzir:** `apps/panel/scripts/dev/storage-poc/` — `run.cjs` (experimento), `run-matrix.sh` (matriz 5 k/10 k),
`bench.cjs`/`bench-services.cjs` (latência alternada), `sqlplans.cjs` (formas da consulta), `prune-poc.cjs` (poda/rollback),
`generator.cjs` + `fixtures/usesul-catalog-shape.json` (forma real agregada, sem PII), `results/*.json` (todos os números
acima). Container: `docker run -d --name oria-storage-poc-pg -e POSTGRES_PASSWORD=poc -e POSTGRES_DB=oria_poc -p 127.0.0.1:55432:5432 postgres:18`.

## Verificações executadas

- **Suíte completa do painel** (Postgres 16, CI): 2.398 testes → 2.387 passaram e 11 falharam; **os 11 eram do release gate**
  (`no-unsafe-truncate` reprovou meu script de poda com `TRUNCATE`). Removi o `TRUNCATE`; `productization-gate.test.js`: **44/44**.
  Não repeti a suíte completa depois da correção (só o gate depende do conteúdo estático de `scripts/`).
- Testes novos: 16 (`product-identity-derived-variants`) + 5 (`catalog-sync-per-product`), em **PG 16 e PG 18**; os 21 do resolvedor
  e os 15 do sync existentes passam sem alteração.
- Sem migration, sem alteração em `lib/connectors/**`, sem push/merge/deploy. Alterações **não commitadas** na branch
  `feature/storage-optimization-poc` (worktree `/Users/gtomazi/projects/oria-storage-poc`).

## Próxima rodada

Comando pronto: `docs/commands/ORIA_RODADA_IDENTIDADE_DERIVADA_E_DISCO.md`.
