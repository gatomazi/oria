'use strict';

// Composição do módulo de afiliados. Um objeto por processo: as dependências entram aqui e nada é global.
//   pool     fachada de tenant (criarPoolTenant): a Organization vem do contexto da request/job.
//   inkClient  cliente do connector da INK: `get` (leitura) e, quando o connector suporta criar cupom, `post`/`patch`/`delete`. A escrita é
//              funcionalidade do painel (sem flag): a capacidade vem de quais métodos o connector expõe; sem `post`, o fluxo é MANUAL (cria-se
//              o cupom na loja e o Oria só vincula/verifica). Outro connector futuro segue a mesma interface (ver arquitetura.md §7).
//   inkScopes  (opcional) escopos declarados do connector; se informados sem `store.promotions.write`, nenhuma escrita sai.

const { createInkPromotionsAdapter } = require('./ink-promotions');
const { criarRegistry } = require('./registry');
const { criarCollabs } = require('./collabs');
const { criarReconciliador } = require('./reconcile');
const { criarPayables } = require('./payables');
const { criarProgressao } = require('./progression');
const { criarDiretorio } = require('./directory');
const { criarPreview } = require('./preview');

function criarAfiliados({ pool, relogio = () => new Date(), inkClient = null, inkScopes = null }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new Error('criarAfiliados exige um pool');
  const inkPromotions = createInkPromotionsAdapter({ client: inkClient, scopes: inkScopes, relogio });
  const registry = criarRegistry({ pool, relogio, inkPromotions });
  const collabs = criarCollabs({ pool, relogio, registry });
  const reconciliador = criarReconciliador({ pool, relogio, registry });
  const payables = criarPayables({ pool, relogio, registry });
  const progressao = criarProgressao({ pool, relogio, registry });
  const diretorio = criarDiretorio({ pool, relogio, registry, payables, progressao });
  const preview = criarPreview({ pool, relogio, registry, payables, progressao });

  // Reconcilia pedidos e, em seguida, recalcula propostas de nível (só propõe; a decisão é do lojista).
  async function reconciliarTudo(ctx, opcoes = {}) {
    const r = await reconciliador.reconciliar(ctx, opcoes);
    const p = await progressao.gerarPropostas(ctx);
    return { ...r, ...p };
  }

  return { registry, collabs, reconciliador, payables, progressao, diretorio, preview, reconciliarTudo, inkPromotions };
}

module.exports = { criarAfiliados };
