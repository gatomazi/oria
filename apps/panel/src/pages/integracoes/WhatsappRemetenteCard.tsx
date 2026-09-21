import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Card, ConfirmDialog, Disclosure, ErrorState, Field, FormActions, FormGrid, FormSection, FormStack, Input, Skeleton, StatusBadge, Textarea } from '../../components/ds';
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
export function WhatsappRemetenteCard() {
  const { organizacaoAtiva } = useAuth();
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
    });
  }

  function testar() {
    setTeste('Testando…');
    testarConexao('whatsapp')
      .then((r) => setTeste(r.status === 'connected' ? 'A Meta reconheceu o número com este token.' : `Falhou (${r.codigo || 'erro'}).`))
      .catch((e: Error) => setTeste(e.message));
  }

  return (
    <Card
      title="Número do WhatsApp"
      description="Número, conta (WABA) e token da API oficial usados em todos os envios desta loja."
    >
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !dados && <Skeleton rows={2} />}
      {dados && (
        <>
          <div className="ad-integracao-item__topo">
            <StatusBadge
              tone={conectado && !dados.tokenInvalidoEm ? 'success' : 'warning'}
              label={conectado ? `${dados.tokenInvalidoEm ? 'Token recusado pela Meta' : 'Token cadastrado'}${dados.token?.last4 ? ` · final ${dados.token.last4}` : ''}` : 'Número não configurado'}
            />
          </div>
          {conectado && dados.tokenInvalidoEm && (
            <p className="ds-form-error" role="alert">
              A Meta recusou o token do WhatsApp (expirado ou revogado). Cole um token novo em "Cadastro manual" ou reconecte com a Meta —
              enquanto isso, templates e envios não funcionam. Token de teste da Meta dura 24 horas.
            </p>
          )}
          {conectado && dados.conectadoVia === 'embedded_signup' && (
            <dl className="pc-nota" aria-label="Conexão com a Meta">
              <div>{dados.nomeVerificado || 'Número conectado'}{dados.numeroExibido ? ` · ${dados.numeroExibido}` : ''}</div>
              <div>Conta do WhatsApp {dados.wabaId}{dados.businessId ? ` · business ${dados.businessId}` : ''}</div>
              <div>{dados.webhookAssinado ? 'Recebendo mensagens' : 'Sem webhook'} · {dados.numeroRegistrado ? 'número registrado' : 'número não registrado'}</div>
            </dl>
          )}
          {ehOwner && <WhatsappConectarMeta conectado={conectado} onConectado={aplicar} />}
          {!ehOwner && (
            <p className="pc-nota">
              {dados.phoneNumberId ? `Número ${dados.phoneNumberId} · conta ${dados.wabaId}. ` : ''}
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
    </Card>
  );
}
