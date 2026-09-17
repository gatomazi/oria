package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeResolver struct {
	mu    sync.Mutex
	calls int
	ids   map[string]metaIdentity
	err   error
}

func (f *fakeResolver) Resolve(_ context.Context, ref senderRef) (metaIdentity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return metaIdentity{}, f.err
	}
	id, ok := f.ids[ref.Ref]
	if !ok {
		return metaIdentity{}, ErrSenderUnresolved
	}
	if id.PhoneNumberID != ref.PhoneNumberID {
		return metaIdentity{}, ErrSenderMismatch
	}
	return id, nil
}

func (f *fakeResolver) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func useResolver(t *testing.T, r senderResolver) {
	t.Helper()
	original := panelSender
	panelSender = r
	t.Cleanup(func() { panelSender = original })
}

func resolverAB() *fakeResolver {
	return &fakeResolver{ids: map[string]metaIdentity{
		testRefA: {PhoneNumberID: testPhoneA, WabaID: testWabaA, AccessToken: testTokenA, Ref: testRefA},
		testRefB: {PhoneNumberID: testPhoneB, WabaID: testWabaB, AccessToken: testTokenB, Ref: testRefB},
	}}
}

// useQueue parte de estado limpo (painel falso A/B) e devolve a fila de A.
func useQueue(t *testing.T) *MsgQueue {
	t.Helper()
	useTenants(t, tenantsAB())
	return queues.For(testOrgA)
}

func refHeaders(phone, ref string) map[string]string {
	return map[string]string{headerSenderPhoneNumberID: phone, headerSenderRef: ref}
}

// callTenantRoute passa pela cadeia das rotas internas de leitura: auth → withTenant → handler.
func callTenantRoute(handler http.HandlerFunc, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	auth(withTenant(handler))(rec, req)
	return rec
}

func postSigned(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return postWebhook(t, signPayload(cfg.AppSecret, body), body)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("tempo esgotado esperando: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

const queueTemplateBody = `{"type":"template","to":"5548999990000","template":"carrinho","language":"pt_BR","pedido":"INK1","loja":"Use Sul"}`

func TestGivenSenderA_WhenQueueingItem_ThenItemKeepsReferenceAndListingHidesIt(t *testing.T) {
	// Given
	useConfig(t, Config{APIKey: testAPIKey})
	q := useQueue(t)

	// When
	rec := callRoute(handleQueueAdd, false, http.MethodPost, "/queue/add", queueTemplateBody, withAPIKey(headersA()))

	// Then
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	items := q.All()
	if len(items) != 1 || items[0].Sender != (senderRef{PhoneNumberID: testPhoneA, Ref: testRefA}) ||
		items[0].OrganizationID != testOrgA || items[0].IntegrationID != testIntegrationA {
		t.Fatalf("items = %+v, want o remetente e a Organization A gravados", items)
	}
	listing := callTenantRoute(handleQueueList, http.MethodGet, "/queue/list", "", withAPIKey(refHeaders(testPhoneA, testRefA)))
	if listing.Code != http.StatusOK || !strings.Contains(listing.Body.String(), `"to":"5548999990000"`) {
		t.Fatalf("listagem de A = %d %s", listing.Code, listing.Body.String())
	}
	for _, secret := range []string{testTokenA, testRefA, testOrgA} {
		if strings.Contains(listing.Body.String(), secret) {
			t.Fatalf("listagem expôs credencial/referência: %s", listing.Body.String())
		}
	}
}

func TestGivenSameTemplateFromTwoSenders_WhenQueueing_ThenNeitherIsDuplicate(t *testing.T) {
	// Given: o mesmo cliente pode ser da loja A e da loja B
	useConfig(t, Config{APIKey: testAPIKey})
	q := useQueue(t)

	// When
	ra := callRoute(handleQueueAdd, false, http.MethodPost, "/queue/add", queueTemplateBody, withAPIKey(headersA()))
	rb := callRoute(handleQueueAdd, false, http.MethodPost, "/queue/add", queueTemplateBody, withAPIKey(headersB()))
	again := callRoute(handleQueueAdd, false, http.MethodPost, "/queue/add", queueTemplateBody, withAPIKey(headersA()))

	// Then
	if strings.Contains(rb.Body.String(), "duplicate") || strings.Contains(ra.Body.String(), "duplicate") {
		t.Fatalf("remetentes diferentes viraram duplicata: a=%s b=%s", ra.Body.String(), rb.Body.String())
	}
	if !strings.Contains(again.Body.String(), "duplicate") {
		t.Fatalf("mesmo remetente repetido deveria ser duplicata: %s", again.Body.String())
	}
	if len(q.All()) != 1 || len(queues.For(testOrgB).All()) != 1 {
		t.Fatalf("filas A=%d B=%d, want 1 cada", len(q.All()), len(queues.For(testOrgB).All()))
	}
	listaB := callTenantRoute(handleQueueList, http.MethodGet, "/queue/list", "", withAPIKey(refHeaders(testPhoneB, testRefB)))
	var decoded struct {
		Items []QueueItem `json:"items"`
	}
	_ = json.Unmarshal(listaB.Body.Bytes(), &decoded)
	if len(decoded.Items) != 1 {
		t.Fatalf("listagem de B = %s, want só o item de B", listaB.Body.String())
	}
}

func TestGivenQueuedItemsFromAAndB_WhenDispatching_ThenEachLeavesWithItsOwnPair(t *testing.T) {
	// Given: ambiente com o remetente antigo — não pode ser usado
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	q := useQueue(t)
	resolver := resolverAB()
	useResolver(t, resolver)
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.X"}]}`)
	// intercalado A/B/A/B
	for _, add := range []struct {
		template string
		headers  map[string]string
	}{{"carrinho", headersA()}, {"carrinho", headersB()}, {"pix", headersA()}, {"pix", headersB()}} {
		body := strings.Replace(queueTemplateBody, "carrinho", add.template, 1)
		callRoute(handleQueueAdd, false, http.MethodPost, "/queue/add", body, withAPIKey(add.headers))
	}

	// When
	sentA, failedA, _ := q.Send(nil)
	sentB, failedB, _ := queues.For(testOrgB).Send(nil)

	// Then
	if failedA+failedB != 0 || sentA != 2 || sentB != 2 {
		t.Fatalf("A sent=%d failed=%d, B sent=%d failed=%d, want 2/0 cada", sentA, failedA, sentB, failedB)
	}
	calls := meta.all()
	if len(calls) != 4 {
		t.Fatalf("meta calls = %d", len(calls))
	}
	for _, c := range calls {
		switch {
		case strings.Contains(c.URL, "/"+testPhoneA+"/") && c.Auth == "Bearer "+testTokenA:
		case strings.Contains(c.URL, "/"+testPhoneB+"/") && c.Auth == "Bearer "+testTokenB:
		default:
			t.Fatalf("par cruzado ou do ambiente: %+v", c)
		}
	}
	if resolver.count() != 2 {
		t.Fatalf("resolver chamado %d vezes, want 1 por referência por lote", resolver.count())
	}
	if len(events.For(testOrgA).Recent(0)) != 2 || len(events.For(testOrgB).Recent(0)) != 2 {
		t.Fatalf("eventos A=%d B=%d, want 2 cada", len(events.For(testOrgA).Recent(0)), len(events.For(testOrgB).Recent(0)))
	}
}

func TestGivenResolverFails_WhenDispatching_ThenItemFailsAndEnvironmentIsNotUsed(t *testing.T) {
	// Given
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	q := useQueue(t)
	useResolver(t, &fakeResolver{err: errors.New("painel fora do ar")})
	meta := useMetaTransport(t, http.StatusOK, `{}`)
	callRoute(handleQueueAdd, false, http.MethodPost, "/queue/add", queueTemplateBody, withAPIKey(headersA()))

	// When
	sent, failed, _ := q.Send(nil)

	// Then
	if sent != 0 || failed != 1 {
		t.Fatalf("sent=%d failed=%d", sent, failed)
	}
	if len(meta.all()) != 0 {
		t.Fatalf("item sem remetente resolvido não pode sair (nem pelo ambiente)")
	}
	if item := q.All()[0]; item.Status != "error" || !strings.Contains(item.ErrorMsg, "painel fora do ar") {
		t.Fatalf("item = %+v", item)
	}
}

func TestGivenIntegrationChangedNumber_WhenDispatching_ThenItemFailsClosed(t *testing.T) {
	// Given: a referência de A agora resolve para outro número
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	q := useQueue(t)
	resolver := resolverAB()
	resolver.ids[testRefA] = metaIdentity{PhoneNumberID: "1119999999", AccessToken: testTokenA, Ref: testRefA}
	useResolver(t, resolver)
	meta := useMetaTransport(t, http.StatusOK, `{}`)
	callRoute(handleQueueAdd, false, http.MethodPost, "/queue/add", queueTemplateBody, withAPIKey(headersA()))

	// When
	_, failed, _ := q.Send(nil)

	// Then
	if failed != 1 || len(meta.all()) != 0 {
		t.Fatalf("failed=%d calls=%d — número divergente não pode sair", failed, len(meta.all()))
	}
}

func TestGivenTemplateSentByB_WhenMetaReportsFailure_ThenRetryKeepsSenderAndSourceWamid(t *testing.T) {
	// Given
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey, AppSecret: "segredo"})
	useQueue(t)
	useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.RETRY-B"}]}`)
	body := `{"to":"5548999990000","template":"pix","language":"en"}`
	if rec := callRoute(handleSendTemplate, false, http.MethodPost, "/send/template", body, withAPIKey(headersB())); rec.Code != http.StatusOK {
		t.Fatalf("send status = %d", rec.Code)
	}
	failedB := statusPayload(testWabaB, testPhoneB, "wamid.RETRY-B", "failed")
	failedA := statusPayload(testWabaA, testPhoneA, "wamid.RETRY-B", "failed")

	// When: o mesmo webhook de B chega duas vezes; um "failed" de A com o mesmo wamid também
	for _, payload := range []string{failedB, failedB, failedA} {
		if rec := postSigned(t, payload); rec.Code != http.StatusOK {
			t.Fatalf("webhook = %d", rec.Code)
		}
	}
	waitFor(t, "retry de B", func() bool { return len(queues.For(testOrgB).All()) == 1 })
	waitFor(t, "evento de falha de A", func() bool { return events.For(testOrgA).Stats().Errors == 1 })

	// Then
	items := queues.For(testOrgB).All()
	if len(items) != 1 {
		t.Fatalf("retry items = %d, want 1", len(items))
	}
	if items[0].Sender != (senderRef{PhoneNumberID: testPhoneB, Ref: testRefB}) || items[0].SourceWamid != "wamid.RETRY-B" ||
		items[0].OrganizationID != testOrgB || items[0].Language != "en" {
		t.Fatalf("retry = %+v, want remetente, Organization, idioma e wamid de B", items[0])
	}
	if n := len(queues.For(testOrgA).All()); n != 0 {
		t.Fatalf("o wamid de B não pode virar retry em A (fila de A = %d)", n)
	}
}

func TestGivenPanelResolver_WhenResolving_ThenSendsKeyAndRefInBodyOnly(t *testing.T) {
	// Given
	var gotKey, gotQuery string
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-Api-Key")
		gotQuery = r.URL.RawQuery
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"phone_number_id":"` + testPhoneA + `","waba_id":"` + testWabaA + `","access_token":"` + testTokenA + `"}`))
	}))
	defer srv.Close()
	resolver, err := newPanelResolver(srv.URL+"/api/internal/whatsapp/sender", "chave-do-resolver", false)
	if err != nil {
		t.Fatalf("newPanelResolver: %v", err)
	}

	// When
	id, err := resolver.Resolve(context.Background(), senderRef{PhoneNumberID: testPhoneA, Ref: testRefA})

	// Then
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if id.AccessToken != testTokenA || id.WabaID != testWabaA || id.Ref != testRefA {
		t.Fatalf("id = %v", id)
	}
	if gotKey != "chave-do-resolver" || gotQuery != "" || gotBody["ref"] != testRefA || len(gotBody) != 1 {
		t.Fatalf("key=%q query=%q body=%v", gotKey, gotQuery, gotBody)
	}
}

func TestGivenPanelRejects_WhenResolving_ThenErrorCarriesOnlyStatusAndCode(t *testing.T) {
	// Given
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"detalhe interno ` + testTokenA + `","codigo":"INTEGRATION_NOT_CONNECTED"}`))
	}))
	defer srv.Close()
	resolver, _ := newPanelResolver(srv.URL, "k", false)

	// When
	_, err := resolver.Resolve(context.Background(), senderRef{PhoneNumberID: testPhoneA, Ref: testRefA})

	// Then
	if !errors.Is(err, ErrSenderUnresolved) || !strings.Contains(err.Error(), "409 (INTEGRATION_NOT_CONNECTED)") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), testTokenA) {
		t.Fatalf("erro carregou o corpo do painel: %v", err)
	}
}

func TestGivenPanelAnswersOtherNumber_WhenResolving_ThenMismatch(t *testing.T) {
	// Given
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"phone_number_id":"` + testPhoneB + `","access_token":"` + testTokenB + `"}`))
	}))
	defer srv.Close()
	resolver, _ := newPanelResolver(srv.URL, "k", false)

	// When
	_, err := resolver.Resolve(context.Background(), senderRef{PhoneNumberID: testPhoneA, Ref: testRefA})

	// Then
	if !errors.Is(err, ErrSenderMismatch) {
		t.Fatalf("err = %v, want mismatch", err)
	}
}

func TestGivenPlainHTTPInProduction_WhenConfiguringResolver_ThenRejects(t *testing.T) {
	// When
	_, err := newPanelResolver("http://painel.interno/api/internal/whatsapp/sender", "k", true)

	// Then
	if err == nil {
		t.Fatalf("http em produção deveria ser recusado")
	}
}

func TestGivenCredentialInResolverURL_WhenConfiguring_ThenRejects(t *testing.T) {
	// When
	_, withUser := newPanelResolver("https://user:senha@painel.test/x", "k", false)
	_, withQuery := newPanelResolver("https://painel.test/x?key=k", "k", false)

	// Then
	if withUser == nil || withQuery == nil {
		t.Fatalf("URL com credencial deveria ser recusada: user=%v query=%v", withUser, withQuery)
	}
}

func TestGivenNoResolverConfig_WhenConfiguring_ThenDisabled(t *testing.T) {
	// When
	r, err := newPanelResolver("", "", true)

	// Then
	if !errors.Is(err, ErrResolverNotEnabled) {
		t.Fatalf("err = %v", err)
	}
	if _, rerr := r.Resolve(context.Background(), senderRef{PhoneNumberID: testPhoneA, Ref: testRefA}); !errors.Is(rerr, ErrResolverNotEnabled) {
		t.Fatalf("resolver desligado deveria falhar: %v", rerr)
	}
}

func TestGivenItemQueuedBeforePhase5b_WhenDispatching_ThenFailsWithoutEnvironmentFallback(t *testing.T) {
	// Given: item carregado do banco sem remetente, ambiente com o remetente antigo
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	q := useQueue(t)
	resolver := resolverAB()
	useResolver(t, resolver)
	meta := useMetaTransport(t, http.StatusOK, `{}`)
	q.items = append(q.items, &QueueItem{ID: 1, Type: "template", To: "5548999990000", Template: "pix", Status: "pending", OrganizationID: testOrgA})

	// When
	sent, failed, _ := q.Send(nil)

	// Then
	if sent != 0 || failed != 1 || len(meta.all()) != 0 || resolver.count() != 0 {
		t.Fatalf("sent=%d failed=%d calls=%d resolves=%d — item sem remetente não sai", sent, failed, len(meta.all()), resolver.count())
	}
	if q.All()[0].ErrorMsg != ErrItemWithoutSender.Error() {
		t.Fatalf("erro = %q", q.All()[0].ErrorMsg)
	}
}

func TestGivenExplicitLanguage_WhenDispatchingTemplate_ThenItIsKeptAndOnlyMissingDefaultsToPtBR(t *testing.T) {
	// Given (WG-25): antes, "en" era trocado por pt_BR
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	useQueue(t)
	useResolver(t, resolverAB())
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.L"}]}`)
	q := queues.For(testOrgA)
	for _, lang := range []string{"en", "es_AR", ""} {
		body := `{"type":"template","to":"55489` + lang + `0","template":"t` + lang + `","language":"` + lang + `"}`
		if rec := callRoute(handleQueueAdd, false, http.MethodPost, "/queue/add", body, withAPIKey(headersA())); rec.Code != http.StatusOK {
			t.Fatalf("add %q = %d", lang, rec.Code)
		}
	}

	// When
	if _, failed, err := q.Send(nil); failed != 0 || err != nil {
		t.Fatalf("failed=%d err=%v", failed, err)
	}

	// Then
	got := []string{}
	for _, c := range meta.all() {
		var body struct {
			Template struct {
				Language struct {
					Code string `json:"code"`
				} `json:"language"`
			} `json:"template"`
		}
		_ = json.Unmarshal([]byte(c.Body), &body)
		got = append(got, body.Template.Language.Code)
	}
	if strings.Join(got, ",") != "en,es_AR,pt_BR" {
		t.Fatalf("idiomas enviados = %v", got)
	}
}
