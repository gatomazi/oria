'use strict';

// Fase 1 · FK, NOT NULL, índices, UNIQUEs por Organization e fim das tabelas de uma linha por instalação.
// SQL gerado a partir de lib/platform/tenancy-manifest.js e congelado em migrations/sql/0007-tenancy-constraints.*.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0007-tenancy-constraints.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
