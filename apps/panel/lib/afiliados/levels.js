'use strict';

// Níveis de parceiro. Regras por loja, editáveis e versionadas (partnership_level_rule_sets); os números abaixo são
// o PADRÃO SUGERIDO do piloto, não constantes de negócio no código. O nível altera elegibilidade e benefícios e pode
// gerar PROPOSTA de novo contrato — nunca reescreve um contrato em vigor. Meta de margem sem custo verificado fica
// "não verificada": nunca se inventa lucro para promover.

const REGRAS_PADRAO = Object.freeze({
  // Teto de referência para contratos por MARGEM (bps). Contratos por receita/fixo pedem equivalência econômica projetada.
  niveis: Object.freeze([
    Object.freeze({
      key: 'raiz', label: 'Raiz', ordem: 0, janelaDias: null, vendasQualificadas: 0, margemCents: 0, mesesComVenda: 0, vendasUltimos60d: 0,
      tetoMargemBps: 1500, beneficio: Object.freeze({ tipo: 'nenhum' }), revisaoAposDias: 60,
    }),
    Object.freeze({
      key: 'voz', label: 'Voz', ordem: 1, janelaDias: 90, vendasQualificadas: 5, margemCents: 15000, mesesComVenda: 0, vendasUltimos60d: 0,
      tetoMargemBps: 2000, beneficio: Object.freeze({ tipo: 'primeira_peca', aPartirDeVendas: 12 }),
    }),
    Object.freeze({
      key: 'referencia', label: 'Referência', ordem: 2, janelaDias: 90, vendasQualificadas: 15, margemCents: 45000, mesesComVenda: 2, vendasUltimos60d: 0,
      tetoMargemBps: 2500, beneficio: Object.freeze({ tipo: 'peca_periodica', aCadaDias: 90 }),
    }),
    Object.freeze({
      key: 'embaixador', label: 'Embaixador', ordem: 3, janelaDias: 90, vendasQualificadas: 40, margemCents: 120000, mesesComVenda: 0, vendasUltimos60d: 10,
      tetoMargemBps: 3000, beneficio: Object.freeze({ tipo: 'peca_periodica', aCadaDias: 30, exigeVendasUltimos30d: 12 }),
    }),
  ]),
});

function validarRegras(regras) {
  if (!regras || !Array.isArray(regras.niveis) || regras.niveis.length === 0) throw new TypeError('regras de nível inválidas');
  const chaves = new Set();
  let ultimaOrdem = -1;
  for (const n of regras.niveis) {
    if (!n || typeof n.key !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(n.key)) throw new TypeError('nível com chave inválida');
    if (chaves.has(n.key)) throw new TypeError(`nível duplicado: ${n.key}`);
    chaves.add(n.key);
    if (!Number.isInteger(n.ordem) || n.ordem <= ultimaOrdem) throw new TypeError('níveis devem estar em ordem crescente');
    ultimaOrdem = n.ordem;
    for (const campo of ['vendasQualificadas', 'margemCents', 'mesesComVenda', 'vendasUltimos60d', 'tetoMargemBps']) {
      if (!Number.isInteger(n[campo]) || n[campo] < 0) throw new TypeError(`${n.key}.${campo} deve ser inteiro >= 0`);
    }
    if (n.tetoMargemBps > 10000) throw new TypeError(`${n.key}.tetoMargemBps acima de 100%`);
    if (n.janelaDias !== null && (!Number.isInteger(n.janelaDias) || n.janelaDias < 1)) throw new TypeError(`${n.key}.janelaDias inválida`);
  }
  return regras;
}

const nivelDe = (regras, key) => regras.niveis.find((n) => n.key === key) || null;

// Métricas na janela para UM parceiro, a partir das linhas de atribuição já calculadas.
//   linhas: { inkOrderId, inkItemId, eligibleQty, marginEligibleCents|null, saleAt: Date, status, orderState }
// Só vendas com pagamento confirmado contam; a mesma linha (pedido+item) nunca conta duas vezes mesmo que cupom e
// collab a tenham atribuído ao mesmo parceiro.
function metricasDaJanela(linhas, { agora, janelaDias, contarPor = 'orders' }) {
  const desde = janelaDias ? new Date(agora.getTime() - janelaDias * 86400000) : new Date(0);
  const porLinha = new Map();
  for (const l of linhas) {
    if (l.status !== 'calculated' || !['paid', 'delivered'].includes(l.orderState) || !(l.eligibleQty > 0)) continue;
    const t = new Date(l.saleAt);
    if (t < desde || t > agora) continue;
    const chave = `${l.inkOrderId}:${l.inkItemId}`;
    if (!porLinha.has(chave)) porLinha.set(chave, { ...l, saleAt: t });
  }
  const pedidos = new Set();
  const meses = new Set();
  let unidades = 0;
  let margem = 0;
  let margemVerificada = true;
  let vendas60 = 0;
  let vendas30 = 0;
  const corte60 = new Date(agora.getTime() - 60 * 86400000);
  const corte30 = new Date(agora.getTime() - 30 * 86400000);
  const pedidosPorRecorte = { d60: new Set(), d30: new Set() };
  for (const l of porLinha.values()) {
    pedidos.add(String(l.inkOrderId));
    unidades += l.eligibleQty;
    meses.add(`${l.saleAt.getUTCFullYear()}-${l.saleAt.getUTCMonth()}`);
    if (l.marginEligibleCents === null || l.marginEligibleCents === undefined) margemVerificada = false;
    else margem += l.marginEligibleCents;
    if (l.saleAt >= corte60) { pedidosPorRecorte.d60.add(String(l.inkOrderId)); vendas60 += l.eligibleQty; }
    if (l.saleAt >= corte30) { pedidosPorRecorte.d30.add(String(l.inkOrderId)); vendas30 += l.eligibleQty; }
  }
  const qualificadas = contarPor === 'units' ? unidades : pedidos.size;
  return {
    contarPor,
    vendasQualificadas: qualificadas,
    pedidosDistintos: pedidos.size,
    unidades,
    margemCents: margem,
    margemVerificada,
    mesesComVenda: meses.size,
    vendasUltimos60d: contarPor === 'units' ? vendas60 : pedidosPorRecorte.d60.size,
    vendasUltimos30d: contarPor === 'units' ? vendas30 : pedidosPorRecorte.d30.size,
  };
}

// Um nível é ALCANÇADO quando todas as metas simultâneas batem. Meta de margem sem margem verificada = não verificada
// (não alcança). Devolve o maior nível alcançado e o relatório de cada meta do PRÓXIMO nível.
function avaliarNivel(metricas, regras, nivelAtualKey) {
  const alcance = (n) => {
    if (n.ordem === 0) return { alcancado: true, metas: [] };
    const metas = [
      { meta: 'vendasQualificadas', exigido: n.vendasQualificadas, atual: metricas.vendasQualificadas, ok: metricas.vendasQualificadas >= n.vendasQualificadas },
      n.margemCents > 0
        ? { meta: 'margemCents', exigido: n.margemCents, atual: metricas.margemVerificada ? metricas.margemCents : null, ok: metricas.margemVerificada && metricas.margemCents >= n.margemCents, naoVerificada: !metricas.margemVerificada }
        : null,
      n.mesesComVenda > 0 ? { meta: 'mesesComVenda', exigido: n.mesesComVenda, atual: metricas.mesesComVenda, ok: metricas.mesesComVenda >= n.mesesComVenda } : null,
      n.vendasUltimos60d > 0 ? { meta: 'vendasUltimos60d', exigido: n.vendasUltimos60d, atual: metricas.vendasUltimos60d, ok: metricas.vendasUltimos60d >= n.vendasUltimos60d } : null,
    ].filter(Boolean);
    return { alcancado: metas.every((m) => m.ok), metas };
  };
  let melhor = regras.niveis[0];
  for (const n of regras.niveis) if (alcance(n).alcancado) melhor = n;
  const atual = nivelDe(regras, nivelAtualKey) || regras.niveis[0];
  const proximo = regras.niveis.find((n) => n.ordem === atual.ordem + 1) || null;
  return {
    nivelAlcancado: melhor.key,
    nivelAtual: atual.key,
    direcao: melhor.ordem > atual.ordem ? 'upgrade' : melhor.ordem < atual.ordem ? 'downgrade' : 'manter',
    proximo: proximo ? { key: proximo.key, label: proximo.label, ...alcance(proximo) } : null,
  };
}

// Benefício "peça" do nível: elegibilidade condicionada a vendas, saldo e atividade. Devolve o motivo do bloqueio.
function elegibilidadeDePeca({ nivel, metricas, saldoBeneficioCents, custoPecaCents, ultimaPecaEm, agora }) {
  const b = nivel.beneficio || { tipo: 'nenhum' };
  if (b.tipo === 'nenhum') return { elegivel: false, motivo: 'nivel_sem_peca' };
  if (b.tipo === 'primeira_peca' && metricas.vendasQualificadas < b.aPartirDeVendas) return { elegivel: false, motivo: 'vendas_insuficientes' };
  if (b.aCadaDias && ultimaPecaEm && (agora.getTime() - new Date(ultimaPecaEm).getTime()) < b.aCadaDias * 86400000) return { elegivel: false, motivo: 'periodo_nao_cumprido' };
  if (b.exigeVendasUltimos30d && metricas.vendasUltimos30d < b.exigeVendasUltimos30d) return { elegivel: false, motivo: 'atividade_insuficiente' };
  if (custoPecaCents !== null && custoPecaCents !== undefined && saldoBeneficioCents < custoPecaCents) return { elegivel: false, motivo: 'saldo_insuficiente' };
  return { elegivel: true, motivo: null };
}

module.exports = { REGRAS_PADRAO, validarRegras, nivelDe, metricasDaJanela, avaliarNivel, elegibilidadeDePeca };
