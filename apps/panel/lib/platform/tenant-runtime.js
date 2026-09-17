'use strict';

// Contexto de tenant no processo Node (Fase 3 · TD-001 + TD-002).
//
// A Organization de uma unidade de trabalho — uma request autenticada, um item de job, um webhook
// roteado — é fixada UMA vez, por quem a resolveu no servidor (sessão, lista de jobs, resolvedor
// estreito), e carregada até as queries por AsyncLocalStorage. O AsyncLocalStorage só transporta;
// quem isola é:
//
//   1. o Postgres: cada query roda em `comOrganization` (BEGIN + set_config(..., true)) e a RLS
//      forçada filtra pela Organization do contexto;
//   2. a aplicação: os handlers continuam filtrando pela Store do contexto;
//   3. o modo estrito: query que toca tabela tenant-owned SEM contexto é erro, não "zero linhas".
//
// Nenhum valor do request entra aqui.

const { AsyncLocalStorage } = require('async_hooks');
const { comOrganization } = require('./tenant-db');
const manifesto = require('./tenancy-manifest');

const armazenamento = new AsyncLocalStorage();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TenantRuntimeError extends Error {
  constructor(message, codigo = 'TENANT_CONTEXT_ERROR') {
    super(message);
    this.name = 'TenantRuntimeError';
    this.codigo = codigo;
  }
}

function contextoAtual() {
  return armazenamento.getStore() || null;
}

// Roda `fn` com a Organization fixada. `origem` diz quem a resolveu (sessao | job | webhook | publico).
function comContexto(contexto, fn) {
  if (!contexto || !UUID_RE.test(String(contexto.organizationId || ''))) {
    throw new TenantRuntimeError('contexto de tenant sem organizationId válido');
  }
  const congelado = Object.freeze({
    organizationId: contexto.organizationId,
    storeId: contexto.storeId || null,
    loja: contexto.loja || null,
    origem: contexto.origem || 'desconhecida',
  });
  return armazenamento.run(congelado, fn);
}

// Trabalho explicitamente SEM tenant (ex.: login, listar Organizations para jobs). Desfaz qualquer
// contexto herdado — um timer criado dentro de uma request não carrega a Organization dela.
function semContexto(fn) {
  return armazenamento.exit(fn);
}

const TABELAS_PROTEGIDAS = [...manifesto.nomesSobRls()];
const PADRAO_PROTEGIDO = new RegExp(
  `\\b(?:from|join|into|update|table)\\s+(?:only\\s+)?(?:public\\.)?"?(${TABELAS_PROTEGIDAS.join('|')})"?\\b`,
  'i'
);

function tabelaProtegidaEm(sql) {
  const texto = typeof sql === 'string' ? sql : sql && sql.text;
  if (typeof texto !== 'string') return null;
  const m = texto.match(PADRAO_PROTEGIDO);
  return m ? m[1].toLowerCase() : null;
}

function exigirContextoPara(sql) {
  const tabela = tabelaProtegidaEm(sql);
  if (tabela) {
    throw new TenantRuntimeError(
      `query em ${tabela} sem contexto de Organization — todo acesso tenant-owned roda em comContexto`,
      'TENANT_CONTEXT_REQUIRED'
    );
  }
}

// Cliente dedicado (pool.connect) sob contexto: todo BEGIN do chamador recebe o set_config local;
// query fora de transação explícita vira uma transação curta própria.
function envolverCliente(cliente, organizationId) {
  let emTransacao = false;
  const configurar = () => cliente.query('SELECT set_config($1, $2, true)', ['app.current_organization_id', organizationId]);
  return new Proxy(cliente, {
    get(alvo, prop) {
      if (prop !== 'query') {
        const v = alvo[prop];
        return typeof v === 'function' ? v.bind(alvo) : v;
      }
      return async (sql, ...resto) => {
        const texto = (typeof sql === 'string' ? sql : sql && sql.text || '').trim().toUpperCase();
        if (/^(BEGIN|START TRANSACTION)\b/.test(texto)) {
          const r = await alvo.query(sql, ...resto);
          emTransacao = true;
          await configurar();
          return r;
        }
        if (/^(COMMIT|ROLLBACK|END)\b/.test(texto)) {
          emTransacao = false;
          return alvo.query(sql, ...resto);
        }
        if (emTransacao) return alvo.query(sql, ...resto);
        await alvo.query('BEGIN');
        try {
          await configurar();
          const r = await alvo.query(sql, ...resto);
          await alvo.query('COMMIT');
          return r;
        } catch (err) {
          await alvo.query('ROLLBACK').catch(() => {});
          throw err;
        }
      };
    },
  });
}

// Fachada do pool para o código da aplicação. Mesma interface usada no server.js (query, connect,
// end, on). A Organization vem do contexto atual; sem contexto, só passa query que não toque
// tabela protegida.
function criarPoolTenant(poolReal) {
  return {
    async query(sql, params) {
      const ctx = contextoAtual();
      if (!ctx) {
        exigirContextoPara(sql);
        return poolReal.query(sql, params);
      }
      return comOrganization(poolReal, ctx.organizationId, (c) => c.query(sql, params));
    },
    async connect() {
      const ctx = contextoAtual();
      const cliente = await poolReal.connect();
      if (!ctx) {
        return new Proxy(cliente, {
          get(alvo, prop) {
            if (prop === 'query') return (sql, ...resto) => { exigirContextoPara(sql); return alvo.query(sql, ...resto); };
            const v = alvo[prop];
            return typeof v === 'function' ? v.bind(alvo) : v;
          },
        });
      }
      return envolverCliente(cliente, ctx.organizationId);
    },
    end: (...a) => poolReal.end(...a),
    on: (...a) => poolReal.on(...a),
    get totalCount() { return poolReal.totalCount; },
    poolReal,
  };
}

module.exports = {
  TenantRuntimeError,
  contextoAtual,
  comContexto,
  semContexto,
  tabelaProtegidaEm,
  criarPoolTenant,
};
