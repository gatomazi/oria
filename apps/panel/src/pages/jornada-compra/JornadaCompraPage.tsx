import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button, Callout, Card, DataTable, EmptyState, ErrorState, Field, Input, KpiCard, KpiStrip,
  PageHeader, PageStack, Skeleton, StatusBadge, Tabs, Toolbar,
} from '../../components/ds';
import { formatValor } from '../../lib/format';
import {
  checkOrderTransactionLink, getJourneyAnalytics, getOpportunities,
  type JourneyAnalyticsResponse, type OrderTransactionLinkResponse, type OpportunitiesResponse, type Opportunity,
} from '../../api/journeyAnalytics';
import { STATUS_LABEL, statusTone, OPORTUNIDADE_TITULO, formatarEvidencia, CONFIANCA_LABEL, confiancaTone } from './formatadores';

import '../../pedidos-central.css';
import '../desempenho-produtos/desempenho-produtos.css';
import './jornada-compra.css';

const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const TRINTA_DIAS_ATRAS = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 29 * 86_400_000));

type Periodo = { startDate: string; endDate: string };

// Cabeçalho de painel com o status normalizado (Rodada L §2.2) — nunca um texto de erro cru, e
// nunca "0%"/"indisponível" fabricado quando o dado real é "não verificado ainda".
function CabecalhoDeFonte({ titulo, available, status, reason }: { titulo: string; available: boolean; status: string; reason: string | null }) {
  return (
    <div className="pa-fonte-cabecalho">
      <h3>{titulo}</h3>
      <StatusBadge tone={statusTone(status as never)} label={STATUS_LABEL[status as never] || status} />
      {!available && reason && <span className="pa-fonte-motivo">{reason}</span>}
    </div>
  );
}

// Gate C/D ("Jornada de Valor") · "Prioridades de hoje" — até 5 diagnósticos reais, com evidência
// numérica, hipótese (NUNCA causa comprovada — ver opportunity-diagnostics.js) e CTA funcional pra
// uma tela que já existe. Busca própria (endpoint próprio, GET /journey/opportunities) — nunca
// bloqueia nem é bloqueada pelo carregamento do resto da página.
function CartaoDeOportunidade({ op }: { op: Opportunity }) {
  const cta = op.product
    ? { href: `/admin/desempenho-produtos?productId=${encodeURIComponent(op.product.id)}`, label: 'Abrir produto' }
    : { href: '/admin/desempenho-produtos', label: 'Abrir Desempenho de Produtos' };
  return (
    <Card
      title={op.product ? `${OPORTUNIDADE_TITULO[op.type]} — ${op.product.name}` : OPORTUNIDADE_TITULO[op.type]}
      description={formatarEvidencia(op)}
      action={<StatusBadge tone={confiancaTone(op.confidence)} label={CONFIANCA_LABEL[op.confidence]} />}
    >
      <p className="pa-oportunidade-hipotese">{op.hypothesis}</p>
      <p className="pa-oportunidade-acao"><strong>O que investigar:</strong> {op.suggestedAction}</p>
      <Link to={cta.href} className="ds-btn ds-btn--secondary ds-btn--sm">{cta.label}</Link>
    </Card>
  );
}

function PrioridadesDeHoje({ periodo }: { periodo: Periodo }) {
  const [dados, setDados] = useState<OpportunitiesResponse | null>(null);
  const [erro, setErro] = useState('');

  function carregar() {
    setErro('');
    setDados(null);
    getOpportunities(periodo, { limit: 5 }).then(setDados).catch((err: Error) => setErro(err.message));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [periodo.startDate, periodo.endDate]);

  if (erro) return <ErrorState description={erro} onRetry={carregar} />;
  if (!dados) return <Skeleton rows={3} />;

  const semNenhumaFonte = !dados.sources.productFunnel.available && !dados.sources.commerceReconciliation.available;
  if (semNenhumaFonte) {
    return (
      <EmptyState
        title="Sem fonte conectada para diagnosticar oportunidades"
        description="Conecte o Google Analytics 4 e/ou o Commerce em Integrações para começar a ver prioridades aqui."
      />
    );
  }

  if (!dados.opportunities.length) {
    return (
      <Callout tone="info" title="Nenhuma prioridade encontrada neste período">
        Com o volume e a cobertura de dados atuais, nenhum produto se desviou o suficiente da própria Store pra virar uma prioridade — isso não significa que está tudo perfeito, só que não há evidência suficiente ainda.
      </Callout>
    );
  }

  return (
    <div className="ds-stack">
      {!dados.sources.commerceReconciliation.available && (
        <Callout tone="info" title="Diagnósticos só com GA4 nesta carga">
          {STATUS_LABEL[dados.sources.commerceReconciliation.status] || 'Commerce indisponível'} — sinais que comparam com pedidos confirmados (ex.: divergência de unidades) não aparecem até o Commerce estar conectado e no período coberto.
        </Callout>
      )}
      <div className="pa-oportunidades-grid">
        {dados.opportunities.map((op, i) => <CartaoDeOportunidade key={`${op.type}-${op.product?.id ?? 'store'}-${i}`} op={op} />)}
      </div>
      {dados.totalCandidates > dados.opportunities.length && (
        <p className="ds-note">Mostrando {dados.opportunities.length} de {dados.totalCandidates} sinais encontrados no período — os de maior prioridade primeiro.</p>
      )}
    </div>
  );
}

function VisaoGeral({ dados, periodo }: { dados: JourneyAnalyticsResponse; periodo: Periodo }) {
  const { tier1 } = dados;
  if (!tier1) return null;
  const { funnel, confirmedOrders, adsInvestment } = tier1;

  return (
    <div className="ds-stack">
      <Card title="Prioridades de hoje" description="Onde investigar primeiro, com evidência e ação sugerida — nunca causa comprovada.">
        <PrioridadesDeHoje periodo={periodo} />
      </Card>

      <Callout tone="info" title="Cada fonte mede uma coisa diferente — nunca somadas entre si">
        GA4 observa comportamento agregado por item; Meta Ads reporta o que a própria plataforma atribui à campanha; Commerce confirma a venda operacional. Divergência entre elas é diagnóstico, não erro.
      </Callout>

      <CabecalhoDeFonte titulo="GA4 — funil observado" available={funnel.available} status={funnel.status} reason={funnel.reason} />
      {funnel.available && funnel.observed ? (
        <KpiStrip label="Itens observados pelo GA4 no período (agregado por item, nunca por pedido)">
          <KpiCard title="Visualizados" value={funnel.observed.itemsViewed} />
          <KpiCard title="Adicionados ao carrinho" value={funnel.observed.itemsAddedToCart} />
          <KpiCard title="Em checkout" value={funnel.observed.itemsCheckedOut} />
          <KpiCard title="Comprados (observado)" value={funnel.observed.itemsPurchased} />
          <KpiCard title="Receita GA4" value={funnel.observed.itemRevenue != null ? formatValor(funnel.observed.itemRevenue) : null} />
        </KpiStrip>
      ) : (
        <EmptyState title="Funil GA4 indisponível" description={STATUS_LABEL[funnel.status as never] || funnel.reason || 'sem detalhe'} />
      )}

      <CabecalhoDeFonte titulo="Commerce — pedidos confirmados" available={confirmedOrders.available} status={confirmedOrders.status} reason={confirmedOrders.reason} />
      {confirmedOrders.available ? (
        <KpiStrip label="Venda operacional confirmada no período">
          <KpiCard title="Pedidos pagos" value={confirmedOrders.count} />
          <KpiCard title="Receita confirmada" value={confirmedOrders.revenue != null ? formatValor(confirmedOrders.revenue) : null} />
        </KpiStrip>
      ) : (
        <EmptyState title="Pedidos do Commerce indisponíveis" description={STATUS_LABEL[confirmedOrders.status as never] || confirmedOrders.reason || 'sem detalhe'} />
      )}

      <CabecalhoDeFonte titulo="Meta Ads — investimento e conversões reportadas" available={adsInvestment.available} status={adsInvestment.status} reason={adsInvestment.reason} />
      {adsInvestment.available ? (
        <KpiStrip label="Reportado pela própria plataforma — nunca pedido individual confirmado">
          <KpiCard title="Campanhas com investimento" value={adsInvestment.campaigns.length} />
          <KpiCard title="Investimento" value={formatValor(adsInvestment.campaigns.reduce((acc, c) => acc + (c.spend ?? 0), 0))} />
          <KpiCard title="Compras reportadas" value={adsInvestment.campaigns.reduce((acc, c) => acc + (c.purchases ?? 0), 0)} />
        </KpiStrip>
      ) : (
        <EmptyState title="Meta Ads indisponível" description={STATUS_LABEL[adsInvestment.status as never] || adsInvestment.reason || 'sem detalhe'} />
      )}
    </div>
  );
}

function Aquisicao({ dados }: { dados: JourneyAnalyticsResponse }) {
  const acq = dados.tier1?.acquisition;
  if (!acq) return null;
  if (!acq.available) return <EmptyState title="Aquisição por canal indisponível" description={STATUS_LABEL[acq.status as never] || acq.reason || 'sem detalhe'} />;
  if (!acq.rows.length) return <EmptyState title="Sem sessões com origem/mídia no período" description="Nenhuma linha de aquisição observada pelo GA4 entre as datas escolhidas." />;
  return (
    <div className="ds-stack">
      <Callout tone="info" title="Agregado por sessão, nunca por pedido individual">
        Origem/mídia/campanha vêm das dimensões de UTM manual do GA4 — sessão sem UTM aparece como &quot;(not set)&quot;, nunca escondida ou traduzida para um canal.
      </Callout>
      <DataTable
        label="Aquisição por canal/campanha"
        rows={acq.rows}
        rowKey={(r) => `${r.source}|${r.medium}|${r.campaign}`}
        columns={[
          { key: 'source', label: 'Origem', render: (r) => r.source },
          { key: 'medium', label: 'Mídia', render: (r) => r.medium },
          { key: 'campaign', label: 'Campanha', truncate: true, render: (r) => r.campaign },
          { key: 'sessions', label: 'Sessões', align: 'right', render: (r) => r.sessions ?? '—' },
          { key: 'ecommercePurchases', label: 'Compras (GA4)', align: 'right', render: (r) => r.ecommercePurchases ?? '—' },
          { key: 'totalRevenue', label: 'Receita', align: 'right', render: (r) => (r.totalRevenue != null ? formatValor(r.totalRevenue) : '—') },
        ]}
      />
    </div>
  );
}

function MetaAdsPainel({ dados }: { dados: JourneyAnalyticsResponse }) {
  const ads = dados.tier1?.adsInvestment;
  if (!ads) return null;
  if (!ads.available) return <EmptyState title="Meta Ads indisponível" description={STATUS_LABEL[ads.status as never] || ads.reason || 'sem detalhe'} />;
  if (!ads.campaigns.length) return <EmptyState title="Nenhuma campanha com investimento no período" description="A conta Meta Ads está conectada, mas nenhuma campanha teve investimento nas datas escolhidas." />;
  return (
    <div className="ds-stack">
      <Callout tone="warning" title="Números atribuídos pela própria plataforma">
        Investimento, cliques e conversões abaixo são o que a Meta reporta, segundo o modelo e a janela de atribuição dela — nunca pedidos individuais confirmados pelo Commerce.
      </Callout>
      <DataTable
        label="Campanhas Meta Ads"
        rows={ads.campaigns}
        rowKey={(c) => c.externalId}
        columns={[
          { key: 'name', label: 'Campanha', truncate: true, render: (c) => c.name },
          { key: 'spend', label: 'Investimento', align: 'right', render: (c) => (c.spend != null ? formatValor(c.spend) : '—') },
          { key: 'impressions', label: 'Impressões', align: 'right', priority: 'low', render: (c) => c.impressions ?? '—' },
          { key: 'clicks', label: 'Cliques', align: 'right', render: (c) => c.clicks ?? '—' },
          { key: 'purchases', label: 'Compras (reportadas)', align: 'right', render: (c) => c.purchases ?? '—' },
          { key: 'revenue', label: 'Receita (reportada)', align: 'right', render: (c) => (c.revenue != null ? formatValor(c.revenue) : '—') },
        ]}
      />
    </div>
  );
}

function VerificacaoSobDemanda({ periodo }: { periodo: Periodo }) {
  const [providerOrderId, setProviderOrderId] = useState('');
  const [resultado, setResultado] = useState<OrderTransactionLinkResponse | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');

  async function verificar() {
    if (!providerOrderId.trim()) return;
    setCarregando(true);
    setErro('');
    setResultado(null);
    try {
      setResultado(await checkOrderTransactionLink(periodo, providerOrderId.trim()));
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="ds-stack">
      <Field label="Verificar 1 pedido específico" hint="Id do pedido no Commerce (providerOrderId) — 1 chamada ao GA4, nunca uma varredura.">
        <Toolbar label="Verificação sob demanda">
          <Input value={providerOrderId} onChange={(e) => setProviderOrderId(e.target.value)} placeholder="Ex.: 12345" onKeyDown={(e) => e.key === 'Enter' && verificar()} />
          <Button onClick={verificar} disabled={carregando || !providerOrderId.trim()}>{carregando ? 'Verificando…' : 'Verificar'}</Button>
        </Toolbar>
      </Field>
      {erro && <ErrorState description={erro} onRetry={verificar} />}
      {resultado && (
        <Callout tone={resultado.linked ? 'success' : resultado.available ? 'info' : 'warning'} title={resultado.available ? (resultado.linked ? 'Transação vinculada' : 'Nenhuma transação GA4 encontrada para este pedido') : (STATUS_LABEL[resultado.status as never] || resultado.reason || 'Indisponível')}>
          {resultado.order && <div>Pedido {resultado.order.providerOrderId} · {formatValor(resultado.order.totalValue)}</div>}
          {resultado.linked && <div>GA4: {resultado.ga4Transactions ?? '—'} transação(ões), {resultado.ga4Revenue != null ? formatValor(resultado.ga4Revenue) : '—'}</div>}
        </Callout>
      )}
    </div>
  );
}

function Correlacao({ dados, periodo }: { dados: JourneyAnalyticsResponse; periodo: Periodo }) {
  const link = dados.tier2?.transactionOrderLink;
  if (!link) return null;
  return (
    <div className="ds-stack">
      <CabecalhoDeFonte titulo="Correlação transação (GA4) ↔ pedido (Commerce)" available={link.available} status={link.status} reason={link.reason} />
      {link.available ? (
        <>
          <Callout tone="info" title="Vínculo só por identificador igual — nunca por proximidade de horário, produto ou valor">
            Uma igualdade confirmada prova apenas que o mesmo id apareceu nos dois lados — nunca a sequência completa de eventos do cliente, nem qual anúncio causou a compra.
          </Callout>
          <KpiStrip label="Amostra verificada nesta carga (nunca todos os pedidos — ver aviso abaixo)">
            <KpiCard title="Pedidos verificados" value={link.checked} helper={link.sampled ? `amostra de ${link.sampleSize} de ${link.totalEligible} pedidos elegíveis` : 'cobre todos os pedidos elegíveis do período'} />
            <KpiCard title="Vínculos confirmados" value={link.linked} />
          </KpiStrip>
          {link.sampled && (
            <Callout tone="warning" title="Isto é uma amostra, não a cobertura total">
              Só os primeiros {link.sampleSize} de {link.totalEligible} pedidos pagos do período foram verificados nesta carga (nunca 1 chamada GA4 por pedido sem teto). Use a verificação abaixo para checar um pedido específico.
            </Callout>
          )}
          {link.links.length > 0 && (
            <DataTable
              label="Vínculos verificados"
              rows={link.links}
              rowKey={(l) => l.commerceOrderId}
              columns={[
                { key: 'providerOrderId', label: 'Pedido', render: (l) => l.providerOrderId },
                { key: 'linked', label: 'Vínculo', render: (l) => (l.linked ? <StatusBadge tone="success" label="Transação vinculada" /> : <StatusBadge tone="neutral" label="Sem vínculo confirmado" />) },
                { key: 'ga4Revenue', label: 'Receita GA4', align: 'right', render: (l) => (l.ga4Revenue != null ? formatValor(l.ga4Revenue) : '—') },
              ]}
            />
          )}
          <VerificacaoSobDemanda periodo={periodo} />
        </>
      ) : (
        <EmptyState title="Correlação transação↔pedido indisponível" description={STATUS_LABEL[link.status as never] || link.reason || 'sem detalhe'} />
      )}
    </div>
  );
}

function QualidadeDosDados({ dados }: { dados: JourneyAnalyticsResponse }) {
  const { tier1, tier2, tier3, coverage } = dados;
  if (!tier1 || !tier2 || !tier3 || !coverage) return null;
  const linhas = [
    { fonte: 'Funil GA4', ...tier1.funnel },
    { fonte: 'Aquisição GA4', ...tier1.acquisition },
    { fonte: 'Meta Ads', ...tier1.adsInvestment },
    { fonte: 'Pedidos Commerce', ...tier1.confirmedOrders },
    { fonte: 'Correlação transação↔pedido', ...tier2.transactionOrderLink },
    { fonte: 'Jornada individual (event-level)', ...tier3.individualJourney },
  ];
  return (
    <div className="ds-stack">
      <Callout tone="info" title="Ausência de uma fonte nunca derruba as demais">
        Cada linha reflete só a fonte dela. Um cliente pode ter só Commerce, Commerce+GA4, Commerce+Meta Ads, todas conectadas, ou nenhuma fonte de Ads/Analytics — a Jornada segue funcionando com o que houver.
      </Callout>
      <DataTable
        label="Status por fonte"
        rows={linhas}
        rowKey={(l) => l.fonte}
        columns={[
          { key: 'fonte', label: 'Fonte' },
          { key: 'status', label: 'Status', render: (l) => <StatusBadge tone={statusTone(l.status as never)} label={STATUS_LABEL[l.status as never] || l.status} /> },
          { key: 'reason', label: 'Detalhe', muted: true, truncate: true, render: (l) => l.reason ?? '—' },
        ]}
      />
      {tier3.individualJourney.available === false && (
        <Callout tone="info" title="Jornada individual por evento — ainda indisponível">
          Exige uma fonte de eventos com identificadores por cliente (`event_analytics`, capability `eventLevel`). Nenhuma fonte assim está conectada — o funil agregado e os vínculos de transação acima continuam funcionando normalmente sem ela.
        </Callout>
      )}
    </div>
  );
}

export function JornadaCompraPage() {
  const [periodo, setPeriodo] = useState<Periodo>({ startDate: TRINTA_DIAS_ATRAS, endDate: HOJE });
  const [dados, setDados] = useState<JourneyAnalyticsResponse | null>(null);
  const [erro, setErro] = useState('');

  function carregar() {
    setErro('');
    setDados(null);
    getJourneyAnalytics(periodo).then(setDados).catch((err: Error) => setErro(err.message));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [periodo.startDate, periodo.endDate]);

  return (
    <PageStack>
      <PageHeader
        title="Jornada de Compra"
        description="Funil e atribuição agregados a partir das integrações conectadas (GA4, Meta Ads, Commerce) — nunca instrumentação própria do StoreFront ou do checkout."
      />

      <div className="ds-stack">
        <Toolbar label="Filtrar por período">
          <Input type="date" aria-label="Início do período" value={periodo.startDate} max={periodo.endDate} onChange={(e) => setPeriodo((p) => ({ ...p, startDate: e.target.value }))} />
          <Input type="date" aria-label="Fim do período" value={periodo.endDate} min={periodo.startDate} max={HOJE} onChange={(e) => setPeriodo((p) => ({ ...p, endDate: e.target.value }))} />
        </Toolbar>

        {erro && <ErrorState description={erro} onRetry={carregar} />}
        {!erro && !dados && <Skeleton variant="table" rows={6} />}

        {!erro && dados && dados.status === 'insufficient_data' && (
          <Callout tone="info" title="Sem cobertura de histórico local suficiente para este período">
            {dados.historyStartsAt
              ? `O cache local de pedidos confiável nesta instalação só começa em ${dados.historyStartsAt}. Escolha um período a partir dessa data.`
              : 'Sem dado suficiente no período escolhido.'}
          </Callout>
        )}

        {!erro && dados && dados.status === 'ok' && (
          <Tabs
            label="Jornada de Compra"
            tabs={[
              { label: 'Visão geral', render: () => <VisaoGeral dados={dados} periodo={periodo} /> },
              { label: 'Aquisição', render: () => <Aquisicao dados={dados} /> },
              { label: 'Meta Ads', render: () => <MetaAdsPainel dados={dados} /> },
              { label: 'Correlação transação↔pedido', render: () => <Correlacao dados={dados} periodo={periodo} /> },
              { label: 'Qualidade dos dados', render: () => <QualidadeDosDados dados={dados} /> },
            ]}
          />
        )}
      </div>
    </PageStack>
  );
}
