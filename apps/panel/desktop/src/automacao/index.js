'use strict';

const suportadas = { darwin: './darwin', win32: './win32' };

function carregarAutomacao(plataforma = process.platform) {
  const modulo = suportadas[plataforma];
  if (!modulo) throw new Error(`sistema não suportado: ${plataforma}`);
  return require(modulo);
}

module.exports = { carregarAutomacao, plataformaSuportada: (p = process.platform) => Boolean(suportadas[p]) };
