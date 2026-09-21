'use strict';

// Lista paginada de Clientes (lib/clientes/lista.js): busca, ordenação e filtro valem para a lista INTEIRA
// (rodam antes de fatiar a página), a entrada é por lista de permissão e a paginação é estável.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const { normalizarConsulta, listarClientes, unirComCadastro } = h.sujeito('lib/clientes/lista.js');

function cliente(i, extra = {}) {
  return {
    loja: 'loja-1',
    customerKey: `doc-${String(i).padStart(3, '0')}`,
    nome: `Cliente ${String(i).padStart(3, '0')}`,
    email: `c${i}@exemplo.com`,
    telefone: `(51) 99${String(i).padStart(3, '0')}-0000`,
    documento: `doc-${i}`,
    aceitaMarketing: i % 2 === 0,
    totalCompras: 0,
    lucroOperacional: 0,
    pedidosSemFinanceiro: 0,
    ultimaCompraEm: null,
    diasSemComprar: null,
    legacyCustomerKeys: ['nao-sai'],
    totalGasto: 999,
    ...extra,
  };
}

const sessenta = () => Array.from({ length: 60 }, (_, i) => cliente(i + 1));
const consulta = (q = {}) => normalizarConsulta(q);

test('pagina a lista inteira: totais, tamanho da página e última página parcial', () => {
  const p1 = listarClientes(sessenta(), consulta({ page: '1', per_page: '25' }));
  assert.equal(p1.clientes.length, 25);
  assert.equal(p1.total, 60);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.page, 1);
  const p3 = listarClientes(sessenta(), consulta({ page: '3', per_page: '25' }));
  assert.equal(p3.clientes.length, 10, 'a última página leva o resto');
  assert.equal(p3.page, 3);
});

test('as páginas juntas são a lista: ninguém repete e ninguém some (empates incluídos)', () => {
  // Todos empatados em compras (0): só o desempate estável separa as páginas.
  const vistos = [];
  for (let page = 1; page <= 3; page += 1) {
    vistos.push(...listarClientes(sessenta(), consulta({ page: String(page), per_page: '25' })).clientes.map((c) => c.customerKey));
  }
  assert.equal(vistos.length, 60);
  assert.equal(new Set(vistos).size, 60, 'nenhum cliente em duas páginas');
});

test('a ordem vale para a lista inteira, não para a página: o de mais compras que está no fim vem primeiro', () => {
  const todos = sessenta();
  todos[59].totalCompras = 9; // o último da lista original
  todos[10].totalCompras = 5;
  const p1 = listarClientes(todos, consulta({ ordem: 'compras_desc', per_page: '25' }));
  assert.equal(p1.clientes[0].customerKey, todos[59].customerKey);
  assert.equal(p1.clientes[1].customerKey, todos[10].customerKey);
});

test('ordena por lucro, por nome e por inatividade (quem nunca comprou é o mais inativo)', () => {
  const l = [
    cliente(1, { nome: 'Zeca', lucroOperacional: 10, diasSemComprar: 5 }),
    cliente(2, { nome: 'Ana', lucroOperacional: 90, diasSemComprar: 200 }),
    cliente(3, { nome: 'Beto', lucroOperacional: 50, diasSemComprar: null }),
  ];
  assert.deepEqual(listarClientes(l, consulta({ ordem: 'lucro_desc' })).clientes.map((c) => c.nome), ['Ana', 'Beto', 'Zeca']);
  assert.deepEqual(listarClientes(l, consulta({ ordem: 'nome' })).clientes.map((c) => c.nome), ['Ana', 'Beto', 'Zeca']);
  assert.deepEqual(listarClientes(l, consulta({ ordem: 'inativos_primeiro' })).clientes.map((c) => c.nome), ['Beto', 'Ana', 'Zeca']);
});

test('"sem comprar há N+ dias" inclui quem nunca comprou e o total reflete o filtro', () => {
  const l = [
    cliente(1, { diasSemComprar: 10 }),
    cliente(2, { diasSemComprar: 45 }),
    cliente(3, { diasSemComprar: 200 }),
    cliente(4, { diasSemComprar: null }),
  ];
  const r = listarClientes(l, consulta({ inativoDias: '90' }));
  assert.equal(r.total, 2);
  assert.deepEqual(r.clientes.map((c) => c.customerKey).sort(), ['doc-003', 'doc-004']);
});

test('busca por nome, e-mail e telefone (também só dígitos), sem diferenciar maiúsculas', () => {
  const l = [
    cliente(1, { nome: 'Maria Souza', email: 'maria@x.com', telefone: '(51) 99246-6818' }),
    cliente(2, { nome: 'João Lima', email: 'joao@x.com', telefone: '(47) 98888-0000' }),
  ];
  assert.equal(listarClientes(l, consulta({ busca: 'MARIA' })).total, 1);
  assert.equal(listarClientes(l, consulta({ busca: 'joao@x' })).total, 1);
  assert.equal(listarClientes(l, consulta({ busca: '51992466' })).total, 1, 'telefone só com dígitos');
  assert.equal(listarClientes(l, consulta({ busca: '4 6' })).total, 0, 'menos de 3 dígitos não casa pela comparação só de dígitos ("46" está em 51992466818)');
  assert.equal(listarClientes(l, consulta({ busca: 'ninguem' })).total, 0);
});

test('página além do fim volta para a última; lista vazia tem 1 página', () => {
  const r = listarClientes(sessenta(), consulta({ page: '99', per_page: '25' }));
  assert.equal(r.page, 3);
  assert.equal(r.clientes.length, 10);
  const vazio = listarClientes([], consulta());
  assert.deepEqual([vazio.total, vazio.totalPages, vazio.page, vazio.clientes.length], [0, 1, 1, 0]);
});

test('entrada por lista de permissão: valor fora dela cai no padrão, nunca é interpretado', () => {
  assert.deepEqual(consulta({ page: 'abc', per_page: '9999', ordem: 'DROP', inativoDias: '45', busca: 5 }),
    { page: 1, perPage: 100, ordem: 'compras_desc', inativoDias: null, busca: '', tipo: 'todos' });
  assert.equal(consulta({ tipo: 'sem_pedido' }).tipo, 'sem_pedido');
  assert.equal(consulta({ tipo: 'qualquer' }).tipo, 'todos', 'tipo fora da lista de permissão cai no padrão');
  assert.equal(consulta({ tipo: ['sem_pedido'] }).tipo, 'todos');
  assert.equal(consulta({ page: '0' }).page, 1);
  assert.equal(consulta({ page: '1001' }).page, 1);
  assert.equal(consulta({ page: '2;drop' }).page, 1, 'lixo depois do número não é aceito');
  assert.equal(consulta({ per_page: '0' }).perPage, 25);
  assert.equal(consulta({ page: ['2', '3'] }).page, 1, 'parâmetro repetido (array) não vira número');
  assert.equal(consulta({ busca: `  ${'a'.repeat(300)}  ` }).busca.length, 100, 'busca limitada');
});

test('a resposta só leva o que a tela usa (nada do agregado interno)', () => {
  const [c] = listarClientes([cliente(1, { totalCompras: 2, lucroOperacional: 30 })], consulta()).clientes;
  assert.equal(c.totalCompras, 2);
  assert.ok(!('legacyCustomerKeys' in c) && !('totalGasto' in c), 'campos internos não saem');
  assert.equal(typeof c.aceitaMarketing, 'boolean');
});

const registro = (id, extra = {}) => ({ id: String(id), nome: `Cadastro ${id}`, email: `cad${id}@x.com`, telefone: `(11) 9${String(id).padStart(4, '0')}-1111`, documento: `9990000${String(id).padStart(4, '0')}`, aceitaMarketing: false, ...extra });

test('cadastro: quem nunca pediu entra sem compra; quem já pediu não duplica (documento, telefone ou e-mail)', () => {
  const historico = [
    cliente(1, { documento: '111.222.333-44', telefone: '(51) 99999-0001', email: 'A@x.com', totalCompras: 2 }),
    cliente(2, { documento: null, telefone: '(51) 98888-0002', email: null, totalCompras: 1, customerKey: '(51) 98888-0002', legacyCustomerKeys: ['(51) 98888-0002'] }),
  ];
  const cadastro = [
    registro(10, { documento: '11122233344', telefone: null, email: null }), // mesmo documento do histórico #1
    registro(11, { documento: null, telefone: '51988880002', email: null }), // mesmo telefone do histórico #2
    registro(12, { documento: null, telefone: null, email: 'a@x.com' }),     // mesmo e-mail (caixa diferente) do histórico #1
    registro(13),                                                            // só cadastro
  ];
  const uniao = unirComCadastro(historico, cadastro, { loja: 'loja-1' });
  assert.equal(uniao.length, 3, '2 do histórico + 1 só de cadastro');
  const so = uniao.filter((c) => c.origem === 'cadastro');
  assert.equal(so.length, 1);
  assert.equal(so[0].customerKey, 'cadastro:13');
  assert.equal(so[0].loja, 'loja-1');
  assert.equal(so[0].totalCompras, 0);
  assert.ok(uniao.filter((c) => c.origem === 'pedido').length === 2, 'o histórico segue com origem "pedido" e seus totais');
});

test('filtro por tipo: todos, só com pedido, só cadastro — e a origem sai na linha', () => {
  const uniao = unirComCadastro([cliente(1, { totalCompras: 3 }), cliente(2, { totalCompras: 1 })], [registro(20), registro(21), registro(22)], { loja: 'l' });
  const total = (tipo) => listarClientes(uniao, consulta({ tipo, per_page: '100' }));
  assert.equal(total('todos').total, 5);
  assert.equal(total('com_pedido').total, 2);
  assert.ok(total('com_pedido').clientes.every((c) => c.origem === 'pedido'));
  assert.equal(total('sem_pedido').total, 3);
  assert.ok(total('sem_pedido').clientes.every((c) => c.origem === 'cadastro' && c.totalCompras === 0));
});

test('quem só tem cadastro entra em "sem comprar há N+ dias" e vai depois de quem comprou em "mais compras"', () => {
  const uniao = unirComCadastro([cliente(1, { totalCompras: 4, diasSemComprar: 10 })], [registro(30)], { loja: 'l' });
  assert.equal(listarClientes(uniao, consulta({ inativoDias: '90' })).total, 1, 'só o de cadastro (nunca comprou)');
  assert.equal(listarClientes(uniao, consulta({ ordem: 'compras_desc' })).clientes[0].origem, 'pedido');
});
