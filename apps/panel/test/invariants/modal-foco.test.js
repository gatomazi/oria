'use strict';

// Foco dos diálogos do design system: o Modal é aberto por estado (sem Dialog.Trigger), então o Radix não devolve
// o foco a ninguém ao fechar — ele ia para o <body>, e quem usa teclado perdia o lugar na página. O Modal guarda
// quem estava focado ao abrir e devolve a ele ao fechar. Lê Modal.tsx e ConfirmDialog.tsx do sujeito.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');

const ler = (rel) => fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'src', 'components', 'ds', rel), 'utf8');

test('Modal guarda o elemento focado ao abrir e o devolve ao fechar', () => {
  const src = ler('Modal.tsx');
  assert.match(src, /onOpenAutoFocus=\{[^}]*document\.activeElement/, 'guarda o elemento focado quando o diálogo abre');
  assert.match(src, /onCloseAutoFocus=\{/, 'trata a devolução do foco ao fechar');
  assert.match(src, /alvo\.isConnected/, 'só devolve se o elemento ainda existe na página (senão deixa o comportamento padrão)');
  assert.match(src, /ev\.preventDefault\(\);\s*alvo\.focus\(\)/, 'impede o comportamento padrão do Radix (foco no <body>) e foca o elemento guardado');
});

test('ConfirmDialog continua usando o Modal (herda a devolução de foco)', () => {
  assert.match(ler('ConfirmDialog.tsx'), /<Modal\b/);
});
