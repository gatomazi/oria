'use strict';

// Rodada 7 — campanha AGENDADA cuja definição é recusada: não dispara, continua agendada, o motivo fica registrado e visível, e ela não
// monopoliza a janela do agendador. Tudo com `iniciar` falso: nenhum envio, nenhum banco.

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRegistroDeBloqueios, iniciarAgendadasVencidas, ehBloqueioDeAudiencia, ESPERA_APOS_BLOQUEIO_MS } = require('../lib/campanhas/agendadas');
const { ErroAudienciaFiltro, diagnosticarDefinicao, filtroTodosClientes } = require('../lib/campanhas/audiencia-filtros');
const { ErroAudienciaRfm } = require('../lib/clientes/audiencia-rfm');

const logger = () => { const l = { erros: [], error: (m) => l.erros.push(m) }; return l; };
const invalida = () => new ErroAudienciaFiltro('AUDIENCIA_FILTRO_INVALIDO', 'A definição da audiência tem um problema: condição 1 (cidade): campo desconhecido', [{ indice: 0, campo: 'cidade', operador: null, motivo: 'campo desconhecido' }]);

test('ehBloqueioDeAudiencia: só erro TIPADO de audiência/RFM é bloqueio; falha transitória não recebe rótulo', () => {
  assert.equal(ehBloqueioDeAudiencia(invalida()), true);
  assert.equal(ehBloqueioDeAudiencia(new ErroAudienciaRfm('RFM_REGRA_DIVERGENTE', 'x')), true);
  assert.equal(ehBloqueioDeAudiencia(Object.assign(new Error('x'), { codigo: 'RFM_SEGMENTO_APROXIMADO' })), true);
  assert.equal(ehBloqueioDeAudiencia(new Error('ECONNRESET')), false);
  assert.equal(ehBloqueioDeAudiencia(Object.assign(new Error('x'), { codigo: 'OUTRO' })), false);
  assert.equal(ehBloqueioDeAudiencia(null), false);
});

test('agendador: definição recusada NÃO inicia, registra o motivo (com detalhes) e loga UMA vez por causa; sucesso limpa o registro', async () => {
  const bloqueios = criarRegistroDeBloqueios();
  const log = logger();
  const iniciadas = [];
  const iniciar = async (c) => { if (c.id === 'ruim') throw invalida(); iniciadas.push(c.id); };
  const r1 = await iniciarAgendadasVencidas({ campanhas: [{ id: 'ruim' }, { id: 'boa' }], iniciar, bloqueios, logger: log });
  assert.deepEqual(r1, { iniciadas: 1, bloqueadas: 1, falhas: 0 });
  assert.deepEqual(iniciadas, ['boa'], 'a válida é iniciada mesmo com a recusada antes dela');
  const b = bloqueios.obter('ruim');
  assert.equal(b.codigo, 'AUDIENCIA_FILTRO_INVALIDO');
  assert.match(b.mensagem, /cidade/);
  assert.equal(b.origem, 'agendador');
  assert.deepEqual(b.detalhes.map((d) => d.campo), ['cidade']);
  assert.equal(log.erros.length, 1);
  // 2º ciclo: mesma causa → registro atualizado (ultimaTentativa), SEM novo log
  await iniciarAgendadasVencidas({ campanhas: [{ id: 'ruim' }], iniciar, bloqueios, logger: log });
  assert.equal(log.erros.length, 1, 'mesma campanha+causa: não repete o log a cada ciclo');
  // causa nova → loga de novo
  const trocada = async () => { throw new ErroAudienciaRfm('RFM_REGRA_DIVERGENTE', 'A regra RFM mudou'); };
  await iniciarAgendadasVencidas({ campanhas: [{ id: 'ruim' }], iniciar: trocada, bloqueios, logger: log });
  assert.equal(log.erros.length, 2);
  assert.equal(bloqueios.obter('ruim').codigo, 'RFM_REGRA_DIVERGENTE');
  // corrigida: inicia e o motivo some
  await iniciarAgendadasVencidas({ campanhas: [{ id: 'ruim' }], iniciar: async () => {}, bloqueios, logger: log });
  assert.equal(bloqueios.obter('ruim'), null);
});

test('falha transitória (erro não tipado) é logada a cada ciclo e NÃO vira "bloqueada" nem some com o registro de outro motivo', async () => {
  const bloqueios = criarRegistroDeBloqueios();
  const log = logger();
  const r = await iniciarAgendadasVencidas({ campanhas: [{ id: '1' }], iniciar: async () => { throw new Error('ECONNRESET'); }, bloqueios, logger: log });
  assert.deepEqual(r, { iniciadas: 0, bloqueadas: 0, falhas: 1 });
  assert.equal(bloqueios.obter('1'), null);
  await iniciarAgendadasVencidas({ campanhas: [{ id: '1' }], iniciar: async () => { throw new Error('ECONNRESET'); }, bloqueios, logger: log });
  assert.equal(log.erros.length, 2);
});

test('janela do agendador: campanhas bloqueadas há pouco ficam em espera (não monopolizam os 5 lugares) e voltam depois da espera', () => {
  const bloqueios = criarRegistroDeBloqueios();
  for (const id of ['1', '2', '3', '4', '5']) bloqueios.registrar(id, invalida());
  assert.deepEqual(bloqueios.idsEmEspera().sort(), ['1', '2', '3', '4', '5']);
  const agora = Date.now();
  assert.deepEqual(bloqueios.idsEmEspera(ESPERA_APOS_BLOQUEIO_MS, agora + ESPERA_APOS_BLOQUEIO_MS + 1000), [], 'passada a espera, voltam a ser tentadas');
  bloqueios.limpar('3');
  assert.ok(!bloqueios.idsEmEspera().includes('3'), 'editar/excluir limpa o registro');
});

test('diagnóstico estático da definição salva: o que o administrador vê antes mesmo de o agendador tentar', () => {
  const ok = { match: 'ALL', filtros: [{ field: 'uf', value: 'RS' }], exclusoes: {} };
  assert.equal(diagnosticarDefinicao(ok, { agendada: true }), null);
  assert.equal(diagnosticarDefinicao({}, { agendada: false }), null, 'rascunho ainda vazio não é bloqueio');
  assert.equal(diagnosticarDefinicao({ match: 'ALL', filtros: [], exclusoes: {} }, { agendada: false }), null, 'rascunho sem condição ainda em montagem');
  const vazioAgendada = diagnosticarDefinicao({ match: 'ALL', filtros: [], exclusoes: {} }, { agendada: true });
  assert.equal(vazioAgendada.codigo, 'AUDIENCIA_SEM_FILTRO', 'agendada sem condição explícita é bloqueio');
  assert.equal(diagnosticarDefinicao({}, { agendada: true }).codigo, 'AUDIENCIA_SEM_FILTRO');
  for (const agendada of [true, false]) {
    const inv = diagnosticarDefinicao({ match: 'ALL', filtros: [{ field: 'cidade', value: 'POA' }], exclusoes: {} }, { agendada });
    assert.equal(inv.codigo, 'AUDIENCIA_FILTRO_INVALIDO');
    assert.equal(inv.origem, 'definicao');
    assert.equal(inv.detalhes[0].campo, 'cidade');
  }
  assert.equal(diagnosticarDefinicao({ match: 'ALL', filtros: [filtroTodosClientes()], exclusoes: {} }, { agendada: true }), null, '"todos" explícito é válido');
});

test('o agendador do servidor usa este caminho (sem `catch` próprio que só logue) e pula as campanhas em espera', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const trecho = src.slice(src.indexOf('async function iniciarCampanhasAgendadasVencidas()'));
  const corpo = trecho.slice(0, trecho.indexOf('\n}\n'));
  assert.match(corpo, /bloqueiosDeCampanha\.idsEmEspera\(\)/);
  assert.match(corpo, /NOT \(id = ANY\(\$1::bigint\[\]\)\)/);
  assert.match(corpo, /campanhasAgendadas\.iniciarAgendadasVencidas\(\{ campanhas: rows, iniciar: iniciarDisparoCampanha, bloqueios: bloqueiosDeCampanha \}\)/);
  assert.doesNotMatch(corpo, /catch/);
});
