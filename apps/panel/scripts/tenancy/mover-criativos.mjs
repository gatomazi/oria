#!/usr/bin/env node
// Move os arquivos do Gerador de Criativos do tenant legado da instalação para a Organization dona
// (Fase 3 · INV-22, OPS-22). A migration 1789800000000 já trocou tenant_id pelo id da Organization no
// banco; os arquivos em UPLOADS_DIR/creatives/tenant/<legado>/ precisam acompanhar.
//
// Uso:
//   node scripts/tenancy/mover-criativos.mjs --uploads <UPLOADS_DIR> --de <legado> --para <organization_id>              # simula
//   node scripts/tenancy/mover-criativos.mjs --uploads <UPLOADS_DIR> --de <legado> --para <organization_id> --aplicar    # move
//   node scripts/tenancy/mover-criativos.mjs --uploads <UPLOADS_DIR> --de <legado> --para <organization_id> --verificar  # confere (DATABASE_URL)
//
// Rodada 19 (trilha G): a release com leitura dupla (CREATIVE_LEGACY_READ_*) já grava arquivos novos no
// diretório da Organization ANTES do mover rodar. Por isso o movimento é arquivo a arquivo:
//   - destino ausente          → move (link + unlink: nunca sobrescreve; em outro disco, cópia exclusiva conferida por sha256)
//   - destino idêntico (sha256) → só remove a origem (re-execução / execução interrompida)
//   - destino diferente         → CONFLITO: nada é movido, sai com erro
// Link simbólico ou arquivo especial na origem = erro. Idempotente: rodar de novo depois de terminar
// não faz nada. Diretórios vazios da origem são removidos no fim.
//
// --verificar (somente leitura) dá PASS só se: nada sobrou no diretório legado; toda referência do banco
// da Organization (creative_products.references_json, creative_assets.storage_key e as referências do
// plano em creative_generations) aponta para um arquivo existente no diretório NOVO; o sha256 e o
// tamanho dos assets batem com o banco; o tamanho das referências de produto bate com o banco.
// Imprime só contagens e nomes relativos — nunca caminho absoluto, URL ou segredo.
//
// Revisão da rodada 19 (RELEASE B = 31a7cdb, sem leitura dupla): antes da B, o diretório da
// Organization vira um VÍNCULO (link simbólico relativo) para o diretório legado:
//   --vincular [--aplicar]          cria tenant/<organization_id> → <legado> (um passo atômico; a versão
//                                   em produção e a B passam a ler e gravar os MESMOS arquivos)
//   --desvincular --aplicar         materializa: remove o vínculo e move arquivo a arquivo. Só com a
//                                   leitura dupla (CREATIVE_LEGACY_READ_*) ligada na release no ar.
// Com o vínculo presente, o movimento comum é RECUSADO (apagaria a origem achando que é duplicado).
// --verificar aceita os dois estados: PASS-VINCULADO (tudo acessível pelo vínculo) ou PASS (separado).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { TENANT_RE, REF_RE, ASSET_RE } = require('../../lib/creative-core/storage.js');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sha256 = (arquivo) => crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex');

function validar({ uploads, de, para }) {
  if (!uploads) throw new Error('--uploads obrigatório');
  if (!TENANT_RE.test(String(de || '')) || UUID_RE.test(String(de))) throw new Error('--de inválido (nome do tenant legado)');
  if (!UUID_RE.test(String(para || ''))) throw new Error('--para precisa ser o id (uuid minúsculo) da Organization');
  const raiz = path.resolve(uploads, 'creatives', 'tenant');
  return { raiz, origem: path.join(raiz, de), destino: path.join(raiz, para) };
}

// Arquivos regulares sob `base`, como caminhos relativos com '/'. Link simbólico ou especial = erro.
function listarArquivos(base) {
  if (!fs.existsSync(base)) return [];
  const saida = [];
  const visitar = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(base, abs).split(path.sep).join('/');
      if (ent.isSymbolicLink()) throw new Error(`link simbólico no diretório de criativos: ${rel}`);
      if (ent.isDirectory()) visitar(abs);
      else if (ent.isFile()) saida.push(rel);
      else throw new Error(`arquivo especial no diretório de criativos: ${rel}`);
    }
  };
  visitar(base);
  return saida.sort();
}

// 'ausente' | 'diretorio' | 'link' | 'outro' — sem seguir link simbólico.
function tipoDe(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return 'ausente';
    throw err;
  }
  if (st.isSymbolicLink()) return 'link';
  return st.isDirectory() ? 'diretorio' : 'outro';
}

// Estado do diretório da Organization em relação ao legado: 'ausente' | 'diretorio' | 'vinculo' | 'invalido'.
function estadoDoDestino(destino, de) {
  const tipo = tipoDe(destino);
  if (tipo === 'link') return fs.readlinkSync(destino) === de ? 'vinculo' : 'invalido';
  if (tipo === 'outro') return 'invalido';
  return tipo;
}

function exigirOrigemReal(origem, de) {
  const tipo = tipoDe(origem);
  if (tipo === 'link' || tipo === 'outro') throw new Error(`tenant/${de} não é um diretório comum — resolva à mão`);
  return tipo;
}

export function vincularCriativos(opcoes, { aplicar = false } = {}) {
  const { origem, destino } = validar(opcoes);
  const { de, para } = opcoes;
  const estado = estadoDoDestino(destino, de);
  if (estado === 'vinculo') return { acao: 'nada', motivo: 'vínculo já existe', aplicado: false };
  if (estado !== 'ausente') {
    throw new Error(`tenant/${para} já existe (${estado === 'diretorio' ? 'diretório' : 'não é o vínculo esperado'}) — o vínculo não se aplica; use a leitura dupla + mover`);
  }
  const criarOrigem = exigirOrigemReal(origem, de) === 'ausente';
  const arquivos = criarOrigem ? 0 : listarArquivos(origem).length;
  if (!aplicar) return { acao: 'vincular', criarOrigem, arquivos, aplicado: false };
  // Sem origem, a versão atual criaria tenant/<legado> e a nova tenant/<org>: dois diretórios. Cria antes.
  if (criarOrigem) fs.mkdirSync(origem, { recursive: true });
  // Relativo (sobrevive a outro ponto de montagem) e atômico: EEXIST se alguém criou o destino no meio.
  fs.symlinkSync(de, destino, 'dir');
  return { acao: 'vincular', criarOrigem, arquivos, aplicado: true };
}

function removerDiretoriosVazios(dir, { manterRaiz = false } = {}) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) removerDiretoriosVazios(path.join(dir, ent.name));
  }
  if (!manterRaiz && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

export function planejarMovimento(opcoes) {
  const { origem, destino } = validar(opcoes);
  const { de, para } = opcoes;
  const estado = estadoDoDestino(destino, de);
  if (estado === 'invalido') throw new Error(`tenant/${para} existe e não é diretório nem o vínculo para tenant/${de} — resolva à mão`);
  if (estado === 'vinculo' && !opcoes.desvincular) {
    throw new Error(`tenant/${para} é o vínculo para tenant/${de}: o movimento comum apagaria os arquivos. `
      + 'Use --desvincular, só com a leitura dupla ligada na release no ar');
  }
  const desvincular = estado === 'vinculo';
  const vazio = (motivo) => ({ origem, destino, acao: desvincular ? 'desvincular' : 'nada', motivo, desvincular, mover: [], iguais: [] });
  if (exigirOrigemReal(origem, de) === 'ausente') return vazio('origem inexistente');
  const arquivos = listarArquivos(origem);
  if (!arquivos.length) return vazio('origem sem arquivos');
  // Com o vínculo, o destino É a origem: depois de removê-lo, tudo precisa ser movido.
  if (desvincular) return { origem, destino, acao: 'mover', desvincular, mover: arquivos, iguais: [] };
  const mover = [];
  const iguais = [];
  const conflitos = [];
  const origemReal = fs.realpathSync(origem);
  for (const rel of arquivos) {
    const alvo = path.join(destino, rel);
    if (!fs.existsSync(alvo)) mover.push(rel);
    // Mesmo arquivo alcançado por link simbólico no caminho do destino: nunca "duplicado".
    else if (fs.realpathSync(alvo).startsWith(origemReal + path.sep)) conflitos.push(rel);
    else if (fs.lstatSync(alvo).isFile() && sha256(alvo) === sha256(path.join(origem, rel))) iguais.push(rel);
    else conflitos.push(rel);
  }
  if (conflitos.length) {
    const e = new Error(`${conflitos.length} arquivo(s) já existem no destino com conteúdo diferente: ${conflitos.slice(0, 10).join(', ')} — resolva à mão, conferindo o conteúdo`);
    e.conflitos = conflitos;
    throw e;
  }
  return { origem, destino, acao: 'mover', mover, iguais };
}

function moverArquivo(de, para) {
  fs.mkdirSync(path.dirname(para), { recursive: true });
  try {
    fs.linkSync(de, para); // falha com EEXIST: nunca sobrescreve
  } catch (err) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(err.code)) throw err;
    fs.copyFileSync(de, para, fs.constants.COPYFILE_EXCL);
    if (sha256(de) !== sha256(para)) {
      fs.unlinkSync(para);
      throw new Error('cópia divergente (sha256)');
    }
  }
  fs.unlinkSync(de);
}

export function moverCriativos(opcoes, { aplicar = false } = {}) {
  const plano = planejarMovimento(opcoes);
  const resumo = { ...plano, movidos: 0, duplicadosRemovidos: 0 };
  if (!aplicar) return { ...resumo, aplicado: false };
  if (plano.desvincular) {
    // Confere de novo imediatamente antes: só o vínculo esperado é removido (unlink não segue o link).
    if (estadoDoDestino(plano.destino, opcoes.de) !== 'vinculo') throw new Error('o vínculo mudou durante a execução — nada foi feito');
    fs.unlinkSync(plano.destino);
    resumo.desvinculado = true;
  }
  if (plano.acao === 'mover') {
    for (const rel of plano.mover) {
      moverArquivo(path.join(plano.origem, rel), path.join(plano.destino, rel));
      resumo.movidos += 1;
    }
    for (const rel of plano.iguais) {
      fs.unlinkSync(path.join(plano.origem, rel));
      resumo.duplicadosRemovidos += 1;
    }
  }
  // Origem sem arquivos (inclusive depois do movimento): some com os diretórios vazios.
  if (fs.existsSync(plano.origem) && !listarArquivos(plano.origem).length) removerDiretoriosVazios(plano.origem);
  return { ...resumo, aplicado: plano.acao !== 'nada' };
}

// Referências do banco da Organization, lidas numa transação READ ONLY com o contexto de RLS dela.
export async function lerReferenciasDoBanco(url, organizationId) {
  if (!UUID_RE.test(String(organizationId || ''))) throw new Error('organization inválida');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => {});
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [organizationId]);
    const assets = (await client.query(
      'SELECT storage_key, sha256, byte_size FROM creative_assets WHERE organization_id = $1 ORDER BY storage_key', [organizationId]
    )).rows.map((r) => ({ rel: r.storage_key, sha256: r.sha256, bytes: Number(r.byte_size) }));
    const produtos = (await client.query(
      `SELECT r->>'ref' AS ref, r->>'sizeBytes' AS bytes
         FROM creative_products p, jsonb_array_elements(CASE WHEN jsonb_typeof(p.references_json) = 'array' THEN p.references_json ELSE '[]'::jsonb END) r
        WHERE p.organization_id = $1`, [organizationId]
    )).rows.map((r) => ({ rel: r.ref, bytes: r.bytes === null ? null : Number(r.bytes) }));
    const planos = (await client.query(
      `SELECT DISTINCT r->>'ref' AS ref
         FROM creative_generations g, jsonb_array_elements(CASE WHEN jsonb_typeof(g.plan->'references') = 'array' THEN g.plan->'references' ELSE '[]'::jsonb END) r
        WHERE g.organization_id = $1`, [organizationId]
    )).rows.map((r) => ({ rel: r.ref, bytes: null }));
    return { assets, referencias: [...produtos, ...planos] };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

// Somente leitura. `banco` = { assets: [{rel, sha256, bytes}], referencias: [{rel, bytes|null}] }.
export function verificarCriativos(opcoes, banco) {
  const { origem, destino } = validar(opcoes);
  const problemas = [];
  const estadoDestino = estadoDoDestino(destino, opcoes.de);
  const vinculado = estadoDestino === 'vinculo';
  if (estadoDestino === 'invalido') problemas.push(`tenant/${opcoes.para} não é diretório nem o vínculo para tenant/${opcoes.de}`);
  if (vinculado && !fs.existsSync(destino)) problemas.push('vínculo aponta para um diretório legado inexistente');
  if (tipoDe(origem) === 'link' || tipoDe(origem) === 'outro') problemas.push(`tenant/${opcoes.de} não é um diretório comum`);
  // Vinculado, o legado É o destino: arquivos lá são esperados até a materialização.
  const restantes = tipoDe(origem) === 'diretorio' ? listarArquivos(origem) : [];
  if (restantes.length && !vinculado) problemas.push(`${restantes.length} arquivo(s) ainda no diretório legado`);
  const novos = estadoDestino === 'invalido' || !fs.existsSync(destino) ? [] : listarArquivos(destino);
  const conferir = (item, padrao, tipo) => {
    const rel = String(item.rel || '');
    if (!padrao.test(rel)) { problemas.push(`${tipo} com chave inválida no banco`); return null; }
    const abs = path.join(destino, rel);
    if (!fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) { problemas.push(`${tipo} ausente no diretório novo: ${rel}`); return null; }
    if (item.bytes !== null && item.bytes !== undefined && fs.statSync(abs).size !== item.bytes) {
      problemas.push(`${tipo} com tamanho divergente: ${rel}`);
      return null;
    }
    return abs;
  };
  let hashesConferidos = 0;
  for (const a of banco.assets) {
    const abs = conferir(a, ASSET_RE, 'asset');
    if (!abs) continue;
    if (sha256(abs) !== a.sha256) problemas.push(`asset com sha256 divergente: ${a.rel}`);
    else hashesConferidos += 1;
  }
  const refsUnicas = new Map();
  for (const r of banco.referencias) {
    const atual = refsUnicas.get(r.rel);
    if (!atual || (atual.bytes === null && r.bytes !== null)) refsUnicas.set(r.rel, r);
  }
  let referenciasOk = 0;
  for (const r of refsUnicas.values()) if (conferir(r, REF_RE, 'referência')) referenciasOk += 1;
  return {
    status: problemas.length ? 'FAIL' : vinculado ? 'PASS-VINCULADO' : 'PASS',
    estado: vinculado ? 'vinculado' : 'separado',
    legadoRestante: restantes.length,
    arquivosNoDestino: novos.length,
    assets: banco.assets.length,
    hashesConferidos,
    referencias: refsUnicas.size,
    referenciasOk,
    problemas,
  };
}

function lerArgs(argv) {
  const valor = (nome) => { const i = argv.indexOf(nome); return i === -1 ? undefined : argv[i + 1]; };
  const o = {
    uploads: valor('--uploads'), de: valor('--de'), para: valor('--para'),
    aplicar: argv.includes('--aplicar'), verificar: argv.includes('--verificar'),
    vincular: argv.includes('--vincular'), desvincular: argv.includes('--desvincular'),
  };
  if (o.verificar && (o.aplicar || o.vincular || o.desvincular)) throw new Error('--verificar não vai junto com --aplicar, --vincular ou --desvincular');
  if (o.vincular && o.desvincular) throw new Error('--vincular e --desvincular não vão juntos');
  if (o.desvincular && !o.aplicar) throw new Error('--desvincular exige --aplicar (simule sem as duas opções)');
  return o;
}

async function main(argv, env) {
  const o = lerArgs(argv);
  const rotulo = `tenant/${o.de} → tenant/${o.para}`;
  if (o.verificar) {
    if (!env.DATABASE_URL) {
      console.error('criativos: DATABASE_URL ausente (a verificação confere as referências do banco)');
      return 2;
    }
    validar(o);
    let banco;
    try {
      banco = await lerReferenciasDoBanco(env.DATABASE_URL, o.para);
    } catch (err) {
      // Só o código: a mensagem do driver pode conter host/usuário.
      console.error(`criativos: leitura do banco falhou (${(err && (err.code || err.name)) || 'erro'})`);
      return 1;
    }
    const r = verificarCriativos(o, banco);
    console.log(`criativos: verificação ${rotulo}`);
    console.log(`  estado: ${r.estado}`);
    console.log(`  legado restante: ${r.legadoRestante} · arquivos no destino: ${r.arquivosNoDestino}`);
    console.log(`  assets no banco: ${r.assets} · sha256 conferidos: ${r.hashesConferidos}`);
    console.log(`  referências no banco: ${r.referencias} · presentes: ${r.referenciasOk}`);
    for (const p of r.problemas.slice(0, 50)) console.log(`  - ${p}`);
    if (r.problemas.length > 50) console.log(`  - … e mais ${r.problemas.length - 50}`);
    console.log(`criativos: ${r.status}`);
    return r.status === 'FAIL' ? 1 : 0;
  }
  if (o.vincular) {
    const v = vincularCriativos(o, { aplicar: o.aplicar });
    if (v.acao === 'nada') console.log(`criativos: nada a vincular (${v.motivo})`);
    else console.log(`criativos: vínculo tenant/${o.para} → tenant/${o.de} · ${v.arquivos} arquivo(s) no legado`
      + `${v.criarOrigem ? ' · legado criado vazio' : ''}${v.aplicado ? '' : ' (simulação; use --aplicar)'}`);
    return 0;
  }
  const r = moverCriativos({ ...o }, { aplicar: o.aplicar });
  if (r.acao === 'nada') {
    console.log(`criativos: nada a mover (${r.motivo})`);
    return 0;
  }
  if (r.desvinculado) console.log(`criativos: vínculo tenant/${o.para} removido`);
  if (r.aplicado) console.log(`criativos: ${rotulo} · ${r.movidos} movido(s) · ${r.duplicadosRemovidos} duplicado(s) idêntico(s) removido(s) da origem`);
  else console.log(`criativos: ${rotulo} · ${r.mover.length} a mover · ${r.iguais.length} já idêntico(s) no destino (simulação; use --aplicar)`);
  return 0;
}

const ehPrincipal = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (ehPrincipal) {
  main(process.argv.slice(2), process.env).then(
    (codigo) => process.exit(codigo),
    (err) => { console.error(`criativos: ${err.message}`); process.exit(1); }
  );
}
