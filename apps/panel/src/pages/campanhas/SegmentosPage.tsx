import { useLojaAtiva } from '../../auth/AuthContext';
import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, DataTable, Drawer, EmptyState, ErrorState, Field, Input, PageHeader, PageStack, RowActionsMenu, Skeleton } from '../../components/ds';
import { plural } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import { criarSegmento, editarSegmento, excluirSegmento, listSegmentos, type Segmento, type SegmentoInput } from '../../api/segments';
import { AudienceBuilder, audienceStateDeSalvo, audienceStateParaApi, audienceStateVazio, type AudienceState } from './AudienceBuilder';

import '../../pedidos-central.css';
import '../../campanhas.css';

// Porte do fluxo de "Segmentos" descrito em
// docs/PROMPT-CLAUDE-CAMPANHAS-REMARKETING-MIDIA-WHATSAPP.md (Parte 5) — um segmento é uma
// DEFINIÇÃO de filtro salva e dinâmica, nunca uma lista fixa de clientes. O snapshot de
// destinatários só nasce quando uma campanha de verdade dispara (Fase 5 do plano, ainda não
// implementada) — aqui é só construir e validar a audiência. Construtor de filtro reaproveitado
// de AudienceBuilder (mesmo componente usado na Etapa 2 do wizard de Nova Campanha).

function SegmentoForm({
  loja, inicial, onSalvar, onCancelar, salvando,
}: {
  loja: string;
  inicial: Segmento | null;
  onSalvar: (input: SegmentoInput) => void;
  onCancelar: () => void;
  salvando: boolean;
}) {
  const [nome, setNome] = useState(inicial?.nome || '');
  const [audiencia, setAudiencia] = useState<AudienceState>(
    inicial ? audienceStateDeSalvo(inicial.match, inicial.filtros, inicial.exclusoes) : audienceStateVazio(),
  );

  return (
    <div className="ad-segmento-form">
      <Field label="Nome do segmento">
        <Input type="text" placeholder="ex: Clientes inativos 90 dias" value={nome} onChange={(e) => setNome(e.target.value)} />
      </Field>

      <Field label="Loja" hint={`Prévia calculada pra ${adminStores.name(loja)} — trocar de loja no topo do painel muda isso.`}>
        <Input type="text" value={adminStores.name(loja)} disabled />
      </Field>

      <AudienceBuilder loja={loja} state={audiencia} onChange={setAudiencia} />

      <div className="ds-button-row">
        <Button variant="ghost" onClick={onCancelar}>Cancelar</Button>
        <Button
          disabled={salvando || !nome.trim()}
          onClick={() => {
            const { match, filtros, exclusoes } = audienceStateParaApi(audiencia);
            onSalvar({ nome: nome.trim(), match, filtros, exclusoes });
          }}
        >
          {salvando ? 'Salvando…' : 'Salvar segmento'}
        </Button>
      </div>
    </div>
  );
}

export function SegmentosPage() {
  const [segmentos, setSegmentos] = useState<Segmento[] | null>(null);
  const [erro, setErro] = useState('');
  const [drawerAberto, setDrawerAberto] = useState(false);
  const [editando, setEditando] = useState<Segmento | null>(null);
  const [excluindo, setExcluindo] = useState<Segmento | null>(null);
  const [salvando, setSalvando] = useState(false);
  // Prévia de audiência na loja da Organization ativa.
  const lojaPreview = useLojaAtiva() ?? '';

  function carregar() {
    setErro('');
    listSegmentos()
      .then((data) => setSegmentos(data.segmentos))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, []);

  function salvar(input: SegmentoInput) {
    setSalvando(true);
    const promise = editando ? editarSegmento(editando.id, input) : criarSegmento(input);
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
    await excluirSegmento(excluindo.id);
    setExcluindo(null);
    carregar();
  }

  return (
    <PageStack>
      <PageHeader
        title="Segmentos"
        description="Defina audiências dinâmicas pra reaproveitar em campanhas — não é uma lista fixa de clientes, recalcula toda vez que é usado."
        actions={
          <Button onClick={() => { setEditando(null); setDrawerAberto(true); }}>Novo segmento</Button>
        }
      />

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !segmentos && <Skeleton variant="table" rows={6} />}
      {!erro && segmentos && segmentos.length === 0 && (
        <EmptyState title="Nenhum segmento criado ainda" description="Crie um segmento pra reaproveitar essa audiência em campanhas futuras." />
      )}
      {!erro && segmentos && segmentos.length > 0 && (
        <DataTable
          label="Segmentos"
          rows={segmentos}
          rowKey={(s) => s.id}
          onRowClick={(s) => { setEditando(s); setDrawerAberto(true); }}
          columns={[
            { key: 'nome', label: 'Nome', render: (s) => s.nome, sortValue: (s) => s.nome },
            { key: 'match', priority: 'low', label: 'Lógica', render: (s) => (s.match === 'ANY' ? 'Qualquer condição' : 'Todas as condições') },
            { key: 'filtros', label: 'Filtros', align: 'right', render: (s) => plural(s.filtros?.length || 0, 'filtro', 'filtros') },
            { key: 'criadoEm', priority: 'low', label: 'Criado em', align: 'right', muted: true, render: (s) => new Date(s.criadoEm).toLocaleDateString('pt-BR') },
            {
              key: 'acoes',
              label: 'Ações',
              hideLabel: true,
              align: 'right',
              width: 56,
              // Mesmo padrão das demais listas: ações por linha no menu ⋮, destrutiva só após 1 clique de intenção.
              render: (s) => (
                <RowActionsMenu
                  items={[
                    { label: 'Editar', onSelect: () => { setEditando(s); setDrawerAberto(true); } },
                    'separator',
                    { label: 'Excluir', variant: 'danger', onSelect: () => setExcluindo(s) },
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
        title={editando ? `Editar "${editando.nome}"` : 'Novo segmento'}
      >
        <SegmentoForm
          loja={lojaPreview}
          inicial={editando}
          salvando={salvando}
          onSalvar={salvar}
          onCancelar={() => { setDrawerAberto(false); setEditando(null); }}
        />
      </Drawer>

      <ConfirmDialog
        open={!!excluindo}
        onClose={() => setExcluindo(null)}
        title={`Excluir o segmento "${excluindo?.nome}"?`}
        onConfirm={confirmarExclusao}
      />
    </PageStack>
  );
}
