import { Fragment } from 'react';
import { Callout } from '../../components/ds';
import { formatNumero, formatPercentual } from '../../lib/ga4';
import type { GaOverviewTotais } from '../../api/googleAnalytics';

interface Etapa {
  chave: string;
  rotulo: string;
  valor: number;
  ajuda: string;
  tom: 'info' | 'warning' | 'premium' | 'success';
}

// Funil sessão → carrinho → checkout → pedido. A taxa entre duas etapas é sempre relativa à etapa
// IMEDIATAMENTE anterior ("de quem chegou ali, quantos seguiram"), nunca ao topo — misturar as duas
// leituras é o erro clássico de funil.
export function FunilConversao({ totais }: { totais: GaOverviewTotais }) {
  const todas: Etapa[] = [
    { chave: 'sessoes', rotulo: 'Sessões', valor: totais.sessions, ajuda: 'visitas no período', tom: 'info' },
    { chave: 'carrinho', rotulo: 'Adicionou ao carrinho', valor: totais.addToCarts, ajuda: 'evento add_to_cart', tom: 'warning' },
    { chave: 'checkout', rotulo: 'Iniciou checkout', valor: totais.checkouts, ajuda: 'evento begin_checkout', tom: 'premium' },
    { chave: 'pedido', rotulo: 'Pedido finalizado', valor: totais.purchases, ajuda: 'evento purchase', tom: 'success' },
  ];

  // Loja que não dispara add_to_cart/begin_checkout devolve 0 nessas etapas. Mostrar "0%" ali diria
  // que ninguém carrinha — que é bem diferente de "esse evento não é medido nesta propriedade".
  const meioNaoMedido = totais.addToCarts === 0 && totais.checkouts === 0 && totais.purchases > 0;
  const etapas = meioNaoMedido ? todas.filter((e) => e.chave === 'sessoes' || e.chave === 'pedido') : todas;
  const base = etapas[0].valor || 1;

  return (
    <div>
      {meioNaoMedido && (
        <Callout tone="warning" title="Carrinho e checkout não estão sendo medidos">
          Esta propriedade do GA4 não registrou nenhum evento <code>add_to_cart</code> nem{' '}
          <code>begin_checkout</code> no período, mesmo havendo pedidos. O funil mostra só as etapas com
          evento real — as duas do meio dependem de configuração na loja.
        </Callout>
      )}

      <div className="ga-funil">
        {etapas.map((etapa, i) => {
          const anterior = i > 0 ? etapas[i - 1] : null;
          const passagem = anterior && anterior.valor > 0 ? etapa.valor / anterior.valor : null;
          return (
            <Fragment key={etapa.chave}>
              {passagem !== null && (
                <p className="ga-funil__passagem">
                  {formatPercentual(passagem)} seguiram para {etapa.rotulo.toLowerCase()}
                </p>
              )}
              <div className="ga-funil__etapa">
                <span className="ga-funil__rotulo" title={etapa.ajuda}>{etapa.rotulo}</span>
                <span className="ga-funil__trilho">
                  <span
                    className={`ga-funil__preenchimento ga-funil__preenchimento--${etapa.tom}`}
                    style={{ transform: `scaleX(${Math.max(0.004, etapa.valor / base)})` }}
                  />
                </span>
                <span className="ga-funil__valor">{formatNumero(etapa.valor)}</span>
              </div>
            </Fragment>
          );
        })}
      </div>

      <p className="ga-funil__resumo">
        <span>Taxa geral sessão → pedido</span>
        <strong>{formatPercentual(totais.conversionRate, 2)}</strong>
      </p>
    </div>
  );
}
