import { api } from './client';

// Envio pelo WhatsApp Web (alternativa à API da Meta) — ver docs/plano-whatsapp-web-envio.md.
export type WhatsappProvider = 'meta_api' | 'whatsapp_web';
export type WhatsappWebOrigem = 'pedido' | 'carrinho' | 'pix' | 'campanha';
export type WhatsappWebStatus = 'aguardando_aprovacao' | 'pending' | 'claimed' | 'sent' | 'failed' | 'desconhecido' | 'cancelado';
export type WhatsappWebAcao = 'aprovar' | 'cancelar' | 'reenviar';

export interface WhatsappWebFaixas {
  seguro: number;
  atencao: number;
  risco: number;
}

export interface WhatsappWebAgenteStatus {
  tokenConfigurado: boolean;
  tokenCriadoEm: string | null;
  ultimoHeartbeatEm: string | null;
  online: boolean;
  versao: string | null;
  whatsapp: 'logado' | 'aguardando_qr' | 'carregando' | 'erro' | 'nao_verificavel' | null;
  // App desktop: por onde envia (WhatsApp Desktop ou aba do navegador), sistema e se está pausado.
  executor: 'desktop' | 'navegador' | null;
  plataforma: 'darwin' | 'win32' | 'linux' | null;
  pausado: boolean;
  // Mensagem de teste saindo pelo botão "Testar" do app (pode estar com a fila pausada).
  testando: boolean;
}

export interface WhatsappWebConfig {
  provider: WhatsappProvider;
  limiteRecomendado: number;
  tetoDiario: number;
  faixas: WhatsappWebFaixas;
  postgresConfigurado: boolean;
  agente: WhatsappWebAgenteStatus;
}

export interface WhatsappWebResumo {
  disponivel: boolean;
  provider?: WhatsappProvider;
  agente?: WhatsappWebAgenteStatus;
  enviadosHoje?: number;
  porOrigem?: Record<WhatsappWebOrigem, number>;
  limiteRecomendado?: number;
  tetoDiario?: number;
  faixas?: WhatsappWebFaixas;
  fila?: { aguardandoAprovacao: number; pendentes: number; enviando: number; desconhecidos: number };
}

export interface WhatsappWebItem {
  id: string;
  origem: WhatsappWebOrigem;
  referencia: string;
  loja: string | null;
  evento: string | null;
  telefone: string;
  nome: string | null;
  template: string | null;
  texto: string;
  midiaIgnorada: boolean;
  status: WhatsappWebStatus;
  tentativas: number;
  enviadoEm: string | null;
  falhaCodigo: string | null;
  falhaMensagem: string | null;
  // Versão da mensagem sorteada (1 = texto principal); null pra envio sem variações.
  variacao: number | null;
  // false = app desktop apertou Enter sem conseguir confirmar na tela.
  envioConfirmado: boolean | null;
  // Quem reservou: 'app' (app desktop) ou 'celular' (envio assistido pelo painel).
  executor: 'app' | 'celular' | null;
  criadoEm: string;
  atualizadoEm: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function getWhatsappWebConfig() {
  return api<WhatsappWebConfig>('/api/admin/whatsapp-web/config');
}

export function updateWhatsappWebConfig(data: Partial<Pick<WhatsappWebConfig, 'provider' | 'limiteRecomendado' | 'tetoDiario'>>) {
  return api<{ ok: boolean }>('/api/admin/whatsapp-web/config', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(data) });
}

export function gerarTokenAgente() {
  return api<{ token: string }>('/api/admin/whatsapp-web/agente-token', { method: 'POST' });
}

export function getWhatsappWebResumo() {
  return api<WhatsappWebResumo>('/api/admin/whatsapp-web/resumo');
}

export function getWhatsappWebFila(filtros: { status?: WhatsappWebStatus | '' | WhatsappWebStatus[]; origem?: WhatsappWebOrigem | '' }) {
  const params = new URLSearchParams();
  const status = Array.isArray(filtros.status) ? filtros.status.join(',') : filtros.status;
  if (status) params.set('status', status);
  if (filtros.origem) params.set('origem', filtros.origem);
  const qs = params.toString();
  return api<{ itens: WhatsappWebItem[] }>('/api/admin/whatsapp-web/fila' + (qs ? '?' + qs : ''));
}

// Envio pelo celular: reserva a mensagem (o app desktop não pega mais), abre o WhatsApp do celular
// com o texto pronto e depois confirma se enviou (ou devolve pra fila).
export function assumirItemFila(id: string) {
  return api<{ item: { id: string; telefone: string; texto: string } }>(`/api/admin/whatsapp-web/fila/${encodeURIComponent(id)}/assumir`, { method: 'POST' });
}

export function concluirItemFila(id: string, enviado: boolean) {
  return api<{ ok: boolean }>(`/api/admin/whatsapp-web/fila/${encodeURIComponent(id)}/concluir`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ enviado }),
  });
}

export function linkWhatsappCelular(telefone: string, texto: string) {
  return `https://wa.me/${telefone.replace(/\D/g, '')}?text=${encodeURIComponent(texto)}`;
}

export function aplicarAcaoFila(acao: WhatsappWebAcao, ids: string[]) {
  return api<{ ok: boolean; atualizados: number }>('/api/admin/whatsapp-web/fila/acao', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ acao, ids }),
  });
}

// ── Mensagens do WhatsApp Web ──────────────────────────────────────────
// Sem cabeçalho, rodapé nem botões (não existem no WhatsApp Web): texto com formatação nativa e
// variáveis nomeadas direto no corpo, ex: {{cliente.nome}}.
export type MensagemWebTipo = 'comum' | 'pedido' | 'carrinho' | 'campanha';

export interface MensagemWeb {
  id: string;
  nome: string;
  tipo: MensagemWebTipo;
  corpo: string;
  // Versões extras (até 4). Cada envio sorteia entre o corpo e elas.
  variacoes: string[];
  criadoEm: string;
  atualizadoEm: string;
  eventos: { loja: string; evento: string }[];
}

export type MensagemWebInput = Pick<MensagemWeb, 'nome' | 'tipo' | 'corpo' | 'variacoes'>;

export function listarMensagensWeb() {
  return api<{ mensagens: MensagemWeb[] }>('/api/admin/whatsapp-web/mensagens');
}

export function obterMensagemWeb(id: string) {
  return api<{ mensagem: MensagemWeb }>(`/api/admin/whatsapp-web/mensagens/${encodeURIComponent(id)}`);
}

export function criarMensagemWeb(data: MensagemWebInput) {
  return api<{ mensagem: MensagemWeb }>('/api/admin/whatsapp-web/mensagens', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) });
}

export function salvarMensagemWeb(id: string, data: MensagemWebInput) {
  return api<{ mensagem: MensagemWeb }>(`/api/admin/whatsapp-web/mensagens/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
}

export function excluirMensagemWeb(id: string) {
  return api<{ ok: boolean }>(`/api/admin/whatsapp-web/mensagens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function salvarVinculoWeb(evento: string, body: Record<string, unknown>) {
  return api(`/api/admin/automacao-eventos/${encodeURIComponent(evento)}/web`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}
