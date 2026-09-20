import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Callout, Card, EmptyState, ErrorState, KpiCard, KpiStrip, PageHeader, PageStack, Skeleton } from '../../components/ds';
import { idadeDoCache } from '../../lib/format';
import { formatDuracao, formatNumero, formatPercentual, formatReais } from '../../lib/ga4';
import { getGaOverview, type GaOverviewResposta } from '../../api/googleAnalytics';
import { FunilConversao } from './FunilConversao';
import { Ga4Toolbar } from './Ga4Toolbar';
import { ListaGrupoGa4 } from './ListaGrupoGa4';
import { MapaDeCalorGa4 } from './MapaDeCalorGa4';
import { GaSerieDiariaChart } from '../utm/charts/GaSerieDiariaChart';
import { useGa4Escopo } from './useGa4Escopo';

import '../../pedidos-central.css';
import '../../analytics.css';

// Panorama do GA4 da loja: funil, tráfego, receita, canais, dispositivos e horários. Todo número
// aqui vem da Data API — nada é estimado, e métrica que a loja não mede aparece como não medida em
// vez de zero. A leitura por campanha/UTM fica no UTM Tracker; esta tela é o retrato da loja.
export function AnalyticsGa4Page() {
  const escopo = useGa4Escopo();
  const [dados, setDados] = useState<GaOverviewResposta | null>(null);
  const [erro, setErro] = useState('');
  const [atualizando, setAtualizando] = useState(false);

  const { loja, periodoChave } = escopo;

  function carregar(forcarAtualizacao = false) {
    if (!loja || !periodoChave) return;
    setErro('');
    if (forcarAtualizacao) setAtualizando(true); else setDados(null);
    getGaOverview(periodoChave, { forcarAtualizacao })
      .then(setDados)
      .catch((err: Error) => setErro(err.message))
      .finally(() => setAtualizando(false));
  }

  useEffect(carregar, [loja, periodoChave]); // eslint-disable-line react-hooks/exhaustive-deps

  if (escopo.carregandoConexoes) {
    return (
      <PageStack>
        <PageHeader title="Analytics GA4" />
        <Skeleton rows={1} height="88px" />
      </PageStack>
    );
  }

  if (escopo.lojasConectadas.length === 0) {
    return (
      <PageStack>
        <PageHeader title="Analytics GA4" description="Retrato da loja no Google Analytics 4." />
        <Callout
          tone="info"
          title="Sem Google Analytics conectado ainda"
          action={<Link className="ds-btn ds-btn--secondary ds-btn--sm" to="/admin/integracoes">Conectar GA4</Link>}
        >
          Conecte a conta do Google e escolha a propriedade da loja em Integrações. Enquanto isso, nenhum
          número é exibido aqui — esta tela só mostra dado real vindo do GA4.
        </Callout>
      </PageStack>
    );
  }

  const t = dados?.totais;

  return (
    <PageStack>
      <PageHeader
        title="Analytics GA4"
        description="Retrato da loja no Google Analytics 4 — funil, canais, dispositivos e horários."
      />

      <Ga4Toolbar
        label="Filtrar panorama do Analytics"
        lojasConectadas={escopo.lojasConectadas}
        loja={escopo.loja}
        onLoja={escopo.setLoja}
        periodo={escopo.periodo}
        onPeriodo={escopo.setPeriodo}
        inicio={escopo.inicio}
        onInicio={escopo.setInicio}
        fim={escopo.fim}
        onFim={escopo.setFim}
        atualizando={atualizando}
        onAtualizar={() => carregar(true)}
        podeAtualizar={!!loja && !!periodoChave}
      />

      {escopo.periodo === 'custom' && !periodoChave && (
        <p className="pc-nota">Escolha as duas datas pra carregar o período personalizado.</p>
      )}

      {erro && <ErrorState description={erro} onRetry={() => carregar()} />}
      {!erro && !dados && periodoChave && (
        <div className="ds-stack">
          <Skeleton rows={1} height="88px" />
          <Skeleton rows={1} height="220px" />
          <Skeleton variant="table" rows={5} />
        </div>
      )}

      {!erro && dados && t && (
        <>
          <p className="pc-nota">
            {dados.doCache ? `Dado em cache — atualizado ${idadeDoCache(dados.atualizadoEm)}.` : 'Atualizado agora.'}
          </p>

          <Card title="Funil de conversão" description="Da sessão ao pedido — e quanto passa de uma etapa pra outra.">
            <FunilConversao totais={t} />
          </Card>

          <KpiStrip label="Tráfego">
            <KpiCard
              title="Usuários"
              value={formatNumero(t.users)}
              helper={`${formatNumero(t.newUsers)} novos · ${formatNumero(t.usuariosRecorrentes)} recorrentes`}
            />
            <KpiCard title="Sessões" value={formatNumero(t.sessions)} helper={`${(t.sessions / (t.users || 1)).toFixed(1).replace('.', ',')} por usuário`} />
            <KpiCard title="Páginas vistas" value={formatNumero(t.pageviews)} helper={`${t.pageviewsPorSessao.toFixed(1).replace('.', ',')} por sessão`} />
            <KpiCard title="Duração média" value={formatDuracao(t.avgSessionDuration)} helper={`rejeição ${formatPercentual(t.bounceRate, 0)}`} />
          </KpiStrip>

          <KpiStrip label="Receita">
            <KpiCard title="Receita" value={formatReais(t.revenue)} helper="no período" />
            <KpiCard title="Pedidos" value={formatNumero(t.purchases)} helper={`ticket médio ${formatReais(t.ticketMedio)}`} />
            {/* Sem o evento add_to_cart, um "0" grande leria como "ninguém carrinhou" — que é
                diferente de "a loja não mede isso". Travessão + helper contam a verdade. */}
            <KpiCard
              title="Carrinhos"
              value={t.addToCarts > 0 ? formatNumero(t.addToCarts) : '—'}
              helper={t.addToCarts > 0 ? `${formatPercentual(t.checkouts / t.addToCarts)} foram ao checkout` : 'evento add_to_cart não medido'}
            />
            <KpiCard title="Conversão" value={formatPercentual(t.conversionRate, 2)} helper="pedidos / sessões" />
          </KpiStrip>

          <Card title="Sessões e receita por dia">
            {dados.serie.length === 0
              ? <EmptyState title="Sem sessões no período" />
              : <GaSerieDiariaChart dados={dados.serie} />}
          </Card>

          <Card title="Canais de aquisição" description="De onde vêm as sessões, pelo agrupamento padrão do GA4.">
            {dados.canais.length === 0
              ? <EmptyState title="Sem canais no período" />
              : <ListaGrupoGa4 itens={dados.canais} rotuloColuna="Canal" />}
          </Card>

          <Card title="Dispositivos">
            {dados.dispositivos.length === 0
              ? <EmptyState title="Sem dados de dispositivo no período" />
              : <ListaGrupoGa4 itens={dados.dispositivos} rotuloColuna="Dispositivo" />}
          </Card>

          <Card title="Sessões por hora" description="Quando a loja tem gente online — referência pra post e disparo de WhatsApp.">
            {dados.horarios.length === 0
              ? <EmptyState title="Sem sessões no período" />
              : <MapaDeCalorGa4 horarios={dados.horarios} />}
          </Card>
        </>
      )}
    </PageStack>
  );
}
