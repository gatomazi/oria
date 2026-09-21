'use strict';

// Erros do WhatsApp (Meta, via serviço de envio) → algo que a tela sabe explicar.
//
// O serviço Go repassa o erro da Meta embutido numa string ("meta api 401: {…}"). Sem tratamento, o
// admin via o JSON cru — com fbtrace_id, timestamp em PDT e tudo — no meio do assistente de campanha.
// Aqui o par (status, mensagem) vira um código estável, uma mensagem de produto e o status HTTP que
// o painel devolve. O corpo bruto da Meta nunca sai daqui.
//
//   WHATSAPP_TOKEN_EXPIRED       token expirado ou revogado (Meta 190/102, ou 401)  → 409, "atualize o token"
//   WHATSAPP_PERMISSION_DENIED   o token não tem a permissão (Meta 10, 200–299)     → 403
//   WHATSAPP_RATE_LIMITED        limite de envio/API (Meta 4, 17, 613, 80007, 130429) → 429
//   WHATSAPP_COUNTRY_RESTRICTED  conta restrita para aquele país (Meta 130497)      → 409, "modo de teste"
//   WHATSAPP_RECIPIENT_NOT_ALLOWED  número de teste só envia a destinatários verificados (131030) → 409
//   WHATSAPP_PROVIDER_ERROR      qualquer outra recusa da Meta                       → 502

const PADRAO_ERRO_META = /meta api (\d{3}):\s*(\{.*\})/s;

function extrairErroMeta(texto) {
  const m = typeof texto === 'string' ? texto.match(PADRAO_ERRO_META) : null;
  if (!m) return { statusMeta: null, erro: null };
  try {
    const erro = JSON.parse(m[2]).error || null;
    return { statusMeta: Number(m[1]), erro };
  } catch {
    return { statusMeta: Number(m[1]), erro: null };
  }
}

// Devolve null quando a mensagem não é um erro da Meta embutido (o chamador mantém a mensagem original).
function classificarErroWhatsapp(status, mensagem) {
  const { statusMeta, erro } = extrairErroMeta(mensagem);
  if (statusMeta === null) return null;
  const code = erro && erro.code !== undefined ? Number(erro.code) : null;

  if (code === 190 || code === 102 || statusMeta === 401) {
    return {
      codigo: 'WHATSAPP_TOKEN_EXPIRED', httpStatus: 409, tokenInvalido: true,
      mensagem: 'o token do WhatsApp expirou ou foi revogado — cole um token novo em Integrações › Número do WhatsApp',
    };
  }
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return { codigo: 'WHATSAPP_PERMISSION_DENIED', httpStatus: 403, tokenInvalido: false, mensagem: 'o token do WhatsApp não tem permissão para esta operação — confira as permissões do token em Integrações' };
  }
  if (code === 130497) {
    return { codigo: 'WHATSAPP_COUNTRY_RESTRICTED', httpStatus: 409, tokenInvalido: false, mensagem: 'a conta do WhatsApp está restrita para enviar mensagens a este país (modo de teste ou conta ainda sem verificação)' };
  }
  if (code === 131030) {
    return { codigo: 'WHATSAPP_RECIPIENT_NOT_ALLOWED', httpStatus: 409, tokenInvalido: false, mensagem: 'o número de teste só envia para destinatários verificados na Meta' };
  }
  if (code === 4 || code === 17 || code === 613 || code === 80007 || code === 130429 || statusMeta === 429) {
    return { codigo: 'WHATSAPP_RATE_LIMITED', httpStatus: 429, tokenInvalido: false, mensagem: 'a Meta está limitando as requisições do WhatsApp agora — tente de novo em instantes' };
  }
  // Mensagem amigável da própria Meta, quando ela manda.
  const amigavel = erro && (erro.error_user_msg || null);
  return {
    codigo: 'WHATSAPP_PROVIDER_ERROR', httpStatus: status >= 500 ? 502 : 502, tokenInvalido: false,
    mensagem: amigavel || 'a Meta recusou o pedido do WhatsApp — tente de novo ou confira o número em Integrações',
  };
}

module.exports = { classificarErroWhatsapp, extrairErroMeta };
