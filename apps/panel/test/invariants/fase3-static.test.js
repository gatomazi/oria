'use strict';

// Fase 3 — o que o código de aplicação NÃO pode mais conter. Lido da raiz do sujeito
// (INVARIANT_SUBJECT_ROOT): os negative controls reintroduzem cada padrão numa cópia e este arquivo
// precisa reprovar.
//
//   INV-01/INV-03  loja/store vêm só do contexto — nunca de req.query/body/params, nunca de /:loja
//   F-02/PD-022    nada percorre todas as lojas (INK_STORES) para montar uma resposta
//   INV-10         sem modo 'all' / multiStoreMode
//   INV-17         nenhum timer de job solto no server.js: todos passam pelo runner por Organization
//   INV-22         CREATIVE_TENANT_ID não é lido pela aplicação

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');

function arquivosDoApp() {
  const extras = ['lib', 'routes'].flatMap((d) => fs.readdirSync(path.join(h.RAIZ_SUJEITO, d), { recursive: true })
    .filter((x) => x.endsWith('.js')).map((x) => path.join(h.RAIZ_SUJEITO, d, x)));
  return [SERVER, ...extras];
}

// Linhas (sem comentário de linha) que casam o padrão.
function procurar(padrao, arquivos = arquivosDoApp()) {
  const achados = [];
  for (const arq of arquivos) {
    fs.readFileSync(arq, 'utf8').split('\n').forEach((l, i) => {
      if (l.trimStart().startsWith('//')) return;
      if (padrao.test(l)) achados.push(`${path.relative(h.RAIZ_SUJEITO, arq)}:${i + 1}: ${l.trim()}`);
    });
  }
  return achados;
}

test('INV-01/03 · nenhuma rota lê loja ou store do request', () => {
  assert.deepEqual(procurar(/req\.(query|body|params)\s*(\.|\[\s*['"`])\s*(loja|lojas|store|storeId|store_id)\b/), []);
  assert.deepEqual(procurar(/\{[^}]*\b(loja|lojas|storeId|store_id)\b[^}]*\}\s*=\s*req\.(query|body|params)\b/), []);
  assert.deepEqual(procurar(/req\.get\(\s*['"`]x-(loja|store)/i), []);
  // Alias do corpo (`const body = req.body`) também não escolhe loja.
  assert.deepEqual(procurar(/\bbody\??\.(loja|lojas|storeId|store_id)\b/), []);
});

test('INV-01/03 · nenhuma rota do server.js tem segmento /:loja', () => {
  assert.deepEqual(procurar(/app\.(get|post|put|patch|delete|all|use)\(\s*['"`][^'"`]*\/:loja\b/, [SERVER]), []);
});

test('F-02 / TD-005 · nada percorre lojas ou segredos: nem a entrada do webhook', () => {
  const varreduras = procurar(/Object\.(keys|values|entries)\(\s*(INK_\w+|LOJAS_LEGADAS)\s*\)|\b(in|of)\s+(INK_\w+|LOJAS_LEGADAS)\b/, [SERVER]);
  assert.deepEqual(varreduras, [], 'varredura de lojas/segredos');
  // TD-005: a entrada da Ink não identifica a loja por segredo de ambiente.
  assert.deepEqual(procurar(/\bidentifyInkWebhookStore\b|\bINK_WEBHOOK_LEGADO\b|INK_WEBHOOK_SECRET_/, [SERVER]), []);
  assert.deepEqual(procurar(/app\.post\(\s*['"]\/api\/webhooks\/ink['"]/, [SERVER]), [], 'rota única legada');
  assert.deepEqual(procurar(/\bfetchAcrossInkStores\b|\bfetchRecentOrdersAcrossStores\b|\blojaAtribuidaPadrao\b/), []);
});

test('INV-10 · sem modo agregado de lojas', () => {
  assert.deepEqual(procurar(/\bmultiStoreMode\b/), []);
  assert.deepEqual(procurar(/loja[A-Za-z]*\s*(===|!==|==)\s*['"]all['"]|['"]all['"]\s*(===|!==)\s*loja/i), []);
});

test('INV-17 · nenhum timer de job solto no server.js', () => {
  const soltos = procurar(/^\s*(setInterval|setTimeout)\s*\(/, [SERVER]);
  assert.deepEqual(soltos, [], 'timer de nível de módulo roda sem Organization — use JOBS.agendar');
  const agendados = procurar(/JOBS\.agendar(UmaVez)?\(/, [SERVER]);
  assert.ok(agendados.length >= 15, `jobs agendados pelo runner: ${agendados.length}`);
});

test('INV-01 · nenhum TRUNCATE no código da aplicação (ignora RLS e apaga todas as Organizations)', () => {
  assert.deepEqual(procurar(/\bTRUNCATE\s+\w/i), []);
});

test('INV-22 · a aplicação não lê CREATIVE_TENANT_ID', () => {
  assert.deepEqual(procurar(/CREATIVE_TENANT_ID/), []);
});

test('INV-21 · sem espelho JSON global de auditoria quando há Postgres', () => {
  const texto = fs.readFileSync(SERVER, 'utf8');
  const inicio = texto.indexOf('async function registrarAuditLog(');
  const corpo = texto.slice(inicio, texto.indexOf('\n}\n', inicio));
  const iPg = corpo.indexOf('if (pgPool)');
  const iArquivo = corpo.indexOf('AUDIT_LOG_FILE');
  assert.ok(iPg !== -1 && iArquivo > iPg, 'o arquivo só pode aparecer depois do ramo Postgres');
  assert.ok(/if \(pgPool\) \{[\s\S]*?return registro;\s*\}/.test(corpo), 'o ramo Postgres retorna antes do arquivo');
  const listar = texto.slice(texto.indexOf('async function listarAuditLog('));
  assert.match(listar.slice(0, listar.indexOf('\n}\n')), /organization_id = \$\d/);
});

test('INV-01/10 · o painel não escolhe loja nem manda tenant para a API', () => {
  const raiz = path.join(h.RAIZ_REPO, 'src');
  const arquivos = fs.readdirSync(raiz, { recursive: true })
    .filter((x) => /\.(ts|tsx)$/.test(x)).map((x) => path.join(raiz, x));
  assert.ok(arquivos.length > 50, 'fontes do painel não encontradas');
  assert.deepEqual(procurar(/\bmultiStoreMode\b|state\/adminState|or_admin_current_store|Todas as lojas/, arquivos), []);
  // Nenhuma chamada de API com loja/organização em query, corpo ou caminho.
  assert.deepEqual(procurar(/[?&](loja|organization_id|store_id)=|set\(\s*['"](loja|organization_id|store_id)['"]/, arquivos), []);
  // Única exceção (TD-002): a troca de workspace, em AuthContext, propõe a Organization ao servidor.
  assert.deepEqual(procurar(/JSON\.stringify\(\s*\{[^}]*\b(loja|organizationId|organization_id)\b/, arquivos)
    .filter((l) => !/auth\/AuthContext\.tsx:\d+: body: JSON\.stringify\(\{ organizationId \}\),$/.test(l)), []);
  assert.deepEqual(procurar(/\/api\/admin\/[^`'"]*\$\{[^}]*loja[^}]*\}/, arquivos), []);
  // Fail-closed: nenhum default de entitlement concedido.
  const ent = fs.readFileSync(path.join(raiz, 'state', 'entitlements.ts'), 'utf8');
  assert.doesNotMatch(ent, /:\s*true\b/);
});

test('INV-12 · credencial de tenant não vem de env global nem das colunas antigas no código da app', () => {
  // Credenciais de PLATAFORMA (META_APP_*, GOOGLE_CLIENT_*, tokens de serviço) continuam no ambiente;
  // o que é proibido é credencial DO CLIENTE resolvida de env no caminho de request/job.
  assert.deepEqual(procurar(/process\.env\.(INK_TOKEN|INK_FEED_URL|GOOGLE_ADS_EM_USO|CREATIVE_TENANT_ID|OPENAI_API_KEY)/), []);
  // Fora do fallback legado explícito (lib/platform/integrations.js), ninguém monta nome de env de loja.
  const fora = procurar(/INK_(TOKEN|FEED_URL)_\$\{|`INK_(TOKEN|FEED_URL)_/).filter((l) => !l.startsWith('lib/platform/integrations.js:'));
  assert.deepEqual(fora, []);
  // Os tokens saíram das tabelas de conexão: a app não lê nem grava as colunas antigas.
  assert.deepEqual(procurar(/\b(access_token_encrypted|refresh_token_encrypted|openai_key_enc)\b/), []);
  // Nenhuma conexão/conta escolhida por singleton da instalação.
  assert.deepEqual(procurar(/FROM (meta|google_ads)_connections WHERE id = 1|WHERE selecionada LIMIT 1/), []);
});
