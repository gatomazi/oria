package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Envio que nasce DENTRO deste serviço — item da fila disparado pelo dashboard, retry de um
// status "failed" — não tem requisição do painel de onde tirar o remetente. O item guarda só a
// referência assinada que veio com a chamada original (X-Sender-Ref) e o número; no despacho,
// o token é pedido de volta ao painel, que continua sendo a autoridade da Organization.
//
// Por que não persistir o token aqui: seria uma segunda cópia do segredo da Organization, fora do
// cofre do painel, que não acompanha rotação nem desconexão. Com a referência, desconectar a
// integração no painel faz o próximo despacho falhar fechado.
//
// Contrato (POST PANEL_SENDER_RESOLVER_URL):
//
//	headers  Content-Type: application/json; X-Api-Key: PANEL_SENDER_RESOLVER_KEY
//	corpo    {"ref": "<X-Sender-Ref>"}
//	200      {"phone_number_id": "...", "waba_id": "...", "access_token": "..."}
//	4xx/5xx  {"error": "...", "codigo": "..."} — o despacho falha, nada de fallback
var (
	ErrSenderUnresolved   = errors.New("sender reference not resolved")
	ErrSenderMismatch     = errors.New("resolved sender does not match the queued sender")
	ErrResolverNotEnabled = errors.New("sender resolver not configured")
	// ErrSenderUnavailable marca a falha passageira (painel fora, 5xx, limite): o efeito que
	// dependia do remetente pode ser tentado de novo. As demais recusas são definitivas.
	ErrSenderUnavailable = errors.New("sender resolver unavailable")
)

// senderRef é o que um envio persistido guarda sobre o remetente. Nunca o token.
type senderRef struct {
	PhoneNumberID string
	Ref           string
}

func (id metaIdentity) reference() senderRef {
	return senderRef{PhoneNumberID: id.PhoneNumberID, Ref: id.Ref}
}

func (s senderRef) empty() bool { return s.Ref == "" }

// senderResolver devolve o remetente completo de uma referência persistida.
type senderResolver interface {
	Resolve(ctx context.Context, ref senderRef) (metaIdentity, error)
}

// panelSender é configurado no main; sem configuração, todo despacho por referência falha.
var panelSender senderResolver = disabledResolver{}

type disabledResolver struct{}

func (disabledResolver) Resolve(context.Context, senderRef) (metaIdentity, error) {
	return metaIdentity{}, ErrResolverNotEnabled
}

type panelResolver struct {
	endpoint string
	key      string
	client   *http.Client
}

const maxResolverResponse = 64 << 10

// newPanelResolver valida a configuração: em produção só https; nunca credencial ou query na URL
// (a URL aparece em erro de transporte).
func newPanelResolver(endpoint, key string, production bool) (senderResolver, error) {
	if endpoint == "" || key == "" {
		return disabledResolver{}, ErrResolverNotEnabled
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("PANEL_SENDER_RESOLVER_URL inválida")
	}
	if u.Scheme != "https" && (production || u.Scheme != "http") {
		return nil, errors.New("PANEL_SENDER_RESOLVER_URL precisa ser https")
	}
	return panelResolver{endpoint: u.String(), key: key, client: &http.Client{Timeout: 10 * time.Second}}, nil
}

func (p panelResolver) Resolve(ctx context.Context, ref senderRef) (metaIdentity, error) {
	if ref.empty() || !senderRefPattern.MatchString(ref.Ref) || !metaIDPattern.MatchString(ref.PhoneNumberID) {
		return metaIdentity{}, fmt.Errorf("%w: referência inválida", ErrSenderUnresolved)
	}
	payload, err := json.Marshal(map[string]string{"ref": ref.Ref})
	if err != nil {
		return metaIdentity{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(payload))
	if err != nil {
		return metaIdentity{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", p.key)

	resp, err := p.client.Do(req)
	if err != nil {
		return metaIdentity{}, fmt.Errorf("%w: %w: %v", ErrSenderUnresolved, ErrSenderUnavailable, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxResolverResponse))

	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
		return metaIdentity{}, fmt.Errorf("%w: %w: painel respondeu %d", ErrSenderUnresolved, ErrSenderUnavailable, resp.StatusCode)
	}

	if resp.StatusCode != http.StatusOK {
		var failure struct {
			Codigo string `json:"codigo"`
		}
		_ = json.Unmarshal(body, &failure)
		return metaIdentity{}, fmt.Errorf("%w: painel respondeu %d (%s)", ErrSenderUnresolved, resp.StatusCode, failure.Codigo)
	}

	var resolved struct {
		PhoneNumberID string `json:"phone_number_id"`
		WabaID        string `json:"waba_id"`
		AccessToken   string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &resolved); err != nil {
		return metaIdentity{}, fmt.Errorf("%w: resposta ilegível", ErrSenderUnresolved)
	}
	id := metaIdentity{PhoneNumberID: resolved.PhoneNumberID, WabaID: resolved.WabaID, AccessToken: resolved.AccessToken, Ref: ref.Ref}
	if err := id.validate(); err != nil {
		return metaIdentity{}, fmt.Errorf("%w: %v", ErrSenderUnresolved, err)
	}
	// O número foi gravado junto do item: se a integração da Organization mudou de número, o item
	// não sai por outro remetente.
	if id.PhoneNumberID != ref.PhoneNumberID {
		return metaIdentity{}, ErrSenderMismatch
	}
	return id, nil
}

// replySender resolve o token da resposta automática pela referência que o painel devolveu no
// contexto do evento — funciona no primeiro evento depois de um restart, sem envio prévio.
func replySender(tc tenantContext) (metaIdentity, error) {
	return senderCache{}.resolve(tc.reference())
}

// senderCache resolve cada referência uma vez por lote de despacho. Vive só durante o lote.
type senderCache map[string]metaIdentity

func (c senderCache) resolve(ref senderRef) (metaIdentity, error) {
	key := ref.PhoneNumberID + "|" + ref.Ref
	if id, ok := c[key]; ok {
		return id, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	id, err := panelSender.Resolve(ctx, ref)
	if err != nil {
		return metaIdentity{}, err
	}
	c[key] = id
	return id, nil
}
