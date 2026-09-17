#!/usr/bin/env node
// Regenera migrations/sql/00{03..09}-tenancy-*.{up,down}.sql a partir do manifesto.
// Só antes do primeiro deploy da Fase 1: depois disso o SQL aplicado é histórico e não se reescreve.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { ARQUIVOS } = require('./sql-fase1.cjs');

for (const [nome, { up, down }] of Object.entries(ARQUIVOS)) {
  for (const [sentido, gerar] of [['up', up], ['down', down]]) {
    const destino = path.join(RAIZ, 'migrations', 'sql', `${nome}.${sentido}.sql`);
    fs.writeFileSync(destino, gerar());
    console.log(path.relative(RAIZ, destino));
  }
}
