'use strict';

// Qual feature (TD-012) cada rota de negócio exige. Central, e aplicado dentro do pipeline de
// tenant (requireAdmin) — uma rota nova sob um destes prefixos já nasce protegida. A ordem importa:
// o primeiro padrão que casar vence.
//
// Não é catálogo comercial: só amarra rotas que JÁ existem às features do vocabulário fechado.

const ROTAS = Object.freeze([
  [/\/reembolsos(\/|$)/, 'refunds'],
  [/^\/api\/admin\/trocas(\/|$)/, 'exchanges'],
  [/^\/api\/admin\/(produtos|produto-tipos|categorias|category-assignments|category-jobs|agrupamentos|promocoes|estoque|controle-estoque)(\/|$)/, 'catalog'],
  [/^\/api\/admin\/(financeiro|dashboard\/financeiro|dashboard\/lucro-produtos|analytics\/consolidado)(\/|$)/, 'financial'],
  [/^\/api\/admin\/(whatsapp|whatsapp-web|whatsapp-templates|campaigns|segments|automacao-eventos|automation-settings|recuperacao|dashboard\/recuperacao-resumo)(\/|$)/, 'whatsapp'],
  [/^\/api\/admin\/criativos(\/|$)/, 'creative_generator'],
]);

function featureDaRota(caminho) {
  const p = String(caminho || '').split('?')[0];
  for (const [re, feature] of ROTAS) if (re.test(p)) return feature;
  return null;
}

module.exports = { ROTAS, featureDaRota };
