import { useEffect, useState } from 'react';
import { getGaStatus, type GaConnection } from '../../api/googleAnalytics';
import { chavePeriodoGa4, type PeriodoGa4 } from '../../lib/ga4';

// Escopo comum das telas que leem GA4 (aba Performance do UTM Tracker e Analytics GA4): qual loja
// está de fato conectada com propriedade escolhida, e qual período está selecionado. As duas telas
// precisam exatamente da mesma regra — inclusive a de cair pra primeira loja conectada quando a
// loja do seletor global não tem GA4.
export function useGa4Escopo(lojaPreferida: string) {
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

  const lojasConectadas = (conexoes || [])
    .filter((c) => c.status === 'connected' && c.propertyId)
    .map((c) => c.loja);

  useEffect(() => {
    if (!conexoes) return;
    if (loja && lojasConectadas.includes(loja)) return;
    setLoja(lojasConectadas.includes(lojaPreferida) ? lojaPreferida : lojasConectadas[0] || '');
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
