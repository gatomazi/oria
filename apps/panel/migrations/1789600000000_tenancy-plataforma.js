'use strict';

// Fase 1 · organizations, stores (1:1), organization_members, tenancy_mapeamentos e o trigger de compatibilidade.
// SQL gerado a partir de lib/platform/tenancy-manifest.js e congelado em migrations/sql/0003-tenancy-plataforma.*.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0003-tenancy-plataforma.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
