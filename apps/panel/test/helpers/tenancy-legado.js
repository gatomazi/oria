'use strict';

// Base "como a de produção hoje": schema até a migration 6 (sem organization_id), dados nas três
// lojas legadas, linhas com loja NULL e o estado que hoje é por instalação. Cobre as 55 tabelas do
// manifesto, para que o backfill seja exercitado em cada uma.

const { inserir } = require('./linhas');
const manifesto = require('../../lib/platform/tenancy-manifest');

const LOJAS = ['sul', 'centro', 'norte'];
// Migrations anteriores à Fase 1 (até creative-core-schema).
const MIGRATIONS_PRE_TENANCY = 6;

async function semearBaseLegada(client, { lojas = LOJAS, creativeTenant = 'default' } = {}) {
  const porLoja = manifesto.TABELAS_TENANT.filter((x) => x.regra === 'loja' || x.regra === 'loja_ou_sem_loja');

  for (const loja of lojas) {
    for (const x of porLoja) await inserir(client, x.tabela, { loja });
    const campanha = await inserir(client, 'campaigns', { loja });
    await inserir(client, 'campaign_recipients', { campaign_id: campanha.id });
    const job = await inserir(client, 'bulk_category_jobs', { loja });
    await inserir(client, 'bulk_category_job_items', { job_id: job.id });
    const sim = await inserir(client, 'origens_migration_simulations', { loja });
    await inserir(client, 'origens_migration_simulation_items', { simulation_id: sim.id });
    const integ = await inserir(client, 'integrations', { escopo: loja, provider: `meta-${loja}` });
    await inserir(client, 'integration_secrets', { integration_id: integ.id });
  }

  // Loja NULL: o dono NÃO pode ser deduzido — só declarado por sem_loja.
  for (const x of manifesto.TABELAS_TENANT.filter((y) => y.regra === 'loja_ou_sem_loja')) {
    await inserir(client, x.tabela, { loja: null });
  }

  // Estado por instalação, conexões e Creative Core.
  for (const x of manifesto.TABELAS_TENANT) {
    if (['instalacao', 'meta', 'google_ads'].includes(x.regra)) {
      await inserir(client, x.tabela, x.singleton ? { id: 1 } : {});
    } else if (x.regra === 'creative') {
      await inserir(client, x.tabela, { tenant_id: creativeTenant });
    }
  }
}

module.exports = { LOJAS, MIGRATIONS_PRE_TENANCY, semearBaseLegada };
