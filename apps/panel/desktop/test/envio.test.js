'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MotorEnvio, TokenInvalidoError, montarUrlConversa, appEsperado } = require('../src/envio');
const { validarConfig, PADRAO } = require('../src/config');
const { criarClientePainel, validarUrlPainel } = require('../src/painel');

// Relógio falso: dormir só avança o tempo, sem esperar de verdade.
function criarMotor({ config = {}, primeiroPlano = 'WhatsApp', ocioso = 60, claim = null, heartbeat = { ok: true, ativo: true } } = {}) {
  const chamadas = { urls: [], enters: 0, abasFechadas: 0, resultados: [], claims: 0, heartbeats: [], estados: [] };
  let relogio = 1_000_000;
  const motor = new MotorEnvio({
    painel: {
      heartbeat: async (dados) => {
        chamadas.heartbeats.push(dados);
        if (heartbeat instanceof Error) throw heartbeat;
        return heartbeat;
      },
      claim: async () => {
        chamadas.claims += 1;
        return claim || { item: null, motivo: 'fila_vazia' };
      },
      resultado: async (id, corpo) => { chamadas.resultados.push({ id, ...corpo }); return { ok: true }; },
    },
    automacao: {
      appEmPrimeiroPlano: async () => (typeof primeiroPlano === 'function' ? primeiroPlano() : primeiroPlano),
      pressionarEnter: async () => { chamadas.enters += 1; },
      fecharAba: async () => { chamadas.abasFechadas += 1; },
    },
    abrirUrl: async (url) => { chamadas.urls.push(url); },
    obterTempoOciosoSeg: () => (typeof ocioso === 'function' ? ocioso() : ocioso),
    obterConfig: () => ({ ...PADRAO, ...config }),
    agora: () => relogio,
    dormir: async (ms) => { relogio += ms; },
    aleatorio: () => 0,
    versao: 'teste',
    plataforma: 'darwin',
    aoMudarEstado: (estado) => chamadas.estados.push(estado),
  });
  return { motor, chamadas };
}

test('montarUrlConversa monta link do Desktop e do navegador com texto codificado', () => {
  assert.equal(montarUrlConversa('desktop', '+55 (48) 99999-0001', 'Oi\n*tudo bem?*'), 'whatsapp://send?phone=5548999990001&text=Oi%0A*tudo%20bem%3F*');
  assert.equal(montarUrlConversa('navegador', '5548999990001', 'a&b'), 'https://web.whatsapp.com/send?phone=5548999990001&text=a%26b');
  assert.throws(() => montarUrlConversa('desktop', '123', 'x'), /telefone inválido/);
});

test('appEsperado compara por trecho sem diferenciar maiúsculas', () => {
  assert.equal(appEsperado('desktop', 'WhatsApp'), true);
  assert.equal(appEsperado('desktop', 'WhatsApp.Root'), true);
  assert.equal(appEsperado('desktop', 'Google Chrome'), false);
  assert.equal(appEsperado('navegador', 'Google Chrome'), true);
  assert.equal(appEsperado('navegador', 'msedge'), true);
  assert.equal(appEsperado('navegador', 'Finder'), false);
});

test('Desktop: abre a conversa, aperta Enter uma vez e não fecha aba', async () => {
  const { motor, chamadas } = criarMotor();
  const resultado = await motor.enviarMensagem('5548999990001', 'Olá');
  assert.deepEqual(resultado, { status: 'sent' });
  assert.equal(chamadas.urls[0], 'whatsapp://send?phone=5548999990001&text=Ol%C3%A1');
  assert.equal(chamadas.enters, 1);
  assert.equal(chamadas.abasFechadas, 0);
});

test('Navegador: envia e fecha a aba aberta', async () => {
  const { motor, chamadas } = criarMotor({ config: { modo: 'navegador' }, primeiroPlano: 'Google Chrome' });
  const resultado = await motor.enviarMensagem('5548999990001', 'Olá');
  assert.equal(resultado.status, 'sent');
  assert.match(chamadas.urls[0], /^https:\/\/web\.whatsapp\.com\/send\?/);
  assert.equal(chamadas.enters, 1);
  assert.equal(chamadas.abasFechadas, 1);
});

test('não aperta Enter se o WhatsApp não estiver em primeiro plano', async () => {
  const { motor, chamadas } = criarMotor({ primeiroPlano: 'Visual Studio Code' });
  const resultado = await motor.enviarMensagem('5548999990001', 'Olá');
  assert.equal(resultado.status, 'failed');
  assert.equal(resultado.codigo, 'app_nao_abriu');
  assert.equal(chamadas.enters, 0);
});

test('computador em uso o tempo todo: não aperta Enter e reporta interrompido', async () => {
  const { motor, chamadas } = criarMotor({ ocioso: 0 });
  const resultado = await motor.enviarMensagem('5548999990001', 'Olá');
  assert.equal(resultado.codigo, 'interrompido');
  assert.equal(chamadas.enters, 0);
});

test('usuário para de mexer no meio da espera: envia normalmente', async () => {
  let leituras = 0;
  const { motor, chamadas } = criarMotor({ ocioso: () => (leituras++ < 3 ? 0 : 30) });
  const resultado = await motor.enviarMensagem('5548999990001', 'Olá');
  assert.equal(resultado.status, 'sent');
  assert.equal(chamadas.enters, 1);
});

test('ciclo: com o computador em uso não reserva item da fila', async () => {
  const { motor, chamadas } = criarMotor({ ocioso: 1, config: { ociosoSeg: 10 } });
  motor.pausado = false;
  await motor.ciclo();
  assert.equal(chamadas.claims, 0);
  assert.equal(motor.estado.detalhe, 'Aguardando você parar de usar o computador');
});

test('ciclo: envia o item reservado e reporta sent sem confirmação', async () => {
  const item = { id: '11111111-1111-4111-8111-111111111111', telefone: '5548999990001', texto: 'Oi' };
  const { motor, chamadas } = criarMotor({ claim: { item } });
  motor.pausado = false;
  await motor.ciclo();
  assert.deepEqual(chamadas.resultados, [{ id: item.id, status: 'sent', confirmado: false }]);
  assert.equal(motor.estado.enviadosSessao, 1);
});

test('ciclo: falha vira resultado failed com código', async () => {
  const item = { id: '22222222-2222-4222-8222-222222222222', telefone: '5548999990001', texto: 'Oi' };
  const { motor, chamadas } = criarMotor({ claim: { item }, primeiroPlano: 'Finder' });
  motor.pausado = false;
  await motor.ciclo();
  assert.equal(chamadas.resultados[0].status, 'failed');
  assert.equal(chamadas.resultados[0].codigo, 'app_nao_abriu');
  assert.equal(motor.estado.falhasSessao, 1);
});

test('ciclo: modo desligado no painel não reserva item', async () => {
  const { motor, chamadas } = criarMotor({ heartbeat: { ok: true, ativo: false } });
  motor.pausado = false;
  await motor.ciclo();
  assert.equal(chamadas.claims, 0);
});

test('loop: token recusado pausa o envio e sinaliza o erro', async () => {
  const { motor } = criarMotor({ heartbeat: new TokenInvalidoError('recusado') });
  // Encerra o loop assim que ele pausar (o relógio falso não deixa um timer externo rodar).
  const pausarOriginal = motor.pausar.bind(motor);
  motor.pausar = () => { pausarOriginal(); motor.encerrar = true; };
  motor.pausado = false;
  await motor.loop();
  assert.equal(motor.pausado, true);
  assert.equal(motor.estado.ultimoErro, 'token_invalido');
});

test('validarConfig: exige https (http só em localhost) e pausas coerentes', () => {
  assert.match(validarConfig({ painelUrl: 'http://painel.com' }).erro, /https/);
  assert.equal(validarConfig({ painelUrl: 'http://localhost:18080/admin' }).config.painelUrl, 'http://localhost:18080');
  assert.equal(validarConfig({ painelUrl: 'https://painel.com/x' }).config.painelUrl, 'https://painel.com');
  assert.match(validarConfig({ pausaMinSeg: 30, pausaMaxSeg: 10 }).erro, /pausa mínima/);
  assert.match(validarConfig({ esperaDesktopSeg: 999 }).erro, /esperaDesktopSeg/);
  assert.match(validarConfig({ modo: 'selenium' }).erro, /modo/);
});

test('validarUrlPainel rejeita esquemas estranhos', () => {
  assert.equal(validarUrlPainel('javascript:alert(1)'), null);
  assert.equal(validarUrlPainel('ftp://x.com'), null);
});

test('cliente do painel: 401 lança token inválido e 409 não é erro', async () => {
  const respostas = [{ status: 401, ok: false }, { status: 409, ok: false }];
  const painel = criarClientePainel({
    obterUrl: () => 'https://painel.com',
    obterToken: () => 'x'.repeat(40),
    fetchImpl: async () => respostas.shift(),
  });
  await assert.rejects(() => painel.heartbeat({}), TokenInvalidoError);
  assert.deepEqual(await painel.resultado('33333333-3333-4333-8333-333333333333', { status: 'sent' }), { conflito: true });
});

test('testar: mostra "testando" (mesmo pausado), avisa o painel e volta pra pausado', async () => {
  const { motor, chamadas } = criarMotor();
  const resultado = await motor.testar('5548999990001', 'teste');
  assert.equal(resultado.status, 'sent');
  assert.ok(chamadas.estados.some((e) => e.situacao === 'testando' && e.pausado === true));
  assert.ok(chamadas.heartbeats.some((h) => h.testando === true));
  assert.equal(motor.estado.situacao, 'pausado');
  assert.equal(motor.testando, false);
  assert.equal(chamadas.heartbeats.at(-1).testando, false);
});

test('iniciar e pausar avisam o painel na hora', async () => {
  const { motor, chamadas } = criarMotor();
  motor.conectar = () => {};
  motor.iniciar();
  motor.pausar();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chamadas.heartbeats.map((h) => h.pausado), [false, true]);
});

test('teste e mensagem da fila nunca digitam ao mesmo tempo', async () => {
  const { motor } = criarMotor();
  const ordem = [];
  let emAndamento = 0;
  const tarefa = (nome) => async () => {
    emAndamento += 1;
    assert.equal(emAndamento, 1, 'duas tarefas ao mesmo tempo');
    ordem.push(`${nome}:inicio`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    ordem.push(`${nome}:fim`);
    emAndamento -= 1;
  };
  await Promise.all([motor.exclusivo(tarefa('fila')), motor.exclusivo(tarefa('teste'))]);
  assert.deepEqual(ordem, ['fila:inicio', 'fila:fim', 'teste:inicio', 'teste:fim']);
});
