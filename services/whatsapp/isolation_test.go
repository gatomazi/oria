package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// INV-28 — dois envios de duas Organizations usam dois remetentes, na ordem e em paralelo.
func senderOfCall(c metaCall) string {
	switch {
	case strings.Contains(c.URL, "/"+testPhoneA+"/") && c.Auth == "Bearer "+testTokenA:
		return "A"
	case strings.Contains(c.URL, "/"+testPhoneB+"/") && c.Auth == "Bearer "+testTokenB:
		return "B"
	default:
		return "cruzado"
	}
}

func recipientOfCall(t *testing.T, c metaCall) string {
	t.Helper()
	var body struct {
		To string `json:"to"`
	}
	if err := json.Unmarshal([]byte(c.Body), &body); err != nil {
		t.Fatalf("corpo da Meta ilegível: %s", c.Body)
	}
	return body.To
}

func TestGivenInterleavedSendsFromAAndB_WhenSending_ThenMetaReceivesEachOrganizationPair(t *testing.T) {
	// Given
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.I"}]}`)
	want := map[string]string{}

	// When: A/B/A/B...
	for i := 0; i < 8; i++ {
		org, headers := "A", headersA()
		if i%2 == 1 {
			org, headers = "B", headersB()
		}
		to := fmt.Sprintf("55489990000%02d", i)
		want[to] = org
		body := fmt.Sprintf(`{"to":"%s","template":"pix","language":"pt_BR"}`, to)
		if rec := callRoute(handleSendTemplate, false, http.MethodPost, "/send/template", body, withAPIKey(headers)); rec.Code != http.StatusOK {
			t.Fatalf("envio %d = %d", i, rec.Code)
		}
	}

	// Then
	calls := meta.all()
	if len(calls) != len(want) {
		t.Fatalf("meta calls = %d, want %d", len(calls), len(want))
	}
	for _, c := range calls {
		if got, to := senderOfCall(c), recipientOfCall(t, c); got != want[to] {
			t.Fatalf("envio para %s saiu como %s, want %s", to, got, want[to])
		}
	}
}

func TestGivenConcurrentSendsFromAAndB_WhenSending_ThenNoPairIsCrossed(t *testing.T) {
	// Given
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.C"}]}`)
	const n = 60
	want := make(map[string]string, n)
	for i := 0; i < n; i++ {
		org := "A"
		if i%2 == 1 {
			org = "B"
		}
		want[fmt.Sprintf("5548%09d", i)] = org
	}

	// When
	var wg sync.WaitGroup
	for to, org := range want {
		wg.Add(1)
		go func(to, org string) {
			defer wg.Done()
			headers := headersA()
			if org == "B" {
				headers = headersB()
			}
			body := fmt.Sprintf(`{"to":"%s","message":"oi"}`, to)
			callRoute(handleSendText, false, http.MethodPost, "/send/text", body, withAPIKey(headers))
		}(to, org)
	}
	wg.Wait()

	// Then
	calls := meta.all()
	if len(calls) != n {
		t.Fatalf("meta calls = %d, want %d", len(calls), n)
	}
	count := map[string]int{}
	for _, c := range calls {
		got, to := senderOfCall(c), recipientOfCall(t, c)
		if got != want[to] {
			t.Fatalf("envio para %s saiu como %s, want %s", to, got, want[to])
		}
		count[got]++
	}
	if count["A"] != n/2 || count["B"] != n/2 {
		t.Fatalf("contagem = %v", count)
	}
}

func TestGivenPhoneOfAWithTokenOfB_WhenSending_ThenServiceSendsExactlyThatPairAndNeverMixesItself(t *testing.T) {
	// Given: o serviço não conhece a posse do número (quem confere é o painel, PD-016); o que ele
	// garante é não recombinar: o par recebido é o par enviado, sem trocar nem completar campo.
	useLegacySenderEnv(t)
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey})
	meta := useMetaTransport(t, http.StatusOK, `{}`)
	mixed := senderHeaders(testPhoneA, testWabaA, testTokenB, testRefA)

	// When
	callRoute(handleSendText, false, http.MethodPost, "/send/text", textBody, withAPIKey(mixed))

	// Then
	calls := meta.all()
	if len(calls) != 1 || !strings.Contains(calls[0].URL, "/"+testPhoneA+"/") || calls[0].Auth != "Bearer "+testTokenB {
		t.Fatalf("calls = %+v, want exatamente o par recebido", calls)
	}
}
