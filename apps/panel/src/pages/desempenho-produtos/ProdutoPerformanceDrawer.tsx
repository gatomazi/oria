import { useEffect, useState } from 'react';
import { Drawer, ErrorState, Skeleton, StatusBadge } from '../../components/ds';
import { formatValor } from '../../lib/format';
import { getProductAnalyticsDetail, type ProductAnalyticsItem } from '../../api/productAnalytics';
import { formatarRazao, DIAGNOSTICO_LABEL, diagnosticoTone } from './formatadores';

// Detalhe do produto (I.3): identidade canônica, ids externos, funil GA4 no período, razões entre
// contagens de item, diagnósticos com explicação. Sem fluxo de correção manual de mapping nesta
// rodada (nenhum endpoint/domain seguro pra isso ainda — rodada seguinte).

const ETAPAS_FUNIL: { key: keyof NonNullable<ProductAnalyticsItem['metrics']>; label: string }[] = [
  { key: 'itemsViewed', label: 'Visualizado' },
  { key: 'itemsAddedToCart', label: 'Adicionado ao carrinho' },
  { key: 'itemsCheckedOut', label: 'Checkout iniciado' },
  { key: 'itemsPurchased', label: 'Comprado (observado)' },
];

function FunilItens({ metrics }: { metrics: ProductAnalyticsItem['metrics'] }) {
  return (
    <div className="pa-funil" role="list" aria-label="Funil de itens no período (GA4)">
      {ETAPAS_FUNIL.map((etapa) => {
        const v = metrics ? metrics[etapa.key] : null;
        return (
          <div className="pa-funil__etapa" role="listitem" key={etapa.key}>
            <span className="pa-funil__valor">{v ?? '—'}</span>
            <span className="pa-funil__label">{etapa.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ProdutoPerformanceDrawer({
  productId, periodo, onClose,
}: {
  productId: string;
  periodo: { startDate: string; endDate: string };
  onClose: () => void;
}) {
  const [item, setItem] = useState<ProductAnalyticsItem | null>(null);
  const [erro, setErro] = useState('');

  function carregar() {
    setErro('');
    setItem(null);
    getProductAnalyticsDetail(productId, periodo)
      .then(setItem)
      .catch((err: Error) => setErro(err.message));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [productId, periodo.startDate, periodo.endDate]);

  return (
    <Drawer open onClose={onClose} title={item ? item.product.name : 'Desempenho do produto'} description={item ? `${periodo.startDate} a ${periodo.endDate}` : undefined}>
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !item && <Skeleton rows={6} />}
      {!erro && item && (
        <div className="ds-stack">
          <section>
            <h3 className="pa-drawer__secao-titulo">Identidade</h3>
            <dl className="pa-drawer__dl">
              <div><dt>Produto</dt><dd>{item.product.name}</dd></div>
              <div><dt>Tipo</dt><dd>{item.product.productType || '—'}</dd></div>
              <div><dt>Provider</dt><dd>{item.product.provider} · {item.product.providerProductId}</dd></div>
              <div>
                <dt>Ids observados pelo GA4</dt>
                <dd>{item.identity.matchedAnalyticsIds.length ? item.identity.matchedAnalyticsIds.join(', ') : '—'}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3 className="pa-drawer__secao-titulo">Funil de itens no período (GA4)</h3>
            <FunilItens metrics={item.metrics} />
            <p className="ds-note">Quantidades de ITEM — nunca usuários, sessões ou pedidos.</p>
          </section>

          <section>
            <h3 className="pa-drawer__secao-titulo">Razões entre contagens de item</h3>
            <dl className="pa-drawer__dl">
              <div><dt>Carrinho / visualização</dt><dd>{formatarRazao(item.itemRatios.itemsAddedToCartPerItemViewed)}</dd></div>
              <div><dt>Checkout / visualização</dt><dd>{formatarRazao(item.itemRatios.itemsCheckedOutPerItemViewed)}</dd></div>
              <div><dt>Checkout / carrinho</dt><dd>{formatarRazao(item.itemRatios.itemsCheckedOutPerItemAddedToCart)}</dd></div>
              <div><dt>Compra / visualização</dt><dd>{formatarRazao(item.itemRatios.itemsPurchasedPerItemViewed)}</dd></div>
            </dl>
          </section>

          <section>
            <h3 className="pa-drawer__secao-titulo">Receita GA4 (item revenue)</h3>
            <p className="pa-drawer__receita">{item.metrics?.itemRevenue != null ? formatValor(item.metrics.itemRevenue) : '—'}</p>
          </section>

          {item.diagnostics.length > 0 && (
            <section>
              <h3 className="pa-drawer__secao-titulo">Diagnósticos</h3>
              <ul className="pa-drawer__diagnosticos">
                {item.diagnostics.map((d) => (
                  <li key={d}>
                    <StatusBadge tone={diagnosticoTone(d)} label={DIAGNOSTICO_LABEL[d] || d} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
