import { useEffect, useState } from 'react';
import { DataTable, EmptyState, ErrorState, Input, PageHeader, PageStack, Pagination, Select, Skeleton, StatusBadge, Toolbar } from '../../components/ds';
import { Link } from 'react-router-dom';
import { adminStores } from '../../state/adminStores';
import { useLojaAtiva } from '../../auth/AuthContext';
import { formatData, plural } from '../../lib/format';
import { toneForGenericStatus } from '../../lib/statusMap';
import { listTrocas, type TrocaListItem, type TrocasListResponse } from '../../api/trocas';
import { TrocaDrawer, reasonLabel } from './TrocaDrawer';

import '../../pedidos-central.css';
import '../../trocas.css';

// Porte de src/trocas.js.
interface FiltroState {
  order_id: string;
  waiting_for_approval: string;
  begin_date: string;
  end_date: string;
  page: number;
}

function Filtros({ state, onChange }: { state: FiltroState; onChange: (patch: Partial<FiltroState>) => void }) {
  return (
    <Toolbar label="Filtrar trocas">
      <Input
        type="number"
        aria-label="Número do pedido"
        placeholder="Nº do pedido"
        defaultValue={state.order_id}
        onChange={(e) => onChange({ order_id: e.target.value })}
      />
      <Select aria-label="Situação da troca" defaultValue={state.waiting_for_approval} onChange={(e) => onChange({ waiting_for_approval: e.target.value })}>
        <option value="">Todas as trocas</option>
        <option value="true">Aguardando aprovação</option>
        <option value="false">Já avaliadas</option>
      </Select>
      <Input type="date" aria-label="Criada a partir de" defaultValue={state.begin_date} onChange={(e) => onChange({ begin_date: e.target.value })} />
      <Input type="date" aria-label="Criada até" defaultValue={state.end_date} onChange={(e) => onChange({ end_date: e.target.value })} />
    </Toolbar>
  );
}

export function TrocasPage() {
  const loja = useLojaAtiva() ?? '';
  const [state, setState] = useState<FiltroState>({ order_id: '', waiting_for_approval: '', begin_date: '', end_date: '', page: 1 });
  const [data, setData] = useState<TrocasListResponse | null>(null);
  const [erro, setErro] = useState('');
  const [drawer, setDrawer] = useState<{ loja: string; id: number } | null>(null);

  function carregar() {
    setErro('');
    setData(null);
    listTrocas({ ...state })
      .then(setData)
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [loja, state.order_id, state.waiting_for_approval, state.begin_date, state.end_date, state.page]);

  function onFiltroChange(patch: Partial<FiltroState>) {
    setState((s) => ({ ...s, ...patch, page: 1 }));
  }

  return (
    <PageStack>
      <PageHeader
        title="Trocas e devoluções"
        description="A aprovação é decidida pela Reserva Ink — aqui você cria e acompanha."
        actions={
          <Link to="/admin/trocas/nova" className="ds-btn ds-btn--primary">
            Nova troca
          </Link>
        }
      />
      <div className="ds-stack">
      <Filtros state={state} onChange={onFiltroChange} />

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !data && <Skeleton variant="table" rows={6} />}
      {!erro && data && (
        <>
          {data.erros && data.erros.length > 0 && (
            <p className="ds-note ds-note--warning">{plural(data.erros.length, 'loja', 'lojas')} com falha ao consultar a Reserva Ink agora.</p>
          )}

          {data.trocas.length === 0 ? (
            <EmptyState title="Nenhuma troca por aqui" description="Quando um pedido tiver uma troca, ela aparece nesta lista." />
          ) : (
            <>
              <DataTable
                label="Trocas e devoluções"
                rows={data.trocas}
                // Trocas só existem na API da Ink, que não ordena: ordenar a página visível daria a
                // impressão errada de ordenar o histórico inteiro.
                sortable={false}
                rowKey={(t) => t.id}
                onRowClick={(t: TrocaListItem) => setDrawer({ loja: t.loja, id: t.id })}
                columns={[
                  { key: 'id', label: 'Troca', render: (t) => `#${t.id}`, sortValue: (t) => Number(t.id) || null },
                  { key: 'loja', priority: 'low', label: 'Loja', muted: true, render: (t) => adminStores.name(t.loja), sortValue: (t) => adminStores.name(t.loja) },
                  {
                    key: 'pedido',
                    label: 'Pedido original',
                    render: (t) => (t.oldOrderId ? `#${t.oldOrderId}` : '—'),
                    sortValue: (t) => (t.oldOrderId ? Number(t.oldOrderId) : null),
                  },
                  {
                    key: 'motivo',
                    priority: 'low',
                    label: 'Motivo',
                    render: (t) => t.exchangeReasonLabel || reasonLabel(t.exchangeReason),
                    sortValue: (t) => t.exchangeReasonLabel || reasonLabel(t.exchangeReason),
                  },
                  {
                    key: 'cortesia',
                    priority: 'low',
                    label: 'Cortesia',
                    // Cortesia é tipo da troca, não plano: tom informativo (violeta fica só pra plano).
                    render: (t) => (t.isCourtesy ? <StatusBadge tone="info" label="Cortesia" /> : '—'),
                    sortValue: (t) => (t.isCourtesy ? 1 : 0),
                  },
                  {
                    key: 'status',
                    label: 'Status',
                    render: (t) => <StatusBadge tone={toneForGenericStatus(t.status)} label={t.status || '—'} />,
                    sortValue: (t) => t.status,
                  },
                  {
                    key: 'criada',
                    priority: 'low',
                    label: 'Criada em',
                    align: 'right',
                    muted: true,
                    render: (t) => (t.createdAt ? formatData(t.createdAt) : '—'),
                    sortValue: (t) => t.createdAt,
                  },
                ]}
              />
              {!data.approximated && (
                <Pagination
                  label="Paginação de trocas"
                  page={data.page}
                  totalPages={data.totalPages}
                  totalLabel={data.totalCount != null ? plural(data.totalCount, 'troca', 'trocas') : undefined}
                  onPrev={() => setState((s) => ({ ...s, page: s.page - 1 }))}
                  onNext={() => setState((s) => ({ ...s, page: s.page + 1 }))}
                />
              )}
            </>
          )}
        </>
      )}
      </div>

      {drawer && <TrocaDrawer loja={drawer.loja} id={drawer.id} onClose={() => setDrawer(null)} />}
    </PageStack>
  );
}
