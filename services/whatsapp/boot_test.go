package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Fail-fast de boot é log.Fatalf: mata o processo. Para provar que ele realmente mata (e não só
// que a lista de faltantes está certa), cada teste re-executa o próprio binário de teste num
// subprocesso, com o ambiente que se quer exercitar, e confere saída e código de retorno.
//
// O filho que espera abortar NUNCA chama t.Fatalf: um teste que falha também sai com código != 0 e
// seria indistinguível de um log.Fatalf. Por isso o pai exige as duas coisas — saída != 0 E a
// mensagem do fatal esperada.
const childEnvKey = "WEBHOOK_BOOT_TEST_CHILD"

func isBootChild() bool { return os.Getenv(childEnvKey) == "1" }

// runBootChild roda apenas testName num subprocesso, com env extra.
func runBootChild(t *testing.T, testName string, env ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^"+testName+"$")
	cmd.Env = append(os.Environ(), append([]string{childEnvKey + "=1"}, env...)...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func assertAborted(t *testing.T, out string, err error, marker, motivo string) {
	t.Helper()
	if err == nil {
		t.Fatalf("processo continuou rodando — %s\nsaída:\n%s", motivo, out)
	}
	if !strings.Contains(out, marker) {
		t.Fatalf("saiu com erro mas sem o fatal esperado (%q) — %s\nsaída:\n%s", marker, motivo, out)
	}
}

func assertKeptRunning(t *testing.T, out string, err error, motivo string) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v\nsaída:\n%s", motivo, err, out)
	}
}

func TestGivenProductionWithoutSecrets_WhenBooting_ThenProcessAborts(t *testing.T) {
	if isBootChild() {
		// Filho: produção, nenhum segredo obrigatório definido. Se retornar, sai com 0 e o pai
		// acusa a falta do fail-fast.
		requireProductionEnv()
		return
	}

	// Given / When
	out, err := runBootChild(t, "TestGivenProductionWithoutSecrets_WhenBooting_ThenProcessAborts",
		"APP_ENV=production", "META_APP_SECRET=", "API_KEY=", "DATABASE_URL=")

	// Then
	assertAborted(t, out, err, "variável de ambiente obrigatória não definida",
		"boot em produção sem segredos obrigatórios tem de abortar")
}

func TestGivenDevelopmentWithoutSecrets_WhenBooting_ThenProcessKeepsRunning(t *testing.T) {
	if isBootChild() {
		requireProductionEnv()
		return
	}

	// Given / When
	out, err := runBootChild(t, "TestGivenDevelopmentWithoutSecrets_WhenBooting_ThenProcessKeepsRunning",
		"APP_ENV=", "RAILWAY_ENVIRONMENT_NAME=", "META_APP_SECRET=", "API_KEY=", "DATABASE_URL=")

	// Then
	assertKeptRunning(t, out, err, "fora de produção o boot não pode abortar por falta de segredo")
}

func TestGivenProductionWithEverySecret_WhenBooting_ThenProcessKeepsRunning(t *testing.T) {
	if isBootChild() {
		requireProductionEnv()
		return
	}

	// Given
	env := []string{"APP_ENV=production"}
	for _, key := range requiredProductionEnv {
		env = append(env, key+"=valor-"+strings.ToLower(key))
	}

	// When
	out, err := runBootChild(t, "TestGivenProductionWithEverySecret_WhenBooting_ThenProcessKeepsRunning", env...)

	// Then
	assertKeptRunning(t, out, err, "com todos os segredos definidos o boot não pode abortar")
}

func TestGivenProductionWithoutDatabase_WhenInitializingDB_ThenProcessAborts(t *testing.T) {
	if isBootChild() {
		// Filho: produção sem persistência — antes, degradava em silêncio para modo memória e
		// perdia a fila no restart.
		initDB()
		return
	}

	// Given / When
	out, err := runBootChild(t, "TestGivenProductionWithoutDatabase_WhenInitializingDB_ThenProcessAborts",
		"APP_ENV=production", "DATABASE_URL=")

	// Then
	assertAborted(t, out, err, "persistência é obrigatória em produção",
		"perda silenciosa de dados em produção não é aceitável")
}

func TestGivenProductionWithUnreachableDatabase_WhenInitializingDB_ThenProcessAborts(t *testing.T) {
	if isBootChild() {
		initDB()
		return
	}

	// Given: porta fechada em localhost — a conexão falha rápido
	// When
	out, err := runBootChild(t, "TestGivenProductionWithUnreachableDatabase_WhenInitializingDB_ThenProcessAborts",
		"APP_ENV=production", "DATABASE_URL=postgres://u:p@127.0.0.1:1/naoexiste?connect_timeout=2&sslmode=disable")

	// Then
	assertAborted(t, out, err, "persistência é obrigatória em produção",
		"banco inalcançável em produção tem de abortar, não cair para memória")
}

func TestGivenDevelopmentWithoutDatabase_WhenInitializingDB_ThenFallsBackToMemory(t *testing.T) {
	if isBootChild() {
		initDB()
		if db != nil {
			t.Fatalf("sem DATABASE_URL não deveria haver pool")
		}
		return
	}

	// Given / When
	out, err := runBootChild(t, "TestGivenDevelopmentWithoutDatabase_WhenInitializingDB_ThenFallsBackToMemory",
		"APP_ENV=", "RAILWAY_ENVIRONMENT_NAME=", "DATABASE_URL=")

	// Then
	assertKeptRunning(t, out, err, "em dev o modo memória tem de continuar funcionando")
}

func TestGivenProductionWithoutDatabaseURL_WhenValidatingBootEnv_ThenReportsItMissing(t *testing.T) {
	// Given
	lookup := envLookup(map[string]string{
		"RAILWAY_ENVIRONMENT_NAME": "production",
		"META_APP_SECRET":          "segredo",
		"API_KEY":                  "chave",
	})

	// When
	missing := missingProductionEnv(lookup)

	// Then
	if !contains(missing, "DATABASE_URL") {
		t.Fatalf("missing = %v, want DATABASE_URL", missing)
	}
}
