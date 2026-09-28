'use strict';

// CSV seguro para planilha: escapa aspas/quebras e neutraliza injeção de fórmula (=, +, -, @, tab, CR no início da célula).
// Valores numéricos legítimos (inclusive negativos) entram como número, nunca como texto prefixado.

const RE_NUMERO = /^-?\d+(\.\d+)?$/;
const PREFIXOS_DE_FORMULA = ['=', '+', '-', '@', '\t', '\r'];

function celula(valor) {
  if (valor === null || valor === undefined) return '';
  let texto;
  if (valor instanceof Date) texto = valor.toISOString();
  else if (typeof valor === 'number' || typeof valor === 'bigint') texto = String(valor);
  else texto = String(valor);
  const numerico = (typeof valor === 'number' || typeof valor === 'bigint') && RE_NUMERO.test(texto);
  if (!numerico && texto.length > 0 && PREFIXOS_DE_FORMULA.includes(texto[0])) texto = `'${texto}`;
  if (/[",\n\r]/.test(texto)) texto = `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

// colunas: [{ chave, titulo }]. Cabeçalho fixo; nada além das colunas declaradas sai (sem vazar campo extra da linha).
function gerarCsv(colunas, linhas) {
  const cabecalho = colunas.map((c) => celula(c.titulo)).join(',');
  const corpo = linhas.map((l) => colunas.map((c) => celula(l[c.chave])).join(','));
  return `﻿${[cabecalho, ...corpo].join('\r\n')}\r\n`;
}

module.exports = { gerarCsv, celula };
