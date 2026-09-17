import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Callout, ConfirmDialog, DataTable, Drawer, EmptyState, ErrorState, KpiCard, KpiStrip, PageHeader, Select, Skeleton, StatusBadge, TabList, type Tone } from '../../components/ds';
import { EnviarPeloCelular } from './EnviarPeloCelular';
import { VolumeWhatsappWebCard } from '../../components/VolumeWhatsappWebCard';
import { formatData, plural } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import {
  aplicarAcaoFila,
  getWhatsappWebFila,
  getWhatsappWebResumo,
  type WhatsappWebAcao,
  type WhatsappWebItem,
  type WhatsappWebOrigem,
  type WhatsappWebResumo,
  type WhatsappWebStatus,
} from '../../api/whatsappWeb';

import '../../../../src/whatsapp-web.css';

// Fila de envio do WhatsApp Web (docs/plano-whatsapp-web-envio.md). Quem envia é o app desktop;
// esta tela só acompanha e corrige: aprovar (modo manual), cancelar, reenviar falhas.
const STATUS_INFO: Record<WhatsappWebStatus, { label: string; tone: Tone }> = {
  aguardando_aprovacao: { label: 'Aguardando aprovação', tone: 'premium' },
  pending: { label: 'Na fila', tone: 'info' },
  claimed: { label: 'Enviando', tone: 'info' },
  sent: { label: 'Enviada', tone: 'success' },
  failed: { label: 'Falhou', tone: 'danger' },
  desconhecido: { label: 'Desconhecido', tone: 'warning' },
  cancelado: { label: 'Cancelada', tone: 'neutral' },
};

const ORIGEM_LABEL: Record<WhatsappWebOrigem, string> = { pedido: 'Pedido', carrinho: 'Carrinho', pix: 'Pix', campanha: 'Campanha' };

const FALHA_LABEL: Record<string, string> = {
  numero_invalido: 'Número inválido no WhatsApp',
  timeout: 'Conversa não abriu a tempo',
  nao_confirmado: 'Envio não confirmado',
  erro_envio: 'Erro ao enviar',
  whatsapp_desconectado: 'WhatsApp Web desconectado',
  lease_expirado: 'App não reportou o resultado',
  interrompido: 'Computador em uso durante o envio',
  app_nao_abriu: 'WhatsApp não ficou em primeiro plano',
};

// App desktop aperta Enter sem ler a tela — "enviada" nesse caso é "Enter apertado com o WhatsApp
// na frente", não confirmação de entrega.
function statusDoItem(item: WhatsappWebItem): { label: string; tone: Tone } {
  if (item.status === 'sent' && item.envioConfirmado === false) return { label: 'Enviada (sem confirmação)', tone: 'success' };
  return STATUS_INFO[item.status];
}

const ACOES_POR_STATUS: Record<WhatsappWebAcao, WhatsappWebStatus[]> = {
  aprovar: ['aguardando_aprovacao'],
  cancelar: ['aguardando_aprovacao', 'pending'],
  reenviar: ['failed', 'desconhecido', 'cancelado'],
};

const ACAO_TEXTO: Record<WhatsappWebAcao, { titulo: string; botao: string; descricao: string; variante: 'primary' | 'danger' }> = {
  aprovar: { titulo: 'Aprovar envio', botao: 'Aprovar', descricao: 'As mensagens entram na fila e o app envia no próximo ciclo.', variante: 'primary' },
  cancelar: { titulo: 'Cancelar envio', botao: 'Cancelar envio', descricao: 'As mensagens não serão enviadas. Dá pra reenviar depois, se precisar.', variante: 'danger' },
  reenviar: {
    titulo: 'Reenviar',
    botao: 'Reenviar',
    descricao: 'Itens "desconhecidos" podem já ter chegado ao cliente. Confira a conversa no WhatsApp antes de reenviar, pra não mandar a mesma mensagem duas vezes.',
    variante: 'primary',
  },
};

const REFRESH_MS = 15000;

export function FilaWhatsappWebPage() {
  const [resumo, setResumo] = useState<WhatsappWebResumo | null>(null);
  const [itens, setItens] = useState<WhatsappWebItem[] | null>(null);
  const [erro, setErro] = useState('');
  const [status, setStatus] = useState<WhatsappWebStatus | ''>('');
  const [origem, setOrigem] = useState<WhatsappWebOrigem | ''>('');
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [detalhe, setDetalhe] = useState<WhatsappWebItem | null>(null);
  const [confirmacao, setConfirmacao] = useState<{ acao: WhatsappWebAcao; ids: string[] } | null>(null);
  // ?modo=celular abre direto no envio pelo celular (link do aviso de app offline).
  const [searchParams, setSearchParams] = useSearchParams();
  const modoCelular = searchParams.get('modo') === 'celular';
  const [itensCelular, setItensCelular] = useState<WhatsappWebItem[] | null>(null);

  const carregar = useCallback(() => {
    Promise.all([
      getWhatsappWebResumo(),
      modoCelular
        ? getWhatsappWebFila({ status: ['pending', 'aguardando_aprovacao', 'claimed', 'desconhecido'] })
        : getWhatsappWebFila({ status, origem }),
    ])
      .then(([r, f]) => {
        setResumo(r);
        if (modoCelular) setItensCelular(f.itens);
        else setItens(f.itens);
        setErro('');
      })
      .catch((err: Error) => setErro(err.message));
  }, [status, origem, modoCelular]);

  function trocarModo(celular: boolean) {
    setSearchParams(celular ? { modo: 'celular' } : {}, { replace: true });
  }

  useEffect(() => {
    carregar();
    const timer = window.setInterval(carregar, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [carregar]);

  useEffect(() => {
    setSelecionados(new Set());
  }, [status, origem]);

  const itensSelecionados = (itens || []).filter((i) => selecionados.has(i.id));
  const idsElegiveis = (acao: WhatsappWebAcao, lista: WhatsappWebItem[]) =>
    lista.filter((i) => ACOES_POR_STATUS[acao].includes(i.status)).map((i) => i.id);

  function confirmar() {
    if (!confirmacao) return;
    return aplicarAcaoFila(confirmacao.acao, confirmacao.ids).then(() => {
      setConfirmacao(null);
      setDetalhe(null);
      setSelecionados(new Set());
      carregar();
    });
  }

  function toggle(id: string) {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }

  const modoApi = resumo?.disponivel && resumo.provider !== 'whatsapp_web';

  return (
    <>
      <PageHeader
        title="Fila de envio"
        description="Mensagens enviadas pelo app Envio WhatsApp (WhatsApp Desktop ou WhatsApp Web) no seu computador."
        actions={<Button variant="secondary" onClick={carregar}>Atualizar</Button>}
      />

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !resumo && <Skeleton variant="table" rows={6} />}

      {!erro && resumo && !resumo.disponivel && (
        <EmptyState title="Indisponível neste ambiente" description="A fila do WhatsApp Web precisa de banco de dados configurado no servidor." />
      )}

      {!erro && resumo?.disponivel && (
        <div className="wa-fila__layout">
          {modoApi && (
            <Callout tone="info" title="O envio está pela API da Meta." className="wa-alerta-espaco">
              Esta fila só recebe mensagens no modo WhatsApp Web. Itens antigos continuam visíveis abaixo. Para trocar, vá em{' '}
              <Link to="/admin/integracoes">Integrações</Link>.
            </Callout>
          )}

          <TabList
            label="Modo de envio"
            value={modoCelular ? 'celular' : 'fila'}
            onChange={(v) => trocarModo(v === 'celular')}
            items={[
              { value: 'fila', label: 'Fila' },
              { value: 'celular', label: 'Enviar pelo celular' },
            ]}
          />

          <VolumeWhatsappWebCard resumo={resumo} />

          {modoCelular && !itensCelular && <Skeleton variant="table" rows={6} />}
          {modoCelular && itensCelular && <EnviarPeloCelular itens={itensCelular} resumo={resumo} aoAtualizar={carregar} />}

          {!modoCelular && (
          <>
          <KpiStrip label="Resumo da fila">
            <KpiCard title="Aguardando aprovação" value={resumo.fila?.aguardandoAprovacao ?? 0} />
            <KpiCard title="Na fila" value={resumo.fila?.pendentes ?? 0} />
            <KpiCard title="Enviando agora" value={resumo.fila?.enviando ?? 0} />
            <KpiCard title="Desconhecidos" value={resumo.fila?.desconhecidos ?? 0} helper="App fechou no meio do envio" />
          </KpiStrip>

          <div className="wa-fila__filtros">
            <Select aria-label="Filtrar por status" value={status} onChange={(e) => setStatus(e.target.value as WhatsappWebStatus | '')}>
              <option value="">Todos os status</option>
              {(Object.keys(STATUS_INFO) as WhatsappWebStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_INFO[s].label}
                </option>
              ))}
            </Select>
            <Select aria-label="Filtrar por origem" value={origem} onChange={(e) => setOrigem(e.target.value as WhatsappWebOrigem | '')}>
              <option value="">Todas as origens</option>
              {(Object.keys(ORIGEM_LABEL) as WhatsappWebOrigem[]).map((o) => (
                <option key={o} value={o}>
                  {ORIGEM_LABEL[o]}
                </option>
              ))}
            </Select>

            {itensSelecionados.length > 0 && (
              <div className="wa-fila__acoes">
                <span className="wa-fila__selecionados">{itensSelecionados.length === 1 ? '1 selecionada' : `${itensSelecionados.length} selecionadas`}</span>
                {(['aprovar', 'reenviar', 'cancelar'] as WhatsappWebAcao[]).map((acao) => {
                  const ids = idsElegiveis(acao, itensSelecionados);
                  if (!ids.length) return null;
                  return (
                    <Button key={acao} variant={acao === 'cancelar' ? 'danger' : 'secondary'} onClick={() => setConfirmacao({ acao, ids })}>
                      {ACAO_TEXTO[acao].botao} ({ids.length})
                    </Button>
                  );
                })}
              </div>
            )}
          </div>

          {!itens && <Skeleton variant="table" rows={6} />}
          {itens && itens.length === 0 && <EmptyState title="Nenhuma mensagem" description="Nada na fila com esses filtros." />}
          {itens && itens.length > 0 && (
            <DataTable
              rows={itens}
              rowKey={(item) => item.id}
              onRowClick={setDetalhe}
              selection={{
                isSelected: (item) => selecionados.has(item.id),
                onToggleRow: (item) => toggle(item.id),
                onToggleAll: (checked) => setSelecionados(checked ? new Set(itens.map((i) => i.id)) : new Set()),
                allOnPageSelected: itens.every((i) => selecionados.has(i.id)),
              }}
              columns={[
                { key: 'criado', label: 'Criada em', render: (item) => formatData(item.criadoEm), sortValue: (item) => item.criadoEm },
                { key: 'origem', priority: 'low', label: 'Origem', render: (item) => ORIGEM_LABEL[item.origem], sortValue: (item) => item.origem },
                {
                  key: 'cliente',
                  label: 'Cliente',
                  render: (item) => (
                    <>
                      <div>{item.nome || '—'}</div>
                      <div className="pc-nota">{item.telefone}</div>
                    </>
                  ),
                  sortValue: (item) => item.nome || '',
                },
                { key: 'loja', priority: 'low', label: 'Loja', render: (item) => (item.loja ? adminStores.name(item.loja) : '—'), sortValue: (item) => item.loja || '' },
                { key: 'mensagem', priority: 'low', label: 'Mensagem', render: (item) => <div className="wa-fila__texto-preview">{item.texto}</div> },
                {
                  key: 'status',
                  label: 'Status',
                  render: (item) => <StatusBadge tone={statusDoItem(item).tone} label={statusDoItem(item).label} />,
                  sortValue: (item) => item.status,
                },
                {
                  key: 'resultado',
                  priority: 'low',
                  label: 'Resultado',
                  render: (item) =>
                    item.status === 'sent'
                      ? formatData(item.enviadoEm)
                      : item.falhaCodigo
                        ? FALHA_LABEL[item.falhaCodigo] || item.falhaCodigo
                        : '—',
                  sortValue: (item) => item.enviadoEm || item.falhaCodigo || '',
                },
              ]}
            />
          )}
          </>
          )}
        </div>
      )}

      <Drawer open={!!detalhe} onClose={() => setDetalhe(null)} title="Mensagem" description={detalhe ? ORIGEM_LABEL[detalhe.origem] : undefined}>
        {detalhe && (
          <div className="wa-fila__detalhe">
            <StatusBadge tone={statusDoItem(detalhe).tone} label={statusDoItem(detalhe).label} />
            <pre className="wa-fila__texto-completo">{detalhe.texto}</pre>
            {detalhe.midiaIgnorada && (
              <Callout tone="warning" title="Mídia não enviada." className="wa-alerta-espaco">
                O template tem imagem, vídeo ou documento no cabeçalho, e o envio pelo WhatsApp Web manda só o texto.
              </Callout>
            )}
            <dl>
              <dt>Cliente</dt>
              <dd>{detalhe.nome || '—'}</dd>
              <dt>Telefone</dt>
              <dd>{detalhe.telefone}</dd>
              <dt>Loja</dt>
              <dd>{detalhe.loja ? adminStores.name(detalhe.loja) : '—'}</dd>
              <dt>Mensagem</dt>
              <dd>
                {detalhe.template || '—'}
                {detalhe.variacao ? ` (versão ${detalhe.variacao})` : ''}
              </dd>
              <dt>Evento</dt>
              <dd>{detalhe.evento || '—'}</dd>
              <dt>Criada em</dt>
              <dd>{formatData(detalhe.criadoEm)}</dd>
              <dt>Enviada em</dt>
              <dd>{formatData(detalhe.enviadoEm)}</dd>
              <dt>Tentativas</dt>
              <dd>{detalhe.tentativas}</dd>
              {detalhe.falhaCodigo && (
                <>
                  <dt>Falha</dt>
                  <dd>
                    {FALHA_LABEL[detalhe.falhaCodigo] || detalhe.falhaCodigo}
                    {detalhe.falhaMensagem ? ` — ${detalhe.falhaMensagem}` : ''}
                  </dd>
                </>
              )}
            </dl>
            <div className="wa-fila__filtros">
              {(['aprovar', 'reenviar', 'cancelar'] as WhatsappWebAcao[])
                .filter((acao) => ACOES_POR_STATUS[acao].includes(detalhe.status))
                .map((acao) => (
                  <Button key={acao} variant={acao === 'cancelar' ? 'danger' : 'primary'} onClick={() => setConfirmacao({ acao, ids: [detalhe.id] })}>
                    {ACAO_TEXTO[acao].botao}
                  </Button>
                ))}
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={!!confirmacao}
        onClose={() => setConfirmacao(null)}
        title={confirmacao ? ACAO_TEXTO[confirmacao.acao].titulo : ''}
        description={confirmacao ? `${plural(confirmacao.ids.length, 'mensagem', 'mensagens')}. ${ACAO_TEXTO[confirmacao.acao].descricao}` : undefined}
        confirmLabel={confirmacao ? ACAO_TEXTO[confirmacao.acao].botao : undefined}
        confirmVariant={confirmacao ? ACAO_TEXTO[confirmacao.acao].variante : undefined}
        onConfirm={confirmar}
      />
    </>
  );
}
