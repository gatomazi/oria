import { useEffect, useState } from 'react';
import { getGaStatus, type GaConnection } from '../../api/googleAnalytics';
import { chavePeriodoGa4, type PeriodoGa4 } from '../../lib/ga4';
import { usePeriodoGlobal, type PeriodoGlobal } from '../../lib/periodoGlobal';

// Escopo comum das telas que leem GA4 (aba Performance do UTM Tracker e Analytics GA4): qual loja
// está de fato conectada com propriedade escolhida, e qual período está selecionado. As duas telas
// precisam exatamente da mesma regra — inclusive a de cair pra primeira loja conectada quando a
// loja do seletor global não tem GA4.
// A identidade de cada conexão é o `storeId` (canônico): a chave legada é nula na Store nativa e nunca
// pode ser o que separa uma conexão da outra. `nome` é só rótulo.
export interface LojaConectada { id: string; nome: string }

// GA4 só entende 4 presets (hoje/7d/30d/90d) + personalizado — nunca "Ontem"/"14 dias", que o
// período global aceita por causa do Meta Ads. Um valor global nesses dois cai pro `custom` com as
// datas já resolvidas: o VALOR fica certo, só não usa o preset "hoje" que o backend trata à parte
// (sempre "agora", nunca uma data presa).
function deGlobal(g: PeriodoGlobal): { periodo: PeriodoGa4; inicio: string; fim: string } {
  if (g.tipo === 'preset' && (g.id === 'hoje' || g.id === '7d' || g.id === '30d' || g.id === '90d')) {
    return { periodo: g.id, inicio: '', fim: '' };
  }
  if (g.tipo === 'custom') return { periodo: 'custom', inicio: g.startDate, fim: g.endDate };
  return { periodo: '30d', inicio: '', fim: '' }; // 'ontem'/'14d' vindos de outra tela
}

export function useGa4Escopo() {
  const [conexoes, setConexoes] = useState<GaConnection[] | null>(null);
  const [loja, setLoja] = useState('');
  const [periodoGlobal, setPeriodoGlobal] = usePeriodoGlobal();
  const [periodo, setPeriodoLocal] = useState<PeriodoGa4>(() => deGlobal(periodoGlobal).periodo);
  const [inicio, setInicioLocal] = useState(() => deGlobal(periodoGlobal).inicio);
  const [fim, setFimLocal] = useState(() => deGlobal(periodoGlobal).fim);

  // Período mudou (outra tela, outra aba, ou o próprio gravar() abaixo — idempotente, mesmo valor
  // de volta). Nunca sobrescreve um "custom" ainda incompleto: enquanto só uma das duas datas está
  // preenchida, nada foi gravado no global ainda, então ele não muda e este efeito não dispara.
  useEffect(() => {
    const d = deGlobal(periodoGlobal);
    setPeriodoLocal(d.periodo);
    setInicioLocal(d.inicio);
    setFimLocal(d.fim);
  }, [periodoGlobal]);

  function setPeriodo(p: PeriodoGa4) {
    setPeriodoLocal(p);
    if (p === 'custom') { setInicioLocal(''); setFimLocal(''); return; }
    setPeriodoGlobal({ tipo: 'preset', id: p });
  }
  function setInicio(v: string) {
    setInicioLocal(v);
    if (v && fim && v <= fim) setPeriodoGlobal({ tipo: 'custom', startDate: v, endDate: fim });
  }
  function setFim(v: string) {
    setFimLocal(v);
    if (inicio && v && inicio <= v) setPeriodoGlobal({ tipo: 'custom', startDate: inicio, endDate: v });
  }

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
