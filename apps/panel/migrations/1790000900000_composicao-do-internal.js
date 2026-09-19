'use strict';

// Composição do plano `internal`: entram `meta_ads`, `google_ads` e `analytics_ga4`, e o domain
// `platform_feature` passa a aceitá-las. É uma migration ADITIVA — nada é apagado.
//
// NÃO apaga `catalog`, `exchanges` nem `refunds` (o runtime ainda as confere como entitlement) e
// NÃO apaga os quatro modos de criativos (o código de produção atual ainda os lê do plano, e o
// pre-deploy roda antes de a release nova assumir). A limpeza física é uma migration separada,
// para depois do deploy. O porquê completo está no cabeçalho do .up.sql e em
// docs/architecture/features-vs-connectors.md.
//
// Numeração: esta migration nasceu como 1790000700000, e o cabeçalho de
// 1790000800000_entitlement-canonico chegou a reservar esse número para ela. A reserva não vale:
// 1790000700000 ordena ANTES de 1790000800000, que já está aplicada em produção, e o
// node-pg-migrate recusa rodar migration pendente anterior a uma já aplicada (checkOrder). Por isso
// o timestamp é o próximo livre depois da mais recente de `main`. O arquivo da 1790000800000 não
// foi tocado — migration aplicada é imutável, comentário inclusive.

const fs = require('fs');
const path = require('path');

const sql = (sentido) => fs.readFileSync(path.join(__dirname, 'sql', `0024-composicao-do-internal.${sentido}.sql`), 'utf8');

exports.shorthands = undefined;
exports.up = (pgm) => { pgm.sql(sql('up')); };
exports.down = (pgm) => { pgm.sql(sql('down')); };
