# ORIA — Rodada: parar o risco de disco e implantar a identidade de variante derivada

**Origem:** `docs/architecture/storage-audit-2026-09.md` (auditoria somente leitura + POC). **Esta rodada já pode escrever em
produção, mas só o que está listado aqui.** Nada de `TRUNCATE` de tabela de tenant (o gate `no-unsafe-truncate` proíbe).

## Contexto que não se discute
- 1 Organization = 1 Store. `CommerceConnector` continua provider-agnostic; nenhum arquivo de `lib/connectors/**` muda.
- `product_external_identities` guarda 3.680.802 linhas `reserva_ink.variant_id` que são espelho exato de
  `commerce_product_variants`. Só os 19.608 aliases `ga4.item_id` e as 105.857 identities de produto são necessários.
- O full sync agendado da Use Sul já falhou por `No space left on device` (2026-09-26 02:46 UTC, volume 96 %).

## Pré-requisitos bloqueantes (parar e pedir ao dono se algum faltar)
1. Volume do Postgres ampliado (≥ 8 GB) **ou** sync suspenso; confirmar `df` com ≥ 2 GB livres antes de qualquer escrita pesada.
2. Backup com **restauração testada** num serviço descartável (registrar o resultado).
3. Worktree limpo a partir do `origin/main` **depois** do merge da branch `feature/storage-optimization-poc` (o dono revisa e
   faz o merge; eu não faço merge). Rodar `git fetch` e conferir migrations de `origin/main` (não há migration nesta rodada).

## Passos (Gate D do relatório)
1. **Deploy com padrão `materialized`** (comportamento idêntico ao atual). Suíte completa + `productization-gate`. Smoke da
   Jornada de Compra e do Desempenho de Produtos + Claude in Chrome (mudança não é visível na UI, mas o smoke prova que nada quebrou).
2. `PRODUCT_IDENTITY_VARIANT_MODE=dual` por 2–7 dias. Acompanhar `[PRODUCT_IDENTITY] divergência materialized×derived`.
   Rodar a antijunção **exaustiva** 3,68 M × 3,68 M em lotes de 50 k (somente leitura, fora do pico, `statement_timeout`).
   Critério: `different_product = 0` e `materialized_only = 0`.
3. `PRODUCT_IDENTITY_VARIANT_MODE=derived`. Um full sync completo com `variantIdentities = 0`. Validar Jornada/GA4, Commerce-only
   e uma Organization de teste com o mesmo id de variante. p95 da resolução ≤ baseline + 20 %.
4. **Poda por Organization** (só depois do backup verificado): `DELETE` em lotes de 50 k com pausa (WAL), conferindo contagem e
   md5 antes/depois, e `VACUUM FULL product_external_identities`. Abortar se a folga < 2 GB. Confirmar que o bootstrap seguinte
   não recria linhas.
5. Métricas/alertas do relatório (volume > 70/80 %, `pg_wal` > 1,5 GB, linhas espelho > 0, WAL por sync).
6. Checkpoint: o que mudou, testes, controles negativos, CI, deploy, smoke API/log/Chrome, dívidas, GO/NO-GO.

## Fora do escopo (decidir antes)
- `CATALOG_SYNC_VARIANT_SWEEP=per_product` (muda o comportamento numa falha parcial — decisão de produto).
- SKU derivado (migration de índice) e `REINDEX CONCURRENTLY` das variantes.
- Materialização seletiva por status de publicação (rejeitada como padrão no relatório).

## Rollback em qualquer passo
Voltar a flag para `materialized`/`dual`. Depois da poda: rodar o bootstrap `materialized` (regenera as linhas; ~4 GB de WAL e
~1,4 GB de folga) e conferir o md5 do conjunto mecânico antes de voltar a ler só as identities.
