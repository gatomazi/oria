package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// Transição sem perda de status (rodada 19, §5): WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1 aceita a URL
// legada com `?secret=` e o repasse sai com a query E a assinatura em header.

const legacyQueryValue = "valor-legado-da-query-de-teste"

func TestGivenLegacyQueryFlag_WhenParsing_ThenOnlyOneAndZeroAreAccepted(t *testing.T) {
	// Given
	valid := map[string]bool{"": false, "0": false, "1": true, " 1 ": true}
	invalid := []string{"true", "yes", "on", "2", "false"}

	// When / Then
	for raw, want := range valid {
		got, err := parseForwardLegacyQuery(raw)
		if err != nil || got != want {
			t.Fatalf("flag %q = %v, %v; want %v", raw, got, err, want)
		}
	}
	for _, raw := range invalid {
		if _, err := parseForwardLegacyQuery(raw); err == nil {
			t.Fatalf("flag %q aceita — valor inesperado precisa ser erro, não desligado", raw)
		}
	}
}

func TestGivenLegacyURLWithoutFlag_WhenValidating_ThenRejectedAsBefore(t *testing.T) {
	// Given
	raw := "https://painel.exemplo/api/webhooks/whatsapp?secret=" + legacyQueryValue

	// When
	_, err := validateForwardSettings(raw, testForwardSecret, true, false)

	// Then
	if err == nil {
		t.Fatalf("URL legada aceita sem a flag de transição")
	}
	if strings.Contains(err.Error(), legacyQueryValue) {
		t.Fatalf("erro repete a query: %v", err)
	}
}

func TestGivenLegacyURLWithFlag_WhenValidating_ThenAcceptedUnchanged(t *testing.T) {
	// Given
	raw := "https://painel.exemplo/api/webhooks/whatsapp?secret=" + legacyQueryValue

	// When
	got, err := validateForwardSettings(raw, testForwardSecret, true, true)

	// Then
	if err != nil || got != raw {
		t.Fatalf("URL legada com a flag = %q, %v; want a mesma URL", got, err)
	}
	if !hasForwardQuery(got) {
		t.Fatalf("hasForwardQuery = false para a URL legada")
	}
}

func TestGivenFlagOn_WhenURLCarriesAnythingButOneLegacySecret_ThenRejectedWithoutEchoingIt(t *testing.T) {
	// Given: a flag não abre a URL para qualquer credencial — só `secret=<valor>`, uma vez
	base := "https://painel.exemplo/api/webhooks/whatsapp"
	for _, raw := range []string{
		base + "?secret=" + legacyQueryValue + "&x=1",
		base + "?x=" + legacyQueryValue,
		base + "?secret=" + legacyQueryValue + "&secret=outro",
		base + "?secret=",
		base + "?",
		base + "?secret=" + legacyQueryValue + "#frag",
		"https://user:" + legacyQueryValue + "@painel.exemplo/api/webhooks/whatsapp?secret=" + legacyQueryValue,
		base + "?secret=%zz" + legacyQueryValue,
	} {
		// When
		_, err := validateForwardSettings(raw, testForwardSecret, true, true)

		// Then
		if err == nil {
			t.Fatalf("URL aceita com a flag: %s", strings.ReplaceAll(raw, legacyQueryValue, "***"))
		}
		if strings.Contains(err.Error(), legacyQueryValue) || strings.Contains(err.Error(), testForwardSecret) {
			t.Fatalf("erro repete segredo: %v", err)
		}
	}
}

func TestGivenFlagOn_WhenHttpsOrSecretIsMissing_ThenStillRejected(t *testing.T) {
	// Given
	legacy := "?secret=" + legacyQueryValue

	// When / Then: a flag não afrouxa https nem a assinatura
	if _, err := validateForwardSettings("http://painel.exemplo/x"+legacy, testForwardSecret, true, true); err == nil {
		t.Fatalf("http aceito em produção com a flag")
	}
	if _, err := validateForwardSettings("https://painel.exemplo/x"+legacy, "", true, true); err == nil {
		t.Fatalf("URL legada sem segredo de assinatura aceita")
	}
	if _, err := validateForwardSettings("https://painel.exemplo/x"+legacy, "curto", false, true); err == nil {
		t.Fatalf("segredo curto aceito com a flag")
	}
}

func TestGivenLegacyQueryEqualToSigningSecret_WhenValidating_ThenRejectedWithoutEchoingIt(t *testing.T) {
	// Given: o segredo da assinatura precisa ser um valor novo, nunca o que esteve na URL
	raw := "https://painel.exemplo/api/webhooks/whatsapp?secret=" + testForwardSecret

	// When
	_, err := validateForwardSettings(raw, testForwardSecret, true, true)

	// Then
	if err == nil {
		t.Fatalf("mesmo valor na query e na assinatura aceito")
	}
	if strings.Contains(err.Error(), testForwardSecret) {
		t.Fatalf("erro repete o segredo: %v", err)
	}
}

func TestGivenLegacyTransition_WhenForwarding_ThenQueryAndSignatureTravelWithTheSameBody(t *testing.T) {
	// Given
	srv, capture := useForwardServer(t, http.StatusOK)
	target, err := validateForwardSettings(srv.URL+"/api/webhooks/whatsapp?secret="+legacyQueryValue, testForwardSecret, false, true)
	if err != nil {
		t.Fatalf("configuração: %v", err)
	}
	useConfig(t, Config{ForwardURL: target, ForwardSecret: testForwardSecret})
	body := []byte(statusPayload(testWabaA, testPhoneA, "wamid.FWD-LEGACY", "delivered"))

	// When
	err = sendForward(body)

	// Then
	if err != nil {
		t.Fatalf("repasse: %v", err)
	}
	got := capture.all()
	if len(got) != 1 {
		t.Fatalf("repasses = %d", len(got))
	}
	req := got[0]
	if req.query != "secret="+legacyQueryValue {
		t.Fatalf("query do repasse = %q; o painel antigo só autentica por ela", req.query)
	}
	if !req.valid {
		t.Fatalf("assinatura em header ausente ou inválida — o painel novo só autentica por ela")
	}
	if !bytes.Equal(req.body, body) || req.headers.Get("Content-Type") != "application/json" {
		t.Fatalf("corpo ou content-type diferente do repasse sem transição")
	}
	for name, values := range req.headers {
		for _, v := range values {
			if strings.Contains(v, testForwardSecret) || strings.Contains(v, legacyQueryValue) {
				t.Fatalf("segredo em claro no header %s", name)
			}
		}
	}
}

func TestGivenLegacyTransition_WhenPanelRejectsOrIsDown_ThenErrorAndLogCarryNoSecret(t *testing.T) {
	// Given
	logs := captureLog(t)
	rejecting, _ := useForwardServer(t, http.StatusUnauthorized)
	down := httptest.NewServer(http.NotFoundHandler())
	downURL := down.URL
	down.Close()

	for _, base := range []string{rejecting.URL, downURL} {
		target, err := validateForwardSettings(base+"/api/webhooks/whatsapp?secret="+legacyQueryValue, testForwardSecret, false, true)
		if err != nil {
			t.Fatalf("configuração: %v", err)
		}
		useConfig(t, Config{ForwardURL: target, ForwardSecret: testForwardSecret})

		// When
		err = sendForward([]byte(`{}`))
		processRouted("whatsapp_business_account", []routedChange{{tenant: tenantA(), wabaID: testWabaA, raw: []byte(`{}`)}})

		// Then
		if err == nil {
			t.Fatalf("repasse recusado virou sucesso")
		}
		if strings.Contains(err.Error(), legacyQueryValue) || strings.Contains(err.Error(), "secret=") {
			t.Fatalf("erro carrega a query legada: %v", err)
		}
	}
	out := logs.String()
	if strings.Contains(out, legacyQueryValue) || strings.Contains(out, testForwardSecret) || strings.Contains(out, "secret=") {
		t.Fatalf("log carrega segredo:\n%s", out)
	}
	if !strings.Contains(out, "[webhook] forward: repasse") {
		t.Fatalf("falha do repasse não apareceu no log:\n%s", out)
	}
}

func TestGivenProductionWithLegacyURLAndFlag_WhenBooting_ThenKeepsRunningWithWarningAndNoSecret(t *testing.T) {
	if isBootChild() {
		configureForward()
		if cfg.ForwardURL == "" || !hasForwardQuery(cfg.ForwardURL) {
			t.Fatalf("repasse não configurado com a URL legada")
		}
		return
	}

	// Given / When
	out, err := runBootChild(t, "TestGivenProductionWithLegacyURLAndFlag_WhenBooting_ThenKeepsRunningWithWarningAndNoSecret",
		"APP_ENV=production", "WEBHOOK_FORWARD_URL=https://painel.exemplo/api/webhooks/whatsapp?secret="+legacyQueryValue,
		"WEBHOOK_FORWARD_SECRET="+testForwardSecret, forwardLegacyQueryEnv+"=1")

	// Then
	assertKeptRunning(t, out, err, "transição ligada precisa subir em produção")
	if !strings.Contains(out, "AVISO env=production: "+forwardLegacyQueryEnv+"=1") || !strings.Contains(out, "TRANSIÇÃO") {
		t.Fatalf("boot sem aviso claro da transição:\n%s", out)
	}
	if strings.Contains(out, legacyQueryValue) || strings.Contains(out, testForwardSecret) || strings.Contains(out, "secret=") {
		t.Fatalf("saída do boot carrega segredo:\n%s", out)
	}
}

func TestGivenProductionWithInvalidFlagValue_WhenBooting_ThenProcessAborts(t *testing.T) {
	if isBootChild() {
		configureForward()
		return
	}

	// Given / When: "true" não é "1" — ler como desligado recusaria a URL legada; ler como ligado
	// seria adivinhar. O boot para.
	out, err := runBootChild(t, "TestGivenProductionWithInvalidFlagValue_WhenBooting_ThenProcessAborts",
		"APP_ENV=production", "WEBHOOK_FORWARD_URL=https://painel.exemplo/api/webhooks/whatsapp",
		"WEBHOOK_FORWARD_SECRET="+testForwardSecret, forwardLegacyQueryEnv+"=true")

	// Then
	assertAborted(t, out, err, forwardLegacyQueryEnv+" inválida", "flag de transição com valor inesperado")
}

func TestGivenFlagOnWithoutQuery_WhenBooting_ThenWarnsTheFlagIsUseless(t *testing.T) {
	// Given
	logs := captureLog(t)

	// When
	warnForwardLegacyQuery(true, false)
	warnForwardLegacyQuery(false, true)

	// Then
	out := logs.String()
	if strings.Count(out, "AVISO") != 1 || !strings.Contains(out, "desligar a flag") {
		t.Fatalf("aviso da flag sem query = %q", out)
	}
}

func TestGivenForwardContract_WhenReadingTheTransition_ThenNamesMatchTheCode(t *testing.T) {
	// Given
	raw, err := os.ReadFile("testdata/forward-auth-v1.json")
	if err != nil {
		t.Fatalf("contrato: %v", err)
	}
	var c struct {
		Version    int `json:"version"`
		Transition struct {
			ServiceFlagEnv   string   `json:"service_flag_env"`
			PanelFlagEnv     string   `json:"panel_flag_env"`
			FlagOn           string   `json:"flag_on"`
			FlagOff          []string `json:"flag_off"`
			LegacyQueryParam string   `json:"legacy_query_param"`
			MustDiffer       bool     `json:"query_secret_must_differ_from_signing_secret"`
		} `json:"legacy_query_transition"`
	}

	// When
	err = json.Unmarshal(raw, &c)

	// Then
	if err != nil || c.Version != 1 {
		t.Fatalf("contrato: version=%d err=%v", c.Version, err)
	}
	tr := c.Transition
	if tr.ServiceFlagEnv != forwardLegacyQueryEnv || tr.LegacyQueryParam != forwardLegacyQueryParam ||
		tr.PanelFlagEnv != "WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED" || !tr.MustDiffer {
		t.Fatalf("transição do contrato divergente do código: %+v", tr)
	}
	if on, err := parseForwardLegacyQuery(tr.FlagOn); err != nil || !on {
		t.Fatalf("flag_on %q não liga", tr.FlagOn)
	}
	for _, v := range tr.FlagOff {
		if on, err := parseForwardLegacyQuery(v); err != nil || on {
			t.Fatalf("flag_off %q não desliga", v)
		}
	}
}
