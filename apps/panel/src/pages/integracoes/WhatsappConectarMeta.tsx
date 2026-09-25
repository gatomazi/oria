import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Disclosure } from '../../components/ds';
import { toast } from '../../lib/toast';
import { ApiError } from '../../api/client';
import {
  concluirEmbeddedSignup,
  getEmbeddedSignupConfig,
  type EmbeddedSignupConfig,
  type WhatsappRemetente,
} from '../../api/integracoes';
import { interpretarMensagemEmbeddedSignup } from './embeddedSignup';

interface RespostaLogin {
  authResponse?: { code?: string } | null;
}

interface SdkFacebook {
  init(opcoes: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(callback: (r: RespostaLogin) => void, opcoes: Record<string, unknown>): void;
}

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

function fb(): SdkFacebook | undefined {
  return (window as unknown as { FB?: SdkFacebook }).FB;
}

// Carrega o SDK da Meta uma vez. Só é chamado depois que o servidor confirmou que a conexão está
// habilitada na plataforma — sem app da Meta configurado, a tela nem toca no domínio deles.
function carregarSdk(): Promise<void> {
  if (fb()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existente = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    const alvo = existente || Object.assign(document.createElement('script'), { src: SDK_URL, async: true, defer: true, crossOrigin: 'anonymous' });
    alvo.addEventListener('load', () => resolve(), { once: true });
    alvo.addEventListener('error', () => reject(new Error('não foi possível carregar o SDK da Meta')), { once: true });
    if (!existente) document.head.appendChild(alvo);
  });
}

type Fase = 'carregando' | 'indisponivel' | 'pronto' | 'aguardando' | 'salvando';

// "Conectar com a Meta": Embedded Signup. A Meta devolve DUAS coisas por caminhos separados — o
// `code` (callback do FB.login) e a WABA/número (mensagem na janela) — em ordem que não é garantida;
// o pedido ao servidor sai quando as duas chegaram. O `state` (uso único, amarrado a esta loja) vem
// do servidor e é refeito depois de cada tentativa.
// `destaque`: a reconexão é a ação principal da tela (número desconectado ou token recusado pela
// Meta). Com a conexão saudável o botão fica secundário — não convida a refazer o que já funciona.
export function WhatsappConectarMeta({ conectado, destaque, onConectado }: { conectado: boolean; destaque: boolean; onConectado: (r: WhatsappRemetente) => void }) {
  const [fase, setFase] = useState<Fase>('carregando');
  const [erro, setErro] = useState('');
  const config = useRef<EmbeddedSignupConfig | null>(null);
  const code = useRef<string | null>(null);
  const ids = useRef<{ wabaId: string; phoneNumberId: string; businessId: string | null } | null>(null);

  const preparar = useCallback(async () => {
    try {
      const c = await getEmbeddedSignupConfig();
      await carregarSdk();
      fb()?.init({ appId: c.appId, autoLogAppEvents: true, xfbml: true, version: c.apiVersion });
      config.current = c;
      setFase('pronto');
    } catch (e) {
      if (e instanceof ApiError && e.codigo === 'PLATFORM_UNAVAILABLE') setFase('indisponivel');
      else {
        setErro(e instanceof Error ? e.message : 'não foi possível preparar a conexão');
        setFase('indisponivel');
      }
    }
  }, []);
  useEffect(() => { void preparar(); }, [preparar]);

  const reiniciar = useCallback(() => {
    code.current = null;
    ids.current = null;
    void preparar();
  }, [preparar]);

  const tentarConcluir = useCallback(() => {
    const c = config.current;
    if (!c || !code.current || !ids.current) return;
    const pedido = { state: c.state, code: code.current, ...ids.current };
    // O code vale 30 s e o state é de uso único: nenhum dos dois é reaproveitado.
    code.current = null;
    ids.current = null;
    setFase('salvando');
    concluirEmbeddedSignup(pedido)
      .then((r) => {
        toast('WhatsApp conectado pela Meta.', 'sucesso');
        onConectado(r);
      })
      .catch((e: Error) => setErro(e.message))
      .finally(reiniciar);
  }, [onConectado, reiniciar]);

  useEffect(() => {
    function aoReceber(ev: MessageEvent) {
      const r = interpretarMensagemEmbeddedSignup(ev.origin, ev.data);
      if (!r) return;
      if (r.tipo === 'concluido') {
        ids.current = { wabaId: r.wabaId, phoneNumberId: r.phoneNumberId, businessId: r.businessId };
        tentarConcluir();
      } else if (r.tipo === 'cancelado') {
        setErro('A conexão foi cancelada antes de terminar.');
        reiniciar();
      } else {
        setErro('A Meta informou um erro durante a conexão. Tente de novo.');
        reiniciar();
      }
    }
    window.addEventListener('message', aoReceber);
    return () => window.removeEventListener('message', aoReceber);
  }, [tentarConcluir, reiniciar]);

  function conectar() {
    const c = config.current;
    const sdk = fb();
    if (!c || !sdk) return;
    setErro('');
    setFase('aguardando');
    sdk.login((resposta) => {
      const recebido = resposta.authResponse && resposta.authResponse.code;
      if (!recebido) {
        setErro('A Meta não autorizou a conexão.');
        reiniciar();
        return;
      }
      code.current = recebido;
      tentarConcluir();
    }, { config_id: c.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {} } });
  }

  if (fase === 'carregando') return <p className="pc-nota">Preparando a conexão com a Meta…</p>;
  if (fase === 'indisponivel') {
    return (
      <div>
        <p className="pc-nota"><strong>Conexão com a Meta indisponível no momento.</strong> A conexão do WhatsApp com a Meta ainda não está habilitada na plataforma.</p>
        {erro && <p className="ds-form-error" role="alert">{erro}</p>}
      </div>
    );
  }
  return (
    <div className="ds-stack">
      {erro && <p className="ds-form-error" role="alert">{erro}</p>}
      <div>
        <Button variant={destaque ? 'primary' : 'secondary'} onClick={conectar} disabled={fase !== 'pronto'}>
          {fase === 'salvando' ? 'Concluindo…' : fase === 'aguardando' ? 'Aguardando a Meta…' : conectado ? 'Reconectar com a Meta' : 'Conectar com a Meta'}
        </Button>
      </div>
      <Disclosure summary="Como funciona a conexão com a Meta">
        <p className="pc-nota">
          Você entra com a sua conta da Meta, escolhe ou cria a conta do WhatsApp Business e o número. O Oria guarda o acesso cifrado e
          recebe as mensagens dos seus clientes. O pagamento das mensagens é feito por você, direto à Meta.
        </p>
        <p className="pc-nota">
          <strong>Modo atual: homologação.</strong> A conexão automática ainda depende da aprovação do Oria como provedor de tecnologia na Meta;
          até lá, só contas com função no app da Meta concluem o fluxo. Para as demais lojas, use o cadastro manual abaixo.
        </p>
      </Disclosure>
    </div>
  );
}
