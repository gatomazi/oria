'use strict';

// Regra de ownership fail-closed. INV-09 e INV-11 vivem aqui.
//
// Contexto: a auditoria achou `lojaAtribuidaPadrao()` (`server.js:11873-11876` em 8a7ea3d), que
// devolve a única loja atribuída quando existe exatamente uma. Isso é o padrão que a regra
// fail-closed do plano proíbe por escrito:
//
//     erro · exclusão · sinalização      ← sempre
//     inferir o único candidato          ← nunca
//
// E é o defeito mais difícil de detectar por teste, porque ele só se manifesta quando há UM
// candidato. O banco de produção tem três lojas; com três lojas, `lojaAtribuidaPadrao()` devolve
// null e parece correto. É por isso que ele sobreviveu à auditoria — e é por isso que o teste
// decisivo (test/invariants/inv-09-ownership.test.js) semeia UMA organization, não três.

class OwnershipUnresolvedError extends Error {
  constructor(message, { recurso = null, motivo = 'unassigned' } = {}) {
    super(message);
    this.name = 'OwnershipUnresolvedError';
    this.recurso = recurso;
    this.motivo = motivo;
  }
}

class CrossTenantAccessError extends Error {
  constructor(message, { recurso = null } = {}) {
    super(message);
    this.name = 'CrossTenantAccessError';
    this.recurso = recurso;
  }
}

function vazio(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

// Resolve a organization dona de um recurso.
//
// O parâmetro `candidatas` existe DE PROPÓSITO, e de propósito não é usado para decidir nada: ele
// está aqui para que o negative control possa introduzir exatamente o defeito histórico
// ("se só há uma candidata, use-a") e o invariant possa reprovar. Uma função que nem recebesse a
// lista tornaria o defeito impossível de escrever aqui — e o defeito não some do sistema por não
// caber nesta função: ele volta no próximo helper que alguém escrever com a lista à mão.
function resolveOwnerOrganization({ recurso, organizationIdDoRecurso, candidatas = [] } = {}) {
  void candidatas;

  if (vazio(organizationIdDoRecurso)) {
    throw new OwnershipUnresolvedError(
      `recurso ${recurso ?? '(sem id)'} não tem organization atribuída — ` +
      'ausência de escopo é erro, nunca "use a única que existe" (INV-09)',
      { recurso, motivo: 'unassigned' }
    );
  }

  return String(organizationIdDoRecurso);
}

// Autoriza o acesso a um recurso carregado por id. INV-20.
// Recurso sem dono NÃO é acessível por ninguém — nem pela única organization do banco.
function assertOwnership({ recurso, organizationIdDoRecurso, organizationIdDoContexto, candidatas = [] } = {}) {
  if (vazio(organizationIdDoContexto)) {
    throw new OwnershipUnresolvedError(
      'contexto sem organization — o pipeline de tenant não rodou',
      { recurso, motivo: 'no-context' }
    );
  }

  const dono = resolveOwnerOrganization({ recurso, organizationIdDoRecurso, candidatas });

  if (dono !== String(organizationIdDoContexto)) {
    throw new CrossTenantAccessError(
      `recurso ${recurso ?? '(sem id)'} pertence a outra organization`,
      { recurso }
    );
  }

  return dono;
}

// INV-11 — particiona uma lista de recursos em "contabilizáveis" e "sinalizados". O recurso sem
// dono, ou de outro tenant, fica FORA do total e é devolvido para ser sinalizado. Nunca some em
// silêncio (o que esconderia o problema) e nunca entra na soma (o que é o defeito F-01: a DRE
// consome mídia sem conferir atribuição).
function particionarPorOwnership(recursos, organizationIdDoContexto, { idDe = (r) => r.id, orgDe = (r) => r.organization_id } = {}) {
  const inclusos = [];
  const sinalizados = [];
  for (const recurso of recursos) {
    try {
      assertOwnership({
        recurso: idDe(recurso),
        organizationIdDoRecurso: orgDe(recurso),
        organizationIdDoContexto,
      });
      inclusos.push(recurso);
    } catch (err) {
      sinalizados.push({ recurso, motivo: err.name === 'CrossTenantAccessError' ? 'cross-tenant' : err.motivo });
    }
  }
  return { inclusos, sinalizados };
}

// ── Recurso por id nas rotas (Fase 3 · F-03 / INV-20) ──────────────────────────────────────
// Toda rota que recebe um id de recurso do banco passa por `exigirRecurso` ANTES do handler: a
// linha é lida com predicado explícito da Organization da sessão (além da RLS por baixo) e
// conferida por assertOwnership. Recurso de outra Organization e recurso inexistente dão a MESMA
// resposta: 404 — um 403 confirmaria que o id existe em algum lugar.

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
// Valor de id malformado para o tipo da coluna (uuid/bigint) é "não encontrado", não 500.
const ERROS_DE_VALOR = new Set(['22P02', '22003']);

function validarTabela(tabela, coluna) {
  // Carregados aqui para o módulo continuar puro para quem só usa as regras acima.
  const { nomesSobRls } = require('./tenancy-manifest');
  if (!nomesSobRls().includes(tabela)) throw new Error(`ownership: ${tabela} não é tabela de tenant`);
  if (!IDENT_RE.test(coluna)) throw new Error(`ownership: coluna inválida ${coluna}`);
}

// Devolve a linha da Organization do contexto, ou null.
async function buscarDaOrganizacao(pool, tabela, valor, { coluna = 'id' } = {}) {
  validarTabela(tabela, coluna);
  const { contextoAtual } = require('./tenant-runtime');
  const ctx = contextoAtual();
  if (!ctx) throw new OwnershipUnresolvedError('contexto sem organization — o pipeline de tenant não rodou', { motivo: 'no-context' });
  if (vazio(valor)) return null;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ${tabela} WHERE organization_id = $1 AND ${coluna} = $2`,
      [ctx.organizationId, valor]
    );
    return rows.length === 1 ? rows[0] : null;
  } catch (err) {
    if (ERROS_DE_VALOR.has(err.code)) return null;
    throw err;
  }
}

// Middleware: `req.recurso` = linha dona do id em req.params[param]; senão 404.
function criarExigirRecurso(obterPool) {
  return function exigirRecurso(tabela, { param = 'id', coluna = 'id' } = {}) {
    validarTabela(tabela, coluna);
    return async function recursoDaOrganizacao(req, res, next) {
      const pool = obterPool();
      if (!pool) return next(); // sem banco: o handler responde 503
      try {
        const { contextoAtual } = require('./tenant-runtime');
        const ctx = contextoAtual();
        const linha = await buscarDaOrganizacao(pool, tabela, req.params[param], { coluna });
        if (!linha) return res.status(404).json({ error: 'não encontrado' });
        assertOwnership({
          recurso: `${tabela}:${req.params[param]}`,
          organizationIdDoRecurso: linha.organization_id,
          organizationIdDoContexto: ctx && ctx.organizationId,
        });
        req.recurso = linha;
        return next();
      } catch (err) {
        if (err instanceof CrossTenantAccessError) return res.status(404).json({ error: 'não encontrado' });
        if (err instanceof OwnershipUnresolvedError) {
          return res.status(err.motivo === 'no-context' ? 403 : 404).json({ error: 'não encontrado' });
        }
        console.error(`[OWNERSHIP] falha ao conferir ${tabela}: ${err.message}`);
        return res.status(500).json({ error: 'falha ao conferir o recurso' });
      }
    };
  };
}

module.exports = {
  OwnershipUnresolvedError,
  CrossTenantAccessError,
  resolveOwnerOrganization,
  assertOwnership,
  particionarPorOwnership,
  buscarDaOrganizacao,
  criarExigirRecurso,
};
