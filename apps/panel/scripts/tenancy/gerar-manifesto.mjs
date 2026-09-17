#!/usr/bin/env node
// Gera docs/productization/tenant-owned-tables.md (raiz do monorepo Oria) a partir de lib/platform/tenancy-manifest.js.
//   node scripts/tenancy/gerar-manifesto.mjs          grava
//   node scripts/tenancy/gerar-manifesto.mjs --check  falha se o arquivo estiver desatualizado
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const m = require('../../lib/platform/tenancy-manifest.js');
const DESTINO = path.join(RAIZ, '..', '..', 'docs', 'productization', 'tenant-owned-tables.md');

const ALVO = {
  loja: 'loja → `loja:<loja>`',
  loja_ou_sem_loja: 'loja → `loja:<loja>`; loja NULL → `sem_loja:<tabela>`',
  pai: 'herda do pai',
  integracao: 'organization_id existente ou `escopo` → `loja:<escopo>`',
  instalacao: '`instalacao:*`',
  meta: '`meta:*`',
  google_ads: '`google_ads:*`',
  creative: '`creative_tenant:<tenant_id>`',
};
const COM_ORG_ANTES = new Set(['integrations', 'integration_secrets']);

function acao(x) {
  const passos = [];
  passos.push(COM_ORG_ANTES.has(x.tabela) ? 'FK + backfill do que estiver NULL + NOT NULL' : 'coluna + backfill + FK + NOT NULL');
  if (x.singleton) passos.push('remove `CHECK (id = 1)`, id com sequência, UNIQUE (organization_id)');
  passos.push('índice organization_id', 'trigger transitório', 'chaves globais → por Organization');
  return passos.join('; ');
}

function chaves(x) {
  const partes = [`PK (organization_id${x.pk.colunas.length ? `, ${x.pk.colunas.join(', ')}` : ''})`];
  for (const u of x.uniques) {
    if (u.nome === x.pk.promover) continue;
    partes.push(`UNIQUE \`${u.nome}\` ${u.expressao || `(${u.colunas.join(', ')})`}${u.where ? ' WHERE …' : ''}`);
  }
  for (const f of x.fks) partes.push(`FK (organization_id, ${f.coluna}) → \`${f.pai}\``);
  for (const l of x.uniquesLegadas) partes.push(`**transitória** \`${l}\` (reprova o INV-05)`);
  return partes.join('<br>');
}

function gerar() {
  const t = m.TABELAS_TENANT;
  const porRegra = m.REGRAS.map((r) => `| \`${r}\` | ${t.filter((x) => x.regra === r).length} |`).join('\n');
  const linhas = t.map((x) => {
    const pai = x.pai ? ` (\`${x.pai.tabela}.${x.pai.coluna}\`)` : '';
    return `| \`${x.tabela}\` | \`${x.regra}\`${pai}: ${ALVO[x.regra]} | ${COM_ORG_ANTES.has(x.tabela) ? 'sim, nullable' : 'não'} | ${x.regra === 'creative' ? 'sim (mantido)' : '—'} | ${acao(x)} | ENABLE + FORCE | ${chaves(x)} | ${x.legado ? '**LEGACY / TO_REMOVE**' : '—'}${x.nota ? ` — ${x.nota}` : ''} |`;
  }).join('\n');

  return `# Tabelas tenant-owned — manifesto canônico (Fase 1)

> **GERADO** por \`scripts/tenancy/gerar-manifesto.mjs\` a partir de
> [\`lib/platform/tenancy-manifest.js\`](../../apps/panel/lib/platform/tenancy-manifest.js). Não editar à mão:
> \`test/invariants/tenancy-schema.test.js\` reprova se este arquivo divergir do código.

## Contagem única

**${t.length} tabelas tenant-owned** + **${m.TABELAS_PLATAFORMA.length} tabelas de plataforma** sob RLS
(${m.TABELAS_PLATAFORMA.map((x) => `\`${x.tabela}\``).join(', ')}) + **${m.TABELAS_GLOBAIS.length} globais declaradas**
(${m.TABELAS_GLOBAIS.map((x) => `\`${x.tabela}\` — ${x.motivo}`).join('; ')}).

Toda tabela do schema está em exatamente uma dessas listas; tabela nova sem classificação reprova
no CI.

| regra | tabelas |
|---|---:|
${porRegra}

### Reconciliação com as contagens antigas

| contagem antiga | o que era | por que difere |
|---|---|---|
| 53 tabelas (auditoria) | 44 do \`bootstrapPostgres()\` + 9 \`creative_*\` do boot do Creative Core, em \`8a7ea3d\` | a Fase 0 criou \`integrations\` e \`integration_secrets\`: 53 + 2 = 55 |
| 47 tabelas (relatório noturno) | schema após as 5 migrations da noite | 44 do baseline + \`integrations\` + \`integration_secrets\` + \`pgmigrations\`; as 9 \`creative_*\` ainda nasciam no boot |
| 49 tabelas (plano, Fase 1) | 53 − 4 \`origens_migration_*\` | as 4 \`origens_migration_*\` **também** recebem \`organization_id\` e RLS: são LEGACY / TO_REMOVE, mas guardam dado por loja enquanto existirem, e ficar fora da RLS seria um buraco declarado |
| 55 tabelas RED (gates TD-001) | todas as tabelas públicas menos \`pgmigrations\` | é a contagem certa das tenant-owned; esta página a torna canônica |
| "9 creative_* já têm tenant_id" | discriminador textual do Creative Core | continuam tendo; \`organization_id\` passa a ser o canônico e \`tenant_id\` fica até a Fase 3 |
| "integrations/integration_secrets com organization_id nullable" | Fase 0 | agora NOT NULL, com FK |
| "28 UNIQUEs globais mantidas" (rodada 11) | expand/contract ainda aberto | **fechado na rodada 12**: os 32 alvos de \`ON CONFLICT\` do código incluem \`organization_id\`, e a migration \`1789600420000_tenancy-chaves\` remove as 20 UNIQUEs globais e troca as 55 PKs por PKs que começam por \`organization_id\`. Zero chaves globais |

## Chaves (INV-05, sem exceção)

Toda UNIQUE e toda PK das ${t.length} tabelas inclui \`organization_id\` — inclusive a PK surrogate, que vira
\`(organization_id, id)\` com um índice comum em \`id\` para as buscas diretas. As 8 FKs entre tabelas
tenant-owned são compostas: o filho só aponta para pai da mesma Organization. O \`public_token\` de
mídia é único por Organization (token de 192 bits), com índice comum para o link público.

**Deploy em dois passos (OPS-17):** primeiro a versão com os alvos novos de \`ON CONFLICT\` e as
migrations até \`1789600360000\`; depois \`1789600420000_tenancy-chaves\`.

## Cardinalidade Organization ↔ Store (PD-002)

\`stores\` tem \`UNIQUE (organization_id)\` — uma Store por Organization, ativa ou não (não há histórico
de Stores na V1). O gate \`card1a1\` confere a constraint e o dado: nenhuma Organization com mais de uma
Store ativa, nenhuma sem Store, nenhuma Store sem Organization.

## Mapeamento explícito exigido antes do pre-deploy

A migration \`1789600120000_tenancy-mapeamento\` lê \`TENANCY_MAPPING_FILE\` (formato em
[\`lib/platform/tenancy-mapping.js\`](../../apps/panel/lib/platform/tenancy-mapping.js)). Com dado na base, o
arquivo é **obrigatório** e precisa declarar, para o código em execução:

${['- `loja:` ' + m.LOJAS_LEGADAS.join(', '),
    '- `sem_loja:` ' + t.filter((x) => x.regra === 'loja_ou_sem_loja').map((x) => x.tabela).join(', '),
    '- `instalacao:*`, `meta:*`, `google_ads:*`',
    '- `creative_tenant:<CREATIVE_TENANT_ID ou default>`',
    '- e qualquer outra loja/tenant que exista no dado'].join('\n')}

PD-019 A → 3 Organizations + 3 Stores (uma por Organization). PD-019 B → **1 Organization + 1 Store**
(Use Origens); os três valores legados de loja (\`sul\`, \`centro\`, \`norte\`) convergem para ela no
backfill, sem virar Stores. Fixtures: \`test/fixtures/tenancy/cenario-a.json\` e \`cenario-b.json\`.
Faltou um item, ou o mesmo item aparece duas vezes → a migration aborta e nada é aplicado. Nunca
existe "é a única Organization".

## Tabelas

| tabela | dono (regra explícita) | organization_id antes da Fase 1 | tenant_id legado | ação da Fase 1 | RLS | chaves finais (INV-05) | legado |
|---|---|---|---|---|---|---|---|
${linhas}
`;
}

const conteudo = gerar();
if (process.argv.includes('--check')) {
  const atual = fs.existsSync(DESTINO) ? fs.readFileSync(DESTINO, 'utf8') : '';
  if (atual !== conteudo) {
    console.error(`${path.relative(RAIZ, DESTINO)} está desatualizado`);
    process.exit(1);
  }
} else {
  fs.writeFileSync(DESTINO, conteudo);
  console.log(path.relative(RAIZ, DESTINO));
}
