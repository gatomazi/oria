#!/usr/bin/env node
// Preflight de release — `npm run release:preflight` (rodada 18, trilha D, §32).
//
// SOMENTE LEITURA. Confere, antes de um passo do runbook (docs/produtizacao-saas/production-rollout-runbook.md):
//   - NOMES de variáveis presentes/ausentes (nunca valores; no máximo "atende o requisito: sim/não")
//   - flags legadas (ligada/desligada)
//   - URL da role de migration separada da URL do app (sem imprimir usuário, host ou senha)
//   - contrato da role da aplicação (código e, com banco, a role real do DATABASE_URL)
//   - versão do schema (pgmigrations × migrations/), numa transação READ ONLY
//   - arquivo de mapeamento de tenancy (validado, sem aplicar) e alvo de rollout (PD-019 cenário B)
//   - perfil de entitlements (validado contra o registry, sem aplicar)
//   - scripts npm que o runbook usa
//
// Uso:
//   npm run release:preflight                                   # ambiente do processo
//   npm run release:preflight -- --from-env-file <arquivo>      # export de variáveis (KEY=VALUE), sem carregar no shell
//   npm run release:preflight -- --service go --from-env-file <arq>  # ambiente do serviço Go
//   npm run release:preflight -- --stage after-ops14            # exige o estado pós OPS-14
//   npm run release:preflight -- --no-db                        # não conecta em banco nenhum
//   npm run release:preflight -- --legacy-forward-panel         # RELEASE D0 (rodada 19, §5): o painel ainda
//                                                                 compara o ?secret= legado
//   npm run release:preflight -- --json
//
// Exit: 0 sem bloqueio para o estágio · 1 algum item BLOCK · 64 uso inválido.
//
// Nunca imprime valor de variável, URL de banco, usuário, host nem mensagem crua de erro de conexão
// (pode conter a URL). Erros de banco saem só com o código SQLSTATE/errno.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

export const OK = 'OK';
export const WARN = 'WARN';
export const BLOCK = 'BLOCK';
export const INFO = 'INFO';
export const NAO_CHECADO = 'NOT CHECKED';

const ESTAGIOS = new Set(['release-n', 'after-ops14', 'cleanup']);

// Variáveis por serviço. `exige`: em que estágio a ausência bloqueia. `requisito`: verificação do
// valor que devolve só booleano.
const VARS_PAINEL = [
  { nome: 'DATABASE_URL', exige: ['release-n', 'after-ops14', 'cleanup'], ops: 'OPS-11/14' },
  { nome: 'MIGRATION_DATABASE_URL', exige: ['after-ops14', 'cleanup'], ops: 'OPS-14', nota: 'URL própria da role de migration (pre-deploy)' },
  { nome: 'DB_ENFORCE_APP_ROLE', exige: ['after-ops14', 'cleanup'], ops: 'OPS-14', requisito: (v) => v.trim() === '1', descricao: 'igual a 1' },
  { nome: 'ENCRYPTION_MASTER_KEY', exige: ['release-n', 'after-ops14', 'cleanup'], ops: 'OPS-12', requisito: (v) => { try { return Buffer.from(v.trim(), 'base64').length === 32; } catch { return false; } }, descricao: '32 bytes em base64' },
  { nome: 'ADMIN_SESSION_SECRET', exige: ['release-n', 'after-ops14', 'cleanup'], ops: 'OPS-20', requisito: (v) => v.length >= 32, descricao: '≥ 32 caracteres' },
  { nome: 'NODE_ENV', exige: ['release-n', 'after-ops14', 'cleanup'], requisito: (v) => v.trim().toLowerCase() === 'production', descricao: 'production' },
  { nome: 'TENANCY_MAPPING_FILE', exige: ['release-n'], ops: 'OPS-16', nota: 'ambiente do Pre-deploy Command' },
  { nome: 'AUTH_BOOTSTRAP_OWNER_EMAIL', exige: ['release-n'], ops: 'OPS-18' },
  { nome: 'AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH', exige: ['release-n'], ops: 'OPS-18' },
  { nome: 'AUTH_BOOTSTRAP_ORGANIZATION_IDS', exige: ['release-n'], ops: 'OPS-18' },
  { nome: 'ENTITLEMENTS_SEED_ORGANIZATION_IDS', exige: ['release-n'], ops: 'OPS-21' },
  // Rodada 19 (§9): a lista de features vem de um PERFIL de dados versionado, validado abaixo.
  { nome: 'ENTITLEMENTS_SEED_PROFILE', exige: ['release-n'], ops: 'OPS-21', nota: 'ex.: config/entitlements/tenant1-entitlements.json' },
  { nome: 'WHATSAPP_SERVICE_URL', exige: [], ops: 'OPS-28' },
  { nome: 'WHATSAPP_API_KEY', exige: [], ops: 'OPS-28' },
  { nome: 'WHATSAPP_SENDER_REF_SECRET', exige: [], ops: 'OPS-28', requisito: (v) => v.length >= 32, descricao: '≥ 32 caracteres', seTem: 'WHATSAPP_SERVICE_URL' },
  { nome: 'WHATSAPP_SENDER_RESOLVER_KEY', exige: [], ops: 'OPS-28', requisito: (v) => v.length >= 32, descricao: '≥ 32 caracteres', seTem: 'WHATSAPP_SERVICE_URL' },
  // Rodada 18 (trilha C): o repasse do Go é assinado em header. Rodada 19 (§4): em produção o painel
  // não sobe sem ele (ausente ou < 32), com ou sem WHATSAPP_SERVICE_URL — exigido em todo estágio.
  { nome: 'WHATSAPP_WEBHOOK_SECRET', exige: ['release-n', 'after-ops14', 'cleanup'], ops: 'OPS-09', requisito: (v) => v.length >= 32, descricao: '≥ 32 caracteres (sem ele o boot de produção aborta)' },
];

// Flags legadas do painel: ligadas são permitidas só no estágio indicado.
const FLAGS_PAINEL = [
  { nome: 'ALLOW_LEGACY_ADMIN_PASSWORD', ops: 'OPS-19', permitidaEm: ['release-n'] },
  { nome: 'ALLOW_LEGACY_INTEGRATION_ENV', ops: 'OPS-24', permitidaEm: ['release-n'] },
  { nome: 'ENCRYPTION_ALLOW_LEGACY_SESSION_KEY', ops: 'OPS-13/25', permitidaEm: ['release-n', 'after-ops14'],
    ausenteEm: { 'release-n': 'OPS-13: o import (OPS-23) só lê os tokens antigos com ela ligada, até a re-cifra (OPS-25) confirmar 0 pendentes' } },
  // Rodada 19 (§5): transição do repasse sem perda de status (round19-trilha-e.md). Sai no CLEANUP.
  { nome: 'WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED', ops: 'OPS-09/R19-5', permitidaEm: ['release-n', 'after-ops14'] },
];

// Flags do serviço Go, com a mesma regra.
const FLAGS_GO = [
  { nome: 'WEBHOOK_FORWARD_LEGACY_QUERY_SECRET', ops: 'OPS-09/R19-5', permitidaEm: ['release-n', 'after-ops14'] },
];

// Variáveis de tenant que saem na limpeza (presença = WARN antes, BLOCK em `cleanup`).
const LEGADAS_PAINEL = [
  { padrao: /^INK_TOKEN_/, ops: 'OPS-24' },
  { padrao: /^INK_FEED_URL_/, ops: 'OPS-24' },
  { padrao: /^INK_WEBHOOK_SECRET_/, ops: 'OPS-34' },
  { padrao: /^GOOGLE_ADS_EM_USO$/, ops: 'OPS-24' },
  { padrao: /^CREATIVE_TENANT_ID$/, ops: 'OPS-22/24' },
  { padrao: /^WHATSAPP_LEGACY_/, ops: 'OPS-29' },
  { padrao: /^ADMIN_PASSWORD$/, ops: 'OPS-19' },
  { padrao: /^LEGACY_ADMIN_USER_EMAIL$/, ops: 'OPS-19' },
];

const VARS_GO = [
  { nome: 'DATABASE_URL', exige: ['release-n', 'after-ops14', 'cleanup'] },
  { nome: 'API_KEY', exige: ['release-n', 'after-ops14', 'cleanup'] },
  { nome: 'META_APP_ID', exige: ['release-n', 'after-ops14', 'cleanup'], ops: 'OPS-27' },
  { nome: 'META_APP_SECRET', exige: ['release-n', 'after-ops14', 'cleanup'], ops: 'OPS-27' },
  { nome: 'PANEL_SENDER_RESOLVER_URL', exige: ['release-n', 'after-ops14', 'cleanup'], ops: 'OPS-28', requisito: (v) => /^https:\/\//.test(v.trim()), descricao: 'https' },
  { nome: 'PANEL_SENDER_RESOLVER_KEY', exige: ['release-n', 'after-ops14', 'cleanup'], ops: 'OPS-28', requisito: (v) => v.length >= 32, descricao: '≥ 32 caracteres' },
  // Rodada 18 (trilha C): repasse sem segredo na URL, assinado com WEBHOOK_FORWARD_SECRET.
  // Rodada 19 (§5): com WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1 e fora do CLEANUP, a URL legada
  // (só `?secret=<valor>`, diferente de WEBHOOK_FORWARD_SECRET) também atende — com WARN próprio.
  { nome: 'WEBHOOK_FORWARD_URL', exige: [], ops: 'OPS-09', requisito: (v, env, estagio) => urlDeRepasseValida(v, { env, estagio }), descricao: 'https, sem query (salvo a transição), credencial ou fragmento' },
  { nome: 'WEBHOOK_FORWARD_SECRET', exige: [], ops: 'OPS-09', requisito: (v) => v.length >= 32, descricao: '≥ 32 caracteres', seTem: 'WEBHOOK_FORWARD_URL' },
];

function transicaoDoRepasseLigada(env, estagio) {
  return String(env?.WEBHOOK_FORWARD_LEGACY_QUERY_SECRET || '').trim() === '1' && estagio !== 'cleanup';
}

// Mesma regra do Go (forward.go): exatamente um parâmetro `secret`, não vazio, e valor diferente do
// segredo da assinatura. Só booleano sai daqui.
function queryLegadaDoRepasse(u, env) {
  const chaves = [...u.searchParams.keys()];
  const valor = u.searchParams.get('secret');
  return chaves.length === 1 && chaves[0] === 'secret' && Boolean(valor) && valor !== String(env?.WEBHOOK_FORWARD_SECRET || '');
}

function urlDeRepasseValida(v, { env = {}, estagio } = {}) {
  try {
    const u = new URL(v.trim());
    const queryOk = !u.search || (transicaoDoRepasseLigada(env, estagio) && queryLegadaDoRepasse(u, env));
    return u.protocol === 'https:' && queryOk && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

const LEGADAS_GO = [
  { padrao: /^META_GRAPH_BASE_URL$/, ops: 'OPS-35', sempreBloqueia: true },
  { padrao: /^META_PHONE_NUMBER_ID$/, ops: 'OPS-29 / 5b Release D' },
  { padrao: /^META_ACCESS_TOKEN$/, ops: 'OPS-29 / 5b Release D' },
  { padrao: /^META_WABA_ID$/, ops: 'OPS-29 / 5b Release D' },
  { padrao: /^REPLY_/, ops: 'OPS-35' },
  { padrao: /^LEGACY_ORGANIZATION_ID$/, ops: 'OPS-32' },
];

// Scripts que o runbook manda rodar (os `tenant1:*` da trilha A entraram na consolidação da rodada 18).
// `onboarding:*` continua só como informação: a trilha B não criou script.
const SCRIPTS_DO_RUNBOOK = [
  'migrate:up', 'auth:bootstrap-owner', 'auth:hash-password', 'tenancy:seed-entitlements', 'tenancy:mover-criativos',
  'integrations:import-legacy', 'integrations:reencrypt', 'integrations:import-whatsapp-sender',
  'integrations:whatsapp-referencia', 'productization:gate', 'release:preflight',
  'tenant1:preflight', 'tenant1:plan', 'tenant1:apply', 'tenant1:verify', 'tenant1:rollback',
];

// ── Leitura de ambiente ─────────────────────────────────────────────────────────────────────────

export function lerArquivoDeEnv(conteudo) {
  const env = {};
  for (const linhaBruta of conteudo.split(/\r?\n/)) {
    const linha = linhaBruta.trim();
    if (!linha || linha.startsWith('#')) continue;
    const m = linha.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

const presente = (env, nome) => typeof env[nome] === 'string' && env[nome].trim() !== '';

function item(status, secao, nome, texto) {
  return { status, secao, nome, texto };
}

// ── Checagens (todas devolvem só nomes e booleanos) ────────────────────────────────────────────

// RELEASE D0 (rodada 19, §5): o painel publicado ainda autentica o repasse pela query; o
// WHATSAPP_WEBHOOK_SECRET dele é o valor LEGADO (qualquer tamanho). O valor novo (≥ 32) só entra no D'.
const WEBHOOK_SECRET_PAINEL_LEGADO = {
  nome: 'WHATSAPP_WEBHOOK_SECRET', exige: [], ops: 'OPS-09/R19-5', requisito: (v) => v.trim() !== '',
  descricao: 'valor LEGADO, comparado pela query no painel D0 (o novo, ≥ 32, entra no D\')',
};

export function checarVariaveis(env, { servico, estagio, repasseLegado = false }) {
  const lista = servico === 'go' ? VARS_GO
    : repasseLegado ? VARS_PAINEL.map((v) => (v.nome === WEBHOOK_SECRET_PAINEL_LEGADO.nome ? WEBHOOK_SECRET_PAINEL_LEGADO : v))
      : VARS_PAINEL;
  const itens = [];
  for (const v of lista) {
    const ref = v.ops ? ` (${v.ops})` : '';
    if (v === WEBHOOK_SECRET_PAINEL_LEGADO && !presente(env, v.nome)) {
      itens.push(item(WARN, 'env', v.nome, `ausente${ref} — o painel D0 aceita repasse sem autenticação (estado de produção anterior); fecha no D'`));
      continue;
    }
    if (!presente(env, v.nome)) {
      const exigida = v.exige.includes(estagio) || (v.seTem && presente(env, v.seTem));
      itens.push(item(exigida ? BLOCK : INFO, 'env', v.nome, `ausente${ref}${v.nota ? ` — ${v.nota}` : ''}`));
      continue;
    }
    if (v.requisito) {
      const atende = v.requisito(String(env[v.nome]), env, estagio);
      itens.push(item(atende ? OK : BLOCK, 'env', v.nome, `presente · ${v.descricao}: ${atende ? 'sim' : 'NÃO'}${ref}`));
    } else {
      itens.push(item(OK, 'env', v.nome, `presente${ref}`));
    }
  }
  return itens;
}

export function checarFlags(env, { servico, estagio }) {
  const itens = (servico === 'go' ? FLAGS_GO : FLAGS_PAINEL).map((f) => {
    const valor = String(env[f.nome] || '').trim();
    if (!valor) {
      const aviso = f.ausenteEm?.[estagio];
      return item(aviso ? WARN : OK, 'flags', f.nome, `desligada (ausente) (${f.ops})${aviso ? ` — ${aviso}` : ''}`);
    }
    if (valor !== '1' && valor !== '0') return item(BLOCK, 'flags', f.nome, `valor inválido (aceitos: 1, 0 ou ausente) (${f.ops})`);
    if (valor === '0') return item(OK, 'flags', f.nome, `desligada (${f.ops})`);
    const permitida = f.permitidaEm.includes(estagio);
    return item(permitida ? WARN : BLOCK, 'flags', f.nome, `LIGADA (${f.ops}) — ${permitida ? `permitida só no estágio ${f.permitidaEm.join('/')}` : `proibida no estágio ${estagio}`}`);
  });
  // Go em transição: dizer se a URL ainda leva a query legada (sem mostrar a URL).
  if (servico === 'go' && transicaoDoRepasseLigada(env, estagio) && presente(env, 'WEBHOOK_FORWARD_URL')) {
    let comQuery = false;
    try { comQuery = Boolean(new URL(env.WEBHOOK_FORWARD_URL.trim()).search); } catch { comQuery = false; }
    itens.push(item(WARN, 'flags', 'WEBHOOK_FORWARD_URL', comQuery
      ? 'transição R19-5: a URL ainda leva a query legada — remover a query e desligar a flag depois que o painel tolerar/exigir a assinatura'
      : 'transição R19-5: a URL já está sem query — a flag pode ser desligada'));
  }
  return itens;
}

// Rodada 18 (trilha B): criação de Organization externa. Ligada só por decisão explícita depois do
// SECOND TENANT GATE — em qualquer estágio deste runbook, ligada bloqueia.
export function checarSegundoTenant(env, { servico }) {
  if (servico === 'go') return [];
  const valor = String(env.SECOND_TENANT_ENABLED || '').trim().toLowerCase();
  if (valor === '' || valor === '0' || valor === 'false') {
    return [item(OK, 'flags', 'SECOND_TENANT_ENABLED', 'desligada (onboarding de Organization externa fechado)')];
  }
  if (valor === '1' || valor === 'true') {
    return [item(BLOCK, 'flags', 'SECOND_TENANT_ENABLED', 'LIGADA — só depois do SECOND TENANT GATE e de decisão explícita')];
  }
  return [item(BLOCK, 'flags', 'SECOND_TENANT_ENABLED', 'valor inválido (aceitos: 1, true, 0, false ou ausente)')];
}

// Rodada 19 (trilha G): leitura dupla TEMPORÁRIA dos arquivos do Creative Core (OPS-22). Permitida
// na transição (release-n e after-ops14, com WARN); BLOCK em `cleanup`; parcial/inválida sempre BLOCK.
// Com o mapeamento disponível, a Organization declarada precisa ser a dona do tenant legado.
export function checarLeituraLegadaCriativos(env, { servico, estagio }) {
  if (servico === 'go') return [];
  const nome = 'CREATIVE_LEGACY_READ_*';
  const { lerLeituraLegada } = require(path.join(RAIZ, 'lib', 'creative-core', 'leitura-legada.js'));
  let cfg;
  try {
    cfg = lerLeituraLegada(env);
  } catch {
    return [item(BLOCK, 'flags', nome, 'configuração parcial ou inválida — o boot falha (OPS-22)')];
  }
  if (!cfg) return [item(OK, 'flags', nome, 'leitura legada de criativos desligada (OPS-22)')];
  const itens = [];
  if (estagio === 'cleanup') {
    itens.push(item(BLOCK, 'flags', nome, 'LIGADA (OPS-22) — remover depois de tenancy:mover-criativos --verificar PASS'));
  } else {
    itens.push(item(WARN, 'flags', nome, 'LIGADA (OPS-22) — temporária: mover, --verificar PASS e desligar na release seguinte'));
  }
  const legadoDaInstalacao = String(env.CREATIVE_TENANT_ID || 'default').trim().toLowerCase();
  if (cfg.de !== legadoDaInstalacao) {
    itens.push(item(BLOCK, 'flags', 'CREATIVE_LEGACY_READ_FROM', 'diferente do tenant legado da instalação (CREATIVE_TENANT_ID ou default)'));
  }
  if (presente(env, 'TENANCY_MAPPING_FILE')) {
    try {
      const { lerMapeamentoDeArquivo } = require(path.join(RAIZ, 'lib', 'platform', 'tenancy-mapping.js'));
      const m = lerMapeamentoDeArquivo(path.resolve(env.TENANCY_MAPPING_FILE.trim()));
      const regra = m.mapeamentos.find((x) => x.tipo === 'creative_tenant' && String(x.chave).toLowerCase() === cfg.de);
      const confere = Boolean(regra) && String(regra.organizationId).toLowerCase() === cfg.organizationId;
      itens.push(item(confere ? OK : BLOCK, 'flags', 'CREATIVE_LEGACY_READ_ORGANIZATION_ID',
        `dona do tenant legado no mapeamento: ${confere ? 'sim' : 'NÃO'}`));
    } catch {
      itens.push(item(INFO, 'flags', 'CREATIVE_LEGACY_READ_ORGANIZATION_ID', 'mapeamento ilegível: não conferido aqui (ver seção MAPPING)'));
    }
  }
  return itens;
}

export function checarLegadas(env, { servico, estagio }) {
  const regras = servico === 'go' ? LEGADAS_GO : LEGADAS_PAINEL;
  const itens = [];
  for (const r of regras) {
    const nomes = Object.keys(env).filter((k) => r.padrao.test(k) && presente(env, k)).sort();
    for (const nome of nomes) {
      const bloqueia = r.sempreBloqueia || estagio === 'cleanup';
      itens.push(item(bloqueia ? BLOCK : WARN, 'legado', nome, `presente — remover (${r.ops})`));
    }
  }
  if (!itens.length) itens.push(item(OK, 'legado', '-', 'nenhuma variável legada de tenant presente'));
  return itens;
}

// Mesma URL (usuário+host+porta+banco) para app e migration = não há role separada. Só booleanos.
export function checarRoleDeMigration(env, { servico, estagio }) {
  if (servico === 'go') return [];
  if (!presente(env, 'MIGRATION_DATABASE_URL')) {
    return [item(estagio === 'release-n' ? INFO : BLOCK, 'roles', 'MIGRATION_DATABASE_URL',
      estagio === 'release-n' ? 'ausente — antes do OPS-14 o pre-deploy usa a DATABASE_URL atual' : 'ausente — depois do OPS-14 o pre-deploy precisa da role de migration')];
  }
  let app; let mig;
  try {
    app = new URL(env.DATABASE_URL);
    mig = new URL(env.MIGRATION_DATABASE_URL);
  } catch {
    return [item(BLOCK, 'roles', 'MIGRATION_DATABASE_URL', 'DATABASE_URL ou MIGRATION_DATABASE_URL não é URL válida')];
  }
  const mesmoBanco = app.hostname === mig.hostname && app.port === mig.port && app.pathname === mig.pathname;
  const mesmoUsuario = decodeURIComponent(app.username) === decodeURIComponent(mig.username);
  const itens = [item(mesmoBanco ? OK : WARN, 'roles', 'MIGRATION_DATABASE_URL', `aponta para o mesmo banco do app: ${mesmoBanco ? 'sim' : 'NÃO'}`)];
  if (estagio === 'release-n') {
    itens.push(item(INFO, 'roles', 'MIGRATION_DATABASE_URL', `usuário distinto do app: ${mesmoUsuario ? 'não (esperado antes do OPS-14)' : 'sim'}`));
  } else {
    itens.push(item(mesmoUsuario ? BLOCK : OK, 'roles', 'MIGRATION_DATABASE_URL', `usuário distinto do app: ${mesmoUsuario ? 'NÃO' : 'sim'}`));
  }
  return itens;
}

export function checarContratoDaRole() {
  const { sqlProvisionarAppRole, FUNCOES_DA_APLICACAO } = require(path.join(RAIZ, 'lib', 'platform', 'app-role.js'));
  const manifesto = require(path.join(RAIZ, 'lib', 'platform', 'tenancy-manifest.js'));
  const sql = sqlProvisionarAppRole({ role: 'oria_app', senha: 'preflight_sem_segredo', tabelasSobRls: manifesto.nomesSobRls() });
  const atributos = ['NOSUPERUSER', 'NOBYPASSRLS', 'NOINHERIT'].every((a) => sql[0].includes(a));
  return [item(atributos ? OK : BLOCK, 'roles', 'app-role.js',
    `contrato: NOSUPERUSER NOBYPASSRLS NOINHERIT ${atributos ? 'presentes' : 'AUSENTES'} · ${manifesto.nomesSobRls().length} tabelas sob RLS · ${FUNCOES_DA_APLICACAO.length} funções SECURITY DEFINER`)];
}

export function checarMapeamento(env, { servico, estagio }) {
  if (servico === 'go') return [];
  if (!presente(env, 'TENANCY_MAPPING_FILE')) {
    return [item(estagio === 'release-n' ? BLOCK : INFO, 'mapping', 'TENANCY_MAPPING_FILE', 'não definido (OPS-16)')];
  }
  const { lerMapeamentoDeArquivo, verificarCompletudeRuntime } = require(path.join(RAIZ, 'lib', 'platform', 'tenancy-mapping.js'));
  const arquivo = path.resolve(env.TENANCY_MAPPING_FILE.trim());
  if (!fs.existsSync(arquivo)) {
    return [item(BLOCK, 'mapping', 'TENANCY_MAPPING_FILE', `arquivo não existe nesta máquina (${path.basename(arquivo)})`)];
  }
  try {
    const m = lerMapeamentoDeArquivo(arquivo);
    verificarCompletudeRuntime(m, { creativeTenant: env.CREATIVE_TENANT_ID || 'default' });
    return [item(OK, 'mapping', path.basename(arquivo), `válido e completo para o runtime · ${m.organizations.length} Organization(s) · ${m.mapeamentos.length} regra(s)`)];
  } catch (err) {
    const faltando = Array.isArray(err.detalhes) ? ` (${err.detalhes.length} item(ns) faltando)` : '';
    return [item(BLOCK, 'mapping', path.basename(arquivo), `inválido: ${err.name || 'erro'}${faltando}`)];
  }
}

// Rodada 19 §1: o rollout mira o cenário B de PD-019 (Organization Use Origens + Store Use Origens).
// Um mapeamento válido com outra forma (ex.: cenário A, três Organizations) bloqueia: mudar o alvo
// exige nova confirmação do usuário. Só a contagem sai (o conteúdo do mapeamento não é impresso).
export async function checarAlvoDeRollout(env, { servico }) {
  if (servico === 'go' || !presente(env, 'TENANCY_MAPPING_FILE')) return [];
  const { lerMapeamentoDeArquivo } = require(path.join(RAIZ, 'lib', 'platform', 'tenancy-mapping.js'));
  let m;
  try {
    m = lerMapeamentoDeArquivo(path.resolve(env.TENANCY_MAPPING_FILE.trim()));
  } catch {
    return []; // a seção MAPPING já bloqueou
  }
  let tenant1;
  try {
    tenant1 = await import(pathToFileURL(path.join(RAIZ, 'scripts', 'tenant1', 'config.mjs')).href);
  } catch {
    return [item(BLOCK, 'rollout', 'PD-019', 'conferência do cenário indisponível (scripts/tenant1/config.mjs)')];
  }
  const problemas = tenant1.conferirCenario(tenant1.CENARIO_ALVO_ROLLOUT, m);
  return problemas.length
    ? [item(BLOCK, 'rollout', 'PD-019', `mapeamento não é o cenário ${tenant1.CENARIO_ALVO_ROLLOUT} (alvo de rollout): ${problemas.length} problema(s) · ${m.organizations.length} Organization(s)`)]
    : [item(OK, 'rollout', 'PD-019', `cenário ${tenant1.CENARIO_ALVO_ROLLOUT} (alvo de rollout) · 1 Organization · lojas legadas convergem por declaração`)];
}

// OPS-21 (rodada 19 §9): o perfil de DADOS (ENTITLEMENTS_SEED_PROFILE) é a fonte da verdade.
// A RELEASE B publica 31a7cdb, cujo seed só lê ENTITLEMENTS_SEED_FEATURES: nesse estágio a variável
// antiga é OBRIGATÓRIA e tem que ser exatamente a lista do perfil (o valor esperado é impresso — são
// nomes de feature). Depois (after-ops14), igual ao perfil é tolerada (WARN: o seed do HEAD aceita as
// duas iguais); na limpeza, sai. Divergente ou sem perfil válido → BLOCK em qualquer estágio.
export async function checarPerfilDeEntitlements(env, { servico, estagio }) {
  if (servico === 'go') return [];
  const itens = [];
  const temLista = presente(env, 'ENTITLEMENTS_SEED_FEATURES');
  let perfil = null;
  if (presente(env, 'ENTITLEMENTS_SEED_PROFILE')) {
    let seed;
    try {
      seed = await import(pathToFileURL(path.join(RAIZ, 'scripts', 'tenancy', 'seed-entitlements.mjs')).href);
    } catch {
      return [item(BLOCK, 'entitlements', 'ENTITLEMENTS_SEED_PROFILE', 'validador do perfil indisponível (scripts/tenancy/seed-entitlements.mjs)')];
    }
    const arquivo = path.resolve(env.ENTITLEMENTS_SEED_PROFILE.trim());
    try {
      perfil = seed.lerPerfilDeEntitlements(arquivo);
      itens.push(item(OK, 'entitlements', path.basename(arquivo), `perfil ${perfil.perfil} válido · ON: ${perfil.features.join(', ')} (OPS-21)`));
    } catch (err) {
      // A mensagem de validação só traz nomes de feature e o nome do arquivo.
      itens.push(item(BLOCK, 'entitlements', path.basename(arquivo), `inválido: ${err.name === 'SeedEntitlementsError' ? err.message : 'erro'}`));
    }
    if (perfil) {
      const c = seed.compararListaComPerfil(env.ENTITLEMENTS_SEED_FEATURES, perfil.features);
      const esperado = `valor esperado (igual ao perfil): ${c.esperado}`;
      if (!temLista) {
        if (estagio === 'release-n') {
          itens.push(item(BLOCK, 'entitlements', 'ENTITLEMENTS_SEED_FEATURES', `ausente — o seed da RELEASE B (31a7cdb) só lê esta variável; ${esperado}`));
        }
      } else if (!c.iguais) {
        const dif = [c.faltando.length && `faltando: ${c.faltando.join(', ')}`, c.extras.length && `a mais: ${c.extras.join(', ')}`,
          c.repetidas.length && `repetidas: ${c.repetidas.join(', ')}`].filter(Boolean).join('; ');
        itens.push(item(BLOCK, 'entitlements', 'ENTITLEMENTS_SEED_FEATURES', `diverge do perfil (${dif}); ${esperado}`));
      } else if (estagio === 'release-n') {
        itens.push(item(OK, 'entitlements', 'ENTITLEMENTS_SEED_FEATURES', `igual ao perfil ${perfil.perfil} (lida pelo seed da RELEASE B)`));
      } else if (estagio === 'after-ops14') {
        itens.push(item(WARN, 'entitlements', 'ENTITLEMENTS_SEED_FEATURES', 'igual ao perfil — forma antiga; remover depois da última release que roda o seed antigo'));
      } else {
        itens.push(item(BLOCK, 'entitlements', 'ENTITLEMENTS_SEED_FEATURES', 'presente — forma antiga; remover na limpeza (o perfil basta)'));
      }
    }
  } else if (temLista) {
    itens.push(item(BLOCK, 'entitlements', 'ENTITLEMENTS_SEED_FEATURES', 'presente sem ENTITLEMENTS_SEED_PROFILE — a lista só vale conferida contra o perfil (OPS-21)'));
  }
  return itens;
}

export function checarScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  const itens = [];
  for (const s of SCRIPTS_DO_RUNBOOK) {
    const cmd = pkg.scripts?.[s];
    if (!cmd) { itens.push(item(BLOCK, 'scripts', s, 'ausente no package.json')); continue; }
    const alvo = cmd.match(/node\s+(\S+\.m?js)/);
    if (alvo && !fs.existsSync(path.join(RAIZ, alvo[1]))) itens.push(item(BLOCK, 'scripts', s, `arquivo ${alvo[1]} não existe`));
    else itens.push(item(OK, 'scripts', s, 'disponível'));
  }
  const extras = Object.keys(pkg.scripts || {}).filter((s) => /^(tenant1|onboarding):/.test(s)).sort();
  itens.push(item(INFO, 'scripts', 'tenant1:*/onboarding:*', extras.length ? extras.join(', ') : 'nenhum (trilhas A/B: a confirmar na consolidação)'));
  return itens;
}

export function checarNode() {
  const [maior, menor] = process.versions.node.split('.').map(Number);
  const ok = maior > 20 || (maior === 20 && menor >= 11);
  return [item(ok ? OK : BLOCK, 'runtime', 'node', `${process.versions.node} (≥ 20.11, OPS-15)`)];
}

function migrationsDoRepositorio() {
  return fs.readdirSync(path.join(RAIZ, 'migrations')).filter((x) => /^\d+_.+\.js$/.test(x)).map((x) => x.replace(/\.js$/, '')).sort();
}

function migrationMinimaDoServer() {
  const m = fs.readFileSync(path.join(RAIZ, 'server.js'), 'utf8').match(/const MIGRATION_MINIMA = '([^']+)'/);
  return m ? m[1] : null;
}

// Só o código de erro sai: a mensagem do driver pode conter host/usuário.
function erroSeguro(err) {
  return err && (err.code || err.errno) ? String(err.code || err.errno) : 'erro de conexão';
}

async function somenteLeitura(url, fn) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  client.on('error', () => {});
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

export async function checarBanco(env, { servico, estagio }) {
  if (servico === 'go') return [item(NAO_CHECADO, 'schema', 'go', 'schema do Go migra no boot (advisory lock); não conferido aqui')];
  const itens = [];
  const urlSchema = presente(env, 'MIGRATION_DATABASE_URL') ? env.MIGRATION_DATABASE_URL : env.DATABASE_URL;
  const rotulo = presente(env, 'MIGRATION_DATABASE_URL') ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL';
  if (!presente(env, 'DATABASE_URL') && !presente(env, 'MIGRATION_DATABASE_URL')) {
    return [item(NAO_CHECADO, 'schema', '-', 'sem URL de banco')];
  }
  try {
    const r = await somenteLeitura(urlSchema, async (c) => {
      const versao = (await c.query('SHOW server_version_num')).rows[0].server_version_num;
      const tem = (await c.query(`SELECT to_regclass('public.pgmigrations') IS NOT NULL AS t`)).rows[0].t;
      const aplicadas = tem ? (await c.query('SELECT name FROM pgmigrations ORDER BY run_on, id')).rows.map((x) => x.name) : [];
      return { versao: Number(versao), aplicadas };
    });
    itens.push(item(r.versao >= 150000 ? OK : BLOCK, 'schema', 'postgres', `server_version_num ${r.versao} (≥ 15)`));
    const repo = migrationsDoRepositorio();
    const pendentes = repo.filter((m) => !r.aplicadas.includes(m));
    const desconhecidas = r.aplicadas.filter((m) => !repo.includes(m));
    const minima = migrationMinimaDoServer();
    itens.push(item(INFO, 'schema', rotulo, `${r.aplicadas.length} aplicadas · última: ${r.aplicadas.at(-1) || '(nenhuma)'} · ${pendentes.length} pendentes no repositório`));
    for (const p of pendentes) itens.push(item(INFO, 'schema', p, 'pendente (o pre-deploy aplica)'));
    for (const d of desconhecidas) itens.push(item(BLOCK, 'schema', d, 'aplicada no banco e ausente no repositório (release atrás do schema?)'));
    if (minima) {
      const vai = r.aplicadas.includes(minima) || repo.includes(minima);
      itens.push(item(vai ? OK : BLOCK, 'schema', 'MIGRATION_MINIMA', `${minima}: ${r.aplicadas.includes(minima) ? 'aplicada' : 'será aplicada pelo pre-deploy'}`));
    }
  } catch (err) {
    itens.push(item(BLOCK, 'schema', rotulo, `conexão/consulta falhou (${erroSeguro(err)})`));
  }

  if (presente(env, 'DATABASE_URL')) {
    try {
      const { verificarRoleDaAplicacao } = require(path.join(RAIZ, 'lib', 'platform', 'db-config.js'));
      const manifesto = require(path.join(RAIZ, 'lib', 'platform', 'tenancy-manifest.js'));
      const problemas = await somenteLeitura(env.DATABASE_URL, async (c) => {
        try {
          await verificarRoleDaAplicacao(c, { tabelasSobRls: manifesto.nomesSobRls() });
          return [];
        } catch (err) {
          // Só a contagem: a mensagem nomeia a role e as tabelas, o que não é segredo, mas o
          // preflight não imprime identidade de banco.
          if (err.name === 'DatabaseConfigError') return String(err.message).split('\n').slice(1);
          throw err;
        }
      });
      if (!problemas.length) itens.push(item(OK, 'roles', 'DATABASE_URL', 'role do app cumpre o contrato (sem SUPERUSER/BYPASSRLS, não dona, sem acesso às privadas)'));
      else itens.push(item(estagio === 'release-n' ? INFO : BLOCK, 'roles', 'DATABASE_URL',
        `role do app NÃO cumpre o contrato (${problemas.length} problema(s))${estagio === 'release-n' ? ' — esperado antes do OPS-14' : ''}`));
    } catch (err) {
      itens.push(item(BLOCK, 'roles', 'DATABASE_URL', `verificação da role falhou (${erroSeguro(err)})`));
    }
  }
  return itens;
}

export async function preflight(env, { servico = 'painel', estagio = 'release-n', banco = true, repasseLegado = false } = {}) {
  if (repasseLegado && (servico !== 'painel' || estagio === 'cleanup')) {
    throw new Error('--legacy-forward-panel vale só para o painel, antes do cleanup');
  }
  const opcoes = { servico, estagio, repasseLegado };
  const itens = [
    ...checarNode(),
    ...checarVariaveis(env, opcoes),
    ...checarFlags(env, opcoes),
    ...checarSegundoTenant(env, opcoes),
    ...checarLeituraLegadaCriativos(env, opcoes),
    ...checarLegadas(env, opcoes),
    ...checarRoleDeMigration(env, opcoes),
    ...(servico === 'painel' ? checarContratoDaRole() : []),
    ...checarMapeamento(env, opcoes),
    ...(await checarAlvoDeRollout(env, opcoes)),
    ...(await checarPerfilDeEntitlements(env, opcoes)),
    ...(servico === 'painel' ? checarScripts() : []),
    ...(banco ? await checarBanco(env, opcoes) : [item(NAO_CHECADO, 'schema', '-', '--no-db')]),
  ];
  const bloqueios = itens.filter((i) => i.status === BLOCK).length;
  return { servico, estagio, ...(repasseLegado ? { repasseLegado } : {}), itens, bloqueios, exit: bloqueios ? 1 : 0 };
}

export function formatar(r) {
  const linhas = [`RELEASE PREFLIGHT · serviço ${r.servico} · estágio ${r.estagio}${r.repasseLegado ? ' · painel D0 (repasse legado)' : ''} · somente leitura`];
  let secao = null;
  for (const i of r.itens) {
    if (i.secao !== secao) { secao = i.secao; linhas.push('', secao.toUpperCase()); }
    linhas.push(`  ${i.status.padEnd(12)} ${i.nome.padEnd(36)} ${i.texto}`);
  }
  linhas.push('', `${r.bloqueios ? `BLOCKED (${r.bloqueios})` : 'NO BLOCKERS'} · exit ${r.exit}`);
  return linhas.join('\n');
}

function lerArgs(argv) {
  const o = { servico: 'painel', estagio: 'release-n', banco: true, json: false, envFile: null, repasseLegado: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--no-db') o.banco = false;
    else if (a === '--legacy-forward-panel') o.repasseLegado = true;
    else if (a === '--service') o.servico = argv[++i];
    else if (a === '--stage') o.estagio = argv[++i];
    else if (a === '--from-env-file') o.envFile = argv[++i];
    else throw new Error(`opção desconhecida: ${a}`);
  }
  if (!['painel', 'go'].includes(o.servico)) throw new Error('--service aceita painel ou go');
  if (!ESTAGIOS.has(o.estagio)) throw new Error(`--stage aceita ${[...ESTAGIOS].join(', ')}`);
  if (o.envFile === undefined) throw new Error('--from-env-file exige um caminho');
  if (o.repasseLegado && (o.servico !== 'painel' || o.estagio === 'cleanup')) {
    throw new Error('--legacy-forward-panel vale só para o painel, antes do cleanup');
  }
  return o;
}

async function main() {
  let o;
  try {
    o = lerArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[preflight] ${err.message}`);
    return 64;
  }
  let env = process.env;
  if (o.envFile) {
    if (!fs.existsSync(o.envFile)) { console.error('[preflight] --from-env-file não encontrado'); return 64; }
    env = lerArquivoDeEnv(fs.readFileSync(o.envFile, 'utf8'));
  }
  const r = await preflight(env, o);
  if (o.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else console.log(formatar(r));
  return r.exit;
}

// Executado direto (não importado pelo teste). realpath: /tmp e /var são links no macOS.
const ehPrincipal = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (ehPrincipal) {
  main().then(
    (c) => process.exit(c),
    // Mensagem genérica: um erro inesperado pode carregar valor de variável.
    (err) => { console.error(`[preflight] falhou (${err && err.name ? err.name : 'erro'})`); process.exit(1); }
  );
}
