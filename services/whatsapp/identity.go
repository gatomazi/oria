package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Remetente explícito (Fase 5b).
//
// O painel é a autoridade da Organization: resolve a integração WhatsApp dela (número, WABA,
// token) e manda esse par junto, em headers internos, na mesma chamada já autenticada por
// API_KEY. Este serviço valida a forma e envia exatamente com o par recebido — nunca completa um
// campo que faltou com outro de outra origem.
//
// Headers, e não corpo nem query string: valem igual para GET/DELETE, não mudam os schemas dos
// corpos existentes e não entram em access log de proxy. A API_KEY continua obrigatória: a
// identidade do remetente não autentica ninguém.
const (
	headerSenderPhoneNumberID = "X-Sender-Phone-Number-Id"
	headerSenderWabaID        = "X-Sender-Waba-Id"
	headerSenderAccessToken   = "X-Sender-Access-Token"
	// Referência assinada pelo painel (organization + integração + número). Não é credencial: é o
	// que este serviço persiste para poder pedir o token de volta ao painel num envio posterior.
	headerSenderRef = "X-Sender-Ref"
)

var (
	// IDs da Meta (phone_number_id, WABA) são numéricos; validar antes de pôr no caminho da URL da
	// Graph API evita que um valor arbitrário mude o endpoint chamado.
	metaIDPattern      = regexp.MustCompile(`^[0-9]{5,32}$`)
	accessTokenPattern = regexp.MustCompile(`^[A-Za-z0-9._|~+/=-]+$`)
	senderRefPattern   = regexp.MustCompile(`^v1\.[A-Za-z0-9_-]{16,1000}\.[A-Za-z0-9_-]{43}$`)
)

// Limites do token fora da regex (o RE2 do Go não repete mais que 1000).
const (
	minAccessTokenLen = 16
	maxAccessTokenLen = 4096
)

var (
	ErrSenderMissing     = errors.New("sender identity missing")
	ErrSenderMalformed   = errors.New("sender identity malformed")
	ErrSenderWabaMissing = errors.New("sender waba id missing")
)

// metaIdentity é o remetente de uma chamada de saída. Número e credencial andam juntos de
// propósito: vêm da mesma integração, resolvida pelo painel.
type metaIdentity struct {
	PhoneNumberID string
	WabaID        string
	AccessToken   string
	Ref           string
}

// String nunca imprime o token: um %v acidental num log não pode vazar a credencial.
func (id metaIdentity) String() string {
	return fmt.Sprintf("sender{phone_number_id=%s waba_id=%s}", id.PhoneNumberID, id.WabaID)
}

func (id metaIdentity) GoString() string { return id.String() }

// validate confere a forma mínima. A mensagem de erro cita o campo, nunca o valor.
func (id metaIdentity) validate() error {
	switch {
	case !metaIDPattern.MatchString(id.PhoneNumberID):
		return fmt.Errorf("%w: phone_number_id", ErrSenderMalformed)
	case len(id.AccessToken) < minAccessTokenLen || len(id.AccessToken) > maxAccessTokenLen ||
		!accessTokenPattern.MatchString(id.AccessToken):
		return fmt.Errorf("%w: access_token", ErrSenderMalformed)
	case id.WabaID != "" && !metaIDPattern.MatchString(id.WabaID):
		return fmt.Errorf("%w: waba_id", ErrSenderMalformed)
	case id.Ref != "" && !senderRefPattern.MatchString(id.Ref):
		return fmt.Errorf("%w: ref", ErrSenderMalformed)
	}
	return nil
}

// redact troca o token do remetente por *** numa mensagem que vai para log ou resposta — a Meta
// ou um proxy podem ecoar a credencial num erro.
func (id metaIdentity) redact(msg string) string {
	if id.AccessToken == "" {
		return msg
	}
	return strings.ReplaceAll(msg, id.AccessToken, "***")
}

func (id metaIdentity) redactErr(err error) error {
	if err == nil || id.AccessToken == "" || !strings.Contains(err.Error(), id.AccessToken) {
		return err
	}
	return errors.New(id.redact(err.Error()))
}

// senderFromHeaders lê o remetente dos headers internos. Nenhum header = ErrSenderMissing;
// qualquer header presente obriga o conjunto inteiro a estar certo.
func senderFromHeaders(h http.Header) (metaIdentity, error) {
	names := []string{headerSenderPhoneNumberID, headerSenderWabaID, headerSenderAccessToken, headerSenderRef}
	present := false
	for _, name := range names {
		values := h.Values(name)
		if len(values) > 1 {
			return metaIdentity{}, fmt.Errorf("%w: header %s repetido", ErrSenderMalformed, name)
		}
		if len(values) == 1 {
			present = true
		}
	}
	if !present {
		return metaIdentity{}, ErrSenderMissing
	}
	id := metaIdentity{
		PhoneNumberID: h.Get(headerSenderPhoneNumberID),
		WabaID:        h.Get(headerSenderWabaID),
		AccessToken:   h.Get(headerSenderAccessToken),
		Ref:           h.Get(headerSenderRef),
	}
	if id.Ref == "" {
		return metaIdentity{}, fmt.Errorf("%w: ref", ErrSenderMalformed)
	}
	if err := id.validate(); err != nil {
		return metaIdentity{}, err
	}
	return id, nil
}

type senderContextKey struct{}

// withSender exige o remetente da chamada antes do handler: sem ele, 400 — não existe remetente
// padrão. Roda DEPOIS de auth: sem API_KEY a resposta é 401 independentemente da identidade.
// A Organization da chamada sai da referência (painel), e o número do remetente tem de ser o dela.
func withSender(requireWaba bool, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := senderFromHeaders(r.Header)
		if err == nil && requireWaba && id.WabaID == "" {
			err = ErrSenderWabaMissing
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "remetente inválido: "+err.Error())
			return
		}
		tc, ok := requireTenant(w, id.reference())
		if !ok {
			return
		}
		if id.WabaID != "" && id.WabaID != tc.WabaID {
			writeError(w, http.StatusForbidden, "remetente não confere com a Organization")
			return
		}
		ctx := context.WithValue(r.Context(), senderContextKey{}, id)
		next(w, r.WithContext(context.WithValue(ctx, tenantContextKey{}, tc)))
	}
}

func senderFrom(r *http.Request) metaIdentity {
	id, _ := r.Context().Value(senderContextKey{}).(metaIdentity)
	return id
}

type tenantContextKey struct{}

// withTenant protege rotas internas que só leem ou mexem em dados de UMA Organization (painel de
// eventos, fila, problemas): exigem a referência assinada e o número dela, nunca o token. Sem
// contexto não existe "lista tudo".
func withTenant(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ref := senderRef{PhoneNumberID: r.Header.Get(headerSenderPhoneNumberID), Ref: r.Header.Get(headerSenderRef)}
		if len(r.Header.Values(headerSenderRef)) > 1 || len(r.Header.Values(headerSenderPhoneNumberID)) > 1 ||
			!metaIDPattern.MatchString(ref.PhoneNumberID) || !senderRefPattern.MatchString(ref.Ref) {
			writeError(w, http.StatusBadRequest, "contexto de Organization ausente ou malformado")
			return
		}
		tc, ok := requireTenant(w, ref)
		if !ok {
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), tenantContextKey{}, tc)))
	}
}

// requireTenant responde o erro certo quando a referência não vira contexto: recusa definitiva é
// 403 (sem dizer por quê), indisponibilidade é 503.
func requireTenant(w http.ResponseWriter, ref senderRef) (tenantContext, bool) {
	tc, err := refTenant(ref)
	switch {
	case err == nil:
		return tc, true
	case dropWithoutEffect(err):
		writeError(w, http.StatusForbidden, "contexto de Organization recusado")
	default:
		writeError(w, http.StatusServiceUnavailable, "contexto de Organization indisponível")
	}
	return tenantContext{}, false
}

func tenantFrom(r *http.Request) tenantContext {
	tc, _ := r.Context().Value(tenantContextKey{}).(tenantContext)
	return tc
}

// forbiddenBodyFields nunca podem chegar no corpo: o remetente só entra pelos headers acima.
var forbiddenBodyFields = map[string]bool{
	"sender": true, "sender_ref": true, "phone_number_id": true, "waba_id": true,
	"access_token": true, "organization_id": true,
}

var errInvalidJSON = errors.New("json inválido")

// decodeJSONBody decodifica o corpo recusando qualquer campo de remetente no nível de cima
// (comparação sem caixa, como o próprio encoding/json faz ao casar campos).
func decodeJSONBody(r *http.Request, dst any) error {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return errInvalidJSON
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return errInvalidJSON
	}
	for key := range top {
		if forbiddenBodyFields[strings.ToLower(key)] {
			return fmt.Errorf("campo não aceito no corpo: %s", strings.ToLower(key))
		}
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return errInvalidJSON
	}
	return nil
}

// Base da Graph API. Plataforma, não tenant.
const defaultGraphBase = "https://graph.facebook.com"

func validateGraphBase(base string, production bool) error {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("META_GRAPH_BASE_URL inválida")
	}
	if u.Scheme != "https" && (production || u.Scheme != "http") {
		return errors.New("META_GRAPH_BASE_URL precisa ser https")
	}
	return nil
}

func graphBase() string {
	if cfg.MetaGraphBase == "" {
		return defaultGraphBase
	}
	return strings.TrimRight(cfg.MetaGraphBase, "/")
}
