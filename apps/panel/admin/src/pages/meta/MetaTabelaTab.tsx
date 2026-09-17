import { useMemo, useState } from 'react';
import { DataTable, EmptyState, ErrorState, SearchInput, Select, Skeleton, StatusBadge, Toolbar, type Column } from '../../components/ds';
import { metaNumero, metaObjetivo, metaPercentual, metaReais, metaRoas, metaStatusRotulo, metaStatusTom } from '../../lib/meta';
import type { MetaLinhaEntidade, MetaNivel } from '../../api/metaAds';

interface Props {
  nivel: MetaNivel;
  linhas: MetaLinhaEntidade[] | null;
  erro: string;
  onRecarregar: () => void;
  // Clicar numa campanha leva aos conjuntos dela; num conjunto, aos anúncios (spec §44).
  onDrilldown?: (linha: MetaLinhaEntidade) => void;
}

const ROTULO_NIVEL: Record<MetaNivel, { entidade: string; pai: string | null; plural: string }> = {
  campaign: { entidade: 'Campanha', pai: null, plural: 'campanhas' },
  adset: { entidade: 'Conjunto', pai: 'Campanha', plural: 'conjuntos' },
  ad: { entidade: 'Anúncio', pai: 'Conjunto', plural: 'anúncios' },
};

// Uma tabela serve os três níveis: o backend expõe uma rota só (`level=campaign|adset|ad`) porque o
// que muda entre elas é a junção e o rótulo, não a lógica. Duplicar em três componentes faria três
// lugares para corrigir a mesma coluna.
//
// A lista vem inteira do servidor (agregada por período, não paginada), então a ordenação do
// DataTable pode ser client-side com segurança — diferente da Central de Pedidos, onde ordenar só a
// página carregada já causou bug real (checklist, Fase 3).
export function MetaTabelaTab({ nivel, linhas, erro, onRecarregar, onDrilldown }: Props) {
  const [busca, setBusca] = useState('');
  const [status, setStatus] = useState('todos');
  const rotulos = ROTULO_NIVEL[nivel];

  const filtradas = useMemo(() => {
    if (!linhas) return [];
    const termo = busca.trim().toLowerCase();
    return linhas.filter((l) => {
      if (status === 'ativos' && l.effectiveStatus !== 'ACTIVE') return false;
      if (status === 'pausados' && l.effectiveStatus === 'ACTIVE') return false;
      if (!termo) return true;
      return (l.nome || '').toLowerCase().includes(termo) || (l.paiNome || '').toLowerCase().includes(termo);
    });
  }, [linhas, busca, status]);

  if (erro) return <ErrorState description={erro} onRetry={onRecarregar} />;
  if (!linhas) return <Skeleton variant="table" rows={6} />;

  const colunas: Column<MetaLinhaEntidade>[] = [
    {
      key: 'nome',
      label: rotulos.entidade,
      truncate: true,
      width: nivel === 'ad' ? 260 : 300,
      sortValue: (l) => (l.nome || '').toLowerCase(),
      render: (l) => (
        <span className="meta-tabela__nome">
          {/* Miniatura só no nível de anúncio, e só quando existe: um quadrado vazio em toda linha
              seria ruído. A imagem é decorativa — o nome ao lado já identifica a linha. */}
          {nivel === 'ad' && l.thumbnailUrl && (
            <img className="meta-tabela__thumb" src={l.thumbnailUrl} alt="" loading="lazy" />
          )}
          <span className="meta-tabela__nome-texto" title={l.nome || undefined}>{l.nome || l.id}</span>
        </span>
      ),
    },
    ...(rotulos.pai
      ? [{
          key: 'pai',
          label: rotulos.pai,
          truncate: true,
          width: 200,
          priority: 'low' as const,
          muted: true,
          sortValue: (l: MetaLinhaEntidade) => (l.paiNome || '').toLowerCase(),
          render: (l: MetaLinhaEntidade) => l.paiNome || '—',
        }]
      : []),
    {
      key: 'status',
      label: 'Status',
      sortValue: (l) => l.effectiveStatus,
      render: (l) => <StatusBadge tone={metaStatusTom(l.effectiveStatus)} label={metaStatusRotulo(l.effectiveStatus)} />,
    },
    ...(nivel === 'campaign'
      ? [{
          key: 'objetivo',
          label: 'Objetivo',
          priority: 'low' as const,
          muted: true,
          sortValue: (l: MetaLinhaEntidade) => l.objective || '',
          render: (l: MetaLinhaEntidade) => metaObjetivo(l.objective),
        }]
      : []),
    { key: 'spend', label: 'Gasto', align: 'right', firstSortDirection: 'desc', sortValue: (l) => l.spend, render: (l) => metaReais(l.spend) },
    { key: 'impressions', label: 'Impressões', align: 'right', priority: 'low', muted: true, firstSortDirection: 'desc', sortValue: (l) => l.impressions, render: (l) => metaNumero(l.impressions) },
    { key: 'ctr', label: 'CTR', align: 'right', priority: 'low', firstSortDirection: 'desc', sortValue: (l) => l.ctr ?? -1, render: (l) => metaPercentual(l.ctr) },
    { key: 'cpc', label: 'CPC', align: 'right', priority: 'low', firstSortDirection: 'desc', sortValue: (l) => l.cpc ?? -1, render: (l) => metaReais(l.cpc) },
    { key: 'purchases', label: 'Compras', align: 'right', firstSortDirection: 'desc', sortValue: (l) => l.purchases, render: (l) => metaNumero(l.purchases) },
    // CPA e ROAS sem compra alguma não são 0 — são incalculáveis. O backend manda null e a tabela
    // mostra "—"; ordenar joga esses casos pro fim em vez de fingir que são os melhores (spec §63).
    { key: 'cpa', label: 'CPA', align: 'right', firstSortDirection: 'desc', sortValue: (l) => l.cpa ?? Number.MAX_SAFE_INTEGER, render: (l) => metaReais(l.cpa) },
    { key: 'purchaseValue', label: 'Receita', align: 'right', priority: 'low', firstSortDirection: 'desc', sortValue: (l) => l.purchaseValue, render: (l) => metaReais(l.purchaseValue) },
    { key: 'roas', label: 'ROAS', align: 'right', firstSortDirection: 'desc', sortValue: (l) => l.roas ?? -1, render: (l) => metaRoas(l.roas) },
  ];

  return (
    <div className="ds-stack">
      <Toolbar label={`Filtrar ${rotulos.plural}`}>
        <SearchInput
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={`Buscar ${rotulos.plural}…`}
          aria-label={`Buscar ${rotulos.plural}`}
        />
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="todos">Todos os status</option>
          <option value="ativos">Só ativos</option>
          <option value="pausados">Só pausados</option>
        </Select>
      </Toolbar>

      {filtradas.length === 0 ? (
        <EmptyState
          title={linhas.length === 0 ? `Nenhuma ${rotulos.entidade.toLowerCase()} com entrega no período` : 'Nenhum resultado para este filtro'}
          description={
            linhas.length === 0
              ? 'Só aparece aqui o que teve impressão ou investimento no intervalo escolhido. Experimente um período maior.'
              : 'Ajuste a busca ou o filtro de status.'
          }
        />
      ) : (
        <DataTable
          label={`Desempenho por ${rotulos.entidade.toLowerCase()}`}
          rows={filtradas}
          rowKey={(l) => l.id}
          columns={colunas}
          defaultSort={{ key: 'spend', direction: 'desc' }}
          onRowClick={onDrilldown ? (l) => onDrilldown(l) : undefined}
        />
      )}
    </div>
  );
}
