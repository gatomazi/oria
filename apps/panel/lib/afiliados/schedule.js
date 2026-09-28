'use strict';

// Calendário financeiro do módulo de afiliados. Quatro datas DISTINTAS, nunca misturadas:
//   sale_at        quando o pedido foi feito
//   release_at     quando o crédito passa a ser pagável (pagamento confirmado + entrega + carência)
//   due_at         vencimento do repasse (a estimativa de algo ainda não liberado é PREVISÃO, não dívida)
//   paid_at        quando o lojista efetivamente transferiu dinheiro
// Regras de calendário rodam no timezone da loja (padrão America/Sao_Paulo); o banco guarda UTC.
// Não há calendário de feriados: "próximo dia útil" considera só sábado e domingo — e isso é dito na UI.

const TZ_PADRAO = 'America/Sao_Paulo';
const DIA_MS = 24 * 60 * 60 * 1000;

const formatadores = new Map();
function formatador(tz) {
  if (!formatadores.has(tz)) {
    formatadores.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatadores.get(tz);
}

function validarTimezone(tz) {
  try { formatador(tz); return true; } catch { return false; }
}

// Partes de calendário de um instante no timezone informado.
function partesLocais(instante, tz = TZ_PADRAO) {
  const d = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(d.getTime())) throw new TypeError('instante inválido');
  const p = {};
  for (const { type, value } of formatador(tz).formatToParts(d)) p[type] = value;
  return { ano: Number(p.year), mes: Number(p.month), dia: Number(p.day), hora: Number(p.hour), minuto: Number(p.minute), segundo: Number(p.second) };
}

// 'YYYY-MM-DD' local.
function dataLocal(instante, tz = TZ_PADRAO) {
  const { ano, mes, dia } = partesLocais(instante, tz);
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Instante UTC do início (00:00) de uma data local. Converge em 2 passos, o suficiente para qualquer offset fixo/DST.
function inicioDoDiaLocal(ano, mes, dia, tz = TZ_PADRAO) {
  let palpite = Date.UTC(ano, mes - 1, dia, 0, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const p = partesLocais(new Date(palpite), tz);
    const localComoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
    const alvo = Date.UTC(ano, mes - 1, dia, 0, 0, 0);
    const erro = localComoUtc - alvo;
    if (erro === 0) break;
    palpite -= erro;
  }
  return new Date(palpite);
}

// Primeiro dia do mês de um instante, como 'YYYY-MM-01' (competência gerencial).
function competenciaDoMes(instante, tz = TZ_PADRAO) {
  const { ano, mes } = partesLocais(instante, tz);
  return `${ano}-${String(mes).padStart(2, '0')}-01`;
}

function somarDias(instante, dias) {
  return new Date((instante instanceof Date ? instante : new Date(instante)).getTime() + dias * DIA_MS);
}

// Dia da semana LOCAL (0 = domingo) de uma data civil, sem depender do timezone da máquina.
function diaDaSemana(ano, mes, dia) {
  return new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
}

// Dia do mês pedido, limitado ao último dia real do mês (payout_day é 1..28, então nunca estoura; defesa mesmo assim).
function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

// release_at por política. Sem o marco necessário devolve null (a comissão continua provisionada; nunca chuta).
//   delivery_plus_hold  entrega + hold dias
//   payment_plus_days   pagamento observado + hold dias (a INK não expõe paid_at no cache: usa-se a data de OBSERVAÇÃO)
function calcularLiberacao({ politica, holdDias, entregueEm, pagoObservadoEm }) {
  if (politica === 'payment_plus_days') {
    return pagoObservadoEm ? somarDias(pagoObservadoEm, holdDias) : null;
  }
  return entregueEm ? somarDias(entregueEm, holdDias) : null;
}

// Vencimento: dia `diaPagamento` do mês (liberação + `mesesDepois`), no timezone da loja, à 00:00 local.
// Fim de semana desloca para segunda-feira quando `deslocarFimDeSemana` (sem feriados).
function calcularVencimento({ liberadoEm, diaPagamento, mesesDepois, deslocarFimDeSemana = true, tz = TZ_PADRAO }) {
  if (!liberadoEm) return null;
  const { ano, mes } = partesLocais(liberadoEm, tz);
  const indice = (ano * 12 + (mes - 1)) + mesesDepois;
  const anoAlvo = Math.floor(indice / 12);
  const mesAlvo = (indice % 12) + 1;
  let dia = Math.min(diaPagamento, ultimoDiaDoMes(anoAlvo, mesAlvo));
  let dow = diaDaSemana(anoAlvo, mesAlvo, dia);
  let deslocamento = 0;
  if (deslocarFimDeSemana) {
    if (dow === 6) deslocamento = 2;
    else if (dow === 0) deslocamento = 1;
  }
  dia += deslocamento;
  dow = (dow + deslocamento) % 7;
  const limite = ultimoDiaDoMes(anoAlvo, mesAlvo);
  if (dia > limite) {
    // Transbordou para o mês seguinte (só ocorre se payout_day estivesse perto do fim do mês).
    const seguinte = mesAlvo === 12 ? { a: anoAlvo + 1, m: 1 } : { a: anoAlvo, m: mesAlvo + 1 };
    return inicioDoDiaLocal(seguinte.a, seguinte.m, dia - limite, tz);
  }
  return inicioDoDiaLocal(anoAlvo, mesAlvo, dia, tz);
}

// Vencido = a DATA (local) do vencimento já passou. Vencer hoje ainda não é atraso.
function diasEmAtraso(dueAt, agora, tz = TZ_PADRAO) {
  if (!dueAt) return 0;
  const due = dataLocal(dueAt, tz);
  const hoje = dataLocal(agora, tz);
  if (hoje <= due) return 0;
  return Math.round((Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DIA_MS);
}

// Limites [início, fim) UTC de um intervalo de DATAS locais 'YYYY-MM-DD' inclusivo nas duas pontas.
function intervaloLocal(de, ate, tz = TZ_PADRAO) {
  const [a1, m1, d1] = de.split('-').map(Number);
  const [a2, m2, d2] = ate.split('-').map(Number);
  const inicio = inicioDoDiaLocal(a1, m1, d1, tz);
  const fimIncl = inicioDoDiaLocal(a2, m2, d2, tz);
  const fim = inicioDoDiaLocal(...proximaData(a2, m2, d2), tz);
  if (fim <= inicio) throw new RangeError('intervalo vazio ou invertido');
  return { inicio, fim, fimInclusivo: fimIncl };
}

function proximaData(ano, mes, dia) {
  const d = new Date(Date.UTC(ano, mes - 1, dia + 1));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

module.exports = {
  TZ_PADRAO, DIA_MS, validarTimezone, partesLocais, dataLocal, inicioDoDiaLocal, competenciaDoMes, somarDias,
  calcularLiberacao, calcularVencimento, diasEmAtraso, intervaloLocal,
};
