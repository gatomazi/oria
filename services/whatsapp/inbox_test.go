package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Aceite durável do webhook (rodada 18, §23/§24). Precisa de WEBHOOK_TEST_DATABASE_URL.

const inboxCustomer = "5548911112222"

func eventRows(t *testing.T, org string) map[string]int {
	t.Helper()
	rows, err := db.Query(context.Background(), `SELECT kind || '|' || phone FROM events WHERE organization_id = $1`, org)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	defer rows.Close()
	got := map[string]int{}
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		got[k]++
	}
	return got
}

func assertExactlyOnce(t *testing.T, got map[string]int, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want exatamente %v", got, want)
	}
	for _, w := range want {
		if got[w] != 1 {
			t.Fatalf("%s aconteceu %d vez(es) (tudo: %v)", w, got[w], got)
		}
	}
}

func TestGivenDatabaseRejectsAcceptance_WhenWebhookArrives_Then503AndNoEffect(t *testing.T) {
	// Given: banco sem o esquema — o aceite durável não consegue gravar
	dsn, schema := newTestSchema(t)
	useSchema(t, dsn, schema)
	useReplyConfig(t)
	useTenants(t, tenantsAB())
	useResolver(t, resolverAB())
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := postSigned(t, inboundFrom(testWabaA, testPhoneA, inboxCustomer, "wamid.NODB"))

	// Then
	time.Sleep(100 * time.Millisecond)
	if rec.Code != http.StatusServiceUnavailable || len(meta.all()) != 0 || events.For(testOrgA).Stats() != (DashStats{}) {
		t.Fatalf("status=%d meta=%d — sem aceite durável não pode haver 200 nem efeito", rec.Code, len(meta.all()))
	}
}

// unavailableOnce simula o painel fora na primeira resolução do remetente.
type unavailableOnce struct {
	*fakeResolver
	failed atomic.Bool
}

func (u *unavailableOnce) Resolve(ctx context.Context, ref senderRef) (metaIdentity, error) {
	if u.failed.CompareAndSwap(false, true) {
		return metaIdentity{}, fmt.Errorf("%w: %w: painel respondeu 503", ErrSenderUnresolved, ErrSenderUnavailable)
	}
	return u.fakeResolver.Resolve(ctx, ref)
}

func TestGivenPanelUnavailableWhileSending_WhenRetrying_ThenEventsAreNotDuplicated(t *testing.T) {
	// Given
	useTestDatabase(t)
	useReplyConfig(t)
	useTenants(t, tenantsAB())
	useResolver(t, &unavailableOnce{fakeResolver: resolverAB()})
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.R"}]}`)

	// When: primeira tentativa grava o evento e para no aviso (painel fora)
	if rec := postSigned(t, inboundFrom(testWabaA, testPhoneA, inboxCustomer, "wamid.RETRY")); rec.Code != http.StatusOK {
		t.Fatalf("webhook = %d", rec.Code)
	}
	webhookWork.Wait()
	pending := countRows(t, `SELECT count(*) FROM webhook_inbox WHERE status = 'pending' AND attempts = 1 AND last_error LIKE '%unavailable%'`)
	if _, err := db.Exec(context.Background(), `UPDATE webhook_inbox SET next_attempt_at = NOW()`); err != nil {
		t.Fatalf("antecipar: %v", err)
	}
	restart()
	drainInbox(nil)

	// Then
	if pending != 1 {
		t.Fatalf("a falha passageira não voltou para a fila (%d)", pending)
	}
	assertExactlyOnce(t, eventRows(t, testOrgA), "received|"+inboxCustomer, "sent|"+inboxCustomer)
	if n := len(meta.all()); n != 2 {
		t.Fatalf("envios = %d, want aviso + resposta", n)
	}
	if n := countRows(t, `SELECT count(*) FROM webhook_inbox`); n != 0 {
		t.Fatalf("inbox = %d", n)
	}
}

func TestGivenForwardKeepsFailing_WhenAttemptsRunOut_ThenRowIsMarkedFailedWithoutSecret(t *testing.T) {
	// Given: o painel recusa o repasse
	useTestDatabase(t)
	useReplyConfig(t)
	useTenants(t, tenantsAB())
	useResolver(t, resolverAB())
	useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.R"}]}`)
	fwd, capture := useForwardServer(t, http.StatusUnauthorized)
	cfg.ForwardURL, cfg.ForwardSecret = fwd.URL, testForwardSecret
	previous := inboxMaxAttempts
	inboxMaxAttempts = 2
	t.Cleanup(func() { inboxMaxAttempts = previous })

	// When
	postSigned(t, statusPayload(testWabaA, testPhoneA, "wamid.FWD-FAIL", "delivered"))
	webhookWork.Wait()
	if _, err := db.Exec(context.Background(), `UPDATE webhook_inbox SET next_attempt_at = NOW()`); err != nil {
		t.Fatalf("antecipar: %v", err)
	}
	drainInbox(nil)

	// Then
	if n := len(capture.all()); n != 2 {
		t.Fatalf("tentativas de repasse = %d, want 2", n)
	}
	var status, lastError string
	if err := db.QueryRow(context.Background(), `SELECT status, last_error FROM webhook_inbox WHERE organization_id = $1`, testOrgA).Scan(&status, &lastError); err != nil {
		t.Fatalf("linha: %v", err)
	}
	if status != "failed" || !strings.Contains(lastError, "401") || strings.Contains(lastError, testForwardSecret) {
		t.Fatalf("status=%s last_error=%q", status, lastError)
	}
	if n := drainInbox(nil); n != 0 {
		t.Fatalf("linha falha foi reprocessada (%d)", n)
	}
}

func TestGivenInboxRowLeasedByOneReplica_WhenAnotherClaims_ThenItOnlyGetsItAfterTheLeaseExpires(t *testing.T) {
	// Given
	useTestDatabase(t)
	useTenants(t, tenantsAB())
	raw := json.RawMessage(`{"field":"messages","value":{"metadata":{"phone_number_id":"` + testPhoneA + `"},"statuses":[{"id":"wamid.L","status":"read"}]}}`)
	var ch InboundChange
	_ = json.Unmarshal(raw, &ch)
	rc := routedChange{tenant: tenantA(), wabaID: testWabaA, raw: raw, change: ch, keys: changeKeys(testOrgA, raw, ch)}
	ids, err := dbAcceptWebhook("whatsapp_business_account", []routedChange{rc})
	if err != nil || len(ids) != 1 {
		t.Fatalf("aceite: %v %v", ids, err)
	}

	// When
	first, err1 := dbClaimInbox(nil, "r1", time.Second, 10)
	second, err2 := dbClaimInbox(nil, "r2", time.Second, 10)
	time.Sleep(1100 * time.Millisecond)
	third, err3 := dbClaimInbox(nil, "r2", time.Second, 10)

	// Then
	if err1 != nil || err2 != nil || err3 != nil {
		t.Fatalf("claim: %v %v %v", err1, err2, err3)
	}
	if len(first) != 1 || len(second) != 0 || len(third) != 1 || third[0].Attempts != 2 {
		t.Fatalf("r1=%d r2=%d depois do lease=%d", len(first), len(second), len(third))
	}
	if first[0].OrganizationID != testOrgA || first[0].Tenant.SenderRef != testRefA || strings.Contains(first[0].Raw, testTokenA) {
		t.Fatalf("linha = %+v", first[0])
	}
	// r1 perdeu o lease: não consegue mais marcar passo
	if err := dbMarkInboxStep(first[0], "r1", stepEvents, stepDone, nil); err != errInboxLeaseLost {
		t.Fatalf("réplica sem lease marcou passo: %v", err)
	}
}
