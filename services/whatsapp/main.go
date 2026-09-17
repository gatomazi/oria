package main

import (
	"crypto/subtle"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config é só configuração de PLATAFORMA. O remetente (número, WABA, token) é da Organization e
// chega em cada chamada (identity.go) — não existe número nem token do serviço.
type Config struct {
	Port        string
	APIVersion  string
	AppSecret   string
	VerifyToken string
	APIKey      string
	// Repasse ao painel (forward.go): URL sem segredo + segredo da assinatura em header.
	ForwardURL    string
	ForwardSecret string
	// AppID é o ID do app da Meta (diferente do WABA ID) — exigido só pelo endpoint de resumable
	// upload (/{app-id}/uploads), usado pra amostra de mídia de template. Vazio até ser
	// configurado; handleMediaUpload retorna erro claro nesse caso, não falha o boot do serviço
	// (upload de amostra é opcional, o resto do serviço funciona sem isso).
	AppID string

	// Intervalo mínimo entre auto-respostas para o mesmo cliente da mesma Organization. O TEXTO da
	// auto-resposta e o número do aviso são da Organization (contexto do painel, Fase 5c).
	ReplyCooldown time.Duration

	// Base da Graph API (plataforma). Só muda em ambiente de teste; em produção tem de ser https.
	MetaGraphBase string

	// Resolução do remetente de envios persistidos (fila, retry) — ver resolver.go. Configuração de
	// plataforma: a URL do painel e a chave que ele exige deste serviço.
	SenderResolverURL string
	SenderResolverKey string

	// Intervalo mínimo entre envios à Meta (todas as origens somadas) — evita rajada em disparo
	// grande de campanha. 0 desliga.
	SendInterval time.Duration
}

var cfg Config

func main() {
	cfg = Config{
		Port:        getEnv("PORT", "8080"),
		APIVersion:  getEnv("META_API_VERSION", "v21.0"),
		AppSecret:   getEnv("META_APP_SECRET", ""),
		VerifyToken: mustEnv("META_VERIFY_TOKEN"),
		APIKey:      getEnv("API_KEY", ""),
		AppID:       getEnv("META_APP_ID", ""),

		SenderResolverURL: getEnv("PANEL_SENDER_RESOLVER_URL", ""),
		SenderResolverKey: getEnv("PANEL_SENDER_RESOLVER_KEY", ""),

		ReplyCooldown: time.Duration(getEnvInt("REPLY_COOLDOWN_MINUTES", 360)) * time.Minute,
		MetaGraphBase: getEnv("META_GRAPH_BASE_URL", defaultGraphBase),

		SendInterval: time.Duration(getEnvInt("META_SEND_INTERVAL_MS", 1000)) * time.Millisecond,
	}
	sendPacer = newPacer(cfg.SendInterval)

	// Fail-fast em produção: sem esses segredos, um controle de segurança inteiro deixaria de
	// existir (assinatura do webhook, autenticação, persistência). Derrubar o boot é melhor que
	// subir aparentemente saudável e sem proteção (ver env.go).
	requireProductionEnv()
	if err := validateGraphBase(cfg.MetaGraphBase, isProduction()); err != nil {
		log.Fatalf("[meta] %v", err)
	}
	configureForward()
	for _, legacy := range []string{"REPLY_REDIRECT_MESSAGE", "REPLY_REDIRECT_NUMBER", "REPLY_NOTIFY_NUMBER"} {
		if os.Getenv(legacy) != "" {
			log.Printf("[config] %s é ignorada: resposta automática e aviso são configurados por Organization no painel", legacy)
		}
	}

	resolver, err := newPanelResolver(cfg.SenderResolverURL, cfg.SenderResolverKey, isProduction())
	switch {
	case errors.Is(err, ErrResolverNotEnabled):
		log.Printf("[sender] resolver do painel não configurado — itens da fila com remetente não serão despachados")
	case err != nil:
		log.Fatalf("[sender] %v", err)
	default:
		panelSender = resolver
		if tenants, ok := resolver.(tenantResolver); ok {
			panelTenants = tenants
		}
	}

	initDB()
	// Eventos aceitos e ainda não processados (inclusive os de uma réplica que caiu) — inbox.go.
	startInboxWorker()

	mux := newMux()

	log.Printf("WhatsApp service :%s  env=%s  api_key=%v  forward=%v  forward_legacy_query=%v  sig_verify=%v  sender_resolver=%v",
		cfg.Port, environmentName(os.Getenv), cfg.APIKey != "", cfg.ForwardURL != "", hasForwardQuery(cfg.ForwardURL),
		cfg.AppSecret != "", cfg.SenderResolverURL != "")

	if err := http.ListenAndServe(":"+cfg.Port, mux); err != nil {
		log.Fatal(err)
	}
}

// configureForward lê WEBHOOK_FORWARD_URL/WEBHOOK_FORWARD_SECRET (forward.go). Em produção,
// configuração inválida (inclusive o segredo antigo na query string sem a flag de transição)
// derruba o boot; fora dela, o repasse fica desligado com aviso. Nenhuma mensagem repete a URL.
func configureForward() {
	legacyQuery, flagErr := parseForwardLegacyQuery(os.Getenv(forwardLegacyQueryEnv))
	forwardURL, err := validateForwardSettings(getEnv("WEBHOOK_FORWARD_URL", ""), os.Getenv("WEBHOOK_FORWARD_SECRET"), isProduction(), legacyQuery)
	if flagErr != nil && !errors.Is(err, ErrForwardDisabled) {
		err = flagErr
	}
	switch {
	case errors.Is(err, ErrForwardDisabled):
	case err != nil && isProduction():
		log.Fatalf("[forward] %v", err)
	case err != nil:
		log.Printf("[forward] %v — repasse desligado", err)
	default:
		cfg.ForwardURL = forwardURL
		cfg.ForwardSecret = os.Getenv("WEBHOOK_FORWARD_SECRET")
		warnForwardLegacyQuery(legacyQuery, hasForwardQuery(forwardURL))
	}
}

// warnForwardLegacyQuery avisa, a cada boot, que a transição do repasse está ligada (rodada 19, §5).
func warnForwardLegacyQuery(legacyQuery, withQuery bool) {
	if !legacyQuery {
		return
	}
	env := environmentName(os.Getenv)
	if withQuery {
		log.Printf("[forward] AVISO env=%s: %s=1 — TRANSIÇÃO: cada repasse leva a query legada da URL (parâmetro secret) além da assinatura em header. "+
			"Assim que o painel aceitar a assinatura, remover a query de WEBHOOK_FORWARD_URL e desligar a flag", env, forwardLegacyQueryEnv)
		return
	}
	log.Printf("[forward] AVISO env=%s: %s=1 sem query na WEBHOOK_FORWARD_URL — nada legado é enviado; desligar a flag", env, forwardLegacyQueryEnv)
}

// newMux registra todas as rotas. Separado do main para que o teste de contrato use exatamente o
// roteador de produção (quais rotas exigem API_KEY, remetente e WABA).
func newMux() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("/webhook", handleWebhook)

	mux.HandleFunc("/send/text", auth(withSender(false, handleSendText)))
	mux.HandleFunc("/send/template", auth(withSender(false, handleSendTemplate)))
	mux.HandleFunc("/send/media", auth(withSender(false, handleSendMedia)))
	mux.HandleFunc("/send/buttons", auth(withSender(false, handleSendButtons)))
	mux.HandleFunc("/send/list", auth(withSender(false, handleSendList)))
	mux.HandleFunc("/send/reaction", auth(withSender(false, handleSendReaction)))
	mux.HandleFunc("/send/read", auth(withSender(false, handleMarkRead)))
	mux.HandleFunc("/media/", auth(withSender(false, handleGetMedia)))

	mux.HandleFunc("/health", handleHealth)

	// Rotas internas com dado de tenant exigem, além da API_KEY, o contexto de uma Organization
	// (withTenant). As páginas HTML embutidas (/dashboard, /problems, /automaticos) foram
	// desativadas: sem contexto de tenant confiável elas não tinham como mostrar dado nenhum. A
	// tela equivalente é do painel Oria (dashboard.go).
	mux.HandleFunc("/dashboard", dashAuth(handleDisabledPage))
	mux.HandleFunc("/dashboard/events", auth(withTenant(handleDashboardEvents)))
	mux.HandleFunc("/dashboard/events/clear", auth(withTenant(handleEventsClear)))

	mux.HandleFunc("/queue/add", auth(withSender(false, handleQueueAdd)))
	mux.HandleFunc("/queue/list", auth(withTenant(handleQueueList)))
	mux.HandleFunc("/queue/send", auth(withTenant(handleQueueSend)))
	mux.HandleFunc("/queue/delete", auth(withTenant(handleQueueDelete)))
	mux.HandleFunc("/queue/dedupe", auth(withTenant(handleQueueDedupe)))

	mux.HandleFunc("/templates/list", auth(withSender(true, handleTemplatesList)))
	mux.HandleFunc("/templates/create", auth(withSender(true, handleTemplatesCreate)))
	mux.HandleFunc("/templates/delete", auth(withSender(true, handleTemplatesDelete)))

	mux.HandleFunc("/media/upload", auth(withSender(false, handleMediaUpload)))

	mux.HandleFunc("/problems", dashAuth(handleDisabledPage))
	mux.HandleFunc("/problems/list", auth(withTenant(handleProblemsList)))
	mux.HandleFunc("/problems/add", auth(withTenant(handleProblemsAdd)))
	mux.HandleFunc("/problems/sync", auth(withTenant(handleProblemsSync)))

	mux.HandleFunc("/automaticos", dashAuth(handleDisabledPage))
	mux.HandleFunc("/automaticos/list", auth(withTenant(handleAutomaticosList)))
	return mux
}

func auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !validAPIKey(apiKeyFromRequest(r)) {
			writeError(w, http.StatusUnauthorized, "invalid or missing API key")
			return
		}
		next(w, r)
	}
}

// apiKeyFromRequest lê a credencial do chamador — só de header, nunca de query string (ver
// dashAuth em dashboard.go).
func apiKeyFromRequest(r *http.Request) string {
	if key := r.Header.Get("X-Api-Key"); key != "" {
		return key
	}
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

// validAPIKey falha FECHADO: API_KEY não configurada significa nenhum chamador autorizado, não
// todo mundo autorizado. Antes, `if cfg.APIKey == ""` liberava sem credencial todos os endpoints
// de envio, fila, templates, upload e problemas — inclusive os destrutivos (/problems/sync,
// /queue/delete, /dashboard/events/clear).
//
// A comparação é em tempo constante: `key != cfg.APIKey` termina no primeiro byte diferente.
func validAPIKey(key string) bool {
	if cfg.APIKey == "" || key == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(key), []byte(cfg.APIKey)) == 1
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("variável de ambiente obrigatória não definida: %s", key)
	}
	return v
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
