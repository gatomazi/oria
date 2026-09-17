#!/usr/bin/env node
// Verifica quais assets visuais estão presentes vs esperados:
//   - Mockups de camiseta (cores)
//   - Brasões por relação (PAI, AVÔ, ...)
//   - Dígitos do ano (0-9)
// Roda com: node scripts/verificar-mockups.js

const fs = require('fs');
const path = require('path');

const rootPath = path.resolve(__dirname, '..');
const mockupsDir = path.join(rootPath, 'assets', 'mockups');
const mockupsBrasaoDir = path.join(rootPath, 'assets', 'mockups-brasao');
const brasoesDir = path.join(rootPath, 'assets', 'brasoes');
const produtos = JSON.parse(fs.readFileSync(path.join(rootPath, 'data', 'produtos.json'), 'utf8'));

if (!fs.existsSync(mockupsDir)) fs.mkdirSync(mockupsDir, { recursive: true });
if (!fs.existsSync(mockupsBrasaoDir)) fs.mkdirSync(mockupsBrasaoDir, { recursive: true });
if (!fs.existsSync(brasoesDir)) fs.mkdirSync(brasoesDir, { recursive: true });

// Precisa bater com o mapa em src/loja.js
const RELACAO_SLUG = {
  'PAI': 'pai', 'MÃE': 'mae',
  'AVÔ': 'avo', 'AVÓ': 'avoo',
  'PADRINHO': 'padrinho', 'MADRINHA': 'madrinha',
  'TIO': 'tio', 'TIA': 'tia',
  'IRMÃO': 'irmao', 'IRMÃ': 'irmaa',
  'FILHO': 'filho', 'FILHA': 'filha'
};
function slugRelacao(rel) { return RELACAO_SLUG[rel] || rel.toLowerCase(); }

function checar(titulo, dir, esperados) {
  console.log(`\n📸  ${titulo} — em ${path.relative(rootPath, dir)}/\n`);
  let presentes = 0, faltando = 0;
  esperados.forEach(({ arquivo, label }) => {
    const existe = fs.existsSync(path.join(dir, arquivo));
    const marca = existe ? '✅' : '❌';
    if (existe) presentes++; else faltando++;
    console.log(`  ${marca}  ${arquivo.padEnd(30)}  ${label || ''}`);
  });
  console.log(`\n  ${presentes} presente(s), ${faltando} faltando.`);
  return { presentes, faltando };
}

// 1) MOCKUPS DAS CAMISETAS
const mockupsEsperados = produtos.cores.map(c => ({
  arquivo: path.basename(c.mockup),
  label: c.nome
}));
const r1 = checar('Mockups das camisetas', mockupsDir, mockupsEsperados);

// 2) MOCKUPS FINALIZADOS (foto camiseta com brasão já estampado) — modo "camiseta"
const emblema = produtos.modelos.find(m => m.slug === 'emblema-raizes');
const relacoes = emblema.campos.find(c => c.id === 'relacao').opcoes;
const mockupsFinaisEsperados = [];
produtos.cores.forEach(c => {
  relacoes.forEach(rel => {
    mockupsFinaisEsperados.push({
      arquivo: `camiseta-${c.slug}-${slugRelacao(rel)}.jpg`,
      label: `${c.nome} + ${rel}`
    });
  });
});
const r2 = checar('Mockups finalizados (foto camiseta + brasão aplicado)', mockupsBrasaoDir, mockupsFinaisEsperados);

// 3) BRASÕES SOZINHOS (pro closeup) — só o brasão em fundo transparente
const brasoesEsperados = relacoes.map(rel => ({
  arquivo: `brasao-${slugRelacao(rel)}.png`,
  label: rel + ' (brasão sozinho pro closeup)'
}));
const r3 = checar('Brasões pro closeup (fundo transparente ou preto)', brasoesDir, brasoesEsperados);

// 4) DÍGITOS DO ANO
const numerosEsperados = Array.from({ length: 10 }, (_, i) => ({
  arquivo: `numero-${i}.png`,
  label: `dígito ${i}`
}));
const r4 = checar('Dígitos do ano (0-9)', brasoesDir, numerosEsperados);

const total = r1.presentes + r2.presentes + r3.presentes + r4.presentes;
const faltantes = r1.faltando + r2.faltando + r3.faltando + r4.faltando;

console.log('\n' + '─'.repeat(60));
console.log(`  Total: ${total} presente(s), ${faltantes} faltando.`);
console.log('─'.repeat(60));
console.log('\n  Enquanto os arquivos não estiverem lá, o site usa fallbacks:');
console.log('   • Camiseta sem PNG → retângulo colorido com o hex');
console.log('   • Brasão sem PNG   → SVG gerado dinamicamente');
console.log('   • Dígito sem PNG   → só aparece o brasão, sem ano visível\n');

process.exit(faltantes > 0 ? 1 : 0);
