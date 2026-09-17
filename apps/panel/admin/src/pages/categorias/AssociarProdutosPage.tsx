import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, KpiCard,
  KpiStrip, PageHeader, Pagination, ProgressBar, Skeleton, StatusBadge, Stepper,
} from '../../components/ds';
import { useLojaAtiva } from '../../auth/AuthContext';
import { adminStores } from '../../state/adminStores';
import { lookup, PRODUCT_APPROVAL_STATUS_MAP } from '../../lib/statusMap';
import { idadeDoCache, plural } from '../../lib/format';
import { listCategorias, type Categoria } from '../../api/categorias';
import { listProdutos, listProdutoTipos, type ListProdutosResponse, type ProdutoSummary, type ProdutoTipo } from '../../api/produtos';
import {
  previewCategoryAssignment, criarCategoryAssignmentJob, getCategoryJob, retryFailedCategoryJob, cancelCategoryJob,
  type AmostraProdutoPreview, type BulkCategoryJob, type FalhaJobItem, type ModoAssociacao,
} from '../../api/categoryAssignments';

import '../../../../src/pedidos-central.css';
import '../../../../src/trocas-nova.css';
import '../../../../src/produtos.css';
import '../../../../src/categorias.css';

// Associação genérica de produtos (docs/claude-categorias-lote-migracao-use-origens.md, Parte
// 2/3). Etapas no Stepper do design system (mesmo dos demais assistentes) — não existe
// componente Stepper compartilhado no ds/ ainda, replicar em vez de arriscar extrair um agora.
const STEP_LABELS = ['Categorias', 'Produtos', 'Modo', 'Simular'];
const PAGE_SIZE = 20;
const JOB_STATUS_MAP: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  queued: { label: 'Na fila', tone: 'info' },
  running: { label: 'Processando', tone: 'warning' },
  completed: { label: 'Concluído', tone: 'success' },
  completed_with_errors: { label: 'Concluído com falhas', tone: 'warning' },
  failed: { label: 'Falhou', tone: 'danger' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
};
const JOB_EM_ANDAMENTO = new Set(['queued', 'running']);
const JOB_POLL_MS = 5000;

export function AssociarProdutosPage() {
  const lojaSelecionada = useLojaAtiva() ?? '';
  const loja = lojaSelecionada;

  const [step, setStep] = useState(0);

  // Etapa 1 — categorias de destino
  const [categorias, setCategorias] = useState<Categoria[] | null>(null);
  const [categoriaIds, setCategoriaIds] = useState<number[]>([]);

  // Etapa 2 — filtro de produtos + seleção
  const [nome, setNome] = useState('');
  const [visivel, setVisivel] = useState('');
  const [aprovacao, setAprovacao] = useState('');
  const [tipoId, setTipoId] = useState('');
  const [tipos, setTipos] = useState<ProdutoTipo[]>([]);
  const [page, setPage] = useState(1);
  const [dadosProdutos, setDadosProdutos] = useState<ListProdutosResponse | null>(null);
  const [erroProdutos, setErroProdutos] = useState('');
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());
  const [modoTodosResultados, setModoTodosResultados] = useState(false);

  // Etapa 3 — modo
  const [modo, setModo] = useState<ModoAssociacao>('add');
  // Transferência (pedido do usuário, 2026-09-11): no modo "add", categorias a REMOVER ao mesmo
  // tempo que adiciona as novas — só faz sentido junto de "add" (o "replace" já define o
  // resultado final explicitamente via categoriaIds).
  const [categoriaIdsRemover, setCategoriaIdsRemover] = useState<number[]>([]);

  // Etapa 4 — simulação + execução
  const [preview, setPreview] = useState<{ total: number; truncado?: boolean; amostra: AmostraProdutoPreview[] } | null>(null);
  const [erroPreview, setErroPreview] = useState('');
  const [confirmando, setConfirmando] = useState(false);

  const [jobId, setJobId] = useState<number | null>(null);
  const [jobEstado, setJobEstado] = useState<{ job: BulkCategoryJob; falhas: FalhaJobItem[] } | null>(null);
  const [erroJob, setErroJob] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    listCategorias().then((d) => setCategorias(d.categorias)).catch(() => setCategorias([]));
    // Tipos são por loja — id de uma loja não vale na outra, então reseta o filtro ao trocar.
    setTipoId('');
    listProdutoTipos().then((d) => setTipos(d.tipos)).catch(() => setTipos([]));
  }, [loja]);

  function carregarProdutos() {
    setErroProdutos('');
    setDadosProdutos(null);
    // A LISTAGEM sai do cache do catálogo quando ele existe (sem isso, filtrar por tipo aqui
    // varria centenas de páginas da Ink e a etapa travava no skeleton). A simulação e o job
    // continuam resolvendo os alvos pela API da Ink — decisão explícita do usuário (2026-09-11):
    // é a Ink que manda no que vai ser alterado. A consequência é que produto criado ou alterado
    // depois da última varredura pode não aparecer aqui e ainda assim entrar no job quando se usa
    // "selecionar todos os resultados do filtro"; o aviso abaixo torna isso explícito na tela.
    listProdutos({ name: nome, visible_in_store: visivel, approval_status: aprovacao, product_type_id: tipoId, page, per_page: PAGE_SIZE })
      .then(setDadosProdutos)
      .catch((err: Error) => setErroProdutos(err.message));
  }
  useEffect(() => { if (step === 1) carregarProdutos(); }, [step, loja, nome, visivel, aprovacao, tipoId, page]);

  function montarFiltros() {
    return {
      name: nome || undefined, visible_in_store: visivel || undefined, approval_status: aprovacao || undefined,
      product_type_id: tipoId || undefined,
    };
  }
  function montarSelecaoManual() {
    return modoTodosResultados ? undefined : { productIds: Array.from(selecionados) };
  }

  function toggleCategoria(id: number) {
    setCategoriaIds((atual) => (atual.includes(id) ? atual.filter((c) => c !== id) : [...atual, id]));
    // Não faz sentido pedir pra remover uma categoria que também virou alvo de adicionar.
    setCategoriaIdsRemover((atual) => atual.filter((c) => c !== id));
  }

  function toggleCategoriaRemover(id: number) {
    setCategoriaIdsRemover((atual) => (atual.includes(id) ? atual.filter((c) => c !== id) : [...atual, id]));
  }

  function toggleProduto(p: ProdutoSummary) {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(p.id)) novo.delete(p.id); else novo.add(p.id);
      return novo;
    });
  }
  function toggleTodosDaPagina(checked: boolean) {
    const produtos = dadosProdutos?.produtos || [];
    setSelecionados((atual) => {
      const novo = new Set(atual);
      produtos.forEach((p) => (checked ? novo.add(p.id) : novo.delete(p.id)));
      return novo;
    });
  }

  async function simular() {
    setErroPreview('');
    setPreview(null);
    try {
      const r = await previewCategoryAssignment({
        categoryIds: categoriaIds, mode: modo, filtros: montarFiltros(), selecaoManual: montarSelecaoManual(),
        removeCategoryIds: modo === 'add' ? categoriaIdsRemover : undefined,
      });
      setPreview(r);
    } catch (err) {
      setErroPreview((err as Error).message);
    }
  }

  async function confirmarEExecutar() {
    const r = await criarCategoryAssignmentJob({
      categoryIds: categoriaIds, mode: modo, filtros: montarFiltros(), selecaoManual: montarSelecaoManual(),
      removeCategoryIds: modo === 'add' ? categoriaIdsRemover : undefined,
    });
    setJobId(r.jobId);
  }

  const carregarJob = useCallback(() => {
    if (!jobId) return;
    getCategoryJob(jobId).then(setJobEstado).catch((err: Error) => setErroJob(err.message));
  }, [jobId]);

  useEffect(carregarJob, [carregarJob]);

  useEffect(() => {
    if (!jobEstado || !JOB_EM_ANDAMENTO.has(jobEstado.job.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(carregarJob, JOB_POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobEstado, carregarJob]);

  const totalSelecionado = modoTodosResultados ? (dadosProdutos?.totalCount ?? 0) : selecionados.size;
  const podeAvancarProdutos = totalSelecionado > 0;
  const podeAvancarCategorias = categoriaIds.length > 0;

  // Tela de progresso do job — substitui o wizard assim que um job existe.
  if (jobId) {
    if (erroJob) return <ErrorState description={erroJob} />;
    if (!jobEstado) return <Skeleton rows={6} />;
    const { job, falhas } = jobEstado;
    const meta = JOB_STATUS_MAP[job.status] || { label: job.status, tone: 'neutral' as const };
    const progresso = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

    return (
      <>
        <PageHeader
          title="Associando categorias"
          description={`${adminStores.name(job.loja)} · modo ${job.mode === 'add' ? 'Adicionar' : 'Substituir'}`}
          back={{ to: '/admin/categorias', label: 'Voltar pra categorias' }}
        />

        <div className="ds-status-linha">
          <StatusBadge tone={meta.tone} label={meta.label} />
          <span>Criado em {new Date(job.criado_em).toLocaleString('pt-BR')}</span>
        </div>

        {JOB_EM_ANDAMENTO.has(job.status) && (
          <Card>
            <p className="ds-status-linha__meta">Processando {job.processed} / {job.total}</p>
            <ProgressBar value={progresso} label="Progresso da associação" showValue />
          </Card>
        )}

        <KpiStrip label="Resultado da associação">
          <KpiCard title="Total" value={job.total} />
          <KpiCard title="Sucesso" value={job.succeeded} />
          <KpiCard title="Falha" value={job.failed} />
          <KpiCard title="Ignorados" value={job.skipped} />
          <KpiCard title="Pendentes" value={job.total - job.processed} />
        </KpiStrip>

        <div className="ds-button-row">
          {JOB_EM_ANDAMENTO.has(job.status) && (
            <Button variant="secondary" onClick={() => cancelCategoryJob(job.id).then(carregarJob)}>Cancelar</Button>
          )}
          {job.failed > 0 && !JOB_EM_ANDAMENTO.has(job.status) && (
            <Button variant="secondary" onClick={() => retryFailedCategoryJob(job.id).then(carregarJob)}>Reexecutar falhas</Button>
          )}
        </div>

        {falhas.length > 0 && (
          <Card>
            <h3 className="ds-card__title">Últimas falhas</h3>
            <DataTable
              rows={falhas}
              rowKey={(f) => f.product_id}
              columns={[
                { key: 'produto', label: 'Produto', render: (f) => `#${f.product_id}` },
                { key: 'tentativas', label: 'Tentativas', render: (f) => String(f.attempts) },
                { key: 'erro', label: 'Erro', render: (f) => f.error || '—' },
              ]}
            />
          </Card>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Associar produtos a categorias"
        description="Selecione categorias, filtre produtos e associe em massa — o disparo real acontece em segundo plano."
        actions={<Link to="/admin/categorias" className="ds-btn ds-btn--secondary">Voltar</Link>}
      />

      <Stepper steps={STEP_LABELS} current={step} isCompleted={() => false} onSelect={setStep} canSelect label="Etapas da associação" />

      <Card>
        {step === 0 && (
          <div className="tn-form">
            <p className="pc-nota">Categorias de destino — escolha 1 ou mais.</p>
            {!categorias && <Skeleton rows={4} />}
            {categorias && categorias.length === 0 && (
              <EmptyState title="Nenhuma categoria" description="Crie categorias antes de associar produtos." />
            )}
            {categorias && categorias.map((c) => (
              <label key={c.id} className="ds-check-inline">
                <input type="checkbox" checked={categoriaIds.includes(c.id)} onChange={() => toggleCategoria(c.id)} />
                {c.name}
              </label>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="tn-form">
            <div className="ds-toolbar" role="search" aria-label="Filtrar produtos">
              <input
                type="search" className="ds-input" aria-label="Buscar produtos por nome" placeholder="Buscar por nome…" defaultValue={nome}
                onBlur={(e) => { setNome(e.target.value); setPage(1); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { setNome((e.target as HTMLInputElement).value); setPage(1); } }}
              />
              <select className="ds-select" aria-label="Filtrar por visibilidade" value={visivel} onChange={(e) => { setVisivel(e.target.value); setPage(1); }}>
                <option value="">Visibilidade (todas)</option>
                <option value="true">Visível</option>
                <option value="false">Oculto</option>
              </select>
              <select className="ds-select" aria-label="Filtrar por aprovação" value={aprovacao} onChange={(e) => { setAprovacao(e.target.value); setPage(1); }}>
                <option value="">Aprovação (todas)</option>
                {Object.keys(PRODUCT_APPROVAL_STATUS_MAP).map((key) => (
                  <option key={key} value={key}>{PRODUCT_APPROVAL_STATUS_MAP[key].label}</option>
                ))}
              </select>
              <select className="ds-select" aria-label="Filtrar por tipo" value={tipoId} onChange={(e) => { setTipoId(e.target.value); setPage(1); }}>
                <option value="">Tipo (todos)</option>
                {tipos.map((t) => (
                  <option key={t.id} value={String(t.id)}>{t.name}</option>
                ))}
              </select>
            </div>

            {erroProdutos && <ErrorState description={erroProdutos} />}
            {!erroProdutos && !dadosProdutos && <Skeleton rows={5} />}
            {!erroProdutos && dadosProdutos && (
              <>
                {dadosProdutos.truncado && (
                  <p className="pc-nota pc-nota--warning">
                    Filtro por nome/tipo analisou só os primeiros 5.000 produtos da loja — o resultado pode estar incompleto.
                  </p>
                )}
                {dadosProdutos.fonte === 'catalogo' && (
                  <p className="pc-nota">
                    Lista servida do cache do catálogo{dadosProdutos.cacheSincronizadoEm ? ` (atualizado ${idadeDoCache(dadosProdutos.cacheSincronizadoEm)})` : ''}.
                    A simulação e a execução consultam a Reserva Ink na hora, então o total final pode diferir
                    se o catálogo mudou desde a última sincronização.
                  </p>
                )}
                {dadosProdutos.totalCount != null && dadosProdutos.totalCount > 0 && (
                  <label className="ds-check-inline">
                    <input type="checkbox" checked={modoTodosResultados} onChange={(e) => setModoTodosResultados(e.target.checked)} />
                    Selecionar todos os {plural(dadosProdutos.totalCount, 'resultado', 'resultados')} do filtro atual (não só esta página)
                  </label>
                )}
                {modoTodosResultados && dadosProdutos.fonte === 'catalogo' && (
                  <p className="pc-nota pc-nota--warning">
                    Neste modo o alvo é o filtro, não os itens listados: quem define a lista final é a Ink no
                    momento da execução. Confira o total na etapa de simulação antes de confirmar.
                  </p>
                )}
                {!dadosProdutos.produtos.length ? (
                  <EmptyState title="Nenhum produto encontrado" description="Ajuste os filtros." />
                ) : (
                  <DataTable
                    rows={dadosProdutos.produtos}
                    rowKey={(p) => p.id}
                    selection={modoTodosResultados ? undefined : {
                      isSelected: (p) => selecionados.has(p.id),
                      onToggleRow: toggleProduto,
                      onToggleAll: toggleTodosDaPagina,
                      allOnPageSelected: dadosProdutos.produtos.every((p) => selecionados.has(p.id)),
                    }}
                    columns={[
                      { key: 'nome', label: 'Produto', render: (p) => p.name || 'Sem nome' },
                      { key: 'tipo', label: 'Tipo', render: (p) => p.productType || '—' },
                      {
                        key: 'status', label: 'Status',
                        render: (p) => { const m = lookup(PRODUCT_APPROVAL_STATUS_MAP, p.approvalStatus); return <StatusBadge tone={m.tone} label={m.label} />; },
                      },
                    ]}
                  />
                )}
                {dadosProdutos.totalPages > 1 && (
                  <Pagination
                    label="Paginação de produtos"
                    page={dadosProdutos.page}
                    totalPages={dadosProdutos.totalPages}
                    totalLabel={dadosProdutos.totalCount != null ? plural(dadosProdutos.totalCount, 'produto', 'produtos') : undefined}
                    onPrev={() => setPage((p) => p - 1)}
                    onNext={() => setPage((p) => p + 1)}
                  />
                )}
                <p className="pc-nota">{plural(totalSelecionado, 'produto selecionado', 'produtos selecionados')}.</p>
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="tn-form">
            <Field label="Modo de associação">
              <label className="ds-check-inline">
                <input type="radio" checked={modo === 'add'} onChange={() => setModo('add')} /> Adicionar preservando categorias atuais
              </label>
              <label className="ds-check-inline">
                <input type="radio" checked={modo === 'replace'} onChange={() => setModo('replace')} /> Substituir categorias atuais
              </label>
            </Field>
            {modo === 'replace' && (
              <p className="ds-form-error">
                As categorias atuais dos produtos selecionados serão substituídas pelas categorias escolhidas.
              </p>
            )}
            {modo === 'add' && (
              <Field label="Remover categorias ao mesmo tempo (opcional)">
                <p className="pc-nota">
                  Pra transferir de uma categoria pra outra sem perder as demais — tira essas antes de somar as novas, no mesmo job.
                </p>
                {(categorias || []).filter((c) => !categoriaIds.includes(c.id)).map((c) => (
                  <label key={c.id} className="ds-check-inline">
                    <input type="checkbox" checked={categoriaIdsRemover.includes(c.id)} onChange={() => toggleCategoriaRemover(c.id)} />
                    {c.name}
                  </label>
                ))}
              </Field>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="tn-form">
            <p className="pc-nota">
              {plural(totalSelecionado, 'produto selecionado', 'produtos selecionados')} · {plural(categoriaIds.length, 'categoria', 'categorias')} · Modo: {modo === 'add' ? 'Adicionar' : 'Substituir'}
              {modo === 'add' && categoriaIdsRemover.length > 0 && ` · removendo ${plural(categoriaIdsRemover.length, 'categoria', 'categorias')}`}
            </p>
            <Button onClick={simular}>Simular migração</Button>
            {erroPreview && <ErrorState description={erroPreview} />}
            {preview && (
              <>
                {preview.truncado && (
                  <p className="pc-nota pc-nota--warning">
                    Atenção: só os primeiros 5.000 produtos da loja foram considerados — produtos além disso não entram nesta associação.
                  </p>
                )}
                <p className="pc-nota">{preview.total === 1 ? '1 produto será atualizado' : `${preview.total} produtos serão atualizados`}. Amostra:</p>
                <DataTable
                  rows={preview.amostra}
                  rowKey={(p) => p.id}
                  columns={[
                    { key: 'nome', label: 'Produto', render: (p) => p.name || `#${p.id}` },
                    { key: 'antes', label: 'Antes', render: (p) => p.categoriasAntes.join(', ') || '—' },
                    { key: 'depois', label: 'Depois', render: (p) => p.categoriasDepois.join(', ') || '—' },
                  ]}
                />
                <div className="ds-button-row ds-bloco-seguinte">
                  <Button variant="primary" onClick={() => setConfirmando(true)}>Confirmar e executar</Button>
                </div>
              </>
            )}
          </div>
        )}
      </Card>

      <div className="ds-button-row ds-bloco-seguinte">
        <Button variant="secondary" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>Voltar</Button>
        {step < STEP_LABELS.length - 1 && (
          <Button
            onClick={() => setStep((s) => s + 1)}
            disabled={(step === 0 && !podeAvancarCategorias) || (step === 1 && !podeAvancarProdutos)}
          >
            Avançar
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmando}
        title="Confirmar associação em massa"
        description={`${(preview?.total ?? totalSelecionado) === 1 ? '1 produto será atualizado' : `${preview?.total ?? totalSelecionado} produtos serão atualizados`} no modo ${modo === 'add' ? 'Adicionar' : 'Substituir'}. Essa ação roda em segundo plano e não pode ser desfeita automaticamente.`}
        confirmLabel="Confirmar e executar"
        onConfirm={confirmarEExecutar}
        onClose={() => setConfirmando(false)}
      />
    </>
  );
}
