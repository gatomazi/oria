import { useEffect, useState } from 'react';
import { Button, Drawer, EmptyState, ErrorState, MaskedValue, Skeleton, StatusBadge } from '../../components/ds';
import type { ReactNode } from 'react';
import { Tabs } from '../../components/Tabs';
import { RefundModal } from '../../components/RefundModal';
import { formatData, formatTelefone, formatValor } from '../../lib/format';
import { lookup, ORDER_STATUS_MAP, PAYMENT_STATUS_MAP, paymentMethodLabel } from '../../lib/statusMap';
import { getPedidoCentral, type Order, type TimelineEvento } from '../../api/pedidosCentral';

// Porte de abrirDrawer()/renderResumoTab()/renderItensTab()/renderEntregaTab()/renderTimelineTab()
// em src/pedidos-central.js. Botão "Reembolsar" (mesma ação de /admin/reembolsos, via
// RefundModal — porte de src/admin/refund-modal.js) aparece quando payment_status é paid/succeeded.

function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="pc-kv">
      {rows.map(([label, value]) => (
        <div className="pc-kv__row" key={label}>
          <span className="pc-kv__label">{label}</span>
          <span className="pc-kv__value">{value == null || value === '' ? '—' : typeof value === 'object' ? value : String(value)}</span>
        </div>
      ))}
    </div>
  );
}

function TabResumo({ order }: { order: Order }) {
  const buyer = order.buyer || {};
  const rows: [string, ReactNode][] = [
    ['Cliente', [buyer.first_name, buyer.last_name].filter(Boolean).join(' ')],
    ['E-mail', buyer.email],
    ['Telefone', formatTelefone(buyer.phone)],
    // D7: documento mascarado por padrão, revelado sob demanda.
    ['Documento', buyer.document ? <MaskedValue value={buyer.document} label="documento" /> : null],
    ['Valor total', formatValor(order.total_value)],
    ['Forma de pagamento', paymentMethodLabel(order.payment_method)],
    ['Criado em', formatData(order.created_at)],
  ];
  if (order.promotion_code) rows.push(['Cupom', order.promotion_code]);
  return <KV rows={rows} />;
}

function TabItens({ order }: { order: Order }) {
  const items = order.items || [];
  if (!items.length) return <EmptyState title="Sem itens" />;
  return (
    <div>
      {items.map((item) => {
        const nome = item.product_v2?.name || item.product_variant?.name || `Item #${item.id}`;
        return (
          <div className="pc-item-linha" key={item.id}>
            <span>
              {nome} · {item.quantity || 1}x
            </span>
            <span>{formatValor(item.total_value) || '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

function TabEntrega({ order }: { order: Order }) {
  const delivery = order.delivery || {};
  const rows: [string, ReactNode][] = [
    ['Transportadora', delivery.carrier],
    ['Modo de envio', delivery.shipping_type],
    ['Status atual', delivery.current_status],
    ['Previsão de entrega', delivery.estimated_delivery_date ? formatData(delivery.estimated_delivery_date) : null],
    ['Entregue em', delivery.delivered_at ? formatData(delivery.delivered_at) : null],
  ];
  return (
    <div>
      <KV rows={rows} />
      {order.tracking_url && (
        <a
          href={order.tracking_url}
          target="_blank"
          rel="noopener"
          className="ds-btn ds-btn--secondary ds-bloco-seguinte"
        >
          Abrir rastreio
        </a>
      )}
    </div>
  );
}

function TabTimeline({ order, timeline }: { order: Order; timeline?: TimelineEvento[] }) {
  const eventos = (timeline || [])
    .map((t) => ({ em: t.em, texto: 'Webhook: ' + (t.evento || '—') }))
    .concat((order.delivery?.history || []).map((h) => ({ em: h.created_at, texto: h.description || h.event || '—' })))
    .sort((a, b) => (b.em || '').localeCompare(a.em || ''));

  if (!eventos.length) return <EmptyState title="Sem eventos registrados ainda" />;
  return (
    <ul className="pc-timeline">
      {eventos.map((e, i) => (
        <li key={i}>
          <time>{formatData(e.em)}</time>
          {e.texto}
        </li>
      ))}
    </ul>
  );
}

export function PedidoCentralDrawer({
  loja,
  inkOrderId,
  onClose,
}: {
  loja: string;
  inkOrderId: string | number;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvento[] | undefined>(undefined);
  const [erro, setErro] = useState('');
  const [refundOpen, setRefundOpen] = useState(false);

  function carregar() {
    setErro('');
    setOrder(null);
    getPedidoCentral(inkOrderId)
      .then((data) => {
        setOrder(data.order);
        setTimeline(data.timeline);
      })
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [loja, inkOrderId]);

  const podeReembolsar = order && (order.payment_status === 'paid' || order.payment_status === 'succeeded');

  return (
    <Drawer
      open
      onClose={onClose}
      title={`#${inkOrderId}`}
      footer={
        podeReembolsar ? (
          <Button variant="danger" onClick={() => setRefundOpen(true)}>
            Reembolsar
          </Button>
        ) : undefined
      }
    >
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !order && <Skeleton rows={4} />}
      {!erro && order && (
        <>
          <div className="pc-drawer-header">
            <div>
              {[order.buyer && [order.buyer.first_name, order.buyer.last_name].filter(Boolean).join(' '), formatValor(order.total_value)]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <div className="pc-drawer-header__badges">
              <StatusBadge {...lookup(PAYMENT_STATUS_MAP, order.payment_status)} />
              <StatusBadge {...lookup(ORDER_STATUS_MAP, order.order_status)} />
            </div>
          </div>

          <Tabs
            tabs={[
              { label: 'Resumo', render: () => <TabResumo order={order} /> },
              { label: 'Itens', render: () => <TabItens order={order} /> },
              { label: 'Entrega', render: () => <TabEntrega order={order} /> },
              { label: 'Timeline', render: () => <TabTimeline order={order} timeline={timeline} /> },
            ]}
          />

          {podeReembolsar && (
            <RefundModal
              open={refundOpen}
              onClose={() => setRefundOpen(false)}
              order={{ ...order, id: Number(inkOrderId), items: order.items }}
              onDone={carregar}
            />
          )}
        </>
      )}
    </Drawer>
  );
}
