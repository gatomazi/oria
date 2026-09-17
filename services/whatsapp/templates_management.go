package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
)

// Gerenciamento de Message Templates da Meta (WhatsApp Business Management API).
// Templates precisam ser aprovados pela Meta antes de usar — este arquivo só
// lista/cria/apaga; a aprovação em si acontece do lado da Meta (pode levar de
// minutos a dias, e pode ser rejeitado).
//
// O WABA e o token vêm do remetente da chamada (withSender com WABA obrigatório): templates são
// da conta WhatsApp da Organization, não deste serviço. O WABA ID é diferente do phone_number_id —
// só se obtém no Meta Business Manager, em Configurações do Negócio > Contas do WhatsApp.

type CreateTemplateRequest struct {
	Name       string        `json:"name"`
	Language   string        `json:"language"`
	Category   string        `json:"category"` // MARKETING | UTILITY | AUTHENTICATION
	Components []interface{} `json:"components"`
}

// wabaCall faz uma chamada à Graph API como o remetente id. Erro de rede ou da Meta volta sem o
// token (redigido), pronto para log e resposta.
func wabaCall(id metaIdentity, method, endpoint string, payload []byte) (json.RawMessage, error) {
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, endpoint, body)
	if err != nil {
		return nil, id.redactErr(err)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+id.AccessToken)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, id.redactErr(err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("meta api %d: %s", resp.StatusCode, id.redact(string(data)))
	}
	return json.RawMessage(data), nil
}

func templatesURL(id metaIdentity) string {
	return fmt.Sprintf("%s/%s/%s/message_templates", graphBase(), cfg.APIVersion, id.WabaID)
}

func handleTemplatesList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	id := senderFrom(r)
	endpoint := templatesURL(id) + "?fields=name,status,category,language,components,rejected_reason&limit=100"
	data, err := wabaCall(id, http.MethodGet, endpoint, nil)
	if err != nil {
		log.Printf("[templates/list] %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeSuccess(w, data)
}

func handleTemplatesCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req CreateTemplateRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" || req.Category == "" || len(req.Components) == 0 {
		writeError(w, http.StatusBadRequest, "name, category e components são obrigatórios")
		return
	}
	if req.Language == "" {
		req.Language = "pt_BR"
	}

	payload, err := json.Marshal(map[string]any{
		"name":       req.Name,
		"language":   req.Language,
		"category":   req.Category,
		"components": req.Components,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	id := senderFrom(r)
	data, err := wabaCall(id, http.MethodPost, templatesURL(id), payload)
	if err != nil {
		log.Printf("[templates/create] %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeSuccess(w, data)
}

func handleTemplatesDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		writeError(w, http.StatusBadRequest, "name é obrigatório (query string)")
		return
	}

	id := senderFrom(r)
	// name escapado: sem isso, "x&hsm_id=..." acrescentaria parâmetros à chamada da Meta.
	data, err := wabaCall(id, http.MethodDelete, templatesURL(id)+"?name="+url.QueryEscape(name), nil)
	if err != nil {
		log.Printf("[templates/delete] %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeSuccess(w, data)
}
