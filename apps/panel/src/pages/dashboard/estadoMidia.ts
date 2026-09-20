// Estado da mídia (Meta Ads + Google Ads) no resultado do Dashboard.
//
// O servidor devolve, junto do gasto, o ESTADO de cada fonte (`midiaFontes`). Sem isso o painel só
// tinha o total gasto, e "R$ 0" significava três coisas diferentes: (a) nenhuma conta conectada,
// (b) conta conectada mas atribuída a outra loja (ou a nenhuma) e (c) conta da loja com gasto zero
// no período. Só (c) é "gasto zero"; (a) e (b) são "não sei quanto foi gasto", e mostrar R$ 0 como
// se fosse a resposta faz o lucro parecer maior do que é.

export interface MidiaFonte {
  provider: string;
  conectado: boolean;
  relevante: boolean;
  // 'sem_loja' | 'outra_loja' quando a conta existe mas não entra no total; null caso contrário.
  motivo: string | null;
  // A conexão (token/API) da plataforma está em erro ou expirada, mesmo com conta da loja atribuída.
  comProblema?: boolean;
}

// desconhecido        não foi possível ler o estado (a tela não afirma nada)
// nao_conectada       nenhuma conta
// conta_fora_do_total conta existe mas não é desta loja
// conectada           conta da loja, conexão saudável (inclusive com gasto zero: esse zero é verdadeiro)
// com_problema        conta da loja, mas a conexão está em erro/expirada: o número pode estar velho
export type EstadoMidia = 'desconhecido' | 'conectada' | 'com_problema' | 'conta_fora_do_total' | 'nao_conectada';

export function estadoDaMidia(fontes: MidiaFonte[] | null | undefined): EstadoMidia {
  // Não foi possível ler as fontes: a tela não pode afirmar nem "sem mídia" nem "gasto zero".
  if (!fontes) return 'desconhecido';
  const conectadas = fontes.filter((f) => f.conectado);
  if (conectadas.length) return conectadas.every((f) => f.comProblema) ? 'com_problema' : 'conectada';
  if (fontes.some((f) => f.motivo)) return 'conta_fora_do_total';
  return 'nao_conectada';
}

// Complemento do rótulo do lucro quando a mídia NÃO entra na conta: diz por quê, em vez de calar.
export function avisoDeMidiaFora(estado: EstadoMidia): string | null {
  if (estado === 'nao_conectada') return 'sem mídia conectada';
  if (estado === 'conta_fora_do_total') return 'conta de anúncios sem loja atribuída';
  return null;
}

// Aviso para quando a mídia ENTRA na conta mas a conexão da plataforma precisa de atenção.
export function avisoDeMidiaComProblema(estado: EstadoMidia): string | null {
  return estado === 'com_problema' ? 'a conexão com a plataforma de anúncios precisa de atenção — reconecte em Integrações' : null;
}
