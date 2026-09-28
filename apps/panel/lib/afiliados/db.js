'use strict';

// Utilidades compartilhadas do módulo de afiliados: erro de domínio com status HTTP, transação e auditoria.
// O `pool` é a FACHADA de tenant do painel (lib/platform/tenant-runtime.js → criarPoolTenant): a Organization vem do
// contexto da request (sessão), nunca de parâmetro. Mesmo assim toda query aqui também filtra por organization_id
// (defesa em profundidade; a RLS forçada continua sendo o piso).

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AfiliadosError extends Error {
  constructor(status, codigo, mensagem, detalhes) {
    super(mensagem);
    this.name = 'AfiliadosError';
    this.status = status;
    this.codigo = codigo;
    this.detalhes = detalhes;
  }
}

const erro = (status, codigo, mensagem, detalhes) => new AfiliadosError(status, codigo, mensagem, detalhes);
const naoEncontrado = (o = 'registro') => erro(404, 'AFILIADOS_NAO_ENCONTRADO', `${o} não encontrado`);
const entradaInvalida = (mensagem, detalhes) => erro(400, 'AFILIADOS_ENTRADA_INVALIDA', mensagem, detalhes);
const conflito = (codigo, mensagem, detalhes) => erro(409, codigo, mensagem, detalhes);

// Id que não é UUID nunca chega ao banco: a resposta é a mesma de "não existe" (nada vaza sobre outra Organization).
function exigirUuid(valor, nome = 'registro') {
  if (typeof valor !== 'string' || !UUID_RE.test(valor)) throw naoEncontrado(nome);
  return valor.toLowerCase();
}

async function tx(pool, fn) {
  const c = await pool.connect();
  let descartar = false;
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => { descartar = true; });
    throw err;
  } finally {
    c.release(descartar);
  }
}

// Serializa o trabalho concorrente de uma chave (transação corrente): pedido em reconciliação, cupom, collab...
async function travarChave(c, organizationId, chave) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${organizationId}:${chave}`]);
}

// Estado sanitizado para auditoria: nunca segredo, nunca dado de comprador (o módulo nem os guarda).
async function auditar(c, ctx, { entidade, entidadeId, acao, antes = null, depois = null, motivo = null, correlacao = null }) {
  await c.query(
    `INSERT INTO partnership_audit_events (organization_id, store_id, entity_type, entity_id, action, before_state, after_state, reason, actor_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      ctx.organizationId, ctx.storeId, entidade, String(entidadeId), acao,
      antes === null ? null : JSON.stringify(antes), depois === null ? null : JSON.stringify(depois),
      motivo, ctx.userId || null, correlacao || null,
    ]
  );
}

const novoUuid = () => crypto.randomUUID();

// Paginação server-side com teto.
function paginacao(query, { padrao = 25, maximo = 100 } = {}) {
  const limite = Math.min(Math.max(Number.parseInt(query.limit, 10) || padrao, 1), maximo);
  const deslocamento = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
  return { limite, deslocamento };
}

function textoOpcional(valor, { max, nome }) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor !== 'string') throw entradaInvalida(`${nome} deve ser texto`);
  const t = valor.trim();
  if (t.length > max) throw entradaInvalida(`${nome} excede ${max} caracteres`);
  return t === '' ? null : t;
}

function textoObrigatorio(valor, { max, nome }) {
  const t = textoOpcional(valor, { max, nome });
  if (t === null) throw entradaInvalida(`${nome} é obrigatório`);
  return t;
}

function inteiro(valor, { nome, min = 0, max = Number.MAX_SAFE_INTEGER, obrigatorio = true }) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw entradaInvalida(`${nome} é obrigatório`);
    return null;
  }
  const n = typeof valor === 'number' ? valor : Number(valor);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw entradaInvalida(`${nome} deve ser um inteiro entre ${min} e ${max}`);
  return n;
}

function dataIso(valor, { nome, obrigatorio = true }) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw entradaInvalida(`${nome} é obrigatório`);
    return null;
  }
  const d = new Date(valor);
  if (typeof valor !== 'string' && !(valor instanceof Date)) throw entradaInvalida(`${nome} inválido`);
  if (Number.isNaN(d.getTime())) throw entradaInvalida(`${nome} inválido`);
  return d;
}

function opcao(valor, permitidos, { nome, padrao = null }) {
  if (valor === undefined || valor === null || valor === '') {
    if (padrao !== null) return padrao;
    throw entradaInvalida(`${nome} é obrigatório`);
  }
  if (!permitidos.includes(valor)) throw entradaInvalida(`${nome} deve ser um de: ${permitidos.join(', ')}`);
  return valor;
}

module.exports = {
  UUID_RE, AfiliadosError, erro, naoEncontrado, entradaInvalida, conflito, exigirUuid, tx, travarChave, auditar, novoUuid,
  paginacao, textoOpcional, textoObrigatorio, inteiro, dataIso, opcao,
};
