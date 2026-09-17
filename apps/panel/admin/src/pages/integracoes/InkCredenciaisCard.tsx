import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Callout, Card, ConfirmDialog, ErrorState, Field, FormActions, FormStack, Input, Skeleton, StatusBadge } from '../../components/ds';
import { copiar } from '../../lib/format';
import { toast } from '../../lib/toast';
import { useAuth } from '../../auth/AuthContext';
import {
  gerarUrlWebhookInk,
  getInkCredenciais,
  removerInkCredenciais,
  salvarInkCredenciais,
  testarConexao,
  type InkCredenciais,
} from '../../api/integracoes';

// Credencial da Reserva Ink desta loja (Fase 4). O token e a URL do feed são da Organization, cifrados
// no servidor; o painel só vê se estão cadastrados e os 4 últimos caracteres. Só o responsável
// (owner) grava ou remove — quem é equipe vê o estado e pode testar a conexão.
//
// Fase 5c: o webhook da Ink tem URL própria desta loja (gerada aqui, mostrada uma vez) e o segredo
// que a Ink mostra no cadastro do webhook fica cifrado junto com o resto.
export function InkCredenciaisCard({ onAlterado }: { onAlterado: () => void }) {
  const { organizacaoAtiva } = useAuth();
  const ehOwner = organizacaoAtiva?.papel === 'owner';
  const [dados, setDados] = useState<InkCredenciais | null>(null);
  const [erro, setErro] = useState('');
  const [token, setToken] = useState('');
  const [feed, setFeed] = useState('');
  const [segredoWebhook, setSegredoWebhook] = useState('');
  const [urlGerada, setUrlGerada] = useState<string | null>(null);
  const [urlCopiada, setUrlCopiada] = useState(false);
  const [confirmarUrl, setConfirmarUrl] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [teste, setTeste] = useState<string | null>(null);

  const carregar = useCallback(() => {
    setErro('');
    getInkCredenciais().then(setDados).catch((e: Error) => setErro(e.message));
  }, []);
  useEffect(carregar, [carregar]);

  const tokenInfo = dados?.segredos.find((s) => s.tipo === 'api_token');
  const feedInfo = dados?.segredos.find((s) => s.tipo === 'feed_url');
  const viaEnv = dados?.viaEnvLegado || [];

  function salvar(ev: FormEvent) {
    ev.preventDefault();
    const corpo: { apiToken?: string; feedUrl?: string; webhookSecret?: string } = {};
    if (token.trim()) corpo.apiToken = token.trim();
    if (feed.trim()) corpo.feedUrl = feed.trim();
    if (segredoWebhook.trim()) corpo.webhookSecret = segredoWebhook.trim();
    if (!corpo.apiToken && !corpo.feedUrl && !corpo.webhookSecret) return;
    setSalvando(true);
    setTeste(null);
    salvarInkCredenciais(corpo)
      .then((r) => {
        setToken(''); // o segredo nunca fica no estado da tela depois de enviado
        setFeed('');
        setSegredoWebhook('');
        setDados(r);
        toast('Credencial da Reserva Ink salva com criptografia.', 'sucesso');
        onAlterado();
      })
      .catch(() => {})
      .finally(() => setSalvando(false));
  }

  function gerarUrl() {
    return gerarUrlWebhookInk().then((r) => {
      setConfirmarUrl(false);
      setUrlCopiada(false);
      setUrlGerada(`${window.location.origin}${r.caminho}`);
      carregar();
    });
  }

  function remover() {
    setTeste(null);
    removerInkCredenciais()
      .then(() => { toast('Credencial da Reserva Ink removida.', 'sucesso'); carregar(); onAlterado(); })
      .catch(() => {});
  }

  function testar() {
    setTeste('Testando…');
    testarConexao('ink')
      .then((r) => setTeste(r.status === 'connected' ? 'Conexão com a Reserva Ink funcionando.' : `Falhou (${r.codigo || 'erro'}).`))
      .catch((e: Error) => setTeste(e.message));
  }

  return (
    <Card title="Credencial da Reserva Ink" description="Token da API e URL do feed desta loja. Ficam cifrados no servidor e nunca são exibidos de novo.">
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !dados && <Skeleton rows={2} />}
      {dados && (
        <>
          <div className="ad-integracao-item__topo">
            {tokenInfo ? (
              <StatusBadge tone="success" label={`Token cadastrado${tokenInfo.last4 ? ` · final ${tokenInfo.last4}` : ''}`} />
            ) : viaEnv.includes('api_token') ? (
              <StatusBadge tone="warning" label="Token vindo da configuração antiga" />
            ) : (
              <StatusBadge tone="warning" label="Token não cadastrado" />
            )}
            <StatusBadge tone={feedInfo ? 'success' : 'neutral'} label={feedInfo ? 'Feed cadastrado' : 'Feed não cadastrado'} />
            <StatusBadge
              tone={dados.webhook?.urlEmitida && dados.webhook?.segredoCadastrado ? 'success' : 'warning'}
              label={dados.webhook?.urlEmitida && dados.webhook?.segredoCadastrado ? 'Webhook configurado' : 'Webhook pendente'}
            />
          </div>
          {urlGerada && (
            <Callout tone="success" title="URL do webhook desta loja">
              <p className="pc-nota">Cole no cadastro de webhook da Reserva Ink. Por segurança, ela não aparece de novo.</p>
              <code className="wa-token">{urlGerada}</code>
              <Button variant="secondary" onClick={() => copiar(urlGerada, () => setUrlCopiada(true))}>
                {urlCopiada ? 'Copiada!' : 'Copiar URL'}
              </Button>
            </Callout>
          )}
          {!ehOwner && <p className="pc-nota">Só o responsável pela loja cadastra ou remove esta credencial.</p>}
          {ehOwner ? (
            <FormStack onSubmit={salvar}>
              <Field label={tokenInfo ? 'Substituir token da API' : 'Token da API'} hint="Gerado no painel da Reserva Ink. Não é salvo no navegador.">
                <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
              </Field>
              <Field label={feedInfo ? 'Substituir URL do feed' : 'URL do feed de produtos'} hint="Endereço https da Reserva Ink.">
                <Input type="url" autoComplete="off" spellCheck={false} value={feed} onChange={(e) => setFeed(e.target.value)} placeholder="https://" />
              </Field>
              <Field
                label={dados.webhook?.segredoCadastrado ? 'Substituir segredo do webhook' : 'Segredo do webhook'}
                optional
                hint="Mostrado pela Reserva Ink ao cadastrar o webhook. Usado para conferir cada evento recebido."
              >
                <Input type="password" autoComplete="off" spellCheck={false} value={segredoWebhook} onChange={(e) => setSegredoWebhook(e.target.value)} />
              </Field>
              <FormActions start={teste ? <span role="status">{teste}</span> : undefined}>
                <Button variant="ghost" onClick={() => (dados.webhook?.urlEmitida ? setConfirmarUrl(true) : gerarUrl())}>
                  {dados.webhook?.urlEmitida ? 'Gerar nova URL do webhook' : 'Gerar URL do webhook'}
                </Button>
                {tokenInfo && (
                  <>
                    <Button variant="ghost" onClick={testar}>Testar conexão</Button>
                    <Button variant="danger" onClick={remover}>Remover</Button>
                  </>
                )}
                <Button type="submit" disabled={salvando || (!token.trim() && !feed.trim() && !segredoWebhook.trim())}>
                  {salvando ? 'Salvando…' : 'Salvar'}
                </Button>
              </FormActions>
            </FormStack>
          ) : (
            (tokenInfo || viaEnv.includes('api_token')) && (
              <FormActions start={teste ? <span role="status">{teste}</span> : undefined}>
                <Button variant="ghost" onClick={testar}>Testar conexão</Button>
              </FormActions>
            )
          )}
        </>
      )}
      <ConfirmDialog
        open={confirmarUrl}
        onClose={() => setConfirmarUrl(false)}
        title="Gerar nova URL do webhook?"
        description="A URL atual para de receber eventos na hora. Troque a URL no cadastro de webhook da Reserva Ink logo em seguida."
        confirmLabel="Gerar nova URL"
        confirmVariant="danger"
        onConfirm={gerarUrl}
      />
    </Card>
  );
}
