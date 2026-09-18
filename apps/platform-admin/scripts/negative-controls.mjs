#!/usr/bin/env node
// Controles negativos do control plane (§29).
//
// ── Por que isto existe ──────────────────────────────────────────────────────────────────────
// Uma suíte escrita junto com o código tende a ser escrita PARA PASSAR, não para detectar. O
// sintoma disso é silêncio — que é indistinguível de sucesso. A mitigação é o ciclo de 5 passos:
//
//     1. a suíte passa no código correto
//     2. o defeito é introduzido numa CÓPIA do código
//     3. a MESMA suíte REPROVA                      ← se não reprovar, o teste não testa nada
//     4. a cópia é descartada
//     5. a suíte passa de novo no código correto
//
// O sujeito sob teste nunca é `../lib` direto: o harness resolve a partir de
// `INVARIANT_SUBJECT_ROOT`, e é isso que permite apontar para a cópia defeituosa.
//
// Uso:
//   npm run test:negative                 roda todos
//   npm run test:negative -- cookie-domain  roda um
//
// Exige o banco de teste em pé (ADMIN_TEST_DATABASE_URL), como a suíte normal.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Cada controle: o defeito (uma substituição textual num arquivo do app) e quais testes precisam
// reprovar. O defeito é sempre REALISTA — é o atalho que alguém escreveria de boa-fé.
const CONTROLES = [
  {
    nome: 'bypassrls',
    descricao: 'listar Organizations por query global crua, em vez do read model (o atalho "sou admin, posso ver tudo")',
    arquivo: 'lib/readmodels.js',
    de: "      'SELECT * FROM platform_listar_organizations($1, $2, $3, $4, $5)',\n      [status, busca, limite + 1, cursor ? cursor.em : null, cursor ? cursor.id : null]",
    para: "      `SELECT o.id, o.nome, o.status, o.criado_em, NULL::uuid AS store_id, NULL::text AS store_nome,\n              0 AS owners_ativos, NULL::text AS plano_chave, NULL::text AS plano_nome,\n              NULL::text AS onboarding_status, NULL::text AS onboarding_step\n         FROM organizations o LIMIT $3`,\n      [status, busca, limite + 1, cursor ? cursor.em : null, cursor ? cursor.id : null]",
    testes: ['test/platform.test.js'],
  },
  {
    nome: 'superuser',
    descricao: 'anunciar que o control plane precisa de SUPERUSER/BYPASSRLS na role',
    arquivo: 'lib/db.js',
    de: "function criarPool(databaseUrl, extra = {}) {",
    para: "// A role do control plane precisa de BYPASSRLS e SUPERUSER para ler tudo.\nfunction criarPool(databaseUrl, extra = {}) {",
    testes: ['test/platform.test.js'],
  },
  {
    nome: 'tenant-user-as-platform-admin',
    descricao: 'aceitar a sessão do painel (tabela `sessions`) como sessão de platform admin',
    arquivo: 'lib/sessions.js',
    de: "      `SELECT s.id, s.admin_id, s.expira_em, s.ultimo_uso_em, a.email, a.nome, a.papel\n         FROM platform_admin_sessions s\n         JOIN platform_admins a ON a.id = s.admin_id",
    para: "      `SELECT s.id, COALESCE(a.id, u.id) AS admin_id, s.expira_em, s.ultimo_uso_em,\n              COALESCE(a.email, u.email) AS email, COALESCE(a.nome, u.nome) AS nome,\n              COALESCE(a.papel, 'platform_owner') AS papel\n         FROM (SELECT id, admin_id::uuid AS sujeito, expira_em, ultimo_uso_em, revogada_em FROM platform_admin_sessions\n               UNION ALL SELECT id, user_id, expira_em, ultimo_uso_em, revogada_em FROM sessions) s\n         LEFT JOIN platform_admins a ON a.id = s.sujeito\n         LEFT JOIN users u ON u.id = s.sujeito",
    ajustes: [
      { de: '        WHERE s.id = $1\n          AND s.revogada_em IS NULL\n          AND s.expira_em > now()\n          AND a.status = \'active\'`',
        para: '        WHERE s.id = $1\n          AND s.revogada_em IS NULL\n          AND s.expira_em > now()`' },
    ],
    testes: ['test/auth.test.js'],
  },
  {
    nome: 'plan-mutation-without-audit',
    descricao: 'trocar o plano sem gravar auditoria (o atalho "auditoria depois")',
    arquivo: 'lib/organizations.js',
    de: "      await audit.registrar(c, {\n        ator,\n        action: atual ? 'subscription.changed' : 'subscription.created',",
    para: "      if (false) await audit.registrar(c, {\n        ator,\n        action: atual ? 'subscription.changed' : 'subscription.created',",
    testes: ['test/audit.test.js'],
  },
  {
    nome: 'suspension-without-audit',
    descricao: 'suspender sem gravar auditoria',
    arquivo: 'lib/organizations.js',
    de: "      await audit.registrar(c, {\n        ator,\n        action: destino === 'suspended' ? 'organization.suspended' : 'organization.reactivated',",
    para: "      if (false) await audit.registrar(c, {\n        ator,\n        action: destino === 'suspended' ? 'organization.suspended' : 'organization.reactivated',",
    testes: ['test/audit.test.js'],
  },
  {
    nome: 'suspended-org-still-allowed',
    descricao: 'ignorar a suspensão no resolver de entitlements (o atalho "suspensão é só um rótulo")',
    arquivo: 'lib/entitlements.js',
    de: '  const suspensa = organizationStatus !== \'active\';',
    para: '  const suspensa = false; // organizationStatus !== \'active\';',
    testes: ['test/organizations.test.js', 'test/plans.test.js'],
  },
  {
    nome: 'body-org-overriding-route-target',
    descricao: 'deixar o organization_id do CORPO decidir o alvo quando ele vem preenchido',
    arquivo: 'lib/http.js',
    de: "  const autoridade = recebidos.filter((k) => CAMPOS_DE_AUTORIDADE.includes(k) && !permitidos.has(k));",
    para: "  const autoridade = [];",
    ajustes: [
      { de: '  const desconhecidos = recebidos.filter((k) => !permitidos.has(k));',
        para: '  const desconhecidos = recebidos.filter((k) => !permitidos.has(k) && !CAMPOS_DE_AUTORIDADE.includes(k));' },
    ],
    testes: ['test/organizations.test.js'],
  },
  {
    nome: 'secret-response',
    descricao: 'devolver o hash do token do convite na listagem (o atalho "a UI só quer conferir")',
    arquivo: 'lib/organizations.js',
    de: '      usadoEm: r.usado_em,\n      revogadoEm: r.revogado_em,',
    para: '      usadoEm: r.usado_em,\n      revogadoEm: r.revogado_em,\n      tokenHash: r.token_hash,',
    ajustes: [
      { de: "      `SELECT id, email, papel, criado_em, expira_em, usado_em, revogado_em\n         FROM organization_owner_invites WHERE organization_id = $1 ORDER BY criado_em DESC`",
        para: "      `SELECT id, email, papel, criado_em, expira_em, usado_em, revogado_em, token_hash\n         FROM organization_owner_invites WHERE organization_id = $1 ORDER BY criado_em DESC`" },
    ],
    testes: ['test/audit.test.js'],
  },
  {
    nome: 'last-owner-removal',
    descricao: 'remover o último owner da Organization sem conferir (o atalho "o banco resolve")',
    arquivo: 'lib/organizations.js',
    de: "      if (membro.papel === 'owner' && membro.status === 'active') {\n        const { rows: [{ n }] } = await c.query('SELECT platform_owners_ativos($1) AS n', [organizationId]);\n        if (n <= 1) {",
    para: "      if (false) {\n        const { rows: [{ n }] } = await c.query('SELECT platform_owners_ativos($1) AS n', [organizationId]);\n        if (n <= 1) {",
    testes: ['test/organizations.test.js'],
  },
  {
    nome: 'last-platform-owner-removal',
    descricao: 'desativar o último platform_owner sem conferir na aplicação',
    arquivo: 'lib/admins.js',
    de: "        if (alvo.papel === 'platform_owner' && alvo.status === 'active' && n <= 1) {",
    para: "        if (false && alvo.papel === 'platform_owner' && alvo.status === 'active' && n <= 1) {",
    // Tirar SÓ a checagem da aplicação não muda o comportamento: o trigger do banco ainda barra, e
    // `traduzirUltimoOwner` devolve o mesmo 409 — defesa em profundidade funcionando. O defeito
    // realista é o par: "o banco já garante, então a checagem E a tradução são redundantes". Aí o
    // operador passa a receber 500 em vez de um conflito legível, e o teste reprova.
    ajustes: [
      { de: '      ).catch(traduzirUltimoOwner);\n\n      if (destino === \'disabled\') {',
        para: '      );\n\n      if (destino === \'disabled\') {' },
    ],
    // Aqui o trigger do banco AINDA barra — e é justamente isso que o teste precisa mostrar:
    // a mensagem muda (o 409 legível some), então o teste reprova mesmo com a rede de baixo.
    testes: ['test/platform.test.js'],
  },
  {
    nome: 'cookie-domain',
    descricao: 'compartilhar a sessão entre app.oria.com.br e admin.oria.com.br com Domain=.oria.com.br',
    arquivo: 'lib/sessions.js',
    de: "    `Max-Age=${maxAge}`,\n    ...(producao ? ['Secure'] : []),",
    para: "    `Max-Age=${maxAge}`,\n    'Domain=.oria.com.br',\n    ...(producao ? ['Secure'] : []),",
    testes: ['test/hosts.test.js'],
  },
  {
    nome: 'origin-app-allowed',
    descricao: 'aceitar mutação vinda do host do painel (o atalho "é tudo oria.com.br")',
    arquivo: 'lib/urls.js',
    de: "  if (origem !== canonica.origem) return { ok: false, motivo: 'origem_nao_permitida' };",
    para: "  if (!origem.endsWith('oria.com.br')) return { ok: false, motivo: 'origem_nao_permitida' };",
    testes: ['test/hosts.test.js'],
  },
  {
    nome: 'open-redirect',
    descricao: 'aceitar returnUrl absoluto depois do login',
    arquivo: 'lib/urls.js',
    de: '  if (!CAMINHO_LOCAL_RE.test(v)) return null;\n  return v;',
    para: '  return v;',
    testes: ['test/hosts.test.js'],
  },
  {
    nome: 'second-tenant-gate',
    descricao: 'reutilizar o bootstrap interno depois do Tenant #1',
    arquivo: 'lib/organizations.js',
    de: '        if (quantas > 0) {',
    para: '        if (false && quantas > 0) {',
    testes: ['test/organizations.test.js'],
  },
  {
    nome: 'entitlement-spread',
    descricao: 'o defeito INV-23 do painel: `{ ...DEFAULTS, ...plano }`, em que ausência vira permissão',
    arquivo: 'lib/entitlements.js',
    de: '    efetivos[f] = false;\n    origem[f] = \'ausente\';',
    para: '    efetivos[f] = true;\n    origem[f] = \'ausente\';',
    testes: ['test/plans.test.js'],
  },
];

function copiarApp(destino) {
  fs.mkdirSync(destino, { recursive: true });
  for (const item of ['lib', 'test', 'scripts', 'node_modules', 'server.js', 'package.json']) {
    const origem = path.join(RAIZ, item);
    if (!fs.existsSync(origem)) continue;
    fs.cpSync(origem, path.join(destino, item), { recursive: true, dereference: false, verbatimSymlinks: true });
  }
}

function aplicarDefeito(raiz, controle) {
  const usar = controle.alternativo || controle;
  const alvo = path.join(raiz, usar.arquivo);
  let fonte = fs.readFileSync(alvo, 'utf8');
  if (!fonte.includes(usar.de)) {
    throw new Error(`controle ${controle.nome}: o trecho a substituir não existe mais em ${usar.arquivo} — o controle precisa ser atualizado junto com o código`);
  }
  fonte = fonte.replace(usar.de, usar.para);
  fs.writeFileSync(alvo, fonte);

  for (const ajuste of usar.ajustes || []) {
    const arquivoAjuste = path.join(raiz, ajuste.arquivo || usar.arquivo);
    let texto = fs.readFileSync(arquivoAjuste, 'utf8');
    if (!texto.includes(ajuste.de)) {
      throw new Error(`controle ${controle.nome}: ajuste não aplicável em ${ajuste.arquivo || usar.arquivo}`);
    }
    fs.writeFileSync(arquivoAjuste, texto.replace(ajuste.de, ajuste.para));
  }
}

function rodar(testes, subjectRoot) {
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...testes],
    {
      cwd: RAIZ,
      encoding: 'utf8',
      env: { ...process.env, INVARIANT_SUBJECT_ROOT: subjectRoot },
    }
  );
  return { ok: r.status === 0, saida: `${r.stdout}${r.stderr}` };
}

async function main() {
  if (!process.env.ADMIN_TEST_DATABASE_URL) {
    console.error('[negative] ADMIN_TEST_DATABASE_URL ausente — rode por `npm run test:negative` (scripts/test-db.mjs run)');
    return 1;
  }
  const pedidos = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const selecionados = pedidos.length ? CONTROLES.filter((c) => pedidos.includes(c.nome)) : CONTROLES;
  if (!selecionados.length) {
    console.error(`[negative] nenhum controle casa com ${pedidos.join(', ')}`);
    console.error(`[negative] disponíveis: ${CONTROLES.map((c) => c.nome).join(', ')}`);
    return 1;
  }

  const falhas = [];
  for (const controle of selecionados) {
    console.log(`\n── ${controle.nome} ──────────────────────────────────────────────`);
    console.log(`   defeito: ${controle.descricao}`);
    console.log(`   testes:  ${controle.testes.join(' ')}`);

    // 1. passa no código correto
    const antes = rodar(controle.testes, RAIZ);
    if (!antes.ok) {
      console.error('   ✖ passo 1: a suíte JÁ estava reprovando no código correto');
      console.error(antes.saida.split('\n').filter((l) => l.startsWith('✖') || l.includes('AssertionError')).slice(0, 5).join('\n'));
      falhas.push(`${controle.nome}: passo 1`);
      continue;
    }
    console.log('   ✔ passo 1: passa no código correto');

    // 2. defeito numa cópia
    const copia = fs.mkdtempSync(path.join(os.tmpdir(), `oria-pa-neg-${controle.nome}-`));
    let reprovou = false;
    try {
      copiarApp(copia);
      aplicarDefeito(copia, controle);
      console.log('   ✔ passo 2: defeito introduzido na cópia');

      // 3. a MESMA suíte reprova
      const comDefeito = rodar(controle.testes, copia);
      reprovou = !comDefeito.ok;
      if (reprovou) {
        const primeira = comDefeito.saida.split('\n').find((l) => l.startsWith('✖ '));
        console.log(`   ✔ passo 3: a suíte REPROVA${primeira ? ` — ${primeira.trim()}` : ''}`);
      } else {
        console.error('   ✖ passo 3: a suíte PASSOU com o defeito — este controle não detecta nada');
        falhas.push(`${controle.nome}: passo 3 (suíte cega)`);
      }
    } catch (err) {
      console.error(`   ✖ ${err.message}`);
      falhas.push(`${controle.nome}: ${err.message}`);
    } finally {
      // 4. descarta a cópia
      fs.rmSync(copia, { recursive: true, force: true });
      console.log('   ✔ passo 4: cópia descartada');
    }

    // 5. passa de novo no código correto
    const depois = rodar(controle.testes, RAIZ);
    if (!depois.ok) {
      console.error('   ✖ passo 5: a suíte não voltou a passar — o controle sujou a árvore real');
      falhas.push(`${controle.nome}: passo 5`);
    } else {
      console.log('   ✔ passo 5: volta a passar no código correto');
    }
  }

  console.log('\n────────────────────────────────────────────────────────────────');
  if (falhas.length) {
    console.error(`[negative] ${falhas.length} controle(s) com problema:`);
    for (const f of falhas) console.error(`  · ${f}`);
    return 1;
  }
  console.log(`[negative] ${selecionados.length} controle(s) OK — a suíte reprova cada defeito reintroduzido`);
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`[negative] ${err.stack || err}`);
  process.exit(1);
});
