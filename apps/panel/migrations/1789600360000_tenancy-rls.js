'use strict';

// Fase 1 · RLS habilitada e forçada, policy USING + WITH CHECK (TD-001).
// SQL gerado a partir de lib/platform/tenancy-manifest.js e congelado em migrations/sql/0009-tenancy-rls.*.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0009-tenancy-rls.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
