'use strict';

// RFM próprio, explicável e reprodutível. Função PURA: recebe clientes com seus pedidos e devolve a classificação;
// não lê banco, relógio nem rede (`asOf` entra por parâmetro). Nada aqui reproduz a lógica fechada de outro painel.
//
// Definições (algoritmo `rfm-v1`)
//   Universo   só quem tem ≥1 compra VÁLIDA até `asOf`. Lead sem compra não entra (nunca é forçado num segmento
//              de recompra) — quem chama conta esse público à parte.
//   Pedido válido  pagamento em {paid, succeeded, free}, não é troca, tem data e valor. Cancelado, expirado,
//              reembolsado por inteiro, pendente e troca ficam de fora. Reembolso PARCIAL não existe no cache de
//              pedidos (só o status final): fica fora do cálculo e é declarado como lacuna, não estimado.
//   R  dias corridos entre a última compra válida e `asOf`, contados em dias do calendário no fuso da Organization.
//   F  nº de pedidos válidos na janela de frequência (padrão 365 dias). A frequência de toda a vida sai à parte.
//   M  valor pago (`total_value`, já líquido de desconto) somado na mesma janela. LTV = a mesma soma, sem janela.
//
// Segmentação por REGRAS explícitas (não por quantis de pontuação): numa base de baixa recompra, quase todo mundo
// tem F=1, e quantil de F/M colocaria quem comprou uma vez na mesma classe de quem comprou dez. A recência usa
// faixas em dias; a única fronteira derivada da base é "valor alto" (P75 do M entre quem tem M>0). Cada segmento
// é um predicado numérico (R, F e M em faixas) — por isso vira filtro de campanha sem depender do rótulo.
// Mutuamente exclusivos e exaustivos: a primeira regra da tabela que casa vence, e a tabela cobre todo (R, F, M).
//
// Base pequena ou histórico curto NÃO recebe categoria: `Dados insuficientes` no lugar de um rótulo enganoso.

const crypto = require('node:crypto');

// Versão do ALGORITMO (estrutura das regras). A versão da REGRA (`regraVersao`) = algoritmo + hash de toda a
// configuração efetiva e da tabela de regras: mudou um limiar, mudou a versão. É ela que os snapshots e os segmentos
// salvos registram, para uma contagem antiga poder ser reproduzida com exatamente a regra que a gerou.
const VERSAO_ALGORITMO = 'rfm-v1';
const STATUS_VALIDOS = Object.freeze(new Set(['paid', 'succeeded', 'free']));
const FUSO_PADRAO = 'America/Sao_Paulo';
const MS_DIA = 86400000;

const PADROES = Object.freeze({
  janelaFrequenciaDias: 365,
  // Fronteiras superiores (inclusivas) das faixas de recência, em dias: T1 ≤45, T2 46–90, T3 91–180, T4 181–365,
  // T5 >365. São padrões a validar contra a distribuição real — configuráveis, nunca escondidos.
  limitesRecenciaDias: Object.freeze([45, 90, 180, 365]),
  minClientes: 30,
  minHistoricoDias: 90,
  percentilValorAlto: 0.75,
  // O que "valor alto" mede: 'ltv_janela' = soma paga na janela (padrão histórico do rfm-v1) ou 'ticket_medio' = valor
  // médio por pedido na janela. Alternativa documentada (docs/features/oria-clientes-rfm-fase0.md): a soma mistura
  // frequência com valor e coloca quem comprou 3× quase sempre acima do corte de uma base de 1 compra.
  valorAltoMetrica: 'ltv_janela',
});
const METRICAS_VALOR = Object.freeze(['ltv_janela', 'ticket_medio']);

// Configuração efetiva e validada: o ÚNICO lugar onde os limiares são lidos. `opcoes` sobrescreve os padrões.
function configuracaoEfetiva(opcoes = {}) {
  const c = {
    janelaFrequenciaDias: opcoes.janelaFrequenciaDias ?? PADROES.janelaFrequenciaDias,
    limitesRecenciaDias: [...(opcoes.limitesRecenciaDias ?? PADROES.limitesRecenciaDias)],
    minClientes: opcoes.minClientes ?? PADROES.minClientes,
    minHistoricoDias: opcoes.minHistoricoDias ?? PADROES.minHistoricoDias,
    percentilValorAlto: opcoes.percentilValorAlto ?? PADROES.percentilValorAlto,
    valorAltoMetrica: opcoes.valorAltoMetrica ?? PADROES.valorAltoMetrica,
  };
  const l = c.limitesRecenciaDias;
  if (l.length !== 4 || l.some((x, i) => !Number.isInteger(x) || x < 1 || (i > 0 && x <= l[i - 1]))) {
    throw new Error('rfm: limites de recência devem ser 4 inteiros estritamente crescentes');
  }
  if (!Number.isInteger(c.janelaFrequenciaDias) || c.janelaFrequenciaDias < 1 || c.janelaFrequenciaDias > 3650) throw new Error('rfm: janela de frequência inválida');
  if (!Number.isInteger(c.minClientes) || c.minClientes < 0 || !Number.isInteger(c.minHistoricoDias) || c.minHistoricoDias < 0) throw new Error('rfm: mínimos inválidos');
  if (!(c.percentilValorAlto > 0 && c.percentilValorAlto < 1)) throw new Error('rfm: percentil de valor alto deve estar entre 0 e 1');
  if (!METRICAS_VALOR.includes(c.valorAltoMetrica)) throw new Error('rfm: métrica de valor alto desconhecida');
  return Object.freeze(c);
}

// Hash curto e estável da regra. Independe da ordem das chaves e não inclui dado de cliente.
function regraVersao(config) {
  const canonico = JSON.stringify({
    algoritmo: VERSAO_ALGORITMO,
    config: {
      janelaFrequenciaDias: config.janelaFrequenciaDias, limitesRecenciaDias: config.limitesRecenciaDias, minClientes: config.minClientes,
      minHistoricoDias: config.minHistoricoDias, percentilValorAlto: config.percentilValorAlto, valorAltoMetrica: config.valorAltoMetrica,
    },
    regras: REGRAS.map((r) => [r.id, r.tiers, r.f, r.mAlto]),
  });
  return `${VERSAO_ALGORITMO}:${crypto.createHash('sha256').update(canonico).digest('hex').slice(0, 8)}`;
}

const SEGMENTO_INSUFICIENTE = Object.freeze({ id: 'dados_insuficientes', nome: 'Dados insuficientes' });

// Ordem = precedência. `tiers` são faixas de recência; `f` faixa de frequência; `mAlto` true/false/null (indiferente).
const REGRAS = Object.freeze([
  { id: 'campeoes', nome: 'Campeões', tiers: [1, 2], f: { min: 3 }, mAlto: true,
    descricao: 'Compraram 3+ vezes, recentemente e com valor alto.',
    hipotese: 'Reconhecimento e acesso antecipado; pedir indicação.' },
  { id: 'leais', nome: 'Leais', tiers: [1, 2], f: { min: 3 }, mAlto: false,
    descricao: 'Compraram 3+ vezes, recentemente, com valor abaixo do alto.',
    hipotese: 'Reforçar frequência com novidades e cross-sell.' },
  { id: 'potenciais_leais', nome: 'Potenciais leais', tiers: [1, 2], f: { min: 2, max: 2 }, mAlto: null,
    descricao: 'Segunda compra feita, recentemente.',
    hipotese: 'Levar à terceira compra com incentivo de recorrência.' },
  { id: 'primeira_alto_valor', nome: 'Primeira compra de alto valor', tiers: [1], f: { min: 1, max: 1 }, mAlto: true,
    descricao: 'Uma compra recente, com valor alto.',
    hipotese: 'Onboarding cuidadoso e convite à segunda compra.' },
  { id: 'novos', nome: 'Novos', tiers: [1], f: { min: 1, max: 1 }, mAlto: false,
    descricao: 'Uma compra recente, com valor abaixo do alto.',
    hipotese: 'Campanha de segunda compra.' },
  { id: 'aguardando_recompra', nome: 'Aguardando recompra', tiers: [2], f: { min: 1, max: 1 }, mAlto: null,
    descricao: 'Uma única compra, feita entre 46 e 90 dias.',
    hipotese: 'Janela de segunda compra; lembrete com produto complementar.' },
  { id: 'precisam_atencao', nome: 'Precisam de atenção', tiers: [3], f: { min: 2 }, mAlto: null,
    descricao: 'Recorrentes que passaram de 90 dias sem comprar.',
    hipotese: 'Retenção antes que virem risco.' },
  { id: 'prestes_a_dormir', nome: 'Prestes a dormir', tiers: [3], f: { min: 1, max: 1 }, mAlto: null,
    descricao: 'Uma compra, entre 91 e 180 dias atrás.',
    hipotese: 'Reativação leve.' },
  { id: 'em_risco', nome: 'Em risco', tiers: [4], f: { min: 2 }, mAlto: null,
    descricao: 'Recorrentes sem comprar há 181–365 dias.',
    hipotese: 'Reativação com oferta; prioridade se o LTV for alto.' },
  { id: 'hibernando', nome: 'Hibernando', tiers: [4], f: { min: 1, max: 1 }, mAlto: null,
    descricao: 'Uma compra, há 181–365 dias.',
    hipotese: 'Reativação de menor custo.' },
  { id: 'perdidos', nome: 'Perdidos', tiers: [5], f: null, mAlto: null,
    descricao: 'Sem compra há mais de 365 dias.',
    hipotese: 'Reativação só com custo baixo; não priorizar.' },
]);

function centavos(v) {
  return Math.round(v * 100) / 100;
}

// Somas em centavos INTEIROS: soma de float depende da ordem das parcelas e faria o mesmo conjunto de pedidos render
// resultados diferentes (na 15ª casa) conforme a ordem de leitura. Inteiro é exato e comutativo.
const emCentavos = (v) => Math.round(Number(v) * 100);
const somaCentavos = (itens, f) => itens.reduce((acc, x) => acc + emCentavos(f(x)), 0) / 100;

const formatadores = new Map();
function diaLocal(data, fuso) {
  if (!formatadores.has(fuso)) {
    formatadores.set(fuso, new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  const [a, m, d] = formatadores.get(fuso).format(data).split('-').map(Number);
  return Date.UTC(a, m - 1, d);
}

// Dias de calendário entre duas datas no fuso (mesmo dia = 0). Nunca negativo.
function diasDeCalendario(de, ate, fuso) {
  return Math.max(0, Math.round((diaLocal(ate, fuso) - diaLocal(de, fuso)) / MS_DIA));
}

function pedidoValido(p) {
  if (!p || !STATUS_VALIDOS.has(p.paymentStatus) || p.isTroca) return false;
  // `new Date(null)` é 1970 (válido para o JS): sem data de verdade o pedido não conta.
  if (p.criadoEm == null || p.criadoEm === '' || p.valor == null || p.valor === '') return false;
  const t = p.criadoEm instanceof Date ? p.criadoEm.getTime() : new Date(p.criadoEm).getTime();
  return Number.isFinite(t) && Number.isFinite(Number(p.valor)) && Number(p.valor) >= 0;
}

// Percentil por posição (nearest-rank) sobre valores ORDENADOS: determinístico, sem interpolação.
function percentil(ordenados, p) {
  if (!ordenados.length) return null;
  const i = Math.min(ordenados.length - 1, Math.max(0, Math.ceil(p * ordenados.length) - 1));
  return ordenados[i];
}

// Pontuação 1–5 por cortes de quantil. Valores iguais sempre caem na mesma nota (o desempate é o próprio valor,
// nunca a ordem de entrada), então a saída não depende da ordem dos clientes. Cortes repetidos apenas colapsam notas.
function cortesQuintis(valores) {
  const ordenados = [...valores].sort((a, b) => a - b);
  return [0.2, 0.4, 0.6, 0.8].map((p) => percentil(ordenados, p));
}

// Mediana simples (média dos dois centrais em quantidade par); null em conjunto vazio.
function mediana(valores) {
  if (!valores.length) return null;
  const o = [...valores].sort((a, b) => a - b);
  const meio = o.length >> 1;
  return o.length % 2 ? o[meio] : (o[meio - 1] + o[meio]) / 2;
}

function faixaDeTier(tier, limites) {
  const inferior = tier === 1 ? 0 : limites[tier - 2] + 1;
  const superior = tier === 5 ? null : limites[tier - 1];
  return { min: inferior, max: superior };
}

// Predicado numérico da regra: recência em dias, frequência e valor. `valorAlto` é a fronteira P75 da base.
function predicadoDaRegra(regra, limites, valorAlto, metrica = 'ltv_janela') {
  const primeira = faixaDeTier(regra.tiers[0], limites);
  const ultima = faixaDeTier(regra.tiers[regra.tiers.length - 1], limites);
  const predicado = {
    recenciaDias: { min: primeira.min, max: ultima.max },
    frequencia: regra.f ? { min: regra.f.min ?? null, max: regra.f.max ?? null } : null,
    valor: null,
  };
  if (regra.mAlto === true) predicado.valor = { metrica, min: valorAlto, maxExclusivo: null };
  if (regra.mAlto === false) predicado.valor = { metrica, min: null, maxExclusivo: valorAlto };
  return predicado;
}

function casaPredicado(predicado, r, f, m) {
  if (r < predicado.recenciaDias.min) return false;
  if (predicado.recenciaDias.max != null && r > predicado.recenciaDias.max) return false;
  if (predicado.frequencia) {
    if (predicado.frequencia.min != null && f < predicado.frequencia.min) return false;
    if (predicado.frequencia.max != null && f > predicado.frequencia.max) return false;
  }
  if (predicado.valor) {
    if (predicado.valor.min != null && m < predicado.valor.min) return false;
    if (predicado.valor.maxExclusivo != null && m >= predicado.valor.maxExclusivo) return false;
  }
  return true;
}

// `clientes`: [{ id, pedidos: [{ criadoEm, valor, paymentStatus, isTroca }] }].
// Devolve `clientes` (mesma ordem da entrada, só quem tem compra válida) e o resumo por segmento.
function classificarRfm(clientes, opcoes = {}) {
  const asOf = opcoes.asOf instanceof Date ? opcoes.asOf : new Date(opcoes.asOf);
  if (!Number.isFinite(asOf.getTime())) throw new Error('rfm: `asOf` inválido');
  const fuso = opcoes.fuso || FUSO_PADRAO;
  const config = configuracaoEfetiva(opcoes);
  const { janelaFrequenciaDias: janela, limitesRecenciaDias: limites, minClientes, minHistoricoDias: minHistorico, percentilValorAlto: percentilAlto, valorAltoMetrica } = config;
  const limiteMs = asOf.getTime();

  // O dia de calendário de `asOf` é o mesmo para todos: calculado uma vez. O de cada compra também (uma vez por compra, e não
  // uma vez por uso): formatar datas com Intl era o custo dominante da classificação em massas grandes.
  const diaAsOf = diaLocal(asOf, fuso);
  const diasAte = (dia) => Math.max(0, Math.round((diaAsOf - dia) / MS_DIA));

  const base = [];
  let primeiroPedido = null;
  let leadsSemCompraValida = 0;
  for (const cliente of clientes) {
    const validos = (cliente.pedidos || [])
      .filter(pedidoValido)
      .map((p) => ({ t: new Date(p.criadoEm).getTime(), valor: Number(p.valor) }))
      .filter((p) => p.t <= limiteMs);
    if (!validos.length) { leadsSemCompraValida += 1; continue; }
    let ultima = validos[0].t;
    let primeira = validos[0].t;
    for (const p of validos) { p.dia = diaLocal(new Date(p.t), fuso); if (p.t > ultima) ultima = p.t; if (p.t < primeira) primeira = p.t; }
    if (primeiroPedido == null || primeira < primeiroPedido) primeiroPedido = primeira;

    const r = diasAte(diaLocal(new Date(ultima), fuso));
    // Janela em dias de calendário: a compra de N dias atrás ainda conta em N ≤ janela.
    const naJanela = validos.filter((p) => diasAte(p.dia) <= janela);
    const fJanela = naJanela.length;
    const m = somaCentavos(naJanela, (p) => p.valor);
    const ltv = somaCentavos(validos, (p) => p.valor);
    base.push({
      id: cliente.id, r, fJanela, fVida: validos.length, m, ltv,
      // Valor de referência do corte "alto": soma da janela ou ticket médio da janela (a métrica é configurável).
      v: valorAltoMetrica === 'ticket_medio' ? (fJanela ? centavos(m / fJanela) : 0) : m,
      primeiraCompraEm: new Date(primeira).toISOString(), ultimaCompraEm: new Date(ultima).toISOString(),
    });
  }

  const historicoObservadoDias = primeiroPedido == null ? 0 : diasDeCalendario(new Date(primeiroPedido), asOf, fuso);
  const universo = base.length;
  let motivoInsuficiencia = null;
  if (universo < minClientes) motivoInsuficiencia = `base pequena: ${universo} cliente(s) com compra, mínimo ${minClientes}`;
  else if (historicoObservadoDias < minHistorico) motivoInsuficiencia = `histórico curto: ${historicoObservadoDias} dia(s) observados, mínimo ${minHistorico}`;
  // `amostraSuficiente` é um critério ESTATÍSTICO mínimo para classificar (≥ minClientes compradores e ≥ minHistoricoDias de
  // histórico observado). NÃO afirma que o histórico é completo: isso é `cobertura` (lib/clientes/cobertura.js), que exige
  // backfill confirmado. Uma loja pode ter amostra suficiente com só 260 dias observados e nenhum backfill.
  const amostraSuficiente = motivoInsuficiencia == null;

  const mPositivos = base.map((c) => c.v).filter((v) => v > 0).sort((a, b) => a - b);
  const valorAlto = amostraSuficiente && mPositivos.length ? percentil(mPositivos, percentilAlto) : null;
  const cortesR = amostraSuficiente ? cortesQuintis(base.map((c) => c.r)) : null;
  const cortesM = amostraSuficiente ? cortesQuintis(base.map((c) => c.m)) : null;

  // Sem nenhum valor positivo na base, ninguém é "valor alto" (a fronteira fica inalcançável, e continua serializável).
  const fronteiraValor = valorAlto ?? Number.MAX_SAFE_INTEGER;
  const regras = REGRAS.map((regra) => ({ regra, predicado: predicadoDaRegra(regra, limites, fronteiraValor, valorAltoMetrica) }));
  const limiteSuperior = limites[limites.length - 1];

  const classificados = base.map((c) => {
    // Quem comprou dentro da faixa "não perdido" tem ao menos 1 pedido na janela; se a janela for menor que o
    // limite de "perdido", força F≥1 para a regra não ver F=0 num cliente que ainda não é Perdido.
    const f = c.r <= limiteSuperior ? Math.max(1, c.fJanela) : c.fJanela;
    let segmento = SEGMENTO_INSUFICIENTE;
    let escore = null;
    if (amostraSuficiente) {
      const achado = regras.find(({ predicado }) => casaPredicado(predicado, c.r, f, c.v));
      segmento = achado ? { id: achado.regra.id, nome: achado.regra.nome } : SEGMENTO_INSUFICIENTE;
      escore = {
        r: 5 - cortesR.filter((corte) => c.r > corte).length,
        f: Math.min(5, f),
        m: 1 + cortesM.filter((corte) => c.m > corte).length,
      };
    }
    return { ...c, f, segmento, escore };
  });

  const janelaAbrangeHistoricoObservado = historicoObservadoDias <= janela;
  const totalReceita = somaCentavos(classificados, (c) => c.ltv);
  const ordemDosSegmentos = amostraSuficiente ? regras.map(({ regra }) => regra.id) : [SEGMENTO_INSUFICIENTE.id];
  const porSegmento = new Map(ordemDosSegmentos.map((id) => [id, []]));
  for (const c of classificados) porSegmento.get(c.segmento.id).push(c);

  const segmentos = ordemDosSegmentos.map((id) => {
    const membros = porSegmento.get(id);
    const definicao = regras.find(({ regra }) => regra.id === id);
    const pedidos = membros.reduce((acc, c) => acc + c.fVida, 0);
    const receita = somaCentavos(membros, (c) => c.ltv);
    return {
      id,
      nome: definicao ? definicao.regra.nome : SEGMENTO_INSUFICIENTE.nome,
      descricao: definicao ? definicao.regra.descricao : motivoInsuficiencia,
      hipotese: definicao ? definicao.regra.hipotese : null,
      predicado: definicao ? definicao.predicado : null,
      clientes: membros.length,
      pctBase: universo ? membros.length / universo : 0,
      pedidos,
      pedidosPorCliente: membros.length ? pedidos / membros.length : 0,
      ticketMedio: pedidos ? centavos(receita / pedidos) : null,
      receita,
      pctReceita: totalReceita ? receita / totalReceita : 0,
      recenciaMediaDias: membros.length ? Math.round(membros.reduce((acc, c) => acc + c.r, 0) / membros.length) : null,
      recenciaMedianaDias: mediana(membros.map((c) => c.r)),
      frequenciaMediana: mediana(membros.map((c) => c.fVida)),
    };
  });

  return {
    versao: VERSAO_ALGORITMO,
    regraVersao: regraVersao(config),
    configuracao: config,
    asOf: asOf.toISOString(),
    fuso,
    janelaFrequenciaDias: janela,
    limitesRecenciaDias: [...limites],
    valorAltoMetrica,
    valorAlto,
    amostraSuficiente,
    motivoInsuficiencia,
    universo,
    leadsSemCompraValida,
    historicoObservadoDias,
    primeiroPedidoEm: primeiroPedido == null ? null : new Date(primeiroPedido).toISOString(),
    // Com a janela cobrindo todo o histórico observado, F/M da janela = frequência/LTV de toda a vida, e o
    // predicado vira filtro de campanha EXATO; senão ele é aproximado (o filtro de audiência não tem janela).
    janelaAbrangeHistoricoObservado,
    clientes: classificados,
    segmentos,
  };
}

module.exports = {
  classificarRfm, pedidoValido, diasDeCalendario, casaPredicado, predicadoDaRegra, percentil, mediana, configuracaoEfetiva, regraVersao,
  METRICAS_VALOR, VERSAO_ALGORITMO, REGRAS, PADROES, SEGMENTO_INSUFICIENTE, STATUS_VALIDOS,
};
