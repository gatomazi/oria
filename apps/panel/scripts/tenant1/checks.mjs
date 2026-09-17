// Fase 6 · Tenant #1 — o que preflight e verify conferem.
//
// Cada item sai como PASS, FAIL, PEND ou INFO:
//   PASS  o estado já é o esperado
//   FAIL  bloqueia: o apply aborta sem escrever; o verify reprova
//   PEND  o apply resolve (só no preflight; no verify, PEND vira FAIL)
//   INFO  fato que o operador precisa ver, sem decidir por ele (não muda o resultado)
//
// Somente leitura: a conexão vem de `urlSomenteLeitura` e os imports são chamados em simulação.
// Nenhum detalhe carrega segredo — só ids, contagens, provider/tipo e nomes de variáveis.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { RAIZ, CENARIO_ALVO_ROLLOUT, RELEASE_B } from './config.mjs';
import { planejarMovimento, verificarCriativos, lerReferenciasDoBanco } from '../tenancy/mover-criativos.mjs';
import { importarLegado } from '../integrations/import-legacy.mjs';
import { importarRemetenteWhatsapp } from '../integrations/import-whatsapp-sender.mjs';
import { compararListaComPerfil } from '../tenancy/seed-entitlements.mjs';

const require = createRequire(import.meta.url);
const pg = require('pg');
const manifesto = require('../../lib/platform/tenancy-manifest.js');
const gates = require('../../lib/platform/tenancy-gates.js');
const { FUNCOES_DA_APLICACAO } = require('../../lib/platform/app-role.js');
const { createKeyring } = require('../../lib/secrets/keyring.js');
const { ENV_IMPORTACAO_INK } = require('../../lib/platform/integrations.js');
const { procurarBypass } = require('./sem-bypass.cjs');

export const ACAO_TENANT1 = 'tenant1.apply';
export const ACAO_ROLLBACK = 'tenant1.rollback';
const FLAGS_LEGADAS = Object.freeze(['ALLOW_LEGACY_INTEGRATION_ENV', 'ENCRYPTION_ALLOW_LEGACY_SESSION_KEY', 'ALLOW_LEGACY_ADMIN_PASSWORD', 'DB_ENFORCE_APP_ROLE']);
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_DETALHE = 8;

const lista = (xs) => (xs.length > MAX_DETALHE ? `${xs.slice(0, MAX_DETALHE).join('; ')}; … (+${xs.length - MAX_DETALHE})` : xs.join('; '));
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function migrationsEsperadas() {
  return fs.readdirSync(path.join(RAIZ, 'migrations'))
    .filter((f) => /^\d+_[\w-]+\.js$/.test(f))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();
}

// Tabelas com coluna `loja` (dono pela loja legada).
const TABELAS_COM_LOJA = manifesto.TABELAS_TENANT.filter((x) => x.regra === 'loja' || x.regra === 'loja_ou_sem_loja').map((x) => x.tabela);

// §2 (rodada 19): o número atual é de quem o arquivo DECLARA. Função pura (testada com controle
// negativo): nada aqui escolhe dono pelo "único número que existe".
//   whatsapp: null     → FAIL se houver remetente legado no ambiente ou posse de WABA/número no banco
//   whatsapp declarado → o ambiente legado precisa ser exatamente o par declarado, e a posse que já
//                        existir para esse par precisa ser da Organization declarada
export function conferirDeclaracaoWhatsapp({ cfg, env = {}, claims = [] }) {
  const id = 'whatsapp.declaracao';
  const envNumero = String(env.WHATSAPP_LEGACY_PHONE_NUMBER_ID || '').trim();
  const envWaba = String(env.WHATSAPP_LEGACY_WABA_ID || '').trim();
  const posses = claims.filter((c) => c.provider === 'whatsapp');
  const problemas = [];
  if (!cfg.whatsapp) {
    if (envNumero || envWaba) problemas.push('remetente legado no ambiente (WHATSAPP_LEGACY_*) sem declaração no arquivo — declare whatsapp.waba e whatsapp.phoneNumber');
    if (posses.length) problemas.push(`${posses.length} posse(s) de WABA/número no banco sem declaração no arquivo`);
    return problemas.length
      ? [{ status: 'FAIL', id, detalhe: problemas.join('; ') }]
      : [{ status: 'PASS', id, detalhe: 'whatsapp: null — nenhum remetente legado no ambiente nem posse no banco' }];
  }
  const { organizationId: org, wabaId, phoneNumberId } = cfg.whatsapp;
  if (envNumero && envNumero !== phoneNumberId) problemas.push('WHATSAPP_LEGACY_PHONE_NUMBER_ID não é o número declarado em whatsapp.phoneNumber.id');
  if (envWaba && envWaba !== wabaId) problemas.push('WHATSAPP_LEGACY_WABA_ID não é a WABA declarada em whatsapp.waba.id');
  for (const c of posses) {
    const declarado = (c.tipo === 'waba' && c.external_id === wabaId) || (c.tipo === 'phone_number' && c.external_id === phoneNumberId);
    if (declarado && c.organization_id !== org) problemas.push(`posse ${c.tipo} declarada para ${org} pertence a ${c.organization_id}`);
  }
  return problemas.length
    ? [{ status: 'FAIL', id, detalhe: problemas.join('; ') }]
    : [{ status: 'PASS', id, detalhe: `WABA ${wabaId} e número ${phoneNumberId} declarados para ${org}` }];
}

function ehVinculoDeCriativos(uploads, organizationId) {
  try {
    return fs.lstatSync(path.join(uploads, 'creatives', 'tenant', organizationId)).isSymbolicLink();
  } catch {
    return false;
  }
}

// ── antes da RELEASE B (sem banco) ─────────────────────────────────────────────────────────────
// A B publica 31a7cdb: o pre-deploy dela lê só variáveis de ambiente e não conhece perfil nem par
// declarado. Aqui o HEAD confere, SEM banco, que o ambiente que a B vai ler é exatamente o que o
// arquivo de rollout declara, e imprime os valores esperados (ids e nomes; nenhum segredo).
const listaEnv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const mesmoConjunto = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

export function conferirAntesDaB({ cfg, env = {} }) {
  const itens = [];
  const add = (status, id, detalhe) => itens.push({ status, id, detalhe });
  const orgIds = cfg.organizations.map((o) => o.id).sort();
  if (cfg.rollout) add('PASS', 'rollout.alvo', `alvo de rollout declarado: PD-019 cenário ${cfg.cenario}`);
  else add('INFO', 'rollout.alvo', `ensaio (rollout: false) — o rollout usa o cenário ${CENARIO_ALVO_ROLLOUT} com rollout: true`);

  // OPS-16: o pre-deploy da B aplica o mapeamento de TENANCY_MAPPING_FILE — tem que ser o do arquivo.
  const mapaEnv = String(env.TENANCY_MAPPING_FILE || '').trim();
  if (!mapaEnv) add('FAIL', 'release-b.mapeamento', `TENANCY_MAPPING_FILE ausente (esperado: ${path.basename(cfg.arquivoMapeamento)})`);
  else {
    let igual = false;
    try {
      igual = fs.readFileSync(path.resolve(mapaEnv), 'utf8') === fs.readFileSync(cfg.arquivoMapeamento, 'utf8');
    } catch { igual = false; }
    const tenantCriativos = String(env.CREATIVE_TENANT_ID || '').trim() || 'default';
    if (tenantCriativos !== cfg.creativeTenantLegado) {
      add('FAIL', 'release-b.creative-tenant', `CREATIVE_TENANT_ID (${tenantCriativos}) diferente de creativeTenantLegado (${cfg.creativeTenantLegado}) — a migration recusaria o mapeamento`);
    }
    add(igual ? 'PASS' : 'FAIL', 'release-b.mapeamento', igual
      ? `TENANCY_MAPPING_FILE tem o mesmo conteúdo de ${path.basename(cfg.arquivoMapeamento)}`
      : `TENANCY_MAPPING_FILE não é o mapeamento do arquivo de rollout (${path.basename(cfg.arquivoMapeamento)})`);
  }

  // OPS-18: bootstrap-owner da B semeia UM owner, pelas variáveis.
  if (cfg.owners.length !== 1) add('FAIL', 'release-b.owner', `o bootstrap da RELEASE B semeia um owner; o arquivo declara ${cfg.owners.length}`);
  else {
    const [o] = cfg.owners;
    const problemas = [];
    if (String(env.AUTH_BOOTSTRAP_OWNER_EMAIL || '').trim().toLowerCase() !== o.email) problemas.push('AUTH_BOOTSTRAP_OWNER_EMAIL diferente do owner declarado');
    if (!mesmoConjunto(listaEnv(env.AUTH_BOOTSTRAP_ORGANIZATION_IDS), o.organizations)) problemas.push('AUTH_BOOTSTRAP_ORGANIZATION_IDS diferente das Organizations do owner');
    if (!String(env.AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH || '').startsWith('scrypt$1$')) problemas.push('AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH ausente ou não é hash scrypt');
    add(problemas.length ? 'FAIL' : 'PASS', 'release-b.owner', problemas.length ? problemas.join('; ') : `${o.email} → ${o.organizations.join(', ')}`);
  }

  // OPS-21: o seed da B lê só ENTITLEMENTS_SEED_FEATURES — tem que ser exatamente o perfil.
  const perfis = [...new Set(cfg.organizations.map((o) => o.entitlements.join(',')))];
  if (perfis.length !== 1) add('FAIL', 'release-b.entitlements', 'o seed da RELEASE B aplica UMA lista a todas as Organizations; o arquivo declara listas diferentes');
  else {
    // Lista única declarada (conferido acima que todas as Organizations declaram a mesma).
    const [unica] = perfis;
    const esperado = unica ? unica.split(',') : [];
    const c = compararListaComPerfil(env.ENTITLEMENTS_SEED_FEATURES, esperado);
    const orgsOk = mesmoConjunto(listaEnv(env.ENTITLEMENTS_SEED_ORGANIZATION_IDS), orgIds);
    const problemas = [];
    if (!c.iguais) {
      problemas.push(listaEnv(env.ENTITLEMENTS_SEED_FEATURES).length
        ? `ENTITLEMENTS_SEED_FEATURES diverge do perfil (${[c.faltando.length && `faltando: ${c.faltando.join(', ')}`, c.extras.length && `a mais: ${c.extras.join(', ')}`, c.repetidas.length && `repetidas: ${c.repetidas.join(', ')}`].filter(Boolean).join('; ')})`
        : 'ENTITLEMENTS_SEED_FEATURES ausente (a RELEASE B só lê esta variável)');
    }
    if (!orgsOk) problemas.push('ENTITLEMENTS_SEED_ORGANIZATION_IDS diferente das Organizations do arquivo');
    add(problemas.length ? 'FAIL' : 'PASS', 'release-b.entitlements', problemas.length
      ? `${problemas.join('; ')}; esperado: ENTITLEMENTS_SEED_FEATURES=${c.esperado}`
      : `ENTITLEMENTS_SEED_FEATURES = perfil (${esperado.length} features)`);
  }

  // OPS-29: o import da B não recebe o par declarado — o ambiente precisa ser o par.
  for (const it of conferirDeclaracaoWhatsapp({ cfg, env, claims: [] })) add(it.status, it.id, it.detalhe);
  if (cfg.whatsapp) {
    const faltam = ['WHATSAPP_LEGACY_PHONE_NUMBER_ID', 'WHATSAPP_LEGACY_WABA_ID', 'WHATSAPP_LEGACY_ACCESS_TOKEN'].filter((n) => !String(env[n] || '').trim());
    add(faltam.length ? 'FAIL' : 'PASS', 'release-b.whatsapp', faltam.length
      ? `ausentes (o import da RELEASE B falharia): ${faltam.join(', ')}`
      : `import da RELEASE B: --organization ${cfg.whatsapp.organizationId}`);
  }
  return itens;
}

// Linhas para o operador copiar no ambiente do pre-deploy da B. Só ids e nomes.
export function valoresDaReleaseB(cfg) {
  const orgIds = cfg.organizations.map((o) => o.id).sort();
  const linhas = [`VALORES para o pre-deploy da RELEASE B (${RELEASE_B.commit}) — nenhum é segredo:`];
  linhas.push(`  ENTITLEMENTS_SEED_ORGANIZATION_IDS=${orgIds.join(',')}`);
  const listas = [...new Set(cfg.organizations.map((o) => [...o.entitlements].sort().join(',')))];
  linhas.push(`  ENTITLEMENTS_SEED_FEATURES=${listas.length === 1 ? listas.join('') : '<o arquivo declara listas diferentes — a RELEASE B não serve>'}`);
  if (cfg.owners.length === 1) {
    linhas.push(`  AUTH_BOOTSTRAP_OWNER_EMAIL=${cfg.owners[0].email}`);
    linhas.push(`  AUTH_BOOTSTRAP_ORGANIZATION_IDS=${cfg.owners[0].organizations.join(',')}`);
    linhas.push(`  AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH=<valor de ${cfg.owners[0].passwordHashEnv}>`);
  }
  linhas.push(`  TENANCY_MAPPING_FILE=<caminho de ${path.basename(cfg.arquivoMapeamento)}>`);
  if (cfg.whatsapp) {
    linhas.push(`  WHATSAPP_LEGACY_WABA_ID=${cfg.whatsapp.wabaId}`);
    linhas.push(`  WHATSAPP_LEGACY_PHONE_NUMBER_ID=${cfg.whatsapp.phoneNumberId}`);
    linhas.push(`  npm run integrations:import-whatsapp-sender -- --organization ${cfg.whatsapp.organizationId} --aplicar`);
  }
  return linhas;
}

// estagio: 'head' (schema do HEAD, padrão) | 'release-b' (verify contra o schema publicado pela B:
// migrations até RELEASE_B.ultimaMigration; itens que dependem de objetos posteriores viram INFO).
export async function coletar({ url, cfg, env = process.env, uploads = null, appRole = 'oria_app', modo = 'preflight', estagio = 'head' }) {
  const naB = estagio === 'release-b';
  const itens = [];
  const add = (status, id, detalhe = '') => {
    itens.push({ status: modo === 'verify' && status === 'PEND' ? 'FAIL' : status, id, detalhe: modo === 'verify' && status === 'PEND' ? `pendente depois do apply: ${detalhe}` : detalhe });
  };
  const orgIds = cfg.organizations.map((o) => o.id);
  const orgSet = new Set(orgIds);
  // §1 (rodada 19): a validação do arquivo já recusou rollout fora do alvo; aqui fica visível.
  if (cfg.rollout) add('PASS', 'rollout.alvo', `alvo de rollout declarado: PD-019 cenário ${cfg.cenario}`);
  else add('INFO', 'rollout.alvo', `ensaio (rollout: false) — o rollout usa o cenário ${CENARIO_ALVO_ROLLOUT} com rollout: true`);

  const client = new pg.Client({ connectionString: url });
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (err) {
    add('FAIL', 'db.conexao', `não conectou (${err.code || 'erro'})`);
    return itens;
  }
  const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
  try {
    // ── banco ────────────────────────────────────────────────────────────────────────────────
    const [papel] = await q('SELECT current_user AS nome, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    add('PASS', 'db.conexao', `role ${papel.nome}`);
    if (!papel.rolsuper && !papel.rolbypassrls) {
      // Sem visão completa, a RLS FORCE filtraria as leituras e o verify passaria em silêncio.
      add('FAIL', 'db.role-operador', `${papel.nome} não tem visão de todas as Organizations (use a role de migration)`);
      return itens;
    }
    add('PASS', 'db.role-operador', 'visão completa (role de migration)');

    const temPgm = (await q("SELECT to_regclass('public.pgmigrations') IS NOT NULL AS ok"))[0].ok;
    const aplicadas = temPgm ? (await q('SELECT name FROM pgmigrations ORDER BY name')).map((r) => r.name) : [];
    const esperadas = naB ? migrationsEsperadas().filter((m) => m <= RELEASE_B.ultimaMigration) : migrationsEsperadas();
    const faltam = esperadas.filter((m) => !aplicadas.includes(m));
    const sobram = aplicadas.filter((m) => !esperadas.includes(m));
    if (faltam.length || sobram.length) {
      add('FAIL', 'db.migrations', [faltam.length && `não aplicadas: ${lista(faltam)}`, sobram.length && `desconhecidas: ${lista(sobram)}`].filter(Boolean).join(' · '));
      return itens;
    }
    add('PASS', 'db.migrations', `${aplicadas.length} aplicadas, última ${esperadas[esperadas.length - 1]}`);

    // ── Organization / Store / mapeamento ─────────────────────────────────────────────────────
    const dbOrgs = new Map((await q('SELECT id, nome, status FROM organizations')).map((r) => [r.id, r]));
    const dbStores = await q('SELECT id, organization_id, nome, loja_legada, ativa FROM stores');
    const foraDoArquivo = [...dbOrgs.keys()].filter((id) => !orgSet.has(id));
    if (foraDoArquivo.length) add('FAIL', 'tenancy.organizations-extras', `Organizations no banco fora do arquivo (ambíguo): ${lista(foraDoArquivo)}`);
    for (const o of cfg.organizations) {
      const d = dbOrgs.get(o.id);
      if (!d) add('PEND', `tenancy.organization[${o.id}]`, `criar "${o.nome}"`);
      else if (d.nome !== o.nome) add('FAIL', `tenancy.organization[${o.id}]`, 'existe com outro nome — nada é sobrescrito');
      else if (d.status !== 'active') add('FAIL', `tenancy.organization[${o.id}]`, `status ${d.status}`);
      else add('PASS', `tenancy.organization[${o.id}]`, o.nome);

      const doArquivo = dbStores.find((s) => s.id === o.store.id);
      const ativas = dbStores.filter((s) => s.organization_id === o.id && s.ativa);
      if (doArquivo && (doArquivo.organization_id !== o.id || (doArquivo.loja_legada || null) !== o.store.lojaLegada)) {
        add('FAIL', `tenancy.store[${o.id}]`, `store ${o.store.id} existe com outra Organization ou loja`);
      } else if (d && !doArquivo) {
        add('FAIL', `tenancy.store[${o.id}]`, ativas.length ? `Store ativa ${ativas[0].id} diferente da declarada` : 'Organization sem Store');
      } else if (!d) {
        add('PEND', `tenancy.store[${o.id}]`, `criar ${o.store.id} (loja legada ${o.store.lojaLegada || '—'})`);
      } else if (!doArquivo.ativa || ativas.length !== 1) {
        add('FAIL', `tenancy.store[${o.id}]`, `Store ativa: ${ativas.length} (esperado 1:1)`);
      } else {
        add('PASS', `tenancy.store[${o.id}]`, `${o.store.id} loja legada ${o.store.lojaLegada || '—'}`);
      }
    }
    const lojasDeStoresExtras = dbStores.filter((s) => !orgSet.has(s.organization_id));
    if (lojasDeStoresExtras.length) add('FAIL', 'tenancy.stores-extras', `${lojasDeStoresExtras.length} Store(s) de Organization fora do arquivo`);

    const dbMaps = await q('SELECT tipo, chave, organization_id FROM tenancy_mapeamentos ORDER BY tipo, chave');
    const chaveMap = (m) => `${m.tipo}:${m.chave}`;
    const dbPor = new Map(dbMaps.map((m) => [chaveMap(m), m.organization_id]));
    const arqPor = new Map(cfg.mapeamento.mapeamentos.map((m) => [chaveMap(m), m.organizationId]));
    const conflitos = [...arqPor].filter(([k, org]) => dbPor.has(k) && dbPor.get(k) !== org).map(([k]) => k);
    const ausentes = [...arqPor.keys()].filter((k) => !dbPor.has(k));
    const extrasMap = [...dbPor.keys()].filter((k) => !arqPor.has(k));
    if (conflitos.length) add('FAIL', 'tenancy.mapeamento', `já pertencem a outra Organization: ${lista(conflitos)}`);
    else if (extrasMap.length) add('FAIL', 'tenancy.mapeamento', `regras no banco fora do arquivo (ambíguo): ${lista(extrasMap)}`);
    else if (ausentes.length) add('PEND', 'tenancy.mapeamento', `gravar ${ausentes.length} regra(s): ${lista(ausentes)}`);
    else add('PASS', 'tenancy.mapeamento', `${dbMaps.length} regras idênticas ao arquivo`);
    const transitorias = dbMaps.filter((m) => ['instalacao', 'meta', 'google_ads', 'sem_loja'].includes(m.tipo));
    if (transitorias.length) add('INFO', 'tenancy.t04', `regras transitórias ainda declaradas (T-04 aberto): ${lista(transitorias.map(chaveMap))}`);

    if (naB) add('INFO', 'tenancy.gates', `não conferido no schema da RELEASE B (o manifesto do HEAD tem tabelas posteriores); conferir no verify do HEAD`);
    else {
      const violacoes = gates.todasAsViolacoes(await gates.inspecionarTenancy(client, manifesto));
      // Antes do apply, uma Organization ainda sem Store é esperada só se ela também não existe.
      if (violacoes.length) add('FAIL', 'tenancy.gates', `INV-04..07/1:1: ${lista(violacoes)}`);
      else add('PASS', 'tenancy.gates', 'INV-04, 05, 06, 07 e 1:1 sem violação');
    }

    const problemas = (await q('SELECT p FROM tenancy_problemas_de_ownership() AS p')).map((r) => r.p);
    const semMapa = (await q('SELECT x FROM tenancy_itens_sem_mapeamento() AS x')).map((r) => r.x);
    if (problemas.length || semMapa.length) add('FAIL', 'tenancy.orfaos', lista([...problemas, ...semMapa.map((x) => `sem dono declarado: ${x}`)]));
    else add('PASS', 'tenancy.orfaos', 'nenhuma linha órfã ou sem dono declarado');

    // Dono pela loja: a regra é FATO. Linha de loja X numa Organization que não é a dona de X é
    // reassociação — reprova.
    const divergentes = [];
    const invisiveis = [];
    for (const t of TABELAS_COM_LOJA) {
      const [r] = await q(
        `SELECT count(*) FILTER (WHERE m.organization_id IS NULL)::int AS sem_regra,
                count(*) FILTER (WHERE m.organization_id <> x.organization_id)::int AS divergentes,
                count(*) FILTER (WHERE s.loja_legada IS DISTINCT FROM x.loja)::int AS fora_da_store
           FROM ${t} x
           LEFT JOIN tenancy_mapeamentos m ON m.tipo = 'loja' AND m.chave = x.loja
           LEFT JOIN stores s ON s.organization_id = x.organization_id AND s.ativa
          WHERE x.loja IS NOT NULL`
      );
      if (r.sem_regra || r.divergentes) divergentes.push(`${t}: ${r.divergentes} de outra Organization, ${r.sem_regra} sem regra`);
      if (r.fora_da_store) invisiveis.push(`${t}: ${r.fora_da_store}`);
    }
    if (divergentes.length) add('FAIL', 'tenancy.dono-da-loja', lista(divergentes));
    else add('PASS', 'tenancy.dono-da-loja', 'toda linha com loja está na Organization dona da loja');
    if (invisiveis.length) {
      // Cenário B: histórico de Centro/Norte converge para a Organization, mas a aplicação filtra
      // pela loja da Store. Não é vazamento; é decisão de execução de PD-019 (fica com o usuário).
      add('INFO', 'tenancy.loja-fora-da-store', `linhas com loja diferente da loja da Store (a aplicação não as mostra): ${lista(invisiveis)}`);
    }

    // ── owner / membership ────────────────────────────────────────────────────────────────────
    for (const o of cfg.owners) {
      const id = `auth.owner[${o.email}]`;
      const hash = String(env[o.passwordHashEnv] || '');
      const [u] = await q('SELECT id, status FROM users WHERE email = $1', [o.email]);
      const membros = u ? await q('SELECT organization_id, papel FROM organization_members WHERE user_id = $1', [u.id]) : [];
      const owner = new Set(membros.filter((m) => m.papel === 'owner').map((m) => m.organization_id));
      const faltando = o.organizations.filter((org) => !owner.has(org));
      const indevidas = membros.map((m) => m.organization_id).filter((org) => orgSet.has(org) && !o.organizations.includes(org));
      if (u && u.status !== 'active') add('FAIL', id, 'usuário desativado — o apply não reativa ninguém');
      else if (indevidas.length) add('FAIL', id, `membership fora do declarado: ${lista(indevidas)}`);
      else if (faltando.length) {
        if (modo === 'preflight' && !hash.startsWith('scrypt$1$')) add('FAIL', id, `${o.passwordHashEnv} ausente ou não é hash scrypt (npm run auth:hash-password)`);
        else add('PEND', id, `${u ? 'confirmar' : 'criar'} owner em ${faltando.length} Organization(s)`);
      } else add('PASS', id, `owner de ${o.organizations.length} Organization(s)`);
    }
    for (const org of orgIds) {
      const [n] = await q(
        `SELECT count(*)::int AS n FROM organization_members m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND m.papel = 'owner' AND u.status = 'active'`, [org]
      );
      if (n.n > 0) add('PASS', `auth.organization-com-owner[${org}]`, `${n.n} owner(s) ativo(s)`);
      else add('PEND', `auth.organization-com-owner[${org}]`, 'nenhum owner ativo ainda');
    }

    // ── entitlements ──────────────────────────────────────────────────────────────────────────
    const planos = new Map((await q(`SELECT organization_id, valor FROM app_config WHERE chave = 'entitlements'`)).map((r) => [r.organization_id, r.valor]));
    for (const o of cfg.organizations) {
      const id = `entitlements[${o.id}]`;
      const plano = planos.get(o.id);
      if (plano !== undefined && (!plano || typeof plano !== 'object' || Array.isArray(plano))) { add('FAIL', id, 'plano gravado não é objeto'); continue; }
      const faltando = o.entitlements.filter((f) => !plano || plano[f] !== true);
      const extras = Object.keys(plano || {}).filter((f) => plano[f] === true && !o.entitlements.includes(f));
      if (faltando.length) add('PEND', id, `ligar: ${faltando.join(', ')}`);
      else add('PASS', id, o.entitlements.length ? o.entitlements.join(', ') : 'nenhuma feature declarada');
      // No rollout, o plano gravado tem que ser EXATAMENTE o perfil (o seed da B aceita qualquer
      // feature do vocabulário, então a sobra seria silenciosa). No ensaio, só informa.
      if (extras.length) {
        add(cfg.rollout ? 'FAIL' : 'INFO', `${id}.extras`, `ligadas no banco e não declaradas (o apply não desliga): ${extras.join(', ')}`);
      }
    }

    // ── integrações / segredos ────────────────────────────────────────────────────────────────
    let keyring = null;
    try {
      keyring = createKeyring(env);
    } catch (err) {
      add('FAIL', 'secrets.chave', err.message);
    }
    const escopadas = await q('SELECT organization_id, provider FROM integrations WHERE escopo IS NOT NULL ORDER BY 1, 2');
    if (escopadas.length) add('FAIL', 'integrations.escopo-legado', `integrações por escopo que a aplicação não lê: ${lista(escopadas.map((r) => `${r.organization_id}/${r.provider}`))}`);
    const duplicadas = await q(
      `SELECT organization_id, provider FROM integrations WHERE escopo IS NULL GROUP BY 1, 2 HAVING count(*) > 1`
    );
    if (duplicadas.length) add('FAIL', 'integrations.unicidade', lista(duplicadas.map((r) => `${r.organization_id}/${r.provider}`)));
    else add('PASS', 'integrations.unicidade', 'uma integração por (Organization, provider)');

    if (keyring) {
      if (!keyring.disponivel()) add('FAIL', 'secrets.chave', 'ENCRYPTION_MASTER_KEY ausente');
      else add('PASS', 'secrets.chave', `versão corrente ${keyring.versaoCorrente}`);
      const versoes = await q('SELECT key_version, count(*)::int AS n FROM integration_secrets GROUP BY 1 ORDER BY 1');
      const antigas = versoes.filter((v) => v.key_version !== keyring.versaoCorrente);
      const ilegiveis = antigas.filter((v) => !keyring.versoesDeLeitura().includes(v.key_version));
      if (ilegiveis.length) add('FAIL', 'secrets.versao', `segredos em versão sem chave de leitura: ${lista(ilegiveis.map((v) => `v${v.key_version}×${v.n}`))}`);
      else if (antigas.length) add('PEND', 'secrets.versao', `re-cifrar: ${lista(antigas.map((v) => `v${v.key_version}×${v.n}`))}`);
      else add('PASS', 'secrets.versao', `todos na versão ${keyring.versaoCorrente}`);

      if (keyring.disponivel()) {
        try {
          const rel = await importarLegado(url, { env, aplicar: false });
          const linhas = rel.organizations.flatMap((o) => o.segredos.map((s) => ({ ...s, org: o.organizationId })));
          const ileg = linhas.filter((s) => s.resultado === 'ilegivel');
          const pend = linhas.filter((s) => s.resultado === 'a_importar');
          const rot = (s) => `${s.org}/${s.provider}/${s.tipo}`;
          if (ileg.length) add('FAIL', 'integrations.legado', `ilegíveis com as chaves atuais: ${lista(ileg.map(rot))}`);
          else if (pend.length) add('PEND', 'integrations.legado', `importar ${pend.length}: ${lista(pend.map(rot))}`);
          else add('PASS', 'integrations.legado', `${linhas.length} credencial(is) legada(s) já em integration_secrets`);
        } catch (err) {
          add('FAIL', 'integrations.legado', `simulação falhou: ${err.message}`);
        }
      }
    }
    const [colunas] = await q(
      `SELECT (SELECT count(*) FROM meta_connections WHERE access_token_encrypted IS NOT NULL)::int
            + (SELECT count(*) FROM google_ads_connections WHERE refresh_token_encrypted IS NOT NULL OR access_token_encrypted IS NOT NULL)::int
            + (SELECT count(*) FROM google_analytics_connections WHERE refresh_token_encrypted IS NOT NULL OR access_token_encrypted IS NOT NULL)::int
            + (SELECT count(*) FROM creative_settings WHERE openai_key_enc IS NOT NULL)::int AS n`
    );
    if (colunas.n) add('INFO', 'legado.colunas', `${colunas.n} linha(s) com credencial na coluna antiga — o apply NÃO limpa (janela de rollback)`);

    // ── Creative Core ─────────────────────────────────────────────────────────────────────────
    if (!uploads) add('FAIL', 'creatives.arquivos', 'informe --uploads <UPLOADS_DIR> (os arquivos precisam ser conferidos)');
    else if (ehVinculoDeCriativos(uploads, cfg.donoCriativos)) {
      // OPS-22 passo 1 (runbook §7): tenant/<org> é o vínculo para o legado, da B até a materialização
      // (§13.2). Estado esperado: confere que tudo o que o banco referencia é alcançável pelo vínculo.
      try {
        const r = verificarCriativos(
          { uploads, de: cfg.creativeTenantLegado, para: cfg.donoCriativos },
          await lerReferenciasDoBanco(url, cfg.donoCriativos),
        );
        if (r.status === 'PASS-VINCULADO') {
          add('PASS', 'creatives.arquivos', `vinculado: tenant/${cfg.donoCriativos} → tenant/${cfg.creativeTenantLegado} · ${r.referenciasOk}/${r.referencias} referência(s) e ${r.hashesConferidos}/${r.assets} asset(s) alcançáveis`);
          add('INFO', 'creatives.materializacao', 'pendente: mover-criativos --desvincular --aplicar com a leitura dupla ligada (runbook §13.2)');
        } else {
          add('FAIL', 'creatives.arquivos', `vínculo presente, mas: ${lista(r.problemas)}`);
        }
      } catch (err) {
        add('FAIL', 'creatives.arquivos', err.message);
      }
    } else {
      try {
        const p = planejarMovimento({ uploads, de: cfg.creativeTenantLegado, para: cfg.donoCriativos });
        if (p.acao === 'nada') add('PASS', 'creatives.arquivos', `nada em tenant/${cfg.creativeTenantLegado} (dono declarado ${cfg.donoCriativos})`);
        else add('PEND', 'creatives.arquivos', `mover tenant/${cfg.creativeTenantLegado} → tenant/${cfg.donoCriativos}`);
      } catch (err) {
        add('FAIL', 'creatives.arquivos', err.message);
      }
    }
    const [criativosFora] = await q(
      `SELECT count(*)::int AS n FROM creative_settings WHERE tenant_id <> organization_id::text`
    );
    if (criativosFora.n) add('FAIL', 'creatives.tenant', `${criativosFora.n} linha(s) com tenant_id diferente da Organization`);
    else add('PASS', 'creatives.tenant', 'tenant do Creative Core = Organization');

    // ── WhatsApp ──────────────────────────────────────────────────────────────────────────────
    const zaps = await q(
      `SELECT i.id, i.organization_id, i.status, i.config,
              EXISTS (SELECT 1 FROM integration_secrets s WHERE s.integration_id = i.id AND s.organization_id = i.organization_id AND s.tipo = 'access_token') AS tem_token
         FROM integrations i WHERE i.provider = 'whatsapp' AND i.escopo IS NULL ORDER BY i.organization_id`
    );
    const claims = await q('SELECT provider, tipo, external_id, organization_id FROM external_resource_claims ORDER BY 1, 2, 3');
    const claimsZap = claims.filter((c) => c.provider === 'whatsapp');
    const posseProblemas = [];
    for (const c of claimsZap) {
      const campo = c.tipo === 'waba' ? 'waba_id' : 'phone_number_id';
      if (!zaps.some((z) => z.organization_id === c.organization_id && (z.config || {})[campo] === c.external_id)) {
        posseProblemas.push(`posse ${c.tipo} de ${c.organization_id} sem integração correspondente`);
      }
    }
    for (const z of naB ? [] : zaps) {
      const cfgZ = z.config || {};
      if (!cfgZ.waba_id && !cfgZ.phone_number_id) continue;
      const [r] = await q('SELECT organization_id, motivo FROM whatsapp_organization_do_remetente($1, $2)', [cfgZ.waba_id || '', cfgZ.phone_number_id || null]);
      if (!r || r.motivo !== 'ok' || r.organization_id !== z.organization_id) posseProblemas.push(`remetente de ${z.organization_id} não resolve para ela (${r ? r.motivo : 'sem resposta'})`);
    }
    if (naB) {
      // Sem posse de WABA na B: nenhuma outra Organization pode ter integração com a mesma WABA ou número.
      for (const z of zaps) {
        const cz = z.config || {};
        const iguais = zaps.filter((o) => o.id !== z.id && ((cz.waba_id && (o.config || {}).waba_id === cz.waba_id)
          || (cz.phone_number_id && (o.config || {}).phone_number_id === cz.phone_number_id)));
        if (iguais.length) posseProblemas.push(`WABA/número de ${z.organization_id} também configurado em ${iguais.map((o) => o.organization_id).join(', ')}`);
      }
    }
    if (posseProblemas.length) add('FAIL', 'whatsapp.posse', lista(posseProblemas));
    else add('PASS', 'whatsapp.posse', `${claimsZap.length} posse(s) de WABA/número coerentes com as integrações${naB ? ' (schema da RELEASE B: sem resolvedor de entrada)' : ''}`);

    for (const it of conferirDeclaracaoWhatsapp({ cfg, env, claims })) add(it.status, it.id, it.detalhe);
    if (!cfg.whatsapp) add('PASS', 'whatsapp.remetente', 'não declarado nesta execução (whatsapp: null)');
    else {
      const { organizationId: org, wabaId, phoneNumberId } = cfg.whatsapp;
      const z = zaps.find((x) => x.organization_id === org);
      // Completo = o par DECLARADO está na integração da Organization declarada, com as duas posses.
      const completo = z && z.status === 'connected' && z.tem_token && z.config
        && z.config.waba_id === wabaId && z.config.phone_number_id === phoneNumberId
        // A posse da WABA só existe a partir da migration whatsapp-inbound (D0); na B, só a do número.
        && (naB || claimsZap.some((c) => c.organization_id === org && c.tipo === 'waba' && c.external_id === wabaId))
        && claimsZap.some((c) => c.organization_id === org && c.tipo === 'phone_number' && c.external_id === phoneNumberId);
      if (naB) {
        const wabaDeOutra = claimsZap.some((c) => c.tipo === 'waba' && c.external_id === wabaId && c.organization_id !== org);
        if (completo && !wabaDeOutra) {
          add('PASS', `whatsapp.remetente[${org}]`, 'integração, token e posse do número completos no schema da RELEASE B');
          add('INFO', 'whatsapp.posse-waba', 'a posse da WABA nasce do backfill da migration 1790000000000_whatsapp-inbound (D0); conferir no verify do HEAD');
        } else {
          add('FAIL', `whatsapp.remetente[${org}]`, 'a integração da Organization declarada não tem o par declarado, token e posse do número (o import da RELEASE B não confere o par)');
        }
      }
      const outras = zaps.filter((x) => x.organization_id !== org && x.config && x.config.phone_number_id);
      if (outras.length) add('INFO', 'whatsapp.outras', `${outras.length} outra(s) Organization(s) com número próprio`);
      if (naB) { /* conferido acima */ } else if (completo && modo === 'verify') add('PASS', `whatsapp.remetente[${org}]`, 'integração, token e posse de WABA/número completos');
      else {
        try {
          const r = await importarRemetenteWhatsapp(url, { env, organizationId: org, esperado: { wabaId, phoneNumberId }, aplicar: false });
          if (r.resultado === 'ja_importado') add('PASS', `whatsapp.remetente[${org}]`, 'remetente legado já importado; posse de WABA/número completa');
          else add('PEND', `whatsapp.remetente[${org}]`, 'importar o remetente legado (WHATSAPP_LEGACY_*)');
        } catch (err) {
          add(completo ? 'PASS' : 'FAIL', `whatsapp.remetente[${org}]`, completo ? 'integração completa (ambiente legado não conferido)' : err.message);
        }
      }
    }

    // ── Ink (URL opaca) ───────────────────────────────────────────────────────────────────────
    if (naB) add('INFO', 'ink.webhook', 'URL opaca da Ink só existe a partir da RELEASE D (migration ink-webhook-token)');
    const inks = await q(
      `SELECT i.organization_id, i.config,
              EXISTS (SELECT 1 FROM integration_secrets s WHERE s.integration_id = i.id AND s.organization_id = i.organization_id AND s.tipo = 'webhook_secret') AS tem_segredo
         FROM integrations i WHERE i.provider = 'ink' AND i.escopo IS NULL`
    );
    const claimsInk = claims.filter((c) => c.provider === 'ink' && c.tipo === 'webhook_token');
    const velhas = claimsInk.filter((c) => !inks.some((i) => i.organization_id === c.organization_id && (i.config || {}).webhook_token_sha256 === c.external_id));
    if (naB) { /* sem ink_organization_do_webhook na B */ } else if (velhas.length) add('FAIL', 'ink.webhook-posse', `${velhas.length} token(s) de URL reivindicado(s) sem integração correspondente`);
    else add('PASS', 'ink.webhook-posse', `${claimsInk.length} URL(s) opaca(s) coerente(s)`);
    if (naB) { /* idem */ } else if (!cfg.inkWebhook) add('PASS', 'ink.webhook', 'não declarado nesta execução (inkWebhook: null)');
    else {
      for (const org of cfg.inkWebhook.organizations) {
        const id = `ink.webhook[${org}]`;
        const i = inks.find((x) => x.organization_id === org);
        const hash = i && i.config && i.config.webhook_token_sha256;
        const loja = cfg.organizations.find((o) => o.id === org).store.lojaLegada;
        const segredoNoAmbiente = Boolean(loja && env[ENV_IMPORTACAO_INK.webhook_secret(loja)]);
        if (hash && HASH_RE.test(hash)) {
          const [r] = await q('SELECT ink_organization_do_webhook($1) AS org', [hash]);
          if (r.org !== org) add('FAIL', id, 'a URL emitida não resolve para esta Organization');
          else if (!i.tem_segredo) add('FAIL', id, 'URL emitida sem segredo do webhook');
          else add('PASS', id, 'URL opaca emitida, resolve para a Organization, segredo cadastrado');
        } else if ((i && i.tem_segredo) || segredoNoAmbiente) {
          add('PEND', id, 'emitir a URL opaca (tela ou apply --saida-segredos)');
        } else {
          add('FAIL', id, `sem segredo do webhook (cadastre na tela${loja ? ` ou ${ENV_IMPORTACAO_INK.webhook_secret(loja)}` : ''})`);
        }
      }
    }

    // ── jobs / filas ──────────────────────────────────────────────────────────────────────────
    if (naB) add('INFO', 'jobs.leases', 'job_leases só existe a partir da D0; conferir no verify do HEAD');
    const leases = naB ? null : await q('SELECT job, organization_id, (dono IS NOT NULL AND ate > now()) AS ativo FROM job_leases');
    const leasesFora = naB ? [] : leases.filter((l) => !orgSet.has(l.organization_id));
    if (naB) { /* acima */ } else if (leasesFora.length) add('FAIL', 'jobs.leases', `${leasesFora.length} lease(s) de Organization fora do arquivo`);
    else add('PASS', 'jobs.leases', `${leases.length} lease(s), ${leases.filter((l) => l.ativo).length} ativo(s) agora`);
    const [presos] = naB ? [{ n: 0 }] : await q(
      `SELECT count(*)::int AS n FROM whatsapp_web_outbox
        WHERE status = 'claimed' AND coalesce(lease_ate, claimed_at, atualizado_em) < now() - interval '1 hour'`
    );
    if (presos.n) add('FAIL', 'jobs.fila-whatsapp-web', `${presos.n} item(ns) preso(s) em claimed — resolva antes do cutover`);
    else add('PASS', 'jobs.fila-whatsapp-web', 'sem item preso');

    // ── flags legadas / role da aplicação ─────────────────────────────────────────────────────
    const invalidas = FLAGS_LEGADAS.filter((f) => env[f] !== undefined && !['', '0', '1'].includes(String(env[f]).trim()));
    if (invalidas.length) add('FAIL', 'legado.flags', `valor inválido (use 1 ou vazio): ${invalidas.join(', ')}`);
    else {
      const ligadas = FLAGS_LEGADAS.filter((f) => String(env[f] || '').trim() === '1');
      add('PASS', 'legado.flags', ligadas.length ? `ligadas: ${ligadas.join(', ')}` : 'nenhuma flag legada ligada');
    }

    const [r] = naB ? [] : await q('SELECT rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = $1', [appRole]);
    // Rollout antes do OPS-14 (RELEASE F): a app ainda usa a role dona; a role da aplicação só é
    // exigida quando DB_ENFORCE_APP_ROLE=1 está no ambiente conferido. Ensaio: sempre exigida.
    const roleAindaNaoExigida = cfg.rollout && String(env.DB_ENFORCE_APP_ROLE || '').trim() !== '1';
    const falhaRole = (detalhe) => add(roleAindaNaoExigida ? 'INFO' : 'FAIL', 'role.app',
      roleAindaNaoExigida ? `antes do OPS-14 (DB_ENFORCE_APP_ROLE ausente): ${detalhe}` : detalhe);
    if (naB) add('INFO', 'role.app', 'role da aplicação entra só na RELEASE F (OPS-14); conferir no verify do HEAD');
    else if (!r) falhaRole(`role ${appRole} não existe (OPS-14)`);
    else {
      const problemasRole = [];
      if (r.rolsuper) problemasRole.push('SUPERUSER');
      if (r.rolbypassrls) problemasRole.push('BYPASSRLS');
      if (r.rolinherit) problemasRole.push('INHERIT');
      const sobRls = manifesto.nomesSobRls();
      const donas = await q(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($2) AND pg_has_role($1, c.relowner, 'USAGE')`, [appRole, sobRls]
      );
      if (donas.length) problemasRole.push(`dona de ${lista(donas.map((d) => d.relname))}`);
      const privadas = await q(
        `SELECT t FROM unnest($2::text[]) t WHERE to_regclass('public.' || t) IS NOT NULL
            AND (has_table_privilege($1, 'public.' || t, 'SELECT') OR has_table_privilege($1, 'public.' || t, 'INSERT')
              OR has_table_privilege($1, 'public.' || t, 'UPDATE') OR has_table_privilege($1, 'public.' || t, 'DELETE'))`,
        [appRole, manifesto.TABELAS_GLOBAIS_PRIVADAS]
      );
      if (privadas.length) problemasRole.push(`acesso a ${privadas.map((p) => p.t).join(', ')}`);
      const semDml = await q(
        `SELECT t FROM unnest($2::text[]) t WHERE NOT (has_table_privilege($1, 'public.' || t, 'SELECT')
            AND has_table_privilege($1, 'public.' || t, 'INSERT') AND has_table_privilege($1, 'public.' || t, 'UPDATE')
            AND has_table_privilege($1, 'public.' || t, 'DELETE'))`,
        [appRole, sobRls]
      );
      if (semDml.length) problemasRole.push(`sem DML em ${lista(semDml.map((x) => x.t))}`);
      const semExec = [];
      for (const f of FUNCOES_DA_APLICACAO) {
        const [e] = await q('SELECT has_function_privilege($1, $2, \'EXECUTE\') AS ok', [appRole, f]);
        if (!e.ok) semExec.push(f);
      }
      if (semExec.length) problemasRole.push(`sem EXECUTE em ${lista(semExec)}`);
      if (problemasRole.length) falhaRole(`${appRole}: ${problemasRole.join(' · ')}`);
      else add('PASS', 'role.app', `${appRole}: sem SUPERUSER/BYPASSRLS, não dona, sem acesso às globais privadas`);
    }

    // ── financeiro (atribuição fail-closed) ───────────────────────────────────────────────────
    const midia = await q(
      `SELECT 'meta' AS provider, 'ad_account' AS tipo, meta_account_id AS external_id, organization_id, loja_atribuida
         FROM meta_ad_accounts WHERE selecionada
       UNION ALL
       SELECT 'google_ads', 'customer', customer_id, organization_id, loja_atribuida
         FROM google_ads_customers WHERE selecionada`
    );
    const fin = [];
    const finInfo = [];
    const donoLoja = new Map(dbMaps.filter((m) => m.tipo === 'loja').map((m) => [m.chave, m.organization_id]));
    for (const m of midia) {
      const c = claims.find((x) => x.provider === m.provider && x.tipo === m.tipo && x.external_id === m.external_id);
      if (!c || c.organization_id !== m.organization_id) fin.push(`${m.provider} ${m.tipo} selecionado em ${m.organization_id} sem posse dela`);
      if (m.loja_atribuida) {
        if (donoLoja.get(m.loja_atribuida) !== m.organization_id) fin.push(`${m.provider} de ${m.organization_id} atribuído à loja de outra Organization`);
        const loja = (dbStores.find((s) => s.organization_id === m.organization_id && s.ativa) || {}).loja_legada;
        if (loja !== m.loja_atribuida) finInfo.push(`${m.provider} de ${m.organization_id} atribuído a loja diferente da Store (a DRE exclui)`);
      }
    }
    if (fin.length) add('FAIL', 'finance.atribuicao', lista(fin));
    else add('PASS', 'finance.atribuicao', `${midia.length} conta(s) de mídia selecionada(s) com posse e atribuição da própria Organization`);
    if (finInfo.length) add('INFO', 'finance.loja-da-store', lista(finInfo));

    // ── audit ─────────────────────────────────────────────────────────────────────────────────
    const [semSujeito] = await q(
      `SELECT count(*)::int AS n FROM audit_log WHERE action IN ($1, $2)
          AND (actor_user_id IS NULL OR actor_user_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`,
      [ACAO_TENANT1, ACAO_ROLLBACK]
    );
    if (semSujeito.n) add('FAIL', 'audit.sujeito', `${semSujeito.n} registro(s) do Tenant #1 sem sujeito real`);
    if (modo === 'verify') {
      for (const org of orgIds) {
        const [a] = await q(
          `SELECT count(*)::int AS n FROM audit_log a
             JOIN organization_members m ON m.organization_id = a.organization_id AND m.user_id::text = a.actor_user_id AND m.papel = 'owner'
            WHERE a.organization_id = $1 AND a.action = $2`, [org, ACAO_TENANT1]
        );
        if (a.n) add('PASS', `audit[${org}]`, `${a.n} registro(s) ${ACAO_TENANT1} com owner da própria Organization como sujeito`);
        // Em produção o apply não roda (os scripts do pre-deploy rodam um a um): no rollout, a falta
        // do registro é informação; no ensaio, o apply é o caminho e o registro é obrigatório.
        else if (cfg.rollout) add('INFO', `audit[${org}]`, `sem registro ${ACAO_TENANT1} (rollout em produção roda os scripts do pre-deploy, não o apply)`);
        else add('FAIL', `audit[${org}]`, `sem registro ${ACAO_TENANT1} atribuível`);
      }
    }

    // ── zero bypass ───────────────────────────────────────────────────────────────────────────
    const { achados, arquivos } = procurarBypass({ raiz: RAIZ });
    if (achados.length) add('FAIL', 'bypass.codigo', lista(achados.map((a) => `${a.padrao} em ${a.onde}`)));
    else add('PASS', 'bypass.codigo', `${arquivos} arquivos de produto sem caminho especial para a operação interna`);
    const bypassRoles = naB ? [] : await q('SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper AND rolname = $1', [appRole]);
    if (bypassRoles.length) add('FAIL', 'bypass.banco', `${appRole} com BYPASSRLS`);
    else add('PASS', 'bypass.banco', 'RLS forçada vale para a role da aplicação (ver tenancy.gates e role.app)');
    return itens;
  } finally {
    await client.end().catch(() => {});
  }
}

// Impressão digital do dado de tenant: para cada tabela, (Organization, chave primária). Serve para
// provar que rollback e re-execuções não removem linhas nem as mudam de Organization.
const TABELAS_IMPRESSAO = () => [
  ...manifesto.nomesSobRls().filter((t) => t !== 'audit_log'),
  'tenancy_mapeamentos', 'external_resource_claims', 'users',
];

export async function impressaoDigital(url) {
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => {});
  await client.connect();
  try {
    const tabelas = {};
    for (const t of TABELAS_IMPRESSAO()) {
      const pk = (await client.query(
        `SELECT a.attname FROM pg_index i
           JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY k.ord`, [`public.${t}`]
      )).rows.map((r) => r.attname);
      const colOrg = t === 'organizations' ? 'id' : (t === 'users' ? null : 'organization_id');
      const chave = pk.length ? pk.map((c) => `x.${c}::text`).join(` || '|' || `) : 'md5(row_to_json(x)::text)';
      const org = colOrg ? `x.${colOrg}::text` : `''`;
      const [r] = (await client.query(
        `SELECT count(*)::int AS n, coalesce(md5(string_agg(${org} || '#' || ${chave}, ',' ORDER BY ${org} || '#' || ${chave})), '') AS h FROM ${t} x`
      )).rows;
      tabelas[t] = r;
    }
    const audit = (await client.query('SELECT organization_id::text AS org, count(*)::int AS n FROM audit_log GROUP BY 1 ORDER BY 1')).rows;
    const resumo = sha256(JSON.stringify(tabelas));
    return { resumo, tabelas, audit: Object.fromEntries(audit.map((a) => [a.org, a.n])) };
  } finally {
    await client.end().catch(() => {});
  }
}

// Diferenças entre duas impressões. audit_log só pode crescer.
export function compararImpressoes(antes, depois) {
  const dif = [];
  for (const [t, a] of Object.entries(antes.tabelas)) {
    const d = depois.tabelas[t];
    if (!d) dif.push(`${t}: sumiu`);
    else if (a.n !== d.n || a.h !== d.h) dif.push(`${t}: ${a.n} → ${d.n} linha(s)${a.n === d.n ? ' (dono ou chave mudou)' : ''}`);
  }
  for (const [org, n] of Object.entries(antes.audit)) {
    if ((depois.audit[org] || 0) < n) dif.push(`audit_log de ${org} diminuiu`);
  }
  return dif;
}
