import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ConfirmDialog, DataTable, EmptyState, ErrorState, PageHeader, RowActionsMenu, Skeleton, StatusBadge } from '../../components/ds';
import { adminStores } from '../../state/adminStores';
import { formatData } from '../../lib/format';
import { lookup, CAMPANHA_STATUS_MAP } from '../../lib/statusMap';
import { useLojaAtiva } from '../../auth/AuthContext';
import { cancelarCampanha, duplicarCampanha, listCampanhas, type Campanha } from '../../api/campanhas';

import '../../../../src/pedidos-central.css';

// Porte da tela "Todas as campanhas" (spec, Parte 3). Cards de resumo (mensagens enviadas, taxa
// de entrega/leitura, cliques, receita) ficam de fora até a Fase 5/6 existir dado real de envio —
// mostrar isso agora seria inventar métrica (spec: "Não inventar métricas").
export function CampanhasPage() {
  const escopo = useLojaAtiva() ?? '';
  const navigate = useNavigate();
  const [campanhas, setCampanhas] = useState<Campanha[] | null>(null);
  const [erro, setErro] = useState('');
  const [cancelando, setCancelando] = useState<Campanha | null>(null);

  function carregar() {
    setErro('');
    listCampanhas()
      .then((data) => setCampanhas(data.campanhas))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [escopo]);

  async function confirmarCancelamento() {
    if (!cancelando) return;
    await cancelarCampanha(cancelando.id);
    setCancelando(null);
    carregar();
  }

  function duplicar(c: Campanha) {
    duplicarCampanha(c.id).then((data) => navigate(`/admin/campanhas/nova?editar=${data.campanha.id}`));
  }

  const novoBtn = (
    <Link to="/admin/campanhas/nova" className="ds-btn ds-btn--primary">
      Nova campanha
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Campanhas"
        description="Crie campanhas segmentadas para reativar clientes, divulgar ofertas e trabalhar sua base via WhatsApp."
        actions={novoBtn}
      />

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !campanhas && <Skeleton variant="table" rows={6} />}
      {!erro && campanhas && campanhas.length === 0 && (
        <EmptyState title="Nenhuma campanha criada ainda" description="Crie a primeira campanha pra começar a reativar clientes." action={<Link to="/admin/campanhas/nova" className="ds-btn ds-btn--secondary">Criar campanha</Link>} />
      )}
      {!erro && campanhas && campanhas.length > 0 && (
        <DataTable
          rows={campanhas}
          rowKey={(c) => c.id}
          onRowClick={(c) => navigate(c.status === 'draft' || c.status === 'scheduled' ? `/admin/campanhas/nova?editar=${c.id}` : `/admin/campanhas/${c.id}`)}
          columns={[
            { key: 'nome', label: 'Campanha', render: (c) => c.nome, sortValue: (c) => c.nome },
            { key: 'loja', priority: 'low', label: 'Loja', muted: true, render: (c) => adminStores.name(c.loja), sortValue: (c) => adminStores.name(c.loja) },
            { key: 'template', priority: 'low', label: 'Template / mensagem', render: (c) => c.mensagemWebNome || c.templateNome || '—' },
            {
              key: 'audiencia',
              priority: 'low',
              label: 'Público',
              render: (c) => (c.totalMatched != null ? `${c.totalMatched} encontrados` : '—'),
            },
            {
              key: 'status',
              label: 'Status',
              render: (c) => {
                const meta = lookup(CAMPANHA_STATUS_MAP, c.status);
                return <StatusBadge tone={meta.tone} label={meta.label} />;
              },
              sortValue: (c) => c.status,
            },
            { key: 'agendada', priority: 'low', label: 'Agendada para', align: 'right', muted: true, render: (c) => (c.agendadaPara ? formatData(c.agendadaPara) : '—') },
            { key: 'criada', priority: 'low', label: 'Criada em', align: 'right', muted: true, render: (c) => formatData(c.criadoEm), sortValue: (c) => c.criadoEm },
            {
              key: 'acoes',
              label: '',
              render: (c) => (
                <RowActionsMenu
                  items={[
                    ...(c.status === 'draft' || c.status === 'scheduled'
                      ? [{ label: 'Ver / editar', onSelect: () => navigate(`/admin/campanhas/nova?editar=${c.id}`) }]
                      : [{ label: 'Ver relatório', onSelect: () => navigate(`/admin/campanhas/${c.id}`) }]),
                    { label: 'Duplicar', onSelect: () => duplicar(c) },
                    ...(c.status === 'draft' || c.status === 'scheduled'
                      ? (['separator', { label: c.status === 'scheduled' ? 'Cancelar agendamento' : 'Excluir rascunho', variant: 'danger' as const, onSelect: () => setCancelando(c) }] as const)
                      : []),
                  ]}
                />
              ),
            },
          ]}
        />
      )}

      <ConfirmDialog
        open={!!cancelando}
        onClose={() => setCancelando(null)}
        title={`${cancelando?.status === 'scheduled' ? 'Cancelar o agendamento de' : 'Excluir o rascunho'} "${cancelando?.nome}"?`}
        onConfirm={confirmarCancelamento}
      />
    </>
  );
}
