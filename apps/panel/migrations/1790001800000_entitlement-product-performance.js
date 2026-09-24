'use strict';

// Fase H (rodada H→I) · entitlement `analytics_product_performance`. Ver o cabeçalho do .up.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0033-entitlement-product-performance.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
