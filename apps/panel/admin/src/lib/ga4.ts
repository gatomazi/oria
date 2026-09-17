// Formatação e vocabulário compartilhados entre a aba Performance do UTM Tracker e a tela
// Analytics GA4 — as duas leem a mesma API e precisam falar a mesma língua (mesmo "—" pra valor
// ausente, mesma casa decimal em conversão, mesmo rótulo de período).

export type PeriodoGa4 = 'hoje' | '7d' | '30d' | '90d' | 'custom';

export const PERIODOS_GA4: { valor: PeriodoGa4; rotulo: string }[] = [
  { valor: 'hoje', rotulo: 'Hoje' },
  { valor: '7d', rotulo: 'Últimos 7 dias' },
  { valor: '30d', rotulo: 'Últimos 30 dias' },
  { valor: '90d', rotulo: 'Últimos 90 dias' },
  { valor: 'custom', rotulo: 'Personalizado' },
];

// Monta a chave que o backend entende; null = período personalizado ainda incompleto.
export function chavePeriodoGa4(periodo: PeriodoGa4, inicio: string, fim: string): string | null {
  if (periodo !== 'custom') return periodo;
  return inicio && fim ? `custom:${inicio}:${fim}` : null;
}

// "(not set)" / "(not provided)" são o jeito do GA4 dizer "esse campo veio vazio" — vira travessão,
// nunca é exibido cru pro usuário nem confundido com um valor real de campanha.
const VAZIOS_GA4 = new Set(['(not set)', '(not provided)', '(none)']);

export function valorUtmVazio(v: string): boolean {
  return !v || VAZIOS_GA4.has(v);
}

export function formatUtmDim(v: string): string {
  return valorUtmVazio(v) ? '—' : v;
}

export function formatNumero(n: number): string {
  return Math.round(n).toLocaleString('pt-BR');
}

export function formatPercentual(n: number, casas = 1): string {
  return `${(n * 100).toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: casas })}%`;
}

export function formatReais(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Duração média de sessão vem em segundos no GA4 → "2m 29s".
export function formatDuracao(segundos: number): string {
  const total = Math.max(0, Math.round(segundos));
  const min = Math.floor(total / 60);
  const seg = total % 60;
  return min > 0 ? `${min}m ${seg}s` : `${seg}s`;
}

export const DIAS_DA_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Número dentro da célula do mapa de calor: precisa caber em ~40px, então acima de mil vira "1,2k".
// Hora sem sessão nenhuma fica em branco — um "0" repetido em 60 células só polui o desenho.
export function formatSessoesCelula(n: number): string {
  if (!n) return '';
  if (n >= 1000) return `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
  return String(Math.round(n));
}

// Tokens que o GA4 usa no lugar do nome da campanha quando a sessão não tinha utm_campaign. São
// literais dele, não nomes escolhidos por ninguém — traduzir é só tornar legível pra quem cuida da
// loja; o valor cru continua disponível no title da célula.
const TOKENS_GA4: Record<string, string> = {
  '(organic)': 'Busca orgânica',
  '(referral)': 'Site de referência',
  '(direct)': 'Acesso direto',
  '(data deleted)': 'Dado removido pelo GA4',
  '--sanitized--': 'Ocultado pelo GA4',
};

// O Meta preenche utm_campaign/content/term com o ID numérico do anúncio quando a loja não define
// UTM própria. Exibir 18 dígitos crus não diz nada — encurta pro fim do ID, que é o que diferencia
// um anúncio do outro, e marca a origem.
export function rotuloCampanhaGa4(campaign: string): { texto: string; idDeAnuncio: boolean } {
  if (valorUtmVazio(campaign)) return { texto: '—', idDeAnuncio: false };
  if (TOKENS_GA4[campaign]) return { texto: TOKENS_GA4[campaign], idDeAnuncio: false };
  if (/^\d{12,}$/.test(campaign)) return { texto: `Anúncio ···${campaign.slice(-6)}`, idDeAnuncio: true };
  return { texto: campaign, idDeAnuncio: false };
}
