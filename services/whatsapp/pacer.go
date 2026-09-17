package main

import (
	"sync"
	"time"
)

// pacer garante um intervalo mínimo entre chamadas de envio à Meta, somando TODAS as origens
// (campanha, automações, fila do dashboard, auto-resposta) — um disparo grande de campanha não
// sai em rajada, mesmo que o chamador mande vários requests em sequência rápida ou em paralelo.
// Funciona por "reserva de horário": cada chamada reserva o próximo slot livre sob o mutex e
// dorme FORA dele, então chamadas concorrentes ficam enfileiradas em ordem sem segurar o lock.
type pacer struct {
	mu       sync.Mutex
	interval time.Duration
	next     time.Time
}

func newPacer(interval time.Duration) *pacer {
	return &pacer{interval: interval}
}

// wait bloqueia até o slot reservado pra esta chamada. Intervalo <= 0 desliga o pacing.
func (p *pacer) wait() {
	if p == nil || p.interval <= 0 {
		return
	}
	p.mu.Lock()
	now := time.Now()
	slot := p.next
	if slot.Before(now) {
		slot = now
	}
	p.next = slot.Add(p.interval)
	p.mu.Unlock()

	if d := time.Until(slot); d > 0 {
		time.Sleep(d)
	}
}
