'use strict';

// Fail-fast de boot medido pelo que o deploy enxerga: o CÓDIGO DE SAÍDA do processo real.
//
// B-2 da Fase 0: `server.js` instala `uncaughtException` como rede de segurança, e ela capturava o
// throw da avaliação do próprio módulo. A configuração inválida virava uma linha de log e o
// processo saía com 0 — ou, com timers já agendados, ficava vivo sem nunca escutar. Nos dois
// casos o Railway não aborta o deploy.
//
// Testar `resolveDatabaseMode()` isolado não pega isso: a função lança certo e o processo, mesmo
// assim, não morre. Por isso aqui sobe `node server.js` de verdade e se exige exit ≠ 0 E a
// mensagem do erro — senão uma falha qualquer (sintaxe, require) passaria pelo motivo errado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const h = require('./harness');

const SERVER = path.join(h.RAIZ_REPO, 'server.js');
const CHAVE_VALIDA = crypto.randomBytes(32).toString('base64');
const SEGREDO_SESSAO = crypto.randomBytes(32).toString('base64url');
// Rodada 19 (§4): em produção o boot exige o segredo do repasse do WhatsApp antes das verificações
// de banco; os casos abaixo que medem essas verificações precisam dele para chegar até elas.
const SEGREDO_REPASSE = crypto.randomBytes(32).toString('base64url');

// Ambiente mínimo e explícito: nada do shell de quem roda o teste (DATABASE_URL, NODE_ENV,
// NODE_TEST_CONTEXT) pode decidir o resultado.
function ambiente(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-boot-'));
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    STORAGE_DIR: dir,
    UPLOADS_DIR: path.join(dir, 'uploads'),
    PORT: '0',
    ...extra,
  };
}

function subir(extra) {
  const r = spawnSync(process.execPath, [SERVER], {
    cwd: h.RAIZ_REPO,
    encoding: 'utf8',
    timeout: 20000,
    env: ambiente(extra),
  });
  return { ...r, saida: `${r.stdout}${r.stderr}` };
}

function assertMorreu(r, mensagem) {
  assert.notEqual(r.signal, 'SIGTERM',
    `o processo não saiu: ficou vivo sem escutar até o timeout.\n${r.saida.slice(-2000)}`);
  assert.equal(typeof r.status, 'number', `sem código de saída (signal ${r.signal})`);
  assert.notEqual(r.status, 0, `configuração inválida saiu com 0 — o deploy não abortaria.\n${r.saida.slice(-2000)}`);
  assert.match(r.saida, mensagem, `saiu ≠ 0, mas não pelo motivo esperado.\n${r.saida.slice(-2000)}`);
  assert.doesNotMatch(r.saida, /Orgulho Regional na porta/, 'escutou antes de morrer');
}

test('boot · DATA_STORE_MODE inválido → exit ≠ 0', () => {
  assertMorreu(subir({ DATA_STORE_MODE: 'memory' }), /DATA_STORE_MODE inválido/);
});

test('boot · dev sem DATABASE_URL e sem modo declarado → exit ≠ 0', () => {
  assertMorreu(subir({ NODE_ENV: 'development' }), /DATABASE_URL ausente/);
});

test('boot · produção sem DATABASE_URL → exit ≠ 0', () => {
  assertMorreu(subir({ NODE_ENV: 'production', ENCRYPTION_MASTER_KEY: CHAVE_VALIDA }), /DATABASE_URL ausente/);
});

test('boot · ENCRYPTION_MASTER_KEY malformada → exit ≠ 0 (throw no topo do módulo)', () => {
  assertMorreu(
    subir({ NODE_ENV: 'development', DATA_STORE_MODE: 'ephemeral-json', ENCRYPTION_MASTER_KEY: 'curta' }),
    /ENCRYPTION_MASTER_KEY precisa ter 32 bytes/
  );
});

test('boot · ENCRYPTION_KEY_VERSION inválida → exit ≠ 0', () => {
  assertMorreu(
    subir({
      NODE_ENV: 'development', DATA_STORE_MODE: 'ephemeral-json',
      ENCRYPTION_MASTER_KEY: CHAVE_VALIDA, ENCRYPTION_KEY_VERSION: 'abc',
    }),
    /ENCRYPTION_KEY_VERSION inválida/
  );
});

test('boot · produção sem ENCRYPTION_MASTER_KEY → exit ≠ 0', () => {
  assertMorreu(
    subir({ NODE_ENV: 'production', DATABASE_URL: h.urlDoBanco(), ADMIN_SESSION_SECRET: SEGREDO_SESSAO }),
    /ENCRYPTION_MASTER_KEY ausente/
  );
});

test('boot · produção contra banco sem migrations → exit ≠ 0 e não escuta', async (t) => {
  const base = h.urlDoBanco();
  const nome = `oria_boot_${crypto.randomBytes(5).toString('hex')}`;
  const admin = h.abrirPoolDescartavel(base.replace(/\/[^/]+$/, '/postgres'));
  await admin.query(`CREATE DATABASE ${nome}`);
  t.after(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
    await admin.end();
  });

  assertMorreu(
    subir({
      NODE_ENV: 'production',
      DATABASE_URL: base.replace(/\/[^/]+$/, `/${nome}`),
      ENCRYPTION_MASTER_KEY: CHAVE_VALIDA,
      ADMIN_SESSION_SECRET: SEGREDO_SESSAO,
      WHATSAPP_WEBHOOK_SECRET: SEGREDO_REPASSE,
    }),
    /pgmigrations ausente/
  );
});

// ── Fase 2 · autenticação ─────────────────────────────────────────────────────────────────────

test('boot · produção sem ADMIN_SESSION_SECRET → exit ≠ 0', () => {
  assertMorreu(
    subir({ NODE_ENV: 'production', DATABASE_URL: h.urlDoBanco(), ENCRYPTION_MASTER_KEY: CHAVE_VALIDA }),
    /ADMIN_SESSION_SECRET ausente ou com menos de 32 caracteres/
  );
});

test('boot · produção com ADMIN_SESSION_SECRET curto → exit ≠ 0', () => {
  assertMorreu(
    subir({ NODE_ENV: 'production', DATABASE_URL: h.urlDoBanco(), ENCRYPTION_MASTER_KEY: CHAVE_VALIDA, ADMIN_SESSION_SECRET: 'curto' }),
    /ADMIN_SESSION_SECRET ausente ou com menos de 32 caracteres/
  );
});

test('boot · login legado ligado sem o usuário que ele representa → exit ≠ 0', () => {
  assertMorreu(
    subir({
      NODE_ENV: 'development', DATA_STORE_MODE: 'ephemeral-json', ENCRYPTION_MASTER_KEY: CHAVE_VALIDA,
      ALLOW_LEGACY_ADMIN_PASSWORD: '1', ADMIN_PASSWORD: 'qualquer',
    }),
    /LEGACY_ADMIN_USER_EMAIL/
  );
});

test('boot · valor inválido na flag do login legado → exit ≠ 0', () => {
  assertMorreu(
    subir({ NODE_ENV: 'development', DATA_STORE_MODE: 'ephemeral-json', ENCRYPTION_MASTER_KEY: CHAVE_VALIDA, ALLOW_LEGACY_ADMIN_PASSWORD: 'true' }),
    /ALLOW_LEGACY_ADMIN_PASSWORD inválido/
  );
});

// Sobe o processo e espera "na porta"; devolve a saída acumulada.
async function subirEEscutar(extra) {
  const filho = spawn(process.execPath, [SERVER], { cwd: h.RAIZ_REPO, env: ambiente(extra) });
  let saida = '';
  try {
    await new Promise((resolve, reject) => {
      const limite = setTimeout(() => reject(new Error(`não escutou em 20s:\n${saida.slice(-2000)}`)), 20000);
      const ler = (buf) => {
        saida += buf;
        if (/Orgulho Regional na porta/.test(saida)) { clearTimeout(limite); resolve(); }
      };
      filho.stdout.on('data', ler);
      filho.stderr.on('data', ler);
      filho.on('exit', (code) => { clearTimeout(limite); reject(new Error(`saiu com ${code} antes de escutar:\n${saida.slice(-2000)}`)); });
    });
    return saida;
  } finally {
    filho.removeAllListeners('exit');
    filho.kill('SIGKILL');
  }
}

// Controle positivo: sem ele, "sempre sai ≠ 0" passaria em todos os casos acima por um server.js
// que nem sobe.
test('boot · configuração válida sobe e escuta', async () => {
  await subirEEscutar({ NODE_ENV: 'development', DATA_STORE_MODE: 'ephemeral-json', ENCRYPTION_MASTER_KEY: CHAVE_VALIDA });
});

// ── TD-001 · role da aplicação (ativável em OPS-14) ────────────────────────────────────────────

test('boot · DB_ENFORCE_APP_ROLE=1 com superusuário → exit ≠ 0 e não escuta', () => {
  assertMorreu(
    subir({
      NODE_ENV: 'production', DATABASE_URL: h.urlDoBanco(), ENCRYPTION_MASTER_KEY: CHAVE_VALIDA,
      ADMIN_SESSION_SECRET: SEGREDO_SESSAO, WHATSAPP_WEBHOOK_SECRET: SEGREDO_REPASSE, DB_ENFORCE_APP_ROLE: '1',
    }),
    /role da aplicação inválida para RLS[\s\S]*SUPERUSER/
  );
});

test('boot · DB_ENFORCE_APP_ROLE=1 com oria_app → verifica e escuta', async () => {
  const url = process.env.INVARIANTS_APP_DATABASE_URL;
  assert.ok(url, 'INVARIANTS_APP_DATABASE_URL ausente — rode pelo npm test');
  const saida = await subirEEscutar({
    NODE_ENV: 'development', DATABASE_URL: url, ENCRYPTION_MASTER_KEY: CHAVE_VALIDA, DB_ENFORCE_APP_ROLE: '1',
  });
  assert.match(saida, /role da aplicação oria_app verificada/);
});

// O estado de produção HOJE: role superusuária e exigência desligada. O próximo deploy não pode
// parar de subir por causa da Fase 1 — a troca de role é OPS-14, depois das Fases 2-3.
test('boot · sem a flag, a role atual (superusuário) continua subindo', async () => {
  const saida = await subirEEscutar({
    NODE_ENV: 'development', DATABASE_URL: h.urlDoBanco(), ENCRYPTION_MASTER_KEY: CHAVE_VALIDA,
  });
  assert.doesNotMatch(saida, /role da aplicação .* verificada/);
});

// ── Fase 5b · remetente WhatsApp por Organization ─────────────────────────────────────────────

test('boot · produção com serviço de WhatsApp e sem as chaves do remetente → exit ≠ 0', () => {
  const base = { NODE_ENV: 'production', DATABASE_URL: h.urlDoBanco(), ENCRYPTION_MASTER_KEY: CHAVE_VALIDA, ADMIN_SESSION_SECRET: SEGREDO_SESSAO, WHATSAPP_SERVICE_URL: 'https://whatsapp.interno.test' };
  assertMorreu(subir(base), /WHATSAPP_SENDER_REF_SECRET.*WHATSAPP_SENDER_RESOLVER_KEY/);
  assertMorreu(
    subir({ ...base, WHATSAPP_SENDER_REF_SECRET: crypto.randomBytes(32).toString('base64url'), WHATSAPP_SENDER_RESOLVER_KEY: 'curta' }),
    /WHATSAPP_SENDER_RESOLVER_KEY/
  );
  assertMorreu(
    subir({ ...base, WHATSAPP_SENDER_REF_SECRET: 'curta', WHATSAPP_SENDER_RESOLVER_KEY: crypto.randomBytes(32).toString('base64url') }),
    /WHATSAPP_SENDER_REF_SECRET/
  );
});
