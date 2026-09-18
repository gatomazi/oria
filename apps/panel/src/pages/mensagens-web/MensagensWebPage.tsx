import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Callout, ConfirmDialog, DataTable, EmptyState, ErrorState, PageHeader, RowActionsMenu, Skeleton, StatusBadge } from '../../components/ds';
import { formatData } from '../../lib/format';
import { eventoLabel } from '../../lib/eventLabels';
import { adminStores } from '../../state/adminStores';
import { useWhatsappProvider } from '../../state/whatsappProvider';
import { excluirMensagemWeb, listarMensagensWeb, type MensagemWeb } from '../../api/whatsappWeb';

import '../../whatsapp-web.css';

// Mensagens do modo WhatsApp Web — o equivalente de Templates pra quem não usa a API da Meta.
// Sem aprovação: salvou, já pode vincular em Automações.
export const TIPO_MENSAGEM_LABEL: Record<MensagemWeb['tipo'], string> = {
  comum: 'Comum',
  pedido: 'Pedido',
  carrinho: 'Carrinho abandonado',
  campanha: 'Campanha',
};

export function MensagensWebPage() {
  const navigate = useNavigate();
  const provider = useWhatsappProvider();
  const [mensagens, setMensagens] = useState<MensagemWeb[] | null>(null);
  const [erro, setErro] = useState('');
  const [excluindo, setExcluindo] = useState<MensagemWeb | null>(null);

  function carregar() {
    setErro('');
    listarMensagensWeb()
      .then((data) => setMensagens(data.mensagens))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, []);

  async function confirmarExclusao() {
    if (!excluindo) return;
    await excluirMensagemWeb(excluindo.id);
    carregar();
  }

  const novoBtn = (
    <Link to="/admin/mensagens/nova" className="ds-btn ds-btn--primary">
      Nova mensagem
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Mensagens"
        description="Textos enviados pelo WhatsApp Web. Use *negrito*, _itálico_ e os dados do pedido ou do carrinho direto no texto."
        actions={novoBtn}
      />

      {provider === 'meta_api' && (
        <Callout tone="info" title="O envio está pela API da Meta.">
          Estas mensagens só são usadas no modo WhatsApp Web. Na API, as automações usam os <Link to="/admin/templates">templates aprovados</Link>.
        </Callout>
      )}

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !mensagens && <Skeleton variant="table" rows={6} />}
      {!erro && mensagens && mensagens.length === 0 && (
        <EmptyState title="Nenhuma mensagem ainda" description="Crie a primeira mensagem e vincule a um evento em Automações." action={<Link to="/admin/mensagens/nova" className="ds-btn ds-btn--secondary">Criar mensagem</Link>} />
      )}
      {!erro && mensagens && mensagens.length > 0 && (
        <DataTable
          rows={mensagens}
          rowKey={(m) => m.id}
          onRowClick={(m) => navigate(`/admin/mensagens/${m.id}`)}
          columns={[
            { key: 'nome', label: 'Mensagem', render: (m) => m.nome, sortValue: (m) => m.nome.toLowerCase() },
            { key: 'tipo', priority: 'low', label: 'Tipo', render: (m) => <StatusBadge tone="neutral" label={TIPO_MENSAGEM_LABEL[m.tipo]} />, sortValue: (m) => m.tipo },
            { key: 'texto', priority: 'low', label: 'Texto', render: (m) => <div className="wa-fila__texto-preview">{m.corpo}</div> },
            { key: 'versoes', priority: 'low', label: 'Versões', align: 'right', render: (m) => 1 + (m.variacoes?.length || 0), sortValue: (m) => 1 + (m.variacoes?.length || 0) },
            {
              key: 'automacoes',
              priority: 'low',
              label: 'Automações',
              render: (m) => (m.eventos.length ? m.eventos.map((v) => `${adminStores.name(v.loja)} · ${eventoLabel(v.evento)}`).join(', ') : '—'),
              sortValue: (m) => m.eventos.length,
            },
            { key: 'atualizado', priority: 'low', label: 'Atualizada em', align: 'right', muted: true, render: (m) => formatData(m.atualizadoEm), sortValue: (m) => m.atualizadoEm },
            {
              key: 'acoes',
              label: '',
              render: (m) => (
                <RowActionsMenu
                  items={[
                    { label: 'Editar', onSelect: () => navigate(`/admin/mensagens/${m.id}`) },
                    'separator',
                    { label: 'Excluir', variant: 'danger', onSelect: () => setExcluindo(m) },
                  ]}
                />
              ),
            },
          ]}
        />
      )}

      <ConfirmDialog
        open={!!excluindo}
        onClose={() => setExcluindo(null)}
        title={`Excluir a mensagem "${excluindo?.nome}"?`}
        description={excluindo && excluindo.eventos.length ? 'Ela está vinculada a automações: desvincule em Automações antes de excluir.' : undefined}
        onConfirm={confirmarExclusao}
      />
    </>
  );
}
