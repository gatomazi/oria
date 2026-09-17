import { useEffect, useSyncExternalStore } from 'react';
import { getWhatsappWebConfig, type WhatsappProvider } from '../api/whatsappWeb';

// Provider de envio do WhatsApp (API da Meta x WhatsApp Web). Decide quais telas aparecem no menu
// (Templates x Mensagens, Fila de envio) e os rótulos de botões de envio. Store compartilhado: o
// menu (AppShell) fica montado o tempo todo, então a troca feita em Integrações precisa
// notificar quem já está na tela — `definirWhatsappProvider` faz isso.
let atual: WhatsappProvider | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notificar() {
  listeners.forEach((fn) => fn());
}

function carregar() {
  if (atual || pending) return;
  pending = getWhatsappWebConfig()
    .then((c) => { atual = c.provider; })
    .catch(() => { atual = 'meta_api'; })
    .finally(() => {
      pending = null;
      notificar();
    });
}

export function definirWhatsappProvider(provider: WhatsappProvider) {
  atual = provider;
  notificar();
}

export function useWhatsappProvider(): WhatsappProvider | null {
  useEffect(carregar, []);
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => atual,
  );
}
