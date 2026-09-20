'use strict';

// Catálogo Ink · `store_id` como identidade da Store no cache de produtos, no estado do sync e nos
// jobs de categoria em lote. Ver o cabeçalho do .up.sql para o raciocínio completo.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0026-catalogo-ink-store-id.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
