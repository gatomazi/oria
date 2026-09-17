#!/usr/bin/env node
// Seed EXPLÍCITO de entitlements por Organization — OPS-21 (TD-012 V1; rodada 19 §9).
//
//   ENTITLEMENTS_SEED_ORGANIZATION_IDS   Organizations (vírgula). Nada é deduzido: sem id, nada acontece.
//   ENTITLEMENTS_SEED_PROFILE            arquivo de PERFIL (dados, versionado) com a lista de features a
//                                        LIGAR — ex.: config/entitlements/tenant1-entitlements.json.
//                                        É o contrato do rollout.
//   ENTITLEMENTS_SEED_FEATURES           forma antiga (lista por vírgula). Aceita para ensaio/teste;
//                                        junto com o perfil é ambíguo e reprova.
//
// Formato do perfil (versão 1):
//   { "versao": 1, "perfil": "nome-do-perfil", "descricao": "...", "features": ["catalog", ...] }
//
// Regras (as duas formas passam pela mesma validação):
//   - feature fora do vocabulário fechado de lib/platform/entitlements.js → erro;
//   - feature que não está `implementada` no registry (em_breve / nao_implementada) → erro;
//   - curinga (`*`, `all`, `todas`, `tudo`, `default`) ou chave de perfil fora do formato
//     (`all: true`, `default: true`, ...) → erro;
//   - lista vazia → erro (nada é ligado por omissão).
// Liga só o que foi listado; não desliga nada, não inventa default. Feature não listada continua
// ausente do plano — e ausência nega. Idempotente: a segunda execução informa "nada mudou".
// A saída traz só nomes de feature, estado e ids de Organization — nunca valor de variável.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { FEATURES, ESTADO_DAS_FEATURES } = require('../../lib/platform/entitlements.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOME_PERFIL_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CAMPOS_DO_PERFIL = Object.freeze(['versao', 'perfil', 'descricao', 'features']);
const CURINGAS = Object.freeze(['*', 'all', 'todas', 'tudo', 'default']);
const lista = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

export class SeedEntitlementsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedEntitlementsError';
  }
}

// Valida a lista a ligar contra o registry canônico. Devolve a lista ordenada; senão, lança com
// todos os problemas de uma vez.
export function validarFeaturesDoSeed(features, origem = 'features') {
  if (!Array.isArray(features) || !features.length) {
    throw new SeedEntitlementsError(`${origem}: lista de features vazia ou inválida — nada é ligado por omissão`);
  }
  const erros = [];
  const naoTexto = features.filter((f) => typeof f !== 'string');
  if (naoTexto.length) erros.push(`${naoTexto.length} item(ns) que não são nome de feature`);
  const nomes = features.filter((f) => typeof f === 'string');
  const desconhecidas = nomes.filter((f) => !FEATURES.includes(f));
  const curinga = desconhecidas.some((f) => CURINGAS.includes(f.trim().toLowerCase()));
  if (desconhecidas.length) {
    erros.push(`feature fora do vocabulário: ${desconhecidas.join(', ')}${curinga ? ' (curinga proibido: liste cada feature)' : ''}`);
  }
  const naoImplementadas = nomes.filter((f) => FEATURES.includes(f) && ESTADO_DAS_FEATURES[f] !== 'implementada');
  if (naoImplementadas.length) {
    erros.push(`feature não implementada (não pode ser semeada): ${naoImplementadas.map((f) => `${f} (${ESTADO_DAS_FEATURES[f]})`).join(', ')}`);
  }
  const repetidas = nomes.filter((f, i) => nomes.indexOf(f) !== i);
  if (repetidas.length) erros.push(`feature repetida: ${[...new Set(repetidas)].join(', ')}`);
  if (erros.length) throw new SeedEntitlementsError(`${origem}: ${erros.join('; ')}`);
  return [...nomes].sort();
}

export function validarPerfilDeEntitlements(json, origem = 'perfil') {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new SeedEntitlementsError(`${origem}: o perfil precisa ser um objeto JSON`);
  }
  const erros = [];
  const extras = Object.keys(json).filter((k) => !CAMPOS_DO_PERFIL.includes(k));
  if (extras.length) {
    const curinga = extras.filter((k) => CURINGAS.includes(k.toLowerCase()) || /default/i.test(k));
    erros.push(curinga.length
      ? `curinga/default proibido no perfil (liste cada feature em "features"): ${curinga.join(', ')}`
      : `campos não aceitos: ${extras.join(', ')}`);
  }
  if (json.versao !== 1) erros.push(`versao ${JSON.stringify(json.versao)} não suportada (esperado 1)`);
  if (typeof json.perfil !== 'string' || !NOME_PERFIL_RE.test(json.perfil)) erros.push('perfil precisa ser um nome (minúsculas, dígitos e hífen)');
  if (json.descricao !== undefined && typeof json.descricao !== 'string') erros.push('descricao precisa ser texto');
  if (!Array.isArray(json.features)) erros.push('features precisa ser uma LISTA de nomes (objeto com true/false não é aceito)');
  if (erros.length) throw new SeedEntitlementsError(`${origem}: ${erros.join('; ')}`);
  return { perfil: json.perfil, features: validarFeaturesDoSeed(json.features, origem) };
}

export function lerPerfilDeEntitlements(caminho) {
  const arquivo = path.resolve(String(caminho || '').trim());
  const nome = path.basename(arquivo);
  let bruto;
  try {
    bruto = fs.readFileSync(arquivo, 'utf8');
  } catch (err) {
    throw new SeedEntitlementsError(`perfil ${nome}: não foi possível ler (${err.code || 'erro'})`);
  }
  let json;
  try {
    json = JSON.parse(bruto);
  } catch {
    throw new SeedEntitlementsError(`perfil ${nome}: não é JSON válido`);
  }
  return { ...validarPerfilDeEntitlements(json, `perfil ${nome}`), arquivo };
}

// Compara a lista da forma antiga (texto com vírgulas) com as features do perfil. Só nomes.
// A RELEASE B (31a7cdb) só lê ENTITLEMENTS_SEED_FEATURES; o perfil continua sendo a fonte da verdade,
// e a variável só vale se for EXATAMENTE a lista dele.
export function compararListaComPerfil(texto, featuresDoPerfil) {
  const itens = lista(texto);
  const esperado = [...featuresDoPerfil].sort();
  const faltando = esperado.filter((f) => !itens.includes(f));
  const extras = itens.filter((f) => !esperado.includes(f));
  const repetidas = [...new Set(itens.filter((f, i) => itens.indexOf(f) !== i))];
  return {
    iguais: !faltando.length && !extras.length && !repetidas.length && itens.length > 0,
    esperado: esperado.join(','),
    faltando,
    extras,
    repetidas,
  };
}

// Lista a ligar a partir do ambiente: o perfil (contrato do rollout) ou a forma antiga. As duas juntas
// só valem se forem a MESMA lista (a variável antiga fica no ambiente desde a RELEASE B) — senão, erro.
export function featuresDoAmbiente(env = process.env) {
  const perfil = String(env.ENTITLEMENTS_SEED_PROFILE || '').trim();
  const soltas = lista(env.ENTITLEMENTS_SEED_FEATURES);
  if (perfil) {
    const p = lerPerfilDeEntitlements(perfil);
    if (soltas.length) {
      const c = compararListaComPerfil(env.ENTITLEMENTS_SEED_FEATURES, p.features);
      if (!c.iguais) {
        const dif = [c.faltando.length && `faltando: ${c.faltando.join(', ')}`, c.extras.length && `a mais: ${c.extras.join(', ')}`,
          c.repetidas.length && `repetidas: ${c.repetidas.join(', ')}`].filter(Boolean).join('; ');
        throw new SeedEntitlementsError(`ENTITLEMENTS_SEED_FEATURES diverge do perfil ${p.perfil} (${dif}) — ambíguo; esperado: ${c.esperado}`);
      }
    }
    return { perfil: p.perfil, arquivo: p.arquivo, features: p.features };
  }
  if (soltas.length) return { perfil: null, arquivo: null, features: validarFeaturesDoSeed(soltas, 'ENTITLEMENTS_SEED_FEATURES') };
  return null;
}

export async function seedEntitlements(url, env = process.env) {
  const orgs = lista(env.ENTITLEMENTS_SEED_ORGANIZATION_IDS);
  const temLista = Boolean(String(env.ENTITLEMENTS_SEED_PROFILE || '').trim() || lista(env.ENTITLEMENTS_SEED_FEATURES).length);
  if (!orgs.length && !temLista) return { feito: false, motivo: 'sem configuração de seed' };
  if (!orgs.length) throw new SeedEntitlementsError('seed de entitlements incompleto: falta ENTITLEMENTS_SEED_ORGANIZATION_IDS');
  if (!temLista) throw new SeedEntitlementsError('seed de entitlements incompleto: falta ENTITLEMENTS_SEED_PROFILE (ou ENTITLEMENTS_SEED_FEATURES)');
  const invalidas = orgs.filter((o) => !UUID_RE.test(o));
  if (invalidas.length) throw new SeedEntitlementsError(`ENTITLEMENTS_SEED_ORGANIZATION_IDS com id inválido: ${invalidas.join(', ')}`);
  if (new Set(orgs).size !== orgs.length) throw new SeedEntitlementsError('ENTITLEMENTS_SEED_ORGANIZATION_IDS com id repetido');
  const { perfil, features } = featuresDoAmbiente(env);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const ligadasAgora = {};
  try {
    await client.query('BEGIN');
    for (const org of orgs) {
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [org]);
      const { rows } = await client.query('SELECT 1 FROM organizations WHERE id = $1', [org]);
      if (!rows.length) throw new SeedEntitlementsError(`Organization inexistente: ${org}`);
      const { rows: atual } = await client.query(
        `SELECT valor FROM app_config WHERE organization_id = $1 AND chave = 'entitlements' FOR UPDATE`, [org]
      );
      const antes = atual.length && atual[0].valor && typeof atual[0].valor === 'object' && !Array.isArray(atual[0].valor) ? atual[0].valor : {};
      ligadasAgora[org] = features.filter((f) => antes[f] !== true);
      if (atual.length && !ligadasAgora[org].length) continue;
      const ligar = JSON.stringify(Object.fromEntries(features.map((f) => [f, true])));
      await client.query(
        `INSERT INTO app_config (organization_id, chave, valor, atualizado_em)
         VALUES ($1, 'entitlements', $2::jsonb, now())
         ON CONFLICT (organization_id, chave) DO UPDATE
           SET valor = (CASE WHEN jsonb_typeof(app_config.valor) = 'object' THEN app_config.valor ELSE '{}'::jsonb END) || EXCLUDED.valor,
               atualizado_em = now()`,
        [org, ligar]
      );
    }
    await client.query('COMMIT');
    return { feito: true, organizations: orgs, features, perfil, ligadasAgora };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

// Linhas do relatório: nomes e estado, nada além.
export function relatorio(r) {
  if (!r.feito) return [`entitlements: nada a fazer (${r.motivo})`];
  const linhas = [`entitlements: ${r.perfil ? `perfil ${r.perfil}` : 'lista ENTITLEMENTS_SEED_FEATURES'} · ON: ${r.features.join(', ')}`];
  for (const org of r.organizations) {
    const novas = r.ligadasAgora[org] || [];
    linhas.push(`entitlements: ${org}: ${novas.length ? `ligadas agora: ${novas.join(', ')}` : 'nada mudou'}`);
  }
  const fora = FEATURES.filter((f) => !r.features.includes(f));
  if (fora.length) linhas.push(`entitlements: não ligadas por este seed: ${fora.map((f) => `${f} (${ESTADO_DAS_FEATURES[f]})`).join(', ')}`);
  return linhas;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL ausente');
    process.exit(2);
  }
  seedEntitlements(process.env.DATABASE_URL)
    .then((r) => { for (const l of relatorio(r)) console.log(l); })
    .catch((err) => {
      // Erro de validação sai inteiro (só nomes); erro de banco sai só com o código.
      console.error(`entitlements: ${err instanceof SeedEntitlementsError ? err.message : `falhou (${err.code || err.name})`}`);
      process.exit(1);
    });
}
