import { useEffect, useState } from 'react';
import { Field, Input, Modal } from '../../components/ds';
import { duplicarProduto, listProdutoTipos, type ProdutoTipo } from '../../api/produtos';

// Porte de abrirModalDuplicar() em src/produtos.js.
export function ModalDuplicarProduto({
  loja,
  produtoId,
  open,
  onClose,
  onDuplicado,
}: {
  loja: string;
  produtoId: number;
  open: boolean;
  onClose: () => void;
  onDuplicado: () => void;
}) {
  const [tipos, setTipos] = useState<ProdutoTipo[] | null>(null);
  const [tipoId, setTipoId] = useState<number | null>(null);
  const [preco, setPreco] = useState('');
  const [copiarCategorias, setCopiarCategorias] = useState(true);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTipos(null);
    setErro('');
    listProdutoTipos()
      .then((data) => {
        setTipos(data.tipos || []);
        setTipoId(data.tipos?.[0]?.id ?? null);
      })
      .catch((err: Error) => {
        setTipos([]);
        setErro(`Não foi possível carregar os tipos de produto: ${err.message}`);
      });
  }, [open, loja]);

  function fechar() {
    setPreco('');
    setCopiarCategorias(true);
    setErro('');
    setSalvando(false);
    onClose();
  }

  function confirmar() {
    if (tipoId == null) return;
    setSalvando(true);
    duplicarProduto(produtoId, {
      productTypeId: tipoId,
      price: preco.trim() || undefined,
      includeCategories: copiarCategorias,
    })
      .then(() => {
        fechar();
        onDuplicado();
      })
      .catch((err: Error) => {
        setSalvando(false);
        setErro(err.message);
      });
  }

  return (
    <Modal
      open={open}
      onClose={fechar}
      title="Duplicar produto para outro tipo"
      confirmLabel="Duplicar"
      confirmDisabled={salvando || !tipos}
      onConfirm={confirmar}
    >
      {!tipos ? (
        <p>Carregando tipos…</p>
      ) : (
        <>
          <Field label="Tipo de destino">
            <select className="ds-select" value={tipoId ?? ''} onChange={(e) => setTipoId(Number(e.target.value))}>
              {tipos.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Preço (opcional)" hint="Sem preço, usa o padrão do tipo de destino.">
            <Input placeholder="Ex: 129.90" value={preco} onChange={(e) => setPreco(e.target.value)} />
          </Field>
          <label className="ds-check-row">
            <input type="checkbox" checked={copiarCategorias} onChange={(e) => setCopiarCategorias(e.target.checked)} />
            {' '}Copiar categorias do produto original
          </label>
          {erro && <p className="ds-form-error">{erro}</p>}
        </>
      )}
    </Modal>
  );
}
