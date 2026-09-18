import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KpiCard,
  KpiStrip,
  PageHeader,
  PageStack,
  Pagination,
  ProgressBar,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
} from '../../components/ds';
import { adminStores } from '../../state/adminStores';
import { JANELAS_ATRIBUICAO_DIAS, janelaAtribuicao, useJanelaAtribuicao } from '../../state/janelaAtribuicao';
import { formatData, formatValor, plural } from '../../lib/format';
import { lookup, CAMPANHA_STATUS_MAP } from '../../lib/statusMap';
import {
  buscarDestinatariosCampanha,
  buscarResumoCampanha,
  liberarLoteCampanha,
  pausarCampanha,
  retomarCampanha,
  type Campanha,
  type CampanhaDestinatario,
  type CampanhaResumo,
  type DestinatarioStatusFiltro,
} from '../../api/campanhas';

import '../../campanhas.css';

import '../../pedidos-central.css';

// Detalhe/Relatório da campanha (spec, Parte 24). Enquanto a campanha está preparando/enviando
// (ou pausada entre lotes — é quando o admin está avaliando entregas/leituras), dá polling
// moderado (10s) — para assim que ela termina (Parte 37: "não fazer polling agressivo"). Tracking
// de cliques (Parte 22) e atribuição de receita/pedidos (Parte 23) ficam fora daqui — sem dado
// confiável ainda, "pedidos"/"receita" vêm null da API e são exibidos como indisponível.
const EM_ANDAMENTO = new Set(['preparing', 'sending']);
const COM_POLLING = new Set(['preparing', 'sending', 'paused']);
const POLL_MS = 10000;
const PAGE_SIZE = 20;
const LOTE_SUGERIDO = 500;

const FILTRO_TABS: { label: string; status?: DestinatarioStatusFiltro }[] = [
  { label: 'Todos' },
  { label: 'Enviados', status: 'enviados' },
  { label: 'Entregues', status: 'entregues' },
  { label: 'Lidos', status: 'lidos' },
  { label: 'Falhas', status: 'falhas' },
  { label: 'Clicados', status: 'clicados' },
  { label: 'Não enviados', status: 'nao_enviados' },
];

function pct(valor: number, base: number) {
  return base > 0 ? `${Math.round((valor / base) * 100)}%` : '—';
}

function DestinatariosTab({ campanhaId, status }: { campanhaId: string; status?: DestinatarioStatusFiltro }) {
  const [dados, setDados] = useState<{ total: number; destinatarios: CampanhaDestinatario[] } | null>(null);
  const [pagina, setPagina] = useState(1);
  const [erro, setErro] = useState('');

  useEffect(() => {
    setPagina(1);
  }, [status]);

  useEffect(() => {
    setDados(null);
    setErro('');
    buscarDestinatariosCampanha(campanhaId, { status, page: pagina, pageSize: PAGE_SIZE })
      .then(setDados)
      .catch((err: Error) => setErro(err.message));
  }, [campanhaId, status, pagina]);

  if (erro) return <ErrorState description={erro} />;
  if (!dados) return <Skeleton variant="table" rows={6} />;
  if (dados.destinatarios.length === 0) {
    return <EmptyState title="Nenhum destinatário nesse filtro" description="Tente outro status ou aguarde o envio avançar." />;
  }

  const totalPaginas = Math.max(1, Math.ceil(dados.total / PAGE_SIZE));

  return (
    <div className="ds-stack">
      <DataTable
        label="Destinatários"
        rows={dados.destinatarios}
        rowKey={(d) => d.id}
        columns={[
          { key: 'cliente', label: 'Cliente', truncate: true, width: 220, render: (d) => d.nome || '—' },
          { key: 'telefone', label: 'Telefone', priority: 'low', muted: true, render: (d) => d.telefoneMascarado || '—' },
          { key: 'lote', label: 'Lote', priority: 'low', align: 'right', render: (d) => (d.lote != null ? `#${d.lote}` : 'Aguardando') },
          {
            key: 'status',
            label: 'Status',
            render: (d) => {
              const meta = lookup(CAMPANHA_RECIPIENT_STATUS_MAP, d.status);
              return <StatusBadge tone={meta.tone} label={meta.label} />;
            },
          },
          { key: 'enviado', label: 'Enviado em', priority: 'low', align: 'right', muted: true, render: (d) => formatData(d.sentAt) },
          { key: 'entregue', label: 'Entregue em', priority: 'low', align: 'right', muted: true, render: (d) => formatData(d.deliveredAt) },
          { key: 'lido', label: 'Lido em', priority: 'low', align: 'right', muted: true, render: (d) => formatData(d.readAt) },
          { key: 'cliques', label: 'Cliques', priority: 'low', align: 'right', render: (d) => String(d.cliques) },
          { key: 'erro', label: 'Erro', priority: 'low', truncate: true, width: 240, render: (d) => d.failureMessage || '—' },
        ]}
      />
      {totalPaginas > 1 && (
        <Pagination
          label="Paginação de destinatários"
          page={pagina}
          totalPages={totalPaginas}
          totalLabel={plural(dados.total, 'destinatário', 'destinatários')}
          onPrev={() => setPagina((p) => p - 1)}
          onNext={() => setPagina((p) => p + 1)}
        />
      )}
    </div>
  );
}

const CAMPANHA_RECIPIENT_STATUS_MAP = {
  pending: { label: 'Pendente', tone: 'neutral' as const },
  queued: { label: 'Na fila', tone: 'info' as const },
  sending: { label: 'Enviando', tone: 'warning' as const },
  sent: { label: 'Enviado', tone: 'info' as const },
  delivered: { label: 'Entregue', tone: 'info' as const },
  read: { label: 'Lido', tone: 'success' as const },
  failed: { label: 'Falhou', tone: 'danger' as const },
  skipped: { label: 'Ignorado', tone: 'neutral' as const },
  opted_out: { label: 'Opt-out', tone: 'neutral' as const },
};

// Controle de envio em lotes: libera o próximo lote, pausa/retoma e mostra métricas por lote.
// Todo o estado vive no backend (campaign_recipients.lote) — sair da tela não perde nada.
function EnvioEmLotesCard({ campanha, resumo, onAtualizar }: { campanha: Campanha; resumo: CampanhaResumo; onAtualizar: () => void }) {
  const [tamanho, setTamanho] = useState(String(campanha.tamanhoLote ?? LOTE_SUGERIDO));
  const [confirmar, setConfirmar] = useState<{ tamanho: number | null } | null>(null);
  const [acaoPendente, setAcaoPendente] = useState(false);
  const [msg, setMsg] = useState<{ texto: string; erro: boolean } | null>(null);

  const liberados = resumo.destinatarios - resumo.aguardandoLiberacao;
  const gerenciavel = COM_POLLING.has(campanha.status);
  const tamanhoNum = Number(tamanho);
  const tamanhoValido = Number.isInteger(tamanhoNum) && tamanhoNum >= 1;
  const proximoLote = resumo.lotes.reduce((max, l) => Math.max(max, l.lote), 0) + 1;
  const qtdConfirmar = confirmar
    ? confirmar.tamanho == null ? resumo.aguardandoLiberacao : Math.min(confirmar.tamanho, resumo.aguardandoLiberacao)
    : 0;

  function liberar() {
    if (!confirmar) return Promise.resolve();
    setMsg(null);
    return liberarLoteCampanha(campanha.id, confirmar.tamanho).then((r) => {
      setMsg({ texto: `Lote #${r.lote} liberado — ${plural(r.liberados, 'destinatário', 'destinatários')} entrando na fila de envio.`, erro: false });
      onAtualizar();
    });
  }

  function alternarPausa() {
    setAcaoPendente(true);
    setMsg(null);
    const acao = campanha.status === 'paused' ? retomarCampanha(campanha.id) : pausarCampanha(campanha.id);
    acao
      .then(() => onAtualizar())
      .catch((err: Error) => setMsg({ texto: err.message, erro: true }))
      .finally(() => setAcaoPendente(false));
  }

  let aviso: string | null = null;
  if (campanha.status === 'paused' && resumo.naFila === 0 && resumo.aguardandoLiberacao > 0) {
    aviso = `Lote concluído. Avalie entregas e leituras abaixo e libere o próximo quando quiser — os ${resumo.aguardandoLiberacao} restantes ficam guardados.`;
  } else if (campanha.status === 'paused' && resumo.naFila > 0) {
    aviso = `Envio pausado — ${resumo.naFila === 1 ? '1 destinatário já liberado aguardando' : `${resumo.naFila} destinatários já liberados aguardando`}.`;
  }

  return (
    <Card title="Envio em lotes">
      <div className="ds-stack">
      <p className="ad-campanha-lotes__resumo">
        Liberados <strong>{liberados}</strong> de <strong>{resumo.destinatarios}</strong>
        {' · '}Aguardando liberação <strong>{resumo.aguardandoLiberacao}</strong>
        {resumo.naFila > 0 && (
          <>
            {' · '}Na fila <strong>{resumo.naFila}</strong>
          </>
        )}
      </p>
      {aviso && <p className="ds-form-note">{aviso}</p>}

      {gerenciavel && (
        <div className="ad-campanha-lotes__controles">
          {resumo.aguardandoLiberacao > 0 && (
            <Field label="Tamanho do próximo lote" hint="Só esse número entra na fila; o restante continua aguardando.">
              <div className="ad-campanha-lotes__liberar">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={tamanho}
                  onChange={(e) => setTamanho(e.target.value)}
                  aria-label="Tamanho do próximo lote"
                />
                <Button disabled={!tamanhoValido} onClick={() => setConfirmar({ tamanho: tamanhoNum })}>
                  Liberar lote #{proximoLote}
                </Button>
                <Button variant="secondary" onClick={() => setConfirmar({ tamanho: null })}>
                  Liberar todos os restantes ({resumo.aguardandoLiberacao})
                </Button>
              </div>
            </Field>
          )}
          <div className="ad-campanha-lotes__pausa">
            {EM_ANDAMENTO.has(campanha.status) && (
              <Button variant="secondary" disabled={acaoPendente} onClick={alternarPausa}>
                {acaoPendente ? 'Pausando…' : 'Pausar envio'}
              </Button>
            )}
            {campanha.status === 'paused' && resumo.naFila > 0 && (
              <Button variant="secondary" disabled={acaoPendente} onClick={alternarPausa}>
                {acaoPendente ? 'Retomando…' : 'Retomar envio'}
              </Button>
            )}
          </div>
        </div>
      )}
      {msg && (
        <p className={msg.erro ? 'ds-form-error' : 'ds-form-note'} role={msg.erro ? 'alert' : undefined}>
          {msg.texto}
        </p>
      )}

      {resumo.lotes.length > 0 && (
        <DataTable
          label="Métricas por lote"
          compact
          rows={resumo.lotes}
          rowKey={(l) => String(l.lote)}
          columns={[
            { key: 'lote', label: 'Lote', render: (l) => `#${l.lote}` },
            { key: 'destinatarios', label: 'Destinatários', align: 'right', render: (l) => String(l.destinatarios) },
            { key: 'enviados', label: 'Enviados', align: 'right', priority: 'low', render: (l) => String(l.enviados) },
            { key: 'entregues', label: 'Entregues', align: 'right', render: (l) => `${l.entregues} (${pct(l.entregues, l.enviados)})` },
            { key: 'lidos', label: 'Lidos', align: 'right', render: (l) => `${l.lidos} (${pct(l.lidos, l.enviados)})` },
            { key: 'falhas', label: 'Falhas', align: 'right', priority: 'low', render: (l) => String(l.falhas) },
            { key: 'cliques', label: 'Cliques', align: 'right', priority: 'low', render: (l) => String(l.cliques) },
            { key: 'naoEnviados', label: 'Não enviados', align: 'right', priority: 'low', render: (l) => String(l.naoEnviados) },
            { key: 'pedidos', label: 'Pedidos', align: 'right', render: (l) => String(l.pedidos) },
            { key: 'receita', label: 'Receita', align: 'right', render: (l) => formatValor(l.receita) ?? '—' },
          ]}
        />
      )}
      </div>

      <ConfirmDialog
        open={!!confirmar}
        onClose={() => setConfirmar(null)}
        title={`Liberar lote #${proximoLote}?`}
        description={
          <>
            Isso enviará mensagens reais de WhatsApp para <strong>{plural(qtdConfirmar, 'destinatário', 'destinatários')}</strong>
            {resumo.aguardandoLiberacao > qtdConfirmar ? `; ${resumo.aguardandoLiberacao - qtdConfirmar} continuam aguardando` : ''}.
            {' '}Essa ação não pode ser desfeita.
          </>
        }
        confirmLabel="Liberar e enviar"
        confirmVariant="danger"
        onConfirm={liberar}
      />
    </Card>
  );
}

export function CampanhaDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const [estado, setEstado] = useState<{ campanha: Campanha; resumo: CampanhaResumo } | null>(null);
  const [erro, setErro] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const janelaDias = useJanelaAtribuicao();

  const carregar = useCallback(() => {
    if (!id) return;
    buscarResumoCampanha(id, janelaDias)
      .then(setEstado)
      .catch((err: Error) => setErro(err.message));
  }, [id, janelaDias]);

  useEffect(carregar, [carregar]);

  useEffect(() => {
    if (!estado || !COM_POLLING.has(estado.campanha.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(carregar, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [estado, carregar]);

  if (erro) return <ErrorState description={erro} onRetry={carregar} />;
  if (!estado) {
    return (
      <PageStack>
        <Skeleton rows={1} height="56px" width="50%" />
        <Skeleton rows={1} height="88px" />
        <Skeleton variant="table" rows={6} />
      </PageStack>
    );
  }

  const { campanha, resumo } = estado;
  const meta = lookup(CAMPANHA_STATUS_MAP, campanha.status);
  const emAndamento = EM_ANDAMENTO.has(campanha.status);
  const liberados = resumo.destinatarios - resumo.aguardandoLiberacao;
  const processados = liberados - resumo.naFila;
  const progresso = liberados > 0 ? Math.round((processados / liberados) * 100) : 0;
  const temLotes = resumo.lotes.length > 1 || resumo.aguardandoLiberacao > 0;

  return (
    <PageStack>
      <PageHeader
        title={campanha.nome}
        back={{ to: '/admin/campanhas', label: 'Voltar pra campanhas' }}
        description={`${adminStores.name(campanha.loja)} · ${campanha.mensagemWebNome ? `Mensagem ${campanha.mensagemWebNome}` : `Template ${campanha.templateNome || '—'}`}`}
        meta={
          <>
            <StatusBadge tone={meta.tone} label={meta.label} />
            <span>Criada em {formatData(campanha.criadoEm)}</span>
            {campanha.agendadaPara && <span>Agendada para {formatData(campanha.agendadaPara)}</span>}
            {campanha.iniciadaEm && <span>Iniciada em {formatData(campanha.iniciadaEm)}</span>}
            {campanha.finalizadaEm && <span>Concluída em {formatData(campanha.finalizadaEm)}</span>}
          </>
        }
        actions={
          <Select
            controlSize="sm"
            aria-label="Janela de atribuição de pedidos"
            value={janelaDias}
            onChange={(e) => janelaAtribuicao.set(Number(e.target.value))}
          >
            {JANELAS_ATRIBUICAO_DIAS.map((d) => (
              <option key={d} value={d}>
                Atribuição: {plural(d, 'dia', 'dias')}
              </option>
            ))}
          </Select>
        }
      />

      {emAndamento && (
        <Card title="Progresso do envio">
          <ProgressBar
            value={progresso}
            label={`Enviando ${processados} de ${liberados}${temLotes ? (liberados === 1 ? ' liberado' : ' liberados') : ''}`}
            showValue
          />
        </Card>
      )}

      {temLotes && <EnvioEmLotesCard campanha={campanha} resumo={resumo} onAtualizar={carregar} />}

      <KpiStrip label="Resultados da campanha">
        <KpiCard title="Destinatários" value={resumo.destinatarios} />
        <KpiCard title="Enviados" value={resumo.enviados} />
        <KpiCard title="Entregues" value={resumo.entregues} />
        <KpiCard title="Lidos" value={resumo.lidos} />
        <KpiCard title="Falhas" value={resumo.falhas} />
        <KpiCard title="Cliques" value={resumo.cliques} />
        <KpiCard title="Pedidos" value={resumo.pedidos} helper={`Pagos até ${plural(resumo.janelaAtribuicaoDias, 'dia', 'dias')} após o envio`} />
        <KpiCard
          title="Receita"
          value={formatValor(resumo.receita)}
          helper={resumo.pedidos > 0 ? `Ticket médio ${formatValor(resumo.receita / resumo.pedidos)}` : 'Última mensagem recebida leva o crédito'}
        />
      </KpiStrip>

      {resumo.destinatarios > 0 && (
        <Card title="Funil">
          <ol className="ad-funil">
            {[
              { label: 'Destinatários', valor: resumo.destinatarios },
              { label: 'Enviados', valor: resumo.enviados },
              { label: 'Entregues', valor: resumo.entregues },
              { label: 'Lidos', valor: resumo.lidos },
              { label: 'Cliques', valor: resumo.cliques },
            ].map((etapa) => (
              <li key={etapa.label} className="ad-funil__etapa">
                <span className="ad-funil__rotulo">{etapa.label}</span>
                <ProgressBar value={etapa.valor} max={resumo.destinatarios || 0} label={etapa.label} tone="info" />
                <span className="ad-funil__valor">{etapa.valor.toLocaleString('pt-BR')}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {id && <Tabs label="Destinatários por status" tabs={FILTRO_TABS.map((t) => ({ label: t.label, render: () => <DestinatariosTab campanhaId={id} status={t.status} /> }))} />}
    </PageStack>
  );
}
