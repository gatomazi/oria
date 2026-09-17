'use strict';

const { TokenInvalidoError } = require('./envio');

const TIMEOUT_MS = 15 * 1000;

// Só https (o token vai no header). http é aceito apenas pra localhost em desenvolvimento.
function validarUrlPainel(valor) {
  let url;
  try {
    url = new URL(String(valor || '').trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.origin;
}

function criarClientePainel({ obterUrl, obterToken, fetchImpl = fetch }) {
  async function post(caminho, corpo) {
    const base = validarUrlPainel(obterUrl());
    const token = obterToken();
    if (!base) throw new Error('URL do painel inválida');
    if (!token) throw new TokenInvalidoError('token não configurado');

    const resposta = await fetchImpl(`${base}${caminho}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(corpo || {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (resposta.status === 401) throw new TokenInvalidoError('token recusado');
    // 409 no resultado = item já não estava reservado (cancelado no painel) — não é erro do app.
    if (resposta.status === 409) return { conflito: true };
    if (!resposta.ok) throw new Error(`painel respondeu ${resposta.status}`);
    return resposta.json();
  }

  return {
    heartbeat: (dados) => post('/api/whatsapp-web-agente/heartbeat', dados),
    claim: () => post('/api/whatsapp-web-agente/claim', {}),
    resultado: (id, corpo) => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('id inválido');
      return post(`/api/whatsapp-web-agente/${id}/resultado`, corpo);
    },
  };
}

module.exports = { criarClientePainel, validarUrlPainel };
