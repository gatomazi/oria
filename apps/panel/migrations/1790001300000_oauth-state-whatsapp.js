'use strict';

// Embedded Signup do WhatsApp · provider `whatsapp` no state de OAuth. Ver o cabeçalho do .up.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0028-oauth-state-whatsapp.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
