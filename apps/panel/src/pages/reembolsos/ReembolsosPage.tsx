import { useLojaAtiva } from '../../auth/AuthContext';
import { useEffect, useState } from 'react';
import { Button, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, PageStack, Skeleton } from '../../components/ds';
import { RefundModal } from '../../components/RefundModal';
import { adminStores } from '../../state/adminStores';
import { formatData } from '../../lib/format';
import { listReembolsos, type ReembolsoListItem } from '../../api/reembolsos';
import { getPedidoCentral, type CentralOrder } from '../../api/trocas';

import '../../reembolsos.css';

// Porte de src/reembolsos.js.
export function ReembolsosPage() {
  const [reembolsos, setReembolsos] = useState<ReembolsoListItem[] | null>(null);
  const [erro, setErro] = useState('');
  const lojaBusca = useLojaAtiva() ?? '';
  const [pedidoId, setPedidoId] = useState('');
  const [buscaErro, setBuscaErro] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [modal, setModal] = useState<{ loja: string; order: CentralOrder } | null>(null);

  function carregar() {
    setErro('');
    setReembolsos(null);
    listReembolsos()
      .then((data) => setReembolsos(data.reembolsos))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, []);

  function buscarPedido() {
    const id = Number(pedidoId);
    setBuscaErro('');
    if (!Number.isInteger(id) || id <= 0) {
      setBuscaErro('Informe um número de pedido válido.');
      return;
    }
    setBuscando(true);
    getPedidoCentral(id)
      .then((data) => {
        setBuscando(false);
        setModal({ loja: lojaBusca, order: data.order });
      })
      .catch((err: Error) => {
        setBuscando(false);
        setBuscaErro(err.message);
      });
  }

  return (
    <PageStack>
      <PageHeader
        title="Reembolsos"
        description="Reembolsos feitos por este painel — a Reserva Ink não tem uma listagem global, só por pedido."
      />

      <div className="rb-busca">
        <Field label="Pedido">
          <Input type="number" placeholder="Nº do pedido" value={pedidoId} onChange={(e) => setPedidoId(e.target.value)} />
        </Field>
        <Button variant="secondary" disabled={buscando} onClick={buscarPedido}>
          Buscar pedido
        </Button>
      </div>
      {buscaErro && (
        <p className="ds-form-error" role="alert">
          {buscaErro}
        </p>
      )}

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !reembolsos && <Skeleton variant="table" rows={6} />}
      {!erro && reembolsos && reembolsos.length === 0 && (
        <EmptyState title="Nenhum reembolso registrado ainda" description="Busque um pedido acima pra começar um reembolso." />
      )}
      {!erro && reembolsos && reembolsos.length > 0 && (
        <DataTable
          rows={reembolsos}
          rowKey={(r) => r.entityId}
          columns={[
            { key: 'pedido', label: 'Pedido', render: (r) => `#${r.entityId.split(':')[1]}`, sortValue: (r) => Number(r.entityId.split(':')[1]) || null },
            { key: 'loja', priority: 'low', label: 'Loja', render: (r) => adminStores.name(r.loja), sortValue: (r) => adminStores.name(r.loja) },
            { key: 'cliente', label: 'Cliente', render: (r) => r.before?.cliente || '—', sortValue: (r) => r.before?.cliente },
            { key: 'tipo', priority: 'low', label: 'Tipo', render: (r) => (r.before?.isTotal ? 'Total' : 'Parcial'), sortValue: (r) => (r.before?.isTotal ? 1 : 0) },
            { key: 'motivo', priority: 'low', label: 'Motivo', render: (r) => r.before?.reason || '—', sortValue: (r) => r.before?.reason },
            { key: 'data', label: 'Data', render: (r) => formatData(r.criadoEm), sortValue: (r) => r.criadoEm },
          ]}
        />
      )}

      {modal && (
        <RefundModal
          open
          onClose={() => setModal(null)}
          order={modal.order}
          onDone={carregar}
        />
      )}
    </PageStack>
  );
}
