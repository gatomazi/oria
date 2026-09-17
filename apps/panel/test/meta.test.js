'use strict';

// Testes do núcleo da integração Meta (docs/meta-ads-analytics-integracao-v2.md §66-67).
// Roda com `npm test` (node --test), mesmo esquema já usado em desktop/test/envio.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getActionValue, normalizarActions, parseNumero, parseNumeroOuZero, metricas } = require('../lib/meta/actions');
const { normalizarLinhaInsight, agregarInsights, totalizarSomas, somarArrayDeAcoes, variacao } = require('../lib/meta/insights');
const { MetaClient, MetaApiError, ERROS, classificarErroMeta, mascararToken } = require('../lib/meta/client');

// ── MetaActionMapper ────────────────────────────────────────────────────────────────────────

test('actions ausente ou vazio não quebra e conta zero', () => {
  assert.equal(getActionValue(undefined, ['purchase']), 0);
  assert.equal(getActionValue(null, ['purchase']), 0);
  assert.equal(getActionValue([], ['purchase']), 0);
  const vazio = normalizarActions(undefined, undefined);
  assert.equal(vazio.purchases, 0);
  assert.equal(vazio.purchaseValue, 0);
});

test('purchase duplicado em action types diferentes conta UMA vez, não soma as variantes', () => {
  // O caso que infla dashboard: a Meta devolve o mesmo pedido em três action_type.
  const actions = [
    { action_type: 'purchase', value: '31' },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '31' },
    { action_type: 'omni_purchase', value: '31' },
  ];
  assert.equal(normalizarActions(actions, []).purchases, 31, 'somar as variantes daria 93');
});

test('cai para a próxima variante quando o action_type preferido não veio', () => {
  const actions = [{ action_type: 'omni_purchase', value: '7' }];
  assert.equal(normalizarActions(actions, []).purchases, 7);
});

test('action_values vira receita atribuída pela Meta, separada da contagem', () => {
  const actions = [{ action_type: 'purchase', value: '3' }];
  const values = [{ action_type: 'purchase', value: '389.70' }];
  const r = normalizarActions(actions, values);
  assert.equal(r.purchases, 3);
  assert.equal(r.purchaseValue, 389.7);
});

test('eventos de funil são lidos cada um do seu action_type', () => {
  const actions = [
    { action_type: 'landing_page_view', value: '500' },
    { action_type: 'view_content', value: '420' },
    { action_type: 'add_to_cart', value: '90' },
    { action_type: 'initiate_checkout', value: '40' },
    { action_type: 'purchase', value: '12' },
  ];
  const r = normalizarActions(actions, []);
  assert.deepEqual(
    [r.landingPageViews, r.viewContent, r.addToCart, r.initiateCheckout, r.purchases],
    [500, 420, 90, 40, 12]
  );
});

// ── Parser monetário ────────────────────────────────────────────────────────────────────────

test('campo string numérica vira número; campo null continua null', () => {
  assert.equal(parseNumero('109.9'), 109.9);
  assert.equal(parseNumero('0.0'), 0);
  assert.equal(parseNumero(null), null);
  assert.equal(parseNumero(undefined), null);
  assert.equal(parseNumero(''), null);
  assert.equal(parseNumero('abc'), null, 'lixo não pode virar NaN silencioso');
  assert.equal(parseNumeroOuZero(null), 0);
});

// ── ROAS / CPA / CTR / MER e divisão por zero ───────────────────────────────────────────────

test('spend = 0 não gera ROAS infinito', () => {
  assert.equal(metricas.roas(500, 0), null);
  assert.equal(metricas.cpc(0, 0), null);
  assert.equal(metricas.cpm(100, 0), null);
});

test('purchases = 0 não gera CPA infinito', () => {
  assert.equal(metricas.cpa(250, 0), null);
});

test('purchaseValue = 0 dá ROAS 0 de verdade (gastou e não vendeu), não null', () => {
  assert.equal(metricas.roas(0, 200), 0);
});

test('ROAS, CPA, CTR e MER calculam certo quando há base', () => {
  assert.equal(metricas.roas(2840, 580), 2840 / 580);
  assert.equal(metricas.cpa(580, 21), 580 / 21);
  assert.equal(metricas.ctr(2104, 100000), 2.104);
  // MER = receita REAL da loja / gasto real de mídia — independente de atribuição (spec §53I).
  assert.equal(metricas.mer(10000, 2500), 4);
});

// ── Normalização de linha de insight ────────────────────────────────────────────────────────

test('outbound_clicks vem como array de ações e não pode virar NaN', () => {
  assert.equal(somarArrayDeAcoes([{ action_type: 'outbound_click', value: '84' }]), 84);
  assert.equal(somarArrayDeAcoes(undefined), 0);
  assert.equal(somarArrayDeAcoes('12'), 12);
});

test('linha de insight vira linha de banco com métricas e atribuição', () => {
  const linha = {
    date_start: '2026-09-10', date_stop: '2026-09-10',
    campaign_id: '111', adset_id: '222', ad_id: '333',
    impressions: '10000', reach: '7000', clicks: '250', unique_clicks: '210',
    inline_link_clicks: '200', outbound_clicks: [{ action_type: 'outbound_click', value: '190' }],
    spend: '300.50', ctr: '2.5', cpc: '1.202', cpm: '30.05',
    actions: [{ action_type: 'purchase', value: '10' }, { action_type: 'add_to_cart', value: '55' }],
    action_values: [{ action_type: 'purchase', value: '1099.00' }],
  };
  const r = normalizarLinhaInsight(linha, { level: 'ad', attributionSetting: '7d_click,1d_view' });
  assert.equal(r.level, 'ad');
  assert.equal(r.date, '2026-09-10');
  assert.equal(r.metaAdId, '333');
  assert.equal(r.spend, 300.5);
  assert.equal(r.purchases, 10);
  assert.equal(r.purchaseValue, 1099);
  assert.equal(r.outboundClicks, 190);
  assert.equal(r.costPerPurchase, 30.05);
  assert.equal(r.attributionSetting, '7d_click,1d_view');
  assert.equal(r.videoPlays, null, 'anúncio sem vídeo fica null, nunca 0 (spec §20)');
});

test('frequency é derivada quando a Meta não manda, e protegida contra reach 0', () => {
  const comReach = normalizarLinhaInsight({ date_start: '2026-09-10', impressions: '900', reach: '300' }, { level: 'campaign' });
  assert.equal(comReach.frequency, 3);
  const semReach = normalizarLinhaInsight({ date_start: '2026-09-10', impressions: '900', reach: '0' }, { level: 'campaign' });
  assert.equal(semReach.frequency, null);
});

test('nível inválido é recusado na porta de entrada', () => {
  assert.throws(() => normalizarLinhaInsight({ date_start: '2026-09-10' }, { level: 'criativo' }), /nível de insight inválido/);
});

// ── Agregação por período ───────────────────────────────────────────────────────────────────

test('taxa de período recalcula das somas, nunca faz média das taxas diárias', () => {
  // Dia 1: CTR 10% com pouco volume. Dia 2: CTR 1% com muito volume.
  // Média das taxas daria 5,5%. O certo é 110/10100 = ~1,089%.
  const dias = [
    { impressions: 100, clicks: 10, spend: 10, purchases: 1, purchaseValue: 100, ctr: 10 },
    { impressions: 10000, clicks: 100, spend: 190, purchases: 4, purchaseValue: 300, ctr: 1 },
  ];
  const t = agregarInsights(dias);
  assert.equal(t.impressions, 10100);
  assert.equal(t.clicks, 110);
  assert.equal(t.spend, 200);
  assert.ok(Math.abs(t.ctr - (110 / 10100) * 100) < 1e-9);
  assert.equal(t.roas, 400 / 200);
  assert.equal(t.cpa, 200 / 5);
});

test('agregar lista vazia não explode e não inventa métrica', () => {
  const t = agregarInsights([]);
  assert.equal(t.spend, 0);
  assert.equal(t.roas, null);
  assert.equal(t.cpa, null);
  assert.equal(t.ctr, null);
});

test('alcance do período não é somado silenciosamente', () => {
  const t = agregarInsights([{ reach: 500 }, { reach: 400 }]);
  assert.equal(t.reach, null, 'alcance único do período a Meta não dá — não pode fingir que dá');
  assert.equal(t.reachSomado, 900);
});

test('vídeo só agrega quando alguma linha tinha vídeo', () => {
  assert.equal(agregarInsights([{ spend: 10 }, { spend: 20 }]).videoPlays, null);
  assert.equal(agregarInsights([{ videoPlays: 30 }, { spend: 20 }]).videoPlays, 30);
});

test('totalizarSomas aceita string do Postgres sem virar concatenação', () => {
  // pg devolve NUMERIC/BIGINT como string pra não perder precisão. Se isso escapar, "10" + "5"
  // vira "105" em vez de 15 — erro silencioso que só aparece como número absurdo na tela.
  const t = totalizarSomas({ impressions: '10100', clicks: '110', spend: '200.50', purchases: '5', purchaseValue: '400' });
  assert.equal(t.impressions, 10100);
  assert.equal(t.spend, 200.5);
  assert.equal(t.roas, 400 / 200.5);
  assert.ok(Math.abs(t.ctr - (110 / 10100) * 100) < 1e-9);
});

test('totalizarSomas mantém vídeo null quando a soma do período veio NULL', () => {
  const t = totalizarSomas({ spend: '100', videoPlays: null, video25: undefined });
  assert.equal(t.videoPlays, null);
  assert.equal(t.video25, null);
  assert.equal(totalizarSomas({ videoPlays: '0' }).videoPlays, 0, 'zero explícito é zero, não "sem dado"');
});

test('variação sem base de comparação é null, não +100%', () => {
  assert.equal(variacao(10, 0), null);
  assert.equal(variacao(10, null), null);
  assert.equal(variacao(115, 100), 15);
  assert.equal(variacao(80, 100), -20);
});

// ── Cliente: erros, retry, paginação ────────────────────────────────────────────────────────

function respostaFalsa(status, corpo) {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo };
}

test('token expirado é classificado e NÃO é repetido', async () => {
  let chamadas = 0;
  const client = new MetaClient({
    accessToken: 'segredo',
    fetchImpl: async () => { chamadas += 1; return respostaFalsa(400, { error: { code: 190, error_subcode: 463 } }); },
    sleep: async () => {},
  });
  await assert.rejects(() => client.request('me/adaccounts'), (err) => {
    assert.equal(err.codigo, ERROS.TOKEN_EXPIRED);
    return true;
  });
  assert.equal(chamadas, 1, 'repetir com token morto só gasta cota');
});

test('permissão negada vira META_PERMISSION_DENIED', () => {
  assert.equal(classificarErroMeta(403, { code: 10 }).codigo, ERROS.PERMISSION_DENIED);
  assert.equal(classificarErroMeta(403, { code: 272 }).codigo, ERROS.PERMISSION_DENIED);
});

test('conta inexistente vira META_ACCOUNT_NOT_FOUND', () => {
  assert.equal(classificarErroMeta(400, { code: 100, error_subcode: 33 }).codigo, ERROS.ACCOUNT_NOT_FOUND);
  assert.equal(classificarErroMeta(400, { code: 803 }).codigo, ERROS.ACCOUNT_NOT_FOUND);
});

test('rate limit é repetido com backoff e depois desiste — nunca em loop infinito', async () => {
  let chamadas = 0;
  const esperas = [];
  const client = new MetaClient({
    accessToken: 'segredo',
    maxTentativas: 3,
    fetchImpl: async () => { chamadas += 1; return respostaFalsa(429, { error: { code: 80004 } }); },
    sleep: async (ms) => { esperas.push(ms); },
  });
  await assert.rejects(() => client.request('act_1/insights'), (err) => {
    assert.equal(err.codigo, ERROS.RATE_LIMIT);
    return true;
  });
  assert.equal(chamadas, 3, 'para no teto de tentativas');
  assert.equal(esperas.length, 2);
  assert.ok(esperas[1] > esperas[0], 'a espera cresce a cada tentativa');
});

test('rate limit que passa na segunda tentativa devolve o dado', async () => {
  let chamadas = 0;
  const client = new MetaClient({
    accessToken: 'segredo',
    fetchImpl: async () => {
      chamadas += 1;
      if (chamadas === 1) return respostaFalsa(429, { error: { code: 17 } });
      return respostaFalsa(200, { data: [{ id: '1' }] });
    },
    sleep: async () => {},
  });
  const corpo = await client.request('act_1/campaigns');
  assert.equal(corpo.data.length, 1);
  assert.equal(chamadas, 2);
});

test('falha de rede é repetida e a mensagem nunca carrega o token', async () => {
  const client = new MetaClient({
    accessToken: 'TOKEN_SUPER_SECRETO',
    maxTentativas: 2,
    fetchImpl: async () => { throw new Error('conexão caiu em access_token=TOKEN_SUPER_SECRETO'); },
    sleep: async () => {},
  });
  await assert.rejects(() => client.request('me'), (err) => {
    assert.ok(!err.message.includes('TOKEN_SUPER_SECRETO'), 'token vazou na mensagem de erro');
    assert.ok(err.message.includes('access_token=***'));
    return true;
  });
});

test('o token vai no header, nunca na URL', async () => {
  let urlVista = null;
  let headersVistos = null;
  const client = new MetaClient({
    accessToken: 'TOKEN_SUPER_SECRETO',
    fetchImpl: async (url, opts) => { urlVista = url; headersVistos = opts.headers; return respostaFalsa(200, { data: [] }); },
  });
  await client.request('act_1/campaigns', { fields: 'id,name' });
  assert.ok(!urlVista.includes('TOKEN_SUPER_SECRETO'));
  assert.equal(headersVistos.Authorization, 'Bearer TOKEN_SUPER_SECRETO');
});

test('paginação percorre todas as páginas via cursor after', async () => {
  const paginas = [
    { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'CUR1' } } },
    { data: [{ id: '3' }], paging: { cursors: { after: 'CUR2' } } },
    { data: [] },
  ];
  const cursores = [];
  let i = 0;
  const client = new MetaClient({
    accessToken: 'segredo',
    fetchImpl: async (url) => { cursores.push(new URL(url).searchParams.get('after')); return respostaFalsa(200, paginas[i++]); },
  });
  const itens = await client.coletar('act_1/ads', { fields: 'id' });
  assert.deepEqual(itens.map((x) => x.id), ['1', '2', '3']);
  assert.deepEqual(cursores, [null, 'CUR1', 'CUR2']);
});

test('paginação sem cursor final para na primeira página', async () => {
  const client = new MetaClient({
    accessToken: 'segredo',
    fetchImpl: async () => respostaFalsa(200, { data: [{ id: '1' }] }),
  });
  assert.equal((await client.coletar('act_1/campaigns')).length, 1);
});

test('paginação tem teto e aborta em vez de rodar sem fim', async () => {
  // Página que sempre devolve o mesmo cursor: sem teto, isso é loop infinito.
  const client = new MetaClient({
    accessToken: 'segredo',
    fetchImpl: async () => respostaFalsa(200, { data: [{ id: 'x' }], paging: { cursors: { after: 'SEMPRE' } } }),
  });
  await assert.rejects(() => client.coletar('act_1/ads', {}, { maxPaginas: 3 }), /abortado para não rodar sem fim/);
});

test('appsecret_proof entra em toda chamada quando configurado — e o secret em si nunca vai junto', async () => {
  const urls = [];
  const client = new MetaClient({
    accessToken: 'TOKEN',
    appsecretProof: 'PROOF123',
    fetchImpl: async (url) => { urls.push(url); return respostaFalsa(200, { data: [] }); },
  });
  await client.request('me/adaccounts');
  assert.equal(new URL(urls[0]).searchParams.get('appsecret_proof'), 'PROOF123');
  assert.ok(!urls[0].includes('client_secret'));
});

test('sem appsecret_proof configurado a URL não ganha o parâmetro vazio', async () => {
  let url = null;
  const client = new MetaClient({ accessToken: 'TOKEN', fetchImpl: async (u) => { url = u; return respostaFalsa(200, { data: [] }); } });
  await client.request('me');
  assert.equal(new URL(url).searchParams.has('appsecret_proof'), false);
});

test('a versão da Graph API é configurável e aparece na URL', () => {
  const client = new MetaClient({ accessToken: 'x', versao: 'v99.0' });
  assert.ok(client.url('act_1/insights').startsWith('https://graph.facebook.com/v99.0/act_1/insights'));
});

test('mascararToken limpa token, secret e Bearer', () => {
  assert.equal(mascararToken('a?access_token=ABC&x=1'), 'a?access_token=***&x=1');
  assert.equal(mascararToken('client_secret=XYZ'), 'client_secret=***');
  assert.equal(mascararToken('Authorization: Bearer ABC.DEF'), 'Authorization: Bearer ***');
});

test('MetaApiError carrega o código sem perder a mensagem', () => {
  const err = new MetaApiError(ERROS.SYNC_FAILED, 'falhou');
  assert.equal(err.codigo, 'META_SYNC_FAILED');
  assert.equal(err.message, 'falhou');
  assert.ok(err instanceof Error);
});
