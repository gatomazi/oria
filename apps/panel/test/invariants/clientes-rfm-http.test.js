'use strict';

// Clientes 360° no processo real (server.js sob a role da aplicação, RLS ligada), com duas Organizations:
//   · resumo/RFM: soma dos segmentos = universo; lista filtrada por segmento = MESMO público do resumo;
//   · detalhe: itens conciliam com o pedido, auditoria gravada, cliente de outra Organização → 404;
//   · exportação: sem CPF, quantidade confirmada, auditada;
//   · segmento de campanha: definição recalculada no servidor (o cliente não manda predicado), dinâmica, isolada.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('./harness');
const senhas = h.sujeito('lib/auth/password.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const { inserir, limparCache, concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_A = 'a1000000-0000-4000-8000-000000000001';
const ORG_B = 'a1000000-0000-4000-8000-000000000002';
const STORE_A = 'a2000000-0000-4000-8000-000000000001';
const STORE_B = 'a2000000-0000-4000-8000-000000000002';
const LOJA = { [ORG_A]: 'sul', [ORG_B]: 'centro' };
const STORE = { [ORG_A]: STORE_A, [ORG_B]: STORE_B };
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_cli_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');

let db;
let sup;
let filho;
let base;
let ordemInk = 1000;

const diasAtras = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

async function pessoa(email, org) {
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await senhas.gerarHash(SENHA)]);
  await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, 'owner']);
  return u.id;
}

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo } = {}) => {
    const hd = {};
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') hd['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, { method: metodo, headers: hd, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.includes('oria_session')) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json, texto, tipo: res.headers.get('content-type') || '' };
  };
  nav.entrar = async (email) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email, password: SENHA } });
    assert.equal(r.status, 200, r.texto);
    return nav;
  };
  return nav;
}

// Pedido + itens de uma Organization. total = Σ itens + frete − descontos (a identidade fechada da Ink).
async function pedido(org, { doc, tel, email, nome, dias, valorItem = 100, qtd = 1, frete = 10, desconto = 0, pagamento = 'paid', troca = false, aceita = true, comItens = true }) {
  ordemInk += 1;
  const total = valorItem * qtd + frete - desconto;
  await inserir(sup, 'pedidos_ink', {
    organization_id: org, store_id: STORE[org], loja: LOJA[org], ink_order_id: ordemInk,
    payment_status: pagamento, order_status: 'sent', buyer_nome: nome, buyer_telefone: tel || null, buyer_documento: doc || null,
    buyer_email: email || null, buyer_aceita_marketing: aceita, buyer_uf: 'RS', total_value: total, criado_em: diasAtras(dias),
    frete, descontos: desconto, items_count: comItens ? 1 : null, lucro_operacional: 20, is_troca: troca,
  });
  if (comItens) {
    await inserir(sup, 'pedidos_ink_itens', {
      organization_id: org, store_id: STORE[org], loja: LOJA[org], ink_order_id: ordemInk, item_id: ordemInk * 10, produto_id: 7,
      produto_nome: 'Camiseta Porto Alegre', sku: 'POA-M', modelo: 'Masculino', cor: 'Preta', tamanho: 'M', quantidade: qtd,
      valor_venda: valorItem * qtd, desconto_rateado: desconto, custo_producao: 40, lucro_operacional: 20,
    });
  }
  return ordemInk;
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_cli_http');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  await pessoa('cli-a@teste.oria', ORG_A);
  await pessoa('cli-b@teste.oria', ORG_B);
  limparCache();
  for (const org of [ORG_A, ORG_B]) await concederFeatures(sup, org, { whatsapp: true });

  // Org A: 44 clientes de uma compra (recência 10..~200 dias), 3 recorrentes fortes, um cliente unido por
  // telefone+documento, um cancelado, um reembolsado e uma troca (nenhum deles vira compra válida).
  for (let i = 0; i < 44; i += 1) {
    await pedido(ORG_A, { doc: `1000000${String(i).padStart(4, '0')}`, tel: `5199${String(1000000 + i)}`, email: `u${i}@a.com`, nome: `Cliente ${i}`, dias: 10 + i * 4, valorItem: 80 + i * 3, aceita: i % 2 === 0 });
  }
  for (let i = 0; i < 3; i += 1) {
    for (const d of [5 + i, 40 + i, 75 + i]) await pedido(ORG_A, { doc: `2000000000${i}`, tel: `5198000000${i}`, email: `rec${i}@a.com`, nome: `Recorrente ${i}`, dias: d, valorItem: 900 });
  }
  await pedido(ORG_A, { doc: '30000000001', nome: 'Unido', dias: 20 });
  await pedido(ORG_A, { tel: '51970000001', nome: 'Unido', dias: 15 });
  await pedido(ORG_A, { doc: '30000000001', tel: '51970000001', nome: 'Unido', dias: 12 });
  await pedido(ORG_A, { doc: '40000000001', tel: '51960000001', nome: 'So cancelado', dias: 5, pagamento: 'canceled' });
  await pedido(ORG_A, { doc: '40000000002', tel: '51960000002', nome: 'Reembolsado', dias: 6, pagamento: 'refunded' });
  await pedido(ORG_A, { doc: '40000000003', tel: '51960000003', nome: 'So troca', dias: 7, troca: true });
  await pedido(ORG_A, { doc: '40000000004', tel: '51960000004', nome: 'Sem itens', dias: 30, comItens: false });
  await pedido(ORG_A, { doc: '40000000005', tel: '51960000005', nome: 'Com desconto', dias: 33, valorItem: 100, qtd: 2, frete: 15, desconto: 30 });
  // Org B: outra loja, dado distinto.
  for (let i = 0; i < 35; i += 1) {
    await pedido(ORG_B, { doc: `9000000${String(i).padStart(4, '0')}`, tel: `5399${String(2000000 + i)}`, email: `b${i}@b.com`, nome: `B ${i}`, dias: 10 + i * 6, valorItem: 50 });
  }
  await pedido(ORG_B, { doc: '50000000001', nome: 'Exclusivo B', dias: 3 });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-cli-srv-'));
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE), DB_ENFORCE_APP_ROLE: '1', ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      PROVIDER_MOCK_LOG: path.join(dir, 'mock.jsonl'),
    },
  }), { aoLer: () => {}, limiteMs: 30000 });
  filho = processo.filho;
  base = processo.base;
});

test.after(async () => {
  if (filho && filho.exitCode === null) filho.kill('SIGKILL');
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

const soma = (arr, f) => arr.reduce((acc, x) => acc + f(x), 0);

test('sem sessão: resumo, detalhe, exportação e segmento respondem 401', async () => {
  const anon = navegador();
  for (const [m, p] of [['GET', '/api/admin/clientes/resumo'], ['POST', '/api/admin/clientes/detalhe'], ['POST', '/api/admin/clientes/exportar'], ['POST', '/api/admin/clientes/segmentos']]) {
    const r = await anon.req(m, p, m === 'POST' ? { corpo: {} } : undefined);
    assert.ok([401, 403].includes(r.status), `${m} ${p}: ${r.status}`);
  }
});

test('resumo: universo só com compra válida; soma dos segmentos = universo; cancelado, reembolso e troca ficam de fora', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const r = await a.req('GET', '/api/admin/clientes/resumo?de=2020-01-01');
  assert.equal(r.status, 200, r.texto);
  const { rfm, indicadores, cobertura } = r.json;
  // 44 únicos + 3 recorrentes + 1 unido (3 pedidos, 1 pessoa) + sem itens + com desconto = 50 pessoas com compra válida.
  assert.equal(rfm.universo, 50);
  assert.equal(rfm.identidadesSemCompraValida, 3, 'cancelado, reembolsado e só-troca não são compradores');
  assert.equal(soma(rfm.segmentos, (s) => s.clientes), rfm.universo);
  assert.equal(rfm.suficiente, true);
  assert.equal(rfm.versao, 'rfm-v1');
  assert.equal(indicadores.atual.clientes, 50);
  assert.equal(indicadores.atual.pedidos, 44 + 9 + 3 + 2);
  assert.equal(indicadores.atual.pedidosReembolsados, 1);
  assert.equal(cobertura.pedidosSemIdentidade, 0);
  assert.ok(cobertura.primeiroPedidoEm && cobertura.fonte);
  // KPIs e RFM no mesmo universo: faturamento = receita total dos segmentos.
  assert.equal(Math.round(indicadores.atual.faturamento * 100), Math.round(soma(rfm.segmentos, (s) => s.receita) * 100));
  const recorrentes = rfm.segmentos.filter((s) => ['campeoes', 'leais'].includes(s.id));
  assert.equal(soma(recorrentes, (s) => s.clientes), 4, '3 recorrentes de 3 compras + o cliente unido (3 pedidos)');
});

test('resumo: identidade unida por documento/telefone conta UMA pessoa com 3 pedidos', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const r = await a.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: '30000000001' } });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.pedidos.length, 3);
  assert.deepEqual(r.json.identidade.motivosDeUniao, ['documento', 'telefone']);
});

test('período sem pedidos não quebra e a comparação some quando o histórico não cobre o período anterior', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const vazio = await a.req('GET', '/api/admin/clientes/resumo?de=2020-01-01&ate=2020-01-31');
  assert.equal(vazio.status, 200);
  assert.equal(vazio.json.indicadores.atual.pedidos, 0);
  assert.equal(vazio.json.indicadores.atual.ticketMedio, null);
  const lixo = await a.req('GET', '/api/admin/clientes/resumo?de=2026-02-30&ate=drop');
  assert.equal(lixo.status, 200, 'datas inválidas caem no padrão');
  const recente = await a.req('GET', '/api/admin/clientes/resumo?de=2026-01-01');
  assert.equal(recente.json.indicadores.comparacao.anterior, null, 'período anterior começa antes do primeiro pedido sincronizado');
});

test('lista filtrada por segmento devolve exatamente o público do segmento no resumo', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const { json: resumo } = await a.req('GET', '/api/admin/clientes/resumo');
  for (const seg of resumo.rfm.segmentos.filter((s) => s.clientes > 0)) {
    const l = await a.req('GET', `/api/admin/clientes/lista?tipo=com_pedido&per_page=100&segmento=${seg.id}`);
    assert.equal(l.status, 200, l.texto);
    assert.equal(l.json.total, seg.clientes, `segmento ${seg.id}`);
    assert.ok(l.json.clientes.every((c) => c.segmento === seg.id));
  }
  const todos = await a.req('GET', '/api/admin/clientes/lista?tipo=com_pedido&per_page=100');
  // "Com pedido" inclui quem só tem pedido cancelado/reembolsado/troca: sem compra válida, fora da RFM, no filtro `sem_compra`.
  assert.equal(todos.json.total, soma(resumo.rfm.segmentos, (s) => s.clientes) + resumo.rfm.identidadesSemCompraValida);
  const semCompra = await a.req('GET', '/api/admin/clientes/lista?tipo=com_pedido&per_page=100&segmento=sem_compra');
  assert.equal(semCompra.json.total, resumo.rfm.identidadesSemCompraValida);
  assert.ok(semCompra.json.clientes.every((c) => c.segmento === null && c.pedidosValidos === 0));
});

test('detalhe: itens, desconto e frete conciliam com o total; cancelado/reembolso/troca não contam no LTV', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const r = await a.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: '40000000005' } });
  assert.equal(r.status, 200, r.texto);
  const [p] = r.json.pedidos;
  assert.equal(p.totalPago, 185);
  assert.equal(p.subtotal, 200);
  assert.equal(p.desconto, 30);
  assert.equal(p.frete, 15);
  assert.equal(p.somaItens, 200);
  assert.equal(p.conciliado, true);
  assert.equal(p.itens[0].produto, 'Camiseta Porto Alegre');
  assert.equal(p.itens[0].imagem, null, 'sem imagem real: placeholder, nunca URL inventada');
  assert.equal(r.json.indicadores.ltv, 185);
  assert.equal(r.json.indicadores.itensComprados, 2);

  const reemb = (await a.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: '40000000002' } })).json;
  assert.equal(reemb.indicadores.ltv, 0);
  assert.equal(reemb.pedidos[0].devolvido, 110);
  assert.equal(reemb.pedidos[0].contaNoLtv, false);
  assert.equal(reemb.pedidos[0].devolucaoParcialRastreada, false);
  assert.equal(reemb.rfm, null, 'sem compra válida: fora da RFM');

  const semItens = (await a.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: '40000000004' } })).json;
  assert.equal(semItens.pedidos[0].conciliado, null, 'sem itens no cache: não dá para conciliar, e não finge');
  assert.equal(semItens.indicadores.itensComprados, null);
});

test('detalhe: canais dizem a verdade (sem envio 1:1 pelo Oria, sem provedor de e-mail, sem opt-in por canal)', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const { json } = await a.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: '10000000000' } });
  assert.equal(json.canais.whatsapp.acao, 'abrir_externo');
  assert.equal(json.canais.whatsapp.telefoneWa.startsWith('55'), true);
  assert.equal(json.canais.whatsapp.conexaoOria, 'desconectada');
  assert.equal(json.canais.email.provedorIntegrado, false);
  assert.equal(json.canais.consentimento.registroPorCanal, false);
  assert.ok(json.lacunas.length >= 3);
});

test('detalhe: auditoria gravada antes da resposta e sem PII na chave da entidade', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const antes = (await sup.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'cliente.visualizar'`)).rows[0].n;
  const r = await a.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: '10000000001' } });
  assert.equal(r.status, 200);
  const { rows } = await sup.query(`SELECT entity_id, organization_id, before, after FROM audit_log WHERE action = 'cliente.visualizar' ORDER BY id DESC LIMIT 1`);
  assert.equal((await sup.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'cliente.visualizar'`)).rows[0].n, antes + 1);
  assert.equal(rows[0].organization_id, ORG_A);
  assert.ok(!JSON.stringify(rows[0]).includes('10000000001'), 'a chave do cliente (CPF) não pode aparecer no audit_log');
});

test('detalhe: exige customerKey e nunca cruza Organization (cliente da B é 404 para A, e vice-versa)', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const b = await navegador().entrar('cli-b@teste.oria');
  assert.equal((await a.req('POST', '/api/admin/clientes/detalhe', { corpo: {} })).status, 400);
  assert.equal((await a.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: 'x'.repeat(300) } })).status, 400);
  assert.equal((await a.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: '50000000001' } })).status, 404);
  assert.equal((await b.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: '50000000001' } })).status, 200);
  assert.equal((await b.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: '10000000000' } })).status, 404);
  const listaB = await b.req('GET', '/api/admin/clientes/lista?tipo=com_pedido&per_page=100');
  assert.ok(!listaB.texto.includes('Cliente 1'), 'lista da B não vaza cliente da A');
  const resumoB = await b.req('GET', '/api/admin/clientes/resumo?de=2020-01-01');
  assert.equal(resumoB.json.rfm.universo, 36);
});

test('exportação: sem CPF, exige a quantidade vista na prévia, respeita o filtro e é auditada', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const lista = await a.req('GET', '/api/admin/clientes/lista?tipo=com_pedido&per_page=100&segmento=perdidos');
  const qtd = lista.json.total;
  const errada = await a.req('POST', '/api/admin/clientes/exportar', { corpo: { filtros: { segmento: 'perdidos' }, quantidadeConfirmada: qtd + 1 } });
  assert.equal(errada.status, 409);
  const todos = await a.req('POST', '/api/admin/clientes/exportar', { corpo: { filtros: {}, quantidadeConfirmada: 53 } });
  assert.equal(todos.status, 200, todos.texto);
  assert.ok(todos.tipo.includes('text/csv'));
  const linhas = todos.texto.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(linhas.length, 54);
  assert.ok(!/documento|cpf/i.test(linhas[0]), 'CPF/documento não é coluna do CSV');
  assert.ok(!todos.texto.includes('10000000000'), 'nenhum CPF no arquivo');
  const { rows } = await sup.query(`SELECT after FROM audit_log WHERE action = 'cliente.exportar' ORDER BY id DESC LIMIT 1`);
  assert.equal(rows[0].after.quantidade, 53);
  assert.ok(!JSON.stringify(rows[0].after).includes('@'), 'a auditoria guarda só a contagem e o nome dos filtros');
});

test('segmento RFM: definição vem do servidor, fica dinâmica com versão e data; a audiência salva bate com o preview', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const { json: resumo } = await a.req('GET', '/api/admin/clientes/resumo');
  const alvo = resumo.rfm.segmentos.find((s) => s.id === 'hibernando') || resumo.rfm.segmentos.find((s) => s.clientes > 3);
  const criar = await a.req('POST', '/api/admin/clientes/segmentos', {
    corpo: { nome: 'Segunda compra', origem: 'rfm', segmento: alvo.id, filtros: [{ field: 'uf', value: 'XX' }], predicado: { evil: true } },
  });
  assert.equal(criar.status, 201, criar.texto);
  assert.equal(criar.json.politica, 'dinamico');
  assert.ok(criar.json.observacoes.length >= 2, 'diferenças entre RFM e motor de audiência são declaradas');
  assert.ok(criar.json.segmento.filtros.every((f) => ['diasSemComprar', 'quantidadePedidos', 'totalGasto'].includes(f.field)), 'filtros vêm do predicado do servidor');
  const { rows: [linha] } = await sup.query('SELECT * FROM segments WHERE id = $1', [criar.json.segmento.id]);
  assert.equal(linha.origem, 'rfm');
  assert.equal(linha.rfm_versao, 'rfm-v1');
  assert.equal(linha.rfm_segmento, alvo.id);
  assert.equal(linha.politica, 'dinamico');
  assert.ok(linha.classificado_em);
  assert.equal(linha.organization_id, ORG_A);
  assert.notEqual(linha.criado_por, 'admin');
  assert.ok(!('evil' in (linha.predicado || {})));

  const prev = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: linha.filtros, exclusions: { semOptIn: false, numeroInvalido: false } } });
  assert.equal(prev.status, 200, prev.texto);
  assert.ok(Math.abs(prev.json.matched - alvo.clientes) <= 2, `preview ${prev.json.matched} vs segmento ${alvo.clientes} (bordas de 1 dia)`);
});

test('segmento: recusa origem/segmento inválidos e filtro sem campo avaliável; não aparece para outra Organization', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const b = await navegador().entrar('cli-b@teste.oria');
  assert.equal((await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'x', origem: 'rfm', segmento: 'DROP' } })).status, 400);
  assert.equal((await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'x', origem: 'outra' } })).status, 400);
  assert.equal((await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { origem: 'rfm', segmento: 'novos' } })).status, 400, 'nome obrigatório');
  assert.equal((await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'x', origem: 'clientes', filtros: {} } })).status, 400, 'sem filtro avaliável');
  const filtros = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'Alto valor', origem: 'clientes', filtros: { ltvMin: '500', pedidosMin: '2' } } });
  assert.equal(filtros.status, 201, filtros.texto);
  assert.deepEqual(filtros.json.segmento.filtros.map((f) => f.field), ['quantidadePedidos', 'totalGasto']);
  const listaB = await b.req('GET', '/api/admin/segments');
  assert.ok(!listaB.texto.includes('Alto valor') && !listaB.texto.includes('Segunda compra'), 'segmento da A não aparece na B');
});
