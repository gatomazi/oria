'use strict';

// Lista paginada de Clientes (busca, ordenação, filtros e paginação no SERVIDOR).
//
// A tela antiga cortava a lista nos 100 primeiros clientes do cadastro da Ink e aplicava busca/ordem/filtro no
// navegador só sobre esses 100. A base agora é o histórico de pedidos (quem já pediu, agregado por identidade em
// `buscarClientesAgregados`) MAIS o cadastro da Ink de quem nunca pediu (`unirComCadastro`); aqui só se escolhe a
// página. Ordenar e filtrar ANTES de fatiar é o que faz "mais compras primeiro" valer para a lista inteira.
//
// `origem`: 'pedido' (tem ao menos um pedido) ou 'cadastro' (só cadastro, nunca pediu). O filtro `tipo` separa os dois.
//
// Entrada: SEMPRE por lista de permissão. Valor fora dela cai no padrão — nunca é repassado ou interpretado.

const { REGRAS, SEGMENTO_INSUFICIENTE } = require('./rfm');
const { diaValido, dataLocal } = require('./metricas');

const UFS = Object.freeze(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']);
const ORDENS = Object.freeze(['compras_desc', 'lucro_desc', 'inativos_primeiro', 'nome', 'ltv_desc']);
// Valores aceitos em `segmento`: os da RFM, mais "sem_compra" (só cadastro, sem pedido válido — fora da RFM).
const SEGMENTOS = Object.freeze([...REGRAS.map((r) => r.id), SEGMENTO_INSUFICIENTE.id, 'sem_compra']);
const MAX_SEGMENTOS = SEGMENTOS.length;
const TIPOS = Object.freeze(['todos', 'com_pedido', 'sem_pedido']);
const INATIVIDADES = Object.freeze([30, 60, 90, 180]);
const POR_PAGINA_PADRAO = 25;
const POR_PAGINA_MAXIMA = 100;
const PAGINA_MAXIMA = 1000;
const BUSCA_MAXIMA = 100;

const soDigitos = (v) => typeof v === 'string' && /^\d{1,4}$/.test(v);
const normalizar = (v) => String(v || '').toLowerCase();
// Número não negativo de até 9 dígitos, com decimais opcionais. Qualquer outra coisa vira `null` (filtro ignorado).
const numeroOuNulo = (v) => (typeof v === 'string' && /^\d{1,9}(\.\d{1,2})?$/.test(v) ? Number(v) : null);
const diaOuNulo = (v) => (diaValido(v) ? v : null);
// `segmento=a,b` (ou repetido): só ids da lista de permissão, sem repetição.
function segmentosDaConsulta(v) {
  const brutos = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string').flatMap((x) => x.split(',')).slice(0, MAX_SEGMENTOS * 2);
  return Array.from(new Set(brutos.map((x) => x.trim()).filter((x) => SEGMENTOS.includes(x))));
}
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
  const tipo = typeof query.tipo === 'string' && TIPOS.includes(query.tipo) ? query.tipo : 'todos';
  const marketing = query.marketing === 'sim' || query.marketing === 'nao' ? query.marketing : null;
  return {
    page, perPage, ordem, inativoDias, busca, tipo,
    segmentos: segmentosDaConsulta(query.segmento),
    recenciaMin: numeroOuNulo(query.recenciaMin), recenciaMax: numeroOuNulo(query.recenciaMax),
    pedidosMin: numeroOuNulo(query.pedidosMin), pedidosMax: numeroOuNulo(query.pedidosMax),
    ltvMin: numeroOuNulo(query.ltvMin), ltvMax: numeroOuNulo(query.ltvMax),
    ticketMin: numeroOuNulo(query.ticketMin), ticketMax: numeroOuNulo(query.ticketMax),
    primeiraDe: diaOuNulo(query.primeiraDe), primeiraAte: diaOuNulo(query.primeiraAte),
    ultimaDe: diaOuNulo(query.ultimaDe), ultimaAte: diaOuNulo(query.ultimaAte),
    marketing,
    // UF do endereço de entrega do pedido mais recente que a informa (captura real; lista de permissão).
    uf: typeof query.uf === 'string' && UFS.includes(query.uf.toUpperCase()) ? query.uf.toUpperCase() : null,
  };
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
  ltv_desc: (a, b) => (b.ltv || 0) - (a.ltv || 0),
});

const dentro = (valor, min, max) => valor != null && (min == null || valor >= min) && (max == null || valor <= max);
const diaDaData = (iso) => (iso ? dataLocal(new Date(iso), 'America/Sao_Paulo') : null);
const diaDentro = (iso, de, ate) => {
  const dia = diaDaData(iso);
  return dia != null && (de == null || dia >= de) && (ate == null || dia <= ate);
};

// Filtros combináveis da consulta (segmento, faixas de recência/pedidos/LTV/ticket, datas e consentimento).
// Cliente sem o campo consultado nunca casa com uma faixa; quem só tem cadastro casa apenas com `sem_compra`.
function passaFiltrosAvancados(c, q) {
  if (q.segmentos.length && !q.segmentos.includes(c.segmento || 'sem_compra')) return false;
  if ((q.recenciaMin != null || q.recenciaMax != null) && !dentro(c.diasSemComprar, q.recenciaMin, q.recenciaMax)) return false;
  if ((q.pedidosMin != null || q.pedidosMax != null) && !dentro(c.pedidosValidos || 0, q.pedidosMin, q.pedidosMax)) return false;
  if ((q.ltvMin != null || q.ltvMax != null) && !dentro(c.ltv, q.ltvMin, q.ltvMax)) return false;
  if ((q.ticketMin != null || q.ticketMax != null) && !dentro(c.ticketMedioValido, q.ticketMin, q.ticketMax)) return false;
  if ((q.primeiraDe || q.primeiraAte) && !diaDentro(c.primeiraCompraEm, q.primeiraDe, q.primeiraAte)) return false;
  if ((q.ultimaDe || q.ultimaAte) && !diaDentro(c.ultimaCompraEm, q.ultimaDe, q.ultimaAte)) return false;
  if (q.uf && c.uf !== q.uf) return false;
  if (q.marketing === 'sim' && !c.aceitaMarketing) return false;
  if (q.marketing === 'nao' && c.aceitaMarketing) return false;
  return true;
}

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
    primeiraCompraEm: c.primeiraCompraEm || null,
    diasSemComprar: c.diasSemComprar == null ? null : c.diasSemComprar,
    origem: c.origem === 'cadastro' ? 'cadastro' : 'pedido',
    // RFM (lib/clientes/rfm.js): `null` em quem não tem compra válida ou cuja base não permite classificar com segurança.
    segmento: c.segmento || null,
    segmentoNome: c.segmentoNome || null,
    rfm: c.rfm || null,
    pedidosValidos: c.pedidosValidos || 0,
    ltv: c.ltv == null ? null : c.ltv,
    ticketMedioValido: c.ticketMedioValido == null ? null : c.ticketMedioValido,
    uf: c.uf || null,
  };
}

// Junta o histórico de pedidos com o cadastro da Ink: quem já pediu vem do histórico (com totais); quem só tem
// cadastro entra sem compra. Casa por documento, depois telefone e e-mail (a mesma ordem de confiança da
// identidade dos pedidos), então o mesmo cliente nunca aparece duas vezes.
function unirComCadastro(historico, cadastro, { loja } = {}) {
  const documentos = new Set();
  const telefones = new Set();
  const emails = new Set();
  for (const h of historico) {
    if (apenasDigitos(h.documento)) documentos.add(apenasDigitos(h.documento));
    if (apenasDigitos(h.telefone)) telefones.add(apenasDigitos(h.telefone));
    if (normalizar(h.email)) emails.add(normalizar(h.email));
    for (const chave of h.legacyCustomerKeys || []) {
      // Chaves antigas do agregado (documento || telefone || e-mail) também identificam esta pessoa.
      if (apenasDigitos(chave)) { documentos.add(apenasDigitos(chave)); telefones.add(apenasDigitos(chave)); }
      if (normalizar(chave).includes('@')) emails.add(normalizar(chave));
    }
  }

  // Toda linha precisa de chave ÚNICA (a tela usa como `key` do React; repetida, ela duplica e omite linhas a
  // cada troca de filtro). A Ink não manda `id` nos clientes e duas contas podem ter o mesmo documento (a mesma
  // pessoa com dois e-mails), então a chave leva documento, telefone e e-mail — e, se ainda repetir, um sufixo.
  const usadas = new Set(historico.map((h) => String(h.customerKey)));
  const soCadastro = [];
  for (const c of cadastro) {
    const doc = apenasDigitos(c.documento);
    const tel = apenasDigitos(c.telefone);
    const email = normalizar(c.email);
    if ((doc && documentos.has(doc)) || (tel && telefones.has(tel)) || (email && emails.has(email))) continue;
    const base = `cadastro:${c.id ?? ([doc, tel, email].filter(Boolean).join('|') || 'sem-identidade')}`;
    let customerKey = base;
    for (let n = 2; usadas.has(customerKey); n += 1) customerKey = `${base}#${n}`;
    usadas.add(customerKey);
    soCadastro.push({
      loja,
      customerKey,
      nome: c.nome,
      email: c.email,
      telefone: c.telefone,
      documento: c.documento,
      aceitaMarketing: c.aceitaMarketing,
      totalCompras: 0,
      lucroOperacional: 0,
      pedidosSemFinanceiro: 0,
      ultimaCompraEm: null,
      diasSemComprar: null,
      origem: 'cadastro',
    });
  }
  return [...historico.map((h) => ({ ...h, origem: 'pedido' })), ...soCadastro];
}

// Filtra e ordena a base INTEIRA (antes de fatiar). Reusada pela exportação: o CSV leva exatamente o público da lista.
function selecionarClientes(clientes, consulta) {
  const { ordem, inativoDias, busca, tipo = 'todos' } = consulta;
  // `consulta` de teste/legado pode não trazer os campos novos: sem eles, nenhum filtro avançado se aplica.
  const q = { segmentos: [], ...consulta };
  const buscaNorm = normalizar(busca);
  const buscaDigitos = apenasDigitos(busca);

  const filtrados = clientes.filter((c) => {
    if (tipo === 'com_pedido' && c.origem === 'cadastro') return false;
    if (tipo === 'sem_pedido' && c.origem !== 'cadastro') return false;
    if (!bateBusca(c, buscaNorm, buscaDigitos)) return false;
    if (!passaFiltrosAvancados(c, q)) return false;
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
  return filtrados;
}

// `clientes`: saída de `buscarClientesAgregados`. `consulta`: saída de `normalizarConsulta`.
function listarClientes(clientes, consulta) {
  const { page, perPage } = consulta;
  const filtrados = selecionarClientes(clientes, consulta);

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

module.exports = { normalizarConsulta, listarClientes, selecionarClientes, paraTela, unirComCadastro, ORDENS, TIPOS, SEGMENTOS, INATIVIDADES, POR_PAGINA_PADRAO, POR_PAGINA_MAXIMA };
