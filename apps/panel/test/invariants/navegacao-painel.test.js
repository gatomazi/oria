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
