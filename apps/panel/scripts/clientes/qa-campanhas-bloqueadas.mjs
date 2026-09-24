#!/usr/bin/env node
// Encerramento — smoke curto: campanha bloqueada mostra o MOTIVO na lista e ao abrir (1440 e 390). Fixture SINTÉTICA local; insere e
// remove campanhas agendadas (futuro, nunca disparam) direto no banco de teste; não clica em Enviar/Agendar/Salvar.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const pg = require(require.resolve('pg', { paths: [process.cwd()] }));
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:18085';
const SENHA = process.env.SMOKE_PASSWORD;
const DB = process.env.SEED_DATABASE_URL;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', './relatorios-privados/rfm-r7'));
if (!SENHA || !DB) throw new Error('defina SMOKE_PASSWORD e SEED_DATABASE_URL');
if (!['127.0.0.1', 'localhost'].includes(new URL(DB).hostname)) throw new Error('recusado: banco não-local');
fs.mkdirSync(OUT, { recursive: true });
const resultados = [];
let contexto = '';
const ok = (n, c, d = '') => { resultados.push({ contexto, nome: n, ok: !!c, detalhe: d }); console.log(`${c ? 'PASS' : 'FAIL'}  [${contexto}] ${n}${d ? ` — ${d}` : ''}`); };

const pool = new pg.Pool({ connectionString: DB, max: 1 });
const ORG = 'a1000000-0000-4000-8000-000000000001';
const STORE = 'a2000000-0000-4000-8000-000000000001';
const ids = [];
const cria = async (nome, def, status) => {
  const { rows: [r] } = await pool.query(
    `INSERT INTO campaigns (organization_id, store_id, loja, nome, template_nome, audience_definition, status, agendada_para, criado_por)
     VALUES ($1,$2,'sul',$3,'tpl_teste',$4,$5,${status === 'scheduled' ? "now() + interval '30 days'" : 'NULL'},'admin') RETURNING id`, [ORG, STORE, nome, JSON.stringify(def), status]);
  ids.push(r.id);
  return r.id;
};
const browser = await chromium.launch();
try {
  const idBloq = await cria('QA agendada bloqueada (campo desconhecido)', { match: 'ALL', filtros: [{ field: 'segmentoAntigo', value: 'vip' }], exclusoes: {} }, 'scheduled');
  await cria('QA agendada válida', { match: 'ALL', filtros: [{ field: 'uf', value: 'RS' }], exclusoes: {} }, 'scheduled');
  for (const vp of [{ nome: 'desktop-1440', w: 1440, h: 900 }, { nome: 'mobile-390', w: 390, h: 844 }]) {
    contexto = vp.nome;
    const mobile = vp.w < 720;
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: mobile, hasTouch: mobile, locale: 'pt-BR' });
    const login = await ctx.request.post(`${BASE}/api/admin/login`, { data: { email: 'local@teste.oria', password: SENHA } });
    if (!login.ok()) throw new Error(`login: ${login.status()}`);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/campanhas`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cp-bloqueio');
    const linha = await page.locator('tr, [role="row"]', { hasText: 'QA agendada bloqueada' }).first().innerText();
    ok('lista: badge "Agendada · bloqueada" e o motivo ao lado', /bloqueada/i.test(linha) && /segmentoAntigo/.test(linha) && /nada foi calculado nem enviado/.test(linha), linha.replace(/\s+/g, ' ').slice(0, 150));
    const valida = await page.locator('tr, [role="row"]', { hasText: 'QA agendada válida' }).first().innerText();
    ok('lista: a campanha válida NÃO tem selo de bloqueio', !/bloqueada/i.test(valida));
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    ok('sem rolagem horizontal da página', m.sw <= m.cw + 1, `${m.sw}/${m.cw}`);
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-01-lista-bloqueada.png`), fullPage: true });
    await page.goto(`${BASE}/admin/campanhas/nova?editar=${idBloq}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.ds-callout:has-text("BLOQUEADA")');
    const aviso = await page.locator('.ds-callout:has-text("BLOQUEADA")').innerText();
    ok('editar: aviso "Campanha agendada BLOQUEADA" com o motivo e a orientação; nada enviado', /segmentoAntigo/.test(aviso) && /Nada foi enviado/.test(aviso), aviso.replace(/\s+/g, ' ').slice(0, 150));
    await page.screenshot({ path: path.join(OUT, `${vp.nome}-02-editar-bloqueada.png`), fullPage: true });
    await ctx.close();
  }
} finally {
  for (const id of ids) await pool.query('DELETE FROM campaigns WHERE id = $1', [id]).catch(() => {});
  await pool.end();
  await browser.close();
}
fs.writeFileSync(path.join(OUT, 'resultado-bloqueio.json'), JSON.stringify({ geradoEm: new Date().toISOString(), dadosSinteticos: true, resultados }, null, 2));
const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram · evidências em ${OUT}`);
process.exit(falhas.length ? 1 : 0);
