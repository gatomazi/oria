'use strict';

// Gerador de Criativos · Product Enrichment (Fase F.2.B) — reserva atômica de concorrência e
// orçamento do piloto controlado. Ver o cabeçalho do .up.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0041-creative-enrichment-pilot-budget.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
