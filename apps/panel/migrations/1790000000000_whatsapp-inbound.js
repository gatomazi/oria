'use strict';

// Fase 5c · resolvedor da entrada do WhatsApp por (WABA, número) e posse exclusiva da WABA.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0014-whatsapp-inbound.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
