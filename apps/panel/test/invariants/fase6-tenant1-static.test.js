'use strict';

// Fase 6 · critério de saída 2 — a operação interna não tem ramo próprio no código de produto.
//
// Lido da raiz do sujeito (INVARIANT_SUBJECT_ROOT): o controle negativo em negative-controls.test.js
// injeta `ehOperacaoInterna` numa cópia do server.js e este arquivo precisa reprovar. Além disso,
// cada padrão reprova o próprio exemplo aqui mesmo (controle negativo local), e o que é legítimo
// — rótulo de exibição, comentário sobre a ferramenta interna R-01 — passa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');
const bypass = require('../../scripts/tenant1/sem-bypass.cjs');

test('Fase 6 · server.js, lib/, routes/ e src/ sem if internalTenant / useOrigens / ourStore / nome ou id fixo', () => {
  const { achados, arquivos } = bypass.procurarBypass({ raiz: h.RAIZ_SUJEITO, raizAdmin: h.RAIZ_REPO });
  assert.ok(arquivos > 150, `arquivos de produto lidos: ${arquivos}`);
  assert.deepEqual(achados, []);
});

test('Fase 6 · cada padrão reprova o próprio exemplo (controle negativo local)', () => {
  const ruins = {
    'identificador-de-tenant-interno': [
      'if (internalTenant) return next();',
      'const isOurStore = req.auth.organizationId === x;',
      'if (useOrigens) aplicarRegraDaCasa();',
      'function ehOperacaoInterna(ctx) { return true; }',
      'const TENANT_1 = cfg.tenant1;',
    ],
    'flag-de-ambiente-de-bypass': [
      "const pular = process.env.USE_ORIGENS === '1';",
      'if (process.env.RLS_BYPASS) semContexto(fn);',
    ],
    'loja-legada-como-decisao': [
      "if (loja === 'sul') return todasAsLojas();",
      "const extra = 'norte' !== ctx.loja ? 0 : 1;",
      "    case 'centro':",
      "if (['sul'].includes(ctx.loja)) x();",
    ],
    'nome-legado-como-decisao': [
      "if (org.nome === 'Use Origens') liberar();",
      'const nossa = store.nome.startsWith("Use Sul");',
      'if (/Use Origens/.test(organization.nome)) x();',
    ],
    'uuid-fixo-como-decisao': [
      "if (organizationId === 'b1000000-0000-4000-8000-000000000001') ok();",
      "if ('a1000000-0000-4000-8000-000000000001' === ctx.organizationId) ok();",
    ],
    'sql-por-nome-de-organization': [
      "SELECT id FROM organizations WHERE nome = 'Use Origens'",
      "JOIN stores s ON s.organization_id = o.id AND s.nome ILIKE 'use%'",
    ],
  };
  assert.deepEqual(Object.keys(ruins).sort(), bypass.PADROES.map((p) => p.id).sort(), 'todo padrão tem exemplo');
  for (const [padrao, linhas] of Object.entries(ruins)) {
    for (const l of linhas) {
      const achados = bypass.procurarBypassEmLinhas('exemplo.js', l).map((a) => a.padrao);
      assert.ok(achados.includes(padrao), `${padrao} não reprovou: ${l} (achou ${achados.join(', ') || 'nada'})`);
    }
  }

  const legitimas = [
    "const LOJAS        = { sul: 'Use Sul', centro: 'Use Centro', norte: 'Use Norte' };",
    "  sul: { id: 'sul', name: 'Use Sul', shortName: 'Sul', color: '#4d543d' },",
    "    items: [{ key: 'origens-migration', label: 'Migração Use Origens', href: '/admin/internal/origens-migration' }],",
    '// if (internalTenant) — proibido desde a Fase 6',
    ' * useOrigens era o nome antigo',
    "const INTERNAL_TOOLS_ENABLED = process.env.INTERNAL_TOOLS_ENABLED === 'true';",
    'if (ctx.loja === store.loja_legada) ok();',
    'const tenantId = ctx.organizationId;',
    "if (organizationId === ctx.organizationId) ok();",
  ];
  for (const l of legitimas) assert.deepEqual(bypass.procurarBypassEmLinhas('exemplo.js', l), [], `falso positivo: ${l}`);
});

test('Fase 6 · exceções declaradas continuam necessárias (nenhuma sobra)', () => {
  const { arquivos } = bypass.arquivosDeProduto({ raiz: h.RAIZ_SUJEITO, raizAdmin: h.RAIZ_REPO });
  for (const ex of bypass.EXCECOES) {
    const alvo = arquivos.find((a) => a.endsWith(ex.arquivo));
    assert.ok(alvo, `exceção para arquivo inexistente: ${ex.arquivo}`);
    assert.ok(fs.readFileSync(alvo, 'utf8').split('\n').some((l) => ex.re.test(l)), `exceção sem uso: ${ex.arquivo}`);
  }
});

test('Fase 6 · o orquestrador do Tenant #1 não escolhe dono por LIMIT 1, rows[0] ou "a única"', () => {
  const dir = path.join(h.RAIZ_REPO, 'scripts', 'tenant1');
  const arquivos = fs.readdirSync(dir).filter((f) => /\.(mjs|cjs|js)$/.test(f));
  assert.ok(arquivos.length >= 5, arquivos.join(', '));
  const proibido = /\bLIMIT\s+1\b|\brows\[0\]|\b(?:organizations|orgs|stores)\[0\]|\[\s*0\s*\]\s*\.organization_?[iI]d/;
  const achados = [];
  for (const f of arquivos) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((l, i) => {
      if (!l.trimStart().startsWith('//') && proibido.test(l)) achados.push(`${f}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(achados, []);
  // o próprio padrão pega a forma histórica
  assert.ok(proibido.test('const org = rows[0].organization_id;'));
  assert.ok(proibido.test('SELECT id FROM organizations LIMIT 1'));
});
