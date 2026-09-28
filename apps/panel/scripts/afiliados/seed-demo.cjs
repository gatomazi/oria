#!/usr/bin/env node
'use strict';

// Semeia um cenário de DEMONSTRAÇÃO do módulo Parcerias e Afiliados num banco LOCAL: Organization/Store 1:1, owner e member, três parceiros
// (collab, cupom, híbrido), contratos versionados, cupons, uma collab com duas estampas, ~20 pedidos SINTÉTICOS da INK (cupom, collab sem
// cupom, pedido misto, devolução parcial, cancelamento, troca, sem custo, sem snapshot) e um pagamento parcial. Roda a MESMA reconciliação
// do produto. Nada de dado real, nada de rede, nada de INK.
//
// Trava de segurança (fail-closed): só roda contra Postgres em localhost/127.0.0.1 e nunca com NODE_ENV=production. Recusa a Organization
// se ela já existir com outro nome. Uso:
//   DATABASE_URL=postgres://... DEMO_SENHA='uma-senha-local' node scripts/afiliados/seed-demo.cjs [--org-id <uuid>]
// Depois: AFILIADOS_MODULE_ENABLED=true npm start  →  /admin/parcerias  (login: demo-owner@local.oria / a senha acima).

const crypto = require('node:crypto');
const path = require('node:path');
const pg = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..');
const { gerarHash } = require(path.join(RAIZ, 'lib/auth/password.js'));
const runtime = require(path.join(RAIZ, 'lib/platform/tenant-runtime.js'));
const { criarAfiliados } = require(path.join(RAIZ, 'lib/afiliados/index.js'));

function recusar(msg) { console.error(`seed-demo: ${msg}`); process.exit(2); }

const url = process.env.DATABASE_URL;
if (!url) recusar('DATABASE_URL ausente');
if (process.env.NODE_ENV === 'production') recusar('NODE_ENV=production: este script é só para banco local');
let host;
try { host = new URL(url).hostname; } catch { recusar('DATABASE_URL inválida'); }
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) recusar(`host "${host}" não é local — recusado (nunca rode isto contra staging ou produção)`);
const senha = process.env.DEMO_SENHA;
if (!senha || senha.length < 12) recusar('defina DEMO_SENHA com pelo menos 12 caracteres (senha do owner de DEMONSTRAÇÃO, local)');

const argOrg = process.argv.indexOf('--org-id');
const ORG = argOrg > -1 ? process.argv[argOrg + 1] : 'de000000-0000-4000-8000-000000000001';
if (!/^[0-9a-f-]{36}$/i.test(ORG)) recusar('--org-id inválido');

const DIA = 86400000;
let agora = new Date();
const relogio = () => new Date(agora);
const dias = (n) => new Date(Date.now() + n * DIA);

async function main() {
  const real = new pg.Pool({ connectionString: url, max: 4 });
  try {
    const ctxBanco = await real.query('SELECT current_database() AS db');
    console.log(`banco: ${ctxBanco.rows[0].db} @ ${host}`);
    const existente = await real.query('SELECT nome FROM organizations WHERE id = $1', [ORG]);
    let storeId;
    if (existente.rows[0]) {
      if (existente.rows[0].nome !== 'Demo Afiliados') recusar(`a Organization ${ORG} já existe e não é a de demonstração`);
      storeId = (await real.query('SELECT id FROM stores WHERE organization_id = $1', [ORG])).rows[0].id;
    } else {
      await real.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [ORG, 'Demo Afiliados']);
      storeId = crypto.randomUUID();
      await real.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [storeId, ORG, 'Loja Demo']);
    }
    for (const [email, papel] of [['demo-owner@local.oria', 'owner'], ['demo-member@local.oria', 'member']]) {
      const { rows: [u] } = await real.query(
        `INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
        [email, papel === 'owner' ? 'Owner Demo' : 'Member Demo', await gerarHash(senha)]
      );
      await real.query(
        `INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id) DO UPDATE SET papel = EXCLUDED.papel`,
        [ORG, u.id, papel]
      );
    }
    const donoId = (await real.query(`SELECT id FROM users WHERE email = 'demo-owner@local.oria'`)).rows[0].id;
    if ((await real.query('SELECT 1 FROM partnership_partners WHERE organization_id = $1 LIMIT 1', [ORG])).rows[0]) {
      console.log('cenário já semeado nesta Organization — nada a fazer.');
      return;
    }

    const ctx = { organizationId: ORG, storeId, userId: donoId };
    const svc = criarAfiliados({ pool: runtime.criarPoolTenant(real), relogio, flags: { inkPromotionWritesEnabled: false } });
    const em = (fn) => runtime.comContexto({ organizationId: ORG, storeId, origem: 'seed-demo' }, fn);
    let proximoItem = 5000;

    async function pedido({ id, quando, pagamento = 'paid', situacao = 'paid', entrega = null, cupom = null, promocao = '0', troca = false, completo = true, itens }) {
      await real.query(
        `INSERT INTO pedidos_ink (organization_id, store_id, ink_order_id, payment_status, order_status, total_value, criado_em, is_troca, promotion_code, promotion_value,
           payment_discount_value, delivered_at, affiliate_snapshot_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'0',$11,$12) ON CONFLICT DO NOTHING`,
        [ORG, storeId, id, pagamento, situacao, '200', quando, troca, cupom, promocao, entrega, completo ? quando : null]
      );
      for (const it of itens) {
        proximoItem += 1;
        await real.query(
          `INSERT INTO pedidos_ink_itens (organization_id, store_id, ink_order_id, item_id, produto_id, produto_nome, sku, quantidade, valor_venda, desconto_rateado, custo_producao, lucro_operacional,
             unit_value, refunded_quantity, free_quantity, unit_ink_base_price, unit_additional_service_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,0,$11,$12,0,$13,'0') ON CONFLICT DO NOTHING`,
          [ORG, storeId, id, proximoItem, it.produto, it.nome, `SKU-${it.produto}`, it.qtd ?? 1, it.total, it.custo ?? '60', it.unit ?? it.total, it.devolvidas ?? 0, it.custoBase === undefined ? '60.00' : it.custoBase]
        );
      }
    }

    // ── 1. Cadastro (há 70 dias) ─────────────────────────────────────────────────────────────────
    agora = dias(-70);
    let amanda; let bruno; let carla; let kAmanda; let kBruno; let kCarla; let collab;
    await em(async () => {
      amanda = await svc.registry.criarParceiro(ctx, { publicName: 'Amanda Ribeiro', contactEmail: 'amanda@exemplo.invalid', profiles: [{ network: 'instagram', handle: '@amanda.estampas' }], origin: 'indicação', communityRegion: 'Florianópolis' }, { aprovarDireto: true });
      bruno = await svc.registry.criarParceiro(ctx, { publicName: 'Bruno Matos', contactEmail: 'bruno@exemplo.invalid', profiles: [{ network: 'tiktok', handle: '@brunomatos' }] }, { aprovarDireto: true });
      carla = await svc.registry.criarParceiro(ctx, { publicName: 'Carla Duarte', profiles: [{ network: 'youtube', handle: '@carladuarte' }], origin: 'formulário' }, { aprovarDireto: true });
      await svc.registry.criarParceiro(ctx, { publicName: 'Diego Candidato', origin: 'formulário' });
      kAmanda = (await svc.registry.criarContrato(ctx, { partnerId: amanda.id, modality: 'collab', title: 'Collab Praia do Rosa', status: 'active', reason: 'acordo inicial', terms: { commissionBasis: 'verified_margin_percent', commissionBps: 1500 } }, { podeAtivar: true })).contract.id;
      kBruno = (await svc.registry.criarContrato(ctx, { partnerId: bruno.id, modality: 'coupon', title: 'Programa de cupom', status: 'active', reason: 'programa de cupons', terms: { commissionBasis: 'net_item_revenue_percent', commissionBps: 1000, levelCapOverrideReason: 'sem histórico de vendas para verificar o teto (demonstração)' } }, { podeAtivar: true })).contract.id;
      kCarla = (await svc.registry.criarContrato(ctx, { partnerId: carla.id, modality: 'hybrid', title: 'Híbrido Carla', status: 'active', reason: 'acordo inicial', terms: { commissionBasis: 'fixed_per_unit', fixedPerUnitCents: 700, levelCapOverrideReason: 'sem histórico de vendas para verificar o teto (demonstração)' } }, { podeAtivar: true })).contract.id;
      collab = await svc.collabs.criarCollab(ctx, { name: 'Praia do Rosa · Amanda', collectionUrl: 'https://loja.exemplo.invalid/praia-do-rosa' });
      await svc.collabs.adicionarCriador(ctx, collab.id, { partnerId: amanda.id, contractId: kAmanda, shareBps: 10000 });
      await svc.collabs.adicionarProdutos(ctx, collab.id, { products: [{ inkProductId: '111', productName: 'Camiseta Praia do Rosa' }, { inkProductId: '112', productName: 'Caneca Praia do Rosa' }] });
      await svc.collabs.atualizarCollab(ctx, collab.id, { status: 'active' });
      const c1 = await svc.registry.criarCupom(ctx, { partnerId: bruno.id, contractId: kBruno, code: 'BRUNO10', discountKind: 'percentage', discountBps: 1000 });
      await svc.registry.ativarCupom(ctx, c1.id);
      const c2 = await svc.registry.criarCupom(ctx, { partnerId: carla.id, contractId: kCarla, code: 'CARLA15', discountKind: 'percentage', discountBps: 1500 });
      await svc.registry.ativarCupom(ctx, c2.id);
      const c3 = await svc.registry.criarCupom(ctx, { partnerId: carla.id, contractId: kCarla, code: 'CARLA20', discountKind: 'percentage', discountBps: 2000 });
      void c3; // fica "aguardando validação": ainda não comissiona
      await svc.collabs.adicionarProdutos(ctx, (await svc.collabs.criarCollab(ctx, { name: 'Carla · Serra' })).id, { products: [{ inkProductId: '222', productName: 'Camiseta Serra' }] });
    });
    // Contrato de Carla também cobre collab: precisa de collab própria com criadora.
    await em(async () => {
      const lista = await svc.collabs.listarCollabs(ctx);
      const serra = lista.find((c) => c.name === 'Carla · Serra');
      await svc.collabs.adicionarCriador(ctx, serra.id, { partnerId: carla.id, contractId: kCarla, shareBps: 10000 });
      await svc.collabs.atualizarCollab(ctx, serra.id, { status: 'active' });
    });

    // ── 2. Pedidos sintéticos (de -60 a -1 dia) ──────────────────────────────────────────────────
    const P = (n) => dias(-n);
    await pedido({ id: 90001, quando: P(60), entrega: P(56), itens: [{ produto: 111, nome: 'Camiseta Praia do Rosa', total: '100.00' }] });                                       // collab sem cupom
    await pedido({ id: 90002, quando: P(55), entrega: P(51), itens: [{ produto: 112, nome: 'Caneca Praia do Rosa', total: '60.00', custoBase: '25.00' }] });
    await pedido({ id: 90003, quando: P(50), entrega: P(46), cupom: 'bruno10', promocao: '20.00', itens: [{ produto: 111, nome: 'Camiseta Praia do Rosa', total: '100.00' }, { produto: 500, nome: 'Camiseta Lisa', total: '100.00' }] }); // misto: cupom de terceiro
    await pedido({ id: 90004, quando: P(48), entrega: P(44), cupom: 'BRUNO10', promocao: '10.00', itens: [{ produto: 500, nome: 'Camiseta Lisa', total: '100.00' }] });
    await pedido({ id: 90005, quando: P(45), entrega: P(41), cupom: 'BRUNO10', promocao: '10.00', itens: [{ produto: 501, nome: 'Camiseta Oversized', total: '120.00' }] });
    await pedido({ id: 90006, quando: P(40), entrega: P(36), cupom: 'BRUNO10', promocao: '15.00', itens: [{ produto: 500, nome: 'Camiseta Lisa', total: '150.00' }] });
    await pedido({ id: 90007, quando: P(38), entrega: P(34), itens: [{ produto: 111, nome: 'Camiseta Praia do Rosa', qtd: 2, total: '200.00', devolvidas: 1 }] });                    // 2 un., 1 devolvida
    await pedido({ id: 90008, quando: P(35), pagamento: 'canceled', situacao: 'canceled', cupom: 'BRUNO10', itens: [{ produto: 500, nome: 'Camiseta Lisa', total: '100.00' }] }); // cancelado: nunca comissiona
    await pedido({ id: 90009, quando: P(33), entrega: P(29), cupom: 'CARLA15', promocao: '15.00', itens: [{ produto: 501, nome: 'Camiseta Oversized', qtd: 2, total: '240.00' }] });        // fixo por unidade
    await pedido({ id: 90010, quando: P(30), entrega: P(26), itens: [{ produto: 222, nome: 'Camiseta Serra', total: '110.00' }] });                                                      // collab da Carla
    await pedido({ id: 90011, quando: P(28), entrega: P(24), cupom: 'BRUNO10', promocao: '10.00', itens: [{ produto: 500, nome: 'Camiseta Lisa', total: '100.00' }] });
    await pedido({ id: 90012, quando: P(25), troca: true, entrega: P(21), cupom: 'BRUNO10', itens: [{ produto: 500, nome: 'Camiseta Lisa', total: '100.00' }] });                        // troca: não é venda
    await pedido({ id: 90013, quando: P(22), entrega: P(18), itens: [{ produto: 111, nome: 'Camiseta Praia do Rosa', total: '100.00', custoBase: null }] });                              // custo desconhecido → revisão
    await pedido({ id: 90014, quando: P(20), completo: false, cupom: 'BRUNO10', itens: [{ produto: 500, nome: 'Camiseta Lisa', total: '100.00' }] });                                    // sem snapshot → revisão
    await pedido({ id: 90015, quando: P(18), itens: [{ produto: null, nome: 'Item sem produto', total: '90.00' }], entrega: P(14) });                                                     // sem product_id → revisão
    await pedido({ id: 90016, quando: P(15), entrega: P(11), cupom: 'BRUNO10', promocao: '10.00', itens: [{ produto: 501, nome: 'Camiseta Oversized', total: '120.00' }] });
    await pedido({ id: 90017, quando: P(12), entrega: P(8), itens: [{ produto: 112, nome: 'Caneca Praia do Rosa', total: '60.00', custoBase: '25.00' }] });
    await pedido({ id: 90018, quando: P(8), entrega: P(4), cupom: 'CARLA15', promocao: '15.00', itens: [{ produto: 500, nome: 'Camiseta Lisa', total: '150.00' }] });
    await pedido({ id: 90019, quando: P(5), itens: [{ produto: 111, nome: 'Camiseta Praia do Rosa', total: '100.00' }] });                                                          // pago, ainda sem entrega → provisionado
    await pedido({ id: 90020, quando: P(2), pagamento: 'waiting_payment', situacao: 'waiting_payment', cupom: 'BRUNO10', itens: [{ produto: 500, nome: 'Camiseta Lisa', total: '100.00' }] }); // aguardando pagamento

    // ── 3. Reconciliação (a MESMA do produto) e um pagamento parcial ─────────────────────────────
    agora = new Date();
    const r = await em(() => svc.reconciliarTudo(ctx, { completo: true }));
    console.log(`reconciliação: ${r.pedidosAvaliados} pedidos, ${r.criadas} atribuições, ${r.revisoes} itens em revisão, ${r.promovidos} liberações, ${r.propostasCriadas} propostas de nível`);
    await em(async () => {
      const ext = await svc.payables.extratoDoParceiro(ctx, amanda.id, { limit: 100 });
      const liberados = ext.itens.filter((i) => i.status === 'released' && i.openCents > 0);
      if (liberados.length) {
        const alvo = liberados[0];
        await svc.payables.registrarPagamento(ctx, {
          partnerId: amanda.id, idempotencyKey: 'demo-pgto-1', method: 'pix', paidAt: dias(-3).toISOString(), externalReference: 'DEMO-PIX-0001',
          allocations: [{ ledgerId: alvo.id, amountCents: Math.max(1, Math.floor(alvo.openCents / 2)) }], notes: 'pagamento parcial de demonstração',
        });
        console.log('pagamento parcial registrado para Amanda (metade do primeiro lançamento liberado).');
      }
    });
    console.log('\nPronto. Suba o painel com AFILIADOS_MODULE_ENABLED=true e entre em /admin/parcerias.');
    console.log('  owner : demo-owner@local.oria');
    console.log('  member: demo-member@local.oria   (mesma senha que você definiu em DEMO_SENHA)');
  } finally {
    await real.end();
  }
}

main().catch((err) => { console.error(`seed-demo: falhou — ${err.message}`); process.exit(1); });
