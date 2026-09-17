package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Teste crash-after-accept (rodada 18, §24): processos filhos reais, o mesmo banco. Precisa de
// WEBHOOK_TEST_DATABASE_URL.

const (
	inboxChildEnv      = "WEBHOOK_INBOX_CHILD"
	inboxCrashEnv      = "WEBHOOK_INBOX_CRASH"
	inboxAddrEnv       = "WEBHOOK_INBOX_ADDR_FILE"
	inboxForwardEnv    = "WEBHOOK_INBOX_FORWARD_URL"
	inboxLeaseEnv      = "WEBHOOK_INBOX_LEASE"
	inboxChildSecret   = "segredo-da-plataforma-filho"
	inboxNotifyNumberA = "5548900000001"
)

// TestInboxProcess é o processo filho: "serve" é o serviço recebendo a Meta de verdade (porta
// local); "worker" é um restart que só drena a inbox. WEBHOOK_INBOX_CRASH derruba o processo
// (os.Exit) numa fronteira de passo.
func TestInboxProcess(t *testing.T) {
	mode := os.Getenv(inboxChildEnv)
	if mode == "" {
		t.Skip("só roda como processo filho")
	}
	db = connectSchema(t, os.Getenv("WEBHOOK_TEST_DATABASE_URL"), os.Getenv(childSchemaEnv))
	panelTenants = tenantsAB()
	panelSender = resolverAB()
	cfg = Config{APIVersion: "v21.0", AppSecret: inboxChildSecret, ReplyCooldown: time.Hour,
		ForwardURL: os.Getenv(inboxForwardEnv), ForwardSecret: testForwardSecret}
	if ttl := os.Getenv(inboxLeaseEnv); ttl != "" {
		inboxLeaseTTL, _ = time.ParseDuration(ttl)
	}
	crashAt := os.Getenv(inboxCrashEnv)
	inboxHook = func(point string) {
		if point == crashAt {
			fmt.Fprintf(os.Stderr, "queda simulada em %s\n", point)
			os.Exit(3)
		}
	}
	out := os.Getenv(childOutEnv)
	httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var body struct {
			To string `json:"to"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		phone := strings.Split(strings.TrimPrefix(r.URL.Path, "/v21.0/"), "/")[0]
		// Gravado na hora (append): uma queda logo depois do envio não pode apagar o registro.
		f, err := os.OpenFile(out, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintln(f, phone+"|"+body.To)
			f.Close()
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"messages":[{"id":"wamid.OUT"}]}`)), Header: http.Header{}}, nil
	})}

	switch mode {
	case "serve":
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		if err := os.WriteFile(os.Getenv(inboxAddrEnv), []byte(ln.Addr().String()), 0o600); err != nil {
			t.Fatalf("addr: %v", err)
		}
		_ = http.Serve(ln, newMux())
	case "worker":
		fmt.Printf("worker drenou %d linha(s)\n", drainInbox(nil))
	}
}

type inboxHarness struct {
	t       *testing.T
	dsn     string
	schema  string
	dir     string
	out     string
	forward string
}

func newInboxHarness(t *testing.T, forwardURL string) *inboxHarness {
	t.Helper()
	dsn, schema := useTestDatabase(t)
	dir := t.TempDir()
	return &inboxHarness{t: t, dsn: dsn, schema: schema, dir: dir, out: dir + "/sent.txt", forward: forwardURL}
}

func (h *inboxHarness) child(mode string, extra ...string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^TestInboxProcess$", "-test.v")
	cmd.Env = append(os.Environ(), inboxChildEnv+"="+mode, "WEBHOOK_TEST_DATABASE_URL="+h.dsn, childSchemaEnv+"="+h.schema,
		childOutEnv+"="+h.out, inboxForwardEnv+"="+h.forward, inboxAddrEnv+"="+h.dir+"/addr-"+mode)
	cmd.Env = append(cmd.Env, extra...)
	return cmd
}

// serve sobe o serviço num processo filho e devolve o endereço e o comando (com a saída).
func (h *inboxHarness) serve(extra ...string) (string, *exec.Cmd, *strings.Builder) {
	h.t.Helper()
	_ = os.Remove(h.dir + "/addr-serve")
	cmd := h.child("serve", extra...)
	var logs strings.Builder
	cmd.Stdout, cmd.Stderr = &logs, &logs
	if err := cmd.Start(); err != nil {
		h.t.Fatalf("start: %v", err)
	}
	h.t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	var addr string
	waitFor(h.t, "serviço filho escutando", func() bool {
		raw, err := os.ReadFile(h.dir + "/addr-serve")
		addr = string(raw)
		return err == nil && addr != ""
	})
	return addr, cmd, &logs
}

func (h *inboxHarness) worker(extra ...string) string {
	h.t.Helper()
	out, err := h.child("worker", extra...).CombinedOutput()
	if err != nil {
		h.t.Fatalf("worker: %v\n%s", err, out)
	}
	return string(out)
}

func postMeta(t *testing.T, addr, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/webhook", strings.NewReader(body))
	req.Header.Set("X-Hub-Signature-256", signPayload(inboxChildSecret, body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /webhook: %v", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("corpo da resposta incompleto: %v", err)
	}
	return resp.StatusCode, string(raw)
}

func assertCrashed(t *testing.T, cmd *exec.Cmd, logs *strings.Builder) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var err error
	select {
	case err = <-done:
	case <-time.After(15 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		t.Fatalf("o processo não caiu na fronteira pedida (continua rodando):\n%s", logs.String())
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 3 || !strings.Contains(logs.String(), "queda simulada") {
		t.Fatalf("o processo deveria ter caído na fronteira pedida: %v\n%s", err, logs.String())
	}
}

func TestGivenAcceptedWebhook_WhenProcessDiesRightAfter200_ThenRestartRunsEveryEffectExactlyOnce(t *testing.T) {
	// Given
	fwd, capture := useForwardServer(t, http.StatusOK)
	h := newInboxHarness(t, fwd.URL)
	body := inboundFrom(testWabaA, testPhoneA, inboxCustomer, "wamid.CRASH-1")
	addr, server, logs := h.serve(inboxCrashEnv + "=accepted")

	// When: a Meta recebe 200 e o processo morre antes de qualquer efeito
	status, resp := postMeta(t, addr, body)
	assertCrashed(t, server, logs)

	// Then: o 200 significava "aceito de forma durável"
	if status != http.StatusOK || resp != `{"status":"received"}` {
		t.Fatalf("resposta = %d %q", status, resp)
	}
	if n := countRows(t, `SELECT count(*) FROM webhook_inbox WHERE organization_id = $1`, testOrgA); n != 1 {
		t.Fatalf("inbox = %d linha(s), want 1 antes do restart", n)
	}
	if len(readSent(t, h.out)) != 0 || len(eventRows(t, testOrgA)) != 0 || len(capture.all()) != 0 {
		t.Fatalf("efeito antes do restart")
	}

	// When: restart
	h.worker()

	// Then: cada efeito exatamente uma vez, no escopo de A
	assertExactlyOnce(t, readSent(t, h.out), testPhoneA+"|"+inboxNotifyNumberA, testPhoneA+"|"+inboxCustomer)
	assertExactlyOnce(t, eventRows(t, testOrgA), "received|"+inboxCustomer, "sent|"+inboxCustomer)
	if len(eventRows(t, testOrgB)) != 0 {
		t.Fatalf("evento de A apareceu em B")
	}
	forwards := capture.all()
	if len(forwards) != 1 || !forwards[0].valid || !strings.Contains(string(forwards[0].body), "wamid.CRASH-1") || forwards[0].query != "" {
		t.Fatalf("repasses = %+v, want 1 assinado", forwards)
	}
	if n := countRows(t, `SELECT count(*) FROM webhook_inbox`); n != 0 {
		t.Fatalf("inbox com %d linha(s) depois de concluir", n)
	}

	// And: outro restart e a reentrega da Meta não repetem nada
	h.worker()
	addr2, server2, logs2 := h.serve()
	if status, _ := postMeta(t, addr2, body); status != http.StatusOK {
		t.Fatalf("reentrega = %d\n%s", status, logs2.String())
	}
	_ = server2.Process.Kill()
	_ = server2.Wait()
	if len(readSent(t, h.out)) != 2 || len(capture.all()) != 1 || countRows(t, `SELECT count(*) FROM webhook_inbox`) != 0 {
		t.Fatalf("reprocessamento repetiu efeito: envios=%v repasses=%d", readSent(t, h.out), len(capture.all()))
	}
	assertExactlyOnce(t, eventRows(t, testOrgA), "received|"+inboxCustomer, "sent|"+inboxCustomer)
}

func TestGivenProcessDiesAfterEventsWereRecorded_WhenAnotherReplicaTakesOver_ThenNothingIsDuplicatedOrLost(t *testing.T) {
	// Given: lease curto; a queda acontece com o evento gravado e os envios ainda por fazer
	fwd, capture := useForwardServer(t, http.StatusOK)
	h := newInboxHarness(t, fwd.URL)
	addr, server, logs := h.serve(inboxCrashEnv+"=done:"+stepEvents, inboxLeaseEnv+"=1s")

	// When
	status, _ := postMeta(t, addr, inboundFrom(testWabaA, testPhoneA, inboxCustomer, "wamid.CRASH-2"))
	assertCrashed(t, server, logs)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	held := countRows(t, `SELECT count(*) FROM webhook_inbox WHERE status = 'processing' AND steps->>'events' = 'done'`)
	time.Sleep(1200 * time.Millisecond)
	h.worker(inboxLeaseEnv + "=1s")

	// Then
	if held != 1 {
		t.Fatalf("a queda não deixou a linha em processamento com o evento gravado (%d)", held)
	}
	assertExactlyOnce(t, eventRows(t, testOrgA), "received|"+inboxCustomer, "sent|"+inboxCustomer)
	assertExactlyOnce(t, readSent(t, h.out), testPhoneA+"|"+inboxNotifyNumberA, testPhoneA+"|"+inboxCustomer)
	if len(capture.all()) != 1 || countRows(t, `SELECT count(*) FROM webhook_inbox`) != 0 {
		t.Fatalf("repasses=%d inbox=%d", len(capture.all()), countRows(t, `SELECT count(*) FROM webhook_inbox`))
	}
}

func TestGivenProcessDiesBetweenMarkingAndSendingTheReply_WhenRecovering_ThenReplyIsNotResent(t *testing.T) {
	// Given: a marca "started" da auto-resposta foi gravada; o envio não saiu (no máximo uma vez)
	fwd, capture := useForwardServer(t, http.StatusOK)
	h := newInboxHarness(t, fwd.URL)
	addr, server, logs := h.serve(inboxCrashEnv+"=started:reply:wamid.CRASH-3", inboxLeaseEnv+"=1s")

	// When
	postMeta(t, addr, inboundFrom(testWabaA, testPhoneA, inboxCustomer, "wamid.CRASH-3"))
	assertCrashed(t, server, logs)
	time.Sleep(1200 * time.Millisecond)
	out := h.worker(inboxLeaseEnv + "=1s")

	// Then: aviso uma vez, auto-resposta nenhuma (e o log diz por quê), evento e repasse uma vez
	assertExactlyOnce(t, readSent(t, h.out), testPhoneA+"|"+inboxNotifyNumberA)
	assertExactlyOnce(t, eventRows(t, testOrgA), "received|"+inboxCustomer)
	if !strings.Contains(out, "auto-reply interrompido numa tentativa anterior") {
		t.Fatalf("recuperação sem registro do efeito interrompido:\n%s", out)
	}
	if len(capture.all()) != 1 || countRows(t, `SELECT count(*) FROM webhook_inbox`) != 0 {
		t.Fatalf("repasses=%d inbox=%d", len(capture.all()), countRows(t, `SELECT count(*) FROM webhook_inbox`))
	}
}
