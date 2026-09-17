'use strict';

// Gerador do SQL das migrations da Fase 1 a partir do manifesto canônico.
//
// Roda UMA vez por mudança de desenho (`node scripts/tenancy/gerar-sql-fase1.mjs`) e o resultado é
// commitado em `migrations/sql/`: a migration aplicada em produção é o texto revisado, não o que o
// gerador produziria amanhã com um manifesto diferente. Os gates (INV-04..07) conferem, contra o
// banco migrado, que manifesto e SQL continuam de acordo.

const m = require('../../lib/platform/tenancy-manifest');

const CTX = "NULLIF(current_setting('app.current_organization_id', true), '')::uuid";
const UNICOS = ['instalacao', 'meta', 'google_ads'];

const tenant = m.TABELAS_TENANT;
const porRegra = (...regras) => tenant.filter((x) => regras.includes(x.regra));
const JA_TEM_COLUNA = new Set(['integrations', 'integration_secrets']);

const idxOrg = (tab) => `idx_${tab}_org`.slice(0, 63);
const fkOrg = (tab) => `fk_${tab}_org`.slice(0, 63);

function cabecalho(titulo) {
  return `-- ${titulo}\n-- GERADO por scripts/tenancy/gerar-sql-fase1.mjs a partir de lib/platform/tenancy-manifest.js.\n-- Congelado: edite o manifesto e regenere só se o desenho mudar ANTES do primeiro deploy.\n\n`;
}

// ── 0003 · plataforma ───────────────────────────────────────────────────────────────────────
function plataformaUp() {
  return `${cabecalho('Fase 1 · organizations, stores, organization_members, mapeamento legado')}CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  nome TEXT NOT NULL CHECK (btrim(nome) <> ''),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- V1 (PD-002): 1 Organization = 1 Store. A UNIQUE em organization_id É a regra de cardinalidade.
-- Store continua entidade própria; multi-store não existe na V1 (R-02).
CREATE TABLE stores (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  nome TEXT NOT NULL CHECK (btrim(nome) <> ''),
  -- Chave do enum antigo (sul/centro/norte) quando a Store nasceu de uma loja legada.
  loja_legada TEXT UNIQUE,
  ativa BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stores_organization UNIQUE (organization_id)
);

-- Usuários individuais (PD-004). A tabela users e a FK chegam na Fase 2; papéis seguem OPEN.
CREATE TABLE organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  papel TEXT NOT NULL DEFAULT 'member',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_organization_members_user UNIQUE (organization_id, user_id)
);

-- Declaração explícita de dono do dado legado. Global, sem RLS, sem acesso da role da aplicação:
-- só o trigger (SECURITY DEFINER) e o backfill leem. PK (tipo, chave) torna "a mesma chave com dois
-- donos" impossível de gravar.
CREATE TABLE tenancy_mapeamentos (
  tipo TEXT NOT NULL CHECK (tipo IN ('loja', 'sem_loja', 'creative_tenant', 'instalacao', 'meta', 'google_ads')),
  chave TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tipo, chave),
  CHECK ((tipo IN ('instalacao', 'meta', 'google_ads')) = (chave = '*'))
);

CREATE FUNCTION tenancy_org_do_mapeamento(p_tipo TEXT, p_chave TEXT) RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT organization_id FROM public.tenancy_mapeamentos WHERE tipo = p_tipo AND chave = p_chave
$fn$;

-- Compatibilidade TRANSITÓRIA: o código grava sem organization_id. Este trigger usa a Organization
-- do contexto (set_config local, Fase 3) e, fora de contexto (migration, operador), o mapeamento
-- explícito — nunca "o único que existe" — e recusa a gravação quando não há regra. Quando o valor vem explícito, confere as regras que são FATO (loja e tenant do
-- Creative Core) e rejeita divergência; para linha-filha, quem confere é a FK composta. Sai quando todo INSERT passar a informar a Organization do
-- contexto (Fase 3).
CREATE FUNCTION tenancy_preencher_organization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  regra TEXT := TG_ARGV[0];
  dado JSONB := to_jsonb(NEW);
  explicito BOOLEAN;
  contexto UUID := NULLIF(current_setting('app.current_organization_id', true), '')::uuid;
  esperado UUID;
  chave TEXT;
  rotulo TEXT;
BEGIN
  -- Sob contexto de Organization (request ou job da Fase 3), a linha é dela: o valor do contexto
  -- entra como se tivesse sido informado, e as conferências abaixo continuam valendo.
  IF NEW.organization_id IS NULL AND contexto IS NOT NULL THEN
    NEW.organization_id := contexto;
  END IF;
  explicito := NEW.organization_id IS NOT NULL;

  IF regra IN ('loja', 'loja_ou_sem_loja', 'integracao') THEN
    chave := dado ->> CASE WHEN regra = 'integracao' THEN 'escopo' ELSE 'loja' END;
    rotulo := 'loja:' || coalesce(chave, 'NULL');
    IF chave IS NOT NULL THEN
      esperado := public.tenancy_org_do_mapeamento('loja', chave);
      IF explicito AND esperado IS NOT NULL AND esperado <> NEW.organization_id THEN
        RAISE EXCEPTION 'tenancy: %.organization_id % diverge do dono da loja % (%)',
          TG_TABLE_NAME, NEW.organization_id, chave, esperado USING ERRCODE = 'check_violation';
      END IF;
    ELSIF regra = 'loja_ou_sem_loja' AND NOT explicito THEN
      rotulo := 'sem_loja:' || TG_TABLE_NAME;
      esperado := public.tenancy_org_do_mapeamento('sem_loja', TG_TABLE_NAME);
    END IF;
  ELSIF regra = 'pai' THEN
    rotulo := TG_ARGV[1] || '.' || coalesce(dado ->> TG_ARGV[2], 'NULL');
    -- Com dono explícito, a FK composta (organization_id, <fk>) garante que o pai é da mesma
    -- Organization. Sem dono, herda do pai — e o pai precisa ser ÚNICO: STRICT falha fechado se
    -- achar zero ou mais de uma linha, nunca "pega a primeira".
    IF NOT explicito THEN
      BEGIN
        EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', TG_ARGV[1])
          INTO STRICT esperado USING (dado ->> TG_ARGV[2])::BIGINT;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          RAISE EXCEPTION 'tenancy: %: linha-pai % inexistente', TG_TABLE_NAME, rotulo
            USING ERRCODE = 'foreign_key_violation';
        WHEN TOO_MANY_ROWS THEN
          RAISE EXCEPTION 'tenancy: %: linha-pai % ambígua entre Organizations — informe organization_id',
            TG_TABLE_NAME, rotulo USING ERRCODE = 'check_violation';
      END;
    END IF;
  ELSIF regra IN ('instalacao', 'meta', 'google_ads') THEN
    rotulo := regra || ':*';
    IF NOT explicito THEN esperado := public.tenancy_org_do_mapeamento(regra, '*'); END IF;
  ELSIF regra = 'creative' THEN
    rotulo := 'creative_tenant:' || coalesce(dado ->> 'tenant_id', 'NULL');
    esperado := public.tenancy_org_do_mapeamento('creative_tenant', dado ->> 'tenant_id');
    IF explicito AND esperado IS NOT NULL AND esperado <> NEW.organization_id THEN
      RAISE EXCEPTION 'tenancy: %.organization_id % diverge do dono de % (%)',
        TG_TABLE_NAME, NEW.organization_id, rotulo, esperado USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'tenancy: regra desconhecida % em %', regra, TG_TABLE_NAME;
  END IF;

  IF NOT explicito THEN
    IF esperado IS NULL THEN
      RAISE EXCEPTION 'tenancy: % sem organization_id e sem mapeamento explícito para %',
        TG_TABLE_NAME, rotulo USING ERRCODE = 'not_null_violation';
    END IF;
    NEW.organization_id := esperado;
  END IF;
  RETURN NEW;
END
$fn$;
`;
}

function plataformaDown() {
  return `${cabecalho('Fase 1 · reverte plataforma')}DROP FUNCTION IF EXISTS tenancy_preencher_organization();
DROP FUNCTION IF EXISTS tenancy_org_do_mapeamento(TEXT, TEXT);
DROP TABLE IF EXISTS tenancy_mapeamentos;
DROP TABLE IF EXISTS organization_members;
DROP TABLE IF EXISTS stores;
DROP TABLE IF EXISTS organizations;
`;
}

// ── 0004 · colunas + funções de verificação ─────────────────────────────────────────────────
function lojasUnion() {
  const partes = porRegra('loja', 'loja_ou_sem_loja').map((x) =>
    `SELECT loja AS chave FROM ${x.tabela} WHERE organization_id IS NULL AND loja IS NOT NULL`);
  partes.push('SELECT escopo FROM integrations WHERE organization_id IS NULL AND escopo IS NOT NULL');
  return partes.join('\n      UNION ');
}

function colunasUp() {
  const adds = tenant.filter((x) => !JA_TEM_COLUNA.has(x.tabela))
    .map((x) => `ALTER TABLE ${x.tabela} ADD COLUMN organization_id UUID;`).join('\n');

  const semLoja = porRegra('loja_ou_sem_loja').map((x) => `  RETURN QUERY SELECT 'sem_loja:${x.tabela}'
    WHERE EXISTS (SELECT 1 FROM ${x.tabela} WHERE organization_id IS NULL AND loja IS NULL)
      AND NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = 'sem_loja' AND chave = '${x.tabela}');`).join('\n');

  const unicos = UNICOS.map((regra) => {
    const tabs = porRegra(regra).map((x) => `EXISTS (SELECT 1 FROM ${x.tabela} WHERE organization_id IS NULL)`);
    return `  RETURN QUERY SELECT '${regra}:*'
    WHERE (${tabs.join('\n        OR ')})
      AND NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = '${regra}' AND chave = '*');`;
  }).join('\n');

  const creative = porRegra('creative').map((x) =>
    `SELECT tenant_id FROM ${x.tabela} WHERE organization_id IS NULL`).join('\n      UNION ');

  const nulos = tenant.map((x) => `  SELECT count(*) INTO n FROM ${x.tabela} WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT '${x.tabela}: ' || n || ' linha(s) sem organization_id'; END IF;`).join('\n');

  const divergencias = tenant.map((x) => {
    let cond;
    if (x.regra === 'loja') {
      cond = `FROM ${x.tabela} t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id`;
    } else if (x.regra === 'loja_ou_sem_loja') {
      cond = `FROM ${x.tabela} t JOIN tenancy_mapeamentos mp
      ON (t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja)
      OR (t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = '${x.tabela}')
    WHERE t.organization_id <> mp.organization_id`;
    } else if (x.regra === 'integracao') {
      cond = `FROM ${x.tabela} t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.escopo
    WHERE t.organization_id <> mp.organization_id`;
    } else if (x.regra === 'pai') {
      cond = `FROM ${x.tabela} t JOIN ${x.pai.tabela} p ON p.id = t.${x.pai.coluna}
    WHERE t.organization_id IS DISTINCT FROM p.organization_id`;
    } else if (x.regra === 'creative') {
      cond = `FROM ${x.tabela} t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id`;
    } else {
      return null; // instalacao/meta/google_ads: só valem no instante do backfill (ver abaixo)
    }
    return `  SELECT count(*) INTO n ${cond};
  IF n > 0 THEN RETURN NEXT '${x.tabela}: ' || n || ' linha(s) com organization_id diferente da regra ${x.regra}'; END IF;`;
  }).filter(Boolean).join('\n');

  return `${cabecalho('Fase 1 · organization_id nullable + funções de verificação')}${adds}

-- Itens que o dado existente exige que estejam mapeados e não estão. Vazio = cobertura completa.
-- NÃO existe ramo "há uma só Organization": com uma Organization, loja sem mapeamento continua
-- aparecendo aqui (INV-09).
CREATE FUNCTION tenancy_itens_sem_mapeamento() RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $fn$
BEGIN
  RETURN QUERY
    WITH lojas AS (
      ${lojasUnion()}
    )
    SELECT 'loja:' || l.chave FROM lojas l
     WHERE NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos mp WHERE mp.tipo = 'loja' AND mp.chave = l.chave);
${semLoja}
${unicos}
  RETURN QUERY
    WITH tenants AS (
      ${creative}
    )
    SELECT 'creative_tenant:' || t.tenant_id FROM tenants t
     WHERE NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos mp WHERE mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id);
  RETURN QUERY SELECT 'integrations: linha sem organization_id e sem escopo — nenhuma regra a cobre'::TEXT
    WHERE EXISTS (SELECT 1 FROM integrations WHERE organization_id IS NULL AND escopo IS NULL);
END
$fn$;

CREATE FUNCTION tenancy_exigir_cobertura() RETURNS VOID
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE faltando TEXT;
BEGIN
  SELECT string_agg(x, E'\\n  - ' ORDER BY x) INTO faltando FROM tenancy_itens_sem_mapeamento() AS x;
  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION E'tenancy: existe dado sem dono declarado. Nada foi atribuído por dedução.\\n  - %', faltando
      USING HINT = 'Declare cada item no arquivo apontado por TENANCY_MAPPING_FILE (ver docs/produtizacao-saas/tenant-owned-tables.md).';
  END IF;
END
$fn$;

-- Problemas de ownership: linha sem organization_id, ou com dono diferente do que a regra
-- explícita manda. Regras que são FATO (loja, pai, tenant do Creative Core) valem sempre; as de
-- instalação só no backfill, e são conferidas lá.
CREATE FUNCTION tenancy_problemas_de_ownership() RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $fn$
DECLARE n BIGINT;
BEGIN
${nulos}
${divergencias}
END
$fn$;
`;
}

function colunasDown() {
  const drops = tenant.filter((x) => !JA_TEM_COLUNA.has(x.tabela))
    .map((x) => `ALTER TABLE ${x.tabela} DROP COLUMN IF EXISTS organization_id;`).join('\n');
  return `${cabecalho('Fase 1 · reverte colunas')}DROP FUNCTION IF EXISTS tenancy_problemas_de_ownership();
DROP FUNCTION IF EXISTS tenancy_exigir_cobertura();
DROP FUNCTION IF EXISTS tenancy_itens_sem_mapeamento();
${drops}
`;
}

// ── 0006 · backfill ─────────────────────────────────────────────────────────────────────────
function backfillUp() {
  const upd = (tab, de, onde) => `UPDATE ${tab} t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND ${onde};`;
  const partes = [];
  for (const x of porRegra('loja')) partes.push(upd(x.tabela, 'loja', "mp.tipo = 'loja' AND mp.chave = t.loja"));
  for (const x of porRegra('loja_ou_sem_loja')) {
    partes.push(upd(x.tabela, 'loja', "t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja"));
    partes.push(upd(x.tabela, 'sem_loja', `t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = '${x.tabela}'`));
  }
  for (const x of porRegra('integracao')) partes.push(upd(x.tabela, 'escopo', "mp.tipo = 'loja' AND mp.chave = t.escopo"));
  for (const regra of UNICOS) {
    for (const x of porRegra(regra)) partes.push(upd(x.tabela, regra, `mp.tipo = '${regra}' AND mp.chave = '*'`));
  }
  for (const x of porRegra('creative')) {
    partes.push(upd(x.tabela, 'creative', "mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id"));
  }
  // Pais antes dos filhos: todo pai é de uma regra acima.
  for (const x of porRegra('pai')) {
    partes.push(`UPDATE ${x.tabela} t SET organization_id = p.organization_id FROM ${x.pai.tabela} p
 WHERE t.organization_id IS NULL AND p.id = t.${x.pai.coluna};`);
  }

  // Conferência das regras de instalação no instante do backfill: toda linha delas tem de ter
  // exatamente o dono declarado (nesta hora ainda não existe outro tenant).
  const conferencias = UNICOS.flatMap((regra) => porRegra(regra).map((x) => `  SELECT count(*) INTO n FROM ${x.tabela} t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = '${regra}' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('${x.tabela}: ' || n || ' linha(s) fora do dono declarado ${regra}:*'); END IF;`)).join('\n');

  return `${cabecalho('Fase 1 · backfill determinístico por mapeamento explícito')}SELECT tenancy_exigir_cobertura();

${partes.join('\n')}

-- Zero órfãos NÃO basta: cada linha precisa ter o dono que a regra explícita manda.
DO $check$
DECLARE
  n BIGINT;
  problemas TEXT[] := ARRAY(SELECT tenancy_problemas_de_ownership());
BEGIN
${conferencias}
  IF cardinality(problemas) > 0 THEN
    RAISE EXCEPTION E'tenancy: backfill não confere com o mapeamento explícito:\\n  - %',
      array_to_string(problemas, E'\\n  - ');
  END IF;
END
$check$;
`;
}

function backfillDown() {
  const sets = tenant.filter((x) => !JA_TEM_COLUNA.has(x.tabela))
    .map((x) => `UPDATE ${x.tabela} SET organization_id = NULL;`).join('\n');
  return `${cabecalho('Fase 1 · reverte backfill')}${sets}\n`;
}

// ── 0007 · constraints, índices, UNIQUEs, singletons ────────────────────────────────────────
function uniqueSql(tab, u) {
  const corpo = u.expressao || `(${u.colunas.join(', ')})`;
  return `CREATE UNIQUE INDEX ${u.nome} ON ${tab} ${corpo}${u.where ? ` WHERE ${u.where}` : ''};`;
}

function constraintsUp() {
  const linhas = [];
  for (const x of tenant) {
    linhas.push(`-- ${x.tabela} (${x.regra})`);
    linhas.push(`ALTER TABLE ${x.tabela} ADD CONSTRAINT ${fkOrg(x.tabela)} FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;`);
    linhas.push(`ALTER TABLE ${x.tabela} ALTER COLUMN organization_id SET NOT NULL;`);
    linhas.push(`CREATE INDEX ${idxOrg(x.tabela)} ON ${x.tabela} (organization_id);`);
    for (const u of x.uniques) linhas.push(uniqueSql(x.tabela, u));
    if (x.singleton) {
      linhas.push(`-- INV-06: deixa de ser uma linha por instalação.`);
      linhas.push(`ALTER TABLE ${x.tabela} DROP CONSTRAINT ${x.singleton.constraint};`);
      linhas.push(`CREATE SEQUENCE ${x.singleton.sequencia} AS SMALLINT START WITH 2 OWNED BY ${x.tabela}.id;`);
      linhas.push(`SELECT setval('${x.singleton.sequencia}', GREATEST(2, (SELECT COALESCE(max(id), 0) + 1 FROM ${x.tabela})), false);`);
      linhas.push(`ALTER TABLE ${x.tabela} ALTER COLUMN id SET DEFAULT nextval('${x.singleton.sequencia}');`);
    }
    linhas.push('');
  }
  // integrations: a UNIQUE da Fase 0 tratava organization_id NULL como igual; agora é NOT NULL.
  return `${cabecalho('Fase 1 · FK, NOT NULL, índices e UNIQUEs por Organization')}${linhas.join('\n')}`;
}

function constraintsDown() {
  const linhas = [];
  for (const x of [...tenant].reverse()) {
    if (x.singleton) {
      linhas.push(`ALTER TABLE ${x.tabela} ALTER COLUMN id DROP DEFAULT;`);
      linhas.push(`DROP SEQUENCE IF EXISTS ${x.singleton.sequencia};`);
      linhas.push(`ALTER TABLE ${x.tabela} ADD CONSTRAINT ${x.singleton.constraint} CHECK (id = 1);`);
    }
    for (const u of x.uniques) linhas.push(`DROP INDEX IF EXISTS ${u.nome};`);
    linhas.push(`DROP INDEX IF EXISTS ${idxOrg(x.tabela)};`);
    linhas.push(`ALTER TABLE ${x.tabela} ALTER COLUMN organization_id DROP NOT NULL;`);
    linhas.push(`ALTER TABLE ${x.tabela} DROP CONSTRAINT IF EXISTS ${fkOrg(x.tabela)};`);
  }
  return `${cabecalho('Fase 1 · reverte constraints')}${linhas.join('\n')}\n`;
}

// ── 0008 · triggers de compatibilidade ──────────────────────────────────────────────────────
function argsTrigger(x) {
  if (x.regra === 'pai') return `'pai', '${x.pai.tabela}', '${x.pai.coluna}'`;
  return `'${x.regra}'`;
}

function triggersUp() {
  const linhas = tenant.map((x) => `CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON ${x.tabela}
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization(${argsTrigger(x)});`);
  return `${cabecalho('Fase 1 · triggers transitórios de organization_id (saem na Fase 3)')}${linhas.join('\n')}\n`;
}

function triggersDown() {
  return `${cabecalho('Fase 1 · reverte triggers')}${tenant.map((x) =>
    `DROP TRIGGER IF EXISTS tenancy_organization ON ${x.tabela};`).join('\n')}\n`;
}

// ── 0009 · RLS ──────────────────────────────────────────────────────────────────────────────
function rlsUp() {
  const linhas = [];
  const alvos = [...tenant.map((x) => ({ tabela: x.tabela, coluna: 'organization_id' })), ...m.TABELAS_PLATAFORMA
    .map((x) => ({ tabela: x.tabela, coluna: x.colunaTenant }))];
  for (const { tabela, coluna } of alvos) {
    linhas.push(`ALTER TABLE ${tabela} ENABLE ROW LEVEL SECURITY;`);
    linhas.push(`ALTER TABLE ${tabela} FORCE ROW LEVEL SECURITY;`);
    linhas.push(`CREATE POLICY tenancy_isolamento ON ${tabela}
  USING (${coluna} = ${CTX})
  WITH CHECK (${coluna} = ${CTX});`);
  }
  return `${cabecalho('Fase 1 · RLS habilitada e FORÇADA (TD-001)')}-- Em produção o app continua na role atual até OPS-14 (ver plano, Fase 1): a role atual é
-- superusuário e ignora RLS. Sob a role oria_app (CI) estas policies valem integralmente.
${linhas.join('\n')}\n`;
}

function rlsDown() {
  const alvos = [...tenant.map((x) => x.tabela), ...m.TABELAS_PLATAFORMA.map((x) => x.tabela)];
  return `${cabecalho('Fase 1 · reverte RLS')}${alvos.map((tabela) => `DROP POLICY IF EXISTS tenancy_isolamento ON ${tabela};
ALTER TABLE ${tabela} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${tabela} DISABLE ROW LEVEL SECURITY;`).join('\n')}\n`;
}

// ── 0010 · contract: chaves por Organization (INV-05 sem exceção) ─────────────────────────────
// Definições das chaves GLOBAIS que existiam antes deste passo, extraídas do schema e congeladas —
// o `down` as recria exatamente.
const ANTIGAS = require('./fase1-chaves-antigas.json');
const curto = (nome) => nome.slice(0, 63);
const idxPk = (tab, col) => curto(`idx_${tab}_pk_${col}`);
const fkNome = (tab, col) => curto(`${tab}_${col}_org_fkey`);

function pkNova(x) {
  return x.pk.promover || `${x.tabela}_pkey`;
}

function chavesUp() {
  const l = [];
  l.push('-- 1. FKs antigas (referenciam PKs de uma coluna só).');
  for (const f of ANTIGAS.fks) l.push(`ALTER TABLE ${f.tabela} DROP CONSTRAINT ${f.nome};`);
  l.push('', '-- 2. UNIQUEs globais que ainda restavam (os alvos de ON CONFLICT já incluem organization_id).');
  for (const u of ANTIGAS.uniques) {
    l.push(u.tipo === 'constraint'
      ? `ALTER TABLE ${u.tabela} DROP CONSTRAINT ${u.nome};`
      : `DROP INDEX ${u.nome};`);
  }
  l.push('', '-- 3. PKs passam a começar por organization_id.');
  for (const x of tenant) {
    l.push(`ALTER TABLE ${x.tabela} DROP CONSTRAINT ${x.tabela}_pkey;`);
    if (x.pk.promover) {
      l.push(`ALTER TABLE ${x.tabela} ADD CONSTRAINT ${x.pk.promover} PRIMARY KEY USING INDEX ${x.pk.promover};`);
    } else {
      l.push(`ALTER TABLE ${x.tabela} ADD CONSTRAINT ${x.tabela}_pkey PRIMARY KEY (organization_id, ${x.pk.colunas.join(', ')});`);
      // Busca direta por id (rotas, jobs) continua indexada.
      l.push(`CREATE INDEX ${idxPk(x.tabela, x.pk.colunas[0])} ON ${x.tabela} (${x.pk.colunas.join(', ')});`);
    }
    for (const i of x.indices) l.push(`CREATE INDEX ${i.nome} ON ${x.tabela} (${i.colunas.join(', ')});`);
  }
  l.push('', '-- 4. FKs compostas: o filho só aponta para pai da MESMA Organization.');
  for (const x of tenant) {
    for (const f of x.fks) {
      const acao = f.onDelete === 'SET NULL' ? `SET NULL (${f.coluna})` : f.onDelete;
      l.push(`ALTER TABLE ${x.tabela} ADD CONSTRAINT ${fkNome(x.tabela, f.coluna)} FOREIGN KEY (organization_id, ${f.coluna}) REFERENCES ${f.pai} (organization_id, id) ON DELETE ${acao};`);
    }
  }
  return `${cabecalho('Fase 1 · contract — toda chave de tabela tenant-owned inclui organization_id')}-- Deploy em DOIS passos (OPS-17): esta migration só pode rodar quando a versão no ar já usa os
-- alvos de ON CONFLICT com organization_id. A versão anterior à Fase 1 usa os alvos globais que
-- este arquivo remove.
${l.join('\n')}\n`;
}

function chavesDown() {
  const l = [];
  for (const x of [...tenant].reverse()) {
    for (const f of x.fks) l.push(`ALTER TABLE ${x.tabela} DROP CONSTRAINT ${fkNome(x.tabela, f.coluna)};`);
  }
  for (const x of [...tenant].reverse()) {
    for (const i of x.indices) l.push(`DROP INDEX ${i.nome};`);
    if (x.pk.promover) {
      l.push(`ALTER TABLE ${x.tabela} DROP CONSTRAINT ${x.pk.promover};`);
      const u = x.uniques.find((y) => y.nome === x.pk.promover);
      l.push(uniqueSql(x.tabela, u));
    } else {
      l.push(`ALTER TABLE ${x.tabela} DROP CONSTRAINT ${x.tabela}_pkey;`);
      l.push(`DROP INDEX ${idxPk(x.tabela, x.pk.colunas[0])};`);
    }
    l.push(`ALTER TABLE ${x.tabela} ADD CONSTRAINT ${x.tabela}_pkey ${ANTIGAS.pks[x.tabela]};`);
  }
  for (const u of ANTIGAS.uniques) {
    l.push(u.tipo === 'constraint'
      ? `ALTER TABLE ${u.tabela} ADD CONSTRAINT ${u.nome} ${u.def};`
      : `${u.def};`);
  }
  for (const f of ANTIGAS.fks) l.push(`ALTER TABLE ${f.tabela} ADD CONSTRAINT ${f.nome} ${f.def};`);
  return `${cabecalho('Fase 1 · reverte o contract (recria as chaves globais)')}${l.join('\n')}\n`;
}

const ARQUIVOS = {
  '0003-tenancy-plataforma': { up: plataformaUp, down: plataformaDown },
  '0004-tenancy-colunas': { up: colunasUp, down: colunasDown },
  '0006-tenancy-backfill': { up: backfillUp, down: backfillDown },
  '0007-tenancy-constraints': { up: constraintsUp, down: constraintsDown },
  '0008-tenancy-triggers': { up: triggersUp, down: triggersDown },
  '0009-tenancy-rls': { up: rlsUp, down: rlsDown },
  '0010-tenancy-chaves': { up: chavesUp, down: chavesDown },
};

module.exports = { ARQUIVOS, CTX };
