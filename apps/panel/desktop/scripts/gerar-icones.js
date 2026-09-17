'use strict';

// Gera os ícones PNG do app sem depender de ferramenta externa (encoder PNG mínimo com zlib).
// Rodar: node scripts/gerar-icones.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABELA = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABELA[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(tipo, dados) {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}
function png(tamanho, pixel) {
  const linhas = [];
  for (let y = 0; y < tamanho; y += 1) {
    const linha = Buffer.alloc(1 + tamanho * 4);
    for (let x = 0; x < tamanho; x += 1) pixel(x, y).forEach((v, i) => { linha[1 + x * 4 + i] = v; });
    linhas.push(linha);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tamanho, 0);
  ihdr.writeUInt32BE(tamanho, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(linhas))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Balão de conversa com "rabinho" no canto inferior esquerdo e três pontos (digitando) vazados.
function dentroTriangulo(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const s2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const s3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const negativo = s1 < 0 || s2 < 0 || s3 < 0;
  const positivo = s1 > 0 || s2 > 0 || s3 > 0;
  return !(negativo && positivo);
}

function balao(tamanho, cor, fundo) {
  const t = tamanho;
  const r = t * 0.38;
  const c = t * 0.52;
  const pontos = [0.36, 0.52, 0.68].map((fx) => [t * fx, c]);
  const raioPonto = t * 0.055;
  return (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    const dist = Math.hypot(px - c, py - c);
    const noRabinho = dentroTriangulo(px, py, [t * 0.1, t * 0.95], [t * 0.22, t * 0.62], [t * 0.46, t * 0.84]);
    let cobertura = noRabinho ? 1 : Math.max(0, Math.min(1, r + 0.5 - dist));
    if (cobertura <= 0) return fundo;
    for (const [dx, dy] of pontos) {
      const buraco = Math.max(0, Math.min(1, raioPonto + 0.5 - Math.hypot(px - dx, py - dy)));
      cobertura = Math.min(cobertura, 1 - buraco);
    }
    if (cobertura <= 0) return fundo;
    return [cor[0], cor[1], cor[2], Math.round(255 * cobertura)];
  };
}

const destino = path.join(__dirname, '..', 'assets');
fs.mkdirSync(destino, { recursive: true });
const transparente = [0, 0, 0, 0];
fs.writeFileSync(path.join(destino, 'icon.png'), png(512, balao(512, [53, 208, 127], transparente)));
fs.writeFileSync(path.join(destino, 'tray.png'), png(32, balao(32, [53, 208, 127], transparente)));
// macOS: imagem "template" (preta + alpha), o sistema pinta conforme o tema da barra.
fs.writeFileSync(path.join(destino, 'trayTemplate.png'), png(22, balao(22, [0, 0, 0], transparente)));
fs.writeFileSync(path.join(destino, 'trayTemplate@2x.png'), png(44, balao(44, [0, 0, 0], transparente)));
console.log('ícones gerados em', destino);
