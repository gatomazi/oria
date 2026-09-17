#!/usr/bin/env node
// Verificação pós-migração: acha produtos da migração presos em approval_status=resizing (mockup
// que nunca terminou) e os DESTRAVA no mesmo id. Doc: docs/plano-migracao-criacao-produtos.md
//
//   INK_TOKEN_SUL=... node scripts/migracao-verificar.mjs                              # só relatório
//   INK_TOKEN_SUL=... node scripts/migracao-verificar.mjs --executar --min-horas=24
//   INK_TOKEN_SUL=... node scripts/migracao-verificar.mjs --executar --limite=20 --concorrencia=2
//   … --cores-extras   libera Body Infantil/Hoodie (cores Rosa Bebê, Off White… ainda em proposta)
//
// Destravar = desativar e readicionar as variantes (reaplicarProduto). Validado em 15/09: a recópia
// só criava cópia nova na mesma fila parada e deixava a antiga órfã; o reaplicar tirou produtos
// presos desde 12/09 de resizing com as imagens carregadas, sem órfão nenhum.
//
// `resizing` também é o estado NORMAL logo depois da cópia — só conta como preso depois de
// --min-horas (padrão 6) sem atualização. Só olha produtos do arquivo de estado da migração.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  TIPO_BASE, TIPOS_COPIA, criarCliente, indexarAcervo, resolverItem, reaplicarProduto, baldeDaCor, habilitarCoresExtras,
} from './migracao-config.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ESTADO = process.env.MIGRACAO_ESTADO || path.join(DIR, '.migracao-estado.jsonl');
const arg = (n, padrao) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] ?? padrao;
const EXECUTAR = process.argv.includes('--executar');
const MIN_HORAS = Number(arg('min-horas', '6'));
// Teto por produto: se reaplicar 2x não destravou, o problema não é esse — vai pra análise manual
// em vez de ficar martelando a Ink a cada rodada.
const MAX_REAPLICAR = Number(arg('max-reaplicar', '2'));
// Cada reaplicar sobe todas as artes do produto (~12 MB num Cropped). Padrão 1, como no lote.
const CONCORRENCIA = Number(arg('concorrencia', '1'));
if (process.argv.includes('--cores-extras')) habilitarCoresExtras();
// Reaplica só os N mais antigos. Bom pra começar pequeno e conferir no painel.
const LIMITE = Number(arg('limite', '0')) || Infinity;

if (!process.env.INK_TOKEN_SUL) { console.error('falta INK_TOKEN_SUL'); process.exit(1); }
if (!fs.existsSync(ESTADO)) { console.error(`sem arquivo de estado em ${ESTADO}`); process.exit(1); }
const ink = criarCliente(process.env.INK_TOKEN_SUL, process.env.MIGRACAO_INK_BASE ? { base: process.env.MIGRACAO_INK_BASE } : {});
const nomeTipo = new Map([[TIPO_BASE.id, TIPO_BASE.nome], ...TIPOS_COPIA.map((t) => [t.id, t.nome])]);

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const aviso = (m) => console.log(`  \x1b[33m! ${m}\x1b[0m`);

// ── Estado: id do produto → de qual item/tipo ele é ─────────────────────────────────────────
const itens = new Map();  // chave -> { nome, base, copias: Map(tipo -> id), recopias: Map(tipo -> n) }
const reaplicacoes = new Map();  // id -> quantas vezes já foi reaplicado
for (const linha of fs.readFileSync(ESTADO, 'utf8').split('\n')) {
  if (!linha.trim()) continue;
  let r; try { r = JSON.parse(linha); } catch { continue; }
  const it = itens.get(r.chave) || { copias: new Map(), recopias: new Map() };
  if (r.nome) it.nome = r.nome;
  if (r.fase === 'criado') it.base = r.produtoId;
  if (r.fase === 'copia') {
    it.copias.set(r.tipo, r.id);
    if (r.substitui) it.recopias.set(r.tipo, (it.recopias.get(r.tipo) || 0) + 1);
  }
  if (r.fase === 'reaberto') { it.base = undefined; it.copias = new Map(); }
  if (r.fase === 'corrigido' && r.modo === 'reaplicar') reaplicacoes.set(Number(r.id), (reaplicacoes.get(Number(r.id)) || 0) + 1);
  itens.set(r.chave, it);
}
const donoDoId = new Map();
for (const [chave, it] of itens) {
  if (it.base) donoDoId.set(it.base, { chave, tipo: TIPO_BASE.id });
  for (const [tipo, id] of it.copias) donoDoId.set(id, { chave, tipo });
}
console.log(`\n\x1b[1mVERIFICAÇÃO PÓS-MIGRAÇÃO\x1b[0m  ${EXECUTAR ? '\x1b[31m[EXECUTA]\x1b[0m' : '\x1b[36m[relatório]\x1b[0m'}`);
console.log(`\n${itens.size} item(ns) no estado · ${donoDoId.size} produto(s) rastreados · preso = sem atualização há ${MIN_HORAS}h+`);

// ── Presos ──────────────────────────────────────────────────────────────────────────────────
async function listarPorStatus(status) {
  const out = [];
  for (let p = 1; ; p += 1) {
    const d = await ink('GET', `/v1/stores/products?per_page=100&page=${p}&approval_status=${status}`, null, { timeoutMs: 60000 });
    out.push(...(d.products || []).filter((pr) => donoDoId.has(pr.id)));
    if (p >= (d.total_pages || 1)) break;
  }
  return out;
}

const agora = Date.now();
const idadeHoras = (pr) => (agora - new Date(pr.updated_at || pr.created_at).getTime()) / 3600000;

const resizing = await listarPorStatus('resizing');
const presos = resizing.filter((pr) => idadeHoras(pr) >= MIN_HORAS);
const recentes = resizing.length - presos.length;
// Reprovado não pode ser copiado nem recuperado por recópia — só aparece no relatório.
const reprovados = await listarPorStatus('disapproved');

console.log(`\nresizing      ${resizing.length}  (${presos.length} preso(s) · ${recentes} ainda dentro do prazo)`);

// Idade dos que estão em resizing. Com o lote rodando, a fila de mockup da Ink pode estar só
// ATRASADA: se a massa está nas faixas recentes e cresce junto com o lote, é fila, não trava —
// recopiar só gera órfão e manda a cópia nova pro fim da mesma fila. Travado de verdade é o que
// continua lá nas faixas antigas.
if (resizing.length) {
  const faixas = [[0, 6], [6, 12], [12, 24], [24, 48], [48, Infinity]];
  console.log('\n\x1b[1mIdade dos que estão em resizing\x1b[0m');
  for (const [de, ate] of faixas) {
    const n = resizing.filter((pr) => { const h = idadeHoras(pr); return h >= de && h < ate; }).length;
    const rot = ate === Infinity ? `${de}h+` : `${de}–${ate}h`;
    console.log(`  ${rot.padStart(7)}  ${String(n).padStart(5)}  ${'█'.repeat(Math.min(50, Math.ceil((50 * n) / resizing.length)))}`);
  }
}
console.log(`reprovados    ${reprovados.length}`);

// Distribuição por tipo: se concentra num tipo só, é problema sistemático daquela peça (grade,
// paleta), não instabilidade — recopiar em massa só geraria órfão.
const porTipo = new Map();
for (const pr of presos) {
  const t = donoDoId.get(pr.id).tipo;
  porTipo.set(t, (porTipo.get(t) || 0) + 1);
}
if (porTipo.size) {
  console.log('\n\x1b[1mPresos por peça\x1b[0m');
  for (const [t, n] of [...porTipo].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${nomeTipo.get(t) || t}`);
  }
  const [maiorTipo, maiorN] = [...porTipo].sort((a, b) => b[1] - a[1])[0];
  if (presos.length >= 20 && maiorN / presos.length > 0.8) {
    aviso(`${Math.round((100 * maiorN) / presos.length)}% dos presos são ${nomeTipo.get(maiorTipo)} — parece sistemático, não instabilidade. Confira uma peça no painel antes de recopiar.`);
  }
}
if (reprovados.length) {
  console.log('\n\x1b[1mReprovados\x1b[0m (não recuperáveis por recópia)');
  for (const pr of reprovados.slice(0, 20)) console.log(`  ${pr.id}  ${nomeTipo.get(donoDoId.get(pr.id).tipo)} :: ${pr.name}`);
}

// Mais antigos primeiro. Camiseta base também entra: o reaplicar lê as áreas do tipo de cada
// produto, então serve pra qualquer peça.
const alvos = [...presos].sort((a, b) => idadeHoras(b) - idadeHoras(a));

const tipos = (await ink('GET', '/v1/stores/product_types?per_page=100')).product_types || [];
// Peças com cor sem balde confirmado (Body Infantil, Hoodie…) ficam de fora sem --cores-extras.
const tiposSemBalde = new Map(tipos
  .map((t) => [t.id, [...new Set((t.printable_areas || []).map((a) => a.color?.name).filter((c) => !baldeDaCor(c)))]])
  .filter(([, cores]) => cores.length));

const noTeto = alvos.filter((pr) => (reaplicacoes.get(pr.id) || 0) >= MAX_REAPLICAR);
const semBalde = alvos.filter((pr) => !noTeto.includes(pr) && tiposSemBalde.has(donoDoId.get(pr.id).tipo));
const fila = alvos.filter((pr) => !noTeto.includes(pr) && !semBalde.includes(pr)).slice(0, LIMITE);

if (semBalde.length) {
  const porPeca = new Map();
  for (const pr of semBalde) { const t = donoDoId.get(pr.id).tipo; porPeca.set(t, (porPeca.get(t) || 0) + 1); }
  aviso(`${semBalde.length} preso(s) de peça com cor sem balde confirmado — ficam de fora (use --cores-extras):`);
  for (const [t, n] of porPeca) console.log(`     ${String(n).padStart(4)}  ${nomeTipo.get(t)}  (${tiposSemBalde.get(t).join(', ')})`);
}
if (noTeto.length) aviso(`${noTeto.length} já reaplicado(s) ${MAX_REAPLICAR}x sem destravar — análise manual: ${noTeto.slice(0, 10).map((p) => p.id).join(', ')}`);

if (!EXECUTAR) {
  console.log(`\n\x1b[36m${fila.length} produto(s) seriam destravados${LIMITE !== Infinity ? ` (limite ${LIMITE})` : ''}. Rode com --executar.\x1b[0m\n`);
  process.exit(0);
}
if (!fila.length) { console.log('\nNada a destravar.\n'); process.exit(0); }

// ── Destravar ───────────────────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1mDestravando ${fila.length} produto(s), concorrência ${CONCORRENCIA}\x1b[0m\n`);
const acervo = indexarAcervo();
const inicio = Date.now();
let feitos = 0, destravados = 0, continuam = 0, falhas = 0;

async function destravar(pr) {
  const { chave, tipo } = donoDoId.get(pr.id);
  const rotulo = `${nomeTipo.get(tipo)} :: ${pr.name}`;
  try {
    const item = acervo.get(chave);
    const r = item && resolverItem(item);
    if (!r || r.bloqueio) throw new Error(`item ${chave} não resolve no acervo: ${r?.bloqueio || 'ausente'}`);
    const { relido } = await reaplicarProduto(ink, { id: pr.id, modelo: r.modelo, arquivos: r.arquivos, tipos });
    fs.appendFileSync(ESTADO, `${JSON.stringify({ chave, fase: 'corrigido', modo: 'reaplicar', id: pr.id, tipo, antes: 'resizing', relido: relido.approval_status, em: new Date().toISOString() })}\n`);
    if (relido.approval_status === 'resizing') {
      continuam += 1;
      return `\x1b[33m~\x1b[0m ${rotulo} (${pr.id}) — reaplicado, ainda em resizing na releitura (confira depois)`;
    }
    destravados += 1;
    return `\x1b[32m✓\x1b[0m ${rotulo} (${pr.id}) — resizing → ${relido.approval_status}`;
  } catch (e) {
    falhas += 1;
    return `\x1b[31m✗\x1b[0m ${rotulo} (${pr.id}) — ${e.message}`;
  } finally {
    feitos += 1;
    if (feitos % 10 === 0 || feitos === fila.length) {
      const min = (Date.now() - inicio) / 60000;
      console.log(`  \x1b[2m[${feitos}/${fila.length}] ${destravados} destravado(s) · ${continuam} ainda resizing · ${falhas} falha(s) · ${(feitos / min).toFixed(1)}/min\x1b[0m`);
    }
  }
}

const pendentes = [...fila];
await Promise.all(Array.from({ length: CONCORRENCIA }, async () => {
  for (let pr = pendentes.shift(); pr; pr = pendentes.shift()) console.log('  ' + await destravar(pr));
}));

console.log(`\n\x1b[1mFim\x1b[0m  ${destravados} destravado(s) · ${continuam} ainda em resizing na releitura · ${falhas} falha(s)`);
if (continuam) console.log('  Os que ainda aparecem em resizing podem só estar processando — rode o relatório de novo em ~30 min.');
console.log();
