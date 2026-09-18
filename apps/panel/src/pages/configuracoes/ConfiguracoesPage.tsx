import { useEffect, useState } from 'react';
import { Button, Card, ErrorState, Field, FormActions, FormStack, Input, PageHeader, PageStack, Skeleton } from '../../components/ds';
import { getProductSettings, updateProductSettings } from '../../api/configuracoes';

import '../../configuracoes.css';

// Configurações gerais do painel (formulário do design system: campos, switch e ações).
export function ConfiguracoesPage() {
  const [nome, setNome] = useState('');
  const [carregado, setCarregado] = useState(false);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getProductSettings()
      .then((settings) => {
        setNome(settings.productName || '');
        setCarregado(true);
      })
      .catch((err: Error) => setErro(err.message));
  }, []);

  function salvar() {
    setSalvando(true);
    setMsg('');
    updateProductSettings({ productName: nome.trim() || 'Oria' })
      .then(() => {
        setMsg('Salvo — recarregue a página pra ver o efeito na sidebar.');
        setSalvando(false);
      })
      .catch(() => setSalvando(false));
  }

  return (
    <PageStack>
      <PageHeader title="Configurações" description={carregado ? 'Preferências gerais do painel.' : undefined} />

      {erro && <ErrorState description={erro} />}
      {!erro && !carregado && <Skeleton rows={3} />}
      {!erro && carregado && (
        <Card>
          <FormStack
            onSubmit={(ev) => {
              ev.preventDefault();
              salvar();
            }}
          >
            <Field label="Nome do produto" hint="Aparece na sidebar e no título das páginas.">
              <Input value={nome} onChange={(e) => setNome(e.target.value)} />
            </Field>

            <FormActions start={msg ? <span className="ds-form-note" role="status">{msg}</span> : undefined}>
              <Button type="submit" disabled={salvando}>
                {salvando ? 'Salvando…' : 'Salvar'}
              </Button>
            </FormActions>
          </FormStack>
        </Card>
      )}
    </PageStack>
  );
}
