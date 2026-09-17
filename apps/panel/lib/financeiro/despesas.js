'use strict';

// Despesas operacionais (docs/meta-ads-analytics-integracao-v2.md §53X, §53Y). É a peça que faltava
// para o nível 4 do resultado — enquanto ela não existia, o Lucro Operacional aparecia como
// travessão porque era genuinamente desconhecido.
//
// O problema com risco aqui é RECORRÊNCIA. Uma despesa mensal (designer, apps, mensalidade) precisa
// contar uma vez por mês dentro do período consultado, sem que existam linhas fantasma no banco
// para meses futuros. A expansão acontece na leitura, e é o que este arquivo testa.

// Categorias da spec §53X. Fechadas de propósito: categoria livre vira sinônimo ("Designer",
// "designer", "Design") e o agrupamento por categoria deixa de significar algo.
const CATEGORIAS = [
  'PAYMENT_FEES', 'TRAFFIC_MANAGER', 'DESIGNER', 'APPS', 'PLATFORM', 'SHIPPING', 'TAXES', 'OTHER',
];

const CATEGORIA_ROTULO = {
  PAYMENT_FEES: 'Taxas de pagamento',
  TRAFFIC_MANAGER: 'Gestor de tráfego',
  DESIGNER: 'Designer',
  APPS: 'Apps e integrações',
  PLATFORM: 'Plataforma',
  SHIPPING: 'Frete subsidiado',
  TAXES: 'Impostos',
  OTHER: 'Outras despesas',
};

const RECORRENCIAS = ['unica', 'mensal'];

function diaISO(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Quantas vezes uma despesa incide no intervalo [from, to].
//
// `unica`  → 1 se a data cai dentro do intervalo, 0 fora.
// `mensal` → uma incidência por mês-calendário que o intervalo toca, a partir do mês de início e
//            até `fim` (quando definido). Conta o MÊS, não 30 dias: uma mensalidade de R$ 1.500 não
//            vira R$ 1.450 porque o período tem 29 dias.
//
// A incidência é atribuída ao dia do mês em que a despesa começou; quando esse dia não existe no
// mês (dia 31 em fevereiro), cai no último dia do mês — mesma regra que cobrança recorrente usa.
function ocorrencias(despesa, from, to) {
  const ini = new Date(`${from}T00:00:00Z`);
  const fim = new Date(`${to}T00:00:00Z`);
  const inicioDespesa = new Date(`${despesa.data}T00:00:00Z`);
  const fimDespesa = despesa.fim ? new Date(`${despesa.fim}T00:00:00Z`) : null;

  if (despesa.recorrencia !== 'mensal') {
    const dentro = inicioDespesa >= ini && inicioDespesa <= fim;
    return dentro ? [diaISO(inicioDespesa)] : [];
  }

  const diaBase = inicioDespesa.getUTCDate();
  const datas = [];
  // Começa no mês do início da despesa ou no mês do início do período, o que vier depois.
  let ano = Math.max(ini.getUTCFullYear(), inicioDespesa.getUTCFullYear());
  let mes = ini > inicioDespesa
    ? (ini.getUTCFullYear() === inicioDespesa.getUTCFullYear() ? Math.max(ini.getUTCMonth(), inicioDespesa.getUTCMonth()) : ini.getUTCMonth())
    : inicioDespesa.getUTCMonth();
  if (ini > inicioDespesa) { ano = ini.getUTCFullYear(); mes = ini.getUTCMonth(); }

  // Teto de segurança: 400 meses cobre qualquer período plausível e impede laço infinito se uma
  // data vier corrompida.
  for (let i = 0; i < 400; i += 1) {
    const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    const d = new Date(Date.UTC(ano, mes, Math.min(diaBase, ultimoDia)));
    if (d > fim) break;
    if (d >= ini && d >= inicioDespesa && (!fimDespesa || d <= fimDespesa)) datas.push(diaISO(d));
    mes += 1;
    if (mes > 11) { mes = 0; ano += 1; }
  }
  return datas;
}

// Total das despesas no período, com a quebra por categoria que a tela usa. `origem` acompanha cada
// linha (spec §53Y): saber que R$ 8.825 de mídia é "automático, via API" e R$ 1.500 de designer é
// "manual, recorrente" é o que torna o financeiro auditável.
function totalizarDespesas(despesas, from, to) {
  const porCategoria = {};
  let total = 0;
  const linhas = [];
  for (const d of despesas || []) {
    const datas = ocorrencias(d, from, to);
    if (!datas.length) continue;
    const valor = Number(d.valor) || 0;
    const subtotal = valor * datas.length;
    porCategoria[d.categoria] = (porCategoria[d.categoria] || 0) + subtotal;
    total += subtotal;
    linhas.push({
      id: d.id,
      categoria: d.categoria,
      descricao: d.descricao,
      valor,
      recorrencia: d.recorrencia,
      ocorrencias: datas.length,
      subtotal,
      // Manual porque veio do cadastro; quando taxas de gateway forem lidas do pedido, a mesma
      // estrutura recebe 'automatico' sem mudar a tela.
      origem: 'manual',
    });
  }
  return { total, porCategoria, linhas };
}

function validarDespesa(corpo) {
  const erros = [];
  const categoria = String((corpo && corpo.categoria) || '').toUpperCase();
  if (!CATEGORIAS.includes(categoria)) erros.push('categoria inválida');

  const valor = Number(corpo && corpo.valor);
  // Zero é recusado junto com negativo: uma despesa de R$ 0 não é despesa, é cadastro incompleto —
  // e passaria batido somando nada ao resultado.
  if (!Number.isFinite(valor) || valor <= 0) erros.push('valor deve ser um número maior que zero');

  const data = String((corpo && corpo.data) || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) erros.push('data deve estar no formato AAAA-MM-DD');

  const recorrencia = String((corpo && corpo.recorrencia) || 'unica');
  if (!RECORRENCIAS.includes(recorrencia)) erros.push('recorrência deve ser "unica" ou "mensal"');

  const fim = corpo && corpo.fim ? String(corpo.fim) : null;
  if (fim && !/^\d{4}-\d{2}-\d{2}$/.test(fim)) erros.push('fim deve estar no formato AAAA-MM-DD');
  if (fim && data && fim < data) erros.push('fim não pode ser antes da data de início');
  if (fim && recorrencia !== 'mensal') erros.push('fim só faz sentido em despesa recorrente');

  const descricao = String((corpo && corpo.descricao) || '').trim();
  if (!descricao) erros.push('descrição é obrigatória');

  if (erros.length) return { erros };
  return { despesa: { categoria, valor, data, recorrencia, fim, descricao: descricao.slice(0, 200) } };
}

module.exports = {
  CATEGORIAS,
  CATEGORIA_ROTULO,
  RECORRENCIAS,
  ocorrencias,
  totalizarDespesas,
  validarDespesa,
};
