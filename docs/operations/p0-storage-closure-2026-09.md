# ORIA-P0-001 — Fechamento do risco de storage

> Coleta de produção em **2026-09-30 12:46–12:54 UTC**, somente leitura, autorizada por escrito pelo dono para esta finalidade.
> Código auditado: `origin/main` (gate mergeado no PR #49, `8c08e0e`; painel em produção no deploy `191c4a0c`, commit `c5a015b`, PR #50).
> Nada foi alterado em produção. Consultas SQL ao Postgres de produção foram **negadas pelo classificador do ambiente** e **não foram
> contornadas** (ver §4).

## 1. Status

```text
RESOLVIDO
```

com duas lacunas de observação declaradas (§12): a lista das 10 maiores relações **não foi coletada**, e "espelho de variante = 0" é
**inferido** dos logs do vigia, não consultado no banco. Nenhuma das duas está entre os critérios de fechamento.

## 2. Resumo executivo

- **Produção está saudável:** volume de 19 GB com **17 % usado** (3,04 GiB), 15,9 GB livres, `pg_wal` 465 MB, banco 2,54 GiB.
- **Produção roda o modo seguro:** `PRODUCT_IDENTITY_VARIANT_MODE=derived` + `CATALOG_SYNC_VARIANT_SWEEP=per_product`; o espelho parece ter sido podado
  (banco de ~3,5 GB em 26/09 → 2,18 GiB em 28/09) e o volume foi ampliado (de ~5 GB para 19 GB) — **inferido** dos números, sem registro
  no repositório da execução da janela.
- **Dois syncs completos após a mudança, ambos `success`, sem `No space left`:** 29/09 03:07 UTC e 30/09 05:19 UTC. No de 30/09,
  `variantes gravadas` (700.931) é **exatamente** o acréscimo de variantes vistas (4.301.458 → 5.002.389) → **zero reescrita de linha
  inalterada**; o de 29/09 (528.100 gravadas) é compatível, mas o total do sync anterior não está nos logs. Pico de `db+wal` = 3,54 GiB (18,6 % da capacidade configurada), de uma base de 2,47 GiB.
- **O gate novo está em produção** (PR #49) e mede corretamente (`pg_ls_waldir` legível, sem fallback para o teto).
- **Causa raiz confirmada e eliminada:** reescrita total de ~3,68 M identities + ~11 GB de WAL por ciclo num volume de ~5 GB.

## 3. Estado atual da capacidade

```text
AMBIENTE = PRODUÇÃO   (Railway project "oria", environment "production")
CAPACIDADE TOTAL:   19.138.976 KiB  (≈ 18,25 GiB · "19 GB" no Railway)   volume postgres-volume, /dev/zd1840
USADO:              3.184.900 KiB   (≈ 3,04 GiB)
LIVRE:              15.937.692 KiB  (≈ 15,20 GiB)
PERCENTUAL:         17 %
PG_VOLUME_CAPACITY_GB: 19
CONFIGURAÇÃO COERENTE: SIM (com ressalva: o vigia usa 19 × 1024³ = 18,99 GiB; o filesystem tem 18,25 GiB → o vigia superestima a
                        capacidade em ~4 %; recomenda-se 18)
```

Outros volumes: `oria-panel-volume` (uploads, `/app/storage`) não medido; `Postgres-KIav` (banco do serviço WhatsApp) com 4,5 GB,
**2 % usado**, `pg_wal` 33 MB — **fora do alcance do vigia** (só o banco do painel é monitorado).

## 4. Estado atual do Postgres

| Item | Valor | Fonte |
|---|---|---|
| Serviço do painel | `Postgres` (`postgres.railway.internal`), `DATABASE_URL` do painel aponta para ele | variáveis (host apenas) |
| `pg_database_size` | **2,54 GiB** | log `[STORAGE_GUARD]` (consulta do próprio painel) |
| `pg_wal` | **0,45 GiB** no log; **465 MB / 31 segmentos** no disco; pico observado **1,00 GiB** | log + `du` |
| `du pgdata` | 3,1 GB (banco + WAL + outros bancos) | `railway ssh` |
| Crescimento | 2,18 → 2,39 (29/09) → 2,54 GiB (30/09): **+0,21 e +0,15 GiB por sync** | logs do vigia, 200 amostras |
| 10 maiores relações / índices | **NÃO COLETADO** | consultas ao Postgres de produção via `railway ssh … psql` foram negadas pelo classificador; não reenviei em pedaços |

Para completar, o dono pode rodar (somente leitura):

```sql
SELECT n.nspname||'.'||c.relname AS relacao, pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','m') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
 ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10;
SELECT count(*) AS espelho_variante FROM product_external_identities WHERE source='commerce_sync' AND namespace LIKE '%.variant_id';
SELECT status, started_at, finished_at, pages_processed, variants_seen, variants_inserted, variants_updated, error_code
  FROM commerce_catalog_sync_logs ORDER BY started_at DESC LIMIT 5;
```

## 5. Estado do sync de catálogo

Logs do painel cobrem **2026-09-28 13:00 UTC → agora** (deploys anteriores foram removidos; não há log antes disso).

| Horário (UTC) | Status | Páginas | Variantes vistas | Gravadas | Desativadas | WAL (cluster) | Erro |
|---|---|---:|---:|---:|---:|---:|---|
| 2026-09-29 03:07 | success | 1.150 | 4.301.458 | 528.100 | 0 | ≈ 2.810 MB | — |
| 2026-09-30 05:19 | success | 1.378 | 5.002.389 | 700.931 | 0 | ≈ 3.195 MB | — |

- Nenhum `partial_failure`, nenhum `No space left on device`/`ENOSPC`, nenhuma linha `[CATALOG_SYNC_SCHEDULER]` de erro e nenhum
  log de nível `error` na janela observada.
- Frequência: 1 sync a cada ~24 h (`catalogSyncMaxAgeMs`), tick de 1 h com guarda; após falha, 6 h (`CATALOG_SYNC_RETRY_COOLDOWN_HOURS=6`).
- Duração e identities processadas: **não observadas** (o log de conclusão não traz início; `bootstrapCommerceIdentities` não loga contagem).
  Em `derived` o bootstrap não grava identity de variante por desenho.
- `CATALOG_SYNC_DISABLED`: **ausente** → sync habilitado. Nenhum sync foi disparado por mim.
- Sem alertas `[STORAGE_GUARD] tenant:` (espelho reintroduzido ou run órfão) em nenhuma das 200 amostras → **espelho = 0 inferido**.

## 6. Causa raiz confirmada

1. **Processo:** full sync agendado (26/09 02:44 UTC) + `bootstrapCommerceIdentities` logo depois.
2. **Volume:** combinação de WAL, tabela e índices de `product_external_identities` (~3,68 M linhas de espelho de variante) e
   reescrita não-HOT de variantes, num volume de ~5 GB com 96 % de uso.
3. **Reescrita total:** `ON CONFLICT DO UPDATE` sem `IS DISTINCT FROM` (corrigido em `d173ff2`) e varredura `last_seen` que regrava toda
   variante vista (substituída por `per_product`).
4. **Situação atual:** o catálogo completo tem ~**5,0 milhões de variantes** (o run de 26/09 parou na página 144 de 1.378, por isso o
   número "658 mil" da auditoria inicial); **cresce ~0,5–0,7 M variantes/dia**. Com `per_product` só essas linhas novas são gravadas.
5. **Correção efetiva:** (a) espelho podado e modo `derived`; (b) `per_product`; (c) volume ampliado para 19 GB; (d) cooldown de 6 h;
   (e) vigia de armazenamento; (f) **gate pré-sync** (PR #49, nesta rodada de entregas).

## 7. Storage guard

| Pergunta | Resposta (produção observada) |
|---|---|
| Ativo? | **Sim** — 200 linhas `[STORAGE_GUARD]` entre 28/09 13:00 e 30/09 12:45, a cada 10 min |
| Mede bem? | **Sim** — WAL medido por `pg_ls_waldir` (nenhuma linha com sufixo `(teto)`); banco 2,54 + WAL 0,45 = 2,99 GiB contra `df` 3,04 GiB (**–1,6 %**) |
| Limiares | aviso > 70 %, crítico > 80 %, WAL > 1,5 GB (inalterados) |
| Decisão do gate hoje | **PERMITE** (15,8 % calculado, 17 % real) |
| Gate é chamado? | sim, por `syncCommerceCatalog`; o sync de 30/09 05:19 (primeiro após o deploy do PR #49) passou por ele (uso 18,5 % no início); o de 29/09 03:07 rodou antes do gate |
| Bloqueia | início de full sync do catálogo canônico; **não** bloqueia escritas comuns nem um sync já em andamento |
| Fail-open aceitável? | ver §9 |

```text
USO REAL DO VOLUME:          3,04 GiB / 18,25 GiB = 16,6 %  (df: 17 %)
USO ESTIMADO PELO GUARD:     2,99 GiB / 18,99 GiB = 15,8 %
DIFERENÇA:                   ~1 ponto percentual (subestima; denominador 4 % maior + ~0,05 GiB de outros bancos)
DECISÃO DO GATE:             PERMITE
```

O guard **representa adequadamente o risco** para o painel (cobre o banco e o WAL, que foram a causa), mas **não enxerga** o volume de
uploads, os logs do Postgres, o banco `postgres`/templates, nem o volume do `Postgres-KIav`.

## 8. Modo derived / per_product

Nomes reais no código (os do roteiro da entrega não existem): `PRODUCT_IDENTITY_VARIANT_MODE` e `CATALOG_SYNC_VARIANT_SWEEP`.

```text
PRODUCT_IDENTITY_VARIANT_MODE = derived        (esperado: derived)
CATALOG_SYNC_VARIANT_SWEEP    = per_product    (esperado: per_product)

VARIANT STORAGE MODE:  derived
IDENTITY STORAGE MODE: per_product  (varredura de variantes; não há modo `last_seen` ativo)

MODO ATUAL:       derived + per_product
MODO RECOMENDADO: derived + per_product
RISCO:            baixo — confirmado pelo sync de 30/09 (gravadas == novas)
```

Outras variáveis relevantes em produção: `PG_VOLUME_CAPACITY_GB=19`, `CATALOG_SYNC_RETRY_COOLDOWN_HOURS=6`,
`CATALOG_SYNC_RATE_LIMIT_RETRIES=6`. `CATALOG_SYNC_DISABLED`, `CATALOG_SYNC_PAGE_DELAY_MS`, `PUBLIC_SITE_URL` e `SITE_BASE_URL`: ausentes
(os dois últimos pertencem ao P1-005, fora de escopo).

## 9. Fail-open

```text
FAIL-OPEN É ACEITÁVEL EM PRODUÇÃO?  NÃO  (como política permanente)
```

Hoje é inofensivo porque a variável existe e a medição funciona. Mas "sem `PG_VOLUME_CAPACITY_GB` o portão libera" significa que remover
ou errar a variável desliga a proteção sem ninguém perceber, exatamente a condição que o P0 quer impedir.

**Recomendação de código (não implementada aqui, sem mudança de código nesta rodada):** em `NODE_ENV=production`, escrita pesada de
catálogo deve ser **fail-closed** quando a capacidade estiver ausente, não numérica ou ≤ 0, e (opcionalmente) quando a medição falhar
repetidamente — devolvendo `storage_unconfigured`. Fora de produção, manter o comportamento atual. Complementar com validação no boot
(`PG_VOLUME_CAPACITY_GB` obrigatório em produção, no padrão dos demais fail-fast do `server.js`).

## 10. Threshold e margem

```text
THRESHOLD ATUAL:               crítico > 80 % de PG_VOLUME_CAPACITY_GB (19 GiB) = 15,2 GiB de db+wal
ESPAÇO LIVRE NO THRESHOLD:     18,25 − 15,2 ≈ 3,05 GiB reais (o volume real é menor que a capacidade configurada)
CHURN/WAL OBSERVADO POR CICLO: db +0,15 a +0,21 GiB; pg_wal até 1,00 GiB; db+wal de 2,47 → 3,54 GiB (+1,07 GiB de pico)
                               WAL total do sync: 2.810–3.195 MB, mas o diretório não passa de ~1 GiB (checkpoint/reciclagem)
MARGEM SUFICIENTE:             SIM
```

- Pico observado (~1,07 GiB) é ~**3×** menor que o espaço livre no limiar (3,05 GiB).
- Ressalva: o pico medido é de um sync que gravou 0,5–0,7 M variantes novas. Um tenant novo com catálogo de ~5 M variantes gravaria
  tudo como novo (~+1,1 GiB de banco + ~1 GiB de WAL ≈ **+2,1 GiB**) — ainda abaixo de 3,05 GiB, mas com folga apertada se dois tenants
  grandes sincronizarem em sequência.
- **Sem evidência para alterar o limiar.** Recomendação futura (opcional): critério composto `> 80 % OU livre < 4 GiB` (piso absoluto),
  e corrigir `PG_VOLUME_CAPACITY_GB` para 18 (tamanho real do filesystem).

## 11. Evidências

- Ambiente: `railway status` → project `oria`, environment `production`; serviços `oria-panel`, `Postgres`, `Postgres-KIav`, `oria-whatsapp`, `oria-admin`, `oria-creatives`.
- Deploy: `191c4a0c` (2026-09-29 21:54 −03), commit `c5a015b` (PR #50); anterior `8c08e0e` (PR #49 — gate de storage).
- Variáveis: `railway variables --service oria-panel` (apenas as relevantes; nenhum segredo exibido).
- Volume: `railway ssh --service Postgres -- df …` → `/dev/zd1840 19.138.976 / 3.184.900 / 15.937.692 KiB, 17 %`; `du pg_wal` 465M, 31 segmentos.
- Logs: `railway logs -s oria-panel -d --since … --filter …` (filtros `CATALOG_SYNC`, `STORAGE_GUARD`, `ENOSPC`, `No space left`, `@level:error`) em 6 deploys.
- Bloqueado: `railway ssh … psql` (classificador "Production Reads"); `railway variables` e `df` foram permitidos, SQL não.

## 12. Riscos residuais

1. **Lacunas de observação:** 10 maiores relações/índices não coletadas; espelho = 0 é inferido; sem log anterior a 28/09 13:00 UTC
   (não dá para provar ausência de `ENOSPC` entre 26/09 e 28/09, só que o estado atual e os dois últimos syncs estão limpos).
2. **Fail-open** por ausência/erro de configuração (§9) — recomendação de código pendente.
3. **Gate pré-início, não contínuo** (§10).
4. **Crescimento:** ~0,15–0,2 GiB/dia de banco com o catálogo atual → ~55 dias até 80 % do volume; o catálogo cresce ~0,5–0,7 M
   variantes/dia. Precisa de acompanhamento, não de ação agora.
5. **Vigia não cobre** o volume de uploads nem o `Postgres-KIav` (2 % hoje).
6. `PG_VOLUME_CAPACITY_GB=19` superestima em ~4 %.
7. Corrida preexistente no polling de `product-analytics-http.test.js` (teste, não produção).

## 13. Ações manuais recomendadas (nenhuma bloqueia o fechamento)

1. `PG_VOLUME_CAPACITY_GB=18` no `oria-panel` (tamanho real do filesystem).
2. Rodar as três consultas do §4 e anexar a saída (completa a lista das maiores relações e confirma espelho = 0).
3. Reavaliar em ~7 dias a curva de crescimento do banco (linha `[STORAGE_GUARD]` mais recente) e o próximo `CATALOG_SYNC` (esperado
   ~05:19 UTC de 01/10, com `gravadas` ≈ acréscimo de variantes).
4. Aprovar a rodada de código do fail-closed em produção (§9) e, se quiser, o piso absoluto de 4 GiB (§10).

## 14. Critério para liberar a próxima etapa

**PRÓXIMA ETAPA LIBERADA: SIM.** Critérios de RESOLVIDO atendidos: capacidade saudável (17 %); capacidade configurada coerente com o
volume real; nenhum erro de falta de espaço na janela observada; último sync `success`; vigia mede corretamente; modo
`derived` + `per_product`; margem suficiente; sem condição concreta de recorrência imediata. As lacunas do §12 não impedem o
fechamento, mas o item 1 (fail-closed) deve entrar no backlog de hardening.
