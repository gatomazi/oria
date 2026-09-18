import { useEffect, useState } from 'react';
import { Button, Drawer, EmptyState, ErrorState, Skeleton, StatusBadge } from '../../components/ds';
import { formatData, formatValor } from '../../lib/format';
import { lookup, PRODUCT_STATUS_MAP } from '../../lib/statusMap';
import { atualizarProduto, getProduto, type ProdutoDetalhe } from '../../api/produtos';
import { ModalDuplicarProduto } from './ModalDuplicarProduto';

// Porte de abrirDrawer() em src/produtos.js.
function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="pc-kv__row">
      <span className="pc-kv__label">{label}</span>
      <span className="pc-kv__value">{value == null || value === '' ? '—' : String(value)}</span>
    </div>
  );
}

export function ProdutoDrawer({
  loja,
  id,
  onClose,
  onChanged,
}: {
  loja: string;
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [produto, setProduto] = useState<ProdutoDetalhe | null>(null);
  const [erro, setErro] = useState('');
  const [alternando, setAlternando] = useState(false);
  const [modalDuplicarAberto, setModalDuplicarAberto] = useState(false);

  function carregar() {
    setErro('');
    getProduto(id)
      .then((data) => setProduto(data.produto))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [loja, id]);

  function alternarVisibilidade() {
    if (!produto) return;
    setAlternando(true);
    atualizarProduto(id, { visibleInStore: !produto.visible_in_store })
      .then(() => {
        carregar();
        onChanged();
      })
      .catch(() => setAlternando(false));
  }

  const variantes = produto?.product_variants || [];

  return (
    <Drawer open onClose={onClose} title={`#${id}`}>
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !produto && <Skeleton rows={4} />}
      {!erro && produto && (
        <>
          <div className="pc-drawer-header">
            <div>{produto.name || 'Produto sem nome'}</div>
            <div className="pc-drawer-header__badges">
              {/* approval_status fica de fora: a Ink o mantém em "waiting" mesmo com o produto
                  publicado e vendendo (produto 4934698), então só confundia. `status` é o que vale. */}
              {produto.status && (
                <StatusBadge tone={lookup(PRODUCT_STATUS_MAP, produto.status).tone} label={lookup(PRODUCT_STATUS_MAP, produto.status).label} />
              )}
            </div>
          </div>

          <div className="pc-kv ds-bloco-seguinte ad-produto-drawer__kv">
            <Row label="Tipo" value={produto.product_type?.name} />
            <Row label="Preço" value={formatValor(produto.price)} />
            <Row label="Preço promocional" value={produto.promotional_price ? formatValor(produto.promotional_price) : null} />
            <Row label="Visível na loja" value={produto.visible_in_store ? 'Sim' : 'Não'} />
            <Row label="Personalizável pelo comprador" value={produto.customizable_by_buyer ? 'Sim' : 'Não'} />
            <Row label="Vendas totais" value={produto.total_sales_count} />
            <Row label="Atualizado em" value={produto.updated_at ? formatData(produto.updated_at) : null} />
          </div>

          <h3 className="ds-card__title">Variantes</h3>
          {!variantes.length ? (
            <EmptyState title="Sem variantes" />
          ) : (
            <ul className="pr-variantes">
              {variantes.map((v) => (
                <li key={v.id}>
                  <span>{[v.model, v.color, v.size].filter(Boolean).join(' · ') || `#${v.id}`}</span>
                  <span>{v.is_available ? 'Disponível' : 'Indisponível'}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="ds-button-row ds-bloco-seguinte">
            <Button variant="secondary" disabled={alternando} onClick={alternarVisibilidade}>
              {produto.visible_in_store ? 'Ocultar da loja' : 'Publicar na loja'}
            </Button>
            <Button variant="secondary" onClick={() => setModalDuplicarAberto(true)}>
              Duplicar para outro tipo
            </Button>
          </div>

          <ModalDuplicarProduto
            loja={loja}
            produtoId={id}
            open={modalDuplicarAberto}
            onClose={() => setModalDuplicarAberto(false)}
            onDuplicado={onChanged}
          />
        </>
      )}
    </Drawer>
  );
}
