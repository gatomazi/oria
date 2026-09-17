'use strict';

// Fase 2 · users, sessions revogáveis, papéis owner/member e lookup de memberships.
// Sem dado a migrar: o primeiro owner nasce por scripts/auth/bootstrap-owner.mjs (OPS-18).

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0011-auth-identidade.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
