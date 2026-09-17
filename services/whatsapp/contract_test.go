package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
)

// Contrato painel → serviço (Fase 5b). testdata/sender-contract-v1.json é a MESMA cópia versionada no
// painel (test/fixtures/whatsapp/sender-contract-v1.json); o teste do painel confere que as duas
// são idênticas e que o que ele emite satisfaz a fixture. Aqui: o serviço aceita exatamente isso.
type senderContract struct {
	Version  int                     `json:"version"`
	Auth     struct{ Header string } `json:"auth"`
	Headers  map[string]string       `json:"headers"`
	Patterns struct {
		MetaID      string `json:"meta_id"`
		AccessToken string `json:"access_token"`
		Ref         string `json:"ref"`
	} `json:"patterns"`
	AccessTokenLength struct {
		Min int `json:"min"`
		Max int `json:"max"`
	} `json:"access_token_length"`
	ForbiddenBodyFields []string `json:"forbidden_body_fields"`
	Routes              struct {
		SenderRequired        []string `json:"sender_required"`
		SenderAndWabaRequired []string `json:"sender_and_waba_required"`
		TenantRequired        []string `json:"tenant_required"`
		NoSender              []string `json:"no_sender"`
	} `json:"routes"`
	TenantHeaders []string       `json:"tenant_headers"`
	Errors        map[string]int `json:"errors"`
	Resolver      struct {
		Method         string   `json:"method"`
		RequestFields  []string `json:"request_fields"`
		ResponseFields []string `json:"response_fields"`
		AuthHeader     string   `json:"auth_header"`
	} `json:"resolver"`
	Health struct {
		AllowedFields []string `json:"allowed_fields"`
	} `json:"health"`
	Examples struct {
		Valid   map[string]string `json:"valid"`
		Invalid []struct {
			Name    string            `json:"name"`
			Headers map[string]string `json:"headers"`
		} `json:"invalid"`
	} `json:"examples"`
}

func loadContract(t *testing.T) senderContract {
	t.Helper()
	raw, err := os.ReadFile("testdata/sender-contract-v1.json")
	if err != nil {
		t.Fatalf("read contract: %v", err)
	}
	var c senderContract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatalf("parse contract: %v", err)
	}
	if c.Version != 1 {
		t.Fatalf("contract version = %d", c.Version)
	}
	return c
}

func headerOf(h map[string]string) http.Header {
	out := http.Header{}
	for k, v := range h {
		out.Set(k, v)
	}
	return out
}

func TestGivenContract_WhenComparingWithService_ThenNamesPatternsAndLimitsMatch(t *testing.T) {
	// Given
	c := loadContract(t)

	// Then
	want := map[string]string{
		"phone_number_id": headerSenderPhoneNumberID,
		"waba_id":         headerSenderWabaID,
		"access_token":    headerSenderAccessToken,
		"ref":             headerSenderRef,
	}
	for k, v := range want {
		if c.Headers[k] != v {
			t.Errorf("header %s = %q, serviço usa %q", k, c.Headers[k], v)
		}
	}
	if len(c.Headers) != len(want) {
		t.Errorf("contrato tem %d headers, serviço conhece %d", len(c.Headers), len(want))
	}
	if c.Patterns.MetaID != metaIDPattern.String() || c.Patterns.AccessToken != accessTokenPattern.String() || c.Patterns.Ref != senderRefPattern.String() {
		t.Errorf("padrões divergentes: contrato %+v", c.Patterns)
	}
	if c.AccessTokenLength.Min != minAccessTokenLen || c.AccessTokenLength.Max != maxAccessTokenLen {
		t.Errorf("limites do token divergentes: %+v", c.AccessTokenLength)
	}
	fields := make([]string, 0, len(forbiddenBodyFields))
	for f := range forbiddenBodyFields {
		fields = append(fields, f)
	}
	sort.Strings(fields)
	if strings.Join(fields, ",") != strings.Join(c.ForbiddenBodyFields, ",") {
		t.Errorf("campos proibidos: serviço %v, contrato %v", fields, c.ForbiddenBodyFields)
	}
	if c.Auth.Header != "X-Api-Key" || c.Resolver.AuthHeader != "X-Api-Key" {
		t.Errorf("auth header divergente: %+v / %s", c.Auth, c.Resolver.AuthHeader)
	}
}

func TestGivenContractExamples_WhenParsingHeaders_ThenServiceAgreesOnEveryOne(t *testing.T) {
	// Given
	c := loadContract(t)

	// When / Then
	if _, err := senderFromHeaders(headerOf(c.Examples.Valid)); err != nil {
		t.Fatalf("exemplo válido recusado: %v", err)
	}
	for _, inv := range c.Examples.Invalid {
		if _, err := senderFromHeaders(headerOf(inv.Headers)); err == nil {
			t.Errorf("exemplo inválido aceito: %s", inv.Name)
		}
	}
}

// contractRequest monta a chamada de uma rota do contrato ("MÉTODO /caminho").
func contractRequest(route string, headers map[string]string) *http.Request {
	method, path, _ := strings.Cut(route, " ")
	path = strings.Replace(path, "{media_id}", "123456", 1)
	body := `{}`
	switch path {
	case "/send/text":
		body = textBody
	case "/send/template":
		body = `{"to":"5548999990000","template":"x"}`
	case "/send/media":
		body = `{"to":"5548999990000","type":"image","link":"https://x/y.png"}`
	case "/send/buttons":
		body = `{"to":"5548999990000","body":"b","buttons":[{"id":"1","title":"t"}]}`
	case "/send/list":
		body = `{"to":"5548999990000","body":"b","button_text":"x","sections":[{"title":"s","rows":[{"id":"1","title":"t"}]}]}`
	case "/send/reaction":
		body = `{"to":"5548999990000","message_id":"wamid.1","emoji":"x"}`
	case "/send/read":
		body = `{"message_id":"wamid.1"}`
	case "/media/upload":
		body = `{"mimeType":"image/png","dataBase64":"aGVsbG8=","appId":"123456789"}`
	case "/queue/add":
		body = queueTemplateBody
	case "/queue/send":
		body = `{"all":true}`
	case "/queue/delete":
		body = `{"ids":[999]}`
	case "/problems/add":
		body = `{"numero":"X1","loja":"Loja"}`
	case "/problems/sync":
		body = `{"loja":"Loja","numeros":[]}`
	case "/templates/create":
		body = `{"name":"n","category":"UTILITY","components":[{}]}`
	case "/templates/delete":
		path += "?name=n"
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return req
}

func serve(mux http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestGivenContractRoutes_WhenCalledThroughTheRealMux_ThenSenderRulesHold(t *testing.T) {
	// Given: o roteador de produção, sem rede (Meta falsa) e sem banco
	c := loadContract(t)
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	useQueue(t)
	// O exemplo do contrato é o número/WABA de A com a referência da fixture.
	contractTenant := tenantA()
	contractTenant.SenderRef = c.Examples.Valid[c.Headers["ref"]]
	useTenants(t, &fakeTenants{contexts: []tenantContext{contractTenant, tenantB()}})
	useResolver(t, resolverAB())
	mux := newMux()
	valid := withAPIKey(c.Examples.Valid)
	noWaba := withAPIKey(c.Examples.Valid)
	delete(noWaba, c.Headers["waba_id"])
	mediaClient := mediaUploadClient
	mediaUploadClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"id":"upload:1","h":"handle"}`)), Header: http.Header{}}, nil
	})}
	t.Cleanup(func() { mediaUploadClient = mediaClient })

	for _, route := range append(append([]string{}, c.Routes.SenderRequired...), c.Routes.SenderAndWabaRequired...) {
		// When / Then: sem API_KEY — 401, com ou sem remetente
		if rec := serve(mux, contractRequest(route, c.Examples.Valid)); rec.Code != c.Errors["missing_api_key"] {
			t.Errorf("%s sem API_KEY = %d", route, rec.Code)
		}
		// sem remetente — 400, a Meta não é chamada
		meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.C"}],"url":"https://lookaside.test/x"}`)
		if rec := serve(mux, contractRequest(route, withAPIKey(nil))); rec.Code != c.Errors["missing_sender"] {
			t.Errorf("%s sem remetente = %d", route, rec.Code)
		}
		if n := len(meta.all()); n != 0 {
			t.Errorf("%s chamou a Meta sem remetente", route)
		}
		// remetente do contrato — aceito
		if rec := serve(mux, contractRequest(route, valid)); rec.Code >= 400 {
			t.Errorf("%s com remetente válido = %d (%s)", route, rec.Code, rec.Body.String())
		}
	}
	for _, route := range c.Routes.SenderAndWabaRequired {
		if rec := serve(mux, contractRequest(route, noWaba)); rec.Code != c.Errors["malformed_sender"] {
			t.Errorf("%s sem WABA = %d", route, rec.Code)
		}
	}
	tenantOnly := withAPIKey(map[string]string{})
	for _, h := range c.TenantHeaders {
		tenantOnly[c.Headers[h]] = c.Examples.Valid[c.Headers[h]]
	}
	foreignRef := withAPIKey(map[string]string{c.Headers["phone_number_id"]: testPhoneB, c.Headers["ref"]: c.Examples.Valid[c.Headers["ref"]]})
	for _, route := range c.Routes.TenantRequired {
		if rec := serve(mux, contractRequest(route, nil)); rec.Code != c.Errors["missing_api_key"] {
			t.Errorf("%s sem API_KEY = %d", route, rec.Code)
		}
		if rec := serve(mux, contractRequest(route, withAPIKey(nil))); rec.Code != c.Errors["missing_tenant"] {
			t.Errorf("%s sem contexto = %d (%s)", route, rec.Code, rec.Body.String())
		}
		if rec := serve(mux, contractRequest(route, foreignRef)); rec.Code != c.Errors["tenant_rejected"] {
			t.Errorf("%s com referência de outro número = %d", route, rec.Code)
		}
		if rec := serve(mux, contractRequest(route, tenantOnly)); rec.Code >= 400 {
			t.Errorf("%s com contexto = %d (%s)", route, rec.Code, rec.Body.String())
		}
	}
	for _, route := range c.Routes.NoSender {
		if rec := serve(mux, contractRequest(route, nil)); rec.Code != http.StatusOK {
			t.Errorf("%s sem nada = %d, want 200", route, rec.Code)
		}
	}
	for _, field := range c.ForbiddenBodyFields {
		req := httptest.NewRequest(http.MethodPost, "/send/text", strings.NewReader(`{"to":"5548999990000","message":"oi","`+field+`":"x"}`))
		for k, v := range valid {
			req.Header.Set(k, v)
		}
		if rec := serve(mux, req); rec.Code != c.Errors["forbidden_body_field"] {
			t.Errorf("corpo com %s = %d", field, rec.Code)
		}
	}
}

func TestGivenContract_WhenReadingHealth_ThenOnlyAllowedFieldsAppear(t *testing.T) {
	// Given: ambiente ainda com o remetente antigo
	c := loadContract(t)
	useLegacySenderEnv(t)
	useConfig(t, Config{APIKey: testAPIKey})

	// When: sem credencial nenhuma
	rec := serve(newMux(), httptest.NewRequest(http.MethodGet, "/health", nil))

	// Then
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("health não é JSON: %s", rec.Body.String())
	}
	allowed := map[string]bool{}
	for _, f := range c.Health.AllowedFields {
		allowed[f] = true
	}
	for k := range body {
		if !allowed[k] {
			t.Errorf("/health expõe %q (INV-35)", k)
		}
	}
	for _, v := range []string{"9990000000", "9998887776", "EAAG-token-do-ambiente"} {
		if strings.Contains(rec.Body.String(), v) {
			t.Errorf("/health expõe identidade do ambiente: %s", rec.Body.String())
		}
	}
}

func TestGivenContractResolver_WhenServiceResolves_ThenRequestAndResponseFieldsMatch(t *testing.T) {
	// Given
	c := loadContract(t)
	var gotMethod string
	var gotFields []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		for k := range body {
			gotFields = append(gotFields, k)
		}
		resp := map[string]string{}
		values := map[string]string{"access_token": testTokenA, "phone_number_id": testPhoneA, "waba_id": testWabaA}
		for _, f := range c.Resolver.ResponseFields {
			resp[f] = values[f]
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()
	r, err := newPanelResolver(srv.URL, "k", false)
	if err != nil {
		t.Fatalf("resolver: %v", err)
	}

	// When
	id, err := r.Resolve(t.Context(), senderRef{PhoneNumberID: testPhoneA, Ref: c.Examples.Valid[c.Headers["ref"]]})

	// Then
	if err != nil || id.AccessToken != testTokenA || id.WabaID != testWabaA {
		t.Fatalf("id = %v, err = %v", id, err)
	}
	sort.Strings(gotFields)
	if gotMethod != c.Resolver.Method || strings.Join(gotFields, ",") != strings.Join(c.Resolver.RequestFields, ",") {
		t.Fatalf("pedido ao painel: %s %v, contrato %s %v", gotMethod, gotFields, c.Resolver.Method, c.Resolver.RequestFields)
	}
}

// ── Contrato de contexto (inbound-context / ref-context) ──────────────────────────────────────

type contextContract struct {
	Version   int `json:"version"`
	Endpoints map[string]struct {
		Method         string   `json:"method"`
		Path           string   `json:"path"`
		RequestFields  []string `json:"request_fields"`
		RequiredFields []string `json:"required_fields"`
	} `json:"endpoints"`
	ResponseFields          []string       `json:"response_fields"`
	ReplyFields             []string       `json:"reply_fields"`
	ForbiddenResponseFields []string       `json:"forbidden_response_fields"`
	Statuses                map[string]int `json:"statuses"`
	ServiceBehavior         struct {
		DropWithoutEffect []int `json:"drop_without_effect"`
		RetryLater        []int `json:"retry_later"`
	} `json:"service_behavior"`
	Examples struct {
		InboundRequest map[string]string `json:"inbound_request"`
		RefRequest     map[string]string `json:"ref_request"`
		Response       json.RawMessage   `json:"response"`
	} `json:"examples"`
}

func loadContextContract(t *testing.T) contextContract {
	t.Helper()
	raw, err := os.ReadFile("testdata/inbound-context-v1.json")
	if err != nil {
		t.Fatalf("read context contract: %v", err)
	}
	var c contextContract
	if err := json.Unmarshal(raw, &c); err != nil || c.Version != 1 {
		t.Fatalf("parse context contract: %v (version %d)", err, c.Version)
	}
	return c
}

func TestGivenContextContract_WhenServiceCallsPanel_ThenRequestsAndResponsesMatch(t *testing.T) {
	// Given: um painel que só aceita exatamente o que o contrato diz e responde o exemplo dele
	c := loadContextContract(t)
	var mu sync.Mutex
	seen := map[string][]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		var fields []string
		for k := range body {
			fields = append(fields, k)
		}
		sort.Strings(fields)
		mu.Lock()
		seen[r.Method+" "+r.URL.Path] = fields
		mu.Unlock()
		if r.Header.Get("X-Api-Key") != "k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write(c.Examples.Response)
	}))
	defer srv.Close()
	resolver, err := newPanelResolver(srv.URL+"/api/internal/whatsapp/sender", "k", false)
	if err != nil {
		t.Fatalf("resolver: %v", err)
	}
	tenants := resolver.(tenantResolver)

	// When
	in := c.Examples.InboundRequest
	tc, err := tenants.InboundContext(t.Context(), in["waba_id"], in["phone_number_id"])
	if err != nil {
		t.Fatalf("inbound: %v", err)
	}
	ref := senderRef{PhoneNumberID: tc.PhoneNumberID, Ref: c.Examples.RefRequest["ref"]}
	byRef, err := tenants.RefContext(t.Context(), ref)

	// Then
	if err != nil || byRef.OrganizationID != tc.OrganizationID {
		t.Fatalf("ref: %v %+v", err, byRef)
	}
	for name, ep := range c.Endpoints {
		got := seen[ep.Method+" "+ep.Path]
		if name == "inbound" && strings.Join(got, ",") != strings.Join(ep.RequestFields, ",") {
			t.Errorf("inbound enviou %v, contrato %v", got, ep.RequestFields)
		}
		if name == "ref" && strings.Join(got, ",") != strings.Join(ep.RequestFields, ",") {
			t.Errorf("ref enviou %v, contrato %v", got, ep.RequestFields)
		}
	}
	var example map[string]json.RawMessage
	_ = json.Unmarshal(c.Examples.Response, &example)
	var keys []string
	for k := range example {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != strings.Join(c.ResponseFields, ",") {
		t.Errorf("exemplo de resposta %v, contrato %v", keys, c.ResponseFields)
	}
	if tc.Reply.RedirectMessage == "" || tc.Reply.NotifyNumber == "" || tc.IntegrationID == "" || tc.SenderRef == "" {
		t.Errorf("contexto decodificado incompleto: %+v", tc)
	}
}

func TestGivenContextContractStatuses_WhenPanelAnswers_ThenServiceDropsOrRetriesAsAgreed(t *testing.T) {
	// Given
	c := loadContextContract(t)
	status := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":"x","codigo":"y"}`))
	}))
	defer srv.Close()
	resolver, _ := newPanelResolver(srv.URL+"/x/sender", "k", false)
	tenants := resolver.(tenantResolver)

	// When / Then
	for _, st := range c.ServiceBehavior.DropWithoutEffect {
		status = st
		if _, err := tenants.InboundContext(t.Context(), testWabaA, testPhoneA); !dropWithoutEffect(err) {
			t.Errorf("status %d: err = %v, want descarte sem efeito", st, err)
		}
	}
	for _, st := range c.ServiceBehavior.RetryLater {
		status = st
		if _, err := tenants.InboundContext(t.Context(), testWabaA, testPhoneA); err == nil || dropWithoutEffect(err) {
			t.Errorf("status %d: err = %v, want reentrega", st, err)
		}
	}
	for _, f := range c.ForbiddenResponseFields {
		if strings.Contains(string(c.Examples.Response), `"`+f+`"`) {
			t.Errorf("exemplo de resposta tem campo proibido %s", f)
		}
	}
}
