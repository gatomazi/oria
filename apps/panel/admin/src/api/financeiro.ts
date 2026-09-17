import { api } from './client';

// Porte de src/financeiro.js — todos os endpoints são GET (a API da Ink não expõe
// escrita pra saldo/saque/antecipação; ver docs/plan-admin-v2-vanilla.md).
export interface ResumoFinanceiro {
  saldo: { available?: number | string; pending?: number | string };
}

export function getResumo() {
  return api<ResumoFinanceiro>(`/api/admin/financeiro/resumo`);
}

export interface Movimento {
  date?: string;
  type?: string;
  order_id?: number;
  description?: string;
  amount?: number | string;
}

export interface MovimentacoesResponse {
  extrato: { date: string; movements: Movimento[] }[];
}

export function getMovimentacoes() {
  return api<MovimentacoesResponse>(`/api/admin/financeiro/movimentacoes`);
}

export interface Antecipacao {
  date?: string;
  status?: string;
  gross_amount?: number | string;
  net_amount?: number | string;
}

export function getAntecipacoes() {
  return api<{ antecipacoes: Antecipacao[] }>(`/api/admin/financeiro/antecipacoes`);
}

export interface Saque {
  created_at?: string;
  amount?: number | string;
}

export function getSaques() {
  return api<{ saques: Saque[] }>(`/api/admin/financeiro/saques`);
}
