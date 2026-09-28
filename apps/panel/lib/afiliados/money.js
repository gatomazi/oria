'use strict';

// Aritmética monetária do módulo de afiliados: SEMPRE centavos inteiros (BRL), nunca float de JS para valor.
// Percentuais em basis points (1 bps = 0,01%). Tudo aqui é puro e determinístico.

const RE_DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

// NUMERIC do Postgres chega como string ("100.00", "45.5", "0"); a INK manda strings decimais. Number só é aceito
// quando já é inteiro seguro de centavos via `emCentavos`; para decimal use a string.
// Arredonda meio-para-cima a partir da 3ª casa, por dígito (sem passar por float).
function centavosDeDecimal(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const texto = typeof valor === 'number' ? numeroParaTexto(valor) : String(valor).trim();
  const m = RE_DECIMAL.exec(texto);
  if (!m) return null;
  const negativo = m[1] === '-';
  const inteiro = Number(m[2]);
  const fracao = (m[3] || '').padEnd(3, '0');
  let centavos = inteiro * 100 + Number(fracao.slice(0, 2));
  if (Number(fracao[2]) >= 5) centavos += 1;
  if (!Number.isSafeInteger(centavos)) return null;
  return negativo ? -centavos : centavos;
}

// Number decimal → texto sem notação científica, para reaproveitar o parser de string.
function numeroParaTexto(n) {
  if (!Number.isFinite(n)) return 'NaN';
  return n.toFixed(6);
}

function exigirInteiro(valor, nome) {
  if (!Number.isSafeInteger(valor)) throw new TypeError(`${nome} deve ser um inteiro seguro de centavos (recebido ${valor})`);
  return valor;
}

// floor((a * b) / d) com arredondamento meio-para-cima, em BigInt: nunca perde precisão nem estoura 2^53.
function multiplicarEDividir(a, b, d) {
  exigirInteiro(a, 'a'); exigirInteiro(b, 'b'); exigirInteiro(d, 'd');
  if (d === 0) throw new RangeError('divisão por zero');
  const numerador = BigInt(a) * BigInt(b);
  const denominador = BigInt(d);
  const negativo = (numerador < 0n) !== (denominador < 0n);
  const absN = numerador < 0n ? -numerador : numerador;
  const absD = denominador < 0n ? -denominador : denominador;
  const q = (absN * 2n + absD) / (absD * 2n); // meio-para-cima em módulo
  const r = negativo ? -q : q;
  return Number(r);
}

// Percentual em bps aplicado a centavos: 15% de 3000 = percentualDe(3000, 1500) = 450.
function percentualDe(centavos, bps) {
  return multiplicarEDividir(exigirInteiro(centavos, 'centavos'), exigirInteiro(bps, 'bps'), 10000);
}

// Proporção: valor * numerador / denominador, arredondado meio-para-cima.
function proporcao(valor, numerador, denominador) {
  return multiplicarEDividir(valor, numerador, denominador);
}

// Rateio determinístico pelo método do maior resto: a soma das partes é EXATAMENTE `total`.
// Empate de resto resolve pelo menor índice. Pesos zerados dividem igualmente.
function ratear(total, pesos) {
  exigirInteiro(total, 'total');
  if (!Array.isArray(pesos) || pesos.length === 0) throw new TypeError('ratear exige ao menos um peso');
  pesos.forEach((p) => { if (!Number.isSafeInteger(p) || p < 0) throw new TypeError('pesos devem ser inteiros >= 0'); });
  const negativo = total < 0;
  const alvo = BigInt(Math.abs(total));
  let base = pesos;
  let soma = base.reduce((acc, p) => acc + BigInt(p), 0n);
  if (soma === 0n) { base = pesos.map(() => 1); soma = BigInt(pesos.length); }
  const partes = base.map((p) => (alvo * BigInt(p)) / soma);
  const restos = base.map((p, i) => ({ i, resto: (alvo * BigInt(p)) % soma }));
  let faltam = alvo - partes.reduce((acc, p) => acc + p, 0n);
  restos.sort((x, y) => (x.resto === y.resto ? x.i - y.i : x.resto > y.resto ? -1 : 1));
  for (const { i } of restos) {
    if (faltam <= 0n) break;
    partes[i] += 1n;
    faltam -= 1n;
  }
  return partes.map((p) => (negativo ? -Number(p) : Number(p)));
}

const FORMATO_BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function formatarBRL(centavos) {
  return FORMATO_BRL.format(exigirInteiro(centavos, 'centavos') / 100);
}

// Centavos → texto decimal exato ("12.34"), para CSV e logs (sem float).
function centavosParaDecimal(centavos) {
  exigirInteiro(centavos, 'centavos');
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const texto = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negativo ? `-${texto}` : texto;
}

module.exports = {
  centavosDeDecimal, exigirInteiro, multiplicarEDividir, percentualDe, proporcao, ratear, formatarBRL, centavosParaDecimal,
};
