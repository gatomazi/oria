import { useEffect, useRef, useState } from 'react';
import { Button, Field, Select, StatusBadge, Switch } from '../../components/ds';
import { Secao } from './IntegracaoAcordeao';
import { formatData, plural } from '../../lib/format';
import {
  getCategoriasCacheStatus,
  salvarCategoriasCacheConfig,
  sincronizarCategoriasCache,
  type CategoriasCacheStatus,
} from '../../api/categorias';

// Sync de Categorias — irmão do CatalogoCacheCard. A tela de Categorias lia a Ink ao vivo a cada abertura,
// trazendo todos os `product_ids` de cada categoria (a maior tem ~100 mil). Com o cache, a listagem responde
// do Postgres; a renovação automática roda sozinha no intervalo escolhido (padrão 6h, pode ser pausada).
// São poucas chamadas à Ink (100 categorias por página), então não há confirmação nem barra de progresso.
export function CategoriasCacheCard({ lojaNome }: { lojaNome: string }) {
  const [status, setStatus] = useState<CategoriasCacheStatus | null>(null);
  const [salvandoConfig, setSalvandoConfig] = useState(false);
  const [disparando, setDisparando] = useState(false);
  const [erro, setErro] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function carregar() {
    getCategoriasCacheStatus().then(setStatus).catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, []);

  const rodando = !!status?.sincronizando;

  // Polling só enquanto a varredura roda.
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!rodando) return;
    pollRef.current = setInterval(carregar, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [rodando]);

  async function sincronizar() {
    setErro('');
    setDisparando(true);
    try {
      await sincronizarCategoriasCache();
      carregar();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setDisparando(false);
    }
  }

  async function salvarConfig(config: { pausado?: boolean; intervaloHoras?: number }) {
    setErro('');
    setSalvandoConfig(true);
    try {
      const r = await salvarCategoriasCacheConfig(config);
      setStatus((atual) => (atual ? { ...atual, autoPausado: r.autoPausado, intervaloHoras: r.intervaloHoras } : atual));
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setSalvandoConfig(false);
    }
  }

  const sincronizado = !!status?.concluidoEm;

  return (
    <Secao
      title="Categorias"
      description="Guarda as categorias da Reserva Ink para a tela de Categorias abrir na hora. Criar, editar e excluir continuam indo direto para a Ink."
    >
      <div className="ds-form-row">
        <div className="ds-status-linha">
          <strong>{lojaNome}</strong>
          {status && (
            <StatusBadge
              tone={rodando ? 'info' : status.erro ? 'danger' : sincronizado ? 'success' : 'neutral'}
              label={rodando ? 'Sincronizando' : status.erro ? 'Falhou' : sincronizado ? 'Em cache' : 'Nunca sincronizado'}
            />
          )}
          {status?.configurado && status.autoPausado && <StatusBadge tone="warning" label="Auto pausado" />}
          {status && (
            <span className="ds-status-linha__meta">
              {rodando
                ? `lendo a página ${Math.max(status.paginas, 1)}`
                : sincronizado
                  ? `${plural(status.total, 'categoria', 'categorias')} — atualizado ${formatData(status.concluidoEm)}`
                  : 'sem dados ainda — a tela de Categorias lê a Ink ao vivo até a primeira sincronização'}
            </span>
          )}
        </div>
        <Button className="ds-form-row__action" variant="secondary" onClick={sincronizar} disabled={rodando || disparando || !status?.configurado}>
          {rodando ? 'Sincronizando…' : 'Sincronizar categorias agora'}
        </Button>
      </div>

      {status && status.configurado && (
        <div className="ds-stack ds-bloco-seguinte">
          <Switch
            checked={!status.autoPausado}
            onChange={(ativo) => salvarConfig({ pausado: !ativo })}
            disabled={salvandoConfig}
            label="Renovação automática"
            description={status.autoPausado
              ? 'Pausada — o cache só muda com "Sincronizar categorias agora" e com as edições feitas pelo Oria.'
              : `Sincroniza as categorias sozinho a cada ${rotuloIntervalo(status.intervaloHoras)}.`}
          />
          <Field label="Intervalo de renovação">
            <Select
              value={String(status.intervaloHoras)}
              onChange={(e) => salvarConfig({ intervaloHoras: Number(e.target.value) })}
              disabled={salvandoConfig || status.autoPausado}
            >
              {status.intervalosHoras.map((h) => (
                <option key={h} value={h}>A cada {rotuloIntervalo(h)}</option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {erro && <p className="ds-form-error" role="alert">{erro}</p>}
      {status?.erro && !rodando && <p className="pc-nota">{status.erro}</p>}
    </Secao>
  );
}

function rotuloIntervalo(horas: number) {
  if (horas % 24 === 0) {
    const dias = horas / 24;
    return dias === 7 ? '1 semana' : plural(dias, 'dia', 'dias');
  }
  return `${horas} horas`;
}
