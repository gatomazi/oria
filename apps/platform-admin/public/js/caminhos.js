// Caminhos e tabela de telas — a parte PURA do roteamento.
//
// Sem `window`, sem `document`: as duas regras que importam (o que é caminho local e qual tela
// responde por qual caminho) são funções, e por isso podem ser testadas fora do browser. É o que
// permite o teste `interface · o roteador da UI recusa returnUrl que não seja caminho local`
// exercitar a mesma função que o login usa.

// Local = começa com UMA barra, não começa com `//` nem `/\`, e não carrega esquema.
// Esta é a porta do §11.8 do contrato: `returnUrl` só pode ser caminho local. Host absoluto,
// protocol-relative (duas barras), esquema embutido e barra invertida não passam.
export function caminhoLocal(valor) {
  if (typeof valor !== 'string' || valor.length === 0) return null;
  if (valor[0] !== '/') return null;
  if (valor[1] === '/' || valor[1] === '\\') return null;
  if (valor.includes('\\')) return null;
  if (/^\/+\s*[a-z][a-z0-9+.-]*:/i.test(valor)) return null;
  return valor;
}

// Cada entrada casa o caminho e diz qual módulo de view renderiza. `params` sai do padrão `:id`.
export const TELAS = Object.freeze([
  { padrao: '/', modulo: 'overview', titulo: 'Visão geral' },
  { padrao: '/organizations', modulo: 'organizations', titulo: 'Organizations' },
  { padrao: '/organizations/:organizationId', modulo: 'organization', titulo: 'Organization' },
  { padrao: '/plans', modulo: 'plans', titulo: 'Planos' },
  { padrao: '/platform-admins', modulo: 'admins', titulo: 'Platform admins' },
  { padrao: '/users', modulo: 'users', titulo: 'Usuários' },
  { padrao: '/onboardings', modulo: 'onboardings', titulo: 'Onboardings' },
  { padrao: '/integrations', modulo: 'integrations', titulo: 'Integrações' },
  { padrao: '/jobs', modulo: 'jobs', titulo: 'Jobs' },
  { padrao: '/webhooks', modulo: 'webhooks', titulo: 'Webhooks' },
  { padrao: '/audit', modulo: 'audit', titulo: 'Auditoria' },
]);

export function casar(caminho) {
  const semQuery = caminho.split('?')[0];
  const partes = semQuery.split('/').filter(Boolean);
  for (const tela of TELAS) {
    const esperadas = tela.padrao.split('/').filter(Boolean);
    if (esperadas.length !== partes.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < esperadas.length; i += 1) {
      const p = esperadas[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(partes[i]);
      else if (p !== partes[i]) { ok = false; break; }
    }
    if (ok) return { tela, params, busca: new URLSearchParams(caminho.split('?')[1] || '') };
  }
  return null;
}
