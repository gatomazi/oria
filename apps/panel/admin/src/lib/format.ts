// Porte 1:1 dos helpers de formatação em src/admin/admin-utils.js (menos `el`/`api`, que não
// se aplicam em React/TS — ver components/ds e api/client.ts).

export function formatValor(valor: unknown): string | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(String(valor).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatData(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export interface TempoDesde {
  min: number;
  texto: string;
}

// Tempo decorrido curto (ex: "18 min", "3h", "2d") — usado pra priorizar carrinhos por recência.
export function tempoDesde(iso: string | null | undefined): TempoDesde | null {
  if (!iso) return null;
  let ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const min = Math.floor(ms / 60000);
  if (min < 1) return { min, texto: 'menos de 1 min' };
  if (min < 60) return { min, texto: `${min} min` };
  const horas = Math.floor(min / 60);
  if (horas < 24) return { min, texto: `${horas}h` };
  const dias = Math.floor(horas / 24);
  return { min, texto: `${dias}d` };
}

// Link wa.me a partir do telefone do cliente (formato ainda não padronizado pela Reserva Ink);
// assume DDI 55 quando o número não vem com código de país.
export function waLink(phone: string | null | undefined, mensagem: string): string | null {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length <= 11) digits = '55' + digits;
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(mensagem);
}

export function copiar(texto: string, onDone?: () => void): void {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(texto).then(() => onDone?.());
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = texto;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    onDone?.();
  } catch {
    // clipboard indisponível — falha silenciosa, igual ao comportamento vanilla
  }
  document.body.removeChild(ta);
}

// "há 3h" / "há 12min". Usado nos avisos de cache de produtos: o que importa ali é quão velho o
// dado está, não a data exata.
export function idadeDoCache(iso: string | null | undefined): string {
  if (!iso) return '';
  const minutos = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutos < 60) return `há ${minutos}min`;
  return `há ${Math.round(minutos / 60)}h`;
}

// Telefone BR legível ("(48) 99123-4567"); mantém o valor original quando não reconhece o formato.
export function formatTelefone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(phone);
}

// Plural simples pra contagens de interface ("1 pedido", "163 pedidos") — substitui "pedido(s)".
export function plural(n: number, singular: string, pluralForm: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? singular : pluralForm}`;
}

// Só a data (dd/mm/aaaa) — pra campos que a API entrega como dia, sem hora significativa.
// Data que já vem como "AAAA-MM-DD" (coluna DATE, sem hora): formata SEM passar por `new Date`.
// `new Date('2026-06-17')` é interpretado como meia-noite UTC, e em qualquer fuso a oeste de
// Greenwich `toLocaleDateString` devolve o dia anterior — foi exatamente assim que o log de
// sincronização da Meta exibiu "16/06 21:00" para um período que começava em 17/06.
export function formatDiaISO(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [ano, mes, dia] = String(iso).split('-');
  if (!ano || !mes || !dia) return '—';
  return `${dia}/${mes}/${ano}`;
}

export function formatDia(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
}
