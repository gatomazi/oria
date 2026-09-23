'use strict';

// Indicadores comerciais da página Clientes. Função PURA sobre clientes já agrupados por identidade
// (lib/clientes/identidade.js) e seus pedidos; nada de banco ou relógio.
//
// Um único universo: os pedidos que entram são os VÁLIDOS da Store do contexto (mesma definição da RFM, ver
// `pedidoValido`), dentro do período. Faturamento, pedidos, clientes, recompra, ticket e receita por cliente saem
// do MESMO conjunto — nenhum card mistura universos (ex.: pedidos da Organização inteira com filtro de uma loja).
//
// Definições (também exibidas em tooltip na tela):
//   faturamento       Σ valor pago (`total_value`, já líquido de desconto; inclui frete pago pelo cliente)
//   clientes          identidades distintas com ≥1 pedido válido no período
//   taxa de recompra  clientes com ≥2 pedidos válidos NO PERÍODO ÷ clientes do período
//   ticket médio      faturamento ÷ pedidos            receita por cliente  faturamento ÷ clientes
//   1ª compra         clientes cujo primeiro pedido válido de toda a vida cai no período
//   reembolsados      pedidos do período com pagamento `refunded` ou "Reembolsado" (fora do faturamento)

const { pedidoValido, diasDeCalendario } = require('./rfm');

// A Ink devolve o status de pagamento ora em inglês (`refunded`), ora como rótulo em português ("Reembolsado"): o
// mapeamento de entrada não cobre este último. Para o contador, os dois são reembolso total.
const ehReembolsado = (status) => ['refunded', 'reembolsado'].includes(String(status || '').trim().toLowerCase());

const FUSO_PADRAO = 'America/Sao_Paulo';
const MS_DIA = 86400000;

const formatadores = new Map();
function dataLocal(data, fuso) {
  if (!formatadores.has(fuso)) {
    formatadores.set(fuso, new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return formatadores.get(fuso).format(data); // YYYY-MM-DD
}

const ISO_DIA = /^\d{4}-\d{2}-\d{2}$/;
function diaValido(v) {
  if (typeof v !== 'string' || !ISO_DIA.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function somarDias(dia, n) {
  return new Date(new Date(`${dia}T00:00:00Z`).getTime() + n * MS_DIA).toISOString().slice(0, 10);
}

function centavos(v) {
  return Math.round(v * 100) / 100;
}

// Período de `de` a `ate`, ambos inclusivos, em dias do fuso da Organization. Entrada inválida cai no padrão
// (últimos `diasPadrao` dias até `hoje`) — nunca é repassada adiante.
function normalizarPeriodo({ de, ate }, { hoje, diasPadrao = 30, maxDias = 1830 } = {}) {
  let fim = diaValido(ate) ? ate : hoje;
  if (fim > hoje) fim = hoje;
  let inicio = diaValido(de) ? de : somarDias(fim, -(diasPadrao - 1));
  if (inicio > fim) inicio = fim;
  if ((new Date(`${fim}T00:00:00Z`) - new Date(`${inicio}T00:00:00Z`)) / MS_DIA + 1 > maxDias) inicio = somarDias(fim, -(maxDias - 1));
  return { de: inicio, ate: fim };
}

function periodoAnterior({ de, ate }) {
  const dias = Math.round((new Date(`${ate}T00:00:00Z`) - new Date(`${de}T00:00:00Z`)) / MS_DIA) + 1;
  return { de: somarDias(de, -dias), ate: somarDias(de, -1) };
}

function calcularPeriodo(clientes, { de, ate }, fuso) {
  // Somas em centavos inteiros (exatas e independentes da ordem dos pedidos).
  let faturamento = 0;
  let pedidos = 0;
  let pedidosReembolsados = 0;
  let clientesDoPeriodo = 0;
  let recorrentes = 0;
  let receitaRecorrente = 0;
  let primeiraCompra = 0;

  for (const cliente of clientes) {
    const validos = (cliente.pedidos || []).filter(pedidoValido);
    let noPeriodo = 0;
    let valorNoPeriodo = 0;
    let primeiroDia = null;
    for (const p of validos) {
      const dia = dataLocal(new Date(p.criadoEm), fuso);
      if (primeiroDia == null || dia < primeiroDia) primeiroDia = dia;
      if (dia >= de && dia <= ate) { noPeriodo += 1; valorNoPeriodo += Math.round(Number(p.valor) * 100); }
    }
    for (const p of cliente.pedidos || []) {
      if (!ehReembolsado(p.paymentStatus)) continue;
      const dia = dataLocal(new Date(p.criadoEm), fuso);
      if (dia >= de && dia <= ate) pedidosReembolsados += 1;
    }
    if (!noPeriodo) continue;
    clientesDoPeriodo += 1;
    pedidos += noPeriodo;
    faturamento += valorNoPeriodo;
    if (noPeriodo >= 2) { recorrentes += 1; receitaRecorrente += valorNoPeriodo; }
    if (primeiroDia >= de && primeiroDia <= ate) primeiraCompra += 1;
  }

  return {
    faturamento: faturamento / 100,
    pedidos,
    clientes: clientesDoPeriodo,
    recorrentes,
    taxaRecompra: clientesDoPeriodo ? recorrentes / clientesDoPeriodo : null,
    ticketMedio: pedidos ? centavos(faturamento / 100 / pedidos) : null,
    receitaPorCliente: clientesDoPeriodo ? centavos(faturamento / 100 / clientesDoPeriodo) : null,
    receitaRecorrente: receitaRecorrente / 100,
    clientesPrimeiraCompra: primeiraCompra,
    pedidosReembolsados,
  };
}

// `cobertura.primeiroPedidoEm`: data do pedido mais antigo no cache. O período anterior só é comparável se começa
// DEPOIS dele — antes disso o cache pode simplesmente não ter os pedidos, e a "queda" seria artefato de cobertura.
function calcularIndicadores(clientes, periodo, { fuso = FUSO_PADRAO, primeiroPedidoEm = null } = {}) {
  const atual = calcularPeriodo(clientes, periodo, fuso);
  const anteriorPeriodo = periodoAnterior(periodo);
  const primeiroDia = primeiroPedidoEm ? dataLocal(new Date(primeiroPedidoEm), fuso) : null;
  const comparavel = primeiroDia != null && anteriorPeriodo.de >= primeiroDia;
  return {
    periodo,
    atual,
    comparacao: comparavel
      ? { periodo: anteriorPeriodo, anterior: calcularPeriodo(clientes, anteriorPeriodo, fuso) }
      : { periodo: anteriorPeriodo, anterior: null, motivo: 'histórico sincronizado não cobre o período anterior inteiro' },
  };
}

module.exports = { normalizarPeriodo, periodoAnterior, calcularIndicadores, diaValido, dataLocal, diasDeCalendario };
