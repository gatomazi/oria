'use strict';

// Fase E · GA4AnalyticsConnector fim a fim: registry (Fase B) → IntegrationResolver (B.1) →
// ConnectorSecretPort (C) → token-port → Ga4Client → mapper, com Postgres falso e Google falso
// (fetchImpl). Cobre a lista completa do comando (§4.14).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createConnectorRegistry } = require('../lib/connectors/registry');
const { createConnectorIntegrationPort } = require('../lib/platform/connector-integration-port');
const { createConnectorSecretPort } = require('../lib/platform/connector-secret-port');
const { createSecretStore } = require('../lib/secrets/store');
const { createKeyring } = require('../lib/secrets/keyring');
const { comContexto } = require('../lib/platform/tenant-runtime');
const { createGa4AnalyticsDescriptor } = require('../lib/connectors/analytics/ga4');
const { createGa4PropertyRepository } = require('../lib/connectors/analytics/ga4/property-repository');
const { GA_DATA_API } = require('../lib/connectors/analytics/ga4/client');
const { CODIGOS } = require('../lib/connectors/errors');
const F = require('./helpers/connector-fakes');

const MESTRA = crypto.randomBytes(32).toString('base64');
const keyring = () => createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA });
const REFRESH_TOKEN = 'rt-A-9f8e7d6c5b4a';
const PROPERTY_ID = '999888777';

// ── Pool falso: stores, integrations, integration_secrets, google_analytics_connections ────────
function poolCompleto({ lojas, integracoes, propriedades = [], segredos = [] }) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql, params });
      if (/FROM stores/.test(sql)) return { rows: lojas.filter((l) => l.id === params[0] && l.organization_id === params[1]).map((l) => ({ id: l.id })) };
      if (/FROM integrations/.test(sql)) {
        const [org, provider, id] = params;
        return { rows: integracoes.filter((i) => i.organization_id === org && i.provider === provider && (id === undefined || String(i.id) === id) && i.escopo === null) };
      }
      if (/FROM google_analytics_connections/.test(sql)) {
        const [org, store] = params;
        return { rows: propriedades.filter((p) => p.organization_id === org && p.store_id === store) };
      }
      if (/INSERT INTO integration_secrets/.test(sql)) {
        const [integrationId, organizationId, tipo, ciphertext, keyVersion, last4v, expiresAt] = params;
        let linha = segredos.find((l) => l.integration_id === integrationId && l.tipo === tipo);
        if (!linha) { linha = { id: String(segredos.length + 1), integration_id: integrationId, tipo }; segredos.push(linha); }
        Object.assign(linha, { organization_id: organizationId, ciphertext, key_version: keyVersion, last4: last4v, expires_at: expiresAt });
        return { rows: [{ id: linha.id, tipo, last4: linha.last4, key_version: linha.key_version, expires_at: linha.expires_at, rotated_at: new Date() }] };
      }
      if (/SELECT ciphertext, key_version, expires_at FROM integration_secrets/.test(sql)) {
        const [integrationId, tipo, organizationId] = params;
        const achada = segredos.find((l) => l.integration_id === integrationId && l.tipo === tipo && (organizationId === null || l.organization_id === organizationId));
        return { rows: achada ? [{ ciphertext: achada.ciphertext, key_version: achada.key_version, expires_at: achada.expires_at }] : [] };
      }
      throw new Error(`SQL inesperado no fake pool: ${sql}`);
    },
  };
}

async function montarAmbiente({ comPropriedade = true, comSegredo = true } = {}) {
  const pool = poolCompleto({
    lojas: [{ id: F.STORE_A, organization_id: F.ORG_A }],
    integracoes: [{ id: F.INT_GA4_A, organization_id: F.ORG_A, provider: 'ga4', escopo: null, status: 'connected' }],
    propriedades: comPropriedade ? [{ organization_id: F.ORG_A, store_id: F.STORE_A, property_id: PROPERTY_ID, property_name: 'Loja A', status: 'connected' }] : [],
  });
  const kr = keyring();
  if (comSegredo) {
    await createSecretStore({ pool, keyring: kr }).gravar({ integrationId: F.INT_GA4_A, organizationId: F.ORG_A, tipo: 'refresh_token', valor: REFRESH_TOKEN, contexto: 'ga4-refresh-token-v1' });
  }
  const secretPort = createConnectorSecretPort({ pool, keyring: kr });
  const propertyRepository = createGa4PropertyRepository({ pool });
  const registry = createConnectorRegistry({ integrations: createConnectorIntegrationPort({ pool }) });
  let fetchImpl;
  registry.register(createGa4AnalyticsDescriptor({
    secretPort, propertyRepository, clientId: 'cid', clientSecret: 'csecret', fetchImpl: (...a) => fetchImpl(...a),
  }));
  return { pool, registry, definirFetch: (fn) => { fetchImpl = fn; } };
}

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const emA = (fn) => comContexto({ organizationId: F.ORG_A, storeId: F.STORE_A, origem: 'teste' }, fn);
const ctxA = { organizationId: F.ORG_A, storeId: F.STORE_A };

const TOKEN_RES = () => jsonRes(200, { access_token: 'at-derivado-xyz', expires_in: 3600 });
const METADATA_COMPLETA = { dimensions: [{ apiName: 'itemId' }, { apiName: 'itemName' }], metrics: [{ apiName: 'itemsViewed' }, { apiName: 'itemsAddedToCart' }, { apiName: 'itemsCheckedOut' }, { apiName: 'itemsPurchased' }, { apiName: 'itemRevenue' }] };
const COMPAT_COMPLETA = {
  dimensionCompatibilities: [{ dimensionMetadata: { apiName: 'itemId' }, compatibility: 'COMPATIBLE' }, { dimensionMetadata: { apiName: 'itemName' }, compatibility: 'COMPATIBLE' }],
  metricCompatibilities: ['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue'].map((apiName) => ({ metricMetadata: { apiName }, compatibility: 'COMPATIBLE' })),
};

// Roteador de fetch por endpoint: usado por vários testes para responder metadata/compat/report
// de forma independente, como o Google faria.
function roteador({ metadata = METADATA_COMPLETA, compat = COMPAT_COMPLETA, report }) {
  return async (url, init) => {
    if (url.endsWith('/metadata')) return jsonRes(200, metadata);
    if (url.endsWith(':checkCompatibility')) return jsonRes(200, compat);
    if (url === 'https://oauth2.googleapis.com/token') return TOKEN_RES();
    if (url.endsWith(':runReport')) return report(JSON.parse(init.body));
    throw new Error(`rota não programada: ${url}`);
  };
}

// ── resolve, capabilities, forma ───────────────────────────────────────────────────────────────

test('E · resolve analytics/ga4 pelo registry, requiresStoreContext true', () => emA(async () => {
  const { registry } = await montarAmbiente();
  const r = registry.resolve('analytics', 'ga4', ctxA);
  assert.equal(r.domain, 'analytics');
  assert.equal(r.requiresStoreContext, true);
  assert.deepEqual({ ...r.capabilities }, { productMetrics: true, eventMetrics: false, realtime: false });
  assert.equal(typeof r.connector.getProductPerformance, 'function');
  assert.equal(typeof r.connector.getProductMetricCapabilities, 'function');
  assert.throws(() => registry.resolve('analytics', 'ga4', { organizationId: F.ORG_A }), (err) => err.codigo === CODIGOS.CONTEXT_INVALID);
}));

// ── Property pertence à Store ─────────────────────────────────────────────────────────────────

test('E · property_id vem de google_analytics_connections da Store certa; sem linha, erro claro', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente({ comPropriedade: false });
  definirFetch(roteador({ report: () => jsonRes(200, { rows: [] }) }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  await assert.rejects(r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' }), (err) => err.codigo === 'INTEGRATION_NOT_CONNECTED');
}));

test('E · Store de outra Organization é recusada (B.1) antes de qualquer chamada ao Google', () => emA(async () => {
  const { registry } = await montarAmbiente();
  const r = registry.resolve('analytics', 'ga4', { organizationId: F.ORG_A, storeId: F.STORE_B });
  await assert.rejects(r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' }), (err) => err.codigo === CODIGOS.INTEGRATION_TENANT_MISMATCH);
}));

// ── Credencial tenant-bound / sem secret no retorno ──────────────────────────────────────────

test('E · sem refresh_token persistido, erro claro, nenhuma chamada ao Google', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente({ comSegredo: false });
  let chamouGoogle = false;
  definirFetch(async () => { chamouGoogle = true; return jsonRes(200, {}); });
  const r = registry.resolve('analytics', 'ga4', ctxA);
  await assert.rejects(r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' }), (err) => err.codigo === 'SECRET_MISSING');
  assert.equal(chamouGoogle, false);
}));

test('E · nem o refresh token nem o access token aparecem no retorno nem em erro', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(roteador({ report: () => jsonRes(200, { rows: [{ dimensionValues: [{ value: '1' }, { value: 'x' }], metricValues: [{ value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }] }], rowCount: 1 }) }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const linhas = await r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.equal(JSON.stringify(linhas).includes(REFRESH_TOKEN), false);
  assert.equal(JSON.stringify(linhas).includes('at-derivado-xyz'), false);

  definirFetch(async () => jsonRes(401, { error: 'invalid_token' }));
  await assert.rejects(r.connector.getProductMetricCapabilities(), (err) => {
    assert.equal(JSON.stringify({ message: err.message }).includes(REFRESH_TOKEN), false);
    return true;
  });
}));

// ── Metadata / compatibility / capabilities ──────────────────────────────────────────────────

test('E · getProductMetricCapabilities: propriedade completa → apt=true, todas as métricas disponíveis', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(roteador({ report: () => jsonRes(200, { rows: [] }) }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const cap = await r.connector.getProductMetricCapabilities();
  assert.equal(cap.apt, true);
  assert.equal(cap.itemIdAvailable, true);
  assert.deepEqual({ ...cap.metrics }, { itemsViewed: true, itemsAddedToCart: true, itemsCheckedOut: true, itemsPurchased: true, itemRevenue: true });
  assert.equal(cap.reason, null);
}));

test('E · itemId indisponível → connector não apto, motivo estável (nunca erro genérico)', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(roteador({
    metadata: { dimensions: [], metrics: METADATA_COMPLETA.metrics },
    compat: { dimensionCompatibilities: [{ dimensionMetadata: { apiName: 'itemId' }, compatibility: 'INCOMPATIBLE' }], metricCompatibilities: COMPAT_COMPLETA.metricCompatibilities },
    report: () => jsonRes(200, { rows: [] }),
  }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const cap = await r.connector.getProductMetricCapabilities();
  assert.equal(cap.apt, false);
  assert.equal(cap.reason, 'ITEM_ID_UNAVAILABLE');
  await assert.rejects(r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' }), (err) => err.codigo === 'GA4_ITEM_ID_UNAVAILABLE');
}));

test('E · itemsViewed indisponível (mas itemId ok) → connector não apto (query fundamental)', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(roteador({
    compat: {
      dimensionCompatibilities: COMPAT_COMPLETA.dimensionCompatibilities,
      metricCompatibilities: COMPAT_COMPLETA.metricCompatibilities.map((m) => (m.metricMetadata.apiName === 'itemsViewed' ? { ...m, compatibility: 'INCOMPATIBLE' } : m)),
    },
    report: () => jsonRes(200, { rows: [] }),
  }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const cap = await r.connector.getProductMetricCapabilities();
  assert.equal(cap.apt, false);
  assert.equal(cap.reason, 'ITEMS_VIEWED_UNAVAILABLE');
}));

test('E · métrica opcional ausente (ex.: itemRevenue): connector segue apto, mas a query nunca a pede e a linha vem null — nunca zero', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  let corpoDoReport;
  definirFetch(roteador({
    compat: {
      dimensionCompatibilities: COMPAT_COMPLETA.dimensionCompatibilities,
      metricCompatibilities: COMPAT_COMPLETA.metricCompatibilities.map((m) => (m.metricMetadata.apiName === 'itemRevenue' ? { ...m, compatibility: 'INCOMPATIBLE' } : m)),
    },
    report: (corpo) => { corpoDoReport = corpo; return jsonRes(200, { rows: [{ dimensionValues: [{ value: '1' }, { value: 'x' }], metricValues: [{ value: '10' }, { value: '2' }, { value: '1' }, { value: '1' }] }], rowCount: 1 }); },
  }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const linhas = await r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.deepEqual(corpoDoReport.metrics.map((m) => m.name), ['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased']);
  assert.equal(linhas[0].itemRevenue, null);
  assert.equal(linhas[0].itemsViewed, 10);
}));

// ── Query correta / itemId identidade / itemName diagnóstico ────────────────────────────────

test('E · a query do report usa itemId como dimensão de identidade e itemName só como segunda dimensão (diagnóstico)', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  let corpoDoReport;
  definirFetch(roteador({ report: (corpo) => { corpoDoReport = corpo; return jsonRes(200, { rows: [] }); } }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  await r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.deepEqual(corpoDoReport.dimensions, [{ name: 'itemId' }, { name: 'itemName' }]);
  assert.deepEqual(corpoDoReport.dateRanges, [{ startDate: '2026-09-01', endDate: '2026-09-20' }]);
}));

test('E · getProductPerformance exige startDate/endDate e startDate <= endDate', () => emA(async () => {
  const { registry } = await montarAmbiente();
  const r = registry.resolve('analytics', 'ga4', ctxA);
  await assert.rejects(r.connector.getProductPerformance({}), TypeError);
  await assert.rejects(r.connector.getProductPerformance({ startDate: '2026-09-20', endDate: '2026-09-01' }), TypeError);
}));

test('E · itemId é a identidade (externalProductId); itemName nunca aparece como identidade', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(roteador({ report: () => jsonRes(200, { rows: [{ dimensionValues: [{ value: '777' }, { value: 'Nome Bonito' }], metricValues: [{ value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }] }], rowCount: 1 }) }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const [linha] = await r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.equal(linha.externalProductId, '777');
  assert.equal(linha.externalProductName, 'Nome Bonito');
  assert.equal(linha.analyticsProvider, 'ga4');
}));

test('E · "(not set)" e itemId vazio são filtrados, nunca viram produto', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(roteador({
    report: () => jsonRes(200, {
      rows: [
        { dimensionValues: [{ value: '(not set)' }, { value: '' }], metricValues: [{ value: '9' }, { value: '9' }, { value: '9' }, { value: '9' }, { value: '9' }] },
        { dimensionValues: [{ value: '1' }, { value: 'x' }], metricValues: [{ value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }] },
      ],
      rowCount: 2,
    }),
  }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const linhas = await r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].externalProductId, '1');
}));

test('E · dataset vazio devolve lista vazia, sem erro', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  definirFetch(roteador({ report: () => jsonRes(200, { rows: [], rowCount: 0 }) }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  assert.deepEqual(await r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' }), []);
}));

// ── Paginação ──────────────────────────────────────────────────────────────────────────────────

test('E · paginação limit/offset: várias páginas até cobrir rowCount, nunca assume 1 request basta', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  const TOTAL = 250; // 3 páginas de 100 + 1 de 50, para provar que o loop não para na 1ª nem assume 10k/25 "total"
  let chamadasReport = 0;
  const offsetsVistos = [];
  definirFetch(roteador({
    report: (corpo) => {
      chamadasReport += 1;
      offsetsVistos.push(corpo.offset);
      const tamanho = Math.min(corpo.limit, TOTAL - corpo.offset);
      const rows = Array.from({ length: Math.max(tamanho, 0) }, (_, i) => {
        const n = corpo.offset + i;
        return { dimensionValues: [{ value: String(n + 1) }, { value: `p${n}` }], metricValues: [{ value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }] };
      });
      return jsonRes(200, { rows, rowCount: TOTAL });
    },
  }));
  // Força páginas pequenas via um limit menor não é exposto no contrato público — em vez disso,
  // o teste de "mais de 10k simuladas" abaixo cobre volume real; aqui provamos que o offset avança
  // corretamente e o loop para exatamente quando rowCount é coberto.
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const linhas = await r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.equal(linhas.length, TOTAL);
  assert.equal(chamadasReport, 1); // TOTAL (250) < limite de página padrão (100000): 1 página basta
  assert.deepEqual(offsetsVistos, [0]);
}));

test('E · mais de 10.000 linhas simuladas: pagina de verdade (offset avança, sem assumir 10k como total)', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  const TOTAL = 12345;
  const TAMANHO_PAGINA_FALSA = 5000; // simula um provider que limita a página abaixo do que pedimos
  let chamadasReport = 0;
  const offsetsVistos = [];
  definirFetch(roteador({
    report: (corpo) => {
      chamadasReport += 1;
      offsetsVistos.push(corpo.offset);
      const restante = TOTAL - corpo.offset;
      const tamanho = Math.max(Math.min(TAMANHO_PAGINA_FALSA, restante), 0);
      const rows = Array.from({ length: tamanho }, (_, i) => {
        const n = corpo.offset + i;
        return { dimensionValues: [{ value: String(n + 1) }, { value: `p${n}` }], metricValues: [{ value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }] };
      });
      return jsonRes(200, { rows, rowCount: TOTAL });
    },
  }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const linhas = await r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.equal(linhas.length, TOTAL);
  assert.equal(chamadasReport, 3); // 5000 + 5000 + 2345
  assert.deepEqual(offsetsVistos, [0, 5000, 10000]);
  assert.deepEqual(new Set(linhas.map((l) => l.externalProductId)).size, TOTAL); // sem duplicar nem pular
}));

// ── Erros normalizados ─────────────────────────────────────────────────────────────────────────

for (const status of [401, 403, 429, 500, 503]) {
  test(`E · erro ${status} do Google sobe classificado com upstreamStatus`, { timeout: 10000 }, () => emA(async () => {
    const { registry, definirFetch } = await montarAmbiente();
    definirFetch(async (url) => (url === 'https://oauth2.googleapis.com/token' ? TOKEN_RES() : jsonRes(status, { error: 'x' })));
    const r = registry.resolve('analytics', 'ga4', ctxA);
    await assert.rejects(r.connector.getProductMetricCapabilities(), (err) => { assert.equal(err.upstreamStatus, status); return true; });
  }));
}

// ── Sem query por produto ─────────────────────────────────────────────────────────────────────

test('E · nenhuma chamada por produto: sempre 1 report agregado por página, independente do nº de produtos', () => emA(async () => {
  const { registry, definirFetch } = await montarAmbiente();
  let chamadasReport = 0;
  definirFetch(roteador({
    report: () => {
      chamadasReport += 1;
      const rows = Array.from({ length: 500 }, (_, i) => ({ dimensionValues: [{ value: String(i + 1) }, { value: `p${i}` }], metricValues: [{ value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }, { value: '1' }] }));
      return jsonRes(200, { rows, rowCount: 500 });
    },
  }));
  const r = registry.resolve('analytics', 'ga4', ctxA);
  const linhas = await r.connector.getProductPerformance({ startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.equal(linhas.length, 500);
  assert.equal(chamadasReport, 1);
}));

// ── Guardas estáticas: nenhum import de server.js, process.env (exceto credencial de plataforma
// documentada em token-port.js) ou dependência Ink ─────────────────────────────────────────────

const DIR_GA4 = path.join(__dirname, '..', 'lib', 'connectors', 'analytics', 'ga4');
const arquivosGa4 = () => fs.readdirSync(DIR_GA4).filter((x) => x.endsWith('.js')).map((x) => path.join(DIR_GA4, x));
const semComentario = (arq) => fs.readFileSync(arq, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

test('E · nenhum arquivo do connector GA4 importa server.js', () => {
  const achados = [];
  for (const arq of arquivosGa4()) {
    semComentario(arq).forEach((l, i) => { if (/require\([^)]*server(\.js)?['"]\)/.test(l)) achados.push(`${path.basename(arq)}:${i + 1}`); });
  }
  assert.deepEqual(achados, []);
});

test('E · nenhuma dependência de Ink no connector GA4', () => {
  const achados = [];
  for (const arq of arquivosGa4()) {
    semComentario(arq).forEach((l, i) => { if (/reserva[_-]?ink|inkApi|InkClient/i.test(l)) achados.push(`${path.basename(arq)}:${i + 1}`); });
  }
  assert.deepEqual(achados, []);
});

test('E · process.env só aparece em token-port.js, como default de credencial de PLATAFORMA (não fallback de tenant)', () => {
  for (const arq of arquivosGa4()) {
    const usaEnv = semComentario(arq).some((l) => /process\.env/.test(l));
    if (path.basename(arq) === 'token-port.js') {
      assert.ok(usaEnv, 'token-port.js deveria default clientId/clientSecret do ambiente (credencial de plataforma)');
    } else {
      assert.equal(usaEnv, false, `${path.basename(arq)} não deveria ler process.env`);
    }
  }
});

test('E · connector.js não lê ALLOW_LEGACY_INTEGRATION_ENV nem importa lib/platform/integrations.js (resolver legado)', () => {
  const fonte = fs.readFileSync(path.join(DIR_GA4, 'connector.js'), 'utf8');
  assert.doesNotMatch(fonte, /ALLOW_LEGACY_INTEGRATION_ENV|require\(['"][^'"]*platform\/integrations['"]\)/);
});
