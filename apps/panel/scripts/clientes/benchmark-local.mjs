#!/usr/bin/env node
// BENCHMARK LOCAL de Clientes/RFM/Audiência sobre massa SINTÉTICA e DETERMINÍSTICA (nada aqui descreve a loja real).
// Só roda contra Postgres/painel em 127.0.0.1; recusa qualquer outro host. Não escreve fora do banco de teste.
//
//   BENCH_DATABASE_URL=postgres://postgres:teste@127.0.0.1:PORTA/oria_test   (superusuário do container de teste PRÓPRIO)
//   BENCH_BASE_URL=http://localhost:18086  BENCH_COUNTER_URL=http://127.0.0.1:18087  BENCH_PASSWORD=<senha-de-teste>
//   node scripts/clientes/benchmark-local.mjs --volumes 2000,20000,100000 --samples 7 --out relatorios-privados/rfm-r5/benchmark
//
// O painel precisa ter subido com `--require scripts/clientes/bench-query-counter.cjs` (conta consultas SQL, CPU e memória).
// Para cada volume: recarrega a massa da Organization 1 (SQL determinístico: generate_series), roda ANALYZE, e mede cada endpoint
// (1 aquecimento + N amostras, sequenciais): tempo, nº de consultas SQL (inclui BEGIN/COMMIT/set_config do contexto de tenant),
// CPU do painel e RSS após. Também: importação duplicada, loja vazia, histórico curto, concorrência e invalidação por chave.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const DB = process.env.BENCH_DATABASE_URL;
const BASE = process.env.BENCH_BASE_URL;
const CONTADOR = process.env.BENCH_COUNTER_URL;
const SENHA = process.env.BENCH_PASSWORD;
if (!DB || !BASE || !CONTADOR || !SENHA) throw new Error('defina BENCH_DATABASE_URL, BENCH_BASE_URL, BENCH_COUNTER_URL e BENCH_PASSWORD');
for (const u of [DB, BASE, CONTADOR]) if (!['127.0.0.1', 'localhost'].includes(new URL(u).hostname)) throw new Error(`benchmark local: recusado host não-local (${new URL(u).hostname})`);
const VOLUMES = arg('volumes', '2000,20000,100000').split(',').map(Number);
const AMOSTRAS = Number(arg('samples', 7));
const OUT = path.resolve(arg('out', './relatorios-privados/rfm-r5/benchmark'));
fs.mkdirSync(OUT, { recursive: true });

const ORG = 'a1000000-0000-4000-8000-000000000001';
const STORE = 'a2000000-0000-4000-8000-000000000001';
const pool = new pg.Pool({ connectionString: DB, max: 2 });

// ── massa determinística ─────────────────────────────────────────────────────────────────────────────
// N pedidos, ~N/1,6 compradores (1,6 pedido por comprador em média), histórico de 400 dias, ~3% sem pagamento confirmado,
// ~1% troca, ~70% com opt-in. Documento/telefone derivam do índice do cliente; nada é aleatório.
async function carregarMassa(n) {
  const clientes = Math.max(50, Math.round(n / 1.6));
  await pool.query('DELETE FROM pedidos_ink_itens WHERE organization_id = $1', [ORG]);
  await pool.query('DELETE FROM pedidos_ink WHERE organization_id = $1', [ORG]);
  await pool.query(`
    INSERT INTO pedidos_ink (organization_id, store_id, loja, ink_order_id, payment_status, order_status, buyer_nome, buyer_telefone, buyer_documento,
                             buyer_email, buyer_aceita_marketing, buyer_uf, total_value, criado_em, frete, descontos, items_count, is_troca)
    SELECT $1::uuid, $2::uuid, 'sul', 5000000 + g,
           CASE WHEN g % 33 = 0 THEN 'canceled' ELSE 'paid' END, 'delivered',
           'Sintético ' || (g % $3), '5199' || lpad(((g % $3) + 1000000)::text, 7, '0'), 'BENCH-' || (g % $3), NULL,
           ((g % $3) % 10) < 7, 'RS',
           (40 + ((g * 13) % 260))::numeric(10,2), now() - (((g * 7) % 400) || ' days')::interval, 10, 0, 1, (g % 97 = 0)
      FROM generate_series(1, $4::int) AS g`, [ORG, STORE, clientes, n]);
  await pool.query('ANALYZE pedidos_ink');
  return clientes;
}

// ── medição ──────────────────────────────────────────────────────────────────────────────────────────
let cookie = null;
let csrf = null;
async function req(metodo, rota, corpo) {
  const cab = {};
  if (corpo !== undefined) cab['Content-Type'] = 'application/json';
  if (cookie) cab.Cookie = cookie;
  if (csrf && metodo !== 'GET') cab['X-CSRF-Token'] = csrf;
  const r = await fetch(BASE + rota, { method: metodo, headers: cab, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.includes('oria_session')) cookie = sc.split(';')[0];
  const t = await r.text();
  let json = null;
  try { json = JSON.parse(t); } catch { /* corpo não-JSON */ }
  if (json && json.csrfToken) csrf = json.csrfToken;
  return { status: r.status, json, bytes: Buffer.byteLength(t) };
}
async function entrar(email) {
  cookie = null; csrf = null;
  const r = await req('POST', '/api/admin/login', { email, password: SENHA });
  if (r.status !== 200) throw new Error(`login falhou (${email}): ${r.status}`);
}
const contador = async () => (await fetch(CONTADOR)).json();
const mediana = (v) => { const o = [...v].sort((a, b) => a - b); return o[o.length >> 1]; };
const p95 = (v) => { const o = [...v].sort((a, b) => a - b); return o[Math.min(o.length - 1, Math.ceil(0.95 * o.length) - 1)]; };

async function medir(nome, metodo, rota, corpo, { esperado = 200 } = {}) {
  await req(metodo, rota, corpo); // aquecimento (não entra)
  const tempos = []; const consultas = []; const cpus = []; let rss = 0; let bytes = 0; let status = 0;
  for (let i = 0; i < AMOSTRAS; i += 1) {
    const a = await contador();
    const t0 = performance.now();
    const r = await req(metodo, rota, corpo);
    const dt = performance.now() - t0;
    const b = await contador();
    status = r.status; bytes = r.bytes;
    if (r.status !== esperado) throw new Error(`${nome}: HTTP ${r.status} (esperado ${esperado})`);
    tempos.push(dt); consultas.push(b.consultas - a.consultas - 0); cpus.push(b.cpuMs - a.cpuMs); rss = b.rssMb;
  }
  return { endpoint: nome, status, amostras: AMOSTRAS, ms: { min: Math.min(...tempos), mediana: mediana(tempos), p95: p95(tempos), max: Math.max(...tempos) }, consultasSql: mediana(consultas), cpuMedianaMs: mediana(cpus), rssMbApos: rss, bytesResposta: bytes };
}

const ARQUIVO_RES = path.join(OUT, 'benchmark-local.json');
const resultados = { ambiente: null, volumes: [] };

async function main() {
  const { rows: [v] } = await pool.query('SHOW server_version');
  resultados.ambiente = {
    aviso: 'BENCHMARK LOCAL sobre massa SINTÉTICA e determinística. Não representa a loja real nem a produção.',
    gerado_em: new Date().toISOString(), so: `${os.type()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, memoriaGb: Math.round(os.totalmem() / 2 ** 30),
    node: process.version, postgres: v.server_version, amostrasPorEndpoint: AMOSTRAS, aquecimento: 1, execucao: 'sequencial, um cliente, painel e Postgres na mesma máquina',
  };
  await entrar('local@teste.oria');

  for (const n of VOLUMES) {
    const t0 = performance.now();
    const compradores = await carregarMassa(n);
    const segundosMassa = (performance.now() - t0) / 1000;
    console.log(`\n== ${n} pedidos · ~${compradores} compradores (massa em ${segundosMassa.toFixed(1)} s) ==`);
    const resumo = (await req('GET', '/api/admin/clientes/resumo?dias=tudo')).json;
    const universo = resumo.rfm.universo;
    const segNovos = resumo.rfm.segmentos.find((s) => s.id === 'novos');
    const alvoKey = 'BENCH-1';
    const filtroRfm = (await req('POST', '/api/admin/clientes/segmentos', { nome: `Benchmark ${n}`, origem: 'rfm', segmento: resumo.rfm.segmentos.find((s) => s.clientes > 0).id })).json.segmento.filtros;
    const linhas = [];
    linhas.push(await medir('GET resumo (indicadores + matriz RFM)', 'GET', '/api/admin/clientes/resumo?dias=tudo'));
    linhas.push(await medir('GET lista filtrada por segmento (p.1, 50)', 'GET', `/api/admin/clientes/lista?tipo=com_pedido&per_page=50&segmento=${segNovos.id}&page=1`));
    linhas.push(await medir('GET lista sem filtro (p.1, 50)', 'GET', '/api/admin/clientes/lista?tipo=com_pedido&per_page=50&page=1'));
    linhas.push(await medir('GET lista sem filtro (página profunda)', 'GET', `/api/admin/clientes/lista?tipo=com_pedido&per_page=50&page=${Math.max(1, Math.floor(universo / 50 / 2))}`));
    linhas.push(await medir('POST detalhe do cliente', 'POST', '/api/admin/clientes/detalhe', { customerKey: alvoKey }));
    linhas.push(await medir('GET estado dos segmentos RFM salvos', 'GET', '/api/admin/clientes/segmentos/estado'));
    linhas.push(await medir('POST prévia de Audiência · filtros genéricos', 'POST', '/api/admin/campaigns/audience/preview', { match: 'ALL', filters: [{ field: 'diasSemComprar', op: 'lte', value: 45 }, { field: 'quantidadePedidos', op: 'gte', value: 1 }], exclusions: { semOptIn: true, numeroInvalido: true } }));
    linhas.push(await medir('POST prévia de Audiência · segmento RFM (exata)', 'POST', '/api/admin/campaigns/audience/preview', { match: 'ALL', filters: filtroRfm, exclusions: { semOptIn: true, numeroInvalido: true } }));

    // Concorrência: 8 resumos simultâneos devolvem o MESMO resultado (mesma leitura, sem estado compartilhado entre requests).
    const c0 = performance.now();
    const conc = await Promise.all(Array.from({ length: 8 }, () => req('GET', '/api/admin/clientes/resumo?dias=tudo')));
    const concMs = performance.now() - c0;
    const assinaturas = new Set(conc.map((r) => JSON.stringify(r.json.rfm.segmentos.map((s) => [s.id, s.clientes]))));
    // Invalidação: um pedido novo (mesmo cliente) muda o resultado na PRÓXIMA leitura (não há cache de resumo/lista/prévia a invalidar).
    await pool.query(`INSERT INTO pedidos_ink (organization_id, store_id, loja, ink_order_id, payment_status, order_status, buyer_nome, buyer_telefone, buyer_documento, buyer_aceita_marketing, buyer_uf, total_value, criado_em, frete, descontos, items_count, is_troca)
                      VALUES ($1,$2,'sul',9999999,'paid','delivered','Sintético novo','51990000001','BENCH-INV',true,'RS',500,now(),0,0,1,false)`, [ORG, STORE]);
    const depois = (await req('GET', '/api/admin/clientes/resumo?dias=tudo')).json;
    await pool.query('DELETE FROM pedidos_ink WHERE ink_order_id = 9999999 AND organization_id = $1', [ORG]);

    // Importação duplicada: 1% dos pedidos reaparecem em linha "legada" (store_id nulo) com o MESMO ink_order_id.
    const dup = await pool.query(`INSERT INTO pedidos_ink (organization_id, store_id, loja, ink_order_id, payment_status, order_status, buyer_nome, buyer_telefone, buyer_documento, buyer_aceita_marketing, buyer_uf, total_value, criado_em, frete, descontos, items_count, is_troca)
      SELECT organization_id, NULL, 'sul', ink_order_id + 50000000, payment_status, order_status, buyer_nome, buyer_telefone, buyer_documento, buyer_aceita_marketing, buyer_uf, total_value, criado_em, frete, descontos, items_count, is_troca
        FROM pedidos_ink WHERE organization_id = $1 AND ink_order_id % 100 = 0 RETURNING ink_order_id`, [ORG]);
    const semDedup = (await req('GET', '/api/admin/clientes/resumo?dias=tudo')).json;
    await pool.query('DELETE FROM pedidos_ink WHERE organization_id = $1 AND store_id IS NULL', [ORG]);

    resultados.volumes.push({
      pedidos: n, compradoresAproximados: compradores, universoRfm: universo, segundosParaCarregarMassa: Number(segundosMassa.toFixed(1)),
      endpoints: linhas,
      concorrencia: { requisicoes: 8, tempoTotalMs: Number(concMs.toFixed(0)), respostasIdenticas: assinaturas.size === 1 },
      invalidacao: { antes: universo, depoisDePedidoNovo: depois.rfm.universo, observacao: 'universo +1 na leitura seguinte: nada é cacheado entre requisições' },
      importacaoDuplicada: { linhasDuplicadas: dup.rowCount, universoIgual: semDedup.rfm.universo === universo, pedidosDuplicadosIgnorados: semDedup.cobertura.pedidosDuplicadosIgnorados },
    });
    fs.writeFileSync(ARQUIVO_RES, JSON.stringify(resultados, null, 2));
    for (const l of linhas) console.log(`${l.endpoint.padEnd(52)} mediana ${l.ms.mediana.toFixed(0).padStart(6)} ms · p95 ${l.ms.p95.toFixed(0).padStart(6)} ms · ${String(l.consultasSql).padStart(3)} consultas · cpu ${l.cpuMedianaMs.toFixed(0)} ms · rss ${l.rssMbApos.toFixed(0)} MB`);
  }

  // Loja vazia e histórico curto (Organizations 2 e 3 do seed).
  const extras = [];
  for (const [email, nome] of [['vazio@teste.oria', 'loja vazia'], ['poucos@teste.oria', 'histórico curto (12 compradores)']]) {
    await entrar(email);
    extras.push({ cenario: nome, ...(await medir(`GET resumo · ${nome}`, 'GET', '/api/admin/clientes/resumo?dias=tudo')) });
  }
  resultados.cenariosExtras = extras;
  fs.writeFileSync(ARQUIVO_RES, JSON.stringify(resultados, null, 2));
  console.log(`\nresultado: ${ARQUIVO_RES}`);
}

try { await main(); } finally { await pool.end(); }
