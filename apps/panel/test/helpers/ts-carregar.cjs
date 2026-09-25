'use strict';

// Carrega módulos TypeScript PUROS do painel (sem React/DOM) para teste: transpila o arquivo REAL (não uma cópia) e resolve
// imports relativos `./x` recursivamente. Imports de tipo somem na transpilação.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function carregar(arquivoAbsoluto, cache = new Map()) {
  if (cache.has(arquivoAbsoluto)) return cache.get(arquivoAbsoluto).exports;
  const js = ts.transpileModule(fs.readFileSync(arquivoAbsoluto, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const modulo = { exports: {} };
  cache.set(arquivoAbsoluto, modulo);
  const requerer = (id) => {
    if (id.startsWith('.')) {
      const base = path.resolve(path.dirname(arquivoAbsoluto), id);
      const candidato = ['.ts', '.tsx', '/index.ts'].map((e) => base + e).find((f) => fs.existsSync(f));
      if (!candidato) throw new Error(`import não resolvido: ${id} (de ${arquivoAbsoluto})`);
      return carregar(candidato, cache);
    }
    throw new Error(`import externo não permitido em módulo puro: ${id}`);
  };
  vm.runInNewContext(js, { module: modulo, exports: modulo.exports, require: requerer });
  return modulo.exports;
}

module.exports = { carregarTs: (rel) => carregar(path.resolve(__dirname, '..', '..', rel)) };
