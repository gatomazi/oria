package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// guarded devolve o handler protegido e um ponteiro que registra se o handler interno chegou a
// rodar — um 401 que ainda executa o handler não seria proteção nenhuma.
func guarded(wrap func(http.HandlerFunc) http.HandlerFunc) (http.HandlerFunc, *bool) {
	reached := false
	return wrap(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}), &reached
}

func callGuarded(handler http.HandlerFunc, target string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, strings.NewReader(""))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func assertUnauthorized(t *testing.T, rec *httptest.ResponseRecorder, reached *bool, motivo string) {
	t.Helper()
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusUnauthorized, motivo)
	}
	if *reached {
		t.Fatalf("handler protegido foi executado (%s)", motivo)
	}
}

func TestGivenNoAPIKeyConfigured_WhenCallingProtectedEndpoint_ThenRejects(t *testing.T) {
	// Given: era o fail-open — sem API_KEY, todo endpoint ficava aberto
	useConfig(t, Config{})
	handler, reached := guarded(auth)

	// When
	rec := callGuarded(handler, "/send/text", nil)

	// Then
	assertUnauthorized(t, rec, reached, "sem API_KEY configurada ninguém pode ser autorizado")
}

func TestGivenAPIKeyConfiguredAndNoCredential_WhenCallingProtectedEndpoint_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{APIKey: "chave-certa"})
	handler, reached := guarded(auth)

	// When
	rec := callGuarded(handler, "/send/text", nil)

	// Then
	assertUnauthorized(t, rec, reached, "requisição sem credencial")
}

func TestGivenWrongAPIKey_WhenCallingProtectedEndpoint_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{APIKey: "chave-certa"})
	handler, reached := guarded(auth)

	// When
	rec := callGuarded(handler, "/send/text", map[string]string{"X-Api-Key": "chave-errada"})

	// Then
	assertUnauthorized(t, rec, reached, "chave inválida")
}

func TestGivenAPIKeyInQueryString_WhenCallingProtectedEndpoint_ThenRejects(t *testing.T) {
	// Given: credencial em URL não autentica em lugar nenhum do serviço
	useConfig(t, Config{APIKey: "chave-certa"})
	handler, reached := guarded(auth)

	// When
	rec := callGuarded(handler, "/send/text?key=chave-certa", nil)

	// Then
	assertUnauthorized(t, rec, reached, "chave em query string não autentica")
}

func TestGivenCorrectAPIKeyInHeader_WhenCallingProtectedEndpoint_ThenAllows(t *testing.T) {
	// Given
	useConfig(t, Config{APIKey: "chave-certa"})
	handler, reached := guarded(auth)

	// When
	rec := callGuarded(handler, "/send/text", map[string]string{"X-Api-Key": "chave-certa"})

	// Then
	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("status = %d, reached = %v — chave correta tem de passar", rec.Code, *reached)
	}
}

func TestGivenCorrectAPIKeyAsBearer_WhenCallingProtectedEndpoint_ThenAllows(t *testing.T) {
	// Given: o painel pode mandar Authorization em vez de X-Api-Key
	useConfig(t, Config{APIKey: "chave-certa"})
	handler, reached := guarded(auth)

	// When
	rec := callGuarded(handler, "/send/text", map[string]string{"Authorization": "Bearer chave-certa"})

	// Then
	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("status = %d, reached = %v", rec.Code, *reached)
	}
}

func TestGivenNoAPIKeyConfigured_WhenOpeningDashboard_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{})
	handler, reached := guarded(dashAuth)

	// When
	rec := callGuarded(handler, "/dashboard", nil)

	// Then
	assertUnauthorized(t, rec, reached, "dashboard sem API_KEY configurada")
}

func TestGivenDashboardKeyInQueryString_WhenOpeningDashboard_ThenRejects(t *testing.T) {
	// Given: era o caminho documentado pela mensagem de erro antiga ("adicione ?key=...")
	useConfig(t, Config{APIKey: "chave-certa"})
	handler, reached := guarded(dashAuth)

	// When
	rec := callGuarded(handler, "/dashboard?key=chave-certa", nil)

	// Then
	assertUnauthorized(t, rec, reached, "credencial em query string vaza em log/Referer")
}

func TestGivenWrongDashboardKey_WhenOpeningDashboard_ThenRejects(t *testing.T) {
	// Given
	useConfig(t, Config{APIKey: "chave-certa"})
	handler, reached := guarded(dashAuth)

	// When
	rec := callGuarded(handler, "/dashboard", map[string]string{"X-Api-Key": "chave-errada"})

	// Then
	assertUnauthorized(t, rec, reached, "chave inválida no dashboard")
}

func TestGivenCorrectDashboardKeyInHeader_WhenOpeningDashboard_ThenAllows(t *testing.T) {
	// Given
	useConfig(t, Config{APIKey: "chave-certa"})
	handler, reached := guarded(dashAuth)

	// When
	rec := callGuarded(handler, "/dashboard", map[string]string{"X-Api-Key": "chave-certa"})

	// Then
	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("status = %d, reached = %v", rec.Code, *reached)
	}
}

func TestGivenProductionWithoutAPIKey_WhenValidatingBootEnv_ThenReportsItMissing(t *testing.T) {
	// Given
	lookup := envLookup(map[string]string{
		"RAILWAY_ENVIRONMENT_NAME": "production",
		"META_APP_SECRET":          "segredo",
	})

	// When
	missing := missingProductionEnv(lookup)

	// Then
	if !contains(missing, "API_KEY") {
		t.Fatalf("missing = %v, want API_KEY", missing)
	}
}
