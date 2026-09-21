'use strict';

// WhatsApp · erro da Meta → mensagem de produto (lib/whatsapp/erros.js).
// Achado do smoke em produção (2026-09-21): o assistente de campanha mostrava o JSON cru da Meta
// ("meta api 401: {"error":{"message":"Error validating access token…","fbtrace_id":…}}").

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const { classificarErroWhatsapp } = h.sujeito('lib/whatsapp/erros.js');

const meta = (statusMeta, erro) => `meta api ${statusMeta}: ${JSON.stringify({ error: erro })}`;

test('Given o erro real do smoke (token de 24 h vencido), When classificar, Then é token expirado, sem JSON cru', () => {
  const bruto = meta(401, { message: 'Error validating access token: Session has expired on Sunday, 20-Sep-26 16:00:00 PDT.', type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'AgNIN' });
  const c = classificarErroWhatsapp(500, bruto);
  assert.equal(c.codigo, 'WHATSAPP_TOKEN_EXPIRED');
  assert.equal(c.httpStatus, 409);
  assert.equal(c.tokenInvalido, true);
  assert.match(c.mensagem, /cole um token novo em Integrações/);
  assert.doesNotMatch(c.mensagem, /fbtrace|OAuthException|PDT|\{|\}/);
});

test('Given 401 mesmo sem código, When classificar, Then também é token expirado', () => {
  assert.equal(classificarErroWhatsapp(500, meta(401, { message: 'x' })).codigo, 'WHATSAPP_TOKEN_EXPIRED');
});

test('Given 130497 (país restrito), When classificar, Then explica o modo de teste — e não é token inválido', () => {
  const c = classificarErroWhatsapp(500, meta(400, { code: 130497, message: 'Business account is restricted from messaging users in this country.' }));
  assert.equal(c.codigo, 'WHATSAPP_COUNTRY_RESTRICTED');
  assert.equal(c.tokenInvalido, false);
  assert.match(c.mensagem, /modo de teste|sem verificação/);
});

test('Given permissão, limite e destinatário de teste, When classificar, Then cada um tem código e status próprios', () => {
  assert.deepEqual([classificarErroWhatsapp(500, meta(403, { code: 10 })).codigo, classificarErroWhatsapp(500, meta(403, { code: 10 })).httpStatus], ['WHATSAPP_PERMISSION_DENIED', 403]);
  assert.equal(classificarErroWhatsapp(500, meta(400, { code: 200 })).codigo, 'WHATSAPP_PERMISSION_DENIED');
  assert.deepEqual([classificarErroWhatsapp(500, meta(429, { code: 130429 })).codigo, classificarErroWhatsapp(500, meta(429, { code: 130429 })).httpStatus], ['WHATSAPP_RATE_LIMITED', 429]);
  assert.equal(classificarErroWhatsapp(500, meta(400, { code: 131030 })).codigo, 'WHATSAPP_RECIPIENT_NOT_ALLOWED');
});

test('Given erro desconhecido da Meta, When classificar, Then genérico — usa a mensagem amigável da Meta quando existe, nunca o corpo', () => {
  const generico = classificarErroWhatsapp(500, meta(400, { code: 999, message: 'segredo interno', fbtrace_id: 'X' }));
  assert.equal(generico.codigo, 'WHATSAPP_PROVIDER_ERROR');
  assert.doesNotMatch(generico.mensagem, /segredo interno|fbtrace/);
  const amigavel = classificarErroWhatsapp(500, meta(400, { code: 999, error_user_msg: 'O template não foi aprovado.' }));
  assert.equal(amigavel.mensagem, 'O template não foi aprovado.');
});

test('Given mensagem que não é da Meta, When classificar, Then null (o chamador mantém a original)', () => {
  assert.equal(classificarErroWhatsapp(503, 'whatsapp-webhook-go respondeu 503'), null);
  assert.equal(classificarErroWhatsapp(500, undefined), null);
});
