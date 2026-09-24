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
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createIntegrationResolver } = h.sujeito('lib/platform/integrations.js');
const { createSecretStore } = h.sujeito('lib/secrets/store.js');
const { createKeyring } = h.sujeito('lib/secrets/keyring.js');
const { inserir, limparCache, concederFeatures } = require('../helpers/linhas');
const { agruparPedidosPorIdentidade } = h.sujeito('lib/clientes/identidade.js');
const { filtrosDoPredicado } = h.sujeito('lib/clientes/segmento.js');

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
let arquivoControle;
let arquivoLogMock;
const controleDoMock = (c) => fs.writeFileSync(arquivoControle, JSON.stringify(c));
const chamadasAoCadastro = () => (fs.existsSync(arquivoLogMock)
  ? fs.readFileSync(arquivoLogMock, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.caminho === '/v1/stores/customers').length
  : 0);

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
  // Ink CONECTADA na Organization A (token de teste): o cadastro de clientes passa a ser consultado, e o mock pode ficar
  // lento/fora do ar sob controle do teste.
  const fachada = runtime.criarPoolTenant(sup);
  const resolver = createIntegrationResolver({
    pool: fachada, segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }) }), env: {}, logger: { warn() {}, error() {} },
  });
  await runtime.comContexto({ organizationId: ORG_A, loja: LOJA[ORG_A] }, () => resolver.gravarSegredo('ink', 'api_token', 'inkA-token-de-teste-clientes'));

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
  arquivoControle = path.join(dir, 'controle-mock.json');
  arquivoLogMock = path.join(dir, 'mock.jsonl');
  controleDoMock({});
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE), DB_ENFORCE_APP_ROLE: '1', ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      PROVIDER_MOCK_LOG: arquivoLogMock, PROVIDER_MOCK_CONTROL: arquivoControle,
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
  assert.equal(rfm.amostraSuficiente, true);
  assert.equal(rfm.versao, 'rfm-v1');
  assert.match(rfm.regraVersao, /^rfm-v1:[0-9a-f]{8}$/, 'a versão da regra (algoritmo + hash dos limiares) acompanha o resumo');
  assert.deepEqual(rfm.configuracao.limitesRecenciaDias, [45, 90, 180, 365]);
  assert.equal(rfm.valorAltoMetrica, 'ltv_janela');
  assert.ok(rfm.segmentos.filter((s) => s.clientes > 0).every((s) => s.recenciaMedianaDias != null && s.frequenciaMediana != null));
  assert.equal(cobertura.pedidosDuplicadosIgnorados, 0);
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
  // Rodada 5: o segmento RFM persiste UM filtro `rfm` (avaliado pela mesma classificação da matriz), não quatro filtros genéricos
  // com semântica diferente — logo não há mais "diferença entre RFM e motor de audiência" a declarar para segmentos novos.
  assert.deepEqual(criar.json.observacoes, []);
  assert.equal(criar.json.segmento.filtros.length, 1);
  assert.equal(criar.json.segmento.filtros[0].field, 'rfm', 'o filtro vem do predicado calculado no servidor, não do corpo');
  assert.notEqual(criar.json.segmento.filtros[0].value.segmento, 'XX');
  const { rows: [linha] } = await sup.query('SELECT * FROM segments WHERE id = $1', [criar.json.segmento.id]);
  assert.equal(linha.origem, 'rfm');
  assert.equal(linha.rfm_versao, resumo.rfm.regraVersao, 'o segmento guarda a versão da REGRA, não só a do algoritmo');
  assert.equal(linha.rfm_segmento, alvo.id);
  assert.equal(linha.politica, 'dinamico');
  assert.ok(linha.classificado_em);
  assert.equal(linha.organization_id, ORG_A);
  assert.notEqual(linha.criado_por, 'admin');
  assert.ok(!('evil' in (linha.predicado || {})));

  const prev = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: linha.filtros, exclusions: { semOptIn: false, numeroInvalido: false } } });
  assert.equal(prev.status, 200, prev.texto);
  assert.equal(prev.json.matched, alvo.clientes, 'a Audiência do segmento é a MESMA população da matriz');
  assert.equal(prev.json.rfm.equivalencia, 'exata');

  // Clicar de novo com a mesma regra reaproveita o segmento salvo, em vez de gerar duplicata.
  const repetido = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'Outro nome', origem: 'rfm', segmento: alvo.id } });
  assert.equal(repetido.status, 200, repetido.texto);
  assert.equal(repetido.json.reaproveitado, true);
  assert.equal(repetido.json.segmento.id, criar.json.segmento.id);
  assert.equal(repetido.json.segmento.origem, 'rfm');
  assert.equal(repetido.json.segmento.politica, 'dinamico');
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

// Ida e volta com Campanhas: segmento RFM → linha persistida → filtros → prévia de audiência → contagem.
// O esperado NÃO vem do motor de audiência: é recalculado aqui, direto das linhas de pedidos, com a semântica do
// filtro de audiência (pedido pago inclusive troca, histórico inteiro, dias = 24h corridas).
function audienciaEsperada(linhasDePedidos, filtros) {
  const pagos = new Set(['paid', 'succeeded', 'free']);
  const agora = Date.now();
  const clientes = agruparPedidosPorIdentidade(linhasDePedidos).map((g) => {
    const p = g.pedidos.filter((x) => pagos.has(x.payment_status));
    const gasto = p.reduce((acc, x) => acc + Number(x.total_value), 0);
    const ultima = p.reduce((m, x) => Math.max(m, new Date(x.criado_em).getTime()), 0);
    return { compras: p.length, gasto, ticket: p.length ? gasto / p.length : null, dias: p.length ? Math.floor((agora - ultima) / 86_400_000) : null };
  });
  const cmp = (v, op, alvo) => v != null && (op === 'gte' ? v >= alvo : op === 'lte' ? v <= alvo : op === 'lt' ? v < alvo : op === 'gt' ? v > alvo : v === alvo);
  const campo = { diasSemComprar: 'dias', quantidadePedidos: 'compras', totalGasto: 'gasto', ticketMedio: 'ticket' };
  return clientes.filter((c) => filtros.every((f) => (f.field === 'diasSemComprar' && c.dias == null ? f.op === 'gte' || f.op === 'gt' : cmp(c[campo[f.field]], f.op, f.value)))).length;
}

test('ida e volta com Campanhas: para TODO segmento, o que foi persistido é a regra do servidor e a prévia bate com a contagem independente', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const { json: resumo } = await a.req('GET', '/api/admin/clientes/resumo');
  const { rows: pedidosA } = await sup.query(
    `SELECT buyer_documento, buyer_telefone, buyer_email, payment_status, total_value, criado_em FROM pedidos_ink WHERE organization_id = $1
      AND COALESCE(NULLIF(buyer_documento,''), NULLIF(buyer_telefone,''), NULLIF(buyer_email,'')) IS NOT NULL ORDER BY criado_em DESC`, [ORG_A]
  );
  const comGente = resumo.rfm.segmentos.filter((s) => s.clientes > 0);
  assert.ok(comGente.length >= 4, 'a base do teste cobre vários segmentos');
  const somaDasPrevias = [];
  for (const seg of comGente) {
    const criar = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: `Ida e volta ${seg.id}`, origem: 'rfm', segmento: seg.id } });
    assert.ok([200, 201].includes(criar.status), criar.texto);
    // 1) o que ficou no banco (não a resposta): origem, política, regra, versão e a data de classificação.
    const { rows: [linha] } = await sup.query('SELECT * FROM segments WHERE id = $1', [criar.json.segmento.id]);
    assert.equal(linha.origem, 'rfm');
    assert.equal(linha.politica, 'dinamico');
    assert.equal(linha.rfm_segmento, seg.id);
    assert.equal(linha.rfm_versao, resumo.rfm.regraVersao);
    assert.ok(linha.classificado_em);
    assert.deepEqual(linha.predicado, seg.predicado, 'a regra persistida é a que o resumo mostra');
    // 2) o filtro persistido é UM filtro `rfm` com regra, data de classificação e o predicado (com o corte SALVO) — e só ele.
    assert.deepEqual(linha.filtros, [{ field: 'rfm', op: 'segmento', value: { segmento: seg.id, regraVersao: resumo.rfm.regraVersao, classificadoEm: linha.filtros[0].value.classificadoEm, predicado: linha.predicado } }]);
    assert.equal(new Date(linha.filtros[0].value.classificadoEm).toISOString(), new Date(linha.classificado_em).toISOString());
    // 3) a prévia, chamada com os filtros lidos do banco (o que a tela de Nova campanha faz), devolve EXATAMENTE a população da matriz.
    const prev = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: linha.match, filters: linha.filtros, exclusions: { semOptIn: false, numeroInvalido: false } } });
    assert.equal(prev.status, 200, prev.texto);
    assert.equal(prev.json.matched, seg.clientes, `segmento ${seg.id}: Audiência × matriz`);
    assert.equal(prev.json.rfm.universos.segmento, seg.clientes);
    assert.equal(prev.json.rfm.regraVersao, resumo.rfm.regraVersao);
    assert.ok(prev.json.rfm.universos.pessoasComPedido >= prev.json.rfm.universos.compradoresValidos && prev.json.rfm.universos.compradoresValidos === resumo.rfm.universo);
    // 4) COMPAT: os filtros genéricos equivalentes (o que o segmento persistia antes) seguem funcionando como sempre e continuam
    //    a divergir da matriz só pelo que está documentado (só-troca conta como comprador; janela/24h) — nada foi alterado neles.
    const genericos = filtrosDoPredicado(linha.predicado);
    const prevGenerico = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: genericos, exclusions: { semOptIn: false, numeroInvalido: false } } });
    assert.equal(prevGenerico.status, 200, prevGenerico.texto);
    assert.equal(prevGenerico.json.matched, audienciaEsperada(pedidosA, genericos), `segmento ${seg.id}: caminho genérico × contagem independente (compat)`);
    assert.ok(prevGenerico.json.matched >= seg.clientes && prevGenerico.json.matched - seg.clientes <= 2, `${seg.id}: RFM ${seg.clientes} × genérico ${prevGenerico.json.matched}`);
    assert.equal(prevGenerico.json.rfm, undefined, 'sem filtro RFM a resposta não ganha bloco rfm');
    somaDasPrevias.push(prev.json.matched);
  }
  assert.ok(somaDasPrevias.every((n) => n > 0));
  // Nada foi disparado nem publicado por este fluxo.
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM campaigns')).rows[0].n, 0);
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM campaign_recipients')).rows[0].n, 0);
});

// ── Rodada 5: Audiência exata (RFM → público comercial → elegíveis) ────────────────────────────────────
// Universo → segmento (matriz) → população comercial (Audiência) → exclusões de contato (só depois, por motivo, na ordem opt-in →
// telefone). O esperado vem da LISTA de Clientes filtrada por segmento (a matriz), não do motor de audiência.
const digitos = (v) => String(v || '').replace(/\D/g, '');

test('Audiência exata: população = matriz; exclusões de contato só atuam depois e são discriminadas por motivo; opt-in e telefone batem com a lista', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const { json: resumo } = await a.req('GET', '/api/admin/clientes/resumo');
  const seg = resumo.rfm.segmentos.filter((s) => s.clientes > 3 && s.clientes <= 100).sort((x, y) => y.clientes - x.clientes)[0];
  const criar = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: `Exclusões ${seg.id}`, origem: 'rfm', segmento: seg.id } });
  assert.ok([200, 201].includes(criar.status), criar.texto);
  const filtros = criar.json.segmento.filtros;
  const membros = (await a.req('GET', `/api/admin/clientes/lista?tipo=com_pedido&per_page=100&segmento=${seg.id}`)).json.clientes;
  assert.equal(membros.length, seg.clientes);

  // Esperado independente: a ordem das exclusões é opt-in → telefone válido (≥ 10 dígitos).
  const semOptIn = membros.filter((m) => !m.aceitaMarketing);
  const comOptIn = membros.filter((m) => m.aceitaMarketing);
  const semTelefone = comOptIn.filter((m) => digitos(m.telefone).length < 10);
  const elegiveis = comOptIn.length - semTelefone.length;
  assert.ok(semOptIn.length > 0, 'a base do teste tem gente sem opt-in neste segmento');

  const sem = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: filtros, exclusions: { semOptIn: false, numeroInvalido: false } } });
  assert.equal(sem.json.matched, seg.clientes);
  assert.equal(sem.json.excluded, 0, 'sem exclusões marcadas, a população comercial inteira é elegível');

  const com = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: filtros, exclusions: { semOptIn: true, numeroInvalido: true } } });
  assert.equal(com.status, 200, com.texto);
  assert.equal(com.json.matched, seg.clientes, 'as exclusões de contato NÃO mudam a população comercial');
  assert.equal(com.json.breakdown.optOut, semOptIn.length);
  assert.equal(com.json.breakdown.numeroInvalido, semTelefone.length);
  assert.equal(com.json.eligible, elegiveis);
  assert.equal(com.json.matched - com.json.excluded, com.json.eligible);
  assert.equal(com.json.excluded, Object.values(com.json.breakdown).reduce((x, y) => x + y, 0), 'cada excluído tem exatamente um motivo');
});

test('Audiência exata: o filtro RFM é OBRIGATÓRIO mesmo com match ANY (um OU nunca alarga para "todos os clientes")', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const { json: resumo } = await a.req('GET', '/api/admin/clientes/resumo');
  const seg = resumo.rfm.segmentos.filter((s) => s.clientes > 3 && s.clientes <= 100)[0];
  const criar = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: `ANY ${seg.id}`, origem: 'rfm', segmento: seg.id } });
  const [filtroRfm] = criar.json.segmento.filtros;
  const excl = { semOptIn: false, numeroInvalido: false };
  const membros = (await a.req('GET', `/api/admin/clientes/lista?tipo=com_pedido&per_page=100&segmento=${seg.id}`)).json.clientes;
  // UF inexistente + ANY: só o segmento RFM não basta para entrar — a condição adicional também vale sobre o público RFM.
  const nenhum = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ANY', filters: [filtroRfm, { field: 'uf', op: 'eq', value: 'ZZ' }], exclusions: excl } });
  assert.equal(nenhum.json.matched, 0);
  const soOptIn = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ANY', filters: [filtroRfm, { field: 'optIn', value: true }], exclusions: excl } });
  assert.equal(soOptIn.json.matched, membros.filter((m) => m.aceitaMarketing).length);
  assert.ok(soOptIn.json.matched <= seg.clientes, 'nunca passa do público do segmento');
});

test('Audiência exata: filtro RFM em erro é 409 acionável (nunca "todos os clientes" nem a última resposta) e a campanha não inicia', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const criar = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'Erro RFM', origem: 'rfm', segmento: 'novos' } });
  const bom = criar.json.segmento.filtros[0];
  const excl = { semOptIn: false, numeroInvalido: false };
  const ruins = [
    ['RFM_FILTRO_INVALIDO', { ...bom, value: { ...bom.value, predicado: undefined } }],
    ['RFM_FILTRO_INVALIDO', { field: 'rfm', op: 'segmento', value: 'novos' }],
    ['RFM_REGRA_DIVERGENTE', { ...bom, value: { ...bom.value, regraVersao: 'rfm-v1:00000000' } }],
  ];
  for (const [codigo, filtro] of ruins) {
    const r = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: [filtro], exclusions: excl } });
    assert.equal(r.status, 409, r.texto);
    assert.equal(r.json.codigo, codigo);
    assert.equal(r.json.matched, undefined, 'nenhuma contagem acompanha o erro');
    assert.match(r.json.error, /segmento|regra|Clientes/i);
  }
  const dois = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: [bom, bom], exclusions: excl } });
  assert.equal(dois.status, 409);

  // Iniciar uma campanha com esse filtro falha ANTES de criar destinatários e a campanha segue em rascunho.
  const camp = await a.req('POST', '/api/admin/campaigns', { corpo: { nome: 'Campanha com filtro RFM quebrado', templateNome: 'tpl_teste', audienceDefinition: { match: 'ALL', filtros: [ruins[2][1]], exclusoes: {} } } });
  assert.equal(camp.status, 200, camp.texto);
  const id = camp.json.campanha.id;
  try {
    const inicio = await a.req('POST', `/api/admin/campaigns/${id}/start`);
    assert.equal(inicio.status, 409, inicio.texto);
    assert.match(inicio.json.error, /regra RFM mudou/);
    assert.equal((await sup.query('SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1', [id])).rows[0].n, 0);
    assert.equal((await sup.query('SELECT status FROM campaigns WHERE id = $1', [id])).rows[0].status, 'draft');
  } finally {
    await sup.query('DELETE FROM campaigns WHERE id = $1', [id]);
  }
});

test('prévia × revisão: reavaliar depois de um pedido novo muda a população E o asOf — a prévia não é uma foto que envelhece em silêncio; nada é disparado', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const criar = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'Prévia × revisão', origem: 'rfm', segmento: 'novos' } });
  const filtros = criar.json.segmento.filtros;
  const excl = { semOptIn: false, numeroInvalido: false };
  const p1 = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: filtros, exclusions: excl } });
  await new Promise((r) => setTimeout(r, 15));
  // Um comprador de 1 pedido de "Novos" faz a 2ª compra hoje: sai de Novos (F=2 → Potenciais leais).
  const { json: lista } = await a.req('GET', '/api/admin/clientes/lista?tipo=com_pedido&per_page=100&segmento=novos');
  const alvo = lista.clientes[0];
  const { rows: [origem] } = await sup.query(`SELECT buyer_documento, buyer_telefone, buyer_email, buyer_nome FROM pedidos_ink WHERE organization_id = $1 AND buyer_nome = $2 LIMIT 1`, [ORG_A, alvo.nome]);
  await pedido(ORG_A, { doc: origem.buyer_documento, tel: origem.buyer_telefone, email: origem.buyer_email, nome: origem.buyer_nome, dias: 0, valorItem: 30 });
  const p2 = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: filtros, exclusions: excl } });
  assert.equal(p2.json.matched, p1.json.matched - 1, 'quem comprou de novo saiu do segmento');
  assert.ok(new Date(p2.json.rfm.asOf).getTime() > new Date(p1.json.rfm.asOf).getTime(), 'cada avaliação carrega o SEU asOf');
  assert.equal(p2.json.rfm.divergente, p1.json.rfm.divergente);
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM campaign_recipients')).rows[0].n, 0);
});

test('Audiência exata: multi-tenant — o mesmo filtro RFM avaliado na Organization B usa SÓ a base da B; segmento salvo na A não existe para a B', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const b = await navegador().entrar('cli-b@teste.oria');
  const criar = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'Só da A', origem: 'rfm', segmento: 'hibernando' } });
  const filtro = criar.json.segmento.filtros[0];
  const resumoB = (await b.req('GET', '/api/admin/clientes/resumo')).json;
  const previaB = await b.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: [filtro], exclusions: { semOptIn: false, numeroInvalido: false } } });
  if (previaB.status === 200) {
    assert.equal(previaB.json.rfm.universos.compradoresValidos, resumoB.rfm.universo, 'universo = o da B');
    assert.notEqual(previaB.json.rfm.universos.compradoresValidos, (await a.req('GET', '/api/admin/clientes/resumo')).json.rfm.universo);
  } else {
    assert.equal(previaB.status, 409, 'a B não tem base suficiente para essa regra: erro acionável, nunca a base da A');
  }
  assert.ok(!(await b.req('GET', '/api/admin/segments')).texto.includes('Só da A'));
});

// ── Matriz × lista × cadastro remoto ────────────────────────────────────────────────────────────────
// A Ink (cadastro de quem nunca pediu) pode ficar fora do ar ou lenta. Isso nunca pode: bloquear pedidos locais já
// sincronizados, contaminar a lista de um segmento RFM, nem ser cacheado como se fosse resposta boa.
const listaDe = (nav, q) => nav.req('GET', `/api/admin/clientes/lista?per_page=100&${q}`);

test('lista × cadastro da Ink: falha → pedidos locais intactos e falha declarada; segmento RFM nem consulta a Ink; recuperação volta ao normal', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const { json: resumo } = await a.req('GET', '/api/admin/clientes/resumo');
  const novos = resumo.rfm.segmentos.find((x) => x.id === 'novos');
  const comPedido = (await listaDe(a, 'tipo=com_pedido')).json.total;
  assert.equal(comPedido, resumo.rfm.universo + resumo.rfm.identidadesSemCompraValida, 'pessoas com pedido = compradores classificados + sem compra válida');

  // 1) Ink fora do ar: tipo=todos segue com os pedidos locais e declara a falha.
  controleDoMock({ clientesCadastro: 'falha' });
  const falha = await listaDe(a, 'tipo=todos');
  assert.equal(falha.status, 200, falha.texto);
  assert.equal(falha.json.cadastro.disponivel, false);
  assert.equal(falha.json.cadastro.incluido, false);
  assert.equal(falha.json.total, comPedido, 'os pedidos já sincronizados não são bloqueados nem escondidos');

  // 2) Com chip de segmento, a Ink NÃO é consultada: total = segmento, sem alerta de cadastro, mesmo com a Ink fora do ar.
  const antes = chamadasAoCadastro();
  const seg = await listaDe(a, 'tipo=todos&segmento=novos');
  assert.equal(seg.status, 200, seg.texto);
  assert.equal(chamadasAoCadastro(), antes, 'o cadastro da Ink não foi consultado');
  assert.equal(seg.json.total, novos.clientes);
  assert.equal(seg.json.cadastro.disponivel, true, 'nenhum alerta de "cadastro indisponível" numa lista que a Ink não afeta');
  assert.equal(seg.json.cadastro.motivoOmitido, 'filtro_exige_pedido');
  assert.ok(seg.json.clientes.every((c) => c.segmento === 'novos'), 'nenhuma linha de outro segmento');

  // 3) Ink LENTA: a lista de segmento responde rápido (não espera a Ink).
  controleDoMock({ clientesCadastro: 'lento', atrasoMs: 2500 });
  const t0 = Date.now();
  const rapida = await listaDe(a, 'tipo=todos&segmento=novos&ltvMin=0');
  assert.equal(rapida.status, 200, rapida.texto);
  assert.ok(Date.now() - t0 < 1500, `lista de segmento levou ${Date.now() - t0} ms com a Ink lenta`);
  assert.equal(rapida.json.total, novos.clientes);

  // 4) Recuperação: a falha anterior NÃO foi cacheada; o cadastro volta e "só cadastro" reaparece.
  controleDoMock({});
  const ok = await listaDe(a, 'tipo=todos');
  assert.equal(ok.json.cadastro.incluido, true, 'recuperou: cadastro incluído');
  assert.equal(ok.json.cadastro.disponivel, true);
  const soCadastro = (await listaDe(a, 'tipo=sem_pedido')).json;
  assert.ok(soCadastro.total >= 1 && soCadastro.clientes.every((c) => c.origem === 'cadastro' && c.segmento === null));
  assert.equal(ok.json.total, comPedido + soCadastro.total);
});

test('matriz × lista × drawer: mesmo segmento, mesma regra e mesmo dia de classificação', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const { json: resumo } = await a.req('GET', '/api/admin/clientes/resumo');
  const diaMatriz = new Intl.DateTimeFormat('en-CA', { timeZone: resumo.rfm.fuso }).format(new Date(resumo.rfm.classificadoEm));
  for (const seg of resumo.rfm.segmentos.filter((x) => x.clientes > 0)) {
    const l = (await listaDe(a, `tipo=com_pedido&segmento=${seg.id}`)).json;
    assert.equal(l.total, seg.clientes, `lista × matriz em ${seg.id}`);
    assert.equal(l.rfm.regraVersao, resumo.rfm.regraVersao);
    assert.equal(l.rfm.diaClassificacao, diaMatriz);
    // O drawer do primeiro cliente da lista usa a MESMA definição de segmento.
    const d = await a.req('POST', '/api/admin/clientes/detalhe', { corpo: { customerKey: l.clientes[0].customerKey } });
    assert.equal(d.json.rfm.segmento.id, seg.id, `drawer × lista em ${seg.id}`);
    assert.equal(d.json.rfm.versao, resumo.rfm.versao);
  }
});

test('lista: filtro que depende da RFM nunca devolve lista SEM o filtro; sem dependência, lista segue local', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  // Segmento inexistente cai fora da lista de permissão: o filtro é ignorado (não vira consulta livre)…
  const ignorado = await listaDe(a, 'tipo=com_pedido&segmento=inexistente');
  assert.equal(ignorado.status, 200);
  // …e um segmento válido sem ninguém devolve ZERO, nunca a lista inteira.
  const { json: resumo } = await a.req('GET', '/api/admin/clientes/resumo');
  const vazio = resumo.rfm.segmentos.find((x) => x.clientes === 0);
  if (vazio) {
    const l = await listaDe(a, `tipo=com_pedido&segmento=${vazio.id}`);
    assert.equal(l.json.total, 0);
    assert.equal(l.json.clientes.length, 0);
  }
});

test('cobertura: amostra suficiente ≠ histórico confirmado; só backfill CONCLUÍDO confirma (e por quantos dias)', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const sp = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - n * 86_400_000));
  const antes = (await a.req('GET', '/api/admin/clientes/resumo?dias=tudo')).json;
  assert.equal(antes.rfm.amostraSuficiente, true, 'critério estatístico atendido…');
  assert.equal(antes.cobertura.backfillConfirmado, false, '…mas nenhum backfill: cobertura NÃO confirmada');
  assert.equal(antes.cobertura.cobertura365Confirmada, false);
  assert.equal(antes.cobertura.coberturaConfirmadaDias, null);
  assert.ok(antes.cobertura.historicoObservadoDias > 100, 'há histórico observado');
  assert.match(antes.cobertura.leitura, /Nenhum backfill concluído/);
  assert.equal('suficiente' in antes.rfm, false, 'o nome ambíguo foi aposentado');

  // Job em andamento/falho não confirma nada.
  await sup.query(`INSERT INTO pedidos_backfill_jobs (organization_id, store_id, loja, desde, status) VALUES ($1, $2, NULL, $3, 'falhou')`, [ORG_A, STORE_A, sp(400)]);
  const falho = (await a.req('GET', '/api/admin/clientes/resumo')).json.cobertura;
  assert.equal(falho.backfillConfirmado, false);
  assert.equal(falho.ultimoBackfillStatus, 'falhou');

  // Concluído cobrindo 200 dias: confirmado, mas menos que a janela de 365.
  await sup.query(`INSERT INTO pedidos_backfill_jobs (organization_id, store_id, loja, desde, status) VALUES ($1, $2, NULL, $3, 'concluido')`, [ORG_A, STORE_A, sp(200)]);
  const parcial = (await a.req('GET', '/api/admin/clientes/resumo')).json.cobertura;
  assert.equal(parcial.backfillConfirmado, true);
  assert.equal(parcial.coberturaConfirmadaDias, 200);
  assert.equal(parcial.cobertura365Confirmada, false);
  assert.equal(parcial.coberturaJanelaConfirmada, false);

  // Outra Organization não herda a confirmação da A.
  const b = await navegador().entrar('cli-b@teste.oria');
  assert.equal((await b.req('GET', '/api/admin/clientes/resumo')).json.cobertura.backfillConfirmado, false);

  // Concluído desde 400 dias: a janela de 365 fica confirmada.
  await sup.query(`INSERT INTO pedidos_backfill_jobs (organization_id, store_id, loja, desde, status) VALUES ($1, $2, NULL, $3, 'concluido')`, [ORG_A, STORE_A, sp(400)]);
  const completo = (await a.req('GET', '/api/admin/clientes/resumo')).json.cobertura;
  assert.equal(completo.coberturaConfirmadaDias, 400, 'vale o MENOR `desde` entre os jobs concluídos');
  assert.equal(completo.cobertura365Confirmada, true);
  assert.equal(completo.coberturaJanelaConfirmada, true);
  assert.equal(completo.backfillConcluidoDesde, sp(400));
});

// ── Segmento dinâmico × corte de valor materializado (Etapa 3) ─────────────────────────────────────────
test('segmento RFM salvo: pessoas dinâmicas, corte de valor materializado — novos pedidos movem o P75, a divergência aparece e NADA é reescrito', async () => {
  const a = await navegador().entrar('cli-a@teste.oria');
  const { json: r0 } = await a.req('GET', '/api/admin/clientes/resumo');
  const criar = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'Corte materializado', origem: 'rfm', segmento: 'novos' } });
  assert.ok([200, 201].includes(criar.status), criar.texto);
  const id = criar.json.segmento.id;
  const { rows: [antes] } = await sup.query('SELECT filtros, predicado, rfm_versao, classificado_em FROM segments WHERE id = $1', [id]);
  const corteSalvo = antes.predicado.valor.maxExclusivo;
  assert.equal(corteSalvo, r0.rfm.valorAlto);

  // Estado logo depois de salvar: sem divergência.
  const e0 = (await a.req('GET', '/api/admin/clientes/segmentos/estado')).json;
  const mine0 = e0.segmentos.find((x) => x.id === id);
  assert.equal(mine0.divergente, false);
  assert.equal(mine0.salvo.corte.valor, corteSalvo);
  assert.equal(mine0.mesmaRegraVersao, true);

  // Chegam 30 pedidos grandes de gente nova: o P75 da base sobe.
  for (let i = 0; i < 30; i += 1) await pedido(ORG_A, { doc: `7000000${String(i).padStart(4, '0')}`, tel: `5197${String(3000000 + i)}`, email: `g${i}@a.com`, nome: `Grande ${i}`, dias: 3 + (i % 5), valorItem: 1200 + i });
  const { json: r1 } = await a.req('GET', '/api/admin/clientes/resumo');
  assert.ok(r1.rfm.valorAlto > r0.rfm.valorAlto, `P75 ${r0.rfm.valorAlto} → ${r1.rfm.valorAlto}`);
  assert.equal(r1.rfm.regraVersao, r0.rfm.regraVersao, 'mesma versão da regra: o hash não cobre o corte');

  const e1 = (await a.req('GET', '/api/admin/clientes/segmentos/estado')).json;
  const mine = e1.segmentos.find((x) => x.id === id);
  assert.equal(mine.divergente, true);
  assert.equal(mine.mesmaRegraVersao, true);
  assert.equal(mine.salvo.corte.valor, corteSalvo, 'o corte salvo é o de quando foi salvo');
  assert.equal(mine.atual.corte.valor, r1.rfm.valorAlto, 'o corte efetivo é o P75 de hoje');
  assert.deepEqual(mine.diferencas.map((d) => d.campo), ['valor.maxExclusivo']);
  assert.equal(mine.politica.corteDeValor, 'materializado');
  assert.equal(e1.classificadoEm.slice(0, 10) >= r0.rfm.classificadoEm.slice(0, 10), true);

  // Nada foi reescrito silenciosamente: a linha salva é a mesma.
  const { rows: [depois] } = await sup.query('SELECT filtros, predicado, rfm_versao, classificado_em FROM segments WHERE id = $1', [id]);
  assert.deepEqual(depois, antes);

  // A Audiência usa o corte SALVO (número persistido), não o percentil de hoje: bate com a contagem independente feita com o corte salvo.
  const prev = await a.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: depois.filtros, exclusions: { semOptIn: false, numeroInvalido: false } } });
  assert.equal(prev.status, 200, prev.texto);
  assert.equal(prev.json.matched, mine.pessoas.comRegraSalva, 'a prévia aplica o corte SALVO: mesma contagem que a classificação de hoje com o predicado salvo');
  assert.equal(prev.json.rfm.corteSalvo.valor, corteSalvo);
  assert.equal(prev.json.rfm.corteAtual.valor, r1.rfm.valorAlto);
  assert.equal(prev.json.rfm.divergente, true);
  assert.equal(prev.json.rfm.pessoasNoSegmentoDeHoje, r1.rfm.segmentos.find((x) => x.id === 'novos').clientes);
  const novosHoje = r1.rfm.segmentos.find((x) => x.id === 'novos').clientes;
  assert.notEqual(prev.json.matched, novosHoje, 'com o corte defasado, a audiência salva difere do segmento de hoje: por isso a divergência é exibida');
  assert.equal(mine.equivalencia, 'exata');

  // Criar de novo com a regra de HOJE gera um segmento NOVO (o antigo não é reescrito).
  const novo = await a.req('POST', '/api/admin/clientes/segmentos', { corpo: { nome: 'Corte atual', origem: 'rfm', segmento: 'novos' } });
  assert.equal(novo.status, 201, novo.texto);
  assert.notEqual(novo.json.segmento.id, id);
  assert.equal(novo.json.predicado.valor.maxExclusivo, r1.rfm.valorAlto);
  const e2 = (await a.req('GET', '/api/admin/clientes/segmentos/estado')).json;
  assert.equal(e2.segmentos.find((x) => x.id === novo.json.segmento.id).divergente, false);
  assert.equal(e2.segmentos.find((x) => x.id === id).divergente, true, 'o antigo continua defasado, e visível');

  // Outra Organization não vê segmentos da A.
  const b = await navegador().entrar('cli-b@teste.oria');
  assert.equal((await b.req('GET', '/api/admin/clientes/segmentos/estado')).json.segmentos.length, 0);
});
