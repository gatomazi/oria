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

test('WhatsApp · o card avisa quando a Meta recusa o token, sem sugerir que está tudo conectado', () => {
  const fonte = ler('pages/integracoes/WhatsappRemetenteCard.tsx');
  assert.match(fonte, /Token recusado pela Meta/);
  assert.match(fonte, /dados\.tokenInvalidoEm/);
});
