'use strict';

// Cadastro de clientes da Reserva Ink, inteiro (todas as páginas), com cache curto por Store.
//
// A lista de Clientes mostra quem já pediu (histórico local) E quem só tem cadastro. O cadastro é remoto e
// paginado (100 por página); percorrê-lo a cada abertura de tela custaria dezenas de chamadas contra a cota da
// Ink. Por isso: (1) lê no máximo `maxPaginas` páginas, poucas por vez; (2) guarda o resultado por alguns
// minutos; (3) uma leitura já em andamento é COMPARTILHADA (dois usuários abrindo a tela juntos = uma só rodada).
//
// Segurança: a chave do cache é montada por quem chama com a Organization E a Store do contexto (nunca vinda do
// request). Cada chave guarda o cadastro só daquela Store; erro nunca é guardado (a próxima abertura tenta de novo).

const TTL_PADRAO_MS = 5 * 60 * 1000;
const MAX_PAGINAS_PADRAO = 100; // 10.000 clientes; acima disso o resultado sai marcado como parcial
const CONCORRENCIA_PADRAO = 3;
const MAX_CHAVES = 50;

const cliente = (c) => ({
  id: c.id == null ? null : String(c.id),
  nome: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null,
  email: c.email || null,
  telefone: c.phone || null,
  documento: c.document || null,
  aceitaMarketing: !!c.accepts_marketing,
});

// `carregarPagina(n)` devolve `{ customers, total_pages }` (a resposta da Ink). A 1ª página diz quantas existem.
async function lerCadastroCompleto(carregarPagina, { maxPaginas = MAX_PAGINAS_PADRAO, concorrencia = CONCORRENCIA_PADRAO } = {}) {
  const primeira = await carregarPagina(1);
  const totalPaginas = Math.max(1, Number(primeira.total_pages) || 1);
  const ate = Math.min(totalPaginas, maxPaginas);
  const paginas = [primeira.customers || []];

  let proxima = 2;
  const trabalhar = async () => {
    while (proxima <= ate) {
      const numero = proxima;
      proxima += 1;
      const r = await carregarPagina(numero);
      paginas[numero - 1] = r.customers || [];
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(concorrencia, ate - 1)) }, trabalhar));

  // Cadastro repetido entre páginas (a Ink pode mexer na ordem entre duas chamadas) não vira cliente duplicado.
  const vistos = new Set();
  const clientes = [];
  for (const pagina of paginas) {
    for (const bruto of pagina || []) {
      const c = cliente(bruto);
      const chave = c.id ?? `${c.documento}|${c.telefone}|${c.email}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      clientes.push(c);
    }
  }
  return { clientes, parcial: totalPaginas > maxPaginas, totalPaginas };
}

function criarCacheDoCadastro({ ttlMs = TTL_PADRAO_MS, agora = Date.now, ...opcoesDeLeitura } = {}) {
  const guardados = new Map(); // chave -> { valor, expiraEm }
  const emAndamento = new Map(); // chave -> Promise

  async function obter(chave, carregarPagina) {
    if (typeof chave !== 'string' || !chave) throw new Error('cadastro sem chave de Store');
    const guardado = guardados.get(chave);
    if (guardado && guardado.expiraEm > agora()) return guardado.valor;
    if (emAndamento.has(chave)) return emAndamento.get(chave);

    const leitura = lerCadastroCompleto(carregarPagina, opcoesDeLeitura)
      .then((r) => {
        const valor = { ...r, carregadoEm: new Date(agora()).toISOString() };
        // Teto de chaves: descarta a mais antiga em vez de crescer sem limite.
        if (guardados.size >= MAX_CHAVES) guardados.delete(guardados.keys().next().value);
        guardados.set(chave, { valor, expiraEm: agora() + ttlMs });
        return valor;
      })
      .finally(() => emAndamento.delete(chave));
    emAndamento.set(chave, leitura);
    return leitura;
  }

  return { obter, limpar: () => { guardados.clear(); } };
}

module.exports = { lerCadastroCompleto, criarCacheDoCadastro, TTL_PADRAO_MS, MAX_PAGINAS_PADRAO, CONCORRENCIA_PADRAO };
