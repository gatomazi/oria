'use strict';

// Custo das APIs (lib/custos/precos.js). O que está sob teste não é aritmética — é a honestidade do
// número: um total que esconde o que não foi medido, ou que chama de exato um preço chutado, leva o
// cliente a planejar gasto errado.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRECOS_PADRAO, CONFIANCAS, mesclarPrecos, precoDe, custoMensagens, custoGeracao,
  piorConfianca, totalizarCustos, validarPreco,
} = require('../lib/custos/precos');

// ── Tabela padrão ───────────────────────────────────────────────────────────────────────────

test('todo preço padrão declara de onde veio e o quanto vale confiar nele', () => {
  for (const p of PRECOS_PADRAO) {
    assert.ok(CONFIANCAS.includes(p.confianca), `${p.chave} sem confiança válida`);
    assert.ok(p.fonte, `${p.chave} sem fonte`);
    assert.ok(Number.isFinite(p.valor), `${p.chave} sem valor numérico`);
  }
});

test('preço do WhatsApp nunca se apresenta como confirmado', () => {
  // A Meta não publica a tabela em BRL; só a fatura do cliente confirma. Marcar como publicado aqui
  // faria a tela parar de avisar que o número é aproximado.
  for (const p of PRECOS_PADRAO.filter((x) => x.chave.startsWith('whatsapp.') && x.valor > 0)) {
    assert.equal(p.confianca, 'estimado', p.chave);
  }
});

test('mensagem de atendimento custa zero, e isso é fato publicado', () => {
  const p = precoDe(null, 'whatsapp.service');
  assert.equal(p.valor, 0);
  assert.equal(p.confianca, 'publicado');
});

// ── Edição pelo cliente ─────────────────────────────────────────────────────────────────────

test('valor editado pelo cliente vence o padrão e vira confirmado', () => {
  const precos = mesclarPrecos([{ chave: 'whatsapp.marketing', valor: 0.34, moeda: 'BRL' }]);
  const p = precoDe(precos, 'whatsapp.marketing');
  assert.equal(p.valor, 0.34);
  assert.equal(p.moeda, 'BRL');
  assert.equal(p.confianca, 'confirmado', 'quem tem a fatura é o cliente');
  assert.equal(p.editado, true);
});

test('linha não editada continua com o padrão e marcada como não editada', () => {
  const precos = mesclarPrecos([{ chave: 'whatsapp.marketing', valor: 0.34, moeda: 'BRL' }]);
  assert.equal(precoDe(precos, 'whatsapp.utility').editado, false);
});

test('preço salvo de chave desconhecida é ignorado, não cria linha nova', () => {
  const precos = mesclarPrecos([{ chave: 'inventado.xyz', valor: 99 }]);
  assert.equal(precos.length, PRECOS_PADRAO.length);
  assert.equal(precoDe(precos, 'inventado.xyz'), null);
});

// ── Custo de mensagens ──────────────────────────────────────────────────────────────────────

test('custo de mensagens multiplica pela quantidade e carrega a confiança do preço', () => {
  const r = custoMensagens('marketing', 200, mesclarPrecos([]));
  assert.ok(Math.abs(r.total - 12.5) < 1e-9, '200 × US$ 0,0625');
  assert.equal(r.confianca, 'estimado');
});

test('categoria sem preço devolve null, não zero', () => {
  // Zero desapareceria na soma; null faz a tela dizer que não sabe.
  assert.equal(custoMensagens('categoria_que_nao_existe', 100, mesclarPrecos([])), null);
});

test('mensagem de atendimento soma zero de verdade', () => {
  assert.equal(custoMensagens('service', 500, mesclarPrecos([])).total, 0);
});

// ── Custo de geração ────────────────────────────────────────────────────────────────────────

const CONSUMO_DETALHADO = {
  modeloImagem: 'gpt-image-2',
  tokensEntrada: 1500,
  tokensEntradaTexto: 300,
  tokensEntradaImagem: 1200,
  tokensEntradaCache: 0,
  tokensSaida: 1584,
};

test('geração com entrada detalhada cobra texto e imagem em preços diferentes', () => {
  const r = custoGeracao(CONSUMO_DETALHADO, mesclarPrecos([]));
  // 300×5/1M + 1200×8/1M = 0,0015 + 0,0096
  assert.ok(Math.abs(r.entrada - 0.0111) < 1e-9);
  // 1584×30/1M
  assert.ok(Math.abs(r.saida - 0.04752) < 1e-9);
  assert.equal(r.entradaNaoDetalhada, false);
});

test('sem a divisão da entrada, cobra pelo preço mais caro e assume a estimativa', () => {
  // Errar para cima é o erro certo: custo subestimado faz planejar gasto que não cabe.
  const r = custoGeracao(
    { modeloImagem: 'gpt-image-2', tokensEntrada: 1500, tokensSaida: 1584 },
    mesclarPrecos([])
  );
  assert.ok(Math.abs(r.entrada - 1500 * 8 / 1e6) < 1e-9, 'tudo pelo preço de imagem');
  assert.equal(r.entradaNaoDetalhada, true);
  assert.equal(r.confianca, 'estimado');
});

test('token em cache é cobrado mais barato que o normal', () => {
  const comCache = custoGeracao(
    { modeloImagem: 'gpt-image-2', tokensEntrada: 1000, tokensEntradaCache: 1000, tokensSaida: 0 },
    mesclarPrecos([])
  );
  const semCache = custoGeracao(
    { modeloImagem: 'gpt-image-2', tokensEntrada: 1000, tokensSaida: 0 },
    mesclarPrecos([])
  );
  assert.ok(comCache.entrada < semCache.entrada);
});

test('geração sem medição nenhuma devolve zero de custo mas nunca inventa tokens', () => {
  const r = custoGeracao({ modeloImagem: 'gpt-image-2' }, mesclarPrecos([]));
  assert.equal(r.total, 0);
  assert.equal(r.entradaNaoDetalhada, false, 'sem entrada não há entrada a estimar');
});

test('modelo sem preço cadastrado devolve null em vez de somar errado', () => {
  assert.equal(custoGeracao({ modeloImagem: 'modelo-inexistente', tokensSaida: 100 }, mesclarPrecos([])), null);
});

test('consumo ausente devolve null', () => {
  assert.equal(custoGeracao(null, mesclarPrecos([])), null);
});

// ── Confiança e totalização ─────────────────────────────────────────────────────────────────

test('a confiança de um total é a do seu pior componente', () => {
  assert.equal(piorConfianca(['confirmado', 'publicado']), 'publicado');
  assert.equal(piorConfianca(['confirmado', 'publicado', 'estimado']), 'estimado');
  assert.equal(piorConfianca(['confirmado']), 'confirmado');
});

test('uma única linha estimada torna o total inteiro uma estimativa', () => {
  const t = totalizarCustos([
    { total: 10, moeda: 'USD', confianca: 'publicado' },
    { total: 5, moeda: 'USD', confianca: 'estimado' },
  ]);
  assert.equal(t.total, 15);
  assert.equal(t.confianca, 'estimado');
});

test('total carrega quanto ficou de fora por não ter sido medido', () => {
  // Sem isso a tela fingiria que o total cobre tudo.
  const t = totalizarCustos([{ total: 10, moeda: 'USD', confianca: 'publicado' }], { naoMedido: 7 });
  assert.equal(t.naoMedido, 7);
});

test('moedas diferentes não são somadas como se fossem a mesma', () => {
  const t = totalizarCustos([
    { total: 10, moeda: 'USD', confianca: 'publicado' },
    { total: 50, moeda: 'BRL', confianca: 'confirmado' },
  ]);
  assert.equal(t.moedasMisturadas, true);
  assert.equal(t.moeda, null, 'sem moeda única, a tela precisa separar em vez de exibir um total');
});

test('lista vazia devolve zero e nenhuma moeda misturada', () => {
  const t = totalizarCustos([]);
  assert.equal(t.total, 0);
  assert.equal(t.moedasMisturadas, false);
});

// ── Validação da edição ─────────────────────────────────────────────────────────────────────

test('recusa preço de chave que não existe', () => {
  assert.ok(validarPreco({ chave: 'nao.existe', valor: 1 }).erros);
});

test('aceita zero, recusa negativo', () => {
  assert.ok(validarPreco({ chave: 'whatsapp.service', valor: 0 }).preco, 'atendimento custa zero');
  assert.ok(validarPreco({ chave: 'whatsapp.marketing', valor: -1 }).erros);
});

test('recusa moeda fora do formato de 3 letras', () => {
  assert.match(validarPreco({ chave: 'whatsapp.marketing', valor: 1, moeda: 'reais' }).erros[0], /moeda/);
});

test('preço válido sai normalizado com moeda em maiúsculas', () => {
  const r = validarPreco({ chave: 'whatsapp.marketing', valor: '0.34', moeda: 'brl' });
  assert.deepEqual(r.preco, { chave: 'whatsapp.marketing', valor: 0.34, moeda: 'BRL', confianca: 'confirmado' });
});
