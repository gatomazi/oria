'use strict';

// Mapeamento EXPLÍCITO do dado legado para Organizations (Fase 1 · PD-019).
//
// A base atual não tem dono por linha. Ela ganha dono por uma declaração do operador, nunca por
// dedução. PD-019 admite dois estados, e os dois são só entradas diferentes para o mesmo código:
//
//   A — três Stores independentes  → três Organizations, cada loja legada mapeada à sua
//   B — operação consolidada        → uma Organization, as três lojas legadas mapeadas a ela
//
// Proibido, por escrito (INV-09): "só existe uma Organization, então é dela". Com uma Organization e
// uma loja sem mapeamento, o resultado é ERRO — igual a com três. A cobertura é verificada no banco,
// por `tenancy_exigir_cobertura()` (migrations/sql/0004-tenancy-colunas.sql).
//
// Formato (versão 1):
//
//   {
//     "versao": 1,
//     "organizations": [
//       { "id": "<uuid>", "nome": "Use Sul",
//         "store": { "id": "<uuid>", "nome": "Use Sul", "lojaLegada": "sul" } }
//     ],
//     "mapeamentos": [
//       { "tipo": "loja",            "chave": "sul",             "organizationId": "<uuid>" },
//       { "tipo": "sem_loja",        "chave": "webhook_eventos", "organizationId": "<uuid>" },
//       { "tipo": "instalacao",      "chave": "*",               "organizationId": "<uuid>" },
//       { "tipo": "meta",            "chave": "*",               "organizationId": "<uuid>" },
//       { "tipo": "google_ads",      "chave": "*",               "organizationId": "<uuid>" },
//       { "tipo": "creative_tenant", "chave": "default",         "organizationId": "<uuid>" }
//     ]
//   }
//
// Lista, não objeto, de propósito: `JSON.parse` descarta chave duplicada em silêncio, e chave
// duplicada é exatamente a ambiguidade que precisa reprovar.

const fs = require('fs');
const manifesto = require('./tenancy-manifest');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAVE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const TIPOS_UNICOS = Object.freeze(['instalacao', 'meta', 'google_ads']);
const TIPOS = Object.freeze(['loja', 'sem_loja', 'creative_tenant', ...TIPOS_UNICOS]);

class TenancyMappingError extends Error {
  constructor(message, detalhes = []) {
    super(detalhes.length ? `${message}\n  - ${detalhes.join('\n  - ')}` : message);
    this.name = 'TenancyMappingError';
    this.detalhes = detalhes;
  }
}

function uuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Valida a forma e a coerência interna. Devolve uma cópia normalizada ou lança com TODOS os erros.
function validarMapeamento(entrada) {
  const erros = [];
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) {
    throw new TenancyMappingError('mapeamento de tenancy precisa ser um objeto JSON');
  }
  if (entrada.versao !== 1) erros.push(`versao ${JSON.stringify(entrada.versao)} não suportada (esperado 1)`);

  const orgs = Array.isArray(entrada.organizations) ? entrada.organizations : null;
  const maps = Array.isArray(entrada.mapeamentos) ? entrada.mapeamentos : null;
  if (!orgs || !orgs.length) erros.push('organizations precisa ser uma lista não vazia');
  if (!maps) erros.push('mapeamentos precisa ser uma lista');
  if (erros.length) throw new TenancyMappingError('mapeamento de tenancy inválido', erros);

  const orgIds = new Set();
  const storeIds = new Set();
  const lojasDeStore = new Map();
  const organizations = [];
  for (const [i, o] of orgs.entries()) {
    const onde = `organizations[${i}]`;
    if (!uuid(o?.id)) { erros.push(`${onde}.id não é UUID`); continue; }
    if (orgIds.has(o.id)) erros.push(`${onde}.id duplicado: ${o.id}`);
    orgIds.add(o.id);
    if (typeof o.nome !== 'string' || !o.nome.trim()) erros.push(`${onde}.nome vazio`);
    else if (o.nome.includes('$') || o.nome.length > 200) erros.push(`${onde}.nome inválido (sem "$", até 200)`);
    const s = o.store;
    // V1: 1 Organization = 1 Store (PD-002). Sem store, ou com lista de stores, é erro.
    if (!s || typeof s !== 'object' || Array.isArray(s)) { erros.push(`${onde}.store ausente (V1 é 1:1)`); continue; }
    if (!uuid(s.id)) erros.push(`${onde}.store.id não é UUID`);
    else if (storeIds.has(s.id)) erros.push(`${onde}.store.id duplicado: ${s.id}`);
    storeIds.add(s.id);
    if (typeof s.nome !== 'string' || !s.nome.trim()) erros.push(`${onde}.store.nome vazio`);
    else if (s.nome.includes('$') || s.nome.length > 200) erros.push(`${onde}.store.nome inválido (sem "$", até 200)`);
    const loja = s.lojaLegada ?? null;
    if (loja !== null) {
      if (typeof loja !== 'string' || !CHAVE_RE.test(loja)) erros.push(`${onde}.store.lojaLegada inválida`);
      else if (lojasDeStore.has(loja)) erros.push(`lojaLegada "${loja}" reivindicada por duas stores — ambíguo`);
      else lojasDeStore.set(loja, o.id);
    }
    organizations.push({
      id: o.id,
      nome: String(o.nome || '').trim(),
      store: { id: s.id, nome: String(s.nome || '').trim(), lojaLegada: loja },
    });
  }

  const tabelasSemLoja = new Set(
    manifesto.TABELAS_TENANT.filter((x) => x.regra === 'loja_ou_sem_loja').map((x) => x.tabela)
  );
  const vistos = new Map();
  const mapeamentos = [];
  for (const [i, m] of maps.entries()) {
    const onde = `mapeamentos[${i}]`;
    if (!TIPOS.includes(m?.tipo)) { erros.push(`${onde}.tipo inválido: ${JSON.stringify(m?.tipo)}`); continue; }
    const chave = m.chave;
    if (TIPOS_UNICOS.includes(m.tipo)) {
      if (chave !== '*') erros.push(`${onde}: tipo ${m.tipo} exige chave "*"`);
    } else if (typeof chave !== 'string' || !CHAVE_RE.test(chave)) {
      erros.push(`${onde}.chave inválida: ${JSON.stringify(chave)}`);
    }
    if (m.tipo === 'sem_loja' && !tabelasSemLoja.has(chave)) {
      erros.push(`${onde}: sem_loja só vale para ${[...tabelasSemLoja].join(', ')} (recebi ${chave})`);
    }
    if (!orgIds.has(m.organizationId)) {
      erros.push(`${onde}.organizationId não está em organizations: ${m.organizationId}`);
    }
    const id = `${m.tipo}:${chave}`;
    if (vistos.has(id)) {
      erros.push(`${id} mapeado mais de uma vez (${vistos.get(id)} e ${m.organizationId}) — ambíguo`);
      continue;
    }
    vistos.set(id, m.organizationId);
    mapeamentos.push({ tipo: m.tipo, chave, organizationId: m.organizationId });
  }

  // A loja legada da store precisa estar mapeada para a MESMA Organization.
  for (const [loja, org] of lojasDeStore) {
    const mapeada = vistos.get(`loja:${loja}`);
    if (!mapeada) erros.push(`store com lojaLegada "${loja}" sem mapeamento loja:${loja}`);
    else if (mapeada !== org) erros.push(`lojaLegada "${loja}" é da org ${org} mas loja:${loja} aponta para ${mapeada}`);
  }

  if (erros.length) throw new TenancyMappingError('mapeamento de tenancy inválido', erros);
  return { versao: 1, organizations, mapeamentos };
}

function lerMapeamentoDeArquivo(caminho) {
  let bruto;
  try {
    bruto = fs.readFileSync(caminho, 'utf8');
  } catch (err) {
    throw new TenancyMappingError(`não foi possível ler o mapeamento de tenancy em ${caminho}: ${err.code || err.message}`);
  }
  let json;
  try {
    json = JSON.parse(bruto);
  } catch (err) {
    throw new TenancyMappingError(`mapeamento de tenancy não é JSON válido: ${err.message}`);
  }
  return validarMapeamento(json);
}

// O que o CÓDIGO ATUAL grava sem informar organization_id e que, portanto, o trigger precisa saber
// resolver — mesmo que o dado ainda não exista. Sem isto, um mapeamento que cobre só o dado de hoje
// passaria na migration e quebraria no primeiro INSERT de uma loja ou tenant ainda vazio.
function itensExigidosPeloRuntime({ creativeTenant = 'default' } = {}) {
  return [
    ...manifesto.LOJAS_LEGADAS.map((l) => `loja:${l}`),
    ...manifesto.TABELAS_TENANT.filter((x) => x.regra === 'loja_ou_sem_loja').map((x) => `sem_loja:${x.tabela}`),
    ...TIPOS_UNICOS.map((t) => `${t}:*`),
    `creative_tenant:${String(creativeTenant).toLowerCase()}`,
  ];
}

function verificarCompletudeRuntime(mapeamento, opcoes) {
  const tem = new Set(mapeamento.mapeamentos.map((x) => `${x.tipo}:${x.chave}`));
  const faltando = itensExigidosPeloRuntime(opcoes).filter((i) => !tem.has(i));
  if (faltando.length) {
    throw new TenancyMappingError(
      'mapeamento de tenancy incompleto para o código em execução (nada é deduzido)', faltando
    );
  }
}

// Literal SQL de um valor já validado (UUID, chave restrita ou nome sem `$`). Aspas dobradas; o
// servidor roda com standard_conforming_strings, então barra invertida é literal.
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

// SQL que grava organizations, stores e mapeamentos. Idempotente para o MESMO conteúdo; divergência
// com o que já está no banco aborta — nunca sobrescreve um dono já declarado. É SQL enfileirado (não
// consulta imediata) para a migration continuar honesta sob `--dry-run`.
function sqlAplicarMapeamento(entrada) {
  const m = validarMapeamento(entrada);
  const passos = [];
  for (const o of m.organizations) {
    passos.push(`INSERT INTO organizations (id, nome) VALUES (${lit(o.id)}, ${lit(o.nome)}) ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = ${lit(o.id)} AND nome = ${lit(o.nome)}) THEN
    RAISE EXCEPTION 'tenancy: organization % já existe com outro nome', ${lit(o.id)};
  END IF;
  INSERT INTO stores (id, organization_id, nome, loja_legada)
    VALUES (${lit(o.store.id)}, ${lit(o.id)}, ${lit(o.store.nome)}, ${lit(o.store.lojaLegada)})
    ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM stores WHERE id = ${lit(o.store.id)} AND organization_id = ${lit(o.id)}
                  AND loja_legada IS NOT DISTINCT FROM ${lit(o.store.lojaLegada)}) THEN
    RAISE EXCEPTION 'tenancy: store % já existe com outra organization ou loja', ${lit(o.store.id)};
  END IF;`);
  }
  for (const x of m.mapeamentos) {
    passos.push(`INSERT INTO tenancy_mapeamentos (tipo, chave, organization_id)
    VALUES (${lit(x.tipo)}, ${lit(x.chave)}, ${lit(x.organizationId)}) ON CONFLICT (tipo, chave) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = ${lit(x.tipo)} AND chave = ${lit(x.chave)}
                  AND organization_id = ${lit(x.organizationId)}) THEN
    RAISE EXCEPTION 'tenancy: %:% já pertence a outra organization — nada foi sobrescrito', ${lit(x.tipo)}, ${lit(x.chave)};
  END IF;`);
  }
  return `DO $mapeamento$\nBEGIN\n  ${passos.join('\n  ')}\nEND\n$mapeamento$;\n`;
}

module.exports = {
  TIPOS,
  TenancyMappingError,
  validarMapeamento,
  lerMapeamentoDeArquivo,
  sqlAplicarMapeamento,
  itensExigidosPeloRuntime,
  verificarCompletudeRuntime,
};
