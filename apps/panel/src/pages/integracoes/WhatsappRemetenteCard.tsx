import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Callout, ConfirmDialog, Disclosure, ErrorState, Field, FormActions, FormGrid, FormSection, FormStack, Input, Skeleton, StatusBadge, Textarea } from '../../components/ds';
import { Secao, useAtualizarResumo } from './IntegracaoAcordeao';
import { toast } from '../../lib/toast';
import { WhatsappConectarMeta } from './WhatsappConectarMeta';
import { useAuth } from '../../auth/AuthContext';
import {
  getWhatsappRemetente,
  removerWhatsappRemetente,
  salvarWhatsappRemetente,
  testarConexao,
  type WhatsappRemetente,
} from '../../api/integracoes';

const ID_META = /^[0-9]{5,32}$/;
const TELEFONE = /^[0-9]{10,15}$/;

// Número da API oficial do WhatsApp desta loja (Fase 5b). O serviço de envio não tem mais um número
// próprio: cada envio sai com o número, a conta (WABA) e o token cadastrados aqui. O token fica
// cifrado no servidor; a tela só vê os 4 últimos caracteres. Só o responsável (owner) grava ou remove.
export function WhatsappRemetenteCard({ modoWeb }: { modoWeb: boolean }) {
  const { organizacaoAtiva } = useAuth();
  const atualizarResumo = useAtualizarResumo();
  const ehOwner = organizacaoAtiva?.papel === 'owner';
  const [dados, setDados] = useState<WhatsappRemetente | null>(null);
  const [erro, setErro] = useState('');
  const [numero, setNumero] = useState('');
  const [waba, setWaba] = useState('');
  const [token, setToken] = useState('');
  const [resposta, setResposta] = useState('');
  const [aviso, setAviso] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [confirmarRemocao, setConfirmarRemocao] = useState(false);
  const [teste, setTeste] = useState<string | null>(null);

  const aplicar = useCallback((r: WhatsappRemetente) => {
    setDados(r);
    setNumero(r.phoneNumberId || '');
    setWaba(r.wabaId || '');
    setResposta(r.replyRedirectMessage || '');
    setAviso(r.notifyNumber || '');
  }, []);

  const carregar = useCallback(() => {
    setErro('');
    getWhatsappRemetente().then(aplicar).catch((e: Error) => setErro(e.message));
  }, [aplicar]);
  useEffect(carregar, [carregar]);

  const conectado = dados?.status === 'connected' && !!dados.token;
  const trocouNumero = !!dados?.phoneNumberId && numero.trim() !== dados.phoneNumberId;

  function salvar(ev: FormEvent) {
    ev.preventDefault();
    setErroForm('');
    setTeste(null);
    const corpo: { phoneNumberId: string; wabaId: string; accessToken?: string; replyRedirectMessage: string; notifyNumber: string } = {
      phoneNumberId: numero.trim(),
      wabaId: waba.trim(),
      replyRedirectMessage: resposta.trim(),
      notifyNumber: aviso.replace(/\D/g, ''),
    };
    if (!ID_META.test(corpo.phoneNumberId) || !ID_META.test(corpo.wabaId)) {
      setErroForm('Os IDs do número e da conta têm só números.');
      return;
    }
    if (corpo.notifyNumber && !TELEFONE.test(corpo.notifyNumber)) {
      setErroForm('O número do aviso tem DDI + DDD + número, só dígitos.');
      return;
    }
    if (token.trim()) corpo.accessToken = token.trim();
    if (!corpo.accessToken && (!dados?.token || trocouNumero)) {
      setErroForm(trocouNumero ? 'Ao trocar de número, informe também o token dele.' : 'Informe o token do WhatsApp.');
      return;
    }
    setSalvando(true);
    salvarWhatsappRemetente(corpo)
      .then((r) => {
        setToken(''); // o token nunca fica no estado da tela depois de enviado
        aplicar(r);
        toast('Número do WhatsApp salvo com criptografia.', 'sucesso');
        atualizarResumo();
      })
      .catch((e: Error) => setErroForm(e.message))
      .finally(() => setSalvando(false));
  }

  function remover() {
    setTeste(null);
    return removerWhatsappRemetente().then(() => {
      setConfirmarRemocao(false);
      toast('Número do WhatsApp removido.', 'sucesso');
      carregar();
      atualizarResumo();
    });
  }

  function testar() {
    setTeste('Testando…');
    testarConexao('whatsapp')
      .then((r) => setTeste(r.status === 'connected' ? 'A Meta reconheceu o número com este token.' : `Falhou (${r.codigo || 'erro'}).`))
      .catch((e: Error) => setTeste(e.message));
  }

  const tokenRecusado = conectado && !!dados?.tokenInvalidoEm;

  return (
    <Secao
      title="Número e conexão com a Meta"
      description="Número, conta (WABA) e autorização da API oficial usados em todos os envios desta loja."
    >
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !dados && <Skeleton rows={2} />}
      {dados && (
        <>
          {modoWeb && (
            <p className="pc-nota">
              Esta loja envia pelo WhatsApp Web. O número da Meta só é usado quando o canal de envio for a API oficial — pode deixá-lo cadastrado.
            </p>
          )}
          <div className="ig-linha-estado">
            <StatusBadge
              tone={tokenRecusado ? 'danger' : conectado ? 'success' : 'neutral'}
              label={tokenRecusado ? 'Reconexão necessária' : conectado ? (dados.conectadoVia === 'manual' ? 'Token cadastrado' : 'Conectado') : 'Número não configurado'}
            />
            {conectado && dados.numeroExibido && <span className="ig-meta">{dados.nomeVerificado ? `${dados.nomeVerificado} · ` : ''}{dados.numeroExibido}</span>}
            {conectado && !dados.numeroExibido && dados.token?.last4 && <span className="ig-meta">Token final {dados.token.last4}</span>}
          </div>
          {tokenRecusado && (
            <Callout tone="danger" role="alert" title="A Meta recusou a autorização deste número">
              O token do WhatsApp expirou ou foi revogado — enquanto isso, templates e envios pela API oficial não funcionam. Reconecte com a Meta
              ou cole um token novo no cadastro manual. (Token de teste da Meta dura 24 horas.)
            </Callout>
          )}
          {conectado && dados.conectadoVia === 'embedded_signup' && (
            <dl className="ig-fatos" aria-label="Situação da conexão com a Meta">
              <div>
                <dt>Autorização</dt>
                <dd>{tokenRecusado ? 'Recusada pela Meta' : 'Ativa'}</dd>
              </div>
              <div>
                <dt>Número registrado</dt>
                <dd>{dados.numeroRegistrado ? 'Sim' : 'Não'}</dd>
              </div>
              <div>
                <dt>Recebimento de mensagens</dt>
                <dd>{dados.webhookAssinado ? 'Ativo' : 'Não configurado'}</dd>
              </div>
            </dl>
          )}
          {ehOwner && <WhatsappConectarMeta conectado={conectado} destaque={!conectado || tokenRecusado} onConectado={(r) => { aplicar(r); atualizarResumo(); }} />}
          {!ehOwner && (
            <p className="pc-nota">
              {dados.phoneNumberId ? 'Há um número cadastrado nesta loja. ' : ''}
              Só o responsável pela loja cadastra ou remove o número.
            </p>
          )}
          {ehOwner ? (
            <Disclosure summary="Cadastro manual (avançado)" defaultOpen={false}>
            <FormStack onSubmit={salvar}>
              <FormGrid>
                <Field label="ID do número" hint="WhatsApp Manager › Números de telefone.">
                  <Input inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={32} value={numero} onChange={(e) => setNumero(e.target.value.replace(/\s/g, ''))} />
                </Field>
                <Field label="ID da conta (WABA)" hint="Configurações do negócio › Contas do WhatsApp.">
                  <Input inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={32} value={waba} onChange={(e) => setWaba(e.target.value.replace(/\s/g, ''))} />
                </Field>
              </FormGrid>
              <Field
                label={dados.token ? 'Substituir token' : 'Token de acesso'}
                optional={!!dados.token && !trocouNumero}
                hint="Token de usuário do sistema com permissão whatsapp_business_messaging. Não é salvo no navegador."
              >
                <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
              </Field>
              <FormSection title="Quando um cliente responde">
                <Field label="Resposta automática" optional hint="Enviada uma vez por período para quem responde a este número. Vazio desliga.">
                  <Textarea rows={3} maxLength={1000} value={resposta} onChange={(e) => setResposta(e.target.value)} />
                </Field>
                <Field label="Número que recebe o aviso" optional hint="Com DDI e DDD. Recebe uma cópia de cada resposta de cliente. Vazio desliga.">
                  <Input inputMode="tel" autoComplete="off" maxLength={20} value={aviso} onChange={(e) => setAviso(e.target.value)} placeholder="ex.: 5548999990000" />
                </Field>
              </FormSection>
              {erroForm && <p className="ds-form-error" role="alert">{erroForm}</p>}
              <FormActions start={teste ? <span role="status">{teste}</span> : undefined}>
                {conectado && (
                  <>
                    <Button variant="ghost" onClick={testar}>Testar conexão</Button>
                    <Button variant="danger" onClick={() => setConfirmarRemocao(true)}>Remover</Button>
                  </>
                )}
                <Button type="submit" disabled={salvando}>
                  {salvando ? 'Salvando…' : 'Salvar'}
                </Button>
              </FormActions>
            </FormStack>
            </Disclosure>
          ) : (
            conectado && (
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
        title="Remover o número do WhatsApp?"
        description="Automações, campanhas e testes de template desta loja param de enviar até um número ser cadastrado de novo. Mensagens já na fila de revisão não saem."
        confirmLabel="Remover"
        onConfirm={remover}
      />
    </Secao>
  );
}
