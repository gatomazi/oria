import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Callout, ConfirmDialog, ErrorState, Field, FormActions, FormStack, Input, Skeleton, StatusBadge } from '../../components/ds';
import { copiar, formatData } from '../../lib/format';
import { toast } from '../../lib/toast';
import { InkWebhookGuia } from './InkWebhookGuia';
import { Secao, useAtualizarResumo, useEhOwner } from './IntegracaoAcordeao';
import {
  gerarUrlWebhookInk,
  getInkCredenciais,
  removerInkCredenciais,
  salvarInkCredenciais,
  testarConexao,
  type InkCredenciais,
} from '../../api/integracoes';

// Credencial da Reserva Ink desta loja (Fase 4). O token e a URL do webhook são da Organization, cifrados
// no servidor; o painel só vê se estão cadastrados e os 4 últimos caracteres. Só o responsável
// (owner) grava ou remove — quem é equipe vê o estado e pode testar a conexão.
//
// Fase 5c: o recebimento automático (webhook da Ink) tem URL própria desta loja (gerada aqui, mostrada
// uma vez) e o segredo que a Ink mostra no cadastro do webhook fica cifrado junto com o resto.
//
// Redesign de Integrações: o antigo card único virou duas seções do card da Reserva Ink — Conexão
// (token) e Pedidos (recebimento automático) — que compartilham o mesmo estado carregado aqui.
export function useInkCredenciais() {
  const [dados, setDados] = useState<InkCredenciais | null>(null);
  const [erro, setErro] = useState('');
  const carregar = useCallback(() => {
    setErro('');
    getInkCredenciais().then(setDados).catch((e: Error) => setErro(e.message));
  }, []);
  useEffect(carregar, [carregar]);
  return { dados, setDados, erro, carregar };
}

export type InkCredenciaisEstado = ReturnType<typeof useInkCredenciais>;

export function InkConexaoSecao({ estado, lojaNome }: { estado: InkCredenciaisEstado; lojaNome: string | null }) {
  const ehOwner = useEhOwner();
  const atualizarResumo = useAtualizarResumo();
  const { dados, setDados, erro, carregar } = estado;
  const [token, setToken] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [teste, setTeste] = useState<string | null>(null);
  const [confirmarRemocao, setConfirmarRemocao] = useState(false);

  const tokenInfo = dados?.segredos.find((s) => s.tipo === 'api_token');
  const viaEnv = dados?.viaEnvLegado || [];

  function salvar(ev: FormEvent) {
    ev.preventDefault();
    if (!token.trim()) return;
    setSalvando(true);
    setTeste(null);
    salvarInkCredenciais({ apiToken: token.trim() })
      .then((r) => {
        setToken(''); // o segredo nunca fica no estado da tela depois de enviado
        setDados(r);
        toast('Credencial da Reserva Ink salva com criptografia.', 'sucesso');
        atualizarResumo();
      })
      .catch(() => {})
      .finally(() => setSalvando(false));
  }

  function remover() {
    setTeste(null);
    return removerInkCredenciais().then(() => {
      setConfirmarRemocao(false);
      toast('Credencial da Reserva Ink removida.', 'sucesso');
      carregar();
      atualizarResumo();
    });
  }

  function testar() {
    setTeste('Testando…');
    testarConexao('ink')
      .then((r) => setTeste(r.status === 'connected' ? 'Conexão com a Reserva Ink funcionando.' : `Falhou (${r.codigo || 'erro'}).`))
      .catch((e: Error) => setTeste(e.message));
  }

  return (
    <Secao title="Conexão" description="Token da API desta loja. Fica cifrado no servidor e nunca é exibido de novo.">
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !dados && <Skeleton rows={2} />}
      {dados && (
        <>
          <div className="ig-linha-estado">
            {tokenInfo ? (
              <StatusBadge tone="success" label={`Credencial cadastrada${tokenInfo.last4 ? ` · final ${tokenInfo.last4}` : ''}`} />
            ) : viaEnv.includes('api_token') ? (
              <StatusBadge tone="warning" label="Credencial vinda da configuração antiga" />
            ) : (
              <StatusBadge tone="neutral" label="Credencial não cadastrada" />
            )}
            {lojaNome && <span className="ig-meta">Loja: {lojaNome}</span>}
          </div>
          {!tokenInfo && !viaEnv.includes('api_token') && (
            <p className="pc-nota">Esta loja ainda não tem credencial da Reserva Ink. Cole o token da API abaixo para começar a receber pedidos e produtos.</p>
          )}
          {!ehOwner && <p className="pc-nota">Só o responsável pela loja cadastra ou remove esta credencial.</p>}
          {ehOwner ? (
            <FormStack onSubmit={salvar}>
              <Field label={tokenInfo ? 'Substituir token da API' : 'Token da API'} hint="Gerado no painel da Reserva Ink. Não é salvo no navegador.">
                <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
              </Field>
              <FormActions start={teste ? <span role="status">{teste}</span> : undefined}>
                {tokenInfo && (
                  <>
                    <Button variant="ghost" onClick={testar}>Testar conexão</Button>
                    <Button variant="danger" onClick={() => setConfirmarRemocao(true)}>Remover</Button>
                  </>
                )}
                <Button type="submit" disabled={salvando || !token.trim()}>
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
        open={confirmarRemocao}
        onClose={() => setConfirmarRemocao(false)}
        title="Remover a credencial da Reserva Ink?"
        description="Pedidos, produtos e catálogo deixam de sincronizar até uma nova credencial ser cadastrada. Os dados já sincronizados continuam no painel."
        confirmLabel="Remover"
        onConfirm={remover}
      />
    </Secao>
  );
}

export function InkRecebimentoSecao({ estado, ultimoEventoEm }: { estado: InkCredenciaisEstado; ultimoEventoEm: string | null }) {
  const ehOwner = useEhOwner();
  const atualizarResumo = useAtualizarResumo();
  const { dados, setDados, erro, carregar } = estado;
  const [segredoWebhook, setSegredoWebhook] = useState('');
  const [urlGerada, setUrlGerada] = useState<string | null>(null);
  const [urlCopiada, setUrlCopiada] = useState(false);
  const [confirmarUrl, setConfirmarUrl] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [guiaAberto, setGuiaAberto] = useState(false);

  const segredoWebhookInfo = dados?.segredos.find((s) => s.tipo === 'webhook_secret');
  const ativo = !!(dados?.webhook?.urlEmitida && dados?.webhook?.segredoCadastrado);

  function abrirGuia() {
    setGuiaAberto(true);
    // O guia abre na própria seção; leva o foco para lá para quem usa teclado ou leitor de tela.
    window.setTimeout(() => document.querySelector<HTMLElement>('#ink-guia-recebimento > summary')?.focus(), 0);
  }

  function gerarUrl() {
    return gerarUrlWebhookInk().then((r) => {
      setConfirmarUrl(false);
      setUrlCopiada(false);
      setUrlGerada(`${window.location.origin}${r.caminho}`);
      carregar();
      atualizarResumo();
    });
  }

  function salvarSegredo(ev: FormEvent) {
    ev.preventDefault();
    if (!segredoWebhook.trim()) return;
    setSalvando(true);
    salvarInkCredenciais({ webhookSecret: segredoWebhook.trim() })
      .then((r) => {
        setSegredoWebhook(''); // o segredo nunca fica no estado da tela depois de enviado
        setDados(r);
        toast('Segredo do recebimento automático salvo com criptografia.', 'sucesso');
        atualizarResumo();
      })
      .catch(() => {})
      .finally(() => setSalvando(false));
  }

  const passoUrl = ehOwner ? (
    <div className="ig-passo-acao">
      <Button variant="secondary" size="sm" onClick={() => (dados?.webhook?.urlEmitida ? setConfirmarUrl(true) : gerarUrl())}>
        {dados?.webhook?.urlEmitida ? 'Gerar nova URL' : 'Gerar URL'}
      </Button>
      {urlGerada && (
        <Callout tone="success" title="URL de recebimento desta loja">
          <p className="pc-nota">Cole no cadastro de webhook da Reserva Ink (passo 2). Por segurança, ela não aparece de novo.</p>
          <code className="wa-token">{urlGerada}</code>
          <Button variant="secondary" size="sm" onClick={() => copiar(urlGerada, () => setUrlCopiada(true))}>
            {urlCopiada ? 'Copiada!' : 'Copiar URL'}
          </Button>
        </Callout>
      )}
    </div>
  ) : (
    <p className="pc-nota">Só o responsável pela loja gera a URL.</p>
  );

  const passoSegredo = ehOwner ? (
    <FormStack onSubmit={salvarSegredo} className="ig-passo-acao">
      <Field
        label={dados?.webhook?.segredoCadastrado ? 'Substituir segredo do recebimento' : 'Segredo do recebimento'}
        hint="Mostrado pela Reserva Ink ao cadastrar o webhook. Usado para conferir cada evento recebido."
      >
        <Input type="password" autoComplete="off" spellCheck={false} value={segredoWebhook} onChange={(e) => setSegredoWebhook(e.target.value)} />
      </Field>
      <FormActions>
        <Button type="submit" variant="secondary" size="sm" disabled={salvando || !segredoWebhook.trim()}>
          {salvando ? 'Salvando…' : 'Salvar segredo'}
        </Button>
      </FormActions>
    </FormStack>
  ) : null;

  return (
    <Secao title="Recebimento automático de pedidos" description="A Reserva Ink avisa o Oria a cada pedido, pagamento e carrinho abandonado.">
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !dados && <Skeleton rows={2} />}
      {dados && (
        <>
          <div className="ig-linha-estado">
            <StatusBadge tone={ativo ? 'success' : 'neutral'} label={ativo ? 'Ativo' : 'Não ativado'} />
            {segredoWebhookInfo && <span className="ig-meta">Segredo cadastrado{segredoWebhookInfo.last4 ? ` · final ${segredoWebhookInfo.last4}` : ''}</span>}
            <span className="ig-meta">Último evento recebido: {ultimoEventoEm ? formatData(ultimoEventoEm) : 'Nenhum ainda'}</span>
          </div>
          {!ativo && (
            <Callout
              tone="info"
              title="O recebimento automático ainda não está ativado"
              action={ehOwner ? <Button size="sm" variant="secondary" onClick={abrirGuia}>Ativar recebimento automático</Button> : undefined}
            >
              Pedidos, produtos e catálogo seguem sendo lidos pela API da Reserva Ink. Ative para o Oria ser avisado na hora de cada pedido,
              pagamento e carrinho abandonado — esses avisos também alimentam as automações. Não é uma falha: ative quando quiser.
              {!ehOwner && ' Só o responsável pela loja pode ativar.'}
            </Callout>
          )}
          <InkWebhookGuia
            aberto={guiaAberto}
            onAlternar={setGuiaAberto}
            segredoFinal={segredoWebhookInfo?.last4 || null}
            passoUrl={passoUrl}
            passoSegredo={passoSegredo}
          />
        </>
      )}
      <ConfirmDialog
        open={confirmarUrl}
        onClose={() => setConfirmarUrl(false)}
        title="Gerar nova URL de recebimento?"
        description="A URL atual para de receber eventos na hora. Troque a URL no cadastro de webhook da Reserva Ink logo em seguida."
        confirmLabel="Gerar nova URL"
        confirmVariant="danger"
        onConfirm={gerarUrl}
      />
    </Secao>
  );
}
