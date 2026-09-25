'use strict';

// Rodada K (Journey Analytics) · leitura de performance por CAMPANHA a partir de `meta_insights_daily`
// — os MESMOS dados que a sincronização de Meta Ads Insights já grava (server.js,
// docs/meta-ads-analytics-integracao-v2.md), agora numa função importável e testável fora de
// server.js, para o Journey Analytics Engine reaproveitar sem duplicar SQL nem reimplementar a
// normalização de `actions` (lib/meta/actions.js `totalizarSomas` decide, sozinha, qual variante de
// `purchase` conta — nunca duplicado aqui).
//
// Tenancy: `meta_connections`/`meta_ad_accounts`/`meta_campaigns`/`meta_insights_daily` são todas
// `organization_id NOT NULL` + RLS FORCED (migrations/sql/0007-tenancy-constraints.up.sql,
// 0009-tenancy-rls.up.sql — migradas de instalação única para 1-por-Organization depois do desenho
// original em 0001-baseline-schema.sql, cujos comentários antigos ainda descrevem o estado anterior).
// `pool` aqui é sempre a fachada RLS (nunca o pool real, mesmo padrão do resto de
// lib/product-analytics/*): nenhum WHERE organization_id explícito, a policy do banco já restringe.
//
// Por que isto NÃO é um `ads/meta` Connector registrado no registry (lib/connectors/registry.js):
// o fluxo de credencial do registry (resolveIntegration → tabela `integrations`, Fase B.1) não é o
// que a conexão Meta usa hoje — ela vive em `meta_connections`, própria, fora da tabela `integrations`
// genérica. Formalizar isso como um descriptor exigiria uma ponte entre os dois modelos de
// integração, fora do escopo de "menor extensão genérica" desta rodada (ver
// docs/features/journey-saas-multi-tenant-audit.md §15 — passo futuro, não decidido aqui). Quem
// consome hoje é só journey-analytics-service.js, direto.

const { totalizarSomas } = require('./insights');

// Mesmas 14 colunas somáveis do overview em server.js (META_COLUNAS_SOMA, sem os campos de vídeo —
// Journey Analytics não usa métricas de vídeo) — lista igual de propósito: uma diferente faria a
// tabela de campanhas divergir do overview para o mesmo período.
const COLUNAS_SOMA = Object.freeze([
  'impressions', 'reach', 'clicks', 'unique_clicks', 'inline_link_clicks', 'outbound_clicks',
  'unique_outbound_clicks', 'spend', 'landing_page_views', 'view_content', 'add_to_cart',
  'initiate_checkout', 'purchases', 'purchase_value',
]);
const SELECT_SOMA = COLUNAS_SOMA.map((c) => `SUM(${c}) AS ${c}`).join(', ');

function linhaParaAdsPerformanceRow(row) {
  const somado = totalizarSomas({
    impressions: row.impressions, reach: row.reach, clicks: row.clicks,
    uniqueClicks: row.unique_clicks, inlineLinkClicks: row.inline_link_clicks,
    outboundClicks: row.outbound_clicks, uniqueOutboundClicks: row.unique_outbound_clicks,
    spend: row.spend, landingPageViews: row.landing_page_views, viewContent: row.view_content,
    addToCart: row.add_to_cart, initiateCheckout: row.initiate_checkout,
    purchases: row.purchases, purchaseValue: row.purchase_value,
  });
  // AdsPerformanceRow (lib/connectors/types.js) — mesmo shape que um `ads/meta` Connector real
  // devolveria de `getCampaignPerformance`, para o Journey Analytics Engine nunca precisar saber se
  // veio do registry ou daqui.
  return Object.freeze({
    externalId: row.meta_campaign_id,
    name: row.nome || row.meta_campaign_id,
    spend: somado.spend,
    impressions: somado.impressions,
    clicks: somado.clicks,
    purchases: somado.purchases,
    revenue: somado.purchaseValue,
  });
}

/**
 * @param {{pool, startDate, endDate}} entrada
 * @returns {Promise<{connected: boolean, campaigns: import('../connectors/types').AdsPerformanceRow[]}>}
 *   `connected: false` quando esta Organization não tem conta de anúncios Meta selecionada — nunca
 *   confundido com "zero campanhas com investimento no período" (mesma disciplina do gate de
 *   conectividade do Ink em lib/connectors/commerce/reserva-ink/connector.js
 *   `exigirIntegracaoConectada`).
 */
async function getCampaignPerformance({ pool, startDate, endDate }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('getCampaignPerformance exige pool');
  if (!startDate || !endDate) throw new TypeError('getCampaignPerformance exige startDate e endDate');
  if (String(startDate) > String(endDate)) throw new TypeError('startDate deve ser <= endDate');

  const { rows: contas } = await pool.query('SELECT meta_account_id FROM meta_ad_accounts WHERE selecionada');
  if (!contas.length) return Object.freeze({ connected: false, campaigns: [] });

  const { rows } = await pool.query(
    `SELECT i.meta_campaign_id, MAX(c.nome) AS nome, ${SELECT_SOMA}
       FROM meta_insights_daily i
       LEFT JOIN meta_campaigns c ON c.meta_campaign_id = i.meta_campaign_id
      WHERE i.level = 'campaign' AND i.meta_account_id = $1 AND i.data BETWEEN $2 AND $3
      GROUP BY i.meta_campaign_id`,
    [contas[0].meta_account_id, startDate, endDate]
  );
  return Object.freeze({ connected: true, campaigns: Object.freeze(rows.map(linhaParaAdsPerformanceRow)) });
}

module.exports = { getCampaignPerformance, COLUNAS_SOMA };
