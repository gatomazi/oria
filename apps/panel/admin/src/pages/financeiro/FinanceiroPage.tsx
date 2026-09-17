import { useEffect, useState } from 'react';
import { DataTable, EmptyState, ErrorState, KpiCard, KpiStrip, PageHeader, PageStack, Skeleton, StatusBadge, Tabs } from '../../components/ds';
import { movementTypeLabel, paymentMethodLabel, toneForGenericStatus } from '../../lib/statusMap';
import { useLojaAtiva } from '../../auth/AuthContext';
import { formatData, formatDia, formatValor } from '../../lib/format';
import {
  getAntecipacoes,
  getMovimentacoes,
  getResumo,
  getSaques,
  type Antecipacao,
  type Movimento,
  type Saque,
} from '../../api/financeiro';

import '../../../../src/dashboard.css';
import '../../../../src/pedidos-central.css';

// Porte de src/financeiro.js. Usava .rc-tabs/.rc-tab (de src/recuperacao.css) — versão quase
// idêntica ao componente Tabs compartilhado, só que duplicada (achado do refinamento visual).
// Consolidado pro Tabs de ../../components/Tabs.

function MovimentacoesTab({ loja }: { loja: string }) {
  const [linhas, setLinhas] = useState<Movimento[] | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    getMovimentacoes()
      .then((data) => {
        const out: Movimento[] = [];
        (data.extrato || []).forEach((dia) => (dia.movements || []).forEach((m) => out.push({ ...m, date: m.date || dia.date })));
        setLinhas(out);
      })
      .catch((err: Error) => setErro(err.message));
  }, [loja]);

  if (erro) return <ErrorState description={erro} />;
  if (!linhas) return <Skeleton rows={6} height="36px" />;
  if (!linhas.length) return <EmptyState title="Nenhuma movimentação nesse período" />;

  return (
    <DataTable
      label="Movimentações"
      rows={linhas}
      rowKey={(_, i) => i}
      columns={[
        // Extrato é por dia: hora 00:00 não informa nada.
        { key: 'data', label: 'Data', muted: true, render: (m) => formatDia(m.date), sortValue: (m) => m.date },
        { key: 'tipo', label: 'Tipo', render: (m) => movementTypeLabel(m.type) || '—', sortValue: (m) => movementTypeLabel(m.type) },
        { key: 'pedido', priority: 'low', label: 'Pedido', render: (m) => (m.order_id ? `#${m.order_id}` : '—'), sortValue: (m) => (m.order_id ? Number(m.order_id) : null) },
        {
          key: 'descricao',
          priority: 'low',
          label: 'Descrição',
          truncate: true,
          width: 360,
          // "pix" cru vira "Pix"; demais descrições da Ink seguem como vieram.
          render: (m) => (m.description && /^[a-z_]+$/.test(m.description) ? paymentMethodLabel(m.description) : m.description) || '—',
          sortValue: (m) => m.description,
        },
        { key: 'valor', label: 'Valor', align: 'right', render: (m) => formatValor(m.amount) || '—', sortValue: (m) => (m.amount != null ? Number(m.amount) : null) },
      ]}
    />
  );
}

function AntecipacoesTab({ loja }: { loja: string }) {
  const [lista, setLista] = useState<Antecipacao[] | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    getAntecipacoes()
      .then((data) => setLista(data.antecipacoes || []))
      .catch((err: Error) => setErro(err.message));
  }, [loja]);

  if (erro) return <ErrorState description={erro} />;
  if (!lista) return <Skeleton rows={4} />;
  if (!lista.length) return <EmptyState title="Nenhuma antecipação registrada" />;

  return (
    <DataTable
      label="Antecipações"
      rows={lista}
      rowKey={(_, i) => i}
      columns={[
        { key: 'data', label: 'Data', muted: true, render: (a) => (a.date ? formatData(a.date) : '—') },
        {
          key: 'status',
          label: 'Status',
          // Enum não documentado pela Ink: tom por palavra-chave, texto cru sempre visível.
          render: (a) => (a.status ? <StatusBadge tone={toneForGenericStatus(a.status)} label={a.status.charAt(0).toUpperCase() + a.status.slice(1)} /> : '—'),
        },
        { key: 'bruto', priority: 'low', label: 'Valor bruto', align: 'right', render: (a) => formatValor(a.gross_amount) || '—' },
        { key: 'liquido', label: 'Valor líquido', align: 'right', render: (a) => formatValor(a.net_amount) || '—' },
      ]}
    />
  );
}

function SaquesTab({ loja }: { loja: string }) {
  const [lista, setLista] = useState<Saque[] | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    getSaques()
      .then((data) => setLista(data.saques || []))
      .catch((err: Error) => setErro(err.message));
  }, [loja]);

  if (erro) return <ErrorState description={erro} />;
  if (!lista) return <Skeleton rows={4} />;
  if (!lista.length) {
    return <EmptyState title="Nenhum saque registrado" description="Solicitação de saque não é feita por este painel — use o painel da Reserva Ink." />;
  }

  return (
    <DataTable
      label="Saques"
      rows={lista}
      rowKey={(_, i) => i}
      columns={[
        { key: 'data', label: 'Data', muted: true, render: (s) => formatData(s.created_at) },
        { key: 'valor', label: 'Valor', align: 'right', render: (s) => formatValor(s.amount) || '—' },
      ]}
    />
  );
}

export function FinanceiroPage() {
  const lojaSelecionada = useLojaAtiva() ?? '';
  const lojaReal = lojaSelecionada;
  const [resumo, setResumo] = useState<{ available: string | null; pending: string | null } | null>(null);
  const [resumoErro, setResumoErro] = useState('');

  useEffect(() => {
    setResumoErro('');
    setResumo(null);
    getResumo()
      .then((data) => setResumo({ available: formatValor(data.saldo.available), pending: formatValor(data.saldo.pending) }))
      .catch((err: Error) => setResumoErro(err.message));
  }, [lojaReal]);

  return (
    <PageStack>
      <PageHeader
        title="Financeiro"
        description={
          'Somente leitura — saque e antecipação são solicitados no painel da Reserva Ink.'
        }
      />

      {resumoErro ? (
        <ErrorState description={resumoErro} />
      ) : (
        <KpiStrip label="Saldo na Reserva Ink" className="ad-kpi-strip--estreita">
          <KpiCard title="Saldo disponível" value={resumo ? resumo.available || 'R$ 0,00' : '—'} />
          <KpiCard title="Saldo pendente" value={resumo ? resumo.pending || 'R$ 0,00' : '—'} />
        </KpiStrip>
      )}

      <Tabs
        label="Extrato financeiro"
        tabs={[
          { label: 'Movimentações', render: () => <MovimentacoesTab loja={lojaReal} /> },
          { label: 'Antecipações', render: () => <AntecipacoesTab loja={lojaReal} /> },
          { label: 'Saques', render: () => <SaquesTab loja={lojaReal} /> },
        ]}
      />
    </PageStack>
  );
}
