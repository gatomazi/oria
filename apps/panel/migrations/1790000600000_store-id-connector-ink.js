'use strict';

// Connector Ink · `store_id` como identidade da Store nas tabelas operacionais.
//
// Cliente criado nativamente pelo Oria nasce com `stores.loja_legada` NULA. Como `pedidos_ink.loja`
// era NOT NULL, esse cliente não conseguia ter pedido — a chave do sistema antigo era requisito de
// existência. Esta migration acrescenta `store_id`, libera `loja` e mantém a coluna textual como
// compatibilidade histórica. Ver o cabeçalho do .up.sql para o raciocínio completo.
//
// Contrato: docs/commands/claude-productizar-connector-ink-sem-loja-legada.md.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0021-store-id-connector-ink.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
