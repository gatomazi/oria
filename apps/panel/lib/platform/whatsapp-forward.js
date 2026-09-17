'use strict';

// Repasse do whatsapp-webhook-go para o painel (POST /api/webhooks/whatsapp) — rodada 18, §22.
//
// Contrato: test/fixtures/whatsapp/forward-auth-v1.json (cópia idêntica no Go).
//
// Antes: o segredo ia na própria URL cadastrada no Go (`?secret=`), comparado com `!==`, e sem
// WHATSAPP_WEBHOOK_SECRET o painel aceitava qualquer POST. A URL com segredo aparece em log de
// proxy, em erro de transporte e em qualquer tela que mostre a variável.
//
// Agora:
//   X-Oria-Forward-Timestamp: <unix seconds>
//   X-Oria-Forward-Signature: v1=<hex HMAC-SHA256(segredo, timestamp + "." + corpo cru)>
// comparação em tempo constante, janela de ±300 s, `secret` na query recusado mesmo com assinatura
// válida, e sem segredo configurado nada é aceito (503). A query antiga nunca autentica.
//
// Transição sem perda de status (rodada 19, §5): com WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1
// (desligada por padrão), um `secret` na query é TOLERADO — ignorado, nunca comparado — desde que a
// assinatura em header seja válida. É o que deixa o Go em transição (query legada + assinatura, para
// o painel antigo) ser aceito por este painel sem janela de recusa. Sem a flag, continua 401.

const crypto = require('crypto');

const HEADER_TIMESTAMP = 'x-oria-forward-timestamp';
const HEADER_ASSINATURA = 'x-oria-forward-signature';
const ESQUEMA = 'v1=';
const TAMANHO_MINIMO_SEGREDO = 32;
const JANELA_SEGUNDOS = 300;
const PARAMETROS_PROIBIDOS = ['secret'];
const FLAG_TOLERANCIA_QUERY_LEGADA = 'WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED';

// Só "1" liga; vazio ou "0" desliga. Outro valor é erro de configuração: um "true" lido como
// desligado recusaria (401) os status do Go em transição sem ninguém perceber.
function lerToleranciaQueryLegada(valor) {
  const v = valor == null ? '' : String(valor).trim();
  if (v === '' || v === '0') return false;
  if (v === '1') return true;
  throw new Error(`${FLAG_TOLERANCIA_QUERY_LEGADA} inválida (aceitos: 1, 0 ou ausente)`);
}

function assinarRepasse(segredo, timestamp, corpoCru) {
  const mac = crypto.createHmac('sha256', segredo);
  mac.update(`${timestamp}.`);
  mac.update(corpoCru);
  return `${ESQUEMA}${mac.digest('hex')}`;
}

// Tempo constante mesmo com tamanhos diferentes: compara os SHA-256 das duas strings.
function iguaisEmTempoConstante(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function segredoConfigurado(segredo) {
  return typeof segredo === 'string' && segredo.length >= TAMANHO_MINIMO_SEGREDO;
}

// Boot (rodada 19, §4). Em produção a rota do repasse (POST /api/webhooks/whatsapp) está sempre
// montada e não existe interruptor que desligue o módulo WhatsApp: sem segredo válido o painel
// subiria recusando todo repasse (503) e os status de campanha se perderiam em silêncio. Então,
// em produção, segredo ausente ou curto impede o boot. Fora de produção vale o padrão dos outros
// segredos do boot (ADMIN_SESSION_SECRET, remetente 5b): não é exigido, e a rota continua falhando
// fechada (503). `motivo` nunca carrega o valor.
function exigirSegredoDeRepasseNoBoot(env = {}) {
  const producao = String(env.NODE_ENV || '').toLowerCase() === 'production';
  if (!producao || segredoConfigurado(env.WHATSAPP_WEBHOOK_SECRET)) return { ok: true };
  const estado = typeof env.WHATSAPP_WEBHOOK_SECRET === 'string' && env.WHATSAPP_WEBHOOK_SECRET !== '' ? 'curto' : 'ausente';
  return {
    ok: false,
    motivo: `WHATSAPP_WEBHOOK_SECRET ${estado} (exige ≥ ${TAMANHO_MINIMO_SEGREDO} caracteres em produção; OPS-09) — o repasse do serviço Go seria recusado`,
  };
}

// Devolve { ok: true } (com `queryLegadaTolerada: true` quando a transição ignorou um `secret` na
// query) ou { ok: false, status, motivo }. `motivo` é seguro para log (nunca carrega o segredo, a
// assinatura nem o valor da query).
function verificarRepasseWhatsapp({ segredo, headers = {}, query = {}, corpoCru, agora = Date.now(), toleraQueryLegada = false } = {}) {
  if (!segredoConfigurado(segredo)) {
    return { ok: false, status: 503, motivo: 'WHATSAPP_WEBHOOK_SECRET ausente ou curto — repasse recusado' };
  }
  let queryLegadaTolerada = false;
  if (query && PARAMETROS_PROIBIDOS.some((p) => Object.prototype.hasOwnProperty.call(query, p))) {
    if (toleraQueryLegada !== true) {
      return { ok: false, status: 401, motivo: 'segredo na query string recusado — o serviço Go precisa de WEBHOOK_FORWARD_SECRET e URL sem query' };
    }
    // Transição: o valor da query não é lido nem comparado; quem autentica é a assinatura abaixo.
    queryLegadaTolerada = true;
  }
  const timestamp = headers[HEADER_TIMESTAMP];
  const assinatura = headers[HEADER_ASSINATURA];
  if (typeof timestamp !== 'string' || !/^[0-9]{1,12}$/.test(timestamp) || typeof assinatura !== 'string' || !assinatura) {
    return { ok: false, status: 401, motivo: 'repasse sem assinatura' };
  }
  if (Math.abs(Math.floor(agora / 1000) - Number(timestamp)) > JANELA_SEGUNDOS) {
    return { ok: false, status: 401, motivo: 'repasse fora da janela de tempo' };
  }
  if (!Buffer.isBuffer(corpoCru)) {
    return { ok: false, status: 401, motivo: 'repasse sem corpo verificável' };
  }
  if (!iguaisEmTempoConstante(assinatura, assinarRepasse(segredo, timestamp, corpoCru))) {
    return { ok: false, status: 401, motivo: 'assinatura do repasse inválida' };
  }
  return queryLegadaTolerada ? { ok: true, queryLegadaTolerada } : { ok: true };
}

module.exports = {
  verificarRepasseWhatsapp,
  lerToleranciaQueryLegada,
  exigirSegredoDeRepasseNoBoot,
  assinarRepasse,
  segredoConfigurado,
  HEADER_TIMESTAMP,
  HEADER_ASSINATURA,
  ESQUEMA,
  TAMANHO_MINIMO_SEGREDO,
  JANELA_SEGUNDOS,
  PARAMETROS_PROIBIDOS,
  FLAG_TOLERANCIA_QUERY_LEGADA,
};
