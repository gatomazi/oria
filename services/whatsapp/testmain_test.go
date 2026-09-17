package main

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
)

const (
	testOrgA         = "a1000000-0000-4000-8000-000000000001"
	testOrgB         = "a1000000-0000-4000-8000-000000000002"
	testIntegrationA = "11"
	testIntegrationB = "22"
)

func tenantA() tenantContext {
	return tenantContext{OrganizationID: testOrgA, IntegrationID: testIntegrationA, PhoneNumberID: testPhoneA, WabaID: testWabaA,
		SenderRef: testRefA, Reply: replyConfig{RedirectMessage: "Fale com A", NotifyNumber: "5548900000001"}}
}

func tenantB() tenantContext {
	return tenantContext{OrganizationID: testOrgB, IntegrationID: testIntegrationB, PhoneNumberID: testPhoneB, WabaID: testWabaB,
		SenderRef: testRefB, Reply: replyConfig{RedirectMessage: "Fale com B", NotifyNumber: ""}}
}

// fakeTenants é o painel falso: conhece A e B pela WABA, pelo número e pela referência.
type fakeTenants struct {
	mu       sync.Mutex
	contexts []tenantContext
	err      error
	inbound  int
	refs     int
}

func (f *fakeTenants) InboundContext(_ context.Context, waba, phone string) (tenantContext, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inbound++
	if f.err != nil {
		return tenantContext{}, f.err
	}
	var byWaba *tenantContext
	for i := range f.contexts {
		if f.contexts[i].WabaID == waba {
			byWaba = &f.contexts[i]
		}
	}
	if byWaba == nil {
		return tenantContext{}, ErrTenantUnknown
	}
	if phone == "" {
		return *byWaba, nil
	}
	for _, c := range f.contexts {
		if c.PhoneNumberID == phone {
			if c.OrganizationID != byWaba.OrganizationID {
				return tenantContext{}, ErrTenantMismatch
			}
			return c, nil
		}
	}
	return tenantContext{}, ErrTenantUnknown
}

func (f *fakeTenants) RefContext(_ context.Context, ref senderRef) (tenantContext, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refs++
	if f.err != nil {
		return tenantContext{}, f.err
	}
	for _, c := range f.contexts {
		if c.SenderRef == ref.Ref && c.PhoneNumberID == ref.PhoneNumberID {
			return c, nil
		}
	}
	return tenantContext{}, ErrTenantUnknown
}

func (f *fakeTenants) calls() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.inbound, f.refs
}

func resetTenantState() {
	tenantContexts = &tenantContextCache{entries: map[string]tenantCacheEntry{}}
	events = &eventStoreRegistry{stores: map[string]*EventStore{}}
	queues = &queueRegistry{queues: map[string]*MsgQueue{}}
	problemStores = &problemRegistry{stores: map[string]*ProblemStore{}}
	memoryWebhookKeys.mu.Lock()
	memoryWebhookKeys.seen = map[webhookEventKey]bool{}
	memoryWebhookKeys.order = nil
	memoryWebhookKeys.mu.Unlock()
}

// useTenants instala um painel falso para o teste (e limpa caches e estado em memória).
func useTenants(t *testing.T, f *fakeTenants) *fakeTenants {
	t.Helper()
	original := panelTenants
	panelTenants = f
	resetTenantState()
	t.Cleanup(func() {
		panelTenants = original
		resetTenantState()
	})
	return f
}

func tenantsAB() *fakeTenants {
	return &fakeTenants{contexts: []tenantContext{tenantA(), tenantB()}}
}

// Todo teste parte com o painel falso de A/B; os que precisam de outro cenário trocam com useTenants.
func TestMain(m *testing.M) {
	panelTenants = tenantsAB()
	os.Exit(m.Run())
}

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }
