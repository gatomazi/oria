// Regras do UTM Builder (docs/claude-utm-tracker-ga4.md, Partes 2 e 3) — usado só pra prévia em
// tempo real no Construtor. A gravação de verdade sempre reprocessa isso no backend
// (prepararUtmCampanha em server.js), então uma divergência aqui nunca corrompe o que é salvo.

// trim → minúsculas → sem acento → espaço vira "_" → só [a-z0-9_-] → sem "_" duplicado/nas pontas.
export function normalizarUtmValor(v: string): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
}

export interface UtmPartes {
  source: string;
  medium: string;
  campaign: string;
  content?: string | null;
  term?: string | null;
}

// URL + URLSearchParams (nunca concatenação manual): preserva querystring que já existia no
// destino e não duplica utm_* se o destino já vier com algum. Retorna null se não for http(s).
export function montarUrlUtm(destinationUrl: string, partes: UtmPartes): string | null {
  let url: URL;
  try {
    url = new URL(String(destinationUrl || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const source = normalizarUtmValor(partes.source);
  const medium = normalizarUtmValor(partes.medium);
  const campaign = normalizarUtmValor(partes.campaign);
  const content = normalizarUtmValor(partes.content || '');
  const term = normalizarUtmValor(partes.term || '');
  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', medium);
  url.searchParams.set('utm_campaign', campaign);
  if (content) url.searchParams.set('utm_content', content);
  else url.searchParams.delete('utm_content');
  if (term) url.searchParams.set('utm_term', term);
  else url.searchParams.delete('utm_term');
  return url.toString();
}

// Sugestões iniciais (spec, Parte 4) — só preenchem o <datalist>; o campo continua texto livre.
export const UTM_SOURCE_SUGESTOES = ['instagram', 'facebook', 'google', 'whatsapp', 'email', 'site', 'tiktok'];
export const UTM_MEDIUM_SUGESTOES = [
  'paid_social', 'organic_social', 'story', 'reel', 'banner', 'email', 'cpc', 'whatsapp', 'bio', 'card',
];

// Presets prontos pra sugerir na aba Presets quando a loja ainda não criou nenhum (spec, Parte 4).
export const UTM_PRESET_SUGESTOES: { nome: string; source: string; medium: string }[] = [
  { nome: 'Instagram Story', source: 'instagram', medium: 'story' },
  { nome: 'Meta Ads', source: 'facebook', medium: 'paid_social' },
  { nome: 'WhatsApp', source: 'whatsapp', medium: 'whatsapp' },
];
