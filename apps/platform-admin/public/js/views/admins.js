// Platform admins — quem tem acesso ao control plane.
//
// Duas regras visíveis na tela:
//   · só `platform_owner` muta (criar, desativar, reativar, trocar papel). O operador lê;
//   · sempre precisa sobrar um `platform_owner` ativo — desativar ou rebaixar o último é 409
//     `ultimo_platform_owner`, e a recusa vem do banco por trigger, não só do Node.
//
// A senha vai no corpo da criação e não aparece em lugar nenhum depois: nem na listagem, nem em
// log, nem nesta tela.

import * as api from '../api.js';
import { adminAtual, podeGerirPlataforma } from '../sessao.js';
import {
  html, cru, icone, dataHora, selo, seloStatus, avisar, abrirDrawer, rodapeDrawer,
  erroNoDrawer, avisoCaixa,
} from '../ui.js';
import { criarListagem } from '../lista.js';
import { PAPEIS_ADMIN, ROTULO_PAPEL_ADMIN } from '../vocabulario.js';

export async function renderizar(alvo) {
  const owner = podeGerirPlataforma();
  const eu = adminAtual();

  alvo.innerHTML = html`
    <div class="pagina">
      <div class="cabecalho-pagina">
        <div>
          <h1>Platform admins</h1>
          <p class="sub">Identidades do control plane. São tabela própria: uma sessão do painel do lojista não vale aqui.</p>
        </div>
        <div class="acoes">
          ${owner ? html`<button type="button" class="btn btn-primario" data-criar>${cru(icone('mais', 16))}Criar admin</button>` : ''}
        </div>
      </div>

      ${owner
        ? cru(avisoCaixa('info', 'Sempre sobra um owner.',
          'Desativar ou rebaixar o último platform_owner ativo é recusado — pela aplicação e por trigger no banco.'))
        : cru(avisoCaixa('info', 'Somente leitura.',
          'Gerir platform admins exige o papel platform_owner. Você vê a lista, mas não as ações.'))}

      <section class="cartao">
        <div data-lista></div>
      </section>
    </div>`;

  const listaAlvo = alvo.querySelector('[data-lista]');

  function montar() {
    criarListagem({
      alvo: listaAlvo,
      buscar: (cursor) => api.admins.listar({ cursor, limit: 50 }),
      colunas: [
        { titulo: 'Admin' },
        { titulo: 'Papel' },
        { titulo: 'Status' },
        { titulo: 'Criado em' },
        { titulo: 'Último login' },
        { titulo: 'Ações', classe: 'acoes' },
      ],
      linha: (a) => {
        const souEu = eu && a.id === eu.id;
        return html`
          <tr data-id="${a.id}">
            <td>
              <div class="principal">${a.nome || a.email}${souEu ? cru(' <span class="selo premium">você</span>') : ''}</div>
              <div class="secundario">${a.email}</div>
            </td>
            <td>${a.papel === 'platform_owner' ? selo(ROTULO_PAPEL_ADMIN[a.papel], 'premium') : selo(ROTULO_PAPEL_ADMIN[a.papel] || a.papel)}</td>
            <td>${seloStatus(a.status)}</td>
            <td class="secundario">${dataHora(a.criadoEm)}</td>
            <td class="secundario">${dataHora(a.ultimoLoginEm)}</td>
            <td class="acoes">
              ${owner ? html`
                <button type="button" class="btn btn-secundario btn-pequeno" data-papel="${a.id}"
                        data-papel-atual="${a.papel}" data-rotulo="${a.email}">Papel</button>
                ${a.status === 'active'
                  ? html`<button type="button" class="btn btn-perigo btn-pequeno" data-desativar="${a.id}" data-rotulo="${a.email}">Desativar</button>`
                  : html`<button type="button" class="btn btn-secundario btn-pequeno" data-reativar="${a.id}" data-rotulo="${a.email}">Reativar</button>`}`
                : cru('<span class="secundario">—</span>')}
            </td>
          </tr>`;
      },
      vazioTitulo: 'Nenhum platform admin listado.',
      vazioDetalhe: 'Se a lista está vazia mas você está logado, algo está muito errado — investigue pela auditoria.',
    });
  }

  // Delegação: uma única escuta, que sobrevive a cada remontagem da tabela.
  listaAlvo.addEventListener('click', async (evento) => {
    const botao = evento.target.closest('button[data-papel], button[data-desativar], button[data-reativar]');
    if (!botao) return;
    if (botao.dataset.papel) await trocarPapel(botao.dataset.papel, botao.dataset.papelAtual, botao.dataset.rotulo, montar);
    else if (botao.dataset.desativar) await mudarStatus('desativar', botao.dataset.desativar, botao.dataset.rotulo, montar);
    else await mudarStatus('reativar', botao.dataset.reativar, botao.dataset.rotulo, montar);
  });

  if (owner) {
    alvo.querySelector('[data-criar]').addEventListener('click', () => criarAdmin(montar));
  }

  montar();
}

async function criarAdmin(recarregar) {
  const feito = await abrirDrawer({
    titulo: 'Criar platform admin',
    descricao: 'A senha é definida aqui e nunca mais é exibida.',
    corpo: html`
      <div class="campo">
        <label for="admin-email">E-mail</label>
        <input id="admin-email" name="email" type="email" required autocapitalize="none" spellcheck="false">
      </div>
      <div class="campo">
        <label for="admin-nome">Nome (opcional)</label>
        <input id="admin-nome" name="nome" type="text" maxlength="200">
      </div>
      <div class="campo">
        <label for="admin-senha">Senha</label>
        <input id="admin-senha" name="senha" type="password" required minlength="12" maxlength="200"
               autocomplete="new-password">
        <span class="ajuda">De 12 a 200 caracteres. Entregue por um canal seguro: ela não é recuperável por aqui.</span>
      </div>
      <div class="campo">
        <label for="admin-papel">Papel</label>
        <select id="admin-papel" name="papel">
          ${cru(PAPEIS_ADMIN.map((p) => html`<option value="${p}"${p === 'platform_operator' ? ' selected' : ''}>${ROTULO_PAPEL_ADMIN[p]}</option>`).join(''))}
        </select>
        <span class="ajuda">O operador faz tudo que é operação de tenant. Só o owner gere admins e planos.</span>
      </div>`,
    rodape: rodapeDrawer('Criar admin'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.admins.criar({
          email: formulario.elements.email.value.trim(),
          nome: formulario.elements.nome.value.trim() || null,
          senha: formulario.elements.senha.value,
          papel: formulario.elements.papel.value,
        });
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Platform admin criado.'); recarregar(); }
}

async function trocarPapel(adminId, papelAtual, rotulo, recarregar) {
  const feito = await abrirDrawer({
    titulo: 'Trocar papel',
    descricao: rotulo,
    corpo: html`
      ${cru(avisoCaixa('alerta', 'Rebaixar o último owner é recusado.',
        'A contagem acontece dentro da transação. Promova outro owner antes, se for o caso.'))}
      <div class="campo">
        <label for="novo-papel">Papel</label>
        <select id="novo-papel" name="papel">
          ${cru(PAPEIS_ADMIN.map((p) => html`<option value="${p}"${p === papelAtual ? ' selected' : ''}>${ROTULO_PAPEL_ADMIN[p]}${p === papelAtual ? ' (atual)' : ''}</option>`).join(''))}
        </select>
      </div>`,
    rodape: rodapeDrawer('Trocar papel'),
    aoConfirmar: async (formulario, fundo) => {
      try { return await api.admins.trocarPapel(adminId, formulario.elements.papel.value); }
      catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Papel atualizado.'); recarregar(); }
}

async function mudarStatus(acao, adminId, rotulo, recarregar) {
  const desativando = acao === 'desativar';
  const feito = await abrirDrawer({
    titulo: desativando ? 'Desativar platform admin' : 'Reativar platform admin',
    descricao: rotulo,
    corpo: cru(desativando
      ? avisoCaixa('critico', 'As sessões dele caem na hora.',
        'Desativar revoga as sessões do admin imediatamente. Desativar o último owner ativo é recusado.')
      : avisoCaixa('info', 'O admin volta a poder entrar.',
        'Reativar não restaura sessões antigas: ele precisa entrar de novo.')),
    rodape: rodapeDrawer(desativando ? 'Desativar' : 'Reativar', desativando ? 'btn-perigo-solido' : 'btn-primario'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return desativando ? await api.admins.desativar(adminId) : await api.admins.reativar(adminId);
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar(desativando ? 'Admin desativado.' : 'Admin reativado.'); recarregar(); }
}
