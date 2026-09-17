'use strict';

// Fase 3 · Organization ativa na sessão e resolvedores estreitos (jobs, webhook legado, links
// públicos, agente WhatsApp Web).

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0012-tenant-context.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
