'use strict';

// Fase 4 · fonte ÚNICA do gasto de mídia de uma Organization (F-01 / PD-021 / INV-11).
//
// Antes havia duas implementações da mesma regra: o dashboard financeiro (G-01, fail-closed) e o
// consolidado (F-01, que somava a conta selecionada sem conferir a quem ela atende e nunca olhava a
// atribuição do Google Ads). As duas telas agora chamam só isto.
//
// Regra, por provider:
//   - só recurso selecionado DESTA Organization (organization_id explícito, além da RLS);
//   - mais de um selecionado é erro de integridade — nunca "o primeiro";
//   - recurso sem loja atribuída, ou atribuído a outra loja, fica FORA do total e é sinalizado;
//   - nada é atribuído por dedução (nenhum "se só há uma loja, é ela");
//   - a loja vem da Store da Organization do contexto, nunca do request.
//
// Provider fora do total volta com `conectado: false` e `motivo` — `totalizarMidia` o lista em
// `faltando`, e a tela diz que o resultado está parcial em vez de mostrar lucro alto demais.

const PROVIDERS = Object.freeze({
  meta: Object.freeze({
    contas: `SELECT meta_account_id AS id, loja_atribuida FROM meta_ad_accounts
              WHERE organization_id = $1 AND selecionada`,
    gasto: `SELECT to_char(data, 'YYYY-MM-DD') AS dia, SUM(spend) AS spend FROM meta_insights_daily
             WHERE organization_id = $1 AND meta_account_id = $2 AND level = 'account'
               AND data BETWEEN $3 AND $4
             GROUP BY data ORDER BY data`,
  }),
  // Nível 'customer' é o total da conta; a régua 'conversions' evita contar o mesmo gasto por
  // régua de conversão.
  google_ads: Object.freeze({
    contas: `SELECT customer_id AS id, loja_atribuida FROM google_ads_customers
              WHERE organization_id = $1 AND selecionada`,
    gasto: `SELECT to_char(data, 'YYYY-MM-DD') AS dia, SUM(custo) AS spend FROM google_ads_insights_daily
             WHERE organization_id = $1 AND customer_id = $2 AND level = 'customer'
               AND contagem_conversao = 'conversions' AND data BETWEEN $3 AND $4
             GROUP BY data ORDER BY data`,
  }),
});

class MidiaIntegridadeError extends Error {
  constructor(provider) {
    super(`integridade: mais de um recurso de ${provider} selecionado na organization`);
    this.name = 'MidiaIntegridadeError';
  }
}

// `relevante(provider)` decide se provider não conectado vira aviso (a operação usa o canal?).
async function resolverMidiaDaOrganizacao(pool, { organizationId, loja, from, to, relevante = () => true }) {
  if (!organizationId) throw new Error('mídia sem organization');
  if (!loja) throw new Error('mídia sem loja da Store');
  const fontes = [];
  const porDia = [];
  const sinalizados = [];
  for (const [provider, sql] of Object.entries(PROVIDERS)) {
    const { rows: contas } = await pool.query(sql.contas, [organizationId]);
    if (contas.length > 1) throw new MidiaIntegridadeError(provider);
    const conta = contas[0];
    if (!conta) {
      fontes.push({ provider, spend: null, conectado: false, relevante: await relevante(provider) });
      continue;
    }
    const motivo = !conta.loja_atribuida ? 'sem_loja' : conta.loja_atribuida !== loja ? 'outra_loja' : null;
    if (motivo) {
      sinalizados.push({ provider, recurso: conta.id, motivo });
      fontes.push({ provider, spend: null, conectado: false, relevante: true, motivo });
      continue;
    }
    const { rows } = await pool.query(sql.gasto, [organizationId, conta.id, from, to]);
    let total = 0;
    for (const r of rows) {
      const spend = Number(r.spend);
      total += spend;
      porDia.push({ provider, loja, dia: r.dia, spend });
    }
    fontes.push({ provider, spend: total, conectado: true, recurso: conta.id });
  }
  return { fontes, porDia, sinalizados };
}

module.exports = { resolverMidiaDaOrganizacao, MidiaIntegridadeError, PROVIDERS };
