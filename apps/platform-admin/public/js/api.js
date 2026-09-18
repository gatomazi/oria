// Cliente da API do control plane.
//
// Regras que este módulo IMPÕE (contrato §4, §5, §11):
//
//   · tudo é caminho relativo sob /api/platform — nunca host escrito à mão, nunca CORS;
//   · `credentials: 'same-origin'` — o cookie de sessão é HttpOnly e esta camada NUNCA o lê;
//   · o csrfToken vive em MEMÓRIA (nem armazenamento local, nem URL, nem atributo do DOM);
//   · toda mutação manda `X-CSRF-Token`; o header `Origin` é do browser, não é forjado aqui;
//   · o envelope de erro { erro, mensagem, detalhes } vira ErroDaApi, com o código estável
//     preservado — a UI decide o texto a partir do CÓDIGO, não do texto do servidor;
//   · 401 em qualquer resposta derruba o estado local e avisa quem escuta (§11.2).

const BASE = '/api/platform';
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

let csrfToken = null;
const ouvintesDeSessaoPerdida = new Set();

export class ErroDaApi extends Error {
  constructor(status, erro, mensagem, detalhes = null) {
    super(mensagem || erro || 'falha na requisição');
    this.name = 'ErroDaApi';
    this.status = status;
    this.erro = erro || 'erro_desconhecido';
    this.detalhes = detalhes;
  }
}

export function aoPerderSessao(fn) {
  ouvintesDeSessaoPerdida.add(fn);
  return () => ouvintesDeSessaoPerdida.delete(fn);
}

export function definirCsrf(token) {
  csrfToken = typeof token === 'string' && token ? token : null;
}

export function temCsrf() {
  return csrfToken !== null;
}

function avisarSessaoPerdida() {
  csrfToken = null;
  for (const fn of ouvintesDeSessaoPerdida) {
    try { fn(); } catch { /* um ouvinte quebrado não derruba os outros */ }
  }
}

// Monta a query string ignorando o que é nulo/vazio. Cursor é opaco: vai de volta como veio.
export function query(parametros = {}) {
  const p = new URLSearchParams();
  for (const [chave, valor] of Object.entries(parametros)) {
    if (valor === null || valor === undefined || valor === '') continue;
    p.set(chave, String(valor));
  }
  const texto = p.toString();
  return texto ? `?${texto}` : '';
}

async function pedir(metodo, caminho, corpo) {
  const cabecalhos = {};
  if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
  if (!METODOS_SEGUROS.has(metodo) && csrfToken) cabecalhos['X-CSRF-Token'] = csrfToken;

  let resposta;
  try {
    resposta = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      headers: cabecalhos,
      credentials: 'same-origin',
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
  } catch {
    // Rede fora / servidor não respondeu. Não há envelope para ler.
    throw new ErroDaApi(0, 'rede_indisponivel', 'não foi possível falar com o Oria Admin');
  }

  const texto = await resposta.text();
  let dados = null;
  if (texto) {
    try { dados = JSON.parse(texto); } catch { dados = null; }
  }

  if (resposta.ok) return dados;

  if (resposta.status === 401) avisarSessaoPerdida();

  const erro = new ErroDaApi(
    resposta.status,
    dados && dados.erro,
    dados && dados.mensagem,
    dados && dados.detalhes ? dados.detalhes : null
  );
  if (resposta.status === 429) {
    const espera = resposta.headers.get('Retry-After');
    if (espera) erro.retryAfter = Number(espera) || null;
  }
  throw erro;
}

const get = (caminho) => pedir('GET', caminho);
const post = (caminho, corpo = {}) => pedir('POST', caminho, corpo);
const put = (caminho, corpo = {}) => pedir('PUT', caminho, corpo);
const patch = (caminho, corpo = {}) => pedir('PATCH', caminho, corpo);
const remover = (caminho) => pedir('DELETE', caminho);

// ── Auth ───────────────────────────────────────────────────────────────────────────────────

export const auth = {
  // `returnUrl` é validado em `rotas.js` antes de chegar aqui: só caminho local.
  async login({ email, senha, returnUrl }) {
    const dados = await pedir('POST', '/auth/login', {
      email,
      senha,
      manterOutrasSessoes: false,
      returnUrl: returnUrl || null,
    });
    definirCsrf(dados.csrfToken);
    return dados;
  },
  async sessao() {
    const dados = await get('/auth/session');
    definirCsrf(dados.csrfToken);
    return dados;
  },
  async logout() {
    try {
      await post('/auth/logout');
    } finally {
      csrfToken = null;
    }
  },
};

// ── Recursos ───────────────────────────────────────────────────────────────────────────────

export const overview = () => get('/overview');

export const admins = {
  listar: (p) => get(`/admins${query(p)}`),
  criar: (corpo) => post('/admins', corpo),
  desativar: (id) => post(`/admins/${id}/deactivate`),
  reativar: (id) => post(`/admins/${id}/reactivate`),
  trocarPapel: (id, papel) => post(`/admins/${id}/role`, { papel }),
};

export const plans = {
  listar: (p) => get(`/plans${query(p)}`),
  buscar: (id) => get(`/plans/${id}`),
  criar: (corpo) => post('/plans', corpo),
  atualizar: (id, corpo) => patch(`/plans/${id}`, corpo),
  substituirFeatures: (id, features) => put(`/plans/${id}/features`, { features }),
  arquivar: (id) => post(`/plans/${id}/archive`),
};

export const organizations = {
  listar: (p) => get(`/organizations${query(p)}`),
  criar: (corpo) => post('/organizations', corpo),
  detalhe: (id) => get(`/organizations/${id}`),
  suspender: (id, motivo) => post(`/organizations/${id}/suspend`, { motivo }),
  reativar: (id, motivo) => post(`/organizations/${id}/reactivate`, { motivo: motivo || null }),
  assinatura: (id) => get(`/organizations/${id}/subscription`),
  trocarPlano: (id, planoChave, motivo) => put(`/organizations/${id}/subscription`, {
    planoChave, motivo: motivo || null,
  }),
  entitlements: (id) => get(`/organizations/${id}/entitlements`),
  definirOverride: (id, feature, permitido, motivo) => put(
    `/organizations/${id}/entitlements/${encodeURIComponent(feature)}`,
    { permitido, motivo: motivo || null }
  ),
  removerOverride: (id, feature) => remover(`/organizations/${id}/entitlements/${encodeURIComponent(feature)}`),
  convites: (id) => get(`/organizations/${id}/invites`),
  emitirConvite: (id, corpo) => post(`/organizations/${id}/invites`, corpo),
  reemitirConvite: (id, inviteId, validadeHoras) => post(
    `/organizations/${id}/invites/${inviteId}/reissue`,
    { validadeHoras: validadeHoras ?? null }
  ),
  revogarConvite: (id, inviteId, motivo) => post(
    `/organizations/${id}/invites/${inviteId}/revoke`,
    { motivo: motivo || null }
  ),
  membros: (id) => get(`/organizations/${id}/members`),
  removerMembro: (id, userId) => remover(`/organizations/${id}/members/${userId}`),
  onboarding: (id) => get(`/organizations/${id}/onboarding`),
  integracoes: (id, p) => get(`/organizations/${id}/integrations${query(p)}`),
};

export const users = (p) => get(`/users${query(p)}`);
export const onboardings = (p) => get(`/onboardings${query(p)}`);
export const integrations = (p) => get(`/integrations${query(p)}`);
export const jobs = (p) => get(`/jobs${query(p)}`);
export const webhooks = (p) => get(`/webhooks${query(p)}`);
export const audit = (p) => get(`/audit${query(p)}`);
