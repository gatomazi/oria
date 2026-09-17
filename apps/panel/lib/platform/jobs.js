'use strict';

// Jobs por Organization (Fase 3 · INV-17) com lease persistente (Fase 5c · INV-18 / TD-006).
//
// Nenhum job descobre escopo lendo "o selecionado" ou percorrendo um enum de processo. O scheduler
// pede ao banco a lista de Organizations ativas (tenancy_organizations_para_jobs, SECURITY
// DEFINER) e roda UMA iteração por Organization dentro de comContexto — toda query do corpo do job
// passa por comOrganization e pela RLS dessa Organization.
//
// Com várias réplicas, cada iteração só roda depois de a réplica conseguir o lease (job,
// Organization) no banco (lib/platform/leases.js): uma execução por intervalo no cluster. Falha ao
// pedir o lease não roda o job (fail-closed) e aparece no log.
//
// Justiça entre Organizations: a ordem da lista gira a cada rodada, e cada iteração processa um
// lote limitado (quem define o lote é o job) — uma Organization com fila enorme não impede as
// outras de rodar na mesma rodada, nem fica sempre na frente.

const { comContexto, semContexto } = require('./tenant-runtime');
const { ttlPara } = require('./leases');

function createJobRunner({ poolReal, leases = null, logger = console }) {
  const rodadas = new Map();

  async function organizacoes() {
    if (!poolReal) return [];
    const { rows } = await semContexto(() => poolReal.query('SELECT * FROM tenancy_organizations_para_jobs()'));
    return rows.map((r) => ({ organizationId: r.organization_id, storeId: r.store_id, loja: r.loja_legada }));
  }

  function emRodizio(nome, lista) {
    if (lista.length < 2) return lista;
    const rodada = rodadas.get(nome) || 0;
    rodadas.set(nome, rodada + 1);
    const inicio = rodada % lista.length;
    return [...lista.slice(inicio), ...lista.slice(0, inicio)];
  }

  // Uma Organization com erro não impede as outras.
  async function executarPorOrganizacao(nome, fn, { intervaloMs = 0, ttlMs = ttlPara(intervaloMs) } = {}) {
    const lista = emRodizio(nome, await organizacoes());
    const resultado = { organizacoes: lista.length, executadas: 0, puladas: 0, falhas: 0 };
    for (const org of lista) {
      if (leases) {
        let ok = false;
        try {
          ok = await leases.adquirir(nome, org.organizationId, ttlMs);
        } catch (err) {
          resultado.falhas += 1;
          logger.error(`[JOB ${nome}] organization ${org.organizationId}: lease indisponível (${err.message}) — não executado`);
          continue;
        }
        if (!ok) {
          resultado.puladas += 1;
          continue;
        }
      }
      try {
        await comContexto({ ...org, origem: `job:${nome}` }, () => fn(org));
        resultado.executadas += 1;
      } catch (err) {
        resultado.falhas += 1;
        logger.error(`[JOB ${nome}] organization ${org.organizationId}: ${err.message}`);
      } finally {
        if (leases) {
          await leases.concluir(nome, org.organizationId, intervaloMs).catch((err) => {
            logger.error(`[JOB ${nome}] organization ${org.organizationId}: falha ao liberar o lease (${err.message})`);
          });
        }
      }
    }
    return resultado;
  }

  // Timer criado fora de qualquer contexto: nem uma request que por acaso o dispare contamina os
  // ciclos seguintes com a Organization dela.
  function agendar(nome, intervaloMs, fn) {
    return semContexto(() => {
      const timer = setInterval(() => {
        executarPorOrganizacao(nome, fn, { intervaloMs }).catch((err) => logger.error(`[JOB ${nome}] ciclo falhou: ${err.message}`));
      }, intervaloMs);
      if (timer.unref) timer.unref();
      return timer;
    });
  }

  function agendarUmaVez(nome, atrasoMs, fn) {
    return semContexto(() => setTimeout(() => {
      executarPorOrganizacao(nome, fn).catch((err) => logger.error(`[JOB ${nome}] falhou: ${err.message}`));
    }, atrasoMs));
  }

  return { organizacoes, executarPorOrganizacao, agendar, agendarUmaVez };
}

module.exports = { createJobRunner };
