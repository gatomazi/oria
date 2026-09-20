'use strict';

// Mídia e financeiro · `store_id` como identidade da Store na atribuição de conta de anúncio, nas
// despesas operacionais e nas campanhas UTM. Ver o cabeçalho do .up.sql para o raciocínio completo.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0025-midia-store-id.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
