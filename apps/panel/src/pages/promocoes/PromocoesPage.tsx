import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, PageHeader, PageStack, RowActionsMenu, Skeleton, TabList } from '../../components/ds';
import { formatData } from '../../lib/format';
import { PROMOTION_TYPE_LABELS } from '../../lib/statusMap';
import { useLojaAtiva } from '../../auth/AuthContext';
import { excluirPromocao, listPromocoes, type Promocao } from '../../api/promocoes';
import { ModalNovaPromocao } from './ModalNovaPromocao';

import '../../pedidos-central.css';
import '../../trocas-nova.css';
import '../../recuperacao.css';
import '../../promocoes.css';

// Porte de src/promocoes.js.
type Tab = 'ativa' | 'agendada' | 'encerrada';

function classificar(p: Promocao): Tab {
  const agora = Date.now();
  if (p.available === false) return 'encerrada';
  if (p.expires_at && new Date(p.expires_at).getTime() < agora) return 'encerrada';
  if (p.starts_at && new Date(p.starts_at).getTime() > agora) return 'agendada';
  return 'ativa';
}

function descontoResumo(p: Promocao): string {
  const tiers = p.discount_tiers || [];
  if (!tiers.length) return p.type === 'unit_free' ? '1 item grátis' : '—';
  if (tiers.length === 1) {
    const t = tiers[0];
    return p.kind === 'value' ? `R$ ${t.discount}` : `${t.discount}%`;
  }
  return `${tiers.length} patamares`;
}

export function PromocoesPage() {
  const lojaSelecionada = useLojaAtiva() ?? '';
  const lojaReal = lojaSelecionada;

  const [promocoes, setPromocoes] = useState<Promocao[] | null>(null);
  const [erro, setErro] = useState('');
  const [tab, setTab] = useState<Tab>('ativa');
  const [modalAberto, setModalAberto] = useState(false);
  const [excluindo, setExcluindo] = useState<Promocao | null>(null);

  function carregar() {
    setErro('');
    setPromocoes(null);
    listPromocoes()
      .then((data) => setPromocoes(data.promocoes || []))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [lojaReal]);

  async function confirmarExclusao() {
    if (!excluindo) return;
    await excluirPromocao(excluindo.id);
    carregar();
  }

  const prefixo = '';
  const visiveis = (promocoes || []).filter((p) => classificar(p) === tab);

  return (
    <PageStack>
      <PageHeader
        title="Promoções"
        description={`${prefixo}Descontos e ofertas da sua loja.`}
        actions={
          <Button variant="primary" onClick={() => setModalAberto(true)}>
            Nova promoção
          </Button>
        }
      />

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !promocoes && <Skeleton variant="table" rows={6} />}
      {!erro && promocoes && (
        <div className="ds-stack">
          <TabList<Tab>
            label="Status das promoções"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'ativa', label: 'Ativas', count: promocoes.filter((p) => classificar(p) === 'ativa').length },
              { value: 'agendada', label: 'Agendadas', count: promocoes.filter((p) => classificar(p) === 'agendada').length },
              { value: 'encerrada', label: 'Encerradas', count: promocoes.filter((p) => classificar(p) === 'encerrada').length },
            ]}
          />

          {!visiveis.length ? (
            <EmptyState title="Nenhuma promoção nesse status" />
          ) : (
            <DataTable
              label="Promoções"
              rows={visiveis}
              rowKey={(p) => p.id}
              columns={[
                { key: 'codigo', label: 'Código', render: (p) => p.code, sortValue: (p) => p.code },
                {
                  key: 'tipo',
                  priority: 'low',
                  label: 'Tipo',
                  render: (p) => PROMOTION_TYPE_LABELS[p.type] || p.type,
                  sortValue: (p) => PROMOTION_TYPE_LABELS[p.type] || p.type,
                },
                { key: 'desconto', label: 'Desconto', render: descontoResumo, sortValue: descontoResumo },
                { key: 'inicio', priority: 'low', label: 'Início', align: 'right', muted: true, render: (p) => (p.starts_at ? formatData(p.starts_at) : '—'), sortValue: (p) => p.starts_at },
                { key: 'fim', priority: 'low', label: 'Fim', align: 'right', muted: true, render: (p) => (p.expires_at ? formatData(p.expires_at) : '—'), sortValue: (p) => p.expires_at },
                {
                  key: 'acoes',
                  label: 'Ações',
                  hideLabel: true,
                  align: 'right',
                  width: 56,
                  render: (p) => (
                    <RowActionsMenu
                      items={[
                        { label: 'Excluir', variant: 'danger', onSelect: () => setExcluindo(p) },
                      ]}
                    />
                  ),
                },
              ]}
            />
          )}
        </div>
      )}

      <ModalNovaPromocao open={modalAberto} onClose={() => setModalAberto(false)} onCriada={carregar} />
      <ConfirmDialog
        open={!!excluindo}
        onClose={() => setExcluindo(null)}
        title={`Excluir a promoção "${excluindo?.code}"?`}
        onConfirm={confirmarExclusao}
      />
    </PageStack>
  );
}
