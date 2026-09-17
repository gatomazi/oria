import { api } from './client';

// Custo das APIs que a operação consome (WhatsApp e geração de criativos). O backend nunca devolve
// um total "exato": cada número vem com a confiança do pior preço que entrou nele e com o quanto
// ficou de fora por não ter sido medido. A tela é obrigada a mostrar as duas coisas.

export type Confianca = 'confirmado' | 'publicado' | 'estimado';

export interface PrecoApi {
  chave: string;
  rotulo: string;
  valor: number;
  moeda: string;
  unidade: 'mensagem' | 'milhao_tokens';
  confianca: Confianca;
  fonte: string;
  nota?: string;
  editado: boolean;
  atualizadoEm?: string | null;
}

export interface LinhaCusto {
  total: number;
  moeda: string | null;
  confianca: Confianca;
  rotulo: string;
  quantidade?: number;
  entradaNaoDetalhada?: boolean;
}

export interface TotalCusto {
  total: number;
  moeda: string | null;
  moedasMisturadas: boolean;
  confianca: Confianca;
  /** Quantas mensagens/gerações existiram mas não puderam ser precificadas. */
  naoMedido: number;
  linhas: LinhaCusto[];
}

export interface CustosApiData {
  dias: number;
  conferidoEm: string;
  provider: 'meta_api' | 'whatsapp_web';
  whatsapp: TotalCusto & { semCustoDeApi: number; porOrigem: Record<string, number> };
  criativos: TotalCusto;
  geral: TotalCusto;
}

export interface PrecosResposta {
  precos: PrecoApi[];
  conferidoEm: string;
}

export function getCustosApi(dias: number) {
  return api<CustosApiData>(`/api/admin/financeiro/custos-api?dias=${dias}`);
}

export function getPrecosApi() {
  return api<PrecosResposta>('/api/admin/financeiro/custos-api/precos');
}

export function salvarPrecoApi(chave: string, valor: number, moeda: string) {
  return api<PrecosResposta>(`/api/admin/financeiro/custos-api/precos/${encodeURIComponent(chave)}`, {
    method: 'PUT',
    body: JSON.stringify({ valor, moeda }),
  });
}

/** Volta a linha para o padrão do painel — desfaz um valor digitado errado. */
export function restaurarPrecoApi(chave: string) {
  return api<PrecosResposta>(`/api/admin/financeiro/custos-api/precos/${encodeURIComponent(chave)}`, {
    method: 'DELETE',
  });
}

export const CONFIANCA_ROTULO: Record<Confianca, string> = {
  confirmado: 'Confirmado por você',
  publicado: 'Tabela oficial',
  estimado: 'Estimativa',
};

export const CONFIANCA_TOM: Record<Confianca, 'success' | 'info' | 'warning'> = {
  confirmado: 'success',
  publicado: 'info',
  estimado: 'warning',
};

/** Formata um valor na moeda em que ele foi cadastrado — nunca converte câmbio. */
export function formatMoeda(valor: number, moeda: string | null, casas = 2): string {
  const m = moeda || 'USD';
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency', currency: m, minimumFractionDigits: casas, maximumFractionDigits: casas,
    }).format(valor);
  } catch {
    return `${m} ${valor.toFixed(casas)}`;
  }
}

/** Preço unitário precisa de mais casas: US$ 0,0625 por mensagem vira "US$ 0,06" com duas. */
export function formatPrecoUnitario(p: PrecoApi): string {
  const casas = p.unidade === 'mensagem' ? 4 : 2;
  const sufixo = p.unidade === 'mensagem' ? 'por mensagem' : 'por 1M de tokens';
  return `${formatMoeda(p.valor, p.moeda, casas)} ${sufixo}`;
}
