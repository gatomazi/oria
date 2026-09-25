'use strict';

// Fase 5c · TD-006 / INV-18 — lease persistente dos jobs.
//
// Todo job que envia mensagem, consome cota, faz follow-up ou processa fila roda, por Organization,
// só depois de a réplica conseguir o lease no Postgres (job_lease_adquirir, SECURITY DEFINER).
// Nada de flag em memória como única trava: duas réplicas veem o mesmo banco, não a mesma memória.
//
//   adquirir(job, org, ttl)        true só para um dono; vence sozinho depois do ttl (queda)
//   concluir(job, org, intervalo)  libera e marca a próxima janela = início + intervalo
//
// O lease é por rodada, não por item. Itens (destinatários de campanha, fila do Go) têm a própria
// reivindicação com FOR UPDATE SKIP LOCKED — e um item que ficou "em andamento" por queda não é
// reenviado às cegas (vira falha visível).

const crypto = require('crypto');
const os = require('os');
const { semContexto } = require('./tenant-runtime');

const JOB_RE = /^[a-z0-9:_-]{1,80}$/;
const TTL_MINIMO_MS = 30 * 60 * 1000;

function donoPadrao() {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
}

function ttlPara(intervaloMs) {
  return Math.max(TTL_MINIMO_MS, 2 * (intervaloMs || 0));
}

function createJobLeases({ poolReal, dono = donoPadrao() }) {
  if (!poolReal) throw new Error('createJobLeases exige o pool');

  function conferir(job, organizationId) {
    if (!JOB_RE.test(job)) throw new Error(`nome de job inválido para lease: ${job}`);
    if (!organizationId) throw new Error('lease sem organization');
  }

  async function adquirir(job, organizationId, ttlMs) {
    conferir(job, organizationId);
    const { rows } = await semContexto(() => poolReal.query(
      'SELECT job_lease_adquirir($1, $2, $3, $4) AS ok', [job, organizationId, dono, Math.round(ttlMs)]
    ));
    return rows[0].ok === true;
  }

  async function concluir(job, organizationId, intervaloMs) {
    conferir(job, organizationId);
    const { rows } = await semContexto(() => poolReal.query(
      'SELECT job_lease_concluir($1, $2, $3, $4) AS ok', [job, organizationId, dono, Math.round(intervaloMs || 0)]
    ));
    return rows[0].ok === true;
  }

  // Kill switch: libera o lease IGNORANDO quem é o dono — quem chama isto é uma pessoa na tela,
  // nunca o processo que pediu o lease originalmente (esse, se ainda existir, só conhece `concluir`).
  // Não mata o processo antigo, só libera a trava pra um run novo poder começar.
  async function liberarForcado(job, organizationId) {
    conferir(job, organizationId);
    const { rows } = await semContexto(() => poolReal.query(
      'SELECT job_lease_liberar_forcado($1, $2) AS ok', [job, organizationId]
    ));
    return rows[0].ok === true;
  }

  return { adquirir, concluir, liberarForcado, dono };
}

module.exports = { createJobLeases, ttlPara, donoPadrao };
