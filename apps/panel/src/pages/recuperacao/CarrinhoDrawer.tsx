import type { ReactNode } from 'react';
import { Button, Callout, Drawer, EmptyState, StatusBadge } from '../../components/ds';
import { formatData, formatTelefone, formatValor, plural, tempoDesde } from '../../lib/format';
import { lookup, RECUPERACAO_STATUS_MAP } from '../../lib/statusMap';
import type { RecuperacaoCarrinho } from '../../api/recuperacao';

// Detalhe de um carrinho abandonado: contato, o que ficou no carrinho e, quando o cliente já
// comprou depois, o pedido que encerrou a recuperação (achado do usuário, 2026-09-15 — a tela não
// mostrava isso e o carrinho seguia como "Aguardando").
interface CarrinhoDrawerProps {
  carrinho: RecuperacaoCarrinho;
  onClose: () => void;
  onVerPedido: (inkOrderId: string | number) => void;
  acoes?: ReactNode;
}

export function CarrinhoDrawer({ carrinho: c, onClose, onVerPedido, acoes }: CarrinhoDrawerProps) {
  const status = lookup(RECUPERACAO_STATUS_MAP, c.status);
  const itens = c.itens || [];
  const abandonado = tempoDesde(c.updatedAt);
  const linhas: [string, ReactNode][] = [
    ['E-mail', c.buyerEmail],
    ['Telefone', formatTelefone(c.buyerPhone)],
    ['Valor do carrinho', formatValor(c.valor)],
    ['Abandonado em', c.updatedAt ? formatData(c.updatedAt) : null],
    ['Mensagens enviadas', c.tentativas + (c.maxTentativas ? ` de ${c.maxTentativas}` : '')],
    ['Status', <StatusBadge tone={status.tone} label={status.label} />],
  ];

  return (
    <Drawer
      open
      onClose={onClose}
      title={c.buyerName || 'Cliente sem nome'}
      description={abandonado ? `Carrinho abandonado há ${abandonado.texto}` : 'Carrinho abandonado'}
      footer={
        c.compra ? (
          <Button variant="secondary" onClick={() => onVerPedido(c.compra!.inkOrderId)}>
            Ver pedido #{c.compra.inkOrderId}
          </Button>
        ) : (
          acoes
        )
      }
    >
      <div className="ds-stack">
        {c.compra && (
          <Callout tone="info" title="Esse cliente já comprou">
            Pedido #{c.compra.inkOrderId}
            {c.compra.em ? ` em ${formatData(c.compra.em)}` : ''}
            {c.compra.valor != null ? ` (${formatValor(c.compra.valor)})` : ''}. A recuperação desse carrinho foi encerrada e nenhuma mensagem é enviada.
          </Callout>
        )}
        {!c.contactable && !c.compra && (
          <Callout tone="warning" title="Sem permissão de contato">
            O cliente não aceitou receber mensagens de marketing, então esse carrinho não pode ser recuperado por WhatsApp.
          </Callout>
        )}

        <div className="pc-kv">
          {linhas.map(([label, valor]) => (
            <div className="pc-kv__row" key={label}>
              <span className="pc-kv__label">{label}</span>
              <span className="pc-kv__value">{valor == null || valor === '' ? '—' : valor}</span>
            </div>
          ))}
        </div>

        <h3 className="ds-card__title">{plural(itens.length || c.itemsCount || 0, 'item no carrinho', 'itens no carrinho')}</h3>
        {!itens.length ? (
          <EmptyState title="Itens indisponíveis" description="A Ink não devolveu os itens desse carrinho." />
        ) : (
          <ul className="rc-itens">
            {itens.map((item, i) => (
              <li className="rc-item" key={i}>
                {item.imagem ? (
                  <img className="rc-item__thumb" src={item.imagem} alt="" loading="lazy" />
                ) : (
                  <span className="rc-item__thumb rc-item__thumb--vazio" aria-hidden="true" />
                )}
                <span className="rc-item__info">
                  <span className="rc-item__nome">{item.nome || 'Produto sem nome'}</span>
                  {item.variante && <span className="rc-item__variante">{item.variante}</span>}
                </span>
                <span className="rc-item__valor">
                  <span>{formatValor(item.total) || '—'}</span>
                  <span className="rc-item__qtd">{item.quantidade}x</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
