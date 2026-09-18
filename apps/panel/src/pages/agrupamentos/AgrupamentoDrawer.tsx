import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, Drawer, ErrorState, Skeleton } from '../../components/ds';
import { getAgrupamento, removerProdutoDoAgrupamento, type Agrupamento, type ProdutoResumo } from '../../api/agrupamentos';

// Porte de abrirDrawer() em src/agrupamentos.js.
export function AgrupamentoDrawer({
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
  const [agrupamento, setAgrupamento] = useState<Agrupamento | null>(null);
  const [produtos, setProdutos] = useState<ProdutoResumo[]>([]);
  const [erro, setErro] = useState('');
  const [removendo, setRemovendo] = useState<number | null>(null);

  function carregar() {
    setErro('');
    getAgrupamento(id)
      .then((data) => {
        setAgrupamento(data.agrupamento);
        setProdutos(data.produtos || []);
      })
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [loja, id]);

  async function remover(pid: number) {
    const res = await removerProdutoDoAgrupamento(id, pid);
    if (res.dissolvido) {
      onClose();
      onChanged();
      return;
    }
    carregar();
    onChanged();
  }

  const produtoVitrine = agrupamento ? produtos.find((p) => p.id === agrupamento.default_product_id) : null;
  const produtoRemovendo = removendo != null ? produtos.find((p) => p.id === removendo) : null;

  return (
    <Drawer open onClose={onClose} title={`Agrupamento #${id}`}>
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !agrupamento && <Skeleton rows={4} />}
      {!erro && agrupamento && (
        <>
          <p className="pc-nota">Produto de vitrine: {produtoVitrine ? produtoVitrine.name : `#${agrupamento.default_product_id}`}</p>
          {(agrupamento.product_ids || []).length <= 2 && (
            <p className="ds-form-error">Removendo mais 1 produto, o agrupamento é desfeito (mínimo de 2).</p>
          )}
          <ul className="pr-variantes">
            {agrupamento.product_ids.map((pid) => {
              const produto = produtos.find((p) => p.id === pid);
              const label = (produto ? produto.name : `Produto #${pid}`) + (produto?.product_type ? ` · ${produto.product_type.name}` : '');
              return (
                <li key={pid}>
                  <span>{label}</span>
                  <Button variant="ghost" onClick={() => setRemovendo(pid)}>
                    Remover do grupo
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <ConfirmDialog
        open={removendo != null}
        onClose={() => setRemovendo(null)}
        title={`Remover "${produtoRemovendo ? produtoRemovendo.name : 'este produto'}" do agrupamento?`}
        confirmLabel="Remover"
        onConfirm={() => (removendo != null ? remover(removendo) : undefined)}
      />
    </Drawer>
  );
}
