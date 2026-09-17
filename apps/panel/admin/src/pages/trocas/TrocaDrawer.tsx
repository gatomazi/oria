import { useEffect, useState } from 'react';
import { Drawer, ErrorState, Skeleton, StatusBadge } from '../../components/ds';
import { adminStores } from '../../state/adminStores';
import { EXCHANGE_REASONS, toneForGenericStatus } from '../../lib/statusMap';
import { formatData } from '../../lib/format';
import { getTroca, type TrocaDetalhe } from '../../api/trocas';

// Porte de abrirDrawer() em src/trocas.js.
function reasonLabel(value: string | null | undefined): string {
  const found = EXCHANGE_REASONS.find((r) => r.value === value);
  return found ? found.label : value || '—';
}

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="pc-kv__row">
      <span className="pc-kv__label">{label}</span>
      <span className="pc-kv__value">{value == null || value === '' ? '—' : String(value)}</span>
    </div>
  );
}

export function TrocaDrawer({ loja, id, onClose }: { loja: string; id: number; onClose: () => void }) {
  const [troca, setTroca] = useState<TrocaDetalhe | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    getTroca(id)
      .then((data) => setTroca(data.exchange))
      .catch((err: Error) => setErro(err.message));
  }, [loja, id]);

  return (
    <Drawer open onClose={onClose} title={`Troca #${id}`}>
      {erro && <ErrorState description={erro} />}
      {!erro && !troca && <Skeleton rows={4} />}
      {!erro && troca && (
        <>
          <div className="pc-drawer-header__badges">
            <StatusBadge tone={toneForGenericStatus(troca.status)} label={troca.status || '—'} />
            {troca.is_courtesy_exchange && <StatusBadge tone="info" label="Cortesia" />}
          </div>
          <div className="pc-kv ds-bloco-seguinte">
            <Row label="Loja" value={adminStores.name(loja)} />
            <Row label="Motivo" value={troca.exchange_reason_label || reasonLabel(troca.exchange_reason)} />
            <Row label="Pedido original" value={troca.old_order?.id ?? troca.old_external_order?.id} />
            <Row label="Novo pedido" value={troca.new_order?.id ?? troca.new_external_order?.id} />
            <Row label="Descrição do problema" value={troca.problem_description} />
            <Row label="Status de revisão do suporte" value={troca.support_review_status} />
            <Row label="Motivo de recusa" value={troca.refusal_reason_label || troca.refusal_reason} />
            <Row label="Nota de recusa" value={troca.refusal_note} />
            <Row label="Revisada em" value={troca.reviewed_at ? formatData(troca.reviewed_at) : null} />
          </div>
        </>
      )}
    </Drawer>
  );
}

export { reasonLabel };
