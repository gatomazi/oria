import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, PageHeader, Pagination, Skeleton, StatusBadge } from '../../components/ds';
import { formatData, plural } from '../../lib/format';
import { useLojaAtiva } from '../../auth/AuthContext';
import { listCategorias, bulkAtivarCategorias, bulkExcluirCategorias, type Categoria } from '../../api/categorias';
import { ModalNovaCategoria } from './ModalNovaCategoria';
import { ModalCriarCategoriasEmLote } from './ModalCriarCategoriasEmLote';
import { CategoriaDrawer } from './CategoriaDrawer';

import '../../pedidos-central.css';
import '../../trocas-nova.css';
import '../../produtos.css';
import '../../categorias.css';

const CATEGORIAS_POR_PAGINA = 25;

// Porte de src/categorias.js (piloto — Fase 2, docs/plan.md).
export function CategoriasPage() {
  const lojaSelecionada = useLojaAtiva() ?? '';
  const lojaReal = lojaSelecionada;

  const [categorias, setCategorias] = useState<Categoria[] | null>(null);
  const [pagina, setPagina] = useState(1);
  const [totalPaginas, setTotalPaginas] = useState(1);
  const [totalCategorias, setTotalCategorias] = useState<number | null>(null);
  const [erro, setErro] = useState('');
  const [modalAberto, setModalAberto] = useState(false);
  const [modalLoteAberto, setModalLoteAberto] = useState(false);
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [selecionadas, setSelecionadas] = useState<Set<number>>(new Set());
  const [confirmandoAcao, setConfirmandoAcao] = useState<'ativar' | 'desativar' | 'excluir' | null>(null);
  const [erroAtivacao, setErroAtivacao] = useState('');

  function carregar() {
    setErro('');
    setCategorias(null);
    setSelecionadas(new Set());
    listCategorias({ page: pagina, perPage: CATEGORIAS_POR_PAGINA })
      .then((data) => {
        const lista = data.categorias || [];
        // Excluir tudo o que restava na última página deixa a página vazia: volta uma.
        if (lista.length === 0 && pagina > 1) { setPagina(pagina - 1); return; }
        setCategorias(lista.slice().sort((a, b) => a.position - b.position));
        setTotalPaginas(data.totalPages ?? 1);
        setTotalCategorias(data.totalCount ?? null);
      })
      .catch((err: Error) => setErro(err.message));
  }

  // Trocar de loja volta para a primeira página; a seleção nunca atravessa páginas (ação em lote só no que está visível).
  useEffect(() => { setPagina(1); }, [lojaReal]);
  useEffect(carregar, [lojaReal, pagina]);

  const naoDisponiveis = (categorias || []).filter((c) => !c.is_available);

  function alternarSelecao(c: Categoria) {
    setSelecionadas((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(c.id)) proximo.delete(c.id); else proximo.add(c.id);
      return proximo;
    });
  }

  async function aplicarAcaoSelecionadas() {
    if (!confirmandoAcao) return;
    setErroAtivacao('');
    if (confirmandoAcao === 'excluir') {
      const r = await bulkExcluirCategorias(Array.from(selecionadas));
      if (r.resumo.falharam > 0) {
        setErroAtivacao(`${r.resumo.excluidas} ${r.resumo.excluidas === 1 ? 'excluída' : 'excluídas'}, ${r.resumo.falharam} ${r.resumo.falharam === 1 ? 'falhou' : 'falharam'}: ${r.resultados.filter((x) => x.status === 'falhou').map((x) => `#${x.id} (${x.error})`).join('; ')}`);
      }
      carregar();
      return;
    }
    const r = await bulkAtivarCategorias(Array.from(selecionadas), confirmandoAcao === 'ativar');
    if (r.resumo.falharam > 0) {
      const verbo = confirmandoAcao === 'ativar' ? (r.resumo.ativadas === 1 ? 'ativada' : 'ativadas') : r.resumo.ativadas === 1 ? 'desativada' : 'desativadas';
      setErroAtivacao(`${r.resumo.ativadas} ${verbo}, ${r.resumo.falharam} ${r.resumo.falharam === 1 ? 'falhou' : 'falharam'}: ${r.resultados.filter((x) => x.status === 'falhou').map((x) => `#${x.id} (${x.error})`).join('; ')}`);
    }
    carregar();
  }

  const descricao = 'Categorias da sua loja Reserva Ink.';

  return (
    <>
      <PageHeader
        title="Categorias"
        description={descricao}
        actions={
          <>
            <Link to="/admin/categorias/associar" className="ds-btn ds-btn--secondary">
              Associar produtos
            </Link>
            <Button variant="secondary" onClick={() => setModalLoteAberto(true)}>
              Criar em lote
            </Button>
            <Button variant="primary" onClick={() => setModalAberto(true)}>
              Nova categoria
            </Button>
          </>
        }
      />

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {erroAtivacao && <ErrorState description={erroAtivacao} />}
      {!erro && !categorias && <Skeleton variant="table" rows={6} />}
      {!erro && categorias && categorias.length === 0 && (
        <EmptyState title="Nenhuma categoria ainda" description="Crie a primeira categoria pra organizar o catálogo." />
      )}
      {!erro && categorias && categorias.length > 0 && (
        <>
          {selecionadas.size > 0 && (
            <div className="ds-button-row ds-selecao-barra">
              <span className="ds-status-linha__meta">{selecionadas.size === 1 ? '1 selecionada' : `${selecionadas.size} selecionadas`}</span>
              <Button variant="primary" onClick={() => setConfirmandoAcao('ativar')}>
                Ativar selecionadas
              </Button>
              <Button variant="secondary" onClick={() => setConfirmandoAcao('desativar')}>
                Desativar selecionadas
              </Button>
              <Button variant="danger" onClick={() => setConfirmandoAcao('excluir')}>
                Excluir selecionadas
              </Button>
            </div>
          )}
          <DataTable
            rows={categorias}
            rowKey={(c) => c.id}
            onRowClick={(c) => setDrawerId(c.id)}
            selection={{
              isSelected: (c) => selecionadas.has(c.id),
              onToggleRow: alternarSelecao,
              allOnPageSelected: naoDisponiveis.length > 0 && naoDisponiveis.every((c) => selecionadas.has(c.id)),
              onToggleAll: (checked) => setSelecionadas(checked ? new Set(naoDisponiveis.map((c) => c.id)) : new Set()),
            }}
            columns={[
              { key: 'nome', label: 'Categoria', render: (c) => c.name, sortValue: (c) => c.name },
              { key: 'produtos', label: 'Produtos', align: 'right', render: (c) => c.product_count ?? (c.product_ids || []).length, sortValue: (c) => c.product_count ?? (c.product_ids || []).length },
              { key: 'kits', priority: 'low', label: 'Kits', align: 'right', render: (c) => (c.kit_ids || []).length, sortValue: (c) => (c.kit_ids || []).length },
              {
                key: 'visivel',
                label: 'Visível',
                render: (c) => <StatusBadge tone={c.is_available ? 'success' : 'neutral'} label={c.is_available ? 'Visível' : 'Oculta'} />,
                sortValue: (c) => (c.is_available ? 1 : 0),
              },
              { key: 'posicao', priority: 'low', label: 'Posição', align: 'right', render: (c) => c.position, sortValue: (c) => c.position },
              { key: 'atualizado', priority: 'low', label: 'Atualizado', align: 'right', muted: true, render: (c) => formatData(c.updated_at), sortValue: (c) => c.updated_at },
            ]}
          />
          {totalPaginas > 1 && (
            <Pagination
              label="Paginação de categorias"
              page={pagina}
              totalPages={totalPaginas}
              totalLabel={totalCategorias != null ? plural(totalCategorias, 'categoria', 'categorias') : undefined}
              onPrev={() => setPagina((p) => Math.max(1, p - 1))}
              onNext={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmandoAcao != null}
        onClose={() => setConfirmandoAcao(null)}
        title={
          confirmandoAcao === 'ativar' ? 'Ativar categorias selecionadas'
            : confirmandoAcao === 'desativar' ? 'Desativar categorias selecionadas'
            : 'Excluir categorias selecionadas'
        }
        description={
          confirmandoAcao === 'ativar'
            ? `${selecionadas.size === 1 ? '1 categoria será marcada' : `${selecionadas.size} categorias serão marcadas`} como "Disponível na loja" na Ink. Produtos só podem ser associados a categorias ativas.`
            : confirmandoAcao === 'desativar'
            ? `${selecionadas.size === 1 ? '1 categoria será marcada' : `${selecionadas.size} categorias serão marcadas`} como "Não disponível na loja" na Ink. Categorias internas de migração costumam ficar assim de propósito — só desative se tiver certeza.`
            : `${selecionadas.size === 1 ? '1 categoria será excluída' : `${selecionadas.size} categorias serão excluídas`} permanentemente da Ink. Isso não afeta os produtos (só a categoria some), mas não tem como desfazer.`
        }
        confirmLabel={confirmandoAcao === 'ativar' ? 'Ativar' : confirmandoAcao === 'desativar' ? 'Desativar' : 'Excluir'}
        confirmVariant={confirmandoAcao === 'ativar' ? 'primary' : 'danger'}
        onConfirm={aplicarAcaoSelecionadas}
      />

      <ModalNovaCategoria
        open={modalAberto}
        onClose={() => setModalAberto(false)}
        onCriada={carregar}
      />

      <ModalCriarCategoriasEmLote
        open={modalLoteAberto}
        onClose={() => setModalLoteAberto(false)}
        onCriadas={carregar}
      />

      {drawerId != null && (
        <CategoriaDrawer loja={lojaReal} id={drawerId} onClose={() => setDrawerId(null)} onChanged={carregar} />
      )}
    </>
  );
}
