'use strict';

// Fase 1 · organization_id nullable em toda tabela tenant-owned + funções de cobertura e de verificação.
// SQL gerado a partir de lib/platform/tenancy-manifest.js e congelado em migrations/sql/0004-tenancy-colunas.*.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0004-tenancy-colunas.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
