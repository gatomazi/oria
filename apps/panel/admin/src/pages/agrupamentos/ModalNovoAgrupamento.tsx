import { useState } from 'react';
import { Field, Input, Modal } from '../../components/ds';
import { criarAgrupamento } from '../../api/agrupamentos';

// Porte de abrirModalNovo() em src/agrupamentos.js.
export function ModalNovoAgrupamento({
  open,
  onClose,
  onCriado,
}: {
  open: boolean;
  onClose: () => void;
  onCriado: () => void;
}) {
  const [idsTexto, setIdsTexto] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  function fechar() {
    setIdsTexto('');
    setErro('');
    setSalvando(false);
    onClose();
  }

  function confirmar() {
    const ids = idsTexto
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
    if (ids.length < 2) {
      setErro('Informe ao menos 2 IDs válidos.');
      return;
    }
    setSalvando(true);
    criarAgrupamento(ids)
      .then(() => {
        fechar();
        onCriado();
      })
      .catch((err: Error) => {
        setSalvando(false);
        setErro(err.message);
      });
  }

  return (
    <Modal open={open} onClose={fechar} title="Agrupar produtos" confirmLabel="Agrupar" confirmDisabled={salvando} onConfirm={confirmar}>
      <p className="pc-nota">Informe os IDs de produto a agrupar (mínimo 2 — ou 1 novo + 1 já agrupado, pra entrar num grupo existente).</p>
      <Field label="IDs dos produtos (separados por vírgula)">
        <Input placeholder="Ex: 123, 456" value={idsTexto} onChange={(e) => setIdsTexto(e.target.value)} />
      </Field>
      {erro && <p className="ds-form-error">{erro}</p>}
    </Modal>
  );
}
