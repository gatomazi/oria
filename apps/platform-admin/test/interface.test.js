'use strict';

// A interface do Oria Admin — o que o servidor entrega de `public/` e o que esse conteúdo NÃO
// pode conter.
//
// ── Por que estes testes existem ─────────────────────────────────────────────────────────────
// A UI é HTML/CSS/JS servidos direto pelo mesmo processo da API. Isso apaga a fronteira entre
// "frontend" e "superfície de plataforma": um `<script src>` para um host externo passa a ser
// execução de terceiro DENTRO do control plane, e um `document.cookie` no bundle passa a ser
// leitura de sessão por script. Nenhuma das duas coisas dispara erro — o sintoma é silêncio.
// Então as invariantes viram teste:
//
//   1. o estático serve o que deve servir, com o tipo e o cache certos;
//   2. o fallback de SPA NUNCA engole `/api/*` — uma rota de API inexistente continua 404 JSON;
//   3. `..` não sai da raiz estática, nem percent-encoded;
//   4. nenhum arquivo de `public/` aponta para host externo;
//   5. nenhum arquivo de `public/` carrega nome de segredo;
//   6. o JS da interface não lê `document.cookie` nem guarda estado em armazenamento do browser;
//   7. os vocabulários fechados que a UI rotula batem com os do backend.
//
// Os controles negativos `public-external-host`, `spa-fallback-swallows-api`, `ui-reads-cookie`,
// `static-path-traversal` e `ui-vocabulary-drift` (scripts/negative-controls.mjs) reintroduzem cada
// defeito numa cópia e exigem que ESTE arquivo reprove.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const h = require('./harness');

const RAIZ_PUBLICA = path.join(h.RAIZ_SUJEITO, 'public');

let db;
let app;

test.before(async () => {
  db = await h.bancoNovo();
  app = await h.subirApp(db.url);
});

test.after(async () => {
  await app.fechar();
  await db.destruir();
});

// ── Utilitários ──────────────────────────────────────────────────────────────────────────────

function arquivosPublicos(diretorio = RAIZ_PUBLICA, acumulado = []) {
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const completo = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) arquivosPublicos(completo, acumulado);
    else acumulado.push(completo);
  }
  return acumulado;
}

const relativo = (arquivo) => path.relative(RAIZ_PUBLICA, arquivo);

const textuais = () => arquivosPublicos().filter((a) => /\.(html|css|js|svg|json)$/i.test(a));

const cru = (arquivo) => fs.readFileSync(arquivo, 'utf8');

// ── 1. O estático ────────────────────────────────────────────────────────────────────────────

test('interface · a raiz serve o index.html, sem cache e com nosniff', async () => {
  const r = await app.cliente.get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html; charset=utf-8$/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  // O index precisa ser revalidado sempre: é ele que carrega a versão nova dos módulos.
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.texto, /<title>Oria Admin/);
  assert.match(r.texto, /Control plane|control plane/i,
    'o index precisa deixar claro que esta superfície é o control plane, não o painel do lojista');
});

test('interface · a folha de estilo e os módulos saem com o tipo certo e nosniff', async () => {
  const css = await app.cliente.get('/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css; charset=utf-8$/);
  assert.equal(css.headers.get('x-content-type-options'), 'nosniff');

  const js = await app.cliente.get('/js/main.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript; charset=utf-8$/);
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff');

  const svg = await app.cliente.get('/favicon.svg');
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
});

test('interface · rota de UI inexistente cai no index (fallback de SPA)', async () => {
  for (const caminho of ['/organizations', '/organizations/nao-existe', '/plans', '/audit', '/tela-que-nao-existe']) {
    const r = await app.cliente.get(caminho);
    assert.equal(r.status, 200, `${caminho} deveria cair no index`);
    assert.match(r.headers.get('content-type'), /^text\/html/, `${caminho} deveria devolver HTML`);
    assert.match(r.texto, /<title>Oria Admin/, `${caminho} deveria devolver o index`);
  }
});

// ── 2. O fallback NÃO engole a API ───────────────────────────────────────────────────────────

test('interface · rota de API inexistente continua 404 JSON e NÃO cai no index', async () => {
  for (const caminho of ['/api/platform/nao-existe', '/api/platform/organizations/x/y/z', '/api/qualquer-coisa']) {
    const r = await app.cliente.get(caminho);
    assert.equal(r.status, 404, `${caminho} deveria ser 404`);
    assert.match(r.headers.get('content-type'), /^application\/json/,
      `${caminho} devolveu ${r.headers.get('content-type')} — o fallback de SPA engoliu uma rota de API`);
    assert.ok(r.corpo && r.corpo.erro, `${caminho} deveria devolver o envelope de erro`);
    assert.doesNotMatch(r.texto, /<title>/, `${caminho} devolveu HTML: o index vazou para a API`);
  }
});

test('interface · a API autenticada continua respondendo 401, não o index', async () => {
  const r = await app.cliente.get('/api/platform/overview');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.equal(r.corpo.erro, 'nao_autenticado');
});

// ── 3. Traversal ─────────────────────────────────────────────────────────────────────────────

test('interface · `..` não sai da raiz estática, nem percent-encoded', async () => {
  const proibidos = [
    '/../package.json',
    '/..%2fpackage.json',
    '/..%2F..%2Fpackage.json',
    '/js/..%2f..%2fpackage.json',
    '/%2e%2e/package.json',
    '/js/../../package.json',
    '/..%5cpackage.json',
  ];
  for (const caminho of proibidos) {
    const r = await app.cliente.get(caminho);
    assert.notEqual(r.status, 500, `${caminho} derrubou o servidor`);
    assert.doesNotMatch(r.texto, /"name":\s*"oria-platform-admin"/,
      `${caminho} vazou o package.json de fora da raiz estática`);
    assert.doesNotMatch(r.texto, /oria-platform-admin/,
      `${caminho} devolveu conteúdo de fora de public/`);
  }
});

test('interface · nenhum caminho serve arquivo de lib/ ou de node_modules/', async () => {
  for (const caminho of ['/lib/config.js', '/server.js', '/package.json', '/node_modules/pg/package.json']) {
    const r = await app.cliente.get(caminho);
    // Cai no index (não existe em public/) — o que não pode é devolver o arquivo real.
    assert.doesNotMatch(r.texto, /DATABASE_URL|require\('pg'\)|"dependencies"/,
      `${caminho} devolveu conteúdo do servidor`);
  }
});

// ── 4. Nenhum host externo ───────────────────────────────────────────────────────────────────

test('interface · nenhum arquivo de public/ referencia host externo', () => {
  // Qualquer esquema absoluto e qualquer URL protocol-relative. A UI é same-origin: tudo que ela
  // carrega sai deste mesmo processo, e tudo que ela chama é caminho relativo `/api/platform/...`.
  const absoluto = /\bhttps?:\/\/[^\s"'`)]+/gi;
  const protocoloRelativo = /(?:src|href|from|import\s*\(|url\()\s*["'(]?\/\/[a-z0-9.-]+/gi;

  const ofensas = [];
  for (const arquivo of textuais()) {
    const texto = cru(arquivo);
    for (const achado of texto.match(absoluto) || []) {
      // A única URL absoluta tolerada é o namespace XML do SVG, que o browser não busca na rede.
      if (achado.startsWith('http://www.w3.org/2000/svg')) continue;
      ofensas.push(`${relativo(arquivo)}: ${achado}`);
    }
    for (const achado of texto.match(protocoloRelativo) || []) {
      ofensas.push(`${relativo(arquivo)}: ${achado}`);
    }
  }
  assert.deepEqual(ofensas, [],
    `public/ não pode carregar nem chamar host externo:\n${ofensas.join('\n')}`);
});

test('interface · o index não carrega script nem folha de estilo de fora', () => {
  const index = cru(path.join(RAIZ_PUBLICA, 'index.html'));
  for (const atributo of index.match(/(?:src|href)\s*=\s*"([^"]*)"/gi) || []) {
    const valor = atributo.replace(/^[^"]*"/, '').replace(/"$/, '');
    assert.ok(valor.startsWith('/') || valor.startsWith('#'),
      `o index referencia "${valor}" — só caminho local é aceito`);
    assert.ok(!valor.startsWith('//'), `o index referencia "${valor}" — protocol-relative é host externo`);
  }
});

// ── 5. Nenhum nome de segredo ────────────────────────────────────────────────────────────────

test('interface · nenhum arquivo de public/ carrega nome de segredo', () => {
  const proibidos = [
    'DATABASE_URL',
    'PLATFORM_ADMIN_SESSION_SECRET',
    'ADMIN_SESSION_SECRET',
    'PLATFORM_ADMIN_PASSWORD',
    'password_hash',
    'token_hash',
    'ciphertext',
    'integration_secrets',
  ];
  const ofensas = [];
  for (const arquivo of textuais()) {
    const texto = cru(arquivo);
    for (const nome of proibidos) {
      if (texto.includes(nome)) ofensas.push(`${relativo(arquivo)}: ${nome}`);
    }
  }
  assert.deepEqual(ofensas, [],
    `nome de segredo não entra no que é servido ao browser:\n${ofensas.join('\n')}`);
});

// ── 6. A UI não lê cookie e não guarda estado no browser ─────────────────────────────────────

test('interface · o JS da interface NUNCA lê document.cookie', () => {
  // O cookie de sessão é HttpOnly e host-only (§4.1). Se a UI lê cookie, ou o cookie deixou de ser
  // HttpOnly, ou alguém está inventando um segundo canal de sessão. Os dois são regressão.
  const ofensas = [];
  for (const arquivo of arquivosPublicos().filter((a) => a.endsWith('.js'))) {
    const texto = cru(arquivo);
    if (/document\s*\.\s*cookie/.test(texto)) ofensas.push(relativo(arquivo));
  }
  assert.deepEqual(ofensas, [], `a interface não pode ler cookie: ${ofensas.join(', ')}`);
});

test('interface · o csrfToken e a sessão não vão para armazenamento do browser', () => {
  // §11.1: o csrfToken fica EM MEMÓRIA. localStorage/sessionStorage/IndexedDB sobrevivem à aba e
  // são legíveis por qualquer script do mesmo host — não é onde token de sessão mora.
  const ofensas = [];
  for (const arquivo of arquivosPublicos().filter((a) => a.endsWith('.js'))) {
    const texto = cru(arquivo);
    for (const padrao of [/localStorage/, /sessionStorage/, /indexedDB/i]) {
      if (padrao.test(texto)) ofensas.push(`${relativo(arquivo)}: ${padrao}`);
    }
  }
  assert.deepEqual(ofensas, [], `estado de sessão não vai para armazenamento do browser:\n${ofensas.join('\n')}`);
});

test('interface · toda chamada de API sai por caminho relativo sob /api/platform', async () => {
  const api = await import(pathToFileURL(path.join(RAIZ_PUBLICA, 'js', 'api.js')).href);
  assert.equal(typeof api.query, 'function');
  // `fetch` é sempre montado sobre a constante BASE; nenhum host aparece no módulo.
  const texto = cru(path.join(RAIZ_PUBLICA, 'js', 'api.js'));
  assert.match(texto, /const BASE = '\/api\/platform'/);
  assert.match(texto, /credentials: 'same-origin'/);
  assert.match(texto, /X-CSRF-Token/);
  assert.doesNotMatch(texto, /mode:\s*'cors'/, 'a UI é same-origin: não existe modo CORS aqui');
});

// ── 7. Vocabulários: a UI rotula o que o backend define ──────────────────────────────────────

test('interface · os vocabulários da UI batem com os do backend', async () => {
  const vocab = await import(pathToFileURL(path.join(RAIZ_PUBLICA, 'js', 'vocabulario.js')).href);
  const { FEATURES } = h.sujeito('lib/entitlements.js');
  const { PASSOS, PASSOS_ESTRUTURAIS } = h.sujeito('lib/organizations.js');
  const { ACOES } = h.sujeito('lib/audit.js');
  const { PAPEIS } = h.sujeito('lib/admins.js');

  assert.deepEqual([...vocab.FEATURES], [...FEATURES],
    'a lista de features da UI divergiu do registry do control plane');
  assert.deepEqual([...vocab.PASSOS_ONBOARDING], [...PASSOS],
    'os passos de onboarding da UI divergiram do backend');
  assert.deepEqual([...vocab.PASSOS_ESTRUTURAIS], [...PASSOS_ESTRUTURAIS],
    'os passos estruturais da UI divergiram do backend');
  assert.deepEqual([...vocab.ACOES_AUDITORIA], [...ACOES],
    'o vocabulário de auditoria da UI divergiu do backend');
  assert.deepEqual([...vocab.PAPEIS_ADMIN].sort(), [...PAPEIS].sort(),
    'os papéis de platform admin da UI divergiram do backend');

  // Rotular é opcional; deixar uma feature sem rótulo não é — a tela mostraria a chave crua.
  for (const feature of FEATURES) {
    assert.ok(vocab.ROTULO_FEATURE[feature], `feature ${feature} sem rótulo na UI`);
  }
  for (const passo of PASSOS) {
    assert.ok(vocab.ROTULO_PASSO[passo], `passo ${passo} sem rótulo na UI`);
  }
});

test('interface · o roteador da UI recusa returnUrl que não seja caminho local', async () => {
  // Mesma propriedade do §11.8, do lado do browser: a UI nunca monta destino com host de fora.
  const { caminhoLocal } = await import(pathToFileURL(path.join(RAIZ_PUBLICA, 'js', 'caminhos.js')).href);
  for (const bom of ['/', '/organizations', '/organizations/abc?aba=planos']) {
    assert.equal(caminhoLocal(bom), bom, `${bom} é caminho local e deveria passar`);
  }
  for (const ruim of ['//evil.example', '/\\evil.example', 'evil.example', '', null, undefined,
    '/\\/evil.example', '\\/evil.example']) {
    assert.equal(caminhoLocal(ruim), null, `${JSON.stringify(ruim)} não é caminho local e não pode passar`);
  }
});

// ── 8. A interface existe de verdade ─────────────────────────────────────────────────────────

test('interface · as telas do contrato têm rota na UI', async () => {
  const { TELAS, casar } = await import(pathToFileURL(path.join(RAIZ_PUBLICA, 'js', 'caminhos.js')).href);
  const esperadas = [
    '/', '/organizations', '/organizations/:organizationId', '/plans', '/platform-admins',
    '/users', '/onboardings', '/integrations', '/jobs', '/webhooks', '/audit',
  ];
  assert.deepEqual(TELAS.map((t) => t.padrao), esperadas);
  const casado = casar('/organizations/8b0b0b0b-0000-0000-0000-000000000000?aba=convites');
  assert.equal(casado.tela.modulo, 'organization');
  assert.equal(casado.params.organizationId, '8b0b0b0b-0000-0000-0000-000000000000');
  assert.equal(casado.busca.get('aba'), 'convites');
});

test('interface · todo módulo referenciado pela UI existe em public/', () => {
  const faltando = [];
  for (const arquivo of arquivosPublicos().filter((a) => a.endsWith('.js'))) {
    const texto = cru(arquivo);
    const referencias = [
      ...(texto.match(/from\s+'([^']+)'/g) || []),
      ...(texto.match(/import\('([^']+)'\)/g) || []),
    ].map((m) => m.replace(/.*'([^']+)'.*/, '$1')).filter((m) => m.startsWith('.'));
    for (const referencia of referencias) {
      const destino = path.resolve(path.dirname(arquivo), referencia);
      if (!fs.existsSync(destino)) faltando.push(`${relativo(arquivo)} → ${referencia}`);
    }
  }
  assert.deepEqual(faltando, [], `módulo referenciado e inexistente:\n${faltando.join('\n')}`);
});

test('interface · o index referencia apenas arquivos que existem em public/', () => {
  const index = cru(path.join(RAIZ_PUBLICA, 'index.html'));
  const referencias = (index.match(/(?:src|href)\s*=\s*"(\/[^"#]+)"/gi) || [])
    .map((m) => m.replace(/^[^"]*"/, '').replace(/"$/, ''));
  assert.ok(referencias.length >= 2, 'o index deveria carregar ao menos a folha de estilo e o módulo principal');
  for (const referencia of referencias) {
    assert.ok(fs.existsSync(path.join(RAIZ_PUBLICA, referencia.replace(/^\//, ''))),
      `o index referencia ${referencia}, que não existe em public/`);
  }
});

test('interface · toda extensão publicada em public/ é servível pelo mapa de tipos', () => {
  // Um arquivo com extensão fora de TIPOS_ESTATICOS sairia como application/octet-stream — e o
  // browser não executaria o módulo. É erro de publicação, não de runtime: aparece aqui.
  const fonte = fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'lib', 'app.js'), 'utf8');
  const bloco = fonte.slice(fonte.indexOf('const TIPOS_ESTATICOS'), fonte.indexOf('});', fonte.indexOf('const TIPOS_ESTATICOS')));
  const conhecidas = new Set((bloco.match(/'\.[a-z0-9]+'/g) || []).map((s) => s.replace(/'/g, '')));
  const desconhecidas = [...new Set(arquivosPublicos().map((a) => path.extname(a).toLowerCase()))]
    .filter((e) => !conhecidas.has(e));
  assert.deepEqual(desconhecidas, [], `extensões publicadas sem tipo declarado: ${desconhecidas.join(', ')}`);
});
