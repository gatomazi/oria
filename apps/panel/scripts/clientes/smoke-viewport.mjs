#!/usr/bin/env node
// Smoke visual + funcional da tela Clientes num viewport de celular (padrão 390×844), com Playwright.
//
//   SMOKE_BASE_URL=http://localhost:8080 SMOKE_EMAIL=… SMOKE_PASSWORD=… \
//   PLAYWRIGHT_MODULE=/caminho/para/node_modules/playwright-core \
//   node scripts/clientes/smoke-viewport.mjs [--out ./evidencias] [--width 390] [--height 844]
//
// Só para um painel LOCAL com dados de teste (o e-mail/senha são de um usuário de teste que você criou): o script faz login
// pela API do próprio painel, nunca guarda credencial e não envia mensagem nem publica campanha. Redimensiona o VIEWPORT da
// página (não a janela do navegador), com emulação de toque.
//
// Confere e falha (exit ≠ 0) se:
//   · a PÁGINA tem rolagem horizontal (tabelas rolam dentro do próprio contêiner, a página não);
//   · alguma célula do treemap, chip da legenda, botão do painel ou botão do rodapé do drawer está coberto por outro elemento;
//   · o drawer não ocupa a largura toda, ou cabeçalho/rodapé não ficam fixos ao rolar o conteúdo;
//   · o segmento criado pelo CTA não chega, com o mesmo filtro e a mesma contagem, à etapa Audiência de Nova campanha.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:8080';
const EMAIL = process.env.SMOKE_EMAIL;
const SENHA = process.env.SMOKE_PASSWORD;
const OUT = path.resolve(arg('out', './evidencias-smoke'));
const W = Number(arg('width', 390));
const H = Number(arg('height', 844));
if (!EMAIL || !SENHA) throw new Error('defina SMOKE_EMAIL e SMOKE_PASSWORD (usuário de teste do painel local)');
fs.mkdirSync(OUT, { recursive: true });

const resultados = [];
const ok = (nome, cond, detalhe = '') => { resultados.push({ nome, ok: !!cond, detalhe }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
const page = await ctx.newPage();
const erros = [];
page.on('pageerror', (e) => erros.push(String(e)));
const respostasComErro = [];
page.on('response', (r) => { if (r.status() >= 400) respostasComErro.push(`${r.status()} ${new URL(r.url()).pathname}`); });
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });

try {
  // Login pela API (cookie de sessão fica no contexto).
  const login = await ctx.request.post(`${BASE}/api/admin/login`, { data: { email: EMAIL, password: SENHA } });
  if (!login.ok()) throw new Error(`login falhou: HTTP ${login.status()}`);
  const csrf = (await login.json()).csrfToken; // escritas (POST) exigem o token da sessão
  const post = (rota, data) => ctx.request.post(`${BASE}${rota}`, { data, headers: csrf ? { 'X-CSRF-Token': csrf } : {} });

  const semRolagemHorizontal = async (rotulo) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
    ok(`sem rolagem horizontal da página — ${rotulo}`, r.sw <= r.cw + 1 && r.bw <= r.cw + 1, `scrollWidth ${r.sw} / clientWidth ${r.cw}`);
  };
  // Elemento realmente "tocável": o ponto central é ele mesmo (ou descendente), não outro elemento por cima.
  const tocavel = (seletor) => page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    return els.map((el) => {
      // Traz o elemento para o meio da tela (como o usuário faria ao rolar): uma barra fixa no topo não conta como "cobertura"
      // de um botão que está só passando por baixo dela. Rodapé/cabeçalho fixos do drawer já estão sempre visíveis.
      if (!el.closest('.ds-drawer')) el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { ok: true, pulado: true };
      // Fora da viewport (precisa rolar) não é "coberto": só confere o que está visível.
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const cy = r.top + r.height / 2;
      if (cy < 0 || cy > innerHeight) return { ok: true, pulado: true };
      const topo = document.elementFromPoint(cx, cy);
      return { ok: !!topo && (el === topo || el.contains(topo)), texto: (el.innerText || '').slice(0, 30) };
    });
  }, seletor);

  // ── 1. Indicadores ──────────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ds-kpi-strip');
  await semRolagemHorizontal('indicadores');
  const kpis = await page.$$eval('.ds-kpi', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, w: r.width, r: r.right }; }));
  ok('KPIs em grade de 2 colunas e dentro da viewport', kpis.length === 6 && kpis.every((k) => k.l >= 0 && k.r <= W + 1) && new Set(kpis.map((k) => Math.round(k.l))).size <= 2, `${kpis.length} células`);
  await page.screenshot({ path: path.join(OUT, '01-indicadores.png') });

  // ── 2. RFM Explorer: 11 linhas com nome completo, sem hover/toque ────────────────────────────────
  await page.locator('.rfmx').scrollIntoViewIfNeeded();
  await semRolagemHorizontal('distribuição RFM');
  const linhas = await page.$$eval('.rfmx-linha', (els) => els.map((e) => ({
    nome: e.querySelector('.rfmx-nome').innerText.trim(), nomeCortado: e.querySelector('.rfmx-nome').scrollWidth > e.querySelector('.rfmx-nome').clientWidth + 1,
    h: Math.round(e.getBoundingClientRect().height), l: e.getBoundingClientRect().left, r: e.getBoundingClientRect().right, aria: e.getAttribute('aria-label') || '',
  })));
  ok('as 11 linhas do RFM Explorer estão presentes (inclusive zero e < 1%)', linhas.length === 11, `${linhas.length} linhas`);
  ok('nome completo visível em todas, sem truncar (Primeira compra de alto valor, Aguardando recompra…)', linhas.every((l) => !l.nomeCortado) && linhas.some((l) => l.nome === 'Primeira compra de alto valor') && linhas.some((l) => l.nome === 'Aguardando recompra'), linhas.filter((l) => l.nomeCortado).map((l) => l.nome).join(', '));
  ok('linhas dentro da viewport e com alvo de toque ≥ 44 px', linhas.every((l) => l.l >= 0 && l.r <= W + 1 && l.h >= 44), `alturas ${Math.min(...linhas.map((l) => l.h))}–${Math.max(...linhas.map((l) => l.h))}`);
  ok('cada linha tem aria-label com nome, clientes e %', linhas.every((l) => /clientes?, [\d,.]+% da base/.test(l.aria)));
  const coberta = await tocavel('.rfmx-linha');
  ok('nenhuma linha coberta por outro elemento', coberta.every((c) => c.ok), `${coberta.length} linhas`);
  await page.screenshot({ path: path.join(OUT, '02-explorer.png') });

  // ── 3. Seleção, painel do segmento e CTA ────────────────────────────────────────────────────────
  await page.locator('.rfmx-linha', { has: page.locator('.rfmx-nome', { hasText: /^Novos$/ }) }).first().tap();
  const painel = page.locator('.segp').first();
  await painel.scrollIntoViewIfNeeded();
  ok('painel do segmento aparece após selecionar', await painel.locator('.segp__titulo', { hasText: 'Novos' }).count() === 1);
  const cta = painel.getByRole('button', { name: 'Criar campanha com este segmento' });
  const ctaBox = await cta.boundingBox();
  ok('CTA dentro da viewport e com largura útil', ctaBox && ctaBox.x >= 0 && ctaBox.x + ctaBox.width <= W && ctaBox.width > 200, ctaBox ? `${Math.round(ctaBox.width)}px` : 'sem caixa');
  const cobertos = await tocavel('.segp .ds-btn');
  ok('botões do painel tocáveis', cobertos.every((c) => c.ok));
  await semRolagemHorizontal('painel do segmento');
  await page.screenshot({ path: path.join(OUT, '03-painel-e-cta.png') });

  // ── 4. Filtros e tabela ─────────────────────────────────────────────────────────────────────────
  await page.locator('#clientes-lista').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /^Filtros/ }).tap();
  await page.waitForSelector('.cli-avancados');
  await semRolagemHorizontal('filtros avançados');
  const inputs = await page.$$eval('.cli-avancados input, .cli-avancados select', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, h: r.height }; }));
  ok('campos dos filtros dentro da viewport', inputs.length >= 12 && inputs.every((i) => i.l >= 0 && i.r <= W + 1), `${inputs.length} campos`);
  ok('campos dos filtros com altura de toque (≥ 32px)', inputs.every((i) => i.h >= 32));
  await page.screenshot({ path: path.join(OUT, '04-filtros.png') });
  await page.getByRole('button', { name: /Ocultar filtros/ }).tap();
  await page.waitForSelector('table[aria-label="Clientes"] tbody tr');
  const tab = await page.evaluate(() => {
    const wrap = document.querySelector('table[aria-label="Clientes"]').closest('.ds-table-wrap');
    const cab = [...document.querySelectorAll('table[aria-label="Clientes"] th')].filter((t) => getComputedStyle(t).display !== 'none').map((t) => t.innerText.trim());
    return { wrapW: wrap.getBoundingClientRect().width, rolavel: wrap.scrollWidth > wrap.clientWidth, cab };
  });
  ok('tabela cabe na viewport (rola por dentro se preciso)', tab.wrapW <= W, `contêiner ${Math.round(tab.wrapW)}px, rolagem interna: ${tab.rolavel}`);
  ok('colunas de apoio ocultas no celular, essenciais mantidas', tab.cab.includes('Nome') && tab.cab.includes('Segmento') && tab.cab.includes('LTV') && !tab.cab.includes('Contato'), tab.cab.join(', '));
  await semRolagemHorizontal('tabela');
  await page.screenshot({ path: path.join(OUT, '05-tabela.png') });

  // ── 5. Drawer em tela cheia ─────────────────────────────────────────────────────────────────────
  await page.locator('table[aria-label="Clientes"] tbody tr').first().tap();
  const drawer = page.locator('.ds-drawer');
  await drawer.waitFor();
  await page.waitForSelector('.cli-drawer');
  await page.waitForTimeout(400); // fim da animação de entrada do drawer (240 ms)
  const caixa = await drawer.boundingBox();
  ok('drawer ocupa a largura toda da viewport', caixa && caixa.x <= 1 && Math.abs(caixa.width - W) <= 1 && Math.abs(caixa.height - H) <= 1, caixa ? `${Math.round(caixa.width)}×${Math.round(caixa.height)}` : '');
  await semRolagemHorizontal('drawer aberto');
  await page.screenshot({ path: path.join(OUT, '06-drawer-topo.png') });
  // Rola o conteúdo do drawer: cabeçalho e rodapé têm que continuar colados no topo e na base.
  await page.evaluate(() => { const d = document.querySelector('.ds-drawer'); d.scrollTo(0, d.scrollHeight); });
  await page.waitForTimeout(200);
  const fixos = await page.evaluate(() => {
    const h = document.querySelector('.ds-drawer__header').getBoundingClientRect();
    const f = document.querySelector('.ds-drawer__footer').getBoundingClientRect();
    return { headerTop: Math.round(h.top), footerBottom: Math.round(f.bottom), alturaJanela: innerHeight, rolou: document.querySelector('.ds-drawer').scrollTop > 0 };
  });
  ok('conteúdo do drawer rola', fixos.rolou);
  ok('cabeçalho fixo no topo ao rolar', fixos.headerTop === 0, `top ${fixos.headerTop}`);
  ok('rodapé fixo na base ao rolar', Math.abs(fixos.footerBottom - fixos.alturaJanela) <= 1, `bottom ${fixos.footerBottom} / ${fixos.alturaJanela}`);
  const rodape = await tocavel('.ds-drawer__footer .ds-btn, .ds-drawer__footer a');
  ok('botões do rodapé do drawer tocáveis (nada por cima)', rodape.length >= 2 && rodape.every((c) => c.ok), `${rodape.length} botões`);
  const semSobreposicaoRodape = await page.evaluate(() => {
    const itens = [...document.querySelectorAll('.ds-drawer__footer > *')].map((e) => e.getBoundingClientRect());
    return itens.every((a, i) => itens.every((b, j) => i === j || a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1));
  });
  ok('botões do rodapé não se sobrepõem entre si', semSobreposicaoRodape);
  await page.screenshot({ path: path.join(OUT, '07-drawer-rodape.png') });
  await page.keyboard.press('Escape');
  await page.locator('.ds-drawer').waitFor({ state: 'detached' });

  // ── 6. CTA → segmento → Nova campanha → Audiência ───────────────────────────────────────────────
  await page.locator('.segp').first().scrollIntoViewIfNeeded();
  await cta.tap();
  await page.waitForURL(/\/admin\/campanhas\/nova\?segmento=\d+/);
  const segId = new URL(page.url()).searchParams.get('segmento');
  ok('CTA levou a Nova campanha com o id do segmento salvo', /^\d+$/.test(segId), `segmento ${segId}`);
  const nomeCampo = page.locator('input[type="text"]').first();
  await nomeCampo.waitFor();
  await page.waitForFunction(() => document.querySelector('input[type="text"]')?.value.startsWith('RFM · '));
  ok('nome da campanha pré-preenchido com o segmento', (await nomeCampo.inputValue()).startsWith('RFM · Novos'));
  await page.getByRole('button', { name: 'Avançar' }).tap();
  await page.waitForSelector('[aria-label="Campo do filtro"]');
  await page.screenshot({ path: path.join(OUT, '08-audiencia.png'), fullPage: true });
  await semRolagemHorizontal('etapa Audiência');

  // Aviso do segmento RFM: regra, data da classificação, corte salvo e corte de hoje (pessoas dinâmicas, corte materializado).
  const aviso = await page.locator('.ds-callout', { hasText: 'Segmento RFM' }).first().innerText().catch(() => '');
  ok('Audiência exibe regra, data, corte salvo e corte de hoje do segmento RFM', /Regra rfm-v1:[0-9a-f]{8}/.test(aviso) && /classificado em/.test(aviso) && /corte salvo/.test(aviso) && /Hoje \(/.test(aviso) && /corte SALVO/.test(aviso), aviso.replace(/\s+/g, ' ').slice(0, 160));
  // O que a tela mostra × o que foi persistido × a prévia calculada pelo servidor.
  const tela = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Campo do filtro"]')].map((sel) => {
    const linha = sel.closest('div');
    const ctrls = [...linha.querySelectorAll('select, input')];
    return { campo: sel.value, op: linha.querySelector('[aria-label="Operador"]')?.value ?? null, valor: (linha.querySelector('input:not([type="checkbox"])') || linha.querySelector('[aria-label="Valor do filtro"]'))?.value ?? null, n: ctrls.length };
  }));
  const api = await ctx.request.get(`${BASE}/api/admin/segments`);
  const salvo = (await api.json()).segmentos.find((s) => s.id === segId);
  ok('segmento persistido é dinâmico, de origem RFM, com versão da regra e data de classificação', salvo && salvo.origem === 'rfm' && salvo.politica === 'dinamico' && /^rfm-v1:[0-9a-f]{8}$/.test(salvo.rfmVersao) && !!salvo.classificadoEm, salvo ? `${salvo.rfmVersao}` : 'não encontrado');
  ok('a Audiência mostra tantos filtros quantos o segmento persistiu', tela.length === salvo.filtros.length, `tela ${tela.length} × banco ${salvo.filtros.length}`);
  const iguais = salvo.filtros.every((f, i) => tela[i] && tela[i].campo === f.field && tela[i].op === f.op && Number(tela[i].valor) === Number(f.value));
  ok('campo, operador e valor de cada filtro na tela = filtro persistido', iguais, JSON.stringify(tela));
  const prevApi = await post('/api/admin/campaigns/audience/preview', { match: salvo.match, filters: salvo.filtros, exclusions: { semOptIn: true, numeroInvalido: true } });
  const esperado = await prevApi.json();
  await page.waitForFunction(() => /encontrados/.test(document.body.innerText));
  const texto = await page.evaluate(() => document.body.innerText.match(/(\d[\d.]*)\s+clientes? eleg[ií]veis?\s+—\s+(\d[\d.]*)\s+encontrados?,\s+(\d[\d.]*)\s+exclu[ií]dos?/i));
  const lido = texto ? texto.slice(1).map((x) => Number(x.replace(/\./g, ''))) : null;
  ok('contagem exibida na Audiência = prévia do servidor com os filtros persistidos', lido && lido[0] === esperado.eligible && lido[1] === esperado.matched && lido[2] === esperado.excluded, `tela ${JSON.stringify(lido)} × servidor ${esperado.eligible}/${esperado.matched}/${esperado.excluded}`);
  const { json: resumo } = { json: await (await ctx.request.get(`${BASE}/api/admin/clientes/resumo`)).json() };
  const seg = resumo.rfm.segmentos.find((s) => s.id === 'novos');
  ok('universo do segmento RFM ≤ audiência encontrada (diferença só pelas regras documentadas)', esperado.matched >= seg.clientes && esperado.matched - seg.clientes <= 3, `RFM ${seg.clientes} × audiência ${esperado.matched}`);
  // Nada foi disparado: continua sem campanha criada.
  const camps = await (await ctx.request.get(`${BASE}/api/admin/campaigns`)).json();
  ok('nenhuma campanha foi criada ou disparada', (camps.campanhas || camps.campaigns || []).length === 0);
  ok('sem erro de JavaScript na sessão', erros.length === 0, erros.slice(0, 2).join(' | '));
  // Respostas HTTP ≥ 400 são listadas (podem ser de outra área do painel, ex.: WhatsApp sem conexão), sem reprovar sozinhas.
  console.log(`INFO  respostas HTTP ≥ 400 durante o fluxo: ${respostasComErro.length ? [...new Set(respostasComErro)].join(', ') : 'nenhuma'}`);
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ viewport: `${W}x${H}`, geradoEm: new Date().toISOString(), resultados }, null, 2));
const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram · evidências em ${OUT}`);
process.exit(falhas.length ? 1 : 0);
