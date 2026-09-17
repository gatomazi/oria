'use strict';

// Fase 1 · backfill por mapeamento explícito; aborta se faltar dono ou se o resultado divergir da regra.
// SQL gerado a partir de lib/platform/tenancy-manifest.js e congelado em migrations/sql/0006-tenancy-backfill.*.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0006-tenancy-backfill.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
