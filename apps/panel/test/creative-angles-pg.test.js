'use strict';

// Fase D · o pgStore dos ângulos customizados contra um Postgres de verdade: identidade própria por escopo
// (slug único DENTRO do escopo, não global), CHECK scope/store_id, FK composta da Store, RLS/isolamento e
// versionamento no UPDATE. Roda com `node scripts/test-db.mjs run -- ...`; com TEST_APP_ROLE=1 o store roda
// como oria_app (RLS forçada), como no server.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const URL_TESTE = process.env.CREATIVE_TEST_DATABASE_URL;
const opcoes = { skip: URL_TESTE ? false : 'defina CREATIVE_TEST_DATABASE_URL para rodar contra Postgres' };

const TENANT = 'a1000000-0000-4000-8000-000000000001';
const OUTRO = 'a1000000-0000-4000-8000-000000000002';
const STORE = 'a2000000-0000-4000-8000-000000000001';
const STORE_DO_OUTRO = 'a2000000-0000-4000-8000-000000000002';

function storeNoContexto(store) {
  const { comContexto } = require('../lib/platform/tenant-runtime');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return new Proxy(store, {
    get(alvo, prop) {
      const v = alvo[prop];
      if (typeof v !== 'function') return v;
      return (...args) => {
        const organizationId = [args[0], args[1]].find((a) => UUID.test(String(a)));
        return comContexto({ organizationId, origem: 'teste' }, () => v.apply(alvo, args));
      };
    },
  });
}

test('pgStore dos ângulos: identidade por escopo, CHECK, FK da Store, RLS e versionamento', opcoes, async () => {
  const { Pool } = require('pg');
  const { createPgStore } = require('../lib/creative-core/pgStore');
  const { criarPoolTenant } = require('../lib/platform/tenant-runtime');

  const modoApp = process.env.TEST_APP_ROLE === '1';
  const dono = new Pool({ connectionString: modoApp ? process.env.TEST_OWNER_DATABASE_URL : URL_TESTE });
  const poolApp = modoApp ? new Pool({ connectionString: URL_TESTE }) : null;
  try {
    const store = modoApp ? storeNoContexto(createPgStore(criarPoolTenant(poolApp))) : createPgStore(dono);

    // ── criação + identidade própria por escopo ──
    const org1 = await store.createAngle(TENANT, { slug: 'campanha-anual', name: 'Campanha Anual', family: 'connection', peopleMode: 'required' });
    assert.deepEqual([org1.scope, org1.storeId, org1.version, org1.active], ['organization', null, 1, true]);
    const store1 = await store.createAngle(TENANT, { storeId: STORE, slug: 'campanha-anual', name: 'Campanha da Loja', family: 'lifestyle', peopleMode: 'optional' });
    assert.deepEqual([store1.scope, store1.storeId], ['store', STORE]);
    assert.notEqual(org1.id, store1.id, 'mesmo slug, escopos diferentes: dois ângulos, nenhuma sobrescrita');

    // Mesmo slug, MESMO escopo (Organization) → recusado pelo índice único parcial.
    await assert.rejects(
      store.createAngle(TENANT, { slug: 'campanha-anual', name: 'Duplicado', family: 'connection', peopleMode: 'required' }),
      /uq_creative_angles_org_slug/,
    );
    // Mesmo slug, mesma Store → recusado pelo outro índice único parcial.
    await assert.rejects(
      store.createAngle(TENANT, { storeId: STORE, slug: 'campanha-anual', name: 'Duplicado', family: 'lifestyle', peopleMode: 'optional' }),
      /uq_creative_angles_store_slug/,
    );
    // Mesmo slug, OUTRA Store da mesma Organization → permitido (identidade própria).
    const outraLoja = crypto.randomUUID();
    await dono.query(`INSERT INTO stores (id, organization_id, nome) VALUES ($1, $2, 'Segunda loja')`, [outraLoja, TENANT]).catch(() => {});
    const existeSegunda = (await dono.query('SELECT 1 FROM stores WHERE id = $1', [outraLoja])).rowCount > 0;
    if (existeSegunda) {
      const store2 = await store.createAngle(TENANT, { storeId: outraLoja, slug: 'campanha-anual', name: 'Campanha da Loja 2', family: 'lifestyle', peopleMode: 'optional' });
      assert.equal(store2.storeId, outraLoja);
    }

    // ── CHECK scope/store_id amarrados ──
    await assert.rejects(dono.query(
      `INSERT INTO creative_angles (organization_id, scope, store_id, slug, name, family, people_mode) VALUES ($1, 'organization', $2, 'x', 'X', 'lifestyle', 'optional')`,
      [TENANT, STORE]), /ck_creative_angles_scope_store/);
    await assert.rejects(dono.query(
      `INSERT INTO creative_angles (organization_id, scope, store_id, slug, name, family, people_mode) VALUES ($1, 'store', NULL, 'y', 'Y', 'lifestyle', 'optional')`,
      [TENANT]), /ck_creative_angles_scope_store/);

    // ── FK composta: a Store precisa ser da MESMA Organization ──
    await assert.rejects(
      store.createAngle(TENANT, { storeId: STORE_DO_OUTRO, slug: 'invasao', name: 'Invasão', family: 'lifestyle', peopleMode: 'optional' }),
      /fk_creative_angles_store/,
    );

    // ── outros CHECKs de vocabulário ──
    await assert.rejects(dono.query(
      `INSERT INTO creative_angles (organization_id, scope, slug, name, family, people_mode) VALUES ($1, 'organization', 'z', 'Z', 'nao_existe', 'optional')`,
      [TENANT]), /creative_angles_family_check/);
    await assert.rejects(dono.query(
      `INSERT INTO creative_angles (organization_id, scope, slug, name, family, people_mode) VALUES ($1, 'organization', 'w', 'W', 'lifestyle', 'sempre')`,
      [TENANT]), /creative_angles_people_mode_check/);

    // ── versionamento: UPDATE incrementa, nunca reescreve em outra linha ──
    const editado = await store.updateAngle(TENANT, org1.id, { name: 'Campanha Anual 2026' });
    assert.deepEqual([editado.id, editado.version, editado.name], [org1.id, 2, 'Campanha Anual 2026']);
    const arquivado = await store.archiveAngle(TENANT, org1.id);
    assert.equal(arquivado, true);
    assert.equal((await store.getAngle(TENANT, org1.id)).active, false);
    assert.deepEqual((await store.listAngles(TENANT, { storeId: STORE })).map((a) => a.id).includes(org1.id), false, 'arquivado some da listagem ativa');
    assert.deepEqual((await store.listAngles(TENANT, { storeId: STORE, includeInactive: true })).map((a) => a.id).includes(org1.id), true);

    // ── resolução: Organization aparece em qualquer Store dela; Store só na dela ──
    const vistoPelaStore = await store.listAngles(TENANT, { storeId: STORE });
    assert.ok(vistoPelaStore.some((a) => a.id === store1.id), 'ângulo da própria Store aparece');
    const vistoPelaOutraLojaQualquer = await store.listAngles(TENANT, { storeId: crypto.randomUUID() });
    assert.deepEqual(vistoPelaOutraLojaQualquer.map((a) => a.id).includes(store1.id), false, 'ângulo de OUTRA Store não aparece');

    // ── isolamento entre Organizations (RLS) ──
    const doOutro = await store.createAngle(OUTRO, { slug: 'so-do-outro', name: 'Só do outro', family: 'lifestyle', peopleMode: 'optional' });
    assert.equal(await store.getAngle(TENANT, doOutro.id), null, 'outra Organization não enxerga');
    assert.equal(await store.updateAngle(TENANT, doOutro.id, { name: 'invadido' }), null);
    assert.equal(await store.archiveAngle(TENANT, doOutro.id), false);
    assert.equal((await store.getAngle(OUTRO, doOutro.id)).name, 'Só do outro', 'nada mudou de fato');
    assert.deepEqual((await store.listAngles(TENANT, {})).map((a) => a.id).includes(doOutro.id), false);
  } finally {
    await dono.query('DELETE FROM creative_angles WHERE organization_id = ANY($1)', [[TENANT, OUTRO]]).catch(() => {});
    await dono.query(`DELETE FROM stores WHERE organization_id = $1 AND nome = 'Segunda loja'`, [TENANT]).catch(() => {});
    await dono.end();
    if (poolApp) await poolApp.end();
  }
});
