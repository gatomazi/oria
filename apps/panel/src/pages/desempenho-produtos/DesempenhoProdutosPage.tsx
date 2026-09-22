import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Callout, DataTable, EmptyState, ErrorState, Icon, Input, KpiCard, KpiStrip, PageHeader, PageStack, Pagination, Skeleton, StatusBadge, Tabs, Toolbar, type TableSort,
} from '../../components/ds';
import { formatValor, plural } from '../../lib/format';
import {
  getProductAnalyticsStatus, listProductAnalytics,
  type ProductAnalyticsItem, type ProductAnalyticsListResponse, type ProductAnalyticsSortField, type ProductAnalyticsStatus,
} from '../../api/productAnalytics';
import { ProdutoPerformanceDrawer } from './ProdutoPerformanceDrawer';
import { ReconciliacaoPanel } from './ReconciliacaoPanel';
import { formatarRazao, DIAGNOSTICO_LABEL, diagnosticoTone } from './formatadores';

import '../../pedidos-central.css';
import '../../produtos.css';
import './desempenho-produtos.css';

const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const TRINTA_DIAS_ATRAS = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 29 * 86_400_000));
const LIMIT = 20;

// Ordenação sempre feita no servidor, sobre o conjunto elegível INTEIRO da Store antes de paginar
// (Fase G.1) — nunca só a página visível (DataTable no modo controlado, ver TrocasPage/ProdutosPage).
const SORT_INICIAL: TableSort = { key: 'itemsPurchased', direction: 'desc' };

type Periodo = { startDate: string; endDate: string };

function Thumb({ item }: { item: ProductAnalyticsItem }) {
  if (item.product.imageUrl) return <img className="pr-thumb" src={item.product.imageUrl} alt="" loading="lazy" />;
  return (
    <div className="pr-thumb pr-thumb--placeholder" title="Sem foto">
      <Icon name="image" />
      <span className="ds-sr-only">Sem foto</span>
    </div>
  );
}

function ConexaoIndisponivel({ status }: { status: ProductAnalyticsStatus }) {
  if (!status.analytics.connected) {
    return (
      <Callout tone="warning" title="Google Analytics 4 não conectado">
        Conecte o GA4 e escolha uma propriedade em Integrações para ver o desempenho de produtos.
        <div className="pa-callout__acao">
          <Link to="/admin/integracoes" className="ds-btn ds-btn--secondary ds-btn--sm">Ir para Integrações</Link>
        </div>
      </Callout>
    );
  }
  if (status.analytics.apt === false) {
    return (
      <Callout tone="warning" title="Propriedade GA4 não está apta para Desempenho de Produtos">
        {status.analytics.reason === 'GA4_ITEM_ID_UNAVAILABLE'
          ? 'Esta propriedade não expõe a dimensão de item (itemId) — confirme que o rastreamento de e-commerce está ativo no GA4.'
          : 'Esta propriedade não expõe itens visualizados (itemsViewed) — confirme o rastreamento de e-commerce/eventos no GA4.'}
      </Callout>
    );
  }
  return null;
}

function VisaoGeral({ periodo, onAbrirProduto }: { periodo: Periodo; onAbrirProduto: (id: string) => void }) {
  const [sort, setSort] = useState<TableSort>(SORT_INICIAL);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ProductAnalyticsListResponse | null>(null);
  const [erro, setErro] = useState('');

  function carregar() {
    setErro('');
    setData(null);
    listProductAnalytics({
      startDate: periodo.startDate, endDate: periodo.endDate, limit: LIMIT,
      cursor: page > 1 ? String(page) : undefined,
      sort: sort.key as ProductAnalyticsSortField, sortDir: sort.direction,
    })
      .then(setData)
      .catch((err: Error) => setErro(err.message));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [periodo.startDate, periodo.endDate, sort.key, sort.direction, page]);

  function onSortChange(novo: TableSort) {
    setSort(novo);
    setPage(1);
  }

  if (erro) return <ErrorState description={erro} onRetry={carregar} />;
  if (!data) return <Skeleton variant="table" rows={6} />;

  const totalPages = Math.max(1, Math.ceil(data.totalCount / LIMIT));

  return (
    <div className="ds-stack">
      <KpiStrip label="Cobertura de identidade no período">
        <KpiCard title="Produtos no catálogo" value={data.totalCount} helper="Total da Store, com o filtro atual" />
        <KpiCard title="Ids observados pelo GA4" value={data.coverage.observedAnalyticsIds} helper="itemId distintos no período (produto, variante ou SKU)" />
        <KpiCard
          title="Identidade resolvida"
          value={data.coverage.status === 'insufficient_data' ? '—' : `${data.coverage.matchedAnalyticsIds}/${data.coverage.observedAnalyticsIds}`}
          helper={data.coverage.coverageRate != null ? `${Math.round(data.coverage.coverageRate * 100)}% de cobertura` : 'Sem dado suficiente no período'}
        />
      </KpiStrip>

      {data.coverage.status === 'insufficient_data' && (
        <Callout tone="info" title="Sem dados de analytics neste período">
          Nenhum evento foi observado pelo GA4 entre {periodo.startDate} e {periodo.endDate}. Isso não significa zero vendas — pode ser um período sem dado coletado ainda.
        </Callout>
      )}

      {data.items.length === 0 ? (
        <EmptyState title="Nenhum produto no catálogo" description="Sincronize o catálogo em Produtos para ver o desempenho aqui." />
      ) : (
        <>
          <DataTable
            label="Desempenho de produtos"
            rows={data.items}
            rowKey={(it) => it.product.id}
            onRowClick={(it: ProductAnalyticsItem) => onAbrirProduto(it.product.id)}
            sort={sort}
            onSortChange={onSortChange}
            columns={[
              { key: 'img', priority: 'low', label: 'Foto', hideLabel: true, width: 48, render: (it) => <Thumb item={it} /> },
              { key: 'name', label: 'Produto', truncate: true, width: 240, render: (it) => it.product.name },
              { key: 'provider', label: 'Origem', priority: 'low', muted: true, truncate: true, render: (it) => `${it.product.provider} · ${it.product.providerProductId}` },
              { key: 'itemsViewed', label: 'Visualizados', align: 'right', firstSortDirection: 'desc', render: (it) => it.metrics?.itemsViewed ?? '—' },
              { key: 'itemsAddedToCart', label: 'No carrinho', align: 'right', firstSortDirection: 'desc', priority: 'low', render: (it) => it.metrics?.itemsAddedToCart ?? '—' },
              { key: 'itemsCheckedOut', label: 'Em checkout', align: 'right', firstSortDirection: 'desc', priority: 'low', render: (it) => it.metrics?.itemsCheckedOut ?? '—' },
              { key: 'itemsPurchased', label: 'Comprados (obs.)', align: 'right', firstSortDirection: 'desc', render: (it) => it.metrics?.itemsPurchased ?? '—' },
              { key: 'itemRevenue', label: 'Receita GA4', align: 'right', firstSortDirection: 'desc', render: (it) => (it.metrics?.itemRevenue != null ? formatValor(it.metrics.itemRevenue) : '—') },
              {
                key: 'itemsPurchasedPerItemViewed', label: 'Compra/visualização', align: 'right', priority: 'low', firstSortDirection: 'desc',
                render: (it) => formatarRazao(it.itemRatios.itemsPurchasedPerItemViewed),
              },
              {
                key: 'diagnostico', label: 'Qualidade do dado', priority: 'low',
                render: (it) => (it.diagnostics.length === 0
                  ? <StatusBadge tone="success" label="Resolvido" />
                  : <StatusBadge tone={diagnosticoTone(it.diagnostics[0])} label={DIAGNOSTICO_LABEL[it.diagnostics[0]] || it.diagnostics[0]} />),
              },
            ]}
          />
          <Pagination
            label="Paginação de desempenho de produtos"
            page={page}
            totalPages={totalPages}
            totalLabel={plural(data.totalCount, 'produto', 'produtos')}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => data.nextCursor && setPage((p) => p + 1)}
          />
        </>
      )}
    </div>
  );
}

export function DesempenhoProdutosPage() {
  const [periodo, setPeriodo] = useState<Periodo>({ startDate: TRINTA_DIAS_ATRAS, endDate: HOJE });
  const [status, setStatus] = useState<ProductAnalyticsStatus | null>(null);
  const [statusErro, setStatusErro] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  useEffect(() => {
    getProductAnalyticsStatus().then(setStatus).catch((err: Error) => setStatusErro(err.message));
  }, []);

  const bloqueado = !!status && (!status.analytics.connected || status.analytics.apt === false);

  return (
    <PageStack>
      <PageHeader
        title="Desempenho de produtos"
        description="Itens observados pelo Google Analytics 4, por produto do catálogo — quantidades de item, nunca de usuário, sessão ou pedido."
      />

      <div className="ds-stack">
        <Toolbar label="Filtrar por período">
          <Input type="date" aria-label="Início do período" value={periodo.startDate} max={periodo.endDate} onChange={(e) => setPeriodo((p) => ({ ...p, startDate: e.target.value }))} />
          <Input type="date" aria-label="Fim do período" value={periodo.endDate} min={periodo.startDate} max={HOJE} onChange={(e) => setPeriodo((p) => ({ ...p, endDate: e.target.value }))} />
        </Toolbar>

        {statusErro && <ErrorState description={statusErro} onRetry={() => window.location.reload()} />}
        {!statusErro && !status && <Skeleton rows={3} />}
        {status && <ConexaoIndisponivel status={status} />}

        {!bloqueado && status && (
          <Tabs
            label="Desempenho de produtos"
            tabs={[
              { label: 'Visão geral', render: () => <VisaoGeral periodo={periodo} onAbrirProduto={setDrawerId} /> },
              { label: 'Reconciliação', render: () => <ReconciliacaoPanel periodo={periodo} /> },
            ]}
          />
        )}
      </div>

      {drawerId && <ProdutoPerformanceDrawer productId={drawerId} periodo={periodo} onClose={() => setDrawerId(null)} />}
    </PageStack>
  );
}
