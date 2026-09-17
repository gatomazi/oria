package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// ── Store ─────────────────────────────────────────────────────────────────────

type ProblemRastreio struct {
	Transportadora string   `json:"transportadora"`
	CodRastreio    string   `json:"cod_rastreio"`
	Prazo          string   `json:"prazo"`
	StatusAtual    string   `json:"status_atual"`
	Historico      []string `json:"historico"`
	URLRastreio    string   `json:"url_rastreio"`
}

type ProblemAnalise struct {
	PrazoInk       string   `json:"prazo_ink"`
	PrazoCarrier   string   `json:"prazo_carrier"`
	DiasDiff       int      `json:"dias_diff"`
	MudouPrazo     bool     `json:"mudou_prazo"`
	CodCorreios    string   `json:"cod_correios"`
	CorreiosStatus string   `json:"correios_status"`
	CorreiosHist   []string `json:"correios_hist"`
	Alertas        []string `json:"alertas"`
	Nivel          string   `json:"nivel"` // "ok" | "atencao" | "critico"
}

type ProblemOrder struct {
	Numero            string          `json:"numero"`
	Pedido            string          `json:"pedido"`
	Data              string          `json:"data"`
	Cliente           string          `json:"cliente"`
	Telefone          string          `json:"telefone"`
	Email             string          `json:"email"`
	CPF               string          `json:"cpf"`
	Valor             string          `json:"valor"`
	Entrega           string          `json:"entrega"`
	Loja              string          `json:"loja"`
	EstimativaInk     string          `json:"estimativa_ink"`
	TransportadoraInk string          `json:"transportadora_ink"`
	RastreioLink      string          `json:"rastreio_link"`
	Rastreio          ProblemRastreio `json:"rastreio"`
	Analise           ProblemAnalise  `json:"analise"`
	ConsultadoEm      string          `json:"consultado_em"`
	SavedAt           time.Time       `json:"saved_at"`
	// Organization dona (Fase 5c) — do contexto da chamada, nunca do corpo.
	OrganizationID string `json:"-"`
}

// problemStores mantém os problemas de entrega por Organization (WG-23/B-26): o mesmo número de
// pedido em duas Organizations são dois registros, sem herança de telefone/e-mail/CPF entre eles.
type problemRegistry struct {
	mu     sync.Mutex
	stores map[string]*ProblemStore
}

var problemStores = &problemRegistry{stores: map[string]*ProblemStore{}}

func (r *problemRegistry) For(organizationID string) *ProblemStore {
	r.mu.Lock()
	s, ok := r.stores[organizationID]
	if !ok {
		s = &ProblemStore{organizationID: organizationID}
		r.stores[organizationID] = s
	}
	r.mu.Unlock()
	s.once.Do(func() {
		loaded := dbLoadProblems(organizationID)
		s.mu.Lock()
		s.items = append(loaded, s.items...)
		s.mu.Unlock()
	})
	return s
}

type ProblemStore struct {
	organizationID string
	once           sync.Once
	mu             sync.RWMutex
	items          []*ProblemOrder
}

func (s *ProblemStore) Upsert(o *ProblemOrder) {
	o.SavedAt = time.Now()
	o.OrganizationID = s.organizationID
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, existing := range s.items {
		if existing.Numero == o.Numero {
			// Preserva campos do registro anterior DESTA Organization se o novo não trouxer informação
			if o.Telefone == "" {
				o.Telefone = existing.Telefone
			}
			if o.Email == "" {
				o.Email = existing.Email
			}
			if o.CPF == "" {
				o.CPF = existing.CPF
			}
			if o.TransportadoraInk == "" {
				o.TransportadoraInk = existing.TransportadoraInk
			}
			// Usa transportadora do ink como fallback se a API não identificou
			if o.Rastreio.Transportadora == "" {
				if existing.Rastreio.Transportadora != "" {
					o.Rastreio.Transportadora = existing.Rastreio.Transportadora
				} else if o.TransportadoraInk != "" {
					o.Rastreio.Transportadora = o.TransportadoraInk
				}
			}
			if o.Rastreio.CodRastreio == "" {
				o.Rastreio.CodRastreio = existing.Rastreio.CodRastreio
			}
			if o.Rastreio.Prazo == "" {
				o.Rastreio.Prazo = existing.Rastreio.Prazo
			}
			if o.Rastreio.StatusAtual == "" {
				o.Rastreio.StatusAtual = existing.Rastreio.StatusAtual
			}
			if len(o.Rastreio.Historico) == 0 {
				o.Rastreio.Historico = existing.Rastreio.Historico
			}
			// Usa link de rastreio do ink se a API não forneceu
			if o.Rastreio.URLRastreio == "" && o.RastreioLink != "" {
				o.Rastreio.URLRastreio = o.RastreioLink
			}
			if len(o.Analise.Alertas) == 0 && len(existing.Analise.Alertas) > 0 {
				o.Analise = existing.Analise
			}
			s.items[i] = o
			go dbSaveProblem(o)
			return
		}
	}
	s.items = append(s.items, o)
	go dbSaveProblem(o)
}

func (s *ProblemStore) All() []*ProblemOrder {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*ProblemOrder, len(s.items))
	copy(out, s.items)
	return out
}

// SyncLoja reconcilia, DENTRO da Organization, a lista de uma loja com os números ainda com
// problema no reserva.ink. Remove os pedidos daquela loja cujo número NÃO está em keep.
// Retorna os números removidos. Nada de outra Organization é tocado, com lista vazia ou não.
func (s *ProblemStore) SyncLoja(loja string, keep []string) []string {
	keepSet := make(map[string]bool, len(keep))
	for _, n := range keep {
		keepSet[n] = true
	}

	s.mu.Lock()
	kept := s.items[:0]
	var removed []string
	for _, it := range s.items {
		if it.Loja == loja && !keepSet[it.Numero] {
			removed = append(removed, it.Numero)
			continue
		}
		kept = append(kept, it)
	}
	s.items = kept
	s.mu.Unlock()

	if len(removed) > 0 {
		go dbDeleteProblems(s.organizationID, removed)
	}
	return removed
}

// ── Handlers ──────────────────────────────────────────────────────────────────

func handleProblemsList(w http.ResponseWriter, r *http.Request) {
	store := problemStores.For(tenantFrom(r).OrganizationID)
	loja := r.URL.Query().Get("loja")
	items := store.All()
	if loja != "" {
		filtered := items[:0]
		for _, it := range items {
			if it.Loja == loja {
				filtered = append(filtered, it)
			}
		}
		items = filtered
	}

	lojas := map[string]int{}
	for _, it := range store.All() {
		if it.Loja != "" {
			lojas[it.Loja]++
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"items": items, "lojas": lojas})
}

// handleProblemsAdd recebe o resultado de problemas_pedidos.py
// Aceita tanto um único objeto quanto um array.
func handleProblemsAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	body, err := decodeAnyJSON(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "json inválido: "+err.Error())
		return
	}

	var orders []ProblemOrder
	switch v := body.(type) {
	case []any:
		for _, raw := range v {
			b, _ := json.Marshal(raw)
			var o ProblemOrder
			if json.Unmarshal(b, &o) == nil {
				orders = append(orders, o)
			}
		}
	case map[string]any:
		b, _ := json.Marshal(v)
		var o ProblemOrder
		if json.Unmarshal(b, &o) == nil {
			orders = append(orders, o)
		}
	}

	store := problemStores.For(tenantFrom(r).OrganizationID)
	for i := range orders {
		store.Upsert(&orders[i])
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{Success: true, Data: mustJSON(map[string]any{"saved": len(orders)})})
}

// handleProblemsSync reconcilia a lista de problemas de uma loja da Organization do contexto.
// Body: {"loja": "Use Sul", "numeros": ["123","456", ...]}
// O ESCOPO (qual Organization) vem da referência assinada da chamada (withTenant), nunca do corpo:
// campos de Organization no corpo são recusados (INV-31).
// Remove do dashboard os pedidos daquela loja que não estão mais na lista
// atual de problemas do reserva.ink (resolvidos na origem). Uma lista vazia
// de "numeros" limpa todos os problemas daquela loja.
func handleProblemsSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		Loja    string   `json:"loja"`
		Numeros []string `json:"numeros"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Loja == "" {
		writeError(w, http.StatusBadRequest, "loja é obrigatório")
		return
	}

	removed := problemStores.For(tenantFrom(r).OrganizationID).SyncLoja(req.Loja, req.Numeros)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{Success: true, Data: mustJSON(map[string]any{
		"removed":     len(removed),
		"removed_ids": removed,
	})})
}

func decodeAnyJSON(r *http.Request) (any, error) {
	var result any
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}
