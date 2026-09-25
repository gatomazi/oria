import { useEffect, useRef, useState } from 'react';
import { Button, Card, ConfirmDialog, ProgressBar, StatusBadge } from '../../components/ds';
import { formatData, plural } from '../../lib/format';
import { cancelarCatalogSync, getCatalogSyncStatus, iniciarCatalogSync, type CatalogSyncStatus } from '../../api/catalogSync';

// Rodada "Observabilidade e controle do catalog sync" · achado real de dogfooding (Use Sul,
// 2026-09-24): o catálogo canônico (commerce_products, o que "Desempenho de Produtos" e a
// "Jornada de Valor" dependem) já sincroniza sozinho — no boot e a cada hora — mas até esta rodada
// não tinha nenhuma tela: só via API. Duas lacunas concretas apareceram no piloto real: (1) nenhum
// progresso visível enquanto rodava (só sabia o resultado no fim, minutos depois) e (2) um run que
// trava (processo caiu no meio) fica 'running' pra sempre, sem jeito de destravar sem esperar o TTL
// de 3h do lease ou mexer direto no banco. Este card cobre as duas.
export function CatalogSyncCard() {
  const [status, setStatus] = useState<CatalogSyncStatus | null>(null);
  const [confirmandoSync, setConfirmandoSync] = useState(false);
  const [confirmandoCancelar, setConfirmandoCancelar] = useState(false);
  const [erro, setErro] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function carregar() {
    getCatalogSyncStatus()
      .then(setStatus)
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, []);

  // Progresso ao vivo: pages_processed/products_seen agora são escritos a CADA página do sync
  // (catalog-sync.js `atualizarProgresso`), não só no fechamento — por isso vale a pena reduzir o
  // intervalo do polling enquanto roda, o dado embaixo realmente muda a cada poll.
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!status?.syncing) return;
    pollRef.current = setInterval(carregar, 4000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.syncing]);

  async function confirmarSync() {
    setErro('');
    await iniciarCatalogSync();
    carregar();
  }

  async function confirmarCancelar() {
    setErro('');
    await cancelarCatalogSync();
    carregar();
  }

  const rodando = !!status?.syncing;
  const ultimo = status?.lastRun || null;
  const progresso = ultimo?.pagesTotal
    ? Math.min(100, Math.round((ultimo.pagesProcessed / ultimo.pagesTotal) * 100))
    : null;

  const tom = rodando ? 'info'
    : status?.state === 'completed' ? 'success'
      : status?.state === 'cancelled' ? 'warning'
        : status?.state === 'partial_failure' || status?.state === 'failed' ? 'danger'
          : 'neutral';
  const rotulo = rodando ? 'Sincronizando'
    : status?.state === 'completed' ? 'Sincronizado'
      : status?.state === 'cancelled' ? 'Cancelado'
        : status?.state === 'partial_failure' ? 'Parcial'
          : status?.state === 'failed' ? 'Falhou'
            : 'Nunca sincronizado';

  return (
    <Card title="Catálogo canônico (Desempenho de Produtos)">
      <p className="pc-nota">
        Varre o catálogo completo da Reserva Ink pra alimentar Desempenho de Produtos e as Prioridades de hoje da
        Jornada de Valor. Roda sozinho — no boot e a cada hora — mas você pode disparar na hora aqui.
      </p>

      <div className="ds-form-row">
        <Button variant="secondary" onClick={() => setConfirmandoSync(true)} disabled={rodando}>
          {rodando ? 'Sincronizando…' : 'Sincronizar catálogo agora'}
        </Button>
        {rodando && (
          <Button className="ds-form-row__action" variant="danger" onClick={() => setConfirmandoCancelar(true)}>
            Cancelar sincronização
          </Button>
        )}
      </div>

      {erro && <p className="ds-form-error" role="alert">{erro}</p>}

      {status && (
        <div className="ds-stack ds-bloco-seguinte">
          <div className="ds-status-linha">
            <StatusBadge tone={tom} label={rotulo} />
            <span className="ds-status-linha__meta">
              {ultimo
                ? rodando
                  ? `${plural(ultimo.productsSeen, 'produto visto', 'produtos vistos')}${ultimo.pagesTotal ? ` — página ${ultimo.pagesProcessed}/${ultimo.pagesTotal}` : ultimo.pagesProcessed ? ` — página ${ultimo.pagesProcessed}` : ''}`
                  : `${plural(ultimo.productsInserted, 'produto novo', 'produtos novos')}, ${plural(ultimo.productsUpdated, 'atualizado', 'atualizados')} — ${formatData(ultimo.finishedAt || ultimo.startedAt)}`
                : 'Ainda não sincronizou nesta Organization.'}
            </span>
          </div>
          {rodando && progresso !== null && (
            <ProgressBar value={progresso} label="Progresso da sincronização do catálogo" showValue />
          )}
          {ultimo?.errorCode && !rodando && (
            <p className="pc-nota">Código: {ultimo.errorCode}</p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmandoSync}
        onClose={() => setConfirmandoSync(false)}
        title="Sincronizar catálogo completo"
        description="Isso varre TODAS as páginas de produtos da Ink (centenas ou milhares de chamadas, dependendo do tamanho do catálogo) e pode levar minutos. Desempenho de Produtos continua funcionando com o catálogo atual enquanto a varredura roda."
        confirmLabel="Sincronizar"
        confirmVariant="primary"
        onConfirm={async () => {
          try {
            await confirmarSync();
          } catch (err) {
            setErro((err as Error).message);
            throw err;
          }
        }}
      />

      <ConfirmDialog
        open={confirmandoCancelar}
        onClose={() => setConfirmandoCancelar(false)}
        title="Cancelar sincronização"
        description="Interrompe a sincronização em andamento (para em até 1 página, se ainda estiver rodando de verdade) e libera a trava na hora, pra uma nova poder começar sem esperar. Nenhum produto já sincronizado nesta execução é desfeito."
        confirmLabel="Cancelar sincronização"
        confirmVariant="danger"
        onConfirm={async () => {
          try {
            await confirmarCancelar();
          } catch (err) {
            setErro((err as Error).message);
            throw err;
          }
        }}
      />
    </Card>
  );
}
