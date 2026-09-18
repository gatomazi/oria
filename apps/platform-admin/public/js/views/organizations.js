// Organizations — listagem, busca, filtro e criação (o caminho do Tenant #1).
//
// A criação é a tela mais carregada de regra do control plane (§8, §12):
//   · `passos` é SEMPRE enviado pela UI. Sem ele o backend depende de ONBOARDING_STEP_REQUIREMENTS
//     e, sem a variável, responde 409 `onboarding_config_required` — não existe plano padrão.
//   · `org_store`, `owner` e `readiness` são estruturais: o backend exige `required`, então o campo
//     é mostrado travado em vez de fingir que a escolha existe.
//   · `bootstrapInterno` é DECLARADO pelo operador; quem decide se pode é o servidor.
//   · o token do convite volta UMA vez. A tela o mostra com cópia e aviso, e não o guarda.

import * as api from '../api.js';
import {
  html, cru, icone, dataHora, seloStatus, seloOnboarding, avisar, numeroOuNulo,
  abrirDrawer, rodapeDrawer, erroNoDrawer, copiar, avisoCaixa, caixaDeErro,
} from '../ui.js';
import { criarListagem } from '../lista.js';
import {
  PASSOS_ONBOARDING, PASSOS_ESTRUTURAIS, ROTULO_PASSO, REQUISITOS, ROTULO_REQUISITO,
} from '../vocabulario.js';

const PADRAO_DOS_PASSOS = Object.freeze({
  org_store: 'required',
  owner: 'required',
  ink: 'optional',
  meta: 'disabled',
  google: 'disabled',
  ga4: 'disabled',
  openai_byok: 'disabled',
  whatsapp: 'optional',
  entitlements: 'optional',
  readiness: 'required',
});

// Chave de idempotência: 16–200 caracteres [A-Za-z0-9_.:-]. Gerada aqui para que reenviar o mesmo
// formulário devolva o mesmo resultado em vez de criar uma segunda organização.
function chaveDeIdempotencia() {
  const dia = new Date().toISOString().slice(0, 10);
  const aleatorio = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `admin-${dia}-${aleatorio}`.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 200);
}

export async function renderizar(alvo, { busca, navegar }) {
  alvo.innerHTML = html`
    <div class="pagina">
      <div class="cabecalho-pagina">
        <div>
          <h1>Organizations</h1>
          <p class="sub">Cada organization é um tenant. O alvo de toda operação vem da rota, nunca do corpo.</p>
        </div>
        <div class="acoes">
          <button type="button" class="btn btn-primario" data-criar>${cru(icone('mais', 16))}Criar organization</button>
        </div>
      </div>

      <section class="cartao">
        <div class="barra-filtros">
          <div class="campo">
            <label for="filtro-q">Buscar por nome</label>
            <input id="filtro-q" type="search" placeholder="ao menos 2 caracteres" autocomplete="off">
          </div>
          <div class="campo estreito">
            <label for="filtro-status">Status</label>
            <select id="filtro-status">
              <option value="">Todos</option>
              <option value="active">Ativas</option>
              <option value="suspended">Suspensas</option>
            </select>
          </div>
          <button type="button" class="btn btn-secundario" data-aplicar>${cru(icone('busca', 16))}Aplicar</button>
        </div>
        <div data-lista></div>
      </section>
    </div>`;

  const listaAlvo = alvo.querySelector('[data-lista]');
  const campoBusca = alvo.querySelector('#filtro-q');
  const campoStatus = alvo.querySelector('#filtro-status');

  function montarLista() {
    const q = campoBusca.value.trim();
    const status = campoStatus.value;
    criarListagem({
      alvo: listaAlvo,
      buscar: (cursor) => api.organizations.listar({ q: q.length >= 2 ? q : null, status, cursor, limit: 50 }),
      colunas: [
        { titulo: 'Organization' },
        { titulo: 'Status' },
        { titulo: 'Plano' },
        { titulo: 'Owners', classe: 'num' },
        { titulo: 'Onboarding' },
        { titulo: 'Criada em' },
      ],
      linha: (o) => html`
        <tr data-id="${o.id}">
          <td>
            <div class="principal">${o.nome}</div>
            <div class="secundario">${o.store ? o.store.nome : 'sem loja'}</div>
          </td>
          <td>${seloStatus(o.status)}</td>
          <td>${o.plano ? html`<span class="mono">${o.plano.chave}</span>` : cru('<span class="selo critico">sem assinatura</span>')}</td>
          <td class="num">${o.ownersAtivos}</td>
          <td>${o.onboarding
            ? html`${seloOnboarding(o.onboarding.status)} ${o.onboarding.currentStep ? html`<span class="secundario">${o.onboarding.currentStep}</span>` : ''}`
            : cru('<span class="secundario">—</span>')}</td>
          <td class="secundario">${dataHora(o.criadoEm)}</td>
        </tr>`,
      vazioTitulo: 'Nenhuma organization encontrada.',
      vazioDetalhe: 'Com os filtros atuais, a listagem não devolveu nada. O Tenant #1 é criado pelo botão "Criar organization".',
      aoClicarLinha: (id) => navegar(`/organizations/${id}`),
    });
  }

  alvo.querySelector('[data-aplicar]').addEventListener('click', montarLista);
  campoBusca.addEventListener('keydown', (e) => { if (e.key === 'Enter') montarLista(); });
  campoStatus.addEventListener('change', montarLista);
  alvo.querySelector('[data-criar]').addEventListener('click', () => abrirCriacao(navegar, () => montarLista()));

  montarLista();

  if (busca && busca.get('criar') === '1') abrirCriacao(navegar, () => montarLista());
}

// ── Criação ───────────────────────────────────────────────────────────────────────────────

async function abrirCriacao(navegar, aoCriar) {
  let planos = [];
  let erroDePlanos = null;
  try {
    const resposta = await api.plans.listar({ limit: 200 });
    planos = (resposta.itens || []).filter((p) => p.status === 'active');
  } catch (err) {
    erroDePlanos = err;
  }

  const opcoesDePlano = planos.map((p) => html`
    <option value="${p.chave}"${p.chave === 'internal' ? ' selected' : ''}>${p.nome} · ${p.chave}${p.chave === 'internal' ? ' (técnico)' : ''}</option>`).join('');

  const corpo = html`
    ${erroDePlanos ? cru(caixaDeErro(erroDePlanos)) : ''}

    ${cru(avisoCaixa('alerta', 'Isto cria um tenant real.',
      'Organization, loja, assinatura, onboarding e convite do owner são criados numa única transação. Não há desfazer — há suspender.'))}

    <div class="campo">
      <label for="c-nome">Nome da organization</label>
      <input id="c-nome" name="nome" type="text" required maxlength="200" placeholder="Use Origens">
    </div>

    <div class="campo">
      <label for="c-store">Nome da loja</label>
      <input id="c-store" name="storeNome" type="text" required maxlength="200" placeholder="Use Origens">
      <span class="ajuda">A loja nasce junto com a organization, na mesma transação.</span>
    </div>

    <div class="campo">
      <label for="c-plano">Plano</label>
      <select id="c-plano" name="planoChave" required>
        ${planos.length ? cru(opcoesDePlano) : html`<option value="">nenhum plano ativo</option>`}
      </select>
      <span class="ajuda">O plano define as features. Override por organization vem depois, no detalhe.</span>
    </div>

    <div class="campo">
      <label for="c-owner">E-mail do owner</label>
      <input id="c-owner" name="ownerEmail" type="email" required autocapitalize="none" spellcheck="false"
             placeholder="pessoa@exemplo.com">
      <span class="ajuda">Recebe o convite de owner. O aceite acontece no painel do lojista, não aqui.</span>
    </div>

    <div class="campo">
      <label for="c-validade">Validade do convite (horas)</label>
      <input id="c-validade" name="conviteValidadeHoras" type="number" min="1" max="168" value="72" required>
      <span class="ajuda">De 1 a 168 (7 dias).</span>
    </div>

    <div class="campo">
      <label for="c-chave">Chave de idempotência</label>
      <input id="c-chave" name="idempotencyKey" type="text" required minlength="16" maxlength="200"
             value="${chaveDeIdempotencia()}" spellcheck="false">
      <span class="ajuda">Reenviar o mesmo pedido com a mesma chave devolve o mesmo resultado, em vez de criar duas organizations.</span>
    </div>

    <label class="campo" style="flex-direction:row;align-items:flex-start;gap:10px">
      <input type="checkbox" name="bootstrapInterno" checked style="width:16px;height:16px;margin-top:2px;flex:none">
      <span>
        <strong style="font-size:13px">Bootstrap interno (Tenant #1)</strong>
        <span class="ajuda" style="display:block">Só funciona enquanto não existir nenhuma organization. Quem decide é o servidor; aqui você apenas declara a intenção.</span>
      </span>
    </label>

    <div>
      <div style="font-size:13px;font-weight:500;color:var(--text-secondary);margin-bottom:8px">Requisitos de onboarding</div>
      <div class="lista-passos">
        ${cru(PASSOS_ONBOARDING.map((passo) => {
          const estrutural = PASSOS_ESTRUTURAIS.includes(passo);
          return html`
            <div class="passo">
              <span class="id">${ROTULO_PASSO[passo] || passo} <span class="secundario">· ${passo}</span></span>
              <select data-passo="${passo}" style="width:150px;flex:none" ${cru(estrutural ? 'disabled' : '')}>
                ${cru(REQUISITOS.map((r) => html`<option value="${r}"${PADRAO_DOS_PASSOS[passo] === r ? ' selected' : ''}>${ROTULO_REQUISITO[r]}</option>`).join(''))}
              </select>
            </div>`;
        }).join(''))}
      </div>
      <span class="ajuda" style="display:block;margin-top:8px">
        <code>org_store</code>, <code>owner</code> e <code>readiness</code> são estruturais e ficam sempre obrigatórios.
      </span>
    </div>`;

  const resultado = await abrirDrawer({
    titulo: 'Criar organization',
    descricao: 'Organization, loja, assinatura, onboarding e convite — uma transação só.',
    corpo,
    rodape: rodapeDrawer('Criar organization'),
    aoConfirmar: async (formulario, fundo) => {
      const passos = {};
      for (const passo of PASSOS_ONBOARDING) {
        const seletor = fundo.querySelector(`[data-passo="${passo}"]`);
        passos[passo] = PASSOS_ESTRUTURAIS.includes(passo) ? 'required' : seletor.value;
      }
      const corpoDoPedido = {
        nome: formulario.elements.nome.value.trim(),
        store: { nome: formulario.elements.storeNome.value.trim() },
        planoChave: formulario.elements.planoChave.value,
        ownerEmail: formulario.elements.ownerEmail.value.trim(),
        idempotencyKey: formulario.elements.idempotencyKey.value.trim(),
        bootstrapInterno: formulario.elements.bootstrapInterno.checked,
        conviteValidadeHoras: numeroOuNulo(formulario.elements.conviteValidadeHoras.value),
        passos,
      };
      try {
        return await api.organizations.criar(corpoDoPedido);
      } catch (err) {
        erroNoDrawer(fundo, err);
        return undefined;
      }
    },
  });

  if (!resultado) return;
  if (aoCriar) aoCriar();
  await mostrarResultadoDaCriacao(resultado, navegar);
}

// O token do convite aparece UMA vez. Esta tela é a única chance de copiá-lo.
async function mostrarResultadoDaCriacao(resultado, navegar) {
  const org = resultado.organization;
  const convite = resultado.invite;
  const concedidas = Object.entries(resultado.entitlements || {}).filter(([, v]) => v).map(([f]) => f);

  await abrirDrawer({
    titulo: resultado.criada ? 'Organization criada' : 'Pedido já processado',
    descricao: resultado.criada
      ? 'Guarde o token do convite agora.'
      : 'A mesma chave de idempotência já havia criado esta organization — nada foi duplicado.',
    corpo: html`
      <div class="definicoes">
        <div class="definicao"><div class="termo">Organization</div><div class="valor">${org.nome}</div></div>
        <div class="definicao"><div class="termo">Loja</div><div class="valor">${resultado.store ? resultado.store.nome : '—'}</div></div>
        <div class="definicao"><div class="termo">Plano</div><div class="valor mono">${resultado.subscription && resultado.subscription.plano ? resultado.subscription.plano.chave : '—'}</div></div>
        <div class="definicao"><div class="termo">Onboarding</div><div class="valor">${resultado.onboarding ? resultado.onboarding.status : '—'}</div></div>
      </div>

      ${convite && convite.token ? html`
        ${cru(avisoCaixa('critico', 'O token aparece uma única vez.',
          'Ele não é recuperável: no banco só existe o resumo criptográfico. Copie agora e entregue ao owner por um canal seguro. Se perder, use "Reemitir" no detalhe da organization.'))}
        <div class="campo">
          <label for="token-convite">Token do convite para ${convite.email}</label>
          <input id="token-convite" class="mono" type="text" readonly value="${convite.token}"
                 aria-describedby="token-ajuda">
          <span class="ajuda" id="token-ajuda">Expira em ${dataHora(convite.expiraEm)} · papel ${convite.papel}</span>
          <div style="display:flex;gap:8px;margin-top:4px">
            <button type="button" class="btn btn-secundario btn-pequeno" data-copiar>${cru(icone('copiar', 14))}Copiar token</button>
          </div>
        </div>
        ${cru(avisoCaixa('info', 'O aceite ainda não tem tela.',
          'A rota que consome o convite pertence ao painel do lojista (tenant plane) e não faz parte desta versão do control plane. Até ela existir, o convite pode ser emitido mas não aceito pela interface.'))}
      ` : cru(avisoCaixa('alerta', 'Nenhum token nesta resposta.',
        'Este pedido não emitiu convite novo. Use "Emitir convite" no detalhe da organization.'))}

      <div>
        <div style="font-size:13px;font-weight:500;color:var(--text-secondary);margin-bottom:8px">Entitlements efetivos</div>
        ${concedidas.length
          ? html`<div style="display:flex;flex-wrap:wrap;gap:6px">${cru(concedidas.map((f) => html`<span class="selo ok">${f}</span>`).join(''))}</div>`
          : html`<div class="vazio"><strong>Nenhuma feature concedida.</strong><span>Confira o plano da assinatura.</span></div>`}
      </div>`,
    rodape: html`
      <button type="button" class="btn btn-secundario" data-fechar>Fechar</button>
      <button type="button" class="btn btn-primario" data-ir>Abrir a organization</button>`,
    aoMontar: (fundo, formulario, fechar) => {
      const botaoCopiar = fundo.querySelector('[data-copiar]');
      if (botaoCopiar) {
        botaoCopiar.addEventListener('click', async () => {
          const campo = fundo.querySelector('#token-convite');
          const ok = await copiar(campo.value);
          if (ok) { avisar('Token copiado. Ele não será exibido de novo.'); return; }
          campo.focus();
          campo.select();
          avisar('Não foi possível copiar automaticamente. O token está selecionado: copie à mão.', 'aviso');
        });
      }
      fundo.querySelector('[data-ir]').addEventListener('click', () => {
        fechar(null);
        navegar(`/organizations/${org.id}`);
      });
    },
  });
}
