'use strict';

// Cobertura dos negative controls: as violações, o particionamento em fatias e a garantia de que o ciclo
// nunca modifica o repositório. Não roda nenhum ciclo (custa ms); os ciclos vivem nas fatias.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RAIZ_REPO } = require('./harness');
const { VIOLACOES, FATIAS, fatiaDe } = require('../helpers/negative-controls-nucleo.cjs');

test('negative control · as fatias cobrem TODAS as violações, sem sobra e sem repetição', () => {
  const porFatia = Array.from({ length: FATIAS }, () => []);
  VIOLACOES.forEach((v, i) => porFatia[fatiaDe(i) - 1].push(`${v.classe}|${v.invariant}`));
  const uniao = porFatia.flat();
  assert.equal(uniao.length, VIOLACOES.length, 'alguma violação ficou sem fatia');
  assert.equal(new Set(uniao).size, uniao.length, 'alguma violação caiu em mais de uma fatia');
  for (const [i, fatia] of porFatia.entries()) assert.ok(fatia.length > 0, `a fatia ${i + 1} ficou vazia`);
});

test('negative control · cada fatia declarada tem seu arquivo, e nenhum arquivo de fatia sobra', () => {
  const dir = __dirname;
  for (let n = 1; n <= FATIAS; n += 1) {
    const arquivo = path.join(dir, `negative-controls-fatia-${n}.test.js`);
    assert.ok(fs.existsSync(arquivo), `falta negative-controls-fatia-${n}.test.js: os controles dessa fatia não rodariam em nenhum shard`);
    assert.match(fs.readFileSync(arquivo, 'utf8'), new RegExp(`registrarFatia\\(${n}\\);`), `a fatia ${n} não chama registrarFatia(${n})`);
  }
  const existentes = fs.readdirSync(dir).filter((f) => /^negative-controls-fatia-\d+\.test\.js$/.test(f));
  assert.equal(existentes.length, FATIAS, 'há arquivo de fatia além das FATIAS declaradas');
});

test('negative control · cobre as classes críticas das Fases 0 a 5c e da construção da Fase 7', () => {
  assert.deepEqual(
    [...new Set(VIOLACOES.map((v) => v.classe))].sort(),
    ['audit/sujeito', 'auth', 'auth/csrf', 'auth/fixation', 'auth/login-tenant', 'auth/revogacao',
      'catalogo/paginacao-ignora-page', 'clientes/chave-da-store-ausente', 'clientes/paginacao-ignora-pagina', 'connector/chamador-exige-loja-legada', 'connector/leitura-por-loja', 'connector/save-sem-atomicidade',
      'connector/store-nativa-no-path-legado', 'convite/conta-existente-troca-senha', 'convite/grant-da-role',
      'convite/motivo-vazado', 'convite/sessao-de-outro-email', 'creative/dual-read-confinamento',
      'creative/dual-read-organization', 'creative/tenant-env', 'dashboard/escopo-loja-nula',
      'dashboard/midia-zero-sem-conta', 'dre/customer-de-outra-org', 'dre/loja-atribuida-padrao', 'dre/sem-loja',
      'entitlement', 'entitlement/app-config-como-fonte', 'entitlement/ausencia', 'fase6/bypass-interno',
      'financeiro/despesas-exige-loja-legada', 'ga4/cache-sem-store-id', 'ga4/connect-exige-loja-legada',
      'ga4/oauth-aceita-store-arbitraria', 'google/chamada-sem-timeout', 'google/invalid-grant-vira-erro-generico',
      'google/retry-em-erro-definitivo', 'http/async-sem-rede', 'http/erro-vaza-stack', 'ink/catalogo-sem-store-id',
      'ink/catalogo-status-exige-loja-legada', 'ink/categorias-exige-loja-legada', 'ink/feed-descontinuado-vira-erro',
      'ink/job-catalogo-so-legado', 'ink/lote-sem-store-id', 'ink/webhook-exige-loja-legada',
      'integracoes/desconectar-cruzado', 'integracoes/env-global', 'integracoes/google-ads-exige-developer-token',
      'integracoes/instagram-finge-conexao', 'integracoes/leitura-falha-vira-nao-configurado',
      'integracoes/plataforma-ausente-vira-nao-configurado', 'integracoes/resolver-global',
      'integracoes/sem-plano-vira-conectavel', 'integracoes/token-de-outra-org', 'integracoes/webhook-adiado-rebaixa-ink',
      'jobs/contexto', 'jobs/lease-ignorado', 'meta/conexao-com-problema-vira-saudavel',
      'meta/oauth-aceita-store-arbitraria', 'midia/atribuicao-canonica-ausente', 'midia/conta-de-outra-organization',
      'midia/select-exige-loja-legada', 'midia/store-nativa-no-ramo-legado', 'oauth/org-do-navegador',
      'onboarding/chave-sem-pedido', 'onboarding/erro-bruto', 'onboarding/gate', 'onboarding/ja-existe-uma',
      'onboarding/segunda-fonte', 'operacao/auditoria-com-id-nulo', 'operacao/automacoes-so-chave-legada',
      'operacao/campanha-sem-store-id', 'operacao/escopo-exige-chave-legada', 'operacao/job-ignora-store-nativa',
      'operacao/promocoes-exigem-chave-legada', 'operacao/sessao-sem-chave-de-escopo',
      'operacao/trocas-exige-chave-legada', 'pedidos/loja-recebe-store-id', 'recuperacao/escopo', 'secrets', 'secrets/log',
      'secrets/resposta', 'store-nativa/clientes-exige-loja-legada', 'store-nativa/financeiro-exige-loja-legada',
      'store-nativa/lucro-produtos-join-por-loja', 'tenancy/agregacao-lojas', 'tenancy/candidato-unico',
      'tenancy/loja-do-request', 'tenancy/mapping', 'tenancy/ownership', 'tenancy/ownership-id', 'tenancy/rls-context',
      'utm/exige-loja-legada', 'webhook', 'webhook/ink-segredo-de-outra-org', 'webhook/ink-segredo-do-ambiente',
      'whatsapp/contexto-sem-store', 'whatsapp/entrada-divergente', 'whatsapp/entrada-org-do-corpo',
      'whatsapp/erro-cru-da-meta-na-tela', 'whatsapp/es-aceita-token-de-outro-app', 'whatsapp/es-confia-no-navegador',
      'whatsapp/es-deixa-claim-orfao', 'whatsapp/es-origem-frouxa', 'whatsapp/es-sem-posse-do-recurso',
      'whatsapp/es-state-nao-amarrado', 'whatsapp/health-como-remetente', 'whatsapp/par-cruzado', 'whatsapp/ref-forjada',
      'whatsapp/remetente-global', 'whatsapp/repasse-boot-inferido', 'whatsapp/repasse-boot-so-avisa',
      'whatsapp/repasse-rota-legada', 'whatsapp/repasse-segredo-na-query', 'whatsapp/repasse-sem-segredo',
      'whatsapp/token-expirado-vira-erro-generico', 'whatsapp/token-recusado-nao-marca-integracao',
      'whatsapp/token-serializavel', 'whatsapp/tolerancia-compara-query', 'whatsapp/tolerancia-sem-assinatura',
      'whatsapp/tolerancia-sem-flag']
  );
});

test('negative control · o repositório nunca é modificado pelo ciclo', () => {
  // Cinturão e suspensório: se alguma violação vazasse para o `lib/` real, ela estaria aqui.
  for (const v of VIOLACOES) {
    const conteudo = fs.readFileSync(path.join(RAIZ_REPO, v.arquivo), 'utf8');
    assert.ok(
      !conteudo.includes('VIOLAÇÃO DELIBERADA'),
      `${v.arquivo} contém uma violação de negative control — ela vazou para o repositório`
    );
  }
});
