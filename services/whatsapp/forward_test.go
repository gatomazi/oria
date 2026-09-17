package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Repasse ao painel sem segredo na query string (rodada 18, §22).

const testForwardSecret = "segredo-de-repasse-de-teste-0000000000001"

type forwardContract struct {
	Request struct {
		Method string `json:"method"`
		Path   string `json:"path"`
	} `json:"request"`
	Auth struct {
		TimestampHeader      string   `json:"timestamp_header"`
		SignatureHeader      string   `json:"signature_header"`
		SignatureScheme      string   `json:"signature_scheme"`
		PanelEnv             string   `json:"panel_env"`
		ServiceEnv           string   `json:"service_env"`
		MinSecretLength      int      `json:"min_secret_length"`
		MaxClockSkewSeconds  int      `json:"max_clock_skew_seconds"`
		ForbiddenQueryParams []string `json:"forbidden_query_params"`
	} `json:"auth"`
	TestVector struct {
		Secret    string `json:"secret"`
		Timestamp string `json:"timestamp"`
		Body      string `json:"body"`
		Signature string `json:"signature"`
	} `json:"test_vector"`
}

func loadForwardContract(t *testing.T) forwardContract {
	t.Helper()
	raw, err := os.ReadFile("testdata/forward-auth-v1.json")
	if err != nil {
		t.Fatalf("contrato: %v", err)
	}
	var c forwardContract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatalf("contrato: %v", err)
	}
	return c
}

// verifyForward é a conferência do lado do painel, reescrita aqui a partir do contrato.
func verifyForward(secret string, r *http.Request, body []byte) bool {
	ts := r.Header.Get(forwardTimestampHeader)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	want := forwardSignatureScheme + hex.EncodeToString(mac.Sum(nil))
	return ts != "" && hmac.Equal([]byte(r.Header.Get(forwardSignatureHeader)), []byte(want))
}

type forwardCapture struct {
	mu       sync.Mutex
	requests []capturedForward
}

type capturedForward struct {
	rawURL  string
	query   string
	headers http.Header
	body    []byte
	valid   bool
}

func (c *forwardCapture) all() []capturedForward {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]capturedForward(nil), c.requests...)
}

func useForwardServer(t *testing.T, status int) (*httptest.Server, *forwardCapture) {
	t.Helper()
	capture := &forwardCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		capture.mu.Lock()
		capture.requests = append(capture.requests, capturedForward{rawURL: r.URL.String(), query: r.URL.RawQuery,
			headers: r.Header.Clone(), body: body, valid: verifyForward(testForwardSecret, r, body)})
		capture.mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	var mu sync.Mutex
	writer := writerFunc(func(p []byte) (int, error) { mu.Lock(); defer mu.Unlock(); return buf.Write(p) })
	previous := log.Writer()
	log.SetOutput(writer)
	t.Cleanup(func() { log.SetOutput(previous) })
	return &buf
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func TestGivenForwardContract_WhenSigningTheTestVector_ThenSignatureAndHeadersMatch(t *testing.T) {
	// Given
	c := loadForwardContract(t)

	// When
	got := signForward(c.TestVector.Secret, c.TestVector.Timestamp, []byte(c.TestVector.Body))

	// Then
	if got != c.TestVector.Signature {
		t.Fatalf("assinatura = %s, want %s", got, c.TestVector.Signature)
	}
	if c.Auth.TimestampHeader != forwardTimestampHeader || c.Auth.SignatureHeader != forwardSignatureHeader ||
		c.Auth.SignatureScheme != forwardSignatureScheme || c.Auth.MinSecretLength != minForwardSecretLen ||
		c.Auth.ServiceEnv != "WEBHOOK_FORWARD_SECRET" {
		t.Fatalf("contrato divergente do código: %+v", c.Auth)
	}
	if len(c.Auth.ForbiddenQueryParams) != 1 || c.Auth.ForbiddenQueryParams[0] != "secret" {
		t.Fatalf("forbidden_query_params = %v", c.Auth.ForbiddenQueryParams)
	}
}

func TestGivenForwardURLWithSecretInQuery_WhenValidating_ThenRejectedWithoutEchoingIt(t *testing.T) {
	// Given: o formato antigo e outras formas de levar credencial na URL
	const leaked = "valor-antigo-do-segredo-na-url"
	for _, raw := range []string{
		"https://painel.exemplo/api/webhooks/whatsapp?secret=" + leaked,
		"https://painel.exemplo/api/webhooks/whatsapp?x=" + leaked,
		"https://user:" + leaked + "@painel.exemplo/api/webhooks/whatsapp",
		"https://painel.exemplo/api/webhooks/whatsapp#" + leaked,
	} {
		// When
		_, err := validateForwardConfig(raw, testForwardSecret, true)

		// Then
		if err == nil {
			t.Fatalf("URL com credencial aceita")
		}
		if strings.Contains(err.Error(), leaked) {
			t.Fatalf("erro repete o segredo: %v", err)
		}
	}
}

func TestGivenForwardConfig_WhenValidating_ThenSecretAndHttpsAreRequired(t *testing.T) {
	// Given
	const panel = "https://painel.exemplo/api/webhooks/whatsapp"

	// When / Then
	if _, err := validateForwardConfig("", "", true); err != ErrForwardDisabled {
		t.Fatalf("sem URL = %v, want desligado", err)
	}
	if _, err := validateForwardConfig(panel, "", true); err == nil {
		t.Fatalf("URL sem segredo aceita")
	}
	if _, err := validateForwardConfig(panel, "curto", false); err == nil {
		t.Fatalf("segredo curto aceito")
	}
	if _, err := validateForwardConfig("http://painel.exemplo/x", testForwardSecret, true); err == nil {
		t.Fatalf("http aceito em produção")
	}
	if got, err := validateForwardConfig("http://127.0.0.1:3000/api/webhooks/whatsapp", testForwardSecret, false); err != nil || got == "" {
		t.Fatalf("http local fora de produção = %q, %v", got, err)
	}
	if got, err := validateForwardConfig(panel, testForwardSecret, true); err != nil || got != panel {
		t.Fatalf("configuração válida = %q, %v", got, err)
	}
}

func TestGivenForwardConfigured_WhenForwarding_ThenSecretOnlyTravelsAsSignature(t *testing.T) {
	// Given
	srv, capture := useForwardServer(t, http.StatusOK)
	useConfig(t, Config{ForwardURL: srv.URL + "/api/webhooks/whatsapp", ForwardSecret: testForwardSecret})
	body := []byte(statusPayload(testWabaA, testPhoneA, "wamid.FWD", "delivered"))

	// When
	err := sendForward(body)

	// Then
	if err != nil {
		t.Fatalf("repasse: %v", err)
	}
	got := capture.all()
	if len(got) != 1 {
		t.Fatalf("repasses = %d", len(got))
	}
	req := got[0]
	if req.query != "" || strings.Contains(req.rawURL, "secret") {
		t.Fatalf("URL do repasse carrega query: %s", req.rawURL)
	}
	if !req.valid || !bytes.Equal(req.body, body) {
		t.Fatalf("assinatura inválida ou corpo alterado: valid=%v", req.valid)
	}
	ts, err := strconv.ParseInt(req.headers.Get(forwardTimestampHeader), 10, 64)
	if err != nil || time.Since(time.Unix(ts, 0)).Abs() > time.Minute {
		t.Fatalf("timestamp = %q", req.headers.Get(forwardTimestampHeader))
	}
	for name, values := range req.headers {
		for _, v := range values {
			if strings.Contains(v, testForwardSecret) {
				t.Fatalf("segredo em claro no header %s", name)
			}
		}
	}
	if strings.Contains(req.rawURL+string(req.body), testForwardSecret) {
		t.Fatalf("segredo em claro na URL ou no corpo")
	}
}

func TestGivenForwardWithoutSecret_WhenForwarding_ThenNothingIsSent(t *testing.T) {
	// Given: URL configurada à mão, segredo ausente
	srv, capture := useForwardServer(t, http.StatusOK)
	useConfig(t, Config{ForwardURL: srv.URL})

	// When
	err := sendForward([]byte(`{}`))

	// Then
	if err == nil || len(capture.all()) != 0 {
		t.Fatalf("err=%v repasses=%d — sem segredo o repasse falha fechado", err, len(capture.all()))
	}
}

func TestGivenPanelRejectsOrIsDown_WhenForwarding_ThenErrorAndLogCarryNoSecret(t *testing.T) {
	// Given
	logs := captureLog(t)
	rejecting, _ := useForwardServer(t, http.StatusUnauthorized)
	down := httptest.NewServer(http.NotFoundHandler())
	downURL := down.URL
	down.Close()

	for _, target := range []string{rejecting.URL, downURL} {
		useConfig(t, Config{ForwardURL: target, ForwardSecret: testForwardSecret})

		// When
		err := sendForward([]byte(`{}`))
		processRouted("whatsapp_business_account", []routedChange{{tenant: tenantA(), wabaID: testWabaA, raw: json.RawMessage(`{}`)}})

		// Then
		if err == nil {
			t.Fatalf("%s: repasse recusado virou sucesso", target)
		}
		if strings.Contains(err.Error(), testForwardSecret) {
			t.Fatalf("erro carrega o segredo: %v", err)
		}
	}
	if strings.Contains(logs.String(), testForwardSecret) || strings.Contains(logs.String(), "secret=") {
		t.Fatalf("log carrega o segredo:\n%s", logs.String())
	}
	if !strings.Contains(logs.String(), "[webhook] forward: repasse") {
		t.Fatalf("falha do repasse não apareceu no log:\n%s", logs.String())
	}
}

func TestGivenProductionWithSecretInForwardURL_WhenBooting_ThenProcessAbortsWithoutPrintingIt(t *testing.T) {
	if isBootChild() {
		configureForward()
		return
	}

	// Given / When
	const leaked = "valor-antigo-do-segredo-na-url-boot"
	out, err := runBootChild(t, "TestGivenProductionWithSecretInForwardURL_WhenBooting_ThenProcessAbortsWithoutPrintingIt",
		"APP_ENV=production", "WEBHOOK_FORWARD_URL=https://painel.exemplo/api/webhooks/whatsapp?secret="+leaked,
		"WEBHOOK_FORWARD_SECRET="+testForwardSecret)

	// Then
	assertAborted(t, out, err, "WEBHOOK_FORWARD_URL inválida", "segredo na query string não pode subir em produção")
	if strings.Contains(out, leaked) || strings.Contains(out, testForwardSecret) {
		t.Fatalf("saída do boot carrega segredo:\n%s", out)
	}
}

func TestGivenProductionWithForwardURLAndNoSecret_WhenBooting_ThenProcessAborts(t *testing.T) {
	if isBootChild() {
		configureForward()
		return
	}

	// Given / When
	out, err := runBootChild(t, "TestGivenProductionWithForwardURLAndNoSecret_WhenBooting_ThenProcessAborts",
		"APP_ENV=production", "WEBHOOK_FORWARD_URL=https://painel.exemplo/api/webhooks/whatsapp", "WEBHOOK_FORWARD_SECRET=")

	// Then
	assertAborted(t, out, err, "WEBHOOK_FORWARD_SECRET ausente", "repasse sem autenticação não sobe em produção")
}
