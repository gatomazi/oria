import { useState } from 'react';
import { Button, Card, Field, FormActions, FormGrid, FormStack, Input } from '../../components/ds';
import { criarCampoCustomizado } from '../../api/campos';

// Porte de renderNovoCampo() em src/campos.js.
export function NovoCampoCard({ recarregar }: { recarregar: () => void }) {
  const [chave, setChave] = useState('');
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState('');
  const [msgErro, setMsgErro] = useState(false);
  const [criando, setCriando] = useState(false);

  function criar() {
    setMsg('');
    setMsgErro(false);
    const chaveNormalizada = chave.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(chaveNormalizada)) {
      setMsgErro(true);
      setMsg('chave inválida — só letras minúsculas, números e "_", começando com letra');
      return;
    }
    if (!label.trim()) {
      setMsgErro(true);
      setMsg('informe um nome');
      return;
    }
    setCriando(true);
    criarCampoCustomizado(chaveNormalizada, label.trim())
      .then(() => {
        setChave('');
        setLabel('');
        recarregar();
      })
      .catch((err: Error) => {
        setMsgErro(true);
        setMsg(err.message);
      })
      .finally(() => setCriando(false));
  }

  return (
    <Card title="Novo campo personalizado">
      <FormStack
        onSubmit={(e) => {
          e.preventDefault();
          criar();
        }}
      >
        <p className="pc-nota">
          Um valor por loja (ex: link do Instagram, WhatsApp de suporte) que passa a estar disponível pra usar em qualquer template, junto dos
          campos prontos (nome do cliente, número do pedido etc). Também pode embutir outro campo pronto no valor — ex: montar uma URL de rastreio
          com "{'{{cliente.documento}}/{{pedido.numero}}'}" (dá pra escolher clicando, depois de criar o campo).
        </p>
        <FormGrid min={260}>
          <Field label="Chave" hint='Só letras minúsculas, números e "_", sem espaço.'>
            <Input type="text" placeholder="ex: instagram" value={chave} onChange={(e) => setChave(e.target.value)} />
          </Field>
          <Field label="Nome" hint="Como aparece na lista de variáveis.">
            <Input type="text" placeholder="ex: Link do Instagram" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </FormGrid>
        {msg && (
          <p className={msgErro ? 'ds-form-error' : 'ds-form-note'} role={msgErro ? 'alert' : undefined}>
            {msg}
          </p>
        )}
        <FormActions>
          <Button type="submit" disabled={criando}>
            {criando ? 'Criando…' : 'Criar campo'}
          </Button>
        </FormActions>
      </FormStack>
    </Card>
  );
}
