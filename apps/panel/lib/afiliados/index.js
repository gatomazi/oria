'use strict';

// Composição do módulo de afiliados. Um objeto por processo: as dependências entram aqui e nada é global.
//   pool     fachada de tenant (criarPoolTenant): a Organization vem do contexto da request/job.
//   inkClient  { get(path) } de LEITURA da INK (verificação de cupom). Escrita NÃO é injetada nesta versão.
//   flags    { inkPromotionWritesEnabled: false } — escrita remota de promoções fica desligada.

const { createInkPromotionsAdapter } = require('./ink-promotions');
const { criarRegistry } = require('./registry');
const { criarCollabs } = require('./collabs');
const { criarReconciliador } = require('./reconcile');
const { criarPayables } = require('./payables');
const { criarProgressao } = require('./progression');
const { criarDiretorio } = require('./directory');

function criarAfiliados({ pool, relogio = () => new Date(), inkClient = null, flags = {} }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new Error('criarAfiliados exige um pool');
  const inkPromotions = createInkPromotionsAdapter({ client: inkClient, flags: { inkPromotionWritesEnabled: flags.inkPromotionWritesEnabled === true } });
  const registry = criarRegistry({ pool, relogio, inkPromotions });
  const collabs = criarCollabs({ pool, relogio, registry });
  const reconciliador = criarReconciliador({ pool, relogio, registry });
  const payables = criarPayables({ pool, relogio, registry });
  const progressao = criarProgressao({ pool, relogio, registry });
  const diretorio = criarDiretorio({ pool, relogio, registry, payables, progressao });

  // Reconcilia pedidos e, em seguida, recalcula propostas de nível (só propõe; a decisão é do lojista).
  async function reconciliarTudo(ctx, opcoes = {}) {
    const r = await reconciliador.reconciliar(ctx, opcoes);
    const p = await progressao.gerarPropostas(ctx);
    return { ...r, ...p };
  }

  return { registry, collabs, reconciliador, payables, progressao, diretorio, reconciliarTudo, inkPromotions, flags: { inkPromotionWritesEnabled: flags.inkPromotionWritesEnabled === true } };
}

module.exports = { criarAfiliados };
