package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Persistência real (Fase 5b/5c). Só roda com WEBHOOK_TEST_DATABASE_URL apontando para um Postgres
// descartável; cada teste usa um schema próprio e o apaga no fim.

const (
	childSchemaEnv = "WEBHOOK_TEST_SCHEMA"
	childWorkerEnv = "WEBHOOK_QUEUE_WORKER"
	childOutEnv    = "WEBHOOK_QUEUE_WORKER_OUT"
)

func connectSchema(t *testing.T, dsn, schema string) *pgxpool.Pool {
	t.Helper()
	conf, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	conf.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(context.Background(), conf)
	if err != nil {
		t.Fatalf("connect schema: %v", err)
	}
	return pool
}

// newTestSchema cria um schema vazio e devolve o nome; migrate fica a cargo de quem chama.
func newTestSchema(t *testing.T) (string, string) {
	t.Helper()
	dsn := os.Getenv("WEBHOOK_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("WEBHOOK_TEST_DATABASE_URL não definida")
	}
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	schema := "wa_test_" + hex.EncodeToString(suffix)
	admin, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if _, err := admin.Exec(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})
	return dsn, schema
}

func useSchema(t *testing.T, dsn, schema string) {
	t.Helper()
	pool := connectSchema(t, dsn, schema)
	previous := db
	db = pool
	t.Cleanup(func() {
		db = previous
		pool.Close()
	})
}

func useTestDatabase(t *testing.T) (string, string) {
	t.Helper()
	dsn, schema := newTestSchema(t)
	useSchema(t, dsn, schema)
	if err := migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return dsn, schema
}

// restart simula um processo novo: memória zerada, mesmo banco.
func restart() { resetTenantState() }

func countRows(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func waitRows(t *testing.T, want int, query string, args ...any) {
	t.Helper()
	waitFor(t, fmt.Sprintf("%d linha(s): %s", want, query), func() bool { return countRows(t, query, args...) == want })
}

func TestGivenRetryItemOfB_WhenServiceRestarts_ThenOrganizationSenderAndSourceWamidSurvive(t *testing.T) {
	// Given
	useTestDatabase(t)
	useQueue(t)
	_, dup := queues.For(testOrgB).AddRetry(QueueAddRequest{
		Type: "template", To: "5548999990000", Template: "pix", Language: "pt_BR",
		Sender: senderRef{PhoneNumberID: testPhoneB, Ref: testRefB}, OrganizationID: testOrgB, IntegrationID: testIntegrationB,
	}, "wamid.PERSISTE", "falhou")
	if dup {
		t.Fatalf("primeiro retry não pode ser duplicata")
	}

	// When: novo processo
	restart()

	// Then
	items := queues.For(testOrgB).All()
	if len(items) != 1 {
		t.Fatalf("itens de B = %d, want 1", len(items))
	}
	it := items[0]
	if it.Sender != (senderRef{PhoneNumberID: testPhoneB, Ref: testRefB}) || it.SourceWamid != "wamid.PERSISTE" ||
		it.OrganizationID != testOrgB || it.IntegrationID != testIntegrationB {
		t.Fatalf("item carregado = %+v", it)
	}
	if len(queues.For(testOrgA).All()) != 0 {
		t.Fatalf("o item de B apareceu na fila de A")
	}
	if _, dup := queues.For(testOrgB).AddRetry(QueueAddRequest{Type: "template", To: "5548999990000", Template: "pix", OrganizationID: testOrgB}, "wamid.PERSISTE", "de novo"); !dup {
		t.Fatalf("o mesmo webhook depois do restart não pode criar outro retry")
	}
	// O mesmo wamid em A é outro evento (INV-34).
	if _, dup := queues.For(testOrgA).AddRetry(QueueAddRequest{Type: "template", To: "5548999990000", Template: "pix", OrganizationID: testOrgA,
		Sender: senderRef{PhoneNumberID: testPhoneA, Ref: testRefA}}, "wamid.PERSISTE", "outro tenant"); dup {
		t.Fatalf("wamid de B não pode deduplicar A")
	}
}

func TestGivenRetryAfterRestart_WhenDispatching_ThenItLeavesWithTheOriginalTenantSender(t *testing.T) {
	// Given (INV-37): item de A criado antes do restart, ambiente com o remetente antigo
	useTestDatabase(t)
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	useQueue(t)
	queues.For(testOrgA).AddRetry(QueueAddRequest{Type: "template", To: "5548911110000", Template: "pix",
		Sender: senderRef{PhoneNumberID: testPhoneA, Ref: testRefA}, OrganizationID: testOrgA, IntegrationID: testIntegrationA}, "wamid.R1", "falhou")
	restart()
	useResolver(t, resolverAB())
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.R2"}]}`)
	id := queues.For(testOrgA).All()[0].ID

	// When: B tenta reenviar o id de A; depois A reenvia
	sentB, _, _ := queues.For(testOrgB).Send([]int64{id})
	sentA, failedA, _ := queues.For(testOrgA).Send([]int64{id})

	// Then
	if sentB != 0 || sentA != 1 || failedA != 0 {
		t.Fatalf("B enviou %d, A enviou %d/%d", sentB, sentA, failedA)
	}
	calls := meta.all()
	if len(calls) != 1 || !strings.Contains(calls[0].URL, "/"+testPhoneA+"/") || calls[0].Auth != "Bearer "+testTokenA {
		t.Fatalf("calls = %+v, want um envio pelo remetente de A", calls)
	}
	if got := queues.For(testOrgA).All()[0]; got.Status != "sent" {
		t.Fatalf("status = %s", got.Status)
	}
}

func TestGivenPersistedRow_WhenReadingColumns_ThenNoTokenIsStored(t *testing.T) {
	// Given
	useTestDatabase(t)
	useQueue(t)
	useConfig(t, Config{APIKey: testAPIKey})
	rec := callRoute(handleQueueAdd, false, http.MethodPost, "/queue/add", queueTemplateBody, withAPIKey(headersA()))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	// When
	var row string
	err := db.QueryRow(context.Background(), `SELECT row_to_json(q)::text FROM queue_items q`).Scan(&row)

	// Then
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if strings.Contains(row, testTokenA) {
		t.Fatalf("token persistido na fila: %s", row)
	}
	for _, want := range []string{testRefA, testPhoneA, testOrgA} {
		if !strings.Contains(row, want) {
			t.Fatalf("linha sem %s: %s", want, row)
		}
	}
}

func TestGivenLegacyRowsWithoutMapping_WhenMigrating_ThenMigrationFailsAndAssignsNothing(t *testing.T) {
	// Given: banco da Fase 5b com dados históricos
	dsn, schema := newTestSchema(t)
	useSchema(t, dsn, schema)
	ctx := context.Background()
	tx, _ := db.Begin(ctx)
	if err := migrateBaseline(ctx, tx); err != nil {
		t.Fatalf("baseline: %v", err)
	}
	_, _ = tx.Exec(ctx, `CREATE TABLE schema_migrations (version INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
		INSERT INTO schema_migrations (version, name) VALUES (1, 'baseline');
		INSERT INTO events (kind, phone) VALUES ('received', '5548');
		INSERT INTO problem_orders (numero, telefone) VALUES ('X1', '5548');
		INSERT INTO queue_items (type, to_phone) VALUES ('template', '5548')`)
	_ = tx.Commit(ctx)
	t.Setenv("LEGACY_ORGANIZATION_ID", "")

	// When
	err := migrate(ctx)

	// Then: nenhum dono inferido
	if !errors.Is(err, ErrLegacyMappingRequired) {
		t.Fatalf("err = %v, want mapeamento obrigatório", err)
	}
	if n := countRows(t, `SELECT count(*) FROM schema_migrations WHERE version = 2`); n != 0 {
		t.Fatalf("migration 2 registrada sem mapeamento")
	}

	// And: com o mapeamento explícito, as linhas vão para a Organization declarada
	t.Setenv("LEGACY_ORGANIZATION_ID", strings.ToUpper(testOrgA))
	if err := migrate(ctx); err != nil {
		t.Fatalf("migrate com mapeamento: %v", err)
	}
	for _, table := range []string{"events", "problem_orders", "queue_items"} {
		if n := countRows(t, `SELECT count(*) FROM `+table+` WHERE organization_id = $1`, testOrgA); n != 1 {
			t.Fatalf("%s: %d linha(s) em A", table, n)
		}
	}
	// O item antigo não tem remetente: continua não saindo (OPS-30).
	restart()
	if sent, failed, _ := queues.For(testOrgA).Send(nil); sent != 0 || failed != 1 {
		t.Fatalf("item antigo: sent=%d failed=%d", sent, failed)
	}
}

func TestGivenSameOrderNumberInAAndB_WhenSaving_ThenRecordsAndPIIStayIndependent(t *testing.T) {
	// Given (WG-23 / B-26)
	useTestDatabase(t)
	useQueue(t)
	problemStores.For(testOrgA).Upsert(&ProblemOrder{Numero: "X", Loja: "Loja A", Telefone: "5548-A", Email: "a@a", CPF: "111"})
	problemStores.For(testOrgB).Upsert(&ProblemOrder{Numero: "X", Loja: "Loja B", Telefone: "5548-B", Email: "b@b", CPF: "222"})
	waitRows(t, 2, `SELECT count(*) FROM problem_orders WHERE numero = 'X'`)

	// When: A atualiza sem PII; processo reinicia
	problemStores.For(testOrgA).Upsert(&ProblemOrder{Numero: "X", Loja: "Loja A", ConsultadoEm: "agora"})
	waitRows(t, 1, `SELECT count(*) FROM problem_orders WHERE organization_id = $1 AND consultado_em = 'agora'`, testOrgA)
	restart()

	// Then
	a := problemStores.For(testOrgA).All()
	b := problemStores.For(testOrgB).All()
	if len(a) != 1 || len(b) != 1 {
		t.Fatalf("A=%d B=%d", len(a), len(b))
	}
	if a[0].Telefone != "5548-A" || a[0].CPF != "111" || b[0].Telefone != "5548-B" || b[0].CPF != "222" {
		t.Fatalf("PII cruzou: A=%+v B=%+v", a[0], b[0])
	}
}

func TestGivenProblemsSyncFromA_WhenBodyTriesAnotherScope_ThenOnlyARecordsAreRemoved(t *testing.T) {
	// Given (WG-24 / INV-31)
	useTestDatabase(t)
	useQueue(t)
	useConfig(t, Config{APIKey: testAPIKey})
	for _, org := range []string{testOrgA, testOrgB} {
		problemStores.For(org).Upsert(&ProblemOrder{Numero: "X", Loja: "Use Sul"})
		problemStores.For(org).Upsert(&ProblemOrder{Numero: "Y", Loja: "Use Sul"})
	}
	waitRows(t, 4, `SELECT count(*) FROM problem_orders`)

	// When: corpo tenta outro escopo; depois lista vazia (limpa tudo da loja — só em A)
	forged := callTenantRoute(handleProblemsSync, http.MethodPost, "/problems/sync",
		`{"loja":"Use Sul","numeros":[],"organization_id":"`+testOrgB+`"}`, withAPIKey(refHeaders(testPhoneA, testRefA)))
	clean := callTenantRoute(handleProblemsSync, http.MethodPost, "/problems/sync",
		`{"loja":"Use Sul","numeros":[]}`, withAPIKey(refHeaders(testPhoneA, testRefA)))

	// Then
	if forged.Code != http.StatusBadRequest || clean.Code != http.StatusOK {
		t.Fatalf("forjado=%d limpo=%d", forged.Code, clean.Code)
	}
	waitRows(t, 0, `SELECT count(*) FROM problem_orders WHERE organization_id = $1`, testOrgA)
	if n := countRows(t, `SELECT count(*) FROM problem_orders WHERE organization_id = $1`, testOrgB); n != 2 {
		t.Fatalf("B perdeu registros: %d", n)
	}
	if len(problemStores.For(testOrgB).All()) != 2 {
		t.Fatalf("B perdeu registros em memória")
	}
}

func TestGivenEventsOfAAndB_WhenClearingAAndRestarting_ThenBIsUntouched(t *testing.T) {
	// Given
	useTestDatabase(t)
	useQueue(t)
	events.Push(Event{Time: time.Now(), Kind: KindReceived, Phone: "1", OrganizationID: testOrgA})
	events.Push(Event{Time: time.Now(), Kind: KindReceived, Phone: "2", OrganizationID: testOrgB})
	events.Push(Event{Time: time.Now(), Kind: KindReceived, Phone: "3"}) // sem Organization: descartado
	waitRows(t, 2, `SELECT count(*) FROM events`)

	// When
	events.Clear(testOrgA)
	waitRows(t, 0, `SELECT count(*) FROM events WHERE organization_id = $1`, testOrgA)
	restart()

	// Then
	if st := events.For(testOrgB).Stats(); st.Received != 1 {
		t.Fatalf("B depois do restart = %+v", st)
	}
	if n := len(events.For(testOrgA).Recent(0)); n != 0 {
		t.Fatalf("A depois de limpar = %d", n)
	}
}

func TestGivenWebhookKeys_WhenClaimedTwiceAndAcrossTenants_ThenOnlyTheFirstPerOrganizationIsFresh(t *testing.T) {
	// Given (INV-16)
	useTestDatabase(t)
	keyA := webhookEventKey{testOrgA, "message:wamid.K"}
	keyB := webhookEventKey{testOrgB, "message:wamid.K"}

	// When
	first, err1 := claimWebhookEvents([]webhookEventKey{keyA})
	restart()
	second, err2 := claimWebhookEvents([]webhookEventKey{keyA, keyB})

	// Then
	if err1 != nil || err2 != nil {
		t.Fatalf("claim: %v %v", err1, err2)
	}
	if !first[keyA] || second[keyA] || !second[keyB] {
		t.Fatalf("first=%v second=%v", first, second)
	}
}

// ── INV-18: duas réplicas, a mesma fila ────────────────────────────────────────────────────────

func runQueueWorker(t *testing.T, dsn, schema, out string, extra ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestQueueWorkerProcess$")
	cmd.Env = append(os.Environ(), childWorkerEnv+"=1", "WEBHOOK_TEST_DATABASE_URL="+dsn, childSchemaEnv+"="+schema, childOutEnv+"="+out)
	cmd.Env = append(cmd.Env, extra...)
	cmd.Args = append(cmd.Args, "-test.v")
	return cmd
}

// TestQueueWorkerProcess é o processo filho: uma réplica que despacha as filas de A e B.
func TestQueueWorkerProcess(t *testing.T) {
	if os.Getenv(childWorkerEnv) != "1" {
		t.Skip("só roda como processo filho")
	}
	pool := connectSchema(t, os.Getenv("WEBHOOK_TEST_DATABASE_URL"), os.Getenv(childSchemaEnv))
	db = pool
	panelTenants = tenantsAB()
	panelSender = resolverAB()
	cfg = Config{APIVersion: "v21.0"}
	if ttl := os.Getenv("WEBHOOK_QUEUE_LEASE"); ttl != "" {
		queueLeaseTTL, _ = time.ParseDuration(ttl)
	}
	if batch := os.Getenv("WEBHOOK_QUEUE_BATCH"); batch != "" {
		_, _ = fmt.Sscanf(batch, "%d", &queueClaimBatch)
	}
	if os.Getenv("WEBHOOK_QUEUE_CRASH") == "1" {
		// Queda logo depois de pegar o lease, antes de enviar.
		afterQueueClaim = func([]*QueueItem) { os.Exit(3) }
	}
	var mu sync.Mutex
	var sent []string
	httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var body struct {
			To string `json:"to"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		sent = append(sent, strings.Split(strings.TrimPrefix(r.URL.Path, "/v21.0/"), "/")[0]+"|"+body.To)
		mu.Unlock()
		time.Sleep(10 * time.Millisecond)
		return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Header: http.Header{}}, nil
	})}
	// Barreira de largada: as réplicas disputam os mesmos itens ao mesmo tempo.
	var start int64
	if _, err := fmt.Sscanf(os.Getenv("WEBHOOK_QUEUE_START"), "%d", &start); err == nil {
		time.Sleep(time.Until(time.UnixMilli(start)))
	}
	var wg sync.WaitGroup
	for _, org := range []string{testOrgA, testOrgB} {
		wg.Add(1)
		go func(org string) {
			defer wg.Done()
			_, _, _ = queues.For(org).Send(nil)
		}(org)
	}
	wg.Wait()
	f, err := os.OpenFile(os.Getenv(childOutEnv), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("out: %v", err)
	}
	defer f.Close()
	for _, s := range sent {
		fmt.Fprintln(f, s)
	}
}

func seedQueue(t *testing.T, perOrg int) map[string]string {
	t.Helper()
	want := map[string]string{}
	for _, org := range []struct{ id, phone, ref string }{{testOrgA, testPhoneA, testRefA}, {testOrgB, testPhoneB, testRefB}} {
		for i := 0; i < perOrg; i++ {
			to := fmt.Sprintf("55%s%04d", org.phone[len(org.phone)-1:], i)
			item := &QueueItem{AddedAt: time.Now(), Type: "text", To: to, Message: "oi", Status: "pending",
				OrganizationID: org.id, Sender: senderRef{PhoneNumberID: org.phone, Ref: org.ref}}
			if _, err := dbInsertQueueItem(item); err != nil {
				t.Fatalf("seed: %v", err)
			}
			want[org.phone+"|"+to] = org.id
		}
	}
	return want
}

func readSent(t *testing.T, out string) map[string]int {
	t.Helper()
	raw, _ := os.ReadFile(out)
	got := map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line != "" {
			got[line]++
		}
	}
	return got
}

func TestGivenTwoReplicas_WhenBothDispatchTheSameQueues_ThenEveryItemIsSentExactlyOnce(t *testing.T) {
	// Given
	dsn, schema := useTestDatabase(t)
	want := seedQueue(t, 40)
	dir := t.TempDir()

	// When: dois processos, lotes pequenos, largando juntos
	start := fmt.Sprintf("WEBHOOK_QUEUE_START=%d", time.Now().Add(1500*time.Millisecond).UnixMilli())
	a := runQueueWorker(t, dsn, schema, dir+"/a.txt", start, "WEBHOOK_QUEUE_BATCH=3")
	b := runQueueWorker(t, dsn, schema, dir+"/b.txt", start, "WEBHOOK_QUEUE_BATCH=3")
	var logA, logB strings.Builder
	a.Stdout, a.Stderr = &logA, &logA
	b.Stdout, b.Stderr = &logB, &logB
	if err := a.Start(); err != nil {
		t.Fatalf("start a: %v", err)
	}
	if err := b.Start(); err != nil {
		t.Fatalf("start b: %v", err)
	}
	errA, errB := a.Wait(), b.Wait()

	// Then
	if errA != nil || errB != nil {
		t.Fatalf("workers: %v / %v", errA, errB)
	}
	sentA, sentB := readSent(t, dir+"/a.txt"), readSent(t, dir+"/b.txt")
	if len(sentA) == 0 || len(sentB) == 0 {
		t.Fatalf("sem disputa real: A enviou %d, B enviou %d\n--- A ---\n%s\n--- B ---\n%s", len(sentA), len(sentB), logA.String(), logB.String())
	}
	got := map[string]int{}
	for _, m := range []map[string]int{sentA, sentB} {
		for k, n := range m {
			got[k] += n
		}
	}
	if len(got) != len(want) {
		t.Fatalf("enviados distintos = %d, want %d", len(got), len(want))
	}
	for k, n := range got {
		if n != 1 {
			t.Fatalf("%s enviado %d vezes", k, n)
		}
		if _, ok := want[k]; !ok {
			t.Fatalf("envio inesperado (par cruzado?): %s", k)
		}
	}
	if n := countRows(t, `SELECT count(*) FROM queue_items WHERE status <> 'sent'`); n != 0 {
		t.Fatalf("%d item(ns) não terminaram como enviados", n)
	}
}

func TestGivenReplicaCrashesHoldingLeases_WhenAnotherReplicaRuns_ThenNothingIsDuplicatedOrLost(t *testing.T) {
	// Given
	dsn, schema := useTestDatabase(t)
	want := seedQueue(t, 60)
	out := t.TempDir() + "/sent.txt"

	// When: a primeira réplica pega um lote de cada Organization e cai; o lease vence; a segunda roda
	crashed := runQueueWorker(t, dsn, schema, out, "WEBHOOK_QUEUE_CRASH=1", "WEBHOOK_QUEUE_LEASE=1s")
	if err := crashed.Run(); err == nil {
		t.Fatalf("a réplica deveria ter caído")
	}
	held := countRows(t, `SELECT count(*) FROM queue_items WHERE status = 'sending'`)
	time.Sleep(1200 * time.Millisecond)
	if err := runQueueWorker(t, dsn, schema, out).Run(); err != nil {
		t.Fatalf("segunda réplica: %v", err)
	}

	// Then: os itens do lote interrompido viram erro (não reenviados às cegas); o resto sai uma vez
	if held == 0 {
		t.Fatalf("a réplica caiu sem segurar lease nenhum — o teste não provou nada")
	}
	got := readSent(t, out)
	for k, n := range got {
		if n != 1 {
			t.Fatalf("%s enviado %d vezes", k, n)
		}
	}
	interrupted := countRows(t, `SELECT count(*) FROM queue_items WHERE status = 'error' AND error_msg LIKE 'envio interrompido%'`)
	if interrupted != held {
		t.Fatalf("interrompidos = %d, want %d", interrupted, held)
	}
	if len(got)+interrupted != len(want) {
		t.Fatalf("enviados %d + interrompidos %d != %d — item sumiu", len(got), interrupted, len(want))
	}
	if n := countRows(t, `SELECT count(*) FROM queue_items WHERE status IN ('pending', 'sending')`); n != 0 {
		t.Fatalf("%d item(ns) presos", n)
	}
}

func TestGivenALeaseHeldInAnOpenTransaction_WhenAnotherReplicaClaims_ThenItGetsOtherItemsWithoutWaiting(t *testing.T) {
	// Given: réplica 1 pegou 3 itens e ainda não confirmou
	useTestDatabase(t)
	seedQueue(t, 6)
	ctx := context.Background()
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	first, err := claimQueueItems(ctx, tx, testOrgA, nil, []string{"pending"}, "r1", time.Minute, 3)
	if err != nil || len(first) != 3 {
		t.Fatalf("réplica 1: %d itens, %v", len(first), err)
	}

	// When: réplica 2 disputa ao mesmo tempo (sem esperar o lock)
	waitCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	second, err := claimQueueItems(waitCtx, db, testOrgA, nil, []string{"pending"}, "r2", time.Minute, 3)

	// Then
	if err != nil {
		t.Fatalf("réplica 2 ficou esperando ou falhou: %v", err)
	}
	if len(second) != 3 {
		t.Fatalf("réplica 2 pegou %d itens, want 3", len(second))
	}
	held := map[int64]bool{}
	for _, it := range first {
		held[it.ID] = true
	}
	for _, it := range second {
		if held[it.ID] {
			t.Fatalf("item %d pego pelas duas réplicas", it.ID)
		}
		if it.OrganizationID != testOrgA {
			t.Fatalf("item de outra Organization: %+v", it)
		}
	}
}
