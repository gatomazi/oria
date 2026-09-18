// Planos — vocabulário técnico de acesso.
//
// Não há preço, trial, cupom nem fatura: o contrato declara isso fora de escopo (§13). Um plano é
// um conjunto de features do vocabulário fechado, e é isso que a tela mostra.
//
// Mutações (criar, editar, trocar features, arquivar) exigem `platform_owner`. O operador vê tudo
// e não vê botão nenhum — o backend recusaria com 403 de qualquer forma.

import * as api from '../api.js';
import { podeGerirPlataforma } from '../sessao.js';
import {
  html, cru, icone, dataHora, selo, avisar, abrirDrawer, rodapeDrawer, erroNoDrawer,
  caixaDeErro, carregando, avisoCaixa, listaVazia,
} from '../ui.js';
import { FEATURES, ROTULO_FEATURE } from '../vocabulario.js';

export async function renderizar(alvo) {
  const owner = podeGerirPlataforma();

  alvo.innerHTML = html`
    <div class="pagina">
      <div class="cabecalho-pagina">
        <div>
          <h1>Planos</h1>
          <p class="sub">Cada plano é um conjunto de features do vocabulário fechado. Não é catálogo comercial.</p>
        </div>
        <div class="acoes">
          ${owner ? html`<button type="button" class="btn btn-primario" data-criar>${cru(icone('mais', 16))}Criar plano</button>` : ''}
        </div>
      </div>
      ${owner ? '' : cru(avisoCaixa('info', 'Somente leitura.',
        'Criar, editar, trocar features e arquivar planos exige o papel platform_owner.'))}
      <div data-lista>${cru(carregando('Carregando planos…'))}</div>
    </div>`;

  const lista = alvo.querySelector('[data-lista]');
  if (owner) alvo.querySelector('[data-criar]').addEventListener('click', () => criarPlano(carregar));

  async function carregar() {
    lista.innerHTML = carregando('Carregando planos…');
    let planos;
    try {
      const resposta = await api.plans.listar({ limit: 200 });
      planos = resposta.itens || [];
    } catch (err) {
      lista.innerHTML = caixaDeErro(err);
      return;
    }
    if (!planos.length) {
      lista.innerHTML = listaVazia('Nenhum plano cadastrado.',
        'O plano técnico `internal` é semeado pela migration; se ele não aparece, o banco não recebeu a migration do control plane.');
      return;
    }
    lista.innerHTML = planos.map((p) => cartaoDePlano(p, owner)).join('');
    ligar();
  }

  function ligar() {
    for (const botao of lista.querySelectorAll('[data-editar]')) {
      botao.addEventListener('click', () => editarPlano(botao.dataset.editar, carregar));
    }
    for (const botao of lista.querySelectorAll('[data-features]')) {
      botao.addEventListener('click', () => editarFeatures(botao.dataset.features, carregar));
    }
    for (const botao of lista.querySelectorAll('[data-arquivar]')) {
      botao.addEventListener('click', () => arquivarPlano(botao.dataset.arquivar, botao.dataset.nome, carregar));
    }
  }

  await carregar();
}

function cartaoDePlano(p, owner) {
  const tecnico = p.chave === 'internal';
  const concedidas = new Set(p.features || []);
  return html`
    <section class="cartao" style="margin-bottom:16px">
      <header>
        <div>
          <h2>${p.nome} ${tecnico ? selo('técnico', 'premium') : ''} ${p.status === 'archived' ? selo('arquivado', 'critico') : selo('ativo', 'ok')}</h2>
          <p class="dica" style="margin:4px 0 0">
            <span class="mono">${p.chave}</span>
            · ${p.assinaturasAtivas} ${p.assinaturasAtivas === 1 ? 'assinatura ativa' : 'assinaturas ativas'}
            · criado em ${dataHora(p.criadoEm)}
          </p>
        </div>
        ${owner ? html`
          <div class="acoes">
            <button type="button" class="btn btn-secundario btn-pequeno" data-editar="${p.id}">Editar</button>
            <button type="button" class="btn btn-secundario btn-pequeno" data-features="${p.id}">Features</button>
            ${p.status === 'active'
              ? html`<button type="button" class="btn btn-perigo btn-pequeno" data-arquivar="${p.id}" data-nome="${p.nome}">Arquivar</button>`
              : ''}
          </div>` : ''}
      </header>

      ${p.descricao ? html`<p style="margin:0 0 12px;color:var(--text-secondary);font-size:13px">${p.descricao}</p>` : ''}

      ${tecnico ? cru(avisoCaixa('info', 'Plano técnico do Tenant #1.',
        'Semeado pela migration a partir do perfil de entitlements do Tenant #1. Não é allow-all: o que não está na lista é negado como qualquer ausência.')) : ''}

      <div class="entitlements" style="margin-top:12px">
        ${cru(FEATURES.map((f) => html`
          <div class="entitlement">
            <div style="min-width:0">
              <div class="nome">${ROTULO_FEATURE[f] || f}</div>
              <div class="origem mono">${f}</div>
            </div>
            <div class="direita">${concedidas.has(f) ? selo('inclusa', 'ok') : selo('fora', '')}</div>
          </div>`).join(''))}
      </div>
    </section>`;
}

// ── Mutações ──────────────────────────────────────────────────────────────────────────────

function caixasDeFeatures(selecionadas) {
  const marcadas = new Set(selecionadas || []);
  return html`
    <div class="entitlements">
      ${cru(FEATURES.map((f) => html`
        <label class="entitlement" style="cursor:pointer">
          <div style="min-width:0">
            <div class="nome">${ROTULO_FEATURE[f] || f}</div>
            <div class="origem mono">${f}</div>
          </div>
          <input type="checkbox" data-feature="${f}"${marcadas.has(f) ? ' checked' : ''}
                 style="width:16px;height:16px;flex:none">
        </label>`).join(''))}
    </div>`;
}

const featuresMarcadas = (fundo) => [...fundo.querySelectorAll('[data-feature]')]
  .filter((c) => c.checked).map((c) => c.dataset.feature);

async function criarPlano(recarregar) {
  const feito = await abrirDrawer({
    titulo: 'Criar plano',
    descricao: 'Chave imutável, nome exibido e o conjunto de features.',
    corpo: html`
      <div class="campo">
        <label for="plano-chave">Chave</label>
        <input id="plano-chave" name="chave" type="text" required maxlength="63" spellcheck="false"
               pattern="[a-z][a-z0-9_]{1,62}" placeholder="growth">
        <span class="ajuda">Minúsculas, começa por letra, aceita dígito e sublinhado. É o identificador estável.</span>
      </div>
      <div class="campo">
        <label for="plano-nome">Nome</label>
        <input id="plano-nome" name="nome" type="text" required maxlength="200" placeholder="Growth">
      </div>
      <div class="campo">
        <label for="plano-descricao">Descrição (opcional)</label>
        <textarea id="plano-descricao" name="descricao" maxlength="1000"></textarea>
      </div>
      <div>
        <div style="font-size:13px;font-weight:500;color:var(--text-secondary);margin-bottom:8px">Features</div>
        ${cru(caixasDeFeatures([]))}
      </div>`,
    rodape: rodapeDrawer('Criar plano'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.plans.criar({
          chave: formulario.elements.chave.value.trim(),
          nome: formulario.elements.nome.value.trim(),
          descricao: formulario.elements.descricao.value.trim() || null,
          features: featuresMarcadas(fundo),
        });
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Plano criado.'); recarregar(); }
}

async function editarPlano(planId, recarregar) {
  let plano;
  try { plano = await api.plans.buscar(planId); } catch (err) { avisar(err.message, 'erro'); return; }

  const feito = await abrirDrawer({
    titulo: `Editar ${plano.nome}`,
    descricao: 'A chave não muda — ela é o identificador estável do plano.',
    corpo: html`
      <div class="campo">
        <label for="editar-nome">Nome</label>
        <input id="editar-nome" name="nome" type="text" maxlength="200" value="${plano.nome}">
      </div>
      <div class="campo">
        <label for="editar-descricao">Descrição</label>
        <textarea id="editar-descricao" name="descricao" maxlength="1000">${plano.descricao || ''}</textarea>
      </div>`,
    rodape: rodapeDrawer('Salvar'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.plans.atualizar(planId, {
          nome: formulario.elements.nome.value.trim() || null,
          descricao: formulario.elements.descricao.value.trim() || null,
        });
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Plano atualizado.'); recarregar(); }
}

async function editarFeatures(planId, recarregar) {
  let plano;
  try { plano = await api.plans.buscar(planId); } catch (err) { avisar(err.message, 'erro'); return; }

  const feito = await abrirDrawer({
    titulo: `Features de ${plano.nome}`,
    descricao: 'A lista marcada SUBSTITUI o conjunto atual.',
    corpo: html`
      ${cru(avisoCaixa('alerta', 'Isto muda o acesso na hora.',
        html`${plano.assinaturasAtivas} ${plano.assinaturasAtivas === 1 ? 'organization assina' : 'organizations assinam'}
             este plano. Desmarcar uma feature nega o acesso imediatamente, exceto onde houver override concedendo.`))}
      ${cru(caixasDeFeatures(plano.features))}`,
    rodape: rodapeDrawer('Substituir features'),
    aoConfirmar: async (formulario, fundo) => {
      try {
        return await api.plans.substituirFeatures(planId, featuresMarcadas(fundo));
      } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Features do plano substituídas.'); recarregar(); }
}

async function arquivarPlano(planId, nome, recarregar) {
  const feito = await abrirDrawer({
    titulo: `Arquivar ${nome}`,
    corpo: cru(avisoCaixa('alerta', 'Arquivar não apaga.',
      'O histórico de assinaturas fica. Um plano com assinatura ativa é recusado com 409 — troque as organizations de plano primeiro.')),
    rodape: rodapeDrawer('Arquivar plano', 'btn-perigo-solido'),
    aoConfirmar: async (formulario, fundo) => {
      try { return await api.plans.arquivar(planId); } catch (err) { erroNoDrawer(fundo, err); return undefined; }
    },
  });
  if (feito) { avisar('Plano arquivado.'); recarregar(); }
}
