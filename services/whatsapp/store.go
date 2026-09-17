package main

import (
	"log"
	"sync"
	"sync/atomic"
	"time"
)

type EventKind string

const (
	KindReceived EventKind = "received"
	KindSent     EventKind = "sent"
	KindError    EventKind = "error"
)

type Event struct {
	ID    int64     `json:"id"`
	Time  time.Time `json:"time"`
	Kind  EventKind `json:"kind"`
	Phone string    `json:"phone"`
	Name  string    `json:"name,omitempty"`
	// Origem distingue quem disparou o envio: "direto" (chamada direta a /send/*, sem
	// passar pela fila — é o caso do modo "automático" do painel admin, e também de um
	// teste manual de template) vs "fila" (item da fila de revisão manual, enviado pelo
	// botão "Enviar" no dashboard). Vazio para eventos que não são de envio (recebidas).
	Origem  string `json:"origem,omitempty"`
	Message string `json:"message"`
	Extra   string `json:"extra,omitempty"`
	// Organization dona do evento (Fase 5c). Fora do JSON: quem lê já está no escopo dela.
	OrganizationID string `json:"-"`
}

const maxEvents = 500

// eventSequence é global só para dar ids únicos às linhas do banco; não carrega escopo.
var eventSequence atomic.Int64

// EventStore é o buffer de eventos de UMA Organization.
type EventStore struct {
	once  sync.Once
	mu    sync.RWMutex
	buf   [maxEvents]Event
	head  int
	count int

	cntSent     atomic.Int64
	cntReceived atomic.Int64
	cntErrors   atomic.Int64
}

// eventStoreRegistry separa os buffers por Organization (INV-33): o painel de A nunca lê, conta
// nem limpa eventos de B.
type eventStoreRegistry struct {
	mu     sync.Mutex
	stores map[string]*EventStore
}

var events = &eventStoreRegistry{stores: map[string]*EventStore{}}

// For devolve o buffer da Organization, carregando do banco (só as linhas dela) na primeira vez.
func (r *eventStoreRegistry) For(organizationID string) *EventStore {
	r.mu.Lock()
	s, ok := r.stores[organizationID]
	if !ok {
		s = &EventStore{}
		r.stores[organizationID] = s
	}
	r.mu.Unlock()
	s.once.Do(func() {
		loaded := dbLoadEvents(organizationID)
		for i := len(loaded) - 1; i >= 0; i-- { // mais antigo primeiro
			s.add(loaded[i])
		}
	})
	return s
}

// Push grava um evento na Organization dele. Evento sem Organization não existe (zero dados novos
// sem dono): é descartado com log.
func (r *eventStoreRegistry) Push(e Event) {
	if !organizationIDPattern.MatchString(e.OrganizationID) {
		log.Printf("[events] evento sem organization descartado (kind=%s)", e.Kind)
		return
	}
	e.ID = eventSequence.Add(1)
	r.For(e.OrganizationID).add(e)
	go dbSaveEvent(e)
}

func (s *EventStore) add(e Event) {
	s.mu.Lock()
	s.buf[s.head] = e
	s.head = (s.head + 1) % maxEvents
	if s.count < maxEvents {
		s.count++
	}
	s.mu.Unlock()
	switch e.Kind {
	case KindSent:
		s.cntSent.Add(1)
	case KindReceived:
		s.cntReceived.Add(1)
	case KindError:
		s.cntErrors.Add(1)
	}
}

// Recent retorna até n eventos mais recentes (do mais novo para o mais antigo).
func (s *EventStore) Recent(n int) []Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.count == 0 {
		return nil
	}
	if n <= 0 || n > s.count {
		n = s.count
	}
	out := make([]Event, n)
	for i := 0; i < n; i++ {
		idx := ((s.head-1-i)%maxEvents + maxEvents) % maxEvents
		out[i] = s.buf[idx]
	}
	return out
}

type DashStats struct {
	Sent     int64 `json:"sent"`
	Received int64 `json:"received"`
	Errors   int64 `json:"errors"`
}

// Clear limpa só os eventos da Organization.
func (r *eventStoreRegistry) Clear(organizationID string) {
	s := r.For(organizationID)
	s.mu.Lock()
	s.buf = [maxEvents]Event{}
	s.head = 0
	s.count = 0
	s.mu.Unlock()
	s.cntSent.Store(0)
	s.cntReceived.Store(0)
	s.cntErrors.Store(0)
	go dbClearEvents(organizationID)
}

func (s *EventStore) Stats() DashStats {
	return DashStats{
		Sent:     s.cntSent.Load(),
		Received: s.cntReceived.Load(),
		Errors:   s.cntErrors.Load(),
	}
}

func truncate(s string, n int) string {
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}
