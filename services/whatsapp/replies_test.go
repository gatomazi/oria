package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Entrada multi-tenant (Fase 5c): INV-15, INV-16, INV-29, INV-33, INV-34.

func inboundFrom(waba, phone, from, wamid string) string {
	return `{"object":"whatsapp_business_account","entry":[{"id":"` + waba + `","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"` +
		phone + `"},"contacts":[{"wa_id":"` + from + `","profile":{"name":"Cliente"}}],"messages":[{"from":"` +
		from + `","id":"` + wamid + `","type":"text","text":{"body":"oi"}}]}}]}]}`
}

func useReplyConfig(t *testing.T) {
	t.Helper()
	useLegacySenderEnv(t)
	t.Setenv("REPLY_REDIRECT_MESSAGE", "texto do ambiente que não pode sair")
	t.Setenv("REPLY_NOTIFY_NUMBER", "5548999999999")
	useConfig(t, Config{APIVersion: "v21.0", APIKey: testAPIKey, AppSecret: "segredo-da-plataforma", ReplyCooldown: time.Hour})
	replyMu.Lock()
	lastReplyAt = map[replyKey]time.Time{}
	replyMu.Unlock()
}

type sentTo struct {
	phone, token, to, body string
}

func sentMessages(t *testing.T, meta *metaRecorder) []sentTo {
	t.Helper()
	var out []sentTo
	for _, c := range meta.all() {
		var body struct {
			To   string `json:"to"`
			Text struct {
				Body string `json:"body"`
			} `json:"text"`
		}
		_ = jsonUnmarshal(c.Body, &body)
		phone := ""
		if i := strings.Index(c.URL, "/v21.0/"); i >= 0 {
			phone = strings.SplitN(c.URL[i+len("/v21.0/"):], "/", 2)[0]
		}
		out = append(out, sentTo{phone: phone, token: strings.TrimPrefix(c.Auth, "Bearer "), to: body.To, body: body.Text.Body})
	}
	return out
}

func TestGivenColdStart_WhenFirstEventIsAnInboundMessage_ThenAutoReplyUsesTheOrganizationSender(t *testing.T) {
	// Given: processo recém-subido — nenhum envio prévio do painel, nenhum cache
	useReplyConfig(t)
	tenants := useTenants(t, tenantsAB())
	useResolver(t, resolverAB())
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.R"}]}`)

	// When
	rec := postSigned(t, inboundFrom(testWabaA, testPhoneA, "5548911111111", "wamid.IN-1"))

	// Then
	if rec.Code != http.StatusOK {
		t.Fatalf("webhook = %d", rec.Code)
	}
	waitFor(t, "aviso + auto-resposta de A", func() bool { return len(meta.all()) == 2 })
	for _, m := range sentMessages(t, meta) {
		if m.phone != testPhoneA || m.token != testTokenA {
			t.Fatalf("envio %+v não saiu pelo remetente de A", m)
		}
	}
	msgs := sentMessages(t, meta)
	if msgs[0].to != "5548900000001" || msgs[1].to != "5548911111111" || msgs[1].body != "Fale com A" {
		t.Fatalf("envios = %+v, want aviso para o número de A e a resposta configurada por A", msgs)
	}
	if inbound, _ := tenants.calls(); inbound != 1 {
		t.Fatalf("inbound-context chamado %d vezes, want 1", inbound)
	}
}

func TestGivenSameCustomerWritingToAAndB_WhenAutoReplying_ThenCooldownOfANeverSuppressesB(t *testing.T) {
	// Given
	useReplyConfig(t)
	useTenants(t, tenantsAB())
	useResolver(t, resolverAB())
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.R"}]}`)
	const customer = "5548922222222"

	// When: A duas vezes (a segunda está no cooldown de A), depois B
	postSigned(t, inboundFrom(testWabaA, testPhoneA, customer, "wamid.A1"))
	waitFor(t, "resposta de A", func() bool { return len(meta.all()) == 2 })
	postSigned(t, inboundFrom(testWabaA, testPhoneA, customer, "wamid.A2"))
	waitFor(t, "aviso da 2ª de A", func() bool { return len(meta.all()) == 3 })
	postSigned(t, inboundFrom(testWabaB, testPhoneB, customer, "wamid.B1"))
	waitFor(t, "evento de B", func() bool { return events.For(testOrgB).Stats().Received == 1 })
	time.Sleep(100 * time.Millisecond)

	// Then: A = aviso + resposta + aviso; B (sem número de aviso) = resposta
	var replies []sentTo
	for _, m := range sentMessages(t, meta) {
		if m.to == customer {
			replies = append(replies, m)
		}
	}
	if len(replies) != 2 {
		t.Fatalf("respostas ao cliente = %+v, want uma de A e uma de B", replies)
	}
	if replies[0].phone != testPhoneA || replies[1].phone != testPhoneB || replies[1].body != "Fale com B" || replies[1].token != testTokenB {
		t.Fatalf("respostas = %+v — o cooldown de A não pode suprimir B nem trocar o remetente", replies)
	}
}

func TestGivenUnknownOrMismatchedSender_WhenWebhookArrives_ThenNothingHappens(t *testing.T) {
	// Given
	useReplyConfig(t)
	useTenants(t, tenantsAB())
	resolver := resolverAB()
	useResolver(t, resolver)
	meta := useMetaTransport(t, http.StatusOK, `{}`)
	var forwards atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { forwards.Add(1) }))
	defer srv.Close()
	cfg.ForwardURL, cfg.ForwardSecret = srv.URL, testForwardSecret

	// When: HMAC válido, mas WABA desconhecida; WABA de A com número de B; número desconhecido
	for _, payload := range []string{
		inboundFrom("2229999999", testPhoneA, "5548933333333", "wamid.U1"),
		inboundFrom(testWabaA, testPhoneB, "5548933333333", "wamid.U2"),
		inboundFrom(testWabaA, "1119999999", "5548933333333", "wamid.U3"),
		statusPayload(testWabaB, testPhoneA, "wamid.U4", "failed"),
	} {
		if rec := postSigned(t, payload); rec.Code != http.StatusOK {
			t.Fatalf("webhook = %d, want 200 (descartado sem efeito)", rec.Code)
		}
	}
	time.Sleep(150 * time.Millisecond)

	// Then
	if len(meta.all()) != 0 || resolver.count() != 0 || forwards.Load() != 0 {
		t.Fatalf("meta=%d resolves=%d forwards=%d — assinatura válida não escolhe tenant", len(meta.all()), resolver.count(), forwards.Load())
	}
	for _, org := range []string{testOrgA, testOrgB} {
		if st := events.For(org).Stats(); st != (DashStats{}) {
			t.Fatalf("eventos em %s: %+v", org, st)
		}
	}
}

func TestGivenPanelUnavailable_WhenWebhookArrives_Then503AndNoEffect(t *testing.T) {
	// Given (INV-38): o painel não responde — a Meta precisa reentregar
	useReplyConfig(t)
	useTenants(t, &fakeTenants{err: ErrTenantUnavailable})
	meta := useMetaTransport(t, http.StatusOK, `{}`)

	// When
	rec := postSigned(t, inboundFrom(testWabaA, testPhoneA, "5548944444444", "wamid.D1"))

	// Then
	time.Sleep(100 * time.Millisecond)
	if rec.Code != http.StatusServiceUnavailable || len(meta.all()) != 0 || events.For(testOrgA).Stats() != (DashStats{}) {
		t.Fatalf("status=%d meta=%d events=%+v", rec.Code, len(meta.all()), events.For(testOrgA).Stats())
	}

	// And: depois que o painel volta, a reentrega é processada (não ficou marcada como vista)
	panelTenants = tenantsAB()
	useResolver(t, resolverAB())
	if rec := postSigned(t, inboundFrom(testWabaA, testPhoneA, "5548944444444", "wamid.D1")); rec.Code != http.StatusOK {
		t.Fatalf("reentrega = %d", rec.Code)
	}
	waitFor(t, "evento reentregue", func() bool { return events.For(testOrgA).Stats().Received == 1 })
}

// gatedTenants segura a resolução até o teste conferir que nada aconteceu antes dela (INV-29).
type gatedTenants struct {
	*fakeTenants
	check func()
}

func (g gatedTenants) InboundContext(ctx context.Context, waba, phone string) (tenantContext, error) {
	g.check()
	return g.fakeTenants.InboundContext(ctx, waba, phone)
}

func TestGivenAnyInboundEvent_WhenRouting_ThenNoEffectHappensBeforeTheTenantIsResolved(t *testing.T) {
	// Given: toda superfície de efeito instrumentada
	useReplyConfig(t)
	resolver := resolverAB()
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.X"}]}`)
	var forwards sync.Map
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		forwards.Store(string(raw), true)
	}))
	defer srv.Close()
	cfg.ForwardURL, cfg.ForwardSecret = srv.URL, testForwardSecret
	var violations []string
	gate := gatedTenants{fakeTenants: tenantsAB()}
	gate.check = func() {
		if n := len(meta.all()); n != 0 {
			violations = append(violations, "envio à Meta")
		}
		if resolver.count() != 0 {
			violations = append(violations, "token resolvido")
		}
		for _, org := range []string{testOrgA, testOrgB} {
			if events.For(org).Stats() != (DashStats{}) {
				violations = append(violations, "evento gravado")
			}
			if len(queues.For(org).All()) != 0 {
				violations = append(violations, "fila")
			}
		}
		forwards.Range(func(any, any) bool { violations = append(violations, "repasse"); return false })
	}
	useTenants(t, &fakeTenants{})
	panelTenants = gate
	useResolver(t, resolver)
	registrarParaRetry("wamid.GATE", QueueAddRequest{Type: "template", To: "5548", Template: "pix", OrganizationID: testOrgA,
		Sender: senderRef{PhoneNumberID: testPhoneA, Ref: testRefA}})

	// When: uma change com mensagem e falha de entrega — as duas com efeitos, uma resolução só
	payload := strings.Replace(inboundFrom(testWabaA, testPhoneA, "5548955555555", "wamid.G1"),
		`"messages":[`, `"statuses":[{"id":"wamid.GATE","status":"failed","recipient_id":"5548"}],"messages":[`, 1)
	postSigned(t, payload)
	waitFor(t, "efeitos depois da resolução", func() bool { return len(queues.For(testOrgA).All()) == 1 && len(meta.all()) == 2 })

	// Then
	if len(violations) != 0 {
		t.Fatalf("efeito antes da resolução do tenant: %v", violations)
	}
}

func TestGivenDuplicateDeliveries_WhenWebhookRepeats_ThenEffectsHappenOncePerOrganization(t *testing.T) {
	// Given: o MESMO id de mensagem em A e em B (INV-16/34)
	useReplyConfig(t)
	useTenants(t, tenantsAB())
	useResolver(t, resolverAB())
	meta := useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.R"}]}`)
	payloadA := inboundFrom(testWabaA, testPhoneA, "5548966666666", "wamid.SAME")
	payloadB := inboundFrom(testWabaB, testPhoneB, "5548966666666", "wamid.SAME")

	// When
	for i := 0; i < 3; i++ {
		postSigned(t, payloadA)
		postSigned(t, payloadB)
	}
	waitFor(t, "A e B", func() bool {
		return events.For(testOrgA).Stats().Received == 1 && events.For(testOrgB).Stats().Received == 1
	})
	time.Sleep(150 * time.Millisecond)

	// Then
	if a, b := events.For(testOrgA).Stats().Received, events.For(testOrgB).Stats().Received; a != 1 || b != 1 {
		t.Fatalf("recebidas A=%d B=%d, want 1 cada", a, b)
	}
	if n := len(meta.all()); n != 3 {
		t.Fatalf("envios = %d, want 3 (A: aviso + resposta, B: resposta)", n)
	}
}

func TestGivenPayloadWithTwoOrganizations_WhenRouting_ThenEachChangeStaysInItsOwnScope(t *testing.T) {
	// Given: um payload, duas entries (A e B) — nunca o tenant do primeiro item para os demais
	useReplyConfig(t)
	useTenants(t, tenantsAB())
	useResolver(t, resolverAB())
	useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.R"}]}`)
	var forwarded []string
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		forwarded = append(forwarded, string(raw))
		mu.Unlock()
	}))
	defer srv.Close()
	cfg.ForwardURL, cfg.ForwardSecret = srv.URL, testForwardSecret
	a := inboundFrom(testWabaA, testPhoneA, "5548977777777", "wamid.M-A")
	b := inboundFrom(testWabaB, testPhoneB, "5548988888888", "wamid.M-B")
	unknown := inboundFrom("2229999999", "1119999999", "5548999999999", "wamid.M-X")
	entry := func(p string) string {
		return p[strings.Index(p, `"entry":[`)+len(`"entry":[`) : len(p)-2]
	}
	payload := `{"object":"whatsapp_business_account","entry":[` + entry(a) + `,` + entry(b) + `,` + entry(unknown) + `]}`

	// When
	if rec := postSigned(t, payload); rec.Code != http.StatusOK {
		t.Fatalf("webhook = %d", rec.Code)
	}
	waitFor(t, "repasse", func() bool { mu.Lock(); defer mu.Unlock(); return len(forwarded) == 1 })

	// Then
	if events.For(testOrgA).Recent(1)[0].Phone != "5548977777777" || events.For(testOrgB).Recent(1)[0].Phone != "5548988888888" {
		t.Fatalf("eventos no escopo errado: A=%+v B=%+v", events.For(testOrgA).Recent(0), events.For(testOrgB).Recent(0))
	}
	if strings.Contains(forwarded[0], "wamid.M-X") || !strings.Contains(forwarded[0], "wamid.M-A") || !strings.Contains(forwarded[0], "wamid.M-B") {
		t.Fatalf("repasse = %s, want só as changes com dono", forwarded[0])
	}
}

func TestGivenTenantResolution_WhenRepeated_ThenPanelIsAskedOncePerSenderWithinTTL(t *testing.T) {
	// Given
	useReplyConfig(t)
	tenants := useTenants(t, tenantsAB())
	useResolver(t, resolverAB())
	useMetaTransport(t, http.StatusOK, `{"messages":[{"id":"wamid.R"}]}`)

	// When: dois eventos de A e dois números desconhecidos repetidos
	postSigned(t, inboundFrom(testWabaA, testPhoneA, "5548911000001", "wamid.C1"))
	postSigned(t, inboundFrom(testWabaA, testPhoneA, "5548911000002", "wamid.C2"))
	postSigned(t, inboundFrom("2229999999", "1119999999", "5548911000003", "wamid.C3"))
	postSigned(t, inboundFrom("2229999999", "1119999999", "5548911000004", "wamid.C4"))

	// Then
	if inbound, _ := tenants.calls(); inbound != 2 {
		t.Fatalf("inbound-context chamado %d vezes, want 2 (um por par, recusa também em cache)", inbound)
	}
	if _, err := inboundTenant("2229999999", "1119999999"); !errors.Is(err, ErrTenantUnknown) {
		t.Fatalf("recusa em cache = %v", err)
	}
}
