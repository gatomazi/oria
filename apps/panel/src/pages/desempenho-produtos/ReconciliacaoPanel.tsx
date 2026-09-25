import { useEffect, useRef, useState } from 'react';
import { Callout, DataTable, EmptyState, ErrorState, Pagination, Skeleton, StatusBadge } from '../../components/ds';
import { formatValor, plural } from '../../lib/format';
import { getReconciliation, type ReconciliationItem, type ReconciliationResponse, type ReconciliationStatus } from '../../api/productAnalytics';

// I.4 — Reconciliação indicativa: Analytics (observado) versus Commerce (confirmado), lado a lado.
// `aligned`/`divergent` é SÓ diagnóstico com tolerância inicial de 10% — nunca prova de
// rastreamento correto nem de erro confirmado. `itemsPurchased` NUNCA é chamado de "pedidos pagos"
// aqui: são unidades observadas pelo Analytics, comparadas com unidades EM pedidos pagos.

// Paginação no servidor: o catálogo tem dezenas de milhares de produtos e só uma página vira linha.
const LIMIT = 25;

const STATUS_LABEL: Record<ReconciliationStatus, string> = {
  aligned: 'Alinhado (dentro da tolerância)',
  divergent: 'Divergente (fora da tolerância)',
  insufficient_identity: 'Identidade insuficiente',
  insufficient_data: 'Sem dado suficiente',
};

function toneDoStatus(status: ReconciliationStatus): 'success' | 'warning' | 'neutral' {
  if (status === 'aligned') return 'success';
  if (status === 'divergent') return 'warning';
  return 'neutral';
}

export function ReconciliacaoPanel({ periodo }: { periodo: { startDate: string; endDate: string } }) {
  const [data, setData] = useState<ReconciliationResponse | null>(null);
  const [page, setPage] = useState(1);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  // Só a resposta da consulta mais recente vale (trocar de página/período rápido não pode deixar uma
  // resposta atrasada sobrescrever a atual).
  const requisicao = useRef(0);

  function carregar() {
    const id = ++requisicao.current;
    setErro('');
    setCarregando(true);
    getReconciliation({ ...periodo, limit: LIMIT, cursor: page > 1 ? String(page) : undefined })
      .then((r) => { if (id === requisicao.current) setData(r); })
      .catch((err: Error) => { if (id === requisicao.current) setErro(err.message); })
      .finally(() => { if (id === requisicao.current) setCarregando(false); });
  }

  // Período novo volta pra primeira página.
  useEffect(() => { setPage(1); }, [periodo.startDate, periodo.endDate]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [periodo.startDate, periodo.endDate, page]);

  if (erro) return <ErrorState description={erro} onRetry={carregar} />;
  if (!data) return <Skeleton variant="table" rows={5} />;

  if (data.status === 'insufficient_data') {
    return (
      <Callout tone="info" title="Sem cobertura suficiente para reconciliar">
        {data.reason === 'LOCAL_ORDERS_HISTORY_STARTS_LATER'
          ? `O histórico local de pedidos só tem cobertura confiável a partir de ${data.historyStartsAt}. Escolha um período que comece nessa data ou depois.`
          : 'Não há dado suficiente para comparar Analytics e Commerce neste período.'}
      </Callout>
    );
  }

  return (
    <div className="ds-stack">
      <Callout tone="info" title="Ressalvas — leia antes de interpretar os números">
        <ul className="pa-caveats">
          {data.caveats.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </Callout>

      {data.items.length === 0 ? (
        <EmptyState title="Nada para reconciliar" description="Não há produto ativo (publicado) no catálogo para comparar neste período." />
      ) : (
        <div className={carregando ? 'pa-tabela pa-tabela--carregando' : 'pa-tabela'} aria-busy={carregando}>
          <p className="ds-note pa-ordem">
            Ordenado por volume — itens comprados observados no Analytics + unidades em pedidos pagos. Produtos sem nenhum dado vêm depois, por nome. Só produtos ativos (publicados na Ink).
          </p>
          <DataTable
            label="Reconciliação Analytics × Commerce"
            rows={data.items}
            sortable={false}
            rowKey={(it: ReconciliationItem) => it.product.id}
            columns={[
              { key: 'produto', label: 'Produto', truncate: true, render: (it) => it.product.name },
              {
                key: 'analytics', label: 'Analytics: itens comprados observados', align: 'right', priority: 'low',
                render: (it) => it.analyticsUnits ?? '—',
              },
              {
                key: 'commerce', label: 'Commerce: unidades em pedidos pagos', align: 'right', priority: 'low',
                render: (it) => it.commerceUnits ?? '—',
              },
              {
                key: 'receita-analytics', label: 'itemRevenue (GA4)', align: 'right', priority: 'low',
                render: (it) => (it.analyticsRevenue != null ? formatValor(it.analyticsRevenue) : '—'),
              },
              {
                key: 'receita-commerce', label: 'Receita operacional de itens', align: 'right', priority: 'low',
                render: (it) => (it.commerceRevenue != null ? formatValor(it.commerceRevenue) : '—'),
              },
              {
                key: 'pedidos', label: 'Pedidos pagos distintos', align: 'right', priority: 'low',
                render: (it) => it.paidOrdersDistinct,
              },
              {
                key: 'status', label: 'Diagnóstico',
                render: (it) => <StatusBadge tone={toneDoStatus(it.status)} label={STATUS_LABEL[it.status]} />,
              },
            ]}
            />
          <Pagination
            label="Paginação da reconciliação"
            page={page}
            totalPages={Math.max(1, Math.ceil((data.totalCount ?? data.items.length) / LIMIT))}
            totalLabel={plural(data.totalCount ?? data.items.length, 'produto', 'produtos')}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => data.nextCursor && setPage((p) => p + 1)}
          />
        </div>
      )}
    </div>
  );
}
