'use strict';

// Rodada 5 — otimizações de desempenho da RFM não podem mudar NENHUM resultado. As saídas de `analisarRfm` sobre massas
// sintéticas determinísticas (test/helpers/dataset-rfm-desempenho.cjs) foram fixadas por hash ANTES da otimização (código da
// Rodada 4) e têm de continuar iguais. Se uma regra de negócio mudar de propósito, os hashes mudam junto — e isso é uma decisão.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { gerar, ASOF } = require('./helpers/dataset-rfm-desempenho.cjs');
const { analisarRfm, compararPedidosRecentesPrimeiro, ordenarRecentesPrimeiro } = require('../lib/clientes/analise');

const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

const OURO = [
  { n: 300, rfm: 'bec0643c849d0bbb', ordem: '446eed2d3343b009', linhas: 300, universo: 206 },
  { n: 5000, rfm: 'dcfc10954776927a', ordem: 'c9bf3d0118efbadf', linhas: 4995, universo: 3234 },
  { n: 40000, rfm: 'ef377230d4a97e89', ordem: 'ef8cb09828cfbb1c', linhas: 39960, universo: 25900 },
];

for (const o of OURO) {
  test(`equivalência (${o.n} pedidos sintéticos): classificação RFM, ordem canônica e deduplicação idênticas às da Rodada 4`, () => {
    const linhas = gerar(o.n);
    const r = analisarRfm(linhas, { asOf: ASOF, fuso: 'America/Sao_Paulo', chaveDoContexto: 'sul' });
    assert.equal(r.linhas.length, o.linhas, 'deduplicação');
    assert.equal(r.rfm.universo, o.universo);
    assert.equal(hash(r.rfm), o.rfm, 'classificação RFM completa (regra, cortes, clientes, segmentos)');
    const canonica = [...linhas].sort(compararPedidosRecentesPrimeiro).map((l) => `${l.ink_order_id}|${l.loja}`);
    assert.equal(hash(canonica), o.ordem, 'comparador canônico');
    // A ordenação com chave pré-calculada é EXATAMENTE a do comparador (estável, mesmos empates).
    assert.deepEqual(ordenarRecentesPrimeiro(linhas).map((l) => `${l.ink_order_id}|${l.loja}`), canonica);
  });
}

test('a massa cobre o que importa: horário de verão de SP (2018/19), viradas de dia locais e pedidos duplicados', () => {
  const linhas = gerar(5000);
  const ms = linhas.map((l) => new Date(l.criado_em).getTime());
  assert.ok(ms.some((t) => t >= Date.parse('2018-11-01') && t <= Date.parse('2019-02-28')), 'período de horário de verão');
  const minutosLocais = new Set(linhas.map((l) => new Date(l.criado_em).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })));
  assert.ok(minutosLocais.has('00:00') || minutosLocais.has('23:59') || minutosLocais.has('00:01'));
  assert.ok(new Set(linhas.map((l) => l.ink_order_id)).size < linhas.length, 'há ink_order_id repetido');
});
