import { useState } from 'react';
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  ICONS,
  Icon,
  Input,
  KpiCard,
  KpiStrip,
  Modal,
  PageHeader,
  PageStack,
  Pagination,
  ProgressBar,
  SearchInput,
  Select,
  Skeleton,
  StatusBadge,
  Stepper,
  TabList,
  Textarea,
  Toolbar,
} from '../components/ds';
import { Drawer } from '../components/ds/Drawer';

// Contrato visual do design system (DESIGN.md): cada componente e estado da Fundação num lugar
// só, pra comparar antes/depois de cada fase. Não é uma página operacional.
interface Pedido {
  id: number;
  cliente: string;
  status: 'pago' | 'pendente';
  valor: string;
  itens: number;
}

const ROWS: Pedido[] = [
  { id: 1840203, cliente: 'Diego Arruda', status: 'pendente', valor: 'R$ 99,90', itens: 1 },
  { id: 1840204, cliente: 'Patrícia Lemos Guterres de Albuquerque', status: 'pago', valor: 'R$ 1.169,90', itens: 12 },
  { id: 1840205, cliente: 'Joaquim Farias', status: 'pago', valor: 'R$ 279,70', itens: 3 },
];

export function Playground() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [aba, setAba] = useState('ativas');
  const [etapa, setEtapa] = useState(1);

  return (
    <PageStack>
      <PageHeader
        title="Playground do design system"
        description="Componentes e estados da Fundação, na forma em que as páginas devem usá-los."
        meta={<span>Fonte: DESIGN.md · tokens em src/admin/design-system/tokens-base.css</span>}
        actions={[
          <Button key="s" variant="secondary">
            Ação secundária
          </Button>,
          <Button key="p">Ação primária</Button>,
        ]}
      />

      <Card title="Botões" description="primary · secondary · ghost · danger · danger-solid (só em confirmação) · desabilitado · sm · com ícone">
        <div className="ds-button-row">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="danger-solid">Danger solid</Button>
          <Button disabled>Disabled</Button>
          <Button variant="secondary" disabled>
            Secondary disabled
          </Button>
        </div>
        <div className="ds-button-row">
          <Button size="sm">Primary sm</Button>
          <Button size="sm" variant="secondary">
            Secondary sm
          </Button>
          <Button variant="secondary">
            <Icon name="plug" />
            Com ícone
          </Button>
          <button type="button" className="ds-icon-btn" aria-label="Fechar">
            <Icon name="close" size={18} />
          </button>
        </div>
      </Card>

      <Card title="Badges" description="Tons semânticos; rótulo e tom sempre de statusMap.ts">
        <div className="ds-button-row">
          <StatusBadge tone="success" label="Pago" />
          <StatusBadge tone="warning" label="Aguardando pagamento" />
          <StatusBadge tone="danger" label="Pagamento recusado" />
          <StatusBadge tone="info" label="Em trânsito" />
          <StatusBadge tone="neutral" label="Rascunho" />
          <StatusBadge tone="premium" label="Plano Completo" />
        </div>
      </Card>

      <Card title="Campos" description="Label associado ao controle · hint · erro · obrigatório · desabilitado">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, maxWidth: 'var(--form-max)' }}>
          <Field label="Nome da campanha" hint="Visível só para você." required>
            <Input placeholder="ex: Reativação 90 dias" />
          </Field>
          <Field label="Loja">
            <Select defaultValue="sul">
              <option value="sul">Use Sul</option>
              <option value="centro">Use Centro</option>
            </Select>
          </Field>
          <Field label="Telefone" error="Informe um telefone com DDD.">
            <Input defaultValue="4899" />
          </Field>
          <Field label="Cupom" optional>
            <Input disabled placeholder="Indisponível neste plano" />
          </Field>
          <Field label="Observação interna" optional>
            <Textarea placeholder="Notas que não aparecem para o cliente" />
          </Field>
        </div>
      </Card>

      <KpiStrip label="KPIs de exemplo">
        <KpiCard title="Pedidos hoje" value={42} delta="+12%" trend="up" helper="vs. ontem até esta hora" sparkline={[3, 5, 4, 8, 6, 9, 12]} />
        <KpiCard title="Receita estimada hoje" value="R$ 4.279,70" delta="-8%" trend="down" helper="vs. ontem até esta hora" />
        <KpiCard title="Carrinhos recuperáveis" value={39} helper="Com contato disponível agora" />
        <KpiCard title="Sincronizações" value="—" icon={ICONS.refresh} />
      </KpiStrip>

      <div className="ds-stack">
        <TabList
          label="Exemplo de abas"
          value={aba}
          onChange={setAba}
          items={[
            { value: 'ativas', label: 'Ativas', count: 3 },
            { value: 'agendadas', label: 'Agendadas', count: 0 },
            { value: 'encerradas', label: 'Encerradas', count: 12 },
          ]}
        />
        <Toolbar label="Filtrar pedidos de exemplo" end={<span className="ds-toolbar__meta">3 pedidos</span>}>
          <SearchInput aria-label="Buscar pedidos" placeholder="Buscar por cliente…" />
          <Select aria-label="Filtrar status" defaultValue="">
            <option value="">Status (todos)</option>
            <option value="pago">Pago</option>
          </Select>
          <Button variant="ghost">Limpar filtros</Button>
        </Toolbar>
        <DataTable
          label="Pedidos de exemplo"
          columns={[
            { key: 'id', label: 'Pedido', render: (r) => `#${r.id}`, sortValue: (r) => r.id },
            { key: 'cliente', label: 'Cliente', truncate: true, width: 240, sortValue: (r) => r.cliente },
            {
              key: 'status',
              label: 'Status',
              render: (r) => <StatusBadge tone={r.status === 'pago' ? 'success' : 'warning'} label={r.status === 'pago' ? 'Pago' : 'Aguardando pagamento'} />,
            },
            { key: 'itens', label: 'Itens', align: 'right', sortValue: (r) => r.itens },
            { key: 'valor', label: 'Valor', align: 'right' },
          ]}
          rows={ROWS}
          rowKey={(r) => r.id}
          onRowClick={() => setDrawerOpen(true)}
        />
        <Pagination label="Paginação de exemplo" page={1} totalPages={7} totalLabel="163 pedidos" onPrev={() => {}} onNext={() => {}} />
      </div>

      <Card title="Alertas, etapas e progresso" description="Callout por tom · Stepper de assistente · ProgressBar">
        <div className="ds-stack">
          <Callout tone="warning" title="18 pedidos com problema de pagamento" action={<Button variant="secondary" size="sm">Ver pedidos</Button>}>
            Recusa, expiração ou reembolso nos últimos 30 dias.
          </Callout>
          <Callout tone="info" title="O envio está pelo WhatsApp Web.">Templates da Meta não são usados nesse modo.</Callout>
          <Callout tone="danger" title="Não foi possível conectar à Reserva Ink.">Confira o token em Integrações.</Callout>
          <Stepper steps={['Campanha', 'Audiência', 'Template', 'Conteúdo', 'Revisão']} current={etapa} onSelect={setEtapa} canSelect label="Etapas de exemplo" />
          <ProgressBar value={38} max={120} label="Progresso de exemplo" showValue />
        </div>
      </Card>

      <Card title="Estados" description="Refinamento completo na Fase 6">
        <EmptyState title="Nenhum resultado" description="Ajuste os filtros." />
        <ErrorState description="Falha ao carregar dados de teste." />
        <Skeleton rows={2} />
      </Card>

      <Card title="Overlays">
        <div className="ds-button-row">
          <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
            Abrir drawer
          </Button>
          <Button variant="secondary" onClick={() => setModalOpen(true)}>
            Abrir modal
          </Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Confirmação destrutiva
          </Button>
        </div>
      </Card>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Drawer de teste" description="Superfície elevada, fechar com ícone">
        <p>Conteúdo do drawer.</p>
      </Drawer>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Modal de teste" confirmLabel="Confirmar" onConfirm={() => setModalOpen(false)}>
        <p>Conteúdo do modal.</p>
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Excluir segmento?"
        description="Campanhas já enviadas continuam no histórico."
        onConfirm={() => setConfirmOpen(false)}
      />
    </PageStack>
  );
}
