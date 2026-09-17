package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

// Cliente próprio (não o httpClient global de 10s de sender.go) — amostra de documento pode
// chegar a 100MB, 10s é curto de propósito pras chamadas normais de envio de mensagem.
var mediaUploadClient = &http.Client{Timeout: 60 * time.Second}

// Upload de amostra de mídia pra criação de template (Resumable Upload API da Meta) — diferente
// do /send/media já existente em sender.go, que usa a Cloud API de mensagens (media_id) pra
// mídia real de ENVIO. "Amostra de template" e "mídia da mensagem" são conceitos separados (ver
// docs/PROMPT-CLAUDE-CAMPANHAS-REMARKETING-MIDIA-WHATSAPP.md, Parte 6/591) — o handle daqui só
// serve pra example.header_handle na criação/aprovação do template.
//
// Fluxo (2 passos, https://developers.facebook.com/docs/graph-api/guides/upload):
//  1. POST /{app-id}/uploads?file_length&file_type&file_name, Authorization: OAuth {token} -> {"id": "upload:XYZ"}
//  2. POST /{upload_session_id} com o arquivo no corpo, Authorization: OAuth {token} -> {"h": "<handle>"}
type MediaUploadRequest struct {
	Filename   string `json:"filename"`
	MimeType   string `json:"mimeType"`
	DataBase64 string `json:"dataBase64"`
	// AppID opcional: o painel guarda o ID do app da Meta (tela de Integrações) e manda aqui.
	// Vazio cai no META_APP_ID do ambiente.
	AppID string `json:"appId"`
}

// ID de app da Meta é numérico; validar antes de pôr no caminho da URL da Graph API evita que um
// valor arbitrário mude o endpoint chamado (path injection).
var appIDPattern = regexp.MustCompile(`^[0-9]{5,32}$`)

func handleMediaUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req MediaUploadRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.MimeType == "" || req.DataBase64 == "" {
		writeError(w, http.StatusBadRequest, "mimeType e dataBase64 são obrigatórios")
		return
	}
	fileBytes, err := base64.StdEncoding.DecodeString(req.DataBase64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "dataBase64 inválido")
		return
	}
	if req.Filename == "" {
		req.Filename = "amostra"
	}

	// Só checado aqui (não antes) — assim um request malformado sempre recebe o erro de validação
	// certo, não "credencial ausente" por causa da ordem das checagens.
	appID := req.AppID
	if appID == "" {
		appID = cfg.AppID
	}
	if appID == "" {
		writeError(w, http.StatusBadGateway, "ID do app da Meta não configurado (Integrações › WhatsApp ou META_APP_ID) — necessário pro upload de amostra de mídia (diferente do WABA ID)")
		return
	}
	if !appIDPattern.MatchString(appID) {
		writeError(w, http.StatusBadRequest, "appId inválido: use só os dígitos do ID do app da Meta")
		return
	}

	id := senderFrom(r)
	sessionID, err := startUploadSession(id, appID, len(fileBytes), req.MimeType, req.Filename)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	handle, err := pushUploadBytes(id, sessionID, fileBytes)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	writeSuccess(w, mustJSON(map[string]any{"handle": handle}))
}

func startUploadSession(id metaIdentity, appID string, fileLength int, mimeType, filename string) (string, error) {
	// file_name/file_type PRECISAM ser url.QueryEscape antes de entrar na query string -- filename
	// vem cru do original_filename enviado pelo admin (server.js repassa sem sanitizar, só o
	// storage_key em disco é sanitizado) e pode ter espaço/acento/&/# etc. Sem escapar, a URL fica
	// malformada e o edge da Meta rejeita com uma página HTML de erro genérica (não o JSON de erro
	// normal da Graph API) -- foi exatamente o sintoma reportado.
	endpoint := fmt.Sprintf("%s/%s/%s/uploads?file_length=%d&file_type=%s&file_name=%s",
		graphBase(), cfg.APIVersion, appID, fileLength, url.QueryEscape(mimeType), url.QueryEscape(filename))

	// Security: o token vai no header, nunca na URL. Na query string ele acaba em log de proxy/CDN,
	// e o *url.Error de uma falha de rede carrega a URL inteira -- que este handler devolve ao
	// chamador via writeError. Mesmo esquema "OAuth" que o passo 2 deste fluxo já usa.
	req, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("falha ao montar sessão de upload: %w", err)
	}
	req.Header.Set("Authorization", "OAuth "+id.AccessToken)

	resp, err := mediaUploadClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("falha ao iniciar sessão de upload: %w", id.redactErr(err))
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("meta api (start upload) %d: %s", resp.StatusCode, id.redact(string(body)))
	}

	var parsed struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.ID == "" {
		return "", fmt.Errorf("resposta inesperada ao iniciar upload: %s", id.redact(string(body)))
	}
	return parsed.ID, nil
}

func pushUploadBytes(id metaIdentity, sessionID string, data []byte) (string, error) {
	url := fmt.Sprintf("%s/%s/%s", graphBase(), cfg.APIVersion, sessionID)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "OAuth "+id.AccessToken)
	req.Header.Set("file_offset", "0")

	resp, err := mediaUploadClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("falha ao enviar bytes do upload: %w", id.redactErr(err))
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("meta api (push bytes) %d: %s", resp.StatusCode, id.redact(string(body)))
	}

	var parsed struct {
		H string `json:"h"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.H == "" {
		return "", fmt.Errorf("resposta inesperada ao enviar bytes: %s", id.redact(string(body)))
	}
	return parsed.H, nil
}
