'use strict';

// Control Plane (Oria Admin) · tabelas de plataforma, read models e o plano técnico `internal`.
//
// O painel é o dono do schema deste banco, então a migration mora aqui — mesmo que quem use as
// tabelas seja `apps/platform-admin`, que é outro deployable e não importa código do painel.
//
// Contrato: docs/architecture/control-plane.md.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0019-platform-admin.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
