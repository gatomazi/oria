// Única fonte de verdade da navegação do painel (sidebar, título da aba, breadcrumb da topbar).
// Itens `comingSoon` ficam declarados aqui mas NÃO aparecem na sidebar (decisão D2 — funcionalidade
// inexistente não ocupa a navegação); voltam a aparecer quando ganharem `href`.
import type { Entitlements } from '../state/entitlements';

export interface NavItem {
  key: string;
  label: string;
  href?: string;
  comingSoon?: boolean;
  // Só aparece quando o envio do WhatsApp está nesse modo (Integrações → WhatsApp). Sem o campo,
  // aparece sempre.
  provider?: 'meta_api' | 'whatsapp_web';
  // Rodada H→I: item some da sidebar sem a feature — o guard de verdade continua sendo o backend
  // (H.1: "esconder navegação não é mecanismo de autorização"); isto é só a navegação respeitando
  // o que o servidor já nega. Opcional — itens existentes não usam isto ainda (ver
  // docs/architecture/features-vs-connectors.md sobre o resto do vocabulário).
  feature?: keyof Entitlements;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_TOP: NavItem[] = [{ key: 'visao-geral', label: 'Visão geral', href: '/admin/dashboard' }];

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Operação',
    items: [
      { key: 'pedidos-central', label: 'Pedidos', href: '/admin/pedidos-central' },
      { key: 'clientes', label: 'Clientes', href: '/admin/clientes' },
      { key: 'trocas', label: 'Trocas e devoluções', href: '/admin/trocas' },
      { key: 'recuperacao', label: 'Recuperação', href: '/admin/recuperacao' },
      { key: 'estoque', label: 'Estoque', href: '/admin/estoque' },
    ],
  },
  {
    label: 'Catálogo',
    items: [
      { key: 'produtos', label: 'Produtos', href: '/admin/produtos' },
      { key: 'categorias', label: 'Categorias', href: '/admin/categorias' },
      { key: 'agrupamentos', label: 'Agrupamentos', href: '/admin/agrupamentos' },
      { key: 'promocoes', label: 'Promoções', href: '/admin/promocoes' },
    ],
  },
  {
    label: 'WhatsApp',
    items: [
      { key: 'whatsapp-visao-geral', label: 'Canal', href: '/admin/whatsapp' },
      { key: 'automacoes', label: 'Automações', href: '/admin/automacoes' },
      { key: 'whatsapp-fila', label: 'Fila de envio', href: '/admin/whatsapp/fila', provider: 'whatsapp_web' },
      { key: 'templates', label: 'Templates', href: '/admin/templates', provider: 'meta_api' },
      { key: 'mensagens-web', label: 'Mensagens', href: '/admin/mensagens', provider: 'whatsapp_web' },
      { key: 'whatsapp-historico', label: 'Histórico', comingSoon: true },
    ],
  },
  {
    // Campanhas é deliberadamente separada de Automações (spec, Parte 2): automação é
    // orientada a evento/transacional (carrinho, Pix), campanha é disparo proativo de
    // audiência. "Nova campanha" é ação da página Campanhas, não item de navegação (decisão D4);
    // a rota /admin/campanhas/nova continua existindo e fica ativa sob "Todas as campanhas".
    label: 'Campanhas',
    items: [
      { key: 'campanhas-todas', label: 'Todas as campanhas', href: '/admin/campanhas' },
      { key: 'campanhas-segmentos', label: 'Segmentos', href: '/admin/campanhas/segmentos' },
      // Relatórios (spec, Parte 24) só faz sentido a partir da Fase 6 (webhooks de entrega/
      // leitura + tracking de clique) — sem isso a tela mostraria métrica zerada por padrão de
      // design, não por falta de envio real.
      { key: 'campanhas-relatorios', label: 'Relatórios', comingSoon: true },
    ],
  },
  {
    label: 'Instagram',
    items: [{ key: 'instagram', label: 'Visão geral', comingSoon: true }],
  },
  {
    label: 'Financeiro',
    items: [
      { key: 'financeiro', label: 'Financeiro', href: '/admin/financeiro' },
      { key: 'despesas', label: 'Despesas', href: '/admin/financeiro/despesas' },
      { key: 'custos-api', label: 'Custos de API', href: '/admin/financeiro/custos-api' },
      { key: 'reembolsos', label: 'Reembolsos', href: '/admin/reembolsos' },
    ],
  },
  {
    label: 'Ferramentas',
    items: [
      { key: 'simular-frete', label: 'Simular frete', href: '/admin/simular-frete' },
      { key: 'pix-ferramenta', label: 'PIX', href: '/admin/pix' },
      { key: 'utm-tracker', label: 'UTM Tracker', href: '/admin/utm' },
      { key: 'analytics-ga4', label: 'Analytics GA4', href: '/admin/analytics' },
      { key: 'desempenho-produtos', label: 'Desempenho de produtos', href: '/admin/desempenho-produtos', feature: 'analytics_product_performance' },
      { key: 'meta-ads', label: 'Meta Ads', href: '/admin/meta-ads' },
      { key: 'google-ads', label: 'Google Ads', href: '/admin/google-ads' },
      { key: 'criativos', label: 'Gerador de criativos', href: '/admin/criativos' },
    ],
  },
  {
    label: 'Sistema',
    items: [
      { key: 'campos', label: 'Campos personalizados', href: '/admin/campos' },
      { key: 'eventos', label: 'Webhooks e logs', href: '/admin/eventos' },
      { key: 'integracoes', label: 'Integrações', href: '/admin/integracoes' },
      { key: 'configuracoes', label: 'Configurações', href: '/admin/configuracoes' },
    ],
  },
];

export const PAGE_TITLES: Record<string, string> = {
  'visao-geral': 'Visão geral',
  pedidos: 'PIX pendentes',
  carrinhos: 'Carrinhos abandonados',
  clientes: 'Clientes',
  estoque: 'Estoque',
  automacoes: 'Automações',
  'whatsapp-fila': 'Fila de envio',
  'mensagens-web': 'Mensagens',
  templates: 'Templates',
  campos: 'Campos personalizados',
  eventos: 'Webhooks e logs',
  integracoes: 'Integrações',
  configuracoes: 'Configurações',
  'pedidos-central': 'Pedidos',
  trocas: 'Trocas e devoluções',
  reembolsos: 'Reembolsos',
  recuperacao: 'Recuperação',
  'whatsapp-visao-geral': 'WhatsApp',
  produtos: 'Produtos',
  categorias: 'Categorias',
  agrupamentos: 'Agrupamentos',
  promocoes: 'Promoções',
  financeiro: 'Financeiro',
  despesas: 'Despesas operacionais',
  'custos-api': 'Custos de API',
  'simular-frete': 'Simular frete',
  'pix-ferramenta': 'PIX',
  'campanhas-todas': 'Campanhas',
  'campanhas-nova': 'Nova campanha',
  'campanhas-segmentos': 'Segmentos',
  'utm-tracker': 'UTM Tracker',
  'analytics-ga4': 'Analytics GA4',
  'desempenho-produtos': 'Desempenho de produtos',
  'meta-ads': 'Meta Ads',
  'google-ads': 'Google Ads',
  criativos: 'Gerador de criativos',
};

// Rotas que não são itens da sidebar (páginas filhas e páginas fora do menu): título da aba e
// breadcrumb da topbar. `parentKey` aponta pro item de navegação que fica ativo e vira link no
// breadcrumb; `group` é usado quando a página não tem item pai.
export interface RouteContext {
  match: RegExp;
  title: string;
  parentKey?: string;
  group?: string;
}

export const ROUTE_CONTEXT: RouteContext[] = [
  { match: /^\/admin\/trocas\/nova\/?$/, title: 'Nova troca', parentKey: 'trocas' },
  { match: /^\/admin\/produtos\/novo\/?$/, title: 'Novo produto', parentKey: 'produtos' },
  { match: /^\/admin\/categorias\/associar\/?$/, title: 'Associar produtos', parentKey: 'categorias' },
  { match: /^\/admin\/templates\/novo\/?$/, title: 'Novo template', parentKey: 'templates' },
  { match: /^\/admin\/templates\/detalhe\/?$/, title: 'Detalhe do template', parentKey: 'templates' },
  { match: /^\/admin\/mensagens\/nova\/?$/, title: 'Nova mensagem', parentKey: 'mensagens-web' },
  { match: /^\/admin\/mensagens\/[^/]+\/?$/, title: 'Editar mensagem', parentKey: 'mensagens-web' },
  { match: /^\/admin\/campanhas\/nova\/?$/, title: 'Nova campanha', parentKey: 'campanhas-todas' },
  { match: /^\/admin\/campanhas\/(?!segmentos)[^/]+\/?$/, title: 'Detalhe da campanha', parentKey: 'campanhas-todas' },
  { match: /^\/admin\/pedidos\/novo\/?$/, title: 'Novo PIX manual', parentKey: 'pix-ferramenta' },
  { match: /^\/admin\/pedidos\/vincular\/?$/, title: 'Vincular pedido', parentKey: 'pix-ferramenta' },
  { match: /^\/admin\/pedidos\/?$/, title: 'Pedidos PIX', parentKey: 'pix-ferramenta' },
  { match: /^\/admin\/playground\/?$/, title: 'Playground', group: 'Sistema' },
];

export const NAV_ICON_PATHS: Record<string, string> = {
  'visao-geral':
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  'pedidos-central': '<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  clientes: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.2A5 5 0 0 1 21 19"/>',
  trocas: '<path d="M4 7h13"/><path d="M14 4l3 3-3 3"/><path d="M20 17H7"/><path d="M10 14l-3 3 3 3"/>',
  recuperacao: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  estoque: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
  produtos: '<path d="M3 4h9l9 9-9 9-9-9V4z"/><circle cx="8" cy="9" r="1.3" fill="currentColor" stroke="none"/>',
  categorias: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>',
  agrupamentos: '<path d="M12 2l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
  promocoes: '<circle cx="7" cy="7" r="2.2"/><circle cx="17" cy="17" r="2.2"/><path d="M18 6L6 18"/>',
  'whatsapp-visao-geral': '<path d="M4 19V9"/><path d="M11 19V4"/><path d="M18 19v-7"/>',
  automacoes: '<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z"/>',
  'whatsapp-fila': '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h7"/><path d="M17 15l3 3-3 3"/>',
  templates: '<path d="M4 4h16v12H8l-4 4V4z"/>',
  'mensagens-web': '<path d="M4 4h16v12H8l-4 4V4z"/><path d="M8 9h8"/><path d="M8 12h5"/>',
  'whatsapp-historico': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  'campanhas-todas': '<path d="M4 4l16 8-16 8V4z"/>',
  'campanhas-nova': '<path d="M12 5v14M5 12h14"/>',
  'campanhas-segmentos': '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="12" cy="17" r="3"/><path d="M9.5 8.5L14.5 15M14.5 8.5L9.5 15"/>',
  instagram:
    '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="12" cy="12" r="3.5"/><circle cx="17" cy="8.3" r=".6" fill="currentColor" stroke="none"/>',
  financeiro:
    '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="17" cy="14.5" r="1.4" fill="currentColor" stroke="none"/>',
  despesas: '<path d="M12 3v18"/><path d="M17 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H6"/>',
  'custos-api':
    '<path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h7"/><circle cx="18" cy="16" r="3.2"/><path d="M18 14.6v2.8"/>',
  reembolsos: '<path d="M9 14l-5-5 5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-2"/>',
  'simular-frete':
    '<rect x="1" y="7" width="13" height="9" rx="1"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="6" cy="18.5" r="1.6"/><circle cx="17.5" cy="18.5" r="1.6"/>',
  'pix-ferramenta':
    '<circle cx="12" cy="12" r="9"/><path d="M13 8l-4 5h3l-1 4 4-5h-3l1-4z" fill="currentColor" stroke="none"/>',
  campos: '<path d="M4 6h10M4 12h6M4 18h12"/><circle cx="17" cy="6" r="1.6"/><circle cx="13" cy="12" r="1.6"/><circle cx="19" cy="18" r="1.6"/>',
  'utm-tracker':
    '<path d="M10 13a5 5 0 0 0 7.07 0l1.72-1.71a5 5 0 0 0-7.07-7.07L10 5.87"/><path d="M14 11a5 5 0 0 0-7.07 0L5.2 12.7a5 5 0 0 0 7.07 7.07L14 18.13"/>',
  'analytics-ga4': '<path d="M3 20h18"/><rect x="5" y="11" width="3.5" height="6" rx="1"/><rect x="10.25" y="7" width="3.5" height="10" rx="1"/><rect x="15.5" y="4" width="3.5" height="13" rx="1"/>',
  'meta-ads': '<path d="M3 17l5-6 4 4 5-7"/><path d="M14 8h4v4"/><path d="M3 21h18"/>',
  'google-ads': '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v9"/><path d="M8.2 9.7l7.6 4.6"/><path d="M15.8 9.7l-7.6 4.6"/>',
  criativos: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>',
  eventos: '<path d="M3 12h4l2 7 4-14 2 7h6"/>',
  integracoes:
    '<path d="M9 2v4M15 2v4"/><path d="M7 6h10v4a5 5 0 0 1-10 0V6z"/><path d="M12 15v3"/><path d="M9 21h6"/>',
  configuracoes:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z"/>',
};
