'use strict';

// Lista paginada de Clientes (busca, ordenação, filtro de inatividade e paginação no SERVIDOR).
//
// A tela antiga cortava a lista nos 100 primeiros clientes do cadastro da Ink e aplicava busca/ordem/filtro no
// navegador só sobre esses 100. A base agora é o histórico de pedidos (todo mundo que já fez um pedido), que
// já está agregado por identidade em `buscarClientesAgregados`; aqui só se escolhe a página. Ordenar e filtrar
// ANTES de fatiar é o que faz "mais compras primeiro" valer para a lista inteira, não para a página.
//
// Entrada: SEMPRE por lista de permissão. Valor fora dela cai no padrão — nunca é repassado ou interpretado.

const ORDENS = Object.freeze(['compras_desc', 'lucro_desc', 'inativos_primeiro', 'nome']);
const INATIVIDADES = Object.freeze([30, 60, 90, 180]);
const POR_PAGINA_PADRAO = 25;
const POR_PAGINA_MAXIMA = 100;
const PAGINA_MAXIMA = 1000;
const BUSCA_MAXIMA = 100;

const soDigitos = (v) => typeof v === 'string' && /^\d{1,4}$/.test(v);
const normalizar = (v) => String(v || '').toLowerCase();
const apenasDigitos = (v) => String(v || '').replace(/\D/g, '');

// `query` é o `req.query` cru: qualquer campo pode vir ausente, repetido (array) ou com outro tipo.
function normalizarConsulta(query = {}) {
  const page = soDigitos(query.page) && Number(query.page) >= 1 && Number(query.page) <= PAGINA_MAXIMA ? Number(query.page) : 1;
  const perPage = soDigitos(query.per_page) && Number(query.per_page) >= 1
    ? Math.min(Number(query.per_page), POR_PAGINA_MAXIMA)
    : POR_PAGINA_PADRAO;
  const ordem = typeof query.ordem === 'string' && ORDENS.includes(query.ordem) ? query.ordem : 'compras_desc';
  const inativoDias = soDigitos(query.inativoDias) && INATIVIDADES.includes(Number(query.inativoDias)) ? Number(query.inativoDias) : null;
  const busca = typeof query.busca === 'string' ? query.busca.trim().slice(0, BUSCA_MAXIMA) : '';
  return { page, perPage, ordem, inativoDias, busca };
}

function bateBusca(cliente, buscaNorm, buscaDigitos) {
  if (!buscaNorm) return true;
  if (normalizar(cliente.nome).includes(buscaNorm) || normalizar(cliente.email).includes(buscaNorm) || normalizar(cliente.telefone).includes(buscaNorm)) return true;
  // "(51) 99246" e "51992466" acham o mesmo telefone: compara também só os dígitos (a partir de 3, para não casar tudo).
  return buscaDigitos.length >= 3 && apenasDigitos(cliente.telefone).includes(buscaDigitos);
}

// Sem `diasSemComprar` (nunca comprou) conta como o mais inativo; entre dois assim, o desempate cai no nome.
function compararInatividade(a, b) {
  const semA = a.diasSemComprar == null;
  const semB = b.diasSemComprar == null;
  if (semA && semB) return 0;
  if (semA) return -1;
  if (semB) return 1;
  return b.diasSemComprar - a.diasSemComprar;
}

const COMPARADORES = Object.freeze({
  compras_desc: (a, b) => (b.totalCompras || 0) - (a.totalCompras || 0),
  lucro_desc: (a, b) => (b.lucroOperacional || 0) - (a.lucroOperacional || 0),
  inativos_primeiro: compararInatividade,
  nome: (a, b) => (a.nome || '').localeCompare(b.nome || ''),
});

// Só o que a tela usa. Nada de `legacyCustomerKeys`, totais de gasto ou qualquer outro campo interno do agregado.
function paraTela(c) {
  return {
    loja: c.loja,
    customerKey: c.customerKey,
    nome: c.nome,
    email: c.email || null,
    telefone: c.telefone || null,
    documento: c.documento || null,
    aceitaMarketing: !!c.aceitaMarketing,
    totalCompras: c.totalCompras || 0,
    lucroOperacional: c.lucroOperacional || 0,
    pedidosSemFinanceiro: c.pedidosSemFinanceiro || 0,
    ultimaCompraEm: c.ultimaCompraEm || null,
    diasSemComprar: c.diasSemComprar == null ? null : c.diasSemComprar,
  };
}

// `clientes`: saída de `buscarClientesAgregados`. `consulta`: saída de `normalizarConsulta`.
function listarClientes(clientes, consulta) {
  const { page, perPage, ordem, inativoDias, busca } = consulta;
  const buscaNorm = normalizar(busca);
  const buscaDigitos = apenasDigitos(busca);

  const filtrados = clientes.filter((c) => {
    if (!bateBusca(c, buscaNorm, buscaDigitos)) return false;
    // "Sem comprar há X+ dias" também inclui quem nunca teve compra confirmada.
    if (inativoDias == null) return true;
    return c.diasSemComprar == null || c.diasSemComprar >= inativoDias;
  });

  // Desempate por nome e depois pela chave de identidade: a mesma página vem igual em toda chamada, e uma
  // página nunca repete nem pula ninguém da vizinha.
  const comparar = COMPARADORES[ordem];
  filtrados.sort((a, b) => comparar(a, b)
    || (a.nome || '').localeCompare(b.nome || '')
    || String(a.customerKey).localeCompare(String(b.customerKey)));

  const total = filtrados.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  // Página além do fim (a lista encolheu com o filtro) volta para a última em vez de vir vazia.
  const paginaAtual = Math.min(page, totalPages);
  const inicio = (paginaAtual - 1) * perPage;

  return {
    clientes: filtrados.slice(inicio, inicio + perPage).map(paraTela),
    page: paginaAtual,
    perPage,
    totalPages,
    total,
  };
}

module.exports = { normalizarConsulta, listarClientes, ORDENS, INATIVIDADES, POR_PAGINA_PADRAO, POR_PAGINA_MAXIMA };
