'use strict';

// Gerador de Criativos · trace de geração (Fase A1). Ver o cabeçalho do .up.sql.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0034-creative-trace.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
