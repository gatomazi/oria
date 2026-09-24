'use strict';

// Fase E · `property_id` continua onde já está: `google_analytics_connections`, por Store — não
// migra para `integrations.config` (§4.7 do comando: não duplicar por conveniência do connector).
// Esta é a "porta/repository pequeno e explícito" pedida: só lê a config, nunca o segredo.
//
// `pool` é a fachada tenant-scoped (lib/platform/tenant-runtime.js) — a query já roda sob RLS,
// mesmo padrão da porta B.1 (connector-integration-port.js).

/**
 * @param {{pool: {query: Function}}} opcoes
 */
function createGa4PropertyRepository({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createGa4PropertyRepository exige pool');

  /**
   * @param {{organizationId: string, storeId: string}} entrada
   * @returns {Promise<{propertyId: string, propertyName: string|null, status: string}|null>}
   */
  async function getProperty({ organizationId, storeId }) {
    if (!organizationId || !storeId) throw new TypeError('getProperty exige organizationId e storeId');
    const { rows } = await pool.query(
      `SELECT property_id, property_name, status FROM google_analytics_connections
        WHERE organization_id = $1 AND store_id = $2`,
      [organizationId, storeId]
    );
    if (rows.length > 1) {
      throw Object.assign(new Error('mais de uma conexão GA4 para a mesma Store'), { codigo: 'GA4_CONNECTION_INTEGRITY_ERROR' });
    }
    const linha = rows[0];
    if (!linha || !linha.property_id) return null;
    return { propertyId: linha.property_id, propertyName: linha.property_name || null, status: linha.status };
  }

  return Object.freeze({ getProperty });
}

module.exports = { createGa4PropertyRepository };
