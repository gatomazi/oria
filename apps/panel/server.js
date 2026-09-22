const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { Pool } = require('pg');
// INV-13 (Fase 4): todo console.* do processo passa pela redação de segredos de integração.
const secretGuard = require('./lib/platform/secret-guard');
secretGuard.instalarNoConsole();
// Núcleo da integração Meta Ads. Fica fora deste arquivo por um motivo específico: a regra de
// contagem de conversões (uma compra aparece em 3 action_type diferentes e NÃO pode ser somada) e
// o retry/paginação do cliente precisam de teste unitário, e nada aqui dentro é testável — este
// arquivo abre pool do Postgres, registra rotas e liga setInterval só de ser requerido.
// Testes em test/meta.test.js (`npm test`).
const metaActions  = require('./lib/meta/actions');
const metaInsights = require('./lib/meta/insights');
const metaCriativos = require('./lib/meta/criativos');
const financeiroConsolidado = require('./lib/financeiro/consolidado');
const clientesLista = require('./lib/clientes/lista');
const clientesCadastro = require('./lib/clientes/cadastro');
const financeiroDespesas = require('./lib/financeiro/despesas');
const { resolverMidiaDaOrganizacao } = require('./lib/financeiro/midia');
const custosPrecos = require('./lib/custos/precos');
const { MetaClient, MetaApiError, ERROS: META_ERROS, VERSAO_PADRAO: META_VERSAO_PADRAO, mascararToken } = require('./lib/meta/client');
const { financeiroPedidoInk, financeiroItensPedidoInk } = require('./lib/ink/financeiro');
const { comRetryDeLeitura } = require('./lib/ink/retry');
const { variantesTelefone, acharCompraDoCarrinho } = require('./lib/recuperacao/compra');
const atribuicaoCampanha = require('./lib/campanhas/atribuicao');
const app     = express();

// Handlers `async` do Express 4 não têm a promise observada: um `throw` dentro deles virava
// `unhandledRejection` e a requisição ficava sem resposta (a tela em "Carregando" para sempre).
// Instalado ANTES de qualquer rota, para todas passarem por `next(err)` → `erroCentral`, registrado
// no fim do arquivo. Ver lib/platform/http-safety.js.
const httpSafety = require('./lib/platform/http-safety');
httpSafety.instalarSegurancaAsync();

// Rede de segurança: uma promise rejeitada sem `.catch`/`await` em qualquer lugar do processo
// (ex: numa integração externa) derruba o Node inteiro por padrão a partir da v15 — o que tiraria
// do ar até a busca de cidades, sem nada nos logs além do processo simplesmente sumindo. Loga em
// vez de matar o processo; a causa raiz continua sendo corrigida onde aparecer.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
});
// Enquanto o módulo está sendo avaliado, a rede de segurança NÃO pode engolir o erro: um throw no
// topo interrompe a avaliação e `app.listen` nunca é alcançado. Engolido, o processo ou sai com
// exit 0 ou fica vivo sem escutar, preso nos timers já agendados — medido nos dois casos (B-2 da
// Fase 0; o segundo com ENCRYPTION_MASTER_KEY malformada). O deploy precisa ver exit ≠ 0.
// A flag só vira `true` na última linha síncrona do arquivo.
let avaliacaoDoModuloConcluida = false;
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err);
  if (!avaliacaoDoModuloConcluida) process.exit(1);
});

// STORAGE_DIR deve apontar para um volume persistente em produção (o filesystem do
// container é efêmero e é apagado a cada deploy). Em dev, cai no próprio diretório do projeto.
// IMG_CACHE_DIR pode ser setado à parte por compatibilidade, mas por padrão já cai dentro do volume.
const STORAGE_DIR   = process.env.STORAGE_DIR || __dirname;
const IMG_CACHE_DIR = process.env.IMG_CACHE_DIR || path.join(STORAGE_DIR, 'img-cache');
const CDN_BASE      = 'https://gcp-images.majestic.ink.rsvcloud.com/images/product_v2/main_image/';
const VALID_IMG     = /^[a-f0-9]{32}\.webp$/;

fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });

// Mídia enviada por admin (amostra de template, biblioteca de campanha) — usa direto
// RAILWAY_VOLUME_MOUNT_PATH, não STORAGE_DIR: achado ao planejar isso (2026-09-08), STORAGE_DIR
// não está de fato setado em produção hoje (cai no default `__dirname`, efêmero), mesmo havendo
// um volume Railway montado — diferente do que o comentário de STORAGE_DIR aqui acima assume.
// Arquivo de mídia enviado por admin não pode se dar ao luxo dessa ambiguidade (não tem Postgres
// como rede de segurança, é o arquivo em si).
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || STORAGE_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Pedidos PIX (hotpage por cliente) ──────────────────────────────────
// QR Code nunca é salvo em arquivo — sempre gerado na hora a partir do `pixCode` guardado (ver
// `/assets/pedidos/:filename`), pra não depender de disco (efêmero em produção) pra nada além do
// próprio código Pix, que já vive no Postgres junto do resto do pedido.
const PEDIDOS_DIR  = path.join(STORAGE_DIR, 'db');
const PEDIDOS_FILE = path.join(PEDIDOS_DIR, 'pedidos.json');
const LOJAS        = { sul: 'Use Sul', centro: 'Use Centro', norte: 'Use Norte' };
const PEDIDO_ID_RE = /^[A-Za-z0-9_-]{10,14}$/;
const SITE_BASE_URL = (process.env.SITE_BASE_URL || 'https://orgulhoregional.com.br').replace(/\/+$/, '');

fs.mkdirSync(PEDIDOS_DIR, { recursive: true });
if (!fs.existsSync(PEDIDOS_FILE)) fs.writeFileSync(PEDIDOS_FILE, '{}');

// ── Integração Reserva Ink (API + Webhooks) ────────────────────────────
// Cada loja tem sua própria conta/token na Reserva Ink (a API é escopada
// "à loja autenticada" via bearer token — não existe store_id nos endpoints).
const INK_API_BASE = 'https://api.reserva.ink';
// Fase 4: o TOKEN da API é da Organization (integration_secrets). Fase 5c (TD-005): o segredo do
// webhook também — a entrada chega numa URL opaca por integração (/api/webhooks/ink/:token).
const PENDING_PAYMENT_STATUSES = new Set(['pending', 'waiting_payment', 'awaiting_analysis']);

// Achado ao auditar dado real pro Dashboard (2026-09-08) e confirmado com payload de webhook real
// (evento shipping.sent do pedido INK1982524: order.payment_status="Pago" enquanto
// resource.state.payment_status="paid" no MESMO payload): pro payment_status, a Ink devolve pra
// esta conta um RÓTULO EM PORTUGUÊS no objeto do pedido ("Pago", "Pendente", "Expirado"...), não
// o enum em inglês que a documentação lista — order_status vem certinho em inglês, só
// payment_status que vem assim. Sem normalizar isso, QUALQUER comparação contra o enum
// documentado (bucketPaymentStatus, PAYMENT_STATUSES_CONVERTIDO, o filtro de audiência de
// campanha) nunca reconhece um pedido pago de verdade.
// Mapeamento validado contra 500 eventos reais de docs/webhook-log.json (cruzando
// order.payment_status com o resource.state.payment_status do mesmo payload, que já vem em
// inglês) — cada chave tem confirmação direta, não é chute: pago=235, pendente=63, expirado=9,
// não autorizado=7, aguardando análise=3, cancelado=1 ocorrência. "Reembolsado" apareceu 1x no
// log mas com o campo em inglês mostrando "paid" (contexto ambíguo, provavelmente o snapshot do
// pedido não refletia o evento específico) — fica de fora até ter uma amostra confiável.
const PAGAMENTO_LABEL_PT_PARA_ENUM = {
  'pago': 'paid',
  'pendente': 'waiting_payment',
  'expirado': 'expired',
  'não autorizado': 'not_authorized',
  'aguardando análise': 'awaiting_analysis',
  'cancelado': 'canceled',
};
// Normaliza payment_status vindo de um objeto de pedido da Ink (REST ou dentro do webhook —
// ambos vêm em português nesta conta) pro enum canônico em inglês. Idempotente: já vindo em
// inglês, ou um rótulo desconhecido, devolve como veio (não inventa mapeamento pra algo nunca
// observado).
function normalizarPaymentStatusInk(statusBruto) {
  const normalizado = String(statusBruto || '').trim().toLowerCase();
  return PAGAMENTO_LABEL_PT_PARA_ENUM[normalizado] || statusBruto;
}

// ── Postgres (OBRIGATÓRIO em produção) ──────────────────────────────────
// TD-003 / B-09 · Fase 0 da productização.
//
// O que existia aqui até 8a7ea3d, e por que saiu:
//
//   const DATABASE_URL = process.env.DATABASE_URL || null;
//   const pgPool = DATABASE_URL ? new Pool({...}) : null;
//
// Essa linha INFERIA o modo de operação da ausência de uma variável: faltou DATABASE_URL, logo
// deve ser dev, logo estado de negócio vai para arquivo JSON. Se a variável faltasse em produção —
// renomeada, secret não montado, serviço recriado — a conclusão era a mesma e o painel subia
// servindo dados de um filesystem efêmero, em silêncio. É o padrão "infere o único candidato" que
// a regra fail-closed do plano proíbe por escrito.
//
// Agora o modo é SEMPRE declarado (`DATA_STORE_MODE`), e `postgres` sem `DATABASE_URL` é erro em
// qualquer ambiente, inclusive dev. Ver lib/platform/db-config.js.
const {
  MODO_POSTGRES,
  resolveDatabaseMode,
  opcoesDePool,
  verificarBootstrapCritico,
  exigirRoleDaAplicacao,
  verificarRoleDaAplicacao,
} = require('./lib/platform/db-config');
const tenancyManifesto = require('./lib/platform/tenancy-manifest');

// ⚠️ O try/catch com `process.exit(1)` NÃO é decorativo, e a razão merece registro.
//
// Este arquivo instala `process.on('uncaughtException')` lá em cima (rede de segurança para não
// derrubar o site inteiro por uma promise rejeitada numa integração). Esse handler também captura
// um throw durante a avaliação do próprio módulo — então, sem este try/catch, a falha de
// configuração aqui vira UMA LINHA DE LOG, `app.listen` nunca é alcançado, o event loop esvazia e o
// processo termina com **exit code 0**. Medido: era exatamente esse o comportamento.
//
// Exit 0 é "encerrou normalmente". O Railway não abortaria o deploy, e o sintoma seria um serviço
// que sobe, não escuta nada e não reclama. O fail-fast de TD-003 precisa ser um código de saída
// diferente de zero, não uma mensagem de erro.
let MODO_DADOS;
try {
  MODO_DADOS = resolveDatabaseMode(process.env);
} catch (err) {
  console.error(`[POSTGRES] configuração de persistência inválida: ${err.message}`);
  process.exit(1);
}

const DATABASE_URL = MODO_DADOS.databaseUrl;
// `pgPoolReal` é a conexão crua: só autenticação, resolvedores estreitos e verificação de boot.
// Todo o resto usa `pgPool`, a fachada do tenant-runtime (Fase 3): cada query roda em
// comOrganization com a Organization do contexto, e query em tabela tenant-owned sem contexto é
// erro. Ver lib/platform/tenant-runtime.js.
const { criarPoolTenant, comContexto, semContexto, contextoAtual, TenantRuntimeError } = require('./lib/platform/tenant-runtime');
const pgPoolReal = MODO_DADOS.modo === MODO_POSTGRES ? new Pool(opcoesDePool(DATABASE_URL)) : null;
const pgPool = pgPoolReal ? criarPoolTenant(pgPoolReal) : null;
// Jobs rodam uma iteração por Organization ativa, cada uma no próprio contexto (INV-17).
// Fase 5c · INV-18: toda iteração de job pede lease persistente (job, Organization) antes de rodar.
const JOBS = require('./lib/platform/jobs').createJobRunner({
  poolReal: pgPoolReal,
  leases: pgPoolReal ? require('./lib/platform/leases').createJobLeases({ poolReal: pgPoolReal }) : null,
});

if (!pgPool) {
  console.warn(
    '[POSTGRES] DATA_STORE_MODE=ephemeral-json — estado de negócio em arquivo JSON. ' +
    'Modo de DESENVOLVIMENTO, declarado explicitamente. Não sobrevive a um deploy.'
  );
}

// ── Schema: responsabilidade das migrations, não do boot ─────────────────
// Até 8a7ea3d, subir o processo rodava ~1.000 linhas de DDL mais três backfills (`bootstrapPostgres`,
// `backfillPedidosSeNecessario`, `backfillPaymentStatusPortugues`, `backfillPublicTokenMedia`), toda
// a cadeia sob um `.catch` que só logava. Não eram código de inicialização: eram migrations
// disfarçadas — não versionadas, não transacionais, com falha silenciosa, e rodando em TODA réplica
// ao mesmo tempo a cada deploy.
//
// Tudo isso virou `migrations/` (node-pg-migrate). Em produção o gancho é o Pre-deploy Command do
// Railway (`npm run migrate:up`, OPS-11): se a migration falhar, o deploy aborta.
//
// O que sobra aqui é VERIFICAÇÃO, não criação: o banco responde, e as migrations realmente rodaram.
// Um deploy que pulou o pre-deploy sobe contra um schema velho, e o modo de falha disso sem esta
// checagem seria erro 500 esparso em runtime — não um boot que falha.
const MIGRATION_MINIMA = '1790000300000_onboarding';

async function verificarPostgresOuMorrer() {
  if (!pgPool) return;
  try {
    await verificarBootstrapCritico(pgPoolReal, { migrationEsperada: MIGRATION_MINIMA });
    // TD-001: ligado em OPS-14 (DB_ENFORCE_APP_ROLE=1 junto com a DATABASE_URL da role oria_app).
    // Desde a Fase 3 todo acesso tenant-owned passa por comOrganization, então o processo roda
    // inteiro sob essa role (test/invariants/fase3-server-ab.test.js).
    if (exigirRoleDaAplicacao()) {
      const { role } = await verificarRoleDaAplicacao(pgPoolReal, { tabelasSobRls: tenancyManifesto.nomesSobRls() });
      console.log(`[POSTGRES] role da aplicação ${role} verificada: sem SUPERUSER, sem BYPASSRLS, não dona`);
    }
    console.log('[POSTGRES] conexão e migrations verificadas');
  } catch (err) {
    console.error(`[POSTGRES] verificação crítica de boot falhou: ${err.message}`);
    // Fail-fast (TD-003). Nunca `.catch(console.error)` e seguir servindo: um painel que responde
    // 200 com o banco no chão é pior que um painel que não sobe — o deploy anterior continua no ar.
    process.exit(1);
  }
}

// Chamada no fim do arquivo, encadeada com `app.listen` — o processo não escuta antes de a
// verificação passar. Ver o bloco final de server.js.

// Configs do painel (campos personalizados, templates, vínculo evento→template): blob JSON
// único por chave. Sem Postgres configurado (dev local), cai só pro arquivo — com Postgres,
// o arquivo local vira só um espelho best-effort; a leitura e a escrita de verdade são no banco,
// porque o filesystem do container é apagado a cada deploy (não dá pra confiar nele em produção).
async function lerConfigPostgres(chave, arquivoFallback, valorVazio) {
  if (pgPool) {
    const { rows } = await pgPool.query('SELECT valor FROM app_config WHERE chave = $1', [chave]);
    if (rows.length) return rows[0].valor;
    return valorVazio;
  }
  try { return JSON.parse(fs.readFileSync(arquivoFallback, 'utf8')); } catch { return valorVazio; }
}
async function salvarConfigPostgres(chave, arquivoFallback, valor) {
  // Com Postgres, nada vai para o arquivo: ele é da instalação inteira e misturaria Organizations
  // (Fase 3 · INV-01). O arquivo é só o modo efêmero de dev, sem banco.
  if (!pgPool) {
    try { fs.writeFileSync(arquivoFallback, JSON.stringify(valor, null, 2)); } catch { /* melhor esforço */ }
    return;
  }
  await pgPool.query(
    `INSERT INTO app_config (chave, valor, atualizado_em) VALUES ($1, $2, now())
     ON CONFLICT (organization_id, chave) DO UPDATE SET valor = $2, atualizado_em = now()`,
    [chave, JSON.stringify(valor)]
  );
}

const WEBHOOK_LOG_FILE = path.join(PEDIDOS_DIR, 'ink_webhook_log.json');
const WEBHOOK_LOG_MAX  = 200;
if (!fs.existsSync(WEBHOOK_LOG_FILE)) fs.writeFileSync(WEBHOOK_LOG_FILE, '[]');

// Log de auditoria/descoberta dos webhooks recebidos — a Reserva Ink não documenta o formato
// do payload nem o header de assinatura, então guardamos cada entrega (corpo + headers recebidos)
// para confirmar o esquema real assim que o primeiro evento chegar.
// Com Postgres, grava só em webhook_eventos e só dentro do contexto da Organization dona (a
// entrega verificada). O arquivo local é da instalação inteira: fica restrito ao modo sem banco.
async function logInkWebhook(entry) {
  if (!pgPool) {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(WEBHOOK_LOG_FILE, 'utf8')); } catch { log = []; }
    log.unshift(entry);
    if (log.length > WEBHOOK_LOG_MAX) log = log.slice(0, WEBHOOK_LOG_MAX);
    fs.writeFileSync(WEBHOOK_LOG_FILE, JSON.stringify(log, null, 2));
    return;
  }
  // `store_id` é a identidade da Store na linha nova; `loja` só vai junto quando a Store tem chave
  // legada, e serve para o histórico continuar legível.
  await pgPool.query(
    `INSERT INTO webhook_eventos (recebido_em, verificado, store_id, loja, metodo_auth, event_name, ink_order_id, headers, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entry.recebidoEm, entry.verificado, entry.storeId || null, entry.loja || null, entry.metodoAuth, entry.eventName, entry.inkOrderId, JSON.stringify(entry.headers), JSON.stringify(entry.body)]
  ).catch((err) => console.error(`[POSTGRES] falha ao gravar evento: ${err.message}`));
}

// ── Auditoria (Fase 5, ver docs/plan.md) ────────────────────────────────
const AUDIT_LOG_FILE = path.join(PEDIDOS_DIR, 'audit_log.json');
const AUDIT_LOG_MAX = 500;
if (!fs.existsSync(AUDIT_LOG_FILE)) fs.writeFileSync(AUDIT_LOG_FILE, '[]');

async function registrarAuditLog(entry) {
  // Sujeito real obrigatório (Fase 2 · INV-21): nada de 'admin'. Falha ANTES de gravar.
  validarAtor(entry.actorUserId);
  const registro = { criadoEm: new Date().toISOString(), ...entry };
  if (pgPool) {
    // Sempre na Organization do contexto (a RLS confere de novo). Sem espelho JSON global (INV-21).
    await registrarAuditoria(pgPoolReal, { ...registro, organizationId: orgDoContexto() })
      .catch((err) => console.error(`[POSTGRES] falha ao gravar audit_log: ${err.message}`));
    return registro;
  }
  let log = [];
  try { log = JSON.parse(fs.readFileSync(AUDIT_LOG_FILE, 'utf8')); } catch { log = []; }
  log.unshift(registro);
  if (log.length > AUDIT_LOG_MAX) log = log.slice(0, AUDIT_LOG_MAX);
  fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify(log, null, 2));
  return registro;
}

async function listarAuditLog(action, limit) {
  if (pgPool) {
    const { rows } = await pgPool.query(
      `SELECT criado_em, actor_user_id, action, entity_type, entity_id, loja, before, after
       FROM audit_log WHERE organization_id = $3 AND action = $1 ORDER BY criado_em DESC LIMIT $2`,
      [action, limit, orgDoContexto()]
    );
    return rows.map((r) => ({
      criadoEm: r.criado_em, actorUserId: r.actor_user_id, action: r.action,
      entityType: r.entity_type, entityId: r.entity_id, loja: r.loja, before: r.before, after: r.after,
    }));
  }
  let log = [];
  try { log = JSON.parse(fs.readFileSync(AUDIT_LOG_FILE, 'utf8')); } catch { log = []; }
  return log.filter((e) => e.action === action).slice(0, limit);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}


// Confirmado com entrega real: a INK manda o nome do evento no header `X-Webhook-Event` e
// também no corpo (`event`); o id do pedido vem em `order_id`/`record_id`/`order.id` no corpo.
function extractInkEvent(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { eventName: null, inkOrderId: null };
  const order = (body.order && typeof body.order === 'object') ? body.order
    : (body.data && typeof body.data === 'object') ? body.data
    : body;
  const rawId = body.order_id ?? body.record_id ?? order.order_id ?? order.id ?? body.id;
  const inkOrderId = rawId != null && Number.isFinite(Number(rawId)) ? Number(rawId) : null;
  const eventName = req.get('x-webhook-event') || body.event || body.event_type || body.type || body.evento || null;
  return { eventName, inkOrderId };
}

// ── Identidade da Store ──────────────────────────────────────────────────────────────────────
//
// A Store canônica é `store_id` (UUID). `loja_legada` é a chave do sistema de loja única
// (`sul`/`centro`/`norte`) e existe só como compatibilidade de migração: cliente novo nasce com ela
// NULA, e nada no caminho novo pode exigi-la.

// Store do contexto — a identidade canônica. É esta que o runtime novo usa.
function storeDoContexto() {
  const ctx = contextoAtual();
  if (!ctx) throw new TenantRuntimeError('operação de store fora de um contexto de Organization', 'TENANT_CONTEXT_REQUIRED');
  if (!ctx.storeId) throw new TenantRuntimeError('contexto de Organization sem store resolvida', 'STORE_NOT_RESOLVED');
  return ctx.storeId;
}

// Chave LEGADA da Store. O nome diz o que é de propósito: quem chamar isto está no caminho de
// compatibilidade, não no caminho canônico. Lança para Store nativa do Oria (loja_legada NULL) —
// e é por isso que o fluxo novo não pode depender dela.
function lojaLegadaDoContexto() {
  const ctx = contextoAtual();
  if (!ctx) throw new TenantRuntimeError('operação de loja fora de um contexto de Organization', 'TENANT_CONTEXT_REQUIRED');
  if (!ctx.loja) throw new TenantRuntimeError('a store desta organization não tem loja legada', 'STORE_WITHOUT_LEGACY_KEY');
  return ctx.loja;
}

// A chave legada, ou null. Para quem só precisa SABER se ela existe (exibição, compatibilidade),
// sem transformar a ausência em erro — Store nativa do Oria simplesmente não tem uma.
function lojaLegadaDoContextoOuNula() {
  const ctx = contextoAtual();
  if (!ctx) throw new TenantRuntimeError('operação fora de um contexto de Organization', 'TENANT_CONTEXT_REQUIRED');
  return ctx.loja || null;
}

// Chave de ESCOPO da Store para estado guardado em mapas por chave (vínculos de automação, histórico
// de envios de carrinho/Pix). Store com chave legada mantém a dela — o dado existente continua
// achável; Store nativa usa o próprio `store_id`, que é opaco e nunca colide com `sul`/`centro`/`norte`.
// NÃO é a chave legada: nunca vai para uma coluna `loja` nem para a checagem de credencial.
function chaveDaStore() {
  return lojaLegadaDoContextoOuNula() || storeDoContexto();
}

// Escopo de Store para leitura, com os dois caminhos SEPARADOS e explícitos.
//
//   canônico     store_id = <Store do contexto>
//   compat.      OU (store_id IS NULL AND loja = <chave legada do contexto>)
//
// O segundo ramo só existe quando a Store do contexto TEM chave legada — ou seja, quando ela veio
// de uma migração e pode ter linhas antigas ainda sem `store_id`. Store nativa do Oria
// (`loja_legada` NULA) **nunca** entra nesse ramo: sem chave, não há o que casar, e a leitura fica
// restrita à identidade canônica. É isso que impede um cliente novo de enxergar linha histórica.
//
// `organization_id` entra sempre, à parte, e a RLS confere de novo por baixo.
function escopoDaStore(proximoParametro) {
  const loja = lojaLegadaDoContextoOuNula();
  const storeId = storeDoContexto();
  if (!loja) {
    return { sql: `store_id = $${proximoParametro}`, params: [storeId], usados: 1 };
  }
  return {
    sql: `(store_id = $${proximoParametro} OR (store_id IS NULL AND loja = $${proximoParametro + 1}))`,
    params: [storeId, loja],
    usados: 2,
  };
}

// Organization do contexto, para predicados SQL explícitos (a RLS filtra de novo por baixo).
function orgDoContexto() {
  const ctx = contextoAtual();
  if (!ctx) throw new TenantRuntimeError('operação fora de um contexto de Organization', 'TENANT_CONTEXT_REQUIRED');
  return ctx.organizationId;
}

// A conta de anúncio (linha de `meta_ad_accounts` / `google_ads_customers`) é desta Store?
//
//   canônico        `store_id` da conta = Store do contexto
//   compatibilidade conta SEM `store_id`, atribuída pelo texto `loja_atribuida` — só quando a Store do
//                   contexto TEM chave legada e é a mesma. Store nativa nunca cai neste ramo.
//
// É a mesma regra de `motivoDeExclusao` em lib/financeiro/midia.js (a fonte do gasto), aplicada à
// linha que a tela mostra — as duas não podem discordar sobre "esta conta é da minha loja".
function contaAtribuidaAEstaStore(conta) {
  if (conta.store_id) return conta.store_id === storeDoContexto();
  const loja = lojaLegadaDoContextoOuNula();
  return !!(conta.loja_atribuida && loja && conta.loja_atribuida === loja);
}

// Stores que o contexto pode operar na Ink: a Store da Organization, se houver credencial.
// Devolve a identidade CANÔNICA (`storeId`) e, junto, a chave legada quando existir — a chave serve
// para rótulo e para os fluxos ainda não convertidos, nunca como condição de existência.
//
// Antes isto exigia `ctx.loja`, então uma Store nativa do Oria devolvia lista vazia e todo o
// caminho de pedidos simplesmente não rodava para ela — sem erro, sem aviso.
async function storesInkDoContexto() {
  const ctx = contextoAtual();
  if (!ctx) throw new TenantRuntimeError('operação de store fora de um contexto de Organization', 'TENANT_CONTEXT_REQUIRED');
  if (!ctx.storeId || !(await inkConectada())) return [];
  return [{ storeId: ctx.storeId, loja: ctx.loja || null }];
}

// Caminho de COMPATIBILIDADE: só as Stores que têm chave legada. Existe para os fluxos que ainda
// gravam em tabela cuja coluna `loja` é obrigatória (catálogo, feed, estoque) — eles não foram
// convertidos nesta rodada, e rodá-los sem chave quebraria o INSERT. Store nativa não entra aqui,
// que é exatamente o comportamento correto enquanto essas tabelas não tiverem `store_id`.
async function lojasLegadasInkDoContexto() {
  return (await storesInkDoContexto()).filter((s) => s.loja).map((s) => s.loja);
}

// ── Chamada à Ink com a credencial da Organization do contexto (Fase 4 · INV-12) ─────────────
// O token vem de integration_secrets da Organization da sessão/job. `loja` só confere que quem
// chama está falando da Store do contexto — nunca escolhe credencial.
// Entrada CANÔNICA: usa a credencial Ink da Organization do contexto. Não recebe identificador
// nenhum de fora — o alvo é sempre a Organization da sessão, e a identidade da loja na Ink é
// determinada pelo próprio token (a API é `/v1/stores/...`, sem id de loja no caminho).
async function comTokenInkDaStore(usar) {
  storeDoContexto(); // exige contexto com Store resolvida; a Organization vem junto
  try {
    return await exigirIntegracoes().usarSegredo('ink', 'api_token', usar);
  } catch (err) {
    if (err instanceof IntegracaoError || err.name === 'SegredoIndisponivelError') {
      const e = new Error('esta organization não tem a integração com a Reserva Ink configurada');
      e.status = 503;
      throw e;
    }
    throw err;
  }
}

// Entrada LEGADA: os chamadores que ainda carregam a chave `sul`/`centro`/`norte` (linhas antigas
// de pedido, jobs de migração). Continua conferindo que a chave é a do contexto — nenhum request
// escolhe loja — e delega para o caminho canônico.
async function comTokenInk(loja, usar) {
  const ctx = contextoAtual();
  if (!ctx || ctx.loja !== loja) {
    const err = new Error(`credencial Ink de "${loja}" fora do contexto da organization`);
    err.status = 403;
    throw err;
  }
  return comTokenInkDaStore(usar);
}

// A Organization do contexto tem token Ink? (sem ler o token)
//
// O guard exigia `ctx.loja`, e por isso respondia "não conectada" para toda Store nativa do Oria,
// mesmo com a credencial gravada: a tela mostrava o token salvo e o status dizia o contrário. Quem
// responde é a integração da Organization; a chave legada não entra nisso.
async function inkConectada() {
  const ctx = contextoAtual();
  if (!ctx || !INTEGRACOES) return false;
  return INTEGRACOES.temSegredo('ink', 'api_token');
}

// Núcleo da chamada à Ink: recebe COMO obter o token (`obterToken`), para a mesma lógica servir o
// caminho canônico (credencial da Organization/Store do contexto) e o de compatibilidade (que ainda
// confere a chave legada). Nenhum dos dois deixa o request escolher a credencial.
async function inkRequisitar(obterToken, metodo, pathAndQuery, opcoes = {}) {
  // Leitura interativa repete de forma curta em 429/5xx transitório (ver lib/ink/retry.js).
  return comRetryDeLeitura(metodo, () => inkRequisitarUma(obterToken, metodo, pathAndQuery, opcoes));
}

async function inkRequisitarUma(obterToken, metodo, pathAndQuery, { body, extraHeaders, timeoutMs } = {}) {
  const res = await obterToken((token) => fetch(INK_API_BASE + pathAndQuery, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(extraHeaders || {}),
    },
    body: body !== undefined ? JSON.stringify(body || {}) : undefined,
    signal: AbortSignal.timeout(timeoutMs || (metodo === 'GET' || metodo === 'DELETE' ? 15000 : 20000)),
  }));
  if (metodo === 'DELETE' && res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.errors && data.errors.join('; ')) || data.error || `INK API respondeu ${res.status}`);
    err.status = res.status;
    if (metodo !== 'GET') err.details = data;
    throw err;
  }
  return data;
}

// Compatibilidade: quem ainda carrega a chave `sul`/`centro`/`norte`. Confere que é a do contexto.
const inkFetch = (loja, metodo, pathAndQuery, opcoes) => inkRequisitar((usar) => comTokenInk(loja, usar), metodo, pathAndQuery, opcoes);
// Canônico: a credencial Ink da Organization do contexto, sem identificador de loja nenhum.
const inkFetchDaStore = (metodo, pathAndQuery, opcoes) => inkRequisitar(comTokenInkDaStore, metodo, pathAndQuery, opcoes);

const inkApiRequest = (loja, pathAndQuery) => inkFetch(loja, 'GET', pathAndQuery);
// Versão canônica do GET: sem chave legada, credencial da Organization do contexto.
const inkApiRequestDaStore = (pathAndQuery) => inkFetchDaStore('GET', pathAndQuery);
const inkApiPost = (loja, pathAndQuery, body, extraHeaders, timeoutMs) => inkFetch(loja, 'POST', pathAndQuery, { body, extraHeaders, timeoutMs });
const inkApiPatch = (loja, pathAndQuery, body, extraHeaders) => inkFetch(loja, 'PATCH', pathAndQuery, { body, extraHeaders });
const inkApiPut = (loja, pathAndQuery, body, extraHeaders) => inkFetch(loja, 'PUT', pathAndQuery, { body, extraHeaders });
const inkApiDelete = (loja, pathAndQuery, extraHeaders) => inkFetch(loja, 'DELETE', pathAndQuery, { extraHeaders });
const inkApiPostDaStore = (pathAndQuery, body, extraHeaders, timeoutMs) => inkFetchDaStore('POST', pathAndQuery, { body, extraHeaders, timeoutMs });
const inkApiPatchDaStore = (pathAndQuery, body, extraHeaders) => inkFetchDaStore('PATCH', pathAndQuery, { body, extraHeaders });
const inkApiPutDaStore = (pathAndQuery, body, extraHeaders) => inkFetchDaStore('PUT', pathAndQuery, { body, extraHeaders });
const inkApiDeleteDaStore = (pathAndQuery, extraHeaders) => inkFetchDaStore('DELETE', pathAndQuery, { extraHeaders });

// Aplica o estado de um pedido da Reserva Ink (resposta de GET /v1/stores/orders/{id}) sobre o
// registro local — QR não é gerado aqui, é sempre na hora que a hotpage pede (`/assets/pedidos`),
// direto do `pixCode`. Idempotente: pode ser chamada repetidas vezes (webhook duplicado,
// reconciliação) sem efeito colateral.
async function aplicarPedidoInk(pedidos, id, pedido, order) {
  const pixCode = (order.pix && order.pix.qr_code) || null;
  pedido.pixCode = pixCode;
  pedido.pixExpiration = (order.pix && order.pix.expiration_date) || null;
  pedido.orderStatus = order.order_status || null;
  pedido.orderStatusLabel = order.formatted_order_status || null;
  pedido.paymentStatus = order.payment_status || null;
  if (order.buyer) {
    const nome = [order.buyer.first_name, order.buyer.last_name].filter(Boolean).join(' ').trim();
    if (nome) pedido.cliente = nome;
  }
  if (order.total_value != null) pedido.valor = String(order.total_value);
  pedido.atualizadoEm = new Date().toISOString();

  pedidos[id] = pedido;
}

async function syncPedidoFromInk(loja, inkOrderId) {
  const data = await inkApiRequestDaStore(`/v1/stores/orders/${inkOrderId}`);
  if (!data.order) return;

  const pedidos = await readPedidos();
  const match = Object.entries(pedidos).find(
    ([, p]) => p.origem === 'ink' && p.loja === loja && p.inkOrderId === inkOrderId
  );
  if (!match) {
    console.warn(`[INK_SYNC] pedido INK ${inkOrderId} (${loja}) sem hotpage vinculada — ignorado`);
    return;
  }

  const [id, pedido] = match;
  await aplicarPedidoInk(pedidos, id, pedido, data.order);
  await writePedidos(pedidos);

  if (pgPool) {
    await upsertPedidoInkPostgres(loja, data.order).catch((err) => {
      console.error(`[POSTGRES] falha ao atualizar pedido ${inkOrderId} (${loja}): ${err.message}`);
    });
  }
}

// Chamado a partir de um webhook verificado: atualiza a hotpage local (se existir uma pra esse
// pedido) e dispara mensagem automática (se houver template configurado pra esse evento) — as
// duas coisas usam o mesmo pedido buscado uma única vez na API.
// `loja` é a chave legada da Store do contexto, NULA na Store nativa. A ingestão do pedido é
// canônica (credencial da Store + `store_id`) e roda para as duas; as automações de WhatsApp/PIX e a
// observação de estoque ainda são indexadas por chave legada, então só rodam para Store que tem uma.
async function processarEventoWebhook(loja, inkOrderId, eventName) {
  const data = await inkApiRequestDaStore(`/v1/stores/orders/${inkOrderId}`);
  if (!data.order) return;

  if (loja) {
    const pedidos = await readPedidos();
    const match = Object.entries(pedidos).find(
      ([, p]) => p.origem === 'ink' && p.loja === loja && p.inkOrderId === inkOrderId
    );
    if (match) {
      const [id, pedido] = match;
      await aplicarPedidoInk(pedidos, id, pedido, data.order);
      await writePedidos(pedidos);
    }
  }

  // Atualiza o cache Postgres em tempo real — sem isso, o anti-spam de carrinho só veria essa
  // compra/mudança de status na próxima sincronização de hora em hora.
  if (pgPool) {
    await upsertPedidoInkPostgres(loja, data.order).catch((err) => {
      console.error(`[POSTGRES] falha ao atualizar pedido ${inkOrderId} (${loja}): ${err.message}`);
    });
  }

  if (!loja) return; // Store nativa: automações de WhatsApp/PIX e estoque ainda são por chave legada.
  await registrarObservacoesEstoque(loja, data.order);
  await registrarPixPendenteSeAplicavel(loja, eventName, data.order);
  await encerrarPixPendenteSeTerminal(loja, eventName, data.order);
  await dispararMensagemAutomatica(loja, eventName, data.order);
}

// Monitor de conciliação: reforça o webhook consultando a API periodicamente para pedidos
// INK ainda pendentes — cobre entregas de webhook perdidas ou ainda não confirmadas.
async function reconcilePendingInkPedidos() {
  const pedidos = await readPedidos();
  const pendentes = Object.entries(pedidos).filter(
    ([, p]) => p.origem === 'ink' && PENDING_PAYMENT_STATUSES.has(p.paymentStatus)
  );
  for (const [id, pedido] of pendentes) {
    try {
      await syncPedidoFromInk(pedido.loja, pedido.inkOrderId);
    } catch (err) {
      console.error(`[MONITOR] falha ao reconciliar pedido ${id}: ${err.message}`);
    }
  }
}

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
JOBS.agendar('reconcile-ink', RECONCILE_INTERVAL_MS, () => reconcilePendingInkPedidos());

// Consulta um endpoint da Ink para a loja da Store do contexto (Fase 3). Substitui o antigo
// agregador que percorria todas as lojas (F-02 / PD-022): mesmo formato de retorno, uma loja só.
async function fetchInkDaStore(pathAndQuery) {
  const resultados = [];
  const erros = [];
  for (const store of await storesInkDoContexto()) {
    // `loja` aqui é a CHAVE de escopo (mapas de automação/envios), não a chave legada.
    const loja = store.loja || chaveDaStore();
    try {
      const data = await inkApiRequestDaStore(pathAndQuery);
      resultados.push({ loja, data });
    } catch (err) {
      erros.push({ loja, error: err.message });
    }
  }
  return { resultados, erros };
}

async function readPedidos() {
  return lerConfigPostgres('pedidos', PEDIDOS_FILE, {});
}
async function writePedidos(data) {
  return salvarConfigPostgres('pedidos', PEDIDOS_FILE, data);
}

// ID público não-sequencial (crypto.randomBytes, nunca Math.random ou contador)
function generatePedidoId(existing) {
  let id;
  do {
    id = crypto.randomBytes(9).toString('base64url'); // 12 chars, ~72 bits de entropia
  } while (existing[id]);
  return id;
}

// ── Autenticação individual (Fase 2) ─────────────────────────────────────────────────────
// Até a Fase 1 existia uma senha única da instalação e um cookie HMAC sem estado: não havia
// pessoa, nem revogação, e todo audit dizia 'admin'. Agora: users + sessions persistidas e
// revogáveis, CSRF em toda escrita autenticada, papéis owner/member. Ver lib/auth/.
//
// `requireAdmin` mantém o nome (222 rotas o usam) e passa a ser a sessão individual. Ele NÃO
// resolve Organization — isso é Fase 3.
const { resolverConfigAuth, createAuth } = require('./lib/auth');
const { comOrganization } = require('./lib/platform/tenant-db');
const { registrarAuditoria, registrarAuditoriaEm, validarAtor } = require('./lib/platform/audit');
const { createTenantPipeline, resolverStore } = require('./lib/platform/tenant-pipeline');
const { requireEntitlement, checkEntitlement, carregadorDaOrganizacao, planoEfetivo } = require('./lib/platform/entitlements');
const { featureDaRota } = require('./lib/platform/feature-routes');
// Recurso por id: lido com a Organization da sessão antes do handler; de outra Organization = 404.
const exigirRecurso = require('./lib/platform/ownership').criarExigirRecurso(() => pgPool);

// Fail-fast com exit ≠ 0: throw no topo seria engolido pelo uncaughtException (B-2).
let CONFIG_AUTH;
try {
  CONFIG_AUTH = resolverConfigAuth(process.env);
} catch (err) {
  console.error(`[AUTH] configuração inválida: ${err.message}`);
  process.exit(1);
}
if (CONFIG_AUTH.legado.habilitado) {
  console.warn(
    '[AUTH] ALLOW_LEGACY_ADMIN_PASSWORD=1 — login por senha compartilhada ATIVO, como ' +
    `${CONFIG_AUTH.legado.email}. Compatibilidade de emergência por uma release (OPS-19).`
  );
}

// OPS-22 · leitura dupla temporária dos arquivos do Creative Core (lib/creative-core/leitura-legada.js).
// Configuração parcial ou inválida derruba o boot: o fallback nunca liga num estado não declarado.
let LEITURA_LEGADA_CRIATIVOS = null;
try {
  LEITURA_LEGADA_CRIATIVOS = require('./lib/creative-core/leitura-legada').lerLeituraLegada(process.env);
} catch (err) {
  console.error(`[CRIATIVOS] configuração inválida: ${err.message}`);
  process.exit(1);
}
if (LEITURA_LEGADA_CRIATIVOS) {
  console.warn(
    '[CRIATIVOS] OPS-22: leitura legada LIGADA para 1 Organization (temporária). Rode ' +
    'tenancy:mover-criativos --aplicar e --verificar; com PASS, desligue na release seguinte.'
  );
}

// Sem Postgres (modo efêmero de dev) ou sem segredo em dev, não há login: 503, nunca "passa".
const AUTH = pgPoolReal && CONFIG_AUTH.disponivel
  ? createAuth({
    pool: pgPoolReal,
    config: CONFIG_AUTH,
    comOrganization,
    auditar: (entrada) => registrarAuditoria(pgPoolReal, entrada),
  })
  : null;
const TENANT = pgPoolReal ? createTenantPipeline({ poolReal: pgPoolReal }) : null;

// Pipeline de toda rota de negócio (Fase 3): sessão → Organization ativa → membership → Store →
// contexto → entitlement da feature da rota. Mantém o nome `requireAdmin` (222 rotas).
function requireAdmin(req, res, next) {
  if (!AUTH || !TENANT) return res.status(503).json({ error: 'autenticação indisponível' });
  return AUTH.requireAuth(req, res, (err) => {
    if (err) return next(err);
    return TENANT.requireOrganizationContext(req, res, (err2) => {
      if (err2) return next(err2);
      // TD-012: a feature da rota é conferida contra o plano da Organization da sessão.
      const feature = featureDaRota(`${req.baseUrl || ''}${req.path}`);
      if (!feature) return next();
      return exigirFeature(feature)(req, res, next);
    });
  });
}

const PLANO_DA_ORGANIZACAO = pgPool ? carregadorDaOrganizacao(pgPool) : async () => null;
function exigirFeature(feature) {
  return requireEntitlement(PLANO_DA_ORGANIZACAO, feature);
}

// Caminhos sem sessão (webhook, link público, agente, callback OAuth, job): a Organization sai de
// um resolvedor estreito do banco (SECURITY DEFINER, uma ou nenhuma) ou de um state assinado —
// nunca de parâmetro do cliente, nunca de "a única que existe". Nome da função: lista fechada.
const RESOLVEDORES_SEM_SESSAO = new Set([
  'tenancy_organization_da_loja',
  'tenancy_organization_do_wamid',
  'publico_organization_do_pedido',
  'publico_organization_da_midia',
  'publico_organization_do_agente',
  'ink_organization_do_webhook',
]);
async function organizacaoPorResolvedor(funcao, valor) {
  if (!RESOLVEDORES_SEM_SESSAO.has(funcao)) throw new Error(`resolvedor desconhecido: ${funcao}`);
  if (!pgPoolReal || typeof valor !== 'string' || !valor) return null;
  const { rows } = await semContexto(() => pgPoolReal.query(`SELECT ${funcao}($1) AS id`, [valor]));
  return (rows[0] && rows[0].id) || null;
}

async function comOrganizacaoResolvida(organizationId, origem, fn) {
  const store = await semContexto(() => resolverStore(pgPoolReal, organizationId));
  return comContexto({ organizationId, storeId: store.storeId, loja: store.loja, origem }, fn);
}

// "Migração Use Origens" não é feature de cliente SaaS normal (doc, Parte 4) — só existe 1 nível
// de admin neste projeto (sem role), então a proteção real é essa env var, checada em TODA rota
// da ferramenta. 404 (não 403) de propósito: não revela nem que a rota existe quando desligada.
// Esconder o item de menu no frontend é só cosmético, nunca a proteção de verdade.
const INTERNAL_TOOLS_ENABLED = process.env.INTERNAL_TOOLS_ENABLED === 'true';
function requireInternalTools(req, res, next) {
  if (!INTERNAL_TOOLS_ENABLED) return res.status(404).end();
  next();
}

// in-flight lock: prevents duplicate CDN fetches for the same file
const inFlight = new Map();

async function fetchAndCache(filename) {
  if (inFlight.has(filename)) return inFlight.get(filename);

  const promise = (async () => {
    const dest = path.join(IMG_CACHE_DIR, filename);
    const res  = await fetch(CDN_BASE + filename, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`CDN ${res.status}`);
    const buf  = Buffer.from(await res.arrayBuffer());

    let out = buf;
    try {
      const sharp = require('sharp');
      out = await sharp(buf).resize(350, 350, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    } catch {
      // sharp not installed: serve original
    }

    fs.writeFileSync(dest, out);
    return dest;
  })();

  inFlight.set(filename, promise);
  promise.finally(() => inFlight.delete(filename)).catch(() => {});
  return promise;
}

// INV-13: nenhuma resposta leva um segredo de integração registrado (lib/platform/secret-guard.js).
app.use(secretGuard.middlewareDeResposta());

app.use(express.json({
  // Padrão do Express é 100kb — artes de produto chegam em base64 (até 20MB cada, por regra da
  // Ink), muito acima disso. Sem esse limite maior, a criação de produto com arte era rejeitada
  // antes de chegar no handler (sem log nenhum do lado nosso — só o body-parser recusando).
  limit: '100mb',
  verify: (req, res, buf) => { req.rawBody = buf; }, // necessário pra validar assinatura HMAC dos webhooks INK
}));

// Image proxy — serves from Railway Volume, falls back to CDN + resize on cache miss
app.get('/img/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!VALID_IMG.test(filename)) return res.status(400).end();

  const cached = path.join(IMG_CACHE_DIR, filename);
  if (fs.existsSync(cached)) {
    return res.sendFile(cached);
  }

  try {
    const dest = await fetchAndCache(filename);
    res.sendFile(dest);
  } catch (err) {
    console.error(`[IMG] ${filename}: ${err.message}`);
    res.status(502).end();
  }
});

// QR Code do pedido — gerado na hora a partir do `pixCode` guardado, nunca cacheado em disco
// (filesystem é efêmero em produção; o código Pix em si já está seguro no Postgres).
app.get('/assets/pedidos/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!/^[A-Za-z0-9_-]{10,14}\.png$/.test(filename)) return res.status(400).end();
  const id = filename.slice(0, -4);
  try {
    // O id do link é a capability; a Organization dona sai do banco (nunca do request).
    const organizationId = await organizacaoPorResolvedor('publico_organization_do_pedido', id);
    if (!organizationId) return res.status(404).end();
    const pedido = await comOrganizacaoResolvida(organizationId, 'publico:pedido', async () => (await readPedidos())[id]);
    if (!pedido || !pedido.pixCode) return res.status(404).end();
    const qrBuffer = await generateQrPng(pedido.pixCode);
    res.type('png').send(qrBuffer);
  } catch (err) {
    console.error(`[PEDIDOS] falha ao gerar QR de ${id}: ${err.message}`);
    res.status(500).end();
  }
});

// Bloqueia acesso direto ao arquivo de dados dos pedidos (contém código PIX de todos os clientes)
app.use((req, res, next) => {
  if (req.path === '/db' || req.path.startsWith('/db/')) return res.status(404).end();
  next();
});

// ── Painel em React/TS (SPA) ────────────────────────────────────────────
// Qualquer sub-rota de /admin/* serve o mesmo index.html, e o react-router cuida do roteamento
// client-side (ver src/App.tsx pra a lista real de rotas).
//
// PASTA ≠ URL. O frontend já morou em `apps/panel/admin/`, com o build em `admin/dist`; a pasta
// acabou — `index.html`, `src/` e `vite.config.mjs` são da raiz do painel, e o build sai em
// `dist/`. A URL `/admin` NÃO mudou junto: é por ela que o painel responde, a landing do Oria
// aponta pra ela, e `base: '/admin/'` no vite.config.mjs é o que faz os assets baterem. Quem for
// "corrigir" isso pra `/` numa próxima rodada: a raiz é a landing de propósito (é o que o domínio
// abre, e é a página que o Google revisita na verificação do OAuth).
//
// Arquivos com hash no nome (Vite: index-<hash>.js/.css) nunca mudam de conteúdo sob o mesmo
// nome — cache longo e imutável é seguro aqui. O index.html É o arquivo que muda a cada deploy
// (referencia os hashes novos), por isso precisa do no-cache logo abaixo; sem isso, um
// index.html antigo em cache (navegador ou Cloudflare, que fica na frente do Railway) continua
// apontando pros arquivos hash antigos, que o build seguinte já sobrescreveu — página inteira
// quebrada/desatualizada até um hard refresh, sem nenhum erro visível pro usuário.
app.use('/admin/assets', express.static(path.join(__dirname, 'dist', 'assets'), {
  maxAge: '1y',
  immutable: true,
}));
app.get(/^\/admin(\/.*)?$/, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Só a allowlist de arquivos abertos do produto (assets/, as páginas da raiz e os dois arquivos
// da hotpage em src/). Nada de express.static na raiz do repo: servia código-fonte, docs,
// scripts e logs.
//
// Aqui ficavam também as rotas do site da Orgulho Regional, que este serviço servia junto com o
// painel: a busca de cidades (`/`, `/{sul|centro|norte}` e sub-rotas, `/{uf}/{cidade}`), a loja de
// personalizados (`/{regiao}/loja/...`) e os dois logs dessas telas (`/api/log`, `/api/loja/log`).
// O site saiu — o produto deste repositório é o painel —, e a raiz passou a servir a landing do
// Oria (lib/arquivos-publicos.js). Nenhuma dessas URLs responde mais: test/invariants/site-fora.test.js
// sobe o serviço e exige 404 em cada uma.
require('./lib/arquivos-publicos').montarArquivosPublicos(app, { raiz: __dirname });

// Login individual, logout, sessão, revogação e membros (lib/auth/router.js).
if (AUTH) {
  app.use('/api/admin', AUTH.router);
} else {
  app.all(/^\/api\/admin\/(login|logout|session)$/, (req, res) => {
    res.status(503).json({ error: 'autenticação indisponível (exige Postgres e ADMIN_SESSION_SECRET)' });
  });
}

// Exibe as últimas entregas de webhook recebidas (headers + corpo) — usado pela tela Eventos e
// pra confirmar o esquema real de autenticação/payload da Reserva Ink caso mude.
app.get('/api/admin/webhook-log', requireAdmin, async (req, res) => {
  if (pgPool) {
    try {
      const { rows } = await pgPool.query(
        `SELECT recebido_em AS "recebidoEm", verificado, loja, metodo_auth AS "metodoAuth",
                event_name AS "eventName", ink_order_id AS "inkOrderId", headers, body
         FROM webhook_eventos WHERE organization_id = $1 ORDER BY recebido_em DESC LIMIT 500`,
        [orgDoContexto()]
      );
      return res.json({ log: rows });
    } catch (err) {
      console.error(`[POSTGRES] falha ao ler eventos: ${err.message}`);
      return res.status(500).json({ error: 'não foi possível ler os eventos' });
    }
  }
  let log = [];
  try { log = JSON.parse(fs.readFileSync(WEBHOOK_LOG_FILE, 'utf8')); } catch { log = []; }
  res.json({ log });
});

app.get('/api/admin/pedidos', requireAdmin, async (req, res) => {
  try {
    const pedidos = await readPedidos();
    const list = Object.entries(pedidos)
      .map(([id, p]) => ({
        id,
        loja: p.loja,
        origem: p.origem || 'manual',
        inkOrderId: p.inkOrderId || null,
        orderStatus: p.orderStatus || null,
        orderStatusLabel: p.orderStatusLabel || null,
        paymentStatus: p.paymentStatus || null,
        referencia: p.referencia || null,
        cliente: p.cliente || null,
        valor: p.valor || null,
        criadoEm: p.criadoEm,
      }))
      .sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
    res.json({ pedidos: list });
  } catch (err) {
    console.error(`[PEDIDOS] falha ao listar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar os pedidos' });
  }
});

// Pedidos da INK com Pix pendente (mesmo sinal usado no vínculo: `order.pix` só vem preenchido
// nesse caso) — pra tela de vincular mostrar uma lista clicável em vez de exigir digitar o ID.
async function buscarPedidosPixPendentes() {
  const pedidosLocais = await readPedidos();
  const vinculados = new Set(
    Object.values(pedidosLocais)
      .filter((p) => p.origem === 'ink')
      .map((p) => `${p.loja}:${p.inkOrderId}`)
  );

  const desde = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const pendentes = [];
  const erros = [];

  for (const store of await storesInkDoContexto()) {
    const loja = store.loja || chaveDaStore();
    try {
      let page = 1;
      let totalPages = 1;
      do {
        const data = await inkApiRequestDaStore(`/v1/stores/orders?begin_date=${desde}&page=${page}&per_page=100`);
        for (const o of data.orders || []) {
          if (!o.pix) continue;
          pendentes.push({
            loja,
            inkOrderId: o.id,
            rsvFactoryId: o.rsv_factory_id || null,
            cliente: o.buyer ? [o.buyer.first_name, o.buyer.last_name].filter(Boolean).join(' ').trim() : null,
            buyerPhone: (o.buyer && o.buyer.phone) || null,
            valor: o.total_value != null ? String(o.total_value) : null,
            criadoEm: o.created_at || null,
            expiracao: o.pix.expiration_date || null,
            jaVinculado: vinculados.has(`${loja}:${o.id}`),
            // Só uso interno (preview do template em /api/admin/recuperacao) — nunca sai na
            // resposta HTTP, ver `ordemBruta` sendo removido antes do res.json ali.
            ordemBruta: o,
          });
        }
        totalPages = data.total_pages || 1;
        page += 1;
      } while (page <= totalPages);
    } catch (err) {
      console.error(`[PEDIDOS_PENDENTES] falha ao buscar pendentes (${loja}): ${err.message}`);
      erros.push(loja);
    }
  }

  pendentes.sort((a, b) => new Date(b.criadoEm || 0) - new Date(a.criadoEm || 0));
  return { pendentes, erros };
}

app.get('/api/admin/pedidos/ink/pendentes', requireAdmin, async (req, res) => {
  try {
    const { pendentes, erros } = await buscarPedidosPixPendentes();
    res.json({ pedidos: pendentes, erros });
  } catch (err) {
    console.error(`[PEDIDOS_PENDENTES] falha ao ler pedidos locais: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler os pedidos' });
  }
});

// Cria (ou reaproveita) a hotpage de um pedido com Pix pendente — usado tanto pelo vínculo
// manual (admin, endpoint abaixo) quanto pelo lembrete automático do evento `pix.pendente`
// (`enviarLembretePix`). `order` deve vir fresco da API (com `.pix` atualizado). Retorna `null`
// quando não existe hotpage ainda E o pedido não tem Pix pendente (nada útil pra criar).
async function garantirHotpagePedidoPix(loja, orderId, order) {
  const pedidos = await readPedidos();
  const existente = Object.entries(pedidos).find(
    ([, p]) => p.origem === 'ink' && p.loja === loja && p.inkOrderId === orderId
  );
  if (!existente && !order.pix) return null;

  const id = existente ? existente[0] : generatePedidoId(pedidos);
  const pedido = existente ? existente[1] : {
    loja,
    origem: 'ink',
    inkOrderId: orderId,
    referencia: null,
    criadoEm: new Date().toISOString(),
  };
  await aplicarPedidoInk(pedidos, id, pedido, order);
  await writePedidos(pedidos);
  return { id, jaExistia: !!existente };
}

// Vincula um pedido real da Reserva Ink a uma hotpage: busca os dados oficiais (pix, valor,
// cliente, status) via API em vez de exigir digitação manual do código pix.
app.post('/api/admin/pedidos/ink', requireAdmin, async (req, res) => {
  const { inkOrderId } = req.body || {};
  // O que autoriza é a Store ter credencial — não ter chave legada. Antes o gate era `!loja`, e
  // por isso uma Store nativa do Oria levava 503 mesmo com a Ink conectada.
  const [store] = await storesInkDoContexto();
  if (!store) return res.status(503).json({ error: 'esta organization não tem integração com a Reserva Ink configurada' });
  const loja = store.loja || chaveDaStore();
  const orderId = Number(inkOrderId);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'id do pedido inválido' });

  let order;
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/orders/${orderId}`);
    order = data.order;
  } catch (err) {
    console.error(`[ADMIN] falha ao buscar pedido INK ${orderId} (${loja}): ${err.message}`);
    return res.status(err.status === 404 ? 404 : 502).json({ error: 'não foi possível buscar esse pedido na Reserva Ink' });
  }
  if (!order) return res.status(404).json({ error: 'pedido não encontrado na Reserva Ink' });

  let resultado;
  try {
    resultado = await garantirHotpagePedidoPix(loja, orderId, order);
  } catch (err) {
    console.error(`[ADMIN] falha ao gerar hotpage do pedido INK ${orderId}: ${err.message}`);
    return res.status(400).json({ error: 'não foi possível gerar a hotpage pra esse pedido' });
  }
  // A hotpage só faz sentido pra enviar ao cliente enquanto o Pix está pendente — a API só
  // preenche `order.pix` nesse caso. Vincular um pedido já pago/sem Pix não gera nada útil.
  if (!resultado) return res.status(400).json({ error: 'esse pedido não tem um Pix pendente para enviar ao cliente' });

  if (pgPool) {
    await upsertPedidoInkPostgres(loja, order).catch((err) => {
      console.error(`[POSTGRES] falha ao atualizar pedido ${orderId} (${loja}): ${err.message}`);
    });
  }

  res.json({ ok: true, id: resultado.id, url: `/${resultado.id}`, jaExistia: resultado.jaExistia });
});

// Força a sincronização de um pedido vinculado à Reserva Ink (botão manual no admin)
app.post('/api/admin/pedidos/:id/sync', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!PEDIDO_ID_RE.test(id)) return res.status(400).json({ error: 'id inválido' });

  const pedidos = await readPedidos();
  const pedido = pedidos[id];
  if (!pedido || pedido.origem !== 'ink') return res.status(404).json({ error: 'pedido não vinculado à Reserva Ink' });

  try {
    const data = await inkApiRequest(pedido.loja, `/v1/stores/orders/${pedido.inkOrderId}`);
    if (!data.order) return res.status(404).json({ error: 'pedido não encontrado na Reserva Ink' });
    await aplicarPedidoInk(pedidos, id, pedido, data.order);
    await writePedidos(pedidos);
  } catch (err) {
    console.error(`[ADMIN] falha ao sincronizar pedido ${id}: ${err.message}`);
    return res.status(502).json({ error: 'não foi possível sincronizar com a Reserva Ink' });
  }

  res.json({ ok: true });
});

const RESUMO_PAGO = new Set(['paid', 'succeeded', 'free']);
// Só os status realmente ruins do enum documentado de payment_status (ver PAYMENT_STATUS_MAP em
// src/lib/statusMap.ts) — bug encontrado 2026-09-06 (usuário notou pedidos Entregues
// contando como "problema de pagamento" no dashboard): antes, QUALQUER status fora de
// RESUMO_PAGO/PENDING_PAYMENT_STATUSES virava "problema" por padrão, incluindo status
// desconhecido/não catalogado ou o campo simplesmente vindo nulo da Ink — um pedido entregue com
// payment_status inesperado (ou ausente) disparava alarme falso de "problema de pagamento".
const RESUMO_PROBLEMA = new Set(['refund_requested', 'refunded', 'canceled', 'failed', 'expired', 'not_authorized', 'dispute', 'chargeback']);
function bucketPaymentStatus(status) {
  if (PENDING_PAYMENT_STATUSES.has(status)) return 'aguardando';
  if (RESUMO_PAGO.has(status)) return 'pago';
  if (RESUMO_PROBLEMA.has(status)) return 'problema';
  return 'desconhecido';
}

// Carrinhos abandonados de todas as lojas configuradas, agregados e ordenados por atualização
app.get('/api/admin/dashboard/abandoned-carts', requireAdmin, async (req, res) => {
  const { resultados, erros } = await fetchInkDaStore('/v1/stores/abandoned_carts?per_page=50');

  const carrinhos = resultados.flatMap(({ loja, data }) =>
    (data.abandoned_carts || []).map((c) => ({
      loja,
      id: c.id,
      updatedAt: c.updated_at,
      itemsCount: c.items_count,
      contactable: !!c.contactable,
      buyerName: (c.buyer && c.buyer.name) || null,
      buyerPhone: (c.buyer && c.buyer.phone) || null,
      primeiroProduto: (c.items && c.items[0] && c.items[0].product_v2 && c.items[0].product_v2.name) || null,
      valor: somaValorItens(c.items) || null,
    }))
  );
  carrinhos.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  res.json({ carrinhos, erros });
});

// Widget "Recuperação via WhatsApp" do Dashboard — só lê o estado persistido de envios (mesma
// conta de /api/admin/recuperacao, via calcularMetricasEnvio), sem bater na Ink nem no serviço de
// WhatsApp: é rápido de propósito, pra não pesar o carregamento do Dashboard.
app.get('/api/admin/dashboard/recuperacao-resumo', requireAdmin, async (req, res) => {
  // Chave legada OU nula: o estado de envios é `app_config` da Organization (RLS), então a Store
  // nativa lê o próprio estado — registros dela não têm `loja`.
  const lojaFiltro = lojaLegadaDoContextoOuNula();
  try {
    const [envios, lembretes] = await Promise.all([readCarrinhoEnvios(), readPixLembretes()]);
    res.json(calcularMetricasEnvio(envios, lembretes, lojaFiltro));
  } catch (err) {
    console.error(`[DASHBOARD] falha ao calcular métricas de recuperação: ${err.message}`);
    res.status(500).json({ error: 'não foi possível calcular métricas de recuperação' });
  }
});

// ── Recuperação (Fase 6, ver docs/plan.md) — unifica Carrinhos + PIX pendente numa mesma
// visão. Não mexe na lógica de envio/cadência (`processarFollowUpsCarrinho`/`Pix`,
// `enviarCarrinhoAbandonado`/`enviarLembretePix`) — só LÊ o mesmo estado que elas já escrevem
// (`carrinho-envios`, `pix-lembretes`) pra mostrar tentativas/status/métricas.
function statusRecuperacao(contactable, registro) {
  if (!contactable) return 'sem_permissao';
  if (registro && registro.concluido) return 'concluido';
  if (registro && registro.envios && registro.envios.length > 0) return 'aguardando';
  return 'recuperavel';
}

function somaValorItens(items) {
  return (items || []).reduce((acc, it) => acc + (Number(it.total_price ?? it.total_value) || 0), 0);
}

// Resumo dos itens pro detalhe do carrinho na tela — só o que a tela mostra, sem o item bruto da Ink.
function itensDoCarrinho(items) {
  return (items || []).map((it) => {
    const variante = it.product_variant || {};
    return {
      nome: (it.product_v2 && it.product_v2.name) || it.sku || null,
      variante: [variante.model, variante.color, variante.size].filter(Boolean).join(' · ') || null,
      quantidade: it.quantity || 1,
      total: Number(it.total_price ?? it.total_value) || null,
      imagem: it.mockup_image_url || (it.product_v2 && it.product_v2.main_image_url) || null,
    };
  });
}

// Desde quando uma compra conta como "comprou depois do carrinho": criação do carrinho na Ink
// quando o snapshot tem, senão o primeiro momento em que foi observado aqui.
function inicioDoCarrinho(registro) {
  return (registro.cart && registro.cart.created_at) || registro.criadoEm;
}

// Pedidos pagos (sem troca) desde `desdeIso` nas lojas pedidas, no formato de lib/recuperacao/compra.js.
// Só com Postgres: sem o cache local a tela não varre a API da Ink por carrinho — fica sem o selo
// "Já comprou", mas o envio continua barrado por `clienteJaComprou`.
async function pedidosPagosDesde(desdeIso) {
  if (!pgPool || !desdeIso) return [];
  const escopo = escopoDaStore(3);
  const { rows } = await pgPool.query(
    `SELECT loja, ink_order_id, criado_em, total_value, buyer_telefone, buyer_documento, buyer_email
     FROM pedidos_ink
     WHERE organization_id = $1 AND payment_status = ANY($2) AND criado_em >= $${3 + escopo.usados}
       AND ${escopo.sql} AND is_troca IS NOT TRUE`,
    [orgDoContexto(), Array.from(PAYMENT_STATUSES_CONVERTIDO), ...escopo.params, desdeIso]
  );
  return rows.map((r) => ({
    loja: r.loja,
    inkOrderId: r.ink_order_id,
    criadoEm: r.criado_em instanceof Date ? r.criado_em.toISOString() : r.criado_em,
    valor: r.total_value != null ? Number(r.total_value) : null,
    telefone: r.buyer_telefone,
    documento: r.buyer_documento,
    email: r.buyer_email,
  }));
}

// Métricas de recuperação (carrinho + Pix) a partir do estado persistido de envios — reaproveitado
// por /api/admin/recuperacao (métricas da tela) e /api/admin/dashboard/recuperacao-resumo (widget
// do Dashboard), pra não duplicar a mesma conta em dois lugares. "Conversão"/"receita recuperada"
// só conta carrinho — o `concluido` do Pix também cobre expirado/cancelado, não só "pagou".
function calcularMetricasEnvio(envios, lembretes, lojaFiltro) {
  // `lojaFiltro` é a chave legada da Store ou nula (Store nativa). Registro sem `loja` é o da Store
  // nativa, então ausente e nula são a MESMA coisa — `undefined === null` daria "nenhum registro".
  const daLoja = (r) => (r.loja || null) === (lojaFiltro || null);
  const enviosFiltrados = Object.values(envios).filter(daLoja);
  const lembretesFiltrados = Object.values(lembretes).filter(daLoja);
  const todasTentativas = [
    ...enviosFiltrados.flatMap((r) => r.envios || []),
    ...lembretesFiltrados.flatMap((r) => r.envios || []),
  ];
  const carrinhosConvertidos = enviosFiltrados.filter((r) => r.concluido).length;
  const receitaRecuperada = enviosFiltrados
    .filter((r) => r.concluido)
    .reduce((acc, r) => acc + somaValorItens(r.cart && r.cart.items), 0);
  const carrinhosTentados = enviosFiltrados.length;

  const porDia = {};
  todasTentativas.forEach((iso) => {
    const dia = String(iso).slice(0, 10);
    porDia[dia] = (porDia[dia] || 0) + 1;
  });

  return {
    mensagensEnviadas: todasTentativas.length,
    carrinhosConvertidos,
    receitaRecuperada,
    carrinhosTentados,
    taxaConversao: carrinhosTentados > 0 ? carrinhosConvertidos / carrinhosTentados : null,
    porDia,
  };
}

app.get('/api/admin/recuperacao', requireAdmin, async (req, res) => {
  const lojaFiltro = chaveDaStore();

  let envios, lembretes, eventosPorLoja;
  try {
    [envios, lembretes, eventosPorLoja] = await Promise.all([readCarrinhoEnvios(), readPixLembretes(), readAutomacaoEventos()]);
  } catch (err) {
    console.error(`[RECUPERACAO] falha ao ler estado local: ${err.message}`);
    return res.status(500).json({ error: 'não foi possível ler o estado de automação local' });
  }

  // Texto real do template (com variáveis já substituídas) pro botão "Copiar template" — busca a
  // lista aprovada na Meta 1x só (não por linha) e reaproveita pros dois tipos (carrinho e Pix).
  // Best-effort: sem isso configurado (ou WhatsApp fora do ar), a tela simplesmente não oferece o
  // botão de copiar nem o de "Enviar via Meta", sem quebrar o resto da listagem.
  // No modo WhatsApp Web o texto vem da mensagem própria vinculada (sem Meta nenhuma).
  const { provider } = await readWhatsappProviderConfig();
  const modoWeb = provider === 'whatsapp_web';
  let templatesMeta = null;
  let mensagensWebPorId = {};
  if (modoWeb) {
    try {
      const { rows } = pgPool ? await pgPool.query('SELECT id, corpo FROM whatsapp_web_mensagens') : { rows: [] };
      mensagensWebPorId = Object.fromEntries(rows.map((r) => [r.id, r]));
    } catch (err) {
      console.error(`[RECUPERACAO] falha ao ler mensagens do WhatsApp Web pro preview: ${err.message}`);
    }
  } else {
    try {
      const resultadoTemplates = await whatsappRequest('GET', '/templates/list');
      templatesMeta = (resultadoTemplates.data && resultadoTemplates.data.data) || [];
    } catch (err) {
      console.error(`[RECUPERACAO] falha ao buscar templates da Meta pro preview: ${err.message}`);
    }
  }
  const templateMetaPorNome = (nome) => (templatesMeta ? templatesMeta.find((t) => t.name === nome) : null);
  const textoDoVinculo = (eventoConfig, vars) => {
    if (!vinculoConfigurado(eventoConfig, provider)) return null;
    if (modoWeb) {
      const mensagem = mensagensWebPorId[eventoConfig.mensagemWeb];
      return mensagem ? renderizarMensagemWeb(mensagem.corpo, vars).trim() || null : null;
    }
    const templateMeta = templateMetaPorNome(eventoConfig.template);
    return templateMeta ? renderizarMensagemTemplate(templateMeta, eventoConfig, vars) : null;
  };

  const { resultados: carrinhoResultados, erros: carrinhoErros } = await fetchInkDaStore('/v1/stores/abandoned_carts?per_page=100');
  const carrinhosBrutos = carrinhoResultados
    .filter(({ loja }) => loja === lojaFiltro)
    .flatMap(({ loja, data }) => (data.abandoned_carts || []).map((c) => ({ loja, c })));

  const carrinhos = await Promise.all(carrinhosBrutos.map(async ({ loja, c }) => {
    const chave = `${loja}:${c.id != null ? c.id : ''}`;
    const registro = envios[chave];
    const vinculo = eventoConfigDeCarrinho(eventosPorLoja[loja] || {}, provider);
    const eventoConfig = vinculo ? vinculo.config : null;

    let mensagemTemplate = null;
    if (eventoConfig) {
      try {
        mensagemTemplate = textoDoVinculo(eventoConfig, await variaveisDoCarrinho(c, loja));
      } catch (err) {
        console.error(`[RECUPERACAO] falha ao montar preview do carrinho ${loja}:${c.id}: ${err.message}`);
      }
    }

    return {
      loja,
      id: c.id,
      buyerName: (c.buyer && c.buyer.name) || null,
      buyerPhone: (c.buyer && c.buyer.phone) || null,
      buyerEmail: (c.buyer && c.buyer.email) || null,
      itemsCount: c.items_count,
      itens: itensDoCarrinho(c.items),
      valor: somaValorItens(c.items),
      criadoEm: c.created_at || (registro ? inicioDoCarrinho(registro) : null),
      updatedAt: c.updated_at,
      contactable: !!c.contactable,
      tentativas: registro ? registro.envios.length : 0,
      maxTentativas: eventoConfig ? (eventoConfig.maxEnvios || 1) : null,
      status: statusRecuperacao(c.contactable, registro),
      mensagemTemplate,
      podeEnviarViaMeta: !!eventoConfig,
      arquivado: false,
    };
  }));

  // Carrinhos que a Ink já apagou (abandonado some de lá depois de ~30 dias) mas que temos
  // snapshot salvo (`persistirCarrinhoObservado`) — sem isso, o carrinho simplesmente sumia da
  // tela assim que a Ink parava de devolvê-lo, mesmo com telefone/itens ainda guardados aqui
  // (achado do usuário, 2026-09-06: lojista queria recuperar carrinho de 30d+ e não conseguia).
  const chavesAoVivo = new Set(carrinhosBrutos.map(({ loja, c }) => `${loja}:${c.id != null ? c.id : ''}`));
  const carrinhosArquivados = await Promise.all(
    Object.entries(envios)
      .filter(([chave, registro]) => !chavesAoVivo.has(chave) && !registro.concluido && (registro.loja === lojaFiltro))
      .map(async ([, registro]) => {
        const c = registro.cart || {};
        const vinculo = eventoConfigDeCarrinho(eventosPorLoja[registro.loja] || {}, provider);
        const eventoConfig = vinculo ? vinculo.config : null;

        let mensagemTemplate = null;
        if (eventoConfig) {
          try {
            mensagemTemplate = textoDoVinculo(eventoConfig, await variaveisDoCarrinho(c, registro.loja));
          } catch (err) {
            console.error(`[RECUPERACAO] falha ao montar preview do carrinho arquivado (${registro.loja}): ${err.message}`);
          }
        }

        return {
          loja: registro.loja,
          id: c.id != null ? c.id : null,
          buyerName: (c.buyer && c.buyer.name) || null,
          buyerPhone: registro.telefone || (c.buyer && c.buyer.phone) || null,
          buyerEmail: registro.email || (c.buyer && c.buyer.email) || null,
          itemsCount: c.items_count,
          itens: itensDoCarrinho(c.items),
          valor: somaValorItens(c.items),
          criadoEm: inicioDoCarrinho(registro),
          updatedAt: c.updated_at || registro.ultimoVistoEm || registro.criadoEm,
          contactable: true,
          tentativas: registro.envios.length,
          maxTentativas: eventoConfig ? (eventoConfig.maxEnvios || 1) : null,
          status: statusRecuperacao(true, registro),
          mensagemTemplate,
          podeEnviarViaMeta: !!eventoConfig,
          arquivado: true,
        };
      }),
  );

  const carrinhosTotal = [...carrinhos, ...carrinhosArquivados];

  // "Já comprou": pedido pago do mesmo comprador depois do carrinho (mesma regra do anti-spam, ver
  // lib/recuperacao/compra.js). Uma consulta só pro lote inteiro, a partir do carrinho mais antigo.
  // Best-effort — falhando, a lista sai sem o selo e o envio continua barrado no POST.
  const inicioMaisAntigo = carrinhosTotal.reduce((min, c) => {
    const t = new Date(c.criadoEm || c.updatedAt).getTime();
    return Number.isFinite(t) && (min == null || t < min) ? t : min;
  }, null);
  let pedidosPagos = [];
  try {
    pedidosPagos = await pedidosPagosDesde(inicioMaisAntigo != null ? new Date(inicioMaisAntigo).toISOString() : null);
  } catch (err) {
    console.error(`[RECUPERACAO] falha ao cruzar carrinhos com pedidos pagos: ${err.message}`);
  }
  carrinhosTotal.forEach((c) => {
    const compra = acharCompraDoCarrinho({ loja: c.loja, telefone: c.buyerPhone, email: c.buyerEmail, desde: c.criadoEm || c.updatedAt }, pedidosPagos);
    c.compra = compra ? { inkOrderId: compra.inkOrderId, em: compra.criadoEm, valor: compra.valor } : null;
    if (compra) c.status = 'comprou';
  });

  let pix = [];
  let pixErros = [];
  try {
    const resultado = await buscarPedidosPixPendentes();
    pixErros = resultado.erros;
    pix = await Promise.all(resultado.pendentes
      .filter((p) => p.loja === lojaFiltro)
      .map(async (p) => {
        const chave = `${p.loja}:${p.inkOrderId}`;
        const registro = lembretes[chave];
        const eventoConfig = (eventosPorLoja[p.loja] || {})[EVENTO_PIX_PENDENTE];

        let mensagemTemplate = null;
        if (vinculoConfigurado(eventoConfig, provider) && p.ordemBruta) {
          try {
            mensagemTemplate = textoDoVinculo(eventoConfig, await variaveisDoPedido(p.ordemBruta, p.loja));
          } catch (err) {
            console.error(`[RECUPERACAO] falha ao montar preview do Pix ${chave}: ${err.message}`);
          }
        }

        const { ordemBruta, ...pLimpo } = p;
        return {
          ...pLimpo,
          tentativas: registro ? registro.envios.length : 0,
          maxTentativas: eventoConfig ? (eventoConfig.maxEnvios || 1) : null,
          status: registro && registro.concluido ? 'concluido' : (registro && registro.envios.length > 0 ? 'aguardando' : 'recuperavel'),
          mensagemTemplate,
          podeEnviarViaMeta: vinculoConfigurado(eventoConfig, provider),
        };
      }));
  } catch (err) {
    console.error(`[RECUPERACAO] falha ao buscar PIX pendentes: ${err.message}`);
  }

  // Métricas: só o que dá pra sustentar com dado real. "Conversão"/"receita recuperada" só
  // conta carrinho (o `concluido` do PIX também cobre expirado/cancelado, não só "pagou" —
  // contar isso como conversão seria enganoso).
  const { mensagensEnviadas, carrinhosConvertidos, receitaRecuperada } = calcularMetricasEnvio(envios, lembretes, lojaFiltro);

  res.json({
    carrinhos: carrinhosTotal,
    pix,
    erros: [...new Set([...carrinhoErros.map((e) => e.loja), ...pixErros])],
    metricas: {
      recuperaveis: carrinhosTotal.filter((c) => c.contactable && c.status !== 'concluido' && c.status !== 'comprou').length + pix.filter((p) => p.status !== 'concluido').length,
      carrinhosJaComprados: carrinhosTotal.filter((c) => c.status === 'comprou').length,
      mensagensEnviadas,
      carrinhosConvertidos,
      receitaRecuperada,
    },
  });
});

// Envio manual "força agora" pra um carrinho abandonado específico — cobre o caso em que ainda
// não existe registro de automação pra esse carrinho (ex: webhook cart.abandoned nunca chegou ou
// não verificou) e o admin quer disparar na hora pela Meta em vez de só copiar e mandar na mão.
app.post('/api/admin/recuperacao/carrinho/enviar', requireAdmin, async (req, res) => {
  const { cartId } = req.body || {};
  const loja = chaveDaStore();
  if (cartId == null) return res.status(400).json({ error: 'cartId obrigatório' });

  try {
    const vinculo = eventoConfigDeCarrinho((await readAutomacaoEventos())[loja] || {}, (await readWhatsappProviderConfig()).provider);
    if (!vinculo) return res.status(400).json({ error: 'nenhuma mensagem de carrinho abandonado vinculada pra esta loja' });

    const chave = `${loja}:${cartId}`;
    const envios = await readCarrinhoEnvios();

    // A Ink não tem endpoint de "buscar 1 carrinho por id" — relista os abandonados da loja e
    // acha pelo id (mesma limitação do webhook, ver `extrairCarrinhoDoWebhook`). Se não achar (Ink
    // já apagou — carrinho abandonado some depois de 30 dias), cai pro snapshot salvo aqui: é
    // exatamente pra isso que ele existe (achado do usuário, 2026-09-06).
    const data = await inkApiRequestDaStore('/v1/stores/abandoned_carts?per_page=100');
    const cart = (data.abandoned_carts || []).find((c) => String(c.id) === String(cartId))
      || (envios[chave] ? envios[chave].cart : null);
    if (!cart) return res.status(404).json({ error: 'carrinho não encontrado (nem ao vivo na Ink, nem salvo aqui)' });

    const to = formatarTelefoneWhatsapp(cart.buyer && cart.buyer.phone) || (envios[chave] && envios[chave].telefone);
    if (!to) return res.status(400).json({ error: 'carrinho sem telefone identificável' });

    // Mesmo anti-spam do job automático: cliente que já comprou depois desse carrinho não recebe
    // mensagem de recuperação, nem forçada pela tela (achado do usuário, 2026-09-15).
    if (vinculo.config.checarCompra !== false) {
      const comprador = {
        telefone: to,
        documento: (cart.buyer && cart.buyer.document) || (envios[chave] && envios[chave].documento) || null,
        email: (cart.buyer && cart.buyer.email) || (envios[chave] && envios[chave].email) || null,
      };
      const desde = cart.created_at || (envios[chave] ? inicioDoCarrinho(envios[chave]) : null) || cart.updated_at;
      if (desde && await clienteJaComprou(loja, comprador, desde)) {
        if (envios[chave] && !envios[chave].concluido) {
          envios[chave].concluido = true;
          await writeCarrinhoEnvios(envios);
        }
        return res.status(409).json({ error: 'esse cliente já fez um pedido depois do carrinho — mensagem não enviada' });
      }
    }

    if (!envios[chave]) {
      envios[chave] = {
        loja, evento: vinculo.chave, telefone: to,
        documento: (cart.buyer && cart.buyer.document) || null, email: (cart.buyer && cart.buyer.email) || null,
        cart, criadoEm: new Date().toISOString(), ultimoVistoEm: new Date().toISOString(), ultimoEnvioEm: null, envios: [], concluido: false,
      };
      await writeCarrinhoEnvios(envios);
    }
    await enviarCarrinhoAbandonado(chave, envios[chave], vinculo.config);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[RECUPERACAO] falha ao enviar manualmente carrinho (${loja}, ${cartId}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível enviar agora' });
  }
});

// Mesma ideia pro lembrete de Pix pendente — pedidos cadastrados/vinculados manualmente (ver
// /admin/pedidos/novo e /admin/pedidos/vincular) nunca passam pelo webhook order.created que
// registra o lembrete automático, então nunca teriam tentativa nenhuma sem essa via manual
// (achado do usuário, 2026-09-05: Pix de véspera parado em 0 tentativas).
app.post('/api/admin/recuperacao/pix/enviar', requireAdmin, async (req, res) => {
  const { inkOrderId } = req.body || {};
  const loja = chaveDaStore();
  if (inkOrderId == null) return res.status(400).json({ error: 'inkOrderId obrigatório' });

  try {
    const eventoConfig = ((await readAutomacaoEventos())[loja] || {})[EVENTO_PIX_PENDENTE];
    if (!vinculoConfigurado(eventoConfig, (await readWhatsappProviderConfig()).provider)) {
      return res.status(400).json({ error: 'nenhuma mensagem de Pix pendente vinculada pra esta loja' });
    }

    const data = await inkApiRequestDaStore(`/v1/stores/orders/${inkOrderId}`);
    if (!data.order || !pedidoPixPendente(data.order)) return res.status(400).json({ error: 'pedido não está mais com Pix pendente' });

    const to = formatarTelefoneWhatsapp(data.order.buyer && data.order.buyer.phone);
    if (!to) return res.status(400).json({ error: 'pedido sem telefone identificável' });

    const chave = `${loja}:${inkOrderId}`;
    const lembretes = await readPixLembretes();
    if (!lembretes[chave]) {
      lembretes[chave] = {
        loja, evento: EVENTO_PIX_PENDENTE, telefone: to, ...identidadeCompradorPix(data.order), inkOrderId,
        criadoEm: new Date().toISOString(), ultimoEnvioEm: null, envios: [], concluido: false,
      };
      await writePixLembretes(lembretes);
    }
    await enviarLembretePix(chave, lembretes[chave], eventoConfig, data.order);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[RECUPERACAO] falha ao enviar manualmente Pix (${loja}, ${inkOrderId}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível enviar agora' });
  }
});

// bucketPaymentStatusDashboard existia separado quando a normalização era só-Dashboard (2026-09-08)
// — agora normalizarPaymentStatusInk é compartilhado (usado por pedidos_ink, clienteJaComprou e
// pedidoPixPendente também, ver topo do arquivo), então isso é só um alias fino.
function bucketPaymentStatusDashboard(statusBruto) {
  return bucketPaymentStatus(normalizarPaymentStatusInk(statusBruto));
}

// Achado ao validar o Dashboard com dado real (2026-09-08): GET /v1/stores/orders não documenta
// (nem aceita) parâmetro de ordenação — na prática devolve os pedidos em ordem CRESCENTE de
// created_at. Com per_page=100 (teto da API) e uma loja com mais de 100 pedidos na janela
// pedida, page=1 devolve os MAIS ANTIGOS da janela, não os mais recentes — os pedidos de hoje
// simplesmente não apareciam (confirmado: Use Sul tem 1640 pedidos nos últimos 90 dias, e
// page=1/per_page=100 parava em julho). Corrigido só aqui (endpoint do Dashboard): 1ª chamada só
// pra descobrir `total_pages`, 2ª já pedindo a última página — 2 requests/loja, não N.
// Mesma limitação existe em /api/admin/pedidos/central (loja=all) e no antigo endpoint do
// Dashboard (sem begin_date algum) — fora do escopo desta tarefa, reportado ao usuário.
async function fetchRecentOrdersDaStore(beginDate) {
  const resultados = [];
  const erros = [];
  const lojasComLacuna = [];
  for (const { loja } of await storesInkDoContexto()) {
    try {
      const query = `begin_date=${beginDate}&per_page=100`;
      const primeira = await inkApiRequest(loja, `/v1/stores/orders?${query}&page=1`);
      const totalPages = primeira.total_pages || 1;
      const data = totalPages > 1 ? await inkApiRequest(loja, `/v1/stores/orders?${query}&page=${totalPages}`) : primeira;
      // > 2: só a 1ª e a última página são buscadas — com 2 páginas as duas cobrem o período
      // inteiro (nada fica de fora); só a partir da 3ª sobra uma lacuna real no meio do período.
      if (totalPages > 2) lojasComLacuna.push(loja);
      resultados.push({ loja, data });
    } catch (err) {
      erros.push({ loja, error: err.message });
    }
  }
  return { resultados, erros, lojasComLacuna };
}

// Data no formato YYYY-MM-DD exigido pelo begin_date/end_date da Ink, N dias atrás (UTC).
function isoDateDiasAtras(dias) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

// Visão geral de pedidos de todas as lojas: contagem por status + últimos pedidos. `dias` cobre
// a janela pedida pelo seletor de período do Dashboard (mín. 2, pra sempre dar pra comparar
// hoje x ontem mesmo com "Hoje" selecionado) — o frontend recorta o range exato client-side,
// isso aqui só limita quanto pedir pra Ink (per_page=100/loja continua sendo o teto real da
// API, não é "toda a história").
app.get('/api/admin/dashboard/orders', requireAdmin, async (req, res) => {
  const dias = Math.max(2, Math.min(Number.parseInt(req.query.dias, 10) || 90, 90));
  const beginDate = isoDateDiasAtras(dias - 1);
  const { resultados, erros, lojasComLacuna } = await fetchRecentOrdersDaStore(beginDate);

  const localPedidos = await readPedidos();
  const hotpageIdPorPedidoInk = {};
  Object.entries(localPedidos).forEach(([id, p]) => {
    if (p.origem === 'ink') hotpageIdPorPedidoInk[`${p.loja}:${p.inkOrderId}`] = id;
  });

  const pedidos = resultados.flatMap(({ loja, data }) =>
    (data.orders || []).map((o) => ({
      loja,
      inkOrderId: o.id,
      createdAt: o.created_at,
      cliente: o.buyer ? [o.buyer.first_name, o.buyer.last_name].filter(Boolean).join(' ').trim() || null : null,
      valor: o.total_value != null ? String(o.total_value) : null,
      orderStatus: o.order_status || null,
      orderStatusLabel: o.formatted_order_status || null,
      paymentStatus: o.payment_status || null,
      paymentBucket: bucketPaymentStatusDashboard(o.payment_status),
      // `pix` só vem preenchido pela API quando o pedido está com Pix aguardando pagamento e não
      // expirado — é o sinal correto de que faz sentido gerar uma hotpage pra esse pedido.
      temPixPendente: !!o.pix,
      hotpageId: hotpageIdPorPedidoInk[`${loja}:${o.id}`] || null,
    }))
  );
  pedidos.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const resumo = { aguardando: 0, pago: 0, problema: 0, desconhecido: 0, total: pedidos.length };
  pedidos.forEach((p) => { resumo[p.paymentBucket] += 1; });

  res.json({ pedidos, resumo, erros, beginDate, lojasComLacuna });
});

// Resultado financeiro por loja e dia (fuso da loja), a partir do cache pedidos_ink — não da API da
// Ink, que no Dashboard só entrega até 200 pedidos/loja na janela (lojas grandes passam de 1.600 em
// 90 dias, a soma sairia bem abaixo do real). Só pedido pago e que não é troca entra nas somas.
// `semFinanceiro` conta os pagos ainda sem custo calculado (linhas de antes da coluna existir), pra
// tela avisar em vez de mostrar lucro menor que o real. Até 180 dias: o bastante pra comparar 90d
// com os 90d anteriores.
// Ranking de lucro por produto ou por modelo de peça no período, a partir de pedidos_ink_itens
// (só pedido pago e sem troca). `pedidosSemItens`: pagos do período cujos itens ainda não foram
// gravados (anteriores à tabela, até o backfill passar) — a tela avisa em vez de sub-reportar.
// `agrupar` vem do cliente e decide a expressão SQL, então só passa por este mapa fechado.
const LUCRO_AGRUPAMENTOS = {
  produto: { chave: 'COALESCE(i.produto_id::text, i.produto_nome)', rotulo: 'MAX(i.produto_nome)' },
  modelo: { chave: "COALESCE(NULLIF(i.modelo, ''), 'Sem modelo')", rotulo: "COALESCE(NULLIF(MAX(i.modelo), ''), 'Sem modelo')" },
};

app.get('/api/admin/dashboard/lucro-produtos', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'lucro por produto exige Postgres configurado' });
  const dias = Math.max(1, Math.min(Number.parseInt(req.query.dias, 10) || 30, 180));
  const agrupar = Object.prototype.hasOwnProperty.call(LUCRO_AGRUPAMENTOS, req.query.agrupar) ? req.query.agrupar : 'produto';
  const { chave, rotulo } = LUCRO_AGRUPAMENTOS[agrupar];
  // Identidade canônica: `organization_id + store_id` (a chave legada só entra como ramo de
  // compatibilidade quando a Store tem uma). O pedido é filtrado UMA vez, num CTE, e os itens
  // entram pela identidade do pedido — sem `loja` na junção, que é NULA na Store nativa.
  const escopo = escopoDaStore(4);
  const params = [orgDoContexto(), Array.from(RESUMO_PAGO), dias, ...escopo.params];
  const pedidosDoPeriodo = `WITH ped AS (
       SELECT store_id, loja, ink_order_id
       FROM pedidos_ink
       WHERE organization_id = $1
         AND ${escopo.sql}
         AND payment_status = ANY($2)
         AND is_troca IS NOT TRUE
         AND criado_em >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($3::int - 1))::timestamp AT TIME ZONE 'America/Sao_Paulo'
     )`;
  const itemDoPedido = `i.organization_id = $1 AND i.ink_order_id = p.ink_order_id
         AND (i.store_id = p.store_id OR (i.store_id IS NULL AND i.loja = p.loja))`;
  try {
    const { rows } = await pgPool.query(
      `${pedidosDoPeriodo}
       SELECT ${chave} AS chave,
              ${rotulo} AS nome,
              SUM(i.quantidade) AS pecas,
              COUNT(DISTINCT p.ink_order_id) AS pedidos,
              SUM(i.valor_venda - i.desconto_rateado) AS lucro_bruto,
              SUM(i.custo_producao) AS custo_producao,
              SUM(i.lucro_operacional) AS lucro_operacional
       FROM pedidos_ink_itens i
       JOIN ped p ON ${itemDoPedido}
       GROUP BY 1
       ORDER BY lucro_operacional DESC
       LIMIT 50`,
      params
    );
    const { rows: cobertura } = await pgPool.query(
      `${pedidosDoPeriodo}
       SELECT COUNT(*) AS sem_itens
       FROM ped p
       WHERE NOT EXISTS (SELECT 1 FROM pedidos_ink_itens i WHERE ${itemDoPedido})`,
      params
    );
    res.json({
      dias,
      agrupar,
      pedidosSemItens: Number(cobertura[0].sem_itens),
      itens: rows.map((r) => ({
        chave: r.chave,
        nome: r.nome,
        pecas: Number(r.pecas),
        pedidos: Number(r.pedidos),
        lucroBruto: Number(r.lucro_bruto),
        custoProducao: Number(r.custo_producao),
        lucroOperacional: Number(r.lucro_operacional),
      })),
    });
  } catch (err) {
    console.error(`[DASHBOARD_LUCRO_PRODUTOS] falha ao agregar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível calcular o lucro por produto' });
  }
});

app.get('/api/admin/dashboard/financeiro', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'resultado financeiro exige Postgres configurado' });
  const dias = Math.max(2, Math.min(Number.parseInt(req.query.dias, 10) || 90, 180));
  try {
    const { rows } = await pgPool.query(
      `SELECT loja,
              to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
              COUNT(*) FILTER (WHERE lucro_operacional IS NOT NULL) AS pedidos,
              COUNT(*) FILTER (WHERE lucro_operacional IS NULL) AS sem_financeiro,
              COALESCE(SUM(total_value) FILTER (WHERE lucro_operacional IS NOT NULL), 0) AS faturamento,
              COALESCE(SUM(frete), 0) AS frete,
              COALESCE(SUM(descontos), 0) AS descontos,
              COALESCE(SUM(lucro_bruto), 0) AS lucro_bruto,
              COALESCE(SUM(custo_producao), 0) AS custo_producao,
              COALESCE(SUM(lucro_operacional), 0) AS lucro_operacional
       FROM pedidos_ink
       WHERE organization_id = $3
         AND payment_status = ANY($1)
         AND is_troca IS NOT TRUE
         AND criado_em >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($2::int - 1))::timestamp AT TIME ZONE 'America/Sao_Paulo'
       GROUP BY loja, dia
       ORDER BY dia`,
      [Array.from(RESUMO_PAGO), dias, orgDoContexto()]
    );
    const { rows: syncs } = await pgPool.query(
      'SELECT MIN(ultimo_sync_em) AS sincronizado_em FROM sync_estado WHERE organization_id = $1', [orgDoContexto()]
    );

    // Gasto real de mídia por dia, pra o dashboard poder mostrar o lucro DEPOIS da mídia — sem ele,
    // o card de lucro ignora o maior custo variável da operação. Vem da conta de anúncios
    // selecionada e é atribuído à loja que ela atende (meta_ad_accounts.loja_atribuida); sem essa
    // definição, não há a quem atribuir e o gasto fica de fora em vez de ser somado na loja errada.
    //
    // Falha aqui não derruba a tela: o resultado financeiro é o conteúdo principal e já foi
    // calculado acima. Sem mídia o painel volta a mostrar o lucro do produto, que é o que ele
    // mostrava antes desta adição.
    let midia = [];
    // `null` = não foi possível ler o estado da mídia (diferente de "nenhuma conta conectada"): a
    // tela não pode afirmar nem "sem mídia" nem "gasto zero" sem saber.
    let midiaFontes = null;
    let midiaSinalizada = [];
    try {
      // Fonte única (lib/financeiro/midia.js): a mesma do consolidado. Recurso sem loja, ou de
      // outra loja, fica fora — não é somado na loja errada.
      const r = await midiaDaOrganizacao(diaISOBrasil(dias - 1), diaISOBrasil(0));
      midia = r.porDia;
      // Saúde da CONEXÃO (token/API), à parte de "tem conta atribuída": conta da loja com a conexão em
      // erro ou expirada é "com problema", não "gasto zero" nem "tudo bem".
      const { rows: [cm] } = await pgPool.query('SELECT status FROM meta_connections WHERE organization_id = $1', [orgDoContexto()]);
      const { rows: [cg] } = await pgPool.query('SELECT status FROM google_ads_connections WHERE organization_id = $1', [orgDoContexto()]);
      const comProblema = (linha) => !!linha && ['error', 'expired'].includes(linha.status);
      midiaFontes = r.fontes.map((f) => ({
        provider: f.provider, conectado: f.conectado, relevante: f.relevante !== false, motivo: f.motivo || null,
        comProblema: f.conectado && comProblema(f.provider === 'meta' ? cm : cg),
      }));
      midiaSinalizada = r.sinalizados;
    } catch (err) {
      console.error(`[DASHBOARD_FINANCEIRO] gasto de mídia indisponível: ${err.message}`);
    }

    res.json({
      midia: midia.map((m) => ({ loja: m.loja, dia: m.dia, spend: Number(m.spend) })),
      // Estado das fontes de mídia: distingue "não conectada" / "conta sem loja atribuída" de
      // "conectada e sem gasto no período" — que são coisas diferentes para o lucro.
      midiaFontes,
      midiaSinalizada,
      dias,
      sincronizadoEm: syncs[0] && syncs[0].sincronizado_em ? new Date(syncs[0].sincronizado_em).toISOString() : null,
      linhas: rows.map((r) => ({
        loja: r.loja,
        dia: r.dia,
        pedidos: Number(r.pedidos),
        semFinanceiro: Number(r.sem_financeiro),
        faturamento: Number(r.faturamento),
        frete: Number(r.frete),
        descontos: Number(r.descontos),
        lucroBruto: Number(r.lucro_bruto),
        custoProducao: Number(r.custo_producao),
        lucroOperacional: Number(r.lucro_operacional),
      })),
    });
  } catch (err) {
    console.error(`[DASHBOARD_FINANCEIRO] falha ao agregar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível calcular o resultado financeiro' });
  }
});

// ── Central de Pedidos (Fase 3, ver docs/plan.md) ───────────────────────
// Query params suportados pela própria API da Reserva Ink (documentacao-api-ink.yaml,
// GET /v1/stores/orders): payment_status, order_status, begin_date, end_date, page, per_page.
// Não existe busca textual do lado da Ink — por isso não expomos um parâmetro "busca" aqui,
// pra não prometer uma funcionalidade que a API não suporta.
const ORDERS_QUERY_PARAMS = ['payment_status', 'order_status', 'begin_date', 'end_date'];

function buildOrdersQuery(req, extra) {
  const params = new URLSearchParams();
  ORDERS_QUERY_PARAMS.forEach((key) => { if (req.query[key]) params.set(key, req.query[key]); });
  Object.entries(extra || {}).forEach(([k, v]) => params.set(k, v));
  return params.toString();
}

function mapOrderSummary(loja, o, hotpageIdPorPedidoInk) {
  return {
    loja,
    inkOrderId: o.id,
    createdAt: o.created_at,
    cliente: o.buyer ? [o.buyer.first_name, o.buyer.last_name].filter(Boolean).join(' ').trim() || null : null,
    valor: o.total_value != null ? String(o.total_value) : null,
    orderStatus: o.order_status || null,
    orderStatusLabel: o.formatted_order_status || null,
    paymentStatus: o.payment_status || null,
    paymentMethod: o.payment_method || null,
    itemsCount: (o.items || []).length,
    trackingUrl: o.tracking_url || null,
    exchangeable: !!o.exchangeable,
    itemsEditable: !!o.items_editable,
    temPixPendente: !!o.pix,
    hotpageId: hotpageIdPorPedidoInk[`${loja}:${o.id}`] || null,
  };
}

// Ordenação da Central de Pedidos a partir do cache (pedidos_ink). Whitelist: a chave vem do
// cliente e vira nome de coluna no SQL, então nunca é interpolada sem passar por este mapa.
const PEDIDOS_CACHE_SORT = {
  pedido: 'ink_order_id',
  loja: 'loja',
  cliente: 'buyer_nome',
  itens: 'items_count',
  valor: 'total_value',
  pagamento: 'payment_status',
  status: 'order_status',
  criado: 'criado_em',
};
const DATA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// Lista pedidos do cache Postgres com filtros, ordenação e paginação sobre todo o histórico
// sincronizado. Devolve null (quem chama cai pra API da Ink) quando não há Postgres ou quando
// alguma loja pedida ainda não tem nenhum pedido em cache — cache parcial passaria por lista
// completa sem aviso.
async function buscarPedidosNoCache(query) {
  if (!pgPool) return null;
  const escopo = escopoDaStore(2);

  // Cobertura do cache: a Store tem algum pedido sincronizado? Sem isso, uma lista vazia por cache
  // frio passaria por "não há pedidos".
  const { rows: cobertura } = await pgPool.query(
    `SELECT COUNT(*)::int AS total
       FROM pedidos_ink p
      WHERE p.organization_id = $1 AND ${escopo.sql.replace(/store_id|loja/g, (m) => `p.${m}`)}`,
    [orgDoContexto(), ...escopo.params]
  );
  if (!cobertura.length || cobertura[0].total === 0) return null;

  const where = [`organization_id = $1`, escopo.sql];
  const params = [orgDoContexto(), ...escopo.params];
  const paymentStatus = String(query.payment_status || '').trim().slice(0, 60);
  if (paymentStatus) {
    params.push(paymentStatus);
    where.push(`payment_status = $${params.length}`);
  }
  const orderStatus = String(query.order_status || '').trim().slice(0, 60);
  if (orderStatus) {
    params.push(orderStatus);
    where.push(`order_status = $${params.length}`);
  }
  // Datas como dia no fuso da loja (mesma semântica de begin_date/end_date da Ink).
  if (DATA_ISO_RE.test(String(query.begin_date || ''))) {
    params.push(query.begin_date);
    where.push(`criado_em >= ($${params.length}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
  }
  if (DATA_ISO_RE.test(String(query.end_date || ''))) {
    params.push(query.end_date);
    where.push(`criado_em < (($${params.length}::date + 1))::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
  }
  const filtro = where.join(' AND ');

  const sortKey = Object.prototype.hasOwnProperty.call(PEDIDOS_CACHE_SORT, query.sort) ? query.sort : 'criado';
  const direcao = query.order === 'asc' ? 'ASC' : 'DESC';
  const coluna = PEDIDOS_CACHE_SORT[sortKey];

  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const perPage = Math.min(Math.max(1, Number.parseInt(query.per_page, 10) || 20), 100);

  const { rows: contagem } = await pgPool.query(`SELECT COUNT(*) AS total FROM pedidos_ink WHERE ${filtro}`, params);
  const totalCount = Number(contagem[0].total);
  const { rows } = await pgPool.query(
    `SELECT loja, ink_order_id, buyer_nome, total_value, order_status, payment_status, items_count, criado_em
     FROM pedidos_ink WHERE ${filtro}
     ORDER BY ${coluna} ${direcao} NULLS LAST, ink_order_id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, perPage, (page - 1) * perPage]
  );

  const syncs = cobertura.map((c) => c.ultimo_sync_em).filter(Boolean).map((d) => new Date(d).getTime());
  const desdes = cobertura.map((c) => c.desde).filter(Boolean).map((d) => new Date(d).getTime());
  return {
    pedidos: rows.map((r) => ({
      loja: r.loja,
      inkOrderId: Number(r.ink_order_id),
      createdAt: r.criado_em ? new Date(r.criado_em).toISOString() : null,
      cliente: r.buyer_nome,
      valor: r.total_value != null ? String(r.total_value) : null,
      orderStatus: r.order_status,
      orderStatusLabel: null,
      paymentStatus: r.payment_status,
      itemsCount: r.items_count,
    })),
    erros: [],
    approximated: false,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(totalCount / perPage)),
    totalCount,
    fonte: 'cache',
    ordenacao: { sort: sortKey, order: direcao === 'ASC' ? 'asc' : 'desc' },
    // Loja sincronizada há mais tempo (a informação mais desatualizada da lista) e pedido mais
    // antigo em cache (cobertura do histórico).
    cacheSincronizadoEm: syncs.length ? new Date(Math.min(...syncs)).toISOString() : null,
    cacheDesde: desdes.length ? new Date(Math.min(...desdes)).toISOString() : null,
  };
}

// Pedidos da Store do contexto (Fase 3). O modo que agregava todas as lojas saiu (PD-022).
app.get('/api/admin/pedidos/central', requireAdmin, async (req, res) => {
  // A identidade é a Store. A chave legada segue disponível só para rotular a linha no formato
  // antigo que a tela e o cache local ainda usam — nunca para escopo.
  const loja = lojaLegadaDoContextoOuNula();

  let localPedidos;
  try {
    localPedidos = await readPedidos();
  } catch (err) {
    console.error(`[PEDIDOS_CENTRAL] falha ao ler pedidos locais: ${err.message}`);
    return res.status(500).json({ error: 'não foi possível ler os pedidos locais' });
  }
  const hotpageIdPorPedidoInk = {};
  Object.entries(localPedidos).forEach(([id, p]) => {
    if (p.origem === 'ink') hotpageIdPorPedidoInk[`${p.loja}:${p.inkOrderId}`] = id;
  });

  // Fonte padrão: cache Postgres (ordenação e paginação sobre todo o histórico). `fonte=ink` é o
  // escape pra ver o estado ao vivo; falha no cache também cai pra Ink, sem quebrar a tela.
  if (req.query.fonte !== 'ink') {
    try {
      const doCache = await buscarPedidosNoCache(req.query);
      if (doCache) return res.json(doCache);
    } catch (err) {
      console.error(`[PEDIDOS_CENTRAL] busca no cache falhou, caindo pra Ink: ${err.message}`);
    }
  }

  const page = Number.parseInt(req.query.page, 10) || 1;
  const perPage = Math.min(Number.parseInt(req.query.per_page, 10) || 20, 100);
  const query = buildOrdersQuery(req, { page: String(page), per_page: String(perPage) });
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/orders?${query}`);
    const pedidos = (data.orders || []).map((o) => mapOrderSummary(loja, o, hotpageIdPorPedidoInk));
    res.json({
      pedidos,
      erros: [],
      approximated: false,
      page: data.page || page,
      perPage: data.per_page || perPage,
      totalPages: data.total_pages || 1,
      totalCount: data.total_count || pedidos.length,
      fonte: 'ink',
    });
  } catch (err) {
    console.error(`[PEDIDOS_CENTRAL] falha ao listar pedidos da loja ${loja}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar os pedidos' });
  }
});

// Histórico de webhooks recebidos pra 1 pedido — usado na aba Timeline do drawer. Só existe
// com Postgres configurado (webhook_eventos); sem ele, cai pro log JSON local (últimos 200,
// filtrado em memória — mesma limitação que o log já tem hoje em qualquer outra tela).
async function getWebhookHistoryForOrder(inkOrderId) {
  if (pgPool) {
    const { rows } = await pgPool.query(
      `SELECT recebido_em, event_name FROM webhook_eventos
       WHERE organization_id = $1 AND ink_order_id = $2 AND ${escopoDaStore(3).sql}
       ORDER BY recebido_em DESC LIMIT 20`,
      [orgDoContexto(), inkOrderId, ...escopoDaStore(3).params]
    );
    return rows.map((r) => ({ em: r.recebido_em, evento: r.event_name }));
  }
  let log = [];
  try { log = JSON.parse(fs.readFileSync(WEBHOOK_LOG_FILE, 'utf8')); } catch { log = []; }
  return log
    // Arquivo local do modo sem Postgres: uma instalação, uma loja. Filtra pelo pedido.
    .filter((e) => e.inkOrderId === inkOrderId)
    .slice(0, 20)
    .map((e) => ({ em: e.recebidoEm, evento: e.eventName }));
}

app.get('/api/admin/pedidos/central/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula();
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/orders/${id}`);
    const timeline = await getWebhookHistoryForOrder(Number(id));
    res.json({ loja, order: data.order, timeline });
  } catch (err) {
    console.error(`[PEDIDOS_CENTRAL] falha ao buscar pedido ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar o pedido' });
  }
});

// ── Trocas (Fase 4, ver docs/plan.md) ───────────────────────────────────
// Sem aprovação via API: a Ink decide `status`/`support_review_status` do lado dela. Este
// admin só cria e acompanha (GET/POST), nunca aprova/recusa — não existe PATCH documentado
// em /v1/stores/exchanges.
const EXCHANGE_REASONS = ['larger_size', 'smaller_size', 'change_color', 'change_print', 'incorrect_print_position', 'defect_in_product', 'print_quality', 'other'];
const EXCHANGE_REASONS_SUPPORT = ['defect_in_product', 'incorrect_print_position', 'print_quality'];

function mapExchangeSummary(loja, e) {
  return {
    loja,
    id: e.id,
    exchangeType: e.exchange_type || null,
    status: e.status || null,
    supportReviewStatus: e.support_review_status || null,
    isCourtesy: !!e.is_courtesy_exchange,
    exchangeReason: e.exchange_reason || null,
    exchangeReasonLabel: e.exchange_reason_label || e.exchange_reason || null,
    oldOrderId: (e.old_order && e.old_order.id) || (e.old_external_order && e.old_external_order.id) || null,
    newOrderId: (e.new_order && e.new_order.id) || (e.new_external_order && e.new_external_order.id) || null,
    createdAt: e.created_at || null,
  };
}

const EXCHANGES_QUERY_PARAMS = ['order_id', 'external_order_id', 'begin_date', 'end_date', 'waiting_for_approval'];

app.get('/api/admin/trocas', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula();

  const baseParams = new URLSearchParams();
  EXCHANGES_QUERY_PARAMS.forEach((key) => { if (req.query[key]) baseParams.set(key, req.query[key]); });

  const page = Number.parseInt(req.query.page, 10) || 1;
  const perPage = Math.min(Number.parseInt(req.query.per_page, 10) || 20, 100);
  const query = new URLSearchParams(baseParams);
  query.set('page', String(page));
  query.set('per_page', String(perPage));
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/exchanges?${query.toString()}`);
    const trocas = (data.exchanges || []).map((e) => mapExchangeSummary(loja, e));
    res.json({
      trocas,
      erros: [],
      approximated: false,
      page: data.page || page,
      perPage: data.per_page || perPage,
      totalPages: data.total_pages || 1,
      totalCount: data.total_count || trocas.length,
    });
  } catch (err) {
    console.error(`[TROCAS] falha ao listar trocas da loja ${loja}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar as trocas' });
  }
});

app.get('/api/admin/trocas/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula();
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/exchanges/${id}`);
    res.json({ loja, exchange: data.exchange });
  } catch (err) {
    console.error(`[TROCAS] falha ao buscar troca ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar a troca' });
  }
});

// Cria uma troca. Espelha as regras documentadas em POST /v1/stores/exchanges: motivos que
// exigem revisão do suporte (defeito/posição/qualidade de impressão) precisam de descrição do
// problema + pelo menos 1 foto. `Idempotency-Key` é gerada aqui — o cliente não escolhe, pra
// nunca duplicar uma troca por duplo clique/retry de rede.
app.post('/api/admin/trocas', requireAdmin, async (req, res) => {
  const { original_order_id: originalOrderId, exchange_reason: exchangeReason, problem_description: problemDescription, items, photos } = req.body || {};
  const loja = lojaLegadaDoContextoOuNula();
  if (!Number.isInteger(originalOrderId) || originalOrderId <= 0) return res.status(400).json({ error: 'original_order_id inválido' });
  if (!EXCHANGE_REASONS.includes(exchangeReason)) return res.status(400).json({ error: 'exchange_reason inválido' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'informe ao menos 1 item' });
  for (const item of items) {
    if (!Number.isInteger(item.old_item_id) || !Number.isInteger(item.product_v2_id) || !Number.isInteger(item.product_variant_id) || !Number.isInteger(item.quantity) || item.quantity < 1) {
      return res.status(400).json({ error: 'cada item precisa de old_item_id, product_v2_id, product_variant_id e quantity (inteiro >= 1)' });
    }
  }

  const exigeSuporte = EXCHANGE_REASONS_SUPPORT.includes(exchangeReason);
  if (exigeSuporte) {
    if (!problemDescription || !problemDescription.trim()) {
      return res.status(400).json({ error: 'esse motivo exige descrição do problema' });
    }
    if (!Array.isArray(photos) || !photos.length) {
      return res.status(400).json({ error: 'esse motivo exige pelo menos 1 foto' });
    }
  }

  const body = {
    original_order_id: originalOrderId,
    exchange_reason: exchangeReason,
    items: items.map((i) => ({
      old_item_id: i.old_item_id,
      product_v2_id: i.product_v2_id,
      product_variant_id: i.product_variant_id,
      quantity: i.quantity,
    })),
  };
  if (problemDescription) body.problem_description = problemDescription.trim().slice(0, 1000);
  if (Array.isArray(photos) && photos.length) {
    body.photos = photos.map((p) => (p.photo_url ? { photo_url: p.photo_url } : { photo_attachment: p.photo_attachment }));
  }

  try {
    const data = await inkApiPostDaStore('/v1/stores/exchanges', body, { 'Idempotency-Key': crypto.randomUUID() });
    res.status(201).json({ loja, exchange: data.exchange });
  } catch (err) {
    console.error(`[TROCAS] falha ao criar troca (${loja}, pedido ${originalOrderId}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível criar a troca', details: err.details });
  }
});

// ── Reembolsos (Fase 5, ver docs/plan.md) ───────────────────────────────
// A Ink não expõe listagem global de reembolso — só por pedido. "Reembolsos" aqui é sempre
// "feitos por este painel" (audit_log), nunca uma cópia completa do lado da Ink. O detalhe por
// pedido (GET /v1/stores/orders/{id}/refunds) é confiável porque é escopado a 1 pedido — usado
// na aba Reembolsos do drawer de Pedidos.
app.get('/api/admin/reembolsos', requireAdmin, async (req, res) => {
  try {
    const registros = await listarAuditLog('refund.create', 100);
    res.json({ reembolsos: registros });
  } catch (err) {
    console.error(`[REEMBOLSOS] falha ao listar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar os reembolsos' });
  }
});

app.get('/api/admin/pedidos/central/:id/reembolsos', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula();
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/orders/${id}/refunds`);
    res.json({ loja, refunds: data.refunds || [] });
  } catch (err) {
    console.error(`[REEMBOLSOS] falha ao listar reembolsos do pedido ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar os reembolsos desse pedido' });
  }
});

// Reembolsa um pedido (parcial ou total). "Total" é decidido aqui, não pelo cliente: só é total
// quando `refunded_items` cobre a quantidade cheia de TODOS os itens do pedido — exige o campo
// `confirmadoTotal: true` explícito no corpo (checkbox de confirmação na UI, spec §32/§72).
app.post('/api/admin/pedidos/:id/reembolsos', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula();
  const { reason, refundedItems, confirmadoTotal } = req.body || {};

  if (typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ error: 'informe o motivo do reembolso' });
  if (!Array.isArray(refundedItems) || !refundedItems.length) return res.status(400).json({ error: 'selecione ao menos 1 item para reembolsar' });
  for (const item of refundedItems) {
    if (!Number.isInteger(item.order_item_id) || !Number.isInteger(item.requested_quantity) || item.requested_quantity < 1) {
      return res.status(400).json({ error: 'cada item precisa de order_item_id e requested_quantity (inteiro >= 1)' });
    }
  }

  let order;
  try {
    const orderData = await inkApiRequestDaStore(`/v1/stores/orders/${id}`);
    order = orderData.order;
  } catch (err) {
    console.error(`[REEMBOLSOS] falha ao buscar pedido ${loja}/${id} antes de reembolsar: ${err.message}`);
    return res.status(err.status || 500).json({ error: 'não foi possível buscar o pedido antes de reembolsar' });
  }
  if (!order) return res.status(404).json({ error: 'pedido não encontrado na Reserva Ink' });

  const isTotal = (order.items || []).length > 0 && (order.items || []).every((oi) => {
    const match = refundedItems.find((ri) => ri.order_item_id === oi.id);
    return match && match.requested_quantity >= oi.quantity;
  });
  if (isTotal && confirmadoTotal !== true) {
    return res.status(400).json({ error: 'esse reembolso cobre o pedido inteiro — confirme explicitamente antes de prosseguir', requiresTotalConfirmation: true });
  }

  const body = {
    reason: reason.trim(),
    refunded_items: refundedItems.map((i) => ({ order_item_id: i.order_item_id, requested_quantity: i.requested_quantity })),
  };

  try {
    const data = await inkApiPostDaStore(`/v1/stores/orders/${id}/refunds`, body, { 'Idempotency-Key': crypto.randomUUID() });
    await registrarAuditLog({
      actorUserId: req.auth.userId,
      action: 'refund.create',
      entityType: 'order',
      entityId: `${loja || storeDoContexto()}:${id}`,
      loja,
      before: {
        paymentStatus: order.payment_status, orderStatus: order.order_status, totalValue: order.total_value,
        isTotal, reason: reason.trim(), refundedItems: body.refunded_items,
        cliente: order.buyer ? [order.buyer.first_name, order.buyer.last_name].filter(Boolean).join(' ').trim() || null : null,
      },
      after: data,
    });
    res.json({ loja, isTotal, result: data });
  } catch (err) {
    console.error(`[REEMBOLSOS] falha ao reembolsar pedido ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível reembolsar esse pedido', details: err.details });
  }
});

// ── Catálogo — Produtos (Fase 8.1, ver docs/plan.md) ────────────────────
// Limite real da API: produtos NÃO têm DELETE documentado — nunca oferecer exclusão, só
// ocultar (`visible_in_store: false` via PATCH). `arts` exige `base_image_id`, que vem de
// GET /v1/stores/product_types (printable_areas) — por isso o wizard depende desse endpoint
// antes de deixar escolher arte.
function mapProdutoSummary(loja, p) {
  return {
    loja,
    id: p.id,
    name: p.name,
    mainImageUrl: p.main_image_url,
    price: p.price,
    promotionalPrice: p.promotional_price,
    visibleInStore: p.visible_in_store,
    approvalStatus: p.approval_status,
    status: p.status,
    productType: p.product_type ? p.product_type.name : null,
    variantsCount: (p.product_variants || []).length,
    productClusterId: p.product_cluster_id,
    updatedAt: p.updated_at,
  };
}

const PRODUTOS_QUERY_PARAMS = ['visible_in_store', 'approval_status', 'begin_date', 'end_date'];
const PRODUTOS_BUSCA_MAX_PAGINAS = 50;

// GET /v1/stores/products não documenta filtro por nome nem por tipo (ver
// documentacao-api-ink.yaml) — a Ink ignora silenciosamente esses params na query. Pra filtrar de
// verdade, busca todas as páginas (respeitando os outros filtros) e filtra aqui. `truncado` avisa
// quando o teto de páginas cortou o catálogo antes do fim (resultado parcial).
async function fetchTodosProdutosLojaComInfo(loja, baseParams) {
  const produtos = [];
  let page = 1;
  let totalPages = 1;
  let truncado = false;
  do {
    const query = new URLSearchParams(baseParams);
    query.set('page', String(page));
    query.set('per_page', '100');
    const data = await inkApiRequestDaStore(`/v1/stores/products?${query.toString()}`);
    produtos.push(...(data.products || []));
    truncado = (data.total_pages || 1) > PRODUTOS_BUSCA_MAX_PAGINAS;
    totalPages = Math.min(data.total_pages || 1, PRODUTOS_BUSCA_MAX_PAGINAS);
    page += 1;
  } while (page <= totalPages);
  return { produtos, truncado };
}

async function fetchTodosProdutosLoja(loja, baseParams) {
  return (await fetchTodosProdutosLojaComInfo(loja, baseParams)).produtos;
}

// Filtros aplicados localmente (name + product_type_id). Retorna null quando nenhum veio — aí dá
// pra usar a paginação nativa da Ink em vez de varrer o catálogo.
function montarFiltroLocalProdutos(fonte) {
  const nomeBusca = String((fonte && fonte.name) || '').trim().toLowerCase();
  const tipoId = Number.parseInt(fonte && fonte.product_type_id, 10);
  const temTipo = Number.isInteger(tipoId) && tipoId > 0;
  if (!nomeBusca && !temTipo) return null;
  return (p) => (!nomeBusca || String(p.name || '').toLowerCase().includes(nomeBusca))
    && (!temTipo || (p.product_type && p.product_type.id === tipoId));
}

app.get('/api/admin/produtos', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa

  const baseParams = new URLSearchParams();
  PRODUTOS_QUERY_PARAMS.forEach((key) => { if (req.query[key] !== undefined) baseParams.set(key, req.query[key]); });
  const filtroLocal = montarFiltroLocalProdutos(req.query);

  // Ordem das fontes (a primeira que cobrir o caso responde):
  //   1. produtos_ink — cache do catálogo COMPLETO. Responde qualquer filtro, incluindo oculto e
  //      não aprovado, e sem o truncamento de PRODUTOS_BUSCA_MAX_PAGINAS. É o caminho normal
  //      depois do primeiro sync (card de Integrações ou job periódico).
  //   2. produtos_feed — cache do CSV, só produto ativo e só busca por nome/tipo. Fica como rede
  //      antes do cache do catálogo existir na loja.
  //   3. API da Ink ao vivo.
  // `fonte=ink` pula direto pra 3: é o link de escape da tela de Produtos (ver dado recém-criado
  // sem esperar o próximo sync) e o que o preview/job de categorias usa do lado do servidor.
  if (req.query.fonte !== 'ink') {
    try {
      const doCatalogo = await buscarProdutosNoCatalogo(loja, req.query);
      if (doCatalogo) return res.json(doCatalogo);
    } catch (err) {
      console.error(`[PRODUTOS_CACHE] busca no cache do catálogo falhou, tentando as outras fontes: ${err.message}`);
    }
    // O feed CSV é caminho legado descontinuado: só existe para Store com chave legada.
    if (loja && filtroLocal && podeUsarCacheDeProdutos(req.query)) {
      try {
        const doCache = await buscarProdutosNoCache(loja, req.query);
        if (doCache) return res.json(doCache);
      } catch (err) {
        console.error(`[PRODUTOS_FEED] busca pelo cache falhou, caindo pra Ink: ${err.message}`);
      }
    }
  }

  const page = Number.parseInt(req.query.page, 10) || 1;
  const perPage = Math.min(Number.parseInt(req.query.per_page, 10) || 20, 100);

  if (filtroLocal) {
    try {
      const { produtos: todos, truncado } = await fetchTodosProdutosLojaComInfo(loja, baseParams);
      const filtrados = todos.filter(filtroLocal);
      const totalCount = filtrados.length;
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      const produtos = filtrados.slice((page - 1) * perPage, page * perPage).map((p) => mapProdutoSummary(loja, p));
      return res.json({ produtos, erros: [], approximated: false, truncado, page, perPage, totalPages, totalCount });
    } catch (err) {
      console.error(`[PRODUTOS] falha ao buscar produtos com filtro local na loja ${loja}: ${err.message}`);
      return res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar os produtos' });
    }
  }

  const query = new URLSearchParams(baseParams);
  query.set('page', String(page));
  query.set('per_page', String(perPage));
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/products?${query.toString()}`);
    const produtos = (data.products || []).map((p) => mapProdutoSummary(loja, p));
    res.json({
      produtos, erros: [], approximated: false,
      page: data.page || page, perPage: data.per_page || perPage,
      totalPages: data.total_pages || 1, totalCount: data.total_count || produtos.length,
    });
  } catch (err) {
    console.error(`[PRODUTOS] falha ao listar produtos da loja ${loja}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar os produtos' });
  }
});

// ── Cache local do catálogo ativo (feed CSV da Ink) ─────────────────────
// A Ink gera, pro catálogo do Facebook/Meta, um CSV público com todos os produtos PUBLICADOS da
// loja. São ~10 mil linhas em 1 request, contra ~850 páginas de /v1/stores/products (85 mil
// produtos, 100 por página) — a varredura pela API é inviável e hoje nem completa: a Ink ignora
// filtro de nome/tipo na query (ver montarFiltroLocalProdutos) e o teto de
// PRODUTOS_BUSCA_MAX_PAGINAS corta o catálogo, devolvendo `truncado`.
//
// LIMITES do feed — por isso ele NUNCA substitui a API:
//   - só produto publicado/ativo aparece (oculto como "controle-estoque" e desativado ficam fora);
//   - não traz approval_status, visible_in_store, variantes, product_cluster_id nem updated_at.
// A URL é da Store (o número no fim identifica a loja) — Fase 4: fica em integration_secrets da
// Organization (integração 'ink', segredo 'feed_url'), nunca em env global nem commitada.
const PRODUTOS_FEED_INTERVAL_MS = 12 * 60 * 60 * 1000;
const PRODUTOS_FEED_LOTE = 500;
const PRODUTOS_FEED_TIMEOUT_MS = 5 * 60 * 1000;
const feedEmSincronizacao = new Set();

// Lê um CSV (RFC 4180: aspas duplas, "" como escape, quebra de linha dentro de campo) direto do
// stream da resposta, sem carregar os 27 MB em memória. Entrega linha a linha pro callback, que
// pode ser async (grava em lote no Postgres) — por isso as linhas prontas de cada chunk são
// processadas depois do chunk, e não caractere a caractere.
async function lerCsvStream(stream, onLinha) {
  const decoder = new TextDecoder('utf-8');
  let campo = '';
  let linha = [];
  let dentroAspas = false;
  let aspaPendente = false; // último caractere foi " dentro de aspas: pode ser escape ("") ou fim

  const processar = async (texto) => {
    const prontas = [];
    for (const c of texto) {
      if (aspaPendente) {
        aspaPendente = false;
        if (c === '"') { campo += '"'; continue; }
        dentroAspas = false;
      }
      if (dentroAspas) {
        if (c === '"') aspaPendente = true;
        else campo += c;
        continue;
      }
      if (c === '"') { dentroAspas = true; continue; }
      if (c === ',') { linha.push(campo); campo = ''; continue; }
      if (c === '\n') { linha.push(campo); prontas.push(linha); linha = []; campo = ''; continue; }
      if (c !== '\r') campo += c;
    }
    for (const pronta of prontas) await onLinha(pronta);
  };

  for await (const chunk of stream) {
    await processar(decoder.decode(chunk, { stream: true }));
  }
  await processar(decoder.decode());
  if (campo !== '' || linha.length) {
    linha.push(campo);
    await onLinha(linha);
  }
}

// "109.90 BRL" -> 109.90; vazio -> null.
function precoDoFeed(valor) {
  const n = Number.parseFloat(String(valor || '').trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

// O feed manda o título como "<tipo> - <nome>" ("Camiseta - Curitiba | Origem PR"), mas no painel
// da Ink o nome do produto é só a segunda parte.
function nomeSemTipo(titulo, tipo) {
  const t = String(titulo || '');
  const prefixo = tipo ? `${tipo} - ` : '';
  return prefixo && t.startsWith(prefixo) ? t.slice(prefixo.length).trim() : t.trim();
}

async function gravarLoteFeed(loja, registros, sincronizadoEm) {
  if (!registros.length) return;
  const col = (campo) => registros.map((r) => r[campo]);
  await pgPool.query(
    `INSERT INTO produtos_feed (loja, produto_id, titulo, nome, tipo, categorias, tags, preco,
       preco_promocional, disponibilidade, link, imagem_url, cores, tamanhos, sincronizado_em)
     SELECT $1, x.produto_id, x.titulo, x.nome, x.tipo, x.categorias, x.tags, x.preco,
       x.preco_promocional, x.disponibilidade, x.link, x.imagem_url, x.cores, x.tamanhos, $2
     FROM unnest($3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
       $9::numeric[], $10::numeric[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[])
       AS x(produto_id, titulo, nome, tipo, categorias, tags, preco, preco_promocional,
            disponibilidade, link, imagem_url, cores, tamanhos)
     ON CONFLICT (organization_id, loja, produto_id) DO UPDATE SET
       titulo = EXCLUDED.titulo, nome = EXCLUDED.nome, tipo = EXCLUDED.tipo,
       categorias = EXCLUDED.categorias, tags = EXCLUDED.tags, preco = EXCLUDED.preco,
       preco_promocional = EXCLUDED.preco_promocional, disponibilidade = EXCLUDED.disponibilidade,
       link = EXCLUDED.link, imagem_url = EXCLUDED.imagem_url, cores = EXCLUDED.cores,
       tamanhos = EXCLUDED.tamanhos, sincronizado_em = EXCLUDED.sincronizado_em`,
    [loja, sincronizadoEm, col('produtoId'), col('titulo'), col('nome'), col('tipo'), col('categorias'),
      col('tags'), col('preco'), col('precoPromocional'), col('disponibilidade'), col('link'),
      col('imagemUrl'), col('cores'), col('tamanhos')]
  );
}

async function feedInkConfigurado() {
  return !!INTEGRACOES && INTEGRACOES.temSegredo('ink', 'feed_url');
}

async function sincronizarProdutosFeed(loja) {
  if (!pgPool) return { pulado: 'sem Postgres configurado' };
  if (lojaLegadaDoContexto() !== loja) return { pulado: 'loja fora do contexto da organization' };
  if (!(await feedInkConfigurado())) return { pulado: 'sem URL do feed configurada pra esta loja' };
  if (feedEmSincronizacao.has(loja)) return { pulado: 'sincronização já em andamento' };
  feedEmSincronizacao.add(loja);

  const inicio = new Date();
  try {
    await pgPool.query(
      `INSERT INTO produtos_feed_sync (loja, iniciado_em, erro) VALUES ($1, $2, NULL)
       ON CONFLICT (organization_id, loja) DO UPDATE SET iniciado_em = EXCLUDED.iniciado_em, erro = NULL`,
      [loja, inicio]
    );

    const res = await INTEGRACOES.usarSegredo('ink', 'feed_url',
      (url) => fetch(url, { signal: AbortSignal.timeout(PRODUTOS_FEED_TIMEOUT_MS) }));
    if (!res.ok) throw new Error(`feed respondeu ${res.status}`);

    let indices = null;
    let lote = [];
    let total = 0;
    let ignorados = 0;

    await lerCsvStream(res.body, async (colunas) => {
      if (!indices) {
        indices = {};
        colunas.forEach((nomeColuna, i) => { indices[String(nomeColuna).trim()] = i; });
        if (indices.id == null || indices.title == null) throw new Error('CSV do feed sem as colunas id/title');
        return;
      }
      // O feed mistura produto (id numérico) com KIT (id "kit_618", URL /kit/<uuid>) — kit não é
      // produto, não existe em /v1/stores/products e ainda usa custom_label_1 pra listar os ids dos
      // produtos que o compõem (não categorias). Fica de fora do cache de propósito; o contador
      // existe pra isso aparecer no log em vez de sumir em silêncio.
      const produtoId = Number.parseInt(colunas[indices.id], 10);
      if (!Number.isInteger(produtoId)) { ignorados += 1; return; }
      const tipo = indices.custom_label_0 != null ? (colunas[indices.custom_label_0] || null) : null;
      const titulo = colunas[indices.title] || null;
      lote.push({
        produtoId,
        titulo,
        nome: nomeSemTipo(titulo, tipo),
        tipo,
        categorias: indices.custom_label_1 != null ? colunas[indices.custom_label_1] || null : null,
        tags: indices.custom_label_2 != null ? colunas[indices.custom_label_2] || null : null,
        preco: indices.price != null ? precoDoFeed(colunas[indices.price]) : null,
        precoPromocional: indices.sale_price != null ? precoDoFeed(colunas[indices.sale_price]) : null,
        disponibilidade: indices.availability != null ? colunas[indices.availability] || null : null,
        link: indices.link != null ? colunas[indices.link] || null : null,
        imagemUrl: indices.image_link != null ? colunas[indices.image_link] || null : null,
        cores: indices.color != null ? colunas[indices.color] || null : null,
        tamanhos: indices.size != null ? colunas[indices.size] || null : null,
      });
      total += 1;
      if (lote.length >= PRODUTOS_FEED_LOTE) {
        await gravarLoteFeed(loja, lote, inicio);
        lote = [];
      }
    });
    await gravarLoteFeed(loja, lote, inicio);

    // Feed vazio quase sempre significa feed quebrado, não loja sem produto — nesse caso mantém o
    // cache anterior em vez de apagar tudo (a limpeza abaixo é o que remove produto desativado).
    if (total === 0) throw new Error('feed veio sem nenhum produto');
    const { rowCount: removidos } = await pgPool.query(
      'DELETE FROM produtos_feed WHERE loja = $1 AND sincronizado_em < $2',
      [loja, inicio]
    );

    await pgPool.query(
      `UPDATE produtos_feed_sync SET concluido_em = now(), total = $2, erro = NULL WHERE loja = $1`,
      [loja, total]
    );
    console.log(`[PRODUTOS_FEED] ${loja}: ${total} produto(s) ativos no cache, ${removidos} removido(s)${ignorados ? `, ${ignorados} linha(s) de kit ignorada(s)` : ''}`);
    return { total, removidos, ignorados };
  } catch (err) {
    console.error(`[PRODUTOS_FEED] falha ao sincronizar a loja ${loja}: ${err.message}`);
    await pgPool.query(
      `INSERT INTO produtos_feed_sync (loja, iniciado_em, erro) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, loja) DO UPDATE SET erro = EXCLUDED.erro`,
      [loja, inicio, String(err.message).slice(0, 500)]
    ).catch(() => {});
    throw err;
  } finally {
    feedEmSincronizacao.delete(loja);
  }
}

async function sincronizarProdutosFeedDaOrganizacao({ apenasVencidos = false } = {}) {
  if (!pgPool) return;
  const ctx = contextoAtual();
  for (const loja of ctx && ctx.loja ? [ctx.loja] : []) {
    if (!(await feedInkConfigurado())) continue;
    if (apenasVencidos) {
      const { rows } = await pgPool.query('SELECT concluido_em FROM produtos_feed_sync WHERE loja = $1', [loja]);
      const ultimo = rows[0] && rows[0].concluido_em;
      if (ultimo && Date.now() - new Date(ultimo).getTime() < PRODUTOS_FEED_INTERVAL_MS) continue;
    }
    try {
      await sincronizarProdutosFeed(loja);
    } catch { /* já logado e gravado em produtos_feed_sync */ }
  }
}

// ── Cache do catálogo completo (varredura de GET /v1/stores/products) ───
// O feed CSV acima resolve busca por nome de produto ATIVO e nada mais. Este cache é o espelho do
// catálogo inteiro: varre a API página a página e grava tudo — inclusive desativado, oculto e não
// aprovado —, com os campos que o feed não expõe. Depois de populado, ele é a fonte da tela de
// Produtos pra QUALQUER combinação de filtro, e a Ink só é consultada sob demanda (`fonte=ink`)
// ou quando o cache ainda está vazio.
//
// Custo: ~850 requests por loja (85 mil produtos, 100 por página). Por isso o crawl NUNCA roda
// dentro de um request do painel — é disparado em segundo plano pelo card de Integrações ou pelo
// job periódico, e grava progresso a cada página pra tela mostrar avanço real.
const PRODUTOS_CACHE_INTERVALO_PADRAO_HORAS = 6;
// Whitelist do intervalo configurável no card de Integrações — valor fora dela é rejeitado.
const PRODUTOS_CACHE_INTERVALOS_HORAS = [6, 12, 24, 48, 72, 168];
const PRODUTOS_CACHE_PER_PAGE = 100;
// Rede de segurança contra loop infinito se a Ink devolver total_pages estranho — não é o teto de
// busca interativa (PRODUTOS_BUSCA_MAX_PAGINAS = 50), que é justamente o que trunca o catálogo
// hoje. 2000 páginas = 200 mil produtos, bem acima do catálogo real.
const PRODUTOS_CACHE_MAX_PAGINAS = 2000;
const catalogoEmSincronizacao = new Set();

// Number(null) é 0 e Number('') também — testar só com Number.isFinite gravaria preço 0 pra
// produto sem preço promocional, que a tela mostraria como R$ 0,00 em vez de "—".
function numeroOuNull(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

// Escreve o cache do catálogo da Store do contexto. Identidade canônica: `store_id` (a unicidade é
// `uq_produtos_ink_store`, parcial em store_id); `loja` só espelha a chave histórica (NULA na Store
// nativa) e o índice legado por `loja` continua para as releases já publicadas.
async function gravarLoteCatalogo(produtos, sincronizadoEm) {
  if (!produtos.length) return;
  const storeId = storeDoContexto();
  const loja = lojaLegadaDoContextoOuNula();
  const linhas = produtos.map((p) => ({
    id: p.id,
    name: p.name ?? null,
    mainImageUrl: p.main_image_url ?? null,
    price: numeroOuNull(p.price),
    promotionalPrice: numeroOuNull(p.promotional_price),
    visibleInStore: typeof p.visible_in_store === 'boolean' ? p.visible_in_store : null,
    approvalStatus: p.approval_status ?? null,
    status: p.status ?? null,
    productTypeId: p.product_type ? numeroOuNull(p.product_type.id) : null,
    productTypeName: p.product_type ? p.product_type.name ?? null : null,
    variantsCount: (p.product_variants || []).length,
    productClusterId: numeroOuNull(p.product_cluster_id),
    updatedAt: p.updated_at || null,
  }));
  const col = (campo) => linhas.map((r) => r[campo]);
  await pgPool.query(
    `INSERT INTO produtos_ink (store_id, loja, produto_id, name, main_image_url, price, promotional_price,
       visible_in_store, approval_status, status, product_type_id, product_type_name,
       variants_count, product_cluster_id, updated_at, sincronizado_em)
     SELECT $16::uuid, $1, x.produto_id, x.name, x.main_image_url, x.price, x.promotional_price,
       x.visible_in_store, x.approval_status, x.status, x.product_type_id, x.product_type_name,
       x.variants_count, x.product_cluster_id, x.updated_at, $2
     FROM unnest($3::bigint[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::boolean[],
       $9::text[], $10::text[], $11::bigint[], $12::text[], $13::integer[], $14::bigint[],
       $15::timestamptz[])
       AS x(produto_id, name, main_image_url, price, promotional_price, visible_in_store,
            approval_status, status, product_type_id, product_type_name, variants_count,
            product_cluster_id, updated_at)
     ON CONFLICT (organization_id, store_id, produto_id) WHERE store_id IS NOT NULL DO UPDATE SET
       loja = EXCLUDED.loja, name = EXCLUDED.name, main_image_url = EXCLUDED.main_image_url, price = EXCLUDED.price,
       promotional_price = EXCLUDED.promotional_price, visible_in_store = EXCLUDED.visible_in_store,
       approval_status = EXCLUDED.approval_status, status = EXCLUDED.status,
       product_type_id = EXCLUDED.product_type_id, product_type_name = EXCLUDED.product_type_name,
       variants_count = EXCLUDED.variants_count, product_cluster_id = EXCLUDED.product_cluster_id,
       updated_at = EXCLUDED.updated_at, sincronizado_em = EXCLUDED.sincronizado_em`,
    [loja, sincronizadoEm, col('id'), col('name'), col('mainImageUrl'), col('price'),
      col('promotionalPrice'), col('visibleInStore'), col('approvalStatus'), col('status'),
      col('productTypeId'), col('productTypeName'), col('variantsCount'), col('productClusterId'),
      col('updatedAt'), storeId]
  );
}

// Sincroniza o cache do catálogo da Store do contexto. A identidade é `store_id`; nada aqui exige a
// chave legada. Linha ÓRFÃ de uma Store com chave legada (sem `store_id`) é reivindicada por
// mapeamento explícito antes de escrever — o mesmo que o backfill da 0026 faz.
async function sincronizarCatalogoInk() {
  if (!pgPool) return { pulado: 'sem Postgres configurado' };
  if (!(await inkConectada())) return { pulado: 'esta organization não tem token INK configurado' };
  const storeId = storeDoContexto();
  const loja = lojaLegadaDoContextoOuNula();
  if (catalogoEmSincronizacao.has(storeId)) return { pulado: 'sincronização já em andamento' };
  catalogoEmSincronizacao.add(storeId);

  const inicio = new Date();
  try {
    if (loja) {
      await pgPool.query('UPDATE produtos_ink SET store_id = $2 WHERE organization_id = $1 AND store_id IS NULL AND loja = $3', [orgDoContexto(), storeId, loja]);
      await pgPool.query('UPDATE produtos_ink_sync SET store_id = $2 WHERE organization_id = $1 AND store_id IS NULL AND loja = $3', [orgDoContexto(), storeId, loja]);
    }
    await pgPool.query(
      `INSERT INTO produtos_ink_sync (store_id, loja, iniciado_em, concluido_em, processados, paginas, truncado, erro)
       VALUES ($1, $3, $2, NULL, 0, 0, false, NULL)
       ON CONFLICT (organization_id, store_id) WHERE store_id IS NOT NULL DO UPDATE SET iniciado_em = EXCLUDED.iniciado_em, concluido_em = NULL,
         processados = 0, paginas = 0, truncado = false, erro = NULL`,
      [storeId, inicio, loja]
    );

    let page = 1;
    let totalPages = 1;
    let truncado = false;
    let processados = 0;

    do {
      const query = new URLSearchParams({ page: String(page), per_page: String(PRODUTOS_CACHE_PER_PAGE) });
      // Retry só nos transitórios (429/5xx/rede): uma varredura de centenas de páginas quase
      // sempre esbarra em um soluço, e abortar o crawl inteiro por causa disso desperdiçaria todo
      // o trabalho já feito.
      const data = await comRetryInk(() => inkApiRequestDaStore(`/v1/stores/products?${query.toString()}`));
      const produtosPagina = data.products || [];
      await gravarLoteCatalogo(produtosPagina, inicio);
      processados += produtosPagina.length;

      const paginasReais = data.total_pages || 1;
      truncado = paginasReais > PRODUTOS_CACHE_MAX_PAGINAS;
      totalPages = Math.min(paginasReais, PRODUTOS_CACHE_MAX_PAGINAS);

      await pgPool.query(
        `UPDATE produtos_ink_sync SET processados = $2, paginas = $3, total_estimado = $4, truncado = $5 WHERE organization_id = $6 AND store_id = $1`,
        [storeId, processados, page, data.total_count || null, truncado, orgDoContexto()]
      );
      page += 1;
    } while (page <= totalPages);

    // Catálogo vazio quase sempre significa resposta quebrada, não loja sem produto — nesse caso
    // preserva o cache anterior em vez de apagar tudo (a limpeza abaixo é o que remove produto que
    // sumiu do catálogo entre uma varredura e outra).
    if (processados === 0) throw new Error('a Ink devolveu o catálogo vazio');
    const { rowCount: removidos } = await pgPool.query(
      'DELETE FROM produtos_ink WHERE organization_id = $1 AND store_id = $2 AND sincronizado_em < $3',
      [orgDoContexto(), storeId, inicio]
    );

    await pgPool.query(
      `UPDATE produtos_ink_sync SET concluido_em = now(), total = $2, erro = NULL WHERE organization_id = $3 AND store_id = $1`,
      [storeId, processados, orgDoContexto()]
    );
    console.log(`[PRODUTOS_CACHE] store ${storeId}: ${processados} produto(s) no cache do catálogo, ${removidos} removido(s)${truncado ? ' (TRUNCADO: catálogo maior que o teto de páginas)' : ''}`);
    return { total: processados, removidos, truncado };
  } catch (err) {
    console.error(`[PRODUTOS_CACHE] falha ao sincronizar o catálogo da store ${storeId}: ${err.message}`);
    await pgPool.query(
      `INSERT INTO produtos_ink_sync (store_id, loja, iniciado_em, erro) VALUES ($1, $4, $2, $3)
       ON CONFLICT (organization_id, store_id) WHERE store_id IS NOT NULL DO UPDATE SET erro = EXCLUDED.erro`,
      [storeId, inicio, String(err.message).slice(0, 500), loja]
    ).catch(() => {});
    throw err;
  } finally {
    catalogoEmSincronizacao.delete(storeId);
  }
}

async function sincronizarCatalogoInkDaOrganizacao({ apenasVencidos = false } = {}) {
  if (!pgPool) return;
  // A Store do contexto (canônica, com ou sem chave legada), se a Organization tem token Ink.
  for (const { storeId } of await storesInkDoContexto()) {
    if (apenasVencidos) {
      const { rows } = await pgPool.query(
        'SELECT concluido_em, auto_pausado, intervalo_horas FROM produtos_ink_sync WHERE organization_id = $1 AND store_id = $2',
        [orgDoContexto(), storeId]
      );
      const cfg = rows[0];
      if (cfg && cfg.auto_pausado) continue;
      const intervaloMs = ((cfg && cfg.intervalo_horas) || PRODUTOS_CACHE_INTERVALO_PADRAO_HORAS) * 60 * 60 * 1000;
      const ultimo = cfg && cfg.concluido_em;
      if (ultimo && Date.now() - new Date(ultimo).getTime() < intervaloMs) continue;
    }
    try {
      await sincronizarCatalogoInk();
    } catch { /* já logado e gravado em produtos_ink_sync */ }
  }
}

// Tipo de produto é por loja e o feed só traz o NOME do tipo — pra honrar o filtro por
// product_type_id no cache, resolve id -> nome pela API (1 request, cacheado em memória).
const tiposPorLojaCache = new Map(); // store_id -> { em: timestamp, tipos: Map<id, nome> }
const TIPOS_CACHE_TTL_MS = 10 * 60 * 1000;

async function nomeDoTipoDeProduto(loja, tipoId) {
  const chave = storeDoContexto();
  const cacheado = tiposPorLojaCache.get(chave);
  if (!cacheado || Date.now() - cacheado.em > TIPOS_CACHE_TTL_MS) {
    const data = await inkApiRequestDaStore('/v1/stores/product_types?per_page=100');
    const tipos = new Map((data.product_types || []).map((t) => [t.id, t.name]));
    tiposPorLojaCache.set(chave, { em: Date.now(), tipos });
    return tipos.get(tipoId) || null;
  }
  return cacheado.tipos.get(tipoId) || null;
}

// O cache só responde por produto ativo — qualquer filtro que peça oculto/não aprovado cai na API.
function podeUsarCacheDeProdutos(query) {
  const visivel = query.visible_in_store;
  const aprovacao = query.approval_status;
  return (!visivel || visivel === 'true') && (!aprovacao || aprovacao === 'approved');
}

function escaparLike(texto) {
  return String(texto).replace(/[\\%_]/g, '\\$&');
}

// Busca no cache do catálogo completo. Ao contrário de buscarProdutosNoCache (feed), aqui TODOS os
// filtros da tela são resolvidos em SQL — inclusive visible_in_store e approval_status, que o feed
// não tinha como responder. Devolve null quando o cache dessa(s) loja(s) ainda não foi populado,
// pro chamador seguir pro feed e, por fim, pra API.
const PRODUTOS_CACHE_SORT = {
  nome: 'lower(name)',
  tipo: 'lower(product_type_name)',
  preco: 'price',
  status: 'status',
  visivel: 'visible_in_store',
  variantes: 'variants_count',
  atualizado: 'updated_at',
};

async function buscarProdutosNoCatalogo(loja, query) {
  if (!pgPool) return null;
  // Escopo canônico da Store do contexto (`organization_id + store_id`); o cache histórico, sem
  // `store_id`, só entra quando a Store tem chave legada.
  const escopo = escopoDaStore(2);
  const escopoBase = ['organization_id = $1', escopo.sql];
  const paramsBase = [orgDoContexto(), ...escopo.params];

  const { rows: totalRows } = await pgPool.query(
    `SELECT COUNT(*) AS total, MAX(sincronizado_em) AS sincronizado_em
     FROM produtos_ink WHERE ${escopoBase.join(' AND ')}`,
    paramsBase
  );
  if (Number(totalRows[0].total) === 0) return null;

  const where = [...escopoBase];
  const params = [...paramsBase];

  const nome = String(query.name || '').trim();
  if (nome) {
    params.push(`%${escaparLike(nome)}%`);
    where.push(`name ILIKE $${params.length} ESCAPE '\\'`);
  }
  // product_type_id é o próprio id da Ink aqui (o feed só guardava o nome do tipo e precisava de
  // um de-para), então o filtro funciona igual com "todas as lojas" selecionado.
  const tipoId = Number.parseInt(query.product_type_id, 10);
  if (Number.isInteger(tipoId) && tipoId > 0) {
    params.push(tipoId);
    where.push(`product_type_id = $${params.length}`);
  }
  if (query.visible_in_store === 'true' || query.visible_in_store === 'false') {
    params.push(query.visible_in_store === 'true');
    where.push(`visible_in_store = $${params.length}`);
  }
  if (query.approval_status) {
    params.push(String(query.approval_status));
    where.push(`approval_status = $${params.length}`);
  }
  const filtro = where.join(' AND ');

  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const perPage = Math.min(Number.parseInt(query.per_page, 10) || 20, 100);

  const { rows: contagem } = await pgPool.query(`SELECT COUNT(*) AS total FROM produtos_ink WHERE ${filtro}`, params);
  const totalCount = Number(contagem[0].total);
  // Padrão: mesma ordenação da listagem da Ink (mais recente primeiro). `sort`/`order` ordenam o
  // catálogo inteiro no banco; a chave passa pela whitelist antes de virar nome de coluna.
  const sortKey = Object.prototype.hasOwnProperty.call(PRODUTOS_CACHE_SORT, query.sort) ? query.sort : 'atualizado';
  const direcao = query.order === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await pgPool.query(
    `SELECT loja, produto_id, name, main_image_url, price, promotional_price, visible_in_store,
       approval_status, status, product_type_name, variants_count, product_cluster_id, updated_at
     FROM produtos_ink WHERE ${filtro}
     ORDER BY ${PRODUTOS_CACHE_SORT[sortKey]} ${direcao} NULLS LAST, produto_id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, perPage, (page - 1) * perPage]
  );

  return {
    produtos: rows.map((r) => ({
      loja: r.loja,
      id: Number(r.produto_id),
      name: r.name,
      mainImageUrl: r.main_image_url,
      price: r.price,
      promotionalPrice: r.promotional_price,
      visibleInStore: r.visible_in_store,
      approvalStatus: r.approval_status,
      status: r.status,
      productType: r.product_type_name,
      variantsCount: r.variants_count,
      productClusterId: r.product_cluster_id === null ? null : Number(r.product_cluster_id),
      updatedAt: r.updated_at,
    })),
    erros: [],
    approximated: false,
    truncado: false,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(totalCount / perPage)),
    totalCount,
    fonte: 'catalogo',
    ordenacao: { sort: sortKey, order: direcao === 'ASC' ? 'asc' : 'desc' },
    cacheSincronizadoEm: totalRows[0].sincronizado_em,
  };
}

// Devolve null quando o cache não cobre o caso (vazio, ou filtro de tipo sem mapeamento) — aí o
// chamador segue pro caminho normal da API.
async function buscarProdutosNoCache(loja, query) {
  if (!pgPool) return null;
  const lojas = [loja];

  const nome = String(query.name || '').trim();
  const tipoId = Number.parseInt(query.product_type_id, 10);
  let tipoNome = null;
  if (Number.isInteger(tipoId) && tipoId > 0) {
    tipoNome = await nomeDoTipoDeProduto(loja, tipoId);
    if (!tipoNome) return null;
  }

  const where = ['loja = ANY($1)'];
  const params = [lojas];
  if (nome) {
    params.push(`%${escaparLike(nome)}%`);
    where.push(`(titulo ILIKE $${params.length} ESCAPE '\\' OR nome ILIKE $${params.length} ESCAPE '\\')`);
  }
  if (tipoNome) {
    params.push(tipoNome);
    where.push(`tipo = $${params.length}`);
  }
  const filtro = where.join(' AND ');

  const { rows: totalRows } = await pgPool.query(
    `SELECT COUNT(*) AS total, MAX(sincronizado_em) AS sincronizado_em FROM produtos_feed WHERE loja = ANY($1)`,
    [lojas]
  );
  if (Number(totalRows[0].total) === 0) return null; // cache ainda não populado

  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const perPage = Math.min(Number.parseInt(query.per_page, 10) || 20, 100);

  const { rows: contagem } = await pgPool.query(`SELECT COUNT(*) AS total FROM produtos_feed WHERE ${filtro}`, params);
  const totalCount = Number(contagem[0].total);
  const { rows } = await pgPool.query(
    `SELECT loja, produto_id, nome, tipo, preco, preco_promocional, imagem_url, sincronizado_em
     FROM produtos_feed WHERE ${filtro}
     ORDER BY nome ASC NULLS LAST, produto_id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, perPage, (page - 1) * perPage]
  );

  return {
    produtos: rows.map((r) => ({
      loja: r.loja,
      id: Number(r.produto_id),
      name: r.nome,
      mainImageUrl: r.imagem_url,
      price: r.preco,
      promotionalPrice: r.preco_promocional,
      // O feed só lista produto publicado e visível na loja — daí esses três serem fixos aqui.
      // approval_status fica 'approved' de propósito: a Ink devolve "waiting" mesmo pra produto já
      // publicado e vendendo (confirmado no produto 4934698), então repetir esse rótulo aqui só
      // propagaria a informação errada.
      visibleInStore: true,
      approvalStatus: 'approved',
      status: 'published',
      productType: r.tipo,
      variantsCount: null, // o feed não traz variantes; a tela mostra "—"
      productClusterId: null,
      updatedAt: null, // o feed não traz updated_at
    })),
    erros: [],
    approximated: false,
    truncado: false,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(totalCount / perPage)),
    totalCount,
    fonte: 'cache',
    cacheSincronizadoEm: totalRows[0].sincronizado_em,
  };
}

app.get('/api/admin/produtos/catalogo/status', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'cache do catálogo exige Postgres configurado' });
  try {
    const inkConfigurada = await inkConectada();
    // Store canônica (`organization_id + store_id`); a linha histórica, sem `store_id`, só entra quando
    // a Store tem chave legada. Antes o status exigia a chave: 500 na Store nativa, e o card de
    // Integrações dizia "Nenhuma loja conectada" mesmo com token Ink.
    const storeId = storeDoContexto();
    const loja = lojaLegadaDoContextoOuNula();
    const escopo = escopoDaStore(2);
    const { rows: [t] } = await pgPool.query(
      `SELECT COUNT(*) AS total, MAX(sincronizado_em) AS sincronizado_em FROM produtos_ink WHERE organization_id = $1 AND ${escopo.sql}`,
      [orgDoContexto(), ...escopo.params]
    );
    const { rows: [sRow] } = await pgPool.query(
      `SELECT iniciado_em, concluido_em, processados, total_estimado, paginas, truncado, erro, auto_pausado, intervalo_horas
         FROM produtos_ink_sync WHERE organization_id = $1 AND ${escopo.sql} ORDER BY (store_id IS NOT NULL) DESC LIMIT 1`,
      [orgDoContexto(), ...escopo.params]
    );
    const s = sRow || null;
    res.json({
      lojas: [{
        storeId,
        loja,
        configurado: inkConfigurada,
        total: Number(t.total),
        sincronizadoEm: t.sincronizado_em,
        iniciadoEm: s ? s.iniciado_em : null,
        concluidoEm: s ? s.concluido_em : null,
        processados: s ? Number(s.processados || 0) : 0,
        totalEstimado: s && s.total_estimado !== null ? Number(s.total_estimado) : null,
        paginas: s ? Number(s.paginas || 0) : 0,
        truncado: s ? !!s.truncado : false,
        erro: s ? s.erro : null,
        sincronizando: catalogoEmSincronizacao.has(storeId),
        autoPausado: s ? !!s.auto_pausado : false,
        intervaloHoras: s && s.intervalo_horas ? Number(s.intervalo_horas) : PRODUTOS_CACHE_INTERVALO_PADRAO_HORAS,
      }],
      intervalosHoras: PRODUTOS_CACHE_INTERVALOS_HORAS,
    });
  } catch (err) {
    console.error(`[PRODUTOS_CACHE] falha ao ler status: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler o status do cache do catálogo' });
  }
});

// Dispara e responde na hora: a varredura são centenas de requests à Ink e leva minutos — quem
// acompanha é o polling de /catalogo/status, igual ao backfill de pedidos.
app.post('/api/admin/produtos/catalogo/sync', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'cache do catálogo exige Postgres configurado' });
  // A Store do contexto, se a Organization tem token Ink — com ou sem chave legada.
  const stores = await storesInkDoContexto();
  if (!stores.length) return res.status(503).json({ error: 'esta loja não tem token INK configurado' });
  const iniciadas = stores.filter((st) => !catalogoEmSincronizacao.has(st.storeId));
  for (let i = 0; i < iniciadas.length; i += 1) {
    sincronizarCatalogoInk().catch(() => {});
  }
  res.json({
    ok: true,
    storeIds: iniciadas.map((st) => st.storeId),
    lojas: iniciadas.map((st) => st.loja),
    jaRodando: stores.filter((st) => !iniciadas.includes(st)).map((st) => st.storeId),
  });
});

// Pausa/retoma a renovação automática e ajusta o intervalo, por loja. Só mexe no agendamento —
// uma varredura já em andamento termina normalmente.
app.put('/api/admin/produtos/catalogo/config', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'cache do catálogo exige Postgres configurado' });
  const body = req.body || {};
  const storeId = storeDoContexto();
  const loja = lojaLegadaDoContextoOuNula();
  const temPausado = body.pausado !== undefined;
  const temIntervalo = body.intervaloHoras !== undefined;
  if (!temPausado && !temIntervalo) return res.status(400).json({ error: 'nada para atualizar' });
  if (temPausado && typeof body.pausado !== 'boolean') return res.status(400).json({ error: 'pausado deve ser booleano' });
  if (temIntervalo && !PRODUTOS_CACHE_INTERVALOS_HORAS.includes(body.intervaloHoras)) {
    return res.status(400).json({ error: 'intervalo inválido' });
  }
  try {
    if (loja) await pgPool.query('UPDATE produtos_ink_sync SET store_id = $2 WHERE organization_id = $1 AND store_id IS NULL AND loja = $3', [orgDoContexto(), storeId, loja]);
    const { rows } = await pgPool.query(
      `INSERT INTO produtos_ink_sync (store_id, loja, auto_pausado, intervalo_horas)
       VALUES ($1, $5, COALESCE($2::boolean, false), COALESCE($3::integer, $4::integer))
       ON CONFLICT (organization_id, store_id) WHERE store_id IS NOT NULL DO UPDATE SET
         auto_pausado = COALESCE($2::boolean, produtos_ink_sync.auto_pausado),
         intervalo_horas = COALESCE($3::integer, produtos_ink_sync.intervalo_horas)
       RETURNING auto_pausado, intervalo_horas`,
      [storeId, temPausado ? body.pausado : null, temIntervalo ? body.intervaloHoras : null, PRODUTOS_CACHE_INTERVALO_PADRAO_HORAS, loja]
    );
    console.log(`[PRODUTOS_CACHE] store ${storeId}: renovação automática ${rows[0].auto_pausado ? 'pausada' : 'ativa'}, a cada ${rows[0].intervalo_horas}h`);
    res.json({ ok: true, autoPausado: rows[0].auto_pausado, intervaloHoras: rows[0].intervalo_horas });
  } catch (err) {
    console.error(`[PRODUTOS_CACHE] falha ao salvar config: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar a configuração do catálogo' });
  }
});
app.get('/api/admin/produtos/feed/status', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'cache de produtos exige Postgres configurado' });
  // O feed CSV é caminho legado descontinuado: só existe para Store com chave legada. Para a Store
  // nativa ele NÃO é requisito — a resposta é "sem feed", nunca um erro de integração.
  if (!lojaLegadaDoContextoOuNula()) return res.json({ lojas: [], descontinuado: true });
  try {
    const feedConfigurado = await feedInkConfigurado();
    const { rows: totais } = await pgPool.query(
      'SELECT loja, COUNT(*) AS total, MAX(sincronizado_em) AS sincronizado_em FROM produtos_feed WHERE organization_id = $1 GROUP BY loja',
      [orgDoContexto()]
    );
    const { rows: syncs } = await pgPool.query(
      'SELECT loja, iniciado_em, concluido_em, erro FROM produtos_feed_sync WHERE organization_id = $1', [orgDoContexto()]
    );
    const porLoja = new Map(totais.map((t) => [t.loja, t]));
    const porSync = new Map(syncs.map((s) => [s.loja, s]));
    res.json({
      lojas: [lojaLegadaDoContexto()].map((loja) => {
        const t = porLoja.get(loja);
        const s = porSync.get(loja);
        return {
          loja,
          configurado: feedConfigurado,
          total: t ? Number(t.total) : 0,
          sincronizadoEm: t ? t.sincronizado_em : null,
          iniciadoEm: s ? s.iniciado_em : null,
          erro: s ? s.erro : null,
          sincronizando: feedEmSincronizacao.has(loja),
        };
      }),
    });
  } catch (err) {
    console.error(`[PRODUTOS_FEED] falha ao ler status: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler o status do cache de produtos' });
  }
});

// Dispara e responde na hora: o download/parse leva dezenas de segundos e não pode segurar a
// request do admin (mesmo motivo dos outros jobs deste arquivo).
app.post('/api/admin/produtos/feed/sync', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'cache de produtos exige Postgres configurado' });
  // Feed CSV: caminho legado descontinuado, só para Store com chave legada.
  const lojaDoFeed = lojaLegadaDoContextoOuNula();
  if (!lojaDoFeed) return res.status(410).json({ error: 'o feed de produtos foi descontinuado: o catálogo é sincronizado direto pela Reserva Ink', codigo: 'FEED_DEPRECATED' });
  const lojas = (await feedInkConfigurado()) ? [lojaDoFeed] : [];
  if (!lojas.length) return res.status(503).json({ error: 'esta loja não tem a URL do feed configurada' });
  for (const loja of lojas) {
    sincronizarProdutosFeed(loja).catch(() => {});
  }
  res.json({ ok: true, lojas });
});

app.get('/api/admin/produtos/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/products/${id}`);
    res.json({ loja, produto: data.product });
  } catch (err) {
    console.error(`[PRODUTOS] falha ao buscar produto ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar o produto' });
  }
});

app.get('/api/admin/produto-tipos', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    const data = await inkApiRequestDaStore('/v1/stores/product_types?per_page=100');
    res.json({ tipos: data.product_types || [] });
  } catch (err) {
    console.error(`[PRODUTOS] falha ao listar tipos de produto (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar os tipos de produto' });
  }
});


app.post('/api/admin/produtos', requireAdmin, async (req, res) => {
  const {
    loja, productTypeId, name, description, price, tags, visibleInStore, customizableByBuyer, collections, newCollections, artGroups,
  } = req.body || {};
  if (!Number.isInteger(productTypeId)) return res.status(400).json({ error: 'productTypeId inválido' });
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'informe o nome do produto' });
  if (typeof price !== 'string' || !price.trim()) return res.status(400).json({ error: 'informe o preço' });
  if (!Array.isArray(artGroups) || !artGroups.length) return res.status(400).json({ error: 'selecione ao menos 1 arte' });

  // A Ink exige 1 entrada por base_image_id (cada uma com sua própria art_url/art_attachment,
  // mutuamente exclusivos — ver documentacao-api-ink.yaml). O cliente manda cada arte 1x só
  // (`artGroups`, agrupada por cor/versão) pra não reenviar o mesmo base64 uma vez por cor — isso
  // é o que travava "Enviando…" sem erro no log: o body ficava gigante (a mesma arte repetida N
  // vezes) e nem chegava a este handler. Expande aqui, na perna servidor→Ink, que é rápida.
  const arts = [];
  for (const g of artGroups) {
    if (!Array.isArray(g.base_image_ids) || !g.base_image_ids.length || (!g.art_url && !g.art_attachment)) {
      return res.status(400).json({ error: 'cada arte precisa de ao menos 1 cor/versão e art_url ou art_attachment' });
    }
    for (const baseImageId of g.base_image_ids) {
      if (!Number.isInteger(baseImageId)) return res.status(400).json({ error: 'base_image_id inválido' });
      const item = { base_image_id: baseImageId };
      if (g.art_url) item.art_url = g.art_url;
      else item.art_attachment = g.art_attachment;
      arts.push(item);
    }
  }

  const body = {
    product_type_id: productTypeId,
    name: name.trim(),
    price: price.trim(),
    arts,
  };
  if (description) body.description = description;
  if (Array.isArray(tags)) body.tags = tags;
  if (visibleInStore !== undefined) body.visible_in_store = !!visibleInStore;
  if (customizableByBuyer !== undefined) body.customizable_by_buyer = !!customizableByBuyer;
  if (Array.isArray(collections)) body.collections = collections;
  if (Array.isArray(newCollections)) body.new_collections = newCollections;

  try {
    // Timeout maior que o padrão de inkApiPost (20s): produto com várias cores pode levar bem
    // mais que isso pra Ink processar todas as artes (image_attachment de até 20MB cada).
    const data = await inkApiPostDaStore('/v1/stores/products', body, { 'Idempotency-Key': crypto.randomUUID() }, 120000);
    res.status(201).json({ loja, produto: data.product });
  } catch (err) {
    console.error(`[PRODUTOS] falha ao criar produto (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível criar o produto', details: err.details });
  }
});

// PATCH genérico — usado tanto pro botão rápido "Ocultar/Publicar" (só visible_in_store) quanto
// por uma futura edição completa. Nunca oferecer DELETE — a API não documenta esse método.
app.patch('/api/admin/produtos/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa

  const { name, description, price, visibleInStore, tags, collections, newCollections, removeVariants, arts } = req.body || {};
  const body = {};
  if (name !== undefined) body.name = name;
  if (description !== undefined) body.description = description;
  if (price !== undefined) body.price = price;
  if (visibleInStore !== undefined) body.visible_in_store = !!visibleInStore;
  if (Array.isArray(tags)) body.tags = tags;
  if (Array.isArray(collections)) body.collections = collections;
  if (Array.isArray(newCollections)) body.new_collections = newCollections;
  if (Array.isArray(removeVariants)) body.remove_variants = removeVariants;
  if (Array.isArray(arts)) body.arts = arts;
  if (!Object.keys(body).length) return res.status(400).json({ error: 'nenhum campo para atualizar' });

  try {
    const data = await inkApiPatchDaStore(`/v1/stores/products/${id}`, body, { 'Idempotency-Key': crypto.randomUUID() });
    res.json({ loja, produto: data.product });
  } catch (err) {
    console.error(`[PRODUTOS] falha ao atualizar produto ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível atualizar o produto', details: err.details });
  }
});

app.post('/api/admin/produtos/:id/duplicar', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const { productTypeId, price, includeCategories } = req.body || {};
  if (!Number.isInteger(productTypeId)) return res.status(400).json({ error: 'productTypeId (tipo de destino) inválido' });

  const body = { product_type_id: productTypeId, include_categories: includeCategories !== false };
  if (price) body.price = price;

  try {
    const data = await inkApiPostDaStore(`/v1/stores/products/${id}/copy`, body, { 'Idempotency-Key': crypto.randomUUID() });
    res.status(201).json({ loja, produto: data.product });
  } catch (err) {
    console.error(`[PRODUTOS] falha ao duplicar produto ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível duplicar o produto', details: err.details });
  }
});


// Paginação opcional das listas de catálogo: sem `page` a rota mantém o comportamento de sempre (uma página de
// 100, usada por seletores); com `page` devolve só aquela página e os totais. Entrada validada como inteiro
// dentro de limites — nunca repassada crua para a Ink.
function paginaDaQuery(query, { padrao = 25, maximo = 100 } = {}) {
  const soDigitos = (v) => typeof v === 'string' && /^\d{1,4}$/.test(v);
  if (!soDigitos(query.page) || Number(query.page) < 1 || Number(query.page) > 1000) return { paginado: false, page: 1, perPage: 100 };
  const perPage = soDigitos(query.per_page) && Number(query.per_page) >= 1 ? Math.min(Number(query.per_page), maximo) : padrao;
  return { paginado: true, page: Number(query.page), perPage };
}

// ── Catálogo — Categorias (Fase 8.2, ver docs/plan.md) ──────────────────
// Único módulo de catálogo com CRUD completo de verdade (a API documenta DELETE aqui, ao
// contrário de produtos). `product_ids`/`kit_ids` são substituição TOTAL do array (não soma) —
// por isso "adicionar 1 produto" sempre lê a categoria atual antes de gravar (ver
// /adicionar-produto abaixo), nunca assume o estado local.
app.get('/api/admin/categorias', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    const { paginado, page, perPage } = paginaDaQuery(req.query);
    const data = await inkApiRequestDaStore(paginado
      ? `/v1/stores/collections?page=${page}&per_page=${perPage}`
      : '/v1/stores/collections?per_page=100');
    // A listagem só precisa da CONTAGEM: cada categoria traz `product_ids` com todos os produtos (a maior tem
    // ~100 mil ids), e a tela levava 10+ s só para carregar esse volume. Os ids completos seguem no detalhe
    // (`GET /api/admin/categorias/:id`), que é o que o drawer usa para editar.
    const categorias = (data.collections || []).map(({ product_ids: ids, ...resto }) => ({
      ...resto,
      product_count: Array.isArray(ids) ? ids.length : 0,
    }));
    res.json({ categorias, page: paginado ? page : 1, totalPages: data.total_pages || 1, totalCount: data.total_count ?? null });
  } catch (err) {
    console.error(`[CATEGORIAS] falha ao listar (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar as categorias' });
  }
});

app.get('/api/admin/categorias/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/collections/${id}`);
    res.json({ loja, categoria: data.collection });
  } catch (err) {
    console.error(`[CATEGORIAS] falha ao buscar categoria ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar a categoria' });
  }
});

// Nomes dos produtos de uma categoria, separados por vírgula (pedido do usuário, 2026-09-11) —
// pra colar direto num filtro de conjunto de produtos no Gerenciador de Anúncios da Meta. A
// categoria só expõe product_ids (não nomes), então busca cada produto individualmente em lotes
// pequenos — mesmo padrão já usado em falhas-por-tipo. Só leitura, não altera nada.
app.get('/api/admin/categorias/:id/produtos-nomes', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    const dataCategoria = await inkApiRequestDaStore(`/v1/stores/collections/${id}`);
    const categoria = dataCategoria.collection;
    if (!categoria) return res.status(404).json({ error: 'categoria não encontrada' });
    const productIds = categoria.product_ids || [];

    const nomes = [];
    const LOTE = 10;
    for (let i = 0; i < productIds.length; i += LOTE) {
      const lote = productIds.slice(i, i + LOTE);
      const resultados = await Promise.all(lote.map(async (pid) => {
        try {
          const data = await inkApiRequestDaStore(`/v1/stores/products/${pid}`);
          return (data.product && data.product.name) || null;
        } catch {
          return null;
        }
      }));
      nomes.push(...resultados.filter(Boolean));
    }

    res.json({
      categoria: { id: categoria.id, name: categoria.name },
      total: productIds.length,
      encontrados: nomes.length,
      nomes,
      csv: nomes.join(', '),
    });
  } catch (err) {
    console.error(`[CATEGORIAS] falha ao listar nomes de produtos (${loja}/${id}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar os produtos da categoria' });
  }
});

app.post('/api/admin/categorias', requireAdmin, async (req, res) => {
  const { name, description, isAvailable, position } = req.body || {};
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  if (typeof name !== 'string' || !name.trim() || name.length > 20) return res.status(400).json({ error: 'nome é obrigatório (máx. 20 caracteres — limite da Ink)' });

  const body = { name: name.trim() };
  if (description !== undefined) body.description = description;
  if (isAvailable !== undefined) body.is_available = !!isAvailable;
  if (position !== undefined) body.position = position;

  try {
    const data = await inkApiPostDaStore('/v1/stores/collections', body, { 'Idempotency-Key': crypto.randomUUID() });
    res.status(201).json({ loja, categoria: data.collection });
  } catch (err) {
    console.error(`[CATEGORIAS] falha ao criar categoria (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível criar a categoria', details: err.details });
  }
});

app.patch('/api/admin/categorias/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const { name, description, isAvailable, position, productIds, kitIds } = req.body || {};
  const body = {};
  if (name !== undefined) body.name = name;
  if (description !== undefined) body.description = description;
  if (isAvailable !== undefined) body.is_available = !!isAvailable;
  if (position !== undefined) body.position = position;
  if (Array.isArray(productIds)) body.product_ids = productIds;
  if (Array.isArray(kitIds)) body.kit_ids = kitIds;
  if (!Object.keys(body).length) return res.status(400).json({ error: 'nenhum campo para atualizar' });

  try {
    const data = await inkApiPatchDaStore(`/v1/stores/collections/${id}`, body, { 'Idempotency-Key': crypto.randomUUID() });
    res.json({ loja, categoria: data.collection });
  } catch (err) {
    console.error(`[CATEGORIAS] falha ao atualizar categoria ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível atualizar a categoria', details: err.details });
  }
});

app.delete('/api/admin/categorias/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    await inkApiDeleteDaStore(`/v1/stores/collections/${id}`, { 'Idempotency-Key': crypto.randomUUID() });
    res.status(204).end();
  } catch (err) {
    console.error(`[CATEGORIAS] falha ao excluir categoria ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível excluir a categoria' });
  }
});

// Lê a categoria atual, acrescenta o produto (sem duplicar) e regrava a lista inteira — a API
// só aceita substituição total de `product_ids`, nunca "adicionar 1".
app.post('/api/admin/categorias/:id/adicionar-produto', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const { productId } = req.body || {};
  if (!Number.isInteger(productId)) return res.status(400).json({ error: 'productId inválido' });

  try {
    const atual = await inkApiRequestDaStore(`/v1/stores/collections/${id}`);
    const productIds = Array.from(new Set([...(atual.collection.product_ids || []), productId]));
    if (productIds.length > 100) return res.status(400).json({ error: 'categoria já está no limite de 100 produtos (limite da Ink)' });
    const data = await inkApiPatchDaStore(`/v1/stores/collections/${id}`, { product_ids: productIds }, { 'Idempotency-Key': crypto.randomUUID() });
    res.json({ loja, categoria: data.collection });
  } catch (err) {
    console.error(`[CATEGORIAS] falha ao adicionar produto ${productId} à categoria ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível adicionar o produto à categoria' });
  }
});

app.get('/api/admin/categorias/:id/vitrine', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/collections/${id}/custom_showcase`);
    res.json({ loja, vitrine: data.custom_showcase });
  } catch (err) {
    console.error(`[CATEGORIAS] falha ao buscar vitrine ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar a vitrine' });
  }
});

app.put('/api/admin/categorias/:id/vitrine', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const { productItems, kitItems } = req.body || {};
  if (!Array.isArray(productItems)) return res.status(400).json({ error: 'productItems é obrigatório' });

  const body = {
    sequence_type: 'personalized',
    product_items: productItems.map((p, i) => ({ product_id: p.productId, position: i + 1 })),
    kit_items: (kitItems || []).map((k) => ({ kit_id: k.kitId, position: k.position })),
  };
  try {
    const data = await inkApiPutDaStore(`/v1/stores/collections/${id}/custom_showcase`, body, { 'Idempotency-Key': crypto.randomUUID() });
    res.json({ loja, vitrine: data.custom_showcase });
  } catch (err) {
    console.error(`[CATEGORIAS] falha ao reordenar vitrine ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível salvar a ordenação', details: err.details });
  }
});

// ── Categorias em lote (migração/organização de catálogo) ───────────────
// Normaliza pra comparação (trim, lowercase, colapsa espaços repetidos) — nunca altera o nome
// real que vai ser enviado à Ink, só usado pra detectar duplicado/já-existe.
function normalizarNomeCategoria(nome) {
  return String(nome || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

app.post('/api/admin/categorias/bulk-preview', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const { nomes } = req.body || {};
  if (!Array.isArray(nomes)) return res.status(400).json({ error: 'nomes é obrigatório (array)' });

  try {
    const existentesData = await inkApiRequestDaStore('/v1/stores/collections?per_page=100');
    const nomesExistentes = new Set((existentesData.collections || []).map((c) => normalizarNomeCategoria(c.name)));
    const vistosNaLista = new Set();

    const itens = nomes
      .map((nomeCru) => String(nomeCru || '').trim())
      .filter((nome) => nome.length > 0)
      .map((nome) => {
        const chave = normalizarNomeCategoria(nome);
        let status;
        if (nome.length > 20) status = 'nome_invalido';
        else if (vistosNaLista.has(chave)) status = 'duplicada_na_lista';
        else if (nomesExistentes.has(chave)) status = 'ja_existe';
        else status = 'pronta';
        vistosNaLista.add(chave);
        return { nome, status };
      });

    res.json({
      itens,
      resumo: {
        total: itens.length,
        prontas: itens.filter((i) => i.status === 'pronta').length,
        jaExistem: itens.filter((i) => i.status === 'ja_existe').length,
        invalidas: itens.filter((i) => i.status === 'nome_invalido').length,
        duplicadas: itens.filter((i) => i.status === 'duplicada_na_lista').length,
      },
    });
  } catch (err) {
    console.error(`[CATEGORIAS_LOTE] falha ao analisar lote (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível analisar a lista' });
  }
});

// Cria 1 categoria por vez (nunca em paralelo — poucas dezenas de itens, sem necessidade de job
// assíncrono; a Fase 2, associação de produtos, é que precisa de job de verdade). Sempre sem
// `product_ids` neste momento — associação de produtos é etapa separada (Parte 2 do plano).
app.post('/api/admin/categorias/bulk-create', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const { nomes, isAvailable, descricaoPadrao } = req.body || {};
  if (!Array.isArray(nomes) || !nomes.length) return res.status(400).json({ error: 'nomes é obrigatório (array não vazio)' });
  if (nomes.some((n) => typeof n !== 'string' || !n.trim() || n.length > 20)) {
    return res.status(400).json({ error: 'todos os nomes precisam ser válidos (máx. 20 caracteres) — rode o preview antes' });
  }

  const resultados = [];
  const mapaIds = {};
  for (const nomeCru of nomes) {
    const nome = nomeCru.trim();
    const body = { name: nome, is_available: !!isAvailable };
    if (descricaoPadrao) body.description = descricaoPadrao;
    try {
      const data = await inkApiPostDaStore('/v1/stores/collections', body, { 'Idempotency-Key': crypto.randomUUID() });
      const categoria = data.collection;
      resultados.push({ nome, status: 'criada', id: categoria && categoria.id });
      if (categoria && categoria.id != null) mapaIds[nome] = categoria.id;
    } catch (err) {
      if (err.status === 409) {
        resultados.push({ nome, status: 'ja_existia', error: err.message });
      } else {
        console.error(`[CATEGORIAS_LOTE] falha ao criar "${nome}" (${loja}): ${err.message}`);
        resultados.push({ nome, status: 'falhou', error: err.message || 'erro desconhecido' });
      }
    }
  }

  res.json({
    resultados,
    mapaIds,
    resumo: {
      criadas: resultados.filter((r) => r.status === 'criada').length,
      existentes: resultados.filter((r) => r.status === 'ja_existia').length,
      falharam: resultados.filter((r) => r.status === 'falhou').length,
    },
  });
});

// Ativar/desativar categorias em massa (pedido do usuário, 2026-09-09): categorias criadas pelo
// preset da Migração Use Origens nascem como "Não disponível na loja" por padrão (Parte 1 —
// categoria interna, is_available=false). Causa raiz real encontrada em produção: a Ink rejeita
// (422) associar um produto a uma categoria desativada — daí toda a execução da migração falhando
// com a mesma mensagem genérica. O painel nativo da Ink só ativa/desativa 1 categoria por vez.
app.post('/api/admin/categorias/bulk-ativar', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const ids = Array.isArray(req.body && req.body.ids) ? Array.from(new Set(req.body.ids)) : null;
  const disponivel = req.body && req.body.isAvailable === false ? false : true;
  const rotulo = disponivel ? 'ativada' : 'desativada';
  if (!ids || !ids.length || !ids.every((n) => Number.isInteger(n))) {
    return res.status(400).json({ error: 'ids é obrigatório (array de inteiros não vazio)' });
  }

  const resultados = [];
  for (const id of ids) {
    try {
      await inkApiPatchDaStore(`/v1/stores/collections/${id}`, { is_available: disponivel }, { 'Idempotency-Key': crypto.randomUUID() });
      resultados.push({ id, status: rotulo });
    } catch (err) {
      console.error(`[CATEGORIAS_LOTE] falha ao ${disponivel ? 'ativar' : 'desativar'} categoria ${id} (${loja}): ${err.message}`);
      resultados.push({ id, status: 'falhou', error: err.message || 'erro desconhecido' });
    }
  }

  res.json({
    resultados,
    resumo: { ativadas: resultados.filter((r) => r.status === rotulo).length, falharam: resultados.filter((r) => r.status === 'falhou').length },
  });
});

// Excluir categorias em massa (pedido do usuário, 2026-09-09) — mesmo padrão de bulk-ativar, só
// que chamando DELETE em vez de PATCH. Exclusão de categoria não desfaz associação de produto
// nenhuma (a categoria some, os produtos continuam existindo normalmente).
// Compartilhada entre /bulk-excluir (genérico, qualquer categoria) e a exclusão segura da
// Migração Use Origens (que valida ANTES quais ids passam, e só chama isto pros aprovados) —
// nunca duplicar a chamada de exclusão em si.
async function excluirCategoriasEmLote(loja, ids) {
  const resultados = [];
  for (const id of ids) {
    try {
      await inkApiDeleteDaStore(`/v1/stores/collections/${id}`, { 'Idempotency-Key': crypto.randomUUID() });
      resultados.push({ id, status: 'excluida' });
    } catch (err) {
      console.error(`[CATEGORIAS_LOTE] falha ao excluir categoria ${id} (${loja}): ${err.message}`);
      resultados.push({ id, status: 'falhou', error: err.message || 'erro desconhecido' });
    }
  }
  return resultados;
}

app.post('/api/admin/categorias/bulk-excluir', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const ids = Array.isArray(req.body && req.body.ids) ? Array.from(new Set(req.body.ids)) : null;
  if (!ids || !ids.length || !ids.every((n) => Number.isInteger(n))) {
    return res.status(400).json({ error: 'ids é obrigatório (array de inteiros não vazio)' });
  }

  const resultados = await excluirCategoriasEmLote(loja, ids);
  res.json({
    resultados,
    resumo: { excluidas: resultados.filter((r) => r.status === 'excluida').length, falharam: resultados.filter((r) => r.status === 'falhou').length },
  });
});

// ── Associação em massa de categorias (docs/claude-categorias-lote-migracao-use-origens.md,
// Parte 2/3) ─────────────────────────────────────────────────────────────
// Retry só usado aqui — as chamadas Ink de sempre (pedidos, produto individual etc.) continuam
// sem retry, comportamento inalterado. 429/5xx/erro de rede são transitórios; qualquer outro erro
// (400/401/404/422) não adianta tentar de novo.
const BULKCAT_RETRY_BACKOFF_MS = [1000, 3000, 10000, 30000];
function erroInkETransitorio(err) {
  if (!err.status) return true; // erro de rede/timeout, sem status HTTP
  return [429, 500, 502, 503, 504].includes(err.status);
}
async function comRetryInk(fn) {
  let ultimoErro;
  for (let tentativa = 0; tentativa <= BULKCAT_RETRY_BACKOFF_MS.length; tentativa++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;
      if (tentativa === BULKCAT_RETRY_BACKOFF_MS.length || !erroInkETransitorio(err)) throw err;
      await new Promise((r) => setTimeout(r, BULKCAT_RETRY_BACKOFF_MS[tentativa]));
    }
  }
  throw ultimoErro;
}

async function fetchTodasCategoriasLoja(loja) {
  const categorias = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await inkApiRequestDaStore(`/v1/stores/collections?page=${page}&per_page=100`);
    categorias.push(...(data.collections || []));
    totalPages = Math.min(data.total_pages || 1, 20);
    page += 1;
  } while (page <= totalPages);
  return categorias;
}

// Índice reverso produto→categorias atuais. A API da Ink não expõe `collections` no produto (nem
// na listagem nem no detalhe — ver documentacao-api-ink.yaml), só o inverso
// (`collection.product_ids`). Por isso o "estado atual" de um produto é calculado 1x por tick a
// partir de TODAS as categorias da loja, em vez de 1 GET por produto (que nem existiria).
async function buildCollectionsIndex(loja) {
  const categorias = await fetchTodasCategoriasLoja(loja);
  const indice = new Map();
  const nomesPorId = new Map();
  // categoriaProdutos: categoriaId -> Set(productId) — "lado da categoria" dos mesmos dados já
  // buscados. Não usado pela atualização de categoria (que voltou a ser via PATCH de produto),
  // mas mantido por ser barato de calcular e útil pra outros usos (ex: /adicionar-produto).
  const categoriaProdutos = new Map();
  for (const cat of categorias) {
    nomesPorId.set(cat.id, cat.name);
    categoriaProdutos.set(cat.id, new Set(cat.product_ids || []));
    for (const pid of (cat.product_ids || [])) {
      if (!indice.has(pid)) indice.set(pid, new Set());
      indice.get(pid).add(cat.id);
    }
  }
  return { indice, nomesPorId, categoriaProdutos };
}

function setsIguais(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Resolve os produtos-alvo de um filtro (ou usa a seleção manual, se veio uma) — reaproveita
// fetchTodosProdutosLoja (já resolve todas as páginas) + o mesmo filtro por nome já usado em
// GET /api/admin/produtos, pra nunca depender de uma lista de milhares de IDs vinda do browser.
async function resolverProdutosAlvo(loja, filtros, selecaoManual) {
  if (selecaoManual && Array.isArray(selecaoManual.productIds) && selecaoManual.productIds.length) {
    return { produtos: Array.from(new Set(selecaoManual.productIds)).map((id) => ({ id })), truncado: false };
  }
  const baseParams = new URLSearchParams();
  PRODUTOS_QUERY_PARAMS.forEach((key) => { if (filtros && filtros[key] !== undefined && filtros[key] !== '') baseParams.set(key, filtros[key]); });
  const { produtos: todos, truncado } = await fetchTodosProdutosLojaComInfo(loja, baseParams);
  const filtroLocal = montarFiltroLocalProdutos(filtros);
  const filtrados = filtroLocal ? todos.filter(filtroLocal) : todos;
  return { produtos: filtrados.map((p) => ({ id: p.id, name: p.name })), truncado };
}

function validarCategoryIds(categoryIds, mode) {
  if (!Array.isArray(categoryIds) || !categoryIds.every((n) => Number.isInteger(n))) {
    return 'categoryIds é obrigatório (array de inteiros)';
  }
  if (mode === 'replace' && categoryIds.length === 0) {
    return 'REPLACE com nenhuma categoria substituiria por uma lista vazia — bloqueado por padrão pra evitar limpeza total acidental';
  }
  return null;
}

// removeCategoryIds (2026-09-11, pedido do usuário): só vale no modo 'add' — permite "transferir"
// (tirar de uma categoria, colocar em outra) num job só, sem precisar calcular a lista completa
// pra um 'replace'. Ignorado silenciosamente no modo 'replace' (lá o resultado final já é
// explícito via categoryIds).
function normalizarRemoveCategoryIds(mode, raw) {
  if (mode !== 'add' || !Array.isArray(raw) || !raw.length) return [];
  if (!raw.every((n) => Number.isInteger(n))) return null; // sinaliza erro de validação
  return Array.from(new Set(raw));
}

app.post('/api/admin/category-assignments/preview', requireAdmin, async (req, res) => {
  const { mode, filtros, selecaoManual } = req.body || {};
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const categoryIds = Array.isArray(req.body && req.body.categoryIds) ? Array.from(new Set(req.body.categoryIds)) : req.body && req.body.categoryIds;
  if (mode !== 'add' && mode !== 'replace') return res.status(400).json({ error: 'mode deve ser "add" ou "replace"' });
  const erroCategorias = validarCategoryIds(categoryIds, mode);
  if (erroCategorias) return res.status(400).json({ error: erroCategorias });
  const removeCategoryIds = normalizarRemoveCategoryIds(mode, req.body && req.body.removeCategoryIds);
  if (removeCategoryIds === null) return res.status(400).json({ error: 'removeCategoryIds deve ser um array de inteiros' });

  try {
    const { produtos, truncado } = await resolverProdutosAlvo(loja, filtros, selecaoManual);
    const { indice, nomesPorId } = await buildCollectionsIndex(loja);
    for (const id of categoryIds) if (!nomesPorId.has(id)) return res.status(400).json({ error: `categoria ${id} não existe nesta loja` });
    for (const id of removeCategoryIds) if (!nomesPorId.has(id)) return res.status(400).json({ error: `categoria ${id} não existe nesta loja` });

    const amostra = produtos.slice(0, 20).map((p) => {
      const atuais = indice.get(p.id) || new Set();
      const antesIds = Array.from(atuais);
      const depoisIds = mode === 'add'
        ? Array.from(new Set([...antesIds.filter((id) => !removeCategoryIds.includes(id)), ...categoryIds]))
        : categoryIds;
      return {
        id: p.id,
        name: p.name || null,
        categoriasAntes: antesIds.map((id) => nomesPorId.get(id) || `#${id}`),
        categoriasDepois: depoisIds.map((id) => nomesPorId.get(id) || `#${id}`),
      };
    });

    res.json({ total: produtos.length, truncado, amostra, categoriasNomes: categoryIds.map((id) => ({ id, name: nomesPorId.get(id) })) });
  } catch (err) {
    console.error(`[CATEGORY_ASSIGNMENTS] falha no preview (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível simular a associação' });
  }
});

app.post('/api/admin/category-assignments', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'associação em massa exige Postgres configurado' });
  const { mode, filtros, selecaoManual } = req.body || {};
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  const categoryIds = Array.isArray(req.body && req.body.categoryIds) ? Array.from(new Set(req.body.categoryIds)) : req.body && req.body.categoryIds;
  if (mode !== 'add' && mode !== 'replace') return res.status(400).json({ error: 'mode deve ser "add" ou "replace"' });
  const erroCategorias = validarCategoryIds(categoryIds, mode);
  if (erroCategorias) return res.status(400).json({ error: erroCategorias });
  const removeCategoryIds = normalizarRemoveCategoryIds(mode, req.body && req.body.removeCategoryIds);
  if (removeCategoryIds === null) return res.status(400).json({ error: 'removeCategoryIds deve ser um array de inteiros' });

  try {
    const { produtos } = await resolverProdutosAlvo(loja, filtros, selecaoManual);
    if (!produtos.length) return res.status(400).json({ error: 'nenhum produto encontrado para os filtros informados' });
    if (removeCategoryIds.length) {
      const { nomesPorId } = await buildCollectionsIndex(loja);
      for (const id of removeCategoryIds) if (!nomesPorId.has(id)) return res.status(400).json({ error: `categoria ${id} não existe nesta loja` });
    }

    const jobRows = await pgPool.query(
      `INSERT INTO bulk_category_jobs (store_id, loja, mode, category_ids, category_ids_remover, filtro_produtos, total, status)
       VALUES ($7, $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, 'queued') RETURNING id`,
      [
        loja, mode, JSON.stringify(categoryIds), removeCategoryIds.length ? JSON.stringify(removeCategoryIds) : null,
        JSON.stringify({ filtros: filtros || null, selecaoManual: !!(selecaoManual && selecaoManual.productIds && selecaoManual.productIds.length) }),
        produtos.length,
        storeDoContexto(),
      ]
    );
    const jobId = jobRows.rows[0].id;

    await pgPool.query(
      `INSERT INTO bulk_category_job_items (job_id, product_id)
       SELECT $1, x FROM unnest($2::bigint[]) AS x`,
      [jobId, produtos.map((p) => p.id)]
    );

    res.status(201).json({ jobId, total: produtos.length });
  } catch (err) {
    console.error(`[CATEGORY_ASSIGNMENTS] falha ao criar job (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível criar o job de associação' });
  }
});

app.get('/api/admin/category-jobs/:id', requireAdmin, exigirRecurso('bulk_category_jobs'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'category-jobs exige Postgres configurado' });
  const { rows } = await pgPool.query('SELECT * FROM bulk_category_jobs WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'job não encontrado' });
  const falhas = await pgPool.query(
    `SELECT id, product_id, error, attempts FROM bulk_category_job_items WHERE job_id = $1 AND status = 'failed' ORDER BY atualizado_em DESC LIMIT 20`,
    [req.params.id]
  );
  res.json({ job: rows[0], falhas: falhas.rows });
});

// Diagnóstico só-leitura (2026-09-11): ver o categories_before/categories_after real gravado por
// item — pra confirmar se um resultado inesperado (ex: "modo add substituiu em vez de somar") é
// bug de verdade ou só o produto já não tendo categoria nenhuma antes (nada a preservar).
app.get('/api/admin/category-jobs/:id/items', requireAdmin, exigirRecurso('bulk_category_jobs'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'category-jobs exige Postgres configurado' });
  const { status } = req.query;
  const params = [req.params.id];
  let where = 'job_id = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  const limit = Math.min(100, Number.parseInt(req.query.limit, 10) || 20);
  const { rows } = await pgPool.query(
    `SELECT id, product_id, status, categories_before, categories_after, categoria_ids_alvo, error, attempts, atualizado_em
     FROM bulk_category_job_items WHERE ${where} ORDER BY atualizado_em DESC LIMIT ${limit}`,
    params
  );
  res.json({ items: rows });
});

// Diagnóstico (pedido do usuário, 2026-09-09): comparando 2 produtos manualmente via Debug, um
// que passou e um que não passou, a diferença visível era o `product_type` (e o padrão de
// estoque) — pode ser coincidência de 2 amostras ou pode ser um padrão real (ex: a Ink pode ter
// alguma regra de categoria obrigatória por tipo de produto, e nosso REPLACE de `collections`
// removendo essa categoria bloquearia só produtos desse tipo). Este endpoint busca o
// `product_type` de TODAS as falhas atuais do job (não só 2) pra confirmar ou descartar a
// hipótese com dado real. Só leitura — nunca faz PATCH, não interfere no job.
app.get('/api/admin/category-jobs/:id/falhas-por-tipo', requireAdmin, exigirRecurso('bulk_category_jobs'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'category-jobs exige Postgres configurado' });
  const jobRows = await pgPool.query('SELECT loja FROM bulk_category_jobs WHERE id = $1', [req.params.id]);
  if (!jobRows.rows.length) return res.status(404).json({ error: 'job não encontrado' });
  const { loja } = jobRows.rows[0];
  const { rows: falhas } = await pgPool.query(
    `SELECT product_id FROM bulk_category_job_items WHERE job_id = $1 AND status = 'failed' LIMIT 300`,
    [req.params.id]
  );

  const contagem = new Map(); // "id|nome" -> quantidade
  let semTipo = 0;
  const LOTE = 8;
  for (let i = 0; i < falhas.length; i += LOTE) {
    const lote = falhas.slice(i, i + LOTE);
    const resultados = await Promise.all(lote.map(async (f) => {
      try {
        const data = await inkApiRequestDaStore(`/v1/stores/products/${f.product_id}`);
        return data.product && data.product.product_type ? data.product.product_type : null;
      } catch {
        return null;
      }
    }));
    for (const tipo of resultados) {
      if (!tipo) { semTipo += 1; continue; }
      const chave = `${tipo.id}|${tipo.name}`;
      contagem.set(chave, (contagem.get(chave) || 0) + 1);
    }
  }

  const tipos = Array.from(contagem.entries())
    .map(([chave, quantidade]) => {
      const [id, nome] = chave.split('|');
      return { id: Number(id), nome, quantidade };
    })
    .sort((a, b) => b.quantidade - a.quantidade);

  res.json({ totalAnalisado: falhas.length, semTipo, tipos });
});

// Debug (pedido do usuário, 2026-09-09): testa a atualização de UM item específico com log
// completo — mesma chamada real que o job faz (mesmo endpoint, mesmo body), mas de forma isolada
// e síncrona, sem passar por comRetryInk (queremos ver a 1ª resposta crua, não um retry
// automático escondendo o que a Ink respondeu de verdade). Loga requisição E resposta no console
// do servidor E devolve tudo na resposta, pra inspecionar sem precisar dos logs do Railway.
// Atualiza o item de verdade (sucesso ou falha) — não é só um dry-run, é o retry real desse item.
// Debug de item único: mesma chamada real que o job faz (PATCH de produto), isolada e síncrona,
// sem retry (queremos a resposta crua, não um retry escondendo o que a Ink respondeu). Loga tudo
// no console E devolve na resposta. Atualiza o item de verdade (não é dry-run).
app.post('/api/admin/internal/origens-migration/debug/testar-item/:itemId', requireAdmin, requireInternalTools, exigirRecurso('bulk_category_job_items', { param: 'itemId' }), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const { rows } = await pgPool.query(
    `SELECT i.*, j.loja, j.category_ids AS job_category_ids
     FROM bulk_category_job_items i JOIN bulk_category_jobs j ON j.id = i.job_id
     WHERE i.id = $1`,
    [req.params.itemId]
  );
  if (!rows.length) return res.status(404).json({ error: 'item não encontrado' });
  const item = rows[0];
  const categoryIds = item.categoria_ids_alvo != null ? item.categoria_ids_alvo : item.job_category_ids;
  const path = `/v1/stores/products/${item.product_id}`;
  const bodyEnviado = { collections: categoryIds };
  const chamadas = [];

  // Payload completo do produto ANTES do PATCH (tipo, status, categoria antiga se a Ink expusesse
  // — não expõe, mas o resto do payload já ajuda a diagnosticar). Best-effort: se falhar, não
  // trava o resto do debug.
  let produtoAtual = null;
  let produtoAtualErro = null;
  try {
    const dataProduto = await inkApiRequest(item.loja, path);
    produtoAtual = dataProduto.product || dataProduto;
    chamadas.push({ titulo: 'Buscar produto (payload completo)', method: 'GET', path, status: 200, response: dataProduto, ocorreuEm: new Date().toISOString() });
  } catch (err) {
    produtoAtualErro = { status: err.status || null, message: err.message, details: err.details || null };
    chamadas.push({ titulo: 'Buscar produto (payload completo)', method: 'GET', path, status: err.status || null, response: err.details || { message: err.message }, ocorreuEm: new Date().toISOString() });
  }
  console.log(`[DEBUG_ORIGENS_MIGRATION] item ${item.id} (produto ${item.product_id}, loja ${item.loja}) — produto atual: ${JSON.stringify(produtoAtual || produtoAtualErro)}`);

  const idempotencyKey = `debug:${crypto.randomUUID()}`;
  const requestInfo = { method: 'PATCH', path, idempotencyKey, body: bodyEnviado };
  console.log(`[DEBUG_ORIGENS_MIGRATION] testando item ${item.id} — request: ${JSON.stringify(requestInfo)}`);

  try {
    const resposta = await inkApiPatch(item.loja, path, bodyEnviado, { 'Idempotency-Key': idempotencyKey });
    chamadas.push({ titulo: 'Atualizar categoria (PATCH)', method: 'PATCH', path, idempotencyKey, body: bodyEnviado, status: 200, response: resposta, ocorreuEm: new Date().toISOString() });
    console.log(`[DEBUG_ORIGENS_MIGRATION] item ${item.id} — sucesso: ${JSON.stringify(resposta)}`);
    await pgPool.query(
      `UPDATE bulk_category_job_items SET status = 'success', categories_after = $1::jsonb, error = NULL, attempts = attempts + 1, atualizado_em = now() WHERE id = $2`,
      [JSON.stringify(categoryIds), item.id]
    );
    await atualizarContadoresBulkCategoryJob(item.job_id);
    return res.json({ produtoAtual, produtoAtualErro, request: requestInfo, success: true, response: resposta, requests: chamadas });
  } catch (err) {
    const respostaErro = { status: err.status || null, message: err.message, details: err.details || null };
    chamadas.push({ titulo: 'Atualizar categoria (PATCH)', method: 'PATCH', path, idempotencyKey, body: bodyEnviado, status: err.status || null, response: err.details || { message: err.message }, ocorreuEm: new Date().toISOString() });
    console.error(`[DEBUG_ORIGENS_MIGRATION] item ${item.id} — falha: ${JSON.stringify(respostaErro)}`);
    await pgPool.query(
      `UPDATE bulk_category_job_items SET status = 'failed', error = $1, attempts = attempts + 1, atualizado_em = now() WHERE id = $2`,
      [`${err.message}${err.details ? ' — ' + JSON.stringify(err.details) : ''}`.slice(0, 500), item.id]
    );
    await atualizarContadoresBulkCategoryJob(item.job_id);
    return res.json({ produtoAtual, produtoAtualErro, request: requestInfo, success: false, response: respostaErro, requests: chamadas });
  }
});

// Também serve pra RETOMAR um job cancelado (bug real corrigido, 2026-09-09): antes só reativava
// job 'completed_with_errors'/'failed' — um job 'cancelled' tinha os itens 'failed' resetados pra
// 'pending' (por isso parecia "limpar a tabela de erros"), mas o job em si nunca voltava a
// 'running', e o processarBulkCategoryJobs só pega jobs 'queued'/'running' — ficava pending pra
// sempre. Itens que nunca chegaram a ser tentados (ainda 'pending' de um cancelamento no meio do
// caminho) também retomam sozinhos assim que o job volta a rodar, sem precisar ter falhado antes.
app.post('/api/admin/category-jobs/:id/retry-failed', requireAdmin, exigirRecurso('bulk_category_jobs'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'category-jobs exige Postgres configurado' });
  await pgPool.query(
    `UPDATE bulk_category_job_items SET status = 'pending', attempts = 0, error = NULL, atualizado_em = now() WHERE job_id = $1 AND status = 'failed'`,
    [req.params.id]
  );
  await pgPool.query(
    `UPDATE bulk_category_jobs SET status = 'running', finalizado_em = NULL, atualizado_em = now() WHERE id = $1 AND status IN ('completed_with_errors', 'failed', 'cancelled')`,
    [req.params.id]
  );
  res.json({ ok: true });
});

app.post('/api/admin/category-jobs/:id/cancel', requireAdmin, exigirRecurso('bulk_category_jobs'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'category-jobs exige Postgres configurado' });
  await pgPool.query(
    `UPDATE bulk_category_jobs SET status = 'cancelled', finalizado_em = now(), atualizado_em = now() WHERE id = $1 AND status IN ('queued', 'running')`,
    [req.params.id]
  );
  res.json({ ok: true });
});

app.get('/api/admin/internal-tools/status', requireAdmin, (req, res) => {
  res.json({ enabled: INTERNAL_TOOLS_ENABLED });
});

// ── "Migração Use Origens" (Partes 4-7 do doc de categorias em lote) ────
// Ferramenta interna, não exposta a clientes SaaS normais (requireInternalTools em toda rota).
function normalizarTextoMatch(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos só pra comparação
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

// Testa 1 operador contra 1 string já normalizada — mesma lógica pras 2 fontes possíveis
// (product_name ou current_category), só muda contra o quê é comparado.
function testarOperador(str, operator, valor) {
  switch (operator) {
    case 'contains': return str.includes(valor);
    case 'not_contains': return !str.includes(valor);
    case 'starts_with': return str.startsWith(valor);
    case 'ends_with': return str.endsWith(valor);
    case 'equals': return str === valor;
    default: return false;
  }
}

// `contexto` = { nomeNormalizado, categoriasAtuaisNormalizadas } — categoriasAtuaisNormalizadas é
// o array de nomes (já normalizados) de TODAS as categorias que o produto tem HOJE (doc: Grupo B,
// coleções especiais só identificáveis pela categoria de origem, não pelo título).
//
// Um produto pode estar em VÁRIAS categorias ao mesmo tempo, então o campo current_category
// compara contra um CONJUNTO, não uma string só — semântica por operador:
// - contains/starts_with/ends_with/equals: SOME (basta 1 categoria atual bater);
// - not_contains: EVERY (NENHUMA categoria atual pode bater, senão a condição não é satisfeita).
// Sem categoria nenhuma: not_contains é verdadeiro (vacuously), os demais são falsos (não tem o
// que bater).
function condicaoBate(contexto, condicao) {
  const valor = normalizarTextoMatch(condicao.value);
  if (condicao.field === 'current_category') {
    const categorias = contexto.categoriasAtuaisNormalizadas || [];
    if (!categorias.length) return condicao.operator === 'not_contains';
    return condicao.operator === 'not_contains'
      ? categorias.every((c) => testarOperador(c, condicao.operator, valor))
      : categorias.some((c) => testarOperador(c, condicao.operator, valor));
  }
  return testarOperador(contexto.nomeNormalizado, condicao.operator, valor);
}

// Regra bate se TODAS as suas condições baterem (AND) — permite "contém X E não contém Y" numa
// regra só, e permite misturar condições de fontes diferentes (nome + categoria atual) na mesma
// regra. Regra sem nenhuma condição nunca bate (evita "bater em tudo" por engano).
function regraBate(contexto, regra) {
  const condicoes = regra.condicoes || [];
  if (!condicoes.length) return false;
  return condicoes.every((c) => condicaoBate(contexto, c));
}

// ── Preload de regras padrão + fallback cidade→UF (doc:
// claude-preload-regras-use-origens-cidade-uf.md) ───────────────────────────
const PRESET_COLECOES = ['Origem', 'Legado', 'Coordenadas', 'Tipografia', 'Traço', 'Território', 'Feito Em', 'Gentilico'];
const PRESET_UFS = ['RS', 'SC', 'PR'];

// ── Preset de "coleções especiais" (Grupo B, doc: claude-migracao-final-categorias-snapshot-
// especiais.md) — produtos que só dá pra classificar pela categoria ATUAL (não pelo nome), porque
// o título não identifica a coleção. Mapeamento fixo, Etapa 3 do doc: categoria de origem (antiga,
// pode não existir em toda loja) → categoria de destino (pública, nova).
// Dicionário cidade→UF pra região Sul (RS/SC/PR) — pedido do usuário, 2026-09-10: vários
// produtos "Feito em {cidade}"/"{cidade} | Coordenadas" (sem UF explícita no nome) caíam em
// conflito "cidade sem UF mapeada" (ex: Zortéa, Xaxim, Balneário Camboriú, São Francisco do
// Sul). Fonte: dataset kelvins/municipios-brasileiros (github.com/kelvins/municipios-brasileiros,
// derivado do IBGE), filtrado pelos 3 estados da região Sul via código UF do IBGE (41=PR, 42=SC,
// 43=RS). 1191 municípios ao todo em RS+SC+PR; 13 nomes se repetem entre 2 desses estados
// (ex: "Barracão" existe em RS e PR, "Bom Jesus" em SC e RS) — esses 26 municípios (13 pares)
// foram EXCLUÍDOS do dicionário automático de propósito, por ambiguidade real (o sistema não tem
// como saber de qual estado é só pelo nome) — ficam pra mapeamento manual se aparecerem em
// produto. Sobraram 1165 municípios não-ambíguos: 489 RS, 288 SC, 388 PR.
const MUNICIPIOS_SUL = [
  { cidade: 'Abatiá', uf: 'PR' },
  { cidade: 'Abdon Batista', uf: 'SC' },
  { cidade: 'Abelardo Luz', uf: 'SC' },
  { cidade: 'Aceguá', uf: 'RS' },
  { cidade: 'Adrianópolis', uf: 'PR' },
  { cidade: 'Agrolândia', uf: 'SC' },
  { cidade: 'Agronômica', uf: 'SC' },
  { cidade: 'Água Doce', uf: 'SC' },
  { cidade: 'Água Santa', uf: 'RS' },
  { cidade: 'Águas de Chapecó', uf: 'SC' },
  { cidade: 'Águas Frias', uf: 'SC' },
  { cidade: 'Águas Mornas', uf: 'SC' },
  { cidade: 'Agudo', uf: 'RS' },
  { cidade: 'Agudos do Sul', uf: 'PR' },
  { cidade: 'Ajuricaba', uf: 'RS' },
  { cidade: 'Alecrim', uf: 'RS' },
  { cidade: 'Alegrete', uf: 'RS' },
  { cidade: 'Alegria', uf: 'RS' },
  { cidade: 'Alfredo Wagner', uf: 'SC' },
  { cidade: 'Almirante Tamandaré', uf: 'PR' },
  { cidade: 'Almirante Tamandaré do Sul', uf: 'RS' },
  { cidade: 'Alpestre', uf: 'RS' },
  { cidade: 'Altamira do Paraná', uf: 'PR' },
  { cidade: 'Alto Alegre', uf: 'RS' },
  { cidade: 'Alto Bela Vista', uf: 'SC' },
  { cidade: 'Alto Feliz', uf: 'RS' },
  { cidade: 'Alto Paraíso', uf: 'PR' },
  { cidade: 'Alto Paraná', uf: 'PR' },
  { cidade: 'Alto Piquiri', uf: 'PR' },
  { cidade: 'Altônia', uf: 'PR' },
  { cidade: 'Alvorada', uf: 'RS' },
  { cidade: 'Alvorada do Sul', uf: 'PR' },
  { cidade: 'Amaporã', uf: 'PR' },
  { cidade: 'Amaral Ferrador', uf: 'RS' },
  { cidade: 'Ametista do Sul', uf: 'RS' },
  { cidade: 'Ampére', uf: 'PR' },
  { cidade: 'Anahy', uf: 'PR' },
  { cidade: 'Anchieta', uf: 'SC' },
  { cidade: 'Andirá', uf: 'PR' },
  { cidade: 'André da Rocha', uf: 'RS' },
  { cidade: 'Angelina', uf: 'SC' },
  { cidade: 'Ângulo', uf: 'PR' },
  { cidade: 'Anita Garibaldi', uf: 'SC' },
  { cidade: 'Anitápolis', uf: 'SC' },
  { cidade: 'Anta Gorda', uf: 'RS' },
  { cidade: 'Antonina', uf: 'PR' },
  { cidade: 'Antônio Carlos', uf: 'SC' },
  { cidade: 'Antônio Olinto', uf: 'PR' },
  { cidade: 'Antônio Prado', uf: 'RS' },
  { cidade: 'Apiúna', uf: 'SC' },
  { cidade: 'Apucarana', uf: 'PR' },
  { cidade: 'Arabutã', uf: 'SC' },
  { cidade: 'Arambaré', uf: 'RS' },
  { cidade: 'Arapongas', uf: 'PR' },
  { cidade: 'Arapoti', uf: 'PR' },
  { cidade: 'Arapuã', uf: 'PR' },
  { cidade: 'Araquari', uf: 'SC' },
  { cidade: 'Araranguá', uf: 'SC' },
  { cidade: 'Araricá', uf: 'RS' },
  { cidade: 'Araruna', uf: 'PR' },
  { cidade: 'Aratiba', uf: 'RS' },
  { cidade: 'Araucária', uf: 'PR' },
  { cidade: 'Ariranha do Ivaí', uf: 'PR' },
  { cidade: 'Armazém', uf: 'SC' },
  { cidade: 'Arroio do Meio', uf: 'RS' },
  { cidade: 'Arroio do Padre', uf: 'RS' },
  { cidade: 'Arroio do Sal', uf: 'RS' },
  { cidade: 'Arroio do Tigre', uf: 'RS' },
  { cidade: 'Arroio dos Ratos', uf: 'RS' },
  { cidade: 'Arroio Grande', uf: 'RS' },
  { cidade: 'Arroio Trinta', uf: 'SC' },
  { cidade: 'Arvoredo', uf: 'SC' },
  { cidade: 'Arvorezinha', uf: 'RS' },
  { cidade: 'Ascurra', uf: 'SC' },
  { cidade: 'Assaí', uf: 'PR' },
  { cidade: 'Assis Chateaubriand', uf: 'PR' },
  { cidade: 'Astorga', uf: 'PR' },
  { cidade: 'Atalaia', uf: 'PR' },
  { cidade: 'Atalanta', uf: 'SC' },
  { cidade: 'Augusto Pestana', uf: 'RS' },
  { cidade: 'Áurea', uf: 'RS' },
  { cidade: 'Aurora', uf: 'SC' },
  { cidade: 'Bagé', uf: 'RS' },
  { cidade: 'Balneário Arroio do Silva', uf: 'SC' },
  { cidade: 'Balneário Barra do Sul', uf: 'SC' },
  { cidade: 'Balneário Camboriú', uf: 'SC' },
  { cidade: 'Balneário Gaivota', uf: 'SC' },
  { cidade: 'Balneário Piçarras', uf: 'SC' },
  { cidade: 'Balneário Pinhal', uf: 'RS' },
  { cidade: 'Balneário Rincão', uf: 'SC' },
  { cidade: 'Balsa Nova', uf: 'PR' },
  { cidade: 'Bandeirante', uf: 'SC' },
  { cidade: 'Bandeirantes', uf: 'PR' },
  { cidade: 'Barão', uf: 'RS' },
  { cidade: 'Barão de Cotegipe', uf: 'RS' },
  { cidade: 'Barão do Triunfo', uf: 'RS' },
  { cidade: 'Barbosa Ferraz', uf: 'PR' },
  { cidade: 'Barra Bonita', uf: 'SC' },
  { cidade: 'Barra do Guarita', uf: 'RS' },
  { cidade: 'Barra do Jacaré', uf: 'PR' },
  { cidade: 'Barra do Quaraí', uf: 'RS' },
  { cidade: 'Barra do Ribeiro', uf: 'RS' },
  { cidade: 'Barra do Rio Azul', uf: 'RS' },
  { cidade: 'Barra Funda', uf: 'RS' },
  { cidade: 'Barra Velha', uf: 'SC' },
  { cidade: 'Barros Cassal', uf: 'RS' },
  { cidade: 'Bela Vista da Caroba', uf: 'PR' },
  { cidade: 'Bela Vista do Paraíso', uf: 'PR' },
  { cidade: 'Bela Vista do Toldo', uf: 'SC' },
  { cidade: 'Belmonte', uf: 'SC' },
  { cidade: 'Benedito Novo', uf: 'SC' },
  { cidade: 'Benjamin Constant do Sul', uf: 'RS' },
  { cidade: 'Bento Gonçalves', uf: 'RS' },
  { cidade: 'Biguaçu', uf: 'SC' },
  { cidade: 'Bituruna', uf: 'PR' },
  { cidade: 'Blumenau', uf: 'SC' },
  { cidade: 'Boa Esperança', uf: 'PR' },
  { cidade: 'Boa Esperança do Iguaçu', uf: 'PR' },
  { cidade: 'Boa Ventura de São Roque', uf: 'PR' },
  { cidade: 'Boa Vista da Aparecida', uf: 'PR' },
  { cidade: 'Boa Vista das Missões', uf: 'RS' },
  { cidade: 'Boa Vista do Buricá', uf: 'RS' },
  { cidade: 'Boa Vista do Cadeado', uf: 'RS' },
  { cidade: 'Boa Vista do Incra', uf: 'RS' },
  { cidade: 'Boa Vista do Sul', uf: 'RS' },
  { cidade: 'Bocaina do Sul', uf: 'SC' },
  { cidade: 'Bocaiúva do Sul', uf: 'PR' },
  { cidade: 'Bom Jardim da Serra', uf: 'SC' },
  { cidade: 'Bom Jesus do Oeste', uf: 'SC' },
  { cidade: 'Bom Jesus do Sul', uf: 'PR' },
  { cidade: 'Bom Princípio', uf: 'RS' },
  { cidade: 'Bom Progresso', uf: 'RS' },
  { cidade: 'Bom Retiro', uf: 'SC' },
  { cidade: 'Bom Retiro do Sul', uf: 'RS' },
  { cidade: 'Bom Sucesso', uf: 'PR' },
  { cidade: 'Bom Sucesso do Sul', uf: 'PR' },
  { cidade: 'Bombinhas', uf: 'SC' },
  { cidade: 'Boqueirão do Leão', uf: 'RS' },
  { cidade: 'Borrazópolis', uf: 'PR' },
  { cidade: 'Bossoroca', uf: 'RS' },
  { cidade: 'Botuverá', uf: 'SC' },
  { cidade: 'Bozano', uf: 'RS' },
  { cidade: 'Braço do Norte', uf: 'SC' },
  { cidade: 'Braço do Trombudo', uf: 'SC' },
  { cidade: 'Braga', uf: 'RS' },
  { cidade: 'Braganey', uf: 'PR' },
  { cidade: 'Brasilândia do Sul', uf: 'PR' },
  { cidade: 'Brochier', uf: 'RS' },
  { cidade: 'Brunópolis', uf: 'SC' },
  { cidade: 'Brusque', uf: 'SC' },
  { cidade: 'Butiá', uf: 'RS' },
  { cidade: 'Caçador', uf: 'SC' },
  { cidade: 'Caçapava do Sul', uf: 'RS' },
  { cidade: 'Cacequi', uf: 'RS' },
  { cidade: 'Cachoeira do Sul', uf: 'RS' },
  { cidade: 'Cachoeirinha', uf: 'RS' },
  { cidade: 'Cacique Doble', uf: 'RS' },
  { cidade: 'Cafeara', uf: 'PR' },
  { cidade: 'Cafelândia', uf: 'PR' },
  { cidade: 'Cafezal do Sul', uf: 'PR' },
  { cidade: 'Caibaté', uf: 'RS' },
  { cidade: 'Caibi', uf: 'SC' },
  { cidade: 'Caiçara', uf: 'RS' },
  { cidade: 'Califórnia', uf: 'PR' },
  { cidade: 'Calmon', uf: 'SC' },
  { cidade: 'Camaquã', uf: 'RS' },
  { cidade: 'Camargo', uf: 'RS' },
  { cidade: 'Cambará', uf: 'PR' },
  { cidade: 'Cambará do Sul', uf: 'RS' },
  { cidade: 'Cambé', uf: 'PR' },
  { cidade: 'Cambira', uf: 'PR' },
  { cidade: 'Camboriú', uf: 'SC' },
  { cidade: 'Campestre da Serra', uf: 'RS' },
  { cidade: 'Campina da Lagoa', uf: 'PR' },
  { cidade: 'Campina das Missões', uf: 'RS' },
  { cidade: 'Campina do Simão', uf: 'PR' },
  { cidade: 'Campina Grande do Sul', uf: 'PR' },
  { cidade: 'Campinas do Sul', uf: 'RS' },
  { cidade: 'Campo Alegre', uf: 'SC' },
  { cidade: 'Campo Belo do Sul', uf: 'SC' },
  { cidade: 'Campo Bom', uf: 'RS' },
  { cidade: 'Campo Bonito', uf: 'PR' },
  { cidade: 'Campo do Tenente', uf: 'PR' },
  { cidade: 'Campo Erê', uf: 'SC' },
  { cidade: 'Campo Largo', uf: 'PR' },
  { cidade: 'Campo Magro', uf: 'PR' },
  { cidade: 'Campo Mourão', uf: 'PR' },
  { cidade: 'Campo Novo', uf: 'RS' },
  { cidade: 'Campos Borges', uf: 'RS' },
  { cidade: 'Campos Novos', uf: 'SC' },
  { cidade: 'Candelária', uf: 'RS' },
  { cidade: 'Cândido de Abreu', uf: 'PR' },
  { cidade: 'Cândido Godói', uf: 'RS' },
  { cidade: 'Candiota', uf: 'RS' },
  { cidade: 'Candói', uf: 'PR' },
  { cidade: 'Canela', uf: 'RS' },
  { cidade: 'Canelinha', uf: 'SC' },
  { cidade: 'Canguçu', uf: 'RS' },
  { cidade: 'Canoas', uf: 'RS' },
  { cidade: 'Canoinhas', uf: 'SC' },
  { cidade: 'Cantagalo', uf: 'PR' },
  { cidade: 'Canudos do Vale', uf: 'RS' },
  { cidade: 'Capanema', uf: 'PR' },
  { cidade: 'Capão Alto', uf: 'SC' },
  { cidade: 'Capão Bonito do Sul', uf: 'RS' },
  { cidade: 'Capão da Canoa', uf: 'RS' },
  { cidade: 'Capão do Cipó', uf: 'RS' },
  { cidade: 'Capão do Leão', uf: 'RS' },
  { cidade: 'Capela de Santana', uf: 'RS' },
  { cidade: 'Capinzal', uf: 'SC' },
  { cidade: 'Capitão', uf: 'RS' },
  { cidade: 'Capitão Leônidas Marques', uf: 'PR' },
  { cidade: 'Capivari de Baixo', uf: 'SC' },
  { cidade: 'Capivari do Sul', uf: 'RS' },
  { cidade: 'Caraá', uf: 'RS' },
  { cidade: 'Carambeí', uf: 'PR' },
  { cidade: 'Carazinho', uf: 'RS' },
  { cidade: 'Carlópolis', uf: 'PR' },
  { cidade: 'Carlos Barbosa', uf: 'RS' },
  { cidade: 'Carlos Gomes', uf: 'RS' },
  { cidade: 'Casca', uf: 'RS' },
  { cidade: 'Cascavel', uf: 'PR' },
  { cidade: 'Caseiros', uf: 'RS' },
  { cidade: 'Castro', uf: 'PR' },
  { cidade: 'Catuípe', uf: 'RS' },
  { cidade: 'Caxambu do Sul', uf: 'SC' },
  { cidade: 'Caxias do Sul', uf: 'RS' },
  { cidade: 'Celso Ramos', uf: 'SC' },
  { cidade: 'Centenário', uf: 'RS' },
  { cidade: 'Centenário do Sul', uf: 'PR' },
  { cidade: 'Cerrito', uf: 'RS' },
  { cidade: 'Cerro Azul', uf: 'PR' },
  { cidade: 'Cerro Branco', uf: 'RS' },
  { cidade: 'Cerro Grande', uf: 'RS' },
  { cidade: 'Cerro Grande do Sul', uf: 'RS' },
  { cidade: 'Cerro Largo', uf: 'RS' },
  { cidade: 'Cerro Negro', uf: 'SC' },
  { cidade: 'Céu Azul', uf: 'PR' },
  { cidade: 'Chapada', uf: 'RS' },
  { cidade: 'Chapadão do Lageado', uf: 'SC' },
  { cidade: 'Chapecó', uf: 'SC' },
  { cidade: 'Charqueadas', uf: 'RS' },
  { cidade: 'Charrua', uf: 'RS' },
  { cidade: 'Chiapetta', uf: 'RS' },
  { cidade: 'Chopinzinho', uf: 'PR' },
  { cidade: 'Chuí', uf: 'RS' },
  { cidade: 'Chuvisca', uf: 'RS' },
  { cidade: 'Cianorte', uf: 'PR' },
  { cidade: 'Cidade Gaúcha', uf: 'PR' },
  { cidade: 'Cidreira', uf: 'RS' },
  { cidade: 'Ciríaco', uf: 'RS' },
  { cidade: 'Clevelândia', uf: 'PR' },
  { cidade: 'Cocal do Sul', uf: 'SC' },
  { cidade: 'Colinas', uf: 'RS' },
  { cidade: 'Colombo', uf: 'PR' },
  { cidade: 'Concórdia', uf: 'SC' },
  { cidade: 'Condor', uf: 'RS' },
  { cidade: 'Congonhinhas', uf: 'PR' },
  { cidade: 'Conselheiro Mairinck', uf: 'PR' },
  { cidade: 'Constantina', uf: 'RS' },
  { cidade: 'Contenda', uf: 'PR' },
  { cidade: 'Coqueiro Baixo', uf: 'RS' },
  { cidade: 'Coqueiros do Sul', uf: 'RS' },
  { cidade: 'Corbélia', uf: 'PR' },
  { cidade: 'Cordilheira Alta', uf: 'SC' },
  { cidade: 'Cornélio Procópio', uf: 'PR' },
  { cidade: 'Coronel Barros', uf: 'RS' },
  { cidade: 'Coronel Bicaco', uf: 'RS' },
  { cidade: 'Coronel Domingos Soares', uf: 'PR' },
  { cidade: 'Coronel Freitas', uf: 'SC' },
  { cidade: 'Coronel Martins', uf: 'SC' },
  { cidade: 'Coronel Pilar', uf: 'RS' },
  { cidade: 'Coronel Vivida', uf: 'PR' },
  { cidade: 'Correia Pinto', uf: 'SC' },
  { cidade: 'Corumbataí do Sul', uf: 'PR' },
  { cidade: 'Corupá', uf: 'SC' },
  { cidade: 'Cotiporã', uf: 'RS' },
  { cidade: 'Coxilha', uf: 'RS' },
  { cidade: 'Criciúma', uf: 'SC' },
  { cidade: 'Crissiumal', uf: 'RS' },
  { cidade: 'Cristal', uf: 'RS' },
  { cidade: 'Cristal do Sul', uf: 'RS' },
  { cidade: 'Cruz Alta', uf: 'RS' },
  { cidade: 'Cruz Machado', uf: 'PR' },
  { cidade: 'Cruzaltense', uf: 'RS' },
  { cidade: 'Cruzeiro do Iguaçu', uf: 'PR' },
  { cidade: 'Cruzeiro do Oeste', uf: 'PR' },
  { cidade: 'Cruzmaltina', uf: 'PR' },
  { cidade: 'Cunha Porã', uf: 'SC' },
  { cidade: 'Cunhataí', uf: 'SC' },
  { cidade: 'Curitiba', uf: 'PR' },
  { cidade: 'Curitibanos', uf: 'SC' },
  { cidade: 'Curiúva', uf: 'PR' },
  { cidade: 'David Canabarro', uf: 'RS' },
  { cidade: 'Derrubadas', uf: 'RS' },
  { cidade: 'Descanso', uf: 'SC' },
  { cidade: 'Dezesseis de Novembro', uf: 'RS' },
  { cidade: 'Diamante D\'Oeste', uf: 'PR' },
  { cidade: 'Diamante do Norte', uf: 'PR' },
  { cidade: 'Diamante do Sul', uf: 'PR' },
  { cidade: 'Dilermando de Aguiar', uf: 'RS' },
  { cidade: 'Dionísio Cerqueira', uf: 'SC' },
  { cidade: 'Dois Irmãos', uf: 'RS' },
  { cidade: 'Dois Irmãos das Missões', uf: 'RS' },
  { cidade: 'Dois Lajeados', uf: 'RS' },
  { cidade: 'Dois Vizinhos', uf: 'PR' },
  { cidade: 'Dom Feliciano', uf: 'RS' },
  { cidade: 'Dom Pedrito', uf: 'RS' },
  { cidade: 'Dom Pedro de Alcântara', uf: 'RS' },
  { cidade: 'Dona Emma', uf: 'SC' },
  { cidade: 'Dona Francisca', uf: 'RS' },
  { cidade: 'Douradina', uf: 'PR' },
  { cidade: 'Doutor Camargo', uf: 'PR' },
  { cidade: 'Doutor Maurício Cardoso', uf: 'RS' },
  { cidade: 'Doutor Pedrinho', uf: 'SC' },
  { cidade: 'Doutor Ricardo', uf: 'RS' },
  { cidade: 'Doutor Ulysses', uf: 'PR' },
  { cidade: 'Eldorado do Sul', uf: 'RS' },
  { cidade: 'Encantado', uf: 'RS' },
  { cidade: 'Encruzilhada do Sul', uf: 'RS' },
  { cidade: 'Enéas Marques', uf: 'PR' },
  { cidade: 'Engenheiro Beltrão', uf: 'PR' },
  { cidade: 'Engenho Velho', uf: 'RS' },
  { cidade: 'Entre Rios', uf: 'SC' },
  { cidade: 'Entre Rios do Oeste', uf: 'PR' },
  { cidade: 'Entre Rios do Sul', uf: 'RS' },
  { cidade: 'Entre-Ijuís', uf: 'RS' },
  { cidade: 'Erebango', uf: 'RS' },
  { cidade: 'Erechim', uf: 'RS' },
  { cidade: 'Ermo', uf: 'SC' },
  { cidade: 'Ernestina', uf: 'RS' },
  { cidade: 'Erval Grande', uf: 'RS' },
  { cidade: 'Erval Seco', uf: 'RS' },
  { cidade: 'Erval Velho', uf: 'SC' },
  { cidade: 'Esmeralda', uf: 'RS' },
  { cidade: 'Esperança do Sul', uf: 'RS' },
  { cidade: 'Esperança Nova', uf: 'PR' },
  { cidade: 'Espigão Alto do Iguaçu', uf: 'PR' },
  { cidade: 'Espumoso', uf: 'RS' },
  { cidade: 'Estação', uf: 'RS' },
  { cidade: 'Estância Velha', uf: 'RS' },
  { cidade: 'Esteio', uf: 'RS' },
  { cidade: 'Estrela', uf: 'RS' },
  { cidade: 'Estrela Velha', uf: 'RS' },
  { cidade: 'Eugênio de Castro', uf: 'RS' },
  { cidade: 'Fagundes Varela', uf: 'RS' },
  { cidade: 'Farol', uf: 'PR' },
  { cidade: 'Farroupilha', uf: 'RS' },
  { cidade: 'Faxinal', uf: 'PR' },
  { cidade: 'Faxinal do Soturno', uf: 'RS' },
  { cidade: 'Faxinal dos Guedes', uf: 'SC' },
  { cidade: 'Faxinalzinho', uf: 'RS' },
  { cidade: 'Fazenda Rio Grande', uf: 'PR' },
  { cidade: 'Fazenda Vilanova', uf: 'RS' },
  { cidade: 'Feliz', uf: 'RS' },
  { cidade: 'Fênix', uf: 'PR' },
  { cidade: 'Fernandes Pinheiro', uf: 'PR' },
  { cidade: 'Figueira', uf: 'PR' },
  { cidade: 'Flor da Serra do Sul', uf: 'PR' },
  { cidade: 'Flor do Sertão', uf: 'SC' },
  { cidade: 'Floraí', uf: 'PR' },
  { cidade: 'Flores da Cunha', uf: 'RS' },
  { cidade: 'Floresta', uf: 'PR' },
  { cidade: 'Florestópolis', uf: 'PR' },
  { cidade: 'Floriano Peixoto', uf: 'RS' },
  { cidade: 'Florianópolis', uf: 'SC' },
  { cidade: 'Flórida', uf: 'PR' },
  { cidade: 'Fontoura Xavier', uf: 'RS' },
  { cidade: 'Formigueiro', uf: 'RS' },
  { cidade: 'Formosa do Oeste', uf: 'PR' },
  { cidade: 'Formosa do Sul', uf: 'SC' },
  { cidade: 'Forquetinha', uf: 'RS' },
  { cidade: 'Forquilhinha', uf: 'SC' },
  { cidade: 'Fortaleza dos Valos', uf: 'RS' },
  { cidade: 'Foz do Iguaçu', uf: 'PR' },
  { cidade: 'Foz do Jordão', uf: 'PR' },
  { cidade: 'Fraiburgo', uf: 'SC' },
  { cidade: 'Francisco Alves', uf: 'PR' },
  { cidade: 'Francisco Beltrão', uf: 'PR' },
  { cidade: 'Frederico Westphalen', uf: 'RS' },
  { cidade: 'Frei Rogério', uf: 'SC' },
  { cidade: 'Galvão', uf: 'SC' },
  { cidade: 'Garibaldi', uf: 'RS' },
  { cidade: 'Garopaba', uf: 'SC' },
  { cidade: 'Garruchos', uf: 'RS' },
  { cidade: 'Garuva', uf: 'SC' },
  { cidade: 'Gaspar', uf: 'SC' },
  { cidade: 'Gaurama', uf: 'RS' },
  { cidade: 'General Câmara', uf: 'RS' },
  { cidade: 'General Carneiro', uf: 'PR' },
  { cidade: 'Gentil', uf: 'RS' },
  { cidade: 'Getúlio Vargas', uf: 'RS' },
  { cidade: 'Giruá', uf: 'RS' },
  { cidade: 'Glorinha', uf: 'RS' },
  { cidade: 'Godoy Moreira', uf: 'PR' },
  { cidade: 'Goioerê', uf: 'PR' },
  { cidade: 'Goioxim', uf: 'PR' },
  { cidade: 'Governador Celso Ramos', uf: 'SC' },
  { cidade: 'Gramado', uf: 'RS' },
  { cidade: 'Gramado dos Loureiros', uf: 'RS' },
  { cidade: 'Gramado Xavier', uf: 'RS' },
  { cidade: 'Grandes Rios', uf: 'PR' },
  { cidade: 'Grão Pará', uf: 'SC' },
  { cidade: 'Gravataí', uf: 'RS' },
  { cidade: 'Gravatal', uf: 'SC' },
  { cidade: 'Guabiju', uf: 'RS' },
  { cidade: 'Guabiruba', uf: 'SC' },
  { cidade: 'Guaíba', uf: 'RS' },
  { cidade: 'Guaíra', uf: 'PR' },
  { cidade: 'Guairaçá', uf: 'PR' },
  { cidade: 'Guamiranga', uf: 'PR' },
  { cidade: 'Guapirama', uf: 'PR' },
  { cidade: 'Guaporé', uf: 'RS' },
  { cidade: 'Guaporema', uf: 'PR' },
  { cidade: 'Guaraci', uf: 'PR' },
  { cidade: 'Guaraciaba', uf: 'SC' },
  { cidade: 'Guaramirim', uf: 'SC' },
  { cidade: 'Guarani das Missões', uf: 'RS' },
  { cidade: 'Guaraniaçu', uf: 'PR' },
  { cidade: 'Guarapuava', uf: 'PR' },
  { cidade: 'Guaraqueçaba', uf: 'PR' },
  { cidade: 'Guaratuba', uf: 'PR' },
  { cidade: 'Guarujá do Sul', uf: 'SC' },
  { cidade: 'Guatambú', uf: 'SC' },
  { cidade: 'Harmonia', uf: 'RS' },
  { cidade: 'Herval', uf: 'RS' },
  { cidade: 'Herval d\'Oeste', uf: 'SC' },
  { cidade: 'Herveiras', uf: 'RS' },
  { cidade: 'Honório Serpa', uf: 'PR' },
  { cidade: 'Horizontina', uf: 'RS' },
  { cidade: 'Hulha Negra', uf: 'RS' },
  { cidade: 'Humaitá', uf: 'RS' },
  { cidade: 'Ibaiti', uf: 'PR' },
  { cidade: 'Ibarama', uf: 'RS' },
  { cidade: 'Ibema', uf: 'PR' },
  { cidade: 'Ibiaçá', uf: 'RS' },
  { cidade: 'Ibiam', uf: 'SC' },
  { cidade: 'Ibicaré', uf: 'SC' },
  { cidade: 'Ibiporã', uf: 'PR' },
  { cidade: 'Ibiraiaras', uf: 'RS' },
  { cidade: 'Ibirama', uf: 'SC' },
  { cidade: 'Ibirapuitã', uf: 'RS' },
  { cidade: 'Ibirubá', uf: 'RS' },
  { cidade: 'Içara', uf: 'SC' },
  { cidade: 'Icaraíma', uf: 'PR' },
  { cidade: 'Igrejinha', uf: 'RS' },
  { cidade: 'Iguaraçu', uf: 'PR' },
  { cidade: 'Iguatu', uf: 'PR' },
  { cidade: 'Ijuí', uf: 'RS' },
  { cidade: 'Ilhota', uf: 'SC' },
  { cidade: 'Ilópolis', uf: 'RS' },
  { cidade: 'Imaruí', uf: 'SC' },
  { cidade: 'Imbaú', uf: 'PR' },
  { cidade: 'Imbé', uf: 'RS' },
  { cidade: 'Imbituba', uf: 'SC' },
  { cidade: 'Imbituva', uf: 'PR' },
  { cidade: 'Imbuia', uf: 'SC' },
  { cidade: 'Imigrante', uf: 'RS' },
  { cidade: 'Inácio Martins', uf: 'PR' },
  { cidade: 'Inajá', uf: 'PR' },
  { cidade: 'Indaial', uf: 'SC' },
  { cidade: 'Independência', uf: 'RS' },
  { cidade: 'Indianópolis', uf: 'PR' },
  { cidade: 'Inhacorá', uf: 'RS' },
  { cidade: 'Iomerê', uf: 'SC' },
  { cidade: 'Ipê', uf: 'RS' },
  { cidade: 'Ipira', uf: 'SC' },
  { cidade: 'Ipiranga', uf: 'PR' },
  { cidade: 'Ipiranga do Sul', uf: 'RS' },
  { cidade: 'Iporã', uf: 'PR' },
  { cidade: 'Iporã do Oeste', uf: 'SC' },
  { cidade: 'Ipuaçu', uf: 'SC' },
  { cidade: 'Ipumirim', uf: 'SC' },
  { cidade: 'Iracema do Oeste', uf: 'PR' },
  { cidade: 'Iraceminha', uf: 'SC' },
  { cidade: 'Iraí', uf: 'RS' },
  { cidade: 'Irani', uf: 'SC' },
  { cidade: 'Iretama', uf: 'PR' },
  { cidade: 'Irineópolis', uf: 'SC' },
  { cidade: 'Itá', uf: 'SC' },
  { cidade: 'Itaara', uf: 'RS' },
  { cidade: 'Itacurubi', uf: 'RS' },
  { cidade: 'Itaguajé', uf: 'PR' },
  { cidade: 'Itaiópolis', uf: 'SC' },
  { cidade: 'Itaipulândia', uf: 'PR' },
  { cidade: 'Itajaí', uf: 'SC' },
  { cidade: 'Itambaracá', uf: 'PR' },
  { cidade: 'Itambé', uf: 'PR' },
  { cidade: 'Itapejara d\'Oeste', uf: 'PR' },
  { cidade: 'Itapema', uf: 'SC' },
  { cidade: 'Itaperuçu', uf: 'PR' },
  { cidade: 'Itapiranga', uf: 'SC' },
  { cidade: 'Itapoá', uf: 'SC' },
  { cidade: 'Itapuca', uf: 'RS' },
  { cidade: 'Itaqui', uf: 'RS' },
  { cidade: 'Itati', uf: 'RS' },
  { cidade: 'Itatiba do Sul', uf: 'RS' },
  { cidade: 'Itaúna do Sul', uf: 'PR' },
  { cidade: 'Ituporanga', uf: 'SC' },
  { cidade: 'Ivaí', uf: 'PR' },
  { cidade: 'Ivaiporã', uf: 'PR' },
  { cidade: 'Ivaté', uf: 'PR' },
  { cidade: 'Ivatuba', uf: 'PR' },
  { cidade: 'Ivorá', uf: 'RS' },
  { cidade: 'Ivoti', uf: 'RS' },
  { cidade: 'Jaborá', uf: 'SC' },
  { cidade: 'Jaboti', uf: 'PR' },
  { cidade: 'Jaboticaba', uf: 'RS' },
  { cidade: 'Jacarezinho', uf: 'PR' },
  { cidade: 'Jacinto Machado', uf: 'SC' },
  { cidade: 'Jacuizinho', uf: 'RS' },
  { cidade: 'Jacutinga', uf: 'RS' },
  { cidade: 'Jaguapitã', uf: 'PR' },
  { cidade: 'Jaguarão', uf: 'RS' },
  { cidade: 'Jaguari', uf: 'RS' },
  { cidade: 'Jaguariaíva', uf: 'PR' },
  { cidade: 'Jaguaruna', uf: 'SC' },
  { cidade: 'Jandaia do Sul', uf: 'PR' },
  { cidade: 'Janiópolis', uf: 'PR' },
  { cidade: 'Japira', uf: 'PR' },
  { cidade: 'Japurá', uf: 'PR' },
  { cidade: 'Jaquirana', uf: 'RS' },
  { cidade: 'Jaraguá do Sul', uf: 'SC' },
  { cidade: 'Jardim Alegre', uf: 'PR' },
  { cidade: 'Jardim Olinda', uf: 'PR' },
  { cidade: 'Jardinópolis', uf: 'SC' },
  { cidade: 'Jari', uf: 'RS' },
  { cidade: 'Jataizinho', uf: 'PR' },
  { cidade: 'Jesuítas', uf: 'PR' },
  { cidade: 'Joaçaba', uf: 'SC' },
  { cidade: 'Joaquim Távora', uf: 'PR' },
  { cidade: 'Jóia', uf: 'RS' },
  { cidade: 'Joinville', uf: 'SC' },
  { cidade: 'José Boiteux', uf: 'SC' },
  { cidade: 'Júlio de Castilhos', uf: 'RS' },
  { cidade: 'Jundiaí do Sul', uf: 'PR' },
  { cidade: 'Jupiá', uf: 'SC' },
  { cidade: 'Juranda', uf: 'PR' },
  { cidade: 'Jussara', uf: 'PR' },
  { cidade: 'Kaloré', uf: 'PR' },
  { cidade: 'Lacerdópolis', uf: 'SC' },
  { cidade: 'Lages', uf: 'SC' },
  { cidade: 'Lagoa Bonita do Sul', uf: 'RS' },
  { cidade: 'Lagoa dos Três Cantos', uf: 'RS' },
  { cidade: 'Lagoa Vermelha', uf: 'RS' },
  { cidade: 'Lagoão', uf: 'RS' },
  { cidade: 'Laguna', uf: 'SC' },
  { cidade: 'Lajeado', uf: 'RS' },
  { cidade: 'Lajeado do Bugre', uf: 'RS' },
  { cidade: 'Lajeado Grande', uf: 'SC' },
  { cidade: 'Lapa', uf: 'PR' },
  { cidade: 'Laranjal', uf: 'PR' },
  { cidade: 'Laranjeiras do Sul', uf: 'PR' },
  { cidade: 'Laurentino', uf: 'SC' },
  { cidade: 'Lauro Muller', uf: 'SC' },
  { cidade: 'Lavras do Sul', uf: 'RS' },
  { cidade: 'Lebon Régis', uf: 'SC' },
  { cidade: 'Leoberto Leal', uf: 'SC' },
  { cidade: 'Leópolis', uf: 'PR' },
  { cidade: 'Liberato Salzano', uf: 'RS' },
  { cidade: 'Lidianópolis', uf: 'PR' },
  { cidade: 'Lindoeste', uf: 'PR' },
  { cidade: 'Lindóia do Sul', uf: 'SC' },
  { cidade: 'Lindolfo Collor', uf: 'RS' },
  { cidade: 'Linha Nova', uf: 'RS' },
  { cidade: 'Loanda', uf: 'PR' },
  { cidade: 'Lobato', uf: 'PR' },
  { cidade: 'Londrina', uf: 'PR' },
  { cidade: 'Lontras', uf: 'SC' },
  { cidade: 'Luiz Alves', uf: 'SC' },
  { cidade: 'Luiziana', uf: 'PR' },
  { cidade: 'Lunardelli', uf: 'PR' },
  { cidade: 'Lupionópolis', uf: 'PR' },
  { cidade: 'Luzerna', uf: 'SC' },
  { cidade: 'Maçambará', uf: 'RS' },
  { cidade: 'Machadinho', uf: 'RS' },
  { cidade: 'Macieira', uf: 'SC' },
  { cidade: 'Mafra', uf: 'SC' },
  { cidade: 'Major Gercino', uf: 'SC' },
  { cidade: 'Major Vieira', uf: 'SC' },
  { cidade: 'Mallet', uf: 'PR' },
  { cidade: 'Mamborê', uf: 'PR' },
  { cidade: 'Mampituba', uf: 'RS' },
  { cidade: 'Mandaguaçu', uf: 'PR' },
  { cidade: 'Mandaguari', uf: 'PR' },
  { cidade: 'Mandirituba', uf: 'PR' },
  { cidade: 'Manfrinópolis', uf: 'PR' },
  { cidade: 'Mangueirinha', uf: 'PR' },
  { cidade: 'Manoel Ribas', uf: 'PR' },
  { cidade: 'Manoel Viana', uf: 'RS' },
  { cidade: 'Maquiné', uf: 'RS' },
  { cidade: 'Maracajá', uf: 'SC' },
  { cidade: 'Maratá', uf: 'RS' },
  { cidade: 'Marau', uf: 'RS' },
  { cidade: 'Maravilha', uf: 'SC' },
  { cidade: 'Marcelino Ramos', uf: 'RS' },
  { cidade: 'Marechal Cândido Rondon', uf: 'PR' },
  { cidade: 'Marema', uf: 'SC' },
  { cidade: 'Maria Helena', uf: 'PR' },
  { cidade: 'Marialva', uf: 'PR' },
  { cidade: 'Mariana Pimentel', uf: 'RS' },
  { cidade: 'Mariano Moro', uf: 'RS' },
  { cidade: 'Marilândia do Sul', uf: 'PR' },
  { cidade: 'Marilena', uf: 'PR' },
  { cidade: 'Mariluz', uf: 'PR' },
  { cidade: 'Maringá', uf: 'PR' },
  { cidade: 'Mariópolis', uf: 'PR' },
  { cidade: 'Maripá', uf: 'PR' },
  { cidade: 'Marmeleiro', uf: 'PR' },
  { cidade: 'Marques de Souza', uf: 'RS' },
  { cidade: 'Marquinho', uf: 'PR' },
  { cidade: 'Marumbi', uf: 'PR' },
  { cidade: 'Massaranduba', uf: 'SC' },
  { cidade: 'Mata', uf: 'RS' },
  { cidade: 'Matelândia', uf: 'PR' },
  { cidade: 'Matinhos', uf: 'PR' },
  { cidade: 'Mato Castelhano', uf: 'RS' },
  { cidade: 'Mato Leitão', uf: 'RS' },
  { cidade: 'Mato Queimado', uf: 'RS' },
  { cidade: 'Mato Rico', uf: 'PR' },
  { cidade: 'Matos Costa', uf: 'SC' },
  { cidade: 'Mauá da Serra', uf: 'PR' },
  { cidade: 'Maximiliano de Almeida', uf: 'RS' },
  { cidade: 'Medianeira', uf: 'PR' },
  { cidade: 'Meleiro', uf: 'SC' },
  { cidade: 'Mercedes', uf: 'PR' },
  { cidade: 'Minas do Leão', uf: 'RS' },
  { cidade: 'Mirador', uf: 'PR' },
  { cidade: 'Miraguaí', uf: 'RS' },
  { cidade: 'Miraselva', uf: 'PR' },
  { cidade: 'Mirim Doce', uf: 'SC' },
  { cidade: 'Missal', uf: 'PR' },
  { cidade: 'Modelo', uf: 'SC' },
  { cidade: 'Mondaí', uf: 'SC' },
  { cidade: 'Montauri', uf: 'RS' },
  { cidade: 'Monte Alegre dos Campos', uf: 'RS' },
  { cidade: 'Monte Belo do Sul', uf: 'RS' },
  { cidade: 'Monte Carlo', uf: 'SC' },
  { cidade: 'Monte Castelo', uf: 'SC' },
  { cidade: 'Montenegro', uf: 'RS' },
  { cidade: 'Moreira Sales', uf: 'PR' },
  { cidade: 'Mormaço', uf: 'RS' },
  { cidade: 'Morretes', uf: 'PR' },
  { cidade: 'Morrinhos do Sul', uf: 'RS' },
  { cidade: 'Morro da Fumaça', uf: 'SC' },
  { cidade: 'Morro Grande', uf: 'SC' },
  { cidade: 'Morro Redondo', uf: 'RS' },
  { cidade: 'Morro Reuter', uf: 'RS' },
  { cidade: 'Mostardas', uf: 'RS' },
  { cidade: 'Muçum', uf: 'RS' },
  { cidade: 'Muitos Capões', uf: 'RS' },
  { cidade: 'Muliterno', uf: 'RS' },
  { cidade: 'Munhoz de Melo', uf: 'PR' },
  { cidade: 'Não-Me-Toque', uf: 'RS' },
  { cidade: 'Navegantes', uf: 'SC' },
  { cidade: 'Nicolau Vergueiro', uf: 'RS' },
  { cidade: 'Nonoai', uf: 'RS' },
  { cidade: 'Nossa Senhora das Graças', uf: 'PR' },
  { cidade: 'Nova Aliança do Ivaí', uf: 'PR' },
  { cidade: 'Nova Alvorada', uf: 'RS' },
  { cidade: 'Nova América da Colina', uf: 'PR' },
  { cidade: 'Nova Araçá', uf: 'RS' },
  { cidade: 'Nova Aurora', uf: 'PR' },
  { cidade: 'Nova Bassano', uf: 'RS' },
  { cidade: 'Nova Boa Vista', uf: 'RS' },
  { cidade: 'Nova Bréscia', uf: 'RS' },
  { cidade: 'Nova Candelária', uf: 'RS' },
  { cidade: 'Nova Cantu', uf: 'PR' },
  { cidade: 'Nova Erechim', uf: 'SC' },
  { cidade: 'Nova Esperança', uf: 'PR' },
  { cidade: 'Nova Esperança do Sudoeste', uf: 'PR' },
  { cidade: 'Nova Esperança do Sul', uf: 'RS' },
  { cidade: 'Nova Fátima', uf: 'PR' },
  { cidade: 'Nova Hartz', uf: 'RS' },
  { cidade: 'Nova Itaberaba', uf: 'SC' },
  { cidade: 'Nova Laranjeiras', uf: 'PR' },
  { cidade: 'Nova Londrina', uf: 'PR' },
  { cidade: 'Nova Olímpia', uf: 'PR' },
  { cidade: 'Nova Pádua', uf: 'RS' },
  { cidade: 'Nova Palma', uf: 'RS' },
  { cidade: 'Nova Petrópolis', uf: 'RS' },
  { cidade: 'Nova Prata', uf: 'RS' },
  { cidade: 'Nova Prata do Iguaçu', uf: 'PR' },
  { cidade: 'Nova Ramada', uf: 'RS' },
  { cidade: 'Nova Roma do Sul', uf: 'RS' },
  { cidade: 'Nova Santa Bárbara', uf: 'PR' },
  { cidade: 'Nova Santa Rita', uf: 'RS' },
  { cidade: 'Nova Santa Rosa', uf: 'PR' },
  { cidade: 'Nova Tebas', uf: 'PR' },
  { cidade: 'Nova Trento', uf: 'SC' },
  { cidade: 'Nova Veneza', uf: 'SC' },
  { cidade: 'Novo Barreiro', uf: 'RS' },
  { cidade: 'Novo Cabrais', uf: 'RS' },
  { cidade: 'Novo Hamburgo', uf: 'RS' },
  { cidade: 'Novo Horizonte', uf: 'SC' },
  { cidade: 'Novo Itacolomi', uf: 'PR' },
  { cidade: 'Novo Machado', uf: 'RS' },
  { cidade: 'Novo Tiradentes', uf: 'RS' },
  { cidade: 'Novo Xingu', uf: 'RS' },
  { cidade: 'Orleans', uf: 'SC' },
  { cidade: 'Ortigueira', uf: 'PR' },
  { cidade: 'Osório', uf: 'RS' },
  { cidade: 'Otacílio Costa', uf: 'SC' },
  { cidade: 'Ourizona', uf: 'PR' },
  { cidade: 'Ouro', uf: 'SC' },
  { cidade: 'Ouro Verde', uf: 'SC' },
  { cidade: 'Ouro Verde do Oeste', uf: 'PR' },
  { cidade: 'Paial', uf: 'SC' },
  { cidade: 'Paiçandu', uf: 'PR' },
  { cidade: 'Paim Filho', uf: 'RS' },
  { cidade: 'Painel', uf: 'SC' },
  { cidade: 'Palhoça', uf: 'SC' },
  { cidade: 'Palma Sola', uf: 'SC' },
  { cidade: 'Palmares do Sul', uf: 'RS' },
  { cidade: 'Palmas', uf: 'PR' },
  { cidade: 'Palmeira das Missões', uf: 'RS' },
  { cidade: 'Palmital', uf: 'PR' },
  { cidade: 'Palmitinho', uf: 'RS' },
  { cidade: 'Palmitos', uf: 'SC' },
  { cidade: 'Palotina', uf: 'PR' },
  { cidade: 'Panambi', uf: 'RS' },
  { cidade: 'Pantano Grande', uf: 'RS' },
  { cidade: 'Papanduva', uf: 'SC' },
  { cidade: 'Paraí', uf: 'RS' },
  { cidade: 'Paraíso', uf: 'SC' },
  { cidade: 'Paraíso do Norte', uf: 'PR' },
  { cidade: 'Paraíso do Sul', uf: 'RS' },
  { cidade: 'Paranacity', uf: 'PR' },
  { cidade: 'Paranaguá', uf: 'PR' },
  { cidade: 'Paranapoema', uf: 'PR' },
  { cidade: 'Paranavaí', uf: 'PR' },
  { cidade: 'Pareci Novo', uf: 'RS' },
  { cidade: 'Parobé', uf: 'RS' },
  { cidade: 'Passa Sete', uf: 'RS' },
  { cidade: 'Passo de Torres', uf: 'SC' },
  { cidade: 'Passo do Sobrado', uf: 'RS' },
  { cidade: 'Passo Fundo', uf: 'RS' },
  { cidade: 'Passos Maia', uf: 'SC' },
  { cidade: 'Pato Bragado', uf: 'PR' },
  { cidade: 'Pato Branco', uf: 'PR' },
  { cidade: 'Paula Freitas', uf: 'PR' },
  { cidade: 'Paulo Bento', uf: 'RS' },
  { cidade: 'Paulo Frontin', uf: 'PR' },
  { cidade: 'Paulo Lopes', uf: 'SC' },
  { cidade: 'Paverama', uf: 'RS' },
  { cidade: 'Peabiru', uf: 'PR' },
  { cidade: 'Pedras Altas', uf: 'RS' },
  { cidade: 'Pedras Grandes', uf: 'SC' },
  { cidade: 'Pedro Osório', uf: 'RS' },
  { cidade: 'Pejuçara', uf: 'RS' },
  { cidade: 'Pelotas', uf: 'RS' },
  { cidade: 'Penha', uf: 'SC' },
  { cidade: 'Peritiba', uf: 'SC' },
  { cidade: 'Perobal', uf: 'PR' },
  { cidade: 'Pérola', uf: 'PR' },
  { cidade: 'Pérola d\'Oeste', uf: 'PR' },
  { cidade: 'Pescaria Brava', uf: 'SC' },
  { cidade: 'Petrolândia', uf: 'SC' },
  { cidade: 'Picada Café', uf: 'RS' },
  { cidade: 'Piên', uf: 'PR' },
  { cidade: 'Pinhais', uf: 'PR' },
  { cidade: 'Pinhal', uf: 'RS' },
  { cidade: 'Pinhal da Serra', uf: 'RS' },
  { cidade: 'Pinhal de São Bento', uf: 'PR' },
  { cidade: 'Pinhal Grande', uf: 'RS' },
  { cidade: 'Pinhalão', uf: 'PR' },
  { cidade: 'Pinhalzinho', uf: 'SC' },
  { cidade: 'Pinhão', uf: 'PR' },
  { cidade: 'Pinheirinho do Vale', uf: 'RS' },
  { cidade: 'Pinheiro Machado', uf: 'RS' },
  { cidade: 'Pinheiro Preto', uf: 'SC' },
  { cidade: 'Pinto Bandeira', uf: 'RS' },
  { cidade: 'Piraí do Sul', uf: 'PR' },
  { cidade: 'Pirapó', uf: 'RS' },
  { cidade: 'Piraquara', uf: 'PR' },
  { cidade: 'Piratini', uf: 'RS' },
  { cidade: 'Piratuba', uf: 'SC' },
  { cidade: 'Pitanga', uf: 'PR' },
  { cidade: 'Pitangueiras', uf: 'PR' },
  { cidade: 'Planaltina do Paraná', uf: 'PR' },
  { cidade: 'Planalto Alegre', uf: 'SC' },
  { cidade: 'Poço das Antas', uf: 'RS' },
  { cidade: 'Pomerode', uf: 'SC' },
  { cidade: 'Ponta Grossa', uf: 'PR' },
  { cidade: 'Pontal do Paraná', uf: 'PR' },
  { cidade: 'Pontão', uf: 'RS' },
  { cidade: 'Ponte Alta', uf: 'SC' },
  { cidade: 'Ponte Alta do Norte', uf: 'SC' },
  { cidade: 'Ponte Preta', uf: 'RS' },
  { cidade: 'Ponte Serrada', uf: 'SC' },
  { cidade: 'Porecatu', uf: 'PR' },
  { cidade: 'Portão', uf: 'RS' },
  { cidade: 'Porto Alegre', uf: 'RS' },
  { cidade: 'Porto Amazonas', uf: 'PR' },
  { cidade: 'Porto Barreiro', uf: 'PR' },
  { cidade: 'Porto Belo', uf: 'SC' },
  { cidade: 'Porto Lucena', uf: 'RS' },
  { cidade: 'Porto Mauá', uf: 'RS' },
  { cidade: 'Porto Rico', uf: 'PR' },
  { cidade: 'Porto União', uf: 'SC' },
  { cidade: 'Porto Vera Cruz', uf: 'RS' },
  { cidade: 'Porto Vitória', uf: 'PR' },
  { cidade: 'Porto Xavier', uf: 'RS' },
  { cidade: 'Pouso Novo', uf: 'RS' },
  { cidade: 'Pouso Redondo', uf: 'SC' },
  { cidade: 'Prado Ferreira', uf: 'PR' },
  { cidade: 'Praia Grande', uf: 'SC' },
  { cidade: 'Pranchita', uf: 'PR' },
  { cidade: 'Presidente Castello Branco', uf: 'SC' },
  { cidade: 'Presidente Castelo Branco', uf: 'PR' },
  { cidade: 'Presidente Getúlio', uf: 'SC' },
  { cidade: 'Presidente Lucena', uf: 'RS' },
  { cidade: 'Presidente Nereu', uf: 'SC' },
  { cidade: 'Primeiro de Maio', uf: 'PR' },
  { cidade: 'Princesa', uf: 'SC' },
  { cidade: 'Progresso', uf: 'RS' },
  { cidade: 'Protásio Alves', uf: 'RS' },
  { cidade: 'Prudentópolis', uf: 'PR' },
  { cidade: 'Putinga', uf: 'RS' },
  { cidade: 'Quaraí', uf: 'RS' },
  { cidade: 'Quarto Centenário', uf: 'PR' },
  { cidade: 'Quatiguá', uf: 'PR' },
  { cidade: 'Quatro Barras', uf: 'PR' },
  { cidade: 'Quatro Irmãos', uf: 'RS' },
  { cidade: 'Quatro Pontes', uf: 'PR' },
  { cidade: 'Quedas do Iguaçu', uf: 'PR' },
  { cidade: 'Querência do Norte', uf: 'PR' },
  { cidade: 'Quevedos', uf: 'RS' },
  { cidade: 'Quilombo', uf: 'SC' },
  { cidade: 'Quinta do Sol', uf: 'PR' },
  { cidade: 'Quinze de Novembro', uf: 'RS' },
  { cidade: 'Quitandinha', uf: 'PR' },
  { cidade: 'Ramilândia', uf: 'PR' },
  { cidade: 'Rancho Alegre', uf: 'PR' },
  { cidade: 'Rancho Alegre D\'Oeste', uf: 'PR' },
  { cidade: 'Rancho Queimado', uf: 'SC' },
  { cidade: 'Realeza', uf: 'PR' },
  { cidade: 'Rebouças', uf: 'PR' },
  { cidade: 'Redentora', uf: 'RS' },
  { cidade: 'Relvado', uf: 'RS' },
  { cidade: 'Renascença', uf: 'PR' },
  { cidade: 'Reserva', uf: 'PR' },
  { cidade: 'Reserva do Iguaçu', uf: 'PR' },
  { cidade: 'Restinga Sêca', uf: 'RS' },
  { cidade: 'Ribeirão Claro', uf: 'PR' },
  { cidade: 'Ribeirão do Pinhal', uf: 'PR' },
  { cidade: 'Rio Azul', uf: 'PR' },
  { cidade: 'Rio Bom', uf: 'PR' },
  { cidade: 'Rio Bonito do Iguaçu', uf: 'PR' },
  { cidade: 'Rio Branco do Ivaí', uf: 'PR' },
  { cidade: 'Rio Branco do Sul', uf: 'PR' },
  { cidade: 'Rio das Antas', uf: 'SC' },
  { cidade: 'Rio do Campo', uf: 'SC' },
  { cidade: 'Rio do Oeste', uf: 'SC' },
  { cidade: 'Rio do Sul', uf: 'SC' },
  { cidade: 'Rio dos Cedros', uf: 'SC' },
  { cidade: 'Rio dos Índios', uf: 'RS' },
  { cidade: 'Rio Fortuna', uf: 'SC' },
  { cidade: 'Rio Grande', uf: 'RS' },
  { cidade: 'Rio Negrinho', uf: 'SC' },
  { cidade: 'Rio Negro', uf: 'PR' },
  { cidade: 'Rio Pardo', uf: 'RS' },
  { cidade: 'Rio Rufino', uf: 'SC' },
  { cidade: 'Riozinho', uf: 'RS' },
  { cidade: 'Riqueza', uf: 'SC' },
  { cidade: 'Roca Sales', uf: 'RS' },
  { cidade: 'Rodeio', uf: 'SC' },
  { cidade: 'Rodeio Bonito', uf: 'RS' },
  { cidade: 'Rolador', uf: 'RS' },
  { cidade: 'Rolândia', uf: 'PR' },
  { cidade: 'Rolante', uf: 'RS' },
  { cidade: 'Romelândia', uf: 'SC' },
  { cidade: 'Roncador', uf: 'PR' },
  { cidade: 'Ronda Alta', uf: 'RS' },
  { cidade: 'Rondinha', uf: 'RS' },
  { cidade: 'Rondon', uf: 'PR' },
  { cidade: 'Roque Gonzales', uf: 'RS' },
  { cidade: 'Rosário do Ivaí', uf: 'PR' },
  { cidade: 'Rosário do Sul', uf: 'RS' },
  { cidade: 'Sabáudia', uf: 'PR' },
  { cidade: 'Sagrada Família', uf: 'RS' },
  { cidade: 'Saldanha Marinho', uf: 'RS' },
  { cidade: 'Salete', uf: 'SC' },
  { cidade: 'Salgado Filho', uf: 'PR' },
  { cidade: 'Saltinho', uf: 'SC' },
  { cidade: 'Salto do Itararé', uf: 'PR' },
  { cidade: 'Salto do Jacuí', uf: 'RS' },
  { cidade: 'Salto do Lontra', uf: 'PR' },
  { cidade: 'Salto Veloso', uf: 'SC' },
  { cidade: 'Salvador das Missões', uf: 'RS' },
  { cidade: 'Salvador do Sul', uf: 'RS' },
  { cidade: 'Sananduva', uf: 'RS' },
  { cidade: 'Sangão', uf: 'SC' },
  { cidade: 'Sant\'Ana do Livramento', uf: 'RS' },
  { cidade: 'Santa Amélia', uf: 'PR' },
  { cidade: 'Santa Bárbara do Sul', uf: 'RS' },
  { cidade: 'Santa Cecília', uf: 'SC' },
  { cidade: 'Santa Cecília do Pavão', uf: 'PR' },
  { cidade: 'Santa Cecília do Sul', uf: 'RS' },
  { cidade: 'Santa Clara do Sul', uf: 'RS' },
  { cidade: 'Santa Cruz de Monte Castelo', uf: 'PR' },
  { cidade: 'Santa Cruz do Sul', uf: 'RS' },
  { cidade: 'Santa Fé', uf: 'PR' },
  { cidade: 'Santa Inês', uf: 'PR' },
  { cidade: 'Santa Isabel do Ivaí', uf: 'PR' },
  { cidade: 'Santa Izabel do Oeste', uf: 'PR' },
  { cidade: 'Santa Lúcia', uf: 'PR' },
  { cidade: 'Santa Margarida do Sul', uf: 'RS' },
  { cidade: 'Santa Maria', uf: 'RS' },
  { cidade: 'Santa Maria do Herval', uf: 'RS' },
  { cidade: 'Santa Maria do Oeste', uf: 'PR' },
  { cidade: 'Santa Mariana', uf: 'PR' },
  { cidade: 'Santa Mônica', uf: 'PR' },
  { cidade: 'Santa Rosa', uf: 'RS' },
  { cidade: 'Santa Rosa de Lima', uf: 'SC' },
  { cidade: 'Santa Rosa do Sul', uf: 'SC' },
  { cidade: 'Santa Tereza', uf: 'RS' },
  { cidade: 'Santa Tereza do Oeste', uf: 'PR' },
  { cidade: 'Santa Terezinha', uf: 'SC' },
  { cidade: 'Santa Terezinha de Itaipu', uf: 'PR' },
  { cidade: 'Santa Terezinha do Progresso', uf: 'SC' },
  { cidade: 'Santa Vitória do Palmar', uf: 'RS' },
  { cidade: 'Santana da Boa Vista', uf: 'RS' },
  { cidade: 'Santana do Itararé', uf: 'PR' },
  { cidade: 'Santiago', uf: 'RS' },
  { cidade: 'Santiago do Sul', uf: 'SC' },
  { cidade: 'Santo Amaro da Imperatriz', uf: 'SC' },
  { cidade: 'Santo Ângelo', uf: 'RS' },
  { cidade: 'Santo Antônio da Patrulha', uf: 'RS' },
  { cidade: 'Santo Antônio da Platina', uf: 'PR' },
  { cidade: 'Santo Antônio das Missões', uf: 'RS' },
  { cidade: 'Santo Antônio do Caiuá', uf: 'PR' },
  { cidade: 'Santo Antônio do Palma', uf: 'RS' },
  { cidade: 'Santo Antônio do Paraíso', uf: 'PR' },
  { cidade: 'Santo Antônio do Planalto', uf: 'RS' },
  { cidade: 'Santo Antônio do Sudoeste', uf: 'PR' },
  { cidade: 'Santo Augusto', uf: 'RS' },
  { cidade: 'Santo Cristo', uf: 'RS' },
  { cidade: 'Santo Expedito do Sul', uf: 'RS' },
  { cidade: 'Santo Inácio', uf: 'PR' },
  { cidade: 'São Bento do Sul', uf: 'SC' },
  { cidade: 'São Bernardino', uf: 'SC' },
  { cidade: 'São Bonifácio', uf: 'SC' },
  { cidade: 'São Borja', uf: 'RS' },
  { cidade: 'São Carlos', uf: 'SC' },
  { cidade: 'São Carlos do Ivaí', uf: 'PR' },
  { cidade: 'São Cristovão do Sul', uf: 'SC' },
  { cidade: 'São Domingos', uf: 'SC' },
  { cidade: 'São Domingos do Sul', uf: 'RS' },
  { cidade: 'São Francisco de Assis', uf: 'RS' },
  { cidade: 'São Francisco de Paula', uf: 'RS' },
  { cidade: 'São Francisco do Sul', uf: 'SC' },
  { cidade: 'São Gabriel', uf: 'RS' },
  { cidade: 'São Jerônimo', uf: 'RS' },
  { cidade: 'São Jerônimo da Serra', uf: 'PR' },
  { cidade: 'São João', uf: 'PR' },
  { cidade: 'São João Batista', uf: 'SC' },
  { cidade: 'São João da Urtiga', uf: 'RS' },
  { cidade: 'São João do Caiuá', uf: 'PR' },
  { cidade: 'São João do Itaperiú', uf: 'SC' },
  { cidade: 'São João do Ivaí', uf: 'PR' },
  { cidade: 'São João do Oeste', uf: 'SC' },
  { cidade: 'São João do Polêsine', uf: 'RS' },
  { cidade: 'São João do Sul', uf: 'SC' },
  { cidade: 'São João do Triunfo', uf: 'PR' },
  { cidade: 'São Joaquim', uf: 'SC' },
  { cidade: 'São Jorge', uf: 'RS' },
  { cidade: 'São Jorge d\'Oeste', uf: 'PR' },
  { cidade: 'São Jorge do Ivaí', uf: 'PR' },
  { cidade: 'São Jorge do Patrocínio', uf: 'PR' },
  { cidade: 'São José', uf: 'SC' },
  { cidade: 'São José da Boa Vista', uf: 'PR' },
  { cidade: 'São José das Missões', uf: 'RS' },
  { cidade: 'São José das Palmeiras', uf: 'PR' },
  { cidade: 'São José do Cedro', uf: 'SC' },
  { cidade: 'São José do Cerrito', uf: 'SC' },
  { cidade: 'São José do Herval', uf: 'RS' },
  { cidade: 'São José do Hortêncio', uf: 'RS' },
  { cidade: 'São José do Inhacorá', uf: 'RS' },
  { cidade: 'São José do Norte', uf: 'RS' },
  { cidade: 'São José do Ouro', uf: 'RS' },
  { cidade: 'São José do Sul', uf: 'RS' },
  { cidade: 'São José dos Ausentes', uf: 'RS' },
  { cidade: 'São José dos Pinhais', uf: 'PR' },
  { cidade: 'São Leopoldo', uf: 'RS' },
  { cidade: 'São Lourenço do Oeste', uf: 'SC' },
  { cidade: 'São Lourenço do Sul', uf: 'RS' },
  { cidade: 'São Ludgero', uf: 'SC' },
  { cidade: 'São Luiz Gonzaga', uf: 'RS' },
  { cidade: 'São Manoel do Paraná', uf: 'PR' },
  { cidade: 'São Marcos', uf: 'RS' },
  { cidade: 'São Martinho da Serra', uf: 'RS' },
  { cidade: 'São Mateus do Sul', uf: 'PR' },
  { cidade: 'São Miguel da Boa Vista', uf: 'SC' },
  { cidade: 'São Miguel das Missões', uf: 'RS' },
  { cidade: 'São Miguel do Iguaçu', uf: 'PR' },
  { cidade: 'São Miguel do Oeste', uf: 'SC' },
  { cidade: 'São Nicolau', uf: 'RS' },
  { cidade: 'São Paulo das Missões', uf: 'RS' },
  { cidade: 'São Pedro da Serra', uf: 'RS' },
  { cidade: 'São Pedro das Missões', uf: 'RS' },
  { cidade: 'São Pedro de Alcântara', uf: 'SC' },
  { cidade: 'São Pedro do Butiá', uf: 'RS' },
  { cidade: 'São Pedro do Iguaçu', uf: 'PR' },
  { cidade: 'São Pedro do Ivaí', uf: 'PR' },
  { cidade: 'São Pedro do Paraná', uf: 'PR' },
  { cidade: 'São Pedro do Sul', uf: 'RS' },
  { cidade: 'São Sebastião da Amoreira', uf: 'PR' },
  { cidade: 'São Sebastião do Caí', uf: 'RS' },
  { cidade: 'São Sepé', uf: 'RS' },
  { cidade: 'São Tomé', uf: 'PR' },
  { cidade: 'São Valentim', uf: 'RS' },
  { cidade: 'São Valentim do Sul', uf: 'RS' },
  { cidade: 'São Valério do Sul', uf: 'RS' },
  { cidade: 'São Vendelino', uf: 'RS' },
  { cidade: 'São Vicente do Sul', uf: 'RS' },
  { cidade: 'Sapiranga', uf: 'RS' },
  { cidade: 'Sapopema', uf: 'PR' },
  { cidade: 'Sapucaia do Sul', uf: 'RS' },
  { cidade: 'Saudade do Iguaçu', uf: 'PR' },
  { cidade: 'Saudades', uf: 'SC' },
  { cidade: 'Schroeder', uf: 'SC' },
  { cidade: 'Seara', uf: 'SC' },
  { cidade: 'Seberi', uf: 'RS' },
  { cidade: 'Sede Nova', uf: 'RS' },
  { cidade: 'Segredo', uf: 'RS' },
  { cidade: 'Selbach', uf: 'RS' },
  { cidade: 'Senador Salgado Filho', uf: 'RS' },
  { cidade: 'Sengés', uf: 'PR' },
  { cidade: 'Sentinela do Sul', uf: 'RS' },
  { cidade: 'Serafina Corrêa', uf: 'RS' },
  { cidade: 'Sério', uf: 'RS' },
  { cidade: 'Serra Alta', uf: 'SC' },
  { cidade: 'Serranópolis do Iguaçu', uf: 'PR' },
  { cidade: 'Sertaneja', uf: 'PR' },
  { cidade: 'Sertanópolis', uf: 'PR' },
  { cidade: 'Sertão', uf: 'RS' },
  { cidade: 'Sertão Santana', uf: 'RS' },
  { cidade: 'Sete de Setembro', uf: 'RS' },
  { cidade: 'Severiano de Almeida', uf: 'RS' },
  { cidade: 'Siderópolis', uf: 'SC' },
  { cidade: 'Silveira Martins', uf: 'RS' },
  { cidade: 'Sinimbu', uf: 'RS' },
  { cidade: 'Siqueira Campos', uf: 'PR' },
  { cidade: 'Sobradinho', uf: 'RS' },
  { cidade: 'Soledade', uf: 'RS' },
  { cidade: 'Sombrio', uf: 'SC' },
  { cidade: 'Sul Brasil', uf: 'SC' },
  { cidade: 'Sulina', uf: 'PR' },
  { cidade: 'Tabaí', uf: 'RS' },
  { cidade: 'Taió', uf: 'SC' },
  { cidade: 'Tamarana', uf: 'PR' },
  { cidade: 'Tamboara', uf: 'PR' },
  { cidade: 'Tangará', uf: 'SC' },
  { cidade: 'Tapera', uf: 'RS' },
  { cidade: 'Tapes', uf: 'RS' },
  { cidade: 'Tapira', uf: 'PR' },
  { cidade: 'Taquara', uf: 'RS' },
  { cidade: 'Taquari', uf: 'RS' },
  { cidade: 'Taquaruçu do Sul', uf: 'RS' },
  { cidade: 'Tavares', uf: 'RS' },
  { cidade: 'Teixeira Soares', uf: 'PR' },
  { cidade: 'Telêmaco Borba', uf: 'PR' },
  { cidade: 'Tenente Portela', uf: 'RS' },
  { cidade: 'Terra Boa', uf: 'PR' },
  { cidade: 'Terra de Areia', uf: 'RS' },
  { cidade: 'Terra Rica', uf: 'PR' },
  { cidade: 'Terra Roxa', uf: 'PR' },
  { cidade: 'Teutônia', uf: 'RS' },
  { cidade: 'Tibagi', uf: 'PR' },
  { cidade: 'Tigrinhos', uf: 'SC' },
  { cidade: 'Tijucas', uf: 'SC' },
  { cidade: 'Tijucas do Sul', uf: 'PR' },
  { cidade: 'Timbé do Sul', uf: 'SC' },
  { cidade: 'Timbó', uf: 'SC' },
  { cidade: 'Timbó Grande', uf: 'SC' },
  { cidade: 'Tio Hugo', uf: 'RS' },
  { cidade: 'Tiradentes do Sul', uf: 'RS' },
  { cidade: 'Toledo', uf: 'PR' },
  { cidade: 'Tomazina', uf: 'PR' },
  { cidade: 'Toropi', uf: 'RS' },
  { cidade: 'Torres', uf: 'RS' },
  { cidade: 'Tramandaí', uf: 'RS' },
  { cidade: 'Travesseiro', uf: 'RS' },
  { cidade: 'Três Arroios', uf: 'RS' },
  { cidade: 'Três Barras', uf: 'SC' },
  { cidade: 'Três Barras do Paraná', uf: 'PR' },
  { cidade: 'Três Cachoeiras', uf: 'RS' },
  { cidade: 'Três Coroas', uf: 'RS' },
  { cidade: 'Três de Maio', uf: 'RS' },
  { cidade: 'Três Forquilhas', uf: 'RS' },
  { cidade: 'Três Palmeiras', uf: 'RS' },
  { cidade: 'Três Passos', uf: 'RS' },
  { cidade: 'Treviso', uf: 'SC' },
  { cidade: 'Treze de Maio', uf: 'SC' },
  { cidade: 'Treze Tílias', uf: 'SC' },
  { cidade: 'Trindade do Sul', uf: 'RS' },
  { cidade: 'Triunfo', uf: 'RS' },
  { cidade: 'Trombudo Central', uf: 'SC' },
  { cidade: 'Tubarão', uf: 'SC' },
  { cidade: 'Tucunduva', uf: 'RS' },
  { cidade: 'Tunápolis', uf: 'SC' },
  { cidade: 'Tunas', uf: 'RS' },
  { cidade: 'Tunas do Paraná', uf: 'PR' },
  { cidade: 'Tuneiras do Oeste', uf: 'PR' },
  { cidade: 'Tupanci do Sul', uf: 'RS' },
  { cidade: 'Tupanciretã', uf: 'RS' },
  { cidade: 'Tupandi', uf: 'RS' },
  { cidade: 'Tuparendi', uf: 'RS' },
  { cidade: 'Tupãssi', uf: 'PR' },
  { cidade: 'Turuçu', uf: 'RS' },
  { cidade: 'Ubiratã', uf: 'PR' },
  { cidade: 'Ubiretama', uf: 'RS' },
  { cidade: 'Umuarama', uf: 'PR' },
  { cidade: 'União da Serra', uf: 'RS' },
  { cidade: 'União da Vitória', uf: 'PR' },
  { cidade: 'União do Oeste', uf: 'SC' },
  { cidade: 'Uniflor', uf: 'PR' },
  { cidade: 'Unistalda', uf: 'RS' },
  { cidade: 'Uraí', uf: 'PR' },
  { cidade: 'Urubici', uf: 'SC' },
  { cidade: 'Uruguaiana', uf: 'RS' },
  { cidade: 'Urupema', uf: 'SC' },
  { cidade: 'Urussanga', uf: 'SC' },
  { cidade: 'Vacaria', uf: 'RS' },
  { cidade: 'Vale do Sol', uf: 'RS' },
  { cidade: 'Vale Real', uf: 'RS' },
  { cidade: 'Vale Verde', uf: 'RS' },
  { cidade: 'Vanini', uf: 'RS' },
  { cidade: 'Vargeão', uf: 'SC' },
  { cidade: 'Vargem', uf: 'SC' },
  { cidade: 'Vargem Bonita', uf: 'SC' },
  { cidade: 'Venâncio Aires', uf: 'RS' },
  { cidade: 'Ventania', uf: 'PR' },
  { cidade: 'Vera Cruz', uf: 'RS' },
  { cidade: 'Vera Cruz do Oeste', uf: 'PR' },
  { cidade: 'Veranópolis', uf: 'RS' },
  { cidade: 'Verê', uf: 'PR' },
  { cidade: 'Vespasiano Corrêa', uf: 'RS' },
  { cidade: 'Viadutos', uf: 'RS' },
  { cidade: 'Viamão', uf: 'RS' },
  { cidade: 'Vicente Dutra', uf: 'RS' },
  { cidade: 'Victor Graeff', uf: 'RS' },
  { cidade: 'Vidal Ramos', uf: 'SC' },
  { cidade: 'Videira', uf: 'SC' },
  { cidade: 'Vila Flores', uf: 'RS' },
  { cidade: 'Vila Lângaro', uf: 'RS' },
  { cidade: 'Vila Maria', uf: 'RS' },
  { cidade: 'Vila Nova do Sul', uf: 'RS' },
  { cidade: 'Virmond', uf: 'PR' },
  { cidade: 'Vista Alegre', uf: 'RS' },
  { cidade: 'Vista Alegre do Prata', uf: 'RS' },
  { cidade: 'Vista Gaúcha', uf: 'RS' },
  { cidade: 'Vitor Meireles', uf: 'SC' },
  { cidade: 'Vitória das Missões', uf: 'RS' },
  { cidade: 'Vitorino', uf: 'PR' },
  { cidade: 'Wenceslau Braz', uf: 'PR' },
  { cidade: 'Westfália', uf: 'RS' },
  { cidade: 'Witmarsum', uf: 'SC' },
  { cidade: 'Xambrê', uf: 'PR' },
  { cidade: 'Xangri-lá', uf: 'RS' },
  { cidade: 'Xanxerê', uf: 'SC' },
  { cidade: 'Xavantina', uf: 'SC' },
  { cidade: 'Xaxim', uf: 'SC' },
  { cidade: 'Zortéa', uf: 'SC' },
];

const PRESET_ESPECIAIS = [
  { origem: 'Fala de Onde', destino: 'Fala Daqui' },
  { origem: 'Dito no Sul', destino: 'Fala Daqui' },
  { origem: 'Básicos de Origem', destino: 'Da Nossa Terra' },
  { origem: 'Marco Zero', destino: 'Da Nossa Terra' },
  { origem: 'Made in Sul', destino: 'Da Nossa Terra' },
  // "Minimalista" e "Essência" não existem como categorias separadas — o nome real da categoria
  // pras 3 (Minimalista/Essência/Identidade) é só "Identidade" (correção do usuário, 2026-09-10).
  { origem: 'Identidade', destino: 'Da Nossa Terra' },
  { origem: 'Lenda do Sul', destino: 'Feito Pra Você' },
];

// Comparação de nome de categoria tolerante a truncamento: a Ink limita `name` a 20 caracteres,
// e nomes-alvo do preset como "SUL - COORDENADAS - SC" (22) ou "SUL - TIPOGRAFIA - SC" (21)
// excedem isso — se essas categorias já existem na loja, foram criadas com nome abreviado, então
// nunca dá pra comparar string exata. Aqui removemos tudo que não é letra/número (space, "-") pra
// sobrar só as letras corridas, comparáveis mesmo com abreviação no fim.
function normalizarCategoriaComparavel(nome) {
  return normalizarTextoMatch(nome).replace(/[^a-z0-9]+/g, '');
}

// Segmentos comparáveis de um nome de categoria, dividindo por " - " (ex: "SUL - TIPOG. - RS" →
// ["sul","tipog","rs"]). Comparar por segmento (não a string toda concatenada) é o que permite
// reconhecer abreviação de UMA palavra no meio do nome, sem que o restante do nome (que não
// mudou) atrapalhe o match.
function segmentosCategoriaComparavel(nome) {
  return String(nome || '').split(' - ').map((seg) => normalizarCategoriaComparavel(seg)).filter(Boolean);
}

// Candidatos pro nome-alvo entre as categorias reais da loja: match exato (string inteira
// normalizada) tem prioridade absoluta e é devolvido sozinho; senão, comparação SEGMENTO A
// SEGMENTO (dividindo por " - "), permitindo que um segmento seja abreviação de palavra do outro
// — convenção real encontrada na loja pra caber no limite de 20 caracteres da Ink, ex:
// "SUL - TIPOG. - RS" abreviando "SUL - TIPOGRAFIA - RS", "SUL - TERRIT. - PR" abreviando
// "SUL - TERRITÓRIO - PR" (truncar a STRING TODA no fim, como a heurística antiga assumia, não
// cobre isso: o corte é no meio, só na palavra da coleção, o UF continua inteiro no final).
// Exige mesma quantidade de segmentos; cada par de segmento tem que ser igual ou um prefixo do
// outro com no mínimo 5 caracteres — abaixo disso (ex: UF de 2 letras "RS"/"SC"/"PR") só aceita
// igualdade exata, pra nunca confundir uma UF com outra.
function candidatosCategoria(nomesPorId, nomeAlvo) {
  const alvoNorm = normalizarCategoriaComparavel(nomeAlvo);
  const alvoSegmentos = segmentosCategoriaComparavel(nomeAlvo);
  const exatos = [];
  const aproximados = [];
  for (const [id, nome] of nomesPorId) {
    const nomeNorm = normalizarCategoriaComparavel(nome);
    if (nomeNorm === alvoNorm) { exatos.push({ id, nome }); continue; }
    const nomeSegmentos = segmentosCategoriaComparavel(nome);
    const segmentosBatem = nomeSegmentos.length === alvoSegmentos.length && nomeSegmentos.every((seg, i) => {
      const alvoSeg = alvoSegmentos[i];
      if (seg === alvoSeg) return true;
      const min = Math.min(seg.length, alvoSeg.length);
      return min >= 5 && (seg.startsWith(alvoSeg) || alvoSeg.startsWith(seg));
    });
    if (segmentosBatem) aproximados.push({ id, nome });
  }
  return exatos.length ? exatos : aproximados;
}

// Categoria extra por coleção (pedido do usuário, 2026-09-09): Gentilico ganha "Fala Daqui",
// as outras 7 coleções ganham "Seu Lugar" — nomes curtos, não sofrem o truncamento de 20
// caracteres da Ink, mas ainda passam pelo mesmo resolver tolerante (podem não existir na loja).
// Ajuste do usuário (2026-09-10): Gentílico deixou de ser exceção — usa "Seu Lugar" igual as
// outras 7 coleções (antes era "Fala Daqui" só pra Gentílico). "Fala Daqui" continua existindo
// como categoria pública, só que agora só pra coleções ESPECIAIS (Grupo B do doc de migração
// final, classificadas por categoria antiga, não por nome), não mais pra Gentílico.
function categoriaExtraDaColecao() {
  return 'Seu Lugar';
}

// Os 5 nomes-alvo que toda combinação coleção×UF precisa (spec: "Estrutura de categorias
// esperada" + categoria extra por coleção) — sempre nesta ordem, usado tanto pelo preset de
// regras quanto pelo fallback de simulação (produto sem UF explícita, resolvido via mapa
// cidade→UF).
function nomesCategoriasAlvo(colecao, uf) {
  return [
    'SUL', `SUL - ${uf}`, `SUL - ${colecao.toUpperCase()}`, `SUL - ${colecao.toUpperCase()} - ${uf}`,
    categoriaExtraDaColecao(colecao),
  ];
}

// Resolve as 5 categorias-alvo de uma combinação coleção×UF contra as categorias reais —
// `resolvidos` tem 1 entrada por nome-alvo com `id` (null se ausente/ambíguo) e os `candidatos`
// encontrados (0, 1 ou 2+) pra o frontend oferecer escolha manual quando ambíguo.
function resolverCategoriasAlvo(nomesPorId, colecao, uf) {
  const nomes = nomesCategoriasAlvo(colecao, uf);
  const resolvidos = nomes.map((nome) => {
    const candidatos = candidatosCategoria(nomesPorId, nome);
    return { nome, id: candidatos.length === 1 ? candidatos[0].id : null, candidatos };
  });
  return { resolvidos, todasResolvidas: resolvidos.every((r) => r.id != null) };
}

// Chave de equivalência de regra pra idempotência do preset — ignora `nome`/`prioridade`/
// `habilitada` de propósito (o doc pede comparar por dimensão+condições+categorias de saída, não
// por nome, pra rodar o preset 2x não duplicar mesmo que o nome tenha sido editado manualmente).
function condicoesChave(condicoes) {
  return (condicoes || [])
    .map((c) => `${c.field}|${c.operator}|${normalizarTextoMatch(c.value)}`)
    .sort()
    .join(',');
}

// Identidade da regra SEM levar categoria de saída em conta — usada pra achar "a mesma regra,
// categorias antigas" (ex: rodar o preset de novo depois de adicionar a 5ª categoria por coleção)
// e decidir UPDATE em vez de criar uma regra nova duplicada com o mesmo nome.
function chaveDimensaoCondicoes(dimensao, condicoes) {
  return `${dimensao || ''}::${condicoesChave(condicoes)}`;
}

function chaveEquivalenciaRegra(dimensao, condicoes, categoriaIdsSaida) {
  const categoriasChave = Array.from(new Set(categoriaIdsSaida || [])).sort((a, b) => a - b).join(',');
  return `${chaveDimensaoCondicoes(dimensao, condicoes)}::${categoriasChave}`;
}

// Monta as 24 combinações coleção×UF (8×3) do preset — condições SEMPRE `contains` coleção +
// `ends_with " UF"` (nunca `contains "SC"` sozinho, spec explícito nisso pra evitar falso
// positivo tipo um produto que menta "SCanner" ou qualquer string que só contenha "sc").
function construirCombinacoesPreset() {
  const combinacoes = [];
  for (const colecao of PRESET_COLECOES) {
    for (const uf of PRESET_UFS) {
      combinacoes.push({
        nome: `${colecao} ${uf}`,
        colecao,
        uf,
        dimensao: 'colecao_uf',
        prioridade: 10,
        condicoes: [
          { field: 'product_name', operator: 'contains', value: colecao },
          { field: 'product_name', operator: 'ends_with', value: ` ${uf}` },
        ],
      });
    }
  }
  return combinacoes;
}

// Extrai a cidade do nome do produto (2 padrões conhecidos, spec "Extração da cidade") — pura,
// reaproveitada pelo discover do mapa cidade→UF e pelo fallback da simulação.
function extrairCidadeDoNomeProduto(nome) {
  const texto = String(nome || '').trim();
  const feitoEm = /^feito em\s+(.+)$/i.exec(texto);
  if (feitoEm) return feitoEm[1].trim();
  const pipeIdx = texto.indexOf('|');
  if (pipeIdx > -1) return texto.slice(0, pipeIdx).trim();
  return null;
}

function ufExplicitaDoNome(nomeNormalizado) {
  const m = /(?:^| )(rs|sc|pr)$/.exec(nomeNormalizado);
  return m ? m[1].toUpperCase() : null;
}

async function carregarCityUfMap(loja) {
  const { rows } = await pgPool.query('SELECT cidade_normalizada, uf FROM origens_migration_city_uf_map WHERE loja = $1', [loja]);
  return new Map(rows.map((r) => [r.cidade_normalizada, r.uf]));
}

const CONDICAO_FIELDS = new Set(['product_name', 'current_category']);
function validarCondicoes(condicoes) {
  const OPERADORES = new Set(['contains', 'not_contains', 'starts_with', 'ends_with', 'equals']);
  if (!Array.isArray(condicoes) || !condicoes.length) return 'condicoes é obrigatório (array não vazio)';
  for (const c of condicoes) {
    if (!c || !CONDICAO_FIELDS.has(c.field) || !OPERADORES.has(c.operator) || typeof c.value !== 'string' || !c.value.trim()) {
      return 'cada condição precisa de field="product_name" ou "current_category", operator válido e value não vazio';
    }
  }
  return null;
}

app.get('/api/admin/internal/origens-migration/rules', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'regras exigem Postgres configurado' });
  const loja = lojaLegadaDoContexto();
  const { rows } = await pgPool.query('SELECT * FROM origens_migration_rules WHERE loja = $1 ORDER BY prioridade ASC, id ASC', [loja]);
  res.json({ regras: rows });
});

app.post('/api/admin/internal/origens-migration/rules', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'regras exigem Postgres configurado' });
  const { nome, habilitada, prioridade, dimensao, condicoes } = req.body || {};
  const loja = lojaLegadaDoContexto();
  const categoriaIdsSaida = Array.isArray(req.body && req.body.categoriaIdsSaida) ? req.body.categoriaIdsSaida : null;
  if (typeof nome !== 'string' || !nome.trim()) return res.status(400).json({ error: 'nome é obrigatório' });
  const erroCondicoes = validarCondicoes(condicoes);
  if (erroCondicoes) return res.status(400).json({ error: erroCondicoes });
  if (!categoriaIdsSaida || !categoriaIdsSaida.length || !categoriaIdsSaida.every((n) => Number.isInteger(n))) {
    return res.status(400).json({ error: 'categoriaIdsSaida é obrigatório (array de inteiros)' });
  }
  try {
    const { nomesPorId } = await buildCollectionsIndex(loja);
    const regra = await inserirRegraMigracao(loja, { nome, habilitada, prioridade, dimensao, condicoes, categoriaIdsSaida }, nomesPorId);
    res.status(201).json({ regra });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao criar regra (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível criar a regra' });
  }
});

// Compartilhado entre o POST individual acima e a pré-carga do preset (Parte "preload" do doc
// claude-preload-regras-use-origens-cidade-uf.md) — nunca duplicar a validação/insert de regra.
async function inserirRegraMigracao(loja, dados, nomesPorId) {
  for (const id of dados.categoriaIdsSaida) {
    if (!nomesPorId.has(id)) { const err = new Error(`categoria ${id} não existe nesta loja`); err.status = 400; throw err; }
  }
  const { rows } = await pgPool.query(
    `INSERT INTO origens_migration_rules (loja, nome, habilitada, prioridade, dimensao, condicoes, categoria_ids_saida)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING *`,
    [
      loja, dados.nome.trim(), dados.habilitada !== false, Number.isInteger(dados.prioridade) ? dados.prioridade : 0,
      dados.dimensao || null, JSON.stringify(dados.condicoes), JSON.stringify(dados.categoriaIdsSaida),
    ]
  );
  return rows[0];
}

// Usado só pelo preset-create quando já existe uma regra com a mesma identidade (dimensão +
// condições) mas categorias antigas/incompletas (ex: rodar o preset de novo depois da 5ª
// categoria por coleção ter sido adicionada) — soma (union) em vez de substituir, pra nunca
// perder uma categoria que o usuário tenha adicionado manualmente por fora do preset.
async function atualizarCategoriasRegraMigracao(id, categoriaIdsSaida) {
  const { rows } = await pgPool.query(
    `UPDATE origens_migration_rules SET categoria_ids_saida = $1::jsonb, atualizado_em = now() WHERE id = $2 RETURNING *`,
    [JSON.stringify(categoriaIdsSaida), id]
  );
  return rows[0];
}

app.patch('/api/admin/internal/origens-migration/rules/:id', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_rules'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'regras exigem Postgres configurado' });
  const atual = await pgPool.query('SELECT * FROM origens_migration_rules WHERE id = $1', [req.params.id]);
  if (!atual.rows.length) return res.status(404).json({ error: 'regra não encontrada' });
  const regra = atual.rows[0];
  const { nome, habilitada, prioridade, dimensao, condicoes } = req.body || {};
  const categoriaIdsSaida = Array.isArray(req.body && req.body.categoriaIdsSaida) ? req.body.categoriaIdsSaida : null;
  if (condicoes !== undefined) {
    const erroCondicoes = validarCondicoes(condicoes);
    if (erroCondicoes) return res.status(400).json({ error: erroCondicoes });
  }
  if (categoriaIdsSaida) {
    if (!categoriaIdsSaida.length || !categoriaIdsSaida.every((n) => Number.isInteger(n))) {
      return res.status(400).json({ error: 'categoriaIdsSaida deve ser um array de inteiros não vazio' });
    }
    const { nomesPorId } = await buildCollectionsIndex(regra.loja);
    for (const id of categoriaIdsSaida) if (!nomesPorId.has(id)) return res.status(400).json({ error: `categoria ${id} não existe nesta loja` });
  }
  try {
    const { rows } = await pgPool.query(
      `UPDATE origens_migration_rules SET
         nome = COALESCE($1, nome), habilitada = COALESCE($2, habilitada), prioridade = COALESCE($3, prioridade),
         dimensao = COALESCE($4, dimensao), condicoes = COALESCE($5::jsonb, condicoes), categoria_ids_saida = COALESCE($6::jsonb, categoria_ids_saida),
         atualizado_em = now()
       WHERE id = $7 RETURNING *`,
      [
        typeof nome === 'string' && nome.trim() ? nome.trim() : null,
        typeof habilitada === 'boolean' ? habilitada : null,
        Number.isInteger(prioridade) ? prioridade : null,
        dimensao !== undefined ? (dimensao || null) : null,
        condicoes !== undefined ? JSON.stringify(condicoes) : null,
        categoriaIdsSaida ? JSON.stringify(categoriaIdsSaida) : null,
        req.params.id,
      ]
    );
    res.json({ regra: rows[0] });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao editar regra ${req.params.id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível editar a regra' });
  }
});

app.delete('/api/admin/internal/origens-migration/rules/:id', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_rules'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'regras exigem Postgres configurado' });
  await pgPool.query('DELETE FROM origens_migration_rules WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Insere os itens da simulação em lotes de INSERT multi-linha (não unnest de N arrays paralelos
// — mais simples de acertar, e 500 linhas × 10 params fica bem abaixo do limite de parâmetros do
// Postgres por query).
async function inserirSimulationItemsEmLote(simulationId, itens) {
  const BATCH = 500;
  for (let i = 0; i < itens.length; i += BATCH) {
    const lote = itens.slice(i, i + BATCH);
    const values = [];
    const params = [];
    lote.forEach((it, idx) => {
      const base = idx * 14;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4}::jsonb,$${base + 5},$${base + 6},$${base + 7},$${base + 8}::jsonb,$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14})`
      );
      params.push(
        simulationId, it.product_id, it.product_name,
        JSON.stringify(it.matched_rule_ids), it.collection, it.uf, it.regiao,
        JSON.stringify(it.categorias_finais), it.status, it.conflito_motivo,
        it.cidade_detectada || null, it.fonte_uf || null, it.confianca || null, it.fonte_classificacao || null
      );
    });
    await pgPool.query(
      `INSERT INTO origens_migration_simulation_items
         (simulation_id, product_id, product_name, matched_rule_ids, collection_detectada, uf_detectada, regiao_detectada, categorias_finais, status, conflito_motivo, cidade_detectada, fonte_uf, confianca, fonte_classificacao)
       VALUES ${values.join(',')}`,
      params
    );
  }
}

// Fallback (doc: claude-preload-regras-use-origens-cidade-uf.md) — só roda pra produtos que NÃO
// bateram em nenhuma regra explícita; nunca mexe no caminho normal de match de regra (inclusive a
// detecção de conflito por dimensão continua exatamente como estava). Extraída pra função de
// nível de módulo (antes era um closure dentro do endpoint) pra poder ser chamada 1x por produto,
// página por página, no processamento em background.
function resolverFallbackCidadeUf(p, nomeNorm, nomesPorId, cityUfMap) {
  const colecaoDetectada = PRESET_COLECOES.find((c) => nomeNorm.includes(normalizarTextoMatch(c))) || null;
  if (!colecaoDetectada) {
    return { product_id: p.id, product_name: p.name, matched_rule_ids: [], status: 'sem_regra', categorias_finais: [], conflito_motivo: null, collection: null, uf: null, regiao: null, cidade_detectada: null, fonte_uf: null, confianca: null, fonte_classificacao: 'fallback_cidade' };
  }

  const ufExplicita = ufExplicitaDoNome(nomeNorm);
  const cidadeBruta = extrairCidadeDoNomeProduto(p.name);
  const cidadeNorm = cidadeBruta ? normalizarTextoMatch(cidadeBruta) : null;
  const ufDoMapa = cidadeNorm ? cityUfMap.get(cidadeNorm) : null;

  let ufResolvida = null;
  let fonteUf = null;
  let confianca = null;
  let conflitoMotivo = null;

  if (ufExplicita) {
    // Precedência (spec): UF explícita no título é a fonte principal — mas se o mapa da
    // cidade discordar dela, é sinal de possível erro de cadastro, então manda pra revisão
    // em vez de confiar cegamente.
    if (ufDoMapa && ufDoMapa !== ufExplicita) {
      conflitoMotivo = `UF explícita ("${ufExplicita}") diverge do mapa da cidade ("${cidadeBruta}" → ${ufDoMapa})`;
      confianca = 'revisar';
    } else {
      ufResolvida = ufExplicita; fonteUf = 'titulo'; confianca = 'alta';
    }
  } else if (cidadeNorm && ufDoMapa) {
    ufResolvida = ufDoMapa; fonteUf = 'mapa_cidade'; confianca = 'alta';
  } else if (cidadeNorm) {
    conflitoMotivo = 'cidade sem UF mapeada'; confianca = 'revisar';
  } else {
    conflitoMotivo = 'não foi possível extrair cidade do nome'; confianca = 'revisar';
  }

  let categoriasFinais = [];
  if (ufResolvida && !conflitoMotivo) {
    const { resolvidos, todasResolvidas } = resolverCategoriasAlvo(nomesPorId, colecaoDetectada, ufResolvida);
    if (todasResolvidas) categoriasFinais = resolvidos.map((r) => r.id);
    else { conflitoMotivo = 'categoria de saída ausente'; confianca = 'revisar'; }
  }

  return {
    product_id: p.id,
    product_name: p.name,
    matched_rule_ids: [],
    status: conflitoMotivo ? 'conflito' : 'pronto',
    conflito_motivo: conflitoMotivo,
    categorias_finais: categoriasFinais,
    collection: colecaoDetectada,
    uf: ufResolvida || ufExplicita || null,
    regiao: 'Sul',
    cidade_detectada: cidadeBruta,
    fonte_uf: fonteUf,
    confianca,
    fonte_classificacao: 'fallback_cidade',
  };
}

// Classifica 1 produto (match de regra explícita — por nome OU por categoria atual —, ou fallback
// cidade→UF se nenhuma regra bateu). `indiceCollections` (productId -> Set(categoriaId)) é o
// mesmo índice já construído por buildCollectionsIndex — dá a categoria ATUAL do produto sem
// nenhuma chamada nova à Ink (doc: claude-migracao-final-categorias-snapshot-especiais.md).
function classificarProdutoMigracao(p, regras, nomesPorId, categoriasExistentesIds, cityUfMap, indiceCollections) {
  const nomeNorm = normalizarTextoMatch(p.name);
  const categoriaIdsAtuais = (indiceCollections && indiceCollections.get(p.id)) || new Set();
  const categoriasAtuaisNormalizadas = Array.from(categoriaIdsAtuais)
    .map((id) => nomesPorId.get(id))
    .filter(Boolean)
    .map((nome) => normalizarTextoMatch(nome));
  const contexto = { nomeNormalizado: nomeNorm, categoriasAtuaisNormalizadas };
  const matched = regras.filter((r) => regraBate(contexto, r));
  if (!matched.length) {
    return resolverFallbackCidadeUf(p, nomeNorm, nomesPorId, cityUfMap);
  }
  // Fonte predominante da classificação (só pra auditoria/relatório — Etapa 4 do doc): se
  // QUALQUER regra batida tiver ao menos 1 condição current_category, marca como "categoria_atual"
  // (é o caso que realmente importa destacar — coleção especial que só a categoria de origem
  // identifica); senão, "nome" (comportamento de sempre, Grupo A).
  const usouCategoriaAtual = matched.some((r) => (r.condicoes || []).some((c) => c.field === 'current_category'));
  const fonteClassificacao = usouCategoriaAtual ? 'categoria_atual' : 'nome';

  const idsAusentes = [];
  for (const r of matched) for (const cid of (r.categoria_ids_saida || [])) if (!categoriasExistentesIds.has(cid) && !idsAusentes.includes(cid)) idsAusentes.push(cid);

  // Conflito de dimensão: 2+ regras habilitadas da MESMA dimensão (uf/colecao/regiao — campo
  // livre) apontando pra CONJUNTOS DE CATEGORIA DIFERENTES no mesmo produto (ex: bate em "Legado
  // SC" e "Legado RS" ao mesmo tempo) — dimensões são tratadas como mutuamente exclusivas (doc:
  // "detecta duas UFs" = conflito).
  //
  // BUG CORRIGIDO (2026-09-09): antes disso, `porDimensao` juntava todos os IDs de categoria
  // soltos num Set só e checava `size > 1` — mas cada regra do preset já produz 5 categorias
  // DIFERENTES por design (SUL + UF + coleção + coleção-UF + extra "Seu Lugar"/"Fala Daqui"),
  // então QUALQUER produto que batesse em 1 regra só (o caso normal) já tinha um Set de tamanho 5
  // e virava "conflito" por engano — nunca era comparação entre regras, era o próprio conjunto de
  // 1 regra sendo confundido com ambiguidade. Corrigido comparando CONJUNTOS (por regra), não IDs
  // soltos: só é conflito de verdade quando 2+ regras da mesma dimensão têm conjuntos diferentes.
  const porDimensao = new Map(); // dimensao -> Set<categoriaId> (usado só pra exibir nome/UF/coleção)
  const porDimensaoConjuntos = new Map(); // dimensao -> Set<"idsOrdenados,juntos"> (usado pra detectar conflito real)
  for (const r of matched) {
    if (!r.dimensao) continue;
    const ids = r.categoria_ids_saida || [];
    if (!porDimensao.has(r.dimensao)) porDimensao.set(r.dimensao, new Set());
    ids.forEach((cid) => porDimensao.get(r.dimensao).add(cid));
    if (!porDimensaoConjuntos.has(r.dimensao)) porDimensaoConjuntos.set(r.dimensao, new Set());
    porDimensaoConjuntos.get(r.dimensao).add(ids.slice().sort((a, b) => a - b).join(','));
  }
  let conflitoMotivo = null;
  if (idsAusentes.length) {
    conflitoMotivo = `categoria(s) referenciada(s) por regra não existe(m) mais: ${idsAusentes.join(', ')}`;
  } else {
    for (const [dim, conjuntos] of porDimensaoConjuntos) {
      if (conjuntos.size > 1) {
        const ids = porDimensao.get(dim);
        conflitoMotivo = `mais de uma categoria de "${dim}" detectada (${Array.from(ids).map((id) => nomesPorId.get(id) || `#${id}`).join(', ')})`;
        break;
      }
    }
  }

  const categoriasFinais = conflitoMotivo ? [] : Array.from(new Set(matched.flatMap((r) => r.categoria_ids_saida || [])));
  const nomeDimensao = (dim) => (porDimensao.get(dim) ? Array.from(porDimensao.get(dim)).map((id) => nomesPorId.get(id) || `#${id}`).join(', ') : null);

  return {
    product_id: p.id,
    product_name: p.name,
    matched_rule_ids: matched.map((r) => r.id),
    status: conflitoMotivo ? 'conflito' : 'pronto',
    conflito_motivo: conflitoMotivo,
    categorias_finais: categoriasFinais,
    collection: nomeDimensao('colecao'),
    uf: nomeDimensao('uf'),
    regiao: nomeDimensao('regiao'),
    fonte_classificacao: fonteClassificacao,
  };
}

// Guard em memória contra 2 simulações da MESMA loja rodando ao mesmo tempo (ex: usuário clica 2x
// em "Simular migração") — simulação é só leitura (nunca faz PATCH), então não corrompe nada, mas
// rodar 2x ao mesmo tempo desperdiça chamadas à Ink e polui o histórico à toa.
const lojasSimulandoMigracao = new Set();

// A migração precisa analisar o CATÁLOGO INTEIRO — PRODUTOS_BUSCA_MAX_PAGINAS (50 páginas =
// 5.000 produtos) é um teto pensado pra busca interativa (campo de busca de produto), não serve
// aqui. Bug real corrigido (2026-09-09): a simulação estava reaproveitando esse mesmo teto e
// analisando só uma fatia da loja silenciosamente, sem avisar que parou antes do fim. Teto bem
// mais alto aqui, só como rede de segurança contra loop infinito em caso de resposta inesperada
// da Ink, nunca pra ser atingido de verdade (100k produtos).
const MIGRACAO_MAX_PAGINAS = 1000;

// Processa a simulação em background, PÁGINA POR PÁGINA da Ink (não busca tudo de uma vez): cada
// página já processada (match de regra + fallback) é inserida e o progresso é gravado, pra o
// polling do frontend mostrar avanço real em vez de travar esperando o catálogo inteiro. Nenhuma
// chamada à Ink acontece dentro do ciclo de request/response do endpoint que dispara isso.
async function processarSimulacaoMigracao(simulationId, loja) {
  let totalProntos = 0;
  let totalSemRegra = 0;
  let totalConflito = 0;
  let produtosProcessados = 0;
  try {
    const { rows: regras } = await pgPool.query(
      `SELECT * FROM origens_migration_rules WHERE loja = $1 AND habilitada = true ORDER BY prioridade ASC, id ASC`, [loja]
    );
    // `indice` (productId -> Set(categoriaId)) era descartado antes — agora precisa ir adiante pra
    // classificarProdutoMigracao poder decidir condições `current_category` (Grupo B, coleções
    // especiais só identificáveis pela categoria de origem, não pelo nome).
    const [{ indice, nomesPorId }, cityUfMap] = await Promise.all([buildCollectionsIndex(loja), carregarCityUfMap(loja)]);
    const categoriasExistentesIds = new Set(nomesPorId.keys());

    let page = 1;
    let totalPages = 1;
    do {
      const query = new URLSearchParams();
      query.set('page', String(page));
      query.set('per_page', '100');
      const data = await inkApiRequest(loja, `/v1/stores/products?${query.toString()}`);
      const produtosPagina = data.products || [];
      totalPages = Math.min(data.total_pages || 1, MIGRACAO_MAX_PAGINAS);

      const itensPagina = produtosPagina.map((p) => classificarProdutoMigracao(p, regras, nomesPorId, categoriasExistentesIds, cityUfMap, indice));
      if (itensPagina.length) await inserirSimulationItemsEmLote(simulationId, itensPagina);

      totalProntos += itensPagina.filter((i) => i.status === 'pronto').length;
      totalSemRegra += itensPagina.filter((i) => i.status === 'sem_regra').length;
      totalConflito += itensPagina.filter((i) => i.status === 'conflito').length;
      produtosProcessados += produtosPagina.length;

      await pgPool.query(
        `UPDATE origens_migration_simulations SET paginas_processadas = $1, paginas_total = $2, produtos_processados = $3 WHERE id = $4`,
        [page, totalPages, produtosProcessados, simulationId]
      );
      page += 1;
    } while (page <= totalPages);

    await pgPool.query(
      `UPDATE origens_migration_simulations
         SET status = 'simulada', total_analisados = $1, total_prontos = $2, total_sem_regra = $3, total_conflito = $4
       WHERE id = $5`,
      [produtosProcessados, totalProntos, totalSemRegra, totalConflito, simulationId]
    );
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao processar simulação ${simulationId} (${loja}): ${err.message}`);
    await pgPool.query(
      `UPDATE origens_migration_simulations SET status = 'falhou', erro = $1 WHERE id = $2`,
      [String(err.message || 'erro desconhecido').slice(0, 500), simulationId]
    ).catch(() => {});
  } finally {
    lojasSimulandoMigracao.delete(loja);
  }
}

// Simulação nunca faz PATCH (spec, Parte 5) — só leituras paginadas da Ink (produtos + índice de
// categorias) e cálculo/persistência local. Responde IMEDIATAMENTE com o id da simulação (criada
// em status 'processando') e processa em background — lojas com muitos produtos podem levar bem
// mais que a duração de uma request HTTP pra paginar tudo na Ink, e travar a resposta esperando
// isso não dava nenhum feedback de progresso (bug real reportado pelo usuário, 2026-09-09).
app.post('/api/admin/internal/origens-migration/simulate', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'simulação exige Postgres configurado' });
  const loja = lojaLegadaDoContexto();
  if (lojasSimulandoMigracao.has(loja)) {
    return res.status(409).json({ error: 'já existe uma simulação em andamento para esta loja — aguarde terminar' });
  }

  try {
    const simRows = await pgPool.query(
      `INSERT INTO origens_migration_simulations (loja, status) VALUES ($1, 'processando') RETURNING id`,
      [loja]
    );
    const simulationId = simRows.rows[0].id;
    lojasSimulandoMigracao.add(loja);
    processarSimulacaoMigracao(simulationId, loja).catch((err) => {
      console.error(`[ORIGENS_MIGRATION] falha não tratada na simulação ${simulationId}: ${err.message}`);
    });
    res.status(202).json({ simulationId });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao iniciar simulação (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível iniciar a simulação' });
  }
});

app.get('/api/admin/internal/origens-migration/simulations/:id', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'simulações exigem Postgres configurado' });
  const { rows } = await pgPool.query('SELECT * FROM origens_migration_simulations WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'simulação não encontrada' });
  res.json({ simulacao: rows[0] });
});

// Reavalia só os itens 'sem_regra'/'conflito' de uma simulação já existente, usando as
// regras/mapa cidade→UF/categorias ATUAIS — pedido do usuário (2026-09-10): depois de importar o
// dicionário de municípios (ou criar regra nova, ou criar categoria que faltava), não precisa
// rodar uma simulação nova do zero (que paginaria o catálogo inteiro de novo, minutos) — o nome
// do produto já está salvo no item, então dá pra reclassificar sem nenhuma chamada nova à Ink
// pra buscar produto (só o índice de categorias, que é 1 chamada só pra loja inteira).
// Nunca mexe em item com override manual (`override_categorias`/`override_ignorar`) — isso é
// decisão do usuário, reavaliar não deve sobrescrever.
async function reavaliarConflitosSimulacao(simulationId) {
  const { rows: simRows } = await pgPool.query('SELECT * FROM origens_migration_simulations WHERE id = $1', [simulationId]);
  if (!simRows.length) { const err = new Error('simulação não encontrada'); err.status = 404; throw err; }
  const sim = simRows[0];

  const { rows: itens } = await pgPool.query(
    `SELECT id, product_id, product_name FROM origens_migration_simulation_items
     WHERE simulation_id = $1 AND status IN ('sem_regra', 'conflito') AND override_categorias IS NULL AND override_ignorar = false`,
    [simulationId]
  );
  if (!itens.length) return { reavaliados: 0, resolvidos: 0, aindaPendente: 0 };

  const { rows: regras } = await pgPool.query(
    `SELECT * FROM origens_migration_rules WHERE loja = $1 AND habilitada = true ORDER BY prioridade ASC, id ASC`, [sim.loja]
  );
  const [{ indice, nomesPorId }, cityUfMap] = await Promise.all([buildCollectionsIndex(sim.loja), carregarCityUfMap(sim.loja)]);
  const categoriasExistentesIds = new Set(nomesPorId.keys());

  let resolvidos = 0;
  for (const item of itens) {
    const resultado = classificarProdutoMigracao({ id: item.product_id, name: item.product_name }, regras, nomesPorId, categoriasExistentesIds, cityUfMap, indice);
    await pgPool.query(
      `UPDATE origens_migration_simulation_items SET
         matched_rule_ids = $1::jsonb, collection_detectada = $2, uf_detectada = $3, regiao_detectada = $4,
         categorias_finais = $5::jsonb, status = $6, conflito_motivo = $7,
         cidade_detectada = $8, fonte_uf = $9, confianca = $10, fonte_classificacao = $11, atualizado_em = now()
       WHERE id = $12`,
      [
        JSON.stringify(resultado.matched_rule_ids), resultado.collection, resultado.uf, resultado.regiao,
        JSON.stringify(resultado.categorias_finais), resultado.status, resultado.conflito_motivo,
        resultado.cidade_detectada || null, resultado.fonte_uf || null, resultado.confianca || null, resultado.fonte_classificacao || null,
        item.id,
      ]
    );
    if (resultado.status === 'pronto') resolvidos += 1;
  }

  // Recalcula os totais a partir do estado real da tabela — mais seguro que incrementar contador
  // na mão, já que só uma FATIA dos itens foi reavaliada agora (os que já estavam 'pronto'/com
  // override continuam de fora da contagem recalculada aqui, então soma com o que não mudou).
  const { rows: totais } = await pgPool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pronto') AS prontos,
       COUNT(*) FILTER (WHERE status = 'sem_regra') AS sem_regra,
       COUNT(*) FILTER (WHERE status = 'conflito') AS conflito
     FROM origens_migration_simulation_items WHERE simulation_id = $1`,
    [simulationId]
  );
  await pgPool.query(
    `UPDATE origens_migration_simulations SET total_prontos = $1, total_sem_regra = $2, total_conflito = $3 WHERE id = $4`,
    [Number(totais[0].prontos), Number(totais[0].sem_regra), Number(totais[0].conflito), simulationId]
  );

  return { reavaliados: itens.length, resolvidos, aindaPendente: itens.length - resolvidos };
}

app.post('/api/admin/internal/origens-migration/simulations/:id/reavaliar-conflitos', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  try {
    const resultado = await reavaliarConflitosSimulacao(Number(req.params.id));
    res.json(resultado);
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao reavaliar conflitos da simulação ${req.params.id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível reavaliar os conflitos' });
  }
});

// Correção pontual (2026-09-11): as 3 regras Gentílico×UF do preset foram criadas ANTES de
// categoriaExtraDaColecao() unificar em "Seu Lugar" (2026-09-10) — ficaram com "Fala Daqui"
// gravado no categoria_ids_saida, categoria essa que hoje só deveria valer pras coleções
// ESPECIAIS (Grupo B). A execução real já rodou (84053 itens, 83106 sucesso, 947 falha) usando
// essa regra desatualizada, então produtos Gentílico foram/serão aplicados na Ink com a categoria
// errada. Reexecutar a simulação inteira (repaginar 85k produtos) é desnecessário: o problema é
// só a categoria extra de 1 coleção, corrigível sem tocar na Ink de novo (Parte 6 nunca releu
// categorias_finais — quem manda de verdade é bulk_category_job_items.categoria_ids_alvo, já
// congelado desde a criação do job de execução).
//
// Corrige nos 2 lugares que importam pra valer: (1) a(s) regra(s) em origens_migration_rules —
// nunca apaga, só troca o id errado pelo certo, pra não errar de novo numa reavaliação futura; (2)
// categoria_ids_alvo dos itens JÁ enfileirados/executados (sucesso OU falha) que tinham o id
// errado — só esses voltam pra 'pending' (não os 83106 inteiros), pra fila reprocessar com o alvo
// corrigido. categorias_finais da simulação é corrigido também, só pra manter relatório/CSV
// coerentes (não influencia a execução).
async function localizarCorrecaoCategoriaExtra(simulationId, nomeAntigo, nomeNovo) {
  const simRows = await pgPool.query('SELECT * FROM origens_migration_simulations WHERE id = $1', [simulationId]);
  if (!simRows.rows.length) { const err = new Error('simulação não encontrada'); err.status = 404; throw err; }
  const sim = simRows.rows[0];
  if (!sim.job_id) { const err = new Error('essa simulação ainda não foi executada (sem job de execução vinculado)'); err.status = 400; throw err; }

  const { nomesPorId } = await buildCollectionsIndex(sim.loja);
  const antigos = candidatosCategoria(nomesPorId, nomeAntigo);
  const novos = candidatosCategoria(nomesPorId, nomeNovo);
  if (antigos.length !== 1) { const err = new Error(`não encontrei exatamente 1 categoria "${nomeAntigo}" nesta loja (${antigos.length} encontrada(s))`); err.status = 400; throw err; }
  if (novos.length !== 1) { const err = new Error(`não encontrei exatamente 1 categoria "${nomeNovo}" nesta loja (${novos.length} encontrada(s))`); err.status = 400; throw err; }
  const idAntigo = antigos[0].id;
  const idNovo = novos[0].id;

  const { rows: regras } = await pgPool.query('SELECT id, categoria_ids_saida FROM origens_migration_rules WHERE loja = $1', [sim.loja]);
  const regrasAfetadas = regras.filter((r) => (r.categoria_ids_saida || []).includes(idAntigo));

  const { rows: itensAfetados } = await pgPool.query(
    `SELECT id, product_id, status, categoria_ids_alvo FROM bulk_category_job_items
     WHERE job_id = $1 AND categoria_ids_alvo @> $2::jsonb`,
    [sim.job_id, JSON.stringify([idAntigo])]
  );

  return { sim, idAntigo, idNovo, regrasAfetadas, itensAfetados };
}

app.get('/api/admin/internal/origens-migration/simulations/:id/corrigir-categoria-extra/preview', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const { categoriaAntiga, categoriaNova } = req.query;
  if (!categoriaAntiga || !categoriaNova) return res.status(400).json({ error: 'categoriaAntiga e categoriaNova são obrigatórios (nomes das categorias)' });
  try {
    const { idAntigo, idNovo, regrasAfetadas, itensAfetados } = await localizarCorrecaoCategoriaExtra(Number(req.params.id), categoriaAntiga, categoriaNova);
    const porStatus = {};
    for (const it of itensAfetados) porStatus[it.status] = (porStatus[it.status] || 0) + 1;
    res.json({
      categoriaAntigaId: idAntigo,
      categoriaNovaId: idNovo,
      regrasAfetadas: regrasAfetadas.map((r) => r.id),
      itensAfetados: itensAfetados.length,
      itensPorStatus: porStatus,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'não foi possível gerar o preview da correção' });
  }
});

app.post('/api/admin/internal/origens-migration/simulations/:id/corrigir-categoria-extra', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const { categoriaAntiga, categoriaNova } = req.body || {};
  if (!categoriaAntiga || !categoriaNova) return res.status(400).json({ error: 'categoriaAntiga e categoriaNova são obrigatórios (nomes das categorias)' });
  try {
    const { sim, idAntigo, idNovo, regrasAfetadas, itensAfetados } = await localizarCorrecaoCategoriaExtra(Number(req.params.id), categoriaAntiga, categoriaNova);

    for (const r of regrasAfetadas) {
      const novo = Array.from(new Set((r.categoria_ids_saida || []).filter((id) => id !== idAntigo).concat(idNovo))).sort((a, b) => a - b);
      await pgPool.query('UPDATE origens_migration_rules SET categoria_ids_saida = $1::jsonb, atualizado_em = now() WHERE id = $2', [JSON.stringify(novo), r.id]);
    }

    let resetadosParaPending = 0;
    for (const item of itensAfetados) {
      const novoAlvo = Array.from(new Set((item.categoria_ids_alvo || []).filter((id) => id !== idAntigo).concat(idNovo))).sort((a, b) => a - b);
      const precisaReprocessar = item.status === 'success' || item.status === 'failed' || item.status === 'skipped';
      await pgPool.query(
        `UPDATE bulk_category_job_items SET
           categoria_ids_alvo = $1::jsonb,
           status = CASE WHEN status IN ('success','failed','skipped') THEN 'pending' ELSE status END,
           attempts = CASE WHEN status IN ('success','failed','skipped') THEN 0 ELSE attempts END,
           error = CASE WHEN status IN ('success','failed','skipped') THEN NULL ELSE error END,
           atualizado_em = now()
         WHERE id = $2`,
        [JSON.stringify(novoAlvo), item.id]
      );
      if (precisaReprocessar) resetadosParaPending += 1;
    }

    if (itensAfetados.length) {
      const { rows: itensSimAfetados } = await pgPool.query(
        `SELECT id, categorias_finais FROM origens_migration_simulation_items
         WHERE simulation_id = $1 AND product_id = ANY($2) AND categorias_finais @> $3::jsonb`,
        [sim.id, itensAfetados.map((it) => it.product_id), JSON.stringify([idAntigo])]
      );
      for (const it of itensSimAfetados) {
        const corrigido = Array.from(new Set((it.categorias_finais || []).filter((id) => id !== idAntigo).concat(idNovo))).sort((a, b) => a - b);
        await pgPool.query('UPDATE origens_migration_simulation_items SET categorias_finais = $1::jsonb, atualizado_em = now() WHERE id = $2', [JSON.stringify(corrigido), it.id]);
      }
    }

    // Mesma transição que retry-failed já faz — reabre o job/simulação pra fila
    // (processarBulkCategoryJobs, ciclo de 15s) pegar os itens resetados de novo sozinha.
    await pgPool.query(
      `UPDATE bulk_category_jobs SET status = 'running', finalizado_em = NULL, atualizado_em = now()
       WHERE id = $1 AND status IN ('completed_with_errors', 'failed', 'cancelled')`,
      [sim.job_id]
    );
    await pgPool.query(
      `UPDATE origens_migration_simulations SET status = 'executando', executada_em = NULL WHERE id = $1 AND status = 'executada'`,
      [sim.id]
    );

    res.json({
      regrasCorrigidas: regrasAfetadas.length,
      itensAfetados: itensAfetados.length,
      resetadosParaPending,
    });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao corrigir categoria extra (sim ${req.params.id}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível aplicar a correção' });
  }
});

// Correção da correção (2026-09-11): a troca acima usou um filtro largo demais — QUALQUER item
// cujo categoria_ids_alvo continha "Fala Daqui" foi trocado pra "Seu Lugar", mas "Fala Daqui"
// também é o destino LEGÍTIMO de outras estampas/coleções (via alguma regra que não é uma das 5
// do Gentílico) — essas foram movidas por engano. matched_rule_ids não foi tocado pela correção
// anterior (só categorias_finais/categoria_ids_alvo mudaram), então ainda reflete com quem cada
// item bateu de verdade — é a fonte confiável pra separar "é Gentílico" de "só passou perto".
// Em vez de tentar reverter manualmente (arriscado: um item pode legitimamente merecer "Seu
// Lugar" de uma regra E "Fala Daqui" de outra ao mesmo tempo), reclassifica do zero com
// classificarProdutoMigracao usando as regras JÁ corrigidas — quem bate numa das 5 regras
// Gentílico sai com "Seu Lugar" (correto, idempotente); quem bate em outra regra sai com o que
// essa outra regra sempre disse (essa nunca foi tocada), sem precisar adivinhar.
app.get('/api/admin/internal/origens-migration/simulations/:id/auditoria-fala-daqui', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const { categoriaAntiga, regraIdsGentilico } = req.query;
  if (!categoriaAntiga || !regraIdsGentilico) return res.status(400).json({ error: 'categoriaAntiga e regraIdsGentilico (csv) são obrigatórios' });
  try {
    const simRows = await pgPool.query('SELECT * FROM origens_migration_simulations WHERE id = $1', [req.params.id]);
    if (!simRows.rows.length) return res.status(404).json({ error: 'simulação não encontrada' });
    const sim = simRows.rows[0];
    const idsGentilico = String(regraIdsGentilico).split(',').map((s) => s.trim()).filter(Boolean);

    const { nomesPorId } = await buildCollectionsIndex(sim.loja);
    const antigos = candidatosCategoria(nomesPorId, categoriaAntiga);
    if (antigos.length !== 1) return res.status(400).json({ error: `não encontrei exatamente 1 categoria "${categoriaAntiga}" (${antigos.length} encontrada(s))` });
    const idAntigo = antigos[0].id;

    // Outras regras (fora as 5 do Gentílico) que também têm "Fala Daqui" no categoria_ids_saida —
    // se existir alguma, é o destino legítimo de outra coleção, não bug.
    const { rows: outrasRegras } = await pgPool.query(
      `SELECT id, nome, dimensao, condicoes, categoria_ids_saida FROM origens_migration_rules
       WHERE loja = $1 AND categoria_ids_saida @> $2::jsonb AND NOT (id = ANY($3::bigint[]))`,
      [sim.loja, JSON.stringify([idAntigo]), idsGentilico]
    );

    // Itens da simulação que bateram em alguma dessas "outras regras" — universo real de itens
    // afetados por engano pela correção anterior.
    let itensAtingidosPorEngano = [];
    if (outrasRegras.length) {
      const outrosIds = outrasRegras.map((r) => String(r.id));
      const { rows } = await pgPool.query(
        `SELECT si.id AS sim_item_id, si.product_id, si.product_name, si.collection_detectada, si.matched_rule_ids,
                bci.id AS job_item_id, bci.status, bci.categoria_ids_alvo
         FROM origens_migration_simulation_items si
         JOIN bulk_category_job_items bci ON bci.job_id = $1 AND bci.product_id = si.product_id
         WHERE si.simulation_id = $2
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(si.matched_rule_ids) AS mrid WHERE mrid = ANY($3::text[]))`,
        [sim.job_id, sim.id, outrosIds]
      );
      itensAtingidosPorEngano = rows;
    }

    const porStatus = {};
    for (const it of itensAtingidosPorEngano) porStatus[it.status] = (porStatus[it.status] || 0) + 1;
    const colecoesAmostra = Array.from(new Set(itensAtingidosPorEngano.map((it) => it.collection_detectada).filter(Boolean))).slice(0, 20);

    res.json({
      categoriaAntigaId: idAntigo,
      outrasRegrasComFalaDaqui: outrasRegras.map((r) => ({ id: r.id, nome: r.nome, dimensao: r.dimensao, condicoes: r.condicoes })),
      itensAtingidosPorEngano: itensAtingidosPorEngano.length,
      itensPorStatus: porStatus,
      colecoesDetectadasAmostra: colecoesAmostra,
    });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha na auditoria fala-daqui (sim ${req.params.id}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível gerar a auditoria' });
  }
});

// Aplica a correção real: reclassifica do zero (classificarProdutoMigracao, regras atuais já
// corrigidas) só os itens que bateram numa regra "outra" (não-Gentílico) que também tinha "Fala
// Daqui" no destino — restaura o que essa regra sempre disse, sem tocar em quem é Gentílico de
// verdade nem em quem nunca teve Fala Daqui no meio do caminho.
app.post('/api/admin/internal/origens-migration/simulations/:id/corrigir-fala-daqui-indevido', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const { regraIdsOutras } = req.body || {};
  if (!Array.isArray(regraIdsOutras) || !regraIdsOutras.length) return res.status(400).json({ error: 'regraIdsOutras (array de ids) é obrigatório' });
  try {
    const simRows = await pgPool.query('SELECT * FROM origens_migration_simulations WHERE id = $1', [req.params.id]);
    if (!simRows.rows.length) return res.status(404).json({ error: 'simulação não encontrada' });
    const sim = simRows.rows[0];
    const outrosIds = regraIdsOutras.map(String);

    const { rows: itens } = await pgPool.query(
      `SELECT si.id AS sim_item_id, si.product_id, si.product_name, si.override_categorias, si.override_ignorar,
              bci.id AS job_item_id, bci.status AS job_item_status, bci.categoria_ids_alvo
       FROM origens_migration_simulation_items si
       JOIN bulk_category_job_items bci ON bci.job_id = $1 AND bci.product_id = si.product_id
       WHERE si.simulation_id = $2
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(si.matched_rule_ids) AS mrid WHERE mrid = ANY($3::text[]))`,
      [sim.job_id, sim.id, outrosIds]
    );
    if (!itens.length) return res.json({ reclassificados: 0, resetadosParaPending: 0, comOverrideIgnorados: 0 });

    const { rows: regras } = await pgPool.query(
      `SELECT * FROM origens_migration_rules WHERE loja = $1 AND habilitada = true ORDER BY prioridade ASC, id ASC`, [sim.loja]
    );
    const [{ indice, nomesPorId }, cityUfMap] = await Promise.all([buildCollectionsIndex(sim.loja), carregarCityUfMap(sim.loja)]);
    const categoriasExistentesIds = new Set(nomesPorId.keys());

    let reclassificados = 0;
    let resetadosParaPending = 0;
    let comOverrideIgnorados = 0;
    for (const item of itens) {
      if (item.override_categorias != null || item.override_ignorar) { comOverrideIgnorados += 1; continue; }

      const resultado = classificarProdutoMigracao({ id: item.product_id, name: item.product_name }, regras, nomesPorId, categoriasExistentesIds, cityUfMap, indice);
      await pgPool.query(
        `UPDATE origens_migration_simulation_items SET
           matched_rule_ids = $1::jsonb, collection_detectada = $2, uf_detectada = $3, regiao_detectada = $4,
           categorias_finais = $5::jsonb, status = $6, conflito_motivo = $7, atualizado_em = now()
         WHERE id = $8`,
        [
          JSON.stringify(resultado.matched_rule_ids), resultado.collection, resultado.uf, resultado.regiao,
          JSON.stringify(resultado.categorias_finais), resultado.status, resultado.conflito_motivo, item.sim_item_id,
        ]
      );
      reclassificados += 1;

      const alvoAtual = item.categoria_ids_alvo || [];
      const alvoCorrigido = resultado.categorias_finais || [];
      const mudou = JSON.stringify(Array.from(alvoAtual).sort()) !== JSON.stringify(Array.from(alvoCorrigido).sort());
      if (!mudou) continue;

      const precisaReprocessar = ['success', 'failed', 'skipped'].includes(item.job_item_status);
      await pgPool.query(
        `UPDATE bulk_category_job_items SET
           categoria_ids_alvo = $1::jsonb,
           status = CASE WHEN status IN ('success','failed','skipped') THEN 'pending' ELSE status END,
           attempts = CASE WHEN status IN ('success','failed','skipped') THEN 0 ELSE attempts END,
           error = CASE WHEN status IN ('success','failed','skipped') THEN NULL ELSE error END,
           atualizado_em = now()
         WHERE id = $2`,
        [JSON.stringify(alvoCorrigido), item.job_item_id]
      );
      if (precisaReprocessar) resetadosParaPending += 1;
    }

    await atualizarContadoresBulkCategoryJob(sim.job_id);
    res.json({ reclassificados, resetadosParaPending, comOverrideIgnorados });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao corrigir fala-daqui indevido (sim ${req.params.id}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível aplicar a correção' });
  }
});

app.get('/api/admin/internal/origens-migration/simulations', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'simulações exigem Postgres configurado' });
  const loja = lojaLegadaDoContexto();
  const { rows } = await pgPool.query(
    `SELECT s.*, j.status AS job_status, j.processed AS job_processed, j.total AS job_total, j.succeeded AS job_succeeded, j.failed AS job_failed
     FROM origens_migration_simulations s LEFT JOIN bulk_category_jobs j ON j.id = s.job_id
     WHERE s.loja = $1 ORDER BY s.criado_em DESC LIMIT 50`,
    [loja]
  );
  res.json({ simulacoes: rows });
});

// Correção direta por NOME (2026-09-11): a correção por regra (corrigir-categoria-extra) ficou
// correta segundo o motor — a auditoria não achou nenhuma OUTRA regra com "Fala Daqui" no
// destino. Mas no painel real da Ink, "Fala Daqui" tem produtos de OUTRAS linhas (ex: "Dizeres")
// que nunca passaram pela Migração Use Origens (não fazem parte de nenhum PRESET_COLECOES) —
// misturados com Gentílico que ainda não tinha sido reprocessado (job cancelado no meio). Pra
// eliminar qualquer dependência da malha de regras/classificação, essa correção é ancorada 100%
// no NOME real do produto: só mexe em produto cujo nome contém "gentilico" E que tem "Fala Daqui"
// na categoria ATUAL de verdade (buildCollectionsIndex, não o que a simulação achou que seria) —
// nunca toca em produto de outra linha, mesmo que também esteja em Fala Daqui. Reaproveita
// origens_migration_simulation_items.product_name como fonte dos nomes (já veio de 1 varredura
// completa do catálogo na simulação/execução mais recente) pra não repaginar a Ink de novo.
async function localizarCorrecaoGentilicoPorNome(simulationId) {
  const simRows = await pgPool.query('SELECT * FROM origens_migration_simulations WHERE id = $1', [simulationId]);
  if (!simRows.rows.length) { const err = new Error('simulação não encontrada'); err.status = 404; throw err; }
  const sim = simRows.rows[0];

  const { rows: candidatos } = await pgPool.query(
    `SELECT DISTINCT product_id, product_name FROM origens_migration_simulation_items
     WHERE simulation_id = $1 AND (product_name ILIKE '%gentilico%' OR product_name ILIKE '%gentílico%')`,
    [sim.id]
  );

  const { indice, nomesPorId } = await buildCollectionsIndex(sim.loja);
  const falaDaqui = candidatosCategoria(nomesPorId, 'Fala Daqui');
  const seuLugar = candidatosCategoria(nomesPorId, 'Seu Lugar');
  if (falaDaqui.length !== 1) { const err = new Error(`não encontrei exatamente 1 categoria "Fala Daqui" (${falaDaqui.length} encontrada(s))`); err.status = 400; throw err; }
  if (seuLugar.length !== 1) { const err = new Error(`não encontrei exatamente 1 categoria "Seu Lugar" (${seuLugar.length} encontrada(s))`); err.status = 400; throw err; }
  const idFalaDaqui = falaDaqui[0].id;
  const idSeuLugar = seuLugar[0].id;

  const afetados = candidatos
    .map((p) => ({ productId: Number(p.product_id), name: p.product_name, categoriasAtuais: Array.from(indice.get(Number(p.product_id)) || []) }))
    .filter((p) => p.categoriasAtuais.includes(idFalaDaqui));

  return { sim, idFalaDaqui, idSeuLugar, totalGentilico: candidatos.length, afetados, nomesPorId };
}

app.get('/api/admin/internal/origens-migration/simulations/:id/gentilico-fala-daqui/preview', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  try {
    const { idFalaDaqui, idSeuLugar, totalGentilico, afetados, nomesPorId } = await localizarCorrecaoGentilicoPorNome(Number(req.params.id));
    res.json({
      totalGentilico,
      comFalaDaqui: afetados.length,
      categoriaFalaDaquiId: idFalaDaqui,
      categoriaSeuLugarId: idSeuLugar,
      amostra: afetados.slice(0, 20).map((p) => ({
        id: p.productId, name: p.name,
        categoriasAtuais: p.categoriasAtuais.map((id) => nomesPorId.get(id) || `#${id}`),
      })),
    });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha no preview gentilico-fala-daqui (sim ${req.params.id}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível gerar o preview' });
  }
});

app.post('/api/admin/internal/origens-migration/simulations/:id/gentilico-fala-daqui/aplicar', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  try {
    const { sim, idFalaDaqui, idSeuLugar, afetados } = await localizarCorrecaoGentilicoPorNome(Number(req.params.id));
    if (!afetados.length) return res.json({ jobId: null, total: 0 });

    const jobRows = await pgPool.query(
      `INSERT INTO bulk_category_jobs (loja, mode, category_ids, filtro_produtos, total, status)
       VALUES ($1, 'replace', '[]'::jsonb, $2::jsonb, $3, 'queued') RETURNING id`,
      [sim.loja, JSON.stringify({ gentilicoFalaDaquiFixSimulationId: sim.id }), afetados.length]
    );
    const jobId = jobRows.rows[0].id;

    for (let i = 0; i < afetados.length; i += 500) {
      const lote = afetados.slice(i, i + 500);
      const values = [];
      const params = [];
      lote.forEach((p, idx) => {
        const alvo = Array.from(new Set(p.categoriasAtuais.filter((id) => id !== idFalaDaqui).concat(idSeuLugar))).sort((a, b) => a - b);
        values.push(`($${idx * 3 + 1},$${idx * 3 + 2},$${idx * 3 + 3}::jsonb)`);
        params.push(jobId, p.productId, JSON.stringify(alvo));
      });
      await pgPool.query(
        `INSERT INTO bulk_category_job_items (job_id, product_id, categoria_ids_alvo) VALUES ${values.join(',')}`,
        params
      );
    }

    res.status(201).json({ jobId, total: afetados.length });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao aplicar correção gentilico-fala-daqui (sim ${req.params.id}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível aplicar a correção' });
  }
});

// Versão genérica da correção por nome (2026-09-11) — 2ª vez que precisamos do mesmo formato
// (produto com X no nome → ajustar categoria), dessa vez pra um caso diferente: usuário apagou
// sem querer a categoria certa de um par duplicado, órfãos ficaram sem categoria. categoriaRemover
// é opcional (pode não haver nada pra tirar, só adicionar a que falta) — categoriaAdicionar é
// sempre obrigatório. Mesma fonte de nomes (scan já feito, sem repaginar a Ink) e mesma forma de
// criar o job (categoria_ids_alvo por item, fila de 15s processa sozinha).
async function localizarCorrecaoPorNome(simulationId, nomeContem, nomeCategoriaAdicionar, nomeCategoriaRemover) {
  const simRows = await pgPool.query('SELECT * FROM origens_migration_simulations WHERE id = $1', [simulationId]);
  if (!simRows.rows.length) { const err = new Error('simulação não encontrada'); err.status = 404; throw err; }
  const sim = simRows.rows[0];

  const { rows: candidatos } = await pgPool.query(
    `SELECT DISTINCT product_id, product_name FROM origens_migration_simulation_items
     WHERE simulation_id = $1 AND product_name ILIKE $2`,
    [sim.id, `%${nomeContem}%`]
  );

  const { indice, nomesPorId } = await buildCollectionsIndex(sim.loja);
  const adicionarCand = candidatosCategoria(nomesPorId, nomeCategoriaAdicionar);
  if (adicionarCand.length !== 1) { const err = new Error(`não encontrei exatamente 1 categoria "${nomeCategoriaAdicionar}" (${adicionarCand.length} encontrada(s))`); err.status = 400; throw err; }
  const idAdicionar = adicionarCand[0].id;

  let idRemover = null;
  if (nomeCategoriaRemover) {
    const removerCand = candidatosCategoria(nomesPorId, nomeCategoriaRemover);
    if (removerCand.length !== 1) { const err = new Error(`não encontrei exatamente 1 categoria "${nomeCategoriaRemover}" (${removerCand.length} encontrada(s))`); err.status = 400; throw err; }
    idRemover = removerCand[0].id;
  }

  const todos = candidatos.map((p) => ({ productId: Number(p.product_id), name: p.product_name, categoriasAtuais: Array.from(indice.get(Number(p.product_id)) || []) }));
  const afetados = todos.filter((p) => (idRemover && p.categoriasAtuais.includes(idRemover)) || !p.categoriasAtuais.includes(idAdicionar));

  return { sim, idAdicionar, idRemover, totalNome: todos.length, afetados, nomesPorId };
}

app.get('/api/admin/internal/origens-migration/simulations/:id/corrigir-por-nome/preview', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const { nomeContem, categoriaAdicionar, categoriaRemover } = req.query;
  if (!nomeContem || !categoriaAdicionar) return res.status(400).json({ error: 'nomeContem e categoriaAdicionar são obrigatórios' });
  try {
    const { idAdicionar, idRemover, totalNome, afetados, nomesPorId } = await localizarCorrecaoPorNome(Number(req.params.id), nomeContem, categoriaAdicionar, categoriaRemover);
    res.json({
      totalNome,
      afetados: afetados.length,
      categoriaAdicionarId: idAdicionar,
      categoriaRemoverId: idRemover,
      amostra: afetados.slice(0, 20).map((p) => ({
        id: p.productId, name: p.name,
        categoriasAtuais: p.categoriasAtuais.map((id) => nomesPorId.get(id) || `#${id}`),
      })),
    });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha no preview corrigir-por-nome (sim ${req.params.id}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível gerar o preview' });
  }
});

app.post('/api/admin/internal/origens-migration/simulations/:id/corrigir-por-nome/aplicar', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const { nomeContem, categoriaAdicionar, categoriaRemover } = req.body || {};
  if (!nomeContem || !categoriaAdicionar) return res.status(400).json({ error: 'nomeContem e categoriaAdicionar são obrigatórios' });
  try {
    const { sim, idAdicionar, idRemover, afetados } = await localizarCorrecaoPorNome(Number(req.params.id), nomeContem, categoriaAdicionar, categoriaRemover);
    if (!afetados.length) return res.json({ jobId: null, total: 0 });

    const jobRows = await pgPool.query(
      `INSERT INTO bulk_category_jobs (loja, mode, category_ids, filtro_produtos, total, status)
       VALUES ($1, 'replace', '[]'::jsonb, $2::jsonb, $3, 'queued') RETURNING id`,
      [sim.loja, JSON.stringify({ corrigirPorNomeSimulationId: sim.id, nomeContem, categoriaAdicionar, categoriaRemover: categoriaRemover || null }), afetados.length]
    );
    const jobId = jobRows.rows[0].id;

    for (let i = 0; i < afetados.length; i += 500) {
      const lote = afetados.slice(i, i + 500);
      const values = [];
      const params = [];
      lote.forEach((p, idx) => {
        const base = idRemover ? p.categoriasAtuais.filter((id) => id !== idRemover) : p.categoriasAtuais;
        const alvo = Array.from(new Set(base.concat(idAdicionar))).sort((a, b) => a - b);
        values.push(`($${idx * 3 + 1},$${idx * 3 + 2},$${idx * 3 + 3}::jsonb)`);
        params.push(jobId, p.productId, JSON.stringify(alvo));
      });
      await pgPool.query(
        `INSERT INTO bulk_category_job_items (job_id, product_id, categoria_ids_alvo) VALUES ${values.join(',')}`,
        params
      );
    }

    res.status(201).json({ jobId, total: afetados.length });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao aplicar corrigir-por-nome (sim ${req.params.id}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível aplicar a correção' });
  }
});

app.get('/api/admin/internal/origens-migration/simulations/:id/items', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'simulações exigem Postgres configurado' });
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Number.parseInt(req.query.pageSize, 10) || 50);
  const { status } = req.query;
  const params = [req.params.id];
  let where = 'simulation_id = $1';
  if (status && status !== 'todos') { params.push(status); where += ` AND status = $${params.length}`; }

  const total = await pgPool.query(`SELECT COUNT(*) AS n FROM origens_migration_simulation_items WHERE ${where}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pgPool.query(
    `SELECT * FROM origens_migration_simulation_items WHERE ${where} ORDER BY id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ itens: rows, total: Number(total.rows[0].n), page, pageSize });
});

app.patch('/api/admin/internal/origens-migration/simulations/:id/items/:itemId', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'simulações exigem Postgres configurado' });
  const { overrideCategorias, overrideIgnorar } = req.body || {};
  if (overrideCategorias != null && (!Array.isArray(overrideCategorias) || !overrideCategorias.every((n) => Number.isInteger(n)))) {
    return res.status(400).json({ error: 'overrideCategorias deve ser um array de inteiros (ou null pra limpar)' });
  }
  const { rows } = await pgPool.query(
    `UPDATE origens_migration_simulation_items SET
       override_categorias = $1::jsonb, override_ignorar = COALESCE($2, override_ignorar), atualizado_em = now()
     WHERE id = $3 AND simulation_id = $4 RETURNING *`,
    [overrideCategorias != null ? JSON.stringify(overrideCategorias) : null, typeof overrideIgnorar === 'boolean' ? overrideIgnorar : null, req.params.itemId, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'item não encontrado nessa simulação' });
  res.json({ item: rows[0] });
});

// Quantos produtos PRONTOS cada regra pegou nesta simulação, e quantos vieram do fallback
// cidade→UF (nenhuma regra bateu). É o que permite escolher o escopo antes de executar — e mostra
// na hora quando uma regra não pegou nada, caso clássico de condições AND que nunca podem ser
// todas verdadeiras ao mesmo tempo (ex: "termina com X" E "termina com Y").
app.get('/api/admin/internal/origens-migration/simulations/:id/rule-counts', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'simulações exigem Postgres configurado' });
  const simRows = await pgPool.query('SELECT id, loja FROM origens_migration_simulations WHERE id = $1', [req.params.id]);
  if (!simRows.rows.length) return res.status(404).json({ error: 'simulação não encontrada' });
  const sim = simRows.rows[0];
  try {
    // "Executável" aqui = mesma regra do /execute: pronto (ou com override) e não ignorado.
    const executavel = `(i.override_ignorar = false AND (i.override_categorias IS NOT NULL OR i.status = 'pronto'))`;
    const [{ rows: porRegra }, { rows: totais }] = await Promise.all([
      pgPool.query(
        `SELECT r.id, r.nome, r.habilitada, COUNT(i.id) AS total
         FROM origens_migration_rules r
         LEFT JOIN origens_migration_simulation_items i
           ON i.simulation_id = $1 AND i.matched_rule_ids @> to_jsonb(r.id) AND ${executavel}
         WHERE r.loja = $2
         GROUP BY r.id, r.nome, r.habilitada
         ORDER BY r.id ASC`,
        [sim.id, sim.loja]
      ),
      pgPool.query(
        `SELECT
           COUNT(*) FILTER (WHERE jsonb_array_length(i.matched_rule_ids) > 0 AND ${executavel}) AS por_regra,
           COUNT(*) FILTER (WHERE jsonb_array_length(i.matched_rule_ids) = 0 AND ${executavel}) AS por_fallback
         FROM origens_migration_simulation_items i WHERE i.simulation_id = $1`,
        [sim.id]
      ),
    ]);
    res.json({
      regras: porRegra.map((r) => ({ id: Number(r.id), nome: r.nome, habilitada: r.habilitada, total: Number(r.total) })),
      totalPorRegra: Number(totais[0].por_regra),
      totalPorFallback: Number(totais[0].por_fallback),
    });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao contar produtos por regra da simulação ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: 'não foi possível contar os produtos por regra' });
  }
});

// Execução (spec, Parte 6): só a partir de uma simulação existente, snapshot fixo (não recalcula
// regra nenhuma aqui), nunca produto em conflito/sem_regra/ignorado — a menos que tenha override
// manual resolvendo. Cada simulação só executa 1 vez (doc: "nova simulação deve gerar nova
// execução"). A execução real acontece no MESMO job assíncrono da Fase 2 (bulk_category_jobs +
// processarBulkCategoryJobs) — aqui só cria o job em modo 'replace' com categoria_ids_alvo por
// item, sem duplicar a lógica de retry/concorrência.
app.post('/api/admin/internal/origens-migration/simulations/:id/execute', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'execução exige Postgres configurado' });
  const simRows = await pgPool.query('SELECT * FROM origens_migration_simulations WHERE id = $1', [req.params.id]);
  if (!simRows.rows.length) return res.status(404).json({ error: 'simulação não encontrada' });
  const sim = simRows.rows[0];
  if (sim.status !== 'simulada') return res.status(409).json({ error: 'essa simulação já foi executada (ou está em execução) — rode uma nova simulação pra executar de novo' });

  // Escopo da execução (pedido do usuário, 2026-09-11). Por padrão ('todos') executa tudo que está
  // pronto — inclusive o que foi classificado pelo FALLBACK cidade→UF, que é o caso da migração
  // completa do catálogo e explica por que uma execução normal mexe em dezenas de milhares de
  // produtos. 'regras' restringe aos produtos que bateram em REGRA explícita (matched_rule_ids não
  // vazio) e, com `regraIds`, só nas regras escolhidas: é o recorte pra rodar um punhado de regras
  // novas sem reclassificar o catálogo inteiro.
  const escopo = req.body && req.body.escopo === 'regras' ? 'regras' : 'todos';
  const regraIdsBrutos = req.body && req.body.regraIds;
  const regraIds = Array.isArray(regraIdsBrutos) ? regraIdsBrutos.map(Number).filter(Number.isInteger) : null;
  if (escopo === 'regras' && Array.isArray(regraIdsBrutos) && !regraIds.length) {
    return res.status(400).json({ error: 'regraIds vazio — escolha ao menos uma regra ou use escopo "todos"' });
  }

  const { rows: itens } = await pgPool.query(
    `SELECT product_id, categorias_finais, override_categorias, override_ignorar, status, matched_rule_ids FROM origens_migration_simulation_items WHERE simulation_id = $1`,
    [req.params.id]
  );
  const dentroDoEscopo = (it) => {
    if (escopo === 'todos') return true;
    const ids = it.matched_rule_ids || [];
    if (!ids.length) return false; // classificado pelo fallback cidade→UF, não por regra
    return !regraIds ? true : ids.some((id) => regraIds.includes(Number(id)));
  };
  const executaveis = itens
    .filter((it) => !it.override_ignorar && (it.override_categorias != null || it.status === 'pronto') && dentroDoEscopo(it))
    .map((it) => ({ productId: it.product_id, categoriaIds: it.override_categorias != null ? it.override_categorias : it.categorias_finais }));

  if (!executaveis.length) {
    return res.status(400).json({
      error: escopo === 'regras'
        ? 'nenhum produto pronto bateu nas regras escolhidas'
        : 'nenhum produto pronto pra executar — todos estão em conflito, sem classificação ou marcados pra ignorar',
    });
  }

  try {
    const jobRows = await pgPool.query(
      `INSERT INTO bulk_category_jobs (loja, mode, category_ids, filtro_produtos, total, status)
       VALUES ($1, 'replace', '[]'::jsonb, $2::jsonb, $3, 'queued') RETURNING id`,
      [sim.loja, JSON.stringify({ origensMigrationSimulationId: sim.id, escopo, regraIds }), executaveis.length]
    );
    const jobId = jobRows.rows[0].id;

    for (let i = 0; i < executaveis.length; i += 500) {
      const lote = executaveis.slice(i, i + 500);
      const values = [];
      const params = [];
      lote.forEach((it, idx) => {
        values.push(`($${idx * 3 + 1},$${idx * 3 + 2},$${idx * 3 + 3}::jsonb)`);
        params.push(jobId, it.productId, JSON.stringify(it.categoriaIds));
      });
      await pgPool.query(
        `INSERT INTO bulk_category_job_items (job_id, product_id, categoria_ids_alvo) VALUES ${values.join(',')}`,
        params
      );
    }

    await pgPool.query(`UPDATE origens_migration_simulations SET status = 'executando', job_id = $1 WHERE id = $2`, [jobId, sim.id]);
    res.status(201).json({ jobId, total: executaveis.length });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao criar execução da simulação ${req.params.id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível criar a execução' });
  }
});

// CSV real, sem lib nova — escapa vírgula/aspas/quebra de linha manualmente (RFC 4180 básico).
function csvEscape(valor) {
  const s = valor == null ? '' : String(valor);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/admin/internal/origens-migration/simulations/:id/export.csv', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_simulations'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exportação exige Postgres configurado' });
  const { rows } = await pgPool.query('SELECT * FROM origens_migration_simulation_items WHERE simulation_id = $1 ORDER BY id ASC', [req.params.id]);
  const header = ['product_id', 'product_name', 'status', 'matched_rules', 'categories_after', 'error', 'collection_detected', 'uf_detected', 'region_detected'];
  const linhas = [header.join(',')];
  for (const r of rows) {
    const categoriasFinais = r.override_categorias != null ? r.override_categorias : r.categorias_finais;
    linhas.push([
      r.product_id, r.product_name, r.status,
      (r.matched_rule_ids || []).join('|'), (categoriasFinais || []).join('|'),
      r.conflito_motivo || '', r.collection_detectada || '', r.uf_detectada || '', r.regiao_detectada || '',
    ].map(csvEscape).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="migracao-${req.params.id}.csv"`);
  res.send(linhas.join('\n'));
});

// ── Preload de regras padrão (doc: claude-preload-regras-use-origens-cidade-uf.md) ──────────
// Preview: nunca cria nada, só resolve as 24 combinações coleção×UF contra as categorias reais
// da loja e contra as regras já existentes (idempotência). O frontend decide o que mandar pro
// preset-create (pode incluir correção manual de categoria ambígua/ausente).
app.get('/api/admin/internal/origens-migration/rules/preset-preview', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'preset exige Postgres configurado' });
  const loja = lojaLegadaDoContexto();

  try {
    const [{ nomesPorId }, regrasExistentes] = await Promise.all([
      buildCollectionsIndex(loja),
      pgPool.query('SELECT id, dimensao, condicoes, categoria_ids_saida FROM origens_migration_rules WHERE loja = $1', [loja]),
    ]);
    // Por identidade (dimensão+condições, ignorando categorias) — pra achar "mesma regra,
    // categorias antigas" e não confundir com duplicata de verdade.
    const regraPorIdentidade = new Map();
    for (const r of regrasExistentes.rows) {
      regraPorIdentidade.set(chaveDimensaoCondicoes(r.dimensao, r.condicoes), r);
    }

    const itens = construirCombinacoesPreset().map((combo) => {
      const { resolvidos, todasResolvidas } = resolverCategoriasAlvo(nomesPorId, combo.colecao, combo.uf);
      const categoriaIdsSaida = todasResolvidas ? resolvidos.map((r) => r.id) : null;
      // Resolução por posição, sempre exposta (mesmo quando a linha inteira não está "pronta") —
      // categoriaIdsSaida é tudo-ou-nada (gate de criação), mas a UI precisa saber quais das 5
      // categorias JÁ resolveram individualmente, senão mostra a linha toda como ausente por
      // causa de só 1 categoria faltando (bug real reportado pelo usuário, 2026-09-09).
      const categoriaIdsPorPosicao = resolvidos.map((r) => r.id);
      const candidatosAmbiguos = resolvidos.filter((r) => r.id == null).map((r) => ({ nome: r.nome, candidatos: r.candidatos }));

      if (!todasResolvidas) {
        return {
          nome: combo.nome, colecao: combo.colecao, uf: combo.uf, dimensao: combo.dimensao, prioridade: combo.prioridade,
          condicoes: combo.condicoes, categoriasNomes: resolvidos.map((r) => r.nome), categoriaIdsSaida, categoriaIdsPorPosicao, candidatosAmbiguos,
          regraIdParaAtualizar: null, status: 'categoria_ausente',
        };
      }

      const regraExistente = regraPorIdentidade.get(chaveDimensaoCondicoes(combo.dimensao, combo.condicoes));
      let status = 'pronta';
      let regraIdParaAtualizar = null;
      let categoriaIdsSaidaFinal = categoriaIdsSaida;
      if (regraExistente) {
        const existentesSet = new Set(regraExistente.categoria_ids_saida || []);
        const faltando = categoriaIdsSaida.filter((id) => !existentesSet.has(id));
        if (!faltando.length) {
          status = 'ja_existe';
        } else {
          // A regra já existe com a mesma identidade, só falta(m) categoria(s) — ex: rodar o
          // preset de novo depois da 5ª categoria (Seu Lugar/Fala Daqui) ter sido adicionada.
          // Nunca cria uma 2ª regra com o mesmo nome/condições — atualiza a existente, somando
          // (union) o que já estava lá com o alvo novo, pra não perder categoria adicionada manualmente.
          status = 'atualizar_categoria';
          regraIdParaAtualizar = regraExistente.id;
          categoriaIdsSaidaFinal = Array.from(new Set([...existentesSet, ...categoriaIdsSaida])).sort((a, b) => a - b);
        }
      }

      return {
        nome: combo.nome,
        colecao: combo.colecao,
        uf: combo.uf,
        dimensao: combo.dimensao,
        prioridade: combo.prioridade,
        condicoes: combo.condicoes,
        categoriasNomes: resolvidos.map((r) => r.nome),
        categoriaIdsSaida: categoriaIdsSaidaFinal,
        categoriaIdsPorPosicao,
        candidatosAmbiguos,
        regraIdParaAtualizar,
        status,
      };
    });

    res.json({
      presetSize: itens.length,
      itens,
      resumo: {
        pronta: itens.filter((i) => i.status === 'pronta').length,
        jaExiste: itens.filter((i) => i.status === 'ja_existe').length,
        atualizarCategoria: itens.filter((i) => i.status === 'atualizar_categoria').length,
        categoriaAusente: itens.filter((i) => i.status === 'categoria_ausente').length,
      },
    });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha no preview do preset (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível gerar o preview do preset' });
  }
});

app.post('/api/admin/internal/origens-migration/rules/preset-create', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'preset exige Postgres configurado' });
  const { itens } = req.body || {};
  const loja = lojaLegadaDoContexto();
  if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ error: 'itens é obrigatório (array não vazio)' });

  let criadas = 0;
  let jaExistiam = 0;
  let atualizadas = 0;
  const falharam = [];
  try {
    const { nomesPorId } = await buildCollectionsIndex(loja);
    for (const item of itens) {
      try {
        const erroCondicoes = validarCondicoes(item.condicoes);
        if (erroCondicoes) throw Object.assign(new Error(erroCondicoes), { status: 400 });
        const categoriaIdsSaida = Array.isArray(item.categoriaIdsSaida) ? item.categoriaIdsSaida : null;
        if (!categoriaIdsSaida || !categoriaIdsSaida.length || !categoriaIdsSaida.every((n) => Number.isInteger(n))) {
          throw Object.assign(new Error('categoriaIdsSaida é obrigatório (array de inteiros)'), { status: 400 });
        }

        // Revalida no servidor, sem confiar no que o frontend mandou (pode ter passado tempo
        // entre o preview e a confirmação, outra regra pode ter sido criada/editada nesse meio-tempo).
        const existentes = await pgPool.query('SELECT id, dimensao, condicoes, categoria_ids_saida FROM origens_migration_rules WHERE loja = $1', [loja]);
        const chaveNova = chaveEquivalenciaRegra(item.dimensao, item.condicoes, categoriaIdsSaida);
        const jaExiste = existentes.rows.some((r) => chaveEquivalenciaRegra(r.dimensao, r.condicoes, r.categoria_ids_saida) === chaveNova);
        if (jaExiste) { jaExistiam++; continue; }

        const identidadeNova = chaveDimensaoCondicoes(item.dimensao, item.condicoes);
        const regraParaAtualizar = existentes.rows.find((r) => chaveDimensaoCondicoes(r.dimensao, r.condicoes) === identidadeNova);
        if (regraParaAtualizar) {
          // Mesma regra (dimensão+condições), só faltava categoria — soma em vez de duplicar.
          const uniao = Array.from(new Set([...(regraParaAtualizar.categoria_ids_saida || []), ...categoriaIdsSaida])).sort((a, b) => a - b);
          for (const id of uniao) if (!nomesPorId.has(id)) throw Object.assign(new Error(`categoria ${id} não existe nesta loja`), { status: 400 });
          await atualizarCategoriasRegraMigracao(regraParaAtualizar.id, uniao);
          atualizadas++;
          continue;
        }

        await inserirRegraMigracao(loja, {
          nome: item.nome, habilitada: true, prioridade: item.prioridade, dimensao: item.dimensao,
          condicoes: item.condicoes, categoriaIdsSaida,
        }, nomesPorId);
        criadas++;
      } catch (err) {
        falharam.push({ nome: item.nome, erro: err.message });
      }
    }
    res.json({ criadas, jaExistiam, atualizadas, falharam });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao criar preset (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível criar as regras do preset' });
  }
});

// Preview do preset ESPECIAL (Grupo B) — mesmo formato de item que o Grupo A (nome/dimensao/
// condicoes/categoriaIdsSaida/categoriasNomes/categoriaIdsPorPosicao/candidatosAmbiguos/status),
// só com 1 categoria de saída em vez de 5 — por isso reaproveita o MESMO endpoint
// /rules/preset-create pra confirmar (não existe /preset-especiais-create: o create já é
// genérico, não depende de nada específico do Grupo A).
//
// "Criar apenas regras pra categorias que existirem" (doc) vale pros dois lados: se a categoria
// de ORIGEM não existir nesta loja, a regra nem se aplica aqui — status 'sem_categoria_origem',
// não é erro, só não é oferecida (cada loja Sul/Centro/Norte pode ter um recorte diferente de
// coleções antigas). Só quando a origem existe é que resolve o destino (mesmo caminho do
// 'categoria_ausente' do Grupo A).
app.get('/api/admin/internal/origens-migration/rules/preset-especiais-preview', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'preset exige Postgres configurado' });
  const loja = lojaLegadaDoContexto();

  try {
    const [{ nomesPorId }, regrasExistentes] = await Promise.all([
      buildCollectionsIndex(loja),
      pgPool.query('SELECT id, dimensao, condicoes, categoria_ids_saida FROM origens_migration_rules WHERE loja = $1', [loja]),
    ]);
    const regraPorIdentidade = new Map();
    for (const r of regrasExistentes.rows) {
      regraPorIdentidade.set(chaveDimensaoCondicoes(r.dimensao, r.condicoes), r);
    }

    const itens = PRESET_ESPECIAIS.map(({ origem, destino }) => {
      const nome = `${origem} → ${destino}`;
      const condicoes = [{ field: 'current_category', operator: 'contains', value: origem }];
      const dimensao = 'colecao_especial';

      const origemExiste = candidatosCategoria(nomesPorId, origem).length > 0;
      if (!origemExiste) {
        return {
          nome, origem, destino, dimensao, prioridade: 10, condicoes,
          categoriasNomes: [destino], categoriaIdsSaida: null, categoriaIdsPorPosicao: [null], candidatosAmbiguos: [],
          regraIdParaAtualizar: null, status: 'sem_categoria_origem',
        };
      }

      const candidatosDestino = candidatosCategoria(nomesPorId, destino);
      const idDestino = candidatosDestino.length === 1 ? candidatosDestino[0].id : null;
      if (idDestino == null) {
        return {
          nome, origem, destino, dimensao, prioridade: 10, condicoes,
          categoriasNomes: [destino], categoriaIdsSaida: null, categoriaIdsPorPosicao: [null],
          candidatosAmbiguos: [{ nome: destino, candidatos: candidatosDestino }],
          regraIdParaAtualizar: null, status: 'categoria_ausente',
        };
      }

      const categoriaIdsSaida = [idDestino];
      const regraExistente = regraPorIdentidade.get(chaveDimensaoCondicoes(dimensao, condicoes));
      let status = 'pronta';
      let regraIdParaAtualizar = null;
      let categoriaIdsSaidaFinal = categoriaIdsSaida;
      if (regraExistente) {
        const existentesSet = new Set(regraExistente.categoria_ids_saida || []);
        const faltando = categoriaIdsSaida.filter((id) => !existentesSet.has(id));
        if (!faltando.length) {
          status = 'ja_existe';
        } else {
          status = 'atualizar_categoria';
          regraIdParaAtualizar = regraExistente.id;
          categoriaIdsSaidaFinal = Array.from(new Set([...existentesSet, ...categoriaIdsSaida])).sort((a, b) => a - b);
        }
      }

      return {
        nome, origem, destino, dimensao, prioridade: 10, condicoes,
        categoriasNomes: [destino], categoriaIdsSaida: categoriaIdsSaidaFinal, categoriaIdsPorPosicao: [idDestino],
        candidatosAmbiguos: [], regraIdParaAtualizar, status,
      };
    });

    res.json({
      presetSize: itens.length,
      itens,
      resumo: {
        pronta: itens.filter((i) => i.status === 'pronta').length,
        jaExiste: itens.filter((i) => i.status === 'ja_existe').length,
        atualizarCategoria: itens.filter((i) => i.status === 'atualizar_categoria').length,
        categoriaAusente: itens.filter((i) => i.status === 'categoria_ausente').length,
        semCategoriaOrigem: itens.filter((i) => i.status === 'sem_categoria_origem').length,
      },
    });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha no preview do preset especial (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível gerar o preview do preset especial' });
  }
});

// ── Mapa Cidade → UF (fallback pra produto sem UF explícita no nome) ────────────────────────
app.get('/api/admin/internal/origens-migration/city-uf-map', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mapa cidade→UF exige Postgres configurado' });
  const loja = lojaLegadaDoContexto();
  const { rows } = await pgPool.query(
    'SELECT * FROM origens_migration_city_uf_map WHERE loja = $1 ORDER BY cidade_display ASC', [loja]
  );
  res.json({ cidades: rows });
});

app.post('/api/admin/internal/origens-migration/city-uf-map', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mapa cidade→UF exige Postgres configurado' });
  const { cidade, uf } = req.body || {};
  const loja = lojaLegadaDoContexto();
  if (typeof cidade !== 'string' || !cidade.trim()) return res.status(400).json({ error: 'cidade é obrigatória' });
  if (!PRESET_UFS.includes(uf)) return res.status(400).json({ error: `uf deve ser uma de: ${PRESET_UFS.join(', ')}` });
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO origens_migration_city_uf_map (loja, cidade_normalizada, cidade_display, uf)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [loja, normalizarTextoMatch(cidade), cidade.trim(), uf]
    );
    res.status(201).json({ cidade: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'essa cidade já está mapeada nessa loja' });
    console.error(`[ORIGENS_MIGRATION] falha ao adicionar cidade→UF (${loja}): ${err.message}`);
    res.status(500).json({ error: 'não foi possível adicionar a cidade' });
  }
});

app.patch('/api/admin/internal/origens-migration/city-uf-map/:id', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_city_uf_map'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mapa cidade→UF exige Postgres configurado' });
  const { uf } = req.body || {};
  if (!PRESET_UFS.includes(uf)) return res.status(400).json({ error: `uf deve ser uma de: ${PRESET_UFS.join(', ')}` });
  const { rows } = await pgPool.query(
    'UPDATE origens_migration_city_uf_map SET uf = $1, atualizado_em = now() WHERE id = $2 RETURNING *',
    [uf, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'cidade não encontrada' });
  res.json({ cidade: rows[0] });
});

app.delete('/api/admin/internal/origens-migration/city-uf-map/:id', requireAdmin, requireInternalTools, exigirRecurso('origens_migration_city_uf_map'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mapa cidade→UF exige Postgres configurado' });
  await pgPool.query('DELETE FROM origens_migration_city_uf_map WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Preview de importação em lote — mesmo espírito UX da Fase 1 (categorias em lote): cola texto,
// analisa, só aplica depois de confirmar. Aceita "Cidade;UF" ou "Cidade,UF" por linha.
app.post('/api/admin/internal/origens-migration/city-uf-map/bulk-preview', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mapa cidade→UF exige Postgres configurado' });
  const { texto } = req.body || {};
  const loja = lojaLegadaDoContexto();
  if (typeof texto !== 'string') return res.status(400).json({ error: 'texto é obrigatório' });

  const { rows: existentesRows } = await pgPool.query('SELECT cidade_normalizada FROM origens_migration_city_uf_map WHERE loja = $1', [loja]);
  const existentes = new Set(existentesRows.map((r) => r.cidade_normalizada));
  const vistasNaLista = new Set();

  const itens = texto.split('\n').map((linha) => linha.trim()).filter(Boolean).map((linha) => {
    const partes = linha.split(/[;,]/).map((p) => p.trim());
    const cidade = partes[0] || '';
    const uf = (partes[1] || '').toUpperCase();
    const cidadeNorm = normalizarTextoMatch(cidade);
    let status;
    if (!cidade || !PRESET_UFS.includes(uf)) status = 'uf_invalida';
    else if (vistasNaLista.has(cidadeNorm)) status = 'duplicada_na_lista';
    else if (existentes.has(cidadeNorm)) status = 'ja_existe';
    else status = 'pronta';
    vistasNaLista.add(cidadeNorm);
    return { linha, cidade, uf: PRESET_UFS.includes(uf) ? uf : null, status };
  });

  res.json({
    itens,
    resumo: {
      total: itens.length,
      pronta: itens.filter((i) => i.status === 'pronta').length,
      jaExiste: itens.filter((i) => i.status === 'ja_existe').length,
      duplicada: itens.filter((i) => i.status === 'duplicada_na_lista').length,
      invalida: itens.filter((i) => i.status === 'uf_invalida').length,
    },
  });
});

app.post('/api/admin/internal/origens-migration/city-uf-map/bulk-create', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mapa cidade→UF exige Postgres configurado' });
  const { itens } = req.body || {};
  const loja = lojaLegadaDoContexto();
  if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ error: 'itens é obrigatório (array não vazio)' });

  let criadas = 0;
  const falharam = [];
  for (const item of itens) {
    if (!item.cidade || !PRESET_UFS.includes(item.uf)) { falharam.push({ cidade: item.cidade, erro: 'uf inválida' }); continue; }
    try {
      await pgPool.query(
        `INSERT INTO origens_migration_city_uf_map (loja, cidade_normalizada, cidade_display, uf) VALUES ($1,$2,$3,$4)
         ON CONFLICT (organization_id, loja, cidade_normalizada) DO NOTHING`,
        [loja, normalizarTextoMatch(item.cidade), item.cidade.trim(), item.uf]
      );
      criadas++;
    } catch (err) {
      falharam.push({ cidade: item.cidade, erro: err.message });
    }
  }
  res.json({ criadas, falharam });
});

// Importa o dicionário fixo de municípios do Sul (MUNICIPIOS_SUL) pro mapa cidade→UF da loja —
// pedido do usuário, 2026-09-10, pra não precisar mapear cidade por cidade manualmente (viu vários
// conflitos "cidade sem UF mapeada" de cidades reais de SC: Zortéa, Xaxim, Balneário Camboriú,
// São Francisco do Sul). Mesmo padrão de insert do bulk-create acima (ON CONFLICT DO NOTHING,
// idempotente) — só que a lista vem fixa do dicionário, não do body da request.
app.post('/api/admin/internal/origens-migration/city-uf-map/importar-dicionario', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mapa cidade→UF exige Postgres configurado' });
  const loja = lojaLegadaDoContexto();

  let importados = 0;
  let jaExistiam = 0;
  for (const item of MUNICIPIOS_SUL) {
    const { rowCount } = await pgPool.query(
      `INSERT INTO origens_migration_city_uf_map (loja, cidade_normalizada, cidade_display, uf) VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, loja, cidade_normalizada) DO NOTHING`,
      [loja, normalizarTextoMatch(item.cidade), item.cidade, item.uf]
    );
    if (rowCount > 0) importados++; else jaExistiam++;
  }
  res.json({ importados, jaExistiam, total: MUNICIPIOS_SUL.length });
});

// Varre o catálogo, extrai cidade de cada nome de produto (mesmas 2 heurísticas do fallback de
// simulação) e devolve as cidades ainda não mapeadas, ordenadas por quantidade de produtos —
// alimenta a tela de "confirmar UF pra cada cidade nova" sem o usuário ter que ler o catálogo
// inteiro procurando manualmente.
app.post('/api/admin/internal/origens-migration/city-uf-map/discover', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mapa cidade→UF exige Postgres configurado' });
  const loja = lojaLegadaDoContexto();

  try {
    const [produtos, cityUfMap] = await Promise.all([
      fetchTodosProdutosLoja(loja, new URLSearchParams()),
      carregarCityUfMap(loja),
    ]);
    const porCidade = new Map();
    for (const p of produtos) {
      const cidadeBruta = extrairCidadeDoNomeProduto(p.name);
      if (!cidadeBruta) continue;
      const cidadeNorm = normalizarTextoMatch(cidadeBruta);
      if (cityUfMap.has(cidadeNorm)) continue;
      if (!porCidade.has(cidadeNorm)) porCidade.set(cidadeNorm, { cidadeDisplay: cidadeBruta, cidadeNormalizada: cidadeNorm, quantidadeProdutos: 0 });
      porCidade.get(cidadeNorm).quantidadeProdutos++;
    }
    const cidades = Array.from(porCidade.values()).sort((a, b) => b.quantidadeProdutos - a.quantidadeProdutos);
    res.json({ cidades });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao descobrir cidades (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível descobrir cidades' });
  }
});

// ── Limpar categorias antigas (doc: claude-migracao-final-categorias-snapshot-especiais.md,
// Etapas 7/8/12) ─────────────────────────────────────────────────────────
// Uma categoria antiga só pode ser excluída quando TODOS os produtos que estão nela hoje já
// tiverem destino decidido numa simulação — pra coleções especiais (Grupo B), a categoria atual
// É a única fonte de classificação, e essa informação some pra sempre depois da exclusão. Este
// bloqueio é uma camada NOVA e específica deste fluxo — /bulk-excluir genérico (usado em outros
// lugares do painel, categoria vazia/sem relação com migração) continua sem essa trava.
async function resolverSimulacaoParaLimpeza(loja, simulationIdParam) {
  if (simulationIdParam) {
    const { rows } = await pgPool.query(`SELECT * FROM origens_migration_simulations WHERE id = $1 AND loja = $2`, [simulationIdParam, loja]);
    return rows[0] || null;
  }
  const { rows } = await pgPool.query(
    `SELECT * FROM origens_migration_simulations WHERE loja = $1 AND status IN ('simulada', 'executada') ORDER BY criado_em DESC LIMIT 1`,
    [loja]
  );
  return rows[0] || null;
}

// Avalia, pra cada categoria REAL da loja, se pode ser excluída com segurança — "resolvido" =
// pronto, corrigido manualmente (override_categorias) ou explicitamente marcado pra ignorar
// (override_ignorar) — qualquer um dos 3 conta como "já decidimos o destino desse produto".
async function avaliarCategoriasAntigas(loja, simulationIdParam) {
  const simulacao = await resolverSimulacaoParaLimpeza(loja, simulationIdParam);
  const { categoriaProdutos, nomesPorId } = await buildCollectionsIndex(loja);

  if (!simulacao) {
    // Nunca rodou simulação nenhuma pra essa loja — nenhuma categoria pode ser considerada segura.
    const categorias = Array.from(categoriaProdutos.entries()).map(([id, produtos]) => ({
      id, nome: nomesPorId.get(id) || `#${id}`, totalProdutos: produtos.size,
      produtosSemDestino: produtos.size, exemplos: [], bloqueada: true, motivo: 'nenhuma simulação rodada ainda',
    }));
    return { simulacaoUsada: null, simulacaoNecessaria: true, categorias };
  }

  const { rows: itens } = await pgPool.query(
    `SELECT product_id, status, override_categorias, override_ignorar FROM origens_migration_simulation_items WHERE simulation_id = $1`,
    [simulacao.id]
  );
  const resolvidos = new Set();
  for (const it of itens) {
    if (it.status === 'pronto' || it.override_categorias != null || it.override_ignorar === true) resolvidos.add(String(it.product_id));
  }

  const infoPreliminar = [];
  const idsPrecisamNome = new Set();
  for (const [catId, produtosSet] of categoriaProdutos) {
    const produtosArr = Array.from(produtosSet);
    const semDestino = produtosArr.filter((pid) => !resolvidos.has(String(pid)));
    infoPreliminar.push({ catId, produtosArr, semDestino });
    semDestino.slice(0, 3).forEach((pid) => idsPrecisamNome.add(pid));
  }

  // Nome de produto só é buscado pros que realmente precisam virar "exemplo" na tela — evita
  // paginar o catálogo inteiro quando a maioria das categorias já está liberada.
  const nomesProduto = new Map();
  if (idsPrecisamNome.size) {
    let page = 1;
    let totalPages = 1;
    do {
      const query = new URLSearchParams();
      query.set('page', String(page));
      query.set('per_page', '100');
      const data = await inkApiRequest(loja, `/v1/stores/products?${query.toString()}`);
      for (const p of (data.products || [])) if (idsPrecisamNome.has(p.id)) nomesProduto.set(p.id, p.name);
      totalPages = Math.min(data.total_pages || 1, MIGRACAO_MAX_PAGINAS);
      page += 1;
    } while (page <= totalPages && nomesProduto.size < idsPrecisamNome.size);
  }

  const categorias = infoPreliminar
    .map(({ catId, produtosArr, semDestino }) => ({
      id: catId,
      nome: nomesPorId.get(catId) || `#${catId}`,
      totalProdutos: produtosArr.length,
      produtosSemDestino: semDestino.length,
      exemplos: semDestino.slice(0, 3).map((pid) => nomesProduto.get(pid) || `#${pid}`),
      bloqueada: semDestino.length > 0,
      motivo: semDestino.length > 0 ? `${semDestino.length} produto(s) sem destino mapeado` : null,
    }))
    .sort((a, b) => b.produtosSemDestino - a.produtosSemDestino || b.totalProdutos - a.totalProdutos);

  return { simulacaoUsada: simulacao, simulacaoNecessaria: false, categorias };
}

app.get('/api/admin/internal/origens-migration/categorias-antigas', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const { simulationId } = req.query;
  const loja = lojaLegadaDoContexto();
  try {
    const resultado = await avaliarCategoriasAntigas(loja, simulationId ? Number(simulationId) : null);
    res.json(resultado);
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao avaliar categorias antigas (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível avaliar as categorias antigas' });
  }
});

app.post('/api/admin/internal/origens-migration/categorias-antigas/excluir', requireAdmin, requireInternalTools, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const { simulationId } = req.body || {};
  const loja = lojaLegadaDoContexto();
  const idsPedidos = Array.isArray(req.body && req.body.ids) ? Array.from(new Set(req.body.ids)) : null;
  if (!idsPedidos || !idsPedidos.length || !idsPedidos.every((n) => Number.isInteger(n))) {
    return res.status(400).json({ error: 'ids é obrigatório (array de inteiros não vazio)' });
  }

  try {
    // Revalida do zero no servidor — nunca confia no que o frontend mandou como "liberada".
    const { categorias } = await avaliarCategoriasAntigas(loja, simulationId ? Number(simulationId) : null);
    const porId = new Map(categorias.map((c) => [c.id, c]));

    const liberadas = [];
    const resultados = [];
    for (const id of idsPedidos) {
      const info = porId.get(id);
      if (!info || info.bloqueada) {
        resultados.push({ id, status: 'bloqueada', motivo: info ? info.motivo : 'categoria não encontrada na avaliação' });
      } else {
        liberadas.push(id);
      }
    }

    if (liberadas.length) {
      const exclusoes = await excluirCategoriasEmLote(loja, liberadas);
      resultados.push(...exclusoes);
    }

    res.json({
      resultados,
      resumo: {
        excluidas: resultados.filter((r) => r.status === 'excluida').length,
        bloqueadas: resultados.filter((r) => r.status === 'bloqueada').length,
        falharam: resultados.filter((r) => r.status === 'falhou').length,
      },
    });
  } catch (err) {
    console.error(`[ORIGENS_MIGRATION] falha ao excluir categorias antigas (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível excluir as categorias antigas' });
  }
});


// ── Migração Centro/Norte → Sul: criação de produtos a partir das artes locais ──────────────
// (doc: docs/plano-migracao-criacao-produtos.md). Ferramenta interna, execução LOCAL: o acervo
// são 8 GB de PNG num diretório da máquina do operador, que o servidor do Railway não enxerga —
// por isso `MIGRACAO_ARTES_DIR` e por isso todo este bloco depende de rodar `node server.js` na
// máquina que tem as artes. Nunca aceitar o diretório por parâmetro de request (path traversal):
// só a env var manda.
const MIGRACAO_ARTES_DIR = process.env.MIGRACAO_ARTES_DIR || '';
const fsp = fs.promises;

// Uma arte pode valer pra várias cores da peça. O sufixo do arquivo diz QUAL arte é, mas o que
// ele nomeia MUDA por modelo, medido na luminância real do acervo (doc §2.2): nos 6 primeiros o
// sufixo é a cor da ARTE (`_branco` = arte branca = vai em peça escura); em gentilicos/feito_em é
// a cor da PEÇA (`_branco` = arte pra camiseta branca = arte escura). Aplicar a regra global aqui
// inverteria 1.870 produtos — arte preta sobre camiseta preta.
const MIGRACAO_CORES_ESCURAS = ['Bordeaux', 'Vermelho', 'Marinho', 'Preta', 'Verde'];
const MIGRACAO_CORES_CLARAS = ['Cinza', 'Rosa', 'Branca'];
const MIGRACAO_COR_AMARELO = 'Amarelo';

// token: o pedaço fixo entre a cidade e o sufixo no nome do arquivo, quando existe
// ("jatei_arte_preto.png" → token "arte"). sufixos: qual arquivo serve cada balde de cor.
const MIGRACAO_MODELOS = {
  coordenadas: { label: 'Coordenadas', categoria: 'COORDENADAS', token: 'coord', sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  legado:      { label: 'Legado',      categoria: 'LEGADO',      token: 'arte',  sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  origem:      { label: 'Origem',      categoria: 'ORIGEM',      token: 'arte',  sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  territorio:  { label: 'Território',  categoria: 'TERRITORIO',  token: 'arte',  sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  tipografia:  { label: 'Tipografia',  categoria: 'TIPOGRAFIA',  token: 'arte',  sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  traco:       { label: 'Traço',       categoria: 'TRACO',       token: 'arte',  sufixos: { escuras: 'branco', claras: 'preto', amarelo: 'preto' } },
  // Invertidos: aqui o sufixo nomeia a camiseta, não a arte.
  gentilicos:  { label: 'Gentílico',   categoria: 'GENTILICO',   token: null,    sufixos: { escuras: 'preto',  claras: 'branco', amarelo: 'branco' } },
  feito_em:    { label: 'Feito Em',    categoria: 'FEITO EM',    token: null,    sufixos: { escuras: 'preto',  claras: 'branco', amarelo: 'amarelo' } },
};

// gentilicos é o único modelo cujo nome de produto NÃO sai do arquivo: a arte se chama pela
// cidade ("bodoquena_branco.png") e o produto pelo gentílico ("Bodoquenense | Gentílico MS").
// O vínculo não existe em nenhum dado do repo (doc §9) — resolvido num passo à parte.
const MIGRACAO_MODELO_SEM_NOME_DERIVAVEL = 'gentilicos';

const MIGRACAO_REGIAO_POR_UF = {
  MT: 'CENTRO-OESTE', MS: 'CENTRO-OESTE', GO: 'CENTRO-OESTE', DF: 'CENTRO-OESTE',
  AC: 'NORTE', AM: 'NORTE', AP: 'NORTE', PA: 'NORTE', RO: 'NORTE', RR: 'NORTE', TO: 'NORTE',
};
const MIGRACAO_CATEGORIA_FIXA = 'Seu Lugar';

// Chave canônica de um produto: modelo + UF + cidade reduzida a letras/dígitos. É o que faz a
// arte do disco encontrar o produto da loja de origem, dos dois lados.
function migracaoChave(modelo, uf, cidade) {
  return `${modelo}|${String(uf).toUpperCase()}|${normalizarTextoMatch(cidade).replace(/[^a-z0-9]+/g, '')}`;
}

// As 5 categorias de um produto (doc §4).
function migracaoCategoriasDoItem(modelo, uf) {
  const regiao = MIGRACAO_REGIAO_POR_UF[String(uf).toUpperCase()];
  const modeloCat = MIGRACAO_MODELOS[modelo] && MIGRACAO_MODELOS[modelo].categoria;
  if (!regiao || !modeloCat) return null;
  return [regiao, `${regiao} - ${uf}`, `${regiao} - ${modeloCat}`, `${regiao} - ${modeloCat} - ${uf}`, MIGRACAO_CATEGORIA_FIXA];
}

// Varre o acervo e devolve Map chave → { modelo, uf, cidadeArquivo, arquivos: { sufixo: caminho } }.
// Lê só a árvore de diretórios; nenhum PNG é aberto aqui (são 8 GB) — abrir só acontece no job,
// item a item.
async function migracaoIndexarAcervo() {
  if (!MIGRACAO_ARTES_DIR) {
    const err = new Error('MIGRACAO_ARTES_DIR não configurado — esta ferramenta só roda na máquina que tem o acervo de artes');
    err.status = 503;
    throw err;
  }
  const acervo = new Map();
  const modelos = await fsp.readdir(MIGRACAO_ARTES_DIR, { withFileTypes: true });
  for (const dirModelo of modelos) {
    if (!dirModelo.isDirectory() || !MIGRACAO_MODELOS[dirModelo.name]) continue;
    const modelo = dirModelo.name;
    const { token } = MIGRACAO_MODELOS[modelo];
    const caminhoModelo = path.join(MIGRACAO_ARTES_DIR, modelo);
    for (const dirUf of await fsp.readdir(caminhoModelo, { withFileTypes: true })) {
      if (!dirUf.isDirectory()) continue;
      const uf = dirUf.name.toUpperCase();
      if (!MIGRACAO_REGIAO_POR_UF[uf]) continue;
      const caminhoUf = path.join(caminhoModelo, dirUf.name);
      for (const arquivo of await fsp.readdir(caminhoUf)) {
        if (!arquivo.toLowerCase().endsWith('.png')) continue;
        const partes = arquivo.slice(0, -4).split('_');
        const sufixo = partes[partes.length - 1];
        // O token só é descartado quando está mesmo na penúltima posição — cidade que por acaso
        // termine em "arte" continua inteira.
        const corte = token && partes.length > 2 && partes[partes.length - 2] === token ? 2 : 1;
        const cidadeArquivo = partes.slice(0, partes.length - corte).join('_');
        if (!cidadeArquivo) continue;
        const chave = migracaoChave(modelo, uf, cidadeArquivo);
        const item = acervo.get(chave) || { modelo, uf, cidadeArquivo, arquivos: {}, descartados: [] };
        const completo = path.join(caminhoUf, arquivo);
        const anterior = item.arquivos[sufixo];
        if (anterior) {
          // Dois arquivos caem na mesma chave quando a cidade tem apóstrofo e o acervo guarda as
          // duas grafias ("alvorada_d'oeste" e "alvorada_d_oeste"). Não são cópias: conferido no
          // acervo, a versão sem apóstrofo tem a estampa ERRADA ("ALVORADA D OESTE"). Vence a
          // grafia com apóstrofo; a outra é descartada e aparece no preview, nunca em silêncio.
          const vencedor = arquivo.includes("'") ? completo : anterior;
          const perdedor = vencedor === completo ? anterior : completo;
          item.arquivos[sufixo] = vencedor;
          item.descartados.push({ sufixo, usado: vencedor, ignorado: perdedor });
        } else {
          item.arquivos[sufixo] = completo;
        }
        acervo.set(chave, item);
      }
    }
  }
  return acervo;
}

// Quais sufixos um item precisa ter pra ser criável: os baldes de cor do modelo, deduplicados
// (na maioria dos modelos `claras` e `amarelo` apontam pro mesmo arquivo).
function migracaoSufixosNecessarios(modelo) {
  return [...new Set(Object.values(MIGRACAO_MODELOS[modelo].sufixos))];
}

// Lê o nome de um produto da loja de origem e devolve a chave canônica, SEM depender do formato
// exato do título. Em vez de casar "{Cidade} | {Modelo} {UF}" com regex — que quebraria no
// "Feito em {Cidade} {UF}" e em qualquer variação futura —, remove do nome as peças conhecidas
// (palavra do modelo, UF, separadores) e trata o resto como cidade.
function migracaoChaveDoProdutoOrigem(nome) {
  const norm = normalizarTextoMatch(nome);
  if (!norm) return null;

  const ufMatch = norm.match(/\b([a-z]{2})\b\s*$/);
  const uf = ufMatch ? ufMatch[1].toUpperCase() : null;
  if (!uf || !MIGRACAO_REGIAO_POR_UF[uf]) return null;

  let resto = norm.slice(0, ufMatch.index);
  let modelo = null;
  for (const [chave, cfg] of Object.entries(MIGRACAO_MODELOS)) {
    const palavra = normalizarTextoMatch(cfg.label);
    if (!resto.includes(palavra)) continue;
    // Vence o rótulo mais longo: "feito em" antes de "em", "territorio" antes de "origem".
    if (!modelo || palavra.length > normalizarTextoMatch(MIGRACAO_MODELOS[modelo].label).length) modelo = chave;
  }
  if (!modelo) return null;

  resto = resto.replace(normalizarTextoMatch(MIGRACAO_MODELOS[modelo].label), ' ');
  const cidade = resto.replace(/[|·\-–]/g, ' ').trim();
  if (!cidade) return null;
  return { chave: migracaoChave(modelo, uf, cidade), modelo, uf, cidade };
}

// ── Catálogo — Agrupamentos (Fase 8.3, ver docs/plan.md) ────────────────
// Sem editar/excluir o grupo inteiro — só criar (merge automático se algum produto já
// pertence a um grupo) e remover produto individual. Remover o penúltimo produto dissolve o
// grupo (a Ink devolve product_cluster: null) — a UI precisa avisar disso antes de confirmar.
app.get('/api/admin/agrupamentos', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    const { paginado, page, perPage } = paginaDaQuery(req.query);
    const data = await inkApiRequestDaStore(paginado
      ? `/v1/stores/product_clusters?page=${page}&per_page=${perPage}`
      : '/v1/stores/product_clusters?per_page=100');
    const clusters = data.product_clusters || [];
    // Resolve nome/imagem só do produto de vitrine (não de todos os `product_ids`, que pode ser
    // bem maior) — sem isso a listagem só mostrava o id cru do agrupamento e do produto de
    // vitrine, achado do refinamento visual (nunca inventar dado que a API não dá, mas o nome
    // real está a 1 chamada de distância, então busca).
    // Até 100 agrupamentos = até 100 chamadas. Em paralelo total, elas esgotavam o limite de taxa da
    // Ink (429) — com o catálogo sincronizando ao mesmo tempo, a tela ficava sem nome de produto. Lotes
    // pequenos e um produto de vitrine repetido só é buscado uma vez.
    const produtosDeVitrine = new Map();
    const buscarVitrine = (id) => {
      if (!produtosDeVitrine.has(id)) {
        produtosDeVitrine.set(id, inkApiRequestDaStore(`/v1/stores/products/${id}`).then((d) => d.product).catch(() => null));
      }
      return produtosDeVitrine.get(id);
    };
    const agrupamentos = [];
    const LOTE_VITRINE = 5;
    for (let i = 0; i < clusters.length; i += LOTE_VITRINE) {
      const lote = clusters.slice(i, i + LOTE_VITRINE);
      const produtos = await Promise.all(lote.map((c) => buscarVitrine(c.default_product_id)));
      lote.forEach((c, k) => {
        agrupamentos.push({
          ...c,
          defaultProductName: produtos[k] ? produtos[k].name : null,
          defaultProductImageUrl: produtos[k] ? produtos[k].main_image_url : null,
        });
      });
    }
    res.json({ agrupamentos, page: paginado ? page : 1, totalPages: data.total_pages || 1, totalCount: data.total_count ?? null });
  } catch (err) {
    console.error(`[AGRUPAMENTOS] falha ao listar (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar os agrupamentos' });
  }
});

app.get('/api/admin/agrupamentos/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    const cluster = await inkApiRequestDaStore(`/v1/stores/product_clusters/${id}`);
    const produtos = await Promise.all(
      (cluster.product_cluster.product_ids || []).map((pid) =>
        inkApiRequestDaStore(`/v1/stores/products/${pid}`).then((d) => d.product).catch(() => null)
      )
    );
    res.json({ loja, agrupamento: cluster.product_cluster, produtos: produtos.filter(Boolean) });
  } catch (err) {
    console.error(`[AGRUPAMENTOS] falha ao buscar agrupamento ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar o agrupamento' });
  }
});

app.post('/api/admin/agrupamentos', requireAdmin, async (req, res) => {
  const { productIds } = req.body || {};
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  if (!Array.isArray(productIds) || productIds.length < 2) return res.status(400).json({ error: 'informe ao menos 2 produtos (ou 1 novo + 1 já agrupado)' });

  try {
    const data = await inkApiPostDaStore('/v1/stores/product_clusters', { product_ids: productIds }, { 'Idempotency-Key': crypto.randomUUID() });
    res.status(201).json({ loja, agrupamento: data.product_cluster });
  } catch (err) {
    console.error(`[AGRUPAMENTOS] falha ao criar agrupamento (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível criar o agrupamento', details: err.details });
  }
});

app.delete('/api/admin/agrupamentos/:clusterId/produtos/:produtoId', requireAdmin, async (req, res) => {
  const { clusterId, produtoId } = req.params;
  const loja = lojaLegadaDoContextoOuNula(); // só rótulo/compatibilidade: nula na Store nativa
  try {
    const data = await inkApiDeleteDaStore(`/v1/stores/product_clusters/${clusterId}/products/${produtoId}`, { 'Idempotency-Key': crypto.randomUUID() });
    res.json({ loja, agrupamento: data.product_cluster || null, dissolvido: !data.product_cluster });
  } catch (err) {
    console.error(`[AGRUPAMENTOS] falha ao remover produto ${produtoId} do agrupamento ${loja}/${clusterId}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível remover o produto do agrupamento' });
  }
});

// ── Catálogo — Promoções (Fase 8.4, ver docs/plan.md) ───────────────────
const PROMOTION_SUBTYPES = ['standard', 'progressive', 'unit_free'];

app.get('/api/admin/promocoes', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula();
  const params = new URLSearchParams({ per_page: '100' });
  if (req.query.type) params.set('type', req.query.type);
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/promotions?${params.toString()}`);
    res.json({ promocoes: data.promotions || [] });
  } catch (err) {
    console.error(`[PROMOCOES] falha ao listar (${loja}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar as promoções' });
  }
});

app.post('/api/admin/promocoes', requireAdmin, async (req, res) => {
  const { type, ...campos } = req.body || {};
  const loja = lojaLegadaDoContextoOuNula();
  if (!PROMOTION_SUBTYPES.includes(type)) return res.status(400).json({ error: `type deve ser um de: ${PROMOTION_SUBTYPES.join(', ')}` });
  if (typeof campos.code !== 'string' || !campos.code.trim()) return res.status(400).json({ error: 'informe o código da promoção' });

  try {
    const data = await inkApiPostDaStore(`/v1/stores/promotions/${type}`, campos, { 'Idempotency-Key': crypto.randomUUID() });
    res.status(201).json({ loja, promocao: data.promotion });
  } catch (err) {
    console.error(`[PROMOCOES] falha ao criar promoção (${loja}, ${type}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível criar a promoção', details: err.details });
  }
});

app.patch('/api/admin/promocoes/:type/:id', requireAdmin, async (req, res) => {
  const { type, id } = req.params;
  const loja = lojaLegadaDoContextoOuNula();
  if (!PROMOTION_SUBTYPES.includes(type)) return res.status(400).json({ error: `type deve ser um de: ${PROMOTION_SUBTYPES.join(', ')}` });
  try {
    const data = await inkApiPatchDaStore(`/v1/stores/promotions/${type}/${id}`, req.body || {}, { 'Idempotency-Key': crypto.randomUUID() });
    res.json({ loja, promocao: data.promotion });
  } catch (err) {
    console.error(`[PROMOCOES] falha ao atualizar promoção ${loja}/${type}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível atualizar a promoção', details: err.details });
  }
});

app.delete('/api/admin/promocoes/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const loja = lojaLegadaDoContextoOuNula();
  try {
    await inkApiDeleteDaStore(`/v1/stores/promotions/${id}`, { 'Idempotency-Key': crypto.randomUUID() });
    res.status(204).end();
  } catch (err) {
    console.error(`[PROMOCOES] falha ao excluir promoção ${loja}/${id}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível excluir a promoção' });
  }
});

// ── Financeiro (Fase 10, ver docs/plan.md) ──────────────────────────────
// Tudo somente leitura — a API não documenta endpoint de "solicitar saque" nem de antecipação
// via API (ambos "fora de escopo" segundo a própria doc), então essa tela nunca oferece essas
// ações, só mostra o histórico.
// Identidade canônica: `organization_id + store_id` do contexto, e a credencial Ink é a da
// Organization (`inkApiRequestDaStore`). `loja` sai só como rótulo de compatibilidade — NULA para a
// Store nativa do Oria — e nunca como condição para a consulta existir.
app.get('/api/admin/financeiro/resumo', requireAdmin, async (req, res) => {
  const storeId = storeDoContexto();
  try {
    const data = await inkApiRequestDaStore('/v1/stores/balance');
    res.json({ storeId, loja: lojaLegadaDoContextoOuNula(), saldo: data.balance });
  } catch (err) {
    console.error(`[FINANCEIRO] falha ao buscar saldo (store ${storeId}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar o saldo' });
  }
});

app.get('/api/admin/financeiro/movimentacoes', requireAdmin, async (req, res) => {
  const storeId = storeDoContexto();
  const params = new URLSearchParams({ page: String(req.query.page || 1), per_page: '25' });
  if (req.query.start_date) params.set('start_date', req.query.start_date);
  if (req.query.end_date) params.set('end_date', req.query.end_date);
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/balance_extract?${params.toString()}`);
    res.json({ storeId, loja: lojaLegadaDoContextoOuNula(), extrato: data.balance_extract || [], page: data.page, totalPages: data.total_pages, hasMore: data.has_more });
  } catch (err) {
    console.error(`[FINANCEIRO] falha ao buscar extrato (store ${storeId}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar o extrato' });
  }
});

app.get('/api/admin/financeiro/antecipacoes', requireAdmin, async (req, res) => {
  const storeId = storeDoContexto();
  try {
    const data = await inkApiRequestDaStore('/v1/stores/prepayments?per_page=100');
    res.json({ storeId, loja: lojaLegadaDoContextoOuNula(), antecipacoes: data.prepayments || [] });
  } catch (err) {
    console.error(`[FINANCEIRO] falha ao buscar antecipações (store ${storeId}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar as antecipações' });
  }
});

app.get('/api/admin/financeiro/saques', requireAdmin, async (req, res) => {
  const storeId = storeDoContexto();
  try {
    const data = await inkApiRequestDaStore('/v1/stores/withdraws?per_page=100');
    res.json({ storeId, loja: lojaLegadaDoContextoOuNula(), saques: data.withdraws || [] });
  } catch (err) {
    console.error(`[FINANCEIRO] falha ao buscar saques (store ${storeId}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível buscar os saques' });
  }
});

// ── Simulador de frete (Fase 10) ─────────────────────────────────────────
// Sempre estimativa sobre um produto de referência (a própria Ink avisa isso) — nunca
// apresentar como cotação definitiva.
app.get('/api/admin/frete/simular', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContextoOuNula();
  const cep = String(req.query.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) return res.status(400).json({ error: 'CEP inválido' });
  try {
    const data = await inkApiRequestDaStore(`/v1/stores/shipping_simulation?cep=${cep}`);
    res.json({ loja, simulacao: data.shipping_simulation });
  } catch (err) {
    console.error(`[FRETE] falha ao simular frete (${loja}, ${cep}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível simular o frete' });
  }
});

// Estoque por variação (tamanho/cor/modelo) — só a última observação de cada uma, mais baixo
// primeiro. Sem Postgres configurado, o recurso simplesmente não existe (não tem fallback em
// JSON, ver `registrarObservacoesEstoque`).
app.get('/api/admin/estoque', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'rastreio de estoque exige Postgres configurado' });
  const loja = lojaLegadaDoContexto();

  try {
    // O "tipo de peça" de verdade pro estoque é Tamanho+Cor+Modelo — a estampa (produto/SKU) é
    // só o que é impresso em cima da mesma peça em branco, não muda o estoque. Várias estampas
    // diferentes compartilham o mesmo Tamanho+Cor+Modelo, então agrupa por essas 3, não por SKU
    // (senão a mesma peça em branco aparece repetida várias vezes, uma por estampa observada).
    const { rows } = await pgPool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (loja, tamanho, cor, modelo)
           loja, tamanho, cor, modelo, sku, produto_nome,
           quantidade_disponivel, disponivel, observado_em
         FROM estoque_observacoes
         WHERE $1::text IS NULL OR loja = $1
         ORDER BY loja, tamanho, cor, modelo, observado_em DESC
       ) latest
       ORDER BY quantidade_disponivel ASC NULLS LAST, tamanho ASC, cor ASC, modelo ASC`,
      [loja || null]
    );
    res.json({
      variantes: rows.map((r) => ({
        loja: r.loja,
        tamanho: r.tamanho,
        cor: r.cor,
        modelo: r.modelo,
        quantidadeDisponivel: r.quantidade_disponivel,
        disponivel: r.disponivel,
        observadoEm: r.observado_em,
        // Só informativo — a última estampa em que essa peça em branco apareceu, não identifica
        // o "tipo" de estoque (isso é Tamanho+Cor+Modelo, acima).
        ultimaEstampaVista: r.produto_nome,
        skuVisto: r.sku,
      })),
    });
  } catch (err) {
    console.error(`[ESTOQUE] falha ao listar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler o estoque' });
  }
});

// Controle de estoque via produto dedicado — fonte direta (variantes do próprio produto
// "controle-estoque"), não uma inferência via pedido. Convive com /api/admin/estoque de
// propósito (decisão do usuário, 2026-09-04) — nunca mistura as duas fontes na mesma resposta.
app.get('/api/admin/controle-estoque', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'controle de estoque exige Postgres configurado' });
  const loja = lojaLegadaDoContexto();

  try {
    // Agrupa por Tamanho+Cor+Modelo (escopado por produto_tipo), não por variant_id: quando o
    // produto "controle-estoque" é recriado na Ink, a mesma peça ganha um variant_id novo e as
    // observações do variant_id antigo (órfão, muitas vezes travado em -1/0) continuavam aparecendo
    // como uma linha duplicada da mesma peça. Pegando a última observação por combinação real,
    // o variant_id atual (sincronizado de verdade) sempre vence o antigo.
    const { rows } = await pgPool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (loja, produto_tipo, tamanho, cor, modelo)
           loja, produto_id, produto_tipo, variant_id, sku, tamanho, cor, modelo,
           quantidade_disponivel, disponivel, observado_em
         FROM controle_estoque_observacoes
         WHERE $1::text IS NULL OR loja = $1
         ORDER BY loja, produto_tipo, tamanho, cor, modelo, observado_em DESC
       ) latest
       ORDER BY quantidade_disponivel ASC NULLS LAST, produto_tipo ASC, tamanho ASC, cor ASC, modelo ASC`,
      [loja || null]
    );
    res.json({
      variantes: rows.map((r) => ({
        loja: r.loja,
        produtoTipo: r.produto_tipo,
        tamanho: r.tamanho,
        cor: r.cor,
        modelo: r.modelo,
        sku: r.sku,
        quantidadeDisponivel: r.quantidade_disponivel,
        disponivel: r.disponivel,
        observadoEm: r.observado_em,
      })),
    });
  } catch (err) {
    console.error(`[CONTROLE_ESTOQUE] falha ao listar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler o controle de estoque' });
  }
});

app.post('/api/admin/controle-estoque/sincronizar', requireAdmin, async (req, res) => {
  const loja = lojaLegadaDoContexto();
  try {
    if (loja) {
      const resultado = await sincronizarControleEstoque(loja);
      res.json({ ok: true, ...resultado });
    } else {
      await sincronizarControleEstoqueDaOrganizacao();
      res.json({ ok: true });
    }
  } catch (err) {
    console.error(`[CONTROLE_ESTOQUE] falha ao sincronizar sob demanda: ${err.message}`);
    res.status(500).json({ error: 'não foi possível sincronizar agora' });
  }
});

// Apaga TODO o histórico de observações (não só a última, todas — a tabela é append-only de
// propósito) e ressincroniza do zero — pedido do usuário pra investigar suspeita de dado velho/
// duplicado sobrevivendo mesmo depois do fix de DISTINCT ON por Tamanho+Cor+Modelo (ver commit
// "controle de estoque deduplica..."). Ação destrutiva: só limpa observação derivada, nunca toca
// no produto/variante real da Ink — ressincroniza na sequência, então o pior caso é a tela ficar
// vazia por alguns segundos até a sincronização terminar.
app.post('/api/admin/controle-estoque/limpar', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'controle de estoque exige Postgres configurado' });
  const loja = lojaLegadaDoContexto();

  try {
    // Só a Organization da sessão. Nunca TRUNCATE: ele ignora RLS e apagaria todas.
    await pgPool.query('DELETE FROM controle_estoque_observacoes WHERE organization_id = $1 AND loja = $2', [orgDoContexto(), loja]);
    const resultado = await sincronizarControleEstoque(loja);
    res.json({ ok: true, limpou: loja, ...resultado });
  } catch (err) {
    console.error(`[CONTROLE_ESTOQUE] falha ao limpar e ressincronizar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível limpar e ressincronizar agora' });
  }
});

// Clientes de todas as lojas configuradas (usa GET /v1/stores/customers, já documentado pela
// API mas ainda não consumido em nenhum outro lugar do sistema).
app.get('/api/admin/dashboard/customers', requireAdmin, async (req, res) => {
  const { resultados, erros } = await fetchInkDaStore('/v1/stores/customers?per_page=100');

  const clientes = resultados.flatMap(({ loja, data }) =>
    (data.customers || []).map((c) => ({
      loja,
      nome: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null,
      email: c.email || null,
      telefone: c.phone || null,
      documento: c.document || null,
      aceitaMarketing: !!c.accepts_marketing,
    }))
  );

  res.json({ clientes, erros });
});

// Histórico de compras por cliente (contagem + última compra) — pra remarketing: quem comprou
// mais (fidelizar) e quem não compra há tempos (reativar com desconto). Agrega direto do cache
// `pedidos_ink` (já alimentado por webhook + sync de hora em hora), não da API da INK ao vivo —
// por isso exige Postgres. Cliente identificado por documento (mais confiável), com telefone e
// depois e-mail como fallback, igual o anti-spam de carrinho já faz (`clienteJaComprou`).
app.get('/api/admin/clientes', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'histórico de compras exige Postgres configurado' });

  try {
    // O escopo é canônico (`organization_id + store_id`, com o ramo de compatibilidade só quando a
    // Store tem chave legada) e vive dentro de `buscarClientesAgregados`.
    const clientes = await buscarClientesAgregados();
    res.json({ clientes });
  } catch (err) {
    console.error(`[CLIENTES] falha ao listar histórico de compras: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler o histórico de compras' });
  }
});

// Cadastro de clientes da Ink (todas as páginas), com cache curto POR STORE. A chave é montada aqui com a
// Organization e a Store do contexto — nunca vem do request — e o cache só guarda o cadastro daquela chave.
const cadastroDeClientesCache = clientesCadastro.criarCacheDoCadastro();

function cadastroDeClientesDaStore() {
  const chave = `${orgDoContexto()}:${storeDoContexto()}`;
  return cadastroDeClientesCache.obter(chave, (page) => inkApiRequestDaStore(`/v1/stores/customers?page=${page}&per_page=100`));
}

// Lista paginada da tela de Clientes: busca, ordenação e filtros rodam aqui, ANTES de fatiar a página, para valerem
// para a lista inteira (lib/clientes/lista.js). A base é o histórico de pedidos da Organization/Store do contexto
// MAIS o cadastro da Ink de quem nunca pediu (filtro `tipo`). Se a Ink não responder, a tela segue com quem já pediu
// e avisa (`cadastro.disponivel: false`) em vez de quebrar.
app.get('/api/admin/clientes/lista', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'histórico de compras exige Postgres configurado' });

  try {
    const consulta = clientesLista.normalizarConsulta(req.query);
    const historico = await buscarClientesAgregados();
    let base = historico;
    let cadastro = { incluido: false, disponivel: true, parcial: false, atualizadoEm: null };

    if (consulta.tipo !== 'com_pedido') {
      try {
        const registro = await cadastroDeClientesDaStore();
        base = clientesLista.unirComCadastro(historico, registro.clientes, { loja: chaveDaStore() });
        cadastro = { incluido: true, disponivel: true, parcial: registro.parcial, atualizadoEm: registro.carregadoEm };
      } catch (err) {
        console.error(`[CLIENTES] cadastro da Ink indisponível: ${err.message}`);
        cadastro = { incluido: false, disponivel: false, parcial: false, atualizadoEm: null };
        // "Só cadastro" sem cadastro não tem o que mostrar; os demais tipos seguem com o histórico.
        if (consulta.tipo === 'sem_pedido') base = [];
      }
    }

    res.json({ ...clientesLista.listarClientes(base, consulta), cadastro });
  } catch (err) {
    console.error(`[CLIENTES] falha ao listar clientes paginados: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler os clientes' });
  }
});

// Agregado de clientes por loja a partir de pedidos_ink. Extraído de /api/admin/clientes pra ser
// reaproveitado por calcularAudienciaCampanha (Campanhas/Remarketing) sem duplicar a query.
// total_gasto/ticket_medio só entram aqui (não em /api/admin/clientes antes disso existir) porque
// são a base dos filtros "total gasto"/"ticket médio" de audiência.
//
// Identidade de cliente é resolvida por union-find (não mais um simples COALESCE por linha): dois
// pedidos são da MESMA pessoa se compartilham documento, telefone OU email — de forma transitiva.
// Antes, um cliente com um pedido "documento=X, sem telefone" e outro "sem documento, telefone=Y"
// virava 2 registros distintos (cada linha pegava o "primeiro campo preenchido" isoladamente),
// duplicando destinatário de campanha (2 customerKey diferentes pra 1 pessoa só, escapando do
// ON CONFLICT (organization_id, campaign_id, customer_key) de campaign_recipients). Trade-off consciente: no caso
// raro de duas pessoas diferentes compartilharem telefone/email de família em pedidos distintos,
// elas passam a contar como 1 "cliente" — prioriza nunca duplicar envio sobre esse risco raro.
async function buscarClientesAgregados() {
  const escopo = escopoDaStore(2);
  const { rows } = await pgPool.query(
    `SELECT loja, buyer_nome, buyer_telefone, buyer_documento, buyer_email, buyer_aceita_marketing,
            buyer_uf, payment_status, total_value, criado_em, lucro_operacional, is_troca
     FROM pedidos_ink
     WHERE organization_id = $1 AND ${escopo.sql}
       AND COALESCE(NULLIF(buyer_documento,''), NULLIF(buyer_telefone,''), NULLIF(buyer_email,'')) IS NOT NULL
     ORDER BY criado_em DESC`,
    [orgDoContexto(), ...escopo.params]
  );

  // Identidade nunca cruza lojas diferentes (mesmo documento podendo se repetir em 2 lojas
  // distintas, cada loja mantém seus próprios registros de cliente) — agrupa por loja primeiro.
  // A Store nativa grava `loja` NULA nos pedidos; o cliente da Ink chega com a chave da Store
  // (`chaveDaStore()`). A tela cruza os dois por `loja + documento/telefone`, então a chave precisa ser a mesma.
  const chaveDoContexto = chaveDaStore();
  const pedidosPorLoja = new Map();
  for (const r of rows) {
    const chave = r.loja || chaveDoContexto;
    if (!pedidosPorLoja.has(chave)) pedidosPorLoja.set(chave, []);
    pedidosPorLoja.get(chave).push(r);
  }

  const agora = Date.now();
  const clientes = [];
  for (const [loja, pedidos] of pedidosPorLoja) {
    const pai = pedidos.map((_, i) => i);
    const encontrar = (i) => { while (pai[i] !== i) { pai[i] = pai[pai[i]]; i = pai[i]; } return i; };
    const unir = (a, b) => { const ra = encontrar(a); const rb = encontrar(b); if (ra !== rb) pai[ra] = rb; };

    const porDocumento = new Map();
    const porTelefone = new Map();
    const porEmail = new Map();
    pedidos.forEach((p, i) => {
      const doc = (p.buyer_documento || '').trim();
      const tel = (p.buyer_telefone || '').trim();
      const email = (p.buyer_email || '').trim();
      if (doc) { if (porDocumento.has(doc)) unir(i, porDocumento.get(doc)); else porDocumento.set(doc, i); }
      if (tel) { if (porTelefone.has(tel)) unir(i, porTelefone.get(tel)); else porTelefone.set(tel, i); }
      if (email) { if (porEmail.has(email)) unir(i, porEmail.get(email)); else porEmail.set(email, i); }
    });

    const grupos = new Map(); // raiz do union-find -> pedidos do grupo, na ordem (já vem DESC por criado_em)
    pedidos.forEach((p, i) => {
      const raiz = encontrar(i);
      if (!grupos.has(raiz)) grupos.set(raiz, []);
      grupos.get(raiz).push(p);
    });

    for (const pedidosDoGrupo of grupos.values()) {
      const maisRecente = pedidosDoGrupo[0]; // grupo preserva a ordem DESC por criado_em da query
      const pedidosPagos = pedidosDoGrupo.filter((p) => PAYMENT_STATUSES_CONVERTIDO.has(p.payment_status));
      const totalCompras = pedidosPagos.length;
      const totalGasto = pedidosPagos.reduce((acc, p) => acc + (Number(p.total_value) || 0), 0);
      // Lucro que o cliente deixou pra loja (ver financeiroPedidoInk): troca não é venda e fica fora;
      // pedido pago ainda sem custo calculado é contado à parte, pra tela não mostrar lucro menor.
      const pagosSemTroca = pedidosPagos.filter((p) => !p.is_troca);
      const lucroOperacional = pagosSemTroca.reduce((acc, p) => acc + (Number(p.lucro_operacional) || 0), 0);
      const pedidosSemFinanceiro = pagosSemTroca.filter((p) => p.lucro_operacional == null).length;
      const ultimaCompraEm = pedidosPagos.reduce((max, p) => (!max || p.criado_em > max ? p.criado_em : max), null);
      const primeiraCompraEm = pedidosPagos.reduce((min, p) => (!min || p.criado_em < min ? p.criado_em : min), null);
      // UF do pedido mais recente QUE TEM uf preenchida — pedidos antigos (antes desse campo
      // existir) não têm buyer_uf, pegar sempre o mais recente sem filtro perderia a UF de quem
      // não comprou de novo depois que passou a ser capturada.
      const ufRecente = pedidosDoGrupo.find((p) => p.buyer_uf);

      // Toda chave de identidade (documento||telefone||email de CADA pedido, na preferência de
      // sempre) que já apareceu nesse grupo — usada por avaliarAudienciaCampanha pra achar
      // histórico de campanha gravado sob uma chave "antiga" (de antes dessa mesclagem existir),
      // sem perder "já recebeu campanha" por causa da identidade ter sido calculada diferente.
      const chavesHistoricas = new Set();
      for (const p of pedidosDoGrupo) {
        const chave = p.buyer_documento || p.buyer_telefone || p.buyer_email;
        if (chave) chavesHistoricas.add(chave);
      }

      clientes.push({
        loja,
        // Preferência documento > telefone > email do PEDIDO MAIS RECENTE do grupo (mesma regra
        // de sempre) — vai ser a chave usada em NOVOS envios de campanha daqui pra frente.
        customerKey: maisRecente.buyer_documento || maisRecente.buyer_telefone || maisRecente.buyer_email,
        legacyCustomerKeys: Array.from(chavesHistoricas),
        nome: maisRecente.buyer_nome,
        telefone: maisRecente.buyer_telefone,
        email: maisRecente.buyer_email,
        documento: maisRecente.buyer_documento,
        aceitaMarketing: maisRecente.buyer_aceita_marketing,
        uf: ufRecente ? ufRecente.buyer_uf : null,
        totalCompras,
        totalGasto,
        ticketMedio: totalCompras > 0 ? totalGasto / totalCompras : null,
        lucroOperacional: Math.round(lucroOperacional * 100) / 100,
        pedidosSemFinanceiro,
        ultimaCompraEm,
        primeiraCompraEm,
        diasSemComprar: ultimaCompraEm ? Math.floor((agora - new Date(ultimaCompraEm).getTime()) / 86400000) : null,
      });
    }
  }

  clientes.sort((a, b) => b.totalCompras - a.totalCompras);
  return clientes;
}

// ── Campanhas/Remarketing — audiência (Fase 3 do plano) ──────────────────────
// Campos suportados hoje com dado real existente (decisão #7 do plano) — cidade, tags,
// produto/categoria comprada, cupom e ticket médio por variação ficam de fora por falta de
// captura desse dado em pedidos_ink (não inventados). UF entrou depois (buyer_uf, vem direto de
// shipping_address.state da Ink) pra permitir campanhas sazonais por estado.
const AUDIENCIA_CAMPOS_FILTRO = [
  'diasSemComprar', 'quantidadePedidos', 'totalGasto', 'ticketMedio', 'uf',
  'optIn', 'temCarrinhoAbandonado', 'recebeuCampanha', 'naoRecebeuCampanha', 'recebeuCampanhaNosUltimosDias',
];

function compararNumero(valor, op, alvo) {
  if (valor == null || alvo == null) return false;
  switch (op) {
    case 'gt': return valor > alvo;
    case 'gte': return valor >= alvo;
    case 'lt': return valor < alvo;
    case 'lte': return valor <= alvo;
    case 'eq': return valor === alvo;
    default: return false;
  }
}

// Reexecuta os filtros no backend, nunca no navegador (spec, "Contagem da audiência"). Usada por
// dois consumidores: o preview (só quer a contagem, clientes nunca chegam ao frontend) e o
// disparo real da campanha (Fase 5, precisa da lista de elegíveis pra montar o snapshot em
// campaign_recipients) — por isso sempre calcula e devolve `elegiveis`; quem só quer a contagem
// (calcularAudienciaCampanha, abaixo) simplesmente ignora o array.
async function avaliarAudienciaCampanha(loja, matchTipo, filtros, exclusoes) {
  const clientes = await buscarClientesAgregados();

  let telefonesComCarrinho = new Set();
  if ((filtros || []).some((f) => f.field === 'temCarrinhoAbandonado')) {
    try {
      const data = await inkApiRequestDaStore('/v1/stores/abandoned_carts?per_page=100');
      telefonesComCarrinho = new Set(
        (data.abandoned_carts || [])
          .map((c) => String((c.buyer && c.buyer.phone) || '').replace(/\D/g, ''))
          .filter(Boolean)
      );
    } catch (err) {
      console.error(`[CAMPANHAS] falha ao buscar carrinhos abandonados pra audiência: ${err.message}`);
    }
  }

  // Histórico de campanhas já enviadas pra essa loja — vazio até a Fase 5 (fila de envio) existir
  // de verdade, o que é correto (nenhuma campanha foi enviada ainda), não um bug.
  const precisaHistorico = (filtros || []).some((f) => ['recebeuCampanha', 'naoRecebeuCampanha', 'recebeuCampanhaNosUltimosDias'].includes(f.field))
    || exclusoes?.recebeuCampanhaNasUltimasHoras;
  const recipientsPorCliente = new Map(); // customerKey -> [{campaignId, sentAt}]
  if (precisaHistorico && pgPool) {
    const { rows } = await pgPool.query(
      `SELECT cr.customer_key, cr.campaign_id, cr.sent_at
       FROM campaign_recipients cr JOIN campaigns c ON c.id = cr.campaign_id
       WHERE c.loja = $1 AND cr.status IN ('sent','delivered','read')`,
      [loja]
    );
    for (const r of rows) {
      if (!recipientsPorCliente.has(r.customer_key)) recipientsPorCliente.set(r.customer_key, []);
      recipientsPorCliente.get(r.customer_key).push({ campaignId: String(r.campaign_id), sentAt: r.sent_at });
    }
  }

  // Um cliente pode ter sido mesclado (buscarClientesAgregados, union-find) a partir de pedidos
  // que no passado geravam customerKey diferentes — olha o histórico sob QUALQUER chave que essa
  // pessoa já teve, não só a atual, senão "já recebeu campanha" pode dar falso negativo (e
  // reenviar) pra quem foi mesclado depois do envio original.
  function historicoDoCliente(cliente) {
    const chaves = [cliente.customerKey, ...(cliente.legacyCustomerKeys || [])];
    const historico = [];
    for (const chave of chaves) {
      const doChave = recipientsPorCliente.get(chave);
      if (doChave) historico.push(...doChave);
    }
    return historico;
  }

  function avaliarFiltro(cliente, filtro) {
    const { field, op, value } = filtro;
    switch (field) {
      case 'diasSemComprar':
        // "nunca comprou" (null) só bate em "há mais de N dias" — pra "menos de N dias" ele
        // simplesmente não se aplica (não é uma resposta válida pra quem nunca comprou).
        if (cliente.diasSemComprar == null) return op === 'gte' || op === 'gt';
        return compararNumero(cliente.diasSemComprar, op, value);
      case 'quantidadePedidos':
        return compararNumero(cliente.totalCompras, op, value);
      case 'totalGasto':
        return compararNumero(cliente.totalGasto, op, value);
      case 'ticketMedio':
        return compararNumero(cliente.ticketMedio, op, value);
      case 'uf':
        return !!cliente.uf && cliente.uf === String(value || '').toUpperCase();
      case 'optIn':
        return !!cliente.aceitaMarketing === !!value;
      case 'temCarrinhoAbandonado': {
        const tem = telefonesComCarrinho.has(String(cliente.telefone || '').replace(/\D/g, ''));
        return tem === !!value;
      }
      case 'recebeuCampanha': {
        const historico = historicoDoCliente(cliente);
        return historico.some((h) => h.campaignId === String(value?.campanhaId));
      }
      case 'naoRecebeuCampanha': {
        const historico = historicoDoCliente(cliente);
        return !historico.some((h) => h.campaignId === String(value?.campanhaId));
      }
      case 'recebeuCampanhaNosUltimosDias': {
        const historico = historicoDoCliente(cliente);
        const limite = Date.now() - (value?.dias || 0) * 86400000;
        return historico.some((h) => h.sentAt && new Date(h.sentAt).getTime() >= limite);
      }
      default:
        return false;
    }
  }

  const filtrosValidos = (filtros || []).filter((f) => f && AUDIENCIA_CAMPOS_FILTRO.includes(f.field));
  const matched = clientes.filter((cliente) => {
    if (!filtrosValidos.length) return true;
    return matchTipo === 'ANY' ? filtrosValidos.some((f) => avaliarFiltro(cliente, f)) : filtrosValidos.every((f) => avaliarFiltro(cliente, f));
  });

  // Exclusões sempre por cima do que já deu match — nunca dentro da lógica ALL/ANY (spec: seção
  // separada de "Exclusões", com "sem opt-in"/"números inválidos" já marcados por padrão).
  const semOptIn = exclusoes?.semOptIn !== false;
  const numeroInvalido = exclusoes?.numeroInvalido !== false;
  const compradoNosUltimosDias = exclusoes?.compradoNosUltimosDias ?? null;
  const recebeuCampanhaNasUltimasHoras = exclusoes?.recebeuCampanhaNasUltimasHoras ?? null;

  const breakdown = { optOut: 0, numeroInvalido: 0, compradoRecentemente: 0, recebeuCampanhaRecentemente: 0 };
  const elegiveis = [];
  for (const cliente of matched) {
    if (semOptIn && !cliente.aceitaMarketing) { breakdown.optOut++; continue; }
    const digitos = String(cliente.telefone || '').replace(/\D/g, '');
    if (numeroInvalido && digitos.length < 10) { breakdown.numeroInvalido++; continue; }
    if (compradoNosUltimosDias != null && cliente.diasSemComprar != null && cliente.diasSemComprar < compradoNosUltimosDias) {
      breakdown.compradoRecentemente++; continue;
    }
    if (recebeuCampanhaNasUltimasHoras != null) {
      const historico = historicoDoCliente(cliente);
      const limite = Date.now() - recebeuCampanhaNasUltimasHoras * 3600000;
      if (historico.some((h) => h.sentAt && new Date(h.sentAt).getTime() >= limite)) {
        breakdown.recebeuCampanhaRecentemente++; continue;
      }
    }
    elegiveis.push(cliente);
  }

  return { matched: matched.length, excluded: matched.length - elegiveis.length, eligible: elegiveis.length, breakdown, elegiveis };
}

// Wrapper pro endpoint de preview — mesma função acima, só sem devolver a lista de clientes pro
// frontend (spec: "não carregar todos os clientes no navegador pra filtrar").
async function calcularAudienciaCampanha(loja, matchTipo, filtros, exclusoes) {
  const { elegiveis, ...contagem } = await avaliarAudienciaCampanha(loja, matchTipo, filtros, exclusoes);
  return contagem;
}

app.post('/api/admin/campaigns/audience/preview', requireAdmin, async (req, res) => {
  const { match, filters, exclusions } = req.body || {};
  const loja = lojaLegadaDoContextoOuNula();
  if (!pgPool) return res.status(503).json({ error: 'audiência de campanha exige Postgres configurado' });
  try {
    const resultado = await calcularAudienciaCampanha(loja, match === 'ANY' ? 'ANY' : 'ALL', filters || [], exclusions || {});
    res.json(resultado);
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao calcular audiência: ${err.message}`);
    res.status(500).json({ error: 'não foi possível calcular a audiência' });
  }
});

// ── Segmentos — definição de filtro salva e DINÂMICA (spec, Parte 5: nunca uma lista fixa de
// IDs). O snapshot de destinatários só nasce quando uma campanha É disparada (Fase 5).
function mapSegmentoRow(r) {
  return {
    id: String(r.id), nome: r.nome, match: r.match, filtros: r.filtros, exclusoes: r.exclusoes,
    criadoPor: r.criado_por, criadoEm: r.criado_em, atualizadoEm: r.atualizado_em,
  };
}

app.get('/api/admin/segments', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ segmentos: [] });
  try {
    const { rows } = await pgPool.query('SELECT id, nome, match, filtros, exclusoes, criado_por, criado_em, atualizado_em FROM segments ORDER BY criado_em DESC');
    res.json({ segmentos: rows.map(mapSegmentoRow) });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao listar segmentos: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar segmentos' });
  }
});

app.post('/api/admin/segments', requireAdmin, async (req, res) => {
  const { nome, match, filtros, exclusoes } = req.body || {};
  if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'nome é obrigatório' });
  if (!pgPool) return res.status(503).json({ error: 'segmentos exigem Postgres configurado' });
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO segments (nome, match, filtros, exclusoes, criado_por) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, nome, match, filtros, exclusoes, criado_por, criado_em, atualizado_em`,
      [String(nome).trim(), match === 'ANY' ? 'ANY' : 'ALL', JSON.stringify(filtros || []), JSON.stringify(exclusoes || {}), 'admin']
    );
    res.json({ segmento: mapSegmentoRow(rows[0]) });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao criar segmento: ${err.message}`);
    res.status(500).json({ error: 'não foi possível criar o segmento' });
  }
});

app.put('/api/admin/segments/:id', requireAdmin, exigirRecurso('segments'), async (req, res) => {
  const { nome, match, filtros, exclusoes } = req.body || {};
  if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'nome é obrigatório' });
  if (!pgPool) return res.status(503).json({ error: 'segmentos exigem Postgres configurado' });
  try {
    const { rows } = await pgPool.query(
      `UPDATE segments SET nome=$1, match=$2, filtros=$3, exclusoes=$4, atualizado_em=now() WHERE id=$5
       RETURNING id, nome, match, filtros, exclusoes, criado_por, criado_em, atualizado_em`,
      [String(nome).trim(), match === 'ANY' ? 'ANY' : 'ALL', JSON.stringify(filtros || []), JSON.stringify(exclusoes || {}), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'segmento não encontrado' });
    res.json({ segmento: mapSegmentoRow(rows[0]) });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao editar segmento: ${err.message}`);
    res.status(500).json({ error: 'não foi possível editar o segmento' });
  }
});

app.delete('/api/admin/segments/:id', requireAdmin, exigirRecurso('segments'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'segmentos exigem Postgres configurado' });
  try {
    await pgPool.query('DELETE FROM segments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao remover segmento: ${err.message}`);
    res.status(500).json({ error: 'não foi possível remover o segmento' });
  }
});

// ── UTM Tracker (docs/claude-utm-tracker-ga4.md) — Builder + campanhas salvas. O Builder não
// depende do Google Analytics: performance real por GA4 é integração futura (Fase 2/3 da spec).
// Regra central da spec: nunca fabricar número — sem GA4 conectado, este módulo só cria, salva e
// padroniza links; não mostra sessão/receita nenhuma.
const UTM_SELECT_COLS = `id, store_id, loja, nome, url_destino, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  url_completa, criado_em, atualizado_em, arquivada_em`;

function mapUtmCampanhaRow(r) {
  return {
    id: String(r.id), storeId: r.store_id, loja: r.loja, nome: r.nome, destinationUrl: r.url_destino,
    source: r.utm_source, medium: r.utm_medium, campaign: r.utm_campaign,
    content: r.utm_content, term: r.utm_term, fullUrl: r.url_completa,
    criadoEm: r.criado_em, atualizadoEm: r.atualizado_em, arquivadaEm: r.arquivada_em,
  };
}

// trim → minúsculas → sem acento → espaço vira "_" → só [a-z0-9_-] → sem "_" duplicado/nas pontas.
// Roda só no momento do save (nunca em background) — uma campanha já salva não é renormalizada
// silenciosamente numa edição que não mexeu naquele campo (spec, Parte 3).
function normalizarUtmValor(v) {
  return String(v ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Nunca concatena querystring na mão: URL + URLSearchParams preservam parâmetros que já existiam
// no destino e não duplicam utm_* se o destino já vier com algum (spec, Parte 2 e teste da Parte
// 29). Retorna null se destinationUrl não for uma URL http(s) válida.
function montarUrlUtm(destinationUrl, { source, medium, campaign, content, term }) {
  let url;
  try { url = new URL(String(destinationUrl || '').trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', medium);
  url.searchParams.set('utm_campaign', campaign);
  if (content) url.searchParams.set('utm_content', content); else url.searchParams.delete('utm_content');
  if (term) url.searchParams.set('utm_term', term); else url.searchParams.delete('utm_term');
  return url.toString();
}

// Valida + normaliza o corpo de criar/editar; devolve { erro } ou os valores prontos pra gravar.
function prepararUtmCampanha(body) {
  // Store da sessão; o corpo nunca escolhe. `loja` (chave legada, nula na Store nativa) só espelha o
  // texto histórico.
  const storeId = storeDoContexto();
  const loja = lojaLegadaDoContextoOuNula();
  const nome = String(body?.nome || '').trim();
  if (!nome) return { erro: 'nome é obrigatório' };
  const source = normalizarUtmValor(body?.source);
  const medium = normalizarUtmValor(body?.medium);
  const campaign = normalizarUtmValor(body?.campaign);
  const content = normalizarUtmValor(body?.content) || null;
  const term = normalizarUtmValor(body?.term) || null;
  if (!source) return { erro: 'utm_source é obrigatório' };
  if (!medium) return { erro: 'utm_medium é obrigatório' };
  if (!campaign) return { erro: 'utm_campaign é obrigatório' };
  const fullUrl = montarUrlUtm(body?.destinationUrl, { source, medium, campaign, content, term });
  if (!fullUrl) return { erro: 'URL de destino inválida — use uma URL completa (http:// ou https://)' };
  return { storeId, loja, nome, destinationUrl: String(body.destinationUrl).trim(), source, medium, campaign, content, term, fullUrl };
}

app.get('/api/admin/utm/campaigns', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ campanhas: [] });
  const status = req.query.status === 'arquivadas' ? 'arquivadas' : req.query.status === 'todas' ? 'todas' : 'ativas';
  // Escopo canônico (`organization_id + store_id`); a campanha histórica, sem `store_id`, só entra
  // quando a Store tem chave legada — Store nativa nunca cai nesse ramo.
  const escopo = escopoDaStore(2);
  const params = [orgDoContexto(), ...escopo.params];
  const condicoes = ['organization_id = $1', escopo.sql];
  if (status === 'ativas') condicoes.push('arquivada_em IS NULL');
  else if (status === 'arquivadas') condicoes.push('arquivada_em IS NOT NULL');
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  try {
    const { rows } = await pgPool.query(`SELECT ${UTM_SELECT_COLS} FROM utm_campaigns ${where} ORDER BY atualizado_em DESC`, params);
    res.json({ campanhas: rows.map(mapUtmCampanhaRow) });
  } catch (err) {
    console.error(`[UTM] falha ao listar campanhas: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar as campanhas UTM' });
  }
});

app.get('/api/admin/utm/campaigns/:id', requireAdmin, exigirRecurso('utm_campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'UTM Tracker exige Postgres configurado' });
  try {
    const { rows } = await pgPool.query(`SELECT ${UTM_SELECT_COLS} FROM utm_campaigns WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    res.json({ campanha: mapUtmCampanhaRow(rows[0]) });
  } catch (err) {
    console.error(`[UTM] falha ao buscar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível buscar a campanha' });
  }
});

app.post('/api/admin/utm/campaigns', requireAdmin, async (req, res) => {
  const prep = prepararUtmCampanha(req.body);
  if (prep.erro) return res.status(400).json({ error: prep.erro });
  if (!pgPool) return res.status(503).json({ error: 'UTM Tracker exige Postgres configurado' });
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO utm_campaigns (store_id, loja, nome, url_destino, utm_source, utm_medium, utm_campaign, utm_content, utm_term, url_completa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${UTM_SELECT_COLS}`,
      [prep.storeId, prep.loja, prep.nome, prep.destinationUrl, prep.source, prep.medium, prep.campaign, prep.content, prep.term, prep.fullUrl]
    );
    res.json({ campanha: mapUtmCampanhaRow(rows[0]) });
  } catch (err) {
    console.error(`[UTM] falha ao criar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível criar a campanha' });
  }
});

app.patch('/api/admin/utm/campaigns/:id', requireAdmin, exigirRecurso('utm_campaigns'), async (req, res) => {
  const prep = prepararUtmCampanha(req.body);
  if (prep.erro) return res.status(400).json({ error: prep.erro });
  if (!pgPool) return res.status(503).json({ error: 'UTM Tracker exige Postgres configurado' });
  try {
    const { rows } = await pgPool.query(
      `UPDATE utm_campaigns SET store_id=$1, loja=$2, nome=$3, url_destino=$4, utm_source=$5, utm_medium=$6, utm_campaign=$7,
         utm_content=$8, utm_term=$9, url_completa=$10, atualizado_em=now()
       WHERE id=$11 RETURNING ${UTM_SELECT_COLS}`,
      [prep.storeId, prep.loja, prep.nome, prep.destinationUrl, prep.source, prep.medium, prep.campaign, prep.content, prep.term, prep.fullUrl,
        req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    res.json({ campanha: mapUtmCampanhaRow(rows[0]) });
  } catch (err) {
    console.error(`[UTM] falha ao editar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível editar a campanha' });
  }
});

app.delete('/api/admin/utm/campaigns/:id', requireAdmin, exigirRecurso('utm_campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'UTM Tracker exige Postgres configurado' });
  try {
    await pgPool.query('DELETE FROM utm_campaigns WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[UTM] falha ao excluir campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível excluir a campanha' });
  }
});

// Duplicar copia só a definição (nunca métricas — este módulo nem tem métrica própria); a cópia
// sempre nasce ativa (não arquivada), mesmo que a original esteja arquivada.
app.post('/api/admin/utm/campaigns/:id/duplicate', requireAdmin, exigirRecurso('utm_campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'UTM Tracker exige Postgres configurado' });
  try {
    const { rows } = await pgPool.query(`SELECT ${UTM_SELECT_COLS} FROM utm_campaigns WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    const o = rows[0];
    const { rows: novaRows } = await pgPool.query(
      `INSERT INTO utm_campaigns (store_id, loja, nome, url_destino, utm_source, utm_medium, utm_campaign, utm_content, utm_term, url_completa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${UTM_SELECT_COLS}`,
      [o.store_id, o.loja, `${o.nome} (cópia)`, o.url_destino, o.utm_source, o.utm_medium, o.utm_campaign, o.utm_content, o.utm_term, o.url_completa]
    );
    res.json({ campanha: mapUtmCampanhaRow(novaRows[0]) });
  } catch (err) {
    console.error(`[UTM] falha ao duplicar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível duplicar a campanha' });
  }
});

app.post('/api/admin/utm/campaigns/:id/archive', requireAdmin, exigirRecurso('utm_campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'UTM Tracker exige Postgres configurado' });
  try {
    const { rows } = await pgPool.query(
      `UPDATE utm_campaigns SET arquivada_em = now(), atualizado_em = now() WHERE id = $1 RETURNING ${UTM_SELECT_COLS}`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    res.json({ campanha: mapUtmCampanhaRow(rows[0]) });
  } catch (err) {
    console.error(`[UTM] falha ao arquivar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível arquivar a campanha' });
  }
});

app.post('/api/admin/utm/campaigns/:id/unarchive', requireAdmin, exigirRecurso('utm_campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'UTM Tracker exige Postgres configurado' });
  try {
    const { rows } = await pgPool.query(
      `UPDATE utm_campaigns SET arquivada_em = NULL, atualizado_em = now() WHERE id = $1 RETURNING ${UTM_SELECT_COLS}`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    res.json({ campanha: mapUtmCampanhaRow(rows[0]) });
  } catch (err) {
    console.error(`[UTM] falha ao desarquivar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível desarquivar a campanha' });
  }
});

// Presets — combinações nomeadas de source+medium reutilizáveis no Builder (ex.: "Instagram Story").
function mapUtmPresetRow(r) {
  return { id: String(r.id), nome: r.nome, source: r.utm_source, medium: r.utm_medium, criadoEm: r.criado_em };
}

app.get('/api/admin/utm/presets', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ presets: [] });
  try {
    const { rows } = await pgPool.query('SELECT id, nome, utm_source, utm_medium, criado_em FROM utm_presets ORDER BY nome');
    res.json({ presets: rows.map(mapUtmPresetRow) });
  } catch (err) {
    console.error(`[UTM] falha ao listar presets: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar os presets' });
  }
});

app.post('/api/admin/utm/presets', requireAdmin, async (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  const source = normalizarUtmValor(req.body?.source);
  const medium = normalizarUtmValor(req.body?.medium);
  if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
  if (!source) return res.status(400).json({ error: 'utm_source é obrigatório' });
  if (!medium) return res.status(400).json({ error: 'utm_medium é obrigatório' });
  if (!pgPool) return res.status(503).json({ error: 'UTM Tracker exige Postgres configurado' });
  try {
    const { rows } = await pgPool.query(
      'INSERT INTO utm_presets (nome, utm_source, utm_medium) VALUES ($1,$2,$3) RETURNING id, nome, utm_source, utm_medium, criado_em',
      [nome, source, medium]
    );
    res.json({ preset: mapUtmPresetRow(rows[0]) });
  } catch (err) {
    console.error(`[UTM] falha ao criar preset: ${err.message}`);
    res.status(500).json({ error: 'não foi possível criar o preset' });
  }
});

app.delete('/api/admin/utm/presets/:id', requireAdmin, exigirRecurso('utm_presets'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'UTM Tracker exige Postgres configurado' });
  try {
    await pgPool.query('DELETE FROM utm_presets WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[UTM] falha ao excluir preset: ${err.message}`);
    res.status(500).json({ error: 'não foi possível excluir o preset' });
  }
});

// ── Campanhas (Fase 4 do plano) — CRUD de rascunho/agendamento. Nada aqui processa envio de
// verdade: uma campanha só chega a "draft" ou "scheduled" nesta fase. A fila de envio de
// verdade (snapshot de destinatários, jobs, Meta) é a Fase 5, ainda não implementada.
const CAMPAIGN_SELECT_COLS = `id, store_id, loja, nome, descricao, template_nome, segmento_id, audience_definition,
  status, agendada_para, iniciada_em, finalizada_em, total_matched, total_excluded, total_recipients,
  criado_por, criado_em, atualizado_em, tamanho_lote, mensagem_web_id, mensagem_web_corpo, mensagem_web_variacoes,
  (SELECT m.nome FROM whatsapp_web_mensagens m WHERE m.id = campaigns.mensagem_web_id) AS mensagem_web_nome`;
// Status em que a campanha ainda pode ser editada/cancelada por aqui — depois de "iniciada" (Fase
// 5), edição silenciosa é proibida (spec, critério de aceite "Nunca permitir editar silenciosamente
// uma campanha que já começou a ser enviada").
const CAMPAIGN_STATUS_EDITAVEL = new Set(['draft', 'scheduled']);

function mapCampanhaRow(r) {
  return {
    id: String(r.id), storeId: r.store_id || null, loja: r.loja || null, nome: r.nome, descricao: r.descricao,
    templateNome: r.template_nome, segmentoId: r.segmento_id != null ? String(r.segmento_id) : null,
    audienceDefinition: r.audience_definition,
    status: r.status, agendadaPara: r.agendada_para, iniciadaEm: r.iniciada_em, finalizadaEm: r.finalizada_em,
    totalMatched: r.total_matched, totalExcluded: r.total_excluded, totalRecipients: r.total_recipients,
    criadoPor: r.criado_por, criadoEm: r.criado_em, atualizadoEm: r.atualizado_em,
    tamanhoLote: r.tamanho_lote,
    mensagemWebId: r.mensagem_web_id || null,
    mensagemWebNome: r.mensagem_web_nome || null,
    mensagemWebCongelada: !!r.mensagem_web_corpo,
  };
}

// undefined = inválido (400); null = sem mensagem do WhatsApp Web.
function normalizarMensagemWebId(valor) {
  if (valor == null || valor === '') return null;
  return typeof valor === 'string' && UUID_RE.test(valor) ? valor : undefined;
}

app.get('/api/admin/campaigns', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ campanhas: [] });
  try {
    // Identidade canônica: a Store do contexto. A linha histórica (sem `store_id`) só entra quando a
    // Store tem chave legada — Store nativa nunca enxerga linha que não seja dela.
    const escopo = escopoDaStore(1);
    const { rows } = await pgPool.query(`SELECT ${CAMPAIGN_SELECT_COLS} FROM campaigns WHERE ${escopo.sql} ORDER BY criado_em DESC`, escopo.params);
    res.json({ campanhas: rows.map(mapCampanhaRow) });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao listar campanhas: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar campanhas' });
  }
});

app.get('/api/admin/campaigns/:id', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  try {
    const { rows } = await pgPool.query(`SELECT ${CAMPAIGN_SELECT_COLS} FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    res.json({ campanha: mapCampanhaRow(rows[0]) });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao buscar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível buscar a campanha' });
  }
});

app.post('/api/admin/campaigns', requireAdmin, async (req, res) => {
  const { nome, descricao, templateNome, segmentoId, audienceDefinition } = req.body || {};
  const loja = lojaLegadaDoContextoOuNula();
  if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'nome é obrigatório' });
  const tamanhoLote = normalizarTamanhoLote(req.body?.tamanhoLote);
  if (tamanhoLote === undefined) return res.status(400).json({ error: 'tamanho de lote inválido' });
  const mensagemWebId = normalizarMensagemWebId(req.body?.mensagemWebId);
  if (mensagemWebId === undefined) return res.status(400).json({ error: 'mensagem inválida' });
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO campaigns (store_id, loja, nome, descricao, template_nome, segmento_id, audience_definition, status, criado_por, tamanho_lote, mensagem_web_id)
       VALUES ($10,$1,$2,$3,$4,$5,$6,'draft',$7,$8,$9) RETURNING ${CAMPAIGN_SELECT_COLS}`,
      [loja, String(nome).trim(), descricao || null, templateNome || null, segmentoId || null, JSON.stringify(audienceDefinition || {}), 'admin', tamanhoLote, mensagemWebId, storeDoContexto()]
    );
    res.json({ campanha: mapCampanhaRow(rows[0]) });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao criar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível criar a campanha' });
  }
});

app.put('/api/admin/campaigns/:id', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  const { nome, descricao, templateNome, segmentoId, audienceDefinition, status, agendadaPara } = req.body || {};
  if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'nome é obrigatório' });
  const novoStatus = status === 'scheduled' ? 'scheduled' : 'draft';
  if (novoStatus === 'scheduled' && !agendadaPara) return res.status(400).json({ error: 'data de agendamento obrigatória' });
  const tamanhoLote = normalizarTamanhoLote(req.body?.tamanhoLote);
  if (tamanhoLote === undefined) return res.status(400).json({ error: 'tamanho de lote inválido' });
  const mensagemWebId = normalizarMensagemWebId(req.body?.mensagemWebId);
  if (mensagemWebId === undefined) return res.status(400).json({ error: 'mensagem inválida' });
  try {
    const atual = await pgPool.query('SELECT status FROM campaigns WHERE id = $1', [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    if (!CAMPAIGN_STATUS_EDITAVEL.has(atual.rows[0].status)) {
      return res.status(409).json({ error: 'campanha já iniciada não pode ser editada' });
    }
    const { rows } = await pgPool.query(
      `UPDATE campaigns SET nome=$1, descricao=$2, template_nome=$3, segmento_id=$4, audience_definition=$5,
         status=$6, agendada_para=$7, tamanho_lote=$8, mensagem_web_id=$10, atualizado_em=now()
       WHERE id=$9 RETURNING ${CAMPAIGN_SELECT_COLS}`,
      [String(nome).trim(), descricao || null, templateNome || null, segmentoId || null, JSON.stringify(audienceDefinition || {}),
        novoStatus, novoStatus === 'scheduled' ? agendadaPara : null, tamanhoLote, req.params.id, mensagemWebId]
    );
    res.json({ campanha: mapCampanhaRow(rows[0]) });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao editar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível editar a campanha' });
  }
});

// Cancelamento de campanha ainda em draft/scheduled = imediato (spec, Parte 39) — remove de vez.
// Cancelamento de campanha JÁ EM ENVIO é outra operação (Fase 5: para novos jobs, mantém
// histórico, nunca deleta) — por isso o guard de status aqui, igual o PUT.
app.delete('/api/admin/campaigns/:id', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  try {
    const atual = await pgPool.query('SELECT status FROM campaigns WHERE id = $1', [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    if (!CAMPAIGN_STATUS_EDITAVEL.has(atual.rows[0].status)) {
      return res.status(409).json({ error: 'campanha já iniciada não pode ser cancelada por aqui' });
    }
    await pgPool.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao cancelar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível cancelar a campanha' });
  }
});

// Duplicar (spec, Parte 40): copia definição, nunca copia recipients/métricas/status — nova
// campanha sempre nasce draft.
app.post('/api/admin/campaigns/:id/duplicate', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  try {
    const { rows } = await pgPool.query(`SELECT ${CAMPAIGN_SELECT_COLS} FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    const original = rows[0];
    const { rows: novaRows } = await pgPool.query(
      `INSERT INTO campaigns (store_id, loja, nome, descricao, template_nome, segmento_id, audience_definition, status, criado_por, tamanho_lote, mensagem_web_id)
       VALUES ($10,$1,$2,$3,$4,$5,$6,'draft',$7,$8,$9) RETURNING ${CAMPAIGN_SELECT_COLS}`,
      [original.loja, `${original.nome} (cópia)`, original.descricao, original.template_nome, original.segmento_id,
        JSON.stringify(original.audience_definition || {}), 'admin', original.tamanho_lote, original.mensagem_web_id, original.store_id || storeDoContexto()]
    );
    res.json({ campanha: mapCampanhaRow(novaRows[0]) });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao duplicar campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível duplicar a campanha' });
  }
});

// ── Disparo de campanha (Fase 5/6 do plano) ─────────────────────────────
// Resolve o valor real de uma fonte de variável (spec, Parte 13) pro cliente elegível — mesmas
// fontes oferecidas no mapeamento do wizard (NovaCampanhaPage.tsx, VARIAVEL_FONTES). "fixo" é
// texto literal igual pra todo mundo; o resto vem de buscarClientesAgregados (dado real).
function resolverVariavelCampanha(cliente, fonte, valorFixo) {
  switch (fonte) {
    case 'cliente.primeiroNome': return String(cliente.nome || '').trim().split(/\s+/)[0] || '';
    case 'cliente.nomeCompleto': return cliente.nome || '';
    case 'cliente.quantidadePedidos': return String(cliente.totalCompras ?? '');
    case 'cliente.totalGasto': return cliente.totalGasto != null ? `R$ ${Number(cliente.totalGasto).toFixed(2)}` : '';
    case 'cliente.ticketMedio': return cliente.ticketMedio != null ? `R$ ${Number(cliente.ticketMedio).toFixed(2)}` : '';
    case 'cliente.ultimaCompraEm': return formatarDataBr(cliente.ultimaCompraEm);
    case 'fixo': return valorFixo || '';
    default: return '';
  }
}

// Snapshot dos destinatários (spec, Parte 17) — reexecuta os filtros no backend e grava
// campaign_recipients de uma vez (bulk insert via UNNEST, não 1 INSERT por cliente). Chamada
// tanto pelo endpoint /start (envio imediato) quanto pelo job periódico quando uma campanha
// agendada chega na hora — nos dois casos a campanha só pode estar em 'draft' ou 'scheduled'
// (nunca reprocessa uma campanha que já tem recipients, por isso o guard de status no chamador).
// Variáveis nomeadas de campanha no modo WhatsApp Web — mesmo dado real de
// resolverVariavelCampanha, só que com o nome direto no texto ({{cliente.primeiro_nome}}).
function variaveisCampanhaWeb(cliente, loja) {
  return {
    'cliente.primeiro_nome': resolverVariavelCampanha(cliente, 'cliente.primeiroNome'),
    'cliente.nome': resolverVariavelCampanha(cliente, 'cliente.nomeCompleto'),
    'cliente.email': cliente.email || '',
    'cliente.telefone': cliente.telefone || '',
    'cliente.quantidade_pedidos': resolverVariavelCampanha(cliente, 'cliente.quantidadePedidos'),
    'cliente.total_gasto': resolverVariavelCampanha(cliente, 'cliente.totalGasto'),
    'cliente.ticket_medio': resolverVariavelCampanha(cliente, 'cliente.ticketMedio'),
    'cliente.ultima_compra': resolverVariavelCampanha(cliente, 'cliente.ultimaCompraEm'),
    'loja.nome': LOJAS[loja] || loja,
  };
}

async function iniciarDisparoCampanha(campanha) {
  const def = campanha.audience_definition || {};
  // O provider no momento do início decide o canal da campanha inteira: Web congela o texto da
  // mensagem própria; API exige template. Vale igual pro "Enviar agora" e pro agendamento.
  const { provider } = await readWhatsappProviderConfig();
  const modoWeb = provider === 'whatsapp_web';
  let mensagemWeb = null;
  if (modoWeb) {
    mensagemWeb = await buscarMensagemWeb(campanha.mensagem_web_id);
    if (!mensagemWeb) {
      const err = new Error('escolha uma mensagem do WhatsApp Web antes de iniciar a campanha');
      err.status = 400;
      throw err;
    }
    // Pedido/carrinho usam dados que não existem numa campanha (chegariam vazios).
    if (mensagemWeb.tipo !== 'campanha' && mensagemWeb.tipo !== 'comum') {
      const err = new Error('campanha só pode usar mensagem do tipo "campanha" ou "comum"');
      err.status = 400;
      throw err;
    }
  } else if (!campanha.template_nome) {
    const err = new Error('escolha um template antes de iniciar a campanha');
    err.status = 400;
    throw err;
  }

  const chaveDaCampanha = campanha.loja || campanha.store_id;
  const resultado = await avaliarAudienciaCampanha(chaveDaCampanha, def.match === 'ANY' ? 'ANY' : 'ALL', def.filtros || [], def.exclusoes || {});
  const variaveisMapa = Array.isArray(def.variaveis) ? def.variaveis : [];
  const mediaAssetId = modoWeb ? null : def.mediaAssetId || null;
  // Campos personalizados: lidos 1x por campanha (não por cliente) e interpolados com as
  // variáveis de cada destinatário.
  const camposCustomizados = modoWeb ? await readCamposCustomizados() : {};

  const customerKeys = [];
  const telefones = [];
  const nomes = [];
  const resolvedVariablesJson = [];
  for (const cliente of resultado.elegiveis) {
    const vars = {};
    if (modoWeb) {
      Object.assign(vars, variaveisCampanhaWeb(cliente, chaveDaCampanha));
      for (const chave of Object.keys(camposCustomizados)) {
        const bruto = (camposCustomizados[chave].valores && camposCustomizados[chave].valores[chaveDaCampanha]) || '';
        vars[`custom.${chave}`] = interpolarCampoCustomizado(bruto, vars);
      }
    }
    for (const v of (modoWeb ? [] : variaveisMapa)) {
      // Chaves reservadas (nunca colidem com token numérico de corpo, ex: "1", "2") pro valor do
      // cabeçalho de texto e do botão de URL dinâmica — cada template só tem no máximo 1 de cada,
      // diferente do corpo que pode ter vários tokens.
      const chave = v.alvo === 'header' ? '__header__' : v.alvo === 'botao' ? '__botao__' : String(v.indice);
      vars[chave] = resolverVariavelCampanha(cliente, v.fonte, v.variavelFixa);
    }
    customerKeys.push(cliente.customerKey);
    telefones.push(cliente.telefone || null);
    nomes.push(cliente.nome || null);
    resolvedVariablesJson.push(JSON.stringify(vars));
  }

  if (!customerKeys.length) {
    const err = new Error('campanha sem destinatários elegíveis');
    err.status = 400;
    throw err;
  }

  await pgPool.query(
    `INSERT INTO campaign_recipients (campaign_id, customer_key, telefone, nome, resolved_variables, media_asset_id)
     SELECT $1, x.customer_key, x.telefone, x.nome, x.resolved_variables::jsonb, $2
     FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) AS x(customer_key, telefone, nome, resolved_variables)
     ON CONFLICT (organization_id, campaign_id, customer_key) DO NOTHING`,
    [campanha.id, mediaAssetId, customerKeys, telefones, nomes, resolvedVariablesJson]
  );

  // 1º lote já sai liberado (tamanho_lote NULL = todos de uma vez, comportamento de antes); o
  // restante fica no snapshot com lote NULL, aguardando o admin liberar pela tela da campanha.
  const { liberados: primeiroLote } = await liberarLoteCampanha(campanha.id, campanha.tamanho_lote || null);

  await pgPool.query(
    `UPDATE campaigns SET status='preparing', total_matched=$1, total_excluded=$2, total_recipients=$3,
       mensagem_web_corpo=$5, mensagem_web_variacoes=$6, iniciada_em=now(), atualizado_em=now() WHERE id=$4`,
    [resultado.matched, resultado.excluded, customerKeys.length, campanha.id, mensagemWeb ? mensagemWeb.corpo : null,
      mensagemWeb ? JSON.stringify(mensagemWeb.variacoes || []) : null]
  );

  return { totalRecipients: customerKeys.length, primeiroLote };
}

// Envio imediato ("Enviar agora"): só quem está em 'draft' pode iniciar por aqui — campanha
// 'scheduled' é iniciada pelo job periódico quando a hora chega (spec, Parte 38/45: nunca
// enviar em loop síncrono na request, aqui só cria o snapshot; quem realmente dispara pra Meta
// é processarFilaDeCampanhas).
app.post('/api/admin/campaigns/:id/start', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  try {
    const atual = await pgPool.query(`SELECT ${CAMPAIGN_SELECT_COLS} FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    const campanha = atual.rows[0];
    if (campanha.status !== 'draft') return res.status(409).json({ error: 'só é possível iniciar uma campanha em rascunho' });
    const { totalRecipients, primeiroLote } = await iniciarDisparoCampanha(campanha);
    res.json({ ok: true, totalRecipients, primeiroLote });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao iniciar campanha: ${err.message}`);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'não foi possível iniciar a campanha' });
  }
});

// ── Envio em lotes ──────────────────────────────────────────────────────
// O snapshot inteiro (campaign_recipients) nasce no /start, mas o job de envio só pega quem já
// foi LIBERADO num lote (lote IS NOT NULL). Quando o lote liberado acaba e ainda sobra gente
// aguardando, a campanha vai pra 'paused' sozinha — o admin avalia entregas/leituras e libera o
// próximo. Tudo fica no Postgres: sair da tela, fechar o navegador ou reiniciar o servidor não
// perde o que falta, e ninguém recebe 2x (status pending -> queued -> sent é de mão única e o lote
// só libera quem ainda está 'pending' sem lote).
const CAMPAIGN_STATUS_EM_ENVIO = new Set(['preparing', 'sending', 'paused']);

// undefined = inválido (400); null = "todos de uma vez".
function normalizarTamanhoLote(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 100000) return undefined;
  return n;
}

// Libera os próximos `tamanho` destinatários ainda não liberados (null = todos os restantes) com o
// próximo número de lote. Transação com lock na linha da campanha: 2 cliques/requests simultâneos
// não geram o mesmo número de lote nem liberam a mesma pessoa 2x.
async function liberarLoteCampanha(campanhaId, tamanho) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM campaigns WHERE id = $1 FOR UPDATE', [campanhaId]);
    const { rows } = await client.query(
      'SELECT COALESCE(MAX(lote), 0) + 1 AS proximo FROM campaign_recipients WHERE campaign_id = $1',
      [campanhaId]
    );
    const proximo = Number(rows[0].proximo);
    const { rowCount } = await client.query(
      `UPDATE campaign_recipients SET lote = $2, atualizado_em = now()
       WHERE id IN (
         SELECT id FROM campaign_recipients
         WHERE campaign_id = $1 AND lote IS NULL AND status = 'pending'
         ORDER BY id ASC LIMIT $3
       )`,
      [campanhaId, proximo, tamanho]
    );
    await client.query('COMMIT');
    return { lote: rowCount ? proximo : null, liberados: rowCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Libera o próximo lote (body: { tamanho: number | null }). Numa campanha pausada, liberar lote
// também retoma o envio — é o fluxo normal "lote acabou -> avaliei -> manda o próximo".
app.post('/api/admin/campaigns/:id/batches', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  const tamanho = normalizarTamanhoLote(req.body?.tamanho);
  if (tamanho === undefined) return res.status(400).json({ error: 'tamanho de lote inválido' });
  try {
    const atual = await pgPool.query('SELECT status FROM campaigns WHERE id = $1', [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ error: 'campanha não encontrada' });
    if (!CAMPAIGN_STATUS_EM_ENVIO.has(atual.rows[0].status)) {
      return res.status(409).json({ error: 'só é possível liberar lote de campanha em envio ou pausada' });
    }
    const { lote, liberados } = await liberarLoteCampanha(req.params.id, tamanho);
    if (!liberados) return res.status(409).json({ error: 'não há destinatários aguardando liberação' });
    await pgPool.query(`UPDATE campaigns SET status = 'sending', atualizado_em = now() WHERE id = $1 AND status = 'paused'`, [req.params.id]);
    res.json({ ok: true, lote, liberados });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao liberar lote da campanha ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: 'não foi possível liberar o lote' });
  }
});

// Pausa manual: o job para de pegar destinatários dessa campanha no próximo tick (o que já estava
// em 'queued' no tick corrente termina normalmente). Liberados e não liberados continuam intactos.
app.post('/api/admin/campaigns/:id/pause', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  try {
    const { rowCount } = await pgPool.query(
      `UPDATE campaigns SET status = 'paused', atualizado_em = now() WHERE id = $1 AND status IN ('preparing', 'sending')`,
      [req.params.id]
    );
    if (!rowCount) return res.status(409).json({ error: 'só é possível pausar uma campanha em envio' });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao pausar campanha ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: 'não foi possível pausar a campanha' });
  }
});

app.post('/api/admin/campaigns/:id/resume', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  try {
    const { rows } = await pgPool.query(
      `SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending' AND lote IS NOT NULL`,
      [req.params.id]
    );
    if (Number(rows[0].n) === 0) {
      return res.status(409).json({ error: 'nenhum destinatário liberado aguardando envio — libere um novo lote' });
    }
    const { rowCount } = await pgPool.query(
      `UPDATE campaigns SET status = 'sending', atualizado_em = now() WHERE id = $1 AND status = 'paused'`,
      [req.params.id]
    );
    if (!rowCount) return res.status(409).json({ error: 'só é possível retomar uma campanha pausada' });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao retomar campanha ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: 'não foi possível retomar a campanha' });
  }
});

// Mascara telefone pra exibição na tabela de destinatários (spec Parte 24: "Telefone mascarado")
// — nunca o número completo cru, mesmo pro admin autenticado. Mantém DDD e os 4 últimos dígitos.
function mascararTelefone(telefone) {
  if (!telefone) return null;
  const digitos = String(telefone).replace(/\D/g, '');
  if (digitos.length < 6) return '****';
  const inicio = digitos.slice(0, digitos.length - 8);
  const fim = digitos.slice(-4);
  return `${inicio ? `+${inicio} ` : ''}*****-${fim}`;
}

// Pedidos/receita atribuídos à campanha (regra em lib/campanhas/atribuicao.js: último toque de
// mensagem, janela de `janelaDias` dias). Lê só o necessário: envios desta campanha, pedidos pagos
// da loja entre o 1º envio e o fim da janela do último, e envios de OUTRAS campanhas da loja no
// mesmo intervalo (pra não contar o mesmo pedido em duas campanhas).
async function calcularAtribuicaoCampanha(campanha, janelaDias) {
  const { rows: envios } = await pgPool.query(
    `SELECT lote, sent_at, telefone, customer_key FROM campaign_recipients
      WHERE campaign_id = $1 AND sent_at IS NOT NULL`,
    [campanha.id]
  );
  if (!envios.length) return { pedidos: 0, receita: 0, porLote: new Map() };

  const desde = envios.reduce((min, e) => (e.sent_at < min ? e.sent_at : min), envios[0].sent_at);
  const ultimo = envios.reduce((max, e) => (e.sent_at > max ? e.sent_at : max), envios[0].sent_at);
  const ate = new Date(ultimo.getTime() + janelaDias * 86400000);
  const [pedidosRes, outrosRes] = await Promise.all([
    pgPool.query(
      `SELECT ink_order_id, criado_em, total_value, buyer_telefone, buyer_documento, buyer_email
         FROM pedidos_ink
        WHERE organization_id = $1 AND ${escopoDaStore(2).sql}
          AND payment_status = ANY($${2 + escopoDaStore(2).usados}) AND is_troca IS NOT TRUE
          AND criado_em >= $${3 + escopoDaStore(2).usados} AND criado_em <= $${4 + escopoDaStore(2).usados}`,
      [orgDoContexto(), ...escopoDaStore(2).params, Array.from(PAYMENT_STATUSES_CONVERTIDO), desde, ate]
    ),
    pgPool.query(
      `SELECT r.sent_at, r.telefone, r.customer_key
         FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
        WHERE (c.store_id = $1 OR (c.store_id IS NULL AND c.loja = $5))
          AND r.campaign_id <> $2 AND r.sent_at > $3 AND r.sent_at <= $4`,
      [campanha.store_id || null, campanha.id, desde, ate, campanha.loja || null]
    ),
  ]);
  const mapaEnvio = (e) => ({ lote: e.lote, sentAt: e.sent_at, telefone: e.telefone, customerKey: e.customer_key });
  return atribuicaoCampanha.atribuirPedidosCampanha({
    envios: envios.map(mapaEnvio),
    outrosEnvios: outrosRes.rows.map(mapaEnvio),
    pedidos: pedidosRes.rows.map((p) => ({
      inkOrderId: p.ink_order_id, criadoEm: p.criado_em, valor: p.total_value,
      telefone: p.buyer_telefone, documento: p.buyer_documento, email: p.buyer_email,
    })),
    janelaDias,
  });
}

// Detalhe/Relatório da campanha (spec, Parte 24) — cards/funil agregados numa query só sobre
// campaign_recipients, mais pedidos/receita atribuídos (calcularAtribuicaoCampanha). `janelaDias`
// na query string é a janela escolhida no painel; fora da lista permitida, vale o padrão.
app.get('/api/admin/campaigns/:id/summary', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  try {
    const campanhaRows = await pgPool.query(`SELECT ${CAMPAIGN_SELECT_COLS} FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!campanhaRows.rows.length) return res.status(404).json({ error: 'campanha não encontrada' });

    const { rows } = await pgPool.query(
      `SELECT
         COUNT(*) AS destinatarios,
         COUNT(*) FILTER (WHERE sent_at IS NOT NULL) AS enviados,
         COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS entregues,
         COUNT(*) FILTER (WHERE read_at IS NOT NULL) AS lidos,
         COUNT(*) FILTER (WHERE status = 'failed') AS falhas,
         COALESCE(SUM(click_count), 0) AS cliques,
         COUNT(*) FILTER (WHERE status = 'pending' AND lote IS NULL) AS aguardando_liberacao,
         COUNT(*) FILTER (WHERE status IN ('pending', 'queued') AND lote IS NOT NULL) AS na_fila
       FROM campaign_recipients WHERE campaign_id = $1`,
      [req.params.id]
    );
    // Métricas por lote — é o que permite avaliar entrega/leitura de um lote antes de liberar o próximo.
    const { rows: loteRows } = await pgPool.query(
      `SELECT
         lote,
         COUNT(*) AS destinatarios,
         COUNT(*) FILTER (WHERE sent_at IS NOT NULL) AS enviados,
         COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS entregues,
         COUNT(*) FILTER (WHERE read_at IS NOT NULL) AS lidos,
         COUNT(*) FILTER (WHERE status = 'failed') AS falhas,
         COALESCE(SUM(click_count), 0) AS cliques,
         COUNT(*) FILTER (WHERE status IN ('pending', 'queued')) AS nao_enviados
       FROM campaign_recipients WHERE campaign_id = $1 AND lote IS NOT NULL
       GROUP BY lote ORDER BY lote ASC`,
      [req.params.id]
    );
    const r = rows[0];
    const janelaDias = atribuicaoCampanha.janelaDiasValida(req.query.janelaDias);
    const atribuicao = await calcularAtribuicaoCampanha(campanhaRows.rows[0], janelaDias);
    const doLote = (lote) => atribuicao.porLote.get(lote) || { pedidos: 0, receita: 0 };
    res.json({
      campanha: mapCampanhaRow(campanhaRows.rows[0]),
      resumo: {
        destinatarios: Number(r.destinatarios), enviados: Number(r.enviados), entregues: Number(r.entregues),
        lidos: Number(r.lidos), falhas: Number(r.falhas), cliques: Number(r.cliques),
        aguardandoLiberacao: Number(r.aguardando_liberacao), naFila: Number(r.na_fila),
        lotes: loteRows.map((l) => ({
          lote: Number(l.lote), destinatarios: Number(l.destinatarios), enviados: Number(l.enviados),
          entregues: Number(l.entregues), lidos: Number(l.lidos), falhas: Number(l.falhas),
          cliques: Number(l.cliques), naoEnviados: Number(l.nao_enviados),
          pedidos: doLote(Number(l.lote)).pedidos, receita: doLote(Number(l.lote)).receita,
        })),
        pedidos: atribuicao.pedidos, receita: atribuicao.receita,
        janelaAtribuicaoDias: janelaDias,
      },
    });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao buscar resumo da campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível buscar o resumo da campanha' });
  }
});

const CAMPANHA_RECIPIENTS_FILTROS = {
  enviados: `sent_at IS NOT NULL`,
  entregues: `delivered_at IS NOT NULL`,
  lidos: `read_at IS NOT NULL`,
  falhas: `status = 'failed'`,
  clicados: `click_count > 0`,
  nao_enviados: `status IN ('pending', 'queued')`,
};

// Tabela de destinatários paginada server-side (spec Parte 24/29 — nunca devolver tudo de uma
// vez). `status` no query string é um dos filtros de CAMPANHA_RECIPIENTS_FILTROS acima; ausente
// ou desconhecido = "Todos".
app.get('/api/admin/campaigns/:id/recipients', requireAdmin, exigirRecurso('campaigns'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'campanhas exigem Postgres configurado' });
  try {
    const pagina = Math.max(1, parseInt(req.query.page, 10) || 1);
    const porPagina = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset = (pagina - 1) * porPagina;
    const filtroSql = CAMPANHA_RECIPIENTS_FILTROS[req.query.status] || null;
    const where = `campaign_id = $1${filtroSql ? ` AND ${filtroSql}` : ''}`;

    const [{ rows: totalRows }, { rows }] = await Promise.all([
      pgPool.query(`SELECT COUNT(*) AS total FROM campaign_recipients WHERE ${where}`, [req.params.id]),
      pgPool.query(
        `SELECT id, nome, telefone, status, lote, sent_at, delivered_at, read_at, failed_at, failure_message, click_count, criado_em
         FROM campaign_recipients WHERE ${where} ORDER BY criado_em DESC, id DESC LIMIT $2 OFFSET $3`,
        [req.params.id, porPagina, offset]
      ),
    ]);

    res.json({
      total: Number(totalRows[0].total),
      page: pagina,
      pageSize: porPagina,
      destinatarios: rows.map((r) => ({
        id: String(r.id), nome: r.nome, telefoneMascarado: mascararTelefone(r.telefone), status: r.status, lote: r.lote,
        sentAt: r.sent_at, deliveredAt: r.delivered_at, readAt: r.read_at, failedAt: r.failed_at,
        failureMessage: r.failure_message, cliques: r.click_count, criadoEm: r.criado_em,
      })),
    });
  } catch (err) {
    console.error(`[CAMPANHAS] falha ao listar destinatários da campanha: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar os destinatários' });
  }
});

// Saúde das integrações: status de configuração por loja (Reserva Ink) + status do WhatsApp
// (o webhook de status sent/delivered/read existe a partir daqui — ver /api/webhooks/whatsapp;
// falta configurar WEBHOOK_FORWARD_URL no serviço Go pra ele de fato repassar os eventos).
// Nome da Store do contexto, para exibição. O contexto carrega o id; o nome é dado de tela.
async function nomeDaStoreDoContexto() {
  if (!pgPool) return null;
  const { rows } = await pgPool.query('SELECT nome FROM stores WHERE id = $1', [storeDoContexto()]);
  return rows.length ? rows[0].nome : null;
}

// UMA linha, sempre: a Organization tem exatamente uma Store (1:1, PD-002). A linha é da STORE,
// identificada por `storeId` — não pela chave legada. Store nativa do Oria tem `loja: null`, e isso
// não impede nada: quem diz se a Ink está configurada é a integração da Organization.
async function statusDaIntegracaoInk() {
  return [{
    storeId: storeDoContexto(),
    loja: lojaLegadaDoContextoOuNula(),
    nome: await nomeDaStoreDoContexto(),
    tokenConfigurado: await inkConectada(),
    // Fase 5c: webhook configurado = URL opaca emitida + segredo guardado na integração.
    webhookConfigurado: await inkWebhookConfigurado(),
  }];
}

// Lê os FATOS de cada provider e entrega ao read model. Cada leitura é isolada: uma que falha vira
// `error` só para aquele provider (nunca "não configurado", que seria mentira) e não derruba as outras.
async function lerIntegracoesParaTela({ inkConectada, inkWebhook, whatsappServicoConfigurado }) {
  let plano = null;
  try { plano = await planoEfetivo(PLANO_DA_ORGANIZACAO); } catch { plano = null; }
  // Plano ilegível é "não sei", não "negado": a decisão de bloquear é de quem usa a rota, não da leitura.
  const entitled = (feature) => (plano && typeof plano === 'object' ? plano[feature] === true : null);
  const expirado = (data) => !!data && new Date(data).getTime() < Date.now();
  const isolar = async (provider, ler) => {
    try {
      return await ler();
    } catch (err) {
      console.error(`[INTEGRACOES] leitura de ${provider} falhou: ${mascararToken(String(err && err.message))}`);
      return linhaComFalha(provider);
    }
  };

  const linhas = [];
  linhas.push(await isolar('ink', async () => linhaDoProvider('ink', {
    entitled: null, platformAvailable: true, configured: inkConectada, connected: inkConectada,
  }, { api: inkConectada ? 'connected' : 'not_configured', webhook: inkWebhook ? 'connected' : 'deferred' })));

  linhas.push(await isolar('ga4', async () => {
    const row = await obterConexaoGA4();
    const conectado = !!row && row.status !== 'disconnected' && row.status !== 'error';
    return linhaDoProvider('ga4', {
      entitled: entitled('analytics_ga4'), platformAvailable: googleOAuthConfigurado(),
      configured: !!row && row.status !== 'disconnected', connected: conectado, needsResource: conectado && !row.property_id,
      hasData: conectado && !!row.last_sync_at, failing: row && row.status === 'error' ? 'error' : null,
    });
  }));

  linhas.push(await isolar('meta_ads', async () => {
    const conexao = await obterConexaoMeta();
    const temToken = !!conexao && conexao.status !== 'disconnected' && (await exigirIntegracoes().temSegredo('meta', 'access_token'));
    const { rows: contas } = pgPool ? await pgPool.query('SELECT * FROM meta_ad_accounts') : { rows: [] };
    const daStore = contas.filter((c) => c.selecionada && contaAtribuidaAEstaStore(c));
    return linhaDoProvider('meta_ads', {
      entitled: entitled('meta_ads'), platformAvailable: metaOAuthConfigurado(),
      configured: temToken, connected: temToken && conexao.status !== 'error', needsResource: temToken && daStore.length === 0,
      hasData: !!conexao && !!conexao.last_successful_sync_at && daStore.length > 0,
      failing: conexao && (conexao.status === 'error' || conexao.status === 'expired' || expirado(conexao.token_expires_at)) ? 'error' : null,
    });
  }));

  linhas.push(await isolar('google_ads', async () => {
    const conexao = await obterConexaoGoogleAds();
    const temToken = !!conexao && conexao.status !== 'disconnected' && (await exigirIntegracoes().temSegredo('google_ads', 'refresh_token'));
    const { rows: contas } = pgPool ? await pgPool.query('SELECT * FROM google_ads_customers') : { rows: [] };
    const daStore = contas.filter((c) => c.selecionada && contaAtribuidaAEstaStore(c));
    return linhaDoProvider('google_ads', {
      entitled: entitled('google_ads'), platformAvailable: googleAdsOAuthConfigurado(),
      configured: temToken, connected: temToken && conexao.status !== 'error', needsResource: temToken && daStore.length === 0,
      hasData: !!conexao && !!conexao.last_successful_sync_at && daStore.length > 0,
      failing: conexao && conexao.status === 'error' ? 'error' : null,
    });
  }));

  linhas.push(await isolar('whatsapp', async () => {
    const remetente = await remetenteWhatsappParaTela();
    const conectado = remetente.status === 'connected' && !!remetente.token;
    return linhaDoProvider('whatsapp', {
      entitled: entitled('whatsapp'), platformAvailable: whatsappServicoConfigurado,
      configured: conectado, connected: conectado, failing: remetente.status === 'error' || remetente.tokenInvalidoEm ? 'error' : null,
    }, {
      modo: remetente.conectadoVia || null,
      // Conectar clientes de fora depende da aprovação do app como Tech Provider (Business Verification
      // + App Review): adiado, e isso não é falha do número que já está conectado.
      embeddedSignup: embeddedSignupConfigurado() ? 'homologacao' : 'deferred',
    });
  }));

  linhas.push(await isolar('openai', async () => {
    const m = await exigirIntegracoes().metadata('openai');
    const conectado = m.segredos.some((x) => x.tipo === 'api_key');
    return linhaDoProvider('openai', { entitled: null, platformAvailable: true, configured: conectado, connected: conectado });
  }));

  linhas.push(linhaDoProvider('instagram', { comingSoon: true, entitled: entitled('instagram') }));
  return linhas;
}

// Tela de STATUS: abrir não pode depender de nada estar configurado, e nenhuma leitura daqui fala
// com provider externo. Handler async sem try/catch vira unhandled rejection — a requisição fica
// sem resposta e o proxy devolve 502, que foi o que aconteceu no primeiro acesso do Tenant #1.
app.get('/api/admin/integrations', requireAdmin, async (req, res) => {
  try {
    let log = [];
    if (pgPool) {
      try {
        const { rows } = await pgPool.query(
          `SELECT recebido_em AS "recebidoEm", verificado, loja FROM webhook_eventos
            WHERE organization_id = $1 AND verificado ORDER BY recebido_em DESC LIMIT 1`,
          [orgDoContexto()]
        );
        log = rows;
      } catch (err) {
        console.error(`[INTEGRACOES] falha ao ler último webhook: ${err.message}`);
      }
    } else {
      try { log = JSON.parse(fs.readFileSync(WEBHOOK_LOG_FILE, 'utf8')); } catch { log = []; }
    }

    // O último evento é da Organization (a query já filtra por ela e a Store é única); não se
    // procura mais por chave de loja.
    const ultimoEvento = log.find((e) => e.verificado) || null;
    const reservaInk = (await statusDaIntegracaoInk()).map((store) => ({
      ...store,
      ultimoEventoEm: ultimoEvento ? ultimoEvento.recebidoEm : null,
    }));

    // O que a tela chama de "Ink conectada" é a API: credencial no lugar. O webhook é outra coisa e,
    // hoje, foi ADIADO de propósito (o sistema anterior segue consumindo os eventos): a ausência dele
    // não rebaixa a integração. Nada aqui afirma que a credencial FUNCIONA — isso só o teste de
    // conexão diz, e ele é explícito (§25 do comando).
    const inkStatus = reservaInk.some((r) => r.tokenConfigurado) ? 'conectada' : 'not_configured';

    const whatsappConfigurado = !!(WHATSAPP_SERVICE_URL && WHATSAPP_API_KEY);
    let provider = WHATSAPP_PROVIDER_PADRAO.provider;
    try {
      provider = (await readWhatsappProviderConfig()).provider;
    } catch (err) {
      console.error(`[INTEGRACOES] falha ao ler provider do WhatsApp: ${err.message}`);
    }
    res.json({
      reservaInk,
      // Resumo explícito por provider: uma organization nova responde `not_configured`, e não um
      // silêncio que a tela precise adivinhar a partir de uma lista vazia.
      ink: {
        conectado: inkStatus === 'conectada',
        status: inkStatus,
        webhook: reservaInk.every((r) => r.webhookConfigurado) && reservaInk.length > 0 ? 'configurado' : 'adiado',
      },
      // Read model: UM estado por provider, derivado no servidor (lib/platform/integration-read-model.js).
      integracoes: await lerIntegracoesParaTela({ inkConectada: inkStatus === 'conectada', inkWebhook: reservaInk.every((r) => r.webhookConfigurado) && reservaInk.length > 0, whatsappServicoConfigurado: whatsappConfigurado }),
      whatsapp: {
        // Configurado = variáveis de ambiente presentes; conectividade real (o serviço está de
        // pé agora) é responsabilidade de /admin/whatsapp (GET /api/admin/whatsapp/visao-geral).
        conectado: whatsappConfigurado,
        observacao: whatsappConfigurado ? null : 'WHATSAPP_SERVICE_URL/WHATSAPP_API_KEY não configurados neste ambiente.',
        status: whatsappConfigurado ? 'configurado' : 'not_configured',
        provider,
      },
    });
  } catch (err) {
    console.error(`[INTEGRACOES] falha ao montar a visão de integrações: ${mascararToken(String(err && err.message))}`);
    res.status(500).json({ error: 'não foi possível ler o estado das integrações' });
  }
});

// ── Integrações: credencial manual da Ink e teste de conexão (Fase 4) ─────────────────────
// A Ink continua com credencial manual (PD-006 aberto). Só owner grava ou apaga; ninguém lê o valor
// de volta — a tela vê conectado/last4/validade.
const INK_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;

function urlDeFeedInkValida(valor) {
  try {
    const u = new URL(String(valor));
    // Só https e só domínio da Reserva Ink: o servidor baixa esta URL (sem SSRF para rede interna).
    return u.protocol === 'https:' && (u.hostname === 'reserva.ink' || u.hostname.endsWith('.reserva.ink'));
  } catch {
    return false;
  }
}

function responderErroIntegracao(res, err, rotulo) {
  if (err instanceof IntegracaoError || err instanceof RemetenteError || err instanceof EmbeddedSignupError) return res.status(err.status).json({ error: err.message, codigo: err.codigo });
  console.error(`[INTEGRACOES] ${rotulo}: ${mascararToken(String(err && err.message))}`);
  return res.status(500).json({ error: 'não foi possível concluir a operação da integração' });
}

async function inkWebhookConfigurado() {
  if (!INTEGRACOES) return false;
  const m = await INTEGRACOES.metadata('ink');
  return !!m.config.webhook_token_sha256 && m.segredos.some((x) => x.tipo === 'webhook_secret');
}

function webhookInkParaTela(m) {
  return {
    urlEmitida: typeof m.config.webhook_token_sha256 === 'string',
    urlEmitidaEm: typeof m.config.webhook_token_criado_em === 'string' ? m.config.webhook_token_criado_em : null,
    segredoCadastrado: m.segredos.some((x) => x.tipo === 'webhook_secret'),
  };
}

app.get('/api/admin/integrations/ink/credenciais', requireAdmin, async (req, res) => {
  try {
    const m = await exigirIntegracoes().metadata('ink');
    res.json({ status: m.status, segredos: m.segredos, viaEnvLegado: m.viaEnvLegado, webhook: webhookInkParaTela(m) });
  } catch (err) {
    responderErroIntegracao(res, err, 'ler credenciais Ink');
  }
});

app.put('/api/admin/integrations/ink/credenciais', requireAdmin, (req, res, next) => TENANT.requireOwner(req, res, next), async (req, res) => {
  const corpo = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const extras = Object.keys(corpo).filter((k) => !['apiToken', 'feedUrl', 'webhookSecret'].includes(k));
  if (extras.length) return res.status(400).json({ error: `campos não aceitos: ${extras.join(', ')}` });
  const { apiToken, feedUrl, webhookSecret } = corpo;
  if (apiToken === undefined && feedUrl === undefined && webhookSecret === undefined) {
    return res.status(400).json({ error: 'informe apiToken, feedUrl e/ou webhookSecret' });
  }
  if (webhookSecret !== undefined && (typeof webhookSecret !== 'string' || !INK_SEGREDO_WEBHOOK_RE.test(webhookSecret.trim()))) {
    return res.status(400).json({ error: 'segredo do webhook em formato inválido' });
  }
  if (apiToken !== undefined && (typeof apiToken !== 'string' || !INK_TOKEN_RE.test(apiToken.trim()))) {
    return res.status(400).json({ error: 'token da Ink em formato inválido' });
  }
  if (feedUrl !== undefined && !urlDeFeedInkValida(feedUrl)) {
    return res.status(400).json({ error: 'URL do feed inválida (use a URL https da Reserva Ink)' });
  }
  try {
    // TUDO numa transação: segredos, status da integração e auditoria. Se a auditoria falhar, o
    // segredo não fica gravado — a resposta e o banco contam a mesma história.
    //
    // A identidade é `organization_id` + `store_id`. A chave legada não entra: Store nativa do
    // Oria não tem uma, e exigi-la aqui era o que impedia um cliente novo de conectar a Ink.
    const m = await exigirIntegracoes().emTransacao(async (tx, cliente) => {
      if (apiToken !== undefined) await tx.gravarSegredo('ink', 'api_token', apiToken.trim());
      if (feedUrl !== undefined) await tx.gravarSegredo('ink', 'feed_url', String(feedUrl).trim());
      if (webhookSecret !== undefined) await tx.gravarSegredo('ink', 'webhook_secret', webhookSecret.trim());
      await registrarAuditoriaEm(cliente, {
        criadoEm: new Date().toISOString(),
        actorUserId: req.auth.userId,
        action: 'integration.credentials.update',
        entityType: 'integration',
        entityId: 'ink',
        organizationId: orgDoContexto(),
        loja: lojaLegadaDoContextoOuNula(),
        after: {
          storeId: storeDoContexto(),
          campos: [apiToken !== undefined && 'apiToken', feedUrl !== undefined && 'feedUrl', webhookSecret !== undefined && 'webhookSecret'].filter(Boolean),
        },
      });
      return tx.metadata('ink');
    });
    res.json({ status: m.status, segredos: m.segredos, webhook: webhookInkParaTela(m) });
  } catch (err) {
    responderErroIntegracao(res, err, 'gravar credenciais Ink');
  }
});

app.delete('/api/admin/integrations/ink/credenciais', requireAdmin, (req, res, next) => TENANT.requireOwner(req, res, next), async (req, res) => {
  try {
    // A Ink não tem revogação remota de token: a invalidação é local e explícita. A URL do webhook
    // (posse do token) sai junto com os segredos.
    const integracoes = exigirIntegracoes();
    const { apagados } = await integracoes.desconectar('ink');
    await integracoes.gravarConfig('ink', {});
    await registrarAuditLog({
      actorUserId: req.auth.userId, action: 'integration.disconnect', entityType: 'integration', entityId: 'ink',
      loja: lojaLegadaDoContextoOuNula(), after: { storeId: storeDoContexto(), segredosApagados: apagados },
    });
    res.json({ ok: true, apagados });
  } catch (err) {
    responderErroIntegracao(res, err, 'desconectar Ink');
  }
});

// URL do webhook da Ink (Fase 5c · TD-005). Um token de 256 bits por integração; só o SHA-256 dele
// é guardado (posse exclusiva em external_resource_claims + config para a tela). Gerar de novo
// invalida a URL anterior. O caminho volta UMA vez, nesta resposta.
const INK_SEGREDO_WEBHOOK_RE = /^[\x21-\x7e]{8,512}$/;
const INK_WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const hashDoTokenInk = (token) => crypto.createHash('sha256').update(token).digest('hex');

app.post('/api/admin/integrations/ink/webhook-url', requireAdmin, (req, res, next) => TENANT.requireOwner(req, res, next), async (req, res) => {
  try {
    const integracoes = exigirIntegracoes();
    const antes = await integracoes.metadata('ink');
    const token = gerarRouteTokenWebhook();
    const hash = hashDoTokenInk(token);
    await integracoes.liberarRecursos('ink', 'webhook_token');
    await integracoes.reivindicarRecurso('ink', 'webhook_token', hash);
    const criadoEm = new Date().toISOString();
    await integracoes.gravarConfig('ink', { ...antes.config, webhook_token_sha256: hash, webhook_token_criado_em: criadoEm });
    await registrarAuditLog({
      actorUserId: req.auth.userId, action: 'integration.webhook_url.rotate', entityType: 'integration', entityId: 'ink',
      loja: lojaLegadaDoContextoOuNula(), after: { storeId: storeDoContexto(), substituiuAnterior: !!antes.config.webhook_token_sha256 },
    });
    res.set('Cache-Control', 'no-store');
    res.json({ caminho: `/api/webhooks/ink/${token}`, criadoEm });
  } catch (err) {
    responderErroIntegracao(res, err, 'gerar URL do webhook Ink');
  }
});

// Teste de conexão padronizado: Organization do contexto → integração → segredo → chamada mínima.
// A resposta traz só status e um código; nunca o erro bruto do provider (pode ecoar token/URL).
const TESTES_DE_CONEXAO = {
  ink: async () => {
    await inkApiRequestDaStore('/v1/stores/orders?per_page=1');
    return {};
  },
  meta: async () => {
    const r = await comTokenMeta(async (token) => {
      const url = new URL(`${META_GRAPH}/${META_GRAPH_VERSION}/me`);
      url.searchParams.set('fields', 'id');
      const proof = metaAppsecretProof(token);
      if (proof) url.searchParams.set('appsecret_proof', proof);
      return fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    });
    if (!r.ok) throw Object.assign(new Error('meta'), { codigo: `HTTP_${r.status}` });
    return {};
  },
  google_ads: async () => {
    const cliente = await googleAdsClient();
    const contas = await cliente.contasAcessiveis();
    return { contas: contas.length };
  },
  ga4: async () => {
    const token = await obterAccessTokenValidoGA4();
    return { propriedades: (await listarPropriedadesGA4(token)).length };
  },
  // WhatsApp: a Meta confere se o token da integração enxerga o número da MESMA integração.
  whatsapp: async () => {
    const r = await exigirRemetenteWhatsapp().comRemetente((remetente) => fetch(
      `${META_GRAPH}/${META_GRAPH_VERSION}/${remetente.phoneNumberId}?fields=id`,
      { headers: { Authorization: `Bearer ${remetente.accessToken}` }, signal: AbortSignal.timeout(15000) }
    ));
    if (!r.ok) throw Object.assign(new Error('whatsapp'), { codigo: `HTTP_${r.status}` });
    return {};
  },
  openai: async () => {
    const r = await cofreOpenAiDaOrganizacao(orgDoContexto()).usar((key) => testarChaveOpenAi(key));
    if (!r) throw Object.assign(new Error('openai'), { codigo: 'INTEGRATION_NOT_CONNECTED' });
    if (!r.ok) throw Object.assign(new Error('openai'), { codigo: `OPENAI_${String(r.reason).toUpperCase()}` });
    return {};
  },
};

app.post('/api/admin/integrations/:provider/teste', requireAdmin, async (req, res) => {
  const teste = Object.prototype.hasOwnProperty.call(TESTES_DE_CONEXAO, req.params.provider)
    ? TESTES_DE_CONEXAO[req.params.provider] : null;
  if (!teste) return res.status(404).json({ error: 'provider desconhecido' });
  try {
    const detalhe = await teste();
    res.json({ provider: req.params.provider, status: 'connected', detalhe });
  } catch (err) {
    const codigo = err.codigo || (err.status ? `HTTP_${err.status}` : 'PROVIDER_ERROR');
    console.warn(`[INTEGRACOES] teste ${req.params.provider} falhou: ${codigo}`);
    res.json({ provider: req.params.provider, status: 'error', codigo });
  }
});

// ── Google Analytics 4 — OAuth (Fase 2, docs/claude-utm-tracker-ga4.md §7-12) ───────────
// OAuth 2.0 (nunca Service Account), escopo só leitura. refresh_token/access_token ficam
// criptografados (AES-256-GCM) com uma chave derivada de ENCRYPTION_MASTER_KEY (HKDF, contexto
// próprio). Desde a Fase 0 (TD-004) essa chave é INDEPENDENTE de ADMIN_SESSION_SECRET: rotacionar o
// segredo de sessão não torna mais nenhuma conexão ilegível. Nenhum token sai do backend — o
// frontend só vê status/propriedade.
const GOOGLE_OAUTH_SCOPE = 'openid email https://www.googleapis.com/auth/analytics.readonly';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GA_ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
// Chamadas ao Google com timeout e retry curto (lib/google/http.js). `Leitura` repete em 429/5xx/rede —
// relatório e renovação de token só LEEM; `Unica` (troca do code de autorização, que só vale uma vez)
// nunca repete.
const googleFetchLeitura = (url, init) => fetchGoogle(url, init, { idempotente: true });
const googleFetchUnica = (url, init) => fetchGoogle(url, init, { idempotente: false });

function googleOAuthConfigurado() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_URI);
}

// ── Cifra de segredos de integração (TD-004 / B-07 · Fase 0) ────────────────────────────────
// Uma chave AES por CONTEXTO — contextos diferentes geram chaves independentes, então um token do
// Google não é decifrável com a chave da Meta. Isso não mudou. O que mudou é DE ONDE vem o material.
//
// Até 8a7ea3d, todas as chaves saíam do `ADMIN_SESSION_SECRET` por HKDF, e o comentário aqui
// registrava o efeito colateral como "aceito": rotacionar o segredo de SESSÃO tornava ilegível todo
// token de INTEGRAÇÃO gravado. O resultado prático é que o segredo de sessão nunca podia ser
// rotacionado — a chave de sessão virou refém dos tokens.
//
// Agora o material é `ENCRYPTION_MASTER_KEY`, própria e versionada (ver lib/secrets/keyring.js).
// Os CONTEXTOS continuam idênticos de propósito (lib/platform/integrations.js): mudá-los tornaria
// ilegível o que está gravado hoje.

const { createKeyring } = require('./lib/secrets/keyring');
// Mesmo motivo do try/catch de `resolveDatabaseMode`: chave malformada lança aqui, no topo.
let CHAVEIRO;
try {
  CHAVEIRO = createKeyring(process.env);
} catch (err) {
  console.error(`[SECRETS] configuração de cifra inválida: ${err.message}`);
  process.exit(1);
}

// Fail-fast em produção (TD-003 aplicado a TD-004): sem a chave mestra, toda ESCRITA de segredo
// falharia — reconectar uma integração, renovar um token — mas só na hora em que alguém tentasse.
// Descobrir isso às 3h da manhã, uma conexão por vez, é pior que não subir.
if ((process.env.NODE_ENV || '').toLowerCase() === 'production' && !CHAVEIRO.disponivel()) {
  console.error(
    '[SECRETS] ENCRYPTION_MASTER_KEY ausente. Ela é independente de ADMIN_SESSION_SECRET (TD-004) ' +
    'e obrigatória em produção. Gere com: ' +
    'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
  );
  process.exit(1);
}

// ⚠️ JANELA LEGACY, DATADA. Com ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1, a LEITURA ainda aceita a
// chave derivada de ADMIN_SESSION_SECRET (key_version 0), para que os ciphertexts já gravados em
// produção continuem legíveis até a re-cifra. ENQUANTO ESSA FLAG ESTIVER LIGADA,
// `ADMIN_SESSION_SECRET` CONTINUA SENDO MATERIAL SENSÍVEL E NÃO PODE SER ROTACIONADO.
// A escrita NUNCA usa a versão legacy. A flag sai numa release posterior à validação da re-cifra.
if (CHAVEIRO.legacyAtivo) {
  console.warn(
    '[SECRETS] leitura legacy (key_version 0, derivada de ADMIN_SESSION_SECRET) ATIVA. ' +
    'ADMIN_SESSION_SECRET não pode ser rotacionado enquanto isto valer. Janela temporária (TD-004).'
  );
}

// ── Integrações por Organization (Fase 4 · INV-12) ──────────────────────────────────────────
// Credencial do cliente (tokens Ink/Meta/Google, chave OpenAI) mora em integration_secrets, uma
// integração por (Organization, provider), e só é lida com a Organization do contexto. Credencial
// da PLATAFORMA (META_ADS_APP_*, META_APP_* do WhatsApp, GOOGLE_CLIENT_*, tokens de serviço) continua no ambiente.
const { createSecretStore } = require('./lib/secrets/store');
const { createIntegrationResolver, IntegracaoError } = require('./lib/platform/integrations');
const { createOAuthStates, OAuthStateError } = require('./lib/platform/oauth-state');
const { linhaDoProvider, linhaComFalha } = require('./lib/platform/integration-read-model');
const { fetchGoogle, erroGoogle } = require('./lib/google/http');
const { classificarErroWhatsapp } = require('./lib/whatsapp/erros');
const { EmbeddedSignupError, criarClienteEmbeddedSignup, validarEntrada: validarEntradaEmbeddedSignup, gerarPin, VERSAO_PADRAO: ES_VERSAO_PADRAO } = require('./lib/whatsapp/embedded-signup');
const {
  resolveWebhookConnection,
  gerarRouteToken: gerarRouteTokenWebhook,
  WebhookRoutingError,
} = require('./lib/platform/webhook-routing');
const { testarChave: testarChaveOpenAi } = require('./lib/creative-core/byok');
const INTEGRACOES = pgPool
  ? createIntegrationResolver({ pool: pgPool, segredos: createSecretStore({ pool: pgPool, keyring: CHAVEIRO }) })
  : null;
const OAUTH_STATES = pgPoolReal ? createOAuthStates({ poolReal: pgPoolReal }) : null;
if (INTEGRACOES && INTEGRACOES.legadoAtivo()) {
  // Janela de UMA release (OPS-24). Com a flag, a Ink de uma Organization ainda pode vir da
  // variável da loja legada da Store DELA — nunca de uma variável "global". O segundo tenant só
  // entra com a flag desligada (SECOND TENANT GATE).
  console.warn('[INTEGRACOES] ALLOW_LEGACY_INTEGRATION_ENV=1: credenciais Ink ainda podem vir de INK_*_<LOJA>. Importe (npm run integrations:import-legacy) e desligue.');
}

// Remetente WhatsApp da Organization (Fase 5b · INV-25/27/28). O painel resolve número + WABA + token
// da integração `whatsapp` da Organization do contexto e os manda ao whatsapp-webhook-go em headers
// internos. WHATSAPP_SENDER_REF_SECRET assina a referência que o Go guarda para envios posteriores
// (fila, retry); WHATSAPP_SENDER_RESOLVER_KEY é a chave que o Go apresenta para trocá-la pelo par.
const {
  createWhatsappSender,
  headersDoRemetente,
  validarConfiguracao: validarRemetenteWhatsapp,
  validarComportamento: validarComportamentoWhatsapp,
  comportamentoDaConfig: comportamentoWhatsappDaConfig,
  RemetenteError,
  HEADERS: WHATSAPP_HEADERS,
} = require('./lib/platform/whatsapp-sender');
const WHATSAPP_HEADER_TOKEN = WHATSAPP_HEADERS.accessToken;
const WHATSAPP_HEADER_WABA = WHATSAPP_HEADERS.wabaId;
const WHATSAPP_REMETENTE = INTEGRACOES
  ? createWhatsappSender({ integracoes: INTEGRACOES, segredoRef: process.env.WHATSAPP_SENDER_REF_SECRET })
  : null;
const WHATSAPP_SENDER_RESOLVER_KEY = process.env.WHATSAPP_SENDER_RESOLVER_KEY || null;
// Fail-fast em produção: com o serviço de WhatsApp configurado, sem essas duas chaves nenhum envio
// sai (não há remetente padrão) e a fila do Go não despacha. Melhor não subir.
if ((process.env.NODE_ENV || '').toLowerCase() === 'production' && process.env.WHATSAPP_SERVICE_URL) {
  const faltando = [];
  if (!WHATSAPP_REMETENTE || !WHATSAPP_REMETENTE.disponivel()) faltando.push('WHATSAPP_SENDER_REF_SECRET (≥ 32 caracteres)');
  if (!WHATSAPP_SENDER_RESOLVER_KEY || WHATSAPP_SENDER_RESOLVER_KEY.length < 32) faltando.push('WHATSAPP_SENDER_RESOLVER_KEY (≥ 32 caracteres)');
  if (faltando.length) {
    console.error(`[WHATSAPP] remetente por Organization exige: ${faltando.join(', ')}`);
    process.exit(1);
  }
}

// Cofre da OpenAI key (BYOK) do tenant do Creative Core — que é a Organization do contexto.
function cofreOpenAiDaOrganizacao(tenantId) {
  const conferir = () => {
    if (String(orgDoContexto()).toLowerCase() !== String(tenantId).toLowerCase()) {
      throw new IntegracaoError('tenant do Creative Core diferente da organization do contexto', { codigo: 'TENANT_MISMATCH', status: 403 });
    }
    return exigirIntegracoes();
  };
  return {
    async metadata() {
      const m = await conferir().metadata('openai');
      const chave = m.segredos.find((x) => x.tipo === 'api_key');
      return { configured: !!chave, last4: (chave && chave.last4) || null, updatedAt: (chave && chave.rotatedAt) || null };
    },
    gravar: (valor) => conferir().gravarSegredo('openai', 'api_key', valor),
    apagar: () => conferir().desconectar('openai'),
    usar: (fn) => conferir().usarSegredo('openai', 'api_key', (key) => fn(key)).catch((err) => {
      if (['INTEGRATION_NOT_CONNECTED', 'SECRET_UNREADABLE', 'SECRET_MISSING'].includes(err.codigo)) return null;
      throw err;
    }),
  };
}

function exigirRemetenteWhatsapp() {
  if (!WHATSAPP_REMETENTE) throw new IntegracaoError('integrações exigem Postgres configurado', { codigo: 'INTEGRATIONS_UNAVAILABLE', status: 503 });
  return WHATSAPP_REMETENTE;
}

function exigirIntegracoes() {
  if (!INTEGRACOES) throw new IntegracaoError('integrações exigem Postgres configurado', { codigo: 'INTEGRATIONS_UNAVAILABLE', status: 503 });
  return INTEGRACOES;
}

// state OAuth: persistido em oauth_states (lib/platform/oauth-state.js), amarrado à pessoa, à
// sessão e à Organization que iniciou o fluxo (Fase 4).
async function criarStateOAuth(req, provider, dados = {}) {
  if (!OAUTH_STATES) throw new IntegracaoError('OAuth exige Postgres configurado', { codigo: 'INTEGRATIONS_UNAVAILABLE', status: 503 });
  return OAUTH_STATES.criar({ provider, organizationId: orgDoContexto(), auth: req.auth, dados });
}

// Revogação no Google (GA4 e Google Ads usam o mesmo endpoint). O token vai no corpo, nunca na URL.
async function revogarTokenGoogle(token) {
  await fetch(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => {});
}

function mapGaConnectionRow(r, loja) {
  if (!r) return { loja, propertyId: null, propertyName: null, googleAccountEmail: null, status: 'disconnected', connectedAt: null, lastSyncAt: null, lastError: null };
  return {
    loja: r.loja, propertyId: r.property_id, propertyName: r.property_name, googleAccountEmail: r.google_account_email,
    status: r.status, connectedAt: r.connected_at, lastSyncAt: r.last_sync_at, lastError: r.last_error,
  };
}

// GA4 por Store do contexto (`organization_id + store_id`). A linha histórica, sem `store_id`, só
// entra quando a Store tem chave legada — e é reivindicada por mapeamento explícito ao escrever.
async function obterConexaoGA4() {
  if (!pgPool) return null;
  const escopo = escopoDaStore(2);
  const { rows } = await pgPool.query(
    `SELECT * FROM google_analytics_connections WHERE organization_id = $1 AND ${escopo.sql} ORDER BY (store_id IS NOT NULL) DESC LIMIT 1`,
    [orgDoContexto(), ...escopo.params]
  );
  return rows[0] || null;
}

// Uma Store com chave legada pode ter linha ANTIGA (sem `store_id`): passa a ser dela, por mapeamento
// explícito (o mesmo do backfill da 0027), antes de qualquer escrita — nunca duplica.
async function reivindicarLinhaLegadaGA4() {
  const loja = lojaLegadaDoContextoOuNula();
  if (!loja) return;
  await pgPool.query('UPDATE google_analytics_connections SET store_id = $2 WHERE organization_id = $1 AND store_id IS NULL AND loja = $3', [orgDoContexto(), storeDoContexto(), loja]);
}

// prompt=consent força o Google a reemitir refresh_token toda vez que a loja conecta — sem isso,
// reconectar uma loja que já autorizou antes não devolve refresh_token nenhum (só sai na 1ª vez).
// Fase 4: os tokens vão para integration_secrets (integração 'ga4' da Organization); a linha da
// conexão guarda só status, e-mail e propriedade.
async function salvarTokensGA4({ refreshToken, accessToken, expiresAt, email }) {
  const integracoes = exigirIntegracoes();
  if (!refreshToken) throw new Error('o Google não devolveu refresh token — reconecte');
  await integracoes.gravarSegredo('ga4', 'refresh_token', refreshToken);
  if (accessToken) await integracoes.gravarSegredo('ga4', 'access_token', accessToken, { expiresAt });
  await reivindicarLinhaLegadaGA4();
  await pgPool.query(
    `INSERT INTO google_analytics_connections (store_id, loja, token_expires_at, google_account_email, status, connected_at, last_error, atualizado_em)
     VALUES ($1,$4,$2,$3,'connected', now(), NULL, now())
     ON CONFLICT (organization_id, store_id) WHERE store_id IS NOT NULL DO UPDATE SET
       token_expires_at = $2, google_account_email = $3,
       status = 'connected', connected_at = now(), last_error = NULL, atualizado_em = now()`,
    [storeDoContexto(), expiresAt, email || null, lojaLegadaDoContextoOuNula()]
  );
}

async function marcarErroGA4(mensagem) {
  await reivindicarLinhaLegadaGA4();
  await pgPool.query(
    `INSERT INTO google_analytics_connections (store_id, loja, status, last_error, atualizado_em) VALUES ($1,$3,'error',$2, now())
     ON CONFLICT (organization_id, store_id) WHERE store_id IS NOT NULL DO UPDATE SET status = 'error', last_error = $2, atualizado_em = now()`,
    [storeDoContexto(), String(mensagem).slice(0, 500), lojaLegadaDoContextoOuNula()]
  );
}

// PD-016: a propriedade passa a pertencer a esta Organization; outra que já a tenha → 409.
async function salvarPropriedadeGA4(propertyId, propertyName) {
  const integracoes = exigirIntegracoes();
  const atual = await obterConexaoGA4();
  await integracoes.reivindicarRecurso('ga4', 'property', propertyId);
  if (atual && atual.property_id && atual.property_id !== propertyId) {
    await integracoes.liberarRecursos('ga4', 'property', atual.property_id);
  }
  await reivindicarLinhaLegadaGA4();
  await pgPool.query(
    'UPDATE google_analytics_connections SET property_id = $2, property_name = $3, atualizado_em = now() WHERE organization_id = $4 AND store_id = $1',
    [storeDoContexto(), propertyId, propertyName, orgDoContexto()]
  );
}

async function desconectarGA4() {
  await exigirIntegracoes().desconectar('ga4');
  await reivindicarLinhaLegadaGA4();
  await pgPool.query(
    `UPDATE google_analytics_connections SET token_expires_at = NULL,
       property_id = NULL, property_name = NULL, status = 'disconnected', last_error = NULL, atualizado_em = now()
      WHERE organization_id = $2 AND store_id = $1`,
    [storeDoContexto(), orgDoContexto()]
  );
}

async function trocarCodePorTokensGA4(code) {
  const res = await googleFetchUnica(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI, grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw erroGoogle(res.status, data, 'falha ao trocar o código de autorização');
  return data;
}

async function renovarAccessTokenGA4(refreshTokenPlano) {
  const res = await googleFetchLeitura(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshTokenPlano, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw erroGoogle(res.status, data, 'renovação de token');
  return data;
}

function decodificarEmailDoIdTokenGA4(idToken) {
  try {
    const payload = idToken.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
}

// Devolve um access_token válido pra `loja`, renovando via refresh_token quando preciso/expirado.
// Usado por /properties agora e pela Fase 3 (Data API) no futuro.
// Access token válido da integração Google (GA4 ou Google Ads) da Organization do contexto,
// renovando pelo refresh token quando o guardado vence em menos de 1 minuto.
async function accessTokenGoogle(provider, aoFalhar) {
  const integracoes = exigirIntegracoes();
  const atual = await integracoes.usarSegredo(provider, 'access_token', (token, { expiresAt }) => (
    expiresAt && new Date(expiresAt).getTime() - Date.now() > 60_000 ? token : null
  ), { aceitarVencido: true }).catch((err) => {
    if (err.codigo === 'INTEGRATION_NOT_CONNECTED') return null;
    throw err;
  });
  if (atual) return atual;
  let tokens;
  try {
    tokens = await integracoes.usarSegredo(provider, 'refresh_token', (refresh) => renovarAccessTokenGA4(refresh));
  } catch (err) {
    const mensagem = err.codigo === 'INTEGRATION_NOT_CONNECTED' || err.codigo === 'SECRET_MISSING'
      ? 'conexão com o Google ausente — conecte de novo'
      : err.codigo === 'SECRET_UNREADABLE'
        ? 'não foi possível decifrar o token salvo — reconecte'
        : `renovação de token falhou: ${err.message}`;
    await aoFalhar(mensagem, err).catch(() => {});
    // Erro já classificado pelo cliente do Google (ex.: RECONNECT_REQUIRED) sobe com o código: a tela
    // oferece "Reconectar" em vez de um 502 genérico.
    if (err.codigo && err.status) throw err;
    throw new Error(mensagem);
  }
  const novaExpiracao = new Date(Date.now() + tokens.expires_in * 1000);
  await integracoes.gravarSegredo(provider, 'access_token', tokens.access_token, { expiresAt: novaExpiracao });
  return { token: tokens.access_token, expiraEm: novaExpiracao };
}

async function obterAccessTokenValidoGA4() {
  const row = await obterConexaoGA4();
  if (!row || row.status === 'disconnected') throw new Error('loja sem conexão com o Google Analytics');
  const r = await accessTokenGoogle('ga4', (mensagem) => marcarErroGA4(mensagem));
  if (typeof r === 'string') return r;
  await reivindicarLinhaLegadaGA4();
  await pgPool.query(
    `UPDATE google_analytics_connections SET token_expires_at = $2, status = 'connected', last_error = NULL, atualizado_em = now()
      WHERE organization_id = $3 AND store_id = $1`,
    [storeDoContexto(), r.expiraEm, orgDoContexto()]
  );
  return r.token;
}

async function listarPropriedadesGA4(accessToken) {
  const res = await googleFetchLeitura(`${GA_ADMIN_API}/accountSummaries?pageSize=200`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw erroGoogle(res.status, data, 'não foi possível listar as propriedades do Google Analytics');
  const propriedades = [];
  for (const conta of data.accountSummaries || []) {
    for (const prop of conta.propertySummaries || []) {
      propriedades.push({
        propertyId: (prop.property || '').replace('properties/', ''),
        propertyName: prop.displayName || prop.property,
        accountName: conta.displayName || '',
      });
    }
  }
  return propriedades;
}

app.get('/api/admin/integrations/google-analytics/status', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'Google Analytics exige Postgres configurado' });
  try {
    // Identidade canônica: a Store do contexto. A linha histórica só entra quando a Store tem chave
    // legada. Sem conexão é "desconectado" (estado normal), nunca erro.
    const row = await obterConexaoGA4();
    const conexoes = [{ storeId: storeDoContexto(), storeNome: await nomeDaStoreDoContexto(), ...mapGaConnectionRow(row, lojaLegadaDoContextoOuNula()) }];
    res.json({ conexoes, oauthConfigurado: googleOAuthConfigurado() });
  } catch (err) {
    console.error(`[GA4] falha ao ler status: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler o status do Google Analytics' });
  }
});

app.get('/api/admin/integrations/google-analytics/connect', requireAdmin, async (req, res) => {
  // A Store do contexto é quem conecta; ela vai no `state` (anti-CSRF, uso único, amarrado à pessoa,
  // à sessão e à Organization). O callback confere que a Store do contexto é a mesma — nunca aceita
  // Organization/Store vinda do navegador.
  const storeId = storeDoContexto();
  // Configuração da PLATAFORMA (credencial do app OAuth): o tenant vê o conceito, não as variáveis.
  if (!googleOAuthConfigurado()) return res.status(503).json({ error: 'a conexão com o Google ainda não está habilitada na plataforma', codigo: 'PLATFORM_UNAVAILABLE' });
  if (!pgPool) return res.status(503).json({ error: 'Google Analytics exige Postgres configurado' });
  const state = await criarStateOAuth(req, 'ga4', { storeId });
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.GOOGLE_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_OAUTH_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// Google redireciona o navegador do admin pra cá — não dá pra garantir que o cookie de sessão do
// painel chega junto (depende do navegador), então quem prova que essa requisição é legítima é o
// `state` de uso único gerado em /connect, não requireAdmin.
app.get('/api/admin/integrations/google-analytics/callback', async (req, res) => {
  const { code, state, error: erroGoogle } = req.query;

  // O redirect_uri é um só para GA4 e Google Ads (trocá-lo exigiria recadastrar no console): o
  // provider vem do state persistido, junto da Organization que iniciou o fluxo (Fase 4).
  const destino = '/admin/integracoes';
  let salvo;
  try {
    salvo = await OAUTH_STATES.consumir(String(state || ''), ['ga4', 'google_ads']);
  } catch (err) {
    console.error(`[GOOGLE_OAUTH] callback recusado: ${err instanceof OAuthStateError ? err.motivo : err.message}`);
    return res.redirect(destino);
  }
  // Tenant do callback = Organization gravada no state (membership revalidado); nunca do request.
  try {
    if (salvo.provider === 'google_ads') {
      await comOrganizacaoResolvida(salvo.organizationId, 'oauth:google-ads', () => concluirCallbackGoogleAds(code, erroGoogle));
      return res.redirect(destino);
    }
    // A Store do state precisa ser a da Organization resolvida pelo state: state forjado ou de outra
    // Store é recusado (e o callback só redireciona, sem gravar nada).
    const { storeId } = salvo.dados;
    await comOrganizacaoResolvida(salvo.organizationId, 'oauth:ga4', async () => {
      if (!storeId || storeDoContexto() !== storeId) throw new Error('state de outra store');
      if (erroGoogle) {
        await marcarErroGA4(`Google recusou: ${erroGoogle}`).catch(() => {});
        return;
      }
      if (!code) {
        await marcarErroGA4('callback sem código de autorização').catch(() => {});
        return;
      }
      try {
        const tokens = await trocarCodePorTokensGA4(String(code));
        const email = tokens.id_token ? decodificarEmailDoIdTokenGA4(tokens.id_token) : null;
        await salvarTokensGA4({ refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresAt: new Date(Date.now() + tokens.expires_in * 1000), email });
        // Uma única propriedade inequívoca é selecionada sozinha; com várias, a tela pede a escolha.
        // Persistimos o ID externo real (`propertyId`), nunca o nome. Falha aqui não desfaz a conexão.
        try {
          const propriedades = await listarPropriedadesGA4(tokens.access_token);
          if (propriedades.length === 1) await salvarPropriedadeGA4(propriedades[0].propertyId, propriedades[0].propertyName);
        } catch (err) {
          console.warn(`[GA4] conectado, mas não foi possível selecionar a propriedade automaticamente: ${err.message}`);
        }
      } catch (err) {
        console.error(`[GA4] falha no callback OAuth (store ${storeId}): ${err.message}`);
        await marcarErroGA4(err.message).catch(() => {});
      }
    });
  } catch (err) {
    console.error(`[GOOGLE_OAUTH] callback sem contexto válido: ${err.message}`);
  }
  res.redirect(destino);
});

app.get('/api/admin/integrations/google-analytics/properties', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'Google Analytics exige Postgres configurado' });
  try {
    const accessToken = await obterAccessTokenValidoGA4();
    res.json({ propriedades: await listarPropriedadesGA4(accessToken) });
  } catch (err) {
    console.error(`[GA4] falha ao listar propriedades (store ${storeDoContexto()}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível listar as propriedades', ...(err.codigo ? { codigo: err.codigo } : {}) });
  }
});

app.post('/api/admin/integrations/google-analytics/property', requireAdmin, async (req, res) => {
  const { propertyId, propertyName } = req.body || {};
  if (!propertyId) return res.status(400).json({ error: 'propertyId é obrigatório' });
  if (!pgPool) return res.status(503).json({ error: 'Google Analytics exige Postgres configurado' });
  try {
    await salvarPropriedadeGA4(String(propertyId), propertyName ? String(propertyName) : String(propertyId));
    res.json({ conexao: { storeId: storeDoContexto(), storeNome: await nomeDaStoreDoContexto(), ...mapGaConnectionRow(await obterConexaoGA4(), lojaLegadaDoContextoOuNula()) } });
  } catch (err) {
    if (err instanceof IntegracaoError) return res.status(err.status).json({ error: err.message, codigo: err.codigo });
    console.error(`[GA4] falha ao salvar propriedade (store ${storeDoContexto()}): ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar a propriedade' });
  }
});

app.post('/api/admin/integrations/google-analytics/disconnect', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'Google Analytics exige Postgres configurado' });
  try {
    // Revoga no Google também — best-effort, não impede a desconexão local se a revogação falhar.
    await exigirIntegracoes().usarSegredo('ga4', 'refresh_token', (refresh) => revogarTokenGoogle(refresh)).catch(() => {});
    await desconectarGA4();
    res.json({ ok: true });
  } catch (err) {
    console.error(`[GA4] falha ao desconectar (store ${storeDoContexto()}): ${err.message}`);
    res.status(500).json({ error: 'não foi possível desconectar' });
  }
});

// ── UTM Tracker — Fase 3: performance real via GA4 Data API (docs/claude-utm-tracker-ga4.md §16-21)
// Regra central pedida pelo usuário: a lista vem AGRUPADA PELAS DIMENSÕES DO GA4 (não das campanhas
// salvas), então links de UTM usados fora do Construtor (ex.: campanhas do Meta) aparecem aqui do
// mesmo jeito — cada linha só ganha um nome amigável quando bate com uma campanha salva.
const GA_DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

function resolverPeriodoGA4(periodoRaw) {
  const periodo = String(periodoRaw || '30d');
  if (periodo === 'hoje') return { chave: 'hoje', startDate: 'today', endDate: 'today' };
  if (periodo === '7d') return { chave: '7d', startDate: '7daysAgo', endDate: 'today' };
  if (periodo === '30d') return { chave: '30d', startDate: '30daysAgo', endDate: 'today' };
  if (periodo === '90d') return { chave: '90d', startDate: '90daysAgo', endDate: 'today' };
  const m = periodo.match(/^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
  if (m) return { chave: periodo, startDate: m[1], endDate: m[2] };
  throw new Error('período inválido');
}

// 1 request pra tabela inteira (nunca 1 por linha — spec §21). "(not set)" é o texto literal que o
// GA4 usa pra sessão sem UTM nenhuma; filtramos direto na API pra não gastar cota trazendo lixo.
async function buscarPerformanceGA4Bruto(accessToken, propertyId, periodo) {
  const res = await googleFetchLeitura(`${GA_DATA_API}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: periodo.startDate, endDate: periodo.endDate }],
      dimensions: [
        { name: 'sessionManualSource' }, { name: 'sessionManualMedium' }, { name: 'sessionManualCampaignName' },
        { name: 'sessionManualAdContent' }, { name: 'sessionManualTerm' },
      ],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'ecommercePurchases' }, { name: 'totalRevenue' }],
      dimensionFilter: {
        notExpression: { filter: { fieldName: 'sessionManualSource', stringFilter: { matchType: 'EXACT', value: '(not set)' } } },
      },
      // Sem orderBys o GA4 devolve as linhas na ordem dele e o `limit` corta um pedaço arbitrário —
      // as combinações mais relevantes podiam simplesmente não vir. Ordenar por sessão garante que
      // o corte pegue sempre o topo, e `rowCount` diz quantas existem de verdade.
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      metricAggregations: ['TOTAL'],
      limit: 250,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw erroGoogle(res.status, data, 'não foi possível consultar o Google Analytics');
  const linhas = (data.rows || []).map((row) => {
    const [source, medium, campaign, content, term] = row.dimensionValues.map((d) => d.value);
    const [sessions, users, purchases, revenue] = row.metricValues.map((m) => Number(m.value) || 0);
    return { source, medium, campaign, content, term, sessions, users, purchases, revenue };
  });
  const totalRow = data.totals?.[0];
  const totais = totalRow
    ? {
        sessions: Number(totalRow.metricValues[0].value) || 0, users: Number(totalRow.metricValues[1].value) || 0,
        purchases: Number(totalRow.metricValues[2].value) || 0, revenue: Number(totalRow.metricValues[3].value) || 0,
      }
    : linhas.reduce((acc, l) => ({
        sessions: acc.sessions + l.sessions, users: acc.users + l.users,
        purchases: acc.purchases + l.purchases, revenue: acc.revenue + l.revenue,
      }), { sessions: 0, users: 0, purchases: 0, revenue: 0 });
  return { linhas, totais, totalCombinacoes: Number(data.rowCount) || linhas.length };
}

// Combinação-chave da spec (source+medium+campaign+content+term) pra evitar colisão entre canais
// diferentes que reusam o mesmo nome de campanha. Usa a mesma normalização do Builder, então uma
// campanha salva como "verao_2026" bate com o link do GA4 mesmo se ele vier "Verão 2026".
function chaveComboUtm({ source, medium, campaign, content, term }) {
  // O GA4 devolve o literal "(not set)" para content/term que o link não tinha; a campanha salva sem
  // content/term guarda vazio. Sem tratar os dois como a MESMA coisa, a normalização (que tira os
  // parênteses) fazia "(not set)" virar "notset" e a campanha salva nunca reconhecia a linha do GA4.
  const vazioSeNaoDefinido = (v) => (String(v ?? '').trim().toLowerCase() === '(not set)' ? '' : v);
  return [source, medium, campaign, content, term].map((v) => normalizarUtmValor(vazioSeNaoDefinido(v))).join('|');
}

async function listarUtmCampanhasParaMatch() {
  // Mesmo escopo canônico da lista de campanhas: `organization_id + store_id`.
  const escopo = escopoDaStore(2);
  const { rows } = await pgPool.query(
    `SELECT ${UTM_SELECT_COLS} FROM utm_campaigns WHERE organization_id = $1 AND ${escopo.sql}`, [orgDoContexto(), ...escopo.params]
  );
  return rows.map(mapUtmCampanhaRow);
}

// Enriquece cada linha do GA4 com o nome da campanha salva quando reconhece a combinação — campanha
// salva sem tráfego no período simplesmente não aparece (nunca inventa uma linha com zero de verdade).
function montarPerformanceGA4(bruto, campanhasSalvas) {
  const porChave = new Map(campanhasSalvas.map((c) => [
    chaveComboUtm({ source: c.source, medium: c.medium, campaign: c.campaign, content: c.content || '', term: c.term || '' }), c,
  ]));
  const linhas = bruto.linhas.map((l) => {
    const salva = porChave.get(chaveComboUtm(l)) || null;
    return {
      ...l, campanhaId: salva?.id || null, campanhaNome: salva?.nome || null,
      conversionRate: l.sessions > 0 ? l.purchases / l.sessions : 0,
      participacao: bruto.totais.sessions > 0 ? l.sessions / bruto.totais.sessions : 0,
    };
  });
  return {
    linhas,
    totais: { ...bruto.totais, conversionRate: bruto.totais.sessions > 0 ? bruto.totais.purchases / bruto.totais.sessions : 0 },
    totalCombinacoes: bruto.totalCombinacoes,
  };
}

// TTL de 20min (dentro dos "15 a 30min" sugeridos pela spec) — evita bater na Data API a cada render.
async function obterCachePerformanceGA4(periodoChave) {
  const escopo = escopoDaStore(3);
  const { rows } = await pgPool.query(
    `SELECT dados, buscado_em FROM ga4_performance_cache WHERE organization_id = $1 AND periodo = $2 AND ${escopo.sql} AND buscado_em > now() - interval '20 minutes'
      ORDER BY (store_id IS NOT NULL) DESC LIMIT 1`,
    [orgDoContexto(), periodoChave, ...escopo.params]
  );
  if (!rows.length) return null;
  return { dados: rows[0].dados, buscadoEm: rows[0].buscado_em };
}

async function salvarCachePerformanceGA4(periodoChave, dados) {
  // Linha antiga de uma Store com chave legada passa a ser dela (mapeamento explícito) antes de escrever.
  const loja = lojaLegadaDoContextoOuNula();
  if (loja) await pgPool.query('UPDATE ga4_performance_cache SET store_id = $2 WHERE organization_id = $1 AND store_id IS NULL AND loja = $3', [orgDoContexto(), storeDoContexto(), loja]);
  await pgPool.query(
    `INSERT INTO ga4_performance_cache (store_id, loja, periodo, dados, buscado_em) VALUES ($1,$4,$2,$3, now())
     ON CONFLICT (organization_id, store_id, periodo) WHERE store_id IS NOT NULL DO UPDATE SET dados = $3, buscado_em = now()`,
    [storeDoContexto(), periodoChave, JSON.stringify(dados), loja]
  );
}

app.get('/api/admin/integrations/google-analytics/performance', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'GA4 exige Postgres configurado' });
  const storeId = storeDoContexto();
  let periodo;
  try { periodo = resolverPeriodoGA4(req.query.periodo); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    if (req.query.atualizar !== '1') {
      const cache = await obterCachePerformanceGA4(periodo.chave);
      if (cache) return res.json({ ...cache.dados, atualizadoEm: cache.buscadoEm, doCache: true });
    }
    const conexao = await obterConexaoGA4();
    if (!conexao || conexao.status !== 'connected' || !conexao.property_id) {
      return res.status(409).json({ error: 'conecte o Google Analytics e escolha uma propriedade em Integrações primeiro' });
    }
    const accessToken = await obterAccessTokenValidoGA4();
    const bruto = await buscarPerformanceGA4Bruto(accessToken, conexao.property_id, periodo);
    const campanhasSalvas = await listarUtmCampanhasParaMatch();
    const dados = montarPerformanceGA4(bruto, campanhasSalvas);
    await salvarCachePerformanceGA4(periodo.chave, dados);
    res.json({ ...dados, atualizadoEm: new Date().toISOString(), doCache: false });
  } catch (err) {
    console.error(`[GA4] falha ao buscar performance (store ${storeId}): ${err.message}`);
    res.status(err.status || 502).json({ error: err.message || 'não foi possível buscar dados do Google Analytics', ...(err.codigo ? { codigo: err.codigo } : {}) });
  }
});

// Série diária de 1 combinação específica — só é chamada quando o usuário abre o detalhe de uma
// linha (spec §21: nunca 1 request por linha pra todas de uma vez, e nunca fica em cache pra todas).
async function buscarSerieDiariaGA4(accessToken, propertyId, periodo, combo) {
  const filtro = (campo, valor) => ({ filter: { fieldName: campo, stringFilter: { matchType: 'EXACT', value: valor } } });
  const res = await googleFetchLeitura(`${GA_DATA_API}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: periodo.startDate, endDate: periodo.endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'ecommercePurchases' }, { name: 'totalRevenue' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            filtro('sessionManualSource', combo.source), filtro('sessionManualMedium', combo.medium),
            filtro('sessionManualCampaignName', combo.campaign), filtro('sessionManualAdContent', combo.content),
            filtro('sessionManualTerm', combo.term),
          ],
        },
      },
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 366,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw erroGoogle(res.status, data, 'não foi possível consultar a série diária do Google Analytics');
  return (data.rows || []).map((row) => {
    const bruta = row.dimensionValues[0].value; // YYYYMMDD
    const [sessions, users, purchases, revenue] = row.metricValues.map((m) => Number(m.value) || 0);
    return {
      data: `${bruta.slice(0, 4)}-${bruta.slice(4, 6)}-${bruta.slice(6, 8)}`,
      sessions, users, purchases, revenue, conversionRate: sessions > 0 ? purchases / sessions : 0,
    };
  });
}

app.get('/api/admin/integrations/google-analytics/performance/series', requireAdmin, async (req, res) => {
  const storeId = storeDoContexto();
  let periodo;
  try { periodo = resolverPeriodoGA4(req.query.periodo); } catch (err) { return res.status(400).json({ error: err.message }); }
  const combo = {
    source: String(req.query.source || ''),
    medium: String(req.query.medium || '(not set)'),
    campaign: String(req.query.campaign || '(not set)'),
    content: String(req.query.content || '(not set)'),
    term: String(req.query.term || '(not set)'),
  };
  if (!combo.source) return res.status(400).json({ error: 'source é obrigatório' });
  try {
    const conexao = await obterConexaoGA4();
    if (!conexao || conexao.status !== 'connected' || !conexao.property_id) {
      return res.status(409).json({ error: 'conecte o Google Analytics e escolha uma propriedade em Integrações primeiro' });
    }
    const accessToken = await obterAccessTokenValidoGA4();
    const serie = await buscarSerieDiariaGA4(accessToken, conexao.property_id, periodo, combo);
    res.json({ serie });
  } catch (err) {
    console.error(`[GA4] falha ao buscar série diária (store ${storeId}): ${err.message}`);
    res.status(err.status || 502).json({ error: err.message || 'não foi possível buscar a série diária do Google Analytics', ...(err.codigo ? { codigo: err.codigo } : {}) });
  }
});

// ── Analytics GA4 — panorama da loja (funil, tráfego, receita, canais, dispositivos, horários).
// Tudo num `batchRunReports` só: 5 relatórios = 1 chamada HTTP (o teto da API é 5 por batch), em
// vez de 5 idas separadas. Mesmo cache de 20min do resto do GA4, com chave "overview:<período>".
const GA_METRICAS_TOTAIS = [
  'sessions', 'totalUsers', 'newUsers', 'screenPageViews', 'averageSessionDuration',
  'bounceRate', 'totalRevenue', 'ecommercePurchases', 'addToCarts', 'checkouts',
];

function metricasGA4(nomes) {
  return nomes.map((name) => ({ name }));
}

function numeroDaLinhaGA4(row, indice) {
  return Number(row?.metricValues?.[indice]?.value) || 0;
}

async function buscarOverviewGA4(accessToken, propertyId, periodo) {
  const dateRanges = [{ startDate: periodo.startDate, endDate: periodo.endDate }];
  const metricasCanal = metricasGA4(['sessions', 'ecommercePurchases', 'totalRevenue']);
  const res = await googleFetchLeitura(`${GA_DATA_API}/properties/${propertyId}:batchRunReports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { dateRanges, metrics: metricasGA4(GA_METRICAS_TOTAIS) },
        { dateRanges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: metricasCanal, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 25 },
        { dateRanges, dimensions: [{ name: 'deviceCategory' }], metrics: metricasCanal, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 },
        { dateRanges, dimensions: [{ name: 'date' }], metrics: metricasCanal, orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 },
        { dateRanges, dimensions: [{ name: 'dayOfWeek' }, { name: 'hour' }], metrics: metricasGA4(['sessions']), limit: 200 },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw erroGoogle(res.status, data, 'não foi possível consultar o panorama do Google Analytics');
  const [rTotais, rCanais, rDispositivos, rSerie, rHoras] = data.reports || [];

  const linhaTotais = rTotais?.rows?.[0];
  const t = {};
  GA_METRICAS_TOTAIS.forEach((nome, i) => { t[nome] = numeroDaLinhaGA4(linhaTotais, i); });
  const totais = {
    sessions: t.sessions, users: t.totalUsers, newUsers: t.newUsers, pageviews: t.screenPageViews,
    avgSessionDuration: t.averageSessionDuration, bounceRate: t.bounceRate,
    revenue: t.totalRevenue, purchases: t.ecommercePurchases, addToCarts: t.addToCarts, checkouts: t.checkouts,
    conversionRate: t.sessions > 0 ? t.ecommercePurchases / t.sessions : 0,
    ticketMedio: t.ecommercePurchases > 0 ? t.totalRevenue / t.ecommercePurchases : 0,
    pageviewsPorSessao: t.sessions > 0 ? t.screenPageViews / t.sessions : 0,
    usuariosRecorrentes: Math.max(0, t.totalUsers - t.newUsers),
  };

  const mapearGrupo = (rows = []) => rows.map((row) => ({
    rotulo: row.dimensionValues[0].value,
    sessions: numeroDaLinhaGA4(row, 0),
    purchases: numeroDaLinhaGA4(row, 1),
    revenue: numeroDaLinhaGA4(row, 2),
    conversionRate: numeroDaLinhaGA4(row, 0) > 0 ? numeroDaLinhaGA4(row, 1) / numeroDaLinhaGA4(row, 0) : 0,
    participacao: totais.sessions > 0 ? numeroDaLinhaGA4(row, 0) / totais.sessions : 0,
  }));

  const serie = (rSerie?.rows || []).map((row) => {
    const bruta = row.dimensionValues[0].value; // YYYYMMDD
    return {
      data: `${bruta.slice(0, 4)}-${bruta.slice(4, 6)}-${bruta.slice(6, 8)}`,
      sessions: numeroDaLinhaGA4(row, 0), purchases: numeroDaLinhaGA4(row, 1), revenue: numeroDaLinhaGA4(row, 2),
    };
  });

  // dayOfWeek vem "0".."6" (0 = domingo) e hour vem "00".."23" — viram números pro mapa de calor.
  const horarios = (rHoras?.rows || []).map((row) => ({
    dia: Number(row.dimensionValues[0].value),
    hora: Number(row.dimensionValues[1].value),
    sessions: numeroDaLinhaGA4(row, 0),
  }));

  return { totais, canais: mapearGrupo(rCanais?.rows), dispositivos: mapearGrupo(rDispositivos?.rows), serie, horarios };
}

app.get('/api/admin/integrations/google-analytics/overview', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'GA4 exige Postgres configurado' });
  const storeId = storeDoContexto();
  let periodo;
  try { periodo = resolverPeriodoGA4(req.query.periodo); } catch (err) { return res.status(400).json({ error: err.message }); }
  const chaveCache = `overview:${periodo.chave}`;
  try {
    if (req.query.atualizar !== '1') {
      const cache = await obterCachePerformanceGA4(chaveCache);
      if (cache) return res.json({ ...cache.dados, atualizadoEm: cache.buscadoEm, doCache: true });
    }
    const conexao = await obterConexaoGA4();
    if (!conexao || conexao.status !== 'connected' || !conexao.property_id) {
      return res.status(409).json({ error: 'conecte o Google Analytics e escolha uma propriedade em Integrações primeiro' });
    }
    const accessToken = await obterAccessTokenValidoGA4();
    const dados = await buscarOverviewGA4(accessToken, conexao.property_id, periodo);
    await salvarCachePerformanceGA4(chaveCache, dados);
    res.json({ ...dados, atualizadoEm: new Date().toISOString(), doCache: false });
  } catch (err) {
    console.error(`[GA4] falha ao buscar panorama (store ${storeId}): ${err.message}`);
    res.status(err.status || 502).json({ error: err.message || 'não foi possível buscar o panorama do Google Analytics', ...(err.codigo ? { codigo: err.codigo } : {}) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Google Ads — conexão, sync e leitura
// ═══════════════════════════════════════════════════════════════════════════════════════════
// SOMENTE LEITURA. Todas as chamadas são GAQL SELECT via googleAds:search; não existe nenhuma
// chamada de mutate neste arquivo, e não deve passar a existir sem um módulo separado.
//
// Isso importa mais aqui do que no Meta: o Google não oferece escopo de leitura para Ads. O único
// escopo existente (`adwords`) concede "ver, editar, criar e excluir". A limitação a leitura é
// disciplina nossa, não do escopo — por isso está escrita aqui e é o que a justificativa enviada
// ao Google afirma.
//
// A conexão é SEPARADA da do GA4 de propósito: escopos diferentes, que o usuário pode conceder um
// sem o outro. Amarrar as duas faria a queda de uma derrubar a outra.
//
// Mesma regra de ouro do Meta: as telas nunca falam com o Google. O sync grava no Postgres e o
// painel lê do Postgres — velocidade, histórico e imunidade a rate limit.

const { GoogleAdsClient, GoogleAdsApiError, ERROS: GADS_ERROS } = require('./lib/google-ads/client');
const gadsMetricas = require('./lib/google-ads/metricas');
const gadsQueries = require('./lib/google-ads/queries');

// `adwords` é o único escopo que a API aceita — não existe variante somente-leitura.
const GOOGLE_ADS_OAUTH_SCOPE = 'openid email https://www.googleapis.com/auth/adwords';
const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || undefined;

// Conversão pode ser reportada dias depois do clique, então dia nenhum é considerado fechado: o
// sync refaz esta janela inteira toda vez. Mesmo motivo do META_DIAS_BACKFILL.
const GOOGLE_ADS_DIAS_BACKFILL = Number(process.env.GOOGLE_ADS_BACKFILL_DIAS || 28);
const GOOGLE_ADS_DIAS_IMPORT_INICIAL = 90;
const GOOGLE_ADS_INTERVALO_SYNC_MIN = Number(process.env.GOOGLE_ADS_SYNC_INTERVALO_MIN || 45);

// Prontidão da PLATAFORMA para o Google Ads = o cliente OAuth do Google está configurado. O developer
// token deixou de existir em 09/09/2026: o nível de acesso da API passou a ser do projeto do Google
// Cloud dono das credenciais OAuth, e o cabeçalho `developer-token` é opcional e ignorado pelo Google.
// Portanto `GOOGLE_ADS_DEVELOPER_TOKEN` NUNCA é requisito de readiness (ver docs/operations/google-ads-2026-09-21.md).
function googleAdsOAuthConfigurado() {
  return googleOAuthConfigurado();
}

// ── Conexão ─────────────────────────────────────────────────────────────────────────────────

async function obterConexaoGoogleAds() {
  if (!pgPool) return null;
  const { rows } = await pgPool.query('SELECT * FROM google_ads_connections WHERE organization_id = $1', [orgDoContexto()]);
  return rows[0] || null;
}

async function marcarErroGoogleAds(codigo, mensagem, detalhe) {
  if (!pgPool) return;
  // O detalhe do Google acompanha a mensagem: é ele que diz QUAL campo foi recusado, e sem ele um
  // erro de consulta só é diagnosticável com acesso ao log do servidor.
  const texto = detalhe ? `${mensagem} · Google: ${detalhe}` : mensagem;
  await pgPool.query(
    `UPDATE google_ads_connections
        SET status = 'error', last_error_at = now(), last_error_code = $1,
            last_error_message = $2, atualizado_em = now()
      WHERE organization_id = $3`,
    [codigo || null, texto ? String(texto).slice(0, 500) : null, orgDoContexto()]
  );
}

// Devolve um access token válido da Organization do contexto, renovando quando preciso.
async function obterAccessTokenValidoGoogleAds() {
  const row = await obterConexaoGoogleAds();
  if (!row || row.status === 'disconnected') throw new Error('Google Ads não conectado');
  const r = await accessTokenGoogle('google_ads', (mensagem) => marcarErroGoogleAds('REFRESH_FALHOU', mensagem));
  if (typeof r === 'string') return r;
  await pgPool.query(
    `UPDATE google_ads_connections
        SET token_expires_at = $1, status = 'connected',
            last_error_code = NULL, last_error_message = NULL, atualizado_em = now()
      WHERE organization_id = $2`,
    [r.expiraEm, orgDoContexto()]
  );
  return r.token;
}

async function googleAdsClient() {
  const row = await obterConexaoGoogleAds();
  const accessToken = await obterAccessTokenValidoGoogleAds();
  return new GoogleAdsClient({
    accessToken,
    // Sem `developer-token`: descontinuado em 09/09/2026 (o acesso vem do projeto das credenciais OAuth).
    loginCustomerId: (row && row.login_customer_id) || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || null,
    versao: GOOGLE_ADS_API_VERSION,
  });
}

// ── OAuth ───────────────────────────────────────────────────────────────────────────────────

app.get('/api/admin/integrations/google-ads/oauth/start', requireAdmin, async (req, res) => {
  if (!googleAdsOAuthConfigurado()) {
    return res.status(503).json({ error: 'a conexão com o Google ainda não está habilitada na plataforma', codigo: 'PLATFORM_UNAVAILABLE' });
  }
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.GOOGLE_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_ADS_OAUTH_SCOPE);
  url.searchParams.set('access_type', 'offline');
  // Sem prompt=consent, reconectar uma conta que já autorizou antes NÃO devolve refresh token
  // nenhum (ele só sai na primeira autorização) — e a conexão morreria em uma hora.
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  // O state persistido diz ao callback compartilhado que esta volta é do Ads (e de qual
  // Organization/pessoa/sessão), não do Analytics.
  url.searchParams.set('state', await criarStateOAuth(req, 'google_ads'));
  res.json({ url: url.toString() });
});

async function concluirCallbackGoogleAds(code, erroGoogle) {
  if (erroGoogle) {
    await marcarErroGoogleAds('OAUTH_RECUSADO', `Google recusou: ${erroGoogle}`).catch(() => {});
    return;
  }
  if (!code) {
    await marcarErroGoogleAds('OAUTH_SEM_CODIGO', 'callback sem código de autorização').catch(() => {});
    return;
  }
  try {
    await concluirOAuthGoogleAds(String(code));
  } catch (err) {
    console.error(`[GOOGLE_ADS] callback falhou: ${err.message}`);
    await marcarErroGoogleAds('OAUTH_FALHOU', err.message).catch(() => {});
  }
}

async function concluirOAuthGoogleAds(code) {
  const tokens = await trocarCodePorTokensGA4(code);
  if (!tokens.refresh_token) {
    throw new Error('o Google não devolveu refresh token — revogue o acesso do app na sua conta e conecte de novo');
  }
  const email = tokens.id_token ? decodificarEmailDoIdTokenGA4(tokens.id_token) : null;
  const expiraEm = new Date(Date.now() + tokens.expires_in * 1000);
  // Fase 4: tokens em integration_secrets da Organization; a linha guarda status e metadados.
  const integracoes = exigirIntegracoes();
  await integracoes.gravarSegredo('google_ads', 'refresh_token', tokens.refresh_token);
  await integracoes.gravarSegredo('google_ads', 'access_token', tokens.access_token, { expiresAt: expiraEm });
  await pgPool.query(
    `INSERT INTO google_ads_connections
       (id, token_expires_at, google_account_email,
        escopos, status, connected_at, last_error_at, last_error_code, last_error_message, atualizado_em)
     VALUES (1, $1, $2, $3, 'connected', now(), NULL, NULL, NULL, now())
     ON CONFLICT (organization_id) DO UPDATE SET
       token_expires_at = EXCLUDED.token_expires_at,
       google_account_email = EXCLUDED.google_account_email,
       escopos = EXCLUDED.escopos,
       status = 'connected', connected_at = now(),
       last_error_at = NULL, last_error_code = NULL, last_error_message = NULL, atualizado_em = now()`,
    [expiraEm, email, tokens.scope || GOOGLE_ADS_OAUTH_SCOPE]
  );
  // Descobrir as contas já na conexão evita uma tela vazia logo depois de conectar.
  try { await sincronizarContasGoogleAds(); } catch (err) {
    console.warn(`[GOOGLE_ADS] contas não listadas logo após conectar: ${err.message}`);
  }
}

app.post('/api/admin/integrations/google-ads/disconnect', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  try {
    const integracoes = exigirIntegracoes();
    // Revoga no Google também: desconectar só do nosso lado deixaria a permissão viva na conta do
    // usuário, o que contraria o que a Política de Privacidade promete.
    await integracoes.usarSegredo('google_ads', 'refresh_token', (refresh) => revogarTokenGoogle(refresh)).catch(() => {});
    // Segredos, posse dos customers e seleção — só desta Organization.
    await integracoes.desconectar('google_ads');
    await pgPool.query('UPDATE google_ads_customers SET selecionada = false WHERE organization_id = $1 AND selecionada', [orgDoContexto()]);
    await pgPool.query(
      `UPDATE google_ads_connections
          SET token_expires_at = NULL, status = 'disconnected', atualizado_em = now()
        WHERE organization_id = $1`,
      [orgDoContexto()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(`[GOOGLE_ADS] falha ao desconectar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível desconectar' });
  }
});

// ── Contas ──────────────────────────────────────────────────────────────────────────────────

// Descobre as contas que o token enxerga e guarda o que é preciso para escolher uma.
// `listAccessibleCustomers` devolve só ids; nome/moeda/fuso exigem uma consulta por conta.
async function sincronizarContasGoogleAds() {
  const cliente = await googleAdsClient();
  const ids = await cliente.contasAcessiveis();
  let gravadas = 0;
  // Falhas por conta sobem para a tela. Engolir isso deixava a lista com o ID pelado e nenhuma
  // explicação — o usuário via três números e não tinha como saber que uma consulta falhou.
  const avisos = [];
  for (const id of ids) {
    let info = {};
    let erroConta = null;
    try {
      const linhas = await cliente.coletar(id, gadsQueries.queryConta());
      info = (linhas[0] && linhas[0].customer) || {};
    } catch (err) {
      erroConta = err;
    }
    // Consultar a conta diretamente falha quando ela é acessada através de uma conta de
    // administrador. `customer_client` é lido a partir da própria conta e devolve os mesmos campos
    // nessa situação, então vale como segunda tentativa antes de desistir do nome.
    if (!info.descriptiveName) {
      try {
        const linhas = await cliente.coletar(id, gadsQueries.queryContaCliente(id));
        const cc = (linhas[0] && linhas[0].customerClient) || {};
        if (cc.descriptiveName) { info = cc; erroConta = null; }
      } catch (err) {
        erroConta = erroConta || err;
      }
    }
    if (erroConta) {
      const codigo = erroConta.codigo || null;
      console.warn(`[GOOGLE_ADS] conta ${id} sem detalhes: ${codigo || erroConta.message}`);
      avisos.push({ customerId: id, codigo, mensagem: String(erroConta.message).slice(0, 200) });
    }
    await pgPool.query(
      `INSERT INTO google_ads_customers (customer_id, nome, currency, timezone_name, manager, test_account, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (organization_id, customer_id) DO UPDATE SET
         nome = COALESCE(EXCLUDED.nome, google_ads_customers.nome),
         currency = COALESCE(EXCLUDED.currency, google_ads_customers.currency),
         timezone_name = COALESCE(EXCLUDED.timezone_name, google_ads_customers.timezone_name),
         manager = EXCLUDED.manager, test_account = EXCLUDED.test_account, atualizado_em = now()`,
      [id, info.descriptiveName || null, info.currencyCode || null, info.timeZone || null,
        info.manager === true, info.testAccount === true]
    );
    gravadas += 1;
  }
  return { contas: gravadas, apiCalls: cliente.apiCalls, avisos };
}

// A conta selecionada DESTA Organization. Mais de uma é erro de integridade — nunca "a primeira".
async function contaGoogleAdsSelecionada() {
  if (!pgPool) return null;
  const { rows } = await pgPool.query(
    'SELECT * FROM google_ads_customers WHERE organization_id = $1 AND selecionada', [orgDoContexto()]
  );
  if (rows.length > 1) throw new Error('integridade: mais de uma conta do Google Ads selecionada');
  return rows[0] || null;
}

// ── Sync de insights ────────────────────────────────────────────────────────────────────────

function diaISOBrasil(offsetDias = 0) {
  const agora = new Date(Date.now() - offsetDias * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
}

// Uma linha por dia, no nível pedido. `segments.date` é o que quebra por dia — sem ele a API
// devolveria o período inteiro somado numa linha só, e o gráfico diário seria impossível.
const UPSERT_INSIGHT_GOOGLE_ADS = `
  INSERT INTO google_ads_insights_daily
    (customer_id, level, entidade_id, data, campaign_id, impressoes, cliques, custo,
     conversoes, valor_conversoes, contagem_conversao, video_views, raw_data, atualizado_em)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
  ON CONFLICT (organization_id, customer_id, level, entidade_id, data, contagem_conversao) DO UPDATE SET
    campaign_id = EXCLUDED.campaign_id,
    impressoes = EXCLUDED.impressoes, cliques = EXCLUDED.cliques, custo = EXCLUDED.custo,
    conversoes = EXCLUDED.conversoes, valor_conversoes = EXCLUDED.valor_conversoes,
    video_views = EXCLUDED.video_views, raw_data = EXCLUDED.raw_data, atualizado_em = now()`;

async function sincronizarInsightsGoogleAds({ dias = GOOGLE_ADS_DIAS_BACKFILL, tipo = 'incremental' } = {}) {
  const conta = await contaGoogleAdsSelecionada();
  if (!conta) throw new Error('nenhuma conta do Google Ads selecionada');
  const inicio = Date.now();
  const de = diaISOBrasil(dias - 1);
  const ate = diaISOBrasil(0);
  let cliente = null;
  let linhasGravadas = 0;
  try {
    cliente = await googleAdsClient();
    for (const nivel of ['customer', 'campaign']) {
      for await (const linha of cliente.consultar(conta.customer_id, gadsQueries.queryInsights(nivel, de, ate))) {
        const m = gadsMetricas.normalizarLinha(linha);
        const campanhaId = linha.campaign && linha.campaign.id ? String(linha.campaign.id) : null;
        const entidadeId = nivel === 'campaign' ? campanhaId : conta.customer_id;
        if (!entidadeId || !m.data) continue;
        await pgPool.query(UPSERT_INSIGHT_GOOGLE_ADS, [
          conta.customer_id, nivel, entidadeId, m.data, campanhaId,
          m.impressoes, m.cliques, m.custo, m.conversoes, m.valorConversoes,
          m.contagemConversao, m.videoViews, JSON.stringify(linha),
        ]);
        linhasGravadas += 1;
        if (nivel === 'campaign' && campanhaId && linha.campaign) {
          await pgPool.query(
            `INSERT INTO google_ads_campaigns (customer_id, campaign_id, nome, raw_data, atualizado_em)
             VALUES ($1,$2,$3,$4, now())
             ON CONFLICT (organization_id, customer_id, campaign_id) DO UPDATE SET
               nome = COALESCE(EXCLUDED.nome, google_ads_campaigns.nome),
               raw_data = EXCLUDED.raw_data, atualizado_em = now()`,
            [conta.customer_id, campanhaId, linha.campaign.name || null, JSON.stringify(linha.campaign)]
          );
        }
      }
    }
    await pgPool.query(
      `UPDATE google_ads_connections SET last_successful_sync_at = now(), status = 'connected',
              last_error_code = NULL, last_error_message = NULL, atualizado_em = now() WHERE organization_id = $1`,
      [orgDoContexto()]
    );
    await pgPool.query('UPDATE google_ads_customers SET last_synced_at = now() WHERE customer_id = $1', [conta.customer_id]);
    await pgPool.query(
      `INSERT INTO google_ads_sync_logs (customer_id, tipo, status, periodo_inicio, periodo_fim, linhas_gravadas, api_calls, duracao_ms)
       VALUES ($1,$2,'ok',$3,$4,$5,$6,$7)`,
      [conta.customer_id, tipo, de, ate, linhasGravadas, cliente.apiCalls, Date.now() - inicio]
    );
    return { linhasGravadas, de, ate, apiCalls: cliente.apiCalls };
  } catch (err) {
    const codigo = err instanceof GoogleAdsApiError ? err.codigo : GADS_ERROS.SYNC_FAILED;
    await marcarErroGoogleAds(codigo, err.message, err.detalhe);
    await pgPool.query(
      `INSERT INTO google_ads_sync_logs (customer_id, tipo, status, periodo_inicio, periodo_fim, linhas_gravadas, api_calls, duracao_ms, erro_codigo, erro_mensagem)
       VALUES ($1,$2,'erro',$3,$4,$5,$6,$7,$8,$9)`,
      [conta.customer_id, tipo, de, ate, linhasGravadas, cliente ? cliente.apiCalls : 0, Date.now() - inicio, codigo, String(err.message).slice(0, 500)]
    ).catch(() => {});
    throw err;
  }
}

// ── Rotas ───────────────────────────────────────────────────────────────────────────────────

app.get('/api/admin/integrations/google-ads/status', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ conectado: false, oauthConfigurado: googleAdsOAuthConfigurado(), contas: [] });
  try {
    const conexao = await obterConexaoGoogleAds();
    const { rows: contas } = await pgPool.query(
      `SELECT customer_id, nome, currency, timezone_name, manager, test_account, selecionada,
              loja_atribuida, store_id, to_char(last_synced_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_synced_at
         FROM google_ads_customers ORDER BY selecionada DESC, nome NULLS LAST, customer_id`
    );
    res.json({
      oauthConfigurado: googleAdsOAuthConfigurado(),
      // "Conectado" significa TER TOKEN, não "nada falhou". Uma consulta ruim não desconecta
      // ninguém: tratar as duas coisas como uma só fazia a tela oferecer "Conectar" e esconder a
      // conta escolhida, empurrando o usuário a refazer um OAuth que estava perfeito.
      conectado: !!conexao && conexao.status !== 'disconnected' && (await exigirIntegracoes().temSegredo('google_ads', 'refresh_token')),
      status: (conexao && conexao.status) || 'disconnected',
      email: (conexao && conexao.google_account_email) || null,
      erroCodigo: (conexao && conexao.last_error_code) || null,
      erroMensagem: (conexao && conexao.last_error_message) || null,
      ultimoSync: conexao && conexao.last_successful_sync_at ? new Date(conexao.last_successful_sync_at).toISOString() : null,
      syncEmAndamento: googleAdsSyncEmAndamento(),
      contas: contas.map((c) => ({
        customerId: c.customer_id,
        customerIdFormatado: gadsMetricas.formatarCustomerId(c.customer_id),
        nome: c.nome,
        moeda: c.currency,
        fuso: c.timezone_name,
        manager: c.manager,
        teste: c.test_account,
        selecionada: c.selecionada,
        lojaAtribuida: c.loja_atribuida,
        // A conta é da Store da sessão? (canônico por store_id; texto legado só com chave legada.)
        atribuidaAEstaStore: contaAtribuidaAEstaStore(c),
        ultimoSync: c.last_synced_at,
      })),
    });
  } catch (err) {
    console.error(`[GOOGLE_ADS] falha no status: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler o status do Google Ads' });
  }
});

app.post('/api/admin/integrations/google-ads/contas/sincronizar', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  try {
    res.json(await sincronizarContasGoogleAds());
  } catch (err) {
    console.error(`[GOOGLE_ADS] falha ao listar contas: ${err.message}`);
    res.status(502).json({ error: err.message, codigo: err.codigo || null });
  }
});

app.post('/api/admin/integrations/google-ads/contas/:customerId/selecionar', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const id = gadsMetricas.normalizarCustomerId(req.params.customerId);
  if (!id) return res.status(400).json({ error: 'customer id inválido' });
  // Store canônica; a chave legada (nula na Store nativa) só espelha o texto histórico.
  const loja = lojaLegadaDoContextoOuNula();
  const org = orgDoContexto();
  const conn = await pgPool.connect();
  try {
    await conn.query('BEGIN');
    const { rows: existe } = await conn.query(
      'SELECT 1 FROM google_ads_customers WHERE organization_id = $1 AND customer_id = $2', [org, id]
    );
    if (!existe.length) { await conn.query('ROLLBACK'); return res.status(404).json({ error: 'conta não encontrada' }); }
    // PD-016: o customer passa a ser desta Organization; se já for de outra, 409 (sem transferir).
    const { rows: [posse] } = await conn.query('SELECT integracao_reivindicar_recurso($1, $2, $3) AS ok', ['google_ads', 'customer', id]);
    if (!posse.ok) {
      await conn.query('ROLLBACK');
      return res.status(409).json({ error: 'esta conta do Google Ads já está conectada a outra organization', codigo: 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE' });
    }
    // Limpar antes de marcar: o índice parcial recusaria duas selecionadas, e sem transação a
    // janela entre as duas escritas deixaria o painel sem conta nenhuma.
    const { rows: anteriores } = await conn.query(
      'UPDATE google_ads_customers SET selecionada = false WHERE organization_id = $1 AND selecionada AND customer_id <> $2 RETURNING customer_id',
      [org, id]
    );
    for (const a of anteriores) {
      await conn.query('SELECT integracao_liberar_recursos($1, $2, $3)', ['google_ads', 'customer', a.customer_id]);
    }
    await conn.query(
      'UPDATE google_ads_customers SET selecionada = true, store_id = $4, loja_atribuida = $2, atualizado_em = now() WHERE organization_id = $3 AND customer_id = $1',
      [id, loja, org, storeDoContexto()]
    );
    await conn.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error(`[GOOGLE_ADS] falha ao selecionar conta: ${err.message}`);
    res.status(500).json({ error: 'não foi possível selecionar a conta' });
  } finally {
    conn.release();
  }
});

// O sync NÃO bloqueia a requisição: entre paginação e retries (até 60s por tentativa) ele passa do
// tempo que o proxy na frente do app espera, e a resposta vira um 502 genérico que não diz nada —
// escondendo justamente o erro real, que fica guardado na conexão. A rota dispara e responde na
// hora; a tela acompanha pelo status. Mesma regra que a integração do Meta já seguia.
// Por Organization: a sincronização de uma não bloqueia (nem é reportada para) outra.
const googleAdsSyncEmAndamentoPorOrg = new Set();
const googleAdsSyncEmAndamento = () => googleAdsSyncEmAndamentoPorOrg.has(orgDoContexto());

// Atribuir a loja sem precisar refazer a escolha da conta. Sem isso, o aviso de "sem loja
// atribuída" apontava um problema e não oferecia caminho: era preciso passar por "Trocar conta".
app.post('/api/admin/integrations/google-ads/contas/:customerId/loja', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const id = gadsMetricas.normalizarCustomerId(req.params.customerId);
  if (!id) return res.status(400).json({ error: 'customer id inválido' });
  // Store canônica; a chave legada (nula na Store nativa) só espelha o texto histórico.
  const storeId = storeDoContexto();
  const loja = lojaLegadaDoContextoOuNula();
  try {
    const { rowCount } = await pgPool.query(
      'UPDATE google_ads_customers SET store_id = $4, loja_atribuida = $2, atualizado_em = now() WHERE organization_id = $3 AND customer_id = $1',
      [id, loja, orgDoContexto(), storeId]
    );
    if (!rowCount) return res.status(404).json({ error: 'conta não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[GOOGLE_ADS] falha ao atribuir loja: ${err.message}`);
    res.status(500).json({ error: 'não foi possível atribuir a loja' });
  }
});

app.post('/api/admin/integrations/google-ads/sync', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  if (googleAdsSyncEmAndamento()) return res.status(409).json({ error: 'já existe uma sincronização em andamento' });
  const dias = Math.min(Math.max(parseInt(req.body && req.body.dias, 10) || GOOGLE_ADS_DIAS_BACKFILL, 1), GOOGLE_ADS_DIAS_IMPORT_INICIAL);
  const conta = await contaGoogleAdsSelecionada();
  if (!conta) return res.status(400).json({ error: 'escolha uma conta de anúncios antes de sincronizar' });

  const orgDaSync = orgDoContexto();
  googleAdsSyncEmAndamentoPorOrg.add(orgDaSync);
  sincronizarInsightsGoogleAds({ dias, tipo: req.body && req.body.tipo === 'inicial' ? 'inicial' : 'manual' })
    .catch((err) => {
      // O erro já foi gravado na conexão por sincronizarInsightsGoogleAds; aqui só evita rejeição
      // não tratada derrubar o processo.
      console.error(`[GOOGLE_ADS] sync falhou: ${err.codigo || ''} ${err.message}`);
    })
    .finally(() => { googleAdsSyncEmAndamentoPorOrg.delete(orgDaSync); });

  res.status(202).json({ iniciado: true, dias });
});

// Visão do período, lida só do Postgres. As taxas são recalculadas dos somatórios pelo mesmo
// módulo que o sync usa — nunca lidas da API nem tiradas de média.
app.get('/api/admin/analytics/google-ads/overview', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'exige Postgres configurado' });
  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);
  try {
    const conta = await contaGoogleAdsSelecionada();
    if (!conta) return res.json({ conectado: false, conta: null, total: null, serie: [], campanhas: [] });
    const conexaoAds = await obterConexaoGoogleAds();
    const desde = diaISOBrasil(dias - 1);

    const { rows: serie } = await pgPool.query(
      `SELECT to_char(data, 'YYYY-MM-DD') AS dia, impressoes, cliques, custo, conversoes, valor_conversoes, video_views
         FROM google_ads_insights_daily
        WHERE customer_id = $1 AND level = 'customer' AND contagem_conversao = 'conversions' AND data >= $2::date
        ORDER BY data`,
      [conta.customer_id, desde]
    );
    const linhas = serie.map((r) => ({
      data: r.dia,
      impressoes: Number(r.impressoes), cliques: Number(r.cliques), custo: Number(r.custo),
      conversoes: Number(r.conversoes), valorConversoes: Number(r.valor_conversoes),
      videoViews: r.video_views === null ? null : Number(r.video_views),
    }));

    const { rows: campanhas } = await pgPool.query(
      `SELECT i.campaign_id, COALESCE(c.nome, i.campaign_id) AS nome,
              SUM(i.impressoes)::bigint AS impressoes, SUM(i.cliques)::bigint AS cliques,
              SUM(i.custo) AS custo, SUM(i.conversoes) AS conversoes, SUM(i.valor_conversoes) AS valor_conversoes
         FROM google_ads_insights_daily i
         LEFT JOIN google_ads_campaigns c
                ON c.customer_id = i.customer_id AND c.campaign_id = i.campaign_id
        WHERE i.customer_id = $1 AND i.level = 'campaign' AND i.contagem_conversao = 'conversions'
          AND i.data >= $2::date
        GROUP BY i.campaign_id, c.nome
        ORDER BY SUM(i.custo) DESC`,
      [conta.customer_id, desde]
    );

    res.json({
      conectado: true,
      conta: {
        customerId: conta.customer_id,
        customerIdFormatado: gadsMetricas.formatarCustomerId(conta.customer_id),
        nome: conta.nome, moeda: conta.currency, lojaAtribuida: conta.loja_atribuida,
        atribuidaAEstaStore: contaAtribuidaAEstaStore(conta),
      },
      dias,
      // As datas exatas do recorte. Sem elas não existe comparação possível com a interface do
      // Google: "últimos 7 dias" ali exclui hoje, aqui inclui, e os dois números divergem sem que
      // ninguém consiga dizer por quê.
      de: desde,
      ate: diaISOBrasil(0),
      // Quando estes números foram buscados. O dia de hoje muda ao longo do dia, então sem a hora
      // não dá para saber se uma divergência é erro ou só defasagem.
      sincronizadoEm: conexaoAds && conexaoAds.last_successful_sync_at
        ? new Date(conexaoAds.last_successful_sync_at).toISOString()
        : null,
      total: gadsMetricas.totalizar(linhas),
      serie: linhas,
      campanhas: campanhas.map((c) => {
        const t = gadsMetricas.totalizar([{
          impressoes: Number(c.impressoes), cliques: Number(c.cliques), custo: Number(c.custo),
          conversoes: Number(c.conversoes), valorConversoes: Number(c.valor_conversoes),
        }]);
        return { campaignId: c.campaign_id, nome: c.nome, ...t };
      }),
    });
  } catch (err) {
    console.error(`[GOOGLE_ADS] falha no overview: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler os dados do Google Ads' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Meta Ads — Fases 1 e 2 (docs/meta-ads-analytics-integracao-v2.md §72-73)
// ═══════════════════════════════════════════════════════════════════════════════════════════
// SOMENTE LEITURA. A V1 pede apenas `ads_read` (spec §2): nada aqui pausa campanha, mexe em
// orçamento ou cria anúncio, e não deve passar a mexer sem um módulo separado (spec §85).
//
// Diferença importante em relação ao GA4: a Meta NÃO tem refresh token. O que existe é um token de
// usuário de longa duração (~60 dias) que se renova trocando um token ainda válido por outro. Se
// ele expirar de vez, não há renovação automática possível — a conexão vira "error" e alguém
// precisa reconectar. Por isso o job de renovação roda bem antes do vencimento.
//
// A regra de ouro do módulo (spec §31): o dashboard NUNCA fala com a Meta. Sync grava no Postgres,
// e as telas leem só do Postgres. Isso dá velocidade, histórico, imunidade a rate limit e
// comparação com GA4/loja sem depender da Meta estar no ar.

// Fase 4: o aviso "Google Ads não conectado" vale quando ESTA Organization tem a integração (antes,
// uma env da instalação — GOOGLE_ADS_EM_USO — decidia por todos os tenants).

const META_OAUTH_DIALOG = 'https://www.facebook.com';
const META_GRAPH = 'https://graph.facebook.com';
// `ads_read` é o menor escopo que lê campanhas e Insights. `ads_management` fica de fora
// deliberadamente (spec §2) — pedir permissão de escrita que não usamos aumenta o risco e a
// exigência de App Review sem nenhum ganho.
const META_OAUTH_SCOPE = 'ads_read';
// Versão da Graph API em um lugar só (spec §5.1). Configurável porque a spec §92 manda confirmar a
// versão vigente na documentação oficial — nunca espalhar a versão por vários arquivos.
const META_GRAPH_VERSION = process.env.META_API_VERSION || META_VERSAO_PADRAO;
// Importação inicial sugerida pela spec §32. Quebrada em janelas (ver META_JANELA_DIAS) pra não
// pedir 90 dias × 4 níveis numa tacada só.
const META_DIAS_IMPORT_INICIAL = 90;
const META_JANELA_DIAS = 30;
// Backfill de atribuição (spec §34): conversão pode ser reportada dias depois, então dia nenhum é
// considerado fechado. O sync noturno refaz esta janela inteira (spec §35).
const META_DIAS_BACKFILL = Number(process.env.META_BACKFILL_DIAS || 28);
// Periodicidade do incremental (spec §33: "30–60 minutos", configurável).
const META_INTERVALO_SYNC_MIN = Number(process.env.META_SYNC_INTERVALO_MIN || 45);

function metaOAuthConfigurado() {
  return !!(process.env.META_ADS_APP_ID && process.env.META_ADS_APP_SECRET && process.env.META_ADS_OAUTH_REDIRECT_URI);
}

// A Meta recomenda (e exige, se o app tiver "Require App Secret" ligado) que toda chamada
// server-side leve o HMAC do token com o app secret. Sem isso a API responde 190 — que parece
// "token expirado" e manda o usuário reconectar pra sempre, sem nunca resolver.
function metaAppsecretProof(accessToken) {
  if (!process.env.META_ADS_APP_SECRET) return null;
  return crypto.createHmac('sha256', process.env.META_ADS_APP_SECRET).update(accessToken).digest('hex');
}

// ── MetaCredentialsService (spec §6) ────────────────────────────────────────────────────────
// Tudo que toca o token passa por aqui. O token sai do banco criptografado e só é decifrado no
// momento de montar o cliente — nunca é devolvido por rota nenhuma, nunca entra em log.


async function obterConexaoMeta() {
  if (!pgPool) return null;
  const { rows } = await pgPool.query('SELECT * FROM meta_connections WHERE organization_id = $1', [orgDoContexto()]);
  return rows[0] || null;
}

// O DTO que o frontend enxerga. Note o que NÃO está aqui: access_token, appsecret_proof, escopos
// sensíveis. O id da conta é mascarado na UI (spec §6/§61), mas o valor cru é necessário pro
// seletor de conta — quem mascara é o frontend, na exibição.
function mapMetaConexao(r) {
  if (!r) {
    return {
      status: 'disconnected', metaUserNome: null, conectadoEm: null,
      tokenExpiraEm: null, ultimoSyncEm: null, ultimoErro: null, ultimoErroCodigo: null,
    };
  }
  return {
    status: r.status,
    metaUserNome: r.meta_user_nome,
    conectadoEm: r.connected_at,
    tokenExpiraEm: r.token_expires_at,
    ultimoSyncEm: r.last_successful_sync_at,
    ultimoErro: r.last_error_message,
    ultimoErroCodigo: r.last_error_code,
  };
}

// Fase 4: o token vai para integration_secrets (integração 'meta' da Organization).
async function salvarTokenMeta({ accessToken, expiresAt, userId, userNome, escopos }) {
  await exigirIntegracoes().gravarSegredo('meta', 'access_token', accessToken, { expiresAt: expiresAt || null });
  await pgPool.query(
    `INSERT INTO meta_connections (id, token_expires_at, meta_user_id, meta_user_nome, escopos, status, connected_at, last_error_at, last_error_code, last_error_message, atualizado_em)
     VALUES (1, $1, $2, $3, $4, 'connected', now(), NULL, NULL, NULL, now())
     ON CONFLICT (organization_id) DO UPDATE SET
       token_expires_at = $1, meta_user_id = $2, meta_user_nome = $3,
       escopos = $4, status = 'connected', connected_at = now(),
       last_error_at = NULL, last_error_code = NULL, last_error_message = NULL, atualizado_em = now()`,
    [expiresAt, userId || null, userNome || null, escopos || null]
  );
}

// Mensagem de erro passa por mascararToken antes de ser gravada: um erro da Meta às vezes ecoa a
// querystring da requisição, e a querystring pode conter appsecret_proof (spec §65).
async function marcarErroMeta(codigo, mensagem) {
  if (!pgPool) return;
  await pgPool.query(
    `INSERT INTO meta_connections (id, status, last_error_at, last_error_code, last_error_message, atualizado_em)
     VALUES (1, 'error', now(), $1, $2, now())
     ON CONFLICT (organization_id) DO UPDATE SET
       status = 'error', last_error_at = now(), last_error_code = $1, last_error_message = $2, atualizado_em = now()`,
    [codigo || META_ERROS.API_ERROR, mascararToken(mensagem).slice(0, 500)]
  );
}

async function desconectarMeta() {
  // Apaga o token e o histórico de mídia junto: manter campanha/insight de uma conta que não está
  // mais conectada faria a tela mostrar número velho como se fosse atual.
  // Só a Organization da sessão, numa transação. Nunca TRUNCATE: ele ignora RLS e apagaria a mídia
  // de todas as Organizations.
  const org = orgDoContexto();
  const integracoes = exigirIntegracoes();
  // Revoga no provider (best-effort): DELETE /me/permissions remove a autorização do app.
  await integracoes.usarSegredo('meta', 'access_token', async (token) => {
    const url = new URL(`${META_GRAPH}/${META_GRAPH_VERSION}/me/permissions`);
    const proof = metaAppsecretProof(token);
    if (proof) url.searchParams.set('appsecret_proof', proof);
    await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }, { aceitarVencido: true }).catch(() => {});
  // Segredo e posse das contas de anúncio — só desta Organization.
  await integracoes.desconectar('meta');
  const cliente = await pgPool.connect();
  try {
    await cliente.query('BEGIN');
    for (const tabela of ['meta_insights_daily', 'meta_ads', 'meta_adsets', 'meta_campaigns', 'meta_creatives', 'meta_sync_logs', 'meta_ad_accounts']) {
      await cliente.query(`DELETE FROM ${tabela} WHERE organization_id = $1`, [org]);
    }
    await cliente.query(
      `UPDATE meta_connections SET token_expires_at = NULL, meta_user_id = NULL,
         meta_user_nome = NULL, escopos = NULL, status = 'disconnected', connected_at = NULL,
         last_successful_sync_at = NULL, last_error_at = NULL, last_error_code = NULL, last_error_message = NULL,
         atualizado_em = now() WHERE organization_id = $1`,
      [org]
    );
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// ── OAuth (spec §5.2) ───────────────────────────────────────────────────────────────────────
// Estas três chamadas usam o app secret e por isso NÃO passam pelo MetaClient (que fala com token
// de usuário). São as únicas do módulo que mandam o secret pra Meta.

async function metaTrocarCodePorToken(code) {
  const url = new URL(`${META_GRAPH}/${META_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', process.env.META_ADS_APP_ID);
  url.searchParams.set('client_secret', process.env.META_ADS_APP_SECRET);
  url.searchParams.set('redirect_uri', process.env.META_ADS_OAUTH_REDIRECT_URI);
  url.searchParams.set('code', code);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(mascararToken(data.error?.message || 'falha ao trocar o código de autorização por um token'));
  return data;
}

// O token que sai do fluxo OAuth dura ~1h. Esta troca o transforma no de longa duração (~60 dias).
// A mesma chamada, com um token de longa duração ainda válido, renova o prazo — é assim que a
// renovação automática funciona, já que não existe refresh token na Meta.
async function metaTokenLongaDuracao(tokenCurto) {
  const url = new URL(`${META_GRAPH}/${META_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', process.env.META_ADS_APP_ID);
  url.searchParams.set('client_secret', process.env.META_ADS_APP_SECRET);
  url.searchParams.set('fb_exchange_token', tokenCurto);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(mascararToken(data.error?.message || 'falha ao obter token de longa duração'));
  return data;
}

// Única forma confiável de saber quando o token vence e quais escopos ele realmente tem — o
// `expires_in` da troca nem sempre vem. `expires_at: 0` significa token que não expira (raro, mas
// existe em token de sistema); tratamos como "sem data de expiração".
async function metaInspecionarToken(accessToken) {
  const url = new URL(`${META_GRAPH}/${META_GRAPH_VERSION}/debug_token`);
  url.searchParams.set('input_token', accessToken);
  url.searchParams.set('access_token', `${process.env.META_ADS_APP_ID}|${process.env.META_ADS_APP_SECRET}`);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(mascararToken(data.error?.message || 'falha ao validar o token com a Meta'));
  const info = data.data || {};
  return {
    valido: !!info.is_valid,
    userId: info.user_id || null,
    escopos: Array.isArray(info.scopes) ? info.scopes.join(',') : null,
    expiraEm: info.expires_at ? new Date(info.expires_at * 1000) : null,
  };
}

// ── Cliente autenticado ─────────────────────────────────────────────────────────────────────

// Token da Meta da Organization do contexto, entregue a `usar`. Falhas viram MetaApiError com a
// instrução certa (conectar, reconectar), nunca com o segredo.
async function comTokenMeta(usar) {
  const conexao = await obterConexaoMeta();
  if (!conexao || conexao.status === 'disconnected') {
    throw new MetaApiError(META_ERROS.TOKEN_EXPIRED, 'a Meta não está conectada — conecte a conta em Integrações');
  }
  try {
    return await exigirIntegracoes().usarSegredo('meta', 'access_token', usar);
  } catch (err) {
    const mensagem = err.codigo === 'SECRET_EXPIRED'
      ? 'o token da Meta expirou — reconecte a conta'
      : err.codigo === 'SECRET_UNREADABLE'
        ? 'não foi possível decifrar o token salvo — reconecte a Meta'
        : err.codigo === 'INTEGRATION_NOT_CONNECTED'
          ? 'a Meta não está conectada — conecte a conta em Integrações'
          : null;
    if (!mensagem) throw err;
    await marcarErroMeta(META_ERROS.TOKEN_EXPIRED, mensagem);
    throw new MetaApiError(META_ERROS.TOKEN_EXPIRED, mensagem);
  }
}

async function criarMetaClient() {
  const token = await comTokenMeta((t) => t);
  return new MetaClient({
    accessToken: token,
    appsecretProof: metaAppsecretProof(token),
    versao: META_GRAPH_VERSION,
    onLog: ({ evento, caminho, tentativa, esperaMs, codigo }) => {
      console.warn(`[META] ${evento} ${caminho} tentativa=${tentativa} espera=${esperaMs}ms codigo=${codigo}`);
    },
  });
}

async function metaContaSelecionada() {
  if (!pgPool) return null;
  const { rows } = await pgPool.query(
    'SELECT * FROM meta_ad_accounts WHERE organization_id = $1 AND selecionada', [orgDoContexto()]
  );
  if (rows.length > 1) throw new Error('integridade: mais de uma conta de anúncios da Meta selecionada');
  return rows[0] || null;
}

// ── Sync de contas de anúncio (spec §9, §24) ────────────────────────────────────────────────
// Nem todo campo existe em toda conta (spec §9: "não assumir que todos os campos estarão
// disponíveis") — por isso tudo entra com COALESCE/null em vez de dar erro por campo ausente.

const META_CAMPOS_CONTA = 'id,account_id,name,account_status,currency,timezone_name,timezone_offset_hours_utc,amount_spent,spend_cap';

async function sincronizarContasMeta(client) {
  const contas = await client.coletar('me/adaccounts', { fields: META_CAMPOS_CONTA, limit: 100 });
  for (const c of contas) {
    await pgPool.query(
      `INSERT INTO meta_ad_accounts (meta_account_id, nome, currency, timezone_name, timezone_offset_hours_utc, account_status, amount_spent, spend_cap, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (organization_id, meta_account_id) DO UPDATE SET
         nome = EXCLUDED.nome, currency = EXCLUDED.currency, timezone_name = EXCLUDED.timezone_name,
         timezone_offset_hours_utc = EXCLUDED.timezone_offset_hours_utc, account_status = EXCLUDED.account_status,
         amount_spent = EXCLUDED.amount_spent, spend_cap = EXCLUDED.spend_cap, atualizado_em = now()`,
      [
        c.id, c.name || null, c.currency || null, c.timezone_name || null,
        metaActions.parseNumero(c.timezone_offset_hours_utc), c.account_status ?? null,
        // amount_spent e spend_cap vêm em centavos, como string.
        metaActions.parseNumero(c.amount_spent) === null ? null : metaActions.parseNumero(c.amount_spent) / 100,
        metaActions.parseNumero(c.spend_cap) === null ? null : metaActions.parseNumero(c.spend_cap) / 100,
      ]
    );
  }
  return contas.length;
}

// ── Sync da hierarquia de mídia (spec §10-13) ───────────────────────────────────────────────
// Um upsert por entidade, com o ID nativo da Meta como chave: renomear uma campanha na Meta
// atualiza a linha existente em vez de criar uma nova órfã (spec §35).

const META_CAMPOS_CAMPANHA = 'id,name,status,effective_status,objective,created_time,updated_time,start_time,stop_time';
const META_CAMPOS_ADSET = 'id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,created_time,updated_time,start_time,end_time';
// A expansão `creative{...}` traz o criativo junto do anúncio: 1 chamada em vez de uma por anúncio
// (spec §69 proíbe N+1 nessa cadeia).
const META_CAMPOS_AD = 'id,name,status,effective_status,campaign_id,adset_id,created_time,updated_time,creative{id,name,title,body,thumbnail_url,image_url,object_story_id,asset_feed_spec,object_story_spec}';

// Orçamento da Meta vem em centavos da moeda da conta, como string. Converte uma vez só, aqui.
function metaCentavosParaValor(v) {
  const n = metaActions.parseNumero(v);
  return n === null ? null : n / 100;
}

async function sincronizarCampanhasMeta(client, contaId) {
  let total = 0;
  for await (const c of client.paginar(`${contaId}/campaigns`, { fields: META_CAMPOS_CAMPANHA, limit: 200 })) {
    await pgPool.query(
      `INSERT INTO meta_campaigns (meta_account_id, meta_campaign_id, nome, objective, status, effective_status, start_time, stop_time, created_time, updated_time, raw_data, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (organization_id, meta_campaign_id) DO UPDATE SET
         nome = EXCLUDED.nome, objective = EXCLUDED.objective, status = EXCLUDED.status,
         effective_status = EXCLUDED.effective_status, start_time = EXCLUDED.start_time,
         stop_time = EXCLUDED.stop_time, updated_time = EXCLUDED.updated_time,
         raw_data = EXCLUDED.raw_data, atualizado_em = now()`,
      [contaId, c.id, c.name || null, c.objective || null, c.status || null, c.effective_status || null,
        c.start_time || null, c.stop_time || null, c.created_time || null, c.updated_time || null, JSON.stringify(c)]
    );
    total += 1;
  }
  return total;
}

async function sincronizarAdSetsMeta(client, contaId) {
  let total = 0;
  for await (const a of client.paginar(`${contaId}/adsets`, { fields: META_CAMPOS_ADSET, limit: 200 })) {
    await pgPool.query(
      `INSERT INTO meta_adsets (meta_account_id, meta_campaign_id, meta_adset_id, nome, status, effective_status, optimization_goal, billing_event, bid_strategy, daily_budget, lifetime_budget, start_time, end_time, created_time, updated_time, raw_data, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (organization_id, meta_adset_id) DO UPDATE SET
         meta_campaign_id = EXCLUDED.meta_campaign_id, nome = EXCLUDED.nome, status = EXCLUDED.status,
         effective_status = EXCLUDED.effective_status, optimization_goal = EXCLUDED.optimization_goal,
         billing_event = EXCLUDED.billing_event, bid_strategy = EXCLUDED.bid_strategy,
         daily_budget = EXCLUDED.daily_budget, lifetime_budget = EXCLUDED.lifetime_budget,
         start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
         updated_time = EXCLUDED.updated_time, raw_data = EXCLUDED.raw_data, atualizado_em = now()`,
      [contaId, a.campaign_id || null, a.id, a.name || null, a.status || null, a.effective_status || null,
        a.optimization_goal || null, a.billing_event || null, a.bid_strategy || null,
        metaCentavosParaValor(a.daily_budget), metaCentavosParaValor(a.lifetime_budget),
        a.start_time || null, a.end_time || null, a.created_time || null, a.updated_time || null, JSON.stringify(a)]
    );
    total += 1;
  }
  return total;
}

async function sincronizarAdsECriativosMeta(client, contaId) {
  let ads = 0;
  let criativos = 0;
  for await (const ad of client.paginar(`${contaId}/ads`, { fields: META_CAMPOS_AD, limit: 200 })) {
    const cr = ad.creative || null;
    if (cr && cr.id) {
      await pgPool.query(
        `INSERT INTO meta_creatives (meta_account_id, meta_creative_id, nome, title, body, thumbnail_url, image_url, object_story_id, asset_feed_spec, object_story_spec, raw_data, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (organization_id, meta_creative_id) DO UPDATE SET
           nome = EXCLUDED.nome, title = EXCLUDED.title, body = EXCLUDED.body,
           thumbnail_url = EXCLUDED.thumbnail_url, image_url = EXCLUDED.image_url,
           object_story_id = EXCLUDED.object_story_id, asset_feed_spec = EXCLUDED.asset_feed_spec,
           object_story_spec = EXCLUDED.object_story_spec, raw_data = EXCLUDED.raw_data, atualizado_em = now()`,
        [contaId, cr.id, cr.name || null, cr.title || null, cr.body || null, cr.thumbnail_url || null,
          cr.image_url || null, cr.object_story_id || null,
          cr.asset_feed_spec ? JSON.stringify(cr.asset_feed_spec) : null,
          cr.object_story_spec ? JSON.stringify(cr.object_story_spec) : null, JSON.stringify(cr)]
      );
      criativos += 1;
    }
    await pgPool.query(
      `INSERT INTO meta_ads (meta_account_id, meta_campaign_id, meta_adset_id, meta_creative_id, meta_ad_id, nome, status, effective_status, created_time, updated_time, raw_data, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (organization_id, meta_ad_id) DO UPDATE SET
         meta_campaign_id = EXCLUDED.meta_campaign_id, meta_adset_id = EXCLUDED.meta_adset_id,
         meta_creative_id = EXCLUDED.meta_creative_id, nome = EXCLUDED.nome, status = EXCLUDED.status,
         effective_status = EXCLUDED.effective_status, updated_time = EXCLUDED.updated_time,
         raw_data = EXCLUDED.raw_data, atualizado_em = now()`,
      [contaId, ad.campaign_id || null, ad.adset_id || null, cr ? cr.id : null, ad.id, ad.name || null,
        ad.status || null, ad.effective_status || null, ad.created_time || null, ad.updated_time || null, JSON.stringify(ad)]
    );
    ads += 1;
  }
  return { ads, criativos };
}

// ── Sync de Insights (spec §14, §21, §29) ───────────────────────────────────────────────────
// `time_increment=1` traz uma linha POR DIA, que é o que permite o painel reconstruir qualquer
// período depois sem consultar a Meta de novo (spec §14).
// `use_unified_attribution_setting=true` faz a Meta usar a configuração de atribuição da própria
// conta/anúncio — o mesmo modelo que o Ads Manager mostra. Gravamos o marcador 'unified' junto do
// snapshot pra que fique registrado com que configuração aquele número foi medido (spec §21),
// e pra que trocar de configuração no futuro gere linhas novas em vez de sobrescrever o histórico.
const META_ATTRIBUTION_MARCADOR = 'unified';

function metaDataISO(d) {
  return d.toISOString().slice(0, 10);
}

// Quebra o período em janelas de META_JANELA_DIAS (spec §32: "dividir por janelas"). Pedir 90 dias
// no nível `ad` de uma conta grande numa chamada só é o caminho mais curto pro rate limit.
function metaJanelas(desde, ate) {
  const janelas = [];
  const fim = new Date(`${ate}T00:00:00Z`);
  let cursor = new Date(`${desde}T00:00:00Z`);
  while (cursor <= fim) {
    const fimJanela = new Date(cursor);
    fimJanela.setUTCDate(fimJanela.getUTCDate() + META_JANELA_DIAS - 1);
    janelas.push({ since: metaDataISO(cursor), until: metaDataISO(fimJanela > fim ? fim : fimJanela) });
    cursor = new Date(fimJanela);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return janelas;
}

// Grava em lotes de multi-row INSERT: 90 dias × centenas de anúncios são milhares de linhas, e um
// INSERT por linha transformaria a importação inicial em minutos de ida e volta com o banco.
const META_LOTE_INSIGHTS = 200;

async function gravarLoteInsights(contaId, level, linhas) {
  if (!linhas.length) return { criados: 0, atualizados: 0 };
  // O SQL é montado em lib/meta/insights.js a partir de UMA lista de colunas — assim não existe a
  // possibilidade clássica deste tipo de INSERT: acrescentar uma coluna e esquecer do valor
  // correspondente, desalinhando todos os $N seguintes sem o Postgres reclamar.
  const { sql, params } = metaInsights.montarUpsertInsights(contaId, level, linhas);
  const { rows } = await pgPool.query(sql, params);
  const criados = rows.filter((r) => r.inserido).length;
  return { criados, atualizados: rows.length - criados };
}

async function sincronizarInsightsMeta(client, contaId, level, desde, ate) {
  let processados = 0;
  let criados = 0;
  let atualizados = 0;
  for (const janela of metaJanelas(desde, ate)) {
    let lote = [];
    for await (const bruta of client.paginar(`${contaId}/insights`, {
      level,
      time_increment: 1,
      time_range: janela,
      fields: metaInsights.CAMPOS_INSIGHTS.join(','),
      use_unified_attribution_setting: true,
      limit: 500,
    })) {
      lote.push(metaInsights.normalizarLinhaInsight(bruta, { level, attributionSetting: META_ATTRIBUTION_MARCADOR }));
      if (lote.length >= META_LOTE_INSIGHTS) {
        const r = await gravarLoteInsights(contaId, level, lote);
        criados += r.criados; atualizados += r.atualizados; processados += lote.length;
        lote = [];
      }
    }
    if (lote.length) {
      const r = await gravarLoteInsights(contaId, level, lote);
      criados += r.criados; atualizados += r.atualizados; processados += lote.length;
    }
  }
  return { processados, criados, atualizados };
}

// ── Orquestração + MetaSyncLog (spec §36) ───────────────────────────────────────────────────
// Só uma sincronização por vez. Sem esta trava, o incremental de 45min podia entrar por cima de
// uma importação inicial de 90 dias ainda rodando e as duas brigarem pelo rate limit da Meta.
// Por Organization: a sincronização de uma não bloqueia (nem é reportada para) outra.
const metaSyncEmAndamentoPorOrg = new Set();
const metaSyncEmAndamento = () => metaSyncEmAndamentoPorOrg.has(orgDoContexto());

async function abrirSyncLogMeta(contaId, tipo, desde, ate) {
  const { rows } = await pgPool.query(
    `INSERT INTO meta_sync_logs (meta_account_id, sync_type, status, date_from, date_to) VALUES ($1,$2,'processando',$3,$4) RETURNING id`,
    [contaId, tipo, desde, ate]
  );
  return rows[0].id;
}

async function fecharSyncLogMeta(id, { status, processados = 0, criados = 0, atualizados = 0, apiCalls = 0, erroCodigo = null, erroMensagem = null }) {
  await pgPool.query(
    `UPDATE meta_sync_logs SET status = $2, finished_at = now(), records_processed = $3, records_created = $4,
       records_updated = $5, api_calls = $6, error_code = $7, error_message = $8 WHERE id = $1`,
    [id, status, processados, criados, atualizados, apiCalls, erroCodigo, erroMensagem ? mascararToken(erroMensagem).slice(0, 500) : null]
  );
}

// `tipo`: INITIAL_IMPORT | INCREMENTAL | BACKFILL | MANUAL (spec §36).
// A hierarquia (campanhas/adsets/ads/criativos) é re-sincronizada em tudo que não é INCREMENTAL,
// porque é ela que corrige nome e status alterados na Meta (spec §35).
async function sincronizarMeta({ tipo = 'MANUAL', dias = null } = {}) {
  if (!pgPool) throw new Error('a integração com a Meta exige Postgres configurado');
  if (metaSyncEmAndamento()) throw new Error('já existe uma sincronização da Meta em andamento');
  const conta = await metaContaSelecionada();
  if (!conta) throw new MetaApiError(META_ERROS.ACCOUNT_NOT_FOUND, 'selecione uma conta de anúncios da Meta antes de sincronizar');

  const janelaDias = dias ?? (tipo === 'INITIAL_IMPORT' ? META_DIAS_IMPORT_INICIAL : tipo === 'INCREMENTAL' ? 2 : META_DIAS_BACKFILL);
  const ate = metaDataISO(new Date());
  const desdeDate = new Date();
  desdeDate.setUTCDate(desdeDate.getUTCDate() - (janelaDias - 1));
  const desde = metaDataISO(desdeDate);

  const orgDaSync = orgDoContexto();
  metaSyncEmAndamentoPorOrg.add(orgDaSync);
  const logId = await abrirSyncLogMeta(conta.meta_account_id, tipo, desde, ate);
  let client = null;
  let processados = 0;
  let criados = 0;
  let atualizados = 0;
  try {
    client = await criarMetaClient();
    if (tipo !== 'INCREMENTAL') {
      processados += await sincronizarCampanhasMeta(client, conta.meta_account_id);
      processados += await sincronizarAdSetsMeta(client, conta.meta_account_id);
      const r = await sincronizarAdsECriativosMeta(client, conta.meta_account_id);
      processados += r.ads + r.criativos;
    }
    // Os quatro níveis são buscados separadamente porque a Meta não devolve hierarquia agregada:
    // o total da conta NÃO é a soma dos anúncios (há dedupe de alcance e gasto fora de anúncio).
    for (const level of metaInsights.NIVEIS) {
      const r = await sincronizarInsightsMeta(client, conta.meta_account_id, level, desde, ate);
      processados += r.processados; criados += r.criados; atualizados += r.atualizados;
    }
    await pgPool.query('UPDATE meta_ad_accounts SET last_synced_at = now() WHERE meta_account_id = $1', [conta.meta_account_id]);
    await pgPool.query(`UPDATE meta_connections SET last_successful_sync_at = now(), status = 'connected', last_error_code = NULL, last_error_message = NULL, atualizado_em = now() WHERE organization_id = $1`, [orgDoContexto()]);
    await fecharSyncLogMeta(logId, { status: 'sucesso', processados, criados, atualizados, apiCalls: client.apiCalls });
    console.log(`[META] sync ${tipo} ok: ${processados} registro(s), ${client.apiCalls} chamada(s) à API, período ${desde}..${ate}`);
    return { logId, processados, criados, atualizados, desde, ate };
  } catch (err) {
    const codigo = err instanceof MetaApiError ? err.codigo : META_ERROS.SYNC_FAILED;
    await fecharSyncLogMeta(logId, { status: 'erro', processados, criados, atualizados, apiCalls: client ? client.apiCalls : 0, erroCodigo: codigo, erroMensagem: err.message });
    // Só derruba a CONEXÃO quando o problema é da conexão (token morto, permissão revogada) — aí a
    // tela precisa pedir "Reconectar". Rate limit ou instabilidade da Meta não são motivo pra
    // mostrar "Atenção necessária": o token está bom e o próximo ciclo provavelmente passa. Esses
    // ficam registrados no sync log, que é onde se investiga sync que falhou.
    if (codigo === META_ERROS.TOKEN_EXPIRED || codigo === META_ERROS.PERMISSION_DENIED) {
      await marcarErroMeta(codigo, err.message);
    }
    console.error(`[META] sync ${tipo} falhou (${codigo}): ${mascararToken(err.message)}`);
    throw err;
  } finally {
    metaSyncEmAndamentoPorOrg.delete(orgDaSync);
  }
}

// ── Jobs (spec §33-35) ──────────────────────────────────────────────────────────────────────
// Só rodam quando há Postgres, OAuth configurado e conta selecionada — em dev local sem nada disso,
// não fazem barulho nenhum.

async function jobIncrementalMeta() {
  if (!pgPool || !metaOAuthConfigurado() || metaSyncEmAndamento()) return;
  const conexao = await obterConexaoMeta();
  if (!conexao || conexao.status !== 'connected') return;
  if (!(await metaContaSelecionada())) return;
  await sincronizarMeta({ tipo: 'INCREMENTAL' }).catch(() => {}); // erro já foi logado e gravado no sync log
}

// Diário: refaz a janela de atribuição inteira e re-sincroniza a hierarquia. É este job que corrige
// conversão tardia, nome de campanha alterado e reprocessamento da Meta (spec §34-35).
async function jobDiarioMeta() {
  if (!pgPool || !metaOAuthConfigurado() || metaSyncEmAndamento()) return;
  const conexao = await obterConexaoMeta();
  if (!conexao || conexao.status !== 'connected') return;
  if (!(await metaContaSelecionada())) return;
  await sincronizarMeta({ tipo: 'BACKFILL', dias: META_DIAS_BACKFILL }).catch(() => {});
}

// Renovação preventiva do token: a Meta não tem refresh token, então a única forma de continuar
// conectado é trocar um token AINDA VÁLIDO por outro. Roda com folga (7 dias antes de vencer)
// porque, depois do vencimento, não há mais o que fazer além de reconectar na mão.
async function jobRenovarTokenMeta() {
  if (!pgPool || !metaOAuthConfigurado()) return;
  const conexao = await obterConexaoMeta();
  if (!conexao || conexao.status !== 'connected' || !conexao.token_expires_at) return;
  const faltam = new Date(conexao.token_expires_at).getTime() - Date.now();
  if (faltam > 7 * 24 * 60 * 60 * 1000) return;
  try {
    const novo = await exigirIntegracoes().usarSegredo('meta', 'access_token', (token) => metaTokenLongaDuracao(token));
    const info = await metaInspecionarToken(novo.access_token);
    await salvarTokenMeta({
      accessToken: novo.access_token, expiresAt: info.expiraEm,
      userId: info.userId, userNome: conexao.meta_user_nome, escopos: info.escopos,
    });
    console.log('[META] token renovado por mais um período');
  } catch (err) {
    await marcarErroMeta(META_ERROS.TOKEN_EXPIRED, `não foi possível renovar o token: ${err.message}`);
    console.error(`[META] falha ao renovar token: ${mascararToken(err.message)}`);
  }
}

JOBS.agendar('meta-incremental', META_INTERVALO_SYNC_MIN * 60 * 1000, () => jobIncrementalMeta());
// De 6 em 6 horas em vez de "às 3h": o container reinicia a qualquer momento (deploy), e um job
// preso a um horário fixo simplesmente não roda no dia em que o processo subiu depois da hora.
JOBS.agendar('meta-diario', 6 * 60 * 60 * 1000, () => jobDiarioMeta());
JOBS.agendar('meta-token', 12 * 60 * 60 * 1000, () => jobRenovarTokenMeta());

// ── Rotas de integração (spec §38, §61) ─────────────────────────────────────────────────────

app.get('/api/admin/integrations/meta/status', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ conexao: mapMetaConexao(null), contas: [], oauthConfigurado: metaOAuthConfigurado(), syncEmAndamento: false });
  try {
    const conexao = await obterConexaoMeta();
    const { rows: contas } = await pgPool.query('SELECT * FROM meta_ad_accounts ORDER BY nome NULLS LAST');
    // date_from/date_to saem como TEXTO, não como Date: são colunas DATE (dia, sem hora) e o
    // driver as converteria em timestamp de meia-noite. Com o servidor em UTC e o navegador em
    // BRT, "2026-06-17" chegava na tela como "16/06 21:00" — um dia a menos e uma hora que não
    // existe. Mesmo motivo do to_char na série temporal.
    const { rows: logs } = await pgPool.query(
      `SELECT id, sync_type, status, started_at, finished_at,
              to_char(date_from, 'YYYY-MM-DD') AS date_from,
              to_char(date_to, 'YYYY-MM-DD') AS date_to,
              records_processed, records_created, records_updated, api_calls, error_code, error_message
       FROM meta_sync_logs ORDER BY started_at DESC LIMIT 5`
    );
    res.json({
      conexao: mapMetaConexao(conexao),
      oauthConfigurado: metaOAuthConfigurado(),
      syncEmAndamento: metaSyncEmAndamento(),
      contas: contas.map((c) => ({
        metaAccountId: c.meta_account_id, nome: c.nome, currency: c.currency,
        timezoneName: c.timezone_name, accountStatus: c.account_status,
        selecionada: c.selecionada, ultimoSyncEm: c.last_synced_at, lojaAtribuida: c.loja_atribuida,
        // A conta é da Store da sessão? (canônico por store_id; texto legado só com chave legada.)
        atribuidaAEstaStore: contaAtribuidaAEstaStore(c),
      })),
      sincronizacoes: logs.map((l) => ({
        id: l.id, tipo: l.sync_type, status: l.status, iniciadoEm: l.started_at, finalizadoEm: l.finished_at,
        de: l.date_from, ate: l.date_to, registros: l.records_processed, criados: l.records_created,
        atualizados: l.records_updated, chamadas: l.api_calls, erroCodigo: l.error_code, erro: l.error_message,
      })),
    });
  } catch (err) {
    console.error(`[META] falha ao ler status: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível ler o status da Meta' });
  }
});

app.get('/api/admin/integrations/meta/connect', requireAdmin, async (req, res) => {
  // Configuração da PLATAFORMA (app Meta global): o tenant vê o conceito, não o nome das variáveis.
  if (!metaOAuthConfigurado()) {
    return res.status(503).json({ error: 'a conexão com a Meta ainda não está habilitada na plataforma', codigo: 'PLATFORM_UNAVAILABLE' });
  }
  // A Store que conecta vai no `state` (anti-CSRF, uso único, amarrado à pessoa, à sessão e à
  // Organization). O callback confere que é a mesma — nunca aceita Organization/Store do navegador.
  const state = await criarStateOAuth(req, 'meta', { storeId: storeDoContexto() });
  const url = new URL(`${META_OAUTH_DIALOG}/${META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', process.env.META_ADS_APP_ID);
  url.searchParams.set('redirect_uri', process.env.META_ADS_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', META_OAUTH_SCOPE);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// Mesma razão do callback do Google: a Meta redireciona o NAVEGADOR pra cá e o cookie de sessão do
// painel pode não vir junto. Quem prova que a requisição é legítima é o `state` de uso único.
app.get('/api/admin/integrations/meta/callback', async (req, res) => {
  const { code, state, error_description: erroMeta } = req.query;
  const destino = '/admin/integracoes';
  let salvo;
  try {
    salvo = await OAUTH_STATES.consumir(String(state || ''), ['meta']);
  } catch (err) {
    console.error(`[META] callback recusado: ${err instanceof OAuthStateError ? err.motivo : mascararToken(err.message)}`);
    return res.redirect(destino);
  }
  // Tenant do callback = Organization gravada no state (membership revalidado), nunca do request.
  try {
    await comOrganizacaoResolvida(salvo.organizationId, 'oauth:meta', async () => {
      // A Store do state precisa ser a da Organization do state: state forjado, antigo (sem Store) ou
      // de outra Store é recusado e o callback só redireciona, sem gravar nada.
      const storeDoState = salvo.dados && salvo.dados.storeId;
      if (!storeDoState || storeDoContexto() !== storeDoState) throw new Error('state de outra store');
      if (erroMeta) {
        await marcarErroMeta(META_ERROS.PERMISSION_DENIED, `a Meta recusou a autorização: ${erroMeta}`).catch(() => {});
        return;
      }
      if (!code) {
        await marcarErroMeta(META_ERROS.API_ERROR, 'a Meta não devolveu o código de autorização').catch(() => {});
        return;
      }
      try {
        // O token curto do fluxo OAuth dura ~1h e é inútil pra sincronizar — só serve como moeda de
        // troca pelo de longa duração, que é o que fica guardado.
        const curto = await metaTrocarCodePorToken(String(code));
        const longo = await metaTokenLongaDuracao(curto.access_token);
        const info = await metaInspecionarToken(longo.access_token);
        if (!info.valido) throw new Error('a Meta devolveu um token que ela mesma considera inválido');
        // Falhar aqui é melhor que falhar no primeiro sync: sem ads_read não há o que ler, e a causa
        // (permissão) fica explícita em vez de virar um erro genérico três telas adiante.
        if (info.escopos && !info.escopos.split(',').includes('ads_read')) {
          throw new Error('a autorização não incluiu a permissão ads_read — reconecte e aceite o acesso aos dados de anúncios');
        }
        let nome = null;
        try {
          const proof = metaAppsecretProof(longo.access_token);
          const url = new URL(`${META_GRAPH}/${META_GRAPH_VERSION}/me`);
          url.searchParams.set('fields', 'name');
          if (proof) url.searchParams.set('appsecret_proof', proof);
          const meRes = await fetch(url, { headers: { Authorization: `Bearer ${longo.access_token}` } });
          if (meRes.ok) nome = (await meRes.json()).name || null;
        } catch { /* nome é enfeite: a conexão funciona sem ele */ }

        await salvarTokenMeta({
          accessToken: longo.access_token, expiresAt: info.expiraEm,
          userId: info.userId, userNome: nome, escopos: info.escopos,
        });
        // Já traz as contas de anúncio: sem isso a tela volta conectada mas sem nada pra selecionar.
        const client = await criarMetaClient();
        await sincronizarContasMeta(client);
        console.log('[META] conta conectada com sucesso');
      } catch (err) {
        console.error(`[META] falha no callback OAuth: ${mascararToken(err.message)}`);
        await marcarErroMeta(META_ERROS.API_ERROR, err.message).catch(() => {});
      }
    });
  } catch (err) {
    console.error(`[META] callback sem contexto válido: ${mascararToken(err.message)}`);
  }
  res.redirect(destino);
});

app.get('/api/admin/integrations/meta/ad-accounts', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'a integração com a Meta exige Postgres configurado' });
  try {
    const client = await criarMetaClient();
    await sincronizarContasMeta(client);
    const { rows } = await pgPool.query('SELECT * FROM meta_ad_accounts ORDER BY nome NULLS LAST');
    res.json({
      contas: rows.map((c) => ({
        metaAccountId: c.meta_account_id, nome: c.nome, currency: c.currency,
        timezoneName: c.timezone_name, accountStatus: c.account_status, selecionada: c.selecionada,
      })),
    });
  } catch (err) {
    console.error(`[META] falha ao listar contas: ${mascararToken(err.message)}`);
    res.status(502).json({ error: err.message || 'não foi possível listar as contas de anúncio' });
  }
});

app.post('/api/admin/integrations/meta/select-account', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'a integração com a Meta exige Postgres configurado' });
  const { metaAccountId } = req.body || {};
  // A conta atende a Store da Organization da sessão (PD-016, 1:1). Identidade canônica: `store_id`;
  // a chave legada (nula na Store nativa) só espelha `loja_atribuida` para as telas e relatórios
  // antigos, e nunca é condição para a conta ser atribuída.
  const storeId = storeDoContexto();
  const loja = lojaLegadaDoContextoOuNula();
  if (!metaAccountId) return res.status(400).json({ error: 'metaAccountId é obrigatório' });
  const cliente = await pgPool.connect();
  try {
    // Uma transação porque o índice parcial só permite UMA conta selecionada: desmarcar e marcar
    // têm que acontecer juntos, senão o segundo UPDATE bate no índice e falha.
    await cliente.query('BEGIN');
    const org = orgDoContexto();
    const idConta = String(metaAccountId);
    const { rows: existe } = await cliente.query(
      'SELECT 1 FROM meta_ad_accounts WHERE organization_id = $1 AND meta_account_id = $2', [org, idConta]
    );
    if (!existe.length) {
      await cliente.query('ROLLBACK');
      return res.status(404).json({ error: 'conta de anúncios não encontrada — atualize a lista de contas' });
    }
    // PD-016: a conta passa a ser desta Organization; se já for de outra, 409 (sem transferir).
    const { rows: [posse] } = await cliente.query('SELECT integracao_reivindicar_recurso($1, $2, $3) AS ok', ['meta', 'ad_account', idConta]);
    if (!posse.ok) {
      await cliente.query('ROLLBACK');
      return res.status(409).json({ error: 'esta conta de anúncios já está conectada a outra organization', codigo: 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE' });
    }
    const { rows: anteriores } = await cliente.query(
      'UPDATE meta_ad_accounts SET selecionada = false WHERE selecionada AND organization_id = $1 AND meta_account_id <> $2 RETURNING meta_account_id',
      [org, idConta]
    );
    for (const a of anteriores) {
      await cliente.query('SELECT integracao_liberar_recursos($1, $2, $3)', ['meta', 'ad_account', a.meta_account_id]);
    }
    await cliente.query(
      `UPDATE meta_ad_accounts SET selecionada = true, store_id = $4, loja_atribuida = $2, atualizado_em = now()
       WHERE meta_account_id = $1 AND organization_id = $3`,
      [idConta, loja, org, storeId]
    );
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    console.error(`[META] falha ao selecionar conta: ${mascararToken(err.message)}`);
    return res.status(500).json({ error: 'não foi possível selecionar a conta' });
  } finally {
    cliente.release();
  }
  // A importação inicial de 90 dias leva minutos: começa em background e a tela acompanha pelo
  // status/sync log (spec §32: "não bloquear request HTTP até completar tudo").
  sincronizarMeta({ tipo: 'INITIAL_IMPORT' }).catch(() => {});
  res.json({ ok: true, importacaoIniciada: true });
});

app.post('/api/admin/integrations/meta/sync', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'a integração com a Meta exige Postgres configurado' });
  if (metaSyncEmAndamento()) return res.status(409).json({ error: 'já existe uma sincronização da Meta em andamento' });
  const dias = req.body && req.body.dias ? Math.min(Number(req.body.dias) || 0, 365) : null;
  try {
    const conta = await metaContaSelecionada();
    if (!conta) return res.status(409).json({ error: 'selecione uma conta de anúncios da Meta antes de sincronizar' });
    sincronizarMeta({ tipo: 'MANUAL', dias }).catch(() => {});
    res.json({ ok: true, iniciado: true });
  } catch (err) {
    res.status(502).json({ error: err.message || 'não foi possível iniciar a sincronização' });
  }
});

app.post('/api/admin/integrations/meta/disconnect', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'a integração com a Meta exige Postgres configurado' });
  try {
    await desconectarMeta();
    res.json({ ok: true });
  } catch (err) {
    console.error(`[META] falha ao desconectar: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível desconectar a Meta' });
  }
});

// ── Leitura para o painel (spec §38, §80) ───────────────────────────────────────────────────
// Lê SÓ do Postgres, nunca da Meta (spec §31). As taxas (CTR/CPC/CPM/CPA/ROAS) são sempre
// recalculadas a partir das somas do período — nunca a média das taxas diárias, que divergiria do
// Ads Manager.

function resolverPeriodoMeta(fromRaw, toRaw) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const to = String(toRaw || metaDataISO(new Date()));
  const from = String(fromRaw || '');
  if (!re.test(to) || !re.test(from)) throw new Error('informe `from` e `to` no formato AAAA-MM-DD');
  if (from > to) throw new Error('`from` não pode ser depois de `to`');
  return { from, to };
}

// Período anterior de mesma duração, imediatamente antes (spec §41).
function periodoAnteriorMeta({ from, to }) {
  const ini = new Date(`${from}T00:00:00Z`);
  const fim = new Date(`${to}T00:00:00Z`);
  const dias = Math.round((fim - ini) / 86400000) + 1;
  const fimAnterior = new Date(ini); fimAnterior.setUTCDate(fimAnterior.getUTCDate() - 1);
  const iniAnterior = new Date(fimAnterior); iniAnterior.setUTCDate(iniAnterior.getUTCDate() - (dias - 1));
  return { from: metaDataISO(iniAnterior), to: metaDataISO(fimAnterior) };
}

// pg devolve NUMERIC/BIGINT como string pra não perder precisão — converter na fronteira evita
// concatenação silenciosa ("10" + "5" = "105") nas contas do frontend.
const META_COLUNAS_SOMA = [
  'impressions', 'reach', 'clicks', 'unique_clicks', 'inline_link_clicks', 'outbound_clicks',
  'unique_outbound_clicks', 'spend', 'landing_page_views', 'view_content', 'add_to_cart',
  'initiate_checkout', 'purchases', 'purchase_value',
  'video_plays', 'video_thruplays', 'video_25', 'video_50', 'video_75', 'video_95', 'video_100',
];

// snake_case do Postgres → camelCase que a lib e o frontend usam. Quem recalcula as taxas é
// metaInsights.totalizarSomas — as rotas não fazem conta nenhuma por conta própria, senão overview,
// série e tabela podem divergir entre si.
function totalizarMeta(row) {
  const r = row || {};
  return metaInsights.totalizarSomas({
    impressions: r.impressions, reach: r.reach, clicks: r.clicks,
    uniqueClicks: r.unique_clicks, inlineLinkClicks: r.inline_link_clicks,
    outboundClicks: r.outbound_clicks, uniqueOutboundClicks: r.unique_outbound_clicks,
    spend: r.spend, landingPageViews: r.landing_page_views, viewContent: r.view_content,
    addToCart: r.add_to_cart, initiateCheckout: r.initiate_checkout,
    purchases: r.purchases, purchaseValue: r.purchase_value,
    // Vídeo passa como null quando a soma veio NULL (nenhuma linha do período tinha vídeo) — aí a
    // UI mostra "—" em vez de um zero que sugere que o vídeo não foi assistido (spec §20).
    videoPlays: r.video_plays, videoThruplays: r.video_thruplays,
    video25: r.video_25, video50: r.video_50, video75: r.video_75,
    video95: r.video_95, video100: r.video_100,
  });
}

const META_SELECT_SOMA = META_COLUNAS_SOMA.map((c) => `SUM(${c}) AS ${c}`).join(', ');

async function somarInsightsMeta(contaId, level, { from, to }) {
  const { rows } = await pgPool.query(
    `SELECT ${META_SELECT_SOMA} FROM meta_insights_daily
     WHERE meta_account_id = $1 AND level = $2 AND data BETWEEN $3 AND $4`,
    [contaId, level, from, to]
  );
  return totalizarMeta(rows[0]);
}

app.get('/api/admin/analytics/meta/overview', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'a integração com a Meta exige Postgres configurado' });
  let periodo;
  try { periodo = resolverPeriodoMeta(req.query.from, req.query.to); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const conta = await metaContaSelecionada();
    if (!conta) return res.status(409).json({ error: 'conecte a Meta e selecione uma conta de anúncios em Integrações primeiro' });
    const conexao = await obterConexaoMeta();
    // Nível `account`: é o número que o Ads Manager mostra pra conta. Somar os anúncios daria
    // outro valor (dedupe de alcance, gasto que não pertence a anúncio nenhum).
    const atual = await somarInsightsMeta(conta.meta_account_id, 'account', periodo);
    const comparar = req.query.comparar !== 'nenhum';
    const anterior = comparar ? await somarInsightsMeta(conta.meta_account_id, 'account', periodoAnteriorMeta(periodo)) : null;

    res.json({
      periodo: { from: periodo.from, to: periodo.to, timezone: conta.timezone_name || null },
      conta: { metaAccountId: conta.meta_account_id, nome: conta.nome, currency: conta.currency },
      ...atual,
      periodoAnterior: anterior,
      // A UI colore o delta a partir daqui, não por "subiu = verde": subir CPA é ruim, subir gasto
      // é neutro sem contexto (spec §41).
      variacoes: anterior
        ? Object.fromEntries(Object.keys(metaInsights.DIRECAO_BOA).map((k) => [k, metaInsights.variacao(atual[k], anterior[k])]))
        : null,
      direcaoBoa: metaInsights.DIRECAO_BOA,
      ultimoSyncEm: conexao ? conexao.last_successful_sync_at : null,
      // A tela precisa saber se o número está completo ou se ainda está entrando (spec §62/§63).
      syncEmAndamento: metaSyncEmAndamento(),
    });
  } catch (err) {
    console.error(`[META] falha no overview: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível montar o panorama da Meta' });
  }
});

app.get('/api/admin/analytics/meta/timeseries', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'a integração com a Meta exige Postgres configurado' });
  let periodo;
  try { periodo = resolverPeriodoMeta(req.query.from, req.query.to); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const conta = await metaContaSelecionada();
    if (!conta) return res.status(409).json({ error: 'conecte a Meta e selecione uma conta de anúncios em Integrações primeiro' });
    const { rows } = await pgPool.query(
      // to_char em vez de deixar o pg devolver um Date: uma coluna DATE vira Date na meia-noite
      // LOCAL, e `toISOString()` converte pra UTC — em qualquer fuso a leste de Greenwich isso
      // devolve o dia anterior. A data já é um rótulo, então sai do banco como texto.
      `SELECT to_char(data, 'YYYY-MM-DD') AS data, ${META_SELECT_SOMA} FROM meta_insights_daily
       WHERE meta_account_id = $1 AND level = 'account' AND data BETWEEN $2 AND $3
       GROUP BY data ORDER BY data`,
      [conta.meta_account_id, periodo.from, periodo.to]
    );
    res.json({
      periodo,
      // Cada ponto recalcula as próprias taxas — o dia é o menor grão que temos, então aqui a
      // conta bate exatamente com o que a Meta reportou naquele dia.
      serie: rows.map((r) => ({ data: r.data, ...totalizarMeta(r) })),
    });
  } catch (err) {
    console.error(`[META] falha na série temporal: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível montar a série temporal da Meta' });
  }
});

// Uma rota só serve as três tabelas (Campanhas / Conjuntos / Anúncios) — mudam o nível e a junção,
// não a lógica. O JOIN traz nome e status da hierarquia já sincronizada, sem N+1 (spec §69).
// `selecao` e `agrupamento` andam juntos de propósito: no Postgres, toda coluna não agregada do
// SELECT precisa estar no GROUP BY. Declarar as duas listas lado a lado (em vez de derivar uma da
// outra por manipulação de string) deixa impossível adicionar uma coluna e esquecer do GROUP BY.
const META_ENTIDADES = {
  campaign: {
    coluna: 'meta_campaign_id',
    joins: 'LEFT JOIN meta_campaigns e ON e.meta_campaign_id = i.meta_campaign_id',
    selecao: 'e.nome, e.status, e.effective_status, e.objective, NULL::text AS pai_id, NULL::text AS pai_nome, NULL::text AS thumbnail_url, NULL::text AS criativo_id',
    agrupamento: 'e.nome, e.status, e.effective_status, e.objective',
  },
  adset: {
    coluna: 'meta_adset_id',
    joins: `LEFT JOIN meta_adsets e ON e.meta_adset_id = i.meta_adset_id
            LEFT JOIN meta_campaigns p ON p.meta_campaign_id = e.meta_campaign_id`,
    selecao: 'e.nome, e.status, e.effective_status, e.optimization_goal AS objective, p.meta_campaign_id AS pai_id, p.nome AS pai_nome, NULL::text AS thumbnail_url, NULL::text AS criativo_id',
    agrupamento: 'e.nome, e.status, e.effective_status, e.optimization_goal, p.meta_campaign_id, p.nome',
  },
  ad: {
    coluna: 'meta_ad_id',
    joins: `LEFT JOIN meta_ads e ON e.meta_ad_id = i.meta_ad_id
            LEFT JOIN meta_adsets p ON p.meta_adset_id = e.meta_adset_id
            LEFT JOIN meta_creatives c ON c.meta_creative_id = e.meta_creative_id`,
    selecao: 'e.nome, e.status, e.effective_status, NULL::text AS objective, p.meta_adset_id AS pai_id, p.nome AS pai_nome, c.thumbnail_url, c.meta_creative_id AS criativo_id',
    agrupamento: 'e.nome, e.status, e.effective_status, p.meta_adset_id, p.nome, c.thumbnail_url, c.meta_creative_id',
  },
};

app.get('/api/admin/analytics/meta/entities', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'a integração com a Meta exige Postgres configurado' });
  const level = String(req.query.level || 'campaign');
  const cfg = META_ENTIDADES[level];
  if (!cfg) return res.status(400).json({ error: 'level deve ser campaign, adset ou ad' });
  let periodo;
  try { periodo = resolverPeriodoMeta(req.query.from, req.query.to); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const conta = await metaContaSelecionada();
    if (!conta) return res.status(409).json({ error: 'conecte a Meta e selecione uma conta de anúncios em Integrações primeiro' });
    const { rows } = await pgPool.query(
      `SELECT i.${cfg.coluna} AS entidade_id, ${cfg.selecao}, ${META_COLUNAS_SOMA.map((c) => `SUM(i.${c}) AS ${c}`).join(', ')}
       FROM meta_insights_daily i
       ${cfg.joins}
       WHERE i.meta_account_id = $1 AND i.level = $2 AND i.data BETWEEN $3 AND $4 AND i.${cfg.coluna} IS NOT NULL
       GROUP BY i.${cfg.coluna}, ${cfg.agrupamento}
       ORDER BY SUM(i.spend) DESC`,
      [conta.meta_account_id, level, periodo.from, periodo.to]
    );
    res.json({
      periodo,
      level,
      linhas: rows.map((r) => ({
        id: r.entidade_id,
        nome: r.nome,
        status: r.status,
        effectiveStatus: r.effective_status,
        objective: r.objective,
        paiId: r.pai_id,
        paiNome: r.pai_nome,
        thumbnailUrl: r.thumbnail_url || null,
        criativoId: r.criativo_id || null,
        ...totalizarMeta(r),
      })),
    });
  } catch (err) {
    console.error(`[META] falha ao listar ${level}: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível listar as entidades da Meta' });
  }
});

// ── Criativos (Fase 4, spec §48-50) ─────────────────────────────────────────────────────────
// A pergunta desta tela é diferente da hierarquia: "qual PEÇA está funcionando?", independente de
// em que campanha ela rodou. Por isso agrega por criativo e não por anúncio — o mesmo criativo
// costuma rodar em vários anúncios/conjuntos, e somá-los é justamente o que dá a leitura útil.

// Metas analíticas (spec §50). Guardadas no mesmo app_config do resto do painel; nenhum valor da
// Use Origens fica no código — sem meta configurada, o painel não emite julgamento nenhum.
const META_METAS_FILE = path.join(PEDIDOS_DIR, 'meta-metas.json');

async function lerMetasMeta() {
  const salvo = await lerConfigPostgres('meta-metas', META_METAS_FILE, metaCriativos.METAS_PADRAO);
  return { ...metaCriativos.METAS_PADRAO, ...salvo };
}

// Aceita só os quatro campos conhecidos, cada um número positivo ou null (= "não avaliar por isto").
// Qualquer outra coisa é recusada em vez de virar NaN silencioso numa comparação de eficiência.
function validarMetasMeta(corpo) {
  const limpo = {};
  for (const campo of Object.keys(metaCriativos.METAS_PADRAO)) {
    const bruto = corpo ? corpo[campo] : undefined;
    if (bruto === undefined || bruto === null || bruto === '') { limpo[campo] = null; continue; }
    const n = Number(bruto);
    if (!Number.isFinite(n) || n < 0) return { erro: `${campo} deve ser um número positivo ou vazio` };
    limpo[campo] = n;
  }
  return { metas: limpo };
}

app.get('/api/admin/analytics/meta/metas', requireAdmin, async (req, res) => {
  try {
    res.json({ metas: await lerMetasMeta() });
  } catch (err) {
    console.error(`[META] falha ao ler metas: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível ler as metas' });
  }
});

app.put('/api/admin/analytics/meta/metas', requireAdmin, async (req, res) => {
  const { metas, erro } = validarMetasMeta(req.body);
  if (erro) return res.status(400).json({ error: erro });
  try {
    await salvarConfigPostgres('meta-metas', META_METAS_FILE, metas);
    res.json({ metas });
  } catch (err) {
    console.error(`[META] falha ao salvar metas: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível salvar as metas' });
  }
});

// Agrega os insights de NÍVEL ANÚNCIO pelo criativo que cada anúncio usa. `string_agg` junta os
// nomes dos anúncios em que a peça rodou — é o que explica um criativo com gasto alto sem precisar
// abrir a hierarquia. Extraída em função porque a aba compara dois períodos, e duplicar esta query
// faria as duas leituras divergirem na primeira coluna que alguém acrescentasse.
function consultarCriativos(contaId, from, to) {
  return pgPool.query(
      `SELECT c.meta_creative_id, c.nome, c.title, c.body, c.thumbnail_url, c.image_url,
              c.object_story_spec, c.asset_feed_spec,
              COUNT(DISTINCT a.meta_ad_id)::int AS anuncios,
              string_agg(DISTINCT a.nome, ' · ') AS nomes_anuncios,
              ${META_COLUNAS_SOMA.map((x) => `SUM(i.${x}) AS ${x}`).join(', ')},
              SUM(i.video_avg_watch_time * NULLIF(i.video_plays, 0)) / NULLIF(SUM(i.video_plays), 0) AS video_avg_watch_time
       FROM meta_insights_daily i
       JOIN meta_ads a ON a.meta_ad_id = i.meta_ad_id
       JOIN meta_creatives c ON c.meta_creative_id = a.meta_creative_id
       WHERE i.meta_account_id = $1 AND i.level = 'ad' AND i.data BETWEEN $2 AND $3
       GROUP BY c.meta_creative_id, c.nome, c.title, c.body, c.thumbnail_url, c.image_url,
                c.object_story_spec, c.asset_feed_spec
       ORDER BY SUM(i.spend) DESC`,
      [contaId, from, to]
    );
}

app.get('/api/admin/analytics/meta/creatives', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'a integração com a Meta exige Postgres configurado' });
  let periodo;
  try { periodo = resolverPeriodoMeta(req.query.from, req.query.to); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const conta = await metaContaSelecionada();
    if (!conta) return res.status(409).json({ error: 'conecte a Meta e selecione uma conta de anúncios em Integrações primeiro' });

    const comparar = req.query.comparar !== 'nenhum';
    const anterior = comparar ? periodoAnteriorMeta(periodo) : null;
    const [{ rows }, antes] = await Promise.all([
      consultarCriativos(conta.meta_account_id, periodo.from, periodo.to),
      anterior ? consultarCriativos(conta.meta_account_id, anterior.from, anterior.to) : Promise.resolve({ rows: [] }),
    ]);
    // Indexado por criativo: peça que não rodou no período anterior simplesmente não tem comparação
    // (e a variação vem null), em vez de aparecer como crescimento infinito vindo de zero.
    const antesPorId = new Map(antes.rows.map((r) => [r.meta_creative_id, totalizarMeta(r)]));

    const metas = await lerMetasMeta();
    const linhas = rows.map((r) => {
      const m = totalizarMeta(r);
      const formato = metaCriativos.classificarCriativo(
        { object_story_spec: r.object_story_spec, asset_feed_spec: r.asset_feed_spec, thumbnail_url: r.thumbnail_url },
        m
      );
      const { sinal, motivos } = metaCriativos.avaliarCriativo(m, metas);
      return {
        id: r.meta_creative_id,
        nome: r.nome || r.title || r.nomes_anuncios || r.meta_creative_id,
        title: r.title,
        body: r.body,
        thumbnailUrl: r.thumbnail_url,
        imageUrl: r.image_url,
        formato,
        anuncios: r.anuncios,
        nomesAnuncios: r.nomes_anuncios,
        ...m,
        videoAvgWatchTime: metaActions.parseNumero(r.video_avg_watch_time),
        retencao: metaCriativos.retencaoVideo(m),
        sinal,
        motivos,
        variacoes: (() => {
          const a = antesPorId.get(r.meta_creative_id);
          if (!a) return null;
          return Object.fromEntries(
            ['spend', 'impressions', 'clicks', 'ctr', 'purchases', 'purchaseValue', 'cpa', 'roas']
              .map((k) => [k, metaInsights.variacao(m[k], a[k])])
          );
        })(),
      };
    });

    res.json({ periodo, periodoAnterior: anterior, metas, formatos: metaCriativos.FORMATOS, direcaoBoa: metaInsights.DIRECAO_BOA, linhas });
  } catch (err) {
    console.error(`[META] falha ao listar criativos: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível listar os criativos da Meta' });
  }
});

// Detalhe de um anúncio (spec §47): métricas do período, série diária própria e, quando for vídeo,
// a retenção por marco. Os dados de vídeo já vinham sendo sincronizados desde a Fase 2 — aqui eles
// finalmente aparecem.
app.get('/api/admin/analytics/meta/ads/:adId', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'a integração com a Meta exige Postgres configurado' });
  let periodo;
  try { periodo = resolverPeriodoMeta(req.query.from, req.query.to); } catch (err) { return res.status(400).json({ error: err.message }); }
  const adId = String(req.params.adId);
  try {
    const conta = await metaContaSelecionada();
    if (!conta) return res.status(409).json({ error: 'conecte a Meta e selecione uma conta de anúncios em Integrações primeiro' });

    const { rows: ficha } = await pgPool.query(
      `SELECT a.meta_ad_id, a.nome, a.status, a.effective_status,
              cp.nome AS campanha_nome, cp.meta_campaign_id,
              s.nome AS adset_nome, s.meta_adset_id,
              c.meta_creative_id, c.nome AS criativo_nome, c.title, c.body, c.thumbnail_url, c.image_url,
              c.object_story_spec, c.asset_feed_spec
       FROM meta_ads a
       LEFT JOIN meta_campaigns cp ON cp.meta_campaign_id = a.meta_campaign_id
       LEFT JOIN meta_adsets s ON s.meta_adset_id = a.meta_adset_id
       LEFT JOIN meta_creatives c ON c.meta_creative_id = a.meta_creative_id
       WHERE a.meta_account_id = $1 AND a.meta_ad_id = $2`,
      [conta.meta_account_id, adId]
    );
    if (!ficha.length) return res.status(404).json({ error: 'anúncio não encontrado no histórico sincronizado' });
    const f = ficha[0];

    const { rows: totalRows } = await pgPool.query(
      `SELECT ${META_SELECT_SOMA},
              SUM(video_avg_watch_time * NULLIF(video_plays, 0)) / NULLIF(SUM(video_plays), 0) AS video_avg_watch_time
       FROM meta_insights_daily
       WHERE meta_account_id = $1 AND level = 'ad' AND meta_ad_id = $2 AND data BETWEEN $3 AND $4`,
      [conta.meta_account_id, adId, periodo.from, periodo.to]
    );
    const { rows: serieRows } = await pgPool.query(
      `SELECT to_char(data, 'YYYY-MM-DD') AS data, ${META_SELECT_SOMA}
       FROM meta_insights_daily
       WHERE meta_account_id = $1 AND level = 'ad' AND meta_ad_id = $2 AND data BETWEEN $3 AND $4
       GROUP BY data ORDER BY data`,
      [conta.meta_account_id, adId, periodo.from, periodo.to]
    );

    const m = totalizarMeta(totalRows[0]);
    res.json({
      periodo,
      anuncio: {
        id: f.meta_ad_id, nome: f.nome, status: f.status, effectiveStatus: f.effective_status,
        campanhaId: f.meta_campaign_id, campanhaNome: f.campanha_nome,
        adsetId: f.meta_adset_id, adsetNome: f.adset_nome,
      },
      criativo: f.meta_creative_id
        ? {
            id: f.meta_creative_id, nome: f.criativo_nome, title: f.title, body: f.body,
            thumbnailUrl: f.thumbnail_url, imageUrl: f.image_url,
            formato: metaCriativos.classificarCriativo({ object_story_spec: f.object_story_spec, asset_feed_spec: f.asset_feed_spec }, m),
          }
        : null,
      ...m,
      videoAvgWatchTime: metaActions.parseNumero(totalRows[0] && totalRows[0].video_avg_watch_time),
      retencao: metaCriativos.retencaoVideo(m),
      serie: serieRows.map((r) => ({ data: r.data, ...totalizarMeta(r) })),
    });
  } catch (err) {
    console.error(`[META] falha no detalhe do anúncio ${adId}: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível abrir o detalhe do anúncio' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Consolidado financeiro + atribuição — Fase 5 (spec §51, §52, §53A-53AC, §76)
// ═══════════════════════════════════════════════════════════════════════════════════════════
// Junta as três fontes que o painel já tem, SEM misturá-las (spec §53D):
//   FINANCEIRO  receita e custo reais dos pedidos (Ink) + gasto real de mídia (Meta API)
//   ATRIBUIÇÃO  o que Meta e GA4 dizem ter gerado — lado a lado, nunca dentro da conta de resultado
//
// Decisão de produto tomada em 15/09/2026: a conta de anúncios conectada ("Use Sul - CA") traz
// tráfego só para a Use Sul, então é a receita DELA que entra no MER e no ROAS de margem. Somar as
// três lojas contra o gasto de uma inflaria o resultado — exatamente o que a spec §53AB quer evitar.
// Fase 3: o antigo `lojaAtribuidaPadrao()` ("se a instalação tem uma loja só, é ela") saiu — era o
// padrão proibido por INV-09. A loja vem da Store da Organization da sessão.

// Nome da Store da sessão, para rótulo. A Organization é a do contexto (a RLS confere de novo).
async function nomeDaStoreDoContexto() {
  const { rows } = await pgPool.query('SELECT nome FROM stores WHERE id = $1 AND organization_id = $2', [storeDoContexto(), orgDoContexto()]);
  return rows[0] ? rows[0].nome : null;
}

// Financeiro real da loja no período, direto de pedidos_ink. Só pedido pago e que não é troca —
// mesma regra do dashboard financeiro, pra os dois nunca divergirem.
async function financeiroDaLoja(from, to) {
  const { rows } = await pgPool.query(
    // Duas escalas, deliberadamente separadas. Somar receita de TODOS os pedidos com custo só dos
    // que têm custo gravado produz uma margem sem sentido — foi exatamente o que apareceu em
    // produção: R$ 61.467 de receita (377 pedidos) contra R$ 3.664 de custo (55 pedidos), dando
    // margem de 6% onde a real é ~45%, e um Lucro após Mídia falsamente negativo.
    // O FILTER amarra receita, custo e lucro ao mesmo conjunto: os pedidos com financeiro completo.
    `SELECT COUNT(*)::int AS pedidos,
            COUNT(*) FILTER (WHERE lucro_operacional IS NULL)::int AS sem_financeiro,
            COUNT(*) FILTER (WHERE lucro_operacional IS NOT NULL)::int AS pedidos_com_financeiro,
            COALESCE(SUM(total_value), 0) AS receita_total,
            COALESCE(SUM(total_value) FILTER (WHERE lucro_operacional IS NOT NULL), 0) AS receita,
            COALESCE(SUM(custo_producao) FILTER (WHERE lucro_operacional IS NOT NULL), 0) AS custo_producao,
            COALESCE(SUM(lucro_operacional) FILTER (WHERE lucro_operacional IS NOT NULL), 0) AS lucro_produto
     FROM pedidos_ink
     WHERE organization_id = $1 AND ${escopoDaStore(2).sql}
       AND payment_status = ANY($${2 + escopoDaStore(2).usados}) AND is_troca IS NOT TRUE
       AND criado_em >= ($${3 + escopoDaStore(2).usados}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
       AND criado_em <  (($${4 + escopoDaStore(2).usados}::date) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`,
    [orgDoContexto(), ...escopoDaStore(2).params, Array.from(RESUMO_PAGO), from, to]
  );
  const r = rows[0];
  const pedidos = Number(r.pedidos);
  const comFinanceiro = Number(r.pedidos_com_financeiro);
  return {
    // Escopo do RESULTADO: só pedidos com financeiro completo, pra receita, custo e lucro falarem
    // do mesmo conjunto.
    pedidos: comFinanceiro,
    receita: Number(r.receita),
    custoProducao: Number(r.custo_producao),
    lucroProduto: Number(r.lucro_produto),
    // Escopo REAL da loja no período: usado pelo MER e pelo Blended CAC, que não dependem de custo
    // e portanto não sofrem com a cobertura parcial.
    pedidosTotal: pedidos,
    receitaTotal: Number(r.receita_total),
    semFinanceiro: Number(r.sem_financeiro),
    coberturaCompleta: comFinanceiro === pedidos,
  };
}

// Fase 4 · gasto de mídia da Organization do contexto, pela fonte única (F-01). A loja é a da
// Store da sessão; nenhum parâmetro do request entra.
function midiaDaOrganizacao(from, to) {
  return resolverMidiaDaOrganizacao(pgPool, {
    organizationId: orgDoContexto(),
    // Identidade canônica primeiro. A chave legada (nula na Store nativa) só habilita o ramo de
    // compatibilidade para conta antiga atribuída pelo texto `loja_atribuida`.
    storeId: storeDoContexto(),
    loja: lojaLegadaDoContextoOuNula(),
    from,
    to,
    // Google Ads só vira aviso de "não conectado" se esta Organization de fato tem a integração.
    relevante: async (provider) => provider !== 'google_ads'
      || (!!INTEGRACOES && (await INTEGRACOES.metadata('google_ads')).status !== 'disconnected'),
  });
}

// Conversão atribuída pela Meta no período — para a comparação, NUNCA para a conta de resultado.
// Só a conta que entrou no gasto (mesma regra da fonte única): conta sem loja ou de outra loja não
// gera comparação.
async function atribuicaoMeta(from, to, fontes) {
  const meta = (fontes || []).find((f) => f.provider === 'meta');
  if (!meta || !meta.conectado || !meta.recurso) return null;
  const conta = { meta_account_id: meta.recurso };
  const { rows } = await pgPool.query(
    `SELECT COALESCE(SUM(purchases),0) AS purchases, COALESCE(SUM(purchase_value),0) AS purchase_value,
            COALESCE(SUM(clicks),0) AS clicks
     FROM meta_insights_daily
     WHERE meta_account_id = $1 AND level = 'account' AND data BETWEEN $2 AND $3`,
    [conta.meta_account_id, from, to]
  );
  return {
    purchases: Number(rows[0].purchases),
    purchaseValue: Number(rows[0].purchase_value),
    clicks: Number(rows[0].clicks),
  };
}

// GA4 da loja atribuída. Só lê o CACHE já existente (mesmo do Analytics GA4) — esta tela não
// dispara chamada à Data API: se o cache estiver frio, a linha do GA4 aparece como indisponível em
// vez de fazer o consolidado esperar por uma API externa.
async function atribuicaoGA4(from, to) {
  const chave = `overview:custom:${from}:${to}`;
  const cache = await obterCachePerformanceGA4(chave);
  if (!cache || !cache.dados || !cache.dados.totais) return null;
  const t = cache.dados.totais;
  return { sessions: t.sessions, purchases: t.purchases, revenue: t.revenue, doCache: true, atualizadoEm: cache.buscadoEm };
}


// ── Despesas operacionais (spec §53X, §53Y) ─────────────────────────────────────────────────
// CRUD simples, por loja. A recorrência é expandida na LEITURA (lib/financeiro/despesas.js): uma
// mensalidade é uma linha só, não doze — editar o valor não exige caçar registros, e não existem
// despesas fantasma para meses que ainda não aconteceram.

// Escopo canônico da Store do contexto (`organization_id + store_id`); a linha histórica, sem
// `store_id`, só entra quando a Store tem chave legada — Store nativa nunca cai nesse ramo.
async function listarDespesas() {
  const escopo = escopoDaStore(2);
  const { rows } = await pgPool.query(
    `SELECT id, categoria, descricao, valor, to_char(data,'YYYY-MM-DD') AS data,
            recorrencia, to_char(fim,'YYYY-MM-DD') AS fim, notas
     FROM despesas_operacionais WHERE organization_id = $1 AND ${escopo.sql} ORDER BY data DESC, id DESC`,
    [orgDoContexto(), ...escopo.params]
  );
  // valor vem NUMERIC (string no driver) — converte na fronteira, como no resto do módulo.
  return rows.map((r) => ({ ...r, valor: Number(r.valor) }));
}

app.get('/api/admin/financeiro/despesas', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'despesas exigem Postgres configurado' });
  try {
    const despesas = await listarDespesas();
    // Quando o período vem junto, devolve também o total expandido — é o que a tela do Resultado
    // consome sem precisar reimplementar a recorrência no frontend.
    let periodo = null;
    if (req.query.from && req.query.to) {
      try {
        const p = resolverPeriodoMeta(req.query.from, req.query.to);
        periodo = { ...p, ...financeiroDespesas.totalizarDespesas(despesas, p.from, p.to) };
      } catch { /* período inválido: devolve só a lista */ }
    }
    res.json({ despesas, categorias: financeiroDespesas.CATEGORIAS, periodo });
  } catch (err) {
    console.error(`[DESPESAS] falha ao listar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar as despesas' });
  }
});

app.post('/api/admin/financeiro/despesas', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'despesas exigem Postgres configurado' });
  const { despesa, erros } = financeiroDespesas.validarDespesa(req.body);
  if (erros) return res.status(400).json({ error: erros.join('; ') });
  try {
    // Store canônica; `loja` só espelha a chave histórica (nula na Store nativa).
    const { rows } = await pgPool.query(
      `INSERT INTO despesas_operacionais (store_id, loja, categoria, descricao, valor, data, recorrencia, fim, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [storeDoContexto(), lojaLegadaDoContextoOuNula(), despesa.categoria, despesa.descricao, despesa.valor, despesa.data, despesa.recorrencia, despesa.fim,
        req.body.notas ? String(req.body.notas).slice(0, 500) : null]
    );
    res.status(201).json({ id: rows[0].id, despesa });
  } catch (err) {
    console.error(`[DESPESAS] falha ao criar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar a despesa' });
  }
});

app.put('/api/admin/financeiro/despesas/:id', requireAdmin, exigirRecurso('despesas_operacionais'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'despesas exigem Postgres configurado' });
  const { despesa, erros } = financeiroDespesas.validarDespesa(req.body);
  if (erros) return res.status(400).json({ error: erros.join('; ') });
  try {
    const { rowCount } = await pgPool.query(
      `UPDATE despesas_operacionais SET categoria=$2, descricao=$3, valor=$4, data=$5,
         recorrencia=$6, fim=$7, notas=$8, atualizado_em=now() WHERE id = $1`,
      [req.params.id, despesa.categoria, despesa.descricao, despesa.valor, despesa.data,
        despesa.recorrencia, despesa.fim, req.body.notas ? String(req.body.notas).slice(0, 500) : null]
    );
    if (!rowCount) return res.status(404).json({ error: 'despesa não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[DESPESAS] falha ao atualizar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível atualizar a despesa' });
  }
});

app.delete('/api/admin/financeiro/despesas/:id', requireAdmin, exigirRecurso('despesas_operacionais'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'despesas exigem Postgres configurado' });
  try {
    const { rowCount } = await pgPool.query('DELETE FROM despesas_operacionais WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'despesa não encontrada' });
    res.status(204).end();
  } catch (err) {
    console.error(`[DESPESAS] falha ao excluir: ${err.message}`);
    res.status(500).json({ error: 'não foi possível excluir a despesa' });
  }
});

// ── Custo das APIs ────────────────────────────────────────────────────────────────────────
// Quanto a operação gasta em WhatsApp e em geração de criativos, além da mídia. Ver
// lib/custos/precos.js para por que nenhum número daqui se apresenta como exato.

async function lerPrecosCustos() {
  if (!pgPool) return custosPrecos.mesclarPrecos([]);
  const { rows } = await pgPool.query(
    'SELECT chave, valor, moeda, confianca, atualizado_em FROM custos_api_precos'
  );
  return custosPrecos.mesclarPrecos(rows.map((r) => ({
    chave: r.chave, valor: Number(r.valor), moeda: r.moeda, confianca: r.confianca,
    atualizadoEm: r.atualizado_em ? new Date(r.atualizado_em).toISOString() : null,
  })));
}

app.get('/api/admin/financeiro/custos-api/precos', requireAdmin, async (req, res) => {
  try {
    res.json({ precos: await lerPrecosCustos(), conferidoEm: custosPrecos.CONFERIDO_EM });
  } catch (err) {
    console.error(`[CUSTOS_API] falha ao ler preços: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler os preços' });
  }
});

app.put('/api/admin/financeiro/custos-api/precos/:chave', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'editar preços exige Postgres configurado' });
  const { erros, preco } = custosPrecos.validarPreco({ ...req.body, chave: req.params.chave });
  if (erros) return res.status(400).json({ error: erros[0], erros });
  try {
    await pgPool.query(
      `INSERT INTO custos_api_precos (chave, valor, moeda, confianca, atualizado_em)
            VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (organization_id, chave) DO UPDATE
            SET valor = EXCLUDED.valor, moeda = EXCLUDED.moeda,
                confianca = EXCLUDED.confianca, atualizado_em = now()`,
      [preco.chave, preco.valor, preco.moeda, preco.confianca]
    );
    res.json({ precos: await lerPrecosCustos(), conferidoEm: custosPrecos.CONFERIDO_EM });
  } catch (err) {
    console.error(`[CUSTOS_API] falha ao salvar preço: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar o preço' });
  }
});

// Volta um preço editado pro padrão do código — sem isso, um valor digitado errado só poderia ser
// corrigido por outro palpite, nunca desfeito.
app.delete('/api/admin/financeiro/custos-api/precos/:chave', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'editar preços exige Postgres configurado' });
  try {
    await pgPool.query('DELETE FROM custos_api_precos WHERE chave = $1', [req.params.chave]);
    res.json({ precos: await lerPrecosCustos(), conferidoEm: custosPrecos.CONFERIDO_EM });
  } catch (err) {
    console.error(`[CUSTOS_API] falha ao restaurar preço: ${err.message}`);
    res.status(500).json({ error: 'não foi possível restaurar o preço' });
  }
});

app.get('/api/admin/financeiro/custos-api', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'custos de API exigem Postgres configurado' });
  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);
  const desde = `((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($1::int - 1))`;
  try {
    const precos = await lerPrecosCustos();
    const { provider } = await readWhatsappProviderConfig();

    // WhatsApp Web sai do próprio celular do cliente: a Meta não cobra nada por essas mensagens.
    // Continuam sendo contadas porque "1.200 mensagens custando zero" é uma informação — some da
    // tela e o cliente acha que o painel não está enviando.
    const { rows: web } = await pgPool.query(
      `SELECT origem, COUNT(*)::int AS n FROM whatsapp_web_outbox
        WHERE status = 'sent' AND sent_at >= ${desde}
        GROUP BY origem`,
      [dias]
    );

    // Campanhas pela API da Meta: cada destinatário enviado é uma mensagem cobrada. A categoria
    // mora no template (lado do whatsapp-webhook-go), então é resolvida logo abaixo.
    const { rows: campanhas } = await pgPool.query(
      `SELECT c.template_nome AS template, COUNT(*)::int AS n
         FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
        WHERE r.sent_at IS NOT NULL AND r.sent_at >= ${desde}
        GROUP BY c.template_nome`,
      [dias]
    );

    // Categoria por template. Se o serviço estiver fora do ar, as mensagens viram "não medido" em
    // vez de serem cobradas na categoria errada — marketing custa ~8x utility no Brasil.
    let categoriaPorTemplate = new Map();
    if (campanhas.length) {
      try {
        const lista = await whatsappRequest('GET', '/templates/list');
        const templates = (lista && (lista.templates || lista.data)) || [];
        categoriaPorTemplate = new Map(templates.map((t) => [t.name, String(t.category || '').toLowerCase()]));
      } catch (err) {
        console.warn(`[CUSTOS_API] categorias de template indisponíveis: ${err.message}`);
      }
    }

    const porCategoria = {};
    let mensagensSemCategoria = 0;
    for (const linha of campanhas) {
      const categoria = categoriaPorTemplate.get(linha.template);
      if (!categoria) { mensagensSemCategoria += linha.n; continue; }
      porCategoria[categoria] = (porCategoria[categoria] || 0) + linha.n;
    }

    const parcelasWhats = Object.entries(porCategoria)
      .map(([categoria, n]) => {
        const c = custosPrecos.custoMensagens(categoria, n, precos);
        return c && { ...c, rotulo: `WhatsApp — ${categoria}`, categoria };
      })
      .filter(Boolean);

    // Geração de criativos. Soma só o que foi medido; o resto entra como "não medido" para a tela
    // poder dizer que o total não cobre tudo.
    let geracoes = { linhas: [], naoMedidas: 0 };
    try {
      const { rows } = await pgPool.query(
        `SELECT modelo_imagem,
                COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE tokens_saida IS NULL)::int AS sem_medicao,
                COALESCE(SUM(tokens_entrada), 0)::bigint AS entrada,
                COALESCE(SUM(tokens_entrada_texto), 0)::bigint AS entrada_texto,
                COALESCE(SUM(tokens_entrada_imagem), 0)::bigint AS entrada_imagem,
                COALESCE(SUM(tokens_entrada_cache), 0)::bigint AS entrada_cache,
                COALESCE(SUM(tokens_saida), 0)::bigint AS saida
           FROM creative_generations
          WHERE created_at >= ${desde}
          GROUP BY modelo_imagem`,
        [dias]
      );
      for (const r of rows) {
        geracoes.naoMedidas += r.sem_medicao;
        // Sem nenhuma medição no grupo não há o que precificar — evita uma linha de R$ 0,00 que
        // sugeriria que gerar criativo é de graça.
        if (Number(r.saida) === 0 && Number(r.entrada) === 0) continue;
        const custo = custosPrecos.custoGeracao({
          modeloImagem: r.modelo_imagem,
          tokensEntrada: Number(r.entrada),
          tokensEntradaTexto: Number(r.entrada_texto) || null,
          tokensEntradaImagem: Number(r.entrada_imagem) || null,
          tokensEntradaCache: Number(r.entrada_cache),
          tokensSaida: Number(r.saida),
        }, precos);
        if (custo) geracoes.linhas.push({ ...custo, rotulo: `Criativos — ${custo.modelo}`, quantidade: r.n });
      }
    } catch (err) {
      // Gerador pode nem estar instalado neste ambiente: ausência de tabela não é erro de custo.
      console.warn(`[CUSTOS_API] consumo de criativos indisponível: ${err.message}`);
    }

    const totalWhats = custosPrecos.totalizarCustos(parcelasWhats, { naoMedido: mensagensSemCategoria });
    const totalCriativos = custosPrecos.totalizarCustos(geracoes.linhas, { naoMedido: geracoes.naoMedidas });
    const geral = custosPrecos.totalizarCustos([...parcelasWhats, ...geracoes.linhas], {
      naoMedido: mensagensSemCategoria + geracoes.naoMedidas,
    });

    res.json({
      dias,
      conferidoEm: custosPrecos.CONFERIDO_EM,
      provider,
      whatsapp: {
        ...totalWhats,
        // Mensagens pelo celular: contadas, custo zero de API.
        semCustoDeApi: web.reduce((acc, r) => acc + r.n, 0),
        porOrigem: Object.fromEntries(web.map((r) => [r.origem, r.n])),
      },
      criativos: totalCriativos,
      geral,
    });
  } catch (err) {
    console.error(`[CUSTOS_API] falha ao calcular: ${err.message}`);
    res.status(500).json({ error: 'não foi possível calcular os custos de API' });
  }
});

app.get('/api/admin/analytics/consolidado', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'o consolidado exige Postgres configurado' });
  let periodo;
  try { periodo = resolverPeriodoMeta(req.query.from, req.query.to); } catch (err) { return res.status(400).json({ error: err.message }); }
  // A Store é a da sessão; nenhum parâmetro do request a sobrescreve (F-01). Identidade canônica:
  // `storeId`. A chave legada (`loja`, nula na Store nativa) só habilita o GA4 antigo, que ainda é
  // indexado por ela.
  const storeId = storeDoContexto();
  const loja = lojaLegadaDoContextoOuNula();

  try {
    const { fontes, sinalizados } = await midiaDaOrganizacao(periodo.from, periodo.to);
    const [dadosLoja, meta, ga4, conexaoMeta, despesasCadastradas] = await Promise.all([
      financeiroDaLoja(periodo.from, periodo.to),
      atribuicaoMeta(periodo.from, periodo.to, fontes),
      atribuicaoGA4(periodo.from, periodo.to),
      obterConexaoMeta(),
      listarDespesas(),
    ]);
    const despesas = financeiroDespesas.totalizarDespesas(despesasCadastradas, periodo.from, periodo.to);

    const midia = financeiroConsolidado.totalizarMidia(fontes);
    // Nenhuma despesa CADASTRADA é diferente de nenhuma despesa EXISTENTE: sem cadastro, o total
    // vai como null e o Lucro Operacional continua desconhecido, em vez de fingir que a operação
    // não tem custo fixo nenhum (spec §53AB).
    const temDespesas = despesasCadastradas.length > 0;
    const resultado = financeiroConsolidado.montarResultado({
      loja: dadosLoja, midia, despesas: temDespesas ? despesas : {},
      coberturaCompleta: dadosLoja.coberturaCompleta,
    });

    const qualidade = financeiroConsolidado.avaliarQualidade({
      pedidos: dadosLoja.pedidosTotal,
      pedidosSemFinanceiro: dadosLoja.semFinanceiro,
      provedoresFaltando: midia.faltando,
      despesasCadastradas: temDespesas,
      despesasNoPeriodo: temDespesas ? despesas.total : null,
      midiaSincronizadaEm: conexaoMeta ? conexaoMeta.last_successful_sync_at : null,
    });

    res.json({
      periodo,
      loja: { id: loja, storeId, nome: (loja && LOJAS[loja]) || (await nomeDaStoreDoContexto()) },
      resultado,
      indicadores: {
        // MER e Blended CAC usam o total REAL da loja: nenhum dos dois depende de custo de
        // produção, então cobertura parcial não os afeta.
        mer: financeiroConsolidado.mer(dadosLoja.receitaTotal, resultado.totalMidia),
        // Absolutos que dependem da margem inteira: sem cobertura completa, dividir a margem de um
        // recorte pelo gasto de TODO o tráfego inventa um prejuízo. A margem % (e o break-even que
        // sai dela) continuam, porque taxa do recorte estima bem a taxa da loja.
        roasDeMargem: dadosLoja.coberturaCompleta
          ? financeiroConsolidado.roasDeMargem(resultado.lucroProduto, resultado.totalMidia) : null,
        resultadoPorRealDeMidia: dadosLoja.coberturaCompleta
          ? financeiroConsolidado.resultadoPorRealDeMidia(resultado.lucroAposMidia, resultado.totalMidia) : null,
        breakEvenRoas: financeiroConsolidado.breakEvenRoas(resultado.margemProduto),
        blendedCac: financeiroConsolidado.blendedCac(resultado.totalMidia, dadosLoja.pedidosTotal),
        // ROAS de plataforma coexiste com o MER, nunca o substitui (spec §53J).
        roasMeta: meta ? metaActions.metricas.roas(meta.purchaseValue, resultado.midiaPorProvedor.meta) : null,
      },
      atribuicao: financeiroConsolidado.compararAtribuicao({ loja: { pedidos: dadosLoja.pedidosTotal, receita: dadosLoja.receitaTotal }, meta, ga4 }),
      cobertura: {
        pedidosComFinanceiro: dadosLoja.pedidos,
        pedidosTotal: dadosLoja.pedidosTotal,
        receitaTotal: dadosLoja.receitaTotal,
        completa: dadosLoja.coberturaCompleta,
      },
      despesas: temDespesas ? despesas : null,
      // Recurso de mídia fora do total (sem loja atribuída ou de outra loja) — INV-11.
      midiaSinalizada: sinalizados,
      ga4Disponivel: !!ga4,
      qualidade,
      midiaSincronizadaEm: conexaoMeta ? conexaoMeta.last_successful_sync_at : null,
    });
  } catch (err) {
    console.error(`[CONSOLIDADO] falha ao montar: ${mascararToken(err.message)}`);
    res.status(500).json({ error: 'não foi possível montar o consolidado financeiro' });
  }
});

// ── Integração com o serviço de WhatsApp (whatsapp-webhook-go) ─────────
// Serviço externo já existente (API oficial Meta Cloud API). Aqui só montamos a mensagem
// e chamamos ele — nenhuma lógica de envio de fato mora neste projeto.
const WHATSAPP_SERVICE_URL = (process.env.WHATSAPP_SERVICE_URL || '').replace(/\/+$/, '');
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY || null;

// Modo de envio das automações: "manual" (padrão, seguro) só enfileira — alguém revisa e
// clica "enviar" no dashboard do whatsapp-webhook-go. "automatico" dispara direto, sem revisão.
// `janelaEnvio` é o horário em que QUALQUER mensagem automática pode sair (exceto
// payment.approved, que é urgente por natureza) — evita mandar WhatsApp de madrugada.
const AUTOMACAO_FILE = path.join(PEDIDOS_DIR, 'automacao.json');
const AUTOMACAO_SETTINGS_PADRAO = { modoEnvio: 'manual', janelaEnvio: { inicio: 8, fim: 22 } };
if (!fs.existsSync(AUTOMACAO_FILE)) fs.writeFileSync(AUTOMACAO_FILE, JSON.stringify(AUTOMACAO_SETTINGS_PADRAO));

async function readAutomacaoSettings() {
  const settings = await lerConfigPostgres('automacao-settings', AUTOMACAO_FILE, AUTOMACAO_SETTINGS_PADRAO);
  return { ...AUTOMACAO_SETTINGS_PADRAO, ...settings };
}
async function writeAutomacaoSettings(settings) {
  return salvarConfigPostgres('automacao-settings', AUTOMACAO_FILE, settings);
}

// Servidor roda em UTC (Vercel) — sem converter pro fuso do Brasil, "08h-22h" seria calculado
// 3h adiantado (ex: 05h-19h UTC de fato vira 08h-22h em Brasília só por coincidência de DST).
function horaAtualBrasil() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
}

// payment.approved nunca respeita a janela — é a mensagem mais urgente de todas (cliente quer
// saber na hora que o pagamento passou). Todo o resto some pra fila até a janela abrir.
function respeitaJanelaDeEnvio(eventName) {
  return eventName !== 'payment.approved';
}

async function dentroDaJanelaDeEnvio() {
  const { janelaEnvio } = await readAutomacaoSettings();
  const janela = janelaEnvio || AUTOMACAO_SETTINGS_PADRAO.janelaEnvio;
  const hora = horaAtualBrasil();
  return hora >= janela.inicio && hora < janela.fim;
}

function formatarTelefoneWhatsapp(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length <= 11 ? `55${digits}` : digits;
}

// Formata uma lista de itens (pedido ou carrinho — mesmo formato de item nos dois) como texto
// simples pra caber numa variável de template ("2x Camiseta Azul, 1x Camiseta Preta").
function formatarListaItens(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items
    .map((it) => {
      const nome = (it.product_v2 && it.product_v2.name) || it.sku || 'item';
      return `${it.quantity || 1}x ${nome}`;
    })
    .join(', ');
}

function formatarDataBr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR');
}

async function variaveisDoPedido(order, loja) {
  const primeiroItem = order.items && order.items[0];
  const numeroPedido = order.rsv_factory_id || String(order.id || '');
  const base = {
    'cliente.nome': order.buyer ? [order.buyer.first_name, order.buyer.last_name].filter(Boolean).join(' ').trim() : '',
    'cliente.email': (order.buyer && order.buyer.email) || '',
    'cliente.telefone': (order.buyer && order.buyer.phone) || '',
    'cliente.documento': (order.buyer && order.buyer.document) || '',
    // `rsv_factory_id` já vem com o prefixo "INK" (ex: INK1234567) — mantém as duas opções
    // porque um template pode ter escrito "Pedido INK{{2}}" no texto (duplicaria o prefixo se
    // usasse a variável com INK) ou "Pedido {{2}}" (precisa do prefixo).
    'pedido.numero': numeroPedido,
    'pedido.numero_sem_prefixo': numeroPedido.replace(/^INK/i, ''),
    'pedido.status': order.formatted_order_status || order.order_status || '',
    'pedido.valor': order.total_value != null ? `R$ ${order.total_value}` : '',
    'pedido.metodo_pagamento': order.payment_method || '',
    'pedido.itens': formatarListaItens(order.items),
    'pedido.transportadora': (order.delivery && order.delivery.carrier) || '',
    'pedido.previsao_entrega': formatarDataBr(order.delivery && order.delivery.estimated_delivery_date),
    'pedido.rastreio': order.tracking_url || '',
    'loja.nome': LOJAS[loja] || loja,
    'produto.nome': (primeiroItem && primeiroItem.product_v2 && primeiroItem.product_v2.name) || '',
    'link': order.tracking_url || '',
  };
  return { ...base, ...(await variaveisCustomizadas(loja, base)) };
}

// Mesma ideia, mas pra um carrinho abandonado — formato confirmado com uma entrega real do
// webhook (2026-09-03, evento cart.abandoned): corpo vem em `body.data`, com `id` (numérico) e
// `uuid` (usado pra montar o link de recuperação do carrinho, ex:
// https://.../cart/{{carrinho.uuid}} — a URL exata depende de como a INK expõe isso).
async function variaveisDoCarrinho(cart, loja) {
  const base = {
    'cliente.nome': (cart.buyer && cart.buyer.name) || '',
    'cliente.email': (cart.buyer && cart.buyer.email) || '',
    'cliente.telefone': (cart.buyer && cart.buyer.phone) || '',
    'loja.nome': LOJAS[loja] || loja,
    'carrinho.produto': (cart.items && cart.items[0] && cart.items[0].product_v2 && cart.items[0].product_v2.name) || '',
    'carrinho.itens': formatarListaItens(cart.items),
    'carrinho.quantidade_itens': String(cart.items_count || (cart.items && cart.items.length) || ''),
    'carrinho.uuid': cart.uuid || '',
    'link': '',
  };
  return { ...base, ...(await variaveisCustomizadas(loja, base)) };
}

// Heurística pra separar evento de carrinho abandonado de evento de pedido (mesma ideia usada
// na página Eventos) — decide se o dado vem de `variaveisDoPedido` ou `variaveisDoCarrinho`.
function eventoEhDeCarrinho(eventName) {
  if (!eventName) return false;
  const n = eventName.toLowerCase();
  return n.includes('cart') || n.includes('carrinho');
}

// Evento sintético (não vem literal da Reserva Ink) disparado quando um pedido chega com Pix
// pendente — ver `registrarPixPendenteSeAplicavel`. Junto com carrinho abandonado, são os únicos
// eventos com cadência de reenvio (atraso do 1º envio + intervalo + anti-spam).
const EVENTO_PIX_PENDENTE = 'pix.pendente';
function eventoTemCadencia(eventName) {
  return eventoEhDeCarrinho(eventName) || eventName === EVENTO_PIX_PENDENTE;
}

// Meta suporta variável posicional ({{1}}, {{2}} — o formato que a gente sempre gerou aqui) e
// variável nomeada ({{customer_name}} — comum em templates criados direto no painel da Meta).
// Extrai o token cru na ordem de 1ª aparição, sem duplicata — quem chama decide o que fazer com
// cada um (número = posicional, resto = nomeado, exige `parameter_name` no envio).
function extrairTokensVariaveis(texto) {
  if (!texto) return [];
  const vistos = new Set();
  const ordenados = [];
  for (const m of texto.match(/\{\{([^{}]+)\}\}/g) || []) {
    const token = m.slice(2, -2).trim();
    if (!vistos.has(token)) { vistos.add(token); ordenados.push(token); }
  }
  return ordenados;
}

// Monta o parâmetro de texto pro envio — inclui `parameter_name` quando o token não é numérico
// (variável nomeada), do contrário fica só posicional (comportamento de sempre).
function construirParametroTexto(token, valor) {
  const param = { type: 'text', text: valor != null ? String(valor) : '' };
  if (token && !/^\d+$/.test(token)) param.parameter_name = token;
  return param;
}

// Acha o botão de link (URL) dinâmico dentro dos `components` reais da Meta — nunca confia em
// cache local (que só existe pra template criado por este painel); funciona igual pra qualquer
// template, de onde quer que tenha vindo.
function extrairBotaoDinamico(components) {
  const buttonsComp = (components || []).find((c) => c.type === 'BUTTONS');
  if (!buttonsComp) return null;
  const indice = (buttonsComp.buttons || []).findIndex((b) => b.type === 'URL' && /\{\{[^{}]+\}\}/.test(b.url || ''));
  return indice === -1 ? null : { indice };
}

// Acha o vínculo evento→template de carrinho abandonado de uma loja — igual a `registro.evento`
// quando já existe um registro de automação, mas resolve mesmo sem nenhum registro ainda (usado
// pelo preview manual da tela de Recuperação, que precisa existir ANTES do 1º envio automático).
function eventoConfigDeCarrinho(eventosLoja, provider) {
  const chave = Object.keys(eventosLoja || {}).find((ev) => eventoEhDeCarrinho(ev) && vinculoConfigurado(eventosLoja[ev], provider));
  return chave ? { chave, config: eventosLoja[chave] } : null;
}

// Texto cru (com {{1}}, {{2}}... ou {{nome_variavel}}) do cabeçalho/corpo aprovados na Meta —
// mesma leitura feita em templates-detalhe.js, só que server-side.
function textosDoTemplateMeta(templateMeta) {
  const comps = (templateMeta && templateMeta.components) || [];
  const header = comps.find((c) => c.type === 'HEADER' && c.format === 'TEXT');
  const corpo = comps.find((c) => c.type === 'BODY');
  return { header: header ? header.text : null, corpo: corpo ? corpo.text : null };
}

function substituirTokenTemplate(texto, token, valor) {
  if (!texto || !token) return texto;
  const re = new RegExp(`\\{\\{${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
  return texto.replace(re, valor != null ? String(valor) : '');
}

// Monta o texto final (cabeçalho + corpo) já com as variáveis reais substituídas — pro botão
// "Copiar template" da tela de Recuperação: mesmo conteúdo que sairia pela Meta, só que copiável
// manualmente em vez de enviado pela API (decisão do usuário, 2026-09-05: quer poder mandar pelo
// WhatsApp pessoal sem depender do envio automático).
function renderizarMensagemTemplate(templateMeta, eventoConfig, vars) {
  const { header, corpo } = textosDoTemplateMeta(templateMeta);
  if (!corpo) return null;
  let corpoFinal = corpo;
  (eventoConfig.corpoVariaveis || []).forEach((varKey, i) => {
    const token = (eventoConfig.corpoTokens && eventoConfig.corpoTokens[i]) || String(i + 1);
    corpoFinal = substituirTokenTemplate(corpoFinal, token, vars[varKey]);
  });
  let headerFinal = header || null;
  if (headerFinal && eventoConfig.headerVariavel) {
    const token = eventoConfig.headerToken || '1';
    headerFinal = substituirTokenTemplate(headerFinal, token, vars[eventoConfig.headerVariavel]);
  }
  return [headerFinal, corpoFinal].filter(Boolean).join('\n\n');
}

// Chamadas ao whatsapp-webhook-go (Fase 5b). Toda rota que age em nome de uma Organization leva o
// remetente dela nos headers internos X-Sender-* (número + WABA + token + referência assinada),
// resolvido aqui a partir da Organization do contexto — nunca do corpo, da query ou do /health do
// serviço. Só as rotas do próprio serviço (saúde, contadores) vão sem remetente.
//
// Sem remetente cadastrado, a chamada falha aqui (409) e não chega ao serviço: não existe número
// padrão em lugar nenhum.
const WHATSAPP_ROTAS_SEM_REMETENTE = new Set(['/health']);
// Fase 5c: leituras do serviço que são de UMA Organization (contadores, eventos) levam só o contexto
// — número + referência assinada —, nunca o token.
const WHATSAPP_ROTAS_SO_CONTEXTO = new Set(['/dashboard/events']);
const WHATSAPP_REMETENTE_AUSENTE = new Set(['INTEGRATION_NOT_CONNECTED', 'SENDER_INCOMPLETE']);

async function whatsappRequest(method, pathAndQuery, body) {
  if (!WHATSAPP_SERVICE_URL || !WHATSAPP_API_KEY) {
    const err = new Error('integração com WhatsApp não configurada (WHATSAPP_SERVICE_URL/WHATSAPP_API_KEY)');
    err.status = 503;
    throw err;
  }
  const caminho = pathAndQuery.split('?')[0];
  if (WHATSAPP_ROTAS_SEM_REMETENTE.has(caminho)) {
    return chamarServicoWhatsapp(method, pathAndQuery, body, {});
  }
  const soContexto = WHATSAPP_ROTAS_SO_CONTEXTO.has(caminho);
  let chamou = false;
  try {
    return await exigirRemetenteWhatsapp().comRemetente((remetente) => {
      chamou = true;
      const headers = headersDoRemetente(remetente);
      if (soContexto) {
        delete headers[WHATSAPP_HEADER_TOKEN];
        delete headers[WHATSAPP_HEADER_WABA];
      }
      return chamarServicoWhatsapp(method, pathAndQuery, body, headers);
    });
  } catch (err) {
    if (chamou || !WHATSAPP_REMETENTE_AUSENTE.has(err.codigo)) throw err;
    const semNumero = new Error('número do WhatsApp não cadastrado nesta loja (Integrações › Número do WhatsApp)');
    semNumero.status = 409;
    semNumero.codigo = 'WHATSAPP_SENDER_NOT_CONFIGURED';
    throw semNumero;
  }
}

// A Meta recusou o token (expirado/revogado): guarda o fato na integração para o painel dizer a verdade.
// Trocar o token (salvar de novo) recria a config e apaga a marca.
async function marcarTokenWhatsappInvalido() {
  const integracoes = exigirIntegracoes();
  const m = await integracoes.metadata('whatsapp');
  if (m.config.token_invalido_em) return;
  await integracoes.gravarConfig('whatsapp', { ...m.config, token_invalido_em: new Date().toISOString() });
}

async function chamarServicoWhatsapp(method, pathAndQuery, body, headersDoRemetenteOuVazio) {
  const headers = { 'X-Api-Key': WHATSAPP_API_KEY, ...headersDoRemetenteOuVazio };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${WHATSAPP_SERVICE_URL}${pathAndQuery}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    // Quando a Meta rejeita algo que a gente não valida antes (código de erro novo, regra que
    // mudou), o whatsapp-webhook-go repassa o erro cru dela embutido numa string
    // ("meta api 400: {...}") — tenta extrair a mensagem amigável (`error_user_msg`) em vez de
    // mostrar o JSON cru pro admin.
    let mensagem = data.error || `whatsapp-webhook-go respondeu ${res.status}`;
    // Erro da Meta embutido ("meta api 401: {…}"): vira código + mensagem de produto. O corpo bruto (com
    // fbtrace_id, horário em PDT…) nunca chega à tela. Token expirado também marca a integração como
    // "com problema" — o card deixa de dizer "Conectada" enquanto a Meta recusa o token.
    const classificado = classificarErroWhatsapp(res.status, typeof mensagem === 'string' ? mensagem : '');
    if (classificado) {
      if (classificado.tokenInvalido) await marcarTokenWhatsappInvalido().catch(() => {});
      const erroMeta = new Error(classificado.mensagem);
      erroMeta.status = classificado.httpStatus;
      erroMeta.codigo = classificado.codigo;
      throw erroMeta;
    }
    const match = typeof mensagem === 'string' && mensagem.match(/\{.*\}/s);
    if (match) {
      try {
        const metaErro = JSON.parse(match[0]).error;
        if (metaErro && metaErro.error_user_msg) mensagem = metaErro.error_user_msg;
      } catch { /* mantém a mensagem original se não for JSON válido */ }
    }
    const err = new Error(mensagem);
    err.status = res.status;
    throw err;
  }
  return data;
}

app.get('/api/admin/automation-settings', requireAdmin, async (req, res) => {
  try {
    const settings = await readAutomacaoSettings();
    res.json({
      ...settings,
      whatsappConfigurado: !!(WHATSAPP_SERVICE_URL && WHATSAPP_API_KEY),
      provider: (await readWhatsappProviderConfig()).provider,
    });
  } catch (err) {
    console.error(`[AUTOMACAO] falha ao ler configurações: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler as configurações de automação' });
  }
});

app.patch('/api/admin/automation-settings', requireAdmin, async (req, res) => {
  const { modoEnvio, janelaEnvio } = req.body || {};
  if (modoEnvio === undefined && janelaEnvio === undefined) {
    return res.status(400).json({ error: 'informe modoEnvio e/ou janelaEnvio' });
  }
  if (modoEnvio !== undefined && modoEnvio !== 'manual' && modoEnvio !== 'automatico') {
    return res.status(400).json({ error: 'modoEnvio deve ser "manual" ou "automatico"' });
  }
  if (janelaEnvio !== undefined) {
    const { inicio, fim } = janelaEnvio || {};
    if (!Number.isInteger(inicio) || !Number.isInteger(fim) || inicio < 0 || inicio > 23 || fim < 1 || fim > 24 || inicio >= fim) {
      return res.status(400).json({ error: 'janela de envio inválida (início e fim devem ser horas entre 0 e 24, com início menor que fim)' });
    }
  }
  try {
    const atual = await readAutomacaoSettings();
    const nova = {
      ...atual,
      ...(modoEnvio !== undefined ? { modoEnvio } : {}),
      ...(janelaEnvio !== undefined ? { janelaEnvio: { inicio: janelaEnvio.inicio, fim: janelaEnvio.fim } } : {}),
    };
    await writeAutomacaoSettings(nova);
    res.json({ ok: true, ...nova });
  } catch (err) {
    console.error(`[AUTOMACAO] falha ao salvar configurações: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar as configurações de automação' });
  }
});

// ── WhatsApp Web (alternativa à API da Meta) ────────────────────────────
// Ver docs/plano-whatsapp-web-envio.md. `provider` decide por onde TODO envio automático sai:
// "meta_api" (padrão — exatamente o comportamento de sempre, via whatsapp-webhook-go) ou
// "whatsapp_web" (enfileira em whatsapp_web_outbox; o agente local consome e envia).
//
// Limites: na API da Meta o teto é o tier da conta + o saldo; no WhatsApp Web o que pesa é o
// risco de bloqueio do número, então existe um volume recomendado por dia (faixas abaixo, mesma
// leitura que o InkPilot expõe). Campanhas só saem enquanto o dia está abaixo do recomendado —
// mensagens transacionais (pedido, Pix, carrinho) continuam até o teto diário.
const WHATSAPP_PROVIDER_FILE = path.join(PEDIDOS_DIR, 'whatsapp-provider.json');
const WHATSAPP_PROVIDER_PADRAO = { provider: 'meta_api', limiteRecomendado: 100, tetoDiario: 200 };
const WHATSAPP_WEB_FAIXAS = { seguro: 50, atencao: 200, risco: 500 };
const WHATSAPP_WEB_AGENTE_FILE = path.join(PEDIDOS_DIR, 'whatsapp-web-agente.json');
const WHATSAPP_WEB_LEASE_MIN = 5;
const WHATSAPP_WEB_AGENTE_ONLINE_SEG = 90;
const WHATSAPP_WEB_ORIGENS = ['pedido', 'carrinho', 'pix', 'campanha'];
const WHATSAPP_WEB_STATUS = ['aguardando_aprovacao', 'pending', 'claimed', 'sent', 'failed', 'desconhecido', 'cancelado'];
const WHATSAPP_WEB_CODIGOS_FALHA = [
  'numero_invalido', 'timeout', 'nao_confirmado', 'erro_envio', 'whatsapp_desconectado',
  // App desktop: o usuário usou o computador no meio do envio / o WhatsApp não ficou em primeiro plano.
  'interrompido', 'app_nao_abriu',
];
// 'nao_verificavel': o app desktop controla o WhatsApp pelo teclado e não tem como saber se ele
// está logado.
const WHATSAPP_WEB_ESTADOS_AGENTE = ['logado', 'aguardando_qr', 'carregando', 'erro', 'nao_verificavel'];
const WHATSAPP_WEB_EXECUTORES = { desktop: 'WhatsApp Desktop', navegador: 'WhatsApp Web (navegador)' };
const WHATSAPP_WEB_PLATAFORMAS = ['darwin', 'win32', 'linux'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function readWhatsappProviderConfig() {
  const cfg = await lerConfigPostgres('whatsapp-provider', WHATSAPP_PROVIDER_FILE, WHATSAPP_PROVIDER_PADRAO);
  return { ...WHATSAPP_PROVIDER_PADRAO, ...cfg };
}

// Token do agente nunca é guardado em claro — só o SHA-256 (o valor aparece 1x, na geração).
async function readWhatsappWebAgente() {
  return lerConfigPostgres('whatsapp-web-agente', WHATSAPP_WEB_AGENTE_FILE, {});
}
async function writeWhatsappWebAgente(dados) {
  return salvarConfigPostgres('whatsapp-web-agente', WHATSAPP_WEB_AGENTE_FILE, dados);
}

function hashTokenAgente(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Vínculo evento→mensagem guarda os dois modos lado a lado: `template` (+ mapeamento posicional)
// pra API da Meta e `mensagemWeb` (id em whatsapp_web_mensagens) pro WhatsApp Web. A cadência
// (atraso, reenvios, checar compra) é do evento, vale pros dois. Trocar de provider nunca apaga
// o vínculo do outro modo — só muda qual deles está valendo.
function vinculoConfigurado(eventoConfig, provider) {
  if (!eventoConfig) return false;
  return provider === 'whatsapp_web' ? !!eventoConfig.mensagemWeb : !!eventoConfig.template;
}

const CAMPOS_VINCULO_API = ['template', 'headerVariavel', 'headerToken', 'corpoVariaveis', 'corpoTokens', 'botaoVariavel', 'botaoIndice'];

// Remove só a parte de um modo; se não sobrar vínculo de nenhum dos dois, o evento sai inteiro.
// Devolve true se o evento foi removido por completo.
function removerVinculoDoModo(eventosLoja, evento, modo) {
  const atual = eventosLoja[evento];
  if (!atual) return false;
  if (modo === 'web') delete atual.mensagemWeb;
  else CAMPOS_VINCULO_API.forEach((campo) => { delete atual[campo]; });
  if (!atual.template && !atual.mensagemWeb) {
    delete eventosLoja[evento];
    return true;
  }
  return false;
}

async function buscarMensagemWeb(id) {
  if (!pgPool || !id || !UUID_RE.test(id)) return null;
  const { rows } = await pgPool.query('SELECT id, nome, tipo, corpo, variacoes FROM whatsapp_web_mensagens WHERE id = $1', [id]);
  return rows[0] || null;
}

// Sorteia uma versão entre o corpo e as variações. `variacao` é 1-based (1 = corpo) — é o que o
// painel mostra na fila ("Versão 2").
function sortearVersaoMensagemWeb(corpo, variacoes) {
  const versoes = [corpo, ...(Array.isArray(variacoes) ? variacoes : [])].filter((v) => typeof v === 'string' && v.trim());
  const indice = versoes.length > 1 ? crypto.randomInt(versoes.length) : 0;
  return { corpo: versoes[indice] || '', variacao: indice + 1 };
}

// Variáveis nomeadas direto no texto ({{cliente.nome}}). Variável sem valor vira vazio — nunca
// deixa "{{...}}" cru chegar pro cliente.
function renderizarMensagemWeb(corpo, vars) {
  return String(corpo || '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, chave) => (vars[chave] != null ? String(vars[chave]) : ''));
}

function extrairVariaveisMensagemWeb(corpo) {
  const chaves = new Set();
  for (const m of String(corpo || '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) chaves.add(m[1]);
  return [...chaves];
}

function templateTemMidiaNoCabecalho(templateMeta) {
  const header = ((templateMeta && templateMeta.components) || []).find((c) => c.type === 'HEADER');
  return !!(header && header.format && header.format !== 'TEXT');
}

// WhatsApp Web não tem botão de template: botão de link vira linha "Texto: URL" (com a parte
// dinâmica já trocada), telefone vira "Texto: número". Resposta rápida/copiar código não têm
// equivalente em texto e são descartados. Rodapé entra como última linha.
function anexarRodapeEBotoes(texto, templateMeta, valorBotaoDinamico) {
  const comps = (templateMeta && templateMeta.components) || [];
  const linhas = [];
  const botoes = (comps.find((c) => c.type === 'BUTTONS') || {}).buttons || [];
  for (const botao of botoes) {
    if (botao.type === 'URL' && botao.url) {
      const dinamico = /\{\{[^{}]+\}\}/.test(botao.url);
      if (dinamico && (valorBotaoDinamico == null || valorBotaoDinamico === '')) continue;
      const url = dinamico ? botao.url.replace(/\{\{[^{}]+\}\}/, String(valorBotaoDinamico)) : botao.url;
      linhas.push(`${botao.text}: ${url}`);
    } else if (botao.type === 'PHONE_NUMBER' && botao.phone_number) {
      linhas.push(`${botao.text}: ${botao.phone_number}`);
    }
  }
  const rodape = comps.find((c) => c.type === 'FOOTER');
  if (rodape && rodape.text) linhas.push(rodape.text);
  return linhas.length ? `${texto}\n\n${linhas.join('\n')}` : texto;
}

// Texto de campanha — variáveis vêm de `resolved_variables` (token → valor, com __header__ e
// __botao__), mesma convenção de montarComponentesEnvioCampanha.
function renderizarTextoCampanhaWeb(templateMeta, resolvedVariables) {
  const vars = resolvedVariables || {};
  const { header, corpo } = textosDoTemplateMeta(templateMeta);
  if (!corpo) throw new Error('template da campanha sem corpo de texto');
  let corpoFinal = corpo;
  for (const token of extrairTokensVariaveis(corpo)) corpoFinal = substituirTokenTemplate(corpoFinal, token, vars[token]);
  let headerFinal = header || null;
  if (headerFinal) {
    const [token] = extrairTokensVariaveis(headerFinal);
    if (token) headerFinal = substituirTokenTemplate(headerFinal, token, vars.__header__);
  }
  const base = [headerFinal, corpoFinal].filter(Boolean).join('\n\n');
  return { texto: anexarRodapeEBotoes(base, templateMeta, vars.__botao__), midiaIgnorada: templateTemMidiaNoCabecalho(templateMeta) };
}

async function enfileirarWhatsappWeb({ origem, referencia, campaignRecipientId, loja, evento, to, nome, template, texto, midiaIgnorada, status, variacao }) {
  if (!pgPool) throw new Error('envio pelo WhatsApp Web exige Postgres (DATABASE_URL)');
  const { rowCount } = await pgPool.query(
    `INSERT INTO whatsapp_web_outbox
       (id, origem, referencia, campaign_recipient_id, loja, evento, telefone, nome, template, texto, midia_ignorada, status, dedupe_key, variacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), origem, referencia, campaignRecipientId || null, loja || null, evento || null, to, nome || null,
      template || null, texto, !!midiaIgnorada, status, `${origem}:${referencia}`, variacao || null]
  );
  return rowCount > 0;
}

// Ponto único de envio das automações (pedido, carrinho, Pix). Com provider "meta_api" faz
// exatamente o que as 3 funções faziam antes (modoEnvio → /send/template ou /queue/add), e só
// então monta os components da Meta (`montarPayloadMeta`). No modo Web usa a mensagem própria
// vinculada ao evento — sem depender do whatsapp-webhook-go.
// Devolve false quando o modo ativo não tem mensagem vinculada (quem chama não registra envio).
async function despacharWhatsapp({ origem, referencia, loja, evento, pedido, nome, to, eventoConfig, vars, montarPayloadMeta }) {
  const [{ provider }, { modoEnvio }] = await Promise.all([readWhatsappProviderConfig(), readAutomacaoSettings()]);
  if (!vinculoConfigurado(eventoConfig, provider)) return false;

  if (provider !== 'whatsapp_web') {
    const payload = await montarPayloadMeta();
    if (modoEnvio === 'automatico') {
      await whatsappRequest('POST', '/send/template', payload);
    } else {
      await whatsappRequest('POST', '/queue/add', { type: 'template', ...payload, pedido, loja: LOJAS[loja] || loja });
    }
    return true;
  }

  const mensagem = await buscarMensagemWeb(eventoConfig.mensagemWeb);
  if (!mensagem) throw new Error(`mensagem do WhatsApp Web vinculada a ${loja}/${evento} não existe mais`);
  const versao = sortearVersaoMensagemWeb(mensagem.corpo, mensagem.variacoes);
  const texto = renderizarMensagemWeb(versao.corpo, vars).trim();
  if (!texto) throw new Error(`mensagem "${mensagem.nome}" ficou vazia depois de trocar as variáveis`);
  await enfileirarWhatsappWeb({
    origem, referencia, loja, evento, nome, to, template: mensagem.nome, texto, midiaIgnorada: false, variacao: versao.variacao,
    // "manual" continua significando revisão humana antes de sair — só que a revisão agora é na
    // fila do painel, não no dashboard do serviço Go.
    status: modoEnvio === 'automatico' ? 'pending' : 'aguardando_aprovacao',
  });
  return true;
}

// Início do dia no fuso de Brasília — mesma razão de horaAtualBrasil (servidor roda em UTC).
const SQL_INICIO_DIA_BRASIL = `(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`;

async function resumoVolumeWhatsappWebHoje() {
  const { rows } = await pgPool.query(
    `SELECT origem, COUNT(*)::int AS n FROM whatsapp_web_outbox
      WHERE status = 'sent' AND sent_at >= ${SQL_INICIO_DIA_BRASIL}
      GROUP BY origem`
  );
  const porOrigem = Object.fromEntries(WHATSAPP_WEB_ORIGENS.map((o) => [o, 0]));
  let total = 0;
  for (const r of rows) { porOrigem[r.origem] = r.n; total += r.n; }
  return { total, porOrigem };
}

// Item preso em 'claimed' além do lease = agente caiu no meio. NÃO volta pra 'pending' (a
// mensagem pode ter saído) — vira 'desconhecido' e o admin decide se reenvia. Mesma lógica de
// recuperarDestinatariosTravados nas campanhas.
async function expirarLeasesWhatsappWeb() {
  const { rowCount } = await pgPool.query(
    `UPDATE whatsapp_web_outbox SET status = 'desconhecido', failure_code = 'lease_expirado',
       failure_message = 'agente não reportou o resultado a tempo — confira no WhatsApp antes de reenviar',
       atualizado_em = now()
     WHERE status = 'claimed' AND lease_ate < now()`
  );
  if (rowCount) console.warn(`[WHATSAPP_WEB] ${rowCount} item(ns) com lease vencido marcado(s) como desconhecido`);
}

// Autenticação do agente local: Bearer token gerado em Integrações. Só vale pras rotas do agente,
// nunca pras rotas /api/admin (que continuam exigindo a sessão).
async function requireAgenteWhatsappWeb(req, res, next) {
  const match = (req.get('authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{32,128})$/);
  if (!match) return res.status(401).json({ error: 'não autenticado' });
  try {
    // O token é da Organization que o emitiu: é ela o contexto do agente, e mais nenhuma.
    const hash = hashTokenAgente(match[1]);
    const organizationId = await organizacaoPorResolvedor('publico_organization_do_agente', hash);
    if (!organizationId) return res.status(401).json({ error: 'não autenticado' });
    const store = await semContexto(() => resolverStore(pgPoolReal, organizationId));
    return comContexto({ organizationId, storeId: store.storeId, loja: store.loja, origem: 'agente:whatsapp-web' }, async () => {
      const { tokenHash } = await readWhatsappWebAgente();
      if (!tokenHash || !safeEqual(hash, tokenHash)) return res.status(401).json({ error: 'não autenticado' });
      return next();
    });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao validar token do agente: ${err.message}`);
    res.status(500).json({ error: 'falha ao validar token' });
  }
}

app.post('/api/whatsapp-web-agente/heartbeat', requireAgenteWhatsappWeb, async (req, res) => {
  const { versao, whatsapp, executor, plataforma, pausado, testando } = req.body || {};
  if (!WHATSAPP_WEB_ESTADOS_AGENTE.includes(whatsapp)) return res.status(400).json({ error: 'estado do whatsapp inválido' });
  if (executor !== undefined && !WHATSAPP_WEB_EXECUTORES[executor]) return res.status(400).json({ error: 'executor inválido' });
  if (plataforma !== undefined && !WHATSAPP_WEB_PLATAFORMAS.includes(plataforma)) return res.status(400).json({ error: 'plataforma inválida' });
  try {
    const atual = await readWhatsappWebAgente();
    await writeWhatsappWebAgente({
      ...atual,
      ultimoHeartbeatEm: new Date().toISOString(),
      versao: typeof versao === 'string' ? versao.slice(0, 20) : null,
      whatsapp,
      executor: executor || null,
      plataforma: plataforma || null,
      pausado: pausado === true,
      testando: testando === true,
    });
    const { provider } = await readWhatsappProviderConfig();
    res.json({ ok: true, ativo: provider === 'whatsapp_web' });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha no heartbeat: ${err.message}`);
    res.status(500).json({ error: 'falha ao registrar heartbeat' });
  }
});

// Reserva 1 item por vez — o ritmo entre mensagens é do agente; aqui ficam as regras que não
// podem depender dele: provider ativo, teto diário, janela de horário (o agente pode ficar
// offline e voltar de madrugada) e campanhas só abaixo do volume recomendado.
app.post('/api/whatsapp-web-agente/claim', requireAgenteWhatsappWeb, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'Postgres não configurado' });
  try {
    const cfg = await readWhatsappProviderConfig();
    if (cfg.provider !== 'whatsapp_web') return res.json({ item: null, motivo: 'provider_inativo' });

    await expirarLeasesWhatsappWeb();
    const { total } = await resumoVolumeWhatsappWebHoje();
    if (total >= cfg.tetoDiario) return res.json({ item: null, motivo: 'teto_diario' });

    const dentroJanela = await dentroDaJanelaDeEnvio();
    const campanhasLiberadas = total < cfg.limiteRecomendado;
    // Recheca a compra AQUI, não só ao enfileirar. A mensagem de recuperação pode ficar parada na
    // fila por horas — janela de envio, teto diário, limite recomendado — e a compra acontecer nesse
    // intervalo. Sem esta verificação, o app entregaria "esqueceu algo no carrinho?" pra quem acabou
    // de comprar. É o único ponto por onde a mensagem realmente sai, então é aqui que a regra tem
    // que valer, qualquer que tenha sido o caminho até a fila.
    let rows = [];
    // Teto de tentativas: cada volta descarta um item já comprado e tenta o próximo. Sem limite,
    // uma fila inteira de itens obsoletos seguraria a requisição do app.
    for (let tentativa = 0; tentativa < 20; tentativa += 1) {
      const claim = await pgPool.query(
        `UPDATE whatsapp_web_outbox
            SET status = 'claimed', claimed_at = now(), lease_ate = now() + make_interval(mins => $3), executor = 'app',
                tentativas = tentativas + 1, atualizado_em = now()
          WHERE id = (
            SELECT id FROM whatsapp_web_outbox
             WHERE status = 'pending'
               AND ($1::boolean OR evento = 'payment.approved')
               AND ($2::boolean OR origem <> 'campanha')
             ORDER BY COALESCE(evento = 'payment.approved', false) DESC, (origem = 'campanha') ASC, criado_em ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, telefone, texto, origem, loja, criado_em`,
        [dentroJanela, campanhasLiberadas, WHATSAPP_WEB_LEASE_MIN]
      );
      if (!claim.rows.length) { rows = []; break; }
      const item = claim.rows[0];
      // Só recuperação: campanha é disparo proativo de audiência, e pedido/pix aprovado é
      // transacional — nenhum dos dois fica sem sentido porque o cliente comprou.
      const eRecuperacao = item.origem === 'carrinho' || item.origem === 'pix';
      if (!eRecuperacao || !item.loja) { rows = claim.rows; break; }
      // `criado_em` do item é o começo da janela que o enfileiramento não cobria: o que veio antes
      // dele já foi checado lá.
      const comprou = await clienteJaComprou(item.loja, { telefone: item.telefone }, item.criado_em);
      if (!comprou) { rows = claim.rows; break; }
      await pgPool.query(
        `UPDATE whatsapp_web_outbox SET status = 'cancelado_compra', failure_code = 'JA_COMPROU',
           failure_message = 'cliente comprou depois do item entrar na fila', atualizado_em = now()
         WHERE id = $1`,
        [item.id]
      );
      console.log(`[WHATSAPP_WEB] item ${item.id} (${item.origem}) cancelado: cliente já comprou`);
    }
    if (!rows.length) {
      let motivo = dentroJanela ? 'fila_vazia' : 'fora_da_janela';
      if (dentroJanela && !campanhasLiberadas) {
        const { rows: bloqueadas } = await pgPool.query(`SELECT 1 FROM whatsapp_web_outbox WHERE status = 'pending' AND origem = 'campanha' LIMIT 1`);
        if (bloqueadas.length) motivo = 'limite_recomendado';
      }
      return res.json({ item: null, motivo });
    }
    res.json({ item: rows[0] });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha no claim: ${err.message}`);
    res.status(500).json({ error: 'falha ao reservar item da fila' });
  }
});

app.post('/api/whatsapp-web-agente/:id/resultado', requireAgenteWhatsappWeb, async (req, res) => {
  const { id } = req.params;
  const { status, codigo, mensagem, confirmado } = req.body || {};
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id inválido' });
  if (status !== 'sent' && status !== 'failed') return res.status(400).json({ error: 'status deve ser "sent" ou "failed"' });
  if (status === 'failed' && !WHATSAPP_WEB_CODIGOS_FALHA.includes(codigo)) return res.status(400).json({ error: 'código de falha inválido' });
  if (confirmado !== undefined && typeof confirmado !== 'boolean') return res.status(400).json({ error: 'confirmado deve ser true ou false' });
  if (!pgPool) return res.status(503).json({ error: 'Postgres não configurado' });

  try {
    // 'desconhecido' também aceita: lease venceu mas o agente conseguiu reportar depois — a
    // informação real (saiu ou não) vale mais que a suposição.
    const { rows } = await pgPool.query(
      `UPDATE whatsapp_web_outbox
          SET status = $2::text,
              sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE NULL END,
              failure_code = CASE WHEN $2::text = 'failed' THEN $3::text ELSE NULL END,
              failure_message = CASE WHEN $2::text = 'failed' THEN $4::text ELSE NULL END,
              envio_confirmado = CASE WHEN $2::text = 'sent' THEN $5::boolean ELSE NULL END,
              atualizado_em = now()
        WHERE id = $1 AND status IN ('claimed', 'desconhecido')
        RETURNING campaign_recipient_id`,
      [id, status, codigo || null, typeof mensagem === 'string' ? mensagem.slice(0, 500) : null, confirmado === undefined ? null : confirmado]
    );
    if (!rows.length) return res.status(409).json({ error: 'item não está mais reservado (cancelado ou já reportado)' });

    await refletirResultadoNaCampanha(rows[0].campaign_recipient_id, status, codigo);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao registrar resultado do item ${id}: ${err.message}`);
    res.status(500).json({ error: 'falha ao registrar resultado' });
  }
});

// Resultado de item de campanha (app ou celular) atualiza o destinatário da campanha.
async function refletirResultadoNaCampanha(recipientId, status, codigo) {
  if (!recipientId) return;
  if (status === 'sent') {
    await pgPool.query(
      `UPDATE campaign_recipients SET status = 'sent', sent_at = now(), failed_at = NULL, failure_code = NULL, failure_message = NULL, atualizado_em = now() WHERE id = $1`,
      [recipientId]
    );
  } else {
    await pgPool.query(
      `UPDATE campaign_recipients SET status = 'failed', failed_at = now(), failure_code = $2, failure_message = $3, atualizado_em = now() WHERE id = $1`,
      [recipientId, codigo, 'falha no envio pelo WhatsApp Web']
    );
  }
}

async function statusAgenteWhatsappWeb() {
  const agente = await readWhatsappWebAgente();
  const ultimo = agente.ultimoHeartbeatEm ? new Date(agente.ultimoHeartbeatEm).getTime() : 0;
  return {
    tokenConfigurado: !!agente.tokenHash,
    tokenCriadoEm: agente.tokenCriadoEm || null,
    ultimoHeartbeatEm: agente.ultimoHeartbeatEm || null,
    online: !!ultimo && Date.now() - ultimo < WHATSAPP_WEB_AGENTE_ONLINE_SEG * 1000,
    versao: agente.versao || null,
    whatsapp: agente.whatsapp || null,
    executor: agente.executor || null,
    plataforma: agente.plataforma || null,
    pausado: agente.pausado === true,
    testando: agente.testando === true,
  };
}

app.get('/api/admin/whatsapp-web/config', requireAdmin, async (req, res) => {
  try {
    const cfg = await readWhatsappProviderConfig();
    res.json({
      provider: cfg.provider,
      limiteRecomendado: cfg.limiteRecomendado,
      tetoDiario: cfg.tetoDiario,
      faixas: WHATSAPP_WEB_FAIXAS,
      postgresConfigurado: !!pgPool,
      agente: await statusAgenteWhatsappWeb(),
    });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao ler configuração: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler a configuração do WhatsApp' });
  }
});

app.put('/api/admin/whatsapp-web/config', requireAdmin, async (req, res) => {
  const { provider, limiteRecomendado, tetoDiario } = req.body || {};
  if (provider !== undefined && provider !== 'meta_api' && provider !== 'whatsapp_web') {
    return res.status(400).json({ error: 'provider deve ser "meta_api" ou "whatsapp_web"' });
  }
  if (provider === 'whatsapp_web' && !pgPool) {
    return res.status(400).json({ error: 'o modo WhatsApp Web exige Postgres (DATABASE_URL) neste ambiente' });
  }
  const limiteValido = (v) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= WHATSAPP_WEB_FAIXAS.risco);
  if (!limiteValido(limiteRecomendado) || !limiteValido(tetoDiario)) {
    return res.status(400).json({ error: `limites devem ser inteiros entre 1 e ${WHATSAPP_WEB_FAIXAS.risco}` });
  }
  try {
    const atual = await readWhatsappProviderConfig();
    const nova = {
      provider: provider !== undefined ? provider : atual.provider,
      limiteRecomendado: limiteRecomendado !== undefined ? limiteRecomendado : atual.limiteRecomendado,
      tetoDiario: tetoDiario !== undefined ? tetoDiario : atual.tetoDiario,
    };
    if (nova.limiteRecomendado > nova.tetoDiario) {
      return res.status(400).json({ error: 'o limite recomendado não pode ser maior que o teto diário' });
    }
    await salvarConfigPostgres('whatsapp-provider', WHATSAPP_PROVIDER_FILE, nova);
    if (nova.provider !== atual.provider) {
      await registrarAuditLog({
        actorUserId: req.auth.userId, action: 'whatsapp.provider.update', entityType: 'integration', entityId: 'whatsapp',
        before: { provider: atual.provider }, after: { provider: nova.provider },
      });
    }
    res.json({ ok: true, ...nova });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao salvar configuração: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar a configuração do WhatsApp' });
  }
});

// ID do app da Meta usado pelo whatsapp-webhook-go no upload de amostra de mídia de template
// (Resumable Upload API: POST /{app-id}/uploads). Não é segredo — o token vai no remetente da
// Organization e o app secret fica no serviço Go. Numérico, validado aqui e de novo no Go.
const WHATSAPP_META_APP_FILE = path.join(PEDIDOS_DIR, 'whatsapp-meta-app.json');
const META_APP_ID_RE = /^[0-9]{5,32}$/;

async function readWhatsappMetaApp() {
  const cfg = await lerConfigPostgres('whatsapp-meta-app', WHATSAPP_META_APP_FILE, {});
  return { appId: cfg && typeof cfg.appId === 'string' && META_APP_ID_RE.test(cfg.appId) ? cfg.appId : '' };
}

app.get('/api/admin/whatsapp/meta-app', requireAdmin, async (req, res) => {
  try {
    res.json(await readWhatsappMetaApp());
  } catch (err) {
    console.error(`[WHATSAPP] falha ao ler o app da Meta: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler o app da Meta' });
  }
});

app.put('/api/admin/whatsapp/meta-app', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const desconhecidos = Object.keys(body).filter((k) => k !== 'appId');
  if (desconhecidos.length) return res.status(400).json({ error: `campo desconhecido: ${desconhecidos[0]}` });
  const appId = typeof body.appId === 'string' ? body.appId.trim() : null;
  // Vazio limpa (volta a valer o META_APP_ID do serviço); preenchido precisa ser só dígitos.
  if (appId === null || (appId !== '' && !META_APP_ID_RE.test(appId))) {
    return res.status(400).json({ error: 'o ID do app tem só números (de 5 a 32 dígitos)' });
  }
  try {
    const atual = await readWhatsappMetaApp();
    await salvarConfigPostgres('whatsapp-meta-app', WHATSAPP_META_APP_FILE, { appId });
    if (atual.appId !== appId) {
      await registrarAuditLog({
        actorUserId: req.auth.userId, action: 'whatsapp.meta_app.update', entityType: 'integration', entityId: 'whatsapp',
        before: { appId: atual.appId }, after: { appId },
      });
    }
    res.json({ appId });
  } catch (err) {
    console.error(`[WHATSAPP] falha ao salvar o app da Meta: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar o app da Meta' });
  }
});

// ── Remetente WhatsApp da Organization (Fase 5b) ─────────────────────────────────────────
// Número (phone_number_id), conta (WABA) e token da API oficial pertencem à Organization, não ao
// serviço Go. Só owner grava ou remove; a tela vê número, WABA e last4 do token, nunca o token.
// O número é recurso externo com um dono só (PD-016): outra Organization não o reivindica.
async function remetenteWhatsappParaTela() {
  const m = await exigirIntegracoes().metadata('whatsapp');
  const token = m.segredos.find((x) => x.tipo === 'access_token') || null;
  const comportamento = comportamentoWhatsappDaConfig(m.config);
  return {
    status: token ? m.status : 'disconnected',
    phoneNumberId: typeof m.config.phone_number_id === 'string' ? m.config.phone_number_id : null,
    wabaId: typeof m.config.waba_id === 'string' ? m.config.waba_id : null,
    businessId: typeof m.config.business_id === 'string' ? m.config.business_id : null,
    storeId: typeof m.config.store_id === 'string' ? m.config.store_id : null,
    conectadoVia: m.config.connected_via === 'embedded_signup' ? 'embedded_signup' : (token ? 'manual' : null),
    numeroExibido: typeof m.config.display_phone_number === 'string' ? m.config.display_phone_number : null,
    nomeVerificado: typeof m.config.verified_name === 'string' ? m.config.verified_name : null,
    webhookAssinado: m.config.webhook_subscribed === true,
    numeroRegistrado: m.config.phone_registered === true,
    conectadoEm: typeof m.config.connected_at === 'string' ? m.config.connected_at : null,
    tokenInvalidoEm: typeof m.config.token_invalido_em === 'string' ? m.config.token_invalido_em : null,
    replyRedirectMessage: comportamento.replyRedirectMessage,
    notifyNumber: comportamento.notifyNumber,
    token,
  };
}

app.get('/api/admin/whatsapp/remetente', requireAdmin, async (req, res) => {
  try {
    res.json(await remetenteWhatsappParaTela());
  } catch (err) {
    responderErroIntegracao(res, err, 'ler remetente WhatsApp');
  }
});

app.put('/api/admin/whatsapp/remetente', requireAdmin, (req, res, next) => TENANT.requireOwner(req, res, next), async (req, res) => {
  const corpo = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const extras = Object.keys(corpo).filter((k) => !['phoneNumberId', 'wabaId', 'accessToken', 'replyRedirectMessage', 'notifyNumber'].includes(k));
  if (extras.length) return res.status(400).json({ error: `campos não aceitos: ${extras.join(', ')}` });
  const replyRedirectMessage = typeof corpo.replyRedirectMessage === 'string' ? corpo.replyRedirectMessage.trim() : corpo.replyRedirectMessage;
  const notifyNumber = typeof corpo.notifyNumber === 'string' ? corpo.notifyNumber.replace(/\D/g, '') : corpo.notifyNumber;
  const comportamentoInvalido = validarComportamentoWhatsapp({ replyRedirectMessage, notifyNumber });
  if (comportamentoInvalido) return res.status(400).json({ error: comportamentoInvalido });
  const phoneNumberId = typeof corpo.phoneNumberId === 'string' ? corpo.phoneNumberId.trim() : '';
  const wabaId = typeof corpo.wabaId === 'string' ? corpo.wabaId.trim() : '';
  const accessToken = corpo.accessToken === undefined ? undefined : typeof corpo.accessToken === 'string' ? corpo.accessToken.trim() : null;
  const invalido = validarRemetenteWhatsapp({ phoneNumberId, wabaId, accessToken: accessToken === null ? '' : accessToken });
  if (invalido) return res.status(400).json({ error: invalido });
  try {
    const integracoes = exigirIntegracoes();
    const antes = await remetenteWhatsappParaTela();
    if (accessToken === undefined && !antes.token) return res.status(400).json({ error: 'informe o token do WhatsApp' });
    const trocouNumero = !!antes.phoneNumberId && antes.phoneNumberId !== phoneNumberId;
    // Trocar de número exige o token dele: o token antigo pertence ao número antigo.
    if (trocouNumero && accessToken === undefined) {
      return res.status(400).json({ error: 'ao trocar de número, informe também o token dele' });
    }
    await integracoes.reivindicarRecurso('whatsapp', 'phone_number', phoneNumberId);
    await integracoes.reivindicarRecurso('whatsapp', 'waba', wabaId);
    if (trocouNumero) await integracoes.liberarRecursos('whatsapp', 'phone_number', antes.phoneNumberId);
    if (antes.wabaId && antes.wabaId !== wabaId) await integracoes.liberarRecursos('whatsapp', 'waba', antes.wabaId);
    // Salvar só o comportamento (resposta automática, aviso) numa conexão do Embedded Signup não pode
    // apagar a identidade que a Meta confirmou: com o mesmo número e a mesma WABA, ela é mantida.
    const mesmaConexaoMeta = antes.conectadoVia === 'embedded_signup' && antes.phoneNumberId === phoneNumberId && antes.wabaId === wabaId && accessToken === undefined;
    const identidadeMeta = mesmaConexaoMeta ? {
      business_id: antes.businessId, store_id: antes.storeId, connected_via: 'embedded_signup',
      display_phone_number: antes.numeroExibido, verified_name: antes.nomeVerificado,
      webhook_subscribed: antes.webhookAssinado, phone_registered: antes.numeroRegistrado, connected_at: antes.conectadoEm,
    } : {};
    await integracoes.gravarConfig('whatsapp', {
      ...identidadeMeta,
      // Só trocar o token limpa a marca de "a Meta recusou o token"; salvar só o comportamento a mantém.
      ...(accessToken === undefined && antes.tokenInvalidoEm ? { token_invalido_em: antes.tokenInvalidoEm } : {}),
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      reply_redirect_message: replyRedirectMessage !== undefined ? replyRedirectMessage : antes.replyRedirectMessage,
      notify_number: notifyNumber !== undefined ? notifyNumber : antes.notifyNumber,
    });
    if (accessToken !== undefined) await integracoes.gravarSegredo('whatsapp', 'access_token', accessToken);
    await registrarAuditLog({
      actorUserId: req.auth.userId, action: 'integration.credentials.update', entityType: 'integration', entityId: 'whatsapp',
      before: { phoneNumberId: antes.phoneNumberId, wabaId: antes.wabaId },
      after: { phoneNumberId, wabaId, token: accessToken !== undefined ? 'substituido' : 'mantido' },
    });
    res.json(await remetenteWhatsappParaTela());
  } catch (err) {
    responderErroIntegracao(res, err, 'gravar remetente WhatsApp');
  }
});

app.delete('/api/admin/whatsapp/remetente', requireAdmin, (req, res, next) => TENANT.requireOwner(req, res, next), async (req, res) => {
  try {
    const integracoes = exigirIntegracoes();
    // Sem revogação remota: o token é de usuário de sistema da Meta; a invalidação aqui é local.
    const { apagados } = await integracoes.desconectar('whatsapp');
    await integracoes.gravarConfig('whatsapp', {});
    await registrarAuditLog({
      actorUserId: req.auth.userId, action: 'integration.disconnect', entityType: 'integration', entityId: 'whatsapp',
      after: { segredosApagados: apagados },
    });
    res.json({ ok: true, apagados });
  } catch (err) {
    responderErroIntegracao(res, err, 'desconectar remetente WhatsApp');
  }
});

// ── Embedded Signup (Tech Provider) ───────────────────────────────────────────────────────
// O app da Meta e o `config_id` são da PLATAFORMA (META_APP_ID, META_APP_SECRET, WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID —
// o app do WhatsApp; o de Ads é outro, META_ADS_*). O tenant não vê nome de variável. O navegador
// abre o fluxo da Meta e devolve WABA, número, business e um `code` de 30 s; a identidade só é
// aceita depois que a Meta confirma que o token trocado enxerga essa WABA e esse número.
const ES_ID_RE = /^[0-9]{5,32}$/;

function embeddedSignupConfigurado() {
  return ES_ID_RE.test(process.env.META_APP_ID || '') && !!process.env.META_APP_SECRET && ES_ID_RE.test(process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || '');
}

function apiVersionEmbeddedSignup() {
  return /^v\d{2}\.\d$/.test(process.env.META_API_VERSION || '') ? process.env.META_API_VERSION : ES_VERSAO_PADRAO;
}

function exigirEmbeddedSignup() {
  if (!embeddedSignupConfigurado()) {
    throw new EmbeddedSignupError('a conexão com o WhatsApp ainda não está habilitada na plataforma', { codigo: 'PLATFORM_UNAVAILABLE', status: 503 });
  }
  return criarClienteEmbeddedSignup({ appId: process.env.META_APP_ID, appSecret: process.env.META_APP_SECRET, apiVersion: apiVersionEmbeddedSignup() });
}

// Só o que o navegador precisa para abrir o fluxo. App Secret nunca sai daqui.
app.get('/api/admin/whatsapp/embedded-signup/config', requireAdmin, (req, res, next) => TENANT.requireOwner(req, res, next), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    exigirEmbeddedSignup();
    // A Store que conecta vai no state (uso único, amarrado à pessoa, à sessão, à Organization).
    const state = await criarStateOAuth(req, 'whatsapp', { storeId: storeDoContexto() });
    res.json({ appId: process.env.META_APP_ID, configId: process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID, apiVersion: apiVersionEmbeddedSignup(), state });
  } catch (err) {
    responderErroIntegracao(res, err, 'preparar Embedded Signup');
  }
});

app.post('/api/admin/whatsapp/embedded-signup/complete', requireAdmin, (req, res, next) => TENANT.requireOwner(req, res, next), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const corpo = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const extras = Object.keys(corpo).filter((k) => !['state', 'code', 'wabaId', 'phoneNumberId', 'businessId'].includes(k));
  if (extras.length) return res.status(400).json({ error: `campos não aceitos: ${extras.join(', ')}` });
  const claimsNovos = [];
  let integracoes = null;
  try {
    const cliente = exigirEmbeddedSignup();
    integracoes = exigirIntegracoes();
    if (!OAUTH_STATES) throw new EmbeddedSignupError('conexão indisponível', { codigo: 'PLATFORM_UNAVAILABLE', status: 503 });
    // state de uso único: consumido antes de qualquer chamada à Meta, então repetir o pedido não repete o efeito.
    let salvo;
    try {
      salvo = await OAUTH_STATES.consumir(String(corpo.state || ''), ['whatsapp']);
    } catch (err) {
      if (!(err instanceof OAuthStateError)) throw err;
      throw new EmbeddedSignupError('a autorização expirou — tente conectar de novo', { codigo: 'ES_STATE_INVALID', status: 400 });
    }
    // O state precisa ser DESTA pessoa, desta Organization e desta Store: state emitido para outra
    // sessão, outra Organization ou outra Store não conclui nada aqui.
    if (salvo.userId !== req.auth.userId || salvo.organizationId !== orgDoContexto() || !salvo.dados || salvo.dados.storeId !== storeDoContexto()) {
      throw new EmbeddedSignupError('a autorização não pertence a esta loja', { codigo: 'ES_STATE_MISMATCH', status: 403 });
    }
    const businessId = corpo.businessId === undefined || corpo.businessId === null || corpo.businessId === '' ? null : corpo.businessId;
    const entrada = { code: corpo.code, wabaId: corpo.wabaId, phoneNumberId: corpo.phoneNumberId, businessId };
    validarEntradaEmbeddedSignup(entrada);

    const prova = await cliente.provar(entrada);
    const antes = await remetenteWhatsappParaTela();
    // Posse do recurso (PD-016): a WABA e o número têm UMA Organization dona. Recusa antes de mexer na Meta.
    for (const [tipo, id] of [['phone_number', entrada.phoneNumberId], ['waba', entrada.wabaId]]) {
      const jaEra = tipo === 'waba' ? antes.wabaId === id : antes.phoneNumberId === id;
      await integracoes.reivindicarRecurso('whatsapp', tipo, id);
      if (!jaEra) claimsNovos.push([tipo, id]);
    }
    const pin = gerarPin();
    await cliente.assinarWebhooks(entrada.wabaId, prova.accessToken);
    await cliente.registrarNumero(entrada.phoneNumberId, prova.accessToken, pin);

    await integracoes.gravarConfig('whatsapp', {
      phone_number_id: entrada.phoneNumberId,
      waba_id: entrada.wabaId,
      business_id: businessId,
      store_id: storeDoContexto(),
      connected_via: 'embedded_signup',
      display_phone_number: prova.numero.numeroExibido,
      verified_name: prova.numero.nomeVerificado,
      webhook_subscribed: true,
      phone_registered: true,
      connected_at: new Date().toISOString(),
      reply_redirect_message: antes.replyRedirectMessage,
      notify_number: antes.notifyNumber,
    });
    await integracoes.gravarSegredo('whatsapp', 'access_token', prova.accessToken, { expiresAt: prova.expiraEm });
    await integracoes.gravarSegredo('whatsapp', 'two_step_pin', pin);
    // Número/WABA anteriores deixam de ser desta Organization só depois que os novos estão gravados.
    if (antes.phoneNumberId && antes.phoneNumberId !== entrada.phoneNumberId) await integracoes.liberarRecursos('whatsapp', 'phone_number', antes.phoneNumberId);
    if (antes.wabaId && antes.wabaId !== entrada.wabaId) await integracoes.liberarRecursos('whatsapp', 'waba', antes.wabaId);
    await registrarAuditLog({
      actorUserId: req.auth.userId, action: 'integration.whatsapp.embedded_signup', entityType: 'integration', entityId: 'whatsapp',
      before: { phoneNumberId: antes.phoneNumberId, wabaId: antes.wabaId },
      after: { phoneNumberId: entrada.phoneNumberId, wabaId: entrada.wabaId, businessId, storeId: storeDoContexto(), token: 'substituido' },
    });
    res.json(await remetenteWhatsappParaTela());
  } catch (err) {
    // Falhou depois de reivindicar: devolve só o que ESTE pedido reivindicou (o que já era da Organization fica).
    for (const [tipo, id] of claimsNovos) {
      await integracoes.liberarRecursos('whatsapp', tipo, id).catch(() => {});
    }
    if (err instanceof EmbeddedSignupError) console.warn(`[WHATSAPP_ES] recusado: ${err.codigo}`);
    responderErroIntegracao(res, err, 'concluir Embedded Signup');
  }
});

// Gera (ou regenera, invalidando o anterior) o token do agente. O valor só volta nesta resposta.
app.post('/api/admin/whatsapp-web/agente-token', requireAdmin, async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('base64url');
    const atual = await readWhatsappWebAgente();
    await writeWhatsappWebAgente({ ...atual, tokenHash: hashTokenAgente(token), tokenCriadoEm: new Date().toISOString() });
    await registrarAuditLog({
      actorUserId: req.auth.userId, action: 'whatsapp.agente_token.create', entityType: 'integration', entityId: 'whatsapp',
      before: { tokenConfigurado: !!atual.tokenHash }, after: { tokenConfigurado: true },
    });
    res.json({ token });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao gerar token do agente: ${err.message}`);
    res.status(500).json({ error: 'não foi possível gerar o token do agente' });
  }
});

app.get('/api/admin/whatsapp-web/resumo', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ disponivel: false });
  try {
    const cfg = await readWhatsappProviderConfig();
    const [volume, { rows }] = await Promise.all([
      resumoVolumeWhatsappWebHoje(),
      pgPool.query(`SELECT status, COUNT(*)::int AS n FROM whatsapp_web_outbox WHERE status IN ('aguardando_aprovacao', 'pending', 'claimed', 'desconhecido') GROUP BY status`),
    ]);
    const fila = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    res.json({
      disponivel: true,
      provider: cfg.provider,
      agente: await statusAgenteWhatsappWeb(),
      enviadosHoje: volume.total,
      porOrigem: volume.porOrigem,
      limiteRecomendado: cfg.limiteRecomendado,
      tetoDiario: cfg.tetoDiario,
      faixas: WHATSAPP_WEB_FAIXAS,
      fila: {
        aguardandoAprovacao: fila.aguardando_aprovacao || 0,
        pendentes: fila.pending || 0,
        enviando: fila.claimed || 0,
        desconhecidos: fila.desconhecido || 0,
      },
    });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao montar resumo: ${err.message}`);
    res.status(500).json({ error: 'não foi possível montar o resumo da fila' });
  }
});

app.get('/api/admin/whatsapp-web/fila', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ itens: [] });
  // status aceita lista separada por vírgula (ex.: a tela "Enviar pelo celular" pede só os ativos).
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status.split(',') : null;
  const origem = typeof req.query.origem === 'string' && req.query.origem ? req.query.origem : null;
  if (status && (status.length > WHATSAPP_WEB_STATUS.length || !status.every((s) => WHATSAPP_WEB_STATUS.includes(s)))) {
    return res.status(400).json({ error: 'status inválido' });
  }
  if (origem && !WHATSAPP_WEB_ORIGENS.includes(origem)) return res.status(400).json({ error: 'origem inválida' });
  try {
    const { rows } = await pgPool.query(
      `SELECT id, origem, referencia, loja, evento, telefone, nome, template, texto, midia_ignorada, status,
              tentativas, sent_at, failure_code, failure_message, criado_em, atualizado_em, variacao, envio_confirmado, executor
         FROM whatsapp_web_outbox
        WHERE ($1::text[] IS NULL OR status = ANY($1::text[])) AND ($2::text IS NULL OR origem = $2)
        ORDER BY criado_em DESC
        LIMIT 300`,
      [status, origem]
    );
    res.json({
      itens: rows.map((r) => ({
        id: r.id, origem: r.origem, referencia: r.referencia, loja: r.loja, evento: r.evento, telefone: r.telefone,
        nome: r.nome, template: r.template, texto: r.texto, midiaIgnorada: r.midia_ignorada, status: r.status,
        tentativas: r.tentativas, enviadoEm: r.sent_at, falhaCodigo: r.failure_code, falhaMensagem: r.failure_message, variacao: r.variacao,
        envioConfirmado: r.envio_confirmado, executor: r.executor,
        criadoEm: r.criado_em, atualizadoEm: r.atualizado_em,
      })),
    });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao listar fila: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar a fila' });
  }
});

// ── Envio assistido pelo celular ────────────────────────────────────────
// Sem o computador por perto: o painel no celular reserva 1 mensagem, abre o WhatsApp do próprio
// celular com o texto pronto (wa.me) e a pessoa confirma se enviou. A reserva é a mesma do app
// desktop (status claimed), então as duas vias nunca pegam a mesma mensagem.
const WHATSAPP_WEB_LEASE_CELULAR_MIN = 15;

app.post('/api/admin/whatsapp-web/fila/:id/assumir', requireAdmin, exigirRecurso('whatsapp_web_outbox'), async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id inválido' });
  if (!pgPool) return res.status(503).json({ error: 'Postgres não configurado' });
  try {
    const cfg = await readWhatsappProviderConfig();
    const { total } = await resumoVolumeWhatsappWebHoje();
    // Envio manual conta no mesmo volume do dia — o risco de bloqueio é do número, não do app.
    if (total >= cfg.tetoDiario) return res.status(409).json({ error: `teto diário de ${cfg.tetoDiario} mensagens atingido` });
    // Mesmo recheque do claim do app: esta é a outra porta por onde a mensagem sai de verdade, e
    // itens em `aguardando_aprovacao` esperam ainda mais tempo que os pendentes — a chance da
    // compra acontecer no meio é maior aqui, não menor.
    const { rows: alvo } = await pgPool.query(
      `SELECT origem, loja, telefone, criado_em FROM whatsapp_web_outbox
        WHERE id = $1 AND status IN ('pending', 'aguardando_aprovacao')`,
      [id]
    );
    if (alvo.length && (alvo[0].origem === 'carrinho' || alvo[0].origem === 'pix') && alvo[0].loja) {
      if (await clienteJaComprou(alvo[0].loja, { telefone: alvo[0].telefone }, alvo[0].criado_em)) {
        await pgPool.query(
          `UPDATE whatsapp_web_outbox SET status = 'cancelado_compra', failure_code = 'JA_COMPROU',
             failure_message = 'cliente comprou depois do item entrar na fila', atualizado_em = now()
           WHERE id = $1`,
          [id]
        );
        return res.status(409).json({ error: 'esse cliente já comprou depois que a mensagem entrou na fila — envio cancelado' });
      }
    }

    // Aguardando aprovação também pode: a pessoa escolher enviar já é a aprovação.
    const { rows } = await pgPool.query(
      `UPDATE whatsapp_web_outbox
          SET status = 'claimed', claimed_at = now(), lease_ate = now() + make_interval(mins => $2),
              tentativas = tentativas + 1, executor = 'celular', status_anterior = status, atualizado_em = now()
        WHERE id = $1 AND status IN ('pending', 'aguardando_aprovacao')
        RETURNING id, telefone, texto`,
      [id, WHATSAPP_WEB_LEASE_CELULAR_MIN]
    );
    if (!rows.length) return res.status(409).json({ error: 'essa mensagem não está mais na fila (o app pode ter pegado)' });
    res.json({ item: rows[0] });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao reservar item ${id} pelo celular: ${err.message}`);
    res.status(500).json({ error: 'não foi possível reservar a mensagem' });
  }
});

app.post('/api/admin/whatsapp-web/fila/:id/concluir', requireAdmin, exigirRecurso('whatsapp_web_outbox'), async (req, res) => {
  const { id } = req.params;
  const { enviado } = req.body || {};
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id inválido' });
  if (typeof enviado !== 'boolean') return res.status(400).json({ error: 'enviado deve ser true ou false' });
  if (!pgPool) return res.status(503).json({ error: 'Postgres não configurado' });
  try {
    // 'desconhecido' também aceita: a reserva venceu enquanto a pessoa estava no WhatsApp.
    const { rows } = enviado
      ? await pgPool.query(
        `UPDATE whatsapp_web_outbox
            SET status = 'sent', sent_at = now(), envio_confirmado = true, failure_code = NULL, failure_message = NULL, atualizado_em = now()
          WHERE id = $1 AND executor = 'celular' AND status IN ('claimed', 'desconhecido')
          RETURNING campaign_recipient_id`,
        [id]
      )
      : await pgPool.query(
        `UPDATE whatsapp_web_outbox
            SET status = COALESCE(status_anterior, 'pending'), status_anterior = NULL, claimed_at = NULL, lease_ate = NULL, executor = NULL,
                failure_code = NULL, failure_message = NULL, atualizado_em = now()
          WHERE id = $1 AND executor = 'celular' AND status IN ('claimed', 'desconhecido')
          RETURNING campaign_recipient_id`,
        [id]
      );
    if (!rows.length) return res.status(409).json({ error: 'essa mensagem não está reservada pelo celular' });
    if (enviado) await refletirResultadoNaCampanha(rows[0].campaign_recipient_id, 'sent');
    res.json({ ok: true });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao concluir item ${id} pelo celular: ${err.message}`);
    res.status(500).json({ error: 'não foi possível atualizar a mensagem' });
  }
});

// Ações em lote na fila. Transições permitidas (qualquer outra é ignorada, não vira erro):
//   aprovar:  aguardando_aprovacao → pending
//   cancelar: aguardando_aprovacao | pending → cancelado
//   reenviar: failed | desconhecido | cancelado → pending
const WHATSAPP_WEB_TRANSICOES = {
  aprovar: { de: ['aguardando_aprovacao'], para: 'pending' },
  cancelar: { de: ['aguardando_aprovacao', 'pending'], para: 'cancelado' },
  reenviar: { de: ['failed', 'desconhecido', 'cancelado'], para: 'pending' },
};

app.post('/api/admin/whatsapp-web/fila/acao', requireAdmin, async (req, res) => {
  const { acao, ids } = req.body || {};
  const transicao = WHATSAPP_WEB_TRANSICOES[acao];
  if (!transicao) return res.status(400).json({ error: 'ação inválida' });
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
    return res.status(400).json({ error: 'informe de 1 a 500 ids válidos' });
  }
  if (!pgPool) return res.status(503).json({ error: 'Postgres não configurado' });

  try {
    const { rows } = await pgPool.query(
      `UPDATE whatsapp_web_outbox
          SET status = $2, failure_code = NULL, failure_message = NULL, claimed_at = NULL, lease_ate = NULL, atualizado_em = now()
        WHERE id = ANY($1::uuid[]) AND status = ANY($3::text[])
        RETURNING campaign_recipient_id`,
      [ids, transicao.para, transicao.de]
    );
    const recipientIds = rows.map((r) => r.campaign_recipient_id).filter(Boolean);
    if (recipientIds.length) {
      if (acao === 'cancelar') {
        await pgPool.query(
          `UPDATE campaign_recipients SET status = 'failed', failed_at = now(), failure_code = 'cancelado', failure_message = 'envio cancelado na fila do WhatsApp Web', atualizado_em = now() WHERE id = ANY($1::bigint[])`,
          [recipientIds]
        );
      } else if (acao === 'reenviar') {
        await pgPool.query(
          `UPDATE campaign_recipients SET status = 'queued', queued_at = now(), failed_at = NULL, failure_code = NULL, failure_message = NULL, atualizado_em = now() WHERE id = ANY($1::bigint[])`,
          [recipientIds]
        );
      }
    }
    res.json({ ok: true, atualizados: rows.length });
  } catch (err) {
    // 23505 = já existe outro item vivo com a mesma chave (ex.: reenviar algo que um job já recriou)
    if (err.code === '23505') return res.status(409).json({ error: 'já existe um envio ativo igual a este na fila' });
    console.error(`[WHATSAPP_WEB] falha na ação ${acao} da fila: ${err.message}`);
    res.status(500).json({ error: 'não foi possível aplicar a ação' });
  }
});

// ── Configurações de produto (V2 do painel — ver docs/plan.md) ─────────
// Fase 3 (R-02): o antigo `multiStoreMode` saiu — não existe seletor de loja; a Store vem da
// Organization da sessão.
const PRODUCT_SETTINGS_FILE = path.join(PEDIDOS_DIR, 'product-settings.json');
const PRODUCT_SETTINGS_DEFAULT = { productName: 'Oria' };
if (!fs.existsSync(PRODUCT_SETTINGS_FILE)) fs.writeFileSync(PRODUCT_SETTINGS_FILE, JSON.stringify(PRODUCT_SETTINGS_DEFAULT, null, 2));

app.get('/api/admin/settings/product', requireAdmin, async (req, res) => {
  try {
    const settings = await lerConfigPostgres('settings-product', PRODUCT_SETTINGS_FILE, PRODUCT_SETTINGS_DEFAULT);
    res.json({ productName: settings.productName || PRODUCT_SETTINGS_DEFAULT.productName });
  } catch (err) {
    console.error(`[SETTINGS] falha ao ler configurações de produto: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler as configurações de produto' });
  }
});

app.patch('/api/admin/settings/product', requireAdmin, async (req, res) => {
  const { productName, ...extras } = req.body || {};
  if (Object.keys(extras).length) {
    return res.status(400).json({ error: `campos não aceitos: ${Object.keys(extras).join(', ')}` });
  }
  if (typeof productName !== 'string' || !productName.trim()) {
    return res.status(400).json({ error: 'productName deve ser um texto não vazio' });
  }
  try {
    const nova = { productName: productName.trim() };
    await salvarConfigPostgres('settings-product', PRODUCT_SETTINGS_FILE, nova);
    res.json({ ok: true, ...nova });
  } catch (err) {
    console.error(`[SETTINGS] falha ao salvar configurações de produto: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar as configurações de produto' });
  }
});

// ── Entitlements (TD-012, fail-closed) ─────────────────────────────────
// Autoridade do BACKEND, por Organization (app_config 'entitlements' da Organization da sessão).
// Ausente, desconhecido, inválido ou fonte fora do ar → nega. Nada herda default `true`: a operação
// interna recebe o plano por seed explícito (npm run tenancy:seed-entitlements, OPS-21).
// Esta rota só informa a UI; quem bloqueia é `exigirFeature(...)` em cada rota protegida.
app.get('/api/admin/entitlements', requireAdmin, async (req, res) => {
  res.json(await planoEfetivo(PLANO_DA_ORGANIZACAO));
});

// ── Gerador de Criativos (Oria) — tudo em routes/criativos.js + lib/creative-core/ ─────────
// Desligado por padrão (flags creative_*); sem Postgres ou sem o serviço Python responde 503, nunca derruba o boot.
let moduloCriativos = null;
try {
  moduloCriativos = require('./routes/criativos').montarCriativos(app, {
    requireAdmin, pgPool, uploadsDir: UPLOADS_DIR,
    // OPS-22: só a Organization declarada lê o diretório legado, e só o que ainda não foi movido.
    leituraLegada: LEITURA_LEGADA_CRIATIVOS,
    // Fase 4: a OpenAI key é a integração 'openai' da Organization do contexto.
    cofreOpenAi: cofreOpenAiDaOrganizacao,
    lerEntitlements: () => planoEfetivo(PLANO_DA_ORGANIZACAO),
    // INV-22: tenant do Creative Core = Organization autenticada; o worker percorre as Organizations.
    tenantAtual: () => orgDoContexto(),
    paraCadaTenant: (fn) => JOBS.executarPorOrganizacao('criativos', (org) => fn(org.organizationId)),
  });
} catch (err) {
  console.error(`[CRIATIVOS] módulo não carregado: ${err.name}`);
}

// ── Templates aprovados pela Meta (WhatsApp Business Management API) ───
// Fora da janela de 24h de conversa, o WhatsApp só permite mensagem via template aprovado
// pela Meta — por isso não existe mais um fluxo de "texto livre" aqui: só templates de
// verdade. A aprovação em si é toda feita pela Meta (minutos a dias, pode ser rejeitada);
// aqui só listamos/criamos/apagamos via o whatsapp-webhook-go, com o WABA e o token da Organization.
//
// A Meta não guarda associação nossa (evento que dispara, qual variável vai em cada {{n}}),
// então isso fica num arquivo de config local, keyado pelo nome do template.
const META_TEMPLATE_CATEGORIAS = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

// Amostra de mídia no cabeçalho do template (docs/PROMPT-CLAUDE-CAMPANHAS-REMARKETING-MIDIA-WHATSAPP.md,
// Parte 6). "Amostra" != "mídia real do envio" (Parte 6, "MUITO IMPORTANTE") — isso aqui é só o
// exemplo usado na aprovação do template pela Meta.
const HEADER_TIPOS = ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'];
const HEADER_MIME_PERMITIDO = {
  IMAGE: ['image/jpeg', 'image/png'],
  VIDEO: ['video/mp4', 'video/3gpp'],
  DOCUMENT: ['application/pdf'],
};
const HEADER_TAMANHO_MAXIMO = { IMAGE: 5 * 1024 * 1024, VIDEO: 16 * 1024 * 1024, DOCUMENT: 100 * 1024 * 1024 };

// Variáveis são separadas por tipo de template ("pedido" vs "carrinho abandonado") porque cada
// uma só existe de verdade num dos dois contextos (ver variaveisDoPedido/variaveisDoCarrinho) —
// usar uma do tipo errado sempre resulta em texto vazio no envio real.
const TEMPLATE_TIPOS = ['pedido', 'carrinho'];
const VARIAVEIS_COMUNS = ['cliente.nome', 'cliente.email', 'cliente.telefone', 'loja.nome'];
const VARIAVEIS_PEDIDO = [
  // `cliente.documento` (CPF/CNPJ) fica aqui, não em VARIAVEIS_COMUNS — o carrinho abandonado
  // da INK não traz documento do comprador, só o pedido.
  'cliente.documento',
  'pedido.numero', 'pedido.numero_sem_prefixo', 'pedido.status', 'pedido.valor', 'pedido.metodo_pagamento', 'pedido.itens',
  'pedido.transportadora', 'pedido.previsao_entrega', 'pedido.rastreio', 'produto.nome', 'link',
  // Só são preenchidos de verdade no evento pix.pendente (`enviarLembretePix`) — em qualquer
  // outro evento de pedido ficam vazios, já que não existe hotpage de pagamento pra gerar.
  // `link_pagamento` é a URL inteira (usar no CORPO do texto); `id_pagamento` é só o
  // identificador (usar dentro de um botão de link dinâmico, ex: https://seusite.com/{{1}} — a
  // Meta rejeita um botão cujo campo de URL seja só "{{1}}" sem endereço de verdade antes).
  'pedido.link_pagamento', 'pedido.id_pagamento',
];
const VARIAVEIS_CARRINHO = ['carrinho.produto', 'carrinho.itens', 'carrinho.quantidade_itens', 'carrinho.uuid'];
const VARIAVEIS_CONHECIDAS = [...VARIAVEIS_COMUNS, ...VARIAVEIS_PEDIDO, ...VARIAVEIS_CARRINHO];

// Campos personalizados: valor fixo definido pelo admin, com um valor diferente por loja (ex:
// link do Instagram, WhatsApp de suporte) — não vêm do pedido/carrinho, mas ficam disponíveis
// nos templates junto dos campos prontos. Guardado à parte (não é fato de pedido nem de
// automação) e prefixado `custom.` na hora de virar variável, pra nunca colidir com os fixos.
const CAMPOS_CUSTOM_FILE = path.join(PEDIDOS_DIR, 'campos-customizados.json');
if (!fs.existsSync(CAMPOS_CUSTOM_FILE)) fs.writeFileSync(CAMPOS_CUSTOM_FILE, '{}');

async function readCamposCustomizados() {
  return lerConfigPostgres('campos-customizados', CAMPOS_CUSTOM_FILE, {});
}
async function writeCamposCustomizados(campos) {
  return salvarConfigPostgres('campos-customizados', CAMPOS_CUSTOM_FILE, campos);
}
async function chavesCamposCustomizados() {
  return Object.keys(await readCamposCustomizados()).map((c) => `custom.${c}`);
}
// Um campo personalizado pode embutir outro dado já resolvido (ex: montar uma URL de rastreio
// com CPF + número do pedido: "https://rastreio.com/{{cliente.documento}}/{{pedido.numero}}").
// Só referencia campos PRONTOS (nunca outro `custom.*`) — evita referência circular por
// construção, já que `varsBase` é montado antes de qualquer campo personalizado existir.
function interpolarCampoCustomizado(template, varsBase) {
  if (!template) return '';
  return template.replace(/\{\{([^{}]+)\}\}/g, (match, tokenBruto) => {
    const chave = tokenBruto.trim();
    const valor = varsBase[chave];
    return valor != null ? String(valor) : '';
  });
}

async function variaveisCustomizadas(loja, varsBase) {
  const campos = await readCamposCustomizados();
  const vars = {};
  for (const chave of Object.keys(campos)) {
    const bruto = (campos[chave].valores && campos[chave].valores[loja]) || '';
    vars[`custom.${chave}`] = interpolarCampoCustomizado(bruto, varsBase || {});
  }
  return vars;
}

// Conjunto permitido pro tipo — tipo desconhecido (templates criados antes dessa separação
// existir) não restringe nada, pra não travar edição de template legado. Campos personalizados
// valem pra qualquer tipo (um link fixo serve tanto pra pedido quanto carrinho).
async function variaveisPermitidas(tipo) {
  const customs = await chavesCamposCustomizados();
  if (tipo === 'pedido') return [...VARIAVEIS_COMUNS, ...VARIAVEIS_PEDIDO, ...customs];
  if (tipo === 'carrinho') return [...VARIAVEIS_COMUNS, ...VARIAVEIS_CARRINHO, ...customs];
  return [...VARIAVEIS_CONHECIDAS, ...customs];
}
const VARIAVEIS_EXEMPLO = {
  'cliente.nome': 'Maria',
  'cliente.email': 'maria@exemplo.com',
  'cliente.telefone': '5548999998888',
  'cliente.documento': '12345678900',
  'pedido.numero': 'INK1234567',
  'pedido.numero_sem_prefixo': '1234567',
  'pedido.status': 'Em produção',
  'pedido.valor': 'R$ 129,90',
  'pedido.metodo_pagamento': 'Pix',
  'pedido.itens': '2x Camiseta Azul, 1x Camiseta Preta',
  'pedido.transportadora': 'Correios',
  'pedido.previsao_entrega': '15/09/2026',
  'pedido.rastreio': 'https://exemplo.com/rastreio',
  'pedido.link_pagamento': 'https://orgulhoregional.com.br/hotpix/AbCdEfGhIj',
  'pedido.id_pagamento': 'AbCdEfGhIj',
  'carrinho.produto': 'Camiseta Exemplo',
  'carrinho.itens': '2x Camiseta Azul',
  'carrinho.quantidade_itens': '2',
  'carrinho.uuid': '2ab47679-1726-4d27-bc0b-1deda4f011c4',
  'loja.nome': 'Use Sul',
  'produto.nome': 'Camiseta Exemplo',
  'link': 'https://exemplo.com/rastreio',
};

// Fatos estruturais de cada template criado por este painel (origem, tipo, posição do botão de
// link dinâmico) — o vínculo evento→template mora em `db/automacao-eventos.json`, não aqui.
const WHATSAPP_TEMPLATE_CONFIG_FILE = path.join(PEDIDOS_DIR, 'whatsapp-template-config.json');
if (!fs.existsSync(WHATSAPP_TEMPLATE_CONFIG_FILE)) fs.writeFileSync(WHATSAPP_TEMPLATE_CONFIG_FILE, '{}');

async function readTemplateConfigs() {
  return lerConfigPostgres('whatsapp-template-config', WHATSAPP_TEMPLATE_CONFIG_FILE, {});
}
async function writeTemplateConfigs(configs) {
  return salvarConfigPostgres('whatsapp-template-config', WHATSAPP_TEMPLATE_CONFIG_FILE, configs);
}

// Vínculo evento→template — dono único da automação (evita 2 templates disputando o mesmo
// evento, que existia quando esse vínculo morava no próprio template).
const AUTOMACAO_EVENTOS_FILE = path.join(PEDIDOS_DIR, 'automacao-eventos.json');
if (!fs.existsSync(AUTOMACAO_EVENTOS_FILE)) fs.writeFileSync(AUTOMACAO_EVENTOS_FILE, '{}');

async function readAutomacaoEventos() {
  return lerConfigPostgres('automacao-eventos', AUTOMACAO_EVENTOS_FILE, {});
}
async function writeAutomacaoEventos(eventos) {
  return salvarConfigPostgres('automacao-eventos', AUTOMACAO_EVENTOS_FILE, eventos);
}

// Histórico de envio por carrinho abandonado — usado pra decidir reenvio (limite/intervalo) e
// pra checar depois se o cliente já comprou (anti-spam), já que não há re-entrega de webhook
// pra "lembrar de novo".
const CARRINHO_ENVIOS_FILE = path.join(PEDIDOS_DIR, 'carrinho-envios.json');
if (!fs.existsSync(CARRINHO_ENVIOS_FILE)) fs.writeFileSync(CARRINHO_ENVIOS_FILE, '{}');

async function readCarrinhoEnvios() {
  return lerConfigPostgres('carrinho-envios', CARRINHO_ENVIOS_FILE, {});
}
async function writeCarrinhoEnvios(envios) {
  return salvarConfigPostgres('carrinho-envios', CARRINHO_ENVIOS_FILE, envios);
}

// Mesma ideia, mas pro lembrete de Pix pendente (evento sintético `pix.pendente`, ver
// `processarEventoWebhook`) — igual estrutura do carrinho (atraso do 1º envio + cadência +
// anti-spam), só que o "já converteu?" é reconsultar o próprio pedido, não casar por
// telefone/documento/e-mail contra qualquer pedido novo.
const PIX_LEMBRETES_FILE = path.join(PEDIDOS_DIR, 'pix-lembretes.json');
if (!fs.existsSync(PIX_LEMBRETES_FILE)) fs.writeFileSync(PIX_LEMBRETES_FILE, '{}');

async function readPixLembretes() {
  return lerConfigPostgres('pix-lembretes', PIX_LEMBRETES_FILE, {});
}
async function writePixLembretes(lembretes) {
  return salvarConfigPostgres('pix-lembretes', PIX_LEMBRETES_FILE, lembretes);
}

async function validarNovoTemplateMeta(body) {
  const { nome, categoria, corpo, headerTexto, headerVariavel, corpoVariaveis, footer, botoes, tipo, headerTipo, sampleMediaAssetId, sampleLocation } = body || {};

  const tipoHeaderNorm = headerTipo || 'TEXT';
  if (!HEADER_TIPOS.includes(tipoHeaderNorm)) return `tipo de cabeçalho deve ser um de: ${HEADER_TIPOS.join(', ')}`;
  // Nunca texto + mídia ao mesmo tempo (regra da Meta — Parte 761/HEADER do spec).
  if (tipoHeaderNorm !== 'TEXT' && headerTexto) return 'cabeçalho não pode ter texto e mídia ao mesmo tempo';
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(tipoHeaderNorm) && !sampleMediaAssetId) return 'selecione ou envie um arquivo de amostra pro cabeçalho';
  if (tipoHeaderNorm === 'LOCATION') {
    if (!sampleLocation || typeof sampleLocation.nome !== 'string' || !sampleLocation.nome.trim()) return 'amostra de localização precisa de nome/local';
    if (typeof sampleLocation.latitude !== 'number' || typeof sampleLocation.longitude !== 'number') return 'amostra de localização precisa de latitude/longitude';
  }
  if (typeof nome !== 'string' || !/^[a-z0-9_]{1,60}$/.test(nome)) return 'nome deve ter só letras minúsculas, números e "_" (exigência da Meta)';
  if (!META_TEMPLATE_CATEGORIAS.includes(categoria)) return `categoria deve ser uma de: ${META_TEMPLATE_CATEGORIAS.join(', ')}`;
  if (!TEMPLATE_TIPOS.includes(tipo)) return `tipo deve ser uma de: ${TEMPLATE_TIPOS.join(', ')}`;
  if (typeof corpo !== 'string' || corpo.trim().length === 0 || corpo.length > 1024) return 'corpo da mensagem inválido';
  // Confirmado com erro real da Meta: no máximo 2 quebras de linha seguidas (1 linha em branco
  // entre parágrafos é ok, 2 não), corpo não pode ser só variável sem texto ao redor, e no
  // máximo 10 emojis.
  if (/\n{3,}/.test(corpo)) return 'corpo não pode ter mais de 1 linha em branco seguida (exigência da Meta)';
  if (!corpo.replace(/\{\{[^{}]+\}\}/g, '').trim()) return 'corpo não pode ser só variável, precisa de texto ao redor (exigência da Meta)';
  if ((corpo.match(/\p{Extended_Pictographic}/gu) || []).length > 10) return 'corpo não pode ter mais de 10 emojis (exigência da Meta)';

  const permitidas = await variaveisPermitidas(tipo);
  const numVarsCorpo = extrairTokensVariaveis(corpo).length;
  const listaCorpoVars = Array.isArray(corpoVariaveis) ? corpoVariaveis : [];
  if (listaCorpoVars.length !== numVarsCorpo) return `selecione ${numVarsCorpo} variável(is) pro corpo (uma pra cada {{n}} usado)`;
  if (listaCorpoVars.some((v) => !permitidas.includes(v))) return 'variável do corpo não é válida pro tipo selecionado';

  if (headerTexto) {
    if (typeof headerTexto !== 'string' || headerTexto.length > 60) return 'cabeçalho deve ter no máximo 60 caracteres';
    const numVarsHeader = extrairTokensVariaveis(headerTexto).length;
    if (numVarsHeader > 1) return 'cabeçalho só pode ter uma variável ({{1}})';
    if (numVarsHeader === 1 && !headerVariavel) return 'selecione a variável do cabeçalho';
    if (headerVariavel && !permitidas.includes(headerVariavel)) return 'variável do cabeçalho não é válida pro tipo selecionado';
  }

  if (footer !== undefined && footer !== null && footer !== '') {
    if (typeof footer !== 'string' || footer.length > 60) return 'rodapé deve ter no máximo 60 caracteres';
    // Confirmado com erro real da Meta (error_subcode 2388073): rodapé não aceita quebra de
    // linha nem emoji.
    if (/[\r\n]/.test(footer)) return 'rodapé não pode ter quebra de linha (exigência da Meta)';
    if (/\p{Extended_Pictographic}/u.test(footer)) return 'rodapé não pode ter emoji (exigência da Meta)';
  }

  if (botoes !== undefined && botoes !== null) {
    if (!Array.isArray(botoes) || botoes.length > 3) return 'máximo de 3 botões';
    let temUrlDinamica = false;
    for (const b of botoes) {
      if (!b || typeof b.texto !== 'string' || b.texto.trim().length === 0 || b.texto.length > 25) return 'todo botão precisa de um texto (até 25 caracteres)';
      if (b.tipo === 'URL') {
        if (typeof b.valor !== 'string' || !b.valor.trim()) return 'botão de link precisa de uma URL';
        if (b.urlTipo === 'DINAMICO') {
          if (temUrlDinamica) return 'só é permitido um botão de link dinâmico por template';
          temUrlDinamica = true;
          const numVarsUrl = new Set(b.valor.match(/\{\{\d+\}\}/g) || []).size;
          if (numVarsUrl !== 1 || !b.valor.trim().endsWith('{{1}}')) return 'link dinâmico deve terminar com {{1}}';
          // Confirmado com erro real da Meta (#100 "not a valid URI"): o {{1}} substitui só um
          // PEDAÇO da URL — precisa ter um endereço de verdade antes, com https://, nunca só "{{1}}".
          const prefixoUrl = b.valor.trim().slice(0, -'{{1}}'.length);
          try { new URL(prefixoUrl); } catch { return 'link dinâmico precisa de uma URL completa antes do {{1}} (ex: https://seusite.com/{{1}})'; }
          if (!b.variavel || !permitidas.includes(b.variavel)) return 'selecione a variável do link dinâmico (válida pro tipo selecionado)';
        } else if (/\{\{\d+\}\}/.test(b.valor)) {
          return 'link estático não pode ter variável — marque como dinâmico';
        }
      }
      if (b.tipo === 'PHONE_NUMBER' && (typeof b.valor !== 'string' || !b.valor.trim())) return 'botão de telefone precisa de um número';
      if (!['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(b.tipo)) return 'tipo de botão inválido';
    }
  }

  return null;
}

// Monta os `components` da Meta a partir do formulário de criação (com exemplos automáticos
// pros campos com variável, exigidos pela Meta pra revisar o template).
function construirComponentesCriacao({ headerTexto, headerVariavel, corpo, corpoVariaveis, footer, botoes, headerTipo, sampleMediaHandle, sampleLocation }) {
  const components = [];

  if (headerTexto) {
    const headerComp = { type: 'HEADER', format: 'TEXT', text: headerTexto };
    if (headerVariavel) headerComp.example = { header_text: [VARIAVEIS_EXEMPLO[headerVariavel] || ''] };
    components.push(headerComp);
  } else if (headerTipo && headerTipo !== 'TEXT') {
    if (headerTipo === 'LOCATION') {
      // LOCATION não usa `example`/handle — o header em si já é o tipo, sem amostra de arquivo.
      components.push({ type: 'HEADER', format: 'LOCATION' });
    } else if (sampleMediaHandle) {
      components.push({ type: 'HEADER', format: headerTipo, example: { header_handle: [sampleMediaHandle] } });
    }
  }

  const bodyComp = { type: 'BODY', text: corpo };
  if (corpoVariaveis && corpoVariaveis.length) {
    bodyComp.example = { body_text: [corpoVariaveis.map((v) => VARIAVEIS_EXEMPLO[v] || '')] };
  }
  components.push(bodyComp);

  if (footer) components.push({ type: 'FOOTER', text: footer });

  if (botoes && botoes.length) {
    components.push({
      type: 'BUTTONS',
      buttons: botoes.map((b) => {
        if (b.tipo === 'URL') {
          const btn = { type: 'URL', text: b.texto, url: b.valor };
          if (b.urlTipo === 'DINAMICO') {
            btn.example = [b.valor.replace('{{1}}', VARIAVEIS_EXEMPLO[b.variavel] || '')];
          }
          return btn;
        }
        if (b.tipo === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.texto, phone_number: b.valor };
        return { type: 'QUICK_REPLY', text: b.texto };
      }),
    });
  }

  return components;
}

// Monta os `components` de ENVIO (header/body com os valores reais, na ordem certa) a partir
// da config local do template + um mapa de variável->valor (do pedido real ou de amostra).
// Header de mídia/localização não tem {{n}} pra resolver, mas a Meta exige o parâmetro em TODO
// envio mesmo assim (o `example` usado na criação só vale pra aprovação do template) — sem isso
// aqui, o disparo automático de um template com header IMAGE/VIDEO/DOCUMENT/LOCATION falha com
// 132012 "Format mismatch... received UNKNOWN", igual ao bug já corrigido no botão de teste manual.
async function montarComponentesEnvio(config, vars) {
  const components = [];
  if (config.headerTipo === 'IMAGE' || config.headerTipo === 'VIDEO' || config.headerTipo === 'DOCUMENT') {
    const mediaLink = await linkPublicoMedia(config.sampleMediaAssetId);
    if (mediaLink) {
      const tipoParam = config.headerTipo.toLowerCase();
      components.push({ type: 'header', parameters: [{ type: tipoParam, [tipoParam]: { link: mediaLink } }] });
    }
  } else if (config.headerTipo === 'LOCATION' && config.sampleLocation) {
    components.push({
      type: 'header',
      parameters: [{
        type: 'location',
        location: {
          latitude: config.sampleLocation.latitude, longitude: config.sampleLocation.longitude,
          name: config.sampleLocation.nome || undefined, address: config.sampleLocation.endereco || undefined,
        },
      }],
    });
  } else if (config.headerVariavel) {
    const token = config.headerToken || '1';
    components.push({ type: 'header', parameters: [construirParametroTexto(token, vars[config.headerVariavel])] });
  }
  if (config.corpoVariaveis && config.corpoVariaveis.length) {
    components.push({
      type: 'body',
      parameters: config.corpoVariaveis.map((v, i) => {
        const token = (config.corpoTokens && config.corpoTokens[i]) || String(i + 1);
        return construirParametroTexto(token, vars[v]);
      }),
    });
  }
  if (config.botaoDinamico) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(config.botaoDinamico.indice),
      parameters: [{ type: 'text', text: vars[config.botaoDinamico.variavel] != null ? String(vars[config.botaoDinamico.variavel]) : '' }],
    });
  }
  return components.length ? components : undefined;
}

// Repassa o vínculo do evento pra `montarComponentesEnvio` — a posição do botão dinâmico
// (`botaoIndice`) já vem confirmada na estrutura real da Meta no momento de salvar o vínculo
// (`PUT .../automacao-eventos`), não depende de cache local do template.
function montarConfigEnvio(eventoConfig, templateInfo) {
  return {
    headerVariavel: eventoConfig.headerVariavel || null,
    headerToken: eventoConfig.headerToken || null,
    corpoVariaveis: eventoConfig.corpoVariaveis || [],
    corpoTokens: eventoConfig.corpoTokens || [],
    botaoDinamico: (eventoConfig.botaoIndice != null && eventoConfig.botaoVariavel)
      ? { indice: eventoConfig.botaoIndice, variavel: eventoConfig.botaoVariavel }
      : null,
    headerTipo: (templateInfo && templateInfo.headerTipo) || null,
    sampleMediaAssetId: (templateInfo && templateInfo.sampleMediaAssetId) || null,
    sampleLocation: (templateInfo && templateInfo.sampleLocation) || null,
  };
}

// Chamado a partir de um webhook INK verificado. Só age se existir um template vinculado a esse
// evento e o pedido tiver telefone — nunca lança pra fora (quem chama já loga o erro).
// payment.approved é urgente por natureza e sempre sai na hora; qualquer outro evento de pedido
// que caia fora da janela de horário (08h-22h por padrão) fica esperando em
// `db/envios-pendentes-janela.json` até a janela abrir (`processarFilaDeJanela`).
async function dispararMensagemAutomatica(loja, eventName, order) {
  if (!eventName) return;
  const eventoConfig = ((await readAutomacaoEventos())[loja] || {})[eventName];
  if (!vinculoConfigurado(eventoConfig, (await readWhatsappProviderConfig()).provider)) return;

  if (respeitaJanelaDeEnvio(eventName) && !(await dentroDaJanelaDeEnvio())) {
    await enfileirarParaJanela(loja, eventName, order);
    return;
  }
  await enviarMensagemDePedido(loja, eventName, order, eventoConfig);
}

// Monta e envia de fato — extraído pra ser reaproveitado tanto no disparo imediato quanto no
// job que libera a fila de espera da janela de horário.
async function enviarMensagemDePedido(loja, eventName, order, eventoConfig) {
  const to = formatarTelefoneWhatsapp(order.buyer && order.buyer.phone);
  if (!to) return;

  const vars = await variaveisDoPedido(order, loja);
  await despacharWhatsapp({
    origem: 'pedido',
    referencia: `${loja}:${order.id}:${eventName}`,
    loja,
    evento: eventName,
    pedido: order.rsv_factory_id || String(order.id || ''),
    nome: nomeDoComprador(order.buyer),
    to,
    eventoConfig,
    vars,
    montarPayloadMeta: () => montarPayloadTemplateMeta(to, eventoConfig, vars),
  });
}

async function montarPayloadTemplateMeta(to, eventoConfig, vars) {
  const templateInfo = (await readTemplateConfigs())[eventoConfig.template] || {};
  const components = await montarComponentesEnvio(montarConfigEnvio(eventoConfig, templateInfo), vars);
  return { to, template: eventoConfig.template, language: templateInfo.idioma || 'pt_BR', components };
}

function nomeDoComprador(buyer) {
  if (!buyer) return null;
  return [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() || null;
}

// Fila de espera da janela de horário — só pra eventos de pedido "instantâneos" (shipping.*,
// payment.card_not_authorized etc). Carrinho abandonado e Pix pendente já têm sua própria
// cadência/atraso e checam a janela direto no job periódico deles.
const JANELA_PENDENTES_FILE = path.join(PEDIDOS_DIR, 'envios-pendentes-janela.json');
if (!fs.existsSync(JANELA_PENDENTES_FILE)) fs.writeFileSync(JANELA_PENDENTES_FILE, '[]');

async function readEnviosPendentesJanela() {
  return lerConfigPostgres('envios-pendentes-janela', JANELA_PENDENTES_FILE, []);
}
async function writeEnviosPendentesJanela(pendentes) {
  return salvarConfigPostgres('envios-pendentes-janela', JANELA_PENDENTES_FILE, pendentes);
}
async function enfileirarParaJanela(loja, eventName, order) {
  const pendentes = await readEnviosPendentesJanela();
  pendentes.push({ loja, eventName, order, criadoEm: new Date().toISOString() });
  await writeEnviosPendentesJanela(pendentes);
}

// Despacha o que ficou esperando a janela de horário abrir — roda no mesmo intervalo dos outros
// jobs periódicos. Se ainda estiver fora da janela (ex: rodou 1x de madrugada), não faz nada e
// tenta de novo no próximo ciclo.
async function processarFilaDeJanela() {
  if (!(await dentroDaJanelaDeEnvio())) return;
  const pendentes = await readEnviosPendentesJanela();
  if (!pendentes.length) return;

  const eventos = await readAutomacaoEventos();
  const { provider } = await readWhatsappProviderConfig();
  const restantes = [];
  for (const item of pendentes) {
    const eventoConfig = (eventos[item.loja] || {})[item.eventName];
    if (!vinculoConfigurado(eventoConfig, provider)) continue; // vínculo removido/trocado — descarta
    try {
      await enviarMensagemDePedido(item.loja, item.eventName, item.order, eventoConfig);
    } catch (err) {
      console.error(`[JANELA] falha ao despachar pendente (${item.loja}/${item.eventName}): ${err.message}`);
      restantes.push(item);
    }
  }
  await writeEnviosPendentesJanela(restantes);
}

function extrairCarrinhoDoWebhook(body) {
  return (body && body.cart && typeof body.cart === 'object') ? body.cart
    : (body && body.data && typeof body.data === 'object') ? body.data
    : body || {};
}

// Chamado a partir do primeiro webhook de carrinho abandonado verificado. Só REGISTRA em
// `db/carrinho-envios.json` — o envio de verdade (1º envio incluído) é sempre feito pelo job
// periódico `processarFollowUpsCarrinho`, que respeita o atraso configurado antes do 1º envio e
// a janela de horário. Diferente de pedido, a API da INK não tem endpoint de "buscar 1 carrinho
// por id" (só listagem) — os dados vêm do próprio corpo do webhook, não de uma nova consulta à
// API. Formato confirmado com uma entrega real em 2026-09-03 (ver `variaveisDoCarrinho`).
// Persiste o carrinho observado incondicionalmente, independente de existir automação/template
// configurado — a Ink apaga carrinho abandonado com 30+ dias, então essa é a ÚNICA forma de ainda
// ter telefone/itens/valor pra mandar mensagem manual bem depois disso (achado do usuário,
// 2026-09-06: lojistas queriam recuperar carrinho de 30d+ e não conseguiam, porque antes a
// persistência só acontecia quando automação já estava configurada — duas decisões que deveriam
// ser separadas: "lembrar que esse carrinho existiu" x "mandar mensagem automática pra ele").
// Se já existe registro, só atualiza o snapshot (itens/valor podem ter mudado) sem tocar no
// histórico de envios/estado de automação já em andamento.
async function persistirCarrinhoObservado(loja, cart, eventoHint) {
  const buyer = cart.buyer || {};
  const to = formatarTelefoneWhatsapp(buyer.phone);
  if (!to) return;
  if (buyer.marketing === false || cart.contactable === false) return;

  const chave = `${loja}:${cart.id != null ? cart.id : to}`;
  const envios = await readCarrinhoEnvios();
  if (envios[chave]) {
    envios[chave].cart = cart;
    envios[chave].ultimoVistoEm = new Date().toISOString();
    await writeCarrinhoEnvios(envios);
    return;
  }

  envios[chave] = {
    loja,
    evento: eventoHint,
    telefone: to,
    documento: buyer.document || null,
    email: buyer.email || null,
    cart,
    criadoEm: new Date().toISOString(),
    ultimoVistoEm: new Date().toISOString(),
    ultimoEnvioEm: null,
    envios: [],
    concluido: false,
  };
  await writeCarrinhoEnvios(envios);
}

// Rede de segurança pra persistência — igual ideia do pix.pendente logo abaixo. Reaproveita a
// mesma listagem ao vivo que já alimenta /api/admin/recuperacao, garantindo que todo carrinho que
// a Ink ainda tem fica salvo aqui antes dela apagar, mesmo se o webhook cart.abandoned nunca
// chegou/verificou pra esse carrinho específico.
async function persistirCarrinhosAbandonadosDaOrganizacao() {
  if (!pgPool) return;
  const eventos = await readAutomacaoEventos();
  const { provider } = await readWhatsappProviderConfig();
  const { resultados } = await fetchInkDaStore('/v1/stores/abandoned_carts?per_page=100');
  for (const { loja, data } of resultados) {
    const vinculo = eventoConfigDeCarrinho(eventos[loja] || {}, provider);
    const eventoHint = vinculo ? vinculo.chave : 'cart.abandoned';
    for (const cart of data.abandoned_carts || []) {
      try {
        await persistirCarrinhoObservado(loja, cart, eventoHint);
      } catch (err) {
        console.error(`[CARRINHO_PERSISTENCIA] falha ao persistir carrinho ${cart.id} (${loja}): ${err.message}`);
      }
    }
  }
}

async function dispararMensagemAutomaticaCarrinho(loja, eventName, body) {
  const cart = extrairCarrinhoDoWebhook(body);
  await persistirCarrinhoObservado(loja, cart, eventName);

  // Envio automático continua exigindo automação/template configurado — só a persistência acima
  // é incondicional. O envio de verdade (1º envio incluído) continua feito pelo job periódico
  // processarFollowUpsCarrinho, como já era.
  const eventoConfig = ((await readAutomacaoEventos())[loja] || {})[eventName];
  if (!vinculoConfigurado(eventoConfig, (await readWhatsappProviderConfig()).provider)) return;
}

// Envia (1º envio ou reenvio) a mensagem de carrinho abandonado e atualiza o histórico — chamado
// só a partir de `processarFollowUpsCarrinho`.
async function enviarCarrinhoAbandonado(chave, registro, eventoConfig) {
  const vars = await variaveisDoCarrinho(registro.cart, registro.loja);

  // Nº do envio na referência: 1º envio e reenvios da cadência são mensagens diferentes, não
  // duplicatas (a dedupe da fila Web é por origem:referencia).
  const despachado = await despacharWhatsapp({
    origem: 'carrinho',
    referencia: `${chave}:${((registro.envios || []).length) + 1}`,
    loja: registro.loja,
    evento: registro.evento || null,
    nome: nomeDoComprador(registro.cart && registro.cart.buyer),
    to: registro.telefone,
    eventoConfig,
    vars,
    montarPayloadMeta: () => montarPayloadTemplateMeta(registro.telefone, eventoConfig, vars),
  });
  if (!despachado) return;

  const envios = await readCarrinhoEnvios();
  if (envios[chave]) {
    const agora = new Date().toISOString();
    envios[chave].ultimoEnvioEm = agora;
    envios[chave].envios.push(agora);
    await writeCarrinhoEnvios(envios);
  }
}

// Registrado quando um pedido chega com Pix pendente (`processarEventoWebhook`) — mesma ideia do
// carrinho abandonado (atraso do 1º envio + cadência + anti-spam), evento sintético
// `pix.pendente` (não vem literal da Reserva Ink). Anti-spam: reconsulta o próprio pedido (ainda
// pendente?) e, como carrinho, casa por telefone/doc/email contra pedido pago posterior (ver
// `processarFollowUpsPix`).
// Bug encontrado 2026-09-06 (usuário: pix.pendente nunca teve 1 envio sequer): isso exigia
// `payment_status` já ser EXATAMENTE pending/waiting_payment/awaiting_analysis no instante do
// webhook order.created — se a Ink levasse mais um instante pra popular esse campo, ou mandasse
// um valor não catalogado, o pedido nunca era registrado, e a chance passava pra sempre (só
// `registrarPixPendenteSeAplicavel` roda em order.created, nunca de novo pro mesmo pedido).
//
// Reformulado a partir da observação do usuário: se um Pix é pago, a Ink SEMPRE manda depois um
// `payment.approved` (que já fecha o lembrete via `encerrarPixPendenteSeTerminal`) — PIX aprova
// em 1-2 min no caso comum. Então não precisa confirmar "pendente" aqui: basta não estar
// CONFIRMADAMENTE resolvido (pago ou terminal-ruim) — no dúvida, registra. Quem filtra de
// verdade é a fila de conferência de 15 em 15 min (`processarFollowUpsPix`, já existia) e o
// fechamento antecipado por evento terminal (`encerrarPixPendenteSeTerminal`, já existia) — os
// dois já reavaliam esta mesma função com o pedido atualizado.
function pedidoPixPendente(order) {
  if (!order) return false;
  const metodoPix = String(order.payment_method || '').toLowerCase() === 'pix';
  if (!metodoPix) return false;
  // normalizarPaymentStatusInk: sem isso, um Pix já pago ("Pago", rótulo em português real desta
  // conta) caía em bucket "desconhecido" e era registrado como pendente mesmo já resolvido —
  // achado 2026-09-08, confirmado com payload real de webhook (pedido INK1982524).
  const bucket = bucketPaymentStatus(normalizarPaymentStatusInk(order.payment_status));
  return bucket === 'aguardando' || bucket === 'desconhecido';
}

async function registrarPixPendenteSeAplicavel(loja, eventName, order) {
  if (eventName !== 'order.created' || !pedidoPixPendente(order)) return;
  const eventoConfig = ((await readAutomacaoEventos())[loja] || {})[EVENTO_PIX_PENDENTE];
  if (!vinculoConfigurado(eventoConfig, (await readWhatsappProviderConfig()).provider)) return;

  const to = formatarTelefoneWhatsapp(order.buyer && order.buyer.phone);
  if (!to) return;

  const chave = `${loja}:${order.id}`;
  const lembretes = await readPixLembretes();
  if (lembretes[chave]) return; // já registrado (webhook duplicado)

  lembretes[chave] = {
    loja,
    evento: EVENTO_PIX_PENDENTE,
    telefone: to,
    ...identidadeCompradorPix(order),
    inkOrderId: order.id,
    criadoEm: new Date().toISOString(),
    ultimoEnvioEm: null,
    envios: [],
    concluido: false,
  };
  await writePixLembretes(lembretes);
}

// Fecha o lembrete de Pix pendente assim que a Reserva Ink avisa o desfecho — sem esperar o
// próximo ciclo de `processarFollowUpsPix` notar sozinho. Dois desfechos reais confirmados até
// agora: `payment.pix_boleto_expired` (Pix morreu, cliente não pagou) e `payment.approved`
// (cliente pagou — pedido do usuário, 2026-09-04: "caso tenha um evento de payment.approved
// desse pedido, pode ser removido da fila"). Nunca mandava lembrete indevido nos dois casos
// antes disso (`enviarLembretePix` só roda depois de reconfirmar `payment_status` ainda
// pendente), então isso é sobre agilizar o encerramento e deixar o motivo rastreável — não uma
// correção de mensagem errada saindo. Lista curta de propósito: só eventos confirmados.
const PIX_EVENTOS_TERMINAIS = ['payment.pix_boleto_expired', 'payment.approved'];
const PIX_JANELA_OUTRO_PEDIDO_MS = 24 * 3600 * 1000;

// Campos do comprador guardados no lembrete pra casar "mesmo cliente" entre pedidos diferentes —
// mesmo formato de `pedidos_ink` (só dígitos / minúsculo). Registros antigos só têm `telefone`.
function identidadeCompradorPix(order) {
  const buyer = (order && order.buyer) || {};
  return {
    documento: String(buyer.document || '').replace(/\D/g, '') || null,
    email: (buyer.email || '').toLowerCase() || null,
    pedidoCriadoEm: (order && order.created_at) || null,
  };
}

function lembretePixDoMesmoComprador(registro, order) {
  const alvo = identidadeCompradorPix(order);
  const tel = formatarTelefoneWhatsapp(order.buyer && order.buyer.phone);
  return (tel && registro.telefone === tel)
    || (alvo.documento && registro.documento === alvo.documento)
    || (alvo.email && registro.email === alvo.email);
}

// Mensagem de lembrete já enfileirada no WhatsApp Web (modo manual aguardando aprovação, ou
// pending ainda não pego pelo agente) não pode sair depois do lembrete encerrado. `claimed`
// fica de fora: o agente já está enviando, cancelar ali deixaria o status mentindo.
async function cancelarLembretesPixNaFilaWeb(chaves) {
  if (!pgPool || !chaves.length) return 0;
  const { rowCount } = await pgPool.query(
    `UPDATE whatsapp_web_outbox
        SET status = 'cancelado', atualizado_em = now()
      WHERE origem = 'pix' AND status = ANY($1::text[])
        AND split_part(referencia, ':', 1) || ':' || split_part(referencia, ':', 2) = ANY($2::text[])`,
    [WHATSAPP_WEB_TRANSICOES.cancelar.de, chaves]
  );
  return rowCount;
}

// Em `payment.approved`, também encerra lembretes de OUTROS pedidos Pix do mesmo cliente
// criados nas últimas 24h (pedido do usuário, 2026-09-12: cliente desistiu do INK1994156 e pagou
// o INK1994160 3 min depois, com itens diferentes — o lembrete do antigo não deveria sair).
// `processarFollowUpsPix` já barra isso antes do envio via `clienteJaComprou`; isto só antecipa
// o encerramento e tira da fila do WhatsApp Web o que já estava enfileirado.
async function encerrarPixPendenteSeTerminal(loja, eventName, order) {
  if (!PIX_EVENTOS_TERMINAIS.includes(eventName) || !order) return;
  const chaveProprio = `${loja}:${order.id}`;
  const lembretes = await readPixLembretes();
  const agora = new Date();
  const encerrados = [];

  const encerrar = (chave, motivo) => {
    const registro = lembretes[chave];
    registro.concluido = true;
    registro.concluidoEm = agora.toISOString();
    registro.concluidoMotivo = motivo;
    encerrados.push(chave);
  };

  if (lembretes[chaveProprio] && !lembretes[chaveProprio].concluido) encerrar(chaveProprio, eventName);

  if (eventName === 'payment.approved') {
    const aprovadoCriadoEm = order.created_at ? new Date(order.created_at).getTime() : agora.getTime();
    for (const [chave, registro] of Object.entries(lembretes)) {
      if (chave === chaveProprio || registro.concluido || registro.loja !== loja) continue;
      const criadoEm = new Date(registro.pedidoCriadoEm || registro.criadoEm).getTime();
      if (agora.getTime() - criadoEm > PIX_JANELA_OUTRO_PEDIDO_MS) continue;
      // Pedido Pix criado DEPOIS do pago é uma compra nova, não uma desistência substituída.
      if (registro.pedidoCriadoEm && criadoEm > aprovadoCriadoEm) continue;
      if (!lembretePixDoMesmoComprador(registro, order)) continue;
      encerrar(chave, `payment.approved de outro pedido (${order.rsv_factory_id || order.id})`);
    }
  }

  if (!encerrados.length) return;
  await writePixLembretes(lembretes);
  console.log(`[PIX_LEMBRETE] encerrado(s) via webhook ${eventName} — ${encerrados.join(', ')}`);
  const cancelados = await cancelarLembretesPixNaFilaWeb(encerrados).catch((err) => {
    console.error(`[PIX_LEMBRETE] falha ao cancelar na fila do WhatsApp Web (${encerrados.join(', ')}): ${err.message}`);
    return 0;
  });
  if (cancelados) console.log(`[PIX_LEMBRETE] ${cancelados} envio(s) cancelado(s) na fila do WhatsApp Web`);
}

async function enviarLembretePix(chave, registro, eventoConfig, order) {
  const vars = await variaveisDoPedido(order, registro.loja);

  // Garante a hotpage de pagamento (cria se ainda não existir) e expõe o link pronto pra usar
  // num botão dinâmico — só faz sentido nesse evento específico, por isso não entra em
  // `variaveisDoPedido` (que serve qualquer evento de pedido, a maioria sem hotpage nenhuma).
  try {
    const hotpage = await garantirHotpagePedidoPix(registro.loja, registro.inkOrderId, order);
    if (hotpage) {
      // Caminho canônico da hotpage: `/hotpix/{id}` (ver a rota no fim deste arquivo).
      vars['pedido.link_pagamento'] = `${SITE_BASE_URL}/hotpix/${hotpage.id}`;
      vars['pedido.id_pagamento'] = hotpage.id;
    }
  } catch (err) {
    console.error(`[PIX_LEMBRETE] falha ao gerar hotpage pra ${chave}: ${err.message}`);
  }

  const despachado = await despacharWhatsapp({
    origem: 'pix',
    referencia: `${chave}:${((registro.envios || []).length) + 1}`,
    loja: registro.loja,
    evento: registro.evento || EVENTO_PIX_PENDENTE,
    pedido: order.rsv_factory_id || String(order.id || ''),
    nome: nomeDoComprador(order.buyer),
    to: registro.telefone,
    eventoConfig,
    vars,
    montarPayloadMeta: () => montarPayloadTemplateMeta(registro.telefone, eventoConfig, vars),
  });
  if (!despachado) return;

  const lembretes = await readPixLembretes();
  if (lembretes[chave]) {
    const agora = new Date().toISOString();
    lembretes[chave].ultimoEnvioEm = agora;
    lembretes[chave].envios.push(agora);
    await writePixLembretes(lembretes);
  }
}

// Statuses de pagamento que contam como "cliente converteu" pro anti-spam de carrinho — não dá
// pra filtrar isso direto na consulta à API (o filtro de payment_status só aceita 1 valor).
const PAYMENT_STATUSES_CONVERTIDO = new Set(['paid', 'succeeded', 'free']);

// Não existe endpoint "esse cliente já comprou?" na API da INK — lista pedidos desde a data
// informada e casa por telefone, documento (CPF/CNPJ) ou e-mail, o que estiver disponível (mais
// confiável que o script legado, que só casava por nome normalizado).
async function clienteJaComprou(loja, registro, desdeIso) {
  // Registro de carrinho guarda o telefone com DDI 55 (formato WhatsApp) e pedidos_ink guarda sem —
  // compara as duas variantes (ver lib/recuperacao/compra.js).
  const telefones = variantesTelefone(registro.telefone);
  const docAlvo = String(registro.documento || '').replace(/\D/g, '') || null;
  const emailAlvo = (registro.email || '').trim().toLowerCase() || null;
  if (!telefones.length && !docAlvo && !emailAlvo) return false;

  if (pgPool) {
    const { rows } = await pgPool.query(
      `SELECT 1 FROM pedidos_ink
       WHERE organization_id = $1 AND ${escopoDaStore(2).sql}
         AND payment_status = ANY($${2 + escopoDaStore(2).usados}) AND criado_em >= $${3 + escopoDaStore(2).usados} AND is_troca IS NOT TRUE
         AND (buyer_telefone = ANY($${4 + escopoDaStore(2).usados}) OR buyer_documento = $${5 + escopoDaStore(2).usados} OR buyer_email = $${6 + escopoDaStore(2).usados})
       LIMIT 1`,
      [orgDoContexto(), ...escopoDaStore(2).params, Array.from(PAYMENT_STATUSES_CONVERTIDO), desdeIso, telefones, docAlvo, emailAlvo]
    );
    return rows.length > 0;
  }

  // Sem Postgres configurado ainda: cai pra consulta direta na API da INK (mais lenta, sem
  // cache local) — mantém o anti-spam funcionando enquanto o banco não é provisionado.
  const desde = desdeIso.slice(0, 10);
  let page = 1;
  let totalPages = 1;
  do {
    const data = await inkApiRequestDaStore(`/v1/stores/orders?begin_date=${desde}&page=${page}&per_page=100`);
    for (const o of data.orders || []) {
      if (!PAYMENT_STATUSES_CONVERTIDO.has(normalizarPaymentStatusInk(o.payment_status)) || o.is_exchange) continue;
      const buyer = o.buyer || {};
      const tel = String(buyer.phone || '').replace(/\D/g, '');
      const doc = String(buyer.document || '').replace(/\D/g, '');
      const email = (buyer.email || '').trim().toLowerCase();
      if ((tel && telefones.includes(tel)) || (docAlvo && doc === docAlvo) || (emailAlvo && email === emailAlvo)) return true;
    }
    totalPages = data.total_pages || 1;
    page += 1;
  } while (page <= totalPages);
  return false;
}

// Sincroniza pedidos da INK pro cache local (Postgres) — roda de hora em hora, buscando desde o
// último sync (ou os últimos 30 dias na 1ª vez). Alimenta `clienteJaComprou` sem precisar bater
// na API da INK a cada checagem de carrinho abandonado.
// Upsert de 1 pedido no cache Postgres — usado tanto pelo sync periódico (`syncPedidosLoja`)
// quanto em tempo real quando um webhook de pedido chega (`processarEventoWebhook`), pra não
// depender só do sync de hora em hora pro anti-spam de carrinho enxergar uma compra recém-paga.
// Conta financeira do pedido e rateio por item: lib/ink/financeiro.js (testada em test/ink-financeiro.test.js).

// Regrava os itens do pedido numa transação (apaga e insere): item removido de um pedido editável
// não pode sobrar contando lucro. Payload sem itens não toca em nada.
async function upsertItensPedidoInkPostgres(lojaOuChave, order) {
  const loja = lojaLegadaParaColuna(lojaOuChave);
  if (!pgPool || !order || !Array.isArray(order.items) || order.id == null) return;
  const itens = financeiroItensPedidoInk(order);
  const cliente = await pgPool.connect();
  try {
    await cliente.query('BEGIN');
    const storeId = storeDoContexto();
    await cliente.query('DELETE FROM pedidos_ink_itens WHERE store_id = $1 AND ink_order_id = $2', [storeId, order.id]);
    for (const it of itens) {
      await cliente.query(
        `INSERT INTO pedidos_ink_itens
           (store_id, loja, ink_order_id, item_id, produto_id, produto_nome, sku, modelo, cor, tamanho, quantidade,
            valor_venda, desconto_rateado, custo_producao, lucro_operacional)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (organization_id, store_id, item_id) WHERE store_id IS NOT NULL DO NOTHING`,
        [storeId, loja || null, order.id, it.itemId, it.produtoId, it.produtoNome, it.sku, it.modelo, it.cor, it.tamanho, it.quantidade,
          it.venda, it.desconto, it.custo, it.lucro]
      );
    }
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// `loja` que chega aqui pode ser a CHAVE de escopo da Store (`chaveDaStore()`: a chave legada OU o `store_id`
// da Store nativa). Só a chave LEGADA pode ir para a coluna `loja`: gravar o `store_id` ali fazia a tela de
// Clientes mostrar o UUID como nome de loja (achado do smoke pós-#10).
function lojaLegadaParaColuna(loja) {
  return loja && loja !== storeDoContexto() ? loja : null;
}

async function upsertPedidoInkPostgres(lojaOuChave, order) {
  const loja = lojaLegadaParaColuna(lojaOuChave);
  if (!pgPool) return;
  const buyer = order.buyer || {};
  const fin = financeiroPedidoInk(order);
  const uf = String((order.shipping_address && order.shipping_address.state) || '').trim().toUpperCase().slice(0, 2) || null;
  await pgPool.query(
    `INSERT INTO pedidos_ink (store_id, loja, ink_order_id, rsv_factory_id, payment_status, order_status, buyer_nome, buyer_telefone, buyer_documento, buyer_email, buyer_aceita_marketing, buyer_uf, total_value, criado_em, items_count,
       frete, descontos, lucro_bruto, custo_producao, lucro_operacional, is_troca, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())
     ON CONFLICT (organization_id, store_id, ink_order_id) WHERE store_id IS NOT NULL DO UPDATE SET
       payment_status = EXCLUDED.payment_status,
       order_status = EXCLUDED.order_status,
       buyer_nome = EXCLUDED.buyer_nome,
       buyer_telefone = EXCLUDED.buyer_telefone,
       buyer_documento = EXCLUDED.buyer_documento,
       buyer_email = EXCLUDED.buyer_email,
       buyer_aceita_marketing = EXCLUDED.buyer_aceita_marketing,
       buyer_uf = EXCLUDED.buyer_uf,
       total_value = EXCLUDED.total_value,
       items_count = COALESCE(EXCLUDED.items_count, pedidos_ink.items_count),
       frete = COALESCE(EXCLUDED.frete, pedidos_ink.frete),
       descontos = COALESCE(EXCLUDED.descontos, pedidos_ink.descontos),
       lucro_bruto = COALESCE(EXCLUDED.lucro_bruto, pedidos_ink.lucro_bruto),
       custo_producao = COALESCE(EXCLUDED.custo_producao, pedidos_ink.custo_producao),
       lucro_operacional = COALESCE(EXCLUDED.lucro_operacional, pedidos_ink.lucro_operacional),
       is_troca = COALESCE(EXCLUDED.is_troca, pedidos_ink.is_troca),
       atualizado_em = now()`,
    [
      storeDoContexto(), loja || null, order.id, order.rsv_factory_id || null, normalizarPaymentStatusInk(order.payment_status) || null, order.order_status || null,
      [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() || null,
      String(buyer.phone || '').replace(/\D/g, '') || null,
      String(buyer.document || '').replace(/\D/g, '') || null,
      (buyer.email || '').toLowerCase() || null,
      buyer.accepts_marketing != null ? !!buyer.accepts_marketing : null,
      uf,
      order.total_value != null ? Number(order.total_value) : null,
      order.created_at || null,
      // Payload sem `items` (ex.: evento parcial) não apaga a contagem já conhecida (COALESCE acima).
      Array.isArray(order.items) ? order.items.length : null,
      // Payload sem itens também não apaga o financeiro já conhecido (COALESCE acima).
      fin ? fin.frete : null,
      fin ? fin.descontos : null,
      fin ? fin.lucroBruto : null,
      fin ? fin.custoProducao : null,
      fin ? fin.lucroOperacional : null,
      fin ? fin.troca : null,
    ]
  );
  await upsertItensPedidoInkPostgres(loja, order);
}

// Registra uma observação de estoque por variação (tamanho/cor/modelo) a cada item de pedido
// que tiver `product_variant` — só "de carona" nos webhooks já recebidos, não uma sincronização
// de verdade (ver comentário no schema). Recurso opcional: sem Postgres, simplesmente não
// coleta nada (diferente dos dados de painel migrados antes, isso não tem valor crítico o
// bastante pra justificar um fallback em JSON crescendo sem limite).
async function registrarObservacoesEstoque(loja, order) {
  if (!pgPool) return;
  const itens = (order && order.items) || [];
  for (const item of itens) {
    const variante = item.product_variant;
    if (!variante || variante.id == null) continue;
    const produto = item.product_v2 || {};
    try {
      await pgPool.query(
        `INSERT INTO estoque_observacoes
           (loja, product_variant_id, sku, produto_id, produto_nome, tamanho, cor, modelo, quantidade_disponivel, disponivel)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          loja, variante.id, variante.sku || null, produto.id || null, produto.name || null,
          variante.size || null, variante.color || null, variante.model || null,
          variante.available_quantity != null ? variante.available_quantity : null,
          variante.is_available != null ? variante.is_available : null,
        ]
      );
    } catch (err) {
      console.error(`[ESTOQUE] falha ao registrar observação (loja ${loja}, variante ${variante.id}): ${err.message}`);
    }
  }
}

// Controle de estoque via produto dedicado "controle-estoque" (1 por tipo de peça, nunca
// publicado). A API não filtra produto por nome — precisa buscar TODOS os produtos da loja e
// filtrar aqui (confirmado com o usuário: "controle-estoque" é o `name` literal, `product_type`
// diz qual peça é). A própria listagem já traz `product_variants[]` com quantidade/disponibilidade
// — não precisa de um GET extra por produto.
const CONTROLE_ESTOQUE_NOME = 'controle-estoque';
const CONTROLE_ESTOQUE_MAX_PAGINAS = 50; // trava de segurança (5000 produtos), nunca deveria bater nisso

async function sincronizarControleEstoque(loja) {
  if (!pgPool) return { produtos: 0, variantes: 0 };
  if (lojaLegadaDoContexto() !== loja || !(await inkConectada())) return { produtos: 0, variantes: 0 };

  let page = 1;
  let totalPages = 1;
  let produtosEncontrados = 0;
  let variantesGravadas = 0;

  do {
    const data = await inkApiRequest(loja, `/v1/stores/products?page=${page}&per_page=100`);
    for (const p of data.products || []) {
      if (String(p.name || '').trim().toLowerCase() !== CONTROLE_ESTOQUE_NOME) continue;
      produtosEncontrados += 1;
      const produtoTipo = (p.product_type && p.product_type.name) || null;
      for (const v of p.product_variants || []) {
        if (v.id == null) continue;
        try {
          await pgPool.query(
            `INSERT INTO controle_estoque_observacoes
               (loja, produto_id, produto_tipo, variant_id, sku, tamanho, cor, modelo, quantidade_disponivel, disponivel)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              loja, p.id, produtoTipo, v.id, v.sku || null,
              v.size || null, v.color || null, v.model || null,
              v.available_quantity != null ? v.available_quantity : null,
              v.is_available != null ? v.is_available : null,
            ]
          );
          variantesGravadas += 1;
        } catch (err) {
          console.error(`[CONTROLE_ESTOQUE] falha ao gravar variante ${v.id} (loja ${loja}, produto ${p.id}): ${err.message}`);
        }
      }
    }
    totalPages = Math.min(data.total_pages || 1, CONTROLE_ESTOQUE_MAX_PAGINAS);
    page += 1;
  } while (page <= totalPages);

  console.log(`[CONTROLE_ESTOQUE] ${loja}: ${produtosEncontrados} produto(s) "controle-estoque", ${variantesGravadas} variante(s) sincronizada(s)`);
  return { produtos: produtosEncontrados, variantes: variantesGravadas };
}

async function sincronizarControleEstoqueDaOrganizacao() {
  // Controle de estoque ainda grava em tabela cuja coluna `loja` é obrigatória (não foi convertido
  // para `store_id`), então só roda para Store com chave legada. Store nativa não é "falha": não há
  // o que sincronizar por este caminho — antes ela entrava aqui com `loja` nula e logava erro a
  // cada ciclo.
  for (const loja of await lojasLegadasInkDoContexto()) {
    try {
      await sincronizarControleEstoque(loja);
    } catch (err) {
      console.error(`[CONTROLE_ESTOQUE] falha ao sincronizar loja ${loja}: ${err.message}`);
    }
  }
}

async function syncPedidosLoja(loja) {
  const escopoSync = escopoDaStore(2);
  const estado = await pgPool.query(
    `SELECT ultimo_sync_em FROM sync_estado WHERE organization_id = $1 AND ${escopoSync.sql} ORDER BY ultimo_sync_em DESC LIMIT 1`,
    [orgDoContexto(), ...escopoSync.params]
  );
  const desde = estado.rows[0]
    ? estado.rows[0].ultimo_sync_em.toISOString().slice(0, 10)
    : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  let page = 1;
  let totalPages = 1;
  do {
    const data = await inkApiRequest(loja, `/v1/stores/orders?begin_date=${desde}&page=${page}&per_page=100`);
    for (const o of data.orders || []) {
      await upsertPedidoInkPostgres(loja, o);
      // Sync de hora em hora relista os mesmos pedidos recentes — "de graça", dá bem mais
      // observação de estoque por variação do que só esperar um webhook novo tocar naquele SKU.
      // Compatibilidade: `estoque_observacoes` ainda tem `loja` obrigatória. Sem chave legada,
      // não há onde gravar — e inventar uma seria pior do que não coletar a observação.
      if (loja) await registrarObservacoesEstoque(loja, o);
    }
    totalPages = data.total_pages || 1;
    page += 1;
  } while (page <= totalPages);

  await pgPool.query(
    `INSERT INTO sync_estado (store_id, loja, ultimo_sync_em) VALUES ($1, $2, now())
     ON CONFLICT (organization_id, store_id) WHERE store_id IS NOT NULL DO UPDATE SET ultimo_sync_em = now()`,
    [storeDoContexto(), loja || null]
  );
}

async function syncPedidosInkParaPostgres() {
  if (!pgPool) return;
  for (const { loja } of await storesInkDoContexto()) {
    try {
      await syncPedidosLoja(loja);
    } catch (err) {
      console.error(`[SYNC_PEDIDOS] falha ao sincronizar ${loja}: ${err.message}`);
    }
  }
}

const SYNC_PEDIDOS_INTERVAL_MS = 60 * 60 * 1000;
JOBS.agendar('sync-pedidos-ink', SYNC_PEDIDOS_INTERVAL_MS, () => syncPedidosInkParaPostgres());
// Não há sync "no boot" fora do runner: chamar `syncPedidosInkParaPostgres()` daqui rodava SEM
// contexto de Organization e falhava em todo boot ("operação de store fora de um contexto de
// Organization") — desde a Fase 3 ele nunca sincronizou nada. Quem sincroniza é o ciclo horário
// acima (por Organization, sob contexto) e o webhook, que mantém o cache fresco entre um ciclo e outro.

// Backfill histórico sob demanda (não é o sync incremental de hora em hora acima) — busca
// pedidos desde uma data bem antiga informada pelo admin, pra cobrir o gap de antes da loja
// entrar no sync automático. Reaproveita o mesmo upsert idempotente (ON CONFLICT loja+ink_order_id)
// do sync incremental, então rodar de novo (ou re-rodar em cima de um período já coberto) nunca
// duplica nada. Deliberadamente NÃO chama registrarObservacoesEstoque: aquilo registra a
// disponibilidade ATUAL da variação, o que não faz sentido associado a um pedido antigo — só é
// útil "de carona" no sync de pedidos recentes. Também nunca toca em sync_estado.ultimo_sync_em,
// que é o cursor do sync incremental — os dois processos são independentes de propósito.
const lojasComBackfillPedidosRodando = new Set(); // por store_id

async function processarBackfillHistoricoPedidos(jobId, storeId, desde) {
  // Roda sob o contexto da request que o iniciou (Organization + Store). Identidade canônica:
  // a credencial Ink é a da Store; `loja` (chave legada, nula na Store nativa) só espelha o histórico.
  const loja = lojaLegadaDoContextoOuNula();
  let pedidosProcessados = 0;
  try {
    let page = 1;
    let totalPages = 1;
    do {
      const data = await inkApiRequestDaStore(`/v1/stores/orders?begin_date=${desde}&page=${page}&per_page=100`);
      for (const o of data.orders || []) {
        await upsertPedidoInkPostgres(loja, o);
      }
      pedidosProcessados += (data.orders || []).length;
      totalPages = data.total_pages || 1;

      await pgPool.query(
        `UPDATE pedidos_backfill_jobs SET paginas_processadas = $1, paginas_total = $2, pedidos_processados = $3, atualizado_em = now() WHERE id = $4`,
        [page, totalPages, pedidosProcessados, jobId]
      );
      page += 1;
    } while (page <= totalPages);

    await pgPool.query(
      `UPDATE pedidos_backfill_jobs SET status = 'concluido', atualizado_em = now() WHERE id = $1`,
      [jobId]
    );
  } catch (err) {
    console.error(`[BACKFILL_PEDIDOS] falha ao processar job ${jobId} (${loja}): ${err.message}`);
    await pgPool.query(
      `UPDATE pedidos_backfill_jobs SET status = 'falhou', erro = $1, atualizado_em = now() WHERE id = $2`,
      [String(err.message || 'erro desconhecido').slice(0, 500), jobId]
    ).catch(() => {});
  } finally {
    lojasComBackfillPedidosRodando.delete(storeId);
  }
}

// Responde imediatamente com o id do job e processa em background — uma loja com anos de
// histórico pode levar bem mais que a duração de uma request HTTP pra paginar tudo na Ink.
app.post('/api/admin/pedidos/backfill-historico', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'backfill exige Postgres configurado' });
  const storeId = storeDoContexto();
  const loja = lojaLegadaDoContextoOuNula();
  if (!(await inkConectada())) return res.status(409).json({ error: 'esta loja não tem a integração com a Reserva Ink configurada' });
  if (lojasComBackfillPedidosRodando.has(storeId)) {
    return res.status(409).json({ error: 'já existe um backfill em andamento para esta loja — aguarde terminar' });
  }

  const desdeInformado = (req.body || {}).desde;
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(desdeInformado || '') ? desdeInformado : '2015-01-01';

  try {
    const jobRows = await pgPool.query(
      `INSERT INTO pedidos_backfill_jobs (store_id, loja, desde, status) VALUES ($1, $2, $3, 'processando') RETURNING id`,
      [storeId, loja, desde]
    );
    const jobId = jobRows.rows[0].id;
    lojasComBackfillPedidosRodando.add(storeId);
    processarBackfillHistoricoPedidos(jobId, storeId, desde).catch((err) => {
      console.error(`[BACKFILL_PEDIDOS] falha não tratada no job ${jobId}: ${err.message}`);
    });
    res.status(202).json({ jobId });
  } catch (err) {
    console.error(`[BACKFILL_PEDIDOS] falha ao iniciar backfill (store ${storeId}): ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'não foi possível iniciar o backfill' });
  }
});

app.get('/api/admin/pedidos/backfill-historico/:jobId', requireAdmin, exigirRecurso('pedidos_backfill_jobs', { param: 'jobId' }), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'backfill exige Postgres configurado' });
  const { jobId } = req.params;
  const escopo = escopoDaStore(3);
  const { rows } = await pgPool.query(
    `SELECT * FROM pedidos_backfill_jobs WHERE id = $1 AND organization_id = $2 AND ${escopo.sql}`,
    [jobId, orgDoContexto(), ...escopo.params]
  );
  if (!rows[0]) return res.status(404).json({ error: 'job não encontrado' });
  res.json({ job: rows[0] });
});

app.get('/api/admin/pedidos/backfill-historico', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'backfill exige Postgres configurado' });
  const escopo = escopoDaStore(2);
  const { rows } = await pgPool.query(
    `SELECT * FROM pedidos_backfill_jobs WHERE organization_id = $1 AND ${escopo.sql} ORDER BY criado_em DESC LIMIT 10`,
    [orgDoContexto(), ...escopo.params]
  );
  res.json({ jobs: rows });
});

// Diagnóstico pontual pro filtro de UF (dúvida real: "RS achou só 5 clientes, tá quebrado ou é
// só o público mesmo?") — mostra os números crus antes de qualquer filtro, pra decidir com dado
// real em vez de suposição. Cobre tanto "o backfill preencheu buyer_uf de verdade?" (pedidos)
// quanto "como isso se distribui entre os clientes agregados?" (pessoas).
app.get('/api/admin/pedidos/uf-diagnostico', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'diagnóstico exige Postgres configurado' });
  const escopo = escopoDaStore(2);
  const doEscopo = (extra = '') => [
    `SELECT COUNT(*) FROM pedidos_ink WHERE organization_id = $1 AND ${escopo.sql}${extra}`,
    [orgDoContexto(), ...escopo.params],
  ];

  try {
    const pedidosTotal = await pgPool.query(...doEscopo());
    const pedidosComUf = await pgPool.query(...doEscopo(' AND buyer_uf IS NOT NULL'));
    const pedidosSemEndereco = await pgPool.query(...doEscopo(' AND buyer_uf IS NULL'));

    const clientes = await buscarClientesAgregados();
    const comUf = clientes.filter((c) => c.uf).length;
    const distribuicao = {};
    for (const c of clientes) {
      const chave = c.uf || 'sem_uf';
      distribuicao[chave] = (distribuicao[chave] || 0) + 1;
    }
    const distribuicaoOrdenada = Object.entries(distribuicao)
      .sort((a, b) => b[1] - a[1])
      .map(([uf, total]) => ({ uf, total }));

    res.json({
      pedidos: {
        total: Number(pedidosTotal.rows[0].count),
        comUf: Number(pedidosComUf.rows[0].count),
        semUf: Number(pedidosSemEndereco.rows[0].count),
      },
      clientes: {
        total: clientes.length,
        comUf,
        semUf: clientes.length - comUf,
        distribuicaoPorUf: distribuicaoOrdenada,
      },
    });
  } catch (err) {
    console.error(`[UF_DIAGNOSTICO] falha ao gerar diagnóstico (${loja}): ${err.message}`);
    res.status(500).json({ error: 'não foi possível gerar o diagnóstico' });
  }
});

// Dono único do 1º envio E dos reenvios de carrinho abandonado — não existe re-entrega de
// webhook pra "lembrar de novo", então um job periódico verifica quem ainda não bateu o limite
// de envios, já esperou o tempo configurado (atraso do 1º envio OU intervalo entre reenvios,
// dependendo de qual envio é o próximo) e (se configurado) ainda não comprou. Também não sai
// fora da janela de horário (nenhum evento de carrinho é payment.approved).
async function processarFollowUpsCarrinho() {
  if (!(await dentroDaJanelaDeEnvio())) return;
  const eventos = await readAutomacaoEventos();
  const envios = await readCarrinhoEnvios();
  const { provider } = await readWhatsappProviderConfig();
  const agora = Date.now();

  for (const [chave, registro] of Object.entries(envios)) {
    if (registro.concluido) continue;
    const eventoConfig = (eventos[registro.loja] || {})[registro.evento];
    if (!vinculoConfigurado(eventoConfig, provider)) continue; // vínculo removido — não reenvia mais

    const maxEnvios = eventoConfig.maxEnvios || 1;
    if (registro.envios.length >= maxEnvios) continue;

    const primeiroEnvio = registro.envios.length === 0;
    const horasEspera = primeiroEnvio
      ? (eventoConfig.atrasoPrimeiroEnvioHoras != null ? eventoConfig.atrasoPrimeiroEnvioHoras : 24)
      : (eventoConfig.intervaloHoras || 24);
    const desde = primeiroEnvio ? registro.criadoEm : registro.ultimoEnvioEm;
    if (agora - new Date(desde).getTime() < horasEspera * 3600 * 1000) continue;

    try {
      // Janela desde o carrinho (não desde o último envio): envio manual pela tela não checa na
      // hora do disparo, então compra feita antes dele passaria batida se contasse só dali pra frente.
      const desdeCompra = inicioDoCarrinho(registro);
      if (eventoConfig.checarCompra !== false && await clienteJaComprou(registro.loja, registro, desdeCompra)) {
        registro.concluido = true;
        await writeCarrinhoEnvios(envios);
        continue;
      }
      await enviarCarrinhoAbandonado(chave, registro, eventoConfig);
    } catch (err) {
      console.error(`[CARRINHO_FOLLOWUP] falha ao reenviar pra ${chave}: ${err.message}`);
    }
  }
}

// Mesma ideia, mas pro lembrete de Pix pendente — anti-spam reconsulta o próprio pedido e também
// casa por telefone/documento/e-mail contra pedidos pagos criados depois dele (`clienteJaComprou`).
async function processarFollowUpsPix() {
  if (!(await dentroDaJanelaDeEnvio())) return;
  const eventos = await readAutomacaoEventos();
  const lembretes = await readPixLembretes();
  const { provider } = await readWhatsappProviderConfig();
  const agora = Date.now();

  for (const [chave, registro] of Object.entries(lembretes)) {
    if (registro.concluido) continue;
    const eventoConfig = (eventos[registro.loja] || {})[EVENTO_PIX_PENDENTE];
    if (!vinculoConfigurado(eventoConfig, provider)) continue;

    const maxEnvios = eventoConfig.maxEnvios || 1;
    if (registro.envios.length >= maxEnvios) continue;

    const primeiroEnvio = registro.envios.length === 0;
    const horasEspera = primeiroEnvio
      ? (eventoConfig.atrasoPrimeiroEnvioHoras != null ? eventoConfig.atrasoPrimeiroEnvioHoras : 4)
      : (eventoConfig.intervaloHoras || 24);
    const desde = primeiroEnvio ? registro.criadoEm : registro.ultimoEnvioEm;
    if (agora - new Date(desde).getTime() < horasEspera * 3600 * 1000) continue;

    try {
      const data = await inkApiRequest(registro.loja, `/v1/stores/orders/${registro.inkOrderId}`);
      // Fonte da verdade é `payment_status` (sempre presente e documentado), não o objeto de
      // conveniência `order.pix` — ver `pedidoPixPendente`. Pagou, cancelou, expirou ou falhou:
      // todos saem de PENDING_PAYMENT_STATUSES, então todos encerram o lembrete aqui.
      if (!data.order || !pedidoPixPendente(data.order)) {
        // Se isso acontece no 1º envio (envios.length === 0), o desfecho aconteceu ANTES do
        // atraso configurado (`atrasoPrimeiroEnvioHoras`) terminar — nenhum lembrete chegou a
        // sair pra esse pedido. Log específico pra não ficar indistinguível de "cliente pagou
        // depois de já ter recebido lembrete" — se isso aparecer muito, o atraso configurado em
        // /admin/automacoes está maior que a validade real do Pix da Reserva Ink, ou os pedidos
        // costumam nascer fora da janela de envio (08h–22h) com Pix de validade curta.
        if (registro.envios.length === 0) {
          console.warn(`[PIX_FOLLOWUP] ${chave}: Pix resolveu (payment_status=${data.order && data.order.payment_status}) antes do 1º lembrete sair`);
        }
        registro.concluido = true;
        registro.concluidoEm = new Date().toISOString();
        registro.concluidoMotivo = data.order ? `payment_status:${data.order.payment_status}` : 'pedido não encontrado';
        await writePixLembretes(lembretes);
        continue;
      }
      // Cliente desistiu deste Pix mas refez a compra em OUTRO pedido já pago (achado do usuário,
      // 2026-09-12: INK1994156 pendente às 20:27, INK1994160 pago às 20:30, mesmo cliente, itens
      // diferentes — e o lembrete do pedido antigo saiu mesmo assim). Este pedido segue pendente
      // pra sempre, então só a reconsulta dele nunca encerraria o lembrete. Casa pelos dados crus
      // do comprador (mesmo formato gravado em pedidos_ink), não pelo telefone já formatado.
      if (eventoConfig.checarCompra !== false) {
        const buyer = data.order.buyer || {};
        const comprador = { telefone: buyer.phone, documento: buyer.document, email: buyer.email };
        const desdePedido = data.order.created_at || registro.criadoEm;
        if (await clienteJaComprou(registro.loja, comprador, desdePedido)) {
          console.log(`[PIX_FOLLOWUP] ${chave}: encerrado — cliente já pagou outro pedido depois deste`);
          registro.concluido = true;
          registro.concluidoEm = new Date().toISOString();
          registro.concluidoMotivo = 'cliente pagou outro pedido';
          await writePixLembretes(lembretes);
          continue;
        }
      }
      if (!data.order.pix) {
        // payment_status ainda pendente, mas a Ink não populou `order.pix` ainda — sem isso não
        // dá pra montar o link de pagamento (`garantirHotpagePedidoPix` exige `order.pix`).
        // Tenta de novo no próximo ciclo em vez de desistir ou mandar mensagem com link quebrado.
        console.warn(`[PIX_FOLLOWUP] ${chave}: payment_status pendente mas order.pix ainda vazio — tentando de novo no próximo ciclo`);
        continue;
      }
      await enviarLembretePix(chave, registro, eventoConfig, data.order);
    } catch (err) {
      console.error(`[PIX_FOLLOWUP] falha ao processar ${chave}: ${err.message}`);
    }
  }
}

// Rede de segurança pro registro de pix.pendente — o registro "de verdade" só acontece 1x, no
// exato instante do webhook order.created (`registrarPixPendenteSeAplicavel`). Se a Ink ainda não
// tinha populado o Pix pendente naquele milissegundo, ou se o pedido nunca passou por webhook
// nenhum (cadastrado via /admin/pedidos/novo ou vinculado via /admin/pedidos/vincular), essa era
// a única chance — e ela passava pra sempre (achado do usuário: pix.pendente nunca teve 1 envio
// sequer monitorado). Reaproveita a mesma busca de /api/admin/recuperacao (já teste na prática)
// pra pegar pendentes que ainda não têm registro e registrar agora, com atraso contado a partir
// de agora (não do pedido original) — só entrega quem chegou depois do atraso configurado.
async function registrarPixPendentesFaltantes() {
  if (!pgPool) return;
  const { pendentes } = await buscarPedidosPixPendentes();
  if (!pendentes.length) return;

  const eventos = await readAutomacaoEventos();
  const lembretes = await readPixLembretes();
  const { provider } = await readWhatsappProviderConfig();
  let novos = 0;
  for (const p of pendentes) {
    const chave = `${p.loja}:${p.inkOrderId}`;
    if (lembretes[chave]) continue;
    const eventoConfig = (eventos[p.loja] || {})[EVENTO_PIX_PENDENTE];
    if (!vinculoConfigurado(eventoConfig, provider)) continue;
    const to = formatarTelefoneWhatsapp(p.buyerPhone);
    if (!to) continue;
    lembretes[chave] = {
      loja: p.loja, evento: EVENTO_PIX_PENDENTE, telefone: to, ...identidadeCompradorPix(p.ordemBruta), inkOrderId: p.inkOrderId,
      criadoEm: new Date().toISOString(), ultimoEnvioEm: null, envios: [], concluido: false,
    };
    novos += 1;
  }
  if (novos) {
    await writePixLembretes(lembretes);
    console.log(`[PIX_LEMBRETE] rede de segurança registrou ${novos} pendente(s) que não vieram do webhook`);
  }
}

// ── Fila de disparo de campanha (Fase 6 do plano) ───────────────────────
// URL pública (Meta busca o arquivo direto, sem sessão admin) da mídia de ENVIO real associada
// à campanha — nunca a mesma coisa que o header_handle da amostra usada na aprovação do
// template (spec, Parte 6/35). Null se a campanha não tiver mídia (header de texto/nenhum).
async function linkPublicoMedia(mediaAssetId) {
  if (!mediaAssetId) return null;
  const { rows } = await pgPool.query('SELECT public_token FROM media_assets WHERE id = $1', [mediaAssetId]);
  if (!rows.length || !rows[0].public_token) return null;
  return `${SITE_BASE_URL}/midia/${rows[0].public_token}/arquivo`;
}

// Monta os `components` de envio real de uma campanha — variante de montarComponentesEnvio pra
// header de MÍDIA (imagem/vídeo/documento)/LOCATION e botão de URL dinâmica, que as automações
// (carrinho/PIX) resolvem com outro shape de config. `resolvedVariables` vem já resolvido do
// snapshot (campaign_recipients): corpo chaveado por índice/nome de token ("1", "2"...), header de
// texto e botão dinâmico em `__header__`/`__botao__` (chaves reservadas, nunca colidem com token
// numérico de corpo).
function montarComponentesEnvioCampanha(templateMeta, headerTipo, mediaLink, sampleLocation, resolvedVariables) {
  const { header, corpo } = textosDoTemplateMeta(templateMeta);
  const vars = resolvedVariables || {};
  const components = [];

  if (headerTipo === 'IMAGE' || headerTipo === 'VIDEO' || headerTipo === 'DOCUMENT') {
    if (!mediaLink) throw new Error('mídia do cabeçalho da campanha não está disponível');
    const tipoParam = headerTipo.toLowerCase();
    components.push({ type: 'header', parameters: [{ type: tipoParam, [tipoParam]: { link: mediaLink } }] });
  } else if (headerTipo === 'LOCATION') {
    if (!sampleLocation) throw new Error('localização do cabeçalho da campanha não está configurada');
    components.push({
      type: 'header',
      parameters: [{
        type: 'location',
        location: {
          latitude: sampleLocation.latitude, longitude: sampleLocation.longitude,
          name: sampleLocation.nome || undefined, address: sampleLocation.endereco || undefined,
        },
      }],
    });
  } else if (header) {
    const headerTokens = extrairTokensVariaveis(header);
    if (headerTokens.length) {
      components.push({ type: 'header', parameters: [construirParametroTexto(headerTokens[0], vars.__header__)] });
    }
  }

  const corpoTokens = extrairTokensVariaveis(corpo || '');
  if (corpoTokens.length) {
    components.push({
      type: 'body',
      parameters: corpoTokens.map((token) => construirParametroTexto(token, vars[token])),
    });
  }

  const botaoDinamico = extrairBotaoDinamico(templateMeta && templateMeta.components);
  if (botaoDinamico) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(botaoDinamico.indice),
      parameters: [{ type: 'text', text: vars.__botao__ != null ? String(vars.__botao__) : '' }],
    });
  }

  return components.length ? components : undefined;
}

// Guard em memória contra 2 ticks do job processando a MESMA campanha em paralelo (o ciclo é
// curto — CAMPANHA_FILA_INTERVAL_MS — e um lote pode demorar mais que isso se a Meta responder
// devagar). Não protege contra 2 processos Node rodando ao mesmo tempo (não é o caso aqui, é
// sempre 1 processo por deploy Railway).
const campanhasEmProcessamento = new Set();
const CAMPANHA_LOTE_TAMANHO = 10;

// Campanhas 'scheduled' cuja hora chegou viram 'preparing' (snapshot de destinatários) — mesma
// função usada pelo endpoint /start, só que disparada pelo relógio em vez de um clique.
async function iniciarCampanhasAgendadasVencidas() {
  const { rows } = await pgPool.query(
    `SELECT ${CAMPAIGN_SELECT_COLS} FROM campaigns WHERE status = 'scheduled' AND agendada_para <= now() ORDER BY agendada_para ASC LIMIT 5`
  );
  for (const campanha of rows) {
    try {
      await iniciarDisparoCampanha(campanha);
    } catch (err) {
      console.error(`[CAMPANHAS_FILA] falha ao iniciar campanha agendada ${campanha.id}: ${err.message}`);
    }
  }
}

// Processa um lote de destinatários 'pending' de UMA campanha (preparing/sending) por tick —
// nunca todas de uma vez, pra não estourar rate limit da Meta nem virar um loop síncrono gigante
// (spec, Parte 19/29). `FOR UPDATE SKIP LOCKED` marcando como 'queued' evita duplicar envio se
// um dia isso rodar em mais de um processo.
async function processarLoteCampanha(campanhaId) {
  // CTE, e não "WHERE id IN (subconsulta com LIMIT ... FOR UPDATE SKIP LOCKED)": nessa forma o
  // Postgres pode reavaliar a subconsulta e reivindicar mais que o lote (achado na Fase 5c, no
  // teste de duas réplicas do serviço Go).
  const { rows: pendentes } = await pgPool.query(
    `WITH lote AS (
       SELECT id FROM campaign_recipients
       WHERE campaign_id = $1 AND status = 'pending' AND lote IS NOT NULL
       ORDER BY id ASC LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE campaign_recipients c SET status = 'queued', queued_at = now(), atualizado_em = now()
       FROM lote
      WHERE c.id = lote.id
     RETURNING c.*`,
    [campanhaId, CAMPANHA_LOTE_TAMANHO]
  );

  if (!pendentes.length) {
    const { rows: restantes } = await pgPool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending', 'queued') AND lote IS NOT NULL) AS liberados,
         COUNT(*) FILTER (WHERE status = 'pending' AND lote IS NULL) AS aguardando
       FROM campaign_recipients WHERE campaign_id = $1`,
      [campanhaId]
    );
    const liberados = Number(restantes[0].liberados);
    const aguardando = Number(restantes[0].aguardando);
    if (liberados === 0 && aguardando === 0) {
      await pgPool.query(
        `UPDATE campaigns SET status = 'completed', finalizada_em = now(), atualizado_em = now() WHERE id = $1 AND status IN ('preparing', 'sending')`,
        [campanhaId]
      );
    } else if (liberados === 0) {
      // Lote liberado terminou e ainda tem gente aguardando — para aqui até o admin liberar o próximo.
      await pgPool.query(
        `UPDATE campaigns SET status = 'paused', atualizado_em = now() WHERE id = $1 AND status IN ('preparing', 'sending')`,
        [campanhaId]
      );
    }
    return;
  }

  await pgPool.query(`UPDATE campaigns SET status = 'sending', atualizado_em = now() WHERE id = $1 AND status = 'preparing'`, [campanhaId]);

  const { rows: campanhaRows } = await pgPool.query(`SELECT ${CAMPAIGN_SELECT_COLS} FROM campaigns WHERE id = $1`, [campanhaId]);
  const campanha = campanhaRows[0];
  const def = campanha.audience_definition || {};
  const { provider } = await readWhatsappProviderConfig();
  // Campanha iniciada no modo Web já tem o texto congelado — não precisa (nem pode depender) da
  // Meta. Sem texto congelado (campanha iniciada pela API), segue buscando o template como antes.
  const corpoWeb = provider === 'whatsapp_web' ? campanha.mensagem_web_corpo : null;

  let templateMeta = null;
  let headerTipo = 'TEXT';
  if (!corpoWeb) try {
    const resultadoTemplates = await whatsappRequest('GET', '/templates/list');
    const lista = (resultadoTemplates.data && resultadoTemplates.data.data) || [];
    templateMeta = lista.find((t) => t.name === campanha.template_nome) || null;
    const configs = await readTemplateConfigs();
    headerTipo = (configs[campanha.template_nome] && configs[campanha.template_nome].headerTipo) || 'TEXT';
  } catch (err) {
    console.error(`[CAMPANHAS_FILA] falha ao buscar template "${campanha.template_nome}" da campanha ${campanhaId}: ${err.message}`);
  }
  if (!corpoWeb && !templateMeta) {
    // Template sumiu/foi rejeitado depois do agendamento — devolve o lote pra 'pending' (não é
    // culpa do destinatário) e não insiste nesse tick; um admin precisa intervir na campanha.
    await pgPool.query(
      `UPDATE campaign_recipients SET status = 'pending', queued_at = NULL, atualizado_em = now() WHERE id = ANY($1::bigint[])`,
      [pendentes.map((p) => p.id)]
    );
    return;
  }

  const mediaLink = corpoWeb ? null : await linkPublicoMedia(def.mediaAssetId);

  for (const destinatario of pendentes) {
    const to = formatarTelefoneWhatsapp(destinatario.telefone);
    if (!to) {
      await pgPool.query(
        `UPDATE campaign_recipients SET status = 'failed', failed_at = now(), failure_code = 'telefone_invalido', failure_message = $1, atualizado_em = now() WHERE id = $2`,
        ['telefone inválido ou ausente', destinatario.id]
      );
      continue;
    }
    if (provider === 'whatsapp_web') {
      // Modo Web: o destinatário fica em 'queued' até o agente reportar (resultado atualiza
      // campaign_recipients). Ritmo, teto diário e "campanha só abaixo do recomendado" ficam no
      // claim — aqui só enfileira.
      try {
        const versao = corpoWeb ? sortearVersaoMensagemWeb(corpoWeb, campanha.mensagem_web_variacoes) : null;
        const { texto, midiaIgnorada } = versao
          ? { texto: renderizarMensagemWeb(versao.corpo, destinatario.resolved_variables || {}).trim(), midiaIgnorada: false }
          : renderizarTextoCampanhaWeb(templateMeta, destinatario.resolved_variables);
        if (!texto) throw new Error('mensagem ficou vazia depois de trocar as variáveis');
        await enfileirarWhatsappWeb({
          origem: 'campanha', referencia: `${campanhaId}:${destinatario.id}`, campaignRecipientId: destinatario.id,
          to, nome: destinatario.nome, template: corpoWeb ? campanha.mensagem_web_nome : campanha.template_nome, texto, midiaIgnorada, status: 'pending',
          variacao: versao ? versao.variacao : null,
        });
      } catch (err) {
        console.error(`[CAMPANHAS_FILA] falha ao enfileirar no WhatsApp Web a campanha ${campanhaId}, destinatário ${destinatario.id}: ${err.message}`);
        await pgPool.query(
          `UPDATE campaign_recipients SET status = 'failed', failed_at = now(), failure_code = 'render_web', failure_message = $1, atualizado_em = now() WHERE id = $2`,
          [String(err.message).slice(0, 500), destinatario.id]
        );
      }
      continue;
    }
    try {
      const components = montarComponentesEnvioCampanha(templateMeta, headerTipo, mediaLink, def.sampleLocation, destinatario.resolved_variables);
      const resultado = await whatsappRequest('POST', '/send/template', {
        to, template: campanha.template_nome, language: templateMeta.language || 'pt_BR', components,
      });
      const wamid = (resultado.data && resultado.data.messages && resultado.data.messages[0] && resultado.data.messages[0].id) || null;
      await pgPool.query(
        `UPDATE campaign_recipients SET status = 'sent', sent_at = now(), provider_message_id = $1, atualizado_em = now() WHERE id = $2`,
        [wamid, destinatario.id]
      );
    } catch (err) {
      console.error(`[CAMPANHAS_FILA] falha ao enviar campanha ${campanhaId} pro destinatário ${destinatario.id}: ${err.message}`);
      await pgPool.query(
        `UPDATE campaign_recipients SET status = 'failed', failed_at = now(), failure_code = $1, failure_message = $2, atualizado_em = now() WHERE id = $3`,
        [err.status ? String(err.status) : null, String(err.message).slice(0, 500), destinatario.id]
      );
    }
  }
}

// Destinatário que ficou em 'queued' (processo morreu/reiniciou no meio do lote) nunca mais seria
// pego pela fila e travaria a campanha pra sempre. Não dá pra saber se a Meta chegou a receber o
// envio antes da queda, então NÃO volta pra 'pending' (poderia mandar 2x) — marca como falha
// explícita. Um lote de 10 leva no máximo ~3 min mesmo com timeout em todos, 15 min é folga.
// Exceção: destinatário com item vivo na fila do WhatsApp Web está legitimamente esperando o
// agente (pode levar horas, teto diário, janela) — não é travamento.
const CAMPANHA_QUEUED_TRAVADO_MIN = 15;

async function recuperarDestinatariosTravados() {
  const { rowCount } = await pgPool.query(
    `UPDATE campaign_recipients SET status = 'failed', failed_at = now(), failure_code = 'interrompido',
       failure_message = 'envio interrompido no meio (ex.: reinício do servidor) — não reenviado automaticamente pra evitar mensagem duplicada',
       atualizado_em = now()
     WHERE status = 'queued' AND queued_at < now() - make_interval(mins => $1)
       AND NOT EXISTS (
         SELECT 1 FROM whatsapp_web_outbox o
          WHERE o.campaign_recipient_id = campaign_recipients.id
            AND o.status IN ('aguardando_aprovacao', 'pending', 'claimed')
       )`,
    [CAMPANHA_QUEUED_TRAVADO_MIN]
  );
  if (rowCount) console.warn(`[CAMPANHAS_FILA] ${rowCount} destinatário(s) travado(s) em 'queued' marcado(s) como falha (interrompido)`);
}

async function processarFilaDeCampanhas() {
  if (!pgPool) return;
  await recuperarDestinatariosTravados();
  if (!(await dentroDaJanelaDeEnvio())) return; // mesma janela das automações — nada de Marketing de madrugada.

  await iniciarCampanhasAgendadasVencidas();

  // 1 campanha em envio por tick (a mais antiga a iniciar primeiro) — evita paralelizar chamadas
  // à Meta de campanhas diferentes competindo pelo mesmo rate limit.
  const { rows } = await pgPool.query(
    `SELECT id FROM campaigns WHERE status IN ('preparing', 'sending') ORDER BY iniciada_em ASC NULLS LAST LIMIT 1`
  );
  if (!rows.length) return;
  const campanhaId = rows[0].id;
  if (campanhasEmProcessamento.has(campanhaId)) return;
  campanhasEmProcessamento.add(campanhaId);
  try {
    await processarLoteCampanha(campanhaId);
  } finally {
    campanhasEmProcessamento.delete(campanhaId);
  }
}

const CAMPANHA_FILA_INTERVAL_MS = 30 * 1000;
JOBS.agendar('campanhas-fila', CAMPANHA_FILA_INTERVAL_MS, () => processarFilaDeCampanhas());

// ── Job de associação em massa de categorias ────────────────────────────
// Mesmo padrão dos outros jobs deste arquivo (setInterval + guard em memória contra 2 ticks
// processando o mesmo job em paralelo). Concorrência conservadora (3 chamadas Ink por vez,
// dentro de um lote pequeno por tick) — spec pede começar assim e só aumentar se a API mostrar
// estabilidade; não há necessidade disso ainda.
const bulkCatJobsEmProcessamento = new Set();
const BULKCAT_LOTE_TAMANHO = 15;
const BULKCAT_CONCORRENCIA = 3;

async function atualizarContadoresBulkCategoryJob(jobId) {
  await pgPool.query(
    `UPDATE bulk_category_jobs SET
       processed = (SELECT count(*) FILTER (WHERE status IN ('success','failed','skipped')) FROM bulk_category_job_items WHERE job_id = $1),
       succeeded = (SELECT count(*) FILTER (WHERE status = 'success') FROM bulk_category_job_items WHERE job_id = $1),
       failed = (SELECT count(*) FILTER (WHERE status = 'failed') FROM bulk_category_job_items WHERE job_id = $1),
       skipped = (SELECT count(*) FILTER (WHERE status = 'skipped') FROM bulk_category_job_items WHERE job_id = $1),
       atualizado_em = now()
     WHERE id = $1`,
    [jobId]
  );
}

// ── Atualização de categoria pelo lado do PRODUTO (revertido, 2026-09-09) ───────────────────
// Passamos por 2 hipóteses erradas antes desta: (1) workaround de agrupamento de estampa
// (product_cluster) — removido, não era a causa; (2) atualizar pelo lado da CATEGORIA
// (`PATCH /v1/stores/collections/{id}`, agregado em lote) — funcionava, mas trazia de volta o
// limite de 100 produtos por `product_ids` da Ink pra categorias grandes, e era bem mais
// complexo. Causa raiz real, resolvida na ORIGEM (não contornada): o produto tinha categoria(s)
// ANTIGA(s) (pré-migração) que iam ser excluídas de qualquer forma como parte da limpeza do
// catálogo. Excluindo essas categorias antigas primeiro (ver "Excluir selecionadas" em
// Categorias), o PATCH simples `/v1/stores/products/{id}` com `collections: [alvo]` volta a
// funcionar normal — sem precisar de nenhum contorno em tempo de execução.
async function processarItemBulkCategoryJob(job, item, indiceCollections) {
  // Execução da migração (Parte 6) grava categoria_ids_alvo POR ITEM — quando presente, o modo
  // efetivo pra esse item é sempre 'replace' (é sempre o snapshot já calculado na simulação),
  // mesmo que o job em si tenha sido criado com mode='replace' e category_ids=[] só de fachada.
  const categoryIds = item.categoria_ids_alvo != null ? item.categoria_ids_alvo : job.category_ids;
  const modoEfetivo = item.categoria_ids_alvo != null ? 'replace' : job.mode;
  try {
    let before = null;
    let after;
    if (modoEfetivo === 'add') {
      // item.product_id vem do Postgres como STRING (coluna BIGINT, node-pg não converte pra
      // evitar perda de precisão) — indiceCollections é chaveado por NÚMERO (ids vêm crus do JSON
      // da Ink). Sem o Number() aqui, Map.get() nunca batia, atuaisSet vinha SEMPRE vazio (bug
      // real, 2026-09-11): no modo 'add' isso fazia a soma virar só a categoria nova, perdendo
      // tudo que o produto já tinha (o 'replace' não sofria o mesmo efeito porque `after` ali vem
      // pronto de fora, não depende de atuaisSet pra decidir o resultado final).
      const atuaisSet = indiceCollections.get(Number(item.product_id)) || new Set();
      before = Array.from(atuaisSet);
      // Transferência (categoria_ids_remover, só existe no modo 'add') — tira essas categorias
      // antes de somar as novas, no mesmo PATCH (não precisa de um 'replace' pra "trocar de lugar").
      const removerSet = new Set(job.category_ids_remover || []);
      const novoSet = new Set([...atuaisSet].filter((id) => !removerSet.has(id)));
      for (const id of categoryIds) novoSet.add(id);
      if (setsIguais(atuaisSet, novoSet)) {
        await pgPool.query(
          `UPDATE bulk_category_job_items SET status = 'skipped', categories_before = $1::jsonb, categories_after = $1::jsonb, attempts = attempts + 1, atualizado_em = now() WHERE id = $2`,
          [JSON.stringify(before), item.id]
        );
        return;
      }
      after = Array.from(novoSet);
    } else {
      // Otimização (pedido do usuário, 2026-09-10): re-simular o catálogo inteiro reclassifica
      // produtos de cidade que já estão corretos desde a execução anterior — sem isso, toda
      // execução nova reenviaria PATCH pra ~85 mil produtos de novo, mesmo pros que não mudam
      // nada. Pula (sem chamar a Ink) quando o conjunto final já é IGUAL ao atual — mesmo
      // princípio que o modo 'add' já usa, só que aplicado ao 'replace' também.
      // item.product_id vem do Postgres como STRING (coluna BIGINT, node-pg não converte pra
      // evitar perda de precisão) — indiceCollections é chaveado por NÚMERO (ids vêm crus do JSON
      // da Ink). Sem o Number() aqui, Map.get() nunca batia, atuaisSet vinha SEMPRE vazio (bug
      // real, 2026-09-11): no modo 'add' isso fazia a soma virar só a categoria nova, perdendo
      // tudo que o produto já tinha (o 'replace' não sofria o mesmo efeito porque `after` ali vem
      // pronto de fora, não depende de atuaisSet pra decidir o resultado final).
      const atuaisSet = indiceCollections.get(Number(item.product_id)) || new Set();
      before = Array.from(atuaisSet);
      const alvoSet = new Set(categoryIds);
      if (setsIguais(atuaisSet, alvoSet)) {
        await pgPool.query(
          `UPDATE bulk_category_job_items SET status = 'skipped', categories_before = $1::jsonb, categories_after = $2::jsonb, attempts = attempts + 1, atualizado_em = now() WHERE id = $3`,
          [JSON.stringify(before), JSON.stringify(categoryIds), item.id]
        );
        return;
      }
      after = categoryIds;
    }

    // Chave inclui `attempts` — cada tentativa nova (via retry-failed) ganha uma chave diferente
    // de verdade, nunca reenvia a mesma pra Ink (bug real corrigido numa sessão anterior).
    await comRetryInk(() => inkApiPatchDaStore(
      `/v1/stores/products/${item.product_id}`, { collections: after },
      { 'Idempotency-Key': `bulkcat:${job.id}:${item.product_id}:${item.attempts}` }
    ));
    await pgPool.query(
      `UPDATE bulk_category_job_items SET status = 'success', categories_before = $1::jsonb, categories_after = $2::jsonb, attempts = attempts + 1, atualizado_em = now() WHERE id = $3`,
      [before != null ? JSON.stringify(before) : null, JSON.stringify(after), item.id]
    );
  } catch (err) {
    // err.details é o corpo bruto da resposta de erro da Ink — sem isso só sobra a frase genérica
    // ("Falha ao atualizar o produto"), impossível de debugar.
    console.error(
      `[BULK_CATEGORY] falha ao atualizar produto ${item.product_id} (job ${job.id}): ${err.message}` +
      (err.status ? ` [status ${err.status}]` : '') +
      (err.details ? ` — resposta da Ink: ${JSON.stringify(err.details).slice(0, 1000)}` : '')
    );
    const detalhe = err.details ? ` — ${JSON.stringify(err.details)}` : '';
    await pgPool.query(
      `UPDATE bulk_category_job_items SET status = 'failed', attempts = attempts + 1, error = $1, atualizado_em = now() WHERE id = $2`,
      [`${String(err.message)}${detalhe}`.slice(0, 500), item.id]
    );
  }
}

async function processarLoteBulkCategoryJob(job) {
  const { rows: pendentes } = await pgPool.query(
    `UPDATE bulk_category_job_items SET status = 'running', atualizado_em = now()
     WHERE id IN (
       SELECT id FROM bulk_category_job_items
       WHERE job_id = $1 AND status = 'pending'
       ORDER BY id ASC LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [job.id, BULKCAT_LOTE_TAMANHO]
  );

  if (!pendentes.length) {
    const { rows: restantes } = await pgPool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'running')) AS pendentes FROM bulk_category_job_items WHERE job_id = $1`,
      [job.id]
    );
    if (Number(restantes[0].pendentes) === 0) {
      const { rows: falhas } = await pgPool.query(`SELECT COUNT(*) AS n FROM bulk_category_job_items WHERE job_id = $1 AND status = 'failed'`, [job.id]);
      const statusFinal = Number(falhas[0].n) > 0 ? 'completed_with_errors' : 'completed';
      await pgPool.query(
        `UPDATE bulk_category_jobs SET status = $1, finalizado_em = now(), atualizado_em = now() WHERE id = $2 AND status IN ('queued', 'running')`,
        [statusFinal, job.id]
      );
      // Se esse job veio de uma execução de "Migração Use Origens", fecha a simulação também.
      await pgPool.query(
        `UPDATE origens_migration_simulations SET status = 'executada', executada_em = now() WHERE job_id = $1 AND status = 'executando'`,
        [job.id]
      );
    }
    return;
  }

  await pgPool.query(`UPDATE bulk_category_jobs SET status = 'running', atualizado_em = now() WHERE id = $1 AND status = 'queued'`, [job.id]);

  const { indice: indiceCollections } = await buildCollectionsIndex(job.loja);
  for (let i = 0; i < pendentes.length; i += BULKCAT_CONCORRENCIA) {
    const chunk = pendentes.slice(i, i + BULKCAT_CONCORRENCIA);
    await Promise.all(chunk.map((item) => processarItemBulkCategoryJob(job, item, indiceCollections)));
  }
  await atualizarContadoresBulkCategoryJob(job.id);
}

// Rede de segurança contra deploy no meio do processamento (pergunta real do usuário,
// 2026-09-09): um item fica 'running' só durante a janela entre o UPDATE que o marca e o PATCH
// de verdade terminar — se o processo Node reiniciar bem nesse meio (redeploy do Railway), o item
// fica 'running' pra sempre, já que só itens 'pending' são pegos de novo. Qualquer item 'running'
// há mais de 5 minutos é sinal de que o processo anterior morreu no meio dele — nunca fica preso
// tanto tempo assim num PATCH normal (timeout da Ink já é bem menor). Roda 1x por ciclo, antes de
// processar o próximo lote.
async function resetarItensRunningOrfaos() {
  const { rows } = await pgPool.query(
    `UPDATE bulk_category_job_items SET status = 'pending', atualizado_em = now()
     WHERE status = 'running' AND atualizado_em < now() - interval '5 minutes'
     RETURNING id`
  );
  if (rows.length) console.warn(`[BULK_CATEGORY] ${rows.length} item(ns) 'running' órfão(s) (provavelmente de um restart no meio) resetado(s) pra 'pending'`);
}

async function processarBulkCategoryJobs() {
  if (!pgPool) return;
  await resetarItensRunningOrfaos();
  const { rows } = await pgPool.query(
    `SELECT id, loja, mode, category_ids, category_ids_remover FROM bulk_category_jobs WHERE status IN ('queued', 'running') ORDER BY criado_em ASC LIMIT 1`
  );
  if (!rows.length) return;
  const job = rows[0];
  if (bulkCatJobsEmProcessamento.has(job.id)) return;
  bulkCatJobsEmProcessamento.add(job.id);
  try {
    await processarLoteBulkCategoryJob(job);
  } finally {
    bulkCatJobsEmProcessamento.delete(job.id);
  }
}

const BULKCAT_FILA_INTERVAL_MS = 15 * 1000;
JOBS.agendar('bulk-category', BULKCAT_FILA_INTERVAL_MS, () => processarBulkCategoryJobs());

const CARRINHO_FOLLOWUP_INTERVAL_MS = 15 * 60 * 1000;
JOBS.agendar('followup-carrinho', CARRINHO_FOLLOWUP_INTERVAL_MS, () => processarFollowUpsCarrinho());
JOBS.agendar('pix-pendentes', CARRINHO_FOLLOWUP_INTERVAL_MS, () => registrarPixPendentesFaltantes());
JOBS.agendar('followup-pix', CARRINHO_FOLLOWUP_INTERVAL_MS, () => processarFollowUpsPix());
JOBS.agendar('fila-janela', CARRINHO_FOLLOWUP_INTERVAL_MS, () => processarFilaDeJanela());
JOBS.agendar('controle-estoque', CARRINHO_FOLLOWUP_INTERVAL_MS, () => sincronizarControleEstoqueDaOrganizacao());
JOBS.agendar('produtos-feed', PRODUTOS_FEED_INTERVAL_MS, () => sincronizarProdutosFeedDaOrganizacao());
// Tick de hora em hora com o guard de "vencidos": o crawl real só roda quando passou
// o intervalo configurado da loja desde o último que concluiu (e nunca se ela estiver pausada). Assim uma varredura que falhou no meio
// é retentada na hora seguinte, em vez de esperar o ciclo inteiro.
JOBS.agendar('catalogo-ink', 60 * 60 * 1000, () => sincronizarCatalogoInkDaOrganizacao({ apenasVencidos: true }));
// No boot só baixa se o cache estiver vencido/vazio — senão todo deploy puxaria ~27 MB por loja à toa.
JOBS.agendarUmaVez('produtos-feed-boot', 60 * 1000, () => sincronizarProdutosFeedDaOrganizacao({ apenasVencidos: true }));
// 5 min depois do boot, e só se estiver vencido — o crawl são centenas de requests à Ink e não
// pode competir com a subida do processo nem repetir a cada restart de deploy.
JOBS.agendarUmaVez('catalogo-ink-boot', 5 * 60 * 1000, () => sincronizarCatalogoInkDaOrganizacao({ apenasVencidos: true }));
JOBS.agendar('carrinhos-persistencia', CARRINHO_FOLLOWUP_INTERVAL_MS, () => persistirCarrinhosAbandonadosDaOrganizacao());
// Rodada inicial logo após o boot (antes era chamada direta, sem escopo).
JOBS.agendarUmaVez('boot-redes-de-seguranca', 5 * 1000, async () => {
  await sincronizarControleEstoqueDaOrganizacao();
  await registrarPixPendentesFaltantes();
  await persistirCarrinhosAbandonadosDaOrganizacao();
});

// ── WhatsApp — Visão geral (Fase 7, ver docs/plan.md) ───────────────────
// Conectividade real via GET /health do whatsapp-webhook-go — só confirma que o serviço está de
// pé. O número exibido é o da integração da Organization (Fase 5b): o serviço não tem número
// próprio e nada do /health dele é lido como identidade. Não existe "quality rating" disponível
// hoje, então essa métrica não aparece aqui em vez de ser inventada.
// KPIs de mensagem vêm de /dashboard/events (contadores em memória do próprio serviço Go —
// só sent/received/errors existem; a Meta não nos avisa "entregue"/"lido" separadamente hoje,
// então não existe esse detalhamento, ver docs/plan.md).
app.get('/api/admin/whatsapp/visao-geral', requireAdmin, async (req, res) => {
  const [healthResult, eventsResult, templatesResult] = await Promise.allSettled([
    whatsappRequest('GET', '/health'),
    whatsappRequest('GET', '/dashboard/events'),
    whatsappRequest('GET', '/templates/list'),
  ]);

  const connected = healthResult.status === 'fulfilled' && healthResult.value.status === 'ok';
  let phoneNumberId = null;
  try {
    phoneNumberId = (await remetenteWhatsappParaTela()).phoneNumberId;
  } catch (err) {
    console.error(`[WHATSAPP_VISAO_GERAL] falha ao ler o número da organization: ${err.message}`);
  }

  const stats = eventsResult.status === 'fulfilled'
    ? eventsResult.value.stats || { sent: 0, received: 0, errors: 0 }
    : { sent: 0, received: 0, errors: 0 };
  const pendingQueue = eventsResult.status === 'fulfilled' ? (eventsResult.value.pending || 0) : 0;

  let templatesAprovados = null;
  if (templatesResult.status === 'fulfilled') {
    const lista = (templatesResult.value.data && templatesResult.value.data.data) || [];
    templatesAprovados = lista.filter((t) => t.status === 'APPROVED').length;
  }

  let automacoesAtivas = 0;
  try {
    const [eventos, { provider }] = await Promise.all([readAutomacaoEventos(), readWhatsappProviderConfig()]);
    Object.values(eventos).forEach((porLoja) => {
      Object.values(porLoja).forEach((cfg) => { if (vinculoConfigurado(cfg, provider)) automacoesAtivas += 1; });
    });
  } catch (err) {
    console.error(`[WHATSAPP_VISAO_GERAL] falha ao ler automações: ${err.message}`);
  }

  res.json({
    connected,
    phoneNumberId,
    stats,
    pendingQueue,
    templatesAprovados,
    automacoesAtivas,
    servicoIndisponivel: !connected,
  });
});

// ── Mídia (amostra de template, biblioteca de campanha — Fase 2 do plano de Campanhas) ──
function kindDoMime(mimeType) {
  if (HEADER_MIME_PERMITIDO.IMAGE.includes(mimeType)) return 'image';
  if (HEADER_MIME_PERMITIDO.VIDEO.includes(mimeType)) return 'video';
  if (HEADER_MIME_PERMITIDO.DOCUMENT.includes(mimeType)) return 'document';
  return null;
}

// Envia o arquivo pro serviço Go (com o token da Organization no remetente) fazer o resumable upload da Meta
// e devolver o handle — nunca chamamos a Graph API direto daqui. Base64 dentro do JSON que
// whatsappRequest já usa (express.json limit:100mb comporta), consistente com o resto da
// integração — não vale montar um segundo caminho binário só pra isso.
async function whatsappUploadHandleRequest(buffer, mimeType, filename) {
  // ID do app da Meta vem da tela de Integrações; sem ele, o serviço Go usa o META_APP_ID do ambiente.
  const { appId } = await readWhatsappMetaApp();
  const resultado = await whatsappRequest('POST', '/media/upload', {
    filename,
    mimeType,
    dataBase64: buffer.toString('base64'),
    ...(appId ? { appId } : {}),
  });
  return resultado.data && resultado.data.handle;
}

// Corpo em base64 dentro do JSON, não multipart — mesmo padrão já usado pra arte de produto
// (comentário do limite de 100mb do express.json, acima: "artes de produto chegam em base64").
// Consistente com o resto do app; evita introduzir uma 2ª forma de subir arquivo no projeto.
app.post('/api/admin/media', requireAdmin, async (req, res) => {
  const { filename, mimeType, dataBase64 } = req.body || {};
  const loja = lojaLegadaDoContextoOuNula();
  if (!filename || !mimeType || !dataBase64) return res.status(400).json({ error: 'filename, mimeType e dataBase64 são obrigatórios' });
  if (!pgPool) return res.status(503).json({ error: 'mídia exige Postgres configurado' });

  const kind = kindDoMime(mimeType);
  if (!kind) return res.status(400).json({ error: `tipo de arquivo não suportado (${mimeType}) — a Meta só aceita ${Object.values(HEADER_MIME_PERMITIDO).flat().join(', ')}` });

  let buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'dataBase64 inválido' });
  }
  const limite = HEADER_TAMANHO_MAXIMO[kind.toUpperCase()];
  if (buffer.length > limite) return res.status(400).json({ error: `arquivo excede o limite de ${Math.round(limite / 1024 / 1024)}MB pra ${kind}` });

  // Nome sanitizado + aleatório — nunca o nome original cru no disco (path traversal / colisão).
  const extensao = path.extname(String(filename)).toLowerCase().replace(/[^a-z0-9.]/g, '') || '';
  const storageKey = `${crypto.randomBytes(16).toString('hex')}${extensao}`;

  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, storageKey), buffer);
  } catch (writeErr) {
    console.error(`[MEDIA] falha ao gravar arquivo: ${writeErr.message}`);
    return res.status(500).json({ error: 'falha no storage' });
  }

  let handle = null;
  try {
    handle = await whatsappUploadHandleRequest(buffer, mimeType, filename);
  } catch (uploadErr) {
    console.error(`[MEDIA] falha no upload pra Meta: ${uploadErr.message}`);
    // Guarda o arquivo mesmo assim (fica com meta_upload_handle nulo) — dá pra tentar de novo
    // sem pedir pro admin re-selecionar o arquivo; só não pode ser usado num template ainda.
  }

  try {
    const publicToken = crypto.randomBytes(24).toString('hex');
    const { rows } = await pgPool.query(
      `INSERT INTO media_assets (loja, kind, filename, original_filename, mime_type, size_bytes, storage_key, meta_upload_handle, created_by, public_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, loja, kind, filename, original_filename, mime_type, size_bytes, meta_upload_handle, created_at`,
      [loja || null, kind, storageKey, filename, mimeType, buffer.length, storageKey, handle, 'admin', publicToken]
    );
    const asset = rows[0];
    res.json({
      ok: true,
      asset: {
        id: asset.id, loja: asset.loja, kind: asset.kind, filename: asset.original_filename,
        mimeType: asset.mime_type, sizeBytes: Number(asset.size_bytes),
        metaHandlePronto: !!asset.meta_upload_handle, criadoEm: asset.created_at,
        previewUrl: `/api/admin/media/${asset.id}/arquivo`,
      },
      avisoMeta: handle ? null : 'arquivo salvo, mas o upload pra Meta falhou — tente de novo antes de usar num template',
    });
  } catch (dbErr) {
    console.error(`[MEDIA] falha ao gravar media_assets: ${dbErr.message}`);
    res.status(500).json({ error: 'não foi possível registrar a mídia' });
  }
});

app.get('/api/admin/media', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ assets: [] });
  const { kind } = req.query;
  const loja = lojaLegadaDoContextoOuNula();
  const condicoes = [];
  const params = [];
  if (loja) { params.push(loja); condicoes.push(`loja = $${params.length}`); }
  if (kind) { params.push(kind); condicoes.push(`kind = $${params.length}`); }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const { rows } = await pgPool.query(
    `SELECT id, loja, kind, original_filename, mime_type, size_bytes, meta_upload_handle, created_at
     FROM media_assets ${where} ORDER BY created_at DESC LIMIT 50`,
    params
  );
  res.json({
    assets: rows.map((a) => ({
      id: a.id, loja: a.loja, kind: a.kind, filename: a.original_filename, mimeType: a.mime_type,
      sizeBytes: Number(a.size_bytes), metaHandlePronto: !!a.meta_upload_handle, criadoEm: a.created_at,
      previewUrl: `/api/admin/media/${a.id}/arquivo`,
    })),
  });
});

app.get('/api/admin/media/:id/arquivo', requireAdmin, exigirRecurso('media_assets'), async (req, res) => {
  if (!pgPool) return res.status(404).end();
  const { rows } = await pgPool.query('SELECT storage_key, mime_type, original_filename FROM media_assets WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).end();
  const caminho = path.join(UPLOADS_DIR, rows[0].storage_key);
  if (!fs.existsSync(caminho)) return res.status(404).end();
  res.setHeader('Content-Type', rows[0].mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].original_filename.replace(/"/g, '')}"`);
  fs.createReadStream(caminho).pipe(res);
});

// Rota pública (sem sessão admin) usada pela Meta pra baixar a mídia REAL de envio de campanha
// (spec, Parte 35/36: "link" apontando pra uma URL pública — o whatsapp-webhook-go não tem
// endpoint de upload que devolva media_id, então o envio usa `link`). Por token opaco e aleatório
// (public_token), nunca pelo id sequencial — evita enumeração de toda a biblioteca de mídia.
//
// HEADS UP (decisão consciente, revisar no futuro se virar problema real): o link não expira e
// não é revogável — enquanto o media_asset existir, quem tiver o token acessa o arquivo pra
// sempre, sem login. Aceitável hoje porque é sempre imagem/vídeo/documento de marketing (nunca
// dado pessoal de cliente) e o token não é enumerável. Se um dia isso precisar de TTL/revogação
// (ex: mídia sensível, ou trocar de token por segurança), dá pra adicionar uma coluna
// `public_token_expira_em` e checar aqui antes de servir o arquivo.
app.get('/midia/:token/arquivo', async (req, res) => {
  if (!pgPool) return res.status(404).end();
  let rows;
  try {
    const token = String(req.params.token);
    const dona = await organizacaoPorResolvedor('publico_organization_da_midia', token);
    if (!dona) return res.status(404).end();
    ({ rows } = await comOrganizacaoResolvida(dona, 'publico:midia', () => pgPool.query(
      'SELECT storage_key, mime_type, original_filename FROM media_assets WHERE public_token = $1 AND organization_id = $2',
      [token, dona]
    )));
  } catch (err) {
    console.error(`[MIDIA] falha ao resolver mídia pública: ${err.message}`);
    return res.status(404).end();
  }
  if (!rows.length) return res.status(404).end();
  const caminho = path.join(UPLOADS_DIR, rows[0].storage_key);
  if (!fs.existsSync(caminho)) return res.status(404).end();
  res.setHeader('Content-Type', rows[0].mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].original_filename.replace(/"/g, '')}"`);
  fs.createReadStream(caminho).pipe(res);
});

app.delete('/api/admin/media/:id', requireAdmin, exigirRecurso('media_assets'), async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mídia exige Postgres configurado' });
  // "Não estar em uso" hoje = não é a amostra ativa de nenhum template salvo (readTemplateConfigs).
  // Campanhas (Fase 3+) vão precisar entrar nessa checagem também quando existirem.
  const configs = await readTemplateConfigs();
  const emUso = Object.values(configs).some((c) => String(c.sampleMediaAssetId) === String(req.params.id));
  if (emUso) return res.status(409).json({ error: 'mídia em uso por um template — troque a amostra do template antes de remover' });

  const { rows } = await pgPool.query('SELECT storage_key FROM media_assets WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'mídia não encontrada' });
  await pgPool.query('DELETE FROM media_assets WHERE id = $1', [req.params.id]);
  try { fs.unlinkSync(path.join(UPLOADS_DIR, rows[0].storage_key)); } catch { /* já não existe, ok */ }
  res.json({ ok: true });
});

app.get('/api/admin/whatsapp-templates', requireAdmin, async (req, res) => {
  try {
    const resultado = await whatsappRequest('GET', '/templates/list');
    const meta = resultado.data || {};
    const configs = await readTemplateConfigs();
    const eventos = await readAutomacaoEventos();
    const vinculosPorTemplate = {};
    for (const loja of Object.keys(eventos)) {
      for (const ev of Object.keys(eventos[loja])) {
        const nomeTemplate = eventos[loja][ev].template;
        if (!nomeTemplate) continue; // vínculo só do modo WhatsApp Web
        if (!vinculosPorTemplate[nomeTemplate]) vinculosPorTemplate[nomeTemplate] = [];
        vinculosPorTemplate[nomeTemplate].push({ loja, evento: ev });
      }
    }
    const templates = (meta.data || []).map((t) => ({
      ...t,
      config: configs[t.name] || null,
      eventos: vinculosPorTemplate[t.name] || [],
    }));
    res.json({ templates });
  } catch (err) {
    console.error(`[WHATSAPP] falha ao listar templates: ${err.message}`);
    res.status(err.status || 502).json({ error: err.message, codigo: err.codigo || null });
  }
});

app.post('/api/admin/whatsapp-templates', requireAdmin, async (req, res) => {
  const erro = await validarNovoTemplateMeta(req.body);
  if (erro) return res.status(400).json({ error: erro });

  const { nome, categoria, idioma, headerTexto, headerVariavel, corpo, corpoVariaveis, footer, botoes, tipo, headerTipo, sampleMediaAssetId, sampleLocation } = req.body;
  const tipoHeaderNorm = headerTipo || 'TEXT';

  // O handle da amostra é resolvido aqui (não no upload) — a Meta pode invalidar um handle não
  // usado após um tempo, então busca fresco toda vez que o template é de fato criado.
  let sampleMediaHandle = null;
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(tipoHeaderNorm) && sampleMediaAssetId) {
    if (!pgPool) return res.status(503).json({ error: 'amostra de mídia exige Postgres configurado' });
    const { rows } = await pgPool.query('SELECT mime_type, storage_key FROM media_assets WHERE id = $1', [sampleMediaAssetId]);
    if (!rows.length) return res.status(400).json({ error: 'mídia de amostra não encontrada' });
    try {
      const caminho = path.join(UPLOADS_DIR, rows[0].storage_key);
      sampleMediaHandle = await whatsappUploadHandleRequest(fs.readFileSync(caminho), rows[0].mime_type, 'amostra');
    } catch (uploadErr) {
      console.error(`[WHATSAPP] falha ao resolver handle da amostra: ${uploadErr.message}`);
      return res.status(502).json({ error: 'não foi possível enviar a amostra de mídia pra Meta agora — tente de novo' });
    }
    if (!sampleMediaHandle) return res.status(502).json({ error: 'a Meta não devolveu um handle pra amostra de mídia' });
  }

  const components = construirComponentesCriacao({
    headerTexto: headerTexto || null,
    headerVariavel: headerVariavel || null,
    corpo: corpo.trim(),
    corpoVariaveis: corpoVariaveis || [],
    footer: footer || null,
    botoes: botoes || [],
    headerTipo: tipoHeaderNorm,
    sampleMediaHandle,
    sampleLocation: sampleLocation || null,
  });

  try {
    const resultado = await whatsappRequest('POST', '/templates/create', {
      name: nome,
      category: categoria,
      language: idioma || 'pt_BR',
      components,
    });

    // O vínculo evento→template é configurado depois em /admin/automacoes (pode ser feito ou
    // mudado a qualquer momento, sem precisar recriar o template) — aqui só guarda fatos
    // estruturais fixos desde a criação (tipo, posição do botão de link dinâmico).
    const indiceBotaoDinamico = (botoes || []).findIndex((b) => b.tipo === 'URL' && b.urlTipo === 'DINAMICO');
    const configs = await readTemplateConfigs();
    configs[nome] = {
      origem: 'painel',
      tipo,
      idioma: idioma || 'pt_BR',
      botaoDinamico: indiceBotaoDinamico !== -1 ? { indice: indiceBotaoDinamico } : null,
      headerTipo: tipoHeaderNorm,
      sampleMediaAssetId: sampleMediaAssetId || null,
      sampleLocation: sampleLocation || null,
      criadoEm: new Date().toISOString(),
    };
    await writeTemplateConfigs(configs);

    res.json({ ok: true, resultado: resultado.data });
  } catch (err) {
    console.error(`[WHATSAPP] falha ao criar template: ${err.message}`);
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.delete('/api/admin/whatsapp-templates/:nome', requireAdmin, async (req, res) => {
  try {
    await whatsappRequest('DELETE', `/templates/delete?name=${encodeURIComponent(req.params.nome)}`);
    const configs = await readTemplateConfigs();
    delete configs[req.params.nome];
    await writeTemplateConfigs(configs);
    // Remove também qualquer vínculo de automação que apontava pra esse template — senão fica
    // um evento configurado "fantasma" apontando pra um template que não existe mais.
    const eventos = await readAutomacaoEventos();
    let mudou = false;
    for (const loja of Object.keys(eventos)) {
      for (const ev of Object.keys(eventos[loja])) {
        if (eventos[loja][ev].template === req.params.nome) { removerVinculoDoModo(eventos[loja], ev, 'api'); mudou = true; }
      }
    }
    if (mudou) await writeAutomacaoEventos(eventos);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[WHATSAPP] falha ao excluir template: ${err.message}`);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Vincula/atualiza a amostra local (mídia ou localização) de um template que já existe na Meta
// mas não tem `sampleMediaAssetId`/`sampleLocation` salvos aqui — acontece com templates criados
// antes dessa config existir, ou direto no Gerenciador da Meta (fora do nosso painel). A Cloud
// API não deixa editar um template já criado, mas essa amostra é config NOSSA (usada só pra
// reconstruir o header no "enviar teste" e nos disparos automáticos, montarComponentesEnvio) —
// podemos atualizar à vontade, desde que o formato bata com o header real do template na Meta.
app.put('/api/admin/whatsapp-templates/:nome/amostra', requireAdmin, async (req, res) => {
  const { headerTipo, sampleMediaAssetId, sampleLocation } = req.body || {};
  if (!['IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(headerTipo)) {
    return res.status(400).json({ error: 'headerTipo deve ser IMAGE, VIDEO, DOCUMENT ou LOCATION' });
  }

  try {
    const resultado = await whatsappRequest('GET', '/templates/list');
    const meta = resultado.data || {};
    const t = (meta.data || []).find((x) => x.name === req.params.nome);
    if (!t) return res.status(404).json({ error: 'template não encontrado' });
    const headerComp = (t.components || []).find((c) => c.type === 'HEADER');
    if (!headerComp || headerComp.format !== headerTipo) {
      return res.status(400).json({ error: `o cabeçalho real desse template na Meta é ${headerComp ? headerComp.format : 'inexistente'}, não ${headerTipo}` });
    }

    let sampleMediaAssetIdValido = null;
    if (headerTipo !== 'LOCATION') {
      if (!sampleMediaAssetId) return res.status(400).json({ error: 'selecione um arquivo de amostra pro cabeçalho' });
      if (!pgPool) return res.status(503).json({ error: 'amostra de mídia exige Postgres configurado' });
      const { rows } = await pgPool.query('SELECT id FROM media_assets WHERE id = $1', [sampleMediaAssetId]);
      if (!rows.length) return res.status(400).json({ error: 'mídia de amostra não encontrada' });
      sampleMediaAssetIdValido = sampleMediaAssetId;
    } else {
      if (!sampleLocation || typeof sampleLocation.nome !== 'string' || !sampleLocation.nome.trim()) {
        return res.status(400).json({ error: 'amostra de localização precisa de nome/local' });
      }
      if (typeof sampleLocation.latitude !== 'number' || typeof sampleLocation.longitude !== 'number') {
        return res.status(400).json({ error: 'amostra de localização precisa de latitude/longitude' });
      }
    }

    const configs = await readTemplateConfigs();
    const existente = configs[req.params.nome] || { origem: 'vinculado', criadoEm: new Date().toISOString() };
    configs[req.params.nome] = {
      ...existente,
      headerTipo,
      sampleMediaAssetId: sampleMediaAssetIdValido,
      sampleLocation: headerTipo === 'LOCATION' ? sampleLocation : null,
    };
    await writeTemplateConfigs(configs);
    res.json({ ok: true, config: configs[req.params.nome] });
  } catch (err) {
    console.error(`[WHATSAPP] falha ao vincular amostra de ${req.params.nome}: ${err.message}`);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Envio de teste: sempre imediato (/send/template), independente do modo de envio configurado
// — é uma ação manual explícita. Preenche todo {{n}} com um texto de exemplo genérico (não
// depende de nenhum evento estar vinculado — só olha a estrutura real do template na Meta).
app.post('/api/admin/whatsapp-templates/:nome/test', requireAdmin, async (req, res) => {
  const to = formatarTelefoneWhatsapp(req.body && req.body.telefone);
  if (!to) return res.status(400).json({ error: 'telefone inválido' });

  // Valores reais por parâmetro são opcionais — quando não vêm (ou vêm em branco), cai pro
  // texto de exemplo de sempre, pra não travar quem só quer confirmar que o envio funciona.
  const valores = (req.body && req.body.valores) || {};
  const headerValor = typeof valores.header === 'string' && valores.header.trim() ? valores.header.trim() : null;
  const corpoValores = Array.isArray(valores.corpo) ? valores.corpo : [];
  const botaoValor = typeof valores.botao === 'string' && valores.botao.trim() ? valores.botao.trim() : null;

  try {
    const resultado = await whatsappRequest('GET', '/templates/list');
    const meta = resultado.data || {};
    const t = (meta.data || []).find((x) => x.name === req.params.nome);
    if (!t) return res.status(404).json({ error: 'template não encontrado' });

    const headerComp = (t.components || []).find((c) => c.type === 'HEADER');
    const corpo = (t.components || []).find((c) => c.type === 'BODY');
    const corpoTokens = extrairTokensVariaveis((corpo && corpo.text) || '');

    const components = [];
    // Cabeçalho de mídia (IMAGE/VIDEO/DOCUMENT) e LOCATION não têm {{n}} — mas a Meta EXIGE o
    // parâmetro do header em todo envio mesmo assim (o `example` usado na criação só serve pra
    // aprovação do template, não é reaproveitado no envio). Sem esse componente aqui, a Meta
    // rejeita com 132012 "Format mismatch... received UNKNOWN", que foi o bug original: este
    // endpoint só sabia montar header de TEXT.
    if (headerComp && (headerComp.format === 'IMAGE' || headerComp.format === 'VIDEO' || headerComp.format === 'DOCUMENT')) {
      const templateInfo = (await readTemplateConfigs())[req.params.nome] || {};
      const mediaLink = await linkPublicoMedia(templateInfo.sampleMediaAssetId);
      if (!mediaLink) {
        return res.status(400).json({ error: `este template tem cabeçalho de mídia (${headerComp.format.toLowerCase()}), mas não há amostra configurada localmente pra reenviar no teste` });
      }
      const tipoParam = headerComp.format.toLowerCase();
      components.push({ type: 'header', parameters: [{ type: tipoParam, [tipoParam]: { link: mediaLink } }] });
    } else if (headerComp && headerComp.format === 'LOCATION') {
      const templateInfo = (await readTemplateConfigs())[req.params.nome] || {};
      const loc = templateInfo.sampleLocation;
      if (!loc) {
        return res.status(400).json({ error: 'este template tem cabeçalho de localização, mas não há amostra configurada localmente pra reenviar no teste' });
      }
      components.push({
        type: 'header',
        parameters: [{
          type: 'location',
          location: { latitude: loc.latitude, longitude: loc.longitude, name: loc.nome || undefined, address: loc.endereco || undefined },
        }],
      });
    } else {
      const headerTokens = extrairTokensVariaveis((headerComp && headerComp.format === 'TEXT' && headerComp.text) || '');
      if (headerTokens.length > 0) components.push({ type: 'header', parameters: [construirParametroTexto(headerTokens[0], headerValor || 'Exemplo')] });
    }
    if (corpoTokens.length > 0) {
      components.push({
        type: 'body',
        parameters: corpoTokens.map((token, i) => {
          const valor = typeof corpoValores[i] === 'string' && corpoValores[i].trim() ? corpoValores[i].trim() : `Exemplo ${i + 1}`;
          return construirParametroTexto(token, valor);
        }),
      });
    }
    const botaoInfo = extrairBotaoDinamico(t.components);
    if (botaoInfo) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(botaoInfo.indice),
        parameters: [{ type: 'text', text: botaoValor || 'exemplo123' }],
      });
    }

    await whatsappRequest('POST', '/send/template', {
      to,
      template: req.params.nome,
      language: t.language || 'pt_BR',
      components: components.length ? components : undefined,
    });
  } catch (err) {
    console.error(`[WHATSAPP] falha no envio de teste: ${err.message}`);
    return res.status(err.status || 502).json({ error: err.message });
  }
  res.json({ ok: true });
});

// ── Campos personalizados (valor fixo por loja, ex: link do Instagram) ─
app.get('/api/admin/campos-customizados', requireAdmin, async (req, res) => {
  try {
    res.json({ campos: await readCamposCustomizados() });
  } catch (err) {
    console.error(`[CAMPOS_CUSTOM] falha ao ler: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler os campos personalizados' });
  }
});

const CAMPO_CUSTOM_CHAVE_RE = /^[a-z][a-z0-9_]{0,39}$/;

app.post('/api/admin/campos-customizados', requireAdmin, async (req, res) => {
  const { chave, label } = req.body || {};
  if (typeof chave !== 'string' || !CAMPO_CUSTOM_CHAVE_RE.test(chave)) {
    return res.status(400).json({ error: 'chave deve ter só letras minúsculas, números e "_", começando com letra' });
  }
  if (typeof label !== 'string' || !label.trim()) return res.status(400).json({ error: 'informe um nome pro campo' });

  try {
    const campos = await readCamposCustomizados();
    if (campos[chave]) return res.status(400).json({ error: 'já existe um campo com essa chave' });

    campos[chave] = { label: label.trim(), valores: {} };
    await writeCamposCustomizados(campos);
    res.json({ ok: true, chave, campo: campos[chave] });
  } catch (err) {
    console.error(`[CAMPOS_CUSTOM] falha ao criar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar o campo personalizado' });
  }
});

app.put('/api/admin/campos-customizados/:chave', requireAdmin, async (req, res) => {
  const { chave } = req.params;
  try {
    const campos = await readCamposCustomizados();
    if (!campos[chave]) return res.status(404).json({ error: 'campo não encontrado' });

    const { label, valores } = req.body || {};
    if (label !== undefined) {
      if (typeof label !== 'string' || !label.trim()) return res.status(400).json({ error: 'informe um nome pro campo' });
      campos[chave].label = label.trim();
    }
    if (valores !== undefined) {
      if (typeof valores !== 'object' || valores === null || Array.isArray(valores)) {
        return res.status(400).json({ error: 'valores inválidos' });
      }
      // Valor por loja: só a loja da Store da sessão pode ser escrita.
      for (const loja of Object.keys(valores)) {
        if (loja !== chaveDaStore()) return res.status(400).json({ error: 'só é possível editar o valor da sua loja', codigo: 'TENANT_SELECTOR_NOT_ALLOWED' });
      }
      campos[chave].valores = { ...campos[chave].valores, ...valores };
    }
    await writeCamposCustomizados(campos);
    res.json({ ok: true, campo: campos[chave] });
  } catch (err) {
    console.error(`[CAMPOS_CUSTOM] falha ao salvar: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar o campo personalizado' });
  }
});

app.delete('/api/admin/campos-customizados/:chave', requireAdmin, async (req, res) => {
  const { chave } = req.params;
  try {
    const campos = await readCamposCustomizados();
    delete campos[chave];
    await writeCamposCustomizados(campos);

    // Remove também qualquer vínculo (evento ou template legado) que usava esse campo — senão
    // fica uma variável "fantasma" configurada que não existe mais.
    const chaveCompleta = `custom.${chave}`;
    const eventos = await readAutomacaoEventos();
    let mudou = false;
    for (const loja of Object.keys(eventos)) {
      for (const ev of Object.keys(eventos[loja])) {
        const cfg = eventos[loja][ev];
        if (cfg.headerVariavel === chaveCompleta) { cfg.headerVariavel = null; mudou = true; }
        if (Array.isArray(cfg.corpoVariaveis) && cfg.corpoVariaveis.includes(chaveCompleta)) {
          cfg.corpoVariaveis = cfg.corpoVariaveis.map((v) => (v === chaveCompleta ? null : v));
          mudou = true;
        }
        if (cfg.botaoVariavel === chaveCompleta) { cfg.botaoVariavel = null; mudou = true; }
      }
    }
    if (mudou) await writeAutomacaoEventos(eventos);

    res.json({ ok: true });
  } catch (err) {
    console.error(`[CAMPOS_CUSTOM] falha ao excluir: ${err.message}`);
    res.status(500).json({ error: 'não foi possível excluir o campo personalizado' });
  }
});

// ── Vínculo evento→template (Status x Template) ────────────────────────
// Dono único da automação: qual template dispara quando um evento chega, com que variáveis, e —
// só pra eventos de carrinho abandonado — a cadência de reenvio e a checagem anti-spam.
//
// Escopado por loja (`{ [loja]: { [evento]: {...} } }`), não só por evento: hoje são 3 lojas
// (Sul/Centro/Norte) e cada uma tem seu próprio template pro mesmo tipo de evento (ex: 3
// templates de "pagamento aprovado", um por marca) — um vínculo global por evento não dava conta
// disso. Se um dia isso virar um serviço com 1 loja só, essa estrutura ainda funciona (só existe
// 1 chave de loja).
app.get('/api/admin/automacao-eventos', requireAdmin, async (req, res) => {
  try {
    res.json({ eventos: await readAutomacaoEventos() });
  } catch (err) {
    console.error(`[AUTOMACAO] falha ao ler vínculos: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler os vínculos evento×template' });
  }
});

function validarAutomacaoEvento(body) {
  const { template, maxEnvios, intervaloHoras, checarCompra, atrasoPrimeiroEnvioHoras } = body || {};
  if (typeof template !== 'string' || !template.trim()) return 'selecione um template';
  if (maxEnvios !== undefined && maxEnvios !== null && (!Number.isInteger(maxEnvios) || maxEnvios < 1 || maxEnvios > 10)) {
    return 'quantidade de envios deve ser um número inteiro entre 1 e 10';
  }
  if (intervaloHoras !== undefined && intervaloHoras !== null && (typeof intervaloHoras !== 'number' || intervaloHoras <= 0 || intervaloHoras > 720)) {
    return 'intervalo deve ser entre 1 e 720 horas';
  }
  if (atrasoPrimeiroEnvioHoras !== undefined && atrasoPrimeiroEnvioHoras !== null && (typeof atrasoPrimeiroEnvioHoras !== 'number' || atrasoPrimeiroEnvioHoras < 0 || atrasoPrimeiroEnvioHoras > 720)) {
    return 'atraso do 1º envio deve ser entre 0 e 720 horas';
  }
  if (checarCompra !== undefined && checarCompra !== null && typeof checarCompra !== 'boolean') return 'checarCompra deve ser true ou false';
  return null;
}

app.put('/api/admin/automacao-eventos/:evento', requireAdmin, async (req, res) => {
  const { evento } = req.params;
  const loja = chaveDaStore();
  if (!evento || evento.length > 80) return res.status(400).json({ error: 'evento inválido' });

  const erro = validarAutomacaoEvento(req.body);
  if (erro) return res.status(400).json({ error: erro });

  const { template, headerVariavel, corpoVariaveis, botaoVariavel, maxEnvios, intervaloHoras, checarCompra, atrasoPrimeiroEnvioHoras } = req.body;

  try {
    const templateInfo = (await readTemplateConfigs())[template] || {};
    const permitidas = await variaveisPermitidas(templateInfo.tipo);

    // Busca a estrutura real do template na Meta — nunca confia em cache local (que só existe pra
    // template criado por este painel, ficando cego a header/corpo/botão de um template feito em
    // outro lugar). Descobre: variável posicional ({{1}}) ou nomeada ({{customer_name}}, comum no
    // painel da Meta) de cada posição, e se existe um botão de link dinâmico e em qual índice.
    let headerToken = null;
    let corpoTokens = [];
    let botaoInfo = null;
    try {
      const resultado = await whatsappRequest('GET', '/templates/list');
      const meta = (resultado.data || {}).data || [];
      const t = meta.find((x) => x.name === template);
      if (!t) return res.status(404).json({ error: 'template não encontrado na Meta' });
      const headerComp = (t.components || []).find((c) => c.type === 'HEADER' && c.format === 'TEXT');
      const corpoComp = (t.components || []).find((c) => c.type === 'BODY');
      const headerTokens = extrairTokensVariaveis((headerComp && headerComp.text) || '');
      headerToken = headerTokens[0] || null;
      corpoTokens = extrairTokensVariaveis((corpoComp && corpoComp.text) || '');
      botaoInfo = extrairBotaoDinamico(t.components);
    } catch (err) {
      console.error(`[AUTOMACAO] falha ao buscar estrutura do template ${template}: ${err.message}`);
      // Erro já classificado (token expirado, permissão…) explica a causa; o genérico só cobre o resto.
      return res.status(err.status || 502).json({
        error: err.codigo ? err.message : 'não foi possível confirmar a estrutura do template na Meta',
        ...(err.codigo ? { codigo: err.codigo } : {}),
      });
    }

    // Tipo desconhecido (template legado, criado antes dessa separação) não valida essa
    // consistência — só templates com `tipo` conhecido ganham essa checagem.
    if (templateInfo.tipo === 'pedido' && eventoEhDeCarrinho(evento)) {
      return res.status(400).json({ error: 'esse evento parece ser de carrinho abandonado, mas o template é do tipo "pedido"' });
    }
    if (templateInfo.tipo === 'carrinho' && !eventoEhDeCarrinho(evento)) {
      return res.status(400).json({ error: 'esse evento não parece ser de carrinho abandonado, mas o template é do tipo "carrinho abandonado"' });
    }

    const eventos = await readAutomacaoEventos();
    if (!eventos[loja]) eventos[loja] = {};
    const existente = eventos[loja][evento];
    const mesmoTemplate = existente && existente.template === template;

    // Automações só escolhe o template pro evento (+ cadência de carrinho) — a seleção de campo
    // por posição é feita em Templates. Por isso os campos de variável são opcionais aqui: se não
    // vierem no corpo da requisição, preserva o que já tava configurado (só se o template não
    // mudou — trocar de template invalida a seleção antiga, que era pra outra estrutura de {{n}}).
    function normalizarArray(valores, tamanho) {
      const base = Array.isArray(valores) ? valores.slice(0, tamanho) : [];
      while (base.length < tamanho) base.push(null);
      return base;
    }

    const corpoVariaveisFinal = corpoVariaveis !== undefined
      ? normalizarArray(corpoVariaveis, corpoTokens.length)
      : normalizarArray(mesmoTemplate ? existente.corpoVariaveis : [], corpoTokens.length);
    const headerVariavelFinal = headerVariavel !== undefined
      ? (headerVariavel || null)
      : (mesmoTemplate ? (existente.headerVariavel || null) : null);
    const botaoVariavelFinal = botaoVariavel !== undefined
      ? (botaoVariavel || null)
      : (mesmoTemplate ? (existente.botaoVariavel || null) : null);

    if (headerVariavelFinal && !permitidas.includes(headerVariavelFinal)) {
      return res.status(400).json({ error: 'variável do cabeçalho não é válida pro tipo deste template' });
    }
    if (corpoVariaveisFinal.some((v) => v && !permitidas.includes(v))) {
      return res.status(400).json({ error: 'variável do corpo não é válida pro tipo deste template' });
    }
    if (botaoVariavelFinal && !permitidas.includes(botaoVariavelFinal)) {
      return res.status(400).json({ error: 'variável do botão não é válida pro tipo deste template' });
    }

    const temCadencia = eventoTemCadencia(evento);
    eventos[loja][evento] = {
      // vínculo do modo WhatsApp Web (se existir) é preservado — são configurações independentes
      ...(existente && existente.mensagemWeb ? { mensagemWeb: existente.mensagemWeb } : {}),
      template,
      headerVariavel: headerVariavelFinal,
      headerToken,
      corpoVariaveis: corpoVariaveisFinal,
      corpoTokens,
      botaoVariavel: botaoInfo ? botaoVariavelFinal : null,
      botaoIndice: botaoInfo ? botaoInfo.indice : null,
      ...(temCadencia ? {
        // Padrão pedido pelo usuário: 24h pro 1º envio de carrinho abandonado, 4h pro lembrete
        // de Pix pendente — sempre editável por evento/loja.
        atrasoPrimeiroEnvioHoras: atrasoPrimeiroEnvioHoras !== undefined
          ? atrasoPrimeiroEnvioHoras
          : (existente && existente.atrasoPrimeiroEnvioHoras != null
              ? existente.atrasoPrimeiroEnvioHoras
              : (evento === EVENTO_PIX_PENDENTE ? 4 : 24)),
        maxEnvios: maxEnvios || (existente && existente.maxEnvios) || 1,
        intervaloHoras: intervaloHoras || (existente && existente.intervaloHoras) || 24,
        checarCompra: checarCompra !== undefined ? checarCompra !== false : (existente ? existente.checarCompra !== false : true),
      } : {}),
    };
    await writeAutomacaoEventos(eventos);
    res.json({ ok: true, config: eventos[loja][evento] });
  } catch (err) {
    console.error(`[AUTOMACAO] falha ao salvar vínculo ${loja}/${evento}: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar o vínculo evento×template' });
  }
});

app.delete('/api/admin/automacao-eventos/:evento', requireAdmin, async (req, res) => {
  const { evento } = req.params;
  const loja = chaveDaStore();
  const { modo } = req.query;
  if (modo !== undefined && modo !== 'api' && modo !== 'web') return res.status(400).json({ error: 'modo deve ser "api" ou "web"' });
  try {
    const eventos = await readAutomacaoEventos();
    // Com `modo`, remove só o vínculo daquele modo (o do outro continua); sem, remove tudo.
    if (eventos[loja]) {
      if (modo) removerVinculoDoModo(eventos[loja], evento, modo);
      else delete eventos[loja][evento];
    }
    await writeAutomacaoEventos(eventos);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[AUTOMACAO] falha ao remover vínculo ${loja}/${evento}: ${err.message}`);
    res.status(500).json({ error: 'não foi possível remover o vínculo evento×template' });
  }
});

// Vínculo evento→mensagem do modo WhatsApp Web. Mesma cadência do vínculo da API (é do evento,
// não do modo); o template da Meta, se existir, fica intacto.
app.put('/api/admin/automacao-eventos/:evento/web', requireAdmin, async (req, res) => {
  const { evento } = req.params;
  const loja = chaveDaStore();
  if (!evento || evento.length > 80) return res.status(400).json({ error: 'evento inválido' });
  const { mensagemWeb, maxEnvios, intervaloHoras, checarCompra, atrasoPrimeiroEnvioHoras } = req.body || {};
  if (typeof mensagemWeb !== 'string' || !UUID_RE.test(mensagemWeb)) return res.status(400).json({ error: 'selecione uma mensagem' });
  // Reaproveita a validação de cadência do vínculo da API (template fictício só pra passar na 1ª regra).
  const erro = validarAutomacaoEvento({ template: '-', maxEnvios, intervaloHoras, checarCompra, atrasoPrimeiroEnvioHoras });
  if (erro) return res.status(400).json({ error: erro });

  try {
    const mensagem = await buscarMensagemWeb(mensagemWeb);
    if (!mensagem) return res.status(404).json({ error: 'mensagem não encontrada' });
    if (mensagem.tipo === 'campanha') return res.status(400).json({ error: 'mensagem do tipo "campanha" só pode ser usada em campanhas' });
    if (mensagem.tipo === 'pedido' && eventoEhDeCarrinho(evento)) {
      return res.status(400).json({ error: 'esse evento é de carrinho abandonado, mas a mensagem é do tipo "pedido"' });
    }
    if (mensagem.tipo === 'carrinho' && !eventoEhDeCarrinho(evento)) {
      return res.status(400).json({ error: 'esse evento não é de carrinho abandonado, mas a mensagem é do tipo "carrinho abandonado"' });
    }

    const eventos = await readAutomacaoEventos();
    if (!eventos[loja]) eventos[loja] = {};
    const existente = eventos[loja][evento] || {};
    const cadencia = eventoTemCadencia(evento) ? {
      atrasoPrimeiroEnvioHoras: atrasoPrimeiroEnvioHoras !== undefined
        ? atrasoPrimeiroEnvioHoras
        : (existente.atrasoPrimeiroEnvioHoras != null ? existente.atrasoPrimeiroEnvioHoras : (evento === EVENTO_PIX_PENDENTE ? 4 : 24)),
      maxEnvios: maxEnvios || existente.maxEnvios || 1,
      intervaloHoras: intervaloHoras || existente.intervaloHoras || 24,
      checarCompra: checarCompra !== undefined ? checarCompra !== false : existente.checarCompra !== false,
    } : {};
    eventos[loja][evento] = { ...existente, mensagemWeb, ...cadencia };
    await writeAutomacaoEventos(eventos);
    res.json({ ok: true, config: eventos[loja][evento] });
  } catch (err) {
    console.error(`[AUTOMACAO] falha ao salvar vínculo web ${loja}/${evento}: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar o vínculo evento×mensagem' });
  }
});

// ── Mensagens do WhatsApp Web ───────────────────────────────────────────
const WHATSAPP_WEB_TIPOS_MENSAGEM = ['comum', 'pedido', 'carrinho', 'campanha'];
// Mesmos dados reais que o disparo de campanha resolve por destinatário (variaveisCampanhaWeb).
const VARIAVEIS_CAMPANHA_WEB = [
  'cliente.primeiro_nome', 'cliente.nome', 'cliente.email', 'cliente.telefone', 'cliente.quantidade_pedidos',
  'cliente.total_gasto', 'cliente.ticket_medio', 'cliente.ultima_compra', 'loja.nome',
];
const WHATSAPP_WEB_MENSAGEM_MAX = 4096;
const WHATSAPP_WEB_MAX_VERSOES = 5; // corpo + até 4 variações

async function validarMensagemWeb(body) {
  const { nome, tipo, corpo, variacoes } = body || {};
  if (typeof nome !== 'string' || !nome.trim() || nome.trim().length > 80) return 'nome é obrigatório (até 80 caracteres)';
  if (!WHATSAPP_WEB_TIPOS_MENSAGEM.includes(tipo)) return 'tipo inválido';
  if (typeof corpo !== 'string' || !corpo.trim()) return 'o texto da mensagem é obrigatório';
  if (variacoes !== undefined && (!Array.isArray(variacoes) || variacoes.length > WHATSAPP_WEB_MAX_VERSOES - 1)) {
    return `no máximo ${WHATSAPP_WEB_MAX_VERSOES} versões por mensagem`;
  }
  const versoes = [corpo, ...(variacoes || [])];
  if (versoes.some((v) => typeof v !== 'string' || !v.trim())) return 'nenhuma versão da mensagem pode ficar vazia';
  if (versoes.some((v) => v.length > WHATSAPP_WEB_MENSAGEM_MAX)) return `o texto passa do limite de ${WHATSAPP_WEB_MENSAGEM_MAX} caracteres`;
  // "comum" pode ser vinculada a qualquer evento, então só aceita variável que existe em todos
  // (senão chegaria vazia num evento que não tem aquele dado).
  const customs = await chavesCamposCustomizados();
  const permitidas = tipo === 'comum' ? [...VARIAVEIS_COMUNS, ...customs]
    : tipo === 'campanha' ? [...VARIAVEIS_CAMPANHA_WEB, ...customs]
      : await variaveisPermitidas(tipo);
  const invalidas = [...new Set(versoes.flatMap(extrairVariaveisMensagemWeb))].filter((chave) => !permitidas.includes(chave));
  if (invalidas.length) return `variável não disponível pra esse tipo de mensagem: ${invalidas.map((v) => `{{${v}}}`).join(', ')}`;
  return null;
}

function vinculosPorMensagemWeb(eventos) {
  const mapa = {};
  for (const loja of Object.keys(eventos)) {
    for (const ev of Object.keys(eventos[loja])) {
      const id = eventos[loja][ev].mensagemWeb;
      if (!id) continue;
      if (!mapa[id]) mapa[id] = [];
      mapa[id].push({ loja, evento: ev });
    }
  }
  return mapa;
}

function mensagemWebParaJson(r, vinculos) {
  return {
    id: r.id, nome: r.nome, tipo: r.tipo, corpo: r.corpo, variacoes: r.variacoes || [],
    criadoEm: r.criado_em, atualizadoEm: r.atualizado_em, eventos: vinculos[r.id] || [],
  };
}

app.get('/api/admin/whatsapp-web/mensagens', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ mensagens: [] });
  try {
    const [{ rows }, eventos] = await Promise.all([
      pgPool.query('SELECT id, nome, tipo, corpo, variacoes, criado_em, atualizado_em FROM whatsapp_web_mensagens ORDER BY lower(nome)'),
      readAutomacaoEventos(),
    ]);
    const vinculos = vinculosPorMensagemWeb(eventos);
    res.json({ mensagens: rows.map((r) => mensagemWebParaJson(r, vinculos)) });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao listar mensagens: ${err.message}`);
    res.status(500).json({ error: 'não foi possível listar as mensagens' });
  }
});

app.get('/api/admin/whatsapp-web/mensagens/:id', requireAdmin, exigirRecurso('whatsapp_web_mensagens'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  if (!pgPool) return res.status(404).json({ error: 'mensagem não encontrada' });
  try {
    const { rows } = await pgPool.query('SELECT id, nome, tipo, corpo, variacoes, criado_em, atualizado_em FROM whatsapp_web_mensagens WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'mensagem não encontrada' });
    res.json({ mensagem: mensagemWebParaJson(rows[0], vinculosPorMensagemWeb(await readAutomacaoEventos())) });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao ler mensagem: ${err.message}`);
    res.status(500).json({ error: 'não foi possível ler a mensagem' });
  }
});

app.post('/api/admin/whatsapp-web/mensagens', requireAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'mensagens do WhatsApp Web exigem Postgres (DATABASE_URL)' });
  try {
    const erro = await validarMensagemWeb(req.body);
    if (erro) return res.status(400).json({ error: erro });
    const { nome, tipo, corpo, variacoes } = req.body;
    const { rows } = await pgPool.query(
      `INSERT INTO whatsapp_web_mensagens (id, nome, tipo, corpo, variacoes) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, tipo, corpo, variacoes, criado_em, atualizado_em`,
      [crypto.randomUUID(), nome.trim(), tipo, corpo, JSON.stringify(variacoes || [])]
    );
    res.status(201).json({ mensagem: mensagemWebParaJson(rows[0], {}) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'já existe uma mensagem com esse nome' });
    console.error(`[WHATSAPP_WEB] falha ao criar mensagem: ${err.message}`);
    res.status(500).json({ error: 'não foi possível criar a mensagem' });
  }
});

app.put('/api/admin/whatsapp-web/mensagens/:id', requireAdmin, exigirRecurso('whatsapp_web_mensagens'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  if (!pgPool) return res.status(503).json({ error: 'mensagens do WhatsApp Web exigem Postgres (DATABASE_URL)' });
  try {
    const erro = await validarMensagemWeb(req.body);
    if (erro) return res.status(400).json({ error: erro });
    const { nome, tipo, corpo, variacoes } = req.body;

    // Trocar o tipo não pode deixar um vínculo inconsistente (ex.: virar "pedido" estando ligado
    // a um evento de carrinho) — mesma regra do vínculo em Automações.
    const eventos = await readAutomacaoEventos();
    const vinculos = vinculosPorMensagemWeb(eventos)[req.params.id] || [];
    const conflito = vinculos.find((v) => tipo === 'campanha' || (tipo === 'pedido' && eventoEhDeCarrinho(v.evento)) || (tipo === 'carrinho' && !eventoEhDeCarrinho(v.evento)));
    if (conflito) {
      return res.status(400).json({ error: `essa mensagem está vinculada a ${conflito.evento} (${LOJAS[conflito.loja] || conflito.loja}), que não combina com o tipo escolhido` });
    }

    const { rows } = await pgPool.query(
      `UPDATE whatsapp_web_mensagens SET nome = $2, tipo = $3, corpo = $4, variacoes = $5, atualizado_em = now() WHERE id = $1
       RETURNING id, nome, tipo, corpo, variacoes, criado_em, atualizado_em`,
      [req.params.id, nome.trim(), tipo, corpo, JSON.stringify(variacoes || [])]
    );
    if (!rows.length) return res.status(404).json({ error: 'mensagem não encontrada' });
    res.json({ mensagem: mensagemWebParaJson(rows[0], vinculosPorMensagemWeb(eventos)) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'já existe uma mensagem com esse nome' });
    console.error(`[WHATSAPP_WEB] falha ao salvar mensagem: ${err.message}`);
    res.status(500).json({ error: 'não foi possível salvar a mensagem' });
  }
});

// Mensagem em uso por automação não é apagada — senão o evento ficaria "vinculado" a nada e
// pararia de enviar sem aviso. Tem que desvincular em Automações antes.
app.delete('/api/admin/whatsapp-web/mensagens/:id', requireAdmin, exigirRecurso('whatsapp_web_mensagens'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  if (!pgPool) return res.status(404).json({ error: 'mensagem não encontrada' });
  try {
    const vinculos = vinculosPorMensagemWeb(await readAutomacaoEventos())[req.params.id] || [];
    if (vinculos.length) {
      const lista = vinculos.map((v) => `${LOJAS[v.loja] || v.loja} → ${v.evento}`).join(', ');
      return res.status(409).json({ error: `mensagem em uso em Automações (${lista}) — desvincule antes de excluir` });
    }
    // Campanha já iniciada tem o texto congelado (não depende mais da mensagem); rascunho ou
    // agendada ainda vai ler a mensagem na hora de iniciar.
    const { rows: campanhas } = await pgPool.query(
      `SELECT nome FROM campaigns WHERE mensagem_web_id = $1 AND status IN ('draft', 'scheduled') LIMIT 3`,
      [req.params.id]
    );
    if (campanhas.length) {
      return res.status(409).json({ error: `mensagem em uso em campanha não iniciada (${campanhas.map((c) => c.nome).join(', ')})` });
    }
    const { rowCount } = await pgPool.query('DELETE FROM whatsapp_web_mensagens WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'mensagem não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[WHATSAPP_WEB] falha ao excluir mensagem: ${err.message}`);
    res.status(500).json({ error: 'não foi possível excluir a mensagem' });
  }
});

// Recebe os webhooks da Reserva Ink (pedidos + carrinhos) — Fase 5c, TD-005 / INV-15.
//
//   URL opaca da integração → Organization (hash do token, SECURITY DEFINER)
//   → segredo do webhook DAQUELA integração → assinatura (base64(hex(HMAC-SHA256)))
//   → processamento no contexto da Organization
//
// Nunca se testa o segredo de outra loja: token desconhecido é 404, assinatura que não confere com
// o segredo da integração da URL é 401 — e nada é gravado em nenhum dos casos.
app.post('/api/webhooks/ink/:token', async (req, res) => {
  const token = req.params.token;
  if (!INK_WEBHOOK_TOKEN_RE.test(token)) return res.sendStatus(404);
  const { eventName, inkOrderId } = extractInkEvent(req);
  let organizationId = null;
  try {
    organizationId = await organizacaoPorResolvedor('ink_organization_do_webhook', hashDoTokenInk(token));
  } catch (err) {
    console.error(`[INK_WEBHOOK] falha ao resolver a URL: ${err.message}`);
    return res.sendStatus(503);
  }
  if (!organizationId) {
    console.warn(`[INK_WEBHOOK] evento ${eventName || '?'} numa URL desconhecida — não aplicado nem gravado`);
    return res.sendStatus(404);
  }

  let verificado;
  try {
    verificado = await comOrganizacaoResolvida(organizationId, 'webhook:ink', async () => {
      const m = await exigirIntegracoes().metadata('ink');
      if (m.config.webhook_token_sha256 !== hashDoTokenInk(token)) return false;
      return exigirIntegracoes().usarSegredo('ink', 'webhook_secret', (segredo, meta) => {
        const conexao = { id: String(meta.integracaoId), organizationId, webhookSecret: segredo };
        try {
          resolveWebhookConnection({
            routeToken: token,
            signature: req.get('x-webhook-signature'),
            rawBody: req.rawBody,
            buscarConexaoPorToken: (t) => (t === token ? conexao : null),
          });
          return true;
        } catch (err) {
          if (err instanceof WebhookRoutingError) return false;
          throw err;
        }
      });
    });
  } catch (err) {
    if (err && err.codigo === 'INTEGRATION_NOT_CONNECTED') verificado = false;
    else {
      console.error(`[INK_WEBHOOK] falha ao verificar entrega (org ${organizationId}): ${err.message}`);
      return res.sendStatus(503);
    }
  }
  if (!verificado) {
    console.warn(`[INK_WEBHOOK] evento ${eventName || '?'} com assinatura que não confere com a integração da URL — não aplicado`);
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  const body = req.body;
  comOrganizacaoResolvida(organizationId, 'webhook:ink', async () => {
    // A entrega é associada pela URL/segredo da Organization (nunca por chave legada): a Store é a
    // do contexto, e a chave legada só acompanha quando ela existe (nula na Store nativa).
    const storeId = storeDoContexto();
    const loja = lojaLegadaDoContextoOuNula();
    await logInkWebhook({
      recebidoEm: new Date().toISOString(),
      verificado: true,
      storeId,
      loja,
      metodoAuth: 'url-opaca+hmac-sha256-base64-of-hex',
      eventName,
      inkOrderId,
      headers: Object.keys(req.headers),
      body,
    });
    if (eventoEhDeCarrinho(eventName)) {
      // Carrinho abandonado → automação de WhatsApp, ainda por chave legada: a Store nativa só
      // registra o evento (acima).
      if (!loja) return;
      await dispararMensagemAutomaticaCarrinho(loja, eventName, body).catch((err) => {
        console.error(`[INK_WEBHOOK] falha ao processar carrinho abandonado (${loja}, evento ${eventName || '?'}): ${err.message}`);
      });
      return;
    }
    if (inkOrderId == null) {
      console.warn(`[INK_WEBHOOK] store=${storeId} evento=${eventName || '?'} sem id de pedido identificável`);
      return;
    }
    await processarEventoWebhook(loja, inkOrderId, eventName).catch((err) => {
      console.error(`[INK_WEBHOOK] falha ao processar pedido ${inkOrderId} (store ${storeId}, evento ${eventName || '?'}): ${err.message}`);
    });
  }).catch((err) => console.error(`[INK_WEBHOOK] falha ao processar entrega (org ${organizationId}): ${err.message}`));
});

// ── Webhook de status do WhatsApp (Fase 7 do plano) ─────────────────────
// O whatsapp-webhook-go (serviço externo, já verifica a assinatura HMAC da Meta e o
// hub.challenge de configuração) repassa o corpo bruto de QUALQUER evento recebido da Meta pra
// WEBHOOK_FORWARD_URL, sem filtrar por tipo — aqui só nos interessa `statuses` (sent/delivered/
// read/failed) de mensagens de campanha (localizadas por `provider_message_id` = wamid; eventos
// de automação/mensagem inbound não têm campaign_recipients pra casar e são ignorados).
//
// Autenticação do repasse (rodada 18): o Go assina cada repasse com WEBHOOK_FORWARD_SECRET em
// headers (lib/platform/whatsapp-forward.js; contrato test/fixtures/whatsapp/forward-auth-v1.json).
// WHATSAPP_WEBHOOK_SECRET é o MESMO valor, do lado do painel. Sem ele, nada é aceito (503); o
// `?secret=` antigo na URL é recusado mesmo com assinatura válida.
// Rodada 19 (§4): em produção, sem segredo válido o processo NÃO sobe (fail-fast, como o remetente
// 5b acima). Não há modo que desligue o repasse em produção; a rota abaixo está sempre montada.
const { verificarRepasseWhatsapp, exigirSegredoDeRepasseNoBoot } = require('./lib/platform/whatsapp-forward');
const WHATSAPP_WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || null;
{
  const segredoDoRepasse = exigirSegredoDeRepasseNoBoot(process.env);
  if (!segredoDoRepasse.ok) {
    console.error(`[WHATSAPP_WEBHOOK] ${segredoDoRepasse.motivo}`);
    process.exit(1);
  }
}

// Meta só avança (sent -> delivered -> read); nunca deixamos um evento atrasado regredir um
// status que já avançou mais (spec: "não substituir delivered por read, são estados distintos").
const ORDEM_STATUS_WHATSAPP = { sent: 1, delivered: 2, read: 3 };

async function aplicarStatusWebhookWhatsapp(status) {
  const wamid = status && status.id;
  const novoStatus = status && status.status;
  if (!wamid || !novoStatus) return;

  const { rows } = await pgPool.query('SELECT id, status FROM campaign_recipients WHERE provider_message_id = $1', [wamid]);
  if (!rows.length) return; // não é mensagem de campanha (automação de carrinho/PIX, fora de campaign_recipients)
  const destinatario = rows[0];
  const quando = status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date();

  if (novoStatus === 'failed') {
    const erro = (status.errors && status.errors[0]) || {};
    await pgPool.query(
      `UPDATE campaign_recipients SET status = 'failed', failed_at = $1, failure_code = $2, failure_message = $3, atualizado_em = now() WHERE id = $4`,
      [quando, erro.code != null ? String(erro.code) : null, erro.title || 'falha reportada pela Meta', destinatario.id]
    );
    return;
  }

  const ordemAtual = ORDEM_STATUS_WHATSAPP[destinatario.status] || 0;
  const ordemNova = ORDEM_STATUS_WHATSAPP[novoStatus] || 0;
  if (ordemNova <= ordemAtual) return;

  const coluna = novoStatus === 'sent' ? 'sent_at' : novoStatus === 'delivered' ? 'delivered_at' : novoStatus === 'read' ? 'read_at' : null;
  if (!coluna) return;
  await pgPool.query(
    `UPDATE campaign_recipients SET status = $1, ${coluna} = $2, atualizado_em = now() WHERE id = $3`,
    [novoStatus, quando, destinatario.id]
  );
}

async function processarWebhookWhatsapp(body) {
  if (!pgPool) return;
  const entries = (body && body.entry) || [];
  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      const statuses = (change.value && change.value.statuses) || [];
      for (const status of statuses) {
        try {
          const organizationId = await organizacaoPorResolvedor('tenancy_organization_do_wamid', status && status.id);
          if (!organizationId) continue; // não é mensagem de campanha, ou wamid ambíguo
          await comOrganizacaoResolvida(organizationId, 'webhook:whatsapp', () => aplicarStatusWebhookWhatsapp(status));
        } catch (err) {
          console.error(`[WHATSAPP_WEBHOOK] falha ao aplicar status ${status && status.id}: ${err.message}`);
        }
      }
    }
  }
}

// Transição sem perda de status (rodada 19, §5; docs/productization/round19-trilha-e.md):
// WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1 aceita o repasse do Go em transição (query legada +
// assinatura) pela assinatura. Valor inválido derruba o boot. Sai no CLEANUP.
const { lerToleranciaQueryLegada } = require('./lib/platform/whatsapp-forward');
const TOLERA_QUERY_LEGADA_DO_REPASSE = lerToleranciaQueryLegada(process.env.WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED);
if (TOLERA_QUERY_LEGADA_DO_REPASSE) {
  console.warn('[WHATSAPP_WEBHOOK] WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1 — TRANSIÇÃO: a query legada do repasse é ignorada quando a assinatura em header é válida. Desligar depois que o Go deixar de mandar a query.');
}
let repasseComQueryLegadaAvisado = false;

app.post('/api/webhooks/whatsapp', (req, res) => {
  const verificacao = verificarRepasseWhatsapp({
    toleraQueryLegada: TOLERA_QUERY_LEGADA_DO_REPASSE,
    segredo: WHATSAPP_WEBHOOK_SECRET, headers: req.headers, query: req.query, corpoCru: req.rawBody,
  });
  if (!verificacao.ok) {
    console.warn(`[WHATSAPP_WEBHOOK] repasse recusado (${verificacao.status}): ${verificacao.motivo}`);
    return res.status(verificacao.status).end();
  }
  if (verificacao.queryLegadaTolerada && !repasseComQueryLegadaAvisado) {
    repasseComQueryLegadaAvisado = true;
    console.warn('[WHATSAPP_WEBHOOK] repasse com a query legada aceito pela assinatura (transição; aviso único por processo)');
  }
  res.sendStatus(200);
  processarWebhookWhatsapp(req.body).catch((err) => {
    console.error(`[WHATSAPP_WEBHOOK] falha ao processar payload: ${err.message}`);
  });
});

// ── Resolução interna do remetente (Fase 5b) ──────────────────────────────────────────────
// Chamado SÓ pelo whatsapp-webhook-go, para despachar um envio que ele guardou (fila do dashboard,
// retry de status "failed"): troca a referência assinada que o próprio painel emitiu pelo par
// número + token atual daquela integração. Duas travas independentes: a chave do serviço
// (WHATSAPP_SENDER_RESOLVER_KEY) e a assinatura da referência (WHATSAPP_SENDER_REF_SECRET, que o
// Go não conhece). A Organization sai da referência assinada, nunca de campo solto; a integração
// precisa ser a mesma e continuar com o mesmo número, e o plano precisa incluir WhatsApp.
function chaveDoResolverValida(recebida) {
  if (!WHATSAPP_SENDER_RESOLVER_KEY || typeof recebida !== 'string' || !recebida) return false;
  const a = crypto.createHash('sha256').update(recebida).digest();
  const b = crypto.createHash('sha256').update(WHATSAPP_SENDER_RESOLVER_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

app.post('/api/internal/whatsapp/sender', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!chaveDoResolverValida(req.get('X-Api-Key'))) return res.status(401).json({ error: 'não autorizado', codigo: 'UNAUTHORIZED' });
  const corpo = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(corpo).some((k) => k !== 'ref') || typeof corpo.ref !== 'string') {
    return res.status(400).json({ error: 'corpo inválido', codigo: 'SENDER_REF_INVALID' });
  }
  try {
    const remetenteApi = exigirRemetenteWhatsapp();
    const alvo = remetenteApi.lerRef(corpo.ref);
    const par = await comOrganizacaoResolvida(alvo.organizationId, 'interno:whatsapp-sender', async () => {
      try {
        await checkEntitlement(PLANO_DA_ORGANIZACAO, 'whatsapp');
      } catch {
        throw new RemetenteError('WhatsApp não incluído no plano', { codigo: 'FEATURE_DISABLED', status: 403 });
      }
      return remetenteApi.comRemetente((r) => {
        if (r.integrationId !== alvo.integrationId || r.phoneNumberId !== alvo.phoneNumberId) {
          throw new RemetenteError('o remetente desta referência mudou', { codigo: 'SENDER_CHANGED', status: 409 });
        }
        return { phone_number_id: r.phoneNumberId, waba_id: r.wabaId, access_token: r.accessToken };
      });
    });
    // Única resposta do painel que carrega um segredo de tenant, por definição do contrato: sai por
    // res.end para não ser redigida pelo secret-guard (que continua valendo para todo o resto).
    res.status(200).type('application/json').end(JSON.stringify(par));
  } catch (err) {
    // RemetenteError, IntegracaoError e o erro de contexto do tenant (Store ausente) têm status e
    // código próprios; nenhum carrega segredo.
    if (err && Number.isInteger(err.status) && typeof err.codigo === 'string') {
      return res.status(err.status).json({ error: err.message, codigo: err.codigo });
    }
    console.error(`[WHATSAPP_SENDER] falha ao resolver referência: ${err.message}`);
    res.status(500).json({ error: 'não foi possível resolver o remetente', codigo: 'SENDER_RESOLVE_FAILED' });
  }
});

// ── Contexto de entrada e de referência para o serviço Go (Fase 5c) ─────────────────────────
// O webhook da Meta chega ao Go autenticado pelo App Secret da PLATAFORMA — isso diz que veio da
// Meta, não de qual Organization. O Go pergunta aqui:
//
//   inbound-context  {waba_id, phone_number_id?}  (entry.id e metadata.phone_number_id do evento)
//   ref-context      {ref}                        (chamada interna do painel, ex.: painel de eventos)
//
// e recebe a Organization, a integração, a referência assinada e o comportamento configurado. Nunca
// o token (para enviar, a referência é trocada em /sender). A Organization NUNCA vem do corpo:
// organization_id no pedido é 400. Desconhecido → 404, divergente → 409, sem listar nada.
const LIMITE_CONTEXTO_POR_MINUTO = Number(process.env.WHATSAPP_CONTEXT_RATE_PER_MIN || 1200);
const janelaContexto = { inicio: 0, total: 0 };
function contextoDentroDoLimite() {
  const agora = Date.now();
  if (agora - janelaContexto.inicio >= 60_000) {
    janelaContexto.inicio = agora;
    janelaContexto.total = 0;
  }
  janelaContexto.total += 1;
  return janelaContexto.total <= LIMITE_CONTEXTO_POR_MINUTO;
}

const META_ID_ENTRADA_RE = /^[0-9]{5,32}$/;

async function organizacaoDoRemetenteWhatsapp(wabaId, phoneNumberId) {
  const { rows } = await semContexto(() => pgPoolReal.query(
    'SELECT organization_id, motivo FROM whatsapp_organization_do_remetente($1, $2)', [wabaId, phoneNumberId]
  ));
  return rows[0] || { organization_id: null, motivo: 'desconhecido' };
}

function rotaDeContextoInterno(nome, campos, resolver) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!chaveDoResolverValida(req.get('X-Api-Key'))) return res.status(401).json({ error: 'não autorizado', codigo: 'UNAUTHORIZED' });
    if (!contextoDentroDoLimite()) {
      console.warn(`[WHATSAPP_CONTEXT] limite de ${LIMITE_CONTEXTO_POR_MINUTO}/min excedido (${nome})`);
      return res.status(429).json({ error: 'muitas requisições', codigo: 'RATE_LIMITED' });
    }
    const corpo = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!corpo || Object.keys(corpo).some((k) => !campos.includes(k))) {
      return res.status(400).json({ error: 'corpo inválido', codigo: 'CONTEXT_REQUEST_INVALID' });
    }
    try {
      const contexto = await resolver(corpo);
      res.json(contexto);
    } catch (err) {
      if (err && Number.isInteger(err.status) && typeof err.codigo === 'string') {
        if (err.status >= 500) console.error(`[WHATSAPP_CONTEXT] ${nome}: ${err.codigo}`);
        return res.status(err.status).json({ error: err.message, codigo: err.codigo });
      }
      console.error(`[WHATSAPP_CONTEXT] ${nome} falhou: ${err.message}`);
      res.status(500).json({ error: 'não foi possível resolver o contexto', codigo: 'CONTEXT_RESOLVE_FAILED' });
    }
  };
}

async function contextoNaOrganizacao(organizationId, origem, conferencia) {
  const remetenteApi = exigirRemetenteWhatsapp();
  return comOrganizacaoResolvida(organizationId, origem, async () => {
    try {
      await checkEntitlement(PLANO_DA_ORGANIZACAO, 'whatsapp');
    } catch {
      throw new RemetenteError('WhatsApp não incluído no plano', { codigo: 'FEATURE_DISABLED', status: 403 });
    }
    return remetenteApi.contextoConferido(conferencia);
  });
}

app.post('/api/internal/whatsapp/inbound-context', rotaDeContextoInterno('inbound', ['waba_id', 'phone_number_id'], async (corpo) => {
  const wabaId = corpo.waba_id;
  const phoneNumberId = corpo.phone_number_id === undefined || corpo.phone_number_id === null ? null : corpo.phone_number_id;
  if (typeof wabaId !== 'string' || !META_ID_ENTRADA_RE.test(wabaId)
    || (phoneNumberId !== null && (typeof phoneNumberId !== 'string' || !META_ID_ENTRADA_RE.test(phoneNumberId)))) {
    throw new RemetenteError('identificadores inválidos', { codigo: 'CONTEXT_REQUEST_INVALID', status: 400 });
  }
  const { organization_id: organizationId, motivo } = await organizacaoDoRemetenteWhatsapp(wabaId, phoneNumberId);
  if (motivo === 'divergente') {
    console.warn(`[WHATSAPP_CONTEXT] WABA ${wabaId} e número ${phoneNumberId} pertencem a Organizations diferentes — evento recusado`);
    throw new RemetenteError('WABA e número não pertencem à mesma Organization', { codigo: 'SENDER_MISMATCH', status: 409 });
  }
  if (!organizationId) {
    console.warn(`[WHATSAPP_CONTEXT] WABA ${wabaId} / número ${phoneNumberId || '-'} sem Organization — evento recusado`);
    throw new RemetenteError('remetente desconhecido', { codigo: 'SENDER_UNKNOWN', status: 404 });
  }
  return contextoNaOrganizacao(organizationId, 'interno:whatsapp-inbound', { wabaId, phoneNumberId });
}));

app.post('/api/internal/whatsapp/ref-context', rotaDeContextoInterno('ref', ['ref'], async (corpo) => {
  const alvo = exigirRemetenteWhatsapp().lerRef(corpo.ref);
  return contextoNaOrganizacao(alvo.organizationId, 'interno:whatsapp-ref', {
    phoneNumberId: alvo.phoneNumberId, integrationId: alvo.integrationId,
  });
}));

// Gera o QR Code a partir do próprio código Pix (nunca a partir de imagem enviada por terceiros)
async function generateQrPng(pixCode) {
  const QRCode = require('qrcode');
  return QRCode.toBuffer(pixCode, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 600,
  });
}

function validarCamposPedido(body) {
  const { pixCode, cliente, valor, referencia } = body || {};
  if (typeof pixCode !== 'string' || pixCode.trim().length < 10 || pixCode.length > 2000) return 'código pix inválido';
  if (cliente !== undefined && cliente !== '' && (typeof cliente !== 'string' || cliente.length > 120)) return 'nome do cliente inválido';
  if (referencia !== undefined && referencia !== '' && (typeof referencia !== 'string' || referencia.length > 60)) return 'referência inválida';
  if (valor !== undefined && valor !== '' && (typeof valor !== 'string' || !/^\d{1,7}([.,]\d{1,2})?$/.test(valor))) return 'valor inválido';
  return null;
}

// Pré-visualização do QR enquanto o admin digita/cola o código pix — não persiste nada
app.post('/api/admin/qr-preview', requireAdmin, async (req, res) => {
  const { pixCode } = req.body || {};
  if (typeof pixCode !== 'string' || pixCode.trim().length < 10 || pixCode.length > 2000) {
    return res.status(400).json({ error: 'código pix inválido' });
  }
  try {
    const qrBuffer = await generateQrPng(pixCode.trim());
    res.json({ dataUrl: `data:image/png;base64,${qrBuffer.toString('base64')}` });
  } catch (err) {
    console.error(`[ADMIN] falha ao pré-visualizar QR: ${err.message}`);
    res.status(400).json({ error: 'não foi possível gerar o QR Code para esse código pix' });
  }
});

app.post('/api/admin/pedidos', requireAdmin, async (req, res) => {
  const erro = validarCamposPedido(req.body);
  if (erro) return res.status(400).json({ error: erro });

  const { pixCode, cliente, valor, referencia } = req.body || {};

  const loja = chaveDaStore();

  try {
    await generateQrPng(pixCode.trim()); // valida que o código gera um QR de verdade antes de salvar
  } catch (err) {
    console.error(`[ADMIN] falha ao gerar QR Code: ${err.message}`);
    return res.status(400).json({ error: 'não foi possível gerar o QR Code para esse código pix' });
  }

  const pedidos = await readPedidos();
  const id = generatePedidoId(pedidos);
  pedidos[id] = {
    loja,
    pixCode: pixCode.trim(),
    cliente: cliente ? cliente.trim() : null,
    referencia: referencia ? referencia.trim() : null,
    valor: valor ? valor.trim() : null,
    criadoEm: new Date().toISOString(),
  };
  await writePedidos(pedidos);

  res.json({ ok: true, id, url: `/${id}` });
});

app.delete('/api/admin/pedidos/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!PEDIDO_ID_RE.test(id)) return res.status(400).json({ error: 'id inválido' });

  const pedidos = await readPedidos();
  if (!pedidos[id]) return res.status(404).json({ error: 'não encontrado' });

  delete pedidos[id];
  await writePedidos(pedidos);
  res.json({ ok: true });
});

// Dados públicos do pedido — consumidos pela hotpage (sem autenticação: o link em si é o acesso)
app.get('/api/pedidos/:id', async (req, res) => {
  const { id } = req.params;
  if (!PEDIDO_ID_RE.test(id)) return res.status(404).json({ error: 'não encontrado' });

  let pedido;
  try {
    const organizationId = await organizacaoPorResolvedor('publico_organization_do_pedido', id);
    if (!organizationId) return res.status(404).json({ error: 'não encontrado' });
    pedido = await comOrganizacaoResolvida(organizationId, 'publico:pedido', async () => (await readPedidos())[id]);
  } catch (err) {
    console.error(`[PEDIDOS] falha ao ler pedido público: ${err.message}`);
    return res.status(404).json({ error: 'não encontrado' });
  }
  if (!pedido) return res.status(404).json({ error: 'não encontrado' });

  res.json({
    loja: pedido.loja,
    lojaNome: LOJAS[pedido.loja],
    pixCode: pedido.pixCode || null,
    qrImageUrl: pedido.pixCode ? `/assets/pedidos/${id}.png` : null,
    cliente: pedido.cliente,
    valor: pedido.valor,
    orderStatus: pedido.orderStatus || null,
    orderStatusLabel: pedido.orderStatusLabel || null,
    paymentStatus: pedido.paymentStatus || null,
    pixExpiration: pedido.pixExpiration || null,
  });
});

// Hotpage pública de pagamento Pix: `/hotpix/{id}`.
//
// O prefixo é o ponto. A rota morava em `/{id}` — um segmento só, sem prefixo nenhum —, o que a
// deixava ambígua com QUALQUER outra rota de um segmento do serviço: a landing, `/admin`,
// `/oria`, `/politica-de-privacidade`. O que segurava a ambiguidade era a ordem de registro mais
// um regex de comprimento (10-14 caracteres), e nada disso aparece em quem lê a rota nova: um id
// de 12 caracteres com o nome de uma página futura já teria colidido em silêncio.
//
// O esquema antigo não ficou respondendo em paralelo, e é de propósito: os links de pagamento que
// já saíram para clientes foram gerados pela stack legada (outro domínio, outro servidor, ainda no
// ar), e continuam sendo servidos por ela. Neste serviço nada foi enviado ainda — então é corte
// limpo, sem redirect e sem rota de um segmento sobrevivendo "por garantia".
// test/invariants/hotpix.test.js trava os dois lados: `/hotpix/{id}` serve, `/{id}` não.
//
// Sem autenticação por decisão de produto: o id do link É a credencial (a mesma capability que
// `/api/pedidos/:id` e `/assets/pedidos/:id.png` já usam). O HTML aqui é estático — quem resolve o
// id e busca o dado é `src/pedido.js`, contra a API.
app.get('/hotpix/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'pedido.html'));
});

// ── Product Analytics (rodada H→I) ──────────────────────────────────────────────────────────
//
// Fases B→G.1 (lib/product-analytics/, lib/connectors/) são bibliotecas puras, sem HTTP. Aqui é a
// ÚNICA fiação: monta os connectors (Ink `commerce`, GA4 `analytics`) e os services UMA VEZ no
// boot — nunca por request (o ReportCache do ProductPerformanceService só reaproveita relatório
// entre requests se a instância sobreviver ao request que a criou; ver
// lib/product-analytics/composition.js). O router só existe, e só é montado, com `pgPool`
// disponível — sem Postgres não há RLS, e sem RLS estes serviços não têm o que ler com segurança.
const { createProductAnalyticsComposition } = require('./lib/product-analytics/composition');
const { createProductAnalyticsRouter } = require('./lib/product-analytics/http-routes');
const PRODUCT_ANALYTICS = pgPool
  ? createProductAnalyticsComposition({
    pool: pgPool, keyring: CHAVEIRO,
    googleClientId: process.env.GOOGLE_CLIENT_ID, googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  })
  : null;
if (PRODUCT_ANALYTICS) {
  // `requireAdmin` já resolve auth + Organization/Store da sessão + entitlement
  // (`analytics_product_performance`, via feature-routes.js → ROTAS) antes de qualquer handler
  // daqui rodar — nenhum guard extra é reimplementado no router.
  app.use('/api/admin/product-analytics', requireAdmin, createProductAnalyticsRouter({
    productPerformanceService: PRODUCT_ANALYTICS.productPerformanceService,
    reconciliationService: PRODUCT_ANALYTICS.reconciliationService,
    registry: PRODUCT_ANALYTICS.registry,
    analyticsProvider: PRODUCT_ANALYTICS.analyticsProvider,
    commerceProvider: PRODUCT_ANALYTICS.commerceProvider,
  }));
}

// Último middleware do app: todo erro que uma rota, um middleware ou uma promise rejeitada
// encaminhar para `next(err)` termina aqui, com resposta HTTP controlada e sem stack no corpo.
app.use(httpSafety.criarErroCentral());

const PORT = process.env.PORT || 8080;

// Escutar só DEPOIS da verificação crítica de boot (TD-003).
//
// Antes disto, `app.listen` era chamado direto e a verificação corria em paralelo: com um banco sem
// as migrations aplicadas, o processo anunciava "na porta 8080", aceitava requisições por alguns
// milissegundos e só então saía com 1. É pouco tempo, mas é uma janela em que o healthcheck do
// Railway pode responder OK e o balanceador mandar tráfego para um processo que está morrendo.
//
// `verificarPostgresOuMorrer()` já faz `process.exit(1)` por conta própria em caso de falha; este
// `.then` só garante a ORDEM. No modo efêmero declarado ela resolve de imediato.
avaliacaoDoModuloConcluida = true;
verificarPostgresOuMorrer().then(() => {
  app.listen(PORT, () => console.log(`Oria na porta ${PORT}`));
  if (moduloCriativos) moduloCriativos.iniciarWorker();
});
