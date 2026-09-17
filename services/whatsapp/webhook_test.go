package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Payload real o bastante para produzir efeito colateral se chegar a ser processado: uma mensagem
// recebida vira evento no dashboard (evStore). É o que torna o teste capaz de provar que um
// webhook recusado não processa nada.
const inboundMessagePayload = `{"object":"whatsapp_business_account","entry":[{"id":"` + testWabaA + `","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"` + testPhoneA + `"},"contacts":[{"wa_id":"5548999","profile":{"name":"Cliente"}}],"messages":[{"from":"5548999","id":"wamid.TESTE","type":"text","text":{"body":"oi"}}]}}]}]}`

func signPayload(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// useConfig troca a config global do processo pela do teste e restaura ao final.
func useConfig(t *testing.T, c Config) {
	t.Helper()
	previous := cfg
	cfg = c
	t.Cleanup(func() { cfg = previous })
}

func postWebhook(t *testing.T, signature, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
	if signature != "" {
		req.Header.Set("X-Hub-Signature-256", signature)
	}
	rec := httptest.NewRecorder()
	handleWebhook(rec, req)
	// Registrado por último, roda primeiro: nenhum processamento sobrevive ao teste.
	t.Cleanup(webhookWork.Wait)
	return rec
}

// assertNoInboundProcessing falha se o payload tiver sido processado. processWebhook roda em
// goroutine, então dá uma janela para o efeito aparecer antes de concluir que ele não aconteceu.
func assertNoInboundProcessing(t *testing.T, before DashStats) {
	t.Helper()
	deadline := time.Now().Add(150 * time.Millisecond)
	for time.Now().Before(deadline) {
		if events.For(testOrgA).Stats().Received != before.Received {
			t.Fatalf("webhook recusado não pode gerar evento no dashboard")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestGivenNoAppSecret_WhenWebhookPosted_ThenRejectsAndProcessesNothing(t *testing.T) {
	// Given: é o deploy sem META_APP_SECRET — antes disso, qualquer POST era aceito
	useConfig(t, Config{})
	before := events.For(testOrgA).Stats()

	// When
	rec := postWebhook(t, "", inboundMessagePayload)

	// Then
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d — sem app secret o webhook tem de falhar FECHADO", rec.Code, http.StatusForbidden)
	}
	assertNoInboundProcessing(t, before)
}

func TestGivenAppSecretAndWrongSignature_WhenWebhookPosted_ThenRejectsAndProcessesNothing(t *testing.T) {
	// Given
	useConfig(t, Config{AppSecret: "segredo-certo"})
	before := events.For(testOrgA).Stats()

	// When: assinatura feita com outro segredo (payload forjado)
	rec := postWebhook(t, signPayload("segredo-errado", inboundMessagePayload), inboundMessagePayload)

	// Then
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	assertNoInboundProcessing(t, before)
}

func TestGivenAppSecretAndNoSignatureHeader_WhenWebhookPosted_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{AppSecret: "segredo-certo"})
	before := events.For(testOrgA).Stats()

	// When
	rec := postWebhook(t, "", inboundMessagePayload)

	// Then
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	assertNoInboundProcessing(t, before)
}

func TestGivenAppSecretAndTamperedBody_WhenWebhookPosted_ThenRejects(t *testing.T) {
	// Given: assinatura válida para OUTRO corpo — o HMAC tem de ser sobre os bytes recebidos
	useConfig(t, Config{AppSecret: "segredo-certo"})
	signature := signPayload("segredo-certo", inboundMessagePayload)
	before := events.For(testOrgA).Stats()

	// When
	rec := postWebhook(t, signature, strings.Replace(inboundMessagePayload, "5548999", "5511888", -1))

	// Then
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	assertNoInboundProcessing(t, before)
}

func TestGivenValidSignature_WhenWebhookPosted_ThenAcceptsAndProcesses(t *testing.T) {
	// Given: status de entrega de A (sem envio de saída). O repasse aponta para um servidor de
	// teste, que é também o sinal de que o processamento (em goroutine) terminou.
	useTenants(t, tenantsAB())
	forwarded := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		forwarded <- struct{}{}
	}))
	defer srv.Close()
	useConfig(t, Config{AppSecret: "segredo-certo", ForwardURL: srv.URL, ForwardSecret: testForwardSecret})
	body := statusPayload(testWabaA, testPhoneA, "wamid.OK", "delivered")

	// When
	rec := postWebhook(t, signPayload("segredo-certo", body), body)

	// Then
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d — assinatura válida tem de ser aceita", rec.Code, http.StatusOK)
	}
	select {
	case <-forwarded:
	case <-time.After(2 * time.Second):
		t.Fatalf("payload assinado não chegou a ser processado")
	}
}

func TestGivenWrongVerifyToken_WhenSubscribing_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{VerifyToken: "token-certo"})

	// When
	req := httptest.NewRequest(http.MethodGet, "/webhook?hub.mode=subscribe&hub.verify_token=token-errado&hub.challenge=123", nil)
	rec := httptest.NewRecorder()
	handleWebhook(rec, req)

	// Then
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestGivenNoVerifyTokenConfigured_WhenSubscribing_ThenRejects(t *testing.T) {
	// Given: sem verify token configurado, uma requisição com token vazio não pode ser aceita
	useConfig(t, Config{})

	// When
	req := httptest.NewRequest(http.MethodGet, "/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=123", nil)
	rec := httptest.NewRecorder()
	handleWebhook(rec, req)

	// Then
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d — verify token vazio não pode validar ninguém", rec.Code, http.StatusForbidden)
	}
}

func TestGivenCorrectVerifyToken_WhenSubscribing_ThenReturnsChallenge(t *testing.T) {
	// Given
	useConfig(t, Config{VerifyToken: "token-certo"})

	// When
	req := httptest.NewRequest(http.MethodGet, "/webhook?hub.mode=subscribe&hub.verify_token=token-certo&hub.challenge=desafio", nil)
	rec := httptest.NewRecorder()
	handleWebhook(rec, req)

	// Then
	if rec.Code != http.StatusOK || rec.Body.String() != "desafio" {
		t.Fatalf("status = %d, body = %q — a Meta precisa receber o challenge de volta", rec.Code, rec.Body.String())
	}
}

func statusPayload(waba, phone, wamid, status string) string {
	return `{"object":"whatsapp_business_account","entry":[{"id":"` + waba + `","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"` +
		phone + `"},"statuses":[{"id":"` + wamid + `","status":"` + status + `","recipient_id":"5548999990000"}]}}]}]}`
}
