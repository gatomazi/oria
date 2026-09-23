import type { PredicadoRfm } from '../../api/clientes';
import { formatValor } from '../../lib/format';

export const pct = (v: number | null | undefined, casas = 1): string =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;

export const numero = (v: number | null | undefined): string => (v == null ? '—' : v.toLocaleString('pt-BR'));

export const decimal = (v: number | null | undefined, casas = 2): string =>
  v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

const moeda = (v: number): string => formatValor(v) ?? '—';

// A regra numérica do segmento em linguagem do lojista (recência, frequência e valor) — a mesma que vira filtro de campanha.
export function descreverPredicado(p: PredicadoRfm): { rotulo: string; texto: string }[] {
  const linhas: { rotulo: string; texto: string }[] = [];
  const r = p.recenciaDias;
  linhas.push({
    rotulo: 'Última compra',
    texto: r.max == null ? `há mais de ${r.min - 1} dias` : r.min === 0 ? `até ${r.max} dias atrás` : `entre ${r.min} e ${r.max} dias atrás`,
  });
  if (p.frequencia) {
    const { min, max } = p.frequencia;
    linhas.push({
      rotulo: 'Compras (na janela)',
      texto: min != null && max != null ? (min === max ? `${min}` : `${min} a ${max}`) : min != null ? `${min} ou mais` : `até ${max}`,
    });
  }
  if (p.valor) {
    linhas.push({
      rotulo: p.valor.metrica === 'ticket_medio' ? 'Ticket médio' : 'Valor comprado',
      texto: p.valor.min != null ? `${moeda(p.valor.min)} ou mais` : `abaixo de ${moeda(p.valor.maxExclusivo ?? 0)}`,
    });
  }
  return linhas;
}

// Dia AAAA-MM-DD → dd/mm/aaaa, sem passar por `new Date` (evita o dia anterior em fusos a oeste de UTC).
export function dia(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

export function dataCurta(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function dataHora(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}
