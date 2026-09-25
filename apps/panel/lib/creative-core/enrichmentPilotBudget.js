'use strict';

// Fase F.2.B — reserva atômica de concorrência e orçamento do piloto controlado de Product
// Enrichment real (OpenAI). Ponte fina para as duas funções SECURITY DEFINER da migration 0038
// (creative_enrichment_pilot_reservar/_finalizar) — toda a lógica atômica de verdade mora no
// Postgres (uma única instrução, `pg_advisory_xact_lock` de escopo de transação, nunca segurando
// lock enquanto espera a rede da OpenAI); este módulo só valida entrada e traduz o resultado.
//
// Temporário, de propósito: existe para ESTA rodada controlada, não é o desenho final de um limite
// de gastos permanente — ver docs/features/creative-generator-fase-f2b.md para o que falta para
// produção com múltiplas réplicas/DBs.

const CENTAVOS_POR_DOLAR = 100;

// Arredonda para CIMA, nunca para o mais próximo — um custo de sub-centavo (ex.: gpt-4o-mini de
// verdade fica na casa de US$ 0,0006/chamada, menos de 1 centavo) nunca pode virar 0 centavo
// reservado: isso apagaria a granularidade do teto de VALOR (mesmo com o teto de CHAMADAS ainda
// protegendo o total). Achado durante a execução real do piloto — corrigido antes de reservar de
// verdade, coberto por teste.
function centavosDeUsd(usd) {
  const valor = Number(usd);
  if (!Number.isFinite(valor) || valor < 0) throw new Error('valor em USD inválido');
  if (valor === 0) return 0;
  return Math.max(1, Math.ceil(valor * CENTAVOS_POR_DOLAR));
}

// `q` é a função de query já usada pelo resto do painel (aceita SQL parametrizado); funciona tanto
// com um Pool quanto com um client de transação — as duas funções SQL fazem sua própria transação
// implícita (uma instrução cada), não precisam de um client dedicado.
async function reservar(q, { organizationId, productId, custoEstimadoUsd, limiteChamadas = 3, limiteUsd = 0.05, ttlSegundos = 120 }) {
  const custoCentavos = centavosDeUsd(custoEstimadoUsd);
  const limiteCentavos = centavosDeUsd(limiteUsd);
  const { rows: [linha] } = await q(
    'SELECT * FROM creative_enrichment_pilot_reservar($1::uuid, $2::uuid, $3::int, $4::int, $5::int, $6::int)',
    [organizationId, productId, custoCentavos, limiteChamadas, limiteCentavos, ttlSegundos],
  );
  return { ok: linha.ok, motivo: linha.motivo || null, attemptId: linha.attempt_id || null };
}

async function finalizar(q, attemptId, { status, model = null, custoRealUsd = null, errorCode = null }) {
  if (!['succeeded', 'failed'].includes(status)) throw new Error(`status inválido: ${status}`);
  const custoRealCentavos = custoRealUsd === null || custoRealUsd === undefined ? null : centavosDeUsd(custoRealUsd);
  const { rows: [linha] } = await q(
    'SELECT creative_enrichment_pilot_finalizar($1::uuid, $2, $3, $4::int, $5) AS ok',
    [attemptId, status, model, custoRealCentavos, errorCode],
  );
  return Boolean(linha && linha.ok);
}

module.exports = { reservar, finalizar, centavosDeUsd };
