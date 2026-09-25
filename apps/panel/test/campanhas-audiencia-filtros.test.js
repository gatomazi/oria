'use strict';

// Rodada 6 — contrato ÚNICO e fail-closed da definição de audiência (lib/campanhas/audiencia-filtros.js).
// Nenhuma condição inválida pode ser descartada em silêncio, avaliada pela metade (AND/OR) ou virar "todos os clientes".

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ErroAudienciaFiltro, validarDefinicaoAudiencia, filtroTodosClientes, CODIGO_INVALIDO, CODIGO_SEM_FILTRO,
} = require('../lib/campanhas/audiencia-filtros');
const { ErroAudienciaRfm, filtroRfmDoSegmento } = require('../lib/clientes/audiencia-rfm');

const def = (filtros, extra = {}) => ({ match: 'ALL', filtros, exclusoes: {}, ...extra });
const lanca = (fn, codigo = CODIGO_INVALIDO) => assert.throws(fn, (e) => e instanceof ErroAudienciaFiltro && e.codigo === codigo && e.status === 400);

// ── 1. Formatos legados VÁLIDOS continuam funcionando (compatibilidade) ─────────────────────────────
const VALIDOS = [
  ['numérico gte', { field: 'diasSemComprar', op: 'gte', value: 46 }],
  ['numérico lte', { field: 'diasSemComprar', op: 'lte', value: 90 }],
  ['quantidade lt', { field: 'quantidadePedidos', op: 'lt', value: 3 }],
  ['total gasto (decimal)', { field: 'totalGasto', op: 'lt', value: 242.73 }],
  ['ticket médio eq', { field: 'ticketMedio', op: 'eq', value: 0 }],
  ['uf sem operador (construtor do front)', { field: 'uf', value: 'RS' }],
  ['uf com eq e minúscula', { field: 'uf', op: 'eq', value: 'sp' }],
  ['opt-in sem operador', { field: 'optIn', value: true }],
  ['opt-in falso', { field: 'optIn', value: false }],
  ['carrinho abandonado', { field: 'temCarrinhoAbandonado', value: true }],
  ['recebeu campanha (id texto)', { field: 'recebeuCampanha', value: { campanhaId: '12' } }],
  ['nunca recebeu (id inteiro)', { field: 'naoRecebeuCampanha', value: { campanhaId: 12 } }],
  ['recebeu nos últimos dias', { field: 'recebeuCampanhaNosUltimosDias', value: { dias: 7 } }],
];
for (const [nome, filtro] of VALIDOS) {
  test(`válido (legado): ${nome}`, () => {
    for (const match of ['ALL', 'ANY']) {
      const r = validarDefinicaoAudiencia({ match, filtros: [filtro], exclusoes: {} });
      assert.equal(r.match, match);
      assert.equal(r.filtros.length, 1);
      assert.equal(r.universal, false);
      assert.equal(r.rfm, null);
    }
  });
}

test('válido: a tradução genérica de um segmento RFM antigo (4 filtros) segue aceita, nada é reescrito', () => {
  const filtros = [
    { field: 'diasSemComprar', op: 'gte', value: 46 }, { field: 'diasSemComprar', op: 'lte', value: 90 },
    { field: 'quantidadePedidos', op: 'gte', value: 1 }, { field: 'quantidadePedidos', op: 'lte', value: 1 },
    { field: 'totalGasto', op: 'lt', value: 134.9 },
  ];
  const copia = JSON.stringify(filtros);
  const r = validarDefinicaoAudiencia(def(filtros));
  assert.equal(r.filtros.length, 5);
  assert.equal(JSON.stringify(filtros), copia, 'a definição de entrada não é mutada');
});

test('válido: condições + exclusões conhecidas; padrões protetores (opt-in e telefone) ficam ligados quando omitidos', () => {
  const r = validarDefinicaoAudiencia(def([{ field: 'uf', value: 'RS' }], { exclusoes: { compradoNosUltimosDias: 7, recebeuCampanhaNasUltimasHoras: 48 } }));
  assert.deepEqual(r.exclusoes, { semOptIn: true, numeroInvalido: true, compradoNosUltimosDias: 7, recebeuCampanhaNasUltimasHoras: 48 });
  assert.equal(validarDefinicaoAudiencia(def([{ field: 'uf', value: 'RS' }], { exclusoes: { semOptIn: false, numeroInvalido: false } })).exclusoes.semOptIn, false);
});

// ── 2. Campo, operador, tipo e valor inválidos LANÇAM (nunca descartam) ─────────────────────────────
const INVALIDOS = [
  ['campo desconhecido', { field: 'cidade', op: 'eq', value: 'Porto Alegre' }, /campo desconhecido: "cidade"/],
  ['campo com erro de digitação', { field: 'diasSemCompra', op: 'gte', value: 30 }, /campo desconhecido/],
  ['campo ausente', { op: 'gte', value: 1 }, /campo ausente/],
  ['operador ausente em campo numérico', { field: 'totalGasto', value: 100 }, /operador inválido/],
  ['operador desconhecido em campo numérico', { field: 'totalGasto', op: 'between', value: 100 }, /operador inválido/],
  ['operador de comparação em booleano', { field: 'optIn', op: 'gt', value: true }, /só aceita o operador eq/],
  ['operador de comparação em uf', { field: 'uf', op: 'gte', value: 'RS' }, /só aceita o operador eq/],
  ['operador em recebeuCampanha', { field: 'recebeuCampanha', op: 'eq', value: { campanhaId: '1' } }, /não usa operador/],
  ['valor numérico como texto', { field: 'diasSemComprar', op: 'gte', value: '45' }, /número/],
  ['valor NaN', { field: 'totalGasto', op: 'gte', value: Number.NaN }, /número/],
  ['valor infinito', { field: 'totalGasto', op: 'gte', value: Infinity }, /número/],
  ['valor negativo', { field: 'ticketMedio', op: 'gte', value: -1 }, /maior ou igual a zero/],
  ['valor nulo', { field: 'quantidadePedidos', op: 'gte', value: null }, /número/],
  ['dias não inteiros', { field: 'diasSemComprar', op: 'gte', value: 45.5 }, /inteiro/],
  ['booleano como texto', { field: 'optIn', value: 'true' }, /verdadeiro ou falso/],
  ['booleano como número', { field: 'temCarrinhoAbandonado', value: 1 }, /verdadeiro ou falso/],
  ['UF inexistente', { field: 'uf', value: 'XX' }, /sigla de um estado/],
  ['UF vazia', { field: 'uf', value: '' }, /sigla de um estado/],
  ['UF como objeto', { field: 'uf', value: { sigla: 'RS' } }, /sigla de um estado/],
  ['campanhaId ausente', { field: 'recebeuCampanha', value: {} }, /campanhaId/],
  ['campanhaId vazio', { field: 'naoRecebeuCampanha', value: { campanhaId: '  ' } }, /campanhaId/],
  ['recebeuCampanha com valor escalar', { field: 'recebeuCampanha', value: 12 }, /campanhaId/],
  ['dias fora da faixa', { field: 'recebeuCampanhaNosUltimosDias', value: { dias: 0 } }, /entre 1 e 3650/],
  ['dias como texto', { field: 'recebeuCampanhaNosUltimosDias', value: { dias: '7' } }, /entre 1 e 3650/],
  ['chave desconhecida na condição', { field: 'uf', value: 'RS', extra: 1 }, /chaves desconhecidas/],
  ['condição nula', null, /não é um objeto/],
  ['condição em texto', 'diasSemComprar>45', /não é um objeto/],
  ['condição em lista', ['diasSemComprar', 'gte', 45], /não é um objeto/],
  ['todosClientes com valor falso', { field: 'todosClientes', value: false }, /value: true/],
];
for (const [nome, filtro, padrao] of INVALIDOS) {
  test(`inválido: ${nome} → AUDIENCIA_FILTRO_INVALIDO, com ALL e com ANY, sem avaliação parcial`, () => {
    for (const match of ['ALL', 'ANY']) {
      assert.throws(() => validarDefinicaoAudiencia({ match, filtros: [filtro], exclusoes: {} }), (e) => {
        assert.ok(e instanceof ErroAudienciaFiltro && e.codigo === CODIGO_INVALIDO && e.status === 400);
        assert.match(e.message, padrao, 'a mensagem diz o problema');
        assert.match(e.message, /nada foi calculado nem enviado/, 'a mensagem diz o que aconteceu');
        assert.equal(e.detalhes[0].indice, 0, 'aponta a condição problemática');
        return true;
      });
    }
  });
}

test('condição mista válida + inválida: a definição INTEIRA é recusada (nunca só a parte válida), com ALL e ANY; todos os problemas listados', () => {
  const filtros = [
    { field: 'diasSemComprar', op: 'gte', value: 45 }, // válida
    { field: 'cidade', op: 'eq', value: 'POA' }, //      campo desconhecido
    { field: 'totalGasto', op: 'gte', value: '100' }, // tipo inválido
    { field: 'uf', value: 'RS' }, //                      válida
  ];
  for (const match of ['ALL', 'ANY']) {
    assert.throws(() => validarDefinicaoAudiencia({ match, filtros, exclusoes: {} }), (e) => {
      assert.equal(e.codigo, CODIGO_INVALIDO);
      assert.deepEqual(e.detalhes.map((d) => [d.indice, d.campo]), [[1, 'cidade'], [2, 'totalGasto']]);
      assert.equal(e.detalhes[1].operador, 'gte');
      assert.match(e.message, /2 problemas/);
      return true;
    });
  }
});

test('o defeito antigo, isolado: descartar campo desconhecido deixaria a audiência UNIVERSAL — e o contrato novo a recusa', () => {
  // Reprodução do comportamento removido (server.js até a Rodada 5): filtra pelos campos conhecidos e, sem nenhum, casa com todos.
  const conhecidos = ['diasSemComprar', 'quantidadePedidos', 'totalGasto', 'ticketMedio', 'uf', 'optIn'];
  const legadoDescartava = (filtros) => filtros.filter((f) => f && conhecidos.includes(f.field));
  const so = [{ field: 'cidade', op: 'eq', value: 'POA' }];
  assert.equal(legadoDescartava(so).length, 0, 'antes: nenhuma condição sobrava → "todos os clientes"');
  lanca(() => validarDefinicaoAudiencia(def(so)));
});

// ── 3. match, lista, vazio e "todos os clientes" explícito ──────────────────────────────────────────
test('match ausente, minúsculo ou desconhecido não vira "ALL" em silêncio', () => {
  for (const match of [undefined, null, 'all', 'any', 'OR', '', 1]) lanca(() => validarDefinicaoAudiencia({ match, filtros: [{ field: 'uf', value: 'RS' }], exclusoes: {} }));
});

test('filtros que não é lista → inválido', () => {
  for (const filtros of ['diasSemComprar', 5, { field: 'uf', value: 'RS' }, true]) lanca(() => validarDefinicaoAudiencia({ match: 'ALL', filtros, exclusoes: {} }));
});

test('sem condição alguma (lista vazia, ausente, {} ou nulo) é AUDIENCIA_SEM_FILTRO — nunca "todos os clientes"', () => {
  for (const d of [def([]), { match: 'ALL', exclusoes: {} }, {}, null, undefined, { match: 'ANY', filtros: [] }]) lanca(() => validarDefinicaoAudiencia(d), CODIGO_SEM_FILTRO);
  assert.throws(() => validarDefinicaoAudiencia(def([])), (e) => /confirme explicitamente "todos os clientes"/.test(e.message));
});

test('"todos os clientes" só existe quando escolhido de forma explícita, sozinho, e continua sujeito às exclusões comerciais', () => {
  const r = validarDefinicaoAudiencia(def([filtroTodosClientes()]));
  assert.equal(r.universal, true);
  assert.deepEqual(r.filtros, []);
  assert.equal(r.exclusoes.semOptIn, true, 'opt-in continua excluído por padrão');
  assert.equal(r.exclusoes.numeroInvalido, true);
  // combinado com qualquer outra condição: inválido (ambíguo)
  lanca(() => validarDefinicaoAudiencia(def([filtroTodosClientes(), { field: 'uf', value: 'RS' }])));
  lanca(() => validarDefinicaoAudiencia(def([filtroTodosClientes(), filtroTodosClientes()])));
  lanca(() => validarDefinicaoAudiencia(def([{ field: 'todosClientes', value: true, extra: 1 }])));
  lanca(() => validarDefinicaoAudiencia(def([{ field: 'todosClientes', op: 'eq', value: true }])));
});

// ── 4. Exclusões ────────────────────────────────────────────────────────────────────────────────────
const EXCLUSOES_INVALIDAS = [
  ['semOptIn como texto', { semOptIn: 'false' }], ['numeroInvalido numérico', { numeroInvalido: 0 }],
  ['dias negativos', { compradoNosUltimosDias: -1 }], ['horas como texto', { recebeuCampanhaNasUltimasHoras: '48' }],
  ['exclusão desconhecida', { ignorarTudo: true }], ['exclusões não-objeto', 'semOptIn'], ['exclusões em lista', [true]],
];
for (const [nome, exclusoes] of EXCLUSOES_INVALIDAS) {
  test(`exclusão inválida (${nome}) → recusa (um "false" em texto não pode religar/desligar proteção em silêncio)`, () => {
    lanca(() => validarDefinicaoAudiencia({ match: 'ALL', filtros: [{ field: 'uf', value: 'RS' }], exclusoes }));
  });
}

// ── 5. RFM continua obrigatório e validado (Rodada 5) ───────────────────────────────────────────────
const predicado = { recenciaDias: { min: 0, max: 45 }, frequencia: { min: 1, max: 1 }, valor: { metrica: 'ltv_janela', min: null, maxExclusivo: 134.9 } };
const rfm = () => filtroRfmDoSegmento({ segmento: 'novos', regraVersao: 'rfm-v1:c35267c2', classificadoEm: '2026-09-24T12:00:00.000Z', predicado });

test('filtro RFM: separado das demais condições e obrigatório também com ANY; sozinho é uma audiência válida (não é "sem filtro")', () => {
  const so = validarDefinicaoAudiencia({ match: 'ANY', filtros: [rfm()], exclusoes: {} });
  assert.equal(so.rfm.value.segmento, 'novos');
  assert.deepEqual(so.filtros, []);
  const misto = validarDefinicaoAudiencia({ match: 'ANY', filtros: [{ field: 'uf', value: 'RS' }, rfm()], exclusoes: {} });
  assert.equal(misto.rfm.field, 'rfm');
  assert.equal(misto.filtros.length, 1);
});

test('filtro RFM defeituoso ou duplicado → erro tipado (RFM_FILTRO_INVALIDO / AUDIENCIA_FILTRO_INVALIDO), nunca ignorado', () => {
  assert.throws(() => validarDefinicaoAudiencia(def([{ ...rfm(), value: 'novos' }])), (e) => e instanceof ErroAudienciaRfm && e.codigo === 'RFM_FILTRO_INVALIDO');
  lanca(() => validarDefinicaoAudiencia(def([rfm(), rfm()])));
  assert.throws(() => validarDefinicaoAudiencia(def([rfm(), { field: 'cidade', value: 'x' }])), (e) => e.codigo === CODIGO_INVALIDO, 'RFM válido + condição inválida: recusa tudo');
});

test('RFM + "todos os clientes" é ambíguo → inválido', () => {
  lanca(() => validarDefinicaoAudiencia(def([rfm(), filtroTodosClientes()])));
});

// ── 6. Definição LEGADA inválida: recusada com a causa, sem ser reescrita ───────────────────────────
test('definição legada inválida (como poderia estar no banco) é recusada com a causa e não é alterada', () => {
  const legada = { match: 'ALL', filtros: [{ field: 'diasSemComprar', op: 'gte', value: 60 }, { field: 'segmentoAntigo', value: 'vip' }], exclusoes: { semOptIn: true } };
  const copia = JSON.stringify(legada);
  assert.throws(() => validarDefinicaoAudiencia(legada), (e) => e.detalhes.some((d) => d.campo === 'segmentoAntigo'));
  assert.equal(JSON.stringify(legada), copia, 'nada foi migrado nem reescrito');
});

test('a mensagem é acionável e não vaza dado: só campo/operador/motivo, sem valores de cliente', () => {
  try {
    validarDefinicaoAudiencia(def([{ field: 'uf', value: 'SEGREDO-123' }]));
    assert.fail('deveria lançar');
  } catch (e) {
    assert.ok(!e.message.includes('SEGREDO-123'));
    assert.ok(!JSON.stringify(e.detalhes).includes('SEGREDO-123'));
  }
});
