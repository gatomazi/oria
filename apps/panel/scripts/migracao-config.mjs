// Configuração e resolução compartilhadas da migração Centro/Norte → Sul.
// Doc: docs/plano-migracao-criacao-produtos.md
//
// Piloto (scripts/migracao-piloto.mjs) e lote (scripts/migracao-lote.mjs) importam DAQUI —
// duplicar essas tabelas nos dois seria a forma mais fácil de publicar 7 mil produtos com a arte
// trocada e não perceber.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';

export const INK = 'https://api.reserva.ink';  // mesmo INK_API_BASE de server.js:54
// Acervos locais do operador (8 GB de artes; banco de gentílicos), fora do repositório e fora do
// git. Sempre por variável de ambiente, nunca com caminho embutido: um caminho de máquina no código
// faz o script funcionar só para quem o escreveu e falhar sem explicação em qualquer outro lugar.
// A leitura é tardia de propósito — `migracao-diagnostico.mjs` importa daqui só o `INK`.
export function acervoLocal(variavel) {
  const dir = process.env[variavel];
  if (!dir) throw new Error(`${variavel} não configurado — esta etapa só roda na máquina que tem o acervo local`);
  return dir;
}
export const ARTES = () => acervoLocal('MIGRACAO_ARTES_DIR');
export const GENTILICOS = () => acervoLocal('MIGRACAO_GENTILICOS_DIR');

export const CORES_ESCURAS = ['Bordeaux', 'Vermelho', 'Marinho', 'Preta', 'Verde'];
export const CORES_CLARAS = ['Cinza', 'Rosa', 'Branca'];
export const COR_AMARELO = 'Amarelo';

// Cores que existem só nas peças de destino (Body Infantil, Hoodie, Suéter, Oversized, Algodão
// Peruano). PROPOSTA de 15/09, ainda NÃO confirmada: fica desligada até alguém chamar
// habilitarCoresExtras() (flag --cores-extras nos scripts). Sem ela, produto com essas cores para
// com "cor sem balde" em vez de receber arte num balde chutado.
export const CORES_ESCURAS_EXTRAS = ['Verde Musgo', 'Verde Oliva'];
export const CORES_CLARAS_EXTRAS = ['Rosa Bebê', 'Azul Bebê', 'Off White', 'Areia', 'Bege'];
let coresExtras = false;
export function habilitarCoresExtras() { coresExtras = true; }

// Balde de arte de uma cor de peça: 'escuras' (recebe arte clara), 'claras' (arte escura) ou
// 'amarelo'. null = cor sem regra — quem chama tem que parar, nunca chutar.
export function baldeDaCor(cor) {
  if (cor === COR_AMARELO) return 'amarelo';
  if ([...CORES_ESCURAS, ...(coresExtras ? CORES_ESCURAS_EXTRAS : [])].includes(cor)) return 'escuras';
  if ([...CORES_CLARAS, ...(coresExtras ? CORES_CLARAS_EXTRAS : [])].includes(cor)) return 'claras';
  return null;
}

// `sufixos` = qual arquivo serve cada balde de cor. Nos 6 primeiros o sufixo do arquivo nomeia a
// cor da ARTE ("_branco" = arte branca, vai em peça escura); em gentilicos/feito_em nomeia a cor
// da PEÇA, e portanto está invertido. Medido na luminância real do acervo: aplicar uma regra
// global inverteria 1.870 produtos (arte preta sobre camiseta preta). Doc §2.2/§2.3.
// `cat` é o rótulo curto da categoria — o limite de 20 caracteres da Ink obriga abreviar (§4).
// `nome` é a forma do título, que NÃO é uniforme entre coleções (§3).
export const MODELOS = {
  coordenadas: { token: 'coord', cat: 'COORD', nome: (c, uf) => `${c} | Coordenadas ${uf}`, sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  legado:      { token: 'arte',  cat: 'LEG',   nome: (c, uf) => `${c} | Legado ${uf}`,      sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  origem:      { token: 'arte',  cat: 'ORIG',  nome: (c, uf) => `${c} | Origem ${uf}`,      sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  territorio:  { token: 'arte',  cat: 'TERR',  nome: (c, uf) => `${c} | Território ${uf}`,  sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  tipografia:  { token: 'arte',  cat: 'TIPOG', nome: (c, uf) => `${c} | Tipografia ${uf}`,  sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  traco:       { token: 'arte',  cat: 'TRACO', nome: (c, uf) => `${c} | Traço ${uf}`,       sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  gentilicos:  { token: null,    cat: 'GENT',  nome: (c, uf, g) => `${g} | Gentílico ${uf}`, sufixos: { escuras: 'preto', claras: 'branco', amarelo: 'branco' } },
  feito_em:    { token: null,    cat: 'FEITO', nome: (c, uf) => `Feito em ${c} ${uf}`,      sufixos: { escuras: 'preto', claras: 'branco', amarelo: 'amarelo' } },
};

export const REGIAO = { MT: 'CO', MS: 'CO', GO: 'CO', DF: 'CO', AC: 'NO', AM: 'NO', AP: 'NO', PA: 'NO', RO: 'NO', RR: 'NO', TO: 'NO' };
export const CATEGORIA_FIXA = 'Seu Lugar';

export const TIPO_BASE = { id: 1, nome: 'Camiseta' };
export const TIPOS_COPIA = [
  { id: 165, nome: 'Body Infantil' }, { id: 72, nome: 'Camiseta Algodão Peruano' },
  { id: 2, nome: 'Camiseta Infantil' }, { id: 178, nome: 'Camiseta Oversized' },
  { id: 23, nome: 'Cropped' }, { id: 28, nome: 'Cropped Moletom' },
  { id: 119, nome: 'Hoodie Moletom' }, { id: 8, nome: 'Regata' }, { id: 120, nome: 'Suéter Moletom' },
];

// 7 cidades de `tipografia` só existem na grafia sem apóstrofo, e nessa versão o apóstrofo some
// TAMBÉM da estampa ("MIRASSOL D OESTE"). Bloqueadas até a arte ser regerada — doc §2.4.
export const TIPOGRAFIA_DEFEITUOSA = new Set([
  'GO/saojoaodalianca', 'GO/sitiodabadia', 'MT/conquistadoeste', 'MT/figueiropolisdoeste',
  'MT/gloriadoeste', 'MT/lambaridoeste', 'MT/mirassoldoeste',
]);

// O dicionário de gentílicos traz alternativas e apelidos que não podem virar nome de produto
// ("tartarugalense ou tartaruguense", "cuiabano (papa peixe)") — doc §3.2.
export const GENTILICO_AMBIGUO = /\bou\b|\/|\(/;

export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// ── Acervo ───────────────────────────────────────────────────────────────────────────────────
// Varre a árvore de diretórios. NÃO abre PNG nenhum (são 8 GB) — isso só acontece por item.
export function indexarAcervo() {
  const raizArtes = ARTES();
  const acervo = new Map();
  for (const modelo of fs.readdirSync(raizArtes)) {
    const cfg = MODELOS[modelo];
    if (!cfg || !fs.statSync(path.join(raizArtes, modelo)).isDirectory()) continue;
    for (const uf of fs.readdirSync(path.join(raizArtes, modelo))) {
      if (!REGIAO[uf.toUpperCase()]) continue;
      const dir = path.join(raizArtes, modelo, uf);
      for (const arquivo of fs.readdirSync(dir)) {
        if (!arquivo.toLowerCase().endsWith('.png')) continue;
        const p = arquivo.slice(0, -4).split('_');
        const sufixo = p[p.length - 1];
        const corte = cfg.token && p.length > 2 && p[p.length - 2] === cfg.token ? 2 : 1;
        const cidadeArquivo = p.slice(0, p.length - corte).join('_');
        if (!cidadeArquivo) continue;
        const chave = `${modelo}/${uf.toUpperCase()}/${norm(cidadeArquivo)}`;
        const item = acervo.get(chave) || { chave, modelo, uf: uf.toUpperCase(), cidadeArquivo, arquivos: {}, descartados: [] };
        const completo = path.join(dir, arquivo);
        if (item.arquivos[sufixo]) {
          // Mesma cidade em duas grafias (apóstrofo). A versão SEM apóstrofo tem a estampa errada,
          // conferido no acervo — vence a com apóstrofo, e o descarte fica registrado. Doc §2.4.
          const vencedor = arquivo.includes("'") ? completo : item.arquivos[sufixo];
          item.descartados.push({ sufixo, usado: vencedor, ignorado: vencedor === completo ? item.arquivos[sufixo] : completo });
          item.arquivos[sufixo] = vencedor;
        } else item.arquivos[sufixo] = completo;
        acervo.set(chave, item);
      }
    }
  }
  return acervo;
}

// ── Nomes ────────────────────────────────────────────────────────────────────────────────────
const cacheGent = new Map();
function dicionarioGentilicos(uf) {
  if (!cacheGent.has(uf)) {
    const arq = path.join(GENTILICOS(), `gentilicos_${uf.toLowerCase()}.json`);
    const lista = fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, 'utf8')) : [];
    cacheGent.set(uf, new Map(lista.map((x) => [norm(x.municipio), x])));
  }
  return cacheGent.get(uf);
}

// Regiões administrativas do DF não são municípios IBGE — nome vem de lista revisada à parte.
let cacheDf = null;
function regioesDf() {
  if (!cacheDf) {
    const arq = new URL('../data/df-regioes-administrativas.json', import.meta.url);
    const bruto = JSON.parse(fs.readFileSync(arq, 'utf8'));
    cacheDf = new Map(Object.entries(bruto).filter(([k]) => !k.startsWith('_')));
  }
  return cacheDf;
}

// Hífen preservado, cada palavra capitalizada — confirmado 12/09.
function capitalizarGentilico(g) {
  return g.split(/([ -])/).map((t) => (/[ -]/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1))).join('');
}

export function categoriasDoItem(modelo, uf) {
  const r = REGIAO[uf];
  const c = MODELOS[modelo].cat;
  return [`ZZ - ${r}`, `ZZ - ${r} - ${uf}`, `ZZ - ${r} - ${c}`, `ZZ - ${r} - ${c} - ${uf}`, CATEGORIA_FIXA];
}

// Resolve um item do acervo em algo criável, ou devolve o motivo do bloqueio.
export function resolverItem(item) {
  const { modelo, uf, cidadeArquivo } = item;
  const cfg = MODELOS[modelo];
  const chaveCidade = norm(cidadeArquivo);

  const faltando = [...new Set(Object.values(cfg.sufixos))].filter((s) => !item.arquivos[s]);
  if (faltando.length) return { bloqueio: `arte faltando: ${faltando.join(', ')}` };
  if (modelo === 'tipografia' && TIPOGRAFIA_DEFEITUOSA.has(`${uf}/${chaveCidade}`)) {
    return { bloqueio: 'arte de tipografia sem apóstrofo na estampa — regerar' };
  }

  const entrada = dicionarioGentilicos(uf).get(chaveCidade);
  let cidade = entrada?.municipio;
  if (!cidade && uf === 'DF') cidade = regioesDf().get(chaveCidade);
  if (!cidade) return { bloqueio: 'cidade sem nome oficial no dicionário' };

  let gentilico = null;
  if (modelo === 'gentilicos') {
    if (!entrada) return { bloqueio: 'sem gentílico no dicionário' };
    if (GENTILICO_AMBIGUO.test(entrada.gentilico)) return { bloqueio: `gentílico ambíguo: "${entrada.gentilico}"` };
    gentilico = capitalizarGentilico(entrada.gentilico);
  }

  return {
    chave: item.chave, modelo, uf, cidade, gentilico,
    nome: cfg.nome(cidade, uf, gentilico),
    categorias: categoriasDoItem(modelo, uf),
    arquivos: item.arquivos,
  };
}

// ── Luminância: guarda contra arte invertida (§2.5) ───────────────────────────────────────────
// O arquivo é lido de qualquer forma pra virar base64; decodificar em miniatura custa ~0,2s e
// pega qualquer arquivo que contradiga a convenção do seu modelo antes de subir pra Ink.
// Média PONDERADA POR ALPHA, não contagem de pixel 100% opaco. A arte é um traço fino num canvas
// 4270x4900: ao reduzir, a antialiasing espalha a opacidade e quase nenhum pixel sobrevive com
// alpha>200 — em `origem/MS/fatima_do_sul` sobravam ZERO, e a guarda reprovava uma arte perfeita
// (12/09). A ponderação usa a mesma informação sem depender de pixel saturado: no mesmo arquivo
// dá 243 (clara) contra 4 (escura), separação limpa.
export async function luminancia(arquivo) {
  const { data, info } = await sharp(arquivo).resize(400, 400, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let soma = 0, peso = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const a = data[i + 3];
    if (a > 10) { soma += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a; peso += a; }
  }
  return peso ? soma / peso : null;
}

// Arte que vai em peça ESCURA tem que ser clara, e vice-versa. Limiares folgados de propósito:
// a intenção é pegar arquivo trocado, não julgar design.
export async function conferirLuminancia(modelo, arquivos) {
  const problemas = [];
  for (const [balde, sufixo] of Object.entries(MODELOS[modelo].sufixos)) {
    const lum = await luminancia(arquivos[sufixo]);
    // Arte 100% transparente é inconclusivo, não reprovação: a guarda existe pra pegar arquivo
    // TROCADO, e reprovar no que ela não consegue medir só trava upload de arte boa.
    if (lum == null) continue;
    if (balde === 'escuras' && lum < 140) problemas.push(`${balde}: arte escura (lum ${lum.toFixed(0)}) em peça escura`);
    if (balde !== 'escuras' && lum > 140) problemas.push(`${balde}: arte clara (lum ${lum.toFixed(0)}) em peça clara`);
  }
  return problemas;
}

// ── Cliente da Ink ───────────────────────────────────────────────────────────────────────────
// `idem` é a CHAVE DE IDEMPOTÊNCIA da operação lógica e tem que ser ESTÁVEL entre tentativas —
// é a única coisa que impede um retry de criar um produto a mais. Gerar um randomUUID por
// chamada (como estava até 12/09) anula o mecanismo: um POST que cria na Ink mas cujo response
// se perde na rede vira 3 produtos idênticos, um por tentativa. Aconteceu de verdade.
// Derivada do item, não do relógio: sobrevive até a reinício do processo.
export function chaveIdem(...partes) {
  return crypto.createHash('sha256').update(partes.join('|')).digest('hex').slice(0, 32);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry-After vem em segundos ("30") ou data HTTP. Sem ele, backoff exponencial.
function segundosRetryAfter(valor) {
  if (!valor) return null;
  const n = Number(valor);
  if (Number.isFinite(n)) return Math.max(1, n);
  const quando = Date.parse(valor);
  return Number.isFinite(quando) ? Math.max(1, Math.ceil((quando - Date.now()) / 1000)) : null;
}

// Cliente único pra TODA chamada à Ink. A espera de 429 mora aqui, não nos pontos de chamada:
// antes só o processamento de item tinha retry, e um 429 no índice ou na criação de categorias
// (50 POSTs seguidos no início do lote completo) derrubava o processo inteiro (12/09).
//
// - 429: a Ink NÃO processou a requisição, então repetir é seguro em qualquer método. Espera o
//   Retry-After (ou 15s, 30s, 60s… até 5 min) e tenta de novo, até ~40 vezes.
// - A pausa é COMPARTILHADA: se um worker toma 429, os outros também esperam, em vez de cada um
//   bater na mesma parede e estender o bloqueio.
// - Erro de rede / 5xx: só GET repete aqui. Em POST a Ink pode ter processado — quem decide é o
//   chamador (a criação de produto confere se ele já existe antes de tentar de novo).
export function criarCliente(token, { base = INK, log = console.log, max429 = 40, maxRede = 6 } = {}) {
  let pausaAte = 0;
  return async function ink(metodo, rota, body, { idem, timeoutMs = 300000 } = {}) {
    // Uma chave por operação lógica, gerada FORA do laço: todas as tentativas mandam a mesma.
    const chave = body ? (idem || crypto.randomUUID()) : null;
    for (let tentativa = 1; ; tentativa += 1) {
      const falta = pausaAte - Date.now();
      if (falta > 0) await dormir(falta + Math.floor(Math.random() * 1000));

      const headers = { Authorization: `Bearer ${token}` };
      if (body) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = chave; }

      let res;
      try {
        res = await fetch(base + rota, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (metodo === 'GET' && tentativa < maxRede) {
          const s = Math.min(120, 5 * 2 ** (tentativa - 1));
          log(`  \x1b[2m⏸ rede em GET ${rota.split('?')[0]} (${e.message}) — tentando de novo em ${s}s\x1b[0m`);
          await dormir(s * 1000);
          continue;
        }
        throw e;
      }

      const repetivel = res.status === 429 || (metodo === 'GET' && res.status >= 500);
      if (repetivel && tentativa < (res.status === 429 ? max429 : maxRede)) {
        await res.text().catch(() => {});
        const s = segundosRetryAfter(res.headers.get('retry-after')) ?? Math.min(300, 15 * 2 ** (tentativa - 1));
        pausaAte = Math.max(pausaAte, Date.now() + s * 1000);
        log(`  \x1b[33m⏸ ${res.status} em ${metodo} ${rota.split('?')[0]} — pausando ${s}s (tentativa ${tentativa})\x1b[0m`);
        continue;
      }

      const txt = await res.text();
      let data; try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 400) }; }
      if (!res.ok) {
        const err = new Error(`${metodo} ${rota} -> ${res.status}: ${(data.errors || []).join('; ') || data.error || JSON.stringify(data).slice(0, 200)}`);
        err.status = res.status;
        // 409 "a tentativa anterior com esta Idempotency-Key falhou de forma indeterminada": a Ink
        // honra a chave, mas não deixa reusar uma cuja 1ª tentativa caiu no meio. Não dá pra saber
        // se ela criou ou não — quem chama tem que CONFERIR antes de mandar chave nova (13/09).
        err.idemIndeterminada = res.status === 409 && /idempotency/i.test(err.message);
        throw err;
      }
      return data;
    }
  };
}

// Áreas de impressão indexadas por cor. O VALOR É UMA LISTA: existe uma área por (modelo, cor) —
// a Camiseta tem 18 = 9 cores × 2 modelos. Indexar por cor sozinha faz um modelo sobrescrever o
// outro e publica metade das variantes sem arte (bug real do piloto, 12/09). Doc §1.2.
export function areasPorCor(printableAreas) {
  const mapa = new Map();
  for (const a of printableAreas || []) {
    if (!a.color?.name) continue;
    mapa.set(a.color.name, [...(mapa.get(a.color.name) || []), a.base_image_id]);
  }
  return mapa;
}

export function montarArtGroups(porCor, arquivos, modelo) {
  const baldes = { escuras: CORES_ESCURAS, claras: CORES_CLARAS, amarelo: [COR_AMARELO] };
  const grupos = [];
  const semCor = [];
  for (const [balde, cores] of Object.entries(baldes)) {
    const ids = [];
    for (const cor of cores) {
      const doCor = porCor.get(cor);
      if (!doCor?.length) { semCor.push(cor); continue; }
      ids.push(...doCor);
    }
    if (ids.length) grupos.push({ balde, cores, base_image_ids: ids, arquivo: arquivos[MODELOS[modelo].sufixos[balde]] });
  }
  return { grupos, semCor };
}

// Produtos do agrupamento de `produtoId`, por tipo: Map(tipoId -> [ids]). É onde se confirma se uma
// cópia aconteceu — o /copy coloca a cópia no agrupamento do produto de origem. `conhecidos`
// (Map id -> tipoId) evita um GET por produto que o estado já identifica.
export async function tiposDoAgrupamento(ink, produtoId, conhecidos = new Map()) {
  const base = (await ink('GET', `/v1/stores/products/${produtoId}`)).product;
  const porTipo = new Map();
  if (!base?.product_cluster_id) return porTipo;
  const cluster = (await ink('GET', `/v1/stores/product_clusters/${base.product_cluster_id}`)).product_cluster;
  for (const id of cluster?.product_ids || []) {
    if (id === produtoId) continue;
    const tipo = conhecidos.get(id) ?? (await ink('GET', `/v1/stores/products/${id}`)).product?.product_type?.id;
    if (tipo != null) porTipo.set(tipo, [...(porTipo.get(tipo) || []), id]);
  }
  return porTipo;
}

// Arte de cada área de impressão de um TIPO (Cropped, Body…), pelo balde da cor. Cada peça tem
// áreas próprias — nunca usar as da Camiseta aqui.
export function artsDasAreas(areas, modelo, arquivos) {
  const porBalde = { escuras: [], claras: [], amarelo: [] };
  const semRegra = new Set();
  for (const a of areas || []) {
    const b = baldeDaCor(a.color?.name);
    if (b) porBalde[b].push(a); else semRegra.add(a.color?.name || `área ${a.base_image_id}`);
  }
  const sufixos = MODELOS[modelo].sufixos;
  const cache = new Map();
  const base64 = (arq) => { if (!cache.has(arq)) cache.set(arq, fs.readFileSync(arq).toString('base64')); return cache.get(arq); };
  const arts = Object.entries(porBalde).flatMap(([b, lista]) =>
    lista.map((a) => ({ base_image_id: a.base_image_id, art_attachment: base64(arquivos[sufixos[b]]) })));
  return { arts, porBalde, semRegra: [...semRegra] };
}

// Destrava produto preso em resizing DESATIVANDO e READICIONANDO as variantes, no mesmo id.
// Validado em 15/09 em dois Cropped presos desde 12/09: saíram de resizing e as imagens das
// variantes carregaram. Trocar a arte com PATCH simples NÃO destravava, e a recópia só gerava
// órfão. A API não aceita desativar todas as variantes de uma vez: vai em duas metades.
export async function reaplicarProduto(ink, { id, modelo, arquivos, tipos, carimbo = Date.now(), log = () => {} }) {
  const antes = (await ink('GET', `/v1/stores/products/${id}`)).product;
  const tipo = (tipos || []).find((t) => t.id === antes?.product_type?.id);
  if (!tipo) throw new Error(`tipo ${antes?.product_type?.id} não encontrado nos tipos da loja`);
  const { arts, porBalde, semRegra } = artsDasAreas(tipo.printable_areas, modelo, arquivos);
  if (semRegra.length) throw new Error(`cor(es) sem balde em ${tipo.name}: ${semRegra.join(', ')} (use --cores-extras se a proposta estiver confirmada)`);
  if (!arts.length) throw new Error(`${tipo.name} sem áreas de impressão`);

  const ids = arts.map((a) => a.base_image_id);
  const corte = Math.ceil(ids.length / 2);
  const metades = [ids.slice(0, corte), ids.slice(corte)].filter((m) => m.length);
  for (const [i, metade] of metades.entries()) {
    await ink('PATCH', `/v1/stores/products/${id}`, { remove_variants: metade }, { idem: chaveIdem('reaplicar-remove', id, i, carimbo) });
    await ink('PATCH', `/v1/stores/products/${id}`, { arts: arts.filter((a) => metade.includes(a.base_image_id)) }, { idem: chaveIdem('reaplicar-arts', id, i, carimbo) });
    log(`metade ${i + 1}/${metades.length} (${metade.length} área(s)) reaplicada`);
  }
  // Relê: a resposta do PATCH pode refletir o estado de antes do processamento assíncrono.
  const relido = (await ink('GET', `/v1/stores/products/${id}`)).product || {};
  return { antes, relido, tipo, porBalde, arts };
}
