// Tela de login do control plane.
//
// O que esta tela NÃO faz, de propósito:
//   · não diz se o e-mail existe — `credenciais_invalidas` é a mesma resposta nos três casos (§4.5);
//   · não guarda e-mail nem senha em lugar nenhum;
//   · não monta `returnUrl` a partir de texto digitado: o valor vem do caminho que o operador
//     tentou abrir, e passa por `caminhoLocal` antes de ir ao servidor (§11.8).

import * as api from '../api.js';
import { caminhoLocal } from '../rotas.js';
import { html, cru, icone, mensagemDoErro } from '../ui.js';

export function renderizarLogin(raiz, { returnUrl, aoEntrar }) {
  const destino = caminhoLocal(returnUrl || '');
  raiz.dataset.estado = 'login';
  raiz.innerHTML = html`
    <div class="login">
      <main class="login-cartao" id="conteudo" tabindex="-1">
        <div class="login-marca">
          ${cru(icone('escudo', 28))}
          <div>
            <h1>Oria Admin</h1>
            <p>Control plane da plataforma</p>
          </div>
        </div>

        <div class="aviso info" style="margin-bottom:16px">
          ${cru(icone('info', 16))}
          <div>Esta é a superfície de <strong>administração da plataforma</strong>, não o painel do
          lojista. Quem entra aqui é platform admin.</div>
        </div>

        <div data-erro></div>

        <form novalidate>
          <div class="campo">
            <label for="login-email">E-mail</label>
            <input id="login-email" name="email" type="email" autocomplete="username"
                   required autocapitalize="none" spellcheck="false" placeholder="voce@exemplo.com">
          </div>
          <div class="campo">
            <label for="login-senha">Senha</label>
            <input id="login-senha" name="senha" type="password" autocomplete="current-password" required>
          </div>
          ${destino ? html`<p class="ajuda" style="margin:0;color:var(--text-muted);font-size:12px">
            Depois de entrar você volta para <code>${destino}</code>.</p>` : ''}
          <button type="submit" class="btn btn-primario" data-entrar>Entrar</button>
        </form>

        <p class="login-rodape">
          Sem nenhum platform admin cadastrado, o login responde <code>bootstrap_pendente</code>:
          rode <code>npm run platform-admin:bootstrap</code> no serviço antes da primeira entrada.
        </p>
      </main>
    </div>`;

  const formulario = raiz.querySelector('form');
  const caixaErro = raiz.querySelector('[data-erro]');
  const botao = raiz.querySelector('[data-entrar]');

  formulario.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    caixaErro.innerHTML = '';
    const email = formulario.elements.email.value.trim();
    const senha = formulario.elements.senha.value;
    if (!email || !senha) {
      caixaErro.innerHTML = html`<div class="erro-caixa" role="alert"><strong>Informe e-mail e senha.</strong></div>`;
      return;
    }
    botao.disabled = true;
    botao.textContent = 'Entrando…';
    try {
      const dados = await api.auth.login({ email, senha, returnUrl: destino });
      aoEntrar(dados);
    } catch (err) {
      const espera = err && err.erro === 'rate_limited' && err.retryAfter
        ? html`<span class="secundario">Tente de novo em ${err.retryAfter} s.</span>` : '';
      caixaErro.innerHTML = html`
        <div class="erro-caixa" role="alert">
          <strong>${mensagemDoErro(err)}</strong>
          <span class="codigo">${err && err.erro ? err.erro : 'erro'}</span>
          ${cru(espera)}
        </div>`;
      formulario.elements.senha.value = '';
      formulario.elements.senha.focus();
    } finally {
      botao.disabled = false;
      botao.textContent = 'Entrar';
    }
  });

  formulario.elements.email.focus();
}
