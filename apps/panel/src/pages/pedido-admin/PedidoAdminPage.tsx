import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, DataTable, EmptyState, PageHeader, RowActionsMenu, Skeleton, StatusBadge } from '../../components/ds';
import { copiar } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import { deletePedidoPix, listPedidosPix, syncPedidoPix, type PedidoPix } from '../../api/pedidoAdmin';

// Porte de src/pedido-admin.js (Fase 3, docs/plan.md).
function CopiarLinkButton({ pedidoId }: { pedidoId: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={() => copiar(window.location.origin + '/' + pedidoId, () => {
        setCopiado(true);
        setTimeout(() => setCopiado(false), 1800);
      })}
    >
      {copiado ? 'Copiado!' : 'Copiar link'}
    </Button>
  );
}

export function PedidoAdminPage() {
  const [pedidos, setPedidos] = useState<PedidoPix[] | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncErro, setSyncErro] = useState('');
  const [excluindo, setExcluindo] = useState<PedidoPix | null>(null);

  function carregar() {
    setPedidos(null);
    listPedidosPix().then((data) => setPedidos(data.pedidos || []));
  }

  useEffect(carregar, []);

  function sincronizar(p: PedidoPix) {
    setSyncErro('');
    setSyncing(p.id);
    syncPedidoPix(p.id)
      .then(carregar)
      .catch((err: Error) => setSyncErro(err.message))
      .finally(() => setSyncing(null));
  }

  async function confirmarExclusao() {
    if (!excluindo) return;
    await deletePedidoPix(excluindo.id);
    carregar();
  }

  return (
    <>
      <PageHeader
        title="Pedidos PIX"
        description="Links de pagamento Pix gerados manualmente ou vinculados a um pedido real da Reserva Ink."
        actions={[
          <a key="vincular" href="/admin/pedidos/vincular" className="ds-btn ds-btn--ghost">
            Vincular pedido da Reserva Ink
          </a>,
          <a key="novo" href="/admin/pedidos/novo" className="ds-btn ds-btn--primary">
            + Criar Pix manual
          </a>,
        ]}
      />

      {syncErro && <p className="ds-form-error">{syncErro}</p>}
      {!pedidos && <Skeleton rows={4} />}
      {pedidos && pedidos.length === 0 && <EmptyState title="Nenhum pedido cadastrado ainda" />}
      {pedidos && pedidos.length > 0 && (
        <DataTable
          rows={pedidos}
          rowKey={(p) => p.id}
          columns={[
            { key: 'cliente', label: 'Cliente', render: (p) => p.cliente || p.referencia || 'Pedido', sortValue: (p) => p.cliente || p.referencia },
            {
              key: 'loja',
              label: 'Loja',
              render: (p) => adminStores.name(p.loja) + (p.referencia && p.cliente ? ` · ref ${p.referencia}` : ''),
              sortValue: (p) => adminStores.name(p.loja),
            },
            // Valor é texto livre digitado no cadastro manual (ex.: "1.169,90") — exibido como veio, sem reinterpretar.
            { key: 'valor', label: 'Valor', align: 'right', render: (p) => (p.valor ? `R$ ${p.valor}` : '—'), sortValue: (p) => (p.valor ? Number(p.valor) : null) },
            {
              key: 'status',
              label: 'Status',
              render: (p) =>
                p.origem !== 'ink' ? (
                  <StatusBadge tone="neutral" label="Manual" />
                ) : (
                  <StatusBadge tone="info" label={p.orderStatusLabel || p.paymentStatus || 'Reserva Ink'} />
                ),
              sortValue: (p) => (p.origem !== 'ink' ? 'Manual' : p.orderStatusLabel || p.paymentStatus),
            },
            {
              key: 'acoes',
              label: '',
              render: (p) => (
                <div className="ds-button-row">
                  <CopiarLinkButton pedidoId={p.id} />
                  <RowActionsMenu
                    items={[
                      ...(p.origem === 'ink'
                        ? [{ label: syncing === p.id ? 'Sincronizando…' : 'Sincronizar', disabled: syncing === p.id, onSelect: () => sincronizar(p) }]
                        : []),
                      'separator' as const,
                      { label: 'Excluir', variant: 'danger' as const, onSelect: () => setExcluindo(p) },
                    ]}
                  />
                </div>
              ),
            },
          ]}
        />
      )}
      <ConfirmDialog
        open={!!excluindo}
        onClose={() => setExcluindo(null)}
        title="Excluir este link de pagamento?"
        onConfirm={confirmarExclusao}
      />
    </>
  );
}
