'use strict';

// TD-003 / B-09 — Postgres obrigatório em produção, degradação DECLARADA em dev.
//
// O que isto substitui, literalmente (`server.js:113` em 8a7ea3d):
//
//     const DATABASE_URL = process.env.DATABASE_URL || null;
//     const pgPool = DATABASE_URL ? new Pool({...}) : null;
//
// Aquela linha é o padrão que a regra fail-closed do plano proíbe: ela INFERE o modo de operação
// da ausência de uma variável. Faltou `DATABASE_URL`? Então o operador deve estar em dev. Faltou em
// produção porque alguém renomeou a variável, o secret não montou ou o serviço foi recriado? Mesma
// conclusão, e o painel sobe servindo estado de negócio a partir de arquivos JSON num filesystem
// efêmero, sem nada nos logs além de silêncio.
//
// Aqui o modo é SEMPRE declarado. `DATA_STORE_MODE` não tem default permissivo: o default é
// `postgres`, e `postgres` sem `DATABASE_URL` é erro em QUALQUER ambiente — inclusive dev. Quem
// quiser rodar sem banco precisa dizer isso em voz alta.

const MODO_POSTGRES = 'postgres';
const MODO_EFEMERO = 'ephemeral-json';
const MODOS = new Set([MODO_POSTGRES, MODO_EFEMERO]);

class DatabaseConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

function ehProducao(env) {
  return (env.NODE_ENV || '').toLowerCase() === 'production';
}

// Resolve o modo de persistência a partir do ambiente. Lança em vez de devolver um modo degradado.
function resolveDatabaseMode(env = process.env) {
  const declarado = (env.DATA_STORE_MODE || '').trim().toLowerCase();
  const modo = declarado || MODO_POSTGRES;

  if (!MODOS.has(modo)) {
    throw new DatabaseConfigError(
      `DATA_STORE_MODE inválido: "${declarado}". Valores aceitos: ${[...MODOS].join(', ')}.`
    );
  }

  if (modo === MODO_EFEMERO) {
    if (ehProducao(env)) {
      throw new DatabaseConfigError(
        'DATA_STORE_MODE=ephemeral-json é proibido em produção (TD-003): estado de negócio em ' +
        'arquivo JSON não sobrevive a um deploy e não é isolável por tenant.'
      );
    }
    return { modo: MODO_EFEMERO, databaseUrl: null, declarado: true };
  }

  const databaseUrl = (env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new DatabaseConfigError(
      'DATABASE_URL ausente e DATA_STORE_MODE=postgres (padrão). O boot falha de propósito: a ' +
      'ausência da variável NUNCA é interpretada como "deve ser dev" (TD-003). Para rodar sem ' +
      'banco em desenvolvimento, declare DATA_STORE_MODE=ephemeral-json.'
    );
  }

  return { modo: MODO_POSTGRES, databaseUrl, declarado: Boolean(declarado) };
}

// SSL: local não usa; qualquer outro host usa. Mantido igual a 8a7ea3d de propósito — mudar a
// política de TLS não é escopo da Fase 0 e alteraria o comportamento contra o Railway.
function opcoesDePool(databaseUrl) {
  return {
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
  };
}

// Verificação crítica de boot. NÃO cria schema: schema é responsabilidade das migrations, que
// rodam no pre-deploy (OPS-11). Aqui só se confirma que o banco responde e que as migrations
// realmente foram aplicadas — porque um deploy que pulou o pre-deploy sobe contra um banco sem as
// tabelas, e o modo de falha disso hoje seria erro 500 esparso em runtime, não um boot que falha.
async function verificarBootstrapCritico(pool, { migrationEsperada } = {}) {
  await pool.query('SELECT 1');

  const { rows } = await pool.query(
    `SELECT to_regclass('public.pgmigrations') IS NOT NULL AS tem_tabela`
  );
  if (!rows[0]?.tem_tabela) {
    throw new DatabaseConfigError(
      'tabela pgmigrations ausente: as migrations nunca rodaram contra este banco. ' +
      'Rode `npm run migrate:up` (em produção, o Pre-deploy Command — OPS-11).'
    );
  }

  if (migrationEsperada) {
    const { rows: aplicadas } = await pool.query(
      'SELECT 1 FROM pgmigrations WHERE name = $1',
      [migrationEsperada]
    );
    if (!aplicadas.length) {
      throw new DatabaseConfigError(
        `migration "${migrationEsperada}" não aplicada neste banco. O deploy está à frente do ` +
        'schema — rode as migrations antes de subir a aplicação.'
      );
    }
  }
}

// TD-001 — a role com que a APLICAÇÃO conecta não pode anular a RLS.
//
//   superusuário   ignora RLS sempre, mesmo com FORCE
//   BYPASSRLS      idem
//   dona (ou membro que herda a dona) de tabela sob RLS
//                  pode desligar a RLS com ALTER TABLE, e sem FORCE escapa da policy
//   acesso a tenancy_mapeamentos
//                  o mapeamento legado é da migration e do trigger, não do request
//
// Ativada por `DB_ENFORCE_APP_ROLE=1` no mesmo passo que troca a DATABASE_URL do app para a role
// `oria_app` (OPS-14). Antes disso, produção ainda conecta com a role atual (superusuário) — ligar a
// exigência agora derrubaria o próximo deploy, e a troca de role depende das Fases 2-3.
function exigirRoleDaAplicacao(env = process.env) {
  return String(env.DB_ENFORCE_APP_ROLE || '').trim() === '1';
}

async function verificarRoleDaAplicacao(pool, { tabelasSobRls, tabelasPrivadas = require('./tenancy-manifest').TABELAS_GLOBAIS_PRIVADAS } = {}) {
  if (!Array.isArray(tabelasSobRls) || !tabelasSobRls.length) {
    throw new DatabaseConfigError('verificarRoleDaAplicacao exige a lista de tabelas sob RLS');
  }
  const problemas = [];
  const { rows: [role] } = await pool.query(
    'SELECT current_user AS nome, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  if (role.rolsuper) problemas.push(`${role.nome} é SUPERUSER — ignora toda RLS`);
  if (role.rolbypassrls) problemas.push(`${role.nome} tem BYPASSRLS`);

  const { rows: donas } = await pool.query(
    `SELECT c.relname, pg_get_userbyid(c.relowner) AS dona
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)
        AND pg_has_role(current_user, c.relowner, 'USAGE')`,
    [tabelasSobRls]
  );
  for (const d of donas) problemas.push(`${role.nome} é (ou herda) a dona de ${d.relname} (${d.dona})`);

  const { rows: privadas } = await pool.query(
    `SELECT t AS tabela FROM unnest($1::text[]) AS t
      WHERE to_regclass('public.' || t) IS NOT NULL
        AND (has_table_privilege(current_user, 'public.' || t, 'SELECT')
          OR has_table_privilege(current_user, 'public.' || t, 'INSERT')
          OR has_table_privilege(current_user, 'public.' || t, 'UPDATE')
          OR has_table_privilege(current_user, 'public.' || t, 'DELETE'))`,
    [tabelasPrivadas]
  );
  for (const x of privadas) problemas.push(`${role.nome} tem acesso a ${x.tabela}`);

  if (problemas.length) {
    throw new DatabaseConfigError(
      `role da aplicação inválida para RLS (TD-001):\n  - ${problemas.join('\n  - ')}`
    );
  }
  return { role: role.nome };
}

module.exports = {
  exigirRoleDaAplicacao,
  verificarRoleDaAplicacao,
  MODO_POSTGRES,
  MODO_EFEMERO,
  DatabaseConfigError,
  resolveDatabaseMode,
  opcoesDePool,
  verificarBootstrapCritico,
};
