// Visão geral — `GET /api/platform/overview`.
//
// Só mostra o que a rota devolve. Zero é zero: não há gráfico inventado, não há "variação vs. mês
// anterior" (a API não tem série temporal) e não há métrica derivada que o backend não calcule.

import * as api from '../api.js';
import { html, cru, icone, caixaDeErro, carregando, avisoCaixa } from '../ui.js';

function kpi(rotulo, valor, detalhe = '') {
  return html`
    <div class="kpi">
      <div class="rotulo">${rotulo}</div>
      <div class="valor">${valor}</div>
      ${detalhe ? html`<div class="detalhe">${cru(detalhe)}</div>` : ''}
    </div>`;
}

const parte = (texto, tom = '') => html`<span class="selo ${cru(tom)}">${texto}</span>`;

export async function renderizar(alvo) {
  alvo.innerHTML = html`<div class="pagina">${cru(carregando('Carregando a visão geral…'))}</div>`;

  let dados;
  try {
    dados = await api.overview();
  } catch (err) {
    alvo.innerHTML = html`<div class="pagina">${cru(caixaDeErro(err))}</div>`;
    return;
  }

  const semOrganizacao = dados.organizations.total === 0;

  const chamada = semOrganizacao
    ? avisoCaixa(
      'info',
      'Nenhuma organização ainda.',
      html`O <strong>bootstrap interno</strong> ${dados.bootstrapInternoDisponivel ? 'está disponível' : 'não está disponível'}
           — ele só existe enquanto não houver nenhuma organização, e é o caminho do Tenant #1.`
    )
    : '';

  const gate = dados.secondTenantEnabled
    ? avisoCaixa('alerta', 'Criação externa liberada.',
      'SECOND_TENANT_ENABLED=1: novas organizações podem ser criadas fora do bootstrap interno.')
    : avisoCaixa('info', 'Criação externa desligada.',
      html`Com <code>SECOND_TENANT_ENABLED=0</code>, criar organização só é possível pelo bootstrap
           interno, e apenas enquanto não existir nenhuma.`);

  alvo.innerHTML = html`
    <div class="pagina">
      <div class="cabecalho-pagina">
        <div>
          <h1>Visão geral</h1>
          <p class="sub">Estado factual da plataforma, direto dos read models do control plane.</p>
        </div>
        <div class="acoes">
          ${dados.bootstrapInternoDisponivel || dados.secondTenantEnabled
            ? html`<a class="btn btn-primario" data-rota href="/organizations?criar=1">${cru(icone('mais', 16))}Criar organization</a>`
            : ''}
          <a class="btn btn-secundario" data-rota href="/audit">${cru(icone('lista', 16))}Auditoria</a>
        </div>
      </div>

      ${cru(chamada)}

      <div class="grade kpis">
        ${cru(kpi('Organizations', dados.organizations.total, [
          parte(`${dados.organizations.ativas} ativas`, dados.organizations.ativas ? 'ok' : ''),
          parte(`${dados.organizations.suspensas} suspensas`, dados.organizations.suspensas ? 'critico' : ''),
        ].join('')))}
        ${cru(kpi('Onboardings', dados.onboardings.emAndamento + dados.onboardings.bloqueados + dados.onboardings.concluidos, [
          parte(`${dados.onboardings.emAndamento} em andamento`, dados.onboardings.emAndamento ? 'info' : ''),
          parte(`${dados.onboardings.bloqueados} bloqueados`, dados.onboardings.bloqueados ? 'critico' : ''),
          parte(`${dados.onboardings.concluidos} concluídos`, dados.onboardings.concluidos ? 'ok' : ''),
        ].join('')))}
        ${cru(kpi('Convites', dados.convites.pendentes + dados.convites.expirados, [
          parte(`${dados.convites.pendentes} pendentes`, dados.convites.pendentes ? 'alerta' : ''),
          parte(`${dados.convites.expirados} expirados`),
        ].join('')))}
        ${cru(kpi('Integrações', dados.integracoes.conectadas + dados.integracoes.erro + dados.integracoes.desconectadas, [
          parte(`${dados.integracoes.conectadas} conectadas`, dados.integracoes.conectadas ? 'ok' : ''),
          parte(`${dados.integracoes.erro} em erro`, dados.integracoes.erro ? 'critico' : ''),
          parte(`${dados.integracoes.desconectadas} desconectadas`),
        ].join('')))}
        ${cru(kpi('Planos ativos', dados.planos.ativos,
          html`<a data-rota href="/plans" style="font-size:12px">Ver planos</a>`))}
        ${cru(kpi('Platform admins ativos', dados.admins.ativos,
          html`<a data-rota href="/platform-admins" style="font-size:12px">Ver admins</a>`))}
      </div>

      <section class="cartao">
        <header>
          <h2>Gate de criação de organizations</h2>
          <span class="dica">Contrato §8</span>
        </header>
        <div class="grade duas">
          <div>
            ${cru(gate)}
          </div>
          <div class="definicoes">
            <div class="definicao">
              <div class="termo">Bootstrap interno</div>
              <div class="valor">${dados.bootstrapInternoDisponivel
                ? cru('<span class="selo ok">disponível</span>')
                : cru('<span class="selo">indisponível</span>')}</div>
            </div>
            <div class="definicao">
              <div class="termo">SECOND_TENANT_ENABLED</div>
              <div class="valor">${dados.secondTenantEnabled
                ? cru('<span class="selo alerta">ligado</span>')
                : cru('<span class="selo">desligado</span>')}</div>
            </div>
          </div>
        </div>
      </section>

      <section class="cartao">
        <header>
          <h2>Onde o Oria Admin termina</h2>
          <span class="dica">Limites declarados · contrato §13</span>
        </header>
        <ul style="margin:0;padding-left:18px;color:var(--text-secondary);font-size:13px;line-height:20px">
          <li><strong>Impersonation não existe</strong> e não vai existir nesta superfície.</li>
          <li><strong>Aceite de convite é do painel</strong> (tenant plane): aqui o convite é emitido, reemitido e revogado.</li>
          <li><strong>Teste de integração</strong> disparado pelo Admin está fora desta versão — por isso não há botão.</li>
          <li><strong>Planos não têm preço</strong>: são vocabulário técnico de acesso, não catálogo comercial.</li>
        </ul>
      </section>
    </div>`;
}
