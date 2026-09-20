import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Callout, Card, DataTable, Drawer, EmptyState, ErrorState, KpiCard, KpiStrip, Skeleton, type Column,
} from '../../components/ds';
import { idadeDoCache, plural } from '../../lib/format';
import {
  formatNumero, formatPercentual, formatReais, formatUtmDim, rotuloCampanhaGa4, valorUtmVazio,
} from '../../lib/ga4';
import { Ga4Toolbar } from '../analytics/Ga4Toolbar';
import { useGa4Escopo } from '../analytics/useGa4Escopo';
import {
  getGaPerformance, getGaPerformanceSerie,
  type GaPerformanceLinha, type GaPerformanceResposta, type GaPerformanceSerieDia,
} from '../../api/googleAnalytics';
import { GaSerieDiariaChart } from './charts/GaSerieDiariaChart';

import '../../analytics.css';

function chaveLinha(l: GaPerformanceLinha) {
  return `${l.source}|${l.medium}|${l.campaign}|${l.content}|${l.term}`;
}

function Chip({ valor, tipo }: { valor: string; tipo?: 'source' | 'medium' }) {
  if (valorUtmVazio(valor)) return <span className="ga-chip ga-chip--vazio">—</span>;
  return <span className={`ga-chip${tipo ? ` ga-chip--${tipo}` : ''}`} title={valor}>{valor}</span>;
}

// Performance real por GA4 (docs/claude-utm-tracker-ga4.md §16-21). Duas leituras separadas, porque
// são perguntas diferentes: "como foram as campanhas que EU cadastrei" e "o que mais trouxe tráfego
// pro site". Na prática quase tudo cai na segunda — o Meta preenche utm_campaign com o ID numérico
// do anúncio, então a lista crua vira um paredão de 18 dígitos se não for tratada.
export function UtmPerformanceTab() {
  const escopo = useGa4Escopo();
  const [dados, setDados] = useState<GaPerformanceResposta | null>(null);
  const [erro, setErro] = useState('');
  const [atualizando, setAtualizando] = useState(false);
  const [detalhe, setDetalhe] = useState<GaPerformanceLinha | null>(null);
  const [serie, setSerie] = useState<GaPerformanceSerieDia[] | null>(null);
  const [serieErro, setSerieErro] = useState('');

  const { loja, periodoChave } = escopo;

  function carregar(forcarAtualizacao = false) {
    if (!loja || !periodoChave) return;
    setErro('');
    if (forcarAtualizacao) setAtualizando(true); else setDados(null);
    getGaPerformance(periodoChave, { forcarAtualizacao })
      .then(setDados)
      .catch((err: Error) => setErro(err.message))
      .finally(() => setAtualizando(false));
  }

  useEffect(carregar, [loja, periodoChave]); // eslint-disable-line react-hooks/exhaustive-deps

  function abrirDetalhe(linha: GaPerformanceLinha) {
    setDetalhe(linha);
    setSerie(null);
    setSerieErro('');
    if (!periodoChave) return;
    getGaPerformanceSerie(periodoChave, linha)
      .then((r) => setSerie(r.serie))
      .catch((err: Error) => setSerieErro(err.message));
  }

  if (escopo.carregandoConexoes) return <Skeleton rows={1} height="88px" />;

  if (escopo.lojasConectadas.length === 0) {
    return (
      <Callout
        tone="info"
        title="Sem Google Analytics conectado ainda"
        action={<Link className="ds-btn ds-btn--secondary ds-btn--sm" to="/admin/integracoes">Conectar GA4</Link>}
      >
        Sessões, compras e receita por combinação de UTM aparecem aqui depois que o GA4 for conectado e uma
        propriedade for escolhida em Integrações.
      </Callout>
    );
  }

  const cadastradas = dados?.linhas.filter((l) => l.campanhaNome) || [];
  const outras = dados?.linhas.filter((l) => !l.campanhaNome) || [];
  const truncou = !!dados && dados.totalCombinacoes > dados.linhas.length;
  const maiorCadastrada = cadastradas.reduce((m, l) => Math.max(m, l.sessions), 0);
  const maiorOutras = outras.reduce((m, l) => Math.max(m, l.sessions), 0);

  return (
    <div className="ds-stack">
      <Ga4Toolbar
        label="Filtrar performance"
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
      {!erro && !dados && periodoChave && <Skeleton variant="table" rows={5} />}

      {!erro && dados && (
        <>
          <KpiStrip label="Resumo do período">
            <KpiCard title="Sessões" value={formatNumero(dados.totais.sessions)} />
            <KpiCard title="Usuários" value={formatNumero(dados.totais.users)} />
            <KpiCard title="Compras" value={formatNumero(dados.totais.purchases)} />
            <KpiCard title="Receita" value={formatReais(dados.totais.revenue)} />
            <KpiCard title="Conversão" value={formatPercentual(dados.totais.conversionRate, 2)} helper="compras / sessões" />
          </KpiStrip>

          {cadastradas.length > 0 && (
            <Card title="Minhas campanhas" description="Links criados no Construtor que tiveram tráfego no período." flush>
              <DataTable
                label="Campanhas cadastradas com tráfego"
                rows={cadastradas}
                rowKey={chaveLinha}
                onRowClick={abrirDetalhe}
                columns={colunas(true, maiorCadastrada)}
                defaultSort={{ key: 'sessions', direction: 'desc' }}
              />
            </Card>
          )}

          <Card
            title={cadastradas.length > 0 ? `Outras origens do site (${outras.length})` : `Origens do site (${outras.length})`}
            description={
              cadastradas.length > 0
                ? 'Tráfego com UTM que não veio do Construtor — anúncios do Meta, links de parceiros, e-mail.'
                : 'Nenhuma campanha do Construtor teve tráfego no período. Abaixo, tudo que o GA4 registrou com UTM.'
            }
            flush
          >
            {outras.length === 0 ? (
              <EmptyState
                title="Nenhuma sessão com UTM neste período"
                description="Quando um link com UTM trouxer visita, ele aparece aqui — mesmo sem ter sido criado no Construtor."
              />
            ) : (
              <DataTable
                label="Origens do site com UTM"
                rows={outras}
                rowKey={chaveLinha}
                onRowClick={abrirDetalhe}
                columns={colunas(false, maiorOutras)}
                defaultSort={{ key: 'sessions', direction: 'desc' }}
              />
            )}
          </Card>

          <p className="pc-nota">
            {dados.doCache ? `Dado em cache — atualizado ${idadeDoCache(dados.atualizadoEm)}. ` : 'Atualizado agora. '}
            {truncou && `Mostrando as ${dados.linhas.length} maiores de ${formatNumero(dados.totalCombinacoes)} combinações; os totais acima consideram todas. `}
            {`Combinação = ${plural(5, 'campo', 'campos')} de UTM juntos (source, medium, campaign, content, term).`}
          </p>
        </>
      )}

      <Drawer
        open={!!detalhe}
        onClose={() => setDetalhe(null)}
        title={detalhe ? (detalhe.campanhaNome || rotuloCampanhaGa4(detalhe.campaign).texto) : ''}
        description={detalhe ? `${formatUtmDim(detalhe.source)} · ${formatUtmDim(detalhe.medium)}` : undefined}
      >
        {detalhe && (
          <div className="ds-stack">
            <dl className="ga-utm-detalhe">
              <dt>utm_source</dt><dd><Chip valor={detalhe.source} tipo="source" /></dd>
              <dt>utm_medium</dt><dd><Chip valor={detalhe.medium} tipo="medium" /></dd>
              <dt>utm_campaign</dt><dd><Chip valor={detalhe.campaign} /></dd>
              <dt>utm_content</dt><dd><Chip valor={detalhe.content} /></dd>
              <dt>utm_term</dt><dd><Chip valor={detalhe.term} /></dd>
            </dl>

            <KpiStrip label="Totais da combinação">
              <KpiCard title="Sessões" value={formatNumero(detalhe.sessions)} />
              <KpiCard title="Compras" value={formatNumero(detalhe.purchases)} />
              <KpiCard title="Receita" value={formatReais(detalhe.revenue)} />
              <KpiCard title="Conversão" value={formatPercentual(detalhe.conversionRate, 2)} />
            </KpiStrip>

            {serieErro && <ErrorState description={serieErro} onRetry={() => abrirDetalhe(detalhe)} />}
            {!serieErro && !serie && <Skeleton rows={1} height="220px" />}
            {!serieErro && serie && serie.length === 0 && <EmptyState title="Sem sessões diárias neste período" />}
            {!serieErro && serie && serie.length > 0 && <GaSerieDiariaChart dados={serie} />}
          </div>
        )}
      </Drawer>
    </div>
  );
}

// Colunas das duas tabelas. Na de campanhas cadastradas o nome salvo é o rótulo; na de origens do
// site o rótulo é a própria campanha do GA4 (com ID de anúncio encurtado).
function colunas(cadastrada: boolean, maiorSessao: number): Column<GaPerformanceLinha>[] {
  return [
    {
      key: 'campanha',
      label: cadastrada ? 'Campanha' : 'Campanha / anúncio',
      width: 190,
      truncate: true,
      render: (l) => {
        if (cadastrada) return l.campanhaNome;
        const { texto } = rotuloCampanhaGa4(l.campaign);
        // title sempre com o valor cru: o rótulo é uma leitura, o dado do GA4 continua acessível.
        return <span title={l.campaign}>{texto}</span>;
      },
      sortValue: (l) => l.campanhaNome || l.campaign,
    },
    { key: 'source', label: 'Origem', width: 130, render: (l) => <Chip valor={l.source} tipo="source" />, sortValue: (l) => l.source },
    // Mídia sai no celular: é o campo mais inferível pela origem e o detalhe completo está no drawer.
    { key: 'medium', label: 'Mídia', width: 120, priority: 'low', render: (l) => <Chip valor={l.medium} tipo="medium" />, sortValue: (l) => l.medium },
    {
      key: 'participacao',
      label: 'Peso',
      width: 110,
      priority: 'low',
      // Escala pela MAIOR linha da lista, não pelo total: com 250 combinações, nenhuma passa de
      // ~10% do total e todas as barras viravam o mesmo toco. Aqui a barra compara as linhas entre
      // si. É só leitura relativa — o número exato está na coluna Sessões ao lado, então a barra
      // fica fora da árvore de acessibilidade em vez de anunciar uma segunda versão do mesmo dado.
      render: (l) => (
        <span className="ga-barra" aria-hidden="true">
          <span className="ga-barra__preenchimento" style={{ transform: `scaleX(${maiorSessao > 0 ? l.sessions / maiorSessao : 0})` }} />
        </span>
      ),
      sortValue: (l) => l.sessions,
    },
    { key: 'sessions', label: 'Sessões', align: 'right', render: (l) => formatNumero(l.sessions), sortValue: (l) => l.sessions, firstSortDirection: 'desc' },
    { key: 'users', label: 'Usuários', align: 'right', priority: 'low', muted: true, render: (l) => formatNumero(l.users), sortValue: (l) => l.users },
    { key: 'purchases', label: 'Compras', align: 'right', render: (l) => formatNumero(l.purchases), sortValue: (l) => l.purchases, firstSortDirection: 'desc' },
    { key: 'revenue', label: 'Receita', align: 'right', render: (l) => formatReais(l.revenue), sortValue: (l) => l.revenue, firstSortDirection: 'desc' },
    { key: 'conversao', label: 'Conversão', align: 'right', priority: 'low', muted: true, render: (l) => formatPercentual(l.conversionRate, 2), sortValue: (l) => l.conversionRate },
  ];
}
