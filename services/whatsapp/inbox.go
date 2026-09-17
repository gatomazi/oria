package main

import (
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"
)

// Aceite durável do webhook da Meta (rodada 18, §23/§24).
//
// Com banco, "200" significa "evento duravelmente aceito": a change com dono e com evento novo já
// está na tabela webhook_inbox, gravada na mesma transação da idempotência (db.go). Os efeitos saem
// depois, por um worker com lease, e cada passo concluído fica registrado em `steps`. Se o processo
// cair depois do 200, outra réplica (ou o mesmo serviço depois do restart) pega a linha quando o
// lease vence e continua de onde parou.
//
// Garantia por efeito (o que um reprocessamento faz):
//
//	eventos do dashboard (recebida, falha de entrega, auto-resposta enviada)
//	        exatamente uma vez — gravados na mesma transação que marca o passo
//	retry de status "failed"
//	        exatamente uma vez — a fila deduplica por (Organization, wamid de origem)
//	repasse ao painel
//	        pelo menos uma vez — o passo só é marcado depois do 2xx; uma queda entre o 2xx e a marca
//	        repete o repasse. O painel é idempotente para status (só avança).
//	aviso ao dono e auto-resposta (envios à Meta)
//	        no máximo uma vez — o passo é marcado "started" ANTES do envio. A Meta não tem chave de
//	        idempotência: se a queda for entre a marca e o envio, o envio não é repetido (log
//	        "interrompido"), a mesma política da fila (lease vencido não é reenviado).
//
// Sem banco (dev/test) não há durabilidade: os efeitos rodam em goroutine logo depois do 200, como
// antes. Produção exige banco (env.go).
const (
	stepEvents  = "events"
	stepForward = "forward"

	stepStarted = "started"
	stepDone    = "done"
)

var (
	inboxLeaseTTL     = 2 * time.Minute
	inboxClaimBatch   = 20
	inboxPollInterval = 2 * time.Second
	inboxMaxAttempts  = 8
	inboxMaxBackoff   = 5 * time.Minute
	inboxWorkerID     = newWorkerID()

	// inboxHook existe só para os testes de queda (processo filho): é chamado em cada fronteira de
	// passo ("accepted", "begin:<passo>", "started:<passo>", "done:<passo>").
	inboxHook func(point string)
)

func inboxCheckpoint(point string) {
	if inboxHook != nil {
		inboxHook(point)
	}
}

// storedTenant é o contexto resolvido no aceite, guardado com a linha — sem token (só a referência
// assinada, como a fila). Um reprocessamento não depende do painel responder o contexto de novo; o
// envio continua conferido na hora pelo /sender, que recusa integração trocada.
type storedTenant struct {
	OrganizationID  string `json:"organization_id"`
	IntegrationID   string `json:"integration_id"`
	PhoneNumberID   string `json:"phone_number_id"`
	WabaID          string `json:"waba_id"`
	SenderRef       string `json:"sender_ref"`
	RedirectMessage string `json:"redirect_message"`
	NotifyNumber    string `json:"notify_number"`
}

func storedTenantOf(tc tenantContext) storedTenant {
	return storedTenant{OrganizationID: tc.OrganizationID, IntegrationID: tc.IntegrationID, PhoneNumberID: tc.PhoneNumberID,
		WabaID: tc.WabaID, SenderRef: tc.SenderRef, RedirectMessage: tc.Reply.RedirectMessage, NotifyNumber: tc.Reply.NotifyNumber}
}

func (s storedTenant) context() tenantContext {
	return tenantContext{OrganizationID: s.OrganizationID, IntegrationID: s.IntegrationID, PhoneNumberID: s.PhoneNumberID,
		WabaID: s.WabaID, SenderRef: s.SenderRef, Reply: replyConfig{RedirectMessage: s.RedirectMessage, NotifyNumber: s.NotifyNumber}}
}

type inboxItem struct {
	ID             int64
	OrganizationID string
	Tenant         tenantContext
	WabaID         string
	Object         string
	Raw            string
	EventKeys      []string
	Steps          map[string]string
	Attempts       int
}

// routed reconstrói a change com dono, só com os eventos que eram novos no aceite.
func (it *inboxItem) routed() (routedChange, error) {
	if it.Tenant.OrganizationID != it.OrganizationID {
		return routedChange{}, errors.New("contexto guardado de outra organization")
	}
	if err := it.Tenant.validate(); err != nil {
		return routedChange{}, errors.New("contexto guardado inválido: " + err.Error())
	}
	raw := json.RawMessage(it.Raw)
	var ch InboundChange
	if err := json.Unmarshal(raw, &ch); err != nil {
		return routedChange{}, errors.New("change guardada ilegível")
	}
	rc := routedChange{tenant: it.Tenant, wabaID: it.WabaID, raw: raw, change: ch, keys: changeKeys(it.OrganizationID, raw, ch)}
	fresh := map[webhookEventKey]bool{}
	for _, k := range it.EventKeys {
		fresh[webhookEventKey{it.OrganizationID, k}] = true
	}
	kept := keepFresh([]routedChange{rc}, fresh)
	if len(kept) == 0 {
		return routedChange{}, errors.New("change guardada sem evento novo")
	}
	return kept[0], nil
}

// effectLedger é onde os efeitos registram o próprio progresso.
type effectLedger interface {
	state(step string) string
	// begin marca um efeito no-máximo-uma-vez antes de ele acontecer.
	begin(step string) error
	// done marca o passo concluído e grava os eventos que ele produziu, atomicamente.
	done(step string, evs []Event) error
}

// memoryLedger: sem banco, nada é lembrado entre tentativas (não há tentativas).
type memoryLedger struct{}

func (memoryLedger) state(string) string { return "" }
func (memoryLedger) begin(string) error  { return nil }
func (memoryLedger) done(_ string, evs []Event) error {
	for _, e := range evs {
		events.Push(e)
	}
	return nil
}

type inboxLedger struct {
	item  *inboxItem
	owner string
}

func (l *inboxLedger) state(step string) string { return l.item.Steps[step] }

func (l *inboxLedger) begin(step string) error {
	inboxCheckpoint("begin:" + step)
	if err := dbMarkInboxStep(l.item, l.owner, step, stepStarted, nil); err != nil {
		return err
	}
	l.item.Steps[step] = stepStarted
	inboxCheckpoint("started:" + step)
	return nil
}

func (l *inboxLedger) done(step string, evs []Event) error {
	// Carrega o buffer da Organization ANTES de gravar: assim a carga do banco não traz de novo o
	// evento que vai ser acrescentado à memória logo abaixo.
	store := events.For(l.item.OrganizationID)
	if err := dbMarkInboxStep(l.item, l.owner, step, stepDone, evs); err != nil {
		return err
	}
	l.item.Steps[step] = stepDone
	for _, e := range evs {
		e.ID = eventSequence.Add(1)
		store.add(e)
	}
	inboxCheckpoint("done:" + step)
	return nil
}

var startInboxOnce sync.Once

// startInboxWorker roda, enquanto o processo viver, a drenagem periódica da inbox. Sem banco não faz
// nada. Várias réplicas podem rodar juntas: o lease (FOR UPDATE SKIP LOCKED) separa as linhas. O
// aceite já dispara a drenagem das próprias linhas (webhook.go); esta volta pega o resto (novas
// tentativas e linhas de uma réplica que caiu).
func startInboxWorker() {
	if db == nil {
		return
	}
	startInboxOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(inboxPollInterval)
			defer ticker.Stop()
			for {
				drainInbox(nil)
				<-ticker.C
			}
		}()
	})
}

// drainInbox processa as linhas vencidas (ou só as de ids, quando dado) até não sobrar nenhuma
// disponível. Devolve quantas linhas foram pegas.
func drainInbox(ids []int64) int {
	total := 0
	for {
		items, err := dbClaimInbox(ids, inboxWorkerID, inboxLeaseTTL, inboxClaimBatch)
		if err != nil {
			log.Printf("[inbox] claim: %v", err)
			return total
		}
		if len(items) == 0 {
			return total
		}
		total += len(items)
		for _, it := range items {
			processInboxItem(it, inboxWorkerID)
		}
		if ids != nil {
			return total
		}
	}
}

func processInboxItem(it *inboxItem, owner string) {
	err := runInboxItem(it, owner)
	if err == nil {
		if ferr := dbFinishInbox(it, owner); ferr != nil {
			// A linha fica 'processing' até o lease vencer; os passos já estão marcados, então a
			// próxima tentativa só a apaga.
			log.Printf("[inbox] concluir id=%d org=%s: %v", it.ID, it.OrganizationID, ferr)
		}
		return
	}
	if errors.Is(err, errInboxLeaseLost) {
		log.Printf("[inbox] id=%d org=%s: lease perdido — outra réplica continua", it.ID, it.OrganizationID)
		return
	}
	failed := it.Attempts >= inboxMaxAttempts
	backoff := time.Duration(1<<min(it.Attempts, 16)) * time.Second
	if backoff > inboxMaxBackoff {
		backoff = inboxMaxBackoff
	}
	reason := truncate(err.Error(), 300)
	if rerr := dbRetryInbox(it, owner, backoff, failed, reason); rerr != nil {
		log.Printf("[inbox] reagendar id=%d org=%s: %v", it.ID, it.OrganizationID, rerr)
	}
	if failed {
		log.Printf("[inbox] id=%d org=%s FALHOU após %d tentativas: %s", it.ID, it.OrganizationID, it.Attempts, reason)
		return
	}
	log.Printf("[inbox] id=%d org=%s tentativa %d falhou (%s) — nova tentativa em %s", it.ID, it.OrganizationID, it.Attempts, reason, backoff)
}

func runInboxItem(it *inboxItem, owner string) error {
	rc, err := it.routed()
	if err != nil {
		// Linha que não dá para reconstruir não melhora com o tempo: falha visível, sem efeito.
		it.Attempts = inboxMaxAttempts
		return err
	}
	ledger := &inboxLedger{item: it, owner: owner}
	if err := processChange(rc, ledger); err != nil {
		return err
	}
	if cfg.ForwardURL == "" || ledger.state(stepForward) == stepDone {
		return nil
	}
	if err := sendForward(forwardBody(it.Object, []routedChange{rc})); err != nil {
		return err
	}
	return ledger.done(stepForward, nil)
}
