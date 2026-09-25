#!/usr/bin/env node
// QA visual da alternância "Lista | Visual" da Distribuição RFM (Playwright), sobre a fixture SINTÉTICA local. Só lê a tela de Clientes.
//
//   SMOKE_BASE_URL=http://localhost:PORTA SMOKE_PASSWORD=<senha-de-teste> PLAYWRIGHT_MODULE=/caminho/playwright-core \
//   AXE_CORE_PATH=/caminho/axe.min.js node scripts/clientes/qa-rfm-visual.mjs --out relatorios-privados/rfm-visual
//
// Viewports: 1440×900, 1280×800, 768×1024, 390×844, 549×900 e 320×640. Confere: Lista continua o padrão; Visual mostra os 11
// segmentos (8 blocos + 3 zeros só na legenda); nome completo na legenda; segmentos pequenos identificáveis e clicáveis (bloco e
// legenda); seleção COMPARTILHADA entre as visões; mesmo painel do segmento; Clientes × Receita nas duas; "Limpar seleção";
// áreas proporcionais aos números da API (com o piso declarado); sem rolagem horizontal; alvos ≥ 44 px no celular; teclado;
// contraste AA; axe; reduced-motion. Não clica em nada fora da distribuição.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:18085';
const SENHA = process.env.SMOKE_PASSWORD;
const AXE = process.env.AXE_CORE_PATH || null;
const OUT = path.resolve(arg('out', './relatorios-privados/rfm-visual'));
if (!SENHA) throw new Error('defina SMOKE_PASSWORD');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { nome: 'desktop-1440', w: 1440, h: 900 }, { nome: 'desktop-1280', w: 1280, h: 800 }, { nome: 'tablet-768', w: 768, h: 1024 },
  { nome: 'mobile-390', w: 390, h: 844 }, { nome: 'mobile-549', w: 549, h: 900 }, { nome: 'mobile-320', w: 320, h: 640 },
];
const PISO = 0.012;
const resultados = [];
let contexto = '';
const ok = (n, c, d = '') => { resultados.push({ contexto, nome: n, ok: !!c, detalhe: d }); console.log(`${c ? 'PASS' : 'FAIL'}  [${contexto}] ${n}${d ? ` — ${d}` : ''}`); };

const JS_CONTRASTE = () => {
  const parse = (c) => { const m = c.match(/^rgba?\(([^)]+)\)/); if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; } const q = c.match(/^color\(srgb ([^)]+)\)/); if (q) { const p = q[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; } return null; };
  const sobre = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const fundo = (el) => { const cam = []; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0) { cam.push(c); if (c[3] >= 1) break; } } let b = [11, 18, 26]; for (const c of cam.reverse()) b = sobre(c, b); return b; };
  const lum = (rgb) => { const f = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
  const alvos = ['.rfmv-bloco__nome', '.rfmv-bloco__valor', '.rfmv-bloco__pct', '.rfmv-chip__nome', '.rfmv-chip__sub', '.rfmv-chip__valor', '.rfmv-chip__valor strong', '.rfmv-nota', '.rfmx-grupo__titulo', '.rfmx-grupo__soma'];
  const ruins = []; let medidos = 0;
  for (const sel of alvos) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
      const cor = parse(getComputedStyle(el).color); if (!cor) continue;
      const bg = fundo(el); const fg = sobre(cor, bg); const L1 = lum(fg); const L2 = lum(bg);
      const razao = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const tam = parseFloat(getComputedStyle(el).fontSize); const peso = parseInt(getComputedStyle(el).fontWeight, 10);
      medidos += 1;
      if (razao < ((tam >= 24 || (tam >= 18.66 && peso >= 700)) ? 3 : 4.5)) ruins.push({ sel, razao: Math.round(razao * 100) / 100, texto: (el.innerText || '').slice(0, 24) });
    }
  }
  return { medidos, ruins };
};

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    contexto = vp.nome;
    const mobile = vp.w < 720;
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: mobile, hasTouch: mobile, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    const login = await ctx.request.post(`${BASE}/api/admin/login`, { data: { email: 'local@teste.oria', password: SENHA } });
    if (!login.ok()) throw new Error(`login falhou: ${login.status()}`);
    const page = await ctx.newPage();
    const erros = [];
    page.on('pageerror', (e) => erros.push(String(e)));
    let requisicoes = 0;
    page.on('request', (r) => { if (r.url().includes('/api/admin/clientes/')) requisicoes += 1; });
    const clicar = (loc) => (mobile ? loc.tap() : loc.click());
    // começa SEM preferência salva (uma vez só: o reload do fim do teste precisa lembrar a escolha)
    await page.addInitScript(() => { try { if (!window.sessionStorage.getItem('qa-visual-init')) { window.localStorage.removeItem('oria.clientes.rfm.visao'); window.sessionStorage.setItem('qa-visual-init', '1'); } } catch { /* */ } });
    const resumo = await (await ctx.request.get(`${BASE}/api/admin/clientes/resumo?dias=tudo`)).json();
    const seg = Object.fromEntries(resumo.rfm.segmentos.map((s) => [s.id, s]));
    const semRolagem = async (r) => { const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); ok(`sem rolagem horizontal (${r})`, m.sw <= m.cw + 1, `${m.sw}/${m.cw}`); };
    const botao = (nome) => page.locator('.rfmx-controles').getByRole('button', { name: nome, exact: true });
    const chip = (nome) => page.locator('.rfmv-chip', { has: page.locator('.rfmv-chip__nome', { hasText: new RegExp(`^${nome}$`) }) }).first();
    const linha = (nome) => page.locator('.rfmx-linha', { has: page.locator('.rfmx-nome', { hasText: new RegExp(`^${nome}$`) }) }).first();

    await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.rfmx-linha');

    // ── 1. padrão = Lista ───────────────────────────────────────────────────────────────────────────
    ok('a Lista continua o padrão (aria-pressed) e mostra as 11 linhas', (await botao('Lista').getAttribute('aria-pressed')) === 'true' && (await botao('Visual').getAttribute('aria-pressed')) === 'false' && (await page.locator('.rfmx-linha').count()) === 11 && (await page.locator('.rfmv').count()) === 0);
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-01-lista.png`), fullPage: true });

    // ── 2. Visual: 11 segmentos representados ───────────────────────────────────────────────────────
    await clicar(botao('Visual'));
    await page.waitForSelector('.rfmv-mapa .rfmv-bloco');
    await page.waitForTimeout(250);
    ok('Visual: sem linhas da Lista, com mapa e legenda', (await page.locator('.rfmx-linha').count()) === 0 && (await page.locator('.rfmv-legenda').count()) === 1);
    const blocos = await page.$$eval('.rfmv-bloco', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.getAttribute('data-segmento'), nivel: e.getAttribute('data-nivel'), w: r.width, h: r.height, titulo: e.getAttribute('title') }; }));
    const chips = await page.$$eval('.rfmv-chip', (els) => els.map((e) => { const n = e.querySelector('.rfmv-chip__nome'); const r = e.getBoundingClientRect(); return { nome: n.innerText.trim(), cortado: n.scrollWidth > n.clientWidth + 1, h: r.height, aria: e.getAttribute('aria-label'), pressed: e.getAttribute('aria-pressed'), l: r.left, r: r.right }; }));
    ok('legenda com os 11 segmentos, nome COMPLETO e sem truncar', chips.length === 11 && chips.every((c) => !c.cortado) && chips.some((c) => c.nome === 'Primeira compra de alto valor'), chips.filter((c) => c.cortado).map((c) => c.nome).join(', '));
    ok('8 blocos no mapa (segmentos com clientes); os 3 sem cliente ficam só na legenda, com "0 clientes"', blocos.length === 8 && chips.filter((c) => /: 0 clientes/.test(c.aria)).length === 3, `${blocos.length} blocos`);
    ok('cada segmento pequeno (1, 1, 3 e 6 clientes) tem bloco com tooltip com o nome e nível de rótulo declarado', ['primeira_alto_valor', 'em_risco', 'precisam_atencao', 'potenciais_leais'].every((id) => { const b = blocos.find((x) => x.id === id); return b && b.titulo && b.titulo.includes(seg[id].nome) && ['valor', 'marcador', 'nome', 'completo'].includes(b.nivel); }));
    const menor = blocos.reduce((m, b) => Math.min(m, b.w, b.h), Infinity);
    ok('o menor bloco é visível e clicável (≥ 14 px nos dois lados)', menor >= 14, `menor lado ${menor.toFixed(0)} px · níveis: ${blocos.map((b) => `${b.id}:${b.nivel}`).join(' ')}`);
    ok('legenda: links do teclado/toque com ≥ 44 px de altura', chips.every((c) => c.h >= 43.5), `mín ${Math.min(...chips.map((c) => c.h)).toFixed(0)} px`);
    ok('legenda dentro da viewport', chips.every((c) => c.l >= -0.5 && c.r <= vp.w + 0.5));
    ok('cada chip da legenda tem aria-label com nome, grupo, clientes, % da base e % da receita', chips.every((c) => /^.+, .+: \d[\d.]* clientes?, [\d,]+% da base, [\d,]+% da receita$/.test(c.aria)));
    // proporção: blocos ≥ piso têm área = % da base (±0,6 p.p.); os abaixo do piso ficam no piso
    const mapa = await page.locator('.rfmv-mapa').boundingBox();
    const total = blocos.reduce((a, b) => a + b.w * b.h, 0); // área dos blocos (o mapa tem 1 px de borda: comparar com a área interna)
    ok('os blocos preenchem o mapa inteiro (soma das áreas = área interna, ±2%)', Math.abs(total / ((mapa.width - 2) * (mapa.height - 2)) - 1) < 0.02, `${(total / ((mapa.width - 2) * (mapa.height - 2)) * 100).toFixed(1)}%`);
    // esperado = valor com o piso declarado, normalizado para o mapa inteiro (o piso rouba um pouco dos maiores)
    const comPiso = blocos.map((b) => ({ id: b.id, v: Math.max(seg[b.id].pctBase, PISO) }));
    const somaPiso = comPiso.reduce((a, x) => a + x.v, 0);
    const desvios = blocos.map((b) => { const share = (b.w * b.h) / total; const esperado = comPiso.find((x) => x.id === b.id).v / somaPiso; return { id: b.id, dif: Math.abs(share - esperado) }; });
    ok('áreas proporcionais aos números da API (com o piso de 1,2% declarado, normalizado); soma = mapa inteiro', desvios.every((d) => d.dif <= 0.004), desvios.filter((d) => d.dif > 0.004).map((d) => `${d.id}:${(d.dif * 100).toFixed(2)}pp`).join(', '));
    ok('o maior bloco (Hibernando 52%) continua dominante: ≥ 47% da área', (blocos.find((b) => b.id === 'hibernando').w * blocos.find((b) => b.id === 'hibernando').h) / total >= 0.47);
    ok('a nota declara o piso e que todos os segmentos estão na legenda', /área mínima/i.test(await page.locator('.rfmv-nota').innerText()) && /legenda/.test(await page.locator('.rfmv-nota').innerText()));
    await semRolagem('Visual, sem seleção');
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-02-visual.png`), fullPage: true });
    const c = await page.evaluate(JS_CONTRASTE);
    ok('contraste WCAG AA no Visual (blocos e legenda)', c.ruins.length === 0, `${c.medidos} textos; ${JSON.stringify(c.ruins.slice(0, 3))}`);

    // ── 3. clicar no BLOCO do menor segmento seleciona; legenda e painel acompanham ─────────────────
    const blocoEmRisco = page.locator('.rfmv-bloco[data-segmento="em_risco"]');
    await clicar(blocoEmRisco);
    await page.waitForSelector('.segp__titulo');
    await page.waitForTimeout(200);
    ok('clique/toque no bloco do menor segmento (Em risco) seleciona: legenda aria-pressed e painel do segmento', (await chip('Em risco').getAttribute('aria-pressed')) === 'true' && (await page.locator('.segp__titulo').first().innerText()) === 'Em risco');
    ok('o painel é o MESMO: critérios R/F/V, CTA e "Ver clientes"', (await page.locator('.segp-criterios li').count()) === 3 && (await page.getByRole('button', { name: 'Criar campanha com este segmento' }).count()) === 1 && (await page.getByRole('button', { name: 'Ver clientes' }).count()) === 1);
    ok('bloco selecionado destacado', (await page.locator('.rfmv-bloco[data-segmento="em_risco"].is-selecionado').count()) === 1);
    await semRolagem('Visual, com painel');
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-03-visual-selecionado.png`), fullPage: true });

    // ── 4. seleção compartilhada com a Lista ────────────────────────────────────────────────────────
    const req0 = requisicoes;
    await clicar(botao('Lista'));
    await page.waitForSelector('.rfmx-linha');
    ok('trocar para Lista mantém a seleção (Em risco marcado) e o painel', (await linha('Em risco').getAttribute('aria-pressed')) === 'true' && (await page.locator('.segp__titulo').first().innerText()) === 'Em risco');
    await clicar(botao('Visual'));
    await page.waitForSelector('.rfmv-mapa');
    await clicar(botao('Lista'));
    await page.waitForSelector('.rfmx-linha');
    ok('alternar Lista ↔ Visual (sem mudar a seleção) não pede nada ao servidor', requisicoes === req0, `+${requisicoes - req0} requisições`);
    await clicar(linha('Novos'));
    await page.waitForTimeout(300);
    await clicar(botao('Visual'));
    await page.waitForSelector('.rfmv-mapa');
    ok('seleção feita na Lista aparece no Visual (Em risco + Novos) — legenda e blocos', (await chip('Em risco').getAttribute('aria-pressed')) === 'true' && (await chip('Novos').getAttribute('aria-pressed')) === 'true' && (await page.locator('.rfmv-bloco.is-selecionado').count()) === 2);

    // ── 5. Clientes × Receita no Visual ─────────────────────────────────────────────────────────────
    const areasAntes = await page.$$eval('.rfmv-bloco', (els) => Object.fromEntries(els.map((e) => { const r = e.getBoundingClientRect(); return [e.getAttribute('data-segmento'), r.width * r.height]; })));
    const reqM = requisicoes;
    await clicar(botao('Receita'));
    await page.waitForTimeout(300);
    const areasDepois = await page.$$eval('.rfmv-bloco', (els) => Object.fromEntries(els.map((e) => { const r = e.getBoundingClientRect(); return [e.getAttribute('data-segmento'), r.width * r.height]; })));
    const totalR = Object.values(areasDepois).reduce((a, b) => a + b, 0);
    const maxRec = Math.max(...resumo.rfm.segmentos.map((s) => s.receita));
    ok('Receita no Visual: as áreas mudam e acompanham a receita da API (o maior segmento continua o maior)', JSON.stringify(Object.keys(areasAntes).sort()) === JSON.stringify(Object.keys(areasDepois).sort()) && areasDepois.hibernando === Math.max(...Object.values(areasDepois)) && Math.abs(areasDepois.hibernando / totalR - Math.max(seg.hibernando.pctReceita, PISO)) < 0.02 && Object.keys(areasAntes).some((k) => Math.abs(areasAntes[k] - areasDepois[k]) > 50), `hibernando ${(areasDepois.hibernando / totalR * 100).toFixed(1)}% (API ${(seg.hibernando.pctReceita * 100).toFixed(1)}%)`);
    ok('Receita: a legenda mostra valores em R$ e a seleção continua', /R\$/.test(await chip('Hibernando').innerText()) && (await chip('Em risco').getAttribute('aria-pressed')) === 'true');
    ok('alternar a métrica não pede nada ao servidor', requisicoes === reqM);
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-04-visual-receita.png`), fullPage: true });
    await clicar(botao('Lista'));
    await page.waitForSelector('.rfmx-linha');
    ok('Receita na Lista (a métrica é compartilhada): valores em R$', /R\$/.test(await linha('Hibernando').innerText()));
    await clicar(botao('Clientes'));
    await clicar(botao('Visual'));
    await page.waitForSelector('.rfmv-mapa');

    // ── 6. Limpar seleção ────────────────────────────────────────────────────────────────────────────
    await clicar(page.getByRole('button', { name: /^Limpar seleção/ }).first());
    await page.waitForTimeout(200);
    ok('"Limpar seleção" no Visual limpa legenda, blocos e painel', (await page.locator('.rfmv-chip[aria-pressed="true"]').count()) === 0 && (await page.locator('.rfmv-bloco.is-selecionado').count()) === 0 && !/^(Em risco|Novos)$/.test((await page.locator('.segp__titulo').first().innerText().catch(() => '')).trim()));

    // ── 7. teclado na legenda ───────────────────────────────────────────────────────────────────────
    if (!mobile) {
      await botao('Visual').focus();
      let achou = null;
      for (let i = 0; i < 30 && !achou; i += 1) { await page.keyboard.press('Tab'); achou = await page.evaluate(() => (document.activeElement?.classList.contains('rfmv-chip') ? document.activeElement.querySelector('.rfmv-chip__nome').innerText.trim() : null)); }
      ok('Tab chega à legenda (botões reais)', !!achou, achou || 'não chegou');
      const foco = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { estilo: s.outlineStyle, largura: parseFloat(s.outlineWidth) }; });
      ok('foco visível (contorno ≥ 2 px) na legenda', foco.estilo !== 'none' && foco.largura >= 2, JSON.stringify(foco));
      await page.keyboard.press('Enter');
      const a1 = await page.evaluate(() => document.activeElement.getAttribute('aria-pressed'));
      await page.keyboard.press('Space');
      const a2 = await page.evaluate(() => document.activeElement.getAttribute('aria-pressed'));
      ok('Enter seleciona e Espaço desmarca', a1 === 'true' && a2 === 'false', `${a1} → ${a2}`);
    }

    // ── 8. preferência lembrada e volta ao padrão ────────────────────────────────────────────────────
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.rfmv-mapa, .rfmx-linha');
    ok('a visão escolhida (Visual) é lembrada ao recarregar', (await page.locator('.rfmv-mapa').count()) === 1);
    if (AXE) {
      await page.addScriptTag({ path: AXE });
      const viol = await page.evaluate(async () => (await window.axe.run(document.querySelector('#ad-content') || document.body)).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length})`));
      ok('axe-core: nenhuma violação serious/critical (Visual)', viol.length === 0, viol.join(', '));
    }
    ok('sem erro de JavaScript', erros.length === 0, erros.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ── reduced-motion ────────────────────────────────────────────────────────────────────────────────
  contexto = 'reduced-motion';
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', locale: 'pt-BR' });
    await ctx.request.post(`${BASE}/api/admin/login`, { data: { email: 'local@teste.oria', password: SENHA } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { window.localStorage.setItem('oria.clientes.rfm.visao', 'visual'); } catch { /* */ } });
    await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.rfmv-bloco');
    const t = await page.evaluate(() => getComputedStyle(document.querySelector('.rfmv-bloco__interno')).transitionDuration);
    ok('prefers-reduced-motion zera a transição dos blocos', t.split(',').every((d) => parseFloat(d) < 0.001), t);
    await ctx.close();
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ geradoEm: new Date().toISOString(), base: BASE, dadosSinteticos: true, resultados }, null, 2));
const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram · evidências em ${OUT}`);
process.exit(falhas.length ? 1 : 0);
