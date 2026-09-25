'use strict';

// Navegação do painel · sidebar só de operação, administração da loja no menu do canto superior
// direito, e nenhum ponto de entrada técnico (webhooks/logs) na experiência do lojista.
// Lê nav.ts (transpilado e executado), App.tsx e AppShell.tsx do sujeito.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const h = require('./harness');

const SRC = path.join(h.RAIZ_SUJEITO, 'src');
const ler = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function carregarNav() {
  const js = ts.transpileModule(ler('shell/nav.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const modulo = { exports: {} };
  vm.runInNewContext(js, { module: modulo, exports: modulo.exports }, { filename: 'nav.ts' });
  return modulo.exports;
}
const nav = carregarNav();
const app = ler('App.tsx');
const shell = ler('shell/AppShell.tsx');

const grupo = (rotulo) => nav.NAV_GROUPS.find((g) => g.label === rotulo);
const itensDe = (rotulo) => (grupo(rotulo) ? Array.from(grupo(rotulo).items, (i) => i.key) : []);
const todosOsItens = () => nav.NAV_GROUPS.flatMap((g) => g.items);

test('sidebar · grupos finais: Operação, Catálogo, Comunicação, Marketing e dados, Criativos, Campanhas, Financeiro (Ferramentas e Sistema não existem)', () => {
  const rotulos = nav.NAV_GROUPS.map((g) => g.label);
  for (const esperado of ['Operação', 'Catálogo', 'Comunicação', 'Marketing e dados', 'Criativos', 'Campanhas', 'Financeiro']) {
    assert.ok(rotulos.includes(esperado), `falta o grupo ${esperado}`);
  }
  for (const proibido of ['Ferramentas', 'Sistema', 'Conexões', 'WhatsApp', 'Webhooks', 'Logs', 'Diagnósticos']) {
    assert.ok(!rotulos.includes(proibido), `o grupo ${proibido} não deve existir na sidebar`);
  }
});

test('sidebar · Recuperação está em Comunicação e Simular frete em Operação', () => {
  assert.ok(itensDe('Comunicação').includes('recuperacao'));
  assert.ok(!itensDe('Operação').includes('recuperacao'));
  assert.ok(itensDe('Operação').includes('simular-frete'));
  assert.deepEqual(itensDe('Operação'), ['pedidos-central', 'clientes', 'trocas', 'estoque', 'simular-frete']);
  for (const k of ['whatsapp-visao-geral', 'recuperacao', 'pix-ferramenta', 'automacoes', 'templates']) assert.ok(itensDe('Comunicação').includes(k), k);
});

test('sidebar · relatórios de Meta Ads, Google Ads e GA4 ficam em Marketing e dados; conectar é só em Integrações', () => {
  for (const k of ['meta-ads', 'google-ads', 'analytics-ga4', 'utm-tracker']) assert.ok(itensDe('Marketing e dados').includes(k), k);
});

test('sidebar · não há entrada de Integrações, Configurações, Campos personalizados, Webhooks, Logs nem Diagnósticos', () => {
  const proibidos = /integra|configura|campos personalizados|webhook|logs?\b|diagn[oó]stic|eventos|conex[õo]es|sistema/i;
  for (const item of todosOsItens()) {
    assert.doesNotMatch(item.label, proibidos, `item de sidebar "${item.label}"`);
    assert.ok(!['integracoes', 'configuracoes', 'campos', 'eventos'].includes(item.key), item.key);
    assert.doesNotMatch(item.href || '', /\/admin\/(integracoes|configuracoes|campos|eventos)/, item.key);
  }
});

test('menu da loja · Configurações, Integrações e Campos personalizados, com as rotas reais', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(nav.NAV_STORE_MENU.map((i) => [i.label, i.href]))),
    [['Configurações', '/admin/configuracoes'], ['Integrações', '/admin/integracoes'], ['Campos personalizados', '/admin/campos']],
  );
  assert.match(shell, /NAV_STORE_MENU\.filter/, 'o dropdown lê a fonte única de navegação');
  assert.match(shell, /onSelect=\{onLogout\}/, 'Sair segue no dropdown, com o logout existente');
  assert.match(shell, /aria-current=\{ativo \? 'page' : undefined\}/, 'item ativo do dropdown é sinalizado');
  assert.doesNotMatch(shell, /RadixDropdown\.Item[^>]*>\s*<Link to="\/admin\/(integracoes|configuracoes)"/, 'sem links fixos: tudo vem de NAV_STORE_MENU');
});

test('rotas · todo href da sidebar e do menu da loja tem uma <Route> real (nada de link quebrado)', () => {
  const rotas = new Set([...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]));
  const hrefs = [...todosOsItens(), ...nav.NAV_STORE_MENU, ...nav.NAV_TOP].filter((i) => i.href).map((i) => i.href);
  for (const href of hrefs) assert.ok(rotas.has(href), `sem rota para ${href}`);
});

test('rotas · itens "em breve" não aparecem como link (sem href)', () => {
  for (const item of todosOsItens().filter((i) => i.comingSoon)) assert.equal(item.href, undefined, item.key);
});

test('webhooks e logs · a tela de eventos brutos saiu; a URL antiga cai em Integrações; nada apaga o processamento', () => {
  assert.ok(!fs.existsSync(path.join(SRC, 'pages', 'eventos')), 'a página de eventos brutos não existe mais');
  assert.doesNotMatch(app, /EventosPage/);
  assert.match(app, /path="\/admin\/eventos" element=\{<Navigate to="\/admin\/integracoes" replace \/>\}/);
  // O que sustenta o recebimento continua no servidor: gravação do evento e rotas de entrega.
  const server = fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'server.js'), 'utf8');
  assert.match(server, /INSERT INTO webhook_eventos/);
  assert.match(server, /\/api\/webhooks\/ink/);
});

test('webhooks e logs · a API do lojista devolve só metadados (sem corpo nem headers da entrega)', () => {
  const server = fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'server.js'), 'utf8');
  const inicio = server.indexOf("app.get('/api/admin/webhook-log'");
  assert.ok(inicio > 0);
  const rota = server.slice(inicio, server.indexOf("app.get('/api/admin/pedidos'", inicio));
  assert.doesNotMatch(rota, /\bheaders\b[^,\n]*,\s*body\s+FROM/, 'a consulta não seleciona headers/body');
  assert.doesNotMatch(rota, /SELECT[^`]*\bbody\b/, 'a consulta não seleciona o corpo do webhook');
  assert.match(rota, /\{ headers, body, \.\.\.metadados \}/, 'o modo sem banco também remove corpo e headers');
});

test('breadcrumb · páginas do menu da loja ficam sob "Loja" e não acendem item da sidebar', () => {
  assert.equal(nav.STORE_MENU_GROUP, 'Loja');
  assert.match(shell, /group: STORE_MENU_GROUP/);
  assert.match(shell, /activeKey: ''/);
});

test('drawer · o conteúdo fica inerte enquanto o drawer está aberto e o drawer fecha ao ir para desktop', () => {
  assert.match(shell, /setAttribute\('inert', ''\)/);
  assert.match(shell, /matchMedia\('\(min-width: 1024px\)'\)/);
});

// ── Fechamento (cabeçalho e sidebar compactável) ─────────────────────────────────────────────────────────────
const cssShell = ler('admin/admin-shell.css');

test('cabeçalho · o gatilho do menu identifica a CONTA (iniciais de quem está logado + chevron) e nunca repete o nome da loja do seletor', () => {
  assert.match(shell, /const rotulo = 'Abrir menu da conta e da loja';/);
  assert.match(shell, /aria-label=\{rotulo\} title=\{rotulo\}/);
  assert.match(shell, /initials\(usuario \|\| nome\)/);
  assert.doesNotMatch(shell, /ad-store-menu__nome/, 'o nome da loja não é mais texto do gatilho');
  assert.doesNotMatch(shell, /aria-label=\{`Menu da loja \$\{nome\}`\}/);
  // o seletor de loja continua à esquerda dos controles do canto direito
  assert.ok(shell.indexOf('<WorkspaceSelect />') < shell.indexOf('<StoreMenu'), 'seletor de loja antes do menu da conta');
});

test('cabeçalho · o menu aberto mantém organização, plano (quando carregado), Configurações, Integrações, Campos personalizados e Sair', () => {
  assert.match(shell, /<strong>\{nome\}<\/strong>/);
  assert.match(shell, /\{plano && <span>\{plano\}<\/span>\}/);
  assert.match(shell, /NAV_STORE_MENU\.filter/);
  assert.match(shell, /aria-current=\{ativo \? 'page' : undefined\}/);
  assert.match(shell, /onSelect=\{onLogout\}/);
  assert.deepEqual(Array.from(nav.NAV_STORE_MENU, (i) => i.key), ['configuracoes', 'integracoes', 'campos']);
});

test('sidebar · botão de recolher/expandir com nome acessível, aria-expanded e aria-controls; a redução só vale no desktop', () => {
  assert.match(shell, /aria-label=\{prefs\.colapsada \? 'Expandir menu lateral' : 'Recolher menu lateral'\}/);
  assert.match(shell, /aria-expanded=\{!prefs\.colapsada\}/);
  assert.match(shell, /aria-controls="ad-sidebar"/);
  assert.match(shell, /useMediaQuery\('\(min-width: 1024px\)'\)/);
  assert.match(shell, /const reduzida = prefs\.colapsada && desktop;/);
});

test('sidebar · grupos recolhíveis: botão com aria-expanded + aria-controls; fechado mostra só a página atual; preferência só local', () => {
  assert.match(shell, /className="ad-nav__group-toggle"/);
  assert.match(shell, /aria-expanded=\{aberto\}/);
  assert.match(shell, /aria-controls=\{listaId\}/);
  assert.match(shell, /itensVisiveis\(group\.items, aberto, routeInfo\.activeKey, reduzida\)/);
  const prefs = ler('shell/navPrefs.ts');
  assert.match(prefs, /oria\.shell\.nav\.v1/);
  assert.doesNotMatch(prefs, /fetch\(|api\//, 'nenhuma chamada ao servidor para guardar a preferência');
  assert.match(shell, /gravarPrefs\(prefs\)/);
});

test('sidebar reduzida · ícones com tooltip (mouse e foco) e o rótulo continua sendo o nome acessível; sem ícone → inicial', () => {
  assert.match(shell, /reduzida \? <Tooltip content=\{item\.label\} side="right">\{link\}<\/Tooltip> : link/);
  assert.match(shell, /<span className="ad-nav__label">\{item\.label\}<\/span>/);
  assert.match(shell, /ad-nav__icon--inicial/);
});

test('sidebar reduzida · as regras vivem SÓ no breakpoint de desktop (o drawer do mobile não recebe a versão compacta)', () => {
  const i = cssShell.indexOf('@media (min-width: 1024px) {');
  assert.ok(i > 0, 'bloco de desktop');
  let profundidade = 0; let fim = -1;
  for (let k = cssShell.indexOf('{', i); k < cssShell.length; k += 1) {
    if (cssShell[k] === '{') profundidade += 1;
    if (cssShell[k] === '}') { profundidade -= 1; if (profundidade === 0) { fim = k; break; } }
  }
  const blocoDesktop = cssShell.slice(i, fim);
  const fora = cssShell.slice(0, i) + cssShell.slice(fim);
  assert.match(blocoDesktop, /\.ad-shell--nav-reduzida \.ad-sidebar \{ width: var\(--sidebar-width-reduzida\); \}/);
  assert.doesNotMatch(fora, /ad-shell--nav-reduzida/, 'nenhuma regra de sidebar reduzida fora do desktop');
});

test('sidebar · o mapa de rotas e o gating dos itens não mudaram (quem decide é nav.ts e o servidor)', () => {
  assert.match(shell, /const itemVisivel = \(item: NavItem\) =>/);
  assert.match(shell, /hasEntitlement\(item\.feature\)/);
  assert.equal(nav.NAV_GROUPS.length >= 7, true);
});

test('cabeçalho · o botão de navegação (hambúrguer) e o menu da conta têm nomes acessíveis DISTINTOS', () => {
  assert.match(shell, /aria-label="Abrir menu de navegação"/);
  assert.match(shell, /aria-label="Fechar menu de navegação"/);
  assert.match(shell, /const rotulo = 'Abrir menu da conta e da loja';/);
  assert.doesNotMatch(shell, /aria-label="Abrir menu"/, 'um nome que é prefixo do outro confunde leitor de tela e comando de voz');
});

test('drawer · o foco volta ao botão de menu DEPOIS de fechar (com o conteúdo sem `inert`), no Esc e no botão Fechar', () => {
  assert.match(shell, /const devolverFoco = useRef\(false\);/);
  assert.equal((shell.match(/devolverFoco\.current = true;/g) || []).length, 2, 'Esc e botão Fechar');
  assert.match(shell, /if \(navOpen \|\| !devolverFoco\.current\) return;\s+devolverFoco\.current = false;\s+menuBtnRef\.current\?\.focus\(\);/);
  // o foco NÃO é pedido no mesmo tick do Esc (o botão ainda estaria dentro do conteúdo inerte)
  assert.doesNotMatch(shell, /setNavOpen\(false\);\s+menuBtnRef\.current\?\.focus\(\);/);
});
