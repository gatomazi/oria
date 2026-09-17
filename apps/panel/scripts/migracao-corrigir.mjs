#!/usr/bin/env node
// Corrige UM produto da migração no mesmo id. Doc: docs/plano-migracao-criacao-produtos.md
//
//   INK_TOKEN_SUL=... node scripts/migracao-corrigir.mjs <id>                          # mostra o que faria
//   INK_TOKEN_SUL=... node scripts/migracao-corrigir.mjs <id> --executar --reaplicar   # destrava resizing
//   INK_TOKEN_SUL=... node scripts/migracao-corrigir.mjs <id> --executar               # só troca a arte
//   … --cores-extras   libera as cores só das peças de destino (Rosa Bebê, Off White…)
//
// --reaplicar desativa e readiciona as variantes em duas metades. Foi o que destravou produtos
// presos em resizing em 15/09; o PATCH simples de arte não destravava. Mesmo id, mesmo
// agrupamento, nenhum órfão. Em lote: scripts/migracao-verificar.mjs --executar.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MODELOS, criarCliente, chaveIdem, indexarAcervo, resolverItem, conferirLuminancia,
  artsDasAreas, reaplicarProduto, habilitarCoresExtras,
} from './migracao-config.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ESTADO = process.env.MIGRACAO_ESTADO || path.join(DIR, '.migracao-estado.jsonl');
const id = Number(process.argv.find((a) => /^\d+$/.test(a)));
const EXECUTAR = process.argv.includes('--executar');
const REAPLICAR = process.argv.includes('--reaplicar');
if (process.argv.includes('--cores-extras')) habilitarCoresExtras();
if (!process.env.INK_TOKEN_SUL || !id) { console.error('uso: INK_TOKEN_SUL=... node scripts/migracao-corrigir.mjs <id> [--executar] [--reaplicar] [--cores-extras]'); process.exit(1); }
const ink = criarCliente(process.env.INK_TOKEN_SUL, process.env.MIGRACAO_INK_BASE ? { base: process.env.MIGRACAO_INK_BASE } : {});

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const falha = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };
const resumo = (p) => `approval_status ${p.approval_status} · ${(p.product_variants || []).length} variantes · ativas ${(p.product_variants || []).filter((v) => v.is_available !== false).length} · main_image_url ${p.main_image_url ? 'ok' : 'VAZIO'}`;

// 1. De qual item da migração é esse id? Produto de fora da migração não é tocado.
let chave = null;
for (const linha of fs.readFileSync(ESTADO, 'utf8').split('\n')) {
  if (!linha.trim()) continue;
  let r; try { r = JSON.parse(linha); } catch { continue; }
  if ((r.fase === 'criado' && Number(r.produtoId) === id) || (r.fase === 'copia' && Number(r.id) === id)) chave = r.chave;
}
if (!chave) falha(`id ${id} não está no arquivo de estado da migração — não mexo em produto de fora`);
const item = indexarAcervo().get(chave);
const resolvido = item && resolverItem(item);
if (!resolvido || resolvido.bloqueio) falha(`item ${chave} não resolve no acervo: ${resolvido?.bloqueio || 'ausente'}`);

// 2. Produto e áreas do TIPO dele
const antes = (await ink('GET', `/v1/stores/products/${id}`)).product;
console.log(`\n\x1b[1m${antes.product_type?.name} :: ${antes.name}\x1b[0m  (id ${id} · item ${chave})`);
console.log(`  antes: ${resumo(antes)}`);
const tipos = (await ink('GET', '/v1/stores/product_types?per_page=100')).product_types || [];
const tipo = tipos.find((t) => t.id === antes.product_type?.id);
if (!tipo) falha(`tipo ${antes.product_type?.id} não encontrado nos tipos da loja`);

const { arts, porBalde, semRegra } = artsDasAreas(tipo.printable_areas, resolvido.modelo, resolvido.arquivos);
if (semRegra.length) falha(`cor(es) sem balde em ${tipo.name}: ${semRegra.join(', ')} — confirme a proposta e use --cores-extras`);
const sufixos = MODELOS[resolvido.modelo].sufixos;
console.log(`\n  ${tipo.name}: ${arts.length} área(s)`);
for (const [b, lista] of Object.entries(porBalde)) {
  if (!lista.length) continue;
  ok(`${b.padEnd(8)} ${[...new Set(lista.map((a) => a.color.name))].join(', ')}  →  ${path.basename(resolvido.arquivos[sufixos[b]])}  (${lista.length})`);
}
const problemas = await conferirLuminancia(resolvido.modelo, resolvido.arquivos);
if (problemas.length) falha(`luminância: ${problemas.join('; ')}`);
ok('luminância das artes confere com o modelo');
const mb = (arts.reduce((n, a) => n + a.art_attachment.length, 0) / 1048576).toFixed(1);

if (!EXECUTAR) {
  console.log(`\n\x1b[36m${REAPLICAR ? 'Desativar + readicionar' : 'PATCH de arte'}: ${arts.length} área(s), ~${mb} MB. Nada foi enviado — rode com --executar.\x1b[0m\n`);
  process.exit(0);
}

let relido;
if (REAPLICAR) {
  console.log(`\n  reaplicando ${arts.length} área(s), ~${mb} MB…`);
  ({ relido } = await reaplicarProduto(ink, { id, modelo: resolvido.modelo, arquivos: resolvido.arquivos, tipos, log: ok }));
} else {
  console.log(`\n  enviando ${arts.length} arte(s), ~${mb} MB…`);
  await ink('PATCH', `/v1/stores/products/${id}`, { arts }, { idem: chaveIdem('corrigir', id, Date.now()) });
  relido = (await ink('GET', `/v1/stores/products/${id}`)).product || {};
}
ok(`depois: ${resumo(relido)}`);
fs.appendFileSync(ESTADO, `${JSON.stringify({ chave, fase: 'corrigido', modo: REAPLICAR ? 'reaplicar' : 'patch', id, tipo: antes.product_type?.id, antes: antes.approval_status, relido: relido.approval_status, em: new Date().toISOString() })}\n`);
console.log(`\nAcompanhe: INK_TOKEN_SUL=... node scripts/migracao-diagnostico.mjs ${id}\n`);
