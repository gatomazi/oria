import { Card, EmptyState, ErrorState, KpiCard, KpiStrip, Skeleton } from '../../components/ds';
import { metaNumero, metaPercentual, metaReais, metaRoas, metaVariacao, tendenciaMeta, type DirecaoBoa } from '../../lib/meta';
import type { MetaOverview, MetaPontoSerie } from '../../api/metaAds';
import { FunilMeta } from './FunilMeta';
import { MetaSerieChart } from './charts/MetaSerieChart';

interface Props {
  dados: MetaOverview | null;
  serie: MetaPontoSerie[] | null;
  erro: string;
  onRecarregar: () => void;
}

export function MetaVisaoGeralTab({ dados, serie, erro, onRecarregar }: Props) {
  if (erro) return <ErrorState description={erro} onRetry={onRecarregar} />;
  if (!dados) {
    return (
      <div className="ds-stack">
        <Skeleton rows={1} height="88px" />
        <Skeleton rows={1} height="220px" />
        <Skeleton variant="table" rows={5} />
      </div>
    );
  }

  const v = dados.variacoes;
  const d = dados.direcaoBoa as Record<string, DirecaoBoa>;

  // Monta as props de delta de um KPI a partir da semântica da métrica. Métrica neutra (gasto,
  // impressões) não recebe cor: a variação vai pro helper, como informação (spec §41). Sem período
  // anterior, nem delta nem helper de comparação — não existe base.
  function delta(chave: string, helperPadrao?: string) {
    const variacao = v ? v[chave] : null;
    const texto = metaVariacao(variacao);
    if (!texto) return { helper: helperPadrao };
    const trend = tendenciaMeta(variacao, d[chave]);
    // Sem cor (métrica neutra, ou variação imperceptível): a comparação vira informação no helper,
    // não um selo verde/vermelho que sugere um julgamento que o número não sustenta (spec §41).
    if (!trend) return { helper: `${texto} vs. período anterior` };
    return { delta: texto, trend, helper: helperPadrao };
  }

  const semDado = dados.impressions === 0 && dados.spend === 0;

  return (
    <div className="ds-stack">
      {semDado ? (
        <EmptyState
          title="Nenhuma campanha com entrega neste período"
          description="A conta está conectada e sincronizada, mas não houve impressão nem investimento no intervalo escolhido. Experimente um período maior."
        />
      ) : (
        <>
          <KpiStrip label="Investimento e entrega">
            <KpiCard title="Investimento" value={metaReais(dados.spend)} {...delta('spend')} />
            <KpiCard title="Impressões" value={metaNumero(dados.impressions)} {...delta('impressions')} />
            {/* Alcance do período a Meta não deduplica por dia — o número somado conta a mesma
                pessoa mais de uma vez, e o rótulo precisa dizer isso (spec §54). */}
            <KpiCard
              title="Alcance somado"
              value={metaNumero(dados.reachSomado)}
              helper="soma diária, não alcance único"
            />
            <KpiCard title="Frequência" value={dados.frequency != null ? dados.frequency.toLocaleString('pt-BR', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '—'} {...delta('frequency')} />
          </KpiStrip>

          <KpiStrip label="Tráfego">
            <KpiCard title="Cliques" value={metaNumero(dados.clicks)} {...delta('clicks', `${metaNumero(dados.inlineLinkClicks)} no link`)} />
            <KpiCard title="CTR" value={metaPercentual(dados.ctr)} {...delta('ctr')} />
            <KpiCard title="CPC" value={metaReais(dados.cpc)} {...delta('cpc')} />
            <KpiCard title="CPM" value={metaReais(dados.cpm)} {...delta('cpm')} />
          </KpiStrip>

          {/* "Meta" no rótulo não é enfeite: são compras e receita ATRIBUÍDAS pela Meta, que não são
              os pedidos reais da loja nem a receita do GA4. A spec §89 proíbe unificar os três. */}
          <KpiStrip label="Conversão atribuída pela Meta">
            <KpiCard title="Compras Meta" value={metaNumero(dados.purchases)} {...delta('purchases')} />
            <KpiCard title="Receita Meta" value={metaReais(dados.purchaseValue)} {...delta('purchaseValue')} />
            <KpiCard title="CPA Meta" value={metaReais(dados.cpa)} {...delta('cpa')} />
            <KpiCard title="ROAS Meta" value={metaRoas(dados.roas)} {...delta('roas')} />
          </KpiStrip>

          <Card
            title="Investimento e receita por dia"
            description="As duas séries dividem o mesmo eixo de propósito — é a distância entre elas que mostra se o dia se pagou."
          >
            {!serie ? (
              <Skeleton rows={1} height="220px" />
            ) : serie.length === 0 ? (
              <EmptyState title="Sem entrega no período" />
            ) : (
              <MetaSerieChart dados={serie} />
            )}
          </Card>

          <Card
            title="Funil Meta"
            description="Só eventos reportados pela Meta. A passagem impressões → cliques é o CTR, acima."
          >
            <FunilMeta m={dados} />
          </Card>
        </>
      )}
    </div>
  );
}
