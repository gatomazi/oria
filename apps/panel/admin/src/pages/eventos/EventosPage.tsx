import { useEffect, useState } from 'react';
import { Button, DataTable, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge } from '../../components/ds';
import { formatData } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import { getWebhookLog, type WebhookEvento } from '../../api/eventos';
import { eventoLabel } from '../../lib/eventLabels';
import { EventoDrawer } from './EventoDrawer';

import '../../../../src/pedidos-central.css';

// Porte de src/eventos.js.
type Filtro = 'todos' | 'pedidos' | 'carrinhos' | 'nao-verificados';

// A Reserva Ink não documenta os nomes de evento de carrinho — classificação por palavra-chave
// até confirmarmos com uma entrega real de "Carrinho Abandonado".
function classificar(nome: string | null): 'carrinhos' | 'pedidos' | 'outro' {
  if (!nome) return 'outro';
  const n = nome.toLowerCase();
  if (n.includes('cart') || n.includes('carrinho')) return 'carrinhos';
  return 'pedidos';
}

const FILTROS: [Filtro, string][] = [
  ['todos', 'Todos'],
  ['pedidos', 'Pedidos'],
  ['carrinhos', 'Carrinhos'],
  ['nao-verificados', 'Falhas de verificação'],
];

export function EventosPage() {
  const [todosEventos, setTodosEventos] = useState<WebhookEvento[] | null>(null);
  const [erro, setErro] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [eventoAberto, setEventoAberto] = useState<WebhookEvento | null>(null);

  useEffect(() => {
    setErro('');
    getWebhookLog()
      .then((data) => setTodosEventos(data.log || []))
      .catch((err: Error) => setErro(err.message));
  }, []);

  if (erro) {
    return (
      <>
        <PageHeader title="Webhooks e logs" />
        <ErrorState description={erro} />
      </>
    );
  }
  if (!todosEventos) return <Skeleton variant="table" rows={6} />;

  // O servidor já devolve só os eventos da Organization ativa.
  const eventos = todosEventos;
  const visiveis = eventos.filter((ev) => {
    if (filtro === 'todos') return true;
    if (filtro === 'nao-verificados') return !ev.verificado;
    return classificar(ev.eventName) === filtro;
  });

  return (
    <>
      <PageHeader title="Webhooks e logs" description={eventos.length === 1 ? 'Última entrega de webhook recebida da Reserva Ink.' : `Últimas ${eventos.length} entregas de webhook recebidas da Reserva Ink.`} />

      <div className="ds-button-row">
        {FILTROS.map(([valor, label]) => (
          <Button key={valor} variant={filtro === valor ? 'primary' : 'secondary'} onClick={() => setFiltro(valor)}>
            {label}
          </Button>
        ))}
      </div>

      {!visiveis.length ? (
        <EmptyState title="Nenhum evento encontrado" />
      ) : (
        <DataTable
          rows={visiveis}
          rowKey={(_ev, i) => i}
          onRowClick={setEventoAberto}
          columns={[
            { key: 'horario', label: 'Horário', muted: true, render: (ev) => formatData(ev.recebidoEm), sortValue: (ev) => ev.recebidoEm },
            { key: 'origem', priority: 'low', label: 'Origem', render: (ev) => (ev.loja ? adminStores.name(ev.loja) : '—'), sortValue: (ev) => (ev.loja ? adminStores.name(ev.loja) : null) },
            { key: 'evento', label: 'Evento', render: (ev) => (ev.eventName ? <span title={ev.eventName}>{eventoLabel(ev.eventName)}</span> : 'desconhecido'), sortValue: (ev) => ev.eventName },
            { key: 'entidade', priority: 'low', label: 'Entidade', render: (ev) => (ev.inkOrderId ? `#${ev.inkOrderId}` : '—'), sortValue: (ev) => (ev.inkOrderId ? Number(ev.inkOrderId) : null) },
            {
              key: 'status',
              label: 'Status',
              render: (ev) => <StatusBadge tone={ev.verificado ? 'success' : 'danger'} label={ev.verificado ? 'Verificado' : 'Não verificado'} />,
              sortValue: (ev) => (ev.verificado ? 1 : 0),
            },
          ]}
        />
      )}

      {eventoAberto && <EventoDrawer evento={eventoAberto} onClose={() => setEventoAberto(null)} />}
    </>
  );
}
