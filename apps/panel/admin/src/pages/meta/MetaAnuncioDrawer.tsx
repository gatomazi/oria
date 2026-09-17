import { useEffect, useState } from 'react';
import { Drawer, EmptyState, ErrorState, KpiCard, KpiStrip, Skeleton, StatusBadge } from '../../components/ds';
import {
  META_FORMATO_ROTULO, metaNumero, metaPercentual, metaReais, metaRoas, metaSegundos,
  metaStatusRotulo, metaStatusTom,
} from '../../lib/meta';
import { getMetaAnuncio, type MetaAnuncioDetalhe } from '../../api/metaAds';
import { MetaSerieChart } from './charts/MetaSerieChart';

interface Props {
  adId: string | null;
  from: string;
  to: string;
  onClose: () => void;
}

// Detalhe do anúncio (spec §47). É aqui que as métricas de vídeo finalmente aparecem: elas vinham
// sendo sincronizadas e guardadas desde a Fase 2, sem nenhuma tela que as mostrasse.
export function MetaAnuncioDrawer({ adId, from, to, onClose }: Props) {
  const [dados, setDados] = useState<MetaAnuncioDetalhe | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!adId) { setDados(null); setErro(''); return; }
    setDados(null);
    setErro('');
    getMetaAnuncio(adId, from, to)
      .then(setDados)
      .catch((err: Error) => setErro(err.message));
  }, [adId, from, to]);

  const r = dados?.retencao;

  return (
    <Drawer
      open={!!adId}
      onClose={onClose}
      title={dados?.anuncio.nome || 'Anúncio'}
      description={dados ? [dados.anuncio.campanhaNome, dados.anuncio.adsetNome].filter(Boolean).join(' › ') : undefined}
    >
      {erro && <ErrorState description={erro} />}
      {!erro && !dados && <Skeleton rows={3} height="80px" />}
      {!erro && dados && (
        <div className="ds-stack">
          <div className="meta-criativo__topo">
            <StatusBadge tone={metaStatusTom(dados.anuncio.effectiveStatus)} label={metaStatusRotulo(dados.anuncio.effectiveStatus)} />
            {dados.criativo && <StatusBadge tone="neutral" label={META_FORMATO_ROTULO[dados.criativo.formato] || dados.criativo.formato} />}
          </div>

          {dados.criativo?.thumbnailUrl && (
            <img className="meta-anuncio__thumb" src={dados.criativo.thumbnailUrl} alt="" loading="lazy" />
          )}
          {dados.criativo?.title && <p className="meta-anuncio__title">{dados.criativo.title}</p>}
          {dados.criativo?.body && <p className="pc-nota">{dados.criativo.body}</p>}

          <KpiStrip label="Entrega">
            <KpiCard title="Investimento" value={metaReais(dados.spend)} />
            <KpiCard title="Impressões" value={metaNumero(dados.impressions)} />
            <KpiCard title="CTR" value={metaPercentual(dados.ctr)} />
            <KpiCard title="CPC" value={metaReais(dados.cpc)} />
          </KpiStrip>

          <KpiStrip label="Conversão atribuída pela Meta">
            <KpiCard title="Compras Meta" value={metaNumero(dados.purchases)} />
            <KpiCard title="Receita Meta" value={metaReais(dados.purchaseValue)} />
            <KpiCard title="CPA Meta" value={metaReais(dados.cpa)} />
            <KpiCard title="ROAS Meta" value={metaRoas(dados.roas)} />
          </KpiStrip>

          {/* Só para anúncio com reprodução real. Um bloco de vídeo zerado num anúncio de imagem
              sugeriria que ninguém assistiu, quando não há vídeo nenhum (spec §20). */}
          {r && (
            <KpiStrip label="Vídeo">
              <KpiCard title="Plays" value={metaNumero(dados.videoPlays)} helper={`ThruPlay ${metaNumero(dados.videoThruplays)}`} />
              <KpiCard title="Assistiu 50%" value={metaPercentual(r.p50, 0)} helper="de quem deu play" />
              <KpiCard title="Assistiu 100%" value={metaPercentual(r.p100, 0)} helper="de quem deu play" />
              <KpiCard title="Tempo médio" value={metaSegundos(dados.videoAvgWatchTime)} />
            </KpiStrip>
          )}

          <div>
            <h3 className="ds-section-title">Investimento e receita por dia</h3>
            {dados.serie.length === 0
              ? <EmptyState title="Sem entrega no período" />
              : <MetaSerieChart dados={dados.serie} />}
          </div>
        </div>
      )}
    </Drawer>
  );
}
