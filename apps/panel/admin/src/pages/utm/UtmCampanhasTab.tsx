import { useEffect, useState } from 'react';
import {
  Button, ConfirmDialog, DataTable, Drawer, EmptyState, ErrorState, RowActionsMenu, Select, Skeleton, Toolbar,
} from '../../components/ds';
import { copiar, formatData } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import {
  arquivarUtmCampaign, criarUtmCampaign, desarquivarUtmCampaign, duplicarUtmCampaign, editarUtmCampaign, excluirUtmCampaign,
  listUtmCampaigns, type UtmCampaign, type UtmCampaignInput, type UtmCampaignStatus, type UtmPreset,
} from '../../api/utm';
import { UtmBuilderForm } from './UtmBuilderForm';

// Lista de campanhas salvas (spec, Parte 5) — reutilizar é o objetivo (Duplicar), excluir é
// destrutivo e vive no menu ⋮ por linha, nunca num botão vermelho solto (mesmo padrão de
// Segmentos/Templates).
export function UtmCampanhasTab({ presets }: { presets: UtmPreset[] }) {
  const [status, setStatus] = useState<UtmCampaignStatus>('ativas');
  const [campanhas, setCampanhas] = useState<UtmCampaign[] | null>(null);
  const [erro, setErro] = useState('');
  const [drawerAberto, setDrawerAberto] = useState(false);
  const [editando, setEditando] = useState<UtmCampaign | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [excluindo, setExcluindo] = useState<UtmCampaign | null>(null);
  const [copiadoId, setCopiadoId] = useState<string | null>(null);

  function carregar() {
    setErro('');
    listUtmCampaigns({ status })
      .then((data) => setCampanhas(data.campanhas))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [status]);

  function salvar(input: UtmCampaignInput) {
    setSalvando(true);
    const promise = editando ? editarUtmCampaign(editando.id, input) : criarUtmCampaign(input);
    promise
      .then(() => {
        setDrawerAberto(false);
        setEditando(null);
        carregar();
      })
      .catch(() => {})
      .finally(() => setSalvando(false));
  }

  async function confirmarExclusao() {
    if (!excluindo) return;
    await excluirUtmCampaign(excluindo.id);
    setExcluindo(null);
    carregar();
  }

  return (
    <div className="ds-stack">
      <Toolbar
        label="Filtrar campanhas UTM"
        end={
          <Button onClick={() => { setEditando(null); setDrawerAberto(true); }}>Nova campanha</Button>
        }
      >
        <Select aria-label="Filtrar por status" value={status} onChange={(e) => setStatus(e.target.value as UtmCampaignStatus)}>
          <option value="ativas">Ativas</option>
          <option value="arquivadas">Arquivadas</option>
          <option value="todas">Todas</option>
        </Select>
      </Toolbar>

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !campanhas && <Skeleton variant="table" rows={6} />}
      {!erro && campanhas && campanhas.length === 0 && (
        <EmptyState
          title={status === 'arquivadas' ? 'Nenhuma campanha arquivada' : 'Nenhuma campanha UTM cadastrada'}
          description={status === 'arquivadas' ? undefined : 'Crie sua primeira campanha pra padronizar e acompanhar os links da loja.'}
          action={status === 'arquivadas' ? undefined : (
            <Button variant="secondary" onClick={() => { setEditando(null); setDrawerAberto(true); }}>Nova campanha</Button>
          )}
        />
      )}
      {!erro && campanhas && campanhas.length > 0 && (
        <DataTable
          label="Campanhas UTM"
          rows={campanhas}
          rowKey={(c) => c.id}
          onRowClick={(c) => { setEditando(c); setDrawerAberto(true); }}
          columns={[
            { key: 'nome', label: 'Nome', truncate: true, width: 200, render: (c) => c.nome, sortValue: (c) => c.nome },
            { key: 'loja', label: 'Loja', priority: 'low', muted: true, render: (c) => adminStores.name(c.loja) },
            { key: 'campaign', label: 'Campaign', muted: true, render: (c) => c.campaign },
            { key: 'source', label: 'Source', priority: 'low', muted: true, render: (c) => c.source },
            { key: 'medium', label: 'Medium', priority: 'low', muted: true, render: (c) => c.medium },
            { key: 'destino', label: 'Destino', priority: 'low', truncate: true, width: 220, muted: true, render: (c) => c.destinationUrl },
            { key: 'atualizado', label: 'Atualizado', align: 'right', muted: true, render: (c) => formatData(c.atualizadoEm), sortValue: (c) => c.atualizadoEm },
            {
              key: 'acoes',
              label: 'Ações',
              hideLabel: true,
              align: 'right',
              width: 56,
              render: (c) => (
                <RowActionsMenu
                  items={[
                    {
                      label: copiadoId === c.id ? 'Copiado!' : 'Copiar URL',
                      onSelect: () => copiar(c.fullUrl, () => { setCopiadoId(c.id); setTimeout(() => setCopiadoId(null), 1800); }),
                    },
                    { label: 'Abrir', onSelect: () => window.open(c.fullUrl, '_blank', 'noopener') },
                    { label: 'Editar', onSelect: () => { setEditando(c); setDrawerAberto(true); } },
                    { label: 'Duplicar', onSelect: () => duplicarUtmCampaign(c.id).then(carregar) },
                    c.arquivadaEm
                      ? { label: 'Desarquivar', onSelect: () => desarquivarUtmCampaign(c.id).then(carregar) }
                      : { label: 'Arquivar', onSelect: () => arquivarUtmCampaign(c.id).then(carregar) },
                    'separator',
                    { label: 'Excluir', variant: 'danger', onSelect: () => setExcluindo(c) },
                  ]}
                />
              ),
            },
          ]}
        />
      )}

      <Drawer
        open={drawerAberto}
        onClose={() => { setDrawerAberto(false); setEditando(null); }}
        title={editando ? `Editar "${editando.nome}"` : 'Nova campanha UTM'}
      >
        <UtmBuilderForm
          inicial={editando}
          presets={presets}
          salvando={salvando}
          onSalvar={salvar}
          onCancelar={() => { setDrawerAberto(false); setEditando(null); }}
        />
      </Drawer>

      <ConfirmDialog
        open={!!excluindo}
        onClose={() => setExcluindo(null)}
        title={`Excluir a campanha "${excluindo?.nome}"?`}
        description="Isso não afeta links que já foram compartilhados — só remove daqui da lista."
        onConfirm={confirmarExclusao}
      />
    </div>
  );
}
