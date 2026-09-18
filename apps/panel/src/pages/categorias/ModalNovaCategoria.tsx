import { useState } from 'react';
import { Field, Input, Modal } from '../../components/ds';
import { createCategoria } from '../../api/categorias';

// Porte de abrirModalNova() em src/categorias.js.
export function ModalNovaCategoria({
  open,
  onClose,
  onCriada,
}: {
  open: boolean;
  onClose: () => void;
  onCriada: () => void;
}) {
  const [nome, setNome] = useState('');
  const [descricao, setDescricao] = useState('');
  const [disponivel, setDisponivel] = useState(true);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  function fechar() {
    setNome('');
    setDescricao('');
    setDisponivel(true);
    setErro('');
    setSalvando(false);
    onClose();
  }

  function confirmar() {
    if (!nome.trim()) {
      setErro('Informe o nome.');
      return;
    }
    setSalvando(true);
    createCategoria({ name: nome.trim(), description: descricao.trim() || undefined, isAvailable: disponivel })
      .then(() => {
        fechar();
        onCriada();
      })
      .catch((err: Error) => {
        setSalvando(false);
        setErro(err.message);
      });
  }

  return (
    <Modal open={open} onClose={fechar} title="Nova categoria" confirmLabel="Criar" confirmDisabled={salvando} onConfirm={confirmar}>
      <Field label="Nome" hint="Máx. 20 caracteres (limite da Ink).">
        <Input value={nome} onChange={(e) => setNome(e.target.value)} />
      </Field>
      <Field label="Descrição (opcional)">
        <Input value={descricao} onChange={(e) => setDescricao(e.target.value)} />
      </Field>
      <label className="ds-check-row">
        <input type="checkbox" checked={disponivel} onChange={(e) => setDisponivel(e.target.checked)} />
        {' '}Disponível na loja
      </label>
      {erro && <p className="ds-form-error">{erro}</p>}
    </Modal>
  );
}
