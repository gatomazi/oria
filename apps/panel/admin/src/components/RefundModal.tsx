import { useState } from 'react';
import { Modal } from './ds/Modal';
import { formatValor } from '../lib/format';
import { criarReembolso } from '../api/reembolsos';

// Porte de src/admin/refund-modal.js — compartilhado entre /admin/reembolsos e a aba
// Reembolsos do drawer de Pedidos (a ação é a mesma). Vira componente controlado
// (`open`/`onClose`) em vez do `AdminRefundModal.open(loja, order, onDone)` imperativo.
//
// Tipo local deliberadamente mínimo (só os campos que este componente realmente lê) — não
// importa o `Order`/`CentralOrder` de nenhuma feature específica (trocas/pedidos-central), pra
// não acoplar este componente compartilhado ao shape mais rico que só uma dessas páginas precisa.
// Qualquer pedido real (de /admin/reembolsos, da Central de Pedidos etc.) já satisfaz isto.
export interface RefundOrderItem {
  id: number;
  quantity?: number;
  unit_value?: number | string;
  product_v2?: { name?: string };
}

export interface RefundOrder {
  id: number;
  items?: RefundOrderItem[];
}

interface RefundModalProps {
  open: boolean;
  onClose: () => void;
  order: RefundOrder;
  onDone: () => void;
}

export function RefundModal({ open, onClose, order, onDone }: RefundModalProps) {
  const [selecionados, setSelecionados] = useState<Record<number, number>>({});
  const [motivo, setMotivo] = useState('');
  const [confirmado, setConfirmado] = useState(false);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const items = order.items || [];

  function isTotal(): boolean {
    if (!items.length) return false;
    return items.every((it) => (selecionados[it.id] || 0) >= (it.quantity || 0));
  }

  function total(): number {
    let t = 0;
    items.forEach((it) => {
      const qty = selecionados[it.id] || 0;
      if (qty && it.unit_value != null) t += Number(it.unit_value) * qty;
    });
    return t;
  }

  function fechar() {
    setSelecionados({});
    setMotivo('');
    setConfirmado(false);
    setErro('');
    setSalvando(false);
    onClose();
  }

  function confirmar() {
    const ids = Object.keys(selecionados);
    if (!ids.length) return setErro('Selecione ao menos 1 item.');
    if (!motivo.trim()) return setErro('Informe o motivo do reembolso.');
    if (isTotal() && !confirmado) return setErro('Confirme o reembolso total antes de continuar.');

    setSalvando(true);
    criarReembolso(order.id, {
      reason: motivo.trim(),
      refundedItems: ids.map((id) => ({ order_item_id: Number(id), requested_quantity: selecionados[Number(id)] })),
      confirmadoTotal: isTotal() ? confirmado : undefined,
    })
      .then(() => {
        fechar();
        onDone();
      })
      .catch((err: Error) => {
        setSalvando(false);
        setErro(err.message);
      });
  }

  return (
    <Modal
      open={open}
      onClose={fechar}
      title={`Reembolsar pedido #${order.id}`}
      cancelLabel="Cancelar"
      confirmLabel="Reembolsar"
      confirmVariant="danger"
      confirmDisabled={salvando}
      onConfirm={confirmar}
    >
      <div>
        {items.map((item) => {
          const qty = selecionados[item.id];
          return (
            <div className="ds-check-row" key={item.id}>
              <input
                type="checkbox"
                checked={qty != null}
                onChange={(e) => {
                  const next = { ...selecionados };
                  if (e.target.checked) next[item.id] = item.quantity || 1;
                  else delete next[item.id];
                  setSelecionados(next);
                  setErro('');
                }}
              />
              <span className="ds-check-row__label">
                {item.product_v2?.name || `Item #${item.id}`} · até {item.quantity || 1}x
              </span>
              <input
                type="number"
                className="ds-input ds-input--sm"
                aria-label={`Quantidade a reembolsar de ${item.product_v2?.name || `item #${item.id}`}`}
                min="1"
                max={String(item.quantity || 1)}
                value={qty ?? item.quantity ?? 1}
                disabled={qty == null}
                onChange={(e) => {
                  if (qty == null) return;
                  setSelecionados({ ...selecionados, [item.id]: Number(e.target.value) || 1 });
                  setErro('');
                }}
              />
            </div>
          );
        })}
      </div>

      <p className="ds-form-note">Valor estimado: {formatValor(total()) || 'R$ 0,00'}</p>

      {isTotal() && (
        <label className="ds-check-row">
          <input type="checkbox" checked={confirmado} onChange={(e) => setConfirmado(e.target.checked)} />
          {' '}Esta é uma ação financeira. Confirmo o reembolso total deste pedido.
        </label>
      )}

      {erro && <p className="ds-form-error">{erro}</p>}
    </Modal>
  );
}
