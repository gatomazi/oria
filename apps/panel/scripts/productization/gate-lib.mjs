// Second Tenant Gate executável (rodada 18, trilha D) — avaliação pura.
//
// Três blocos, nunca misturados:
//
//   CODE GATES     o código está tecnicamente pronto? (suíte, invariants, checagens estáticas, Go)
//   OPS GATES      OPS-01..36: só VERIFIED com arquivo de evidência explícito; ausência = NOT VERIFIED
//   DOGFOOD GATE   14 dias com a Organization interna: NOT STARTED até existir evidência; os dias vêm
//                  do relógio desde `dogfood_started_at`, nunca de status/data de fim declarados
//
// Regra do gate: nenhum check vira PASS por ausência de informação. Suíte não rodada, repositório do
// Go não encontrado, teste esperado que não apareceu, evidência inválida — tudo isso é NOT VERIFIED
// ou FAIL, e os dois bloqueiam. Este arquivo não executa nada: recebe eventos e caminhos e devolve
// o relatório (a CLI é gate.mjs), para que cada regra tenha controle negativo por teste unitário.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const NAO_VERIFICADO = 'NOT VERIFIED';

// Piso de testes da suíte completa (bfd00a6: 710; rodada 18: 806; rodada 19 consolidada, trilhas E–H: 894). Só sobe: uma
// suíte que encolheu em silêncio é o mesmo modo de falha de um teste que se pula.
export const MINIMO_DE_TESTES = 894;

// Contratos painel ↔ Go. A versão esperada é declarada aqui de propósito: mudar o contrato exige
// mudar o gate junto, e o gate confere que os dois lados carregam a mesma cópia.
export const CONTRATOS_GO = Object.freeze([
  { arquivo: 'sender-contract-v1.json', contrato: 'oria-whatsapp-sender', versao: 1, fase: '5b' },
  { arquivo: 'inbound-context-v1.json', contrato: 'oria-whatsapp-context', versao: 1, fase: '5c' },
  { arquivo: 'forward-auth-v1.json', contrato: 'oria-whatsapp-forward-auth', versao: 1, fase: 'r18' },
]);

// Remetente/identidade de processo que não pode voltar (INV-25/INV-27). Só o script de import do
// remetente (scripts/integrations/import-whatsapp-sender.mjs) conhece esses nomes.
export const ENV_REMETENTE_PADRAO = /\b(META_PHONE_NUMBER_ID|META_ACCESS_TOKEN|META_WABA_ID|WHATSAPP_LEGACY_[A-Z_]+)\b/;

export const FORMATO_RELATORIO_GO = 'oria-go-gate-report/v1';
export const FORMATO_EVIDENCIA_OPS = 'oria-ops-evidence/v1';
export const DIR_EVIDENCIA_PADRAO = path.join('docs', 'produtizacao-saas', 'ops-evidence');

// ── Catálogo OPS ───────────────────────────────────────────────────────────────────────────────
// Fonte: productization-plan.md (seção SECOND TENANT GATE para OPS-01..10; Fases 0-5c para 11-26),
// whatsapp-sender-contract.md §9 e whatsapp-inbound-5c.md §8. A ordem de execução está em
// production-rollout-runbook.md. OPS-06/07/08 foram registrados VERIFIED na rodada 8
// (productization-progress.md), mas sem arquivo de evidência no formato do gate continuam NOT
// VERIFIED aqui: o registro precisa ser refeito no formato, não presumido.
export const CATALOGO_OPS = Object.freeze([
  ['OPS-01', 'creative-lab sem networking público'],
  ['OPS-02', 'CREATIVE_CORE_URL no domínio privado'],
  ['OPS-03', 'volume persistente montado (STORAGE_DIR/UPLOADS_DIR/IMG_CACHE_DIR)'],
  ['OPS-04', 'backups do Postgres habilitados e testados por restauração'],
  ['OPS-05', 'DATABASE_URL presente (painel)'],
  ['OPS-06', 'META_APP_SECRET definido (Go) — registrado VERIFIED na rodada 8, sem evidência no formato'],
  ['OPS-07', 'API_KEY definida (Go) — registrado VERIFIED na rodada 8, sem evidência no formato'],
  ['OPS-08', 'DATABASE_URL definida (Go) — registrado VERIFIED na rodada 8, sem evidência no formato'],
  ['OPS-09', 'WEBHOOK_FORWARD_URL conhecida e autenticada'],
  ['OPS-10', 'natureza do token da Meta conhecida (absorvido por OPS-27; NOT_APPLICABLE só com reason)'],
  ['OPS-11', 'Pre-deploy Command = npm run migrate:up (role de migration)'],
  ['OPS-12', 'ENCRYPTION_MASTER_KEY (32 bytes, base64) no ambiente do painel'],
  ['OPS-13', 'ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1 até a re-cifra (OPS-25)'],
  ['OPS-14', 'DATABASE_URL do app -> oria_app + DB_ENFORCE_APP_ROLE=1'],
  ['OPS-15', 'Node >= 20.11 no build do Railway'],
  ['OPS-16', 'PD-019 decidido e TENANCY_MAPPING_FILE publicado no pre-deploy'],
  ['OPS-17', 'deploy em dois passos da Fase 1 (b8f2ac7 antes de fee17e7+), se a base estiver antes da Fase 1'],
  ['OPS-18', 'owner(s) criados por auth:bootstrap-owner com Organizations explícitas'],
  ['OPS-19', 'ALLOW_LEGACY_ADMIN_PASSWORD só na release N; removido na N+1'],
  ['OPS-20', 'ADMIN_SESSION_SECRET >= 32 caracteres em produção'],
  ['OPS-21', 'seed explícito de entitlements de cada Organization interna'],
  ['OPS-22', 'arquivos do Creative Core movidos para a pasta da Organization'],
  ['OPS-23', 'integrations:import-legacy --aplicar no pre-deploy'],
  ['OPS-24', 'ALLOW_LEGACY_INTEGRATION_ENV só na release N; limpeza de colunas e env na N+1'],
  ['OPS-25', 'integrations:reencrypt sem pendentes; depois remover ENCRYPTION_ALLOW_LEGACY_SESSION_KEY'],
  ['OPS-26', 'POST /api/admin/integrations/<provider>/teste na Organization interna após o deploy'],
  ['OPS-27', 'META_APP_SECRET pertence ao META_APP_ID do Go e webhook real passa no HMAC (bateria 5a)'],
  ['OPS-28', 'segredos do contrato de remetente (painel e Go) configurados'],
  ['OPS-29', 'integrations:import-whatsapp-sender --aplicar para a Organization interna'],
  ['OPS-30', 'fila antiga do Go esvaziada antes do cutover; teste da integração whatsapp'],
  ['OPS-31', 'App da plataforma inscrito na WABA de cada cliente (subscribed_apps)'],
  ['OPS-32', 'LEGACY_ORGANIZATION_ID no Go durante a migration 2; removido depois'],
  ['OPS-33', 'extrator de problemas manda X-Sender-Phone-Number-Id + X-Sender-Ref'],
  ['OPS-34', 'cutover da URL opaca do webhook da Ink; INK_WEBHOOK_SECRET_* removidos depois'],
  ['OPS-35', 'META_GRAPH_BASE_URL ausente em produção; REPLY_* removidas do Go'],
  // Rodada 19 (§10): último passo do runbook, depois do CLEANUP e do OPS-25 completo.
  ['OPS-36', 'ADMIN_SESSION_SECRET rotacionado por último (0 ciphertext legado, ENCRYPTION_ALLOW_LEGACY_SESSION_KEY removida, suíte/smoke verdes)'],
].map(([id, titulo]) => Object.freeze({ id, titulo })));

// Rodada 19 (§13): constante do gate. Um DOGFOOD.json que declare outro número é FAIL.
export const DIAS_DE_DOGFOOD = 14;
// Referência factual do rollout: o dogfood só conta a partir das etapas finais do runbook. OPS-14
// (RELEASE F, app role) e OPS-36 (rotação do ADMIN_SESSION_SECRET, último passo — consolidação da
// rodada 19) precisam estar VERIFIED — NOT_APPLICABLE não serve — com `verified_at` ≤
// `dogfood_started_at`. Cada uma é exigida.
export const REFERENCIAS_DO_DOGFOOD = Object.freeze(['OPS-14', 'OPS-36']);
// Marcação manual que o formato antigo (rodada 18) aceitava e que não pode mais fechar o gate.
export const CAMPOS_MANUAIS_DO_DOGFOOD = Object.freeze(['status', 'started_at', 'ended_at', 'completed_at', 'closed_at', 'days', 'elapsed_days']);

// ── Utilidades ─────────────────────────────────────────────────────────────────────────────────

function combinar(...status) {
  if (status.includes(FAIL)) return FAIL;
  if (status.includes(NAO_VERIFICADO)) return NAO_VERIFICADO;
  return PASS;
}

// macOS: /tmp e /var são links para /private/...; o runner reporta o caminho real.
function real(arq) {
  try { return fs.realpathSync(arq); } catch { return path.resolve(arq); }
}

function rel(raiz, arq) {
  return path.relative(raiz, arq).split(path.sep).join('/');
}

function listar(dir, filtro) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map((x) => path.join(dir, String(x)))
    .filter((x) => filtro(x) && fs.statSync(x).isFile());
}

// Linhas que casam o padrão, ignorando comentário de linha (// e --).
function procurar(raiz, arquivos, padrao) {
  const achados = [];
  for (const arq of arquivos) {
    fs.readFileSync(arq, 'utf8').split('\n').forEach((linha, i) => {
      const t = linha.trimStart();
      if (t.startsWith('//') || t.startsWith('--') || t.startsWith('*')) return;
      if (padrao.test(linha)) achados.push(`${rel(raiz, arq)}:${i + 1}: ${linha.trim().slice(0, 160)}`);
    });
  }
  return achados;
}

export function arquivosDoApp(raiz) {
  const js = (x) => /\.(c?js|mjs)$/.test(x) && !x.includes(`${path.sep}node_modules${path.sep}`);
  return [path.join(raiz, 'server.js'), ...listar(path.join(raiz, 'lib'), js), ...listar(path.join(raiz, 'routes'), js)]
    .filter((x) => fs.existsSync(x));
}

export function lerEventos(arquivo) {
  if (!arquivo || !fs.existsSync(arquivo)) return [];
  return fs.readFileSync(arquivo, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── Suíte ──────────────────────────────────────────────────────────────────────────────────────

export function resumirSuite(eventos) {
  const testes = eventos.filter((e) => e.tipo !== 'suite');
  return {
    testes: testes.length,
    pass: testes.filter((e) => e.status === 'pass' && !e.skip && !e.todo).length,
    fail: testes.filter((e) => e.status === 'fail').length,
    skipped: testes.filter((e) => e.skip).length,
    todo: testes.filter((e) => e.todo).length,
    cancelled: testes.filter((e) => e.falha === 'cancelledByParent').length,
  };
}

// Um arquivo "passa" quando rodou (≥ 1 teste de nível 0), nada falhou e nada foi pulado.
function estadoDoArquivo(raiz, eventos, relativo) {
  const alvo = real(path.join(raiz, relativo));
  const doArquivo = eventos.filter((e) => e.file && real(e.file) === alvo);
  const problemas = [];
  if (!doArquivo.some((e) => e.nesting === 0 && e.status === 'pass' && !e.skip && !e.todo)) problemas.push(`${relativo}: nenhum teste executado`);
  for (const e of doArquivo) {
    if (e.status === 'fail') problemas.push(`${relativo}: FALHOU · ${e.name}`);
    else if (e.skip) problemas.push(`${relativo}: PULADO · ${e.name} (${e.skip})`);
    else if (e.todo) problemas.push(`${relativo}: TODO · ${e.name} (${e.todo})`);
  }
  return problemas;
}

function estadoDoTeste(eventos, relativo, nome) {
  const achados = eventos.filter((e) => e.file && e.file.split(path.sep).join('/').endsWith(relativo)
    && (nome instanceof RegExp ? nome.test(e.name) : e.name === nome));
  if (!achados.length) return [`${relativo}: teste esperado não executou · ${nome}`];
  return achados.filter((e) => e.status !== 'pass' || e.skip || e.todo)
    .map((e) => `${relativo}: ${e.status === 'fail' ? 'FALHOU' : 'PULADO'} · ${e.name}`);
}

// Checks derivados da suíte. `suite` = { exitCode, eventos } ou null (suíte não rodada).
export function avaliarSuite(suite, { raiz, minimoDeTestes = MINIMO_DE_TESTES } = {}) {
  if (!suite) {
    const motivo = 'suíte não executada nesta chamada (--skip-suite)';
    return {
      resumo: null,
      partes: {
        suite: { status: NAO_VERIFICADO, detalhes: [motivo] },
        invariants: { status: NAO_VERIFICADO, detalhes: [motivo] },
        pulados: { status: NAO_VERIFICADO, detalhes: [motivo] },
        rls: { status: NAO_VERIFICADO, detalhes: [motivo] },
        appRole: { status: NAO_VERIFICADO, detalhes: [motivo] },
        crossOrg: { status: NAO_VERIFICADO, detalhes: [motivo] },
        fallback: { status: NAO_VERIFICADO, detalhes: [motivo] },
        goE2e: { status: NAO_VERIFICADO, detalhes: [motivo] },
      },
    };
  }
  const { eventos } = suite;
  const resumo = resumirSuite(eventos);
  const parte = (problemas, ok) => ({ status: problemas.length ? FAIL : PASS, detalhes: problemas.length ? problemas : [ok] });
  const arquivos = (lista) => lista.flatMap((a) => estadoDoArquivo(raiz, eventos, a));

  const suiteProblemas = [];
  if (suite.exitCode !== 0) suiteProblemas.push(`npm test saiu com ${suite.exitCode}`);
  if (resumo.fail) suiteProblemas.push(`${resumo.fail} teste(s) falharam`);
  if (resumo.testes < minimoDeTestes) suiteProblemas.push(`${resumo.testes} testes < piso ${minimoDeTestes}`);

  const invariants = fs.readdirSync(path.join(raiz, 'test', 'invariants'))
    .filter((x) => x.endsWith('.test.js')).sort().map((x) => `test/invariants/${x}`);

  const pulados = eventos.filter((e) => e.skip || e.todo)
    .map((e) => `${e.file ? rel(raiz, e.file) : '?'}: ${e.skip ? 'PULADO' : 'TODO'} · ${e.name} (${e.skip || e.todo})`);
  if (resumo.cancelled) pulados.push(`${resumo.cancelled} teste(s) cancelados`);

  return {
    resumo,
    partes: {
      suite: parte(suiteProblemas, `${resumo.testes} testes · ${resumo.pass} pass · ${resumo.fail} fail · exit ${suite.exitCode}`),
      invariants: parte(arquivos(invariants), `${invariants.length} arquivos de invariants verdes`),
      pulados: parte(pulados, 'skipped 0 · todo 0 · cancelled 0'),
      rls: parte(arquivos([
        'test/invariants/tenancy-schema.test.js', 'test/invariants/td001-rls-contract.test.js',
        'test/invariants/tenancy-db-negative-controls.test.js', 'test/invariants/tenancy-migrations.test.js',
      ]), 'tenancy-schema, td001-rls-contract, tenancy-db-negative-controls, tenancy-migrations verdes'),
      appRole: parte([
        ...arquivos(['test/invariants/td001-rls-contract.test.js', 'test/invariants/fase3-server-ab.test.js']),
        ...estadoDoTeste(eventos, 'test/invariants/boot-exit-code.test.js', /DB_ENFORCE_APP_ROLE=1 com superusuário/),
        ...estadoDoTeste(eventos, 'test/invariants/boot-exit-code.test.js', /DB_ENFORCE_APP_ROLE=1 com oria_app/),
      ], 'server.js sob oria_app (fase3-server-ab) e boot recusa superusuário'),
      crossOrg: parte(arquivos([
        'test/invariants/tenancy-isolation.test.js', 'test/invariants/fase3-server-ab.test.js',
        'test/invariants/fase4-integrations.test.js', 'test/invariants/inv-09-tenancy.test.js',
      ]), 'isolamento A/B verde (tenancy-isolation, fase3-server-ab, fase4-integrations, inv-09)'),
      fallback: parte(estadoDoTeste(eventos, 'test/invariants/fase4-integrations.test.js', /^INV-12 · fallback de env legado/),
        'INV-12 · fallback de env legado verde'),
      goE2e: parte(arquivos([
        'test/invariants/fase5b-whatsapp-sender.test.js', 'test/invariants/fase5b-server-whatsapp.test.js',
        'test/invariants/fase5c-e2e-whatsapp.test.js',
      ]), 'contrato 5b/5c e E2E com o binário Go verdes'),
    },
  };
}

// ── Checagens estáticas (contra `raiz`, que pode ser uma cópia com violação) ───────────────────

// Testes estáticos existentes (test/invariants/fase3-static.test.js) que o gate reaproveita,
// rodados com INVARIANT_SUBJECT_ROOT=raiz. Nome exato: teste renomeado ou sumido reprova o check.
export const TESTES_ESTATICOS = Object.freeze({
  seletor: [
    'INV-01/03 · nenhuma rota lê loja ou store do request',
    'INV-01/03 · nenhuma rota do server.js tem segmento /:loja',
    'INV-01/10 · o painel não escolhe loja nem manda tenant para a API',
  ],
  agregacao: [
    'INV-10 · sem modo agregado de lojas',
    'F-02 / TD-005 · nada percorre lojas ou segredos: nem a entrada do webhook',
  ],
  credencial: ['INV-12 · credencial de tenant não vem de env global nem das colunas antigas no código da app'],
  truncate: ['INV-01 · nenhum TRUNCATE no código da aplicação (ignora RLS e apaga todas as Organizations)'],
  ink: ['F-02 / TD-005 · nada percorre lojas ou segredos: nem a entrada do webhook'],
});

function pelosTestesEstaticos(eventosEstaticos, chave) {
  if (!eventosEstaticos) return { status: NAO_VERIFICADO, detalhes: ['testes estáticos não executados'] };
  const problemas = TESTES_ESTATICOS[chave].flatMap((nome) => estadoDoTeste(eventosEstaticos, 'test/invariants/fase3-static.test.js', nome));
  return { status: problemas.length ? FAIL : PASS, detalhes: problemas.length ? problemas : [`fase3-static: ${TESTES_ESTATICOS[chave].length} teste(s) verdes`] };
}

function checarTruncate(raiz) {
  const manifesto = createRequire(import.meta.url)(path.join(raiz, 'lib', 'platform', 'tenancy-manifest.js'));
  const tabelas = new Set([...manifesto.nomesTenant(), ...manifesto.nomesSobRls(), ...manifesto.TABELAS_GLOBAIS]);
  const alvos = [
    ...arquivosDoApp(raiz),
    ...listar(path.join(raiz, 'scripts'), (x) => /\.(c?js|mjs)$/.test(x)),
    ...listar(path.join(raiz, 'migrations'), (x) => /\.(c?js|mjs|sql)$/.test(x)),
  ];
  const achados = procurar(raiz, alvos, /\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?["\w$]/i).filter((l) => {
    const m = l.match(/TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?([^;'"`]+)/i);
    // Sem nome legível (comando montado em runtime) não há como provar a tabela: reprova.
    if (!m) return true;
    return m[1].split(',').map((t) => t.trim().split(/\s+/)[0].replace(/^public\./, '').replace(/"/g, ''))
      .some((t) => tabelas.has(t) || !/^[a-z_][a-z0-9_]*$/.test(t));
  });
  return { status: achados.length ? FAIL : PASS, detalhes: achados.length ? achados : ['nenhum TRUNCATE de tabela do manifesto em app, scripts ou migrations'] };
}

function checarRotaInk(raiz) {
  const server = path.join(raiz, 'server.js');
  const problemas = procurar(raiz, [server], /app\.(get|post|put|patch|delete|all|use)\(\s*['"`]\/api\/webhooks\/ink(?!\/:token['"`])/);
  if (!procurar(raiz, [server], /app\.post\(\s*['"`]\/api\/webhooks\/ink\/:token['"`]/).length) {
    problemas.push('server.js: rota opaca /api/webhooks/ink/:token não encontrada');
  }
  return { status: problemas.length ? FAIL : PASS, detalhes: problemas.length ? problemas : ['só /api/webhooks/ink/:token (URL opaca, TD-005)'] };
}

function checarRemetentePadraoNoPainel(raiz) {
  const achados = procurar(raiz, arquivosDoApp(raiz), ENV_REMETENTE_PADRAO);
  return { status: achados.length ? FAIL : PASS, detalhes: achados.length ? achados : ['painel não lê META_*/WHATSAPP_LEGACY_* fora do script de import'] };
}

function checarRoleDaAplicacao(raiz) {
  const req = createRequire(import.meta.url);
  const problemas = [];
  try {
    const { sqlProvisionarAppRole, FUNCOES_DA_APLICACAO } = req(path.join(raiz, 'lib', 'platform', 'app-role.js'));
    const manifesto = req(path.join(raiz, 'lib', 'platform', 'tenancy-manifest.js'));
    const sql = sqlProvisionarAppRole({ role: 'oria_app_gate', senha: 'gate_sem_segredo_0000', tabelasSobRls: manifesto.nomesSobRls() });
    const criar = sql[0];
    for (const attr of ['NOSUPERUSER', 'NOBYPASSRLS', 'NOCREATEDB', 'NOCREATEROLE', 'NOINHERIT']) {
      if (!new RegExp(`\\b${attr}\\b`).test(criar)) problemas.push(`app-role.js: falta ${attr}`);
    }
    if (/(?<!NO)(SUPERUSER|BYPASSRLS)\b/.test(criar.replace(/NOSUPERUSER|NOBYPASSRLS/g, ''))) problemas.push('app-role.js: atributo privilegiado concedido');
    for (const t of manifesto.TABELAS_GLOBAIS_PRIVADAS) {
      if (!sql.includes(`REVOKE ALL ON ${t} FROM oria_app_gate;`)) problemas.push(`app-role.js: ${t} não é revogada`);
      if (sql.some((s) => /^GRANT/.test(s) && new RegExp(`\\b${t}\\b`).test(s))) problemas.push(`app-role.js: GRANT em tabela privada ${t}`);
    }
    if (!Array.isArray(FUNCOES_DA_APLICACAO) || !FUNCOES_DA_APLICACAO.length) problemas.push('app-role.js: lista de funções vazia');
  } catch (err) {
    problemas.push(`app-role.js não carregou: ${err.message}`);
  }
  const server = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  if (!/if \(exigirRoleDaAplicacao\(\)\) \{\s*const \{ role \} = await verificarRoleDaAplicacao\(/.test(server)) {
    problemas.push('server.js: boot não verifica a role quando DB_ENFORCE_APP_ROLE=1');
  }
  return { status: problemas.length ? FAIL : PASS, detalhes: problemas.length ? problemas : ['NOSUPERUSER NOBYPASSRLS NOINHERIT; privadas revogadas; boot verifica com DB_ENFORCE_APP_ROLE=1'] };
}

// Estado das flags legadas: o check passa se o DEFAULT é desligado e só '1' liga. A existência da
// flag é informada (é limpeza pendente, não defeito de código).
function checarFlagsLegadas(raiz) {
  const req = createRequire(import.meta.url);
  const problemas = [];
  const notas = [];
  try {
    const { createIntegrationResolver } = req(path.join(raiz, 'lib', 'platform', 'integrations.js'));
    const mudo = { log() {}, warn() {}, error() {} };
    const r = (env) => createIntegrationResolver({ pool: {}, segredos: {}, env, logger: mudo });
    if (typeof r({}).legadoAtivo !== 'function') {
      notas.push('ALLOW_LEGACY_INTEGRATION_ENV: removida do código');
    } else {
      if (r({}).legadoAtivo() !== false) problemas.push('ALLOW_LEGACY_INTEGRATION_ENV ligada por padrão');
      if (r({ ALLOW_LEGACY_INTEGRATION_ENV: 'true' }).legadoAtivo() !== false) problemas.push('ALLOW_LEGACY_INTEGRATION_ENV aceita valor diferente de 1');
      if (r({ ALLOW_LEGACY_INTEGRATION_ENV: '1' }).legadoAtivo() === true) notas.push('ALLOW_LEGACY_INTEGRATION_ENV: existe, desligada por padrão (remoção: OPS-24, release N+1)');
    }
  } catch (err) {
    problemas.push(`integrations.js não carregou: ${err.message}`);
  }
  try {
    const { createKeyring } = req(path.join(raiz, 'lib', 'secrets', 'keyring.js'));
    const chave = crypto.randomBytes(32).toString('base64');
    const segredo = 'x'.repeat(40);
    if (createKeyring({ ENCRYPTION_MASTER_KEY: chave, ADMIN_SESSION_SECRET: segredo }).legacyAtivo) {
      problemas.push('ENCRYPTION_ALLOW_LEGACY_SESSION_KEY ligada por padrão');
    } else {
      notas.push('ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: desligada por padrão (remoção depois de OPS-25)');
    }
  } catch (err) {
    problemas.push(`keyring.js não carregou: ${err.message}`);
  }
  return {
    integracoes: { status: problemas.length ? FAIL : PASS, detalhes: problemas.length ? problemas : notas },
  };
}

function checarAuthLegado(raiz) {
  const req = createRequire(import.meta.url);
  const problemas = [];
  const notas = [];
  try {
    const { resolverConfigAuth } = req(path.join(raiz, 'lib', 'auth', 'index.js'));
    if (resolverConfigAuth({}).legado.habilitado !== false) problemas.push('login legado ligado por padrão');
    if (resolverConfigAuth({ ALLOW_LEGACY_ADMIN_PASSWORD: '0', ADMIN_PASSWORD: 'x' }).legado.habilitado !== false) problemas.push('login legado ligado com 0');
    let recusou = false;
    try { resolverConfigAuth({ ALLOW_LEGACY_ADMIN_PASSWORD: '1', ADMIN_PASSWORD: 'x' }); } catch { recusou = true; }
    if (!recusou) problemas.push('ALLOW_LEGACY_ADMIN_PASSWORD=1 sem LEGACY_ADMIN_USER_EMAIL não é recusado');
    let producao = false;
    try { resolverConfigAuth({ NODE_ENV: 'production', ADMIN_SESSION_SECRET: 'curto' }); } catch { producao = true; }
    if (!producao) problemas.push('produção aceita ADMIN_SESSION_SECRET < 32');
    notas.push('ALLOW_LEGACY_ADMIN_PASSWORD: existe, desligada por padrão, exige e-mail real (remoção: OPS-19, release N+1)');
  } catch (err) {
    problemas.push(`lib/auth não carregou: ${err.message}`);
  }
  return { status: problemas.length ? FAIL : PASS, detalhes: problemas.length ? problemas : notas };
}

// ── Go ─────────────────────────────────────────────────────────────────────────────────────────

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function lerRelatorioGo(arquivo) {
  if (!arquivo) return null;
  if (!fs.existsSync(arquivo)) return { invalido: `relatório do Go não encontrado: ${arquivo}` };
  try {
    const r = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    if (r.format !== FORMATO_RELATORIO_GO) return { invalido: `formato do relatório do Go ≠ ${FORMATO_RELATORIO_GO}` };
    return r;
  } catch (err) {
    return { invalido: `relatório do Go ilegível: ${err.message}` };
  }
}

function arquivosGo(goDir) {
  return fs.readdirSync(goDir).filter((x) => x.endsWith('.go') && !x.endsWith('_test.go')).map((x) => path.join(goDir, x));
}

// Relatório que o gate emite quando o repositório do Go está disponível, para ser consumido onde ele
// não está (CI do painel). Não contém segredo: hashes, versões e resultados.
export function gerarRelatorioGo(goDir, { goHead = null, goTestes = null } = {}) {
  const contratos = {};
  for (const c of CONTRATOS_GO) {
    const bruto = fs.readFileSync(path.join(goDir, 'testdata', c.arquivo));
    const json = JSON.parse(bruto.toString('utf8'));
    contratos[c.arquivo] = { contract: json.contract, version: json.version, sha256: sha256(bruto) };
  }
  const fonte = arquivosGo(goDir).map((a) => fs.readFileSync(a, 'utf8')).join('\n');
  return {
    format: FORMATO_RELATORIO_GO,
    generated_at: new Date().toISOString(),
    go_head: goHead,
    contracts: contratos,
    default_sender_env_absent: !procurar(goDir, arquivosGo(goDir), ENV_REMETENTE_PADRAO).length && Boolean(fonte),
    go_tests: goTestes,
  };
}

function checarContratosGo(raiz, { goDir, relatorioGo }) {
  const fixture = (c) => fs.readFileSync(path.join(raiz, 'test', 'fixtures', 'whatsapp', c.arquivo));
  const versao = [];
  for (const c of CONTRATOS_GO) {
    let json;
    try { json = JSON.parse(fixture(c).toString('utf8')); } catch (err) { versao.push(`${c.arquivo}: ilegível no painel (${err.message})`); continue; }
    if (json.contract !== c.contrato || json.version !== c.versao) {
      versao.push(`${c.arquivo}: painel declara ${json.contract} v${json.version}, gate espera ${c.contrato} v${c.versao} (${c.fase})`);
    }
  }

  const temGo = goDir && fs.existsSync(path.join(goDir, 'go.mod'));
  if (!temGo && !relatorioGo) {
    const motivo = `repositório do Go não encontrado (${goDir || 'WHATSAPP_GO_DIR ausente'}) e nenhum --go-report`;
    return {
      fixtures: { status: NAO_VERIFICADO, detalhes: [motivo] },
      versao: { status: versao.length ? FAIL : NAO_VERIFICADO, detalhes: versao.length ? versao : [motivo] },
      remetente: { status: NAO_VERIFICADO, detalhes: [motivo] },
    };
  }

  const fixtures = [];
  let remetente;
  if (temGo) {
    for (const c of CONTRATOS_GO) {
      const copia = path.join(goDir, 'testdata', c.arquivo);
      if (!fs.existsSync(copia)) { fixtures.push(`Go: testdata/${c.arquivo} ausente`); continue; }
      const bruto = fs.readFileSync(copia);
      if (!bruto.equals(fixture(c))) fixtures.push(`${c.arquivo}: cópia do Go diverge da do painel`);
      const json = JSON.parse(bruto.toString('utf8'));
      if (json.version !== c.versao || json.contract !== c.contrato) versao.push(`Go ${c.arquivo}: ${json.contract} v${json.version} (esperado v${c.versao})`);
    }
    // O Go implementa o que o contrato nomeia: cabeçalhos do 5b e rotas do 5c.
    const fonte = arquivosGo(goDir).map((a) => fs.readFileSync(a, 'utf8')).join('\n');
    const sender = JSON.parse(fixture(CONTRATOS_GO[0]).toString('utf8'));
    for (const h of Object.values(sender.headers || {})) if (!fonte.includes(`"${h}"`)) versao.push(`Go não referencia o header ${h} do contrato 5b`);
    const contexto = JSON.parse(fixture(CONTRATOS_GO[1]).toString('utf8'));
    for (const e of Object.values(contexto.endpoints || {})) {
      const fim = e.path.split('/').pop();
      if (!fonte.includes(`"${fim}"`)) versao.push(`Go não chama ${e.path} do contrato 5c`);
    }
    const repasse = JSON.parse(fixture(CONTRATOS_GO[2]).toString('utf8'));
    for (const h of [repasse.auth?.timestamp_header, repasse.auth?.signature_header]) {
      if (!h || !fonte.includes(`"${h}"`)) versao.push(`Go não assina o repasse com o header ${h} (rodada 18)`);
    }
    const achados = procurar(goDir, arquivosGo(goDir), ENV_REMETENTE_PADRAO);
    remetente = { status: achados.length ? FAIL : PASS, detalhes: achados.length ? achados.map((a) => `Go ${a}`) : ['Go não lê META_PHONE_NUMBER_ID/META_ACCESS_TOKEN/META_WABA_ID (código não-teste)'] };
  } else if (relatorioGo.invalido) {
    return {
      fixtures: { status: FAIL, detalhes: [relatorioGo.invalido] },
      versao: { status: FAIL, detalhes: [relatorioGo.invalido] },
      remetente: { status: FAIL, detalhes: [relatorioGo.invalido] },
    };
  } else {
    for (const c of CONTRATOS_GO) {
      const doGo = relatorioGo.contracts?.[c.arquivo];
      if (!doGo) { fixtures.push(`relatório do Go sem ${c.arquivo}`); continue; }
      if (doGo.sha256 !== sha256(fixture(c))) fixtures.push(`${c.arquivo}: hash do Go (relatório) diverge do painel`);
      if (doGo.version !== c.versao || doGo.contract !== c.contrato) versao.push(`Go (relatório) ${c.arquivo}: ${doGo.contract} v${doGo.version}`);
    }
    remetente = relatorioGo.default_sender_env_absent === true
      ? { status: PASS, detalhes: [`Go sem remetente de ambiente (relatório, head ${relatorioGo.go_head || '?'})`] }
      : { status: relatorioGo.default_sender_env_absent === false ? FAIL : NAO_VERIFICADO, detalhes: ['relatório do Go não atesta ausência de remetente de ambiente'] };
  }
  const origem = temGo ? `Go em ${goDir}` : `relatório do Go (head ${relatorioGo.go_head || '?'})`;
  return {
    fixtures: { status: fixtures.length ? FAIL : PASS, detalhes: fixtures.length ? fixtures : [`${CONTRATOS_GO.length} contratos byte a byte iguais · ${origem}`] },
    versao: { status: versao.length ? FAIL : PASS, detalhes: versao.length ? versao : [CONTRATOS_GO.map((c) => `${c.fase}: ${c.contrato} v${c.versao}`).join(' · ')] },
    remetente,
  };
}

// Resultado de `go vet` / `go build` / `go test -race -json`, quando o gate os roda (--run-go) ou
// quando o relatório do Go os traz. Sem nenhum dos dois: NOT VERIFIED.
export function avaliarTestesGo(goTestes, { relatorioGo, goHead } = {}) {
  const fonte = goTestes || (relatorioGo && !relatorioGo.invalido ? relatorioGo.go_tests : null);
  if (!fonte) return { status: NAO_VERIFICADO, detalhes: ['go vet/build/test -race não executados (suíte pulada, --no-go-tests ou Go ausente, e nenhum --go-report com go_tests)'] };
  const problemas = [];
  if (fonte.vet !== 0) problemas.push(`go vet saiu com ${fonte.vet}`);
  if (fonte.build !== 0) problemas.push(`go build saiu com ${fonte.build}`);
  if (fonte.test !== 0) problemas.push(`go test -race saiu com ${fonte.test}`);
  if (!fonte.race) problemas.push('go test sem -race');
  if (!(fonte.pass > 0)) problemas.push('go test não executou nenhum teste');
  if (fonte.fail) problemas.push(`${fonte.fail} teste(s) Go falharam`);
  for (const s of fonte.skipped || []) problemas.push(`Go PULADO · ${s}`);
  if (!goTestes && goHead && fonte.head && fonte.head !== goHead) problemas.push(`relatório de testes do Go é de ${fonte.head}, repositório está em ${goHead}`);
  return {
    status: problemas.length ? FAIL : PASS,
    detalhes: problemas.length ? problemas : [`go vet 0 · go build 0 · go test -race: ${fonte.pass} pass, 0 fail, 0 skip${fonte.head ? ` · head ${fonte.head}` : ''}`],
  };
}

// Testes Go que existem só como processo filho de outro teste; o pulo deles é o comportamento
// correto quando rodados diretamente. Qualquer outro pulo reprova.
export const PULOS_GO_ESPERADOS = Object.freeze([/^TestQueueWorkerProcess$/, /^TestInboxProcess$/]);

export function resumirGoTestJson(saida, { permitidos = PULOS_GO_ESPERADOS } = {}) {
  let pass = 0; let fail = 0; const skipped = []; const pulosEsperados = [];
  for (const linha of saida.split('\n')) {
    if (!linha.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(linha); } catch { continue; }
    if (!ev.Test || !['pass', 'fail', 'skip'].includes(ev.Action)) continue;
    if (ev.Action === 'pass') pass += 1;
    else if (ev.Action === 'fail') fail += 1;
    else if (permitidos.some((re) => re.test(ev.Test))) pulosEsperados.push(ev.Test);
    else skipped.push(ev.Test);
  }
  return { pass, fail, skipped, pulosEsperados };
}

// ── OPS e dogfood ──────────────────────────────────────────────────────────────────────────────

// Heurística contra segredo em arquivo de evidência: nomes de campo sensíveis e valores com cara de
// credencial. Evidência que parece conter segredo é INVÁLIDA (FAIL), não ignorada.
const CAMPO_SENSIVEL = /(secret|token|password|senha|api[_-]?key|private|credential)/i;
const VALOR_SENSIVEL = [/EAA[A-Za-z0-9]{10,}/, /\b[A-Fa-f0-9]{40,}\b/, /\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/, /postgres(ql)?:\/\/[^\s@]+:[^\s@]+@/i];

export function segredoAparente(obj, caminho = '') {
  const achados = [];
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const aqui = caminho ? `${caminho}.${k}` : k;
      if (CAMPO_SENSIVEL.test(k) && v !== null && v !== false && v !== '') achados.push(`${aqui}: campo sensível com valor`);
      achados.push(...segredoAparente(v, aqui));
    }
  } else if (typeof obj === 'string' && VALOR_SENSIVEL.some((re) => re.test(obj))) {
    achados.push(`${caminho}: valor com cara de credencial`);
  }
  return achados;
}

function lerEvidencia(dir, nome) {
  const arq = path.join(dir, `${nome}.json`);
  if (!fs.existsSync(arq)) return null;
  try {
    return { arquivo: arq, dados: JSON.parse(fs.readFileSync(arq, 'utf8')) };
  } catch (err) {
    return { arquivo: arq, erro: `ilegível: ${err.message}` };
  }
}

export function validarEvidenciaOps(id, ev) {
  if (ev.erro) return [ev.erro];
  const d = ev.dados;
  const problemas = [];
  if (d.format !== FORMATO_EVIDENCIA_OPS) problemas.push(`format ≠ ${FORMATO_EVIDENCIA_OPS}`);
  if (d.id !== id) problemas.push(`id ${d.id} ≠ ${id}`);
  if (!['VERIFIED', 'NOT_APPLICABLE'].includes(d.status)) problemas.push(`status ${d.status} (aceitos: VERIFIED, NOT_APPLICABLE)`);
  if (d.status === 'NOT_APPLICABLE' && !(typeof d.reason === 'string' && d.reason.trim().length >= 10)) problemas.push('NOT_APPLICABLE sem reason');
  for (const campo of ['verified_at', 'verified_by', 'environment', 'evidence']) {
    if (!(typeof d[campo] === 'string' && d[campo].trim())) problemas.push(`campo ${campo} ausente`);
  }
  if (d.verified_at && Number.isNaN(Date.parse(d.verified_at))) problemas.push('verified_at não é data ISO');
  if (d.environment && d.environment !== 'production') problemas.push(`environment ${d.environment} ≠ production`);
  problemas.push(...segredoAparente(d));
  return problemas;
}

export function avaliarOps(dirEvidencia) {
  return CATALOGO_OPS.map(({ id, titulo }) => {
    const ev = lerEvidencia(dirEvidencia, id);
    if (!ev) return { id, titulo, status: NAO_VERIFICADO, detalhes: ['sem arquivo de evidência'] };
    const problemas = validarEvidenciaOps(id, ev);
    if (problemas.length) return { id, titulo, status: FAIL, detalhes: problemas.map((p) => `${path.basename(ev.arquivo)}: ${p}`) };
    return { id, titulo, status: ev.dados.status === 'NOT_APPLICABLE' ? 'NOT APPLICABLE' : 'VERIFIED', detalhes: [`${ev.dados.verified_at} · ${ev.dados.verified_by}`] };
  });
}

// Instante ISO 8601 com hora e fuso explícitos (Z ou ±hh:mm), com data de calendário válida.
// Devolve epoch ms ou null. Date.parse sozinho aceita 2026-02-30 (vira 02/03) e datas sem fuso.
const INSTANTE_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export function lerInstante(texto) {
  if (typeof texto !== 'string') return null;
  const m = INSTANTE_ISO.exec(texto);
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const calendario = new Date(Date.UTC(ano, mes - 1, dia));
  if (calendario.getUTCFullYear() !== ano || calendario.getUTCMonth() !== mes - 1 || calendario.getUTCDate() !== dia) return null;
  const ms = Date.parse(texto);
  return Number.isNaN(ms) ? null : ms;
}

// DOGFOOD.json (rodada 19):
//   { "format": "oria-ops-evidence/v1", "id": "DOGFOOD", "environment": "production",
//     "dogfood_started_at": "<ISO com fuso>", "dogfood_required_days": 14 (opcional; se vier, = 14),
//     "recorded_by": "<quem registrou>", "open_incidents": <inteiro ≥ 0> }
// Dias = floor((agora − dogfood_started_at) / 24 h). Não há status nem data de fim declarados.
export function avaliarDogfood(dirEvidencia, { agora = new Date() } = {}) {
  const ev = lerEvidencia(dirEvidencia, 'DOGFOOD');
  if (!ev) return { status: 'NOT STARTED', detalhes: [`${DIAS_DE_DOGFOOD} dias com a Organization interna: sem DOGFOOD.json (rollout não concluído)`] };
  if (ev.erro) return { status: FAIL, detalhes: [`DOGFOOD.json: ${ev.erro}`] };
  const agoraMs = agora instanceof Date ? agora.getTime() : NaN;
  if (!Number.isFinite(agoraMs)) throw new Error('avaliarDogfood: relógio inválido');
  const d = ev.dados;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { status: FAIL, detalhes: ['DOGFOOD.json: não é um objeto'] };
  const problemas = [];
  if (d.format !== FORMATO_EVIDENCIA_OPS || d.id !== 'DOGFOOD') problemas.push('format/id inválidos');
  if (d.environment !== 'production') problemas.push(`environment ${d.environment} ≠ production`);
  if (!(typeof d.recorded_by === 'string' && d.recorded_by.trim())) problemas.push('campo recorded_by ausente');
  for (const campo of CAMPOS_MANUAIS_DO_DOGFOOD) {
    if (Object.prototype.hasOwnProperty.call(d, campo)) problemas.push(`campo ${campo} não é aceito: o gate calcula os dias pelo relógio desde dogfood_started_at`);
  }
  if (Object.prototype.hasOwnProperty.call(d, 'dogfood_required_days') && d.dogfood_required_days !== DIAS_DE_DOGFOOD) {
    problemas.push(`dogfood_required_days ${JSON.stringify(d.dogfood_required_days)} ≠ ${DIAS_DE_DOGFOOD} (constante do gate)`);
  }
  if (!(Number.isInteger(d.open_incidents) && d.open_incidents >= 0)) problemas.push('open_incidents ausente ou não é inteiro ≥ 0');
  problemas.push(...segredoAparente(d));

  const inicio = lerInstante(d.dogfood_started_at);
  if (inicio === null) problemas.push('dogfood_started_at ausente ou fora do formato ISO 8601 com hora e fuso');
  else if (inicio > agoraMs) problemas.push(`dogfood_started_at ${d.dogfood_started_at} está no futuro`);

  for (const id of REFERENCIAS_DO_DOGFOOD) {
    const ref = lerEvidencia(dirEvidencia, id);
    if (!ref) { problemas.push(`${id} sem evidência: o dogfood só começa depois da release final do runbook`); continue; }
    const invalida = validarEvidenciaOps(id, ref);
    if (invalida.length) { problemas.push(`${id} inválido como referência: ${invalida.join('; ')}`); continue; }
    if (ref.dados.status !== 'VERIFIED') { problemas.push(`${id} ${ref.dados.status}: a referência do dogfood exige VERIFIED`); continue; }
    const quando = lerInstante(ref.dados.verified_at);
    if (quando === null) problemas.push(`${id}.verified_at fora do formato ISO 8601 com hora e fuso`);
    else if (inicio !== null && inicio < quando) problemas.push(`dogfood_started_at ${d.dogfood_started_at} é anterior a ${id} (${ref.dados.verified_at})`);
  }
  if (problemas.length) return { status: FAIL, detalhes: problemas };

  const dias = Math.floor((agoraMs - inicio) / 86400000);
  const desde = `desde ${d.dogfood_started_at} (referência ${REFERENCIAS_DO_DOGFOOD.join(', ')})`;
  if (dias < DIAS_DE_DOGFOOD) return { status: 'IN PROGRESS', detalhes: [`dia ${dias} de ${DIAS_DE_DOGFOOD} ${desde}`] };
  if (d.open_incidents !== 0) return { status: FAIL, detalhes: [`${dias} dias ${desde}, mas open_incidents = ${d.open_incidents}: o fechamento exige 0`] };
  return { status: 'COMPLETED', detalhes: [`${dias} dias ${desde} · open_incidents 0`] };
}

// ── Consolidação ───────────────────────────────────────────────────────────────────────────────

// Rodada 19 (§12): exit 0 SÓ com OVERALL READY. Qualquer bloqueio (CODE, OPS obrigatório pendente,
// dogfood não cumprido) sai ≠ 0 — 1 quando o código bloqueia, 2 quando só o rollout bloqueia. Não
// existe modo do gate que saia 0 com OVERALL BLOCKED: o antigo `--code-only` foi removido. O único
// modo que sai 0 bloqueado é `--report-only`, que não é gate (o relatório diz isso e traz `gateExit`).
export const EXIT = Object.freeze({ PRONTO: 0, CODIGO_BLOQUEADO: 1, ROLLOUT_BLOQUEADO: 2, USO: 64 });

export function codigoDeSaidaDoGate({ codeStatus, overall }) {
  if (codeStatus !== PASS) return EXIT.CODIGO_BLOQUEADO;
  return overall === 'READY' ? EXIT.PRONTO : EXIT.ROLLOUT_BLOQUEADO;
}

export function consolidar({
  raiz, suite, eventosEstaticos, goDir, relatorioGo, goTestes, goHead, dirEvidencia, soRelatorio = false, agora = new Date(),
}) {
  const s = avaliarSuite(suite, { raiz }).partes;
  const go = checarContratosGo(raiz, { goDir, relatorioGo });
  const flags = checarFlagsLegadas(raiz);
  const e = (chave) => pelosTestesEstaticos(eventosEstaticos, chave);
  const juntar = (...partes) => ({ status: combinar(...partes.map((p) => p.status)), detalhes: partes.flatMap((p) => p.detalhes) });

  const code = [
    ['suite', 'npm test completo (piso, falhas, exit code)', s.suite],
    ['invariants', 'all invariants PASS', s.invariants],
    ['no-skipped', 'no skipped critical tests', s.pulados],
    ['no-tenant-selector', 'no tenant selector', e('seletor')],
    ['no-cross-org-aggregation', 'no cross-org aggregation', juntar(e('agregacao'), s.crossOrg)],
    ['rls-schema', 'RLS schema valid', s.rls],
    ['app-role-contract', 'app role contract', juntar(checarRoleDaAplicacao(raiz), s.appRole)],
    ['integration-env-fallback', 'integration env fallback state', juntar(flags.integracoes, s.fallback)],
    ['legacy-admin-auth', 'legacy admin auth state', checarAuthLegado(raiz)],
    ['go-contract-fixtures', 'Go contract fixtures aligned', juntar(go.fixtures, s.goE2e)],
    ['go-contract-version', 'Go 5b/5c contract version', go.versao],
    ['go-tests', 'Go vet/build/test -race', avaliarTestesGo(goTestes, { relatorioGo, goHead })],
    ['no-global-tenant-credential', 'no global tenant credential request-path usage', e('credencial')],
    ['no-unsafe-truncate', 'no unsafe TRUNCATE tenant tables', juntar(e('truncate'), checarTruncate(raiz))],
    ['no-legacy-ink-route', 'no legacy Ink runtime route', juntar(e('ink'), checarRotaInk(raiz))],
    ['no-default-sender-env', 'no default sender env', juntar(checarRemetentePadraoNoPainel(raiz), go.remetente)],
  ].map(([id, titulo, r]) => ({ id, titulo, ...r }));

  const ops = avaliarOps(dirEvidencia);
  const dogfood = avaliarDogfood(dirEvidencia, { agora });

  const codeStatus = combinar(...code.map((c) => c.status));
  const opsPendentes = ops.filter((o) => !['VERIFIED', 'NOT APPLICABLE'].includes(o.status));
  const bloqueios = [];
  if (codeStatus !== PASS) bloqueios.push(`CODE ${codeStatus}`);
  for (const o of opsPendentes) bloqueios.push(`${o.id} ${o.status}`);
  if (dogfood.status !== 'COMPLETED') bloqueios.push(`DOGFOOD ${dogfood.status}`);
  const overall = bloqueios.length ? 'BLOCKED' : 'READY';

  const gateExit = codigoDeSaidaDoGate({ codeStatus, overall });
  const exit = soRelatorio ? EXIT.PRONTO : gateExit;

  return {
    mode: soRelatorio ? 'report-only' : 'gate', gate: !soRelatorio,
    code, codeStatus, ops, dogfood, overall, bloqueios, gateExit, exit,
  };
}

export function formatarRelatorio(r, { detalhado = false } = {}) {
  const linhas = [];
  const pad = (s, n) => String(s).padEnd(n);
  const aviso = 'REPORT ONLY — ISTO NÃO É UM GATE: exit 0 aqui NÃO significa pronto (use o comando sem --report-only)';
  linhas.push('SECOND TENANT GATE');
  if (r.mode === 'report-only') linhas.push(aviso);
  linhas.push('');
  linhas.push(`CODE GATES: ${r.codeStatus}`);
  for (const c of r.code) {
    linhas.push(`  ${pad(c.status, 13)} ${c.titulo}`);
    if (detalhado || c.status !== PASS) for (const d of c.detalhes) linhas.push(`                ${d}`);
  }
  linhas.push('');
  const pend = r.ops.filter((o) => !['VERIFIED', 'NOT APPLICABLE'].includes(o.status)).length;
  linhas.push(`OPS GATES: ${pend ? `${pend} de ${r.ops.length} pendentes` : 'todos VERIFIED'}`);
  for (const o of r.ops) {
    linhas.push(`  ${pad(o.id, 7)} ${pad(o.status, 14)} ${o.titulo}`);
    if (o.status === FAIL) for (const d of o.detalhes) linhas.push(`                ${d}`);
  }
  linhas.push('');
  linhas.push(`DOGFOOD GATE: ${DIAS_DE_DOGFOOD} days ${r.dogfood.status}`);
  if (detalhado || r.dogfood.status !== 'NOT STARTED') for (const d of r.dogfood.detalhes) linhas.push(`                ${d}`);
  linhas.push('');
  linhas.push(`CODE: ${r.codeStatus}`);
  linhas.push(`OVERALL: ${r.overall}${r.bloqueios.length ? ` (${r.bloqueios.length} bloqueio(s))` : ''}`);
  if (r.mode === 'report-only') {
    linhas.push(`exit ${r.exit} (--report-only: informativo; o gate sairia com ${r.gateExit})`);
    linhas.push(aviso);
  } else {
    linhas.push(`exit ${r.exit}`);
  }
  return linhas.join('\n');
}
