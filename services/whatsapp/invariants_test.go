package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// INV-27 — nenhum caminho do serviço lê o remetente de estado de processo. O remetente só existe
// quando chega na chamada (identity.go) ou volta do painel (resolver.go).
var processSenderMarkers = []string{
	"META_PHONE_NUMBER_ID",
	"META_ACCESS_TOKEN",
	"META_WABA_ID",
	"defaultIdentity",
	"envIdentity",
	"cfg.PhoneNumberID",
	"cfg.AccessToken",
	"resolveWABAID",
}

func productionSources(t *testing.T) map[string]string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	out := map[string]string{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		out[f] = string(b)
	}
	if len(out) == 0 {
		t.Fatalf("nenhum arquivo de produção encontrado")
	}
	return out
}

func TestGivenProductionSources_WhenScanningForProcessSender_ThenNoneRemains(t *testing.T) {
	// Given
	sources := productionSources(t)

	// When / Then
	for file, src := range sources {
		for _, marker := range processSenderMarkers {
			if strings.Contains(src, marker) {
				t.Errorf("%s usa %s — remetente de estado de processo (INV-27)", file, marker)
			}
		}
	}
}

// INV-35 — o endpoint público de saúde não expõe identidade de tenant.
func TestGivenLegacySenderEnvironment_WhenCallingHealthWithoutCredentials_ThenOnlyStatusIsReturned(t *testing.T) {
	// Given: o ambiente ainda tem o remetente antigo (Release C, antes da limpeza)
	useLegacySenderEnv(t)
	useConfig(t, Config{APIKey: testAPIKey, AppID: "123456789"})
	rec := httptest.NewRecorder()

	// When
	handleHealth(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	// Then
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("health não é JSON: %s", rec.Body.String())
	}
	if rec.Code != http.StatusOK || len(body) != 1 || body["status"] != "ok" {
		t.Fatalf("health = %d %s, want só {\"status\":\"ok\"}", rec.Code, rec.Body.String())
	}
	for _, leak := range []string{"9990000000", "9998887776", "EAAG", "phone", "waba", "organization", "token", testAPIKey} {
		if strings.Contains(rec.Body.String(), leak) {
			t.Fatalf("health expõe %q: %s", leak, rec.Body.String())
		}
	}
}

// INV-32 — toda consulta ou escrita de dado de tenant no banco do serviço filtra pela Organization.
// Por função de db.go: se ela fala de uma tabela de tenant, precisa de um predicado
// `organization_id = $n` (leitura, update, delete) ou gravar a coluna (insert). Exceções nomeadas:
// o próprio esquema (migrations), a limpeza de retenção (chaves de idempotência e inbox falha) e a
// reivindicação da inbox pelo worker da plataforma (cada linha devolvida carrega a própria
// Organization e todo efeito roda nesse escopo — inbox.go).
var tenantTables = regexp.MustCompile(`\b(events|queue_items|problem_orders|processed_webhook_events|webhook_inbox)\b`)
var sqlLiteral = regexp.MustCompile("`[^`]*`|\"(?:[^\"\\\\]|\\\\.)*\"")
var orgPredicate = regexp.MustCompile(`organization_id\s*=\s*\$\d|\(organization_id,`)

func TestGivenDatabaseCode_WhenScanningTenantQueries_ThenEveryOneFiltersByOrganization(t *testing.T) {
	// Given
	src, err := os.ReadFile("db.go")
	if err != nil {
		t.Fatalf("read db.go: %v", err)
	}
	exempt := map[string]bool{"migrate": true, "migrateBaseline": true, "migrateTenantScope": true, "migrateWebhookInbox": true,
		"dbPruneWebhookEvents": true, "dbClaimInbox": true}
	checked := 0

	// When / Then
	for _, fn := range strings.Split(string(src), "\nfunc ")[1:] {
		name := strings.FieldsFunc(fn, func(r rune) bool { return r == '(' || r == ' ' })[0]
		if exempt[name] {
			continue
		}
		sql := strings.Join(sqlLiteral.FindAllString(fn, -1), " ")
		if !tenantTables.MatchString(sql) {
			continue
		}
		checked++
		if !orgPredicate.MatchString(sql) {
			t.Errorf("%s: SQL de tenant sem predicado de organization_id (INV-32)", name)
		}
	}
	if checked < 10 {
		t.Fatalf("só %d funções verificadas — o teste não está enxergando o código", checked)
	}
}
