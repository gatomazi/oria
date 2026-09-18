// Detalhe de uma organization — a bancada de operação do tenant.
//
// O alvo é SEMPRE o `:organizationId` da rota (§2 do contrato). Nenhuma mutação daqui manda
// organization no corpo: o backend recusaria com 400 `organization_no_corpo`, e com razão.
//
// A aba de entitlements existe para tornar a PRECEDÊNCIA visível, que é o ponto do §7:
// override da organization > feature do plano > false. O campo `entitlements.origem` da API é a
// fonte — a UI não recalcula nada.

import * as api from '../api.js';
import {
  html, cru, icone, dataHora, relativo, vazio, selo, seloStatus, seloConvite, seloIntegracao,
  seloOnboarding, avisar, abrirDrawer, rodapeDrawer, erroNoDrawer, copiar, avisoCaixa,
  caixaDeErro, carregando, numeroOuNulo,
} from '../ui.js';
import { ROTULO_FEATURE, ROTULO_ORIGEM, ROTULO_PASSO, ROTULO_REQUISITO, FEATURES } from '../vocabulario.js';

const ABAS = [
  { id: 'resumo', rotulo: 'Resumo' },
  { id: 'entitlements', rotulo: 'Entitlements' },
  { id: 'convites', rotulo: 'Convites' },
  { id: 'membros', rotulo: 'Membros' },
  { id: 'onboarding', rotulo: 'Onboarding' },
  { id: 'integracoes', rotulo: 'Integrações' },
  { id: 'assinatura', rotulo: 'Assinatura' },
];

export async function renderizar(alvo, { params, busca, navegar }) {
  const id = params.organizationId;
  let abaAtual = ABAS.some((a) => a.id === busca.get('aba')) ? busca.get('aba') : 'resumo';

  alvo.innerHTML = html`<div class="pagina">${cru(carregando('Carregando a organization…'))}</div>`;

  let detalhe;
  try {
    detalhe = await api.organizations.detalhe(id);
  } catch (err) {
    alvo.innerHTML = html`
      <div class="pagina">
        <div class="migalha"><a data-rota href="/organizations">${cru(icone('volta', 14))} Organizations</a></div>
        ${cru(caixaDeErro(err))}
      </div>`;
    return;
  }

  const recarregar = () => renderizar(alvo, { params, busca: new URLSearchParams(`aba=${abaAtual}`), navegar });

  alvo.innerHTML = html`
    <div class="pagina">
      <div class="migalha">
        <a data-rota href="/organizations">${cru(icone('volta', 14))} Organizations</a>
        <span>/</span>
        <span>${detalhe.nome}</span>
      </div>

      <div class="cabecalho-pagina">
        <div>
          <h1>${detalhe.nome} ${seloStatus(detalhe.status)}</h1>
          <p class="sub">
            <span class="mono">${detalhe.id}</span>
            · criada em ${dataHora(detalhe.criadoEm)}
          </p>
        </div>
        <div class="acoes">
          ${detalhe.status === 'active'
            ? html`<button type="button" class="btn btn-perigo" data-suspender>Suspender</button>`
            : html`<button type="button" class="btn btn-primario" data-reativar>Reativar</button>`}
          <button type="button" class="btn btn-secundario" data-trocar-plano>Trocar plano</button>
          <button type="button" class="btn btn-secundario" data-convidar>${cru(icone('mais', 16))}Emitir convite</button>
        </div>
      </div>

      ${detalhe.status === 'suspended' ? cru(avisoCaixa('critico', 'Organization suspensa.',
        html`Todas as features são negadas, o tenant perde login e seleção de workspace, e os jobs deixam de rodar.
             Os dados permanecem. ${detalhe.suspensao ? html`Suspensa em ${dataHora(detalhe.suspensao.suspensaEm)} por
             <strong>${detalhe.suspensao.por}</strong>${detalhe.suspensao.motivo ? html` — “${detalhe.suspensao.motivo}”` : ''}.` : ''}`)) : ''}

      ${!detalhe.subscription ? cru(avisoCaixa('alerta', 'Sem assinatura ativa.',
        'Ausência nega: sem assinatura ativa, todas as features ficam negadas, mesmo com override permitindo.')) : ''}

      <div class="abas" role="tablist">
        ${cru(ABAS.map((a) => html`
          <button type="button" class="aba" role="tab" data-aba="${a.id}"
                  aria-selected="${a.id === abaAtual ? 'true' : 'false'}">${a.rotulo}</button>`).join(''))}
      </div>
      <div data-painel></div>
    </div>`;

  const painel = alvo.querySelector('[data-painel]');

  function pintarAba() {
    for (const botao of alvo.querySelectorAll('[data-aba]')) {
      botao.setAttribute('aria-selected', String(botao.dataset.aba === abaAtual));
    }
    painel.innerHTML = PAINEIS[abaAtual](detalhe);
    ligarAcoesDoPainel(painel, detalhe, recarregar, navegar);
  }

  for (const botao of alvo.querySelectorAll('[data-aba]')) {
    botao.addEventListener('click', () => {
      abaAtual = botao.dataset.aba;
      window.history.replaceState({}, '', `/organizations/${id}?aba=${abaAtual}`);
      pintarAba();
    });
  }

  alvo.querySelector('[data-suspender]')?.addEventListener('click', () => suspender(detalhe, recarregar));
  alvo.querySelector('[data-reativar]')?.addEventListener('click', () => reativar(detalhe, recarregar));
  alvo.querySelector('[data-trocar-plano]').addEventListener('click', () => trocarPlano(detalhe, recarregar));
  alvo.querySelector('[data-convidar]').addEventListener('click', () => emitirConvite(detalhe, recarregar));

  pintarAba();
}

// ── Painéis ───────────────────────────────────────────────────────────────────────────────

const definicao = (termo, valor) => html`
  <div class="definicao"><div class="termo">${termo}</div><div class="valor">${valor}</div></div>`;

const PAINEIS = {
  resumo: (d) => html`
    <div class="grade duas">
      <section class="cartao">
        <header><h2>Organization</h2></header>
        <div class="definicoes">
          ${cru(definicao('Identificador', html`<span class="mono">${d.id}</span>`))}
          ${cru(definicao('Status', seloStatus(d.status)))}
          ${cru(definicao('Criada em', dataHora(d.criadoEm)))}
          ${cru(definicao('Owners ativos', d.owners.filter((o) => o.status === 'active').length))}
        </div>
      </section>

      <section class="cartao">
        <header><h2>Loja</h2></header>
        ${d.store ? html`
          <div class="definicoes">
            ${cru(definicao('Nome', d.store.nome))}
            ${cru(definicao('Identificador', html`<span class="mono">${d.store.id}</span>`))}
            ${cru(definicao('Ativa', d.store.ativa ? selo('sim', 'ok') : selo('não', 'critico')))}
            ${cru(definicao('Loja legada', vazio(d.store.lojaLegada)))}
          </div>`
        : html`<div class="vazio"><strong>Sem loja vinculada.</strong></div>`}
      </section>

      <section class="cartao">
        <header><h2>Assinatura</h2><span class="dica">Uma ativa por organization</span></header>
        ${d.subscription ? html`
          <div class="definicoes">
            ${cru(definicao('Plano', html`<strong>${d.plano ? d.plano.nome : '—'}</strong> <span class="mono">${d.plano ? d.plano.chave : ''}</span>`))}
            ${cru(definicao('Status', selo(d.subscription.status, d.subscription.status === 'active' ? 'ok' : '')))}
            ${cru(definicao('Iniciada em', dataHora(d.subscription.iniciadaEm)))}
          </div>`
        : html`<div class="vazio"><strong>Sem assinatura ativa.</strong><span>Use "Trocar plano" para criar uma.</span></div>`}
      </section>

      <section class="cartao">
        <header><h2>Onboarding</h2></header>
        ${d.onboarding ? html`
          <div class="definicoes">
            ${cru(definicao('Status', seloOnboarding(d.onboarding.status)))}
            ${cru(definicao('Próximo passo', vazio(d.onboarding.proximoPasso)))}
            ${cru(definicao('Passo bloqueado', vazio(d.onboarding.passoBloqueado)))}
            ${cru(definicao('Atualizado em', dataHora(d.onboarding.atualizadoEm)))}
          </div>`
        : html`<div class="vazio"><strong>Sem onboarding.</strong><span>Organization legada, criada antes do fluxo de onboarding.</span></div>`}
      </section>
    </div>`,

  entitlements: (d) => {
    const efetivos = d.entitlements.efetivos || {};
    const origem = d.entitlements.origem || {};
    const chaves = FEATURES.filter((f) => f in efetivos).concat(Object.keys(efetivos).filter((f) => !FEATURES.includes(f)));
    return html`
      <div class="pagina" style="gap:16px">
        ${cru(avisoCaixa('info', 'Precedência.',
          html`<code>override da organization</code> &gt; <code>feature do plano</code> &gt; <code>false</code>.
               Organization suspensa ou sem assinatura ativa nega tudo, inclusive o que o override concede.`))}
        <section class="cartao">
          <header>
            <h2>Acesso efetivo</h2>
            <span class="dica">${chaves.length} features no vocabulário</span>
          </header>
          <div class="entitlements">
            ${cru(chaves.map((f) => html`
              <div class="entitlement">
                <div style="min-width:0">
                  <div class="nome">${ROTULO_FEATURE[f] || f}</div>
                  <div class="origem"><span class="mono">${f}</span> · ${ROTULO_ORIGEM[origem[f]] || origem[f] || '—'}</div>
                </div>
                <div class="direita">
                  ${efetivos[f] ? selo('liberada', 'ok') : selo('negada', 'critico')}
                  <button type="button" class="btn btn-fantasma btn-pequeno" data-override="${f}">Override</button>
                  ${origem[f] === 'override'
                    ? html`<button type="button" class="btn btn-fantasma btn-pequeno" data-remover-override="${f}">Remover</button>`
                    : ''}
                </div>
              </div>`).join(''))}
          </div>
        </section>

        <section class="cartao">
          <header><h2>Overrides gravados</h2><span class="dica">O que difere do plano</span></header>
          ${(d.overrides && d.overrides.length) ? html`
            <div class="tabela-rolagem">
              <table class="tabela">
                <thead><tr><th>Feature</th><th>Decisão</th><th>Motivo</th><th>Criado em</th></tr></thead>
                <tbody>
                  ${cru(d.overrides.map((o) => html`
                    <tr>
                      <td class="mono">${o.feature}</td>
                      <td>${o.permitido ? selo('concede', 'ok') : selo('nega', 'critico')}</td>
                      <td class="secundario">${vazio(o.motivo)}</td>
                      <td class="secundario">${dataHora(o.criadoEm)}</td>
                    </tr>`).join(''))}
                </tbody>
              </table>
            </div>`
          : html`<div class="vazio"><strong>Nenhum override.</strong><span>Todas as features vêm do plano.</span></div>`}
        </section>
      </div>`;
  },

  convites: (d) => html`
    <section class="cartao">
      <header>
        <h2>Convites de owner</h2>
        <span class="dica">O token nunca é recuperável depois da emissão</span>
      </header>
      ${cru(avisoCaixa('info', 'O aceite é do painel do lojista.',
        'Esta versão do control plane emite, reemite e revoga. A rota que consome o convite e cria a associação pertence ao tenant plane e ainda não existe — até lá o convite não pode ser aceito pela interface.'))}
      ${(d.convites && d.convites.length) ? html`
        <div class="tabela-rolagem" style="margin-top:12px">
          <table class="tabela">
            <thead><tr><th>E-mail</th><th>Papel</th><th>Estado</th><th>Criado</th><th>Expira</th><th class="acoes">Ações</th></tr></thead>
            <tbody>
              ${cru(d.convites.map((c) => html`
                <tr>
                  <td class="principal">${c.email}</td>
                  <td>${c.papel}</td>
                  <td>${seloConvite(c.estado)}</td>
                  <td class="secundario">${dataHora(c.criadoEm)}</td>
                  <td class="secundario">${dataHora(c.expiraEm)} <span class="secundario">(${relativo(c.expiraEm)})</span></td>
                  <td class="acoes">
                    ${c.estado === 'pendente' || c.estado === 'expirado'
                      ? html`<button type="button" class="btn btn-secundario btn-pequeno" data-reemitir="${c.id}">Reemitir</button>` : ''}
                    ${c.estado === 'pendente'
                      ? html`<button type="button" class="btn btn-perigo btn-pequeno" data-revogar="${c.id}">Revogar</button>` : ''}
                  </td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>`
      : html`<div class="vazio" style="margin-top:12px"><strong>Nenhum convite emitido.</strong>
             <span>Use "Emitir convite" no topo da página.</span></div>`}
    </section>`,

  membros: (d) => html`
    <section class="cartao">
      <header><h2>Membros</h2><span class="dica">Pessoas entram por convite, nunca por cadastro daqui</span></header>
      ${(d.membros && d.membros.length) ? html`
        <div class="tabela-rolagem">
          <table class="tabela">
            <thead><tr><th>Pessoa</th><th>Papel</th><th>Status</th><th>Desde</th><th class="acoes">Ações</th></tr></thead>
            <tbody>
              ${cru(d.membros.map((m) => html`
                <tr>
                  <td>
                    <div class="principal">${m.nome || m.email}</div>
                    <div class="secundario">${m.email}</div>
                  </td>
                  <td>${m.papel === 'owner' ? selo('owner', 'premium') : selo(m.papel)}</td>
                  <td>${seloStatus(m.status)}</td>
                  <td class="secundario">${dataHora(m.desde)}</td>
                  <td class="acoes">
                    <button type="button" class="btn btn-perigo btn-pequeno"
                            data-remover-membro="${m.userId}" data-membro-nome="${m.email}">Remover</button>
                  </td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>`
      : html`<div class="vazio"><strong>Nenhum membro ainda.</strong>
             <span>O owner aparece aqui depois de aceitar o convite no painel do lojista.</span></div>`}
    </section>`,

  onboarding: (d) => {
    if (!d.onboarding) {
      return html`<section class="cartao"><div class="vazio"><strong>Sem onboarding.</strong>
        <span>Esta organization não passou pelo fluxo de onboarding.</span></div></section>`;
    }
    return html`
      <section class="cartao">
        <header>
          <h2>Passos ${seloOnboarding(d.onboarding.status)}</h2>
          <span class="dica">Estado derivado do fato — não há como marcar passo à mão</span>
        </header>
        ${d.onboarding.passoBloqueado ? cru(avisoCaixa('critico', 'Passo bloqueado.',
          html`<code>${d.onboarding.passoBloqueado}</code>${d.onboarding.lastErrorCode ? html` · último código: <code>${d.onboarding.lastErrorCode}</code>` : ''}`)) : ''}
        <div class="tabela-rolagem" style="margin-top:12px">
          <table class="tabela">
            <thead><tr><th>Passo</th><th>Requisito</th><th>Status</th><th>Último erro</th><th class="num">Tentativas</th><th>Concluído em</th></tr></thead>
            <tbody>
              ${cru(d.onboarding.passos.map((p) => html`
                <tr>
                  <td>
                    <div class="principal">${ROTULO_PASSO[p.id] || p.id}</div>
                    <div class="secundario mono">${p.id}</div>
                  </td>
                  <td>${selo(ROTULO_REQUISITO[p.requirement] || p.requirement, p.requirement === 'required' ? 'info' : '')}</td>
                  <td>${p.status === 'complete' ? selo('completo', 'ok')
                        : p.status === 'blocked' ? selo('bloqueado', 'critico') : selo(p.status || 'pendente')}</td>
                  <td class="secundario">${vazio(p.lastErrorCode)}</td>
                  <td class="num">${p.tentativas ?? 0}</td>
                  <td class="secundario">${dataHora(p.completedAt)}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </section>`;
  },

  integracoes: (d) => html`
    <section class="cartao">
      <header><h2>Integrações</h2><span class="dica">Sem token, sem config, sem id de conta externa</span></header>
      ${cru(avisoCaixa('info', 'Último teste e último sucesso não existem como dado.',
        'A tabela de integrações não tem essas colunas. Em vez de derivar um valor de "atualizado em", a API devolve null — e a tela mostra vazio. O disparo de teste pelo Admin está fora desta versão, por isso não há botão.'))}
      ${(d.integracoes && d.integracoes.length) ? html`
        <div class="tabela-rolagem" style="margin-top:12px">
          <table class="tabela">
            <thead><tr><th>Provider</th><th>Status</th><th>Nome exibido</th><th class="num">Segredos válidos</th><th class="num">Vencidos</th><th>Último erro</th><th>Atualizado em</th></tr></thead>
            <tbody>
              ${cru(d.integracoes.map((i) => html`
                <tr>
                  <td class="principal mono">${i.provider}</td>
                  <td>${seloIntegracao(i.status)}</td>
                  <td class="secundario">${vazio(i.displayName)}</td>
                  <td class="num">${i.segredosValidos ?? 0}</td>
                  <td class="num">${i.segredosVencidos ?? 0}</td>
                  <td class="secundario">${vazio(i.lastErrorCode)}</td>
                  <td class="secundario">${dataHora(i.atualizadoEm)}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>`
      : html`<div class="vazio" style="margin-top:12px"><strong>Nenhuma integração conectada.</strong>
             <span>As conexões são feitas pelo lojista, no painel.</span></div>`}
    </section>`,

  assinatura: () => html`<div data-assinatura>${carregando('Carregando o histórico de assinaturas…')}</div>`,
};

// ── Ações ─────────────────────────────────────────────────────────────────────────────────

function ligarAcoesDoPainel(painel, detalhe, recarregar) {
  for (const botao of painel.querySelectorAll('[data-override]')) {
    botao.addEventListener('click', () => definirOverride(detalhe, botao.dataset.override, recarregar));
  }
  for (const botao of painel.querySelectorAll('[data-remover-override]')) {
    botao.addEventListener('click', () => removerOverride(detalhe, botao.dataset.removerOverride, recarregar));
  }
  for (const botao of painel.querySelectorAll('[data-reemitir]')) {
    botao.addEventListener('click', () => reemitirConvite(detalhe, botao.dataset.reemitir, recarregar));
  }
  for (const botao of painel.querySelectorAll('[data-revogar]')) {
    botao.addEventListener('click', () => revogarConvite(detalhe, botao.dataset.revogar, recarregar));
  }
  for (const botao of painel.querySelectorAll('[data-remover-membro]')) {
    botao.addEventListener('click', () => removerMembro(detalhe, botao.dataset.removerMembro, botao.dataset.membroNome, recarregar));
  }
  const caixaAssinatura = painel.querySelector('[data-assinatura]');
  if (caixaAssinatura) carregarAssinatura(caixaAssinatura, detalhe);
}

async function carregarAssinatura(alvo, detalhe) {
  let dados;
  try {
    dados = await api.organizations.assinatura(detalhe.id);
  } catch (err) {
    alvo.innerHTML = caixaDeErro(err);
    return;
  }
  alvo.innerHTML = html`
    <section class="cartao">
      <header><h2>Assinatura atual</h2><span class="dica">Trocar de plano cancela a ativa e cria a nova na mesma transação</span></header>
      ${dados.subscription ? html`
        <div class="definicoes">
          ${cru(definicao('Plano', html`<strong>${dados.plano ? dados.plano.nome : '—'}</strong> <span class="mono">${dados.plano ? dados.plano.chave : ''}</span>`))}
          ${cru(definicao('Status', selo(dados.subscription.status, 'ok')))}
          ${cru(definicao('Iniciada em', dataHora(dados.subscription.iniciadaEm)))}
        </div>`
      : html`<div class="vazio"><strong>Sem assinatura ativa.</strong></div>`}
    </section>

    <section class="cartao" style="margin-top:16px">
      <header><h2>Histórico</h2><span class="dica">Arquivar plano não apaga histórico</span></header>
      ${(dados.historico && dados.historico.length) ? html`
        <div class="tabela-rolagem">
          <table class="tabela">
            <thead><tr><th>Plano</th><th>Status</th><th>Iniciada</th><th>Cancelada</th><th>Motivo</th></tr></thead>
            <tbody>
              ${cru(dados.historico.map((h) => html`
                <tr>
                  <td><div class="principal">${h.plano.nome}</div><div class="secundario mono">${h.plano.chave}</div></td>
                  <td>${selo(h.status, h.status === 'active' ? 'ok' : '')}</td>
                  <td class="secundario">${dataHora(h.iniciadaEm)}</td>
                  <td class="secundario">${dataHora(h.canceladaEm)}</td>
                  <td class="secundario">${vazio(h.motivoCancelamento)}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>`
      : html`<div class="vazio"><strong>Sem histórico.</strong></div>`}
    </section>`;
}

async function suspender(detalhe, recarregar) {
  const feito = await abrirDrawer({
    titulo: 'Suspender organization',
    descricao: detalhe.nome,
    corpo: html`
      ${cru(avisoCaixa('critico', 'A suspensão tem efeito real.',
        'O tenant perde login e seleção de workspace, todas as features são negadas, os jobs param. Os dados permanecem e reativar restaura.'))}
      <div class="campo">
        <label for="motivo-suspensao">Motivo</label>
        <textarea id="motivo-suspensao" name="motivo" required minlength="4" maxlength="500"
                  placeholder="Fica registrado na auditoria."></textarea>
        <span class="ajuda">De 4 a 500 caracteres.</span>
      </div>`,
    rodape: rodapeDrawer('Suspender', 'btn-perigo-solido'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.organizations.suspender(detalhe.id, formulario.elements.motivo.value.trim());
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Organization suspensa.'); recarregar(); }
}

async function reativar(detalhe, recarregar) {
  const feito = await abrirDrawer({
    titulo: 'Reativar organization',
    descricao: detalhe.nome,
    corpo: html`
      ${cru(avisoCaixa('info', 'Reativar restaura o acesso.',
        'As features voltam a valer conforme o plano e os overrides. Nada foi apagado durante a suspensão.'))}
      <div class="campo">
        <label for="motivo-reativacao">Motivo (opcional)</label>
        <textarea id="motivo-reativacao" name="motivo" maxlength="500"></textarea>
      </div>`,
    rodape: rodapeDrawer('Reativar'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.organizations.reativar(detalhe.id, formulario.elements.motivo.value.trim());
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Organization reativada.'); recarregar(); }
}

async function trocarPlano(detalhe, recarregar) {
  let planos = [];
  try {
    const resposta = await api.plans.listar({ limit: 200 });
    planos = (resposta.itens || []).filter((p) => p.status === 'active');
  } catch { planos = []; }

  const atual = detalhe.plano ? detalhe.plano.chave : null;
  const feito = await abrirDrawer({
    titulo: 'Trocar plano',
    descricao: detalhe.nome,
    corpo: html`
      <div class="campo">
        <label for="novo-plano">Plano</label>
        <select id="novo-plano" name="planoChave" required>
          ${planos.length
            ? cru(planos.map((p) => html`<option value="${p.chave}"${p.chave === atual ? ' selected' : ''}>${p.nome} · ${p.chave}${p.chave === atual ? ' (atual)' : ''}</option>`).join(''))
            : html`<option value="">nenhum plano ativo</option>`}
        </select>
        <span class="ajuda">Plano arquivado não aceita assinatura nova. Trocar para o mesmo plano não muda nada.</span>
      </div>
      <div class="campo">
        <label for="motivo-plano">Motivo (opcional)</label>
        <textarea id="motivo-plano" name="motivo" maxlength="500"></textarea>
      </div>`,
    rodape: rodapeDrawer('Trocar plano'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.organizations.trocarPlano(
          detalhe.id, formulario.elements.planoChave.value, formulario.elements.motivo.value.trim()
        );
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Assinatura atualizada.'); recarregar(); }
}

async function definirOverride(detalhe, feature, recarregar) {
  const origem = (detalhe.entitlements.origem || {})[feature];
  const atual = (detalhe.entitlements.efetivos || {})[feature];
  const feito = await abrirDrawer({
    titulo: `Override · ${ROTULO_FEATURE[feature] || feature}`,
    descricao: detalhe.nome,
    corpo: html`
      ${cru(avisoCaixa('info', 'Override vence o plano.',
        html`Hoje a feature <code>${feature}</code> está <strong>${atual ? 'liberada' : 'negada'}</strong>
             por <strong>${ROTULO_ORIGEM[origem] || origem || '—'}</strong>. Um override com “negar” nega mesmo que o plano conceda.`))}
      <div class="campo">
        <label for="override-decisao">Decisão</label>
        <select id="override-decisao" name="permitido">
          <option value="true">Conceder</option>
          <option value="false">Negar</option>
        </select>
      </div>
      <div class="campo">
        <label for="override-motivo">Motivo</label>
        <textarea id="override-motivo" name="motivo" maxlength="500" placeholder="Fica na auditoria."></textarea>
      </div>`,
    rodape: rodapeDrawer('Gravar override'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.organizations.definirOverride(
          detalhe.id, feature,
          formulario.elements.permitido.value === 'true',
          formulario.elements.motivo.value.trim()
        );
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Override gravado.'); recarregar(); }
}

async function removerOverride(detalhe, feature, recarregar) {
  const feito = await abrirDrawer({
    titulo: `Remover override · ${feature}`,
    descricao: detalhe.nome,
    corpo: cru(avisoCaixa('info', 'Remover devolve a decisão ao plano.',
      'A feature volta a herdar do plano da assinatura ativa — não volta a "negada" por acidente.')),
    rodape: rodapeDrawer('Remover override', 'btn-perigo'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.organizations.removerOverride(detalhe.id, feature);
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Override removido.'); recarregar(); }
}

async function emitirConvite(detalhe, recarregar) {
  const resultado = await abrirDrawer({
    titulo: 'Emitir convite',
    descricao: detalhe.nome,
    corpo: html`
      <div class="campo">
        <label for="convite-email">E-mail</label>
        <input id="convite-email" name="email" type="email" required autocapitalize="none" spellcheck="false">
        <span class="ajuda">Só pode haver um convite pendente por e-mail nesta organization.</span>
      </div>
      <div class="campo">
        <label for="convite-papel">Papel</label>
        <select id="convite-papel" name="papel">
          <option value="owner" selected>owner</option>
          <option value="member">member</option>
        </select>
      </div>
      <div class="campo">
        <label for="convite-validade">Validade (horas)</label>
        <input id="convite-validade" name="validadeHoras" type="number" min="1" max="168" value="72">
      </div>`,
    rodape: rodapeDrawer('Emitir convite'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.organizations.emitirConvite(detalhe.id, {
          email: formulario.elements.email.value.trim(),
          papel: formulario.elements.papel.value,
          validadeHoras: numeroOuNulo(formulario.elements.validadeHoras.value),
        });
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (!resultado) return;
  await mostrarToken(resultado, 'Convite emitido');
  recarregar();
}

async function reemitirConvite(detalhe, inviteId, recarregar) {
  const resultado = await abrirDrawer({
    titulo: 'Reemitir convite',
    descricao: 'O convite anterior é revogado e outro é emitido, na mesma transação.',
    corpo: html`
      ${cru(avisoCaixa('alerta', 'O token antigo deixa de valer.',
        'Reemitir não estende a validade: revoga e emite outro. Quem já tiver o token anterior perde o acesso ao convite.'))}
      <div class="campo">
        <label for="reemitir-validade">Validade (horas)</label>
        <input id="reemitir-validade" name="validadeHoras" type="number" min="1" max="168" value="72">
      </div>`,
    rodape: rodapeDrawer('Reemitir'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.organizations.reemitirConvite(
          detalhe.id, inviteId, numeroOuNulo(formulario.elements.validadeHoras.value)
        );
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (!resultado) return;
  await mostrarToken(resultado, 'Convite reemitido');
  recarregar();
}

async function revogarConvite(detalhe, inviteId, recarregar) {
  const feito = await abrirDrawer({
    titulo: 'Revogar convite',
    descricao: detalhe.nome,
    corpo: html`
      ${cru(avisoCaixa('alerta', 'A organization nunca pode ficar sem caminho para um owner.',
        'Se este for o único caminho — sem owner ativo e sem outro convite de owner pendente — o servidor recusa com 409 ultimo_owner.'))}
      <div class="campo">
        <label for="revogar-motivo">Motivo (opcional)</label>
        <textarea id="revogar-motivo" name="motivo" maxlength="500"></textarea>
      </div>`,
    rodape: rodapeDrawer('Revogar', 'btn-perigo-solido'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.organizations.revogarConvite(detalhe.id, inviteId, formulario.elements.motivo.value.trim());
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Convite revogado.'); recarregar(); }
}

async function removerMembro(detalhe, userId, rotulo, recarregar) {
  const feito = await abrirDrawer({
    titulo: 'Remover membro',
    descricao: rotulo,
    corpo: cru(avisoCaixa('critico', 'Remover o último owner ativo é recusado.',
      'A checagem acontece dentro da transação, sob o contexto da organization. A pessoa perde o acesso a este tenant; a conta dela continua existindo.')),
    rodape: rodapeDrawer('Remover membro', 'btn-perigo-solido'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        await api.organizations.removerMembro(detalhe.id, userId);
        return true;
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Membro removido.'); recarregar(); }
}

// Token do convite: uma aparição, com cópia e aviso. Nunca vai para URL, título ou log.
async function mostrarToken(convite, titulo) {
  if (!convite || !convite.token) return;
  await abrirDrawer({
    titulo,
    descricao: 'Copie agora — esta é a única exibição.',
    corpo: html`
      ${cru(avisoCaixa('critico', 'O token não é recuperável.',
        'No banco fica apenas o resumo criptográfico. Se o token se perder, o caminho é reemitir o convite, o que invalida este.'))}
      <div class="campo">
        <label for="token-emitido">Token para ${convite.email}</label>
        <input id="token-emitido" class="mono" type="text" readonly value="${convite.token}">
        <span class="ajuda">Expira em ${dataHora(convite.expiraEm)} · papel ${convite.papel}</span>
        <div><button type="button" class="btn btn-secundario btn-pequeno" data-copiar>${cru(icone('copiar', 14))}Copiar token</button></div>
      </div>
      ${cru(avisoCaixa('info', 'Sem tela de aceite, ainda.',
        'O aceite pertence ao painel do lojista. Entregue o token ao owner por um canal seguro; a entrada dele acontece lá, não aqui.'))}`,
    rodape: html`<button type="button" class="btn btn-primario" data-fechar>Já copiei</button>`,
    aoMontar: (fundo) => {
      fundo.querySelector('[data-copiar]').addEventListener('click', async () => {
        const campo = fundo.querySelector('#token-emitido');
        const ok = await copiar(campo.value);
        if (ok) { avisar('Token copiado. Ele não será exibido de novo.'); return; }
        campo.focus();
        campo.select();
        avisar('Não foi possível copiar automaticamente. O token está selecionado: copie à mão.', 'aviso');
      });
    },
  });
}
