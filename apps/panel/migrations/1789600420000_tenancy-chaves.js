'use strict';

// Fase 1 · contract: toda UNIQUE, PK e FK entre tabelas tenant-owned passa a incluir
// organization_id; as chaves globais restantes saem. INV-05 sem exceção.
// SQL gerado a partir de lib/platform/tenancy-manifest.js e congelado em migrations/sql/0010-tenancy-chaves.*.sql.
//
// Deploy em DOIS passos (OPS-17): primeiro a versão cujo código já usa os alvos de ON CONFLICT com
// organization_id (migrations até 1789600360000); só depois esta. Se as duas subirem juntas, a
// versão antiga, ainda no ar durante o pre-deploy, perde o árbitro dos seus upserts.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0010-tenancy-chaves.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
