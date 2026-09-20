import { useEffect, useRef, useState } from 'react';
import { Button, Card, ConfirmDialog, Field, ProgressBar, Select, StatusBadge, Switch } from '../../components/ds';
import { formatData, plural } from '../../lib/format';
import type { LojaOpcao } from './lojaOpcao';
import {
  getCatalogoCacheStatus,
  salvarCatalogoCacheConfig,
  sincronizarCatalogoCache,
  type CatalogoCacheStatusLoja,
} from '../../api/produtos';

// A Ink ignora filtro de nome e de tipo em GET /v1/stores/products, então buscar produto pelo
// painel obrigava a varrer o catálogo inteiro a cada busca — lento e, pior, truncado no teto de
// páginas. Este card dispara a varredura UMA vez e persiste o catálogo em Postgres; depois disso a
// tela de Produtos responde do cache, com qualquer combinação de filtro. A renovação automática
// roda sozinha no intervalo escolhido (padrão 6h, pode ser pausada) — isto aqui é pro caso de precisar do catálogo atualizado na hora.
export function CatalogoCacheCard({ stores }: { stores: LojaOpcao[] }) {
  // `loja` guarda o storeId (identidade canônica); o nome é só rótulo.
  const [loja, setLoja] = useState(stores[0]?.id || '');
  const nomeDe = (id: string) => stores.find((st) => st.id === id)?.nome || 'sua loja';
  const [status, setStatus] = useState<CatalogoCacheStatusLoja[] | null>(null);
  const [intervalos, setIntervalos] = useState<number[]>([6, 12, 24, 48, 72, 168]);
  const [salvandoConfig, setSalvandoConfig] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function carregar() {
    getCatalogoCacheStatus()
      .then((r) => {
        setStatus(r.lojas);
        if (r.intervalosHoras?.length) setIntervalos(r.intervalosHoras);
      })
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, []);

  const daLoja = (status || []).find((s) => s.storeId === loja) || null;
  const rodando = !!daLoja?.sincronizando;

  // Polling só enquanto há varredura em andamento — o crawl leva minutos e o progresso por página
  // é o que dá sinal de vida.
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!(status || []).some((s) => s.sincronizando)) return;
    pollRef.current = setInterval(carregar, 4000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status]);

  async function confirmar() {
    setErro('');
    await sincronizarCatalogoCache();
    carregar();
  }

  async function salvarConfig(config: { pausado?: boolean; intervaloHoras?: number }) {
    setErro('');
    setSalvandoConfig(true);
    try {
      const r = await salvarCatalogoCacheConfig(config);
      setStatus((atual) => (atual || []).map((s) => (
        s.storeId === loja ? { ...s, autoPausado: r.autoPausado, intervaloHoras: r.intervaloHoras } : s
      )));
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setSalvandoConfig(false);
    }
  }

  const progresso = daLoja && daLoja.totalEstimado
    ? Math.min(100, Math.round((daLoja.processados / daLoja.totalEstimado) * 100))
    : 0;

  return (
    <Card title="Cache do catálogo de produtos">
      <p className="pc-nota">
        Varre o catálogo completo da Reserva Ink e guarda no banco — inclusive produto desativado, oculto e não
        aprovado. É o que faz a busca de produtos responder na hora, sem depender da API a cada consulta.
        Renova sozinho no intervalo escolhido abaixo — ou fica parado, se a renovação automática estiver pausada.
      </p>

      <div className="ds-form-row">
        <Field label="Loja">
          <Select value={loja} onChange={(e) => setLoja(e.target.value)} disabled={rodando || !stores.length}>
            {!stores.length && <option value="">Conecte a Reserva Ink pra sincronizar o catálogo</option>}
            {stores.map((st) => (
              <option key={st.id} value={st.id}>{st.nome}</option>
            ))}
          </Select>
        </Field>
        <Button className="ds-form-row__action" variant="secondary" onClick={() => setConfirmando(true)} disabled={rodando || !loja}>
          {rodando ? 'Sincronizando…' : 'Sincronizar catálogo agora'}
        </Button>
      </div>

      {daLoja && daLoja.configurado && (
        <div className="ds-stack ds-bloco-seguinte">
          <Switch
            checked={!daLoja.autoPausado}
            onChange={(ativo) => salvarConfig({ pausado: !ativo })}
            disabled={salvandoConfig}
            label="Renovação automática"
            description={daLoja.autoPausado
              ? `Pausada em ${nomeDe(loja)} — o cache só muda com "Sincronizar catálogo agora".`
              : `Varre o catálogo de ${nomeDe(loja)} sozinho a cada ${rotuloIntervalo(daLoja.intervaloHoras)}.`}
          />
          <Field label="Intervalo de renovação">
            <Select
              value={String(daLoja.intervaloHoras)}
              onChange={(e) => salvarConfig({ intervaloHoras: Number(e.target.value) })}
              disabled={salvandoConfig || daLoja.autoPausado}
            >
              {intervalos.map((h) => (
                <option key={h} value={h}>A cada {rotuloIntervalo(h)}</option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {erro && <p className="ds-form-error" role="alert">{erro}</p>}

      {status && (
        <div className="ds-stack ds-bloco-seguinte">
          {status.map((s) => (
            <div key={s.storeId} className="ds-stack">
              <div className="ds-status-linha">
                <strong>{nomeDe(s.storeId)}</strong>
                <StatusBadge
                  tone={s.sincronizando ? 'info' : s.erro ? 'danger' : s.total > 0 ? 'success' : 'neutral'}
                  label={s.sincronizando ? 'Sincronizando' : s.erro ? 'Falhou' : s.total > 0 ? 'Em cache' : 'Nunca sincronizado'}
                />
                {s.configurado && s.autoPausado && <StatusBadge tone="warning" label="Auto pausado" />}
                <span className="ds-status-linha__meta">
                  {s.sincronizando
                    ? `${plural(s.processados, 'produto lido', 'produtos lidos')}${s.totalEstimado ? ` de ~${s.totalEstimado}` : ''} — página ${s.paginas}`
                    : s.total > 0
                      ? `${plural(s.total, 'produto', 'produtos')} — atualizado ${formatData(s.sincronizadoEm)}`
                      : 'sem dados ainda'}
                </span>
              </div>
              {s.sincronizando && s.totalEstimado != null && (
                <ProgressBar value={progresso} label="Progresso da varredura do catálogo" showValue />
              )}
              {s.truncado && (
                <p className="pc-nota">
                  A varredura parou no teto de segurança de páginas — o cache pode estar incompleto nesta loja.
                </p>
              )}
              {s.erro && !s.sincronizando && <p className="pc-nota">{s.erro}</p>}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmando}
        onClose={() => setConfirmando(false)}
        title="Sincronizar catálogo completo"
        description={`Isso varre TODAS as páginas de produtos da Ink em ${nomeDe(loja)} (centenas de chamadas) e pode levar alguns minutos. A busca de produtos continua funcionando com o cache atual enquanto a varredura roda.`}
        confirmLabel="Sincronizar"
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
    </Card>
  );
}

function rotuloIntervalo(horas: number) {
  if (horas % 24 === 0) {
    const dias = horas / 24;
    return dias === 7 ? '1 semana' : plural(dias, 'dia', 'dias');
  }
  return `${horas} horas`;
}
