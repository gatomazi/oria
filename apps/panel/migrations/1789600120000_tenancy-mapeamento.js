'use strict';

// Fase 1 · declaração explícita de dono do dado legado (PD-019).
//
// Entrada: `TENANCY_MAPPING_FILE` — caminho para o JSON descrito em lib/platform/tenancy-mapping.js.
// Obrigatório sempre que a base já tiver dado. Sem ele, `tenancy_exigir_cobertura()` lista tudo que
// ficaria sem dono e a migration aborta (e, em single-transaction, o lote inteiro volta).
//
// Banco vazio (instalação nova, CI) não exige arquivo: não há dado a atribuir. Nesse caso nenhuma
// Organization é criada aqui, e qualquer INSERT posterior sem organization_id é recusado pelo trigger
// até que um mapeamento seja aplicado (scripts/tenancy/aplicar-mapeamento.mjs).
//
// Com arquivo, ele precisa cobrir também o que o código em execução grava sem organization_id
// (as três lojas, as quatro tabelas de loja opcional, instalação/Meta/Google Ads e o tenant do
// Creative Core) — não só o dado de hoje.
//
// O arquivo é lido e validado ANTES de qualquer SQL, e só SQL enfileirado sai daqui: `--dry-run`
// continua sem efeito colateral.

const path = require('path');
const {
  lerMapeamentoDeArquivo,
  sqlAplicarMapeamento,
  verificarCompletudeRuntime,
} = require('../lib/platform/tenancy-mapping');

exports.shorthands = undefined;

exports.up = (pgm) => {
  const arquivo = (process.env.TENANCY_MAPPING_FILE || '').trim();
  if (arquivo) {
    const mapeamento = lerMapeamentoDeArquivo(path.resolve(arquivo));
    // Mesmo tenant que routes/criativos.js usa em runtime.
    verificarCompletudeRuntime(mapeamento, { creativeTenant: process.env.CREATIVE_TENANT_ID || 'default' });
    pgm.sql(sqlAplicarMapeamento(mapeamento));
  }
  pgm.sql('SELECT tenancy_exigir_cobertura();');
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM tenancy_mapeamentos;
    DELETE FROM organization_members;
    DELETE FROM stores;
    DELETE FROM organizations;
  `);
};
