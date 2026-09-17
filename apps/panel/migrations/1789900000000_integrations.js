'use strict';

// Fase 4 · registro de posse de recurso externo e state de OAuth persistido. Segredos NÃO entram
// por migration: `npm run integrations:import-legacy` os importa (nunca em SQL, git ou pgmigrations).

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0013-integrations.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
