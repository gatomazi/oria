// Primitivas de UI: escape, template, ícones inline, estados de lista, drawer e avisos.
//
// Tudo que vem da API é DADO, nunca markup. O template `html` escapa toda interpolação por padrão;
// só passa cru o que for marcado com `cru()`, e `cru()` só é usado sobre fragmentos que esta
// própria camada montou. É o que impede um nome de organização virar HTML.

import { MENSAGEM_DE_ERRO } from './vocabulario.js';

const MARCA_CRUA = Symbol('cru');

export function esc(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Fragmento de markup montado por ESTA camada — nunca por dado de fora. É o que `html` devolve e
// o que `cru()` marca. Tem `toString()` para que os pontos que escrevem em `innerHTML` continuem
// recebendo texto sem conversão explícita.
function fragmento(texto) {
  return { [MARCA_CRUA]: true, texto, toString() { return texto; } };
}

// Idempotente de propósito: `cru(cru(x))` é `cru(x)`. Sem isso, um fragmento já marcado que
// passasse por `cru()` de novo viraria "[object Object]" na tela — falha silenciosa, o pior tipo.
export function cru(texto) {
  if (texto && typeof texto === 'object' && texto[MARCA_CRUA]) return texto;
  return fragmento(String(texto));
}

function interpolar(valor) {
  if (valor === null || valor === undefined || valor === false) return '';
  if (Array.isArray(valor)) return valor.map(interpolar).join('');
  if (typeof valor === 'object' && valor[MARCA_CRUA]) return valor.texto;
  return esc(valor);
}

// Devolve um FRAGMENTO, não uma string. Essa é a diferença que faz composição funcionar: um
// `html` interpolado dentro de outro `html` é markup que este código escreveu, e entra inteiro;
// qualquer outro valor cai em `esc()`. Quando isto devolvia string, o template aninhado era
// indistinguível de dado e saía escapado — a tela mostrava `<strong>` como texto.
//
// A regra de segurança não muda: markup vem de template literal escrito aqui; valor interpolado
// é escapado sempre, a menos que alguém o marque explicitamente com `cru()`.
export function html(partes, ...valores) {
  let saida = partes[0];
  for (let i = 0; i < valores.length; i += 1) saida += interpolar(valores[i]) + partes[i + 1];
  return fragmento(saida);
}

// ── Ícones (SVG inline; nenhum arquivo externo, nenhuma fonte de ícones) ──────────────────

const TRACOS = {
  painel: '<path d="M3 3h7v7H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 14h7v7H3z"/>',
  predio: '<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M15 21V10h3a2 2 0 0 1 2 2v9M3 21h18M8 7h3M8 11h3M8 15h3"/>',
  camadas: '<path d="M12 3 3 8l9 5 9-5-9-5ZM3 14l9 5 9-5M3 11l9 5 9-5"/>',
  escudo: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z"/>',
  pessoas: '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM22 20v-2a4 4 0 0 0-3-3.9M16 4.1a4 4 0 0 1 0 7.8"/>',
  bandeira: '<path d="M4 21V4M4 4h11l-1.5 3L15 10H4"/>',
  plugue: '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0V9ZM12 18v3"/>',
  relogio: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2"/>',
  raio: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  lista: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  sair: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  copiar: '<path d="M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9ZM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  alerta: '<path d="M12 9v4M12 17h.01M10.3 3.9 2.4 17.1A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16v-4M12 8h.01"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  seta: '<path d="m9 18 6-6-6-6"/>',
  volta: '<path d="m15 18-6-6 6-6"/>',
  busca: '<path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3"/>',
};

export function icone(nome, tamanho = 16) {
  const traco = TRACOS[nome];
  if (!traco) return '';
  return `<svg class="glifo" width="${tamanho}" height="${tamanho}" viewBox="0 0 24 24" fill="none"`
    + ` stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true" focusable="false">${traco}</svg>`;
}

// ── Formatação ────────────────────────────────────────────────────────────────────────────

const FORMATO_DATA = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// Campo nulo é estado vazio honesto, não placeholder fabricado (§11.5 do contrato).
export function dataHora(valor) {
  if (!valor) return cru('<span class="secundario">—</span>');
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return String(valor);
  return FORMATO_DATA.format(d);
}

export function relativo(valor) {
  if (!valor) return '—';
  const ms = new Date(valor).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  const minutos = Math.round(ms / 60000);
  const abs = Math.abs(minutos);
  if (abs < 60) return `${minutos >= 0 ? 'em' : 'há'} ${abs} min`;
  if (abs < 60 * 24) return `${minutos >= 0 ? 'em' : 'há'} ${Math.round(abs / 60)} h`;
  return `${minutos >= 0 ? 'em' : 'há'} ${Math.round(abs / 1440)} d`;
}

export function vazio(valor) {
  return valor === null || valor === undefined || valor === '' ? cru('<span class="secundario">—</span>') : valor;
}

export function selo(texto, tom = '') {
  return cru(html`<span class="selo ${cru(esc(tom))}">${texto}</span>`);
}

const TOM_STATUS = { active: 'ok', suspended: 'critico', disabled: 'critico', archived: '' };
export function seloStatus(status) {
  const rotulos = { active: 'Ativa', suspended: 'Suspensa', disabled: 'Desativado', archived: 'Arquivado' };
  return selo(rotulos[status] || status || '—', TOM_STATUS[status] ?? '');
}

const TOM_CONVITE = { pendente: 'alerta', usado: 'ok', revogado: 'critico', expirado: '' };
export const seloConvite = (estado) => selo(estado || '—', TOM_CONVITE[estado] ?? '');

const TOM_INTEGRACAO = { connected: 'ok', disconnected: '', error: 'critico' };
export const seloIntegracao = (status) => selo(status || '—', TOM_INTEGRACAO[status] ?? '');

const TOM_ONBOARDING = { complete: 'ok', in_progress: 'info', blocked: 'critico', not_started: '' };
export const seloOnboarding = (status) => selo(status || '—', TOM_ONBOARDING[status] ?? '');

// ── Estados de lista ──────────────────────────────────────────────────────────────────────

export const carregando = (o = 'Carregando…') => html`<div class="carregando" role="status">${o}</div>`;

export const listaVazia = (titulo, detalhe = '') => html`
  <div class="vazio">
    <strong>${titulo}</strong>
    ${detalhe ? html`<span>${detalhe}</span>` : ''}
  </div>`;

export function mensagemDoErro(err) {
  if (!err) return 'Falha desconhecida.';
  const porCodigo = MENSAGEM_DE_ERRO[err.erro];
  return porCodigo || err.message || 'Falha ao processar a requisição.';
}

export function caixaDeErro(err) {
  const detalhes = err && err.detalhes ? JSON.stringify(err.detalhes) : '';
  return html`
    <div class="erro-caixa" role="alert">
      <strong>${mensagemDoErro(err)}</strong>
      <span class="codigo">${err && err.erro ? err.erro : 'erro'}${err && err.status ? ` · HTTP ${err.status}` : ''}</span>
      ${detalhes ? html`<span class="mono">${detalhes}</span>` : ''}
    </div>`;
}

export function avisoCaixa(tom, titulo, texto) {
  const glifo = tom === 'critico' || tom === 'alerta' ? 'alerta' : 'info';
  return html`
    <div class="aviso ${cru(esc(tom))}">
      ${cru(icone(glifo, 16))}
      <div><strong>${titulo}</strong> ${texto}</div>
    </div>`;
}

// ── Avisos flutuantes ─────────────────────────────────────────────────────────────────────

export function avisar(texto, tom = '') {
  const alvo = document.getElementById('avisos');
  if (!alvo) return;
  const no = document.createElement('div');
  no.className = `toast ${tom}`.trim();
  no.textContent = texto;
  alvo.append(no);
  setTimeout(() => no.remove(), 6000);
}

// ── Drawer ────────────────────────────────────────────────────────────────────────────────
//
// Painel lateral para detalhe e formulário. Devolve uma Promise que resolve com o que o
// `onEnviar` retornar, ou `null` quando o operador fecha. Foco fica preso enquanto está aberto.

export function abrirDrawer({ titulo, descricao = '', corpo, rodape = '', aoMontar, aoConfirmar }) {
  return new Promise((resolve) => {
    const fundo = document.createElement('div');
    fundo.className = 'drawer-fundo';
    fundo.innerHTML = html`
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="${titulo}">
        <header>
          <div>
            <h2>${titulo}</h2>
            ${descricao ? html`<p>${descricao}</p>` : ''}
          </div>
          <button type="button" class="fechar-x" data-fechar aria-label="Fechar">${cru(icone('x', 16))}</button>
        </header>
        <form class="corpo" novalidate>${cru(corpo)}</form>
        <div class="rodape">${cru(rodape)}</div>
      </aside>`;

    const formulario = fundo.querySelector('form');
    const anterior = document.activeElement;

    function fechar(resultado) {
      document.removeEventListener('keydown', aoTeclar, true);
      fundo.remove();
      if (anterior && typeof anterior.focus === 'function') anterior.focus();
      resolve(resultado);
    }

    function aoTeclar(evento) {
      if (evento.key === 'Escape') { evento.preventDefault(); fechar(null); return; }
      if (evento.key !== 'Tab') return;
      const focaveis = [...fundo.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )];
      if (!focaveis.length) return;
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      if (evento.shiftKey && document.activeElement === primeiro) { evento.preventDefault(); ultimo.focus(); }
      else if (!evento.shiftKey && document.activeElement === ultimo) { evento.preventDefault(); primeiro.focus(); }
    }

    fundo.addEventListener('click', (evento) => {
      if (evento.target === fundo || evento.target.closest('[data-fechar]')) fechar(null);
    });
    document.addEventListener('keydown', aoTeclar, true);

    if (aoConfirmar) {
      formulario.addEventListener('submit', async (evento) => {
        evento.preventDefault();
        const botao = fundo.querySelector('[data-confirmar]');
        if (botao) botao.disabled = true;
        try {
          const resultado = await aoConfirmar(formulario, fundo);
          if (resultado !== undefined) fechar(resultado);
        } finally {
          if (botao) botao.disabled = false;
        }
      });
      const confirmar = fundo.querySelector('[data-confirmar]');
      if (confirmar) confirmar.addEventListener('click', () => formulario.requestSubmit());
    }

    document.body.append(fundo);
    if (aoMontar) aoMontar(fundo, formulario, fechar);
    const primeiroCampo = fundo.querySelector('input, select, textarea, button[data-confirmar]');
    if (primeiroCampo) primeiroCampo.focus();
  });
}

export const rodapeDrawer = (rotulo, tom = 'btn-primario') => html`
  <button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>
  <button type="button" class="btn ${cru(esc(tom))}" data-confirmar>${rotulo}</button>`;

// Mostra o erro da API dentro do drawer, acima do rodapé, em vez de fechá-lo.
export function erroNoDrawer(fundo, err) {
  const corpo = fundo.querySelector('.corpo');
  let caixa = corpo.querySelector('[data-erro]');
  if (!caixa) {
    caixa = document.createElement('div');
    caixa.setAttribute('data-erro', '');
    corpo.prepend(caixa);
  }
  caixa.innerHTML = caixaDeErro(err);
  caixa.scrollIntoView({ block: 'nearest' });
}

// Campo numérico opcional: vazio vira `null`, e `null` significa "use o padrão do servidor".
// Mandar `0` (que é o que `Number('')` devolve) seria pedir um valor fora da faixa e tomar 400.
export function numeroOuNulo(valor) {
  const texto = String(valor ?? '').trim();
  if (!texto) return null;
  const n = Number(texto);
  return Number.isFinite(n) ? n : null;
}

// ── Cópia para a área de transferência ────────────────────────────────────────────────────
//
// Em contexto inseguro `navigator.clipboard` não existe. A UI não finge que copiou: devolve false
// e o chamador orienta a copiar à mão do campo que já está na tela.
export async function copiar(texto) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch { /* cai no retorno abaixo */ }
  return false;
}
