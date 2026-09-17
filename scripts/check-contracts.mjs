#!/usr/bin/env node
// Contratos cross-service (painel Node ↔ serviço Go) — fonte canônica em contracts/whatsapp.
//
// Por que existem cópias: cada serviço precisa do arquivo dentro da própria árvore de build (o
// Railway publica só o Root Directory do service, e o Go lê testdata/ no pacote). Então a cópia
// continua, mas deixa de ser "duas verdades": aqui a fonte é uma só e as cópias são conferidas
// byte a byte. Nenhuma dependência de runtime entre Go e Node é criada por isso.
//
//   node scripts/check-contracts.mjs          confere (exit 1 se divergir)
//   node scripts/check-contracts.mjs --sync    reescreve as cópias a partir da fonte canônica

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = path.join(RAIZ, 'contracts', 'whatsapp');
const COPIAS = [
  path.join(RAIZ, 'apps', 'panel', 'test', 'fixtures', 'whatsapp'),
  path.join(RAIZ, 'services', 'whatsapp', 'testdata'),
];

function arquivosCanonicos() {
  return fs.readdirSync(FONTE).filter((f) => f.endsWith('.json')).sort();
}

function main() {
  const sincronizar = process.argv.includes('--sync');
  const canonicos = arquivosCanonicos();
  if (!canonicos.length) {
    console.error(`[contracts] nenhum contrato em ${path.relative(RAIZ, FONTE)}`);
    return 1;
  }
  const problemas = [];
  for (const nome of canonicos) {
    const fonte = fs.readFileSync(path.join(FONTE, nome));
    // O contrato declara o próprio nome e versão: um arquivo sem isso não é contrato.
    let json;
    try {
      json = JSON.parse(fonte.toString('utf8'));
    } catch (err) {
      problemas.push(`${nome}: JSON inválido na fonte (${err.message})`);
      continue;
    }
    if (!json.contract || !Number.isInteger(json.version)) {
      problemas.push(`${nome}: fonte sem "contract"/"version" inteiro`);
    }
    for (const dir of COPIAS) {
      const destino = path.join(dir, nome);
      const relativo = path.relative(RAIZ, destino);
      if (!fs.existsSync(destino)) {
        if (sincronizar) { fs.writeFileSync(destino, fonte); console.log(`[contracts] criada ${relativo}`); continue; }
        problemas.push(`${relativo}: ausente`);
        continue;
      }
      if (fs.readFileSync(destino).equals(fonte)) continue;
      if (sincronizar) { fs.writeFileSync(destino, fonte); console.log(`[contracts] atualizada ${relativo}`); continue; }
      problemas.push(`${relativo}: diverge de contracts/whatsapp/${nome}`);
    }
  }
  if (problemas.length) {
    console.error(`[contracts] FAIL\n  ${problemas.join('\n  ')}\n  corrija a fonte e rode: npm run contracts:sync`);
    return 1;
  }
  console.log(`[contracts] OK · ${canonicos.length} contrato(s) · ${COPIAS.length} cópia(s) idênticas byte a byte`);
  console.log(`  ${canonicos.map((c) => c.replace('.json', '')).join(' · ')}`);
  return 0;
}

process.exit(main());
