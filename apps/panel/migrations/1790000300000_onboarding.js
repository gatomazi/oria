'use strict';

// Fase 7 (construção) · estado de onboarding retomável, convite do primeiro owner e chave de
// idempotência da criação de Organization. Nada é criado aqui; a criação fica atrás de
// SECOND_TENANT_ENABLED (lib/platform/onboarding.js).

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0018-onboarding.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
