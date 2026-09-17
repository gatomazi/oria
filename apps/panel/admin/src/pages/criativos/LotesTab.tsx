import { useCallback, useEffect, useState } from 'react';
import { Button, Card, DataTable, EmptyState, ErrorState, PageStack, ProgressBar, Skeleton, StatusBadge, type Column } from '../../components/ds';
import { cancelJob, getJob, listHistory, listJobs, retryJobItem, type Job, type JobItem } from '../../api/criativos';
import { formatData, plural } from '../../lib/format';
import { CREATIVE_JOB_STATUS_MAP } from '../../lib/statusMap';

const MOTOR: Record<string, string> = { CLEAN_ANGLES: 'Ângulos Limpos', REMARKETING: 'Remarketing', FUNNEL_VISUAL: 'Funil por Criativo' };
const ATIVOS = ['queued', 'planning', 'generating', 'processing'];

function Status({ value }: { value: string }) {
  const s = CREATIVE_JOB_STATUS_MAP[value] || { label: value, tone: 'neutral' as const };
  return <StatusBadge tone={s.tone} label={s.label} />;
}

export function LotesTab({ selecionado, onSelecionar }: { selecionado: string | null; onSelecionar: (id: string | null) => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [erro, setErro] = useState('');

  const carregar = useCallback(() => {
    setErro('');
    listJobs().then((r) => setJobs(r.items)).catch((e: Error) => setErro(e.message));
  }, []);
  useEffect(carregar, [carregar]);

  if (selecionado) return <LoteDetalhe id={selecionado} onVoltar={() => { onSelecionar(null); carregar(); }} />;
  if (erro) return <ErrorState description={erro} onRetry={carregar} />;
  if (!jobs) return <Skeleton variant="table" rows={4} />;
  if (!jobs.length) return <EmptyState title="Nenhum lote ainda" description="Os lotes criados na aba Gerar aparecem aqui com o andamento de cada criativo." />;

  const columns: Column<Job>[] = [
    { key: 'createdAt', label: 'Criado em', render: (j) => formatData(j.createdAt), sortValue: (j) => j.createdAt, firstSortDirection: 'desc' },
    { key: 'engine', label: 'Motor', render: (j) => MOTOR[j.engine] || j.engine },
    { key: 'productMode', label: 'Produtos', render: (j) => (j.productMode === 'multi_product' ? 'Multipeça' : 'Um produto'), priority: 'low' },
    { key: 'total', label: 'Criativos', align: 'right', render: (j) => j.total },
    { key: 'status', label: 'Status', render: (j) => <Status value={j.status} /> },
  ];
  return <DataTable label="Lotes do gerador de criativos" columns={columns} rows={jobs} rowKey={(j) => j.id} onRowClick={(j) => onSelecionar(j.id)} defaultSort={{ key: 'createdAt', direction: 'desc' }} />;
}

function LoteDetalhe({ id, onVoltar }: { id: string; onVoltar: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [erro, setErro] = useState('');

  const carregar = useCallback(() => {
    getJob(id).then((j) => { setJob(j); setErro(''); }).catch((e: Error) => setErro(e.message));
  }, [id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Polling só enquanto o lote tem trabalho em andamento.
  useEffect(() => {
    if (!job || !ATIVOS.includes(job.status)) return undefined;
    const t = window.setInterval(carregar, 4000);
    return () => window.clearInterval(t);
  }, [job, carregar]);

  if (erro && !job) return <ErrorState description={erro} onRetry={carregar} />;
  if (!job) return <Skeleton variant="table" rows={3} />;
  const p = job.progress || { total: job.total, done: 0, completed: 0, failed: 0 };

  return (
    <PageStack>
      <Card
        title={`${MOTOR[job.engine] || job.engine} · ${job.productMode === 'multi_product' ? 'Multipeça' : 'Um produto'}`}
        description={`Criado em ${formatData(job.createdAt)}`}
        action={
          <>
            <Button variant="ghost" size="sm" onClick={onVoltar}>Todos os lotes</Button>
            {ATIVOS.includes(job.status) && <Button variant="danger" size="sm" onClick={() => cancelJob(job.id).then(setJob).catch(() => {})}>Cancelar lote</Button>}
          </>
        }
      >
        <Status value={job.status} />
        <ProgressBar value={p.done} max={p.total || 1} label={`Gerando ${p.done} de ${p.total}`} showValue />
        <p>{plural(p.completed, 'criativo pronto', 'criativos prontos')} · {plural(p.failed, 'falha', 'falhas')}</p>
      </Card>
      <div className="criativos-grade">
        {(job.items || []).map((item) => <ItemCard key={item.creativeId} jobId={job.id} item={item} onAtualizar={carregar} />)}
      </div>
    </PageStack>
  );
}

function ItemCard({ jobId, item, onAtualizar }: { jobId: string; item: JobItem; onAtualizar: () => void }) {
  const [tentando, setTentando] = useState(false);
  return (
    <div className="criativos-item">
      {item.assetUrl
        ? <img className="criativos-item__thumb" src={item.assetUrl} alt={`Criativo ${item.summary?.angle?.label || item.angle} (${item.placement})`} loading="lazy" />
        : <div className="criativos-item__thumb criativos-item__thumb--vazio">{CREATIVE_JOB_STATUS_MAP[item.status]?.label || item.status}</div>}
      <Status value={item.status} />
      <span className="criativos-item__meta">
        {item.summary?.angle?.label || item.angle} · {item.placement === 'STORY_9X16' ? 'Story' : 'Feed'}
        {item.funnelStage ? ` · ${item.funnelStage}` : ''}
        {item.generationAttempt > 1 ? ` · tentativa ${item.generationAttempt}` : ''}
      </span>
      {item.error && <p className="ds-form-error" role="alert">{item.error.message}</p>}
      {item.status === 'failed' && (
        <Button size="sm" variant="secondary" disabled={tentando} onClick={() => { setTentando(true); retryJobItem(jobId, item.creativeId).then(onAtualizar).catch(() => {}).finally(() => setTentando(false)); }}>
          Tentar de novo
        </Button>
      )}
      {item.assetUrl && <a href={item.assetUrl} download={`criativo-${item.creativeId}.png`}>Baixar PNG</a>}
    </div>
  );
}

export function HistoricoTab() {
  const [itens, setItens] = useState<(JobItem & { record: Record<string, unknown> | null })[] | null>(null);
  const [erro, setErro] = useState('');
  const carregar = useCallback(() => {
    setErro('');
    listHistory().then((r) => setItens(r.items)).catch((e: Error) => setErro(e.message));
  }, []);
  useEffect(carregar, [carregar]);

  if (erro) return <ErrorState description={erro} onRetry={carregar} />;
  if (!itens) return <Skeleton variant="table" rows={5} />;
  if (!itens.length) return <EmptyState title="Histórico vazio" description="Cada criativo gerado fica registrado aqui com motor, modo de produto, ângulo e versões." />;

  const columns: Column<(typeof itens)[number]>[] = [
    { key: 'updatedAt', label: 'Data', render: (i) => formatData(i.updatedAt), sortValue: (i) => i.updatedAt, firstSortDirection: 'desc' },
    { key: 'engine', label: 'Motor', render: (i) => MOTOR[i.engine] || i.engine },
    { key: 'productMode', label: 'Modo', render: (i) => (i.productMode === 'multi_product' ? 'Multipeça' : 'Um produto'), priority: 'low' },
    { key: 'angle', label: 'Ângulo', render: (i) => i.summary?.angle?.label || i.angle, truncate: true },
    { key: 'placement', label: 'Formato', render: (i) => (i.placement === 'STORY_9X16' ? 'Story' : 'Feed'), priority: 'low' },
    { key: 'funnel', label: 'Funil / intenção', render: (i) => i.funnelStage || i.remarketingIntent || '—', priority: 'low' },
    { key: 'versions', label: 'Versões', render: (i) => `marca v${i.brandKitVersion ?? '—'} · prompt v${i.promptVersion ?? '—'}`, priority: 'low', muted: true },
    { key: 'status', label: 'Status', render: (i) => <Status value={i.status} /> },
    { key: 'asset', label: 'Arquivo', render: (i) => (i.assetUrl ? <a href={i.assetUrl} target="_blank" rel="noreferrer">Abrir</a> : '—') },
  ];
  return <DataTable label="Histórico de criativos" columns={columns} rows={itens} rowKey={(i) => i.creativeId} defaultSort={{ key: 'updatedAt', direction: 'desc' }} />;
}
