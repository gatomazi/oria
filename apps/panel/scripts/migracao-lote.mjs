#!/usr/bin/env node
// Executor do lote da migração Centro/Norte → Sul.
// Doc: docs/plano-migracao-criacao-produtos.md · Config: scripts/migracao-config.mjs
//
//   node scripts/migracao-lote.mjs --plano
//   node scripts/migracao-lote.mjs --plano --modelo=origem --uf=MS
//   INK_TOKEN_SUL=... node scripts/migracao-lote.mjs --executar --modelo=origem --uf=MS --limite=5
//   INK_TOKEN_SUL=... node scripts/migracao-lote.mjs --executar
//
// Em fases (a cópia pesa na fila de mockup da Ink; a Camiseta base não):
//   INK_TOKEN_SUL=... node scripts/migracao-lote.mjs --executar --fase=base
//   INK_TOKEN_SUL=... node scripts/migracao-lote.mjs --executar --copias=body
//   INK_TOKEN_SUL=... node scripts/migracao-lote.mjs --executar --copias=cropped
//   node scripts/migracao-lote.mjs --plano --copias=regata     (quantos faltam daquela peça)
//
// Retomável: cada item concluído é gravado em scripts/.migracao-estado.jsonl (append-only). Rodar
// de novo pula o que já passou. Estado em arquivo local de propósito — o job roda numa máquina só
// e assim não depende do Postgres nem cria tabela em produção.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MODELOS, REGIAO, TIPO_BASE, TIPOS_COPIA, CATEGORIA_FIXA, chaveIdem, tiposDoAgrupamento,
  indexarAcervo, resolverItem, categoriasDoItem, conferirLuminancia, norm,
  criarCliente, areasPorCor, montarArtGroups,
} from './migracao-config.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// Sobrescrevível só pra teste — em uso normal fica sempre no mesmo lugar (é a memória do lote).
const ESTADO = process.env.MIGRACAO_ESTADO || path.join(DIR, '.migracao-estado.jsonl');

const arg = (n, padrao) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] ?? padrao;
const PLANO = process.argv.includes('--plano');
const EXECUTAR = process.argv.includes('--executar');
// Só lista produtos com nome repetido na loja e sai. A API da Ink não tem DELETE de produto —
// a remoção é manual no painel, então o que dá pra automatizar é dizer exatamente qual apagar.
const DUPLICADOS = process.argv.some((a) => a === '--duplicados' || a.startsWith('--duplicados='));
// Pré-voo offline: mede a luminância de TODO o acervo contra a convenção de cada modelo. Roda sem
// token e sem tocar na Ink. Serve pra descobrir arquivo fora do padrão antes de começar, em vez
// de ver o item falhar no meio de uma corrida de dezenas de horas.
const CONFERIR_ARTES = process.argv.includes('--conferir-artes');
const FILTRO_DUP = arg('duplicados');
const FILTRO_MODELO = arg('modelo');
const FILTRO_UF = arg('uf')?.toUpperCase();
const LIMITE = Number(arg('limite', '0')) || Infinity;
// Cada criação carrega ~12 MB (a mesma arte repetida uma vez por base_image_id — a Ink exige uma
// entrada de `arts` por área). Concorrência 3 colocava ~36 MB simultâneos na rede e derrubava a
// conexão ("fetch failed"). Padrão 1; suba com cuidado e olhando a taxa de erro.
const CONCORRENCIA = Number(arg('concorrencia', '1'));
const PRECO = arg('preco') || process.env.MIGRACAO_PRECO || '109.90';

// Modo de execução:
//   completo (padrão) — Camiseta + as 9 cópias, item a item
//   base              — só a Camiseta
//   copia             — só UMA peça, e só pra itens que já têm Camiseta
// Faseado a pedido em 15/09: a fila de mockup da Ink travou duas vezes com as cópias, e a
// Camiseta base nunca passou por resizing. Assim cada peça sobe separada e dá pra ver se a Ink
// aguenta antes de soltar a próxima.
const FASE = arg('fase');
const COPIAS = arg('copias');
if (FASE && COPIAS) { console.error('use --fase=base OU --copias=<peça>, não os dois'); process.exit(1); }
if (FASE && FASE !== 'base') { console.error(`--fase só aceita "base" (veio "${FASE}")`); process.exit(1); }
const MODO = FASE === 'base' ? 'base' : COPIAS ? 'copia' : 'completo';

function resolverTipo(valor) {
  const alvo = norm(valor);
  const porId = TIPOS_COPIA.find((t) => String(t.id) === String(valor));
  if (porId) return porId;
  const exato = TIPOS_COPIA.find((t) => norm(t.nome) === alvo);
  if (exato) return exato;
  const parcial = TIPOS_COPIA.filter((t) => norm(t.nome).includes(alvo));
  if (parcial.length === 1) return parcial[0];
  const opcoes = TIPOS_COPIA.map((t) => `${t.nome} (${t.id})`).join(' · ');
  console.error(parcial.length
    ? `--copias=${valor} é ambíguo: ${parcial.map((t) => t.nome).join(', ')}. Use o nome completo ou o id.`
    : `--copias=${valor} não bate com nenhuma peça. Opções: ${opcoes}`);
  process.exit(1);
}
const TIPO_ALVO = MODO === 'copia' ? resolverTipo(COPIAS) : null;
const TIPOS_DA_RODADA = MODO === 'base' ? [] : MODO === 'copia' ? [TIPO_ALVO] : TIPOS_COPIA;

if (!PLANO && !EXECUTAR && !DUPLICADOS && !CONFERIR_ARTES) {
  console.error('use --plano · --conferir-artes · --duplicados · --executar');
  process.exit(1);
}
if ((EXECUTAR || DUPLICADOS) && !process.env.INK_TOKEN_SUL) { console.error('falta INK_TOKEN_SUL'); process.exit(1); }
const ink = (EXECUTAR || DUPLICADOS)
  ? criarCliente(process.env.INK_TOKEN_SUL, process.env.MIGRACAO_INK_BASE ? { base: process.env.MIGRACAO_INK_BASE } : {})
  : null;

if (DUPLICADOS) {
  const porNome = new Map();
  for (let p = 1; ; p += 1) {
    const d = await ink('GET', `/v1/stores/products?per_page=100&page=${p}`, null, { timeoutMs: 60000 });
    for (const pr of d.products || []) {
      const k = `${pr.product_type?.name || '?'} :: ${pr.name}`;
      porNome.set(k, [...(porNome.get(k) || []), pr.id].sort((a, b) => a - b));
    }
    if (p % 50 === 0) process.stdout.write(`\r  ${p}/${d.total_pages} páginas…`);
    if (p >= (d.total_pages || 1)) break;
  }
  if (FILTRO_DUP) {
    // Sonda: mostra TODOS os nomes que casam, duplicados ou não. É o que responde se o índice
    // enxerga produto recém-criado e oculto — sem isso a adoção não tem como funcionar.
    const casam = [...porNome.entries()].filter(([k]) => k.toLowerCase().includes(FILTRO_DUP.toLowerCase()));
    console.log(`\r\n${porNome.size} nome(s) no catálogo · ${casam.length} casam com "${FILTRO_DUP}"\n`);
    for (const [k, ids] of casam.sort()) console.log(`  ${ids.length}x  ${k}   ids: ${ids.join(', ')}`);
    console.log();
    process.exit(0);
  }
  const dups = [...porNome.entries()].filter(([, ids]) => ids.length > 1).sort();
  console.log(`\r\n${porNome.size} nome(s) no catálogo · ${dups.length} com duplicata\n`);
  let apagar = 0;
  for (const [k, ids] of dups) {
    apagar += ids.length - 1;
    console.log(`  ${k}\n     manter ${ids[0]}   APAGAR ${ids.slice(1).join(', ')}`);
  }
  console.log(`\n  ${apagar} produto(s) a apagar manualmente no painel da Ink (a API não tem DELETE).\n`);
  process.exit(0);
}

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const falha = (m) => console.log(`  \x1b[31m✗ ${m}\x1b[0m`);
const aviso = (m) => console.log(`  \x1b[33m! ${m}\x1b[0m`);

// ── Plano ────────────────────────────────────────────────────────────────────────────────────
const acervo = indexarAcervo();

if (CONFERIR_ARTES) {
  const alvos = [...acervo.values()]
    .filter((i) => (!FILTRO_MODELO || i.modelo === FILTRO_MODELO) && (!FILTRO_UF || i.uf === FILTRO_UF))
    .map((i) => resolverItem(i)).filter((r) => !r.bloqueio);
  console.log(`\nConferindo a luminância de ${alvos.length} item(ns) (${alvos.length * 2}–${alvos.length * 3} arquivos)…\n`);
  const t0 = Date.now();
  const fila = [...alvos];
  const ruins = [];
  let feitos = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (fila.length) {
      const it = fila.shift();
      const p = await conferirLuminancia(it.modelo, it.arquivos);
      if (p.length) { ruins.push({ it, p }); console.log(`  \x1b[31m✗\x1b[0m ${it.chave} — ${p.join('; ')}`); }
      feitos += 1;
      if (feitos % 500 === 0) {
        const s = (Date.now() - t0) / 1000;
        process.stdout.write(`\r  \x1b[2m${feitos}/${alvos.length} · ${(feitos / s).toFixed(0)}/s · restam ~${(((alvos.length - feitos) / (feitos / s)) / 60).toFixed(0)}min\x1b[0m`);
      }
    }
  }));
  process.stdout.write('\r');
  console.log(`\n${alvos.length} item(ns) · ${ruins.length} fora do padrão · ${((Date.now() - t0) / 60000).toFixed(1)}min\n`);
  process.exit(ruins.length ? 1 : 0);
}
const prontos = [];
const bloqueados = [];
for (const item of acervo.values()) {
  if (FILTRO_MODELO && item.modelo !== FILTRO_MODELO) continue;
  if (FILTRO_UF && item.uf !== FILTRO_UF) continue;
  const r = resolverItem(item);
  (r.bloqueio ? bloqueados : prontos).push(r.bloqueio ? { ...item, motivo: r.bloqueio } : r);
}
prontos.sort((a, b) => a.chave.localeCompare(b.chave));

// Gentílico não é único por cidade: "Formosense" serve Formosa E Formoso (GO); "Lagunense" serve
// Guia Lopes da Laguna E Laguna Carapã (MS). Nesses casos o nome do produto é o MESMO para duas
// cidades — legítimo (a loja já tem 97 casos assim), mas quebra qualquer dedup por nome: adotar
// pelo nome pegaria o produto da cidade errada. Esses itens dependem só do arquivo de estado.
const contagemNome = new Map();
for (const p of prontos) contagemNome.set(p.nome, (contagemNome.get(p.nome) || 0) + 1);
const nomesColidentes = new Set([...contagemNome].filter(([, n]) => n > 1).map(([n]) => n));

// Estado anterior
// O estado é append-only e gravado POR FASE, não só no fim. Um item leva ~10 chamadas e vários
// minutos: se só gravássemos ao concluir, uma queda no meio deixaria o produto criado na Ink e
// ausente do arquivo — e a rodada seguinte criaria tudo de novo. A Ink não deduplica por nome.
// Fases: 'criado' (produto base existe) · 'copia' (uma peça pronta) · 'concluido' · 'erro'.
const estado = new Map();
// Mesmo redutor pra leitura do arquivo e pra cada gravação durante a rodada: o estado em memória
// precisa refletir o progresso, senão um item que volta pro fim da fila (queda da Ink) recomeçaria
// do zero em vez de continuar das cópias que faltam.
function aplicarNoEstado(r) {
  const e = estado.get(r.chave) || { copias: new Map() };
  if (r.fase === 'criado') e.produtoId = r.produtoId;
  if (r.fase === 'copia') e.copias.set(r.tipo, r.id);
  if (r.fase === 'concluido') e.concluido = true;
  if (r.fase === 'reaberto') { e.concluido = false; e.produtoId = undefined; e.copias = new Map(); }
  if (r.fase === 'erro') e.erro = r.erro;
  estado.set(r.chave, e);
}
if (fs.existsSync(ESTADO)) {
  for (const linha of fs.readFileSync(ESTADO, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    let r; try { r = JSON.parse(linha); } catch { continue; }  // linha truncada por crash
    aplicarNoEstado(r);
  }
}
const precisa = {
  completo: (e) => !e?.concluido,
  base: (e) => !e?.produtoId,
  copia: (e) => !!e?.produtoId && !e.copias.has(TIPO_ALVO.id),
}[MODO];
const pendentes = prontos.filter((p) => precisa(estado.get(p.chave))).slice(0, LIMITE);
const retomaveis = MODO === 'completo' ? pendentes.filter((p) => estado.get(p.chave)?.produtoId).length : 0;
const semBase = MODO === 'copia' ? prontos.filter((p) => !estado.get(p.chave)?.produtoId).length : 0;

const modo = EXECUTAR ? '\x1b[31m[EXECUTA]\x1b[0m' : '\x1b[36m[plano, não escreve]\x1b[0m';
console.log(`\n\x1b[1mMIGRAÇÃO EM LOTE\x1b[0m  ${modo}`);
console.log(`\nacervo        ${acervo.size}`);
if (FILTRO_MODELO || FILTRO_UF) console.log(`filtro        ${FILTRO_MODELO || '*'} / ${FILTRO_UF || '*'}`);
console.log(`prontos       ${prontos.length}`);
// Conta só dentro do filtro atual — senão uma rodada de origem/MS apareceria no total de gentilicos.
console.log(`modo          ${MODO === 'copia' ? `cópia · ${TIPO_ALVO.nome} (${TIPO_ALVO.id})` : MODO}`);
console.log(`já concluídos ${prontos.filter((p) => estado.get(p.chave)?.concluido).length}  (Camiseta + 9 cópias)`);
console.log(`a processar   ${pendentes.length}${LIMITE !== Infinity ? `  (limite ${LIMITE})` : ''}`);
if (retomaveis) console.log(`  dos quais    ${retomaveis} já têm o produto base criado — retoma só as cópias que faltam`);
if (semBase) console.log(`  \x1b[2m(${semBase} item(ns) ainda sem Camiseta ficam de fora — rode --fase=base antes)\x1b[0m`);

// Placar por fase: o que já existe de cada peça, pra acompanhar o faseamento.
{
  const bases = prontos.filter((p) => estado.get(p.chave)?.produtoId).length;
  console.log(`\n\x1b[1mPlacar\x1b[0m  (de ${prontos.length} prontos)`);
  console.log(`  ${String(bases).padStart(5)}  Camiseta (base)`);
  for (const t of TIPOS_COPIA) {
    const n = prontos.filter((p) => estado.get(p.chave)?.copias.has(t.id)).length;
    console.log(`  ${String(n).padStart(5)}  ${t.nome}${TIPO_ALVO?.id === t.id ? '   ← esta rodada' : ''}`);
  }
}
console.log(`bloqueados    ${bloqueados.length}`);
if (nomesColidentes.size) {
  aviso(`${nomesColidentes.size} nome(s) servem mais de uma cidade — não entram na adoção por nome:`);
  for (const n of nomesColidentes) {
    console.log(`     ${n}  <-  ${prontos.filter((p) => p.nome === n).map((p) => p.cidade).join(', ')}`);
  }
}

if (bloqueados.length) {
  const porMotivo = {};
  for (const b of bloqueados) (porMotivo[b.motivo] ||= []).push(`${b.modelo}/${b.uf}/${b.cidadeArquivo}`);
  console.log('\n\x1b[1mBloqueados\x1b[0m');
  for (const [motivo, itens] of Object.entries(porMotivo)) {
    console.log(`  ${itens.length}x  ${motivo}`);
    for (const i of itens.slice(0, 8)) console.log(`        ${i}`);
    if (itens.length > 8) console.log(`        … +${itens.length - 8}`);
  }
}

// Categorias necessárias, geradas por combinatória (nunca lista colada — doc §4)
const nomesCategorias = [...new Set(prontos.flatMap((p) => p.categorias))].sort();
const estouradas = nomesCategorias.filter((n) => Buffer.byteLength(n) > 20);
console.log(`\ncategorias    ${nomesCategorias.length}  (maior: ${Math.max(...nomesCategorias.map((n) => Buffer.byteLength(n)))} bytes)`);
if (estouradas.length) { falha(`${estouradas.length} passam de 20 bytes: ${estouradas.slice(0, 3).join(' · ')}`); process.exit(1); }

const criacoesPrevistas = MODO === 'copia' ? 0 : pendentes.filter((p) => !estado.get(p.chave)?.produtoId).length;
const copiasPrevistas = pendentes.reduce((n, p) => n + TIPOS_DA_RODADA.filter((t) => !estado.get(p.chave)?.copias.has(t.id)).length, 0);
console.log(`chamadas      ${criacoesPrevistas} criações + ${copiasPrevistas} cópias = ${criacoesPrevistas + copiasPrevistas}`);

if (!EXECUTAR) {
  console.log('\n\x1b[36mPlano apenas. Rode com --executar para criar.\x1b[0m\n');
  process.exit(0);
}

// Append direto: usado antes do stream principal abrir (reconciliação roda na fase de índice).
const gravar0 = (r) => fs.appendFileSync(ESTADO, `${JSON.stringify({ ...r, em: new Date().toISOString() })}\n`);

// ── Execução ─────────────────────────────────────────────────────────────────────────────────
if (!pendentes.length) { console.log('\nNada a processar.\n'); process.exit(0); }

console.log('\n\x1b[1m1. Áreas de impressão\x1b[0m');
const tipos = (await ink('GET', '/v1/stores/product_types?per_page=100')).product_types || [];
const camiseta = tipos.find((t) => t.id === TIPO_BASE.id);
if (!camiseta) { falha('tipo Camiseta não encontrado'); process.exit(1); }
const areas = camiseta.printable_areas || [];
const porCor = areasPorCor(areas);
const modelosPeca = [...new Set(areas.map((a) => a.model).filter(Boolean))];
ok(`${areas.length} área(s) = ${modelosPeca.length} modelo(s) × ${porCor.size} cores`);

// Cobertura: a soma dos base_image_ids tem que bater com o total de áreas, senão metade das
// variantes sai sem arte (bug do piloto, doc §1.2).
const amostra = montarArtGroups(porCor, pendentes[0].arquivos, pendentes[0].modelo);
if (amostra.semCor.length) { falha(`cores ausentes na Camiseta: ${amostra.semCor.join(', ')}`); process.exit(1); }
const cobertura = amostra.grupos.reduce((n, g) => n + g.base_image_ids.length, 0);
if (cobertura !== areas.length) { falha(`cobriria ${cobertura} de ${areas.length} áreas — abortando`); process.exit(1); }
ok(`${cobertura}/${areas.length} áreas cobertas`);

// ── Índice do catálogo por nome ──────────────────────────────────────────────────────────────
// Rede de segurança independente do arquivo de estado E da idempotência da Ink: se um produto
// com esse nome já existe na loja, ele é ADOTADO em vez de criado de novo. Foi assim que a
// rodada de 12/09 duplicou (retry com Idempotency-Key novo a cada tentativa) — sem este índice,
// perder o .jsonl ou repetir uma falha de rede volta a duplicar. Custa ~630 requests uma vez.
console.log('\n\x1b[1m2. Indexando o catálogo da Sul por nome\x1b[0m');
const idsPorNome = new Map();
// NFC nos dois lados: "Água" pode vir composto (U+00C1) ou decomposto (A + acento). São strings
// diferentes para o ===, idênticas na tela — e a adoção falharia em silêncio em toda cidade
// acentuada, que é a maioria.
const chaveNome = (n) => String(n || '').normalize('NFC');
let totalListados = 0;
const idsNaLoja = new Set();
// Modo cópia não cria Camiseta: não precisa adotar por nome, e o índice custa ~865 páginas.
for (let p = 1; MODO !== 'copia'; p += 1) {
  const d = await ink('GET', `/v1/stores/products?per_page=100&page=${p}`, null, { timeoutMs: 60000 });
  for (const pr of d.products || []) {
    totalListados += 1;
    idsNaLoja.add(pr.id);
    if (pr.product_type?.id !== TIPO_BASE.id) continue;  // só a peça base; cópias têm o mesmo nome
    const k = chaveNome(pr.name);
    idsPorNome.set(k, [...(idsPorNome.get(k) || []), pr.id].sort((a, b) => a - b));
  }
  if (p % 100 === 0) process.stdout.write(`\r  \x1b[2m${p}/${d.total_pages} páginas…\x1b[0m`);
  if (p >= (d.total_pages || 1)) break;
}
process.stdout.write('\r');
if (MODO === 'copia') ok('modo cópia — índice por nome dispensado');
else ok(`${totalListados} produto(s) listado(s) · ${idsPorNome.size} nome(s) de Camiseta`);

// Nome repetido na loja nem sempre é duplicata: gentílico igual para cidades diferentes é
// legítimo e a loja já tinha 97 casos assim antes desta migração. Só reporta os que também
// aparecem no plano com nome único — esses sim seriam produto criado duas vezes.
// Reconciliação: o arquivo de estado pode afirmar "concluído" para produto que foi APAGADO à mão
// no painel depois (aconteceu em 12/09 com Anastácio e Anaurilândia, removidos junto com uma
// limpeza de duplicados). Sem isto, o item nunca mais seria criado e a cidade sumiria do catálogo
// sem nenhum aviso. O catálogo real manda, não o arquivo.
const sumiram = prontos.filter((p) => {
  const e = estado.get(p.chave);
  // Qualquer item com Camiseta registrada (não só os concluídos): no faseamento a base existe
  // muito antes de o item fechar. Sem índice (modo cópia) não há como conferir — pula.
  return MODO !== 'copia' && e?.produtoId && !idsNaLoja.has(e.produtoId);
});
if (sumiram.length) {
  aviso(`${sumiram.length} item(ns) marcados como concluídos NÃO existem mais na loja — serão recriados:`);
  for (const p of sumiram.slice(0, 15)) console.log(`     ${p.modelo}/${p.uf}/${p.cidade}  (id ${estado.get(p.chave).produtoId})`);
  if (sumiram.length > 15) console.log(`     … +${sumiram.length - 15}`);
  for (const p of sumiram) {
    estado.delete(p.chave);
    gravar0({ chave: p.chave, fase: 'reaberto', motivo: 'produto ausente do catálogo' });
    pendentes.push(p);
  }
  console.log(`     \x1b[2ma processar passou de ${pendentes.length - sumiram.length} para ${pendentes.length}\x1b[0m`);
}

const duplicados = [...idsPorNome.entries()]
  .filter(([nome, ids]) => ids.length > 1 && contagemNome.get(nome) === 1);
if (duplicados.length) {
  aviso(`${duplicados.length} nome(s) do plano com produto repetido na loja (provável duplicata):`);
  for (const [nome, ids] of duplicados.slice(0, 20)) {
    console.log(`     ${nome}  →  fica ${ids[0]} · apagar no painel: ${ids.slice(1).join(', ')}`);
  }
  if (duplicados.length > 20) console.log(`     … +${duplicados.length - 20}`);
  console.log('     \x1b[2m(a API da Ink não tem DELETE de produto — a remoção é manual no painel)\x1b[0m');
}

console.log('\n\x1b[1m3. Categorias\x1b[0m');
const existentes = [];
for (let p = 1; ; p += 1) {
  const d = await ink('GET', `/v1/stores/collections?per_page=100&page=${p}`);
  existentes.push(...(d.collections || []));
  if (p >= (d.total_pages || 1)) break;
}
const idPorCategoria = new Map(existentes.map((c) => [c.name, c.id]));
let criadas = 0;
for (const nome of nomesCategorias) {
  if (idPorCategoria.has(nome)) continue;
  let c;
  try {
    c = (await ink('POST', '/v1/stores/collections', { name: nome, is_available: false }, { idem: chaveIdem('categoria', nome) })).collection;
  } catch (e) {
    if (!e.idemIndeterminada) throw e;
    // Tentativa anterior indeterminada: relista e procura antes de mandar chave nova.
    for (let p = 1; !c; p += 1) {
      const d = await ink('GET', `/v1/stores/collections?per_page=100&page=${p}`);
      c = (d.collections || []).find((x) => x.name === nome);
      if (p >= (d.total_pages || 1)) break;
    }
    c ||= (await ink('POST', '/v1/stores/collections', { name: nome, is_available: false }, { idem: chaveIdem('categoria', nome, 'nova', Date.now()) })).collection;
  }
  if (c.name !== nome) { falha(`a Ink gravou "${c.name}" em vez de "${nome}" — abortando`); process.exit(1); }
  idPorCategoria.set(nome, c.id);
  criadas += 1;
}
ok(`${existentes.length} já existiam · ${criadas} criada(s) · ${nomesCategorias.length} em uso`);

console.log(`\n\x1b[1m4. Processando ${pendentes.length} item(ns), concorrência ${CONCORRENCIA}\x1b[0m\n`);
const fluxo = fs.createWriteStream(ESTADO, { flags: 'a' });
const inicio = Date.now();
let n = 0, sucessos = 0, falhas = 0;

// A Ink RECEBE e CRIA o produto, mas a resposta se perde: processar as 18 artes demora e a conexão
// cai antes do retorno ("fetch failed"). Visto em 12/09 com concorrência 2 e 3. Repetir o POST às
// cegas depende de a Ink honrar o Idempotency-Key; em vez de apostar nisso, depois de erro de
// REDE (sem status HTTP) procura o produto antes de tentar de novo.
// A API não filtra por nome, mas filtra por data de criação — produtos de hoje são poucas páginas.
async function acharCriadoHoje(nome) {
  // Desde ONTEM: a data vem em UTC e a loja está em UTC-3 — um produto criado às 22h de Brasília
  // já é "amanhã" em UTC. Uma página a mais de busca é barato; perder o produto é duplicata.
  const hoje = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const alvo = chaveNome(nome);
  const achados = [];
  for (let p = 1; ; p += 1) {
    const d = await ink('GET', `/v1/stores/products?per_page=100&page=${p}&begin_date=${hoje}`, null, { timeoutMs: 60000 });
    for (const pr of d.products || []) {
      if (pr.product_type?.id === TIPO_BASE.id && chaveNome(pr.name) === alvo) achados.push(pr);
    }
    if (p >= (d.total_pages || 1)) break;
  }
  return achados.sort((a, b) => a.id - b.id);
}

// Dono de cada produto base conhecido (estado + criados nesta rodada). Serve pra adoção por nome
// não pegar o produto de OUTRA cidade quando o nome se repete (gentílico).
const donoDoProduto = new Map([...estado].filter(([, e]) => e.produtoId).map(([k, e]) => [e.produtoId, k]));

async function criarProdutoSemDuplicar(item, body) {
  let idem = chaveIdem('produto', item.chave);
  for (let t = 1; t <= 4; t += 1) {
    try {
      return { produto: (await ink('POST', '/v1/stores/products', body, { idem })).product, adotado: false };
    } catch (e) {
      // Erro HTTP comum é resposta real da Ink: não houve criação escondida.
      if (e.status && !e.idemIndeterminada) throw e;
      // Rede caiu OU a Ink recusou a chave por tentativa anterior indeterminada. Nos dois casos o
      // produto pode existir: espera o processamento assentar e confere antes de insistir.
      await new Promise((r) => setTimeout(r, (e.idemIndeterminada ? 5000 : 15000) * t));
      const achados = (await acharCriadoHoje(item.nome))
        .filter((pr) => !donoDoProduto.has(pr.id) || donoDoProduto.get(pr.id) === item.chave);
      if (achados.length) {
        if (achados.length > 1) {
          aviso(`${item.nome}: ${achados.length} produtos criados — adotando ${achados[0].id}, apagar no painel: ${achados.slice(1).map((a) => a.id).join(', ')}`);
        }
        return { produto: achados[0], adotado: true };
      }
      // Não criou. Chave antiga está queimada pra Ink: só aqui, depois de conferir, gera outra.
      if (e.idemIndeterminada) idem = chaveIdem('produto', item.chave, 'nova', Date.now());
      if (t === 4) throw e;
    }
  }
}

async function copiarSemDuplicar(chave, produtoId, tipo, conhecidos) {
  let idem = chaveIdem('copia', chave, tipo);
  for (let t = 1; t <= 3; t += 1) {
    try {
      const c = await comRetry(() => ink('POST', `/v1/stores/products/${produtoId}/copy`,
        { product_type_id: tipo, include_categories: true }, { idem }));
      return { id: c.product.id, adotada: false };
    } catch (e) {
      if (!e.idemIndeterminada) throw e;
      // A cópia entra no agrupamento do produto de origem: se o tipo já está lá, a tentativa
      // anterior copiou e só a resposta se perdeu.
      await new Promise((r) => setTimeout(r, 5000 * t));
      const noGrupo = await tiposDoAgrupamento(ink, produtoId, conhecidos);
      const ids = noGrupo.get(tipo) || [];
      if (ids.length) return { id: ids[0], adotada: true };
      idem = chaveIdem('copia', chave, tipo, 'nova', Date.now());
      if (t === 3) throw e;
    }
  }
}

async function comRetry(fn, tentativas = 3) {
  for (let t = 1; ; t += 1) {
    try { return await fn(); }
    catch (e) {
      // 4xx que não seja 429 é erro de dado, não de rede: repetir só gasta chamada.
      if (t >= tentativas || (e.status >= 400 && e.status < 500 && e.status !== 429)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** t));
    }
  }
}

function gravar(registro) {
  fluxo.write(`${JSON.stringify({ ...registro, em: new Date().toISOString() })}\n`);
  aplicarNoEstado(registro);
}

// ── Queda da Ink ────────────────────────────────────────────────────────────────────────────
// Na madrugada de 14/09 a Ink respondeu 500 em todo POST /products por ~8h. Cada falha era
// rápida, e o lote passou por ~2.400 itens só marcando erro. Agora: falha de servidor devolve o
// item pro fim da fila, e N falhas seguidas PAUSAM todos os workers até a Ink responder de novo.
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIAR_QUEDA = 8;        // falhas de servidor seguidas (sem nenhum sucesso no meio)
const MAX_VOLTAS_ITEM = 4;     // quantas vezes um mesmo item volta pra fila nesta rodada
let falhasServidorSeguidas = 0;
let pausasSeguidas = 0;
let pausaEmCurso = null;
const voltasPorItem = new Map();

const ehFalhaDeServidor = (e) => !e.status || e.status >= 500 || [408, 429, 499].includes(e.status);

async function aguardarInk() {
  if (falhasServidorSeguidas < LIMIAR_QUEDA) return;
  pausaEmCurso ||= (async () => {
    for (;;) {
      pausasSeguidas += 1;
      const min = Math.min(15, 2 * pausasSeguidas);
      console.log(`\n  \x1b[33m⏸ Ink instável: ${falhasServidorSeguidas} falhas de servidor seguidas — pausando ${min} min (pausa ${pausasSeguidas})\x1b[0m`);
      await dormir(min * Number(process.env.MIGRACAO_MINUTO_MS || 60000));
      try {
        await ink('GET', '/v1/stores/product_types?per_page=1', null, { timeoutMs: 30000 });
        break;
      } catch (e) {
        console.log(`  \x1b[33m⏸ ainda fora: ${e.message.slice(0, 90)}\x1b[0m`);
      }
    }
    falhasServidorSeguidas = 0;
    pausaEmCurso = null;
    console.log('  \x1b[32m▶ Ink respondendo — retomando\x1b[0m\n');
  })();
  await pausaEmCurso;
}

async function processar(item) {
  const rotulo = `${item.modelo}/${item.uf}/${item.cidade}`;
  let voltou = false;
  const anterior = estado.get(item.chave) || { copias: new Map() };
  try {
    let produtoId = anterior.produtoId;
    let origem = produtoId ? 'retomado' : null;

    // Nome já no catálogo = produto criado numa rodada anterior (inclusive uma que falhou depois
    // de criar). Adota o menor id e segue pras cópias; nunca cria um segundo com o mesmo nome.
    // Só adota quando o nome identifica UM produto sem ambiguidade: nome único no plano (senão
    // adotaria o da cidade vizinha) e um único id na loja.
    // Nome que serve duas cidades (gentílico) nunca é adotado: pegaria o produto da vizinha.
    // Para os demais, mais de um id na loja é duplicata de uma falha de rede anterior — adota o
    // menor e aponta os outros. Exigir exatamente 1 fazia o script criar um QUARTO produto.
    const candidatos = nomesColidentes.has(item.nome) ? [] : (idsPorNome.get(chaveNome(item.nome)) || []);
    if (!produtoId && candidatos.length) {
      produtoId = candidatos[0];
      origem = 'adotado';
      if (candidatos.length > 1) {
        aviso(`${item.nome}: ${candidatos.length} na loja — adotando ${candidatos[0]}, apagar no painel: ${candidatos.slice(1).join(', ')}`);
      }
      gravar({ chave: item.chave, fase: 'criado', nome: item.nome, produtoId, adotado: true });
    }

    if (produtoId) {
      /* já existe: nunca recriar */
    } else if (MODO === 'copia') {
      throw new Error('sem Camiseta base registrada — rode --fase=base antes');
    } else {
      const problemas = await conferirLuminancia(item.modelo, item.arquivos);
      if (problemas.length) throw new Error(`luminância: ${problemas.join('; ')}`);

      const { grupos } = montarArtGroups(porCor, item.arquivos, item.modelo);
      const arts = grupos.flatMap((g) => g.base_image_ids.map((base_image_id) => ({
        base_image_id, art_attachment: fs.readFileSync(g.arquivo).toString('base64'),
      })));
      if (arts.length !== areas.length) throw new Error(`cobriria ${arts.length} de ${areas.length} áreas`);

      // Chave derivada do item: as 3 tentativas do comRetry mandam a MESMA, e a Ink devolve o
      // produto já criado em vez de criar outro.
      const { produto: base, adotado } = await criarProdutoSemDuplicar(item, {
        product_type_id: TIPO_BASE.id, name: item.nome, price: PRECO, visible_in_store: false,
        collections: item.categorias.map((c) => idPorCategoria.get(c)), arts,
      });
      produtoId = base.id;
      if (adotado) origem = 'recuperado após falha de rede';
      // Grava ANTES das cópias: a partir daqui o produto existe na Ink e não pode ser recriado.
      gravar({ chave: item.chave, fase: 'criado', nome: item.nome, produtoId, cluster: base.product_cluster_id });
      donoDoProduto.set(produtoId, item.chave);
    }

    const feitas = new Map(anterior.copias);
    let recuperadas = 0;
    for (const t of TIPOS_DA_RODADA) {
      if (feitas.has(t.id)) continue;
      const conhecidos = new Map([...feitas].map(([tipo, id]) => [id, tipo]));
      const c = await copiarSemDuplicar(item.chave, produtoId, t.id, conhecidos);
      if (c.adotada) recuperadas += 1;
      feitas.set(t.id, c.id);
      gravar({ chave: item.chave, fase: 'copia', tipo: t.id, id: c.id, ...(c.adotada ? { adotada: true } : {}) });
    }
    if (recuperadas) origem = [origem, `${recuperadas} cópia(s) recuperada(s) após 409`].filter(Boolean).join(', ');

    // Concluído = Camiseta + as 9 peças, venha de uma rodada completa ou da última fase.
    const completo = TIPOS_COPIA.every((t) => feitas.has(t.id));
    if (completo && !anterior.concluido) gravar({ chave: item.chave, fase: 'concluido', produtoId });
    sucessos += 1;
    falhasServidorSeguidas = 0;
    pausasSeguidas = 0;
    const oQue = MODO === 'base' ? 'Camiseta' : MODO === 'copia' ? `${TIPO_ALVO.nome} ${feitas.get(TIPO_ALVO.id)}` : `${feitas.size} cópias`;
    return `\x1b[32m✓\x1b[0m ${rotulo} → ${produtoId} (${oQue}${origem ? `, ${origem}` : ''}${completo ? ' · item completo' : ''})`;
  } catch (e) {
    if (ehFalhaDeServidor(e)) {
      falhasServidorSeguidas += 1;
      const voltas = (voltasPorItem.get(item.chave) || 0) + 1;
      voltasPorItem.set(item.chave, voltas);
      if (voltas < MAX_VOLTAS_ITEM) {
        // Não é erro do item, é a Ink: volta pro fim da fila e continua de onde parou.
        fila.push(item);
        voltou = true;
        return `\x1b[33m↻\x1b[0m ${rotulo} — ${e.message.slice(0, 90)} (volta pra fila, ${voltas}/${MAX_VOLTAS_ITEM - 1})`;
      }
    }
    gravar({ chave: item.chave, fase: 'erro', nome: item.nome, erro: e.message });
    falhas += 1;
    return `\x1b[31m✗\x1b[0m ${rotulo} — ${e.message}`;
  } finally {
    // Item que voltou pra fila não conta no progresso (senão passaria de 100%). Sem `return` aqui:
    // return em finally sobrescreveria a linha de saída do catch.
    if (!voltou) n += 1;
    if (!voltou && (n % 10 === 0 || n === pendentes.length)) {
      const decorrido = (Date.now() - inicio) / 1000;
      const restam = ((decorrido / n) * (pendentes.length - n)) / 3600;
      console.log(`  \x1b[2m[${n}/${pendentes.length}] ${sucessos} ok · ${falhas} falha(s) · ${(n / decorrido * 60).toFixed(1)}/min · restam ~${restam.toFixed(1)}h\x1b[0m`);
    }
  }
}

const fila = [...pendentes];
await Promise.all(Array.from({ length: CONCORRENCIA }, async () => {
  while (fila.length) {
    await aguardarInk();
    const item = fila.shift();
    if (!item) break;  // outro worker pegou o último durante a pausa
    console.log('  ' + await processar(item));
  }
}));

fluxo.end();
console.log(`\n\x1b[1mFim\x1b[0m  ${sucessos} criado(s) · ${falhas} falha(s) · ${((Date.now() - inicio) / 3600000).toFixed(2)}h`);
if (falhas) console.log(`  Rode de novo para retentar só o que falhou (estado em ${path.basename(ESTADO)}).`);
