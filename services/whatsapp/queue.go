package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

type QueueItem struct {
	ID         int64      `json:"id"`
	AddedAt    time.Time  `json:"added_at"`
	Type       string     `json:"type"` // "text" | "template"
	To         string     `json:"to"`
	Name       string     `json:"name,omitempty"`
	Pedido     string     `json:"pedido,omitempty"` // ex: INK1802540
	Loja       string     `json:"loja,omitempty"`   // ex: Use Sul
	Message    string     `json:"message,omitempty"`
	Template   string     `json:"template,omitempty"`
	Language   string     `json:"language,omitempty"`
	Components []any      `json:"components,omitempty"`
	Status     string     `json:"status"` // "pending" | "sending" | "sent" | "error"
	SentAt     *time.Time `json:"sent_at,omitempty"`
	ErrorMsg   string     `json:"error,omitempty"`
	// SourceWamid identifica o wamid da Meta que originou esse item de retry (ver retry.go) — evita
	// duplicar o mesmo retry se o webhook de status "failed" chegar mais de uma vez. Persistido
	// junto do remetente e da Organization (WG-29): um item que sobrevive ao restart continua ligado
	// ao envio de origem, ao número que o enviou e ao tenant dono.
	SourceWamid string `json:"-"`
	// Remetente do item: número + referência assinada pelo painel (resolver.go). Nunca o token.
	// Fora do JSON: nem a listagem expõe, nem um corpo de requisição consegue preencher.
	Sender senderRef `json:"-"`
	// Organization e integração donas do item (Fase 5c), vindas do contexto da chamada.
	OrganizationID string `json:"-"`
	IntegrationID  string `json:"-"`
}

type QueueAddRequest struct {
	Type       string `json:"type"`
	To         string `json:"to"`
	Name       string `json:"name,omitempty"`
	Pedido     string `json:"pedido,omitempty"`
	Loja       string `json:"loja,omitempty"`
	Message    string `json:"message,omitempty"`
	Template   string `json:"template,omitempty"`
	Language   string `json:"language,omitempty"`
	Components []any  `json:"components,omitempty"`
	// Preenchidos pelo handler a partir do contexto validado da chamada — nunca do corpo.
	Sender         senderRef `json:"-"`
	OrganizationID string    `json:"-"`
	IntegrationID  string    `json:"-"`
}

type QueueSendRequest struct {
	IDs []int64 `json:"ids,omitempty"`
	All bool    `json:"all,omitempty"`
}

// ErrItemWithoutSender marca item enfileirado antes da Fase 5b: não há de onde tirar o remetente.
var ErrItemWithoutSender = errors.New("item sem remetente (enfileirado antes da Fase 5b) — enfileire de novo pelo painel")

var errQueueWithoutOrganization = errors.New("item de fila sem organization")

// queueRegistry mantém uma fila por Organization (INV-33). Com banco, o banco é a fonte da verdade
// (várias réplicas); a memória só é usada sem banco (dev/test).
type queueRegistry struct {
	mu     sync.Mutex
	queues map[string]*MsgQueue
}

var queues = &queueRegistry{queues: map[string]*MsgQueue{}}

func (r *queueRegistry) For(organizationID string) *MsgQueue {
	r.mu.Lock()
	defer r.mu.Unlock()
	q, ok := r.queues[organizationID]
	if !ok {
		q = &MsgQueue{organizationID: organizationID}
		r.queues[organizationID] = q
	}
	return q
}

type MsgQueue struct {
	organizationID string
	mu             sync.RWMutex
	items          []*QueueItem
	seq            atomic.Int64
}

// Lease do envio (TD-006). Identidade do processo para o lease — não é segredo.
var (
	queueLeaseTTL   = 2 * time.Minute
	queueClaimBatch = 50
	queueWorkerID   = newWorkerID()
	// afterQueueClaim existe só para o teste de queda no meio do envio.
	afterQueueClaim func([]*QueueItem)
)

func newWorkerID() string {
	host, _ := os.Hostname()
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	return fmt.Sprintf("%s:%d:%s", host, os.Getpid(), hex.EncodeToString(suffix))
}

// dedupKey retorna a chave usada para checagem de duplicados, dentro da fila da Organization.
// Para template: "remetente:to:template". Para texto: "remetente:to:hash(message)".
func dedupKey(r QueueAddRequest) string {
	if r.Type == "template" {
		return r.Sender.PhoneNumberID + ":" + r.To + ":" + r.Template
	}
	// Hash simples para texto (FNV-like, sem importar crypto)
	h := uint64(14695981039346656037)
	for _, c := range r.Message {
		h ^= uint64(c)
		h *= 1099511628211
	}
	return fmt.Sprintf("%s:%s:%x", r.Sender.PhoneNumberID, r.To, h)
}

func keyOf(it *QueueItem) string {
	return dedupKey(QueueAddRequest{Type: it.Type, To: it.To, Template: it.Template, Message: it.Message, Sender: it.Sender})
}

// All devolve a fila da Organization. Com banco, relida do banco (outra réplica pode ter mudado).
func (q *MsgQueue) All() []*QueueItem {
	if db != nil {
		return dbLoadQueue(q.organizationID)
	}
	q.mu.RLock()
	defer q.mu.RUnlock()
	out := make([]*QueueItem, len(q.items))
	for i, v := range q.items {
		cp := *v
		out[i] = &cp
	}
	return out
}

// isDuplicate verifica se já existe um item com a mesma chave — enviado, ainda pendente ou com
// erro (aguardando reenvio manual). Um job periódico que re-registra quem ainda não foi enviado
// não empilha cópias.
func (q *MsgQueue) isDuplicate(key string) bool {
	for _, it := range q.All() {
		if keyOf(it) == key {
			return true
		}
	}
	return false
}

func (q *MsgQueue) newItem(r QueueAddRequest, status string) (*QueueItem, error) {
	if r.OrganizationID != q.organizationID || !organizationIDPattern.MatchString(r.OrganizationID) {
		return nil, errQueueWithoutOrganization
	}
	return &QueueItem{
		AddedAt:        time.Now(),
		Type:           r.Type,
		To:             r.To,
		Name:           r.Name,
		Pedido:         r.Pedido,
		Loja:           r.Loja,
		Message:        r.Message,
		Template:       r.Template,
		Language:       r.Language,
		Components:     r.Components,
		Status:         status,
		Sender:         r.Sender,
		OrganizationID: r.OrganizationID,
		IntegrationID:  r.IntegrationID,
	}, nil
}

func (q *MsgQueue) store(item *QueueItem) error {
	if db != nil {
		id, err := dbInsertQueueItem(item)
		if err != nil {
			return err
		}
		item.ID = id
		return nil
	}
	item.ID = q.seq.Add(1)
	q.mu.Lock()
	q.items = append(q.items, item)
	q.mu.Unlock()
	return nil
}

func (q *MsgQueue) Add(r QueueAddRequest) (*QueueItem, bool, error) {
	if q.isDuplicate(dedupKey(r)) {
		return nil, true, nil
	}
	item, err := q.newItem(r, "pending")
	if err != nil {
		return nil, false, err
	}
	if err := q.store(item); err != nil {
		return nil, false, err
	}
	return item, false, nil
}

// AddRetry cria um item de fila já como "error", pronto pra reenvio pelo botão existente
// ("Reenviar erros") — usado quando um webhook de status "failed" da Meta chega pra uma
// mensagem cujo pedido original a gente ainda tem guardado (ver retry.go). Ignora o dedup por
// "sent" do Add normal de propósito: a mensagem original FOI enviada, só não foi entregue.
// `wamid` evita duplicar o mesmo retry se a Meta reenviar o mesmo webhook de status.
func (q *MsgQueue) AddRetry(r QueueAddRequest, wamid, errorMsg string) (*QueueItem, bool) {
	if wamid != "" {
		for _, it := range q.All() {
			if it.SourceWamid == wamid {
				return nil, true
			}
		}
	}
	item, err := q.newItem(r, "error")
	if err != nil {
		log.Printf("[queue] retry descartado: %v", err)
		return nil, false
	}
	item.ErrorMsg = errorMsg
	item.SourceWamid = wamid
	if err := q.store(item); err != nil {
		log.Printf("[queue] retry não gravado: %v", err)
		return nil, false
	}
	return item, false
}

// RemoveDuplicates limpa as cópias "pending"/"error" repetidas da fila da Organization e mantém só
// a mais recente de cada grupo. Não mexe em itens "sent".
func (q *MsgQueue) RemoveDuplicates() []int64 {
	all := q.All()
	best := map[string]*QueueItem{}
	for _, it := range all {
		if it.Status != "pending" && it.Status != "error" {
			continue
		}
		key := keyOf(it)
		if cur, ok := best[key]; !ok || it.AddedAt.After(cur.AddedAt) {
			best[key] = it
		}
	}
	var removedIDs []int64
	for _, it := range all {
		if (it.Status == "pending" || it.Status == "error") && best[keyOf(it)].ID != it.ID {
			removedIDs = append(removedIDs, it.ID)
		}
	}
	if len(removedIDs) > 0 {
		q.Remove(removedIDs)
	}
	return removedIDs
}

func (q *MsgQueue) Remove(ids []int64) int {
	if db != nil {
		before := len(dbLoadQueue(q.organizationID))
		dbDeleteQueueItems(q.organizationID, ids)
		return before - len(dbLoadQueue(q.organizationID))
	}
	set := make(map[int64]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	before := len(q.items)
	kept := q.items[:0]
	for _, it := range q.items {
		if !set[it.ID] {
			kept = append(kept, it)
		}
	}
	q.items = kept
	return before - len(kept)
}

func (q *MsgQueue) PendingCount() int {
	n := 0
	for _, it := range q.All() {
		if it.Status == "pending" {
			n++
		}
	}
	return n
}

// Send envia os itens especificados, ou só os "pending" se ids==nil (botão "Enviar Todos
// Pendentes" — nunca arrasta item "error": reenviar erro é ação separada, com IDs explícitos).
// Erro de banco (lease) volta como erro, não como "zero enviados" (INV-38).
func (q *MsgQueue) Send(ids []int64) (sent int, errs int, err error) {
	statuses := []string{"pending", "error"}
	if ids == nil {
		statuses = []string{"pending"}
	}
	senders := senderCache{}
	if db != nil {
		return q.sendWithLease(ids, statuses, senders)
	}
	sent, errs = q.sendInMemory(ids, statuses, senders)
	return sent, errs, nil
}

func (q *MsgQueue) sendWithLease(ids []int64, statuses []string, senders senderCache) (sent int, errs int, err error) {
	if err := dbRecoverExpiredQueue(q.organizationID); err != nil {
		return 0, 0, fmt.Errorf("recuperação de lease: %w", err)
	}
	for {
		claimed, err := dbClaimQueueItems(q.organizationID, ids, statuses, queueWorkerID, queueLeaseTTL, queueClaimBatch)
		if err != nil {
			return sent, errs, fmt.Errorf("lease: %w", err)
		}
		if len(claimed) == 0 {
			return sent, errs, nil
		}
		if afterQueueClaim != nil {
			afterQueueClaim(claimed)
		}
		for _, item := range claimed {
			if q.finish(item, dispatchItem(item, senders)) {
				sent++
			} else {
				errs++
			}
			dbFinishQueueItem(item, queueWorkerID)
		}
		if ids != nil {
			return sent, errs, nil
		}
	}
}

func (q *MsgQueue) sendInMemory(ids []int64, statuses []string, senders senderCache) (sent int, errs int) {
	allowed := map[string]bool{}
	for _, s := range statuses {
		allowed[s] = true
	}
	wanted := map[int64]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	q.mu.Lock()
	var targets []*QueueItem
	for _, it := range q.items {
		if allowed[it.Status] && (ids == nil || wanted[it.ID]) {
			it.Status = "sending"
			it.ErrorMsg = ""
			targets = append(targets, it)
		}
	}
	q.mu.Unlock()
	for _, item := range targets {
		err := dispatchItem(item, senders)
		q.mu.Lock()
		ok := q.finish(item, err)
		q.mu.Unlock()
		if ok {
			sent++
		} else {
			errs++
		}
	}
	return
}

// finish aplica o resultado do envio ao item e registra o evento na Organization dele.
func (q *MsgQueue) finish(item *QueueItem, err error) bool {
	now := time.Now()
	if err != nil {
		item.Status = "error"
		item.ErrorMsg = err.Error()
		events.Push(Event{Time: now, Kind: KindError, Phone: item.To, Name: item.Name, Origem: "fila",
			Message: labelFor(item), Extra: err.Error(), OrganizationID: item.OrganizationID})
		return false
	}
	item.Status = "sent"
	item.SentAt = &now
	events.Push(Event{Time: now, Kind: KindSent, Phone: item.To, Name: item.Name, Origem: "fila",
		Message: labelFor(item), OrganizationID: item.OrganizationID})
	return true
}

func labelFor(item *QueueItem) string {
	if item.Type == "template" {
		return "Template: " + item.Template
	}
	return truncate(item.Message, 100)
}

// itemSender devolve o remetente de um item persistido: pela referência, resolvida no painel.
func itemSender(item *QueueItem, senders senderCache) (metaIdentity, error) {
	if item.Sender.empty() {
		return metaIdentity{}, ErrItemWithoutSender
	}
	return senders.resolve(item.Sender)
}

func dispatchItem(item *QueueItem, senders senderCache) error {
	var payload map[string]any
	switch item.Type {
	case "text":
		payload = map[string]any{
			"messaging_product": "whatsapp",
			"recipient_type":    "individual",
			"to":                item.To,
			"type":              "text",
			"text":              map[string]any{"preview_url": false, "body": item.Message},
		}
	case "template":
		// Só completa idioma AUSENTE (WG-25): um idioma explícito do chamador, inclusive "en",
		// é respeitado.
		lang := item.Language
		if lang == "" {
			lang = "pt_BR"
		}
		tmpl := map[string]any{
			"name":     item.Template,
			"language": map[string]string{"code": lang},
		}
		if len(item.Components) > 0 {
			tmpl["components"] = item.Components
		}
		payload = map[string]any{
			"messaging_product": "whatsapp",
			"to":                item.To,
			"type":              "template",
			"template":          tmpl,
		}
	default:
		return fmt.Errorf("tipo desconhecido: %s", item.Type)
	}
	id, err := itemSender(item, senders)
	if err != nil {
		log.Printf("[queue] dispatch sem remetente id=%d to=%s: %v", item.ID, item.To, err)
		return err
	}
	data, err := metaPost(id, payload)
	if err != nil {
		log.Printf("[queue] dispatch erro id=%d to=%s: %v", item.ID, item.To, err)
		return err
	}
	if item.Type == "template" {
		registrarParaRetry(extrairWamid(data), QueueAddRequest{
			Type: item.Type, To: item.To, Name: item.Name, Pedido: item.Pedido, Loja: item.Loja,
			Template: item.Template, Language: item.Language, Components: item.Components,
			Sender: item.Sender, OrganizationID: item.OrganizationID, IntegrationID: item.IntegrationID,
		})
	}
	return nil
}
