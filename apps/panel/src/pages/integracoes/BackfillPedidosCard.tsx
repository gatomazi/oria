import { useEffect, useRef, useState } from 'react';
import { Button, ConfirmDialog, Disclosure, Field, Input, ProgressBar, Select, StatusBadge } from '../../components/ds';
import { Secao } from './IntegracaoAcordeao';
import { formatData, plural } from '../../lib/format';
import type { LojaOpcao } from './lojaOpcao';
import {
  getBackfillPedidosJob,
  iniciarBackfillPedidos,
  listarBackfillsPedidos,
  type PedidosBackfillJob,
} from '../../api/pedidosBackfill';

// O sync incremental de pedidos (server.js `syncPedidosLoja`) só busca desde o último sync (ou
// os últimos 30 dias na 1ª ativação da loja) — pedidos mais antigos nunca entram no cache local,
// o que sub-contava clientes em segmentos de campanha (achado real, 2026-09-10: 712 clientes
// contra 4000+ pedidos históricos). Este card dispara um backfill sob demanda, reexecutável a
// qualquer momento (ex.: loja nova, gap depois de instabilidade).
const ROTULO_STATUS: Record<string, string> = { concluido: 'concluído', falhou: 'falhou', processando: 'em andamento' };

export function BackfillPedidosCard({ stores }: { stores: LojaOpcao[] }) {
  // `loja` guarda o storeId (identidade canônica); o nome é só rótulo.
  const [loja, setLoja] = useState(stores[0]?.id || '');
  const nomeDe = (id: string) => stores.find((st) => st.id === id)?.nome || 'sua loja';
  const [desde, setDesde] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [jobAtivo, setJobAtivo] = useState<PedidosBackfillJob | null>(null);
  const [historico, setHistorico] = useState<PedidosBackfillJob[]>([]);
  const [erro, setErro] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function carregarHistorico() {
    listarBackfillsPedidos()
      .then((r) => {
        setHistorico(r.jobs);
        const rodando = r.jobs.find((j) => j.status === 'processando');
        if (rodando) setJobAtivo(rodando);
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (loja) carregarHistorico();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loja]);

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!jobAtivo || jobAtivo.status !== 'processando') return;
    pollRef.current = setInterval(() => {
      getBackfillPedidosJob(jobAtivo.id)
        .then((r) => {
          setJobAtivo(r.job);
          if (r.job.status !== 'processando') carregarHistorico();
        })
        .catch(() => {});
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobAtivo, loja]);

  async function confirmar() {
    setErro('');
    const r = await iniciarBackfillPedidos(desde || undefined);
    setJobAtivo({
      id: r.jobId,
      loja,
      desde: desde || '2015-01-01',
      status: 'processando',
      paginas_processadas: 0,
      paginas_total: null,
      pedidos_processados: 0,
      erro: null,
      criado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    });
  }

  const progresso = jobAtivo?.paginas_total ? Math.round((jobAtivo.paginas_processadas / jobAtivo.paginas_total) * 100) : 0;
  const rodando = jobAtivo?.status === 'processando';

  return (
    <Secao
      title="Pedidos antigos"
      description="A sincronização automática cobre só os últimos 30 dias a partir da 1ª ativação da loja. Traga o histórico para que segmentos de campanha contem clientes de compras antigas."
    >
      <div className="ds-form-row">
        <Field label="Loja">
          <Select value={loja} onChange={(e) => setLoja(e.target.value)} disabled={rodando || !stores.length}>
            {!stores.length && <option value="">Cadastre a credencial da Reserva Ink para importar o histórico</option>}
            {stores.map((st) => (
              <option key={st.id} value={st.id}>{st.nome}</option>
            ))}
          </Select>
        </Field>
        <Field label="Desde (opcional)" hint="Padrão: 2015-01-01">
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} disabled={rodando} />
        </Field>
        <Button className="ds-form-row__action" variant="secondary" onClick={() => setConfirmando(true)} disabled={rodando || !loja}>
          {rodando ? 'Sincronizando…' : 'Importar histórico completo'}
        </Button>
      </div>

      {erro && <p className="ds-form-error" role="alert">{erro}</p>}

      {jobAtivo && (
        <div className="ds-stack ds-bloco-seguinte">
          <div className="ds-status-linha">
            <StatusBadge
              tone={jobAtivo.status === 'concluido' ? 'success' : jobAtivo.status === 'falhou' ? 'danger' : 'info'}
              label={jobAtivo.status === 'concluido' ? 'Concluído' : jobAtivo.status === 'falhou' ? 'Falhou' : 'Processando'}
            />
            <span className="ds-status-linha__meta">
              {jobAtivo.paginas_total
                ? `página ${jobAtivo.paginas_processadas}/${jobAtivo.paginas_total} — ${plural(jobAtivo.pedidos_processados, 'pedido processado', 'pedidos processados')}`
                : 'Buscando pedidos na Reserva Ink…'}
            </span>
          </div>
          {rodando && jobAtivo.paginas_total != null && (
            <ProgressBar value={progresso} label="Progresso da sincronização histórica" showValue />
          )}
          {jobAtivo.status === 'falhou' && jobAtivo.erro && <p className="pc-nota">{jobAtivo.erro}</p>}
        </div>
      )}

      {historico.length > 0 && (
        <Disclosure summary={`Execuções anteriores (${historico.length})`}>
          <ul className="ds-lista-meta">
            {historico.map((j) => (
              <li key={j.id}>
                {formatData(j.criado_em)} — desde {j.desde} — {ROTULO_STATUS[j.status] || j.status} — {plural(j.pedidos_processados, 'pedido', 'pedidos')}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      <ConfirmDialog
        open={confirmando}
        onClose={() => setConfirmando(false)}
        title="Importar histórico completo de pedidos"
        description={`Isso vai buscar TODOS os pedidos da Ink de ${nomeDe(loja)} desde ${desde || '2015-01-01'} e pode demorar. O sync incremental normal não é afetado.`}
        confirmLabel="Importar"
        confirmVariant="primary"
        onConfirm={async () => {
          try {
            await confirmar();
          } catch (err) {
            setErro((err as Error).message);
            throw err;
          }
        }}
      />
    </Secao>
  );
}
