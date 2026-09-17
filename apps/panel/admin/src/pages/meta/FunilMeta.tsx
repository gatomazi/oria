import { Fragment } from 'react';
import { Callout } from '../../components/ds';
import { metaNumero, metaPercentual } from '../../lib/meta';
import type { MetaMetricas } from '../../api/metaAds';

interface EtapaMeta {
  chave: string;
  rotulo: string;
  valor: number;
  ajuda: string;
  tom: 'info' | 'warning' | 'premium' | 'success';
}

// Funil Meta (spec §43). Reaproveita o desenho do funil do GA4 (mesmas classes .ga-funil), mas é
// outro funil: só eventos reportados pela Meta, nenhum dado de GA4 misturado — a spec é explícita
// nisso, porque os dois medem coisas diferentes e empilhá-los sugeriria uma continuidade que não
// existe.
//
// Duas decisões que se afastam da lista literal da spec, e o porquê:
//
// 1. Começa em CLIQUES, não em impressões. Com 2 milhões de impressões contra 375 compras, toda
//    barra depois da primeira vira um fio de 0,02% — o desenho deixaria de informar. A passagem
//    impressões → cliques é exatamente o CTR, que já aparece com destaque na faixa de KPIs acima.
// 2. A taxa entre etapas só é exibida quando é uma queda. `view_content` e `landing_page_view` são
//    CONTAGENS DE EVENTO, não de pessoas: o mesmo visitante dispara view_content várias vezes numa
//    sessão, então a etapa seguinte pode ser MAIOR que a anterior. Mostrar "139% seguiram" seria
//    absurdo; nesses casos a tela diz que não dá pra ler como passagem.
export function FunilMeta({ m }: { m: MetaMetricas }) {
  const etapas: EtapaMeta[] = [
    { chave: 'cliques', rotulo: 'Cliques no link', valor: m.inlineLinkClicks || m.clicks, ajuda: 'cliques que levaram ao site', tom: 'info' },
    { chave: 'lpv', rotulo: 'Página carregada', valor: m.landingPageViews, ajuda: 'landing_page_view', tom: 'info' },
    { chave: 'conteudo', rotulo: 'Viu produto', valor: m.viewContent, ajuda: 'view_content', tom: 'warning' },
    { chave: 'carrinho', rotulo: 'Adicionou ao carrinho', valor: m.addToCart, ajuda: 'add_to_cart', tom: 'warning' },
    { chave: 'checkout', rotulo: 'Iniciou checkout', valor: m.initiateCheckout, ajuda: 'initiate_checkout', tom: 'premium' },
    { chave: 'compra', rotulo: 'Compra', valor: m.purchases, ajuda: 'purchase', tom: 'success' },
  ];

  // Etapa que o pixel não reporta vem 0. Mostrá-la como "0% seguiram" diria que ninguém passou —
  // diferente de "esse evento não é medido". Some do desenho e é explicada uma vez só.
  const naoMedidas = etapas.filter((e) => e.chave !== 'cliques' && e.chave !== 'compra' && e.valor === 0);
  const visiveis = etapas.filter((e) => e.valor > 0 || e.chave === 'cliques' || e.chave === 'compra');
  const base = visiveis[0]?.valor || 1;

  return (
    <div>
      {naoMedidas.length > 0 && (
        <Callout tone="warning" title="Nem todo evento do funil está sendo medido">
          O pixel não reportou {naoMedidas.map((e) => e.ajuda).join(', ')} neste período. As etapas sem
          evento ficam fora do desenho — o funil só mostra o que a Meta realmente mediu.
        </Callout>
      )}

      <div className="ga-funil">
        {visiveis.map((etapa, i) => {
          const anterior = i > 0 ? visiveis[i - 1] : null;
          const passagem = anterior && anterior.valor > 0 ? etapa.valor / anterior.valor : null;
          return (
            <Fragment key={etapa.chave}>
              {passagem !== null && (
                <p className="ga-funil__passagem">
                  {passagem > 1
                    ? `mais eventos que na etapa anterior — ${etapa.ajuda} conta evento, não pessoa`
                    : `${metaPercentual(passagem * 100, 1)} seguiram para ${etapa.rotulo.toLowerCase()}`}
                </p>
              )}
              <div className="ga-funil__etapa">
                <span className="ga-funil__rotulo" title={etapa.ajuda}>{etapa.rotulo}</span>
                <span className="ga-funil__trilho">
                  <span
                    className={`ga-funil__preenchimento ga-funil__preenchimento--${etapa.tom}`}
                    style={{ transform: `scaleX(${Math.max(0.004, Math.min(1, etapa.valor / base))})` }}
                  />
                </span>
                <span className="ga-funil__valor">{metaNumero(etapa.valor)}</span>
              </div>
            </Fragment>
          );
        })}
      </div>

      <p className="ga-funil__resumo">
        <span>Clique → compra</span>
        <strong>
          {(m.inlineLinkClicks || m.clicks) > 0
            ? metaPercentual((m.purchases / (m.inlineLinkClicks || m.clicks)) * 100, 2)
            : '—'}
        </strong>
      </p>
    </div>
  );
}
