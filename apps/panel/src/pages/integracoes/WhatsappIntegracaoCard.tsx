import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Callout, Card, ConfirmDialog, Disclosure, Field, Input, Modal, RadioCardGroup, StatusBadge } from '../../components/ds';
import { VolumeWhatsappWebCard } from '../../components/VolumeWhatsappWebCard';
import { copiar, formatData, plural } from '../../lib/format';
import { hasEntitlement } from '../../state/entitlements';
import { definirWhatsappProvider } from '../../state/whatsappProvider';
import {
  gerarTokenAgente,
  getWhatsappWebConfig,
  getWhatsappWebResumo,
  updateWhatsappWebConfig,
  type WhatsappProvider,
  type WhatsappWebConfig,
  type WhatsappWebResumo,
} from '../../api/whatsappWeb';
import { getWhatsappMetaApp, updateWhatsappMetaApp } from '../../api/integracoes';

import '../../whatsapp-web.css';

// Card WhatsApp de Integrações: escolha de provider (API da Meta x WhatsApp Web) e, no modo Web,
// status do app desktop, token e limites diários. Ver docs/plano-whatsapp-web-envio.md.
const PROVIDERS: { valor: WhatsappProvider; nome: string; descricao: string }[] = [
  {
    valor: 'meta_api',
    nome: 'API oficial da Meta',
    descricao: 'Envio pelo serviço de WhatsApp com templates aprovados. A Meta cobra por mensagem e o limite depende do tier da conta.',
  },
  {
    valor: 'whatsapp_web',
    nome: 'WhatsApp Web',
    descricao: 'Sem custo por mensagem. O app Envio WhatsApp, no seu computador, envia pelo WhatsApp Desktop ou pelo WhatsApp Web, respeitando um volume diário seguro.',
  },
];

const EXECUTOR_LABEL: Record<string, string> = { desktop: 'WhatsApp Desktop', navegador: 'WhatsApp Web (navegador)' };
const PLATAFORMA_LABEL: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

const REFRESH_MS = 30000;

function statusApp(agente: WhatsappWebConfig['agente']): { label: string; detalhe: string; tone: 'success' | 'warning' | 'danger' | 'info' } {
  if (!agente.ultimoHeartbeatEm) return { label: 'App não conectado', detalhe: 'Nunca conectou', tone: 'danger' };
  if (!agente.online) return { label: 'App offline', detalhe: 'Offline', tone: 'danger' };
  if (agente.testando) return { label: 'App testando envio', detalhe: 'Enviando teste', tone: 'info' };
  if (agente.pausado) return { label: 'App pausado', detalhe: 'Online, pausado', tone: 'warning' };
  return { label: 'App enviando', detalhe: 'Enviando a fila', tone: 'success' };
}

// ID do app da Meta (developers.facebook.com) — o serviço de WhatsApp precisa dele pra subir a mídia
// de exemplo dos templates. Vazio usa o que estiver configurado no próprio serviço.
function MetaAppIdCampo() {
  const [salvo, setSalvo] = useState<string | null>(null);
  const [valor, setValor] = useState('');
  const [erroCarga, setErroCarga] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState<{ tipo: 'nota' | 'erro'; texto: string } | null>(null);

  useEffect(() => {
    getWhatsappMetaApp()
      .then((r) => { setSalvo(r.appId); setValor(r.appId); })
      .catch((err: Error) => setErroCarga(err.message));
  }, []);

  function salvar() {
    const appId = valor.trim();
    setMsg(null);
    if (appId && !/^[0-9]{5,32}$/.test(appId)) {
      setMsg({ tipo: 'erro', texto: 'o ID do app tem só números' });
      return;
    }
    setSalvando(true);
    updateWhatsappMetaApp(appId)
      .then((r) => { setSalvo(r.appId); setValor(r.appId); setMsg({ tipo: 'nota', texto: r.appId ? 'salvo!' : 'removido' }); })
      .catch((err: Error) => setMsg({ tipo: 'erro', texto: err.message }))
      .finally(() => setSalvando(false));
  }

  if (erroCarga) return <p className="ds-form-error" role="alert">Não foi possível carregar o ID do app: {erroCarga}</p>;
  if (salvo === null) return null;

  return (
    <div className="wa-limites">
      <Field label="ID do app da Meta" optional hint="developers.facebook.com › seu app › Configurações › Básico. Usado para enviar a mídia de exemplo dos templates.">
        <Input inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={32} value={valor} onChange={(e) => setValor(e.target.value.replace(/\s/g, ''))} placeholder="ex.: 1234567890123456" />
      </Field>
      <Button variant="ghost" onClick={salvar} disabled={salvando || valor.trim() === salvo}>
        {salvando ? 'Salvando…' : 'Salvar ID do app'}
      </Button>
      {msg && <span role={msg.tipo === 'erro' ? 'alert' : 'status'} className={msg.tipo === 'erro' ? 'ds-form-error' : 'ds-form-note'}>{msg.texto}</span>}
    </div>
  );
}

export function WhatsappIntegracaoCard({ conectadoApi, observacao, entitlementsProntos }: { conectadoApi: boolean; observacao?: string | null; entitlementsProntos: boolean }) {
  const [config, setConfig] = useState<WhatsappWebConfig | null>(null);
  const [erroConfig, setErroConfig] = useState('');
  const [resumo, setResumo] = useState<WhatsappWebResumo | null>(null);
  const [trocaPara, setTrocaPara] = useState<WhatsappProvider | null>(null);
  const [confirmarToken, setConfirmarToken] = useState(false);
  const [tokenGerado, setTokenGerado] = useState<string | null>(null);
  const [tokenCopiado, setTokenCopiado] = useState(false);
  const [limiteRecomendado, setLimiteRecomendado] = useState(100);
  const [tetoDiario, setTetoDiario] = useState(200);
  const [msgLimites, setMsgLimites] = useState<{ tipo: 'nota' | 'erro'; texto: string } | null>(null);

  const carregar = useCallback((sincronizarLimites = false) => {
    Promise.all([getWhatsappWebConfig(), getWhatsappWebResumo()])
      .then(([c, r]) => {
        setConfig(c);
        setResumo(r);
        if (sincronizarLimites) {
          setLimiteRecomendado(c.limiteRecomendado);
          setTetoDiario(c.tetoDiario);
        }
      })
      .catch((err: Error) => setErroConfig(err.message));
  }, []);

  useEffect(() => {
    carregar(true);
    const timer = window.setInterval(() => carregar(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [carregar]);

  function trocarProvider() {
    if (!trocaPara) return;
    const novo = trocaPara;
    return updateWhatsappWebConfig({ provider: novo }).then(() => {
      definirWhatsappProvider(novo);
      setTrocaPara(null);
      carregar();
    });
  }

  function gerarToken() {
    return gerarTokenAgente().then(({ token }) => {
      setConfirmarToken(false);
      setTokenCopiado(false);
      setTokenGerado(token);
      carregar();
    });
  }

  function salvarLimites() {
    setMsgLimites(null);
    if (!Number.isInteger(limiteRecomendado) || !Number.isInteger(tetoDiario) || limiteRecomendado < 1 || tetoDiario < 1) {
      setMsgLimites({ tipo: 'erro', texto: 'use números inteiros maiores que zero' });
      return;
    }
    if (config && tetoDiario > config.faixas.risco) {
      setMsgLimites({ tipo: 'erro', texto: `o teto diário não pode passar de ${config.faixas.risco}` });
      return;
    }
    if (limiteRecomendado > tetoDiario) {
      setMsgLimites({ tipo: 'erro', texto: 'o limite recomendado não pode ser maior que o teto' });
      return;
    }
    updateWhatsappWebConfig({ limiteRecomendado, tetoDiario })
      .then(() => {
        setMsgLimites({ tipo: 'nota', texto: 'salvo!' });
        carregar();
      })
      .catch((err: Error) => setMsgLimites({ tipo: 'erro', texto: err.message }));
  }

  const modoWeb = config?.provider === 'whatsapp_web';
  const pendentesWeb = (resumo?.fila?.pendentes ?? 0) + (resumo?.fila?.aguardandoAprovacao ?? 0);
  const agente = config?.agente;

  return (
    <>
      <Card title="WhatsApp">
        <div className="ad-integracao-item__topo">
          {entitlementsProntos && (
            <StatusBadge
              tone={hasEntitlement('whatsapp') ? 'success' : 'neutral'}
              label={hasEntitlement('whatsapp') ? 'Incluído no plano' : 'Não incluído no plano'}
            />
          )}
          <StatusBadge tone={conectadoApi ? 'success' : 'danger'} label={conectadoApi ? 'API conectada' : 'API não conectada'} />
          {modoWeb && agente && (
            <StatusBadge tone={statusApp(agente).tone} label={statusApp(agente).label} />
          )}
        </div>
        {observacao &&
          // Observação do servidor pode citar variáveis de ambiente: texto de lojista na frente, detalhe técnico sob demanda.
          (/[A-Z][A-Z0-9]*_[A-Z0-9_]+/.test(observacao) ? (
            <div className="ds-stack">
              <p className="ds-note">Serviço de envio de WhatsApp não configurado neste ambiente.</p>
              <Disclosure summary="Detalhes técnicos">{observacao}</Disclosure>
            </div>
          ) : (
            <p className="pc-nota">{observacao}</p>
          ))}

        {!config && erroConfig && (
          <Callout tone="danger" title="Não foi possível carregar a configuração do WhatsApp Web">
            {erroConfig}
          </Callout>
        )}

        {config && (
          <>
            <div className="wa-alerta-espaco">
              <RadioCardGroup<WhatsappProvider>
                name="whatsappProvider"
                legend="Forma de envio do WhatsApp"
                value={config.provider}
                onChange={(v) => setTrocaPara(v)}
                options={PROVIDERS.map((p) => ({
                  value: p.valor,
                  title: p.nome,
                  description: p.descricao,
                  disabled: p.valor === 'whatsapp_web' && !config.postgresConfigurado,
                }))}
              />
            </div>
            {!config.postgresConfigurado && (
              <div className="ds-stack wa-alerta-espaco">
                <p className="ds-note">O modo WhatsApp Web precisa de banco de dados configurado neste ambiente.</p>
                <Disclosure summary="Detalhes técnicos">
                  Variável de ambiente <code>DATABASE_URL</code> (Postgres) não configurada no servidor.
                </Disclosure>
              </div>
            )}
            {!modoWeb && <MetaAppIdCampo />}
          </>
        )}

        {config && modoWeb && agente && (
          <>
            <Callout tone="warning" title="Atenção" className="wa-alerta-espaco">
              O envio pelo WhatsApp Web ou Desktop não é oficial e pode levar ao bloqueio do número. O computador com o app Envio WhatsApp
              precisa ficar ligado, com o WhatsApp logado.
            </Callout>

            <div className="wa-agente">
              <div className="wa-agente__item">
                App Envio WhatsApp
                <strong>{agente.online || !agente.ultimoHeartbeatEm ? statusApp(agente).detalhe : 'Offline'}</strong>
              </div>
              <div className="wa-agente__item">
                Envia por
                <strong>
                  {agente.executor ? EXECUTOR_LABEL[agente.executor] : '—'}
                  {agente.plataforma ? ` · ${PLATAFORMA_LABEL[agente.plataforma] || agente.plataforma}` : ''}
                </strong>
              </div>
              <div className="wa-agente__item">
                Último sinal
                <strong>{formatData(agente.ultimoHeartbeatEm)}</strong>
              </div>
              <div className="wa-agente__item">
                Na fila
                <strong>
                  <Link to="/admin/whatsapp/fila">{plural(pendentesWeb, 'mensagem', 'mensagens')}</Link>
                </strong>
              </div>
            </div>

            <div className="wa-limites">
              <Field label="Limite recomendado por dia" hint="campanhas param aqui">
                <Input type="number" min={1} max={config.faixas.risco} value={limiteRecomendado} onChange={(e) => setLimiteRecomendado(Number(e.target.value))} />
              </Field>
              <Field label="Teto diário" hint="nada sai depois disso">
                <Input type="number" min={1} max={config.faixas.risco} value={tetoDiario} onChange={(e) => setTetoDiario(Number(e.target.value))} />
              </Field>
              <Button variant="ghost" onClick={salvarLimites}>
                Salvar limites
              </Button>
              {msgLimites && <span className={msgLimites.tipo === 'erro' ? 'ds-form-error' : 'ds-form-note'}>{msgLimites.texto}</span>}
            </div>

            <div className="wa-limites">
              <Button variant="secondary" onClick={() => (agente.tokenConfigurado ? setConfirmarToken(true) : gerarToken())}>
                {agente.tokenConfigurado ? 'Gerar novo token do app' : 'Gerar token do app'}
              </Button>
              {agente.tokenCriadoEm && <span className="pc-nota">Token atual criado em {formatData(agente.tokenCriadoEm)}</span>}
            </div>
            <p className="pc-nota">
              Instale o app Envio WhatsApp (macOS ou Windows), cole a URL deste painel e o token e clique em "Iniciar envio". Instruções em{' '}
              <code>desktop/README.md</code>.
            </p>
          </>
        )}
      </Card>

      {modoWeb && resumo && <VolumeWhatsappWebCard resumo={resumo} />}

      <ConfirmDialog
        open={!!trocaPara}
        onClose={() => setTrocaPara(null)}
        title={trocaPara === 'whatsapp_web' ? 'Enviar pelo WhatsApp Web?' : 'Voltar para a API da Meta?'}
        description={
          trocaPara === 'whatsapp_web'
            ? 'A partir de agora, as automações usam as Mensagens do WhatsApp Web (em vez dos templates da Meta) e entram na fila de envio, que o app Envio WhatsApp executa no seu computador. Vincule uma mensagem a cada evento em Automações. O envio não é oficial e pode levar ao bloqueio do número.'
            : pendentesWeb > 0
              ? `Novas mensagens voltam a sair pela API (com cobrança da Meta). ${pendentesWeb === 1 ? 'A mensagem que já está na fila do WhatsApp Web fica parada' : `As ${pendentesWeb} mensagens já na fila do WhatsApp Web ficam paradas`} até você voltar para o modo Web ou cancelá-las na fila.`
              : 'Novas mensagens voltam a sair pela API, com cobrança da Meta por mensagem.'
        }
        confirmLabel="Confirmar"
        confirmVariant="primary"
        onConfirm={trocarProvider}
      />

      <ConfirmDialog
        open={confirmarToken}
        onClose={() => setConfirmarToken(false)}
        title="Gerar novo token?"
        description="O token atual para de funcionar na hora. Cole o novo token no app Envio WhatsApp."
        confirmLabel="Gerar novo token"
        confirmVariant="danger"
        onConfirm={gerarToken}
      />

      <Modal open={!!tokenGerado} onClose={() => setTokenGerado(null)} title="Token do app" cancelLabel="Fechar">
        <p className="pc-nota">Copie agora: por segurança, ele não aparece de novo. Cole no app Envio WhatsApp, em "Conexão com o painel".</p>
        <code className="wa-token">{tokenGerado}</code>
        <Button variant="secondary" onClick={() => tokenGerado && copiar(tokenGerado, () => setTokenCopiado(true))}>
          {tokenCopiado ? 'Copiado!' : 'Copiar token'}
        </Button>
      </Modal>
    </>
  );
}
