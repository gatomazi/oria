// Telas de observabilidade: usuários, onboardings, integrações, jobs, webhooks e auditoria.
//
// Todas são LEITURA. O control plane não oferece mutação nenhuma nestas superfícies, e a tela não
// finge que oferece:
//   · não há rota para marcar passo de onboarding como concluído — o estado é derivado do fato;
//   · não há botão de testar integração — a rota está fora desta versão (§10.9);
//   · não há payload de webhook: `headers` e `body` não saem de nenhum read model.

import * as api from '../api.js';
import {
  html, cru, dataHora, relativo, vazio, selo, seloIntegracao, seloOnboarding, seloStatus,
  icone, abrirDrawer, avisoCaixa,
} from '../ui.js';
import { criarListagem } from '../lista.js';
import { ACOES_AUDITORIA, ROTULO_PASSO } from '../vocabulario.js';

const CABECALHOS = {
  users: {
    titulo: 'Usuários do tenant',
    sub: 'Pessoas que entram no painel do lojista. Não há criação por aqui: pessoa entra por convite.',
  },
  onboardings: {
    titulo: 'Onboardings',
    sub: 'Estado derivado dos requisitos reais. O Admin lê; quem conclui um passo é o fato.',
  },
  integrations: {
    titulo: 'Integrações',
    sub: 'Projeção estreita: sem token, sem config, sem id de conta externa, sem mensagem de provider.',
  },
  jobs: { titulo: 'Jobs', sub: 'Leases dos schedulers. O dono do lease vira um booleano — é identificador de worker.' },
  webhooks: { titulo: 'Webhooks', sub: 'Recebimentos verificados e não verificados. Sem headers e sem corpo: é payload cru com PII.' },
  audit: { titulo: 'Auditoria', sub: 'Vocabulário fechado de ações. Ordem monotônica, do mais recente para o mais antigo.' },
};

export async function renderizar(alvo, { tela, navegar }) {
  const cabecalho = CABECALHOS[tela];

  alvo.innerHTML = html`
    <div class="pagina">
      <div class="cabecalho-pagina">
        <div>
          <h1>${cabecalho.titulo}</h1>
          <p class="sub">${cabecalho.sub}</p>
        </div>
      </div>
      ${cru(AVISOS[tela] || '')}
      <section class="cartao">
        <div class="barra-filtros" data-filtros>${cru(FILTROS[tela] || '')}</div>
        <div data-lista></div>
      </section>
    </div>`;

  const listaAlvo = alvo.querySelector('[data-lista]');
  const filtros = alvo.querySelector('[data-filtros]');
  if (!filtros.textContent.trim() && !filtros.children.length) filtros.remove();

  const ler = (nome) => {
    const campo = alvo.querySelector(`[name="${nome}"]`);
    return campo ? campo.value.trim() : '';
  };

  function montar() {
    criarListagem({ alvo: listaAlvo, ...CONFIG[tela](ler, navegar) });
  }

  for (const campo of alvo.querySelectorAll('[data-filtros] select')) campo.addEventListener('change', montar);
  const aplicar = alvo.querySelector('[data-aplicar]');
  if (aplicar) aplicar.addEventListener('click', montar);
  for (const campo of alvo.querySelectorAll('[data-filtros] input')) {
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') montar(); });
  }

  listaAlvo.addEventListener('click', (evento) => {
    const botao = evento.target.closest('[data-audit]');
    if (!botao) return;
    let registro;
    try { registro = JSON.parse(botao.dataset.audit); } catch { return; }
    abrirDetalheDeAuditoria(registro);
  });

  montar();
}

// ── Avisos por tela ───────────────────────────────────────────────────────────────────────

const AVISOS = {
  integrations: avisoCaixa('info', 'Último teste e último sucesso vêm nulos.',
    'A tabela de integrações não tem essas colunas. Derivá-las de "atualizado em" seria dado fabricado, então a API devolve null e a tela mostra vazio.'),
  onboardings: avisoCaixa('info', 'Não existe "marcar como concluído".',
    'O passo fica completo quando o requisito real é satisfeito — integração conectada, loja criada, owner presente. Forçar o estado aqui seria mentir sobre o tenant.'),
  webhooks: avisoCaixa('info', 'Sem payload.',
    'Nenhuma rota devolve headers ou corpo de webhook. O que existe é metadado: quando chegou, se foi verificado, por qual método e qual evento.'),
};

// ── Filtros por tela ──────────────────────────────────────────────────────────────────────

const FILTROS = {
  users: html`
    <div class="campo">
      <label for="f-q">Buscar</label>
      <input id="f-q" name="q" type="search" placeholder="nome ou e-mail, ao menos 2 caracteres" autocomplete="off">
    </div>
    <div class="campo estreito">
      <label for="f-status">Status</label>
      <select id="f-status" name="status">
        <option value="">Todos</option>
        <option value="active">Ativos</option>
        <option value="disabled">Desativados</option>
      </select>
    </div>
    <button type="button" class="btn btn-secundario" data-aplicar>${cru(icone('busca', 16))}Aplicar</button>`,

  onboardings: html`
    <div class="campo estreito">
      <label for="f-status">Status</label>
      <select id="f-status" name="status">
        <option value="">Todos</option>
        <option value="not_started">Não iniciado</option>
        <option value="in_progress">Em andamento</option>
        <option value="blocked">Bloqueado</option>
        <option value="complete">Concluído</option>
      </select>
    </div>`,

  integrations: html`
    <div class="campo estreito">
      <label for="f-provider">Provider</label>
      <input id="f-provider" name="provider" type="text" placeholder="ink, meta, google…" autocomplete="off">
    </div>
    <div class="campo estreito">
      <label for="f-status">Status</label>
      <select id="f-status" name="status">
        <option value="">Todos</option>
        <option value="connected">Conectadas</option>
        <option value="disconnected">Desconectadas</option>
        <option value="error">Em erro</option>
      </select>
    </div>
    <button type="button" class="btn btn-secundario" data-aplicar>${cru(icone('busca', 16))}Aplicar</button>`,

  jobs: html`
    <div class="campo">
      <label for="f-org">Organization (identificador)</label>
      <input id="f-org" name="organizationId" type="text" placeholder="deixe vazio para todas" autocomplete="off" spellcheck="false">
    </div>
    <button type="button" class="btn btn-secundario" data-aplicar>${cru(icone('busca', 16))}Aplicar</button>`,

  webhooks: html`
    <div class="campo">
      <label for="f-org">Organization (identificador)</label>
      <input id="f-org" name="organizationId" type="text" placeholder="deixe vazio para todas" autocomplete="off" spellcheck="false">
    </div>
    <div class="campo estreito">
      <label for="f-verificado">Verificado</label>
      <select id="f-verificado" name="verificado">
        <option value="">Todos</option>
        <option value="true">Só verificados</option>
        <option value="false">Só não verificados</option>
      </select>
    </div>
    <button type="button" class="btn btn-secundario" data-aplicar>${cru(icone('busca', 16))}Aplicar</button>`,

  audit: html`
    <div class="campo estreito">
      <label for="f-action">Ação</label>
      <select id="f-action" name="action">
        <option value="">Todas</option>
        ${cru(ACOES_AUDITORIA.map((a) => html`<option value="${a}">${a}</option>`).join(''))}
      </select>
    </div>
    <div class="campo">
      <label for="f-org">Organization (identificador)</label>
      <input id="f-org" name="organizationId" type="text" placeholder="deixe vazio para todas" autocomplete="off" spellcheck="false">
    </div>
    <button type="button" class="btn btn-secundario" data-aplicar>${cru(icone('busca', 16))}Aplicar</button>`,
};

// ── Configuração de cada listagem ─────────────────────────────────────────────────────────

const CONFIG = {
  users: (ler) => {
    const q = ler('q');
    return {
      buscar: (cursor) => api.users({ q: q.length >= 2 ? q : null, status: ler('status'), cursor, limit: 50 }),
      colunas: [
        { titulo: 'Pessoa' }, { titulo: 'Status' }, { titulo: 'Organizations' },
        { titulo: 'Criado em' }, { titulo: 'Último login' },
      ],
      linha: (u) => html`
        <tr>
          <td><div class="principal">${u.nome || u.email}</div><div class="secundario">${u.email}</div></td>
          <td>${seloStatus(u.status)}</td>
          <td>${(u.organizations && u.organizations.length)
            ? cru(u.organizations.map((o) => html`<span class="selo ${cru(o.papel === 'owner' ? 'premium' : '')}">${o.nome} · ${o.papel}</span>`).join(' '))
            : cru('<span class="secundario">nenhuma</span>')}</td>
          <td class="secundario">${dataHora(u.criadoEm)}</td>
          <td class="secundario">${dataHora(u.ultimoLoginEm)}</td>
        </tr>`,
      vazioTitulo: 'Nenhum usuário.',
      vazioDetalhe: 'Pessoas aparecem aqui depois de aceitar um convite no painel do lojista.',
    };
  },

  onboardings: (ler, navegar) => ({
    buscar: (cursor) => api.onboardings({ status: ler('status'), cursor, limit: 50 }),
    colunas: [
      { titulo: 'Organization' }, { titulo: 'Status' }, { titulo: 'Passo atual' },
      { titulo: 'Concluídos' }, { titulo: 'Bloqueado em' }, { titulo: 'Último erro' }, { titulo: 'Atualizado' },
    ],
    linha: (o) => html`
      <tr data-id="${o.organizationId}">
        <td class="principal">${o.organizationNome}</td>
        <td>${seloOnboarding(o.status)}</td>
        <td class="mono">${vazio(o.currentStep)}</td>
        <td class="secundario">${(o.completedSteps || []).length
          ? cru((o.completedSteps || []).map((s) => html`<span class="selo ok">${ROTULO_PASSO[s] || s}</span>`).join(' '))
          : cru('<span class="secundario">nenhum</span>')}</td>
        <td>${o.blockedStep ? selo(o.blockedStep, 'critico') : cru('<span class="secundario">—</span>')}</td>
        <td class="secundario mono">${vazio(o.lastErrorCode)}</td>
        <td class="secundario">${dataHora(o.atualizadoEm)}</td>
      </tr>`,
    vazioTitulo: 'Nenhum onboarding.',
    vazioDetalhe: 'Organizations criadas pelo control plane nascem com onboarding; as legadas não têm.',
    aoClicarLinha: (id) => navegar(`/organizations/${id}?aba=onboarding`),
  }),

  integrations: (ler, navegar) => ({
    buscar: (cursor) => api.integrations({ provider: ler('provider'), status: ler('status'), cursor, limit: 50 }),
    colunas: [
      { titulo: 'Organization' }, { titulo: 'Provider' }, { titulo: 'Status' }, { titulo: 'Nome exibido' },
      { titulo: 'Último teste' }, { titulo: 'Último sucesso' }, { titulo: 'Último erro' },
    ],
    linha: (i) => html`
      <tr data-id="${i.organizationId}">
        <td class="principal">${i.organizationNome}</td>
        <td class="mono">${i.provider}</td>
        <td>${seloIntegracao(i.status)}</td>
        <td class="secundario">${vazio(i.displayName)}</td>
        <td class="secundario">${dataHora(i.lastTestEm)}</td>
        <td class="secundario">${dataHora(i.lastSuccessEm)}</td>
        <td class="secundario mono">${vazio(i.lastErrorCode)}</td>
      </tr>`,
    vazioTitulo: 'Nenhuma integração.',
    vazioDetalhe: 'As conexões são feitas pelo lojista, no painel dele.',
    aoClicarLinha: (id) => navegar(`/organizations/${id}?aba=integracoes`),
  }),

  jobs: (ler, navegar) => ({
    buscar: (cursor) => api.jobs({ organizationId: ler('organizationId'), cursor, limit: 50 }),
    colunas: [
      { titulo: 'Job' }, { titulo: 'Organization' }, { titulo: 'Lease' },
      { titulo: 'Iniciado em' }, { titulo: 'Até' }, { titulo: 'Próxima' },
    ],
    linha: (j) => html`
      <tr data-id="${j.organizationId}">
        <td class="principal mono">${j.job}</td>
        <td>${vazio(j.organizationNome)}</td>
        <td>${j.ocupado ? selo('ocupado', 'info') : selo('livre')}</td>
        <td class="secundario">${dataHora(j.iniciadoEm)}</td>
        <td class="secundario">${dataHora(j.ate)}</td>
        <td class="secundario">${dataHora(j.proximaEm)} <span class="secundario">${j.proximaEm ? `(${relativo(j.proximaEm)})` : ''}</span></td>
      </tr>`,
    vazioTitulo: 'Nenhum job registrado.',
    vazioDetalhe: 'A tabela de leases só ganha linhas quando um scheduler roda.',
    aoClicarLinha: (id) => (id ? navegar(`/organizations/${id}`) : null),
  }),

  webhooks: (ler, navegar) => ({
    buscar: (cursor) => api.webhooks({
      organizationId: ler('organizationId'), verificado: ler('verificado'), cursor, limit: 50,
    }),
    colunas: [
      { titulo: 'Recebido em' }, { titulo: 'Evento' }, { titulo: 'Organization' },
      { titulo: 'Verificado' }, { titulo: 'Método de autenticação' },
    ],
    linha: (w) => html`
      <tr data-id="${w.organizationId || ''}">
        <td class="secundario">${dataHora(w.recebidoEm)}</td>
        <td class="principal mono">${vazio(w.eventName)}</td>
        <td>${vazio(w.organizationNome)}</td>
        <td>${w.verificado ? selo('verificado', 'ok') : selo('não verificado', 'alerta')}</td>
        <td class="secundario mono">${vazio(w.metodoAuth)}</td>
      </tr>`,
    vazioTitulo: 'Nenhum webhook recebido.',
    vazioDetalhe: 'Webhooks aparecem aqui assim que chegarem, verificados ou não.',
    aoClicarLinha: (id) => (id ? navegar(`/organizations/${id}`) : null),
  }),

  audit: (ler) => ({
    buscar: (cursor) => api.audit({
      action: ler('action'), organizationId: ler('organizationId'), cursor, limit: 50,
    }),
    colunas: [
      { titulo: 'Quando' }, { titulo: 'Ação' }, { titulo: 'Ator' },
      { titulo: 'Entidade' }, { titulo: 'Organization' }, { titulo: '', classe: 'acoes' },
    ],
    linha: (r) => html`
      <tr>
        <td class="secundario">${dataHora(r.criadoEm)}</td>
        <td><span class="selo ${cru(tomDaAcao(r.action))}">${r.action}</span></td>
        <td class="secundario">${r.actor ? r.actor.email : '—'}</td>
        <td><div class="principal mono">${r.entityType}</div><div class="secundario mono">${vazio(r.entityId)}</div></td>
        <td>${vazio(r.organizationNome)}</td>
        <td class="acoes">
          <button type="button" class="btn btn-fantasma btn-pequeno" data-audit="${JSON.stringify(r)}">Ver</button>
        </td>
      </tr>`,
    vazioTitulo: 'Nenhum registro de auditoria.',
    vazioDetalhe: 'Com os filtros atuais nada foi registrado. A auditoria grava na mesma transação da mutação.',
  }),
};

function tomDaAcao(acao) {
  if (!acao) return '';
  if (acao.endsWith('_failed') || acao.includes('suspended') || acao.includes('revoked')
      || acao.includes('removed') || acao.includes('deactivated') || acao.includes('archived')) return 'critico';
  if (acao.includes('created') || acao.includes('reactivated') || acao.includes('issued')) return 'ok';
  if (acao.includes('changed') || acao.includes('updated') || acao.includes('override')
      || acao.includes('replaced') || acao.includes('reissued') || acao.includes('role')) return 'alerta';
  return 'info';
}

function abrirDetalheDeAuditoria(registro) {
  const bloco = (titulo, valor) => html`
    <div>
      <div style="font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">${titulo}</div>
      ${valor === null || valor === undefined
        ? html`<div class="vazio" style="padding:12px"><span>sem dado</span></div>`
        : html`<pre class="mono-bloco">${JSON.stringify(valor, null, 2)}</pre>`}
    </div>`;

  abrirDrawer({
    titulo: registro.action,
    descricao: `Registro ${registro.id}`,
    corpo: html`
      <div class="definicoes">
        <div class="definicao"><div class="termo">Quando</div><div class="valor">${dataHora(registro.criadoEm)}</div></div>
        <div class="definicao"><div class="termo">Ator</div><div class="valor">${registro.actor ? registro.actor.email : '—'}</div></div>
        <div class="definicao"><div class="termo">Entidade</div><div class="valor mono">${registro.entityType}${registro.entityId ? ` · ${registro.entityId}` : ''}</div></div>
        <div class="definicao"><div class="termo">Organization</div><div class="valor">${vazio(registro.organizationNome)}</div></div>
      </div>
      ${cru(bloco('Antes', registro.before))}
      ${cru(bloco('Depois', registro.after))}
      ${cru(avisoCaixa('info', 'Segredo nunca entra aqui.',
        'Antes de gravar, o sanitizador recusa qualquer chave que cheire a credencial — com erro, não com redação silenciosa.'))}`,
    rodape: html`<button type="button" class="btn btn-secundario" data-fechar>Fechar</button>`,
  });
}
