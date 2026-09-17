'use strict';

// Fase 4 · INV-13 — rede de segurança contra segredo em resposta, log ou erro.
//
// A regra principal continua sendo estrutural: o plaintext só existe dentro do callback de
// `usarSegredo` e nenhuma função o devolve (lib/secrets/store.js). Esta é a segunda camada, para o
// modo de falha que a estrutura não pega — um provider que ecoa o token na mensagem de erro, um
// `res.json(err)` apressado, um log com a URL inteira.
//
// Todo segredo de tenant que passa pelo resolver de integrações é registrado aqui (em memória, com
// validade, sem persistência). Respostas HTTP e saídas de console trocam qualquer ocorrência dele
// por `***` antes de sair do processo.

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX = 2000;
const MINIMO = 12; // valor curto demais viraria falso positivo em texto comum
const MASCARA = '***';

const registrados = new Map(); // valor → expira em (ms)

function registrar(valor) {
  if (typeof valor !== 'string' || valor.length < MINIMO) return;
  registrados.delete(valor);
  registrados.set(valor, Date.now() + TTL_MS);
  while (registrados.size > MAX) registrados.delete(registrados.keys().next().value);
}

function ativos() {
  const agora = Date.now();
  const lista = [];
  for (const [valor, expira] of registrados) {
    if (expira <= agora) registrados.delete(valor);
    else lista.push(valor);
  }
  return lista;
}

function contem(texto) {
  if (typeof texto !== 'string' || !texto) return false;
  return ativos().some((v) => texto.includes(v));
}

function redigir(texto) {
  if (typeof texto !== 'string' || !texto) return texto;
  let saida = texto;
  for (const v of ativos()) if (saida.includes(v)) saida = saida.split(v).join(MASCARA);
  return saida;
}

function redigirValor(valor) {
  if (typeof valor === 'string') return redigir(valor);
  if (valor instanceof Error) {
    const copia = new Error(redigir(valor.message));
    copia.name = valor.name;
    copia.stack = redigir(valor.stack || '');
    return copia;
  }
  if (valor && typeof valor === 'object') {
    try {
      const json = JSON.stringify(valor);
      return contem(json) ? JSON.parse(redigir(json)) : valor;
    } catch {
      return valor;
    }
  }
  return valor;
}

// Console: cada argumento passa pela redação antes de ser escrito.
function instalarNoConsole(alvo = console, metodos = ['log', 'info', 'warn', 'error', 'debug']) {
  for (const m of metodos) {
    const original = alvo[m];
    if (typeof original !== 'function' || original.__secretGuard) continue;
    const protegido = function consoleProtegido(...args) {
      return original.apply(alvo, args.map(redigirValor));
    };
    protegido.__secretGuard = true;
    alvo[m] = protegido;
  }
}

// Express: res.json/res.send nunca levam um segredo registrado para fora.
function middlewareDeResposta(logger = console) {
  return function secretGuard(req, res, next) {
    const json = res.json.bind(res);
    const send = res.send.bind(res);
    res.json = (corpo) => {
      let serializado;
      try { serializado = JSON.stringify(corpo); } catch { return json(corpo); }
      if (!contem(serializado)) return json(corpo);
      logger.error(`[SECRET_GUARD] resposta de ${req.method} ${req.path} continha segredo de integração — redigida`);
      return json(JSON.parse(redigir(serializado)));
    };
    res.send = (corpo) => {
      if (typeof corpo === 'string' && contem(corpo)) {
        logger.error(`[SECRET_GUARD] resposta de ${req.method} ${req.path} continha segredo de integração — redigida`);
        return send(redigir(corpo));
      }
      return send(corpo);
    };
    next();
  };
}

function limpar() {
  registrados.clear();
}

module.exports = { registrar, contem, redigir, redigirValor, instalarNoConsole, middlewareDeResposta, limpar, MASCARA };
