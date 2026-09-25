// Estado de integração (read model do servidor) → rótulo, tom e resumo da linha do provedor.
//
// O SERVIDOR decide o estado (lib/platform/integration-read-model.js); aqui só se traduz em texto.
// Nenhum card recalcula "conectado" por conta própria — é isso que impedia dois cards de se
// contradizerem. Tom: `warning` é ação necessária, `danger` é falha, `neutral` é "não é com você agora".
//
// Este arquivo é PURO (sem React, sem rede): os testes o transpilam e o executam direto.

export type EstadoIntegracao =
  | 'not_entitled' | 'platform_unavailable' | 'not_configured' | 'configured' | 'connecting'
  | 'connected' | 'connected_with_data' | 'degraded' | 'error' | 'deferred' | 'coming_soon';

export type ProximaAcao = 'none' | 'ask_plan' | 'wait_platform' | 'configure' | 'select_resource' | 'reconnect' | 'retry';

export interface IntegracaoLeitura {
  provider: string;
  estado: EstadoIntegracao;
  proximaAcao: ProximaAcao;
  entitled: boolean | null;
  platformAvailable: boolean;
  componentes?: Record<string, string | null>;
  leituraFalhou?: boolean;
}

export type TomSelo = 'success' | 'warning' | 'danger' | 'neutral';
export type TomResumo = TomSelo | 'info';

const ROTULOS: Record<EstadoIntegracao, { label: string; tone: TomSelo }> = {
  not_entitled: { label: 'Não incluída no plano', tone: 'neutral' },
  platform_unavailable: { label: 'Indisponível no momento', tone: 'neutral' },
  not_configured: { label: 'Não conectado', tone: 'neutral' },
  configured: { label: 'Configuração pendente', tone: 'warning' },
  connecting: { label: 'Conectando…', tone: 'neutral' },
  connected: { label: 'Conectado', tone: 'success' },
  connected_with_data: { label: 'Conectado', tone: 'success' },
  degraded: { label: 'Conectado · ação necessária', tone: 'warning' },
  error: { label: 'Reconexão necessária', tone: 'danger' },
  deferred: { label: 'Não ativado', tone: 'neutral' },
  coming_soon: { label: 'Em breve', tone: 'neutral' },
};

// `error` com ação `retry` é a leitura que falhou (rede, timeout): NÃO é autorização perdida, então
// não pode pedir reconexão — o pedido certo é tentar de novo.
export function seloDoEstado(estado: EstadoIntegracao, proximaAcao?: ProximaAcao): { label: string; tone: TomSelo } {
  if (estado === 'error' && proximaAcao === 'retry') return { label: 'Não foi possível verificar', tone: 'warning' };
  return ROTULOS[estado] || { label: 'Desconhecido', tone: 'neutral' };
}

export const NOME_DO_PROVIDER: Record<string, string> = {
  ink: 'Reserva Ink',
  ga4: 'Google Analytics 4',
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  whatsapp: 'WhatsApp',
  openai: 'OpenAI',
  instagram: 'Instagram',
};

// A Ink tem duas partes com estados próprios. Ter a credencial cadastrada NÃO prova que ela funciona
// (só o teste de conexão, que é explícito, prova) — por isso o rótulo não diz "conectada". E sem o
// recebimento automático (webhook, adiado de propósito em quem ainda usa o sistema anterior) a
// integração NÃO fica "pendente" nem "com erro".
export function rotuloDaApiInk(estadoApi: string | null | undefined): { label: string; tone: TomSelo } {
  return estadoApi === 'connected' ? { label: 'Credencial cadastrada', tone: 'success' } : { label: 'Credencial não cadastrada', tone: 'neutral' };
}

export function rotuloDoWebhookInk(estadoWebhook: string | null | undefined): { label: string; tone: TomSelo } {
  return estadoWebhook === 'connected'
    ? { label: 'Recebimento automático ativo', tone: 'success' }
    : { label: 'Recebimento automático não ativado', tone: 'neutral' };
}

// ── Resumo da linha do provedor (Integrações, card recolhido) ────────────────────────────────────

export type ChaveProvedor = 'ink' | 'whatsapp' | 'instagram' | 'meta_ads' | 'google_ads' | 'ga4' | 'openai';

// Estado do app "Envio WhatsApp" (modo WhatsApp Web), já traduzido do heartbeat pelo card do canal.
export type EstadoAgenteWeb = 'nunca_conectou' | 'offline' | 'pausado' | 'testando' | 'enviando';

export interface ContextoResumo {
  papel: 'owner' | 'member' | null;
  whatsappModo?: 'meta_api' | 'whatsapp_web' | null;
  // 'carregando' e 'indisponivel' existem porque "não sei" não pode virar "offline".
  agenteWeb?: EstadoAgenteWeb | 'carregando' | 'indisponivel' | null;
  ink?: { webhookAtivo: boolean };
}

export interface AtencaoProvedor {
  mensagem: string;
  acao: string;
  // Aba do card que resolve o problema.
  aba?: string;
}

export interface ResumoProvedor {
  provider: string;
  label: string;
  tone: TomResumo;
  detalhe: string | null;
  // Só preenchido quando há problema REAL que a pessoa logada consegue resolver.
  atencao: AtencaoProvedor | null;
}

// Conectar e reconectar Ink e WhatsApp é do responsável (as rotas exigem owner). Um membro vê o
// estado, mas não recebe um alerta com botão que ele não pode usar.
const EXIGE_OWNER: ReadonlySet<string> = new Set(['ink', 'whatsapp']);

function podeAgir(provider: string, papel: ContextoResumo['papel']): boolean {
  return !EXIGE_OWNER.has(provider) || papel === 'owner';
}

const RECURSO: Record<string, string> = { ga4: 'a propriedade', meta_ads: 'a conta de anúncios', google_ads: 'a conta de anúncios' };

const AGENTE: Record<EstadoAgenteWeb, { label: string; tone: TomResumo }> = {
  nunca_conectou: { label: 'App não conectado', tone: 'warning' },
  offline: { label: 'App offline', tone: 'danger' },
  pausado: { label: 'App pausado', tone: 'warning' },
  testando: { label: 'Testando envio', tone: 'info' },
  enviando: { label: 'Enviando pelo WhatsApp Web', tone: 'success' },
};

function resumoWhatsappWeb(linha: IntegracaoLeitura, ctx: ContextoResumo): ResumoProvedor {
  const base = { provider: linha.provider, detalhe: 'Canal: WhatsApp Web', atencao: null };
  const agente = ctx.agenteWeb;
  if (!agente || agente === 'carregando') return { ...base, label: 'Verificando…', tone: 'neutral' };
  if (agente === 'indisponivel') return { ...base, label: 'Não foi possível verificar', tone: 'warning' };
  const { label, tone } = AGENTE[agente];
  const atencao =
    agente === 'offline'
      ? { mensagem: 'O app Envio WhatsApp está offline', acao: 'Ver detalhes', aba: 'envio' }
      : agente === 'nunca_conectou'
        ? { mensagem: 'O app Envio WhatsApp ainda não foi conectado', acao: 'Conectar o app', aba: 'envio' }
        : null;
  return { ...base, label, tone, atencao };
}

export function resumoDoProvedor(linha: IntegracaoLeitura, ctx: ContextoResumo): ResumoProvedor {
  const nome = NOME_DO_PROVIDER[linha.provider] || linha.provider;
  const selo = seloDoEstado(linha.estado, linha.proximaAcao);
  let label = selo.label;
  let tone: TomResumo = selo.tone;
  let detalhe: string | null = null;
  let atencao: AtencaoProvedor | null = null;

  // WhatsApp Web não depende do número/token da Meta: o que vale é o app no computador da loja.
  if (linha.provider === 'whatsapp' && ctx.whatsappModo === 'whatsapp_web' && linha.estado !== 'not_entitled') {
    return resumoWhatsappWeb(linha, ctx);
  }

  const ativo = linha.estado === 'connected' || linha.estado === 'connected_with_data' || linha.estado === 'degraded';

  if (linha.provider === 'ink') {
    if (linha.estado === 'connected' || linha.estado === 'connected_with_data') {
      ({ label, tone } = rotuloDaApiInk('connected'));
      detalhe = ctx.ink?.webhookAtivo ? 'Recebimento automático de pedidos ativo' : 'Recebimento automático não ativado';
    }
  } else if (linha.provider === 'openai') {
    if (linha.estado === 'connected' || linha.estado === 'connected_with_data') label = 'Chave cadastrada';
    else if (linha.estado === 'not_configured') label = 'Chave não cadastrada';
  } else if (linha.provider === 'whatsapp' && ativo) {
    detalhe = 'Canal: API oficial da Meta';
    // Cadastro manual guarda o token, mas quem o validou foi a pessoa que o colou — só o Embedded
    // Signup passa pela Meta. Não é "Conectado" até o servidor ver a Meta recusar (então vira erro).
    if (linha.estado !== 'degraded' && linha.componentes?.modo === 'manual') label = 'Token cadastrado';
  }

  if (podeAgir(linha.provider, ctx.papel)) {
    if (linha.estado === 'error' && linha.proximaAcao === 'reconnect') {
      atencao = {
        mensagem: linha.provider === 'whatsapp' ? 'O WhatsApp precisa ser reconectado' : `${nome} precisa ser reconectado`,
        acao: 'Resolver',
        aba: linha.provider === 'whatsapp' ? 'conexao' : undefined,
      };
    } else if (linha.estado === 'degraded' && linha.proximaAcao === 'reconnect') {
      atencao = { mensagem: `${nome} precisa de atenção`, acao: 'Resolver', aba: linha.provider === 'whatsapp' ? 'conexao' : undefined };
    } else if (linha.estado === 'configured' && linha.proximaAcao === 'select_resource') {
      const recurso = RECURSO[linha.provider];
      if (recurso) atencao = { mensagem: `${nome}: falta escolher ${recurso}`, acao: 'Concluir configuração' };
    }
  }

  return { provider: linha.provider, label, tone, detalhe, atencao };
}

export interface AlertaAtencao extends AtencaoProvedor {
  provider: string;
}

// Alertas do topo da página: um por provedor com problema real e acionável. Provedores opcionais
// desconectados de propósito, integração indisponível na plataforma e leitura que falhou não geram alerta.
export function alertasDeAtencao(resumos: ResumoProvedor[]): AlertaAtencao[] {
  const alertas: AlertaAtencao[] = [];
  for (const r of resumos) {
    if (r.atencao) alertas.push({ provider: r.provider, ...r.atencao });
  }
  return alertas;
}
