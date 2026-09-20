import { Link, useNavigate } from 'react-router-dom';
import { Callout, ConfirmDialog, DataTable, EmptyState, ErrorState, PageHeader, PageStack, RowActionsMenu, Skeleton, StatusBadge } from '../../components/ds';
import { eventoLabel, idiomaLabel, templateCategoriaLabel } from '../../lib/eventLabels';
import { adminStores } from '../../state/adminStores';
import { lookup, TEMPLATE_META_STATUS_MAP } from '../../lib/statusMap';
import { ApiError } from '../../api/client';
import { deleteTemplate, listTemplates, type WhatsappTemplate } from '../../api/templates';
import { useEffect, useState } from 'react';
import { useWhatsappProvider } from '../../state/whatsappProvider';

import '../../templates.css';
import '../../whatsapp-web.css';

// Porte de src/templates.js.
function statusCell(t: WhatsappTemplate) {
  const meta = lookup(TEMPLATE_META_STATUS_MAP, t.status);
  const badge = <StatusBadge tone={meta.tone} label={meta.label} />;
  if (t.status !== 'REJECTED' || !t.rejected_reason) return badge;
  return (
    <div>
      {badge}
      <div className="ds-form-note">{t.rejected_reason}</div>
    </div>
  );
}

export function TemplatesPage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<WhatsappTemplate[] | null>(null);
  const [erro, setErro] = useState('');
  // WhatsApp sem número cadastrado é um estado normal de quem ainda não configurou o canal, não uma
  // falha: a tela mostra o caminho (Integrações) em vez de "Não foi possível carregar".
  const [semNumero, setSemNumero] = useState(false);
  const [excluindo, setExcluindo] = useState<WhatsappTemplate | null>(null);
  const provider = useWhatsappProvider();

  function carregar() {
    setErro('');
    setSemNumero(false);
    listTemplates()
      .then((data) => setTemplates(data.templates || []))
      .catch((err: Error) => {
        if (err instanceof ApiError && err.codigo === 'WHATSAPP_SENDER_NOT_CONFIGURED') setSemNumero(true);
        else setErro(err.message);
      });
  }

  useEffect(carregar, []);

  async function confirmarExclusao() {
    if (!excluindo) return;
    await deleteTemplate(excluindo.name);
    carregar();
  }

  const novoBtn = (
    <Link to="/admin/templates/novo" className="ds-btn ds-btn--primary">
      Novo template
    </Link>
  );

  return (
    <PageStack>
      <PageHeader
        title="Templates"
        description="Fora da janela de 24h desde a última mensagem do cliente, o WhatsApp só permite mandar mensagem usando um template aprovado pela Meta."
        actions={novoBtn}
      />

      {provider === 'whatsapp_web' && (
        <Callout tone="info" title="O envio está pelo WhatsApp Web.">
          Templates da Meta não são usados nesse modo (não existem cabeçalho, rodapé nem botões no WhatsApp Web). As automações usam as{' '}
          <Link to="/admin/mensagens">Mensagens</Link>.
        </Callout>
      )}

      {semNumero && (
        <EmptyState
          title="WhatsApp sem número cadastrado"
          description="Cadastre o número do WhatsApp em Integrações pra criar e acompanhar os templates aprovados pela Meta."
          action={<Link to="/admin/integracoes" className="ds-btn ds-btn--secondary">Ir para Integrações</Link>}
        />
      )}
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !semNumero && !templates && <Skeleton variant="table" rows={6} />}
      {!erro && templates && templates.length === 0 && (
        <EmptyState title="Nenhum template ainda" description="Crie o primeiro template pra começar a automatizar mensagens." action={<Link to="/admin/templates/novo" className="ds-btn ds-btn--secondary">Criar template</Link>} />
      )}
      {!erro && templates && templates.length > 0 && (
        <DataTable
          label="Templates"
          rows={templates}
          rowKey={(t) => t.name}
          onRowClick={(t) => navigate(`/admin/templates/detalhe?nome=${encodeURIComponent(t.name)}`)}
          columns={[
            { key: 'nome', label: 'Template', render: (t) => t.name, sortValue: (t) => t.name },
            { key: 'categoria', priority: 'low', label: 'Categoria', muted: true, render: (t) => templateCategoriaLabel(t.category), sortValue: (t) => t.category },
            { key: 'status', label: 'Status na Meta', render: statusCell, sortValue: (t) => t.status },
            { key: 'idioma', priority: 'low', label: 'Idioma', muted: true, render: (t) => idiomaLabel(t.language), sortValue: (t) => t.language },
            {
              key: 'automacoes',
              priority: 'low',
              label: 'Automações',
              truncate: true,
              width: 320,
              render: (t) => (t.eventos && t.eventos.length ? t.eventos.map((v) => `${adminStores.name(v.loja)}: ${eventoLabel(v.evento)}`).join(', ') : '—'),
              sortValue: (t) => (t.eventos ? t.eventos.length : 0),
            },
            {
              key: 'acoes',
              label: 'Ações',
              hideLabel: true,
              align: 'right',
              width: 56,
              render: (t) => (
                <RowActionsMenu
                  items={[
                    { label: 'Ver detalhes', onSelect: () => navigate(`/admin/templates/detalhe?nome=${encodeURIComponent(t.name)}`) },
                    'separator',
                    { label: 'Excluir', variant: 'danger', onSelect: () => setExcluindo(t) },
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
        title={`Excluir o template "${excluindo?.name}" da Meta?`}
        onConfirm={confirmarExclusao}
      />
    </PageStack>
  );
}
