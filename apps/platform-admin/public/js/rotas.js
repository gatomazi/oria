// Roteador do Oria Admin — a parte que fala com o browser.
//
// Navegação por History API sobre o fallback SPA do servidor (lib/app.js · servirEstatico):
// qualquer caminho de UI cai no index.html, e quem decide a tela é `TELAS`, em `caminhos.js`.
//
// A validação de caminho local vive em `caminhos.js` de propósito: ela é a regra do §11.8 e
// precisa ser testável sem browser.

import { caminhoLocal, TELAS, casar } from './caminhos.js';

export { caminhoLocal, TELAS, casar };

const ouvintes = new Set();

export function caminhoAtual() {
  return caminhoLocal(window.location.pathname + window.location.search) || '/';
}

export function navegar(caminho, { substituir = false } = {}) {
  const destino = caminhoLocal(caminho) || '/';
  if (substituir) window.history.replaceState({}, '', destino);
  else window.history.pushState({}, '', destino);
  emitir();
}

function emitir() {
  for (const fn of ouvintes) fn(caminhoAtual());
}

export function aoNavegar(fn) {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}

window.addEventListener('popstate', emitir);

// Intercepta cliques em links internos para não recarregar a página.
document.addEventListener('click', (evento) => {
  if (evento.defaultPrevented || evento.button !== 0 || evento.metaKey || evento.ctrlKey
      || evento.shiftKey || evento.altKey) return;
  const link = evento.target.closest('a[data-rota]');
  if (!link) return;
  const destino = caminhoLocal(link.getAttribute('href'));
  if (!destino) return;
  evento.preventDefault();
  navegar(destino);
});
