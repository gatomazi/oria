'use strict';

// Vigia de armazenamento do Postgres (rodada de otimização de armazenamento).
//
// Por que existe: em 2026-09-26 o full sync agendado esgotou o volume do Postgres (ENOSPC) sem que nada
// avisasse antes — o dono só soube pelo erro. O painel não enxerga o disco do banco (`df`), então o vigia
// usa o que o SQL alcança: tamanho do banco + WAL em disco contra a capacidade configurada do volume
// (`PG_VOLUME_CAPACITY_GB`). É uma aproximação declarada, não um substituto do alerta do provedor.
//
//   > 70 % aviso (warn) · > 80 % crítico (error) · WAL acima de `walAltoBytes` (padrão 1,5 GB) aviso
//
// Por tenant (dentro de comContexto, sob RLS): identities MECÂNICAS de variante reaparecendo (só quando o
// modo é `derived` — esperado 0) e runs do catálogo `running` há mais que o TTL do lease (órfãos).
// Só ids/contagens; nenhum dado de cliente.

const GB = 1024 ** 3;

function avaliarArmazenamento({ dbBytes, walBytes = 0, capacidadeBytes, avisoPct = 70, criticoPct = 80, walAltoBytes = 1.5 * GB }) {
  const alertas = [];
  const uso = (Number(dbBytes) || 0) + (Number(walBytes) || 0);
  let pct = null;
  let nivel = 'ok';
  if (capacidadeBytes > 0) {
    pct = (uso / capacidadeBytes) * 100;
    if (pct > criticoPct) { nivel = 'critico'; alertas.push(`uso do volume ~${pct.toFixed(1)}% (> ${criticoPct}%)`); }
    else if (pct > avisoPct) { nivel = 'aviso'; alertas.push(`uso do volume ~${pct.toFixed(1)}% (> ${avisoPct}%)`); }
  }
  if (walBytes > walAltoBytes) {
    if (nivel === 'ok') nivel = 'aviso';
    alertas.push(`pg_wal em ${(walBytes / GB).toFixed(2)} GB (> ${(walAltoBytes / GB).toFixed(2)} GB)`);
  }
  return { nivel, pct, usoBytes: uso, alertas };
}

function createStorageGuard({ pool, logger = console, capacidadeBytes = 0, modoVariante = 'materialized', ttlLeaseMs = 3 * 60 * 60 * 1000, avisoPct, criticoPct, walAltoBytes } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createStorageGuard exige pool');

  async function tamanhoDoWal() {
    try {
      const { rows } = await pool.query('SELECT COALESCE(sum(size), 0)::bigint AS bytes FROM pg_ls_waldir()');
      return { bytes: Number(rows[0].bytes), medido: true };
    } catch {
      // A role da aplicação não é pg_monitor: sem `pg_ls_waldir` usa o TETO do WAL (max_wal_size).
      try {
        const { rows } = await pool.query(`SELECT setting::bigint * 1048576 AS bytes FROM pg_settings WHERE name = 'max_wal_size'`);
        return { bytes: Number(rows[0].bytes), medido: false };
      } catch { return { bytes: 0, medido: false }; }
    }
  }

  // Global (uma vez por tick, qualquer contexto serve).
  async function verificarVolume() {
    const { rows: [{ bytes }] } = await pool.query('SELECT pg_database_size(current_database())::bigint AS bytes');
    const wal = await tamanhoDoWal();
    const r = avaliarArmazenamento({ dbBytes: Number(bytes), walBytes: wal.bytes, capacidadeBytes, avisoPct, criticoPct, walAltoBytes });
    const linha = `[STORAGE_GUARD] banco=${(Number(bytes) / GB).toFixed(2)}GB wal=${(wal.bytes / GB).toFixed(2)}GB${wal.medido ? '' : '(teto)'} capacidade=${capacidadeBytes ? `${(capacidadeBytes / GB).toFixed(0)}GB uso~${r.pct.toFixed(1)}%` : 'não configurada (PG_VOLUME_CAPACITY_GB)'}`;
    if (r.nivel === 'critico') logger.error(`${linha} CRÍTICO: ${r.alertas.join('; ')}`);
    else if (r.nivel === 'aviso') logger.warn(`${linha} AVISO: ${r.alertas.join('; ')}`);
    else logger.log(linha);
    return { ...r, dbBytes: Number(bytes), walBytes: wal.bytes };
  }

  // Por tenant (dentro de comContexto da Organization).
  async function verificarTenant() {
    const alertas = [];
    let espelho = null;
    if (modoVariante === 'derived') {
      const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM product_external_identities WHERE source = 'commerce_sync' AND namespace LIKE '%.variant_id'`);
      espelho = n;
      if (n > 0) alertas.push(`${n} identity(ies) espelho de variante (commerce_sync) existem com o modo derived — reintrodução ou poda pendente`);
    }
    const { rows: [{ n: orfaos }] } = await pool.query(`SELECT count(*)::int AS n FROM commerce_catalog_sync_logs WHERE status = 'running' AND started_at < now() - ($1::bigint * interval '1 millisecond')`, [ttlLeaseMs]);
    if (orfaos > 0) alertas.push(`${orfaos} run(s) do catálogo 'running' há mais que o lease — órfão(s)`);
    for (const a of alertas) logger.warn(`[STORAGE_GUARD] tenant: ${a}`);
    return { espelho, orfaos, alertas };
  }

  return Object.freeze({ verificarVolume, verificarTenant });
}

module.exports = { avaliarArmazenamento, createStorageGuard };
