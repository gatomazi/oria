import { Link } from 'react-router-dom';
import { Callout, Card, DataTable, ErrorState, KpiCard, KpiStrip, Skeleton, Tooltip, type Column } from '../../components/ds';
import { metaNumero, metaPercentual, metaReais, metaRoas } from '../../lib/meta';
import type { MetaConsolidado, MetaLinhaAtribuicao } from '../../api/metaAds';

interface Props {
  dados: MetaConsolidado | null;
  erro: string;
  codigoErro: string | null;
  onRecarregar: () => void;
}

// Linha da DRE. `destaque` marca os subtotais (Lucro do Produto, Lucro após Mídia, Lucro
// Operacional) — são as três respostas que a tela existe pra dar.
function Linha({ rotulo, valor, margem, negativo, destaque, ajuda }: {
  rotulo: string; valor: string; margem?: string | null; negativo?: boolean; destaque?: boolean; ajuda?: string;
}) {
  return (
    <div className={['meta-dre__linha', destaque ? 'meta-dre__linha--destaque' : null].filter(Boolean).join(' ')}>
      <span className="meta-dre__rotulo">
        {negativo ? <span className="meta-dre__sinal" aria-hidden="true">(−)</span> : null}
        {ajuda ? <Tooltip content={ajuda}><span>{rotulo}</span></Tooltip> : rotulo}
      </span>
      <span className="meta-dre__valor">{valor}</span>
      <span className="meta-dre__margem">{margem ?? ''}</span>
    </div>
  );
}

const COLUNAS_ATRIBUICAO: Column<MetaLinhaAtribuicao>[] = [
  { key: 'rotulo', label: 'Origem', render: (l) => <Tooltip content={l.fonte}><span>{l.rotulo}</span></Tooltip> },
  // Campo que a fonte NÃO mede vem null e sai como travessão. A spec §54 é explícita: não exibir
  // campo não equivalente como se fosse igual — a Meta não mede sessão, o GA4 não mede clique de
  // anúncio, e zerar qualquer um dos dois seria inventar uma medição.
  { key: 'sessoes', label: 'Sessões', align: 'right', render: (l) => (l.sessoes === null ? '—' : metaNumero(l.sessoes)) },
  { key: 'cliques', label: 'Cliques', align: 'right', render: (l) => (l.cliques === null ? '—' : metaNumero(l.cliques)) },
  { key: 'compras', label: 'Compras', align: 'right', render: (l) => (l.compras === null ? '—' : metaNumero(l.compras)) },
  { key: 'receita', label: 'Receita', align: 'right', render: (l) => (l.receita === null ? '—' : metaReais(l.receita)) },
];

export function MetaConsolidadoTab({ dados, erro, codigoErro, onRecarregar }: Props) {
  // Erro de configuração não é falha: é um passo que falta, e a ação fica junto da explicação.
  if (codigoErro === 'META_LOJA_NAO_DEFINIDA') {
    return (
      <Callout
        tone="warning"
        title="Falta dizer a qual loja esta conta de anúncios atribui o tráfego"
        action={<Link className="ds-btn ds-btn--secondary ds-btn--sm" to="/admin/integracoes">Definir em Integrações</Link>}
      >
        O MER e o ROAS de margem dividem a receita real da loja pelo gasto real da conta. Sem saber
        qual loja essa conta atende, o painel compararia receita e gasto de escopos diferentes — e o
        resultado pareceria melhor do que é.
      </Callout>
    );
  }
  if (erro) return <ErrorState description={erro} onRetry={onRecarregar} />;
  if (!dados) return <div className="ds-stack"><Skeleton rows={1} height="88px" /><Skeleton rows={1} height="260px" /></div>;

  const r = dados.resultado;
  const i = dados.indicadores;
  const pct = (v: number | null) => (v === null ? null : metaPercentual(v, 2));

  return (
    <div className="ds-stack">
      {/* O aviso de qualidade vem ANTES dos números, não depois: um lucro alto pode ser só gasto
          faltando, e descobrir isso no rodapé é tarde demais (spec §53AB). */}
      {dados.qualidade.nivel !== 'completo' && (
        <Callout
          tone={dados.qualidade.nivel === 'sem_dado' ? 'info' : 'warning'}
          title={dados.qualidade.nivel === 'sem_dado' ? 'Sem pedidos pagos no período' : 'Resultado parcial'}
        >
          <ul className="meta-dre__avisos">
            {dados.qualidade.avisos.map((a) => <li key={a}>{a}</li>)}
          </ul>
        </Callout>
      )}

      <Card
        title={`Resultado — ${dados.loja.nome}`}
        description={
          dados.cobertura.completa
            ? 'Receita e custo reais dos pedidos, gasto real das plataformas. Nenhum número aqui depende de atribuição.'
            // Com cobertura parcial, receita/custo/lucro vêm todos do MESMO subconjunto — o que
            // torna a margem correta, mas de um recorte. Dizer isso no cabeçalho evita ler os
            // R$ 61 mil de receita da loja aqui e não achá-los.
            : `Calculado sobre ${dados.cobertura.pedidosComFinanceiro} de ${dados.cobertura.pedidosTotal} pedidos pagos — os demais ainda não têm custo de produção. A receita total da loja no período foi ${metaReais(dados.cobertura.receitaTotal)}.`
        }
      >
        <div className="meta-dre">
          <Linha rotulo="Receita real" valor={metaReais(r.receita)} />
          <Linha rotulo="Custo de produção" valor={metaReais(r.custoProducao)} negativo
            ajuda="Vem do webhook do pedido, não de preço médio nem do catálogo." />
          <Linha rotulo="Lucro do Produto" valor={metaReais(r.lucroProduto)} margem={pct(r.margemProduto)} destaque
            ajuda="Valor da venda menos o custo de produção. Não inclui mídia, taxas nem despesas operacionais." />

          {Object.entries(r.midiaPorProvedor).map(([p, v]) => (
            <Linha key={p} rotulo={p === 'meta' ? 'Meta Ads' : p} valor={metaReais(v)} negativo />
          ))}
          <Linha rotulo="Lucro após Mídia" valor={metaReais(r.lucroAposMidia)} margem={pct(r.margemAposMidia)} destaque />

          {/* Sem despesas cadastradas o Lucro Operacional é DESCONHECIDO, não igual ao anterior.
              Mostrar travessão é o que impede a tela de parecer um fechamento que ela não é. */}
          <Linha rotulo="Despesas operacionais" valor={r.despesas === null ? '—' : metaReais(r.despesas)} negativo
            ajuda="Taxas, frete subsidiado, apps, serviços. Ainda não cadastrados neste painel." />
          <Linha rotulo="Lucro Operacional" valor={r.lucroOperacional === null ? '—' : metaReais(r.lucroOperacional)}
            margem={pct(r.margemOperacional)} destaque
            ajuda={r.lucroOperacional === null ? 'Depende das despesas operacionais, que ainda não são cadastradas.' : undefined} />
        </div>
      </Card>

      <KpiStrip label="Eficiência real">
        <KpiCard title="MER observado" value={metaRoas(i.mer)}
          helper="receita real ÷ mídia conectada" />
        <KpiCard title="ROAS de margem" value={metaRoas(i.roasDeMargem)}
          helper="margem ÷ mídia — o que sobrou por real investido" />
        <KpiCard title="Break-even ROAS" value={metaRoas(i.breakEvenRoas)}
          helper="abaixo disso a mídia come a margem" />
        <KpiCard title="Blended CAC" value={metaReais(i.blendedCac)}
          helper="inclui venda orgânica" />
      </KpiStrip>

      <Card
        title="De onde vieram as vendas"
        description="Comparação, não conciliação — cada fonte mede uma coisa diferente."
      >
        <DataTable
          label="Atribuição por origem"
          rows={dados.atribuicao}
          rowKey={(l) => l.origem}
          columns={COLUNAS_ATRIBUICAO}
        />
        <p className="pc-nota">
          Meta, GA4 e a loja usam fontes e janelas diferentes. Divergência é esperada e não significa
          erro de rastreamento. A <strong>loja</strong> é a única fonte financeira: é dela que sai o
          dinheiro que de fato entrou.
          {!dados.ga4Disponivel && ' O GA4 aparece vazio porque os dados deste período ainda não foram carregados em Analytics GA4.'}
        </p>
        {i.roasMeta !== null && (
          <p className="pc-nota">
            ROAS que a Meta reporta para si: <strong>{metaRoas(i.roasMeta)}</strong>. Convive com o MER
            de {metaRoas(i.mer)}, não o substitui — um mede o que a plataforma reivindica, o outro o
            que a loja realmente faturou por real de mídia.
          </p>
        )}
      </Card>
    </div>
  );
}
