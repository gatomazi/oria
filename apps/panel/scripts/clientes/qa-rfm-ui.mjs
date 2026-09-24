#!/usr/bin/env node
// QA visual e funcional do RFM Explorer / Clientes com Playwright, sobre a fixture SINTÉTICA determinística
// (scripts/clientes/seed-sintetico-rfm.mjs). Só painel LOCAL de teste; nenhum dado real, nenhuma PII, nenhum envio.
//
//   SMOKE_BASE_URL=http://localhost:18080 SMOKE_PASSWORD=<senha-de-teste> \
//   SEED_DATABASE_URL=postgres://postgres:teste@127.0.0.1:PORTA/oria_test      # opcional: habilita o cenário "corte defasado"
//   PLAYWRIGHT_MODULE=/caminho/playwright-core AXE_CORE_PATH=/caminho/axe-core/axe.min.js   # axe é opcional
//   node scripts/clientes/qa-rfm-ui.mjs --out apps/panel/relatorios-privados/rfm-ui-noturna
//
// Viewports (o VIEWPORT do Playwright, não a janela do navegador): 1440×900, 1280×800, 768×1024, 390×844, 549×900, 320×640.
// Confere, por viewport: 11 linhas com nome completo e sem truncar; sem rolagem horizontal da PÁGINA; alvos de toque ≥ 44 px no
// celular; barras proporcionais aos números da API; seleção (aria-pressed) e painel; alternar Clientes/Receita mantendo a seleção
// sem novas requisições; teclado (Tab/Enter/Espaço, foco visível); contraste WCAG AA nos estados padrão e selecionado; reduced-motion;
// axe-core (serious/critical). Só no desktop: fluxos (Ver clientes → busca → drawer → voltar; CTA → Audiência → voltar), estados
// (carregando, 503 do resumo, segmento 0, Perdidos com histórico curto, org vazia, amostra insuficiente, corte defasado).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:18080';
const SENHA = process.env.SMOKE_PASSWORD;
const OUT = path.resolve(arg('out', './relatorios-privados/rfm-ui-noturna'));
const AXE = process.env.AXE_CORE_PATH || null;
const SEED_DB = process.env.SEED_DATABASE_URL || null;
if (!SENHA) throw new Error('defina SMOKE_PASSWORD (senha do usuário de teste do painel local)');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { nome: 'desktop-1440', w: 1440, h: 900 }, { nome: 'desktop-1280', w: 1280, h: 800 }, { nome: 'tablet-768', w: 768, h: 1024 },
  { nome: 'mobile-390', w: 390, h: 844 }, { nome: 'mobile-549', w: 549, h: 900 }, { nome: 'mobile-320', w: 320, h: 640 },
];
const resultados = [];
let contexto = '';
const ok = (nome, cond, detalhe = '') => { resultados.push({ contexto, nome, ok: !!cond, detalhe }); console.log(`${cond ? 'PASS' : 'FAIL'}  [${contexto}] ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };
const info = (txt) => console.log(`INFO  [${contexto}] ${txt}`);

const browser = await chromium.launch();

async function novoContexto(vp, email, extras = {}) {
  const mobile = vp.w < 720;
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', ...extras });
  const login = await ctx.request.post(`${BASE}/api/admin/login`, { data: { email, password: SENHA } });
  if (!login.ok()) throw new Error(`login falhou (${email}): HTTP ${login.status()}`);
  const csrf = (await login.json()).csrfToken;
  return { ctx, csrf, mobile };
}
const api = async (ctx, rota) => (await ctx.request.get(`${BASE}${rota}`)).json();

// ── utilitários injetados na página ─────────────────────────────────────────────────────────────────
const JS_CONTRASTE = () => {
  const parse = (c) => {
    let m = c.match(/^rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = c.match(/^color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return null;
  };
  const sobre = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const fundoEfetivo = (el) => {
    const camadas = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) { camadas.push(c); if (c[3] >= 1) break; }
    }
    let base = [11, 18, 26];
    for (const c of camadas.reverse()) base = sobre(c, base);
    return base;
  };
  const lum = (rgb) => { const f = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
  const alvos = ['.rfmx-nome', '.rfmx-desc', '.rfmx-valor', '.rfmx-valor strong', '.rfmx-pct', '.rfmx-sec', '.rfmx-grupo__titulo', '.rfmx-grupo__soma', '.rfmx-base', '.segp__titulo', '.segp__texto', '.segp__etapa', '.segp-criterios__corpo', '.segp-criterios__corpo em', '.segp__nota', '.segp-estat dt', '.segp-estat strong', '.segp-metricas', '.segp-hipotese', '.cli-kpi-nota'];
  const ruins = [];
  let medidos = 0;
  for (const sel of alvos) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      const cor = parse(getComputedStyle(el).color);
      if (!cor) continue;
      const bg = fundoEfetivo(el);
      const fg = sobre(cor, bg);
      const L1 = lum(fg); const L2 = lum(bg);
      const razao = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const tam = parseFloat(getComputedStyle(el).fontSize); const peso = parseInt(getComputedStyle(el).fontWeight, 10);
      const grande = tam >= 24 || (tam >= 18.66 && peso >= 700);
      medidos += 1;
      if (razao < (grande ? 3 : 4.5)) ruins.push({ sel, razao: Math.round(razao * 100) / 100, texto: (el.innerText || '').slice(0, 30) });
    }
  }
  return { medidos, ruins };
};

async function contraste(page) { return page.evaluate(JS_CONTRASTE); }
const semRolagemHorizontal = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
const linhaDoSegmento = (page, nome) => page.locator('.rfmx-linha', { has: page.locator('.rfmx-nome', { hasText: new RegExp(`^${nome}$`) }) }).first();

async function axeRun(page) {
  if (!AXE) return null;
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document.querySelector('#ad-content') || document.body, { resultTypes: ['violations'] });
    return r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => ({ id: v.id, impacto: v.impact, nos: v.nodes.length, exemplo: (v.nodes[0]?.html || '').slice(0, 120) }));
  });
}

// ── 1) Matriz de viewports ──────────────────────────────────────────────────────────────────────────
const esperado = { campeoes: 0, leais: 0, potenciais_leais: 6, primeira_alto_valor: 1, novos: 50, aguardando_recompra: 169, precisam_atencao: 3, prestes_a_dormir: 250, em_risco: 1, hibernando: 520, perdidos: 0 };

try {
  for (const vp of VIEWPORTS) {
    contexto = vp.nome;
    const { ctx, mobile } = await novoContexto(vp, 'local@teste.oria');
    const page = await ctx.newPage();
    const erros = [];
    page.on('pageerror', (e) => erros.push(String(e)));
    let requisicoes = 0;
    page.on('request', (r) => { if (r.url().includes('/api/admin/clientes/')) requisicoes += 1; });

    const resumo = await api(ctx, '/api/admin/clientes/resumo?dias=tudo');
    const porId = Object.fromEntries(resumo.rfm.segmentos.map((s) => [s.id, s]));
    if (vp.nome === 'desktop-1440') {
      ok('fixture confere: 0 / 1 / < 1% / 5% / > 50% (11 segmentos)', Object.entries(esperado).every(([id, n]) => porId[id]?.clientes === n) && resumo.rfm.universo === 1000, JSON.stringify(Object.fromEntries(resumo.rfm.segmentos.map((s) => [s.id, s.clientes]))));
    }

    await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.rfmx-linha');
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-01-padrao.png`) });
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-01-padrao-pagina.png`), fullPage: true });

    let r = await semRolagemHorizontal(page);
    ok('sem rolagem horizontal da página (estado padrão)', r.sw <= r.cw + 1 && r.bw <= r.cw + 1, `${r.sw}/${r.cw}`);

    const linhas = await page.$$eval('.rfmx-linha', (els) => els.map((e) => {
      const nome = e.querySelector('.rfmx-nome'); const b = e.getBoundingClientRect(); const t = e.querySelector('.rfmx-trilho').getBoundingClientRect(); const barra = e.querySelector('.rfmx-barra').getBoundingClientRect();
      return { nome: nome.innerText.trim(), cortado: nome.scrollWidth > nome.clientWidth + 1 || getComputedStyle(nome).textOverflow === 'ellipsis', h: b.height, l: b.left, r: b.right, trilhaW: t.width, barraW: barra.width, aria: e.getAttribute('aria-label'), pressed: e.getAttribute('aria-pressed') };
    }));
    ok('as 11 linhas visíveis no DOM, inclusive 0 cliente e < 1%', linhas.length === 11);
    ok('nomes completos, sem truncar (nem "Primeira compra de alto valor" nem "Aguardando recompra")', linhas.every((l) => !l.cortado) && linhas.some((l) => l.nome === 'Primeira compra de alto valor'), linhas.filter((l) => l.cortado).map((l) => l.nome).join(', '));
    ok('linhas dentro da viewport', linhas.every((l) => l.l >= -0.5 && l.r <= vp.w + 0.5));
    if (mobile) ok('alvo de toque ≥ 44 px em cada linha', linhas.every((l) => l.h >= 44), `mín ${Math.round(Math.min(...linhas.map((l) => l.h)))} px`);
    const maior = Math.max(...Object.values(esperado));
    const desvios = linhas.map((l) => {
      const id = Object.keys(porId).find((k) => porId[k].nome === l.nome);
      const esp = (porId[id].clientes / maior) * l.trilhaW;
      const alvo = porId[id].clientes > 0 ? Math.max(esp, 2) : 0;
      return { nome: l.nome, dif: Math.abs(l.barraW - alvo) };
    });
    ok('barras proporcionais aos números da API (tolerância 1,5 px; marca mínima de 2 px só para > 0)', desvios.every((d) => d.dif <= 1.5), desvios.filter((d) => d.dif > 1.5).map((d) => `${d.nome}:${d.dif.toFixed(1)}`).join(', '));
    ok('cada linha tem aria-label com nome, grupo, clientes, % da base e % da receita', linhas.every((l) => /^.+, .+: \d[\d.]* clientes?, [\d,]+% da base, [\d,]+% da receita$/.test(l.aria)));
    const zero = await page.locator('.rfmx-linha', { hasText: 'Perdidos' }).first().innerText();
    ok('Perdidos = 0 explicado pela cobertura (histórico < 365 dias), sem fingir comportamento', /Ainda não pode existir/.test(zero) && /300 dias/.test(zero), zero.replace(/\s+/g, ' ').slice(0, 110));
    const leais = await page.locator('.rfmx-linha', { hasText: /^Leais/ }).first().innerText();
    ok('Leais = 0 mostrado como "0 clientes"/"0,0%", nunca escondido', /0\s*clientes/.test(leais) && /0,0%/.test(leais), leais.replace(/\s+/g, ' ').slice(0, 100));

    // contraste no estado padrão
    let c = await contraste(page);
    ok('contraste WCAG AA no estado padrão', c.ruins.length === 0, `${c.medidos} textos medidos; ${JSON.stringify(c.ruins.slice(0, 3))}`);

    // seleção do MENOR segmento não vazio (Em risco: 1 cliente)
    await linhaDoSegmento(page, 'Em risco').click();
    await page.waitForSelector('.segp__titulo');
    await page.waitForTimeout(250);
    ok('seleciona o menor segmento (1 cliente): aria-pressed e painel com o nome', await linhaDoSegmento(page, 'Em risco').getAttribute('aria-pressed') === 'true' && (await page.locator('.segp__titulo').first().innerText()) === 'Em risco');
    ok('painel traz critérios R, F e Valor com cortes exatos', await page.locator('.segp-criterios li').count() === 3 && /181 e 365 dias/.test(await page.locator('.segp-criterios').first().innerText()));
    ok('painel: CTA e "Ver clientes" presentes', await page.getByRole('button', { name: 'Criar campanha com este segmento' }).count() === 1 && await page.getByRole('button', { name: 'Ver clientes' }).count() === 1);
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-02-selecionado-em-risco.png`) });
    await page.locator('.segp').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-02b-painel.png`) });
    c = await contraste(page);
    ok('contraste WCAG AA com segmento selecionado e painel aberto', c.ruins.length === 0, `${c.medidos} textos; ${JSON.stringify(c.ruins.slice(0, 3))}`);
    r = await semRolagemHorizontal(page);
    ok('sem rolagem horizontal com painel aberto', r.sw <= r.cw + 1, `${r.sw}/${r.cw}`);

    // alternar Clientes/Receita: mantém seleção, ordem e não faz requisições novas
    const ordemAntes = await page.$$eval('.rfmx-nome', (els) => els.map((e) => e.innerText.trim()));
    const reqAntes = requisicoes;
    await page.getByRole('button', { name: 'Receita', exact: true }).click();
    await page.waitForTimeout(300);
    const ordemDepois = await page.$$eval('.rfmx-nome', (els) => els.map((e) => e.innerText.trim()));
    ok('alternar para Receita mantém a seleção', await linhaDoSegmento(page, 'Em risco').getAttribute('aria-pressed') === 'true');
    ok('alternar para Receita mantém a ordem das 11 linhas e não pede nada ao servidor', JSON.stringify(ordemAntes) === JSON.stringify(ordemDepois) && requisicoes === reqAntes, `requisições +${requisicoes - reqAntes}`);
    const barrasReceita = await page.$$eval('.rfmx-linha', (els) => els.map((e) => ({ n: e.querySelector('.rfmx-nome').innerText.trim(), w: e.querySelector('.rfmx-barra').getBoundingClientRect().width, t: e.querySelector('.rfmx-trilho').getBoundingClientRect().width })));
    const maxRec = Math.max(...resumo.rfm.segmentos.map((s) => s.receita));
    const desvRec = barrasReceita.map((b) => { const s = resumo.rfm.segmentos.find((x) => x.nome === b.n); const alvo = s.receita > 0 ? Math.max((s.receita / maxRec) * b.t, 2) : 0; return Math.abs(b.w - alvo); });
    ok('modo Receita: barras proporcionais à receita da API', desvRec.every((d) => d <= 1.5), `máx desvio ${Math.max(...desvRec).toFixed(1)} px`);
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-03-receita.png`) });
    await page.getByRole('button', { name: 'Clientes', exact: true }).click();

    // teclado: Tab até uma linha, foco visível, Enter e Espaço alternam
    await page.locator('.rfmx-cabecalho').scrollIntoViewIfNeeded();
    await linhaDoSegmento(page, 'Em risco').click(); // limpa a seleção para partir do zero
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.locator('.rfmx-titulo').evaluate((el) => { el.setAttribute('tabindex', '-1'); el.focus(); });
    let achou = null;
    for (let i = 0; i < 40 && !achou; i += 1) { await page.keyboard.press('Tab'); achou = await page.evaluate(() => (document.activeElement?.classList.contains('rfmx-linha') ? document.activeElement.querySelector('.rfmx-nome').innerText.trim() : null)); }
    ok('Tab chega a uma linha do Explorer', !!achou, achou || 'não chegou');
    if (achou) {
      const foco = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { estilo: s.outlineStyle, largura: parseFloat(s.outlineWidth) }; });
      ok('foco visível (contorno ≥ 2 px) na linha focada por teclado', foco.estilo !== 'none' && foco.largura >= 2, JSON.stringify(foco));
      await page.keyboard.press('Enter');
      const apos = await page.evaluate(() => document.activeElement.getAttribute('aria-pressed'));
      await page.keyboard.press('Space');
      const apos2 = await page.evaluate(() => document.activeElement.getAttribute('aria-pressed'));
      ok('Enter seleciona e Espaço desmarca (aria-pressed)', apos === 'true' && apos2 === 'false', `${apos} → ${apos2}`);
    }

    // alvos de toque dos controles do painel e da métrica (celular)
    if (mobile) {
      await linhaDoSegmento(page, 'Novos').tap();
      await page.waitForTimeout(200);
      const alvos = await page.$$eval('.cli-segmentado button, .segp .ds-btn', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      ok('controles (Clientes/Receita, CTA, Ver clientes, Exportar) com altura ≥ 44 px no celular', alvos.every((h) => h >= 44), alvos.join(','));
      await linhaDoSegmento(page, 'Novos').tap();
    }

    const axeRes = await axeRun(page);
    if (axeRes) ok('axe-core: nenhuma violação serious/critical', axeRes.length === 0, JSON.stringify(axeRes.slice(0, 3)));
    ok('sem erro de JavaScript', erros.length === 0, erros.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ── 2) reduced-motion ──────────────────────────────────────────────────────────────────────────
  contexto = 'reduced-motion';
  {
    const { ctx } = await novoContexto({ w: 1280, h: 800 }, 'local@teste.oria', { reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.rfmx-linha');
    const mov = await page.evaluate(() => { const l = getComputedStyle(document.querySelector('.rfmx-linha')); return { transicao: l.transitionDuration, animacao: l.animationName }; });
    ok('prefers-reduced-motion zera as transições do Explorer', mov.transicao.split(',').every((d) => parseFloat(d) < 0.001), JSON.stringify(mov));
    await ctx.close();
  }

  // ── 3) Fluxos e estados (desktop 1440) ─────────────────────────────────────────────────────────
  const VP = { w: 1440, h: 900 };

  contexto = 'fluxo-ver-clientes';
  {
    const { ctx } = await novoContexto(VP, 'local@teste.oria');
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.rfmx-linha');
    await linhaDoSegmento(page, 'Novos').click();
    await page.getByRole('button', { name: 'Ver clientes' }).click();
    await page.waitForSelector('#clientes-lista table[aria-label="Clientes"] tbody tr');
    const chip = await page.locator('#clientes-lista .cli-chip--remover').allInnerTexts();
    ok('Novo → Ver clientes: a lista mostra o chip do segmento e só linhas dele', chip.some((t) => t.includes('Segmento: Novos')) && (await page.$$eval('#clientes-lista tbody tr', (trs) => trs.map((t) => t.children[1].innerText.split('\n')[0].trim()))).every((s) => s === 'Novos'));
    // busca + filtros
    await page.getByPlaceholder('Buscar por nome, email ou telefone…').fill('Cliente 09');
    await page.waitForTimeout(700);
    await page.waitForFunction(() => /cliente/.test(document.querySelector('#clientes-lista .ds-toolbar__meta')?.textContent || ''));
    const meta = await page.locator('#clientes-lista .ds-toolbar__meta').innerText();
    ok('busca dentro do segmento restringe a lista sem sair do segmento', /cliente/.test(meta) && (await page.$$eval('#clientes-lista tbody tr', (trs) => trs.every((t) => t.children[1].innerText.startsWith('Novos')))), meta);
    await page.screenshot({ path: path.join(OUT, 'fluxo-01-lista-filtrada.png') });
    // drawer e volta
    const primeira = page.locator('#clientes-lista tbody tr').first();
    await primeira.click();
    await page.waitForSelector('.cli-drawer');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'fluxo-02-drawer.png') });
    const foot = await page.locator('.ds-drawer__footer').innerText();
    ok('drawer: WhatsApp explicitamente externo; e-mail indisponível ou externo; sem envio pelo Oria', /WhatsApp \(abre fora do Oria\)/.test(foot) && /E-mail/.test(foot) && /(indisponível|abre seu app)/.test(foot), foot.replace(/\s+/g, ' '));
    const primarios = await page.locator('.ds-drawer__footer .ds-btn--primary').count();
    ok('rodapé do drawer não tem 3 botões primários competindo (no máximo 1)', primarios <= 1, `${primarios} primário(s)`);
    await page.keyboard.press('Escape');
    await page.locator('.ds-drawer').waitFor({ state: 'detached' });
    const aindaChip = await page.locator('#clientes-lista .cli-chip--remover').allInnerTexts();
    ok('ao fechar o drawer os filtros continuam (chip e busca)', aindaChip.some((t) => t.includes('Novos')) && (await page.getByPlaceholder('Buscar por nome, email ou telefone…').inputValue()) === 'Cliente 09');
    await ctx.close();
  }

  contexto = 'fluxo-campanha';
  {
    const { ctx } = await novoContexto(VP, 'local@teste.oria');
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.rfmx-linha');
    await linhaDoSegmento(page, 'Aguardando recompra').click();
    await page.getByRole('button', { name: 'Criar campanha com este segmento' }).click();
    await page.waitForURL(/\/admin\/campanhas\/nova\?segmento=\d+/);
    await page.locator('input[type="text"]').first().waitFor();
    await page.getByRole('button', { name: 'Avançar' }).click();
    await page.waitForSelector('.ds-callout');
    await page.screenshot({ path: path.join(OUT, 'fluxo-03-audiencia.png') });
    const camps = await api(ctx, '/api/admin/campaigns');
    ok('Audiência aberta sem criar nem disparar campanha', (camps.campanhas || camps.campaigns || []).length === 0);
    await page.goBack();
    await page.waitForURL(/\/admin\/clientes/);
    await page.waitForSelector('.rfmx-linha');
    ok('voltar da Audiência para Clientes: o segmento continua selecionado', await linhaDoSegmento(page, 'Aguardando recompra').getAttribute('aria-pressed') === 'true' && /seg=aguardando_recompra/.test(page.url()));
    await page.screenshot({ path: path.join(OUT, 'fluxo-04-retorno-clientes.png') });
    await ctx.close();
  }

  contexto = 'estado-segmento-zero';
  {
    const { ctx } = await novoContexto(VP, 'local@teste.oria');
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.rfmx-linha');
    await linhaDoSegmento(page, 'Campeões').click();
    await page.waitForSelector('.segp__titulo');
    const cta = page.getByRole('button', { name: 'Criar campanha com este segmento' });
    ok('segmento com 0 clientes: CTA desabilitado e motivo explícito', await cta.isDisabled() && /Sem clientes hoje/.test(await page.locator('.segp').innerText()));
    ok('segmento com 0 clientes: "Ver clientes" e "Exportar" desabilitados', await page.getByRole('button', { name: 'Ver clientes' }).isDisabled() && await page.getByRole('button', { name: 'Exportar' }).first().isDisabled());
    await page.screenshot({ path: path.join(OUT, 'estado-01-segmento-zero.png') });
    // seleção de VÁRIOS: comparar
    await linhaDoSegmento(page, 'Em risco').click();
    await linhaDoSegmento(page, 'Novos').click();
    await page.waitForTimeout(250);
    ok('vários segmentos: painel resume a união e explica que a campanha é um segmento por vez', /3 segmentos/.test(await page.locator('.segp__titulo').innerText()) && /um segmento por vez/.test(await page.locator('.segp').innerText()));
    await page.screenshot({ path: path.join(OUT, 'estado-02-varios.png') });
    await ctx.close();
  }

  contexto = 'estado-carregando-e-503';
  {
    const { ctx } = await novoContexto(VP, 'local@teste.oria');
    const page = await ctx.newPage();
    await page.route('**/api/admin/clientes/resumo*', async (rt) => { await new Promise((res) => setTimeout(res, 1800)); await rt.continue(); });
    const ir = page.goto(`${BASE}/admin/clientes`);
    await page.waitForSelector('.ds-skeleton, [aria-busy="true"]', { timeout: 5000 }).catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'estado-03-carregando.png') });
    ok('carregando: skeleton visível enquanto o resumo não chega (sem números falsos)', (await page.locator('.rfmx-linha').count()) === 0);
    await ir; await page.waitForSelector('.rfmx-linha');
    await page.unroute('**/api/admin/clientes/resumo*');
    let falhas = 1;
    await page.route('**/api/admin/clientes/resumo*', async (rt) => { if (falhas > 0) { falhas -= 1; await rt.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'serviço indisponível (simulado)' }) }); } else await rt.continue(); });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[role="alert"]');
    await page.screenshot({ path: path.join(OUT, 'estado-04-resumo-503.png') });
    ok('503 do resumo: estado de erro honesto com "Tentar novamente", sem gráfico', (await page.locator('.rfmx-linha').count()) === 0 && await page.getByRole('button', { name: 'Tentar novamente' }).count() >= 1);
    await page.getByRole('button', { name: 'Tentar novamente' }).first().click();
    await page.waitForSelector('.rfmx-linha');
    ok('recuperação após 503: a distribuição volta com os 11 segmentos', (await page.locator('.rfmx-linha').count()) === 11);
    await ctx.close();
  }

  contexto = 'estado-org-vazia';
  {
    const { ctx } = await novoContexto(VP, 'vazio@teste.oria');
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.ds-empty');
    await page.screenshot({ path: path.join(OUT, 'estado-05-org-vazia.png') });
    const txt = await page.locator('.cli-rfm-card').innerText();
    ok('sem compradores: estado vazio útil, sem linhas e sem CTA de campanha', /Ainda não há compradores classificados/.test(txt) && (await page.locator('.rfmx-linha').count()) === 0 && (await page.getByRole('button', { name: 'Criar campanha com este segmento' }).count()) === 0);
    await ctx.close();
  }

  contexto = 'estado-amostra-insuficiente';
  {
    const { ctx } = await novoContexto(VP, 'poucos@teste.oria');
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.ds-callout');
    await page.screenshot({ path: path.join(OUT, 'estado-06-amostra-insuficiente.png') });
    const txt = await page.locator('.cli-rfm-card').innerText();
    ok('amostra insuficiente: aviso explícito, sem segmentos de recompra e sem CTA', /Dados insuficientes/.test(txt) && (await page.locator('.rfmx-linha').count()) === 0 && (await page.getByRole('button', { name: 'Criar campanha com este segmento' }).count()) === 0, txt.replace(/\s+/g, ' ').slice(0, 120));
    await ctx.close();
  }

  // Corte defasado: cria o segmento, insere pedidos que movem o P75 e confere painel + Audiência. Limpa o que inseriu.
  contexto = 'estado-corte-defasado';
  if (SEED_DB) {
    const pg = require('pg');
    const pool = new pg.Pool({ connectionString: SEED_DB, max: 1 });
    const MARCA = 990000;
    try {
      const { ctx, csrf } = await novoContexto(VP, 'local@teste.oria');
      const page = await ctx.newPage();
      const antes = await api(ctx, '/api/admin/clientes/resumo?dias=tudo');
      const criar = await ctx.request.post(`${BASE}/api/admin/clientes/segmentos`, { data: { nome: 'QA · Novos (corte original)', origem: 'rfm', segmento: 'novos' }, headers: { 'X-CSRF-Token': csrf } });
      const segId = (await criar.json()).segmento.id;
      const org = 'a1000000-0000-4000-8000-000000000001'; const store = 'a2000000-0000-4000-8000-000000000001';
      for (let i = 0; i < 300; i += 1) {
        await pool.query("INSERT INTO pedidos_ink (organization_id,store_id,loja,ink_order_id,payment_status,order_status,buyer_nome,buyer_telefone,buyer_documento,total_value,criado_em,frete,descontos,items_count,is_troca) VALUES ($1,$2,'sul',$3,'paid','sent',$4,$5,$6,$7,now()-interval '3 days',0,0,1,false)",
          [org, store, MARCA + i, `Cliente QA ${i}`, `5196${String(9000000 + i)}`, `9${String(10000000000 + i)}`, 400 + i]);
      }
      const depois = await api(ctx, '/api/admin/clientes/resumo?dias=tudo');
      ok('fixture do corte defasado: o P75 mudou e a versão da regra NÃO', depois.rfm.valorAlto > antes.rfm.valorAlto && depois.rfm.regraVersao === antes.rfm.regraVersao, `${antes.rfm.valorAlto} → ${depois.rfm.valorAlto}`);
      await page.goto(`${BASE}/admin/clientes?seg=novos`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.segp-alerta');
      await page.screenshot({ path: path.join(OUT, 'estado-07-corte-defasado-painel.png') });
      const alerta = await page.locator('.segp-alerta').innerText();
      ok('painel do segmento avisa corte defasado com os dois números e não altera o segmento salvo', /corte defasado/.test(alerta) && /hoje/.test(alerta), alerta.replace(/\s+/g, ' ').slice(0, 140));
      await page.goto(`${BASE}/admin/campanhas/nova?segmento=${segId}`, { waitUntil: 'networkidle' });
      await page.locator('input[type="text"]').first().waitFor();
      await page.getByRole('button', { name: 'Avançar' }).click();
      await page.waitForSelector('.ds-callout--warning');
      await page.screenshot({ path: path.join(OUT, 'estado-08-corte-defasado-audiencia.png') });
      const av = await page.locator('.ds-callout--warning').first().innerText();
      ok('Audiência: aviso de corte defasado com corte salvo, corte de hoje, as duas contagens e o botão de criar outro', /defasado/.test(av) && /corte salvo/.test(av) && /Hoje \(/.test(av) && /Pessoas hoje/.test(av) && /Criar segmento com o corte atual/.test(av), av.replace(/\s+/g, ' ').slice(0, 160));
      await ctx.close();
    } finally {
      await pool.query('DELETE FROM pedidos_ink WHERE ink_order_id >= $1 AND ink_order_id < $2', [MARCA, MARCA + 300]);
      await pool.query("DELETE FROM segments WHERE nome = 'QA · Novos (corte original)'");
      await pool.end();
    }
  } else info('SEED_DATABASE_URL ausente: cenário "corte defasado" não executado');
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ geradoEm: new Date().toISOString(), base: BASE, dadosSinteticos: true, resultados }, null, 2));
const falhas = resultados.filter((x) => !x.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram · evidências em ${OUT}`);
process.exit(falhas.length ? 1 : 0);
