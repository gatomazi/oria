#!/usr/bin/env node
// Piloto da migração Centro/Norte → Sul: cria UM produto de ponta a ponta e confere tudo que o
// lote depende (doc: docs/plano-migracao-criacao-produtos.md, Passo 0).
//
// Roda local, porque o acervo de artes (8 GB) só existe na máquina do operador.
//
//   INK_TOKEN_SUL=... node scripts/migracao-piloto.mjs feito_em/MS/bodoquena
//   INK_TOKEN_SUL=... node scripts/migracao-piloto.mjs origem/MS/bodoquena --executar
//
// Sem --executar não escreve NADA: só resolve, mostra o que faria e roda as checagens de leitura
// (tipos, cores, limite de nome de categoria). Com --executar, cria categorias + 1 produto oculto
// + as 9 cópias, e relê tudo pra conferir.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const INK = 'https://api.reserva.ink';  // mesmo INK_API_BASE de server.js:54
const TOKEN = process.env.INK_TOKEN_SUL;
const ARTES = process.env.MIGRACAO_ARTES_DIR || '/Users/gtomazi/projects/arte-lojas/migracao-useorigens';
const GENTILICOS = process.env.MIGRACAO_GENTILICOS_DIR || '/Users/gtomazi/projects/pontos-turisticos';

// A Ink EXIGE `price` no POST /products (só o /copy aceita omitir e cair no padrão da loja).
// 109.90 é o preço de 7.304 dos 7.313 produtos Camiseta da Sul hoje — é o padrão da loja.
const PRECO_BASE = (process.argv.find((a) => a.startsWith('--preco=')) || '').split('=')[1]
  || process.env.MIGRACAO_PRECO || '109.90';

const alvo = process.argv[2];
const EXECUTAR = process.argv.includes('--executar');
// --corrigir=<id>: em vez de criar, faz PATCH das artes num produto que já existe e refaz as 9
// cópias. `arts` faz upsert por base_image_id, e /copy substitui no grupo o produto que já ocupava
// o tipo de destino — então conserta um produto publicado incompleto sem deixar lixo pra trás.
const CORRIGIR = Number((process.argv.find((a) => a.startsWith('--corrigir=')) || '').split('=')[1]) || null;
if (!TOKEN) { console.error('falta INK_TOKEN_SUL no ambiente'); process.exit(1); }
if (!alvo || alvo.split('/').length !== 3) {
  console.error('uso: node scripts/migracao-piloto.mjs {modelo}/{UF}/{cidade_do_arquivo} [--executar]');
  process.exit(1);
}

// ── Configuração (espelha docs/plano-migracao-criacao-produtos.md §2.3, §3, §4) ──────────────
const CORES_ESCURAS = ['Bordeaux', 'Vermelho', 'Marinho', 'Preta', 'Verde'];
const CORES_CLARAS = ['Cinza', 'Rosa', 'Branca'];
const COR_AMARELO = 'Amarelo';

// `sufixos` = qual arquivo serve cada balde de cor. Nos 6 primeiros o sufixo nomeia a cor da ARTE;
// em gentilicos/feito_em nomeia a cor da PEÇA — por isso invertido. Medido na luminância real do
// acervo; aplicar a regra global inverteria 1.870 produtos (doc §2.2).
const MODELOS = {
  coordenadas: { token: 'coord', nome: (c, uf) => `${c} | Coordenadas ${uf}`, cat: 'COORD', sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  legado:      { token: 'arte',  nome: (c, uf) => `${c} | Legado ${uf}`,      cat: 'LEG',   sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  origem:      { token: 'arte',  nome: (c, uf) => `${c} | Origem ${uf}`,      cat: 'ORIG',  sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  territorio:  { token: 'arte',  nome: (c, uf) => `${c} | Território ${uf}`,  cat: 'TERR',  sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  tipografia:  { token: 'arte',  nome: (c, uf) => `${c} | Tipografia ${uf}`,  cat: 'TIPOG', sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  traco:       { token: 'arte',  nome: (c, uf) => `${c} | Traço ${uf}`,       cat: 'TRACO', sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  gentilicos:  { token: null,    nome: (c, uf, g) => `${g} | Gentílico ${uf}`, cat: 'GENT', sufixos: { escuras: 'preto', claras: 'branco', amarelo: 'branco' } },
  feito_em:    { token: null,    nome: (c, uf) => `Feito em ${c} ${uf}`,      cat: 'FEITO', sufixos: { escuras: 'preto', claras: 'branco', amarelo: 'amarelo' } },
};
const REGIAO = { MT: 'CO', MS: 'CO', GO: 'CO', DF: 'CO', AC: 'NO', AM: 'NO', AP: 'NO', PA: 'NO', RO: 'NO', RR: 'NO', TO: 'NO' };

// Camiseta é a base; as 9 abaixo recebem /copy. IDs conferidos no cache do catálogo da Sul.
const TIPO_BASE = { id: 1, nome: 'Camiseta' };
const TIPOS_COPIA = [
  { id: 165, nome: 'Body Infantil' }, { id: 72, nome: 'Camiseta Algodão Peruano' },
  { id: 2, nome: 'Camiseta Infantil' }, { id: 178, nome: 'Camiseta Oversized' },
  { id: 23, nome: 'Cropped' }, { id: 28, nome: 'Cropped Moletom' },
  { id: 119, nome: 'Hoodie Moletom' }, { id: 8, nome: 'Regata' }, { id: 120, nome: 'Suéter Moletom' },
];

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function ink(metodo, rota, body) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (body) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = crypto.randomUUID(); }
  const res = await fetch(INK + rota, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) });
  const txt = await res.text();
  let data; try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 400) }; }
  if (!res.ok) throw new Error(`${metodo} ${rota} -> ${res.status}: ${(data.errors || []).join('; ') || data.error || JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const falha = (m) => console.log(`  \x1b[31m✗ ${m}\x1b[0m`);
const aviso = (m) => console.log(`  \x1b[33m! ${m}\x1b[0m`);

// ── 1. Resolver o item a partir do acervo ────────────────────────────────────────────────────
const [modelo, uf, cidadeArq] = alvo.split('/');
const cfg = MODELOS[modelo];
if (!cfg) { console.error(`modelo inválido: ${modelo}`); process.exit(1); }

const dir = path.join(ARTES, modelo, uf);
const arquivos = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.png')) continue;
  const p = f.slice(0, -4).split('_');
  const sufixo = p[p.length - 1];
  const corte = cfg.token && p.length > 2 && p[p.length - 2] === cfg.token ? 2 : 1;
  if (norm(p.slice(0, p.length - corte).join('_')) !== norm(cidadeArq)) continue;
  if (!arquivos[sufixo] || f.includes("'")) arquivos[sufixo] = path.join(dir, f);
}

const gent = JSON.parse(fs.readFileSync(path.join(GENTILICOS, `gentilicos_${uf.toLowerCase()}.json`), 'utf8'));
const entrada = gent.find((x) => norm(x.municipio) === norm(cidadeArq));
if (!entrada) { console.error(`cidade "${cidadeArq}" não está em gentilicos_${uf.toLowerCase()}.json`); process.exit(1); }
// Gentílico com hífen preservado, cada palavra capitalizada (confirmado 12/09).
const gentilico = entrada.gentilico.split(/([ -])/).map((t) => (/[ -]/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1))).join('');
const nomeProduto = cfg.nome(entrada.municipio, uf, gentilico);
const reg = REGIAO[uf];
const categorias = [`ZZ - ${reg}`, `ZZ - ${reg} - ${uf}`, `ZZ - ${reg} - ${cfg.cat}`, `ZZ - ${reg} - ${cfg.cat} - ${uf}`, 'Seu Lugar'];

console.log(`\n\x1b[1mPILOTO — ${alvo}\x1b[0m  ${EXECUTAR ? '\x1b[31m[EXECUTA E ESCREVE]\x1b[0m' : '\x1b[36m[simulação, não escreve]\x1b[0m'}`);
console.log(`\nmunicípio  ${entrada.municipio}   gentílico  ${gentilico}`);
console.log(`nome       ${nomeProduto}`);
console.log(`preço      R$ ${PRECO_BASE}  (cópias herdam o padrão da loja por tipo)`);
console.log('categorias');
for (const c of categorias) {
  const b = Buffer.byteLength(c);
  console.log(`   ${b <= 20 ? '\x1b[32m' : '\x1b[31m'}${String(b).padStart(2)}b\x1b[0m  ${c}`);
}
console.log('artes');
for (const [balde, sufixo] of Object.entries(cfg.sufixos)) {
  console.log(`   ${balde.padEnd(8)} <- ${arquivos[sufixo] ? path.basename(arquivos[sufixo]) : '\x1b[31mFALTANDO\x1b[0m'}`);
}
if (Object.values(cfg.sufixos).some((s) => !arquivos[s])) { falha('arte faltando, abortando'); process.exit(1); }

// 7 cidades de `tipografia` só existem na grafia SEM apóstrofo, e nessa versão o apóstrofo some
// também da estampa ("MIRASSOL D OESTE" em vez de "MIRASSOL D'OESTE") — doc §2.4. Publicar erro
// de grafia no nome da cidade é pior que não publicar: bloqueia até a arte ser regerada.
const TIPOGRAFIA_ARTE_DEFEITUOSA = new Set([
  'GO/saojoaodalianca', 'GO/sitiodabadia', 'MT/conquistadoeste', 'MT/figueiropolisdoeste',
  'MT/gloriadoeste', 'MT/lambaridoeste', 'MT/mirassoldoeste',
]);
if (modelo === 'tipografia' && TIPOGRAFIA_ARTE_DEFEITUOSA.has(`${uf}/${norm(cidadeArq)}`)) {
  falha(`arte de tipografia defeituosa (apóstrofo ausente na estampa) — regerar antes de publicar`);
  process.exit(1);
}

// ── 2. Áreas de impressão da Camiseta ────────────────────────────────────────────────────────
console.log('\n\x1b[1m1. Áreas de impressão (base_image_id por cor)\x1b[0m');
const tipos = (await ink('GET', '/v1/stores/product_types?per_page=100')).product_types || [];
const camiseta = tipos.find((t) => t.id === TIPO_BASE.id);
if (!camiseta) { falha('tipo Camiseta (id 1) não encontrado nesta loja'); process.exit(1); }
const areas = camiseta.printable_areas || [];
// ATENÇÃO: existe UMA ÁREA POR (MODELO, COR) — a Camiseta tem 18 áreas = 9 cores × 2 modelos
// (Baby Look Feminino e Clássica Masculina). Indexar por cor sozinha sobrescreve um modelo pelo
// outro e publica o produto com arte em metade das variantes (bug real do piloto, 12/09: saiu só
// na Baby Look). A chave é a cor, mas o valor é a LISTA de base_image_id daquela cor.
const modelos = [...new Set(areas.map((a) => a.model).filter(Boolean))];
ok(`${camiseta.name}: ${areas.length} área(s) = ${modelos.length} modelo(s) × cores`);
if (modelos.length) console.log(`   modelos: ${modelos.join(', ')}`);
const porCor = new Map();
for (const a of areas) {
  if (!a.color?.name) continue;
  porCor.set(a.color.name, [...(porCor.get(a.color.name) || []), a.base_image_id]);
}
console.log('   cores:', [...porCor.keys()].join(', '));
for (const [cor, ids] of porCor) {
  if (ids.length !== modelos.length) aviso(`cor "${cor}" tem ${ids.length} área(s), esperado ${modelos.length} (uma por modelo)`);
}

const baldes = { escuras: CORES_ESCURAS, claras: CORES_CLARAS, amarelo: [COR_AMARELO] };
const artGroups = [];
let faltouCor = false;
for (const [balde, cores] of Object.entries(baldes)) {
  const ids = [];
  for (const cor of cores) {
    const doCor = porCor.get(cor);
    if (!doCor || !doCor.length) { falha(`cor "${cor}" não existe nas áreas da Camiseta`); faltouCor = true; continue; }
    ids.push(...doCor);  // todas as áreas da cor = todos os modelos
  }
  if (!ids.length) continue;
  const arquivo = arquivos[cfg.sufixos[balde]];
  artGroups.push({ base_image_ids: ids, arquivo, balde, cores: cores.join(', ') });
}
if (faltouCor) { falha('mapeamento de cor incompleto, abortando'); process.exit(1); }
for (const g of artGroups) ok(`${g.balde.padEnd(8)} ${g.cores}  ->  ${path.basename(g.arquivo)}  [${g.base_image_ids.join(',')}]`);
const totalAreas = artGroups.reduce((n, g) => n + g.base_image_ids.length, 0);
totalAreas === areas.length
  ? ok(`${totalAreas} de ${areas.length} áreas cobertas — nenhuma variante fica sem arte`)
  : falha(`só ${totalAreas} de ${areas.length} áreas cobertas — ${areas.length - totalAreas} variante(s) sairiam SEM arte`);

// ── 3. Cores dos 9 tipos de destino (a cópia exige a estampa nas cores do destino) ───────────
console.log('\n\x1b[1m2. Paleta dos 9 tipos de destino\x1b[0m');
const coresCamiseta = new Set(porCor.keys());
for (const t of TIPOS_COPIA) {
  const tt = tipos.find((x) => x.id === t.id);
  if (!tt) { falha(`${t.nome} (id ${t.id}) não existe nesta loja`); continue; }
  const cores = [...new Set((tt.printable_areas || []).map((a) => a.color?.name).filter(Boolean))];
  const extras = cores.filter((c) => !coresCamiseta.has(c));
  const faltando = [...coresCamiseta].filter((c) => !cores.includes(c));
  const msg = `${t.nome.padEnd(26)} ${String(cores.length).padStart(2)} cor(es)`;
  if (!extras.length && !faltando.length) ok(`${msg}  idêntica à Camiseta`);
  else aviso(`${msg}  só no destino: [${extras.join(', ') || '—'}]  sem arte: [${faltando.join(', ') || '—'}]`);
}

if (!EXECUTAR) {
  console.log('\n\x1b[36mSimulação encerrada. Rode com --executar para criar de verdade.\x1b[0m\n');
  process.exit(0);
}

// ── 4. Categorias: cria e confere o nome que a Ink REALMENTE gravou ──────────────────────────
console.log('\n\x1b[1m3. Categorias — teste do limite de 20 caracteres\x1b[0m');
const existentes = [];
for (let pagina = 1; ; pagina += 1) {
  const d = await ink('GET', `/v1/stores/collections?per_page=100&page=${pagina}`);
  existentes.push(...(d.collections || []));
  if (pagina >= (d.total_pages || 1)) break;
}
ok(`${existentes.length} categoria(s) já na loja`);
const porNome = new Map(existentes.map((c) => [c.name, c.id]));
const idsCategorias = [];
for (const nome of categorias) {
  let id = porNome.get(nome);
  if (id) { ok(`já existe  "${nome}"  (id ${id})`); idsCategorias.push(id); continue; }
  const criada = (await ink('POST', '/v1/stores/collections', { name: nome, is_available: false })).collection;
  idsCategorias.push(criada.id);
  if (criada.name === nome) ok(`criada     "${criada.name}"  (id ${criada.id})`);
  else falha(`TRUNCOU!   pedi "${nome}" (${nome.length}ch) e a Ink gravou "${criada.name}" (${criada.name.length}ch)`);
}

// ── 5. O produto ─────────────────────────────────────────────────────────────────────────────
const arts = artGroups.flatMap((g) => g.base_image_ids.map((base_image_id) => ({
  base_image_id, art_attachment: fs.readFileSync(g.arquivo).toString('base64'),
})));

let criado;
if (CORRIGIR) {
  console.log(`\n\x1b[1m4. Corrigindo as artes do produto ${CORRIGIR}\x1b[0m`);
  criado = (await ink('PATCH', `/v1/stores/products/${CORRIGIR}`, { arts, visible_in_store: false })).product;
  ok(`${arts.length} área(s) reenviadas para "${criado.name}"`);
} else {
  console.log('\n\x1b[1m4. Criando o produto (oculto)\x1b[0m');
  criado = (await ink('POST', '/v1/stores/products', {
    product_type_id: TIPO_BASE.id,
    name: nomeProduto,
    price: PRECO_BASE,
    visible_in_store: false,
    collections: idsCategorias,
    arts,
  })).product;
  ok(`id ${criado.id}  "${criado.name}"`);
}

console.log('\n\x1b[1m5. Relendo o produto\x1b[0m');
const lido = (await ink('GET', `/v1/stores/products/${criado.id}`)).product;
lido.name === nomeProduto ? ok(`nome intacto: "${lido.name}"`) : falha(`nome divergiu: "${lido.name}"`);
lido.visible_in_store === false ? ok('nasceu OCULTO') : falha(`visible_in_store = ${lido.visible_in_store} (deveria ser false)`);
const variantes = lido.product_variants || [];
const coresGeradas = [...new Set(variantes.map((v) => v.color).filter(Boolean))];
const modelosGerados = [...new Set(variantes.map((v) => v.model).filter(Boolean))];
ok(`${variantes.length} variante(s) · ${coresGeradas.length} cor(es) · ${modelosGerados.length} modelo(s): ${modelosGerados.join(', ')}`);
modelosGerados.length === modelos.length
  ? ok(`todos os ${modelos.length} modelos receberam arte`)
  : falha(`só ${modelosGerados.length} de ${modelos.length} modelos receberam arte — faltou ${modelos.filter((m) => !modelosGerados.includes(m)).join(', ')}`);
console.log(`   cores: ${coresGeradas.join(', ')}`);
const esperadas = [...CORES_ESCURAS, ...CORES_CLARAS, COR_AMARELO];
const semVariante = esperadas.filter((c) => !coresGeradas.includes(c));
semVariante.length ? falha(`sem variante: ${semVariante.join(', ')}`) : ok('todas as 9 cores geraram variante');
console.log(`   \x1b[36mCONFIRA NO PAINEL DA INK: a arte certa em cada cor.\x1b[0m`);
console.log(`   produto: ${lido.store_product_url || `(id ${criado.id})`}`);

// ── 6. As 9 cópias ───────────────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m6. Copiando para as 9 peças\x1b[0m${CORRIGIR ? ' (substituem as cópias antigas do mesmo cluster)' : ''}`);
const copias = [];
for (const t of TIPOS_COPIA) {
  try {
    const c = (await ink('POST', `/v1/stores/products/${criado.id}/copy`, { product_type_id: t.id, include_categories: true })).product;
    copias.push({ tipo: t, produto: c });
    ok(`${t.nome.padEnd(26)} id ${c.id}  cluster ${c.product_cluster_id ?? '—'}  visível=${c.visible_in_store}`);
  } catch (e) { falha(`${t.nome.padEnd(26)} ${e.message}`); }
}

console.log('\n\x1b[1m7. Conferindo as cópias\x1b[0m');
const clusters = new Set([lido.product_cluster_id, ...copias.map((c) => c.produto.product_cluster_id)].filter((x) => x != null));
clusters.size === 1 ? ok(`todas no mesmo agrupamento (cluster ${[...clusters][0]})`) : falha(`agrupamentos diferentes: ${[...clusters].join(', ')}`);
const visiveis = [];
for (const c of copias) {
  const p = (await ink('GET', `/v1/stores/products/${c.produto.id}`)).product;
  const cores = [...new Set((p.product_variants || []).map((v) => v.color).filter(Boolean))];
  if (p.visible_in_store) visiveis.push(c.tipo.nome);
  console.log(`   ${c.tipo.nome.padEnd(26)} oculto=${!p.visible_in_store}  R$ ${p.price ?? '—'}  ${(p.product_variants || []).length} variante(s)  cores: ${cores.join(', ') || '—'}`);
}
visiveis.length
  ? falha(`${visiveis.length} cópia(s) nasceram VISÍVEIS (${visiveis.join(', ')}) — o lote vai precisar de um PATCH por cópia`)
  : ok('todas as cópias nasceram ocultas — nenhum PATCH extra necessário');

console.log('\n\x1b[1mResumo\x1b[0m');
console.log(`  produto base : ${criado.id}`);
console.log(`  cópias       : ${copias.length}/9`);
console.log(`  categorias   : ${idsCategorias.join(', ')}`);
console.log('\n  Falta só o olho humano: abrir no painel da Ink e confirmar que a arte clara');
console.log('  está nas peças escuras e vice-versa.\n');
