package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 10 * time.Second}

// sendPacer espaça os envios à Meta (ver pacer.go) — inicializado no main a partir de
// META_SEND_INTERVAL_MS.
var sendPacer *pacer

// messagesURL é o endpoint de mensagens do remetente. Separado de metaPost para poder ser
// verificado sem rede.
func (id metaIdentity) messagesURL() string {
	return fmt.Sprintf("%s/%s/%s/messages", graphBase(), cfg.APIVersion, id.PhoneNumberID)
}

// metaPost envia um payload para a API de mensagens do WhatsApp Business, como o remetente id.
//
// Sem fallback: identidade incompleta ou malformada falha antes de qualquer chamada. Nenhum erro
// devolvido carrega o token.
func metaPost(id metaIdentity, payload any) (json.RawMessage, error) {
	if err := id.validate(); err != nil {
		return nil, err
	}
	sendPacer.wait()

	apiURL := id.messagesURL()

	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, apiURL, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+id.AccessToken)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, id.redactErr(err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("meta api %d: %s", resp.StatusCode, id.redact(string(body)))
	}

	return json.RawMessage(body), nil
}

// sendText envia uma mensagem de texto simples como o remetente id (reutilizável internamente,
// ex: auto-resposta do webhook). Usa preview_url para o link wa.me virar clicável.
func sendText(id metaIdentity, to, body string) error {
	payload := map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "text",
		"text":              map[string]any{"preview_url": true, "body": body},
	}
	_, err := metaPost(id, payload)
	return err
}

// --- Handlers de envio ---

func handleSendText(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req SendTextRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.To == "" || req.Message == "" {
		writeError(w, http.StatusBadRequest, "to e message são obrigatórios")
		return
	}

	payload := map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                req.To,
		"type":              "text",
		"text":              map[string]any{"preview_url": false, "body": req.Message},
	}
	if req.ReplyToID != "" {
		payload["context"] = map[string]string{"message_id": req.ReplyToID}
	}

	data, err := metaPost(senderFrom(r), payload)
	if err != nil {
		log.Printf("[send/text] %v", err)
		events.Push(Event{Time: time.Now(), Kind: KindError, Phone: req.To, Origem: "direto", Message: truncate(req.Message, 100), Extra: err.Error(), OrganizationID: tenantFrom(r).OrganizationID})
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	events.Push(Event{Time: time.Now(), Kind: KindSent, Phone: req.To, Origem: "direto", Message: truncate(req.Message, 120), OrganizationID: tenantFrom(r).OrganizationID})
	writeSuccess(w, data)
}

func handleSendTemplate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req SendTemplateRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.To == "" || req.Template == "" {
		writeError(w, http.StatusBadRequest, "to e template são obrigatórios")
		return
	}
	if req.Language == "" {
		req.Language = "pt_BR"
	}

	tmpl := map[string]any{
		"name":     req.Template,
		"language": map[string]string{"code": req.Language},
	}
	if len(req.Components) > 0 {
		tmpl["components"] = req.Components
	}

	payload := map[string]any{
		"messaging_product": "whatsapp",
		"to":                req.To,
		"type":              "template",
		"template":          tmpl,
	}

	data, err := metaPost(senderFrom(r), payload)
	if err != nil {
		log.Printf("[send/template] %v", err)
		events.Push(Event{Time: time.Now(), Kind: KindError, Phone: req.To, Origem: "direto", Message: "Template: " + req.Template, Extra: err.Error(), OrganizationID: tenantFrom(r).OrganizationID})
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	tc := tenantFrom(r)
	registrarParaRetry(extrairWamid(data), QueueAddRequest{
		Type: "template", To: req.To, Template: req.Template, Language: req.Language, Components: req.Components,
		Sender: senderFrom(r).reference(), OrganizationID: tc.OrganizationID, IntegrationID: tc.IntegrationID,
	})
	events.Push(Event{Time: time.Now(), Kind: KindSent, Phone: req.To, Origem: "direto", Message: "Template: " + req.Template, OrganizationID: tenantFrom(r).OrganizationID})
	writeSuccess(w, data)
}

func handleSendMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req SendMediaRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.To == "" || req.Type == "" {
		writeError(w, http.StatusBadRequest, "to e type são obrigatórios")
		return
	}
	if req.MediaID == "" && req.Link == "" {
		writeError(w, http.StatusBadRequest, "media_id ou link é obrigatório")
		return
	}

	mediaObj := map[string]string{}
	if req.MediaID != "" {
		mediaObj["id"] = req.MediaID
	} else {
		mediaObj["link"] = req.Link
	}
	if req.Caption != "" {
		mediaObj["caption"] = req.Caption
	}

	payload := map[string]any{
		"messaging_product": "whatsapp",
		"to":                req.To,
		"type":              req.Type,
		req.Type:            mediaObj,
	}

	data, err := metaPost(senderFrom(r), payload)
	if err != nil {
		log.Printf("[send/media] %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeSuccess(w, data)
}

func handleSendButtons(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req SendButtonsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.To == "" || req.Body == "" || len(req.Buttons) == 0 {
		writeError(w, http.StatusBadRequest, "to, body e buttons são obrigatórios")
		return
	}
	if len(req.Buttons) > 3 {
		writeError(w, http.StatusBadRequest, "máximo 3 botões")
		return
	}

	btns := make([]map[string]any, len(req.Buttons))
	for i, b := range req.Buttons {
		btns[i] = map[string]any{
			"type":  "reply",
			"reply": map[string]string{"id": b.ID, "title": b.Title},
		}
	}

	payload := map[string]any{
		"messaging_product": "whatsapp",
		"to":                req.To,
		"type":              "interactive",
		"interactive": map[string]any{
			"type": "button",
			"body": map[string]string{"text": req.Body},
			"action": map[string]any{
				"buttons": btns,
			},
		},
	}

	data, err := metaPost(senderFrom(r), payload)
	if err != nil {
		log.Printf("[send/buttons] %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeSuccess(w, data)
}

func handleSendList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req SendListRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.To == "" || req.Body == "" || req.ButtonText == "" || len(req.Sections) == 0 {
		writeError(w, http.StatusBadRequest, "to, body, button_text e sections são obrigatórios")
		return
	}

	sections := make([]map[string]any, len(req.Sections))
	for i, s := range req.Sections {
		rows := make([]map[string]string, len(s.Rows))
		for j, row := range s.Rows {
			rows[j] = map[string]string{
				"id":          row.ID,
				"title":       row.Title,
				"description": row.Description,
			}
		}
		sections[i] = map[string]any{"title": s.Title, "rows": rows}
	}

	payload := map[string]any{
		"messaging_product": "whatsapp",
		"to":                req.To,
		"type":              "interactive",
		"interactive": map[string]any{
			"type": "list",
			"body": map[string]string{"text": req.Body},
			"action": map[string]any{
				"button":   req.ButtonText,
				"sections": sections,
			},
		},
	}

	data, err := metaPost(senderFrom(r), payload)
	if err != nil {
		log.Printf("[send/list] %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeSuccess(w, data)
}

func handleSendReaction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req SendReactionRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.To == "" || req.MessageID == "" || req.Emoji == "" {
		writeError(w, http.StatusBadRequest, "to, message_id e emoji são obrigatórios")
		return
	}

	payload := map[string]any{
		"messaging_product": "whatsapp",
		"to":                req.To,
		"type":              "reaction",
		"reaction":          map[string]string{"message_id": req.MessageID, "emoji": req.Emoji},
	}

	data, err := metaPost(senderFrom(r), payload)
	if err != nil {
		log.Printf("[send/reaction] %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeSuccess(w, data)
}

func handleMarkRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req MarkReadRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.MessageID == "" {
		writeError(w, http.StatusBadRequest, "message_id é obrigatório")
		return
	}

	payload := map[string]any{
		"messaging_product": "whatsapp",
		"status":            "read",
		"message_id":        req.MessageID,
	}

	data, err := metaPost(senderFrom(r), payload)
	if err != nil {
		log.Printf("[send/read] %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeSuccess(w, data)
}

// handleGetMedia resolve e faz download de uma mídia recebida via ID.
// GET /media/{media_id}
// Retorna o binário com o Content-Type correto.
func handleGetMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	mediaID := strings.TrimPrefix(r.URL.Path, "/media/")
	if !metaIDPattern.MatchString(mediaID) {
		writeError(w, http.StatusBadRequest, "media_id inválido")
		return
	}
	id := senderFrom(r)

	// Passo 1: resolver URL da mídia
	resolveURL := fmt.Sprintf("%s/%s/%s", graphBase(), cfg.APIVersion, mediaID)
	req, err := http.NewRequest(http.MethodGet, resolveURL, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	req.Header.Set("Authorization", "Bearer "+id.AccessToken)

	resp, err := httpClient.Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, id.redactErr(err).Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		writeError(w, http.StatusBadGateway, fmt.Sprintf("meta api %d: %s", resp.StatusCode, id.redact(string(body))))
		return
	}

	var meta struct {
		URL      string `json:"url"`
		MimeType string `json:"mime_type"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		writeError(w, http.StatusBadGateway, "resposta inválida da meta api")
		return
	}

	// Passo 2: download do binário
	dlReq, err := http.NewRequest(http.MethodGet, meta.URL, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	dlReq.Header.Set("Authorization", "Bearer "+id.AccessToken)

	dlResp, err := httpClient.Do(dlReq)
	if err != nil {
		writeError(w, http.StatusBadGateway, id.redactErr(err).Error())
		return
	}
	defer dlResp.Body.Close()

	if dlResp.StatusCode >= 400 {
		body, _ := io.ReadAll(dlResp.Body)
		writeError(w, http.StatusBadGateway, fmt.Sprintf("download %d: %s", dlResp.StatusCode, id.redact(string(body))))
		return
	}

	mimeType := meta.MimeType
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mimeType)
	io.Copy(w, dlResp.Body)
}

// --- Health + helpers ---

// handleHealth é público e só operacional (INV-35): nenhum número, WABA, Organization ou token.
// O remetente é da Organization e vive no painel; ninguém descobre identidade por aqui.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(APIResponse{Success: false, Error: msg})
}

func writeSuccess(w http.ResponseWriter, data json.RawMessage) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{Success: true, Data: data})
}
