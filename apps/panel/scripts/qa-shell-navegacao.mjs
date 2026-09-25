#!/usr/bin/env node
// QA do cabeçalho e da sidebar compactável em VIEWPORT REAL (Playwright, sem iframe), sobre a fixture SINTÉTICA local. Não grava
// nada além de preferências locais do navegador (localStorage). Nenhum token real; nenhuma conta real.
//
//   SMOKE_BASE_URL=http://localhost:PORTA SMOKE_PASSWORD=<senha-de-teste> SEED_DATABASE_URL=postgres://postgres:…@127.0.0.1:PORTA/oria_test \
//   PLAYWRIGHT_MODULE=/caminho/playwright-core AXE_CORE_PATH=/caminho/axe.min.js node scripts/qa-shell-navegacao.mjs --out relatorios-privados/redesign-shell
//
// Viewports: 1440×900, 1280×800, 1024×768 (desktop), 768×1024 (drawer), 390×844 e 360×800 (mobile real).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const pg = require(require.resolve('pg', { paths: [process.cwd()] }));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:18085';
const SENHA = process.env.SMOKE_PASSWORD;
const AXE = process.env.AXE_CORE_PATH || null;
const DB = process.env.SEED_DATABASE_URL;
const OUT = path.resolve(arg('out', './relatorios-privados/redesign-shell'));
if (!SENHA || !DB) throw new Error('defina SMOKE_PASSWORD e SEED_DATABASE_URL (banco local de teste)');
if (!['127.0.0.1', 'localhost'].includes(new URL(DB).hostname)) throw new Error('recusado: banco não-local');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { nome: 'desktop-1440', w: 1440, h: 900 }, { nome: 'desktop-1280', w: 1280, h: 800 }, { nome: 'desktop-1024', w: 1024, h: 768 },
  { nome: 'tablet-768', w: 768, h: 1024 }, { nome: 'mobile-390', w: 390, h: 844 }, { nome: 'mobile-360', w: 360, h: 800 },
];
const CHAVE = 'oria.shell.nav.v1';
const resultados = [];
let contexto = '';
const ok = (n, c, d = '') => { resultados.push({ contexto, nome: n, ok: !!c, detalhe: d }); console.log(`${c ? 'PASS' : 'FAIL'}  [${contexto}] ${n}${d ? ` — ${d}` : ''}`); };

// O usuário de teste ganha um 2º vínculo (Org 2) para o seletor de loja aparecer; removido no fim.
const pool = new pg.Pool({ connectionString: DB, max: 1 });
const ORG2 = 'a1000000-0000-4000-8000-000000000002';
const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'local@teste.oria'");
await pool.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [ORG2, u.id]);

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    contexto = vp.nome;
    const desktop = vp.w >= 1024;
    const mobile = vp.w < 720;
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: mobile, hasTouch: mobile, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    const login = await ctx.request.post(`${BASE}/api/admin/login`, { data: { email: 'local@teste.oria', password: SENHA } });
    if (!login.ok()) throw new Error(`login falhou: ${login.status()}`);
    // com 2 lojas o servidor exige escolher a Organization da sessão (o painel mostra "Suas lojas"): escolhe a Org 1 pela API
    const csrf = (await login.json()).csrfToken;
    const escolha = await ctx.request.post(`${BASE}/api/admin/session/organization`, { data: { organizationId: 'a1000000-0000-4000-8000-000000000001' }, headers: { 'X-CSRF-Token': csrf } });
    if (!escolha.ok()) throw new Error(`seleção de loja falhou: ${escolha.status()}`);
    const page = await ctx.newPage();
    const erros = [];
    page.on('pageerror', (e) => erros.push(String(e)));
    const clicar = (loc) => (mobile ? loc.tap() : loc.click());
    const semRolagem = async (r) => { const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); ok(`sem rolagem horizontal (${r})`, m.sw <= m.cw + 1, `${m.sw}/${m.cw}`); };
    const prefs = () => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return 'erro'; } }, CHAVE);
    await page.addInitScript((k) => { try { if (!sessionStorage.getItem('qa-shell-init')) { localStorage.removeItem(k); sessionStorage.setItem('qa-shell-init', '1'); } } catch { /* */ } }, CHAVE);

    await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.ad-topbar');

    // ── 1. Cabeçalho: dois controles distintos ──────────────────────────────────────────────────────
    const gatilho = page.getByRole('button', { name: 'Abrir menu da conta e da loja' });
    ok('gatilho do menu com nome acessível "Abrir menu da conta e da loja"', (await gatilho.count()) === 1);
    const seletor = page.locator('.ad-scope');
    ok('seletor de loja presente (usuário com 2 lojas) e à ESQUERDA do gatilho', (await seletor.count()) === 1 && (await seletor.boundingBox()).x < (await gatilho.boundingBox()).x);
    const textoSeletor = (await seletor.evaluate((el) => el.options[el.selectedIndex].text)).trim();
    const textoGatilho = (await gatilho.innerText()).trim();
    ok('o gatilho NÃO repete o nome da loja do seletor (só iniciais da conta)', textoGatilho.length <= 3 && !textoGatilho.includes(textoSeletor), `seletor "${textoSeletor}" · gatilho "${textoGatilho}"`);
    const cx = await gatilho.boundingBox();
    ok('gatilho compacto (largura ≤ 72 px) e alvo de toque ≥ 32 px de altura', cx.width <= 72 && cx.height >= 32, `${cx.width.toFixed(0)}×${cx.height.toFixed(0)}`);
    if (desktop) ok('tooltip nativo no desktop (title)', (await gatilho.getAttribute('title')) === 'Abrir menu da conta e da loja');
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-01-cabecalho.png`) });

    await clicar(gatilho);
    await page.waitForSelector('.ad-store-menu__content');
    const menu = await page.locator('.ad-store-menu__content').innerText();
    ok('menu aberto: organização atual, Configurações, Integrações, Campos personalizados e Sair', /Configurações/.test(menu) && /Integrações/.test(menu) && /Campos personalizados/.test(menu) && /Sair/.test(menu) && menu.split('\n')[0].trim().length > 0, menu.replace(/\n+/g, ' | ').slice(0, 140));
    const caixa = await page.locator('.ad-store-menu__content').boundingBox();
    ok('menu aberto dentro da viewport (sem sobreposição fora da tela)', caixa.x >= 0 && caixa.x + caixa.width <= vp.w + 0.5 && caixa.y + caixa.height <= vp.h + 0.5, `${caixa.x.toFixed(0)}+${caixa.width.toFixed(0)} de ${vp.w}`);
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-02-menu-aberto.png`) });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ad-store-menu__content', { state: 'detached' });
    ok('Esc fecha o menu e devolve o foco ao gatilho', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Abrir menu da conta e da loja'));
    // item ativo: página de Integrações marca aria-current no menu
    await page.goto(`${BASE}/admin/integracoes`, { waitUntil: 'networkidle' });
    await clicar(page.getByRole('button', { name: 'Abrir menu da conta e da loja' }));
    await page.waitForSelector('.ad-store-menu__content');
    ok('aria-current="page" em "Integrações" com o menu aberto na própria página', (await page.locator('.ad-store-menu__content a[aria-current="page"]').innerText()).includes('Integrações'));
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'networkidle' });

    // ── 2. Sidebar ──────────────────────────────────────────────────────────────────────────────────
    const toggles = page.locator('.ad-nav__group-toggle');
    const nGrupos = await toggles.count();
    ok('grupos com botão de recolher (aria-expanded/aria-controls) e todos ABERTOS por padrão', nGrupos >= 6 && (await page.$$eval('.ad-nav__group-toggle', (b) => b.every((x) => x.getAttribute('aria-expanded') === 'true' && document.getElementById(x.getAttribute('aria-controls'))))), `${nGrupos} grupos`);

    if (desktop) {
      const botao = page.getByRole('button', { name: 'Recolher menu lateral' });
      ok('desktop: botão "Recolher menu lateral" (aria-expanded=true, aria-controls=ad-sidebar)', (await botao.getAttribute('aria-expanded')) === 'true' && (await botao.getAttribute('aria-controls')) === 'ad-sidebar');
      const larguraAntes = (await page.locator('#ad-sidebar').boundingBox()).width;
      await page.screenshot({ path: path.join(OUT, `${vp.nome}-03-sidebar-expandida.png`) });
      await botao.click();
      await page.waitForTimeout(350);
      const larguraDepois = (await page.locator('#ad-sidebar').boundingBox()).width;
      ok('recolher reduz a sidebar a ícones (~64 px) e o conteúdo ocupa o espaço', larguraAntes >= 230 && larguraDepois <= 70 && (await page.locator('.ad-main').evaluate((e) => parseFloat(getComputedStyle(e).marginLeft))) <= 70, `${larguraAntes.toFixed(0)} → ${larguraDepois.toFixed(0)} px`);
      const botaoExp = page.getByRole('button', { name: 'Expandir menu lateral' });
      ok('botão vira "Expandir menu lateral" (aria-expanded=false)', (await botaoExp.getAttribute('aria-expanded')) === 'false');
      const links = await page.$$eval('#ad-sidebar .ad-nav__item', (els) => els.map((e) => ({ nome: e.innerText.trim(), href: e.getAttribute('href'), ativo: e.getAttribute('aria-current') === 'page', larguraTexto: e.querySelector('.ad-nav__label').getBoundingClientRect().width, icone: !!e.querySelector('.ad-nav__icon') })));
      ok('reduzida: todos os links continuam presentes, com nome acessível e ícone (sem texto na tela)', links.length >= 25 && links.every((l) => l.nome && l.href && l.icone && l.larguraTexto <= 2), `${links.length} links`);
      ok('reduzida: o item ativo (Visão geral) está indicado', links.filter((l) => l.ativo).length === 1 && links.find((l) => l.ativo).nome === 'Visão geral');
      ok('reduzida: nenhum grupo fica escondido (todas as rotas alcançáveis)', (await page.locator('#ad-sidebar .ad-nav__group-items:not([hidden])').count()) === nGrupos);
      // tooltip: mouse e teclado
      await page.locator('#ad-sidebar .ad-nav__item', { hasText: 'Clientes' }).first().hover();
      await page.waitForSelector('.ds-tooltip', { timeout: 3000 }).catch(() => {});
      ok('reduzida: tooltip com o nome ao passar o mouse', (await page.locator('.ds-tooltip').first().innerText().catch(() => '')).includes('Clientes'));
      await page.mouse.move(700, 500);
      await page.waitForFunction(() => document.querySelectorAll('.ds-tooltip').length === 0, null, { timeout: 4000 }).catch(() => {});
      // teclado: Tab até um item da sidebar reduzida (foco por teclado abre o tooltip)
      await page.locator('#ad-sidebar .ad-nav__item').first().focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.waitForSelector('.ds-tooltip', { timeout: 4000 }).catch(() => {});
      const focado = (await page.evaluate(() => document.activeElement?.innerText || '')).trim();
      const tips = (await page.locator('.ds-tooltip').allInnerTexts().catch(() => [])).join(' | ');
      ok('reduzida: tooltip com o nome ao focar pelo teclado', focado.length > 0 && tips.includes(focado), `foco "${focado}" · tooltip "${tips}"`);
      await page.screenshot({ path: path.join(OUT, `${vp.nome}-04-sidebar-reduzida.png`) });
      const c = await prefs();
      ok('a preferência foi gravada LOCALMENTE (chave versionada; sem dado sensível)', c && c.colapsada === true && Array.isArray(c.gruposFechados) && Object.keys(c).sort().join() === 'colapsada,gruposFechados');
      await page.reload({ waitUntil: 'networkidle' });
      ok('recarregar mantém a sidebar reduzida', (await page.locator('#ad-sidebar').boundingBox()).width <= 70);
      await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
      ok('navegar mantém a preferência e acende o item da página (Clientes)', (await page.locator('#ad-sidebar .ad-nav__item--active .ad-nav__label').innerText()) === 'Clientes' && (await page.locator('#ad-sidebar').boundingBox()).width <= 70);
      await semRolagem('sidebar reduzida em Clientes');
      await page.screenshot({ path: path.join(OUT, `${vp.nome}-05-reduzida-clientes.png`) });
      await page.getByRole('button', { name: 'Expandir menu lateral' }).click();
      await page.waitForTimeout(350);
      ok('expandir volta à sidebar completa', (await page.locator('#ad-sidebar').boundingBox()).width >= 230);
    } else {
      ok('mobile/tablet: NÃO há botão de recolher (o drawer não muda)', (await page.getByRole('button', { name: /(Recolher|Expandir) menu lateral/ }).isVisible().catch(() => false)) === false);
      // prefs colapsada gravadas antes NÃO afetam o drawer
      await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ colapsada: true, gruposFechados: [] })), CHAVE);
      await page.reload({ waitUntil: 'networkidle' });
      const abrir = page.getByRole('button', { name: 'Abrir menu de navegação' });
      await clicar(abrir);
      await page.waitForFunction(() => document.querySelector('.ad-shell--nav-open'));
      await page.waitForTimeout(400);
      const gaveta = await page.locator('#ad-sidebar').boundingBox();
      ok('drawer com a preferência "reduzida" salva: continua completo, com rótulos (nada compacto por cima do drawer)', gaveta.width >= 250 && (await page.locator('#ad-sidebar .ad-nav__label').first().evaluate((e) => e.getBoundingClientRect().width)) > 20, `largura ${gaveta.width.toFixed(0)}`);
      ok('drawer aberto: foco em "Fechar menu de navegação" e conteúdo inerte', (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Fechar menu de navegação' && (await page.locator('.ad-main').getAttribute('inert')) !== null);
      await page.screenshot({ path: path.join(OUT, `${vp.nome}-03-drawer-aberto.png`) });
      await semRolagem('drawer aberto');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      ok('Esc fecha o drawer e devolve o foco ao botão de menu', (await page.locator('.ad-shell--nav-open').count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Abrir menu de navegação');
      await page.evaluate((k) => localStorage.removeItem(k), CHAVE);
      await page.reload({ waitUntil: 'networkidle' });
    }

    // ── 3. Grupos recolhíveis (todas as larguras; no mobile dentro do drawer) ────────────────────────
    if (!desktop) { await clicar(page.getByRole('button', { name: 'Abrir menu de navegação' })); await page.waitForFunction(() => document.querySelector('.ad-shell--nav-open')); await page.waitForTimeout(350); }
    const grupoCat = page.locator('.ad-nav__group-toggle', { hasText: 'Catálogo' });
    const itensCat = page.locator('#nav-grupo-catálogo-itens a, [id^="nav-grupo-cat"][id$="-itens"] a');
    const antes = await itensCat.count();
    await clicar(grupoCat);
    await page.waitForTimeout(150);
    ok('fechar um grupo: aria-expanded=false e os itens saem (grupo sem página atual = nenhum item)', (await grupoCat.getAttribute('aria-expanded')) === 'false' && antes >= 4 && (await itensCat.filter({ visible: true }).count()) === 0, `${antes} → ${await itensCat.filter({ visible: true }).count()}`);
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-06-grupo-fechado.png`) });
    ok('preferência de grupo gravada localmente', ((await prefs()) || {}).gruposFechados?.includes('Catálogo'));
    await grupoCat.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    ok('teclado: Enter reabre o grupo', (await grupoCat.getAttribute('aria-expanded')) === 'true');
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    ok('teclado: Espaço fecha o grupo', (await grupoCat.getAttribute('aria-expanded')) === 'false');
    // grupo fechado que CONTÉM a página atual mostra só ela (orientação)
    await page.goto(`${BASE}/admin/produtos`, { waitUntil: 'networkidle' });
    if (!desktop) { await clicar(page.getByRole('button', { name: 'Abrir menu de navegação' })); await page.waitForFunction(() => document.querySelector('.ad-shell--nav-open')); await page.waitForTimeout(350); }
    const visiveisCat = await page.locator('.ad-nav__group', { has: page.locator('.ad-nav__group-toggle', { hasText: 'Catálogo' }) }).locator('a').filter({ visible: true }).allInnerTexts();
    ok('grupo fechado com a página atual (Produtos): só ela continua visível e marcada', visiveisCat.length === 1 && visiveisCat[0].trim() === 'Produtos', JSON.stringify(visiveisCat));
    await page.evaluate((k) => localStorage.removeItem(k), CHAVE);

    if (AXE) {
      await page.reload({ waitUntil: 'networkidle' });
      await page.addScriptTag({ path: AXE });
      const viol = await page.evaluate(async () => (await window.axe.run(document.querySelector('.ad-shell'))).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length})`));
      ok('axe-core no shell: nenhuma violação serious/critical', viol.length === 0, viol.join(', '));
    }
    // ── 4. Ordem final dos grupos e marca oficial ────────────────────────────────────────────────────────────────────────────────
    await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.ad-topbar');
    await page.evaluate((k) => { try { localStorage.removeItem(k); } catch { /* */ } }, CHAVE);
    await page.reload({ waitUntil: 'networkidle' });
    const ORDEM = ['Comunicação', 'Marketing e dados', 'Criativos', 'Campanhas', 'Operação', 'Financeiro', 'Catálogo'];
    const rotulos = await page.$$eval('.ad-nav__group-toggle', (b) => b.map((x) => x.textContent.trim()));
    ok('sidebar: grupos na ordem final (Comunicação → Marketing e dados → Criativos → Campanhas → Operação → Financeiro → Catálogo)', JSON.stringify(rotulos.filter((r) => ORDEM.includes(r))) === JSON.stringify(ORDEM) && rotulos.filter((r) => !ORDEM.includes(r)).length === 0, rotulos.join(' → '));
    const primeiro = await page.$eval('#ad-sidebar .ad-nav__item', (e) => e.textContent.trim());
    ok('"Visão geral" vem isolada antes dos grupos', primeiro === 'Visão geral' && (await page.$$eval('#ad-sidebar .ad-nav > *', (els) => els[0].querySelector('.ad-nav__group-toggle') === null)), primeiro);
    ok('nada de Conexões, Sistema, Webhooks e logs, Configurações, Integrações ou Campos personalizados na sidebar', !(await page.$$eval('#ad-sidebar .ad-nav__item, #ad-sidebar .ad-nav__group-toggle', (els) => els.map((e) => e.textContent.trim()))).some((t) => /^(Conexões|Sistema|Webhooks|Logs|Configurações|Integrações|Campos personalizados)/.test(t)));
    const logo = await page.$eval('img.ad-sidebar__logo', (i) => ({ ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute('src'), rw: i.getBoundingClientRect().width, rh: i.getBoundingClientRect().height }));
    ok('logo oficial (oria-simbolo.png) carregada, sem monograma "OR"', logo.ok && /oria-simbolo\.png$/.test(logo.src) && !(await page.locator('.ad-sidebar__brand').innerText()).match(/^OR\b/), `${logo.w}×${logo.h}`);
    ok('proporção do símbolo preservada (sem distorção)', Math.abs(logo.rw / logo.rh - logo.w / logo.h) < 0.03 * (logo.w / logo.h), `${logo.rw.toFixed(1)}×${logo.rh.toFixed(1)} vs ${logo.w}×${logo.h}`);
    if (desktop) {
      const marca = await page.locator('.ad-sidebar__brand').innerText();
      ok('expandida: símbolo + "Oria" + "Central operacional" alinhados', /Oria/.test(marca) && /Central operacional/.test(marca));
      const yl = await page.locator('img.ad-sidebar__logo').boundingBox(); const yt = await page.locator('.ad-sidebar__brand-text').boundingBox();
      ok('expandida: símbolo e texto centrados na mesma linha', Math.abs((yl.y + yl.height / 2) - (yt.y + yt.height / 2)) <= 3, `${(yl.y + yl.height / 2).toFixed(1)} vs ${(yt.y + yt.height / 2).toFixed(1)}`);
      await page.screenshot({ path: path.join(OUT, `${vp.nome}-04-marca-ordem-expandida.png`), clip: { x: 0, y: 0, width: 280, height: vp.h } });
      await page.getByRole('button', { name: 'Recolher menu lateral' }).click();
      await page.waitForTimeout(400);
      const bl = await page.locator('img.ad-sidebar__logo').boundingBox();
      const largura = (await page.locator('#ad-sidebar').boundingBox()).width;
      ok('recolhida: só o símbolo, centralizado no trilho', Math.abs((bl.x + bl.width / 2) - largura / 2) <= 2 && (await page.locator('.ad-sidebar__brand-text').evaluate((e) => e.getBoundingClientRect().width)) <= 2, `centro ${(bl.x + bl.width / 2).toFixed(1)} de ${largura}`);
      ok('recolhida: o nome "Oria" continua acessível (texto só para leitores de tela)', /Oria/.test(await page.locator('.ad-sidebar__brand-text').evaluate((e) => e.textContent)));
      await page.locator('img.ad-sidebar__logo').hover();
      await page.waitForSelector('.ds-tooltip', { timeout: 3000 }).catch(() => {});
      ok('recolhida: tooltip "Oria" no símbolo', (await page.locator('.ds-tooltip').allInnerTexts()).some((t) => /Oria/.test(t)));
      await page.mouse.move(700, 500);
      await page.screenshot({ path: path.join(OUT, `${vp.nome}-05-marca-recolhida.png`), clip: { x: 0, y: 0, width: 120, height: vp.h } });
      await page.getByRole('button', { name: 'Expandir menu lateral' }).click();
      await page.waitForTimeout(350);
    } else {
      await clicar(page.getByRole('button', { name: 'Abrir menu de navegação' })); await page.waitForFunction(() => document.querySelector('.ad-shell--nav-open')); await page.waitForTimeout(350);
      const bd = await page.locator('img.ad-sidebar__logo').boundingBox();
      ok('drawer: símbolo visível, com dimensões adequadas e dentro da tela', bd && bd.width >= 30 && bd.height >= 24 && bd.x >= 0 && bd.x + bd.width <= vp.w, bd ? `${bd.width.toFixed(0)}×${bd.height.toFixed(0)}` : 'sem caixa');
      ok('drawer: "Oria" e "Central operacional" visíveis ao lado do símbolo', (await page.locator('.ad-sidebar__brand-text').innerText()).includes('Central operacional'));
      await page.screenshot({ path: path.join(OUT, `${vp.nome}-04-drawer-marca-ordem.png`) });
      await page.keyboard.press('Escape'); await page.waitForTimeout(350);
    }
    // Rota de Marketing e de Campanhas: a página atual continua destacada no grupo certo.
    for (const [rota, item, grupo] of [['/admin/meta-ads', 'Meta Ads', 'Marketing e dados'], ['/admin/campanhas', 'Todas as campanhas', 'Campanhas']]) {
      await page.goto(`${BASE}${rota}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.ad-topbar');
      const ativo = await page.$$eval('#ad-sidebar .ad-nav__item[aria-current="page"]', (els) => els.map((e) => ({ t: e.textContent.trim(), g: e.closest('.ad-nav__group')?.querySelector('.ad-nav__group-toggle')?.textContent.trim() })));
      ok(`${item} continua destacado no grupo "${grupo}"`, ativo.length === 1 && ativo[0].t === item && ativo[0].g === grupo, JSON.stringify(ativo));
    }
    await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'networkidle' });
    await semRolagem('final');
    ok('sem erro de JavaScript', erros.length === 0, erros.slice(0, 2).join(' | '));
    await ctx.close();
  }
} finally {
  await pool.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [ORG2, u.id]).catch(() => {});
  await pool.end();
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'resultado-shell.json'), JSON.stringify({ geradoEm: new Date().toISOString(), base: BASE, dadosSinteticos: true, resultados }, null, 2));
const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram · evidências em ${OUT}`);
process.exit(falhas.length ? 1 : 0);
