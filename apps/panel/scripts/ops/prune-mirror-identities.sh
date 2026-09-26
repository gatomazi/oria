#!/usr/bin/env bash
# Poda das identities ESPELHO de variante (source='commerce_sync', namespace '<provider>.variant_id').
#
# Rodar DENTRO do container do Postgres (tem psql, df e acesso ao PGDATA):
#   bash prune-mirror-identities.sh --provider reserva_ink --confirm-derived-mode-and-backup
#
# Segurança (todas obrigatórias; qualquer falha ABORTA e nada mais é apagado):
#   - só apaga o predicado exato: source = 'commerce_sync' AND namespace = '<provider>.variant_id' (nunca GA4,
#     produto, SKU, manual/regra, histórico) — e só por Organization/Store, nunca a tabela inteira
#   - jamais TRUNCATE (gate `no-unsafe-truncate`); DELETE em lotes curtos (uma transação cada) com pausa
#   - antes de cada lote: espaço livre >= --min-free-gb e pg_wal <= --max-wal-mb (espera o checkpoint reciclar)
#   - conferência: (linhas espelho apagadas == contagem inicial) e hash das linhas NÃO espelho idêntico antes/depois
#   - retomável: reexecutar continua de onde parou (o predicado só enxerga o que sobrou)
#   - --dry-run só conta e confere pré-condições
set -euo pipefail

PROVIDER="reserva_ink"; BATCH=50000; SLEEP=2; MIN_FREE_GB=6; MAX_WAL_MB=2500; DRY=0; CONFIRM=0; VACUUM_FULL=1
PGUSER_="${PGUSER:-postgres}"; PGDB="${PGDATABASE:-railway}"
while [ $# -gt 0 ]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2;;
    --batch) BATCH="$2"; shift 2;;
    --sleep) SLEEP="$2"; shift 2;;
    --min-free-gb) MIN_FREE_GB="$2"; shift 2;;
    --max-wal-mb) MAX_WAL_MB="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    --no-vacuum-full) VACUUM_FULL=0; shift;;
    --confirm-derived-mode-and-backup) CONFIRM=1; shift;;
    *) echo "argumento desconhecido: $1" >&2; exit 2;;
  esac
done
[[ "$PROVIDER" =~ ^[a-z][a-z0-9_]*$ ]] || { echo "provider inválido" >&2; exit 2; }
[[ "$BATCH" =~ ^[0-9]+$ && "$BATCH" -le 50000 && "$BATCH" -ge 100 ]] || { echo "--batch precisa estar entre 100 e 50000" >&2; exit 2; }
NS="${PROVIDER}.variant_id"
PSQL=(psql -U "$PGUSER_" -d "$PGDB" -v ON_ERROR_STOP=1 -At -F '|')
q() { "${PSQL[@]}" -c "$1"; }
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
die() { log "ABORTADO: $*"; exit 1; }

DATADIR="$(q 'show data_directory')"
MOUNT="$(dirname "$DATADIR")"
free_gb() { df -BG --output=avail "$MOUNT" | tail -1 | tr -dc '0-9'; }
wal_mb() { du -sm "$DATADIR/pg_wal" | cut -f1; }

log "provider=$PROVIDER namespace=$NS batch=$BATCH dry-run=$DRY datadir=$DATADIR livre=$(free_gb)GB pg_wal=$(wal_mb)MB"
[ "$(free_gb)" -ge "$MIN_FREE_GB" ] || die "espaço livre $(free_gb)GB < $MIN_FREE_GB GB"
if [ "$DRY" -eq 0 ] && [ "$CONFIRM" -ne 1 ]; then die "faltou --confirm-derived-mode-and-backup (o operador atesta: app em modo derived/dual E backup restaurável verificado)"; fi

NONMIRROR_HASH_SQL="SELECT count(*) || '|' || coalesce(md5(string_agg(id::text || namespace || external_id || commerce_product_id::text || source, ',' ORDER BY id)), '') FROM product_external_identities WHERE NOT (source = 'commerce_sync' AND namespace = '${NS}')"
BEFORE_NONMIRROR="$(q "$NONMIRROR_HASH_SQL")"
log "linhas NÃO espelho antes (contagem|md5): $BEFORE_NONMIRROR"

TARGETS="$(q "SELECT organization_id || '|' || store_id || '|' || count(*) FROM product_external_identities WHERE source = 'commerce_sync' AND namespace = '${NS}' GROUP BY organization_id, store_id ORDER BY 1")"
[ -n "$TARGETS" ] || { log "nada a podar (0 linhas espelho)"; exit 0; }
log "alvos (org|store|linhas):"; echo "$TARGETS"
[ "$DRY" -eq 1 ] && { log "dry-run: fim"; exit 0; }

TOTAL_DELETED=0
while IFS='|' read -r ORG STORE INITIAL; do
  [[ "$ORG" =~ ^[0-9a-f-]{36}$ && "$STORE" =~ ^[0-9a-f-]{36}$ ]] || die "ids inválidos: $ORG $STORE"
  log "== organization $ORG · $INITIAL linhas espelho"
  DELETED=0; LAST=""
  while :; do
    [ "$(free_gb)" -ge "$MIN_FREE_GB" ] || die "espaço livre caiu para $(free_gb)GB (< $MIN_FREE_GB GB)"
    W="$(wal_mb)"; TRIES=0
    while [ "$W" -gt "$MAX_WAL_MB" ]; do
      TRIES=$((TRIES+1)); [ "$TRIES" -le 60 ] || die "pg_wal ${W}MB não baixou de ${MAX_WAL_MB}MB em 60 tentativas"
      log "pg_wal=${W}MB > ${MAX_WAL_MB}MB — aguardando checkpoint"; q "CHECKPOINT" >/dev/null; sleep 5; W="$(wal_mb)"
    done
    RES="$(q "WITH d AS (DELETE FROM product_external_identities WHERE id IN (SELECT id FROM product_external_identities WHERE organization_id = '${ORG}' AND store_id = '${STORE}' AND namespace = '${NS}' AND source = 'commerce_sync' AND external_id > '${LAST//\'/}' ORDER BY external_id LIMIT ${BATCH}) RETURNING external_id) SELECT count(*), coalesce(max(external_id), '') FROM d")"
    N="${RES%%|*}"; NEWLAST="${RES#*|}"
    [ "$N" -gt 0 ] || break
    DELETED=$((DELETED+N)); LAST="$NEWLAST"
    log "  lote ok: $N (acumulado $DELETED/$INITIAL) livre=$(free_gb)GB pg_wal=$(wal_mb)MB"
    sleep "$SLEEP"
  done
  [ "$DELETED" -eq "$INITIAL" ] || die "apagadas $DELETED != esperado $INITIAL para a organization $ORG"
  TOTAL_DELETED=$((TOTAL_DELETED+DELETED))
done <<< "$TARGETS"

REMAIN="$(q "SELECT count(*) FROM product_external_identities WHERE source = 'commerce_sync' AND namespace = '${NS}'")"
[ "$REMAIN" -eq 0 ] || die "sobraram $REMAIN linhas espelho"
AFTER_NONMIRROR="$(q "$NONMIRROR_HASH_SQL")"
[ "$AFTER_NONMIRROR" = "$BEFORE_NONMIRROR" ] || die "linhas NÃO espelho mudaram! antes=$BEFORE_NONMIRROR depois=$AFTER_NONMIRROR"
log "OK: $TOTAL_DELETED linhas espelho apagadas; NÃO espelho intactas ($AFTER_NONMIRROR)"

log "VACUUM (ANALYZE) product_external_identities"
q "VACUUM (ANALYZE) product_external_identities" >/dev/null
if [ "$VACUUM_FULL" -eq 1 ]; then
  log "VACUUM FULL product_external_identities (ACCESS EXCLUSIVE; tabela quase vazia) — livre=$(free_gb)GB"
  [ "$(free_gb)" -ge "$MIN_FREE_GB" ] || die "sem folga para o VACUUM FULL"
  q "VACUUM (FULL, ANALYZE) product_external_identities" >/dev/null
fi
log "tamanho final: $(q "SELECT pg_size_pretty(pg_total_relation_size('product_external_identities')) || ' · ' || (SELECT count(*) FROM product_external_identities) || ' linhas'") · livre=$(free_gb)GB pg_wal=$(wal_mb)MB"
