package main

import (
	"os"
	"strings"
)

// Distinção entre produção e dev/test.
//
// O serviço roda hoje no Railway, que expõe RAILWAY_ENVIRONMENT_NAME (valor "production" no
// ambiente produtivo). APP_ENV vem antes para que qualquer outra hospedagem — ou um teste — possa
// declarar o ambiente sem depender de uma variável específica do Railway.
//
// O padrão é "development" de propósito: em dev e em `go test` nenhuma das duas variáveis existe, e
// o serviço precisa continuar subindo sem os segredos. Isso NÃO afrouxa os controles — eles são
// fail-closed em tempo de execução nos dois ambientes (sem API_KEY ninguém autentica; sem
// META_APP_SECRET nenhum webhook é aceito). O que é condicional a produção é apenas a EXIGÊNCIA de
// que os valores existam no boot, para que uma variável esquecida no deploy derrube o processo em
// vez de degradar em silêncio.
var environmentEnvKeys = []string{"APP_ENV", "RAILWAY_ENVIRONMENT_NAME"}

// requiredProductionEnv são os segredos sem os quais o serviço não pode subir em produção. Cada um
// protege um controle que, com o valor ausente, deixaria de existir:
//
//	META_APP_SECRET — verificação HMAC do webhook (webhook.go); ausente = qualquer POST aceito.
//	API_KEY         — autenticação de todo endpoint não público (main.go, dashboard.go).
//	DATABASE_URL    — persistência; ausente = fila e eventos perdidos no restart, sem sinal (db.go).
//	PANEL_SENDER_RESOLVER_URL / PANEL_SENDER_RESOLVER_KEY — remetente dos envios persistidos (fila,
//	                  retry) e das respostas automáticas (resolver.go); ausentes = nada disso sai.
var requiredProductionEnv = []string{
	"META_APP_SECRET",
	"API_KEY",
	"DATABASE_URL",
	"PANEL_SENDER_RESOLVER_URL",
	"PANEL_SENDER_RESOLVER_KEY",
}

// environmentName devolve o nome do ambiente em minúsculas, ou "development" se nada for declarado.
func environmentName(lookup func(string) string) string {
	for _, key := range environmentEnvKeys {
		if v := strings.TrimSpace(lookup(key)); v != "" {
			return strings.ToLower(v)
		}
	}
	return "development"
}

// isProductionEnv recebe o lookup para ser testável sem mexer no ambiente do processo.
func isProductionEnv(lookup func(string) string) bool {
	switch environmentName(lookup) {
	case "production", "prod":
		return true
	default:
		return false
	}
}

func isProduction() bool {
	return isProductionEnv(os.Getenv)
}

// requireProductionEnv aborta o processo quando falta, em produção, algum segredo obrigatório.
// Fora de produção não faz nada. Usa mustEnv — o helper que o repositório já usa para variável
// obrigatória — só nas chaves que já sabemos estar faltando, para abortar com a mesma mensagem das
// demais.
func requireProductionEnv() {
	if !isProduction() {
		return
	}
	for _, key := range missingProductionEnv(os.Getenv) {
		mustEnv(key)
	}
}

// missingProductionEnv lista, na ordem de requiredProductionEnv, os segredos obrigatórios que estão
// ausentes ou em branco. Valor só com espaços conta como ausente: "API_KEY= " no painel do Railway
// é um erro de digitação, não uma chave.
func missingProductionEnv(lookup func(string) string) []string {
	var missing []string
	for _, key := range requiredProductionEnv {
		if strings.TrimSpace(lookup(key)) == "" {
			missing = append(missing, key)
		}
	}
	return missing
}
