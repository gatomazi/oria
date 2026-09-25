import { toast } from '../lib/toast';

// Porte de api() em src/admin/admin-utils.js — mesmo contrato (credentials same-origin, parse de
// JSON tolerante a corpo vazio/não-JSON, erro vira Error(message)).
//
// Política de toast (Fase 6, docs/ui-lapidacao-auditoria.md §16): só AÇÕES (POST/PUT/PATCH/DELETE)
// avisam por toast quando falham. Falha de CARREGAMENTO (GET) é mostrada pela própria tela, no
// lugar do dado (ErrorState/Callout) — antes cada falha de leitura aparecia duas vezes (toast +
// estado da tela) e polling com erro empilhava toasts. `toast` explícito sobrescreve a regra.
export interface ApiOptions extends RequestInit {
  toast?: boolean;
}

// Erro de API com o código legível por máquina que o backend mandou, quando mandou. Existe porque
// nem toda falha é falha: algumas são configuração faltando, e a tela precisa poder oferecer a ação
// certa ("Definir em Integrações") em vez do ErrorState genérico. Continua sendo um Error com a
// mesma `message` de antes — quem só lê a mensagem não muda em nada.
export class ApiError extends Error {
  codigo: string | null;
  status: number;
  constructor(mensagem: string, status: number, codigo: string | null) {
    super(mensagem);
    this.name = 'ApiError';
    this.status = status;
    this.codigo = codigo;
  }
}

// Token CSRF da sessão atual (Fase 2). Vem de GET /api/admin/session ou do login e vive só em
// memória — nunca em localStorage. Toda escrita (POST/PUT/PATCH/DELETE) o envia no header.
let csrfToken: string | null = null;

// Disparado quando o servidor diz que a Organization ativa não vale mais (ou precisa ser escolhida).
// O AuthContext escuta e relê a sessão; nenhuma tela escolhe Organization por conta própria.
export const EVENTO_CONTEXTO_ORGANIZACAO = 'oria:contexto-organizacao';
const CODIGOS_CONTEXTO = new Set(['ORGANIZATION_CONTEXT_REQUIRED', 'ORGANIZATION_ACCESS_REVOKED', 'NO_ORGANIZATION_MEMBERSHIP']);

export function definirCsrfToken(token: string | null): void {
  csrfToken = token;
}

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function api<T = unknown>(path: string, options?: ApiOptions): Promise<T> {
  const { toast: toastOpcao, ...init } = options || {};
  // Corpo em texto sem Content-Type faz o express.json() ignorar a requisição inteira: req.body
  // chega vazio e a rota responde "campo obrigatório" para um campo que foi enviado. Como só
  // mandamos JSON como string, dá para preencher aqui — FormData e Blob não são string e passam
  // intactos, com o boundary que o navegador define. Cabeçalho explícito do chamador sempre vence.
  const cabecalhos = new Headers(init.headers || {});
  if (typeof init.body === 'string' && !cabecalhos.has('Content-Type')) {
    cabecalhos.set('Content-Type', 'application/json');
  }
  const metodoHttp = (init.method || 'GET').toUpperCase();
  if (!METODOS_SEGUROS.has(metodoHttp) && csrfToken && !cabecalhos.has('X-CSRF-Token')) {
    cabecalhos.set('X-CSRF-Token', csrfToken);
  }
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: cabecalhos });
  const raw = await res.text();

  let data: Record<string, unknown> = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      // resposta não é JSON — ex.: erro de infra/Cloudflare
    }
  }

  if (!res.ok) {
    const mensagem =
      (data.error as string | undefined) ||
      `Erro HTTP ${res.status}${raw && !data.error ? ' — resposta inesperada do servidor' : ''}`;
    const metodo = (init.method || 'GET').toUpperCase();
    const avisar = toastOpcao ?? (metodo !== 'GET' && metodo !== 'HEAD');
    if (avisar) toast(mensagem, 'erro');
    const codigo = (data.codigo as string | undefined) || null;
    if (codigo && CODIGOS_CONTEXTO.has(codigo) && path !== '/api/admin/session') {
      window.dispatchEvent(new Event(EVENTO_CONTEXTO_ORGANIZACAO));
    }
    throw new ApiError(mensagem, res.status, codigo);
  }

  return data as T;
}

// POST que devolve um ARQUIVO (ex.: CSV), não JSON. Mesmo contrato de credenciais e CSRF de `api()`.
// Erro devolve a mensagem do servidor; sucesso devolve o Blob e o nome sugerido pelo servidor.
export async function apiArquivoPost(path: string, corpo: unknown): Promise<{ blob: Blob; nome: string }> {
  const cabecalhos = new Headers({ 'Content-Type': 'application/json' });
  if (csrfToken) cabecalhos.set('X-CSRF-Token', csrfToken);
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: cabecalhos, body: JSON.stringify(corpo) });
  if (!res.ok) {
    let mensagem = `Erro HTTP ${res.status}`;
    try { mensagem = ((await res.json()) as { error?: string }).error || mensagem; } catch { /* resposta não é JSON */ }
    toast(mensagem, 'erro');
    throw new ApiError(mensagem, res.status, null);
  }
  const disposicao = res.headers.get('Content-Disposition') || '';
  const nome = /filename="([^"]+)"/.exec(disposicao)?.[1] || 'clientes.csv';
  return { blob: await res.blob(), nome };
}
