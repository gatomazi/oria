package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// Contexto de tenant (Fase 5c).
//
// Um processo e um Meta App da plataforma atendem várias Organizations (PD-023). O App Secret prova
// que o webhook veio da Meta; QUAL Organization é dona do evento quem diz é o painel, a partir do
// par (WABA = entry.id, número = metadata.phone_number_id). Chamadas internas trazem a referência
// assinada (X-Sender-Ref), que o painel também troca pelo contexto. O Go nunca decide tenant
// sozinho e nunca guarda uma cópia das integrações.
//
// Contrato: testdata/inbound-context-v1.json (cópia idêntica no painel).
var (
	ErrTenantUnknown     = errors.New("tenant context unknown")
	ErrTenantMismatch    = errors.New("tenant context mismatch")
	ErrTenantDenied      = errors.New("tenant context denied")
	ErrTenantUnavailable = errors.New("tenant context unavailable")
)

var (
	organizationIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	integrationIDPattern  = regexp.MustCompile(`^[0-9]{1,19}$`)
	notifyNumberPattern   = regexp.MustCompile(`^[0-9]{10,15}$`)
)

const maxReplyMessage = 1000

// replyConfig é o comportamento da Organization nas respostas automáticas. Vazio desliga.
type replyConfig struct {
	RedirectMessage string
	NotifyNumber    string
}

type tenantContext struct {
	OrganizationID string
	// StoreID e BusinessID vêm do Embedded Signup; vazios em cadastro manual (contrato v1, opcionais).
	StoreID       string
	BusinessID    string
	IntegrationID string
	PhoneNumberID string
	WabaID        string
	SenderRef     string
	Reply         replyConfig
}

func (c tenantContext) reference() senderRef {
	return senderRef{PhoneNumberID: c.PhoneNumberID, Ref: c.SenderRef}
}

func (c tenantContext) validate() error {
	switch {
	case !organizationIDPattern.MatchString(c.OrganizationID):
		return errors.New("organization_id")
	case c.StoreID != "" && !organizationIDPattern.MatchString(c.StoreID):
		return errors.New("store_id")
	case c.BusinessID != "" && !metaIDPattern.MatchString(c.BusinessID):
		return errors.New("business_id")
	case !integrationIDPattern.MatchString(c.IntegrationID):
		return errors.New("integration_id")
	case !metaIDPattern.MatchString(c.PhoneNumberID):
		return errors.New("phone_number_id")
	case !metaIDPattern.MatchString(c.WabaID):
		return errors.New("waba_id")
	case !senderRefPattern.MatchString(c.SenderRef):
		return errors.New("sender_ref")
	case len([]rune(c.Reply.RedirectMessage)) > maxReplyMessage:
		return errors.New("reply.redirect_message")
	case c.Reply.NotifyNumber != "" && !notifyNumberPattern.MatchString(c.Reply.NotifyNumber):
		return errors.New("reply.notify_number")
	}
	return nil
}

// dropWithoutEffect diz se a recusa é definitiva (evento sem dono, divergente, plano sem WhatsApp):
// o evento é descartado sem efeito. O resto (painel fora, limite) é tentado de novo pela Meta.
func dropWithoutEffect(err error) bool {
	return errors.Is(err, ErrTenantUnknown) || errors.Is(err, ErrTenantMismatch) || errors.Is(err, ErrTenantDenied)
}

// tenantResolver é o lado do painel que conhece as Organizations.
type tenantResolver interface {
	InboundContext(ctx context.Context, wabaID, phoneNumberID string) (tenantContext, error)
	RefContext(ctx context.Context, ref senderRef) (tenantContext, error)
}

var panelTenants tenantResolver = disabledResolver{}

func (disabledResolver) InboundContext(context.Context, string, string) (tenantContext, error) {
	return tenantContext{}, fmt.Errorf("%w: %v", ErrTenantUnavailable, ErrResolverNotEnabled)
}

func (disabledResolver) RefContext(context.Context, senderRef) (tenantContext, error) {
	return tenantContext{}, fmt.Errorf("%w: %v", ErrTenantUnavailable, ErrResolverNotEnabled)
}

type contextResponse struct {
	OrganizationID string `json:"organization_id"`
	StoreID        string `json:"store_id"`
	BusinessID     string `json:"business_id"`
	IntegrationID  string `json:"integration_id"`
	PhoneNumberID  string `json:"phone_number_id"`
	WabaID         string `json:"waba_id"`
	SenderRef      string `json:"sender_ref"`
	Reply          struct {
		RedirectMessage string `json:"redirect_message"`
		NotifyNumber    string `json:"notify_number"`
	} `json:"reply"`
}

// contextURL troca o último segmento da URL do resolver (/sender) pelo endpoint de contexto.
func (p panelResolver) contextURL(name string) string {
	base := p.endpoint
	for i := len(base) - 1; i >= 0; i-- {
		if base[i] == '/' {
			return base[:i+1] + name
		}
	}
	return base + "/" + name
}

func (p panelResolver) postContext(ctx context.Context, name string, body map[string]string) (tenantContext, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return tenantContext{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.contextURL(name), bytes.NewReader(payload))
	if err != nil {
		return tenantContext{}, fmt.Errorf("%w: %v", ErrTenantUnavailable, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", p.key)
	resp, err := p.client.Do(req)
	if err != nil {
		return tenantContext{}, fmt.Errorf("%w: %v", ErrTenantUnavailable, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxResolverResponse))

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return tenantContext{}, ErrTenantUnknown
	case http.StatusConflict:
		return tenantContext{}, ErrTenantMismatch
	case http.StatusForbidden:
		return tenantContext{}, ErrTenantDenied
	default:
		return tenantContext{}, fmt.Errorf("%w: painel respondeu %d", ErrTenantUnavailable, resp.StatusCode)
	}

	var decoded contextResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return tenantContext{}, fmt.Errorf("%w: resposta ilegível", ErrTenantUnavailable)
	}
	tc := tenantContext{
		OrganizationID: decoded.OrganizationID,
		StoreID:        decoded.StoreID,
		BusinessID:     decoded.BusinessID,
		IntegrationID:  decoded.IntegrationID,
		PhoneNumberID:  decoded.PhoneNumberID,
		WabaID:         decoded.WabaID,
		SenderRef:      decoded.SenderRef,
		Reply:          replyConfig{RedirectMessage: decoded.Reply.RedirectMessage, NotifyNumber: decoded.Reply.NotifyNumber},
	}
	if err := tc.validate(); err != nil {
		return tenantContext{}, fmt.Errorf("%w: contexto inválido (%v)", ErrTenantUnavailable, err)
	}
	return tc, nil
}

func (p panelResolver) InboundContext(ctx context.Context, wabaID, phoneNumberID string) (tenantContext, error) {
	if !metaIDPattern.MatchString(wabaID) || (phoneNumberID != "" && !metaIDPattern.MatchString(phoneNumberID)) {
		return tenantContext{}, ErrTenantUnknown
	}
	body := map[string]string{"waba_id": wabaID}
	if phoneNumberID != "" {
		body["phone_number_id"] = phoneNumberID
	}
	tc, err := p.postContext(ctx, "inbound-context", body)
	if err != nil {
		return tenantContext{}, err
	}
	// O painel já confere; conferir de novo aqui impede que uma resposta trocada vire efeito.
	if tc.WabaID != wabaID || (phoneNumberID != "" && tc.PhoneNumberID != phoneNumberID) {
		return tenantContext{}, ErrTenantMismatch
	}
	return tc, nil
}

func (p panelResolver) RefContext(ctx context.Context, ref senderRef) (tenantContext, error) {
	if !senderRefPattern.MatchString(ref.Ref) || !metaIDPattern.MatchString(ref.PhoneNumberID) {
		return tenantContext{}, ErrTenantUnknown
	}
	tc, err := p.postContext(ctx, "ref-context", map[string]string{"ref": ref.Ref})
	if err != nil {
		return tenantContext{}, err
	}
	if tc.PhoneNumberID != ref.PhoneNumberID || tc.SenderRef != ref.Ref {
		return tenantContext{}, ErrTenantMismatch
	}
	return tc, nil
}

// tenantCache guarda o contexto resolvido por pouco tempo. O contexto de uma referência ou de um
// par (WABA, número) só muda quando a integração muda; desconexão e troca de número passam a valer
// para a ENTRADA em no máximo tenantCacheTTL (30 s; até a rodada 18 eram 5 min). Envios não
// dependem deste cache: o token é conferido na hora pelo /sender, que recusa integração trocada.
//
// Por que TTL curto e não invalidação explícita: são várias réplicas e o painel não tem canal para
// avisá-las; e o evento da Meta não traz versão da integração para entrar na chave. Com 30 s, o custo
// é no máximo uma consulta ao painel a cada 30 s por (WABA, número) ativo por réplica.
//
// Recusa definitiva fica em cache por menos tempo ainda (evita martelar o painel com um número
// desconhecido, mas um número recém-conectado passa a valer em até 15 s); indisponibilidade não fica.
var (
	tenantCacheTTL     = 30 * time.Second
	tenantNegativeTTL  = 15 * time.Second
	maxTenantCacheSize = 5000
	tenantCacheNow     = time.Now
)

type tenantCacheEntry struct {
	ctx     tenantContext
	err     error
	expires time.Time
}

type tenantContextCache struct {
	mu      sync.Mutex
	entries map[string]tenantCacheEntry
}

var tenantContexts = &tenantContextCache{entries: map[string]tenantCacheEntry{}}

func (c *tenantContextCache) get(key string, load func() (tenantContext, error)) (tenantContext, error) {
	now := tenantCacheNow()
	c.mu.Lock()
	if e, ok := c.entries[key]; ok && now.Before(e.expires) {
		c.mu.Unlock()
		return e.ctx, e.err
	}
	c.mu.Unlock()

	tc, err := load()
	var ttl time.Duration
	switch {
	case err == nil:
		ttl = tenantCacheTTL
	case dropWithoutEffect(err):
		ttl = tenantNegativeTTL
	default:
		return tc, err
	}
	c.mu.Lock()
	if len(c.entries) >= maxTenantCacheSize {
		c.entries = map[string]tenantCacheEntry{}
	}
	c.entries[key] = tenantCacheEntry{ctx: tc, err: err, expires: now.Add(ttl)}
	c.mu.Unlock()
	return tc, err
}

func resolveTimeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

// inboundTenant resolve o dono de um evento da Meta.
func inboundTenant(wabaID, phoneNumberID string) (tenantContext, error) {
	return tenantContexts.get("in|"+wabaID+"|"+phoneNumberID, func() (tenantContext, error) {
		ctx, cancel := resolveTimeout()
		defer cancel()
		return panelTenants.InboundContext(ctx, wabaID, phoneNumberID)
	})
}

// refTenant resolve o dono de uma chamada interna pela referência assinada.
func refTenant(ref senderRef) (tenantContext, error) {
	return tenantContexts.get("ref|"+ref.PhoneNumberID+"|"+ref.Ref, func() (tenantContext, error) {
		ctx, cancel := resolveTimeout()
		defer cancel()
		return panelTenants.RefContext(ctx, ref)
	})
}
