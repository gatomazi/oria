package main

import (
	"sync"
	"testing"
	"time"
)

func TestGivenPacerWithInterval_WhenCalledSequentially_ThenCallsAreSpaced(t *testing.T) {
	// Given
	p := newPacer(50 * time.Millisecond)

	// When
	start := time.Now()
	for i := 0; i < 3; i++ {
		p.wait()
	}
	elapsed := time.Since(start)

	// Then: 1ª sai na hora, 2ª e 3ª esperam 1 intervalo cada
	if elapsed < 100*time.Millisecond {
		t.Fatalf("esperado >= 100ms entre 3 chamadas, levou %v", elapsed)
	}
}

func TestGivenPacerWithInterval_WhenCalledConcurrently_ThenCallsAreSpaced(t *testing.T) {
	// Given
	p := newPacer(40 * time.Millisecond)
	var wg sync.WaitGroup

	// When
	start := time.Now()
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.wait()
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)

	// Then
	if elapsed < 120*time.Millisecond {
		t.Fatalf("esperado >= 120ms entre 4 chamadas concorrentes, levou %v", elapsed)
	}
}

func TestGivenPacerWithZeroInterval_WhenCalled_ThenDoesNotBlock(t *testing.T) {
	// Given
	p := newPacer(0)

	// When
	start := time.Now()
	for i := 0; i < 100; i++ {
		p.wait()
	}

	// Then
	if time.Since(start) > 20*time.Millisecond {
		t.Fatalf("pacer desligado não deveria bloquear")
	}
}
