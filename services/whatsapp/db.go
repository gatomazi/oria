package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var db *pgxpool.Pool

// dbDegraded reporta que a persistência não está disponível. Em produção isso ABORTA o boot: o
// serviço aceita mensagens na fila e as perderia no restart sem avisar nenhum chamador (/health
// responde "ok" de qualquer jeito). Fora de produção mantém o modo memória, que é o que torna
// `go run` e `go test` possíveis sem um Postgres por perto.
func dbDegraded(format string, args ...any) {
	if isProduction() {
		log.Fatalf("[db] "+format+" — persistência é obrigatória em produção, abortando", args...)
	}
	log.Printf("[db] "+format+" — dados somente em memória", args...)
}

func initDB() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dbDegraded("DATABASE_URL não definida")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		dbDegraded("falha ao conectar: %v", err)
		return
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		dbDegraded("ping falhou: %v", err)
		return
	}

	db = pool
	log.Println("[db] PostgreSQL conectado ✅")

	if err := migrate(ctx); err != nil {
		// Migration que falha (inclusive por falta do mapeamento legado) nunca vira modo memória
		// silencioso: em produção aborta, fora dela avisa e desliga a persistência.
		db = nil
		pool.Close()
		dbDegraded("migrate erro: %v", err)
		return
	}
	// Estado em memória é carregado por Organization, na primeira vez que ela aparece (store.go,
	// queue.go, problems.go) — não existe carga "de todas".
}

// ── Migrations versionadas ────────────────────────────────────────────────────────────────────

type migration struct {
	version int
	name    string
	apply   func(ctx context.Context, tx pgx.Tx) error
}

// ErrLegacyMappingRequired: há linhas anteriores à Fase 5c e nenhuma Organization declarada para
// elas. O banco é single-tenant histórico; o dono não é inferido ("a única Organization").
var ErrLegacyMappingRequired = errors.New("linhas sem organization e LEGACY_ORGANIZATION_ID não definido")

var migrations = []migration{
	{1, "baseline", migrateBaseline},
	{2, "tenant-scope", migrateTenantScope},
	{3, "webhook-inbox", migrateWebhookInbox},
}

func migrate(ctx context.Context) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Duas réplicas subindo juntas: só uma migra por vez.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('whatsapp-webhook-go:migrations'))`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INT         PRIMARY KEY,
		name       TEXT        NOT NULL,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`); err != nil {
		return err
	}
	for _, m := range migrations {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, m.version).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		if err := m.apply(ctx, tx); err != nil {
			return fmt.Errorf("migration %d (%s): %w", m.version, m.name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, m.version, m.name); err != nil {
			return err
		}
		log.Printf("[db] migration %d (%s) aplicada", m.version, m.name)
	}
	return tx.Commit(ctx)
}

// Esquema até a Fase 5b (idempotente: bancos existentes já o têm).
func migrateBaseline(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS events (
			id       BIGSERIAL    PRIMARY KEY,
			time     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
			kind     TEXT         NOT NULL,
			phone    TEXT         NOT NULL,
			name     TEXT         NOT NULL DEFAULT '',
			message  TEXT         NOT NULL DEFAULT '',
			extra    TEXT         NOT NULL DEFAULT ''
		);
		ALTER TABLE events ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT '';
		CREATE INDEX IF NOT EXISTS idx_events_time ON events(time DESC);

		CREATE TABLE IF NOT EXISTS problem_orders (
			numero         TEXT         PRIMARY KEY,
			saved_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
			loja           TEXT         NOT NULL DEFAULT '',
			pedido         TEXT         NOT NULL DEFAULT '',
			data_pedido    TEXT         NOT NULL DEFAULT '',
			cliente        TEXT         NOT NULL DEFAULT '',
			telefone       TEXT         NOT NULL DEFAULT '',
			email          TEXT         NOT NULL DEFAULT '',
			cpf            TEXT         NOT NULL DEFAULT '',
			valor          TEXT         NOT NULL DEFAULT '',
			entrega        TEXT         NOT NULL DEFAULT '',
			estimativa_ink TEXT         NOT NULL DEFAULT '',
			consultado_em  TEXT         NOT NULL DEFAULT '',
			rastreio       JSONB,
			analise        JSONB
		);

		CREATE TABLE IF NOT EXISTS queue_items (
			id         BIGSERIAL    PRIMARY KEY,
			added_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
			type       TEXT         NOT NULL,
			to_phone   TEXT         NOT NULL,
			name       TEXT         NOT NULL DEFAULT '',
			pedido     TEXT         NOT NULL DEFAULT '',
			message    TEXT         NOT NULL DEFAULT '',
			template   TEXT         NOT NULL DEFAULT '',
			language   TEXT         NOT NULL DEFAULT '',
			components JSONB,
			status     TEXT         NOT NULL DEFAULT 'pending',
			sent_at    TIMESTAMPTZ,
			error_msg  TEXT         NOT NULL DEFAULT ''
		);
		ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS pedido TEXT NOT NULL DEFAULT '';
		ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS loja   TEXT NOT NULL DEFAULT '';
		ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS sender_phone_number_id TEXT NOT NULL DEFAULT '';
		ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS sender_ref             TEXT NOT NULL DEFAULT '';
		ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS source_wamid           TEXT NOT NULL DEFAULT '';
		CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_items(status);
	`)
	return err
}

// Fase 5c: todo estado de negócio passa a ter Organization (events, queue_items, problem_orders) e
// nasce a tabela de idempotência dos webhooks. Linhas antigas só ganham dono pelo mapeamento
// explícito LEGACY_ORGANIZATION_ID; sem ele, com linhas antigas presentes, a migration falha.
func migrateTenantScope(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `
		ALTER TABLE events         ADD COLUMN IF NOT EXISTS organization_id UUID;
		ALTER TABLE queue_items    ADD COLUMN IF NOT EXISTS organization_id UUID;
		ALTER TABLE queue_items    ADD COLUMN IF NOT EXISTS integration_id  TEXT NOT NULL DEFAULT '';
		ALTER TABLE queue_items    ADD COLUMN IF NOT EXISTS lease_owner     TEXT;
		ALTER TABLE queue_items    ADD COLUMN IF NOT EXISTS lease_until     TIMESTAMPTZ;
		ALTER TABLE problem_orders ADD COLUMN IF NOT EXISTS organization_id UUID;
	`); err != nil {
		return err
	}

	var pending int64
	if err := tx.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM events WHERE organization_id IS NULL)
		     + (SELECT count(*) FROM queue_items WHERE organization_id IS NULL)
		     + (SELECT count(*) FROM problem_orders WHERE organization_id IS NULL)`).Scan(&pending); err != nil {
		return err
	}
	if pending > 0 {
		legacy := strings.ToLower(strings.TrimSpace(os.Getenv("LEGACY_ORGANIZATION_ID")))
		if legacy == "" {
			return fmt.Errorf("%w (%d linha(s))", ErrLegacyMappingRequired, pending)
		}
		if !organizationIDPattern.MatchString(legacy) {
			return errors.New("LEGACY_ORGANIZATION_ID inválido (uuid)")
		}
		for _, table := range []string{"events", "queue_items", "problem_orders"} {
			if _, err := tx.Exec(ctx, `UPDATE `+table+` SET organization_id = $1 WHERE organization_id IS NULL`, legacy); err != nil {
				return err
			}
		}
		log.Printf("[db] %d linha(s) anteriores à Fase 5c atribuídas à organization legada %s", pending, legacy)
	}

	_, err := tx.Exec(ctx, `
		ALTER TABLE events         ALTER COLUMN organization_id SET NOT NULL;
		ALTER TABLE queue_items    ALTER COLUMN organization_id SET NOT NULL;
		ALTER TABLE problem_orders ALTER COLUMN organization_id SET NOT NULL;

		-- O número do pedido só é único dentro da Organization (WG-23).
		ALTER TABLE problem_orders DROP CONSTRAINT IF EXISTS problem_orders_pkey;
		ALTER TABLE problem_orders ADD PRIMARY KEY (organization_id, numero);

		CREATE INDEX IF NOT EXISTS idx_events_org_time   ON events (organization_id, time DESC);
		CREATE INDEX IF NOT EXISTS idx_queue_org_status  ON queue_items (organization_id, status);

		-- Idempotência do webhook (INV-16): o mesmo evento, entregue de novo, não produz efeito de
		-- novo — e a chave inclui a Organization, então o id de um tenant nunca bloqueia outro.
		CREATE TABLE IF NOT EXISTS processed_webhook_events (
			organization_id UUID        NOT NULL,
			event_key       TEXT        NOT NULL,
			received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (organization_id, event_key)
		);
		CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_received ON processed_webhook_events (received_at);
	`)
	return err
}

// Rodada 18 (§23): aceite durável do webhook. Cada change com dono e com evento novo vira uma linha
// da inbox NA MESMA TRANSAÇÃO do registro de idempotência — só depois disso a Meta recebe 200. Um
// worker com lease processa os efeitos (inbox.go); `steps` registra o que já foi feito, para que
// uma nova tentativa não repita efeito. Aditiva: a versão anterior do serviço ignora a tabela.
func migrateWebhookInbox(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS webhook_inbox (
			id              BIGSERIAL   PRIMARY KEY,
			organization_id UUID        NOT NULL,
			tenant          JSONB       NOT NULL,
			waba_id         TEXT        NOT NULL,
			object          TEXT        NOT NULL,
			raw_change      TEXT        NOT NULL,
			event_keys      TEXT[]      NOT NULL,
			steps           JSONB       NOT NULL DEFAULT '{}'::jsonb,
			status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'failed')),
			attempts        INT         NOT NULL DEFAULT 0,
			lease_owner     TEXT,
			lease_until     TIMESTAMPTZ,
			next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			last_error      TEXT        NOT NULL DEFAULT '',
			received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE INDEX IF NOT EXISTS idx_webhook_inbox_due ON webhook_inbox (status, next_attempt_at);
		CREATE INDEX IF NOT EXISTS idx_webhook_inbox_org ON webhook_inbox (organization_id, status);
	`)
	return err
}

func dbContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

// ── Eventos ───────────────────────────────────────────────────────────────────

func dbSaveEvent(e Event) {
	if db == nil {
		return
	}
	ctx, cancel := dbContext()
	defer cancel()
	_, err := db.Exec(ctx,
		`INSERT INTO events (organization_id, time, kind, phone, name, message, extra, origem)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		e.OrganizationID, e.Time, string(e.Kind), e.Phone, e.Name, e.Message, e.Extra, e.Origem,
	)
	if err != nil {
		log.Printf("[db] insert event: %v", err)
	}
}

func dbLoadEvents(organizationID string) []Event {
	if db == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := db.Query(ctx,
		`SELECT id, organization_id::text, time, kind, phone, name, message, extra, origem
		 FROM events WHERE organization_id = $1 ORDER BY time DESC LIMIT $2`, organizationID, maxEvents)
	if err != nil {
		log.Printf("[db] load events: %v", err)
		return nil
	}
	defer rows.Close()
	var loaded []Event
	for rows.Next() {
		var e Event
		var kind string
		if err := rows.Scan(&e.ID, &e.OrganizationID, &e.Time, &kind, &e.Phone, &e.Name, &e.Message, &e.Extra, &e.Origem); err != nil {
			continue
		}
		e.Kind = EventKind(kind)
		loaded = append(loaded, e)
	}
	return loaded
}

func dbClearEvents(organizationID string) {
	if db == nil {
		return
	}
	ctx, cancel := dbContext()
	defer cancel()
	if _, err := db.Exec(ctx, "DELETE FROM events WHERE organization_id = $1", organizationID); err != nil {
		log.Printf("[db] clear events: %v", err)
	}
}

// ── Fila ──────────────────────────────────────────────────────────────────────

const queueColumns = `id, organization_id::text, integration_id, added_at, type, to_phone, name, pedido, loja,
	message, template, language, components, status, sent_at, error_msg,
	sender_phone_number_id, sender_ref, source_wamid`

// qualifiedQueueColumns prefixa cada coluna (RETURNING de UPDATE ... FROM, onde `id` é ambíguo).
func qualifiedQueueColumns(alias string) string {
	parts := strings.Split(queueColumns, ",")
	for i, p := range parts {
		parts[i] = alias + "." + strings.TrimSpace(p)
	}
	return strings.Join(parts, ", ")
}

func scanQueueItem(row pgx.Row) (*QueueItem, error) {
	item := &QueueItem{}
	var compJSON []byte
	if err := row.Scan(
		&item.ID, &item.OrganizationID, &item.IntegrationID, &item.AddedAt, &item.Type, &item.To, &item.Name,
		&item.Pedido, &item.Loja, &item.Message, &item.Template, &item.Language,
		&compJSON, &item.Status, &item.SentAt, &item.ErrorMsg,
		&item.Sender.PhoneNumberID, &item.Sender.Ref, &item.SourceWamid,
	); err != nil {
		return nil, err
	}
	if len(compJSON) > 0 {
		_ = json.Unmarshal(compJSON, &item.Components)
	}
	return item, nil
}

// dbInsertQueueItem grava o item e devolve o id do banco — único entre réplicas.
func dbInsertQueueItem(item *QueueItem) (int64, error) {
	ctx, cancel := dbContext()
	defer cancel()
	var compJSON []byte
	if len(item.Components) > 0 {
		compJSON, _ = json.Marshal(item.Components)
	}
	var id int64
	err := db.QueryRow(ctx,
		`INSERT INTO queue_items
		   (organization_id, integration_id, added_at, type, to_phone, name, pedido, loja, message, template,
		    language, components, status, error_msg, sender_phone_number_id, sender_ref, source_wamid)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		 RETURNING id`,
		item.OrganizationID, item.IntegrationID, item.AddedAt, item.Type, item.To, item.Name, item.Pedido, item.Loja,
		item.Message, item.Template, item.Language, compJSON, item.Status, item.ErrorMsg,
		item.Sender.PhoneNumberID, item.Sender.Ref, item.SourceWamid,
	).Scan(&id)
	return id, err
}

func dbDeleteQueueItems(organizationID string, ids []int64) {
	if db == nil {
		return
	}
	ctx, cancel := dbContext()
	defer cancel()
	if _, err := db.Exec(ctx, "DELETE FROM queue_items WHERE organization_id = $1 AND id = ANY($2)", organizationID, ids); err != nil {
		log.Printf("[db] delete queue_items: %v", err)
	}
}

func dbLoadQueue(organizationID string) []*QueueItem {
	if db == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := db.Query(ctx, `SELECT `+queueColumns+` FROM queue_items WHERE organization_id = $1 ORDER BY added_at ASC`, organizationID)
	if err != nil {
		log.Printf("[db] load queue: %v", err)
		return nil
	}
	defer rows.Close()
	var loaded []*QueueItem
	for rows.Next() {
		item, err := scanQueueItem(rows)
		if err != nil {
			continue
		}
		loaded = append(loaded, item)
	}
	return loaded
}

// Lease da fila (INV-18 / TD-006). Várias réplicas podem receber o "enviar" do mesmo item: só a que
// conseguir o lease no banco envia. Um lease vencido (réplica caiu no meio) NÃO é reenviado — a
// mensagem pode ter saído antes da queda —, o item vira erro e o reenvio é decisão manual.
func dbRecoverExpiredQueue(organizationID string) error {
	ctx, cancel := dbContext()
	defer cancel()
	_, err := db.Exec(ctx,
		`UPDATE queue_items
		    SET status = 'error', lease_owner = NULL, lease_until = NULL,
		        error_msg = 'envio interrompido (lease vencido) — não reenviado automaticamente para evitar duplicata'
		  WHERE organization_id = $1 AND status = 'sending' AND lease_until < NOW()`,
		organizationID)
	return err
}

func dbClaimQueueItems(organizationID string, ids []int64, statuses []string, owner string, ttl time.Duration, limit int) ([]*QueueItem, error) {
	ctx, cancel := dbContext()
	defer cancel()
	return claimQueueItems(ctx, db, organizationID, ids, statuses, owner, ttl, limit)
}

// queryer é o pool ou uma transação (o teste segura um lease numa transação aberta).
type queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func claimQueueItems(ctx context.Context, conn queryer, organizationID string, ids []int64, statuses []string, owner string, ttl time.Duration, limit int) ([]*QueueItem, error) {
	// CTE, não "WHERE id IN (subconsulta com LIMIT ... FOR UPDATE SKIP LOCKED)": nessa forma o
	// Postgres pode reavaliar a subconsulta e o UPDATE pega mais linhas que o LIMIT (visto no teste
	// de duas réplicas: um lote de 3 levou a fila inteira).
	rows, err := conn.Query(ctx,
		`WITH picked AS (
		   SELECT id FROM queue_items
		    WHERE organization_id = $1
		      AND ($2::bigint[] IS NULL OR id = ANY($2))
		      AND status = ANY($3)
		    ORDER BY id
		    LIMIT $6
		    FOR UPDATE SKIP LOCKED
		 )
		 UPDATE queue_items q
		    SET status = 'sending', lease_owner = $4, lease_until = NOW() + make_interval(secs => $5), error_msg = ''
		   FROM picked
		  WHERE q.id = picked.id AND q.organization_id = $1
		RETURNING `+qualifiedQueueColumns("q"),
		organizationID, ids, statuses, owner, ttl.Seconds(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var claimed []*QueueItem
	for rows.Next() {
		item, err := scanQueueItem(rows)
		if err != nil {
			return nil, err
		}
		claimed = append(claimed, item)
	}
	return claimed, rows.Err()
}

func dbFinishQueueItem(item *QueueItem, owner string) {
	ctx, cancel := dbContext()
	defer cancel()
	_, err := db.Exec(ctx,
		`UPDATE queue_items SET status = $1, sent_at = $2, error_msg = $3, lease_owner = NULL, lease_until = NULL
		  WHERE id = $4 AND organization_id = $5 AND lease_owner = $6`,
		item.Status, item.SentAt, item.ErrorMsg, item.ID, item.OrganizationID, owner)
	if err != nil {
		log.Printf("[db] finish queue_item %d: %v", item.ID, err)
	}
}

// ── Problemas de entrega ──────────────────────────────────────────────────────

func dbSaveProblem(o *ProblemOrder) {
	if db == nil {
		return
	}
	ctx, cancel := dbContext()
	defer cancel()

	rastreioJSON, _ := json.Marshal(o.Rastreio)
	analiseJSON, _ := json.Marshal(o.Analise)

	// A herança de PII (telefone/e-mail/CPF) só acontece dentro da MESMA Organization: a chave é
	// (organization_id, numero).
	_, err := db.Exec(ctx, `
		INSERT INTO problem_orders
		  (organization_id, numero, saved_at, loja, pedido, data_pedido, cliente, telefone, email, cpf,
		   valor, entrega, estimativa_ink, consultado_em, rastreio, analise)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		ON CONFLICT (organization_id, numero) DO UPDATE SET
		  saved_at       = EXCLUDED.saved_at,
		  loja           = EXCLUDED.loja,
		  cliente        = EXCLUDED.cliente,
		  telefone       = COALESCE(NULLIF(EXCLUDED.telefone,''), problem_orders.telefone),
		  email          = COALESCE(NULLIF(EXCLUDED.email,''),    problem_orders.email),
		  cpf            = COALESCE(NULLIF(EXCLUDED.cpf,''),      problem_orders.cpf),
		  estimativa_ink = COALESCE(NULLIF(EXCLUDED.estimativa_ink,''), problem_orders.estimativa_ink),
		  consultado_em  = EXCLUDED.consultado_em,
		  rastreio       = EXCLUDED.rastreio,
		  analise        = EXCLUDED.analise`,
		o.OrganizationID, o.Numero, o.SavedAt, o.Loja, o.Pedido, o.Data, o.Cliente,
		o.Telefone, o.Email, o.CPF, o.Valor, o.Entrega,
		o.EstimativaInk, o.ConsultadoEm, rastreioJSON, analiseJSON,
	)
	if err != nil {
		log.Printf("[db] upsert problem_order %s: %v", o.Numero, err)
	}
}

func dbDeleteProblems(organizationID string, numeros []string) {
	if db == nil || len(numeros) == 0 {
		return
	}
	ctx, cancel := dbContext()
	defer cancel()
	if _, err := db.Exec(ctx, `DELETE FROM problem_orders WHERE organization_id = $1 AND numero = ANY($2)`, organizationID, numeros); err != nil {
		log.Printf("[db] delete problems: %v", err)
	}
}

func dbLoadProblems(organizationID string) []*ProblemOrder {
	if db == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := db.Query(ctx, `
		SELECT organization_id::text, numero, saved_at, loja, pedido, data_pedido, cliente, telefone, email, cpf,
		       valor, entrega, estimativa_ink, consultado_em, rastreio, analise
		FROM problem_orders WHERE organization_id = $1 ORDER BY saved_at DESC`, organizationID)
	if err != nil {
		log.Printf("[db] load problems: %v", err)
		return nil
	}
	defer rows.Close()

	var loaded []*ProblemOrder
	for rows.Next() {
		o := &ProblemOrder{}
		var rastreioJSON, analiseJSON []byte
		if err := rows.Scan(
			&o.OrganizationID, &o.Numero, &o.SavedAt, &o.Loja, &o.Pedido, &o.Data, &o.Cliente,
			&o.Telefone, &o.Email, &o.CPF, &o.Valor, &o.Entrega,
			&o.EstimativaInk, &o.ConsultadoEm, &rastreioJSON, &analiseJSON,
		); err != nil {
			continue
		}
		if len(rastreioJSON) > 0 {
			_ = json.Unmarshal(rastreioJSON, &o.Rastreio)
		}
		if len(analiseJSON) > 0 {
			_ = json.Unmarshal(analiseJSON, &o.Analise)
		}
		loaded = append(loaded, o)
	}
	return loaded
}

// ── Idempotência do webhook ───────────────────────────────────────────────────

// dbClaimWebhookEvents registra, numa transação, as chaves ainda não vistas e devolve quais são
// novas. Erro de banco devolve erro sem registrar nada — o webhook responde 503 e a Meta reenvia.
func dbClaimWebhookEvents(keys []webhookEventKey) (map[webhookEventKey]bool, error) {
	ctx, cancel := dbContext()
	defer cancel()
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	fresh, err := claimWebhookKeysTx(ctx, tx, keys)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return fresh, nil
}

func claimWebhookKeysTx(ctx context.Context, tx pgx.Tx, keys []webhookEventKey) (map[webhookEventKey]bool, error) {
	fresh := make(map[webhookEventKey]bool, len(keys))
	for _, k := range keys {
		tag, err := tx.Exec(ctx,
			`INSERT INTO processed_webhook_events (organization_id, event_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			k.OrganizationID, k.Key)
		if err != nil {
			return nil, err
		}
		fresh[k] = tag.RowsAffected() == 1
	}
	return fresh, nil
}

// dbAcceptWebhook é o aceite durável: numa transação, registra as chaves de idempotência e grava na
// inbox cada change que ainda tem evento novo. Devolve os ids gravados. Erro = nada gravado (503).
func dbAcceptWebhook(object string, routed []routedChange) ([]int64, error) {
	ctx, cancel := dbContext()
	defer cancel()
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var keys []webhookEventKey
	for _, rc := range routed {
		keys = append(keys, rc.keys...)
	}
	fresh, err := claimWebhookKeysTx(ctx, tx, keys)
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, rc := range keepFresh(routed, fresh) {
		tenant, err := json.Marshal(storedTenantOf(rc.tenant))
		if err != nil {
			return nil, err
		}
		var freshKeys []string
		for _, k := range rc.keys {
			if fresh[k] {
				freshKeys = append(freshKeys, k.Key)
			}
		}
		var id int64
		if err := tx.QueryRow(ctx,
			`INSERT INTO webhook_inbox (organization_id, tenant, waba_id, object, raw_change, event_keys)
			 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			rc.tenant.OrganizationID, tenant, rc.wabaID, object, string(rc.raw), freshKeys,
		).Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return ids, nil
}

const inboxColumns = `id, organization_id::text, tenant, waba_id, object, raw_change, event_keys, steps, attempts`

// dbClaimInbox pega linhas vencidas da inbox com lease. É o único acesso à inbox sem filtro de
// Organization, por definição: o worker é da plataforma e atende todas. Cada linha devolvida leva a
// própria organization_id, e todo efeito dela roda nesse escopo (inbox.go). Lease vencido (réplica
// que caiu) volta a ser elegível.
func dbClaimInbox(ids []int64, owner string, ttl time.Duration, limit int) ([]*inboxItem, error) {
	ctx, cancel := dbContext()
	defer cancel()
	rows, err := db.Query(ctx,
		`WITH picked AS (
		   SELECT id FROM webhook_inbox
		    WHERE ($1::bigint[] IS NULL OR id = ANY($1))
		      AND ((status = 'pending' AND next_attempt_at <= NOW())
		        OR (status = 'processing' AND lease_until < NOW()))
		    ORDER BY id
		    LIMIT $4
		    FOR UPDATE SKIP LOCKED
		 )
		 UPDATE webhook_inbox w
		    SET status = 'processing', lease_owner = $2, lease_until = NOW() + make_interval(secs => $3),
		        attempts = w.attempts + 1
		   FROM picked
		  WHERE w.id = picked.id
		RETURNING w.id, w.organization_id::text, w.tenant, w.waba_id, w.object, w.raw_change, w.event_keys, w.steps, w.attempts`,
		ids, owner, ttl.Seconds(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*inboxItem
	for rows.Next() {
		it := &inboxItem{}
		var tenant, steps []byte
		if err := rows.Scan(&it.ID, &it.OrganizationID, &tenant, &it.WabaID, &it.Object, &it.Raw, &it.EventKeys, &steps, &it.Attempts); err != nil {
			return nil, err
		}
		var st storedTenant
		if err := json.Unmarshal(tenant, &st); err != nil {
			return nil, err
		}
		it.Tenant = st.context()
		it.Steps = map[string]string{}
		if err := json.Unmarshal(steps, &it.Steps); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

var errInboxLeaseLost = errors.New("lease da inbox perdido para outra réplica")

// dbMarkInboxStep grava o estado de um passo e, na MESMA transação, os eventos que ele produziu —
// assim o evento existe exatamente uma vez. Só vale enquanto o lease for deste worker (e o renova).
func dbMarkInboxStep(it *inboxItem, owner, step, state string, evs []Event) error {
	ctx, cancel := dbContext()
	defer cancel()
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, e := range evs {
		if e.OrganizationID != it.OrganizationID {
			return errors.New("evento de outra organization na inbox")
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO events (organization_id, time, kind, phone, name, message, extra, origem)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			e.OrganizationID, e.Time, string(e.Kind), e.Phone, e.Name, e.Message, e.Extra, e.Origem,
		); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx,
		`UPDATE webhook_inbox
		    SET steps = steps || jsonb_build_object($3::text, $4::text),
		        lease_until = NOW() + make_interval(secs => $6)
		  WHERE id = $1 AND organization_id = $2 AND lease_owner = $5`,
		it.ID, it.OrganizationID, step, state, owner, inboxLeaseTTL.Seconds())
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errInboxLeaseLost
	}
	return tx.Commit(ctx)
}

// dbFinishInbox apaga a linha concluída: o registro de idempotência continua em
// processed_webhook_events, e o conteúdo da mensagem não fica guardado sem necessidade.
func dbFinishInbox(it *inboxItem, owner string) error {
	ctx, cancel := dbContext()
	defer cancel()
	_, err := db.Exec(ctx, `DELETE FROM webhook_inbox WHERE id = $1 AND organization_id = $2 AND lease_owner = $3`,
		it.ID, it.OrganizationID, owner)
	return err
}

// dbRetryInbox devolve a linha para nova tentativa (com espera) ou, esgotadas as tentativas, marca
// como falha visível. O erro gravado não carrega segredo nem conteúdo da mensagem.
func dbRetryInbox(it *inboxItem, owner string, backoff time.Duration, failed bool, reason string) error {
	ctx, cancel := dbContext()
	defer cancel()
	status := "pending"
	if failed {
		status = "failed"
	}
	_, err := db.Exec(ctx,
		`UPDATE webhook_inbox
		    SET status = $4, lease_owner = NULL, lease_until = NULL,
		        next_attempt_at = NOW() + make_interval(secs => $5), last_error = $6
		  WHERE id = $1 AND organization_id = $2 AND lease_owner = $3`,
		it.ID, it.OrganizationID, owner, status, backoff.Seconds(), reason)
	return err
}

// dbPruneWebhookEvents apaga chaves antigas: a Meta não reentrega depois de alguns dias.
func dbPruneWebhookEvents(olderThan time.Duration) {
	// Roda em goroutine: usa o pool do momento em que começou (o global pode ser trocado).
	pool := db
	if pool == nil {
		return
	}
	ctx, cancel := dbContext()
	defer cancel()
	if _, err := pool.Exec(ctx, `DELETE FROM processed_webhook_events WHERE received_at < NOW() - make_interval(secs => $1)`, olderThan.Seconds()); err != nil {
		log.Printf("[db] prune processed_webhook_events: %v", err)
	}
	// Linhas da inbox que esgotaram as tentativas ficam visíveis pelo mesmo prazo e depois saem.
	if _, err := pool.Exec(ctx, `DELETE FROM webhook_inbox WHERE status = 'failed' AND received_at < NOW() - make_interval(secs => $1)`, olderThan.Seconds()); err != nil {
		log.Printf("[db] prune webhook_inbox: %v", err)
	}
}
