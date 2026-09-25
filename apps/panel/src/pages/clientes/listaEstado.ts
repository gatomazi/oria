// Estado da carga da lista de Clientes ligado à CHAVE do que foi pedido (escopo + filtros + busca + tentativa).
//
// Por que existe: antes, a lista guardava só "a última resposta". Ao trocar um filtro (ex.: ativar o chip "Novos"), a
// resposta anterior — sem filtro, com o total antigo — continuava na tela, com o chip novo no topo, até a nova resposta
// chegar (ou para sempre, se ela falhasse). Agora só se exibe dado cuja chave é IGUAL à chave atual; em qualquer outro caso
// a tela mostra carregamento ou erro, nunca linhas de outro filtro.
export type StatusCarga = 'carregando' | 'ok' | 'erro';

export interface CargaLista<T> {
  chave: string;
  status: StatusCarga;
  dados: T | null;
  erro: string;
}

export type Exibicao<T> =
  | { modo: 'carregando'; dados: null; erro: '' }
  | { modo: 'erro'; dados: null; erro: string }
  | { modo: 'ok'; dados: T; erro: '' };

export function iniciarCarga<T>(chave: string): CargaLista<T> {
  return { chave, status: 'carregando', dados: null, erro: '' };
}

// Aplica um resultado SÓ se ele ainda é da carga corrente: resposta de uma chave antiga (mais lenta, fora de ordem) é ignorada.
export function concluirCarga<T>(atual: CargaLista<T> | null, chave: string, resultado: { dados: T } | { erro: string }): CargaLista<T> | null {
  if (!atual || atual.chave !== chave) return atual;
  return 'dados' in resultado
    ? { chave, status: 'ok', dados: resultado.dados, erro: '' }
    : { chave, status: 'erro', dados: null, erro: resultado.erro };
}

export function exibicao<T>(carga: CargaLista<T> | null, chaveAtual: string): Exibicao<T> {
  if (!carga || carga.chave !== chaveAtual || carga.status === 'carregando') return { modo: 'carregando', dados: null, erro: '' };
  if (carga.status === 'erro') return { modo: 'erro', dados: null, erro: carga.erro || 'erro desconhecido' };
  return { modo: 'ok', dados: carga.dados as T, erro: '' };
}

// Confere a lista com a matriz: só faz sentido quando o ÚNICO filtro ativo é o de segmento(s) RFM. Devolve o total esperado
// (soma dos clientes dos segmentos selecionados) ou `null` quando não há comparação honesta a fazer.
export function totalEsperadoDaMatriz(
  segmentosAtivos: string[],
  clientesPorSegmento: Record<string, number>,
  outrosFiltrosAtivos: boolean,
): number | null {
  if (!segmentosAtivos.length || outrosFiltrosAtivos) return null;
  let soma = 0;
  for (const id of segmentosAtivos) {
    if (!(id in clientesPorSegmento)) return null; // ex.: `sem_compra` não é um segmento da matriz
    soma += clientesPorSegmento[id];
  }
  return soma;
}
