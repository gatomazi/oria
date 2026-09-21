'use strict';

// Front · escopo da Store nas telas que indexam estado por loja (Automações, Templates).
//
// O servidor guarda vínculos de automação e histórico de envios sob a CHAVE de escopo da Store: a legada
// (`sul`) ou, na Store nativa, o `store_id`. Uma tela que usava só a chave legada (`useLojaAtiva() ?? ''`)
// recebia '' na Store nativa: a página de Automações não desenhava nenhuma loja e os vínculos de
// Templates nunca casavam. Estes testes leem o código REAL das telas.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');

const ler = (rel) => fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'src', rel), 'utf8');

test('Automações · indexa vínculos pela chave de escopo da Store, não só pela chave legada', () => {
  const fonte = ler('pages/automacoes/AutomacoesPage.tsx');
  assert.match(fonte, /const escopo = useChaveDaStore\(\);/);
  assert.doesNotMatch(fonte, /const escopo = useLojaAtiva\(\) \?\? ''/, 'o escopo de chave legada deixava a Store nativa sem card');
  assert.match(fonte, /mesmaLoja\(e\.loja, lojaLegada\)/, 'o log de eventos continua filtrado pela chave LEGADA (nula = nula)');
});

test('Templates · o vínculo evento→template casa pela chave de escopo', () => {
  const fonte = ler('pages/templates-detalhe/TemplatesDetalhePage.tsx');
  assert.match(fonte, /const selectLoja = useChaveDaStore\(\);/);
  assert.doesNotMatch(fonte, /useLojaAtiva/);
});

test('Nomes · a chave da Store nativa (id opaco) nunca aparece como nome de loja', () => {
  for (const arquivo of ['pages/templates/TemplatesPage.tsx', 'pages/mensagens-web/MensagemWebEditorPage.tsx']) {
    const fonte = ler(arquivo);
    assert.match(fonte, /adminStores\.nameOr\(v\.loja, nomeStore\)/, arquivo);
    assert.doesNotMatch(fonte, /adminStores\.name\(v\.loja\)/, arquivo);
  }
  const automacoes = ler('pages/automacoes/AutomacoesPage.tsx');
  // Só o helper de fallback pode chamar `adminStores.name(loja)`; as telas usam o helper.
  assert.equal((automacoes.match(/adminStores\.name\(loja\)/g) || []).length, 1);
  assert.match(automacoes, /function useNomeDaLoja\(\)/);
});

test('Sessão · o contexto de autenticação oferece a chave de escopo e o nome da Store', () => {
  const fonte = ler('auth/AuthContext.tsx');
  assert.match(fonte, /export function useChaveDaStore\(\): string/);
  assert.match(fonte, /o\?\.chaveEscopo \?\? o\?\.loja \?\? o\?\.storeId \?\? ''/);
  assert.match(fonte, /export function useNomeDaStore\(\): string/);
});

test('Automações · canal do WhatsApp com problema (token recusado, permissão, limite) não derruba a tela: avisa em texto de produto', () => {
  const fonte = ler('pages/automacoes/AutomacoesPage.tsx');
  assert.match(fonte, /err\.codigo\.startsWith\('WHATSAPP_'\)\) return \{ templates: \[\], avisoCanal: err\.message \}/);
  assert.match(fonte, /Canal do WhatsApp com problema/);
});

test('Rotas · endereço que não existe mostra "Página não encontrada" (nunca uma tela em branco) e Segmentos tem atalho', () => {
  const app = ler('App.tsx');
  assert.match(app, /<Route path="\*" element=\{<PaginaNaoEncontrada \/>\} \/>/);
  assert.match(app, /path="\/admin\/segmentos" element=\{<Navigate to="\/admin\/campanhas\/segmentos" replace \/>\}/);
  assert.match(ler('pages/PaginaNaoEncontrada.tsx'), /Página não encontrada/);
});

test('Clientes · a tela pagina no servidor (25 por página) e não ordena só a página pelo cabeçalho', () => {
  const fonte = ler('pages/clientes/ClientesPage.tsx');
  assert.match(fonte, /const CLIENTES_POR_PAGINA = 25;/);
  assert.match(fonte, /listClientes\(\{ page: pagina, perPage: CLIENTES_POR_PAGINA, ordem, busca: buscaAplicada, inativoDias: inatividade, tipo \}\)/, 'pede só a página atual, com busca/ordem/filtros');
  assert.match(fonte, /<option value="sem_pedido">Só cadastro \(nunca pediu\)<\/option>/, 'filtro de quem só tem cadastro');
  assert.match(fonte, /lista\.cadastro\.disponivel/, 'avisa quando o cadastro da Ink não respondeu');
  assert.match(fonte, /c\.origem === 'cadastro' \? 'Só cadastro' : 'Sem compra'/, 'a linha diz se é só cadastro');
  assert.match(fonte, /<Pagination[\s\S]*?onPrev=[\s\S]*?onNext=/, 'rodapé de paginação');
  assert.match(fonte, /sortable=\{false\}/, 'ordenar pelo cabeçalho reordenaria só a página e enganaria');
  assert.doesNotMatch(fonte, /getCustomers|cruzarComCompras/, 'a base é o histórico de pedidos, não a 1ª página do cadastro da Ink');
  assert.match(ler('api/clientes.ts'), /\/api\/admin\/clientes\/lista\?/);
});

test('WhatsApp · o card avisa quando a Meta recusa o token, sem sugerir que está tudo conectado', () => {
  const fonte = ler('pages/integracoes/WhatsappRemetenteCard.tsx');
  assert.match(fonte, /Token recusado pela Meta/);
  assert.match(fonte, /dados\.tokenInvalidoEm/);
});

test('Categorias e Agrupamentos · listas longas são paginadas (25 por página) e mostram o rodapé de paginação', () => {
  for (const [arquivo, chamada] of [['pages/categorias/CategoriasPage.tsx', 'listCategorias'], ['pages/agrupamentos/AgrupamentosPage.tsx', 'listAgrupamentos']]) {
    const fonte = ler(arquivo);
    assert.match(fonte, new RegExp(`${chamada}\\(\\{ page: pagina, perPage: \\w+ \\}\\)`), `${arquivo} pede só a página atual`);
    assert.match(fonte, /<Pagination[\s\S]*?onPrev=[\s\S]*?onNext=/, `${arquivo} mostra o rodapé de paginação`);
    assert.match(fonte, /useEffect\(carregar, \[lojaReal, pagina\]\)/, `${arquivo} recarrega ao trocar de página`);
  }
  assert.match(ler('pages/categorias/CategoriasPage.tsx'), /const CATEGORIAS_POR_PAGINA = 25;/);
  assert.match(ler('pages/agrupamentos/AgrupamentosPage.tsx'), /const AGRUPAMENTOS_POR_PAGINA = 25;/);
});

test('Trocas · o status da troca aparece em português (nunca o código cru da Ink)', () => {
  const trocas = ler('pages/trocas/TrocasPage.tsx');
  const drawer = ler('pages/trocas/TrocaDrawer.tsx');
  assert.match(trocas, /label=\{labelForExchangeStatus\(t\.status\)\}/);
  assert.match(drawer, /label=\{labelForExchangeStatus\(troca\.status\)\}/);
  const mapa = ler('lib/statusMap.ts');
  assert.match(mapa, /in_progress: 'Em andamento'/);
  assert.match(mapa, /waiting_for_approval: 'Aguardando aprovação'/);
});

test('Categorias · a listagem usa a contagem (product_count), não o array completo de ids', () => {
  assert.match(ler('pages/categorias/CategoriasPage.tsx'), /c\.product_count \?\? \(c\.product_ids \|\| \[\]\)\.length/);
});

test('Sidebar · Clientes tem item de navegação (a rota existia, mas nada levava até ela)', () => {
  const nav = ler('shell/nav.ts');
  assert.match(nav, /key: 'clientes', label: 'Clientes', href: '\/admin\/clientes'/, 'Clientes é item da sidebar');
  assert.ok(/'clientes':|\bclientes:/.test(nav.slice(nav.indexOf('NAV_ICON_PATHS'))), 'e tem ícone');
  // Como item de navegação ele fica ativo pelo href; uma entrada em ROUTE_CONTEXT o trataria como "fora do menu" (sem destaque).
  assert.doesNotMatch(nav, /match: \/\^\\\/admin\\\/clientes/, 'Clientes não é mais rota fora do menu');
  assert.match(ler('App.tsx'), /path="\/admin\/clientes"/, 'a rota continua registrada');
});
