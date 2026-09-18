import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, InfoTooltip, PageHeader, PageStack, Select, Skeleton, StatusBadge, Toolbar, type Tone } from '../../components/ds';
import { Tabs } from '../../components/Tabs';
import { formatData } from '../../lib/format';
import { useLojaAtiva } from '../../auth/AuthContext';
import { adminStores } from '../../state/adminStores';
import {
  getControleEstoque,
  getObservadoEstoque,
  limparEResincronizarControleEstoque,
  sincronizarControleEstoque,
  type ControleEstoqueVariante,
  type ObservadoVariante,
} from '../../api/estoque';

import '../../pedidos-central.css';
import '../../estoque.css';

// Estoque (Fase 3 do design system). Decisão D6: 0 é o estado comum de peça sob demanda (tom
// neutro); negativo é dado divergente (vermelho) e vai pro fim da lista por padrão.

// 4 faixas (achado do refinamento visual: diferenciar disponível/baixo/zero/negativo sem
// depender só de cor — daltonismo, impressão em P&B etc.) — limites ainda não configuráveis.
type Faixa = 'disponivel' | 'baixo' | 'esgotado_negativo';

function faixaChave(qtd: number | null): Faixa | null {
  if (qtd == null) return null;
  if (qtd <= 0) return 'esgotado_negativo';
  if (qtd <= 20) return 'baixo';
  return 'disponivel';
}

function faixaInfo(qtd: number | null): { tone: Tone; label: string } {
  if (qtd == null) return { tone: 'neutral', label: '—' };
  if (qtd < 0) return { tone: 'danger', label: `${qtd} · negativo` };
  if (qtd === 0) return { tone: 'neutral', label: '0 · esgotado' };
  if (qtd <= 20) return { tone: 'warning', label: `${qtd} · baixo` };
  return { tone: 'success', label: String(qtd) };
}

// Ordem padrão: negativos por último (ordem original preservada entre os demais). A ordenação por
// coluna do DataTable continua disponível e sobrepõe esta.
function negativosPorUltimo<T extends { quantidadeDisponivel: number | null }>(rows: T[]): T[] {
  const naoNegativos = rows.filter((r) => r.quantidadeDisponivel == null || r.quantidadeDisponivel >= 0);
  const negativos = rows.filter((r) => r.quantidadeDisponivel != null && r.quantidadeDisponivel < 0);
  return naoNegativos.concat(negativos);
}

const FILTRO_FAIXA_OPCOES: [string, string][] = [
  ['', 'Status (todos)'],
  ['disponivel', 'Só disponível'],
  ['baixo', 'Só baixo'],
  ['esgotado_negativo', 'Só esgotado/negativo'],
];

// Pedido do usuário, 2026-09-06: "permita remover peças esgotadas/baixo no filtro" — filtro
// único por faixa (escolher 1 pra ver só ela), reaproveitado nas 2 abas.
function FiltroFaixa({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select aria-label="Filtrar por faixa de estoque" value={value} onChange={(e) => onChange(e.target.value)}>
      {FILTRO_FAIXA_OPCOES.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </Select>
  );
}

function ControleEstoqueTab({ escopo }: { escopo: string }) {
  const [variantes, setVariantes] = useState<ControleEstoqueVariante[] | null>(null);
  const [erro, setErro] = useState('');
  const [sincronizando, setSincronizando] = useState(false);
  const [limpando, setLimpando] = useState(false);
  const [confirmandoLimpeza, setConfirmandoLimpeza] = useState(false);
  const [filtroFaixa, setFiltroFaixa] = useState('');

  function carregar() {
    setErro('');
    setVariantes(null);
    getControleEstoque()
      .then((data) => setVariantes(data.variantes || []))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [escopo]);

  function sincronizar() {
    setSincronizando(true);
    sincronizarControleEstoque()
      .then(() => {
        setSincronizando(false);
        carregar();
      })
      .catch(() => setSincronizando(false));
  }

  async function limparEResincronizar() {
    setLimpando(true);
    try {
      await limparEResincronizarControleEstoque();
      carregar();
    } finally {
      setLimpando(false);
    }
  }

  return (
    <div className="ds-stack">
      <Toolbar
        label="Filtrar controle de estoque"
        end={
          <>
            <InfoTooltip content='Fonte direta: variantes do produto "controle-estoque" (1 por tipo de peça, nunca publicado). Sincroniza automaticamente a cada 15 min.' />
            <Button variant="secondary" disabled={sincronizando} onClick={sincronizar}>
              {sincronizando ? 'Sincronizando…' : 'Sincronizar agora'}
            </Button>
            <Button variant="danger" disabled={limpando} onClick={() => setConfirmandoLimpeza(true)}>
              {limpando ? 'Limpando…' : 'Limpar e ressincronizar'}
            </Button>
          </>
        }
      >
        {variantes && variantes.length > 0 && <FiltroFaixa value={filtroFaixa} onChange={setFiltroFaixa} />}
      </Toolbar>
      <ConfirmDialog
        open={confirmandoLimpeza}
        onClose={() => setConfirmandoLimpeza(false)}
        title={`Apagar o histórico de ${adminStores.name(escopo)} e ressincronizar?`}
        description="Some com o histórico de observações (não afeta o produto/variante real na Ink) e busca tudo de novo na hora. Use se suspeitar de dado velho ou duplicado."
        confirmLabel="Limpar e ressincronizar"
        onConfirm={limparEResincronizar}
      />
      <div>
        {erro && <ErrorState description={erro} onRetry={carregar} />}
        {!erro && !variantes && <Skeleton variant="table" rows={6} />}
        {!erro && variantes && !variantes.length && (
          <EmptyState title="Nenhum dado ainda" description='Clique em "Sincronizar agora" ou aguarde a próxima rodada automática (a cada 15 min).' />
        )}
        {!erro && variantes && variantes.length > 0 && (
          <>
            {(() => {
              const filtradas = negativosPorUltimo(filtroFaixa ? variantes.filter((v) => faixaChave(v.quantidadeDisponivel) === filtroFaixa) : variantes);
              if (!filtradas.length) return <EmptyState title="Nenhuma peça nessa faixa" />;
              return (
                <DataTable
                  label="Controle de estoque"
                  rows={filtradas}
                  rowKey={(v, i) => `${v.loja}:${v.produtoTipo}:${v.tamanho}:${v.cor}:${v.modelo}:${i}`}
                  columns={[
                    { key: 'tipo', label: 'Tipo de peça', render: (v) => v.produtoTipo || '—', sortValue: (v) => v.produtoTipo },
                    { key: 'loja', priority: 'low', label: 'Loja', muted: true, render: (v) => adminStores.name(v.loja), sortValue: (v) => adminStores.name(v.loja) },
                    {
                      key: 'variacao',
                      label: 'Tamanho · Cor · Modelo',
                      render: (v) => [v.tamanho, v.cor, v.modelo].filter(Boolean).join(' · ') || '—',
                      sortValue: (v) => [v.tamanho, v.cor, v.modelo].filter(Boolean).join(' · '),
                    },
                    {
                      key: 'qtd',
                      label: 'Disponível',
                      render: (v) => <StatusBadge {...faixaInfo(v.quantidadeDisponivel)} />,
                      sortValue: (v) => v.quantidadeDisponivel,
                    },
                    { key: 'atualizado', priority: 'low', label: 'Atualizado em', align: 'right', muted: true, render: (v) => formatData(v.observadoEm), sortValue: (v) => v.observadoEm },
                  ]}
                />
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

function ObservadoTab({ escopo }: { escopo: string }) {
  const [variantes, setVariantes] = useState<ObservadoVariante[] | null>(null);
  const [erro, setErro] = useState('');
  const [filtroFaixa, setFiltroFaixa] = useState('');

  useEffect(() => {
    setErro('');
    setVariantes(null);
    getObservadoEstoque()
      .then((data) => setVariantes(data.variantes || []))
      .catch((err: Error) => setErro(err.message));
  }, [escopo]);

  const filtradas = variantes ? negativosPorUltimo(filtroFaixa ? variantes.filter((v) => faixaChave(v.quantidadeDisponivel) === filtroFaixa) : variantes) : null;

  return (
    <div className="ds-stack">
      <Toolbar
        label="Filtrar estoque observado"
        end={
          <span className="ds-note">
            Não é um estoque em tempo real.
            <InfoTooltip content='Só o que aparece "de carona" nos pedidos que chegam por webhook ou na sincronização de hora em hora. Um tipo de peça que não vende não ganha número mais recente.' />
          </span>
        }
      >
        {variantes && variantes.length > 0 && <FiltroFaixa value={filtroFaixa} onChange={setFiltroFaixa} />}
      </Toolbar>
      {erro && <ErrorState description={erro} />}
      {!erro && !variantes && <Skeleton variant="table" rows={6} />}
      {!erro && variantes && !variantes.length && <EmptyState title="Nenhuma observação de estoque ainda" />}
      {!erro && variantes && variantes.length > 0 && (
        <>
          {!filtradas!.length ? (
            <EmptyState title="Nenhuma peça nessa faixa" />
          ) : (
            <DataTable
              label="Estoque observado via pedidos"
              rows={filtradas!}
              rowKey={(v, i) => `${v.loja}:${v.tamanho}:${v.cor}:${v.modelo}:${i}`}
              columns={[
                {
                  key: 'variacao',
                  label: 'Tamanho · Cor · Modelo',
                  render: (v) => [v.tamanho, v.cor, v.modelo].filter(Boolean).join(' · ') || '—',
                  sortValue: (v) => [v.tamanho, v.cor, v.modelo].filter(Boolean).join(' · '),
                },
                { key: 'loja', priority: 'low', label: 'Loja', muted: true, render: (v) => adminStores.name(v.loja), sortValue: (v) => adminStores.name(v.loja) },
                {
                  key: 'qtd',
                  label: 'Disponível',
                  render: (v) => <StatusBadge {...faixaInfo(v.quantidadeDisponivel)} />,
                  sortValue: (v) => v.quantidadeDisponivel,
                },
                { key: 'estampa', priority: 'low', label: 'Última estampa vista', render: (v) => v.ultimaEstampaVista || '—', sortValue: (v) => v.ultimaEstampaVista },
                { key: 'visto', priority: 'low', label: 'Visto em', align: 'right', muted: true, render: (v) => formatData(v.observadoEm), sortValue: (v) => v.observadoEm },
              ]}
            />
          )}
        </>
      )}
    </div>
  );
}

export function EstoquePage() {
  const escopo = useLojaAtiva() ?? '';

  return (
    <PageStack>
      <PageHeader title="Estoque" description="Duas fontes, nunca misturadas: controle direto (produto dedicado) e observação indireta (via pedidos)." />
      <Tabs
        key={escopo}
        label="Fonte do estoque"
        tabs={[
          { label: 'Controle de estoque', render: () => <ControleEstoqueTab escopo={escopo} /> },
          { label: 'Observado via pedidos', render: () => <ObservadoTab escopo={escopo} /> },
        ]}
      />
    </PageStack>
  );
}
