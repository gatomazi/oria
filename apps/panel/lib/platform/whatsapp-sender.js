'use strict';

// Fase 5b · remetente WhatsApp da Organization (INV-25, INV-27, INV-28).
//
// O painel é a autoridade do remetente. Para cada chamada ao whatsapp-webhook-go:
//
//   Organization do contexto → integração `whatsapp` → config (phone_number_id, waba_id)
//                                                    + segredo access_token da MESMA integração
//
// e o par sai junto, num objeto só (`remetente`). Número de uma integração com token de outra não
// tem como ser montado: os dois saem da mesma linha, na mesma leitura. Nada vem do navegador, e
// nada vem do serviço Go (o /health dele não informa mais número nenhum).
//
// Referência assinada: para envios que o Go dispara depois, sem requisição do painel (fila do
// dashboard, retry de status "failed"), ele guarda só `v1.<payload>.<hmac>`, com payload
// {o: Organization, i: integração, p: número}. Na hora de despachar, devolve a referência ao painel
// (POST /api/internal/whatsapp/sender), que confere a assinatura, entra no contexto daquela
// Organization e resolve o par de novo — ou recusa se a integração mudou de número ou foi
// desconectada. O token nunca é copiado para o banco do Go.
//
// Contrato dos headers: test/fixtures/whatsapp/sender-contract-v1.json (a mesma cópia vive no
// repositório do Go, em testdata/).
//
// Fase 5c: a entrada (webhook da Meta) chega ao Go sem Organization. O Go pergunta ao painel pelo
// par (WABA, número) — ou pela referência, para chamadas internas — e recebe o CONTEXTO: a
// Organization, a integração, a referência assinada e o comportamento configurado (texto da
// resposta automática, número do aviso). Nunca o token: para enviar, a referência continua sendo
// trocada no resolver da 5b.

const crypto = require('crypto');
const { contextoAtual } = require('./tenant-runtime');

const PROVIDER = 'whatsapp';
const META_ID_RE = /^[0-9]{5,32}$/;
const TOKEN_RE = /^[A-Za-z0-9._|~+/=-]+$/;
const TOKEN_MIN = 16;
const TOKEN_MAX = 4096;
const REF_RE = /^v1\.([A-Za-z0-9_-]{16,1000})\.([A-Za-z0-9_-]{43})$/;
const TELEFONE_RE = /^[0-9]{10,15}$/;
const MAX_MENSAGEM_RESPOSTA = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXTO_HMAC = 'whatsapp-sender-ref-v1';

const HEADERS = Object.freeze({
  phoneNumberId: 'X-Sender-Phone-Number-Id',
  wabaId: 'X-Sender-Waba-Id',
  accessToken: 'X-Sender-Access-Token',
  ref: 'X-Sender-Ref',
});

class RemetenteError extends Error {
  constructor(message, { codigo, status }) {
    super(message);
    this.name = 'RemetenteError';
    this.codigo = codigo;
    this.status = status;
  }
}

const tokenValido = (t) => typeof t === 'string' && t.length >= TOKEN_MIN && t.length <= TOKEN_MAX && TOKEN_RE.test(t);
const idMetaValido = (v) => typeof v === 'string' && META_ID_RE.test(v);

// O token não é enumerável nem entra em JSON: `console.log(remetente)`, `JSON.stringify` e o spread
// não o levam para lugar nenhum. Só `remetente.accessToken`, explícito, o lê.
function criarRemetente({ organizationId, storeId = null, businessId = null, integrationId, phoneNumberId, wabaId, accessToken, ref, comportamento }) {
  const publico = { organizationId, storeId, businessId, integrationId, phoneNumberId, wabaId, comportamento };
  const remetente = { ...publico, ref };
  Object.defineProperty(remetente, 'accessToken', { value: accessToken, enumerable: false });
  Object.defineProperty(remetente, 'toJSON', { value: () => ({ ...publico }), enumerable: false });
  return Object.freeze(remetente);
}

// Headers do contrato painel → Go. Só existem dentro do callback de `comRemetente`.
function headersDoRemetente(remetente) {
  return {
    [HEADERS.phoneNumberId]: remetente.phoneNumberId,
    [HEADERS.wabaId]: remetente.wabaId,
    [HEADERS.accessToken]: remetente.accessToken,
    [HEADERS.ref]: remetente.ref,
  };
}

// Valida o que o owner digita na tela. Mensagens citam o campo, nunca o valor.
function validarConfiguracao({ phoneNumberId, wabaId, accessToken }) {
  if (!idMetaValido(phoneNumberId)) return 'o ID do número tem só números (5 a 32 dígitos)';
  if (!idMetaValido(wabaId)) return 'o ID da conta do WhatsApp (WABA) tem só números (5 a 32 dígitos)';
  if (phoneNumberId === wabaId) return 'o ID do número e o ID da conta (WABA) são diferentes — confira os dois';
  if (accessToken !== undefined && !tokenValido(accessToken)) return 'token do WhatsApp em formato inválido';
  return null;
}

// Comportamento por Organization (Fase 5c): o que o serviço Go fazia com variáveis de ambiente
// (REPLY_REDIRECT_MESSAGE, REPLY_NOTIFY_NUMBER) é configuração da loja. Vazio desliga.
function validarComportamento({ replyRedirectMessage, notifyNumber }) {
  if (replyRedirectMessage !== undefined) {
    if (typeof replyRedirectMessage !== 'string') return 'mensagem de resposta automática inválida';
    if (replyRedirectMessage.length > MAX_MENSAGEM_RESPOSTA) return `a mensagem de resposta automática passa de ${MAX_MENSAGEM_RESPOSTA} caracteres`;
  }
  if (notifyNumber !== undefined && notifyNumber !== '' && !(typeof notifyNumber === 'string' && TELEFONE_RE.test(notifyNumber))) {
    return 'o número do aviso tem só dígitos, com DDI (10 a 15)';
  }
  return null;
}

function comportamentoDaConfig(config) {
  return Object.freeze({
    replyRedirectMessage: typeof config.reply_redirect_message === 'string' ? config.reply_redirect_message : '',
    notifyNumber: typeof config.notify_number === 'string' && TELEFONE_RE.test(config.notify_number) ? config.notify_number : '',
  });
}

// Contexto que o Go recebe (sem token). Mesmo formato para entrada e para referência.
function contextoParaServico(remetente) {
  return {
    organization_id: remetente.organizationId,
    store_id: remetente.storeId,
    business_id: remetente.businessId,
    integration_id: remetente.integrationId,
    phone_number_id: remetente.phoneNumberId,
    waba_id: remetente.wabaId,
    sender_ref: remetente.ref,
    reply: {
      redirect_message: remetente.comportamento.replyRedirectMessage,
      notify_number: remetente.comportamento.notifyNumber,
    },
  };
}

// integracoes: createIntegrationResolver(...). segredoRef: WHATSAPP_SENDER_REF_SECRET (plataforma).
function createWhatsappSender({ integracoes, segredoRef }) {
  if (!integracoes) throw new Error('createWhatsappSender exige o resolver de integrações');
  const chave = segredoRef && String(segredoRef).length >= 32 ? Buffer.from(String(segredoRef)) : null;

  function exigirChave() {
    if (!chave) {
      throw new RemetenteError('referência de remetente indisponível (WHATSAPP_SENDER_REF_SECRET)', {
        codigo: 'SENDER_REF_UNAVAILABLE', status: 503,
      });
    }
  }

  const assinatura = (payload) => crypto.createHmac('sha256', chave).update(`${CONTEXTO_HMAC}.${payload}`).digest('base64url');

  function assinarRef({ organizationId, integrationId, phoneNumberId }) {
    exigirChave();
    const payload = Buffer.from(JSON.stringify({ v: 1, o: organizationId, i: String(integrationId), p: phoneNumberId })).toString('base64url');
    return `v1.${payload}.${assinatura(payload)}`;
  }

  // Referência vinda do Go: só vale com assinatura deste painel. Devolve o que ela afirma; quem
  // chama ainda confere contra a integração atual.
  function lerRef(ref) {
    exigirChave();
    const invalida = () => new RemetenteError('referência de remetente inválida', { codigo: 'SENDER_REF_INVALID', status: 400 });
    const m = typeof ref === 'string' ? REF_RE.exec(ref) : null;
    if (!m) throw invalida();
    const esperada = Buffer.from(assinatura(m[1]));
    const recebida = Buffer.from(m[2]);
    if (esperada.length !== recebida.length || !crypto.timingSafeEqual(esperada, recebida)) throw invalida();
    let dados;
    try {
      dados = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    } catch {
      throw invalida();
    }
    if (!dados || dados.v !== 1 || !UUID_RE.test(String(dados.o)) || !/^[0-9]{1,19}$/.test(String(dados.i)) || !idMetaValido(dados.p)) {
      throw invalida();
    }
    return { organizationId: String(dados.o).toLowerCase(), integrationId: String(dados.i), phoneNumberId: dados.p };
  }

  // Entrega o remetente da Organization do contexto a `usar`. Integração ausente, incompleta ou
  // com token vencido falha — nunca cai para outro remetente.
  async function comRemetente(usar) {
    const ctx = contextoAtual();
    if (!ctx) {
      throw new RemetenteError('remetente fora de um contexto de Organization', { codigo: 'TENANT_CONTEXT_REQUIRED', status: 500 });
    }
    exigirChave();
    return integracoes.usarSegredo(PROVIDER, 'access_token', async (token, meta) => {
      const config = (meta && meta.config) || {};
      const phoneNumberId = String(config.phone_number_id || '');
      const wabaId = String(config.waba_id || '');
      if (!meta || !meta.integracaoId || !idMetaValido(phoneNumberId) || !idMetaValido(wabaId) || !tokenValido(token)) {
        throw new RemetenteError('integração de WhatsApp incompleta nesta organization', { codigo: 'SENDER_INCOMPLETE', status: 409 });
      }
      // O número tem um dono só (PD-016). Um número que é de outra Organization — config alterada
      // fora da tela, import errado — não sai com o token desta: falha antes do envio.
      await integracoes.reivindicarRecurso(PROVIDER, 'phone_number', phoneNumberId);
      await integracoes.reivindicarRecurso(PROVIDER, 'waba', wabaId);
      const integrationId = String(meta.integracaoId);
      // Identidade canônica gravada pelo Embedded Signup. Config antiga (cadastro manual) não tem: vai nulo.
      const storeId = UUID_RE.test(String(config.store_id || '')) ? String(config.store_id).toLowerCase() : null;
      const businessId = idMetaValido(String(config.business_id || '')) ? String(config.business_id) : null;
      return usar(criarRemetente({
        organizationId: ctx.organizationId,
        storeId,
        businessId,
        integrationId,
        phoneNumberId,
        wabaId,
        accessToken: token,
        ref: assinarRef({ organizationId: ctx.organizationId, integrationId, phoneNumberId }),
        comportamento: comportamentoDaConfig(config),
      }));
    });
  }

  // Contexto da Organization do contexto para o serviço Go, conferido contra o que o evento (ou a
  // referência) afirma. Qualquer divergência — outra WABA, outro número, outra integração — é 409.
  async function contextoConferido({ wabaId = null, phoneNumberId = null, integrationId = null }) {
    return comRemetente((r) => {
      const diverge = (wabaId !== null && r.wabaId !== wabaId)
        || (phoneNumberId !== null && r.phoneNumberId !== phoneNumberId)
        || (integrationId !== null && r.integrationId !== integrationId);
      if (diverge) {
        throw new RemetenteError('o remetente desta Organization não confere com o pedido', { codigo: 'SENDER_CHANGED', status: 409 });
      }
      return contextoParaServico(r);
    });
  }

  return { comRemetente, contextoConferido, assinarRef, lerRef, disponivel: () => !!chave };
}

module.exports = {
  PROVIDER,
  HEADERS,
  META_ID_RE,
  TOKEN_RE,
  TOKEN_MIN,
  TOKEN_MAX,
  REF_RE,
  RemetenteError,
  createWhatsappSender,
  headersDoRemetente,
  validarConfiguracao,
  validarComportamento,
  comportamentoDaConfig,
  contextoParaServico,
  TELEFONE_RE,
};
