// Fase 6 · Tenant #1 — arquivo de mapeamento, argumentos, conexão e saída.
//
// Nada aqui escolhe cenário, Organization ou dono. O operador declara tudo num arquivo (versão 1):
//
//   {
//     "versao": 1,
//     "cenario": "A" | "B",                        // PD-019: tem que bater com --scenario
//     "rollout": true | false,                     // true = arquivo do rollout real: exige --rollout,
//                                                  //   cenário B (alvo), whatsapp declarado e perfil
//     "mapeamentoTenancy": "cenario-a.json",       // formato de lib/platform/tenancy-mapping.js
//     "creativeTenantLegado": "default",           // pasta antiga do Creative Core
//     "organizations": [{ "id": "<uuid>", "entitlements": ["financial", ...] }         // lista explícita
//                     | { "id": "<uuid>", "entitlementsProfile": "perfil.json" }],     // perfil de dados (§9)
//     "owners": [{ "email": "...", "passwordHashEnv": "NOME_DA_VARIAVEL", "organizations": ["<uuid>"] }],
//     "whatsapp": null | {                          // §2 (rodada 19): posse EXPLÍCITA do número atual
//       "waba":        { "id": "<WABA_ID>",         "organizationId": "<uuid>" },
//       "phoneNumber": { "id": "<PHONE_NUMBER_ID>", "organizationId": "<uuid>" }
//     },
//     "inkWebhook": null | { "organizations": ["<uuid>"] }
//   }
//
// `whatsapp` e `inkWebhook` são obrigatórios como CHAVE: `null` é a declaração explícita de "não faz
// parte desta execução". Ausência da chave é erro — nada é inferido.
// WhatsApp: WABA e phone_number_id são declarados um a um, com a Organization dona de cada, e
// precisam convergir para a MESMA Organization. `null` só vale se não houver remetente legado no
// ambiente nem posse no banco (conferido no preflight) — nunca "o único número que existe".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { lerPerfilDeEntitlements, validarFeaturesDoSeed } from '../tenancy/seed-entitlements.mjs';

const require = createRequire(import.meta.url);
const tm = require('../../lib/platform/tenancy-mapping.js');
const { LOJAS_LEGADAS } = require('../../lib/platform/tenancy-manifest.js');

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CENARIOS = Object.freeze(['A', 'B']);
// Rodada 19 §1 (decisão do usuário): o rollout de productização mira o cenário B de PD-019 —
// Organization "Use Origens" com Store "Use Origens"; Sul/Centro/Norte só como origem/mapping
// legado. O cenário A continua suportado e testado como ENSAIO (rollout: false). Se a realidade
// operacional mudar, isto só muda com nova confirmação do usuário.
export const CENARIO_ALVO_ROLLOUT = 'B';

// RELEASE B do runbook publica um commit ANTIGO (o pre-deploy roda os scripts dele, não os do HEAD).
// Em 31a7cdb: 17 migrations; seed só com ENTITLEMENTS_SEED_FEATURES (sem perfil, sem checar
// implementação); import do WhatsApp sem `esperado` e sem posse da WABA (a posse da WABA nasce do
// backfill da migration 1790000000000_whatsapp-inbound, na D0). O tooling do HEAD cobre o que esses
// scripts não conferem: `--estagio antes-da-b` (sem banco) e `--estagio release-b` (verify).
export const RELEASE_B = Object.freeze({ commit: '31a7cdb', ultimaMigration: '1789900000000_integrations' });
export const ESTAGIOS = Object.freeze({
  head: ['preflight', 'plan', 'apply', 'verify', 'rollback'],
  'antes-da-b': ['preflight', 'plan'],
  'release-b': ['verify'],
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{2,80}$/;
const TENANT_LEGADO_RE = /^[a-z0-9_-]{1,64}$/;
const META_ID_RE = /^[0-9]{5,32}$/;
const CHAVES = ['versao', 'cenario', 'rollout', 'mapeamentoTenancy', 'creativeTenantLegado', 'organizations', 'owners', 'whatsapp', 'inkWebhook'];

export class Tenant1Error extends Error {
  constructor(message, detalhes = []) {
    super(detalhes.length ? `${message}\n  - ${detalhes.join('\n  - ')}` : message);
    this.name = 'Tenant1Error';
    this.detalhes = detalhes;
  }
}

const listaDeIds = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && UUID_RE.test(x));

// PD-019: a forma do mapeamento precisa ser a do cenário DECLARADO. Não há "parece B".
export function conferirCenario(cenario, mapeamento) {
  const erros = [];
  const orgs = mapeamento.organizations;
  const donoDaLoja = new Map(mapeamento.mapeamentos.filter((m) => m.tipo === 'loja').map((m) => [m.chave, m.organizationId]));
  if (cenario === 'A') {
    if (orgs.length !== LOJAS_LEGADAS.length) erros.push(`cenário A exige ${LOJAS_LEGADAS.length} Organizations (recebi ${orgs.length})`);
    const lojas = orgs.map((o) => o.store.lojaLegada);
    for (const l of LOJAS_LEGADAS) {
      if (lojas.filter((x) => x === l).length !== 1) erros.push(`cenário A: a loja legada "${l}" precisa ser a Store de exatamente uma Organization`);
    }
    const donos = LOJAS_LEGADAS.map((l) => donoDaLoja.get(l));
    if (new Set(donos).size !== LOJAS_LEGADAS.length) erros.push('cenário A: cada loja legada precisa de uma Organization própria');
  } else if (cenario === 'B') {
    if (orgs.length !== 1) erros.push(`cenário B exige 1 Organization (recebi ${orgs.length})`);
    // Confere a declaração de cada Organization do arquivo; nada é atribuído "à única".
    for (const o of orgs) {
      if (!LOJAS_LEGADAS.includes(o.store.lojaLegada)) erros.push('cenário B: a Store precisa declarar a loja legada que ela assume (lojaLegada)');
      for (const l of LOJAS_LEGADAS) {
        if (donoDaLoja.get(l) !== o.id) erros.push(`cenário B: loja:${l} precisa convergir explicitamente para ${o.id}`);
      }
    }
  } else {
    erros.push(`cenário desconhecido: ${JSON.stringify(cenario)}`);
  }
  return erros;
}

// §2 (rodada 19): cada recurso declara a própria Organization; os dois precisam ser da mesma.
export function validarWhatsapp(zap, idsMapeamento, erros) {
  if (zap === null || zap === undefined) return null;
  if (typeof zap !== 'object' || Array.isArray(zap)) {
    erros.push('whatsapp precisa ser null ou { waba, phoneNumber }');
    return null;
  }
  const antes = erros.length;
  const extra = Object.keys(zap).filter((k) => !['waba', 'phoneNumber'].includes(k));
  if (extra.length) erros.push(`whatsapp: campos não aceitos: ${extra.join(', ')} (declare waba e phoneNumber, cada um com id e organizationId)`);
  const recurso = {};
  for (const nome of ['waba', 'phoneNumber']) {
    const r = zap[nome];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      erros.push(`whatsapp.${nome} ausente — o dono do número atual é declarado, nunca inferido`);
      continue;
    }
    const extraR = Object.keys(r).filter((k) => !['id', 'organizationId'].includes(k));
    if (extraR.length) erros.push(`whatsapp.${nome}: campos não aceitos: ${extraR.join(', ')}`);
    if (typeof r.id !== 'string' || !META_ID_RE.test(r.id)) erros.push(`whatsapp.${nome}.id precisa ser o id numérico da Meta`);
    if (typeof r.organizationId !== 'string' || !idsMapeamento.has(r.organizationId)) {
      erros.push(`whatsapp.${nome}.organizationId precisa ser uma Organization do mapeamento`);
    }
    recurso[nome] = r;
  }
  if (erros.length > antes) return null;
  if (recurso.waba.organizationId !== recurso.phoneNumber.organizationId) {
    erros.push(`whatsapp: WABA (${recurso.waba.organizationId}) e número (${recurso.phoneNumber.organizationId}) declarados para Organizations diferentes — precisam convergir para a mesma`);
    return null;
  }
  return { organizationId: recurso.waba.organizationId, wabaId: recurso.waba.id, phoneNumberId: recurso.phoneNumber.id };
}

export function validarTenant1(json, { dir, cenario, rollout = false }) {
  const erros = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Tenant1Error('arquivo de Tenant #1 precisa ser um objeto JSON');
  const extras = Object.keys(json).filter((k) => !CHAVES.includes(k));
  if (extras.length) erros.push(`campos não aceitos: ${extras.join(', ')}`);
  const faltando = CHAVES.filter((k) => !Object.prototype.hasOwnProperty.call(json, k));
  if (faltando.length) erros.push(`campos obrigatórios ausentes (use null para "não se aplica"): ${faltando.join(', ')}`);
  if (json.versao !== 1) erros.push(`versao ${JSON.stringify(json.versao)} não suportada (esperado 1)`);
  if (!CENARIOS.includes(json.cenario)) erros.push(`cenario precisa ser "A" ou "B" (recebi ${JSON.stringify(json.cenario)})`);
  if (cenario !== json.cenario) erros.push(`--scenario ${cenario} não confere com o cenario do arquivo (${JSON.stringify(json.cenario)})`);
  if (typeof json.rollout !== 'boolean') erros.push('rollout precisa ser true (arquivo do rollout real) ou false (ensaio)');
  else if (json.rollout !== Boolean(rollout)) {
    erros.push(json.rollout
      ? 'o arquivo declara rollout: true — passe --rollout (a execução do rollout é sempre declarada)'
      : '--rollout informado, mas o arquivo declara rollout: false (ensaio)');
  }
  if (json.rollout === true && json.cenario !== CENARIO_ALVO_ROLLOUT) {
    erros.push(`rollout: true exige o cenário ${CENARIO_ALVO_ROLLOUT} (PD-019, alvo de rollout); o cenário ${JSON.stringify(json.cenario)} só roda como ensaio (rollout: false)`);
  }
  if (typeof json.creativeTenantLegado !== 'string' || !TENANT_LEGADO_RE.test(json.creativeTenantLegado)) {
    erros.push('creativeTenantLegado inválido');
  }
  if (erros.length) throw new Tenant1Error('arquivo de Tenant #1 inválido', erros);

  let mapeamento;
  const arquivoMapeamento = typeof json.mapeamentoTenancy === 'string' ? path.resolve(dir, json.mapeamentoTenancy) : null;
  if (!arquivoMapeamento) throw new Tenant1Error('arquivo de Tenant #1 inválido', ['mapeamentoTenancy ausente']);
  try {
    mapeamento = tm.lerMapeamentoDeArquivo(arquivoMapeamento);
    tm.verificarCompletudeRuntime(mapeamento, { creativeTenant: json.creativeTenantLegado });
  } catch (err) {
    throw new Tenant1Error('mapeamento de tenancy inválido', [err.message]);
  }
  erros.push(...conferirCenario(json.cenario, mapeamento));

  const idsMapeamento = new Set(mapeamento.organizations.map((o) => o.id));
  const organizations = [];
  if (!Array.isArray(json.organizations)) erros.push('organizations precisa ser uma lista');
  else {
    const vistos = new Set();
    for (const [i, o] of json.organizations.entries()) {
      const onde = `organizations[${i}]`;
      const extra = Object.keys(o || {}).filter((k) => !['id', 'entitlements', 'entitlementsProfile'].includes(k));
      if (extra.length) erros.push(`${onde}: campos não aceitos: ${extra.join(', ')}`);
      if (!o || !UUID_RE.test(o.id || '')) { erros.push(`${onde}.id não é UUID minúsculo`); continue; }
      if (!idsMapeamento.has(o.id)) erros.push(`${onde}.id ${o.id} não está no mapeamento de tenancy`);
      if (vistos.has(o.id)) erros.push(`${onde}.id duplicado — ambíguo`);
      vistos.add(o.id);
      const temLista = Object.prototype.hasOwnProperty.call(o, 'entitlements');
      const temPerfil = Object.prototype.hasOwnProperty.call(o, 'entitlementsProfile');
      if (temLista === temPerfil) {
        erros.push(`${onde}: declare exatamente um de entitlements (lista) ou entitlementsProfile (arquivo de perfil)`);
        continue;
      }
      if (temPerfil) {
        // Perfil de DADOS, validado pela mesma regra do seed (registry canônico, só implementadas).
        if (typeof o.entitlementsProfile !== 'string' || !o.entitlementsProfile.trim()) {
          erros.push(`${onde}.entitlementsProfile precisa ser o caminho do arquivo de perfil`);
          continue;
        }
        try {
          const p = lerPerfilDeEntitlements(path.resolve(dir, o.entitlementsProfile));
          organizations.push({ id: o.id, entitlements: p.features, perfil: p.perfil, arquivoPerfil: p.arquivo });
        } catch (err) {
          erros.push(`${onde}.entitlementsProfile: ${err.message}`);
        }
        continue;
      }
      if (!Array.isArray(o.entitlements) || !o.entitlements.every((f) => typeof f === 'string')) {
        erros.push(`${onde}.entitlements precisa ser uma lista (vazia = nenhuma feature)`);
        continue;
      }
      if (o.entitlements.length) {
        try {
          validarFeaturesDoSeed(o.entitlements, `${onde}.entitlements`);
        } catch (err) {
          erros.push(err.message);
        }
      }
      organizations.push({ id: o.id, entitlements: [...o.entitlements].sort(), perfil: null, arquivoPerfil: null });
    }
    for (const id of idsMapeamento) if (!vistos.has(id)) erros.push(`Organization ${id} do mapeamento sem entrada em organizations`);
  }

  const owners = [];
  if (!Array.isArray(json.owners) || !json.owners.length) erros.push('owners precisa ser uma lista não vazia');
  else {
    const emails = new Set();
    const cobertas = new Set();
    for (const [i, o] of json.owners.entries()) {
      const onde = `owners[${i}]`;
      const extra = Object.keys(o || {}).filter((k) => !['email', 'passwordHashEnv', 'organizations'].includes(k));
      if (extra.length) erros.push(`${onde}: campos não aceitos: ${extra.join(', ')}`);
      const email = String((o && o.email) || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) erros.push(`${onde}.email inválido`);
      if (emails.has(email)) erros.push(`${onde}.email repetido — ambíguo`);
      emails.add(email);
      if (!ENV_RE.test(String((o && o.passwordHashEnv) || ''))) erros.push(`${onde}.passwordHashEnv precisa ser o NOME de uma variável de ambiente`);
      if (!listaDeIds(o && o.organizations)) { erros.push(`${onde}.organizations precisa listar UUIDs`); continue; }
      if (new Set(o.organizations).size !== o.organizations.length) erros.push(`${onde}.organizations com repetição`);
      for (const id of o.organizations) {
        if (!idsMapeamento.has(id)) erros.push(`${onde}: Organization ${id} fora do mapeamento`);
        cobertas.add(id);
      }
      owners.push({ email, passwordHashEnv: o.passwordHashEnv, organizations: [...o.organizations].sort() });
    }
    for (const id of idsMapeamento) if (!cobertas.has(id)) erros.push(`Organization ${id} sem owner declarado`);
  }

  const whatsapp = validarWhatsapp(json.whatsapp, idsMapeamento, erros);

  let inkWebhook = null;
  if (json.inkWebhook !== null && json.inkWebhook !== undefined) {
    const extra = Object.keys(json.inkWebhook).filter((k) => k !== 'organizations');
    if (extra.length) erros.push(`inkWebhook: campos não aceitos: ${extra.join(', ')}`);
    if (!listaDeIds(json.inkWebhook.organizations)) erros.push('inkWebhook.organizations precisa listar UUIDs');
    else {
      const fora = json.inkWebhook.organizations.filter((id) => !idsMapeamento.has(id));
      if (fora.length) erros.push(`inkWebhook: Organization fora do mapeamento: ${fora.join(', ')}`);
      if (new Set(json.inkWebhook.organizations).size !== json.inkWebhook.organizations.length) erros.push('inkWebhook.organizations com repetição');
      inkWebhook = { organizations: [...json.inkWebhook.organizations].sort() };
    }
  }

  if (json.rollout === true) {
    // O rollout não aceita "fora desta execução" para o número atual nem lista solta de features.
    if (!whatsapp && !erros.some((x) => x.startsWith('whatsapp'))) {
      erros.push('rollout: true exige whatsapp declarado (o número atual pertence à Organization do rollout)');
    }
    if (Array.isArray(json.organizations) && json.organizations.some((o) => o && !Object.prototype.hasOwnProperty.call(o, 'entitlementsProfile'))) {
      erros.push('rollout: true exige entitlementsProfile (perfil versionado) em cada Organization, não lista inline');
    }
  }

  if (erros.length) throw new Tenant1Error('arquivo de Tenant #1 inválido', erros);

  const porId = new Map(mapeamento.organizations.map((o) => [o.id, o]));
  return {
    versao: 1,
    cenario: json.cenario,
    rollout: json.rollout,
    arquivoMapeamento,
    mapeamento,
    creativeTenantLegado: json.creativeTenantLegado,
    organizations: organizations
      .map((o) => ({ ...o, nome: porId.get(o.id).nome, store: porId.get(o.id).store }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    owners,
    whatsapp,
    inkWebhook,
    // Dono declarado do Creative Core legado.
    donoCriativos: mapeamento.mapeamentos.find((m) => m.tipo === 'creative_tenant' && m.chave === json.creativeTenantLegado).organizationId,
  };
}

export function lerTenant1(caminho, { cenario, rollout = false }) {
  let bruto;
  try {
    bruto = fs.readFileSync(caminho, 'utf8');
  } catch (err) {
    throw new Tenant1Error(`não foi possível ler o arquivo de Tenant #1 (${err.code || err.message})`);
  }
  let json;
  try {
    json = JSON.parse(bruto);
  } catch (err) {
    throw new Tenant1Error(`arquivo de Tenant #1 não é JSON válido: ${err.message}`);
  }
  return validarTenant1(json, { dir: path.dirname(path.resolve(caminho)), cenario, rollout });
}

// ── argumentos ─────────────────────────────────────────────────────────────────────────────────
const OPCOES = Object.freeze({
  '--scenario': 'valor',
  '--mapping': 'valor',
  '--uploads': 'valor',
  '--app-role': 'valor',
  '--saida-segredos': 'valor',
  '--snapshot': 'valor',
  '--aplicar': 'flag',
  '--rollout': 'flag',
  '--estagio': 'valor',
});

export function lerArgs(argv) {
  const r = { aplicar: false, rollout: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!OPCOES[a]) throw new Tenant1Error(`argumento desconhecido: ${a}`);
    if (OPCOES[a] === 'flag') { r[a.slice(2)] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Tenant1Error(`${a} exige um valor`);
    r[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    i += 1;
  }
  return r;
}

// Cenário e arquivo são obrigatórios em todos os comandos: sem eles, FAIL — nunca inferência.
export function exigirCenarioEArquivo(args) {
  const erros = [];
  if (!args.scenario) erros.push('--scenario A|B não informado — o cenário de PD-019 nunca é inferido');
  else if (!CENARIOS.includes(args.scenario)) erros.push(`--scenario precisa ser A ou B (recebi ${args.scenario})`);
  if (!args.mapping) erros.push('--mapping <arquivo> não informado — o dono dos dados nunca é inferido');
  if (erros.length) throw new Tenant1Error('execução recusada', erros);
  return lerTenant1(args.mapping, { cenario: args.scenario, rollout: Boolean(args.rollout) });
}

// ── conexão ────────────────────────────────────────────────────────────────────────────────────
// Leitura: a sessão inteira é READ ONLY no servidor — preflight, plan e verify não conseguem gravar
// nem por engano (inclusive nos imports em modo simulação que eles chamam).
export function urlSomenteLeitura(url) {
  const u = new URL(url);
  u.searchParams.set('options', '-c default_transaction_read_only=on');
  return u.toString();
}

const HOSTS_LOCAIS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// apply e rollback: só banco local/teste nesta fase. Produção fica para o rollout, com runbook.
export function exigirBancoLocal(url, env = process.env) {
  const erros = [];
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    erros.push('DATABASE_URL inválida');
  }
  if (host && !HOSTS_LOCAIS.has(host)) erros.push(`host ${host} não é local — apply/rollback só rodam contra banco local ou de teste`);
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') erros.push('NODE_ENV=production — recusado');
  const railway = Object.keys(env).filter((k) => k.startsWith('RAILWAY_'));
  if (railway.length) erros.push('ambiente Railway detectado — recusado');
  if (erros.length) throw new Tenant1Error('banco não permitido para escrita', erros);
}

// ── saída ──────────────────────────────────────────────────────────────────────────────────────
const NOME_SENSIVEL = /(SECRET|TOKEN|PASSWORD|PASSWD|MASTER_KEY|_HASH|API_KEY|RESOLVER_KEY|ACCESS_KEY)/;

function valoresSensiveis(env) {
  const valores = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || v.length < 8) continue;
    if (NOME_SENSIVEL.test(k)) valores.push(v);
  }
  for (const k of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
    try {
      const u = new URL(env[k] || '');
      if (u.password && u.password.length >= 4) valores.push(decodeURIComponent(u.password));
    } catch { /* sem URL */ }
  }
  return valores;
}

// Toda linha sai por aqui. Se algum valor sensível do ambiente aparecer, ele é trocado e a execução
// é marcada como vazamento (exit ≠ 0) — um segredo no stdout é bug, não detalhe.
export function criarSaida({ env = process.env, escrever = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const sensiveis = valoresSensiveis(env);
  const estado = { vazou: false, linhas: [] };
  function linha(texto) {
    let t = String(texto);
    for (const v of sensiveis) {
      if (t.includes(v)) { t = t.split(v).join('[REDACTED]'); estado.vazou = true; }
    }
    t = t.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, '$1[REDACTED]@');
    estado.linhas.push(t);
    escrever(t);
  }
  return { linha, estado };
}

export function imprimirItens(saida, itens) {
  for (const it of itens) saida.linha(`${it.status.padEnd(4)} ${it.id}${it.detalhe ? ` — ${it.detalhe}` : ''}`);
}

export function resultado(itens) {
  return itens.some((i) => i.status === 'FAIL') ? 'FAIL' : 'PASS';
}
