package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Repasse ao painel (WEBHOOK_FORWARD_URL) — contrato testdata/forward-auth-v1.json (cópia idêntica
// no painel).
//
// Antes (até a Fase 5c) o segredo ia embutido na própria URL (`?secret=`): aparecia em log de
// proxy, em erro de transporte (url.Error carrega a URL) e em qualquer tela que mostrasse a
// variável. Agora a URL não pode ter credencial, query nem fragmento, e cada repasse leva
//
//	X-Oria-Forward-Timestamp: <unix seconds>
//	X-Oria-Forward-Signature: v1=<hex HMAC-SHA256(WEBHOOK_FORWARD_SECRET, timestamp + "." + corpo)>
//
// O painel confere em tempo constante, recusa timestamp fora da janela e recusa `secret` na query.
//
// Transição sem perda de status (rodada 19, §5): enquanto o painel em produção ainda autentica pelo
// `?secret=` antigo, WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1 (desligada por padrão) aceita a URL
// legada — exatamente um parâmetro `secret`, nada mais — e cada repasse sai com a query E com a
// assinatura em header, mesmo corpo. O painel antigo ignora os headers e confere a query; o painel
// novo com WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1 ignora a query e confere a assinatura. Sem a
// flag, a URL com query continua recusada. A URL nunca vai para log nem para erro.
const (
	forwardTimestampHeader = "X-Oria-Forward-Timestamp"
	forwardSignatureHeader = "X-Oria-Forward-Signature"
	forwardSignatureScheme = "v1="
	minForwardSecretLen    = 32

	// forwardLegacyQueryEnv liga a transição (só "1"; vazio ou "0" desliga; outro valor é erro).
	forwardLegacyQueryEnv   = "WEBHOOK_FORWARD_LEGACY_QUERY_SECRET"
	forwardLegacyQueryParam = "secret"
)

// ErrForwardDisabled: WEBHOOK_FORWARD_URL não definida — o repasse é opcional.
var ErrForwardDisabled = errors.New("forward disabled")

var (
	forwardClient = &http.Client{Timeout: 10 * time.Second}
	forwardNow    = time.Now
)

// validateForwardConfig valida a URL e o segredo do repasse, sem a transição. A mensagem de erro
// nunca repete a URL (ela pode estar carregando o segredo antigo na query string).
func validateForwardConfig(rawURL, secret string, production bool) (string, error) {
	return validateForwardSettings(rawURL, secret, production, false)
}

// parseForwardLegacyQuery lê WEBHOOK_FORWARD_LEGACY_QUERY_SECRET. Valor inesperado é erro (e não
// "desligada"): um "true" lido como desligado recusaria status no painel antigo sem aviso.
func parseForwardLegacyQuery(raw string) (bool, error) {
	switch strings.TrimSpace(raw) {
	case "", "0":
		return false, nil
	case "1":
		return true, nil
	default:
		return false, fmt.Errorf("%s inválida (aceitos: 1, 0 ou ausente)", forwardLegacyQueryEnv)
	}
}

// hasForwardQuery diz se a URL (já validada) carrega query — só a URL legada da transição carrega.
func hasForwardQuery(rawURL string) bool {
	u, err := url.Parse(rawURL)
	return err == nil && (u.RawQuery != "" || u.ForceQuery)
}

// isLegacySecretQuery: a query é exatamente `secret=<valor não vazio>`, uma vez só.
func isLegacySecretQuery(u *url.URL) bool {
	if u.ForceQuery {
		return false
	}
	values, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(values) != 1 {
		return false
	}
	v, ok := values[forwardLegacyQueryParam]
	return ok && len(v) == 1 && v[0] != ""
}

// validateForwardSettings valida URL + segredo; com legacyQuery, aceita também a URL legada com
// `?secret=` (transição). A assinatura continua obrigatória nos dois casos.
func validateForwardSettings(rawURL, secret string, production, legacyQuery bool) (string, error) {
	if rawURL == "" {
		return "", ErrForwardDisabled
	}
	invalid := errors.New("WEBHOOK_FORWARD_URL inválida: sem credencial, query string ou fragmento — o segredo vai em WEBHOOK_FORWARD_SECRET")
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", invalid
	}
	if u.RawQuery != "" || u.ForceQuery {
		if !legacyQuery || !isLegacySecretQuery(u) {
			return "", invalid
		}
	}
	if u.Scheme != "https" && (production || u.Scheme != "http") {
		return "", errors.New("WEBHOOK_FORWARD_URL precisa ser https")
	}
	if len(secret) < minForwardSecretLen {
		return "", fmt.Errorf("WEBHOOK_FORWARD_SECRET ausente ou curto (mínimo %d caracteres)", minForwardSecretLen)
	}
	if u.RawQuery != "" && u.Query().Get(forwardLegacyQueryParam) == secret {
		// O segredo da assinatura é um valor NOVO: o da query já esteve em URL (log de proxy, tela).
		return "", errors.New("WEBHOOK_FORWARD_SECRET não pode ser o mesmo valor da query legada da URL — gere um valor novo")
	}
	return u.String(), nil
}

// signForward calcula a assinatura do repasse.
func signForward(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	return forwardSignatureScheme + hex.EncodeToString(mac.Sum(nil))
}

// sendForward entrega um corpo ao painel. Erro = não entregue (o chamador decide se tenta de novo).
// Nenhum erro carrega a URL nem o segredo.
func sendForward(body []byte) error {
	if cfg.ForwardURL == "" {
		return nil
	}
	if len(cfg.ForwardSecret) < minForwardSecretLen {
		// Falha fechada: sem segredo, nada sai sem autenticação.
		return errors.New("repasse sem WEBHOOK_FORWARD_SECRET — não enviado")
	}
	req, err := http.NewRequest(http.MethodPost, cfg.ForwardURL, bytes.NewReader(body))
	if err != nil {
		return errors.New("repasse: requisição inválida")
	}
	ts := strconv.FormatInt(forwardNow().Unix(), 10)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(forwardTimestampHeader, ts)
	req.Header.Set(forwardSignatureHeader, signForward(cfg.ForwardSecret, ts, body))

	resp, err := forwardClient.Do(req)
	if err != nil {
		var uerr *url.Error
		if errors.As(err, &uerr) {
			return fmt.Errorf("repasse: %v", uerr.Err)
		}
		return errors.New("repasse: falha de transporte")
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("repasse: painel respondeu %d", resp.StatusCode)
	}
	return nil
}
