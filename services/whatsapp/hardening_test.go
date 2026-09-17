package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Rodada 18: cache de contexto curto (§25) e páginas HTML embutidas desativadas (§26).

func useCacheClock(t *testing.T) *time.Time {
	t.Helper()
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	previous := tenantCacheNow
	tenantCacheNow = func() time.Time { return now }
	t.Cleanup(func() { tenantCacheNow = previous })
	return &now
}

func TestGivenCachedInboundContext_WhenIntegrationIsDisconnected_ThenItStopsRoutingWithinThirtySeconds(t *testing.T) {
	// Given
	tenants := useTenants(t, tenantsAB())
	now := useCacheClock(t)
	if _, err := inboundTenant(testWabaA, testPhoneA); err != nil {
		t.Fatalf("contexto inicial: %v", err)
	}

	// When: o painel desconecta A
	tenants.mu.Lock()
	tenants.contexts = []tenantContext{tenantB()}
	tenants.mu.Unlock()
	*now = now.Add(29 * time.Second)
	stale, staleErr := inboundTenant(testWabaA, testPhoneA)
	*now = now.Add(2 * time.Second)
	_, freshErr := inboundTenant(testWabaA, testPhoneA)

	// Then: o limite real é o TTL — até 30 s o contexto antigo ainda vale; depois, não
	if staleErr != nil || stale.OrganizationID != testOrgA {
		t.Fatalf("dentro do TTL = %+v, %v", stale, staleErr)
	}
	if !errors.Is(freshErr, ErrTenantUnknown) {
		t.Fatalf("depois de 31 s = %v, want desconhecido", freshErr)
	}
	if tenantCacheTTL > 30*time.Second {
		t.Fatalf("TTL positivo = %s, want ≤ 30s", tenantCacheTTL)
	}
}

func TestGivenCachedRefusal_WhenNumberIsConnected_ThenItStartsRoutingWithinFifteenSeconds(t *testing.T) {
	// Given: B ainda não conectado
	tenants := useTenants(t, &fakeTenants{contexts: []tenantContext{tenantA()}})
	now := useCacheClock(t)
	if _, err := inboundTenant(testWabaB, testPhoneB); !errors.Is(err, ErrTenantUnknown) {
		t.Fatalf("antes de conectar = %v", err)
	}

	// When
	tenants.mu.Lock()
	tenants.contexts = append(tenants.contexts, tenantB())
	tenants.mu.Unlock()
	*now = now.Add(16 * time.Second)
	tc, err := inboundTenant(testWabaB, testPhoneB)

	// Then
	if err != nil || tc.OrganizationID != testOrgB {
		t.Fatalf("depois de 16 s = %+v, %v", tc, err)
	}
}

func TestGivenEventsOfAAndB_WhenOpeningTheEmbeddedPages_ThenTheyAreGoneAndShowNoTenantData(t *testing.T) {
	// Given
	useTenants(t, tenantsAB())
	useConfig(t, Config{APIKey: testAPIKey})
	events.Push(Event{Time: time.Now(), Kind: KindReceived, Phone: "5548000000A1", Name: "Cliente de A", OrganizationID: testOrgA})
	events.Push(Event{Time: time.Now(), Kind: KindReceived, Phone: "5548000000B1", Name: "Cliente de B", OrganizationID: testOrgB})
	problemStores.For(testOrgB).Upsert(&ProblemOrder{Numero: "INK-B", Loja: "Loja B", Telefone: "5548000000B2"})
	mux := newMux()

	for _, path := range []string{"/dashboard", "/problems", "/automaticos"} {
		// When
		withKey := httptest.NewRequest(http.MethodGet, path, nil)
		withKey.Header.Set("X-Api-Key", testAPIKey)
		rec := serve(mux, withKey)
		anonymous := serve(mux, httptest.NewRequest(http.MethodGet, path, nil))

		// Then
		if rec.Code != http.StatusGone || rec.Body.String() != disabledPageMessage ||
			!strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
			t.Fatalf("%s = %d %q", path, rec.Code, rec.Body.String())
		}
		for _, leak := range []string{"5548000000A1", "5548000000B1", "5548000000B2", "Cliente", "INK-B", "<html", "fetch("} {
			if strings.Contains(rec.Body.String(), leak) {
				t.Fatalf("%s mostra %q", path, leak)
			}
		}
		if anonymous.Code != http.StatusUnauthorized {
			t.Fatalf("%s sem chave = %d", path, anonymous.Code)
		}
	}

	// And: os dados continuam só com contexto, e cada contexto só vê a própria Organization
	if rec := serve(mux, withAPIKeyRequest("/dashboard/events", nil)); rec.Code != http.StatusBadRequest {
		t.Fatalf("/dashboard/events sem contexto = %d", rec.Code)
	}
	recA := serve(mux, withAPIKeyRequest("/dashboard/events", refHeaders(testPhoneA, testRefA)))
	if recA.Code != http.StatusOK || !strings.Contains(recA.Body.String(), "5548000000A1") || strings.Contains(recA.Body.String(), "5548000000B1") {
		t.Fatalf("eventos de A = %d %s", recA.Code, recA.Body.String())
	}
}

func withAPIKeyRequest(path string, headers map[string]string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range withAPIKey(headers) {
		req.Header.Set(k, v)
	}
	return req
}
