package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// AutoSendView é um envio "direto" (fora da fila de revisão manual — ver Event.Origem)
// pareado com a resposta do cliente mais próxima em seguida, se houver. A correlação é só
// por telefone + ordem cronológica dentro do buffer de eventos (buffer da Organization, até maxEvents),
// não existe um vínculo estruturado com o pedido/carrinho de origem.
type AutoSendView struct {
	Event
	Resposta *Event `json:"resposta,omitempty"`
}

func handleAutomaticosList(w http.ResponseWriter, r *http.Request) {
	phone := onlyDigits(r.URL.Query().Get("to"))

	// Recent devolve do mais novo pro mais antigo — inverte pra ordem cronológica antes de procurar
	// qual resposta veio depois de qual envio. Só eventos da Organization do contexto.
	recentes := events.For(tenantFrom(r).OrganizationID).Recent(0)
	asc := make([]Event, len(recentes))
	for i, e := range recentes {
		asc[len(recentes)-1-i] = e
	}

	var out []AutoSendView
	for i, e := range asc {
		if e.Kind != KindSent || e.Origem != "direto" {
			continue
		}
		if phone != "" && !strings.Contains(onlyDigits(e.Phone), phone) {
			continue
		}
		view := AutoSendView{Event: e}
		for j := i + 1; j < len(asc); j++ {
			candidata := asc[j]
			if candidata.Kind == KindReceived && onlyDigits(candidata.Phone) == onlyDigits(e.Phone) {
				resposta := candidata
				view.Resposta = &resposta
				break
			}
		}
		out = append(out, view)
	}

	// volta pra mais novo primeiro, como o resto do dashboard
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}

	comResposta := 0
	for _, v := range out {
		if v.Resposta != nil {
			comResposta++
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"items":       out,
		"total":       len(out),
		"comResposta": comResposta,
	})
}
