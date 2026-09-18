'use strict';

// Entitlement canônico · o Tenant Plane lê a fonte do Control Plane.
//
// O Oria Admin concedia plano em `organization_subscriptions`/`plan_features` e o painel resolvia
// entitlement em `app_config` — duas fontes que nunca conversaram. Organization criada pela
// interface nascia sem acesso a nada. Ver o cabeçalho do .up.sql.
//
// Numeração: o 1790000700000 fica reservado para a migration da frente de capabilities, que ainda
// não foi mesclada e hoje colide com a 0021 já aplicada em produção.
//
// Contrato: docs/architecture/entitlement-canonico.md.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0023-entitlement-canonico.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
