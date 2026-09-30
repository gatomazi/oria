# ORIA-P0-001 — Fechamento do risco de storage

> Validado em **2026-09-28** sobre `origin/main` @ `902cc96`. Branch da entrega: `fix/oria-p0-storage`.
> Nenhuma operação foi feita em produção. A leitura de produção pelo Railway CLI foi **negada** pelo classificador do
> ambiente (`Production Reads`) e **não foi contornada**.

## 1. Status

```text
BLOQUEADO POR ACESSO À INFRA
```

O código atual está correto e ganhou um portão que faltava (§9). Mas o P0 nasceu de um fato **de produção** (volume a 96 %) e nenhum
dado atual de produção foi observado. Testes locais passando não fecham o item.

## 2. Resumo executivo

- **Causa:** o full sync do catálogo (~658 k variantes) mais o bootstrap de identities reescreviam ~3,68 M linhas e ~11 GB de WAL por
  ciclo num volume de ~5 GB (ENOSPC em 26/09 02:44 UTC).
- **O que o código já corrigia antes desta entrega:** bootstrap sem reescrita inútil (`d173ff2`), varredura `per_product`,
  modo `derived`, cooldown de 6 h após falha, kill switch `CATALOG_SYNC_DISABLED`, script de poda com backup/ensaio.
- **O que faltava (lacuna de código, corrigida aqui):** o vigia de armazenamento **só logava**. Nada impedia o sync de começar com o
  volume crítico. Agora `syncCommerceCatalog` consulta o vigia antes de tudo e devolve `storage_critical` (> 80 %).
- **O que só produção responde:** capacidade real, `PG_VOLUME_CAPACITY_GB`, modos ativos (`derived`/`per_product`), último sync,
  se a janela de migração do runbook foi executada. **Nada disso está registrado no repositório.**

## 3. Estado atual da capacidade

**Não observado.** Último dado conhecido (26/09 03:08 UTC, `storage-audit-2026-09.md`): volume 96 %, 4,4 GB usados, 194 MB livres,
`pg_wal` 833 MB, banco 3.548 MB. Nenhum documento do repositório registra ampliação do volume depois disso.

## 4. Estado atual do Postgres

**Não observado** (tamanhos de banco/tabelas/índices/WAL atuais). Referência de 26/09: `product_external_identities` ≈ 3,68 M linhas
de espelho de variante; poda ensaiada em cópia (3 min 11 s, 1,38 GB de WAL, tabela final ~2,2 GB).

## 5. Estado do sync de catálogo

**Estado de produção não observado.** Comportamento do código atual (`origin/main`):

| Item | Código atual | Evidência |
|---|---|---|
| Frequência | tick de 1 h + uma rodada 5 min após o boot; cada tick só age se `catalogSyncNecessario` | `server.js` `JOBS.agendar('catalogo-canonico', 60*60*1000…)` |
| Necessidade | último sucesso mais velho que 24 h; nunca sincronizado; `running` além do TTL de 3 h | `composition.js` `catalogSyncNecessario`, `catalogSyncMaxAgeMs` |
| Após falha | espera 6 h (era 1 h) — `CATALOG_SYNC_RETRY_COOLDOWN_HOURS` | `composition.js` |
| Retry no mesmo tick | nenhum; 429 repete a MESMA página até 6× (`CATALOG_SYNC_RATE_LIMIT_RETRIES`) | `catalog-sync.js` |
| Paginação/lote | 1 `INSERT … ON CONFLICT` por página (produtos e variantes); tombstones em lotes | `catalog-sync.js` |
| Concorrência | lease por `(job, organizationId)`: `commerce-scan:reserva_ink` (compartilhado com o crawl legado) + `commerce-catalog-sync:reserva_ink`; no Postgres (vale entre instâncias); TTL 3 h; run `running` órfão vira `ABANDONED` ao obter o lease; job runner processa **uma Organization por vez** | `composition.js`, `catalog-sync.js`, `lib/platform/leases.js` |
| Todos os gatilhos passam por `syncCommerceCatalog` | agendador, boot, disparo pós-conexão da Ink e botão manual | `server.js` (4 chamadores) → **ponto único** |
| Modo padrão de variantes | `last_seen` (regrava **toda** variante vista a cada sync); `per_product` só por env | `catalog-sync.js`, `composition.js` |
| Modo padrão de identity | `materialized` (grava o espelho); `derived` só por env | `product-identity-resolver.js` |

## 6. Causa raiz reconstruída

1. **Processo:** o full sync agendado (02:44:16 UTC) + o `bootstrapCommerceIdentities` que roda logo após um sync com sucesso.
2. **Crescimento:** combinação — **WAL** (~11 GB por ciclo medido na POC; `pg_wal` 177 → 833 MB durante o run), **tabela + índices** de
   `product_external_identities` (re-upsert dobra heap e índices: +865 MB na POC) e reescrita não-HOT das variantes.
3. **Por que ~3,68 M identities:** o bootstrap fazia `ON CONFLICT DO UPDATE` **sem** `IS DISTINCT FROM`; toda linha era regravada mesmo sem
   mudança. **Corrigido em `d173ff2` (26/09 12:06 −03)** para produtos, variantes e SKU — confirmado no código de `origin/main`.
4. **Ainda existe?** A reescrita de identities: **não** (corrigida). A reescrita de variantes por sync: **sim, no modo padrão
   `last_seen`** — cada run regrava as ~658 k variantes só para carimbar `last_seen_sync_id`. Só `per_product` evita.
5. **Roda de hora em hora?** O tick sim, o sync não: no máximo 1×/24 h após sucesso e 1×/6 h após falha.
6. **Concorrência:** protegida por lease em banco (ver §5). Um clique manual durante um run recebe `locked`. Não há N syncs em paralelo
   (o runner é sequencial por Organization).
7. **Sync full ainda é necessário?** Sim para desativar produtos/variantes que sumiram da Ink; `per_product` só grava o que mudou e
   aplica tombstones só depois do run inteiro com sucesso.
8. **`derived`/`per_product` aplicados?** **Desconhecido** — dependem de env de produção (§8).
9. **O vigia teria evitado o incidente?** **Não.** Só logava e rodava a cada 10 min; o sync inteiro do incidente durou ~2 min 24 s.
10. **Atua cedo o bastante?** Antes desta entrega, não (só observação). Agora o gate mede no instante de iniciar e nega acima de 80 %;
    **não interrompe** um run já em andamento (§12).
11. **Outro tenant pode repetir?** **Sim.** O disco é único e compartilhado; qualquer Organization com Ink conectada dispara um full
    sync na conexão (`server.js`, disparo pós-conexão). O gate agora vale para todas, mas a capacidade é global.

## 7. Storage guard

Auditado em `lib/platform/storage-guard.js` (origem `origin/main`).

| Pergunta | Resposta |
|---|---|
| Fail-open/closed | **Fail-open** por desenho: só observa. Agora o gate nega no crítico; sem capacidade ou com leitura falha **libera** (§9) |
| Origem da métrica | `pg_database_size(current_database())` + WAL (`pg_ls_waldir()`, ou o teto `max_wal_size` se a role não puder ler) contra `PG_VOLUME_CAPACITY_GB`. **Aproximação declarada**: não enxerga `df` do volume nem outros arquivos |
| `PG_VOLUME_CAPACITY_GB` ausente | percentual desconhecido → nível `ok`, log "não configurada". Gate: libera **e avisa a cada tentativa** |
| Consulta de uso falha | `verificarVolume` propaga o erro ao job; gate libera e loga o motivo |
| Limiares (mantidos) | aviso > 70 %, crítico > 80 %, WAL > 1,5 GB (aviso) — os do runbook, não alterados |
| Quem chama | job `storage-guard` a cada 10 min (`verificarVolume` no máx. 1×/5 min + `verificarTenant`) **e**, novo, `syncCommerceCatalog` |
| Bloqueia | **novo:** início de qualquer full sync do catálogo canônico |
| Não bloqueia | escritas comuns (pedidos, sessões…), o crawl legado `produtos_ink`, jobs de outros módulos, e um sync **já em andamento** |
| Logs | `[STORAGE_GUARD] banco=… wal=… capacidade=…GB uso~…%` (`warn`/`error` por nível); `[CATALOG_SYNC] … BLOQUEADO pelo vigia` |
| Testes | antes: limiares, crítico com teto de WAL, `verificarTenant`. **Agora:** saudável/aviso/crítico, liberação após normalizar, capacidade ausente, erro de leitura, sync bloqueado sem lease/log/chamada à Ink |

**Risco de configuração:** se `PG_VOLUME_CAPACITY_GB` estiver com o valor de exemplo do runbook (19) e o volume real for ~5 GB, o gate
**nunca** dispara. Confirmar (§13).

## 8. Modo derived / per_product

```text
MODO ATUAL:    NÃO OBSERVADO em produção (env não lida).
               Padrões do código: PRODUCT_IDENTITY_VARIANT_MODE=materialized · CATALOG_SYNC_VARIANT_SWEEP=last_seen
MODO ESPERADO: derived + per_product (runbook, passos 6 e 8), após backup e poda (passo 7)
DIFERENÇA:     desconhecida; o repositório não registra que a janela do runbook tenha sido executada
IMPACTO:       em materialized/last_seen o próximo full sync volta a gravar milhares de linhas de espelho/variantes
               e ~GBs de WAL; só o gate novo impede que isso comece com o volume crítico
```

O código de `derived`, `per_product`, poda e verificação de equivalência **existe, está testado** (suíte 2.416/2.416 registrada em
26/09) e **não foi reimplementado**.

## 9. Mudanças realizadas

Mínimas, restritas ao P0-001 (branch `fix/oria-p0-storage`):

| Arquivo | Mudança |
|---|---|
| `apps/panel/lib/platform/storage-guard.js` | novo `podeIniciarEscritaPesada()`: nega só no nível crítico; sem capacidade → libera + `warn`; leitura falha → libera + `warn` |
| `apps/panel/lib/product-analytics/composition.js` | opção `storageGate`; `syncCommerceCatalog` consulta antes do lease e devolve `{ status: 'storage_critical' }` |
| `apps/panel/server.js` | liga o portão ao vigia (ligação tardia, pois o vigia é criado depois da composição) |
| `apps/panel/test/storage-guard.test.js` | +4 testes |
| `apps/panel/test/invariants/catalog-sync-necessario.test.js` | +1 teste (sync bloqueado sem lease, sem log, sem Ink) |
| `docs/operations/p0-storage-closure-2026-09.md`, `docs/auditoria-produto-oria.md` | documentação |

Decisões: nenhum limiar alterado; nenhum comportamento de produção mudou enquanto o volume estiver < 80 % ou sem capacidade configurada.
Achado durante a entrega: com capacidade **não** configurada o primeiro desenho consultava o banco mesmo assim e a latência extra expôs
uma corrida já existente no polling de `product-analytics-http.test.js` ("M · POST /catalog-sync/cancelar…"); por isso o gate
curto-circuita sem capacidade (nada a comparar). A corrida do teste em si **não foi alterada** (registrada como dívida).

## 10. Testes executados

| Comando (em `apps/panel`) | Resultado |
|---|---|
| `node --test test/storage-guard.test.js` | 7/7 ✔ |
| Grupo pertinente com Postgres efêmero (22 arquivos: `catalog-*`, `jobs-*`, `lease*`, `storage-*`, `product-analytics-*`, `desempenho-*`, `jornada-*`, `composition`, `boot-*`, `http-safety`, `feature-routes`, `entitle*`) | **228/228 ✔** |
| `product-analytics-http.test.js` isolado, 4 execuções na versão final | 4/4 ✔ (na versão intermediária: 1 de 2 falhou — corrida descrita em §9) |
| `negative-controls-cobertura` + `navegacao-painel` | 33/33 ✔ |
| `tsc -p tsconfig.app.json --noEmit` | 0 erros |
| `vite build` | ✔ |
| `git diff --check` | limpo |

Não repeti os 2.416 testes do painel: a mudança é isolada em vigia/composição, sem tocar tenancy, jobs ou leases.

## 11. Evidências

- Código: `storage-guard.js`, `composition.js` (`syncCommerceCatalog`, `catalogSyncNecessario`), `catalog-sync.js`, `product-identity-resolver.js`, `server.js` (jobs `catalogo-canonico`, `storage-guard`).
- Histórico: `d173ff2` (bootstrap sem reescrita, 26/09), `3a0e928` (varredura incremental), `644b0c2` (sync operacionalmente seguro), `78093b6` (poda guardada), `23c110c` (backup/restore/ensaio).
- Docs: `storage-audit-2026-09.md`, `storage-migration-window-2026-09.md` (runbook §Sequência, rollback e evidências pré-mutação).
- Ausência de evidência: nenhum commit ou doc após 26/09 registra ampliação de volume, ativação de `derived`/`per_product` ou execução da poda.

## 12. Riscos residuais

1. **Estado de produção desconhecido** (capacidade, WAL, modos, último sync, se a janela foi executada).
2. **Gate é pré-início, não contínuo:** um sync que começa a 79 % pode encher o volume durante o run (o incidente cresceu ~650 MB de WAL em ~2,5 min).
3. **Métrica aproximada:** não vê `df`, logs do Postgres nem outros arquivos do volume; exige `PG_VOLUME_CAPACITY_GB` correta.
4. **Modo padrão do código continua o pesado** (`materialized` + `last_seen`); a proteção real é ambiental.
5. **Disco compartilhado:** um tenant com catálogo grande afeta todos; sem quota por Organization.
6. **Não bloqueia escritas comuns:** com o volume cheio por outro motivo, o painel inteiro falha do mesmo jeito.
7. Corrida preexistente no polling de `product-analytics-http.test.js`.

## 13. Ações manuais necessárias

Somente leitura, para o dono executar e devolver a saída (nomes de serviço entre `<>` a confirmar no Railway):

```bash
# 1) Variáveis (imprime só as relevantes)
railway variables --service oria-panel --kv | grep -E '^(PG_VOLUME_CAPACITY_GB|PRODUCT_IDENTITY_VARIANT_MODE|CATALOG_SYNC_[A-Z_]+)='

# 2) Logs do vigia e do sync (últimas ocorrências)
railway logs --service oria-panel | grep -E 'STORAGE_GUARD|CATALOG_SYNC' | tail -60

# 3) Disco real do volume e do WAL (no container do Postgres)
railway ssh --service <postgres> -- df -h /var/lib/postgresql/data
railway ssh --service <postgres> -- du -sh /var/lib/postgresql/data/pgdata/pg_wal

# 4) SQL somente leitura (psql no Postgres do painel)
SELECT pg_size_pretty(pg_database_size(current_database())) AS banco;
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total
  FROM pg_class WHERE relname IN ('product_external_identities','commerce_product_variants','commerce_products') ORDER BY pg_total_relation_size(oid) DESC;
SELECT status, started_at, finished_at, pages_processed, variants_seen, variants_updated, error_code
  FROM commerce_catalog_sync_logs ORDER BY started_at DESC LIMIT 5;
SELECT count(*) AS espelho_variante FROM product_external_identities
 WHERE source = 'commerce_sync' AND namespace LIKE '%.variant_id';   -- derived aplicado ⇒ 0
SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retido FROM pg_replication_slots;
```

Interpretação para encerrar como **RESOLVIDO**: livre ≥ 2 GB e uso < 70 %; `PG_VOLUME_CAPACITY_GB` = tamanho **real** do volume;
último sync `success` recente sem `No space left`; `PRODUCT_IDENTITY_VARIANT_MODE=derived` e `CATALOG_SYNC_VARIANT_SWEEP=per_product`
(ou espelho = 0); nenhum `[CATALOG_SYNC] … BLOQUEADO` recorrente.

Se o volume ainda estiver > 80 %: **AINDA ABERTO** — ampliar o volume (decisão do dono) e/ou seguir o runbook (janela única); manter
`CATALOG_SYNC_DISABLED=1` até lá. Nada disso foi executado.

## 14. Critério para liberar a próxima etapa

**PRÓXIMA ETAPA LIBERADA: NÃO** — até o dono devolver a saída do §13 e ela satisfazer o critério de **RESOLVIDO**, ou aceitar por
escrito o risco de seguir com produção não verificada. O PR desta entrega pode ser mergeado independentemente: ele só adiciona o portão.
