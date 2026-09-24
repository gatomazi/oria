#!/usr/bin/env node
// Regressão da consistência matriz × lista (Clientes), com Playwright, contra um painel LOCAL com dados de teste.
//
//   SMOKE_BASE_URL=http://localhost:8080 SMOKE_EMAIL=… SMOKE_PASSWORD=… \
//   PLAYWRIGHT_MODULE=/caminho/para/node_modules/playwright-core \
//   node scripts/clientes/smoke-lista.mjs [--out ./evidencias-lista]
//
// Invariante testada em INSTANTES AMOSTRADOS (a cada ~60 ms durante a troca de filtros): com um chip de segmento ativo, a
// lista NUNCA mostra linha de outro segmento nem uma contagem que não seja a do segmento — no máximo um estado de
// carregamento/erro. O defeito original era a lista anterior (sem filtro) continuar na tela, com o chip novo e o total
// antigo, enquanto a resposta nova não chegava (ou falhava).
//
// Cenários: (1) resposta lenta; (2) troca rápida entre segmentos com respostas fora de ordem; (3) falha 503 e recuperação;
// (4) o cadastro da Reserva Ink lento/indisponível não bloqueia nem contamina a lista de um segmento RFM.
// Não envia mensagem, não cria campanha; só lê.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:8080';
const EMAIL = process.env.SMOKE_EMAIL;
const SENHA = process.env.SMOKE_PASSWORD;
const OUT = path.resolve(arg('out', './evidencias-lista'));
if (!EMAIL || !SENHA) throw new Error('defina SMOKE_EMAIL e SMOKE_PASSWORD (usuário de teste do painel local)');
fs.mkdirSync(OUT, { recursive: true });

const resultados = [];
const ok = (nome, cond, detalhe = '') => { resultados.push({ nome, ok: !!cond, detalhe }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
const page = await ctx.newPage();
const erros = [];
page.on('pageerror', (e) => erros.push(String(e)));

try {
  const login = await ctx.request.post(`${BASE}/api/admin/login`, { data: { email: EMAIL, password: SENHA } });
  if (!login.ok()) throw new Error(`login falhou: HTTP ${login.status()}`);

  // Verdade independente: o servidor, sem passar pela tela.
  const lista = async (q) => (await (await ctx.request.get(`${BASE}/api/admin/clientes/lista?per_page=100&${q}`)).json());
  const verdade = {};
  for (const seg of ['novos', 'campeoes', 'leais', 'hibernando', 'em_risco']) verdade[seg] = (await lista(`tipo=com_pedido&segmento=${seg}`)).total;
  const resumo = await (await ctx.request.get(`${BASE}/api/admin/clientes/resumo`)).json();
  const rot = Object.fromEntries(resumo.rfm.segmentos.map((s) => [s.id, s.nome]));
  const semFiltro = (await lista('tipo=com_pedido')).total;
  console.log(`INFO  verdade do servidor: ${JSON.stringify({ semFiltro, ...verdade })}`);
  ok('universo: pessoas com pedido = compradores classificados + sem compra válida', semFiltro === resumo.rfm.universo + resumo.rfm.identidadesSemCompraValida, `${semFiltro} = ${resumo.rfm.universo} + ${resumo.rfm.identidadesSemCompraValida}`);

  // Estado visível da lista agora (só DOM, sem depender de marcação nova).
  const ler = () => page.evaluate(() => {
    const meta = document.querySelector('#clientes-lista .ds-toolbar__meta')?.textContent || '';
    const total = Number((meta.match(/([\d.]+)\s+cliente/) || [])[1]?.replace(/\./g, '')) || null;
    const linhas = [...document.querySelectorAll('#clientes-lista table[aria-label="Clientes"] tbody tr')].map((tr) => (tr.children[1]?.innerText || '').split('\n')[0].trim());
    const chips = [...document.querySelectorAll('#clientes-lista .cli-chip--remover')].map((c) => c.innerText.replace(/\s*×\s*$/, '').trim());
    const erro = !!document.querySelector('#clientes-lista [role="alert"]');
    return { total, linhas, chips, erro, url: location.search };
  });
  // Violação = chip de segmento ativo E (linha de outro segmento OU total diferente do total do segmento).
  const violacao = (estado, seg) => {
    if (!estado.chips.some((c) => c === `Segmento: ${rot[seg]}`)) return null; // chip ainda não é o desta etapa
    const estrangeiras = estado.linhas.filter((l) => l !== rot[seg]);
    if (estrangeiras.length) return `linhas de outro segmento: ${[...new Set(estrangeiras)].join(', ')}`;
    if (estado.linhas.length && estado.total !== verdade[seg]) return `total ${estado.total} ≠ ${verdade[seg]} do segmento`;
    return null;
  };
  const amostrar = async (seg, ms) => {
    const viol = [];
    const fim = Date.now() + ms;
    while (Date.now() < fim) { const v = violacao(await ler(), seg); if (v) viol.push(v); await dorme(60); }
    return [...new Set(viol)];
  };

  await page.goto(`${BASE}/admin/clientes`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#clientes-lista table[aria-label="Clientes"] tbody tr');

  // ── Cenário 1: resposta lenta (2,5 s) ao aplicar o chip ────────────────────────────────────────
  await page.route('**/api/admin/clientes/lista*', async (r) => { await dorme(2500); await r.continue(); });
  await page.locator('.cli-legenda .cli-chip', { hasText: 'Novos' }).first().click();
  const v1 = await amostrar('novos', 3200);
  ok('1 · com resposta lenta, a lista antiga não fica na tela com o chip novo', v1.length === 0, v1.join(' | '));
  await page.waitForFunction((n) => (document.querySelector('#clientes-lista .ds-toolbar__meta')?.textContent || '').includes(`${n.toLocaleString('pt-BR')} cliente`), verdade.novos);
  const f1 = await ler();
  ok('1 · depois da resposta, total e linhas são os do segmento', f1.total === verdade.novos && f1.linhas.every((l) => l === rot.novos), `total ${f1.total}, ${f1.linhas.length} linhas`);
  await page.screenshot({ path: path.join(OUT, '01-resposta-lenta.png') });
  await page.unroute('**/api/admin/clientes/lista*');

  // ── Cenário 2: troca rápida, respostas FORA DE ORDEM (a 1ª resposta é a mais lenta) ────────────
  await page.locator('#clientes-lista').getByRole('button', { name: /Limpar filtros/ }).click();
  await page.waitForFunction(() => !document.querySelector('#clientes-lista .cli-chip--remover'));
  let n = 0;
  await page.route('**/api/admin/clientes/lista*', async (r) => { n += 1; await dorme(Math.max(100, 2200 - n * 500)); await r.continue(); });
  const violRapida = [];
  for (const nome of ['Hibernando', 'Campeões', 'Novos']) {
    const chip = page.locator('.cli-legenda .cli-chip', { hasText: nome }).first();
    await chip.click(); // seleciona
    await dorme(80);
    await chip.click(); // desmarca, para o segmento final ser o ÚNICO ativo
    await dorme(80);
  }
  await page.locator('.cli-legenda .cli-chip', { hasText: 'Em risco' }).first().click();
  violRapida.push(...await amostrar('em_risco', 4200));
  ok('2 · troca rápida: nunca aparece linha/total de segmento anterior', violRapida.length === 0, violRapida.join(' | '));
  const f2 = await ler();
  ok('2 · estado final = último segmento escolhido (respostas fora de ordem ignoradas)', f2.chips.join() === `Segmento: ${rot.em_risco}` && f2.total === verdade.em_risco && f2.linhas.every((l) => l === rot.em_risco), `${f2.chips.join()} · total ${f2.total}`);
  await page.unroute('**/api/admin/clientes/lista*');

  // ── Cenário 3: falha 503 e recuperação ────────────────────────────────────────────────────────
  await page.locator('#clientes-lista').getByRole('button', { name: /Limpar filtros/ }).click();
  await page.waitForFunction(() => !document.querySelector('#clientes-lista .cli-chip--remover'));
  await page.waitForSelector('#clientes-lista table[aria-label="Clientes"] tbody tr');
  let falhas = 1;
  await page.route('**/api/admin/clientes/lista*', async (r) => {
    if (falhas > 0) { falhas -= 1; await r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'serviço indisponível (simulado)' }) }); return; }
    await r.continue();
  });
  await page.locator('.cli-legenda .cli-chip', { hasText: 'Novos' }).first().click();
  await page.waitForSelector('#clientes-lista [role="alert"]');
  const f3 = await ler();
  ok('3 · falha 503: estado de erro verdadeiro, sem linhas antigas nem total antigo', f3.erro && f3.linhas.length === 0 && f3.total == null, `erro ${f3.erro}, linhas ${f3.linhas.length}, total ${f3.total}`);
  await page.screenshot({ path: path.join(OUT, '02-falha-503.png') });
  const tentar = page.locator('#clientes-lista').getByRole('button', { name: 'Tentar novamente' });
  ok('3 · o estado de erro oferece "Tentar novamente"', await tentar.count() === 1);
  if (await tentar.count()) await tentar.click();
  else { // sem botão de nova tentativa: recupera pelo caminho que o usuário teria (trocar o filtro e voltar)
    await page.locator('.cli-legenda .cli-chip', { hasText: 'Novos' }).first().click();
    await page.locator('.cli-legenda .cli-chip', { hasText: 'Novos' }).first().click();
  }
  await page.waitForFunction((t) => (document.querySelector('#clientes-lista .ds-toolbar__meta')?.textContent || '').includes(`${t.toLocaleString('pt-BR')} cliente`), verdade.novos);
  const f3b = await ler();
  ok('3 · recuperação: volta ao segmento certo, com total e linhas coerentes', !f3b.erro && f3b.total === verdade.novos && f3b.linhas.every((l) => l === rot.novos), `total ${f3b.total}`);
  await page.unroute('**/api/admin/clientes/lista*');

  // ── Cenário 4: cadastro da Ink indisponível não contamina segmento RFM ─────────────────────────
  const semChip = await lista('tipo=todos');
  ok('4 · sem filtro de segmento, a falha do cadastro é declarada (`cadastro.disponivel=false`) e os pedidos locais continuam', semChip.cadastro.disponivel === false && semChip.total === semFiltro, `cadastro ${JSON.stringify(semChip.cadastro)}`);
  const comChip = await lista('tipo=todos&segmento=novos');
  ok('4 · com segmento RFM, o cadastro da Ink nem é consultado e o total é o do segmento', comChip.total === verdade.novos && comChip.cadastro.incluido === false && comChip.cadastro.disponivel === true, JSON.stringify(comChip.cadastro));
  ok('4 · nenhuma linha estranha ao segmento vem na resposta', comChip.clientes.every((c) => c.segmento === 'novos'));
  ok('4 · a lista carrega a data e a versão da classificação (mesma da matriz)', comChip.rfm && comChip.rfm.regraVersao === resumo.rfm.regraVersao, JSON.stringify(comChip.rfm));

  ok('sem erro de JavaScript na sessão', erros.length === 0, erros.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ geradoEm: new Date().toISOString(), resultados }, null, 2));
const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram · evidências em ${OUT}`);
process.exit(falhas.length ? 1 : 0);
