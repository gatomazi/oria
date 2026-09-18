// Listagem paginada por cursor.
//
// O contrato só oferece cursor opaco (§5.4): `?limit=&cursor=`, resposta `{itens, proximoCursor}`,
// `proximoCursor: null` = fim. Não existe offset, não existe total — então esta camada não inventa
// numeração de página nem "x de y". O que existe é "carregar mais", e o cursor volta como veio.
//
// Toda listagem passa por aqui para que os quatro estados sejam sempre os mesmos:
// carregando · vazio explícito · erro com o código do contrato · fim da paginação.

import { html, cru, caixaDeErro, carregando, listaVazia } from './ui.js';

export function criarListagem({ alvo, buscar, colunas, linha, vazioTitulo, vazioDetalhe = '', aoClicarLinha = null }) {
  let cursor = null;
  let primeiraPagina = true;
  let carregandoAgora = false;

  alvo.innerHTML = carregando();

  function moldura(corpoTabela, rodape) {
    return html`
      <div class="tabela-rolagem">
        <table class="tabela">
          <thead><tr>${cru(colunas.map((c) => html`<th${cru(c.classe ? ` class="${c.classe}"` : '')}>${c.titulo}</th>`).join(''))}</tr></thead>
          <tbody data-corpo>${cru(corpoTabela)}</tbody>
        </table>
      </div>
      <div class="rodape-pagina" data-rodape>${cru(rodape)}</div>`;
  }

  function botaoMais() {
    return html`<button type="button" class="btn btn-secundario" data-mais>Carregar mais</button>`;
  }

  function fim(quantos) {
    return html`<span class="secundario" style="font-size:12px;color:var(--text-muted)">Fim da lista · ${quantos} ${quantos === 1 ? 'registro' : 'registros'}</span>`;
  }

  let total = 0;

  async function pagina() {
    if (carregandoAgora) return;
    carregandoAgora = true;
    const rodape = alvo.querySelector('[data-rodape]');
    if (rodape) rodape.innerHTML = html`<span class="secundario" style="font-size:12px">Carregando…</span>`;
    try {
      const resposta = await buscar(cursor);
      const itens = (resposta && resposta.itens) || [];
      total += itens.length;
      cursor = (resposta && resposta.proximoCursor) || null;

      if (primeiraPagina) {
        primeiraPagina = false;
        if (!itens.length) {
          alvo.innerHTML = listaVazia(vazioTitulo, vazioDetalhe);
          return;
        }
        alvo.innerHTML = moldura(itens.map(linha).join(''), cursor ? botaoMais() : fim(total));
      } else {
        alvo.querySelector('[data-corpo]').insertAdjacentHTML('beforeend', itens.map(linha).join(''));
        alvo.querySelector('[data-rodape]').innerHTML = cursor ? botaoMais() : fim(total);
      }
      ligar();
    } catch (err) {
      if (primeiraPagina) alvo.innerHTML = caixaDeErro(err);
      else alvo.querySelector('[data-rodape]').innerHTML = caixaDeErro(err);
    } finally {
      carregandoAgora = false;
    }
  }

  function ligar() {
    const mais = alvo.querySelector('[data-mais]');
    if (mais) mais.addEventListener('click', pagina, { once: true });
    if (!aoClicarLinha) return;
    for (const tr of alvo.querySelectorAll('tbody tr[data-id]')) {
      if (tr.dataset.ligada) continue;
      tr.dataset.ligada = '1';
      tr.classList.add('linha-clicavel');
      tr.tabIndex = 0;
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select')) return;
        aoClicarLinha(tr.dataset.id);
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target !== tr) return;
        e.preventDefault();
        aoClicarLinha(tr.dataset.id);
      });
    }
  }

  pagina();
  return { recarregar() { cursor = null; primeiraPagina = true; total = 0; alvo.innerHTML = carregando(); pagina(); } };
}
