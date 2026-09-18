// Janela de atribuição de pedidos a campanha (dias após o envio). Mesmo padrão de adminState.ts:
// escolhida numa tela, fica gravada no navegador e vale pra todas as próximas telas que usam
// atribuição — sem precisar escolher de novo a cada campanha aberta.
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'or_admin_janela_atribuicao_dias';
// Espelha JANELAS_DIAS_PERMITIDAS de lib/campanhas/atribuicao.js (o backend recusa outro valor).
export const JANELAS_ATRIBUICAO_DIAS = [1, 3, 7, 14, 30] as const;
const PADRAO = 7;

function valida(n: number): boolean {
  return (JANELAS_ATRIBUICAO_DIAS as readonly number[]).includes(n);
}

function read(): number {
  try {
    const n = Number(window.localStorage.getItem(STORAGE_KEY));
    return valida(n) ? n : PADRAO;
  } catch {
    return PADRAO;
  }
}

let atual = read();
const listeners = new Set<() => void>();

export const janelaAtribuicao = {
  get(): number {
    return atual;
  },
  set(dias: number): void {
    if (!valida(dias) || dias === atual) return;
    atual = dias;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(dias));
    } catch {
      // localStorage indisponível: vale só até recarregar a página
    }
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useJanelaAtribuicao(): number {
  return useSyncExternalStore(janelaAtribuicao.subscribe, janelaAtribuicao.get);
}
