'use strict';

// Planos e features (§10, §11).
//
// `plans` é vocabulário TÉCNICO de acesso, não catálogo comercial: não há preço, trial, cupom nem
// cadência (§36 — pricing/billing seguem em aberto). Um plano é um conjunto nomeado de features do
// vocabulário fechado.
//
// Feature desconhecida → REJEITA (422). Em três camadas: aqui, no domain `platform_feature` do
// banco, e no registry copiado em lib/entitlements.js. Um teste compara as três.

const { emTransacao } = require('./db');
const audit = require('./audit');
const { erro404, erro409, erro422 } = require('./http');
const { exigirFeaturesConhecidas, FeatureDesconhecidaError } = require('./entitlements');

const CHAVE_RE = /^[a-z][a-z0-9_]{1,62}$/;

function traduzirFeature(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      if (err instanceof FeatureDesconhecidaError) {
        throw erro422('feature_desconhecida', 'feature fora do vocabulário', { features: err.features });
      }
      throw err;
    }
  };
}

const validarFeatures = traduzirFeature(exigirFeaturesConhecidas);

function criarServicoDePlanos({ pool }) {
  const SELECT = `
    SELECT p.id, p.chave, p.nome, p.descricao, p.status, p.criado_em, p.atualizado_em,
           COALESCE((SELECT array_agg(f.feature::text ORDER BY f.feature)
                       FROM plan_features f WHERE f.plan_id = p.id AND f.habilitada), '{}') AS features,
           (SELECT count(*)::int FROM organization_subscriptions s
             WHERE s.plan_id = p.id AND s.status = 'active') AS assinaturas_ativas
      FROM plans p`;

  function paraApi(linha) {
    return {
      id: linha.id,
      chave: linha.chave,
      nome: linha.nome,
      descricao: linha.descricao,
      status: linha.status,
      features: linha.features,
      assinaturasAtivas: linha.assinaturas_ativas,
      criadoEm: linha.criado_em,
      atualizadoEm: linha.atualizado_em,
    };
  }

  async function listar({ limite = 50, cursor = null }) {
    const { rows } = await pool.query(
      `${SELECT}
        WHERE ($1::timestamptz IS NULL OR (p.criado_em, p.id) < ($1, $2))
        ORDER BY p.criado_em DESC, p.id DESC
        LIMIT $3`,
      [cursor ? cursor.em : null, cursor ? cursor.id : null, limite + 1]
    );
    return { rows, paraApi };
  }

  async function buscar(planId, cliente = pool) {
    const { rows } = await cliente.query(`${SELECT} WHERE p.id = $1`, [planId]);
    return rows[0] ? paraApi(rows[0]) : null;
  }

  async function buscarPorChave(chave, cliente = pool) {
    const { rows } = await cliente.query(`${SELECT} WHERE p.chave = $1`, [chave]);
    return rows[0] ? paraApi(rows[0]) : null;
  }

  async function criar({ ator, chave, nome, descricao, features }) {
    if (!CHAVE_RE.test(chave)) {
      throw erro422('chave_invalida', 'chave precisa casar ^[a-z][a-z0-9_]{1,62}$');
    }
    validarFeatures(features);
    return emTransacao(pool, async (c) => {
      const { rows } = await c.query(
        'INSERT INTO plans (chave, nome, descricao) VALUES ($1, $2, $3) RETURNING id',
        [chave, nome, descricao]
      ).catch((err) => {
        if (err.code === '23505') throw erro409('chave_em_uso', 'já existe um plano com esta chave');
        throw err;
      });
      const planId = rows[0].id;
      await gravarFeatures(c, planId, features);
      await audit.registrar(c, {
        ator,
        action: 'plan.created',
        entityType: 'plan',
        entityId: planId,
        after: { chave, nome, features: [...features].sort() },
      });
      return buscar(planId, c);
    });
  }

  async function atualizar({ ator, planId, nome, descricao }) {
    return emTransacao(pool, async (c) => {
      const antes = await buscar(planId, c);
      if (!antes) throw erro404();
      const { rows } = await c.query(
        `UPDATE plans SET nome = COALESCE($2, nome), descricao = COALESCE($3, descricao), atualizado_em = now()
          WHERE id = $1 RETURNING id`,
        [planId, nome, descricao]
      );
      if (!rows.length) throw erro404();
      const depois = await buscar(planId, c);
      await audit.registrar(c, {
        ator,
        action: 'plan.updated',
        entityType: 'plan',
        entityId: planId,
        before: { nome: antes.nome, descricao: antes.descricao },
        after: { nome: depois.nome, descricao: depois.descricao },
      });
      return depois;
    });
  }

  // Substitui o conjunto. Conjunto explícito, sempre — nada de "acrescenta o que veio".
  async function substituirFeatures({ ator, planId, features }) {
    validarFeatures(features);
    return emTransacao(pool, async (c) => {
      const antes = await buscar(planId, c);
      if (!antes) throw erro404();
      await c.query('DELETE FROM plan_features WHERE plan_id = $1', [planId]);
      await gravarFeatures(c, planId, features);
      const depois = await buscar(planId, c);
      await audit.registrar(c, {
        ator,
        action: 'plan.features_replaced',
        entityType: 'plan',
        entityId: planId,
        before: { features: antes.features },
        after: { features: depois.features },
      });
      return depois;
    });
  }

  async function arquivar({ ator, planId }) {
    return emTransacao(pool, async (c) => {
      const antes = await buscar(planId, c);
      if (!antes) throw erro404();
      if (antes.status === 'archived') return antes;
      if (antes.assinaturasAtivas > 0) {
        throw erro409('plano_com_assinatura_ativa',
          'mova as Organizations para outro plano antes de arquivar',
          { assinaturasAtivas: antes.assinaturasAtivas });
      }
      await c.query(`UPDATE plans SET status = 'archived', atualizado_em = now() WHERE id = $1`, [planId]);
      const depois = await buscar(planId, c);
      await audit.registrar(c, {
        ator,
        action: 'plan.archived',
        entityType: 'plan',
        entityId: planId,
        before: { status: antes.status },
        after: { status: depois.status },
      });
      return depois;
    });
  }

  async function gravarFeatures(cliente, planId, features) {
    const unicas = [...new Set(features)];
    if (!unicas.length) return;
    await cliente.query(
      `INSERT INTO plan_features (plan_id, feature, habilitada)
       SELECT $1, f, true FROM unnest($2::text[]) AS f`,
      [planId, unicas]
    ).catch((err) => {
      // O domain do banco é a terceira camada: se ela reclamar, a lista passou pelas duas primeiras
      // — o que é defeito de código, não entrada inválida.
      if (err.code === '23514') throw erro422('feature_desconhecida', 'feature fora do vocabulário do banco');
      throw err;
    });
  }

  return { listar, buscar, buscarPorChave, criar, atualizar, substituirFeatures, arquivar, paraApi };
}

module.exports = { CHAVE_RE, criarServicoDePlanos };
