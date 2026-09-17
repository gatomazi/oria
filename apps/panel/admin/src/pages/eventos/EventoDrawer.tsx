import { Disclosure, Drawer } from '../../components/ds';
import { formatData } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import type { WebhookEvento } from '../../api/eventos';

// Porte de abrirDrawer() em src/eventos.js.
export function EventoDrawer({ evento, onClose }: { evento: WebhookEvento; onClose: () => void }) {
  const linhas: [string, string | null][] = [
    ['Loja', evento.loja ? adminStores.name(evento.loja) : null],
    ['Evento', evento.eventName],
    ['Pedido', evento.inkOrderId ? `#${evento.inkOrderId}` : null],
    ['Verificado', evento.verificado ? 'Sim' : 'Não'],
    ['Método de autenticação', evento.metodoAuth],
    ['Recebido em', formatData(evento.recebidoEm)],
  ];

  return (
    <Drawer open onClose={onClose} title={evento.eventName || 'Evento'}>
      <div className="pc-kv">
        {linhas.map(([label, value]) => (
          <div className="pc-kv__row" key={label}>
            <span className="pc-kv__label">{label}</span>
            <span className="pc-kv__value">{value == null || value === '' ? '—' : value}</span>
          </div>
        ))}
      </div>
      <div className="ds-bloco-seguinte">
        <Disclosure summary="Detalhes técnicos">
          <pre className="ds-code-block">{JSON.stringify({ headers: evento.headers, body: evento.body }, null, 2)}</pre>
        </Disclosure>
      </div>
    </Drawer>
  );
}
