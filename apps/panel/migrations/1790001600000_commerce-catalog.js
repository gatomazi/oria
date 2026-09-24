'use strict';

// Fase D · catálogo canônico de Commerce (commerce_products, commerce_product_variants,
// commerce_catalog_sync_logs). Ver o cabeçalho do .up.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0031-commerce-catalog.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
