# `migrations/` — migrations de schema do painel (node-pg-migrate)

**Não confundir com `scripts/migracao-*.mjs`.** Aquilo é a migração de *catálogo* da Use Origens
(mover produtos de Centro/Norte para Sul). Isto aqui é migração de *schema do Postgres*.

| Pasta | O que é | Quem roda |
|---|---|---|
| `migrations/` | schema do banco, versionado, controlado por `node-pg-migrate` (tabela `pgmigrations`) | `npm run migrate:up`, no pre-deploy |
| `scripts/migracao-*.mjs` | migração de catálogo de produtos entre lojas | operador, sob demanda |

## Comandos

```bash
npm run migrate:up        # aplica o que falta
npm run migrate:down      # desfaz a última
npm run migrate:dry       # mostra o que faria, sem escrever (--dry-run)
npm run migrate:create -- nome-da-migration
```

Todos leem `DATABASE_URL`.

## Regras

1. **Migration nunca roda no boot da aplicação.** O `server.js` não cria mais tabela nem faz
   backfill. Em produção o gancho é o *Pre-deploy Command* do Railway (`npm run migrate:up`,
   **OPS-11**): se a migration falhar, o deploy aborta e a versão antiga continua no ar.
2. `node-pg-migrate` é **dependência normal**, não `devDependency` — o comando roda no container
   publicado, e o build pode podar devDeps.
3. Migration nova é **aditiva**. A regra do plano é
   `adicionar → backfill → dual-read/write → validar → trocar leitores → remover caminho antigo`.
   `DROP` fica para uma migration posterior, nunca na mesma.
4. `CREATE INDEX CONCURRENTLY` exige `pgm.noTransaction()`.
5. As tabelas `origens_migration_*` são **LEGACY / TO_REMOVE** e **não** devem receber `DROP`
   precoce.

## O que é a `0001-baseline-schema`

É o DDL que até `8a7ea3d` rodava dentro de `bootstrapPostgres()`, no boot, a cada subida do
processo e em cada réplica ao mesmo tempo, sob um `.catch` que só logava. O texto SQL foi movido
**sem edição** para `sql/0001-baseline-schema.sql` e é integralmente `CREATE ... IF NOT EXISTS` /
`ALTER ... ADD COLUMN IF NOT EXISTS`, portanto aplicá-lo sobre um banco de produção já existente
é um no-op — é exatamente o que ele já fazia todo dia.

`down` é deliberadamente **irreversível**: derrubar o schema inteiro apagaria a base. Reverter
*para antes* do baseline não é uma operação de migration, é um restore de backup.

As três migrations seguintes (`0002`, `0003`, `0004`) são os backfills que também rodavam no boot —
`backfillPedidosSeNecessario`, `backfillPaymentStatusPortugues` e `backfillPublicTokenMedia`.
Não eram código de inicialização: eram migrations disfarçadas.

## O que é a `creative-core-schema`

O DDL do Gerador de Criativos, que rodava no mount de `routes/criativos.js` (a cada boot, sob um
`.catch` que só logava) e escapou do primeiro corte por não morar em `server.js`. Movido sem edição
para `sql/0002-creative-core-schema.sql`. Também irreversível: em produção as tabelas `creative_*`
já existiam, com dados, antes desta migration.

## Concorrência e falha (node-pg-migrate 9.0.0, conferido no código instalado)

- Antes de ler `pgmigrations`, o runner faz `pg_try_advisory_lock(7241865325823964)`. Modo `fail`
  (default): um segundo `migrate:up` no mesmo banco sai com 1 sem aplicar nada. **Nunca usar
  `--no-lock`.**
- `--single-transaction` é default: se uma migration do lote falha, o lote inteiro volta e a CLI
  sai com 1 — o pre-deploy aborta.
- Contagem é **posicional** (`up 5`, `down 2`). `--count` é aceito e ignorado em silêncio.

Os três pontos têm teste em `test/invariants/migrations.test.js`.

## Fase 1 — tenancy (`1789600000000` … `1789600420000`)

Oito migrations, SQL em `sql/0003..0010-tenancy-*.{up,down}.sql`, **gerado** de
`lib/platform/tenancy-manifest.js` por `node scripts/tenancy/gerar-sql-fase1.mjs` e congelado.
Não regenerar depois do primeiro deploy: o SQL aplicado é histórico.

**Entrada obrigatória quando a base tem dado:** `TENANCY_MAPPING_FILE` apontando para o JSON de
mapeamento explícito (formato em `lib/platform/tenancy-mapping.js`; exemplos em
`test/fixtures/tenancy/`). Sem ele, ou com item faltando/ambíguo, a migration aborta e — em
single-transaction — nada da Fase 1 fica aplicado. Detalhes e a lista exigida:
[`docs/produtizacao-saas/tenant-owned-tables.md`](../docs/produtizacao-saas/tenant-owned-tables.md).

Banco vazio (CI, instalação nova) migra sem arquivo; o mapeamento vem depois, por
`node scripts/tenancy/aplicar-mapeamento.mjs <arquivo>`.

A role que roda migrations precisa ser dona das tabelas e superusuária (ou `BYPASSRLS`): com
`FORCE ROW LEVEL SECURITY`, até a dona obedece a policy. A role do **app** nunca é essa.

**Deploy em dois passos (OPS-17).** `1789600420000_tenancy-chaves` remove as chaves globais que o
código anterior à Fase 1 usa como árbitro de `ON CONFLICT`. Primeiro sobe a versão do commit
`fix(tenancy): arbitrate upserts within the organization` (migrations até `1789600360000`, código
com os alvos novos); só depois a versão com `1789600420000`. Se as duas subirem juntas, a versão
antiga, ainda no ar durante o pre-deploy, perde o árbitro dos seus upserts até a troca.

PostgreSQL ≥ 15: `NULLS NOT DISTINCT` (Fase 0) e `ON DELETE SET NULL (coluna)` nas FKs compostas.

## Fase 2 — identidade (`1789700000000_auth-identidade`)

`users`, `sessions` e papéis `owner`/`member`. Não migra dado: o primeiro owner de cada Organization
é criado depois das migrations, no mesmo *Pre-deploy Command*:

```bash
npm run migrate:up && npm run auth:bootstrap-owner
```

(`AUTH_BOOTSTRAP_OWNER_EMAIL`, `AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH`, `AUTH_BOOTSTRAP_ORGANIZATION_IDS` —
ver `scripts/auth/bootstrap-owner.mjs`; sem essas variáveis o comando não faz nada.)
