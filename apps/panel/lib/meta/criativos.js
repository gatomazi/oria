'use strict';

// Criativos (docs/meta-ads-analytics-integracao-v2.md §13, §48-50). Duas regras de negócio moram
// aqui, fora do server.js, porque são exatamente o tipo de coisa que precisa de teste: classificar
// o formato de um criativo a partir de um payload irregular, e julgar eficiência a partir de metas.

const { metricas, parseNumero } = require('./actions');

// Formatos que a tela oferece como filtro (spec §48). "outro" NÃO é uma categoria de descarte: é a
// resposta honesta quando o payload não permite afirmar o formato. A spec é explícita em preferir
// isso a chutar.
const FORMATOS = ['imagem', 'video', 'carrossel', 'dinamico', 'outro'];

// A Meta não devolve um campo "tipo de criativo". O formato tem que ser deduzido da forma do
// object_story_spec / asset_feed_spec, e as duas mudam conforme a origem do anúncio (criado no Ads
// Manager, por API, impulsionado a partir de um post, Advantage+...). A ordem abaixo importa:
// vai do sinal mais específico para o mais genérico.
//
// `insights` entra como desempate porque é evidência de comportamento, não de estrutura: um
// criativo que registrou reprodução de vídeo é vídeo, qualquer que seja o formato do spec.
function classificarCriativo(criativo, insights) {
  const story = (criativo && criativo.object_story_spec) || null;
  const feed = (criativo && criativo.asset_feed_spec) || null;

  // Advantage+/Dynamic Creative: a Meta monta combinações a partir de vários ativos. É o sinal mais
  // forte e vem primeiro — um dinâmico costuma TAMBÉM ter video_data ou link_data, e classificá-lo
  // como vídeo esconderia justamente o que ele tem de diferente (spec §13).
  if (feed && (temItens(feed.videos) || temItens(feed.images) || temItens(feed.asset_customization_rules))) {
    return 'dinamico';
  }

  const link = story && story.link_data;
  // Carrossel = várias peças filhas dentro do mesmo anúncio.
  if (link && temItens(link.child_attachments)) return 'carrossel';

  if (story && story.video_data) return 'video';
  if (link && (link.image_hash || link.picture || link.image_crops)) return 'imagem';

  // Post impulsionado e outros casos onde o spec vem vazio: sobra o comportamento medido.
  const plays = insights ? parseNumero(insights.videoPlays) : null;
  if (plays !== null && plays > 0) return 'video';

  // thumbnail sozinha não decide nada: vídeo também tem thumbnail. Sem sinal, "outro" é a resposta
  // correta — e a tela mostra isso como formato, não como erro.
  return 'outro';
}

function temItens(v) {
  return Array.isArray(v) && v.length > 0;
}

// ── Metas e sinalização analítica (spec §49, §50) ───────────────────────────────────────────
// A V1 NÃO automatiza decisão de mídia. A spec proíbe explicitamente escrever "PAUSAR"/"ESCALAR"
// como veredito; o que se oferece é uma leitura com o motivo à vista, para a pessoa decidir.

const METAS_PADRAO = {
  cpaAlvo: null,
  roasAlvo: null,
  ctrMinimo: null,
  gastoMinimo: null,
};

// Sem gasto suficiente, nenhum julgamento se sustenta: 1 compra em R$ 30 vira "ROAS 4x" e some no
// dia seguinte. `gastoMinimo` é o que separa sinal de ruído, e por isso é uma meta como as outras.
const SINAL = {
  ESCALA: 'candidato_escala',
  MONITORAR: 'monitorar',
  BAIXA: 'baixa_eficiencia',
  SEM_BASE: 'sem_base',
};

// Devolve o sinal E os motivos que o produziram. Mostrar o motivo é o que diferencia uma leitura
// analítica de um palpite do sistema (spec §49) — e é o que permite discordar dela.
function avaliarCriativo(m, metasBrutas) {
  const metas = { ...METAS_PADRAO, ...(metasBrutas || {}) };
  const gasto = parseNumero(m && m.spend) || 0;
  const roas = m ? m.roas : null;
  const cpa = m ? m.cpa : null;
  const ctr = m ? m.ctr : null;

  const gastoMinimo = parseNumero(metas.gastoMinimo);
  if (gastoMinimo !== null && gasto < gastoMinimo) {
    return { sinal: SINAL.SEM_BASE, motivos: [`gasto abaixo de ${gastoMinimo} no período`] };
  }
  // Nenhuma meta definida = nenhum julgamento. A tela mostra as métricas e cala sobre eficiência,
  // em vez de inventar um limiar "razoável" no lugar do usuário (spec §50).
  const temMeta = [metas.cpaAlvo, metas.roasAlvo, metas.ctrMinimo].some((x) => parseNumero(x) !== null);
  if (!temMeta) return { sinal: null, motivos: [] };

  // As metas são separadas em dois grupos porque não têm o mesmo peso. ROAS e CPA medem RESULTADO;
  // CTR mede meio do caminho. Um criativo que gastou e não vendeu nada não deixa de ser ineficiente
  // porque as pessoas clicaram — na primeira versão, um criativo com R$ 1.435 de gasto e zero venda
  // saía como "Monitorar" só por passar no CTR, ao lado de outro com ROAS 2,33. Clique nenhum
  // redime venda zero.
  const conversaoBons = [];
  const conversaoRuins = [];
  const apoioBons = [];
  const apoioRuins = [];

  const roasAlvo = parseNumero(metas.roasAlvo);
  if (roasAlvo !== null) {
    if (roas === null) conversaoRuins.push('sem ROAS calculável (nenhuma compra atribuída)');
    else if (roas >= roasAlvo) conversaoBons.push(`ROAS ${fmt(roas)} igual ou acima da meta ${fmt(roasAlvo)}`);
    else conversaoRuins.push(`ROAS ${fmt(roas)} abaixo da meta ${fmt(roasAlvo)}`);
  }

  const cpaAlvo = parseNumero(metas.cpaAlvo);
  if (cpaAlvo !== null) {
    if (cpa === null) conversaoRuins.push('sem CPA calculável (nenhuma compra atribuída)');
    else if (cpa <= cpaAlvo) conversaoBons.push(`CPA ${fmt(cpa)} igual ou abaixo da meta ${fmt(cpaAlvo)}`);
    else conversaoRuins.push(`CPA ${fmt(cpa)} acima da meta ${fmt(cpaAlvo)}`);
  }

  const ctrMinimo = parseNumero(metas.ctrMinimo);
  if (ctrMinimo !== null) {
    if (ctr === null) apoioRuins.push('sem CTR calculável');
    else if (ctr >= ctrMinimo) apoioBons.push(`CTR ${fmt(ctr)}% igual ou acima do mínimo ${fmt(ctrMinimo)}%`);
    else apoioRuins.push(`CTR ${fmt(ctr)}% abaixo do mínimo ${fmt(ctrMinimo)}%`);
  }

  const ruins = [...conversaoRuins, ...apoioRuins];
  const bons = [...conversaoBons, ...apoioBons];

  // Só é candidato a escala quem passa em TUDO que foi definido. Basta uma meta não batida para
  // sair da recomendação — o erro caro aqui é sugerir escalar algo que só parece bom numa métrica.
  if (ruins.length === 0) return { sinal: SINAL.ESCALA, motivos: bons };

  // Falhou em TODA meta de resultado definida: é baixa eficiência, mesmo que o CTR passe. O CTR
  // aparece nos motivos assim mesmo, porque é a informação que diz onde está o problema — atrai
  // clique e não converte é um diagnóstico diferente de nem atrair clique.
  const temMetaConversao = conversaoBons.length + conversaoRuins.length > 0;
  if (temMetaConversao && conversaoBons.length === 0) return { sinal: SINAL.BAIXA, motivos: [...conversaoRuins, ...apoioBons, ...apoioRuins] };

  if (bons.length === 0) return { sinal: SINAL.BAIXA, motivos: ruins };
  return { sinal: SINAL.MONITORAR, motivos: [...ruins, ...bons] };
}

function fmt(n) {
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

// Taxa de retenção de vídeo: de quem começou a assistir, quantos chegaram a cada marco. Usa
// videoPlays como base (não impressões) porque é a pergunta que o criativo responde — "quem deu
// play, ficou?". null quando não houve play: um anúncio de imagem não tem retenção 0%, não tem
// retenção nenhuma (spec §20).
function retencaoVideo(m) {
  const base = parseNumero(m && m.videoPlays);
  if (base === null || base === 0) return null;
  const marco = (v) => {
    const n = parseNumero(v);
    return n === null ? null : metricas.ctr(n, base); // mesma conta de "parte sobre o todo", em %
  };
  return {
    p25: marco(m.video25),
    p50: marco(m.video50),
    p75: marco(m.video75),
    p95: marco(m.video95),
    p100: marco(m.video100),
    thruplay: marco(m.videoThruplays),
  };
}

module.exports = {
  FORMATOS,
  METAS_PADRAO,
  SINAL,
  classificarCriativo,
  avaliarCriativo,
  retencaoVideo,
};
