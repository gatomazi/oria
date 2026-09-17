package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// dashAuth protege as páginas e os endpoints de leitura do dashboard.
//
// A chave NÃO é mais aceita em ?key= na URL: credencial em query string vaza em access log de
// proxy/CDN, no histórico do navegador e no header Referer de qualquer link externo da página. É a
// mesma credencial dos endpoints de escrita, então o vazamento é passivo e total. Também não há
// mais liberação quando API_KEY está vazia — ver validAPIKey em main.go.
//
// As páginas HTML que existiam atrás dele (dashboard, problems, automaticos) foram desativadas na
// rodada 18: montavam os fetches com ?key=... e não tinham contexto de tenant. Ver handleDisabledPage.
func dashAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !validAPIKey(apiKeyFromRequest(r)) {
			http.Error(w, "Unauthorized — envie a chave no header X-Api-Key", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// disabledPageMessage é tudo o que as antigas páginas HTML respondem: nenhum dado, nenhum HTML.
const disabledPageMessage = "página desativada: use o painel Oria (dados por Organization)\n"

// handleDisabledPage responde 410 para /dashboard, /problems e /automaticos. As páginas embutidas
// eram de antes da Fase 5c (uma loja, chave na URL) e não tinham como escolher a Organization; os
// dados continuam nas rotas com contexto (/dashboard/events, /problems/list, /automaticos/list).
func handleDisabledPage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusGone)
	w.Write([]byte(disabledPageMessage))
}

func handleEventsClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	events.Clear(tenantFrom(r).OrganizationID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{Success: true})
}

func handleDashboardEvents(w http.ResponseWriter, r *http.Request) {
	// Só a Organization do contexto (withTenant): nenhuma soma entre tenants.
	org := tenantFrom(r).OrganizationID
	store := events.For(org)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"events":  store.Recent(200),
		"stats":   store.Stats(),
		"pending": queues.For(org).PendingCount(),
	})
}

func handleQueueAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req QueueAddRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.To == "" || req.Type == "" {
		writeError(w, http.StatusBadRequest, "to e type são obrigatórios")
		return
	}
	// O item guarda o remetente validado desta chamada (número + referência) e a Organization do
	// contexto, nunca o token.
	tc := tenantFrom(r)
	req.Sender = senderFrom(r).reference()
	req.OrganizationID = tc.OrganizationID
	req.IntegrationID = tc.IntegrationID
	item, dup, err := queues.For(tc.OrganizationID).Add(req)
	if err != nil {
		log.Printf("[queue/add] org=%s: %v", tc.OrganizationID, err)
		writeError(w, http.StatusServiceUnavailable, "fila indisponível")
		return
	}
	if dup {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(APIResponse{Success: true, Data: mustJSON(map[string]any{"duplicate": true})})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{Success: true, Data: mustJSON(map[string]any{"id": item.ID})})
}

func handleQueueDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		IDs []int64 `json:"ids"`
	}
	if err := decodeJSONBody(r, &req); err != nil || len(req.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids é obrigatório")
		return
	}
	removed := queues.For(tenantFrom(r).OrganizationID).Remove(req.IDs)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{Success: true, Data: mustJSON(map[string]any{"removed": removed})})
}

func handleQueueList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	loja := q.Get("loja") // filtro de exibição dentro da Organization, nunca escopo
	phone := onlyDigits(q.Get("to"))
	pedido := strings.ToLower(strings.TrimSpace(q.Get("pedido")))
	template := q.Get("template")

	all := queues.For(tenantFrom(r).OrganizationID).All()

	items := make([]*QueueItem, 0, len(all))
	for _, it := range all {
		if loja != "" && it.Loja != loja {
			continue
		}
		if phone != "" && !strings.Contains(onlyDigits(it.To), phone) {
			continue
		}
		if pedido != "" && !strings.Contains(strings.ToLower(it.Pedido), pedido) {
			continue
		}
		if template != "" && it.Template != template {
			continue
		}
		items = append(items, it)
	}

	// Mapas de loja/template → contagem, calculados sobre a fila inteira (não filtrada)
	lojas := map[string]int{}
	templates := map[string]int{}
	for _, it := range all {
		if it.Loja != "" {
			lojas[it.Loja]++
		}
		if it.Template != "" {
			templates[it.Template]++
		}
	}

	pending := 0
	for _, it := range items {
		if it.Status == "pending" {
			pending++
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"items":     items,
		"pending":   pending,
		"lojas":     lojas,
		"templates": templates,
	})
}

// onlyDigits mantém só os dígitos de s, usado pra comparar números de telefone
// ignorando formatação (+, espaços, parênteses, hífen).
func onlyDigits(s string) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			b = append(b, s[i])
		}
	}
	return string(b)
}

func handleQueueDedupe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	removed := queues.For(tenantFrom(r).OrganizationID).RemoveDuplicates()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{Success: true, Data: mustJSON(map[string]any{"removed": len(removed)})})
}

func handleQueueSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req QueueSendRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var ids []int64
	if !req.All {
		ids = req.IDs
	}
	org := tenantFrom(r).OrganizationID
	sent, errs, err := queues.For(org).Send(ids)
	if err != nil {
		log.Printf("[queue/send] org=%s: %v", org, err)
		writeError(w, http.StatusServiceUnavailable, "fila indisponível")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{Success: true, Data: mustJSON(map[string]any{
		"sent":   sent,
		"errors": errs,
	})})
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
