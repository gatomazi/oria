'use strict';

// Exportação CSV do público filtrado em Clientes. Sem CPF/documento por padrão. Campos de texto que comecem com
// = + - @ (ou tab/CR) ganham um apóstrofo: planilha não pode interpretá-los como fórmula (CSV injection).

const COLUNAS = Object.freeze([
  ['nome', 'nome'],
  ['email', 'email'],
  ['telefone', 'telefone'],
  ['segmentoNome', 'segmento_rfm'],
  ['pedidosValidos', 'pedidos_validos'],
  ['ltv', 'ltv'],
  ['ticketMedioValido', 'ticket_medio'],
  ['primeiraCompraEm', 'primeira_compra'],
  ['ultimaCompraEm', 'ultima_compra'],
  ['diasSemComprar', 'dias_sem_comprar'],
  ['aceitaMarketing', 'aceita_marketing'],
]);

const PERIGOSOS = /^[=+\-@\t\r]/;

function celula(valor) {
  if (valor == null) return '';
  let texto = typeof valor === 'boolean' ? (valor ? 'sim' : 'nao') : String(valor);
  if (PERIGOSOS.test(texto)) texto = `'${texto}`;
  return /[",\n\r;]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function gerarCsv(clientes) {
  const linhas = [COLUNAS.map(([, nome]) => nome).join(',')];
  for (const c of clientes) linhas.push(COLUNAS.map(([campo]) => celula(c[campo])).join(','));
  // BOM: o Excel abre em UTF-8 sem estragar acentos.
  return `﻿${linhas.join('\r\n')}\r\n`;
}

module.exports = { gerarCsv, COLUNAS };
