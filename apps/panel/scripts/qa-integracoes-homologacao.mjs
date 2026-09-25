#!/usr/bin/env node
// Homologação funcional de Integrações no navegador REAL (Playwright) contra o backend local (server.js + Postgres descartável), com os
// providers externos simulados por test/helpers/provider-mock.cjs. Só dados SINTÉTICOS: tokens fabricados, nenhuma conta real; nada sai da máquina.
//
// Servidor esperado (porta HOM_BASE, padrão 18086), iniciado com o mock e com as variáveis de PLATAFORMA de teste:
//   node --require ./test/helpers/provider-mock.cjs server.js
//   GOOGLE_CLIENT_ID/SECRET/OAUTH_REDIRECT_URI e META_ADS_APP_ID/SECRET/OAUTH_REDIRECT_URI fictícios; WHATSAPP_SERVICE_URL/API_KEY apontando
//   para um serviço falso local; ORIA_JOBS_DE_FUNDO=off; DB_ENFORCE_APP_ROLE=1.
// Ambiente: SMOKE_PASSWORD, SEED_DATABASE_URL (banco local, superusuário — só para conceder planos/vínculos sintéticos e limpar depois).
//
// Resultado por cenário: validado | falhou | bloqueado (credencial/ambiente). Bloqueado nunca conta como aprovado.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const pg = require(require.resolve('pg', { paths: [process.cwd()] }));
const { gerarHash } = require('../lib/auth/password.js');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.HOM_BASE || 'http://localhost:18086';
const SENHA = process.env.SMOKE_PASSWORD;
const DB = process.env.SEED_DATABASE_URL;
const OUT = path.resolve(arg('out', './relatorios-privados/redesign-integracoes'));
if (!SENHA || !DB) throw new Error('defina SMOKE_PASSWORD e SEED_DATABASE_URL (banco local de teste)');
if (!['127.0.0.1', 'localhost'].includes(new URL(DB).hostname)) throw new Error('recusado: banco não-local');
if (!['127.0.0.1', 'localhost'].includes(new URL(BASE).hostname)) throw new Error('recusado: servidor não-local');
fs.mkdirSync(OUT, { recursive: true });

const ORG1 = 'a1000000-0000-4000-8000-000000000001';
const ORG2 = 'a1000000-0000-4000-8000-000000000002';
const EMAIL_DONO = 'local@teste.oria';
const EMAIL_EQUIPE = 'equipe-homolog@teste.oria';
// Tokens 100% fictícios. A 4ª letra do token da Ink escolhe a "loja de teste" do mock (C = Org 1, D = Org 2).
const TOKEN_INK_1 = 'inkCsintetico0000000000000001';
const TOKEN_INK_2 = 'inkDsintetico0000000000000002';
const SEGREDO_WEBHOOK = 'segredo-webhook-sintetico-9999';
const CHAVE_OPENAI = 'sk-sintetica-abcdefghijklmnop1234';
const CHAVE_OPENAI_INVALIDA = 'sk-invalid-abcdefghijklmnop5678';
const SEGREDOS = [TOKEN_INK_1, TOKEN_INK_2, SEGREDO_WEBHOOK, CHAVE_OPENAI, CHAVE_OPENAI_INVALIDA];

const resultados = [];
let cenarioAtual = '';
let ambiente = '';
const ok = (nome, cond, detalhe = '') => {
  resultados.push({ ambiente, cenario: cenarioAtual, nome, status: cond ? 'validado' : 'falhou', detalhe });
  console.log(`${cond ? 'PASS' : 'FAIL'}  [${ambiente}] ${cenarioAtual} · ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};
const bloqueado = (cenario, nome, motivo) => {
  resultados.push({ ambiente: 'todos', cenario, nome, status: 'bloqueado', detalhe: motivo });
  console.log(`BLOQ  ${cenario} · ${nome} — ${motivo}`);
};

// ── Massa sintética (removida no fim) ──────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: DB, max: 2 });
async function concederPlano(org, features) {
  const chave = `homolog_${org.replace(/-/g, '')}`;
  const { rows: [plano] } = await pool.query(
    `INSERT INTO plans (chave, nome, status) VALUES ($1, $2, 'active') ON CONFLICT (chave) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`, [chave, `Plano de homologação ${org.slice(-1)}`]);
  for (const f of features) {
    await pool.query(`INSERT INTO plan_features (plan_id, feature, habilitada) VALUES ($1, $2, true) ON CONFLICT (plan_id, feature) DO UPDATE SET habilitada = true`, [plano.id, f]);
  }
  const { rows } = await pool.query('SELECT plan_id FROM organization_subscriptions WHERE organization_id = $1', [org]);
  const anterior = rows[0] ? rows[0].plan_id : null;
  if (rows[0]) await pool.query(`UPDATE organization_subscriptions SET plan_id = $2, status = 'active' WHERE organization_id = $1`, [org, plano.id]);
  else await pool.query(`INSERT INTO organization_subscriptions (organization_id, plan_id, status) VALUES ($1, $2, 'active')`, [org, plano.id]);
  return { org, anterior, plano: plano.id };
}
const FEATURES = ['analytics_ga4', 'meta_ads', 'google_ads', 'whatsapp', 'creative_generator', 'financial', 'catalog'];
// A Org 2 fica SEM `analytics_product_performance` de propósito: prova o que a tela faz para quem não tem o recurso do card "Catálogo para análises".
const FEATURES_POR_ORG = { [ORG1]: [...FEATURES, 'analytics_product_performance'], [ORG2]: FEATURES };
const desfazer = [];
// Estado de integração das duas Organizations de teste zerado antes e depois: cada execução parte do mesmo ponto (banco descartável).
const TABELAS_INTEGRACAO = ['integration_secrets', 'integrations', 'meta_ad_accounts', 'meta_connections', 'google_ads_customers', 'google_ads_connections', 'google_analytics_connections', 'creative_settings', 'oauth_states', 'webhook_eventos'];
async function zerarIntegracoes() {
  for (const t of TABELAS_INTEGRACAO) await pool.query(`DELETE FROM ${t} WHERE organization_id = ANY($1)`, [[ORG1, ORG2]]);
}
async function preparar() {
  await zerarIntegracoes();
  for (const org of [ORG1, ORG2]) desfazer.push(await concederPlano(org, FEATURES_POR_ORG[org]));
  const { rows: [dono] } = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL_DONO]);
  await pool.query(`INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [ORG2, dono.id]);
  await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`, [EMAIL_EQUIPE, await gerarHash(SENHA)]);
  const { rows: [equipe] } = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL_EQUIPE]);
  await pool.query(`INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [ORG1, equipe.id]);
  return { donoId: dono.id, equipeId: equipe.id };
}
async function limpar(ids) {
  await zerarIntegracoes().catch((e) => console.log('limpeza de integrações:', e.message));
  await pool.query('DELETE FROM organization_members WHERE user_id = ANY($1) AND organization_id = ANY($2)', [[ids.equipeId], [ORG1, ORG2]]);
  await pool.query('DELETE FROM organization_members WHERE user_id = $1 AND organization_id = $2', [ids.donoId, ORG2]);
  await pool.query('DELETE FROM users WHERE id = $1', [ids.equipeId]).catch(() => {});
  for (const d of desfazer) {
    if (d.anterior) await pool.query('UPDATE organization_subscriptions SET plan_id = $2 WHERE organization_id = $1', [d.org, d.anterior]);
    else await pool.query('DELETE FROM organization_subscriptions WHERE organization_id = $1', [d.org]);
  }
}

// ── Navegador ──────────────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
async function sessao(email, org, vp = { width: 1440, height: 900 }, mobile = false) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const login = await ctx.request.post(`${BASE}/api/admin/login`, { data: { email, password: SENHA } });
  if (!login.ok()) throw new Error(`login falhou (${email}): ${login.status()}`);
  const csrf = (await login.json()).csrfToken;
  const sel = await ctx.request.post(`${BASE}/api/admin/session/organization`, { data: { organizationId: org }, headers: { 'X-CSRF-Token': csrf } });
  if (!sel.ok()) throw new Error(`seleção de loja falhou: ${sel.status()}`);
  const page = await ctx.newPage();
  const vazamentos = [];
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  // Nenhuma resposta do servidor pode devolver um segredo digitado (a tela só recebe os 4 últimos caracteres).
  page.on('response', async (r) => {
    if (!r.url().startsWith(BASE) || !/\/api\//.test(r.url())) return;
    const corpo = await r.text().catch(() => '');
    for (const s of SEGREDOS) if (corpo.includes(s)) vazamentos.push(`${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  return { ctx, page, csrf, vazamentos, erros, api: (m, p, data) => ctx.request.fetch(`${BASE}${p}`, { method: m, data, headers: { 'X-CSRF-Token': csrf } }) };
}
let ultimaPagina = null;
const abrir = async (page, qs = '') => {
  ultimaPagina = page;
  await page.goto(`${BASE}/admin/integracoes${qs}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ig-pagina');
};
const cabecalho = (page, nome) => page.locator('.ig-linha, .ig-acordeao, [id^="ig-"]').filter({ hasText: nome }).first();
const botaoDoCard = (page, nome) => page.getByRole('button', { name: nome });
const semRolagem = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const textoPagina = (page) => page.locator('.ig-pagina').innerText();
const foto = (page, nome) => page.screenshot({ path: path.join(OUT, `${nome}.png`) });

async function cenario(nome, fn) {
  cenarioAtual = nome;
  try { await fn(); } catch (e) {
    ok('cenário concluiu sem exceção', false, String(e && e.message).split('\n')[0]);
    if (ultimaPagina) await ultimaPagina.screenshot({ path: path.join(OUT, `falha-${nome.replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
  }
}


const card = (page, p) => page.locator(`section.ig-card[data-provider="${p}"]`);
const corpo = (page, p) => page.locator(`#integracao-${p}-corpo`);
async function abrirCard(page, p) {
  const cab = page.locator(`#integracao-${p}-cabecalho`);
  if ((await cab.getAttribute('aria-expanded')) !== 'true') await cab.click();
  await corpo(page, p).waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}
const estadoDaLinha = async (page, p) => (await page.locator(`#integracao-${p}-cabecalho`).innerText()).replace(/\s+/g, ' ').trim();
// O resumo da linha é relido do servidor logo depois da ação (com uma pequena espera): aguarda o texto esperado em vez de assumir o instante.
async function linhaComTexto(page, p, re, ms = 6000) {
  const fim = Date.now() + ms;
  let t = '';
  while (Date.now() < fim) { t = await estadoDaLinha(page, p); if (re.test(t)) return { ok: true, t }; await page.waitForTimeout(150); }
  return { ok: false, t };
}
const botoesVisiveis = (page, p) => corpo(page, p).getByRole('button').evaluateAll((els) => els.filter((e) => e.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })).map((e) => `${(e.innerText || e.textContent).trim() || e.getAttribute('aria-label')}${e.disabled ? ' [desabilitado]' : ''}`));
// OAuth simulado ponta a ponta: começa o fluxo no servidor real, lê o `state` de uso único e devolve o callback como o provedor faria.
async function oauth(sessao, { inicio, callback, code }) {
  let state;
  if (inicio.tipo === 'redirect') {
    const r = await sessao.ctx.request.get(`${BASE}${inicio.caminho}`, { maxRedirects: 0 });
    state = new URL(r.headers().location).searchParams.get('state');
  } else {
    const r = await sessao.api('GET', inicio.caminho);
    state = new URL((await r.json()).url).searchParams.get('state');
  }
  await sessao.page.goto(`${BASE}${callback}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { waitUntil: 'networkidle' });
}

const ids = await preparar();
try {
  // ════════ DESKTOP 1440 · dono da Org 1 ════════
  ambiente = 'desktop-1440';
  const dono = await sessao(EMAIL_DONO, ORG1);
  const { page } = dono;
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(150000);

  await cenario('Instagram', async () => {
    await abrir(page);
    const txt = await textoPagina(page);
    ok('mostra "Em breve"', /Instagram/.test(txt) && /Em breve/.test(txt));
    ok('sem botão de expandir, sem botão nem link de conexão', (await card(page, 'instagram').locator('button, a').count()) === 0);
    await foto(page, 'desktop-00-visao-geral');
  });

  await cenario('Ink · estado inicial', async () => {
    await abrir(page);
    ok('linha da Ink: "Não conectado" (lido do servidor)', /Não conectado/.test(await estadoDaLinha(page, 'ink')), await estadoDaLinha(page, 'ink'));
    await abrirCard(page, 'ink');
    await corpo(page, 'ink').getByText(/Credencial (não )?cadastrada/).first().waitFor();
    const txt = await corpo(page, 'ink').innerText();
    ok('credencial não cadastrada; sem "Testar conexão" nem "Remover" (nada para testar/remover)', /Credencial não cadastrada/.test(txt) && !(await botoesVisiveis(page, 'ink')).some((b) => /Testar conexão|Remover/.test(b)), (await botoesVisiveis(page, 'ink')).join(' | '));
    await foto(page, 'desktop-01-ink-sem-credencial');
  });

  await cenario('Ink · credencial', async () => {
    await corpo(page, 'ink').getByLabel('Token da API').fill(TOKEN_INK_1);
    await corpo(page, 'ink').getByRole('button', { name: 'Salvar', exact: true }).click();
    await page.getByText(/Credencial cadastrada · final/).waitFor();
    ok('salvar mostra "cadastrada · final xxxx" (só os 4 últimos)', /final 0001/.test(await corpo(page, 'ink').innerText()));
    ok('campo do token é limpo depois de enviar', (await corpo(page, 'ink').locator('input[type=password]').first().inputValue()) === '');
    ok('o token digitado não aparece em nenhum texto da página', !(await page.locator('body').innerText()).includes(TOKEN_INK_1) && !(await page.content()).includes(TOKEN_INK_1));
    const linha = await linhaComTexto(page, 'ink', /Credencial cadastrada/);
    ok('linha da Ink relida do servidor: "Credencial cadastrada" e NÃO "Conectado" (cadastrada ≠ validada)', linha.ok && !/\bConectado\b/.test(linha.t), linha.t);
    await foto(page, 'desktop-02-ink-credencial-salva');
    await botaoDoCard(page, 'Testar conexão').click();
    await page.getByRole('status').filter({ hasText: /funcionando|Falhou/ }).waitFor();
    ok('testar conexão devolve resultado verdadeiro do provedor (mock)', /funcionando/.test(await corpo(page, 'ink').innerText()));
  });

  await cenario('Ink · recebimento automático (webhook opcional)', async () => {
    await corpo(page, 'ink').getByRole('tab', { name: 'Pedidos' }).click();
    const txt = await corpo(page, 'ink').innerText();
    ok('"Não ativado" e aviso INFORMATIVO ("Não é uma falha")', /Não ativado/.test(txt) && /Não é uma falha/.test(txt));
    const alerta = (await page.locator('.ig-atencao').count()) ? await page.locator('.ig-atencao').innerText() : '';
    ok('a ausência do webhook NÃO vira alerta em "Atenção necessária"', !/webhook|recebimento autom/i.test(alerta), alerta.replace(/\s+/g, ' ').slice(0, 120));
    ok('a ausência do webhook não usa tom de erro (sem role=alert vermelho no corpo)', (await corpo(page, 'ink').locator('[role=alert], .ds-callout--danger').count()) === 0);
    await botaoDoCard(page, 'Ativar recebimento automático').click();
    await page.waitForTimeout(300);
    ok('guia abre e recebe o foco (teclado/leitor de tela)', await page.evaluate(() => document.activeElement?.closest('#ink-guia-recebimento') !== null));
    await botaoDoCard(page, 'Gerar URL').click();
    const urlEl = corpo(page, 'ink').locator('code.wa-token');
    await urlEl.waitFor();
    const url = (await urlEl.innerText()).trim();
    ok('URL própria da loja mostrada uma vez', /^http:\/\/localhost:18086\/.+/.test(url) && url.length > 40, url.replace(/[A-Za-z0-9_-]{16,}/g, '…'));
    await foto(page, 'desktop-03-ink-webhook-url');
    await botaoDoCard(page, 'Gerar nova URL').click();
    const dlg = page.getByRole('dialog');
    await dlg.waitFor();
    ok('regenerar a URL exige confirmação', /Gerar nova URL de recebimento/.test(await dlg.innerText()));
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    ok('Esc cancela a confirmação e devolve o foco ao botão "Gerar nova URL"', await page.evaluate(() => document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent.trim() === 'Gerar nova URL'));
    await corpo(page, 'ink').getByLabel(/Segredo do recebimento/).fill(SEGREDO_WEBHOOK);
    await botaoDoCard(page, 'Salvar segredo').click();
    await page.getByText(/Segredo cadastrado · final/).waitFor();
    await page.waitForLoadState('networkidle');
    ok('com URL e segredo, o recebimento fica "Ativo"', /Ativo/.test(await corpo(page, 'ink').innerText()));
    await abrir(page, '?provedor=ink&aba=pedidos');
    ok('depois de recarregar, a URL gerada não reaparece (mostrada uma vez)', (await corpo(page, 'ink').locator('code.wa-token').count()) === 0);
  });

  await cenario('Ink · importar pedidos e sincronizar catálogo', async () => {
    const b1 = corpo(page, 'ink').getByRole('button', { name: /Importar histórico completo/ });
    ok('"Importar histórico completo" presente e habilitado', (await b1.count()) === 1 && (await b1.isEnabled()));
    await b1.click();
    const d1 = page.getByRole('dialog');
    ok('importar pede confirmação', /Importar histórico completo de pedidos/.test(await d1.innerText()));
    await d1.getByRole('button', { name: 'Importar' }).click();
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
    await page.waitForTimeout(1500);
    ok('importação iniciada sem erro visível', (await corpo(page, 'ink').locator('[role=alert]').count()) === 0, (await corpo(page, 'ink').locator('[role=alert]').allInnerTexts()).join(' | '));
    await corpo(page, 'ink').getByRole('tab', { name: 'Catálogo' }).click();
    const b2 = corpo(page, 'ink').getByRole('button', { name: /Sincronizar catálogo agora|Sincronizando/ }).last();
    ok('cache do catálogo e "Sincronizar catálogo agora" (análises) presentes', (await corpo(page, 'ink').getByRole('button', { name: /Sincronizar catálogo agora|Sincronizando/ }).count()) === 2);
    if (await b2.isEnabled()) {
      await b2.click();
      const d2 = page.getByRole('dialog');
      ok('sincronizar catálogo pede confirmação', /Sincronizar catálogo completo/.test(await d2.innerText()));
      await d2.getByRole('button', { name: /Sincronizar|Confirmar/ }).last().click();
      await page.waitForTimeout(2500);
      ok('sincronização do catálogo sem erro visível', (await corpo(page, 'ink').locator('[role=alert]').count()) === 0, (await corpo(page, 'ink').locator('[role=alert]').allInnerTexts()).join(' | '));
    }
    await foto(page, 'desktop-04-ink-catalogo');
  });

  await cenario('Ink · remover credencial', async () => {
    await corpo(page, 'ink').getByRole('tab', { name: 'Conexão' }).click();
    await botaoDoCard(page, 'Remover').click();
    const dlg = page.getByRole('dialog');
    await dlg.waitFor();
    await page.waitForTimeout(500);
    await foto(page, 'desktop-05-ink-confirmar-remocao');
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    ok('cancelar (Esc) mantém a credencial e devolve o foco ao botão "Remover"', /Credencial cadastrada/.test(await corpo(page, 'ink').innerText()) && (await page.evaluate(() => document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent.trim() === 'Remover')));
    await botaoDoCard(page, 'Remover').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remover' }).click();
    await page.getByText('Credencial não cadastrada').waitFor();
    ok('confirmar remove: volta a "Credencial não cadastrada"', true);
    const depois = await linhaComTexto(page, 'ink', /Não conectado/);
    ok('a linha volta a "Não conectado"', depois.ok, depois.t);
  });

  await cenario('OpenAI', async () => {
    await abrir(page, '?provedor=openai');
    const c = corpo(page, 'openai');
    await c.waitFor({ state: 'visible' });
    ok('Gerador de criativos habilitado no plano de teste: formulário disponível', (await c.getByLabel(/API Key/).count()) === 1, (await c.innerText()).replace(/\s+/g, ' ').slice(0, 140));
    await c.getByLabel(/API Key/).fill(CHAVE_OPENAI);
    await c.getByRole('button', { name: 'Salvar', exact: true }).click();
    await page.getByText(/Cadastrada · final/).waitFor();
    ok('salvar: "Cadastrada · final xxxx", campo limpo, chave nunca ecoada', /final 1234/.test(await c.innerText()) && (await c.locator('input').first().inputValue()) === '' && !(await page.content()).includes(CHAVE_OPENAI));
    await c.getByRole('button', { name: 'Testar chave' }).click();
    await c.getByRole('status').filter({ hasText: /Chave válida|Falhou/ }).waitFor();
    ok('testar chave válida: "Chave válida."', /Chave válida/.test(await c.innerText()));
    await c.getByLabel(/Substituir API Key/).fill(CHAVE_OPENAI_INVALIDA);
    await c.getByRole('button', { name: 'Salvar', exact: true }).click();
    await page.getByText(/final 5678/).waitFor();
    await c.getByRole('button', { name: 'Testar chave' }).click();
    await c.getByRole('status').filter({ hasText: /Falhou/ }).waitFor();
    ok('chave inválida: o teste reporta falha (sem simular sucesso)', /Falhou/.test(await c.innerText()), (await c.getByRole('status').innerText()).slice(0, 80));
    await c.getByRole('button', { name: 'Remover' }).click();
    const dlg = page.getByRole('dialog');
    ok('remover exige confirmação', /Remover a chave da OpenAI/.test(await dlg.innerText()));
    await dlg.getByRole('button', { name: 'Remover' }).click();
    await page.getByText('Não cadastrada').first().waitFor();
    ok('confirmar remove a chave', true);
    await foto(page, 'desktop-06-openai');
  });

  await cenario('GA4', async () => {
    await abrir(page, '?provedor=ga4');
    const c = corpo(page, 'ga4');
    await c.waitFor({ state: 'visible' });
    ok('sem conexão: "Não conectado" com link Conectar (plataforma habilitada)', /Não conectado/.test(await c.innerText()) && (await c.getByRole('link', { name: 'Conectar' }).count()) === 1, await estadoDaLinha(page, 'ga4'));
    await oauth(dono, { inicio: { tipo: 'redirect', caminho: '/api/admin/integrations/google-analytics/connect' }, callback: '/api/admin/integrations/google-analytics/callback', code: 'multiA' });
    await abrir(page, '?provedor=ga4');
    await c.waitFor({ state: 'visible' });
    ok('conectado sem propriedade: "Falta escolher a propriedade" + botão de escolha (não vale como conectado)', /Falta escolher a propriedade/.test(await c.innerText()) && (await c.getByRole('button', { name: 'Escolher propriedade' }).count()) === 1, await estadoDaLinha(page, 'ga4'));
    const lin = await linhaComTexto(page, 'ga4', /Configuração pendente|escolher|Conexão incompleta/i);
    ok('a linha do resumo pede a configuração (propriedade ausente ≠ conectado)', lin.ok && !/\bConectado\b/.test(lin.t), lin.t);
    ok('o alerta "Atenção necessária" oferece a ação para escolher a propriedade', /propriedade/i.test(await page.locator('.ig-atencao').innerText().catch(() => '')), (await page.locator('.ig-atencao').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140));
    await foto(page, 'desktop-07-ga4-falta-propriedade');
    await c.getByRole('button', { name: 'Escolher propriedade' }).click();
    const sel = c.getByRole('combobox', { name: 'Propriedade do Google Analytics' });
    await sel.waitFor();
    const opcoes = await sel.locator('option').allInnerTexts();
    ok('lista as propriedades da conta Google (2 no mock)', opcoes.length === 2, opcoes.join(' | '));
    await sel.selectOption({ index: 1 });
    await c.getByRole('button', { name: 'Usar esta propriedade' }).click();
    await c.getByText('Conectado', { exact: true }).first().waitFor();
    const escolhida = opcoes[1].split(' — ')[0];
    ok('a propriedade escolhida aparece na linha do GA4', (await c.innerText()).includes(escolhida), escolhida);
    await abrir(page, '?provedor=ga4');
    ok('depois de recarregar, a seleção persiste', (await corpo(page, 'ga4').innerText()).includes(escolhida) && /Conectado/.test(await corpo(page, 'ga4').innerText()));
    const lin2 = await linhaComTexto(page, 'ga4', /Conectado/);
    ok('e o resumo passa a "Conectado"', lin2.ok, lin2.t);
    await foto(page, 'desktop-08-ga4-conectado');
  });

  await cenario('GA4 · falha de leitura ≠ reconexão', async () => {
    const rota = '**/api/admin/integrations/google-analytics/status';
    await page.route(rota, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'falha temporária de leitura' }) }));
    await abrir(page, '?provedor=ga4');
    await corpo(page, 'ga4').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    const t = await corpo(page, 'ga4').innerText();
    ok('erro de leitura do card: mostra falha + tentar de novo, sem pedir Conectar/Reconectar', /tentar de novo|Tentar novamente|falha/i.test(t) && (await corpo(page, 'ga4').getByRole('link', { name: /Conectar|Reconectar/ }).count()) === 0, t.replace(/\s+/g, ' ').slice(0, 120));
    await page.unroute(rota);
    await page.route('**/api/admin/integrations', (r) => r.request().method() === 'GET' && !/\//.test(new URL(r.request().url()).pathname.replace('/api/admin/integrations', '')) ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'falha temporária' }) }) : r.continue());
    await abrir(page);
    const geral = await textoPagina(page);
    ok('falha ao ler o resumo: estado de erro com "tentar de novo", sem exigir reconexão de ninguém', !/Reconectar|Reconexão necessária/.test(geral) && /tentar|Tentar/.test(geral), geral.replace(/\s+/g, ' ').slice(0, 140));
    await page.unroute('**/api/admin/integrations');
    await foto(page, 'desktop-09-falha-de-leitura');
  });

  await cenario('GA4 · desconectar', async () => {
    await abrir(page, '?provedor=ga4');
    const c = corpo(page, 'ga4');
    await c.getByRole('button', { name: 'Desconectar' }).click();
    const dlg = page.getByRole('dialog');
    ok('desconectar pede confirmação, e o botão de confirmar diz "Desconectar" (não "Excluir")', /Desconectar o Google Analytics/.test(await dlg.innerText()) && (await dlg.getByRole('button', { name: 'Desconectar', exact: true }).count()) === 1);
    await dlg.getByRole('button', { name: 'Desconectar', exact: true }).click();
    await c.getByText('Não conectado', { exact: true }).first().waitFor();
    ok('desconectado: volta a "Não conectado"', true);
  });

  await cenario('Meta Ads', async () => {
    await oauth(dono, { inicio: { tipo: 'redirect', caminho: '/api/admin/integrations/meta/connect' }, callback: '/api/admin/integrations/meta/callback', code: 'metaA' });
    await abrir(page, '?provedor=meta_ads');
    const c = corpo(page, 'meta_ads');
    await c.waitFor({ state: 'visible' });
    await c.getByText('Falta escolher a conta').waitFor();
    const lin = await linhaComTexto(page, 'meta_ads', /Configuração pendente/);
    ok('autorizou a Meta sem escolher conta: "Falta escolher a conta" e resumo "Configuração pendente" (não "Conectado")', lin.ok, lin.t);
    await c.getByRole('button', { name: 'Escolher conta' }).click();
    const radios = c.getByRole('radio');
    await radios.first().waitFor();
    const nContas = await radios.count();
    ok('lista as contas de anúncios da conta Meta (mock)', nContas >= 1, `${nContas} conta(s)`);
    await radios.first().check({ force: true });
    await c.getByRole('button', { name: 'Usar esta conta' }).click();
    await c.getByRole('button', { name: 'Desconectar' }).waitFor();
    const t = await c.innerText();
    ok('conta escolhida: aparece "Conectado" e a ação "Trocar conta"', /Conectado/.test(t) && (await c.getByRole('button', { name: 'Trocar conta' }).count()) === 1, t.replace(/\n+/g, ' | ').slice(0, 200));
    await abrir(page, '?provedor=meta_ads');
    ok('depois de recarregar, a conta escolhida persiste', /Conectado/.test(await corpo(page, 'meta_ads').innerText()) && (await botoesVisiveis(page, 'meta_ads')).some((b) => /Trocar conta/.test(b)));
    const lin2 = await linhaComTexto(page, 'meta_ads', /Conectado/);
    ok('resumo da linha coerente: "Conectado"', lin2.ok, lin2.t);
    await foto(page, 'desktop-10-meta-conectada');
  });

  await cenario('Google Ads', async () => {
    await pool.query(`INSERT INTO google_ads_customers (organization_id, customer_id, nome, currency, timezone_name) VALUES ($1, '1112223334', 'Conta Ads Sintética Org 1', 'BRL', 'America/Sao_Paulo') ON CONFLICT DO NOTHING`, [ORG1]);
    await oauth(dono, { inicio: { tipo: 'json', caminho: '/api/admin/integrations/google-ads/oauth/start' }, callback: '/api/admin/integrations/google-analytics/callback', code: 'gadsA' });
    await abrir(page, '?provedor=google_ads');
    const c = corpo(page, 'google_ads');
    await c.waitFor({ state: 'visible' });
    await c.getByText('Escolha a conta de anúncios').waitFor();
    const lin = await linhaComTexto(page, 'google_ads', /Configuração pendente/);
    ok('autorizou o Google Ads sem escolher conta: "Escolha a conta de anúncios" e resumo "Configuração pendente"', lin.ok, lin.t);
    await c.getByRole('button', { name: 'Escolher conta' }).click();
    const radios = c.getByRole('radio');
    await radios.first().waitFor();
    ok('lista a conta sincronizada desta Organization', (await c.innerText()).includes('Conta Ads Sintética Org 1'));
    await radios.first().check({ force: true });
    await c.getByRole('button', { name: /Usar esta conta|Salvar|Confirmar/ }).first().click();
    await page.waitForTimeout(1200);
    const t = await c.innerText();
    ok('conta escolhida aparece na tela (nome da conta) com opção de trocar/desconectar', /Conta Ads Sintética Org 1/.test(t) && (await botoesVisiveis(page, 'google_ads')).some((b) => /Desconectar/.test(b)), t.replace(/\n+/g, ' | ').slice(0, 220));
    await foto(page, 'desktop-11-google-ads');
    bloqueado('Google Ads', 'listagem real de contas pela API do Google Ads / sincronização de campanhas', 'sem developer token e conta Google Ads de teste; o mock devolve lista vazia (a conta do teste foi semeada no banco descartável)');
  });

  await cenario('Permissões · membro da equipe (Org 1)', async () => {
    // O dono cadastra a credencial da Ink (pela API) para o membro enxergar um estado "cadastrado".
    const put = await dono.api('PUT', '/api/admin/integrations/ink/credenciais', { apiToken: TOKEN_INK_1 });
    ok('preparo: dono cadastra a credencial da Ink', put.ok(), String(put.status()));
    const equipe = await sessao(EMAIL_EQUIPE, ORG1);
    const ep = equipe.page;
    ep.setDefaultTimeout(45000);
    await abrir(ep, '?provedor=ink');
    const c = corpo(ep, 'ink');
    await c.waitFor({ state: 'visible' });
    await ep.getByText(/Credencial cadastrada · final/).waitFor();
    const t = await c.innerText();
    ok('membro vê o estado da Ink e a nota "Só o responsável…"', /Só o responsável pela loja cadastra ou remove/.test(t));
    ok('membro NÃO vê campo de token nem Salvar/Remover, mas pode "Testar conexão"', (await c.locator('input[type=password]').count()) === 0 && (await botoesVisiveis(ep, 'ink')).join('|') === 'Testar conexão', (await botoesVisiveis(ep, 'ink')).join('|'));
    await c.getByRole('tab', { name: 'Pedidos' }).click();
    ok('membro não vê "Ativar recebimento automático" nem "Gerar URL"; vê a nota de que só o responsável ativa', (await botoesVisiveis(ep, 'ink')).every((b) => !/Ativar recebimento|Gerar/.test(b)) && /Só o responsável/.test(await c.innerText()), (await botoesVisiveis(ep, 'ink')).join('|'));
    const escrita = await equipe.api('PUT', '/api/admin/integrations/ink/credenciais', { apiToken: TOKEN_INK_2 });
    ok('o servidor recusa a gravação da credencial pelo membro (403)', escrita.status() === 403, String(escrita.status()));
    const remocao = await equipe.api('DELETE', '/api/admin/integrations/ink/credenciais');
    ok('o servidor recusa a remoção da credencial pelo membro (403)', remocao.status() === 403, String(remocao.status()));
    // Meta / Google Ads / GA4 / OpenAI: o que o membro enxerga e o que o servidor permite.
    for (const [p, ini] of [['meta_ads', 'Meta Ads'], ['google_ads', 'Google Ads'], ['ga4', 'Google Analytics 4'], ['openai', 'OpenAI']]) {
      await abrir(ep, `?provedor=${p}`);
      await corpo(ep, p).waitFor({ state: 'visible' });
      await ep.waitForTimeout(700);
      console.log(`     (info) membro em ${ini}: botões = ${(await botoesVisiveis(ep, p)).join(' ; ')}`);
    }
    const tentaMeta = await equipe.api('POST', '/api/admin/integrations/meta/disconnect', {});
    const tentaGa = await equipe.api('POST', '/api/admin/integrations/google-analytics/disconnect', {});
    const tentaGads = await equipe.api('POST', '/api/admin/integrations/google-ads/disconnect', {});
    console.log(`     (info) membro tenta desconectar: Meta=${tentaMeta.status()} GA4=${tentaGa.status()} GoogleAds=${tentaGads.status()}`);
    await equipe.ctx.close();
    await dono.api('DELETE', '/api/admin/integrations/ink/credenciais');
  });

  await cenario('Troca de organização com o painel aberto', async () => {
    const prepararMeta = async (sess, code) => {
      await oauth(sess, { inicio: { tipo: 'redirect', caminho: '/api/admin/integrations/meta/connect' }, callback: '/api/admin/integrations/meta/callback', code });
      const contas = (await (await sess.api('GET', '/api/admin/integrations/meta/ad-accounts')).json()).contas;
      await sess.api('POST', '/api/admin/integrations/meta/select-account', { metaAccountId: contas[0].metaAccountId });
      return contas[0];
    };
    await dono.api('PUT', '/api/admin/integrations/ink/credenciais', { apiToken: TOKEN_INK_1 });
    const c1 = await prepararMeta(dono, 'metaA');
    const dono2 = await sessao(EMAIL_DONO, ORG2);
    await dono2.api('PUT', '/api/admin/integrations/ink/credenciais', { apiToken: TOKEN_INK_2 });
    const c2 = await prepararMeta(dono2, 'metaB');
    await dono2.ctx.close();
    ok('preparo: cada Organization com a sua Ink (finais 0001/0002) e a sua conta Meta', c1.metaAccountId !== c2.metaAccountId, `${c1.metaAccountId} · ${c2.metaAccountId}`);

    // Org 1 aberta em Ink, com o token mascarado à vista.
    await abrir(page, '?provedor=ink');
    await page.getByText(/final 0001/).first().waitFor();
    ok('Org 1: Ink aberta mostra o final 0001', true);
    // Resposta ATRASADA: a leitura do resumo demora; a troca acontece antes de ela chegar.
    await page.route('**/api/admin/integrations', async (r) => { await new Promise((ok2) => setTimeout(ok2, 4000)); await r.continue().catch(() => {}); });
    const antes = page.url();
    const espera = page.waitForNavigation({ waitUntil: 'load' });
    await page.getByRole('combobox', { name: 'Loja em que você está trabalhando' }).selectOption(ORG2);
    await espera;
    await page.unroute('**/api/admin/integrations').catch(() => {});
    await page.waitForSelector('.ig-pagina');
    await page.getByText(/final 0002/).first().waitFor();
    const txt = await page.locator('.ig-pagina').innerText();
    ok('Org 2 depois da troca: Ink mostra o final 0002 e NÃO o 0001 (nada reaproveitado da Org 1)', /final 0002/.test(txt) && !/final 0001/.test(txt));
    ok('a resposta atrasada da Org 1 não sobrescreveu a tela da Org 2 (sem erro de JS)', dono.erros.length === 0, dono.erros.join(' | '));
    ok('a loja exibida é a da Org 2 ("Use Centro"), não a da Org 1 ("Use Sul")', /Use Centro/.test(txt) && !/Use Sul/.test(txt));
    await abrir(page, '?provedor=meta_ads');
    await corpo(page, 'meta_ads').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    const meta2 = await corpo(page, 'meta_ads').innerText();
    ok('Org 2: Meta mostra a conta da Org 2 (B) e nenhuma da Org 1 (A)', meta2.includes(c2.metaAccountId) && !meta2.includes(c1.metaAccountId), `${c2.metaAccountId} em vez de ${c1.metaAccountId}`);
    await foto(page, 'desktop-12-org2-apos-troca');
    // Catálogo: a Org 2 não tem o recurso de análises (feature ausente): o que a tela faz?
    await abrir(page, '?provedor=ink&aba=catalogo');
    await corpo(page, 'ink').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    const cat = await corpo(page, 'ink').innerText();
    console.log(`     (info) Org 2 sem 'analytics_product_performance', aba Catálogo: ${cat.replace(/\n+/g, ' | ').slice(200, 900)}`);
    // Volta para a Org 1 e confere que nada da Org 2 ficou.
    await page.getByRole('combobox', { name: 'Loja em que você está trabalhando' }).selectOption(ORG1);
    await page.waitForLoadState('load');
    await page.waitForSelector('.ig-pagina');
    await page.getByText(/final 0001/).first().waitFor().catch(() => {});
    ok('de volta à Org 1: só dados da Org 1', !/final 0002/.test(await page.locator('.ig-pagina').innerText()));
  });

  await cenario('Fechar o card com requisição pendente', async () => {
    await abrir(page);
    await page.route('**/api/admin/integrations/ink/credenciais', async (r) => { await new Promise((f) => setTimeout(f, 2500)); await r.continue().catch(() => {}); });
    await page.locator('#integracao-ink-cabecalho').click();
    await corpo(page, 'ink').waitFor({ state: 'visible' });
    await page.locator('#integracao-ink-cabecalho').click();
    await page.waitForTimeout(3500);
    ok('fechar durante a leitura pendente não gera erro nem reabre o card', (await page.locator('#integracao-ink-cabecalho').getAttribute('aria-expanded')) === 'false' && dono.erros.length === 0, dono.erros.join(' | '));
    await page.unroute('**/api/admin/integrations/ink/credenciais');
  });

  await cenario('WhatsApp', async () => {
    const TOKEN_WA = 'EAAWsinteticoZZ0000000000000000000';
    SEGREDOS.push(TOKEN_WA);
    await abrir(page, '?provedor=whatsapp&aba=conexao');
    const c = corpo(page, 'whatsapp');
    await c.waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    ok('deep link ?provedor=whatsapp&aba=conexao abre o card com o foco no cabeçalho', await page.evaluate(() => document.activeElement?.id === 'integracao-whatsapp-cabecalho'));
    ok('duas abas: Conexão e Canal de envio (API da Meta × WhatsApp Web)', (await c.getByRole('tab').allInnerTexts()).join('|') === 'Conexão|Canal de envio');
    const t0 = await c.innerText();
    ok('Embedded Signup NÃO habilitado na plataforma: explica a indisponibilidade e não oferece "Conectar com a Meta"', /Conexão com a Meta indisponível/.test(t0) && (await c.getByRole('button', { name: /Conectar com a Meta/ }).count()) === 0);
    await c.getByText('Cadastro manual (avançado)').click();
    ok('cadastro manual continua acessível (ID do número, WABA, token)', (await c.getByLabel('ID do número').count()) === 1 && (await c.getByLabel(/ID da conta/).count()) === 1 && (await c.getByLabel(/Token de acesso/).count()) === 1);
    await c.getByLabel('ID do número').fill('109876543210987');
    await c.getByLabel(/ID da conta/).fill('209876543210987');
    await c.getByLabel(/Token de acesso/).fill(TOKEN_WA);
    await c.getByRole('button', { name: 'Salvar', exact: true }).click();
    await c.getByText('Token cadastrado').first().waitFor();
    ok('salvar: "Token cadastrado" (ainda não "Conectado"), token nunca ecoado', !(await page.content()).includes(TOKEN_WA) && !(await c.locator('input').evaluateAll((els) => els.some((e) => e.value.includes('EAAWsintetico')))));
    const lin = await linhaComTexto(page, 'whatsapp', /Token cadastrado|Configuração pendente|Conectado/);
    console.log(`     (info) linha do WhatsApp após cadastro manual: ${lin.t}`);
    await c.getByRole('button', { name: 'Testar conexão' }).click();
    await c.getByRole('status').filter({ hasText: /Meta reconheceu|Falhou/ }).waitFor({ timeout: 20000 }).catch(() => {});
    const resTeste = (await c.getByRole('status').allInnerTexts()).join(' ');
    ok('testar conexão devolve um resultado explícito (verdadeiro ou falha), nunca silêncio', /Meta reconheceu|Falhou/.test(resTeste), resTeste);
    await foto(page, 'desktop-13-whatsapp-manual');

    // Token recusado pela Meta: marca semeada no banco descartável (o mesmo campo que o servidor grava ao receber a recusa real).
    await pool.query(`UPDATE integrations SET config = config || jsonb_build_object('token_invalido_em', now()::text) WHERE organization_id = $1 AND provider = 'whatsapp'`, [ORG1]);
    await abrir(page, '?provedor=whatsapp&aba=conexao');
    await c.waitFor({ state: 'visible' });
    const dono1 = await c.innerText();
    ok('dono com token recusado: "Reconexão necessária" + aviso com o caminho (reconectar ou token novo)', /Reconexão necessária/.test(dono1) && /A Meta recusou a autorização/.test(dono1) && /cole um token novo/.test(dono1));
    ok('o aviso do dono tem role=alert', (await c.locator('[role=alert]').count()) >= 1);
    const alertaDono = (await page.locator('.ig-atencao').innerText().catch(() => '')).replace(/\s+/g, ' ');
    ok('"Atenção necessária" lista o WhatsApp com CTA de reconexão para o dono', /WhatsApp/.test(alertaDono), alertaDono.slice(0, 160));
    await foto(page, 'desktop-14-whatsapp-token-recusado-dono');
    const equipe = await sessao(EMAIL_EQUIPE, ORG1);
    const ep = equipe.page;
    ep.setDefaultTimeout(45000);
    await abrir(ep);
    const alertaEq = (await ep.locator('.ig-atencao').innerText().catch(() => '')).replace(/\s+/g, ' ');
    console.log(`     (info) alertas para o membro: ${alertaEq.slice(0, 200)}`);
    await abrir(ep, '?provedor=whatsapp&aba=conexao');
    await corpo(ep, 'whatsapp').waitFor({ state: 'visible' });
    await ep.waitForTimeout(800);
    const membro = await corpo(ep, 'whatsapp').innerText();
    ok('membro NÃO recebe botão de reconectar/cadastrar (só quem pode agir)', (await corpo(ep, 'whatsapp').getByRole('button', { name: /Conectar com a Meta|Salvar|Remover/ }).count()) === 0 && /Só o responsável/.test(membro), (await botoesVisiveis(ep, 'whatsapp')).join('|'));
    await foto(ep, 'desktop-15-whatsapp-token-recusado-membro');
    await equipe.ctx.close();
    ultimaPagina = page;

    // Sem CTA morto: todo botão/link visível tem nome acessível e nenhum link vazio.
    const mortos = await c.locator('button, a').evaluateAll((els) => els.filter((e) => e.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })).filter((e) => !((e.innerText || e.textContent).trim() || e.getAttribute('aria-label')) || e.getAttribute('href') === '#' || e.getAttribute('href') === '').map((e) => e.outerHTML.slice(0, 80)));
    ok('nenhum botão/link sem nome ou com destino vazio no card', mortos.length === 0, mortos.join(' | '));

    // Canal de envio: API da Meta × WhatsApp Web
    await c.getByRole('tab', { name: 'Canal de envio' }).click();
    await c.getByRole('radio', { name: /WhatsApp Web/ }).click({ force: true });
    const dlg = page.getByRole('dialog');
    await dlg.waitFor();
    ok('trocar para o WhatsApp Web pede confirmação', /Enviar pelo WhatsApp Web\?/.test(await dlg.innerText()));
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    ok('cancelar mantém a API da Meta', await c.getByRole('radio', { name: /API oficial da Meta/ }).isChecked());
    await c.getByRole('radio', { name: /WhatsApp Web/ }).click({ force: true });
    await page.getByRole('dialog').getByRole('button', { name: /Enviar pelo WhatsApp Web|Confirmar|Trocar/ }).last().click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForTimeout(1200);
    const web = await c.innerText();
    console.log(`     (info) WhatsApp Web ativo: ${web.replace(/\n+/g, ' | ').slice(0, 400)}`);
    const linhaWeb = await linhaComTexto(page, 'whatsapp', /Web|Aguardando|app/i);
    ok('modo Web: a linha do resumo reflete o canal (depende do app no computador da loja, não de "Conectado" da Meta)', linhaWeb.ok && !/Reconexão necessária/.test(linhaWeb.t), linhaWeb.t);
    await foto(page, 'desktop-16-whatsapp-web');
    await c.getByRole('radio', { name: /API oficial da Meta/ }).click({ force: true });
    await page.getByRole('dialog').getByRole('button').last().click();
    await page.getByRole('dialog').waitFor({ state: 'detached' }).catch(() => {});
    // Limpeza: remove o número (com confirmação).
    await c.getByRole('tab', { name: 'Conexão' }).click();
    if (!(await c.getByRole('button', { name: 'Remover' }).isVisible())) await c.getByText('Cadastro manual (avançado)').click();
    await c.getByRole('button', { name: 'Remover' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remover' }).click();
    await c.getByText('Número não configurado').waitFor();
    ok('remover o número exige confirmação e volta a "Número não configurado"', true);
    bloqueado('WhatsApp', 'Embedded Signup real (janela da Meta) e envio/recebimento reais pelo serviço Go', 'sem app da Meta e conta WABA de teste autorizados; o Embedded Signup nem é habilitado neste ambiente (o servidor o esconde, comportamento verificado acima)');
  });

  await cenario('Segredos nas respostas do servidor', async () => {
    ok('nenhuma resposta /api/ devolveu token, chave ou segredo digitado', dono.vazamentos.length === 0, dono.vazamentos.join(', '));
    ok('nenhum erro de JavaScript na página', dono.erros.length === 0, dono.erros.join(' | '));
  });


  // ════════ MOBILE REAL (Playwright com viewport de celular, sem iframe) ════════
  const AXE = process.env.AXE_CORE_PATH && fs.existsSync(process.env.AXE_CORE_PATH) ? fs.readFileSync(process.env.AXE_CORE_PATH, 'utf8') : null;
  // Estado do resto do dia: Ink com credencial; GA4 e Google Ads autorizados mas SEM propriedade/conta (dois alertas com CTA).
  await dono.api('PUT', '/api/admin/integrations/ink/credenciais', { apiToken: TOKEN_INK_1 });
  await oauth(dono, { inicio: { tipo: 'redirect', caminho: '/api/admin/integrations/google-analytics/connect' }, callback: '/api/admin/integrations/google-analytics/callback', code: 'multiA' });
  await oauth(dono, { inicio: { tipo: 'json', caminho: '/api/admin/integrations/google-ads/oauth/start' }, callback: '/api/admin/integrations/google-analytics/callback', code: 'gadsA' });
  await dono.ctx.close();

  for (const vp of [{ nome: 'mobile-390', w: 390, h: 844 }, { nome: 'mobile-360', w: 360, h: 800 }]) {
    ambiente = vp.nome;
    const m = await sessao(EMAIL_DONO, ORG1, { width: vp.w, height: vp.h }, true);
    const mp = m.page;
    mp.setDefaultTimeout(45000);
    mp.setDefaultNavigationTimeout(150000);
    const tocar = (loc) => loc.tap();
    const sem = async (rotulo) => ok(`sem rolagem horizontal (${rotulo})`, await semRolagem(mp), `${await mp.evaluate(() => document.documentElement.scrollWidth)}/${vp.w}`);
    const dentro = async (loc, rotulo) => { const b = await loc.boundingBox(); ok(`${rotulo} dentro da tela`, !!b && b.x >= -0.5 && b.x + b.width <= vp.w + 0.5, b ? `${b.x.toFixed(0)}+${b.width.toFixed(0)}/${vp.w}` : 'sem caixa'); };

    await cenario('Mobile · cabeçalho e menu da conta', async () => {
      await abrir(mp);
      const seletor = mp.getByRole('combobox', { name: 'Loja em que você está trabalhando' });
      const conta = mp.getByRole('button', { name: 'Abrir menu da conta e da loja' });
      const hamb = mp.getByRole('button', { name: 'Abrir menu de navegação' });
      const [bs, bc, bh] = [await seletor.boundingBox(), await conta.boundingBox(), await hamb.boundingBox()];
      const cruza = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      ok('seletor de loja, menu da conta e menu de navegação não se sobrepõem', !cruza(bs, bc) && !cruza(bs, bh) && !cruza(bc, bh), `seletor ${bs.width.toFixed(0)}px · conta ${bc.width.toFixed(0)}px`);
      ok('o gatilho da conta é só avatar + chevron (sem repetir o nome da loja)', (await conta.innerText()).trim().length <= 3);
      await foto(mp, `${vp.nome}-01-cabecalho`);
      await tocar(conta);
      await mp.waitForSelector('.ad-store-menu__content');
      await dentro(mp.locator('.ad-store-menu__content'), 'menu da conta aberto');
      await foto(mp, `${vp.nome}-02-menu-da-conta`);
      await mp.keyboard.press('Escape');
      await mp.waitForSelector('.ad-store-menu__content', { state: 'detached' });
      await sem('cabeçalho');
    });

    await cenario('Mobile · visão geral com alerta de dois CTAs', async () => {
      await abrir(mp);
      const itens = mp.locator('.ig-atencao li');
      await itens.first().waitFor();
      const n = await itens.count();
      ok('"Atenção necessária" com dois itens, cada um com o seu CTA', n === 2 && (await mp.locator('.ig-atencao li button').count()) === 2, `${n} itens`);
      const txt = await mp.locator('.ig-atencao').innerText();
      ok('os dois alertas são os esperados (GA4 e Google Ads)', /Google Analytics 4/.test(txt) && /Google Ads/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 160));
      const btns = mp.locator('.ig-atencao li button');
      const caixas = [await btns.nth(0).boundingBox(), await btns.nth(1).boundingBox()];
      ok('CTAs inteiros na tela e com alvo de toque ≥ 32 px de altura', caixas.every((b) => b.x >= 0 && b.x + b.width <= vp.w + 0.5 && b.height >= 32), caixas.map((b) => `${b.width.toFixed(0)}×${b.height.toFixed(0)}`).join(' · '));
      const cortado = await mp.locator('.ig-atencao li').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
      ok('texto do alerta não é cortado', cortado === 0);
      await sem('visão geral');
      await foto(mp, `${vp.nome}-03-visao-geral-alertas`);
      await tocar(btns.first());
      await mp.waitForTimeout(500);
      ok('o CTA abre o provedor certo e leva o foco ao cabeçalho', (await mp.locator('.ig-card__cabecalho[aria-expanded=true]').count()) === 1 && (await mp.evaluate(() => document.activeElement?.classList.contains('ig-card__cabecalho'))));
    });

    await cenario('Mobile · um card aberto por vez, abas da Ink e modal', async () => {
      await abrir(mp);
      await tocar(mp.locator('#integracao-ink-cabecalho'));
      await corpo(mp, 'ink').waitFor({ state: 'visible' });
      await tocar(mp.locator('#integracao-ga4-cabecalho'));
      await corpo(mp, 'ga4').waitFor({ state: 'visible' });
      ok('abrir outro provedor recolhe o anterior (só um card aberto)', (await mp.locator('.ig-card__cabecalho[aria-expanded=true]').count()) === 1 && (await mp.locator('#integracao-ink-cabecalho').getAttribute('aria-expanded')) === 'false');
      await foto(mp, `${vp.nome}-04-card-aberto-ga4`);
      await tocar(mp.locator('#integracao-ink-cabecalho'));
      await corpo(mp, 'ink').getByRole('tab', { name: 'Conexão' }).waitFor();
      const abas = corpo(mp, 'ink').getByRole('tab');
      ok('abas da Ink (Conexão, Pedidos, Catálogo) visíveis e alcançáveis', (await abas.count()) === 3);
      for (const nome of ['Pedidos', 'Catálogo', 'Conexão']) {
        await tocar(corpo(mp, 'ink').getByRole('tab', { name: nome }));
        await mp.waitForTimeout(500);
        ok(`aba ${nome} abre e o conteúdo cabe na tela`, (await corpo(mp, 'ink').getByRole('tab', { name: nome }).getAttribute('aria-selected')) === 'true' && (await semRolagem(mp)));
        if (nome !== 'Conexão') await foto(mp, `${vp.nome}-05-ink-aba-${nome.toLowerCase().replace('á', 'a')}`);
      }
      await corpo(mp, 'ink').getByText(/Credencial cadastrada · final/).waitFor();
      await foto(mp, `${vp.nome}-05-ink-aba-conexao`);
      await tocar(botaoDoCard(mp, 'Remover'));
      const dlg = mp.getByRole('dialog');
      await dlg.waitFor();
      await dentro(dlg, 'modal de confirmação');
      const bd = await dlg.getByRole('button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { n: e.innerText.trim(), ok: r.x >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 && r.height >= 32 }; }));
      ok('modal: botões inteiros na tela e com alvo de toque ≥ 32 px', bd.length >= 2 && bd.every((b) => b.ok), bd.map((b) => b.n).join(' · '));
      ok('modal: sem rolagem horizontal do corpo e foco dentro do diálogo', (await semRolagem(mp)) && (await mp.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))));
      await mp.waitForTimeout(500);
      await foto(mp, `${vp.nome}-06-modal-confirmacao`);
      await mp.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
      ok('Esc fecha o modal e devolve o foco ao botão "Remover"', await mp.evaluate(() => document.activeElement?.textContent?.trim() === 'Remover'));
    });

    await cenario('Mobile · drawer e rolagem', async () => {
      await abrir(mp, '?provedor=ink');
      await tocar(mp.getByRole('button', { name: 'Abrir menu de navegação' }));
      const gaveta = mp.locator('#ad-sidebar');
      await mp.waitForTimeout(400);
      await dentro(gaveta, 'drawer aberto');
      ok('drawer aberto: foco em "Fechar menu de navegação" e o conteúdo fica inerte', await mp.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Fechar menu de navegação' && !!document.querySelector('.ad-main[inert], main[inert]')));
      await sem('drawer aberto');
      await foto(mp, `${vp.nome}-07-drawer-aberto`);
      await mp.keyboard.press('Escape');
      await mp.waitForTimeout(400);
      ok('Esc fecha o drawer e o foco volta ao botão de menu', await mp.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Abrir menu de navegação'));
      const y0 = await mp.evaluate(() => window.scrollY);
      await mp.mouse.wheel(0, 900).catch(() => {});
      await mp.evaluate(() => window.scrollBy(0, 900));
      await mp.waitForTimeout(300);
      ok('o conteúdo rola verticalmente (página longa com o card aberto)', (await mp.evaluate(() => window.scrollY)) > y0);
      await sem('depois de rolar');
      await foto(mp, `${vp.nome}-08-rolagem`);
    });

    await cenario('Mobile · teclado e acessibilidade', async () => {
      await abrir(mp);
      // Tab: do topo da página até o primeiro cabeçalho de provedor; Shift+Tab volta; Enter/Espaço alternam.
      await mp.evaluate(() => { document.body.focus(); window.scrollTo(0, 0); });
      let achou = false;
      for (let i = 0; i < 25 && !achou; i += 1) { await mp.keyboard.press('Tab'); achou = await mp.evaluate(() => document.activeElement?.classList.contains('ig-card__cabecalho')); }
      ok('Tab chega ao primeiro cabeçalho de provedor', achou);
      const id = await mp.evaluate(() => document.activeElement?.id);
      await mp.keyboard.press('Enter');
      await mp.waitForTimeout(400);
      ok('Enter abre o card', (await mp.locator(`#${id}`).getAttribute('aria-expanded')) === 'true');
      await mp.keyboard.press('Space');
      await mp.waitForTimeout(400);
      ok('Espaço fecha o card', (await mp.locator(`#${id}`).getAttribute('aria-expanded')) === 'false');
      await mp.keyboard.press('Shift+Tab');
      ok('Shift+Tab sai do cabeçalho para o controle anterior', await mp.evaluate((i) => document.activeElement?.id !== i, id));
      // Deep link: foco no cabeçalho do provedor indicado
      await abrir(mp, '?provedor=google_ads');
      await mp.waitForTimeout(600);
      ok('deep link ?provedor=google_ads: card aberto e foco no cabeçalho', (await mp.locator('#integracao-google_ads-cabecalho').getAttribute('aria-expanded')) === 'true' && (await mp.evaluate(() => document.activeElement?.id === 'integracao-google_ads-cabecalho')));
      // Controles só com ícone precisam de nome acessível.
      const sem_nome = await mp.locator('button, a[href], [role=button], [role=tab]').evaluateAll((els) => els
        .filter((e) => e.checkVisibility({ checkVisibilityCSS: true }))
        .filter((e) => !((e.innerText || '').trim() || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title')))
        .map((e) => e.outerHTML.slice(0, 90)));
      ok('todo controle visível tem nome acessível (ícones sem texto incluídos)', sem_nome.length === 0, sem_nome.join(' | '));
      if (AXE) {
        await mp.evaluate(AXE);
        const violacoes = await mp.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id} (${v.nodes.length})`));
        ok('axe-core na página de Integrações (card aberto): nenhuma violação serious/critical', violacoes.length === 0, violacoes.join(', '));
      } else bloqueado('Acessibilidade', 'axe-core', 'AXE_CORE_PATH não informado');
      ok('nenhum erro de JavaScript', m.erros.length === 0, m.erros.join(' | '));
    });
    await m.ctx.close();
  }

  bloqueado('Reserva Ink', 'recusa do token pela Reserva Ink no "Testar conexão" e entrega real de webhook pela Ink', 'sem conta/token de teste da Reserva Ink; o mock aceita qualquer token bem formado (cobertura de recusa e de assinatura HMAC nos testes de connector/servidor, não neste navegador)');
  bloqueado('Meta Ads / Google / GA4', 'tela de consentimento OAuth real e renovação de token', 'sem apps OAuth de teste autorizados; o callback é exercitado no servidor real com o `state` de uso único emitido por ele e a troca de código simulada pelo mock');
} finally {
  fs.writeFileSync(path.join(OUT, 'resultado-integracoes.json'), JSON.stringify(resultados, null, 2));
  await limpar(ids).catch((e) => console.log('limpeza:', e.message));
  await browser.close();
  await pool.end();
  const n = (s) => resultados.filter((r) => r.status === s).length;
  console.log(`\nvalidado ${n('validado')} · falhou ${n('falhou')} · bloqueado ${n('bloqueado')} · evidências em ${OUT}`);
  process.exitCode = n('falhou') ? 1 : 0;
}
