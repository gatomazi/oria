'use strict';

// Massa SINTÉTICA e determinística para provar que otimizações de desempenho da RFM NÃO mudam nenhum resultado:
// a saída de `analisarRfm` (e do sort canônico) sobre estas linhas é fixada por hash (test/clientes-rfm-equivalencia.test.js).
const ASOF = new Date('2026-09-24T15:00:00.000Z');

// n pedidos, ~n/1,6 compradores; 3% cancelados, 1% troca; instantes espalhados em 3.000 dias (cruza o horário de verão de SP
// 2018/19 e viradas de dia locais) e amarrados a minutos "quebrados" (23:59, 00:00, 00:01 locais) para exercitar as fronteiras.
function gerar(n) {
  const clientes = Math.max(20, Math.round(n / 1.6));
  const MIN_QUEBRADOS = [0, 1, 719, 720, 721, 1440, 180, 179, 181]; // ASOF é 12:00 local: 719/720/721 min antes = 00:01/00:00/23:59 locais
  const linhas = [];
  for (let g = 1; g <= n; g += 1) {
    const c = g % clientes;
    const dias = (g * 7) % 3000;
    const min = MIN_QUEBRADOS[g % MIN_QUEBRADOS.length];
    const t = ASOF.getTime() - dias * 86_400_000 - min * 60_000 - (g % 5) * 1000;
    linhas.push({
      loja: g % 11 === 0 ? 'centro' : 'sul', ink_order_id: 5_000_000 + (g % 997 === 0 ? g - 1 : g), // alguns ids repetidos (duplicidade)
      payment_status: g % 33 === 0 ? 'canceled' : 'paid', order_status: 'delivered', buyer_nome: `Sintético ${c}`,
      buyer_telefone: g % 3 ? `5199${String(c + 1_000_000).padStart(7, '0')}` : null, buyer_documento: g % 5 ? `DOC-${c}` : null,
      buyer_email: g % 7 === 0 ? `s${c}@sintetico.invalid` : null, buyer_aceita_marketing: (c % 10) < 7, buyer_uf: 'RS',
      total_value: 40 + ((g * 13) % 260) + ((g % 4) * 0.25), criado_em: new Date(t).toISOString(), is_troca: g % 97 === 0, frete: 10, descontos: 0, items_count: 1,
    });
  }
  return linhas;
}

module.exports = { ASOF, gerar };
