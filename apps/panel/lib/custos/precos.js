'use strict';

// Custo das APIs que o painel consome, para informar ao cliente quanto a operação gasta além da
// mídia. Duas fontes: mensagens de WhatsApp (cobradas pela Meta por mensagem, por categoria) e
// geração de criativos (cobrada pela OpenAI por token).
//
// A premissa deste arquivo é que PREÇO NÃO É DADO CONFIÁVEL. Ele muda sem aviso, varia por país,
// por volume e por acordo comercial, e a Meta sequer publica a tabela em BRL — remete a rate cards
// por moeda. Por isso nada aqui é verdade absoluta: cada preço carrega de onde veio (`fonte`) e o
// quanto vale confiar nele (`confianca`), e a tela mostra isso junto do número. Um total que parece
// exato mas foi calculado com preço chutado é pior que um total assumidamente aproximado — o
// cliente toma decisão em cima dele.
//
// O cliente pode sobrescrever qualquer linha com o valor da fatura dele. Quando faz isso, a linha
// passa a valer como 'confirmado' e o total deixa de ser estimativa naquela parte.

// Moeda dos padrões. USD porque é como os dois provedores publicam; quem quiser BRL edita a linha
// (não convertemos por câmbio: câmbio do dia não é o câmbio que a fatura usou, e um total
// "convertido" pareceria mais preciso do que é).
const MOEDA_PADRAO = 'USD';

const CONFIANCAS = ['confirmado', 'publicado', 'estimado'];

// Unidades em que cada preço é cobrado. Guardadas junto do valor porque 1M de tokens e 1 mensagem
// não são comparáveis, e porque é o que permite a tela escrever "US$ 30,00 por 1M de tokens".
const UNIDADES = {
  mensagem: { rotulo: 'por mensagem', divisor: 1 },
  milhao_tokens: { rotulo: 'por 1M de tokens', divisor: 1_000_000 },
};

// ── Tabela padrão ───────────────────────────────────────────────────────────────────────────
//
// `confianca`:
//   'publicado' — número lido na tabela oficial do provedor nesta data. Ainda muda sem aviso.
//   'estimado'  — não achamos valor oficial aplicável; é uma aproximação, e a tela diz isso.
//   'confirmado'— o cliente conferiu contra a fatura dele. Só chega aqui por edição.
const PRECOS_PADRAO = [
  // ── WhatsApp (Meta) ───────────────────────────────────────────────────────────────────────
  // A Meta cobra por mensagem entregue desde 01/07/2025, por categoria do template e por país.
  // Ela NÃO publica a tabela em BRL na documentação — remete a rate cards em CSV/PDF por moeda.
  // Por isso estes três entram como estimativa: as fontes secundárias que consultamos divergiam
  // entre si. O cliente tem o número exato na fatura dele e deve substituir.
  {
    chave: 'whatsapp.marketing',
    rotulo: 'WhatsApp — mensagem de marketing',
    valor: 0.0625,
    moeda: 'USD',
    unidade: 'mensagem',
    confianca: 'estimado',
    fonte: 'Fontes secundárias, Brasil 2026 — a Meta não publica a tabela em BRL',
    nota: 'Categoria mais cara. É a de campanha e recuperação de carrinho.',
  },
  {
    chave: 'whatsapp.utility',
    rotulo: 'WhatsApp — mensagem de utilidade',
    valor: 0.008,
    moeda: 'USD',
    unidade: 'mensagem',
    confianca: 'estimado',
    fonte: 'Fontes secundárias, Brasil 2026 — divergentes entre si',
    nota: 'Confirmação de pedido, aviso de envio. Grátis dentro da janela de 24h de atendimento.',
  },
  {
    chave: 'whatsapp.authentication',
    rotulo: 'WhatsApp — mensagem de autenticação',
    valor: 0.008,
    moeda: 'USD',
    unidade: 'mensagem',
    confianca: 'estimado',
    fonte: 'Fontes secundárias, Brasil 2026',
    nota: 'Código de verificação. Não usada nesta operação hoje.',
  },
  {
    chave: 'whatsapp.service',
    rotulo: 'WhatsApp — mensagem de atendimento',
    valor: 0,
    moeda: 'USD',
    unidade: 'mensagem',
    confianca: 'publicado',
    fonte: 'developers.facebook.com/docs/whatsapp/pricing',
    nota: 'Resposta dentro da janela de 24h aberta pelo cliente. Não é cobrada.',
  },

  // ── OpenAI — geração de imagem ────────────────────────────────────────────────────────────
  // gpt-image-2 cobra por token, e a ENTRADA tem três preços diferentes: texto, imagem e cache.
  // Somar tudo como "entrada" erraria o custo, por isso são três linhas.
  {
    chave: 'openai.gpt-image-2.entrada_texto',
    rotulo: 'gpt-image-2 — entrada de texto',
    valor: 5,
    moeda: 'USD',
    unidade: 'milhao_tokens',
    confianca: 'publicado',
    fonte: 'developers.openai.com/api/docs/pricing',
  },
  {
    chave: 'openai.gpt-image-2.entrada_imagem',
    rotulo: 'gpt-image-2 — entrada de imagem',
    valor: 8,
    moeda: 'USD',
    unidade: 'milhao_tokens',
    confianca: 'publicado',
    fonte: 'developers.openai.com/api/docs/pricing',
    nota: 'As imagens de referência do produto entram por aqui.',
  },
  {
    chave: 'openai.gpt-image-2.entrada_cache',
    rotulo: 'gpt-image-2 — entrada em cache',
    valor: 2,
    moeda: 'USD',
    unidade: 'milhao_tokens',
    confianca: 'publicado',
    fonte: 'developers.openai.com/api/docs/pricing',
  },
  {
    chave: 'openai.gpt-image-2.saida',
    rotulo: 'gpt-image-2 — saída (a imagem gerada)',
    valor: 30,
    moeda: 'USD',
    unidade: 'milhao_tokens',
    confianca: 'publicado',
    fonte: 'developers.openai.com/api/docs/pricing',
    nota: 'É a maior parte do custo de um criativo.',
  },

  // ── OpenAI — geração de texto (copy do anúncio) ───────────────────────────────────────────
  // A tabela da OpenAI lista variantes (Sol, Terra, Luna) e o gerador pede só "gpt-5.6". Sem saber
  // qual variante atende, usamos a do meio e marcamos como estimativa — errar a variante muda o
  // custo em 10x entre a mais cara e a mais barata.
  {
    chave: 'openai.gpt-5.6.entrada',
    rotulo: 'gpt-5.6 — entrada',
    valor: 2,
    moeda: 'USD',
    unidade: 'milhao_tokens',
    confianca: 'estimado',
    fonte: 'Tabela da OpenAI, variante Terra (a variante efetiva não é conhecida pelo painel)',
  },
  {
    chave: 'openai.gpt-5.6.entrada_cache',
    rotulo: 'gpt-5.6 — entrada em cache',
    valor: 0.2,
    moeda: 'USD',
    unidade: 'milhao_tokens',
    confianca: 'estimado',
    fonte: 'Tabela da OpenAI, variante Terra',
  },
  {
    chave: 'openai.gpt-5.6.saida',
    rotulo: 'gpt-5.6 — saída',
    valor: 12,
    moeda: 'USD',
    unidade: 'milhao_tokens',
    confianca: 'estimado',
    fonte: 'Tabela da OpenAI, variante Terra',
  },
];

const POR_CHAVE = new Map(PRECOS_PADRAO.map((p) => [p.chave, p]));

// Data em que a tabela padrão foi conferida. A tela mostra isso: um preço de meses atrás merece
// menos confiança que um de ontem, e só a data permite ao cliente julgar isso.
const CONFERIDO_EM = '2026-09-15';

// Mescla os padrões com o que o cliente editou. A edição vence sempre — quem tem a fatura é ele.
function mesclarPrecos(salvos) {
  const porChave = new Map((salvos || []).map((p) => [p.chave, p]));
  return PRECOS_PADRAO.map((padrao) => {
    const salvo = porChave.get(padrao.chave);
    if (!salvo) return { ...padrao, editado: false };
    return {
      ...padrao,
      valor: Number(salvo.valor),
      moeda: salvo.moeda || padrao.moeda,
      // Valor vindo da fatura do cliente é o único que pode ser chamado de confirmado.
      confianca: salvo.confianca || 'confirmado',
      fonte: salvo.fonte || 'Informado pelo cliente',
      editado: true,
      atualizadoEm: salvo.atualizadoEm || null,
    };
  });
}

function precoDe(precos, chave) {
  return (precos || []).find((p) => p.chave === chave) || POR_CHAVE.get(chave) || null;
}

// Custo de N mensagens de uma categoria. Devolve null quando não há preço para a categoria — nunca
// zero, que somaria a menos sem ninguém perceber.
function custoMensagens(categoria, quantidade, precos) {
  const chave = `whatsapp.${String(categoria || '').toLowerCase()}`;
  const preco = precoDe(precos, chave);
  if (!preco || !Number.isFinite(Number(preco.valor))) return null;
  const n = Number(quantidade) || 0;
  return {
    total: Number(preco.valor) * n,
    moeda: preco.moeda,
    quantidade: n,
    confianca: preco.confianca,
  };
}

// Custo de uma geração, a partir do consumo medido.
//
// `entradaNaoDetalhada` é o caso em que o provedor informou o total de entrada mas não a divisão
// entre texto e imagem. Aí cobramos tudo pelo preço de imagem — que é o mais caro — e marcamos a
// linha como estimada. Errar para cima é o erro certo aqui: um custo subestimado faz o cliente
// planejar gasto que não cabe.
function custoGeracao(consumo, precos, { modeloPadrao = 'gpt-image-2' } = {}) {
  if (!consumo) return null;
  const modelo = consumo.modeloImagem || modeloPadrao;
  const p = (sufixo) => precoDe(precos, `openai.${modelo}.${sufixo}`);
  const saida = p('saida');
  if (!saida) return null;

  const porMilhao = (tokens, preco) => (preco && Number.isFinite(Number(preco.valor))
    ? (Number(tokens) || 0) * Number(preco.valor) / UNIDADES.milhao_tokens.divisor
    : 0);

  const cache = Number(consumo.tokensEntradaCache) || 0;
  const texto = consumo.tokensEntradaTexto;
  const imagem = consumo.tokensEntradaImagem;
  const entradaTotal = Number(consumo.tokensEntrada) || 0;

  let custoEntrada = 0;
  let entradaNaoDetalhada = false;
  if (Number.isFinite(texto) || Number.isFinite(imagem)) {
    custoEntrada = porMilhao(texto || 0, p('entrada_texto')) + porMilhao(imagem || 0, p('entrada_imagem'));
  } else {
    // Sem a divisão, o não-cacheado vai pelo preço mais caro.
    entradaNaoDetalhada = entradaTotal > 0;
    custoEntrada = porMilhao(Math.max(entradaTotal - cache, 0), p('entrada_imagem') || p('entrada'));
  }
  custoEntrada += porMilhao(cache, p('entrada_cache'));

  const custoSaida = porMilhao(consumo.tokensSaida, saida);
  const confiancas = [saida.confianca, entradaNaoDetalhada ? 'estimado' : null].filter(Boolean);

  return {
    total: custoEntrada + custoSaida,
    entrada: custoEntrada,
    saida: custoSaida,
    moeda: saida.moeda,
    modelo,
    entradaNaoDetalhada,
    confianca: piorConfianca(confiancas),
  };
}

// A confiança de um total é a do seu pior componente: um total com uma linha estimada é uma
// estimativa inteira, por mais linhas publicadas que tenha junto.
function piorConfianca(lista) {
  const ordem = { confirmado: 0, publicado: 1, estimado: 2 };
  let pior = 'confirmado';
  for (const c of lista || []) {
    if (!c) continue;
    if ((ordem[c] ?? 2) > (ordem[pior] ?? 0)) pior = c;
  }
  return pior;
}

// Soma um conjunto de parcelas de custo, preservando o que o total não sabe.
//
// `naoMedido` é a parte que sabidamente existiu mas não pôde ser precificada — gerações sem
// `usage`, mensagens sem categoria conhecida. A tela precisa dizer "além disso, N não medidos" em
// vez de fingir que o total cobre tudo.
function totalizarCustos(parcelas, { naoMedido = 0 } = {}) {
  const linhas = (parcelas || []).filter((p) => p && Number.isFinite(Number(p.total)));
  const moedas = new Set(linhas.map((l) => l.moeda).filter(Boolean));
  return {
    total: linhas.reduce((acc, l) => acc + Number(l.total), 0),
    // Mais de uma moeda no mesmo total significa que o cliente editou parte em BRL e deixou parte
    // em USD. Somar isso daria um número sem significado, então a tela separa em vez de somar.
    moeda: moedas.size === 1 ? [...moedas][0] : null,
    moedasMisturadas: moedas.size > 1,
    confianca: piorConfianca(linhas.map((l) => l.confianca)),
    naoMedido,
    linhas,
  };
}

function validarPreco(corpo) {
  const erros = [];
  const chave = String((corpo && corpo.chave) || '');
  if (!POR_CHAVE.has(chave)) erros.push('preço desconhecido');

  const valor = Number(corpo && corpo.valor);
  // Zero é válido aqui, ao contrário de despesa: mensagem de atendimento custa zero de verdade.
  if (!Number.isFinite(valor) || valor < 0) erros.push('valor deve ser um número maior ou igual a zero');

  const moeda = String((corpo && corpo.moeda) || MOEDA_PADRAO).toUpperCase();
  if (!/^[A-Z]{3}$/.test(moeda)) erros.push('moeda deve ter 3 letras (ex.: USD, BRL)');

  const confianca = String((corpo && corpo.confianca) || 'confirmado');
  if (!CONFIANCAS.includes(confianca)) erros.push('confiança inválida');

  if (erros.length) return { erros };
  return { preco: { chave, valor, moeda, confianca } };
}

module.exports = {
  MOEDA_PADRAO,
  CONFIANCAS,
  UNIDADES,
  PRECOS_PADRAO,
  CONFERIDO_EM,
  mesclarPrecos,
  precoDe,
  custoMensagens,
  custoGeracao,
  piorConfianca,
  totalizarCustos,
  validarPreco,
};
