'use strict';

// Persistência das propostas de Product Enrichment (Fase F.1) — tabela creative_enrichment_proposals
// (migration 0036). A proposta em si vem do core (POST /v1/enrichment/propose, sempre "fake" nesta fase —
// ver apps/creative-generator/creative_core/enrichment.py); este módulo só guarda/lista/decide. A escrita
// que de fato MUDA um produto (aprovar/ajustar) precisa tocar duas tabelas numa transação — fica em
// pgStore.js (mesmo motivo de createJob ali: precisa do client bruto, não só do `q` de uma query).

const MERGEABLE_FIELDS = Object.freeze([
  'wearer_roles', 'relationship_themes', 'recommended_supporting_roles',
  'incompatible_auto_supporting_roles', 'scene_intents', 'visible_text',
]);

function iso(v) {
  return v instanceof Date ? v.toISOString() : v || null;
}

function mapProposal(r) {
  return r && {
    id: r.id, organizationId: r.organization_id, productId: r.product_id, storeId: r.store_id,
    status: r.status, schemaVersion: r.schema_version, provider: r.provider,
    proposed: r.proposed, recommendedAngleFamilies: r.recommended_angle_families,
    recommendedInteractions: r.recommended_interactions, fieldNotes: r.field_notes,
    productSnapshotHash: r.product_snapshot_hash,
    // Fase F.2.A — custo/observabilidade (0037). Sempre null para provider "fake"; nunca a resposta
    // bruta do provider, nunca bytes de imagem, nunca credencial — ver contracts.py::EnrichmentProposal.
    providerMeta: r.provider_meta === undefined ? null : r.provider_meta,
    acceptedFields: r.accepted_fields, beforeSemanticContext: r.before_semantic_context,
    appliedSemanticContext: r.applied_semantic_context,
    createdBy: r.created_by, reviewedBy: r.reviewed_by,
    createdAt: iso(r.created_at), reviewedAt: iso(r.reviewed_at), updatedAt: iso(r.updated_at),
  };
}

// Espelha creative_core/enrichment.py::merge — mesma regra, mesmo resultado, por design (§4: "merge
// explícito e auditável"; a decisão de QUAIS campos entram é sempre do humano, nunca da proposta
// sozinha). Mantidas as duas porque o core precisa da sua própria (pura, testável ali) e o painel é quem
// de fato grava no produto — ver docs/features/creative-generator-fase-f1.md para o porquê de não termos
// feito o painel chamar o core outra vez só para isto.
//
// Fase F.2.A também preenche `field_sources`/`field_confidence` — proveniência por campo, aditiva e
// compatível com objetos que só tinham `source`/`confidence`. A auditoria desta fase confirmou que o
// flip do `source` agregado abaixo reatribuía SILENCIOSAMENTE todo o objeto (inclusive campos que o
// lojista nunca tocou, ex.: `wearer_roles` confirmado manualmente ao lado de um `scene_intents` recém
// aceito) para "enrichment". `field_sources` registra "enrichment" exatamente para os campos que ESTA
// decisão aceita; para os demais campos mesclaveis sem registro por-campo prévio, preenche com o
// `source` agregado do objeto como ele estava um instante antes deste merge — não é um chute
// retroativo sobre uma linha histórica adormecida, é a única evidência viva que esta chamada está
// prestes a sobrescrever, capturada antes de se perder. Um campo nunca registrado antes (produto novo,
// sem `source` prévio nenhum) não ganha entrada — nada é inventado — e cai no mesmo fallback na leitura
// (ver composition.py::field_origin, espelhado nos consumidores Node quando existirem).
function mergeSemanticContext(current, proposed, acceptedFields) {
  const desconhecidos = (acceptedFields || []).filter((f) => !MERGEABLE_FIELDS.includes(f));
  if (desconhecidos.length) throw new Error(`accepted_fields: campo desconhecido: ${desconhecidos.join(', ')}`);
  if (!acceptedFields || !acceptedFields.length) return current ? { ...current } : null;
  const mesclado = { ...(current || {}) };
  const previousSource = mesclado.source;
  const fieldSources = { ...(mesclado.field_sources || {}) };
  const fieldConfidence = { ...(mesclado.field_confidence || {}) };
  for (const campo of MERGEABLE_FIELDS) {
    if (acceptedFields.includes(campo)) {
      fieldSources[campo] = 'enrichment';
      fieldConfidence[campo] = proposed.confidence;
    } else if (!(campo in fieldSources) && previousSource) {
      fieldSources[campo] = previousSource;
    }
  }
  for (const campo of acceptedFields) mesclado[campo] = proposed[campo] || [];
  mesclado.field_sources = fieldSources;
  mesclado.field_confidence = fieldConfidence;
  mesclado.source = 'enrichment';
  mesclado.confidence = proposed.confidence;
  return mesclado;
}

function enrichmentMethods(q) {
  return {
    async listProposals(tenantId, productId) {
      const { rows } = await q(
        'SELECT * FROM creative_enrichment_proposals WHERE organization_id = $1::uuid AND product_id = $2 ORDER BY created_at DESC',
        [tenantId, productId],
      );
      return rows.map(mapProposal);
    },
    async getPendingProposal(tenantId, productId) {
      const { rows } = await q(
        `SELECT * FROM creative_enrichment_proposals WHERE organization_id = $1::uuid AND product_id = $2 AND status = 'pending'`,
        [tenantId, productId],
      );
      return mapProposal(rows[0]) || null;
    },
    async getProposal(tenantId, id) {
      const { rows } = await q('SELECT * FROM creative_enrichment_proposals WHERE organization_id = $1::uuid AND id = $2', [tenantId, id]);
      return mapProposal(rows[0]) || null;
    },
    async createProposal(tenantId, { productId, provider, proposed, recommendedAngleFamilies, recommendedInteractions,
      fieldNotes, productSnapshotHash, productUpdatedAt, createdBy, providerMeta }) {
      const { rows } = await q(
        `INSERT INTO creative_enrichment_proposals
           (organization_id, product_id, provider, proposed, recommended_angle_families, recommended_interactions,
            field_notes, product_snapshot_hash, product_updated_at, created_by, provider_meta)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb) RETURNING *`,
        [tenantId, productId, provider, JSON.stringify(proposed), JSON.stringify(recommendedAngleFamilies || []),
          JSON.stringify(recommendedInteractions || []), JSON.stringify(fieldNotes || {}), productSnapshotHash,
          productUpdatedAt, createdBy || null, providerMeta ? JSON.stringify(providerMeta) : null],
      );
      return mapProposal(rows[0]);
    },
  };
}

module.exports = { enrichmentMethods, mapProposal, mergeSemanticContext, MERGEABLE_FIELDS };
