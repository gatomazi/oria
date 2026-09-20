'use strict';

// GA4 · `store_id` como identidade da Store na conexão e no cache de performance. Ver o cabeçalho
// do .up.sql para o raciocínio completo.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0027-ga4-store-id.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
