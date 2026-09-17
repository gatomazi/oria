'use strict';

// Fase 1 · triggers transitórios que preenchem organization_id pelo mapeamento (saem na Fase 3).
// SQL gerado a partir de lib/platform/tenancy-manifest.js e congelado em migrations/sql/0008-tenancy-triggers.*.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0008-tenancy-triggers.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
