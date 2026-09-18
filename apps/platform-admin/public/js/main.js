// Boot do Oria Admin (control plane).
//
// Sequência do §11.1 do contrato:
//   1. `GET /auth/session` no carregamento;
//   2. 401 → tela de login, guardando o caminho pedido como returnUrl LOCAL;
//   3. csrfToken fica em memória (api.js), nunca em armazenamento local;
//   4. 401 em qualquer resposta depois disso → volta para o login e limpa o estado.

import * as api from './api.js';
import * as sessao from './sessao.js';
import * as rotas from './rotas.js';
import { html, cru, icone, caixaDeErro, avisar } from './ui.js';
import { renderizarLogin } from './views/login.js';

const raiz = document.getElementById('raiz');

const GRUPOS_DE_NAVEGACAO = [
  {
    titulo: 'Plataforma',
    itens: [
      { href: '/', rotulo: 'Visão geral', glifo: 'painel' },
      { href: '/organizations', rotulo: 'Organizations', glifo: 'predio' },
      { href: '/plans', rotulo: 'Planos', glifo: 'camadas' },
    ],
  },
  {
    titulo: 'Pessoas',
    itens: [
      { href: '/platform-admins', rotulo: 'Platform admins', glifo: 'escudo' },
      { href: '/users', rotulo: 'Usuários do tenant', glifo: 'pessoas' },
    ],
  },
  {
    titulo: 'Operação',
    itens: [
      { href: '/onboardings', rotulo: 'Onboardings', glifo: 'bandeira' },
      { href: '/integrations', rotulo: 'Integrações', glifo: 'plugue' },
      { href: '/jobs', rotulo: 'Jobs', glifo: 'relogio' },
      { href: '/webhooks', rotulo: 'Webhooks', glifo: 'raio' },
      { href: '/audit', rotulo: 'Auditoria', glifo: 'lista' },
    ],
  },
];

// Carregamento sob demanda: cada tela é um módulo. Sem bundler, sem passo de build — o browser
// resolve o `import()` relativo e o servidor entrega o arquivo de `public/`.
const CARREGADORES = {
  overview: () => import('./views/overview.js'),
  organizations: () => import('./views/organizations.js'),
  organization: () => import('./views/organization.js'),
  plans: () => import('./views/plans.js'),
  admins: () => import('./views/admins.js'),
  users: () => import('./views/observabilidade.js'),
  onboardings: () => import('./views/observabilidade.js'),
  integrations: () => import('./views/observabilidade.js'),
  jobs: () => import('./views/observabilidade.js'),
  webhooks: () => import('./views/observabilidade.js'),
  audit: () => import('./views/observabilidade.js'),
};

let cascaMontada = false;
let renderizacaoAtual = 0;

// ── Casca autenticada ─────────────────────────────────────────────────────────────────────

function marcaDoControlPlane() {
  return html`
    <div class="nav-marca">
      <span class="nome">Oria Admin</span>
      <span class="selo-plano">Control plane</span>
    </div>`;
}

function montarCasca() {
  const admin = sessao.adminAtual();
  raiz.dataset.estado = 'autenticado';
  raiz.innerHTML = html`
    <div class="casca" data-nav="fechada">
      <nav class="nav" aria-label="Navegação principal">
        ${cru(marcaDoControlPlane())}
        ${cru(GRUPOS_DE_NAVEGACAO.map((grupo) => html`
          <div class="nav-grupo">
            <h2>${grupo.titulo}</h2>
            ${cru(grupo.itens.map((item) => html`
              <a class="nav-item" data-rota href="${item.href}">${cru(icone(item.glifo, 16))}<span>${item.rotulo}</span></a>`).join(''))}
          </div>`).join(''))}
        <div class="nav-rodape">
          <div class="nav-admin">
            <div class="email" title="${admin ? admin.email : ''}">${admin ? (admin.nome || admin.email) : ''}</div>
            <div class="papel">${admin && admin.papel === 'platform_owner' ? 'Platform owner' : 'Platform operator'}</div>
          </div>
          <button type="button" class="btn btn-fantasma" data-sair>${cru(icone('sair', 16))}<span>Sair</span></button>
        </div>
      </nav>
      <div class="painel">
        <header class="topo">
          <button type="button" class="fechar-x" data-abrir-nav aria-label="Abrir navegação" aria-expanded="false">${cru(icone('menu', 16))}</button>
          <span class="nome" style="font-weight:600">Oria Admin</span>
          <span class="selo-plano">Control plane</span>
        </header>
        <main id="conteudo" tabindex="-1"></main>
      </div>
    </div>`;

  const casca = raiz.querySelector('.casca');
  raiz.querySelector('[data-abrir-nav]').addEventListener('click', (e) => {
    const aberta = casca.dataset.nav === 'aberta';
    casca.dataset.nav = aberta ? 'fechada' : 'aberta';
    e.currentTarget.setAttribute('aria-expanded', String(!aberta));
  });
  raiz.querySelector('[data-sair]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api.auth.logout();
    } catch { /* o cookie já pode ter morrido; o destino é o mesmo */ }
    sessao.definirAdmin(null);
    cascaMontada = false;
    rotas.navegar('/login');
  });
  // Fecha a navegação móvel ao navegar e ao tocar fora dela. A escuta fica na casca, que é
  // recriada a cada montagem — em `raiz` ela se acumularia a cada login.
  casca.addEventListener('click', (evento) => {
    if (evento.target === casca || evento.target.closest('a[data-rota]')) casca.dataset.nav = 'fechada';
  });

  cascaMontada = true;
}

function marcarNavegacaoAtiva(caminho) {
  const base = `/${caminho.split('?')[0].split('/').filter(Boolean)[0] || ''}`;
  for (const link of raiz.querySelectorAll('.nav-item')) {
    const href = link.getAttribute('href');
    const ativo = href === '/' ? base === '/' : base === href;
    if (ativo) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

// ── Renderização ──────────────────────────────────────────────────────────────────────────

async function renderizar(caminho) {
  const selo = ++renderizacaoAtual;

  if (!sessao.autenticado()) {
    cascaMontada = false;
    const pedido = caminho.startsWith('/login') ? null : caminho;
    renderizarLogin(raiz, { returnUrl: pedido, aoEntrar: entrarComSessao });
    return;
  }

  if (caminho.startsWith('/login')) { rotas.navegar('/', { substituir: true }); return; }
  if (!cascaMontada) montarCasca();
  marcarNavegacaoAtiva(caminho);

  const conteudo = raiz.querySelector('#conteudo');
  const casado = rotas.casar(caminho);
  if (!casado) {
    conteudo.innerHTML = html`
      <div class="pagina">
        <div class="cabecalho-pagina"><div><h1>Tela não encontrada</h1>
          <p class="sub">O caminho <code>${caminho}</code> não existe no Oria Admin.</p></div></div>
        <a class="btn btn-secundario" data-rota href="/" style="align-self:flex-start">Ir para a visão geral</a>
      </div>`;
    return;
  }

  document.title = `${casado.tela.titulo} · Oria Admin`;
  conteudo.innerHTML = html`<div class="carregando" role="status">Carregando ${casado.tela.titulo}…</div>`;

  try {
    const modulo = await CARREGADORES[casado.tela.modulo]();
    if (selo !== renderizacaoAtual) return;
    await modulo.renderizar(conteudo, {
      params: casado.params,
      busca: casado.busca,
      tela: casado.tela.modulo,
      navegar: rotas.navegar,
    });
  } catch (err) {
    if (selo !== renderizacaoAtual) return;
    if (err && err.status === 401) return;
    conteudo.innerHTML = html`<div class="pagina">${cru(caixaDeErro(err))}</div>`;
  }
}

function entrarComSessao(dados) {
  sessao.definirAdmin(dados.admin);
  cascaMontada = false;
  // `destino` pode vir ABSOLUTO do backend (ele monta a partir de PLATFORM_ADMIN_URL). A UI não
  // navega para host nenhum: extrai o caminho e valida que é local antes de usar.
  let destino = '/';
  try {
    const url = new URL(dados.destino, window.location.origin);
    if (url.origin === window.location.origin) destino = rotas.caminhoLocal(url.pathname + url.search) || '/';
  } catch { destino = '/'; }
  rotas.navegar(destino, { substituir: true });
}

// ── Início ────────────────────────────────────────────────────────────────────────────────

api.aoPerderSessao(() => {
  if (!sessao.autenticado()) return;
  sessao.definirAdmin(null);
  cascaMontada = false;
  avisar('Sessão encerrada. Entre de novo.', 'aviso');
  rotas.navegar('/login');
});

rotas.aoNavegar(renderizar);

(async function iniciar() {
  try {
    const dados = await api.auth.sessao();
    sessao.definirAdmin(dados.admin);
  } catch (err) {
    sessao.definirAdmin(null);
    if (err && err.status && err.status !== 401) {
      // Banco fora, por exemplo. Mostra o motivo em vez de fingir que é "não logado".
      raiz.dataset.estado = 'erro';
      raiz.innerHTML = html`<div class="login"><div class="login-cartao">${cru(caixaDeErro(err))}
        <button type="button" class="btn btn-secundario" style="margin-top:16px" data-recarregar>Tentar de novo</button></div></div>`;
      raiz.querySelector('[data-recarregar]').addEventListener('click', () => window.location.reload());
      return;
    }
  }
  await renderizar(rotas.caminhoAtual());
}());
