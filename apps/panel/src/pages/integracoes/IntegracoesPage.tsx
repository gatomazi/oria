import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ErrorState, Icon, PageHeader } from '../../components/ds';
import { useAuth } from '../../auth/AuthContext';
import { getIntegrations, type IntegrationsData } from '../../api/integracoes';
import { getWhatsappWebConfig } from '../../api/whatsappWeb';
import {
  alertasDeAtencao,
  resumoDoProvedor,
  type ChaveProvedor,
  type ContextoResumo,
  type IntegracaoLeitura,
  type ResumoProvedor,
} from './estadoIntegracao';
import { AtualizarResumoProvider, IntegracaoAcordeao, idDoCabecalho } from './IntegracaoAcordeao';
import { InkIntegracao, ABAS_INK } from './InkIntegracao';
import { WhatsappIntegracao, ABAS_WHATSAPP } from './WhatsappIntegracao';
import { estadoDoAgente } from './WhatsappIntegracaoCard';
import { GoogleAnalyticsIntegracaoCard } from './GoogleAnalyticsIntegracaoCard';
import { GoogleAdsIntegracaoCard } from './GoogleAdsIntegracaoCard';
import { MetaAdsIntegracaoCard } from './MetaAdsIntegracaoCard';
import { OpenAiIntegracaoCard } from './OpenAiIntegracaoCard';

import '../../pedidos-central.css';
import '../../integracoes.css';

// Central de conexões da loja. Três níveis de leitura: visão geral (o que precisa de atenção) →
// provedor (linha recolhida com o estado) → tarefa (o provedor expandido, com abas só onde reduzem
// complexidade). O estado de cada linha vem do read model do servidor (`integracoes`); nenhum
// texto de status é fixo aqui. Webhooks, logs e diagnósticos técnicos não fazem parte desta tela.

interface Provedor {
  chave: ChaveProvedor;
  nome: string;
  descricao: string;
  // Sem conteúdo expandível (funcionalidade que ainda não existe): sem chevron e sem botão falso.
  informativo?: boolean;
}

const SECOES: { titulo: string; provedores: Provedor[] }[] = [
  {
    titulo: 'Vendas e catálogo',
    provedores: [{ chave: 'ink', nome: 'Reserva Ink', descricao: 'Pedidos, produtos e catálogo da loja.' }],
  },
  {
    titulo: 'Comunicação',
    provedores: [
      { chave: 'whatsapp', nome: 'WhatsApp', descricao: 'Número, conexão com a Meta e canal de envio das mensagens.' },
      { chave: 'instagram', nome: 'Instagram', descricao: 'Ainda não disponível neste painel.', informativo: true },
    ],
  },
  {
    titulo: 'Marketing e mensuração',
    provedores: [
      { chave: 'meta_ads', nome: 'Meta Ads', descricao: 'Gasto, CPA, ROAS e criativos das campanhas.' },
      { chave: 'google_ads', nome: 'Google Ads', descricao: 'Gasto e desempenho das campanhas.' },
      { chave: 'ga4', nome: 'Google Analytics 4', descricao: 'Sessões, compras e receita das campanhas UTM.' },
    ],
  },
  {
    titulo: 'Inteligência artificial',
    provedores: [{ chave: 'openai', nome: 'OpenAI', descricao: 'Chave própria para os recursos de IA do Gerador de criativos.' }],
  },
];

const CHAVES_EXPANSIVEIS = new Set<string>(SECOES.flatMap((s) => s.provedores.filter((p) => !p.informativo).map((p) => p.chave)));

export function IntegracoesPage() {
  const { organizacaoAtiva } = useAuth();
  // Trocar de organização remonta a tela inteira: status, contas e ações de uma loja nunca ficam
  // visíveis na outra (o servidor também recarrega a sessão ao trocar).
  return <IntegracoesConteudo key={organizacaoAtiva?.id ?? 'sem-organizacao'} />;
}

function IntegracoesConteudo() {
  const { organizacaoAtiva } = useAuth();
  const papel = organizacaoAtiva?.papel ?? null;
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [erro, setErro] = useState('');
  const [agenteWeb, setAgenteWeb] = useState<ContextoResumo['agenteWeb']>('carregando');
  const dataRef = useRef<IntegrationsData | null>(null);
  const versao = useRef(0);
  const foco = useRef<{ chave: string; focar: boolean } | null>(null);

  const chaveParam = params.get('provedor');
  const provedorAberto = chaveParam && CHAVES_EXPANSIVEIS.has(chaveParam) ? (chaveParam as ChaveProvedor) : null;
  const abaParam = params.get('aba');

  // Deep link (`?provedor=whatsapp&aba=conexao`): abre o provedor e leva foco e rolagem até ele.
  useEffect(() => {
    if (provedorAberto && !foco.current) foco.current = { chave: provedorAberto, focar: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Relê o resumo sem descartar o que já está na tela: uma falha na releitura mantém o último estado
  // conhecido, e uma resposta atrasada nunca sobrescreve uma mais nova.
  const recarregar = useCallback(() => {
    const minha = ++versao.current;
    return getIntegrations()
      .then((d) => {
        if (minha !== versao.current) return;
        dataRef.current = d;
        setData(d);
        setErro('');
      })
      .catch((err: Error) => {
        if (minha !== versao.current) return;
        if (!dataRef.current) setErro(err.message);
      });
  }, []);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  // O estado do WhatsApp Web vem do app no computador da loja (heartbeat), não do read model.
  const modoWhatsapp = data?.whatsapp.provider ?? null;
  useEffect(() => {
    if (modoWhatsapp !== 'whatsapp_web') return;
    let vivo = true;
    getWhatsappWebConfig()
      .then((c) => vivo && setAgenteWeb(estadoDoAgente(c.agente)))
      .catch(() => vivo && setAgenteWeb('indisponivel'));
    return () => {
      vivo = false;
    };
  }, [modoWhatsapp, data]);

  const resumos = useMemo(() => {
    const mapa = new Map<string, ResumoProvedor>();
    if (!data) return mapa;
    const leituras = new Map<string, IntegracaoLeitura>(data.integracoes.map((l) => [l.provider, l]));
    const ctx: ContextoResumo = { papel, whatsappModo: modoWhatsapp, agenteWeb };
    for (const secao of SECOES) {
      for (const p of secao.provedores) {
        // Provedor ausente na resposta é "não sei", nunca "não configurado".
        const leitura: IntegracaoLeitura = leituras.get(p.chave) || {
          provider: p.chave,
          estado: 'error',
          proximaAcao: 'retry',
          entitled: null,
          platformAvailable: true,
          leituraFalhou: true,
        };
        mapa.set(p.chave, resumoDoProvedor(leitura, { ...ctx, ink: { webhookAtivo: leitura.componentes?.webhook === 'connected' } }));
      }
    }
    return mapa;
  }, [data, papel, modoWhatsapp, agenteWeb]);

  const alertas = useMemo(
    () => alertasDeAtencao(SECOES.flatMap((s) => s.provedores.map((p) => resumos.get(p.chave)).filter((r): r is ResumoProvedor => !!r))),
    [resumos],
  );

  function abrir(chave: ChaveProvedor, aba?: string, focar = false) {
    const proximo = new URLSearchParams();
    proximo.set('provedor', chave);
    if (aba) proximo.set('aba', aba);
    foco.current = { chave, focar };
    setParams(proximo, { replace: true });
  }

  function alternar(chave: ChaveProvedor) {
    if (provedorAberto === chave) {
      setParams(new URLSearchParams(), { replace: true });
      return;
    }
    abrir(chave);
  }

  function trocarAba(chave: ChaveProvedor, aba: string) {
    const proximo = new URLSearchParams();
    proximo.set('provedor', chave);
    proximo.set('aba', aba);
    setParams(proximo, { replace: true });
  }

  // Depois de abrir um provedor, garante que o cabeçalho continue à vista (o card aberto antes
  // se recolhe e o conteúdo sobe). Por alerta ou link direto, também move o foco para lá.
  useEffect(() => {
    const alvo = foco.current;
    if (!alvo || !data || alvo.chave !== provedorAberto) return;
    foco.current = null;
    const el = document.getElementById(idDoCabecalho(alvo.chave));
    if (!el) return;
    el.scrollIntoView({ block: alvo.focar ? 'start' : 'nearest' });
    if (alvo.focar) el.focus({ preventScroll: true });
  }, [provedorAberto, data]);

  function abaAtual(chave: ChaveProvedor): string {
    if (chave === 'ink') return (ABAS_INK as readonly string[]).includes(abaParam ?? '') ? (abaParam as string) : 'conexao';
    if (chave === 'whatsapp') {
      if ((ABAS_WHATSAPP as readonly string[]).includes(abaParam ?? '')) return abaParam as string;
      return modoWhatsapp === 'whatsapp_web' ? 'envio' : 'conexao';
    }
    return '';
  }

  function conteudo(chave: ChaveProvedor) {
    if (!data) return null;
    switch (chave) {
      case 'ink':
        return <InkIntegracao reservaInk={data.reservaInk} aba={abaAtual('ink')} onAba={(a) => trocarAba('ink', a)} />;
      case 'whatsapp':
        return (
          <WhatsappIntegracao
            conectadoApi={data.whatsapp.conectado}
            observacao={data.whatsapp.observacao}
            modoWeb={modoWhatsapp === 'whatsapp_web'}
            aba={abaAtual('whatsapp')}
            onAba={(a) => trocarAba('whatsapp', a)}
          />
        );
      case 'meta_ads':
        return <MetaAdsIntegracaoCard />;
      case 'google_ads':
        return <GoogleAdsIntegracaoCard />;
      case 'ga4':
        return <GoogleAnalyticsIntegracaoCard />;
      case 'openai':
        return <OpenAiIntegracaoCard />;
      default:
        return null;
    }
  }

  return (
    <div className="ig-pagina">
      <PageHeader title="Integrações" description="Conecte e gerencie os serviços usados pela sua loja." />

      {erro && !data && <ErrorState description={erro} onRetry={() => void recarregar()} />}

      {!(erro && !data) && (
        <AtualizarResumoProvider value={() => void recarregar()}>
          {alertas.length > 0 && (
            <section className="ig-atencao" aria-labelledby="ig-atencao-titulo">
              <h2 className="ig-atencao__titulo" id="ig-atencao-titulo">
                <Icon name="alert-triangle" size={16} />
                Atenção necessária
              </h2>
              <ul className="ig-atencao__lista">
                {alertas.map((a) => (
                  <li key={a.provider}>
                    <span>{a.mensagem}</span>
                    <Button size="sm" variant="secondary" onClick={() => abrir(a.provider as ChaveProvedor, a.aba, true)}>
                      {a.acao}
                      <Icon name="chevron-right" size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {SECOES.map((secao) => (
            <section key={secao.titulo} className="ig-grupo" aria-label={secao.titulo}>
              <h2 className="ig-grupo__titulo">{secao.titulo}</h2>
              <div className="ig-lista">
                {secao.provedores.map((p) => (
                  <IntegracaoAcordeao
                    key={p.chave}
                    provider={p.chave}
                    nome={p.nome}
                    descricao={p.descricao}
                    resumo={resumos.get(p.chave) ?? null}
                    aberto={provedorAberto === p.chave}
                    onAlternar={p.informativo ? undefined : () => alternar(p.chave)}
                  >
                    {conteudo(p.chave)}
                  </IntegracaoAcordeao>
                ))}
              </div>
            </section>
          ))}
        </AtualizarResumoProvider>
      )}
    </div>
  );
}
