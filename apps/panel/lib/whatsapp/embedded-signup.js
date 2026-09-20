'use strict';

// WhatsApp · Embedded Signup (Tech Provider).
//
// O navegador do cliente conclui o fluxo da Meta e devolve ao painel três identificadores (WABA,
// número, business) mais um `code` de 30 segundos. NADA disso é confiável por vir do navegador: o
// painel troca o `code` pelo token do cliente e só aceita a WABA e o número que a própria Meta
// confirma que esse token enxerga. Um `waba_id` forjado no corpo da requisição não passa por aqui.
//
// A ordem em `concluir` é a do risco: primeiro prova (token do NOSSO app, WABA concedida ao token,
// número pertencente à WABA), depois o que muda o mundo (assinar webhooks, registrar o número). O
// painel decide o resto (posse do recurso, gravação cifrada) com o que este módulo devolve.
//
// O token nunca aparece em mensagem de erro, log ou resposta: os erros daqui carregam só um código.
const crypto = require('crypto');

const GRAPH = 'https://graph.facebook.com';
const VERSAO_PADRAO = 'v25.0';
const ID_RE = /^[0-9]{5,32}$/;
// `code` do Embedded Signup: opaco, curto. Limita tamanho e alfabeto antes de ir a qualquer URL.
const CODE_RE = /^[A-Za-z0-9_.~+/=-]{10,2048}$/;
const TIMEOUT_MS = 15000;

class EmbeddedSignupError extends Error {
  constructor(message, { codigo, status }) {
    super(message);
    this.name = 'EmbeddedSignupError';
    this.codigo = codigo;
    this.status = status;
  }
}

const erro = (codigo, status, message) => new EmbeddedSignupError(message, { codigo, status });

const idValido = (v) => typeof v === 'string' && ID_RE.test(v);

// Valida o que veio do navegador. Não prova nada: só barra formato antes de gastar chamada à Meta.
function validarEntrada({ code, wabaId, phoneNumberId, businessId }) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw erro('ES_CODE_INVALID', 400, 'código de autorização inválido');
  if (!idValido(wabaId)) throw erro('ES_WABA_INVALID', 400, 'ID da conta do WhatsApp inválido');
  if (!idValido(phoneNumberId)) throw erro('ES_PHONE_INVALID', 400, 'ID do número inválido');
  if (businessId !== undefined && businessId !== null && businessId !== '' && !idValido(businessId)) {
    throw erro('ES_BUSINESS_INVALID', 400, 'ID do business inválido');
  }
  if (wabaId === phoneNumberId) throw erro('ES_IDS_EQUAIS', 400, 'o ID do número e o da conta são diferentes');
}

// PIN da verificação em duas etapas do número (6 dígitos). Gerado aqui, guardado cifrado: o
// cliente não precisa saber dele, e a Meta o pede para registrar/re-registrar o número.
function gerarPin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function criarClienteEmbeddedSignup({ appId, appSecret, apiVersion = VERSAO_PADRAO, fetchFn = null }) {
  if (!idValido(String(appId || '')) || typeof appSecret !== 'string' || !appSecret) {
    throw new Error('criarClienteEmbeddedSignup exige appId e appSecret');
  }
  // Resolve o fetch na hora da chamada: o harness de testes troca `globalThis.fetch`.
  const chamar = (url, init) => (fetchFn || globalThis.fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

  // appsecret_proof: a Meta exige (se o app tiver "Require App Secret") o HMAC do token com o segredo.
  const prova = (token) => crypto.createHmac('sha256', appSecret).update(token).digest('hex');

  async function ler(res, codigoFalha) {
    let corpo = null;
    try { corpo = await res.json(); } catch { /* corpo ilegível: vale só o status */ }
    if (!res.ok) {
      // 5xx/429 da Meta: indisponível agora, vale tentar de novo. 4xx: recusa definitiva.
      const transitorio = res.status >= 500 || res.status === 429;
      throw erro(codigoFalha, transitorio ? 502 : 400, transitorio ? 'a Meta está indisponível agora — tente de novo em instantes' : 'a Meta recusou o pedido');
    }
    return corpo || {};
  }

  function urlDe(caminho, params = {}) {
    const url = new URL(`${GRAPH}/${apiVersion}/${caminho}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  const comToken = (token) => ({ Authorization: `Bearer ${token}` });

  async function trocarCode(code) {
    const res = await chamar(urlDe('oauth/access_token', { client_id: appId, client_secret: appSecret, code }), {});
    const corpo = await ler(res, 'ES_CODE_EXCHANGE_FAILED');
    if (typeof corpo.access_token !== 'string' || !corpo.access_token) throw erro('ES_CODE_EXCHANGE_FAILED', 400, 'a Meta não devolveu o token');
    const expiraEm = Number.isFinite(Number(corpo.expires_in)) && Number(corpo.expires_in) > 0
      ? new Date(Date.now() + Number(corpo.expires_in) * 1000) : null;
    return { accessToken: corpo.access_token, expiraEm };
  }

  // Confere o token pela própria Meta (com o token do APP, não com o do cliente).
  async function inspecionarToken(token) {
    const res = await chamar(urlDe('debug_token', { input_token: token, access_token: `${appId}|${appSecret}` }), {});
    const dados = (await ler(res, 'ES_TOKEN_INSPECT_FAILED')).data || {};
    return {
      valido: dados.is_valid === true,
      appId: dados.app_id === undefined ? null : String(dados.app_id),
      escopos: Array.isArray(dados.scopes) ? dados.scopes.map(String) : [],
      concedidos: Array.isArray(dados.granular_scopes) ? dados.granular_scopes : [],
    };
  }

  async function listarNumeros(wabaId, token) {
    const res = await chamar(urlDe(`${wabaId}/phone_numbers`, {
      fields: 'id,display_phone_number,verified_name', limit: '100', appsecret_proof: prova(token),
    }), { headers: comToken(token) });
    const corpo = await ler(res, 'ES_PHONE_LIST_FAILED');
    return (Array.isArray(corpo.data) ? corpo.data : []).map((n) => ({
      id: String(n.id), numeroExibido: typeof n.display_phone_number === 'string' ? n.display_phone_number : null,
      nomeVerificado: typeof n.verified_name === 'string' ? n.verified_name : null,
    }));
  }

  async function assinarWebhooks(wabaId, token) {
    const res = await chamar(urlDe(`${wabaId}/subscribed_apps`, { appsecret_proof: prova(token) }), {
      method: 'POST', headers: comToken(token),
    });
    await ler(res, 'ES_SUBSCRIBE_FAILED');
  }

  async function registrarNumero(phoneNumberId, token, pin) {
    const res = await chamar(urlDe(`${phoneNumberId}/register`, { appsecret_proof: prova(token) }), {
      method: 'POST', headers: { ...comToken(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    await ler(res, 'ES_REGISTER_FAILED');
  }

  // Prova, em ordem, o que o navegador afirmou. Devolve o que é seguro gravar.
  async function provar({ code, wabaId, phoneNumberId }) {
    const { accessToken, expiraEm } = await trocarCode(code);
    const info = await inspecionarToken(accessToken);
    if (!info.valido) throw erro('ES_TOKEN_INVALID', 400, 'a Meta considera o token inválido');
    // Token de OUTRO app (colado de fora, ou de outra plataforma) não vale para este.
    if (info.appId !== String(appId)) throw erro('ES_TOKEN_OTHER_APP', 403, 'o token não pertence ao app do Oria');
    const concedeuWaba = info.concedidos.some((g) => (g.scope === 'whatsapp_business_management' || g.scope === 'whatsapp_business_messaging')
      && Array.isArray(g.target_ids) && g.target_ids.map(String).includes(wabaId));
    if (!concedeuWaba) throw erro('ES_WABA_NOT_GRANTED', 403, 'a Meta não concedeu acesso a esta conta do WhatsApp');
    const numero = (await listarNumeros(wabaId, accessToken)).find((n) => n.id === phoneNumberId);
    if (!numero) throw erro('ES_PHONE_NOT_IN_WABA', 403, 'este número não pertence à conta do WhatsApp informada');
    return { accessToken, expiraEm, numero };
  }

  return { provar, assinarWebhooks, registrarNumero, trocarCode, inspecionarToken, listarNumeros };
}

module.exports = { EmbeddedSignupError, criarClienteEmbeddedSignup, validarEntrada, gerarPin, VERSAO_PADRAO, ID_RE };
