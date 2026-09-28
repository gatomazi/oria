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
      tetoMargemBps: 1500, beneficio: Object.freeze({ tipo: 'nenhum' }),
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

const MIN_NIVEIS = 1;
const MAX_NIVEIS = 16; // "mais steps" é livre para o lojista dentro de um teto sensato (payload de auditoria, tabela na UI).
const TIPOS_BENEFICIO = ['nenhum', 'primeira_peca', 'peca_periodica'];

function inteiroEm(valor, { min, max, nome }) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) throw new TypeError(`${nome} deve ser um inteiro entre ${min} e ${max}`);
  return n;
}

// Reconstrói o benefício SÓ com os campos que o tipo escolhido usa (mesma técnica de whitelist de `lerTermos`/`lerPerfis`
// no registry): um campo desconhecido ou de outro tipo nunca é persistido, nunca influencia o sistema.
function normalizarBeneficio(b, contexto) {
  if (!b || typeof b !== 'object' || !TIPOS_BENEFICIO.includes(b.tipo)) throw new TypeError(`${contexto}.beneficio.tipo inválido (use nenhum, primeira_peca ou peca_periodica)`);
  if (b.tipo === 'nenhum') return { tipo: 'nenhum' };
  if (b.tipo === 'primeira_peca') return { tipo: 'primeira_peca', aPartirDeVendas: inteiroEm(b.aPartirDeVendas, { min: 0, max: 1000000, nome: `${contexto}.beneficio.aPartirDeVendas` }) };
  const beneficio = { tipo: 'peca_periodica', aCadaDias: inteiroEm(b.aCadaDias, { min: 1, max: 3650, nome: `${contexto}.beneficio.aCadaDias` }) };
  if (b.exigeVendasUltimos30d !== undefined && b.exigeVendasUltimos30d !== null && b.exigeVendasUltimos30d !== '') {
    beneficio.exigeVendasUltimos30d = inteiroEm(b.exigeVendasUltimos30d, { min: 0, max: 1000000, nome: `${contexto}.beneficio.exigeVendasUltimos30d` });
  }
  return beneficio;
}

// Reconstrói UM nível campo a campo (whitelist): nada que não esteja listado aqui chega a ser persistido. `ordem` NÃO é
// entrada do usuário — é sempre a posição do nível no array (índice), o que elimina buraco/duplicata/ordem incoerente
// como classe de erro; reordenar é reordenar o array. O nível de índice 0 é a "base": suas metas nunca são avaliadas
// (`avaliarNivel` trata `ordem === 0` como sempre alcançado), então os limiares dele são sempre zerados aqui.
function normalizarNivel(n, indice, chavesVistas) {
  if (!n || typeof n !== 'object') throw new TypeError(`nível #${indice + 1} inválido`);
  if (typeof n.key !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(n.key)) throw new TypeError(`nível #${indice + 1}: chave inválida (a-z, 0-9, _; começa com letra; até 31 caracteres)`);
  if (chavesVistas.has(n.key)) throw new TypeError(`chave de nível duplicada: ${n.key}`);
  chavesVistas.add(n.key);
  const label = typeof n.label === 'string' ? n.label.trim() : '';
  if (!label || label.length > 60) throw new TypeError(`${n.key}.label deve ter de 1 a 60 caracteres`);
  const contexto = n.key;
  const base = indice === 0;
  const zeroSeBase = (valor, min, max, nome) => (base ? 0 : inteiroEm(valor, { min, max, nome: `${contexto}.${nome}` }));
  return {
    key: n.key, label, ordem: indice,
    janelaDias: n.janelaDias === null || n.janelaDias === undefined ? null : inteiroEm(n.janelaDias, { min: 1, max: 3650, nome: `${contexto}.janelaDias` }),
    vendasQualificadas: zeroSeBase(n.vendasQualificadas, 0, 1000000, 'vendasQualificadas'),
    margemCents: zeroSeBase(n.margemCents, 0, 100000000000, 'margemCents'),
    mesesComVenda: zeroSeBase(n.mesesComVenda, 0, 120, 'mesesComVenda'),
    vendasUltimos60d: zeroSeBase(n.vendasUltimos60d, 0, 1000000, 'vendasUltimos60d'),
    tetoMargemBps: inteiroEm(n.tetoMargemBps, { min: 0, max: 10000, nome: `${contexto}.tetoMargemBps` }),
    beneficio: normalizarBeneficio(n.beneficio, contexto),
  };
}

// Valida E normaliza: devolve sempre um objeto NOVO, só com os campos whitelisted (nunca o `regras` bruto de entrada).
function validarRegras(regras) {
  if (!regras || typeof regras !== 'object' || !Array.isArray(regras.niveis)) throw new TypeError('regras de nível inválidas');
  if (regras.niveis.length < MIN_NIVEIS || regras.niveis.length > MAX_NIVEIS) throw new TypeError(`use de ${MIN_NIVEIS} a ${MAX_NIVEIS} níveis`);
  const chaves = new Set();
  const niveis = regras.niveis.map((n, i) => normalizarNivel(n, i, chaves));
  return { niveis };
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

module.exports = { REGRAS_PADRAO, validarRegras, nivelDe, metricasDaJanela, avaliarNivel, elegibilidadeDePeca, MIN_NIVEIS, MAX_NIVEIS, TIPOS_BENEFICIO };
