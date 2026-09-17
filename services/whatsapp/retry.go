package main

import (
	"encoding/json"
	"sync"
)

// Correlaciona o wamid retornado pela Meta no envio com o pedido original (to/template/
// language/components) — permite oferecer reenvio de 1 clique (via fila existente) quando o
// webhook de status "failed" chega depois, sem repetir o que já foi digitado/configurado.
// Só em memória, tamanho limitado (FIFO) — não precisa sobreviver a um restart: se o serviço
// reiniciar entre o envio e a falha, a mensagem só não vira retryable automaticamente.
const maxRetryLookup = 500

// A chave inclui a Organization (INV-34): o mesmo wamid visto por dois tenants não se confunde.
type retryKey struct {
	OrganizationID string
	Wamid          string
}

var retryStore = struct {
	mu    sync.Mutex
	byID  map[retryKey]QueueAddRequest
	order []retryKey
}{byID: make(map[retryKey]QueueAddRequest)}

func registrarParaRetry(wamid string, req QueueAddRequest) {
	if wamid == "" || req.OrganizationID == "" {
		return
	}
	key := retryKey{OrganizationID: req.OrganizationID, Wamid: wamid}
	retryStore.mu.Lock()
	defer retryStore.mu.Unlock()
	if _, exists := retryStore.byID[key]; !exists {
		retryStore.order = append(retryStore.order, key)
		if len(retryStore.order) > maxRetryLookup {
			oldest := retryStore.order[0]
			retryStore.order = retryStore.order[1:]
			delete(retryStore.byID, oldest)
		}
	}
	retryStore.byID[key] = req
}

func buscarParaRetry(organizationID, wamid string) (QueueAddRequest, bool) {
	retryStore.mu.Lock()
	defer retryStore.mu.Unlock()
	req, ok := retryStore.byID[retryKey{OrganizationID: organizationID, Wamid: wamid}]
	return req, ok
}

// extrairWamid lê o id da mensagem devolvido pela Meta num envio bem-sucedido
// (`{"messages":[{"id":"wamid...."}]}`) — vazio se o formato vier diferente do esperado.
func extrairWamid(data json.RawMessage) string {
	var parsed struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil || len(parsed.Messages) == 0 {
		return ""
	}
	return parsed.Messages[0].ID
}
