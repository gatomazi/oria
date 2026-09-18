'use strict';

// Aceite do convite de owner (Tenant Plane) · leitura que não consome.
//
// A 0019 (control plane) é de outro deployable, mas o schema é do painel — e o aceite é do painel.
// Esta migration acrescenta apenas `platform_convite_pendente(hash)`, o passo que faltava para a
// rota poder criar a conta do convidado antes de gravar o consumo. Ver o cabeçalho do .up.sql.
//
// Contrato: docs/architecture/invite-acceptance.md.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0020-convite-aceite.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
