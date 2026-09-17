'use strict';

// Fonte única do DDL para os testes de schema.
//
// Até 8a7ea3d, três testes liam o `server.js` e recortavam o bloco de `bootstrapPostgres()` por
// `indexOf`. Era a escolha certa naquele momento — "roda contra o DDL real, não contra uma cópia
// que envelheceu" — mas o DDL saiu do boot na Fase 0 e virou `migrations/sql/0001-baseline-schema.sql`.
// O recorte continua apontando para a fonte real; só mudou onde ela mora.

const fs = require('node:fs');
const path = require('node:path');

const ARQUIVO = path.join(__dirname, '..', '..', 'migrations', 'sql', '0001-baseline-schema.sql');

function ddlBaseline() {
  return fs.readFileSync(ARQUIVO, 'utf8');
}

// DDL do Gerador de Criativos — saiu do mount de routes/criativos.js para a migration 0002.
function ddlCreativeCore() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', 'sql', '0002-creative-core-schema.sql'), 'utf8');
}

// Recorta um trecho do baseline entre um marcador inicial e o primeiro `;` após um marcador final.
// Mesma semântica do recorte que os testes já faziam sobre o server.js.
function trechoDoBaseline(marcadorInicio, marcadorFim) {
  const sql = ddlBaseline();
  const i = sql.indexOf(marcadorInicio);
  if (i < 0) throw new Error(`marcador inicial não encontrado no baseline: ${marcadorInicio}`);
  const j = sql.indexOf(marcadorFim, i);
  if (j < 0) throw new Error(`marcador final não encontrado no baseline: ${marcadorFim}`);
  const fim = sql.indexOf(';', j) + 1;
  return sql.slice(i, fim);
}

module.exports = { ARQUIVO, ddlBaseline, ddlCreativeCore, trechoDoBaseline };
