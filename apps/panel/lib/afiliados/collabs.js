'use strict';

// Collabs por estampa: a arte pode estar em vários produtos (camiseta, peruana, caneca...) ou num produto isolado sem cluster.
// A apuração usa o snapshot VERSIONADO de ids de produto participantes (partner_collab_product_memberships); o cluster da INK só
// ajuda a DESCOBRIR produtos novos e nunca comissiona sozinho. Nova associação nunca é retroativa sem comando expresso e auditoria.

const db = require('./db');

const { erro, entradaInvalida, naoEncontrado, conflito, exigirUuid, textoOpcional, textoObrigatorio, inteiro, opcao, dataIso } = db;

const RE_ID_INK = /^[0-9]{1,18}$/;

function idInk(valor, nome) {
  const t = String(valor === undefined || valor === null ? '' : valor).trim();
  if (!RE_ID_INK.test(t)) throw entradaInvalida(`${nome} inválido (esperado inteiro da INK)`);
  return t;
}

function urlHttps(valor, nome) {
  const t = textoOpcional(valor, { max: 500, nome });
  if (t && !/^https:\/\/[^\s]+$/.test(t)) throw entradaInvalida(`${nome} deve começar com https://`);
  return t;
}

function criarCollabs({ pool, relogio = () => new Date(), registry }) {
  const mapearCollab = (r) => ({
    id: r.id, name: r.name, imageUrl: r.image_url, collectionUrl: r.collection_url, startsAt: r.starts_at, endsAt: r.ends_at, status: r.status,
    newMemberPolicy: r.new_member_policy, notes: r.notes, createdAt: r.created_at,
  });

  async function obterCollab(c, ctx, id, { travar = false } = {}) {
    const { rows } = await c.query(`SELECT * FROM partner_collabs WHERE organization_id = $1 AND id = $2 ${travar ? 'FOR UPDATE' : ''}`, [ctx.organizationId, exigirUuid(id, 'collab')]);
    if (!rows[0]) throw naoEncontrado('collab');
    return rows[0];
  }

  async function criarCollab(ctx, entrada) {
    const agora = relogio();
    const nome = textoObrigatorio(entrada.name, { max: 160, nome: 'nome interno' });
    const inicio = dataIso(entrada.startsAt, { nome: 'início', obrigatorio: false }) || agora;
    const fim = dataIso(entrada.endsAt, { nome: 'fim', obrigatorio: false });
    if (fim && fim <= inicio) throw entradaInvalida('fim deve ser depois do início');
    const politica = opcao(entrada.newMemberPolicy, ['require_approval', 'auto_include'], { nome: 'política de novos produtos', padrao: 'require_approval' });
    return db.tx(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO partner_collabs (organization_id, store_id, name, image_url, collection_url, starts_at, ends_at, new_member_policy, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [ctx.organizationId, ctx.storeId, nome, urlHttps(entrada.imageUrl, 'imagem'), urlHttps(entrada.collectionUrl, 'página da coleção'), inicio, fim, politica,
          textoOpcional(entrada.notes, { max: 4000, nome: 'observações' }), ctx.userId || null]
      );
      await db.auditar(c, ctx, { entidade: 'collab', entidadeId: rows[0].id, acao: 'collab.create', depois: { name: nome, newMemberPolicy: politica } });
      return mapearCollab(rows[0]);
    });
  }

  async function atualizarCollab(ctx, id, entrada) {
    return db.tx(pool, async (c) => {
      const antes = await obterCollab(c, ctx, id, { travar: true });
      const valores = [ctx.organizationId, antes.id];
      const sets = [];
      const add = (coluna, valor) => { valores.push(valor); sets.push(`${coluna} = $${valores.length}`); };
      if (entrada.name !== undefined) add('name', textoObrigatorio(entrada.name, { max: 160, nome: 'nome interno' }));
      if (entrada.imageUrl !== undefined) add('image_url', urlHttps(entrada.imageUrl, 'imagem'));
      if (entrada.collectionUrl !== undefined) add('collection_url', urlHttps(entrada.collectionUrl, 'página da coleção'));
      if (entrada.notes !== undefined) add('notes', textoOpcional(entrada.notes, { max: 4000, nome: 'observações' }));
      if (entrada.newMemberPolicy !== undefined) add('new_member_policy', opcao(entrada.newMemberPolicy, ['require_approval', 'auto_include'], { nome: 'política de novos produtos' }));
      if (entrada.endsAt !== undefined) {
        const fim = dataIso(entrada.endsAt, { nome: 'fim', obrigatorio: false });
        if (fim && fim <= new Date(antes.starts_at)) throw entradaInvalida('fim deve ser depois do início');
        add('ends_at', fim);
      }
      if (entrada.status !== undefined) {
        const novo = opcao(entrada.status, ['draft', 'active', 'ended'], { nome: 'status' });
        if (antes.status === 'ended' && novo !== 'ended') throw conflito('AFILIADOS_TRANSICAO_INVALIDA', 'collab encerrada não reabre; crie outra');
        add('status', novo);
      }
      if (!sets.length) return mapearCollab(antes);
      const { rows } = await c.query(`UPDATE partner_collabs SET ${sets.join(', ')}, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`, valores);
      await db.auditar(c, ctx, { entidade: 'collab', entidadeId: antes.id, acao: 'collab.update', antes: { status: antes.status, newMemberPolicy: antes.new_member_policy }, depois: { status: rows[0].status, newMemberPolicy: rows[0].new_member_policy } });
      return mapearCollab(rows[0]);
    });
  }

  // ── Criadores ───────────────────────────────────────────────────────────────────────────────────
  async function adicionarCriador(ctx, collabId, entrada) {
    const agora = relogio();
    const partnerId = exigirUuid(entrada.partnerId, 'parceiro');
    const contractId = exigirUuid(entrada.contractId, 'contrato');
    const share = inteiro(entrada.shareBps ?? 10000, { nome: 'participação (bps)', min: 1, max: 10000 });
    return db.tx(pool, async (c) => {
      const collab = await obterCollab(c, ctx, collabId, { travar: true });
      const { rows: kv } = await c.query(
        `SELECT k.partner_id, k.modality FROM partnership_contracts k WHERE k.organization_id = $1 AND k.id = $2`, [ctx.organizationId, contractId]
      );
      if (!kv[0] || kv[0].partner_id !== partnerId) throw naoEncontrado('contrato');
      if (!['collab', 'hybrid'].includes(kv[0].modality)) throw conflito('AFILIADOS_MODALIDADE_INCOMPATIVEL', 'o contrato não é de collab nem híbrido');
      try {
        const { rows } = await c.query(
          `INSERT INTO partner_collab_creators (organization_id, store_id, collab_id, partner_id, contract_id, share_bps, valid_from, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [ctx.organizationId, ctx.storeId, collab.id, partnerId, contractId, share, agora, ctx.userId || null]
        );
        await db.auditar(c, ctx, { entidade: 'collab', entidadeId: collab.id, acao: 'collab.creator.add', depois: { partnerId, contractId, shareBps: share } });
        return { id: rows[0].id, partnerId, contractId, shareBps: share, validFrom: rows[0].valid_from };
      } catch (err) {
        if (err && err.code === '23514') throw conflito('AFILIADOS_PARTICIPACAO_EXCEDIDA', 'as participações dos criadores da collab passariam de 100%');
        if (err && err.code === '23505') throw conflito('AFILIADOS_CRIADOR_DUPLICADO', 'este parceiro já é criador vigente desta collab');
        throw err;
      }
    });
  }

  async function encerrarCriador(ctx, collabId, creatorId, { motivo }) {
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const collab = await obterCollab(c, ctx, collabId, { travar: true });
      const { rows } = await c.query(
        `UPDATE partner_collab_creators SET valid_to = GREATEST(now(), valid_from + interval '1 second') WHERE organization_id = $1 AND collab_id = $2 AND id = $3 AND valid_to IS NULL RETURNING *`,
        [ctx.organizationId, collab.id, exigirUuid(creatorId, 'criador')]
      );
      if (!rows[0]) throw naoEncontrado('criador vigente');
      await db.auditar(c, ctx, { entidade: 'collab', entidadeId: collab.id, acao: 'collab.creator.end', antes: { partnerId: rows[0].partner_id, shareBps: rows[0].share_bps }, motivo: m });
      return { id: rows[0].id, validTo: rows[0].valid_to };
    });
  }

  // ── Produtos participantes ──────────────────────────────────────────────────────────────────────
  const mapearMembership = (r) => ({
    id: r.id, collabId: r.collab_id, inkProductId: String(r.ink_product_id), inkVariantId: r.ink_variant_id === null ? null : String(r.ink_variant_id),
    inkClusterId: r.ink_cluster_id === null ? null : String(r.ink_cluster_id), productName: r.product_name, status: r.status, source: r.source,
    validFrom: r.valid_from, validTo: r.valid_to, createdAt: r.created_at,
  });

  function lerProdutos(lista) {
    if (!Array.isArray(lista) || lista.length === 0 || lista.length > 100) throw entradaInvalida('informe de 1 a 100 produtos');
    const vistos = new Set();
    return lista.map((p) => {
      const id = idInk(p && p.inkProductId, 'inkProductId');
      if (vistos.has(id)) throw entradaInvalida(`produto ${id} repetido`);
      vistos.add(id);
      return {
        inkProductId: id,
        inkVariantId: p.inkVariantId === undefined || p.inkVariantId === null || p.inkVariantId === '' ? null : idInk(p.inkVariantId, 'inkVariantId'),
        inkClusterId: p.inkClusterId === undefined || p.inkClusterId === null || p.inkClusterId === '' ? null : idInk(p.inkClusterId, 'inkClusterId'),
        productName: textoOpcional(p.productName, { max: 200, nome: 'nome do produto' }),
      };
    });
  }

  // Início da vigência da associação: agora. Retroativo só com `retroativoDesde` + motivo (owner) e auditoria própria.
  function inicioDaAssociacao(agora, { retroativoDesde, motivo, podeRetroagir }) {
    if (!retroativoDesde) return { inicio: agora, retroativo: false };
    if (!podeRetroagir) throw erro(403, 'AFILIADOS_SEM_PERMISSAO', 'associação retroativa exige owner');
    const d = dataIso(retroativoDesde, { nome: 'retroativoDesde' });
    if (d > agora) throw entradaInvalida('retroativoDesde não pode estar no futuro');
    if (!textoOpcional(motivo, { max: 500, nome: 'motivo' })) throw entradaInvalida('associação retroativa exige motivo');
    return { inicio: d, retroativo: true };
  }

  async function adicionarProdutos(ctx, collabId, entrada, { podeRetroagir = false } = {}) {
    const agora = relogio();
    const produtos = lerProdutos(entrada.products);
    const { inicio, retroativo } = inicioDaAssociacao(agora, { retroativoDesde: entrada.retroativoDesde, motivo: entrada.reason, podeRetroagir });
    return db.tx(pool, async (c) => {
      const collab = await obterCollab(c, ctx, collabId, { travar: true });
      if (collab.status === 'ended') throw conflito('AFILIADOS_COLLAB_ENCERRADA', 'a collab está encerrada');
      const criados = [];
      for (const p of produtos) {
        const { rows: ativo } = await c.query(
          `SELECT m.collab_id, k.name FROM partner_collab_product_memberships m JOIN partner_collabs k ON k.id = m.collab_id AND k.organization_id = m.organization_id
            WHERE m.organization_id = $1 AND m.ink_product_id = $2 AND m.status = 'active'`, [ctx.organizationId, p.inkProductId]
        );
        if (ativo[0]) {
          if (ativo[0].collab_id === collab.id) continue;
          throw conflito('AFILIADOS_PRODUTO_EM_OUTRA_COLLAB', `o produto ${p.inkProductId} já pertence à collab "${ativo[0].name}"`, { collabId: ativo[0].collab_id });
        }
        // Promove uma proposta pendente do mesmo produto, se houver; senão cria ativa.
        const { rows: pend } = await c.query(
          `SELECT id FROM partner_collab_product_memberships WHERE organization_id = $1 AND collab_id = $2 AND ink_product_id = $3 AND status = 'pending_approval'`,
          [ctx.organizationId, collab.id, p.inkProductId]
        );
        let linha;
        if (pend[0]) {
          ({ rows: [linha] } = await c.query(
            `UPDATE partner_collab_product_memberships SET status = 'active', valid_from = $3, approved_by = $4, ink_variant_id = COALESCE($5, ink_variant_id), ink_cluster_id = COALESCE($6, ink_cluster_id),
               product_name = COALESCE($7, product_name) WHERE organization_id = $1 AND id = $2 RETURNING *`,
            [ctx.organizationId, pend[0].id, inicio, ctx.userId || null, p.inkVariantId, p.inkClusterId, p.productName]
          ));
        } else {
          ({ rows: [linha] } = await c.query(
            `INSERT INTO partner_collab_product_memberships (organization_id, store_id, collab_id, ink_product_id, ink_variant_id, ink_cluster_id, product_name, status, source, valid_from, created_by, approved_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'active','manual',$8,$9,$9) RETURNING *`,
            [ctx.organizationId, ctx.storeId, collab.id, p.inkProductId, p.inkVariantId, p.inkClusterId, p.productName, inicio, ctx.userId || null]
          ));
        }
        criados.push(mapearMembership(linha));
        await db.auditar(c, ctx, {
          entidade: 'collab', entidadeId: collab.id, acao: retroativo ? 'collab.product.add.retroactive' : 'collab.product.add', depois: { inkProductId: p.inkProductId, validFrom: inicio }, motivo: retroativo ? entrada.reason : null,
        });
      }
      return { adicionados: criados, retroativo };
    });
  }

  async function aprovarProduto(ctx, collabId, membershipId, entrada = {}, { podeRetroagir = false } = {}) {
    const agora = relogio();
    const { inicio, retroativo } = inicioDaAssociacao(agora, { retroativoDesde: entrada.retroativoDesde, motivo: entrada.reason, podeRetroagir });
    return db.tx(pool, async (c) => {
      const collab = await obterCollab(c, ctx, collabId, { travar: true });
      const { rows } = await c.query(
        `SELECT * FROM partner_collab_product_memberships WHERE organization_id = $1 AND collab_id = $2 AND id = $3 AND status = 'pending_approval' FOR UPDATE`,
        [ctx.organizationId, collab.id, exigirUuid(membershipId, 'produto da collab')]
      );
      if (!rows[0]) throw naoEncontrado('proposta de produto');
      const { rows: conflitos } = await c.query(
        `SELECT k.name FROM partner_collab_product_memberships m JOIN partner_collabs k ON k.id = m.collab_id AND k.organization_id = m.organization_id
          WHERE m.organization_id = $1 AND m.ink_product_id = $2 AND m.status = 'active'`, [ctx.organizationId, rows[0].ink_product_id]
      );
      if (conflitos[0]) throw conflito('AFILIADOS_PRODUTO_EM_OUTRA_COLLAB', `o produto já pertence à collab "${conflitos[0].name}"`);
      const { rows: atualizada } = await c.query(
        `UPDATE partner_collab_product_memberships SET status = 'active', valid_from = $3, approved_by = $4 WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [ctx.organizationId, rows[0].id, inicio, ctx.userId || null]
      );
      await db.auditar(c, ctx, { entidade: 'collab', entidadeId: collab.id, acao: retroativo ? 'collab.product.approve.retroactive' : 'collab.product.approve', depois: { inkProductId: String(rows[0].ink_product_id), validFrom: inicio }, motivo: retroativo ? entrada.reason : null });
      return { membership: mapearMembership(atualizada[0]), retroativo };
    });
  }

  async function rejeitarProduto(ctx, collabId, membershipId, { motivo }) {
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const collab = await obterCollab(c, ctx, collabId, { travar: true });
      const { rows } = await c.query(
        `DELETE FROM partner_collab_product_memberships WHERE organization_id = $1 AND collab_id = $2 AND id = $3 AND status = 'pending_approval' RETURNING *`,
        [ctx.organizationId, collab.id, exigirUuid(membershipId, 'produto da collab')]
      );
      if (!rows[0]) throw naoEncontrado('proposta de produto');
      await db.auditar(c, ctx, { entidade: 'collab', entidadeId: collab.id, acao: 'collab.product.reject', antes: { inkProductId: String(rows[0].ink_product_id) }, motivo: m });
      return { removido: true };
    });
  }

  // Desvincular NÃO apaga: fecha a vigência. Vendas anteriores continuam atribuídas ao produto exato que compunha a collab na data.
  async function removerProduto(ctx, collabId, membershipId, { motivo }) {
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const collab = await obterCollab(c, ctx, collabId, { travar: true });
      const { rows } = await c.query(
        `UPDATE partner_collab_product_memberships SET status = 'removed', valid_to = GREATEST(now(), valid_from), removed_by = $4
          WHERE organization_id = $1 AND collab_id = $2 AND id = $3 AND status = 'active' RETURNING *`,
        [ctx.organizationId, collab.id, exigirUuid(membershipId, 'produto da collab'), ctx.userId || null]
      );
      if (!rows[0]) throw naoEncontrado('produto ativo da collab');
      await db.auditar(c, ctx, { entidade: 'collab', entidadeId: collab.id, acao: 'collab.product.remove', antes: { inkProductId: String(rows[0].ink_product_id), validFrom: rows[0].valid_from }, depois: { validTo: rows[0].valid_to }, motivo: m });
      return mapearMembership(rows[0]);
    });
  }

  // Descoberta por cluster: produtos do MESMO agrupamento (metadata.productClusterId do catálogo canônico) que ainda não estão na collab.
  // Padrão seguro: viram PROPOSTA (pending_approval) com prévia de impacto; auto_include só se a collab assim decidir. Nunca retroativo.
  async function descobrirPorCluster(ctx, collabId) {
    const agora = relogio();
    return db.tx(pool, async (c) => {
      const collab = await obterCollab(c, ctx, collabId, { travar: true });
      const { rows: atuais } = await c.query(
        `SELECT m.ink_product_id, m.ink_cluster_id, cp.metadata->>'productClusterId' AS cluster_catalogo
           FROM partner_collab_product_memberships m
           LEFT JOIN commerce_products cp ON cp.organization_id = m.organization_id AND cp.provider = 'reserva_ink' AND cp.provider_product_id = m.ink_product_id::text
          WHERE m.organization_id = $1 AND m.collab_id = $2 AND m.status IN ('active', 'pending_approval')`, [ctx.organizationId, collab.id]
      );
      const clusters = [...new Set(atuais.map((a) => a.ink_cluster_id === null ? a.cluster_catalogo : String(a.ink_cluster_id)).filter(Boolean))];
      if (clusters.length === 0) return { collab: mapearCollab(collab), clusters: [], encontrados: [] };
      const { rows: candidatos } = await c.query(
        `SELECT cp.provider_product_id, cp.name, cp.image_url, cp.metadata->>'productClusterId' AS cluster
           FROM commerce_products cp
          WHERE cp.organization_id = $1 AND cp.provider = 'reserva_ink' AND cp.is_active AND cp.metadata->>'productClusterId' = ANY($2::text[])
            AND cp.provider_product_id ~ '^[0-9]{1,18}$'
            AND NOT EXISTS (SELECT 1 FROM partner_collab_product_memberships m WHERE m.organization_id = cp.organization_id AND m.ink_product_id = cp.provider_product_id::bigint
                              AND (m.status IN ('active', 'pending_approval') OR (m.status = 'removed' AND m.collab_id = $3)))`,
        [ctx.organizationId, clusters, collab.id]
      );
      const encontrados = [];
      for (const cand of candidatos) {
        const automatico = collab.new_member_policy === 'auto_include';
        const { rows: outraCollab } = await c.query(
          `SELECT 1 FROM partner_collab_product_memberships WHERE organization_id = $1 AND ink_product_id = $2 AND status = 'active'`, [ctx.organizationId, cand.provider_product_id]
        );
        if (outraCollab[0]) continue;
        const { rows: impacto } = await c.query(
          `SELECT COALESCE(sum(i.quantidade), 0)::int AS unidades, COALESCE(sum(round((i.valor_venda - i.desconto_rateado) * 100)), 0)::bigint AS receita_cents
             FROM pedidos_ink_itens i JOIN pedidos_ink p ON p.organization_id = i.organization_id AND p.store_id = i.store_id AND p.ink_order_id = i.ink_order_id
            WHERE i.organization_id = $1 AND i.produto_id = $2 AND p.criado_em >= $3 AND p.payment_status IN ('paid', 'succeeded', 'free') AND p.is_troca IS NOT TRUE`,
          [ctx.organizationId, cand.provider_product_id, new Date(agora.getTime() - 90 * 86400000)]
        );
        const { rows: nova } = await c.query(
          `INSERT INTO partner_collab_product_memberships (organization_id, store_id, collab_id, ink_product_id, ink_cluster_id, product_name, status, source, valid_from, created_by, approved_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'cluster_discovery',$8,$9,$10) RETURNING *`,
          [ctx.organizationId, ctx.storeId, collab.id, cand.provider_product_id, cand.cluster, cand.name, automatico ? 'active' : 'pending_approval', automatico ? agora : null, ctx.userId || null, automatico ? ctx.userId || null : null]
        );
        await db.auditar(c, ctx, { entidade: 'collab', entidadeId: collab.id, acao: automatico ? 'collab.product.auto_include' : 'collab.product.discovered', depois: { inkProductId: cand.provider_product_id, cluster: cand.cluster } });
        encontrados.push({
          ...mapearMembership(nova[0]), imageUrl: cand.image_url,
          impactoUltimos90d: { unidades: impacto[0].unidades, receitaLiquidaCents: Number(impacto[0].receita_cents), observacao: 'Não retroativo: só vendas após a aprovação comissionam.' },
        });
      }
      return { collab: mapearCollab(collab), clusters, encontrados };
    });
  }

  // ── Leitura ─────────────────────────────────────────────────────────────────────────────────────
  async function listarCollabs(ctx) {
    const { rows } = await pool.query(
      `SELECT k.*,
         (SELECT count(*) FROM partner_collab_product_memberships m WHERE m.organization_id = k.organization_id AND m.collab_id = k.id AND m.status = 'active')::int AS produtos_ativos,
         (SELECT count(*) FROM partner_collab_product_memberships m WHERE m.organization_id = k.organization_id AND m.collab_id = k.id AND m.status = 'pending_approval')::int AS produtos_pendentes,
         (SELECT COALESCE(json_agg(json_build_object('partnerId', p.id, 'name', p.public_name, 'shareBps', cc.share_bps)), '[]'::json)
            FROM partner_collab_creators cc JOIN partnership_partners p ON p.id = cc.partner_id AND p.organization_id = cc.organization_id
           WHERE cc.organization_id = k.organization_id AND cc.collab_id = k.id AND cc.valid_to IS NULL) AS criadores,
         (SELECT COALESCE(sum((a.current_state->>'eligibleQty')::int), 0) FROM partnership_attributions a
           WHERE a.organization_id = k.organization_id AND a.collab_id = k.id AND a.status = 'calculated' AND a.current_state->>'orderState' IN ('paid', 'delivered'))::int AS unidades
       FROM partner_collabs k WHERE k.organization_id = $1 ORDER BY k.created_at DESC LIMIT 200`, [ctx.organizationId]
    );
    return rows.map((r) => ({ ...mapearCollab(r), activeProducts: r.produtos_ativos, pendingProducts: r.produtos_pendentes, creators: r.criadores, units: r.unidades }));
  }

  async function detalharCollab(ctx, id) {
    const c = await pool.connect();
    try {
      const collab = await obterCollab(c, ctx, id);
      // Cada leitura usa a fachada do pool (uma conexão por query): `c` é um cliente único e o pg não aceita queries concorrentes nele.
      const [{ rows: produtos }, { rows: criadores }, { rows: resumo }, { rows: porProduto }] = await Promise.all([
        pool.query(
          `SELECT m.*, cp.name AS catalogo_nome, cp.image_url AS catalogo_imagem
             FROM partner_collab_product_memberships m
             LEFT JOIN commerce_products cp ON cp.organization_id = m.organization_id AND cp.provider = 'reserva_ink' AND cp.provider_product_id = m.ink_product_id::text
            WHERE m.organization_id = $1 AND m.collab_id = $2 ORDER BY (m.status = 'pending_approval') DESC, m.valid_from NULLS LAST, m.created_at`, [ctx.organizationId, collab.id]
        ),
        pool.query(
          `SELECT cc.*, p.public_name FROM partner_collab_creators cc JOIN partnership_partners p ON p.id = cc.partner_id AND p.organization_id = cc.organization_id
            WHERE cc.organization_id = $1 AND cc.collab_id = $2 ORDER BY cc.valid_from`, [ctx.organizationId, collab.id]
        ),
        pool.query(
          `SELECT count(DISTINCT a.ink_order_id)::int AS pedidos, COALESCE(sum((a.current_state->>'eligibleQty')::int), 0)::int AS unidades,
                  COALESCE(sum((a.current_state->>'baseEligibleCents')::bigint), 0)::bigint AS receita_cents,
                  COALESCE((SELECT sum(l.amount_cents) FROM partner_commission_ledger l WHERE l.organization_id = $1 AND l.status <> 'reversed' AND l.attribution_id IN
                    (SELECT id FROM partnership_attributions WHERE organization_id = $1 AND collab_id = $2)), 0)::bigint AS comissao_cents
             FROM partnership_attributions a WHERE a.organization_id = $1 AND a.collab_id = $2 AND a.status = 'calculated' AND a.current_state->>'orderState' IN ('paid', 'delivered')`, [ctx.organizationId, collab.id]
        ),
        pool.query(
          `SELECT (a.evidence->>'productId') AS produto, COALESCE(sum((a.current_state->>'eligibleQty')::int), 0)::int AS unidades
             FROM partnership_attributions a WHERE a.organization_id = $1 AND a.collab_id = $2 AND a.status = 'calculated' AND a.current_state->>'orderState' IN ('paid', 'delivered')
            GROUP BY 1 ORDER BY 2 DESC`, [ctx.organizationId, collab.id]
        ),
      ]);
      return {
        collab: mapearCollab(collab),
        products: produtos.map((p) => ({ ...mapearMembership(p), catalogName: p.catalogo_nome, imageUrl: p.catalogo_imagem })),
        creators: criadores.map((cc) => ({ id: cc.id, partnerId: cc.partner_id, partnerName: cc.public_name, contractId: cc.contract_id, shareBps: cc.share_bps, validFrom: cc.valid_from, validTo: cc.valid_to })),
        summary: { orders: resumo[0].pedidos, units: resumo[0].unidades, netRevenueCents: Number(resumo[0].receita_cents), commissionCents: Number(resumo[0].comissao_cents) },
        unitsByProduct: porProduto.map((p) => ({ inkProductId: p.produto, units: p.unidades })),
      };
    } finally { c.release(); }
  }

  // Busca de produtos no catálogo canônico (nunca chama a INK): para escolher o que entra na collab.
  async function buscarProdutosDoCatalogo(ctx, { q = '', limite = 20 } = {}) {
    const termo = String(q || '').trim().slice(0, 80);
    const lim = Math.min(Math.max(Number(limite) || 20, 1), 50);
    const { rows } = await pool.query(
      `SELECT cp.provider_product_id, cp.name, cp.image_url, cp.metadata->>'productClusterId' AS cluster,
              (SELECT collab_id FROM partner_collab_product_memberships m WHERE m.organization_id = cp.organization_id AND m.status = 'active' AND m.ink_product_id::text = cp.provider_product_id LIMIT 1) AS collab_id
         FROM commerce_products cp
        WHERE cp.organization_id = $1 AND cp.provider = 'reserva_ink' AND cp.is_active AND cp.provider_product_id ~ '^[0-9]{1,18}$'
          AND ($2 = '' OR cp.name ILIKE '%' || replace(replace($2, '%', ''), '_', '') || '%' OR cp.provider_product_id = $2)
        ORDER BY cp.name LIMIT $3`, [ctx.organizationId, termo, lim]
    );
    return rows.map((r) => ({ inkProductId: r.provider_product_id, name: r.name, imageUrl: r.image_url, clusterId: r.cluster, collabId: r.collab_id }));
  }

  return {
    criarCollab, atualizarCollab, adicionarCriador, encerrarCriador, adicionarProdutos, aprovarProduto, rejeitarProduto, removerProduto, descobrirPorCluster,
    listarCollabs, detalharCollab, buscarProdutosDoCatalogo, mapearCollab, mapearMembership,
  };
}

module.exports = { criarCollabs };
