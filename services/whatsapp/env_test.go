package main

import (
	"strings"
	"testing"
)

// envLookup é um os.Getenv falso — mantém os testes fora do ambiente do processo.
func envLookup(pairs map[string]string) func(string) string {
	return func(key string) string { return pairs[key] }
}

func TestGivenRailwayProductionEnv_WhenCheckingEnvironment_ThenIsProduction(t *testing.T) {
	// Given
	lookup := envLookup(map[string]string{"RAILWAY_ENVIRONMENT_NAME": "production"})

	// When
	prod := isProductionEnv(lookup)

	// Then
	if !prod {
		t.Fatalf("RAILWAY_ENVIRONMENT_NAME=production deveria ser produção")
	}
}

func TestGivenAppEnvProduction_WhenCheckingEnvironment_ThenIsProduction(t *testing.T) {
	// Given: APP_ENV tem precedência sobre a variável do Railway
	lookup := envLookup(map[string]string{"APP_ENV": "Production", "RAILWAY_ENVIRONMENT_NAME": "staging"})

	// When
	prod := isProductionEnv(lookup)

	// Then
	if !prod {
		t.Fatalf("APP_ENV=Production deveria ser produção, independente do case")
	}
}

func TestGivenNoEnvDeclared_WhenCheckingEnvironment_ThenIsDevelopment(t *testing.T) {
	// Given: é o caso de `go test` e de `go run` local
	lookup := envLookup(nil)

	// When
	name := environmentName(lookup)

	// Then
	if name != "development" {
		t.Fatalf("environmentName = %q, want development", name)
	}
	if isProductionEnv(lookup) {
		t.Fatalf("sem declaração de ambiente não pode ser produção — o serviço precisa subir em dev")
	}
}

func TestGivenNonProductionEnvName_WhenCheckingEnvironment_ThenIsNotProduction(t *testing.T) {
	// Given
	lookup := envLookup(map[string]string{"RAILWAY_ENVIRONMENT_NAME": "staging"})

	// When / Then
	if isProductionEnv(lookup) {
		t.Fatalf("staging não é produção")
	}
}

func TestGivenProductionWithoutAppSecret_WhenValidatingBootEnv_ThenReportsItMissing(t *testing.T) {
	// Given: é exatamente o deploy que hoje sobe com a verificação HMAC desligada
	lookup := envLookup(map[string]string{"RAILWAY_ENVIRONMENT_NAME": "production"})

	// When
	missing := missingProductionEnv(lookup)

	// Then
	if !contains(missing, "META_APP_SECRET") {
		t.Fatalf("missing = %v, want META_APP_SECRET — sem ele o boot em produção tem de abortar", missing)
	}
}

func TestGivenProductionWithBlankAppSecret_WhenValidatingBootEnv_ThenReportsItMissing(t *testing.T) {
	// Given: valor só com espaços é erro de digitação no painel, não segredo
	lookup := envLookup(map[string]string{
		"RAILWAY_ENVIRONMENT_NAME": "production",
		"META_APP_SECRET":          "   ",
	})

	// When
	missing := missingProductionEnv(lookup)

	// Then
	if !contains(missing, "META_APP_SECRET") {
		t.Fatalf("missing = %v, want META_APP_SECRET para valor em branco", missing)
	}
}

func TestGivenProductionWithEveryRequiredSecret_WhenValidatingBootEnv_ThenNothingIsMissing(t *testing.T) {
	// Given
	values := map[string]string{"RAILWAY_ENVIRONMENT_NAME": "production"}
	for _, key := range requiredProductionEnv {
		values[key] = "valor-" + strings.ToLower(key)
	}
	lookup := envLookup(values)

	// When
	missing := missingProductionEnv(lookup)

	// Then
	if len(missing) != 0 {
		t.Fatalf("missing = %v, want vazio", missing)
	}
}

func contains(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
