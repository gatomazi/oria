# Janela única de migração de armazenamento — runbook

Origem: `docs/architecture/storage-audit-2026-09.md` e `ORIA_MIGRACAO_UNICA_ARMAZENAMENTO_PRODUCAO.md`.
Regra: nenhum passo destrutivo sem (1) backup restaurável verificado, (2) folga de volume e (3) app em `derived`.
Nunca `TRUNCATE` de tabela de tenant (gate `no-unsafe-truncate`).

## Variáveis de ambiente (serviço `oria-panel`)

| Variável | Valor | Efeito |
| --- | --- | --- |
| `CATALOG_SYNC_DISABLED` | `1` | desliga o sync canônico (agendador, boot, pós-conexão, botão) e os ticks/boot do legado; o boot nunca reprograma varredura |
| `PRODUCT_IDENTITY_VARIANT_MODE` | `materialized` (padrão) → `dual` → `derived` | de onde vem a identity de variante |
| `CATALOG_SYNC_VARIANT_SWEEP` | `last_seen` (padrão) → `per_product` | `per_product` só grava variantes que mudaram; tombstones aplicados só após sucesso global |
| `CATALOG_SYNC_RETRY_COOLDOWN_HOURS` | `6` (padrão) | espera após run que não fechou em sucesso |
| `CATALOG_SYNC_PAGE_DELAY_MS` | `0` (padrão) | ritmo mínimo entre páginas |
| `CATALOG_SYNC_RATE_LIMIT_RETRIES` | `6` (padrão) | repetições da MESMA página em 429 (respeita `Retry-After`) |
| `PG_VOLUME_CAPACITY_GB` | capacidade do volume (ex.: `19`) | habilita o alerta > 70 % / > 80 % do `[STORAGE_GUARD]` |

## Sequência

1. Estado: `df`/`du` do PGDATA e do `pg_wal`, slots, logs do catálogo, deploy atual. Folga ≥ 8 GB.
2. `CATALOG_SYNC_DISABLED=1` **antes** do deploy do código novo; confirmar que nenhum run está `running`.
3. Backup: `pg_dump -Fc` fora do volume + restauração testada num PostgreSQL 18 descartável (assinaturas de schema/RLS/funções e contagens exatas de todas as tabelas idênticas).
4. Deploy com `materialized`; smoke (auth, Jornada, Desempenho, GA4, Commerce-only, pedidos).
5. `dual`: comparação exaustiva (identity→variante e variante→identity, lotes de 50 mil, tenant-scoped). Critério: zero `materialized_only`, zero `different_product`.
6. `derived`: bootstrap controlado com `variantIdentities = 0`; conferir `ga4.item_id`, variante, pedido pago, reconciliação, oportunidades.
7. Poda: `scripts/ops/prune-mirror-identities.sh` dentro do container do Postgres (`--confirm-derived-mode-and-backup`), depois `VACUUM (FULL, ANALYZE)` (o script faz).
8. `per_product` + **um** full sync piloto: medir páginas, duração, 429, WAL, crescimento, identidades escritas, GA4.
9. Reativar (`CATALOG_SYNC_DISABLED` removido) com cooldown/pacing; conferir jobs no restart e no tick seguinte.

## Rollback
- Antes da poda: voltar a flag para `dual`/`materialized` ou reverter o deploy.
- Depois da poda: restaurar o dump verificado **ou**, com folga e sync desligado, bootstrap `materialized` (regenera ~3,68 M linhas; ~4 GB de WAL) e comparar contagem e hash (SHA-256 do conjunto espelho, `scripts/ops/verify-mirror-equivalence.js`) com o baseline.
- Nunca `pg_resetwal` nem apagar `pg_wal`.

## Evidências já obtidas (antes de qualquer alteração de produção)

- **Backup:** `pg_dump -Fc -Z 3` do banco `railway` (PG 18.6) gerado no container do Postgres em `/tmp` (fora do volume de dados), transferido em pedaços verificados por SHA-256 (o stdout binário do `railway ssh` **corrompe** — usar base64), 309.973.028 bytes, SHA-256 `4142423c…5017`, guardado em `~/oria-backups` (modo 600).
- **Restauração testada** em PostgreSQL 18.6 descartável: 1 min 41 s; assinaturas idênticas às de produção para colunas (1084), índices (345), constraints (1007), RLS (86 tabelas), policies (67), funções (45) e migrations (45); contagens exatas idênticas nas **86 tabelas** (variantes 3.680.802 · identities 3.806.268 · produtos 105.857 · pedidos_ink 4.672 · itens 6.299).
- **Equivalência exaustiva** (produção, somente leitura, 148 lotes de 50 mil, 4 min): identity→variante e variante→identity = 3.680.802 nos dois sentidos, 100 % mesmo produto, 0 exceções, 0 linhas não-espelho no namespace de variante, 0 variantes inativas. SHA-256 do conjunto espelho: `4ac0625d5f0dd5a8e5cd2e0ee15c0a72e89aefae94c31824afe454ac333b3366`.
- **Ensaio da poda numa cópia fiel** (o backup restaurado): `prune-mirror-identities.sh` — 74 lotes, **3 min 11 s**, 1,38 GB de WAL, linhas não-espelho intactas (125.466 | md5 igual antes/depois), `VACUUM FULL` → tabela de **2.217 MB → 41 MB**.
- **Ensaio do rollback** (bootstrap `materialized` na cópia podada): 231 s, 3,39 GB de WAL, 3.680.802 linhas regeneradas, **SHA-256 do conjunto idêntico ao baseline**.
- **Latência da resolução em dados reais** (cópia): resultados idênticos nos 5 conjuntos; `derived` no estado final (pós-poda) vs `materialized`: variante 5 k p50 88 vs 128 ms, variante 20 k 442 vs 1.417 ms, misto 20 k 324 vs 545 ms, desconhecidos 20 k 93 vs 101 ms.
- **Testes na versão final:** suíte completa PG 16 — **2.416/2.416**; subconjunto afetado em PG 18 — 84/84; `productization-gate` 44/44; `tsc -b --noEmit` e `vite build` verdes.
