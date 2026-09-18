'use strict';

// Rodada 19 · §5 — contrato EXECUTÁVEL da transição do repasse Go → painel sem perda de status.
//
// Processos reais, nada lido só do código:
//   - painel ANTIGO: server.js do commit COMMIT_PAINEL_ANTIGO (5c R1, antes do endurecimento do
//     repasse em COMMIT_ENDURECIMENTO), extraído do snapshot versionado em test/fixtures/legacy/
//     para um diretório temporário, com o seu próprio schema (as migrations DAQUELE commit) e
//     WHATSAPP_WEBHOOK_SECRET definido — autentica só por `?secret=`;
//   - painel NOVO: server.js deste checkout, com e sem WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED;
//   - serviço Go: binário compilado de WHATSAPP_GO_DIR, com e sem WEBHOOK_FORWARD_LEGACY_QUERY_SECRET,
//     e um binário MUTANTE (com a flag, deixa de mandar a query) como controle negativo.
//
// A prova é o efeito: um status de campanha (delivered/read) entra no Go como webhook assinado da
// Meta, o Go resolve a Organization no painel, repassa, e o destinatário da campanha avança no banco
// do painel. Recusa = o destinatário não avança e o Go registra o 401.
//
// Sem a toolchain Go ou sem o código do serviço, o teste registra o motivo e não roda.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const h = require('./harness');
const senhas = h.sujeito('lib/auth/password.js');
const { inserir, limparCache, concederFeatures } = require('../helpers/linhas');

// 5c R1 (PD-023 fechado), última forma do painel que autentica o repasse pela query. A rota é a
// mesma do painel em produção hoje (`req.query.secret !== WHATSAPP_WEBHOOK_SECRET`) e a do commit
// imediatamente anterior ao endurecimento — o candidato a RELEASE D0 do runbook (round19-trilha-e.md).
const COMMIT_PAINEL_ANTIGO = 'bfd00a6';
const SNAPSHOT_PAINEL_ANTIGO = 'bfd00a6-painel'; // snapshot versionado em test/fixtures/legacy/
const COMMIT_ENDURECIMENTO = 'c706da1';
// `c706da1^` = 8c024d2, o candidato a RELEASE D0 — também versionado, e com o server.js daquele
// commit, para que a comparação das rotas continue sendo feita contra o código real.
const SNAPSHOT_ANTES_DO_ENDURECIMENTO = '8c024d2-release-d0';

const DIR_GO = process.env.WHATSAPP_GO_DIR || path.resolve(h.RAIZ_REPO, '..', '..', 'services', 'whatsapp');
const GO = spawnSync('go', ['version'], { encoding: 'utf8' });
const MOTIVO_PULO = GO.status !== 0 ? 'toolchain Go ausente'
  : !fs.existsSync(path.join(DIR_GO, 'go.mod')) ? `repositório do Go não encontrado em ${DIR_GO} (defina WHATSAPP_GO_DIR)`
    : null;

const ORG = 'a1000000-0000-4000-8000-000000000001';
const LOJA = 'sul';
const EMAIL = 'r19-repasse@teste.oria';
const SENHA = 'senha-forte-de-teste-123';
const PHONE = '1110000001';
const WABA = '2220000001';
const TOKEN = `EAAGR19${crypto.randomBytes(12).toString('hex')}`;
const MESTRA = crypto.randomBytes(32).toString('base64');
const SEGREDO_REF = crypto.randomBytes(32).toString('base64url');
const CHAVE_RESOLVER = crypto.randomBytes(32).toString('base64url');
const CHAVE_GO = crypto.randomBytes(24).toString('base64url');
const APP_SECRET = crypto.randomBytes(24).toString('hex');
// O segredo antigo (na URL do Go, comparado pelo painel antigo) pode ser curto; o da assinatura é NOVO.
const SEGREDO_LEGADO = crypto.randomBytes(10).toString('hex');
const SEGREDO_NOVO = crypto.randomBytes(32).toString('base64url');
const FLAG_GO = 'WEBHOOK_FORWARD_LEGACY_QUERY_SECRET';
const FLAG_PAINEL = 'WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED';

let arvoreAntiga;
let arvoreD0;
let binarioGo;
let binarioMutante;
let meta;
let portaMeta;
const bancos = [];
const processos = new Set();

const livre = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const esperar = async (oque, cond, ms = 15000) => {
  const fim = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > fim) throw new Error(`tempo esgotado: ${oque}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

function processo(rotulo, comando, args, opcoes, marca) {
  const p = { log: '', filho: spawn(comando, args, opcoes) };
  processos.add(p);
  const ler = (b) => { p.log += b; };
  p.filho.stdout.on('data', ler);
  p.filho.stderr.on('data', ler);
  p.saiu = new Promise((resolve) => p.filho.once('exit', (code) => { processos.delete(p); resolve(code); }));
  p.parar = async () => {
    if (p.filho.exitCode === null && p.filho.signalCode === null) p.filho.kill('SIGTERM');
    await p.saiu;
  };
  p.pronto = marca ? Promise.race([
    esperar(`${rotulo} subir`, () => marca.test(p.log), 60000),
    p.saiu.then((code) => { throw new Error(`${rotulo} saiu com ${code}:\n${p.log.slice(-3000)}`); }),
  ]) : null;
  return p;
}

// ── Banco do painel (schema da árvore indicada) ───────────────────────────────────────────────
async function prepararPainelDb(raiz, prefixo) {
  const db = await h.criarBancoDescartavel(prefixo);
  bancos.push(db);
  const r = spawnSync(process.execPath, [
    path.join(h.RAIZ_REPO, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js'),
    '--migrations-dir', path.join(raiz, 'migrations'), '--ignore-pattern', '(README\\.md|sql|sql/.*)', 'up',
  ], {
    cwd: raiz, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, DATABASE_URL: db.url, TENANCY_MAPPING_FILE: path.join(raiz, 'test', 'fixtures', 'tenancy', 'cenario-a.json') },
  });
  assert.equal(r.status, 0, `migrations de ${path.basename(raiz)}:\n${r.stdout.slice(-2000)}${r.stderr}`);
  const sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  db.sup = sup;
  // Role da aplicação provisionada com o contrato DAQUELA árvore (sem SUPERUSER/BYPASSRLS).
  const { sqlProvisionarAppRole } = require(path.join(raiz, 'lib', 'platform', 'app-role.js'));
  const manifesto = require(path.join(raiz, 'lib', 'platform', 'tenancy-manifest.js'));
  db.role = `oria_app_r19_${crypto.randomBytes(4).toString('hex')}`;
  db.senhaRole = crypto.randomBytes(16).toString('hex');
  for (const sql of sqlProvisionarAppRole({ role: db.role, senha: db.senhaRole, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  limparCache();
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [EMAIL, await senhas.gerarHash(SENHA)]);
  await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [ORG, u.id, 'owner']);
  // Este cenário monta o banco no schema de uma RELEASE ANTIGA, anterior às tabelas do control
  // plane — `plans` nem existe aqui. A concessão continua sendo em `app_config`, que é o que o
  // painel daquela época lê. Não é regressão: é o caminho de compatibilidade sendo exercitado.
  await sup.query(`INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'entitlements', '{"whatsapp": true}'::jsonb)`, [ORG]);
  if (await temTabela(sup, 'plans')) await concederFeatures(sup, ORG, { whatsapp: true });
  db.campanha = (await inserir(sup, 'campaigns', { organization_id: ORG, loja: LOJA, nome: 'campanha r19' })).id;
  return db;
}

// O schema deste arquivo varia por cenário (release antiga vs. HEAD): a concessão canônica só é
// possível onde as tabelas do control plane existem.
async function temTabela(cliente, nome) {
  const { rows } = await cliente.query('SELECT to_regclass($1) AS t', [`public.${nome}`]);
  return !!rows[0].t;
}

async function novoDestinatario(db) {
  const wamid = `wamid.R19.${crypto.randomBytes(6).toString('hex')}`;
  await inserir(db.sup, 'campaign_recipients', { organization_id: ORG, campaign_id: db.campanha, provider_message_id: wamid, status: 'sent' });
  return wamid;
}

const statusDe = async (db, wamid) => (await db.sup.query('SELECT status FROM campaign_recipients WHERE provider_message_id = $1', [wamid])).rows[0].status;

// ── Painel (processo real) ─────────────────────────────────────────────────────────────────────
async function subirPainel({ raiz, db, porta, segredo, extra = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-r19-srv-'));
  const p = processo(`painel ${path.basename(raiz)}`, process.execPath, [path.join(raiz, 'server.js')], {
    cwd: raiz,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, db.role, db.senhaRole),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      WHATSAPP_SERVICE_URL: `http://127.0.0.1:${portaMeta}`,
      WHATSAPP_API_KEY: CHAVE_GO,
      WHATSAPP_SENDER_REF_SECRET: SEGREDO_REF,
      WHATSAPP_SENDER_RESOLVER_KEY: CHAVE_RESOLVER,
      WHATSAPP_WEBHOOK_SECRET: segredo,
      META_API_VERSION: 'v21.0',
      ...extra,
    },
  }, /na porta/);
  await p.pronto;
  p.porta = porta;
  return p;
}

async function configurarRemetente(porta) {
  const base = `http://127.0.0.1:${porta}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: SENHA }),
  });
  const corpoLogin = await login.json();
  assert.equal(login.status, 200, JSON.stringify(corpoLogin));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const put = await fetch(`${base}/api/admin/whatsapp/remetente`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': corpoLogin.csrfToken },
    body: JSON.stringify({ phoneNumberId: PHONE, wabaId: WABA, accessToken: TOKEN, replyRedirectMessage: '', notifyNumber: '' }),
  });
  assert.equal(put.status, 200, await put.text());
}

// ── Go (processo real) ─────────────────────────────────────────────────────────────────────────
async function subirGo({ binario = binarioGo, portaPainel, legado, flag }) {
  const db = await h.criarBancoDescartavel('wa_r19');
  bancos.push(db);
  const porta = await livre();
  const url = `http://127.0.0.1:${portaPainel}/api/webhooks/whatsapp${legado ? `?secret=${SEGREDO_LEGADO}` : ''}`;
  const p = processo('go', binario, [], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      APP_ENV: 'development',
      PORT: String(porta),
      API_KEY: CHAVE_GO,
      META_APP_SECRET: APP_SECRET,
      META_VERIFY_TOKEN: 'verificacao',
      META_GRAPH_BASE_URL: `http://127.0.0.1:${portaMeta}`,
      META_SEND_INTERVAL_MS: '0',
      DATABASE_URL: db.url.includes('?') ? db.url : `${db.url}?sslmode=disable`,
      PANEL_SENDER_RESOLVER_URL: `http://127.0.0.1:${portaPainel}/api/internal/whatsapp/sender`,
      PANEL_SENDER_RESOLVER_KEY: CHAVE_RESOLVER,
      WEBHOOK_FORWARD_URL: url,
      WEBHOOK_FORWARD_SECRET: SEGREDO_NOVO,
      ...(flag ? { [FLAG_GO]: flag } : {}),
    },
  }, /WhatsApp service :/);
  await p.pronto;
  await esperar('health do Go', async () => (await fetch(`http://127.0.0.1:${porta}/health`).catch(() => ({ ok: false }))).ok);
  p.porta = porta;
  p.db = db;
  return p;
}

async function statusPeloGo(go, wamid, status) {
  const corpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: PHONE },
      statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '5548912340000' }],
    } }] }],
  });
  const r = await fetch(`http://127.0.0.1:${go.porta}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', APP_SECRET).update(corpo).digest('hex')}` },
    body: corpo,
  });
  assert.equal(r.status, 200, 'o Go aceita o webhook assinado da Meta');
}

async function inboxDoGo(go) {
  const pool = h.abrirPoolDescartavel(go.db.url, { max: 1 });
  try {
    return (await pool.query('SELECT count(*)::int AS n FROM webhook_inbox')).rows[0].n;
  } finally {
    await pool.end();
  }
}

// Aplicado: o destinatário avança e a inbox do Go esvazia (a linha só sai depois do 2xx do painel).
async function provarAplicado(go, db, wamid, status) {
  await statusPeloGo(go, wamid, status);
  await esperar(`status ${status} aplicado`, async () => (await statusDe(db, wamid)) === status);
  await esperar('inbox do Go vazia', async () => (await inboxDoGo(go)) === 0);
  assert.doesNotMatch(go.log, /repasse: painel respondeu|repasse:/, 'o Go registrou falha de repasse');
}

// Recusado: o Go registra a resposta do painel e o destinatário não muda.
async function provarRecusado(go, db, wamid, status, codigo) {
  await statusPeloGo(go, wamid, status);
  await esperar(`repasse recusado com ${codigo}`, () => go.log.includes(`repasse: painel respondeu ${codigo}`));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await statusDe(db, wamid), 'sent', 'repasse recusado não pode alterar o status');
  assert.equal(await inboxDoGo(go), 1, 'o evento fica pendente na inbox do Go');
}

function semSegredoNosLogs(...procs) {
  for (const p of procs) {
    for (const v of [SEGREDO_LEGADO, SEGREDO_NOVO, TOKEN]) assert.ok(!p.log.includes(v), 'valor sensível em log');
    assert.ok(!p.log.includes('secret='), 'query com segredo em log');
  }
}

function construirGo(dir, destino) {
  const r = spawnSync('go', ['build', '-o', destino, '.'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `go build (${dir}):\n${r.stderr}`);
}

// ── Montagem ───────────────────────────────────────────────────────────────────────────────────
let dbAntigo;
let dbNovo;
let painelAntigo;
let portaNovo;

test.before(async () => {
  if (MOTIVO_PULO) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-r19-'));
  // Árvore antiga, só leitura para o teste; dependências do checkout atual por symlink.
  arvoreAntiga = h.extrairSnapshotLegado(path.join(tmp, `painel-${COMMIT_PAINEL_ANTIGO}`), SNAPSHOT_PAINEL_ANTIGO);
  arvoreD0 = h.extrairSnapshotLegado(path.join(tmp, 'painel-d0'), SNAPSHOT_ANTES_DO_ENDURECIMENTO);
  fs.symlinkSync(path.join(h.RAIZ_REPO, 'node_modules'), path.join(arvoreAntiga, 'node_modules'), 'dir');

  binarioGo = path.join(tmp, 'whatsapp-webhook');
  construirGo(DIR_GO, binarioGo);
  // Mutante: mesma fonte, mas com a flag a URL perde a query (o Go "só assina").
  const fonteMutante = path.join(tmp, 'go-mutante');
  fs.mkdirSync(fonteMutante);
  for (const f of fs.readdirSync(DIR_GO)) {
    if (/\.go$/.test(f) && !/_test\.go$/.test(f) || f === 'go.mod' || f === 'go.sum') fs.copyFileSync(path.join(DIR_GO, f), path.join(fonteMutante, f));
  }
  const forward = fs.readFileSync(path.join(fonteMutante, 'forward.go'), 'utf8');
  const ancora = '\treturn u.String(), nil\n}';
  assert.equal(forward.split(ancora).length - 1, 1, 'âncora do mutante não encontrada em forward.go — o controle negativo não pode ser aplicado');
  fs.writeFileSync(path.join(fonteMutante, 'forward.go'), forward.replace(ancora, `\tu.RawQuery = "" // MUTANTE (controle negativo)\n${ancora}`));
  binarioMutante = path.join(tmp, 'whatsapp-webhook-mutante');
  construirGo(fonteMutante, binarioMutante);

  portaMeta = await livre();
  meta = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{"messages":[{"id":"wamid.R19-META"}]}'); });
  });
  await new Promise((resolve) => meta.listen(portaMeta, '127.0.0.1', resolve));

  dbAntigo = await prepararPainelDb(arvoreAntiga, 'oria_r19_antigo');
  dbNovo = await prepararPainelDb(h.RAIZ_SUJEITO, 'oria_r19_novo');
  painelAntigo = await subirPainel({ raiz: arvoreAntiga, db: dbAntigo, porta: await livre(), segredo: SEGREDO_LEGADO });
  await configurarRemetente(painelAntigo.porta);
  portaNovo = await livre();
});

test.after(async () => {
  if (MOTIVO_PULO) return;
  await Promise.all([...processos].map((p) => p.parar()));
  meta?.close();
  for (const db of bancos) {
    if (db.sup) {
      await db.sup.query(`DROP OWNED BY ${db.role}`).catch(() => {});
      await db.sup.end();
    }
    await db.destruir();
  }
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try {
    for (const db of bancos.filter((b) => b.role)) await admin.query(`DROP ROLE IF EXISTS ${db.role}`);
  } finally {
    await admin.end();
  }
  if (arvoreAntiga) fs.rmSync(path.dirname(arvoreAntiga), { recursive: true, force: true });
});

const cenario = (nome, fn) => test(nome, { timeout: 240000 }, (t) => (MOTIVO_PULO ? t.skip(MOTIVO_PULO) : fn(t)));

cenario('R19 · o painel antigo extraído é o que autentica só pela query (e é a rota de antes do endurecimento)', () => {
  const rota = (fonte) => fonte.slice(fonte.indexOf("app.post('/api/webhooks/whatsapp'"), fonte.indexOf('// ── Resolução interna do remetente'));
  const antiga = rota(fs.readFileSync(path.join(arvoreAntiga, 'server.js'), 'utf8'));
  assert.match(antiga, /if \(WHATSAPP_WEBHOOK_SECRET && req\.query\.secret !== WHATSAPP_WEBHOOK_SECRET\) \{\n\s+return res\.status\(401\)\.end\(\);/);
  assert.doesNotMatch(antiga, /x-oria-forward|verificarRepasseWhatsapp/i, 'o painel antigo não conhece a assinatura');
  const anterior = fs.readFileSync(path.join(arvoreD0, 'server.js'), 'utf8');
  assert.equal(rota(anterior), antiga, `a rota em ${COMMIT_ENDURECIMENTO}^ (candidato a RELEASE D0) difere da testada`);
  assert.match(painelAntigo.log, /na porta/);
});

cenario('R19 · passo 1: Go novo COM a flag + URL legada → painel antigo aplica o status', async () => {
  const go = await subirGo({ portaPainel: painelAntigo.porta, legado: true, flag: '1' });
  try {
    assert.match(go.log, new RegExp(`AVISO env=development: ${FLAG_GO}=1 — TRANSIÇÃO`));
    assert.match(go.log, /forward=true {2}forward_legacy_query=true/);
    const wamid = await novoDestinatario(dbAntigo);
    await provarAplicado(go, dbAntigo, wamid, 'delivered');
    await provarAplicado(go, dbAntigo, wamid, 'read');
    semSegredoNosLogs(go, painelAntigo);
  } finally {
    await go.parar();
  }
});

cenario('R19 · controle negativo: Go que com a flag deixa de mandar a query → painel antigo recusa (status perdido)', async () => {
  const go = await subirGo({ binario: binarioMutante, portaPainel: painelAntigo.porta, legado: true, flag: '1' });
  try {
    await provarRecusado(go, dbAntigo, await novoDestinatario(dbAntigo), 'delivered', 401);
  } finally {
    await go.parar();
  }
});

cenario('R19 · o problema original: Go novo SEM a flag (URL limpa) → painel antigo recusa', async () => {
  const go = await subirGo({ portaPainel: painelAntigo.porta, legado: false });
  try {
    assert.match(go.log, /forward_legacy_query=false/);
    await provarRecusado(go, dbAntigo, await novoDestinatario(dbAntigo), 'delivered', 401);
    semSegredoNosLogs(go);
  } finally {
    await go.parar();
  }
});

cenario('R19 · Go novo SEM a flag e com URL legada: fora de produção o repasse desliga (em produção o boot para — teste do Go)', async () => {
  const go = await subirGo({ portaPainel: painelAntigo.porta, legado: true });
  try {
    assert.match(go.log, /\[forward\] WEBHOOK_FORWARD_URL inválida.*repasse desligado/);
    assert.match(go.log, /forward=false/);
    semSegredoNosLogs(go);
  } finally {
    await go.parar();
  }
});

cenario('R19 · passo 2: Go com a flag → painel novo COM tolerância aplica (pela assinatura); sem query também', async () => {
  const painel = await subirPainel({ raiz: h.RAIZ_SUJEITO, db: dbNovo, porta: portaNovo, segredo: SEGREDO_NOVO, extra: { [FLAG_PAINEL]: '1' } });
  try {
    assert.match(painel.log, new RegExp(`${FLAG_PAINEL}=1 — TRANSIÇÃO`));
    await configurarRemetente(portaNovo);
    const comFlag = await subirGo({ portaPainel: portaNovo, legado: true, flag: '1' });
    try {
      await provarAplicado(comFlag, dbNovo, await novoDestinatario(dbNovo), 'delivered');
      await provarAplicado(comFlag, dbNovo, await novoDestinatario(dbNovo), 'read');
      assert.equal(painel.log.match(/repasse com a query legada aceito pela assinatura/g).length, 1, 'aviso único por processo');
    } finally {
      await comFlag.parar();
    }
    // Passo 3 (Go sem query, flag desligada) com a tolerância ainda ligada.
    const limpo = await subirGo({ portaPainel: portaNovo, legado: false });
    try {
      await provarAplicado(limpo, dbNovo, await novoDestinatario(dbNovo), 'delivered');
    } finally {
      await limpo.parar();
    }
    assert.doesNotMatch(painel.log, /repasse recusado/);
    semSegredoNosLogs(painel);
  } finally {
    await painel.parar();
  }
});

cenario('R19 · painel novo SEM tolerância: Go com a flag → 401 (rodada 18 preservada); Go sem a flag → aplica', async () => {
  const painel = await subirPainel({ raiz: h.RAIZ_SUJEITO, db: dbNovo, porta: portaNovo, segredo: SEGREDO_NOVO });
  try {
    assert.doesNotMatch(painel.log, /TRANSIÇÃO/);
    const comFlag = await subirGo({ portaPainel: portaNovo, legado: true, flag: '1' });
    try {
      await provarRecusado(comFlag, dbNovo, await novoDestinatario(dbNovo), 'delivered', 401);
      assert.match(painel.log, /repasse recusado \(401\): segredo na query string recusado/);
    } finally {
      await comFlag.parar();
    }
    const limpo = await subirGo({ portaPainel: portaNovo, legado: false });
    try {
      await provarAplicado(limpo, dbNovo, await novoDestinatario(dbNovo), 'read');
    } finally {
      await limpo.parar();
    }
    semSegredoNosLogs(painel);
  } finally {
    await painel.parar();
  }
});

cenario('R19 · painel novo com a query legada SEM assinatura válida → 401 mesmo com tolerância', async () => {
  const painel = await subirPainel({ raiz: h.RAIZ_SUJEITO, db: dbNovo, porta: portaNovo, segredo: SEGREDO_NOVO, extra: { [FLAG_PAINEL]: '1' } });
  try {
    const wamid = await novoDestinatario(dbNovo);
    const corpo = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    const url = `http://127.0.0.1:${portaNovo}/api/webhooks/whatsapp`;
    const ts = String(Math.floor(Date.now() / 1000));
    const assinatura = (segredo) => `v1=${crypto.createHmac('sha256', segredo).update(`${ts}.`).update(corpo).digest('hex')}`;
    for (const [nome, secret, headers] of [
      ['query legada, sem headers', SEGREDO_LEGADO, {}],
      ['query = segredo novo, sem headers', SEGREDO_NOVO, {}],
      ['query legada, assinatura com o segredo legado', SEGREDO_LEGADO, { 'X-Oria-Forward-Timestamp': ts, 'X-Oria-Forward-Signature': assinatura(SEGREDO_LEGADO) }],
    ]) {
      const r = await fetch(`${url}?secret=${encodeURIComponent(secret)}`, { method: 'POST', body: corpo, headers: { 'Content-Type': 'application/json', ...headers } });
      assert.equal(r.status, 401, nome);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await statusDe(dbNovo, wamid), 'sent');
    semSegredoNosLogs(painel);
  } finally {
    await painel.parar();
  }
});

cenario('R19 · painel novo com valor inválido na flag de tolerância não sobe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-r19-flag-'));
  const p = processo('painel flag inválida', process.execPath, [path.join(h.RAIZ_SUJEITO, 'server.js')], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(await livre()), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(dbNovo.url, dbNovo.role, dbNovo.senhaRole), DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA, ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      WHATSAPP_WEBHOOK_SECRET: SEGREDO_NOVO, [FLAG_PAINEL]: 'true',
    },
  });
  const code = await Promise.race([p.saiu, new Promise((r) => setTimeout(() => r('rodando'), 20000))]);
  if (code === 'rodando') await p.parar();
  assert.notEqual(code, 'rodando', `o painel subiu com ${FLAG_PAINEL}=true:\n${p.log.slice(-1500)}`);
  assert.notEqual(code, 0);
  assert.match(p.log, new RegExp(`${FLAG_PAINEL} inválida`));
  assert.ok(!p.log.includes(SEGREDO_NOVO));
});
