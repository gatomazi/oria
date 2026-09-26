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
