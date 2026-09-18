'use strict';

// Reclassificação de features comerciais → connector capabilities (Reserva Ink) e module
// capabilities (Gerador de Criativos). Só ajusta dado do control plane: tira as sete chaves
// reclassificadas de `plan_features` e `organization_entitlement_overrides`.
//
// O domain `platform_feature` NÃO é estreitado aqui — é a última fase da depreciação, quando não
// houver mais nenhuma linha nem ambiente carregando as chaves antigas. Ver o cabeçalho do .up.sql
// e docs/architecture/features-vs-connectors.md.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0022-features-reclassificadas.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
