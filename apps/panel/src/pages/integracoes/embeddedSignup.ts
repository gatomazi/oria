// Embedded Signup do WhatsApp · leitura da mensagem que a Meta posta na janela ao fim do fluxo.
//
// A mensagem chega por `window.postMessage`, então QUALQUER página aberta pode postar uma mensagem
// com o mesmo formato. Duas travas: a origem tem que ser o domínio da Meta (comparação exata do
// host — `endsWith('facebook.com')` aceitaria `evilfacebook.com`), e nada aqui vale por si: o
// servidor só aceita WABA e número que a Meta confirma para o token trocado pelo `code`.

export type ResultadoEmbeddedSignup =
  | { tipo: 'concluido'; wabaId: string; phoneNumberId: string; businessId: string | null }
  | { tipo: 'cancelado'; etapa: string | null }
  | { tipo: 'erro'; codigo: string | null };

const ID_META = /^[0-9]{5,32}$/;

export function origemDaMeta(origem: string): boolean {
  try {
    const host = new URL(origem).hostname;
    return new URL(origem).protocol === 'https:' && (host === 'facebook.com' || host.endsWith('.facebook.com'));
  } catch {
    return false;
  }
}

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const texto = (v: unknown) => (typeof v === 'string' ? v : null);

// null = a mensagem não é do Embedded Signup (ou não veio da Meta): ignorar.
export function interpretarMensagemEmbeddedSignup(origem: string, dados: unknown): ResultadoEmbeddedSignup | null {
  if (!origemDaMeta(origem)) return null;
  let corpo: unknown = dados;
  if (typeof dados === 'string') {
    try { corpo = JSON.parse(dados); } catch { return null; }
  }
  const msg = objeto(corpo);
  if (!msg || msg.type !== 'WA_EMBEDDED_SIGNUP') return null;
  const dado = objeto(msg.data) || {};
  if (msg.event === 'FINISH') {
    const wabaId = texto(dado.waba_id);
    const phoneNumberId = texto(dado.phone_number_id);
    if (!wabaId || !phoneNumberId || !ID_META.test(wabaId) || !ID_META.test(phoneNumberId)) return { tipo: 'erro', codigo: 'IDS_INVALIDOS' };
    const business = texto(dado.business_id);
    return { tipo: 'concluido', wabaId, phoneNumberId, businessId: business && ID_META.test(business) ? business : null };
  }
  if (msg.event === 'CANCEL') {
    if (texto(dado.error_message) || texto(dado.error_code)) return { tipo: 'erro', codigo: texto(dado.error_code) };
    return { tipo: 'cancelado', etapa: texto(dado.current_step) };
  }
  return null;
}
