import { api } from './client';

export interface ControleEstoqueVariante {
  produtoTipo: string | null;
  loja: string;
  tamanho: string | null;
  cor: string | null;
  modelo: string | null;
  quantidadeDisponivel: number | null;
  observadoEm: string | null;
}

export interface ObservadoVariante {
  loja: string;
  tamanho: string | null;
  cor: string | null;
  modelo: string | null;
  quantidadeDisponivel: number | null;
  ultimaEstampaVista: string | null;
  observadoEm: string | null;
}

export function getControleEstoque() {
  return api<{ variantes: ControleEstoqueVariante[] }>('/api/admin/controle-estoque');
}

export function sincronizarControleEstoque() {
  return api('/api/admin/controle-estoque/sincronizar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// Apaga todo o histórico de observações e ressincroniza do zero — ação destrutiva (perde o
// histórico, mantido só o estado atual pós-resync), pedida pelo usuário pra investigar suspeita
// de dado velho/duplicado.
export function limparEResincronizarControleEstoque() {
  return api('/api/admin/controle-estoque/limpar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function getObservadoEstoque() {
  return api<{ variantes: ObservadoVariante[] }>('/api/admin/estoque');
}
