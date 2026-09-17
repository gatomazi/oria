'use strict';

// Baseline: o schema que até `8a7ea3d` era criado por `bootstrapPostgres()` no boot do processo.
// O texto SQL foi movido sem edição para `sql/0001-baseline-schema.sql` (ver migrations/README.md).
//
// É todo `IF NOT EXISTS`, então aplicar sobre a base de produção atual é no-op — é literalmente o
// que já acontecia a cada subida. A diferença é que agora acontece UMA vez, transacionalmente, com
// registro em `pgmigrations`, e a falha aborta o deploy em vez de virar uma linha de log.

const fs = require('fs');
const path = require('path');

exports.shorthands = undefined;

exports.up = (pgm) => {
  const sql = fs.readFileSync(path.join(__dirname, 'sql', '0001-baseline-schema.sql'), 'utf8');
  pgm.sql(sql);
};

// Irreversível de propósito: o "estado anterior" ao baseline é um banco sem nenhuma tabela do
// painel. Reverter isso é restore de backup, não migration. Ver migrations/README.md.
exports.down = () => {
  throw new Error(
    'baseline-schema é irreversível: reverter apagaria todo o schema do painel. ' +
    'Para voltar antes deste ponto, restaure um backup.'
  );
};
