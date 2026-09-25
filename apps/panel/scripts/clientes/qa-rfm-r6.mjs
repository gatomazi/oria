#!/usr/bin/env node
// Rodada 6 — smoke CURTO (1440 e 390) dos estados novos da Audiência fail-closed, sobre a fixture SINTÉTICA local.
// NUNCA clica em "Enviar agora", "Agendar" nem "Salvar rascunho"; nenhuma campanha é criada.
//
//   SMOKE_BASE_URL=http://localhost:PORTA SMOKE_PASSWORD=<senha-de-teste> SEED_DATABASE_URL=postgres://postgres:…@127.0.0.1:PORTA/oria_test \
//   PLAYWRIGHT_MODULE=/caminho/playwright-core AXE_CORE_PATH=/caminho/axe.min.js node scripts/clientes/qa-rfm-r6.mjs --out relatorios-privados/rfm-r6
//
// Estados: (1) audiência sem condição ≠ "todos os clientes"; (2) "todos" só quando marcado; (3) linha incompleta NÃO é descartada
// (erro do servidor visível, sem contagem); (4) erro 409/400 e recuperação; (5) segmento RFM legado "aproximado": aviso, bloqueio
// da Revisão até confirmar, e "Recriar na avaliação exata".
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
const SEED_DB = process.env.SEED_DATABASE_URL;
const OUT = path.resolve(arg('out', './relatorios-privados/rfm-r6'));
if (!SENHA || !SEED_DB) throw new Error('defina SMOKE_PASSWORD e SEED_DATABASE_URL (banco local de teste)');
if (!['127.0.0.1', 'localhost'].includes(new URL(SEED_DB).hostname)) throw new Error('recusado: banco não-local');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [{ nome: 'desktop-1440', w: 1440, h: 900 }, { nome: 'mobile-390', w: 390, h: 844 }];
const resultados = [];
let contexto = '';
const ok = (nome, cond, detalhe = '') => { resultados.push({ contexto, nome, ok: !!cond, detalhe }); console.log(`${cond ? 'PASS' : 'FAIL'}  [${contexto}] ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

const pool = new pg.Pool({ connectionString: SEED_DB, max: 1 });
const ORG = 'a1000000-0000-4000-8000-000000000001';
const browser = await chromium.launch();
let segLegadoId = null;
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
    const clicar = (loc) => (mobile ? loc.tap() : loc.click());
    let previas = 0;
    page.on('request', (r) => { if (r.url().includes('/audience/preview')) previas += 1; });
    const semRolagem = async (r) => { const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); ok(`sem rolagem horizontal (${r})`, m.sw <= m.cw + 1, `${m.sw}/${m.cw}`); };
    const previaTexto = () => page.locator('.ad-segmento-preview').innerText();

    // ── 1. audiência sem condição: NÃO é "todos os clientes" ─────────────────────────────────────────
    await page.goto(`${BASE}/admin/campanhas/nova`, { waitUntil: 'networkidle' });
    await page.locator('input[type="text"]').first().fill('QA Rodada 6 (não salvar)');
    await clicar(page.getByRole('button', { name: 'Avançar' }));
    await page.waitForSelector('.ad-todos-card');
    const antes = previas;
    await page.waitForTimeout(900);
    ok('sem condição: nenhuma prévia é pedida e nenhuma contagem aparece', previas === antes && !/eleg[ií]veis?/.test(await previaTexto()) && !/Calculando/.test(await previaTexto()));
    ok('"todos os clientes" começa DESMARCADO, com a explicação de que lista vazia não é "todos"', !(await page.locator('.ad-todos-card input[type="checkbox"]').isChecked()) && /nunca vira "todos os clientes"/.test(await page.locator('.ad-todos-card').innerText()));
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-01-sem-condicao.png`), fullPage: true });
    await semRolagem('sem condição');

    // ── 2. Revisão com audiência incompleta: erro verdadeiro, envio/agendamento bloqueados ───────────
    for (let i = 0; i < 3; i += 1) await clicar(page.getByRole('button', { name: 'Avançar' }));
    await page.waitForSelector('.tn-form [role="alert"]');
    const revisao = await page.locator('.ad-revisao').innerText();
    ok('Revisão sem condição: "Não foi possível calcular a audiência" + causa (AUDIENCIA_SEM_FILTRO) e bloqueio', /Não foi possível calcular a audiência/.test(revisao) && /nenhuma condição/i.test(await page.locator('.tn-form [role="alert"]').innerText()) && /bloqueado/.test(await page.locator('.tn-form [role="alert"]').innerText()));
    await page.locator('input[type="datetime-local"]').fill('2030-01-01T10:00');
    ok('"Agendar campanha" e "Enviar agora" desabilitados', (await page.getByRole('button', { name: 'Agendar campanha' }).isDisabled()) && (await page.getByRole('button', { name: 'Enviar agora' }).isDisabled()));
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-02-revisao-sem-condicao.png`), fullPage: true });
    for (let i = 0; i < 3; i += 1) await clicar(page.getByRole('button', { name: 'Voltar' }));
    await page.waitForSelector('.ad-todos-card');

    // ── 3. "todos os clientes" só quando marcado; depois adicionar condição o desmarca ────────────────
    await clicar(page.locator('.ad-todos-card input[type="checkbox"]'));
    await page.waitForFunction(() => /eleg[ií]veis?/.test(document.querySelector('.ad-segmento-preview')?.innerText || ''));
    const todos = await previaTexto();
    ok('"todos" explícito: prévia calculada, com as exclusões comerciais valendo', /clientes? eleg[ií]veis?/.test(todos) && /Excluídos por contato/.test(todos), todos.replace(/\s+/g, ' ').slice(0, 130));
    await clicar(page.getByRole('button', { name: '+ Adicionar filtro' }));
    ok('adicionar uma condição desfaz o "todos" (cartão some, sem ambiguidade)', (await page.locator('.ad-todos-card').count()) === 0 && (await page.locator('[aria-label="Campo do filtro"]').count()) === 1);

    // ── 4. linha incompleta NÃO é descartada: erro do servidor, sem contagem ──────────────────────────
    await page.waitForSelector('.ad-segmento-preview [role="alert"]');
    const incompleto = await previaTexto();
    ok('condição incompleta: erro acionável do servidor, nenhuma contagem (a linha não foi descartada)', /condição 1/.test(incompleto) && /número/.test(incompleto) && !/clientes? eleg/i.test(incompleto), incompleto.replace(/\s+/g, ' ').slice(0, 160));
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-03-linha-incompleta.png`), fullPage: true });
    await page.getByPlaceholder('valor').fill('45');
    await page.waitForFunction(() => /clientes? eleg[ií]veis?/.test(document.querySelector('.ad-segmento-preview')?.innerText || ''));
    ok('recuperação: ao completar a condição a prévia volta', /clientes? eleg[ií]veis?/.test(await previaTexto()));
    // UF inválida (a lista só oferece UFs válidas; o campo de valor de texto não existe para uf) — campo de campanha vazio:
    await page.locator('[aria-label="Campo do filtro"]').selectOption('recebeuCampanha');
    await page.waitForSelector('.ad-segmento-preview [role="alert"]');
    ok('"recebeu a campanha" sem id: erro do servidor (campanhaId), nunca ignorado', /campanhaId/.test(await previaTexto()));
    if (AXE) {
      await page.addScriptTag({ path: AXE });
      const viol = await page.evaluate(async () => (await window.axe.run(document.querySelector('#ad-content') || document.body)).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length})`));
      ok('axe-core: nenhuma violação serious/critical', viol.length === 0, viol.join(', '));
    }

    // ── 5. segmento RFM LEGADO "aproximado": aviso, bloqueio até confirmar, "recriar na via exata" ────
    if (segLegadoId == null) {
      const resumo = await (await ctx.request.get(`${BASE}/api/admin/clientes/resumo`)).json();
      const alvo = resumo.rfm.segmentos.find((s) => s.id === 'aguardando_recompra');
      const p = alvo.predicado;
      const f = [];
      if (p.recenciaDias.min > 0) f.push({ field: 'diasSemComprar', op: 'gte', value: p.recenciaDias.min });
      if (p.recenciaDias.max != null) f.push({ field: 'diasSemComprar', op: 'lte', value: p.recenciaDias.max });
      if (p.frequencia.min != null) f.push({ field: 'quantidadePedidos', op: 'gte', value: p.frequencia.min });
      if (p.frequencia.max != null) f.push({ field: 'quantidadePedidos', op: 'lte', value: p.frequencia.max });
      const { rows: [r] } = await pool.query(
        `INSERT INTO segments (organization_id, nome, match, filtros, exclusoes, criado_por, origem, politica, predicado, rfm_versao, classificado_em, rfm_segmento)
         VALUES ($1,'RFM · Aguardando recompra (legado)','ALL',$2,'{}','admin','rfm','dinamico',$3,$4,now(),'aguardando_recompra') RETURNING id`,
        [ORG, JSON.stringify(f), JSON.stringify(p), resumo.rfm.regraVersao]
      );
      segLegadoId = r.id;
    }
    await page.goto(`${BASE}/admin/campanhas/nova?segmento=${segLegadoId}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('input[type="text"]')?.value.startsWith('RFM · '));
    await clicar(page.getByRole('button', { name: 'Avançar' }));
    await page.getByRole('button', { name: 'Recriar na avaliação exata' }).waitFor();
    const nBotoes = await page.getByRole('button', { name: 'Recriar na avaliação exata' }).count();
    const marcado = await page.getByRole('checkbox', { name: /Entendo que o público é aproximado/ }).first().isChecked();
    ok('segmento RFM legado: aviso de avaliação aproximada com "Recriar na avaliação exata" e confirmação desmarcada', nBotoes >= 1 && !marcado, `botões ${nBotoes}, marcado ${marcado}`);
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-04-segmento-aproximado.png`), fullPage: true });
    await semRolagem('segmento aproximado');
    for (let i = 0; i < 3; i += 1) await clicar(page.getByRole('button', { name: 'Avançar' }));
    await page.waitForSelector('.ad-revisao');
    await page.locator('input[type="datetime-local"]').fill('2030-01-01T10:00');
    ok('Revisão do segmento aproximado NÃO confirmado: "Agendar campanha" bloqueado', await page.getByRole('button', { name: 'Agendar campanha' }).isDisabled());
    for (let i = 0; i < 3; i += 1) await clicar(page.getByRole('button', { name: 'Voltar' }));
    await clicar(page.getByRole('checkbox', { name: /Entendo que o público é aproximado/ }));
    for (let i = 0; i < 3; i += 1) await clicar(page.getByRole('button', { name: 'Avançar' }));
    await page.waitForFunction(() => /no segmento|encontrados/.test(document.querySelector('.ad-revisao')?.innerText || ''));
    await page.locator('input[type="datetime-local"]').fill('2030-01-01T10:00');
    ok('depois de confirmar explicitamente, a Revisão calcula e libera "Agendar campanha" (NÃO clicado)', !(await page.getByRole('button', { name: 'Agendar campanha' }).isDisabled()));
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-05-aproximado-confirmado-revisao.png`), fullPage: true });
    for (let i = 0; i < 3; i += 1) await clicar(page.getByRole('button', { name: 'Voltar' }));
    await clicar(page.getByRole('button', { name: 'Recriar na avaliação exata' }));
    await page.waitForURL(/\/admin\/campanhas\/nova\?segmento=\d+/);
    await page.waitForSelector('.ad-rfm-card'); // já estamos na etapa Audiência: a página recarrega os segmentos e aplica o novo
    await page.waitForFunction(() => !document.body.innerText.includes('avaliação aproximada'), null, { timeout: 8000 }).catch(() => {});
    const nRfm = await page.locator('.ad-rfm-card').count();
    const nAprox = await page.locator('.ds-callout:has-text("avaliação aproximada")').count();
    ok('"Recriar na avaliação exata": novo segmento com o cartão RFM exato e sem aviso de aproximação', nRfm === 1 && nAprox === 0, `cartão RFM ${nRfm}, avisos de aproximação ${nAprox}`);

    ok('sem erro de JavaScript', erros.length === 0, erros.slice(0, 2).join(' | '));
    const camps = await (await ctx.request.get(`${BASE}/api/admin/campaigns`)).json();
    ok('nenhuma campanha criada nem disparada', (camps.campanhas || camps.campaigns || []).length === 0);
    await ctx.close();
  }
} finally {
  if (segLegadoId != null) await pool.query('DELETE FROM segments WHERE id = $1', [segLegadoId]).catch(() => {});
  await pool.end();
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ geradoEm: new Date().toISOString(), base: BASE, dadosSinteticos: true, resultados }, null, 2));
const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram · evidências em ${OUT}`);
process.exit(falhas.length ? 1 : 0);
