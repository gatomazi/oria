'use strict';

// Hotfix pré-merge · D-1 e D-2 no front (contrato de fonte). O servidor é a autoridade (403); aqui se prova que a tela esconde exatamente o
// que ele nega: desconectar/trocar/conectar Meta Ads, Google Ads e GA4 só para o owner, e o card "Catálogo para análises" só com a feature.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');

const SRC = path.join(h.RAIZ_SUJEITO, 'src');
const ler = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const card = (nome) => ler(`pages/integracoes/${nome}.tsx`);

test('a regra do owner vive em UM hook compartilhado (mesma leitura do papel que a Ink e o WhatsApp usam)', () => {
  const acordeao = ler('pages/integracoes/IntegracaoAcordeao.tsx');
  assert.match(acordeao, /export function useEhOwner\(\): boolean \{\s*return useAuth\(\)\.organizacaoAtiva\?\.papel === 'owner';/);
  assert.match(card('InkCredenciaisCard'), /useEhOwner[^;]*from '\.\/IntegracaoAcordeao'/, 'a Ink usa o hook compartilhado, sem cópia local');
  assert.doesNotMatch(card('InkCredenciaisCard'), /function useEhOwner/);
});

test('Meta Ads: conectar, escolher/trocar conta, vincular à loja e desconectar só aparecem para o owner; sincronizar continua para todos', () => {
  const src = card('MetaAdsIntegracaoCard');
  assert.match(src, /const ehOwner = useEhOwner\(\);/);
  assert.match(src, /!ehOwner \? null : dados\.oauthConfigurado/, 'Conectar/Reconectar');
  assert.match(src, /ehOwner \? <Button[^\n]*onClick=\{abrirEscolha\}>Escolher conta/, 'Escolher conta');
  assert.match(src, /\{ehOwner && <Button[^\n]*onClick=\{abrirEscolha\}>Trocar conta/, 'Trocar conta');
  assert.match(src, /\{ehOwner && <Button[^\n]*setConfirmandoDesconexao\(true\)\}>Desconectar/, 'Desconectar');
  assert.match(src, /\{contaSelecionada && ehOwner && \(/, 'Vincular esta conta à loja');
  assert.match(src, /onClick=\{sincronizar\}>\s*\{dados\.syncEmAndamento \? 'Sincronizando…' : 'Sincronizar agora'\}/, 'Sincronizar agora sem guarda de papel');
  assert.match(src, /Só o responsável pela loja conecta, troca ou desconecta esta integração\./, 'o member vê o porquê');
  assert.match(src, /confirmLabel="Desconectar"/);
});

test('Google Ads: conectar, trocar/escolher conta, vincular à loja e desconectar só para o owner; sincronizar e buscar contas seguem abertos', () => {
  const src = card('GoogleAdsIntegracaoCard');
  assert.match(src, /const ehOwner = useEhOwner\(\);/);
  assert.match(src, /ehOwner && dados\.conectado && !emErro \? \(\s*<Button[^\n]*>Desconectar/);
  assert.match(src, /\{ehOwner && <Button onClick=\{conectar\}>Conectar Google Ads<\/Button>\}/);
  assert.match(src, /\{ehOwner && \(\s*<Button[^\n]*\n\s*Trocar conta/);
  assert.match(src, /\{ehOwner && <Button size="sm" onClick=\{\(\) => setEscolhendo\(true\)\}>Escolher conta/);
  assert.match(src, /\{ehOwner && <div className="ga-linha__acao">\s*<Button\s+size="sm"\s+disabled=\{salvandoLoja\}/, 'Vincular à loja');
  assert.match(src, /onClick=\{sincronizar\}/);
  assert.match(src, /onClick=\{atualizarContas\}/);
  assert.match(src, /confirmLabel="Desconectar"/);
});

test('GA4: conectar/reconectar, escolher/trocar propriedade e desconectar só para o owner', () => {
  const src = card('GoogleAnalyticsIntegracaoCard');
  assert.match(src, /const ehOwner = useEhOwner\(\);/);
  assert.match(src, /\{!ehOwner \? null : conexao\.status === 'disconnected'/, 'toda a área de ações da linha é do owner');
  assert.match(src, /confirmLabel="Desconectar"/);
  assert.match(src, /!ehOwner && <p className="pc-nota">Só o responsável/);
});

test('nenhuma ação de credencial/vínculo dos três cards escapa da guarda (todo "Desconectar"/"Conectar" está atrás de ehOwner)', () => {
  for (const nome of ['MetaAdsIntegracaoCard', 'GoogleAdsIntegracaoCard', 'GoogleAnalyticsIntegracaoCard']) {
    const src = card(nome);
    const linhas = src.split('\n');
    linhas.forEach((l, i) => {
      if (!/setConfirmandoDesconexao\(true\)|urlConectar(Meta|Ga)\(\)|onClick=\{conectar\}/.test(l)) return;
      const janela = linhas.slice(Math.max(0, i - 25), i + 1).join('\n');
      assert.match(janela, /ehOwner/, `${nome}:${i + 1} usa uma ação de credencial sem checar o papel`);
    });
  }
});

test('D-2: "Catálogo para análises" só existe com analytics_product_performance, lida pela MESMA fonte de entitlements (sem regra duplicada)', () => {
  const ink = card('InkIntegracao');
  assert.match(ink, /useEntitlement\('analytics_product_performance'\)/);
  assert.match(ink, /\{analisesDeCatalogo && <CatalogSyncCard \/>\}/);
  assert.match(ink, /<CatalogoCacheCard stores=\{lojas\} \/>/, 'o catálogo genérico (busca de produtos) continua sem essa feature');
  assert.doesNotMatch(ink, /papel|hardcode|=== 'analytics/, 'sem regra própria no card');
  // A feature é a que já esconde "Desempenho de produtos" e "Jornada de compra" no menu.
  const nav = ler('shell/nav.ts');
  assert.equal((nav.match(/feature: 'analytics_product_performance'/g) || []).length, 2);
});

test('D-2: useEntitlement é fail-closed e não vaza entre Organizations', () => {
  const src = ler('state/entitlements.ts');
  const hook = src.slice(src.indexOf('export function useEntitlement'));
  assert.match(hook, /useAuth\(\)\.organizacaoAtiva\?\.id/, 'chaveado pela Organization ativa');
  assert.match(hook, /setLido\(null\);/, 'ao trocar de Organization volta a "carregando" (nada da anterior)');
  assert.match(hook, /entitlementsCarregados\(\) && hasEntitlement\(chave\)/, 'só libera com resposta válida do servidor');
  assert.match(hook, /return lido !== null && lido\.organizacaoId === organizacaoId && lido\.liberado;/, 'carregando, falha ou outra Organization = false');
  assert.match(hook, /vivo = false/, 'resposta atrasada de outra Organization é descartada');
  // O cache só existe depois de uma resposta válida; falha de leitura não fixa "sem plano" nem "com plano".
  assert.match(src, /\.catch\(\(\) => \{\s*\/\/ Sem cache/);
});
