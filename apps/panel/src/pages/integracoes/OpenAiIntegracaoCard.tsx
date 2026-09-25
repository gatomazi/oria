import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, ConfirmDialog, Disclosure, ErrorState, Field, FormActions, FormStack, Input, Skeleton, StatusBadge } from '../../components/ds';
import { Secao, useAtualizarResumo } from './IntegracaoAcordeao';
import { toast } from '../../lib/toast';
import {
  getCriativosStatus,
  removeOpenAiKey,
  saveOpenAiKey,
  testOpenAiKey,
  type CriativosStatus,
} from '../../api/criativos';

// OpenAI API Key do Gerador de Criativos (BYOK). Mesmos endpoints de antes (/api/admin/criativos/settings/openai-key):
// a chave é cifrada no servidor e só os 4 últimos caracteres voltam. As rotas exigem o módulo ligado e
// Postgres, então o card explica quando não dá pra cadastrar em vez de mostrar um formulário que falha.
export function OpenAiIntegracaoCard() {
  const atualizarResumo = useAtualizarResumo();
  const [confirmarRemocao, setConfirmarRemocao] = useState(false);
  const [status, setStatus] = useState<CriativosStatus | null>(null);
  const [erro, setErro] = useState('');
  const [chave, setChave] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [teste, setTeste] = useState<string | null>(null);

  const carregar = useCallback(() => {
    setErro('');
    getCriativosStatus().then(setStatus).catch((e: Error) => setErro(e.message));
  }, []);
  useEffect(carregar, [carregar]);

  function salvar(ev: FormEvent) {
    ev.preventDefault();
    setSalvando(true);
    setTeste(null);
    saveOpenAiKey(chave)
      .then(() => {
        setChave(''); // a key nunca fica no estado da tela depois de enviada
        toast('API Key salva com criptografia.', 'sucesso');
        carregar();
        atualizarResumo();
      })
      .catch(() => {})
      .finally(() => setSalvando(false));
  }

  function remover() {
    setTeste(null);
    return removeOpenAiKey().then(() => { setConfirmarRemocao(false); toast('API Key removida.', 'sucesso'); carregar(); atualizarResumo(); });
  }

  function testar() {
    setTeste('Testando…');
    testOpenAiKey().then((r) => setTeste(r.ok ? 'Chave válida.' : `Falhou: ${r.reason}`)).catch((e: Error) => setTeste(e.message));
  }

  const habilitado = !!status?.flags.creative_generator;
  const podeCadastrar = habilitado && !!status?.postgres;
  const chaveInfo = status?.openaiKey;

  return (
    <Secao description="Chave própria (BYOK) usada pelos recursos de IA do Gerador de criativos. É cifrada no servidor e nunca é exibida de novo.">
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !status && <Skeleton rows={2} />}
      {status && (
        <>
          <div className="ad-integracao-item__topo">
            {!habilitado ? (
              <StatusBadge tone="neutral" label="Gerador de criativos desligado" />
            ) : chaveInfo?.configured ? (
              <StatusBadge tone="success" label={`Cadastrada · final ${chaveInfo.last4}`} />
            ) : (
              <StatusBadge tone="warning" label="Não cadastrada" />
            )}
          </div>
          {!habilitado && <p className="pc-nota">A chave só é usada pelo Gerador de criativos, que não está habilitado nesta conta.</p>}
          {habilitado && !status.postgres && <p className="ds-note">O cadastro da chave precisa de banco de dados configurado neste ambiente.</p>}
          {podeCadastrar && (
            <FormStack onSubmit={salvar}>
              <Field label={chaveInfo?.configured ? 'Substituir API Key' : 'API Key'} hint="Começa com sk-. Não é salva no navegador.">
                <Input type="password" autoComplete="off" spellCheck={false} value={chave} onChange={(e) => setChave(e.target.value)} placeholder="sk-..." />
              </Field>
              <FormActions start={teste ? <span role="status">{teste}</span> : undefined}>
                {chaveInfo?.configured && (
                  <>
                    <Button variant="ghost" onClick={() => setConfirmarRemocao(true)}>Remover</Button>
                    <Button variant="secondary" onClick={testar}>Testar chave</Button>
                  </>
                )}
                <Button type="submit" disabled={!chave || salvando}>{salvando ? 'Salvando…' : 'Salvar'}</Button>
              </FormActions>
            </FormStack>
          )}
          {/* Antes na aba Configurações do gerador: detalhe técnico do módulo, sob demanda. */}
          <Disclosure summary="Estado do módulo">
            <ul>
              <li>Serviço do gerador: {status.core.reachable ? 'no ar' : status.core.configured ? 'fora do ar' : 'não configurado'}</li>
              <li>Postgres: {status.postgres ? 'ok' : 'não configurado'}</li>
              {status.flagNames.map((f) => <li key={f}>{f}: {status.flags[f] ? 'ligada' : 'desligada'}</li>)}
            </ul>
          </Disclosure>
        </>
      )}
      <ConfirmDialog
        open={confirmarRemocao}
        onClose={() => setConfirmarRemocao(false)}
        title="Remover a chave da OpenAI?"
        description="O Gerador de criativos para de gerar imagens até uma nova chave ser cadastrada."
        confirmLabel="Remover"
        onConfirm={remover}
      />
    </Secao>
  );
}
