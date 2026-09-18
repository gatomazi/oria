// DOM direto (não React), pra manter o mesmo comportamento de sempre (empilha no <body>, some
// sozinho em 8s) sem precisar de um Provider. Visual em admin-shell.css (.ad-toast*): superfície
// elevada + ícone semântico. Política de uso em api/client.ts: toast é pra resultado de ação, não
// pra falha de carregamento.
export type ToastTipo = 'erro' | 'sucesso';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS: Record<ToastTipo | 'close', string[]> = {
  erro: ['M12 8v5', 'M12 16.5h.01', 'M10.3 3.9 2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'],
  sucesso: ['M20 6 9 17l-5-5'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
};

function icon(name: ToastTipo | 'close', size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

// Mesma mensagem já visível não empilha de novo (duas chamadas falhando pelo mesmo motivo, ou o
// StrictMode do dev chamando o efeito duas vezes).
const visiveis = new Map<string, HTMLDivElement>();

export function toast(mensagem: string, tipo: ToastTipo = 'erro'): void {
  // Erro de ação que a tela já mostra junto do controle (formulário, diálogo) não repete em toast:
  // espera o React pintar o catch() e só avisa se a mensagem não estiver visível na tela.
  if (tipo === 'erro') {
    window.setTimeout(() => {
      const alvo = Array.from(document.querySelectorAll<HTMLElement>('#ad-content .ds-form-error, [role="dialog"] .ds-form-error, #ad-content [role="alert"]:not(.ad-toast)'));
      if (alvo.some((el) => el.textContent?.includes(mensagem))) return;
      mostrar(mensagem, tipo);
    }, 150);
    return;
  }
  mostrar(mensagem, tipo);
}

function mostrar(mensagem: string, tipo: ToastTipo): void {
  const chave = `${tipo}:${mensagem}`;
  if (visiveis.get(chave)?.isConnected) return;
  let container = document.querySelector<HTMLDivElement>('.ad-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'ad-toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const item = document.createElement('div');
  item.className = `ad-toast ad-toast--${tipo}`;
  item.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');

  const iconWrap = document.createElement('span');
  iconWrap.className = 'ad-toast__icon';
  iconWrap.appendChild(icon(tipo, 16));
  item.appendChild(iconWrap);

  const texto = document.createElement('span');
  texto.className = 'ad-toast__texto';
  texto.textContent = mensagem;
  item.appendChild(texto);

  const fechar = document.createElement('button');
  fechar.type = 'button';
  fechar.className = 'ad-toast__fechar';
  fechar.setAttribute('aria-label', 'Fechar aviso');
  fechar.appendChild(icon('close', 14));
  // Sai com fade curto; sem animação (movimento reduzido) o animationend não vem, então há um teto.
  const remover = () => {
    if (!item.parentNode || item.classList.contains('ad-toast--saindo')) return;
    item.classList.add('ad-toast--saindo');
    const tirar = () => item.parentNode?.removeChild(item);
    item.addEventListener('animationend', tirar, { once: true });
    window.setTimeout(tirar, 200);
  };
  fechar.addEventListener('click', remover);
  item.appendChild(fechar);

  container.appendChild(item);
  visiveis.set(chave, item);
  setTimeout(() => {
    remover();
  }, 8000);
}
