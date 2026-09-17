package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const (
	testPhoneA = "1110000001"
	testWabaA  = "2220000001"
	testTokenA = "EAAG-token-da-org-a-0000000001"
	testRefA   = "v1.eyJvIjoiYSIsImkiOjF9AAAA.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testPhoneB = "1110000002"
	testWabaB  = "2220000002"
	testTokenB = "EAAG-token-da-org-b-0000000002"
	testRefB   = "v1.eyJvIjoiYiIsImkiOjJ9BBBB.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testAPIKey = "chave-interna-de-teste"
)

// metaCall é uma chamada que chegou à "Meta" durante o teste.
type metaCall struct {
	Method string
	URL    string
	Auth   string
	Body   string
}

type metaRecorder struct {
	mu    sync.Mutex
	calls []metaCall
}

func (m *metaRecorder) all() []metaCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]metaCall(nil), m.calls...)
}

// useMetaTransport troca o cliente HTTP de saída por um que registra a chamada e responde com
// status/body dados. Nenhuma chamada sai para a rede.
func useMetaTransport(t *testing.T, status int, body string) *metaRecorder {
	t.Helper()
	rec := &metaRecorder{}
	original := httpClient
	httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var sent string
		if r.Body != nil {
			raw, _ := io.ReadAll(r.Body)
			sent = string(raw)
		}
		rec.mu.Lock()
		rec.calls = append(rec.calls, metaCall{Method: r.Method, URL: r.URL.String(), Auth: r.Header.Get("Authorization"), Body: sent})
		rec.mu.Unlock()
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	t.Cleanup(func() { httpClient = original })
	return rec
}

func senderHeaders(phone, waba, token, ref string) map[string]string {
	h := map[string]string{}
	if phone != "" {
		h[headerSenderPhoneNumberID] = phone
	}
	if waba != "" {
		h[headerSenderWabaID] = waba
	}
	if token != "" {
		h[headerSenderAccessToken] = token
	}
	if ref != "" {
		h[headerSenderRef] = ref
	}
	return h
}

func headersA() map[string]string { return senderHeaders(testPhoneA, testWabaA, testTokenA, testRefA) }
func headersB() map[string]string { return senderHeaders(testPhoneB, testWabaB, testTokenB, testRefB) }

// callRoute passa pela mesma cadeia registrada no main: auth → withSender → handler.
func callRoute(handler http.HandlerFunc, requireWaba bool, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	auth(withSender(requireWaba, handler))(rec, req)
	return rec
}

func withAPIKey(h map[string]string) map[string]string {
	out := map[string]string{"X-Api-Key": testAPIKey}
	for k, v := range h {
		out[k] = v
	}
	return out
}

const textBody = `{"to":"5548999990000","message":"oi"}`

func TestGivenExplicitSender_WhenSendingText_ThenMetaReceivesThatPair(t *testing.T) {
	// Given
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.A"}]}`)

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, withAPIKey(headersA()))

	// Then
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	calls := meta.all()
	if len(calls) != 1 {
		t.Fatalf("meta calls = %d, want 1", len(calls))
	}
	if !strings.Contains(calls[0].URL, "/"+testPhoneA+"/messages") || calls[0].Auth != "Bearer "+testTokenA {
		t.Fatalf("meta recebeu %s com %q — want o par da org A", calls[0].URL, calls[0].Auth)
	}
}

// useLegacySenderEnv põe no ambiente o remetente antigo do serviço — que não pode mais ser usado.
func useLegacySenderEnv(t *testing.T) {
	t.Helper()
	t.Setenv("META_PHONE_NUMBER_ID", "9990000000")
	t.Setenv("META_ACCESS_TOKEN", "EAAG-token-do-ambiente-000000")
	t.Setenv("META_WABA_ID", "9998887776")
}

func TestGivenNoSenderHeaders_WhenSendingText_ThenRejectsWithoutEnvironmentFallback(t *testing.T) {
	// Given: o ambiente ainda tem o remetente antigo
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, withAPIKey(nil))

	// Then
	assertSenderRejected(t, rec, meta, "sem remetente não existe padrão")
	if !strings.Contains(rec.Body.String(), "sender identity missing") {
		t.Fatalf("body = %s, want o motivo", rec.Body.String())
	}
}

func TestGivenNoSenderHeaders_WhenCallingAnySenderRoute_ThenEveryOneRejects(t *testing.T) {
	// Given
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey, AppID: "123456789"})
	meta := useMetaTransport(t, http.StatusOK, `{}`)
	useQueue(t)
	routes := []struct {
		name        string
		handler     http.HandlerFunc
		requireWaba bool
		method      string
		target      string
		body        string
	}{
		{"text", handleSendText, false, http.MethodPost, "/send/text", textBody},
		{"template", handleSendTemplate, false, http.MethodPost, "/send/template", `{"to":"5548999990000","template":"x"}`},
		{"media", handleSendMedia, false, http.MethodPost, "/send/media", `{"to":"5548999990000","type":"image","link":"https://x/y.png"}`},
		{"buttons", handleSendButtons, false, http.MethodPost, "/send/buttons", `{"to":"5548999990000","body":"b","buttons":[{"id":"1","title":"t"}]}`},
		{"list", handleSendList, false, http.MethodPost, "/send/list", `{"to":"5548999990000","body":"b","button_text":"x","sections":[{"title":"s","rows":[{"id":"1","title":"t"}]}]}`},
		{"reaction", handleSendReaction, false, http.MethodPost, "/send/reaction", `{"to":"5548999990000","message_id":"wamid.1","emoji":"👍"}`},
		{"read", handleMarkRead, false, http.MethodPost, "/send/read", `{"message_id":"wamid.1"}`},
		{"media get", handleGetMedia, false, http.MethodGet, "/media/123456", ""},
		{"media upload", handleMediaUpload, false, http.MethodPost, "/media/upload", `{"mimeType":"image/png","dataBase64":"aGVsbG8="}`},
		{"queue add", handleQueueAdd, false, http.MethodPost, "/queue/add", queueTemplateBody},
		{"templates list", handleTemplatesList, true, http.MethodGet, "/templates/list", ""},
		{"templates create", handleTemplatesCreate, true, http.MethodPost, "/templates/create", `{"name":"n","category":"UTILITY","components":[{}]}`},
		{"templates delete", handleTemplatesDelete, true, http.MethodDelete, "/templates/delete?name=n", ""},
	}

	for _, route := range routes {
		// When
		rec := callRoute(route.handler, route.requireWaba, route.method, route.target, route.body, withAPIKey(nil))

		// Then
		assertSenderRejected(t, rec, meta, route.name)
	}
	if len(queues.For(testOrgA).All())+len(queues.For(testOrgB).All()) != 0 {
		t.Fatalf("item enfileirado sem remetente")
	}
}

func assertSenderRejected(t *testing.T, rec *httptest.ResponseRecorder, meta *metaRecorder, motivo string) {
	t.Helper()
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s); body = %s", rec.Code, motivo, rec.Body.String())
	}
	if n := len(meta.all()); n != 0 {
		t.Fatalf("meta foi chamada %d vez(es) — %s", n, motivo)
	}
}

func TestGivenSenderWithoutToken_WhenSendingText_ThenRejectsWithoutMixingEnvironmentToken(t *testing.T) {
	// Given: número de uma origem + token de outra nunca pode virar um envio
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, withAPIKey(senderHeaders(testPhoneA, "", "", testRefA)))

	// Then
	assertSenderRejected(t, rec, meta, "identidade pela metade")
}

func TestGivenSenderWithoutRef_WhenSendingText_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, withAPIKey(senderHeaders(testPhoneA, "", testTokenA, "")))

	// Then
	assertSenderRejected(t, rec, meta, "sem referência assinada")
}

func TestGivenNonNumericPhoneNumberID_WhenSendingText_ThenRejectsBeforeBuildingURL(t *testing.T) {
	// Given: o número entra no caminho da URL da Graph API
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, withAPIKey(senderHeaders("123/../me", "", testTokenA, testRefA)))

	// Then
	assertSenderRejected(t, rec, meta, "phone_number_id malformado")
	if strings.Contains(rec.Body.String(), "123/../me") {
		t.Fatalf("erro ecoou o valor recebido: %s", rec.Body.String())
	}
}

func TestGivenMalformedToken_WhenSendingText_ThenRejectsWithoutEchoingIt(t *testing.T) {
	// Given
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, withAPIKey(senderHeaders(testPhoneA, "", "token com espaço 000000", testRefA)))

	// Then
	assertSenderRejected(t, rec, meta, "token malformado")
	if strings.Contains(rec.Body.String(), "token com espaço") {
		t.Fatalf("erro ecoou o token: %s", rec.Body.String())
	}
}

func TestGivenMalformedRef_WhenSendingText_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, withAPIKey(senderHeaders(testPhoneA, "", testTokenA, "v1.curta.x")))

	// Then
	assertSenderRejected(t, rec, meta, "ref malformada")
}

func TestGivenRepeatedSenderHeader_WhenSendingText_ThenRejects(t *testing.T) {
	// Given: dois valores no mesmo header não escolhem "o primeiro"
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)
	req := httptest.NewRequest(http.MethodPost, "/send/text", strings.NewReader(textBody))
	for k, v := range withAPIKey(headersA()) {
		req.Header.Set(k, v)
	}
	req.Header.Add(headerSenderPhoneNumberID, testPhoneB)
	rec := httptest.NewRecorder()

	// When
	auth(withSender(false, handleSendText))(rec, req)

	// Then
	assertSenderRejected(t, rec, meta, "header repetido")
}

func TestGivenSenderFieldsInBody_WhenSendingText_ThenRejects(t *testing.T) {
	// Given: o remetente só entra por header validado; corpo com credencial é recusado
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	for _, field := range []string{"access_token", "Phone_Number_Id", "waba_id", "sender", "organization_id"} {
		// When
		body := fmt.Sprintf(`{"to":"5548999990000","message":"oi","%s":"x"}`, field)
		rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", body, withAPIKey(headersA()))

		// Then
		assertSenderRejected(t, rec, meta, "campo proibido "+field)
	}
}

func TestGivenValidSenderAndNoAPIKey_WhenSendingText_ThenUnauthorized(t *testing.T) {
	// Given: identidade não autentica
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, headersA())

	// Then
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(meta.all()) != 0 {
		t.Fatalf("meta chamada sem API_KEY")
	}
}

func TestGivenValidSenderAndWrongAPIKey_WhenSendingText_ThenUnauthorized(t *testing.T) {
	// Given
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)
	h := headersA()
	h["X-Api-Key"] = "chave-errada"

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, h)

	// Then
	if rec.Code != http.StatusUnauthorized || len(meta.all()) != 0 {
		t.Fatalf("status = %d, calls = %d — want 401 sem chamada", rec.Code, len(meta.all()))
	}
}

func TestGivenMetaEchoesToken_WhenSendingFails_ThenResponseRedactsIt(t *testing.T) {
	// Given: erro do provider com a credencial dentro
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	useMetaTransport(t, http.StatusBadRequest, `{"error":{"message":"invalid token `+testTokenA+`"}}`)

	// When
	rec := callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, withAPIKey(headersA()))

	// Then
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if strings.Contains(rec.Body.String(), testTokenA) {
		t.Fatalf("resposta vazou o token: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "***") {
		t.Fatalf("resposta = %s, want a marca de redação", rec.Body.String())
	}
}

func TestGivenTransportErrorWithToken_WhenSending_ThenErrorRedactsIt(t *testing.T) {
	// Given: *url.Error e afins podem carregar o que estiver na requisição
	useConfig(t, Config{APIVersion: "v21.0"})
	original := httpClient
	httpClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("proxy refused Bearer %s", testTokenA)
	})}
	t.Cleanup(func() { httpClient = original })
	id := metaIdentity{PhoneNumberID: testPhoneA, AccessToken: testTokenA, Ref: testRefA}

	// When
	_, err := metaPost(id, map[string]any{})

	// Then
	if err == nil || strings.Contains(err.Error(), testTokenA) {
		t.Fatalf("err = %v — want erro sem o token", err)
	}
}

func TestGivenIdentity_WhenFormatted_ThenTokenNeverPrinted(t *testing.T) {
	// Given
	id := metaIdentity{PhoneNumberID: testPhoneA, WabaID: testWabaA, AccessToken: testTokenA, Ref: testRefA}

	// When
	out := fmt.Sprintf("%v %+v %#v %s", id, id, id, id)

	// Then
	if strings.Contains(out, testTokenA) || strings.Contains(out, testRefA) {
		t.Fatalf("formatação vazou credencial: %s", out)
	}
}

func TestGivenSenderWithoutWaba_WhenListingTemplates_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{"data":[]}`)

	// When
	rec := callRoute(handleTemplatesList, true, http.MethodGet, "/templates/list", "", withAPIKey(senderHeaders(testPhoneA, "", testTokenA, testRefA)))

	// Then
	assertSenderRejected(t, rec, meta, "templates sem WABA")
}

func TestGivenExplicitSender_WhenManagingTemplates_ThenUsesSenderWabaAndToken(t *testing.T) {
	// Given: o WABA do ambiente antigo não interfere
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{"data":[]}`)

	// When
	list := callRoute(handleTemplatesList, true, http.MethodGet, "/templates/list", "", withAPIKey(headersB()))
	del := callRoute(handleTemplatesDelete, true, http.MethodDelete, "/templates/delete?name=promo%26hsm_id%3D1", "", withAPIKey(headersB()))

	// Then
	if list.Code != http.StatusOK || del.Code != http.StatusOK {
		t.Fatalf("status list=%d delete=%d", list.Code, del.Code)
	}
	calls := meta.all()
	if len(calls) != 2 {
		t.Fatalf("calls = %d, want 2", len(calls))
	}
	for _, c := range calls {
		if !strings.Contains(c.URL, "/"+testWabaB+"/message_templates") || c.Auth != "Bearer "+testTokenB {
			t.Fatalf("call = %+v, want WABA e token da org B", c)
		}
	}
	if !strings.HasSuffix(calls[1].URL, "?name=promo%26hsm_id%3D1") {
		t.Fatalf("delete url = %s — o nome precisa ir escapado", calls[1].URL)
	}
}

func TestGivenMediaIDWithPath_WhenDownloading_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := callRoute(handleGetMedia, false, http.MethodGet, "/media/me", "", withAPIKey(headersA()))

	// Then
	assertSenderRejected(t, rec, meta, "media_id não numérico")
}
