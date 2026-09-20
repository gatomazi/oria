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
}

export type EstadoMidia = 'desconhecido' | 'conectada' | 'conta_fora_do_total' | 'nao_conectada';

export function estadoDaMidia(fontes: MidiaFonte[] | null | undefined): EstadoMidia {
  // Não foi possível ler as fontes: a tela não pode afirmar nem "sem mídia" nem "gasto zero".
  if (!fontes) return 'desconhecido';
  if (fontes.some((f) => f.conectado)) return 'conectada';
  if (fontes.some((f) => f.motivo)) return 'conta_fora_do_total';
  return 'nao_conectada';
}

// Complemento do rótulo do lucro quando a mídia NÃO entra na conta: diz por quê, em vez de calar.
export function avisoDeMidiaFora(estado: EstadoMidia): string | null {
  if (estado === 'nao_conectada') return 'sem mídia conectada';
  if (estado === 'conta_fora_do_total') return 'conta de anúncios sem loja atribuída';
  return null;
}
