import { useState } from 'react';
import { Input, Select } from './ds';
import {
  PERIODO_PRESETS, hojeISO, intervaloDoPeriodo, type PeriodoGlobal, type PeriodoPresetId,
} from '../lib/periodoGlobal';

const HOJE = hojeISO();

/** Seletor de período compartilhado (ver src/lib/periodoGlobal.ts): presets + "Personalizado" (uma
 * data específica ou um intervalo — os dois campos de data só aparecem nesse modo). */
export function PeriodoGlobalSelect({ value, onChange }: { value: PeriodoGlobal; onChange: (p: PeriodoGlobal) => void }) {
  // Só pra lembrar o último intervalo customizado ao alternar de volta pra "Personalizado" vindo de
  // um preset — sem isso cada troca pro modo customizado reiniciaria em hoje/hoje.
  const [ultimoCustom, setUltimoCustom] = useState<{ startDate: string; endDate: string } | null>(null);
  const selecionado = value.tipo === 'preset' ? value.id : 'custom';

  function selecionarPreset(id: PeriodoPresetId) {
    onChange({ tipo: 'preset', id });
  }

  function selecionarCustomizado() {
    const inicial = ultimoCustom ?? { startDate: value.tipo === 'preset' ? intervaloDoPeriodo(value).startDate : HOJE, endDate: HOJE };
    onChange({ tipo: 'custom', ...inicial });
  }

  function atualizarCustom(parcial: Partial<{ startDate: string; endDate: string }>) {
    if (value.tipo !== 'custom') return;
    const proximo = { startDate: value.startDate, endDate: value.endDate, ...parcial };
    setUltimoCustom(proximo);
    onChange({ tipo: 'custom', ...proximo });
  }

  // Fragmento, nunca um <div> — quem usa isto (Toolbar, PageHeader actions) espera o Select e os
  // Inputs como filhos DIRETOS pra aplicar o próprio layout/responsivo (ver components.css).
  return (
    <>
      <Select
        aria-label="Período"
        value={selecionado}
        onChange={(e) => (e.target.value === 'custom' ? selecionarCustomizado() : selecionarPreset(e.target.value as PeriodoPresetId))}
      >
        {PERIODO_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
        <option value="custom">Personalizado</option>
      </Select>
      {value.tipo === 'custom' && (
        <>
          <Input
            type="date" aria-label="Início do período" value={value.startDate} max={value.endDate}
            onChange={(e) => atualizarCustom({ startDate: e.target.value })}
          />
          <Input
            type="date" aria-label="Fim do período" value={value.endDate} min={value.startDate} max={HOJE}
            onChange={(e) => atualizarCustom({ endDate: e.target.value })}
          />
        </>
      )}
    </>
  );
}
