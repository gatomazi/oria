import { useEffect, useState } from 'react';
import { Button, DataTable, EmptyState, ErrorState, PageHeader, Skeleton } from '../../components/ds';
import { useLojaAtiva } from '../../auth/AuthContext';
import { listAgrupamentos, type Agrupamento } from '../../api/agrupamentos';
import { ModalNovoAgrupamento } from './ModalNovoAgrupamento';
import { AgrupamentoDrawer } from './AgrupamentoDrawer';

import '../../../../src/pedidos-central.css';
import '../../../../src/trocas-nova.css';
import '../../../../src/produtos.css';

function Thumb({ a }: { a: Agrupamento }) {
  if (a.defaultProductImageUrl) return <img className="pr-thumb" src={a.defaultProductImageUrl} alt="" />;
  return <div className="pr-thumb pr-thumb--placeholder">sem foto</div>;
}

// Porte de src/agrupamentos.js.
export function AgrupamentosPage() {
  const lojaSelecionada = useLojaAtiva() ?? '';
  const lojaReal = lojaSelecionada;

  const [agrupamentos, setAgrupamentos] = useState<Agrupamento[] | null>(null);
  const [erro, setErro] = useState('');
  const [modalAberto, setModalAberto] = useState(false);
  const [drawerId, setDrawerId] = useState<number | null>(null);

  function carregar() {
    setErro('');
    setAgrupamentos(null);
    listAgrupamentos()
      .then((data) => setAgrupamentos(data.agrupamentos || []))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [lojaReal]);

  const prefixo = '';

  return (
    <>
      <PageHeader
        title="Agrupamentos"
        description={`${prefixo}Mesma estampa aplicada em tipos de produto diferentes, exibida como 1 card na vitrine.`}
        actions={
          <Button variant="primary" onClick={() => setModalAberto(true)}>
            Agrupar produtos
          </Button>
        }
      />

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !agrupamentos && <Skeleton variant="table" rows={6} />}
      {!erro && agrupamentos && agrupamentos.length === 0 && <EmptyState title="Nenhum agrupamento ainda" />}
      {!erro && agrupamentos && agrupamentos.length > 0 && (
        <DataTable
          rows={agrupamentos}
          rowKey={(a) => a.id}
          onRowClick={(a) => setDrawerId(a.id)}
          columns={[
            { key: 'img', label: '', render: (a) => <Thumb a={a} /> },
            {
              key: 'vitrine',
              label: 'Produto de vitrine',
              render: (a) => (
                <div>
                  <div>{a.defaultProductName || 'Produto não encontrado'}</div>
                  <div className="ds-form-note">#{a.default_product_id}</div>
                </div>
              ),
              sortValue: (a) => a.defaultProductName,
            },
            {
              key: 'produtos',
              label: 'Produtos associados',
              render: (a) => a.product_ids.length,
              sortValue: (a) => a.product_ids.length,
            },
            { key: 'id', label: 'Agrupamento', render: (a) => <span className="ds-form-note">#{a.id}</span>, sortValue: (a) => a.id },
          ]}
        />
      )}

      <ModalNovoAgrupamento open={modalAberto} onClose={() => setModalAberto(false)} onCriado={carregar} />

      {drawerId != null && (
        <AgrupamentoDrawer loja={lojaReal} id={drawerId} onClose={() => setDrawerId(null)} onChanged={carregar} />
      )}
    </>
  );
}
