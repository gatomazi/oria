import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Callout, Card, DataTable, EmptyState, ErrorState, Field, FormActions, FormStack, Input, PageHeader, PageStack, Skeleton, StatusBadge } from '../../components/ds';
import { copiar, formatData } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import { listPedidosInkPendentes, vincularPedidoInk, type PedidoInkPendente } from '../../api/pedidoAdmin';

import '../../pedidos-central.css';

// Porte de src/pedido-vincular.js (Fase 3, docs/plan.md).
function ResultadoLink({ url }: { url: string }) {
  const [copiado, setCopiado] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [url]);

  return (
    <div ref={ref}>
      <Callout
        tone="success"
        title="Link de pagamento gerado"
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              copiar(url, () => {
                setCopiado(true);
                setTimeout(() => setCopiado(false), 1800);
              })
            }
          >
            {copiado ? 'Copiado!' : 'Copiar link'}
          </Button>
        }
      >
        <span className="ds-num">{url}</span>
      </Callout>
    </div>
  );
}

function PendentesCard({ vincular }: { vincular: (inkOrderId: string | number) => Promise<void> }) {
  const [pedidos, setPedidos] = useState<PedidoInkPendente[] | null>(null);
  const [erros, setErros] = useState<string[]>([]);
  const [erro, setErro] = useState('');
  const [selecionando, setSelecionando] = useState<string | number | null>(null);

  function carregar() {
    setErro('');
    setPedidos(null);
    listPedidosInkPendentes()
      .then((data) => {
        setPedidos(data.pedidos || []);
        setErros(data.erros || []);
      })
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, []);

  function selecionar(p: PedidoInkPendente) {
    setSelecionando(p.inkOrderId);
    vincular(p.inkOrderId)
      .then(carregar)
      .catch(() => {})
      .finally(() => setSelecionando(null));
  }

  return (
    <Card title="Pedidos com Pix pendente">
      <p className="pc-nota">Buscados na Reserva Ink (últimos 7 dias) — clique num pedido pra gerar o link sem digitar o ID.</p>
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !pedidos && <Skeleton rows={3} />}
      {!erro && pedidos && pedidos.length === 0 && <EmptyState title="Nenhum pedido com Pix pendente nos últimos 7 dias" />}
      {!erro && pedidos && pedidos.length > 0 && (
        <DataTable
          rows={pedidos}
          rowKey={(p) => p.inkOrderId}
          columns={[
            {
              key: 'cliente',
              label: 'Cliente',
              render: (p) => (p.cliente || 'Sem nome') + (p.valor ? ` · R$ ${p.valor}` : ''),
              sortValue: (p) => p.cliente,
            },
            {
              key: 'detalhe',
              label: 'Loja / Pedido',
              render: (p) =>
                [adminStores.name(p.loja), p.rsvFactoryId ? `#${p.rsvFactoryId}` : `#${p.inkOrderId}`, formatData(p.criadoEm)]
                  .filter(Boolean)
                  .join(' · '),
              sortValue: (p) => adminStores.name(p.loja),
            },
            {
              key: 'status',
              label: 'Status',
              render: (p) => (p.jaVinculado ? <StatusBadge tone="info" label="Já vinculado" /> : '—'),
              sortValue: (p) => (p.jaVinculado ? 1 : 0),
            },
            {
              key: 'acoes',
              label: '',
              render: (p) => (
                <Button variant="ghost" disabled={selecionando === p.inkOrderId} onClick={() => selecionar(p)}>
                  {p.jaVinculado ? 'Atualizar link' : 'Gerar link'}
                </Button>
              ),
            },
          ]}
        />
      )}
      {!!erros.length && <p className="ds-form-error">Falha ao buscar pendentes de: {erros.map((id) => adminStores.name(id)).join(', ')}</p>}
    </Card>
  );
}

function InkFormCard({ vincular }: { vincular: (inkOrderId: string | number) => Promise<void> }) {
  const [inkId, setInkId] = useState('');
  const [erro, setErro] = useState('');
  const [buscando, setBuscando] = useState(false);

  function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    setErro('');
    setBuscando(true);
    vincular(inkId)
      .catch((err: Error) => setErro(err.message))
      .finally(() => setBuscando(false));
  }

  return (
    <Card title="Ou vincular pelo ID manualmente">
      <FormStack onSubmit={handleSubmit}>
        <Field label="ID do pedido na Reserva Ink" required>
          <Input type="number" min={1} required value={inkId} onChange={(e) => setInkId(e.target.value)} />
        </Field>
        {erro && (
          <p className="ds-form-error" role="alert">
            {erro}
          </p>
        )}
        <FormActions>
          <Button type="submit" disabled={buscando}>
            {buscando ? 'Buscando…' : 'Buscar e vincular'}
          </Button>
        </FormActions>
      </FormStack>
    </Card>
  );
}

export function PedidoVincularPage() {
  const [resultadoUrl, setResultadoUrl] = useState<string | null>(null);

  function vincular(inkOrderId: string | number) {
    return vincularPedidoInk(inkOrderId).then((data) => {
      setResultadoUrl(window.location.origin + data.url);
    });
  }

  return (
    <PageStack>
      <PageHeader
        title="Vincular pedido"
        description="Gere a hotpage de pagamento pra um pedido real da Reserva Ink que ainda não tem uma."
        back={{ to: '/admin/pedidos', label: 'Voltar pra lista' }}
      />

      {resultadoUrl && <ResultadoLink url={resultadoUrl} />}

      <div className="ad-vincular-grid">
        <PendentesCard vincular={vincular} />
        <InkFormCard vincular={vincular} />
      </div>
    </PageStack>
  );
}
