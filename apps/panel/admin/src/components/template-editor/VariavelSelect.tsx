import type { SelectHTMLAttributes } from 'react';
import { gruposParaTipo, useGruposVariaveis } from '../../lib/templateVariables';

// Porte de renderVariavelSelect()/popularSelect() em template-editor.js.
interface VariavelSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  tipo: string | null | undefined;
}

function VariavelSelectBase({ tipo, className, ...rest }: VariavelSelectProps) {
  useGruposVariaveis(); // re-renderiza quando definirCamposCustomizados() atualiza o grupo "Personalizados"
  return (
    <select className={['ds-select', className].filter(Boolean).join(' ')} aria-label={rest['aria-label'] ?? 'Variável'} {...rest}>
      <option value="">Selecione…</option>
      {gruposParaTipo(tipo).map((g) => (
        <optgroup key={g.grupo} label={g.grupo}>
          {g.itens.map((v) => (
            <option key={v.chave} value={v.chave}>
              {v.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// Marcado como controle rotulável: dentro de <Field>, o label é associado automaticamente.
export const VariavelSelect = Object.assign(VariavelSelectBase, { dsControl: true });
