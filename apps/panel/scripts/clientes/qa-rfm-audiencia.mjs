#!/usr/bin/env node
// Rodada 5 — QA da jornada RFM Explorer → Nova campanha → Audiência → Revisão (Playwright), só sobre a fixture SINTÉTICA local.
// NUNCA clica em "Enviar agora", "Agendar" nem "Salvar rascunho": nenhuma campanha é criada e nada é disparado.
//
//   SMOKE_BASE_URL=http://localhost:PORTA SMOKE_PASSWORD=<senha-de-teste> PLAYWRIGHT_MODULE=/caminho/playwright-core \
//   AXE_CORE_PATH=/caminho/axe.min.js node scripts/clientes/qa-rfm-audiencia.mjs --out apps/panel/relatorios-privados/rfm-r5/audiencia
//
// Por viewport (1440×900, 390×844, 320×640):
//   · Audiência: cartão do segmento RFM (condição obrigatória) com a regra do segmento CLICADO, contagem = prévia do servidor,
//     população = matriz, universos/asOf/regra declarados, sem rolagem horizontal, axe sem serious/critical;
//   · Revisão: reavalia ao entrar (não reaproveita a foto da etapa anterior) e mostra o erro verdadeiro se a prévia falhar,
//     bloqueando "Agendar"; nunca mostra contagem de filtro antigo;
//   · troca de segmento (Clientes → outro segmento → Audiência): mostra a regra NOVA, nunca a anterior;
//   · "Montar filtros manualmente" depois de um segmento RFM zera a condição oculta;
//   · resposta lenta/fora de ordem da prévia: a contagem exibida é sempre a da configuração vigente.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:18085';
const EMAIL = process.env.SMOKE_EMAIL || 'local@teste.oria';
const SENHA = process.env.SMOKE_PASSWORD;
const AXE = process.env.AXE_CORE_PATH || null;
const OUT = path.resolve(arg('out', './relatorios-privados/rfm-r5/audiencia'));
if (!SENHA) throw new Error('defina SMOKE_PASSWORD (senha do usuário de teste do painel local)');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [{ nome: 'desktop-1440', w: 1440, h: 900 }, { nome: 'mobile-390', w: 390, h: 844 }, { nome: 'mobile-320', w: 320, h: 640 }];
const resultados = [];
let contexto = '';
const ok = (nome, cond, detalhe = '') => { resultados.push({ contexto, nome, ok: !!cond, detalhe }); console.log(`${cond ? 'PASS' : 'FAIL'}  [${contexto}] ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    contexto = vp.nome;
    const mobile = vp.w < 720;
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: mobile, hasTouch: mobile, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    const login = await ctx.request.post(`${BASE}/api/admin/login`, { data: { email: EMAIL, password: SENHA } });
    if (!login.ok()) throw new Error(`login falhou: HTTP ${login.status()}`);
    const csrf = (await login.json()).csrfToken;
    const page = await ctx.newPage();
    const erros = [];
    page.on('pageerror', (e) => erros.push(String(e)));
    const clicar = (loc) => (mobile ? loc.tap() : loc.click());
    const linha = (nome) => page.locator('.rfmx-linha', { has: page.locator('.rfmx-nome', { hasText: new RegExp(`^${nome}$`) }) }).first();
    const semRolagem = async (rotulo) => {
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      ok(`sem rolagem horizontal (${rotulo})`, r.sw <= r.cw + 1, `${r.sw}/${r.cw}`);
    };
    // A prévia é recalculada com debounce quando a página termina de carregar: espera o texto final, estável (sem "Calculando…").
    const previaPronta = async () => {
      await page.waitForFunction(() => { const t = document.querySelector('.ad-segmento-preview')?.innerText || ''; return /calculado agora/.test(t) && !/Calculando/.test(t); });
      await page.waitForTimeout(900);
      await page.waitForFunction(() => { const t = document.querySelector('.ad-segmento-preview')?.innerText || ''; return /calculado agora/.test(t) && !/Calculando/.test(t); });
    };
    const previa = async (filtros) => (await ctx.request.post(`${BASE}/api/admin/campaigns/audience/preview`, {
      data: { match: 'ALL', filters: filtros, exclusions: { semOptIn: true, numeroInvalido: true } }, headers: { 'X-CSRF-Token': csrf },
    })).json();
    const segmentoSalvo = async (id) => (await (await ctx.request.get(`${BASE}/api/admin/segments`)).json()).segmentos.find((s) => s.id === id);
    const resumo = await (await ctx.request.get(`${BASE}/api/admin/clientes/resumo`)).json();

    // ── 1. Explorer → CTA → Nova campanha → Audiência (Aguardando recompra) ───────────────────────────
    async function irParaAudiencia(nomeSegmento) {
      await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.rfmx-linha');
      await clicar(linha(nomeSegmento));
      await page.waitForSelector('.segp__titulo');
      await clicar(page.getByRole('button', { name: 'Criar campanha com este segmento' }));
      await page.waitForURL(/\/admin\/campanhas\/nova\?segmento=\d+/);
      const id = new URL(page.url()).searchParams.get('segmento');
      await page.waitForFunction(() => document.querySelector('input[type="text"]')?.value.startsWith('RFM · '));
      await clicar(page.getByRole('button', { name: 'Avançar' }));
      await page.waitForSelector('.ad-rfm-card');
      await previaPronta();
      return id;
    }

    const id1 = await irParaAudiencia('Aguardando recompra');
    const salvo1 = await segmentoSalvo(id1);
    const api1 = await previa(salvo1.filtros);
    const seg1 = resumo.rfm.segmentos.find((s) => s.id === 'aguardando_recompra');
    const cartao1 = await page.locator('.ad-rfm-card').innerText();
    ok('Audiência: cartão obrigatório com a regra do segmento clicado (46 a 90 dias)', /Segmento RFM: Aguardando recompra/.test(cartao1) && /entre 46 e 90 dias/.test(cartao1) && /Condição obrigatória/.test(cartao1), cartao1.replace(/\s+/g, ' ').slice(0, 130));
    ok('população da Audiência = segmento da matriz (igualdade exata)', api1.matched === seg1.clientes && api1.rfm.universos.segmento === seg1.clientes, `Audiência ${api1.matched} × matriz ${seg1.clientes}`);
    const texto1 = await page.locator('.ad-segmento-preview').innerText();
    const m1 = texto1.match(/(\d[\d.]*)\s+clientes? eleg[ií]veis?\s+—\s+(\d[\d.]*)\s+no segmento,\s+(\d[\d.]*)\s+exclu[ií]dos?/i);
    ok('contagem exibida = prévia do servidor', m1 && Number(m1[1].replace(/\./g, '')) === api1.eligible && Number(m1[2].replace(/\./g, '')) === api1.matched && Number(m1[3].replace(/\./g, '')) === api1.excluded, m1 ? m1.slice(1).join('/') : texto1.slice(0, 80));
    ok('a prévia declara universos (com pedido ⊃ compradores válidos ⊃ segmento), asOf e regra', /pessoas? no segmento RFM/.test(texto1) && /compradores? v[aá]lidos?/.test(texto1) && /pessoas? com pedido/.test(texto1) && /calculado agora/.test(texto1) && texto1.includes(api1.rfm.regraVersao));
    ok('motivos de exclusão de contato discriminados (só os que existem)', api1.excluded === 0 || /Excluídos por contato:/.test(texto1), texto1.replace(/\s+/g, ' ').slice(0, 160));
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-01-audiencia.png`), fullPage: true });
    await semRolagem('Audiência');
    if (AXE) {
      await page.addScriptTag({ path: AXE });
      const viol = await page.evaluate(async () => (await window.axe.run(document.querySelector('#ad-content') || document.body)).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length})`));
      ok('axe-core na Audiência: nenhuma violação serious/critical', viol.length === 0, viol.join(', '));
    }

    // ── 2. Resposta lenta e fora de ordem: a contagem exibida é a da configuração vigente ─────────────
    await page.route('**/api/admin/campaigns/audience/preview', async (rt) => {
      const corpo = rt.request().postDataJSON();
      const soOptIn = (corpo.exclusions || {}).semOptIn === false;
      if (soOptIn) await new Promise((r) => setTimeout(r, 1500)); // a configuração ANTIGA responde por último
      await rt.continue();
    });
    await page.getByRole('checkbox', { name: 'Sem opt-in de marketing' }).uncheck(); // dispara prévia lenta (config A)
    await page.waitForTimeout(500);
    await page.getByRole('checkbox', { name: 'Sem opt-in de marketing' }).check(); //  volta à config B (rápida) antes de A responder
    await page.waitForTimeout(2600);
    const texto2 = await page.locator('.ad-segmento-preview').innerText();
    const m2 = texto2.match(/(\d[\d.]*)\s+clientes? eleg[ií]veis?/i);
    ok('resposta lenta de uma configuração antiga não sobrescreve a atual', m2 && Number(m2[1].replace(/\./g, '')) === api1.eligible, m2 ? m2[1] : texto2.slice(0, 60));
    await page.unroute('**/api/admin/campaigns/audience/preview');

    // ── 3. Revisão: reavalia ao entrar; erro verdadeiro bloqueia o envio ──────────────────────────────
    let chamadasPrevia = 0;
    page.on('request', (r) => { if (r.url().includes('/audience/preview')) chamadasPrevia += 1; });
    const antes = chamadasPrevia;
    for (let i = 0; i < 3; i += 1) await clicar(page.getByRole('button', { name: 'Avançar' })); // Template → Conteúdo/Mensagem → Revisão
    await page.waitForFunction(() => /Revisão|Resumo|Audiência/.test(document.body.innerText) && document.querySelector('.ad-revisao'));
    await page.waitForFunction(() => /no segmento/.test(document.querySelector('.ad-revisao')?.innerText || ''));
    ok('Revisão: a audiência foi RECALCULADA ao entrar (nova chamada de prévia)', chamadasPrevia > antes, `+${chamadasPrevia - antes} chamada(s)`);
    const rev = await page.locator('.ad-revisao').innerText();
    ok('Revisão mostra a mesma contagem do servidor, com "no segmento" e a regra', new RegExp(`${api1.matched} no segmento`).test(rev) && /calculado agora/.test(await page.locator('.tn-form').innerText()), rev.replace(/\s+/g, ' ').slice(0, 140));
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-02-revisao.png`), fullPage: true });
    await semRolagem('Revisão');

    // Falha da prévia (409 acionável) ao reavaliar: erro verdadeiro, sem contagem, envio bloqueado.
    await page.route('**/api/admin/campaigns/audience/preview', (rt) => rt.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'A regra RFM mudou desde que este segmento foi salvo (simulado). Crie um novo segmento em Clientes com a regra atual.', codigo: 'RFM_REGRA_DIVERGENTE' }) }));
    for (let i = 0; i < 3; i += 1) await clicar(page.getByRole('button', { name: 'Voltar' })); // Revisão → Conteúdo → Template → Audiência
    await page.getByRole('checkbox', { name: 'Números inválidos/sem telefone' }).uncheck(); // muda a configuração → nova prévia (409)
    await page.waitForSelector('[role="alert"]');
    const textoErro = await page.locator('.ad-segmento-preview').innerText();
    ok('erro da prévia (409): mensagem acionável e NENHUMA contagem exibida', /regra RFM mudou/.test(textoErro) && !/clientes? eleg/i.test(textoErro), textoErro.replace(/\s+/g, ' ').slice(0, 150));
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-03-erro-previa.png`), fullPage: true });
    for (let i = 0; i < 3; i += 1) await clicar(page.getByRole('button', { name: 'Avançar' }));
    await page.waitForSelector('.ad-revisao');
    await page.waitForSelector('.tn-form [role="alert"]');
    ok('Revisão com prévia em erro: alerta verdadeiro e "Calculando…"/contagem NÃO aparece como se estivesse pronta', /Não foi possível calcular a audiência/.test(await page.locator('.ad-revisao').innerText()) && /bloqueado/.test(await page.locator('.tn-form [role="alert"]').innerText()));
    await page.locator('input[type="datetime-local"]').fill('2030-01-01T10:00');
    ok('"Agendar campanha" fica desabilitado enquanto a audiência não pode ser calculada', await page.getByRole('button', { name: 'Agendar campanha' }).isDisabled());
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-04-revisao-erro.png`), fullPage: true });
    await page.unroute('**/api/admin/campaigns/audience/preview');

    // ── 4. Trocar de segmento: a Audiência mostra a regra NOVA, nunca a anterior ──────────────────────
    const id2 = await irParaAudiencia('Novos');
    const cartao2 = await page.locator('.ad-rfm-card').innerText();
    ok('outro segmento (Novos): cartão com a regra de Novos e nada de "46 e 90"', id2 !== id1 && /Segmento RFM: Novos/.test(cartao2) && /até 45 dias/.test(cartao2) && !/46 e 90/.test(cartao2), cartao2.replace(/\s+/g, ' ').slice(0, 110));
    const texto3 = await page.locator('.ad-segmento-preview').innerText();
    const seg2 = resumo.rfm.segmentos.find((s) => s.id === 'novos');
    ok('contagem de Novos = matriz (sem resquício do segmento anterior)', new RegExp(`${seg2.clientes} no segmento`).test(texto3), texto3.replace(/\s+/g, ' ').slice(0, 100));

    // ── 5. "Montar filtros manualmente" depois de um segmento RFM ─────────────────────────────────────
    await page.locator('.ad-segmento-form').locator('xpath=ancestor::div[contains(@class,"tn-form")]').first().locator('select').first().selectOption('');
    await page.waitForTimeout(700);
    ok('"Montar filtros manualmente" remove a condição RFM (não fica oculta atrás do seletor)', (await page.locator('.ad-rfm-card').count()) === 0 && (await page.locator('[aria-label="Campo do filtro"]').count()) === 1);

    ok('sem erro de JavaScript', erros.length === 0, erros.slice(0, 2).join(' | '));
    const camps = await (await ctx.request.get(`${BASE}/api/admin/campaigns`)).json();
    ok('nenhuma campanha criada nem disparada', (camps.campanhas || camps.campaigns || []).length === 0);
    await ctx.close();
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ geradoEm: new Date().toISOString(), base: BASE, dadosSinteticos: true, resultados }, null, 2));
const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram · evidências em ${OUT}`);
process.exit(falhas.length ? 1 : 0);
