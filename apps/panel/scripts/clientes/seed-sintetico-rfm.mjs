#!/usr/bin/env node
// Fixture SINTÉTICA e DETERMINÍSTICA para inspecionar a UI de Clientes/RFM. Só banco LOCAL de teste; recusa qualquer outro host.
//
//   SEED_DATABASE_URL=postgres://postgres:teste@127.0.0.1:PORTA/oria_test SEED_PASSWORD=<senha-de-teste> \
//     node scripts/clientes/seed-sintetico-rfm.mjs
//
// Cria, em bancos migrados pelo `scripts/test-db.mjs` (cenário A: três Organizations), usuários de teste e pedidos SEM nenhum dado
// real: nomes "Cliente 0001…", documentos/telefones numéricos fabricados. Nada aqui descreve clientes da loja.
//
//   Org 1 (`local@teste.oria`)   1.000 compradores válidos + 20 só com pedido cancelado, com a distribuição-alvo:
//        hibernando 520 (52%) · aguardando recompra 169 (16,9%) · prestes a dormir 250 (25%) · novos 50 (5%) ·
//        potenciais leais 6 (0,6%) · precisam de atenção 3 (0,3%) · primeira compra de alto valor 1 · em risco 1 ·
//        campeões 0 · leais 0 · perdidos 0   (histórico de 300 dias: Perdidos NÃO pode existir; Leais = 0 vem de "valor alto
//        pela soma"; ambos são estruturais, não comportamento).
//   Org 2 (`vazio@teste.oria`)   nenhum pedido (estado vazio).
//   Org 3 (`poucos@teste.oria`)  12 compradores (amostra insuficiente).
//
// O corte de "valor alto" (P75 da soma) cai em 134,90 por construção: só UM cliente recente tem valor ≥ corte.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const require = createRequire(import.meta.url);
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const senhas = require(path.join(RAIZ, 'lib', 'auth', 'password.js'));
const { concederFeatures } = require(path.join(RAIZ, 'test', 'helpers', 'linhas.js'));

const url = process.env.SEED_DATABASE_URL;
const senha = process.env.SEED_PASSWORD;
if (!url || !senha) throw new Error('defina SEED_DATABASE_URL (banco local de teste) e SEED_PASSWORD (senha do usuário de teste)');
const host = new URL(url).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error(`recuso semear em "${host}": só banco local de teste`);

const ORGS = [
  { org: 'a1000000-0000-4000-8000-000000000001', store: 'a2000000-0000-4000-8000-000000000001', loja: 'sul', email: 'local@teste.oria' },
  { org: 'a1000000-0000-4000-8000-000000000002', store: 'a2000000-0000-4000-8000-000000000002', loja: 'centro', email: 'vazio@teste.oria' },
  { org: 'a1000000-0000-4000-8000-000000000003', store: 'a2000000-0000-4000-8000-000000000003', loja: 'norte', email: 'poucos@teste.oria' },
];
const PRODUTOS = [['Camiseta Porto Alegre', 'POA'], ['Camiseta Gramado', 'GRA'], ['Boné Serra', 'SER'], ['Moletom Pampa', 'PAM'], ['Camiseta Floripa', 'FLO']];

// Distribuição-alvo da Org 1 (ordem = ordem de geração; determinística).
const ALVO = [
  ['hibernando', 520], ['prestes_a_dormir', 250], ['aguardando_recompra', 169], ['novos', 50],
  ['potenciais_leais', 6], ['precisam_atencao', 3], ['primeira_alto_valor', 1], ['em_risco', 1],
];
// Recência (dias desde a última compra) e nº de pedidos por segmento — só faixas, sem aleatoriedade.
const FAIXA = {
  hibernando: { r: [181, 300], f: 1 }, prestes_a_dormir: { r: [91, 180], f: 1 }, aguardando_recompra: { r: [46, 90], f: 1 }, novos: { r: [1, 45], f: 1 },
  primeira_alto_valor: { r: [10, 10], f: 1 }, potenciais_leais: { r: [5, 80], f: 2 }, precisam_atencao: { r: [100, 170], f: 2 }, em_risco: { r: [250, 250], f: 2 },
};
const centavos = (v) => Math.round(v * 100) / 100;

function clientesDaOrg1() {
  const lista = [];
  for (const [seg, n] of ALVO) for (let i = 0; i < n; i += 1) lista.push({ seg, i });
  // Valores: 750 "baixos" distintos (60,0 … 134,9) e 250 "altos" (300 …). O 750º menor (134,90) é o P75 por posição.
  const baixos = Array.from({ length: 750 }, (_, k) => centavos(60 + k * 0.1));
  const altos = Array.from({ length: 250 }, (_, k) => centavos(300 + k * 0.5));
  let ib = 0; let ia = 0;
  const novos = lista.filter((c) => c.seg === 'novos');
  novos.forEach((c) => { c.valor = baixos[ib++]; }); // os 50 "novos" ficam com os 50 menores valores (todos < corte)
  lista.find((c) => c.seg === 'primeira_alto_valor').valor = altos[ia++]; // o ÚNICO recente com valor ≥ corte
  const restantes = lista.filter((c) => c.valor == null);
  // Recorrentes usam valores baixos; entre os de 1 compra, cada 4º vai para o grupo alto até completar os 249 restantes.
  restantes.filter((c) => FAIXA[c.seg].f >= 2).forEach((c) => { c.valor = baixos[ib++]; });
  // Exatamente 249 altos entre os de 1 compra restantes, espalhados de forma uniforme (sem aleatoriedade).
  const umaCompra = restantes.filter((c) => c.valor == null);
  umaCompra.forEach((c, k) => {
    const alto = Math.floor(((k + 1) * 249) / umaCompra.length) > Math.floor((k * 249) / umaCompra.length);
    c.valor = alto ? altos[ia++] : baixos[ib++];
  });
  if (ia !== 250 || ib !== 750) throw new Error(`fixture inconsistente: altos ${ia}/250, baixos ${ib}/750`);
  lista.forEach((c, idx) => { c.n = idx + 1; });
  return lista;
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
let ink = 100000;
let item = 900000;
const linhasPedido = [];
const linhasItem = [];
function pedidos(org, c, dias, valor, doc, tel, nome, aceita) {
  const f = c.f;
  const valores = [];
  let restante = valor;
  for (let k = 0; k < f; k += 1) { const v = k === f - 1 ? centavos(restante) : centavos(valor / f); valores.push(v); restante = centavos(restante - v); }
  valores.forEach((v, k) => {
    ink += 1; item += 1;
    const d = dias + k * 30;
    linhasPedido.push([org.org, org.store, org.loja, ink, 'paid', 'delivered', nome, tel, doc, null, aceita, 'RS', v, d, 0, 0, 1, false]);
    const [prod, sku] = PRODUTOS[(c.n + k) % PRODUTOS.length];
    linhasItem.push([org.org, org.store, org.loja, ink, item, 7, prod, `${sku}-${(c.n % 4) + 1}`, 'Masculino', ['Preta', 'Branca', 'Verde'][c.n % 3], ['P', 'M', 'G', 'GG'][c.n % 4], 1, v, 0, 40, 20]);
  });
}

const COLS_P = 'organization_id,store_id,loja,ink_order_id,payment_status,order_status,buyer_nome,buyer_telefone,buyer_documento,buyer_email,buyer_aceita_marketing,buyer_uf,total_value,criado_em,frete,descontos,items_count,is_troca';
const COLS_I = 'organization_id,store_id,loja,ink_order_id,item_id,produto_id,produto_nome,sku,modelo,cor,tamanho,quantidade,valor_venda,desconto_rateado,custo_producao,lucro_operacional';

async function inserir(tabela, cols, rows, tsIndex) {
  for (let i = 0; i < rows.length; i += 400) {
    const parte = rows.slice(i, i + 400);
    const params = []; const ph = [];
    parte.forEach((r, ri) => {
      ph.push(`(${r.map((_, ci) => (ci === tsIndex ? `now() - ($${ri * r.length + ci + 1}::int * interval '1 day')` : `$${ri * r.length + ci + 1}`)).join(',')})`);
      params.push(...r);
    });
    await pool.query(`INSERT INTO ${tabela} (${cols}) VALUES ${ph.join(',')}`, params);
  }
}

try {
  const hash = await senhas.gerarHash(senha);
  for (const o of ORGS) {
    const { rows: [u] } = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id', [o.email, hash]);
    await pool.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [o.org, u.id]);
    await pool.query('DELETE FROM pedidos_ink_itens WHERE organization_id = $1', [o.org]);
    await pool.query('DELETE FROM pedidos_ink WHERE organization_id = $1', [o.org]);
    await concederFeatures(pool, o.org, { whatsapp: true });
  }
  // Org 1
  const o1 = ORGS[0];
  for (const c of clientesDaOrg1()) {
    const { r, f } = FAIXA[c.seg];
    const dias = r[0] === r[1] ? r[0] : r[0] + ((c.i * 7) % (r[1] - r[0] + 1));
    const n = c.n;
    pedidos(o1, { ...c, f }, dias, c.valor, `1${String(n).padStart(10, '0')}`, `5199${String(1000000 + n)}`, `Cliente ${String(n).padStart(4, '0')}`, n % 2 === 0);
  }
  // 20 identidades só com pedido cancelado (sem compra válida)
  for (let k = 1; k <= 20; k += 1) {
    ink += 1;
    linhasPedido.push([o1.org, o1.store, o1.loja, ink, 'canceled', 'canceled', `Cancelado ${String(k).padStart(3, '0')}`, `5198${String(2000000 + k)}`, `2${String(k).padStart(10, '0')}`, null, false, 'RS', 100, 30 + k, 0, 0, 1, false]);
  }
  // Org 3: 12 compradores (amostra insuficiente)
  const o3 = ORGS[2];
  for (let k = 1; k <= 12; k += 1) pedidos(o3, { n: 5000 + k, f: 1 }, 10 + k * 8, centavos(80 + k * 7), `3${String(k).padStart(10, '0')}`, `5197${String(3000000 + k)}`, `Cliente ${String(5000 + k)}`, true);
  await inserir('pedidos_ink', COLS_P, linhasPedido, 13);
  await inserir('pedidos_ink_itens', COLS_I, linhasItem, -1);
  process.stdout.write(`semeado: ${linhasPedido.length} pedidos, ${linhasItem.length} itens (sintéticos)\n`);
} finally {
  await pool.end();
}
