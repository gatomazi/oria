import { useCallback, useEffect, useState } from 'react';

// Período compartilhado entre as telas com filtro por data (Dashboard, Desempenho de Produtos,
// Jornada de Compra, …) — escolher em uma reflete nas outras e sobrevive a sair e voltar (achado
// direto do produto: cada tela guardava o próprio período em estado local, então "Últimos 7 dias"
// escolhido numa tela nunca aparecia nas outras, e sumia ao navegar). Persistido no localStorage —
// é uma conveniência por navegador, nunca dado de servidor: não precisa de tabela nem de RLS.

// Rodada "período global nas telas de mídia": os mesmos ids que o Meta Ads já usava (lib/meta.ts
// `PeriodoMeta`) — 'ontem' e '14d' entraram aqui pra não perder nenhum preset que o Meta já tinha
// ao ligar as duas telas no mesmo valor.
export type PeriodoPresetId = 'hoje' | 'ontem' | '7d' | '14d' | '30d' | '90d';

export interface PeriodoPreset {
  id: PeriodoPresetId;
  label: string;
  dias: number;
  // Dias entre o fim da janela e hoje — 0 pros presets de sempre (janela termina hoje), 1 só pra
  // "Ontem" (janela de 1 dia terminando ontem, não hoje).
  fimOffsetDias?: number;
}

export const PERIODO_PRESETS: PeriodoPreset[] = [
  { id: 'hoje', label: 'Hoje', dias: 1 },
  { id: 'ontem', label: 'Ontem', dias: 1, fimOffsetDias: 1 },
  { id: '7d', label: 'Últimos 7 dias', dias: 7 },
  { id: '14d', label: 'Últimos 14 dias', dias: 14 },
  { id: '30d', label: 'Últimos 30 dias', dias: 30 },
  { id: '90d', label: 'Últimos 90 dias', dias: 90 },
];

// `preset`: janela relativa a hoje (recalculada a cada leitura — "Últimos 7 dias" persistido ontem
// continua sendo os 7 dias mais recentes, não fica preso na data em que foi escolhido).
// `custom`: intervalo LITERAL escolhido na tela (o pedido original: "quero saber como foram minhas
// vendas em determinado dia" — startDate=endDate cobre esse caso; um intervalo maior também).
export type PeriodoGlobal =
  | { tipo: 'preset'; id: PeriodoPresetId }
  | { tipo: 'custom'; startDate: string; endDate: string };

export const PERIODO_GLOBAL_PADRAO: PeriodoGlobal = { tipo: 'preset', id: '30d' };

const CHAVE_STORAGE = 'oria.periodoGlobal.v1';

// "Hoje" no fuso do navegador — mesmo padrão frouxo já usado no resto do admin (não reproduz o
// -03:00 da Ink com precisão, só dá uma data-referência local). Duplicado aqui (e não importado de
// dashboardData.ts) pra este módulo não criar uma dependência cíclica com quem o consome.
export function hojeISO(): string {
  const d = new Date();
  const semFuso = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return semFuso.toISOString().slice(0, 10);
}

export function diasAtrasISO(dataISO: string, n: number): string {
  const [y, m, dia] = dataISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dia));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

function presetPorId(id: PeriodoPresetId): PeriodoPreset {
  return PERIODO_PRESETS.find((p) => p.id === id) ?? PERIODO_PRESETS.find((p) => p.id === '30d')!;
}

export function rotuloDoPreset(id: PeriodoPresetId): string {
  return presetPorId(id).label;
}

/** Intervalo [startDate, endDate] explícito equivalente ao período — sempre datas literais, nunca
 * "dias contados a partir de agora": quem consome (fetch, agregação) nunca precisa saber se veio
 * de um preset ou de um intervalo customizado. */
export function intervaloDoPeriodo(p: PeriodoGlobal): { startDate: string; endDate: string; dias: number } {
  if (p.tipo === 'custom') {
    const dias = Math.max(1, Math.round((Date.parse(p.endDate) - Date.parse(p.startDate)) / 86400000) + 1);
    return { startDate: p.startDate, endDate: p.endDate, dias };
  }
  const preset = presetPorId(p.id);
  const endDate = diasAtrasISO(hojeISO(), preset.fimOffsetDias ?? 0);
  return { startDate: diasAtrasISO(endDate, preset.dias - 1), endDate, dias: preset.dias };
}

function formatarDiaCurto(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

export function rotuloDoPeriodo(p: PeriodoGlobal): string {
  if (p.tipo === 'preset') return rotuloDoPreset(p.id);
  return p.startDate === p.endDate ? formatarDiaCurto(p.startDate) : `${formatarDiaCurto(p.startDate)} – ${formatarDiaCurto(p.endDate)}`;
}

function periodoValido(p: unknown): p is PeriodoGlobal {
  if (!p || typeof p !== 'object') return false;
  const x = p as Record<string, unknown>;
  if (x.tipo === 'preset') return typeof x.id === 'string' && PERIODO_PRESETS.some((preset) => preset.id === x.id);
  if (x.tipo === 'custom') return typeof x.startDate === 'string' && typeof x.endDate === 'string' && x.startDate <= x.endDate;
  return false;
}

function ler(): PeriodoGlobal {
  try {
    const bruto = localStorage.getItem(CHAVE_STORAGE);
    if (!bruto) return PERIODO_GLOBAL_PADRAO;
    const p = JSON.parse(bruto);
    return periodoValido(p) ? p : PERIODO_GLOBAL_PADRAO;
  } catch {
    // localStorage indisponível (aba privada, política do navegador) ou JSON de versão antiga: o
    // período só não persiste entre sessões, a tela continua funcionando com o padrão.
    return PERIODO_GLOBAL_PADRAO;
  }
}

// Pub/sub dentro da MESMA aba — o evento nativo `storage` só dispara em OUTRAS abas, nunca na que
// fez a escrita, e o produto quer as duas telas sincronizadas mesmo sem trocar de aba.
const ouvintes = new Set<(p: PeriodoGlobal) => void>();

function gravar(p: PeriodoGlobal) {
  try {
    localStorage.setItem(CHAVE_STORAGE, JSON.stringify(p));
  } catch {
    // Quota/aba privada: aplica em memória (os ouvintes abaixo) mesmo sem persistir.
  }
  ouvintes.forEach((fn) => fn(p));
}

/** Hook do período global — qualquer tela que chame isto lê e escreve o MESMO valor persistido,
 * em sincronia com as outras telas montadas ao mesmo tempo e com outras abas do navegador. */
export function usePeriodoGlobal(): [PeriodoGlobal, (p: PeriodoGlobal) => void] {
  const [periodo, setPeriodoLocal] = useState<PeriodoGlobal>(() => ler());

  useEffect(() => {
    const ouvinte = (p: PeriodoGlobal) => setPeriodoLocal(p);
    ouvintes.add(ouvinte);
    const noStorageDeOutraAba = (e: StorageEvent) => {
      if (e.key === CHAVE_STORAGE) setPeriodoLocal(ler());
    };
    window.addEventListener('storage', noStorageDeOutraAba);
    return () => {
      ouvintes.delete(ouvinte);
      window.removeEventListener('storage', noStorageDeOutraAba);
    };
  }, []);

  const setPeriodo = useCallback((p: PeriodoGlobal) => gravar(p), []);
  return [periodo, setPeriodo];
}
