import { useEffect, useState } from 'react';
import {
  Button, DataTable, EmptyState, ErrorState, Input, PageHeader, PageStack, Pagination, Select, Skeleton, StatusBadge, Toolbar, type TableSort,
} from '../../components/ds';
import { formatData, formatDia, formatValor, idadeDoCache, plural } from '../../lib/format';
import { lookup, ORDER_STATUS_MAP, PAYMENT_STATUS_MAP, type StatusEntry } from '../../lib/statusMap';
import { useLojaAtiva } from '../../auth/AuthContext';
import { adminStores } from '../../state/adminStores';
import { listPedidosCentral, type ListaPedidosCentral, type PedidoResumo } from '../../api/pedidosCentral';
import { PedidoCentralDrawer } from './PedidoCentralDrawer';

import '../../pedidos-central.css';

// Central de pedidos: toolbar com filtros rotulados, tabela e paginação de rodapé. A lista vem do
// cache Postgres por padrão, então ordenação e filtros valem pra todo o histórico (decisão D5 — a API
// da Ink não ordena). "Consultar direto na Ink" mostra o estado ao vivo, sem ordenação por coluna.
interface FiltrosState {
  payment_status: string;
  order_status: string;
  begin_date: string;
  end_date: string;
  page: number;
  sort: TableSort;
  fonte: 'auto' | 'ink';
}

const ORDENACAO_PADRAO: TableSort = { key: 'criado', direction: 'desc' };
const FILTROS_VAZIOS: FiltrosState = { payment_status: '', order_status: '', begin_date: '', end_date: '', page: 1, sort: ORDENACAO_PADRAO, fonte: 'auto' };

function statusOptions(map: Record<string, StatusEntry>) {
  return Object.entries(map).map(([key, v]) => [key, v.label] as const);
}

function Filtros({ state, onChange, onClear }: { state: FiltrosState; onChange: (patch: Partial<FiltrosState>) => void; onClear: () => void }) {
  const temFiltro = !!(state.payment_status || state.order_status || state.begin_date || state.end_date);
  return (
    <Toolbar label="Filtrar pedidos">
      <Select aria-label="Status de pagamento" value={state.payment_status} onChange={(e) => onChange({ payment_status: e.target.value })}>
        <option value="">Pagamento (todos)</option>
        {statusOptions(PAYMENT_STATUS_MAP).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </Select>
      <Select aria-label="Status do pedido" value={state.order_status} onChange={(e) => onChange({ order_status: e.target.value })}>
        <option value="">Status do pedido (todos)</option>
        {statusOptions(ORDER_STATUS_MAP).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </Select>
      <Input type="date" aria-label="Criado a partir de" value={state.begin_date} onChange={(e) => onChange({ begin_date: e.target.value })} />
      <Input type="date" aria-label="Criado até" value={state.end_date} onChange={(e) => onChange({ end_date: e.target.value })} />
      {temFiltro && (
        <Button variant="ghost" onClick={onClear}>
          Limpar filtros
        </Button>
      )}
    </Toolbar>
  );
}

export function PedidosCentralPage() {
  const loja = useLojaAtiva() ?? '';
  const [state, setState] = useState<FiltrosState>(FILTROS_VAZIOS);
  const [data, setData] = useState<ListaPedidosCentral | null>(null);
  const [erro, setErro] = useState('');
  const [drawer, setDrawer] = useState<{ loja: string; inkOrderId: string | number } | null>(null);

  function query() {
    const params = new URLSearchParams();
    (['payment_status', 'order_status', 'begin_date', 'end_date'] as const).forEach((k) => {
      if (state[k]) params.set(k, state[k]);
    });
    params.set('page', String(state.page));
    params.set('per_page', '20');
    if (state.fonte === 'ink') {
      params.set('fonte', 'ink');
    } else {
      params.set('sort', state.sort.key);
      params.set('order', state.sort.direction);
    }
    return params.toString();
  }

  function carregar() {
    setErro('');
    setData(null);
    listPedidosCentral(query())
      .then(setData)
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [loja, state.payment_status, state.order_status, state.begin_date, state.end_date, state.page, state.sort.key, state.sort.direction, state.fonte]);

  function onFiltroChange(patch: Partial<FiltrosState>) {
    setState((s) => ({ ...s, ...patch, page: 1 }));
  }

  return (
    <PageStack>
      <PageHeader title="Pedidos" description="Acompanhe pedidos, produção, entrega e pós-venda." />

      <div className="ds-stack">
        <Filtros state={state} onChange={onFiltroChange} onClear={() => setState((s) => ({ ...FILTROS_VAZIOS, sort: s.sort, fonte: s.fonte }))} />

        {erro && <ErrorState description={erro} onRetry={carregar} />}
        {!erro && !data && <Skeleton variant="table" rows={8} />}
        {!erro && data && (
          <>
            {!!data.erros?.length && <p className="ds-note ds-note--warning">{plural(data.erros.length, 'loja', 'lojas')} com falha ao consultar a Reserva Ink agora.</p>}

            {data.fonte === 'cache' ? (
              <div className="ds-note">
                <span className="ds-num">
                  Lista do histórico sincronizado
                  {data.cacheDesde ? ` · pedidos desde ${formatDia(data.cacheDesde)}` : ''}
                  {data.cacheSincronizadoEm ? ` · sincronizado ${idadeDoCache(data.cacheSincronizadoEm)}` : ''}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setState((s) => ({ ...s, fonte: 'ink', page: 1 }))}>
                  Consultar direto na Ink
                </Button>
              </div>
            ) : (
              <div className="ds-note">
                <span>Consulta ao vivo na Reserva Ink — ordenação por coluna indisponível (a API da Ink não ordena).</span>
                {state.fonte === 'ink' && (
                  <Button variant="ghost" size="sm" onClick={() => setState((s) => ({ ...s, fonte: 'auto', page: 1 }))}>
                    Voltar pro histórico completo
                  </Button>
                )}
              </div>
            )}

            {!data.pedidos.length ? (
              <EmptyState title="Nenhum pedido encontrado" description="Ajuste os filtros ou tente outro período." />
            ) : (
              <>
                <DataTable
                  label="Pedidos"
                  rows={data.pedidos}
                  rowKey={(p) => p.inkOrderId}
                  onRowClick={(p) => setDrawer({ loja: p.loja, inkOrderId: p.inkOrderId })}
                  sortable={data.fonte === 'cache'}
                  sort={state.sort}
                  onSortChange={(sort) => setState((s) => ({ ...s, sort, page: 1 }))}
                  columns={[
                    { key: 'pedido', priority: 'low', label: 'Pedido', render: (p: PedidoResumo) => `#${p.inkOrderId}`, sortValue: (p) => Number(p.inkOrderId) || null },
                    { key: 'loja', priority: 'low', label: 'Loja', muted: true, render: (p) => adminStores.name(p.loja), sortValue: (p) => adminStores.name(p.loja) },
                    { key: 'cliente', label: 'Cliente', truncate: true, width: 280, render: (p) => p.cliente || '—', sortValue: (p) => p.cliente },
                    { key: 'itens', priority: 'low', label: 'Itens', align: 'right', firstSortDirection: 'desc', render: (p) => p.itemsCount ?? '—', sortValue: (p) => p.itemsCount },
                    { key: 'valor', label: 'Valor', align: 'right', firstSortDirection: 'desc', render: (p) => formatValor(p.valor) || '—', sortValue: (p) => (p.valor != null ? Number(p.valor) : null) },
                    {
                      key: 'pagamento',
                      priority: 'low',
                      label: 'Pagamento',
                      render: (p) => <StatusBadge {...lookup(PAYMENT_STATUS_MAP, p.paymentStatus)} />,
                      sortValue: (p) => lookup(PAYMENT_STATUS_MAP, p.paymentStatus).label,
                    },
                    {
                      key: 'status',
                      label: 'Status',
                      render: (p) => <StatusBadge {...lookup(ORDER_STATUS_MAP, p.orderStatus)} />,
                      sortValue: (p) => lookup(ORDER_STATUS_MAP, p.orderStatus).label,
                    },
                    { key: 'criado', priority: 'low', label: 'Criado em', align: 'right', muted: true, firstSortDirection: 'desc', render: (p) => formatData(p.createdAt), sortValue: (p) => p.createdAt },
                  ]}
                />

                {!data.approximated && (
                  <Pagination
                    label="Paginação de pedidos"
                    page={data.page}
                    totalPages={data.totalPages}
                    totalLabel={data.totalCount != null ? plural(data.totalCount, 'pedido', 'pedidos') : undefined}
                    onPrev={() => setState((s) => ({ ...s, page: s.page - 1 }))}
                    onNext={() => setState((s) => ({ ...s, page: s.page + 1 }))}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>

      {drawer && <PedidoCentralDrawer loja={drawer.loja} inkOrderId={drawer.inkOrderId} onClose={() => setDrawer(null)} />}
    </PageStack>
  );
}
