'use strict';

// Testes da Fase 4 (docs/meta-ads-analytics-integracao-v2.md §48-50). Duas regras com risco real:
// classificar formato a partir de payload irregular, e julgar eficiência sem inventar limiar.

const test = require('node:test');
const assert = require('node:assert/strict');

const { classificarCriativo, avaliarCriativo, retencaoVideo, SINAL } = require('../lib/meta/criativos');

// ── Classificação de formato ────────────────────────────────────────────────────────────────

test('imagem simples é reconhecida pelo link_data', () => {
  assert.equal(classificarCriativo({ object_story_spec: { link_data: { image_hash: 'abc', link: 'x' } } }), 'imagem');
  assert.equal(classificarCriativo({ object_story_spec: { link_data: { picture: 'http://x/y.jpg' } } }), 'imagem');
});

test('vídeo é reconhecido pelo video_data', () => {
  assert.equal(classificarCriativo({ object_story_spec: { video_data: { video_id: '123' } } }), 'video');
});

test('carrossel é reconhecido pelas peças filhas', () => {
  const cr = { object_story_spec: { link_data: { image_hash: 'abc', child_attachments: [{ link: 'a' }, { link: 'b' }] } } };
  assert.equal(classificarCriativo(cr), 'carrossel', 'child_attachments vence image_hash — senão todo carrossel viraria imagem');
});

test('Advantage+/dinâmico vence vídeo e imagem', () => {
  // Caso real que derruba a ordem ingênua: um dinâmico costuma TER video_data também. Classificar
  // como vídeo esconderia justamente o que ele tem de diferente (spec §13).
  const cr = {
    asset_feed_spec: { videos: [{ video_id: '1' }, { video_id: '2' }], bodies: [{ text: 'a' }] },
    object_story_spec: { video_data: { video_id: '1' } },
  };
  assert.equal(classificarCriativo(cr), 'dinamico');
});

test('asset_feed_spec vazio não faz de um vídeo um dinâmico', () => {
  const cr = { asset_feed_spec: { videos: [] }, object_story_spec: { video_data: { video_id: '1' } } };
  assert.equal(classificarCriativo(cr), 'video');
});

test('sem sinal nenhum o formato é "outro", nunca um chute', () => {
  assert.equal(classificarCriativo({}), 'outro');
  assert.equal(classificarCriativo(null), 'outro');
  // Thumbnail sozinha não decide: vídeo também tem thumbnail.
  assert.equal(classificarCriativo({ thumbnail_url: 'http://x/t.jpg' }), 'outro');
});

test('post impulsionado sem spec cai no comportamento medido', () => {
  assert.equal(classificarCriativo({}, { videoPlays: 400 }), 'video');
  assert.equal(classificarCriativo({}, { videoPlays: 0 }), 'outro');
  assert.equal(classificarCriativo({}, { videoPlays: null }), 'outro');
});

// ── Metas e sinalização ─────────────────────────────────────────────────────────────────────

const BOM = { spend: 500, roas: 4, cpa: 30, ctr: 2 };

test('sem meta definida o sistema não julga', () => {
  const r = avaliarCriativo(BOM, {});
  assert.equal(r.sinal, null, 'inventar um limiar "razoável" no lugar do usuário é o que a spec §50 proíbe');
  assert.deepEqual(r.motivos, []);
});

test('gasto abaixo do mínimo suspende o julgamento', () => {
  const r = avaliarCriativo({ spend: 50, roas: 9, cpa: 5, ctr: 8 }, { gastoMinimo: 100, roasAlvo: 3 });
  assert.equal(r.sinal, SINAL.SEM_BASE, 'ROAS 9x com R$ 50 de gasto é ruído, não descoberta');
  assert.match(r.motivos[0], /gasto abaixo/);
});

test('candidato a escala exige passar em TODAS as metas definidas', () => {
  const metas = { roasAlvo: 3, cpaAlvo: 45, ctrMinimo: 1.5, gastoMinimo: 100 };
  assert.equal(avaliarCriativo(BOM, metas).sinal, SINAL.ESCALA);
  // Uma única meta não batida tira da recomendação — o erro caro é sugerir escalar o que só parece
  // bom numa métrica.
  assert.equal(avaliarCriativo({ ...BOM, ctr: 0.9 }, metas).sinal, SINAL.MONITORAR);
});

test('falhar em tudo é baixa eficiência; misturar é monitorar', () => {
  const metas = { roasAlvo: 3, cpaAlvo: 45, gastoMinimo: 100 };
  assert.equal(avaliarCriativo({ spend: 500, roas: 1, cpa: 90 }, metas).sinal, SINAL.BAIXA);
  assert.equal(avaliarCriativo({ spend: 500, roas: 5, cpa: 90 }, metas).sinal, SINAL.MONITORAR);
});

test('CTR bom não resgata criativo que gastou e não vendeu', () => {
  // Achado olhando a tela com dado real: um criativo com R$ 1.435 de gasto e ZERO venda saía como
  // "Monitorar" — o mesmo selo de outro com ROAS 2,33 — só porque o CTR passou. CTR é meio do
  // caminho; ROAS e CPA são resultado. Clique nenhum redime venda zero.
  const metas = { roasAlvo: 3, cpaAlvo: 45, ctrMinimo: 1.5, gastoMinimo: 1000 };
  const r = avaliarCriativo({ spend: 1435, roas: 0, cpa: null, ctr: 1.71 }, metas);
  assert.equal(r.sinal, SINAL.BAIXA);
  // O CTR continua nos motivos: "atrai clique e não converte" é um diagnóstico diferente de
  // "nem atrai clique", e a diferença importa pra decidir o que mexer.
  assert.ok(r.motivos.some((m) => /CTR/.test(m)), 'o CTR aprovado precisa continuar visível');
  assert.ok(r.motivos.some((m) => /ROAS/.test(m)));
});

test('sem meta de resultado definida, CTR volta a mandar sozinho', () => {
  // Só CTR configurado: não há resultado pra dominar, então a regra antiga vale.
  assert.equal(avaliarCriativo({ spend: 500, ctr: 3 }, { ctrMinimo: 1.5, gastoMinimo: 100 }).sinal, SINAL.ESCALA);
  assert.equal(avaliarCriativo({ spend: 500, ctr: 0.4 }, { ctrMinimo: 1.5, gastoMinimo: 100 }).sinal, SINAL.BAIXA);
});

test('métrica incalculável conta como não atingida, não como aprovada', () => {
  // Criativo que gastou e não vendeu: roas/cpa vêm null. Tratar null como "sem opinião" deixaria
  // um criativo que só queima verba passar como candidato a escala. Como as duas metas de
  // RESULTADO falharam, o CTR aprovado não segura em "monitorar" — ver o teste do CTR abaixo.
  const r = avaliarCriativo({ spend: 500, roas: null, cpa: null, ctr: 3 }, { roasAlvo: 3, cpaAlvo: 45, ctrMinimo: 1.5, gastoMinimo: 100 });
  assert.equal(r.sinal, SINAL.BAIXA);
  assert.ok(r.motivos.some((x) => /sem ROAS calculável/.test(x)));
});

test('o motivo sempre acompanha o sinal', () => {
  const r = avaliarCriativo(BOM, { roasAlvo: 3, gastoMinimo: 100 });
  assert.equal(r.sinal, SINAL.ESCALA);
  assert.ok(r.motivos.length > 0, 'sinal sem motivo vira palpite do sistema (spec §49)');
  assert.match(r.motivos[0], /ROAS/);
});

test('o limite é inclusivo — bater a meta exatamente é atingir a meta', () => {
  const metas = { roasAlvo: 3, cpaAlvo: 45, ctrMinimo: 1.5, gastoMinimo: 100 };
  assert.equal(avaliarCriativo({ spend: 100, roas: 3, cpa: 45, ctr: 1.5 }, metas).sinal, SINAL.ESCALA);
});

// ── Retenção de vídeo ───────────────────────────────────────────────────────────────────────

test('retenção é relativa a quem deu play, não a impressões', () => {
  const r = retencaoVideo({ videoPlays: 1000, video25: 500, video50: 250, video100: 100, videoThruplays: 300 });
  assert.equal(r.p25, 50);
  assert.equal(r.p50, 25);
  assert.equal(r.p100, 10);
  assert.equal(r.thruplay, 30);
});

test('anúncio sem play não tem retenção 0% — não tem retenção', () => {
  assert.equal(retencaoVideo({ videoPlays: null }), null);
  assert.equal(retencaoVideo({ videoPlays: 0 }), null);
  assert.equal(retencaoVideo({}), null);
});

test('marco que a Meta não mandou fica null dentro da retenção', () => {
  const r = retencaoVideo({ videoPlays: 1000, video25: 500 });
  assert.equal(r.p25, 50);
  assert.equal(r.p50, null);
});
