import { useEffect, useState } from 'react';
import { getGaStatus, type GaConnection } from '../../api/googleAnalytics';
import { chavePeriodoGa4, type PeriodoGa4 } from '../../lib/ga4';

// Escopo comum das telas que leem GA4 (aba Performance do UTM Tracker e Analytics GA4): qual loja
// está de fato conectada com propriedade escolhida, e qual período está selecionado. As duas telas
// precisam exatamente da mesma regra — inclusive a de cair pra primeira loja conectada quando a
// loja do seletor global não tem GA4.
// A identidade de cada conexão é o `storeId` (canônico): a chave legada é nula na Store nativa e nunca
// pode ser o que separa uma conexão da outra. `nome` é só rótulo.
export interface LojaConectada { id: string; nome: string }

export function useGa4Escopo() {
  const [conexoes, setConexoes] = useState<GaConnection[] | null>(null);
  const [loja, setLoja] = useState('');
  const [periodo, setPeriodo] = useState<PeriodoGa4>('30d');
  const [inicio, setInicio] = useState('');
  const [fim, setFim] = useState('');

  useEffect(() => {
    getGaStatus()
      .then((r) => setConexoes(r.conexoes))
      .catch(() => setConexoes([]));
  }, []);

  const lojasConectadas: LojaConectada[] = (conexoes || [])
    .filter((c) => c.status === 'connected' && c.propertyId)
    .map((c) => ({ id: c.storeId, nome: c.storeNome || 'Sua loja' }));

  useEffect(() => {
    if (!conexoes) return;
    if (loja && lojasConectadas.some((l) => l.id === loja)) return;
    setLoja(lojasConectadas[0]?.id || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conexoes]);

  return {
    carregandoConexoes: conexoes === null,
    lojasConectadas,
    loja,
    setLoja,
    periodo,
    setPeriodo,
    inicio,
    setInicio,
    fim,
    setFim,
    periodoChave: chavePeriodoGa4(periodo, inicio, fim),
  };
}
