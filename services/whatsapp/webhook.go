package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Entrada multi-tenant (Fase 5c). Ordem obrigatória num POST da Meta:
//
//  1. corpo cru
//  2. HMAC com o App Secret da PLATAFORMA — sem ele: 403, nenhum lookup, nenhuma escrita
//  3. parse; object == whatsapp_business_account
//  4. para CADA change de CADA entry: WABA (entry.id) + número (metadata.phone_number_id)
//  5. Organization pelo painel (inbound-context); desconhecido/divergente = change descartada
//  6. idempotência por (Organization, evento) e, com banco, a change gravada na inbox — na mesma
//     transação, antes de qualquer efeito (inbox.go)
//  7. 200 para a Meta — com banco, significa "aceito de forma durável"
//  8. efeitos (eventos, retry, aviso, auto-resposta, repasse), cada um no escopo da sua change; com
//     banco, pelo worker da inbox, com passos registrados e nova tentativa
//
// Painel indisponível ou banco fora no passo 5/6: 503 sem nenhum efeito, e a Meta reentrega.

// Controle anti-spam da auto-resposta: último envio por (Organization, telefone) — o cooldown de A
// nunca suprime a resposta de B para o mesmo cliente (INV-33).
type replyKey struct {
	OrganizationID string
	Phone          string
}

var (
	replyMu     sync.Mutex
	lastReplyAt = map[replyKey]time.Time{}
)

// maybeAutoReply envia (no máximo 1x por cooldown) o texto configurado pela Organization para quem
// respondeu. Sai pelo número que recebeu a mensagem, com o token que o painel resolver para a
// referência do contexto — funciona no primeiro evento depois de um restart.
//
// Erro devolvido = nada foi enviado e vale tentar de novo (painel indisponível ou banco). Recusa
// definitiva do remetente e erro da Meta só vão para o log.
func maybeAutoReply(tc tenantContext, to, step string, ledger effectLedger) error {
	if tc.Reply.RedirectMessage == "" {
		return nil
	}
	if st := ledger.state(step); st != "" {
		if st == stepStarted {
			log.Printf("[webhook] auto-reply interrompido numa tentativa anterior — não repetido org=%s to=%s", tc.OrganizationID, to)
		}
		return nil
	}

	key := replyKey{OrganizationID: tc.OrganizationID, Phone: to}
	inCooldown := func(now time.Time) bool {
		last, ok := lastReplyAt[key]
		return ok && now.Sub(last) < cfg.ReplyCooldown
	}
	replyMu.Lock()
	cooling := inCooldown(time.Now())
	replyMu.Unlock()
	if cooling {
		return nil
	}

	id, err := replySender(tc)
	if err != nil {
		if errors.Is(err, ErrSenderUnavailable) {
			return fmt.Errorf("auto-resposta: %w", err)
		}
		log.Printf("[webhook] auto-reply ignorado org=%s to=%s: %v", tc.OrganizationID, to, err)
		return nil
	}

	replyMu.Lock()
	now := time.Now()
	if inCooldown(now) {
		replyMu.Unlock()
		return nil
	}
	previous, hadPrevious := lastReplyAt[key]
	lastReplyAt[key] = now
	replyMu.Unlock()

	if err := ledger.begin(step); err != nil {
		// Nada saiu: devolve o cooldown para a próxima tentativa poder responder.
		replyMu.Lock()
		if hadPrevious {
			lastReplyAt[key] = previous
		} else {
			delete(lastReplyAt, key)
		}
		replyMu.Unlock()
		return err
	}
	if err := sendText(id, to, tc.Reply.RedirectMessage); err != nil {
		log.Printf("[webhook] auto-reply erro org=%s to=%s: %v", tc.OrganizationID, to, err)
		return ledger.done(step, nil)
	}
	log.Printf("[webhook] auto-reply enviado org=%s to=%s", tc.OrganizationID, to)
	return ledger.done(step, []Event{{Time: time.Now(), Kind: KindSent, Phone: to, Origem: "auto-resposta",
		Message: truncate(tc.Reply.RedirectMessage, 120), OrganizationID: tc.OrganizationID}})
}

func extractMsgText(msg InboundMessage) string {
	switch msg.Type {
	case "text":
		if msg.Text != nil {
			return msg.Text.Body
		}
	case "image":
		if msg.Image != nil && msg.Image.Caption != "" {
			return "🖼 " + msg.Image.Caption
		}
		return "🖼 [imagem]"
	case "audio":
		return "🎵 [áudio]"
	case "video":
		if msg.Video != nil && msg.Video.Caption != "" {
			return "🎥 " + msg.Video.Caption
		}
		return "🎥 [vídeo]"
	case "document":
		if msg.Document != nil && msg.Document.Filename != "" {
			return "📄 " + msg.Document.Filename
		}
		return "📄 [documento]"
	case "sticker":
		return "🎯 [sticker]"
	case "interactive":
		if msg.Interactive != nil {
			if msg.Interactive.ButtonReply != nil {
				return "🔘 " + msg.Interactive.ButtonReply.Title
			}
			if msg.Interactive.ListReply != nil {
				return "📋 " + msg.Interactive.ListReply.Title
			}
		}
	}
	return "[" + msg.Type + "]"
}

// notifyOwner encaminha a mensagem do cliente para o número de aviso da Organization, pelo número
// que recebeu a mensagem. Mesma política de erro de maybeAutoReply.
func notifyOwner(tc tenantContext, msg InboundMessage, name, step string, ledger effectLedger) error {
	if tc.Reply.NotifyNumber == "" {
		return nil
	}
	if st := ledger.state(step); st != "" {
		if st == stepStarted {
			log.Printf("[webhook] notify-owner interrompido numa tentativa anterior — não repetido org=%s", tc.OrganizationID)
		}
		return nil
	}

	conteudo := extractMsgText(msg)
	notif := fmt.Sprintf("📨 *Resposta de cliente*\nDe: +%s (%s)\nMensagem: %s", msg.From, name, conteudo)

	id, err := replySender(tc)
	if err != nil {
		if errors.Is(err, ErrSenderUnavailable) {
			return fmt.Errorf("aviso ao dono: %w", err)
		}
		log.Printf("[webhook] notify-owner ignorado org=%s: %v", tc.OrganizationID, err)
		return nil
	}
	if err := ledger.begin(step); err != nil {
		return err
	}
	if err := sendText(id, tc.Reply.NotifyNumber, notif); err != nil {
		log.Printf("[webhook] notify-owner erro org=%s: %v", tc.OrganizationID, err)
		return ledger.done(step, nil)
	}
	log.Printf("[webhook] notify-owner enviado org=%s from=%s", tc.OrganizationID, msg.From)
	return ledger.done(step, nil)
}

func handleWebhook(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		verifyWebhook(w, r)
	case http.MethodPost:
		receiveWebhook(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func verifyWebhook(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("hub.mode")
	token := r.URL.Query().Get("hub.verify_token")
	challenge := r.URL.Query().Get("hub.challenge")

	// Comparação em tempo constante, como a da assinatura logo abaixo: `token == cfg.VerifyToken`
	// termina no primeiro byte diferente. E verify token vazio não valida ninguém.
	if mode == "subscribe" && cfg.VerifyToken != "" &&
		subtle.ConstantTimeCompare([]byte(token), []byte(cfg.VerifyToken)) == 1 {
		log.Println("[webhook] verificado com sucesso")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(challenge))
		return
	}

	log.Printf("[webhook] falha na verificação: mode=%s", mode)
	http.Error(w, "forbidden", http.StatusForbidden)
}

// Formato cru do payload: as changes ficam como vieram, para o repasse levar só as roteadas.
type rawWebhookPayload struct {
	Object string            `json:"object"`
	Entry  []rawWebhookEntry `json:"entry"`
}

type rawWebhookEntry struct {
	ID      string            `json:"id"`
	Changes []json.RawMessage `json:"changes"`
}

// webhookEventKey identifica um evento para idempotência: sempre com a Organization (INV-16/34).
type webhookEventKey struct {
	OrganizationID string
	Key            string
}

// routedChange é uma change com dono resolvido.
type routedChange struct {
	tenant tenantContext
	wabaID string
	raw    json.RawMessage
	change InboundChange
	keys   []webhookEventKey
}

func changeKeys(orgID string, raw json.RawMessage, ch InboundChange) []webhookEventKey {
	var keys []webhookEventKey
	if ch.Field == "messages" {
		for _, m := range ch.Value.Messages {
			if m.ID != "" {
				keys = append(keys, webhookEventKey{orgID, "message:" + m.ID})
			}
		}
		for _, s := range ch.Value.Statuses {
			if s.ID != "" {
				keys = append(keys, webhookEventKey{orgID, "status:" + s.ID + ":" + s.Status})
			}
		}
	}
	if len(keys) == 0 {
		sum := sha256.Sum256(raw)
		keys = append(keys, webhookEventKey{orgID, "change:" + hex.EncodeToString(sum[:])})
	}
	return keys
}

// errWebhookRetry: nada foi feito e a Meta deve reentregar.
type errWebhookRetry struct{ reason string }

func (e errWebhookRetry) Error() string { return e.reason }

// routeWebhook resolve o dono de cada change. Não produz efeito nenhum.
func routeWebhook(payload rawWebhookPayload) ([]routedChange, error) {
	var routed []routedChange
	for _, entry := range payload.Entry {
		for _, raw := range entry.Changes {
			var ch InboundChange
			if err := json.Unmarshal(raw, &ch); err != nil {
				log.Printf("[webhook] change ilegível descartada (waba=%s)", entry.ID)
				continue
			}
			if entry.ID == "" {
				log.Printf("[webhook] change sem WABA descartada (field=%s)", ch.Field)
				continue
			}
			tc, err := inboundTenant(entry.ID, ch.Value.Metadata.PhoneNumberID)
			switch {
			case err == nil:
				routed = append(routed, routedChange{tenant: tc, wabaID: entry.ID, raw: raw, change: ch,
					keys: changeKeys(tc.OrganizationID, raw, ch)})
			case dropWithoutEffect(err):
				log.Printf("[webhook] change sem dono descartada waba=%s phone_number_id=%s: %v",
					entry.ID, ch.Value.Metadata.PhoneNumberID, err)
			default:
				return nil, errWebhookRetry{"contexto de tenant indisponível: " + err.Error()}
			}
		}
	}
	return routed, nil
}

// Idempotência sem banco (dev/test): conjunto limitado em memória, com a Organization na chave.
var memoryWebhookKeys = struct {
	mu    sync.Mutex
	seen  map[webhookEventKey]bool
	order []webhookEventKey
}{seen: map[webhookEventKey]bool{}}

const maxMemoryWebhookKeys = 10000

func claimWebhookEvents(keys []webhookEventKey) (map[webhookEventKey]bool, error) {
	if db != nil {
		fresh, err := dbClaimWebhookEvents(keys)
		if err != nil {
			return nil, errWebhookRetry{"idempotência indisponível: " + err.Error()}
		}
		pruneWebhookEventsOccasionally()
		return fresh, nil
	}
	memoryWebhookKeys.mu.Lock()
	defer memoryWebhookKeys.mu.Unlock()
	fresh := make(map[webhookEventKey]bool, len(keys))
	for _, k := range keys {
		if memoryWebhookKeys.seen[k] {
			fresh[k] = false
			continue
		}
		fresh[k] = true
		memoryWebhookKeys.seen[k] = true
		memoryWebhookKeys.order = append(memoryWebhookKeys.order, k)
		if len(memoryWebhookKeys.order) > maxMemoryWebhookKeys {
			delete(memoryWebhookKeys.seen, memoryWebhookKeys.order[0])
			memoryWebhookKeys.order = memoryWebhookKeys.order[1:]
		}
	}
	return fresh, nil
}

var lastWebhookPrune atomic.Int64

func pruneWebhookEventsOccasionally() {
	now := time.Now().Unix()
	last := lastWebhookPrune.Load()
	if now-last < 3600 || !lastWebhookPrune.CompareAndSwap(last, now) {
		return
	}
	go dbPruneWebhookEvents(7 * 24 * time.Hour)
}

func receiveWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if !validWebhookSignature(r.Header.Get("X-Hub-Signature-256"), body) {
		log.Printf("[webhook] assinatura inválida ou app secret não configurado — payload descartado")
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	var payload rawWebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		log.Printf("[webhook] json inválido: %v", err)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if payload.Object != "whatsapp_business_account" {
		writeReceived(w)
		return
	}

	routed, err := routeWebhook(payload)
	var accepted []int64
	if err == nil && len(routed) > 0 {
		if db != nil {
			// Aceite durável: idempotência + inbox numa transação, antes do 200.
			accepted, err = dbAcceptWebhook(payload.Object, routed)
			if err != nil {
				err = errWebhookRetry{"aceite durável indisponível: " + err.Error()}
			}
			routed = nil
		} else {
			var fresh map[webhookEventKey]bool
			var keys []webhookEventKey
			for _, rc := range routed {
				keys = append(keys, rc.keys...)
			}
			fresh, err = claimWebhookEvents(keys)
			if err == nil {
				routed = keepFresh(routed, fresh)
			}
		}
	}
	if err != nil {
		log.Printf("[webhook] %v — 503, sem efeito, a Meta reentrega", err)
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}

	// Meta exige 200 rápido; os efeitos vêm depois, cada um no escopo da sua change.
	writeReceived(w)
	if len(accepted) > 0 {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		inboxCheckpoint("accepted")
		pruneWebhookEventsOccasionally()
		webhookWork.Add(1)
		go func() {
			defer webhookWork.Done()
			drainInbox(accepted)
		}()
		return
	}
	if len(routed) > 0 {
		webhookWork.Add(1)
		go func() {
			defer webhookWork.Done()
			processRouted(payload.Object, routed)
		}()
	}
}

// webhookWork conta o processamento em andamento (espera em shutdown e em teste).
var webhookWork sync.WaitGroup

var receivedBody = []byte(`{"status":"received"}`)

func writeReceived(w http.ResponseWriter) {
	// Content-Length explícito: a resposta fica completa no Flush, antes de qualquer efeito.
	w.Header().Set("Content-Length", strconv.Itoa(len(receivedBody)))
	w.WriteHeader(http.StatusOK)
	w.Write(receivedBody)
}

// keepFresh tira de cada change os eventos já processados; change sem evento novo sai inteira.
func keepFresh(routed []routedChange, fresh map[webhookEventKey]bool) []routedChange {
	out := routed[:0]
	for _, rc := range routed {
		isFresh := func(key string) bool { return fresh[webhookEventKey{rc.tenant.OrganizationID, key}] }
		anyFresh := false
		for _, k := range rc.keys {
			if fresh[k] {
				anyFresh = true
			}
		}
		if !anyFresh {
			continue
		}
		msgs := rc.change.Value.Messages[:0]
		for _, m := range rc.change.Value.Messages {
			if isFresh("message:" + m.ID) {
				msgs = append(msgs, m)
			}
		}
		rc.change.Value.Messages = msgs
		sts := rc.change.Value.Statuses[:0]
		for _, s := range rc.change.Value.Statuses {
			if isFresh("status:" + s.ID + ":" + s.Status) {
				sts = append(sts, s)
			}
		}
		rc.change.Value.Statuses = sts
		out = append(out, rc)
	}
	return out
}

// validWebhookSignature confere o HMAC-SHA256 da Meta sobre o corpo CRU da requisição, em tempo
// constante.
//
// A verificação nunca é opcional. Sem segredo resolvido não há como atribuir origem ao payload,
// então a única resposta correta é recusar. O segredo é do App da PLATAFORMA (PD-023): ele prova
// que o evento veio da Meta — nunca escolhe a Organization.
func validWebhookSignature(header string, body []byte) bool {
	if cfg.AppSecret == "" {
		return false
	}
	sig := strings.TrimPrefix(header, "sha256=")
	mac := hmac.New(sha256.New, []byte(cfg.AppSecret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(sig), []byte(expected))
}

// processRouted roda os efeitos sem banco (dev/test): sem registro de passos e sem nova tentativa.
func processRouted(object string, routed []routedChange) {
	for _, rc := range routed {
		if err := processChange(rc, memoryLedger{}); err != nil {
			log.Printf("[webhook] efeito não concluído org=%s: %v", rc.tenant.OrganizationID, err)
		}
	}
	if len(routed) > 0 {
		if err := sendForward(forwardBody(object, routed)); err != nil {
			log.Printf("[webhook] forward: %v", err)
			return
		}
		if cfg.ForwardURL != "" {
			log.Printf("[webhook] forward ok changes=%d", len(routed))
		}
	}
}

// processChange produz os efeitos de uma change, no escopo da Organization dela. Erro devolvido =
// algum efeito ficou para uma nova tentativa (os concluídos estão no ledger).
func processChange(rc routedChange, ledger effectLedger) error {
	tc := rc.tenant
	if rc.change.Field != "messages" {
		return nil
	}
	v := rc.change.Value

	contactNames := make(map[string]string)
	for _, c := range v.Contacts {
		contactNames[c.WaID] = c.Profile.Name
	}
	nameOf := func(from string) string {
		if name := contactNames[from]; name != "" {
			return name
		}
		return from
	}

	if ledger.state(stepEvents) != stepDone {
		var evs []Event
		for _, s := range v.Statuses {
			log.Printf("[webhook] status org=%s id=%s status=%s recipient=%s", tc.OrganizationID, s.ID, s.Status, s.RecipientID)

			// "sent" no dashboard só significa que a Meta aceitou a chamada da API — a entrega de
			// verdade (ou falha) só chega depois, por aqui.
			if s.Status != "failed" {
				continue
			}
			motivo := "Meta não informou o motivo nesse webhook"
			if len(s.Errors) > 0 {
				e := s.Errors[0]
				motivo = fmt.Sprintf("(%d) %s", e.Code, e.Title)
				if e.Message != "" {
					motivo += " — " + e.Message
				}
				if e.ErrorData.Details != "" {
					motivo += " (" + e.ErrorData.Details + ")"
				}
			} else {
				log.Printf("[webhook] status failed sem detalhe de erro org=%s id=%s", tc.OrganizationID, s.ID)
			}
			// O pedido original é procurado só na Organization dona do evento. A fila deduplica por
			// wamid de origem, então uma nova tentativa não cria outro item.
			if req, achou := buscarParaRetry(tc.OrganizationID, s.ID); achou {
				item, dup := queues.For(tc.OrganizationID).AddRetry(req, s.ID, motivo)
				switch {
				case item != nil:
					motivo += " — adicionado à fila pra reenvio"
				case !dup:
					return fmt.Errorf("retry de %s não gravado", s.ID)
				}
			}

			evs = append(evs, Event{
				Time:           time.Now(),
				Kind:           KindError,
				Phone:          s.RecipientID,
				Message:        "Falha na entrega (id " + s.ID + ")",
				Extra:          motivo,
				OrganizationID: tc.OrganizationID,
			})
		}
		for _, msg := range v.Messages {
			log.Printf("[webhook] mensagem org=%s de=%s tipo=%s", tc.OrganizationID, msg.From, msg.Type)
			evs = append(evs, Event{
				Time:           time.Now(),
				Kind:           KindReceived,
				Phone:          msg.From,
				Name:           nameOf(msg.From),
				Message:        truncate(extractMsgText(msg), 120),
				OrganizationID: tc.OrganizationID,
			})
		}
		if err := ledger.done(stepEvents, evs); err != nil {
			return err
		}
	}

	for _, msg := range v.Messages {
		// Reação (❤️/👍 etc) não é uma resposta de verdade — não justifica gastar mensagem.
		if msg.Type == "reaction" {
			continue
		}
		if err := notifyOwner(tc, msg, nameOf(msg.From), "notify:"+msg.ID, ledger); err != nil {
			return err
		}
		if err := maybeAutoReply(tc, msg.From, "reply:"+msg.ID, ledger); err != nil {
			return err
		}
	}
	return nil
}

// forwardBody monta o corpo do repasse: só as changes com dono e com evento novo, agrupadas por
// WABA, no formato do webhook da Meta.
func forwardBody(object string, routed []routedChange) []byte {
	var entries []map[string]any
	index := map[string]int{}
	for _, rc := range routed {
		i, ok := index[rc.wabaID]
		if !ok {
			i = len(entries)
			index[rc.wabaID] = i
			entries = append(entries, map[string]any{"id": rc.wabaID, "changes": []json.RawMessage{}})
		}
		entries[i]["changes"] = append(entries[i]["changes"].([]json.RawMessage), rc.raw)
	}
	body, _ := json.Marshal(map[string]any{"object": object, "entry": entries})
	return body
}
