import { api } from './client';

export interface RecuperacaoCarrinho {
  id: string | number;
  loja: string;
  buyerName: string | null;
  buyerPhone: string | null;
  buyerEmail?: string | null;
  itemsCount: number;
  itens?: RecuperacaoCarrinhoItem[];
  valor: number | string | null;
  criadoEm?: string | null;
  updatedAt: string | null;
  tentativas: number;
  maxTentativas?: number | null;
  status: string;
  contactable: boolean;
  mensagemTemplate?: string | null;
  podeEnviarViaMeta?: boolean;
  // A Ink apaga carrinho abandonado depois de ~30 dias — quando true, esse carrinho não existe
  // mais lá, os dados vêm só do snapshot salvo aqui no primeiro momento em que foi observado.
  arquivado?: boolean;
  // Pedido pago do mesmo comprador depois do carrinho — quando existe, status vem 'comprou' e o
  // servidor recusa o envio de recuperação.
  compra?: { inkOrderId: string | number; em: string | null; valor: number | null } | null;
}

export interface RecuperacaoCarrinhoItem {
  nome: string | null;
  variante: string | null;
  quantidade: number;
  total: number | null;
  imagem: string | null;
}

export interface RecuperacaoPix {
  loja: string;
  inkOrderId: string | number;
  cliente: string | null;
  buyerPhone: string | null;
  valor: number | string | null;
  criadoEm: string | null;
  expiracao: string | null;
  tentativas: number;
  maxTentativas?: number | null;
  status: string;
  mensagemTemplate?: string | null;
  podeEnviarViaMeta?: boolean;
}

export interface RecuperacaoMetricas {
  recuperaveis: number;
  carrinhosJaComprados?: number;
  mensagensEnviadas: number;
  carrinhosConvertidos: number;
  receitaRecuperada: number | string | null;
}

export interface RecuperacaoData {
  carrinhos: RecuperacaoCarrinho[];
  pix: RecuperacaoPix[];
  metricas: RecuperacaoMetricas;
  erros?: { loja: string }[];
}

export function getRecuperacao() {
  return api<RecuperacaoData>(`/api/admin/recuperacao`);
}

export function enviarRecuperacaoCarrinho(cartId: string | number) {
  return api('/api/admin/recuperacao/carrinho/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cartId }),
  });
}

export function enviarRecuperacaoPix(inkOrderId: string | number) {
  return api('/api/admin/recuperacao/pix/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inkOrderId }),
  });
}
