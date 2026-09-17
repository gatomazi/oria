'use strict';

// Schema do Gerador de Criativos. Até esta migration, `lib/creative-core/schema.js` rodava este
// DDL no mount de `routes/criativos.js` — a cada boot, em toda réplica, sob um `.catch` que só
// logava. Era a mesma classe de `bootstrapPostgres()` e tinha escapado do corte da Fase 0 porque
// não morava em `server.js`.
//
// O texto SQL foi movido sem edição para `sql/0002-creative-core-schema.sql`. É todo
// `IF NOT EXISTS`, então sobre a base de produção (onde o boot já o aplicou) é no-op.

const fs = require('fs');
const path = require('path');

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(fs.readFileSync(path.join(__dirname, 'sql', '0002-creative-core-schema.sql'), 'utf8'));
};

// Irreversível pelo mesmo motivo do baseline: em produção estas tabelas já existiam antes desta
// migration, com dados de cliente. Um `down` que as derrubasse apagaria esses dados.
exports.down = () => {
  throw new Error(
    'creative-core-schema é irreversível: as tabelas creative_* já existiam em produção antes ' +
    'desta migration. Para voltar antes deste ponto, restaure um backup.'
  );
};
