'use strict';

// Gates estruturais da Fase 1, lidos do catálogo do Postgres. Devolvem VIOLAÇÕES (lista vazia =
// PASS) em vez de lançar, para que os testes mostrem todas de uma vez e os negative controls possam
// medir cada classe separadamente.
//
//   INV-04  organization_id NOT NULL em toda tabela tenant-owned
//   INV-05  toda UNIQUE e toda PK inclui organization_id; FK entre tabelas tenant-owned é composta;
//           nenhuma UNIQUE transitória declarada no manifesto (sem exceção)
//   INV-06  nenhuma tabela tenant-owned é single-row
//   INV-07  RLS habilitada E forçada; toda policy exige o contexto em USING e em WITH CHECK
//   1:1     cada Organization tem exatamente uma Store ativa (constraint + dado) — PD-002
//   (+)     toda tabela do schema está classificada no manifesto

const CONFIG_ORGANIZATION = 'app.current_organization_id';

// Forma canônica da policy, como o Postgres a devolve em pg_policies. Comparação EXATA: "contém o
// nome da configuração" deixaria passar `... OR true`.
const policyCanonica = (coluna) =>
  `(${coluna} = (NULLIF(current_setting('${CONFIG_ORGANIZATION}'::text, true), ''::text))::uuid)`;

async function inspecionarTenancy(client, manifesto) {
  const tenant = manifesto.TABELAS_TENANT;
  const nomesTenant = tenant.map((x) => x.tabela);
  const sobRls = manifesto.nomesSobRls();
  const v = {
    naoClassificadas: [],
    inexistentes: [],
    inv04: [],
    inv05: [],
    inv06: [],
    inv07: [],
    card1a1: [],
  };

  const { rows: tabelas } = await client.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`
  );
  const porNome = new Map(tabelas.map((r) => [r.relname, r]));
  const classificadas = new Set([
    ...sobRls,
    ...manifesto.TABELAS_GLOBAIS.map((x) => x.tabela),
  ]);
  for (const r of tabelas) {
    // harness_* são fixtures de teste criadas pelos próprios testes, nunca por migration.
    if (!classificadas.has(r.relname) && !r.relname.startsWith('harness_')) v.naoClassificadas.push(r.relname);
  }
  for (const nome of sobRls) if (!porNome.has(nome)) v.inexistentes.push(nome);

  // INV-04
  const { rows: cols } = await client.query(
    `SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'organization_id' AND table_name = ANY($1)`,
    [nomesTenant]
  );
  const colPorTabela = new Map(cols.map((r) => [r.table_name, r.is_nullable]));
  for (const nome of nomesTenant) {
    if (!porNome.has(nome)) continue;
    if (!colPorTabela.has(nome)) v.inv04.push(`${nome}: sem organization_id`);
    else if (colPorTabela.get(nome) !== 'NO') v.inv04.push(`${nome}: organization_id nullable`);
  }

  // INV-05
  const { rows: indices } = await client.query(
    `SELECT t.relname AS tabela, i.relname AS indice, x.indisprimary AS pk,
            pg_get_indexdef(x.indexrelid) AS def,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS colunas
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND x.indisunique AND t.relname = ANY($1)`,
    [nomesTenant]
  );
  for (const idx of indices) {
    if (!(idx.colunas || []).includes('organization_id') && !/\borganization_id\b/.test(idx.def)) {
      v.inv05.push(`${idx.tabela}.${idx.indice}: ${idx.pk ? 'PK' : 'UNIQUE'} sem organization_id (${idx.def})`);
    }
  }
  for (const x of tenant) {
    for (const legada of x.uniquesLegadas) {
      v.inv05.push(`${x.tabela}.${legada}: UNIQUE global transitória declarada no manifesto — precisa ser zero`);
    }
  }
  const { rows: fks } = await client.query(
    `SELECT t.relname AS tabela, c.conname, pg_get_constraintdef(c.oid) AS def,
            (SELECT array_agg(a.attname::text) FROM unnest(c.conkey) k(attnum)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS colunas
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_class r ON r.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND c.contype = 'f' AND t.relname = ANY($1) AND r.relname = ANY($1)`,
    [nomesTenant]
  );
  for (const f of fks) {
    if (!(f.colunas || []).includes('organization_id')) {
      v.inv05.push(`${f.tabela}.${f.conname}: FK entre tabelas tenant-owned sem organization_id (${f.def})`);
    }
  }
  const nomesIdx = new Set(indices.map((i) => `${i.tabela}.${i.indice}`));
  for (const x of tenant) {
    for (const u of x.uniques) {
      if (!nomesIdx.has(`${x.tabela}.${u.nome}`)) v.inv05.push(`${x.tabela}.${u.nome}: UNIQUE por Organization declarada e ausente`);
    }
  }

  // INV-06
  const { rows: checks } = await client.query(
    `SELECT t.relname AS tabela, c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND c.contype = 'c' AND t.relname = ANY($1)`,
    [nomesTenant]
  );
  for (const c of checks) {
    if (/\(\s*\(?\s*id\s*=\s*-?\d+\s*\)?\s*\)/i.test(c.def)) v.inv06.push(`${c.tabela}.${c.conname}: ${c.def}`);
  }
  const { rows: ids } = await client.query(
    `SELECT table_name, column_default, identity_generation FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND table_name = ANY($1)`,
    [nomesTenant]
  );
  for (const r of ids) {
    if (r.column_default === null && r.identity_generation === null) {
      const { rows: tipo } = await client.query(
        `SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`,
        [r.table_name]
      );
      // id inteiro sem gerador = alguém escolhe o valor à mão — o desenho de "linha 1" (uuid é gerado pela aplicação).
      if (tipo[0].data_type !== 'uuid') v.inv06.push(`${r.table_name}.id: inteiro sem default/identity`);
    }
  }

  // INV-07
  const { rows: policies } = await client.query(
    `SELECT tablename, policyname, permissive, cmd, qual, with_check
       FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [sobRls]
  );
  for (const nome of sobRls) {
    const r = porNome.get(nome);
    if (!r) continue;
    if (!r.relrowsecurity) v.inv07.push(`${nome}: RLS desabilitada`);
    if (!r.relforcerowsecurity) v.inv07.push(`${nome}: RLS não forçada (a dona escapa)`);
    const ps = policies.filter((p) => p.tablename === nome);
    if (!ps.length) v.inv07.push(`${nome}: sem policy`);
    const coluna = (manifesto.TABELAS_PLATAFORMA.find((x) => x.tabela === nome) || {}).colunaTenant || 'organization_id';
    const esperado = policyCanonica(coluna);
    for (const p of ps) {
      // Policies permissivas se somam por OR: UMA fora da forma canônica abre a tabela inteira.
      if (p.cmd !== 'ALL') v.inv07.push(`${nome}.${p.policyname}: policy só para ${p.cmd} — esperado ALL`);
      if (p.qual !== esperado) v.inv07.push(`${nome}.${p.policyname}: USING fora da forma canônica: ${p.qual}`);
      if (p.with_check !== esperado) v.inv07.push(`${nome}.${p.policyname}: WITH CHECK fora da forma canônica: ${p.with_check}`);
    }
  }

  // 1:1 Organization ↔ Store ativa (PD-002): na constraint e no dado.
  const { rows: unicasStore } = await client.query(
    `SELECT pg_get_indexdef(x.indexrelid) AS def, pg_get_expr(x.indpred, x.indrelid) AS predicado,
            (SELECT array_agg(a.attname::text) FROM unnest(x.indkey) k(attnum)
               JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) AS colunas
       FROM pg_index x WHERE x.indrelid = to_regclass('public.stores') AND x.indisunique`
  );
  const garante = unicasStore.some((u) => (u.colunas || []).length === 1 && u.colunas[0] === 'organization_id'
    && (u.predicado === null || /^\(?ativa\)?$/.test(u.predicado)));
  if (porNome.has('stores') && !garante) {
    v.card1a1.push('stores: nenhuma UNIQUE (organization_id) [WHERE ativa] — o banco não garante uma Store ativa por Organization');
  }
  if (porNome.has('stores') && porNome.has('organizations')) {
    const { rows: [d] } = await client.query(
      `SELECT
         (SELECT count(*)::int FROM (SELECT organization_id FROM stores WHERE ativa
            GROUP BY organization_id HAVING count(*) > 1) x) AS com_varias,
         (SELECT count(*)::int FROM organizations o
            WHERE NOT EXISTS (SELECT 1 FROM stores s WHERE s.organization_id = o.id AND s.ativa)) AS sem_store,
         (SELECT count(*)::int FROM stores s
            WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = s.organization_id)) AS store_orfa`
    );
    if (d.com_varias) v.card1a1.push(`${d.com_varias} Organization(s) com mais de uma Store ativa`);
    if (d.sem_store) v.card1a1.push(`${d.sem_store} Organization(s) sem Store ativa`);
    if (d.store_orfa) v.card1a1.push(`${d.store_orfa} Store(s) sem Organization`);
  }

  return v;
}

function todasAsViolacoes(v) {
  return Object.entries(v).flatMap(([classe, lista]) => lista.map((x) => `[${classe}] ${x}`));
}

module.exports = { CONFIG_ORGANIZATION, policyCanonica, inspecionarTenancy, todasAsViolacoes };
