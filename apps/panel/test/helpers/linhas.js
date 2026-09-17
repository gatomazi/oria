'use strict';

// Gera e insere uma linha válida em QUALQUER tabela do schema, preenchendo só o que é obrigatório
// (NOT NULL sem default) e o que o teste pedir. Existe para que a matriz de isolamento cubra as 55
// tabelas tenant-owned sem 55 fixtures escritas à mão — uma tabela nova entra na matriz sozinha.

const crypto = require('node:crypto');

let contador = 0;
const cacheColunas = new Map();

async function colunas(client, tabela) {
  const chave = tabela;
  if (cacheColunas.has(chave)) return cacheColunas.get(chave);
  const { rows } = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default, is_generated, identity_generation
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [tabela]
  );
  cacheColunas.set(chave, rows);
  return rows;
}

function limparCache() {
  cacheColunas.clear();
}

function valorPara(coluna, n) {
  switch (coluna.data_type) {
    case 'text':
    case 'character varying':
      return `${coluna.column_name}-${n}`;
    case 'smallint':
      return (n % 30000) + 1;
    case 'integer':
    case 'bigint':
      return n;
    case 'numeric':
    case 'double precision':
    case 'real':
      return 1;
    case 'boolean':
      return false;
    case 'uuid':
      return crypto.randomUUID();
    case 'json':
    case 'jsonb':
      return '{}';
    case 'date':
      return '2026-09-10';
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return new Date().toISOString();
    case 'ARRAY':
      return '{}';
    case 'bytea':
      return Buffer.from('x');
    default:
      throw new Error(`linhas.js: tipo ${coluna.data_type} (${coluna.column_name}) sem gerador`);
  }
}

// Insere e devolve a linha. `valores` sobrescreve/acrescenta colunas; `null` explícito é respeitado.
async function inserir(client, tabela, valores = {}) {
  contador += 1;
  const n = contador;
  const cols = await colunas(client, tabela);
  const nomes = [];
  const params = [];
  for (const c of cols) {
    if (c.is_generated === 'ALWAYS') continue;
    if (Object.prototype.hasOwnProperty.call(valores, c.column_name)) {
      nomes.push(c.column_name);
      params.push(valores[c.column_name]);
      continue;
    }
    const obrigatoria = c.is_nullable === 'NO' && c.column_default === null && !c.identity_generation;
    if (obrigatoria) {
      nomes.push(c.column_name);
      params.push(valorPara(c, n));
    }
  }
  const desconhecidas = Object.keys(valores).filter((k) => !cols.some((c) => c.column_name === k));
  if (desconhecidas.length) throw new Error(`linhas.js: ${tabela} não tem ${desconhecidas.join(', ')}`);

  const sql = nomes.length
    ? `INSERT INTO ${tabela} (${nomes.join(', ')}) VALUES (${nomes.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`
    : `INSERT INTO ${tabela} DEFAULT VALUES RETURNING *`;
  const { rows } = await client.query(sql, params);
  return rows[0];
}

module.exports = { inserir, colunas, limparCache };
